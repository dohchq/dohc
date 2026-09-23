import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOptions, createEvidenceDirectory, benchmarkEnvironment, packagedLaunchArgs } from './packaged-benchmark-options.mjs';
import { startWindowController, waitForVisibleWindow } from './window-controller.mjs';
import { closeOwnedPackage, observeExit, benchmarkCancellation, verifyRestartInput } from './packaged-process.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';
import { createRequire } from 'node:module';
import { observeStartupReadiness, startupTargetFromRegistry } from './startup-readiness.mjs';
import { observeSurface, observeSearchSubmit, seededPostThreadId, collectionFixtureFiles, recordId, classifyProcess, aggregateByKind } from './packaged-surfaces.mjs';

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
test('surface observer times a keydown-triggered palette to its focused input and two frames', async t => {
  const p = fakePage(t, '<main></main>');
  const pending = p.run(observeSurface, { trigger: 'keydown', triggerKey: 'p', target: '[data-testid="quick-open"] input', focused: '[data-testid="quick-open"] input', countSelector: '[role="option"]', timeoutMs: 1000 });
  p.step();
  p.keydown(p.document.body, 'Control');
  p.document.body.insertAdjacentHTML('beforeend', paletteHtml);
  p.document.querySelector('input').focus();
  await mutations(); p.step();
  assert.equal(p.frames.size, 0, 'a surface present before the trigger is not a match');
  p.keydown(p.document.body, 'p');
  p.step();
  assert.equal(p.frames.size, 1);
  p.frame(); p.frame();
  const observed = await pending;
  assert.equal(observed.triggerMs, 110);
  assert.equal(observed.triggerTrusted, false);
  assert.equal(observed.matchedMs, 160);
  assert.equal(observed.paintedMs, 192);
  assert.equal(observed.count, 2);
  assert.equal(observed.matchedCount, 1);
  assert.equal(p.frames.size + p.timers.size, 0);
});
test('surface observer waits for the typed value, a blurred input, and enough rows', async t => {
  const p = fakePage(t, paletteHtml);
  const input = p.document.querySelector('input');
  input.focus();
  const typed = p.run(observeSurface, { trigger: 'keydown', triggerKey: 'x', target: 'input', value: 'x', focused: 'input', timeoutMs: 1000 });
  p.keydown(input, 'x');
  p.step();
  assert.equal(p.frames.size, 0, 'the keystroke has not reached the input value yet');
  input.value = 'x';
  input.blur();
  p.step();
  assert.equal(p.frames.size, 0, 'focus left the input');
  input.focus();
  p.step(); p.frame(); p.frame();
  assert.equal((await typed).text, '');
  const rows = p.run(observeSurface, { target: '[role="option"]', minCount: 3, timeoutMs: 1000 });
  p.step();
  assert.equal(p.frames.size, 0);
  p.document.querySelector('ul').insertAdjacentHTML('beforeend', '<li role="option">c.md</li>');
  await mutations();
  assert.equal(p.frames.size, 1, 'the mutation observer matched without waiting for the poll');
  p.frame(); p.frame();
  const observed = await rows;
  assert.equal(observed.triggerMs, null);
  assert.equal(observed.count, 3);
  assert.equal(observed.text, 'a.md');
});
test('surface observer records a mousedown trigger and rejects unknown triggers and timeouts', async t => {
  const p = fakePage(t, '<button>Open</button>');
  await assert.rejects(p.run(observeSurface, { trigger: 'hover', target: 'button' }), /Unknown trigger/);
  const clicked = p.run(observeSurface, { trigger: 'click', target: '[data-testid="collection-page"] [role="row"]', timeoutMs: 1000 });
  p.document.querySelector('button').dispatchEvent(new p.window.MouseEvent('mousedown', { bubbles: true }));
  p.document.body.insertAdjacentHTML('beforeend', '<div data-testid="collection-page"><div role="row" data-index="0">Record 1</div></div>');
  await mutations(); p.frame(); p.frame();
  assert.equal((await clicked).triggerMs, 10);
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
  p.step();
  p.keydown(p.document.body, 'Enter');
  assert.equal(p.now(), 60);
  p.keydown(input, 'Enter');
  view.dataset.searchId = 's1'; view.dataset.state = 'searching';
  view.querySelector('ul').innerHTML = '<li data-testid="search-result-row">hit</li>';
  await mutations(); p.frame();
  view.dataset.state = 'complete';
  view.insertAdjacentHTML('beforeend', '<span data-testid="search-summary">1 result in 1 file</span>');
  await mutations(); p.frame(); p.frame();
  const observed = await pending;
  assert.equal(observed.submitMs, 60);
  assert.equal(observed.submitTrusted, false);
  assert.equal(observed.debounceFiredBeforeSubmit, false);
  assert.equal(observed.firstResultMs, 60);
  assert.equal(observed.firstResultPaintedMs, 92);
  assert.equal(observed.settledMs, 76);
  assert.equal(observed.settledPaintedMs, 108);
  assert.deepEqual([observed.rowsRendered, observed.summary, observed.limitHit, observed.emptyState, observed.searchIdChanges], [1, '1 result in 1 file', false, false, 0]);
  assert.equal(p.frames.size + p.timers.size, 0);
});
test('search observer flags a debounce that ran before Enter and keeps a missing first result missing', async t => {
  const p = fakePage(t, searchHtml);
  const view = p.document.querySelector('[data-testid="search-view"]');
  const pending = p.run(observeSearchSubmit, { timeoutMs: 1000 });
  view.dataset.searchId = 'typed'; view.dataset.state = 'complete';
  await mutations();
  p.keydown(p.document.querySelector('input'), 'Enter');
  view.dataset.searchId = 's2';
  view.insertAdjacentHTML('beforeend', '<div data-testid="search-empty-state">No results found</div>');
  await mutations(); p.frame(); p.frame();
  const observed = await pending;
  assert.equal(observed.debounceFiredBeforeSubmit, true);
  assert.equal(observed.firstResultMs, null);
  assert.equal(observed.emptyState, true);
  assert.equal(observed.rowsRendered, 0);
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
  assert.match(files[0].content, /^name: Records\nfields:\n {2}Name:\n {4}type: text\n/);
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
  ]) assert.throws(() => parseOptions([...required, ...extra]), JSON.stringify(extra));
  assert.throws(() => parseOptions(required.filter((_, i) => i !== 2 && i !== 3)), /package-commit/);
});
test('surface scenarios parse with their own sizes and defaults', () => {
  for (const scenario of ['go-to', 'command-palette', 'search', 'chat-history', 'collection', 'soak']) {
    const options = parseOptions([...required, '--scenario', scenario]);
    assert.deepEqual([options.scenario, options.soakMinutes, options.chatMessages, options.records], [scenario, 10, 200, 500]);
  }
  assert.equal(parseOptions([...required, '--scenario', 'soak', '--soak-minutes', '3', '--profile-renderer', 'true']).soakMinutes, 3);
  assert.equal(parseOptions([...required, '--scenario', 'chat-history', '--chat-messages', '2']).chatMessages, 2);
  assert.equal(parseOptions([...required, '--scenario', 'collection', '--records', '1', '--files', '5000']).records, 1);
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
    '--binary', join(root, 'missing.exe'), '--package-commit', 'a'.repeat(40), '--output', output, '--label', 'baseline'], { encoding: 'utf8', timeout: 10000 });
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
function controller(code, options = {}) {
  return startWindowController({ command: process.execPath, args: ['-e', fixture(code)], startupTimeoutMs: 5000, requestTimeoutMs: 1000, closeTimeoutMs: 100, ...options });
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
    await assert.rejects(controller(code, { ...options, onSpawn: value => { child = value; } }), pattern);
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
    const deadline = performance.now() + 3000;
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
  const startup = controller(`setInterval(()=>{},1000);`, { signal: signal.signal, onSpawn: value => { child = value; } });
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
  const open = (painted, optionCount) => ({ keydownToReadyMs: painted - 20, keydownToPaintedMs: painted, optionCount });
  const sample = (cycle, renderer, main) => ({ cycle, completedAtMs: 1000 + cycle * 60000, processCount: 5, kinds: { renderer: { count: 1, workingSetBytes: renderer, privateBytes: renderer / 2 }, main: { count: 1, workingSetBytes: main, privateBytes: main / 2 } } });
  const summary = await summarize({ label: 'baseline', status: 'complete', settings: {}, limits: [], runs: [
    { index: 1, goTo: { query: 'fixture-004242', cold: open(120, 50), warm: open(40, 50), keystrokes: [{ keydownToPaintedMs: 30, optionCount: 50 }, { keydownToPaintedMs: 18, optionCount: 1 }] },
      commandPalette: { cold: open(90, 12), warm: open(25, 12) },
      search: [{ query: 'fixture', open: { clickToPaintedMs: 70 }, submitToFirstResultMs: 200, submitToSettledMs: 1500, debounceFiredBeforeSubmit: true, summary: '2000 results in 2000 files', limitHit: true, rowsRendered: 40 },
        { query: 'fixture 4242.', open: null, submitToFirstResultMs: null, submitToSettledMs: 300, debounceFiredBeforeSubmit: false, summary: 'No results', limitHit: false, rowsRendered: 0 }],
      chatHistory: { seed: { messages: 200, seedingObservedMs: 90000 }, channelOpen: { clickToPostsPaintedMs: 150 }, threadOpen: { clickToFirstCommentPaintedMs: 400, clickToAllCommentsPaintedMs: null, commentRowsRendered: 120 } },
      collection: { records: 500, indexedWaitObservedMs: 800, clickToRowsPaintedMs: 210, rowsRendered: 24, loadedRecords: 100 },
      soak: { minutes: 2, elapsedMs: 120000, cycles: [{ durationMs: 50000 }, { durationMs: 55000 }], samples: [sample(0, 400, 100), sample(1, 450, 100), sample(2, 440, 110)] } },
    { index: 2, goTo: { query: 'fixture-004242', cold: open(100, 50), warm: open(30, 50), keystrokes: [{ keydownToPaintedMs: 26, optionCount: 1 }] },
      chatHistory: { seed: { messages: 200, seedingObservedMs: 80000 }, channelOpen: { clickToPostsPaintedMs: 130 }, threadOpen: { clickToFirstCommentPaintedMs: 380, clickToAllCommentsPaintedMs: 900, commentRowsRendered: 199 } } },
  ] });
  assert.deepEqual(summary.goTo.query, ['fixture-004242']);
  assert.deepEqual(summary.goTo.coldOpenToEditableInputMs, { count: 2, p50: 100, p95: 120, max: 120 });
  assert.equal(summary.goTo.warmOpenToEditableInputMs.max, 40);
  assert.equal(summary.goTo.keystrokeToResultsPaintedMs.count, 3);
  assert.deepEqual(summary.goTo.lastKeystrokeToResultsPaintedMs, { count: 2, p50: 18, p95: 26, max: 26 });
  assert.deepEqual(summary.goTo.finalOptionCounts, [1]);
  assert.deepEqual(summary.commandPalette, { coldOpenToFirstRowMs: { count: 1, p50: 90, p95: 90, max: 90 }, warmOpenToFirstRowMs: { count: 1, p50: 25, p95: 25, max: 25 }, optionCounts: [12] });
  assert.equal(summary.search.fixture.openToInputFocusedMs.p50, 70);
  assert.equal(summary.search.fixture.debounceFiredBeforeSubmitCount, 1);
  assert.deepEqual(summary.search.fixture.limitHit, [true]);
  assert.deepEqual(summary.search['fixture 4242.'].submitToFirstResultMs, { count: 0, p50: null, p95: null, max: null });
  assert.equal(summary.search['fixture 4242.'].openToInputFocusedMs.count, 0);
  assert.deepEqual(summary.chatHistory.messages, [200]);
  assert.equal(summary.chatHistory.threadOpenToAllCommentsPaintedMs.count, 1);
  assert.equal(summary.chatHistory.allCommentsUnobservedCount, 1);
  assert.deepEqual(summary.chatHistory.commentRowsRendered, [120, 199]);
  assert.deepEqual(summary.collection, { records: [500], indexedWaitObservedMs: { count: 1, p50: 800, p95: 800, max: 800 }, openToRowsPaintedMs: { count: 1, p50: 210, p95: 210, max: 210 }, rowsRendered: [24], loadedRecords: [100] });
  assert.equal(summary.soak.length, 1);
  assert.deepEqual(summary.soak[0].kinds.renderer, { processCounts: [1], workingSetBytes: { first: 400, last: 440, max: 450, delta: 40 }, privateBytes: { first: 200, last: 220, max: 225, delta: 20 } });
  assert.deepEqual([summary.soak[0].cycles, summary.soak[0].elapsedMs, summary.soak[0].cycleDurationMs.max], [2, 120000, 55000]);
});
