// The acceptance matrix, against the kit's own mock: every case checks the
// state the screen renders from and the mock's counters.
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { MAX_FILE_BYTES } from "../src/core/file-check.ts";
import { monthlyTotalMinor } from "../src/core/format.ts";
import { createOperationStore } from "../src/core/store.ts";
import { createDevice, fixture, launchApp, pick, startMock, until, type Mock } from "./harness.ts";

let mock: Mock;
const apps: ReturnType<typeof launchApp>[] = [];
const allLogLines: string[] = [];

function launch(device: ReturnType<typeof createDevice>, options?: Parameters<typeof launchApp>[2]) {
  const app = launchApp(mock, device, options);
  apps.push(app);
  return app;
}

const isReady = (state: ReturnType<ReturnType<typeof launchApp>["engine"]["getState"]>) =>
  state.op?.job?.status === "ready";

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

describe("happy", () => {
  test("CSV: real bytes go out, 202 is not a report, ready shows the mock's data", async () => {
    const device = createDevice(mock);
    const app = launch(device);

    await app.engine.selectFile(pick(fixture("statement.csv")));
    const confirming = app.engine.getState().op;
    assert.equal(confirming?.phase, "confirming");
    assert.equal(confirming?.file.format, "csv");
    assert.equal((await mock.stats()).createRequests, 0, "nothing is sent before confirmation");

    await app.engine.confirm();
    const accepted = app.engine.getState().op;
    assert.equal(accepted?.phase, "accepted");
    assert.equal(accepted?.job?.status, "queued", "202 is a queued job, not a report");
    assert.equal(accepted?.job?.report, null);

    const ready = (await until(app.engine, isReady)).op;
    assert.equal(ready?.job?.revision, 3);
    assert.equal(ready?.job?.report?.currency, "AUD");
    assert.deepEqual(
      ready?.job?.report?.items.map((item) => item.merchant),
      ["StreamBeam", "BrightGrid"],
    );
    assert.equal(monthlyTotalMinor(ready?.job?.report?.items ?? []), 15199);

    const server = await mock.control.state();
    const size = statSync(fixture("statement.csv")).size;
    assert.deepEqual(server.stats, {
      createRequests: 1,
      newJobs: 1,
      duplicateHits: 0,
      acceptedBytes: size,
      deleteRequests: 0,
    });
    assert.equal(server.jobs[0].sha256, ready?.file.sha256, "the server hashed the very bytes we checked");

    assert.equal(ready?.file.copyUri, null, "the private copy is released once the server has the bytes");
    assert.deepEqual(device.files.copies(), []);
  });

  test("PDF fixture goes through the same way", async () => {
    const app = launch(createDevice(mock));
    const ready = (await importToReady(app, fixture("statement.pdf"))).op;
    assert.equal(ready?.file.format, "pdf");
    const stats = await mock.stats();
    assert.equal(stats.newJobs, 1);
    assert.equal(stats.acceptedBytes, statSync(fixture("statement.pdf")).size);
  });

  test("the idempotency key is on disk before the first POST leaves", async () => {
    const device = createDevice(mock);
    let atPost: { key?: string; phase?: string; header?: string } | null = null;
    const app = launch(device, {
      onCall(call) {
        if (call.method !== "POST" || call.path !== "/imports") return;
        const stored = createOperationStore(device.storage).load();
        atPost = { key: stored?.key, phase: stored?.phase, header: call.headers["Idempotency-Key"] };
      },
    });

    await app.engine.selectFile(pick(fixture("statement.csv")));
    const key = app.engine.getState().op?.key;
    await app.engine.confirm();

    assert.ok(key && key.length >= 8);
    assert.deepEqual(atPost, { key, phase: "sending", header: key });
  });
});

