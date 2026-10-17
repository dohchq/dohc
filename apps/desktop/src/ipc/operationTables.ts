import { shareHandoffOperations, shareMountOperations } from "./shareOperations";
import { chatOperations } from "./chatOperations";
import {
  workspaceSyncOperations,
  systemMotionOperations,
  serverAccountOperations,
  chatDispatchNoticeOperations,
  agentRunStateOperations,
  crashReportOperations,
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
  workspaceSearchOperations,
  folderAppOfferOperations,
  workspaceVersionOperations,
  historyOperations,
} from "./bridgeContract";
import { settingsOperations } from "./settingsOperations";
import type { OperationTable } from "./operationTable";
import { shareCopyOperations } from "./shareCopyOperations";
import { accessOperations } from "./accessOperations";
import { workspaceFileOperations } from "./workspaceFileOperations";

// Add each migrated table here when B5 replaces its manual registrations.
export const OPERATION_TABLES = [
  workspaceFileOperations,
  settingsOperations,
  chatOperations,
  shareHandoffOperations,
  shareMountOperations,
  shareCopyOperations,
  workspaceSyncOperations,
  systemMotionOperations,
  serverAccountOperations,
  accessOperations,
  workspaceVersionOperations,
  historyOperations,
  workspaceSearchOperations,
  folderAppOfferOperations,
  crashReportOperations,
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
  scheduleHostOperations,
  noticeOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
] as const satisfies readonly OperationTable[];
