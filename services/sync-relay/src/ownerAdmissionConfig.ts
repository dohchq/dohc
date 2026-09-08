import {openSync,readSync,closeSync} from "node:fs";
import {isAbsolute} from "node:path";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {createLiveMarkdownJournalValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import type {OrderedLiveUpdateCutPolicy} from "../../../packages/ydoc-projection/src/orderedLiveUpdateCut.js";
import type {OwnerOutboxAdmission} from "./ownerOutboxDelivery.js";
import type {SyncRelayStorage} from "./storage.js";
import type {LiveJournalHistoryAuthority} from "./storage/liveJournalHistory.js";
import type {createDeviceControl} from "./deviceControl.js";
import {configRecord} from "./deviceLiveHostConfig.js";

const policyFields = ["maxStructVisits","maxValueNodeVisits","maxDecodedPayloadByteVisits","maxStructClientGroupVisits","maxDeleteClientGroupVisits","maxDeleteIntervalVisits","maxIndexOperations"];
const positive = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Invalid private owner admission budget.");
  return value;
};
export function readOwnerAdmissionConfig(path: string,workspaceIds: readonly string[]) {
  if (!isAbsolute(path)) throw new Error("Private owner admission configuration path must be absolute.");
  const fd = openSync(path,"r"), buffer = Buffer.alloc(1_048_577);
  let length = 0;
  try {while (length < buffer.length) {const read = readSync(fd,buffer,length,buffer.length-length,null); if (!read) break; length += read;}}
  finally {closeSync(fd);}
  if (length === buffer.length) throw new Error("Private owner admission configuration is too large.");
  const row = configRecord(JSON.parse(buffer.subarray(0,length).toString("utf8")),["version","shares","validation","maxEntriesPerDrain","maxBytesPerDrain","maxDocumentsPerPass","pollIntervalMs","passDeadlineMs"]);
  if (row.version !== 1 || !Array.isArray(row.shares) || !row.shares.length || row.shares.length > 64) throw new Error("Invalid private owner shares.");
  const shares = new Map<string,string>();
  for (const value of row.shares) {
    const item = configRecord(value,["workspaceId","shareId"]), workspaceId = parseLiveUpdateIdentifier(item.workspaceId,"workspace ID");
    if (!workspaceIds.includes(workspaceId) || shares.has(workspaceId)) throw new Error("Private owner workspace is not configured.");
    shares.set(workspaceId,parseLiveUpdateIdentifier(item.shareId,"share ID"));
  }
  const validation = configRecord(row.validation,policyFields);
  for (const field of policyFields) positive(validation[field]);
  const validate = createLiveMarkdownJournalValidator(validation as unknown as OrderedLiveUpdateCutPolicy);
  const admission: OwnerOutboxAdmission = {shares,maxEntriesPerDrain: positive(row.maxEntriesPerDrain),maxBytesPerDrain: positive(row.maxBytesPerDrain),validate};
  return {admission,maxDocumentsPerPass: positive(row.maxDocumentsPerPass),pollIntervalMs: positive(row.pollIntervalMs),passDeadlineMs: positive(row.passDeadlineMs)};
}

/** The private device owner keeps journal progress moving without a public control route. */
export function startOwnerAdmission(options: {
  config: ReturnType<typeof readOwnerAdmissionConfig>; storage: SyncRelayStorage; history: LiveJournalHistoryAuthority;
  control: Pick<ReturnType<typeof createDeviceControl>,"settle">; onError(error: unknown): void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, workspaceIndex = 0, afterObject = "", lastError: string | undefined;
  const stop = new AbortController(), workspaces = [...options.config.admission.shares.keys()];
  const store = options.storage.createLiveCommittedDeliveryStore(options.history);
  const pass = async () => {
    const signal = AbortSignal.any([stop.signal,options.storage.unavailable,AbortSignal.timeout(options.config.passDeadlineMs)]);
    try {
      let visited = 0, completedWorkspaces = 0;
      while (!signal.aborted && visited < options.config.maxDocumentsPerPass && completedWorkspaces < workspaces.length) {
        const workspaceId = workspaces[workspaceIndex]!;
        const document = store.nextOwnerDocument(workspaceId,afterObject);
        if (!document) {afterObject = ""; workspaceIndex = (workspaceIndex+1)%workspaces.length; completedWorkspaces++; continue;}
        afterObject = document.objectId; visited++;
        await options.control.settle(document,signal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!stopped && !options.storage.unavailable.aborted && message !== lastError) {lastError = message; options.onError(error);}
    }
    if (!stopped && !options.storage.unavailable.aborted) {timer = setTimeout(() => {void pass();},options.config.pollIntervalMs); timer.unref();}
  };
  void pass();
  return {close() {stopped = true; stop.abort(); clearTimeout(timer);}};
}
