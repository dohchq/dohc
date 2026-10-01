import { startWindowController, waitForVisibleWindow } from './window-controller.mjs';
import { parseOptions, createEvidenceDirectory, benchmarkEnvironment, packagedLaunchArgs, usage } from './packaged-benchmark-options.mjs';
import { observeExit, closeOwnedPackage, benchmarkCancellation, verifyRestartInput } from './packaged-process.mjs';
import { run as runOwnedCommand } from '../../scripts/verification/process.mjs';
import { observeStartupReadiness, startupTargetFromRegistry } from './startup-readiness.mjs';
import { observeSurface, observeSearchSubmit, seededPostThreadId, collectionFixtureFiles, aggregateByKind } from './packaged-surfaces.mjs';
import { automationCases, automationFixtureDigest, automationOf, automationsYaml, CASE_TIMEOUT_MS, classifyOutcome, cpuByKind, DATASET_FOLDER, DATASET_NAME,
  datasetListRequest, datasetRowValues, datasetSetupRequest, DOCUMENT_FOLDER, documentAutomationFiles, journalBytes, observeAutomationRun,
  outcomeTexts, peakByKind, readDocumentCase, readRunJournal, TRIGGER, verifyCase, waitForQuiet } from './packaged-collection-automations.mjs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const { output, binary, label, runCount, idleSeconds, keystrokes, switches, scenario, profileRenderer, profileMain, fixtureFiles, soakMinutes, chatMessages, records, findCap, writeCap } = options;
await createEvidenceDirectory(output);
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const settings = { runCount, idleSeconds, keystrokes, switches, scenario, profileRenderer, profileMain, fixtureFiles, soakMinutes, chatMessages, records,
  ...(scenario === 'collection' ? { findCap, writeCap } : {}) };
const receipt = { label, binary, packageCommit: options.packageCommit, engineCommit: options.engineCommit,
  startedAt: new Date().toISOString(), platform: process.platform, node: process.version, settings, runs: [], status: 'setup' };
