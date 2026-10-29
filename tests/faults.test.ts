// The failure paths around the matrix, against the kit's real mock with
// network faults injected on the client side (see Faults in harness.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { EngineState } from "../src/core/engine.ts";
import { createOperationStore } from "../src/core/store.ts";
import { importView } from "../src/presentation/import-view.ts";
import { createDevice, fixture, launchApp, pick, startMock, until, waitFor, type Call, type Mock } from "./harness.ts";

let mock: Mock;
const apps: ReturnType<typeof launchApp>[] = [];
const allLogLines: string[] = [];

function launch(device: ReturnType<typeof createDevice>, options?: Parameters<typeof launchApp>[2]) {
  const app = launchApp(mock, device, options);
  apps.push(app);
  return app;
}

const isReady = (state: EngineState) => state.op?.job?.status === "ready" && state.op.job.report !== null;
const isJobGet = (call: Call) => call.method === "GET" && /^\/imports\/job-/.test(call.path);
const never = new Promise<void>(() => {});

async function importToReady(app: ReturnType<typeof launchApp>, file = fixture("statement.csv")) {
  await app.engine.selectFile(pick(file));
  await app.engine.confirm();
  return until(app.engine, isReady);
}

beforeEach(async () => {
  mock = await startMock();
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.engine.stop();
    allLogLines.push(...app.lines);
  }
  await mock.close();
});

describe("sending", () => {
  test("after a 5xx and a 404 by key the automatic resend reuses the key: one job", async () => {
    let posts = 0;
    const app = launch(createDevice(mock), {
      faults: {
        // The first POST "fails" with 503 before reaching the server.
        respond: (call) => (call.method === "POST" && ++posts === 1 ? { status: 503, body: "{}" } : undefined),
      },
    });
    await importToReady(app);

    const keys = app.calls.filter((call) => call.method === "POST").map((call) => call.headers["Idempotency-Key"]);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], "the resend carries the same key");
    assert.ok(app.calls.some((call) => call.path.startsWith("/imports/by-key/")), "it asked by key before resending");
    const stats = await mock.stats();
    assert.deepEqual([stats.createRequests, stats.newJobs, stats.duplicateHits], [1, 1, 0]);
  });

  test("no server while the answer is unknown: shown as such, and found by key once it is back", async () => {
    await mock.scenario("lost_ack");
    let down = false;
    const app = launch(createDevice(mock), {
      offlineRetryMs: 50,
      // The POST gets through and the mock drops its answer; with it the
      // connection goes.
      onCall(call) {
        if (call.method === "POST") down = true;
      },
      faults: { refuse: (call) => down && call.method !== "POST" },
    });
    await app.engine.selectFile(pick(fixture("statement.csv")));
    await app.engine.confirm();

    const stuck = app.engine.getState();
    assert.equal(stuck.op?.phase, "unknown");
    assert.equal(stuck.offline, true);
    const step = importView(stuck.op!, stuck).steps.find((s) => s.title === "Отправка на сервер");
    assert.match(step?.detail ?? "", /нет связи/);

    down = false;
    await until(app.engine, (state) => state.op?.phase === "accepted" && !state.offline);
    await until(app.engine, isReady);
    assert.equal(app.calls.filter((call) => call.method === "POST").length, 1, "nothing uploaded again");
    assert.equal((await mock.stats()).newJobs, 1);
  });
});

