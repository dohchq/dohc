import { spawn, execFile } from 'node:child_process';
import { closeElectronApplication } from '../../scripts/verification/close-electron.mjs';

function killTree(child) {
  return new Promise(resolve => {
    if (!child.pid) { resolve(); return; }
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else { try { child.kill('SIGKILL'); } catch {} resolve(); }
  });
}

// Runs a helper the harness owns, such as the CLI launcher that spawns a second Node process.
// A timeout or cancellation stops the whole process tree and waits for its exit before rejecting.
export function runOwnedProcess(command, args, { cwd, env, timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const exit = observeExit(child);
    const label = `${command} ${args.join(' ')}`;
    let stdout = '', stderr = '', stopping = null;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const stop = reason => { stopping ??= killTree(child).then(() => exit).then(() => reject(reason)); };
    const timer = setTimeout(() => stop(Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => stop(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    void exit.then(exited => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (stopping) return;
      if (exited.spawnError) reject(Error(`${label} failed to start: ${exited.spawnError}`));
      else if (exited.code !== 0) reject(Error(`${label} exited ${exited.code}/${exited.signal}: ${(stderr || stdout).trim()}`));
      else resolve({ stdout, stderr, pid: child.pid });
    });
  });
}

export async function verifyRestartInput({ isEditedWorkspaceSelected, selectEditedWorkspace, readEditedText, marker }) {
  if (!(await isEditedWorkspaceSelected())) await selectEditedWorkspace();
  if (!(await readEditedText()).includes(marker)) throw Error('Restart did not restore the saved input');
  return true;
}

export function benchmarkCancellation() {
  const controller = new AbortController();
  const interrupt = signal => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort(Error(`Release benchmark interrupted by ${signal}`));
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  return {
    signal: controller.signal,
    async run(action) {
      controller.signal.throwIfAborted();
      let onAbort;
      try {
        return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(); }), new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        })]);
      } finally { controller.signal.removeEventListener('abort', onAbort); }
    },
    dispose() { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); },
  };
}

export function observeExit(child) {
  return new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
    child.once('error', error => resolve({ spawnError: error.message, at: Date.now() }));
  });
}

export async function closeOwnedPackage(instance, graceMs = 20000) {
  if (!instance?.child.pid) return;
  await closeElectronApplication({
    async close() {
      if (!instance.browser) throw Error('Package failed before CDP attached');
      const session = await instance.browser.newBrowserCDPSession();
      void session.send('Browser.close').catch(() => {});
      await instance.exit;
    },
  }, instance.child, graceMs);
}
