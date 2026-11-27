import {
  exceedsLiveMarkdownLimit,
  parseLiveDocumentKey,
  type LiveDocumentKey,
  type LiveUpdateStructRange,
} from "@dohc/live-session-contract";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { validateUserWritePath } from "@dohc/workspace-core/paths";
import { Schema } from "@tiptap/pm/model";
import { digest as sha256 } from "lib0/hash/sha256";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import {
  SOURCE_META_KEYS,
  readMarkdownSourceWitness,
  resolveMarkdownSource,
} from "./artifact-markdown.js";
import {
  bodySequenceChangeLimit,
  bodySequenceChangeRefusal,
  bodySequenceRoomPolicy,
  bodySequenceStateRefusal,
  type BodySequenceIntakeRules,
  type BodySequenceIntakeWork,
} from "./bodySequenceIntake.js";
import { FRONTMATTER_EDIT_REFUSED_MESSAGE } from "./frontmatter.js";
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  markdownToYDoc,
  isEmptyShell,
  yDocPropertiesToMarkdown,
  yDocToMarkdown,
} from "./import-export.js";
import {
  validateRegistrationCutForProjection,
  validateJournalCutForProjection,
  MAX_OLD_SUFFIX_ENTRIES,
  type JournalPrefixProjection,
  type OrderedLiveUpdateCutPolicy,
  type OrderedLiveUpdateCutFinalizeResult,
  type ProjectionTopology,
  type BodySequenceCut,
  type ValidatedLiveUpdateCut,
  type OrderedLiveUpdateCutRefusal,
} from "./orderedLiveUpdateCut.js";
import {
  MAX_PROJECTION_NODES,
  WORKER_LIVE_VALIDATION_POLICY,
  withinLiveNoteCapacity,
} from "./liveValidationPolicy.js";
import {
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  holdsBodySequence,
} from "./bodySequenceStore.js";

const INPUT_FIELDS = ["document", "currentPath", "checkpoint"] as const;
const JOURNAL_INPUT_FIELDS = [...INPUT_FIELDS, "suffix", "candidate"] as const;
const DOCUMENT_FIELDS = ["workspaceId", "mainVersionId", "objectId", "lineageClaimId"] as const;
const POLICY_FIELDS = [
  "maxStructVisits",
  "maxValueNodeVisits",
  "maxDecodedPayloadByteVisits",
  "maxStructClientGroupVisits",
  "maxDeleteClientGroupVisits",
  "maxDeleteIntervalVisits",
  "maxIndexOperations",
] as const;
const MAX_DEPTH = 128;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;
const SHARED_BIGINT_KEY = "$dohcBigInt";
const PUBLIC_ROOTS = new Set(["body", "frontmatter", "meta"]);
const BODY_SEQUENCE_NOTE_ROOTS = new Set([
  ...PUBLIC_ROOTS,
  BODY_SEQUENCE_FIELD,
  BODY_CONTAINERS_FIELD,
]);
const META_KEYS = new Set([
  "schemaVersion",
  "dohcMarkdownCrlf",
  "dohcFrontmatterSource",
  "dohcMarkdownSource",
  "dohcMarkdownSourceSha256",
  "dohcMarkdownSourceProjectionSha256",
]);
// Exact text the projection keeps only while it reads as the current state.
// A frontmatter edit leaves it behind, so it need not match a reimport.
const PROJECTION_SOURCE_META_KEYS = [...SOURCE_META_KEYS, "dohcFrontmatterSource"] as const;
// The item each frontmatter key held when its text was kept, one entry per key.
const FRONTMATTER_SOURCE_ITEM_META_PREFIX = "dohcFrontmatterSourceItem:";
// Metadata only the engine's Markdown reader writes.
const ENGINE_META_KEYS = new Set(["dohcLineageEpoch", "dohcMarkdownSourceReader"]);
const LINEAGE_EPOCH_META_KEY = "dohcLineageEpoch";
const SHA256_HEX = /^[0-9a-f]{64}$/;

let bodySequenceNotesAdmitted = false;

/**
 * The relay's one setting for notes whose body is one sequence. While it is off, which is how
 * every process starts, each check in this module refuses such a note and every change to one.
 */
export function admitBodySequenceNotes(admitted: boolean): void {
  bodySequenceNotesAdmitted = admitted;
}

export function bodySequenceNotesRefused(): boolean {
  return !bodySequenceNotesAdmitted;
}

export function baselineHoldsBodySequence(baseline: Uint8Array): boolean {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, baseline);
    return holdsBodySequence(doc);
  } finally {
    doc.destroy();
  }
}

/** Each key's own rule from `validateMetadata`, for one item of a body-sequence note's metadata. */
function bodySequenceMetadata(
  engineReader: boolean,
  lineageEpoch = false,
): BodySequenceIntakeRules["metadata"] {
  return (key, shown) => {
    const kept = key.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX);
    if (
      !kept &&
      !META_KEYS.has(key) &&
      !(engineReader && ENGINE_META_KEYS.has(key)) &&
      !(lineageEpoch && key === LINEAGE_EPOCH_META_KEY)
    )
      return false;
    if (!shown) return true;
    const { value } = shown;
    if (key === "dohcMarkdownCrlf") return value === true;
    if (key === "dohcMarkdownSourceReader") return value === 1;
    if (typeof value !== "string") return false;
    if (kept || key === "dohcMarkdownSource") return true;
    if (key === "dohcFrontmatterSource") return !exceedsLiveMarkdownLimit(value);
    return SHA256_HEX.test(value);
  };
}

const ROOM_METADATA = bodySequenceMetadata(false);

function bodySequenceCut(
  policy: OrderedLiveUpdateCutPolicy,
  engineReader: boolean,
): BodySequenceCut | undefined {
  if (!bodySequenceNotesAdmitted) return undefined;
  const rules = { policy, metadata: bodySequenceMetadata(engineReader) };
  const stateRules = { policy, metadata: bodySequenceMetadata(engineReader, true) };
  return {
    holds: holdsBodySequence,
    entry(document, bytes, apply, kind) {
      if (kind === "state") return bodySequenceStateRefusal(document, bytes, apply, stateRules);
      if (holdsBodySequence(document))
        return bodySequenceChangeRefusal(document, bytes, apply, rules);
      apply();
      return holdsBodySequence(document) ? "invalid-schema" : undefined;
    },
  };
}
const ByteArray = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(ByteArray.prototype) as object;
const byteTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const setBytes = ByteArray.prototype.set;
const utf8 = new TextEncoder();