describe("relaunch", () => {
  test("the report comes back after a relaunch even when the first answer is stale", async () => {
    const device = createDevice(mock);
    const first = launch(device);
    const ready = (await importToReady(first)).op!;
    first.engine.stop();

    // Under stale_status the second GET of a job answers processing/2: make
    // that the one the relaunched app gets first.
    await mock.scenario("stale_status");
    await fetch(`${mock.baseUrl}/imports/${ready.job!.jobId}`);

    const second = launch(device);
    const restored = second.engine.getState();
    assert.equal(restored.op?.job?.report, null, "the report isn't stored");
    const view = importView(restored.op!, restored);
    assert.equal(view.notice?.title, "Загружаем отчёт");
    assert.equal(view.showReport, false);
    assert.equal(view.canDelete, true, "deleting doesn't wait for the report");

    await second.engine.resume();
    const after = await until(second.engine, isReady);
    assert.equal(after.op?.job?.revision, 3);
    const ignored = second.events.entries().find((entry) => entry.event === "snapshot_ignored" && entry.status === "processing");
    assert.equal(ignored?.ignored, "stale", "the stale answer came and was dropped");
  });

  test("killed while the DELETE answer was on its way: the relaunch confirms by GET, no second DELETE", async () => {
    const device = createDevice(mock);
    const first = launch(device, { faults: { hold: (call) => (call.method === "DELETE" ? never : undefined) } });
    await importToReady(first);
    void first.engine.requestDelete();
    await waitFor(() => first.calls.some((call) => call.method === "DELETE"));
    first.engine.stop();

    const stored = createOperationStore(device.storage).load();
    assert.equal(stored?.phase, "deleting");
    assert.ok(stored?.deleteKey, "the delete key was stored before the request");

    const second = launch(device);
    await second.engine.resume();
    await until(second.engine, (state) => state.op?.phase === "deleted");
    assert.ok(second.calls.every((call) => call.method === "GET"), "only reads after the relaunch");
    assert.equal((await mock.stats()).deleteRequests, 1);
  });
});

