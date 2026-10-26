// The queue monitor: the snapshot its page draws, a run's details, and who the server answers.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSampler, monitorState, runDetails, runLog, slotLog, startMonitor, threadDirectory, waitingIntervals } from "./queue-monitor.mjs";
import { laneSetting, listRequests, nextRequest, pauseQueue, position, queueLanePurpose, queuePaths, readJson, readPause, resumeQueue, writeJson } from "./queue.mjs";
import { verificationLanes } from "../../tools/rust-engine-program/build-slot.mjs";

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

// A request to the monitor. A chunked body is sent in two writes, without a length.
function get(port, path, { host = `127.0.0.1:${port}`, method = "GET", headers = {}, body, chunked = false } = {}) {
  return new Promise((done, fail) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => done({ status: response.statusCode, type: response.headers["content-type"], headers: response.headers, body: text }));
    });
    call.on("error", fail);
    if (chunked) { call.write(body.slice(0, 10)); call.end(body.slice(10)); }
    else call.end(body);
  });
}

test("the server answers reads only on this host's names and the tailnet", async t => {
  const root = await queueRoot(t);
  const server = startMonitor({ root, port: 0, now: () => now });
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
  assert.equal((await get(port, "/api/state", { host: "pc.example.ts.net:8446", headers: { "tailscale-funnel-request": "?1" } })).status, 403, "a request through Funnel does not");
  assert.equal((await get(port, "/api/state", { method: "POST" })).status, 405);
  assert.equal((await get(port, "/api/run?id=000000002-bbbbbb&attempt=7")).status, 404);
  assert.equal((await get(port, "/elsewhere")).status, 404);
  const script = await get(port, "/app.js");
  assert.equal(script.status, 200);
  assert.match(script.type, /javascript/u);
  assert.doesNotMatch(script.body, /\/log\?/u, "uBlock Origin's default lists block URLs like /log?id=, so the page must not request one");
  assert.equal((await get(port, "/api/output?id=000000003-cccccc&attempt=1&file=..%2F..%2Fstatus.json")).status, 404);
  assert.equal(JSON.parse((await get(port, "/api/output?id=000000003-cccccc&attempt=1&file=rust.log")).body).text, "rust.log\n");
  assert.equal(JSON.parse((await get(port, "/api/load?days=7")).body).samples.length, 288);
});