const LIVE_MARKDOWN_VALIDATION_REFUSALS = [
  "invalid-input",
  "invalid-update",
  "invalid-schema",
  "projection-mutated",
  "capacity-refused",
] as const;
export type LiveMarkdownValidationRefusal = (typeof LIVE_MARKDOWN_VALIDATION_REFUSALS)[number];
export interface LiveMarkdownRegistrationInput {
  readonly document: LiveDocumentKey;
  readonly currentPath: string;
  readonly checkpoint: Uint8Array;
}
export interface LiveMarkdownRegistrationEvidence {
  readonly version: 1;
  readonly document: LiveDocumentKey;
  readonly currentPath: string;
  readonly checkpoint: {
    readonly bytes: Uint8Array;
    readonly updateDigest: string;
    readonly ranges: readonly LiveUpdateStructRange[];
  };
  readonly projectedMarkdown: string;
  readonly projectedMarkdownSha256: string;
  readonly projectedMarkdownByteLength: number;
  readonly stateUpdate: Uint8Array;
  readonly stateUpdateSha256: string;
  readonly stateUpdateByteLength: number;
  readonly stateVector: Uint8Array;
  readonly stateVectorSha256: string;
}
type RefusedRegistration = {
  readonly kind: "refused";
  readonly reason: LiveMarkdownValidationRefusal;
  readonly source: "call" | "registration-input";
};
export type LiveMarkdownRegistrationResult =
  | { readonly kind: "accepted"; readonly evidence: LiveMarkdownRegistrationEvidence }
  | RefusedRegistration;

class Refusal extends Error {
  constructor(readonly reason: LiveMarkdownValidationRefusal) {
    super(reason);
  }
}
function refuse(reason: LiveMarkdownValidationRefusal): never {
  throw new Refusal(reason);
}
/** ProseMirror's schema verdicts; allocation and stack RangeErrors stay fatal. */
export function isProseMirrorSchemaError(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    /^(Invalid content for node |Invalid collection of marks for node |Unsupported attribute |Expected value of type |No value supplied for attribute |Unknown node type: |Invalid node type: )/.test(
      error.message,
    )
  );
}
function refusal<S extends RefusedRegistration["source"] | RefusedJournal["source"]>(
  reason: LiveMarkdownValidationRefusal,
  source: S,
): {
  readonly kind: "refused";
  readonly reason: LiveMarkdownValidationRefusal;
  readonly source: S;
} {
  return Object.freeze({ kind: "refused", reason, source });
}
function exactDataFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("invalid-input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse("invalid-input");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    refuse("invalid-input");
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) refuse("invalid-input");
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}
function captureBytes(value: unknown): Uint8Array {
  if (Reflect.apply(byteTag, value, []) !== "Uint8Array") refuse("invalid-input");
  const buffer = Reflect.apply(byteBuffer, value, []) as ArrayBuffer;
  const offset = Reflect.apply(byteOffset, value, []) as number;
  const length = Reflect.apply(byteLength, value, []) as number;
  const backingLength = Reflect.apply(bufferLength, buffer, []) as number;
  if (
    length <= 0 ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > backingLength ||
    length > backingLength - offset ||
    (bufferResizable !== undefined && Reflect.apply(bufferResizable, buffer, []) === true)
  )
    refuse("invalid-input");
  return new ByteArray(buffer, offset, length);
}
function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new ByteArray(Reflect.apply(byteLength, value, []) as number);
  Reflect.apply(setBytes, copy, [value]);
  return copy;
}
function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function capturePolicy(policy: OrderedLiveUpdateCutPolicy): OrderedLiveUpdateCutPolicy {
  try {
    const snapshot = exactDataFields(policy, POLICY_FIELDS);
    for (const field of POLICY_FIELDS) {
      const value = snapshot[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        refuse("invalid-input");
    }
    return Object.freeze(snapshot) as unknown as OrderedLiveUpdateCutPolicy;
  } catch {
    throw new TypeError("Live Markdown validation requires an exact, positive work policy.");
  }
}

export function createLiveMarkdownRegistrationValidator(
  policy: OrderedLiveUpdateCutPolicy,
): (input: unknown) => LiveMarkdownRegistrationResult {
  const ownedPolicy = capturePolicy(policy);

  return (input) => validateRegistrationInput(input, ownedPolicy, true);
}

type ValidationOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly reason: LiveMarkdownValidationRefusal };

function validateRegistrationInput(
  input: unknown,
  policy: OrderedLiveUpdateCutPolicy,
  includeEvidence: true,
): LiveMarkdownRegistrationResult;
function validateRegistrationInput(
  input: unknown,
  policy: OrderedLiveUpdateCutPolicy,
  includeEvidence: false,
): ValidationOutcome;
function validateRegistrationInput(
  input: unknown,
  ownedPolicy: OrderedLiveUpdateCutPolicy,
  includeEvidence: boolean,
): LiveMarkdownRegistrationResult | ValidationOutcome {
  let document: LiveDocumentKey, currentPath: string, checkpointValue: unknown;
  try {
    const snapshot = exactDataFields(input, INPUT_FIELDS);
    document = Object.freeze(
      parseLiveDocumentKey(exactDataFields(snapshot.document, DOCUMENT_FIELDS)),
    );
    if (document.mainVersionId !== "main" || typeof snapshot.currentPath !== "string")
      refuse("invalid-input");
    currentPath = snapshot.currentPath;
    const path = validateUserWritePath(currentPath);
    if (
      !path.ok ||
      path.normalized !== currentPath ||
      liveDocumentKindForPath(currentPath) !== "richdoc"
    ) {
      refuse("invalid-input");
    }
    checkpointValue = snapshot.checkpoint;
  } catch {
    return refusal("invalid-input", "call");
  }

  let checkpoint: Uint8Array;
  try {
    checkpoint = captureBytes(checkpointValue);
  } catch {
    return refusal("invalid-input", "registration-input");
  }
  const result = validateRegistrationCutForProjection(
    { mode: "registration", checkpoint },
    ownedPolicy,
    bodySequenceCut(ownedPolicy, false),
  );
  if (result.kind === "refused") return refusal(result.reason, "registration-input");
  const { cut, topology } = result;
  let checkpointCopy: Uint8Array | undefined;
  const projected = projectAndFinalize(cut, ownedPolicy, topology, "drop", () => {
    if (!includeEvidence) return;
    checkpointCopy = copyBytes(checkpoint);
    if (sha256Hex(checkpointCopy) !== cut.checkpoint.updateDigest) refuse("invalid-update");
  });
  if (projected.kind === "refused") return refusal(projected.reason, "registration-input");
  if (!includeEvidence) return { kind: "accepted" };
  if (checkpointCopy === undefined) return refusal("projection-mutated", "registration-input");
  const { projectedMarkdown, finalized } = projected;

  const ownedCheckpoint = checkpointCopy;
  const stateUpdate = copyBytes(finalized.stateUpdate),
    stateVector = copyBytes(finalized.stateVector);
  const markdownBytes = utf8.encode(projectedMarkdown);
  const evidence: LiveMarkdownRegistrationEvidence = Object.freeze({
    version: 1,
    document,
    currentPath,
    checkpoint: Object.freeze({
      get bytes() {
        return copyBytes(ownedCheckpoint);
      },
      updateDigest: cut.checkpoint.updateDigest,
      ranges: Object.freeze(cut.checkpoint.ranges.map((range) => Object.freeze({ ...range }))),
    }),
    projectedMarkdown,
    projectedMarkdownSha256: sha256Hex(markdownBytes),
    projectedMarkdownByteLength: markdownBytes.byteLength,
    get stateUpdate() {
      return copyBytes(stateUpdate);
    },
    stateUpdateSha256: sha256Hex(stateUpdate),
    stateUpdateByteLength: stateUpdate.byteLength,
    get stateVector() {
      return copyBytes(stateVector);
    },
    stateVectorSha256: sha256Hex(stateVector),
  });
  return Object.freeze({ kind: "accepted", evidence });
}

