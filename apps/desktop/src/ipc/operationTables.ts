import {
  chatDispatchNoticeOperations,
  crashReportOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
  engineYDocSaveOperations,
  captureRecoveryOperations,
  noticeOperations,
  reportingOperations,
  scheduleHostOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
  workspaceSearchOperations,
  workspaceVersionOperations,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";
import { shareCopyOperations } from "./shareCopyOperations";
import { accessOperations } from "./accessOperations";

// Add each migrated table here when B5 replaces its manual registrations.
export const OPERATION_TABLES = [
  shareCopyOperations,
  accessOperations,
  workspaceVersionOperations,
  workspaceSearchOperations,
  crashReportOperations,
  reportingOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
  engineYDocSaveOperations,
  captureRecoveryOperations,
  chatDispatchNoticeOperations,
  scheduleHostOperations,
  noticeOperations,
  sharedViewAccessOperations,
  shareDirectWriteDeliveryOperations,
] as const satisfies readonly OperationTable[];
