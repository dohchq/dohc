import { closeElectronApplication } from '../../scripts/verification/close-electron.mjs';

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
