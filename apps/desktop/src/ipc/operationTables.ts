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
  folderAppOfferOperations,
  workspaceVersionOperations,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";
import { accessOperations } from "./accessOperations";

// Add each migrated table here when B5 replaces its manual registrations.
export const OPERATION_TABLES = [
  accessOperations,
  workspaceVersionOperations,
  workspaceSearchOperations,
  folderAppOfferOperations,
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
