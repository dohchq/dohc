"use strict";
// The verification queue dashboard. It polls the service's read-only API and redraws only what changed,
// so a terminal keeps its scroll position and a table keeps its hover while the numbers move.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
const at = t => clockFormat.format(new Date(t));
const dur = ms => ms == null || !Number.isFinite(ms) ? "unknown" : ms >= HOUR ? `${Math.floor(ms / HOUR)} h ${String(Math.round(ms % HOUR / MIN)).padStart(2, "0")} m` : `${Math.max(0, Math.round(ms / MIN))} min`;
const stopwatch = ms => { const s = Math.max(0, Math.floor((ms ?? 0) / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
const ago = t => `${dur(Date.now() - t)} ago`;
const seconds = s => s == null ? "" : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`;
const OUTCOME = { passed: "Passed", failed: "Failed", environment: "Machine failure", error: "Host gave up", cancelled: "Cancelled", superseded: "Replaced", interrupted: "Interrupted", running: "Running", queued: "Waiting" };
const outcomeName = o => OUTCOME[o] ?? o;
const machine = o => o === "environment" || o === "error";
const prLink = branch => branch === "main (nightly)" ? "https://github.com/dohchq/dohc/commits/main" : `https://github.com/dohchq/dohc/pulls?q=is%3Apr+head%3A${encodeURIComponent(branch)}`;
const runKey = run => `${run.id}/${run.attempt}`;

const ui = { data: null, load: { 1: null, 7: null }, loadRange: 1, tab: "now", range: 1, filter: "all", search: "", shown: 25, laneLog: new Map(), drawer: null, failures: 0 };

// Set an element's HTML only when it changed, so unchanged parts keep focus, hover, and scroll.
function patch(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/* Theme: follow the system, or keep the person's choice. */
const THEMES = ["system", "light", "dark"];
const themeIcon = {
  system: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3"/></g></svg>',
  dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor"/></svg>',
};
function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  $("#theme").innerHTML = themeIcon[theme];
  $("#theme").setAttribute("aria-label", `Theme: ${theme}. Change theme`);
  $("#theme").title = `Theme: ${theme}`;
}
let theme = localStorage.getItem("queue-theme") ?? "system";
if (!THEMES.includes(theme)) theme = "system";

/* Tabs, kept in the address so a reload or a bookmark returns to the same view. */
const TABS = ["now", "queue", "history", "tests", "nightly"];
function showTab(tab) {
  ui.tab = TABS.includes(tab) ? tab : "now";
  for (const button of $$(".topbar [data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === ui.tab));
  for (const name of TABS) $(`#view-${name}`).hidden = name !== ui.tab;
  if (location.hash.slice(1) !== ui.tab) history.replaceState(null, "", `#${ui.tab}`);
  render();
  if (ui.tab === "now") refreshTerminals();
  if (ui.tab === "queue" && !ui.load[ui.loadRange]) refreshLoad(ui.loadRange);
}

/* Lanes for attempts recorded before the service stored them: the first lane free at the start. */
function withLanes(runs) {
  const free = [0, 0];
  return runs.map(run => ({ ...run })).map(run => {
    const end = run.endedAt ? Date.parse(run.endedAt) : Infinity;
    if (!run.lane) {
      const start = Date.parse(run.startedAt);
      run.lane = free[0] <= start ? 1 : free[1] <= start ? 2 : free[0] <= free[1] ? 1 : 2;
    }
    free[run.lane - 1] = end;
    return run;
  });
}

// Each lane frees when its run reaches the typical time; each waiting request then takes the typical time.
function startTimes(data, running) {
  const lanes = data.service?.lanes ?? 1;
  const typical = data.typicalMs ?? 0;
  const free = running.map(run => data.now + Math.max(typical - (run.awakeMs ?? 0), 5 * MIN));
  while (free.length < lanes) free.push(data.now);
  return data.queued.map(entry => {
    free.sort((a, b) => a - b);
    const starts = Math.max(free[0], entry.notBefore ? Date.parse(entry.notBefore) : 0);
    free[0] = starts + typical;
    return starts;
  });
}

function derived() {
  const data = ui.data;
  const runs = withLanes(data.runs);
  const running = runs.filter(run => run.outcome === "running");
  const finished = runs.filter(run => run.endedAt).sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  return { data, runs, running, finished, starts: startTimes(data, running) };
}

/* Header, banners, and the key numbers. */
function renderHeader({ data }) {
  const svc = data.service;
  const beat = svc ? Date.parse(svc.heartbeatAt) : null;
  patch($("#service"), !svc ? '<span class="dot bad"></span>The service has never started'
    : svc.alive ? `<span class="dot ok"></span>Service running <span class="mono muted">${esc(svc.commit ?? "")}</span>`
    : `<span class="dot bad"></span>Service silent since ${esc(at(beat))}`);
  $("#updated").textContent = `Updated ${at(data.now)}`;
  $("#queue-count").textContent = data.queued.length || "";
  const banners = [];
  if (svc && !svc.alive) banners.push(`<div class="banner bad">The service has not checked in for ${esc(dur(data.now - beat))}, so nothing new starts. Task Scheduler restarts it within five minutes. If it stays down, run <span class="mono">pnpm verify:queue restart</span> on the host.</div>`);
  if (svc?.health?.reason) banners.push(`<div class="banner">${esc(svc.health.reason)}</div>`);
  patch($("#banners"), banners.join(""));
}

function renderStrip({ data, running, finished, starts }) {
  const lanes = data.service?.lanes ?? 1;
  const day = finished.filter(run => Date.parse(run.endedAt) > data.now - DAY);
  const count = test => day.filter(test).length;
  const passed = count(run => run.outcome === "passed"), failed = count(run => run.outcome === "failed"), machines = count(run => machine(run.outcome));
  const oldest = Math.min(...data.queued.map(q => Date.parse(q.submittedAt)));
  const clears = data.queued.length && data.typicalMs ? starts.at(-1) + data.typicalMs : null;
  const health = data.service?.health ?? {};
  const pct = (n, total) => total ? `${(n / total * 100).toFixed(1)}%` : "0%";
  const meter = (label, value, fill, cls = "") => `<div class="meter"><span class="m-label">${label}</span><b>${value}</b><div class="m-bar"><i class="${cls}" style="width:${Math.max(0, Math.min(100, fill))}%"></i></div></div>`;
  const cpu = health.cpuBusyPercent, mem = health.freeMemGb, disk = health.diskFreeGb;
  patch($("#strip"), `
    <div class="stat"><div class="label">Running</div><div class="value">${running.length} of ${lanes}</div><div class="sub">${running.length === lanes ? "every lane busy" : `${lanes - running.length} lane free`}</div></div>
    <div class="stat"><div class="label">Waiting</div><div class="value${data.queued.length > 2 * lanes ? " warn" : ""}">${data.queued.length}</div><div class="sub">${data.queued.length ? `oldest waited ${esc(dur(data.now - oldest))}` : "nothing waiting"}</div></div>
    <div class="stat"><div class="label">Line clears</div><div class="value${clears && clears - data.now > 2 * HOUR ? " warn" : ""}">${clears ? `≈ ${esc(at(clears))}` : "Now"}</div><div class="sub">${clears ? `in ${esc(dur(clears - data.now))} if nothing new arrives` : "no backlog"}</div></div>
    <div class="stat"><div class="label">Last 24 hours</div><div class="value">${day.length ? Math.round(passed / day.length * 100) : 0}% <span class="muted" style="font-size:14px">passed</span></div>
      <div class="mini" title="${passed} passed, ${failed} failed, ${machines} machine failures"><i class="passed" style="width:${pct(passed, day.length)}"></i><i class="failed" style="width:${pct(failed, day.length)}"></i><i class="environment" style="width:${pct(machines, day.length)}"></i></div>
      <div class="sub">${passed} passed, ${failed} failed, ${machines} machine</div></div>
    <div class="stat"><div class="label">Typical passing gate</div><div class="value">${data.typicalMs ? esc(stopwatch(data.typicalMs)) : "—"}</div><div class="sub">${(day.length / 24).toFixed(1)} runs an hour</div></div>
    <div class="stat"><div class="label">Host</div><div class="meters">
      ${meter("CPU", cpu != null ? `${cpu}%` : "?", cpu ?? 0, cpu >= 90 ? "bad" : cpu >= 75 ? "warn" : "")}
      ${meter("Free memory", mem != null ? `${mem} GB` : "?", mem != null ? mem / 64 * 100 : 0, mem != null && mem < 10 ? "warn" : "")}
      ${meter("Free disk", disk != null ? `${Math.round(disk)} GB` : "?", disk != null ? Math.min(100, disk / 200 * 100) : 0, disk != null && disk < 40 ? "warn" : "")}
    </div><div class="sub">Docker ${health.dockerOk === false ? "not responding" : "responding"}</div></div>`);
}

/* Lanes: each keeps its own elements so its terminal survives refreshes. */
function laneShell(n) {
  let el = $(`#lane-${n}`);
  if (el) return el;
  el = document.createElement("article");
  el.id = `lane-${n}`;
  el.className = "lane";
  el.innerHTML = `<div class="lane-no" aria-hidden="true">${n}</div><div class="lane-head"></div><div class="lane-track"></div><div class="lane-steps"></div>
    <div class="terminal" hidden><div class="term-head"><div class="term-tabs" role="group" aria-label="Log"></div><button class="term-open" type="button">Run details</button></div><pre class="term-body" tabindex="0" aria-label="Lane ${n} output"></pre></div>
    <div class="lane-next"></div>`;
  $("#lanes").append(el);
  return el;
}

// A log's short name: its package or step, or "verifier" for the verifier's own output.
const logLabel = file => file === "worker.log" ? "verifier" : file.replace(/\.log$/, "").replace(/^js-tests\//, "").replace(/^_dohc_/, "");

function defaultLog(run) {
  const logs = run.logs ?? [];
  return (logs.find(log => log.file !== "worker.log") ?? logs[0])?.file ?? null;
}

function renderLanes({ data, running, starts }) {
  const lanes = Math.max(data.service?.lanes ?? 1, ...running.map(run => run.lane));
  for (const el of $$("#lanes > .lane")) if (Number(el.id.slice(5)) > lanes) el.remove();
  const stepTimes = new Map((data.stepTimes ?? []).map(step => [step.name, step.medianSeconds]));
  for (let n = 1; n <= lanes; n += 1) {
    const el = laneShell(n);
    const run = running.find(r => r.lane === n);
    const late = run && data.typicalMs && run.awakeMs > data.typicalMs * 1.2;
    el.className = `lane${run ? " running" : ""}${late ? " late" : ""}`;
    el.dataset.key = run ? runKey(run) : "";
    if (!run) {
      const next = data.queued[0];
      patch($(".lane-head", el), `<div class="lane-who"><div class="lane-idle">Idle</div></div>`);
      patch($(".lane-track", el), "");
      patch($(".lane-steps", el), "");
      $(".terminal", el).hidden = true;
      patch($(".lane-next", el), next ? `Next up: <b>${esc(next.branch)}</b>, starts ≈ ${esc(at(starts[0]))}` : "Nothing is waiting.");
      continue;
    }
    const left = data.typicalMs ? data.typicalMs - (run.awakeMs ?? 0) : null;
    patch($(".lane-head", el), `
      <div class="lane-who"><a class="lane-branch" href="${esc(prLink(run.branch))}" target="_blank" rel="noreferrer" title="${esc(run.branch)}">${esc(run.branch)}</a>
        <div class="lane-meta"><span>In the lane since ${esc(at(Date.parse(run.startedAt)))}</span>${run.attempt > 1 ? `<span>Attempt ${run.attempt}</span>` : ""}<span class="mono">${esc(run.head)}</span>${run.scope !== "all" ? `<span>${esc(run.scope)} only</span>` : ""}${run.phase && run.phase !== "verifying" ? `<span>${esc(run.phase)}</span>` : ""}</div></div>
      <div class="lane-clock"><b>${esc(stopwatch(run.awakeMs))}</b><span class="${late ? "warn" : ""}">${left == null ? "no typical time yet" : left >= 0 ? `≈ ${esc(dur(left))} left of ${esc(stopwatch(data.typicalMs))}` : `${esc(dur(-left))} over typical`}</span></div>`);
    // The step track: each finished or running step is as wide as its time; the mark is the typical gate.
    const steps = (run.steps ?? []).filter(step => step.verdict);
    const elapsed = step => step.seconds ?? (step.startedAt ? (data.now - Date.parse(step.startedAt)) / 1000 : 0);
    const total = Math.max((data.typicalMs ?? 0) / 1000, steps.reduce((sum, step) => sum + elapsed(step), 0), 1);
    const typicalMark = data.typicalMs ? `<span class="typical" style="left:${Math.min(100, data.typicalMs / 1000 / total * 100)}%" data-tip="Typical passing gate\n${stopwatch(data.typicalMs)}"></span>` : "";
    patch($(".lane-track", el), `<div class="steptrack">${steps.map(step => {
      const cls = step.verdict === "NOT RUN" ? "NOT" : step.verdict;
      const typical = stepTimes.get(step.name);
      return `<i class="seg-${esc(cls)}" style="flex:0 0 ${(elapsed(step) / total * 100).toFixed(2)}%" data-tip="${esc(`${step.name}\n${step.verdict === "RUNNING" ? "running for" : step.verdict.toLowerCase()} ${seconds(elapsed(step))}${typical ? `, typically ${seconds(typical)}` : ""}`)}"></i>`;
    }).join("")}${typicalMark}</div>`);
    const active = steps.filter(step => step.verdict === "RUNNING");
    const done = steps.filter(step => step.verdict !== "RUNNING");
    const failed = steps.filter(step => step.verdict === "FAIL");
    patch($(".lane-steps", el), `${active.map(step => `<span class="chip">${esc(step.name)}</span>`).join("")}
      <span>${done.length} step${done.length === 1 ? "" : "s"} done</span>${failed.length ? `<span class="result failed">${esc(failed.map(step => step.name).join(", "))} failed</span>` : ""}`);
    const terminal = $(".terminal", el);
    terminal.hidden = false;
    const chosen = ui.laneLog.get(runKey(run)) ?? defaultLog(run);
    const files = [...new Set([chosen, ...(run.logs ?? []).map(log => log.file)].filter(Boolean))].slice(0, 4);
    patch($(".term-tabs", el), files.map(file => `<button type="button" data-lane-log="${esc(file)}" aria-pressed="${file === chosen}" title="${esc(file)}">${esc(logLabel(file))}</button>`).join(""));
    patch($(".lane-next", el), "");
  }
}

async function refreshTerminals() {
  if (ui.tab !== "now" || document.hidden || !ui.data) return;
  for (const el of $$("#lanes > .lane.running")) {
    const key = el.dataset.key;
    if (!key) continue;
    const [id, attempt] = key.split("/");
    const run = ui.data.runs.find(r => runKey(r) === key);
    const file = ui.laneLog.get(key) ?? (run ? defaultLog(run) : null);
    const pre = $(".term-body", el);
    if (!file) { pre.textContent = "Waiting for the first step's output."; pre.classList.add("empty"); continue; }
    try {
      const log = await getJson(`api/log?id=${encodeURIComponent(id)}&attempt=${encodeURIComponent(attempt)}&file=${encodeURIComponent(file)}`);
      writeTerminal(pre, log?.text || "No output yet.", `${key}:${file}`);
    } catch { /* The next refresh tries again. */ }
  }
}

// Replace a terminal's text, and follow its end only if the reader was already at the end.
function writeTerminal(pre, text, source) {
  const following = pre._source !== source || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  if (pre._text === text && pre._source === source) return;
  pre.textContent = text;
  pre.classList.toggle("empty", !text.trim());
  pre._text = text;
  pre._source = source;
  if (following) pre.scrollTop = pre.scrollHeight;
}

function renderTower({ data, starts }) {
  const rows = data.queued.slice(0, 10).map((entry, i) => `<li>
      <span class="pos">${i + 1}</span>
      <span class="tower-branch" title="${esc(entry.branch)}">${esc(entry.branch)}${entry.nightly ? '<span class="tag nightly">nightly</span>' : ""}${entry.retry ? '<span class="tag retry">retry</span>' : ""}</span>
      <span class="tower-time">${data.typicalMs ? `≈ ${esc(at(starts[i]))}` : ""}</span>
      <span class="tower-sub"><span>waited ${esc(dur(data.now - Date.parse(entry.submittedAt)))}</span>${entry.scope !== "all" ? `<span>${esc(entry.scope)} only</span>` : ""}</span>
    </li>`);
  patch($("#tower"), rows.length ? rows.join("") + (data.queued.length > 10 ? `<li class="tower-more">and ${data.queued.length - 10} more, the last starting ≈ ${esc(at(starts.at(-1)))}</li>` : "") : '<li class="tower-more">Nothing is waiting.</li>');
}

/* The lanes' runs over a day or a week. */
function renderTrack(el, { data, runs }, days, { matches = () => true, tall = false } = {}) {
  const span = days * DAY, start = data.now - span;
  const pos = t => `${Math.max(0, (t - start) / span * 100).toFixed(3)}%`;
  const lanes = Math.max(data.service?.lanes ?? 1, ...runs.map(run => run.lane));
  let html = "";
  for (let lane = 1; lane <= lanes; lane += 1) {
    html += `<div class="row"><span class="row-label">Lane ${lane}</span>` + runs.filter(run => run.lane === lane && (run.endedAt ? Date.parse(run.endedAt) : data.now) > start).map(run => {
      const from = Math.max(Date.parse(run.startedAt), start), to = run.endedAt ? Date.parse(run.endedAt) : data.now;
      const tip = `${run.branch}\n${outcomeName(run.outcome)}, ${dur(to - Date.parse(run.startedAt))}\n${at(Date.parse(run.startedAt))} to ${run.endedAt ? at(to) : "now"}${run.attempt > 1 ? `, attempt ${run.attempt}` : ""}${run.flaky ? `\n${run.flaky} flaky test${run.flaky > 1 ? "s" : ""} passed on retry` : ""}${run.cause && !["pass", "check"].includes(run.cause) ? `\n${run.cause}` : ""}`;
      return `<button class="run ${esc(run.outcome)}${matches(run) ? "" : " dim"}" data-id="${esc(run.id)}" data-attempt="${run.attempt}" data-tip="${esc(tip)}" aria-label="${esc(`${run.branch}: ${outcomeName(run.outcome)}`)}" style="left:${pos(from)};width:calc(${((to - from) / span * 100).toFixed(3)}% - 2px)"></button>`;
    }).join("") + "</div>";
  }
  const step = days === 1 ? (el.clientWidth && el.clientWidth < 640 ? 6 * HOUR : 3 * HOUR) : DAY;
  const offset = new Date(data.now).getTimezoneOffset() * MIN;
  let ticks = "";
  for (let t = Math.ceil((start - offset) / step) * step + offset; t <= data.now; t += step) ticks += `<span style="left:${pos(t)}">${esc(days === 1 ? at(t) : dayFormat.format(new Date(t)))}</span>`;
  el.classList.toggle("tall", tall);
  patch(el, `${html}<div class="axis">${ticks}</div>`);
}

const legendHtml = ["passed", "failed", "environment", "running", "cancelled"].map(o => `<span><i class="${o}"></i>${esc(outcomeName(o))}</span>`).join("") + "<span>Select a run for its steps and logs.</span>";

/* A line chart of one load field, sized to its container. */
function lineChart(el, samples, field, { max, unit = "", cls = "run", days = 1 }) {
  if (!samples) { patch(el, '<div class="chart-empty">Loading</div>'); return; }
  const points = samples.filter(row => row[field] != null);
  if (points.length < 2) { patch(el, '<div class="chart-empty">The service records the host once a minute. The chart fills in as it does.</div>'); return; }
  const width = Math.max(280, Math.round(el.clientWidth || 600)), height = el.closest("#view-queue") ? 180 : 120, pad = { l: 34, r: 6, t: 8, b: 18 };
  const now = Date.now(), from = now - days * DAY;
  const top = max ?? Math.max(4, Math.ceil(Math.max(...points.map(row => row[field])) * 1.15));
  const x = t => pad.l + (t - from) / (now - from) * (width - pad.l - pad.r);
  const y = v => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const coords = points.map(row => [x(Date.parse(row.at)), y(row[field])]);
  const line = coords.map(([cx, cy], i) => `${i ? "L" : "M"}${cx.toFixed(1)},${cy.toFixed(1)}`).join("");
  const area = `${line}L${coords.at(-1)[0].toFixed(1)},${y(0)}L${coords[0][0].toFixed(1)},${y(0)}Z`;
  const grid = [0, top / 2, top].map(v => `<line class="grid-line" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}${unit}</text>`).join("");
  const step = days === 1 ? 6 * HOUR : DAY, offset = new Date().getTimezoneOffset() * MIN;
  let ticks = "";
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= now; t += step) ticks += `<text class="axis-text" x="${x(t)}" y="${height - 2}" text-anchor="middle">${esc(days === 1 ? at(t) : dayFormat.format(new Date(t)))}</text>`;
  const slot = (width - pad.l - pad.r) / Math.max(points.length, 1);
  const hits = points.map((row, i) => `<rect class="hit" x="${(coords[i][0] - slot / 2).toFixed(1)}" y="${pad.t}" width="${Math.max(slot, 2).toFixed(1)}" height="${height - pad.t - pad.b}" data-tip="${esc(`${at(Date.parse(row.at))}\n${row[field]}${unit}${field === "queued" ? " waiting" : ""}`)}"/>`).join("");
  patch(el, `<svg class="chart" viewBox="0 0 ${width} ${height}" style="height:${height}px" role="img" aria-label="${esc(field)} over time">${grid}<path class="area-${cls}" d="${area}"/><path class="line-${cls}" d="${line}"/>${ticks}${hits}</svg>`);
}

/* Views */
function renderNow(d) {
  renderLanes(d);
  renderTower(d);
  renderTrack($("#track-now"), d, 1);
  patch($("#legend-now"), legendHtml);
  lineChart($("#chart-cpu"), ui.load[1], "cpu", { max: 100, unit: "%" });
  lineChart($("#chart-queue-now"), ui.load[1], "queued", { cls: "ink" });
}

function renderQueue({ data, starts }) {
  lineChart($("#chart-queue"), ui.load[ui.loadRange], "queued", { cls: "ink", days: ui.loadRange });
  const longest = Math.max(1, ...data.queued.map(q => data.now - Date.parse(q.submittedAt)));
  patch($("#queue-summary"), data.queued.length ? `${data.queued.length} waiting. Start times assume each run takes the typical ${esc(dur(data.typicalMs))}.` : "");
  patch($("#queue-table"), data.queued.length ? `<thead><tr><th class="n">#</th><th>Branch</th><th>Waited</th><th class="n">Starts</th><th>Note</th></tr></thead><tbody>${data.queued.map((q, i) => {
    const waited = data.now - Date.parse(q.submittedAt);
    return `<tr><td class="n">${i + 1}</td>
      <td><a class="b" href="${esc(prLink(q.branch))}" target="_blank" rel="noreferrer">${esc(q.branch)}</a>${q.nightly ? '<span class="tag nightly">nightly, goes first</span>' : ""}${q.retry ? '<span class="tag retry">retry</span>' : ""}${q.scope !== "all" ? `<span class="tag scope">${esc(q.scope)} only</span>` : ""}<div class="sub mono">${esc(q.head)}</div></td>
      <td style="min-width:140px"><span class="num">${esc(dur(waited))}</span><div class="waitbar" style="width:${(waited / longest * 100).toFixed(1)}%"></div></td>
      <td class="n">${data.typicalMs ? `≈ ${esc(at(starts[i]))}` : "unknown"}</td>
      <td class="muted">${esc(q.waiting ?? "")}</td></tr>`;
  }).join("")}</tbody>` : '<tbody><tr><td class="empty">Nothing is waiting.</td></tr></tbody>');
}

function historyMatch(run) {
  const filter = ui.filter === "all" || (ui.filter === "machine" ? machine(run.outcome) : run.outcome === ui.filter);
  return filter && (!ui.search || run.branch.toLowerCase().includes(ui.search.toLowerCase()));
}

function renderHistory(d) {
  const { data, finished } = d;
  $("#history-title").textContent = ui.range === 1 ? "Last 24 hours" : "Last 7 days";
  renderTrack($("#track-history"), d, ui.range, { matches: historyMatch, tall: true });
  patch($("#legend-history"), legendHtml);
  // Runs per day, for the week.
  const today = new Date(data.now); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const from = new Date(today); from.setDate(today.getDate() - i);
    const to = new Date(from); to.setDate(from.getDate() + 1);
    const rows = finished.filter(run => Date.parse(run.endedAt) >= from && Date.parse(run.endedAt) < to);
    const passing = rows.filter(run => run.outcome === "passed").map(run => run.awakeMs).sort((a, b) => a - b);
    days.push({ label: dayFormat.format(from), passed: rows.filter(run => run.outcome === "passed").length, failed: rows.filter(run => run.outcome === "failed").length,
      machine: rows.filter(run => machine(run.outcome)).length, typical: passing.length ? passing[Math.floor(passing.length / 2)] : null });
  }
  const most = Math.max(1, ...days.map(day => day.passed + day.failed + day.machine));
  const block = (n, cls, name, label) => n ? `<i class="${cls}" style="height:${n / most * 130}px" data-tip="${esc(`${label}\n${n} ${name}`)}"></i>` : "";
  patch($("#days"), `<div class="days">${days.map(day => `<div class="day"><div class="total">${day.passed + day.failed + day.machine || ""}</div><div class="stack">${block(day.passed, "passed", "passed", day.label)}${block(day.failed, "failed", "failed", day.label)}${block(day.machine, "environment", "machine failures", day.label)}</div></div>`).join("")}</div>
    <div class="day-labels">${days.map(day => `<span>${esc(day.label)}</span>`).join("")}</div>
    <div class="day-labels typical" title="Median passing gate">${days.map(day => `<span>${day.typical ? esc(stopwatch(day.typical)) : ""}</span>`).join("")}</div>
    <div class="legend" style="margin-top:8px"><span><i class="passed"></i>Passed</span><span><i class="failed"></i>Failed</span><span><i class="environment"></i>Machine failure</span><span>Bottom row: median passing gate</span></div>`);
  // Results in the selected range, as a ring.
  const inRange = finished.filter(run => Date.parse(run.endedAt) > data.now - ui.range * DAY);
  const parts = [["passed", inRange.filter(run => run.outcome === "passed").length], ["failed", inRange.filter(run => run.outcome === "failed").length],
    ["environment", inRange.filter(run => machine(run.outcome)).length], ["other", inRange.filter(run => ["cancelled", "interrupted"].includes(run.outcome)).length]];
  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  const r = 60, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = total ? parts.filter(([, n]) => n).map(([name, n]) => {
    const length = n / total * c;
    const arc = `<circle class="d-${name}" cx="75" cy="75" r="${r}" stroke-dasharray="${Math.max(0, length - 2).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 75 75)"/>`;
    offset += length;
    return arc;
  }).join("") : "";
  const label = { passed: "Passed", failed: "Failed", environment: "Machine failure", other: "Cancelled or interrupted" };
  patch($("#outcomes"), `<div class="donut-wrap"><svg class="donut" viewBox="0 0 150 150" role="img" aria-label="Results"><circle class="d-track" cx="75" cy="75" r="${r}"/>${arcs}
      <text class="donut-center" x="75" y="78" text-anchor="middle">${total ? Math.round(parts[0][1] / total * 100) : 0}%</text><text class="donut-sub" x="75" y="98" text-anchor="middle">passed</text></svg>
    <div class="outcome-list">${parts.map(([name, n]) => `<div><i class="${name === "other" ? "" : name}" style="display:inline-block;width:10px;height:10px;border-radius:3px;${name === "other" ? "background:var(--other)" : ""}"></i><b>${n}</b>${esc(label[name])}</div>`).join("")}
      <div class="muted">${total} runs ${ui.range === 1 ? "in the last 24 hours" : "in the last 7 days"}</div></div></div>`);
  // The runs themselves.
  const rows = finished.filter(run => Date.parse(run.endedAt) > data.now - ui.range * DAY && historyMatch(run)).reverse();
  patch($("#runs-summary"), `${rows.length} shown`);
  patch($("#runs-table"), rows.length ? `<thead><tr><th>Ended</th><th>Branch</th><th>Result</th><th class="n">Took</th><th class="n">Lane</th><th class="n">Flaky</th></tr></thead><tbody>${rows.slice(0, ui.shown).map(run => `
    <tr data-id="${esc(run.id)}" data-attempt="${run.attempt}" tabindex="0"><td class="num">${esc(ui.range === 1 ? at(Date.parse(run.endedAt)) : `${dayFormat.format(new Date(Date.parse(run.endedAt)))} ${at(Date.parse(run.endedAt))}`)}</td>
      <td><span class="b">${esc(run.branch)}</span>${run.attempt > 1 ? `<span class="tag scope">attempt ${run.attempt}</span>` : ""}</td>
      <td><span class="result ${esc(run.outcome)}">${esc(outcomeName(run.outcome))}</span>${run.outcome !== "passed" && run.cause && run.cause !== "check" ? `<div class="sub">${esc(run.cause)}</div>` : ""}</td>
      <td class="n">${esc(stopwatch(Date.parse(run.endedAt) - Date.parse(run.startedAt)))}</td><td class="n">${run.lane}</td><td class="n">${run.flaky || ""}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="empty">No runs match.</td></tr></tbody>');
  patch($("#runs-more"), rows.length > ui.shown ? `<button class="more" type="button" data-more>Show ${Math.min(25, rows.length - ui.shown)} more of ${rows.length - ui.shown}</button>` : "");
}

function renderTests({ data }) {
  const steps = data.stepTimes ?? [];
  const most = Math.max(1, ...steps.map(step => step.medianSeconds));
  patch($("#step-times"), steps.length ? `<div class="bars">${steps.slice(0, 18).map(step => `<div class="bar-row"><span class="b-name" title="${esc(step.name)}">${esc(step.name)}</span><span class="b-track"><i style="width:${(step.medianSeconds / most * 100).toFixed(1)}%" data-tip="${esc(`${step.name}\nmedian ${seconds(step.medianSeconds)} over ${step.runs} passing runs`)}"></i></span><span class="b-value">${esc(seconds(step.medianSeconds))}</span></div>`).join("")}</div>`
    : '<div class="chart-empty">Step times appear after the first passing runs are recorded.</div>');
  patch($("#flaky-table"), data.flaky.length ? `<thead><tr><th>Test</th><th class="n">Runs</th><th class="n">Last</th></tr></thead><tbody>${data.flaky.map(t => `<tr><td><div class="mono" style="font-size:12px">${esc(t.test)}</div><div class="sub">${esc(t.step)}</div></td><td class="n">${t.flaky}</td><td class="n">${esc(ago(Date.parse(t.last)))}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="empty">No test passed only on retry this week.</td></tr></tbody>');
  patch($("#slow-table"), data.slowest.length ? `<thead><tr><th>Test</th><th class="n">Median</th><th class="n">Runs</th></tr></thead><tbody>${data.slowest.map(t => `<tr><td><div class="mono" style="font-size:12px">${esc(t.test)}</div><div class="sub">${esc(t.step)}</div></td><td class="n">${esc(seconds(t.medianSeconds))}</td><td class="n">${t.runs}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="empty">No test times recorded yet.</td></tr></tbody>');
}

function renderNightly({ data, runs }) {
  const last = data.nightly, pass = data.lastNightlyPass;
  const tone = state => state === "passed" ? "passed" : state === "failed" ? "failed" : machine(state) ? "environment" : "running";
  patch($("#nightly-hero"), last ? `<div class="nightly-mark result ${tone(last.state)}">${esc(outcomeName(last.state))}</div>
      <div class="facts"><span>Main at <b class="mono">${esc(last.head)}</b></span>${last.at ? `<span>Updated <b>${esc(ago(Date.parse(last.at)))}</b></span>` : ""}<span>Last pass <b class="mono">${pass ? esc(pass.head) : "none yet"}</b>${pass?.at ? ` ${esc(ago(Date.parse(pass.at)))}` : ""}</span></div>`
    : '<div class="nightly-mark muted">No nightly run yet</div><div class="facts">The first one runs tonight at 03:07.</div>');
  const nightly = runs.filter(run => run.nightly).reverse();
  patch($("#nightly-table"), nightly.length ? `<thead><tr><th>Started</th><th>Commit</th><th>Result</th><th class="n">Took</th><th class="n">Flaky</th></tr></thead><tbody>${nightly.map(run => `
    <tr data-id="${esc(run.id)}" data-attempt="${run.attempt}" tabindex="0"><td class="num">${esc(`${dayFormat.format(new Date(Date.parse(run.startedAt)))} ${at(Date.parse(run.startedAt))}`)}</td><td class="mono">${esc(run.head)}</td>
      <td><span class="result ${esc(run.outcome)}">${esc(outcomeName(run.outcome))}</span></td><td class="n">${run.endedAt ? esc(stopwatch(Date.parse(run.endedAt) - Date.parse(run.startedAt))) : "running"}</td><td class="n">${run.flaky || ""}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="empty">No nightly runs this week.</td></tr></tbody>');
}

function render() {
  if (!ui.data) return;
  const d = derived();
  renderHeader(d);
  renderStrip(d);
  if (ui.tab === "now") renderNow(d);
  if (ui.tab === "queue") renderQueue(d);
  if (ui.tab === "history") renderHistory(d);
  if (ui.tab === "tests") renderTests(d);
  if (ui.tab === "nightly") renderNightly(d);
}

async function refresh() {
  try {
    ui.data = await getJson("api/state");
    ui.failures = 0;
    render();
  } catch (error) {
    ui.failures += 1;
    patch($("#service"), `<span class="dot bad"></span>This page cannot reach the service (${esc(error.message)})`);
  }
}

async function refreshLoad(days = 1) {
  try { ui.load[days] = (await getJson(`api/load?days=${days}`)).samples; render(); }
  catch { /* The next refresh tries again. */ }
}

/* The run drawer: a summary, the steps on a timeline, and every log. */
async function openRun(id, attempt, opener) {
  ui.drawer = { id, attempt: String(attempt), pane: "summary", file: null, data: null, opener: opener ?? document.activeElement };
  $("#tip").hidden = true;
  $("#drawer").hidden = false;
  $("#scrim").hidden = false;
  $("#drawer-title").textContent = "Loading";
  patch($("#drawer-facts"), "");
  patch($("#drawer-body"), "");
  $("#drawer-close").focus();
  await loadRun();
}

function closeRun() {
  const opener = ui.drawer?.opener;
  ui.drawer = null;
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
  if (opener?.isConnected) opener.focus();
}

async function loadRun() {
  const drawer = ui.drawer;
  if (!drawer) return;
  try {
    const data = await getJson(`api/run?id=${encodeURIComponent(drawer.id)}&attempt=${encodeURIComponent(drawer.attempt)}`);
    if (ui.drawer !== drawer) return;
    drawer.data = data;
    renderDrawer();
    if (drawer.pane === "logs") await loadDrawerLog();
  } catch {
    if (ui.drawer === drawer) { $("#drawer-title").textContent = "This run is no longer recorded."; patch($("#drawer-body"), ""); }
  }
}

function renderDrawer() {
  const drawer = ui.drawer, d = drawer?.data;
  if (!d) return;
  const outcome = d.outcome ?? (d.state === "running" ? "running" : d.state);
  $("#drawer-title").textContent = d.branch;
  const took = d.startedAt ? (d.endedAt ? Date.parse(d.endedAt) : Date.now()) - Date.parse(d.startedAt) : null;
  patch($("#drawer-facts"), `<span class="result ${esc(outcome)}">${esc(outcomeName(outcome))}</span><span>Attempt <b>${d.attempt}</b></span>${d.lane ? `<span>Lane <b>${d.lane}</b></span>` : ""}
    <span><b class="mono">${esc(d.head)}</b> against <b class="mono">${esc(d.base)}</b></span>${d.startedAt ? `<span>${esc(at(Date.parse(d.startedAt)))} to ${d.endedAt ? esc(at(Date.parse(d.endedAt))) : "now"}</span>` : ""}
    ${took != null ? `<span>Took <b>${esc(stopwatch(took))}</b></span>` : ""}<span class="mono">${esc(d.id)}</span><a href="${esc(prLink(d.branch))}" target="_blank" rel="noreferrer">Open PR</a>`);
  for (const button of $$("#drawer [data-pane]")) button.setAttribute("aria-selected", String(button.dataset.pane === drawer.pane));
  const body = $("#drawer-body");
  if (drawer.pane === "summary") {
    const failing = d.steps.filter(step => step.verdict === "FAIL");
    patch(body, `
      ${d.reason || d.error ? `<div class="banner${outcome === "failed" ? " bad" : ""}">${esc(d.reason ?? d.error)}</div>` : ""}
      ${d.stopped ? `<div class="banner">The run stopped after ${esc(d.stopped.after)} failed. Not run: ${esc(d.stopped.notRun.join(", "))}.</div>` : ""}
      ${failing.map(step => `<details open><summary>${esc(step.group === "javascript" ? `tests › ${step.name}` : step.name)} <span class="muted">failed${step.seconds != null ? ` after ${esc(seconds(step.seconds))}` : ""}</span></summary>${step.error ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(step.error)}</div>` : ""}${step.log ? `<pre class="excerpt">${esc(step.log)}</pre>` : ""}</details>`).join("")}
      ${!failing.length && outcome === "passed" ? '<div class="banner" style="background:var(--pass-soft);border-left-color:var(--pass)">Every selected check passed.</div>' : ""}
      ${d.flaky.length ? `<div><h2>Passed only on retry</h2>${d.flaky.map(f => `<div style="font-size:13px;margin-top:6px"><span class="mono">${esc(f.test)}</span> <span class="muted">${esc(f.step)}</span></div>`).join("")}</div>` : ""}
      ${d.slowest.length ? `<div><h2>Slowest tests</h2><div class="bars" style="margin-top:8px">${d.slowest.map(t => `<div class="bar-row"><span class="b-name" title="${esc(t.test)}">${esc(t.test)}</span><span class="b-track"><i style="width:${(t.seconds / d.slowest[0].seconds * 100).toFixed(1)}%"></i></span><span class="b-value">${esc(seconds(t.seconds))}</span></div>`).join("")}</div></div>` : ""}`);
  } else if (drawer.pane === "steps") {
    const timed = d.steps.filter(step => step.startedAt);
    const start = Math.min(...timed.map(step => Date.parse(step.startedAt)));
    const end = Math.max(...timed.map(step => Date.parse(step.startedAt) + (step.seconds ?? (Date.now() - Date.parse(step.startedAt)) / 1000) * 1000));
    const span = Math.max(1, end - start);
    patch(body, timed.length ? `<div class="gantt">${d.steps.map(step => {
      const from = step.startedAt ? Date.parse(step.startedAt) : null;
      const length = step.seconds != null ? step.seconds * 1000 : from ? Date.now() - from : 0;
      const cls = step.verdict === "NOT RUN" ? "NOT" : step.verdict ?? "NOT";
      return `<div class="g-row"><span class="g-name${step.group === "javascript" ? " sub" : ""}" title="${esc(step.name)}">${esc(step.name)}</span>
        <span class="g-track">${from ? `<i class="seg-${esc(cls)}" style="left:${((from - start) / span * 100).toFixed(2)}%;width:${(length / span * 100).toFixed(2)}%" data-tip="${esc(`${step.name}\n${(step.verdict ?? "").toLowerCase()} ${seconds(length / 1000)}`)}"></i>` : ""}</span>
        <span class="g-time">${step.verdict === "NOT RUN" ? "not run" : esc(seconds(length / 1000))}</span></div>`;
    }).join("")}</div>` : '<div class="muted">No steps recorded.</div>');
  } else {
    const files = d.logs ?? [];
    drawer.file ??= files.find(log => log.file !== "worker.log")?.file ?? files[0]?.file ?? null;
    if (!files.length) { patch(body, '<div class="muted">This attempt wrote no logs.</div>'); return; }
    // The viewer stays while the list of logs refreshes, so a growing log keeps its scroll position.
    if (!$("#drawer-log")) patch(body, '<div class="log-files" id="drawer-files" role="group" aria-label="Logs"></div><pre class="excerpt full" id="drawer-log" tabindex="0"></pre>');
    patch($("#drawer-files"), files.map(log => `<button type="button" data-drawer-log="${esc(log.file)}" aria-pressed="${log.file === drawer.file}" title="${esc(`${Math.round(log.size / 1024)} KB, written ${at(Date.parse(log.modifiedAt))}`)}">${esc(log.file)}</button>`).join(""));
  }
}

async function loadDrawerLog() {
  const drawer = ui.drawer;
  if (!drawer?.file) return;
  const pre = $("#drawer-log");
  if (!pre) return;
  try {
    const log = await getJson(`api/log?id=${encodeURIComponent(drawer.id)}&attempt=${encodeURIComponent(drawer.attempt)}&file=${encodeURIComponent(drawer.file)}`);
    if (ui.drawer === drawer) writeTerminal(pre, log?.text || "This log is empty.", `${drawer.id}/${drawer.attempt}:${drawer.file}`);
  } catch { /* The next refresh tries again. */ }
}

/* Tooltips for anything that carries data-tip: a first line in bold, the rest plain. */
function showTip(event) {
  const target = event.target.closest?.("[data-tip]");
  const tip = $("#tip");
  if (!target) { tip.hidden = true; return; }
  const [head, ...rest] = target.dataset.tip.split("\n");
  tip.replaceChildren(Object.assign(document.createElement("b"), { textContent: head }), ...rest.flatMap((line, i) => [...(i ? [document.createElement("br")] : []), document.createTextNode(line)]));
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(event.clientX + 14, innerWidth - box.width - 8)}px`;
  tip.style.top = `${Math.min(event.clientY + 16, innerHeight - box.height - 8)}px`;
}

/* Wiring */
document.addEventListener("DOMContentLoaded", () => {
  applyTheme(theme);
  $("#theme").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    localStorage.setItem("queue-theme", theme);
    applyTheme(theme);
  });
  document.addEventListener("click", event => {
    const tab = event.target.closest(".topbar [data-tab]");
    if (tab) return showTab(tab.dataset.tab);
    const goto = event.target.closest("[data-goto]");
    if (goto) return showTab(goto.dataset.goto);
    const laneLog = event.target.closest("[data-lane-log]");
    if (laneLog) {
      const key = laneLog.closest(".lane").dataset.key;
      ui.laneLog.set(key, laneLog.dataset.laneLog);
      render();
      return refreshTerminals();
    }
    const open = event.target.closest(".term-open");
    if (open) { const [id, attempt] = open.closest(".lane").dataset.key.split("/"); return openRun(id, attempt, open); }
    const pane = event.target.closest("#drawer [data-pane]");
    if (pane && ui.drawer) { ui.drawer.pane = pane.dataset.pane; renderDrawer(); if (ui.drawer.pane === "logs") loadDrawerLog(); return; }
    const drawerLog = event.target.closest("[data-drawer-log]");
    if (drawerLog && ui.drawer) { ui.drawer.file = drawerLog.dataset.drawerLog; renderDrawer(); return loadDrawerLog(); }
    if (event.target.closest("[data-more]")) { ui.shown += 25; return render(); }
    const range = event.target.closest("[data-range]");
    if (range) { ui.range = Number(range.dataset.range); ui.shown = 25; for (const b of $$("[data-range]")) b.setAttribute("aria-pressed", String(b === range)); return render(); }
    const filter = event.target.closest("[data-filter]");
    if (filter) { ui.filter = filter.dataset.filter; ui.shown = 25; for (const b of $$("[data-filter]")) b.setAttribute("aria-pressed", String(b === filter)); return render(); }
    const loadRange = event.target.closest("[data-load-range]");
    if (loadRange) {
      ui.loadRange = Number(loadRange.dataset.loadRange);
      for (const b of $$("[data-load-range]")) b.setAttribute("aria-pressed", String(b === loadRange));
      render();
      return refreshLoad(ui.loadRange);
    }
    const run = event.target.closest("[data-id][data-attempt]");
    if (run) return openRun(run.dataset.id, run.dataset.attempt, run);
  });
  $("#drawer-close").addEventListener("click", closeRun);
  $("#scrim").addEventListener("click", closeRun);
  $("#search").addEventListener("input", event => { ui.search = event.target.value.trim(); ui.shown = 25; render(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && ui.drawer) return closeRun();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (!typing && !ui.drawer && !event.ctrlKey && !event.metaKey && !event.altKey && /^[1-5]$/.test(event.key)) return showTab(TABS[Number(event.key) - 1]);
    const row = event.target.closest?.("tr[data-id]");
    if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openRun(row.dataset.id, row.dataset.attempt, row); }
  });
  document.addEventListener("mousemove", showTip);
  document.addEventListener("mouseleave", () => { $("#tip").hidden = true; });
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  let resized;
  window.addEventListener("resize", () => { clearTimeout(resized); resized = setTimeout(() => { for (const el of $$("[id^=chart-]")) el._html = null; render(); }, 150); });

  // Poll while the page is visible: the state every four seconds, the lanes' output every three, the load every minute.
  let timers = [];
  const schedule = () => {
    for (const timer of timers) clearInterval(timer);
    timers = document.hidden ? [] : [
      setInterval(refresh, 4000),
      setInterval(refreshTerminals, 3000),
      setInterval(() => refreshLoad(1), 60_000),
      setInterval(() => { if (ui.drawer && (ui.drawer.data?.state === "running" || !ui.drawer.data?.endedAt)) { loadRun(); } }, 3000),
    ];
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); refreshTerminals(); } schedule(); });
  showTab(location.hash.slice(1));
  refresh().then(refreshTerminals);
  refreshLoad(1);
  schedule();
});
