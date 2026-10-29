import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Icon, Icons, type IconName } from "@/components/icon";
import { Appear, Shift, Stage } from "@/components/motion";
import { Notice } from "@/components/notice";
import { ReportCard } from "@/components/report-card";
import { Row, SectionLabel } from "@/components/row";
import { Steps } from "@/components/steps";
import { ThemedText } from "@/components/themed-text";
import { MaxContentWidth, Spacing } from "@/constants/theme";
import type { EngineState } from "@/core/engine";
import { formatBytes } from "@/core/format";
import type { ImportOperation } from "@/core/machine";
import { useTheme } from "@/hooks/use-theme";
import { playHaptic } from "@/platform/haptics";
import { importEngine, pickStatement, useImportState } from "@/platform/import-engine";
import { feedbackFor, momentOf, type Moment } from "@/presentation/feedback";
import { importView, rejectionText, storageNotice, type Action, type ImportView } from "@/presentation/import-view";

async function chooseFile() {
  try {
    const picked = await pickStatement();
    if (picked) await importEngine.selectFile(picked);
  } catch {
    // The picker failed to open (another one is already up); nothing changed.
  }
}

function confirmDelete() {
  Alert.alert(
    "Удалить импорт?",
    "Сервер удалит файл и результаты обработки. «Удалено» появится, когда сервер это подтвердит.",
    [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: () => void importEngine.requestDelete() },
    ],
  );
}

function Assurance({ icon, children }: { icon: IconName; children: string }) {
  const theme = useTheme();
  return (
    <View style={styles.assurance}>
      <Icon name={icon} size={20} color={theme.tint} />
      <ThemedText type="subhead" themeColor="textSecondary" style={styles.assuranceText}>
        {children}
      </ThemedText>
    </View>
  );
}

function Start({ state }: { state: EngineState }) {
  const theme = useTheme();
  const checking = state.activity === "checking_file";
  const rejection = state.rejection;

  return (
    <>
      <Card>
        <View style={[styles.badge, { backgroundColor: theme.accentSoft }]}>
          <Icon name={Icons.document} size={26} color={theme.tint} />
        </View>
        <ThemedText type="title2">Загрузите выписку</ThemedText>
        <ThemedText themeColor="textSecondary">
          PDF или CSV до 10 МБ. Сервер найдёт в ней регулярные списания.
        </ThemedText>
        <View style={styles.assurances}>
          <Assurance icon={Icons.shield}>
            Файл проверяется на устройстве: подделка или слишком большой файл на сервер не уйдут
          </Assurance>
          <Assurance icon={Icons.upload}>Отправка — только после вашего подтверждения</Assurance>
          <Assurance icon={Icons.trash}>Импорт можно удалить; «удалено» покажем, когда это подтвердит сервер</Assurance>
        </View>
      </Card>
      {rejection ? (
        <Appear key={`${rejection.reason}:${rejection.name}`}>
          <Notice tone="danger" title="Файл не подходит" body={rejectionText(rejection)} />
        </Appear>
      ) : null}
      <Shift>
        <Button
          title={checking ? "Проверяем файл…" : "Выбрать файл"}
          icon={Icons.document}
          loading={checking}
          onPress={chooseFile}
        />
      </Shift>
    </>
  );
}

// The name is kept in memory only, so after a relaunch it is gone.
function fileTitle(op: ImportOperation): string {
  return op.file.name ?? "Выписка";
}

function Confirm({ op, state }: { op: ImportOperation; state: EngineState }) {
  const busy = state.activity !== null;
  const rejection = state.rejection;
  const unsaved = storageNotice(state);

  return (
    <>
      {/* Another file was picked and didn't pass; the earlier choice stands. */}
      {rejection ? (
        <Appear key={`${rejection.reason}:${rejection.name}`}>
          <Notice tone="danger" title="Этот файл не подходит" body={`${rejectionText(rejection)} Выбранный ранее файл остался.`} />
        </Appear>
      ) : null}
      {unsaved ? (
        <Appear>
          <Notice {...unsaved} />
        </Appear>
      ) : null}
      <Card>
        <SectionLabel>Проверьте перед отправкой</SectionLabel>
        <ThemedText type="headline">{fileTitle(op)}</ThemedText>
        <Row label="Размер" value={formatBytes(op.file.size)} />
        <Row label="Формат" value={op.file.format.toUpperCase()} detail="по содержимому файла" />
      </Card>
      <ThemedText type="footnote" themeColor="textSecondary" style={styles.note}>
        Файл уйдёт на сервер только после нажатия «Отправить». Если связь оборвётся, повторная отправка
        не создаст дубликат.
      </ThemedText>
      <View style={styles.actions}>
        <Button title="Отправить" icon={Icons.upload} disabled={busy} onPress={() => void importEngine.confirm()} />
        <Button title="Выбрать другой файл" variant="secondary" disabled={busy} onPress={chooseFile} />
        <Button title="Отмена" variant="plain" disabled={busy} onPress={() => void importEngine.discard()} />
      </View>
    </>
  );
}

