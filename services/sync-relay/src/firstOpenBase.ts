import { createHash } from "node:crypto";
import {
  createLiveMarkdownRegistrationValidator,
  type OrderedLiveUpdateCutPolicy,
} from "@dohc/ydoc-projection/live-journal-validation";
import {
  encodeRichdocSeed,
  richdocSeedFile,
  seedClientId,
} from "@dohc/ydoc-projection/richdoc-seed";
import {
  activationCaptureBytes,
  baseOnlyActivationReadBytes,
} from "./storage/ordinaryActivationSource.js";

/** `dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES`. */
export const MAX_YDOC_UPDATE_BYTES = 20 * 1024 * 1024;
/** Room for native to re-encode the base larger than Yjs did, as it does integral floats. */
export const FIRST_OPEN_FULL_STATE_SLACK_BYTES = 1024;

export interface FirstOpenBaseBounds {
  maxCaptureBytes: number;
  maxBytesPerDrain: number;
  /** `activationDescriptorReserve` for the document. */
  descriptorBytes: number;
  /** `ordinaryActivationEntryBytes` for the base's log row. */
  logEntryBytes: number;
}
export interface FirstOpenBaseInput {
  document: { workspaceId: string; mainVersionId: "main"; objectId: string };
  currentPath: string;
  headMomentId: string;
  markdown: string;
  sourceDigest: string;
  sourceByteLength: number;
  bounds: FirstOpenBaseBounds;
}
export type FirstOpenBaseBound =
  | "update-limit"
  | "drain-budget"
  | "capture-budget"
  | "read-budget";
export type FirstOpenBaseResult =
  | { kind: "built"; base: Uint8Array; lineageClaimId: string }
  | { kind: "refused"; reason: "source-mismatch" | "invalid-base" | FirstOpenBaseBound };

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * The first bound a base would break when native captures its activation and
 * the relay verifies it. Native re-encodes the full state, so its length is
 * estimated from the larger of the base and the validated state.
 */
export function firstOpenBaseExceeds(
  sizes: { baseBytes: number; stateUpdateBytes: number },
  bounds: FirstOpenBaseBounds,
): FirstOpenBaseBound | undefined {
  const { baseBytes } = sizes;
  const larger = Math.max(baseBytes, sizes.stateUpdateBytes);
  const fullStateBytes = larger + FIRST_OPEN_FULL_STATE_SLACK_BYTES;
  if (baseBytes > MAX_YDOC_UPDATE_BYTES) return "update-limit";
  if (baseBytes > bounds.maxBytesPerDrain) return "drain-budget";
  if (activationCaptureBytes(larger, fullStateBytes, bounds.descriptorBytes) > bounds.maxCaptureBytes) {
    return "capture-budget";
  }
  if (
    baseOnlyActivationReadBytes({ baseBytes, fullStateBytes, logEntryBytes: bounds.logEntryBytes }) >
    bounds.maxBytesPerDrain
  ) {
    return "read-budget";
  }
  return undefined;
}

/**
 * The first Y.Doc base for a Markdown head, built as the desktop seeds it and
 * accepted only when it settles to exactly that head.
 */
export function buildFirstOpenBase(
  policy: OrderedLiveUpdateCutPolicy,
  input: FirstOpenBaseInput,
): FirstOpenBaseResult {
  const { document, currentPath, markdown, sourceDigest, sourceByteLength, bounds } = input;
  const refused = (reason: Extract<FirstOpenBaseResult, { kind: "refused" }>["reason"]) =>
    ({ kind: "refused", reason }) as const;
  if (Buffer.byteLength(markdown) !== sourceByteLength || sha256(markdown) !== sourceDigest) {
    return refused("source-mismatch");
  }
  const clientID = seedClientId({
    workspaceId: document.workspaceId,
    versionId: document.mainVersionId,
    objectId: document.objectId,
    contentKind: "richdoc",
    headMomentId: input.headMomentId,
    headBlobSha256: sourceDigest,
  });
  let base: Uint8Array;
  try {
    base = encodeRichdocSeed(markdown, clientID);
  } catch {
    return refused("invalid-base");
  }
  // A base too large on its own is refused before validation.
  const early = firstOpenBaseExceeds({ baseBytes: base.byteLength, stateUpdateBytes: 0 }, bounds);
  if (early) return refused(early);
  const lineageClaimId = sha256(base);
  const validated = createLiveMarkdownRegistrationValidator(policy)({
    document: { ...document, lineageClaimId },
    currentPath,
    checkpoint: base,
  });
  if (validated.kind !== "accepted") return refused("invalid-base");
  const { evidence } = validated;
  // The validator also verifies witnesses the engine does not settle to.
  if (
    evidence.projectedMarkdownSha256 !== sourceDigest ||
    evidence.projectedMarkdownByteLength !== sourceByteLength ||
    richdocSeedFile(base) !== markdown
  ) {
    return refused("source-mismatch");
  }
  const exceeded = firstOpenBaseExceeds(
    { baseBytes: base.byteLength, stateUpdateBytes: evidence.stateUpdateByteLength },
    bounds,
  );
  return exceeded ? refused(exceeded) : { kind: "built", base, lineageClaimId };
}
