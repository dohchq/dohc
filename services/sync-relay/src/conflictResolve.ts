import { createHash } from "node:crypto";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { validateUserWritePath } from "@dohc/workspace-core";
import { stableJsonStringify } from "./canonicalJson";
import { RELAY_ERRORS } from "./errorCodes";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_WORKSPACE_PATH_BYTES = 1_024;
const MAX_METADATA_FIELD_BYTES = 16 * 1024;
const MAX_AUTHOR_FIELD_BYTES = 512;

const METADATA_ORIGINS = new Set([
  "api",
  "local-file",
  "restore",
  "sync",
  "unknown",
]);

export interface ConflictResolveEnvelopeContext {
  workspaceId: string;
  recordedAtMs: number;
}

interface Metadata {
  origin: string;
  summary: string | null;
  correlationId: string | null;
}

interface AgentAuthor {
  kind: "agent";
  agentId: string;
  onBehalfOf: string;
  agentRunId: string | null;
}

interface AbsentSide {
  present: false;
  pathRef: number;
}

interface PresentSide {
  present: true;
  pathRef: number;
  objectId: string;
  latestMomentId: string;
  contentKind: "text" | "binary";
  blobSha256: string;
  byteLength: number;
  updatedAtMs: number;
}

type Side = AbsentSide | PresentSide;

interface EffectContext {
  recordedAtMs: number;
  metadata: Metadata;
  author: AgentAuthor | null;
  currentObjectCreatedAtMs: number | null;
  resultObjectCreatedAtMs: number | null;
}

interface Effect {
  kind: "delete" | "write";
  momentId: string;
  payloadSha256: string;
}

interface Successor {
  lineageClaimId: string;
  epochTag: string;
  contentKind: "plaintext" | "richdoc";
  resultSha256: string;
  updateBlobSha256: string;
  stateVectorBlobSha256: string;
}

interface LineageTransition {
  predecessorClaimId: string;
  predecessorStateVectorSha256: string;
  artifactPreimageSha256: string;
  successor: Successor | null;
}

interface ParsedResolve {
  workspaceId: string;
  conflictId: string;
  chosenFrom: "current" | "incoming" | "merged";
  resolution: "kept-current" | "applied-incoming" | "applied-merged";
  targetVersionId: string;
  sourceVersionId: string;
  paths: string[];
  current: Side;
  incoming: Side;
  result: Side;
  effectContext: EffectContext;
  effects: Effect[];
  lineageTransition: LineageTransition | null;
}

export class SyncRelayInvalidConflictResolveError extends Error {
  readonly statusCode = RELAY_ERRORS.bad_request.status;
  readonly code = RELAY_ERRORS.bad_request.code;
}

