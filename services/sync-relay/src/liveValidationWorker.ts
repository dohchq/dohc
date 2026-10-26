import {createLiveMarkdownRegistrationValidator} from "@dohc/ydoc-projection/live-journal-validation";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import type {LiveValidationWork} from "./liveValidation.js";
import { liveJournalCheckpointDue } from "./storage/liveJournalCheckpoint.js";
import { validateOrdinaryActivation } from "./storage/ordinaryActivationSource.js";
import { runLiveRestoreWork } from "./liveRestoreValidation.js";
const send = process.send?.bind(process);
if (!send) throw new Error("Live validation requires a child process.");
process.on("message", message => {
  const work = message as LiveValidationWork;
  if (work.kind === "restore") {
    send(runLiveRestoreWork(work.input, work.policy));
    return;
  }
  if (work.kind === "activation") {
    send(validateOrdinaryActivation(work.input, work.policy));
    return;
  }
  if (work.kind === "settlement") {
    const result=createLiveMarkdownRegistrationValidator(work.policy)(work.input);
    send(result.kind === "accepted" ? {kind:"accepted",evidence:{stateUpdateSha256:result.evidence.stateUpdateSha256,
      projectedMarkdownSha256:result.evidence.projectedMarkdownSha256,projectedMarkdownByteLength:result.evidence.projectedMarkdownByteLength}} : result);
    return;
  }
  const {policy,input}=work;
  const {retainStateUpdate, ...projectionInput} = input;
  let result: ReturnType<ReturnType<typeof createLiveMarkdownJournalValidator>>;
  try {result = createLiveMarkdownJournalValidator(policy)(projectionInput);}
  catch (error) {
    // A validator failure is no verdict on the edit: the relay tries it again and names the failure.
    send({kind: "failed", errorClass: error instanceof Error ? error.name : typeof error});
    return;
  }
  if (result.kind === "accepted" &&
    !retainStateUpdate && !liveJournalCheckpointDue(input.suffix.length + 1, input.suffix.reduce((bytes, update) => bytes + update.byteLength, input.candidate.byteLength))) {
    // Do not invoke the stateUpdate getter or clone its bytes before a checkpoint is due.
    const evidence: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(result.evidence);
    delete evidence.stateUpdate;
    send({ kind: result.kind, evidence: Object.defineProperties({}, evidence) });
  } else {
    send(result);
  }
});
