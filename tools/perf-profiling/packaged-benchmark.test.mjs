import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOptions, createEvidenceDirectory } from './packaged-benchmark-options.mjs';
import { startWindowController } from './window-controller.mjs';
import { closeOwnedPackage, observeExit, benchmarkCancellation } from './packaged-process.mjs';
import { summarize } from './summarize-packaged-benchmark.mjs';

const required = ['--binary', 'dohc.exe', '--package-commit', 'a'.repeat(40), '--output', 'new-output', '--label', 'baseline'];
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

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} interrupts a pending launch and closes owned resources`, async () => {
  const priorExitCode = process.exitCode;
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const cancellation = benchmarkCancellation();
  const instance = await ownedNode(`console.log('ready');setInterval(()=>{},1000);`);
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
  } finally {
    await closeOwnedPackage(instance, 100).catch(() => {});
    await helper.close();
    cancellation.dispose();
    process.exitCode = priorExitCode;
  }
  assert.ok(instance.child.exitCode !== null || instance.child.signalCode !== null);
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
