import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOptions, createEvidenceDirectory, benchmarkEnvironment, packagedLaunchArgs } from './packaged-benchmark-options.mjs';
import { startWindowController, waitForVisibleWindow } from './window-controller.mjs';
import { closeOwnedPackage, observeExit, benchmarkCancellation, verifyRestartInput } from './packaged-process.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';
import { compareSummaries, DEFAULT_MARGIN } from './compare-packaged-benchmark.mjs';
import { createRequire } from 'node:module';
import { observeStartupReadiness, startupTargetFromRegistry } from './startup-readiness.mjs';
import { observeSurface, observeSearchSubmit, seededPostThreadId, collectionFixtureFiles, recordId, classifyProcess, aggregateByKind } from './packaged-surfaces.mjs';
import { automationCases, automationFixtureDigest, automationOf, busyShare, classifyOutcome, cpuByKind, DATASET_NAME, datasetAutomationDefinition, datasetListRequest, datasetRowValues, datasetSetupRequest, DEFAULT_LIMITS,
  documentAutomationFiles, documentValues, journalBytes, observeAutomationRun, outcomeTexts, peakByKind, readDocumentCase, readRunJournal, TRIGGER,
  verifyCase, waitForQuiet, WIDE_SET } from './packaged-collection-automations.mjs';
import { run as runOwnedCommand } from '../../scripts/verification/process.mjs';

// A jsdom window with a fake clock. Frames and timers only advance through step() and frame().
function fakePage(t, html) {
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  let now = 10, id = 0;
  const frames = new Map(), timers = new Map();
  w.performance.now = () => now;
  w.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  w.cancelAnimationFrame = key => frames.delete(key);
  w.setTimeout = (callback, ms) => { timers.set(++id, { callback, at: now + ms }); return id; };
  w.clearTimeout = key => timers.delete(key);
  // jsdom has no layout. All DOM ancestry, selection and computed-style
  // checks are real; this supplies the visible fixture's viewport geometry.
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 });
  const step = () => {
    now += 50;
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
  };
  const frame = () => {
    now += 16;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(now);
  };
  const run = (observer, options) => w.eval(`(${observer.toString()})`)(options);
  const keydown = (target, key) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));
  return { window: w, document: w.document, run, step, frame, frames, timers, keydown, now: () => now };
}
// MutationObserver callbacks are microtasks; settle them before driving the fake clock.
const mutations = () => new Promise(resolve => setImmediate(resolve));

function readinessPage(t) {
  const p = fakePage(t, `<div data-testid="workspace-shell" data-ready="true">
    <button data-testid="workspace-switcher">workspace-0</button>
    <div data-testid="workspace-workbench">
      <section data-editor-group-id="primary" data-active="true">
        <div role="tab" aria-selected="true" data-testid="tab-small.md">small.md</div>
        <div data-testid="view-markdown"><div class="tiptap" contenteditable="true">Workspace 0 small</div></div>
      </section>
    </div>
  </div>`);
  const observe = (target = { workspaceName: 'workspace-0', path: 'small.md', content: 'Workspace 0 small' }) => p.run(observeStartupReadiness, { ...target, timeoutMs: 1000 });
  return { ...p, observe };
}

test('startup observer records an already-ready document without inferring earlier readiness', async t => {
  const p = readinessPage(t);
  const result = p.observe();
  p.frame(); p.frame();
  const observed = await result;
  assert.equal(observed.alreadyReady, true);
  assert.equal(observed.observerInstalledMs, 10);
  assert.equal(observed.predicateMatchedMs, 10);
  assert.equal(observed.secondAnimationFrameMs, 42);
  assert.ok(Number.isFinite(observed.timeOrigin));
  assert.equal(p.timers.size + p.frames.size, 0);
});

test('startup observer installed before the body exists waits for the editable document', async t => {
  const p = readinessPage(t);
  const body = p.document.body;
  body.remove();
  assert.equal(p.document.body, null);
  const result = p.observe();
  assert.equal(p.frames.size, 0);
  p.document.documentElement.append(body);
  p.step(); p.frame(); p.frame();
  const observed = await result;
  assert.equal(observed.alreadyReady, false);
  assert.equal(observed.observerInstalledMs, 10);
  assert.equal(observed.predicateMatchedMs, 60);
  assert.equal(observed.secondAnimationFrameMs, 92);
  assert.equal(p.frames.size + p.timers.size, 0);
});

const notReadyCases = {
  'wrong workspace': d => { const node = d.querySelector('[data-testid="workspace-switcher"]'); node.textContent = 'workspace-1'; return () => { node.textContent = 'workspace-0'; }; },
  'wrong selected tab': d => { const node = d.querySelector('[role="tab"]'); node.setAttribute('data-testid', 'tab-large.md'); return () => node.setAttribute('data-testid', 'tab-small.md'); },
  'wrong document body': d => { const node = d.querySelector('.tiptap'); node.textContent = 'Workspace 1 small'; return () => { node.textContent = 'Workspace 0 small'; }; },
  'inactive editor group': d => { const node = d.querySelector('[data-editor-group-id]'); node.removeAttribute('data-active'); return () => node.setAttribute('data-active', 'true'); },
  'unselected tab': d => { const node = d.querySelector('[role="tab"]'); node.setAttribute('aria-selected', 'false'); return () => node.setAttribute('aria-selected', 'true'); },
  'pending workspace': d => { const node = d.querySelector('[data-testid="workspace-shell"]'); node.setAttribute('data-ready', 'false'); return () => node.setAttribute('data-ready', 'true'); },
  'hidden preserved editor': d => { const node = d.querySelector('[data-testid="view-markdown"]'); node.hidden = true; return () => { node.hidden = false; }; },
  'inert workbench': d => { const node = d.querySelector('[data-testid="workspace-workbench"]'); node.setAttribute('inert', ''); return () => node.removeAttribute('inert'); },
  'CSS-hidden pane': d => { const node = d.querySelector('[data-testid="view-markdown"]'); node.style.display = 'none'; return () => { node.style.display = ''; }; },
  'read-only editor': d => { const node = d.querySelector('.tiptap'); node.setAttribute('contenteditable', 'false'); return () => node.setAttribute('contenteditable', 'true'); },
  'zero-sized editor': d => { const node = d.querySelector('.tiptap'); node.getBoundingClientRect = () => ({ width: 0, height: 0 }); return () => { delete node.getBoundingClientRect; }; },
};
for (const [name, prepare] of Object.entries(notReadyCases)) test(`startup observer waits for ${name} to become usable`, async t => {
  const p = readinessPage(t);
  const restore = prepare(p.document);
  const result = p.observe();
  assert.equal(p.frames.size, 0);
  restore(); p.step(); p.frame(); p.frame();
  const observed = await result;
  assert.equal(observed.alreadyReady, false);
  assert.equal(observed.observerInstalledMs, 10);
  assert.equal(observed.predicateMatchedMs, 60);
  assert.equal(observed.secondAnimationFrameMs, 92);
});

test('startup observer restarts its frame check when the bound editor is replaced', async t => {
  const p = readinessPage(t);
  const result = p.observe();
  p.frame();
  const editor = p.document.querySelector('.tiptap');
  editor.replaceWith(editor.cloneNode(true));
  p.frame(); p.frame(); p.frame();
  const observed = await result;
  assert.equal(observed.predicateMatchedMs, 42);
  assert.equal(observed.secondAnimationFrameMs, 74);
});

const fixtureWorkspaces = [0, 1].map(index => ({ workspaceId: `perf4-package-${index}`, rootPath: `C:/fixture/workspace-${index}` }));

test('full restart after odd switches opens registry workspace 0 despite workspace 1 recency', async t => {
  const p = readinessPage(t);
  const registry = { version: 1, workspaces: fixtureWorkspaces.map((workspace, index) => ({ ...workspace, lastOpenedAt: 100 + index })) };
  const result = p.observe(startupTargetFromRegistry(registry, fixtureWorkspaces));
  p.frame(); p.frame();
  const observed = await result;
  assert.equal(observed.alreadyReady, true);
  assert.equal(observed.workspaceName, 'workspace-0');
  assert.equal(observed.path, 'small.md');
});

test('restart records a different known workspace only when the persisted registry selects it', async t => {
  const p = readinessPage(t);
  p.document.querySelector('[data-testid="workspace-switcher"]').textContent = 'workspace-1';
  p.document.querySelector('.tiptap').textContent = 'Workspace 1 small';
  const result = p.observe(startupTargetFromRegistry({ version: 1, workspaces: [...fixtureWorkspaces].reverse() }, fixtureWorkspaces));
  p.frame(); p.frame();
  const observed = await result;
  assert.equal(observed.alreadyReady, true);
  assert.equal(observed.workspaceName, 'workspace-1');
  assert.equal(observed.path, 'small.md');
});

test('startup target refuses unknown workspace identities and roots', () => {
  for (const selected of [{ workspaceId: 'unknown', rootPath: 'C:/fixture/workspace-0' }, { ...fixtureWorkspaces[0], rootPath: 'C:/other' }]) {
    assert.throws(() => startupTargetFromRegistry({ version: 1, workspaces: [selected] }, fixtureWorkspaces), /known fixture workspace/);
  }
});

test('startup observer cannot combine the active selection with content in another group', async t => {
  const p = readinessPage(t);
  const group = p.document.querySelector('[data-editor-group-id]');
  const inactiveGroup = group.cloneNode(true);
  inactiveGroup.removeAttribute('data-active');
  inactiveGroup.setAttribute('data-editor-group-id', 'other');
  group.after(inactiveGroup);
  const activeEditor = group.querySelector('.tiptap');
  activeEditor.textContent = 'Workspace 1 small';
  const result = p.observe();
  assert.equal(p.frames.size, 0);
  activeEditor.textContent = 'Workspace 0 small';
  p.step(); p.frame(); p.frame();
  assert.equal((await result).alreadyReady, false);
});

