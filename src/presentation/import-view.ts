// What the import screen says, derived from the engine state alone. Plain
// TypeScript, so the wording rules are tested next to the engine: nothing
// reads as "sent" before a 202, "ready" before a ready snapshot or "deleted"
// before the server confirms it.
import type { EngineState, FileRejection } from "../core/engine.ts";
import { MAX_FILE_BYTES } from "../core/file-check.ts";
import { formatBytes } from "../core/format.ts";
import { canRequestDelete, type ImportOperation } from "../core/machine.ts";

export type Tone = "info" | "success" | "warning" | "danger";
export type StepState = "done" | "active" | "waiting" | "warning" | "failed";
export type StepView = { title: string; detail?: string; state: StepState };
export type NoticeView = { tone: Tone; title: string; body: string };

export type Action =
  | "check"
  | "resend"
  | "discard"
  | "retry_delete"
  | "new_import"
  | "start_over";

export type ImportView = {
  steps: StepView[];
  deletion: StepView[] | null;
  notice: NoticeView | null;
  // A storage, transport or contract problem on top of the last confirmed state.
  connection: NoticeView | null;
  actions: Action[];
  showReport: boolean;
  canDelete: boolean;
};

const FORMAT_NAMES = { pdf: "PDF", csv: "CSV" } as const;

export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function rejectionText(rejection: FileRejection): string {
  const nothingSent = "На сервер ничего не отправлено.";
  switch (rejection.reason) {
    case "too_large": {
      const size = rejection.size ?? 0;
      return `Файл весит ${formatBytes(size)} (${groupDigits(size)} байт), а лимит — 10 МБ (${groupDigits(MAX_FILE_BYTES)} байт). ${nothingSent}`;
    }
    case "empty":
      return `Файл пустой. ${nothingSent}`;
    case "unreadable":
      return `Не удалось прочитать файл. Попробуйте выбрать его ещё раз. ${nothingSent}`;
    case "unsupported_content":
      if (rejection.claimed === "pdf") return `Файл называется .pdf, но внутри не PDF. ${nothingSent}`;
      if (rejection.claimed === "csv") {
        return `Файл называется .csv, но первая строка не «date,description,amount». ${nothingSent}`;
      }
      return `Внутри не PDF и не CSV-выписка. ${nothingSent}`;
  }
}

function uploadStep(op: ImportOperation, state: EngineState): StepView {
  const title = "Отправка на сервер";
  switch (op.phase) {
    case "confirming":
      return { title, state: "waiting", detail: "Начнётся после вашего подтверждения" };
    case "sending":
      return {
        title,
        state: "active",
        detail:
          state.activity === "uploading"
            ? "Передаём файл. Сервер ещё не подтвердил получение"
            : "Повторяем отправку с тем же ключом операции",
      };
    case "unknown":
      return {
        title,
        state: "warning",
        detail:
          state.activity === "checking_key"
            ? "Ответ не пришёл. Проверяем по ключу операции…"
            : state.offline
              ? "Ответ не пришёл, а проверить по ключу пока не удалось: нет связи с сервером"
              : "Ответ не пришёл — неизвестно, получил ли сервер файл",
      };
    case "not_received":
      return { title, state: "warning", detail: "По ключу операции импорт пока не найден" };
    case "failed":
      if (op.failure?.kind === "conflict") {
        return { title, state: "failed", detail: "Ключ операции уже занят другим файлом (HTTP 409)" };
      }
      if (op.failure?.kind === "refused") {
        return { title, state: "failed", detail: `Сервер отклонил файл (HTTP ${op.failure.status})` };
      }
      if (op.failure?.kind === "copy_lost") {
        return { title, state: "failed", detail: "Копия файла на устройстве пропала до отправки" };
      }
      break;
  }
  return { title, state: "done", detail: op.job ? `Сервер принял файл · ${op.job.jobId}` : undefined };
}

