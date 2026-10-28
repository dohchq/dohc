import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS, USAGE_DOORS, UsageVersionCoverage, queryUsage } from "@dohc/workspace-contracts/usage";
import { crashReportOperations, noticeOperations, workspaceVersionOperations } from "../ipc/bridgeContract";
import { createRendererUsage, RENDERER_USAGE_ACTIONS, RENDERER_USAGE_COVERAGE } from "./rendererUsage";

type Event = { sender: object };
const tables = { version: workspaceVersionOperations, crash: crashReportOperations, notice: noticeOperations };

describe("renderer usage", () => {
  it("covers exactly the explicit observers, with issued action ids matching their operation", () => {
    const usage = createRendererUsage<Event>(() => {});
    for (const group of Object.keys(tables) as (keyof typeof tables)[]) {
      expect(Object.keys(usage[group]).sort()).toEqual(Object.keys(RENDERER_USAGE_ACTIONS[group]).sort());
      for (const [name, id] of Object.entries(RENDERER_USAGE_ACTIONS[group])) {
        expect(Object.hasOwn(CAPABILITIES, id)).toBe(true);
        expect(USAGE_ACTION_IDS).toContain(id);
        expect((tables[group] as Record<string, { capabilityId: string }>)[name]!.capabilityId).toBe(id);
      }
    }
    expect(UsageVersionCoverage.safeParse({ appVersion: "0.1.0", pairs: RENDERER_USAGE_COVERAGE }).success).toBe(true);
    expect(RENDERER_USAGE_COVERAGE).toHaveLength(Object.keys(CAPABILITIES).length * USAGE_DOORS.length);
    const ids = Object.values(RENDERER_USAGE_ACTIONS).flatMap(group => Object.values(group));
    expect(ids.toSorted()).toEqual(["version.create", "version.merge", "version.conflict.resolve", "file.kept.save", "crash.send", "automation.schedule.run", "automation.notice.retry"].toSorted());
    expect(RENDERER_USAGE_COVERAGE.filter(pair => pair.status === "covered").map(pair => pair.capabilityId).sort()).toEqual(ids.sort());
  });

  it("leaves all other doors, reads, ambiguous successes and hand-registered actions uncovered", () => {
    for (const pair of RENDERER_USAGE_COVERAGE) {
      if (pair.door !== "renderer") expect(pair.status).toBe("uncovered");
    }
    for (const id of ["version.compare", "notice.mark", "workspace.open.retry", "automation.host.choose", "automation.host.takeover", "file.write", "chat.export", "file.read", "notice.list", "version.list"]) {
      expect(RENDERER_USAGE_COVERAGE.find(pair => pair.capabilityId === id && pair.door === "renderer")?.status).toBe("uncovered");
    }
    const usage = createRendererUsage<Event>(() => {});
    expect(usage.version).not.toHaveProperty("listWorkspaceVersions");
    expect(usage.crash).not.toHaveProperty("readCrashReport");
    expect(usage.notice).not.toHaveProperty("listNotices");
    expect(JSON.stringify(usage)).not.toContain("usage.read");
  });

  it("reports uncovered rows as null instead of zero", () => {
    const rows = queryUsage({ version: 1, enabled: true, cleanExit: true,
      days: [{ day: "2026-10-07", appVersions: ["0.1.0"], complete: true }], counts: [],
      coverage: [{ appVersion: "0.1.0", pairs: [...RENDERER_USAGE_COVERAGE] }],
    }, { from: "2026-10-07", through: "2026-10-07", pairs: [
      { capabilityId: "version.create", door: "renderer" },
      { capabilityId: "version.compare", door: "renderer" },
      { capabilityId: "version.create", door: "cli" },
    ] });
    expect(rows.map(row => [row.daily[0]!.status, row.total])).toEqual([
      ["covered", 0], ["uncovered", null], ["uncovered", null],
    ]);
  });

  it("reports typing, automatic switches and unconfirmed dismissals as unknown use", () => {
    const ids = ["search.start", "version.switch", "crash.dismiss", "chat.dispatch.notice.dismiss"] as const;
    const rows = queryUsage({ version: 1, enabled: true, cleanExit: true,
      days: [{ day: "2026-10-07", appVersions: ["0.1.0"], complete: true }], counts: [],
      coverage: [{ appVersion: "0.1.0", pairs: [...RENDERER_USAGE_COVERAGE] }],
    }, { from: "2026-10-07", through: "2026-10-07", pairs: ids.map(capabilityId => ({ capabilityId, door: "renderer" })) });
    expect(rows).toHaveLength(ids.length);
    for (const row of rows) {
      expect(row).toMatchObject({ total: null, usedDays: null, coveredDays: 0 });
      expect(row.daily[0]!.status).toBe("uncovered");
    }
    const usage = createRendererUsage<Event>(() => {});
    expect(usage).not.toHaveProperty("search");
    expect(usage).not.toHaveProperty("dispatch");
    expect(usage.version).not.toHaveProperty("switchWorkspaceVersion");
    expect(usage.crash).not.toHaveProperty("dismissCrashReport");
  });

  it("records each unconditional deliberate command once without its data", () => {
    const record = vi.fn();
    const usage = createRendererUsage<Event>(record);
    const event = { sender: {} };
    const workspace = { workspaceId: "PRIVATE WORKSPACE" };
    const versions = { versions: [], activeVersionId: "PRIVATE VERSION" };
    usage.version.createWorkspaceVersion!({ ...workspace, name: "PRIVATE NAME" }, versions, event);
    usage.version.mergeWorkspaceVersion!({ ...workspace, versionId: "PRIVATE VERSION" }, { mergedFileCount: 0, unchangedFileCount: 0, conflictCount: 0, conflicts: [], nextAfterConflictId: null }, event);
    usage.version.resolveWorkspaceVersionConflict!({ ...workspace, conflictId: "PRIVATE CONFLICT", resolution: { kind: "keep-current" } }, { conflicts: [], nextAfterConflictId: null }, event);
    expect(record.mock.calls.map(([row]) => row)).toEqual([
      ...["version.create", "version.merge", "version.conflict.resolve"]
        .map(capabilityId => ({ capabilityId, door: "renderer" })),
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain("PRIVATE");
  });

  it("excludes unsuccessful result variants", () => {
    const record = vi.fn();
    const usage = createRendererUsage<Event>(record);
    const event = { sender: {} };
    usage.version.saveKeptCopy!({ workspaceId: "workspace", id: 1 }, { status: "gone" }, event);
    usage.version.saveKeptCopy!({ workspaceId: "workspace", id: 1 }, { status: "no-valid-name" }, event);
    usage.crash.sendCrashReport!({}, { sent: false }, event);
    const notice = { store: "local" as const, noticeId: "notice" };
    usage.notice.runSkippedScheduleNow!({ notice, account: null }, { note: "Not started" }, event);
    usage.notice.retryAutomationNotice!({ notice, account: null, startOver: false }, { status: "refused", reason: "Refused" }, event);
    usage.notice.retryAutomationNotice!({ notice, account: null, startOver: false }, { status: "definition-changed", repeatsMessages: false }, event);
    expect(record).not.toHaveBeenCalled();
    usage.version.saveKeptCopy!({ workspaceId: "workspace", id: 1 }, { status: "saved", path: "PRIVATE PATH" }, event);
    usage.crash.sendCrashReport!({}, { sent: true }, event);
    usage.notice.runSkippedScheduleNow!({ notice, account: null }, { note: null }, event);
    usage.notice.retryAutomationNotice!({ notice, account: null, startOver: false }, { status: "queued", press: false }, event);
    expect(record.mock.calls.map(([row]) => row)).toEqual([
      { capabilityId: "file.kept.save", door: "renderer" }, { capabilityId: "crash.send", door: "renderer" },
      { capabilityId: "automation.schedule.run", door: "renderer" }, { capabilityId: "automation.notice.retry", door: "renderer" },
    ]);
  });
});