function invalid(reason: string): never {
  throw new SyncRelayInvalidConflictResolveError(
    `invalid conflict.resolve formatVersion 1 payload: ${reason}`,
  );
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = asRecord(value, label);
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    invalid(`${label} has unknown or missing fields`);
  }
  return record;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function wellFormedUnicode(value: string, label: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      invalid(
        `${label} must contain well-formed Unicode; unpaired UTF-16 surrogate at code unit ${index}`,
      );
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid(
        `${label} must contain well-formed Unicode; unpaired UTF-16 surrogate at code unit ${index}`,
      );
    }
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  const parsed = wellFormedUnicode(value, label);
  const observed = utf8Bytes(parsed);
  if (observed > MAX_IDENTIFIER_BYTES) {
    invalid(
      `${label} exceeds MAX_IDENTIFIER_BYTES (${MAX_IDENTIFIER_BYTES} bytes); observed ${observed} bytes`,
    );
  }
  if (ASCII_CONTROL.test(parsed)) invalid(`${label} contains an ASCII control character`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    invalid(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function wireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nullableWireInteger(value: unknown, label: string): number | null {
  return value === null ? null : wireInteger(value, label);
}

function nullableMetadataField(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalid(`${label} must be a string or null`);
  const parsed = wellFormedUnicode(value, label);
  const observed = utf8Bytes(parsed);
  if (observed > MAX_METADATA_FIELD_BYTES) {
    invalid(
      `${label} exceeds MAX_METADATA_FIELD_BYTES (${MAX_METADATA_FIELD_BYTES} bytes); observed ${observed} bytes`,
    );
  }
  return parsed;
}

function metadata(value: unknown): Metadata {
  const record = exactKeys(
    value,
    ["origin", "summary", "correlationId"],
    "effectContext.metadata",
  );
  if (typeof record.origin !== "string" || !METADATA_ORIGINS.has(record.origin)) {
    invalid("effectContext.metadata.origin is invalid");
  }
  return {
    origin: record.origin,
    summary: nullableMetadataField(
      record.summary,
      "effectContext.metadata.summary",
    ),
    correlationId: nullableMetadataField(
      record.correlationId,
      "effectContext.metadata.correlationId",
    ),
  };
}

function authorField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  const parsed = wellFormedUnicode(value, label);
  const observed = utf8Bytes(parsed);
  if (observed > MAX_AUTHOR_FIELD_BYTES) {
    invalid(
      `${label} exceeds MAX_AUTHOR_FIELD_BYTES (${MAX_AUTHOR_FIELD_BYTES} bytes); observed ${observed} bytes`,
    );
  }
  if (ASCII_CONTROL.test(parsed)) invalid(`${label} contains an ASCII control character`);
  return parsed;
}

function author(value: unknown): AgentAuthor | null {
  if (value === null) return null;
  const record = exactKeys(
    value,
    ["kind", "agentId", "onBehalfOf", "agentRunId"],
    "effectContext.author",
  );
  if (record.kind !== "agent") invalid("effectContext.author.kind must be agent");
  return {
    kind: "agent",
    agentId: authorField(record.agentId, "effectContext.author.agentId"),
    onBehalfOf: authorField(
      record.onBehalfOf,
      "effectContext.author.onBehalfOf",
    ),
    agentRunId:
      record.agentRunId === null
        ? null
        : authorField(record.agentRunId, "effectContext.author.agentRunId"),
  };
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    invalid("paths must contain one or two strings");
  }
  const parsed = value.map((raw, index) => {
    if (typeof raw !== "string" || raw.length === 0) {
      invalid(`paths[${index}] must be a non-empty string`);
    }
    const path = wellFormedUnicode(raw, `paths[${index}]`);
    const observed = utf8Bytes(path);
    if (observed > MAX_WORKSPACE_PATH_BYTES) {
      invalid(
        `paths[${index}] exceeds MAX_WORKSPACE_PATH_BYTES (${MAX_WORKSPACE_PATH_BYTES} bytes); observed ${observed} bytes`,
      );
    }
    if (ASCII_CONTROL.test(path)) {
      invalid(`paths[${index}] contains an ASCII control character`);
    }
    const validated = validateUserWritePath(path);
    if (!validated.ok || validated.normalized !== path) {
      invalid(`paths[${index}] is not a canonical workspace-relative path`);
    }
    if (classifyEngineFilePath(path).kind !== "tracked") {
      invalid(`paths[${index}] is not a tracked path`);
    }
    return path;
  });
  if (new Set(parsed).size !== parsed.length) invalid("paths must be distinct");
  return parsed;
}

function pathRef(value: unknown, count: number, label: string): number {
  const parsed = wireInteger(value, label);
  if (parsed >= count) invalid(`${label} does not reference paths`);
  return parsed;
}

function side(value: unknown, count: number, label: string): Side {
  const record = asRecord(value, label);
  if (record.present === false) {
    const absent = exactKeys(value, ["present", "pathRef"], label);
    return {
      present: false,
      pathRef: pathRef(absent.pathRef, count, `${label}.pathRef`),
    };
  }
  if (record.present !== true) invalid(`${label}.present must be a boolean`);
  const present = exactKeys(
    value,
    [
      "present",
      "pathRef",
      "objectId",
      "latestMomentId",
      "contentKind",
      "blobSha256",
      "byteLength",
      "updatedAtMs",
    ],
    label,
  );
  if (present.contentKind !== "text" && present.contentKind !== "binary") {
    invalid(`${label}.contentKind is invalid`);
  }
  return {
    present: true,
    pathRef: pathRef(present.pathRef, count, `${label}.pathRef`),
    objectId: identifier(present.objectId, `${label}.objectId`),
    latestMomentId: identifier(
      present.latestMomentId,
      `${label}.latestMomentId`,
    ),
    contentKind: present.contentKind,
    blobSha256: sha256(present.blobSha256, `${label}.blobSha256`),
    byteLength: wireInteger(present.byteLength, `${label}.byteLength`),
    updatedAtMs: wireInteger(present.updatedAtMs, `${label}.updatedAtMs`),
  };
}