export interface LiveMarkdownJournalInput extends LiveMarkdownRegistrationInput {
  readonly suffix: readonly Uint8Array[];
  readonly candidate: Uint8Array;
}
export interface LiveMarkdownJournalEvidence {
  readonly version: 1;
  readonly document: LiveDocumentKey;
  readonly currentPath: string;
  readonly checkpointDigest: string;
  readonly checkpointRanges: readonly LiveUpdateStructRange[];
  readonly suffixDigests: readonly string[];
  readonly candidate: {
    readonly updateDigest: string;
    readonly firstSeen: readonly LiveUpdateStructRange[];
    readonly firstSeenDeletes: readonly LiveUpdateStructRange[];
    readonly ranges: readonly LiveUpdateStructRange[];
  };
  readonly projectedMarkdownSha256: string;
  readonly projectedMarkdownByteLength: number;
  readonly stateUpdate: Uint8Array;
  readonly stateUpdateSha256: string;
  readonly stateUpdateByteLength: number;
}
type RefusedJournal = {
  readonly kind: "refused";
  readonly reason: LiveMarkdownValidationRefusal;
  readonly source: "call" | "admitted-cut" | "candidate" | "final";
};
export type LiveMarkdownJournalResult =
  | { readonly kind: "accepted"; readonly evidence: LiveMarkdownJournalEvidence }
  | RefusedJournal;
/** Where one journal check spent its time, in milliseconds, for the caller's own timing line. */
export interface LiveMarkdownJournalTiming {
  /** Rebuilding the document from the checkpoint, the suffix and the candidate. */
  replayMs?: number;
  /** Projecting the rebuilt document to Markdown and finishing the cut. */
  projectionMs?: number;
}
/**
 * The projection of each prefix that ends at input `from` or later, before the
 * candidate, checked in the pass that validates the journal. Input 0 is the
 * checkpoint and input `i` is suffix entry `i - 1`.
 */
export interface LiveMarkdownJournalPrefixes {
  readonly from: number;
  readonly visit: (
    projection: {
      readonly projectedMarkdownSha256: string;
      readonly projectedMarkdownByteLength: number;
    },
    index: number,
  ) => void;
}

function captureSuffix(value: unknown): Uint8Array[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    refuse("invalid-input");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value"))
    refuse("invalid-input");
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
    refuse("invalid-input");
  if (length > MAX_OLD_SUFFIX_ENTRIES) refuse("capacity-refused");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    keys.some((key) => {
      if (key === "length") return false;
      return typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length;
    })
  )
    refuse("invalid-input");
  const suffix: Uint8Array[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      refuse("invalid-input");
    suffix.push(captureBytes(descriptor.value));
  }
  return suffix;
}

/** `timing`, when given, receives each check's replay and projection times. */
export function createLiveMarkdownJournalValidator(
  policy: OrderedLiveUpdateCutPolicy,
  engineReader = false,
  timing?: LiveMarkdownJournalTiming,
): (input: unknown) => LiveMarkdownJournalResult {
  const validate = journalValidator(policy, engineReader);
  return (input) => validate(input, undefined, timing);
}

/** A journal validator that also checks each prefix's projection in the same pass. */
export function createLiveMarkdownHistoryValidator(
  policy: OrderedLiveUpdateCutPolicy,
): (input: unknown, prefixes: LiveMarkdownJournalPrefixes) => LiveMarkdownJournalResult {
  const validate = journalValidator(policy, false);
  return (input, prefixes) => validate(input, prefixes);
}

