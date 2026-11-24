import { sha256Hex } from "@dohc/workspace-core/hash";
import { stableJsonStringify } from "./canonicalJson";

type Side = {
  present: true;
  pathRef: number;
  objectId: string;
  latestMomentId: string;
  contentKind: "text" | "binary";
  blobSha256: string;
  byteLength: number;
  updatedAtMs: number;
};
type Effect = { kind: "delete" | "write"; momentId: string; payloadSha256: string };

export type NoteResolvePayload = {
  formatVersion: 1;
  workspaceId: string;
  conflictId: string;
  status: "resolved";
  chosenFrom: string;
  resolution: string;
  targetVersionId: string;
  sourceVersionId: string;
  paths: string[];
  transition: { current: Side; incoming: Side; result: Side };
  effectContext: {
    recordedAtMs: number;
    metadata: { origin: string; summary: null; correlationId: null };
    author: null;
    currentObjectCreatedAtMs: number;
    resultObjectCreatedAtMs: number;
  };
  effects: Effect[];
  lineageTransition: {
    predecessorClaimId: string;
    predecessorStateVectorSha256: string;
    predecessorDeleteSetSha256: string;
    artifactPreimageSha256: string;
    successor: {
      lineageClaimId: string;
      epochTag: string;
      contentKind: string;
      resultSha256: string;
      updateBlobSha256: string;
      stateVectorBlobSha256: string;
    };
  };
};

const content = (text: string) => {
  const bytes = new Uint8Array(new TextEncoder().encode(text));
  return { content: bytes, sha256: sha256Hex(bytes) };
};

/** The bytes a single-note resolve names: its sides and its successor's update and state vector. */
export const RESOLVE_BLOBS = {
  current: content("note before the conflict"),
  incoming: content("note from the other computer"),
  result: content("merged note"),
  update: content("successor update"),
  stateVector: content("successor state vector"),
};

function side(
  objectId: string,
  latestMomentId: string,
  blob: { content: Uint8Array; sha256: string },
  updatedAtMs: number,
): Side {
  return {
    present: true,
    pathRef: 0,
    objectId,
    latestMomentId,
    contentKind: "text",
    blobSha256: blob.sha256,
    byteLength: blob.content.byteLength,
    updatedAtMs,
  };
}

/** The effect moments a resolve's effects stand for, as the relay checks them. */
export function resolveShadows(payload: NoteResolvePayload): Record<string, unknown>[] {
  const { current, result } = payload.transition;
  const context = payload.effectContext;
  return payload.effects.map((effect, index) => {
    const common = {
      conflictId: payload.conflictId,
      conflictEffectIndex: index,
      momentId: effect.momentId,
      versionId: payload.targetVersionId,
      recordedAtMs: context.recordedAtMs,
      metadata: context.metadata,
      authors: null,
      beforeMetadata: null,
    };
    const head = effect.kind === "delete" ? current : result;
    const path = payload.paths[head.pathRef]!;
    const before = effect.kind === "delete" || current.pathRef === result.pathRef ? current : null;
    const beforePath = before && payload.paths[before.pathRef]!;
    return {
      ...common,
      objectId: head.objectId,
      objectCreatedAtMs:
        effect.kind === "delete"
          ? context.currentObjectCreatedAtMs
          : context.resultObjectCreatedAtMs,
      path,
      operation: effect.kind,
      payloadBeforeBlobSha256: before?.blobSha256 ?? null,
      payloadBeforePath: beforePath,
      payloadAfterBlobSha256: head.blobSha256,
      payloadAfterPath: path,
      payloadBeforeContentKind: before?.contentKind ?? null,
      payloadBeforeByteLength: before?.byteLength ?? null,
      payloadAfterContentKind: head.contentKind,
      payloadAfterByteLength: head.byteLength,
      beforePresent: before ? "present" : "null",
      beforeObjectId: before?.objectId ?? null,
      beforeVersionId: before ? payload.targetVersionId : null,
      beforePath,
      beforeBlobSha256: before?.blobSha256 ?? null,
      beforeContentKind: before?.contentKind ?? null,
      beforeByteLength: before?.byteLength ?? null,
      beforeUpdatedAtMs: before?.updatedAtMs ?? null,
      beforeLatestMomentId: before?.latestMomentId ?? null,
    };
  });
}

