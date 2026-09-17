import { startWindowController, waitForVisibleWindow } from './window-controller.mjs';
import { parseOptions, createEvidenceDirectory, benchmarkEnvironment, usage } from './packaged-benchmark-options.mjs';
import { observeExit, closeOwnedPackage, benchmarkCancellation, verifyRestartInput } from './packaged-process.mjs';
import { observeStartupReadiness, startupTargetAfterSwitches } from './startup-readiness.mjs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  console.log(usage);
  process.exit(0);
}
if (process.platform !== 'win32') throw Error('The packaged release benchmark requires Windows');
const root = resolve('.');
const { output, binary, label, runCount, idleSeconds, keystrokes, switches, scenario, profileRenderer, profileMain, fixtureFiles } = options;
await createEvidenceDirectory(output);
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const receipt = { label, binary, packageCommit: options.packageCommit, engineCommit: options.engineCommit,
  startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  settings: { runCount, idleSeconds, keystrokes, switches, scenario, profileRenderer, profileMain, fixtureFiles }, runs: [], status: 'setup' };
const feedRequests = [];
let feed, active, windowController, helperStartup, workload;
const cancellation = benchmarkCancellation();
try {
await json(join(output, 'result.json'), receipt);
const require = createRequire(join(root, 'apps/desktop/package.json'));
const exec = promisify(execFile);
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const asar = join(dirname(binary), 'resources/app.asar');
const engineBinary = join(dirname(binary), 'resources/workspace-engine/dohc-workspace-engine.exe');
Object.assign(receipt, {
  label, binary, binarySha256: await sha256(binary), asar, asarSha256: await sha256(asar),
  packageCommit: options.packageCommit,
  engineBinary, engineSha256: await sha256(engineBinary), engineCommit: options.engineCommit,
  packageDescription: 'Windows packaged release; check companion build and signature receipt for ownership and signing status.',
  harnessSha256: await sha256(fileURLToPath(import.meta.url)),
  samplerSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'packaged-process-snapshot.ps1')),
  windowControllerSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'packaged-window-state.ps1')),
  windowClientSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'window-controller.mjs')),
  lifecycleSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'packaged-process.mjs')),
  startupReadinessSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'startup-readiness.mjs')),
  optionsSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'packaged-benchmark-options.mjs')),
  closeImplementationSha256: await sha256(fileURLToPath(new URL('../../scripts/verification/close-electron.mjs', import.meta.url))),
  summarizerSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'summarize-packaged-benchmark.mjs')),
  harnessCheckout: root, harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  settings: { runCount, idleSeconds, keystrokes, switches, scenario, profileRenderer, profileMain, fixtureFiles }, runs: [],
  limits: [
    'Fresh profile/process is not cold OS filesystem cache. Restart reuses the same profile and workspace.',
    'Startup/switch/open wall times include CDP/Playwright detection and scheduling; readiness is observed DOM plus two animation frames, not an instrumented compositor presentation.',
    'Startup renderer timestamps record observer installation, the expected visible non-inert editor predicate, and a second animation-frame callback. Already-ready samples are left-censored; no earlier readiness time is inferred and no overhead is subtracted.',
    'Only PerformanceEventTiming.duration is called input-to-next-paint here. Chromium quantizes durations to 8ms and does not report event entries below the requested 16ms floor. Missing samples stay missing.',
    'Keyboard uses trusted Chromium CDP input; physical keyboard/OS delivery before Chromium is not measured. EventTiming measures presentation opportunity, not photons.',
    'Idle measures a small local workspace without cloud, sync peers or plugins. Minimized is the background condition; it does not model every occlusion/power mode.',
    'Win32 IsWindowVisible/IsIconic verifies the owned app window. DOM visibility is recorded separately because CDP may keep it visible while minimized. A persistent prewarmed Win32 helper verifies the window before readiness; individual round-trip overhead remains included and separately recorded.',
    'Windows IO transfer counters include file/device/network transfers and cache effects; they are not physical disk traffic.',
    'Snapshots cover observed descendants of the launched PID. Processes born and exited between samples are not included. PID and creation time are matched for deltas.',
    'Process context switches and hardware wakeups are unavailable in this lightweight harness; no surrogate is reported. CIM sampler overhead is recorded and excluded from app counters.',
    'Native launch log marks start when launchMarks.ts evaluates, not at OS process birth; no launch phase is renamed to actual process-start time.',
    'Renderer CPU profiling is optional and diagnostic; profiled runs cannot serve as unprofiled performance comparisons.',
    'The local updater feed advertises version 0.0.0 and has no downloadable asset; update installation is never requested.',
  ],
});
const { chromium } = require('playwright');
await json(join(output, 'result.json'), receipt);
feed = createServer((req, res) => {
  feedRequests.push({ at: Date.now(), url: req.url });
  res.writeHead(200, { 'content-type': 'text/yaml' });
  res.end('version: 0.0.0\nfiles: []\npath: unavailable.exe\nsha512: AA==\nreleaseDate: 2020-01-01T00:00:00.000Z\n');
});
await new Promise((resolve, reject) => { feed.once('error', reject); feed.listen(0, '127.0.0.1', resolve); });
const feedUrl = `http://127.0.0.1:${feed.address().port}`;
const env = benchmarkEnvironment(process.env, feedUrl);
let profileOrdinal = 0;

