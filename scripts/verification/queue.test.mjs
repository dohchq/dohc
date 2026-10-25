// The verification queue: its line rules, and the service run against a stub
// verifier that passes, fails, fails for machine reasons, hangs, and crashes.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { freemem, tmpdir, uptime, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { attemptOutcome, cancel, inlineRuns, lastNightlyPass, launchAgentDefinition, launchAgentLabel, launchPath, listRequests, movedNote, nextRequest, nightlyAgentDefinition, nightlyAgentLabel, nightlyTaskDefinition, ownerFor, parseMove, pauseQueue, pauseStatus, placeMove, placeSubmission, position, queueLanePurpose, queuePaths, queueRoot, readJson, readPause, registerLaunchAgents, reloadLaunchAgent, requestMove, resumeQueue, runOrder, serviceRuns, serviceState, sharedFailures, startCommand, startsInMs, submit, submitNightly, taskDefinition, terminalStates, unregisterLaunchAgents, verifyThroughQueue, writeJson } from "./queue.mjs";
import { cleanCheckout, freeMemoryGb, holdAwake, laneTemp, runService, stopStrays, sweepContainers } from "./queue-service.mjs";
import { buildEnvHelper, envHelper, heldPath, holdSocket, instanceVariable, markedPids, members, processTable, requestMarker, requestVariable, stopProcesses, stopRecorded, supervise, treePath } from "./queue-supervisor.mjs";
import { threadDirectory } from "./queue-monitor.mjs";
import { failureKind, takeGrant } from "./verify.mjs";
import { run } from "./process.mjs";

const entry = (id, request, state = "queued", extra = {}) => ({ id, request: { sequence: Number(id.slice(0, 9)), scope: "all", gates: { rust: true, js: true }, checkout: "C:\\w\\a", branch: "refs/heads/a", ...request }, status: { state, attempts: [], ...extra } });

test("a submission joins the same live work, reuses a pass, and replaces a queued commit on its branch", () => {
  const running = entry("000000001-aaaaaa", { head: "h1" }, "running");
  const queued = entry("000000002-bbbbbb", { head: "h2", branch: "refs/heads/b" });
  const passed = entry("000000003-cccccc", { head: "h3", branch: "refs/heads/c" }, "passed");
  const failed = entry("000000004-dddddd", { head: "h4", branch: "refs/heads/d" }, "failed");
  const requests = [running, queued, passed, failed];
  const submission = fields => ({ scope: "all", gates: { rust: true, js: true }, checkout: "C:\\w\\x", branch: "refs/heads/a", ...fields });
  assert.deepEqual(placeSubmission(requests, submission({ head: "h1" })), { attach: running.id });
  assert.deepEqual(placeSubmission(requests, submission({ head: "h3", branch: "refs/heads/other" })), { attach: passed.id }, "a pass of the same commit and gates covers any branch");
  assert.deepEqual(placeSubmission(requests, submission({ head: "h3", gates: { rust: true, js: false } })), { supersede: [], sequence: null }, "different gates are different work");
  assert.deepEqual(placeSubmission(requests, submission({ head: "h4", branch: "refs/heads/d" })), { supersede: [], sequence: null }, "a failed commit may run again");
  assert.deepEqual(placeSubmission(requests, submission({ head: "h5", branch: "refs/heads/b" })), { supersede: [queued.id], sequence: 2 }, "a newer commit keeps the queued one's place");
  assert.deepEqual(placeSubmission(requests, submission({ head: "h6" })), { supersede: [], sequence: null }, "a running request is left to finish");
});

