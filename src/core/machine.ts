import type { FileFormat } from "./file-check.ts";
import type { JobSnapshot } from "./protocol.ts";

// Where an import stands from the device's point of view. The server's own
// status (queued/processing/ready/…) lives in `job`.
export type Phase =
  | "confirming" // validated on the device; nothing sent yet
  | "sending" // POST in flight
  | "unknown" // POST outcome unknown (no response): the server may have the job
  | "not_received" // the server has no job for the key; resending is the user's call
  | "accepted" // the server has a job; `job.status` tells how far it got
  | "deleting" // a DELETE was sent with `deleteKey`; waiting for `deleted`
  | "delete_failed" // the last DELETE wasn't accepted; the data is still on the server
  | "deleted" // a GET returned `deleted`
  | "failed"; // the server refused the file; nothing to recover

export type Failure =
  | { kind: "conflict" } // 409: the key was already used for other bytes
  | { kind: "refused"; status: number } // any other 4xx on POST
  | { kind: "copy_lost" } // the local copy disappeared before the server got it
  | { kind: "job_missing" }; // the server no longer knows the job id

export type ImportOperation = {
  version: 1;
  opId: string;
  // Idempotency-Key of the POST. Created with the operation and stored before
  // the first byte is sent, so every retry and every relaunch reuses it.
  key: string;
  file: {
    // In memory only; null after a relaunch (see store.ts).
    name: string | null;
    size: number;
    format: FileFormat;
    // Private copy that the upload reads; null once the server has the bytes.
    copyUri: string | null;
    // In memory only, for the diagnostics screen.
    sha256: string | null;
  };
  phase: Phase;
  // The newest snapshot the server sent, by revision.
  job: JobSnapshot | null;
  // Idempotency-Key of the DELETE, stored before the request goes out.
  deleteKey: string | null;
  // HTTP status of the last failed DELETE; null when no response came back.
  deleteError: { status: number | null } | null;
  failure: Failure | null;
  createdAt: number;
  updatedAt: number;
};

export type OpEvent =
  | { type: "confirmed" }
  | { type: "post_accepted"; job: JobSnapshot }
  | { type: "post_refused"; status: number }
  | { type: "post_unknown" }
  | { type: "key_found"; job: JobSnapshot }
  | { type: "key_missing"; resend: boolean }
  | { type: "resend" }
  | { type: "snapshot"; job: JobSnapshot }
  | { type: "delete_requested"; deleteKey: string }
  | { type: "delete_accepted"; job: JobSnapshot }
  | { type: "delete_failed"; status: number | null }
  | { type: "copy_released" }
  | { type: "failed"; failure: Failure };

// Why a server snapshot was not applied.
export type Ignored = "foreign" | "stale" | "same" | "after_delete" | "unconfirmed";

export type Transition = { op: ImportOperation; ignored?: Ignored };

export function createOperation(input: {
  opId: string;
  key: string;
  name: string;
  size: number;
  format: FileFormat;
  copyUri: string;
  sha256: string | null;
  now: number;
}): ImportOperation {
  return {
    version: 1,
    opId: input.opId,
    key: input.key,
    file: {
      name: input.name,
      size: input.size,
      format: input.format,
      copyUri: input.copyUri,
      sha256: input.sha256,
    },
    phase: "confirming",
    job: null,
    deleteKey: null,
    deleteError: null,
    failure: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

// The single gate for server snapshots. Revisions only move forward, so a
// late `processing` can't follow `ready`, and once a delete has been asked for
// nothing but `deleting`/`deleted` is accepted, so a late `ready` can't
// resurrect the job either.
export function applySnapshot(op: ImportOperation, job: JobSnapshot): Transition {
  if (op.job && job.jobId !== op.job.jobId) return { op, ignored: "foreign" };
  if (op.job && job.revision < op.job.revision) return { op, ignored: "stale" };
  if (op.job && job.revision === op.job.revision) {
    // The same state, but it may bring back the report that storage never
    // keeps (see store.ts).
    if (job.report && !op.job.report) return { op: { ...op, job } };
    return { op, ignored: "same" };
  }
  const deletion = job.status === "deleting" || job.status === "deleted";
  if ((op.deleteKey !== null || op.phase === "deleted") && !deletion) {
    return { op, ignored: "after_delete" };
  }

  let phase: Phase = "accepted";
  if (job.status === "deleting") phase = "deleting";
  if (job.status === "deleted") phase = "deleted";
  return { op: { ...op, job, phase, deleteError: deletion ? null : op.deleteError } };
}

export function canRequestDelete(op: ImportOperation): boolean {
  return (op.phase === "accepted" && op.job !== null) || op.phase === "delete_failed";
}

const SNAPSHOT_PHASES = new Set<Phase>(["sending", "unknown", "not_received", "accepted", "deleting", "delete_failed"]);

export function reduce(op: ImportOperation, event: OpEvent, now: number): Transition {
  const result = transition(op, event);
  return result.op === op ? result : { ...result, op: { ...result.op, updatedAt: now } };
}

function transition(op: ImportOperation, event: OpEvent): Transition {
  switch (event.type) {
    case "confirmed":
      return op.phase === "confirming" ? { op: { ...op, phase: "sending" } } : { op };

    case "resend":
      return op.phase === "not_received" ? { op: { ...op, phase: "sending" } } : { op };

    case "post_unknown":
      return op.phase === "sending" ? { op: { ...op, phase: "unknown" } } : { op };

    case "key_missing":
      if (op.phase !== "unknown" && op.phase !== "not_received") return { op };
      return { op: { ...op, phase: event.resend ? "sending" : "not_received" } };

    case "post_refused":
      if (op.phase !== "sending") return { op };
      return {
        op: {
          ...op,
          phase: "failed",
          failure: event.status === 409 ? { kind: "conflict" } : { kind: "refused", status: event.status },
        },
      };

    case "delete_accepted":
      // A DELETE's own answer can move the job to "deleting" only; "deleted"
      // counts once a later GET says so.
      if (event.job.status !== "deleting") return { op, ignored: "unconfirmed" };
      if (!SNAPSHOT_PHASES.has(op.phase)) return { op };
      return applySnapshot(op, event.job);

    case "post_accepted":
    case "key_found":
    case "snapshot":
      if (!SNAPSHOT_PHASES.has(op.phase)) return { op };
      return applySnapshot(op, event.job);

    case "delete_requested": {
      // Any job the server has, ready or not: a stuck one must not hold the
      // user's data hostage.
      if (!canRequestDelete(op)) return { op };
      // A retry keeps the first key, so the server sees one delete, not two.
      return { op: { ...op, phase: "deleting", deleteKey: op.deleteKey ?? event.deleteKey, deleteError: null } };
    }

    case "delete_failed":
      if (op.phase !== "deleting") return { op };
      return { op: { ...op, phase: "delete_failed", deleteError: { status: event.status } } };

    case "copy_released":
      return op.file.copyUri === null ? { op } : { op: { ...op, file: { ...op.file, copyUri: null } } };

    case "failed":
      return { op: { ...op, phase: "failed", failure: event.failure } };
  }
}
