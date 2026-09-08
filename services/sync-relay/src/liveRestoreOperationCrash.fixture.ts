import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openRelayDeployment } from "./relayDeployment";
import type { StorageContext } from "./storage/context";
import { beginStopRestore, advanceStopRestoreFence, type StopRestoreIntent } from "./storage/liveRestoreOperation";

const [configPath, intentPath, boundary] = process.argv.slice(2);
const intent = JSON.parse(readFileSync(intentPath!, "utf8")) as StopRestoreIntent;
const { storage } = openRelayDeployment(configPath!);
const context = storage as StorageContext;
if (boundary === "before-operation") process.exit(80);
if (boundary!.startsWith("fence-")) beginStopRestore(context, intent, 40);
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  const relay = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get();
  if (relay && boundary!.endsWith("before-commit")) process.exit(81);
  const result = exec.call(this, sql);
  if (relay && boundary!.endsWith("after-commit")) process.exit(82);
  return result;
};
if (boundary!.startsWith("fence-")) advanceStopRestoreFence(context, { operationId: intent.operationId,
  workspaceId: intent.document.workspaceId, ownerUserId: intent.ownerUserId }, 50);
else beginStopRestore(context, intent, 40);
throw new Error("The selected stop/restore interruption boundary was not reached.");
