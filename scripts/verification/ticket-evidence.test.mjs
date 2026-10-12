// Producer ticket evidence, exercised through real verification-lane acquisition
// against private slot roots.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketEvidenceError, acquireVerificationSlot } from "../../tools/rust-engine-program/build-slot.mjs";
import { processIdentity, ticketEvidence } from "./ticket-evidence.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const producer = { ProcessId: process.pid, CreationTimeUtc: "2026-10-09T08:00:00.1234560Z" };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-ticket-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "result");
  mkdirSync(output);
  return { slots: join(root, "slots"), output };
}

function queued(slots) {
  const dir = join(slots, "verification-slot-queue");
  return existsSync(dir) ? readdirSync(dir) : [];
}

test("the verifier retains the exact published ticket before admission and records its removal", async t => {
  const { slots, output } = fixture(t);
  const persisted = [];
  const evidence = ticketEvidence({ output, checkout: "fixture-checkout", commit: "fixture-commit", producer,
    persist: () => persisted.push(JSON.parse(JSON.stringify(evidence.record))) });
  let seen;
  const slot = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: slots }, { metadata: { purpose: "full PR verification", checkout: "fixture-checkout", commit: "fixture-commit" },
    observeTicket: ticket => {
      seen = { bytes: readFileSync(ticket.path), laneExists: existsSync(join(slots, "verification-slot-1")) };
      evidence.observe(ticket);
    } });
  let cleanup;
  try { cleanup = evidence.settle(); }
  finally { slot.release(); }
  assert.equal(cleanup, null);
  assert.equal(seen.laneExists, false);
  const [entry] = evidence.record.observations;
  assert.equal(evidence.record.observations.length, 1);
  assert.deepEqual(readFileSync(join(output, entry.payloadFile)), seen.bytes);
  assert.equal(entry.sha256, sha256(seen.bytes));
  const observationBytes = readFileSync(join(output, entry.observationFile));
  assert.equal(entry.observationSha256, sha256(observationBytes));
  const observation = JSON.parse(observationBytes);
  assert.deepEqual({ ...observation, readStartedAt: undefined, readFinishedAt: undefined }, {
    schema: "dohc-verification-ticket-observation-v1", meaning: "producer-before-admission", index: 1,
    queueRoot: slots, kind: "verification-slot", ticket: entry.ticket, path: join(slots, "verification-slot-queue", entry.ticket),
    readStartedAt: undefined, readFinishedAt: undefined, bytes: seen.bytes.length, sha256: entry.sha256,
    text: seen.bytes.toString("utf8"), payload: JSON.parse(seen.bytes), payloadFile: entry.payloadFile,
    checkout: "fixture-checkout", commit: "fixture-commit", producer,
  });
  assert.equal(observation.payload.pid, process.pid);
  assert.ok(Date.parse(observation.readStartedAt) <= Date.parse(observation.readFinishedAt));
  assert.deepEqual(persisted.map(record => record.observations), [evidence.record.observations]);
  assert.deepEqual(evidence.record.cleanup.map(({ ticket, state }) => ({ ticket, state })), [{ ticket: entry.ticket, state: "absent" }]);
});

test("ticket read, parse, and persistence failures reject before admission without retry", async t => {
  for (const fault of ["missing", "corrupt", "blocked", "persist"]) {
    const { slots, output } = fixture(t);
    if (fault === "blocked") writeFileSync(join(output, "ticket-evidence"), "not a directory");
    const evidence = ticketEvidence({ output, checkout: "fixture-checkout", commit: "fixture-commit", producer,
      persist: () => { if (fault === "persist") throw Object.assign(new Error("fixture receipt write failed"), { code: "EBUSY" }); } });
    let calls = 0;
    const error = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: slots }, { observeTicket: ticket => {
      calls += 1;
      if (fault === "missing") rmSync(ticket.path);
      if (fault === "corrupt") writeFileSync(ticket.path, "{torn");
      evidence.observe(ticket);
    } }).then(() => null, error => error);
    assert.ok(error instanceof TicketEvidenceError, `${fault}: ${error}`);
    if (fault === "missing") assert.equal(error.cause.code, "ENOENT");
    if (fault === "persist") assert.match(error.message, /fixture receipt write failed/);
    assert.equal(calls, 1, fault);
    assert.equal(existsSync(join(slots, "verification-slot-1")), false, fault);
    assert.deepEqual(queued(slots), [], fault);
    assert.equal(evidence.settle(), null, fault);
    assert.equal(evidence.record.observations.length, fault === "persist" ? 1 : 0, fault);
  }
});

const helperUrl = new URL("./ticket-evidence.mjs", import.meta.url).href;
const buildSlotUrl = new URL("../../tools/rust-engine-program/build-slot.mjs", import.meta.url).href;