function effectContext(value: unknown): EffectContext {
  const record = exactKeys(
    value,
    [
      "recordedAtMs",
      "metadata",
      "author",
      "currentObjectCreatedAtMs",
      "resultObjectCreatedAtMs",
    ],
    "effectContext",
  );
  return {
    recordedAtMs: wireInteger(record.recordedAtMs, "effectContext.recordedAtMs"),
    metadata: metadata(record.metadata),
    author: author(record.author),
    currentObjectCreatedAtMs: nullableWireInteger(
      record.currentObjectCreatedAtMs,
      "effectContext.currentObjectCreatedAtMs",
    ),
    resultObjectCreatedAtMs: nullableWireInteger(
      record.resultObjectCreatedAtMs,
      "effectContext.resultObjectCreatedAtMs",
    ),
  };
}

function effects(value: unknown): Effect[] {
  if (!Array.isArray(value) || value.length > 2) {
    invalid("effects must contain at most two entries");
  }
  return value.map((raw, index) => {
    const record = exactKeys(
      raw,
      ["kind", "momentId", "payloadSha256"],
      `effects[${index}]`,
    );
    if (record.kind !== "delete" && record.kind !== "write") {
      invalid(`effects[${index}].kind is invalid`);
    }
    return {
      kind: record.kind,
      momentId: identifier(record.momentId, `effects[${index}].momentId`),
      payloadSha256: sha256(
        record.payloadSha256,
        `effects[${index}].payloadSha256`,
      ),
    };
  });
}

function successor(value: unknown): Successor | null {
  if (value === null) return null;
  const record = exactKeys(
    value,
    [
      "lineageClaimId",
      "epochTag",
      "contentKind",
      "resultSha256",
      "updateBlobSha256",
      "stateVectorBlobSha256",
    ],
    "successor",
  );
  if (record.contentKind !== "plaintext" && record.contentKind !== "richdoc") {
    invalid("successor.contentKind is invalid");
  }
  return {
    lineageClaimId: sha256(record.lineageClaimId, "successor.lineageClaimId"),
    epochTag: sha256(record.epochTag, "successor.epochTag"),
    contentKind: record.contentKind,
    resultSha256: sha256(record.resultSha256, "successor.resultSha256"),
    updateBlobSha256: sha256(
      record.updateBlobSha256,
      "successor.updateBlobSha256",
    ),
    stateVectorBlobSha256: sha256(
      record.stateVectorBlobSha256,
      "successor.stateVectorBlobSha256",
    ),
  };
}

function lineageTransition(value: unknown): LineageTransition | null {
  if (value === null) return null;
  const record = exactKeys(
    value,
    [
      "predecessorClaimId",
      "predecessorStateVectorSha256",
      "artifactPreimageSha256",
      "successor",
    ],
    "lineageTransition",
  );
  return {
    predecessorClaimId: sha256(
      record.predecessorClaimId,
      "lineageTransition.predecessorClaimId",
    ),
    predecessorStateVectorSha256: sha256(
      record.predecessorStateVectorSha256,
      "lineageTransition.predecessorStateVectorSha256",
    ),
    artifactPreimageSha256: sha256(
      record.artifactPreimageSha256,
      "lineageTransition.artifactPreimageSha256",
    ),
    successor: successor(record.successor),
  };
}

function sameSide(left: Side, right: Side): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function sameProjectedContent(left: Side, right: Side): boolean {
  if (!left.present || !right.present) return left.present === right.present;
  return (
    left.pathRef === right.pathRef &&
    left.contentKind === right.contentKind &&
    left.blobSha256 === right.blobSha256 &&
    left.byteLength === right.byteLength
  );
}

