import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS, USAGE_DOORS, type UsageBuildPair, type UsageSnapshot } from "@dohc/workspace-contracts/usage";
import { INVALID_USAGE_RECORD, type UsageRecordResult, type UsageRecordRow, type usageRecordOperations } from "../ipc/bridgeContract";
import type { OperationHandlers } from "../ipc/operationTable";
import type { createUsageStore } from "./usageStore";

type UsageStore = Pick<ReturnType<typeof createUsageStore>,
  "read" | "newestAside" | "clear" | "setEnabled" | "startNewRecord" | "restoreSetAside">;

// One row per counted action: each door's total over the kept days, and
// whether this build counts that door at all.
export function usageRecordView(snapshot: UsageSnapshot, coverage: readonly UsageBuildPair[], file: string): UsageRecordResult {
  const counted = new Set(coverage.filter(pair => pair.status === "covered").map(pair => `${pair.capabilityId}:${pair.door}`));
  const rows = new Map<string, UsageRecordRow>(USAGE_ACTION_IDS.map(capabilityId => [capabilityId, {
    capabilityId,
    label: CAPABILITIES[capabilityId].description.replace(/\.$/, ""),
    doors: Object.fromEntries(USAGE_DOORS.map(door =>
      [door, { count: 0, counted: counted.has(`${capabilityId}:${door}`) }])) as UsageRecordRow["doors"],
    lastUsed: null,
  }]));
  for (const { capabilityId, door, day, count } of snapshot.counts) {
    const row = rows.get(capabilityId)!;
    row.doors[door].count += count;
    if (row.lastUsed === null || day > row.lastUsed) row.lastUsed = day;
  }
  const days = snapshot.days.map(day => day.day).sort();
  return { status: "readable", enabled: snapshot.enabled, file, since: days[0] ?? null,
    incompleteDays: snapshot.days.filter(day => !day.complete).length, rows: [...rows.values()], setAside: null };
}

// Privacy's handlers. They have no completion observer, so reading or
// changing the record is never itself counted.
export function usageRecordHandlers(deps: {
  store(): UsageStore | undefined;
  file(): string;
  coverage: readonly UsageBuildPair[];
}): OperationHandlers<typeof usageRecordOperations> {
  function store(): UsageStore {
    const current = deps.store();
    if (!current) throw new Error("dohc has not opened the usage record yet. Open Privacy again.");
    return current;
  }
  return {
    readUsageRecord: async () => {
      const file = deps.file();
      const current = store();
      let result: UsageRecordResult;
      try {
        result = usageRecordView(await current.read(), deps.coverage, file);
      } catch (error) {
        // File and decoding errors leave the record unreadable.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (typeof code !== "string") throw error;
        result = { status: "unreadable", file, code, setAside: null };
      }
      // Restore swaps only a record main read or could not decode.
      if (result.status === "readable" || result.code === INVALID_USAGE_RECORD) result.setAside = await current.newestAside();
      return result;
    },
    clearUsageRecord: () => store().clear(),
    setUsageRecordEnabled: ({ enabled }) => store().setEnabled(enabled),
    startUsageRecord: () => store().startNewRecord(),
    restoreUsageRecord: () => store().restoreSetAside(),
  };
}
