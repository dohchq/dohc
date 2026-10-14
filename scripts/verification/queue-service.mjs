// The verification queue service. It accepts submissions, runs one PR
// verification per host lane, each in its own checkout, and records every outcome.
// A supervisor (queue-supervisor.ps1) starts it inside a job object that
// stops every descendant when the service exits, so restart recovery never
// meets a worker left running.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { git, run } from "./process.mjs";
import { acquireVerificationSlot, freeDiskGb, resolveBuildBudget, verificationLanes } from "../../tools/rust-engine-program/build-slot.mjs";
import { attemptOutcome, listRequests, nextRequest, placeSubmission, protocol, queuePaths, readJson, retryDelayMs, serviceRuns, terminalStates, writeJson } from "./queue.mjs";

const verifierEntry = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const sha = /^[0-9a-f]{40}$/u;
// After this many machine failures a request ends in "error": no verdict, and the lane moves on.
const environmentAttempts = 5;
// A stopped run that has not ended by then is stopped by restarting the service, whose job kills it.
const stopGraceMs = 5 * 60_000;
const names = path => { try { return readdirSync(path); } catch { return []; } };

/**
 * Remove one request's containers, and any verification container that has
 * exited. Any other container may belong to a run in another lane, so it is never touched.
 */
export async function sweepContainers({ request, command = run } = {}) {
  const list = async filters => {
    const result = await command("docker", ["ps", "--all", "--quiet", ...filters.flatMap(filter => ["--filter", filter])], { timeoutMs: 30_000, quietStdout: true });
    return result.stdout.split(/\s+/u).filter(Boolean);
  };
  const ids = new Set(request ? await list([`label=dohc.verification=${request}`]) : []);
  for (const status of ["exited", "dead"]) for (const id of await list(["name=dohc-verify-", `status=${status}`])) ids.add(id);
  if (ids.size) await command("docker", ["rm", "--force", ...ids], { timeoutMs: 60_000, quietStdout: true });
  return ids.size;
}

/** Put the lane at `head` with no state from earlier runs except the named caches. */
export async function prepareLane({ lane, repo, head, signal }) {
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
  await run(process.execPath, ["scripts/verification/setup.mjs"], { cwd: lane, signal, quietStdout: true, timeoutMs: 30 * 60_000 });
}

export async function dockerResponds(command = run) {
  try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000, quietStdout: true }); return true; }
  catch { return false; }
}

/** Hold a host lane's slot, so runs started by older code and this service never exceed the lane count. */
async function holdLegacyLane({ entry, signal, lanes }) {
  // No wait limit: a timeout would only send a durable request to the back of the line. Cancel still stops the wait.
  return acquireVerificationSlot(process.env, { lanes, entry: verifierEntry, signal, waitMs: Infinity,
    metadata: { purpose: "PR verification (queue)", checkout: entry.request.checkout, commit: entry.request.head, phase: `request ${entry.id}` } });
}