function journalValidator(
  policy: OrderedLiveUpdateCutPolicy,
  engineReader: boolean,
): (
  input: unknown,
  prefixes?: LiveMarkdownJournalPrefixes,
  timing?: LiveMarkdownJournalTiming,
) => LiveMarkdownJournalResult {
  const ownedPolicy = capturePolicy(policy);

  function prefixProjection(prefixes: LiveMarkdownJournalPrefixes): JournalPrefixProjection {
    const { from, visit } = prefixes;
    return {
      from,
      project: (document, topology, index) => {
        let projectedMarkdown: string;
        try {
          if (topology.kind !== "compatible") refuse("invalid-schema");
          projectedMarkdown = validatePublicState(
            document,
            ownedPolicy,
            topology,
            "refuse",
            engineReader,
          );
        } catch (error) {
          if (engineReader && !(error instanceof Refusal)) throw error;
          return error instanceof Refusal ? error.reason : "invalid-schema";
        }
        const markdownBytes = utf8.encode(projectedMarkdown);
        visit(
          {
            projectedMarkdownSha256: sha256Hex(markdownBytes),
            projectedMarkdownByteLength: markdownBytes.byteLength,
          },
          index,
        );
        return undefined;
      },
    };
  }

  function validateAttempt(
    input: LiveMarkdownJournalInput,
    includeEvidence: boolean,
    prefixes?: LiveMarkdownJournalPrefixes,
    timing?: LiveMarkdownJournalTiming,
  ):
    | { kind: "accepted"; evidence?: LiveMarkdownJournalEvidence }
    | { kind: "refused"; failure: Pick<OrderedLiveUpdateCutRefusal, "reason" | "stage"> } {
    const replayStarted = timing && performance.now();
    const result = validateJournalCutForProjection(
      {
        mode: "journal-candidate",
        checkpoint: input.checkpoint,
        suffix: input.suffix,
        candidate: input.candidate,
      },
      ownedPolicy,
      engineReader,
      prefixes && prefixProjection(prefixes),
      bodySequenceCut(ownedPolicy, engineReader),
    );
    if (timing) timing.replayMs = performance.now() - replayStarted!;
    let failure: Pick<OrderedLiveUpdateCutRefusal, "reason" | "stage">;
    if (result.kind === "refused") failure = result;
    else {
      const { cut, topology } = result;
      const projectionStarted = timing && performance.now();
      const projected = projectAndFinalize(
        cut,
        ownedPolicy,
        topology,
        "refuse",
        () => {
          if (changesLineageEpoch(cut)) refuse("invalid-schema");
        },
        engineReader,
      );
      if (timing) timing.projectionMs = performance.now() - projectionStarted!;
      if (projected.kind === "refused")
        failure = { reason: projected.reason, stage: { kind: "final" } };
      else {
        if (!includeEvidence) return { kind: "accepted" };
        const stateUpdate = copyBytes(projected.finalized.stateUpdate);
        const markdownBytes = utf8.encode(projected.projectedMarkdown);
        const evidence: LiveMarkdownJournalEvidence = Object.freeze({
          version: 1,
          document: input.document,
          currentPath: input.currentPath,
          checkpointDigest: cut.checkpointDigest,
          checkpointRanges: cut.checkpointRanges,
          suffixDigests: cut.suffixDigests,
          candidate: Object.freeze({
            updateDigest: cut.candidate.updateDigest,
            firstSeen: cut.candidate.firstSeen,
            firstSeenDeletes: cut.candidate.firstSeenDeletes,
            ranges: Object.freeze(cut.candidate.ranges.map((range) => Object.freeze({ ...range }))),
          }),
          projectedMarkdownSha256: sha256Hex(markdownBytes),
          projectedMarkdownByteLength: markdownBytes.byteLength,
          get stateUpdate() {
            return copyBytes(stateUpdate);
          },
          stateUpdateSha256: sha256Hex(stateUpdate),
          stateUpdateByteLength: stateUpdate.byteLength,
        });
        return Object.freeze({ kind: "accepted", evidence });
      }
    }
    return { kind: "refused", failure };
  }

  function validateCaptured(
    input: LiveMarkdownJournalInput,
    diagnose: true,
    prefixes?: LiveMarkdownJournalPrefixes,
    timing?: LiveMarkdownJournalTiming,
  ): LiveMarkdownJournalResult;
  function validateCaptured(input: LiveMarkdownJournalInput, diagnose: false): ValidationOutcome;
  function validateCaptured(
    input: LiveMarkdownJournalInput,
    diagnose: boolean,
    prefixes?: LiveMarkdownJournalPrefixes,
    timing?: LiveMarkdownJournalTiming,
  ): LiveMarkdownJournalResult | ValidationOutcome {
    // Let the completed cut become collectible before replaying its prefix.
    const attempt = validateAttempt(input, diagnose, prefixes, timing);
    if (attempt.kind === "accepted") return attempt;
    const { failure } = attempt;
    if (failure.stage.kind === "call") return refusal(failure.reason, "call");
    if (failure.stage.kind === "input") {
      return refusal(
        failure.reason,
        failure.stage.role === "candidate" ? "candidate" : "admitted-cut",
      );
    }
    if (!engineReader && diagnose && failure.reason !== "projection-mutated") {
      const last = input.suffix.length - 1;
      const prefix =
        last < 0
          ? validateRegistrationInput(
              {
                document: input.document,
                currentPath: input.currentPath,
                checkpoint: input.checkpoint,
              },
              ownedPolicy,
              false,
            )
          : validateCaptured(
              { ...input, suffix: input.suffix.slice(0, last), candidate: input.suffix[last] },
              false,
            );
      if (prefix.kind === "refused") return refusal(prefix.reason, "admitted-cut");
    }
    return refusal(failure.reason, "final");
  }

  return (input, prefixes, timing): LiveMarkdownJournalResult => {
    let captured: LiveMarkdownJournalInput;
    try {
      const snapshot = exactDataFields(input, JOURNAL_INPUT_FIELDS);
      const document = Object.freeze(
        parseLiveDocumentKey(exactDataFields(snapshot.document, DOCUMENT_FIELDS)),
      );
      if (document.mainVersionId !== "main" || typeof snapshot.currentPath !== "string")
        refuse("invalid-input");
      const currentPath = snapshot.currentPath;
      const path = validateUserWritePath(currentPath);
      if (
        !path.ok ||
        path.normalized !== currentPath ||
        liveDocumentKindForPath(currentPath) !== "richdoc"
      )
        refuse("invalid-input");
      captured = {
        document,
        currentPath,
        checkpoint: captureBytes(snapshot.checkpoint),
        suffix: captureSuffix(snapshot.suffix),
        candidate: captureBytes(snapshot.candidate),
      };
    } catch (error) {
      if (engineReader && !(error instanceof Refusal)) throw error;
      return refusal(error instanceof Refusal ? error.reason : "invalid-input", "call");
    }
    return validateCaptured(captured, true, prefixes, timing);
  };
}

type ProjectedCut =
  | {
      readonly kind: "accepted";
      readonly projectedMarkdown: string;
      readonly finalized: Extract<OrderedLiveUpdateCutFinalizeResult, { kind: "accepted" }>;
    }
  | { readonly kind: "refused"; readonly reason: LiveMarkdownValidationRefusal };

// What to do with a current source witness that does not import as the
// document. A baseline drops it, as the engine does. A journal candidate is
// refused: the engine's own check reads some sources differently from the
// importer, so a forged witness must not reach it through an update.
type UnverifiedSource = "drop" | "refuse";

function changesLineageEpoch(
  cut: Extract<ValidatedLiveUpdateCut, { mode: "journal-candidate" }>,
): boolean {
  const item = cut.document.share.get("meta")?._map.get(LINEAGE_EPOCH_META_KEY);
  if (!item) return false;
  const { client, clock } = item.id;
  const holds = (ranges: readonly LiveUpdateStructRange[]) =>
    ranges.some(
      (range) => range.clientId === client && range.startClock <= clock && clock < range.endClock,
    );
  return holds(cut.candidate.firstSeen) || holds(cut.candidate.firstSeenDeletes);
}

function projectAndFinalize(
  cut: ValidatedLiveUpdateCut,
  policy: OrderedLiveUpdateCutPolicy,
  topology: ProjectionTopology,
  unverifiedSource: UnverifiedSource,
  beforeProjection?: () => void,
  engineReader = false,
): ProjectedCut {
  let pending: LiveMarkdownValidationRefusal | undefined;
  let projectedMarkdown = "";
  let finalized: OrderedLiveUpdateCutFinalizeResult | undefined;
  try {
    beforeProjection?.();
    if (topology.kind !== "compatible") refuse("invalid-schema");
    projectedMarkdown = validatePublicState(
      cut.document,
      policy,
      topology,
      unverifiedSource,
      engineReader,
    );
  } catch (error) {
    // A journal candidate is an owner's edit: a validator failure retries it instead of refusing it.
    if ((engineReader || unverifiedSource === "refuse") && !(error instanceof Refusal)) throw error;
    pending = error instanceof Refusal ? error.reason : "invalid-schema";
  } finally {
    try {
      finalized = cut.finishAfterProjection();
    } catch (error) {
      if (engineReader) throw error;
      pending = "projection-mutated";
    } finally {
      try {
        if (!cut.document.isDestroyed) cut.document.destroy();
      } catch (error) {
        if (engineReader) throw error;
        pending = "projection-mutated";
      }
    }
  }
  if (finalized?.kind === "refused") return { kind: "refused", reason: finalized.reason };
  if (pending) return { kind: "refused", reason: pending };
  if (finalized?.kind !== "accepted") return { kind: "refused", reason: "projection-mutated" };
  return { kind: "accepted", projectedMarkdown, finalized };
}

