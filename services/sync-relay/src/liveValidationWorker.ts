import { parentPort } from "node:worker_threads";
import { createLiveMarkdownJournalValidator, type OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
if (!parentPort) throw new Error("Live validation requires a worker.");
parentPort.on("message", ({ policy, input }: { policy: OrderedLiveUpdateCutPolicy; input: Parameters<OwnerOutboxAdmission["validate"]>[0] }) => {
  const result = createLiveMarkdownJournalValidator(policy)(input);
  if (result.kind === "accepted" && input.suffix.length + 1 !== 4095 &&
    input.suffix.reduce((bytes, update) => bytes + update.byteLength, input.candidate.byteLength) < 20_971_520) {
    // Do not invoke the stateUpdate getter or clone its bytes before a checkpoint is due.
    const evidence: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(result.evidence);
    delete evidence.stateUpdate;
    parentPort!.postMessage({ kind: result.kind, evidence: Object.defineProperties({}, evidence) });
  } else {
    parentPort!.postMessage(result);
  }
});