describe("lost_ack", () => {
  test("the dropped answer is recovered by key: one job, no duplicate", async () => {
    await mock.scenario("lost_ack");
    const app = launch(createDevice(mock));

    await app.engine.selectFile(pick(fixture("statement.pdf")));
    await app.engine.confirm();

    const state = app.engine.getState();
    assert.equal(state.op?.phase, "accepted");
    assert.equal(state.op?.job?.jobId, "job-demo-001");
    assert.deepEqual(
      app.calls.slice(0, 2).map((call) => `${call.method} ${call.path.replace(/by-key\/.*/, "by-key/{key}")}`),
      ["POST /imports", "GET /imports/by-key/{key}"],
    );
    await until(app.engine, isReady);

    const stats = await mock.stats();
    assert.equal(stats.newJobs, 1);
    assert.equal(stats.createRequests, 1);
    assert.equal(stats.duplicateHits, 0);
  });

  test("relaunch after the dropped answer finds the job by key and uploads nothing", async () => {
    await mock.scenario("lost_ack");
    const device = createDevice(mock);

    const first = launch(device);
    first.engine.setAutoRecover(false); // the process dies before it can ask
    await first.engine.selectFile(pick(fixture("statement.csv")));
    await first.engine.confirm();
    assert.equal(first.engine.getState().op?.phase, "unknown");
    first.engine.stop();

    const second = launch(device);
    assert.equal(second.engine.getState().op?.phase, "unknown", "restored from storage");
    await second.engine.resume();

    assert.equal(second.engine.getState().op?.phase, "accepted");
    assert.equal(second.engine.getState().op?.job?.jobId, "job-demo-001");
    assert.ok(second.calls.every((call) => call.method !== "POST"), "no upload after relaunch");
    await until(second.engine, isReady);

    const stats = await mock.stats();
    assert.equal(stats.newJobs, 1);
    assert.equal(stats.createRequests, 1);
  });

  test("relaunch when the POST never arrived: no automatic resend, the user's resend keeps the key", async () => {
    const device = createDevice(mock);

    // The first process stores the operation and dies as the upload starts.
    const first = launch(device, {
      onCall(call) {
        if (call.method === "POST") throw new Error("process killed");
      },
    });
    first.engine.setAutoRecover(false);
    await first.engine.selectFile(pick(fixture("statement.csv")));
    const key = first.engine.getState().op?.key;
    await first.engine.confirm();
    first.engine.stop();
    assert.equal((await mock.stats()).createRequests, 0);

    const second = launch(device);
    await second.engine.resume();
    assert.equal(second.engine.getState().op?.phase, "not_received");
    assert.ok(second.calls.every((call) => call.method !== "POST"), "resending is the user's call");
    assert.equal((await mock.stats()).createRequests, 0);

    await second.engine.resend();
    const post = second.calls.find((call) => call.method === "POST");
    assert.equal(post?.headers["Idempotency-Key"], key);
    await until(second.engine, isReady);
    const stats = await mock.stats();
    assert.equal(stats.newJobs, 1);
    assert.equal(stats.createRequests, 1);
  });
});

describe("stale_status", () => {
  test("processing/2 after ready/3 is ignored and the screen state stays ready", async () => {
    const app = launch(createDevice(mock));
    await importToReady(app);
    await mock.scenario("stale_status");

    await app.engine.refresh(); // 1st GET: ready / 3
    await app.engine.refresh(); // 2nd GET: processing / 2
    const after = app.engine.getState().op;
    assert.equal(after?.phase, "accepted");
    assert.equal(after?.job?.status, "ready");
    assert.equal(after?.job?.revision, 3);
    assert.equal(after?.job?.report?.items.length, 2);

    const ignored = app.events.entries().find((entry) => entry.event === "snapshot_ignored");
    assert.deepEqual(
      { status: ignored?.status, revision: ignored?.revision, ignored: ignored?.ignored, current: ignored?.current },
      { status: "processing", revision: 2, ignored: "stale", current: 3 },
      "the mock really sent the older revision",
    );

    await app.engine.refresh(); // 3rd GET: ready / 3 again
    assert.equal(app.engine.getState().op?.job?.status, "ready");
  });
});

