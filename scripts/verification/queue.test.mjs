// The verification queue: its line rules, and the service run against a stub
// verifier that passes, fails, fails for machine reasons, hangs, and crashes.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { attemptOutcome, cancel, lastNightlyPass, listRequests, movedNote, nextRequest, nightlyTaskDefinition, placeMove, placeSubmission, position, queuePaths, readJson, requestMove, serviceRuns, sharedFailures, startsInMs, submit, submitNightly, taskDefinition, terminalStates, writeJson } from "./queue.mjs";
import { laneTemp, runService, sweepContainers } from "./queue-service.mjs";
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
  const moved = (target, fields) => ({ ...target, status: { ...target.status, ...placeMove(requests, { reason: "unblocks others", ...fields }) } });
  let requests = [running, a, b, c, passed, superseded];
  const first = moved(c, { id: c.id });
  requests = [running, a, b, first, passed, superseded];
  assert.equal(nextRequest(requests, health).id, c.id, "--first starts it next");
  assert.deepEqual([c, a, b].map(row => position(requests, row.id)), [2, 3, 4]);
  assert.equal(first.request.sequence, 4, "a move changes no sequence");
  requests = [running, a, moved(b, { id: b.id, before: a.id }), first, passed, superseded];
  assert.deepEqual([c, b, a].map(row => position(requests, row.id)), [2, 3, 4], "--before puts it just ahead of the other");
  requests = [...requests, nightly];
  assert.equal(nextRequest(requests, health).id, nightly.id, "the nightly still goes first");
  assert.deepEqual([nightly, c, b, a].map(row => position(requests, row.id)), [2, 3, 4, 5]);
  const refused = fields => placeMove(requests, { reason: "unblocks others", ...fields }).rejected;
  assert.match(refused({ id: running.id }), /it is running\. Only a queued request can move\.$/u);
  assert.match(refused({ id: passed.id }), /it has already finished: passed/u);
  assert.match(refused({ id: superseded.id }), /replaced by 000000004-dddddd/u);
  assert.match(refused({ id: "000000009-zzzzzz" }), /^No verification request 000000009-zzzzzz\.$/u);
  assert.match(refused({ id: a.id, before: running.id }), /before 000000001-aaaaaa: it is running/u, "nothing goes ahead of a running request");
  assert.match(refused({ id: a.id, before: a.id }), /before itself/u);
  assert.match(refused({ id: a.id, reason: " " }), /needs a reason/u);
  assert.match(placeMove(requests, { id: a.id, reason: "x" }, new Set([a.id])).rejected, /it is running/u, "a request the service has started cannot move before its status says so");
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
function harness(t, { timeLimitMs = 60_000, docker = async () => true, sweep = async () => 0, hostFails = () => {}, holdLane = async () => ({ release() {} }), prepare = async () => {}, prepareLimitMs, lanes, cleanupRetryMs = 50, freeMemory = () => 32 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-"));
  const fixture = fixtureRepo();
  const calls = [];
  const stop = new AbortController();
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
    else if (behavior === "host-down") receipt({ verdict: "FAIL", error: "Docker did not answer", failure: { kind: "environment", cause: "postgres-start" } });
    // Two slow machine failures, then a run that ends only when it is stopped.
    else if (behavior === "slow-host" && calls.filter(call => call.id === grant.request).length > 2) await new Promise(done => signal.addEventListener("abort", done, { once: true }));
    else if (behavior === "slow-host") { await sleep(3000); receipt({ verdict: "FAIL", error: "Docker did not answer", failure: { kind: "environment", cause: "postgres-start" } }); }
  };
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, timeLimitMs, floorGb: 1,
    freeDisk: () => 100, docker, prepare, sweep, prepareLimitMs,
    holdLane, worker, retryDelay: () => 50, cleanupRetryMs, lanes, freeMemory, stop: stop.signal, log: () => {} });
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
  return { root, fixture, calls, request, settled, service };
}

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
  const { request, settled } = harness(t, { lanes: () => { throw new Error("verification-lanes must contain 1 or 2."); },
    holdLane: async ({ lanes }) => { slots = lanes; return { release() {} }; } });
  assert.equal((await settled((await request("pass")).id)).status.verdict, "PASS");
  assert.equal(slots, 1);
});

test("a request's cleanup removes only its containers, and the sweep never one another lane may be starting", async () => {
  let removed = [];
  const command = async (_, args) => {
    if (args[0] === "rm") { removed.push(...args.slice(2)); return { stdout: "" }; }
    const filters = args.filter(arg => arg.includes("="));
    const found = filters.includes("label=dohc.verification=r1") ? "own" : filters.includes("status=exited") ? "exited" : filters.includes("status=created") ? "starting" : "";
    return { stdout: found };
  };
  assert.equal(await sweepContainers({ request: "r1", command }), 1);
  assert.deepEqual(removed, ["own"], "another request's container cannot fail this cleanup");
  removed = [];
  assert.equal(await sweepContainers({ command }), 1);
  assert.deepEqual(removed, ["exited"]);
});

test("each lane has its own temp folder under the queue root", () => {
  assert.equal(laneTemp(join("C:", "w", "_verification", "lane")), join("C:", "w", "_verification", "tmp", "lane"));
  assert.equal(laneTemp(join("C:", "w", "_verification", "lane-2")), join("C:", "w", "_verification", "tmp", "lane-2"));
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
  await cancel(root, first.id);
  await cancel(root, second.id);
});