test("a request is named by the T3 thread whose worktree, linked pull request, or branch it uses, and by the thread a person started above it", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-t3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sqlite = process.getBuiltinModule("node:sqlite");
  const path = join(dir, "statev2.sqlite");
  const db = new sqlite.DatabaseSync(path);
  db.exec("create table orchestration_v2_projection_threads (thread_id text, title text, payload_json text, updated_at text, deleted_at text)");
  const add = (id, title, payload, deleted = null, updated = new Date().toISOString()) => db.prepare("insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?)").run(id, title, JSON.stringify(payload), updated, deleted);
  const subagentOf = root => ({ parentThreadId: root, relationshipToParent: "subagent", rootThreadId: root });
  add("t1", "Fix the share page", { worktreePath: "C:/w/share-page", branch: "main" });
  add("t2", "Agent review", { createdBy: "agent", pullRequests: [{ number: 7, snapshot: { headBranch: "feat/sync" } }] });
  add("t3", "Make sync faster", { createdBy: "user", pullRequests: [{ number: 7, snapshot: { headBranch: "feat/sync" } }], lineage: { parentThreadId: null, rootThreadId: "t3" } });
  add("t4", "Old thread", { branch: "feat/gone" }, new Date().toISOString());
  add("t5", "Tidy styles", { branch: "fix/styles" });
  add("t6", "A later shape", { worktreePath: 5, pullRequests: 3 });
  add("t7", "Check sync tests", { createdBy: "agent", pullRequests: [{ number: 8, snapshot: { headBranch: "fix/sync-tests" } }], lineage: subagentOf("t3") });
  // A thread a person started a month ago, with a subagent working now.
  add("t8", "Plan the launch", { createdBy: "user" }, null, new Date(Date.now() - 30 * 1440 * 60_000).toISOString());
  add("t9", "Draft the launch post", { createdBy: "agent", branch: "docs/launch", lineage: subagentOf("t8") });
  db.close();
  const threadOf = threadDirectory({ path });
  assert.deepEqual(threadOf("anything", "c:/w/share-page"), { id: "t1", title: "Fix the share page", root: { id: "t1", title: "Fix the share page" } }, "by the thread's own worktree, whatever the case");
  assert.deepEqual(threadOf("feat/sync", "C:/w/elsewhere"), { id: "t3", title: "Make sync faster", pr: 7, root: { id: "t3", title: "Make sync faster" } }, "by a linked pull request, preferring the thread a person started");
  assert.deepEqual(threadOf("fix/sync-tests", null), { id: "t7", title: "Check sync tests", pr: 8, root: { id: "t3", title: "Make sync faster" } }, "a subagent's thread names the thread a person started above it");
  assert.deepEqual(threadOf("docs/launch", null).root, { id: "t8", title: "Plan the launch" }, "however long ago that thread last changed");
  assert.deepEqual(threadOf("fix/styles", null), { id: "t5", title: "Tidy styles", root: { id: "t5", title: "Tidy styles" } }, "a row in a shape this reader does not know costs only its own name");
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

test("status, positions, and the dashboard show the line in the order the service starts it, with each request's owner", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-monitor-turns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = queuePaths(root);
  const owner = name => ({ key: `flag:${name}`, title: name, source: "flag" });
  const add = async (n, request, status = { state: "queued", attempts: [] }) => {
    const id = `${String(n).padStart(9, "0")}-abcdef`;
    await writeJson(join(paths.request(id), "request.json"), { head, base, scope: "all", checkout: "C:\\w\\x", branch: `refs/heads/b${n}`, submittedAt: iso(60), sequence: n, ...request, id });
    await writeJson(join(paths.request(id), "status.json"), status);
    return id;
  };
  await add(1, { owner: owner("bob") }, { state: "passed", attempts: [{ n: 1, startedAt: iso(300), endedAt: iso(270), outcome: "passed" }] });
  const running = await add(2, { owner: owner("ann") }, { state: "running", attempts: [{ n: 1, startedAt: iso(10) }] });
  const [a3, a4] = [await add(3, { owner: owner("ann") }), await add(4, { owner: owner("ann") })];
  const [b5, b6] = [await add(5, { owner: owner("bob") }), await add(6, { owner: owner("bob") })];
  const c7 = await add(7, { owner: owner("cat") });
  // Accepted before owners existed: it belongs to its checkout.
  const legacy = await add(8, { checkout: "C:\\w\\legacy" });
  const nightly = await add(9, { nightly: true, checkout: "nightly", branch: "refs/heads/main" });
  // Cat and the legacy checkout never started, Bob started five hours ago, and Ann runs now.
  const line = [running, nightly, c7, legacy, b5, a3, b6, a4];
  const requests = listRequests(root);
  // The service starts one request a minute, every run still going.
  let queue = requests;
  const picked = [];
  for (let at = now, next; picked.length < requests.length && (next = nextRequest(queue, { diskOk: true, dockerOk: true }, at)); at += 60_000) {
    picked.push(next.id);
    queue = queue.map(row => row === next ? { ...row, status: { ...row.status, state: "running", attempts: [{ n: 1, startedAt: new Date(at).toISOString() }] } } : row);
  }
  assert.deepEqual(picked, line.slice(1), "the service starts the line in this order");
  assert.deepEqual(line.map(id => position(requests, id)), line.map((_, index) => index + 1));
  const state = monitorState(root, { now });
  assert.deepEqual(state.queued.map(entry => entry.id), line.slice(1), "the dashboard draws the same line");
  assert.deepEqual(state.queued.map(entry => [entry.owner.title, entry.owner.source, entry.owner.waiting]), [
    ["nightly", "checkout", 1], ["cat", "flag", 1], ["C:\\w\\legacy", "checkout", 1], ["bob", "flag", 2], ["ann", "flag", 2], ["bob", "flag", 2], ["ann", "flag", 2]],
    "each request names its owner and how many requests that owner has waiting");
  const status = spawnSync(process.execPath, [fileURLToPath(new URL("./queue.mjs", import.meta.url)), "status"], { env: { ...process.env, DOHC_VERIFICATION_QUEUE_ROOT: root }, encoding: "utf8", windowsHide: true });
  assert.equal(status.status, 0, status.stderr);
  const rows = status.stdout.split(/\r?\n/u).filter(row => row.includes("  owner: "));
  assert.deepEqual(rows.map(row => row.slice(0, 16)), line, status.stdout);
  assert.match(rows.find(row => row.startsWith(c7)), /  b7  owner: cat$/u, "status shows the owner beside each request");
});