function canonicalAuthor(value: AgentAuthor | null): Record<string, unknown> | null {
  if (value === null) return null;
  return {
    kind: "agent",
    agentId: value.agentId,
    onBehalfOf: value.onBehalfOf,
    ...(value.agentRunId === null ? {} : { agentRunId: value.agentRunId }),
  };
}

function deleteShadow(
  payload: ParsedResolve,
  effect: Effect,
  effectIndex: number,
): Record<string, unknown> {
  const current = payload.current;
  if (!current.present || payload.effectContext.currentObjectCreatedAtMs === null) {
    invalid("a delete effect requires a present current side");
  }
  const path = payload.paths[current.pathRef];
  return {
    conflictId: payload.conflictId,
    conflictEffectIndex: effectIndex,
    momentId: effect.momentId,
    versionId: payload.targetVersionId,
    objectId: current.objectId,
    objectCreatedAtMs: payload.effectContext.currentObjectCreatedAtMs,
    path,
    recordedAtMs: payload.effectContext.recordedAtMs,
    operation: "delete",
    payloadBeforeBlobSha256: current.blobSha256,
    payloadBeforePath: path,
    payloadAfterBlobSha256: current.blobSha256,
    payloadAfterPath: path,
    payloadBeforeContentKind: current.contentKind,
    payloadBeforeByteLength: current.byteLength,
    payloadAfterContentKind: current.contentKind,
    payloadAfterByteLength: current.byteLength,
    metadata: payload.effectContext.metadata,
    author: canonicalAuthor(payload.effectContext.author),
    beforePresent: "present",
    beforeObjectId: current.objectId,
    beforeVersionId: payload.targetVersionId,
    beforePath: path,
    beforeBlobSha256: current.blobSha256,
    beforeContentKind: current.contentKind,
    beforeByteLength: current.byteLength,
    beforeUpdatedAtMs: current.updatedAtMs,
    beforeLatestMomentId: current.latestMomentId,
    beforeMetadata: null,
  };
}

