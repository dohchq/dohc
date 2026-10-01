import { parentPort } from "node:worker_threads";
import { createLiveMarkdownJournalValidator, type OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
import { liveJournalCheckpointDue } from "./storage/liveJournalCheckpoint.js";
if (!parentPort) throw new Error("Live validation requires a worker.");
parentPort.on("message", ({ policy, input }: { policy: OrderedLiveUpdateCutPolicy; input: Parameters<OwnerOutboxAdmission["validate"]>[0] }) => {
  const {retainStateUpdate, ...projectionInput} = input;
  const result = createLiveMarkdownJournalValidator(policy)(projectionInput);
  if (result.kind === "accepted" &&
    !retainStateUpdate && !liveJournalCheckpointDue(input.suffix.length + 1, input.suffix.reduce((bytes, update) => bytes + update.byteLength, input.candidate.byteLength))) {
    // Do not invoke the stateUpdate getter or clone its bytes before a checkpoint is due.
    const evidence: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(result.evidence);
    delete evidence.stateUpdate;
    parentPort!.postMessage({ kind: result.kind, evidence: Object.defineProperties({}, evidence) });
  } else {
    parentPort!.postMessage(result);
  }
});
