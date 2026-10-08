import {createLiveMarkdownRegistrationValidator} from "@dohc/ydoc-projection/live-journal-validation";
import { parentPort } from "node:worker_threads";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import type {LiveValidationWork} from "./liveValidation.js";
import { liveJournalCheckpointDue } from "./storage/liveJournalCheckpoint.js";
if (!parentPort) throw new Error("Live validation requires a worker.");
parentPort.on("message", (work:LiveValidationWork) => {
  if (work.kind === "settlement") {
    const result=createLiveMarkdownRegistrationValidator(work.policy)(work.input);
    parentPort!.postMessage(result.kind === "accepted" ? {kind:"accepted",evidence:{stateUpdateSha256:result.evidence.stateUpdateSha256,
      projectedMarkdownSha256:result.evidence.projectedMarkdownSha256,projectedMarkdownByteLength:result.evidence.projectedMarkdownByteLength}} : result);
    return;
  }
  const {policy,input}=work;
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
