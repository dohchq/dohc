import { execFile } from "node:child_process";
import { join } from "node:path";

// taskkill /T walks the tree and a forced exit still has to reach the parent.
// Beside other work both took over 2 s, so this bound only stops a hang.
const FORCED_CLEANUP_TIMEOUT_MS = 10_000;
export const PROCESS_EXIT_ALLOWANCE_MS = 1_000;

// Every process under pid, found by parent pid while pid still runs.
async function descendantPids(pid) {
  const listing = await new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: FORCED_CLEANUP_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
  const rows = listing.trim().split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/u).map(Number));
  const found = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [member, parent] of rows) {
      if (!found.has(member) && found.has(parent)) { found.add(member); changed = true; }
    }
  }
  found.delete(pid);
  return [...found];
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function assertCleanExit(child) {
  if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Electron exited with status ${child.exitCode}.`);
  if (child.signalCode !== null) throw new Error(`Electron exited with signal ${child.signalCode}.`);
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
        { windowsHide: true, timeout: FORCED_CLEANUP_TIMEOUT_MS }, (error) => {
          if (error && isRunning(child)) reject(error);
          else resolve();
        });
    });
  } else {
    // Graceful close already had its bounded attempt. A descendant can lead its own group, as the
    // engine does on Linux, so every descendant is listed while the leader is live and killed by pid.
    const descendants = await descendantPids(child.pid).catch((error) => {
      console.error("Electron forced cleanup could not list descendants; killing its group only:", error);
      return [];
    });
    // Kill the group only while its recorded leader is live; once it exits, its pid can lead
    // another group. A second grace period could outlive the leader and lose ownership.
    if (isRunning(child)) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    for (const pid of descendants) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") console.error(`Electron forced cleanup could not kill descendant ${pid}:`, error); }
    }
  }
  if (!(await waitForExit(child, FORCED_CLEANUP_TIMEOUT_MS))) {
    throw new Error(`Electron process ${child.pid} did not exit after forced cleanup.`);
  }
}

/**
 * @param {{ close(): Promise<void> }} app
 * @param {import("node:child_process").ChildProcess} child
 */
export async function closeElectronApplication(app, child, graceMs = 5000) {
  if (!isRunning(child)) {
    assertCleanExit(child);
    return;
  }
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
    if (!closeFailure && !(await waitForExit(child, PROCESS_EXIT_ALLOWANCE_MS))) {
      closeFailure = new Error(`Electron close completed while process ${child.pid} was still running; forced cleanup was required.`);
    }
    try { await terminateOwnedProcess(child); }
    catch (error) {
      if (closeFailure) console.error("Electron forced cleanup failed:", error);
      else closeFailure = error;
    }
  }
  if (closeFailure) throw closeFailure;
  assertCleanExit(child);
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
