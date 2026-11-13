import { linksOperations } from "./linksOperations";
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
  chatDispatchNoticeOperations,
  updateDownloadOperations,
  agentRunStateOperations,
  stoppedRunOperations,
  chatDispatchPauseOperations,
  agentsListeningOperations,
  personalAgentsOperations,
  crashReportOperations,
  collectionCopiesLeftOperations,
  workspaceTrustOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
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
import { CHANNELS } from "./channels";
import { DECLARATION_FAMILIES } from "@dohc/workspace-contracts/all-declarations";
import type { OperationFamily } from "@dohc/workspace-contracts/operation-declaration";
import type { OperationDefinition, OperationTable } from "./operationTable";
import { shareCopyOperations } from "./shareCopyOperations";
import { accessOperations } from "./accessOperations";
import { workspaceFileOperations } from "./workspaceFileOperations";
import { explorerMenuOperations } from "./explorerMenuOperations";

// Add each migrated table here when B5 replaces its manual registrations.
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
  heldChangeOperations,
  workspaceSyncOperations,
  workspaceFolderNameOperations,
  systemMotionOperations,
  systemPrivacySettingsOperations,
  serverAccountOperations,
  accessOperations,
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
  stopAndRestoreRecoveryOperations,
  engineYDocSaveOperations,
  captureRecoveryOperations,
  fileObservationOperations,
  chatDispatchNoticeOperations,
  agentRunStateOperations,
  stoppedRunOperations,
  chatDispatchPauseOperations,
  agentsListeningOperations,
  personalAgentsOperations,
  scheduleHostOperations,
  noticeOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
  appViewOperations,
] as const satisfies readonly OperationTable[];

// Each channel names one row or one CHANNELS entry. A repeat fails when this module loads.
const rowChannels = OPERATION_TABLES.flatMap((table) =>
  Object.values<OperationDefinition>(table).map((row) => row.channel),
);
const channels = [...Object.values(CHANNELS), ...rowChannels];
const repeated = channels.find((channel, index) => channels.indexOf(channel) !== index);
if (repeated) throw new Error(`${repeated} is declared twice.`);
// A listed family without its table in OPERATION_TABLES fails here.
for (const family of Object.values<OperationFamily>(DECLARATION_FAMILIES)) {
  for (const [name, { ipc }] of Object.entries(family))
    if (!rowChannels.includes(ipc.channel)) throw new Error(`${name} has no IPC row.`);
}
