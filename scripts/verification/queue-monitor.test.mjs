// The queue monitor: the snapshot its page draws, a run's details, and who the server answers.

import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSampler, monitorState, runDetails, runLog, slotLog, startMonitor, threadDirectory, waitingIntervals } from "./queue-monitor.mjs";
import { listRequests, queuePaths, writeJson } from "./queue.mjs";

const now = Date.parse("2026-10-15T12:00:00Z");
const iso = minutesAgo => new Date(now - minutesAgo * 60_000).toISOString();
const head = "a".repeat(40), base = "b".repeat(40);

async function queueRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-monitor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = queuePaths(root);
  const add = async (id, request, status) => {
    await writeJson(join(paths.request(id), "request.json"), { head, base, scope: "all", checkout: "C:\\w\\x", submittedAt: iso(300), sequence: Number(id.slice(0, 9)), ...request, id });
    await writeJson(join(paths.request(id), "status.json"), status);
  };
  await add("000000001-aaaaaa", { branch: "refs/heads/old" }, { state: "passed", updatedAt: iso(9 * 1440), attempts: [{ n: 1, startedAt: iso(9 * 1440 + 30), endedAt: iso(9 * 1440), outcome: "passed" }] });
  await add("000000002-bbbbbb", { branch: "refs/heads/done" }, { state: "passed", attempts: [
    { n: 1, startedAt: iso(200), endedAt: iso(190), outcome: "environment", cause: "service restart", lane: 1, awakeMs: 600_000 },
    { n: 2, startedAt: iso(180), endedAt: iso(150), outcome: "passed", cause: "pass", lane: 1, awakeMs: 1_800_000, flaky: [{ step: "rust", test: "engine::settles" }] }] });
  await add("000000003-cccccc", { branch: "refs/heads/now" }, { state: "running", attempts: [{ n: 1, startedAt: iso(10), lane: 2 }] });
  await writeJson(join(paths.attempt("000000003-cccccc", 1), "result.json"), { verdict: "RUNNING", steps: [{ name: "install", verdict: "PASS", seconds: 2.4 }, { name: "tests", verdict: "RUNNING", startedAt: iso(8) }, { name: "rust", verdict: "RUNNING", startedAt: iso(9) }] });
  // The running attempt's logs: the verifier's own, then a step's, written later.
  for (const [name, minutesAgo] of [["worker.log", 5], ["rust.log", 1]]) {
    writeFileSync(join(paths.attempt("000000003-cccccc", 1), name), `${name}\n`);
    utimesSync(join(paths.attempt("000000003-cccccc", 1), name), new Date(now - minutesAgo * 60_000), new Date(now - minutesAgo * 60_000));
  }
  await add("000000004-dddddd", { branch: "refs/heads/again" }, { state: "queued", waiting: "Docker did not answer. Retrying.", attempts: [{ n: 1, startedAt: iso(60), endedAt: iso(55), outcome: "environment" }] });
  await add("000000005-eeeeee", { branch: "refs/heads/main", checkout: "nightly", nightly: true }, { state: "queued", attempts: [] });
  await writeJson(paths.service, { protocol: 1, pid: 1, commit: "c".repeat(40), startedAt: iso(500), heartbeatAt: iso(0.1), lanes: 2,
    running: [{ id: "000000003-cccccc", attempt: 1, checkout: "C:\\w\\_verification\\lane-2", phase: "verifying", startedAt: iso(10), awakeMs: 540_000 }], health: { cpuBusyPercent: 40, freeMemGb: 20 } });
  const event = (minutesAgo, fields) => appendFileSync(paths.history, `${JSON.stringify({ at: iso(minutesAgo), event: "finished", ...fields })}\n`);
  event(9 * 1440, { flaky: [{ step: "rust", test: "engine::settles" }], slowest: [{ step: "desktop", test: "states page", seconds: 900 }] });
  event(150, { outcome: "passed", steps: { tests: 1000, rust: 900 }, flaky: [{ step: "rust", test: "engine::settles" }, { step: "repository", test: "heartbeat", passedAlone: true }], slowest: [{ step: "desktop", test: "states page", seconds: 280 }, { step: "rust", test: "capture", seconds: 80 }] });
  event(100, { outcome: "passed", steps: { tests: 1200 }, flaky: [{ step: "rust", test: "engine::settles" }, { step: "repository", test: "heartbeat" }], slowest: [{ step: "desktop", test: "states page", seconds: 260 }] });
  appendFileSync(paths.history, "a torn line\n");
  return root;
}