for (const frameNumber of [1, 2]) test(`startup observer rejects a DOM error in animation frame ${frameNumber}`, async t => {
  const p = readinessPage(t);
  const result = p.observe();
  if (frameNumber === 2) p.frame();
  p.document.querySelector('.tiptap').getBoundingClientRect = () => { throw Error('fixture DOM failure'); };
  const rejected = assert.rejects(result, /fixture DOM failure/);
  p.frame();
  await rejected;
  assert.equal(p.frames.size + p.timers.size, 0);
});

test('startup observer times out and clears scheduled work when no editable document appears', async t => {
  const p = readinessPage(t);
  p.document.querySelector('.tiptap').remove();
  const rejected = assert.rejects(p.observe(), /Expected visible editable document/);
  for (let n = 0; n < 20; n++) p.step();
  await rejected;
  assert.equal(p.frames.size + p.timers.size, 0);
});

test('startup observer propagates the editing refusal', async t => {
  const p = readinessPage(t);
  p.document.body.innerText = 'dohc could not open this document for editing.';
  await assert.rejects(p.observe(), /Actual packaged app refused document editing/);
  assert.equal(p.frames.size + p.timers.size, 0);
});

const paletteHtml = '<div data-testid="quick-open"><input aria-label="File"><ul role="listbox"><li role="option">a.md</li><li role="option">b.md</li></ul></div>';
test('surface observer sees a keydown-triggered palette on the next frame and paints one frame later', async t => {
  const p = fakePage(t, '<main></main>');
  const pending = p.run(observeSurface, { trigger: 'keydown', triggerKey: 'p', target: '[data-testid="quick-open"] input', focused: '[data-testid="quick-open"] input', countSelector: '[role="option"]', timeoutMs: 1000 });
  p.frame();
  p.keydown(p.document.body, 'Control');
  p.document.body.insertAdjacentHTML('beforeend', paletteHtml);
  p.document.querySelector('input').focus();
  await mutations(); p.frame();
  assert.equal(p.frames.size, 1, 'only the frame loop is pending: a surface present before the trigger is not a match');
  p.keydown(p.document.body, 'p');
  p.frame();
  assert.equal(p.frames.size, 2, 'the frame loop matched without a mutation and started the one-frame wait');
  p.frame();
  const observed = await pending;
  assert.equal(observed.triggerMs, 42);
  assert.equal(observed.triggerTrusted, false);
  // Matched inside frame N's callback, which paints it; the next callback comes after that paint.
  assert.deepEqual([observed.matchedMs, observed.matchedIn, observed.paintedMs], [58, 'frame', 74]);
  assert.deepEqual([observed.count, observed.matchedCount, observed.firstText, observed.entranceAnimating, observed.fullTimedOut], [2, 1, 'a.md', false, false]);
  assert.equal(p.frames.size + p.timers.size, 0);
});
test('surface observer waits for the typed value, a focused input, and an in-order first row', async t => {
  const p = fakePage(t, paletteHtml);
  const input = p.document.querySelector('input');
  input.focus();
  const typed = p.run(observeSurface, { trigger: 'keydown', triggerKey: 'x', target: 'input', value: 'x', focused: 'input', firstTextMatches: 'AM', countSelector: '[role="option"]', timeoutMs: 1000 });
  p.keydown(input, 'x');
  p.frame();
  assert.equal(p.frames.size, 1, 'the keystroke has not reached the input value yet');
  input.value = 'x';
  input.blur();
  p.frame();
  assert.equal(p.frames.size, 1, 'focus left the input');
  input.focus();
  assert.equal(p.frames.size, 2, 'the focus change matched and started the one-frame wait');
  p.frame();
  const observed = await typed;
  assert.deepEqual([observed.matchedIn, observed.paintedMs - observed.matchedMs], ['focus', 16]);
  assert.deepEqual([observed.text, observed.firstText, observed.count], ['', 'a.md', 2]);
  const mismatch = p.run(observeSurface, { target: 'input', firstTextMatches: 'zz', countSelector: '[role="option"]', timeoutMs: 120 });
  const rejected = assert.rejects(mismatch, /did not render within 120ms/);
  p.step(); p.step(); p.step();
  await rejected;
  assert.equal(p.frames.size + p.timers.size, 0);
});
test('surface observer carries a first and a full milestone from one trigger and flags a full milestone that misses the deadline', async t => {
  const p = fakePage(t, '<button>Open</button><ol></ol>');
  const pending = p.run(observeSurface, { trigger: 'click', target: 'ol li', fullCount: 3, countSelector: 'ol li', timeoutMs: 1000 });
  p.document.querySelector('button').dispatchEvent(new p.window.MouseEvent('mousedown', { bubbles: true }));
  p.document.querySelector('ol').insertAdjacentHTML('beforeend', '<li>1</li>');
  await mutations();
  p.frame(); p.frame();
  assert.equal(p.frames.size, 1, 'the first milestone painted and only the frame loop remains');
  p.document.querySelector('ol').insertAdjacentHTML('beforeend', '<li>2</li><li>3</li>');
  await mutations();
  p.frame(); p.frame();
  const observed = await pending;
  // Both milestones matched between frames through mutations; each ends at the next frame callback.
  assert.deepEqual([observed.triggerMs, observed.matchedMs, observed.paintedMs, observed.fullMatchedMs, observed.fullPaintedMs], [10, 10, 26, 42, 58]);
  assert.deepEqual([observed.matchedIn, observed.fullMatchedIn, observed.count, observed.fullTimedOut], ['mutation', 'mutation', 3, false]);
  const partial = p.run(observeSurface, { target: 'ol li', fullCount: 10, timeoutMs: 100 });
  p.frame(); p.frame();
  p.step(); p.step();
  const timedOut = await partial;
  assert.equal(timedOut.fullTimedOut, true);
  assert.equal(timedOut.fullPaintedMs, null);
  // The rows were already present, so the installation check matched; it is not a frame callback.
  assert.deepEqual([timedOut.matchedIn, timedOut.paintedMs - timedOut.matchedMs], ['install', 16]);
  assert.equal(p.frames.size + p.timers.size, 0);
});
test('surface observer rejects unknown triggers and a surface that never renders', async t => {
  const p = fakePage(t, '<main></main>');
  await assert.rejects(p.run(observeSurface, { trigger: 'hover', target: 'main' }), /Unknown trigger/);
  const missing = p.run(observeSurface, { target: '[data-testid="absent"]', timeoutMs: 120 });
  const rejected = assert.rejects(missing, /did not render within 120ms/);
  p.step(); p.step(); p.step();
  await rejected;
  assert.equal(p.frames.size + p.timers.size, 0);
});
const searchHtml = '<div data-testid="search-view" data-state="idle" data-search-id=""><input data-testid="search-input"><ul></ul></div>';
test('search observer times Enter to the first result row and to the complete state', async t => {
  const p = fakePage(t, searchHtml);
  const view = p.document.querySelector('[data-testid="search-view"]');
  const input = p.document.querySelector('input');
  const pending = p.run(observeSearchSubmit, { timeoutMs: 1000 });
  p.frame();
  p.keydown(p.document.body, 'Enter');
  p.keydown(input, 'Enter');
  view.dataset.searchId = 's1'; view.dataset.state = 'searching';
  view.querySelector('ul').innerHTML = '<li data-testid="search-result-row">hit</li>';
  await mutations(); p.frame();
  view.dataset.state = 'complete';
  view.insertAdjacentHTML('beforeend', '<span data-testid="search-summary">1 result in 1 file</span>');
  await mutations(); p.frame(); p.frame();
  const observed = await pending;
  assert.equal(observed.submitMs, 26);
  assert.equal(observed.submitTrusted, false);
  assert.equal(observed.debounceFiredBeforeSubmit, false);
  assert.deepEqual([observed.firstResultMs, observed.firstResultPaintedMs, observed.settledMs, observed.settledPaintedMs], [26, 42, 42, 58]);
  assert.deepEqual([observed.firstResultMatchedIn, observed.settledMatchedIn], ['mutation', 'mutation']);
  assert.deepEqual([observed.rowsRendered, observed.summary, observed.limitHit, observed.emptyState, observed.searchIdChanges], [1, '1 result in 1 file', false, false, 0]);
  assert.deepEqual([[...observed.statesSeen], observed.sawUpdating], [['searching', 'complete'], false]);
  assert.equal(p.frames.size + p.timers.size, 0);
});
test('search observer flags a debounce that ran before Enter, records updating, and keeps a missing first result missing', async t => {
  const p = fakePage(t, searchHtml);
  const view = p.document.querySelector('[data-testid="search-view"]');
  const pending = p.run(observeSearchSubmit, { timeoutMs: 1000 });
  view.dataset.searchId = 'typed'; view.dataset.state = 'complete';
  await mutations();
  p.keydown(p.document.querySelector('input'), 'Enter');
  view.dataset.searchId = 's2'; view.dataset.state = 'updating';
  await mutations();
  view.dataset.state = 'complete';
  view.insertAdjacentHTML('beforeend', '<div data-testid="search-empty-state">No results found</div>');
  await mutations(); p.frame(); p.frame();
  const observed = await pending;
  assert.equal(observed.debounceFiredBeforeSubmit, true);
  assert.equal(observed.firstResultMs, null);
  assert.deepEqual([observed.emptyState, observed.rowsRendered, [...observed.statesSeen], observed.sawUpdating], [true, 0, ['updating', 'complete'], true]);
  const closed = fakePage(t, '<main></main>');
  await assert.rejects(closed.run(observeSearchSubmit, {}), /Search view is not open/);
});
test('seeded post is found by its title and yields the engine thread id the DOM carries, not the CLI handle', t => {
  const post = (id, title) => `<div data-testid="chats-post-card" data-thread-id="${id}"><div data-testid="chats-thread" data-thread-id="${id}"><span data-testid="chats-post-title"> ${title} </span></div></div>`;
  const p = fakePage(t, `<div data-testid="chats-channel-view">${post('thread-f7a6fc48-3eb4', 'Other post')}${post('thread-0c1d2e3f-4a5b', 'Long history')}</div>`);
  assert.equal(p.run(seededPostThreadId, { title: 'Long history' }), 'thread-0c1d2e3f-4a5b');
  assert.throws(() => p.run(seededPostThreadId, { title: 'th_0c1d2e3f-4a5b' }), /found 0/);
  p.document.querySelector('[data-testid="chats-channel-view"]').insertAdjacentHTML('beforeend', post('thread-dup', 'Long history'));
  assert.throws(() => p.run(seededPostThreadId, { title: 'Long history' }), /found 2/);
});
test('collection fixture writes the schema first and deterministic pre-minted record ids', () => {
  const files = collectionFixtureFiles(3);
  assert.deepEqual(files.map(f => f.path), ['records/collection.yaml', 'records/record-000001.md', 'records/record-000002.md', 'records/record-000003.md']);
  assert.match(files[0].content, /^version: 1\nname: Records\nfields:\n {2}Name:\n {4}type: text\n/);
  const ids = files.slice(1).map(f => f.content.match(/^id: (\S+)$/m)[1]);
  for (const id of ids) assert.match(id, /^rec_[a-z2-7]{26}$/);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(collectionFixtureFiles(3), files);
  assert.match(files[1].content, /^Due: "2026-\d{2}-\d{2}"$/m);
  assert.equal(recordId('records/1'), ids[0]);
});
test('process kinds come from the launched pid, engine name, and Chromium type flags', () => {
  const processes = [
    { pid: 1, name: 'dohc.exe', commandLine: '"C:\\dohc.exe" --user-data-dir=x', workingSetBytes: 100, privateBytes: 10 },
    { pid: 2, name: 'dohc.exe', commandLine: 'dohc.exe --type=renderer --lang=en', workingSetBytes: 200, privateBytes: 20 },
    { pid: 3, name: 'dohc.exe', commandLine: 'dohc.exe --type=renderer', workingSetBytes: 300, privateBytes: 30 },
    { pid: 4, name: 'dohc.exe', commandLine: 'dohc.exe --type=gpu-process', workingSetBytes: 40, privateBytes: 4 },
    { pid: 5, name: 'dohc.exe', commandLine: 'dohc.exe --type=utility --utility-sub-type=network.mojom.NetworkService', workingSetBytes: 50, privateBytes: 5 },
    { pid: 6, name: 'dohc-workspace-engine.exe', commandLine: null, workingSetBytes: 60, privateBytes: 6 },
    { pid: 7, name: 'dohc.exe', commandLine: 'dohc.exe --type=crashpad-handler', workingSetBytes: 7, privateBytes: 1 },
    { pid: 8, name: 'pwsh.exe', commandLine: 'pwsh -File sampler.ps1', workingSetBytes: 8, privateBytes: 1 },
  ];
  assert.deepEqual(processes.map(p => classifyProcess(p, 1)), ['main', 'renderer', 'renderer', 'gpu', 'utility', 'engine', 'crashpad', 'other']);
  const aggregate = aggregateByKind({ completedAtMs: 5, processes }, 1);
  assert.equal(aggregate.processCount, 8);
  assert.deepEqual(aggregate.kinds.renderer, { count: 2, workingSetBytes: 500, privateBytes: 50 });
  assert.deepEqual(aggregate.kinds.main, { count: 1, workingSetBytes: 100, privateBytes: 10 });
});

