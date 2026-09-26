import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScheduleRecord } from "./automationScheduler";

// Each workspace's schedules this computer runs, with their marks, kept in
// stateDir()/schedules/<workspaceId>.json while the workspace is open. After
// its windows close, or at the next start, dohc reads them to open the
// workspace in the background when a schedule is due. The workspace's
// engine keeps the real marks; a record only says when to open it.

const FREQUENCIES = new Set(["hour", "day", "weekday", "week", "month"]);

const isTime = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

function isRecordedSchedule(value: unknown): value is ScheduleRecord["schedules"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { automationId, name, scheduleHash, enabledSince, throughMs, trigger } = value as Record<string, unknown>;
  if (typeof automationId !== "string" || typeof name !== "string" || typeof scheduleHash !== "string") return false;
  if (!isTime(enabledSince) || !isTime(throughMs)) return false;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return false;
  const { kind, every, at, timezone, days } = trigger as Record<string, unknown>;
  if (kind !== "schedule" || typeof every !== "string" || !FREQUENCIES.has(every)) return false;
  if (typeof at !== "string" || typeof timezone !== "string") return false;
  return every === "week" || every === "month" ? Array.isArray(days) : days === undefined;
}

/** A record read from disk, or null when it is not one dohc wrote. */
export function parseScheduleRecord(text: string): { workspaceId: string; record: ScheduleRecord } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, workspaceId, schedules } = value as Record<string, unknown>;
  if (version !== 1 || typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  if (!Array.isArray(schedules) || !schedules.every(isRecordedSchedule)) return null;
  return { workspaceId, record: { schedules } };
}

export function createScheduleRecords(directory: string) {
  const fileOf = (workspaceId: string) => join(directory, `${encodeURIComponent(workspaceId)}.json`);
  // Writes go one at a time, so the last one lands last.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    /** Keeps the record, or removes it when null. */
    save(workspaceId: string, record: ScheduleRecord | null): Promise<void> {
      const write = queue.then(async () => {
        const file = fileOf(workspaceId);
        if (record === null) {
          await rm(file, { force: true });
          return;
        }
        await mkdir(directory, { recursive: true });
        const temporary = `${file}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, workspaceId, schedules: record.schedules })}\n`);
        await rename(temporary, file);
      });
      queue = write.catch(() => undefined);
      return write;
    },

    /** Every readable record. One dohc cannot read is removed. */
    async readAll(): Promise<Array<{ workspaceId: string; record: ScheduleRecord }>> {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return [];
      }
      const records: Array<{ workspaceId: string; record: ScheduleRecord }> = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = join(directory, name);
        const parsed = parseScheduleRecord(await readFile(file, "utf8").catch(() => ""));
        if (parsed === null || fileOf(parsed.workspaceId) !== file) {
          await rm(file, { force: true });
          continue;
        }
        records.push(parsed);
      }
      return records;
    },
  };
}
