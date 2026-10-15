// A read-only web dashboard for the verification queue: what each lane runs now and
// its live output, what waits, and what ran this week. The service serves it on this
// host only; reach it from other devices through a private Tailscale Serve route. It
// reads the queue's own files and writes only its load samples, so a fault here can
// never stop a run.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastNightlyPass, listRequests, monitorPort, position, queuePaths, readJson, serviceState, terminalStates, writeJson } from "./queue.mjs";

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

const stepRow = step => ({ name: step.name, verdict: step.verdict ?? null, startedAt: step.startedAt ?? null,
  seconds: Number.isFinite(step.seconds) ? Math.round(step.seconds) : null });

/** A running attempt's steps from its receipt so far, and its three most recently written logs. */
function progress(root, id, n) {
  const folder = queuePaths(root).attempt(id, n);
  const steps = (readJson(join(folder, "result.json"))?.steps ?? []).map(stepRow);
  return { steps, logs: attemptLogs(folder).slice(0, 3) };
}

/**
 * Everything the dashboard shows, from the queue's files. Finished requests are cached
 * by the caller's `finished` map, as the service does, so a refresh reads only live ones.
 */
export function monitorState(root, { now = Date.now(), days = 7, finished = new Map(), history = historyReader(root) } = {}) {
  const { record, alive } = serviceState(root, now);
  const requests = listRequests(root, finished);
  for (const entry of requests) if (terminalStates.has(entry.status.state)) finished.set(entry.id, entry);
  const running = record?.running ?? [];
  const since = now - days * dayMs;
  const runs = requests.flatMap(entry => entry.status.attempts.flatMap(row => {
    const live = running.find(run => run.id === entry.id && run.attempt === row.n);
    const endedAt = row.endedAt ?? null;
    if (Date.parse(endedAt ?? row.startedAt) < since) return [];
    // An attempt without an end that the service is not running was cut short; its outcome is recorded on recovery.
    const outcome = row.outcome ?? (live ? "running" : "interrupted");
    return [{
      id: entry.id, attempt: row.n, branch: branchOf(entry.request), nightly: Boolean(entry.request.nightly), scope: entry.request.scope,
      head: entry.request.head.slice(0, 12), lane: row.lane ?? (live ? live.checkout.endsWith("-2") ? 2 : 1 : null), startedAt: row.startedAt, endedAt, outcome,
      cause: row.cause ?? null, reason: clip(row.reason, 300), awakeMs: live?.awakeMs ?? row.awakeMs ?? null, flaky: row.flaky?.length ?? 0,
      ...(live ? { phase: live.phase, ...progress(root, entry.id, row.n) } : {}),
    }];
  })).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const typicalMs = median(runs.filter(run => run.outcome === "passed").slice(-20).map(run => run.awakeMs));
  const queued = requests.filter(entry => entry.status.state === "queued")
    .sort((a, b) => position(requests, a.id) - position(requests, b.id))
    .map(entry => ({
      id: entry.id, branch: branchOf(entry.request), nightly: Boolean(entry.request.nightly), scope: entry.request.scope, head: entry.request.head.slice(0, 12),
      submittedAt: entry.request.submittedAt ?? entry.request.acceptedAt, retry: entry.status.attempts.length > 0,
      notBefore: entry.status.notBefore ?? null, waiting: clip(entry.status.waiting, 200),
    }));
  const events = history(days, now);
  const tests = new Map();
  const steps = new Map();
  for (const event of events) {
    for (const row of event.flaky ?? []) {
      const key = `${row.step}\n${row.test}`;
      const item = tests.get(key) ?? { step: row.step, test: row.test, flaky: 0, slow: [], last: null };
      item.flaky += 1;
      item.last = event.at;
      tests.set(key, item);
    }
    for (const row of event.slowest ?? []) {
      const key = `${row.step}\n${row.test}`;
      const item = tests.get(key) ?? { step: row.step, test: row.test, flaky: 0, slow: [], last: null };
      item.slow.push(row.seconds);
      tests.set(key, item);
    }
    if (event.outcome === "passed") for (const [name, seconds] of Object.entries(event.steps ?? {})) steps.set(name, [...(steps.get(name) ?? []), seconds]);
  }
  const all = [...tests.values()];
  const nightly = requests.findLast(entry => entry.request.nightly);
  const pass = lastNightlyPass(requests);
  return {
    now, days,
    service: record ? { alive, commit: record.commit?.slice(0, 12) ?? null, pid: record.pid, startedAt: record.startedAt, heartbeatAt: record.heartbeatAt, lanes: record.lanes ?? 1, health: record.health ?? null } : null,
    typicalMs, runs, queued,
    flaky: all.filter(item => item.flaky).sort((a, b) => b.flaky - a.flaky).slice(0, 15).map(({ slow: _slow, ...item }) => item),
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

/** The resolved path of a log inside `folder`, or null for any path outside it. */
function inside(folder, path) {
  if (typeof path !== "string") return null;
  const full = resolve(folder, path);
  const within = relative(folder, full);
  return !within || within.startsWith("..") || isAbsolute(within) ? null : full;
}

/** A failing log's test summary, or its last lines, without terminal colors. */
function failureExcerpt(folder, path) {
  const full = inside(folder, path);
  if (!full) return null;
  try {
    const lines = plain(readFileSync(full, "utf8")).split(/\r?\n/u);
    const start = lines.findLastIndex(line => failureSummary.test(line));
    return (start >= 0 ? lines.slice(start, start + 200) : lines.slice(-80)).join("\n").slice(0, 16_000);
  } catch { return null; }
}

/** The last lines of a file, reading only its end. A line a progress bar rewrote with \r shows its last state. */
function tail(path, bytes = 96 * 1024, lines = 400) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const rows = plain(buffer.toString("utf8")).split("\n").map(row => row.split("\r").filter(Boolean).at(-1) ?? "");
    return (length < size ? rows.slice(1) : rows).slice(-lines).join("\n");
  } finally { closeSync(fd); }
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
  const step = (item, group) => ({ group, ...stepRow(item), error: clip(item.error, 400), log: item.verdict === "FAIL" ? failureExcerpt(folder, item.log) : null });
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
  const folder = attemptFolder(root, id, n);
  const full = folder && logName.test(file ?? "") ? inside(folder, file) : null;
  if (!full) return null;
  try {
    const stat = statSync(full);
    return { file, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString(), text: tail(full) };
  } catch { return null; }
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
  const samples = (readJson(path)?.samples ?? []).filter(sample => Date.parse(sample.at) > Date.now() - keepMs);
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

/** Serve the dashboard and its data on this host. Returns the server; `close()` stops it and its sampler. */
export function startMonitor({ root, port = monitorPort, host = "127.0.0.1", log = () => {}, sampleEveryMs }) {
  const finished = new Map();
  const history = historyReader(root);
  let cached = null;
  // Every open page polls; one snapshot serves them all for two seconds.
  const snapshot = () => {
    if (!cached || Date.now() - cached.at > 2000) {
      const state = monitorState(root, { finished, history });
      cached = { at: Date.now(), state, body: JSON.stringify(state) };
    }
    return cached;
  };
  const load = loadSampler(root, () => snapshot().state, { everyMs: sampleEveryMs });
  const server = createServer((request, response) => {
    const send = (code, type, body) => {
      response.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const json = value => value ? send(200, "application/json", JSON.stringify(value)) : send(404, "application/json", "null");
    try {
      if (!allowedHost(request.headers.host)) return send(403, "text/plain", "This page answers only on this host and its tailnet name.");
      if (request.method !== "GET" && request.method !== "HEAD") return send(405, "text/plain", "The monitor is read-only.");
      const url = new URL(request.url, "http://monitor");
      const query = name => url.searchParams.get(name);
      const asset = assets[url.pathname];
      if (asset) return send(200, asset[1], readFileSync(assetPath(asset[0])));
      if (url.pathname === "/api/state") return send(200, "application/json", snapshot().body);
      if (url.pathname === "/api/run") return json(runDetails(root, query("id"), query("attempt")));
      if (url.pathname === "/api/log") return json(runLog(root, query("id"), query("attempt"), query("file")));
      if (url.pathname === "/api/load") return json({ samples: load.read(query("days") === "7" ? 7 : 1, 288, listRequests(root, finished)) });
      return send(404, "text/plain", "Not found.");
    } catch (error) {
      log(`monitor request failed: ${error.stack ?? error.message}`);
      try { send(500, "text/plain", "The monitor could not read the queue."); } catch { /* The client is gone. */ }
    }
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
