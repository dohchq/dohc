// The host's verification queue. One service runs whole-PR verifications one
// at a time in its own checkout, so waiting costs no process, and a request
// survives the agent, shell, or T3 session that made it.
//
// Layout under the queue root. Each file has one writer.
//   inbox/<key>.json             a client's submission (client)
//   keys/<key>                   the request id a submission became (service)
//   requests/<id>/request.json   the accepted request, never changed (service)
//   requests/<id>/status.json    its state and attempts (service)
//   requests/<id>/cancel         a cancellation request (client)
//   requests/<id>/attempts/<n>/  one worker's evidence (worker)
//   service.json                 service identity, heartbeat, and health (service)
//   lane/                        the checkout the service verifies in
//   service/<commit>/, current   installed service checkouts, and the active one

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { git } from "./process.mjs";

export const protocol = 1;
// "error" ends a request the host kept failing; it carries no verdict about the change.
export const terminalStates = new Set(["passed", "failed", "error", "cancelled", "superseded"]);

/**
 * The queue root on a host that runs the service, else null. CI, other
 * platforms, and runs with their own slot root (tests and trials) verify inline.
 */
export function queueRoot(env = process.env, platform = process.platform) {
  if (env.DOHC_VERIFICATION_QUEUE_ROOT) return env.DOHC_VERIFICATION_QUEUE_ROOT;
  const budget = platform === "win32" && !env.DOHC_BUILD_SLOT_ROOT ? resolveBuildBudget(env) : null;
  return budget ? join(dirname(budget.root), "_verification") : null;
}

export const queuePaths = root => ({
  inbox: join(root, "inbox"),
  keys: join(root, "keys"),
  requests: join(root, "requests"),
  service: join(root, "service.json"),
  history: join(root, "history.jsonl"),
  lane: join(root, "lane"),
  installs: join(root, "service"),
  current: join(root, "current"),
  control: join(root, "control"),
  request: id => join(root, "requests", id),
  attempt: (id, n) => join(root, "requests", id, "attempts", String(n)),
});

