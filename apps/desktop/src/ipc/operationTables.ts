import {
  chatDispatchNoticeOperations,
  crashReportOperations,
  noticeOperations,
  scheduleHostOperations,
  workspaceSearchOperations,
  workspaceVersionOperations,
} from "./bridgeContract";
import type { OperationTable } from "./operationTable";

// Add each migrated table here when B5 replaces its manual registrations.
export const OPERATION_TABLES = [
  workspaceVersionOperations,
  workspaceSearchOperations,
  crashReportOperations,
  chatDispatchNoticeOperations,
  scheduleHostOperations,
  noticeOperations,
] as const satisfies readonly OperationTable[];
