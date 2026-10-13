// The verification queue service. It accepts submissions, runs one PR
// verification at a time in its own checkout, and records every outcome.
// A supervisor (queue-supervisor.ps1) starts it inside a job object that
// stops every descendant when the service exits, so restart recovery never
// meets a worker left running.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { git, run } from "./process.mjs";
import { acquireVerificationSlot, freeDiskGb, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { attemptOutcome, listRequests, nextRequest, placeSubmission, protocol, queuePaths, readJson, retryDelayMs, terminalStates, writeJson } from "./queue.mjs";

const verifierEntry = fileURLToPath(new URL("./verify.mjs", import.meta.url));
const sha = /^[0-9a-f]{40}$/u;
const names = path => { try { return readdirSync(path); } catch { return []; } };

/** Remove a request's containers, and stopped ones that killed runs left behind. */
export async function sweepContainers({ request, command = run } = {}) {
  const list = async filters => {
    const result = await command("docker", ["ps", "--all", "--quiet", ...filters.flatMap(filter => ["--filter", filter])], { timeoutMs: 30_000, quietStdout: true });
    return result.stdout.split(/\s+/u).filter(Boolean);
  };
  const ids = new Set(await list([request ? `label=dohc.verification=${request}` : "label=dohc.verification"]));
  // Unlabeled containers come from runs that predate labels. Only stopped ones are certainly orphans.
  for (const status of ["exited", "created", "dead"]) for (const id of await list(["name=dohc-verify-", `status=${status}`])) ids.add(id);
  if (ids.size) await command("docker", ["rm", "--force", ...ids], { timeoutMs: 60_000, quietStdout: true });
  return ids.size;
}

/** Put the lane at `head` with no state from earlier runs except the named caches. */
export async function prepareLane({ lane, repo, head }) {
  if (!existsSync(join(lane, ".git"))) git(["worktree", "add", "--detach", "--force", lane, head], repo);
  const gitDir = git(["rev-parse", "--absolute-git-dir"], lane);
  // No worker runs while the lane is prepared, so any Git lock or operation state is stale.
  for (const name of ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) rmSync(join(gitDir, name), { force: true });
  git(["checkout", "--force", "--detach", head], lane);
  git(["clean", "-ffdx", "--exclude=node_modules", "--exclude=target"], lane);
  if (git(["rev-parse", "HEAD"], lane) !== head) throw new Error(`The lane did not check out ${head}.`);
  if (git(["status", "--porcelain"], lane) !== "") throw new Error("The lane has changes after checkout and clean.");
  if (!existsSync(join(lane, "node_modules", "pnpm"))) await run(process.execPath, ["scripts/verification/setup.mjs"], { cwd: lane, quietStdout: true, timeoutMs: 30 * 60_000 });
}

export async function dockerResponds(command = run) {
  try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000, quietStdout: true }); return true; }
  catch { return false; }
}

/** Hold the host lane's slot, so a run started by older code cannot overlap this one. */
async function holdLegacyLane({ entry }) {
  return acquireVerificationSlot(process.env, { entry: verifierEntry,
    metadata: { purpose: "PR verification (queue)", checkout: entry.request.checkout, commit: entry.request.head, phase: `request ${entry.id}` } });
}

