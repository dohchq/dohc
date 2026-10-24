import {createHash} from "node:crypto";
import * as Y from "yjs";
import {createEngineMarkdownReader, type EngineMarkdownProof} from "./engine-markdown-reader.js";
import {yDocToMarkdown} from "./import-export.js";
import {createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator} from "./liveDocumentValidation.js";
import type {LiveMarkdownRegistrationInput, LiveMarkdownRegistrationResult, LiveMarkdownJournalInput} from "./liveDocumentValidation.js";
import type {OrderedLiveUpdateCutPolicy} from "./orderedLiveUpdateCut.js";

/** Reads bytes from an authenticated object's stored artifact history, never its witness. */
export type RestoreArtifact = (digest: string) => Uint8Array | undefined;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const noop = new Uint8Array([0, 0]);
const marked = (doc: Y.Doc) => doc.getMap("meta").get("dohcMarkdownSourceReader") === 1;
function matchesProof(doc: Y.Doc, bytes: Uint8Array, proof: EngineMarkdownProof, projected: string) {
  return proof.kind !== "refused" && proof.sourceSha256 === hash(bytes) && proof.sourceByteLength === bytes.length &&
    (proof.kind === "accepted"
      ? proof.projectionSha256 === doc.getMap("meta").get("dohcMarkdownSourceProjectionSha256") && proof.sourceSha256 === projected
      : proof.projectionSha256 === projected);
}

export function restoreValidators(policy: OrderedLiveUpdateCutPolicy, artifact?: RestoreArtifact) {
  const nativeRegistration = createLiveMarkdownRegistrationValidator(policy);
  const nativeJournal = createLiveMarkdownJournalValidator(policy);
  let strict: ReturnType<typeof createLiveMarkdownJournalValidator> | undefined;
  let reader: ReturnType<typeof createEngineMarkdownReader> | undefined;
  const source = (doc: Y.Doc) => {
    const digest = doc.getMap("meta").get("dohcMarkdownSourceSha256");
    const bytes = typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? artifact?.(digest) : undefined;
    if (!bytes || hash(bytes) !== digest) throw new Error("Restore source snapshot unavailable.");
    return bytes;
  };
  const prove = <T>(input: LiveMarkdownJournalInput, fallback: T) => {
    strict ??= createLiveMarkdownJournalValidator(policy, true);
    reader ??= createEngineMarkdownReader(policy);
    const result = strict(input);
    if (result.kind !== "accepted") return fallback;
    const doc = new Y.Doc({gc: false});
    try {
      // The strict non-dropping journal bounds and validates this full state first.
      Y.applyUpdate(doc, result.evidence.stateUpdate);
      if (marked(doc)) {
        const bytes = source(doc);
        const proof = reader.prove({...input, checkpoint: result.evidence.stateUpdate, source: bytes});
        if (!matchesProof(doc, bytes, proof, result.evidence.projectedMarkdownSha256)) {
          throw new Error("Restore source proof refused.");
        }
      } else {
        // A replacement may remove the marker when the selected point is native.
        const before = strict({...input, suffix: [], candidate: noop});
        if (before.kind !== "accepted") return fallback;
        const prior = new Y.Doc({gc: false});
        try {
          Y.applyUpdate(prior, before.evidence.stateUpdate);
          if (!marked(prior)) return fallback;
          const native = nativeRegistration({document: input.document, currentPath: input.currentPath, checkpoint: result.evidence.stateUpdate});
          if (native.kind !== "accepted") throw new Error("Restore checkpoint refused.");
          const bytes = source(prior);
          const proof = reader.prove({...input, source: bytes});
          if (!matchesProof(prior, bytes, proof, before.evidence.projectedMarkdownSha256)) {
            throw new Error("Restore checkpoint proof refused.");
          }
        } finally {prior.destroy();}
      }
      return result;
    } finally {doc.destroy();}
  };
  return {
    journal(input: LiveMarkdownJournalInput) {
      const native = nativeJournal(input);
      return native.kind === "accepted" || !artifact ? native : prove(input, native);
    },
    registration(input: LiveMarkdownRegistrationInput): LiveMarkdownRegistrationResult {
      const native = nativeRegistration(input);
      if (native.kind === "accepted" || !artifact) return native;
      const result = prove({...input, suffix: [], candidate: noop}, native);
      if (result.kind !== "accepted") return native;
      const doc = new Y.Doc({gc: false});
      try {
        Y.applyUpdate(doc, result.evidence.stateUpdate);
        const stateVector = Y.encodeStateVector(doc);
        const bytes = artifact(result.evidence.projectedMarkdownSha256);
        const projectedMarkdown = bytes ? new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes) : yDocToMarkdown(doc);
        if (hash(new TextEncoder().encode(projectedMarkdown)) !== result.evidence.projectedMarkdownSha256) {
          throw new Error("Restore artifact unavailable.");
        }
        return {kind: "accepted", evidence: {...result.evidence,
          checkpoint: {bytes: new Uint8Array(input.checkpoint), updateDigest: result.evidence.checkpointDigest, ranges: result.evidence.checkpointRanges},
          projectedMarkdown, stateVector, stateVectorSha256: hash(stateVector)}};
      } finally {doc.destroy();}
    },
  };
}
