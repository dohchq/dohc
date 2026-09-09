import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {LiveDocumentKey, LiveUpdateStructRange} from "@dohc/live-session-contract";
import * as Y from "yjs";
import {yXmlFragmentToProseMirrorRootNode} from "y-prosemirror";
import {getDohcProseMirrorSchema, yDocToMarkdown} from "./import-export.js";
import {createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator} from "./liveDocumentValidation.js";
import {MAX_OLD_SUFFIX_ENTRIES, type OrderedLiveUpdateCutPolicy} from "./orderedLiveUpdateCut.js";

type Cut = {checkpoint: Uint8Array; suffix: readonly Uint8Array[]};
type RestoreContentInput = {
  document: LiveDocumentKey;
  currentPath: string;
  accepted: Cut & {target: "accepted"};
  point: Cut & {target: "selected"};
  nativeSources: readonly Uint8Array[];
  frozenState: Uint8Array;
  candidate: Uint8Array;
  replacementRanges: readonly LiveUpdateStructRange[];
  pointMarkdownDigest: string;
  pointProjectionDigest: string;
  assertCurrent(): void;
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function refuse(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Restore content refused: ${detail}.`);
}

function frontmatterStructure(map: Y.Map<unknown>): unknown {
  let remaining = 262_144;
  const value = (node: unknown, depth: number): unknown => {
    refuse(depth <= 128 && remaining-- > 0, "frontmatter traversal budget");
    if (node instanceof Y.Map) {
      return {kind: "map", entries: [...node.keys()].sort().map(key => [key, value(node.get(key), depth + 1)])};
    }
    if (node instanceof Y.Array) return {kind: "array", values: node.toArray().map(child => value(child, depth + 1))};
    return {kind: "value", value: node};
  };
  return {kind: "map", entries: [...map.keys()].sort().map(key => [key, value(map.get(key), 0)])};
}

/** Content proof only. The caller must separately authenticate the operation, host and source receipts. */
export function compareLiveRestoreContent(input: RestoreContentInput, policy: OrderedLiveUpdateCutPolicy,
  budget: {maxBytes: number; maxEvents: number}) {
  input.assertCurrent();
  input = {...input, accepted: {...input.accepted}, point: {...input.point}};
  refuse(Number.isSafeInteger(budget.maxBytes) && budget.maxBytes > 0 &&
    Number.isSafeInteger(budget.maxEvents) && budget.maxEvents > 0, "invalid budget");
  refuse(input.accepted.target === "accepted" && input.point.target === "selected", "history target differs");
  const copyUpdates = (updates: readonly Uint8Array[]) => {
    const length = updates.length;
    refuse(Array.isArray(updates) && Number.isSafeInteger(length) && length >= 0 &&
      length <= MAX_OLD_SUFFIX_ENTRIES && length <= budget.maxEvents, "event budget");
    const copy: Uint8Array[] = [];
    for (let index = 0; index < length; index++) copy.push(updates[index]!);
    return copy;
  };
  input = {...input, accepted: {...input.accepted, suffix: copyUpdates(input.accepted.suffix)},
    point: {...input.point, suffix: copyUpdates(input.point.suffix)}, nativeSources: copyUpdates(input.nativeSources)};
  const contextCount = input.accepted.suffix.length + input.nativeSources.length;
  refuse(contextCount <= MAX_OLD_SUFFIX_ENTRIES &&
    contextCount + input.point.suffix.length <= budget.maxEvents, "event budget");
  const contextSuffix = [...input.accepted.suffix, ...input.nativeSources];
  // Charge every independent proof input, including repeated checkpoint bytes, before validation or scratch allocation.
  let bytes = 0;
  for (const update of [input.accepted.checkpoint, ...contextSuffix, input.point.checkpoint, ...input.point.suffix,
    input.frozenState, input.candidate]) {
    refuse(update instanceof Uint8Array && !(update.buffer instanceof SharedArrayBuffer), "invalid bytes");
    bytes += update.byteLength;
    refuse(Number.isSafeInteger(bytes) && bytes <= budget.maxBytes, "byte budget");
  }
  const document = {...input.document}, currentPath = input.currentPath;
  const registration = createLiveMarkdownRegistrationValidator(policy), journal = createLiveMarkdownJournalValidator(policy);
  const cut = (value: Cut) => {
    const candidate = value.suffix.at(-1);
    const result = candidate === undefined
      ? registration({document, currentPath, checkpoint: value.checkpoint})
      : journal({document, currentPath, checkpoint: value.checkpoint, suffix: value.suffix.slice(0, -1), candidate});
    if (result.kind !== "accepted") throw new Error(`Restore content refused: ${result.reason}.`);
    return result.evidence;
  };
  const context = cut({checkpoint: input.accepted.checkpoint, suffix: contextSuffix});
  const frozen = registration({document, currentPath, checkpoint: input.frozenState});
  if (frozen.kind !== "accepted") throw new Error(`Restore content refused: ${frozen.reason}.`);
  refuse(context.stateUpdateSha256 === frozen.evidence.stateUpdateSha256, "frozen context differs from retained sources");
  const point = cut(input.point);
  refuse(point.projectedMarkdownSha256 === input.pointMarkdownDigest, "selected artifact differs");
  const restored = journal({document, currentPath, checkpoint: context.stateUpdate, suffix: [], candidate: input.candidate});
  if (restored.kind !== "accepted") throw new Error(`Restore content refused: ${restored.reason}.`);
  refuse(isDeepStrictEqual(restored.evidence.candidate.ranges, input.replacementRanges), "replacement ranges differ");
  // The native restore producer records fresh owner replacement structs, including source metadata.
  refuse(input.replacementRanges.length > 0, "candidate makes no owner replacement writes");
  const before = Y.decodeStateVector(frozen.evidence.stateVector);
  for (const range of input.replacementRanges) {
    refuse(range.startClock === 0 && !before.has(range.clientId), "replacement writer is not fresh");
  }
  refuse(restored.evidence.projectedMarkdownSha256 === input.pointMarkdownDigest, "restored artifact differs");
  const pointDoc = new Y.Doc({gc: false}), restoredDoc = new Y.Doc({gc: false});
  try {
    // Both full states already passed bounded decoding, dependency closure and public schema validation.
    Y.applyUpdate(pointDoc, point.stateUpdate);
    Y.applyUpdate(restoredDoc, restored.evidence.stateUpdate);
    const semantic = (doc: Y.Doc) => ({
      body: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("body"), getDohcProseMirrorSchema()).toJSON(),
      frontmatter: frontmatterStructure(doc.getMap("frontmatter")),
    });
    refuse(isDeepStrictEqual(semantic(pointDoc), semantic(restoredDoc)), "restored structure differs");
    refuse(hash(yDocToMarkdown(pointDoc)) === input.pointProjectionDigest &&
      hash(yDocToMarkdown(restoredDoc)) === input.pointProjectionDigest, "restored projection differs");
    input.assertCurrent();
    const stateUpdate = restored.evidence.stateUpdate;
    return Object.freeze({candidateDigest: restored.evidence.candidate.updateDigest,
      frozenStateDigest: frozen.evidence.checkpoint.updateDigest, pointStateDigest: point.stateUpdateSha256,
      restoredStateDigest: restored.evidence.stateUpdateSha256,
      get stateUpdate() {return new Uint8Array(stateUpdate);},
      replacementRanges: Object.freeze(restored.evidence.candidate.ranges.map(range => Object.freeze({...range}))),
      inputBytes: bytes,
    });
  } finally {pointDoc.destroy(); restoredDoc.destroy();}
}