test("a check that fails after free memory ran out is retried as a machine failure", async t => {
  const { request, calls } = harness(t, { freeMemory: () => 1 });
  const failed = await request("slow-fail");
  await waitFor(() => calls.filter(call => call.id === failed.id).length >= 2, "the failure must be retried");
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
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }), retryDelay: () => 0,
    worker: async ({ grant, output }) => { calls.push(grant); writeFileSync(join(output, "result.json"), JSON.stringify({ grant, commit: grant.head, baseCommit: grant.base, verdict: "PASS", final: true })); },
    stop: stop.signal, log: () => {} });
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
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }), retryDelay: () => 0,
    worker: async ({ grant, output }) => { calls.push(grant.head); writeFileSync(join(output, "result.json"), JSON.stringify({ grant, commit: grant.head, baseCommit: grant.base, verdict: "PASS", final: true })); },
    stop: stop.signal, log: () => {} });
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
  const options = { root, repo: fixture.repo, tickMs: 20, freeDisk: () => 100, floorGb: 1, docker: async () => true, stop: stop.signal, log: () => {} };
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
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }),
    worker: async ({ grant }) => { calls.push(grant); }, stop: stop.signal, log: () => {} });
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
  const first = await queueCli(root, "move", c.id, "--first", "--reason", "fixes the test three branches fail", "--by", "Ice");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /now #3 in line, was #5/u, "the running request and the nightly stay ahead");
  const before = await queueCli(root, "move", b.id, "--before", a.id, "--reason", "main is broken until it lands");
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /now #4 in line, was #5/u);
  const status = await queueCli(root, "status");
  const line = id => status.stdout.split("\n").find(row => row.startsWith(id)) ?? "";
  assert.ok(line(c.id).includes("#3") && line(c.id).endsWith("  (moved first by Ice: fixes the test three branches fail)"), status.stdout);
  assert.ok(line(b.id).endsWith(`  (moved before ${a.id} by ${userInfo().username} in ${process.cwd()}: main is broken until it lands)`), status.stdout);
  assert.equal(listRequests(root).find(candidate => candidate.id === hung.id).status.state, "running", "a move never touches a running request");
  await cancel(root, hung.id);
  for (const { id } of [a, b, c, nightly]) assert.equal((await settled(id)).status.verdict, "PASS");
  assert.deepEqual(calls.map(call => call.id), [hung.id, nightly.id, c.id, b.id, a.id]);
  const moves = historyEvents(root, "moved");
  assert.deepEqual(moves.map(({ id, from, to, before, reason, by }) => ({ id, from, to, before, reason, name: by.name })), [
    { id: c.id, from: 5, to: 3, before: null, reason: "fixes the test three branches fail", name: "Ice" },
    { id: b.id, from: 5, to: 4, before: a.id, reason: "main is broken until it lands", name: null }]);
  assert.deepEqual([moves[1].by.user, moves[1].by.cwd], [userInfo().username, process.cwd()], "an unnamed mover is known by its user and checkout");
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
  // The command refuses at once.
  for (const [args, message] of [
    [[hung.id, "--first"], /^Cannot move \S+: it is running\. Only a queued request can move\.$/u],
    [[done.id, "--first"], /it has already finished: passed/u],
    [["000000099-ffffff", "--first"], /^No verification request 000000099-ffffff\.$/u],
    [[waiting.id, "--before", hung.id], /before \S+: it is running\. Move it before a queued request, or use --first\.$/u],
  ]) {
    const result = await queueCli(root, "move", ...args, "--reason", "unblocks others");
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr.trim(), message);
  }
  for (const args of [[waiting.id, "--first"], [waiting.id, "--first", "--before", done.id, "--reason", "x"], [waiting.id, "--reason", "x"]]) {
    assert.match((await queueCli(root, "move", ...args)).stderr, /^Use move <id> --first/u, args.join(" "));
  }
  // The service makes the same checks for a move written straight to it, and answers each one.
  for (const [move, message] of [[{ id: hung.id }, /it is running/u], [{ id: done.id }, /already finished/u], [{ id: "000000099-ffffff" }, /No verification request/u], [{ id: waiting.id, reason: "" }, /needs a reason/u]]) {
    const key = await requestMove(root, { reason: "unblocks others", by: { name: "test" }, ...move });
    assert.match((await waitFor(() => readJson(join(queuePaths(root).keys, key)), "the service must answer the move")).rejected, message);
  }
  assert.equal(listRequests(root).find(candidate => candidate.id === hung.id).status.state, "running", "a refused move leaves the run alone");
  assert.equal(calls.filter(call => call.id === hung.id).length, 1);
  assert.ok(!existsSync(queuePaths(root).history) || historyEvents(root, "moved").length === 0, "a refused move records no move");
  await cancel(root, hung.id);
  assert.equal((await settled(waiting.id)).status.verdict, "PASS");
});

test("a newer commit that replaces a moved request keeps the moved place", async t => {
  const { root, request, settled, calls } = harness(t);
  const hung = await request("hang");
  await waitFor(() => calls.find(call => call.id === hung.id), "the hang must start");
  const other = await request("pass", { branch: "refs/heads/other" });
  const old = await request("pass", { branch: "refs/heads/feature" });
  const key = await requestMove(root, { id: old.id, reason: "fixes main", by: { name: "Ice" } });
  assert.deepEqual(await waitFor(() => readJson(join(queuePaths(root).keys, key)), "the move must be applied"), { moved: old.id, from: 3, to: 2 });
  const newer = await request("pass", { branch: "refs/heads/feature" });
  assert.equal((await settled(old.id)).status.supersededBy, newer.id);
  const requests = listRequests(root);
  assert.equal(position(requests, newer.id), 2, "the newer commit keeps the moved place");
  assert.equal(movedNote(requests.find(candidate => candidate.id === newer.id).status.moved), "moved first by Ice: fixes main", "and the record of the move");
  await cancel(root, hung.id);
  await settled(other.id);
  await settled(newer.id);
  assert.deepEqual(calls.map(call => call.id), [hung.id, newer.id, other.id]);
});