test("the snapshot shows the week's attempts with their lanes, the line in order, and the week's flaky and slow tests", async t => {
  const root = await queueRoot(t);
  const state = monitorState(root, { now });
  assert.equal(state.service.alive, true);
  assert.equal(state.service.lanes, 2);
  assert.deepEqual(state.runs.map(run => [run.id, run.attempt, run.outcome, run.lane]), [
    ["000000002-bbbbbb", 1, "environment", 1], ["000000002-bbbbbb", 2, "passed", 1], ["000000004-dddddd", 1, "environment", null], ["000000003-cccccc", 1, "running", 2]],
    "an attempt older than the week is left out, and each keeps its lane");
  const running = state.runs.find(run => run.outcome === "running");
  assert.deepEqual(running.steps.map(step => [step.name, step.verdict, step.seconds]), [["install", "PASS", 2], ["tests", "RUNNING", null], ["rust", "RUNNING", null]], "a running attempt shows its steps from its receipt so far");
  assert.deepEqual([running.awakeMs, running.phase, running.head], [540_000, "verifying", head.slice(0, 12)]);
  assert.deepEqual(running.logs.map(log => log.file), ["rust.log", "worker.log"], "its logs, the most recently written first");
  assert.deepEqual(state.stepTimes.map(step => [step.name, step.runs, step.medianSeconds]), [["tests", 2, 1200], ["rust", 1, 900]], "each step's median in the week's passing runs");
  assert.equal(state.runs.find(run => run.outcome === "passed").flaky, 1);
  assert.equal(state.typicalMs, 1_800_000);
  assert.deepEqual(state.queued.map(entry => [entry.branch, entry.retry, entry.nightly]), [["main (nightly)", false, true], ["again", true, false]], "the nightly run goes first");
  assert.equal(state.queued[1].waiting, "Docker did not answer. Retrying.");
  assert.deepEqual(state.flaky.map(item => [item.test, item.flaky, item.passedAlone]), [["heartbeat", 1, 1], ["engine::settles", 2, 0]],
    "only this week's flaky tests count, and a test that passed alone, which would have failed the gate, counts apart and goes first");
  assert.deepEqual(state.slowest.map(item => [item.test, item.runs, item.totalSeconds]), [["states page", 2, 540], ["capture", 1, 80]]);
  assert.deepEqual(state.nightly, { id: "000000005-eeeeee", head: head.slice(0, 12), state: "queued", at: null });
  assert.equal(state.lastNightlyPass, null);
});

test("the line is drawn in the order moves gave it, and a moved request says who moved it and why, in line and once it runs", async t => {
  const root = await queueRoot(t);
  const paths = queuePaths(root);
  const add = async (id, branch, status) => {
    await writeJson(join(paths.request(id), "request.json"), { head, base, scope: "all", checkout: "C:\\w\\y", branch, submittedAt: iso(20), sequence: Number(id.slice(0, 9)), id });
    await writeJson(join(paths.request(id), "status.json"), { state: "queued", attempts: [], ...status });
  };
  await add("000000006-ffffff", "refs/heads/fix/grid", { order: 3,
    moved: { at: iso(5), before: "000000004-dddddd", reason: "fixes the grid test three branches fail", by: { name: null, user: "ice", cwd: "C:\\w\\fix-grid" } } });
  await add("000000007-gggggg", "refs/heads/later");
  assert.deepEqual(monitorState(root, { now }).queued.map(entry => [entry.branch, entry.moved]), [
    ["main (nightly)", null],
    ["fix/grid", "moved before 000000004-dddddd by ice (C:\\w\\fix-grid)\nfixes the grid test three branches fail"],
    ["again", null],
    ["later", null]], "the nightly still goes first, the moved request is ahead of the one it was moved before, and its tooltip names who moved it and why");
  // A moved request keeps its mark in its lane once it runs.
  await writeJson(join(paths.request("000000003-cccccc"), "status.json"), { state: "running", attempts: [{ n: 1, startedAt: iso(10), lane: 2 }],
    moved: { at: iso(30), before: null, reason: "unblocks the others", by: { name: "Ice", user: "ice", cwd: "C:\\w\\now" } } });
  const runs = monitorState(root, { now }).runs;
  assert.equal(runs.find(run => run.outcome === "running").moved, "moved first by Ice (C:\\w\\now)\nunblocks the others");
  assert.ok(runs.filter(run => run.outcome !== "running").every(run => !("moved" in run)), "a finished run carries no mark");
});

