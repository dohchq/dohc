import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openRelayDeployment } from "./relayDeployment";
import type { StorageContext } from "./storage/context";
import { beginStopRestore, advanceStopRestoreFence, type StopRestoreIntent } from "./storage/liveRestoreOperation";

const [configPath, intentPath, boundary] = process.argv.slice(2);
const intent = JSON.parse(readFileSync(intentPath!, "utf8")) as StopRestoreIntent;
const { storage, history } = openRelayDeployment(configPath!);
const context = storage as StorageContext;
if (boundary === "before-operation") process.exit(80);
if (boundary!.startsWith("fence-") || boundary!.startsWith("complete-")) beginStopRestore(context, intent, 40);
const lookup = {operationId:intent.operationId,workspaceId:intent.document.workspaceId,ownerUserId:intent.ownerUserId};
let finish: (()=>void) | undefined;
if (boundary!.startsWith("complete-")) {
  advanceStopRestoreFence(context,lookup,50);
  const host = storage.getLiveHostControl()!;
  const store = storage.createLiveCommittedDeliveryStore(history);
  const opened = store.openStopRestoreCut({...lookup,host:{mode:host.configuredMode,hostId:host.configuredHostId,hostEpoch:host.hostEpoch,instanceId:host.registeredInstanceId!,connectionId:host.registeredConnectionId!}});
  if(opened.kind!=="ready")throw new Error("Missing restore capture.");
  const next=store.nextStopRestoreCut(opened.capture);
  if(next.kind!=="bootstrap")throw new Error("Expected empty bootstrap.");
  store.acknowledgeStopRestoreBootstrap(opened.capture,{bootstrapId:next.baseline.bootstrapId,bootstrapMomentId:next.baseline.bootstrapMomentId,
    baselineDigest:next.baseline.baselineDigest,baselineMomentRelaySequence:next.baseline.baselineMomentRelaySequence,localYDocSequence:0,bootstrapReplayed:false});
  finish=()=>{store.completeStopRestoreCut(opened.capture);};
}
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql: string) {
  const relay = sql === "COMMIT" && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get();
  if (relay && boundary!.endsWith("before-commit")) process.exit(81);
  const result = exec.call(this, sql);
  if (relay && boundary!.endsWith("after-commit")) process.exit(82);
  return result;
};
if (finish) finish();
else if (boundary!.startsWith("fence-")) advanceStopRestoreFence(context, { operationId: intent.operationId,
  workspaceId: intent.document.workspaceId, ownerUserId: intent.ownerUserId }, 50);
else beginStopRestore(context, intent, 40);
throw new Error("The selected stop/restore interruption boundary was not reached.");
