// A web dashboard for the verification queue: what each lane runs now and its live
// output, what waits, and what ran this week. The service serves it on this host only;
// reach it from other devices through a private Tailscale Serve route. It reads the
// queue's own files and writes only its load samples and, when asked, the queue's pause
// and the host's lane setting, so a fault here can never stop a run.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQueueStatus, heldVerificationSlots, maxVerificationLanes } from "../../tools/rust-engine-program/build-slot.mjs";
import { closingNote, laneSetting, lastNightlyPass, listRequests, monitorPort, movedNote, ownerOf, pauseQueue, pauseState, queuePaths, readJson, restartReason, resumeQueue, runOrder, serviceState, setLanes, terminalStates, verificationSlotRoot, writeJson } from "./queue.mjs";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
const assetPath = name => fileURLToPath(new URL(`./queue-monitor/${name}`, import.meta.url));
const dayMs = 24 * 60 * 60_000;
const requestId = /^\d{9}-[0-9a-f]{6}$/u;
// A log the dashboard may show: one in the attempt's folder or its package-test folder.
const logName = /^(?:js-tests\/)?[\w.@-]+\.log$/u;
const branchOf = request => request.nightly ? "main (nightly)" : request.branch?.replace("refs/heads/", "") ?? request.checkout;
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const clip = (text, length) => typeof text === "string" && text.length > length ? `${text.slice(0, length)}…` : text ?? null;
const names = path => { try { return readdirSync(path); } catch { return []; } };
// A request's last move for its mark's tooltip: who moved it on the first line, why on the second.
const noteOf = status => status.moved ? movedNote(status.moved, "\n") : null;
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");

/** Finished events from the history in the last `days`, read again only when the file changes. */
function historyReader(root) {
  let seen = null;
  let events = [];
  return (days, now = Date.now()) => {
    const path = queuePaths(root).history;
    let stamp;
    try { const stat = statSync(path); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { return []; }
    if (stamp !== seen) {
      seen = stamp;
      events = readFileSync(path, "utf8").split("\n").flatMap(line => {
        try { const event = JSON.parse(line); return event.event === "finished" ? [event] : []; } catch { return []; }
      });
    }
    const since = now - days * dayMs;
    return events.filter(event => Date.parse(event.at) >= since);
  };
}

/** An attempt's logs, newest first, as paths relative to its folder. */
function attemptLogs(folder) {
  return ["", "js-tests"].flatMap(dir => names(join(folder, dir)).filter(name => name.endsWith(".log")).flatMap(name => {
    try {
      const stat = statSync(join(folder, dir, name));
      return [{ file: dir ? `${dir}/${name}` : name, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() }];
    } catch { return []; }
  })).sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

// A step's log as a name inside its folder, when it is one the dashboard may show.
const logOf = (folder, path) => {
  if (typeof path !== "string") return null;
  const name = relative(folder, resolve(folder, path)).replaceAll("\\", "/");
  return logName.test(name) ? name : null;
};
const stepRow = (step, folder) => ({ name: step.name, verdict: step.verdict ?? null, startedAt: step.startedAt ?? null,
  seconds: Number.isFinite(step.seconds) ? Math.round(step.seconds) : null, ...(folder ? { log: logOf(folder, step.log) } : {}) });

/** A run's live view from its folder: its gate steps and package steps so far, each with its log, and every log it has written. */
function liveSteps(folder) {
  return {
    steps: (readJson(join(folder, "result.json"))?.steps ?? []).map(step => stepRow(step, folder)),
    packages: (readJson(join(folder, "js-tests", "result.json"))?.steps ?? []).map(step => stepRow(step, folder)),
    logs: attemptLogs(folder),
  };
}

/** A running attempt's live view. */
function progress(root, id, n) {
  return liveSteps(queuePaths(root).attempt(id, n));
}

/**
 * The T3 thread behind a branch or checkout, when T3 runs on this host. T3 keeps its
 * threads in a local database, read here read-only once a minute. A thread is found by
 * its own worktree, by a pull request it linked, or by its branch. Its `root` is the
 * thread a person started, which an agent's subagent threads descend from. Without T3
 * every lookup is null, and the dashboard names work by its branch.
 */
export function threadDirectory({ path = join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "userdata", "statev2.sqlite"), refreshMs = 60_000, sinceDays = 14 } = {}) {
  let loadedAt = -Infinity;
  let maps = { paths: new Map(), heads: new Map(), branches: new Map() };
  const load = () => {
    loadedAt = Date.now();
    const sqlite = process.getBuiltinModule?.("node:sqlite");
    if (!sqlite || !existsSync(path)) return;
    let db;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true });
      const rows = db.prepare("select thread_id, title, payload_json from orchestration_v2_projection_threads where deleted_at is null and updated_at > ?")
        .all(new Date(Date.now() - sinceDays * dayMs).toISOString());
      // A root thread can be older than the rows above, so its title is read from every row.
      const titles = new Map(db.prepare("select thread_id, title from orchestration_v2_projection_threads").all().map(row => [row.thread_id, row.title]));
      const next = { paths: new Map(), heads: new Map(), branches: new Map() };
      // A thread a person started names the work better than an agent's child thread on the same branch.
      const put = (map, key, thread) => { const old = map.get(key); if (!old || (old.child && !thread.child)) map.set(key, thread); };
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json);
          const rootId = typeof payload.lineage?.rootThreadId === "string" ? payload.lineage.rootThreadId : row.thread_id;
          const thread = { id: row.thread_id, title: row.title, child: payload.createdBy === "agent", root: { id: rootId, title: titles.get(rootId) ?? row.title } };
          if (payload.worktreePath) put(next.paths, resolve(payload.worktreePath).toLowerCase(), thread);
          for (const pr of payload.pullRequests ?? []) if (pr?.snapshot?.headBranch) put(next.heads, pr.snapshot.headBranch, { ...thread, pr: pr.number });
          if (payload.branch && !["main", "master"].includes(payload.branch)) put(next.branches, payload.branch, thread);
        } catch { /* A row in a shape this reader does not know names nothing. */ }
      }
      maps = next;
    } catch { /* T3 may be migrating its database; the next refresh tries again. */ }
    finally { try { db?.close(); } catch { /* Already closed. */ } }
  };
  return (branch, checkout) => {
    if (Date.now() - loadedAt > refreshMs) load();
    const thread = (checkout && maps.paths.get(resolve(checkout).toLowerCase())) ?? maps.heads.get(branch) ?? maps.branches.get(branch) ?? null;
    return thread && { id: thread.id, title: thread.title, ...(thread.pr ? { pr: thread.pr } : {}), root: thread.root };
  };
}

