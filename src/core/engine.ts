import type { ImportApi } from "./api.ts";
import { claimedFormat, detectFormat, HEAD_BYTES, MAX_FILE_BYTES, type FileFormat } from "./file-check.ts";
import { HttpError, isAbortError, TransportError } from "./http.ts";
import type { Logger } from "./log.ts";
import { canRequestDelete, createOperation, reduce, type ImportOperation, type OpEvent, type Phase } from "./machine.ts";
import { ProtocolError, type JobSnapshot } from "./protocol.ts";
import type { OperationStore } from "./store.ts";

export type PickedFile = { uri: string; name: string; size: number | null };

// The app's private folder of upload copies.
export interface FileGateway {
  // Copies or moves the picked file into the folder, named by the operation.
  adopt(sourceUri: string, opId: string): Promise<string>;
  // Removes what the picker itself left in the sandbox, if anything.
  discardSource(sourceUri: string): void;
  size(uri: string): number | null;
  head(uri: string, length: number): Promise<Uint8Array>;
  sha256(uri: string): Promise<string>;
  remove(uri: string): void;
  // Deletes every copy but `keep`; returns how many went.
  sweep(keep: string | null): number;
}

export type FileRejection = {
  reason: "too_large" | "empty" | "unsupported_content" | "unreadable";
  name: string;
  size: number | null;
  claimed: FileFormat | null;
};

export type Activity = "checking_file" | "uploading" | "checking_key" | "refreshing" | "deleting";

export type EngineState = {
  op: ImportOperation | null;
  activity: Activity | null;
  // The last request got no HTTP response at all.
  offline: boolean;
  // The last response didn't match the contract.
  invalidResponse: boolean;
  // When the server last confirmed the job's state.
  syncedAt: number | null;
  rejection: FileRejection | null;
  // The last write to the device's storage failed.
  unsaved: boolean;
};

export type EngineDeps = {
  api: ImportApi;
  files: FileGateway;
  store: OperationStore;
  log: Logger;
  newId: () => string;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollDelaysMs?: readonly number[];
  postAttempts?: number;
  offlineRetryMs?: number;
};

export type ImportEngine = ReturnType<typeof createImportEngine>;

const POLL_DELAYS_MS = [400, 700, 1000, 1500, 2500, 4000];
const POST_ATTEMPTS = 3;
const OFFLINE_RETRY_MS = 5000;
const DISCARDABLE = new Set<Phase>(["confirming", "not_received", "failed", "deleted"]);
// Nothing left to recover or finish: the record leaves the device.
const FINISHED = new Set<Phase>(["deleted", "failed"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError) return `http_${error.status}`;
  if (error instanceof TransportError) return "transport";
  if (error instanceof ProtocolError) return "protocol";
  return "unexpected";
}

function connection(error: unknown): Pick<EngineState, "offline" | "invalidResponse"> {
  return { offline: error instanceof TransportError, invalidResponse: error instanceof ProtocolError };
}

// A ready job whose report isn't in memory (it's never stored, so after a
// relaunch) is polled too, until a GET brings the report back.
function needsPolling(op: ImportOperation): boolean {
  if (op.phase === "accepted") return op.job?.status !== "ready" || !op.job.report;
  return op.phase === "deleting" && op.job?.status === "deleting";
}

