import { CAPABILITIES, type CapabilityId } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS, USAGE_DOORS, type UsageBuildPair } from "@dohc/workspace-contracts/usage";
import { chatDispatchNoticeOperations, crashReportOperations, noticeOperations, workspaceSearchOperations, workspaceVersionOperations } from "../ipc/bridgeContract";
import type { OperationCompletions } from "../ipc/operationTable";

type Invocation = { capabilityId: (typeof USAGE_ACTION_IDS)[number]; door: "renderer" };
type SearchEvent = { sender: object };

// Only these table handlers have a deliberate invocation and a success signal.
// Compare is a mount/refresh reader. Mark, host choice and path retry can
// return normally without completing their requested change.
// Hand-registered handlers and every other door remain explicitly uncovered.
export const RENDERER_USAGE_ACTIONS = {
  version: {
    createWorkspaceVersion: workspaceVersionOperations.createWorkspaceVersion.capabilityId,
    switchWorkspaceVersion: workspaceVersionOperations.switchWorkspaceVersion.capabilityId,
    mergeWorkspaceVersion: workspaceVersionOperations.mergeWorkspaceVersion.capabilityId,
    resolveWorkspaceVersionConflict: workspaceVersionOperations.resolveWorkspaceVersionConflict.capabilityId,
    saveKeptCopy: workspaceVersionOperations.saveKeptCopy.capabilityId,
    tryInWorkspaceVersion: workspaceVersionOperations.tryInWorkspaceVersion.capabilityId,
    dismissTryInVersionReview: workspaceVersionOperations.dismissTryInVersionReview.capabilityId,
  },
  crash: {
    dismissCrashReport: crashReportOperations.dismissCrashReport.capabilityId,
    sendCrashReport: crashReportOperations.sendCrashReport.capabilityId,
  },
  search: { searchWorkspace: workspaceSearchOperations.searchWorkspace.capabilityId },
  dispatch: { dismissChatDispatchNotice: chatDispatchNoticeOperations.dismissChatDispatchNotice.capabilityId },
  notice: {
    runSkippedScheduleNow: noticeOperations.runSkippedScheduleNow.capabilityId,
    retryAutomationNotice: noticeOperations.retryAutomationNotice.capabilityId,
  },
} as const;

const covered = new Set<CapabilityId>(Object.values(RENDERER_USAGE_ACTIONS).flatMap(group => Object.values(group)));
export const RENDERER_USAGE_COVERAGE: readonly UsageBuildPair[] = Object.keys(CAPABILITIES).flatMap(id =>
  USAGE_DOORS.map(door => ({ capabilityId: id as CapabilityId, door,
    status: door === "renderer" && covered.has(id as CapabilityId) ? "covered" as const : "uncovered" as const })));

export function createRendererUsage<Event extends SearchEvent>(recordSuccess: (input: Invocation) => unknown) {
  // One transient id per live sender. No query, workspace, path or identity
  // enters the record. Refused indexing retries never reach this map.
  const acceptedSearch = new WeakMap<object, string>();
  function count(id: Invocation["capabilityId"]) {
    recordSuccess({ capabilityId: id, door: "renderer" });
  }
  const version: OperationCompletions<typeof workspaceVersionOperations, Event> = {
    createWorkspaceVersion: () => count(RENDERER_USAGE_ACTIONS.version.createWorkspaceVersion),
    switchWorkspaceVersion: () => count(RENDERER_USAGE_ACTIONS.version.switchWorkspaceVersion),
    mergeWorkspaceVersion: () => count(RENDERER_USAGE_ACTIONS.version.mergeWorkspaceVersion),
    resolveWorkspaceVersionConflict: () => count(RENDERER_USAGE_ACTIONS.version.resolveWorkspaceVersionConflict),
    saveKeptCopy: (_input, result) => { if (result.status === "saved") count(RENDERER_USAGE_ACTIONS.version.saveKeptCopy); },
    tryInWorkspaceVersion: () => count(RENDERER_USAGE_ACTIONS.version.tryInWorkspaceVersion),
    dismissTryInVersionReview: () => count(RENDERER_USAGE_ACTIONS.version.dismissTryInVersionReview),
  };
  const crash: OperationCompletions<typeof crashReportOperations, Event> = {
    dismissCrashReport: () => count(RENDERER_USAGE_ACTIONS.crash.dismissCrashReport),
    sendCrashReport: (_input, result) => { if (result.sent) count(RENDERER_USAGE_ACTIONS.crash.sendCrashReport); },
  };
  const search: OperationCompletions<typeof workspaceSearchOperations, Event> = {
    searchWorkspace: (input, result, event) => {
      if (result.status !== "accepted" || acceptedSearch.get(event.sender) === input.searchId) return;
      acceptedSearch.set(event.sender, input.searchId);
      count(RENDERER_USAGE_ACTIONS.search.searchWorkspace);
    },
  };
  const dispatch: OperationCompletions<typeof chatDispatchNoticeOperations, Event> = {
    dismissChatDispatchNotice: () => count(RENDERER_USAGE_ACTIONS.dispatch.dismissChatDispatchNotice),
  };
  const notice: OperationCompletions<typeof noticeOperations, Event> = {
    runSkippedScheduleNow: (_input, result) => { if (result.note === null) count(RENDERER_USAGE_ACTIONS.notice.runSkippedScheduleNow); },
    retryAutomationNotice: (_input, result) => { if (result.status === "queued") count(RENDERER_USAGE_ACTIONS.notice.retryAutomationNotice); },
  };
  return { version, crash, search, dispatch, notice };
}
