import { createHash } from "node:crypto";
import {
  createLiveMarkdownRegistrationValidator,
  type OrderedLiveUpdateCutPolicy,
} from "@dohc/ydoc-projection/live-journal-validation";
import { encodeRichdocSeed, seedClientId } from "@dohc/ydoc-projection/richdoc-seed";
import {
  activationCaptureBytes,
  ordinaryActivationReadBytes,
} from "./storage/ordinaryActivationSource.js";

/** `dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES`. */
export const MAX_YDOC_UPDATE_BYTES = 20 * 1024 * 1024;
/** The shortest full state native encodes: an empty document. */
const MIN_FULL_STATE_BYTES = 2;

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
/** `validation-budget`: the registration validator ran out of its configured policy. */
export type FirstOpenBaseBound = "update-limit" | "capture-budget" | "read-budget" | "validation-budget";
/** A base's length and the length of native's full-state encoding of it. */
export interface FirstOpenBaseSizes { baseBytes: number; fullStateBytes: number }
export type FirstOpenBaseResult =
  | { kind: "built"; base: Uint8Array; lineageClaimId: string }
  | {
      kind: "refused";
      /**
       * `source-mismatch`: the input is not the verified head. `unsupported-source`:
       * the head is current, but the validator does not read its base back as it.
       */
      reason: "source-mismatch" | "unsupported-source" | "invalid-base" | FirstOpenBaseBound;
    };

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

const baseOnlyReads = (baseBytes: number, bounds: FirstOpenBaseBounds, fullStateBytes: number) =>
  ordinaryActivationReadBytes({ baselineBytes: baseBytes, entryBytes: [bounds.logEntryBytes], updateBytes: [baseBytes], fullStateBytes });

/**
 * The first bound a base and native's measured full state would break when
 * native captures its activation and the relay verifies it.
 */
export function firstOpenBaseExceeds(
  sizes: FirstOpenBaseSizes,
  bounds: FirstOpenBaseBounds,
): FirstOpenBaseBound | undefined {
  const { baseBytes, fullStateBytes } = sizes;
  if (baseBytes > MAX_YDOC_UPDATE_BYTES || fullStateBytes > MAX_YDOC_UPDATE_BYTES) return "update-limit";
  if (activationCaptureBytes(baseBytes, fullStateBytes, bounds.descriptorBytes) > bounds.maxCaptureBytes) {
    return "capture-budget";
  }
  return baseOnlyReads(baseBytes, bounds, fullStateBytes) > bounds.maxBytesPerDrain ? "read-budget" : undefined;
}

/**
 * The most bytes native may encode a base's full state in: whatever the
 * update limit, the capture budget and the verifier's reads each leave once
 * the base is charged, the least of them, with the bound that sets it. Every
 * charge grows one byte per full-state byte. A base that leaves no room for
 * even an empty state names the bound it breaks.
 */
export function firstOpenEncodingCap(
  baseBytes: number,
  bounds: FirstOpenBaseBounds,
): { cap: number; bound: FirstOpenBaseBound } | { exceeded: FirstOpenBaseBound } {
  if (baseBytes > MAX_YDOC_UPDATE_BYTES) return { exceeded: "update-limit" };
  const allowances: [FirstOpenBaseBound, number][] = [
    ["update-limit", MAX_YDOC_UPDATE_BYTES],
    ["capture-budget", bounds.maxCaptureBytes - activationCaptureBytes(baseBytes, 0, bounds.descriptorBytes)],
    ["read-budget", bounds.maxBytesPerDrain - baseOnlyReads(baseBytes, bounds, 0)],
  ];
  const [bound, cap] = allowances.reduce((least, next) => (next[1] < least[1] ? next : least));
  return cap < MIN_FULL_STATE_BYTES ? { exceeded: bound } : { cap, bound };
}

/**
 * The first Y.Doc base for a Markdown head, built as the desktop seeds it.
 * Building proves nothing about settlement: the engine checks the base
 * against the head before anything publishes it.
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
  // Refused before anything decodes it, as is a base that leaves native no room.
  const room = firstOpenEncodingCap(base.byteLength, bounds);
  if ("exceeded" in room) return refused(room.exceeded);
  const lineageClaimId = sha256(base);
  const validated = createLiveMarkdownRegistrationValidator(policy)({
    document: { ...document, lineageClaimId },
    currentPath,
    checkpoint: base,
  });
  if (validated.kind !== "accepted") {
    return refused(validated.reason === "capacity-refused" ? "validation-budget" : "invalid-base");
  }
  const { evidence } = validated;
  if (evidence.projectedMarkdownSha256 !== sourceDigest || evidence.projectedMarkdownByteLength !== sourceByteLength) {
    return refused("unsupported-source");
  }
  return { kind: "built", base, lineageClaimId };
}
