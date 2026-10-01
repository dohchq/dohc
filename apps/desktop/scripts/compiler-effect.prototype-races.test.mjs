import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const bounds = { timeoutMs: 20000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8, maxInputBytes: 4096, maxOutputBytes: 4096, maxErrorBytes: 8192 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const variant of ['baseline', 'candidate']) {
  const modulePath = variant === 'baseline' ? '../src/workspaces/compilerProcessSupervisor.prototype-baseline.ts' : '../src/workspaces/compilerProcessSupervisor.ts';
  const { runOwnedCompilerProcess } = await import(modulePath);
  async function runtime(t) {
    const directory = await mkdtemp(join(tmpdir(), 'dohc-effect-compiler-race-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const workerPath = join(directory, 'worker.mjs');
    await writeFile(workerPath, 'setInterval(()=>{},1000);');
    return { nodeExecutable: process.execPath, workerPath };
  }
  test(`${variant}: cancellation during spawn waits for owner closure`, { timeout: 30000 }, async t => {
    const processRuntime = await runtime(t);
    const controller = new AbortController();
    let owner;
    processRuntime.onOwnerSpawn = pid => { owner = pid; controller.abort(); };
    await assert.rejects(runOwnedCompilerProcess(processRuntime, { input: Buffer.alloc(0), bounds, signal: controller.signal }), { reason: 'cancelled' });
    assert.equal(alive(owner), false);
  });
  test(`${variant}: spawn callback error wins over later cancellation`, { timeout: 30000 }, async t => {
    const processRuntime = await runtime(t);
    const controller = new AbortController();
    const original = new Error('original spawn failure');
    let owner;
    processRuntime.onOwnerSpawn = pid => { owner = pid; queueMicrotask(() => controller.abort()); throw original; };
    await assert.rejects(runOwnedCompilerProcess(processRuntime, { input: Buffer.alloc(0), bounds, signal: controller.signal }), error => error === original);
    assert.equal(alive(owner), false);
  });
  test(`${variant}: cancellation wins over later spawn callback error`, { timeout: 30000 }, async t => {
    const processRuntime = await runtime(t);
    const controller = new AbortController();
    let owner;
    processRuntime.onOwnerSpawn = pid => { owner = pid; controller.abort(); throw new Error('later spawn failure'); };
    await assert.rejects(runOwnedCompilerProcess(processRuntime, { input: Buffer.alloc(0), bounds, signal: controller.signal }), { reason: 'cancelled' });
    assert.equal(alive(owner), false);
  });
}
