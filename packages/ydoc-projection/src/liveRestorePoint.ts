import {createHash} from "node:crypto";
import * as Y from "yjs";
import {yDocToMarkdown} from "./import-export.js";
import {createLiveMarkdownRegistrationValidator, createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
import type {OrderedLiveUpdateCutPolicy} from "./orderedLiveUpdateCut.js";
import type {RestorePointCapture} from "../../../services/sync-relay/src/storage/liveCommittedDelivery.js";

/** Resolves a retained point without using a checkpoint from its future. */
export function resolveLiveRestorePoint(capture: RestorePointCapture, policy: OrderedLiveUpdateCutPolicy) {
  capture.assertCurrent();
  const {workspaceId, mainVersionId, objectId, lineageClaimId, currentPath} = capture.binding;
  const document = {workspaceId, mainVersionId, objectId, lineageClaimId};
  const last = capture.events.at(-1);
  const result = last
    ? createLiveMarkdownJournalValidator(policy)({document, currentPath, checkpoint: capture.checkpoint.bytes,
      suffix: capture.events.slice(0, -1).map(event => event.updateBytes), candidate: last.updateBytes})
    : createLiveMarkdownRegistrationValidator(policy)({document, currentPath, checkpoint: capture.checkpoint.bytes});
  if (result.kind !== "accepted") throw new Error(`Restore point validation refused: ${result.reason}.`);
  const scratch = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(scratch, result.evidence.stateUpdate);
    const projection = yDocToMarkdown(scratch);
    capture.assertCurrent();
    return Object.freeze({...capture.point, markdownDigest: result.evidence.projectedMarkdownSha256,
      projectionDigest: createHash("sha256").update(projection).digest("hex")});
  } finally {scratch.destroy();}
}