/** A throwaway verification slot root, so no test reads or changes the host's lanes. */
function slotRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-monitor-slots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function monitor(t, root, options = {}) {
  const slots = "slotRoot" in options ? options.slotRoot : slotRoot(t);
  // A Mac refuses the lane switch; these tests choose, so they read the same on every host.
  const server = startMonitor({ root, port: 0, now: () => now, oneLane: false, ...options, slotRoot: slots });
  t.after(() => server.close());
  if (!server.listening) await once(server, "listening");
  const { port } = server.address();
  // A write as the page sends it: a JSON POST that names the page's origin, which each option can change. A GET carries no body, as from a browser.
  const write = (path, body, { host = `127.0.0.1:${port}`, origin = `http://${host}`, type = "application/json", method = "POST", chunked = false, headers = {} } = {}) =>
    get(port, path, { host, method, chunked, body: typeof body === "string" || body === undefined ? body : JSON.stringify(body),
      headers: { ...(origin === null ? {} : { origin }), ...(type === null ? {} : { "content-type": type }), ...headers } });
  const state = async () => JSON.parse((await get(port, "/api/state")).body);
  return { port, write, state, slots };
}

test("the page pauses and resumes the queue with a JSON POST from its own origin, and the pause keeps a one-line reason and names the dashboard", async t => {
  const root = await queueRoot(t);
  const { port, write, state } = await monitor(t, root);
  assert.equal((await state()).pause, null);
  const paused = await write("/api/pause", { reason: "  new\r\ndrivers\u0000 and\u202e\ttools \u0007" }, { type: "application/json; charset=utf-8" });
  assert.equal(paused.status, 200);
  const pause = readPause(root);
  assert.deepEqual(pause, { at: pause.at, reason: "new drivers and tools", by: { name: "dashboard", host: `127.0.0.1:${port}` } }, "newlines and control characters become one space");
  assert.deepEqual(JSON.parse(paused.body), { changed: true, pause });
  assert.equal((await state()).pause.reason, "new drivers and tools", "the next poll shows the pause, not a snapshot from before it");
  assert.deepEqual(JSON.parse((await write("/api/pause", { reason: "again" })).body), { changed: false, pause }, "pausing a paused queue keeps its first record");
  const tailnet = { host: "pc.example.ts.net:8446", origin: "https://pc.example.ts.net:8446" };
  const resumed = await write("/api/resume", {}, tailnet);
  assert.deepEqual([resumed.status, JSON.parse(resumed.body)], [200, { changed: true, pause: null }], "the page on the tailnet name resumes");
  assert.equal(readPause(root), null);
  assert.equal((await state()).pause, null);
  assert.equal(JSON.parse((await write("/api/resume", {}, tailnet)).body).changed, false, "resuming a moving queue changes nothing");
  await write("/api/pause", { reason: " \n\t " });
  assert.equal(readPause(root).reason, null, "a blank reason records none");
  const defaultPort = await write("/api/resume", {}, { host: "pc.example.ts.net:443", origin: "https://pc.example.ts.net" });
  assert.equal(JSON.parse(defaultPort.body).changed, true, "a Host that names the scheme's default port matches an Origin that leaves it out");
});

// Writes the server refuses before reading what they ask for: [name, body, options, status].
const refusals = [
  ["another site's origin", {}, { origin: "http://attacker.example" }, 403],
  ["another origin on this host", {}, { origin: "http://127.0.0.1:3000" }, 403],
  ["no origin", {}, { origin: null }, 403],
  ["an opaque origin", {}, { origin: "null" }, 403],
  ["a form's content type", "reason=x", { type: "application/x-www-form-urlencoded" }, 415],
  ["plain text", "{}", { type: "text/plain" }, 415],
  ["no content type", "{}", { type: null }, 415],
  ["a GET", undefined, { method: "GET" }, 405],
  ["a PUT", {}, { method: "PUT" }, 405],
  ["a body over the limit", { reason: "x".repeat(5000) }, {}, 413],
  ["a body over the limit sent without a length", { reason: "x".repeat(5000) }, { chunked: true }, 413],
  ["a body that is not an object", "[]", {}, 400],
  ["a body that is not JSON", "{", {}, 400],
  ["a reason that is not text", { reason: { text: "x" } }, {}, 400],
  ["a name rebound to this host", {}, { host: "attacker.example", origin: "http://attacker.example" }, 403],
  ["a request through Funnel", {}, { host: "pc.example.ts.net", origin: "https://pc.example.ts.net", headers: { "tailscale-funnel-request": "?1" } }, 403],
];

