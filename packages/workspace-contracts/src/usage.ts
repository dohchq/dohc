import { z } from "zod";
import { CAPABILITIES, type CapabilityId } from "./capabilities";

export const USAGE_DOORS = ["renderer", "cli", "mcp", "automation"] as const;
export const USAGE_RETENTION_DAYS = 90;
export const USAGE_MAX_COUNT = 2_147_483_647;

// Adapters must also exclude polling, autosave, retries, and failed results.
// An issued id alone is never permission to count an invocation.
export const USAGE_ACTION_IDS = [
  "version.create", "version.switch", "version.compare", "version.merge",
  "version.conflict.resolve", "file.kept.save", "version.try", "version.try.dismiss",
  "search.start", "crash.dismiss", "crash.send", "chat.dispatch.notice.dismiss",
  "automation.host.choose", "automation.host.takeover", "notice.mark",
  "automation.schedule.run", "automation.notice.retry", "workspace.open.retry",
  "chat.show", "chat.post", "chat.reply", "chat.react", "chat.search", "chat.export",
  "collection.record.edit", "collection.record.create", "file.write", "file.move",
  "file.delete", "document.edit", "document.create", "file.chat.start",
  "automation.switch", "automation.run.retry", "automation.button.press",
  "dataset.history.restore.prepare", "dataset.delete", "dataset.archive", "dataset.restore",
  "dataset.attempt.reconcile", "dataset.attempt.cancel", "dataset.grant.set",
  "dataset.grant.remove", "dataset.export", "dataset.recovery.prepare", "dataset.recovery.claim",
  "dataset.recovery.discard", "dataset.file.upload", "dataset.form.create", "dataset.create",
  "dataset.prepare", "dataset.approve", "dataset.discard", "dataset.migration.prepare",
  "dataset.schema.change.prepare", "dataset.migration.approve", "dataset.migration.discard",
  "dataset.operation.invoke", "app.link.create", "app.local.prepare", "app.local.launch",
  "app.publication.prepare", "app.publication.approve", "app.publication.cancel",
  "app.publication.withdraw", "app.collection.revoke", "app.publication.reactivation.review",
  "app.responses.undo", "folder.create", "app.create", "app.test", "data.import",
] as const satisfies readonly CapabilityId[];

export const UsageCapabilityId = z.enum(Object.keys(CAPABILITIES) as [CapabilityId, ...CapabilityId[]]);
export const UsageActionId = z.enum(USAGE_ACTION_IDS);
export const UsageDoor = z.enum(USAGE_DOORS);
export const UsageDay = z.iso.date();
export const UsageAppVersion = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/);
export const UsagePair = z.strictObject({ capabilityId: UsageCapabilityId, door: UsageDoor });
export type UsagePair = z.infer<typeof UsagePair>;
export const UsageInvocation = z.strictObject({ capabilityId: UsageActionId, door: UsageDoor });
export const UsageCoverageStatus = z.enum(["covered", "uncovered", "incomplete", "off", "unavailable"]);
export const UsageCoverageInput = UsagePair.extend({ status: UsageCoverageStatus });
export const UsageCount = z.strictObject({
  day: UsageDay, capabilityId: UsageActionId, door: UsageDoor,
  count: z.number().int().positive().max(USAGE_MAX_COUNT),
});
export type UsageCount = z.infer<typeof UsageCount>;
export const UsageCoverage = UsageCoverageInput.extend({ day: UsageDay });
export type UsageCoverage = z.infer<typeof UsageCoverage>;
export const UsageDayRecord = z.strictObject({
  day: UsageDay,
  appVersions: z.array(UsageAppVersion).min(1).max(90).refine(values => new Set(values).size === values.length),
  collection: z.enum(["on", "off", "partial"]),
});
export type UsageDayRecord = z.infer<typeof UsageDayRecord>;

