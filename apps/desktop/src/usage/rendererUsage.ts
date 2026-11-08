import { CAPABILITIES, type CapabilityId } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS, USAGE_DOORS, type UsageBuildPair } from "@dohc/workspace-contracts/usage";
import { crashReportOperations, noticeOperations, workspaceVersionOperations } from "../ipc/bridgeContract";
import type { OperationCompletions } from "../ipc/operationTable";

type Invocation = { capabilityId: (typeof USAGE_ACTION_IDS)[number]; door: "renderer" };

// Only these table handlers have a deliberate invocation and a success signal.
// Search follows typing; switch can be automatic. Dismissals do not report
// whether anything changed. All remain explicitly uncovered.
// Compare is a mount/refresh reader. Mark, host choice and path retry can
// return normally without completing their requested change.
export const RENDERER_USAGE_ACTIONS = {
  version: {
    createWorkspaceVersion: workspaceVersionOperations.createWorkspaceVersion.capabilityId,
    mergeWorkspaceVersion: workspaceVersionOperations.mergeWorkspaceVersion.capabilityId,
    resolveWorkspaceVersionConflict: workspaceVersionOperations.resolveWorkspaceVersionConflict.capabilityId,
    saveKeptCopy: workspaceVersionOperations.saveKeptCopy.capabilityId,
  },
  crash: {
    sendCrashReport: crashReportOperations.sendCrashReport.capabilityId,
  },
  notice: {
    runSkippedScheduleNow: noticeOperations.runSkippedScheduleNow.capabilityId,
    retryAutomationNotice: noticeOperations.retryAutomationNotice.capabilityId,
  },
} as const;

const covered = new Set<CapabilityId>(Object.values(RENDERER_USAGE_ACTIONS).flatMap(group => Object.values(group)));
export const RENDERER_USAGE_COVERAGE: readonly UsageBuildPair[] = Object.keys(CAPABILITIES).flatMap(id =>
  USAGE_DOORS.map(door => ({ capabilityId: id as CapabilityId, door,
    status: door === "renderer" && covered.has(id as CapabilityId) ? "covered" as const : "uncovered" as const })));

export function createRendererUsage<Event>(recordSuccess: (input: Invocation) => unknown) {
  function count(id: Invocation["capabilityId"]) {
    recordSuccess({ capabilityId: id, door: "renderer" });
  }
  const version: OperationCompletions<typeof workspaceVersionOperations, Event> = {
    createWorkspaceVersion: () => count(RENDERER_USAGE_ACTIONS.version.createWorkspaceVersion),
    mergeWorkspaceVersion: () => count(RENDERER_USAGE_ACTIONS.version.mergeWorkspaceVersion),
    resolveWorkspaceVersionConflict: () => count(RENDERER_USAGE_ACTIONS.version.resolveWorkspaceVersionConflict),
    saveKeptCopy: (_input, result) => { if (result.status === "saved") count(RENDERER_USAGE_ACTIONS.version.saveKeptCopy); },
  };
  const crash: OperationCompletions<typeof crashReportOperations, Event> = {
    sendCrashReport: (_input, result) => { if (result.sent) count(RENDERER_USAGE_ACTIONS.crash.sendCrashReport); },
  };
  const notice: OperationCompletions<typeof noticeOperations, Event> = {
    runSkippedScheduleNow: (_input, result) => { if (result.note === null) count(RENDERER_USAGE_ACTIONS.notice.runSkippedScheduleNow); },
    retryAutomationNotice: (_input, result) => { if (result.status === "queued") count(RENDERER_USAGE_ACTIONS.notice.retryAutomationNotice); },
  };
  return { version, crash, notice };
}