test("a write is refused with a status, and changes nothing, unless it is a small JSON POST from the page's own origin on an allowed host", async t => {
  const root = await queueRoot(t);
  const { write } = await monitor(t, root);
  for (const [name, body, options, status] of refusals) {
    const answer = await write("/api/pause", body, options);
    assert.equal(answer.status, status, name);
    assert.equal(answer.headers.connection, options.method === "GET" ? "keep-alive" : "close", `${name} closes its connection unless it is a GET`);
    assert.equal(readPause(root), null, `${name} must not pause the queue`);
  }
  assert.equal((await write("/api/pause", undefined, { method: "GET" })).headers.allow, "POST");
  const { pause } = await pauseQueue(root, { reason: "drivers" });
  for (const [name, body, options, status] of refusals) {
    assert.equal((await write("/api/resume", body, options)).status, status, name);
    assert.deepEqual(readPause(root), pause, `${name} must not resume the queue`);
  }
  // A cross-site JSON POST first asks with a preflight, which grants nothing.
  const preflight = await write("/api/pause", undefined, { method: "OPTIONS", origin: "http://attacker.example", type: null });
  assert.equal(preflight.status, 405);
  assert.deepEqual(Object.keys(preflight.headers).filter(name => name.startsWith("access-control-")), [], "no answer grants another origin");
});

// The queue fixture's history has a torn line, which every reader skips.
const laneEvents = root => readFileSync(queuePaths(root).history, "utf8").trim().split("\n").flatMap(line => {
  try { const event = JSON.parse(line); return event.event === "lanes" ? [event] : []; } catch { return []; }
});
const holdSlot = (slots, n, owner) => {
  mkdirSync(join(slots, `verification-slot-${n}`));
  writeFileSync(join(slots, `verification-slot-${n}`, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString(), ...owner }));
};

test("the page switches the host between 2 and 3 lanes with a JSON POST from its own origin, records who did, and the next poll shows it", async t => {
  const root = await queueRoot(t);
  const logged = [];
  const { port, write, state, slots } = await monitor(t, root, { log: line => logged.push(line) });
  const setting = () => readFileSync(join(slots, "verification-lanes"), "utf8");
  // A count set on the host outside the switch shows as it is.
  writeFileSync(join(slots, "verification-lanes"), "4\n");
  assert.deepEqual((await state()).laneSetting, { lanes: 4, error: null, closing: [], note: null });
  const three = await write("/api/lanes", { lanes: 3 }, { type: "application/json; charset=utf-8" });
  assert.deepEqual([three.status, JSON.parse(three.body)], [200, { changed: true, lanes: 3 }]);
  assert.equal(setting(), "3\n");
  assert.deepEqual(readdirSync(slots), ["verification-lanes"], "the write leaves no temporary file");
  assert.equal(verificationLanes({ DOHC_BUILD_SLOT_ROOT: slots }), 3, "every verifier and the service read the new count");
  assert.equal((await state()).laneSetting.lanes, 3, "the next poll shows the new setting, not a snapshot from before it");
  const by = { name: "dashboard", host: `127.0.0.1:${port}` };
  assert.deepEqual(laneEvents(root).map(({ at: _at, ...event }) => event), [{ event: "lanes", lanes: 3, previous: 4, by }], "the history records who set it");
  assert.deepEqual(logged, [`the dashboard at 127.0.0.1:${port} set the verification lanes to 3, from 4`]);
  assert.deepEqual(JSON.parse((await write("/api/lanes", { lanes: 3 })).body), { changed: false, lanes: 3 }, "choosing the current count changes nothing");
  assert.equal(laneEvents(root).length, 1);
  const tailnet = { host: "pc.example.ts.net:443", origin: "https://pc.example.ts.net" };
  assert.deepEqual(JSON.parse((await write("/api/lanes", { lanes: 2 }, tailnet)).body), { changed: true, lanes: 2 }, "the page on the tailnet name switches back");
  assert.equal(setting(), "2\n");
  // A setting the host cannot read is shown with why, and a switch replaces it.
  writeFileSync(join(slots, "verification-lanes"), "two");
  assert.deepEqual(laneSetting(slots), { lanes: null, error: `${join(slots, "verification-lanes")} must contain a lane count from 1 to 4.`, closing: [] });
  assert.equal((await write("/api/lanes", { lanes: 3 })).status, 200);
  assert.equal(setting(), "3\n");
  assert.match(logged.at(-1), /set the verification lanes to 3, from a setting that could not be read$/u);
});

