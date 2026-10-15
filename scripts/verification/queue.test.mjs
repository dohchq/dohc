// The verification queue: its line rules, and the service run against a stub
// verifier that passes, fails, fails for machine reasons, hangs, and crashes.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { attemptOutcome, cancel, lastNightlyPass, listRequests, nextRequest, nightlyTaskDefinition, placeSubmission, position, queuePaths, readJson, serviceRuns, startsInMs, submit, submitNightly, taskDefinition, terminalStates, writeJson } from "./queue.mjs";
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

// A run that a service restart cut off during its package tests, shaped like the first attempt of request 000000071-5df0bf.
const restartedAt = "2026-10-15T05:39:00.000Z";
function cutOffRun(grant, steps, fields = {}) {
  const folder = `C:\\w\\_verification\\requests\\${grant.request}\\attempts\\${grant.attempt}`;
  const jsTests = `${folder}\\js-tests\\result.json`;
  const result = { version: 1, mode: "pr", scope: "all", full: false, grant, commit: grant.head, baseCommit: grant.base, verdict: "RUNNING", jsTests,
    flaky: [{ step: "rust", test: "engine::settles" }],
    steps: [{ name: "typecheck", verdict: "PASS", startedAt: "2026-10-15T05:13:25.788Z", finishedAt: "2026-10-15T05:15:04.981Z" },
      { name: "tests", runner: "testWorkspace", report: jsTests, startedAt: "2026-10-15T05:15:13.862Z", verdict: "RUNNING" }], ...fields };
  const tests = { version: 1, concurrency: 2, proofs: true, verdict: "RUNNING", startedAt: "2026-10-15T05:15:13.865Z",
    packages: [{ name: "@dohc/desktop", script: "test:unit", resource: null }, { name: "@dohc/share-web", script: "test", resource: "postgres" }],
    steps: [{ name: "inventory", args: ["-r", "list", "--depth", "-1", "--json"], verdict: "PASS", startedAt: "2026-10-15T05:15:13.971Z", finishedAt: "2026-10-15T05:15:21.830Z" },
      { name: "@dohc/desktop", args: ["--filter", "@dohc/desktop", "run", "test:unit"], verdict: "RUNNING", startedAt: "2026-10-15T05:15:21.836Z" }, ...steps] };
  return { result, tests };
}
const exited = (code, name = "_dohc_share-web") => `C:\\Program Files\\nodejs\\node.exe failed (${code}). Log: C:\\w\\_verification\\requests\\r\\attempts\\1\\js-tests\\${name}.log`;
const shareWeb = (verdict, fields = {}) => ({ name: "@dohc/share-web", args: ["--filter", "@dohc/share-web", "run", "test"], startedAt: "2026-10-15T05:15:21.947Z",
  verdict, ...(verdict === "FAIL" ? { error: exited(1), finishedAt: "2026-10-15T05:21:38.400Z", seconds: 376.45 } : {}), ...fields });
const repository = (verdict, fields = {}) => ({ name: "repository", args: ["run", "test:repo"], startedAt: "2026-10-15T05:15:13.866Z",
  verdict, ...(verdict === "FAIL" ? { error: exited(1, "repository"), finishedAt: "2026-10-15T05:21:40.000Z", seconds: 386.13 } : {}), ...fields });

test("a run a service restart cut off after a package test failed ends failed, with partial coverage", () => {
  const grant = { request: "000000071-5df0bf", attempt: 1, head: "h", base: "b" };
  const recovered = steps => { const { result, tests } = cutOffRun(grant, steps); return attemptOutcome(result, grant, { stopped: "service restart", tests, stoppedAt: restartedAt }); };
  assert.deepEqual(recovered([shareWeb("FAIL")]), { outcome: "failed", cause: "check", reason: "The run stopped at a service restart after @dohc/share-web failed, so its coverage is partial." });
  assert.equal(recovered([repository("FAIL"), shareWeb("FAIL")]).reason, "The run stopped at a service restart after repository and @dohc/share-web failed, so its coverage is partial.");
});

test("a restart retries a run whose package steps show no failure of their own", () => {
  const grant = { request: "000000071-5df0bf", attempt: 1, head: "h", base: "b" };
  const recovered = steps => { const { result, tests } = cutOffRun(grant, steps); return attemptOutcome(result, grant, { stopped: "service restart", tests, stoppedAt: restartedAt }).outcome; };
  assert.equal(recovered([shareWeb("FAIL")]), "failed", "a package that failed on its own");
  assert.equal(recovered([shareWeb("FAIL", { error: exited("interrupted") })]), "environment", "a step that was interrupted");
  assert.equal(recovered([shareWeb("NOT RUN", { error: exited("interrupted"), reason: "stopped after typecheck failed", finishedAt: "2026-10-15T05:21:38.400Z" })]), "environment", "a step a stop kept from finishing");
  assert.equal(recovered([shareWeb("RUNNING"), repository("PASS")]), "environment", "no failure yet");
  assert.equal(recovered([shareWeb("FAIL", { error: exited(53445) })]), "environment", "a command the job relay could not start");
  assert.equal(recovered([repository("FAIL", { finishedAt: "2026-10-15T05:38:04.450Z" })]), "environment", "a failure in the minutes before the stop, when a logoff stops new processes from starting");
  assert.equal(recovered([{ name: "proofs", runner: "runProofs", verdict: "FAIL", error: exited(1, "browser-install"), finishedAt: "2026-10-15T05:21:38.400Z" }]), "environment", "the proofs, which include host steps");
  assert.equal(recovered([{ name: "inventory", verdict: "FAIL", error: exited(1, "inventory"), finishedAt: "2026-10-15T05:15:21.830Z" }]), "environment", "the package inventory");
});

