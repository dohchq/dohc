import { z } from "zod";
import { CAPABILITIES, type CapabilityId } from "./capabilities";

export const USAGE_DOORS = ["renderer", "cli", "mcp", "automation"] as const;
export const USAGE_RETENTION_DAYS = 90;
export const USAGE_MAX_COUNT = 2_147_483_647;

// Adapters must also exclude polling, autosave, retries, and failed results.
// An issued id alone is never permission to count an invocation.
export const USAGE_ACTION_IDS = [
  "version.create", "version.switch", "version.compare", "version.merge",
  "version.conflict.resolve", "file.kept.save",
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

const UsageCapabilityId = z.enum(Object.keys(CAPABILITIES) as [CapabilityId, ...CapabilityId[]]);
const UsageActionId = z.enum(USAGE_ACTION_IDS);
const UsageDoor = z.enum(USAGE_DOORS);
const UsageDay = z.iso.date();
export const UsageAppVersion = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/);
export const UsagePair = z.strictObject({ capabilityId: UsageCapabilityId, door: UsageDoor });
export type UsagePair = z.infer<typeof UsagePair>;
export const UsageInvocation = z.strictObject({ capabilityId: UsageActionId, door: UsageDoor });
const UsageCoverageStatus = z.enum(["covered", "uncovered", "unavailable"]);
export const UsageBuildPair = UsagePair.extend({ status: UsageCoverageStatus });
export type UsageBuildPair = z.infer<typeof UsageBuildPair>;
export const UsageVersionCoverage = z.strictObject({
  appVersion: UsageAppVersion,
  pairs: z.array(UsageBuildPair).max(Object.keys(CAPABILITIES).length * USAGE_DOORS.length),
}).superRefine((coverage, ctx) => {
  const keys = new Set<string>();
  for (const pair of coverage.pairs) {
    const key = usagePairKey(pair);
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate coverage pair" });
    keys.add(key);
    if (pair.status === "covered" && !UsageActionId.safeParse(pair.capabilityId).success) {
      ctx.addIssue({ code: "custom", message: "Only counted actions can be covered" });
    }
  }
});
export type UsageVersionCoverage = z.infer<typeof UsageVersionCoverage>;
export const UsageCount = z.strictObject({
  day: UsageDay, capabilityId: UsageActionId, door: UsageDoor,
  count: z.number().int().positive().max(USAGE_MAX_COUNT),
});
export type UsageCount = z.infer<typeof UsageCount>;
export const UsageDayRecord = z.strictObject({
  day: UsageDay,
  appVersions: z.array(UsageAppVersion).min(1).max(90).refine(values => new Set(values).size === values.length),
  complete: z.boolean(),
});
export type UsageDayRecord = z.infer<typeof UsageDayRecord>;

function usagePairKey(pair: UsagePair): string {
  return `${pair.capabilityId}:${pair.door}`;
}
export function usageRowKey(row: UsagePair & { day: string }): string {
  return `${row.day}:${usagePairKey(row)}`;
}

export const UsageSnapshot = z.strictObject({
  version: z.literal(1), enabled: z.boolean(), cleanExit: z.boolean(),
  // Retention is a calendar policy. Future days survive a clock rollback.
  days: z.array(UsageDayRecord), counts: z.array(UsageCount),
  coverage: z.array(UsageVersionCoverage),
}).superRefine((snapshot, ctx) => {
  const days = new Set(snapshot.days.map(day => day.day));
  if (days.size !== snapshot.days.length) ctx.addIssue({ code: "custom", message: "Duplicate day" });
  const keys = new Set<string>();
  for (const row of snapshot.counts) {
    const key = usageRowKey(row);
    if (keys.has(key) || !days.has(row.day)) ctx.addIssue({ code: "custom", path: ["counts"], message: "Duplicate or unrecorded day" });
    keys.add(key);
  }
  if (new Set(snapshot.coverage.map(row => row.appVersion)).size !== snapshot.coverage.length) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "Duplicate app version" });
  }
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

// Validate the aggregate shape before separating unknown and retired ids.
// The store keeps these rows until they age out, except unknown pairs filed
// under its own app version. Unknown fields remain errors.
const StoredCapabilityId = z.string().max(128).regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/);
export const StoredSnapshot = z.strictObject({
  version: z.literal(1), enabled: z.boolean(), cleanExit: z.boolean().default(false),
  days: z.array(UsageDayRecord),
  counts: z.array(UsageCount.extend({ capabilityId: StoredCapabilityId })),
  coverage: z.array(z.strictObject({ appVersion: UsageAppVersion,
    pairs: z.array(UsageBuildPair.extend({ capabilityId: StoredCapabilityId })) })),
});
export type StoredSnapshot = z.infer<typeof StoredSnapshot>;
export function decodeUsageSnapshot(input: unknown): {
  snapshot: UsageSnapshot; dropped: Pick<StoredSnapshot, "counts" | "coverage">;
} {
  const stored = StoredSnapshot.parse(input);
  const dropped: Pick<StoredSnapshot, "counts" | "coverage"> = { counts: [], coverage: [] };
  const snapshot = UsageSnapshot.parse({ ...stored,
    counts: stored.counts.filter(row => {
      if (UsageActionId.safeParse(row.capabilityId).success) return true;
      dropped.counts.push(row);
      return false;
    }),
    coverage: stored.coverage.map(version => {
      const unknown: StoredSnapshot["coverage"][number] = { appVersion: version.appVersion, pairs: [] };
      const pairs = version.pairs.filter(pair => {
        if (UsageCapabilityId.safeParse(pair.capabilityId).success) return true;
        unknown.pairs.push(pair);
        return false;
      });
      if (unknown.pairs.length) dropped.coverage.push(unknown);
      return { ...version, pairs };
    }),
  });
  return { snapshot, dropped };
}

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
  const versions = new Map(snapshot.coverage.map(version => [version.appVersion,
    new Map(version.pairs.map(pair => [usagePairKey(pair), pair.status]))]));
  return query.pairs.map(pair => {
    const daily = calendarDays(query.from, query.through).map(day => {
      const record = days.get(day);
      const statuses = record?.appVersions.map(version => versions.get(version)?.get(usagePairKey(pair)) ?? "uncovered") ?? ["uncovered"];
      const status = statuses.includes("uncovered") ? "uncovered" as const
        : statuses.includes("unavailable") ? "unavailable" as const
        : !record?.complete ? "incomplete" as const : "covered" as const;
      const count = status === "covered" ? counts.get(usageRowKey({ ...pair, day })) ?? 0 : null;
      return { day, appVersions: record?.appVersions.slice() ?? [], status, count };
    });
    const complete = daily.every(day => day.status === "covered");
    const total = complete ? daily.reduce((sum, day) => sum + day.count!, 0) : null;
    const usedDays = complete ? daily.filter(day => day.count! > 0).length : null;
    return { ...pair, daily, coveredDays: daily.filter(day => day.status === "covered").length,
      total, usedDays };
  });
}