describe("delete_failure", () => {
  test("503 is never shown as deleted; after switching to happy the same key reaches deleted", async () => {
    const device = createDevice(mock);
    const app = launch(device);
    await importToReady(app);

    await mock.scenario("delete_failure");
    await app.engine.requestDelete();
    const failed = app.engine.getState().op;
    assert.equal(failed?.phase, "delete_failed");
    assert.deepEqual(failed?.deleteError, { status: 503 });
    assert.equal(failed?.job?.status, "ready", "the data is still on the server");
    assert.equal(createOperationStore(device.storage).load()?.deleteKey, failed?.deleteKey, "key stored");

    await app.engine.refresh();
    assert.notEqual(app.engine.getState().op?.job?.status, "deleted");

    await mock.scenario("happy");
    await app.engine.requestDelete();
    const deleting = app.engine.getState().op;
    assert.equal(deleting?.phase, "deleting", "202 means deleting, not deleted");
    assert.equal(deleting?.job?.status, "deleting");

    const deleted = (await until(app.engine, (state) => state.op?.phase === "deleted")).op;
    assert.equal(deleted?.job?.status, "deleted");
    assert.equal(deleted?.job?.revision, 5);

    const deleteKeys = app.calls.filter((call) => call.method === "DELETE").map((call) => call.headers["Idempotency-Key"]);
    assert.deepEqual(deleteKeys, [failed?.deleteKey, failed?.deleteKey]);
    assert.equal((await mock.stats()).deleteRequests, 2);
  });

  test("relaunch while deleting carries on to deleted without a second DELETE", async () => {
    const device = createDevice(mock);
    const first = launch(device);
    await importToReady(first);
    await first.engine.requestDelete();
    assert.equal(first.engine.getState().op?.phase, "deleting");
    first.engine.stop();

    const second = launch(device);
    await second.engine.resume();
    await until(second.engine, (state) => state.op?.phase === "deleted");
    assert.ok(second.calls.every((call) => call.method === "GET"));
    assert.equal((await mock.stats()).deleteRequests, 1);
  });
});

describe("spoofed + oversize", () => {
  test("both are rejected on the device: createRequests doesn't move, no copy is left", async () => {
    const device = createDevice(mock);
    const app = launch(device);
    const before = await mock.stats();

    await app.engine.selectFile(pick(fixture("spoofed.pdf")));
    assert.deepEqual(
      { reason: app.engine.getState().rejection?.reason, claimed: app.engine.getState().rejection?.claimed },
      { reason: "unsupported_content", claimed: "pdf" },
    );

    // Same recipe as the kit's `fixtures:oversize`, written outside the kit.
    const oversize = join(mock.directory, "oversize.csv");
    const header = "date,description,amount\n";
    const row = "2026-09-01,Synthetic,-1.00\n";
    writeFileSync(oversize, header + row.repeat(Math.ceil((MAX_FILE_BYTES + 1 - header.length) / row.length)));
    assert.ok(statSync(oversize).size > MAX_FILE_BYTES);

    await app.engine.selectFile(pick(oversize));
    assert.equal(app.engine.getState().rejection?.reason, "too_large");
    // Even if the provider reports no size, the copy's real size decides.
    await app.engine.selectFile({ uri: oversize, name: "oversize.csv", size: null });
    assert.equal(app.engine.getState().rejection?.reason, "too_large");

    assert.equal(app.engine.getState().op, null);
    assert.deepEqual(app.calls, [], "no request at all");
    assert.deepEqual(await mock.stats(), before);
    assert.deepEqual(device.files.copies(), []);
  });
});

describe("privacy", () => {
  test("the report is never written to storage; a relaunch fetches it again", async () => {
    const device = createDevice(mock);
    const first = launch(device);
    await importToReady(first);
    assert.ok(device.storage.writes.every((json) => !json.includes("StreamBeam") && !json.includes("amountMinor")));
    first.engine.stop();

    const second = launch(device);
    assert.equal(second.engine.getState().op?.job?.report, null);
    await second.engine.resume();
    assert.equal(second.engine.getState().op?.job?.report?.items.length, 2);
  });

  test("logs carry neither the idempotency key nor the file hash", async () => {
    const app = launch(createDevice(mock));
    const ready = (await importToReady(app)).op;
    const text = app.lines.join("\n");
    assert.ok(ready?.key && !text.includes(ready.key));
    assert.ok(ready?.file.sha256 && !text.includes(ready.file.sha256));
    assert.ok(!readFileSync(fixture("statement.csv"), "utf8").split("\n").some((line) => line && text.includes(line)));
  });

  // Runs last: every line the whole matrix above logged.
  test("no log line from any scenario carries a file name, bytes or statement data", () => {
    const forbidden = ["statement", ".csv", ".pdf", "StreamBeam", "BrightGrid", "date,description", "%PDF", "Synthetic"];
    assert.ok(allLogLines.length > 50, "the log was actually exercised");
    for (const line of allLogLines) {
      for (const word of forbidden) assert.ok(!line.includes(word), `log line leaks "${word}": ${line}`);
    }
  });
});