function ActionButton({ action, state }: { action: Action; state: EngineState }) {
  switch (action) {
    case "check":
      return (
        <Button
          title="Проверить"
          loading={state.activity === "checking_key"}
          onPress={() => void importEngine.check()}
        />
      );
    case "resend":
      return (
        <Button
          title="Отправить повторно"
          icon={Icons.repeat}
          loading={state.activity === "uploading"}
          onPress={() => void importEngine.resend()}
        />
      );
    case "discard":
      return (
        <Button
          title="Отменить импорт"
          variant="plain"
          loading={state.activity === "checking_key"}
          accessibilityHint="Перед отменой ещё раз проверим по ключу операции"
          onPress={() => void importEngine.discard()}
        />
      );
    case "retry_delete":
      return (
        <Button
          title="Повторить удаление"
          variant="danger"
          loading={state.activity === "deleting"}
          onPress={() => void importEngine.requestDelete()}
        />
      );
    case "new_import":
      return <Button title="Новый импорт" onPress={() => void importEngine.discard()} />;
    case "start_over":
      return <Button title="Начать заново" onPress={() => void importEngine.discard()} />;
  }
}

function SyncLine({ op, state }: { op: ImportOperation; state: EngineState }) {
  if (!op.job) return null;
  const time = state.syncedAt
    ? new Date(state.syncedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  return (
    <ThemedText type="footnote" themeColor="textTertiary" style={styles.note}>
      {op.job.jobId} · {op.job.status} · ревизия {op.job.revision}
      {time ? ` · сверено с сервером в ${time}` : " · ещё не сверено после запуска"}
    </ThemedText>
  );
}

function FileLine({ op }: { op: ImportOperation }) {
  return (
    <ThemedText type="subhead" themeColor="textSecondary" style={styles.note}>
      {fileTitle(op)} · {formatBytes(op.file.size)} · {op.file.format.toUpperCase()}
    </ThemedText>
  );
}

// Keyed by tone: "sending" → "processing" only rewrites the text in place; a
// notice of another kind (a warning, an error, done) slides in anew.
function StatusNotices({ view, state }: { view: ImportView; state: EngineState }) {
  return (
    <>
      {view.notice ? (
        <Appear key={view.notice.tone}>
          <Notice {...view.notice}>
            {view.actions.length > 0
              ? view.actions.map((action) => <ActionButton key={action} action={action} state={state} />)
              : null}
          </Notice>
        </Appear>
      ) : null}
      {view.connection ? (
        <Appear key={view.connection.title}>
          <Notice {...view.connection} />
        </Appear>
      ) : null}
    </>
  );
}

// From «Отправить» to the report. Blocks that arrive with a new server state
// slide in; the rest glide aside.
function Progress({ op, state, view }: { op: ImportOperation; state: EngineState; view: ImportView }) {
  const report = op.job?.report;

  return (
    <>
      <FileLine op={op} />
      <StatusNotices view={view} state={state} />
      {view.showReport && report ? (
        <Appear>
          <ReportCard currency={report.currency} items={report.items} />
        </Appear>
      ) : null}
      <Shift>
        <Card>
          <SectionLabel>Импорт</SectionLabel>
          <Steps steps={view.steps} />
        </Card>
      </Shift>
      {view.canDelete ? (
        <Appear>
          <Button title="Удалить импорт" variant="destructive" icon={Icons.trash} onPress={confirmDelete} />
        </Appear>
      ) : null}
      <Shift>
        <SyncLine op={op} state={state} />
      </Shift>
    </>
  );
}

// From «Удалить» to «Удалено на сервере»: its own stage, so the report and the
// import steps leave in one crossfade instead of collapsing piece by piece,
// and from here on only the status and the step marks change.
function Deletion({ op, state, view }: { op: ImportOperation; state: EngineState; view: ImportView }) {
  const report = op.job?.report;

  return (
    <>
      <FileLine op={op} />
      <StatusNotices view={view} state={state} />
      {view.deletion ? (
        <Shift>
          <Card>
            <SectionLabel>Удаление</SectionLabel>
            <Steps steps={view.deletion} />
          </Card>
        </Shift>
      ) : null}
      {/* A failed delete leaves the data on the server, and on screen. */}
      {view.showReport && report ? (
        <Appear>
          <ReportCard currency={report.currency} items={report.items} />
        </Appear>
      ) : null}
      <Shift>
        <SyncLine op={op} state={state} />
      </Shift>
    </>
  );
}

type StageName = "start" | "confirm" | "progress" | "deletion";

function stageOf(op: ImportOperation | null): StageName {
  if (!op) return "start";
  if (op.phase === "confirming") return "confirm";
  if (op.phase === "deleting" || op.phase === "delete_failed" || op.phase === "deleted") return "deletion";
  return "progress";
}

// A haptic and a spoken update when something the user waits for happens.
// Compared render to render, so a state restored at launch stays silent.
function useFeedback(state: EngineState, view: ImportView | null) {
  const { phase, status, rejection } = momentOf(state);
  const announcement = view?.notice?.title ?? (status === "ready" ? "Отчёт готов" : null);
  const previous = useRef<Moment>({ phase, status, rejection });

  useEffect(() => {
    const before = previous.current;
    const after = { phase, status, rejection };
    previous.current = after;

    const feedback = feedbackFor(before, after);
    if (feedback) playHaptic(feedback);

    if (rejection && rejection !== before.rejection) {
      AccessibilityInfo.announceForAccessibility(`Файл не подходит. ${rejectionText(rejection)}`);
    } else if (phase && (phase !== before.phase || status !== before.status) && announcement) {
      AccessibilityInfo.announceForAccessibility(announcement);
    }
  }, [phase, status, rejection, announcement]);
}

export default function ImportScreen() {
  // The spinner answers the user's own pull only; refreshes the app makes by
  // itself (the stale_status check in dev builds) stay silent.
  const [pulling, setPulling] = useState(false);
  const pull = () => {
    setPulling(true);
    void importEngine.refresh().finally(() => setPulling(false));
  };
  const state = useImportState();
  const op = state.op;
  const view = op && op.phase !== "confirming" ? importView(op, state) : null;
  const stage = stageOf(op);
  const canRefresh = op?.phase === "accepted" || op?.phase === "deleting" || op?.phase === "delete_failed";
  useFeedback(state, view);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={
        canRefresh ? (
          <RefreshControl
            refreshing={pulling}
            onRefresh={pull}
          />
        ) : undefined
      }
    >
      {/* What is on screen at launch just appears; only later changes animate. */}
      <LayoutAnimationConfig skipEntering>
        <View style={styles.column}>
          <Stage key={stage} style={styles.stack}>
            {stage === "start" ? <Start state={state} /> : null}
            {stage === "confirm" && op ? <Confirm op={op} state={state} /> : null}
            {stage === "progress" && op && view ? <Progress op={op} state={state} view={view} /> : null}
            {stage === "deletion" && op && view ? <Deletion op={op} state={state} view={view} /> : null}
          </Stage>
        </View>
      </LayoutAnimationConfig>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    paddingBottom: Spacing.six,
    alignItems: "center",
  },
  column: {
    width: "100%",
    maxWidth: MaxContentWidth,
  },
  stack: {
    gap: Spacing.four,
  },
  badge: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  assurances: {
    gap: Spacing.three,
    paddingTop: Spacing.one,
  },
  assurance: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.three,
  },
  assuranceText: {
    flex: 1,
  },
  actions: {
    gap: Spacing.two,
  },
  note: {
    paddingHorizontal: Spacing.one,
  },
});
