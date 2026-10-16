// The verification queue service. It accepts submissions, runs one PR
// verification per host lane, each in its own checkout, and records every outcome.
// A supervisor (queue-supervisor.ps1) starts it inside a job object that
// stops every descendant when the service exits, so restart recovery never
// meets a worker left running.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, freemem, uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { git, run } from "./process.mjs";
import { acquireVerificationSlot, freeDiskGb, resolveBuildBudget, verificationLanes } from "../../tools/rust-engine-program/build-slot.mjs";
import { attemptOutcome, lastNightlyPass, lineOrder, listRequests, monitorPort, nextRequest, orderOf, ownerFor, ownerOf, parseMove, pauseQueue, placeMove, placeSubmission, position, protocol, queueLanePurpose, queuePaths, readJson, readPause, restartReason, retryDelayMs, serviceRuns, terminalStates, writeJson } from "./queue.mjs";
import { startMonitor, threadDirectory } from "./queue-monitor.mjs";

const verifierEntry = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const sha = /^[0-9a-f]{40}$/u;
// After this many machine failures a request ends in "error": no verdict, and the lane moves on.
const environmentAttempts = 5;
// A stopped run that has not ended by then is stopped by restarting the service, whose job kills it.
const stopGraceMs = 5 * 60_000;
const names = path => { try { return readdirSync(path); } catch { return []; } };
// A receipt's step times in seconds, and its ten slowest tests, for the history.
const timesOf = receipt => ({
  steps: Object.fromEntries((receipt?.timings ?? []).filter(row => Number.isFinite(row.seconds)).map(row => [row.name, Math.round(row.seconds)])),
  slowest: (receipt?.slowest ?? []).slice(0, 10),
});
const cpuTimes = () => cpus().reduce((total, { times }) => {
  const busy = times.user + times.nice + times.sys + times.irq;
  return { busy: total.busy + busy, all: total.all + busy + times.idle };
}, { busy: 0, all: 0 });

/**
 * Remove one request's containers, or without a request, every verification
 * container that has exited. A container that cannot be removed fails only its
 * own request's cleanup. Any other container may belong to a run in another lane, so it is never touched.
 */
export async function sweepContainers({ request, command = run } = {}) {
  const list = async filters => {
    const result = await command("docker", ["ps", "--all", "--quiet", ...filters.flatMap(filter => ["--filter", filter])], { timeoutMs: 30_000, quietStdout: true });
    return result.stdout.split(/\s+/u).filter(Boolean);
  };
  const ids = new Set(request ? await list([`label=dohc.verification=${request}`]) : []);
  if (!request) for (const status of ["exited", "dead"]) for (const id of await list(["name=dohc-verify-", `status=${status}`])) ids.add(id);
  // --volumes also removes each container's anonymous data volume, which would otherwise stay on the disk.
  if (ids.size) await command("docker", ["rm", "--force", "--volumes", ...ids], { timeoutMs: 60_000, quietStdout: true });
  return ids.size;
}

/**
 * A lane's temp folder, beside the lane under the queue root. Lanes never share one, and the queue root
 * sits in the host's antivirus exclusion, so a scan cannot hold a test's temp file while it is deleted.
 */
export const laneTemp = lane => join(dirname(lane), "tmp", basename(lane));

/** Put the lane at `head` with no state from earlier runs except the named caches. */
export async function prepareLane({ lane, repo, head, signal }) {
  // The temp folder keeps only the coming run's files.
  // Best effort: a file still held by a stray process stays, and every run makes its own folders inside.
  await rm(laneTemp(lane), { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  mkdirSync(laneTemp(lane), { recursive: true });
  // Git runs as a child process, never synchronously, so a slow checkout cannot stop the heartbeat of another lane's run.
  const laneGit = async (args, cwd = lane) => (await run("git", args, { cwd, signal, quietStdout: true, timeoutMs: 15 * 60_000 })).stdout.trim();
  if (!existsSync(join(lane, ".git"))) {
    await laneGit(["worktree", "add", "--detach", "--force", lane, head], repo);
    // Workspace cleanup keeps locked worktrees, so the lane keeps its warm caches.
    await laneGit(["worktree", "lock", "--reason", "dohc verification queue lane", lane], repo);
  }
  const gitDir = await laneGit(["rev-parse", "--absolute-git-dir"]);
  // No worker runs while the lane is prepared, so any Git lock or operation state is stale.
  for (const name of ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) rmSync(join(gitDir, name), { force: true });
  await laneGit(["checkout", "--force", "--detach", head]);
  await laneGit(["clean", "-ffdx", "--exclude=node_modules", "--exclude=target"]);
  if (await laneGit(["rev-parse", "HEAD"]) !== head) throw new Error(`The lane did not check out ${head}.`);
  if (await laneGit(["status", "--porcelain"]) !== "") throw new Error("The lane has changes after checkout and clean.");
  // Installed while the request waits for the lane, so the verifier's own install has nothing left to do in it.
  await run(process.execPath, ["scripts/verification/setup.mjs"], { cwd: lane, signal, quietStdout: true, timeoutMs: 30 * 60_000,
    env: { ...process.env, TEMP: laneTemp(lane), TMP: laneTemp(lane) } });
}

export async function dockerResponds(command = run) {
  try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000, quietStdout: true }); return true; }
  catch { return false; }
}