interface ElementFingerprint {
  kind: "element";
  nodeName: string;
  attributes: [string, unknown][];
  children: XmlFingerprint[];
}
interface TextFingerprint {
  kind: "text";
  delta: { insert: string; attributes: [string, unknown][] }[];
}
type XmlFingerprint = ElementFingerprint | TextFingerprint;

class ProjectionBudget {
  nodes = 0;

  consume(depth: number): void {
    if (depth > MAX_DEPTH) refuse("capacity-refused");
    this.consumeNode();
  }

  consumeNode(): void {
    this.nodes += 1;
    if (this.nodes > MAX_PROJECTION_NODES) refuse("capacity-refused");
  }

  get remaining(): number {
    return MAX_PROJECTION_NODES - this.nodes;
  }
}

function isSharedBigInt(value: Y.Map<unknown>): boolean {
  return value.size === 1 && typeof value.get(SHARED_BIGINT_KEY) === "bigint";
}

function visitPublicValue(
  value: unknown,
  depth: number,
  budget: ProjectionBudget,
  ancestors: Set<object>,
): void {
  budget.consume(depth);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return;
  }
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || value > MAX_INT64) refuse("invalid-schema");
    return;
  }
  if (typeof value !== "object") refuse("invalid-schema");
  if (value instanceof Uint8Array || value instanceof Y.Doc) {
    refuse("invalid-schema");
  }
  if (ancestors.has(value)) refuse("invalid-schema");
  ancestors.add(value);
  try {
    if (value instanceof Y.Map) {
      if (isSharedBigInt(value)) {
        const integer = value.get(SHARED_BIGINT_KEY) as bigint;
        if (integer < MIN_INT64 || integer > MAX_INT64) refuse("invalid-schema");
        return;
      }
      const normalizedKeys = new Set<string>();
      for (const [key, child] of value.entries()) {
        const normalized = /^\$\$+dohcBigInt$/.test(key) ? key.slice(1) : key;
        if (normalizedKeys.has(normalized)) refuse("invalid-schema");
        normalizedKeys.add(normalized);
        visitPublicValue(child, depth + 1, budget, ancestors);
      }
      return;
    }
    if (value instanceof Y.Array) {
      if (value.length > budget.remaining) refuse("capacity-refused");
      for (const child of value.toArray()) {
        visitPublicValue(child, depth + 1, budget, ancestors);
      }
      return;
    }
    if (value instanceof Y.AbstractType) refuse("invalid-schema");
    if (Array.isArray(value)) {
      if (value.length > budget.remaining) refuse("capacity-refused");
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        refuse("invalid-schema");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
          refuse("invalid-schema");
        }
        visitPublicValue(descriptor.value, depth + 1, budget, ancestors);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      refuse("invalid-schema");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") refuse("invalid-schema");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value")
      ) {
        refuse("invalid-schema");
      }
      visitPublicValue(descriptor.value, depth + 1, budget, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function sortedValueEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.keys(value)
    .sort()
    .map((key) => [key, value[key]]);
}

function validBodyAttribute(nodeName: string, key: string, value: unknown): boolean {
  switch (`${nodeName}.${key}`) {
    case "wikilink.target":
    case "inlineAtom.atomId":
    case "inlineAtom.params":
    case "inlineAtom.source":
    case "callout.calloutType":
    case "callout.title":
    case "mathInline.tex":
    case "mathBlock.tex":
    case "image.src":
    case "image.alt":
    case "escapedPunctuation.value":
    case "rawBlock.source":
    case "rawInline.source":
      return typeof value === "string";
    case "bulletList.loose":
    case "orderedList.loose":
    case "taskList.loose":
      return typeof value === "boolean";
    case "wikilink.label":
    case "image.title":
    case "codeBlock.language":
    case "orderedList.type":
      return value === null || typeof value === "string";
    case "callout.fold":
      return value === "" || value === "+" || value === "-";
    case "heading.level":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6;
    case "orderedList.start":
    case "tableCell.colspan":
    case "tableCell.rowspan":
    case "tableHeader.colspan":
    case "tableHeader.rowspan":
      return typeof value === "number" && Number.isFinite(value);
    case "taskItem.checked":
      return typeof value === "boolean";
    case "tableCell.colwidth":
    case "tableHeader.colwidth":
      return (
        value === null ||
        (Array.isArray(value) &&
          value.every(
            (width) => typeof width === "number" && (Number.isFinite(width) || Number.isNaN(width)),
          ))
      );
    case "tableCell.align":
    case "tableHeader.align":
      return value === null || value === "left" || value === "right" || value === "center";
    case "tableRow.height":
      return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);
    default:
      return true;
  }
}

// y-prosemirror appends an eight-character hash to nonexclusive mark names.
const markNameOf = (name: string) => /^(.*)(--[a-zA-Z0-9+/=]{8})$/.exec(name)?.[1] ?? name;
// Projection reads each format key with y-prosemirror's own unanchored pattern, which takes time quadratic in
// the key's length. A key longer than any mark name with its hash is refused before projection.
let maxFormatKeyLength: number | undefined;

function validateMarkAttributes(name: string, value: unknown): void {
  maxFormatKeyLength ??=
    Math.max(...Object.keys(getDohcProseMirrorSchema().marks).map((mark) => mark.length)) + 10;
  if (name.length > maxFormatKeyLength) refuse("invalid-schema");
  const markName = markNameOf(name);
  if (markName !== "link" || value === null || typeof value !== "object") return;
  for (const key of ["href", "target", "rel", "class", "title"]) {
    const attribute = (value as Record<string, unknown>)[key];
    if (attribute !== undefined && attribute !== null && typeof attribute !== "string")
      refuse("invalid-schema");
  }
}

type Shared = ReturnType<Y.Doc["get"]>;

/**
 * Applies an edit to `copy`, a copy of the note kept for this check alone, and says whether each
 * item the edit added sits among items of its own parent and key, and whether each one the note
 * still shows is a kind of content a note can hold: the three roots, the elements and marks the
 * shared schema has, each element's own attributes, and frontmatter and metadata values. Yjs has
 * placed each item by then, so this reads where it really sits. It checks no values or nesting;
 * the full check at save does that. False when the edit can't be applied whole. After false,
 * `copy` may hold part of the edit, so the caller builds it again.
 *
 * The copy's `meta.schemaVersion` says which format the note is: 2 for a note whose body is one
 * sequence, and 1 or none for the first format, which the rules above are for. A note whose body
 * is one sequence gets that format's intake instead, when the relay admits such notes, and takes
 * no edit at all when it does not. An edit may give a first-format note that has no
 * `meta.schemaVersion` the number 1 and no other value, so no edit makes a note the other format.
 * No edit may replace or delete the one a note of either format has: the engine writes it once,
 * and a page that changed it would change what every reader takes the note to be before the save
 * refused it.
 */
export function liveEditFitsCopy(copy: Y.Doc, update: Uint8Array): boolean {
  return liveEditRefusal(copy, update) === undefined;
}

/**
 * Why a room does not take an edit. `limit` is there for an edit past a limit of its own: a
 * sentence that names the limit, its unit and what the edit holds.
 */
