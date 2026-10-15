// A read-only web page for the verification queue: what runs now, what waits, and
// what ran this week. The service serves it on this host only; reach it from other
// devices through a private Tailscale Serve route. It reads the queue's own files and
// changes nothing, so a fault here can never stop a run.

import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { lastNightlyPass, listRequests, monitorPort, position, queuePaths, readJson, serviceState, terminalStates } from "./queue.mjs";

const page = fileURLToPath(new URL("./queue-monitor.html", import.meta.url));
const dayMs = 24 * 60 * 60_000;
const requestId = /^\d{9}-[0-9a-f]{6}$/u;
const branchOf = request => request.nightly ? "main (nightly)" : request.branch?.replace("refs/heads/", "") ?? request.checkout;
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const clip = (text, length) => typeof text === "string" && text.length > length ? `${text.slice(0, length)}…` : text ?? null;

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

/** The steps a running attempt is in, and how many have finished, from its receipt so far. */
function progress(root, id, n) {
  const receipt = readJson(join(queuePaths(root).attempt(id, n), "result.json"));
  const steps = receipt?.steps ?? [];
  return { steps: steps.filter(step => step.verdict === "RUNNING").map(step => step.name), done: steps.filter(step => step.verdict && step.verdict !== "RUNNING").length };
}

/**
 * Everything the page shows, from the queue's files. Finished requests are cached by
 * the caller's `finished` map, as the service does, so a refresh reads only live ones.
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
      lane: row.lane ?? (live ? live.checkout.endsWith("-2") ? 2 : 1 : null), startedAt: row.startedAt, endedAt, outcome,
      cause: row.cause ?? null, reason: clip(row.reason, 300), awakeMs: live?.awakeMs ?? row.awakeMs ?? null, flaky: row.flaky?.length ?? 0,
      ...(live ? { phase: live.phase, ...progress(root, entry.id, row.n) } : {}),
    }];
  })).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const typicalMs = median(runs.filter(run => run.outcome === "passed").slice(-20).map(run => run.awakeMs));
  const queued = requests.filter(entry => entry.status.state === "queued")
    .sort((a, b) => position(requests, a.id) - position(requests, b.id))
    .map(entry => ({
      id: entry.id, branch: branchOf(entry.request), nightly: Boolean(entry.request.nightly), scope: entry.request.scope,
      submittedAt: entry.request.submittedAt ?? entry.request.acceptedAt, retry: entry.status.attempts.length > 0,
      notBefore: entry.status.notBefore ?? null, waiting: clip(entry.status.waiting, 200),
    }));
  const tests = new Map();
  for (const event of history(days, now)) {
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
    nightly: nightly ? { id: nightly.id, head: nightly.request.head.slice(0, 12), state: nightly.status.state, at: nightly.status.updatedAt ?? null } : null,
    lastNightlyPass: pass ? { id: pass.id, head: pass.request.head.slice(0, 12), at: pass.status.updatedAt ?? null } : null,
  };
}

// Where a test runner's own failure summary starts: node:test, vitest, Playwright, and nextest.
const failureSummary = /^(✖ failing tests:|\s*⎯+ Failed Tests? \d+ ⎯+|\s*\d+ failed$|\s*Summary \[.*\].*failed)/mu;

/** A failing log's test summary, or its last lines, without terminal colors. Only logs inside the attempt's folder are read. */
function failureExcerpt(folder, path) {
  if (typeof path !== "string") return null;
  const inside = relative(folder, resolve(path));
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  try {
    const text = readFileSync(resolve(path), "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");
    const lines = text.split(/\r?\n/u);
    const start = lines.findLastIndex(line => failureSummary.test(line));
    return (start >= 0 ? lines.slice(start, start + 200) : lines.slice(-80)).join("\n").slice(0, 16_000);
  } catch { return null; }
}

/** One attempt's steps, failures, and the end of each failing step's log. */
export function runDetails(root, id, n) {
  if (!requestId.test(id ?? "") || !/^\d{1,3}$/u.test(String(n ?? ""))) return null;
  const request = readJson(join(queuePaths(root).request(id), "request.json"));
  const status = readJson(join(queuePaths(root).request(id), "status.json"));
  if (!request || !status) return null;
  const row = status.attempts.find(attempt => attempt.n === Number(n));
  if (!row) return null;
  const folder = queuePaths(root).attempt(id, n);
  const receipt = readJson(join(folder, "result.json"));
  const js = readJson(join(folder, "js-tests", "result.json"));
  const step = (item, group) => ({ group, name: item.name, verdict: item.verdict ?? null, seconds: Number.isFinite(item.seconds) ? Math.round(item.seconds) : null,
    error: clip(item.error, 400), log: item.verdict === "FAIL" ? failureExcerpt(folder, item.log) : null });
  return {
    id, attempt: Number(n), branch: branchOf(request), head: request.head.slice(0, 12), base: request.base.slice(0, 12), scope: request.scope, nightly: Boolean(request.nightly),
    state: status.state, outcome: row.outcome ?? null, cause: row.cause ?? null, reason: clip(row.reason, 600), startedAt: row.startedAt ?? null, endedAt: row.endedAt ?? null,
    verdict: receipt?.verdict ?? null, error: clip(receipt?.error, 600),
    steps: [...(receipt?.steps ?? []).map(item => step(item, "gate")), ...(js?.steps ?? []).map(item => step(item, "javascript"))],
    flaky: receipt?.flaky ?? [], slowest: (receipt?.slowest ?? []).slice(0, 10),
  };
}

// Only this host's own names and the tailnet's reach the page, so a web page that rebinds a name to this host cannot read it.
const allowedHost = host => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu.test(host ?? "") || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d+)?$/iu.test(host ?? "");

/** Serve the page and its data on this host. Returns the server; `close()` stops it. */
export function startMonitor({ root, port = monitorPort, host = "127.0.0.1", log = () => {} }) {
  const finished = new Map();
  const history = historyReader(root);
  let cached = null;
  const state = () => {
    // Every open page polls; one snapshot serves them all for two seconds.
    if (!cached || Date.now() - cached.at > 2000) cached = { at: Date.now(), body: JSON.stringify(monitorState(root, { finished, history })) };
    return cached.body;
  };
  const server = createServer((request, response) => {
    const send = (code, type, body) => {
      response.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    try {
      if (!allowedHost(request.headers.host)) return send(403, "text/plain", "This page answers only on this host and its tailnet name.");
      if (request.method !== "GET" && request.method !== "HEAD") return send(405, "text/plain", "The monitor is read-only.");
      const url = new URL(request.url, "http://monitor");
      if (url.pathname === "/") return send(200, "text/html; charset=utf-8", readFileSync(page));
      if (url.pathname === "/api/state") return send(200, "application/json", state());
      if (url.pathname === "/api/run") {
        const details = runDetails(root, url.searchParams.get("id"), url.searchParams.get("attempt"));
        return details ? send(200, "application/json", JSON.stringify(details)) : send(404, "application/json", "null");
      }
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
  server.listen(port, host);
  server.unref();
  return server;
}
