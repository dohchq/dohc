import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import * as Y from "yjs";
import type {LiveUpdateStructRange} from "@dohc/live-session-contract";
import {compareLiveRestoreContent} from "./liveRestoreContent.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
import {createLiveMarkdownRegistrationValidator} from "./liveDocumentValidation.js";
import type {OrderedLiveUpdateCutPolicy} from "./orderedLiveUpdateCut.js";

type Selected = Parameters<typeof resolveLiveRestorePoint>[0];
type ProposalCapture = {
  selected: Selected;
  accepted: Omit<Selected, "target"> & {target: "accepted"};
  receipt: {point: {journalCursor: number; receiptDigest: string; markdownDigest: string; projectionDigest: string};
    candidateDigest: string; frozenStateDigest: string; pointStateDigest: string;
    beforeStateVector: readonly number[]; afterStateVector: readonly number[]; replacementRanges: readonly LiveUpdateStructRange[];
    nativeSources: readonly {byteLength: number; updateDigest: string}[]};
  assertCurrent(): void;
};
export type LiveRestoreProposalBytes = {candidateBytes: Uint8Array; frozenStateBytes: Uint8Array;
  pointStateBytes: Uint8Array; nativeSourceBytes: readonly Uint8Array[]};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function require(condition: unknown): asserts condition {if (!condition) throw new Error("Restore proposal content differs from its evidence.");}

/** The host adapter supplies an authenticated storage capture and keeps its reservation through admission. */
export function validateLiveRestoreProposal(capture: ProposalCapture, input: LiveRestoreProposalBytes,
  policy: OrderedLiveUpdateCutPolicy, budget: {maxBytes: number; maxEvents: number}) {
  capture.assertCurrent();
  require(Number.isSafeInteger(budget.maxBytes) && budget.maxBytes > 0 && Number.isSafeInteger(budget.maxEvents) && budget.maxEvents > 0);
  require(Array.isArray(input.nativeSourceBytes) && input.nativeSourceBytes.length <= budget.maxEvents &&
    input.nativeSourceBytes.length === capture.receipt.nativeSources.length);
  let bytes = 0;
  const snapshot = (value: Uint8Array) => {
    require(value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer));
    bytes += value.byteLength; require(bytes <= budget.maxBytes);
    return new Uint8Array(value);
  };
  const candidate = snapshot(input.candidateBytes), frozen = snapshot(input.frozenStateBytes), point = snapshot(input.pointStateBytes);
  const native: Uint8Array[] = [];
  for (let i = 0; i < input.nativeSourceBytes.length; i++) native.push(snapshot(input.nativeSourceBytes[i]!));
  const receipt = capture.receipt;
  require(hash(candidate) === receipt.candidateDigest && hash(frozen) === receipt.frozenStateDigest && hash(point) === receipt.pointStateDigest);
  for (let i = 0; i < native.length; i++) require(native[i]!.byteLength === receipt.nativeSources[i]!.byteLength && hash(native[i]!) === receipt.nativeSources[i]!.updateDigest);
  require(isDeepStrictEqual(resolveLiveRestorePoint(capture.selected, policy), receipt.point));
  const binding = capture.selected.binding;
  const document = {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
  const pointValidation = createLiveMarkdownRegistrationValidator(policy)({document, currentPath: binding.currentPath, checkpoint: point});
  if (pointValidation.kind !== "accepted") throw new Error(`Restore proposal point refused: ${pointValidation.reason}.`);
  // The point is a separate native full state. Compare normalized state, including deletion history.
  const result = compareLiveRestoreContent({document, currentPath: binding.currentPath,
    accepted: {target: capture.accepted.target, checkpoint: capture.accepted.checkpoint.bytes, suffix: capture.accepted.events.map(e => e.updateBytes)},
    point: {target: capture.selected.target, checkpoint: capture.selected.checkpoint.bytes, suffix: capture.selected.events.map(e => e.updateBytes)},
    nativeSources: native, frozenState: frozen, candidate, replacementRanges: receipt.replacementRanges,
    pointMarkdownDigest: receipt.point.markdownDigest, pointProjectionDigest: receipt.point.projectionDigest,
    assertCurrent: capture.assertCurrent}, policy, {...budget, maxBytes: budget.maxBytes - point.byteLength});
  require(pointValidation.evidence.stateUpdateSha256 === result.pointStateDigest);
  const frozenDoc = new Y.Doc({gc: false}), restoredDoc = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(frozenDoc, frozen);Y.applyUpdate(restoredDoc, result.stateUpdate);
    // Yrs and Yjs may encode map entries in a different order; compare decoded vectors.
    require(isDeepStrictEqual(Y.decodeStateVector(Y.encodeStateVector(frozenDoc)), Y.decodeStateVector(Uint8Array.from(receipt.beforeStateVector))));
    require(isDeepStrictEqual(Y.decodeStateVector(Y.encodeStateVector(restoredDoc)), Y.decodeStateVector(Uint8Array.from(receipt.afterStateVector))));
    capture.assertCurrent();
    return Object.freeze({content: result, get candidateBytes() {return new Uint8Array(candidate);}});
  } finally {frozenDoc.destroy();restoredDoc.destroy();}
}

export {resolveLiveRestorePoint};
