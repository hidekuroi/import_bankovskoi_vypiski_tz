import {
  HttpError,
  withDeadline,
  type HttpClient,
  type HttpMethod,
  type HttpResponse,
} from "./http.ts";
import { parseJob, ProtocolError, type JobSnapshot } from "./protocol.ts";

const UPLOAD_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_HEADER_NAME = 255;

// Header values must be ISO-8859-1, and a statement may well be called
// «Выписка.pdf»: percent-encode, then cut back to the mock's 255-char limit
// without splitting an escape.
export function headerFileName(name: string): string {
  const encoded = encodeURIComponent(name.trim() || "statement");
  if (encoded.length <= MAX_HEADER_NAME) return encoded;
  return encoded.slice(0, MAX_HEADER_NAME).replace(/%[0-9A-F]?$/i, "");
}

function json(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ProtocolError("json");
  }
}

export type ImportApi = ReturnType<typeof createImportApi>;

export function createImportApi({ baseUrl, http }: { baseUrl: string; http: HttpClient }) {
  const url = (path: string) => `${baseUrl}${path}`;

  const send = (method: HttpMethod, path: string, signal?: AbortSignal, headers?: Record<string, string>) =>
    withDeadline(REQUEST_TIMEOUT_MS, signal, (deadline) =>
      http.send(method, url(path), { headers: { Accept: "application/json", ...headers }, signal: deadline }),
    );

  return {
    // 202 is "the server has the bytes", never "the report is ready".
    async createImport(input: { key: string; fileName: string; fileUri: string; signal?: AbortSignal }): Promise<JobSnapshot> {
      const response = await withDeadline(UPLOAD_TIMEOUT_MS, input.signal, (signal) =>
        http.upload(url("/imports"), input.fileUri, {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/octet-stream",
            "Idempotency-Key": input.key,
            "X-File-Name": headerFileName(input.fileName),
          },
          signal,
        }),
      );
      if (response.status !== 202) throw new HttpError(response.status);
      return parseJob(json(response));
    },

    // null is "not found at this instant", not "never will be".
    async findByKey(key: string, signal?: AbortSignal): Promise<JobSnapshot | null> {
      const response = await send("GET", `/imports/by-key/${encodeURIComponent(key)}`, signal);
      if (response.status === 404) return null;
      if (response.status !== 200) throw new HttpError(response.status);
      return parseJob(json(response));
    },

    async getJob(jobId: string, signal?: AbortSignal): Promise<JobSnapshot> {
      const response = await send("GET", `/imports/${encodeURIComponent(jobId)}`, signal);
      if (response.status !== 200) throw new HttpError(response.status);
      return parseJob(json(response));
    },

    async deleteJob(jobId: string, deleteKey: string, signal?: AbortSignal): Promise<JobSnapshot> {
      const response = await send("DELETE", `/imports/${encodeURIComponent(jobId)}`, signal, {
        "Idempotency-Key": deleteKey,
      });
      if (response.status !== 202) throw new HttpError(response.status);
      return parseJob(json(response));
    },
  };
}

export const SCENARIOS = ["happy", "lost_ack", "stale_status", "delete_failure"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type MockStats = {
  createRequests: number;
  newJobs: number;
  duplicateHits: number;
  acceptedBytes: number;
  deleteRequests: number;
};

export type MockState = {
  mode: Scenario;
  stats: MockStats;
  jobs: { jobId: string; status: string; revision: number; sha256: string; bytes: number }[];
};

// The kit's reviewer-only routes, used by the diagnostics screen in dev builds.
export function createMockControl({ baseUrl, http }: { baseUrl: string; http: HttpClient }) {
  const call = async (method: HttpMethod, path: string, body?: unknown) => {
    const response = await withDeadline(REQUEST_TIMEOUT_MS, undefined, (signal) =>
      http.send(method, `${baseUrl}${path}`, {
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        json: body,
        signal,
      }),
    );
    if (response.status !== 200) throw new HttpError(response.status);
    return json(response);
  };

  return {
    state: async () => (await call("GET", "/__test/state")) as MockState,
    setScenario: async (mode: Scenario) => {
      await call("POST", "/__test/scenario", { mode });
    },
    reset: async () => {
      await call("POST", "/__test/reset");
    },
  };
}