// One import at a time, driven by the screen and by app lifecycle events.
// Every transition is written to storage before the request it leads to.
export function createImportEngine(deps: EngineDeps) {
  const { api, files, store, log } = deps;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  const pollDelays = deps.pollDelaysMs ?? POLL_DELAYS_MS;
  const postAttempts = deps.postAttempts ?? POST_ATTEMPTS;
  const offlineRetryMs = deps.offlineRetryMs ?? OFFLINE_RETRY_MS;

  let state: EngineState = {
    op: store.load(),
    activity: null,
    offline: false,
    invalidResponse: false,
    syncedAt: null,
    rejection: null,
    unsaved: false,
  };
  const listeners = new Set<() => void>();
  let poller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let foreground = true;
  let autoRecover = true;

  function update(patch: Partial<EngineState>) {
    state = { ...state, ...patch };
    if (state.offline) scheduleRetry();
    listeners.forEach((listener) => listener());
  }

  // The screen follows memory even when the write fails; only a send needs
  // the record on disk first (see confirm).
  function commit(op: ImportOperation | null) {
    let unsaved = false;
    try {
      store.save(op && !FINISHED.has(op.phase) ? op : null);
    } catch {
      unsaved = true;
      log("store_failed", { opId: op?.opId ?? state.op?.opId, phase: op?.phase });
    }
    update({ op, unsaved });
  }

  // The operation `opId` if it is still the current one: an answer that
  // arrives after the user moved on is dropped.
  function live(opId: string): ImportOperation | null {
    return state.op?.opId === opId ? state.op : null;
  }

  function dispatch(opId: string, event: OpEvent): ImportOperation | null {
    const op = live(opId);
    if (!op) return null;
    const { op: next, ignored } = reduce(op, event, now());
    if ("job" in event) {
      const { jobId, status, revision } = event.job;
      if (ignored) log("snapshot_ignored", { opId, jobId, status, revision, ignored, current: op.job?.revision });
      else if (event.type === "snapshot") log("snapshot_applied", { opId, jobId, status, revision, phase: next.phase });
    }
    if (next !== op) commit(next);
    return next;
  }

  function removeQuietly(uri: string) {
    try {
      files.remove(uri);
    } catch {
      // The launch sweep gets it next time.
    }
  }

  // Once the server holds the bytes (or refused them for good) no retry can
  // need the copy.
  function releaseCopy(opId: string) {
    const uri = live(opId)?.file.copyUri;
    if (!uri) return;
    dispatch(opId, { type: "copy_released" });
    removeQuietly(uri);
    log("copy_released", { opId });
  }

  function settle(opId: string, event: OpEvent) {
    if (!dispatch(opId, event)) return;
    releaseCopy(opId);
    update({ activity: null, offline: false, invalidResponse: false, syncedAt: now() });
    ensurePolling();
  }

  function dropOperation(op: ImportOperation) {
    stopPolling();
    commit(null);
    if (op.file.copyUri) removeQuietly(op.file.copyUri);
    log("discarded", { opId: op.opId, phase: op.phase });
  }

  // ---- Picking

  type Admission = { op: ImportOperation } | { reason: FileRejection["reason"]; size: number | null };

  async function admit(picked: PickedFile): Promise<Admission> {
    // The provider reports the size without the file being read, so an
    // oversize file is turned away before it is even copied.
    if (picked.size !== null && picked.size > MAX_FILE_BYTES) {
      files.discardSource(picked.uri);
      return { reason: "too_large", size: picked.size };
    }

    const opId = deps.newId();
    const copyUri = await files.adopt(picked.uri, opId);

    // The copy is what gets uploaded, so the copy is what gets checked: its
    // real size, then its first bytes.
    let size = 0;
    let format: FileFormat | null = null;
    try {
      size = files.size(copyUri) ?? 0;
      if (size > 0 && size <= MAX_FILE_BYTES) format = detectFormat(await files.head(copyUri, HEAD_BYTES));
    } catch (error) {
      removeQuietly(copyUri);
      throw error;
    }
    if (!format) {
      removeQuietly(copyUri);
      return { reason: size > MAX_FILE_BYTES ? "too_large" : size === 0 ? "empty" : "unsupported_content", size };
    }

    const sha256 = await files.sha256(copyUri).catch(() => null);
    return {
      op: createOperation({ opId, key: deps.newId(), name: picked.name, size, format, copyUri, sha256, now: now() }),
    };
  }

  // A file already chosen stays chosen until the new one passes the checks.
  async function selectFile(picked: PickedFile) {
    if (state.activity || (state.op && state.op.phase !== "confirming")) return;
    update({ activity: "checking_file", rejection: null });

    let admission: Admission;
    try {
      admission = await admit(picked);
    } catch {
      try {
        files.discardSource(picked.uri);
      } catch {
        // Nothing more to do; the picker's leftovers are its own.
      }
      admission = { reason: "unreadable", size: picked.size };
    }

    if ("op" in admission) {
      if (state.op) dropOperation(state.op);
      commit(admission.op);
      update({ activity: null });
      log("file_accepted", { opId: admission.op.opId, format: admission.op.file.format, bytes: admission.op.file.size });
      return;
    }
    log("file_rejected", { reason: admission.reason, bytes: admission.size });
    update({
      activity: null,
      rejection: { ...admission, name: picked.name, claimed: claimedFormat(picked.name) },
    });
  }

  function clearRejection() {
    update({ rejection: null });
  }

  // ---- Sending

  // Back to the screen before the tap, with the failure still shown.
  function holdBack(op: ImportOperation) {
    commit(op);
    update({ unsaved: true });
  }

  // The key goes out only once it is on the device: with no record a
  // relaunch couldn't ask by key, and a new pick would send it again as a
  // second job. If the write fails nothing is sent and the screen stays.
  async function confirm() {
    const op = state.op;
    if (!op || op.phase !== "confirming" || state.activity) return;
    dispatch(op.opId, { type: "confirmed" });
    if (state.unsaved) return holdBack(op);
    update({ rejection: null });
    await send(op.opId, 1);
  }

  async function resend() {
    const op = state.op;
    if (!op || op.phase !== "not_received" || state.activity) return;
    dispatch(op.opId, { type: "resend" });
    if (state.unsaved) return holdBack(op);
    await send(op.opId, 1);
  }

  async function send(opId: string, attempt: number) {
    const op = live(opId);
    if (!op || op.phase !== "sending") return;
    const copyUri = op.file.copyUri;
    if (!copyUri || files.size(copyUri) === null) {
      dispatch(opId, { type: "failed", failure: { kind: "copy_lost" } });
      return;
    }

    update({ activity: "uploading" });
    log("post_started", { opId, attempt });
    try {
      // The name isn't stored, so a resend after a relaunch goes out under a
      // neutral one; the server matches retries by key and bytes.
      const fileName = op.file.name ?? `statement.${op.file.format}`;
      const job = await api.createImport({ key: op.key, fileName, fileUri: copyUri });
      log("post_accepted", { opId, jobId: job.jobId, status: job.status, revision: job.revision });
      settle(opId, { type: "post_accepted", job });
    } catch (error) {
      if (!live(opId)) return;
      if (error instanceof HttpError && error.status < 500) {
        log("post_refused", { opId, http: error.status });
        dispatch(opId, { type: "post_refused", status: error.status });
        releaseCopy(opId);
        update({ activity: null, offline: false });
        return;
      }
      // No answer, a 5xx or a garbled one: the job may exist all the same.
      log("post_unknown", { opId, attempt, error: errorCode(error) });
      dispatch(opId, { type: "post_unknown" });
      update({ activity: null, ...connection(error) });
      if (autoRecover) await recover(opId, attempt < postAttempts ? attempt : null);
    }
  }

  // Asks the server by key whether a POST got through. `resendAfter` is the
  // attempt number when a missing job may be POSTed again (same key, same
  // bytes); null leaves resending to the user.
  async function recover(opId: string, resendAfter: number | null) {
    const op = live(opId);
    if (!op || (op.phase !== "unknown" && op.phase !== "not_received")) return;

    update({ activity: "checking_key" });
    try {
      const job = await api.findByKey(op.key);
      if (!live(opId)) return;
      if (job) {
        log("key_found", { opId, jobId: job.jobId, status: job.status, revision: job.revision });
        settle(opId, { type: "key_found", job });
        return;
      }
      log("key_missing", { opId, attempt: resendAfter });
      dispatch(opId, { type: "key_missing", resend: resendAfter !== null });
      update({ activity: null, offline: false, invalidResponse: false });
      if (resendAfter !== null) {
        await wait(500 * 2 ** (resendAfter - 1));
        await send(opId, resendAfter + 1);
      }
    } catch (error) {
      if (!live(opId)) return;
      log("key_check_failed", { opId, error: errorCode(error) });
      update({ activity: null, ...connection(error) });
    }
  }

  async function check() {
    const op = state.op;
    if (!op || (op.phase !== "unknown" && op.phase !== "not_received") || state.activity) return;
    await recover(op.opId, null);
  }

  // ---- Following the job

  function ensurePolling() {
    const op = state.op;
    if (poller || !foreground || !op || !needsPolling(op)) return;
    const controller = new AbortController();
    poller = controller;
    void poll(op.opId, controller.signal).finally(() => {
      if (poller === controller) poller = null;
    });
  }

  function stopPolling() {
    poller?.abort();
    poller = null;
  }

  async function poll(opId: string, signal: AbortSignal) {
    for (let attempt = 0; !signal.aborted; attempt += 1) {
      await wait(pollDelays[Math.min(attempt, pollDelays.length - 1)], signal);
      const op = live(opId);
      if (signal.aborted || !op || !needsPolling(op)) return;
      await fetchJob(opId, signal);
    }
  }

  async function fetchJob(opId: string, signal?: AbortSignal): Promise<JobSnapshot | null> {
    const jobId = live(opId)?.job?.jobId;
    if (!jobId) return null;
    try {
      const job = await api.getJob(jobId, signal);
      if (!live(opId)) return null;
      dispatch(opId, { type: "snapshot", job });
      update({ offline: false, invalidResponse: false, syncedAt: now() });
      return job;
    } catch (error) {
      if (isAbortError(error) || !live(opId)) return null;
      log("poll_failed", { opId, jobId, error: errorCode(error) });
      if (error instanceof HttpError && error.status === 404) {
        stopPolling();
        dispatch(opId, { type: "failed", failure: { kind: "job_missing" } });
      }
      update(connection(error));
      return null;
    }
  }

  async function refresh() {
    const op = state.op;
    if (!op || state.activity) return;
    if (op.phase !== "accepted" && op.phase !== "deleting" && op.phase !== "delete_failed") return;
    update({ activity: "refreshing" });
    await fetchJob(op.opId);
    update({ activity: null });
    ensurePolling();
  }

  // ---- Deleting

  async function requestDelete() {
    const op = state.op;
    if (!op || state.activity || !canRequestDelete(op)) return;
    stopPolling();
    // Stored before the request; a retry reuses it.
    dispatch(op.opId, { type: "delete_requested", deleteKey: deps.newId() });
    await sendDelete(op.opId);
  }

  async function sendDelete(opId: string) {
    const op = live(opId);
    if (!op?.job || !op.deleteKey || op.phase !== "deleting") return;

    update({ activity: "deleting" });
    log("delete_started", { opId, jobId: op.job.jobId });
    try {
      const job = await api.deleteJob(op.job.jobId, op.deleteKey);
      log("delete_accepted", { opId, jobId: job.jobId, status: job.status, revision: job.revision });
      // The machine takes only "deleting" from a DELETE. A repeated DELETE
      // can already answer "deleted"; that still waits for a GET to say so.
      settle(opId, { type: "delete_accepted", job });
      if (job.status !== "deleting") await confirmDeletion(opId);
    } catch (error) {
      if (!live(opId)) return;
      log("delete_failed", { opId, error: errorCode(error) });
      // A 5xx is the server saying it didn't delete: the data is still there.
      if (error instanceof HttpError && error.status >= 500) {
        dispatch(opId, { type: "delete_failed", status: error.status });
        update({ activity: null, offline: false });
        return;
      }
      // No answer, a refusal (404: the job may be gone already) or a garbled
      // one: only a GET can tell what the server holds now.
      update({ activity: null, ...connection(error) });
      await confirmDeletion(opId, error instanceof HttpError ? error.status : null);
    }
  }

  // The fate of a DELETE is unclear: no answer, a refusal, or the app was
  // killed after the key was stored. A GET decides: deleting → follow it,
  // deleted → done, 404 → the job is gone, still there → the delete failed.
  async function confirmDeletion(opId: string, status: number | null = null) {
    const job = await fetchJob(opId);
    const op = live(opId);
    if (!op || op.phase !== "deleting") return;
    if (job?.status === "deleting") return ensurePolling();
    dispatch(opId, { type: "delete_failed", status });
  }

  // ---- Lifecycle

  // On launch: reconcile whatever was stored with the server. Reads only;
  // nothing is uploaded again without the user asking.
  async function resume() {
    const op = state.op;
    try {
      const removed = files.sweep(op?.file.copyUri ?? null);
      if (removed > 0) log("orphans_removed", { count: removed });
    } catch {
      // The copy folder is unreadable; nothing to sweep this time.
    }
    if (!op) return;

    log("resumed", { opId: op.opId, phase: op.phase });
    switch (op.phase) {
      case "confirming":
        if (!op.file.copyUri || files.size(op.file.copyUri) === null) dropOperation(op);
        return;
      case "sending":
        // Killed with a POST possibly on the wire.
        dispatch(op.opId, { type: "post_unknown" });
        return recover(op.opId, null);
      case "unknown":
      case "not_received":
        return recover(op.opId, null);
      case "accepted":
      case "delete_failed":
        await fetchJob(op.opId);
        return ensurePolling();
      case "deleting":
        if (op.job?.status !== "deleting") return confirmDeletion(op.opId);
        await fetchJob(op.opId);
        return ensurePolling();
    }
  }

  // Asks the server again: back in the foreground, when the device is back
  // online, and every few seconds while the server is unreachable. Reads
  // only; a job that isn't found is never re-uploaded from here.
  async function reconnect() {
    const op = state.op;
    if (!op || state.activity || !foreground) return;
    if (op.phase === "unknown" || op.phase === "not_received") return recover(op.opId, null);
    if (op.phase !== "accepted" && op.phase !== "deleting" && op.phase !== "delete_failed") return;
    // A running poll loop is already asking.
    if (poller) return;
    await fetchJob(op.opId);
    ensurePolling();
  }

  function scheduleRetry() {
    if (retryTimer || !foreground) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!state.offline || !foreground) return;
      await reconnect();
      if (state.offline) scheduleRetry();
    }, offlineRetryMs);
  }

  function stop() {
    stopPolling();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function setForeground(active: boolean) {
    if (active === foreground) return;
    foreground = active;
    if (!active) return stop();
    void reconnect();
  }

  async function discard() {
    const op = state.op;
    if (!op) return clearRejection();
    if (!DISCARDABLE.has(op.phase) || state.activity) return;
    if (op.phase === "not_received") {
      // The first POST may have landed since the last check. Forgetting the
      // key then would leave a job on the server the user can't delete, so
      // look once more and let go only on a definite "not found".
      await recover(op.opId, null);
      const after = live(op.opId);
      if (after?.phase !== "not_received" || state.offline || state.invalidResponse) return;
    }
    dropOperation(op);
    update({ rejection: null });
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resume,
    selectFile,
    clearRejection,
    confirm,
    check,
    resend,
    refresh,
    requestDelete,
    discard,
    setForeground,
    reconnect,
    // Dev builds: hold the automatic by-key check after a lost response, so
    // the relaunch path can be exercised by hand.
    setAutoRecover(value: boolean) {
      autoRecover = value;
    },
    // Dev builds: forget the local operation whatever its phase.
    resetLocal() {
      if (state.op) dropOperation(state.op);
      update({ activity: null, offline: false, invalidResponse: false, syncedAt: null, rejection: null });
    },
    stop,
  };
}
