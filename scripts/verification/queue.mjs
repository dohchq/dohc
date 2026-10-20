// The host's verification queue. One service runs whole-PR verifications one
// at a time in its own checkout, so waiting costs no process, and a request
// survives the agent, shell, or T3 session that made it.
//
// Layout under the queue root. Each file has one writer.
//   inbox/<key>.json             a client's submission (client)
//   moves/<key>.json             a client's request to move a queued request (client)
//   keys/<key>                   the request id a submission became, or the answer to a move (service)
//   requests/<id>/request.json   the accepted request, never changed (service)
//   requests/<id>/status.json    its state, attempts, and any place a move gave it (service)
//   requests/<id>/cancel         a cancellation request (client)
//   requests/<id>/attempts/<n>/  one worker's evidence (worker)
//   service.json                 service identity, heartbeat, and health (service)
//   monitor-load.json            the dashboard's minute samples of host load (service)
//   control/restart              exit once the runs in flight end (client)
//   control/pause                start no run until resume (client, the dashboard, or the service after the computer restarts)
//   lane/                        the checkout the service verifies in
//   service/<commit>/, current   installed service checkouts, and the active one
//   supervisor.ps1, supervisor.mjs  the supervisor launchd or Task Scheduler runs (install)
//   service-tree.json            on a Mac, the service's processes, for the next supervisor (supervisor)

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { buildQueueStatus, heldVerificationSlots, macSlotRoot, maxVerificationLanes, readVerificationLanes, resolveBuildBudget } from "../../tools/rust-engine-program/build-slot.mjs";
import { git } from "./process.mjs";
import { buildEnvHelper, envHelper, heldPath, stopRecorded } from "./queue-supervisor.mjs";

export const protocol = 1;
// "error" ends a request the host kept failing; it carries no verdict about the change.
export const terminalStates = new Set(["passed", "failed", "error", "cancelled", "superseded"]);

/**
 * The queue root on a host that runs the service, else null: beside the build slot root on the shared Windows host,
 * and on a shared Mac once the service is installed there. CI, other platforms, other Macs, and runs with their own
 * slot root (tests and trials) verify inline. `host` replaces the platform, the home folder, and the install check.
 */
export function queueRoot(env = process.env, { platform = process.platform, home, installed = root => existsSync(join(root, "current")) } = {}) {
  if (env.DOHC_VERIFICATION_QUEUE_ROOT) return env.DOHC_VERIFICATION_QUEUE_ROOT;
  const budget = ["win32", "darwin"].includes(platform) && !env.DOHC_BUILD_SLOT_ROOT ? resolveBuildBudget(env, { platform, home }) : null;
  const root = budget ? join(dirname(budget.root), "_verification") : null;
  // A Mac uninstalled again verifies inline, though it keeps its slot root.
  return root && (platform !== "darwin" || installed(root)) ? root : null;
}

