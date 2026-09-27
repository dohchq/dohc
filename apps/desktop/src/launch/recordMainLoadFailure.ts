import { app } from "electron";
import { release as osRelease, type as osType } from "node:os";
import { join } from "node:path";
import { resolveUpdateChannel } from "../updates/electronUpdater";
import { stateDir } from "../workspaces/WorkspaceRegistry";
import { createCodeFrames, crashReportRoot } from "../crashReports/crashReport";
import { createCrashReportStore } from "../crashReports/crashReportStore";

/**
 * Keeps a main module that failed to load in the crash report on this
 * computer, in the same file main's store reads. The entry loads this only
 * after the failure, so a healthy launch pays nothing for it. It never sends:
 * the next dohc that starts shows the report in Notices, and it leaves only
 * when the person clicks Send report.
 */
export function recordMainLoadFailure(error: unknown): void {
  const version = app.getVersion();
  createCrashReportStore({
    path: join(stateDir(), "crash-report.json"),
    endpoint: null,
    facts: () => ({
      atMs: Date.now(),
      version,
      channel: resolveUpdateChannel(version),
      packaged: app.isPackaged,
      system: `${osType()} ${osRelease()}`,
      arch: process.arch,
      electron: process.versions.electron ?? "unknown",
      uptimeSeconds: Math.round(process.uptime()),
    }),
    codeFrame: createCodeFrames(
      [crashReportRoot({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })],
      process.platform,
    ),
    onChanged: () => undefined,
  }).record({ kind: "main-exception", error, origin: "module-load" });
}
