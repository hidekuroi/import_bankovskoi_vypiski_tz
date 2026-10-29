export type JobStatus = "queued" | "processing" | "ready" | "deleting" | "deleted";

export type RecurringCharge = {
  id: string;
  merchant: string;
  amountMinor: number;
  cadence: string;
  lastSeen: string;
};

export type JobSnapshot = {
  jobId: string;
  status: JobStatus;
  revision: number;
  // Present only when status is "ready".
  report: { currency: string; items: RecurringCharge[] } | null;
};

const STATUSES = new Set<string>(["queued", "processing", "ready", "deleting", "deleted"]);

// The message names the offending field only: payload values may be statement
// data and must not reach logs through an error.
export class ProtocolError extends Error {
  constructor(field: string) {
    super(`Unexpected server payload: ${field}`);
    this.name = "ProtocolError";
  }
}

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(source: Fields, field: string, pattern?: RegExp): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new ProtocolError(field);
  }
  if (pattern && !pattern.test(value)) throw new ProtocolError(field);
  return value;
}

function count(source: Fields, field: string, minimum: number): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ProtocolError(field);
  }
  return value;
}

function charge(value: unknown): RecurringCharge {
  if (!isObject(value)) throw new ProtocolError("items[]");
  return {
    id: text(value, "id"),
    merchant: text(value, "merchant"),
    amountMinor: count(value, "amountMinor", 0),
    cadence: text(value, "cadence"),
    lastSeen: text(value, "lastSeen", /^\d{4}-\d{2}-\d{2}$/),
  };
}

// Every job-shaped response goes through here, so an unexpected answer turns
// into an error state instead of a crash or a half-rendered report.
export function parseJob(value: unknown): JobSnapshot {
  if (!isObject(value)) throw new ProtocolError("body");
  const status = text(value, "status");
  if (!STATUSES.has(status)) throw new ProtocolError("status");

  let report: JobSnapshot["report"] = null;
  if (status === "ready") {
    if (!Array.isArray(value.items)) throw new ProtocolError("items");
    report = {
      currency: text(value, "currency", /^[A-Z]{3}$/),
      items: value.items.map(charge),
    };
  }

  return {
    jobId: text(value, "jobId", /^[\w-]{1,64}$/),
    status: status as JobStatus,
    revision: count(value, "revision", 1),
    report,
  };
}
