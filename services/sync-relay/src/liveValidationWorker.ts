import {createLiveMarkdownRegistrationValidator} from "@dohc/ydoc-projection/live-journal-validation";
import { parentPort } from "node:worker_threads";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import type {LiveValidationWork} from "./liveValidation.js";
import {validateLiveRestoreProposal} from "@dohc/ydoc-projection/restore-proof";
import { liveJournalCheckpointDue } from "./storage/liveJournalCheckpoint.js";
if (!parentPort) throw new Error("Live validation requires a worker.");
parentPort.on("message", (work:LiveValidationWork) => {
  if (work.kind === "restore") {
    const artifacts = new Map(work.input.artifacts);
    class ArtifactRequired extends Error {constructor(readonly digest: string) {super("Restore artifact required.");}}
    const artifact = (digest: string) => {
      if (!artifacts.has(digest)) throw new ArtifactRequired(digest);
      return artifacts.get(digest);
    };
    const assertCurrent = () => {}; // The parent pins the captured storage reads until its admission transaction.
    const capture = {...work.input.capture, assertCurrent,
      selected: {...work.input.capture.selected, assertCurrent, artifact},
      accepted: {...work.input.capture.accepted, assertCurrent, artifact}};
    try {
      const validated = validateLiveRestoreProposal(capture, work.input.bytes, work.policy, work.input.budget);
      const binding = capture.selected.binding;
      const normalized = createLiveMarkdownRegistrationValidator(work.settlementPolicy)({document: {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
        objectId: binding.objectId, lineageClaimId: binding.lineageClaimId},
        currentPath: binding.currentPath, checkpoint: validated.content.stateUpdate});
      if (normalized.kind === "refused" && normalized.reason === "capacity-refused") {
        parentPort!.postMessage({kind: "capacity-refused"});
      } else {
        parentPort!.postMessage({kind: "accepted", validated: {content: validated.content,
          candidateBytes: validated.candidateBytes, nativeSourceRanges: validated.nativeSourceRanges},
          ...(work.input.maxOutputBytes === undefined ? {} : {reviewContent: validated.projectReview(work.input.maxOutputBytes)})});
      }
    } catch (error) {
      parentPort!.postMessage(error instanceof ArtifactRequired ? {kind: "artifact-required", digest: error.digest}
        : {kind: "invalid", message: error instanceof Error ? error.message : String(error)});
    }
    return;
  }
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