export function usagePairKey(pair: UsagePair): string {
  return `${pair.capabilityId}:${pair.door}`;
}
export function usageRowKey(row: UsagePair & { day: string }): string {
  return `${row.day}:${usagePairKey(row)}`;
}

export const UsageSnapshot = z.strictObject({
  version: z.literal(1), enabled: z.boolean(),
  days: z.array(UsageDayRecord).max(USAGE_RETENTION_DAYS),
  counts: z.array(UsageCount).max(USAGE_RETENTION_DAYS * USAGE_ACTION_IDS.length * USAGE_DOORS.length),
  coverage: z.array(UsageCoverage).max(USAGE_RETENTION_DAYS * Object.keys(CAPABILITIES).length * USAGE_DOORS.length),
}).superRefine((snapshot, ctx) => {
  const days = new Map(snapshot.days.map(day => [day.day, day]));
  if (days.size !== snapshot.days.length) ctx.addIssue({ code: "custom", message: "Duplicate day" });
  for (const [field, rows] of [["counts", snapshot.counts], ["coverage", snapshot.coverage]] as const) {
    const keys = new Set<string>();
    for (const row of rows) {
      const key = usageRowKey(row);
      if (keys.has(key) || !days.has(row.day)) ctx.addIssue({ code: "custom", path: [field], message: "Duplicate or unrecorded day" });
      keys.add(key);
    }
  }
  for (const row of snapshot.coverage) {
    if (row.status === "covered" && !UsageActionId.safeParse(row.capabilityId).success) {
      ctx.addIssue({ code: "custom", path: ["coverage"], message: "Only counted actions can be covered" });
    }
    if (row.status === "covered" && days.get(row.day)?.collection !== "on") {
      ctx.addIssue({ code: "custom", path: ["coverage"], message: "Off or partial days cannot be covered" });
    }
  }
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

export const UsageQuery = z.strictObject({
  from: UsageDay, through: UsageDay, pairs: z.array(UsagePair).min(1).max(Object.keys(CAPABILITIES).length * 4),
}).refine(query => query.from <= query.through && calendarDays(query.from, query.through).length <= USAGE_RETENTION_DAYS);
export type UsageQuery = z.infer<typeof UsageQuery>;

// Noon avoids daylight-saving transitions while walking local calendar dates.
export function calendarDays(from: string, through: string): string[] {
  const date = new Date(`${from}T12:00:00`);
  const days: string[] = [];
  while (localUsageDay(date) <= through && days.length <= USAGE_RETENTION_DAYS) {
    days.push(localUsageDay(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
}

export function localUsageDay(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}

export function queryUsage(snapshot: UsageSnapshot, input: UsageQuery) {
  const query = UsageQuery.parse(input);
  const days = new Map(snapshot.days.map(day => [day.day, day]));
  const counts = new Map(snapshot.counts.map(row => [usageRowKey(row), row.count]));
  const coverage = new Map(snapshot.coverage.map(row => [usageRowKey(row), row.status]));
  return query.pairs.map(pair => {
    const daily = calendarDays(query.from, query.through).map(day => {
      const record = days.get(day);
      const key = usageRowKey({ ...pair, day });
      const recorded = coverage.get(key) ?? "uncovered";
      const status = record?.collection === "off" ? "off" as const
        : record?.collection === "partial" && recorded === "covered" ? "incomplete" as const : recorded;
      const observedCount = counts.get(key) ?? 0;
      return { day, appVersions: record?.appVersions.slice() ?? [], status,
        count: status === "covered" ? observedCount : null, observedCount };
    });
    const complete = daily.every(day => day.status === "covered");
    const observedCount = daily.reduce((sum, day) => sum + day.observedCount, 0);
    const observedUsedDays = daily.filter(day => day.observedCount > 0).length;
    return { ...pair, daily, coveredDays: daily.filter(day => day.status === "covered").length,
      total: complete ? observedCount : null, usedDays: complete ? observedUsedDays : null,
      observedCount, observedUsedDays };
  });
}