test("a service that stopped beating is shown as not responding", async t => {
  const root = await queueRoot(t);
  assert.equal(monitorState(root, { now: now + 5 * 60_000 }).service.alive, false);
});

test("run details show a failing step's test summary and never read a file outside the attempt", async t => {
  const root = await queueRoot(t);
  const folder = queuePaths(root).attempt("000000002-bbbbbb", 2);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "repository.log"), `${"✔ passes\n".repeat(500)}✖ failing tests:\n\ntest at scripts\\a.test.mjs:1:1\n\x1b[31m✖ the heartbeat keeps\x1b[39m\n`);
  writeFileSync(join(root, "outside.log"), "a secret");
  await writeJson(join(folder, "result.json"), { verdict: "FAIL", error: "tests failed", steps: [
    { name: "tests", verdict: "FAIL", seconds: 1460.4, log: join(folder, "repository.log") },
    { name: "rust", verdict: "FAIL", log: join(root, "outside.log") },
    { name: "typecheck", verdict: "PASS", seconds: 30, log: join(folder, "repository.log") }] });
  const details = runDetails(root, "000000002-bbbbbb", "2");
  assert.equal(details.branch, "done");
  assert.deepEqual(details.steps.map(step => [step.name, step.verdict, step.seconds]), [["tests", "FAIL", 1460], ["rust", "FAIL", null], ["typecheck", "PASS", 30]]);
  assert.equal(details.steps[0].excerpt, "✖ failing tests:\n\ntest at scripts\\a.test.mjs:1:1\n✖ the heartbeat keeps\n", "the excerpt starts at the runner's summary, without colors");
  assert.equal(details.steps[1].excerpt, null, "a log outside the attempt's folder is never read");
  assert.equal(details.steps[2].excerpt, null, "a passing step's log is not sent");
  assert.equal(runDetails(root, "../../000000002-bbbbbb", "2"), null);
  assert.equal(runDetails(root, "000000002-bbbbbb", "2/../../1"), null);
  assert.equal(runDetails(root, "000000009-ffffff", "1"), null, "a request that is gone has no details");
});

test("a log is read from its end, only by a log name inside the attempt", async t => {
  const root = await queueRoot(t);
  const folder = queuePaths(root).attempt("000000002-bbbbbb", 2);
  mkdirSync(join(folder, "js-tests"), { recursive: true });
  const lines600 = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(join(folder, "js-tests", "_dohc_desktop.log"), `${lines600}\n\x1b[32mbuilding 10%\rbuilding 100%\x1b[39m\n`);
  writeFileSync(join(root, "secret.log"), "secret");
  const log = runLog(root, "000000002-bbbbbb", "2", "js-tests/_dohc_desktop.log");
  const lines = log.text.split("\n");
  assert.equal(lines.at(-2), "building 100%", "a progress line shows its last state, without colors");
  assert.equal(lines[0], "line 202", "only the last 400 lines");
  for (const file of ["../../secret.log", "js-tests/../../../secret.log", "..\\..\\secret.log", "status.json", "/etc/passwd"]) assert.equal(runLog(root, "000000002-bbbbbb", "2", file), null, file);
  assert.equal(runLog(root, "000000002-bbbbbb", "9", "js-tests/_dohc_desktop.log"), null);
  assert.deepEqual(runDetails(root, "000000002-bbbbbb", "2").logs.map(item => item.file), ["js-tests/_dohc_desktop.log"]);
  // A link inside the attempt that leads out of it reads nothing. A junction needs no privilege on Windows.
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "secret.log"), "secret");
  mkdirSync(queuePaths(root).attempt("000000002-bbbbbb", 3), { recursive: true });
  symlinkSync(join(root, "outside"), join(queuePaths(root).attempt("000000002-bbbbbb", 3), "js-tests"), "junction");
  assert.equal(runLog(root, "000000002-bbbbbb", "3", "js-tests/secret.log"), null);
  try { symlinkSync(join(root, "secret.log"), join(folder, "linked.log"), "file"); }
  catch (error) { if (error.code === "EPERM") return; throw error; }
  assert.equal(runLog(root, "000000002-bbbbbb", "2", "linked.log"), null);
});

