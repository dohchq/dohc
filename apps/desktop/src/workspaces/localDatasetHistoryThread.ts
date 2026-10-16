import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";
import { readLocalDatasetHistory, type LocalDatasetHistoryInput } from "./localDatasetHistory.ts";

const port = parentPort;
if (!port) throw new Error("Collection history is unavailable.");
const { path, workspaceId } = workerData as { path: string; workspaceId: string };
const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
db.exec("PRAGMA busy_timeout=0;");
if (db.prepare("SELECT workspace_id FROM local_dataset_identity WHERE singleton=1").get()?.workspace_id !== workspaceId) {
  db.close();
  throw new Error("This Collection store belongs to another workspace.");
}
port.on("message", (input: LocalDatasetHistoryInput) => {
  try {
    db.exec("BEGIN");
    const result = readLocalDatasetHistory(db, workspaceId, input);
    db.exec("COMMIT");
    port.postMessage({ result });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    port.postMessage({ error: { message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DatasetHostError ? { code: error.code } : {}) } });
  }
});
port.on("close", () => db.close());