test("a restart still retries a run its receipt blames on the host, and only a restart keeps a package failure", () => {
  const grant = { request: "000000071-5df0bf", attempt: 1, head: "h", base: "b" };
  const { result, tests } = cutOffRun(grant, [shareWeb("FAIL")]);
  const recovered = (fields, options = { stopped: "service restart" }) => attemptOutcome({ ...result, ...fields }, grant, { tests, stoppedAt: restartedAt, ...options });
  assert.equal(recovered({ verdict: "FAIL", failure: { kind: "check", cause: "tests" } }).outcome, "failed", "a check failure the receipt recorded before its cleanup ended");
  assert.deepEqual(recovered({ verdict: "FAIL", failure: { kind: "environment", cause: "postgres-start" } }), { outcome: "environment", cause: "service restart", reason: "The worker stopped before its receipt was final." });
  assert.equal(recovered({ failure: { kind: "environment", cause: "interrupted" } }).outcome, "environment");
  assert.equal(recovered({}, { stopped: "preparation limit" }).outcome, "environment", "a stop the service decided");
  assert.equal(recovered({}, { stopped: undefined }).outcome, "environment", "a worker that ended without a final receipt");
  assert.equal(recovered({}, { stopped: "service restart", stoppedAt: undefined }).outcome, "environment", "a stop time that was never recorded");
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
    else if (behavior === "fail") receipt({ verdict: "FAIL", error: "a test failed", failure: { kind: "check", cause: "tests" } });
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

test("a restarted service ends a run cut off after a package test failed, and retries one with no such failure", async t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-queue-restart-failed-"));
  const fixture = fixtureRepo();
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); rmSync(fixture.repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const paths = queuePaths(root);
  // The previous service's last heartbeat is when it stopped.
  await writeJson(paths.service, { protocol: 1, pid: 1, heartbeatAt: restartedAt, lanes: 1, running: [] });
  const plant = async (id, steps, fields) => {
    await writeJson(join(paths.request(id), "request.json"), { id, sequence: Number(id.slice(0, 9)), head: fixture.head, base: fixture.base, scope: "all", gates: { rust: true, js: true }, checkout: "pass", branch: `refs/heads/${id}` });
    await writeJson(join(paths.request(id), "status.json"), { state: "running", attempts: [{ n: 1, startedAt: "2026-10-15T05:05:21.235Z" }] });
    const { result, tests } = cutOffRun({ request: id, attempt: 1, head: fixture.head, base: fixture.base }, steps, fields);
    await writeJson(join(paths.attempt(id, 1), "result.json"), result);
    await writeJson(join(paths.attempt(id, 1), "js-tests", "result.json"), tests);
  };
  await plant("000000001-aaaaaa", [repository("FAIL", { finishedAt: "2026-10-15T05:38:04.450Z" }), shareWeb("FAIL")]);
  await plant("000000002-bbbbbb", [repository("FAIL", { error: exited("interrupted", "repository") }), shareWeb("NOT RUN", { error: exited("interrupted"), reason: "stopped after typecheck failed" })]);
  await plant("000000003-cccccc", [shareWeb("FAIL")], { verdict: "FAIL", failure: { kind: "environment", cause: "postgres-start" } });
  await plant("000000004-dddddd", [repository("FAIL", { finishedAt: "2026-10-15T05:38:04.450Z" })]);
  const calls = [];
  const stop = new AbortController();
  const service = runService({ root, repo: fixture.repo, lane: join(root, "lane"), tickMs: 20, floorGb: 1, freeDisk: () => 100,
    docker: async () => true, prepare: async () => {}, sweep: async () => 0, holdLane: async () => ({ release() {} }), retryDelay: () => 0,
    worker: async ({ grant, output }) => { calls.push(grant); writeFileSync(join(output, "result.json"), JSON.stringify({ grant, commit: grant.head, baseCommit: grant.base, verdict: "PASS", final: true })); },
    stop: stop.signal, log: () => {} });
  const finished = await waitFor(() => {
    const all = listRequests(root);
    return all.length === 4 && all.every(candidate => terminalStates.has(candidate.status.state)) ? all : null;
  }, "4 requests must finish");
  stop.abort();
  await service;
  const [failed] = finished;
  assert.deepEqual([failed.status.state, failed.status.verdict, failed.status.cause], ["failed", "FAIL", "check"]);
  assert.equal(failed.status.reason, "The run stopped at a service restart after @dohc/share-web failed, so its coverage is partial.", "a failure in the minutes before the stop is not named");
  assert.match(failed.status.result, /attempts[\\/]1[\\/]result\.json$/u);
  assert.deepEqual(failed.status.attempts[0].flaky, [{ step: "rust", test: "engine::settles" }], "the cut-off receipt keeps its flaky tests");
  assert.deepEqual(finished.slice(1).map(candidate => [candidate.status.state, candidate.status.attempts[0].outcome]), [["passed", "environment"], ["passed", "environment"], ["passed", "environment"]]);
  assert.deepEqual(calls.map(grant => [grant.request, grant.attempt]), [["000000002-bbbbbb", 2], ["000000003-cccccc", 2], ["000000004-dddddd", 2]], "only the run with an earlier package failure is not run again");
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