function processingSteps(op: ImportOperation): StepView[] {
  const status = op.job?.status;
  const accepted = op.phase === "accepted";
  const after = op.phase === "deleting" || op.phase === "delete_failed" || op.phase === "deleted";

  if (op.failure?.kind === "job_missing") {
    return [
      { title: "Обработка", state: "failed", detail: "Сервер больше не знает этот импорт (HTTP 404)" },
      { title: "Отчёт готов", state: "waiting" },
    ];
  }

  const queued: StepView =
    accepted && status === "queued"
      ? { title: "В очереди", state: "active", detail: "Файл на сервере, отчёт ещё не готов" }
      : { title: "В очереди", state: (accepted && status !== "queued") || after ? "done" : "waiting" };
  const processing: StepView =
    accepted && status === "processing"
      ? { title: "Обработка", state: "active", detail: "Сервер ищет регулярные списания" }
      : { title: "Обработка", state: (accepted && status === "ready") || after ? "done" : "waiting" };
  const ready: StepView =
    (accepted && status === "ready") || after
      ? { title: "Отчёт готов", state: "done", detail: accepted ? `Ревизия ${op.job?.revision}` : undefined }
      : { title: "Отчёт готов", state: "waiting" };
  return [queued, processing, ready];
}

function deletionSteps(op: ImportOperation): StepView[] | null {
  if (op.deleteKey === null) return null;
  const status = op.job?.status;
  const acceptedByServer = status === "deleting" || status === "deleted";

  let request: StepView = { title: "Запрос на удаление", state: "active", detail: "Отправляем запрос…" };
  if (acceptedByServer) request = { title: "Запрос на удаление", state: "done", detail: "Сервер принял запрос" };
  else if (op.phase === "delete_failed") {
    const status = op.deleteError?.status;
    request = {
      title: "Запрос на удаление",
      state: "failed",
      detail: status ? `Сервер не смог удалить (HTTP ${status})` : "Сервер не подтвердил запрос",
    };
  }

  return [
    request,
    status === "deleted"
      ? { title: "Удаление на сервере", state: "done" }
      : status === "deleting"
        ? { title: "Удаление на сервере", state: "active", detail: "Данные ещё на сервере, ждём подтверждения" }
        : { title: "Удаление на сервере", state: "waiting" },
    status === "deleted"
      ? { title: "Удалено", state: "done", detail: `Подтверждено сервером · ревизия ${op.job?.revision}` }
      : { title: "Удалено", state: "waiting", detail: "Скажем, когда сервер подтвердит" },
  ];
}

// How long the server may keep a job queued or processing, counted between
// its last change and the server's latest answer, before the screen says so.
export const SLOW_AFTER_MS = 60_000;

function stalled(op: ImportOperation, state: EngineState): boolean {
  if (op.phase !== "accepted" || !op.job || op.job.status === "ready") return false;
  return state.syncedAt !== null && state.syncedAt - op.updatedAt >= SLOW_AFTER_MS;
}