/** Run the lane's own verifier for one attempt. */
async function defaultWorker({ lane, request, grant, output, signal }) {
  const args = ["scripts/verification/verify.mjs", "pr", "--base", request.base,
    ...(request.scope === "all" ? [] : ["--job", request.scope]), ...(request.full ? ["--full"] : [])];
  await run(process.execPath, args, { cwd: lane, signal, log: join(output, "worker.log"), quietStdout: true,
    env: { ...process.env, DOHC_VERIFICATION_GRANT: JSON.stringify(grant), DOHC_VERIFICATION_OUTPUT: output } })
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
  tickMs = 2000, timeLimitMs = 120 * 60_000, floorGb = resolveBuildBudget()?.diskFloorGb ?? 40,
  freeDisk = () => freeDiskGb(lane) ?? freeDiskGb(root), docker = dockerResponds,
  prepare = prepareLane, sweep = sweepContainers, holdLane = holdLegacyLane,
  worker = defaultWorker, retryDelay = retryDelayMs, cleanupRetryMs = 60_000, prepareLimitMs = 45 * 60_000, stop, log = defaultLog(root),
  lanes = () => 1,
}) {
  const paths = queuePaths(root);
  for (const path of [paths.inbox, paths.keys, paths.requests, paths.control]) mkdirSync(path, { recursive: true });
  const instance = await holdInstance(root);
  if (!instance) { log("another service already serves this queue root"); return 0; }
  const startedAt = new Date().toISOString();
  // The previous service's last heartbeat says how long its interrupted runs had been awake.
  const previousRuns = serviceRuns(readJson(paths.service)).runs;
  const health = { diskFreeGb: null, diskOk: true, dockerOk: true, dockerCheckedAt: 0, pausedUntil: 0, environmentStreak: 0, reason: null };
  // A request may use twice the per-run limit across all its attempts.
  const requestBudgetMs = 2 * timeLimitMs;
  // Attempts in flight, by request id. Each holds one of the lane checkouts.
  const running = new Map();
  const checkouts = [lane, `${lane}-2`];
  let laneCount = 1;
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
  const history = event => { try { appendFileSync(paths.history, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); } catch { /* History informs estimates only. */ } };
  const beat = () => writeJson(paths.service, {
    protocol, pid: process.pid, commit, startedAt, heartbeatAt: new Date().toISOString(), lanes: laneCount,
    running: [...running.values()].map(current => ({ id: current.id, attempt: current.attempt, checkout: current.checkout, phase: current.phase, startedAt: current.startedAt, awakeMs: current.awakeMs })),
    health: { diskFreeGb: health.diskFreeGb, diskOk: health.diskOk, dockerOk: health.dockerOk,
      pausedUntil: health.pausedUntil ? new Date(health.pausedUntil).toISOString() : null, reason: health.reason },
  });

  async function cleanUp(id) {
    try { await sweep({ request: id }); cleanupPending.delete(id); return false; }
    catch (error) { log(`container cleanup for ${id} failed: ${error.message}`); cleanupPending.add(id); return true; }
  }

  async function finish(entry, attempt, outcome, { cleanup = false } = {}) {
    const status = readJson(statusPath(entry.id)) ?? entry.status;
    const attempts = status.attempts.map(row => row.n === attempt?.n ? { ...row, endedAt: new Date().toISOString(), awakeMs: attempt.awakeMs, ...outcome } : row);
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
    history({ event: "finished", id: entry.id, attempt: attempt?.n, awakeMs: attempt?.awakeMs, ...outcome });
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
      try { await finish(entry, attempt && { n: attempt.n, awakeMs: last }, attemptOutcome(result, grant, { stopped }), { cleanup: true }); }
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
      if (place.attach) { await answer({ id: place.attach }); return; }
      const order = place.sequence ?? ++sequence;
      const id = `${String(order).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
      // Pin both commits before accepting, so an accepted request can always be verified.
      git(["update-ref", `refs/verification-queue/${id}/head`, submission.head], repo);
      git(["update-ref", `refs/verification-queue/${id}/base`, submission.base], repo);
      const { key: _key, protocol: _protocol, ...fields } = submission;
      await writeJson(join(paths.request(id), "request.json"), { ...fields, id, sequence: order, acceptedAt: new Date().toISOString(), supersedes: place.supersede });
      try {
        await setStatus(id, { state: "queued", attempts: [] });
        for (const old of place.supersede) await setStatus(old, { ...requests.find(entry => entry.id === old).status, state: "superseded", supersededBy: id });
        await answer({ id });
      } catch (error) { error.acceptedId = id; throw error; }
      history({ event: "accepted", id, head: submission.head, scope: submission.scope, supersedes: place.supersede });
    }
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
    const current = { id: entry.id, attempt: n, checkout, startedAt: new Date().toISOString(), phase: "preparing", awakeMs: 0,
      limitMs: Math.min(timeLimitMs, requestBudgetMs - used), prepareMs: 0, abort: new AbortController(), stopped: undefined };
    running.set(entry.id, current);
    let lease;
    try {
      await setStatus(entry.id, { ...entry.status, state: "running", attempts: [...entry.status.attempts, { n, startedAt: current.startedAt }], notBefore: null, waiting: null });
      history({ event: "started", id: entry.id, attempt: n });
      mkdirSync(output, { recursive: true });
      await prepare({ lane: checkout, repo, head: entry.request.head, signal: current.abort.signal });
      current.phase = "waiting for the host lane";
      lease = await holdLane({ entry, signal: current.abort.signal, lanes: laneCount });
      // Rust-only runs need no Docker, so a sweep failure must not stop them.
      await sweep({}).catch(error => log(`container sweep failed: ${error.message}`));
      current.phase = "verifying";
      if (!current.stopped) await worker({ lane: checkout, request: entry.request, grant, output, signal: current.abort.signal });
    } catch (error) {
      if (!current.stopped) log(`attempt ${entry.id}/${n} ended early: ${error.stack ?? error.message}`);
    } finally {
      lease?.release();
      let outcome = attemptOutcome(readJson(join(output, "result.json")), grant, { stopped: current.stopped });
      if (outcome.outcome === "failed" && outcome.cause === "check") {
        // A check that failed while the host was failing proves nothing about the change.
        const free = freeDisk();
        const host = free !== null && free < Math.min(floorGb, 5) ? `free disk fell to ${free.toFixed(1)} GB`
          : entry.request.gates?.js && !(await docker()) ? "Docker stopped responding" : null;
        if (host) outcome = { outcome: "environment", cause: "host", reason: `${host} during the run, so its failure is not trusted.` };
      }
      // The attempt stays owned until its outcome is on disk. If that write fails, the
      // service stops, and its replacement recovers the request from the receipt.
      await finish({ ...entry, status: readJson(statusPath(entry.id)) ?? entry.status }, { n, awakeMs: current.awakeMs }, outcome, { cleanup: true });
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
      : !health.dockerOk ? "Docker is not responding; runs with the JavaScript gate wait" : null;
  }

  function prune(requests) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    for (const entry of requests) {
      if (!terminalStates.has(entry.status.state) || cleanupPending.has(entry.id) || Date.parse(entry.status.updatedAt ?? 0) > cutoff) continue;
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
  // A synchronous call that hangs still stops it, and the supervisor restarts the service.
  let beating = null;
  const pulse = setInterval(() => {
    beating ??= beat().catch(error => log(`heartbeat failed: ${error.message}`)).finally(() => { beating = null; });
  }, 10_000);
  log(`service ${commit ?? "(unversioned)"} started, pid ${process.pid}`);
  let last = Date.now();
  try {
    for (;;) {
      if (stop?.aborted) return 0;
      // A status that could not be written leaves the service unsure of its own state; restart and recover.
      if (fatal) throw fatal;
      const now = Date.now();
      try {
      // Count only awake verification time against a run: a gap far over one tick is sleep.
      // Preparation has its own deadline. Waiting for the host lane has no limit; only cancel or a stop ends it.
      const awake = Math.min(now - last, 3 * tickMs);
      for (const current of running.values()) {
        if (current.phase === "verifying") current.awakeMs += awake;
        if (current.phase === "preparing") current.prepareMs += awake;
      }
      last = now;
      // Recovered first, so a submission that arrived during a restart replaces the interrupted request.
      await recover(load());
      if (fatal) continue;
      await ingest();
      for (const entry of load().filter(entry => entry.status.state === "queued" && existsSync(join(paths.request(entry.id), "cancel")))) {
        await finish(entry, null, { outcome: "cancelled", cause: "cancelled" });
      }
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
      // Docker may be down; a failed cleanup is retried once a minute, not every tick.
      if (cleanupPending.size && now - lastCleanup > cleanupRetryMs) {
        lastCleanup = now;
        for (const id of [...cleanupPending]) {
          if (await cleanUp(id)) break;
          // A verdict is never rewritten from a failed read; the next retry records the cleanup instead.
          const status = readJson(statusPath(id));
          if (!status) { cleanupPending.add(id); continue; }
          finished.delete(id);
          await setStatus(id, { ...status, cleanupPending: false });
        }
      }
      await checkHealth(requests);
      // Fill free lanes in line order. A request started here still reads as queued in `requests`. A request whose
      // containers are not yet removed waits, because they carry its id and their removal would stop its next run.
      // A restart, even one requested during this tick, starts nothing new and waits for the runs in flight.
      const started = new Set([...running.keys(), ...cleanupPending]);
      while (running.size < laneCount && health.pausedUntil <= now && !existsSync(restart)) {
        const entry = nextRequest(requests.filter(candidate => !started.has(candidate.id)), health, now);
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
  return runService({ root, repo, commit: git(["rev-parse", "HEAD"], here), lanes: () => verificationLanes(process.env) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code ?? 0), error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
