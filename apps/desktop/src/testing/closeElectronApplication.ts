import { execFile, type ChildProcess } from "node:child_process";

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return true;
  return await new Promise((resolve) => {
    const finish = (exited: boolean) => {
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

async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || !isRunning(child)) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 2000 }, (error) => {
          if (error && isRunning(child)) reject(error);
          else resolve();
        });
    });
  } else {
    // Playwright launches Electron as the leader of its own POSIX process group.
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (await waitForExit(child, 1000)) return;
    }
  }
  if (!(await waitForExit(child, 1000))) {
    throw new Error(`Electron process ${child.pid} did not exit after forced cleanup.`);
  }
}

export async function closeElectronApplication(
  app: { close(): Promise<void> },
  child: ChildProcess,
  graceMs = 5000,
): Promise<void> {
  if (!isRunning(child)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeFailure: unknown;
  try {
    await Promise.race([
      Promise.resolve().then(() => app.close()),
      new Promise<never>((_, reject) => {
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
