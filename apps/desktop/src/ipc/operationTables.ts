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
