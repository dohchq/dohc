import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS, USAGE_DOORS, UsageVersionCoverage, queryUsage } from "@dohc/workspace-contracts/usage";
import { chatDispatchNoticeOperations, crashReportOperations, noticeOperations, workspaceSearchOperations, workspaceVersionOperations } from "../ipc/bridgeContract";
import { registerOperations, type OperationHandlers } from "../ipc/operationTable";
import { createRendererUsage, RENDERER_USAGE_ACTIONS, RENDERER_USAGE_COVERAGE } from "./rendererUsage";

type Event = { sender: object };
const tables = { version: workspaceVersionOperations, crash: crashReportOperations, search: workspaceSearchOperations, dispatch: chatDispatchNoticeOperations, notice: noticeOperations };

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

  it("counts accepted searches once per live sender and search, excluding indexing resends", async () => {
    const record = vi.fn();
    const usage = createRendererUsage<Event>(record);
    const sender = {};
    const event = { sender };
    let listener!: (event: Event, input: unknown) => Promise<unknown>;
    const search = vi.fn<OperationHandlers<typeof workspaceSearchOperations, Event>["searchWorkspace"]>();
    registerOperations({
      handle: (channel, fn) => { if (channel === workspaceSearchOperations.searchWorkspace.channel) listener = fn; },
      assertTrustedSender: () => {}, withActiveWorkspace: async (_event, _id, _message, work) => work({}),
    }, workspaceSearchOperations, { searchWorkspace: search, cancelWorkspaceSearch: () => {} }, usage.search);
    const input = { workspaceId: "workspace-a", searchId: "search-a", query: "PRIVATE QUERY" };
    search.mockResolvedValue({ status: "refused", code: "workspace-updating" });
    await listener(event, input);
    await listener(event, input);
    expect(record).not.toHaveBeenCalled();
    search.mockResolvedValue({ status: "accepted" });
    await listener(event, input);
    await listener(event, input);
    expect(record).toHaveBeenCalledExactlyOnceWith({ capabilityId: "search.start", door: "renderer" });
    await listener(event, { ...input, searchId: "search-b" });
    await listener({ sender: {} }, input);
    expect(record).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/PRIVATE|workspace-a|search-a/);
  });

  it("records each unconditional deliberate command once without its data", () => {
    const record = vi.fn();
    const usage = createRendererUsage<Event>(record);
    const event = { sender: {} };
    const workspace = { workspaceId: "PRIVATE WORKSPACE" };
    const versions = { versions: [], activeVersionId: "PRIVATE VERSION" };
    usage.version.createWorkspaceVersion!({ ...workspace, name: "PRIVATE NAME" }, versions, event);
    usage.version.switchWorkspaceVersion!({ ...workspace, versionId: "PRIVATE VERSION" }, { activeVersionId: "PRIVATE VERSION", changedFileCount: 0 }, event);
    usage.version.mergeWorkspaceVersion!({ ...workspace, versionId: "PRIVATE VERSION" }, { mergedFileCount: 0, unchangedFileCount: 0, conflictCount: 0, conflicts: [], nextAfterConflictId: null }, event);
    usage.version.resolveWorkspaceVersionConflict!({ ...workspace, conflictId: "PRIVATE CONFLICT", resolution: { kind: "keep-current" } }, { conflicts: [], nextAfterConflictId: null }, event);
    usage.version.tryInWorkspaceVersion!({ ...workspace, task: "PRIVATE TASK" }, { versionId: "PRIVATE VERSION", versionName: "PRIVATE NAME", runId: "PRIVATE RUN" }, event);
    usage.version.dismissTryInVersionReview!(workspace, undefined, event);
    usage.crash.dismissCrashReport!({ through: 1 }, undefined, event);
    usage.dispatch.dismissChatDispatchNotice!({ ...workspace, id: "PRIVATE NOTICE" }, undefined, event);
    expect(record.mock.calls.map(([row]) => row)).toEqual([
      ...["version.create", "version.switch", "version.merge", "version.conflict.resolve", "version.try", "version.try.dismiss", "crash.dismiss", "chat.dispatch.notice.dismiss"]
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