const required = ['--binary', 'dohc.exe', '--package-commit', 'a'.repeat(40), '--output', 'new-output', '--label', 'baseline'];
test('packaged rehearsals opt out of OS registration with their own profile', () => {
  const profile = resolve('rehearsal/profile');
  const args = packagedLaunchArgs(profile);
  assert.ok(args.includes(`--user-data-dir=${profile}`));
  assert.ok(args.includes('--dohc-isolated-test'));
  assert.throws(() => packagedLaunchArgs('relative/profile'), /absolute profile/);
  assert.throws(() => packagedLaunchArgs(''), /absolute profile/);
});
test('release environment excludes inherited dohc integration and Node controls', () => {
  const inherited = {
    PATH: 'runtime-path', SystemRoot: 'windows-root', HOME: 'user-home',
    DOHC_DESKTOP_OWNER_HOST_CONFIG: 'private-host', DOHC_DESKTOP_OWNER_DELIVERY_CONFIG: 'private-delivery',
    DOHC_UPDATE_URL: 'external-feed', DOHC_TEST_HOME: 'other-profile', DOHC_FUTURE_CONTROL: 'future',
    dohc_lowercase_control: 'windows-case-variant', ELECTRON_RUN_AS_NODE: '1', node_options: 'injected',
  };
  assert.deepEqual(benchmarkEnvironment(inherited, 'http://127.0.0.1:1234'), {
    PATH: 'runtime-path', SystemRoot: 'windows-root', HOME: 'user-home', DOHC_UPDATE_URL: 'http://127.0.0.1:1234',
  });
  assert.equal(inherited.DOHC_DESKTOP_OWNER_HOST_CONFIG, 'private-host');
});
test('strict release CLI rejects typos, duplicates, missing provenance and ambiguous modes', () => {
  assert.equal(parseOptions(required).scenario, 'full');
  assert.equal(parseOptions(required).runCount, 3);
  assert.deepEqual(parseOptions(['--help']), { help: true });
  for (const extra of [
    ['--runs'], ['--typo', '3'], ['--runs', 'NaN'], ['--runs', '0'], ['--runs', '1.5'], ['--runs', '1e2'],
    ['--files', '1'], ['--switches', '-1'], ['--idle-seconds', 'Infinity'], ['--runs', '2', '--runs', '3'],
    ['--label', 'candidate'], ['--profile-main', 'yes'], ['--profile-renderer', '1'], ['--scenario', 'typo'],
    ['--package-dir', 'other'], ['--engine-commit', 'HEAD'], ['--profile-main', 'true'],
    ['--profile-renderer', 'true', '--scenario', 'startup'], ['--profile-renderer', 'true', '--scenario', 'go-to'],
    ['--soak-minutes', '5'], ['--chat-messages', '5'], ['--records', '5'], ['--scenario', 'soak', '--soak-minutes', '0'],
    ['--scenario', 'chat-history', '--chat-messages', '1'], ['--scenario', 'soak', '--records', '5'],
    ['--scenario', 'go-to'], ['--scenario', 'search', '--files', '4242'],
  ]) assert.throws(() => parseOptions([...required, ...extra]), JSON.stringify(extra));
  assert.throws(() => parseOptions(required.filter((_, i) => i !== 2 && i !== 3)), /package-commit/);
  assert.throws(() => parseOptions([...required, '--scenario', 'go-to']), /at least 4243/);
});
test('surface scenarios parse with their own sizes and defaults', () => {
  for (const scenario of ['go-to', 'command-palette', 'search', 'chat-history', 'collection', 'soak']) {
    const options = parseOptions([...required, '--scenario', scenario, '--files', '5000']);
    assert.deepEqual([options.scenario, options.soakMinutes, options.chatMessages, options.records], [scenario, 10, 200, 500]);
  }
  assert.equal(parseOptions([...required, '--scenario', 'go-to', '--files', '4243']).fixtureFiles, 4243);
  assert.equal(parseOptions([...required, '--scenario', 'soak', '--soak-minutes', '3', '--profile-renderer', 'true']).soakMinutes, 3);
  assert.equal(parseOptions([...required, '--scenario', 'chat-history', '--chat-messages', '2']).chatMessages, 2);
  assert.equal(parseOptions([...required, '--scenario', 'collection', '--records', '1']).records, 1);
});

test('evidence directory is exclusive even for concurrent starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dohc-release-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'nested', 'run');
  const results = await Promise.allSettled([createEvidenceDirectory(output), createEvidenceDirectory(output)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await writeFile(join(output, 'keep.txt'), 'evidence');
  await assert.rejects(createEvidenceDirectory(output), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'evidence');
});
test('missing package binary finalizes a CLI failure receipt', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dohc-release-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'failed-run');
  const result = spawnSync(process.execPath, ['tools/perf-profiling/packaged-benchmark.mjs',
    '--binary', join(root, 'missing.exe'), '--package-commit', 'a'.repeat(40), '--output', output, '--label', 'baseline'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.error, /ENOENT.*missing\.exe/);
  assert.equal(receipt.packageCommit, 'a'.repeat(40));
  assert.ok(receipt.completedAt);
  assert.deepEqual(receipt.runs, []);
  assert.deepEqual(receipt.feedRequests, []);
});
for (const selected of [true, false]) test(`restart verifies saved input when edited workspace is ${selected ? 'already selected' : 'not selected'}`, async () => {
  const calls = [];
  const config = { isEditedWorkspaceSelected: async () => selected, marker: 'saved', selectEditedWorkspace: async () => { calls.push('select workspace 0'); },
    readEditedText: async () => { calls.push('read'); return 'saved'; } };
  assert.equal(await verifyRestartInput(config), true);
  assert.deepEqual(calls, selected ? ['read'] : ['select workspace 0', 'read']);
  await assert.rejects(verifyRestartInput({ ...config, readEditedText: async () => 'lost' }), /did not restore/);
});

