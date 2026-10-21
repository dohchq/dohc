import type {
  DatabaseEdit,
  DatabaseEditResult,
  DatabaseOperationInput,
  DatabasePageView,
  DatabaseSnapshotView,
} from "./workspaceDatabaseTypes.ts";
import type { ImportDataInput } from "@dohc/sqlite-worker";

export interface DatabaseImportResult {
  bytes: Uint8Array;
  rowCount: number;
  tableName: string;
}

export type WorkspaceDatabaseWorkerRequest =
  | { id: number; kind: "import-data"; input: ImportDataInput }
  | {
      id: number;
      kind: "read-path";
      absolutePath: string;
      resultPath: string;
    }
  | {
      id: number;
      kind: "read-bytes";
      bytes: Uint8Array;
      resultPath: string;
    }
  | {
      id: number;
      kind: "read-page-path";
      absolutePath: string;
      resultPath: string;
      table: string;
      offset: number;
    }
  | {
      id: number;
      kind: "read-page-bytes";
      bytes: Uint8Array;
      resultPath: string;
      table: string;
      offset: number;
    }
  | {
      id: number;
      kind: "edit-path";
      absolutePath: string;
      resultPath: string;
      logPath: string;
      statePath: string;
      edit: DatabaseEdit;
      operation: DatabaseOperationInput;
      pageOffset: number;
    };

export type WorkspaceDatabaseWorkerResult =
  | DatabaseImportResult
  | DatabaseSnapshotView
  | DatabasePageView
  | DatabaseEditResult;

export type WorkspaceDatabaseWorkerResponse =
  | { id: number; kind: "started" }
  | { id: number; kind: "result"; result: WorkspaceDatabaseWorkerResult }
  | {
      id: number;
      kind: "error";
      error: { name: string; message: string; stack?: string; code?: string };
    };

export function isWorkspaceDatabaseWorkerResponse(
  value: unknown,
): value is WorkspaceDatabaseWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) < 0) return false;
  if (candidate.kind === "started") return true;
  if (candidate.kind === "result") return Object.hasOwn(candidate, "result");
  if (candidate.kind !== "error") return false;
  const error = candidate.error;
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as Record<string, unknown>).name === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}
