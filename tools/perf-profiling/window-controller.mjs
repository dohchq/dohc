import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { closeElectronApplication } from '../../scripts/verification/close-electron.mjs';
import { observeExit } from './packaged-process.mjs';
import { setTimeout as delay } from 'node:timers/promises';

class WindowRequestError extends Error {}

export async function waitForVisibleWindow(inspect, { signal, timeoutMs = 10000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const state = await inspect();
    signal?.throwIfAborted();
    if (performance.now() >= deadline) break;
    if (state.ready !== false && state.visible && !state.minimized) return state;
    await delay(Math.min(50, Math.max(0, deadline - performance.now())), undefined, { signal });
  }
  throw Error(`Owned window did not become visible within ${timeoutMs}ms`);
}

export async function startWindowController({
  command = 'pwsh.exe',
  args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./packaged-window-state.ps1', import.meta.url))],
  startupTimeoutMs = 30000, requestTimeoutMs = 10000, closeTimeoutMs = 2000,
  onSpawn = () => {}, signal,
} = {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const exited = observeExit(child);
  let diagnostics = '', failure, stopPromise;
  child.stderr.on('data', data => { diagnostics += data; });
  const pending = new Map();
  let nextId = 0, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const stop = () => stopPromise ??= (async () => {
    clearTimeout(readyTimer);
    lines.close();
    signal?.removeEventListener('abort', onAbort);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Window helper is closed')); }
    pending.clear();
    if (child.pid) await closeElectronApplication({ close: async () => {
      child.stdin.end(`${JSON.stringify({ state: 'exit' })}\n`);
      await exited;
    } }, child, closeTimeoutMs);
    return await exited;
  })();
  const fail = error => {
    failure ??= error;
    clearTimeout(readyTimer);
    readyReject(failure);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    pending.clear();
    void stop().catch(cleanupError => { failure.cleanupError = cleanupError.message; });
  };
  const readyTimer = setTimeout(() => fail(Error(`Window helper startup timed out: ${diagnostics}`)), startupTimeoutMs);
  const onAbort = () => fail(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.once('exit', (code, signal) => { if (!stopPromise) fail(Error(`Window helper exited ${code}/${signal}: ${diagnostics}`)); });
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw Error('Invalid window helper response');
      if (response.ready === true) { clearTimeout(readyTimer); readyResolve(); return; }
      if (!Number.isSafeInteger(response.id)) throw Error('Window helper response has no request id');
      const item = pending.get(response.id);
      if (!item) throw Error('Unexpected window helper response id');
      pending.delete(response.id); clearTimeout(item.timer);
      response.error ? item.reject(new WindowRequestError(response.error)) : item.resolve(response.value);
    } catch (error) { fail(error); }
  });
  const request = async payload => {
    if (failure) {
      await stop().catch(cleanupError => { failure.cleanupError = cleanupError.message; });
      throw failure;
    }
    if (stopPromise) throw Error('Window helper is closed');
    try {
      return await new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => fail(Error('Window helper request timed out')), requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, error => { if (error) fail(error); });
      });
    } catch (error) {
      if (error instanceof WindowRequestError) throw error;
      fail(error);
      await stop().catch(cleanupError => { error.cleanupError = cleanupError.message; });
      throw error;
    }
  };
  try {
    onSpawn(child);
    await ready;
    await request({ state: 'ping' });
    return { pid: child.pid, request, close: stop };
  } catch (error) {
    fail(error);
    await stop().catch(cleanupError => { error.cleanupError = cleanupError.message; });
    throw error;
  }
}
