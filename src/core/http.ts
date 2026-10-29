export type HttpResponse = { status: number; body: string };

export type HttpMethod = "GET" | "POST" | "DELETE";

export type SendOptions = {
  headers?: Record<string, string>;
  json?: unknown;
  signal?: AbortSignal;
};

export type UploadOptions = {
  headers: Record<string, string>;
  signal?: AbortSignal;
};

// The platform's networking, injected: expo/fetch and File.upload on the
// device, Node's fetch in the tests. Both resolve for any HTTP status and
// reject only when no response arrived.
export interface HttpClient {
  send(method: HttpMethod, url: string, options?: SendOptions): Promise<HttpResponse>;
  // Streams a local file as the raw request body (POST).
  upload(url: string, fileUri: string, options: UploadOptions): Promise<HttpResponse>;
}

// No HTTP response at all: refused, dropped, timed out. For a POST this means
// the outcome is unknown, not that it failed.
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

// Runs a request under a deadline. The caller's own abort stays an
// AbortError (a cancellation); our deadline becomes a TransportError.
export async function withDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw abortError();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (timedOut) throw new TransportError(`No response within ${timeoutMs} ms`);
    if (signal?.aborted) throw abortError();
    if (error instanceof Error && !isAbortError(error)) throw new TransportError(error.name);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}