const fixture = body => `const readline=require('node:readline'); ${body}`;
const protocol = `console.log(JSON.stringify({ready:true})); readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.state==='exit')process.exit(0);console.log(JSON.stringify({id:r.id,value:{ok:true}}));});`;
// Loaded-gate bounds for helpers that follow the protocol. A helper that ignores
// the exit request passes closeTimeoutMs: 100 so its forced stop stays quick.
function controller(code, options = {}) {
  return startWindowController({ command: process.execPath, args: ['-e', fixture(code)], startupTimeoutMs: 20_000, requestTimeoutMs: 10_000, closeTimeoutMs: 10_000, ...options });
}
test('helper completes requests and closes the recorded process', async () => {
  let child;
  const helper = await controller(protocol, { onSpawn: value => { child = value; } });
  try { assert.deepEqual(await helper.request({ state: 'inspect' }), { ok: true }); }
  finally { await helper.close(); }
  assert.notEqual(child.exitCode, null);
  await assert.rejects(helper.request({ state: 'ping' }), /closed/);
});
test('ordinary helper error rejects one request and the same controller remains usable', async () => {
  let child;
  const helper = await controller(`console.log(JSON.stringify({ready:true}));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.state==='exit')process.exit(0);console.log(JSON.stringify(r.state==='inspect'?{id:r.id,error:'Window title is changing'}:{id:r.id,value:{ok:true}}));});`, { onSpawn: value => { child = value; } });
  try {
    await assert.rejects(helper.request({ state: 'inspect' }), /Window title is changing/);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.deepEqual(await helper.request({ state: 'visible' }), { ok: true });
  } finally { await helper.close(); }
  assert.notEqual(child.exitCode, null);
});
test('startup polling retries explicit not-ready replies on the same helper', async () => {
  const helper = await controller(`let inspections=0;console.log(JSON.stringify({ready:true}));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.state==='exit')process.exit(0);const value=r.state==='inspect'?(++inspections===1?{ready:false,reason:'title-changing'}:{visible:true,minimized:false,inspections}):{ok:true};console.log(JSON.stringify({id:r.id,value}));});`);
  try {
    const state = await waitForVisibleWindow(() => helper.request({ state: 'inspect' }));
    assert.equal(state.inspections, 2);
    assert.equal(state.visible, true);
  } finally { await helper.close(); }
});
test('startup polling propagates ownership errors without retrying', async () => {
  const helper = await controller(`console.log(JSON.stringify({ready:true}));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.state==='exit')process.exit(0);console.log(JSON.stringify(r.state==='inspect'?{id:r.id,error:'PID no longer belongs to the recorded packaged executable'}:{id:r.id,value:true}));});`);
  let requests = 0;
  try {
    await assert.rejects(waitForVisibleWindow(() => { requests++; return helper.request({ state: 'inspect' }); }), /PID no longer belongs/);
    assert.equal(requests, 1);
  } finally { await helper.close(); }
});
test('startup polling propagates fatal protocol errors after helper cleanup', async () => {
  let child;
  const helper = await controller(`console.log(JSON.stringify({ready:true}));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.state==='exit')process.exit(0);console.log(JSON.stringify(r.state==='inspect'?{id:999,value:true}:{id:r.id,value:true}));});`, { onSpawn: value => { child = value; } });
  await assert.rejects(waitForVisibleWindow(() => helper.request({ state: 'inspect' })), /Unexpected window helper response id/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
test('startup polling never starts a new request after its deadline', async t => {
  t.mock.method(performance, 'now', (() => {
    const times = [0, 0, 10000];
    return () => times.shift() ?? 10000;
  })());
  let requests = 0;
  await assert.rejects(waitForVisibleWindow(async () => { requests++; return { ready: false }; }), /within 10000ms/);
  assert.equal(requests, 1);
});
test('startup polling cancels its wait without starting another request', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(waitForVisibleWindow(async () => {
    requests++;
    setImmediate(() => controller.abort(Error('cancel startup wait')));
    return { ready: false };
  }, { signal: controller.signal }), error => error.message === 'cancel startup wait' || error.cause?.message === 'cancel startup wait');
  assert.equal(requests, 1);
});
for (const [name, code, options, pattern] of [
  ['malformed readiness', `console.log('not json');setInterval(()=>{},1000);`, {}, /JSON/],
  ['missing readiness', `setInterval(()=>{},1000);`, { startupTimeoutMs: 100 }, /startup timed out/],
  ['request timeout', `console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000);`, { requestTimeoutMs: 100 }, /request timed out/],
  ['invalid response object', `console.log('null');setInterval(()=>{},1000);`, {}, /Invalid window/],
  ['unexpected exit', `process.exit(7);`, {}, /exited 7/],
]) {
  test(`helper ${name} rejects and stops its child`, async () => {
    let child;
    await assert.rejects(controller(code, { closeTimeoutMs: 100, ...options, onSpawn: value => { child = value; } }), pattern);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned helper must exit before rejection returns');
  });
}
test('helper spawn failure rejects without hanging on an exit event', async () => {
  await assert.rejects(startWindowController({ command: 'dohc-no-such-helper-executable', startupTimeoutMs: 1000 }), /ENOENT/);
});
test('helper malformed response after readiness rejects the request and cleans up', async () => {
  let child;
  const helper = await controller(`let n=0;console.log(JSON.stringify({ready:true}));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.state==='exit')process.exit(0);console.log(++n===1?JSON.stringify({id:r.id,value:true}):'broken');});`, { onSpawn: value => { child = value; } });
  await assert.rejects(helper.request({ state: 'inspect' }), /JSON/);
  assert.notEqual(child.exitCode, null);
});

async function ownedNode(code) {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const exit = observeExit(child);
  const [data] = await once(child.stdout, 'data');
  return { child, exit, firstOutput: data.toString() };
}
test('launch before CDP cleans up the owned process and its child, preserving an unrelated process', async () => {
  const unrelated = await ownedNode(`console.log('ready');setInterval(()=>{},1000);`);
  const instance = await ownedNode(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);`);
  try {
    await assert.rejects(closeOwnedPackage(instance, 100), /before CDP/);
    assert.ok(instance.child.exitCode !== null || instance.child.signalCode !== null);
    const descendantPid = Number(instance.firstOutput.trim());
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    const deadline = performance.now() + 10_000;
    let descendantAlive = true;
    while (descendantAlive && performance.now() < deadline) {
      try { process.kill(descendantPid, 0); await delay(10); }
      catch (error) { if (error.code !== 'ESRCH') throw error; descendantAlive = false; }
    }
    assert.equal(descendantAlive, false, 'the recorded descendant must also exit');
    assert.equal(unrelated.child.exitCode, null);
    assert.equal(unrelated.child.signalCode, null);
  } finally {
    await closeOwnedPackage(instance, 100).catch(() => {});
    await closeOwnedPackage(unrelated, 100).catch(() => {});
  }
});
// The seed script's process ownership comes from scripts/verification/process.mjs, whose job and
// process-group behavior scripts/verification/process-group.test.mjs covers. This checks the
// script's own contract against a stand-in launcher.
test('chat seed script posts once, replies for the rest, reports the CLI thread id, and fails on a CLI error', async t => {
  // Canonical, so a symlinked temp directory (macOS /var is /private/var) matches the child's cwd.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dohc-seed-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = join(root, 'calls.jsonl');
  const launcher = join(root, 'fake-dohc.mjs');
  await writeFile(launcher, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd(), stateDir: process.env.DOHC_STATE_DIR }) + '\\n');
if (args[0] === '--json') console.log(JSON.stringify({ schemaVersion: 1, threadId: 'th_seeded', messageId: 'msg_0', title: args[5] }));
else if (args[3] === 'Message 3') { console.error('pipe closed'); process.exit(2); }
else console.log('replied th_seeded msg_' + args[3].slice(8));
`);
  const seedScript = resolve('tools/perf-profiling/seed-chat-cli.mjs');
  const seeded = spawnSync(process.execPath, [seedScript, launcher, 'Long history', '3'], { cwd: root, env: { ...process.env, DOHC_STATE_DIR: 'state-dir' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  const result = JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual([result.channel, result.title, result.cliThreadId, result.messages], ['general', 'Long history', 'th_seeded', 3]);
  assert.ok(Number.isFinite(result.seedingObservedMs));
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recorded.map(call => call.args), [['--json', 'chat', 'post', 'general', '--title', 'Long history', 'Message 0'], ['chat', 'reply', 'th_seeded', 'Message 1'], ['chat', 'reply', 'th_seeded', 'Message 2']]);
  assert.ok(recorded.every(call => call.stateDir === 'state-dir' && resolve(call.cwd) === resolve(root)), 'the workspace cwd and profile reach every CLI call');
  const failed = spawnSync(process.execPath, [seedScript, launcher, 'Long history', '5'], { cwd: root, env: process.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /pipe closed/);
  assert.match(spawnSync(process.execPath, [seedScript, launcher, 'Long history', '1'], { encoding: 'utf8', timeout: 60000 }).stderr, /usage/);
});
test('CDP shutdown timeout still stops its owned process', async () => {
  const instance = await ownedNode(`console.log('ready');setInterval(()=>{},1000);`);
  instance.browser = { newBrowserCDPSession: () => new Promise(() => {}) };
  await assert.rejects(closeOwnedPackage(instance, 100), /timed out/);
  assert.ok(instance.child.exitCode !== null || instance.child.signalCode !== null);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} rejects pending work and blocks later launches`, async () => {
  const priorExitCode = process.exitCode;
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const cancellation = benchmarkCancellation();
  let helperChild;
  const helper = await controller(protocol, { signal: cancellation.signal, onSpawn: child => { helperChild = child; } });
  let laterLaunches = 0;
  try {
    const pending = cancellation.run(() => new Promise(() => {}));
    process.emit(signal);
    await assert.rejects(pending, new RegExp(signal));
    await assert.rejects(cancellation.run(() => { laterLaunches++; }), new RegExp(signal));
    assert.equal(laterLaunches, 0);
    assert.equal(process.exitCode, signal === 'SIGINT' ? 130 : 143);
    await assert.rejects(helper.request({ state: 'ping' }), new RegExp(signal));
    assert.ok(helperChild.exitCode !== null || helperChild.signalCode !== null, 'abort must stop the helper before fallback cleanup');
  } finally {
    await helper.close();
    cancellation.dispose();
    process.exitCode = priorExitCode;
  }
  assert.ok(helperChild.exitCode !== null || helperChild.signalCode !== null);
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], listeners);
});

test('cancellation during helper readiness waits for cleanup before returning', async () => {
  const signal = new AbortController();
  let child;
  const startup = controller(`setInterval(()=>{},1000);`, { closeTimeoutMs: 100, signal: signal.signal, onSpawn: value => { child = value; } });
  signal.abort(Error('cancel readiness'));
  await assert.rejects(startup, /cancel readiness/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('summary keeps absent timing samples missing and labels diagnostic measurements', async () => {
  const rendererReadiness = { timeOrigin: 1005, observerInstalledMs: 12, alreadyReady: true, predicateMatchedMs: 12, secondAnimationFrameMs: 28 };
  const summary = await summarize({ label: 'baseline', status: 'failed', settings: { profileRenderer: true }, limits: ['16ms floor'], runs: [{
    index: 1, freshStartup: { startedAt: 1000, editablePaintObservedMs: 50, windowControlObservedMs: 4, rendererReadiness, renderer: { timeOrigin: 1005, paints: [{ name: 'first-paint', startTime: 8 }] } },
    typing: [{ name: 'small.md', supported: true, samples: [{ inputToNextPaintMs: null }, {}, { inputToNextPaintMs: 16 }], longTasks: [] }],
    switches: [{ phasesMs: { files: 3 } }, { phasesMs: {} }],
  }] }, async () => '[desktop] launch marks (ms since process start): ready 12');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.diagnostic, true);
  assert.deepEqual(summary.restartEditableObservedMs, { count: 0, p50: null, p95: null, max: null });
  assert.equal(summary.typing['small.md'].eventTimingUnreportedCount, 2);
  assert.equal(summary.typing['small.md'].inputToNextPaintReportedOnlyMs.count, 1);
  assert.equal(summary.typing['large.md'].eventTimingSupported, null);
  assert.equal(summary.nativeSwitchPhasesMs.files.count, 1);
  assert.equal(summary.startupEvidence[0].nativeMarksMsSinceModuleEvaluation.ready, 12);
  assert.equal(summary.startupEvidence[0].rendererPaintsMsSinceHarnessSpawn[0].ms, 13);
  assert.deepEqual(summary.startupEvidence[0].rendererReadiness, rendererReadiness);
  assert.equal(summary.freshEditableObservedMs.p50, 50);
  assert.deepEqual(summary.limits, ['16ms floor']);
  assert.deepEqual([summary.goTo, summary.commandPalette, summary.search, summary.chatHistory, summary.collection, summary.soak], [null, null, null, null, null, null]);
});

test('summary reports each surface scenario from its own runs and keeps unobserved samples missing', async () => {
  const open = (painted, optionCount) => ({ keydownToReadyMs: painted - 20, keydownToPaintedMs: painted, optionCount, observed: { entranceAnimating: true, matchedIn: 'frame' } });
  const sample = (cycle, renderer, main) => ({ cycle, completedAtMs: 1000 + cycle * 60000, processCount: 5, kinds: { renderer: { count: 1, workingSetBytes: renderer, privateBytes: renderer / 2 }, main: { count: 1, workingSetBytes: main, privateBytes: main / 2 } } });
  const summary = await summarize({ label: 'baseline', status: 'complete', settings: {}, limits: [], runs: [
    { index: 1, goTo: { query: 'fixture-004242', firstOption: 'fixture-004242.txt', cold: open(120, 50), warm: open(40, 50), keystrokes: [{ keydownToPaintedMs: 30, optionCount: 50 }, { keydownToPaintedMs: 18, optionCount: 1 }] },
      commandPalette: { cold: open(90, 12), warm: open(25, 12) },
      search: [{ query: 'fixture', open: { clickToPaintedMs: 70 }, submitToFirstResultMs: 200, submitToSettledMs: 1500, debounceFiredBeforeSubmit: true, sawUpdating: true, summary: '50 results in 50 files', limitHit: false, rowsRendered: 40 },
        { query: 'fixture 4242.', open: null, submitToFirstResultMs: null, submitToSettledMs: 300, debounceFiredBeforeSubmit: false, sawUpdating: false, summary: 'No results', limitHit: false, rowsRendered: 0 }],
      chatHistory: { seed: { messages: 200, seedingObservedMs: 90000 }, channelOpen: { clickToPostsPaintedMs: 150 }, threadOpen: { clickToFirstCommentPaintedMs: 400, clickToAllCommentsPaintedMs: null, commentRowsRendered: 120 } },
      collection: { records: 500, indexedWaitObservedMs: 800, clickToRowsPaintedMs: 210, rowsRendered: 24, loadedRecords: 100 },
      soak: { minutes: 2, searchQuery: 'Performance', elapsedMs: 120000, cycles: [{ durationMs: 50000 }, { durationMs: 55000 }], samples: [sample(0, 400, 100), sample(1, 450, 100), sample(2, 440, 110)] } },
    { index: 2, goTo: { query: 'fixture-004242', firstOption: 'fixture-004242.txt', cold: open(100, 50), warm: open(30, 50), keystrokes: [{ keydownToPaintedMs: 26, optionCount: 1 }] },
      chatHistory: { seed: { messages: 200, seedingObservedMs: 80000 }, channelOpen: { clickToPostsPaintedMs: 130 }, threadOpen: { clickToFirstCommentPaintedMs: 380, clickToAllCommentsPaintedMs: 900, commentRowsRendered: 199 } } },
  ] });
  assert.deepEqual(summary.goTo.query, ['fixture-004242']);
  assert.deepEqual(summary.goTo.coldOpenToEditableInputPaintedMs, { count: 2, p50: 100, p95: 120, max: 120 });
  assert.equal(summary.goTo.warmOpenToEditableInputPaintedMs.max, 40);
  assert.equal(summary.goTo.keystrokeToFirstMatchPaintedMs.count, 3);
  assert.deepEqual(summary.goTo.lastKeystrokeToFirstMatchPaintedMs, { count: 2, p50: 18, p95: 26, max: 26 });
  assert.deepEqual([summary.goTo.finalOptionCounts, summary.goTo.finalFirstOptions, summary.goTo.entranceAnimating, summary.goTo.openMatchedIn], [[1], ['fixture-004242.txt'], [true], ['frame']]);
  assert.deepEqual(summary.commandPalette, { coldOpenToFirstRowPaintedMs: { count: 1, p50: 90, p95: 90, max: 90 }, warmOpenToFirstRowPaintedMs: { count: 1, p50: 25, p95: 25, max: 25 }, optionCounts: [12], entranceAnimating: [true], openMatchedIn: ['frame'] });
  assert.equal(summary.search.fixture.openToInputPaintedMs.p50, 70);
  assert.deepEqual([summary.search.fixture.debounceFiredBeforeSubmitCount, summary.search.fixture.sawUpdatingCount], [1, 1]);
  assert.deepEqual(summary.search.fixture.limitHit, [false]);
  assert.deepEqual(summary.search['fixture 4242.'].submitToFirstResultPaintedMs, { count: 0, p50: null, p95: null, max: null });
  assert.equal(summary.search['fixture 4242.'].openToInputPaintedMs.count, 0);
  assert.deepEqual(summary.chatHistory.messages, [200]);
  assert.deepEqual(summary.chatHistory.channelOpenToPostsPaintedMs, { count: 2, p50: 130, p95: 150, max: 150 });
  assert.equal(summary.chatHistory.threadOpenToAllCommentsPaintedMs.count, 1);
  assert.equal(summary.chatHistory.allCommentsUnobservedCount, 1);
  assert.deepEqual(summary.chatHistory.commentRowsRendered, [120, 199]);
  assert.deepEqual(summary.collection, { records: [500], indexedWaitObservedMs: { count: 1, p50: 800, p95: 800, max: 800 }, openToRowsPaintedMs: { count: 1, p50: 210, p95: 210, max: 210 }, rowsRendered: [24], loadedRecords: [100] });
  assert.equal(summary.soak.length, 1);
  assert.deepEqual(summary.soak[0].kinds.renderer, { processCounts: [1], workingSetBytes: { first: 400, last: 440, max: 450, delta: 40 }, privateBytes: { first: 200, last: 220, max: 225, delta: 20 } });
  assert.deepEqual([summary.soak[0].cycles, summary.soak[0].elapsedMs, summary.soak[0].cycleDurationMs.max, summary.soak[0].searchQuery], [2, 120000, 55000, 'Performance']);
});

const loadYaml = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('js-yaml').load;
const caseNamed = (cases, name) => cases.find(spec => spec.name === name);

test('automation limits default to the current ones and belong to the collection scenario', () => {
  const collection = [...required, '--scenario', 'collection'];
  assert.deepEqual([parseOptions(collection).findCap, parseOptions(collection).writeCap], [DEFAULT_LIMITS.findCap, DEFAULT_LIMITS.writeCap]);
  assert.deepEqual([50, 200], [DEFAULT_LIMITS.findCap, DEFAULT_LIMITS.writeCap]);
  const candidate = parseOptions([...collection, '--find-cap', '500', '--write-cap', '1000']);
  assert.deepEqual([candidate.findCap, candidate.writeCap], [500, 1000]);
  for (const extra of [['--find-cap', '500'], ['--scenario', 'soak', '--write-cap', '10'], ['--scenario', 'collection', '--find-cap', '0'], ['--scenario', 'collection', '--write-cap', '1.5']]) {
    assert.throws(() => parseOptions([...required, ...extra]), JSON.stringify(extra));
  }
});

test('automation cases expect the package limits to refuse only the cases over them', () => {
  const cases = automationCases(DEFAULT_LIMITS);
  assert.deepEqual(cases.map(spec => [spec.name, spec.expected]), [['baseline', 'done'], ['find-500', 'refused'], ['five-finds', 'refused'], ['set-then-find', 'done'],
    ['add-then-find', 'done'], ['find-at-cap', 'done'], ['find-over-cap', 'refused'], ['wide', 'done'], ['baseline-typing', 'done'], ['find-500-typing', 'refused']]);
  assert.deepEqual(automationCases({ findCap: 500, writeCap: 1000 }).filter(spec => spec.expected === 'refused').map(spec => spec.name), ['find-over-cap']);
  assert.deepEqual(cases.map(spec => spec.seed.length), [50, 500, 300, 40, 10, 50, 51, 50, 50, 500]);
  assert.deepEqual(cases.filter(spec => spec.contention).map(spec => spec.name), ['baseline-typing', 'find-500-typing']);
  // Five Finds of 100 records each, so their 1,000 assignments count records in two Finds twice.
  const five = caseNamed(cases, 'five-finds');
  assert.deepEqual([1, 2, 3, 4, 5].map(k => five.seed.filter(record => record[`F${k}`]).length), [100, 100, 100, 100, 100]);
  assert.ok(five.seed.every(record => [1, 2].includes([1, 2, 3, 4, 5].filter(k => record[`F${k}`]).length)));
  assert.equal(five.steps.length, 10);
  const baseline = caseNamed(cases, 'baseline');
  assert.deepEqual(baseline.seed[0], { Name: 'baseline 1', Case: 'baseline', N: 1 });
  assert.equal(baseline.matches * Object.keys(baseline.steps[1].set).length, baseline.assignments);
});

test('automation fixtures are deterministic, sort the trigger first, and pre-mint unique ids', () => {
  const cases = automationCases(DEFAULT_LIMITS);
  const files = documentAutomationFiles(cases);
  assert.deepEqual(documentAutomationFiles(automationCases(DEFAULT_LIMITS)), files);
  assert.deepEqual(files.slice(0, 3).map(file => file.path), ['automation-bench/collection.yaml', 'automation-bench/automations.yaml', TRIGGER.document.path]);
  const records = files.filter(file => file.path.endsWith('.md'));
  assert.equal(records.length, 1 + cases.reduce((sum, spec) => sum + spec.seed.length, 0));
  assert.equal(records.map(file => file.path).sort()[0], TRIGGER.document.path);
  const ids = records.map(file => file.content.match(/^id: (\S+)$/m)[1]);
  assert.ok(ids.every(id => /^rec_[a-z2-7]{26}$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  const setup = datasetSetupRequest(cases, 'workspace');
  assert.deepEqual(datasetSetupRequest(automationCases(DEFAULT_LIMITS), 'workspace'), setup);
  const keys = setup.records.map(record => record[setup.idFieldId]);
  assert.equal(keys.length, records.length);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([keys[0], [...keys].sort()[0]], [TRIGGER.dataset.id, TRIGGER.dataset.id]);
  // The Explorer's Collections section lists a dataset by its table's name, which the harness clicks.
  assert.deepEqual(datasetAutomationDefinition(cases).tables.map(table => table.name), [DATASET_NAME]);
  assert.equal(automationFixtureDigest(cases), automationFixtureDigest(automationCases(DEFAULT_LIMITS)));
  // A case's digest changes only when its own records, steps, or expected outcome do.
  const candidate = automationCases({ findCap: 500, writeCap: 1000 });
  assert.equal(caseNamed(candidate, 'baseline').fixtureSha256, caseNamed(cases, 'baseline').fixtureSha256);
  for (const name of ['find-500', 'find-at-cap']) assert.notEqual(caseNamed(candidate, name).fixtureSha256, caseNamed(cases, name).fixtureSha256);
  assert.equal(new Set(cases.map(spec => spec.fixtureSha256)).size, cases.length);
  assert.notEqual(automationFixtureDigest(cases), automationFixtureDigest(automationCases({ findCap: 500, writeCap: 1000 })));
});

// The JS gate builds @dohc/app-backend-runtime before its tests; the executor's plan imports it.
test('automation fixtures pass the product contracts for automations, schemas, and datasets', () => {
  const tsx = pathToFileURL(createRequire(new URL('../../packages/cli/package.json', import.meta.url)).resolve('tsx')).href;
  const checked = spawnSync(process.execPath, ['--import', tsx, 'tools/perf-profiling/check-automation-fixtures.mts'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout.trim().split(/\r?\n/).at(-1)), { problems: [] });
});

test('document records read back from frontmatter and the verifier tells step visibility apart', async t => {
  const cases = automationCases(DEFAULT_LIMITS);
  const root = await mkdtemp(join(tmpdir(), 'dohc-automation-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'automation-bench'));
  for (const file of documentAutomationFiles(cases)) await writeFile(join(root, file.path), file.content);
  const staged = caseNamed(cases, 'set-then-find');
  const read = await readDocumentCase(root, staged, loadYaml);
  assert.equal(read.length, 40);
  // A case reads its own seeded files and the records its runs created, never another file.
  await writeFile(join(root, 'automation-bench', 'Added.md'), '---\nCase: "find-500"\nN: 501\n---\n');
  await writeFile(join(root, 'automation-bench', 'Other.md'), '---\nCase: "find-500"\nN: 502\n---\n');
  await writeFile(join(root, 'automation-bench', 'find-500-typing-0001.md'), '---\nCase: "find-500"\nN: 999\n---\n');
  const fiveHundred = caseNamed(cases, 'find-500');
  assert.deepEqual((await readDocumentCase(root, fiveHundred, loadYaml, ['automation-bench/Added.md'])).map(record => record.N).filter(n => n > 500), [501]);
  await rm(join(root, 'automation-bench', 'find-500-0001.md'));
  assert.deepEqual(verifyCase(fiveHundred, 'refused', await readDocumentCase(root, fiveHundred, loadYaml)).problems, ['N 1 is missing']);
  assert.deepEqual(verifyCase(staged, 'refused', read), { ok: true, visibility: null, problems: [], problemCount: 0 });
  assert.equal(documentValues('no frontmatter', loadYaml), null);
  for (const visibility of ['run-start', 'stepwise']) {
    const { records } = staged.expect(staged.seed, visibility);
    assert.deepEqual([verifyCase(staged, 'done', records).ok, verifyCase(staged, 'done', records).visibility], [true, visibility]);
  }
  const unchanged = verifyCase(staged, 'done', staged.seed);
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.problems[0], /^N 1 Stage is "stf-a", expected "stf-b"$/);
  const added = caseNamed(cases, 'add-then-find');
  const { records, added: [record] } = added.expect(added.seed, 'stepwise');
  assert.equal(verifyCase(added, 'done', [...records, record]).visibility, 'stepwise');
  assert.deepEqual(verifyCase(added, 'done', records).problems, ['N 11 is missing']);
  assert.deepEqual(verifyCase(added, 'refused', [...added.seed, record]).problems, ['N 11 was not expected']);
  assert.deepEqual(verifyCase(added, 'refused', [added.seed[0], ...added.seed]).problems, ['N 1 appears twice']);
  const wide = caseNamed(cases, 'wide');
  const problem = verifyCase(wide, 'done', wide.seed).problems[0];
  assert.ok(problem.startsWith('N 1 C is null, expected 2') || problem.includes('Notes'), problem);
  assert.ok(verifyCase(wide, 'done', wide.seed).problems.every(text => text.length < 140));
  assert.equal(wide.expect(wide.seed).records[0].Notes, WIDE_SET);
});

test('dataset rows map back to field names and a list asks for one case', () => {
  const cases = automationCases(DEFAULT_LIMITS);
  const setup = datasetSetupRequest(cases, 'workspace');
  const request = datasetListRequest({ datasetId: setup.definition.datasetId, revision: 3, revisionSha256: 'b'.repeat(64) }, 'workspace', 'wide');
  assert.deepEqual([request.mode, request.revision, request.filters.length, request.filters[0].value], ['list', 3, 1, 'wide']);
  assert.deepEqual([setup.datasetPath, request.datasetPath], ['automation-data/dataset.json', 'automation-data/dataset.json']);
  const [trigger, first] = setup.records;
  const { [setup.idFieldId]: id, ...values } = first;
  const row = datasetRowValues({ id, version: 1, values });
  assert.deepEqual(row, { Name: 'baseline 1', Case: 'baseline', N: 1, A: null, B: null, C: null, D: null, Stage: null, Seen: null, F1: null, F2: null, F3: null, F4: null, F5: null, Hit: null, Last: null, Notes: null });
  assert.equal(datasetRowValues({ values: trigger }).Name, 'Trigger');
});

test('settle text counts only a limit refusal as refused', () => {
  const failed = text => classifyOutcome({ outcome: 'failed', text });
  assert.equal(failed('find-500 did not finish. A Find matched more than 50 records. Narrow its condition, then try again.'), 'refused');
  assert.equal(failed('x did not finish. This run would change more than 200 fields. Narrow its Find steps.'), 'refused');
  assert.equal(failed('x did not finish. This run would change more data than dohc can save for it.'), 'refused');
  assert.equal(failed('x did not finish. dohc cannot find the Collection automation-bench.'), 'failed');
  assert.equal(failed(undefined), 'failed');
  assert.equal(classifyOutcome({ outcome: 'done', text: 'Ran x on Trigger' }), 'done');
  const baseline = outcomeTexts('baseline', 'Trigger');
  assert.deepEqual(baseline.done, ['Ran baseline on Trigger']);
  // A case's words never match another case's settle text.
  const typing = Object.values(outcomeTexts('baseline-typing', 'Trigger')).flat();
  assert.ok(Object.values(baseline).flat().every(phrase => typing.every(text => !text.includes(phrase))));
});

test('run journal reads saved headers and progress, and a refused run leaves none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dohc-automation-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const automation = automationOf('document', 'baseline');
  assert.deepEqual(automation, { collectionPath: 'automation-bench', name: 'bench-baseline' });
  assert.deepEqual(await readRunJournal(root, automation), []);
  assert.deepEqual(await journalBytes(root, automation), { headerBytes: 0, progressBytes: 0 });
  // The engine names the Collection by an object id, so the folder and id come from the saved header.
  const runs = join(root, '.dohc', 'automations', 'runs');
  const elsewhere = join(runs, 'f0');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, 'run-x.json'), JSON.stringify({ automationId: 'collection:object-b#bench-baseline', collections: [{ collectionId: 'object-b', path: 'automation-data' }] }));
  // A header caught mid-rewrite reads as partial JSON; the lookup skips it instead of stopping the run.
  await writeFile(join(elsewhere, 'run-partial.json'), '{"automationId": "collection:obj');
  assert.deepEqual(await journalBytes(root, automation), { headerBytes: 0, progressBytes: 0 });
  const folder = join(runs, 'f1');
  await mkdir(folder, { recursive: true });
  const automationId = 'collection:object-a#bench-baseline';
  const header = JSON.stringify({ version: 2, claimId: 'c1', automationId, collections: [{ collectionId: 'object-a', path: 'automation-bench' }], startedAtMs: 1000, finishedAtMs: 1600, plan: null, outcome: { state: 'done' } });
  const progress = [{ kind: 'created', ordinal: 0, recordId: 'r', path: 'p' },
    { kind: 'effect', ordinal: 1, writes: [{ kind: 'field', field: 'A' }, { kind: 'field', field: 'B' }, { kind: 'created', recordId: 'r', path: 'p' }] },
    { kind: 'effect', ordinal: 2, writes: [{ kind: 'dataset-edit', fields: [{}, {}, {}] }, { kind: 'dataset-created' }] }].map(line => `${JSON.stringify(line)}\n`).join('');
  await writeFile(join(folder, 'run-c1.json'), header);
  await writeFile(join(folder, 'run-c1.progress.jsonl'), progress);
  await writeFile(join(folder, 'other.json'), JSON.stringify({ automationId: 'collection:elsewhere#x', startedAtMs: 0 }));
  const [run, ...others] = await readRunJournal(root, automation);
  assert.deepEqual(others, []);
  assert.deepEqual(run, { claimId: 'c1', startedAtMs: 1000, finishedAtMs: 1600, outcome: { state: 'done' }, headerBytes: Buffer.byteLength(header),
    progressBytes: Buffer.byteLength(progress), progressLines: 3, fieldWrites: 5, created: 2, createdPaths: ['p'] });
  const bytes = await journalBytes(root, automation);
  assert.equal(bytes.progressBytes, Buffer.byteLength(progress));
  assert.ok(bytes.headerBytes > Buffer.byteLength(header));
});

const proc = (pid, name, cpuMs, workingSetBytes = 0, commandLine = 'dohc.exe') => ({ pid, name, commandLine, createdAt: `t${pid}`, cpuMs, workingSetBytes, privateBytes: workingSetBytes / 2 });
test('process accounting splits CPU and peaks by kind', () => {
  const before = { completedAtMs: 1000, processes: [proc(1, 'dohc.exe', 100, 10), proc(2, 'dohc-workspace-engine.exe', 50, 20), proc(3, 'dohc.exe', 10, 30, 'dohc.exe --type=renderer'), proc(9, 'dohc.exe', 5, 1, 'dohc.exe --type=utility')] };
  const after = { completedAtMs: 3000, processes: [proc(1, 'dohc.exe', 130, 40), proc(2, 'dohc-workspace-engine.exe', 80, 10), proc(3, 'dohc.exe', 60, 30, 'dohc.exe --type=renderer'), proc(4, 'dohc.exe', 7, 5, 'dohc.exe --type=renderer')] };
  assert.deepEqual(cpuByKind(before, after, 1), { main: 30, engine: 30, renderer: 57 });
  assert.equal(busyShare(before, after, 1), 60 / 2000);
  assert.deepEqual(peakByKind([before, after], 1), { main: { workingSetBytes: 40, privateBytes: 20 }, engine: { workingSetBytes: 20, privateBytes: 10 },
    renderer: { workingSetBytes: 35, privateBytes: 17.5 }, utility: { workingSetBytes: 1, privateBytes: 0.5 } });
});

test('quiet wait needs consecutive quiet intervals and gives up at its deadline', async () => {
  let at = 0;
  const snapshotAt = cpuMs => ({ completedAtMs: (at += 1000), processes: [proc(1, 'dohc.exe', cpuMs)] });
  const cumulative = [0, 500, 500, 1300, 1300, 1300, 1300];
  const samples = [];
  const quiet = await waitForQuiet({ appPid: 1, sample: async () => { const next = snapshotAt(cumulative[samples.length]); samples.push(next); return next; } });
  // Busy, quiet, busy, quiet, quiet, quiet: the third quiet interval in a row ends the wait.
  assert.equal(samples.length, 7);
  assert.equal(quiet.snapshot, samples[6]);
  assert.equal(quiet.busyShare, 0);
  let cpu = 0;
  await assert.rejects(waitForQuiet({ appPid: 1, timeoutMs: 50, sample: async () => snapshotAt((cpu += 1000)) }), /did not settle within 50ms: main and engine used 100% of a core/);
  const controller = new AbortController();
  controller.abort(Error('stop waiting'));
  await assert.rejects(waitForQuiet({ appPid: 1, signal: controller.signal, sample: async () => snapshotAt((cpu += 1000)) }), /stop waiting/);
});

const automationHtml = '<main><button aria-label="baseline for Trigger"><span>baseline</span></button><button aria-label="other for Trigger">other</button><div id="cells"></div><div data-testid="notice-toasts" id="toasts"></div></main>';
test('automation observer times a press on its own button to the painted settle text', async t => {
  const p = fakePage(t, automationHtml);
  const toasts = p.document.getElementById('toasts');
  const pending = p.run(observeAutomationRun, { button: 'baseline for Trigger', texts: outcomeTexts('baseline', 'Trigger'), timeoutMs: 1000 });
  const press = selector => p.document.querySelector(selector).dispatchEvent(new p.window.MouseEvent('mousedown', { bubbles: true }));
  toasts.insertAdjacentHTML('beforeend', '<div>Ran baseline on Trigger</div>');
  await mutations();
  press('[aria-label="other for Trigger"]');
  toasts.insertAdjacentHTML('beforeend', '<div>Ran baseline on Trigger</div>');
  await mutations();
  assert.equal(p.frames.size, 0, 'text before the press, or after a press on another button, is not this run');
  p.step();
  press('[aria-label="baseline for Trigger"] span');
  p.step();
  // Text outside the toast stack and Notices, such as a table cell, is not a settle.
  p.document.getElementById('cells').insertAdjacentHTML('beforeend', '<div>Ran baseline on Trigger</div>');
  await mutations();
  assert.equal(p.frames.size, 0);
  toasts.insertAdjacentHTML('beforeend', '<div role="status">Ran baseline on Trigger</div>');
  await mutations();
  p.frame();
  const observed = await pending;
  assert.deepEqual([observed.outcome, observed.text, observed.triggerMs, observed.matchedMs, observed.paintedMs, observed.triggerTrusted], ['done', 'Ran baseline on Trigger', 60, 110, 126, false]);
  assert.equal(observed.installedMs, 10);
  assert.ok(Number.isFinite(observed.installedEpochMs));
  assert.equal(observed.longTasks.length, 0);
  assert.equal(p.frames.size + p.timers.size, 0);
});

test('automation observer reads changed text and rejects a run that never settles', async t => {
  const p = fakePage(t, `${automationHtml}<div data-testid="notice-center"><p id="notice">Waiting</p></div>`);
  const pending = p.run(observeAutomationRun, { button: 'baseline for Trigger', texts: outcomeTexts('baseline', 'Trigger'), timeoutMs: 1000 });
  p.document.querySelector('[aria-label="baseline for Trigger"]').dispatchEvent(new p.window.MouseEvent('mousedown', { bubbles: true }));
  p.document.getElementById('notice').firstChild.data = 'baseline did not finish. A Find matched more than 50 records.';
  await mutations();
  p.frame();
  const failed = await pending;
  assert.deepEqual([failed.outcome, classifyOutcome(failed)], ['failed', 'refused']);
  const silent = p.run(observeAutomationRun, { button: 'baseline for Trigger', texts: outcomeTexts('baseline', 'Trigger'), timeoutMs: 120 });
  const rejected = assert.rejects(silent, /baseline for Trigger did not settle within 120ms/);
  p.step(); p.step(); p.step();
  await rejected;
  assert.equal(p.frames.size + p.timers.size, 0);
});

test('summary reports automation cases per kind and keeps missing measurements missing', async () => {
  const sample = (start, inputToNextPaintMs) => ({ start, dispatchToTwoRafMs: 20, inputToNextPaintMs });
  const row = (name, fields) => ({ name, expected: 'done', outcome: 'done', pass: true, visibility: null, verification: { ok: true, settledOnDiskObservedMs: 300 },
    triggerToSettledPaintedMs: 900, startMs: 400, runMs: 450, journal: { headerPeakBytesSampled: 8000, runs: [{ headerBytes: 700, progressBytes: 5000, fieldWrites: 200, created: 0 }] },
    cpuMs: { main: 300, engine: 200, renderer: 50 }, peakBytes: { main: { privateBytes: 1e8 } }, longTasks: [{ duration: 60 }, { duration: 80 }], typing: null, ...fields });
  const refused = row('find-500', { expected: 'refused', outcome: 'refused', startMs: null, runMs: null, journal: { headerPeakBytesSampled: 0, runs: [] } });
  const summary = await summarize({ label: 'baseline', status: 'failed', settings: {}, limits: [], runs: [
    { index: 1, collectionAutomations: { findCap: 50, writeCap: 200, fixtureSha256: 'f', document: { cases: [row('baseline'), refused] },
      dataset: { cases: [row('baseline-typing', { pass: false, typing: { samplesDuringRun: 2, samples: [sample(1, 24), sample(2, null), sample(3, 99)] } })] } } },
    { index: 2 },
  ] });
  const automations = summary.collectionAutomations;
  assert.deepEqual([automations.findCap, automations.writeCap, automations.fixtureSha256], [[50], [200], ['f']]);
  assert.deepEqual(automations.document.baseline.triggerToSettledPaintedMs, { count: 1, p50: 900, p95: 900, max: 900 });
  assert.deepEqual([automations.document.baseline.longTaskCount.max, automations.document.baseline.longTaskTotalMs.max, automations.document.baseline.fieldWrites], [2, 140, [200]]);
  assert.deepEqual(automations.document['find-500'].startMs, { count: 0, p50: null, p95: null, max: null });
  assert.deepEqual([automations.document['find-500'].outcomes, automations.document['find-500'].fieldWrites, automations.document['find-500'].runMs.count], [['refused'], [], 0]);
  assert.deepEqual([automations.dataset['baseline-typing'].failures, automations.dataset['baseline-typing'].typingDuringRun.samplesDuringRun], [1, 2]);
  assert.deepEqual(automations.dataset['baseline-typing'].typingDuringRun.inputToNextPaintReportedOnlyMs, { count: 1, p50: 24, p95: 24, max: 24 });
  assert.equal(automations.document.baseline.typingDuringRun, null);
  assert.equal((await summarize({ label: 'baseline', status: 'complete', settings: {}, limits: [], runs: [{ index: 1 }] })).collectionAutomations, null);
});

// A fake executeCli: it records each call and answers as the desktop CLI server does.
const fakeCli = calls => `import { appendFileSync } from 'node:fs';
const ok = body => ({ exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, ...body }), stderr: '' });
export async function executeCli({ argv }) {
  const [, , verb, text] = argv;
  const body = JSON.parse(text);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: argv.slice(0, 3), body, cwd: process.cwd(), stateDir: process.env.DOHC_STATE_DIR }) + '\\n');
  if (verb === 'create') return ok({ kind: 'approved', revision: { datasetId: body.definition.datasetId, revision: 1, revisionSha256: 'a'.repeat(64) } });
  if (body.input.values) {
    if (body.input.values.key === 'refuse') return ok({ kind: 'refused', code: 'not_unique', message: 'A record already uses this value.' });
    if (body.input.values.key === 'fail') return { exitCode: 1, stdout: '', stderr: 'dohc: the app did not answer' };
    return ok({ kind: 'invoked', result: { id: body.input.values.key, version: 1 }, revision: 2, replayed: false });
  }
  return ok({ kind: 'invoked', result: body.input.after ? { rows: [{ id: 'b' }], nextCursor: null } : { rows: [{ id: 'a' }], nextCursor: { id: 'a', value: 'a' } }, revision: 2, replayed: false });
}
`;
test('dataset CLI script creates, seeds, and lists through executeCli, and fails on a CLI error', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dohc-dataset-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = join(root, 'calls.jsonl');
  const cliModule = join(root, 'fake-cli.mjs');
  await writeFile(cliModule, fakeCli(calls));
  const script = resolve('tools/perf-profiling/dataset-cli.mjs');
  const request = async (name, body) => { const path = join(root, `${name}.json`); await writeFile(path, JSON.stringify({ cliModule, workspaceId: 'w', ...body })); return path; };
  const runScript = path => spawnSync(process.execPath, [script, path], { cwd: root, env: { ...process.env, DOHC_STATE_DIR: 'profile' }, encoding: 'utf8', timeout: 60_000 });
  const setup = runScript(await request('setup', { mode: 'setup', datasetPath: 'data/dataset.json', definition: { datasetId: 'd' }, createOperationId: 'create', idFieldId: 'key', records: [{ key: 'one' }, { key: 'two' }] }));
  assert.equal(setup.status, 0, setup.stderr);
  const seeded = JSON.parse(setup.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual([seeded.datasetId, seeded.revision, seeded.revisionSha256, seeded.records], ['d', 1, 'a'.repeat(64), 2]);
  assert.ok(Number.isFinite(seeded.seedingObservedMs));
  const listed = runScript(await request('list', { mode: 'list', datasetPath: 'data/dataset.json', datasetId: 'd', revision: 1, revisionSha256: 'a'.repeat(64), operationId: 'list', filters: [{ fieldId: 'case', value: 'x' }] }));
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout.trim()), { rows: [{ id: 'a' }, { id: 'b' }] });
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recorded.map(call => call.argv), [...Array(5)].map((_, index) => ['--json', 'dataset', index === 0 ? 'create' : 'invoke']));
  assert.deepEqual(recorded.slice(1, 3).map(call => [call.body.idempotencyKey, call.body.operationId, call.body.revision]), [['seed:one', 'create', 1], ['seed:two', 'create', 1]]);
  const [first, second] = recorded.slice(3).map(call => call.body);
  assert.deepEqual([first.input, second.input.after], [{ limit: 100, filters: [{ fieldId: 'case', value: 'x' }] }, { id: 'a', value: 'a' }]);
  assert.match(first.idempotencyKey, /^list:[0-9a-f-]{36}:0$/);
  assert.equal(second.idempotencyKey, first.idempotencyKey.replace(/0$/, '1'));
  assert.ok(recorded.every(call => call.stateDir === 'profile' && resolve(call.cwd) === resolve(root)));
  // The CLI names a dataset by its dataset.json path and refuses a body that still carries datasetId.
  assert.ok(recorded.slice(1).every(call => call.body.datasetPath === 'data/dataset.json' && call.body.expectedDatasetId === 'd' && !('datasetId' in call.body)));
  for (const [key, message] of [['refuse', /refused: not_unique/], ['fail', /the app did not answer/]]) {
    const failed = runScript(await request(key, { mode: 'setup', definition: { datasetId: 'd' }, createOperationId: 'create', idFieldId: 'key', records: [{ key }] }));
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, message);
  }
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 }).status, 2);
});

test('dataset CLI runs in an owned job that stops what it started when it fails', { skip: process.platform !== 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dohc-dataset-owned-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'descendant.pid');
  const cliModule = join(root, 'fake-cli.mjs');
  // The CLI starts a process that outlives it, then fails, as a crashed CLI worker would leave one.
  await writeFile(cliModule, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
export async function executeCli() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  child.unref();
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  return { exitCode: 1, stdout: '', stderr: 'dohc: failed after starting a worker' };
}
`);
  const requestPath = join(root, 'setup.json');
  await writeFile(requestPath, JSON.stringify({ cliModule, workspaceId: 'w', mode: 'setup', definition: {}, records: [] }));
  await assert.rejects(runOwnedCommand(process.execPath, [resolve('tools/perf-profiling/dataset-cli.mjs'), requestPath], { cwd: root, timeoutMs: 60_000, quietStdout: true, log: join(root, 'setup.log') }), /failed \(1\)/);
  const descendant = Number(await readFile(pidFile, 'utf8'));
  const deadline = performance.now() + 30_000;
  let alive = true;
  while (alive && performance.now() < deadline) {
    try { process.kill(descendant, 0); await delay(50); }
    catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
  }
  assert.equal(alive, false, 'the job must stop the process the CLI started');
});