const feedRequests = [];
let feed, active, windowController, helperStartup, workload;
const automationFailures = [];
const cancellation = benchmarkCancellation();
try {
await json(join(output, 'result.json'), receipt);
const require = createRequire(join(root, 'apps/desktop/package.json'));
const exec = promisify(execFile);
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
// One digest over the named files and directory trees, in sorted relative-path order.
async function sha256Tree(base, subpaths) {
  const files = [];
  for (const subpath of subpaths) {
    const path = join(base, subpath);
    if ((await stat(path)).isDirectory()) files.push(...(await readdir(path, { withFileTypes: true, recursive: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)));
    else files.push(path);
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(`${relative(base, file).replaceAll('\\', '/')}\0`).update(await readFile(file)).update('\0');
  return hash.digest('hex');
}
const asar = join(dirname(binary), 'resources/app.asar');
const engineBinary = join(dirname(binary), 'resources/workspace-engine/dohc-workspace-engine.exe');
const cli = join(root, 'packages/cli');
const cliLauncher = join(cli, 'bin/dohc.js');
const cliHashedPaths = ['bin', 'src', 'package.json'];
const seedScript = join(dirname(fileURLToPath(import.meta.url)), 'seed-chat-cli.mjs');
const automationsModule = join(dirname(fileURLToPath(import.meta.url)), 'packaged-collection-automations.mjs');
const datasetCliScript = join(dirname(fileURLToPath(import.meta.url)), 'dataset-cli.mjs');
const processRunner = fileURLToPath(new URL('../../scripts/verification', import.meta.url));
const processRunnerPaths = ['process.mjs', 'windows-job.ps1', 'windows-command.mjs'];
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
  surfacesSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'packaged-surfaces.mjs')),
  closeImplementationSha256: await sha256(fileURLToPath(new URL('../../scripts/verification/close-electron.mjs', import.meta.url))),
  summarizerSha256: await sha256(join(dirname(fileURLToPath(import.meta.url)), 'summarize-packaged-benchmark.mjs')),
  ...(scenario === 'chat-history' || scenario === 'collection' ? { cli, cliHashedPaths, cliSha256: await sha256Tree(cli, cliHashedPaths),
    processRunner, processRunnerPaths, processRunnerSha256: await sha256Tree(processRunner, processRunnerPaths) } : {}),
  ...(scenario === 'chat-history' ? { cliLauncher, seedScript, seedScriptSha256: await sha256(seedScript) } : {}),
  ...(scenario === 'collection' ? { automationsModule, automationsModuleSha256: await sha256(automationsModule), datasetCliScript, datasetCliSha256: await sha256(datasetCliScript) } : {}),
  harnessCheckout: root, harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), platform: process.platform, node: process.version, settings, runs: [],
  limits: [
    'Fresh profile/process is not cold OS filesystem cache. Restart reuses the same profile and workspace.',
    'Startup/switch/open wall times include CDP/Playwright detection and scheduling; readiness is observed DOM plus two animation frames, not an instrumented compositor presentation.',
    'Startup renderer timestamps record observer installation, the expected visible non-inert editor predicate, and a second animation-frame callback. Already-ready samples are left-censored; no earlier readiness time is inferred and no overhead is subtracted.',
    'Only PerformanceEventTiming.duration is called input-to-next-paint here. Chromium quantizes durations to 8ms and does not report event entries below the requested 16ms floor. Missing samples stay missing.',
    'Keyboard uses trusted Chromium CDP input; physical keyboard/OS delivery before Chromium is not measured. EventTiming measures presentation opportunity, not photons.',
    'Idle measures a small local workspace without cloud or sync peers. Minimized is the background condition; it does not model every occlusion/power mode.',
    'Win32 IsWindowVisible/IsIconic verifies the owned app window. DOM visibility is recorded separately because CDP may keep it visible while minimized. A persistent prewarmed Win32 helper verifies the window before readiness; individual round-trip overhead remains included and separately recorded.',
    'Windows IO transfer counters include file/device/network transfers and cache effects; they are not physical disk traffic.',
    'Snapshots cover observed descendants of the launched PID. Processes born and exited between samples are not included. PID and creation time are matched for deltas.',
    'Process context switches and hardware wakeups are unavailable in this lightweight harness; no surrogate is reported. CIM sampler overhead is recorded and excluded from app counters.',
    'Native launch log marks start when launchMarks.ts evaluates, not at OS process birth; no launch phase is renamed to actual process-start time.',
    'Renderer CPU profiling is optional and diagnostic; profiled runs cannot serve as unprofiled performance comparisons.',
    'The local updater feed advertises version 0.0.0 and has no downloadable asset; update installation is never requested.',
    'Go to, command palette, search, chat, and collection durations start at the renderer receipt of the trusted keydown or mousedown and end at the first animation-frame callback after the DOM predicate matched. They include React commit and layout, not compositor presentation.',
    'The renderer observer evaluates its predicate at installation, on every animation frame, on mutations and on focus changes, and reads computed style each frame. Visible means the first frame where no ancestor computes to opacity 0; a palette entrance animation counts from that frame and entranceAnimating records whether it was still running.',
    'A painted time, the first animation-frame callback after the predicate matched, is within one frame of the paint that first shows the surface: that callback runs before the paint when the match came between frames, and one frame after it when the match came during a frame. matchedIn records which check saw the match (install, frame, mutation or focus); the end rule is the same for all four.',
    'Every palette close first waits until no animation runs on the palette or its ancestors, so a warm reopen never interrupts the cold open\'s entrance animation.',
    'Search submits with Enter after one programmatic fill. Search-as-you-type debounces at 150 ms; a sample whose search id changed before Enter is flagged debounceFiredBeforeSubmit.',
    'With an engine capture, search queries the engine index and returns at most 50 results in one batch, so limitHit false does not mean the results are complete. sawUpdating records whether the view passed through updating, whose retry backoff lands in the settled time.',
    'chat-history seeds one #general post and its replies through the checkout CLI (packages/cli) against the running package, then restarts before measuring. Seeding runs seed-chat-cli.mjs through scripts/verification/process.mjs. The benchmark runs only on Windows, where that runner holds seeding in a job object that kills every descendant when the harness-owned job owner exits. Each CLI call times out after 60 seconds. Each message runs two Node processes, the launcher and the CLI. The thread comment list is not virtualized; every reply renders.',
    'collection seeds Markdown records with pre-minted ids. The table is virtualized and pages on demand: rowsRendered is the visible window and loadedRecords is the first page.',
    'collection then types in small.md, and then runs the automation phase: it writes a document Collection to disk and creates a dataset Collection through the checkout CLI, and presses one Button per case on a trigger record. Seeding starts no run. Before the first document case, the harness scrolls the table until it holds every record, so no Find runs before the engine indexed its records. A case starts once main and the engine used under 5% of one core over three consecutive intervals of at least 1 s. Before each press, the harness dismisses the shown toast, so the settle text arrives as new text in the toast stack or Notices.',
    'Automation settle times run from the renderer receipt of the trusted mousedown to the first animation-frame callback after the settle text appeared. startMs runs from that mousedown to the run header startedAtMs, before any Find. runMs runs from startedAtMs to finishedAtMs. Saved steps supply findMs for reads and Finds, including read access and permission checks, and planMs for planning and formula evaluation. Saved effects supply writeMs for effect application, excluding each effect result append but including created-record and replan appends, and writes for completed effect applications. Unmeasured stages and runs refused before saving a header stay missing.',
    'Automation CPU is per process kind between the snapshot that ended the quiet wait and one started when the run settled; PowerShell start-up adds about half a second to that window. The formula evaluator runs on a worker thread in main, so its CPU is part of main CPU. Peak memory and header bytes are sampled about once a second, so a short peak can be missed.',
    'Contention cases press the button, then run the typing workload in small.md; samplesDuringRun counts trusted input events between the press and the settle text, and a case expected to finish fails when none arrived. Their CPU ends when the run settles, not when typing ends. Document values are read from the settled Markdown; dataset values through the approved list operation.',
    'soak samples working set and private bytes per process kind after each mixed cycle. Growth includes allocator and garbage-collector timing; it is not a leak proof.',
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
    await json(join(workspace.rootPath, '.dohc/ui-state.json'), { version: 3, activeView: 'explorer', sidebarVisible: true, sidebarWidth: 320, editorGroups: [{ id: 'primary', tabs: ['small.md'], activeTab: 'small.md', size: 1 }], activeEditorGroup: 'primary', chatsVisible: false, chatsWidth: 360 });
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
    const collection = scenario === 'collection' && index === 0 ? collectionFixtureFiles(records) : [];
    if (collection.length) await mkdir(join(workspace.rootPath, dirname(collection[0].path)));
    for (let begin = 0; begin < collection.length; begin += 32) {
      cancellation.signal.throwIfAborted();
      await Promise.all(collection.slice(begin, begin + 32).map(file => {
        workspaceHash.update(`${file.path}\0${file.content}\0`);
        return writeFile(join(workspace.rootPath, file.path), file.content);
      }));
    }
    fixtureHashes.push({ workspaceId: workspace.workspaceId, files: fixtureFiles, collectionFiles: collection.length, digest: workspaceHash.digest('hex'), algorithm: 'SHA256 of name,NUL,UTF8-content,NUL in generation order; workspace metadata excluded' });
    workspaces.push(workspace);
  }
  await json(join(profile, 'dohc-workspaces.json'), { version: 1, workspaces });
  await json(join(runDir, 'fixture.json'), fixtureHashes);
  return { profile, workspaces, fixtureHashes };
}
async function launch(runDir, fixture, phase) {
  const startupTarget = phase === 'fresh'
    ? { workspaceName: 'workspace-0', path: 'small.md', content: 'Workspace 0 small' }
    : startupTargetFromRegistry(JSON.parse(await readFile(join(fixture.profile, 'dohc-workspaces.json'), 'utf8')), fixture.workspaces);
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
  const child = spawn(binary, packagedLaunchArgs(fixture.profile, profileArgs), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
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
  const readiness = page.evaluate(observeStartupReadiness, startupTarget);
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

// Installs a self-contained renderer observer before the harness sends the input that it
// times, so the trigger cannot be missed. The returned function awaits the observation.
async function armSurface(page, observer, surfaceOptions) {
  await page.evaluate(`(() => { window.__dohcSurface = (${observer.toString()})(${JSON.stringify(surfaceOptions)}); window.__dohcSurface.catch(() => {}); })()`);
  return async () => {
    const observed = await page.evaluate(() => window.__dohcSurface);
    if (observed.triggerTrusted === false || observed.submitTrusted === false) throw Error('Untrusted trigger observed');
    return observed;
  };
}
async function filesListed(page, rootEntries) {
  const started = performance.now();
  await page.waitForFunction(expected => Number(document.querySelector('[data-testid="file-tree"] [data-testid="tree-row"][aria-level="1"]')?.getAttribute('aria-setsize')) >= expected, rootEntries, { timeout: 120000, polling: 100 });
  return { rootEntries, waitObservedMs: performance.now() - started };
}
const surfaces = {
  goTo: { name: 'Go to', shortcut: 'Control+p', key: 'p', palette: '[data-testid="quick-open"]', input: '[data-testid="quick-open"] input[aria-label="File"]', option: '[data-testid="quick-open"] [role="option"]' },
  commandPalette: { name: 'Command palette', shortcut: 'Control+Shift+P', key: 'p', palette: '[data-testid="command-palette"]', input: '[data-testid="command-palette"] input[aria-label="Command"]', option: '[data-testid="command-palette"] [role="option"]' },
};
const GO_TO_QUERY = 'fixture-004242';
const CHAT_TITLE = 'Long history';
const SEARCH_QUERIES = ['fixture', 'fixture 4242.'];
// Both editor documents contain this word, so the soak search hits with the default fixture.
const SOAK_SEARCH_QUERY = 'Performance';
const fromTrigger = observed => ({ keydownToReadyMs: observed.matchedMs - observed.triggerMs, keydownToPaintedMs: observed.paintedMs - observed.triggerMs });
async function openPalette(page, surface, readyWhen) {
  if (await page.locator(surface.palette).count()) throw Error(`${surface.name} is already open`);
  const settle = await armSurface(page, observeSurface, { trigger: 'keydown', triggerKey: surface.key, target: readyWhen === 'first-row' ? surface.option : surface.input, focused: surface.input, countSelector: surface.option });
  const started = performance.now();
  await page.keyboard.press(surface.shortcut);
  const observed = await settle();
  return { shortcut: surface.shortcut, readyWhen, observedMs: performance.now() - started, ...fromTrigger(observed), optionCount: observed.count, observed };
}
// Go to's typing outlasts the entrance animation. Waiting for it here gives the command palette's
// warm reopen the same settled start instead of interrupting the cold open's animation.
async function closePalette(page, surface) {
  await page.waitForFunction(selector => {
    for (let node = document.querySelector(selector); node; node = node.parentElement) {
      if (node.getAnimations().some(animation => animation.playState === 'running')) return false;
    }
    return true;
  }, surface.palette, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.locator(surface.palette).waitFor({ state: 'detached', timeout: 10000 });
}
async function typeInPalette(page, surface, query) {
  const keystrokes = [];
  let typed = '';
  for (const character of query) {
    typed += character;
    // Ready means the input echoes the prefix and the first ranked row contains its characters in order.
    const settle = await armSurface(page, observeSurface, { trigger: 'keydown', triggerKey: character, target: surface.input, value: typed, firstTextMatches: typed, countSelector: surface.option });
    const started = performance.now();
    await page.keyboard.press(character);
    const observed = await settle();
    keystrokes.push({ character, typed, observedMs: performance.now() - started, ...fromTrigger(observed), optionCount: observed.count, firstOption: observed.firstText });
  }
  return keystrokes;
}
async function goTo(page) {
  const cold = await openPalette(page, surfaces.goTo, 'editable-input');
  const keystrokes = await typeInPalette(page, surfaces.goTo, GO_TO_QUERY);
  const firstOption = keystrokes.at(-1).firstOption;
  if (firstOption !== `${GO_TO_QUERY}.txt`) throw Error(`Go to ranked ${JSON.stringify(firstOption)} first for ${GO_TO_QUERY}`);
  await closePalette(page, surfaces.goTo);
  const warm = await openPalette(page, surfaces.goTo, 'editable-input');
  await closePalette(page, surfaces.goTo);
  return { query: GO_TO_QUERY, cold, keystrokes, firstOption, warm };
}
async function commandPalette(page) {
  const cold = await openPalette(page, surfaces.commandPalette, 'first-row');
  await closePalette(page, surfaces.commandPalette);
  const warm = await openPalette(page, surfaces.commandPalette, 'first-row');
  await closePalette(page, surfaces.commandPalette);
  return { cold, warm };
}
async function openSearchView(page) {
  const settle = await armSurface(page, observeSurface, { trigger: 'click', target: '[data-testid="search-input"]', focused: '[data-testid="search-input"]' });
  const started = performance.now();
  await page.getByTestId('activity-search').click();
  const observed = await settle();
  return { observedMs: performance.now() - started, clickToInputFocusedMs: observed.matchedMs - observed.triggerMs, clickToPaintedMs: observed.paintedMs - observed.triggerMs };
}
async function searchQuery(page, query, open) {
  const settle = await armSurface(page, observeSearchSubmit, { timeoutMs: 180000 });
  const input = page.getByTestId('search-input');
  await input.fill(query);
  const started = performance.now();
  await input.press('Enter');
  const observed = await settle();
  return { query, open, observedMs: performance.now() - started,
    submitToFirstResultMs: observed.firstResultPaintedMs === null ? null : observed.firstResultPaintedMs - observed.submitMs,
    submitToSettledMs: observed.settledPaintedMs - observed.submitMs, debounceFiredBeforeSubmit: observed.debounceFiredBeforeSubmit, sawUpdating: observed.sawUpdating,
    summary: observed.summary, limitHit: observed.limitHit, rowsRendered: observed.rowsRendered, observed };
}
async function search(page) {
  const open = await openSearchView(page);
  const results = [];
  for (const [index, query] of SEARCH_QUERIES.entries()) results.push(await searchQuery(page, query, index === 0 ? open : null));
  return results;
}
async function seedChatHistory(instance, workspace, runDir) {
  const profile = instance.fixture.profile;
  await waitUntil(() => Promise.all(['dohc-cli-endpoint', 'dohc-cli-token'].map(name => stat(join(profile, name)))).then(() => true, () => false), 60000);
  // The benchmark runs only on Windows, so one job object holds every CLI launcher and worker the
  // seed script starts, and the job kills them when its owner exits. The runner settles after the
  // pipes close and ends the job on timeout or interrupt. It writes both streams to chat-seed.log,
  // and a failure rejects with that log's path.
  const { stdout } = await runOwnedCommand(process.execPath, [seedScript, cliLauncher, CHAT_TITLE, String(chatMessages)],
    { cwd: workspace.rootPath, env: { ...env, DOHC_STATE_DIR: profile, NODE_NO_WARNINGS: '1' }, timeoutMs: chatMessages * 30000, log: join(runDir, 'chat-seed.log') });
  return { ...JSON.parse(stdout.trim().split(/\r?\n/).at(-1)), seededThrough: seedScript, cliLauncher };
}
async function openChatHistory(page, seed) {
  const panel = page.getByTestId('chats-panel');
  if (!(await panel.isVisible())) await page.getByTestId('titlebar-chats-sidebar').click();
  await panel.waitFor({ timeout: 30000 });
  await page.getByTestId('chats-panel-tab-all').click();
  const channel = page.locator(`[data-testid="chats-channel"][data-channel-slug="${seed.channel}"]`);
  await channel.waitFor({ timeout: 60000 });
  const card = '[data-testid="chats-channel-view"] [data-testid="chats-post-card"]';
  const channelSettle = await armSurface(page, observeSurface, { trigger: 'click', target: card, countSelector: card });
  const channelStarted = performance.now();
  await channel.click();
  const channelObserved = await channelSettle();
  const channelObservedMs = performance.now() - channelStarted;
  const domThreadId = await page.evaluate(seededPostThreadId, { title: seed.title });
  const comment = '[data-testid="chats-thread-view"] [data-testid="chats-comments"] [data-testid="chats-message"]';
  // One observer, armed before the click, carries both milestones from the same trigger timestamp.
  const threadSettle = await armSurface(page, observeSurface, { trigger: 'click', target: comment, fullCount: seed.messages - 1, countSelector: comment, timeoutMs: 120000 });
  const threadStarted = performance.now();
  await page.locator(`${card}[data-thread-id="${domThreadId}"]`).getByTestId('chats-post-title').click();
  const thread = await threadSettle();
  return {
    seed,
    channelOpen: { observedMs: channelObservedMs, clickToPostsPaintedMs: channelObserved.paintedMs - channelObserved.triggerMs, postCards: channelObserved.count, observed: channelObserved },
    threadOpen: { domThreadId, observedMs: performance.now() - threadStarted, clickToFirstCommentPaintedMs: thread.paintedMs - thread.triggerMs,
      clickToAllCommentsPaintedMs: thread.fullPaintedMs === null ? null : thread.fullPaintedMs - thread.triggerMs, allCommentsTimedOut: thread.fullTimedOut,
      commentRowsRendered: thread.count, observed: thread },
  };
}
async function openCollection(page, folder) {
  const row = `[data-testid="tree-row"][data-path="${folder}"]`;
  const indexedStarted = performance.now();
  await page.locator(`${row}[data-collection="true"]`).waitFor({ timeout: 120000 });
  const indexedWaitObservedMs = performance.now() - indexedStarted;
  const gridRow = '[data-testid="collection-page"] [role="row"][data-index]';
  const settle = await armSurface(page, observeSurface, { trigger: 'click', target: gridRow, countSelector: gridRow, timeoutMs: 120000 });
  const started = performance.now();
  await page.locator(row).click();
  const observed = await settle();
  const ariaRowCount = Number(await page.locator('[data-testid="collection-page"] [role="grid"]').getAttribute('aria-rowcount'));
  return { folder, records, indexedWaitObservedMs, observedMs: performance.now() - started, clickToFirstRowMs: observed.matchedMs - observed.triggerMs,
    clickToRowsPaintedMs: observed.paintedMs - observed.triggerMs, rowsRendered: observed.count, loadedRecords: ariaRowCount - 1, observed };
}
// The automation phase: one document and one dataset Collection, one Button per case on a trigger record.
const cliModule = join(cli, 'src/index.ts');
const tsxLoader = pathToFileURL(createRequire(join(cli, 'package.json')).resolve('tsx')).href;
const { load: loadYaml } = require('js-yaml');
async function datasetCli(instance, runDir, name, request, timeoutMs) {
  const requestPath = join(runDir, `dataset-${name}.json`);
  await json(requestPath, { ...request, cliModule });
  // The same job object as chat seeding owns this process and anything it starts.
  const { stdout } = await runOwnedCommand(process.execPath, ['--import', tsxLoader, datasetCliScript, requestPath],
    { cwd: instance.fixture.workspaces[0].rootPath, env: { ...env, DOHC_STATE_DIR: instance.fixture.profile, NODE_NO_WARNINGS: '1' }, timeoutMs, quietStdout: true, log: join(runDir, `dataset-${name}.log`) });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
// A button can run once main has said which automation it runs.
async function buttonReady(page, name) {
  await page.waitForFunction(name => {
    const button = [...document.querySelectorAll('button[aria-label]')].find(candidate => candidate.getAttribute('aria-label') === name);
    return Boolean(button) && !button.hasAttribute('aria-disabled');
  }, name, { timeout: 120000, polling: 100 });
}
// The engine indexes records a writer dropped on disk after the Collection appears. The table pages on
// demand, so the harness scrolls it to the end until it holds every record, then back to the top.
async function tableHolds(page, expected, timeoutMs = 180000) {
  const started = performance.now();
  const scroll = to => page.evaluate(to => {
    const grid = document.querySelector('[data-testid="collection-page"] [role="grid"]');
    if (!grid) return null;
    const scroller = [...grid.querySelectorAll('div')].find(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
    if (scroller) scroller.scrollTop = to === 'end' ? scroller.scrollHeight : 0;
    return Number(grid.getAttribute('aria-rowcount')) - 1;
  }, to);
  for (let held = await scroll('end'); held !== expected; held = await scroll('end')) {
    if (performance.now() - started > timeoutMs) throw Error(`The Collection table held ${held} of ${expected} records after ${timeoutMs}ms`);
    await delay(250, undefined, { signal: cancellation.signal });
  }
  await scroll('top');
  return performance.now() - started;
}
// A toast the last case left would hide a new toast with the same words, so it goes first.
async function dismissToasts(page) {
  const dismiss = page.locator('[data-testid="notice-toasts"] button[aria-label^="Dismiss workspace"]');
  while (await dismiss.count()) await dismiss.first().click();
}
// Installs the observer, then presses with trusted input. Returns the pending observation in an object,
// so awaiting the press does not also await the run.
async function press(page, name, texts) {
  await page.evaluate(`(() => { window.__dohcAutomation = (${observeAutomationRun.toString()})(${JSON.stringify({ button: name, texts, timeoutMs: CASE_TIMEOUT_MS })}); window.__dohcAutomation.catch(() => {}); })()`);
  await page.getByRole('button', { name, exact: true }).click();
  const settled = page.evaluate(() => window.__dohcAutomation);
  void settled.catch(() => {});
  return { settled };
}
// Process snapshots and the case's journal size, about once a second, until the run settles.
async function sampleDuring(settled, pid, root, automation) {
  let done = false;
  const finished = settled.then(() => { done = true; }, () => { done = true; });
  const snapshots = [];
  let headerPeakBytes = 0;
  while (!done) {
    snapshots.push(await snapshot(pid));
    headerPeakBytes = Math.max(headerPeakBytes, (await journalBytes(root, automation)).headerBytes);
    await Promise.race([finished, delay(1000, undefined, { signal: cancellation.signal })]);
  }
  return { snapshots, headerPeakBytes };
}
async function verifyDocuments(root, spec, outcome, createdPaths) {
  const started = performance.now();
  for (;;) {
    const verification = verifyCase(spec, outcome, await readDocumentCase(root, spec, loadYaml, createdPaths));
    // Settlement writes the Markdown after the run settles.
    if (verification.ok || performance.now() - started > 120000) return { ...verification, settledOnDiskObservedMs: verification.ok ? performance.now() - started : null };
    await delay(500, undefined, { signal: cancellation.signal });
  }
}
async function automationCase(instance, runDir, kind, spec, surface) {
  const { page } = instance, pid = instance.child.pid, workspace = instance.fixture.workspaces[0], root = workspace.rootPath;
  const name = `${spec.name} for ${surface.label}`, automation = automationOf(kind, spec.name);
  if (!(await page.getByRole('button', { name, exact: true }).isVisible())) await surface.open();
  await buttonReady(page, name);
  await dismissToasts(page);
  const quiet = await waitForQuiet({ sample: () => snapshot(pid), appPid: pid, signal: cancellation.signal });
  const before = quiet.snapshot;
  const { settled } = await press(page, name, outcomeTexts(spec.name, surface.label));
  // The closing snapshot starts as the run settles, not after sampling or typing ends.
  const closing = settled.then(() => snapshot(pid));
  void closing.catch(() => {});
  const typed = spec.contention ? typing(page, 'small.md') : null;
  void typed?.catch(() => {});
  const during = await sampleDuring(settled, pid, root, automation);
  const observed = await settled;
  const after = await closing;
  const typingResult = typed ? await typed : null;
  const runs = await readRunJournal(root, automation);
  const outcome = classifyOutcome(observed);
  const verification = kind === 'document'
    ? await verifyDocuments(root, spec, outcome, runs.flatMap(run => run.createdPaths))
    : verifyCase(spec, outcome, (await datasetCli(instance, runDir, `list-${spec.name}`, datasetListRequest(surface.setup, workspace.workspaceId, spec.name), 120000)).rows.map(datasetRowValues));
  const triggerEpochMs = observed.installedEpochMs + observed.triggerMs - observed.installedMs;
  const run = runs.at(-1) ?? null;
  // Keystroke N is the Nth trusted input event, which the renderer stamped when it arrived.
  const samplesDuringRun = typingResult?.inputs.filter(input => input.timestamp >= observed.triggerMs && input.timestamp <= observed.matchedMs).length ?? null;
  // A contention case that settled before the first keystroke arrived measured no contention.
  const overlapped = !spec.contention || spec.expected !== 'done' || samplesDuringRun > 0;
  return { kind, name: spec.name, fixtureSha256: spec.fixtureSha256, expected: spec.expected, outcome, reason: observed.text, pass: outcome === spec.expected && verification.ok && overlapped,
    matches: spec.matches, plannedAssignments: spec.assignments, visibility: verification.visibility, verification, triggerTrusted: observed.triggerTrusted,
    triggerToSettledPaintedMs: observed.paintedMs - observed.triggerMs, triggerToSettledMatchedMs: observed.matchedMs - observed.triggerMs,
    startMs: run ? run.startedAtMs - triggerEpochMs : null, runMs: Number.isFinite(run?.finishedAtMs) ? run.finishedAtMs - run.startedAtMs : null,
    findMs: run?.findMs ?? null, planMs: run?.planMs ?? null, writeMs: run?.writeMs ?? null, writes: run?.writes ?? null,
    journal: { runs, headerPeakBytesSampled: during.headerPeakBytes },
    elapsedMs: after.completedAtMs - before.completedAtMs, cpuMs: cpuByKind(before, after, pid),
    peakBytes: peakByKind([before, ...during.snapshots, after], pid),
    longTasks: observed.longTasks.filter(task => task.startTime + task.duration >= observed.triggerMs && task.startTime <= observed.paintedMs),
    quiet: { waitedMs: quiet.waitedMs, busyShare: quiet.busyShare },
    typing: typingResult && { ...typingResult, samplesDuringRun } };
}
async function automationKind(instance, runDir, kind, cases, surface, result) {
  for (const spec of cases) await buttonReady(instance.page, `${spec.name} for ${surface.label}`);
  for (const spec of cases) {
    const record = await automationCase(instance, runDir, kind, spec, surface);
    result.cases.push(record);
    await json(join(output, 'result.json'), receipt);
    console.log(JSON.stringify({ label, phase: 'automation-case', kind, name: spec.name, expected: record.expected, outcome: record.outcome, pass: record.pass, ms: Math.round(record.triggerToSettledPaintedMs) }));
  }
}
// Writes into data.collectionAutomations as it goes, so a failed run keeps the cases it finished.
async function automationPhase(instance, runDir, data) {
  const { page, fixture } = instance, workspace = fixture.workspaces[0];
  const cases = automationCases({ findCap, writeCap });
  const result = data.collectionAutomations = { findCap, writeCap, fixtureSha256: automationFixtureDigest(cases), document: { cases: [] }, dataset: { cases: [] } };
  // Written as an agent writes files: the schema and automations first, then the records.
  const files = documentAutomationFiles(cases);
  const written = performance.now();
  await mkdir(join(workspace.rootPath, DOCUMENT_FOLDER));
  for (let begin = 0; begin < files.length; begin += 32) {
    cancellation.signal.throwIfAborted();
    await Promise.all(files.slice(begin, begin + 32).map(file => writeFile(join(workspace.rootPath, file.path), file.content)));
  }
  await page.locator(`[data-testid="tree-row"][data-path="${DOCUMENT_FOLDER}"][data-collection="true"]`).waitFor({ timeout: 120000 });
  result.document.seed = { files: files.length, collectionObservedMs: performance.now() - written };
  const documents = { label: TRIGGER.document.label, open: () => page.locator(`[data-testid="tree-row"][data-path="${DOCUMENT_FOLDER}"]`).click() };
  await documents.open();
  result.document.seed.tableHoldsAllObservedMs = await tableHolds(page, files.filter(file => file.path.endsWith('.md')).length);
  await automationKind(instance, runDir, 'document', cases, documents, result.document);

  await waitUntil(() => Promise.all(['dohc-cli-endpoint', 'dohc-cli-token'].map(name => stat(join(fixture.profile, name)))).then(() => true, () => false), 60000);
  const setup = await datasetCli(instance, runDir, 'setup', datasetSetupRequest(cases, workspace.workspaceId), 600000);
  result.dataset.seed = setup;
  await writeFile(join(workspace.rootPath, DATASET_FOLDER, 'automations.yaml'), automationsYaml(cases, 'dataset'));
  const opener = page.getByRole('region', { name: 'Collections', exact: true }).getByRole('button', { name: DATASET_NAME, exact: true });
  const datasets = { label: TRIGGER.dataset.label, setup, open: async () => { await opener.waitFor({ timeout: 120000 }); await opener.click(); } };
  await datasets.open();
  await automationKind(instance, runDir, 'dataset', cases, datasets, result.dataset);
}
async function soak(instance, data) {
  const page = instance.page;
  const sample = async cycle => ({ cycle, ...aggregateByKind(await snapshot(instance.child.pid), instance.child.pid) });
  const result = data.soak = { minutes: soakMinutes, searchQuery: SOAK_SEARCH_QUERY, goToQuery: 'small', cycles: [], samples: [await sample(0)], elapsedMs: null };
  const deadline = performance.now() + soakMinutes * 60000;
  while (performance.now() < deadline) {
    cancellation.signal.throwIfAborted();
    const started = performance.now();
    const cycle = { index: result.cycles.length + 1 };
    cycle.openLargeObservedMs = (await openDoc(page, 'large.md')).openObservedMs;
    cycle.openSmallObservedMs = (await openDoc(page, 'small.md')).openObservedMs;
    cycle.goToOpenMs = (await openPalette(page, surfaces.goTo, 'editable-input')).keydownToPaintedMs;
    await typeInPalette(page, surfaces.goTo, 'small');
    await closePalette(page, surfaces.goTo);
    cycle.commandPaletteOpenMs = (await openPalette(page, surfaces.commandPalette, 'first-row')).keydownToPaintedMs;
    await closePalette(page, surfaces.commandPalette);
    await openSearchView(page);
    cycle.searchQuery = SOAK_SEARCH_QUERY;
    cycle.searchSettledMs = (await searchQuery(page, SOAK_SEARCH_QUERY, null)).submitToSettledMs;
    await page.getByTestId('activity-explorer').click();
    await page.getByTestId('file-tree').waitFor({ timeout: 30000 });
    cycle.switchEditableObservedMs = [(await switchTo(page, 1)).editablePaintObservedMs, (await switchTo(page, 0)).editablePaintObservedMs];
    cycle.durationMs = performance.now() - started;
    result.cycles.push(cycle);
    result.samples.push(await sample(cycle.index));
    result.elapsedMs = result.samples.at(-1).completedAtMs - result.samples[0].completedAtMs;
    await json(join(output, 'result.json'), receipt);
    console.log(JSON.stringify({ label, phase: 'soak-cycle', cycle: cycle.index, durationMs: Math.round(cycle.durationMs) }));
  }
  return result;
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
    if (['go-to', 'command-palette', 'search', 'collection'].includes(scenario)) {
      data.listing = await filesListed(fresh.page, fixtureFiles + (scenario === 'collection' ? 1 : 0));
      if (scenario === 'go-to') data.goTo = await goTo(fresh.page);
      if (scenario === 'command-palette') data.commandPalette = await commandPalette(fresh.page);
      if (scenario === 'search') data.search = await search(fresh.page);
      if (scenario === 'collection') {
        data.collection = await openCollection(fresh.page, 'records');
        data.typing = [await typing(fresh.page, 'small.md')];
        await json(join(output, 'result.json'), receipt);
        await automationPhase(fresh, runDir, data);
        automationFailures.push(...['document', 'dataset'].flatMap(kind => data.collectionAutomations[kind].cases.filter(c => !c.pass).map(c => `run ${index + 1} ${kind} ${c.name}: expected ${c.expected}, ${c.outcome}${c.verification.ok ? '' : `, ${c.verification.problemCount} wrong values`}`)));
      }
      await fresh.page.screenshot({ path: join(runDir, 'completed.png') });
      await shutdown(runDir, fresh);
      await json(join(output, 'result.json'), receipt);
      continue;
    }
    if (scenario === 'chat-history') {
      data.chatSeed = await seedChatHistory(fresh, f.workspaces[0], runDir);
      await json(join(output, 'result.json'), receipt);
      await shutdown(runDir, fresh);
      const restart = await launch(runDir, f, 'restart');
      data.restartStartup = restart.startup;
      data.chatHistory = await openChatHistory(restart.page, data.chatSeed);
      await restart.page.screenshot({ path: join(runDir, 'completed.png') });
      await shutdown(runDir, restart);
      await json(join(output, 'result.json'), receipt);
      continue;
    }
    if (scenario === 'soak') {
      data.switchPrecondition = [await switchTo(fresh.page, 1), await switchTo(fresh.page, 0)];
      console.log(JSON.stringify({ label, phase: 'soak-start', minutes: soakMinutes }));
      await soak(fresh, data);
      await fresh.page.screenshot({ path: join(runDir, 'completed.png') });
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
    const restart = await launch(runDir, f, 'restart');
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
  if (automationFailures.length) throw Error(`Collection automation cases failed: ${automationFailures.join('; ')}`);
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