export interface LiveEditRefusal {
  readonly reason: "invalid-update" | "capacity-refused";
  readonly limit?: string;
}

/**
 * Why `liveEditFitsCopy` is false. An edit to a note whose body is one sequence that is large
 * enough to be past a limit is counted first, and refused for capacity when it alone holds more
 * than the save could take: more values than `BODY_SEQUENCE_CHANGE_MAX_VALUES`, or more items or
 * weight than a note may have. Then it is read once under the save's `policy` divided by how
 * often the save reads each thing, hashing nothing, so an edit a room takes is one whose counts
 * the save has room for. Without a policy it uses the validation worker's.
 */
export function liveEditRefusal(
  copy: Y.Doc,
  update: Uint8Array,
  policy: OrderedLiveUpdateCutPolicy = WORKER_LIVE_VALIDATION_POLICY,
  work?: BodySequenceIntakeWork,
): LiveEditRefusal | undefined {
  const invalid: LiveEditRefusal = { reason: "invalid-update" };
  if (!holdsBodySequence(copy)) return editFitsFormat1(copy, update) ? undefined : invalid;
  if (!bodySequenceNotesAdmitted) return invalid;
  return bodySequenceEditRefusal(copy, update, policy, work);
}

/**
 * Why a room would not take an edit to a note whose body is one sequence, whether or not this
 * process admits such notes: `liveEditRefusal` for a process that does.
 */
export function bodySequenceEditRefusal(
  copy: Y.Doc,
  update: Uint8Array,
  policy: OrderedLiveUpdateCutPolicy = WORKER_LIVE_VALIDATION_POLICY,
  work?: BodySequenceIntakeWork,
): LiveEditRefusal | undefined {
  const invalid: LiveEditRefusal = { reason: "invalid-update" };
  try {
    const limit = bodySequenceChangeLimit(update, policy, work);
    if (limit !== undefined) return { reason: "capacity-refused", limit };
    const keepsEngineMeta = engineMetaKept(copy);
    const refusal = bodySequenceChangeRefusal(
      copy,
      update,
      () => Y.applyUpdate(copy, update),
      { policy: bodySequenceRoomPolicy(policy), metadata: ROOM_METADATA },
      work,
    );
    if (refusal === undefined) return keepsEngineMeta() ? undefined : invalid;
    return refusal === "capacity-refused" ? { reason: refusal } : invalid;
  } catch {
    return invalid;
  }
}

function editFitsFormat1(copy: Y.Doc, update: Uint8Array): boolean {
  try {
    for (const struct of Y.decodeUpdate(update).structs) {
      // Yjs takes an empty item without moving its editor's clock, so the check would never read it.
      if (struct.length < 1) return false;
      // Yjs makes a root for each name an item gives, even one the same edit removes.
      if (!(struct instanceof Y.Item)) continue;
      if (typeof struct.parent === "string" && !PUBLIC_ROOTS.has(struct.parent)) return false;
      // The save refuses these kinds of content even in an item the same edit removes.
      const content = struct.content;
      if (
        content instanceof Y.ContentJSON ||
        (content instanceof Y.ContentType && content.type instanceof Y.XmlHook)
      )
        return false;
    }
  } catch {
    return false;
  }
  const version = copy.share.get("meta")?._map.get("schemaVersion");
  const hadVersion = version !== undefined && !version.deleted;
  const keepsEngineMeta = engineMetaKept(copy);
  let fits = true;
  // Read before the change ends: Yjs then joins each new item to the one before it from the same
  // editor without comparing their parents.
  const read = (transaction: Y.Transaction) => {
    if (!placedItemsFit(copy, transaction)) fits = false;
  };
  copy.on("beforeObserverCalls", read);
  try {
    Y.applyUpdate(copy, update);
  } catch {
    return false;
  } finally {
    copy.off("beforeObserverCalls", read);
  }
  return (
    fits &&
    !(hadVersion && version.deleted) &&
    keepsEngineMeta() &&
    copy.store.pendingStructs === null &&
    copy.store.pendingDs === null
  );
}

function engineMetaKept(copy: Y.Doc): () => boolean {
  const meta = copy.share.get("meta")?._map;
  const items = [...ENGINE_META_KEYS].flatMap((key) => {
    const item = meta?.get(key);
    return item && !item.deleted ? [item] : [];
  });
  return () => items.every((item) => !item.deleted);
}

function placedItemsFit(copy: Y.Doc, transaction: Y.Transaction): boolean {
  const schema = getDohcProseMirrorSchema();
  const roots = new Map<Shared, string>();
  for (const [name, type] of copy.share) roots.set(type, name);
  const xmlChild = (content: Y.Item["content"]) =>
    content instanceof Y.ContentType &&
    (content.type instanceof Y.XmlText ||
      (content.type instanceof Y.XmlElement &&
        Object.hasOwn(schema.nodes, content.type.nodeName) &&
        content.type.nodeName !== schema.topNodeType.name &&
        content.type.nodeName !== "text"));
  const value = (content: Y.Item["content"]) =>
    content instanceof Y.ContentAny ||
    (content instanceof Y.ContentType &&
      !(content.type instanceof Y.XmlHook) &&
      (content.type instanceof Y.Map || content.type instanceof Y.Array));
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = copy.store.clients.get(client)!;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index += 1) {
      const item = structs[index];
      if (!(item instanceof Y.Item)) continue;
      const type = item.parent as Shared | null;
      if (!type) return false;
      // Yjs links an item beside the one its edit names. An edit can name one under another parent
      // or key, which puts the item in that list while it still names its own parent.
      for (const near of [item.left, item.right])
        if (near && (near.parent !== type || near.parentSub !== item.parentSub)) return false;
      const parent = roots.get(type) ?? type,
        sub = item.parentSub,
        content = item.content;
      // A root a note can't have, a key in the body, or a frontmatter or metadata value under no
      // key stays in the note once removed.
      if (
        typeof parent === "string" &&
        (!PUBLIC_ROOTS.has(parent) || (parent === "body") !== (sub === null))
      )
        return false;
      if (parent === "meta" && sub !== null && ENGINE_META_KEYS.has(sub)) return false;
      if (
        parent === "meta" &&
        sub === "schemaVersion" &&
        (item.deleted ||
          item.length !== 1 ||
          !(content instanceof Y.ContentAny) ||
          content.arr[0] !== 1)
      )
        return false;
      // A removed item stays removed, so what it holds never shows.
      if (item.deleted) continue;
      const fits =
        parent === "body"
          ? sub === null && xmlChild(content)
          : parent === "frontmatter"
            ? sub !== null && value(content)
            : parent === "meta"
              ? sub !== null &&
                (META_KEYS.has(sub) || sub.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX)) &&
                content instanceof Y.ContentAny
              : typeof parent === "string"
                ? false
                : parent instanceof Y.XmlElement
                  ? sub === null
                    ? xmlChild(content)
                    : Object.hasOwn(schema.nodes[parent.nodeName]?.spec.attrs ?? {}, sub) &&
                      content instanceof Y.ContentAny
                  : parent instanceof Y.XmlText
                    ? sub === null &&
                      (content instanceof Y.ContentString ||
                        (content instanceof Y.ContentFormat &&
                          Object.hasOwn(schema.marks, markNameOf(content.key))))
                    : parent instanceof Y.XmlHook || parent instanceof Y.XmlFragment
                      ? false
                      : parent instanceof Y.Map
                        ? sub !== null && value(content)
                        : parent instanceof Y.Array && sub === null && value(content);
      if (!fits) return false;
    }
  }
  return true;
}