const receipt = ({ status = 'complete', open = [100, 110, 120], typed = [20, 22, 24], settled = [800, 900, 1000], fixture = 'f1', failures = 0, findCap = 50 } = {}) => ({
  label: 'baseline', status, settings: { scenario: 'collection', runCount: 3, keystrokes: 30, fixtureFiles: 2, records: 500, findCap, writeCap: 200 }, limits: [],
  runs: open.map((openMs, index) => ({ index: index + 1,
    collection: { records: 500, indexedWaitObservedMs: 10, clickToRowsPaintedMs: openMs, rowsRendered: 20, loadedRecords: 100 },
    typing: [{ name: 'small.md', supported: true, longTasks: [], samples: [{ dispatchToTwoRafMs: typed[index], inputToNextPaintMs: null }] }],
    collectionAutomations: { findCap, writeCap: 200, fixtureSha256: 'all', dataset: { cases: [] }, document: { cases: [
      { name: 'baseline', fixtureSha256: fixture, expected: 'done', outcome: 'done', pass: index >= failures, verification: { ok: true }, triggerToSettledPaintedMs: settled[index], longTasks: [],
        typing: { samplesDuringRun: 1, samples: [{ dispatchToTwoRafMs: typed[index] }] } },
    ] } } })),
});
const compared = async (baseline, candidate, margin) => compareSummaries(await summarize(receipt(baseline)), await summarize(receipt(candidate)), margin);

