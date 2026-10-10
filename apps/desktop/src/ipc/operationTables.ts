import {
  chatDispatchNoticeOperations,
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
  workspaceVersionOperations,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";
import { accessOperations } from "./accessOperations";

// Add each migrated table here when B5 replaces its manual registrations.
export const OPERATION_TABLES = [
  accessOperations,
  workspaceVersionOperations,
  workspaceSearchOperations,
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
  scheduleHostOperations,
  noticeOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
] as const satisfies readonly OperationTable[];