function bodyFingerprint(
  body: Y.XmlFragment,
  budget: ProjectionBudget | null,
  depth = 0,
): XmlFingerprint[] {
  if (budget !== null && body.length > budget.remaining) refuse("capacity-refused");
  const schema = getDohcProseMirrorSchema();
  const permitsText =
    body instanceof Y.XmlElement &&
    schema.nodes[body.nodeName]?.contentMatch.matchType(schema.nodes.text) != null;
  // The engine's Markdown writer turns a left-out shell into blank lines only in the body or a
  // bullet or to-do list. Elsewhere it changes the file, such as a list's numbers or a table cell.
  const leavesOutShells =
    !(body instanceof Y.XmlElement) ||
    body.nodeName === "bulletList" ||
    body.nodeName === "taskList";
  const children: XmlFingerprint[] = [];
  for (const child of body.toArray()) {
    const fingerprint = xmlFingerprint(child, depth, budget);
    if (permitsText && fingerprint.kind === "text" && fingerprint.delta.length === 0) continue;
    // A reading leaves out an empty shell, so the comparison does too. A shell carrying an
    // attribute the schema doesn't know would hide it, so that one is still compared and refused.
    if (
      leavesOutShells &&
      fingerprint.kind === "element" &&
      fingerprint.children.length === 0 &&
      child instanceof Y.XmlElement &&
      isEmptyShell(child) &&
      fingerprint.attributes.every(([key]) =>
        Object.hasOwn(schema.nodes[child.nodeName]!.spec.attrs ?? {}, key),
      )
    )
      continue;
    // A reading joins neighbouring texts, as two editors typing into one new line leave them.
    const previous = children.at(-1);
    if (fingerprint.kind === "text" && previous?.kind === "text") {
      const [first, ...rest] = fingerprint.delta,
        last = previous.delta.at(-1);
      if (first && last && semanticEqual(first.attributes, last.attributes))
        previous.delta[previous.delta.length - 1] = {
          insert: last.insert + first.insert,
          attributes: last.attributes,
        };
      else if (first) previous.delta.push(first);
      previous.delta.push(...rest);
      continue;
    }
    children.push(fingerprint);
  }
  return children;
}

function xmlFingerprint(
  value: Y.XmlElement | Y.XmlText | Y.XmlHook,
  depth: number,
  budget: ProjectionBudget | null,
): XmlFingerprint {
  if (value instanceof Y.XmlHook) refuse("invalid-schema");
  if (value instanceof Y.XmlElement) {
    budget?.consume(depth);
    if (budget !== null && value.length > budget.remaining) refuse("capacity-refused");
    const attributes = value.getAttributes() as Record<string, unknown>;
    const entries = sortedValueEntries(attributes);
    for (const [key, attribute] of entries) {
      if (budget !== null) {
        visitPublicValue(attribute, depth + 1, budget, new Set());
        if (!validBodyAttribute(value.nodeName, key, attribute)) refuse("invalid-schema");
      }
    }
    return {
      kind: "element",
      nodeName: value.nodeName,
      attributes: entries,
      children: bodyFingerprint(value, budget, depth + 1),
    };
  }
  if (!(value instanceof Y.XmlText)) refuse("invalid-schema");
  budget?.consume(depth);
  const delta = value.toDelta();
  const runs: TextFingerprint["delta"] = [];
  for (const run of delta) {
    if (typeof run.insert !== "string" || run.insert.length === 0) {
      refuse("invalid-schema");
    }
    budget?.consumeNode();
    const attributes = (run.attributes ?? {}) as Record<string, unknown>;
    const entries = sortedValueEntries(attributes);
    for (const [name, attribute] of entries) {
      if (budget !== null) {
        visitPublicValue(attribute, depth + 2, budget, new Set());
        validateMarkAttributes(name, attribute);
      }
    }
    runs.push({ insert: run.insert, attributes: entries });
  }
  return { kind: "text", delta: runs };
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => semanticEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        semanticEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function validateMetadata(
  meta: Y.Map<unknown>,
  zeroStructSeed: boolean,
  engineReader: boolean,
  schemaVersion: number,
): { metadata: Record<string, unknown>; witness: ReturnType<typeof readMarkdownSourceWitness> } {
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, value] of meta.entries()) {
    if (key === LINEAGE_EPOCH_META_KEY) {
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) refuse("invalid-schema");
      snapshot[key] = value;
      continue;
    }
    if (engineReader && key === "dohcMarkdownSourceReader") {
      if (value !== 1) refuse("invalid-schema");
      snapshot[key] = value;
      continue;
    }
    if (!META_KEYS.has(key) && !key.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX))
      refuse("invalid-schema");
    snapshot[key] = value;
  }
  if (Object.hasOwn(snapshot, "schemaVersion")) {
    if (snapshot.schemaVersion !== schemaVersion) refuse("invalid-schema");
  } else if (!zeroStructSeed) refuse("invalid-schema");
  if (Object.hasOwn(snapshot, "dohcMarkdownCrlf") && snapshot.dohcMarkdownCrlf !== true) {
    refuse("invalid-schema");
  }
  // Frontmatter text is never longer than the document it leads.
  if (
    Object.hasOwn(snapshot, "dohcFrontmatterSource") &&
    (typeof snapshot.dohcFrontmatterSource !== "string" ||
      exceedsLiveMarkdownLimit(snapshot.dohcFrontmatterSource))
  )
    refuse("invalid-schema");
  // The item records name each frontmatter key once, as `client:clock`.
  let itemBytes = 0;
  for (const [key, item] of Object.entries(snapshot)) {
    if (!key.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX)) continue;
    if (typeof item !== "string") refuse("invalid-schema");
    itemBytes += utf8.encode(key).length + utf8.encode(item).length;
    if (itemBytes > 2 * 1024 * 1024) refuse("invalid-schema");
  }
  const witness = readMarkdownSourceWitness(snapshot);
  if (witness === "invalid") refuse("invalid-schema");
  return { metadata: snapshot, witness };
}

let format1Schema: Schema | undefined;