describe("deleting", () => {
  test("a 404 on DELETE is checked by GET and never shown as data still on the server", async () => {
    const app = launch(createDevice(mock));
    await importToReady(app);
    await mock.control.reset();

    await app.engine.requestDelete();
    const state = app.engine.getState();
    assert.equal(state.op?.phase, "failed");
    assert.deepEqual(state.op?.failure, { kind: "job_missing" });
    const view = importView(state.op!, state);
    assert.equal(view.notice?.title, "Импорт не найден");
    assert.doesNotMatch(view.notice?.body ?? "", /на сервере/);
  });

  test("a job still queued can be deleted: the screen goes straight to deleting, never back to the report", async () => {
    const app = launch(createDevice(mock));
    await app.engine.selectFile(pick(fixture("statement.csv")));
    await app.engine.confirm();
    const queued = app.engine.getState();
    assert.equal(queued.op?.job?.status, "queued");
    assert.equal(importView(queued.op!, queued).canDelete, true);

    const phases: string[] = [];
    const unsubscribe = app.engine.subscribe(() => phases.push(app.engine.getState().op?.phase ?? "none"));
    await app.engine.requestDelete();
    const done = await until(app.engine, (state) => state.op?.phase === "deleted");
    unsubscribe();

    assert.equal(done.op?.job?.report ?? null, null, "no report ever showed up");
    assert.ok(!phases.includes("accepted"), `went back to accepted: ${phases.join(",")}`);
    const stats = await mock.stats();
    assert.deepEqual([stats.newJobs, stats.deleteRequests], [1, 1]);
  });

  test("a repeated DELETE that already answers deleted still waits for a GET", async () => {
    let cut = false;
    const app = launch(createDevice(mock), {
      offlineRetryMs: 60_000,
      faults: { lose: () => cut },
    });
    await importToReady(app);

    // The DELETE lands but its answer and the follow-up GET are lost.
    cut = true;
    await app.engine.requestDelete();
    cut = false;
    assert.equal(app.engine.getState().op?.phase, "delete_failed");

    // A second later the server reports the job as deleted to the retried DELETE.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.engine.requestDelete();
    await until(app.engine, (state) => state.op?.phase === "deleted");

    const deletes = app.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 2);
    assert.equal(deletes[0].headers["Idempotency-Key"], deletes[1].headers["Idempotency-Key"]);
    const events = app.events.entries();
    const unconfirmed = events.find((entry) => entry.event === "snapshot_ignored" && entry.ignored === "unconfirmed");
    assert.equal(unconfirmed?.status, "deleted", "the DELETE's own 'deleted' was not taken as confirmation");
    const lastCall = app.calls.at(-1);
    assert.ok(lastCall && isJobGet(lastCall), "deleted came from a GET");
  });

  test("a GET answered before the delete but delivered after it can't bring the job back", async () => {
    let release = () => {};
    let holdNext = false;
    const app = launch(createDevice(mock), {
      faults: {
        hold: (call) => {
          if (!holdNext || !isJobGet(call)) return undefined;
          holdNext = false;
          return new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
    await importToReady(app);
    const phases: string[] = [];
    app.engine.subscribe(() => phases.push(app.engine.getState().op?.phase ?? "none"));

    // A refresh asks for the job; its answer (ready/3) is held back.
    holdNext = true;
    app.engine.setForeground(false);
    app.engine.setForeground(true);
    await waitFor(() => !holdNext);

    await app.engine.requestDelete();
    await until(app.engine, (state) => state.op?.job?.status === "deleting");
    release();
    await until(app.engine, (state) => state.op?.phase === "deleted");

    const late = app.events.entries().find((entry) => entry.event === "snapshot_ignored" && entry.status === "ready");
    assert.ok(late, "the late ready answer arrived and was ignored");
    const deleteAt = phases.indexOf("deleting");
    assert.ok(deleteAt >= 0 && !phases.slice(deleteAt).includes("accepted"), "never back to accepted after the delete");
  });
});

describe("picking and cancelling", () => {
  test("a second file that fails the checks leaves the first choice in place", async () => {
    const device = createDevice(mock);
    const app = launch(device);
    await app.engine.selectFile(pick(fixture("statement.csv")));
    const first = app.engine.getState().op!;

    await app.engine.selectFile(pick(fixture("spoofed.pdf")));
    const state = app.engine.getState();
    assert.equal(state.op?.opId, first.opId);
    assert.equal(state.rejection?.reason, "unsupported_content");
    assert.deepEqual(device.files.copies(), [first.opId], "the first copy stays, the rejected one is gone");

    await app.engine.selectFile(pick(fixture("statement.pdf")));
    const second = app.engine.getState().op!;
    assert.notEqual(second.opId, first.opId);
    assert.deepEqual(device.files.copies(), [second.opId]);
    assert.equal(app.engine.getState().rejection, null);
  });

  test("cancelling after a 404 by key looks once more: a job that landed late is kept", async () => {
    const device = createDevice(mock);
    const first = launch(device, {
      onCall(call) {
        if (call.method === "POST") throw new Error("process killed");
      },
    });
    first.engine.setAutoRecover(false);
    await first.engine.selectFile(pick(fixture("statement.csv")));
    await first.engine.confirm();
    first.engine.stop();

    const second = launch(device);
    await second.engine.resume();
    const op = second.engine.getState().op!;
    assert.equal(op.phase, "not_received");

    // The original upload reaches the server after all.
    await fetch(`${mock.baseUrl}/imports`, {
      method: "POST",
      headers: { "Idempotency-Key": op.key, "X-File-Name": "statement.csv", "Content-Type": "application/octet-stream" },
      body: readFileSync(fixture("statement.csv")),
    });

    await second.engine.discard();
    assert.equal(second.engine.getState().op?.phase, "accepted", "kept, so it can still be deleted");
    assert.equal((await mock.stats()).newJobs, 1);
  });

  test("cancelling after a 404 by key lets go once the server confirms there is nothing", async () => {
    const device = createDevice(mock);
    const first = launch(device, {
      onCall(call) {
        if (call.method === "POST") throw new Error("process killed");
      },
    });
    first.engine.setAutoRecover(false);
    await first.engine.selectFile(pick(fixture("statement.csv")));
    await first.engine.confirm();
    first.engine.stop();

    const second = launch(device);
    await second.engine.resume();
    await second.engine.discard();
    assert.equal(second.engine.getState().op, null);
    assert.equal(createOperationStore(device.storage).load(), null);
    assert.deepEqual(device.files.copies(), []);
  });
});

describe("storage", () => {
  test("the stored record has no file name, hash or report, and is gone once the import is deleted", async () => {
    const device = createDevice(mock);
    const app = launch(device);
    const ready = (await importToReady(app)).op!;

    assert.ok(device.storage.writes.length > 0);
    for (const json of device.storage.writes) {
      const stored = JSON.parse(json);
      assert.deepEqual([stored.file.name, stored.file.sha256, stored.job?.report ?? null], [null, null, null]);
      assert.ok(!json.includes("statement.csv"), "no file name anywhere");
      assert.ok(ready.file.sha256 && !json.includes(ready.file.sha256), "no content hash anywhere");
      assert.ok(!json.includes("StreamBeam") && !json.includes("amountMinor"), "no report anywhere");
    }
    assert.equal(createOperationStore(device.storage).load()?.key, ready.key, "the key is there");

    await app.engine.requestDelete();
    await until(app.engine, (state) => state.op?.phase === "deleted");
    assert.equal(createOperationStore(device.storage).load(), null, "nothing left once the server deleted it");
  });

  test("a write the device refuses before the send keeps the file here: no POST until the key is stored", async () => {
    const device = createDevice(mock);
    let refuse = false;
    const storage = {
      ...device.storage,
      set(key: string, value: string) {
        if (refuse) throw new Error("keychain unavailable");
        device.storage.set(key, value);
      },
    };
    const app = launch({ ...device, storage });
    await app.engine.selectFile(pick(fixture("statement.csv")));

    refuse = true;
    await app.engine.confirm();
    const held = app.engine.getState();
    assert.deepEqual([held.op?.phase, held.unsaved], ["confirming", true]);
    assert.equal(importView({ ...held.op!, phase: "accepted" }, held).connection?.title, "Не удалось сохранить на устройстве");
    assert.equal(app.calls.filter((call) => call.method === "POST").length, 0, "nothing went out");

    refuse = false;
    await app.engine.confirm();
    assert.equal((await until(app.engine, isReady)).unsaved, false);
    const stats = await mock.stats();
    assert.deepEqual([stats.createRequests, stats.newJobs], [1, 1]);
  });

  test("writes refused after the send don't stall the import: it carries on in memory", async () => {
    const device = createDevice(mock);
    let refuse = false;
    const storage = {
      ...device.storage,
      set(key: string, value: string) {
        if (refuse) throw new Error("keychain unavailable");
        device.storage.set(key, value);
      },
    };
    // The phone locks while the bytes are on their way.
    const app = launch({ ...device, storage }, { onCall: (call) => void (call.method === "POST" && (refuse = true)) });

    const ready = await importToReady(app);
    assert.equal(ready.unsaved, true);
    assert.ok(app.lines.some((line) => line.includes('"store_failed"')));
    assert.equal(createOperationStore(device.storage).load()?.phase, "sending", "the key from before the send is still there");

    refuse = false;
    await app.engine.requestDelete();
    await until(app.engine, (state) => state.op?.phase === "deleted");
    assert.equal(app.engine.getState().unsaved, false);
  });

  // Runs last: every line the tests above logged.
  test("no log line from these paths carries a file name, bytes or statement data", () => {
    const forbidden = ["statement", ".csv", ".pdf", "StreamBeam", "BrightGrid", "date,description", "%PDF"];
    assert.ok(allLogLines.length > 30);
    for (const line of allLogLines) {
      for (const word of forbidden) assert.ok(!line.includes(word), `log line leaks "${word}": ${line}`);
    }
  });
});
