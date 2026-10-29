import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { headerFileName } from "../src/core/api.ts";
import type { EngineState } from "../src/core/engine.ts";
import { claimedFormat, detectFormat } from "../src/core/file-check.ts";
import { formatBytes, formatDay, formatMinor, monthlyTotalMinor } from "../src/core/format.ts";
import { sanitize } from "../src/core/log.ts";
import { applySnapshot, createOperation, reduce, type ImportOperation } from "../src/core/machine.ts";
import { parseJob, ProtocolError, type JobSnapshot } from "../src/core/protocol.ts";
import { createOperationStore } from "../src/core/store.ts";
import { feedbackFor, type Moment } from "../src/presentation/feedback.ts";
import { importView, SLOW_AFTER_MS } from "../src/presentation/import-view.ts";
import { fixture } from "./harness.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("content check mirrors the server", () => {
  test("accepts the kit's statement fixtures by their bytes", () => {
    assert.equal(detectFormat(readFileSync(fixture("statement.pdf")).subarray(0, 32)), "pdf");
    assert.equal(detectFormat(readFileSync(fixture("statement.csv")).subarray(0, 32)), "csv");
  });

  test("rejects the spoofed PDF whatever its name says", () => {
    const head = readFileSync(fixture("spoofed.pdf")).subarray(0, 32);
    assert.equal(detectFormat(head), null);
    assert.equal(claimedFormat("spoofed.pdf"), "pdf");
  });

  test("rejects what the mock would answer with 415", () => {
    assert.equal(detectFormat(bytes("")), null);
    assert.equal(detectFormat(bytes("%PDF")), null);
    assert.equal(detectFormat(bytes("﻿date,description,amount\n")), null);
    // The mock reads 24 bytes and drops \r, so a CRLF header never matches.
    assert.equal(detectFormat(bytes("date,description,amount\r\n")), null);
    assert.equal(detectFormat(bytes("Date,Description,Amount\n")), null);
  });
});

describe("server payloads", () => {
  test("parses the fixed ready answer", () => {
    const job = parseJob({
      jobId: "job-demo-001",
      status: "ready",
      revision: 3,
      currency: "AUD",
      items: [{ id: "rec-001", merchant: "StreamBeam", amountMinor: 1999, cadence: "monthly", lastSeen: "2026-10-01" }],
    });
    assert.equal(job.report?.items[0].amountMinor, 1999);
  });

  test("turns a malformed answer into a ProtocolError that names no values", () => {
    const broken = [
      null,
      { jobId: "job-demo-001", status: "done", revision: 1 },
      { jobId: "job-demo-001", status: "queued", revision: "1" },
      { jobId: "job-demo-001", status: "ready", revision: 3, currency: "AUD" },
      {
        jobId: "job-demo-001",
        status: "ready",
        revision: 3,
        currency: "AUD",
        items: [{ id: "x", merchant: "SecretShop", amountMinor: 1.5, cadence: "monthly", lastSeen: "2026-10-01" }],
      },
    ];
    for (const payload of broken) {
      assert.throws(
        () => parseJob(payload),
        (error: unknown) => error instanceof ProtocolError && !error.message.includes("SecretShop"),
      );
    }
  });
});

describe("money and formatting", () => {
  test("the fixed report totals 151,99 AUD a month", () => {
    const items = [
      { id: "rec-001", merchant: "StreamBeam", amountMinor: 1999, cadence: "monthly", lastSeen: "2026-10-01" },
      { id: "rec-002", merchant: "BrightGrid", amountMinor: 13200, cadence: "monthly", lastSeen: "2026-10-03" },
    ];
    assert.equal(monthlyTotalMinor(items), 15199);
    assert.equal(formatMinor(15199, "AUD"), "151,99 AUD");
    assert.equal(formatMinor(123456789, "AUD"), "1 234 567,89 AUD");
    assert.equal(formatDay("2026-10-03"), "3 октября 2026");
    assert.equal(formatBytes(33882), "33,1 КБ");
  });

  test("file names become ASCII header values within the mock's limit", () => {
    assert.equal(headerFileName("statement.csv"), "statement.csv");
    assert.equal(headerFileName("Выписка.pdf"), "%D0%92%D1%8B%D0%BF%D0%B8%D1%81%D0%BA%D0%B0.pdf");
    const long = headerFileName("я".repeat(200));
    assert.ok(long.length <= 255 && !/%[0-9A-F]?$/.test(long));
  });
});

