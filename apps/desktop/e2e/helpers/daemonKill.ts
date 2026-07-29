import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENGINE_BASENAME = "dohc-workspace-engine";

interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
}

async function processTable(): Promise<ProcessRow[]> {
  const raw =
    process.platform === "win32"
      ? (
          await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }',
            ],
            { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
          )
        ).stdout
      : (
          await execFileAsync("ps", ["-eo", "pid=,ppid=,comm="], {
            maxBuffer: 32 * 1024 * 1024,
          })
        ).stdout;
  const separator = process.platform === "win32" ? /\|/ : /\s+/;
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().split(separator))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({
      pid: Number.parseInt(parts[0] ?? "", 10),
      parentPid: Number.parseInt(parts[1] ?? "", 10),
      name: parts.slice(2).join(" "),
    }))
    .filter((row) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid));
}

/**
 * Every dohc-workspace-engine process under THIS app's process tree.
 *
 * Scoped by ancestry on purpose: a developer machine (or a parallel agent)
 * routinely has other dohc engines running, and a kill-by-image-name test would
 * take them down with it. The walk is recursive because Playwright's Electron
 * launcher is itself a shim whose child is the real main process.
 */
export async function engineDaemonPids(appPid: number): Promise<number[]> {
  const rows = await processTable();
  const descendants = new Set<number>([appPid]);
  // A parent always precedes its children in creation order, but the table is
  // unordered — iterate to a fixed point instead of assuming.
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.pid) || !descendants.has(row.parentPid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return rows
    .filter(
      (row) => row.pid !== appPid && descendants.has(row.pid) && row.name.startsWith(ENGINE_BASENAME),
    )
    .map((row) => row.pid);
}

/** Hard-kills a pid the way a crash or `taskkill /F` would: no graceful exit. */
export async function hardKillPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Waits until the app has a live engine daemon whose pid differs from every pid
 * in `excluded`, and returns it. Proves a restart actually happened rather than
 * just that "some engine exists".
 */
export async function waitForFreshEngineDaemon(
  appPid: number,
  excluded: readonly number[],
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await engineDaemonPids(appPid);
    const fresh = pids.find((pid) => !excluded.includes(pid));
    if (fresh !== undefined) return fresh;
    if (Date.now() > deadline) {
      throw new Error(
        `No replacement engine daemon appeared for app ${appPid} within ${timeoutMs}ms (saw ${pids.join(",") || "none"}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
