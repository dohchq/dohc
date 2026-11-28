import { captureOperations } from "./captureOperations";
import { linksOperations } from "./linksOperations";
import { drawingOperations } from "./drawingOperations";
import { retrievalOperations } from "./retrievalOperations";
import { agentRunHistoryOperations } from "./agentRunHistoryOperations";
import { heldChangeOperations } from "./heldChangeOperations";
import {
  shareHandoffOperations,
  shareMountOperations,
  shareProposalOperations,
  sharedChannelOperations,
  relayShareOperations,
} from "./shareOperations";
import { datasetOperations } from "./datasetOperations";
import { chatOperations } from "./chatOperations";
import {
  databaseImportOperations,
  workspaceSyncOperations,
  workspaceFolderNameOperations,
  systemMotionOperations,
  systemPrivacySettingsOperations,
  serverAccountOperations,
  connectServerOperations,
  chatDispatchNoticeOperations,
  phoneAppOperations,
  updateDownloadOperations,
  agentRunStateOperations,
  chatDispatchPauseOperations,
  agentThreadOperations,
  agentsListeningOperations,
  personalAgentsOperations,
  crashReportOperations,
  collectionCopiesLeftOperations,
  workspaceTrustOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
  setAsideDraftOperations,
  stopAndRestoreRecoveryOperations,
  engineYDocSaveOperations,
  captureRecoveryOperations,
  fileObservationOperations,
  noticeOperations,
  reportingOperations,
  scheduleHostOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
  usageRecordOperations,
  oldWindowOperations,
  workLinkOperations,
  workspaceSearchOperations,
  folderAppOfferOperations,
  workspaceVersionOperations,
  historyOperations,
  appViewOperations,
} from "./bridgeContract";
import { settingsOperations } from "./settingsOperations";
import {
  agentRunUndoOperations,
  liveNoteOperations,
  noteFormatOperations,
  protectedCopyOperations,
  stoppedRunOperations,
} from "./writeOperations";
import { CHANNELS } from "./channels";
import { DECLARATION_FAMILIES } from "@dohc/workspace-contracts/all-declarations";
import type { OperationFamily } from "@dohc/workspace-contracts/operation-declaration";
import { WRITE_DECLARATION_FAMILIES } from "@dohc/workspace-contracts/all-write-declarations";
import type { WriteFamily } from "@dohc/workspace-contracts/write-declaration";
import type { OperationDefinition, OperationTable } from "./operationTable";
import { shareCopyOperations } from "./shareCopyOperations";
import { accessOperations } from "./accessOperations";
import { memberOperations } from "./memberOperations";
import { directMessageOperations } from "./directMessageOperations";
import { workspaceFileOperations } from "./workspaceFileOperations";
import { workspaceSecretsOperations } from "./workspaceSecretsOperations";
import { incomingWebhooksOperations } from "./incomingWebhooksOperations";
import {
  inboxDesktopOperations,
  inboxReadOperations,
  inboxWriteOperations,
} from "./inboxOperations";
import { explorerMenuOperations } from "./explorerMenuOperations";
import { memberAppsReadOperations, memberAppsWriteOperations } from "./memberAppsOperations";

export const OPERATION_TABLES = [
  workspaceFileOperations,
  explorerMenuOperations,
  settingsOperations,
  chatOperations,
  datasetOperations,
  databaseImportOperations,
  shareHandoffOperations,
  shareMountOperations,
  shareProposalOperations,
  sharedChannelOperations,
  relayShareOperations,
  shareCopyOperations,
  linksOperations,
  retrievalOperations,
  captureOperations,
  drawingOperations,
  agentRunHistoryOperations,
  heldChangeOperations,
  workspaceSyncOperations,
  workspaceFolderNameOperations,
  systemMotionOperations,
  systemPrivacySettingsOperations,
  serverAccountOperations,
  connectServerOperations,
  accessOperations,
  memberOperations,
  directMessageOperations,
  updateDownloadOperations,
  workspaceVersionOperations,
  historyOperations,
  workspaceSearchOperations,
  folderAppOfferOperations,
  crashReportOperations,
  collectionCopiesLeftOperations,
  workspaceTrustOperations,
  oldWindowOperations,
  workLinkOperations,
  reportingOperations,
  usageRecordOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
  setAsideDraftOperations,
  stopAndRestoreRecoveryOperations,
  engineYDocSaveOperations,
  captureRecoveryOperations,
  fileObservationOperations,
  chatDispatchNoticeOperations,
  phoneAppOperations,
  agentRunStateOperations,
  stoppedRunOperations,
  protectedCopyOperations,
  agentRunUndoOperations,
  liveNoteOperations,
  noteFormatOperations,
  chatDispatchPauseOperations,
  agentThreadOperations,
  agentsListeningOperations,
  personalAgentsOperations,
  scheduleHostOperations,
  workspaceSecretsOperations,
  incomingWebhooksOperations,
  inboxReadOperations,
  inboxWriteOperations,
  inboxDesktopOperations,
  noticeOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
  appViewOperations,
  memberAppsReadOperations,
  memberAppsWriteOperations,
] as const satisfies readonly OperationTable[];

// Each channel names one row or one CHANNELS entry. A repeat fails when this module loads.
const rowChannels = OPERATION_TABLES.flatMap((table) =>
  Object.values<OperationDefinition>(table).map((row) => row.channel),
);
const channels = [...Object.values(CHANNELS), ...rowChannels];
const repeated = channels.find((channel, index) => channels.indexOf(channel) !== index);
if (repeated) throw new Error(`${repeated} is declared twice.`);
for (const family of Object.values<OperationFamily>(DECLARATION_FAMILIES)) {
  for (const [name, { ipc }] of Object.entries(family))
    if (!rowChannels.includes(ipc.channel)) throw new Error(`${name} has no IPC row.`);
}
for (const family of Object.values<WriteFamily>(WRITE_DECLARATION_FAMILIES)) {
  for (const [name, { ipc }] of Object.entries(family))
    if (!("none" in ipc) && !rowChannels.includes(ipc.channel))
      throw new Error(`${name} has no IPC row.`);
}
