import { execFile } from "node:child_process";
import { join } from "node:path";

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child, timeoutMs) {
  if (!isRunning(child)) return true;
  return await new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (!isRunning(child)) finish(true);
  });
}

async function terminateOwnedProcess(child) {
  if (!child.pid || !isRunning(child)) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 2000 }, (error) => {
          if (error && isRunning(child)) reject(error);
          else resolve();
        });
    });
  } else {
    // Graceful close already had its bounded attempt. Kill the group while its recorded leader
    // is live; a second grace period could outlive the leader and lose ownership.
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  if (!(await waitForExit(child, 1000))) {
    throw new Error(`Electron process ${child.pid} did not exit after forced cleanup.`);
  }
}

/**
 * @param {{ close(): Promise<void> }} app
 * @param {import("node:child_process").ChildProcess} child
 */
export async function closeElectronApplication(app, child, graceMs = 5000) {
  if (!isRunning(child)) return;
  let timer;
  let closeFailure;
  try {
    await Promise.race([
      Promise.resolve().then(() => app.close()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Electron close timed out after ${graceMs}ms.`)), graceMs);
      }),
    ]);
  } catch (error) {
    closeFailure = error;
  } finally {
    clearTimeout(timer);
    if (!closeFailure) await waitForExit(child, 1000);
    await terminateOwnedProcess(child);
  }
  if (closeFailure) throw closeFailure;
}

async function captureBeforeClose(action, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch { /* Artifacts are best-effort; process cleanup must still run. */ }
  finally { clearTimeout(timer); }
}

export async function closeDebugApplication(app, child, directory, { artifactTimeoutMs = 5000, closeTimeoutMs = 5000 } = {}) {
  try {
    const pages = app.windows();
    for (const [index, page] of pages.entries()) {
      const name = pages.length === 1 ? "last-screen.png" : `last-screen-${index + 1}.png`;
      await captureBeforeClose(() => page.screenshot({ path: join(directory, name), timeout: artifactTimeoutMs }), artifactTimeoutMs);
    }
    await captureBeforeClose(() => app.context().tracing.stop({ path: join(directory, "trace.zip") }), artifactTimeoutMs);
  } finally {
    await closeElectronApplication(app, child, closeTimeoutMs);
  }
}
