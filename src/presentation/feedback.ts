// Which haptic a change of state deserves. Plain TypeScript, so the rules are
// tested next to the wording: a soft tap when a request the user asked for
// leaves, the system success/warning/error once its outcome is known, and
// silence for polls that change nothing the user is waiting on.
import type { EngineState, FileRejection } from "../core/engine.ts";
import type { Phase } from "../core/machine.ts";
import type { JobStatus } from "../core/protocol.ts";

export type Feedback = "tap" | "success" | "warning" | "error";

export type Moment = {
  phase: Phase | null;
  status: JobStatus | null;
  rejection: FileRejection | null;
};

export function momentOf(state: EngineState): Moment {
  return { phase: state.op?.phase ?? null, status: state.op?.job?.status ?? null, rejection: state.rejection };
}

export function feedbackFor(before: Moment, after: Moment): Feedback | null {
  if (after.rejection && after.rejection !== before.rejection) return "error";
  if (after.phase === before.phase && after.status === before.status) return null;

  switch (after.phase) {
    case "confirming": // the file passed the device checks
      return before.phase === null ? "tap" : null;
    case "sending":
      return before.phase === "confirming" || before.phase === "not_received" ? "tap" : null;
    case "accepted":
      return after.status === "ready" ? "success" : null;
    case "deleting":
      return before.phase === "accepted" || before.phase === "delete_failed" ? "tap" : null;
    case "deleted":
      return "success";
    case "unknown":
    case "not_received":
      return "warning";
    case "failed":
    case "delete_failed":
      return "error";
    default:
      return null;
  }
}