describe("log sanitizer", () => {
  test("drops unknown fields and anything that isn't an id-like value", () => {
    const fields = { opId: "op-1", reason: "statement.pdf", status: "ready", name: "x" } as never;
    assert.deepEqual(sanitize(fields), { opId: "op-1", status: "ready" });
  });
});

describe("revision gate", () => {
  const job = (status: JobSnapshot["status"], revision: number): JobSnapshot => ({
    jobId: "job-demo-001",
    status,
    revision,
    report: null,
  });
  const op = (patch: Partial<ImportOperation>): ImportOperation => ({
    ...createOperation({ opId: "op", key: "key-0001", name: "f.csv", size: 1, format: "csv", copyUri: "x", sha256: null, now: 0 }),
    ...patch,
  });

  test("an older revision never replaces a newer one", () => {
    const ready = op({ phase: "accepted", job: job("ready", 3) });
    assert.equal(applySnapshot(ready, job("processing", 2)).ignored, "stale");
    assert.equal(applySnapshot(ready, job("ready", 3)).ignored, "same");
  });

  test("a late answer can't resurrect a deleting or deleted job", () => {
    const deleting = op({ phase: "deleting", deleteKey: "del-0001", job: job("deleting", 4) });
    assert.equal(applySnapshot(deleting, job("ready", 3)).ignored, "stale");
    const deleted = op({ phase: "deleted", deleteKey: "del-0001", job: job("deleted", 5) });
    assert.equal(applySnapshot(deleted, job("ready", 3)).ignored, "stale");
    // Even a newer non-delete revision is refused once deletion was asked for.
    const asked = op({ phase: "deleting", deleteKey: "del-0001", job: job("ready", 3) });
    assert.equal(applySnapshot(asked, job("ready", 6)).ignored, "after_delete");
  });

  test("a retried delete keeps its first key", () => {
    const failed = op({ phase: "delete_failed", deleteKey: "del-first", job: job("ready", 3) });
    const retried = reduce(failed, { type: "delete_requested", deleteKey: "del-second" }, 1).op;
    assert.equal(retried.deleteKey, "del-first");
    assert.equal(retried.phase, "deleting");
  });

  test("409 on create is a dead end, not a retry", () => {
    const sending = op({ phase: "sending" });
    assert.deepEqual(reduce(sending, { type: "post_refused", status: 409 }, 1).op.failure, { kind: "conflict" });
  });
});

describe("screen wording", () => {
  const report = {
    currency: "AUD",
    items: [{ id: "rec-001", merchant: "StreamBeam", amountMinor: 1999, cadence: "monthly", lastSeen: "2026-10-01" }],
  };
  const base = createOperation({ opId: "op", key: "key-0001", name: "f.csv", size: 112, format: "csv", copyUri: null as never, sha256: null, now: 0 });
  const idle: EngineState = { op: null, activity: null, offline: false, invalidResponse: false, syncedAt: null, rejection: null, unsaved: false };
  const view = (patch: Partial<ImportOperation>) => {
    const op = { ...base, ...patch };
    return importView(op, { ...idle, op });
  };
  const said = (result: ReturnType<typeof view>) =>
    [result.notice?.title, result.notice?.body, ...[...result.steps, ...(result.deletion ?? [])].flatMap((s) => [s.title + (s.state === "done" ? " ✓" : ""), s.detail])].join(" | ");

  test("202 reads as accepted, not as a report", () => {
    const result = view({ phase: "accepted", job: { jobId: "job-demo-001", status: "queued", revision: 1, report: null } });
    assert.equal(result.notice?.title, "Сервер обрабатывает выписку");
    assert.equal(result.showReport, false);
    assert.ok(!said(result).includes("Отчёт готов ✓"));
  });

  test("a job still in progress can be deleted, and a long wait is said out loud", () => {
    const processing = { ...base, phase: "accepted" as const, job: { jobId: "job-demo-001", status: "processing" as const, revision: 2, report: null }, updatedAt: 1_000 };
    const at = (syncedAt: number) => importView(processing, { ...idle, op: processing, syncedAt });
    assert.equal(at(1_000).canDelete, true, "deleting doesn't wait for the report");
    assert.equal(at(1_000 + SLOW_AFTER_MS - 1).notice?.title, "Сервер обрабатывает выписку");
    assert.equal(at(1_000 + SLOW_AFTER_MS).notice?.title, "Обработка идёт дольше обычного");
    assert.equal(view({ phase: "sending" }).canDelete, false, "nothing to delete before the server has a job");
  });

  test("nothing says deleted until the server does", () => {
    const ready = { jobId: "job-demo-001", status: "ready" as const, revision: 3, report };
    for (const phase of ["deleting", "delete_failed"] as const) {
      const result = view({ phase, deleteKey: "del-0001", deleteError: phase === "delete_failed" ? { status: 503 } : null, job: ready });
      assert.ok(!said(result).includes("Удалено ✓"), phase);
      assert.ok(!said(result).includes("Удалено на сервере"), phase);
    }
    const failed = view({ phase: "delete_failed", deleteKey: "del-0001", deleteError: { status: 503 }, job: ready });
    assert.equal(failed.notice?.title, "Не удалось удалить");
    assert.match(failed.notice?.body ?? "", /503.*по-прежнему на сервере/);
    assert.equal(failed.showReport, true, "the data is still there, so it is still shown");
    assert.deepEqual(failed.actions, ["retry_delete"]);

    const deleted = view({ phase: "deleted", deleteKey: "del-0001", job: { jobId: "job-demo-001", status: "deleted", revision: 5, report: null } });
    assert.equal(deleted.notice?.title, "Удалено на сервере");
    assert.ok(said(deleted).includes("Удалено ✓"));
  });

  test("an unanswered POST is shown as unknown, with a check, not as a failure", () => {
    const result = view({ phase: "unknown" });
    assert.equal(result.notice?.title, "Неизвестно, дошёл ли файл");
    assert.deepEqual(result.actions, ["check"]);
  });
});