test("the waiting count is rebuilt from the requests: until each first attempt, and between a machine failure and its retry", async t => {
  const root = await queueRoot(t);
  const requests = listRequests(root);
  const waiting = at => waitingIntervals(requests, now).filter(([start, end]) => start <= at && at < end).length;
  assert.equal(waiting(Date.parse(iso(185))), 4, "the retry of a machine failure waits again");
  assert.equal(waiting(Date.parse(iso(100))), 3);
  assert.equal(waiting(Date.parse(iso(30))), 3, "a request that failed for the machine waits for its retry");
  writeFileSync(join(root, "monitor-load.json"), JSON.stringify({ samples: { at: "not a list" } }));
  const buckets = loadSampler(root, () => ({ runs: [], queued: [] }), { everyMs: 3_600_000 }).read(1, 120, requests, now);
  assert.equal(buckets.length, 120);
  assert.equal(buckets.at(-1).queued, 2, "six minutes ago: the nightly run and the retry wait");
  assert.equal(buckets.at(-1).running, 1);
});

function get(port, path, { host = `127.0.0.1:${port}`, method = "GET" } = {}) {
  return new Promise((done, fail) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => done({ status: response.statusCode, type: response.headers["content-type"], body }));
    });
    call.on("error", fail);
    call.end();
  });
}

test("the server answers only reads, and only on this host's names and the tailnet", async t => {
  const root = await queueRoot(t);
  const server = startMonitor({ root, port: 0 });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const { port } = server.address();
  const page = await get(port, "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Verification queue<\/title>/u);
  const state = await get(port, "/api/state");
  assert.equal(state.type, "application/json");
  assert.equal(JSON.parse(state.body).runs.length > 0, true);
  assert.equal((await get(port, "/api/state", { host: "pc.example.ts.net:8446" })).status, 200, "the tailnet name reaches the page");
  assert.equal((await get(port, "/api/state", { host: "attacker.example" })).status, 403, "a name rebound to this host does not");
  assert.equal((await get(port, "/api/state", { method: "POST" })).status, 405);
  assert.equal((await get(port, "/api/run?id=000000002-bbbbbb&attempt=7")).status, 404);
  assert.equal((await get(port, "/elsewhere")).status, 404);
  const script = await get(port, "/app.js");
  assert.equal(script.status, 200);
  assert.match(script.type, /javascript/u);
  assert.equal((await get(port, "/api/log?id=000000003-cccccc&attempt=1&file=..%2F..%2Fstatus.json")).status, 404);
  assert.equal(JSON.parse((await get(port, "/api/log?id=000000003-cccccc&attempt=1&file=rust.log")).body).text, "rust.log\n");
  assert.equal(JSON.parse((await get(port, "/api/load?days=7")).body).samples.length, 288);
});

test("a request is named by the T3 thread whose worktree, linked pull request, or branch it uses", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-t3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sqlite = process.getBuiltinModule("node:sqlite");
  const path = join(dir, "statev2.sqlite");
  const db = new sqlite.DatabaseSync(path);
  db.exec("create table orchestration_v2_projection_threads (thread_id text, title text, payload_json text, updated_at text, deleted_at text)");
  const add = (id, title, payload, deleted = null) => db.prepare("insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?)").run(id, title, JSON.stringify(payload), new Date().toISOString(), deleted);
  add("t1", "Fix the share page", { worktreePath: "C:/w/share-page", branch: "main" });
  add("t2", "Agent review", { createdBy: "agent", pullRequests: [{ number: 7, snapshot: { headBranch: "feat/sync" } }] });
  add("t3", "Make sync faster", { createdBy: "user", pullRequests: [{ number: 7, snapshot: { headBranch: "feat/sync" } }] });
  add("t4", "Old thread", { branch: "feat/gone" }, new Date().toISOString());
  add("t5", "Tidy styles", { branch: "fix/styles" });
  add("t6", "A later shape", { worktreePath: 5, pullRequests: 3 });
  db.close();
  const threadOf = threadDirectory({ path });
  assert.deepEqual(threadOf("anything", "c:/w/share-page"), { id: "t1", title: "Fix the share page" }, "by the thread's own worktree, whatever the case");
  assert.deepEqual(threadOf("feat/sync", "C:/w/elsewhere"), { id: "t3", title: "Make sync faster", pr: 7 }, "by a linked pull request, preferring the thread a person started");
  assert.deepEqual(threadOf("fix/styles", null), { id: "t5", title: "Tidy styles" }, "a row in a shape this reader does not know costs only its own name");
  assert.equal(threadOf("feat/gone", null), null, "a deleted thread names nothing");
  assert.equal(threadDirectory({ path: join(dir, "missing.sqlite") })("feat/sync", null), null, "without T3 every lookup is null");
});

