import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOptions, createEvidenceDirectory, benchmarkEnvironment } from './packaged-benchmark-options.mjs';
import { startWindowController, waitForVisibleWindow } from './window-controller.mjs';
import { closeOwnedPackage, observeExit, benchmarkCancellation, verifyRestartInput } from './packaged-process.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';

const required = ['--binary', 'dohc.exe', '--package-commit', 'a'.repeat(40), '--output', 'new-output', '--label', 'baseline'];
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
    ['--profile-renderer', 'true', '--scenario', 'startup'],
  ]) assert.throws(() => parseOptions([...required, ...extra]), JSON.stringify(extra));
  assert.throws(() => parseOptions(required.filter((_, i) => i !== 2 && i !== 3)), /package-commit/);
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
for (const switches of [1, 2, 3, 4]) test(`restart verifies saved input after ${switches} switches`, async () => {
  const calls = [];
  const config = { switches, marker: 'saved', selectEditedWorkspace: async () => { calls.push('select workspace 0'); },
    readEditedText: async () => { calls.push('read'); return 'saved'; } };
  assert.equal(await verifyRestartInput(config), true);
  assert.deepEqual(calls, switches % 2 ? ['select workspace 0', 'read'] : ['read']);
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
  const summary = await summarize({ label: 'baseline', status: 'failed', settings: { profileRenderer: true }, limits: ['16ms floor'], runs: [{
    index: 1, freshStartup: { startedAt: 1000, editablePaintObservedMs: 50, windowControlObservedMs: 4, renderer: { timeOrigin: 1005, paints: [{ name: 'first-paint', startTime: 8 }] } },
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
  assert.deepEqual(summary.limits, ['16ms floor']);
});