test('comparison passes within the margin and fails a p95 past it', async () => {
  assert.deepEqual(DEFAULT_MARGIN, { percent: 10, floorMs: 17 });
  const same = await compared({}, {});
  assert.equal(same.pass, true, same.problems.join('; '));
  assert.deepEqual(same.checks.map(check => [check.metric, check.verdict]), [['collection open to rows painted', 'pass'], ['typing small.md dispatch to two frames', 'pass'],
    ['typing large.md dispatch to two frames', 'unmeasured'], ['document baseline press to settled', 'pass'], ['document baseline typing during the run', 'pass']]);
  // 1,000 ms plus 10% allows 1,100; 24 ms plus the 17 ms floor allows 41.
  assert.equal((await compared({}, { settled: [800, 900, 1100] })).pass, true);
  const slower = await compared({}, { settled: [800, 900, 1101], typed: [20, 22, 42] });
  assert.equal(slower.pass, false);
  assert.deepEqual(slower.problems, ['typing small.md dispatch to two frames: regressed', 'document baseline press to settled: regressed', 'document baseline typing during the run: regressed']);
  assert.equal((await compared({}, { settled: [800, 900, 1101] }, { percent: 20, floorMs: 17 })).pass, true);
  assert.deepEqual((await compared({}, { open: [100, 110, 138] })).problems, ['collection open to rows painted: regressed']);
});

