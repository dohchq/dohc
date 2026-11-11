import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceFile } from "../atomicReplaceFile";
import { MAX_IGNORED_SETTINGS } from "../settings/settingsFile";
import { DEFAULT_RUN_LOG_KEEP_DAYS, type AgentRunLogsSettings, type StoredUserSettingsResult } from "../settings/userSettings";

// Each agent run writes its output to run-logs/<runId>.log in dohc's state
// folder, with the files its launch writes beside it. dohc removes a run's
// files once its recorded end is older than the settings file's agentRunLogs.keepDays.
export const RUN_LOG_FOLDER = "run-logs";

const DAY_MS = 24 * 60 * 60 * 1000;
// No settings file keeps a log for less, so a younger run's missing log was not removed by dohc.
export const MIN_RUN_LOG_AGE_MS = DEFAULT_RUN_LOG_KEEP_DAYS * DAY_MS;
const ENDED = ".ended";
// A run's log, its reply runtime record (.node), Claude Code's MCP config
// (.mcp.json) and the run's end record (.ended).
const RUN_FILE = /^(?<runId>[^.]+)\.log(?:\.node|\.mcp\.json|\.ended)?$/u;

// A file dohc could not read, or a limit it ignored, may ask to keep logs
// longer, so dohc keeps every log until the file says how long. A full list
// of ignored keys may have left the limit out.
export function runLogKeepDays(
  result: Pick<StoredUserSettingsResult, "settings" | "source" | "ignored">,
): AgentRunLogsSettings["keepDays"] {
  const unread = result.source === "recovered" || (result.ignored?.length ?? 0) >= MAX_IGNORED_SETTINGS ||
    result.ignored?.some(({ key }) => key === "agentRunLogs" || key.startsWith("agentRunLogs."));
  return unread ? "forever" : result.settings.agentRunLogs.keepDays;
}

// A run's end, recorded beside its log as <runId>.log.ended. Cleanup counts
// a run's age from it, and keeps every file of a run that has none: that run
// may still be running, or dohc stopped before it could record the end.
export async function markRunLogEnded(logPath: string, nowMs: number): Promise<void> {
  await atomicReplaceFile(`${logPath}${ENDED}`, (tmp) => writeFile(tmp, `${nowMs}\n`, { mode: 0o600 }))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
}

async function readEnd(path: string): Promise<number | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return /^\d+\n$/u.test(text) ? Number(text) : undefined;
}

/**
 * Removes the files of runs whose recorded end is more than `keepDays` ago.
 * A run with no readable end record, or one still running, keeps its files at
 * any age. The end record goes last, so a removal that stops partway is
 * finished by the next cleanup.
 */
export async function removeExpiredRunLogs(input: {
  stateDir: string;
  keepDays: AgentRunLogsSettings["keepDays"];
  nowMs: number;
  isRunning(runId: string): boolean;
}): Promise<void> {
  if (input.keepDays === "forever") return;
  const folder = join(input.stateDir, RUN_LOG_FOLDER);
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const runs = new Map<string, string[]>();
  for (const name of names) {
    const runId = RUN_FILE.exec(name)?.groups?.runId;
    if (runId !== undefined) runs.set(runId, [...runs.get(runId) ?? [], name]);
  }
  const before = input.nowMs - input.keepDays * DAY_MS;
  const failures: unknown[] = [];
  const remove = (name: string) => unlink(join(folder, name)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return true;
    failures.push(error);
    return false;
  });
  for (const [runId, files] of runs) {
    const endRecord = `${runId}.log${ENDED}`;
    if (!files.includes(endRecord) || input.isRunning(runId)) continue;
    try {
      const endedAtMs = await readEnd(join(folder, endRecord));
      if (endedAtMs === undefined || endedAtMs > before) continue;
    } catch (error) {
      failures.push(error);
      continue;
    }
    const removed = await Promise.all(files.filter((name) => name !== endRecord).map(remove));
    if (removed.every(Boolean)) await remove(endRecord);
  }
  if (failures.length > 0) throw new AggregateError(failures, `dohc could not remove ${failures.length} old agent run log files.`);
}
