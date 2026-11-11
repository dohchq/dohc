import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunLogsSettings } from "../settings/userSettings";

// Each agent run writes its output to run-logs/<runId>.log in dohc's state
// folder, with the files its launch writes beside it. dohc removes a finished
// run's files once they are older than the settings file's agentRunLogs.keepDays.
export const RUN_LOG_FOLDER = "run-logs";

const DAY_MS = 24 * 60 * 60 * 1000;
// A run's log, its reply runtime record (.node) and Claude Code's MCP config (.mcp.json).
const RUN_FILE = /^(?<runId>[^.]+)\.log(?:\.node|\.mcp\.json)?$/u;

/**
 * Removes the files of runs that last wrote them more than `keepDays` ago.
 * A finished run writes nothing more, so that is the time since it ended.
 * A running run's files stay at any age.
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
  const before = input.nowMs - input.keepDays * DAY_MS;
  const failures: unknown[] = [];
  for (const name of names) {
    const runId = RUN_FILE.exec(name)?.groups?.runId;
    if (runId === undefined || input.isRunning(runId)) continue;
    const path = join(folder, name);
    try {
      const file = await stat(path);
      if (!file.isFile() || file.mtimeMs > before) continue;
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `dohc could not remove ${failures.length} old agent run log files.`);
}
