import { parentPort } from "node:worker_threads";
import {
  editDatabaseAtPath,
  readDatabasePageAtPath,
  readDatabasePageFromBytesInWorker,
  readDatabaseSnapshotAtPath,
  readDatabaseSnapshotFromBytesInWorker,
} from "./workspaceDatabaseCore.ts";
import type {
  WorkspaceDatabaseWorkerRequest,
  WorkspaceDatabaseWorkerResponse,
  WorkspaceDatabaseWorkerResult,
} from "./workspaceDatabaseProtocol.ts";

const port = parentPort;
if (!port) {
  throw new Error("The workspace database thread requires a worker parent port.");
}

function serializedError(error: unknown): Extract<
  WorkspaceDatabaseWorkerResponse,
  { kind: "error" }
>["error"] {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const code = (error as NodeJS.ErrnoException).code;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(typeof code === "string" ? { code } : {}),
  };
}

async function run(
  request: WorkspaceDatabaseWorkerRequest,
): Promise<WorkspaceDatabaseWorkerResult> {
  switch (request.kind) {
    case "import-data": {
      const { createSqliteEngine } = await import("@dohc/sqlite-worker");
      const engine = await createSqliteEngine();
      const result = await engine.materializeImport(request.input);
      if (!result.ok) throw new Error(`Import failed (${result.code}): ${result.message}`);
      const bytes = Uint8Array.from(result.bytes);
      return { bytes, rowCount: result.rowCount, tableName: result.tableName };
    }
    case "read-path":
      return readDatabaseSnapshotAtPath(
        request.absolutePath,
        request.resultPath,
      );
    case "read-bytes":
      return readDatabaseSnapshotFromBytesInWorker(
        request.bytes,
        request.resultPath,
      );
    case "read-page-path":
      return readDatabasePageAtPath({
        absolutePath: request.absolutePath,
        resultPath: request.resultPath,
        table: request.table,
        offset: request.offset,
      });
    case "read-page-bytes":
      return readDatabasePageFromBytesInWorker({
        bytes: request.bytes,
        resultPath: request.resultPath,
        table: request.table,
        offset: request.offset,
      });
    case "edit-path":
      return editDatabaseAtPath({
        absolutePath: request.absolutePath,
        resultPath: request.resultPath,
        logPath: request.logPath,
        statePath: request.statePath,
        edit: request.edit,
        operation: request.operation,
        pageOffset: request.pageOffset,
      });
  }
}

let sequence = Promise.resolve();

port.on("message", (request: WorkspaceDatabaseWorkerRequest) => {
  sequence = sequence.then(async () => {
    port.postMessage({ id: request.id, kind: "started" });
    try {
      const result = await run(request);
      port.postMessage(
        { id: request.id, kind: "result", result },
        "bytes" in result ? [result.bytes.buffer as ArrayBuffer] : [],
      );
    } catch (error) {
      port.postMessage({
        id: request.id,
        kind: "error",
        error: serializedError(error),
      });
    }
  });
});