/** Hold a host lane's slot, so runs started by older code and this service never exceed the lane count. */
async function holdLegacyLane({ entry, signal, lanes }) {
  // No wait limit: a timeout would only send a durable request to the back of the line. Cancel still stops the wait.
  return acquireVerificationSlot(process.env, { lanes, entry: verifierEntry, signal, waitMs: Infinity,
    metadata: { purpose: queueLanePurpose, checkout: entry.request.checkout, commit: entry.request.head, phase: `request ${entry.id}` } });
}

/** Run the lane's own verifier for one attempt. */
async function defaultWorker({ lane, request, grant, output, signal }) {
  const args = ["scripts/verification/verify.mjs", "pr", "--base", request.base,
    ...(request.scope === "all" ? [] : ["--job", request.scope]), ...(request.full ? ["--full"] : [])];
  await run(process.execPath, args, { cwd: lane, signal, log: join(output, "worker.log"), quietStdout: true,
    env: { ...process.env, TEMP: laneTemp(lane), TMP: laneTemp(lane), DOHC_VERIFICATION_GRANT: JSON.stringify(grant), DOHC_VERIFICATION_OUTPUT: output } })
    .catch(error => { if (!error.commandExitFailure) throw error; });
}

function defaultLog(root) {
  const path = join(root, "service.log");
  return line => {
    try {
      if (existsSync(path) && statSync(path).size > 10 * 1024 * 1024) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch { /* The log is a record; losing a line must not stop the queue. */ }
  };
}

const pipeName = root => `\\\\.\\pipe\\dohc-verification-queue-${createHash("sha256").update(resolve(root).toLowerCase()).digest("hex").slice(0, 12)}`;

/** Hold the host-wide name for this queue root; the OS frees it when the process dies. */
function holdInstance(root) {
  return new Promise((done, fail) => {
    const server = createServer(socket => socket.end());
    server.once("error", error => error.code === "EADDRINUSE" ? done(null) : fail(error));
    server.listen(process.platform === "win32" ? pipeName(root) : join(root, "service.sock"), () => { server.unref(); done(server); });
  });
}

/**
 * Run the service until a restart is requested (resolves 75) or `stop` aborts.
 * Tests replace the worker, lane preparation, and host probes.
 */
export async function runService({
  root, repo, lane = queuePaths(root).lane, commit = null,
  tickMs = 2000, heartbeatMs = 10_000, timeLimitMs = 120 * 60_000, floorGb = resolveBuildBudget()?.diskFloorGb ?? 40,
  // Another run starts only with this much free memory; a check that failed after it fell under the second floor is not trusted.
  memoryFloorGb = 10, memoryFailGb = 3, freeMemory = () => freemem() / 1024 ** 3,
  freeDisk = () => freeDiskGb(lane) ?? freeDiskGb(root), docker = dockerResponds,
  prepare = prepareLane, sweep = sweepContainers, holdLane = holdLegacyLane,
  worker = defaultWorker, retryDelay = retryDelayMs, cleanupRetryMs = 60_000, prepareLimitMs = 45 * 60_000, stop, log = defaultLog(root),
  lanes = () => 1, monitor = null, bootedAt = Date.now() - uptime() * 1000, threadOf = threadDirectory(),
}) {
  const paths = queuePaths(root);
  for (const path of [paths.inbox, paths.keys, paths.requests, paths.control]) mkdirSync(path, { recursive: true });
  const instance = await holdInstance(root);
  if (!instance) { log("another service already serves this queue root"); return 0; }
  // The page only reads the queue's files, so it starts with the service and never holds up its loop.
  const page = monitor === null ? null : startMonitor({ root, port: monitor, log, threadOf });
  const startedAt = new Date().toISOString();
  const previous = readJson(paths.service);
  // The previous service's last heartbeat says how long its interrupted runs had been awake.
  const previousRuns = serviceRuns(previous).runs;
  // A computer restart since that heartbeat holds the line until someone resumes it, so no run starts
  // by itself after logon. A service restart within one boot, or a first start, holds nothing.
  if (previous?.heartbeatAt && bootedAt > Date.parse(previous.heartbeatAt)) {
    await pauseQueue(root, { reason: restartReason });
    log("the computer restarted since the last heartbeat; no run starts until pnpm verify:queue resume");
  }
  const health = { diskFreeGb: null, diskOk: true, dockerOk: true, dockerCheckedAt: 0, pausedUntil: 0, environmentStreak: 0, reason: null };
  // A request may use twice the per-run limit across all its attempts.
  const requestBudgetMs = 2 * timeLimitMs;
  // Attempts in flight, by request id. Each holds one of the lane checkouts.
  const running = new Map();
  const checkouts = [lane, `${lane}-2`];
  let laneCount = 1;
  // The host's CPU and free memory at the last clock tick.
  const host = { cpuBusyPercent: null, freeMemGb: null };
  // The load an attempt verified under: the lane count, the most runs at once, the lowest free memory, and the mean CPU use.
  const runLoad = current => current.load.samples ? { lanes: current.load.lanes, peakRuns: current.load.peakRuns,
    minFreeMemGb: Math.round(current.load.minFreeMemGb * 10) / 10, cpuBusyPercent: Math.round(current.load.cpuBusy / current.load.samples) } : null;
  let laneError = null;
  let fatal = null;
  let lastPrune = 0;
  let lastCleanup = 0;

  // A finished request's state never changes again, so it is read once.
  const finished = new Map();
  const load = () => listRequests(root, finished).map(entry => {
    if (terminalStates.has(entry.status.state)) finished.set(entry.id, entry);
    return entry;
  });
  let sequence = Math.max(0, ...load().map(entry => entry.request.sequence ?? 0));
  // Requests whose containers could not be removed yet. Their records stay until cleanup succeeds.
  const cleanupPending = new Set(load().filter(entry => entry.status.cleanupPending).map(entry => entry.id));

  const statusPath = id => join(paths.request(id), "status.json");
  const setStatus = (id, status) => writeJson(statusPath(id), { ...status, updatedAt: new Date().toISOString() });
  const history = event => { try { appendFileSync(paths.history, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); } catch { /* History informs estimates and records moves; losing a line must not stop the queue. A request keeps its last move in its status. */ } };
  const beat = () => writeJson(paths.service, {
    protocol, pid: process.pid, commit, startedAt, heartbeatAt: new Date().toISOString(), lanes: laneCount,
    // Read with the runs: once a heartbeat shows the pause, no run starts that it does not list.
    paused: readPause(root),
    running: [...running.values()].map(current => ({ id: current.id, attempt: current.attempt, checkout: current.checkout, phase: current.phase, startedAt: current.startedAt, awakeMs: current.awakeMs })),
    health: { diskFreeGb: health.diskFreeGb, diskOk: health.diskOk, dockerOk: health.dockerOk, cpuBusyPercent: host.cpuBusyPercent, freeMemGb: host.freeMemGb,
      pausedUntil: health.pausedUntil ? new Date(health.pausedUntil).toISOString() : null, reason: health.reason },
  });

  async function cleanUp(id) {
    try { await sweep({ request: id }); cleanupPending.delete(id); return false; }
    catch (error) { log(`container cleanup for ${id} failed: ${error.message}`); cleanupPending.add(id); return true; }
  }

  async function finish(entry, attempt, outcome, { cleanup = false } = {}) {
    const status = readJson(statusPath(entry.id)) ?? entry.status;
    const attempts = status.attempts.map(row => row.n === attempt?.n ? { ...row, endedAt: new Date().toISOString(), awakeMs: attempt.awakeMs, load: attempt.load ?? null, flaky: attempt.flaky ?? [], failed: attempt.failed ?? [],
      steps: attempt.steps ?? {}, slowest: attempt.slowest ?? [], ...outcome } : row);
    // Only the JavaScript gate starts containers.
    if (cleanup && entry.request.gates?.js) status.cleanupPending = await cleanUp(entry.id);
    const failures = attempts.filter(row => row.outcome === "environment").length;
    if (outcome.outcome === "environment" && failures >= environmentAttempts) {
      await setStatus(entry.id, { ...status, state: "error", attempts, notBefore: null, waiting: null, verdict: null, stopping: null,
        result: null, cause: outcome.cause, reason: `The host failed ${failures} times running this request; the last failure: ${outcome.reason ?? outcome.cause}` });
    } else if (outcome.outcome === "environment") {
      health.environmentStreak += 1;
      // Repeated machine failures across requests mean the host is unwell; stop admitting for a while.
      if (health.environmentStreak >= 2) health.pausedUntil = Date.now() + retryDelay(health.environmentStreak - 1);
      await setStatus(entry.id, { ...status, state: "queued", attempts, stopping: null,
        notBefore: new Date(Date.now() + retryDelay(failures)).toISOString(),
        waiting: `${outcome.cause}: ${outcome.reason ?? "environment failure."} Retrying.` });
    } else {
      if (attempt && outcome.outcome !== "error") { health.environmentStreak = 0; health.pausedUntil = 0; }
      await setStatus(entry.id, { ...status, state: outcome.outcome, attempts, notBefore: null, waiting: null, stopping: null,
        verdict: outcome.outcome === "passed" ? "PASS" : outcome.outcome === "failed" ? "FAIL" : null,
        result: attempt ? join(paths.attempt(entry.id, attempt.n), "result.json") : null, cause: outcome.cause, reason: outcome.reason ?? null });
    }
    history({ event: "finished", id: entry.id, attempt: attempt?.n, awakeMs: attempt?.awakeMs, load: attempt?.load ?? null, flaky: attempt?.flaky ?? [], failed: attempt?.failed ?? [],
      steps: attempt?.steps ?? {}, slowest: attempt?.slowest ?? [], ...outcome });
  }

  async function recover(requests) {
    // A request marked running that this service is not running was left by a previous service, whose
    // worker has stopped, or could not be read when this one started. A finished receipt still counts.
    for (const entry of requests.filter(entry => entry.status.state === "running" && !running.has(entry.id))) {
      const attempt = entry.status.attempts.at(-1);
      const grant = { request: entry.id, attempt: attempt?.n, head: entry.request.head, base: entry.request.base };
      const result = attempt ? readJson(join(paths.attempt(entry.id, attempt.n), "result.json")) : null;
      const last = previousRuns.find(row => row.id === entry.id && row.attempt === attempt?.n)?.awakeMs ?? 0;
      const stopped = entry.status.stopping ?? "service restart";
      // A recovery that cannot be recorded would repeat every tick; restart under the supervisor's backoff instead.
      try { await finish(entry, attempt && { n: attempt.n, awakeMs: last, flaky: result?.flaky ?? [], failed: result?.failed ?? [], ...timesOf(result) }, attemptOutcome(result, grant, { stopped }), { cleanup: true }); }
      catch (error) { fatal = error; return; }
    }
  }

  async function ingest() {
    for (const name of names(paths.inbox).filter(name => name.endsWith(".json")).sort()) {
      try { await accept(name); }
      catch (error) {
        log(`submission ${name} could not be accepted: ${error.stack ?? error.message}`);
        // An answer is never replaced: its client may already follow the request it names.
        // Once a request's record exists the request runs, so its client is told its id, not a rejection.
        const key = join(paths.keys, name.slice(0, -5));
        const answer = existsSync(key) ? null : error.acceptedId ? { id: error.acceptedId } : { rejected: `The service could not accept it: ${error.message}` };
        try { if (answer) await writeJson(key, answer); rmSync(join(paths.inbox, name), { force: true }); }
        catch { /* It stays in the inbox and is tried again. */ }
      }
    }
  }

  async function accept(name) {
    {
      const path = join(paths.inbox, name);
      const key = name.slice(0, -5);
      const submission = readJson(path);
      if (!submission) {
        // A torn submission is still being written, or its writer died.
        try { if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true }); } catch { /* Gone. */ }
        return;
      }
      // Antivirus can hold the file for a moment; a later tick removes an answered submission.
      const discard = () => { try { rmSync(path, { force: true }); } catch { /* Removed later. */ } };
      const answer = async value => { await writeJson(join(paths.keys, key), value); discard(); };
      if (existsSync(join(paths.keys, key))) { discard(); return; }
      const rejection = submission.protocol !== protocol ? `This service speaks queue protocol ${protocol}, not ${submission.protocol}. Run pnpm verify:queue upgrade from a checkout of origin/main.`
        : !sha.test(submission.head ?? "") || !sha.test(submission.base ?? "") ? "The submission has no full head and base commit."
        : !["all", "js", "rust"].includes(submission.scope) ? `Unknown scope ${submission.scope}.`
        : typeof submission.checkout !== "string" || !(submission.branch === null || submission.branch === undefined || typeof submission.branch === "string") ? "The submission names no checkout."
        : (() => {
          try { git(["cat-file", "-e", `${submission.head}^{commit}`], repo); git(["cat-file", "-e", `${submission.base}^{commit}`], repo); return null; }
          catch { return "The head or base commit is not in this host's repository."; }
        })();
      if (rejection) { await answer({ rejected: rejection }); return; }
      const requests = load();
      const place = placeSubmission(requests, submission);
      // A request whose attempt is starting is no longer waiting; it finishes like a running one.
      if (place.supersede) {
        place.supersede = place.supersede.filter(id => !running.has(id));
        place.sequence = requests.find(candidate => candidate.id === place.supersede[0])?.request.sequence ?? null;
      }
      if (place.attach) { await answer({ id: place.attach, owner: ownerOf(requests.find(candidate => candidate.id === place.attach).request) }); return; }
      // A newer commit takes the place of the request it replaces that is furthest ahead, its owner, and the record of any move that put it there.
      const ahead = requests.filter(candidate => place.supersede.includes(candidate.id)).sort(lineOrder)[0];
      const order = place.sequence ?? ++sequence;
      const id = `${String(order).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
      // Pin both commits before accepting, so an accepted request can always be verified.
      git(["update-ref", `refs/verification-queue/${id}/head`, submission.head], repo);
      git(["update-ref", `refs/verification-queue/${id}/base`, submission.base], repo);
      const { key: _key, protocol: _protocol, ownerName: _ownerName, ...fields } = submission;
      const owner = ahead ? ownerOf(ahead.request) : ownerFor(submission, threadOf);
      await writeJson(join(paths.request(id), "request.json"), { ...fields, owner, id, sequence: order, acceptedAt: new Date().toISOString(), supersedes: place.supersede });
      try {
        await setStatus(id, { state: "queued", attempts: [], order: ahead && orderOf(ahead), moved: ahead?.status.moved });
        for (const old of place.supersede) await setStatus(old, { ...requests.find(entry => entry.id === old).status, state: "superseded", supersededBy: id });
        await answer({ id, owner });
      } catch (error) { error.acceptedId = id; throw error; }
      history({ event: "accepted", id, head: submission.head, scope: submission.scope, supersedes: place.supersede, owner: owner.key });
    }
  }

  // A move changes only the order of queued requests. One this service has started cannot move, even before its status says so.
  async function applyMoves() {
    for (const name of names(paths.moves).filter(name => name.startsWith("move-") && name.endsWith(".json")).sort()) {
      try { await applyMove(name); }
      catch (error) {
        // Like a submission, a move that fails here is answered and removed, so it never stops the tick again.
        log(`move ${name} could not be applied: ${error.stack ?? error.message}`);
        const key = join(paths.keys, name.slice(0, -5));
        try { if (!existsSync(key)) await writeJson(key, { rejected: `The service could not apply it: ${error.message}` }); rmSync(join(paths.moves, name), { force: true }); }
        catch { /* It stays and is tried again. */ }
      }
    }
  }

  async function applyMove(name) {
    const path = join(paths.moves, name);
    const key = join(paths.keys, name.slice(0, -5));
    // A later tick removes an answered move that antivirus held.
    const discard = () => { try { rmSync(path, { force: true }); } catch { /* Removed later. */ } };
    const answer = async value => { await writeJson(key, value); discard(); };
    if (existsSync(key)) { discard(); return; }
    const raw = readJson(path);
    if (raw === null) {
      // Antivirus can hold a new file for a moment. One that stays unreadable for a minute is answered and removed.
      const age = (() => { try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; } })();
      if (age > 60_000) await answer({ rejected: "The service could not read the move." });
      return;
    }
    const move = parseMove(raw);
    const requests = load();
    const placed = move.rejected ? move : placeMove(requests, move, new Set(running.keys()));
    if (placed.rejected) { log(`move ${name} refused: ${placed.rejected}`); await answer({ rejected: placed.rejected }); return; }
    const moved = { at: new Date().toISOString(), before: move.before, reason: move.reason, by: move.by };
    const after = requests.map(entry => {
      const order = placed.orders.get(entry.id) ?? orderOf(entry);
      return entry.id === move.id ? { ...entry, status: { ...entry.status, order, moved } }
        : order === orderOf(entry) ? entry : { ...entry, status: { ...entry.status, order } };
    });
    // Each request whose order changed is rewritten, in one pass. Moves are rare and the line is about 50 requests.
    for (const [index, entry] of after.entries()) if (entry !== requests[index]) await setStatus(entry.id, entry.status);
    const from = position(requests, move.id);
    const to = position(after, move.id);
    history({ event: "moved", id: move.id, from, to, before: moved.before, reason: moved.reason, by: moved.by });
    await answer({ moved: move.id, from, to });
  }

  async function attempt(entry) {
    const n = (entry.status.attempts.at(-1)?.n ?? 0) + 1;
    const output = paths.attempt(entry.id, n);
    const grant = { request: entry.id, attempt: n, head: entry.request.head, base: entry.request.base };
    // Retries share one budget, so a request that keeps failing late cannot hold the lane forever.
    const used = entry.status.attempts.reduce((total, row) => total + (row.awakeMs ?? 0), 0);
    if (used >= requestBudgetMs) {
      // Only machine failures lead to another attempt, so a spent budget is the host's doing: no verdict.
      await finish(entry, null, { outcome: "error", cause: "time budget", reason: `Its attempts used ${Math.round(used / 60_000)} minutes, the request's limit, after machine failures.` });
      return;
    }
    const busy = new Set([...running.values()].map(other => other.checkout));
    const checkout = checkouts.find(path => !busy.has(path));
    const current = { id: entry.id, attempt: n, checkout, startedAt: new Date().toISOString(), phase: "preparing", phaseAt: Date.now(), awakeMs: 0, load: { lanes: 0, peakRuns: 0, minFreeMemGb: Infinity, cpuBusy: 0, samples: 0 },
      limitMs: Math.min(timeLimitMs, requestBudgetMs - used), prepareMs: 0, abort: new AbortController(), stopped: undefined };
    running.set(entry.id, current);
    let lease;
    try {
      const laneNumber = checkouts.indexOf(checkout) + 1;
      await setStatus(entry.id, { ...entry.status, state: "running", attempts: [...entry.status.attempts, { n, startedAt: current.startedAt, lane: laneNumber }], notBefore: null, waiting: null });
      history({ event: "started", id: entry.id, attempt: n, lane: laneNumber });
      mkdirSync(output, { recursive: true });
      await prepare({ lane: checkout, repo, head: entry.request.head, signal: current.abort.signal });
      current.phase = "waiting for the host lane";
      lease = await holdLane({ entry, signal: current.abort.signal, lanes: laneCount });
      // Rust-only runs need no Docker, so a sweep failure must not stop them.
      await sweep({}).catch(error => log(`container sweep failed: ${error.message}`));
      current.phase = "verifying";
      current.phaseAt = Date.now();
      if (!current.stopped) await worker({ lane: checkout, request: entry.request, grant, output, signal: current.abort.signal });
    } catch (error) {
      if (!current.stopped) log(`attempt ${entry.id}/${n} ended early: ${error.stack ?? error.message}`);
    } finally {
      // Only verification counts against the run; its bookkeeping does not.
      current.phase = "finishing";
      lease?.release();
      const receipt = readJson(join(output, "result.json"));
      let outcome = attemptOutcome(receipt, grant, { stopped: current.stopped });
      if (outcome.outcome === "failed" && outcome.cause === "check") {
        // A check that failed while the host was failing proves nothing about the change.
        const free = freeDisk();
        const host = free !== null && free < Math.min(floorGb, 5) ? `free disk fell to ${free.toFixed(1)} GB`
          : current.load.minFreeMemGb < memoryFailGb ? `free memory fell to ${current.load.minFreeMemGb.toFixed(1)} GB`
          : entry.request.gates?.js && !(await docker()) ? "Docker stopped responding" : null;
        if (host) outcome = { outcome: "environment", cause: "host", reason: `${host} during the run, so its failure is not trusted.` };
      }
      // The attempt stays owned until its outcome is on disk. If that write fails, the
      // service stops, and its replacement recovers the request from the receipt.
      await finish({ ...entry, status: readJson(statusPath(entry.id)) ?? entry.status }, { n, awakeMs: current.awakeMs, load: runLoad(current), flaky: receipt?.flaky ?? [], failed: receipt?.failed ?? [], ...timesOf(receipt) }, outcome, { cleanup: true });
      running.delete(entry.id);
    }
  }

  let targetRemoval = null;
  let targetRetryAt = 0;
  async function checkHealth(requests) {
    health.diskFreeGb = freeDisk();
    health.diskOk = !targetRemoval && (health.diskFreeGb === null || health.diskFreeGb >= floorGb);
    // A bad setting keeps the current lane count, so it never stops the runs in flight.
    try { laneCount = lanes(); laneError = null; }
    catch (error) { if (error.message !== laneError) log(`keeping ${laneCount} lane(s): ${error.message}`); laneError = error.message; }
    const busy = new Set([...running.values()].map(current => current.checkout));
    const targets = checkouts.filter(path => !busy.has(path)).map(path => join(path, "target")).filter(path => existsSync(path));
    if (!health.diskOk && !targetRemoval && Date.now() >= targetRetryAt && targets.length) {
      // The idle lanes' build output is the one large thing the service owns and may delete. No run
      // starts while it is removed. Deleting tens of GB takes minutes; it runs beside the loop so heartbeats continue.
      log(`free disk ${health.diskFreeGb.toFixed(1)} GB is under ${floorGb} GB; removing the lanes' target folders`);
      // Admission stays closed until every removal has settled, so no run starts in a checkout still being emptied.
      targetRemoval = Promise.allSettled(targets.map(path => rm(path, { recursive: true, force: true })))
        .then(results => {
          const failed = results.filter(result => result.status === "rejected");
          if (!failed.length) return;
          targetRetryAt = Date.now() + cleanupRetryMs;
          log(`removing the lanes' target folders failed: ${failed.map(result => result.reason.message).join("; ")}`);
        })
        .finally(() => { targetRemoval = null; });
    }
    if (requests.some(entry => entry.status.state === "queued" && entry.request.gates?.js) && Date.now() - health.dockerCheckedAt > 60_000) {
      health.dockerOk = await docker();
      health.dockerCheckedAt = Date.now();
    }
    health.reason = targetRemoval ? "removing the lanes' build output to free disk"
      : !health.diskOk ? `waiting for disk: ${health.diskFreeGb.toFixed(1)} GB free, ${floorGb} GB needed`
      : health.pausedUntil > Date.now() ? `paused after ${health.environmentStreak} environment failures in a row`
      : !health.dockerOk ? "Docker is not responding; runs with the JavaScript gate wait"
      : running.size && freeMemory() < memoryFloorGb ? `waiting for memory: ${freeMemory().toFixed(1)} GB free, ${memoryFloorGb} GB needed to start another run` : null;
  }

  function prune(requests) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    // The last nightly that passed stays, with its pinned commits, as the base of the next one.
    const keep = lastNightlyPass(requests)?.id;
    for (const entry of requests) {
      if (!terminalStates.has(entry.status.state) || cleanupPending.has(entry.id) || entry.id === keep || Date.parse(entry.status.updatedAt ?? 0) > cutoff) continue;
      rmSync(paths.request(entry.id), { recursive: true, force: true });
      finished.delete(entry.id);
    }
    // Pins whose request is gone, including pins from an acceptance interrupted before its record.
    const pinned = git(["for-each-ref", "--format=%(refname)", "refs/verification-queue/"], repo).split(/\r?\n/u).filter(Boolean);
    for (const ref of pinned) {
      const id = ref.split("/")[2];
      if (!existsSync(join(paths.request(id), "request.json"))) {
        try { git(["update-ref", "-d", ref], repo); } catch { /* Already gone. */ }
      }
    }
    for (const key of names(paths.keys)) {
      const answer = readJson(join(paths.keys, key));
      const old = (() => { try { return statSync(join(paths.keys, key)).mtimeMs < cutoff; } catch { return false; } })();
      if (answer?.id ? !existsSync(paths.request(answer.id)) : old) rmSync(join(paths.keys, key), { force: true });
    }
    try { if (statSync(paths.history).size > 5 * 1024 * 1024) renameSync(paths.history, `${paths.history}.1`); } catch { /* No history yet. */ }
  }

  await beat();
  // The heartbeat has its own timer, so slow Docker or disk work in the loop never looks like a dead service.
  // It stops when the loop has made no progress for 15 minutes, far longer than any tick's own deadlines,
  // or when a synchronous call hangs. The supervisor then restarts the service.
  let tickAt = Date.now();
  let beating = null;
  const pulse = setInterval(() => {
    if (Date.now() - tickAt > 15 * 60_000) return;
    beating ??= beat().catch(error => log(`heartbeat failed: ${error.message}`)).finally(() => { beating = null; });
  }, heartbeatMs);
  // Awake time has its own clock too, so slow work in the loop never shortens a run's time.
  // Only awake time counts against a run. A gap of over a minute between ticks is the machine sleeping;
  // a shorter one is a busy host delaying the timer, and the run was working through it.
  // The same clock samples the host, so each run records the load it verified under.
  let last = Date.now();
  let cpu = cpuTimes();
  const clock = setInterval(() => {
    const now = Date.now();
    const asleep = now - last > 60_000;
    const sample = cpuTimes();
    host.cpuBusyPercent = Math.round(100 * (sample.busy - cpu.busy) / Math.max(1, sample.all - cpu.all));
    const memoryGb = freeMemory();
    host.freeMemGb = Math.round(memoryGb * 10) / 10;
    cpu = sample;
    for (const current of running.values()) {
      // A phase that began since the last tick counts only from its start; a clock set back counts nothing.
      const awake = asleep ? 0 : Math.max(0, now - Math.max(last, current.phaseAt));
      if (current.phase === "verifying") {
        current.awakeMs += awake;
        current.load.lanes = Math.max(current.load.lanes, laneCount);
        current.load.peakRuns = Math.max(current.load.peakRuns, running.size);
        current.load.minFreeMemGb = Math.min(current.load.minFreeMemGb, memoryGb);
        current.load.cpuBusy += host.cpuBusyPercent;
        current.load.samples += 1;
      }
      if (current.phase === "preparing") current.prepareMs += awake;
    }
    last = now;
  }, tickMs);
  log(`service ${commit ?? "(unversioned)"} started, pid ${process.pid}`);
  try {
    for (;;) {
      if (stop?.aborted) return 0;
      // A status that could not be written leaves the service unsure of its own state; restart and recover.
      if (fatal) throw fatal;
      const now = Date.now();
      tickAt = now;
      try {
      // Preparation has its own deadline. Waiting for the host lane has no limit; only cancel or a stop ends it.
      // Recovered first, so a submission that arrived during a restart replaces the interrupted request.
      await recover(load());
      if (fatal) continue;
      await ingest();
      for (const entry of load().filter(entry => entry.status.state === "queued" && existsSync(join(paths.request(entry.id), "cancel")))) {
        await finish(entry, null, { outcome: "cancelled", cause: "cancelled" });
      }
      await applyMoves();
      const requests = load();
      // An attempt can finish during the status write below, so each check keeps its own reference.
      for (const current of [...running.values()].filter(current => !current.stopped)) {
        if (existsSync(join(paths.request(current.id), "cancel"))) current.stopped = "cancelled";
        else if (current.awakeMs > current.limitMs) current.stopped = current.limitMs < timeLimitMs ? "time budget" : "time limit";
        // A hung preparation is the host's problem, so its stop is retried like any machine failure.
        else if (current.prepareMs > prepareLimitMs) current.stopped = "preparation limit";
        if (current.stopped) {
          log(`stopping ${current.id}: ${current.stopped}`);
          current.stoppedAt = now;
          // Recorded first, so a restart before the run ends still honors the stop.
          try {
            const status = readJson(statusPath(current.id));
            if (status) await setStatus(current.id, { ...status, stopping: current.stopped });
          }
          finally { current.abort.abort(); }
        }
      }
      const stuck = [...running.values()].find(current => current.stoppedAt && now - current.stoppedAt > stopGraceMs);
      if (stuck) throw new Error(`${stuck.id} did not stop within ${stopGraceMs / 60_000} minutes; restarting the service to stop it`);
      const restart = join(paths.control, "restart");
      if (existsSync(restart) && running.size === 0) { rmSync(restart, { force: true }); log("restart requested"); return 75; }
      // Docker may be down; a failed cleanup is retried once a minute, one request at a time, oldest first.
      // A failure goes to the back, so a container Docker cannot remove never holds back another request.
      if (cleanupPending.size && now - lastCleanup > cleanupRetryMs) {
        lastCleanup = now;
        const [id] = cleanupPending;
        cleanupPending.delete(id);
        if (!(await cleanUp(id))) {
          // A verdict is never rewritten from a failed read; the next retry records the cleanup instead.
          const status = readJson(statusPath(id));
          if (!status) cleanupPending.add(id);
          else { finished.delete(id); await setStatus(id, { ...status, cleanupPending: false }); }
        }
      }
      await checkHealth(requests);
      // Fill free lanes in run order. A request started here still reads as queued in `requests`, and counts as its
      // owner's latest start, so two free lanes go to two owners. A request whose containers are not yet removed waits,
      // because they carry its id and their removal would stop its next run; it holds no turn meanwhile.
      // A restart or a pause, even one requested during this tick, starts nothing new and waits for the runs in flight.
      const started = new Set(running.keys());
      // A lone run always starts; another one waits while free memory is low.
      while (running.size < laneCount && (running.size === 0 || freeMemory() >= memoryFloorGb) && health.pausedUntil <= now && !existsSync(restart) && !existsSync(paths.pause)) {
        const entry = nextRequest(requests, health, now, started, cleanupPending);
        if (!entry) break;
        started.add(entry.id);
        attempt(entry).catch(error => { log(`attempt bookkeeping failed: ${error.stack ?? error.message}`); fatal = error; });
      }
      if (now - lastPrune > 10 * 60_000) { prune(requests); lastPrune = now; }
      } catch (error) {
        if ([...running.values()].some(current => current.stoppedAt && now - current.stoppedAt > stopGraceMs)) throw error;
        log(`tick failed: ${error.stack ?? error.message}`);
      }
      await sleep(tickMs);
    }
  } finally {
    clearInterval(pulse);
    clearInterval(clock);
    page?.close();
    instance.close();
  }
}

async function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : null;
  if (!root) throw new Error("Use --root <queue root>.");
  const here = fileURLToPath(new URL("../..", import.meta.url));
  if (argv.includes("--self-test")) {
    listRequests(root);
    git(["rev-parse", "HEAD"], here);
    console.log("ok");
    return 0;
  }
  if (argv.includes("--supervised")) {
    // The supervisor puts this process in its job, then says go. Nothing may start before that.
    let go = false;
    for await (const chunk of process.stdin) if ((go = String(chunk).includes("go"))) break;
    if (!go) throw new Error("The supervisor never said go; this process may be outside its job.");
  }
  const repo = resolve(git(["rev-parse", "--git-common-dir"], here), "..");
  return runService({ root, repo, commit: git(["rev-parse", "HEAD"], here), lanes: () => verificationLanes(process.env), monitor: monitorPort });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code ?? 0), error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