function notice(op: ImportOperation, state: EngineState): NoticeView | null {
  switch (op.phase) {
    case "confirming":
      return null;
    case "sending":
      return {
        tone: "info",
        title: "Отправляем файл",
        body: "Сервер ещё не подтвердил получение. Если связь прервётся, проверим по ключу операции — дубликата не будет.",
      };
    case "unknown":
      return {
        tone: "warning",
        title: "Неизвестно, дошёл ли файл",
        body: "Связь прервалась до ответа сервера. Проверка по ключу операции покажет, есть ли импорт на сервере.",
      };
    case "not_received":
      return {
        tone: "warning",
        title: "Импорт по ключу не найден",
        body: "Похоже, файл до сервера не дошёл. Можно отправить его ещё раз: ключ операции тот же, поэтому дубликата не будет. Перед отменой проверим ещё раз.",
      };
    case "accepted":
      if (op.job?.status === "ready") {
        // The report is never stored, so after a relaunch it comes back with
        // the next GET.
        if (op.job.report) return null;
        return {
          tone: "info",
          title: "Загружаем отчёт",
          body: "Сервер сообщил, что отчёт готов. Получаем данные — на устройстве они между запусками не хранятся.",
        };
      }
      if (stalled(op, state)) {
        return {
          tone: "warning",
          title: "Обработка идёт дольше обычного",
          body: "Сервер получил файл, но отчёт ещё не готов. Статус продолжает обновляться. Если ждать не хотите, удалите импорт: сервер удалит файл.",
        };
      }
      return {
        tone: "info",
        title: "Сервер обрабатывает выписку",
        body: "Файл получен, отчёт ещё не готов. Статус обновляется сам. Удалить импорт можно и сейчас.",
      };
    case "deleting":
      return {
        tone: "info",
        title: "Удаляем данные на сервере",
        body: "Пока сервер не подтвердит удаление, данные считаются сохранёнными.",
      };
    case "delete_failed": {
      const status = op.deleteError?.status;
      return {
        tone: "danger",
        title: "Не удалось удалить",
        body: status
          ? `Сервер ответил ошибкой ${status}. Данные по-прежнему на сервере — попробуйте ещё раз.`
          : "Сервер не подтвердил удаление. Данные могут оставаться на сервере — попробуйте ещё раз.",
      };
    }
    case "deleted":
      return {
        tone: "success",
        title: "Удалено на сервере",
        body: "Сервер подтвердил удаление. Копия файла на устройстве была удалена ещё после отправки.",
      };
    case "failed":
      switch (op.failure?.kind) {
        case "conflict":
          return {
            tone: "danger",
            title: "Импорт остановлен",
            body: "Сервер уже получил другой файл с этим ключом операции. Чтобы не смешать данные, начните заново.",
          };
        case "copy_lost":
          return {
            tone: "danger",
            title: "Файл нужно выбрать заново",
            body: "Система удалила временную копию до того, как сервер её получил. На сервере этого импорта нет.",
          };
        case "job_missing":
          return {
            tone: "danger",
            title: "Импорт не найден",
            body: "Сервер больше не знает этот импорт. Начните заново.",
          };
        default:
          return {
            tone: "danger",
            title: "Сервер не принял файл",
            body: "Файл не прошёл проверку на сервере. Начните заново с другим файлом.",
          };
      }
  }
}

function actions(op: ImportOperation): Action[] {
  switch (op.phase) {
    case "unknown":
      return ["check"];
    case "not_received":
      return ["resend", "discard"];
    case "delete_failed":
      return ["retry_delete"];
    case "deleted":
      return ["new_import"];
    case "failed":
      return ["start_over"];
    default:
      return [];
  }
}

// The device refused to store the operation: whatever was tapped didn't go
// out, since the key has to be on the device before a send.
export function storageNotice(state: EngineState): NoticeView | null {
  if (!state.unsaved) return null;
  return {
    tone: "danger",
    title: "Не удалось сохранить на устройстве",
    body: "Файл не отправлен: без сохранённого ключа повтор мог бы создать дубликат. Попробуйте ещё раз.",
  };
}

// A missing connection is the toast's job (components/offline-toast.tsx);
// here only an answer that broke the contract.
function connection(state: EngineState): NoticeView | null {
  if (state.unsaved) return storageNotice(state);
  if (!state.invalidResponse) return null;
  return {
    tone: "warning",
    title: "Сервер ответил неожиданно",
    body: "Ответ не совпал с форматом, мы его не применили. Показан последний подтверждённый статус.",
  };
}

export function importView(op: ImportOperation, state: EngineState): ImportView {
  const checked: StepView = {
    title: "Проверен на устройстве",
    state: "done",
    detail: `${FORMAT_NAMES[op.file.format]} · ${formatBytes(op.file.size)} — формат определён по содержимому`,
  };
  const ready = op.job?.status === "ready";

  return {
    steps: [checked, uploadStep(op, state), ...processingSteps(op)],
    deletion: deletionSteps(op),
    notice: notice(op, state),
    connection: connection(state),
    actions: actions(op),
    // While a delete is unconfirmed the data is still on the server, and
    // still shown.
    showReport: ready && op.job?.report != null && (op.phase === "accepted" || op.phase === "delete_failed"),
    // Deleting needs the job only: not the report, not even a finished one.
    canDelete: op.phase === "accepted" && canRequestDelete(op),
  };
}
