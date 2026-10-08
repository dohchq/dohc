import {
  chatDispatchNoticeOperations,
  crashReportOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
  noticeOperations,
  reportingOperations,
  scheduleHostOperations,
  sharedViewAccessOperations,
  workspaceSearchOperations,
  workspaceVersionOperations,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";

// Add each migrated table here when B5 replaces its manual registrations.
export const OPERATION_TABLES = [
  workspaceVersionOperations,
  workspaceSearchOperations,
  crashReportOperations,
  reportingOperations,
  engineYDocAdmissionOperations,
  liveDraftRecoveryOperations,
  chatDispatchNoticeOperations,
  scheduleHostOperations,
  noticeOperations,
  sharedViewAccessOperations,
] as const satisfies readonly OperationTable[];