// Format 1 stores and writes inline code under a link or bold, as `[`npm install`](…)` and
// `**`flag`**`. The shared schema keeps code exclusive because format 2 reads a letter of inline
// code with code alone (https://github.com/dohchq/dohc/issues/4601).
function format1BodySchema(): Schema {
  if (format1Schema) return format1Schema;
  const { spec, marks } = getDohcProseMirrorSchema();
  const excludes = Object.keys(marks)
    .filter((name) => name !== "link" && name !== "bold")
    .join(" ");
  format1Schema = new Schema({
    ...spec,
    marks: spec.marks.update("code", { ...spec.marks.get("code"), excludes }),
  });
  return format1Schema;
}

function joinsInlineCode(blocks: XmlFingerprint[]): boolean {
  return blocks.some((block) =>
    block.kind === "text"
      ? block.delta.some((run, index) => {
          const next = block.delta[index + 1];
          return (
            next !== undefined &&
            [run, next].every(({ attributes }) => attributes.some(([name]) => name === "code")) &&
            !semanticEqual(run.attributes, next.attributes)
          );
        })
      : joinsInlineCode(block.children),
  );
}

/** A format-1 body: what it shows must be what it stores, with nothing the schema refuses. */
function validateBody(
  body: Y.XmlFragment,
  originalFingerprint: XmlFingerprint[],
  hasActiveItem: boolean,
): void {
  let rootNode: ReturnType<typeof yXmlFragmentToProseMirrorRootNode>;
  try {
    rootNode = yXmlFragmentToProseMirrorRootNode(body, format1BodySchema());
    if (!hasActiveItem) {
      const json = rootNode.toJSON();
      if (Object.keys(json).length !== 1 || json.type !== "doc") refuse("invalid-schema");
    } else rootNode.check();
  } catch (error) {
    // Only a schema verdict refuses the document; anything else is a validator failure.
    if (!isProseMirrorSchemaError(error)) throw error;
    refuse("invalid-schema");
  }
  if (!hasActiveItem) return;
  const rebuilt = new Y.Doc({ gc: false });
  try {
    const rebuiltBody = rebuilt.getXmlFragment("body");
    prosemirrorJSONToYXmlFragment(format1BodySchema(), rootNode.toJSON(), rebuiltBody);
    if (!semanticEqual(originalFingerprint, bodyFingerprint(rebuiltBody, null)))
      refuse("invalid-schema");
  } catch (error) {
    if (!isProseMirrorSchemaError(error)) throw error;
    refuse("invalid-schema");
  } finally {
    rebuilt.destroy();
  }
}

function writtenMarkdown(scratch: Y.Doc): string {
  try {
    return yDocToMarkdown(scratch);
  } catch (error) {
    if (error instanceof Error && error.message === FRONTMATTER_EDIT_REFUSED_MESSAGE)
      refuse("invalid-schema");
    throw error;
  }
}

function validatePublicState(
  scratch: Y.Doc,
  policy: OrderedLiveUpdateCutPolicy,
  topology: Extract<ProjectionTopology, { kind: "compatible" }>,
  unverifiedSource: UnverifiedSource,
  engineReader = false,
): string {
  // Projection and reimport are the costliest steps, so a note too dense for them is refused first.
  if (!withinLiveNoteCapacity(scratch, policy)) refuse("capacity-refused");
  const bodySequence = bodySequenceNotesAdmitted && holdsBodySequence(scratch);
  const roots = bodySequence ? BODY_SEQUENCE_NOTE_ROOTS : PUBLIC_ROOTS;
  if (
    [...PUBLIC_ROOTS].some((key) => !scratch.share.has(key)) ||
    [...scratch.share.keys()].some((key) => !roots.has(key)) ||
    !(scratch.share.get("body") instanceof Y.XmlFragment) ||
    !(scratch.share.get("frontmatter") instanceof Y.Map) ||
    !(scratch.share.get("meta") instanceof Y.Map)
  )
    refuse("invalid-schema");
  const body = scratch.getXmlFragment("body");
  const frontmatter = scratch.getMap("frontmatter");
  const meta = scratch.getMap("meta");
  const zeroStructSeed =
    topology.canonicalZeroStructSeed &&
    !topology.bodyHasActiveItem &&
    body.length === 0 &&
    frontmatter.size === 0 &&
    meta.size === 0;
  const { metadata, witness } = validateMetadata(
    meta,
    zeroStructSeed,
    engineReader,
    bodySequence ? 2 : 1,
  );
  const budget = new ProjectionBudget();
  for (const value of frontmatter.values()) visitPublicValue(value, 0, budget, new Set());
  const storedBody = bodySequence ? undefined : bodyFingerprint(body, budget);
  const frontmatterSnapshot = getDohcYDocFrontmatter(scratch);
  if (storedBody) validateBody(body, storedBody, topology.bodyHasActiveItem);
  if (storedBody && joinsInlineCode(storedBody)) refuse("invalid-schema");
  const projectedMarkdown = writtenMarkdown(scratch);
  if (exceedsLiveMarkdownLimit(projectedMarkdown)) refuse("capacity-refused");
  const emptied =
    storedBody?.every(
      (block) =>
        block.kind === "element" && block.nodeName === "paragraph" && block.children.length === 0,
    ) === true;
  if (
    !bodySequence &&
    !emptied &&
    metadata.dohcMarkdownCrlf === true &&
    !projectedMarkdown.includes("\r\n")
  )
    refuse("invalid-schema");
  const source = resolveMarkdownSource(scratch, projectedMarkdown, witness, engineReader);
  if (source.kind === "capacity-refused") refuse("capacity-refused");
  if (
    source.kind === "invalid" ||
    source.kind === "import-failed" ||
    (source.kind === "unverified" && unverifiedSource === "refuse")
  )
    refuse("invalid-schema");
  if (bodySequence) {
    // What the body holds never decides this: the properties are written with no body and read back.
    const written = markdownToYDoc(yDocPropertiesToMarkdown(scratch));
    try {
      if (!semanticEqual(frontmatterSnapshot, getDohcYDocFrontmatter(written)))
        refuse("invalid-schema");
    } finally {
      written.destroy();
    }
  } else if (!zeroStructSeed) {
    const reimported = markdownToYDoc(projectedMarkdown);
    try {
      if (!semanticEqual(frontmatterSnapshot, getDohcYDocFrontmatter(reimported)))
        refuse("invalid-schema");
      const withoutSources = (values: Record<string, unknown>) => {
        const kept = { ...values };
        delete kept[LINEAGE_EPOCH_META_KEY];
        if (emptied) delete kept.dohcMarkdownCrlf;
        if (engineReader) delete kept.dohcMarkdownSourceReader;
        for (const key of PROJECTION_SOURCE_META_KEYS) delete kept[key];
        for (const key of Object.keys(kept))
          if (key.startsWith(FRONTMATTER_SOURCE_ITEM_META_PREFIX)) delete kept[key];
        return kept;
      };
      if (
        !semanticEqual(
          withoutSources(metadata),
          withoutSources(Object.fromEntries(reimported.getMap("meta").entries())),
        )
      )
        refuse("invalid-schema");
    } finally {
      reimported.destroy();
    }
  }
  return source.kind === "verified" ? source.markdown : projectedMarkdown;
}
