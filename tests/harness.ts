// Runs the real engine against the kit's real mock server: in-process, on a
// random port, with throwaway state, so counters are reproducible.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createImportApi, createMockControl, type Scenario } from "../src/core/api.ts";
import { createImportEngine, type FileGateway } from "../src/core/engine.ts";
import type { HttpClient, HttpResponse } from "../src/core/http.ts";
import { createEventLog } from "../src/core/log.ts";
import { createOperationStore, type KeyValueStorage } from "../src/core/store.ts";
import { createMockServer } from "../kit/mock-server.mjs";

export const KIT = fileURLToPath(new URL("../kit/", import.meta.url));
export const fixture = (name: string) => join(KIT, "fixtures", name);

export type Call = { method: string; path: string; headers: Record<string, string> };

// Network faults, decided per request:
// - refuse: no connection; the request never leaves;
// - respond: answer without sending anything (the server never sees it);
// - lose: send it, then lose the answer (the server did act on it);
// - hold: send it, then deliver the answer only when the returned promise
//   settles (a late response).
export type Faults = {
  refuse?: (call: Call) => boolean;
  respond?: (call: Call) => HttpResponse | undefined;
  lose?: (call: Call) => boolean;
  hold?: (call: Call) => Promise<void> | undefined;
};

// Node's fetch as the device's networking. `calls` records every request in
// order, `onCall` lets a test observe storage at the moment a request leaves.
export function createNodeHttp(onCall?: (call: Call) => void, faults: Faults = {}) {
  const calls: Call[] = [];

  async function exchange(method: string, url: string, headers: Record<string, string> = {}, init: RequestInit) {
    const call = { method, path: new URL(url).pathname, headers };
    calls.push(call);
    onCall?.(call);
    if (faults.refuse?.(call)) throw new TypeError("Network request failed");
    const canned = faults.respond?.(call);
    if (canned) return canned;
    const response = await fetch(url, { method, headers, ...init });
    const answer = { status: response.status, body: await response.text() };
    if (faults.lose?.(call)) throw new TypeError("Network request failed");
    await faults.hold?.(call);
    return answer;
  }

  const http: HttpClient = {
    send: (method, url, options = {}) =>
      exchange(method, url, options.headers, {
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal: options.signal,
      }),
    upload: (url, fileUri, options) =>
      exchange("POST", url, options.headers, { body: readFileSync(fileUri), signal: options.signal }),
  };
  return { http, calls };
}

// A plain directory standing in for the app's private copy folder.
export function createDiskFiles(directory: string): FileGateway & { copies(): string[] } {
  return {
    async adopt(sourceUri, opId) {
      const target = join(directory, opId);
      copyFileSync(sourceUri, target);
      return target;
    },
    discardSource() {},
    size: (uri) => (existsSync(uri) ? statSync(uri).size : null),
    async head(uri, length) {
      return new Uint8Array(readFileSync(uri).subarray(0, length));
    },
    async sha256(uri) {
      return createHash("sha256").update(readFileSync(uri)).digest("hex");
    },
    remove: (uri) => rmSync(uri, { force: true }),
    sweep(keep) {
      const stale = readdirSync(directory)
        .map((name) => join(directory, name))
        .filter((path) => path !== keep);
      stale.forEach((path) => unlinkSync(path));
      return stale.length;
    },
    copies: () => readdirSync(directory),
  };
}

export function createMemoryStorage(): KeyValueStorage & { writes: string[] } {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    getString: (key) => values.get(key),
    set(key, value) {
      values.set(key, value);
      writes.push(value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

export async function startMock() {
  const directory = mkdtempSync(join(tmpdir(), "statement-import-test-"));
  const server = createMockServer({ statePath: join(directory, "mock-state.json") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const control = createMockControl({ baseUrl, http: createNodeHttp().http });

  return {
    baseUrl,
    directory,
    control,
    scenario: (mode: Scenario) => control.setScenario(mode),
    stats: async () => (await control.state()).stats,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type Mock = Awaited<ReturnType<typeof startMock>>;

// One "app process": an engine over shared storage and a shared copy folder.
// Building a second one over the same storage is a relaunch.
export function launchApp(
  mock: Mock,
  shared: { storage: KeyValueStorage; files: FileGateway },
  options: { onCall?: (call: Call) => void; faults?: Faults; offlineRetryMs?: number } = {},
) {
  const { http, calls } = createNodeHttp(options.onCall, options.faults);
  const events = createEventLog();
  const lines: string[] = [];
  const engine = createImportEngine({
    api: createImportApi({ baseUrl: mock.baseUrl, http }),
    files: shared.files,
    store: createOperationStore(shared.storage),
    log: (event, fields) => {
      lines.push(JSON.stringify({ event, ...fields }));
      events.log(event, fields);
    },
    newId: randomUUID,
    pollDelaysMs: [60],
    offlineRetryMs: options.offlineRetryMs,
  });
  return { engine, calls, events, lines };
}

export function createDevice(mock: Mock) {
  const copies = mkdtempSync(join(mock.directory, "copies-"));
  return { storage: createMemoryStorage(), files: createDiskFiles(copies) };
}

export function pick(path: string, name = path.split("/").pop() ?? "file") {
  return { uri: path, name, size: statSync(path).size };
}

// Resolves once the engine's state satisfies `test`, or fails after `ms`.
export function until<T>(
  engine: { getState(): T; subscribe(listener: () => void): () => void },
  test: (state: T) => boolean,
  ms = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (test(engine.getState())) return resolve(engine.getState());
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out; last state: ${JSON.stringify(engine.getState())}`));
    }, ms);
    const unsubscribe = engine.subscribe(() => {
      if (!test(engine.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(engine.getState());
    });
  });
}

// For conditions the engine doesn't announce (a request leaving, say).
export async function waitFor(test: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