test("the lanes show the gate holding each verification slot, an agent's inline gate with its own steps and logs, and each thread's week", async t => {
  const root = await queueRoot(t);
  const checkout = mkdtempSync(join(tmpdir(), "dohc-inline-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/fix/inline-thing\n");
  const run = join(checkout, ".agent-artifacts", "verification", "2026-10-15T11-00-00.000Z-abcdef12");
  mkdirSync(run, { recursive: true });
  await writeJson(join(run, "result.json"), { commit: "d".repeat(40), steps: [{ name: "rust", verdict: "RUNNING", startedAt: iso(5) }] });
  writeFileSync(join(run, "rust.log"), "compiling\n");
  writeFileSync(join(checkout, "secret.log"), "secret");
  const status = { slots: 2, owners: [
    { name: "verification-slot-1", start: iso(10), elapsedMs: 600_000, phase: "request 000000003-cccccc" },
    { name: "verification-slot-2", start: iso(5), elapsedMs: 300_000, checkout, commit: "d".repeat(40), phase: "tests", pid: 4 }],
    waiters: [{ position: 1, elapsedMs: 120_000, phase: "request 000000004-dddddd" }] };
  const threadOf = branch => ({ done: { id: "t1", title: "Ship the done thing" }, "fix/inline-thing": { id: "t2", title: "Inline work" } })[branch] ?? null;
  const state = monitorState(root, { now, threadOf, slots: () => status });
  assert.deepEqual(state.lanes.holders.map(holder => [holder.slot, holder.kind, holder.requestId ?? holder.branch]), [[1, "queue", "000000003-cccccc"], [2, "inline", "fix/inline-thing"]]);
  const inline = state.lanes.holders[1];
  assert.deepEqual([inline.thread.title, inline.head, inline.steps.map(step => step.name), inline.logs.map(log => log.file)], ["Inline work", "d".repeat(12), ["rust"], ["rust.log"]]);
  assert.deepEqual(state.lanes.waiters, [{ position: 1, waitedMs: 120_000, kind: "queue", requestId: "000000004-dddddd" }]);
  assert.equal(state.runs.find(run => run.id === "000000002-bbbbbb").thread.title, "Ship the done thing");
  const done = state.threads.find(item => item.title === "Ship the done thing");
  assert.deepEqual([done.runs, done.passed, done.machine, done.waiting, done.running, done.gateMs], [2, 1, 1, 0, 0, 40 * 60_000]);
  assert.deepEqual(state.threads.find(item => item.title === "Inline work").inline, 1);
  assert.equal(state.threads.find(item => item.title === "again").waiting, 1, "a request without a thread is named by its branch");
  assert.equal(slotLog(status, 2, "rust.log").text, "compiling\n");
  for (const file of ["../../../secret.log", "result.json"]) assert.equal(slotLog(status, 2, file), null, file);
  assert.equal(slotLog(status, 1, "rust.log"), null, "a queued request's logs are read by its id, not its slot");
});
