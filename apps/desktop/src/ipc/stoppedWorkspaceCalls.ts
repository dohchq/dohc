import { accessOperations } from "./accessOperations";
import {
  agentRunStateOperations,
  captureRecoveryOperations,
  historyOperations,
  liveDraftRecoveryOperations,
  workspaceVersionOperations,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { chatOperations } from "./chatOperations";
import { STOPPED_WORKSPACE, STOPPED_WORKSPACE_READ } from "./errorWords";
import { settingsOperations } from "./settingsOperations";
import { relayShareOperations, sharedChannelOperations, shareProposalOperations } from "./shareOperations";
import { workspaceFileOperations } from "./workspaceFileOperations";

// Workspace reads that change nothing. A window repeats them after workspace
// activity, so a stopped window would report each failure. A channel left off
// this list still reports its failure, as a change that was not saved must.
const READ_CHANNELS: ReadonlySet<string> = new Set([
  ...[
    chatOperations.getChatThreadRevision,
    chatOperations.listChannelThreads,
    chatOperations.listChatBookmarks,
    chatOperations.listChatChannels,
    chatOperations.listChatFollows,
    chatOperations.listChatMessages,
    chatOperations.listChatReactions,
    chatOperations.listChatThreadAttachments,
    chatOperations.listChatThreadDecisions,
    chatOperations.listFileChats,
    sharedChannelOperations.listChatChannelShares,
    sharedChannelOperations.listJoinedSharedChannels,
    shareProposalOperations.listMyShareChanges,
    shareProposalOperations.listShareProposals,
    shareProposalOperations.readShareProposalChanges,
    relayShareOperations.listOwnerLiveDocuments,
    relayShareOperations.listOwnerLiveRefusals,
    accessOperations.getObjectAccess,
    settingsOperations.getWorkspaceSettings,
    settingsOperations.getWorkspaceUiState,
    workspaceFileOperations.listWorkspaceFiles,
    workspaceFileOperations.readWorkspaceText,
    workspaceVersionOperations.compareWorkspaceVersions,
    workspaceVersionOperations.listKeptCopies,
    workspaceVersionOperations.listRetainedCopies,
    workspaceVersionOperations.listWorkspaceVersionConflicts,
    workspaceVersionOperations.listWorkspaceVersions,
    historyOperations.listHistory,
    historyOperations.listVersionLastChanges,
    captureRecoveryOperations.getCaptureRecoveryStatus,
    liveDraftRecoveryOperations.listLiveDraftRecovery,
    agentRunStateOperations.readAgentRunState,
  ].map(row => row.channel),
  CHANNELS.chatDispatchStateForThread,
  CHANNELS.chatRunRecordsForThread,
  CHANNELS.findAutomationCollection,
  CHANNELS.findDatasetCollection,
  CHANNELS.getAgentRunStatus,
  CHANNELS.getCollection,
  CHANNELS.getCollectionAutomationRun,
  CHANNELS.getCollectionRecordHistory,
  CHANNELS.getSyncStatus,
  CHANNELS.listAutomationButtons,
  CHANNELS.listAutomationGroups,
  CHANNELS.listAutomationHolds,
  CHANNELS.listAutomationPeople,
  CHANNELS.listAutomationTargets,
  CHANNELS.listCollectionAutomationRuns,
  CHANNELS.listCollectionAutomations,
  CHANNELS.listCollectionFieldMarks,
  CHANNELS.listCollections,
  CHANNELS.listEngineMoments,
  CHANNELS.listRecordButtons,
  CHANNELS.listServerAutomationHolds,
  CHANNELS.listServerAutomationRuns,
  CHANNELS.listSites,
  CHANNELS.listWorkspaceHeadings,
  CHANNELS.queryCollectionRecords,
  CHANNELS.readEngineMoment,
  CHANNELS.readWorkspaceDatabase,
  CHANNELS.readWorkspaceDatabasePage,
]);

// A call on the workspace the sending window has stopped cannot succeed
// until the stop ends. It keeps its words and gains a code: the window drops
// a failed read, which lost nothing, and reports any other failure without
// Try again. `stoppedWorkspaceId` runs only for a failed call that names a
// workspace.
export function markStoppedWorkspaceCall(
  channel: string,
  payload: unknown,
  error: unknown,
  stoppedWorkspaceId: () => string | null,
): unknown {
  const workspaceId: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "workspaceId") : undefined;
  if (!(error instanceof Error) || typeof workspaceId !== "string" || workspaceId !== stoppedWorkspaceId()) return error;
  const marked = new Error(error.message, { cause: error });
  marked.name = error.name;
  return Object.assign(marked, { code: READ_CHANNELS.has(channel) ? STOPPED_WORKSPACE_READ : STOPPED_WORKSPACE });
}