/** Run the lane's own verifier for one attempt. */
async function defaultWorker({ lane, request, grant, output, signal }) {
  const args = ["scripts/verification/verify.mjs", "pr", "--base", request.base,
    ...(request.scope === "all" ? [] : ["--job", request.scope]), ...(request.full ? ["--full"] : []),
    ...(request.reuseRust ? ["--reuse-rust", request.reuseRust] : [])];
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
  worker = defaultWorker, retryDelay = retryDelayMs, stop, log = defaultLog(root),
}) {
  const paths = queuePaths(root);
  for (const path of [paths.inbox, paths.keys, paths.requests, paths.control]) mkdirSync(path, { recursive: true });
  const instance = await holdInstance(root);
  if (!instance) { log("another service already serves this queue root"); return 0; }
  const startedAt = new Date().toISOString();
  const health = { diskFreeGb: null, diskOk: true, dockerOk: true, dockerCheckedAt: 0, pausedUntil: 0, environmentStreak: 0, reason: null };
  let running = null;
  let lastBeat = 0;
  let lastPrune = 0;

  // A finished request never changes again, so it is read once.
  const finished = new Map();
  const load = () => listRequests(root, finished).map(entry => {
    if (terminalStates.has(entry.status.state)) finished.set(entry.id, entry);
    return entry;
  });
  let sequence = Math.max(0, ...load().map(entry => entry.request.sequence ?? 0));

  const statusPath = id => join(paths.request(id), "status.json");
  const setStatus = (id, status) => writeJson(statusPath(id), { ...status, updatedAt: new Date().toISOString() });
  const history = event => { try { appendFileSync(paths.history, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); } catch { /* History informs estimates only. */ } };
  const beat = () => writeJson(paths.service, {
    protocol, pid: process.pid, commit, startedAt, heartbeatAt: new Date().toISOString(),
    running: running && { id: running.id, attempt: running.attempt, phase: running.phase, startedAt: running.startedAt, awakeMs: running.awakeMs },
    health: { diskFreeGb: health.diskFreeGb, diskOk: health.diskOk, dockerOk: health.dockerOk,
      pausedUntil: health.pausedUntil ? new Date(health.pausedUntil).toISOString() : null, reason: health.reason },
  });

  async function finish(entry, attempt, outcome, { cleanup = false } = {}) {
    const status = readJson(statusPath(entry.id)) ?? entry.status;
    const attempts = status.attempts.map(row => row.n === attempt?.n ? { ...row, endedAt: new Date().toISOString(), awakeMs: attempt.awakeMs, ...outcome } : row);
    if (cleanup) await sweep({ request: entry.id }).catch(error => log(`container cleanup for ${entry.id} failed: ${error.message}`));
    if (outcome.outcome === "environment") {
      const failures = attempts.filter(row => row.outcome === "environment").length;
      health.environmentStreak += 1;
      // Repeated machine failures across requests mean the host is unwell; stop admitting for a while.
      if (health.environmentStreak >= 2) health.pausedUntil = Date.now() + retryDelay(health.environmentStreak - 1);
      await setStatus(entry.id, { ...status, state: "queued", attempts,
        notBefore: new Date(Date.now() + retryDelay(failures)).toISOString(),
        waiting: `${outcome.cause}: ${outcome.reason ?? "environment failure."} Retrying.` });
    } else {
      if (attempt) { health.environmentStreak = 0; health.pausedUntil = 0; }
      await setStatus(entry.id, { ...status, state: outcome.outcome, attempts, notBefore: null, waiting: null,
        verdict: outcome.outcome === "passed" ? "PASS" : outcome.outcome === "failed" ? "FAIL" : null,
        result: attempt ? join(paths.attempt(entry.id, attempt.n), "result.json") : null, cause: outcome.cause, reason: outcome.reason ?? null });
    }
    history({ event: "finished", id: entry.id, attempt: attempt?.n, awakeMs: attempt?.awakeMs, ...outcome });
  }

  async function reconcile() {
    // A previous service died with requests running. Its job object stopped their workers;
    // a receipt that finished still counts, anything else is retried.
    for (const entry of load().filter(entry => entry.status.state === "running")) {
      const attempt = entry.status.attempts.at(-1);
      const grant = { request: entry.id, attempt: attempt?.n, head: entry.request.head, base: entry.request.base };
      const result = attempt ? readJson(join(paths.attempt(entry.id, attempt.n), "result.json")) : null;
      await finish(entry, attempt, attemptOutcome(result, grant, { stopped: "service restart" }), { cleanup: true });
    }
  }

  async function ingest() {
    for (const name of names(paths.inbox).filter(name => name.endsWith(".json")).sort()) {
      const path = join(paths.inbox, name);
      const key = name.slice(0, -5);
      const submission = readJson(path);
      if (!submission) {
        // A torn submission is still being written, or its writer died.
        try { if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true }); } catch { /* Gone. */ }
        continue;
      }
      const answer = async value => { await writeJson(join(paths.keys, key), value); rmSync(path, { force: true }); };
      if (existsSync(join(paths.keys, key))) { rmSync(path, { force: true }); continue; }
      const rejection = submission.protocol !== protocol ? `This service speaks queue protocol ${protocol}, not ${submission.protocol}. Run pnpm verify:queue upgrade from a checkout of origin/main.`
        : !sha.test(submission.head ?? "") || !sha.test(submission.base ?? "") ? "The submission has no full head and base commit."
        : !["all", "js", "rust"].includes(submission.scope) ? `Unknown scope ${submission.scope}.`
        : (() => {
          try { git(["cat-file", "-e", `${submission.head}^{commit}`], repo); git(["cat-file", "-e", `${submission.base}^{commit}`], repo); return null; }
          catch { return "The head or base commit is not in this host's repository."; }
        })();
      if (rejection) { await answer({ rejected: rejection }); continue; }
      const requests = load();
      const place = placeSubmission(requests, submission);
      // A request whose attempt is starting is no longer waiting; it finishes like a running one.
      if (place.supersede) {
        place.supersede = place.supersede.filter(id => id !== running?.id);
        place.sequence = requests.find(candidate => candidate.id === place.supersede[0])?.request.sequence ?? null;
      }
      if (place.attach) { await answer({ id: place.attach }); continue; }
      const order = place.sequence ?? ++sequence;
      const id = `${String(order).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
      // Pin both commits before accepting, so an accepted request can always be verified.
      git(["update-ref", `refs/verification-queue/${id}/head`, submission.head], repo);
      git(["update-ref", `refs/verification-queue/${id}/base`, submission.base], repo);
      const { key: _key, protocol: _protocol, ...fields } = submission;
      await writeJson(join(paths.request(id), "request.json"), { ...fields, id, sequence: order, acceptedAt: new Date().toISOString(), supersedes: place.supersede });
      await setStatus(id, { state: "queued", attempts: [] });
      for (const old of place.supersede) await setStatus(old, { ...requests.find(entry => entry.id === old).status, state: "superseded", supersededBy: id });
      await answer({ id });
      history({ event: "accepted", id, head: submission.head, scope: submission.scope, supersedes: place.supersede });
    }
  }

  async function attempt(entry) {
    const n = (entry.status.attempts.at(-1)?.n ?? 0) + 1;
    const output = paths.attempt(entry.id, n);
    const grant = { request: entry.id, attempt: n, head: entry.request.head, base: entry.request.base };
    const current = { id: entry.id, attempt: n, startedAt: new Date().toISOString(), phase: "preparing", awakeMs: 0, abort: new AbortController(), stopped: undefined };
    running = current;
    let lease;
    try {
      await setStatus(entry.id, { ...entry.status, state: "running", attempts: [...entry.status.attempts, { n, startedAt: current.startedAt }], notBefore: null, waiting: null });
      history({ event: "started", id: entry.id, attempt: n });
      mkdirSync(output, { recursive: true });
      await prepare({ lane, repo, head: entry.request.head });
      current.phase = "waiting for the host lane";
      lease = await holdLane({ entry });
      // Rust-only runs need no Docker, so a sweep failure must not stop them.
      await sweep({}).catch(error => log(`container sweep failed: ${error.message}`));
      current.phase = "verifying";
      if (!current.stopped) await worker({ lane, request: entry.request, grant, output, signal: current.abort.signal });
    } catch (error) {
      if (!current.stopped) log(`attempt ${entry.id}/${n} ended early: ${error.stack ?? error.message}`);
    } finally {
      lease?.release();
      running = null;
      const outcome = attemptOutcome(readJson(join(output, "result.json")), grant, { stopped: current.stopped });
      await finish({ ...entry, status: readJson(statusPath(entry.id)) ?? entry.status }, { n, awakeMs: current.awakeMs }, outcome, { cleanup: true });
    }
  }

  async function checkHealth(requests) {
    health.diskFreeGb = freeDisk();
    health.diskOk = health.diskFreeGb === null || health.diskFreeGb >= floorGb;
    if (!health.diskOk && existsSync(join(lane, "target"))) {
      // The lane's build output is the one large thing the service owns and may delete.
      log(`free disk ${health.diskFreeGb.toFixed(1)} GB is under ${floorGb} GB; removing the lane's target folder`);
      rmSync(join(lane, "target"), { recursive: true, force: true });
      health.diskFreeGb = freeDisk();
      health.diskOk = health.diskFreeGb === null || health.diskFreeGb >= floorGb;
    }
    if (requests.some(entry => entry.status.state === "queued" && entry.request.gates?.js) && Date.now() - health.dockerCheckedAt > 60_000) {
      health.dockerOk = await docker();
      health.dockerCheckedAt = Date.now();
    }
    health.reason = !health.diskOk ? `waiting for disk: ${health.diskFreeGb.toFixed(1)} GB free, ${floorGb} GB needed`
      : health.pausedUntil > Date.now() ? `paused after ${health.environmentStreak} environment failures in a row`
      : !health.dockerOk ? "Docker is not responding; runs with the JavaScript gate wait" : null;
  }

  function prune(requests) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    for (const entry of requests) {
      if (!terminalStates.has(entry.status.state) || Date.parse(entry.status.updatedAt ?? 0) > cutoff) continue;
      for (const name of ["head", "base"]) { try { git(["update-ref", "-d", `refs/verification-queue/${entry.id}/${name}`], repo); } catch { /* Already gone. */ } }
      rmSync(paths.request(entry.id), { recursive: true, force: true });
      finished.delete(entry.id);
    }
    for (const key of names(paths.keys)) {
      const id = readJson(join(paths.keys, key))?.id;
      if (id && !existsSync(paths.request(id))) rmSync(join(paths.keys, key), { force: true });
    }
  }

  await reconcile();
  log(`service ${commit ?? "(unversioned)"} started, pid ${process.pid}`);
  let last = Date.now();
  try {
    for (;;) {
      if (stop?.aborted) return 0;
      const now = Date.now();
      // Count only awake verification time against a run: a gap far over one tick is sleep.
      if (running?.phase === "verifying") running.awakeMs += Math.min(now - last, 3 * tickMs);
      last = now;
      await ingest();
      for (const entry of load().filter(entry => entry.status.state === "queued" && existsSync(join(paths.request(entry.id), "cancel")))) {
        await finish(entry, null, { outcome: "cancelled", cause: "cancelled" });
      }
      const requests = load();
      if (running && !running.stopped) {
        if (existsSync(join(paths.request(running.id), "cancel"))) running.stopped = "cancelled";
        else if (running.awakeMs > timeLimitMs) running.stopped = "time limit";
        if (running.stopped) { log(`stopping ${running.id}: ${running.stopped}`); running.abort.abort(); }
      }
      if (!running) {
        if (existsSync(join(paths.control, "restart"))) { rmSync(join(paths.control, "restart"), { force: true }); log("restart requested"); return 75; }
        await checkHealth(requests);
        const entry = health.pausedUntil > now ? null : nextRequest(requests, health, now);
        if (entry) attempt(entry).catch(error => log(`attempt bookkeeping failed: ${error.stack ?? error.message}`));
        if (now - lastPrune > 10 * 60_000) { prune(requests); lastPrune = now; }
      }
      if (now - lastBeat > 10_000) { await beat(); lastBeat = now; }
      await sleep(tickMs);
    }
  } finally {
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
    for await (const chunk of process.stdin) if (String(chunk).includes("go")) break;
  }
  const repo = resolve(git(["rev-parse", "--git-common-dir"], here), "..");
  return runService({ root, repo, commit: git(["rev-parse", "HEAD"], here) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code ?? 0), error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
