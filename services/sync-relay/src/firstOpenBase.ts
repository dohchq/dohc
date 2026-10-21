import { createHash } from "node:crypto";
import * as Y from "yjs";
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
  ordinaryActivationReadBytes,
} from "./storage/ordinaryActivationSource.js";

/** `dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES`. */
export const MAX_YDOC_UPDATE_BYTES = 20 * 1024 * 1024;
/**
 * The most bytes yrs adds when it re-encodes one number. lib0 writes an
 * integer above 2^31 - 1 that a float32 holds as a 4-byte float32 (lib0
 * 0.2.117 `encoding.js:551-559`). yrs reads it back as that integer
 * (yrs 0.27.3 `any.rs:53`) and writes every safe integer as a signed varint
 * (`any.rs:143-154`, `encoding/varint.rs:330-353`): 6 bits, then 7 per byte,
 * so 8 bytes for 53 bits. Every other number keeps its width.
 */
export const NATIVE_NUMBER_GROWTH_BYTES = 4;

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
export interface FirstOpenBaseSizes { baseBytes: number; stateUpdateBytes: number; nativeGrowthBytes: number }
export type FirstOpenBaseResult =
  /** `sizes` lets a publisher check the base against bounds that changed since. */
  | { kind: "built"; base: Uint8Array; lineageClaimId: string; sizes: FirstOpenBaseSizes }
  | {
      kind: "refused";
      /**
       * `source-mismatch`: the input is not the verified head. `unsupported-source`:
       * the head is current, but its base would not settle to it or could not be
       * bounded once native re-encodes it.
       */
      reason: "source-mismatch" | "unsupported-source" | "invalid-base" | FirstOpenBaseBound;
    };

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

/** Whether yrs writes this number wider than lib0 did. */
const growsNatively = (value: number) =>
  Number.isSafeInteger(value) && Math.abs(value) > 0x7fff_ffff && Math.fround(value) === value;

/**
 * How many bytes larger native's full state can be than this base, or
 * undefined when that is not bounded. yrs writes the same structs as the base;
 * only values change width.
 * - Binary values grow only by numbers (see `NATIVE_NUMBER_GROWTH_BYTES`).
 * - Format and embed values travel as JSON text, which yrs parses and prints
 *   again (yrs `updates/encoder.rs:170-174`). It prints a safe integer as an
 *   i64 (`encoding/serde/ser.rs:25-34`), with the digits JSON.stringify wrote;
 *   other numbers can change spelling, so they are not bounded.
 */
export function nativeFullStateGrowth(base: Uint8Array): number | undefined {
  let growing = 0;
  let bounded = true;
  const visit = (value: unknown, json: boolean) => {
    if (typeof value === "number") {
      if (json) bounded &&= Number.isSafeInteger(value);
      else if (growsNatively(value)) growing += 1;
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, json);
    } else if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
      for (const entry of Object.values(value)) visit(entry, json);
    }
  };
  for (const struct of Y.decodeUpdate(base).structs) {
    if (!(struct instanceof Y.Item)) continue;
    const { content } = struct;
    if (content instanceof Y.ContentAny) visit(content.arr, false);
    else if (content instanceof Y.ContentFormat) visit(content.value, true);
    else if (content instanceof Y.ContentEmbed) visit(content.embed, true);
    else if (content instanceof Y.ContentDoc) bounded = false;
  }
  return bounded ? growing * NATIVE_NUMBER_GROWTH_BYTES : undefined;
}

/**
 * The first bound a base would break when native captures its activation and
 * the relay verifies it. Native re-encodes the full state, so its length is
 * the larger of the base and the validated state, plus what re-encoding adds.
 */
export function firstOpenBaseExceeds(
  sizes: FirstOpenBaseSizes,
  bounds: FirstOpenBaseBounds,
): FirstOpenBaseBound | undefined {
  const { baseBytes } = sizes;
  const larger = Math.max(baseBytes, sizes.stateUpdateBytes);
  const fullStateBytes = larger + sizes.nativeGrowthBytes;
  if (fullStateBytes > MAX_YDOC_UPDATE_BYTES) return "update-limit";
  if (activationCaptureBytes(larger, fullStateBytes, bounds.descriptorBytes) > bounds.maxCaptureBytes) {
    return "capture-budget";
  }
  const reads = ordinaryActivationReadBytes({
    baselineBytes: baseBytes,
    entryBytes: [bounds.logEntryBytes],
    updateBytes: [baseBytes],
    fullStateBytes,
  });
  return reads > bounds.maxBytesPerDrain ? "read-budget" : undefined;
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
  // Refused before anything decodes it.
  if (base.byteLength > MAX_YDOC_UPDATE_BYTES) return refused("update-limit");
  const nativeGrowthBytes = nativeFullStateGrowth(base);
  if (nativeGrowthBytes === undefined) return refused("unsupported-source");
  // A base too large on its own is refused before validation.
  const early = firstOpenBaseExceeds(
    { baseBytes: base.byteLength, stateUpdateBytes: 0, nativeGrowthBytes },
    bounds,
  );
  if (early) return refused(early);
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
  // The validator also verifies witnesses the engine does not settle to.
  if (
    evidence.projectedMarkdownSha256 !== sourceDigest ||
    evidence.projectedMarkdownByteLength !== sourceByteLength ||
    richdocSeedFile(base) !== markdown
  ) {
    return refused("unsupported-source");
  }
  const sizes = { baseBytes: base.byteLength, stateUpdateBytes: evidence.stateUpdateByteLength, nativeGrowthBytes };
  const exceeded = firstOpenBaseExceeds(sizes, bounds);
  return exceeded ? refused(exceeded) : { kind: "built", base, lineageClaimId, sizes };
}