describe("haptic feedback", () => {
  const at = (phase: Moment["phase"], status: Moment["status"] = null, rejection: Moment["rejection"] = null): Moment => ({
    phase,
    status,
    rejection,
  });
  const rejection = { reason: "too_large", name: "oversize.csv", size: 1, claimed: "csv" } as const;

  test("success only once the outcome is known", () => {
    assert.equal(feedbackFor(at(null), at("confirming")), "tap", "the file passed the device checks");
    assert.equal(feedbackFor(at("confirming"), at("sending")), "tap");
    assert.equal(feedbackFor(at("sending"), at("accepted", "queued")), null, "202 is not the result yet");
    assert.equal(feedbackFor(at("accepted", "queued"), at("accepted", "processing")), null);
    assert.equal(feedbackFor(at("accepted", "processing"), at("accepted", "ready")), "success");
    assert.equal(feedbackFor(at("deleting", "deleting"), at("deleted", "deleted")), "success");
  });

  test("failures and doubt are felt, repeats of the same state are not", () => {
    assert.equal(feedbackFor(at(null), at(null, null, rejection)), "error");
    assert.equal(feedbackFor(at("sending"), at("unknown")), "warning");
    assert.equal(feedbackFor(at("deleting", "ready"), at("delete_failed", "ready")), "error");
    assert.equal(feedbackFor(at("sending"), at("failed")), "error");
    assert.equal(feedbackFor(at("accepted", "ready"), at("accepted", "ready")), null, "a poll that changes nothing");
    assert.equal(feedbackFor(at("unknown"), at("sending")), null, "the engine's own resend is not a tap");
  });
});

describe("delete confirmation and storage", () => {
  const job = (status: JobSnapshot["status"], revision: number): JobSnapshot => ({
    jobId: "job-demo-001",
    status,
    revision,
    report: null,
  });
  const deleting = {
    ...createOperation({ opId: "op", key: "key-0001", name: "f.csv", size: 1, format: "csv", copyUri: "x", sha256: null, now: 0 }),
    phase: "deleting" as const,
    deleteKey: "del-0001",
    job: job("ready", 3),
  };

  test("a DELETE's own answer can't confirm the deletion", () => {
    const result = reduce(deleting, { type: "delete_accepted", job: job("deleted", 5) }, 1);
    assert.equal(result.ignored, "unconfirmed");
    assert.equal(result.op.phase, "deleting");
    assert.equal(reduce(deleting, { type: "delete_accepted", job: job("deleting", 4) }, 1).op.job?.status, "deleting");
    assert.equal(reduce(deleting, { type: "snapshot", job: job("deleted", 5) }, 1).op.phase, "deleted");
  });

  test("a blank or malformed record reads as nothing", () => {
    const values = new Map<string, string>();
    const store = createOperationStore({
      getString: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    });
    for (const raw of ["", "{", "null", '{"version":1,"key":"k"}', '{"version":2,"opId":"o","key":"k","phase":"accepted","file":{"format":"csv","size":1}}']) {
      values.set("statement-import.operation", raw);
      assert.equal(store.load(), null, raw);
    }
    store.save(deleting);
    assert.equal(store.load()?.deleteKey, "del-0001");
    assert.equal(store.load()?.file.name, null);
  });
});
