import { isAppBackendRuntimeError } from "./protocol.js";
import { AppBackendLimitError } from "@dohc/security-contract/app-backend";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-error";
import type { OperationMetrics } from "./persistent-protocol.js";

export const DATASET_TRACE_CAPACITY = 200;

export interface DatasetTraceEntry {
  atMs: number;
  operation: string;
  durationMs: number;
  statementCount: number;
  rowsRead: number;
  changesetBytes: number;
  callerKind: string;
  revision: number | null;
  status: "ok" | "refused" | "error";
  refusalCode: string | null;
}

export function traceSuccess(
  operation: string,
  callerKind: string,
  startedMs: number,
  revision: number,
  metrics?: OperationMetrics,
  changesetBytes = 0,
): DatasetTraceEntry {
  return {
    atMs: Date.now(),
    operation,
    durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
    statementCount: metrics?.statementCount ?? 0,
    rowsRead: metrics?.rowsRead ?? 0,
    changesetBytes,
    callerKind,
    revision,
    status: "ok",
    refusalCode: null,
  };
}

export function traceFailure(
  operation: string,
  callerKind: string,
  startedMs: number,
  error: unknown,
): DatasetTraceEntry {
  const refusalCode = isAppBackendRuntimeError(error)
    ? error.refusal.code
    : error instanceof AppBackendLimitError
      ? "resource_limit"
      : error instanceof DatasetHostError
        ? error.code
        : null;
  return {
    atMs: Date.now(),
    operation,
    durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
    statementCount: 0,
    rowsRead: 0,
    changesetBytes: 0,
    callerKind,
    revision: null,
    status: refusalCode ? "refused" : "error",
    refusalCode,
  };
}

export function createDatasetTraceBuffer(capacity = DATASET_TRACE_CAPACITY, maxDatasets = 256) {
  const entries = new Map<string, DatasetTraceEntry[]>();
  return {
    record(datasetId: string, entry: DatasetTraceEntry): void {
      let list = entries.get(datasetId);
      if (list) entries.delete(datasetId);
      else {
        if (entries.size >= maxDatasets) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        list = [];
      }
      list.push(entry);
      if (list.length > capacity) list.splice(0, list.length - capacity);
      entries.set(datasetId, list);
    },
    list(datasetId: string, limit = 50): DatasetTraceEntry[] {
      const list = entries.get(datasetId);
      if (!list?.length) return [];
      return list.slice(-Math.max(1, Math.min(capacity, Math.trunc(limit)))).reverse();
    },
    clear(datasetId: string): void {
      entries.delete(datasetId);
    },
  };
}