/**
 * A merge of one note's two edits at its one path, with a rich-text
 * successor. `change` reshapes it before its effects are signed.
 */
export function noteResolve(
  input: { workspaceId: string; objectId: string; path: string; recordedAtMs: number },
  change: (payload: NoteResolvePayload) => void = () => {},
): NoteResolvePayload {
  const { workspaceId, objectId, path, recordedAtMs } = input;
  const payload: NoteResolvePayload = {
    formatVersion: 1,
    workspaceId,
    conflictId: "note-conflict",
    status: "resolved",
    chosenFrom: "merged",
    resolution: "applied-merged",
    targetVersionId: "main",
    sourceVersionId: "main",
    paths: [path],
    transition: {
      current: side(objectId, "moment-current", RESOLVE_BLOBS.current, 0),
      incoming: side(objectId, "moment-incoming", RESOLVE_BLOBS.incoming, 0),
      result: side(objectId, "moment-resolved", RESOLVE_BLOBS.result, recordedAtMs),
    },
    effectContext: {
      recordedAtMs,
      metadata: { origin: "sync", summary: null, correlationId: null },
      author: null,
      currentObjectCreatedAtMs: 0,
      resultObjectCreatedAtMs: 0,
    },
    effects: [{ kind: "write", momentId: "moment-resolved", payloadSha256: "" }],
    lineageTransition: {
      predecessorClaimId: "a".repeat(64),
      predecessorStateVectorSha256: "b".repeat(64),
      predecessorDeleteSetSha256: "c".repeat(64),
      artifactPreimageSha256: RESOLVE_BLOBS.current.sha256,
      successor: {
        lineageClaimId: RESOLVE_BLOBS.update.sha256,
        epochTag: "d".repeat(64),
        contentKind: "richdoc",
        resultSha256: RESOLVE_BLOBS.result.sha256,
        updateBlobSha256: RESOLVE_BLOBS.update.sha256,
        stateVectorBlobSha256: RESOLVE_BLOBS.stateVector.sha256,
      },
    },
  };
  change(payload);
  const shadows = resolveShadows(payload);
  payload.effects = payload.effects.map((effect, index) => ({
    ...effect,
    payloadSha256: sha256Hex(stableJsonStringify(shadows[index])),
  }));
  return payload;
}

/** Resolve shapes the hosted feed must keep withholding, each still a valid resolve. */
export const WITHHELD_RESOLVES: Array<[string, (payload: NoteResolvePayload) => void]> = [
  [
    "a second path",
    (payload) => {
      payload.paths.push("docs/b.md");
      payload.transition.incoming.pathRef = 1;
    },
  ],
  [
    "an incoming side from another object",
    (payload) => {
      payload.transition.incoming.objectId = "object-private";
    },
  ],
  [
    "another version",
    (payload) => {
      payload.targetVersionId = "fork";
    },
  ],
  [
    "a move, with a delete and a write",
    (payload) => {
      const { incoming, result } = payload.transition;
      payload.paths.push("docs/moved.md");
      payload.chosenFrom = "incoming";
      payload.resolution = "applied-incoming";
      incoming.pathRef = 1;
      payload.transition.result = {
        ...incoming,
        latestMomentId: result.latestMomentId,
        updatedAtMs: result.updatedAtMs,
      };
      payload.lineageTransition.successor.resultSha256 = incoming.blobSha256;
      payload.effects = [
        { kind: "delete", momentId: "moment-moved-away", payloadSha256: "" },
        { kind: "write", momentId: result.latestMomentId, payloadSha256: "" },
      ];
    },
  ],
  [
    "a plain-text successor",
    (payload) => {
      payload.lineageTransition.successor.contentKind = "plaintext";
    },
  ],
];