export const queuePaths = root => ({
  inbox: join(root, "inbox"),
  moves: join(root, "moves"),
  keys: join(root, "keys"),
  requests: join(root, "requests"),
  service: join(root, "service.json"),
  history: join(root, "history.jsonl"),
  lane: join(root, "lane"),
  installs: join(root, "service"),
  current: join(root, "current"),
  control: join(root, "control"),
  pause: join(root, "control", "pause"),
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

/** Write a file so readers see the old or the new bytes, never a mix, and so it survives a crash. */
export async function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { await withFileRetry(() => renameSync(temporary, path)); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export const writeJson = (path, value) => writeText(path, JSON.stringify(value, null, 2) + "\n");

/** Add an event to the queue's history. Losing a line must not stop the queue. */
export function recordHistory(root, event) {
  try { appendFileSync(queuePaths(root).history, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); }
  catch { /* History informs estimates and records moves and lane changes. A request keeps its last move in its status. */ }
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

/** A request's place in line: the order a move gave it, else its sequence. A move changes no id or sequence. */
export const orderOf = entry => entry.status.order ?? entry.request.sequence;
export const lineOrder = (a, b) => orderOf(a) - orderOf(b) || a.id.localeCompare(b.id);

// One line of text: whitespace and control characters become one space, so a field cannot fake a row in status.
const oneLine = (value, length) => typeof value === "string" ? [...value.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim()].slice(0, length).join("") : null;

// A request without a checkout, written by hand, must not stop the line.
const checkoutOwner = (checkout = "unknown checkout") => ({ key: `checkout:${String(checkout).toLowerCase()}`, title: String(checkout), source: "checkout" });

/** Whose turn a request waits for. A request accepted before owners existed belongs to its checkout. */
export const ownerOf = request => request.owner ?? checkoutOwner(request.checkout);

/**
 * The owner of a new request: the T3 thread a person started for its work, with a subagent's thread
 * counted under it, else the name it was submitted with by --owner, else its checkout.
 * A T3 lookup that fails names no thread.
 */
export function ownerFor(submission, threadOf) {
  let thread = null;
  try { thread = submission.nightly ? null : threadOf(submission.branch?.replace(/^refs\/heads\//u, "") ?? null, submission.checkout)?.root ?? null; }
  catch { /* T3's database can be locked or migrating. */ }
  const name = oneLine(submission.ownerName, 100);
  return thread ? { key: `thread:${thread.id}`, title: oneLine(thread.title, 200) || thread.id, source: "thread" }
    : name ? { key: `flag:${name.toLowerCase()}`, title: name, source: "flag" }
    : checkoutOwner(submission.checkout);
}

const movedFirst = entry => Boolean(entry.status.moved) && !entry.status.moved.before;

/**
 * Every live request in the order it runs: the running ones, the nightly run, the requests moved
 * first to unblock others, then the owners' turns. Owners with no run in progress go before owners
 * with one. Among each, the owner who has gone longest without a start goes next, and an owner that
 * never started goes first. Each owner's requests keep line order. A request ahead of the turns counts
 * as a run its owner starts before them, so the line is the order the service starts it while no run
 * ends. An attempt that failed because of the machine uses no turn. Requests accepted before owners
 * existed record no starts, so right after an upgrade they keep the line order they had.
 * A waiting request that fails `canStart` takes no place in the line, but its runs still count.
 */
export function runOrder(requests, { canStart = () => true } = {}) {
  const live = requests.filter(entry => !terminalStates.has(entry.status.state)).sort(lineOrder);
  const waiting = live.filter(entry => entry.status.state !== "running" && canStart(entry));
  const front = waiting.filter(entry => entry.request.nightly || movedFirst(entry));
  const ahead = [...front.filter(entry => entry.request.nightly), ...front.filter(entry => !entry.request.nightly)];
  const lastStart = new Map();
  const busy = new Set();
  for (const entry of requests.filter(entry => entry.request.owner)) {
    const { key } = entry.request.owner;
    if (entry.status.state === "running") busy.add(key);
    for (const attempt of entry.status.attempts) {
      const at = Date.parse(attempt.startedAt);
      if (attempt.outcome !== "environment" && at > (lastStart.get(key) ?? 0)) lastStart.set(key, at);
    }
  }
  // The requests ahead of the turns start first, so their owners have a run in progress, started last, when the turns begin.
  let latest = Math.max(0, ...lastStart.values());
  for (const entry of ahead.filter(entry => entry.request.owner)) {
    busy.add(entry.request.owner.key);
    lastStart.set(entry.request.owner.key, latest += 1);
  }
  // Each owner's waiting requests, the owners in line order of their first request, which settles a tie.
  const owners = new Map();
  for (const entry of waiting) {
    if (ahead.includes(entry)) continue;
    const { key } = ownerOf(entry.request);
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(entry);
  }
  const turns = [...owners].sort(([a], [b]) => Number(busy.has(a)) - Number(busy.has(b)) || (lastStart.get(a) ?? 0) - (lastStart.get(b) ?? 0)).map(([, entries]) => entries);
  const line = [...live.filter(entry => entry.status.state === "running"), ...ahead];
  for (let round = 0; turns.some(entries => round < entries.length); round += 1) {
    for (const entries of turns) if (round < entries.length) line.push(entries[round]);
  }
  return line;
}

/** A move as a client wrote it, checked and cleaned: `{ id, before, reason, by }`, or `{ rejected }`. */
export function parseMove(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { rejected: "The move is not a JSON object." };
  const by = raw.by ?? {};
  const id = oneLine(raw.id, 64);
  // An empty --before is a mistake, never --first.
  const named = raw.before !== null && raw.before !== undefined;
  const before = named ? oneLine(raw.before, 64) : null;
  const reason = oneLine(raw.reason, 300);
  if (!id) return { rejected: "The move names no request to move." };
  if (named && !before) return { rejected: "The move's --before names no request. Use --first to move a request to the front." };
  if (!reason) return { rejected: "A move needs a reason." };
  if (typeof by !== "object" || Array.isArray(by) || ["name", "user", "cwd"].some(field => by[field] != null && typeof by[field] !== "string")) {
    return { rejected: "The move's by field must hold name, user, and cwd, each text or null." };
  }
  return { id, before, reason, by: { name: oneLine(by.name, 200) || null, user: oneLine(by.user, 200) || null, cwd: oneLine(by.cwd, 200) || null } };
}

/**
 * The line after a move: `{ orders }`, each queued request's order by id, or `{ rejected }` with the reason.
 * A move only brings a queued request forward, to the front or just ahead of another queued request.
 * `starting` names requests the service has started that still read as queued.
 */
export function placeMove(requests, { id, before = null }, starting = new Set()) {
  const waiting = entry => entry.status.state === "queued" && !starting.has(entry.id);
  const why = entry => entry.status.state === "running" || starting.has(entry.id) ? "it is running"
    : entry.status.state === "superseded" ? `it was replaced by ${entry.status.supersededBy}, a newer commit on its branch`
    : `it has already finished: ${entry.status.state}`;
  const entry = requests.find(candidate => candidate.id === id);
  const target = before && requests.find(candidate => candidate.id === before);
  if (!entry) return { rejected: `No verification request ${id}.` };
  if (before && !target) return { rejected: `No verification request ${before}.` };
  if (!waiting(entry)) return { rejected: `Cannot move ${id}: ${why(entry)}. Only a queued request can move.` };
  if (target === entry) return { rejected: `Cannot move ${id} before itself.` };
  if (target && !waiting(target)) return { rejected: `Cannot move ${id} before ${before}: ${why(target)}. Move it before a queued request, or use --first.` };
  // The nightly runs first whatever its place in the line, so a move before it would change nothing.
  if (target?.request.nightly) return { rejected: `Cannot move ${id} before ${before}: the nightly run always goes first. Use --first to put ${id} at the front of the rest of the line.` };
  // A request moved first runs ahead of every turn; one moved before it would only take its owner's turn.
  if (target && movedFirst(target)) return { rejected: `Cannot move ${id} before ${before}: ${before} was moved first, ahead of every owner's turn. Use --first for ${id} if it also unblocks others.` };
  // Owners take turns, so --before can order only one owner's requests.
  if (target && ownerOf(target.request).key !== ownerOf(entry.request).key) {
    return { rejected: `Cannot move ${id} before ${before}: ${before} belongs to ${ownerOf(target.request).title}, and owners take turns. --before orders one owner's requests. Use --first only to unblock others.` };
  }
  const line = requests.filter(waiting).sort(lineOrder);
  if (target && line.indexOf(entry) < line.indexOf(target)) return { rejected: `Cannot move ${id} before ${before}: ${id} is already ahead of ${before}. A move only brings a request forward.` };
  // The line hands its own order values out again in the new order. They stay whole numbers however many
  // moves there are, and stay comparable with the sequence of a request running now, which comes back to
  // its place if it is retried, and with every later submission, which goes behind.
  const values = line.map(orderOf);
  const next = line.filter(candidate => candidate !== entry);
  next.splice(target ? next.indexOf(target) : 0, 0, entry);
  return { orders: new Map(next.map((candidate, index) => [candidate.id, values[index]])) };
}

/**
 * The first request in run order that can run now. Only the requests that can run now take turns,
 * so a request waiting on Docker, a retry's backoff, or the removal of its containers (`cleaning`)
 * does not hold back one that needs none, of its own owner or another. Its runs still count.
 * `started` names requests the service has started that may still read as queued; each counts as a
 * run its owner started now.
 */
export function nextRequest(requests, { diskOk, dockerOk }, now = Date.now(), started = new Set(), cleaning = new Set()) {
  if (!diskOk) return null;
  const ready = ({ id, request, status }) => !cleaning.has(id) && (!status.notBefore || Date.parse(status.notBefore) <= now) && (!request.gates?.js || dockerOk);
  const startedAt = new Date(now).toISOString();
  const view = requests.map(entry => entry.status.state === "queued" && started.has(entry.id)
    ? { ...entry, status: { ...entry.status, state: "running", attempts: [...entry.status.attempts, { startedAt }] } } : entry);
  return runOrder(view, { canStart: ready }).find(entry => entry.status.state === "queued") ?? null;
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

/** Position among live requests in run order, counting the running ones first. */
export function position(requests, id) {
  const index = runOrder(requests).findIndex(entry => entry.id === id);
  return index < 0 ? null : index + 1;
}

/**
 * Submit the nightly verification of main: every gate and every package at
 * main's head, against the last nightly that passed. A head that already
 * passed, or is already waiting, is not verified again.
 */
export async function submitNightly(root, repo, { fetch = () => git(["fetch", "--quiet", "origin", "main"], repo) } = {}) {
  fetch();
  const head = git(["rev-parse", "--verify", "origin/main^{commit}"], repo);
  const last = listRequests(root).findLast(entry => entry.request.nightly && entry.status.state === "passed");
  const base = last?.request.head ?? git(["rev-parse", "--verify", `${head}~1^{commit}`], repo);
  await submit(root, { head, base, scope: "all", full: true, gates: { rust: true, js: true }, branch: "refs/heads/main", checkout: "nightly", nightly: true });
  return { head, base };
}

/** The last nightly run of main that passed, or null. */
export const lastNightlyPass = requests => requests.findLast(entry => entry.request.nightly && entry.status.state === "passed") ?? null;

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

/**
 * Ask the service to move a queued request first in line, or before `before`. The service
 * answers under keys/<key>. A key starts with the time, so moves apply in the order they were asked.
 */
export async function requestMove(root, { id, before = null, reason, by }) {
  const key = `move-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await writeJson(join(queuePaths(root).moves, `${key}.json`), { id, before, reason, by, requestedAt: new Date().toISOString() });
  return key;
}

/**
 * How status and the dashboard describe a request's last move. Every agent on the host runs as the same
 * user, so the checkout that asked always shows, with the --by name or else the user.
 */
export const movedNote = ({ before, by, reason }, separator = ": ") =>
  `moved ${before ? `before ${before}` : "first"} by ${by?.name ?? by?.user ?? "unknown"} (${by?.cwd ?? "unknown checkout"})${separator}${reason}`;

/** The service's own record, and whether its heartbeat is current. */
export function serviceState(root, now = Date.now()) {
  const record = readJson(queuePaths(root).service);
  return { record, alive: Boolean(record && now - Date.parse(record.heartbeatAt) < 60_000) };
}

/** The queue's pause, `{ at, reason, by? }`, or null when the line moves. */
export function readPause(root) {
  const path = queuePaths(root).pause;
  // A marker that antivirus holds for a moment still pauses the queue.
  return readJson(path) ?? (existsSync(path) ? { at: null, reason: null } : null);
}

// The reason the service records when it holds the line after the computer restarts.
export const restartReason = "the computer restarted";

/**
 * Hold the line: runs in flight finish, and no run starts until resumeQueue, even after the
 * service or the computer restarts. Pausing a paused queue keeps its first record. The reason
 * is kept to one line; `by` optionally records who paused, such as the dashboard and its host name.
 */
export async function pauseQueue(root, { reason = null, by = null } = {}) {
  const current = readPause(root);
  if (current) return { pause: current, changed: false };
  const pause = { at: new Date().toISOString(), reason: oneLine(reason, 300) || null, ...(by ? { by } : {}) };
  await writeJson(queuePaths(root).pause, pause);
  return { pause, changed: true };
}

/** Let the line move again. Returns the pause it ended, or null. */
export async function resumeQueue(root) {
  const pause = readPause(root);
  if (pause) await withFileRetry(() => rmSync(queuePaths(root).pause, { force: true }));
  return pause;
}

const pausedSince = pause => `paused${pause.at ? ` since ${pause.at}` : ""}${pause.reason ? ` (${pause.reason})` : ""}`;

/** For an inline gate's lane wait: why it must not take a lane now, or null. */
export const pauseHold = root => () => {
  const pause = readPause(root);
  return pause && `waiting: the verification queue is ${pausedSince(pause)}; this gate starts after pnpm verify:queue resume`;
};

// The service holds a lane under this purpose for each of its runs. Every other holder is an inline gate.
export const queueLanePurpose = "PR verification (queue)";

/** The root that holds the verification slots and the lane setting: an isolated trial root, else the build slot root. */
export const verificationSlotRoot = (env = process.env) => env.DOHC_VERIFICATION_SLOT_ROOT ?? resolveBuildBudget(env)?.root ?? null;

/** Inline gates holding one of the host's verification lanes, in any lane whatever the lane setting. */
export function inlineRuns(env = process.env) {
  const root = verificationSlotRoot(env);
  return root ? buildQueueStatus({ root, slots: maxVerificationLanes, kind: "verification-slot" }).owners.filter(owner => owner.purpose !== queueLanePurpose).length : 0;
}

/**
 * The lane setting in the slot root, `{ lanes, error, closing }`, or null without a slot root. `lanes` is
 * null when the setting cannot be read, and `error` says why. `closing` lists the held lanes above the
 * setting: each finishes its current gate and takes no more.
 */
export function laneSetting(slotRoot) {
  if (!slotRoot) return null;
  try {
    const lanes = readVerificationLanes(slotRoot);
    return { lanes, error: null, closing: heldVerificationSlots(slotRoot).filter(slot => slot > lanes) };
  } catch (error) { return { lanes: null, error: error.message, closing: [] }; }
}

/** The closing lanes in the words status and the dashboard use, or null when none is closing. */
export const closingNote = closing => !closing?.length ? null : closing.length === 1 ? `lane ${closing[0]} closes after its current gate`
  : `lanes ${closing.slice(0, -1).join(", ")} and ${closing.at(-1)} close after their current gates`;

/**
 * Set the host's lane count, which every verifier and the queue service read. Lowering it stops nothing: a lane
 * above the new count finishes its current gate and takes no more. A change goes to the queue's history with
 * who made it. Returns the count it replaced, null when that one could not be read, and whether it changed.
 */
export async function setLanes({ root, slotRoot, lanes, by }) {
  const { lanes: previous } = laneSetting(slotRoot);
  if (previous === lanes) return { previous, changed: false };
  await writeText(join(slotRoot, "verification-lanes"), `${lanes}\n`);
  recordHistory(root, { event: "lanes", lanes, previous, by });
  return { previous, changed: true };
}

/**
 * The pause with the runs it waits for, `{ at, reason, by?, running, idle }`, or null when the queue
 * is not paused. Only a heartbeat that shows this pause can say idle: the service records the pause
 * and its runs together. `inline` counts the inline gates that hold a lane.
 */
export function pauseState(root, { record, alive } = serviceState(root), inline = inlineRuns()) {
  const pause = readPause(root);
  if (!pause) return null;
  const running = (alive ? serviceRuns(record).runs.length : 0) + inline;
  const seen = !alive || record.paused?.at === pause.at;
  return { ...pause, running, idle: !running && seen };
}

/** The pause as status shows it, or null when the queue is not paused. */
export function pauseStatus(root, service = serviceState(root), inline = inlineRuns()) {
  const pause = pauseState(root, service, inline);
  return pause && (pause.idle ? "paused and idle: safe to restart" : `${pausedSince(pause)}: ${pause.running} running, no new runs start`);
}

export const taskName = "dohc-verification-queue";
// The service serves its read-only monitor page here, on this host only.
export const monitorPort = 4250;
// On a Mac, launchd runs the supervisor and the nightly submission as these LaunchAgents.
export const launchAgentLabel = "app.dohc.verification-queue";
export const nightlyAgentLabel = "app.dohc.verification-nightly";
export const launchAgentsDir = (home = homedir()) => join(home, "Library", "LaunchAgents");
export const guiDomain = () => `gui/${process.getuid()}`;
const launchctl = args => spawnSync("launchctl", args, { encoding: "utf8" });

/** The command that starts the installed service. Starting a running task or LaunchAgent does nothing. */
export const startCommand = (platform = process.platform) => platform === "darwin"
  ? ["launchctl", ["kickstart", `${guiDomain()}/${launchAgentLabel}`]]
  : ["schtasks.exe", ["/run", "/tn", taskName]];

/** Start the installed service if its heartbeat is not current. */
export function ensureService(root, { start = () => spawnSync(...startCommand(), { windowsHide: true, encoding: "utf8" }) } = {}) {
  if (serviceState(root).alive) return;
  const result = start();
  if (result.status !== 0) throw new Error(`The verification queue service is not installed on this host (${(result.stderr || result.stdout || "").trim()}). Run pnpm verify:queue install from a checkout of origin/main.`);
}

/** Rough wait before the request at `place` starts: the runs ahead of it, shared across the lanes. */
export const startsInMs = (place, typical, lanes) => Math.ceil(Math.max(0, place - lanes) / lanes) * typical;

/** The service's lane count and its runs. A service older than two lanes recorded one run, or null. */
export const serviceRuns = record => ({ lanes: record?.lanes ?? 1, runs: [record?.running ?? []].flat() });

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
 * The failed tests, from a list of { step, test }, that another branch's attempt
 * also failed in the last day: [{ step, test, branches }]. `branch` names this
 * run's line as a request does, by its branch ref or else its checkout; attempts
 * on that line do not count. A missing or unreadable queue gives none.
 */
export function sharedFailures(root, failed, { branch, now = Date.now() } = {}) {
  try {
    const key = row => `${row.step}\n${row.test}`;
    const wanted = new Map(failed.map(row => [key(row), row]));
    const attempts = new Map();
    const history = wanted.size ? readFileSync(queuePaths(root).history, "utf8").trim().split("\n").reverse() : [];
    // The history is in time order, newest last, so the reading stops at the first event older than a day.
    for (const line of history) {
      const event = (() => { try { return JSON.parse(line); } catch { return null; } })();
      if (Date.parse(event?.at) < now - 24 * 60 * 60_000) break;
      if (event?.event !== "finished") continue;
      for (const row of event.failed ?? []) if (wanted.has(key(row))) attempts.set(key(row), [...(attempts.get(key(row)) ?? []), event.id]);
    }
    const lines = new Map();
    const lineOf = id => {
      if (!lines.has(id)) { const request = readJson(join(queuePaths(root).request(id), "request.json")); lines.set(id, request?.branch ?? request?.checkout ?? null); }
      return lines.get(id);
    };
    // A branch is compared and shown without refs/heads/, however each request recorded it.
    const short = line => String(line).replace(/^refs\/heads\//u, "");
    const own = short(branch).toLowerCase();
    return [...wanted].flatMap(([name, row]) => {
      const branches = [...new Set((attempts.get(name) ?? []).map(lineOf).filter(Boolean).map(short).filter(line => line.toLowerCase() !== own))].sort();
      return branches.length ? [{ ...row, branches }] : [];
    });
  } catch { return []; }
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
  // A service older than owners answers without one.
  if (answer.owner) log(`owner: ${answer.owner.title}${answer.owner.source === "checkout" ? " (its checkout). Pass --owner <name> with your next branch to group a thread's requests under one owner." : ""}`);
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
    const { lanes } = serviceRuns(serviceState(root).record);
    const current = status.state === "running" ? readJson(join(queuePaths(root).attempt(id, status.attempts.at(-1).n), "result.json"))?.timings?.at(-1)?.name : null;
    const line = status.state === "running" ? `running attempt ${status.attempts.at(-1).n}${current ? `, ${current}` : ""}`
      : `queued at position ${place}${typical && place ? `, about ${Math.round(startsInMs(place, typical, lanes) / 60_000)} min until it starts` : ""}${status.waiting ? `; ${status.waiting}` : ""}`;
    if (line !== shown || Date.now() - shownAt > 5 * 60_000) { log(line); shown = line; shownAt = Date.now(); }
    await follow();
    await sleep(pollMs);
  }
}

export const nightlyTaskName = "dohc-verification-nightly";

/** The task that submits the nightly verification of main every night at 03:07, and tries again every 10 minutes for an hour if that fails. */
export function nightlyTaskDefinition(root) {
  const xml = text => text.replace(/[&<>"]/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const command = `--headless pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(root, "nightly.ps1")}" -Root "${root}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger><Enabled>true</Enabled><StartBoundary>2026-01-01T03:07:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure><Interval>PT10M</Interval><Count>6</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xml(command)}</Arguments></Exec></Actions>
</Task>
`;
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

export const plistText = text => `<string>${text.replace(/[&<>]/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</string>`;
export const plist = (label, env, entries) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${plistText(label)}
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([name, value]) => `<key>${name}</key>${plistText(value)}`).join("")}</dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
${entries}
</dict>
</plist>
`;

/**
 * The installer's PATH for the LaunchAgents: its absolute entries, without the ones pnpm adds for a script, the
 * installing checkout's node_modules/.bin folders and pnpm's node-gyp-bin. A later checkout at that path would
 * otherwise supply tools to every run, and a relative entry would name a folder inside each lane.
 */
export const launchPath = (path = process.env.PATH ?? "") => [...new Set(path.split(":")
  .filter(entry => entry.startsWith("/") && !/\/node_modules\/\.bin\/?$/u.test(entry) && !/(^|\/)node-gyp-bin\/?$/u.test(entry)))].join(":");

/**
 * The LaunchAgent that keeps the supervisor running. It loads only into the login session, where Electron can open
 * windows. launchd starts it at login and again whenever it exits. PATH is the installer's, so the service finds the
 * same node, git, cargo, and Docker as the agents that submit to it. Interactive runs it without the resource limits
 * launchd sets for other jobs, as a terminal would. Node raises the open-file limit, which launchd sets to 256.
 * The service's environment never names the queue root: each lane's verifier and its tests inherit it, and a test's
 * nested verifier must verify inline under its own slot root.
 */
export function launchAgentDefinition(root, path = launchPath()) {
  return plist(launchAgentLabel, { PATH: path }, `  <key>ProgramArguments</key><array>${["/usr/bin/env", "node", join(root, "supervisor.mjs"), "--root", root].map(plistText).join("")}</array>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${plistText(join(root, "supervisor.err.log"))}
  <key>StandardErrorPath</key>${plistText(join(root, "supervisor.err.log"))}`);
}

/**
 * The LaunchAgent that submits the nightly verification of main every night at 03:07, and tries again every 10 minutes
 * for an hour if that fails. launchd runs a night the Mac slept through when it wakes.
 */
export function nightlyAgentDefinition(root, path = launchPath()) {
  const script = 'for attempt in 1 2 3 4 5 6 7; do date -u +%Y-%m-%dT%H:%M:%SZ; node "$0/service/$(cat "$0/current")/scripts/verification/queue.mjs" nightly && exit 0; sleep 600; done; exit 1';
  return plist(nightlyAgentLabel, { PATH: path, DOHC_VERIFICATION_QUEUE_ROOT: root }, `  <key>ProgramArguments</key><array>${["/bin/sh", "-c", script, root].map(plistText).join("")}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>7</integer></dict>
  <key>StandardOutPath</key>${plistText(join(root, "nightly.log"))}
  <key>StandardErrorPath</key>${plistText(join(root, "nightly.log"))}`);
}

/**
 * Unload a LaunchAgent and wait until launchd lets it go. bootout returns while the job may still be stopping;
 * launchd kills a job that has not stopped 20 seconds after it was asked to.
 */
export async function unloadLaunchAgent(label, { command = launchctl, waitMs = 60_000, pollMs = 200 } = {}) {
  command(["bootout", `${guiDomain()}/${label}`]);
  for (const deadline = Date.now() + waitMs; command(["print", `${guiDomain()}/${label}`]).status === 0; await sleep(pollMs)) {
    if (Date.now() > deadline) throw new Error(`launchd did not unload ${label}.`);
  }
}

/**
 * Write the LaunchAgents and load them into this login session. A loaded supervisor keeps its definition until
 * `restart`, so a run in progress is never stopped; the nightly agent is loaded again at once.
 * Resolves with whether the loaded supervisor's definition changed.
 */
export async function registerLaunchAgents(root, { dir = launchAgentsDir(), command = launchctl, path = launchPath(), waitMs } = {}) {
  mkdirSync(dir, { recursive: true });
  let changed = false;
  for (const [label, definition] of [[launchAgentLabel, launchAgentDefinition(root, path)], [nightlyAgentLabel, nightlyAgentDefinition(root, path)]]) {
    const file = join(dir, `${label}.plist`);
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    writeFileSync(file, definition);
    const loaded = command(["print", `${guiDomain()}/${label}`]).status === 0;
    if (label === launchAgentLabel && loaded) { changed = before !== definition; continue; }
    if (loaded) await unloadLaunchAgent(label, { command, waitMs });
    const result = command(["bootstrap", guiDomain(), file]);
    if (result.status !== 0) throw new Error(`launchd refused ${label}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return changed;
}

/**
 * Unload the LaunchAgents and remove them. Unloading the supervisor stops the service and everything it started;
 * what a supervisor that launchd had to kill leaves is stopped from its record.
 */
export async function unregisterLaunchAgents(root, { dir = launchAgentsDir(), command = launchctl, stop = stopRecorded, waitMs } = {}) {
  for (const label of [launchAgentLabel, nightlyAgentLabel]) {
    await unloadLaunchAgent(label, { command, waitMs });
    rmSync(join(dir, `${label}.plist`), { force: true });
  }
  return stop(root);
}

/** Install or upgrade the service to `ref` from this checkout's repository. It switches between runs, never during one. */
async function install(root, ref) {
  if (!["win32", "darwin"].includes(process.platform)) throw new Error("The queue service runs on the shared Windows host and on a shared Mac. Elsewhere pnpm verify:pr runs inline.");
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
  // The running supervisor keeps its script and its task's or LaunchAgent's settings until it restarts.
  const windows = process.platform === "win32";
  // A Mac's supervisor and service find their processes with this helper, so an install without it stops here.
  if (!windows) buildEnvHelper(envHelper(root), join(dir, "scripts/verification/procenv.c"));
  const supervisorScript = join(root, windows ? "supervisor.ps1" : "supervisor.mjs");
  const before = existsSync(supervisorScript) ? readFileSync(supervisorScript) : null;
  copyFileSync(join(dir, "scripts/verification", windows ? "queue-supervisor.ps1" : "queue-supervisor.mjs"), supervisorScript);
  const previous = existsSync(paths.current) ? readFileSync(paths.current, "utf8").trim() : null;
  await withFileRetry(() => { writeFileSync(`${paths.current}.tmp`, short); renameSync(`${paths.current}.tmp`, paths.current); });
  let changed = !before?.equals(readFileSync(supervisorScript));
  if (windows) {
    copyFileSync(join(dir, "scripts/verification/queue-nightly.ps1"), join(root, "nightly.ps1"));
    const definition = join(root, "task.xml");
    const task = existsSync(definition) ? readFileSync(definition) : null;
    writeFileSync(definition, `﻿${taskDefinition(root)}`, "utf16le");
    changed ||= !task?.equals(readFileSync(definition));
    const created = spawnSync("schtasks.exe", ["/create", "/tn", taskName, "/xml", definition, "/f"], { encoding: "utf8", windowsHide: true });
    if (created.status !== 0) throw new Error(`Task Scheduler refused the service task: ${created.stderr || created.stdout}`);
    const nightlyDefinition = join(root, "nightly-task.xml");
    writeFileSync(nightlyDefinition, `﻿${nightlyTaskDefinition(root)}`, "utf16le");
    const nightly = spawnSync("schtasks.exe", ["/create", "/tn", nightlyTaskName, "/xml", nightlyDefinition, "/f"], { encoding: "utf8", windowsHide: true });
    if (nightly.status !== 0) throw new Error(`Task Scheduler refused the nightly task: ${nightly.stderr || nightly.stdout}`);
  } else changed = await registerLaunchAgents(root) || changed;
  if (serviceState(root).alive && previous !== short) {
    // The running service exits when idle; the supervisor then starts this one.
    mkdirSync(paths.control, { recursive: true });
    writeFileSync(join(paths.control, "restart"), "");
  } else if (!serviceState(root).alive) spawnSync(...startCommand(), { windowsHide: true });
  // Keep the active, the previous, and the running installation; older ones are removed.
  const runningInstall = serviceState(root).record?.commit?.slice(0, 12);
  for (const name of readdirSync(paths.installs).filter(name => ![short, previous, runningInstall].includes(name))) {
    try { git(["worktree", "remove", "--force", "--force", join(paths.installs, name)], repo); }
    catch (error) { console.error(`could not remove the old install ${name}: ${error.message}`); }
  }
  console.log(`verification queue service ${short} installed at ${root}${previous && previous !== short ? `, replacing ${previous} once the current run ends` : ""}.`);
  if (changed && serviceState(root).alive) console.log(`The supervisor or its ${windows ? "task" : "LaunchAgent"} changed. Run pnpm verify:queue restart when no run is in progress to apply it.`);
}

function printStatus(root) {
  const { record, alive } = serviceState(root);
  const requests = listRequests(root);
  const typical = typicalRunMs(root);
  const minutes = ms => `${Math.round(ms / 60_000)} min`;
  const { lanes, runs } = serviceRuns(record);
  console.log(`service: ${alive ? `running ${record.commit?.slice(0, 12) ?? ""} (pid ${record.pid})` : record ? `not responding since ${record.heartbeatAt}` : "never started"}`);
  if (alive) console.log(`monitor: http://127.0.0.1:${monitorPort}`);
  const pause = pauseStatus(root, { record, alive });
  if (pause) console.log(pause);
  // The supervisor starts no service while processes of the last one still run.
  const held = readJson(heldPath(root));
  if (held) console.log(`held since ${held.at}: the supervisor could not stop the last service's processes (${held.reason}). No service starts until they stop; supervisor.log has each try.`);
  if (record?.health?.reason) console.log(`health: ${record.health.reason}`);
  if (record?.health?.diskFreeGb != null) console.log(`free disk: ${record.health.diskFreeGb.toFixed(1)} GB`);
  // The setting, which the service reads each tick, and any lane above it still finishing a gate.
  const setting = laneSetting(verificationSlotRoot());
  console.log(`lanes: ${setting?.error ? `${lanes}, the service's last count. ${setting.error}` : [setting?.lanes ?? lanes, closingNote(setting?.closing)].filter(Boolean).join(", ")}`);
  if (record) console.log(`host: ${record.health?.cpuBusyPercent ?? "unknown"}% CPU, ${record.health?.freeMemGb ?? "unknown"} GB free memory`);
  const live = runOrder(requests);
  for (const [index, entry] of live.entries()) {
    const place = index + 1;
    // The service's heartbeat says what a running attempt is doing, such as waiting for the host lane.
    const phase = runs.find(row => row.id === entry.id)?.phase;
    const where = entry.status.state === "running" ? `running attempt ${entry.status.attempts.at(-1)?.n}${phase ? `, ${phase}` : ""}` : `#${place}${typical ? `, starts ${pause ? "about " : "in about "}${minutes(startsInMs(place, typical, lanes))}${pause ? " after resume" : ""}` : ""}`;
    console.log(`${entry.id}  ${where}  ${entry.request.scope}  ${entry.request.head.slice(0, 12)}  ${entry.request.branch?.replace("refs/heads/", "") ?? entry.request.checkout}  owner: ${ownerOf(entry.request).title}${entry.status.waiting ? `  (${entry.status.waiting})` : ""}${entry.status.moved ? `  (${movedNote(entry.status.moved)})` : ""}`);
  }
  if (!live.length) console.log("no requests waiting");
  const nightly = lastNightlyPass(requests);
  console.log(`last passing nightly: ${nightly ? `${nightly.request.head.slice(0, 12)} (${nightly.id})` : "none yet"}`);
  for (const entry of requests.filter(entry => terminalStates.has(entry.status.state)).slice(-8)) {
    console.log(`${entry.id}  ${entry.status.state}${entry.status.cause && entry.status.state !== "passed" ? ` (${entry.status.cause})` : ""}  ${entry.request.head.slice(0, 12)}  ${entry.status.result ?? ""}`);
  }
}

/** Ask the service to move a queued request, and report where it went once the service applies it. */
async function move(root, args) {
  const usage = 'Use move <id> --first, or move <id> --before <other-id>, with --reason "<why>" and optionally --by "<name>". --before orders one owner\'s requests. Use --first only to unblock other work.';
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, options: { first: { type: "boolean" }, before: { type: "string" }, reason: { type: "string" }, by: { type: "string" } } }); }
  catch { throw new Error(usage); }
  const { positionals: [id], values: { first = false, before = null, reason, by = null } } = parsed;
  if (!id || first === Boolean(before) || !reason?.trim()) throw new Error(usage);
  // The service makes the same checks when it applies the move; these answer at once, even while it is down.
  const asked = parseMove({ id, before, reason, by: { name: by, user: userInfo().username, cwd: process.cwd() } });
  if (asked.rejected) throw new Error(asked.rejected);
  const { record, alive } = serviceState(root);
  const check = placeMove(listRequests(root), asked, new Set(alive ? serviceRuns(record).runs.map(run => run.id) : []));
  if (check.rejected) throw new Error(check.rejected);
  const key = await requestMove(root, asked);
  if (!alive) return console.log(`The verification queue service is not running. The move of ${id} applies when the service starts.`);
  for (let waited = 0; waited < 30_000; waited += 500) {
    const answer = readJson(join(queuePaths(root).keys, key));
    if (answer?.rejected) throw new Error(answer.rejected);
    if (answer) return console.log(`moved ${id} ${before ? `before ${before}` : "first"}: now #${answer.to} in line, was #${answer.from}`);
    await sleep(500);
  }
  console.log(`The service has not applied the move of ${id} yet. It applies on the service's next pass; pnpm verify:queue status shows the line. A service older than this checkout applies no moves until pnpm verify:queue upgrade.`);
}

/** Report a restart once a service other than `stoppedPid` beats. */
async function reportRestart(root, stoppedPid, scheduler) {
  for (let waited = 0; waited < 30_000; waited += 500) {
    const next = serviceState(root);
    if (next.alive && next.record.pid !== stoppedPid) return console.log(`restarted the verification queue service (pid ${next.record.pid})`);
    await sleep(500);
  }
  console.log(scheduler === "launchd" ? "asked launchd to restart the verification queue service; pnpm verify:queue status shows when it runs"
    : "asked Task Scheduler to restart the verification queue service; it starts within five minutes");
}

/** Unload the supervisor's LaunchAgent, which stops the service and everything it started, and load it again, so a changed definition applies. */
export async function reloadLaunchAgent(root, { dir = launchAgentsDir(), command = launchctl, stop = stopRecorded, waitMs } = {}) {
  await unloadLaunchAgent(launchAgentLabel, { command, waitMs });
  await stop(root);
  const result = command(["bootstrap", guiDomain(), join(dir, `${launchAgentLabel}.plist`)]);
  if (result.status !== 0) throw new Error(`launchd refused ${launchAgentLabel}: ${(result.stderr || result.stdout || "").trim()}`);
}

async function main([command, ...args]) {
  const installing = command === "install" || command === "upgrade";
  // Installing makes a Mac a shared host: its slot root marks it, and the install marks its queue.
  if (installing && process.platform === "darwin" && !process.env.DOHC_BUILD_SLOT_ROOT) mkdirSync(macSlotRoot(), { recursive: true });
  const root = queueRoot(process.env, installing ? { installed: () => true } : {});
  if (!root) throw new Error("This host has no verification queue. pnpm verify:pr runs inline here.");
  const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "origin/main";
  if (command === "status" || !command) return printStatus(root);
  if (command === "cancel") { await cancel(root, args[0]); return console.log(`asked the service to stop ${args[0]}`); }
  if (command === "pause") {
    const reason = args.includes("--reason") ? args[args.indexOf("--reason") + 1] : null;
    if (args.includes("--reason") && (!reason || reason.startsWith("--"))) throw new Error("Use pause [--reason <text>].");
    const { changed } = await pauseQueue(root, { reason });
    console.log(changed ? "paused the verification queue. Runs in progress finish, and no run starts until pnpm verify:queue resume." : "the verification queue was already paused.");
    return console.log(pauseStatus(root));
  }
  if (command === "resume") {
    const ended = await resumeQueue(root);
    return console.log(ended ? `resumed the verification queue, which was ${pausedSince(ended)}.` : "the verification queue was not paused.");
  }
  if (installing) return install(root, ref);
  if (command === "nightly") {
    const here = fileURLToPath(new URL("../..", import.meta.url));
    const { head, base } = await submitNightly(root, resolve(git(["rev-parse", "--git-common-dir"], here), ".."));
    return console.log(`submitted the nightly verification of main at ${head.slice(0, 12)}, against ${base.slice(0, 12)}`);
  }
  if (command === "move") return move(root, args);
  if (command === "restart") {
    const { record, alive } = serviceState(root);
    if (serviceRuns(record).runs.length && !args.includes("--now")) throw new Error("A run is in progress. Wait for it, or pass --now to stop it; it will be retried.");
    if (process.platform === "darwin") {
      await reloadLaunchAgent(root);
      return reportRestart(root, record?.pid, "launchd");
    }
    // The task's own process is conhost, so ending the task leaves the supervisor running. Stop the supervisor
    // itself; its job stops the service and any run. It is found by its command line, which names this root's
    // script, and stopped through a handle held before that check, so a reused pid is never stopped. The script
    // runs in powershell.exe, never pwsh.exe: its own command line names the supervisor's script too.
    const script = join(root, "supervisor.ps1").replaceAll("'", "''");
    const stopped = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      $mine = { param($id) $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"; $p -and $p.CommandLine -and $p.CommandLine.IndexOf('${script}', [StringComparison]::OrdinalIgnoreCase) -ge 0 }
      $found = 0
      foreach ($candidate in Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'") {
        if (-not (& $mine $candidate.ProcessId)) { continue }
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        $null = $process.Handle
        if (-not (& $mine $process.Id)) { continue }
        $found += 1
        try { $process.Kill() } catch { if (-not $process.HasExited) { throw } }
        if (-not $process.WaitForExit(10000)) { throw "supervisor $($process.Id) did not exit" }
      }
      # A live service always has a supervisor; finding none means this root names it differently.
      if ($found -eq 0 -and ${alive ? "$true" : "$false"}) { throw 'no supervisor for this queue root was found, though its service is running' }`], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    if (stopped.status !== 0) throw new Error(`The supervisor could not be stopped, so the service was not restarted: ${(stopped.stderr || stopped.stdout || stopped.error?.message || "").trim()}`);
    // Every service is stopped now, so the last recorded pid is a dead one, even if the supervisor restarted it meanwhile.
    const stoppedPid = serviceState(root).record?.pid;
    spawnSync("schtasks.exe", ["/end", "/tn", taskName], { windowsHide: true });
    spawnSync("schtasks.exe", ["/run", "/tn", taskName], { windowsHide: true });
    // Report a restart only once a new service is beating; otherwise the task's five-minute trigger finishes it.
    return reportRestart(root, stoppedPid, "Task Scheduler");
  }
  if (command === "uninstall") {
    if (process.platform !== "darwin") throw new Error("uninstall removes a Mac's LaunchAgents. On Windows, delete the dohc-verification-queue and dohc-verification-nightly scheduled tasks.");
    if (serviceRuns(serviceState(root).record).runs.length && !args.includes("--now")) throw new Error("A run is in progress. Wait for it, or pass --now to stop it; it runs again after the next install.");
    const stopped = await unregisterLaunchAgents(root);
    // Without its install marker the queue root is no longer found, so pnpm verify:pr runs inline.
    rmSync(queuePaths(root).current, { force: true });
    return console.log(`uninstalled the verification queue service: removed ${launchAgentLabel} and ${nightlyAgentLabel} from ${launchAgentsDir()}${stopped.length ? `, and stopped ${stopped.length} process(es) its supervisor left` : ""}. pnpm verify:pr runs inline on this Mac now.
The requests, history, lanes, and installs stay in ${root}, so pnpm verify:queue install resumes with warm lanes. To remove them too, run git worktree remove --force --force on each of ${join(root, "lane*")} and ${join(root, "service", "*")}, then delete ${root}.
${macSlotRoot()} stays too, so builds and gates on this Mac keep sharing the build budget. Delete it while no build or gate runs to stop that.`);
  }
  throw new Error(`Use status, pause [--reason <text>], resume, cancel <id>, move <id> --first|--before <id> --reason <text>, install [--ref <ref>], upgrade [--ref <ref>], restart [--now],${process.platform === "darwin" ? " uninstall [--now]," : ""} or nightly.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
