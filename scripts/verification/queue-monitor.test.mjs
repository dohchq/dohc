// The queue monitor: the snapshot its page draws, a run's details, and who the server answers.

import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorState, runDetails, startMonitor } from "./queue-monitor.mjs";
import { queuePaths, writeJson } from "./queue.mjs";

const now = Date.parse("2026-10-15T12:00:00Z");
const iso = minutesAgo => new Date(now - minutesAgo * 60_000).toISOString();
const head = "a".repeat(40), base = "b".repeat(40);

async function queueRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-monitor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = queuePaths(root);
  const add = async (id, request, status) => {
    await writeJson(join(paths.request(id), "request.json"), { head, base, scope: "all", checkout: "C:\\w\\x", submittedAt: iso(300), ...request, id });
    await writeJson(join(paths.request(id), "status.json"), status);
  };
  await add("000000001-aaaaaa", { branch: "refs/heads/old" }, { state: "passed", updatedAt: iso(9 * 1440), attempts: [{ n: 1, startedAt: iso(9 * 1440 + 30), endedAt: iso(9 * 1440), outcome: "passed" }] });
  await add("000000002-bbbbbb", { branch: "refs/heads/done" }, { state: "passed", attempts: [
    { n: 1, startedAt: iso(200), endedAt: iso(190), outcome: "environment", cause: "service restart", lane: 1, awakeMs: 600_000 },
    { n: 2, startedAt: iso(180), endedAt: iso(150), outcome: "passed", cause: "pass", lane: 1, awakeMs: 1_800_000, flaky: [{ step: "rust", test: "engine::settles" }] }] });
  await add("000000003-cccccc", { branch: "refs/heads/now" }, { state: "running", attempts: [{ n: 1, startedAt: iso(10), lane: 2 }] });
  await writeJson(join(paths.attempt("000000003-cccccc", 1), "result.json"), { verdict: "RUNNING", steps: [{ name: "install", verdict: "PASS" }, { name: "tests", verdict: "RUNNING" }, { name: "rust", verdict: "RUNNING" }] });
  await add("000000004-dddddd", { branch: "refs/heads/again" }, { state: "queued", waiting: "Docker did not answer. Retrying.", attempts: [{ n: 1, startedAt: iso(60), endedAt: iso(55), outcome: "environment" }] });
  await add("000000005-eeeeee", { branch: "refs/heads/main", checkout: "nightly", nightly: true }, { state: "queued", attempts: [] });
  await writeJson(paths.service, { protocol: 1, pid: 1, commit: "c".repeat(40), startedAt: iso(500), heartbeatAt: iso(0.1), lanes: 2,
    running: [{ id: "000000003-cccccc", attempt: 1, checkout: "C:\\w\\_verification\\lane-2", phase: "verifying", startedAt: iso(10), awakeMs: 540_000 }], health: { cpuBusyPercent: 40, freeMemGb: 20 } });
  const event = (minutesAgo, fields) => appendFileSync(paths.history, `${JSON.stringify({ at: iso(minutesAgo), event: "finished", ...fields })}\n`);
  event(9 * 1440, { flaky: [{ step: "rust", test: "engine::settles" }], slowest: [{ step: "desktop", test: "states page", seconds: 900 }] });
  event(150, { flaky: [{ step: "rust", test: "engine::settles" }], slowest: [{ step: "desktop", test: "states page", seconds: 280 }, { step: "rust", test: "capture", seconds: 80 }] });
  event(100, { flaky: [{ step: "rust", test: "engine::settles" }, { step: "repository", test: "heartbeat" }], slowest: [{ step: "desktop", test: "states page", seconds: 260 }] });
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
  assert.deepEqual([running.steps, running.done, running.awakeMs, running.phase], [["tests", "rust"], 1, 540_000, "verifying"], "a running attempt shows its steps from its receipt so far");
  assert.equal(state.runs.find(run => run.outcome === "passed").flaky, 1);
  assert.equal(state.typicalMs, 1_800_000);
  assert.deepEqual(state.queued.map(entry => [entry.branch, entry.retry, entry.nightly]), [["main (nightly)", false, true], ["again", true, false]], "the nightly run goes first");
  assert.equal(state.queued[1].waiting, "Docker did not answer. Retrying.");
  assert.deepEqual(state.flaky.map(item => [item.test, item.flaky]), [["engine::settles", 2], ["heartbeat", 1]], "only this week's flaky tests count");
  assert.deepEqual(state.slowest.map(item => [item.test, item.runs, item.totalSeconds]), [["states page", 2, 540], ["capture", 1, 80]]);
  assert.deepEqual(state.nightly, { id: "000000005-eeeeee", head: head.slice(0, 12), state: "queued", at: null });
  assert.equal(state.lastNightlyPass, null);
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
  assert.equal(details.steps[0].log, "✖ failing tests:\n\ntest at scripts\\a.test.mjs:1:1\n✖ the heartbeat keeps\n", "the excerpt starts at the runner's summary, without colors");
  assert.equal(details.steps[1].log, null, "a log outside the attempt's folder is never read");
  assert.equal(details.steps[2].log, null, "a passing step's log is not sent");
  assert.equal(runDetails(root, "../../000000002-bbbbbb", "2"), null);
  assert.equal(runDetails(root, "000000002-bbbbbb", "2/../../1"), null);
  assert.equal(runDetails(root, "000000009-ffffff", "1"), null, "a request that is gone has no details");
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
});
