import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import type { ScheduleRecord } from "@dohc/automation-executor/automation-scheduler";
import { createScheduleRecords, parseScheduleRecord } from "./scheduleRecords";

const record: ScheduleRecord = {
  schedules: [{
    automationId: "collection:Tasks#report",
    collectionPath: "Tasks",
    name: "Weekday report",
    trigger: { kind: "schedule", every: "week", at: "09:00", days: ["mon"], timezone: "Europe/London" },
    scheduleHash: "abc123",
    enabledSince: null,
    throughMs: 1_000,
  }],
};

describe("schedule records", () => {
  it("keeps, reads, and removes a workspace's record", async () => {
    const directory = join(await createTestScratch("dohc-schedule-records-"), "schedules");
    const records = createScheduleRecords(directory);
    expect(await records.readAll(), "no folder yet").toEqual([]);
    await records.save("ws/1", record);
    await records.save("ws-2", { schedules: [] });
    expect(await records.readAll()).toEqual(expect.arrayContaining([
      { workspaceId: "ws/1", record },
      { workspaceId: "ws-2", record: { schedules: [] } },
    ]));
    await records.save("ws-2", null);
    expect(await records.readAll()).toEqual([{ workspaceId: "ws/1", record }]);
  });

  it("removes a file it cannot read, or one named for another workspace", async () => {
    const directory = join(await createTestScratch("dohc-schedule-records-"), "schedules");
    const records = createScheduleRecords(directory);
    await records.save("ws", record);
    await writeFile(join(directory, "broken.json"), "{");
    await writeFile(join(directory, "moved.json"), JSON.stringify({ version: 1, workspaceId: "ws", schedules: [] }));
    expect(await records.readAll()).toEqual([{ workspaceId: "ws", record }]);
    expect(await readdir(directory)).toEqual(["ws.json"]);
  });

  it("takes only schedules dohc wrote", () => {
    const text = (schedules: unknown) => JSON.stringify({ version: 1, workspaceId: "ws", schedules });
    expect(parseScheduleRecord(text(record.schedules))).toEqual({ workspaceId: "ws", record });
    const [schedule] = record.schedules;
    for (const bad of [
      { ...schedule, throughMs: -1 },
      { ...schedule, trigger: { ...schedule!.trigger, kind: "record-added" } },
      { ...schedule, trigger: { kind: "schedule", every: "day", at: "09:00", timezone: "UTC", days: [] } },
      { ...schedule, automationId: 7 },
    ]) {
      expect(parseScheduleRecord(text([bad]))).toBeNull();
    }
    expect(parseScheduleRecord(JSON.stringify({ version: 2, workspaceId: "ws", schedules: [] }))).toBeNull();
  });
});