async function waitUntil(read, timeout = 60000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    cancellation.signal.throwIfAborted();
    const value = await read();
    if (value) return value;
    await delay(50, undefined, { signal: cancellation.signal });
  }
  throw Error(`Condition did not settle within ${timeout}ms`);
}
async function painted(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function ready(page) {
  const state = await page.waitForFunction(() => {
    if (document.body.innerText.includes('dohc could not open this document for editing.')) return 'editing-refused';
    if (document.querySelector('[data-testid="workspace-shell"][data-ready="true"]') && document.querySelector('.tiptap[contenteditable="true"]')) return 'ready';
    return false;
  }, null, { timeout: 30000, polling: 50 });
  if (await state.jsonValue() === 'editing-refused') throw Error('Actual packaged app refused document editing: dohc could not open this document for editing.');
  await painted(page);
}
async function fixture(runDir) {
  const profile = join(runDir, 'profile');
  await mkdir(profile, { recursive: true });
  const workspaces = [];
  const fixtureHashes = [];
  for (let index = 0; index < 2; index++) {
    cancellation.signal.throwIfAborted();
    const workspace = { workspaceId: `perf4-package-${index}`, rootPath: join(runDir, `workspace-${index}`).replaceAll('\\', '/'), kind: 'personal', mode: 'local-first' };
    await mkdir(join(workspace.rootPath, '.dohc'), { recursive: true });
    await json(join(workspace.rootPath, '.dohc/manifest.json'), { version: 1, workspaceId: workspace.workspaceId, kind: workspace.kind, mode: workspace.mode });
    await json(join(workspace.rootPath, '.dohc/ui-state.json'), { version: 2, activeView: 'explorer', sidebarVisible: true, sidebarWidth: 320, editorGroups: [{ id: 'primary', tabs: ['small.md'], activeTab: 'small.md', size: 1 }], activeEditorGroup: 'primary', chatsVisible: false, chatsWidth: 360 });
    const workspaceHash = createHash('sha256');
    for (const [name, paragraphs] of [['small', 100], ['large', 5000]]) {
      const content = `# Workspace ${index} ${name}\n\n${Array.from({ length: scenario === 'small-tab' ? 100 : paragraphs }, (_, n) => `Paragraph ${n}. Performance text.`).join('\n\n')}\n`;
      await writeFile(join(workspace.rootPath, `${name}.md`), content);
      workspaceHash.update(`${name}.md\0${content}\0`);
    }
    for (let begin = 2; begin < fixtureFiles; begin += 32) {
      cancellation.signal.throwIfAborted();
      const batch = [];
      for (let n = begin; n < Math.min(fixtureFiles, begin + 32); n++) {
        const name = `fixture-${String(n).padStart(6, '0')}.txt`;
        const content = `Workspace ${index}, fixture ${n}.\n`;
        workspaceHash.update(`${name}\0${content}\0`);
        batch.push(writeFile(join(workspace.rootPath, name), content));
      }
      await Promise.all(batch);
    }
    fixtureHashes.push({ workspaceId: workspace.workspaceId, files: fixtureFiles, digest: workspaceHash.digest('hex'), algorithm: 'SHA256 of name,NUL,UTF8-content,NUL in generation order; workspace metadata excluded' });
    workspaces.push(workspace);
  }
  await json(join(profile, 'dohc-workspaces.json'), { version: 1, workspaces });
  await json(join(runDir, 'fixture.json'), fixtureHashes);
  return { profile, workspaces, fixtureHashes };
}
async function launch(runDir, fixture, phase, priorSwitches = []) {
  const logPath = join(runDir, `${phase}.log`);
  const v8LogDir = join(runDir, `${phase}-v8`);
  const profileArgs = [];
  if (profileMain) {
    await mkdir(v8LogDir);
    const logFile = join(v8LogDir, 'startup-v8.log').replaceAll('\\', '/');
    if (/\s/.test(logFile)) throw Error('V8 diagnostic log path must have no whitespace');
    profileArgs.push(`--js-flags=--prof --logfile=${logFile}`);
  }
  const started = performance.now();
  const startedAt = Date.now();
  cancellation.signal.throwIfAborted();
  const child = spawn(binary, [`--user-data-dir=${fixture.profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--enable-logging', ...profileArgs], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const launchStages = { spawnReturnedObservedMs: performance.now() - started };
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk; });
  const exit = observeExit(child);
  active = { child, exit, logPath, logs: () => logs, fixture, startedAt, phase, v8LogDir };
  let spawnError;
  child.on('error', error => { spawnError = error; logs += `\nSPAWN ERROR: ${error.stack}`; });
  await json(join(runDir, `${phase}-instance.json`), { binary, asarSha256: receipt.asarSha256, engineBinary, engineSha256: receipt.engineSha256, engineCommit: receipt.engineCommit, pid: child.pid, startedAt, profile: fixture.profile, workspaces: fixture.workspaces, feedUrl, profileArgs });
  launchStages.spawnedObservedMs = performance.now() - started;
  const port = await waitUntil(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`Package exited ${child.exitCode}/${child.signalCode}: ${logs}`);
    try {
      const portFile = join(fixture.profile, 'DevToolsActivePort');
      if ((await stat(portFile)).mtimeMs < startedAt) return null;
      return Number((await readFile(portFile, 'utf8')).split('\n')[0]) || null;
    } catch { return null; }
  });
  launchStages.debugPortObservedMs = performance.now() - started;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  active.browser = browser;
  launchStages.cdpAttachedObservedMs = performance.now() - started;
  const page = await waitUntil(async () => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html')));
  active.page = page;
  launchStages.pageObservedMs = performance.now() - started;
  const readiness = page.evaluate(observeStartupReadiness, startupTargetAfterSwitches(priorSwitches));
  // Window ownership verification and renderer observation run concurrently.
  // The launch failure path owns shutdown if either rejects.
  void readiness.catch(() => {});
  const windowControlStart = performance.now();
  const windowState = await waitForVisibleWindow(() => setWindowState(active, 'inspect'), { signal: cancellation.signal });
  const windowControlObservedMs = performance.now() - windowControlStart;
  if (!windowState.visible || windowState.minimized) throw Error('Fresh release window is not visible; startup sample invalid');
  launchStages.visibleWindowVerifiedObservedMs = performance.now() - started;
  const rendererReadiness = await readiness;
  const startup = { phase, startedAt, editablePaintObservedMs: performance.now() - started, pid: child.pid,
    windowState, windowControlObservedMs, launchStages, rendererReadiness,
    renderer: await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now(), paints: performance.getEntriesByType('paint').map(e => e.toJSON()), visibility: document.visibilityState, testBridge: typeof window.dohcDesktopTest, testMarks: typeof window.dohcDesktopMarks })) };
  if (startup.renderer.testBridge !== 'undefined') throw Error('Unexpected test bridge in release package');
  await json(join(runDir, `${phase}-startup.json`), startup);
  return { ...active, startup };
}
async function shutdown(runDir, instance) {
  try { await closeOwnedPackage(instance); }
  finally { await writeFile(instance.logPath, instance.logs()); }
  const exited = await instance.exit;
  if (instance.startup) instance.startup.nativeLaunchMarksMsSinceModuleEvaluation = parseNativeLaunchMarks(instance.logs());
  await json(join(runDir, `${instance.phase}-exit.json`), exited);
  if (profileMain) {
    const logs = await readdir(instance.v8LogDir);
    const mainLogs = logs.filter(name => name.includes(`-${instance.child.pid}-`) && name.endsWith('startup-v8.log'));
    if (!mainLogs.length) throw Error(`No V8 profile matched recorded main PID ${instance.child.pid}`);
    instance.startup.v8MainLogs = mainLogs.map(name => join(instance.v8LogDir, name));
  }
  void instance.browser.close().catch(() => {});
  active = null;
}
async function openDoc(page, name) {
  const start = performance.now();
  await page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true }).click();
  await page.waitForFunction(name => document.querySelector('[data-testid="view-markdown"]')?.textContent?.includes(`Workspace 0 ${name === 'small.md' ? 'small' : 'large'}`), name, { timeout: 120000 });
  await painted(page);
  const openObservedMs = performance.now() - start;
  if ((await page.locator('body').innerText()).includes('dohc could not open this document for editing.')) throw Error('Actual packaged app refused document editing after tab switch');
  const surface = await page.waitForFunction(() => {
    if (document.body.innerText.includes('dohc could not open this document for editing.')) return 'refused';
    if (document.querySelector('[contenteditable="true"]')) return 'editable';
    if (document.querySelector('[data-testid="markdown-edit-toggle"]:not(:disabled)')?.textContent === 'Edit') return 'read';
    return false;
  }, null, { timeout: 30000, polling: 50 });
  const settledSurface = await surface.jsonValue();
  if (settledSurface === 'refused') throw Error('Actual packaged app refused document editing after tab switch');
  const editButton = page.getByRole('button', { name: 'Edit', exact: true });
  let editActivationObservedMs = null;
  if (settledSurface === 'read') {
    const editStart = performance.now();
    await editButton.click();
    await page.locator('[contenteditable="true"]').waitFor({ timeout: 120000 });
    await painted(page);
    editActivationObservedMs = performance.now() - editStart;
  }
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 120000 });
  return { openObservedMs, editActivationObservedMs };
}
async function typing(page, name) {
  const windowState = await setWindowState(active, 'visible');
  const { openObservedMs, editActivationObservedMs } = await openDoc(page, name);
  console.log(JSON.stringify({ label, phase: 'typing-start', name, openObservedMs, editActivationObservedMs }));
  const editor = page.locator('[contenteditable="true"]');
  const mode = await editor.evaluate(element => element.classList.contains('tiptap') ? 'rich' : element.classList.contains('cm-content') ? 'source' : 'unknown');
  await editor.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+End');
  await painted(page);
  await page.evaluate(() => {
    const state = window.__packagedEvents = { events: [], inputs: [], longTasks: [], supported: PerformanceObserver.supportedEntryTypes.includes('event') };
    state.onInput = event => state.inputs.push({ timestamp: performance.now(), trusted: event.isTrusted, type: event.inputType });
    document.addEventListener('input', state.onInput, true);
    if (state.supported) {
      state.observer = new PerformanceObserver(list => state.events.push(...list.getEntries().map(e => ({ name: e.name, startTime: e.startTime, duration: e.duration, processingStart: e.processingStart, processingEnd: e.processingEnd, interactionId: e.interactionId }))));
      state.observer.observe({ type: 'event', durationThreshold: 16 });
    }
    state.longObserver = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(e => ({ startTime: e.startTime, duration: e.duration }))));
    state.longObserver.observe({ type: 'longtask' });
  });
  const samples = [];
  for (let index = 0; index < keystrokes; index++) {
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press('x');
    await painted(page);
    const end = await page.evaluate(() => performance.now());
    samples.push({ index, start, end, dispatchToTwoRafMs: end - start });
    // An intentionally paced user workload, not a sleep used as a correctness assertion.
    await delay(80, undefined, { signal: cancellation.signal });
  }
  await page.waitForFunction(count => window.__packagedEvents.inputs.length === count, keystrokes);
  const timing = await page.evaluate(() => {
    const s = window.__packagedEvents;
    if (s.observer) s.events.push(...s.observer.takeRecords().map(e => ({ name: e.name, startTime: e.startTime, duration: e.duration, processingStart: e.processingStart, processingEnd: e.processingEnd, interactionId: e.interactionId })));
    s.longTasks.push(...s.longObserver.takeRecords().map(e => ({ startTime: e.startTime, duration: e.duration })));
    s.observer?.disconnect(); s.longObserver.disconnect(); document.removeEventListener('input', s.onInput, true);
    return { supported: s.supported, events: s.events, inputs: s.inputs, longTasks: s.longTasks };
  });
  for (const sample of samples) {
    const events = timing.events.filter(e => e.startTime >= sample.start && e.startTime <= sample.end && e.interactionId > 0);
    sample.inputToNextPaintMs = events.length ? Math.max(...events.map(e => e.duration)) : null;
    sample.events = events;
  }
  if (!timing.inputs.every(input => input.trusted)) throw Error('Untrusted input observed');
  return { name, mode, windowState, paragraphs: name === 'small.md' ? 100 : 5000, openObservedMs, editActivationObservedMs, samples, ...timing };
}
function parseNativeLaunchMarks(log) {
  const line = log.match(/\[desktop\] launch marks \(ms since process start\): ([^\r\n]+)/)?.[1];
  return line ? Object.fromEntries([...line.matchAll(/([a-z-]+) (\d+(?:\.\d+)?)/g)].map(m => [m[1], Number(m[2])])) : null;
}
async function switchTo(page, index) {
  await page.getByTestId('workspace-switcher').click();
  const priorOrdinal = await page.evaluate(() => Math.max(0, ...performance.getEntriesByType('mark').map(m => Number(m.name.match(/^dohc:workspace-switch:(\d+):/)?.[1] ?? 0))));
  await page.evaluate(() => {
    window.__switchLongTasks = { entries: [] };
    window.__switchLongTasks.observer = new PerformanceObserver(list => window.__switchLongTasks.entries.push(...list.getEntries().map(e => ({ startTime: e.startTime, duration: e.duration }))));
    window.__switchLongTasks.observer.observe({ type: 'longtask' });
  });
  let profiler;
  if (profileRenderer) {
    profiler = await page.context().newCDPSession(page);
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
  }
  const started = performance.now();
  await page.locator(`[data-testid="workspace-switcher-option"][data-workspace-id="perf4-package-${index}"]`).getByRole('button').click();
  await page.waitForFunction(index => document.querySelector('[data-testid="workspace-switcher"]')?.textContent?.trim() === `workspace-${index}`, index);
  const selectedObservedMs = performance.now() - started;
  await ready(page);
  await page.waitForFunction(index => document.querySelector('.tiptap[contenteditable="true"]')?.textContent?.includes(`Workspace ${index}`), index);
  await painted(page);
  const editablePaintObservedMs = performance.now() - started;
  // Native renderer marks remain available in release builds without the test bridge.
  await page.waitForFunction(prior => {
    const marks = performance.getEntriesByType('mark');
    const ordinal = Math.max(0, ...marks.map(m => Number(m.name.match(/^dohc:workspace-switch:(\d+):/)?.[1] ?? 0)));
    return ordinal > prior && ['session-admitted', 'files-painted', 'files-revalidated', 'history-ready', 'restored-active-surface-ready'].every(phase => marks.some(m => m.name.startsWith(`dohc:workspace-switch:${ordinal}:${phase}`)));
  }, priorOrdinal, { timeout: 30000, polling: 25 });
  const details = await page.evaluate(prior => {
    const marks = performance.getEntriesByType('mark').filter(m => m.name.startsWith('dohc:workspace-switch:'));
    const ordinal = Math.max(...marks.map(m => Number(m.name.split(':')[2])));
    const entries = marks.filter(m => Number(m.name.split(':')[2]) === ordinal).map(m => ({ name: m.name, startTime: m.startTime }));
    const base = entries.find(m => m.name.endsWith(':switch-start'))?.startTime;
    const phasesMs = Object.fromEntries(entries.map(m => [m.name.split(':').slice(3).join(':'), base === undefined ? null : m.startTime - base]));
    const tasks = window.__switchLongTasks;
    tasks.entries.push(...tasks.observer.takeRecords().map(e => ({ startTime: e.startTime, duration: e.duration })));
    tasks.observer.disconnect();
    return { ordinal, phasesMs, entries, rendererTimeOrigin: performance.timeOrigin, longTasks: tasks.entries, priorOrdinal: prior };
  }, priorOrdinal);
  let cpuProfilePath = null;
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    cpuProfilePath = join(output, `renderer-switch-${++profileOrdinal}.cpuprofile`);
    await json(cpuProfilePath, profile);
    await profiler.detach();
  }
  return { to: index, selectedObservedMs, editablePaintObservedMs, allPhasesObservedMs: performance.now() - started, ...details, cpuProfilePath };
}
async function snapshot(pid) {
  const { stdout } = await exec('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(dirname(fileURLToPath(import.meta.url)), 'packaged-process-snapshot.ps1'), '-AppProcessId', String(pid)], { windowsHide: true, signal: cancellation.signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
async function setWindowState(instance, state) {
    const cdpTitle = await instance.page.title();
    const cdpUrl = instance.page.url();
    const result = await windowController.request({ pid: instance.child.pid, binary, title: cdpTitle, state });
    return { ...result, cdpTitle, cdpUrl };
}
async function idle(instance, state) {
  const windowState = await setWindowState(instance, state);
  if (state === 'visible') await instance.page.bringToFront();
  const domVisibility = await instance.page.evaluate(() => document.visibilityState);
  const samples = [await snapshot(instance.child.pid)];
  const started = performance.now();
  while (performance.now() - started < idleSeconds * 1000) {
    await delay(Math.min(5000, Math.max(1, idleSeconds * 1000 - (performance.now() - started))), undefined, { signal: cancellation.signal });
    samples.push(await snapshot(instance.child.pid));
  }
  const deltas = { cpuMs: 0, readBytes: 0, writeBytes: 0, otherBytes: 0, readOperations: 0, writeOperations: 0, otherOperations: 0 };
  const intervals = [];
  for (let i = 1; i < samples.length; i++) {
    const before = new Map(samples[i - 1].processes.map(p => [`${p.pid}:${p.createdAt}`, p]));
    const delta = Object.fromEntries(Object.keys(deltas).map(key => [key, 0]));
    for (const p of samples[i].processes) {
      const previous = before.get(`${p.pid}:${p.createdAt}`);
      if (previous) for (const key of Object.keys(delta)) delta[key] += p[key] - previous[key];
    }
    for (const key of Object.keys(deltas)) deltas[key] += delta[key];
    intervals.push(delta);
  }
  const elapsedMs = samples.at(-1).completedAtMs - samples[0].completedAtMs;
  const totals = samples.map(s => ({ privateBytes: s.processes.reduce((n, p) => n + p.privateBytes, 0), workingSetBytes: s.processes.reduce((n, p) => n + p.workingSetBytes, 0), processCount: s.processes.length }));
  await setWindowState(instance, 'visible');
  await instance.page.bringToFront();
  return { state, windowState, domVisibility, elapsedMs, deltas, cpuPercentOneLogicalCore: 100 * deltas.cpuMs / elapsedMs, contextSwitches: null, hardwareWakeups: null, totals, samples, intervals };
}

  await cancellation.run(() => (workload = (async () => {
  const helperStarted = performance.now();
  helperStartup = startWindowController({ signal: cancellation.signal, onSpawn(child) { receipt.windowHelper = { pid: child.pid }; } });
  windowController = await helperStartup;
  receipt.windowHelper = { pid: windowController.pid, prewarmMs: performance.now() - helperStarted };
  await json(join(output, 'result.json'), receipt);
  for (let index = 0; index < runCount; index++) {
    cancellation.signal.throwIfAborted();
    const runDir = join(output, `run-${index + 1}`);
    const data = { index: index + 1 };
    receipt.runs.push(data);
    await mkdir(runDir, { recursive: true });
    const f = await fixture(runDir);
    const fresh = await launch(runDir, f, 'fresh');
    data.freshStartup = fresh.startup;
    await json(join(output, 'result.json'), receipt);
    console.log(JSON.stringify({ label, run: index + 1, phase: 'fresh-ready', ms: fresh.startup.editablePaintObservedMs }));
    if (scenario === 'startup') {
      await shutdown(runDir, fresh);
      const restart = await launch(runDir, f, 'restart');
      data.restartStartup = restart.startup;
      await shutdown(runDir, restart);
      await json(join(output, 'result.json'), receipt);
      continue;
    }
    if (scenario === 'switches') {
      data.switchPrecondition = [await switchTo(fresh.page, 1), await switchTo(fresh.page, 0)];
      data.switches = [];
      for (let n = 0; n < switches; n++) {
        data.switches.push(await switchTo(fresh.page, n % 2 === 0 ? 1 : 0));
        await json(join(output, 'result.json'), receipt);
      }
      await shutdown(runDir, fresh);
      await json(join(output, 'result.json'), receipt);
      continue;
    }
    if (scenario === 'small-switch' || scenario === 'small-tab') {
      data.typing = [await typing(fresh.page, 'small.md')];
      await waitUntil(async () => (await readFile(join(f.workspaces[0].rootPath, 'small.md'), 'utf8')).includes('x'.repeat(keystrokes)), 10000);
      await json(join(output, 'result.json'), receipt);
      if (scenario === 'small-tab') {
        await openDoc(fresh.page, 'large.md');
        await openDoc(fresh.page, 'small.md');
        await ready(fresh.page);
      }
      data.switches = [];
      for (const destination of [1, 0]) {
        data.switches.push(await switchTo(fresh.page, destination));
        await json(join(output, 'result.json'), receipt);
      }
      await shutdown(runDir, fresh);
      await json(join(output, 'result.json'), receipt);
      continue;
    }
    data.typing = [];
    for (const name of ['small.md', 'large.md']) {
      data.typing.push(await typing(fresh.page, name));
      await json(join(output, 'result.json'), receipt);
    }
    data.durableEdits = [];
    for (const name of ['small.md', 'large.md']) {
      await waitUntil(async () => (await readFile(join(f.workspaces[0].rootPath, name), 'utf8')).includes('x'.repeat(keystrokes)), 60000);
      data.durableEdits.push({ name, marker: 'x'.repeat(keystrokes), observedOnDisk: true });
    }
    await openDoc(fresh.page, 'small.md');
    data.switchPrecondition = [await switchTo(fresh.page, 1), await switchTo(fresh.page, 0)];
    data.switches = [];
    for (let n = 0; n < switches; n++) {
      data.switches.push(await switchTo(fresh.page, n % 2 === 0 ? 1 : 0));
      await json(join(output, 'result.json'), receipt);
    }
    // Idle only once per package, after foreground work has settled for a fixed workload pause.
    if (index === 0) {
      await delay(10000, undefined, { signal: cancellation.signal });
      console.log(JSON.stringify({ label, phase: 'visible-idle-start', seconds: idleSeconds }));
      data.idle = [await idle(fresh, 'visible')];
      await json(join(output, 'result.json'), receipt);
      console.log(JSON.stringify({ label, phase: 'background-idle-start', seconds: idleSeconds }));
      data.idle.push(await idle(fresh, 'minimized'));
    }
    await fresh.page.screenshot({ path: join(runDir, 'completed.png') });
    await json(join(output, 'result.json'), receipt);
    await shutdown(runDir, fresh);
    const restart = await launch(runDir, f, 'restart', data.switches);
    data.restartStartup = restart.startup;
    data.restartHasSavedInput = await verifyRestartInput({
      isEditedWorkspaceSelected: async () => (await restart.page.getByTestId('workspace-switcher').textContent())?.trim() === 'workspace-0',
      selectEditedWorkspace: async () => { data.restartVerificationSwitch = await switchTo(restart.page, 0); },
      readEditedText: () => restart.page.locator('.tiptap[contenteditable="true"]').innerText(),
      marker: 'x'.repeat(keystrokes) });
    await shutdown(runDir, restart);
    await json(join(output, 'result.json'), receipt);
    console.log(JSON.stringify({ label, run: index + 1, phase: 'complete', restartMs: data.restartStartup.editablePaintObservedMs }));
  }
  cancellation.signal.throwIfAborted();
  receipt.status = 'complete';
  })()));
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.stack;
  console.error(error);
  if (active) {
    try {
      if (active.page && !active.page.isClosed()) {
        await active.page.screenshot({ path: join(dirname(active.logPath), 'failure.png'), timeout: 5000 }).catch(() => {});
        await json(join(dirname(active.logPath), 'failure-dom.json'), { body: await active.page.locator('body').innerText({ timeout: 5000 }).catch(() => 'page unavailable') });
      }
      await writeFile(active.logPath, active.logs());
    } catch (artifactError) { receipt.artifactError = artifactError.stack; }
  }
  if (!cancellation.signal.aborted) process.exitCode = 1;
} finally {
  if (active) {
    try { await closeOwnedPackage(active); }
    catch (cleanupError) { receipt.shutdownError = cleanupError.stack; receipt.status = 'failed'; if (!cancellation.signal.aborted) process.exitCode = 1; }
    await writeFile(active.logPath, active.logs()).catch(error => { receipt.logError = error.message; });
    void active.browser?.close().catch(() => {});
  }
  if (helperStartup && !windowController) await helperStartup.catch(error => { receipt.helperStartupError = error.stack; });
  if (windowController) {
    try { receipt.windowHelper.exit = await windowController.close(); }
    catch (cleanupError) { receipt.helperCleanupError = cleanupError.stack; receipt.status = 'failed'; if (!cancellation.signal.aborted) process.exitCode = 1; }
  }
  if (cancellation.signal.aborted) await workload?.catch(() => {});
  feed?.closeAllConnections();
  if (feed?.listening) await new Promise(resolve => feed.close(resolve));
  if (cancellation.signal.aborted) {
    receipt.status = 'failed';
    receipt.error ??= cancellation.signal.reason.stack;
  }
  receipt.completedAt = new Date().toISOString(); receipt.feedRequests = feedRequests;
  try { await json(join(output, 'result.json'), receipt); }
  finally { cancellation.dispose(); }
}