test('comparison checks a case whose fixture changed only within the candidate, and refuses mismatched receipts', async () => {
  const other = await compared({}, { fixture: 'f2', settled: [5000, 6000, 7000], findCap: 500 });
  assert.equal(other.pass, true, other.problems.join('; '));
  assert.deepEqual(other.cases, [{ kind: 'document', name: 'baseline', compared: false, outcomes: ['done'] }]);
  assert.equal(other.checks.some(check => check.metric.startsWith('document baseline')), false);
  const failed = await compared({}, { fixture: 'f2', failures: 1, status: 'failed' });
  assert.deepEqual(failed.problems, ['The candidate receipt is failed, not complete.', "The candidate's document baseline case failed its checks in 1 of 3 runs."]);
  const baseline = await summarize(receipt());
  const candidate = await summarize(receipt());
  candidate.settings = { ...candidate.settings, keystrokes: 10 };
  delete candidate.collectionAutomations.document.baseline;
  candidate.typing['small.md'].dispatchToTwoRafObservedMs = { count: 0, p50: null, p95: null, max: null };
  assert.deepEqual(compareSummaries(baseline, candidate).problems, ['The receipts differ in keystrokes.', 'typing small.md dispatch to two frames: missing', 'document baseline: missing']);
  // A receipt from before per-case digests cannot pass as comparable.
  const old = receipt({ settled: [5000, 6000, 7000] });
  for (const run of old.runs) delete run.collectionAutomations.document.cases[0].fixtureSha256;
  const undigested = await summarize(old);
  assert.deepEqual(compareSummaries(undigested, await summarize(receipt())).problems, ['The document baseline case has no single fixture digest in both receipts.']);
});