const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Windows antivirus and indexers briefly lock new files; retry before giving up. */
export async function withFileRetry(action, attempts = 8) {
  for (let attempt = 1; ; attempt += 1) {
    try { return action(); }
    catch (error) {
      if (!retryable.has(error.code) || attempt >= attempts) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

/** Write JSON so readers see the old or the new bytes, never a mix, and so it survives a crash. */
export async function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { await withFileRetry(() => renameSync(temporary, path)); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/** A JSON file, or null when it does not exist or is torn. Torn files are rewritten by their one writer. */
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function names(path) {
  try { return readdirSync(path); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** Every accepted request with its status, in line order. `finished` holds entries already known to be final. */
export function listRequests(root, finished = new Map()) {
  const paths = queuePaths(root);
  return names(paths.requests).sort().flatMap(id => {
    if (finished.has(id)) return [finished.get(id)];
    const request = readJson(join(paths.request(id), "request.json"));
    // A status not written yet belongs to a request just accepted. One that exists but cannot be read
    // now, held by antivirus for example, is skipped this time: read as new, it would run again from attempt 1.
    let status;
    try { status = JSON.parse(readFileSync(join(paths.request(id), "status.json"), "utf8")); }
    catch (error) { status = error.code === "ENOENT" ? { state: "queued", attempts: [] } : null; }
    return request && status ? [{ id, request, status }] : [];
  });
}

/** The identity two submissions share when one can stand in for the other. */
export const lineKey = request => `${(request.branch ?? request.checkout).toLowerCase()}\n${request.scope}`;
const sameWork = (a, b) => a.head === b.head && a.scope === b.scope && Boolean(a.full) === Boolean(b.full)
  && a.gates?.rust === b.gates?.rust && a.gates?.js === b.gates?.js;

/**
 * Where a submission goes. A live request on the same branch for the same
 * work takes it, so does a pass of the same commit with the same gates. A
 * newer commit replaces a queued request on its branch and keeps its place;
 * a running one finishes, because someone may already rely on it.
 */
export function placeSubmission(requests, submission) {
  const live = requests.filter(entry => !terminalStates.has(entry.status.state));
  const attach = live.find(entry => lineKey(entry.request) === lineKey(submission) && sameWork(entry.request, submission))
    ?? requests.findLast(entry => entry.status.state === "passed" && sameWork(entry.request, submission));
  if (attach) return { attach: attach.id };
  const replaced = live.filter(entry => entry.status.state === "queued" && lineKey(entry.request) === lineKey(submission));
  return { supersede: replaced.map(entry => entry.id), sequence: replaced[0]?.request.sequence ?? null };
}

/** The oldest request that can run now. A request waiting on Docker does not hold back one that needs none. */
export function nextRequest(requests, { diskOk, dockerOk }, now = Date.now()) {
  if (!diskOk) return null;
  return requests.find(({ request, status }) => status.state === "queued"
    && (!status.notBefore || Date.parse(status.notBefore) <= now)
    && (!request.gates?.js || dockerOk)) ?? null;
}

/** Backoff after an environment failure: 30 s, 2 min, 5 min, then every 15 min. */
export const retryDelayMs = failures => [30_000, 120_000, 300_000][failures - 1] ?? 900_000;

/**
 * What one attempt proved. Only a receipt that names this exact attempt
 * counts; anything else means the attempt did not finish its checks.
 */
export function attemptOutcome(result, grant, { stopped } = {}) {
  if (stopped === "time limit") return { outcome: "failed", cause: "time limit", reason: "The run passed its time limit. Read the last step's log for a hang." };
  // Only machine failures lead to another attempt, so a run cut short by the shared budget gets no verdict.
  if (stopped === "time budget") return { outcome: "error", cause: "time budget", reason: "Its attempts used the request's time limit after machine failures." };
  if (stopped === "cancelled") return { outcome: "cancelled", cause: "cancelled" };
  const matches = result?.grant && result.grant.request === grant.request && result.grant.attempt === grant.attempt
    && result.commit === grant.head && result.baseCommit === grant.base;
  if (!matches) return { outcome: "environment", cause: stopped ?? "no receipt", reason: "The worker ended without a receipt for this attempt." };
  if (result.final !== true) return { outcome: "environment", cause: stopped ?? "unfinished", reason: "The worker stopped before its receipt was final." };
  if (result.verdict === "PASS") return { outcome: "passed", cause: "pass" };
  if (result.verdict === "FAIL" && result.failure?.kind === "check") return { outcome: "failed", cause: "check", reason: result.error };
  if (result.verdict === "FAIL") return { outcome: "environment", cause: result.failure?.cause ?? "environment", reason: result.error };
  return { outcome: "environment", cause: "unfinished", reason: "The receipt has no verdict." };
}

/** Position among live requests, 1 for the running one. */
export function position(requests, id) {
  const live = requests.filter(entry => !terminalStates.has(entry.status.state))
    .sort((a, b) => (a.status.state === "running" ? -1 : 0) - (b.status.state === "running" ? -1 : 0) || a.id.localeCompare(b.id));
  const index = live.findIndex(entry => entry.id === id);
  return index < 0 ? null : index + 1;
}

/** Hand a submission to the service. Returns its key; the service turns it into a request. */
export async function submit(root, submission) {
  const key = submission.key ?? randomUUID();
  await writeJson(join(queuePaths(root).inbox, `${key}.json`), { protocol, ...submission, key, submittedAt: new Date().toISOString() });
  return key;
}

export function requestForKey(root, key) {
  return readJson(join(queuePaths(root).keys, key))?.id ?? null;
}

/** Ask the service to stop a request. Repeating it is harmless; a finished request keeps its verdict. */
export async function cancel(root, id) {
  if (!existsSync(join(queuePaths(root).request(id), "request.json"))) throw new Error(`No verification request ${id}.`);
  await withFileRetry(() => closeSync(openSync(join(queuePaths(root).request(id), "cancel"), "a")));
}

/** The service's own record, and whether its heartbeat is current. */
export function serviceState(root, now = Date.now()) {
  const record = readJson(queuePaths(root).service);
  return { record, alive: Boolean(record && now - Date.parse(record.heartbeatAt) < 60_000) };
}

export const taskName = "dohc-verification-queue";

/** Start the installed service if its heartbeat is not current. Starting a running task does nothing. */
export function ensureService(root, { start = () => spawnSync("schtasks.exe", ["/run", "/tn", taskName], { windowsHide: true, encoding: "utf8" }) } = {}) {
  if (serviceState(root).alive) return;
  const result = start();
  if (result.status !== 0) throw new Error(`The verification queue service is not installed on this host (${(result.stderr || result.stdout || "").trim()}). Run pnpm verify:queue install from a checkout of origin/main.`);
}

/** Median awake minutes of recent passing attempts, for estimates only. */
export function typicalRunMs(root) {
  try {
    const text = readFileSync(queuePaths(root).history, "utf8");
    const runs = text.slice(-256 * 1024).trim().split("\n").slice(-400)
      .flatMap(line => { try { const event = JSON.parse(line); return event.event === "finished" && event.outcome === "passed" && event.awakeMs > 0 ? [event.awakeMs] : []; } catch { return []; } })
      .slice(-20).sort((a, b) => a - b);
    return runs.length ? runs[Math.floor(runs.length / 2)] : null;
  } catch { return null; }
}

/**
 * Submit a verification and follow it. Stopping this process never stops the
 * request: running the same command again follows it, or returns its result.
 */
export async function verifyThroughQueue({ root, submission, detach = false, checkpoint = async () => {}, log = line => console.log(`[queue] ${line}`), pollMs = 3000 }) {
  ensureService(root);
  const key = await submit(root, submission);
  let id;
  for (let waited = 0; !(id = requestForKey(root, key)); waited += pollMs) {
    const answer = readJson(join(queuePaths(root).keys, key));
    if (answer?.rejected) throw new Error(answer.rejected);
    if (waited && waited % 60_000 < pollMs) log(serviceState(root).alive ? "waiting for the service to accept the request" : "the service is not running; the request waits in its inbox");
    await checkpoint();
    await sleep(pollMs);
  }
  const answer = readJson(join(queuePaths(root).keys, key));
  if (answer?.rejected) throw new Error(answer.rejected);
  id = answer.id;
  log(`request ${id}. Follow it with pnpm verify:queue status, stop it with pnpm verify:queue cancel ${id}.`);
  if (detach) return { id, state: "queued" };
  let shown = "";
  let shownAt = 0;
  let missing = 0;
  const follow = async () => {
    try { await checkpoint(); }
    catch (error) { log(`stopped following ${id}; the request continues. Run the same command again to follow it.`); throw error; }
  };
  for (;;) {
    const requests = listRequests(root);
    const entry = requests.find(candidate => candidate.id === id);
    // A record being replaced can read as missing for a moment.
    if (!entry && (missing += 1) > 10) throw new Error(`Request ${id} disappeared from ${root}.`);
    if (!entry) { await follow(); await sleep(pollMs); continue; }
    missing = 0;
    const { status } = entry;
    if (terminalStates.has(status.state)) {
      if (status.state === "superseded") log(`superseded by ${status.supersededBy}, a newer commit on the same branch`);
      log(`${status.state}${status.result ? `: ${status.result}` : ""}`);
      return { id, state: status.state, verdict: status.verdict ?? null, result: status.result ?? null, reason: status.reason ?? null, attempts: status.attempts.length, supersededBy: status.supersededBy ?? null };
    }
    const place = position(requests, id);
    const typical = typicalRunMs(root);
    const current = status.state === "running" ? readJson(join(queuePaths(root).attempt(id, status.attempts.at(-1).n), "result.json"))?.timings?.at(-1)?.name : null;
    const line = status.state === "running" ? `running attempt ${status.attempts.at(-1).n}${current ? `, ${current}` : ""}`
      : `queued at position ${place}${typical && place ? `, about ${Math.round(((place - 1) * typical) / 60_000)} min until it starts` : ""}${status.waiting ? `; ${status.waiting}` : ""}`;
    if (line !== shown || Date.now() - shownAt > 5 * 60_000) { log(line); shown = line; shownAt = Date.now(); }
    await follow();
    await sleep(pollMs);
  }
}

export function taskDefinition(root) {
  const xml = text => text.replace(/[&<>"]/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const command = `--headless pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(root, "supervisor.ps1")}" -Root "${root}"`;
  // Logon starts it. Every five minutes a time trigger restarts a supervisor that died; a logon trigger's own
  // repetition would only begin at the next logon, leaving the session that installed it unguarded. IgnoreNew keeps one.
  // Priority 4 is normal: Task Scheduler's default of 7 runs every gate in the lane below normal CPU and I/O priority.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger>
    <TimeTrigger><Enabled>true</Enabled><StartBoundary>2026-01-01T00:00:00</StartBoundary><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xml(command)}</Arguments></Exec></Actions>
</Task>
`;
}

/** Install or upgrade the service to `ref` from this checkout's repository. It switches between runs, never during one. */
async function install(root, ref) {
  if (process.platform !== "win32") throw new Error("The queue service runs on Windows hosts. Elsewhere pnpm verify:pr runs inline.");
  const here = fileURLToPath(new URL("../..", import.meta.url));
  const repo = resolve(git(["rev-parse", "--git-common-dir"], here), "..");
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`], here);
  const paths = queuePaths(root);
  const short = commit.slice(0, 12);
  const dir = join(paths.installs, short);
  mkdirSync(paths.installs, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    git(["worktree", "add", "--detach", "--force", dir, commit], repo);
    // Workspace cleanup keeps locked worktrees, so a rollback install survives it.
    git(["worktree", "lock", "--reason", "dohc verification queue service", dir], repo);
  }
  const check = spawnSync(process.execPath, [join(dir, "scripts/verification/queue-service.mjs"), "--self-test", "--root", root], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (check.status !== 0) throw new Error(`The service at ${short} failed its self-test, so the current one stays active:\n${check.stderr || check.stdout}`);
  // The running supervisor keeps its script and its task's settings until it restarts.
  const supervisorScript = join(root, "supervisor.ps1");
  const definition = join(root, "task.xml");
  const before = [supervisorScript, definition].map(path => existsSync(path) ? readFileSync(path) : null);
  copyFileSync(join(dir, "scripts/verification/queue-supervisor.ps1"), supervisorScript);
  const previous = existsSync(paths.current) ? readFileSync(paths.current, "utf8").trim() : null;
  await withFileRetry(() => { writeFileSync(`${paths.current}.tmp`, short); renameSync(`${paths.current}.tmp`, paths.current); });
  writeFileSync(definition, `﻿${taskDefinition(root)}`, "utf16le");
  const created = spawnSync("schtasks.exe", ["/create", "/tn", taskName, "/xml", definition, "/f"], { encoding: "utf8", windowsHide: true });
  if (created.status !== 0) throw new Error(`Task Scheduler refused the service task: ${created.stderr || created.stdout}`);
  if (serviceState(root).alive && previous !== short) {
    // The running service exits when idle; the supervisor then starts this one.
    mkdirSync(paths.control, { recursive: true });
    writeFileSync(join(paths.control, "restart"), "");
  } else if (!serviceState(root).alive) spawnSync("schtasks.exe", ["/run", "/tn", taskName], { windowsHide: true });
  // Keep the active, the previous, and the running installation; older ones are removed.
  const runningInstall = serviceState(root).record?.commit?.slice(0, 12);
  for (const name of readdirSync(paths.installs).filter(name => ![short, previous, runningInstall].includes(name))) {
    try { git(["worktree", "remove", "--force", "--force", join(paths.installs, name)], repo); }
    catch (error) { console.error(`could not remove the old install ${name}: ${error.message}`); }
  }
  console.log(`verification queue service ${short} installed at ${root}${previous && previous !== short ? `, replacing ${previous} once the current run ends` : ""}.`);
  const changed = [supervisorScript, definition].some((path, index) => !before[index]?.equals(readFileSync(path)));
  if (changed && serviceState(root).alive) console.log("The supervisor or its task changed. Run pnpm verify:queue restart when no run is in progress to apply it.");
}

function printStatus(root) {
  const { record, alive } = serviceState(root);
  const requests = listRequests(root);
  const typical = typicalRunMs(root);
  const minutes = ms => `${Math.round(ms / 60_000)} min`;
  console.log(`service: ${alive ? `running ${record.commit?.slice(0, 12) ?? ""} (pid ${record.pid})` : record ? `not responding since ${record.heartbeatAt}` : "never started"}`);
  if (record?.health?.reason) console.log(`health: ${record.health.reason}`);
  if (record?.health?.diskFreeGb != null) console.log(`free disk: ${record.health.diskFreeGb.toFixed(1)} GB`);
  const live = requests.filter(entry => !terminalStates.has(entry.status.state));
  for (const entry of live.sort((a, b) => position(requests, a.id) - position(requests, b.id))) {
    const place = position(requests, entry.id);
    const where = entry.status.state === "running" ? `running attempt ${entry.status.attempts.at(-1)?.n}` : `#${place}${typical ? `, starts in about ${minutes((place - 1) * typical)}` : ""}`;
    console.log(`${entry.id}  ${where}  ${entry.request.scope}  ${entry.request.head.slice(0, 12)}  ${entry.request.branch?.replace("refs/heads/", "") ?? entry.request.checkout}${entry.status.waiting ? `  (${entry.status.waiting})` : ""}`);
  }
  if (!live.length) console.log("no requests waiting");
  for (const entry of requests.filter(entry => terminalStates.has(entry.status.state)).slice(-8)) {
    console.log(`${entry.id}  ${entry.status.state}${entry.status.cause && entry.status.state !== "passed" ? ` (${entry.status.cause})` : ""}  ${entry.request.head.slice(0, 12)}  ${entry.status.result ?? ""}`);
  }
}

async function main([command, ...args]) {
  const root = queueRoot();
  if (!root) throw new Error("This host has no verification queue. pnpm verify:pr runs inline here.");
  const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "origin/main";
  if (command === "status" || !command) return printStatus(root);
  if (command === "cancel") { await cancel(root, args[0]); return console.log(`asked the service to stop ${args[0]}`); }
  if (command === "install" || command === "upgrade") return install(root, ref);
  if (command === "restart") {
    const { record, alive } = serviceState(root);
    if (record?.running && !args.includes("--now")) throw new Error("A run is in progress. Wait for it, or pass --now to stop it; it will be retried.");
    // The task's own process is conhost, so ending the task leaves the supervisor running. Stop the supervisor
    // itself; its job stops the service and any run. The task starts a new one once the old one has exited.
    const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
    if (alive && record.supervisor) {
      try { process.kill(record.supervisor); } catch { /* Already stopped. */ }
      for (let waited = 0; waited < 10_000 && exists(record.supervisor); waited += 200) await sleep(200);
    }
    spawnSync("schtasks.exe", ["/end", "/tn", taskName], { windowsHide: true });
    spawnSync("schtasks.exe", ["/run", "/tn", taskName], { windowsHide: true });
    return console.log("restarted the verification queue service");
  }
  throw new Error("Use status, cancel <id>, install [--ref <ref>], upgrade [--ref <ref>], or restart [--now].");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
