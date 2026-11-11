import { accessOperations } from "./accessOperations";
import {
  agentRunStateOperations,
  captureRecoveryOperations,
  folderAppOfferOperations,
  historyOperations,
  liveDraftRecoveryOperations,
  workspaceVersionOperations,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { chatOperations } from "./chatOperations";
import { datasetOperations } from "./datasetOperations";
import type { StoppedWorkspaceCall } from "./errorWords";
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
    chatOperations.listChatUnread,
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
    workspaceVersionOperations.countWorkspaceVersionChanges,
    folderAppOfferOperations.getFolderApp,
    workspaceVersionOperations.listKeptCopies,
    workspaceVersionOperations.listRetainedCopies,
    workspaceVersionOperations.listWorkspaceVersionConflicts,
    workspaceVersionOperations.countWorkspaceVersionConflicts,
    workspaceVersionOperations.listWorkspaceVersions,
    workspaceVersionOperations.listNotVersionedFiles,
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

// The dataset operation's actions that change nothing. Its other actions
// change a Collection.
const DATASET_READS: ReadonlySet<unknown> = new Set([
  "list", "describe", "history", "historyRevision", "lifecycle", "pendingAttempts", "permissions",
]);

const field = (payload: unknown, name: string): unknown =>
  typeof payload === "object" && payload !== null ? Reflect.get(payload, name) : undefined;

// A failed call on the workspace the sending window has stopped cannot
// succeed until the stop ends. The window drops a failed read, which lost
// nothing, and reports any other failure without Try again.
// `stoppedWorkspaceId` runs only for a call that names a workspace.
export function stoppedWorkspaceCall(
  channel: string,
  payload: unknown,
  stoppedWorkspaceId: () => string | null,
): StoppedWorkspaceCall | undefined {
  const workspaceId = field(payload, "workspaceId");
  if (typeof workspaceId !== "string" || workspaceId !== stoppedWorkspaceId()) return undefined;
  const read = channel === datasetOperations.dataset.channel
    ? DATASET_READS.has(field(payload, "action"))
    : READ_CHANNELS.has(channel);
  return read ? "read" : "call";
}