test("the oldest runnable request goes next; Docker trouble holds back only JavaScript runs", () => {
  const js = entry("000000001-aaaaaa", { head: "h1" });
  const rust = entry("000000002-bbbbbb", { head: "h2", scope: "rust", gates: { rust: true, js: false } });
  const later = entry("000000003-cccccc", { head: "h3" }, "queued", { notBefore: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(nextRequest([js, rust, later], { diskOk: true, dockerOk: true }).id, js.id);
  assert.equal(nextRequest([js, rust, later], { diskOk: true, dockerOk: false }).id, rust.id);
  assert.equal(nextRequest([js, rust, later], { diskOk: false, dockerOk: true }), null);
  assert.equal(nextRequest([later], { diskOk: true, dockerOk: true }), null, "a backoff keeps its place but not the lane");
  assert.equal(position([later, rust, entry("000000000-zzzzzz", { head: "h0" }, "running")], rust.id), 2);
});

test("a wait estimate shares the runs ahead across the lanes, and status reads either heartbeat", () => {
  assert.deepEqual([1, 2, 3, 4].map(place => startsInMs(place, 10, 1)), [0, 10, 20, 30]);
  assert.deepEqual([1, 2, 3, 4, 5].map(place => startsInMs(place, 10, 2)), [0, 0, 10, 10, 20]);
  assert.deepEqual(serviceRuns({ lanes: 2, running: [{ id: "a" }, { id: "b" }] }), { lanes: 2, runs: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(serviceRuns({ running: { id: "a" } }), { lanes: 1, runs: [{ id: "a" }] }, "a service older than two lanes");
  assert.deepEqual(serviceRuns(null), { lanes: 1, runs: [] });
});

test("only a receipt for this exact attempt counts", () => {
  const grant = { request: "r", attempt: 2, head: "h", base: "b" };
  const receipt = fields => ({ grant, commit: "h", baseCommit: "b", final: true, ...fields });
  assert.equal(attemptOutcome(receipt({ verdict: "PASS" }), grant).outcome, "passed");
  assert.equal(attemptOutcome(receipt({ verdict: "FAIL", failure: { kind: "check" }, error: "tests" }), grant).outcome, "failed");
  assert.equal(attemptOutcome(receipt({ verdict: "FAIL", failure: { kind: "environment", cause: "doctor" } }), grant).cause, "doctor");
  assert.equal(attemptOutcome(receipt({ verdict: "RUNNING" }), grant).outcome, "environment");
  assert.equal(attemptOutcome(receipt({ verdict: "PASS", final: false }), grant).outcome, "environment", "a pass saved before teardown finished is not trusted");
  assert.equal(attemptOutcome({ ...receipt({ verdict: "PASS" }), grant: { ...grant, attempt: 1 } }, grant).outcome, "environment", "an earlier attempt's pass is not this attempt's");
  assert.equal(attemptOutcome(null, grant).outcome, "environment");
  assert.equal(attemptOutcome(receipt({ verdict: "PASS" }), grant, { stopped: "time limit" }).outcome, "failed");
  assert.equal(attemptOutcome(null, grant, { stopped: "cancelled" }).outcome, "cancelled");
  assert.equal(attemptOutcome(null, grant, { stopped: "time budget" }).outcome, "error", "a run cut short by the shared budget gets no verdict");
});

test("the nightly run of main goes ahead of the line, and only a ready one does", () => {
  const first = entry("000000001-aaaaaa", { head: "h1" });
  const nightly = entry("000000009-nnnnnn", { head: "h9", branch: "refs/heads/main", checkout: "nightly", full: true, nightly: true });
  const waiting = entry("000000008-mmmmmm", { head: "h8", nightly: true }, "queued", { notBefore: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(nextRequest([first, nightly], { diskOk: true, dockerOk: true }).id, nightly.id);
  assert.equal(nextRequest([first, waiting], { diskOk: true, dockerOk: true }).id, first.id, "a nightly in backoff holds back nobody");
  assert.equal(position([first, nightly, entry("000000000-zzzzzz", { head: "h0" }, "running")], nightly.id), 2);
  assert.equal(position([first, nightly], first.id), 2);
});

test("a move puts a queued request first or before another, the line follows it, and the nightly still goes first", () => {
  const running = entry("000000001-aaaaaa", { head: "h1" }, "running");
  const a = entry("000000002-bbbbbb", { head: "h2" });
  const b = entry("000000003-cccccc", { head: "h3" });
  const c = entry("000000004-dddddd", { head: "h4" });
  const nightly = entry("000000005-eeeeee", { head: "h5", nightly: true });
  const passed = entry("000000006-ffffff", { head: "h6" }, "passed");
  const superseded = entry("000000007-gggggg", { head: "h7" }, "superseded", { supersededBy: c.id });
  const health = { diskOk: true, dockerOk: true };
  const apply = (requests, move) => {
    const { orders, rejected } = placeMove(requests, move);
    assert.equal(rejected, undefined);
    return requests.map(row => orders.has(row.id) ? { ...row, status: { ...row.status, order: orders.get(row.id) } } : row);
  };
  let requests = apply([running, a, b, c, passed, superseded], { id: c.id });
  assert.equal(nextRequest(requests, health).id, c.id, "--first starts it next");
  assert.deepEqual([c, a, b].map(row => position(requests, row.id)), [2, 3, 4]);
  assert.deepEqual(requests.map(row => row.request.sequence), [1, 2, 3, 4, 6, 7], "a move changes no sequence");
  assert.deepEqual(requests.map(row => row.status.order ?? null), [null, 3, 4, 2, null, null], "the queued requests share out their own values again");
  requests = apply(requests, { id: b.id, before: a.id });
  assert.deepEqual([c, b, a].map(row => position(requests, row.id)), [2, 3, 4], "--before puts it just ahead of the other");
  // The running request keeps its sequence, so a retry after a machine failure comes back ahead of the line it left.
  const retried = requests.map(row => row.id === running.id ? { ...row, status: { ...row.status, state: "queued" } } : row);
  assert.equal(nextRequest(retried, health).id, running.id);
  requests = [...requests, nightly];
  assert.equal(nextRequest(requests, health).id, nightly.id, "the nightly still goes first");
  assert.deepEqual([nightly, c, b, a].map(row => position(requests, row.id)), [2, 3, 4, 5]);
  const refused = move => placeMove(requests, move).rejected;
  assert.match(refused({ id: running.id }), /it is running\. Only a queued request can move\.$/u);
  assert.match(refused({ id: passed.id }), /it has already finished: passed/u);
  assert.match(refused({ id: superseded.id }), /replaced by 000000004-dddddd/u);
  assert.match(refused({ id: "000000009-zzzzzz" }), /^No verification request 000000009-zzzzzz\.$/u);
  assert.match(refused({ id: a.id, before: running.id }), /before 000000001-aaaaaa: it is running/u, "nothing goes ahead of a running request");
  assert.match(refused({ id: a.id, before: a.id }), /before itself/u);
  assert.equal(refused({ id: c.id, before: a.id }), `Cannot move ${c.id} before ${a.id}: ${c.id} is already ahead of ${a.id}. A move only brings a request forward.`);
  assert.equal(refused({ id: a.id, before: nightly.id }), `Cannot move ${a.id} before ${nightly.id}: the nightly run always goes first. Use --first to put ${a.id} at the front of the rest of the line.`);
  assert.match(placeMove(requests, { id: a.id }, new Set([a.id])).rejected, /it is running/u, "a request the service has started cannot move before its status says so");
});

// A request that belongs to the owner named by --owner.
const owned = (id, name, state = "queued", extra = {}) => entry(id, { owner: { key: `flag:${name}`, title: name, source: "flag" } }, state, extra);
const now = Date.parse("2026-10-16T09:00:00Z");
const started = (minutes, outcome) => ({ n: 1, startedAt: new Date(now - 60 * 60_000 + minutes * 60_000).toISOString(), ...(outcome ? { outcome } : {}) });

test("the nightly run goes first, then a request moved --first, then the owner longest without a start, one request per turn", () => {
  const running = owned("000000001-aaaaaa", "ann", "running", { attempts: [started(0)] });
  const [a2, a3] = ["000000002-aaaaaa", "000000003-aaaaaa"].map(id => owned(id, "ann"));
  const bobRan = owned("000000004-bbbbbb", "bob", "passed", { attempts: [started(-120, "passed")] });
  const [b5, b6] = ["000000005-bbbbbb", "000000006-bbbbbb"].map(id => owned(id, "bob"));
  // Cat's only attempt failed because of the machine, which uses no turn, so Cat has never started.
  const c7 = owned("000000007-cccccc", "cat", "queued", { attempts: [started(-60, "environment")] });
  const danRan = owned("000000008-dddddd", "dan", "failed", { attempts: [started(-30, "failed")] });
  const d9 = owned("000000009-dddddd", "dan");
  const nightly = entry("000000010-nnnnnn", { nightly: true, checkout: "nightly" });
  const first = owned("000000011-bbbbbb", "bob", "queued", { order: 1, moved: { at: started(-1).startedAt, before: null, reason: "fixes main", by: { name: "Ice" } } });
  const requests = [running, a2, a3, bobRan, b5, b6, c7, danRan, d9, nightly, first];
  const line = [running, nightly, first, c7, d9, a2, b5, a3, b6];
  assert.deepEqual(runOrder(requests).map(row => row.id), line.map(row => row.id),
    "Cat never started, and Dan has no run in progress. Ann runs now and Bob's request moved first starts before the turns, so they follow, Ann first because she started longer ago");
  assert.deepEqual(line.map(row => position(requests, row.id)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(startInTurn(requests, { diskOk: true, dockerOk: true }, { ending: false }), line.slice(1).map(row => row.id), "the service starts the line in this order");
});

test("--before orders one owner's requests, and a move before another owner's request is refused", () => {
  const [a1, a2, a3] = ["000000001-aaaaaa", "000000002-aaaaaa", "000000003-aaaaaa"].map(id => owned(id, "ann"));
  const b4 = owned("000000004-bbbbbb", "bob");
  let requests = [a1, a2, a3, b4];
  const { orders } = placeMove(requests, { id: a3.id, before: a1.id });
  requests = requests.map(row => orders.has(row.id) ? { ...row, status: { ...row.status, order: orders.get(row.id) } } : row);
  assert.deepEqual(runOrder(requests).map(row => row.id), [a3.id, b4.id, a1.id, a2.id], "Ann's moved request takes Ann's turn, and Bob's turn comes next");
  assert.equal(placeMove(requests, { id: b4.id, before: a1.id }).rejected,
    `Cannot move ${b4.id} before ${a1.id}: ${a1.id} belongs to ann, and owners take turns. --before orders one owner's requests. Use --first only to unblock others.`);
});

const rustOnly = row => ({ ...row, request: { ...row.request, scope: "rust", gates: { rust: true, js: false } } });
/**
 * The ids the service starts, one a minute: by one lane, each run ending before the next starts, or,
 * with `ending` false, by as many lanes as it takes, every run still going.
 */
function startInTurn(requests, health, { ending = true } = {}) {
  const order = [];
  for (let at = now, next; order.length < requests.length && (next = nextRequest(requests, health, at)); at += 60_000) {
    order.push(next.id);
    const attempt = { n: next.status.attempts.length + 1, startedAt: new Date(at).toISOString(), ...(ending ? { outcome: "passed" } : {}) };
    requests = requests.map(row => row === next ? { ...row, status: { ...row.status, state: ending ? "passed" : "running", attempts: [...row.status.attempts, attempt] } } : row);
  }
  return order;
}

test("a request waiting on Docker holds no turn, so its owner's Rust-only request takes it", () => {
  const b1 = owned("000000001-bbbbbb", "bob");
  const [b2, a3, c4, a5, c6] = [["000000002-bbbbbb", "bob"], ["000000003-aaaaaa", "ann"], ["000000004-cccccc", "cat"], ["000000005-aaaaaa", "ann"], ["000000006-cccccc", "cat"]].map(([id, name]) => rustOnly(owned(id, name)));
  assert.deepEqual(startInTurn([b1, b2, a3, c4, a5, c6], { diskOk: true, dockerOk: false }), [b2, a3, c4, a5, c6].map(row => row.id),
    "Bob's JavaScript run waits for Docker, and Bob's Rust-only run takes Bob's turn instead of waiting behind every other start");
});

test("a request in its retry backoff holds no turn, so two free lanes go to two owners", () => {
  const [a1, a2] = ["000000001-aaaaaa", "000000003-aaaaaa"].map(id => owned(id, "ann"));
  const b1 = owned("000000002-bbbbbb", "bob", "queued", { notBefore: new Date(now + 60_000).toISOString(), attempts: [started(-5, "environment")] });
  const b2 = owned("000000004-bbbbbb", "bob");
  const requests = [a1, b1, a2, b2];
  const health = { diskOk: true, dockerOk: true };
  assert.equal(nextRequest(requests, health, now).id, a1.id);
  assert.equal(nextRequest(requests, health, now, new Set([a1.id])).id, b2.id, "the second lane goes to Bob's request that can run, not to Ann's second");
});

test("a request whose containers are still being removed holds no turn", () => {
  const annRan = owned("000000001-aaaaaa", "ann", "passed", { attempts: [started(-30, "passed")] });
  const b2 = owned("000000002-bbbbbb", "bob", "queued", { attempts: [started(-10, "environment")] });
  const a3 = owned("000000003-aaaaaa", "ann");
  const b4 = owned("000000004-bbbbbb", "bob");
  assert.equal(nextRequest([annRan, b2, a3, b4], { diskOk: true, dockerOk: true }, now, new Set(), new Set([b2.id])).id, b4.id,
    "Bob has not had a turn, so his other request runs while the first one's cleanup waits");
});

test("a request that cannot start still counts its owner's last start", () => {
  // Ann's first request waits on Docker, though she started it at 12:00. Bob last started at 11:00.
  const at = time => new Date(`2026-10-16T${time}:00Z`).toISOString();
  const a1 = owned("000000001-aaaaaa", "ann", "queued", { attempts: [{ n: 1, startedAt: at("12:00"), outcome: "passed" }] });
  const bobRan = owned("000000002-bbbbbb", "bob", "passed", { attempts: [{ n: 1, startedAt: at("11:00"), outcome: "passed" }] });
  const a2 = rustOnly(owned("000000003-aaaaaa", "ann"));
  const b1 = rustOnly(owned("000000004-bbbbbb", "bob"));
  assert.equal(nextRequest([a1, bobRan, a2, b1], { diskOk: true, dockerOk: false }, Date.parse(at("13:00"))).id, b1.id, "Bob has gone longer without a start than Ann");
});

test("an owner with a run in progress waits until every owner without one has had a turn", () => {
  const annRunning = owned("000000001-aaaaaa", "ann", "running", { attempts: [started(-30)] });
  const bobRan = owned("000000002-bbbbbb", "bob", "passed", { attempts: [started(-20, "passed")] });
  const a3 = owned("000000003-aaaaaa", "ann");
  const b4 = owned("000000004-bbbbbb", "bob");
  assert.equal(nextRequest([annRunning, bobRan, a3, b4], { diskOk: true, dockerOk: true }, now).id, b4.id,
    "Ann started longer ago, but her run is still going, so Bob, whose run finished, takes the free lane");
});

test("requests accepted before owners existed record no starts, so they keep the line order they had", () => {
  // Without a recorded owner, each belongs to its checkout. One checkout already ran a request.
  const legacy = (id, checkout, state = "queued", extra = {}) => entry(id, { checkout, branch: null }, state, extra);
  const ran = legacy("000000001-aaaaaa", "C:\\w\\one", "passed", { attempts: [started(-10, "passed")] });
  const l2 = legacy("000000002-aaaaaa", "C:\\w\\one");
  const l3 = legacy("000000003-aaaaaa", "C:\\w\\two");
  const l4 = legacy("000000004-aaaaaa", "C:\\w\\three");
  const annRan = owned("000000005-aaaaaa", "ann", "passed", { attempts: [started(-60, "passed")] });
  const n6 = owned("000000006-aaaaaa", "ann");
  const m7 = owned("000000007-bbbbbb", "bob");
  assert.deepEqual(runOrder([ran, l2, l3, l4, annRan, n6, m7]).map(row => row.id), [l2, l3, l4, m7, n6].map(row => row.id));
});

test("a move before a request moved first is refused", () => {
  const moved = { at: started(-1).startedAt, before: null, reason: "fixes main", by: { name: "Ice" } };
  const first = owned("000000002-aaaaaa", "ann", "queued", { order: 1, moved });
  const a3 = owned("000000003-aaaaaa", "ann");
  assert.equal(placeMove([first, a3], { id: a3.id, before: first.id }).rejected,
    `Cannot move ${a3.id} before ${first.id}: ${first.id} was moved first, ahead of every owner's turn. Use --first for ${a3.id} if it also unblocks others.`);
});

test("a new request's owner is its person's T3 thread, else its --owner name, else its checkout, and a failed lookup names no thread", () => {
  const threads = { "feat/sync": { id: "t-sub", title: "Review sync", root: { id: "t-person", title: "Ship\nsync" } } };
  const threadOf = branch => threads[branch] ?? null;
  const person = { key: "thread:t-person", title: "Ship sync", source: "thread" };
  assert.deepEqual(ownerFor({ branch: "refs/heads/feat/sync", checkout: "C:\\w\\Sync", ownerName: "Sol" }, threadOf), person, "a thread T3 knows wins over --owner, and its title is one line");
  assert.deepEqual(ownerFor({ branch: "refs/heads/other", checkout: "C:\\w\\Other", ownerName: " Sol\nReview " }, threadOf), { key: "flag:sol review", title: "Sol Review", source: "flag" });
  assert.deepEqual(ownerFor({ branch: null, checkout: "C:\\w\\Other", ownerName: " " }, threadOf), { key: "checkout:c:\\w\\other", title: "C:\\w\\Other", source: "checkout" });
  const locked = () => { throw new Error("database is locked"); };
  assert.deepEqual(ownerFor({ branch: "refs/heads/feat/sync", checkout: "C:\\w\\Sync", ownerName: "Sol" }, locked), { key: "flag:sol", title: "Sol", source: "flag" }, "a lookup that throws falls back");
  assert.deepEqual(ownerFor({ nightly: true, branch: "refs/heads/main", checkout: "nightly" }, () => threads["feat/sync"]), { key: "checkout:nightly", title: "nightly", source: "checkout" }, "the nightly run belongs to no thread");
});

test("a move is checked and cleaned before it is applied, and its note always names the checkout", () => {
  const by = { name: "Ice", user: "ice", cwd: "C:\\w\\fix-grid" };
  const move = fields => parseMove({ id: "000000002-bbbbbb", before: null, reason: "unblocks others", by, ...fields });
  assert.deepEqual(move({}), { id: "000000002-bbbbbb", before: null, reason: "unblocks others", by });
  assert.match(move({ before: "" }).rejected, /--before names no request/u, "an empty --before is never --first");
  assert.match(move({ before: " \n" }).rejected, /--before names no request/u);
  for (const fields of [{ id: "" }, { id: { toString: 1 } }, { reason: "\n\t" }, { reason: 7 }, { by: "Ice" }, { by: { name: 5 } }, { by: [] }]) {
    assert.ok(move(fields).rejected, JSON.stringify(fields));
  }
  for (const raw of [null, [1], "move", 3]) assert.match(parseMove(raw).rejected, /not a JSON object/u);
  const cleaned = move({ reason: `fixes main\n000000001-aaaaaa  #1  all\r\n\u001b[31mred\u202e ${"x".repeat(400)}`, by: { name: "Ice\nX", user: null, cwd: `C:\\w\\${"y".repeat(300)}` } });
  assert.equal(cleaned.reason, `fixes main 000000001-aaaaaa #1 all [31mred ${"x".repeat(400)}`.slice(0, 300), "one line, no control characters, at most 300 characters");
  assert.deepEqual([cleaned.by.name, cleaned.by.user, cleaned.by.cwd.length], ["Ice X", null, 200]);
  assert.equal(movedNote({ before: null, by, reason: "unblocks others" }), "moved first by Ice (C:\\w\\fix-grid): unblocks others");
  assert.equal(movedNote({ before: "000000001-aaaaaa", by: { ...by, name: null }, reason: "r" }), "moved before 000000001-aaaaaa by ice (C:\\w\\fix-grid): r");
});

test("the nightly submission verifies main's head in full, against the last nightly that passed", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-nightly-"));
  const fixture = fixtureRepo();
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(fixture.repo, { recursive: true, force: true }); });
  fixture.git("update-ref", "refs/remotes/origin/main", fixture.head);
  let fetched = 0;
  const first = await submitNightly(root, fixture.repo, { fetch: () => { fetched += 1; } });
  assert.equal(fetched, 1);
  assert.deepEqual(first, { head: fixture.head, base: fixture.base }, "with no nightly yet, the base is main's previous commit");
  const [name] = readdirSync(queuePaths(root).inbox);
  const submission = readJson(join(queuePaths(root).inbox, name));
  assert.deepEqual({ ...submission, key: undefined, submittedAt: undefined, protocol: undefined },
    { head: fixture.head, base: fixture.base, scope: "all", full: true, gates: { rust: true, js: true }, branch: "refs/heads/main", checkout: "nightly", nightly: true, key: undefined, submittedAt: undefined, protocol: undefined });
  // Once a nightly passed, the next one covers everything merged since.
  await writeJson(join(queuePaths(root).request("000000001-aaaaaa"), "request.json"), { id: "000000001-aaaaaa", sequence: 1, head: fixture.base, base: fixture.base, nightly: true, scope: "all" });
  await writeJson(join(queuePaths(root).request("000000001-aaaaaa"), "status.json"), { state: "passed", attempts: [] });
  assert.equal(lastNightlyPass(listRequests(root)).id, "000000001-aaaaaa");
  assert.deepEqual(await submitNightly(root, fixture.repo, { fetch: () => {} }), { head: fixture.head, base: fixture.base });
});

test("the nightly task submits the run every night and stops within ten minutes", () => {
  const xml = nightlyTaskDefinition("C:\\w\\_verification");
  assert.match(xml, /<CalendarTrigger><Enabled>true<\/Enabled><StartBoundary>2026-01-01T03:07:00<\/StartBoundary><ScheduleByDay><DaysInterval>1<\/DaysInterval><\/ScheduleByDay><\/CalendarTrigger>/u);
  assert.match(xml, /nightly\.ps1/u);
  assert.match(xml, /<ExecutionTimeLimit>PT10M<\/ExecutionTimeLimit>/u);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/u, "a night the host slept still gets its run");
  assert.match(xml, /<RestartOnFailure><Interval>PT10M<\/Interval><Count>6<\/Count><\/RestartOnFailure>/u, "a failed fetch tries again");
});

test("pruning keeps the last nightly that passed, however old", async t => {
  const { root, request, settled } = harness(t);
  const paths = queuePaths(root);
  const old = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  for (const [id, nightly] of [["000000001-aaaaaa", true], ["000000002-bbbbbb", false]]) {
    await writeJson(join(paths.request(id), "request.json"), { id, sequence: Number(id.slice(0, 9)), head: "0".repeat(40), base: "0".repeat(40), scope: "all", nightly });
    await writeJson(join(paths.request(id), "status.json"), { state: "passed", attempts: [], updatedAt: old });
  }
  // Prune runs once the service has been up for ten minutes, or on its first tick.
  await settled((await request("pass")).id);
  await waitFor(() => !existsSync(paths.request("000000002-bbbbbb")), "an old request is pruned", 20_000);
  assert.ok(existsSync(paths.request("000000001-aaaaaa")), "the last passing nightly stays");
});

test("the service task restarts a dead supervisor from the session that installed it, at normal priority", () => {
  const xml = taskDefinition("C:\\w\\_verification");
  // A logon trigger's repetition only starts at the next logon; the time trigger repeats from the moment it is registered.
  assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>[^<]*<\/UserId><\/LogonTrigger>/u);
  assert.match(xml, /<TimeTrigger>.*<Repetition><Interval>PT5M<\/Interval>/u);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(xml, /<Priority>4<\/Priority>/u, "the default priority runs every gate below normal");
});

test("a failed test is shared when another branch's run failed it in the last day; runs of the same branch do not count", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-shared-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = queuePaths(root);
  const now = Date.parse("2026-10-15T12:00:00Z");
  const grid = { step: "@dohc/desktop", test: "src/grid.test.tsx › draws the table" };
  const rust = { step: "rust", test: "dohc-engine-sync tests::lane_delete" };
  const own = { step: "repository", test: "fails only on this branch" };
  const lines = { "000000001-aaaaaa": "refs/heads/feat/a", "000000002-bbbbbb": "refs/heads/fix/b", "000000003-cccccc": "refs/heads/mine",
    "000000004-dddddd": "refs/heads/old", "000000005-eeeeee": "refs/heads/other-step", "000000006-ffffff": null };
  for (const [id, branch] of Object.entries(lines)) await writeJson(join(paths.request(id), "request.json"), { id, branch, checkout: `C:\\w\\${id.slice(-6)}` });
  const finished = (hours, id, failed) => JSON.stringify({ at: new Date(now - hours * 60 * 60_000).toISOString(), event: "finished", id, attempt: 1, failed, outcome: "failed" });
  writeFileSync(paths.history, [
    finished(30, "000000004-dddddd", [grid, rust]),
    finished(5, "000000001-aaaaaa", [grid]),
    "{torn",
    JSON.stringify({ at: new Date(now - 4 * 60 * 60_000).toISOString(), event: "started", id: "000000002-bbbbbb", failed: [rust] }),
    finished(3, "000000002-bbbbbb", [grid, rust]),
    finished(3, "000000005-eeeeee", [{ step: "@dohc/sync-relay", test: grid.test }]),
    finished(2, "000000003-cccccc", [grid, own]),
    finished(1, "000000006-ffffff", [rust]),
    finished(1, "000000009-pruned", [own]),
  ].join("\n") + "\n");
  const failed = [grid, rust, own, { step: "rust", test: "fails nowhere else" }];
  assert.deepEqual(sharedFailures(root, failed, { branch: "refs/heads/mine", now }), [
    { ...grid, branches: ["feat/a", "fix/b"] },
    { ...rust, branches: ["C:\\w\\ffffff", "fix/b"] },
  ], "a run older than a day, the same test in another step, this branch's runs, and a request with no record do not count; a detached run is named by its checkout");
  assert.deepEqual(sharedFailures(root, failed, { branch: "Mine", now }), sharedFailures(root, failed, { branch: "refs/heads/mine", now }), "a branch named without refs/heads/ is still this branch");
  assert.deepEqual(sharedFailures(root, [own], { branch: "refs/heads/mine", now }), []);
  assert.deepEqual(sharedFailures(root, [], { branch: "refs/heads/mine", now }), []);
  assert.deepEqual(sharedFailures(join(root, "missing"), failed, { branch: "refs/heads/mine", now }), [], "a missing queue root gives none");
  rmSync(paths.history);
  mkdirSync(paths.history);
  assert.deepEqual(sharedFailures(root, failed, { branch: "refs/heads/mine", now }), [], "an unreadable history gives none");
});

test("a request whose status cannot be read is skipped, never taken for a new one", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-status-"));
  try {
    const paths = queuePaths(root);
    for (const id of ["000000001-aaaaaa", "000000002-bbbbbb"]) {
      mkdirSync(paths.request(id), { recursive: true });
      writeFileSync(join(paths.request(id), "request.json"), JSON.stringify({ id, sequence: Number(id.slice(0, 9)) }));
    }
    // A directory where the status belongs cannot be read, as a file antivirus holds cannot.
    mkdirSync(join(paths.request("000000002-bbbbbb"), "status.json"));
    assert.deepEqual(listRequests(root).map(entry => [entry.id, entry.status.state]), [["000000001-aaaaaa", "queued"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("machine failures are told apart from failures of the change", () => {
  const kind = fields => failureKind(Object.assign(new Error(fields.message ?? "failed"), fields)).kind;
  assert.equal(kind({ status: 3221225794 }), "environment", "a program that could not start");
  assert.equal(kind({ code: "ENOENT", syscall: "spawn git" }), "environment");
  assert.equal(kind({ code: "ENOMEM", syscall: "spawn node" }), "environment", "any failure to start a program ran no check");
  assert.equal(kind({ code: "ENOENT", cause: Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT", syscall: "spawnSync git" }) }), "environment", "the git helper keeps the spawn error as its cause");
  assert.equal(kind({ step: "queue", message: "The verification queue service is not installed." }), "environment");
  assert.equal(kind({ code: "ENOENT", syscall: "open", step: "desktop" }), "check", "a missing report is the run's own failure");
  assert.equal(kind({ step: "postgres-start", message: "Verification Postgres did not become healthy." }), "environment");
  assert.equal(kind({ step: "install", stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }), "check");
  assert.equal(kind({ step: "install", stderr: "ECONNRESET" }), "environment");
  assert.equal(kind({ step: "tests", commandExitFailure: true }), "check");
  assert.equal(kind({ step: "tests", stderr: "expected ENOSPC: no space left on device", stdout: "0xC0000142" }), "check", "text in test output proves nothing");
  assert.equal(kind({ step: "rust", stdout: "refusing to run the gate: 38.2 GB free on the worktree volume is below the 40 GB floor" }), "environment");
  // Another lane can use up the disk after this run was admitted.
  assert.equal(kind({ step: "prepare", environment: "disk space", message: "Build needs 40 GB free; observed 38.2." }), "environment");
  assert.equal(kind({ step: "tests", stderr: "Error: Build needs 40 GB free; observed 38.2." }), "check", "a test may print a refusal it expects");
});

test("a command the Windows job relay cannot start is a machine failure", { skip: process.platform !== "win32" && "the job relay is Windows-only" }, async () => {
  const error = await run("dohc-no-such-program", [], { quietStdout: true }).then(() => null, failure => failure);
  assert.equal(error?.exitCode, 0xD0C5, "the relay's exit code for a command that never started");
  assert.equal(failureKind(error).kind, "environment");
});

test("a verifier takes its grant out of the environment its children inherit", () => {
  const env = { DOHC_VERIFICATION_GRANT: JSON.stringify({ request: "r", attempt: 1 }), DOHC_VERIFICATION_OUTPUT: "C:\\out", PATH: "x" };
  assert.deepEqual(takeGrant(env), { grant: { request: "r", attempt: 1 }, output: "C:\\out" });
  assert.deepEqual(env, { PATH: "x" });
  assert.deepEqual(takeGrant({}), { grant: null, output: null });
});

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "dohc-queue-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q", "-b", "main");
  // A personal signing setup must not reach the fixture.
  git("config", "commit.gpgsign", "false");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "head");
  return { repo, base, head: git("rev-parse", "HEAD"), git };
}

/** A service on a private root with a stub verifier: request.checkout names its behavior. */
function harness(t, { timeLimitMs = 60_000, docker = async () => true, sweep = async () => 0, hostFails = () => {}, holdLane = async () => ({ release() {} }), prepare = async () => {}, prepareLimitMs, lanes, cleanupRetryMs = 50, freeMemory = () => 32, heartbeatMs, bootedAt, threadOf = () => null, strays = async () => undefined, strayRetryMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-"));
  const fixture = fixtureRepo();
  const calls = [];
  // Runs that pass once the test calls finishHeld.
  const held = [];
  let stop = new AbortController();
  const worker = async ({ lane, request, grant, output, signal }) => {
    calls.push({ id: grant.request, attempt: grant.attempt, behavior: request.checkout, lane });
    const receipt = fields => writeFileSync(join(output, "result.json"), JSON.stringify({ grant, commit: grant.head, baseCommit: grant.base, final: true, ...fields }));
    const behavior = request.checkout;
    if (behavior === "pass") receipt({ verdict: "PASS" });
    else if (behavior === "pass-on-retry") receipt({ verdict: "PASS", flaky: [{ step: "repository", test: "times out under load" }],
      timings: [{ name: "tests", seconds: 1260.4 }, { name: "rust", seconds: 990.2 }], slowest: [{ step: "desktop", test: "restarts", seconds: 66 }] });
    else if (behavior === "fail") receipt({ verdict: "FAIL", error: "a test failed", failure: { kind: "check", cause: "tests" }, failed: [{ step: "repository", test: "times out under load" }] });
    else if (behavior === "slow-fail") { await sleep(300); receipt({ verdict: "FAIL", error: "a test failed", failure: { kind: "check", cause: "tests" } }); }
    else if (behavior === "fail-as-host-fails") { hostFails(calls.length); receipt({ verdict: "FAIL", error: "a test failed", failure: { kind: "check", cause: "tests" } }); }
    else if (behavior === "flaky-host") receipt(calls.filter(call => call.id === grant.request).length === 1
      ? { verdict: "FAIL", error: "Docker did not answer", failure: { kind: "environment", cause: "postgres-start" } } : { verdict: "PASS" });
    else if (behavior === "crash") throw new Error("worker crashed without a receipt");
    else if (behavior === "hang") await new Promise(done => signal.addEventListener("abort", done, { once: true }));
    else if (behavior === "held") { await new Promise(done => held.push(done)); receipt({ verdict: "PASS" }); }
    else if (behavior === "host-down") receipt({ verdict: "FAIL", error: "Docker did not answer", failure: { kind: "environment", cause: "postgres-start" } });
    // Two slow machine failures, then a run that ends only when it is stopped.
    else if (behavior === "slow-host" && calls.filter(call => call.id === grant.request).length > 2) await new Promise(done => signal.addEventListener("abort", done, { once: true }));
    else if (behavior === "slow-host") { await sleep(3000); receipt({ verdict: "FAIL", error: "Docker did not answer", failure: { kind: "environment", cause: "postgres-start" } }); }
  };
  const serve = (overrides = {}) => runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, timeLimitMs, floorGb: 1,
    freeDisk: () => 100, docker, prepare, sweep, prepareLimitMs, heartbeatMs, bootedAt,
    holdLane, worker, retryDelay: () => 50, cleanupRetryMs, lanes, freeMemory, threadOf, stop: stop.signal, log: () => {}, keepAwake: () => () => {}, strays, strayRetryMs, ...overrides });
  let service = serve();
  // Stop the service and start another on the same root, as the supervisor does. Resolves once the new one beats.
  const restart = async overrides => {
    const before = readJson(queuePaths(root).service)?.startedAt;
    stop.abort();
    await service;
    stop = new AbortController();
    service = serve(overrides);
    await waitFor(() => readJson(queuePaths(root).service)?.startedAt !== before, "the restarted service must beat");
  };
  t.after(async () => { stop.abort(); await service; rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); rmSync(fixture.repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const request = async (behavior, fields = {}) => {
    // Each behavior verifies its own commit: one commit with the same gates is one piece of work.
    if (!fields.head) fixture.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", behavior);
    const head = fields.head ?? fixture.git("rev-parse", "HEAD");
    const key = await submit(root, { head, base: fixture.base, scope: "all", gates: { rust: true, js: true }, branch: `refs/heads/${behavior}`, checkout: behavior, ...fields, head });
    return waitFor(() => readJson(join(queuePaths(root).keys, key)), `submission ${behavior} was not answered`);
  };
  const settled = id => waitFor(() => {
    const found = listRequests(root).find(candidate => candidate.id === id);
    return found && terminalStates.has(found.status.state) ? found : null;
  }, `request ${id} did not finish`);
  const finishHeld = () => held.splice(0).forEach(done => done());
  return { root, fixture, calls, request, settled, service, restart, finishHeld };
}

const uptimeMs = () => uptime() * 1000;

async function waitFor(read, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < deadline, message);
    await sleep(20);
  }
}

test("the service records passes and check failures, and retries a machine failure in place", async t => {
  const { request, settled, calls } = harness(t);
  const pass = await request("pass");
  const fail = await request("fail");
  const flaky = await request("flaky-host");
  assert.equal((await settled(pass.id)).status.verdict, "PASS");
  const failed = await settled(fail.id);
  assert.equal(failed.status.state, "failed");
  assert.equal(failed.status.reason, "a test failed");
  const retried = await settled(flaky.id);
  assert.equal(retried.status.verdict, "PASS");
  assert.deepEqual(retried.status.attempts.map(attempt => attempt.outcome), ["environment", "passed"]);
  assert.equal(calls.filter(call => call.id === flaky.id).length, 2);
  assert.ok(existsSync(retried.status.result), "the result names the passing attempt's own receipt");
  assert.match(retried.status.result, /attempts[\\/]2[\\/]result\.json$/u);
});

test("a hung run stops at its time limit and a run without a receipt is retried, never passed", async t => {
  const { root, request, settled, calls } = harness(t, { timeLimitMs: 300 });
  const hung = await request("hang");
  const stopped = await settled(hung.id);
  assert.equal(stopped.status.state, "failed");
  assert.equal(stopped.status.cause, "time limit");
  const crash = await request("crash");
  await waitFor(() => calls.filter(call => call.id === crash.id).length >= 2, "a crash without a receipt must be retried");
  const crashed = listRequests(root).find(candidate => candidate.id === crash.id);
  assert.ok(!terminalStates.has(crashed.status.state), `a crash leaves the request waiting to retry, not ${crashed.status.state}`);
  assert.ok(crashed.status.attempts.every(attempt => !attempt.outcome || attempt.outcome === "environment"));
});

test("a repeated submission attaches, a newer commit replaces a queued one, and cancel stops a run", async t => {
  const { root, fixture, request, settled } = harness(t, { timeLimitMs: 60_000 });
  fixture.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "hang");
  const hangHead = fixture.git("rev-parse", "HEAD");
  const hung = await request("hang", { head: hangHead });
  await waitFor(() => listRequests(root).find(candidate => candidate.id === hung.id)?.status.state === "running", "the hang must start");
  assert.deepEqual(await request("hang", { head: hangHead }), hung, "the same work attaches to the running request");
  const first = await request("pass", { branch: "refs/heads/feature" });
  fixture.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "newer");
  const second = await request("pass", { branch: "refs/heads/feature", head: fixture.git("rev-parse", "HEAD") });
  const replaced = await settled(first.id);
  assert.equal(replaced.status.state, "superseded");
  assert.equal(replaced.status.supersededBy, second.id);
  assert.equal(second.id.slice(0, 9), first.id.slice(0, 9), "the newer commit keeps the older one's place");
  await cancel(root, hung.id);
  assert.equal((await settled(hung.id)).status.state, "cancelled");
  assert.equal((await settled(second.id)).status.verdict, "PASS");
});

test("two lanes run two requests at once, each in its own checkout, and the next takes the freed one", async t => {
  const { root, request, settled, calls } = harness(t, { lanes: () => 2 });
  const state = id => listRequests(root).find(candidate => candidate.id === id).status.state;
  const started = id => waitFor(() => calls.find(call => call.id === id), `${id} must start`);
  const first = await request("hang");
  const second = await request("hang");
  const [one, two] = [await started(first.id), await started(second.id)];
  assert.notEqual(one.lane, two.lane, "each run has its own checkout");
  const third = await request("pass");
  // A later acceptance means the service has filled its lanes since the third arrived.
  await request("pass", { branch: "refs/heads/later" });
  assert.equal(state(third.id), "queued", "both lanes are busy");
  await cancel(root, first.id);
  assert.equal((await settled(first.id)).status.state, "cancelled");
  assert.equal(state(second.id), "running", "a stop reaches only its own run");
  const laneOf = id => listRequests(root).find(candidate => candidate.id === id).status.attempts[0].lane;
  assert.deepEqual([laneOf(first.id), laneOf(second.id)], [one, two].map(call => call.lane.endsWith("-2") ? 2 : 1), "each attempt names the lane it ran in");
  // Each attempt records the load it verified under, in its status and in the history.
  const load = listRequests(root).find(candidate => candidate.id === first.id).status.attempts[0].load;
  assert.equal(load.lanes, 2);
  assert.equal(load.peakRuns, 2);
  assert.ok(load.minFreeMemGb > 0 && load.cpuBusyPercent >= 0 && load.cpuBusyPercent <= 100, JSON.stringify(load));
  const finished = readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(event => event.event === "finished" && event.id === first.id);
  assert.deepEqual(finished.load, load);
  assert.equal((await settled(third.id)).status.verdict, "PASS");
  assert.equal(calls.find(call => call.id === third.id).lane, one.lane, "the next run takes the freed checkout");
  await cancel(root, second.id);
  assert.equal((await settled(second.id)).status.state, "cancelled");
});

test("a requested restart starts nothing new and waits for the runs in flight", async t => {
  const { root, request, settled, calls, service } = harness(t, { lanes: () => 2 });
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  writeFileSync(join(queuePaths(root).control, "restart"), "");
  const waiting = await request("pass");
  await request("pass", { branch: "refs/heads/later" });
  const state = () => listRequests(root).find(candidate => candidate.id === waiting.id).status.state;
  assert.equal(state(), "queued", "a free lane takes nothing during a restart");
  await cancel(root, hung.id);
  assert.equal((await settled(hung.id)).status.state, "cancelled");
  assert.equal(await service, 75);
  assert.equal(state(), "queued");
});

test("a pass with tests that needed a retry records them in its attempt and the history", async t => {
  const { root, request, settled } = harness(t);
  const passed = await settled((await request("pass-on-retry")).id);
  const expected = [{ step: "repository", test: "times out under load" }];
  assert.equal(passed.status.verdict, "PASS");
  assert.deepEqual(passed.status.attempts[0].flaky, expected);
  assert.deepEqual(passed.status.attempts[0].steps, { tests: 1260, rust: 990 });
  assert.deepEqual(passed.status.attempts[0].slowest, [{ step: "desktop", test: "restarts", seconds: 66 }]);
  const finished = readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(event => event.event === "finished" && event.id === passed.id);
  assert.deepEqual(finished.flaky, expected);
  // The history keeps the step times and slowest tests for the weekly review.
  assert.deepEqual(finished.steps, { tests: 1260, rust: 990 });
  assert.deepEqual(finished.slowest, [{ step: "desktop", test: "restarts", seconds: 66 }]);
});

test("a failed run records the tests that failed in its attempt and the history, where another branch finds them", async t => {
  const { root, request, settled } = harness(t);
  const failed = await settled((await request("fail")).id);
  const expected = [{ step: "repository", test: "times out under load" }];
  assert.equal(failed.status.verdict, "FAIL");
  assert.deepEqual(failed.status.attempts[0].failed, expected);
  const finished = readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(event => event.event === "finished" && event.id === failed.id);
  assert.deepEqual(finished.failed, expected);
  assert.deepEqual(sharedFailures(root, expected, { branch: "refs/heads/other" }), [{ ...expected[0], branches: ["fail"] }]);
  assert.deepEqual(sharedFailures(root, expected, { branch: "refs/heads/fail" }), []);
});

test("an attempt that never sampled the host records its load as null", async t => {
  const { root, request, settled } = harness(t);
  const passed = await settled((await request("pass")).id);
  assert.ok("load" in passed.status.attempts[0], "the attempt row names its load");
  const finished = readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(event => event.event === "finished" && event.id === passed.id);
  assert.ok("load" in finished, "the history event names its load");
});

test("a lane setting that cannot be read keeps the lane count the service had, for its slots too", async t => {
  let slots;
  const { request, settled } = harness(t, { lanes: () => { throw new Error("verification-lanes must contain a lane count from 1 to 4."); },
    holdLane: async ({ lanes }) => { slots = lanes(); return { release() {} }; } });
  assert.equal((await settled((await request("pass")).id)).status.verdict, "PASS");
  assert.equal(slots, 1);
});

test("a request's cleanup removes only its containers and their volumes, and the sweep never one another lane may be starting", async () => {
  let removed = [];
  const flags = [];
  const command = async (_, args) => {
    if (args[0] === "rm") {
      flags.push(args.filter(arg => arg.startsWith("--")));
      removed.push(...args.slice(1).filter(arg => !arg.startsWith("--")));
      return { stdout: "" };
    }
    const filters = args.filter(arg => arg.includes("="));
    const found = filters.includes("label=dohc.verification=r1") ? "own" : filters.includes("status=exited") ? "exited" : filters.includes("status=created") ? "starting" : "";
    return { stdout: found };
  };
  assert.equal(await sweepContainers({ request: "r1", command }), 1);
  assert.deepEqual(removed, ["own"], "another request's container cannot fail this cleanup");
  removed = [];
  assert.equal(await sweepContainers({ command }), 1);
  assert.deepEqual(removed, ["exited"]);
  assert.deepEqual(flags, [["--force", "--volumes"], ["--force", "--volumes"]], "each removal takes the container's anonymous data volume with it");
});

test("each lane has its own temp folder under the queue root", () => {
  assert.equal(laneTemp(join("C:", "w", "_verification", "lane")), join("C:", "w", "_verification", "tmp", "lane"));
  assert.equal(laneTemp(join("C:", "w", "_verification", "lane-2")), join("C:", "w", "_verification", "tmp", "lane-2"));
});

test("a lane's clean removes read-only build output that git clean alone cannot, and keeps the caches", async () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-lane-clean-"));
  // As the Markdown reader's staging left it before #2243: a read-only folder holding read-only files.
  // The other two have names Git would quote, and a name that trimmed output would lose.
  const generations = [join(root, "resources", "engine-reader", "generation"), join(root, "généré"), join(root, " generated")];
  const cached = join(root, "scratch", "node_modules", "package", "index.js");
  try {
    const git = async args => (await run("git", args, { cwd: root, quietStdout: true })).stdout;
    await git(["init", "-q"]);
    writeFileSync(join(root, ".gitignore"), "resources/\n");
    for (const generation of generations) {
      mkdirSync(generation, { recursive: true });
      writeFileSync(join(generation, "reader.cjs"), "");
      chmodSync(join(generation, "reader.cjs"), 0o444);
      chmodSync(generation, 0o555);
    }
    mkdirSync(join(cached, ".."), { recursive: true });
    writeFileSync(cached, "");
    chmodSync(cached, 0o444);
    await cleanCheckout(git, root);
    for (const generation of generations) assert.equal(existsSync(generation), false, generation);
    assert.equal(statSync(cached).mode & 0o200, 0, "the clean keeps a cache below an untracked folder as it was");
  } finally {
    for (const path of [...generations, cached]) try { chmodSync(path, 0o755); } catch { /* Removed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lane's clean retries only after Git ran and failed, and fails when the retry does", async () => {
  const calls = [];
  const exited = Object.assign(new Error("git failed (1)."), { commandExitFailure: true });
  await assert.rejects(cleanCheckout(async args => {
    calls.push(args[0]);
    if (args[0] === "clean") throw exited;
    return "";
  }, tmpdir()), /git failed \(1\)/);
  assert.deepEqual(calls, ["clean", "ls-files", "clean"]);
  calls.length = 0;
  const timedOut = Object.assign(new Error("git failed (timed out after 900000ms)."), { timedOut: true });
  await assert.rejects(cleanCheckout(async args => { calls.push(args[0]); throw timedOut; }, tmpdir()), /timed out/);
  assert.deepEqual(calls, ["clean"], "a timeout or a stop fails the lane without touching it again");
  calls.length = 0;
  // Windows' job relay exits with 0xD0C5 when Git never started.
  const neverStarted = Object.assign(new Error("git failed (53445)."), { commandExitFailure: true, exitCode: 0xD0C5 });
  await assert.rejects(cleanCheckout(async args => { calls.push(args[0]); throw neverStarted; }, tmpdir()), /53445/);
  assert.deepEqual(calls, ["clean"]);
});

test("another run waits while free memory is low, but a lone run still starts", async t => {
  let memory = 5;
  const { root, request, calls } = harness(t, { lanes: () => 2, freeMemory: () => memory });
  const state = id => listRequests(root).find(candidate => candidate.id === id).status.state;
  const first = await request("hang");
  await waitFor(() => calls.find(call => call.id === first.id), "a lone run starts on low memory");
  const second = await request("hang");
  // A later acceptance means the service has decided about the second since it arrived.
  await request("pass", { branch: "refs/heads/later" });
  assert.equal(state(second.id), "queued", "the second run waits for memory");
  await waitFor(() => /waiting for memory/u.test(readJson(queuePaths(root).service)?.health?.reason ?? "") || null, "status says why", 20_000);
  memory = 20;
  await waitFor(() => calls.find(call => call.id === second.id), "the second run starts once memory is back");
  // With every lane busy, no run waits for memory, so status does not say so.
  memory = 5;
  await waitFor(() => readJson(queuePaths(root).service)?.health?.reason === null || null, "a full host waits for a lane, not for memory", 20_000);
  await cancel(root, first.id);
  await cancel(root, second.id);
});

test("a check that fails after free memory ran out is retried as a machine failure", async t => {
  const { request, calls } = harness(t, { freeMemory: () => 1 });
  const failed = await request("slow-fail");
  await waitFor(() => calls.filter(call => call.id === failed.id).length >= 2, "the failure must be retried");
});

test("four lanes run four requests at once, each in its own checkout", async t => {
  const { root, request, calls } = harness(t, { lanes: () => 4 });
  const hung = [];
  for (const branch of ["a", "b", "c", "d"]) hung.push(await request("hang", { branch: `refs/heads/${branch}` }));
  await waitFor(() => calls.length === 4, "four runs must start");
  assert.equal(new Set(calls.map(call => call.lane)).size, 4, "each run has its own checkout");
  for (const entry of hung) await cancel(root, entry.id);
});

test("three lanes run a third gate; switching back to two stops nothing and starts no gate until fewer than two run; each attempt records the lanes it ran under", async t => {
  let lanes = 3;
  const { root, request, settled, calls } = harness(t, { lanes: () => lanes, heartbeatMs: 50 });
  const beat = () => readJson(queuePaths(root).service);
  const state = id => listRequests(root).find(candidate => candidate.id === id).status.state;
  // The clock samples the host and counts awake time together, so awake time shows a run has sampled its lanes.
  const sampled = id => waitFor(() => beat()?.running.find(run => run.id === id)?.awakeMs > 0, `${id} must sample the host`);
  const hung = [];
  for (const branch of ["a", "b", "c"]) hung.push(await request("hang", { branch: `refs/heads/${branch}` }));
  await waitFor(() => calls.length === 3, "three lanes run three gates at once");
  for (const entry of hung) await sampled(entry.id);
  lanes = 2;
  await waitFor(() => beat()?.lanes === 2, "the service reads the lowered setting");
  assert.deepEqual(hung.map(entry => state(entry.id)), ["running", "running", "running"], "switching back to two stops nothing");
  const next = await request("hang", { branch: "refs/heads/d" });
  // A later acceptance means the service has decided about the request before it.
  await request("pass", { branch: "refs/heads/later" });
  assert.equal(state(next.id), "queued", "no gate starts while three run under a setting of two");
  await cancel(root, hung[0].id);
  await settled(hung[0].id);
  await request("pass", { branch: "refs/heads/later-still" });
  assert.equal(state(next.id), "queued", "the closing lane takes no more gates");
  await cancel(root, hung[1].id);
  await waitFor(() => calls.find(call => call.id === next.id), "a gate starts once fewer than two run");
  await sampled(next.id);
  for (const entry of [hung[2], next]) await cancel(root, entry.id);
  const loads = [];
  for (const entry of [...hung, next]) loads.push((await settled(entry.id)).status.attempts[0].load);
  assert.deepEqual(loads.map(load => [load.lanes, load.peakRuns]), [[3, 3], [3, 3], [3, 3], [2, 2]], "a gate that ran while three lanes were open says so, even after the switch back");
  const finished = readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "finished");
  assert.deepEqual([...hung, next].map(entry => finished.find(event => event.id === entry.id).load), loads, "the history records the same load");
});

test("a submission the service cannot verify is rejected with a reason", async t => {
  const { request } = harness(t);
  assert.match((await request("pass", { head: "0".repeat(40) })).rejected, /not in this host's repository/u);
  assert.match((await request("pass", { scope: "docs" })).rejected, /Unknown scope/u);
});

test("a restarted service keeps a finished receipt and retries an interrupted run, even one it could not read at first", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-restart-"));
  const fixture = fixtureRepo();
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); rmSync(fixture.repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const paths = queuePaths(root);
  const plant = async (id, receipt) => {
    await writeJson(join(paths.request(id), "request.json"), { id, sequence: Number(id.slice(0, 9)), head: fixture.head, base: fixture.base, scope: "all", gates: { rust: true, js: false }, checkout: "pass", branch: `refs/heads/${id}` });
    await writeJson(join(paths.request(id), "status.json"), { state: "running", attempts: [{ n: 1, startedAt: new Date().toISOString() }] });
    mkdirSync(paths.attempt(id, 1), { recursive: true });
    if (receipt) writeFileSync(join(paths.attempt(id, 1), "result.json"), JSON.stringify({ grant: { request: id, attempt: 1, head: fixture.head, base: fixture.base }, commit: fixture.head, baseCommit: fixture.base, verdict: "PASS", final: true, flaky: [{ step: "rust", test: "engine::settles" }] }));
  };
  await plant("000000001-aaaaaa", true);
  await plant("000000002-bbbbbb", false);
  await plant("000000003-cccccc", false);
  // The third request's status cannot be read when the service starts, as when antivirus holds the file.
  const held = join(paths.request("000000003-cccccc"), "status.json");
  const status = readFileSync(held, "utf8");
  rmSync(held);
  mkdirSync(held);
  const calls = [];
  const stop = new AbortController();
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100, keepAwake: () => () => {}, strays: async () => undefined,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }), retryDelay: () => 0,
    worker: async ({ grant, output }) => { calls.push(grant); writeFileSync(join(output, "result.json"), JSON.stringify({ grant, commit: grant.head, baseCommit: grant.base, verdict: "PASS", final: true })); },
    threadOf: () => null, stop: stop.signal, log: () => {} });
  const settled = count => waitFor(() => {
    const all = listRequests(root);
    return all.length === count && all.every(candidate => terminalStates.has(candidate.status.state)) ? all : null;
  }, `${count} requests must finish`);
  await settled(2);
  // Once the status can be read, the running service recovers the request like the others.
  rmSync(held, { recursive: true });
  writeFileSync(held, status);
  const finished = await settled(3);
  stop.abort();
  await service;
  assert.deepEqual(finished.map(candidate => candidate.status.verdict), ["PASS", "PASS", "PASS"]);
  assert.deepEqual(finished[0].status.attempts[0].flaky, [{ step: "rust", test: "engine::settles" }], "a recovered receipt keeps its flaky tests");
  assert.deepEqual(calls.map(grant => [grant.request, grant.attempt]), [["000000002-bbbbbb", 2], ["000000003-cccccc", 2]], "only interrupted requests run again, as new attempts");
});

test("a newer commit submitted while the service was down replaces the request it interrupted", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-restart-newer-"));
  const fixture = fixtureRepo();
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); rmSync(fixture.repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const paths = queuePaths(root);
  const old = "000000001-aaaaaa";
  const fields = { base: fixture.base, scope: "all", gates: { rust: true, js: false }, checkout: "pass", branch: "refs/heads/feature" };
  await writeJson(join(paths.request(old), "request.json"), { id: old, sequence: 1, head: fixture.head, ...fields });
  await writeJson(join(paths.request(old), "status.json"), { state: "running", attempts: [{ n: 1, startedAt: new Date().toISOString() }] });
  fixture.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "newer");
  const newer = fixture.git("rev-parse", "HEAD");
  const key = await submit(root, { head: newer, ...fields });
  const calls = [];
  const stop = new AbortController();
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100, keepAwake: () => () => {}, strays: async () => undefined,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }), retryDelay: () => 0,
    worker: async ({ grant, output }) => { calls.push(grant.head); writeFileSync(join(output, "result.json"), JSON.stringify({ grant, commit: grant.head, baseCommit: grant.base, verdict: "PASS", final: true })); },
    threadOf: () => null, stop: stop.signal, log: () => {} });
  const id = (await waitFor(() => readJson(join(paths.keys, key)), "the newer commit must be accepted")).id;
  const all = await waitFor(() => {
    const requests = listRequests(root);
    return requests.length === 2 && requests.every(candidate => terminalStates.has(candidate.status.state)) ? requests : null;
  }, "both requests must settle");
  stop.abort();
  await service;
  assert.deepEqual(Object.fromEntries(all.map(candidate => [candidate.id, candidate.status.state])), { [old]: "superseded", [id]: "passed" });
  assert.deepEqual(calls, [newer], "only the newer commit is verified");
});

test("only one service serves a queue root", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-single-"));
  const fixture = fixtureRepo();
  const stop = new AbortController();
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); rmSync(fixture.repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const options = { root, repo: fixture.repo, tickMs: 20, freeDisk: () => 100, floorGb: 1, docker: async () => true, threadOf: () => null, stop: stop.signal, log: () => {} };
  const first = runService(options);
  await waitFor(() => existsSync(queuePaths(root).service), "the first service must start");
  assert.equal(await runService(options), 0, "a second service on the same root exits at once");
  stop.abort();
  await first;
});

test("the supervisor stops everything a dead service started, restarts it, and its job takes the rest", { skip: process.platform !== "win32" && "job objects are Windows-only" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-supervisor-"));
  t.after(async () => {
    // A failed run can leave processes behind; each names this folder on its command line, some with escaped separators.
    const folder = root.split(/[\\/]/u).at(-1);
    spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${folder}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
    // Windows releases a killed process's handles shortly after it exits, so removal retries until then.
    for (let attempt = 0; ; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); return; }
      catch (error) { if (attempt >= 50 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error; await sleep(200); }
    }
  });
  const service = join(root, "service", "stub", "scripts", "verification");
  mkdirSync(service, { recursive: true });
  writeFileSync(join(root, "current"), "stub");
  // A command through the Windows job relay, as the verifier starts every command; it records its own pid.
  const command = `require("node:fs").appendFileSync(${JSON.stringify(join(root, "commands.log"))}, process.pid + "\\n"); setInterval(() => {}, 1000);`;
  // A stub service: waits for go, starts a child and a relayed command, records its pids, and heartbeats.
  writeFileSync(join(service, "queue-service.mjs"), `
    import { spawn } from "node:child_process";
    import { appendFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { run } = await import(${JSON.stringify(new URL("./process.mjs", import.meta.url).href)});
    const root = process.argv[process.argv.indexOf("--root") + 1];
    for await (const chunk of process.stdin) if (String(chunk).includes("go")) break;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    run(process.execPath, ["-e", ${JSON.stringify(command)}], { quietStdout: true }).catch(() => {});
    // Store PowerShell escapes every job, so a run stopped mid-test would leave this supervisor restarting stubs.
    setInterval(() => { try { process.kill(${process.pid}, 0); } catch (error) { if (error.code === "ESRCH") { try { process.kill(process.ppid); } catch {} process.exit(0); } } }, 1000);
    appendFileSync(join(root, "pids.log"), process.pid + " " + child.pid + "\\n");
    setInterval(() => writeFileSync(join(root, "service.json"), "{}"), 1000);
  `);
  const supervisor = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", new URL("./queue-supervisor.ps1", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"), "-Root", root], { stdio: "ignore", windowsHide: true });
  const lines = name => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").split(/\r?\n/u).filter(line => /^\d+( \d+)?$/u.test(line)) : [];
  // Each service generation records its pid and its child's, and its command records its own.
  const generation = n => waitFor(() => {
    const service = lines("pids.log")[n];
    const command = lines("commands.log")[n];
    return service && command ? [...service.split(" ").map(Number), Number(command)] : null;
  }, `the supervisor must start service generation ${n + 1}`, 60_000);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  const first = await generation(0);
  assert.ok(first.every(alive));
  // Kill only the service, as a crash would: the supervisor closes its job, and the relay stops the command.
  spawnSync("taskkill.exe", ["/PID", String(first[0]), "/F"], { windowsHide: true });
  await waitFor(() => first.every(pid => !alive(pid)), "everything the dead service started must stop", 15_000);
  const second = await generation(1);
  assert.ok(second.every(alive));
  // Stop only the supervisor, as a crash or Task Scheduler would; its job takes the rest.
  spawnSync("taskkill.exe", ["/PID", String(supervisor.pid), "/F"], { windowsHide: true });
  await waitFor(() => second.every(pid => !alive(pid)), "the service and everything it started must stop with the supervisor", 15_000);
});

test("a Mac finds its queue only once the service is installed there, and never for a run with its own slot root", t => {
  const home = mkdtempSync(join(tmpdir(), "dohc-queue-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const mac = { platform: "darwin", home };
  const root = join(home, "dev", "worktrees", "_verification");
  assert.equal(queueRoot({}, mac), null, "an ordinary Mac verifies inline");
  mkdirSync(join(home, "dev", "worktrees", ".locks"), { recursive: true });
  mkdirSync(root);
  assert.equal(queueRoot({}, mac), null, "a shared Mac without the service verifies inline");
  writeFileSync(join(root, "current"), "0123456789ab");
  assert.equal(queueRoot({}, mac), root, "the queue sits beside the slot root, as on Windows");
  assert.equal(queueRoot({ DOHC_BUILD_SLOT_ROOT: join(home, "trial") }, mac), null, "a trial or a test verifies inline");
  assert.equal(queueRoot({ CI: "true" }, mac), null);
  assert.equal(queueRoot({ DOHC_VERIFICATION_QUEUE_ROOT: join(home, "elsewhere") }, mac), join(home, "elsewhere"));
  assert.equal(queueRoot({}, { platform: "linux", home }), null);
  // Uninstall removes the marker, and the Mac verifies inline again.
  rmSync(join(root, "current"));
  assert.equal(queueRoot({}, mac), null);
});

test("the Mac's LaunchAgents run the supervisor in the login session and submit the nightly run at 03:07", t => {
  // A name only, never created: Windows forbids < and > in a file name.
  const root = join("/Users", "a & b <c>", "_verification");
  const xml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const service = launchAgentDefinition(root, "/opt/homebrew/bin:/usr/bin");
  assert.match(service, /<key>Label<\/key><string>app\.dohc\.verification-queue<\/string>/u);
  assert.match(service, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/u, "Electron needs the login session's display");
  assert.match(service, /<key>RunAtLoad<\/key><true\/>\s*<key>KeepAlive<\/key><true\/>/u, "launchd starts it at login and whenever it exits");
  assert.match(service, /<key>ProcessType<\/key><string>Interactive<\/string>/u, "a gate runs without launchd's limits for other jobs");
  assert.ok(service.includes(`<array><string>/usr/bin/env</string><string>node</string><string>${xml(join(root, "supervisor.mjs"))}</string><string>--root</string><string>${xml(root)}</string></array>`));
  assert.match(service, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/u, "the service finds the installer's tools");
  assert.doesNotMatch(service, /DOHC_VERIFICATION_QUEUE_ROOT/u, "a lane's tests inherit the service's environment, and their nested verifiers must not find the live queue");
  const nightly = nightlyAgentDefinition(root, "/usr/bin");
  assert.match(nightly, /<key>Label<\/key><string>app\.dohc\.verification-nightly<\/string>/u);
  assert.ok(nightly.includes(`<key>DOHC_VERIFICATION_QUEUE_ROOT</key><string>${xml(root)}</string>`), "the nightly submission names its queue, as nightly.ps1 does");
  assert.match(nightly, /<key>StartCalendarInterval<\/key><dict><key>Hour<\/key><integer>3<\/integer><key>Minute<\/key><integer>7<\/integer><\/dict>/u);
  assert.doesNotMatch(nightly, /KeepAlive|RunAtLoad/u);
  assert.match(nightly, /sleep 600/u, "a failed submission tries again every 10 minutes");
  // Only a Mac has plutil, and only a POSIX shell runs the nightly script.
  if (process.platform !== "darwin") return;
  const dir = mkdtempSync(join(tmpdir(), "dohc queue & agents "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of [["service.plist", launchAgentDefinition(dir, process.env.PATH)], ["nightly.plist", nightlyAgentDefinition(dir, process.env.PATH)]]) {
    writeFileSync(join(dir, name), text);
    const lint = spawnSync("plutil", ["-lint", join(dir, name)], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
  // The nightly script runs the installed service's queue.mjs, whatever the root's name; a pass ends it at once.
  const script = nightlyAgentDefinition(dir, process.env.PATH).match(/<string>\/bin\/sh<\/string><string>-c<\/string><string>(.*?)<\/string>/su)[1]
    .replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
  const queue = join(dir, "service", "0123456789ab", "scripts", "verification");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(dir, "current"), "0123456789ab\n");
  writeFileSync(join(queue, "queue.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(dir, "ran"))}, process.argv.slice(2).join(" ") + " " + process.env.DOHC_VERIFICATION_QUEUE_ROOT);`);
  // A failed first attempt would wait ten minutes for the next one.
  const ran = spawnSync("/bin/sh", ["-c", script, dir], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, DOHC_VERIFICATION_QUEUE_ROOT: dir } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(readFileSync(join(dir, "ran"), "utf8"), `nightly ${dir}`);
});

test("the LaunchAgents keep the installer's PATH without the folders pnpm adds for its script", () => {
  const checkout = "/Users/ice/dev/worktrees/mac-queue";
  const path = [`${checkout}/node_modules/.bin`, "/Users/ice/.bun/install/global/node_modules/pnpm/dist/node-gyp-bin", `${checkout}/node_modules/.bin`,
    "/opt/homebrew/bin", "", "/usr/bin", "/opt/homebrew/bin", "/Users/ice/.cargo/bin", `${checkout}/apps/desktop/node_modules/.bin/`, "node_modules/.bin", ".", "bin", "~/bin"].join(":");
  assert.equal(launchPath(path), "/opt/homebrew/bin:/usr/bin:/Users/ice/.cargo/bin", "a later checkout at that path would supply tools to every run, and a relative entry names a folder in the lane");
  assert.doesNotMatch(launchAgentDefinition("/q", launchPath(path)) + nightlyAgentDefinition("/q", launchPath(path)), /node_modules|node-gyp-bin/u);
});

test("install loads both LaunchAgents into the login session, a loaded supervisor keeps its definition until restart, and uninstall unloads and removes them", { skip: process.platform === "win32" && "launchd is macOS-only" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-queue-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "_verification");
  const domain = `gui/${process.getuid()}`;
  const file = label => join(dir, `${label}.plist`);
  const loaded = new Set();
  // bootout returns while the job still stops: launchd still lists it for two more looks.
  const stopping = new Map();
  const calls = [];
  const command = args => {
    if (args[0] !== "print") calls.push(args);
    const label = args[0] === "bootstrap" ? basename(args[2], ".plist") : args[1].split("/").at(-1);
    if (args[0] === "print") {
      if (stopping.get(label) > 0) { stopping.set(label, stopping.get(label) - 1); return { status: 0 }; }
      return { status: loaded.has(label) ? 0 : 113, stderr: "Could not find service" };
    }
    // A bootstrap while launchd still lists the job fails, as launchd's does.
    if (args[0] === "bootstrap") { if (loaded.has(label) || stopping.get(label) > 0) return { status: 5, stderr: "Bootstrap failed: 5: Input/output error" }; loaded.add(label); return { status: 0 }; }
    if (loaded.delete(label)) stopping.set(label, 2);
    return { status: 0 };
  };
  const take = () => calls.splice(0);
  assert.equal(await registerLaunchAgents(root, { dir, command, path: "/usr/bin" }), false);
  assert.deepEqual(take(), [["bootstrap", domain, file(launchAgentLabel)], ["bootstrap", domain, file(nightlyAgentLabel)]]);
  assert.equal(readFileSync(file(launchAgentLabel), "utf8"), launchAgentDefinition(root, "/usr/bin"));
  // An upgrade that changes the supervisor's definition never stops a run: restart applies it. The nightly agent
  // loads again at once, once launchd has let the old one go.
  assert.equal(await registerLaunchAgents(root, { dir, command, path: "/opt/homebrew/bin:/usr/bin" }), true);
  assert.deepEqual(take(), [["bootout", `${domain}/${nightlyAgentLabel}`], ["bootstrap", domain, file(nightlyAgentLabel)]]);
  assert.equal(await registerLaunchAgents(root, { dir, command, path: "/opt/homebrew/bin:/usr/bin" }), false, "the same definition changes nothing");
  take();
  const stopped = [];
  const stop = async path => { stopped.push(path); return []; };
  await reloadLaunchAgent(root, { dir, command, stop });
  assert.deepEqual(take(), [["bootout", `${domain}/${launchAgentLabel}`], ["bootstrap", domain, file(launchAgentLabel)]]);
  assert.deepEqual(stopped, [root], "a restart stops what a supervisor launchd killed left behind before another starts");
  // A service that is not running is started through launchd, never by hand.
  assert.deepEqual(startCommand("darwin"), ["launchctl", ["kickstart", `${domain}/${launchAgentLabel}`]]);
  assert.deepEqual(startCommand("win32"), ["schtasks.exe", ["/run", "/tn", "dohc-verification-queue"]]);
  await unregisterLaunchAgents(root, { dir, command, stop });
  assert.deepEqual(take(), [["bootout", `${domain}/${launchAgentLabel}`], ["bootout", `${domain}/${nightlyAgentLabel}`]]);
  assert.deepEqual([loaded.size, readdirSync(dir)], [0, []]);
  assert.deepEqual(stopped, [root, root]);
  // A LaunchAgent launchd keeps loaded is an error, and its definition stays.
  await registerLaunchAgents(root, { dir, command, path: "/usr/bin" });
  await assert.rejects(unregisterLaunchAgents(root, { dir, command: args => args[0] === "bootout" ? { status: 5 } : command(args), stop, waitMs: 500 }), /launchd did not unload app\.dohc\.verification-queue/u);
  assert.ok(existsSync(file(launchAgentLabel)));
});

test("a Mac counts the memory it can reclaim at once as free, as Windows counts its standby memory", () => {
  const near = (a, b) => Math.abs(a - b) < 0.5;
  assert.ok(near(freeMemoryGb("darwin"), process.availableMemory() / 1024 ** 3));
  assert.ok(near(freeMemoryGb("win32"), freemem() / 1024 ** 3), "Windows keeps os.freemem()");
});

test("a run on a Mac holds off idle sleep until it ends", { skip: process.platform !== "darwin" && "caffeinate is macOS-only" }, async t => {
  assert.equal(holdAwake("win32")(), undefined, "elsewhere nothing is held");
  const holder = () => spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout.split("\n")
    .find(line => line.trim().endsWith(`caffeinate -i -w ${process.pid}`))?.trim().split(/\s+/u)[0] ?? null;
  const letSleep = holdAwake("darwin");
  t.after(letSleep);
  const pid = await waitFor(holder, "caffeinate must hold the assertion");
  await waitFor(() => spawnSync("pmset", ["-g", "assertions"], { encoding: "utf8" }).stdout.includes(`pid ${pid}(caffeinate)`), "macOS must list the assertion");
  letSleep();
  await waitFor(() => !holder(), "the assertion must end with the run");
});

test("the supervisor takes a service instance's processes by its marker, its record, and descent, and never a stranger's", () => {
  const start = second => `Mon Oct 19 10:00:${String(second).padStart(2, "0")} 2026`;
  const table = processTable([
    [1, 0, "Ss", 0], [200, 1, "Ss", 3], [201, 200, "S", 4], [300, 1, "S", 5], [400, 1, "Ss", 6], [500, 1, "Ss", 8], [600, 1, "Z", 9],
  ].map(([pid, ppid, stat, second]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${stat.padEnd(4)} ${start(second)}`).join("\n"));
  assert.deepEqual(table.find(row => row.pid === 200), { pid: 200, ppid: 1, zombie: false, start: start(3) });
  // 200 carries the marker and its parent died; 201 is its child, an Apple program; 300 is recorded; 500 is a recorded pid that is now another process.
  assert.deepEqual([...members(table, new Set([200, 1]), new Map([[300, start(5)], [500, start(59)]])).keys()].sort((a, b) => a - b), [200, 201, 300]);
  assert.deepEqual([...members(table, new Set([200])).keys()].sort((a, b) => a - b), [200, 201], "the marker alone finds what the record missed");
  // lstart pads a one-digit day with a space; a start time reads the same either way.
  assert.equal(processTable("    9     1 S    Thu Oct  1 10:00:00 2026")[0].start, "Thu Oct 1 10:00:00 2026");
});

/** A fake process table of `[pid, ppid, second]` rows, as ps prints it. */
const fakeTable = rows => processTable(rows.map(([pid, ppid, second]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} S    Mon Oct 19 10:00:${String(second).padStart(2, "0")} 2026`).join("\n"));

test("the supervisor kills a process once it is stopped and still the same process, even one that dropped its marker, and lets a reused pid go on", async () => {
  const signals = [];
  const killed = new Set();
  let stopping = false;
  // Pid 200 is marked when first read, and another process by the time it is stopped. Pid 300 ran another program
  // without the marker, which keeps its pid and start. Pid 400 and its child stay themselves. Pid 600 exits first.
  const table = () => fakeTable([[200, 1, stopping ? 9 : 3], [300, 1, 4], [400, 1, 5], [401, 400, 6], [600, 1, 7]].filter(([pid]) => !killed.has(pid) && !(pid === 600 && stopping)));
  const marked = () => new Set(stopping ? [400] : [200, 300, 400, 600]);
  const signal = (pid, name) => {
    if (pid === 600) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    signals.push(`${name} ${pid}`);
    if (name === "SIGSTOP") stopping = true;
    if (name === "SIGKILL") killed.add(pid);
  };
  assert.deepEqual((await stopProcesses({ table, marked, signal })).sort(), [300, 400, 401]);
  assert.deepEqual(signals, ["SIGSTOP 200", "SIGSTOP 300", "SIGSTOP 400", "SIGSTOP 401", "SIGCONT 200", "SIGKILL 300", "SIGKILL 400", "SIGKILL 401"]);
});

test("a stop that fails midway kills the processes it confirmed and lets the others go on, so none stays stopped", async () => {
  const signals = [];
  let reads = 0;
  // Round one finds and confirms 400; round two finds its new child 401, then the read that would confirm it fails.
  const table = () => {
    reads += 1;
    if (reads === 4) throw new Error("ps timed out");
    return fakeTable(reads >= 3 ? [[400, 1, 5], [401, 400, 6]] : [[400, 1, 5]]);
  };
  await assert.rejects(stopProcesses({ table, marked: () => new Set([400]), signal: (pid, name) => { signals.push(`${name} ${pid}`); } }), /ps timed out/u);
  assert.deepEqual(signals, ["SIGSTOP 400", "SIGSTOP 401", "SIGCONT 401", "SIGKILL 400"]);
});

test("the helper finds an exact environment entry, never one in the arguments, inside another value, or in an Apple program's hidden environment", { skip: process.platform !== "darwin" && "the helper reads macOS process arguments" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-queue-helper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  buildEnvHelper(envHelper(dir));
  const marker = requestMarker("test-helper-1");
  const idle = (args, env = {}, command = process.execPath) => spawn(command, args, { stdio: "ignore", env: { ...process.env, ...env } });
  const exact = idle(["-e", "setInterval(() => {}, 1000)"], { [requestVariable]: "test-helper-1" });
  // Node zero-fills the rest of its arguments' area when it sets its title, as pnpm does on its native-build path.
  const titled = idle(["-e", "process.title = 'x'; setInterval(() => {}, 1000)", "padding", "more padding"], { [requestVariable]: "test-helper-1" });
  const decoys = [
    idle(["-e", "setInterval(() => {}, 1000)", marker]),
    idle(["-e", "setInterval(() => {}, 1000)"], { OTHER: `x ${marker} y` }),
    idle(["-e", "setInterval(() => {}, 1000)"], { [requestVariable]: "test-helper-10" }),
    idle(["600"], { [requestVariable]: "test-helper-1" }, "/bin/sleep"),
    idle(["-c", `while :; do pgrep -f ${marker} > /dev/null; sleep 0.2; done`], {}, "/bin/zsh"),
  ];
  t.after(() => { for (const child of [exact, titled, ...decoys]) child.kill("SIGKILL"); });
  await Promise.all([exact, titled, ...decoys].map(child => once(child, "spawn")));
  await waitFor(() => spawnSync("ps", ["-o", "command=", "-p", String(titled.pid)], { encoding: "utf8" }).stdout.trim() === "x", "the titled process must set its title");
  assert.deepEqual([...markedPids(marker, envHelper(dir))].sort((a, b) => a - b), [exact.pid, titled.pid].sort((a, b) => a - b));
  assert.throws(() => buildEnvHelper(join(dir, "broken"), join(dir, "missing.c")), /cc could not build the procenv helper.*xcode-select --install/su);
});

test("an attempt's end stops what its verifier left running, and its attempt and the history say how many", async t => {
  const swept = [];
  const { root, request, settled } = harness(t, { strays: async (id, queue) => { swept.push([id, queue]); return swept.length === 1 ? 2 : 0; } });
  const passed = await settled((await request("pass")).id);
  const failed = await settled((await request("fail")).id);
  assert.deepEqual(swept, [[passed.id, root], [failed.id, root]], "a pass and a failure are both swept");
  assert.deepEqual([passed.status.attempts[0].strays, failed.status.attempts[0].strays], [2, 0]);
  const history = readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "finished");
  assert.deepEqual(history.map(event => [event.id, event.strays]), [[passed.id, 2], [failed.id, 0]]);
});

test("an attempt keeps its lane until what it left running has stopped, and status says the lane is held meanwhile", async t => {
  const events = [];
  let failures = 2;
  const strays = async id => { events.push(`sweep ${id}`); if (failures-- > 0) throw new Error("processes 4242 did not stop after SIGKILL"); return 1; };
  const holdLane = async ({ entry }) => { events.push(`lane ${entry.id}`); return { release() { events.push(`release ${entry.id}`); } }; };
  const { root, request, settled } = harness(t, { strays, holdLane, strayRetryMs: 500, heartbeatMs: 20 });
  const first = await request("pass");
  const second = await request("pass", { branch: "refs/heads/second" });
  await waitFor(() => /^held: could not stop what the run left running \(processes 4242 did not stop after SIGKILL\)/u.test(readJson(queuePaths(root).service)?.running?.[0]?.phase ?? "") || null, "status must say the lane is held");
  assert.ok(!events.includes(`lane ${second.id}`), "the next request waits while the lane is held");
  await settled(second.id);
  assert.deepEqual(events, [`lane ${first.id}`, `sweep ${first.id}`, `sweep ${first.id}`, `sweep ${first.id}`, `release ${first.id}`, `lane ${second.id}`, `sweep ${second.id}`, `release ${second.id}`]);
  assert.equal((await settled(first.id)).status.attempts[0].strays, 1);
});

test("a request's sweep stops a daemon its verifier left in a session of its own in /, and neither another request's process nor one that only names the marker", { skip: process.platform !== "darwin" && "the sweep runs on a Mac" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-sweep-"));
  buildEnvHelper(envHelper(root));
  assert.equal(await stopStrays("any", root, "win32"), undefined, "Windows sweeps nothing: the service's job stops what it started");
  const daemon = (id, args = []) => spawn(process.execPath, ["-e", "process.chdir('/'); setInterval(() => {}, 1000)", ...args], { detached: true, stdio: "ignore", cwd: "/", env: { ...process.env, ...(id ? { [requestVariable]: id } : {}) } });
  const mine = daemon("test-request-1");
  const others = [daemon("test-request-10"), daemon(null, [requestMarker("test-request-1")])];
  t.after(() => { for (const child of [mine, ...others]) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  await Promise.all([mine, ...others].map(child => once(child, "spawn")));
  const exited = once(mine, "exit");
  assert.equal(await stopStrays("test-request-1", root), 1);
  await exited;
  assert.deepEqual(others.map(child => child.exitCode ?? child.signalCode), [null, null], "another request's process and one that names the marker in its arguments keep running");
  assert.equal(await stopStrays("test-request-1", root), 0, "nothing of the request is left");
});

test("a socket that a killed holder left is taken over, and a live holder keeps it", { skip: process.platform === "win32" && "Windows names a pipe, which dies with its holder" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dohc-queue-sock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.sock");
  const holder = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("ready"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await once(holder.stdout, "data");
  assert.equal(await holdSocket(path), null, "a live holder keeps the name");
  holder.kill("SIGKILL");
  await once(holder, "exit");
  assert.ok(existsSync(path), "a killed holder leaves its socket file behind");
  const server = await holdSocket(path);
  assert.ok(server, "the name is taken over");
  assert.equal(await holdSocket(path), null, "and held again");
  server.close();
});

test("a record names its service's processes in the boot that wrote it, and stays until they are stopped", { skip: process.platform !== "darwin" && "the supervisor runs on a Mac" }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dohc-queue-record-")));
  buildEnvHelper(envHelper(root));
  // One process the record names by its start time, and one only its marker names.
  const recorded = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  const marked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { ...process.env, [instanceVariable]: "test-instance" } });
  t.after(() => { recorded.kill("SIGKILL"); marked.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  await Promise.all([once(recorded, "spawn"), once(marked, "spawn")]);
  const start = processTable().find(row => row.pid === recorded.pid).start;
  const record = fields => writeFileSync(treePath(root), JSON.stringify({ at: Date.now(), bootedAt: Date.now() - uptimeMs(), instance: "test-instance", processes: [[recorded.pid, start]], ...fields }));
  record({ bootedAt: 0 });
  assert.deepEqual(await stopRecorded(root), [], "a record from before the computer restarted names nothing");
  record({ instance: "another", processes: [[recorded.pid, "Thu Jan 1 00:00:00 2026"]] });
  assert.deepEqual(await stopRecorded(root), [], "a pid under another start is another process, and another instance's marker is not this one");
  assert.equal(recorded.exitCode ?? recorded.signalCode ?? marked.exitCode ?? marked.signalCode, null);
  // A process that outlives SIGKILL fails the stop, and the record stays for the next try.
  record({});
  await assert.rejects(stopRecorded(root, { signal: (pid, name) => name === "SIGKILL" || process.kill(pid, name), timeoutMs: 300 }), /did not stop after SIGKILL/u);
  assert.ok(existsSync(treePath(root)));
  const exited = Promise.all([once(recorded, "exit"), once(marked, "exit")]);
  assert.deepEqual((await stopRecorded(root)).sort((a, b) => a - b), [recorded.pid, marked.pid].sort((a, b) => a - b));
  await exited;
  assert.equal(existsSync(treePath(root)), false);
});

/** A stub service under `root`: it waits for go, runs `body`, records its pid, and heartbeats until the test process exits. */
function stubService(root, body = "") {
  const service = join(root, "service", "stub", "scripts", "verification");
  mkdirSync(service, { recursive: true });
  writeFileSync(join(root, "current"), "stub");
  writeFileSync(join(service, "queue-service.mjs"), `
    import { spawn } from "node:child_process";
    import { appendFileSync, writeFileSync } from "node:fs";
    for await (const chunk of process.stdin) if (String(chunk).includes("go")) break;
    ${body}
    // A test stopped midway must not leave this service running.
    setInterval(() => { try { process.kill(${process.pid}, 0); } catch { process.exit(0); } }, 1000);
    appendFileSync(${JSON.stringify(join(root, "services.log"))}, process.pid + "\\n");
    setInterval(() => writeFileSync(${JSON.stringify(join(root, "service.json"))}, "{}"), 1000);
  `);
}

const logged = (root, name) => existsSync(join(root, `${name}.log`)) ? readFileSync(join(root, `${name}.log`), "utf8").split("\n").filter(Boolean).map(Number) : [];
// Zombies hold a pid but no longer run.
const running = pid => { const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(); return stat !== "" && !stat.startsWith("Z"); };

test("the supervisor starts no service while the last one's processes cannot be stopped, and status says so", { skip: process.platform !== "darwin" && "the supervisor runs on a Mac" }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dohc-queue-held-")));
  buildEnvHelper(envHelper(root));
  stubService(root);
  const abort = new AbortController();
  let failures = 2;
  const stopLast = async path => { if (failures-- > 0) throw new Error("processes 4242 did not stop after SIGKILL"); return stopRecorded(path); };
  const supervising = supervise(root, { stopLast, retryMs: 300, signal: abort.signal });
  t.after(async () => { abort.abort(); await supervising; for (const pid of logged(root, "services")) try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } rmSync(root, { recursive: true, force: true }); });
  await waitFor(() => existsSync(heldPath(root)), "a failed stop must hold the service");
  assert.deepEqual(logged(root, "services"), [], "no service starts while the last one's processes run");
  const status = spawnSync(process.execPath, [fileURLToPath(new URL("./queue.mjs", import.meta.url)), "status"], { env: { ...process.env, DOHC_VERIFICATION_QUEUE_ROOT: root }, encoding: "utf8" });
  assert.match(status.stdout, /^held since \S+: the supervisor could not stop the last service's processes \(processes 4242 did not stop after SIGKILL\)\. No service starts until they stop/mu);
  assert.match(readFileSync(join(root, "supervisor.log"), "utf8"), /could not stop everything the last service left: processes 4242 did not stop after SIGKILL\. No service starts until they stop; trying again in 0 s/u);
  const [service] = await waitFor(() => logged(root, "services").length ? logged(root, "services") : null, "the service starts once the stop succeeds");
  assert.equal(existsSync(heldPath(root)), false, "status no longer says held");
  assert.ok(running(service));
  abort.abort();
  await supervising;
  assert.equal(running(service), false, "a stopped supervisor stops its service");
});

test("on a Mac, the supervisor stops everything a dead service started, whatever its session, parent, or folder, and a new supervisor stops what a killed one left", { skip: process.platform !== "darwin" && "launchd supervises the service on a Mac only" }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dohc-queue-supervisor-")));
  buildEnvHelper(envHelper(root));
  const log = name => join(root, `${name}.log`);
  // Each helper records its pid in the log it is given, and runs until it is stopped.
  writeFileSync(join(root, "idle.cjs"), `require("node:fs").appendFileSync(process.argv[2], process.pid + "\\n"); setInterval(() => {}, 1000);`);
  // A command as the verifier starts one, in a session of its own, starts another session, as Playwright starts Electron.
  writeFileSync(join(root, "command.cjs"), `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(root, "idle.cjs"))}, ${JSON.stringify(log("grandchildren"))}], { detached: true, stdio: "ignore" });
    require("node:fs").appendFileSync(${JSON.stringify(log("commands"))}, process.pid + "\\n"); setInterval(() => {}, 1000);`);
  // A daemon: a child that calls setsid, works in /, and outlives its parent, which exits before any poll can see it.
  writeFileSync(join(root, "daemon.cjs"), `require("node:child_process").spawn(process.execPath, ["-e", "process.chdir('/'); require('node:fs').appendFileSync(" + ${JSON.stringify(JSON.stringify(log("daemons")))} + ", process.pid + '\\\\n'); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", cwd: "/" }).unref();`);
  stubService(root, `
    const { run } = await import(${JSON.stringify(new URL("./process.mjs", import.meta.url).href)});
    spawn(process.execPath, [${JSON.stringify(join(root, "idle.cjs"))}, ${JSON.stringify(log("children"))}], { stdio: "ignore" });
    run(process.execPath, [${JSON.stringify(join(root, "command.cjs"))}], { quietStdout: true }).catch(() => {});
    spawn(process.execPath, [${JSON.stringify(join(root, "daemon.cjs"))}], { stdio: "ignore" });
    // An Apple program hides its environment: only the record names it once its parent is gone.
    appendFileSync(${JSON.stringify(log("sleeps"))}, spawn("/bin/sleep", ["600"], { stdio: "ignore" }).pid + "\\n");
  `);
  const names = ["services", "children", "commands", "grandchildren", "daemons", "sleeps"];
  const all = () => names.flatMap(name => logged(root, name));
  // launchd starts a job in a session of its own and kills that job's group, as the test does.
  const supervisors = [];
  const startSupervisor = () => { const child = spawn(process.execPath, [fileURLToPath(new URL("./queue-supervisor.mjs", import.meta.url)), "--root", root], { detached: true, stdio: "ignore" }); supervisors.push(child); return child; };
  t.after(() => {
    for (const child of supervisors) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Gone. */ }
    for (const pid of all()) try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ }
    rmSync(root, { recursive: true, force: true });
  });
  // A generation: the service and the five processes it started, once the supervisor has recorded the Apple program.
  const generation = n => waitFor(() => {
    const found = names.map(name => logged(root, name)[n]);
    if (found.some(pid => !pid)) return null;
    const recorded = new Set((readJson(treePath(root))?.processes ?? []).map(([pid]) => pid));
    return recorded.has(found[0]) && recorded.has(found.at(-1)) ? found : null;
  }, `the supervisor must start and record service generation ${n + 1}`, 60_000);
  const first = startSupervisor();
  const zero = await generation(0);
  assert.ok(zero.every(running));
  // A crash of the service alone: the supervisor stops everything it started, then starts another.
  process.kill(zero[0], "SIGKILL");
  await waitFor(() => zero.every(pid => !running(pid)), "everything the dead service started must stop", 15_000);
  const one = await generation(1);
  // launchd kills the supervisor's group, which leaves the service and everything it started running.
  process.kill(-first.pid, "SIGKILL");
  await once(first, "exit");
  assert.ok(one.every(running), "killing the supervisor alone stops nothing below it");
  // The next supervisor stops them from the record before it starts a service.
  const second = startSupervisor();
  await waitFor(() => one.every(pid => !running(pid)), "a new supervisor must stop what the killed one left", 15_000);
  const two = await generation(2);
  // launchctl bootout sends SIGTERM: the supervisor stops everything, then exits.
  const exited = once(second, "exit");
  process.kill(second.pid, "SIGTERM");
  await exited;
  assert.deepEqual(two.filter(running), [], "the supervisor stops the service and everything it started before it exits");
  assert.match(readFileSync(join(root, "supervisor.log"), "utf8"), /stopped 6 process\(es\) that service stub started/u);
});

test("a check that fails while Docker stops answering is retried, and fails on a healthy host", async t => {
  let dockerUp = true;
  // The first run takes Docker down with it; the second runs on a healthy host.
  const { request, settled } = harness(t, { docker: async () => dockerUp, hostFails: calls => {
    dockerUp = calls > 1;
    if (!dockerUp) setTimeout(() => { dockerUp = true; }, 200);
  } });
  const failed = await request("fail-as-host-fails");
  const final = await settled(failed.id);
  assert.deepEqual(final.status.attempts.map(attempt => [attempt.outcome, attempt.cause]), [["environment", "host"], ["failed", "check"]]);
  assert.equal(final.status.state, "failed", "on a healthy host the same failure is the change's");
});

test("retries share one time budget, so a request the host keeps failing late ends in error", async t => {
  // Each slow attempt takes at least 3 s of the 5 s limit, so two leave the third less than its limit of the 10 s budget.
  // The 2 s margins hold on a host whose CPU is saturated by other gates.
  const { request, settled } = harness(t, { timeLimitMs: 5000 });
  const slow = await request("slow-host");
  const ended = await settled(slow.id);
  assert.equal(ended.status.state, "error", "only machine failures retry, so a spent budget gives no verdict");
  assert.equal(ended.status.verdict, null);
  assert.equal(ended.status.cause, "time budget");
  assert.equal(ended.status.attempts.at(-1).outcome, "error", "the attempt the budget cut short ends the request itself");
  assert.equal(ended.status.attempts.length, 3);
});

test("a cleanup that fails is retried until it succeeds, and its request is kept until then", async t => {
  let failures = 2;
  const cleaned = [];
  const { root, request, settled } = harness(t, { sweep: async ({ request: id }) => {
    if (!id) return 0;
    if (failures > 0) { failures -= 1; throw new Error("Docker is not answering"); }
    cleaned.push(id);
    return 1;
  } });
  const passed = await request("pass");
  const done = await settled(passed.id);
  assert.equal(done.status.verdict, "PASS", "a cleanup failure does not change the verdict");
  await waitFor(() => cleaned.includes(passed.id), "the cleanup must be retried");
  await waitFor(() => readJson(join(queuePaths(root).request(passed.id), "status.json"))?.cleanupPending === false, "the pending cleanup must be cleared");
});

test("a request whose containers could not be removed waits for that cleanup before it runs again", async t => {
  let cleanups = 0;
  let cleanedAfter;
  // The retry is due long before the cleanup is retried; removing the old containers during the retry would stop it.
  const { request, settled, calls } = harness(t, { cleanupRetryMs: 500, sweep: async ({ request: id }) => {
    if (!id) return 0;
    cleanups += 1;
    // The cleanup at the end of the attempt and its first retry both fail.
    if (cleanups <= 2) throw new Error("Docker is not answering");
    cleanedAfter ??= calls.length;
    return 1;
  } });
  const flaky = await request("flaky-host");
  assert.equal((await settled(flaky.id)).status.verdict, "PASS");
  assert.equal(calls.length, 2);
  assert.equal(cleanedAfter, 1, "the retry started only once the first attempt's containers were gone");
});

test("a container Docker cannot remove never holds back another request's cleanup", async t => {
  // The first request's container can never be removed; the second's cleanup fails once, then works.
  let stuck;
  let failedOnce = false;
  const { request, settled } = harness(t, { sweep: async ({ request: id }) => {
    if (!id) return 0;
    stuck ??= id;
    if (id === stuck) throw new Error("unable to remove filesystem");
    if (!failedOnce) { failedOnce = true; throw new Error("Docker is not answering"); }
    return 1;
  } });
  const first = await request("flaky-host");
  const other = await request("flaky-host", { branch: "refs/heads/other" });
  assert.equal((await settled(other.id)).status.verdict, "PASS");
  assert.equal(stuck, first.id);
});

test("a restart requested while the service checks the host starts nothing new", async t => {
  let root;
  const { root: queueRoot, request, service } = harness(t, { docker: async () => { writeFileSync(join(queuePaths(root).control, "restart"), ""); return true; } });
  root = queueRoot;
  const waiting = await request("pass");
  assert.equal(await service, 75);
  assert.equal(listRequests(root).find(candidate => candidate.id === waiting.id).status.state, "queued");
});

test("a malformed submission is rejected and the service keeps serving", async t => {
  const { root, fixture, request, settled } = harness(t);
  const key = await submit(root, { head: fixture.head, base: fixture.base, scope: "all", gates: { rust: true, js: true }, branch: null });
  const answer = await waitFor(() => readJson(join(queuePaths(root).keys, key)), "the malformed submission must be answered");
  assert.match(answer.rejected, /names no checkout/u);
  const pass = await request("pass");
  assert.equal((await settled(pass.id)).status.verdict, "PASS");
});

test("a request the host keeps failing ends in error, with no verdict", async t => {
  const { request, settled, calls } = harness(t);
  const down = await request("host-down");
  const ended = await settled(down.id);
  assert.equal(ended.status.state, "error");
  assert.equal(ended.status.verdict, null);
  assert.equal(calls.filter(call => call.id === down.id).length, 5);
});

test("cancel reaches a request still waiting for the host lane", async t => {
  const { root, request, settled } = harness(t, { holdLane: ({ signal }) => new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true })) });
  const waiting = await request("pass");
  await waitFor(() => listRequests(root).find(candidate => candidate.id === waiting.id)?.status.state === "running", "the request must reach the lane wait");
  await cancel(root, waiting.id);
  assert.equal((await settled(waiting.id)).status.state, "cancelled");
});

test("a stop decided before a restart is honored after it", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-stopping-"));
  const fixture = fixtureRepo();
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); rmSync(fixture.repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const paths = queuePaths(root);
  const id = "000000001-aaaaaa";
  await writeJson(join(paths.request(id), "request.json"), { id, sequence: 1, head: fixture.head, base: fixture.base, scope: "all", gates: { rust: true, js: false }, checkout: "hang", branch: null });
  await writeJson(join(paths.request(id), "status.json"), { state: "running", stopping: "time limit", attempts: [{ n: 1, startedAt: new Date().toISOString() }] });
  const calls = [];
  const stop = new AbortController();
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100, keepAwake: () => () => {}, strays: async () => undefined,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }),
    worker: async ({ grant }) => { calls.push(grant); }, threadOf: () => null, stop: stop.signal, log: () => {} });
  const ended = await waitFor(() => terminalStates.has(listRequests(root)[0]?.status.state) && listRequests(root)[0], "the request must end");
  stop.abort();
  await service;
  assert.equal(ended.status.state, "failed");
  assert.equal(ended.status.cause, "time limit");
  assert.deepEqual(calls, [], "a run stopped for its time limit is not run again");
});

test("a preparation that hangs is stopped at its deadline and retried, and the line moves on", async t => {
  let preparations = 0;
  const { request, settled, calls } = harness(t, { prepareLimitMs: 200, prepare: ({ signal }) => {
    preparations += 1;
    // The first preparation hangs until it is stopped; later ones finish.
    if (preparations > 1) return Promise.resolve();
    return new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }));
  } });
  const first = await request("pass");
  const second = await request("pass", { branch: "refs/heads/second" });
  const done = await settled(first.id);
  assert.deepEqual(done.status.attempts.map(attempt => [attempt.outcome, attempt.cause]), [["environment", "preparation limit"], ["passed", "pass"]]);
  assert.equal((await settled(second.id)).status.verdict, "PASS");
  assert.equal(calls.length, 2, "the hung preparation never reached the verifier");
});

test("a Rust-only request never asks Docker to clean up after it", async t => {
  const swept = [];
  const { request, settled } = harness(t, { sweep: async ({ request: id }) => { if (id) swept.push(id); return 0; } });
  const rust = await request("pass", { scope: "rust", gates: { rust: true, js: false } });
  const js = await request("pass", { branch: "refs/heads/js" });
  await settled(rust.id);
  await settled(js.id);
  assert.deepEqual(swept, [js.id]);
});

/** Run pnpm verify:queue against a private queue root, without blocking the service in this process. */
function queueCli(root, ...args) {
  return new Promise(done => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./queue.mjs", import.meta.url)), ...args], { env: { ...process.env, DOHC_VERIFICATION_QUEUE_ROOT: root }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => done({ code, stdout, stderr }));
  });
}

const historyEvents = (root, event) => readFileSync(queuePaths(root).history, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.event === event);

test("pnpm verify:queue move changes what starts next, and the history and status say who moved it and why", async t => {
  const { root, request, settled, calls } = harness(t);
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  const a = await request("pass", { branch: "refs/heads/a" });
  const b = await request("pass", { branch: "refs/heads/b" });
  const c = await request("pass", { branch: "refs/heads/c" });
  const nightly = await request("pass", { branch: "refs/heads/main", nightly: true });
  const first = await queueCli(root, "move", c.id, "--first", "--reason", "fixes the test\nthree branches fail", "--by", "Ice");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /now #3 in line, was #5/u, "the running request and the nightly stay ahead");
  const before = await queueCli(root, "move", b.id, "--before", a.id, "--reason", "main is broken until it lands");
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /now #4 in line, was #5/u);
  const status = await queueCli(root, "status");
  const line = id => status.stdout.split("\n").find(row => row.startsWith(id)) ?? "";
  assert.ok(line(c.id).includes("#3") && line(c.id).endsWith(`  (moved first by Ice (${process.cwd()}): fixes the test three branches fail)`), status.stdout);
  assert.ok(line(b.id).endsWith(`  (moved before ${a.id} by ${userInfo().username} (${process.cwd()}): main is broken until it lands)`), status.stdout);
  assert.ok(!status.stdout.includes("\nthree branches fail"), "a reason never starts a row of its own");
  assert.equal(listRequests(root).find(candidate => candidate.id === hung.id).status.state, "running", "a move never touches a running request");
  await cancel(root, hung.id);
  for (const { id } of [a, b, c, nightly]) assert.equal((await settled(id)).status.verdict, "PASS");
  assert.deepEqual(calls.map(call => call.id), [hung.id, nightly.id, c.id, b.id, a.id]);
  const moves = historyEvents(root, "moved");
  assert.deepEqual(moves.map(({ id, from, to, before, reason, by }) => ({ id, from, to, before, reason, name: by.name })), [
    { id: c.id, from: 5, to: 3, before: null, reason: "fixes the test three branches fail", name: "Ice" },
    { id: b.id, from: 5, to: 4, before: a.id, reason: "main is broken until it lands", name: null }]);
  assert.deepEqual(moves.map(({ by }) => [by.user, by.cwd]), [[userInfo().username, process.cwd()], [userInfo().username, process.cwd()]], "every mover is known by its user and checkout");
  const moved = listRequests(root).find(candidate => candidate.id === c.id);
  assert.equal(moved.request.sequence, Number(c.id.slice(0, 9)), "a move changes no id or sequence");
  assert.deepEqual([moved.status.moved.reason, moved.status.moved.by.name], ["fixes the test three branches fail", "Ice"], "the request keeps its last move");
});

test("a move of a running, finished, or unknown request is refused with a reason, and the running request keeps running", async t => {
  const { root, request, settled, calls } = harness(t);
  const done = await settled((await request("pass")).id);
  const hung = await request("hang");
  await waitFor(() => listRequests(root).find(candidate => candidate.id === hung.id)?.status.state === "running", "the hang must start");
  const waiting = await request("pass", { branch: "refs/heads/waiting" });
  const behind = await request("pass", { branch: "refs/heads/behind" });
  // The command refuses at once.
  for (const [args, message] of [
    [[hung.id, "--first"], /^Cannot move \S+: it is running\. Only a queued request can move\.$/u],
    [[done.id, "--first"], /it has already finished: passed/u],
    [["000000099-ffffff", "--first"], /^No verification request 000000099-ffffff\.$/u],
    [[waiting.id, "--before", hung.id], /before \S+: it is running\. Move it before a queued request, or use --first\.$/u],
    [[waiting.id, "--before", behind.id], /is already ahead of \S+\. A move only brings a request forward\.$/u],
  ]) {
    const result = await queueCli(root, "move", ...args, "--reason", "unblocks others");
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr.trim(), message);
  }
  for (const args of [[waiting.id, "--first"], [waiting.id, "--first", "--before", done.id, "--reason", "x"], [waiting.id, "--reason", "x"]]) {
    assert.match((await queueCli(root, "move", ...args)).stderr, /^Use move <id> --first/u, args.join(" "));
  }
  // The service makes the same checks for a move written straight to it, and answers each one.
  for (const [move, message] of [[{ id: hung.id }, /it is running/u], [{ id: done.id }, /already finished/u], [{ id: "000000099-ffffff" }, /No verification request/u], [{ id: waiting.id, reason: "" }, /needs a reason/u], [{ id: waiting.id, before: behind.id }, /already ahead/u]]) {
    const key = await requestMove(root, { reason: "unblocks others", by: { name: "test" }, ...move });
    assert.match((await waitFor(() => readJson(join(queuePaths(root).keys, key)), "the service must answer the move")).rejected, message);
  }
  assert.equal(listRequests(root).find(candidate => candidate.id === hung.id).status.state, "running", "a refused move leaves the run alone");
  assert.equal(calls.filter(call => call.id === hung.id).length, 1);
  assert.ok(!existsSync(queuePaths(root).history) || historyEvents(root, "moved").length === 0, "a refused move records no move");
  await cancel(root, hung.id);
  assert.equal((await settled(waiting.id)).status.verdict, "PASS");
  assert.equal((await settled(behind.id)).status.verdict, "PASS");
});

test("a newer commit that replaces a moved request keeps the moved place", async t => {
  const { root, request, settled, calls } = harness(t);
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  const other = await request("pass", { branch: "refs/heads/other" });
  const old = await request("pass", { branch: "refs/heads/feature" });
  const key = await requestMove(root, { id: old.id, reason: "fixes main", by: { name: "Ice", user: "ice", cwd: "C:\\w\\fix" } });
  assert.deepEqual(await waitFor(() => readJson(join(queuePaths(root).keys, key)), "the move must be applied"), { moved: old.id, from: 3, to: 2 });
  const newer = await request("pass", { branch: "refs/heads/feature" });
  assert.equal((await settled(old.id)).status.supersededBy, newer.id);
  const requests = listRequests(root);
  assert.equal(position(requests, newer.id), 2, "the newer commit keeps the moved place");
  assert.equal(movedNote(requests.find(candidate => candidate.id === newer.id).status.moved), "moved first by Ice (C:\\w\\fix): fixes main", "and the record of the move");
  await cancel(root, hung.id);
  await settled(other.id);
  await settled(newer.id);
  assert.deepEqual(calls.map(call => call.id), [hung.id, newer.id, other.id]);
});

test("a malformed move is answered and removed, and the rest of the tick still runs", async t => {
  const { root, request, settled, calls } = harness(t);
  const paths = queuePaths(root);
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  const waiting = await request("pass", { branch: "refs/heads/waiting" });
  const by = { name: "test", user: "ice", cwd: "C:\\w\\x" };
  const bad = [
    [{ id: { toString: 1 }, reason: "x", by }, /names no request to move/u],
    [{ id: waiting.id, before: "", reason: "x", by }, /--before names no request/u],
    [{ id: waiting.id, reason: "x", by: "Ice" }, /by field/u],
    [{ id: waiting.id, reason: "x", by: { name: 5 } }, /by field/u],
  ];
  const keys = [];
  for (const [move] of bad) keys.push(await requestMove(root, move));
  const array = `move-${Date.now()}-array`;
  await writeJson(join(paths.moves, `${array}.json`), [1]);
  // A move the service can use, written as a client might: its text is cleaned to one short line.
  const dirty = await requestMove(root, { id: waiting.id, reason: `fixes main\n000000001-aaaaaa  #1  all\u001b[31m ${"x".repeat(400)}`, by: { name: "Ice\nX", user: "ice", cwd: `C:\\w\\${"y".repeat(300)}` } });
  // A cancel written with them still stops the run in the same pass.
  await cancel(root, hung.id);
  assert.equal((await settled(hung.id)).status.state, "cancelled");
  for (const [index, [, message]] of bad.entries()) assert.match((await waitFor(() => readJson(join(paths.keys, keys[index])), "each malformed move must be answered")).rejected, message);
  assert.match((await waitFor(() => readJson(join(paths.keys, array)), "a move that is not an object must be answered")).rejected, /not a JSON object/u);
  assert.equal((await waitFor(() => readJson(join(paths.keys, dirty)), "the dirty move must be answered")).moved, waiting.id);
  await waitFor(() => readdirSync(paths.moves).length === 0, "every answered move is removed");
  const { moved } = (await settled(waiting.id)).status;
  assert.equal(moved.reason, `fixes main 000000001-aaaaaa #1 all [31m ${"x".repeat(400)}`.slice(0, 300));
  assert.deepEqual([moved.by.name, moved.by.cwd.length], ["Ice X", 200]);
});

test("a move file that stays unreadable is answered and removed after a minute", async t => {
  const { root } = harness(t);
  const paths = queuePaths(root);
  mkdirSync(paths.moves, { recursive: true });
  const torn = join(paths.moves, `move-${Date.now()}-torn.json`);
  writeFileSync(torn, "{\"id\": \"0000");
  // The service reads every move in each pass, so an answer to a later one means it has seen the torn one.
  const later = await requestMove(root, { id: "000000099-ffffff", reason: "unblocks others", by: { name: "test" } });
  await waitFor(() => readJson(join(paths.keys, later)), "the later move must be answered");
  assert.ok(existsSync(torn), "a new unreadable move may still be being written");
  assert.equal(readJson(join(paths.keys, basename(torn, ".json"))), null);
  const old = new Date(Date.now() - 2 * 60_000);
  utimesSync(torn, old, old);
  assert.match((await waitFor(() => readJson(join(paths.keys, basename(torn, ".json"))), "the old unreadable move must be answered")).rejected, /could not read the move/u);
  await waitFor(() => !existsSync(torn), "the old unreadable move must be removed");
});

test("sixty moves into the same gap keep the exact order", async t => {
  const { root, request, calls } = harness(t);
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  const a = await request("pass", { branch: "refs/heads/a" });
  const b = await request("pass", { branch: "refs/heads/b" });
  const c = await request("pass", { branch: "refs/heads/c" });
  // Each move puts the last request just ahead of the one before it, into the gap behind the first.
  let [second, third] = [b.id, c.id];
  for (let n = 1; n <= 60; n += 1) {
    const key = await requestMove(root, { id: third, before: second, reason: "unblocks others", by: { name: "test" } });
    const answer = await waitFor(() => readJson(join(queuePaths(root).keys, key)), `move ${n} must be answered`);
    assert.deepEqual([answer.rejected, answer.to], [undefined, 3], `move ${n} puts ${third} at #3, behind the running request and ${a.id}`);
    [second, third] = [third, second];
  }
  const requests = listRequests(root);
  assert.deepEqual([a.id, b.id, c.id].map(id => position(requests, id)), [2, 3, 4]);
  assert.ok(requests.every(entry => Number.isInteger(entry.status.order ?? entry.request.sequence)), "every place is a whole number");
});

test("a newer commit that replaces two queued requests takes the place of the one furthest ahead", async t => {
  const { root, fixture, request, settled, calls } = harness(t);
  const paths = queuePaths(root);
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  // Two queued requests on one branch, as after a run on it was retried behind a newer commit. The later one was moved ahead.
  const moved = { at: new Date().toISOString(), before: null, reason: "fixes main", by: { name: "Ice", user: "ice", cwd: "C:\\w\\fix" } };
  for (const [id, status] of [["000000101-aaaaaa", { order: 50 }], ["000000102-bbbbbb", { order: 40, moved }]]) {
    await writeJson(join(paths.request(id), "request.json"), { id, sequence: Number(id.slice(0, 9)), head: fixture.head, base: fixture.base, scope: "all", gates: { rust: true, js: true }, checkout: "pass", branch: "refs/heads/feature" });
    await writeJson(join(paths.request(id), "status.json"), { state: "queued", attempts: [], ...status });
  }
  const newer = await request("pass", { branch: "refs/heads/feature" });
  for (const id of ["000000101-aaaaaa", "000000102-bbbbbb"]) assert.equal((await settled(id)).status.supersededBy, newer.id);
  const { status } = listRequests(root).find(candidate => candidate.id === newer.id);
  assert.deepEqual([status.order, status.moved], [40, moved]);
  await cancel(root, hung.id);
  assert.equal((await settled(newer.id)).status.verdict, "PASS");
});

test("a paused queue starts nothing, lets the run in flight finish, and moves again on resume", async t => {
  const { root, request, settled, calls, finishHeld } = harness(t, { lanes: () => 2, heartbeatMs: 50 });
  const state = id => listRequests(root).find(candidate => candidate.id === id).status.state;
  const status = () => pauseStatus(root, serviceState(root), 0);
  const running = await request("held");
  await waitFor(() => calls.find(call => call.id === running.id), "the first run must start");
  assert.equal((await pauseQueue(root, { reason: "updating drivers" })).changed, true);
  const waiting = await request("pass");
  // A later acceptance means the service has decided about the waiting request since it arrived.
  await request("pass", { branch: "refs/heads/later" });
  assert.equal(state(waiting.id), "queued", "a free lane takes nothing while paused");
  await waitFor(() => /^paused since \S+ \(updating drivers\): 1 running, no new runs start$/u.test(status()), "status must count the run in flight");
  finishHeld();
  assert.equal((await settled(running.id)).status.verdict, "PASS", "the run in flight finishes normally");
  await waitFor(() => status() === "paused and idle: safe to restart", "status must say idle once the run ends");
  await request("pass", { branch: "refs/heads/after-idle" });
  assert.equal(state(waiting.id), "queued", "an idle paused queue still starts nothing");
  assert.equal((await resumeQueue(root)).reason, "updating drivers");
  assert.equal((await settled(waiting.id)).status.verdict, "PASS", "resume starts the line in its order");
});

test("pausing records no failure and changes no request", async t => {
  const { root, request, settled } = harness(t, { heartbeatMs: 50 });
  const paths = queuePaths(root);
  await pauseQueue(root, { reason: "maintenance" });
  const waiting = await request("pass");
  const accepted = readFileSync(join(paths.request(waiting.id), "status.json"), "utf8");
  await request("pass", { branch: "refs/heads/later" });
  const record = await waitFor(() => { const beat = readJson(paths.service); return beat?.paused?.reason === "maintenance" && beat; }, "the heartbeat must show the pause");
  assert.equal(readFileSync(join(paths.request(waiting.id), "status.json"), "utf8"), accepted, "the waiting request's status is untouched");
  assert.deepEqual({ ...JSON.parse(accepted), updatedAt: undefined }, { state: "queued", attempts: [], updatedAt: undefined });
  assert.deepEqual([record.health.reason, record.health.pausedUntil], [null, null], "a pause is not a machine failure");
  assert.deepEqual(readFileSync(paths.history, "utf8").trim().split("\n").map(line => JSON.parse(line).event), ["accepted", "accepted"]);
  await resumeQueue(root);
  const passed = await settled(waiting.id);
  assert.deepEqual(passed.status.attempts.map(attempt => attempt.outcome), ["passed"], "the pause left no failed attempt");
});

test("a computer restart holds the line until resume; a service restart or a first start does not", async t => {
  // A first start has no heartbeat to compare, even with a boot just now.
  const { root, request, settled, restart } = harness(t, { bootedAt: Date.now() });
  const state = id => listRequests(root).find(candidate => candidate.id === id).status.state;
  const lastBeat = () => Date.parse(readJson(queuePaths(root).service).heartbeatAt);
  assert.equal((await settled((await request("pass", { branch: "refs/heads/first" })).id)).status.verdict, "PASS");
  assert.equal(readPause(root), null, "a first start holds nothing");
  // The supervisor or an upgrade restarts the service within one boot.
  await restart({ bootedAt: lastBeat() - 60 * 60_000 });
  assert.equal(readPause(root), null, "a service restart holds nothing");
  assert.equal((await settled((await request("pass", { branch: "refs/heads/same-boot" })).id)).status.verdict, "PASS");
  // The computer booted after the last heartbeat.
  await restart({ bootedAt: lastBeat() + 1 });
  assert.equal(readPause(root)?.reason, "the computer restarted");
  const waiting = await request("pass", { branch: "refs/heads/after-boot" });
  await request("pass", { branch: "refs/heads/later" });
  assert.equal(state(waiting.id), "queued", "no run starts after the computer restarts");
  // The pause outlasts a service restart.
  await restart({ bootedAt: 0 });
  assert.equal(readPause(root)?.reason, "the computer restarted");
  await request("pass", { branch: "refs/heads/later-still" });
  assert.equal(state(waiting.id), "queued", "the pause survives a service restart");
  await resumeQueue(root);
  assert.equal((await settled(waiting.id)).status.verdict, "PASS");
});

test("status says paused and idle only when nothing runs, counting inline gates", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-pause-"));
  const slots = mkdtempSync(join(tmpdir(), "dohc-queue-pause-slots-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(slots, { recursive: true, force: true }); });
  assert.equal(pauseStatus(root, { record: null, alive: false }, 0), null, "a queue that is not paused");
  const { pause } = await pauseQueue(root, { reason: "restarting" });
  assert.deepEqual(await pauseQueue(root, { reason: "again" }), { pause, changed: false }, "pausing again keeps the first record");
  const beat = (running, paused = pause) => ({ record: { paused, running: running.map(id => ({ id })) }, alive: true });
  const busy = count => `paused since ${pause.at} (restarting): ${count} running, no new runs start`;
  assert.equal(pauseStatus(root, beat([]), 0), "paused and idle: safe to restart");
  assert.equal(pauseStatus(root, beat(["a", "b"]), 0), busy(2));
  assert.equal(pauseStatus(root, beat([]), 1), busy(1), "an inline gate holding a lane is running");
  assert.equal(pauseStatus(root, beat([], null), 0), busy(0), "a service that has not seen the pause may still start a run");
  assert.equal(pauseStatus(root, { record: beat(["a"]).record, alive: false }, 0), "paused and idle: safe to restart", "a stopped service's runs stopped with it");
  // The service's own runs hold lanes too; only the other holders are inline gates.
  for (const [n, purpose] of [[1, queueLanePurpose], [2, "PR verification"]]) {
    mkdirSync(join(slots, `verification-slot-${n}`));
    writeFileSync(join(slots, `verification-slot-${n}`, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString(), purpose }));
  }
  assert.equal(inlineRuns({ DOHC_BUILD_SLOT_ROOT: slots }), 1);
  assert.deepEqual(await resumeQueue(root), pause);
  assert.equal(await resumeQueue(root), null, "resuming a moving queue changes nothing");
  assert.equal(pauseStatus(root, beat([]), 0), null);
});

/** A T3 database holding `threads`, each [id, title, payload]. */
function t3Database(t, threads) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-t3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "statev2.sqlite");
  const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(path);
  db.exec("create table orchestration_v2_projection_threads (thread_id text, title text, payload_json text, updated_at text, deleted_at text)");
  for (const [id, title, payload] of threads) db.prepare("insert into orchestration_v2_projection_threads values (?, ?, ?, ?, null)").run(id, title, JSON.stringify(payload), new Date().toISOString());
  db.close();
  return path;
}

test("the service records each request's owner when it accepts it: the thread a person started, counting a subagent's under it, else --owner, else the checkout", async t => {
  const path = t3Database(t, [
    ["t-person", "Ship sync", { createdBy: "user", branch: "feat/sync", lineage: { parentThreadId: null, rootThreadId: "t-person" } }],
    ["t-sub", "Review sync", { createdBy: "agent", pullRequests: [{ number: 9, snapshot: { headBranch: "fix/sync-review" } }],
      lineage: { parentThreadId: "t-person", relationshipToParent: "subagent", rootThreadId: "t-person" } }],
  ]);
  const queue = harness(t, { threadOf: threadDirectory({ path }) });
  const recorded = async ({ root, request }, fields) => readJson(join(queuePaths(root).request((await request("pass", fields)).id), "request.json"));
  const person = { key: "thread:t-person", title: "Ship sync", source: "thread" };
  assert.deepEqual((await recorded(queue, { branch: "refs/heads/feat/sync" })).owner, person);
  const sub = await recorded(queue, { branch: "refs/heads/fix/sync-review", ownerName: "Sol" });
  assert.deepEqual(sub.owner, person, "a subagent's work belongs to the thread a person started, whatever --owner says");
  assert.equal("ownerName" in sub, false, "the request keeps the owner, not the name it was submitted with");
  assert.deepEqual((await recorded(queue, { branch: "refs/heads/unknown", ownerName: "Sol" })).owner, { key: "flag:sol", title: "Sol", source: "flag" });
  assert.deepEqual((await recorded(queue, { branch: "refs/heads/unknown-too" })).owner, { key: "checkout:pass", title: "pass", source: "checkout" });
  const missing = harness(t, { threadOf: threadDirectory({ path: join(queue.root, "no-t3.sqlite") }) });
  assert.deepEqual((await recorded(missing, { branch: "refs/heads/feat/sync" })).owner, { key: "checkout:pass", title: "pass", source: "checkout" },
    "without T3's database the request is still accepted, owned by its checkout");
});

test("one lane takes turns between two owners with unequal backlogs", async t => {
  const { root, request, settled, calls } = harness(t);
  // Paused, so the whole line is waiting before the first run starts.
  await pauseQueue(root, { reason: "submitting the line" });
  const owned = async (name, n) => (await request("pass", { branch: `refs/heads/${name}-${n}`, ownerName: name })).id;
  const ann = [await owned("ann", 1), await owned("ann", 2), await owned("ann", 3)];
  const bob = [await owned("bob", 1), await owned("bob", 2)];
  await resumeQueue(root);
  for (const id of [...ann, ...bob]) assert.equal((await settled(id)).status.verdict, "PASS");
  assert.deepEqual(calls.map(call => call.id), [ann[0], bob[0], ann[1], bob[1], ann[2]]);
});

test("two free lanes go to two owners, not to one owner's first two requests", async t => {
  const { root, request, settled, calls, finishHeld } = harness(t, { lanes: () => 2 });
  await pauseQueue(root, { reason: "submitting the line" });
  const owned = async (name, n) => (await request("held", { branch: `refs/heads/${name}-${n}`, ownerName: name })).id;
  const [a1, a2, b1] = [await owned("ann", 1), await owned("ann", 2), await owned("bob", 1)];
  await resumeQueue(root);
  await waitFor(() => calls.length >= 2, "both lanes must start");
  assert.deepEqual(calls.map(call => call.id).sort(), [a1, b1].sort());
  finishHeld();
  await waitFor(() => calls.length >= 3, "Ann's second request must start");
  finishHeld();
  for (const id of [a1, a2, b1]) assert.equal((await settled(id)).status.verdict, "PASS");
});

test("a newer commit keeps the owner and the place of the request it replaces", async t => {
  const { root, request, settled, calls, finishHeld } = harness(t);
  // Cat's run holds the lane, so Cat has had a turn and Ann and Bob have not.
  const running = await request("held", { ownerName: "cat" });
  await waitFor(() => calls.find(call => call.id === running.id), "Cat's run must start");
  const old = await request("pass", { branch: "refs/heads/feature", ownerName: "ann" });
  const other = await request("pass", { branch: "refs/heads/other", ownerName: "bob" });
  assert.equal(position(listRequests(root), old.id), 2);
  const newer = await request("pass", { branch: "refs/heads/feature", ownerName: "cat" });
  assert.equal((await settled(old.id)).status.supersededBy, newer.id);
  const requests = listRequests(root);
  assert.deepEqual(requests.find(candidate => candidate.id === newer.id).request.owner, { key: "flag:ann", title: "ann", source: "flag" });
  assert.equal(position(requests, newer.id), 2, "as Ann's request it goes before Bob's; as Cat's it would wait behind it");
  finishHeld();
  for (const id of [newer.id, other.id]) assert.equal((await settled(id)).status.verdict, "PASS");
  assert.deepEqual(calls.map(call => call.id), [running.id, newer.id, other.id]);
});

test("pnpm verify:pr prints the owner the service recorded, and how to name one when only the checkout owns the request", async t => {
  const { root, fixture } = harness(t);
  // Until this service beats, verify:pr would start the host's installed service instead.
  await waitFor(() => serviceState(root).alive, "the service must beat");
  const owner = async fields => {
    fixture.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "owner");
    const lines = [];
    await verifyThroughQueue({ root, detach: true, pollMs: 20, log: line => lines.push(line),
      submission: { head: fixture.git("rev-parse", "HEAD"), base: fixture.base, scope: "all", gates: { rust: true, js: true }, checkout: "pass", ...fields } });
    return lines.filter(line => line.startsWith("owner: "));
  };
  assert.deepEqual(await owner({ branch: "refs/heads/named", ownerName: "Sol" }), ["owner: Sol"]);
  assert.deepEqual(await owner({ branch: "refs/heads/unnamed" }), ["owner: pass (its checkout). Pass --owner <name> with your next branch to group a thread's requests under one owner."]);
});