function writeShadow(
  payload: ParsedResolve,
  effect: Effect,
  effectIndex: number,
): Record<string, unknown> {
  const result = payload.result;
  if (!result.present || payload.effectContext.resultObjectCreatedAtMs === null) {
    invalid("a write effect requires a present result side");
  }
  const resultPath = payload.paths[result.pathRef];
  const before =
    payload.current.present && payload.current.pathRef === result.pathRef
      ? payload.current
      : null;
  return {
    conflictId: payload.conflictId,
    conflictEffectIndex: effectIndex,
    momentId: effect.momentId,
    versionId: payload.targetVersionId,
    objectId: result.objectId,
    objectCreatedAtMs: payload.effectContext.resultObjectCreatedAtMs,
    path: resultPath,
    recordedAtMs: payload.effectContext.recordedAtMs,
    operation: "write",
    payloadBeforeBlobSha256: before?.blobSha256 ?? null,
    payloadBeforePath: before === null ? null : payload.paths[before.pathRef],
    payloadAfterBlobSha256: result.blobSha256,
    payloadAfterPath: resultPath,
    payloadBeforeContentKind: before?.contentKind ?? null,
    payloadBeforeByteLength: before?.byteLength ?? null,
    payloadAfterContentKind: result.contentKind,
    payloadAfterByteLength: result.byteLength,
    metadata: payload.effectContext.metadata,
    author: canonicalAuthor(payload.effectContext.author),
    beforePresent: before === null ? "null" : "present",
    beforeObjectId: before?.objectId ?? null,
    beforeVersionId: before === null ? null : payload.targetVersionId,
    beforePath: before === null ? null : payload.paths[before.pathRef],
    beforeBlobSha256: before?.blobSha256 ?? null,
    beforeContentKind: before?.contentKind ?? null,
    beforeByteLength: before?.byteLength ?? null,
    beforeUpdatedAtMs: before?.updatedAtMs ?? null,
    beforeLatestMomentId: before?.latestMomentId ?? null,
    beforeMetadata: null,
  };
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function validateBindings(payload: ParsedResolve): void {
  const choicePairs = new Map([
    ["current", "kept-current"],
    ["incoming", "applied-incoming"],
    ["merged", "applied-merged"],
  ]);
  if (choicePairs.get(payload.chosenFrom) !== payload.resolution) {
    invalid("chosenFrom and resolution do not match");
  }
  if (payload.current.pathRef !== 0) invalid("transition.current.pathRef must be 0");
  const usedPaths = new Set([
    payload.current.pathRef,
    payload.incoming.pathRef,
    payload.result.pathRef,
  ]);
  if (usedPaths.size !== payload.paths.length) invalid("paths contains an unused entry");

  const currentCreated = payload.effectContext.currentObjectCreatedAtMs;
  const resultCreated = payload.effectContext.resultObjectCreatedAtMs;
  if (payload.current.present !== (currentCreated !== null)) {
    invalid("currentObjectCreatedAtMs does not match transition.current");
  }
  if (payload.result.present !== (resultCreated !== null)) {
    invalid("resultObjectCreatedAtMs does not match transition.result");
  }
  if (
    payload.current.present &&
    payload.result.present &&
    payload.current.objectId === payload.result.objectId &&
    currentCreated !== resultCreated
  ) {
    invalid("one object has conflicting creation times");
  }

  if (payload.resolution === "kept-current" && !sameSide(payload.current, payload.result)) {
    invalid("kept-current result must equal current");
  }
  if (
    payload.resolution === "applied-incoming" &&
    !sameProjectedContent(payload.incoming, payload.result)
  ) {
    invalid("applied-incoming result does not match incoming content");
  }
  if (
    payload.resolution === "applied-merged" &&
    (!payload.result.present ||
      payload.result.contentKind !== "text" ||
      payload.result.pathRef !== 0)
  ) {
    invalid("applied-merged requires a text result on the current anchor path");
  }

  let expectedKinds: Effect["kind"][];
  if (sameSide(payload.current, payload.result)) {
    expectedKinds = [];
  } else if (payload.current.present && !payload.result.present) {
    expectedKinds = ["delete"];
  } else if (
    payload.current.present &&
    payload.result.present &&
    payload.current.pathRef !== payload.result.pathRef
  ) {
    expectedKinds = ["delete", "write"];
  } else if (payload.result.present) {
    expectedKinds = ["write"];
  } else {
    expectedKinds = [];
  }
  if (
    payload.effects.length !== expectedKinds.length ||
    payload.effects.some((effect, index) => effect.kind !== expectedKinds[index])
  ) {
    invalid("effects do not match the ordered state transition");
  }
  if (new Set(payload.effects.map((effect) => effect.momentId)).size !== payload.effects.length) {
    invalid("effect moment IDs must be unique");
  }
  const write = payload.effects.find((effect) => effect.kind === "write");
  if (write && (!payload.result.present || payload.result.latestMomentId !== write.momentId)) {
    invalid("the write effect does not match the result latestMomentId");
  }
  if (write && payload.result.present && payload.result.updatedAtMs !== payload.effectContext.recordedAtMs) {
    invalid("the write result timestamp does not match effectContext.recordedAtMs");
  }

  const lineage = payload.lineageTransition;
  if (lineage !== null) {
    if (!payload.current.present) {
      invalid("lineageTransition requires a present current side");
    }
    if (lineage.artifactPreimageSha256 !== payload.current.blobSha256) {
      invalid(
        "lineageTransition.artifactPreimageSha256 does not match the current blob",
      );
    }
  }
  const next = lineage?.successor ?? null;
  if (next !== null) {
    if (
      !payload.current.present ||
      !payload.result.present ||
      payload.current.contentKind !== "text" ||
      payload.result.contentKind !== "text" ||
      payload.result.objectId !== payload.current.objectId
    ) {
      invalid("successor requires a same-object text result");
    }
    if (next.lineageClaimId !== next.updateBlobSha256) {
      invalid("successor lineageClaimId must equal updateBlobSha256");
    }
    if (next.resultSha256 !== payload.result.blobSha256) {
      invalid("successor resultSha256 does not match the result blob");
    }
  } else if (
    lineage !== null &&
    payload.current.present &&
    payload.result.present &&
    payload.result.contentKind === "text" &&
    payload.result.objectId === payload.current.objectId
  ) {
    invalid("a same-object text lineage transition requires a successor");
  }

  for (const [effectIndex, effect] of payload.effects.entries()) {
    const shadow =
      effect.kind === "delete"
        ? deleteShadow(payload, effect, effectIndex)
        : writeShadow(payload, effect, effectIndex);
    const shadowJson = stableJsonStringify(shadow);
    const observedBytes = utf8Bytes(shadowJson);
    if (observedBytes > MAX_PAYLOAD_JSON_BYTES) {
      invalid(
        `canonical ${effect.kind} shadow exceeds MAX_PAYLOAD_JSON_BYTES (${MAX_PAYLOAD_JSON_BYTES} bytes); observed ${observedBytes} bytes`,
      );
    }
    if (sha256Canonical(shadow) !== effect.payloadSha256) {
      invalid(`${effect.kind} payloadSha256 does not match its canonical shadow`);
    }
  }
}

export function conflictResolveBlobShas(
  payloadJson: string,
  envelope: ConflictResolveEnvelopeContext,
): string[] {
  const observedBytes = utf8Bytes(payloadJson);
  if (observedBytes > MAX_PAYLOAD_JSON_BYTES) {
    invalid(
      `payload exceeds MAX_PAYLOAD_JSON_BYTES (${MAX_PAYLOAD_JSON_BYTES} bytes); observed ${observedBytes} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    invalid("payload is not JSON");
  }
  const record = exactKeys(
    parsed,
    [
      "formatVersion",
      "workspaceId",
      "conflictId",
      "status",
      "chosenFrom",
      "resolution",
      "targetVersionId",
      "sourceVersionId",
      "paths",
      "transition",
      "effectContext",
      "effects",
      "lineageTransition",
    ],
    "payload",
  );
  if (record.formatVersion !== 1) invalid("formatVersion must be 1");
  if (record.status !== "resolved") invalid("status must be resolved");
  if (
    record.chosenFrom !== "current" &&
    record.chosenFrom !== "incoming" &&
    record.chosenFrom !== "merged"
  ) {
    invalid("chosenFrom is invalid");
  }
  if (
    record.resolution !== "kept-current" &&
    record.resolution !== "applied-incoming" &&
    record.resolution !== "applied-merged"
  ) {
    invalid("resolution is invalid");
  }
  const workspaceId = identifier(record.workspaceId, "workspaceId");
  if (workspaceId !== envelope.workspaceId) invalid("workspaceId does not match the envelope");
  const parsedPaths = paths(record.paths);
  const transition = exactKeys(
    record.transition,
    ["current", "incoming", "result"],
    "transition",
  );
  const context = effectContext(record.effectContext);
  if (context.recordedAtMs !== envelope.recordedAtMs) {
    invalid("effectContext.recordedAtMs does not match the envelope");
  }
  const payload: ParsedResolve = {
    workspaceId,
    conflictId: identifier(record.conflictId, "conflictId"),
    chosenFrom: record.chosenFrom,
    resolution: record.resolution,
    targetVersionId: identifier(record.targetVersionId, "targetVersionId"),
    sourceVersionId: identifier(record.sourceVersionId, "sourceVersionId"),
    paths: parsedPaths,
    current: side(transition.current, parsedPaths.length, "transition.current"),
    incoming: side(transition.incoming, parsedPaths.length, "transition.incoming"),
    result: side(transition.result, parsedPaths.length, "transition.result"),
    effectContext: context,
    effects: effects(record.effects),
    lineageTransition: lineageTransition(record.lineageTransition),
  };
  validateBindings(payload);

  const roots: string[] = [];
  for (const candidate of [payload.current, payload.incoming, payload.result]) {
    if (candidate.present) roots.push(candidate.blobSha256);
  }
  const next = payload.lineageTransition?.successor;
  if (next) {
    roots.push(
      next.updateBlobSha256,
      next.stateVectorBlobSha256,
    );
  }
  return roots;
}