test("a Mac refuses the lane switch and keeps one lane, because Electron runs cannot share its display", async t => {
  const root = await queueRoot(t);
  const { write, state, slots } = await monitor(t, root, { oneLane: true });
  const answer = await write("/api/lanes", { lanes: 2 });
  assert.deepEqual([answer.status, answer.body], [409, "This Mac runs one lane: Electron runs cannot share its display."]);
  assert.deepEqual(readdirSync(slots), [], "the refusal writes no lane setting");
  assert.equal((await state()).laneSetting.lanes, 1);
  // Pause and resume still work there.
  assert.equal((await write("/api/pause", { reason: "a Mac pause" })).status, 200);
});

test("a lane switch is refused with a status, and changes nothing, unless it is a small JSON POST from the page's own origin that names 2 or 3 lanes", async t => {
  const root = await queueRoot(t);
  const { write, slots } = await monitor(t, root);
  writeFileSync(join(slots, "verification-lanes"), "2\n");
  // Each refused write asks for 3 lanes, so only its refusal keeps the setting at 2.
  const asking = body => body && typeof body === "object" ? { lanes: 3, ...body } : body;
  const counts = [["one lane", { lanes: 1 }], ["four lanes", { lanes: 4 }], ["a count as text", { lanes: "3" }], ["a fraction", { lanes: 2.5 }], ["no count", {}]]
    .map(([name, body]) => [name, body, {}, 400]);
  for (const [name, body, options, status] of [...refusals.map(([name, body, options, status]) => [name, asking(body), options, status]), ...counts]) {
    const answer = await write("/api/lanes", body, options);
    assert.equal(answer.status, status, name);
    assert.equal(answer.headers.connection, options.method === "GET" ? "keep-alive" : "close", `${name} closes its connection unless it is a GET`);
    assert.equal(readFileSync(join(slots, "verification-lanes"), "utf8"), "2\n", `${name} must not change the lanes`);
  }
  assert.equal((await write("/api/lanes", undefined, { method: "GET" })).headers.allow, "POST");
  assert.deepEqual(laneEvents(root), []);
  // A host without a slot root has no lane setting to show or change.
  const bare = await monitor(t, root, { slotRoot: null });
  assert.equal((await bare.state()).laneSetting, null);
  assert.equal((await bare.write("/api/lanes", { lanes: 3 })).status, 409);
});

test("switching to 2 while lane 3 runs a gate stops nothing, and the dashboard and status say lane 3 closes after its current gate", async t => {
  const root = await queueRoot(t);
  const { write, state, slots } = await monitor(t, root);
  writeFileSync(join(slots, "verification-lanes"), "3\n");
  holdSlot(slots, 3, { purpose: queueLanePurpose, phase: "request 000000003-cccccc" });
  assert.equal((await write("/api/lanes", { lanes: 2 })).status, 200);
  assert.ok(existsSync(join(slots, "verification-slot-3")), "lane 3 keeps its gate");
  const { laneSetting: closing, lanes } = await state();
  assert.deepEqual(closing, { lanes: 2, error: null, closing: [3], note: "lane 3 closes after its current gate" });
  assert.deepEqual([lanes.slots, lanes.holders.map(holder => [holder.slot, holder.requestId])], [3, [[3, "000000003-cccccc"]]], "the page still draws lane 3 and its gate");
  const { DOHC_VERIFICATION_SLOT_ROOT: _trial, ...env } = process.env;
  const status = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./queue.mjs", import.meta.url)), "status"], { env: { ...env, DOHC_VERIFICATION_QUEUE_ROOT: root, DOHC_BUILD_SLOT_ROOT: slots }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(status(), /^lanes: 2, lane 3 closes after its current gate$/mu);
  // Once lane 3's gate ends, no lane is closing.
  rmSync(join(slots, "verification-slot-3"), { recursive: true });
  assert.deepEqual(monitorState(root, { now, lanes: () => laneSetting(slots) }).laneSetting, { lanes: 2, error: null, closing: [], note: null });
  assert.match(status(), /^lanes: 2$/mu);
});