/** The branch a checkout has out, read from its Git files, or null. */
function checkoutBranch(checkout) {
  try {
    let git = join(checkout, ".git");
    if (statSync(git).isFile()) git = resolve(checkout, readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/mu)[1].trim());
    return readFileSync(join(git, "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/mu)?.[1]?.trim() ?? null;
  } catch { return null; }
}

/** An inline gate's evidence folder: the newest in its checkout for the commit it verifies. */
function inlineFolder(checkout, commit) {
  const dir = join(checkout, ".agent-artifacts", "verification");
  for (const name of names(dir).sort().reverse().slice(0, 6)) {
    const receipt = readJson(join(dir, name, "result.json"));
    if (receipt && (!commit || receipt.commit === commit)) return join(dir, name);
  }
  return null;
}

/**
 * Who holds each verification slot, the host's real lanes: a queued request, or a gate
 * an agent ran inline in its own checkout, with that gate's steps and logs. And who waits.
 */
function slotView(status, threadOf) {
  if (!status) return null;
  const queued = text => text?.match(/^request (\d{9}-[0-9a-f]{6})$/u)?.[1] ?? null;
  const inline = owner => {
    const branch = owner.checkout ? checkoutBranch(owner.checkout) : null;
    const folder = owner.checkout ? inlineFolder(owner.checkout, owner.commit) : null;
    return { branch, thread: threadOf(branch, owner.checkout), checkout: owner.checkout ?? null, head: owner.commit?.slice(0, 12) ?? null, phase: owner.phase ?? null,
      ...(folder ? liveSteps(folder) : { steps: [], packages: [], logs: [] }) };
  };
  return {
    slots: status.slots,
    holders: status.owners.map(owner => {
      const slot = Number(owner.name.match(/(\d+)$/u)?.[1]);
      const requestId = queued(owner.phase);
      return { slot, startedAt: owner.start ?? null, elapsedMs: owner.elapsedMs ?? null, ...(requestId ? { kind: "queue", requestId } : { kind: "inline", ...inline(owner) }) };
    }).sort((a, b) => a.slot - b.slot),
    waiters: status.waiters.map(waiter => {
      const requestId = queued(waiter.phase);
      const branch = requestId ? null : waiter.checkout ? checkoutBranch(waiter.checkout) : null;
      return { position: waiter.position, waitedMs: waiter.elapsedMs ?? null, ...(requestId ? { kind: "queue", requestId } : { kind: "inline", branch, thread: threadOf(branch, waiter.checkout), checkout: waiter.checkout ?? null }) };
    }),
  };
}

/**
 * The tests that failed on two or more branches in the last day, main's nightly counting as main:
 * `[{ step, test, branches, last, nightly }]`, where `branches` leaves the nightly out and `nightly`
 * says whether a nightly failed the test too, or is null when no nightly finished with a verdict.
 * Such a failure more often comes from main or a flaky test than from one branch's change.
 */
function sharedFailures(requests, events, now) {
  const requestOf = new Map(requests.map(entry => [entry.id, entry.request]));
  const tests = new Map();
  let nightlyRan = false;
  for (const event of events.filter(event => Date.parse(event.at) >= now - dayMs)) {
    const request = requestOf.get(event.id);
    if (!request) continue;
    if (request.nightly && ["passed", "failed"].includes(event.outcome)) nightlyRan = true;
    for (const row of event.failed ?? []) {
      const key = `${row.step}\n${row.test}`;
      const item = tests.get(key) ?? { step: row.step, test: row.test, branches: new Map(), nightly: false, last: null };
      if (request.nightly) item.nightly = true;
      else item.branches.set(branchOf(request).toLowerCase(), branchOf(request));
      if (!item.last || event.at > item.last) item.last = event.at;
      tests.set(key, item);
    }
  }
  return [...tests.values()]
    .filter(item => item.branches.size + (item.nightly && !item.branches.has("main") ? 1 : 0) >= 2)
    .map(item => ({ step: item.step, test: item.test, branches: [...item.branches.values()].sort(), last: item.last, nightly: item.nightly || (nightlyRan ? false : null) }))
    .sort((a, b) => b.branches.length - a.branches.length || b.last.localeCompare(a.last))
    .slice(0, 15);
}

/**
 * Everything the dashboard shows, from the queue's files. Finished requests are cached
 * by the caller's `finished` map, as the service does, so a refresh reads only live ones.
 * `threadOf` names a request's T3 thread, `slots` reads who holds the verification slots,
 * and `lanes` reads the host's lane setting.
 */
export function monitorState(root, { now = Date.now(), days = 7, finished = new Map(), history = historyReader(root), threadOf = () => null, slots = () => null, lanes: readLanes = () => null } = {}) {
  const { record, alive } = serviceState(root, now);
  const requests = listRequests(root, finished);
  for (const entry of requests) if (terminalStates.has(entry.status.state)) finished.set(entry.id, entry);
  const running = record?.running ?? [];
  const threadFor = request => request.nightly ? null : threadOf(request.branch?.replace("refs/heads/", "") ?? null, request.checkout);
  const since = now - days * dayMs;
  const runs = requests.flatMap(entry => entry.status.attempts.flatMap(row => {
    const live = running.find(run => run.id === entry.id && run.attempt === row.n);
    const endedAt = row.endedAt ?? null;
    if (Date.parse(endedAt ?? row.startedAt) < since) return [];
    // An attempt without an end that the service is not running was cut short; its outcome is recorded on recovery.
    const outcome = row.outcome ?? (live ? "running" : "interrupted");
    return [{
      id: entry.id, attempt: row.n, branch: branchOf(entry.request), thread: threadFor(entry.request), nightly: Boolean(entry.request.nightly), scope: entry.request.scope,
      head: entry.request.head.slice(0, 12), lane: row.lane ?? (live ? Number(live.checkout.match(/-(\d)$/u)?.[1] ?? 1) : null), startedAt: row.startedAt, endedAt, outcome,
      cause: row.cause ?? null, reason: clip(row.reason, 300), awakeMs: live?.awakeMs ?? row.awakeMs ?? null, flaky: row.flaky?.length ?? 0,
      ...(live ? { phase: live.phase, moved: noteOf(entry.status), ...progress(root, entry.id, row.n) } : {}),
    }];
  })).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const typicalMs = median(runs.filter(run => run.outcome === "passed").slice(-20).map(run => run.awakeMs));
  const line = runOrder(requests).filter(entry => entry.status.state === "queued");
  // How many requests each owner has waiting.
  const waitingFor = new Map();
  for (const { key } of line.map(entry => ownerOf(entry.request))) waitingFor.set(key, (waitingFor.get(key) ?? 0) + 1);
  const queued = line.map(entry => {
    const owner = ownerOf(entry.request);
    return {
      id: entry.id, branch: branchOf(entry.request), thread: threadFor(entry.request), nightly: Boolean(entry.request.nightly), scope: entry.request.scope, head: entry.request.head.slice(0, 12),
      owner: { title: owner.title, source: owner.source, waiting: waitingFor.get(owner.key) },
      submittedAt: entry.request.submittedAt ?? entry.request.acceptedAt, retry: entry.status.attempts.length > 0,
      notBefore: entry.status.notBefore ?? null, waiting: clip(entry.status.waiting, 200),
      moved: noteOf(entry.status),
    };
  });
  const events = history(days, now);
  const tests = new Map();
  const steps = new Map();
  for (const event of events) {
    for (const row of event.flaky ?? []) {
      const key = `${row.step}\n${row.test}`;
      const item = tests.get(key) ?? { step: row.step, test: row.test, flaky: 0, passedAlone: 0, slow: [], last: null };
      // A test that passed only alone failed both tries, so before the isolated retry it would have failed the gate.
      if (row.passedAlone) item.passedAlone += 1;
      else item.flaky += 1;
      item.last = event.at;
      tests.set(key, item);
    }
    for (const row of event.slowest ?? []) {
      const key = `${row.step}\n${row.test}`;
      const item = tests.get(key) ?? { step: row.step, test: row.test, flaky: 0, passedAlone: 0, slow: [], last: null };
      item.slow.push(row.seconds);
      tests.set(key, item);
    }
    if (event.outcome === "passed") for (const [name, seconds] of Object.entries(event.steps ?? {})) steps.set(name, [...(steps.get(name) ?? []), seconds]);
  }
  const all = [...tests.values()];
  const nightly = requests.findLast(entry => entry.request.nightly);
  const pass = lastNightlyPass(requests);
  const setting = readLanes();
  let lanes;
  try { lanes = slotView(slots(setting?.lanes ?? record?.lanes ?? 1), threadOf); } catch { lanes = null; }
  const pause = pauseState(root, { record, alive }, lanes?.holders.filter(holder => holder.kind === "inline").length ?? 0);
  // Each thread's week: its runs and their results, what it has waiting and running now, and its time in gates.
  const groups = new Map();
  const group = (thread, branch) => {
    const key = thread?.id ?? `branch:${branch}`;
    if (!groups.has(key)) groups.set(key, { key, thread, title: thread?.title ?? branch, branches: new Set(), runs: 0, passed: 0, failed: 0, machine: 0, waiting: 0, running: 0, inline: 0, gateMs: 0, lastAt: null, lastOutcome: null });
    const item = groups.get(key);
    if (branch) item.branches.add(branch);
    return item;
  };
  for (const run of runs) {
    if (run.nightly) continue;
    const item = group(run.thread, run.branch);
    if (run.outcome === "running") { item.running += 1; continue; }
    if (!run.endedAt) continue;
    item.runs += 1;
    if (run.outcome === "passed") item.passed += 1;
    else if (run.outcome === "failed") item.failed += 1;
    else if (run.outcome === "environment" || run.outcome === "error") item.machine += 1;
    item.gateMs += Date.parse(run.endedAt) - Date.parse(run.startedAt);
    if (!item.lastAt || run.endedAt > item.lastAt) { item.lastAt = run.endedAt; item.lastOutcome = run.outcome; }
  }
  for (const entry of queued) if (!entry.nightly) group(entry.thread, entry.branch).waiting += 1;
  for (const holder of lanes?.holders ?? []) if (holder.kind === "inline") group(holder.thread, holder.branch ?? holder.checkout).inline += 1;
  const threads = [...groups.values()].map(item => ({ ...item, branches: [...item.branches] }))
    .sort((a, b) => (b.running + b.inline + b.waiting) - (a.running + a.inline + a.waiting) || String(b.lastAt).localeCompare(String(a.lastAt)));
  return {
    now, days,
    service: record ? { alive, commit: record.commit?.slice(0, 12) ?? null, pid: record.pid, startedAt: record.startedAt, heartbeatAt: record.heartbeatAt, lanes: record.lanes ?? 1, health: record.health ?? null } : null,
    pause: pause && { ...pause, restart: pause.reason === restartReason },
    // The host's lane setting, which the service reads each tick, and the lanes above it still finishing a gate.
    laneSetting: setting && { ...setting, note: closingNote(setting.closing) },
    typicalMs, runs, queued, lanes, threads, sharedFailures: sharedFailures(requests, events, now),
    flaky: all.filter(item => item.flaky || item.passedAlone).sort((a, b) => b.passedAlone - a.passedAlone || b.flaky - a.flaky).slice(0, 15).map(({ slow: _slow, ...item }) => item),
    slowest: all.filter(item => item.slow.length).map(item => ({ step: item.step, test: item.test, runs: item.slow.length, medianSeconds: median(item.slow), totalSeconds: Math.round(item.slow.reduce((sum, seconds) => sum + seconds, 0)) }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 15),
    // Each step's median seconds in the week's passing runs, for typical step times.
    stepTimes: [...steps].map(([name, values]) => ({ name, runs: values.length, medianSeconds: median(values) })).sort((a, b) => b.medianSeconds - a.medianSeconds),
    nightly: nightly ? { id: nightly.id, head: nightly.request.head.slice(0, 12), state: nightly.status.state, at: nightly.status.updatedAt ?? null } : null,
    lastNightlyPass: pass ? { id: pass.id, head: pass.request.head.slice(0, 12), at: pass.status.updatedAt ?? null } : null,
  };
}

// Where a test runner's own failure summary starts: node:test, vitest, Playwright, and nextest.
const failureSummary = /^(✖ failing tests:|\s*⎯+ Failed Tests? \d+ ⎯+|\s*\d+ failed$|\s*Summary \[.*\].*failed)/mu;

/** The real path of a log inside `folder`, or null for any path outside it, including through a link. */
function inside(folder, path) {
  if (typeof path !== "string") return null;
  try {
    const full = realpathSync(resolve(folder, path));
    const within = relative(realpathSync(folder), full);
    return !within || within.startsWith("..") || isAbsolute(within) ? null : full;
  } catch { return null; }
}

/** The end of a file: its last `bytes`, without the partial first line when it was cut. Reads only that end, however large the file. */
function readEnd(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

/** A failing log's test summary, or its last lines, without terminal colors. A runner prints its summary at the end, so only the last 2 MB are read. */
function failureExcerpt(folder, path) {
  const full = inside(folder, path);
  if (!full) return null;
  try {
    const lines = plain(readEnd(full, 2 * 1024 * 1024)).split(/\r?\n/u);
    const start = lines.findLastIndex(line => failureSummary.test(line));
    return (start >= 0 ? lines.slice(start, start + 200) : lines.slice(-80)).join("\n").slice(0, 16_000);
  } catch { return null; }
}

/** The last lines of a file, reading only its end. A line a progress bar rewrote with \r shows its last state. */
function tail(path, bytes = 96 * 1024, lines = 400) {
  return plain(readEnd(path, bytes)).split("\n").map(row => row.split("\r").filter(Boolean).at(-1) ?? "").slice(-lines).join("\n");
}

const attemptFolder = (root, id, n) => requestId.test(id ?? "") && /^\d{1,3}$/u.test(String(n ?? "")) ? queuePaths(root).attempt(id, n) : null;

/** One attempt's steps, failures, the end of each failing step's log, and its logs. */
export function runDetails(root, id, n) {
  const folder = attemptFolder(root, id, n);
  if (!folder) return null;
  const request = readJson(join(queuePaths(root).request(id), "request.json"));
  const status = readJson(join(queuePaths(root).request(id), "status.json"));
  if (!request || !status) return null;
  const row = status.attempts.find(attempt => attempt.n === Number(n));
  if (!row) return null;
  const receipt = readJson(join(folder, "result.json"));
  const js = readJson(join(folder, "js-tests", "result.json"));
  const step = (item, group) => ({ group, ...stepRow(item, folder), error: clip(item.error, 400), excerpt: item.verdict === "FAIL" ? failureExcerpt(folder, item.log) : null });
  return {
    id, attempt: Number(n), branch: branchOf(request), head: request.head.slice(0, 12), base: request.base.slice(0, 12), scope: request.scope, nightly: Boolean(request.nightly),
    state: status.state, outcome: row.outcome ?? null, cause: row.cause ?? null, reason: clip(row.reason, 600), lane: row.lane ?? null,
    startedAt: row.startedAt ?? null, endedAt: row.endedAt ?? null, awakeMs: row.awakeMs ?? null,
    verdict: receipt?.verdict ?? null, error: clip(receipt?.error, 600), stopped: receipt?.stopped ?? null,
    steps: [...(receipt?.steps ?? []).map(item => step(item, "gate")), ...(js?.steps ?? []).map(item => step(item, "javascript"))],
    flaky: receipt?.flaky ?? [], slowest: (receipt?.slowest ?? []).slice(0, 10), logs: attemptLogs(folder),
  };
}

/** The end of one of an attempt's logs. Only a log name inside the attempt's folder is read. */
export function runLog(root, id, n, file) {
  return logIn(attemptFolder(root, id, n), file);
}

/** The end of a log by its name inside `folder`, or null for any other name. */
function logIn(folder, file) {
  const full = folder && logName.test(file ?? "") ? inside(folder, file) : null;
  if (!full) return null;
  try {
    const stat = statSync(full);
    return { file, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString(), text: tail(full) };
  } catch { return null; }
}

/** The end of a log of the inline gate holding verification slot `slot`, found from the slot's own record. */
export function slotLog(status, slot, file) {
  const owner = status?.owners.find(candidate => candidate.name === `verification-slot-${slot}`);
  if (!owner?.checkout || /^request /u.test(owner.phase ?? "")) return null;
  return logIn(inlineFolder(owner.checkout, owner.commit), file);
}

/**
 * When each request waited: from acceptance to its first attempt, and from a machine
 * failure to its retry. A request replaced or cancelled before it ran waited until then.
 */
export function waitingIntervals(requests, now = Date.now()) {
  return requests.flatMap(({ request, status }) => {
    const intervals = [];
    let from = Date.parse(request.acceptedAt ?? request.submittedAt);
    for (const attempt of status.attempts) {
      if (Number.isFinite(from)) intervals.push([from, Date.parse(attempt.startedAt)]);
      from = attempt.outcome === "environment" && attempt.endedAt ? Date.parse(attempt.endedAt) : NaN;
    }
    if (Number.isFinite(from)) intervals.push([from, status.state === "queued" ? now : Date.parse(status.updatedAt ?? new Date(now).toISOString())]);
    return intervals;
  });
}

/**
 * The host's load once a minute: CPU and free memory. Samples survive a service restart
 * in `monitor-load.json`, a week of them. How many requests ran and waited comes from the
 * requests themselves, so it covers the whole week from the start.
 */
export function loadSampler(root, snapshot, { everyMs = 60_000, keepMs = 7 * dayMs } = {}) {
  const path = join(root, "monitor-load.json");
  const stored = readJson(path)?.samples;
  const samples = (Array.isArray(stored) ? stored : []).filter(sample => Date.parse(sample?.at) > Date.now() - keepMs);
  let saved = Date.now();
  const sample = () => {
    try {
      const state = snapshot();
      const health = state.service?.alive ? state.service.health : null;
      samples.push({ at: new Date().toISOString(), cpu: health?.cpuBusyPercent ?? null, memGb: health?.freeMemGb ?? null });
      while (samples.length && Date.parse(samples[0].at) < Date.now() - keepMs) samples.shift();
      if (Date.now() - saved > 5 * 60_000) { saved = Date.now(); writeJson(path, { samples }).catch(() => {}); }
    } catch { /* A missed sample leaves a gap in the chart. */ }
  };
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    /** The last `days` in `points` buckets: mean CPU and memory from the samples, and the requests waiting and running at each bucket's middle. */
    read(days = 1, points = 288, requests = [], now = Date.now()) {
      const from = now - days * dayMs, width = days * dayMs / points;
      const buckets = Array.from({ length: points }, () => []);
      for (const row of samples) {
        const key = Math.floor((Date.parse(row.at) - from) / width);
        if (key >= 0 && key < points) buckets[key].push(row);
      }
      const waits = waitingIntervals(requests, now);
      const runs = requests.flatMap(({ status }) => status.attempts.map(attempt => [Date.parse(attempt.startedAt), attempt.endedAt ? Date.parse(attempt.endedAt) : status.state === "running" ? now : Date.parse(attempt.startedAt)]));
      const during = (intervals, t) => intervals.filter(([start, end]) => start <= t && t < end).length;
      const mean = (rows, field) => { const values = rows.map(row => row[field]).filter(Number.isFinite); return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null; };
      return buckets.map((rows, key) => {
        const t = from + (key + 0.5) * width;
        return { at: new Date(t).toISOString(), cpu: mean(rows, "cpu"), memGb: mean(rows, "memGb"), queued: during(waits, t), running: during(runs, t) };
      });
    },
  };
}

// Only this host's own names and the tailnet's reach the page, so a web page that rebinds a name to this host cannot read it.
const allowedHost = host => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu.test(host ?? "") || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d+)?$/iu.test(host ?? "");

// The dashboard's only writes. A page on another site cannot send JSON without a CORS preflight,
// which this server never grants, and a browser names the page's origin, which must be this host.
const writePaths = { "/api/pause": "pause", "/api/resume": "resume", "/api/lanes": "lanes" };
// The dashboard switches between these lane counts. It shows any count the setting allows, 1 to 4.
const switchLanes = [2, 3];
const bodyLimit = 4096;
// URL drops a scheme's default port, so `Host: pc.ts.net:443` and `Origin: https://pc.ts.net` name one origin.
const sameHost = (origin, host) => { try { return new URL(`${origin.protocol}//${host}`).host === origin.host; } catch { return false; } };

/**
 * A write's JSON object, `{ refused: [status, message] }` before anything changes, or `{ gone: true }` when the
 * client left mid-body. Reads at most `bodyLimit` bytes for at most `waitMs`.
 */
async function writeBody(request, waitMs) {
  if ((request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return { refused: [415, "Send the write as application/json."] };
  let origin = null;
  try { origin = new URL(request.headers.origin); } catch { /* No origin, or not a URL. */ }
  if (!["http:", "https:"].includes(origin?.protocol) || !sameHost(origin, request.headers.host)) return { refused: [403, "A write must come from the dashboard page on this host."] };
  if (Number(request.headers["content-length"] ?? 0) > bodyLimit) return { refused: [413, "The request is too large."] };
  let timer;
  const raw = await new Promise(done => {
    const chunks = [];
    let size = 0;
    timer = setTimeout(done, waitMs, "slow");
    request.on("data", chunk => { size += chunk.length; if (size > bodyLimit) done("large"); else chunks.push(chunk); });
    request.on("end", () => done(Buffer.concat(chunks)));
    request.on("error", () => done("gone"));
  }).finally(() => clearTimeout(timer));
  if (raw === "gone") return { gone: true };
  if (raw === "slow") return { refused: [408, "The request body did not arrive in time."] };
  if (raw === "large") return { refused: [413, "The request is too large."] };
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { refused: [400, "The body is not a JSON object."] };
  if (body.reason != null && typeof body.reason !== "string") return { refused: [400, "The reason must be text."] };
  return { body };
}

/**
 * Serve the dashboard and its data on this host. Returns the server; `close()` stops it and its sampler.
 * `oneLane` refuses the lane switch: a Mac has one display, and Electron runs cannot share it.
 */
export function startMonitor({ root, port = monitorPort, host = "127.0.0.1", log = () => {}, now = Date.now, sampleEveryMs, writeWaitMs = 10_000,
  threadOf = threadDirectory(), slotRoot = verificationSlotRoot(), oneLane = process.platform === "darwin" }) {
  const finished = new Map();
  const history = historyReader(root);
  // The verification slots live beside the build slots. A held slot above the setting is a lane still finishing its gate, so it is shown too.
  const slots = lanes => slotRoot ? buildQueueStatus({ root: slotRoot, kind: "verification-slot", slots: Math.max(lanes, ...heldVerificationSlots(slotRoot)) }) : null;
  const lanes = () => laneSetting(slotRoot);
  let cached = null;
  // Every open page polls; one snapshot serves them all for two seconds.
  const snapshot = () => {
    if (!cached || Date.now() - cached.at > 2000) {
      const state = monitorState(root, { now: now(), finished, history, threadOf, slots, lanes });
      cached = { at: Date.now(), state, body: JSON.stringify(state) };
    }
    return cached;
  };
  const load = loadSampler(root, () => snapshot().state, { everyMs: sampleEveryMs });
  // Pause or resume the queue, or set the lane count, for the dashboard page, and record the host name it used.
  const write = async (request, action, send) => {
    const { body, refused, gone } = await writeBody(request, writeWaitMs);
    if (gone) return;
    if (refused) return send(refused[0], "text/plain", refused[1]);
    const host = request.headers.host;
    let answer;
    if (action === "lanes") {
      if (oneLane) return send(409, "text/plain", "This Mac runs one lane: Electron runs cannot share its display.");
      if (!switchLanes.includes(body.lanes)) return send(400, "text/plain", "Choose 2 or 3 lanes.");
      if (!slotRoot) return send(409, "text/plain", "This host has no verification lane setting.");
      const { previous, changed } = await setLanes({ root, slotRoot, lanes: body.lanes, by: { name: "dashboard", host } });
      if (changed) log(`the dashboard at ${host} set the verification lanes to ${body.lanes}, from ${previous ?? "a setting that could not be read"}`);
      answer = { changed, lanes: body.lanes };
    } else if (action === "pause") {
      const { pause, changed } = await pauseQueue(root, { reason: body.reason, by: { name: "dashboard", host } });
      if (changed) log(`the dashboard at ${host} paused the queue${pause.reason ? `: ${pause.reason}` : ""}`);
      answer = { changed, pause };
    } else {
      const ended = await resumeQueue(root);
      if (ended) log(`the dashboard at ${host} resumed the queue`);
      answer = { changed: Boolean(ended), pause: null };
    }
    // The next poll shows the change, not a snapshot from before it.
    cached = null;
    return send(200, "application/json", JSON.stringify(answer));
  };
  const server = createServer((request, response) => {
    const send = (code, type, body, headers = {}) => {
      response.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        // Closing the connection stops a refused client from streaming the rest of a body.
        ...(code >= 400 && !["GET", "HEAD"].includes(request.method) ? { connection: "close" } : {}), ...headers });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const json = value => value ? send(200, "application/json", JSON.stringify(value)) : send(404, "application/json", "null");
    const failed = error => {
      log(`monitor request failed: ${error.stack ?? error.message}`);
      try { send(500, "text/plain", "The monitor could not read or change the queue."); } catch { /* The client is gone. */ }
    };
    try {
      // Tailscale sets this header on every Funnel request and removes any copy a client sends.
      if (request.headers["tailscale-funnel-request"]) return send(403, "text/plain", "This page does not answer through Tailscale Funnel.");
      if (!allowedHost(request.headers.host)) return send(403, "text/plain", "This page answers only on this host and its tailnet name.");
      const url = new URL(request.url, "http://monitor");
      const action = writePaths[url.pathname];
      if (action) return request.method === "POST" ? void write(request, action, send).catch(failed) : send(405, "text/plain", "Pause, resume, and the lane switch take a POST.", { allow: "POST" });
      if (request.method !== "GET" && request.method !== "HEAD") return send(405, "text/plain", "Only pause, resume, and the lane switch change the queue.", { allow: "GET, HEAD" });
      const query = name => url.searchParams.get(name);
      const asset = assets[url.pathname];
      if (asset) return send(200, asset[1], readFileSync(assetPath(asset[0])));
      if (url.pathname === "/api/state") return send(200, "application/json", snapshot().body);
      if (url.pathname === "/api/run") return json(runDetails(root, query("id"), query("attempt")));
      // Not /api/log: uBlock Origin's default EasyPrivacy list blocks any URL containing /log?id=.
      if (url.pathname === "/api/output") return json(query("slot") ? slotLog(slots(maxVerificationLanes), query("slot"), query("file")) : runLog(root, query("id"), query("attempt"), query("file")));
      if (url.pathname === "/api/load") return json({ samples: load.read(query("days") === "7" ? 7 : 1, 288, listRequests(root, finished)) });
      return send(404, "text/plain", "Not found.");
    } catch (error) { failed(error); }
  });
  server.on("error", error => {
    log(`the monitor could not serve on ${host}:${port}: ${error.message}`);
    // A service that is still exiting may hold the port for a moment.
    if (error.code === "EADDRINUSE") setTimeout(() => server.listen(port, host), 30_000).unref();
  });
  server.on("close", () => load.stop());
  server.listen(port, host);
  server.unref();
  return server;
}
