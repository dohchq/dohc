import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireProfilingSlot, profilingHostContext } from './admission.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dohc-profiling-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { DOHC_BUILD_SLOT_ROOT: root };
  let sample;
  const options = { schedule(callback) { sample = callback; return {}; }, unschedule() {} };
  return { root, env, options, sample: () => sample(), acquire: () => acquireProfilingSlot(env, options) };
}

function owner(root, kind, index = 1) {
  const dir = join(root, `${kind}-${index}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, start: new Date().toISOString(), purpose: 'fixture gate' }));
}

test('profiling admits one benchmark without creating a PR slot or queue ticket', t => {
  const f = fixture(t);
  const first = f.acquire();
  t.after(() => first.release());
  assert.equal(first.name, 'profiling-slot-1');
  assert.throws(f.acquire, /Another run owns/);
  assert.equal(existsSync(join(f.root, 'verification-slot-1')), false);
  assert.equal(existsSync(join(f.root, 'verification-slot-queue')), false);
  assert.equal(existsSync(join(f.root, 'profiling-slot-queue')), false);
  first.release();
  const next = f.acquire();
  next.release();
  assert.equal(readdirSync(f.root).filter(name => name.startsWith('profiling-slot')).length, 0);
});

test('nine simultaneous profiling processes admit exactly one without joining the PR queue', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const source = `import { acquireProfilingSlot } from ${JSON.stringify(new URL('./admission.mjs', import.meta.url).href)};
    let lane;
    process.on('message', message => {
      if (message === 'start') {
        try { lane = acquireProfilingSlot(); process.send('admitted'); }
        catch { process.send('rejected'); }
      } else { lane?.release(); process.disconnect(); }
    });
    process.send('ready');`;
  const children = Array.from({ length: 9 }, () => spawn(process.execPath, ['--input-type=module', '-e', source],
    { env: { ...process.env, DOHC_BUILD_SLOT_ROOT: f.root, DOHC_VERIFICATION_SLOT_ROOT: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }));
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
  });
  await Promise.all(children.map(child => once(child, 'message')));
  const replies = children.map(child => once(child, 'message'));
  children.forEach(child => child.send('start'));
  const results = (await Promise.all(replies)).map(([message]) => message);
  assert.equal(results.filter(result => result === 'admitted').length, 1);
  assert.equal(results.filter(result => result === 'rejected').length, 8);
  assert.equal(existsSync(join(f.root, 'verification-slot-queue')), false);
  const exits = children.map(child => once(child, 'exit'));
  children.forEach(child => child.send('stop'));
  await Promise.all(exits);
  assert.equal(existsSync(join(f.root, 'profiling-slot-1')), false);
});

for (const kind of ['verification-slot', 'verification-light-slot', 'build-slot']) {
  test(`profiling rejects active ${kind} work and records its owner`, t => {
    const f = fixture(t);
    owner(f.root, kind);
    assert.throws(f.acquire, error => {
      assert.match(error.message, /Profiling deferred/);
      assert.equal(error.hostContext.observations[0].lanes.find(lane => lane.kind === kind).owners[0].purpose, 'fixture gate');
      return true;
    });
    assert.equal(existsSync(join(f.root, 'profiling-slot-1')), false);
  });
}

test('a waiting PR has priority even before its full lane is held', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'verification-slot-queue'));
  const ticket = join(f.root, 'verification-slot-queue', 'old-pr.json');
  writeFileSync(ticket, JSON.stringify({ pid: process.pid, start: new Date().toISOString(), purpose: 'waiting PR' }));
  assert.throws(f.acquire, /Profiling deferred/);
  assert.equal(existsSync(ticket), true);
  assert.equal(existsSync(join(f.root, 'profiling-slot-1')), false);
});

test('registered work arriving after admission interrupts only the profiling caller', t => {
  const f = fixture(t);
  const lane = f.acquire();
  t.after(() => lane.release());
  owner(f.root, 'verification-slot');
  f.sample();
  assert.equal(lane.signal.aborted, true);
  assert.throws(lane.check, /Profiling deferred/);
  assert.equal(existsSync(join(f.root, 'profiling-slot-1')), true, 'retain ownership until child cleanup completes');
  lane.release();
  assert.equal(existsSync(join(f.root, 'verification-slot-1')), true, 'never release another run');
});

test('post-claim host check catches newly admitted PR work and releases profiling ownership', t => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => acquireProfilingSlot(f.env, { ...f.options, observe() {
    if (++calls === 2) owner(f.root, 'verification-slot');
    return profilingHostContext(f.env);
  } }), /Profiling deferred/);
  assert.equal(existsSync(join(f.root, 'profiling-slot-1')), false);
});

test('host context includes shared and isolated verification lanes without changing Cargo capacity', t => {
  const f = fixture(t);
  const trial = join(f.root, 'trial');
  mkdirSync(trial);
  owner(trial, 'verification-slot', 2);
  const context = profilingHostContext({ ...f.env, DOHC_VERIFICATION_SLOT_ROOT: trial });
  assert.equal(context.lanes.find(lane => lane.kind === 'build-slot').slots, 4);
  assert.equal(context.lanes.filter(lane => lane.kind === 'verification-slot').length, 2);
  assert.equal(context.lanes.find(lane => lane.root === trial && lane.kind === 'verification-slot').owners[0].name, 'verification-slot-2');
});

test('unbudgeted hosts record uncoordinated context without claiming host idleness', t => {
  const lane = acquireProfilingSlot({ CI: '1' }, { schedule: () => ({}), unschedule() {} });
  t.after(() => lane.release());
  assert.equal(lane.evidence.coordinated, false);
  assert.equal(lane.name, null);
  assert.match(lane.evidence.scope, /does not certify an idle host/);
});