test("a write whose body is too large or too slow is refused, and its connection closes", async t => {
  const root = await queueRoot(t);
  const { port, write } = await monitor(t, root, { writeWaitMs: 200 });
  const large = await write("/api/pause", { reason: "x".repeat(5000) }, { chunked: true });
  assert.deepEqual([large.status, large.headers.connection], [413, "close"], "the client cannot keep streaming a body the server refused");
  // A body that never arrives gets its answer when the wait runs out, then the server closes the connection.
  const socket = connect(port, "127.0.0.1");
  let answer = "";
  socket.setEncoding("utf8").on("data", chunk => { answer += chunk; });
  socket.write([`POST /api/pause HTTP/1.1`, `host: 127.0.0.1:${port}`, `origin: http://127.0.0.1:${port}`, "content-type: application/json", "content-length: 100", "", "{"].join("\r\n"));
  await once(socket, "close");
  assert.match(answer, /^HTTP\/1\.1 408 [^]*did not arrive in time/u, "the monitor answers, not Node's own request timeout");
  assert.equal(readPause(root), null);
});

test("the snapshot says when the queue is paused: the runs it waits for, when it is idle, and a hold after the computer restarted", async t => {
  const root = await queueRoot(t);
  const paths = queuePaths(root);
  const service = readJson(paths.service);
  const beat = (paused, running = []) => writeJson(paths.service, { ...service, paused, running });
  assert.equal(monitorState(root, { now }).pause, null);
  const { pause } = await pauseQueue(root, { reason: "drivers" });
  assert.deepEqual(monitorState(root, { now }).pause, { ...pause, running: 1, idle: false, restart: false }, "the service's run in flight still runs");
  await beat(null);
  assert.deepEqual(monitorState(root, { now }).pause, { ...pause, running: 0, idle: false, restart: false }, "a service that has not seen the pause may still start a run");
  await beat(pause);
  assert.deepEqual(monitorState(root, { now }).pause, { ...pause, running: 0, idle: true, restart: false }, "paused and idle: safe to restart");
  const inline = { slots: 2, owners: [{ name: "verification-slot-2", start: iso(5), elapsedMs: 300_000, checkout: join(root, "inline"), commit: "d".repeat(40), phase: "tests" }], waiters: [] };
  assert.deepEqual(monitorState(root, { now, slots: () => inline }).pause, { ...pause, running: 1, idle: false, restart: false }, "an inline gate holding a lane is running");
  await resumeQueue(root);
  const { pause: held } = await pauseQueue(root, { reason: "the computer restarted" });
  await beat(held);
  assert.deepEqual(monitorState(root, { now }).pause, { ...held, running: 0, idle: true, restart: true });
});

test("the snapshot lists each test that failed on two or more branches in the last day, with whether main's nightly failed it too", async t => {
  const root = await queueRoot(t);
  const failed = (minutesAgo, id, tests, outcome = "failed") => appendFileSync(queuePaths(root).history, `${JSON.stringify({ at: iso(minutesAgo), event: "finished", id, outcome, failed: tests })}\n`);
  const grid = { step: "desktop", test: "grid sorts" }, sync = { step: "rust", test: "sync::merges" }, mine = { step: "tests", test: "only mine" }, old = { step: "tests", test: "long ago" };
  failed(2 * 1440, "000000002-bbbbbb", [old]);
  failed(2 * 1440, "000000004-dddddd", [old]);
  failed(300, "000000002-bbbbbb", [grid, sync, mine]);
  failed(200, "000000002-bbbbbb", [mine]);
  failed(120, "000000004-dddddd", [grid]);
  failed(100, "000000009-ffffff", [mine]);
  failed(60, "000000003-cccccc", [grid]);
  assert.deepEqual(monitorState(root, { now }).sharedFailures, [{ ...grid, branches: ["again", "done", "now"], last: iso(60), nightly: null }],
    "a test failed twice on one branch, more than a day ago, or by a request that is gone does not count, and no nightly finished today");
  failed(30, "000000005-eeeeee", [sync]);
  assert.deepEqual(monitorState(root, { now }).sharedFailures, [
    { ...grid, branches: ["again", "done", "now"], last: iso(60), nightly: false },
    { ...sync, branches: ["done"], last: iso(30), nightly: true }], "main's nightly counts as a branch, and says which tests it failed too");
});