function evidenceProbe(root, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = process.argv[1];
    const producer = { ProcessId: process.pid, CreationTimeUtc: "2026-10-09T08:00:00.1234560Z" };
    ${script}
  `, root], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test("a retained copy that differs from the bytes read rejects before admission", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-ticket-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  evidenceProbe(root, `
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, data, options) => write(path,
      String(path).includes("ticket-evidence") && !String(path).endsWith(".observation.json") ? Buffer.concat([Buffer.from(data), Buffer.from(" ")]) : data, options);
    syncBuiltinESMExports();
    const { ticketEvidence } = await import(${JSON.stringify(helperUrl)});
    const { acquireVerificationSlot, TicketEvidenceError } = await import(${JSON.stringify(buildSlotUrl)});
    const evidence = ticketEvidence({ output: join(root, "result"), checkout: "fixture-checkout", commit: "fixture-commit", producer, persist: () => {} });
    let calls = 0;
    const error = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: join(root, "slots") }, { observeTicket: ticket => { calls += 1; evidence.observe(ticket); } })
      .then(() => null, error => error);
    assert.ok(error instanceof TicketEvidenceError, String(error));
    assert.match(error.message, /differs from the bytes read/);
    assert.equal(calls, 1);
    assert.equal(evidence.record.observations.length, 0);
    assert.equal(fs.existsSync(join(root, "slots", "verification-slot-1")), false);
    assert.deepEqual(fs.readdirSync(join(root, "slots", "verification-slot-queue")), []);
  `);
});

test("a surviving or unreadable own ticket fails cleanup while the acquired lane keeps its release handle", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-ticket-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  evidenceProbe(root, `
    const remove = fs.rmSync;
    const lstat = fs.lstatSync;
    let unreadable = false;
    const ticketPath = path => String(path).includes("verification-slot-queue") && String(path).endsWith(".json");
    fs.rmSync = (path, options) => {
      if (ticketPath(path)) throw Object.assign(new Error("fixture deletion failure"), { code: "EACCES" });
      return remove(path, options);
    };
    fs.lstatSync = (path, options) => {
      if (unreadable && ticketPath(path)) throw Object.assign(new Error("fixture ticket unreadable"), { code: "EPERM" });
      return lstat(path, options);
    };
    syncBuiltinESMExports();
    const { ticketEvidence } = await import(${JSON.stringify(helperUrl)});
    const { acquireVerificationSlot } = await import(${JSON.stringify(buildSlotUrl)});
    const evidence = ticketEvidence({ output: join(root, "result"), checkout: "fixture-checkout", commit: "fixture-commit", producer, persist: () => {} });
    const slot = await acquireVerificationSlot({ DOHC_BUILD_SLOT_ROOT: join(root, "slots") }, { observeTicket: evidence.observe });
    const [{ ticket }] = evidence.record.observations;
    assert.match(evidence.settle(), new RegExp(ticket.replaceAll(".", "\\\\.") + " is present"));
    assert.equal(evidence.record.cleanup[0].state, "present");
    unreadable = true;
    assert.match(evidence.settle(), /is unreadable/);
    assert.match(evidence.record.cleanup[0].error, /fixture ticket unreadable/);
    assert.equal(fs.existsSync(slot.dir), true);
    slot.release();
    assert.equal(fs.existsSync(slot.dir), false);
    assert.match(fs.readFileSync(join(root, "slots", "events.log"), "utf8"), /ticket cleanup failed/);
  `);
});

test("process identity reports one live creation time and never infers a missing one", () => {
  const row = { ProcessId: 4242, ParentProcessId: 7, Name: "node.exe", CreationTimeUtc: "2026-10-09T08:00:00.1234560Z" };
  const identity = processIdentity({ pid: 4242, platform: "win32", query: () => JSON.stringify(row) });
  assert.deepEqual({ ...identity, requestedAt: undefined, observedAt: undefined },
    { ...row, source: "Win32_Process.CreationDate", requestedAt: undefined, observedAt: undefined });
  for (const [name, query] of [
    ["no process", () => ""],
    ["another pid", () => JSON.stringify({ ...row, ProcessId: 4243 })],
    ["two rows", () => JSON.stringify([row, row])],
    ["no creation time", () => JSON.stringify({ ...row, CreationTimeUtc: null })],
    ["query failure", () => { throw new Error("fixture CIM failure"); }],
  ]) {
    const missing = processIdentity({ pid: 4242, platform: "win32", query });
    assert.equal(missing.CreationTimeUtc, null, name);
    assert.equal(missing.ProcessId, 4242, name);
    assert.ok(missing.unavailable, name);
  }
  let queried = false;
  const unsupported = processIdentity({ pid: 4242, platform: "linux", query: () => { queried = true; } });
  assert.equal(queried, false);
  assert.deepEqual([unsupported.CreationTimeUtc, unsupported.unavailable], [null, "Creation-time identity is recorded only on win32, not linux."]);
});

test("the live Windows identity is this process with its OS creation time", { skip: process.platform !== "win32" }, () => {
  const identity = processIdentity();
  assert.equal(identity.unavailable, undefined, identity.unavailable);
  assert.deepEqual([identity.ProcessId, identity.ParentProcessId], [process.pid, process.ppid]);
  const started = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(Date.parse(identity.CreationTimeUtc) - started) < 60_000, `${identity.CreationTimeUtc} is not this process's start`);
});
