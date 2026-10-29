import type { ImportOperation, Phase } from "./machine.ts";

// Synchronous key-value storage: the Keychain on the device (see
// platform/import-engine.ts), a Map in the tests. The write must have happened
// when `set` returns, because the engine sends a request right after it.
export interface KeyValueStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface OperationStore {
  load(): ImportOperation | null;
  save(op: ImportOperation | null): void;
}

const KEY = "statement-import.operation";

const PHASES = new Set<Phase>([
  "confirming",
  "sending",
  "unknown",
  "not_received",
  "accepted",
  "deleting",
  "delete_failed",
  "deleted",
  "failed",
]);

function isOperation(value: unknown): value is ImportOperation {
  const op = value as ImportOperation | null;
  return (
    op?.version === 1 &&
    typeof op.opId === "string" &&
    typeof op.key === "string" &&
    PHASES.has(op.phase) &&
    (op.file?.format === "pdf" || op.file?.format === "csv") &&
    typeof op.file.size === "number"
  );
}

// What survives a relaunch is the minimum to find the job again and finish
// what was started: the random keys, the job id and revision, size and
// format. The file name, the content hash and the report (merchants,
// amounts) stay in memory only.
export function createOperationStore(storage: KeyValueStorage): OperationStore {
  return {
    load() {
      const raw = storage.getString(KEY);
      if (!raw) return null;
      try {
        const op: unknown = JSON.parse(raw);
        return isOperation(op) ? op : null;
      } catch {
        return null;
      }
    },
    save(op) {
      if (!op) return storage.remove(KEY);
      const stored: ImportOperation = {
        ...op,
        file: { ...op.file, name: null, sha256: null },
        job: op.job && { ...op.job, report: null },
      };
      storage.set(KEY, JSON.stringify(stored));
    },
  };
}
