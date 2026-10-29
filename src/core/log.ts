// Diagnostics without document data. Events are a closed set, fields an
// allowlist, and string values must look like ids or enum values, so a file
// name, a merchant or raw bytes can't get in even by mistake. The idempotency
// key isn't logged either: with the by-key route it reads the report.

export type LogEvent =
  | "resumed"
  | "resume_failed"
  | "file_accepted"
  | "file_rejected"
  | "post_started"
  | "post_accepted"
  | "post_refused"
  | "post_unknown"
  | "key_found"
  | "key_missing"
  | "key_check_failed"
  | "snapshot_applied"
  | "snapshot_ignored"
  | "poll_failed"
  | "delete_started"
  | "delete_accepted"
  | "delete_failed"
  | "copy_released"
  | "orphans_removed"
  | "discarded"
  | "store_failed";

const FIELDS = [
  "opId",
  "jobId",
  "phase",
  "status",
  "revision",
  "current",
  "ignored",
  "http",
  "error",
  "reason",
  "attempt",
  "format",
  "bytes",
  "count",
] as const;

export type LogFields = Partial<Record<(typeof FIELDS)[number], string | number | null | undefined>>;

export type LogEntry = { at: number; event: LogEvent } & Record<string, string | number>;

export type Logger = (event: LogEvent, fields?: LogFields) => void;

const SAFE_TEXT = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitize(fields: LogFields): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const name of FIELDS) {
    const value = fields[name];
    if (typeof value === "number" && Number.isFinite(value)) safe[name] = value;
    else if (typeof value === "string" && SAFE_TEXT.test(value)) safe[name] = value;
  }
  return safe;
}

// A ring buffer the diagnostics screen subscribes to, plus an optional sink
// (the dev console).
export function createEventLog(options: { limit?: number; sink?: (entry: LogEntry) => void; now?: () => number } = {}) {
  const limit = options.limit ?? 200;
  const now = options.now ?? Date.now;
  let entries: LogEntry[] = [];
  const listeners = new Set<() => void>();

  const log: Logger = (event, fields = {}) => {
    const entry = { at: now(), event, ...sanitize(fields) } as LogEntry;
    entries = [entry, ...entries].slice(0, limit);
    options.sink?.(entry);
    listeners.forEach((listener) => listener());
  };

  return {
    log,
    entries: () => entries,
    clear: () => {
      entries = [];
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
