import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { LiveDocumentKind } from "@dohc/workspace-contracts/live-documents";
import {
  declareSceneRoots,
  exportPortableScene,
  stableJson,
} from "@dohc/excalidraw-scene";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { bridge } from "../bridge";
import { documentKey, documentVersionKey } from "../documentVersionKey";
import {
  binaryFileDataFromArtifact,
  sameArtifactAssetDescriptor,
} from "../excalidrawAssets";
import {
  captureOrphanedDraft,
  replaceOrphanedDraft,
} from "../orphanedDrafts";
import {
  bindEngineYDoc,
  EngineYDocDeliveryRefusedError,
  type EngineRemovalInProgress,
  type EngineYDocBinding,
  type EngineYDocTransport,
} from "./engineYDocProvider";
import {
  durableMarkdownFromSnapshot,
  loadProjectionModule,
  markdownFromSnapshot,
} from "./recoverySnapshot";

export type { EngineRemovalInProgress };

function sceneFromSnapshot(snapshot: Uint8Array): string {
  const rebuilt = new Y.Doc();
  declareSceneRoots(rebuilt);
  Y.applyUpdate(rebuilt, snapshot);
  return exportPortableScene(rebuilt);
}

type SceneRecoveryWork = {
  immediateText: string;
  requiredAssetCount: number;
  completed: Promise<{ text: string; missingAssetCount: number }>;
};

type ArtifactAssetRead = Awaited<
  ReturnType<EngineYDocBinding["readArtifactAsset"]>
>;

function portableSceneRecovery(
  snapshot: Uint8Array,
  files: Readonly<Record<string, BinaryFileData>>,
): { text: string; requiredAssetIds: readonly string[] } {
  const scene = JSON.parse(sceneFromSnapshot(snapshot)) as {
    elements: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  const requiredAssetIds = new Set<string>();
  for (const element of scene.elements) {
    if (element.type === "image" && typeof element.fileId === "string") {
      requiredAssetIds.add(element.fileId);
    }
  }
  const available = new Set(Object.keys(files));
  const elements = scene.elements.map((element) =>
    element.type === "image" &&
    typeof element.fileId === "string" &&
    !available.has(element.fileId)
      ? { ...element, fileId: null }
      : element,
  );
  return {
    text: stableJson({ ...scene, elements, files }),
    requiredAssetIds: [...requiredAssetIds],
  };
}

function recoveryTextFromSnapshot(
  kind: LiveDocumentKind,
  snapshot: Uint8Array,
): Promise<string> {
  return kind === "scene"
    ? Promise.resolve(sceneFromSnapshot(snapshot))
    : markdownFromSnapshot(snapshot);
}

// The immediate fallback the recovery boundary persists BEFORE the
// projection module is even guaranteed to load. A scene exports losslessly
// without the module; a rich document embeds its canonical snapshot in an
// inert comment (durableMarkdownFromSnapshot) so a crash before the faithful
// projection cannot lose structure.
function crudeRecoveryText(
  kind: LiveDocumentKind,
  doc: Y.Doc,
  snapshot: Uint8Array,
): string {
  return kind === "scene"
    ? exportPortableScene(doc)
    : durableMarkdownFromSnapshot(doc, snapshot);
}

function snapshotsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// The engine Y.Doc editor hook for live files. Given a workspace, path, and
// format kind, it opens a live engine Y.Doc session in main over IPC and binds
// a mirror Y.Doc to the format editor. Solo editing runs through the engine; a
// co-editor's edit arrives as a forwarded remote delta on the same channel.
//
// available:false AND opening:false => the doc is NOT engine-backed (unflagged
// workspace, secret path, or already live) — the caller stays on the plain
// local autosave editor showing the real on-disk content. While opening:true
// the answer is not known yet and the caller must stay read-only. The other
// exception is `notInVersion`, where the answer IS known and the caller must
// stop editing rather than fall back (#534). Each editor owns undo: rich
// documents use their collaboration history, while drawings use Excalidraw's
// native history and publish the resulting higher element revision.
//
// Duplicate views of one document share ONE session: leases are keyed by the
// workspace, path, and active-version token, so two panes showing the same
// file bind the same mirror Y.Doc, share its save state, and recover together.
//
// Renderer async-state invariant (product invariant): every open response is
// guarded by its request key and the session's disposed flag. A slow open for
// workspace/path A can never bind or repaint after the user has switched to B
// — the stale response is dropped and its session closed.

// "error" = a settle FAILED, so the file on disk is behind what the editor
// shows. "file-locked" = the same stale disk, but transient by contract:
// another program holds the file's handle and the engine retries until it
// releases (#554), so the copy names the blocker instead of advising an edit.
// "read-only" = the workspace is a read-only shared view and the edit
// was discarded outright; retrying cannot help, so it gets its own copy.
// "changed-on-disk" = the file was edited outside dohc while this document was
// open, and dohc kept that edit instead of overwriting it (#338).
// None is ever inferred — main pushes all of them from real outcomes.
export type EngineDocSaveState =
  | "saved"
  | "saving"
  | "error"
  | "file-locked"
  | "read-only"
  | "changed-on-disk"
  | "deleted";

export type UseEngineDoc = {
  // True once the engine session is open and the mirror doc is bound. false =>
  // fall back to the local autosave editor, but ONLY once `opening` is false.
  available: boolean;
  // No open has answered for the CURRENT request yet (#533). "Opening" and
  // "not engine-backed" used to be the same `available: false`, so the caller
  // showed its writable plain editor — whose autosave writes straight to disk
  // — for the whole wait. On a workspace whose capture chain is busy (startup
  // reconciliation, a version switch) that wait is seconds, and every keystroke
  // in it took a path the about-to-bind session never sees: the session then
  // seeds from a head without them. True on the first render of an open AND on
  // the first render after the request changes under a bound document (a
  // version switch), because both are the same unanswered question.
  // The caller must offer no writable surface while this is true.
  opening: boolean;
  // The mirror Y.Doc the editor binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // Exact engine identity for this bound document. Presence must not use the
  // path because a rename does not create a new document.
  objectId: string | null;
  versionId: string | null;
  // The document's REAL save state. "saving" the moment an edit is made,
  // "saved" ONLY when main reports a settle that covered that edit actually
  // committed and wrote the .md, "error" when a settle failed. This used to be
  // a 1s timer that flipped to "saved" regardless of what the engine did —
  // three dogfood journeys watched a doc read "Saved" over a zero-byte file.
  saveState: EngineDocSaveState;
  // A known terminal save failure. The save-state chip uses this instead of
  // its generic error text so it can name the constraint and measured bytes.
  saveError: string | null;
  // The path is not in the version this workspace is on: a version switch
  // removed it while this open was queued behind that switch (#534). Unlike
  // every other available:false the caller must NOT fall back to the writable
  // plain editor, whose autosave would write the file back into the version the
  // user just entered.
  notInVersion: boolean;
  // The open did not land and a session for this document may still be the
  // engine's (#564, #657). Same no-downgrade rule as notInVersion: the caller
  // stays read-only, states the reason, and offers a retry (bump retryKey),
  // which is also what discharges what the failure left behind.
  engineMayHoldDocument: boolean;
  // The canonical drawing's image records conflict with authoritative
  // storage. Retrying cannot repair this state.
  artifactAssetsInvalid: boolean;
  // Main confirmed that it removed this file while the live session was
  // bound. The current document is retained for recovery only.
  deletedWhileEditing: boolean;
  // The recovery row created for this deletion, if it still exists.
  deletedDraftId: number | null;
  // Image recovery for a drawing retained after deletion or a read-only
  // transition, or after a permanent local-update refusal. While loading, the
  // immediate draft has null file references.
  recoveryAssets:
    | { state: "loading"; count: number }
    | { state: "missing"; count: number }
    | null;
  // A local update exceeded the permanent transport limit, or main refused a
  // delivery outright. The rejected document is retained for recovery only.
  permanentFailureWhileEditing: boolean;
  // Main refused a live edit because this workspace became read-only after
  // the session opened. The rejected document is retained for recovery only.
  readOnlyWhileEditing: boolean;
  // An open lost to a delete or move interval. This is not a terminal outcome:
  // the operation can still fail, so the caller stays read-only and retries.
  removalInProgress: EngineRemovalInProgress | null;
  artifactAssets: readonly ArtifactAssetDescriptor[];
  readArtifactAsset(descriptor: ArtifactAssetDescriptor): Promise<{
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  }>;
};

// What ONE open answers: a workspace, a path, the gate, and the active-version
// token. Everything this hook returns belongs to exactly one of these. JSON
// quotes each part, so two different requests cannot produce one key.
function engineDocRequestKey(input: {
  workspaceId: string;
  path: string;
  enabled: boolean;
  kind?: LiveDocumentKind;
  reopenKey?: number;
  retryKey?: number;
}): string {
  return JSON.stringify([
    input.enabled,
    input.kind ?? "richdoc",
    input.workspaceId,
    input.path,
    input.reopenKey ?? null,
    input.retryKey ?? null,
  ]);
}

// The settled result of one open.
type EngineDocOpenOutcome =
  | {
      token: number;
      kind: "bound";
      doc: Y.Doc;
      objectId: string | null;
      versionId: string | null;
      artifactAssets: readonly ArtifactAssetDescriptor[];
      readArtifactAsset: EngineYDocBinding["readArtifactAsset"];
    }
  | { kind: "unavailable" }
  // Their OWN kinds, not flags on "unavailable": every other unavailable
  // answer means "fall back to the plain editor", and these two mean the
  // opposite (#534, #564). Collapsing them would put the branches back
  // behind one flag.
  | { kind: "not-in-version" }
  | { kind: "engine-may-hold-document" }
  | { kind: "artifact-assets-invalid" }
  | { kind: "removal-in-progress"; removal: EngineRemovalInProgress };

let engineDocSessionCounter = 0;
function nextSessionId(): string {
  engineDocSessionCounter += 1;
  // Bounded (< 64 chars) + unique per open, like the search searchId.
  return `eyd-${Date.now().toString(36)}-${engineDocSessionCounter.toString(36)}`;
}

function makeTransport(
  workspaceId: string,
  path: string,
  sessionId: string,
  // Monotonic local-edit counter, shared with the save-state listener: main
  // echoes back the seq each settle STARTED at, and only a settle that covers
  // the newest edit may be reported as "Saved".
  localSeq: { current: number },
  writesRefused: { current: boolean },
  kind: LiveDocumentKind,
): EngineYDocTransport {
  let lineageGeneration = 1;
  return {
    ...(kind === "scene" ? { initializeDoc: declareSceneRoots } : {}),
    async open() {
      const result = await bridge().openEngineYDocSession({
        workspaceId,
        path,
        sessionId,
      });
      if (result.available && result.lineageGeneration !== undefined) {
        lineageGeneration = result.lineageGeneration;
      }
      return {
        available: result.available,
        ...(result.initialUpdate ? { initialUpdate: result.initialUpdate } : {}),
        ...(result.objectId ? { objectId: result.objectId } : {}),
        ...(result.versionId ? { versionId: result.versionId } : {}),
        ...(result.artifactAssets
          ? { artifactAssets: result.artifactAssets }
          : {}),
        ...(result.available && result.lineageGeneration !== undefined
          ? { lineageGeneration: result.lineageGeneration }
          : {}),
        ...(result.notInVersion ? { notInVersion: true } : {}),
        ...(result.engineMayHoldDocument ? { engineMayHoldDocument: true } : {}),
        ...(result.artifactAssetsInvalid ? { artifactAssetsInvalid: true } : {}),
        ...(result.removalInProgress
          ? { removalInProgress: result.removalInProgress }
          : {}),
      };
    },
    readArtifactAsset(descriptor) {
      return bridge().readEngineYDocArtifactAsset({ sessionId, descriptor });
    },
    stageLocalUpdate() {
      if (writesRefused.current) return null;
      localSeq.current += 1;
      return localSeq.current;
    },
    async applyLocalUpdate(update, seq, updateGeneration) {
      if (writesRefused.current) return;
      // The provider owns ordered retry. Rejecting here keeps this batch at
      // the head of that queue; resolving is the acknowledgement that main
      // accepted it. The staged seq is reused on retry, never rolled back.
      // Main returns refusals as data; they surface as the one permanent
      // delivery error so the provider preserves the mirror instead of
      // retrying forever.
      const result = await bridge().applyEngineYDocUpdate({
        sessionId,
        update,
        seq,
        lineageGeneration: updateGeneration,
      });
      if (!result.accepted) {
        throw new EngineYDocDeliveryRefusedError(result.reason);
      }
    },
    onRemoteUpdate(listener) {
      return bridge().onEngineYDocRemoteUpdate((event) => {
        if (event.sessionId !== sessionId) return;
        listener(event.update, event.lineageGeneration);
      });
    },
    onLineageReplacement(listener) {
      return bridge().onEngineYDocLineageReplacement((event) => {
        if (event.sessionId !== sessionId) return;
        if (event.lineageGeneration <= lineageGeneration) return;
        void listener({
          update: event.update,
          recoveredPaths: event.recoveredPaths,
          artifactAssets: event.artifactAssets,
          lineageGeneration: event.lineageGeneration,
        });
      });
    },
    async acknowledgeLineageReplacement(nextLineageGeneration) {
      const result = await bridge().acknowledgeEngineYDocLineageReplacement({
        sessionId,
        lineageGeneration: nextLineageGeneration,
      });
      lineageGeneration = nextLineageGeneration;
      return result.updates;
    },
    async close() {
      await bridge().closeEngineYDocSession({ sessionId }).catch(() => undefined);
    },
  };
}

type EngineDocInput = {
  workspaceId: string;
  path: string;
  // The caller gates which supported live files open an engine session.
  // Read-only shared views stay local. A scene can open even when the bounded
  // renderer text read is truncated because the engine owns the full scene.
  enabled: boolean;
  // Defaults to richdoc for existing direct hook callers. Product callers pass
  // the classifier result explicitly.
  kind?: LiveDocumentKind;
  // Bump to retry after engineMayHoldDocument (#564): a retry replaces the
  // lease's session behind every subscriber, with the same stale-response
  // guard as any other open.
  retryKey?: number;
  // G2-C-3 version-switch re-bind: a monotonic token that changes whenever the
  // active version of this workspace changes while the same file stays open.
  reopenKey?: number;
};

type EngineDocLeaseSnapshot = {
  key: string;
  outcome: EngineDocOpenOutcome | null;
  saveState: EngineDocSaveState;
  saveError: string | null;
  deletion: { token: number; draftId: number | null } | null;
  readOnlyTransition: { token: number } | null;
  permanentFailure: { token: number } | null;
  sceneRecoveryAssets: {
    token: number;
    state: "loading" | "missing";
    count: number;
  } | null;
};

type EngineDocSession = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => EngineDocLeaseSnapshot;
  start: () => void;
  dispose: () => Promise<void>;
  whenClosed: () => Promise<void>;
};

type EngineDocLease = Omit<EngineDocSession, "start"> & {
  documentKey: string;
  startAfter: (barrier: Promise<void> | undefined) => void;
  retain: () => void;
  release: () => void;
  disposeIfReleased: () => void;
  reopenForRetry: (input: EngineDocInput, requestKey: string) => void;
};

const engineDocLeases = new Map<string, EngineDocLease>();
const engineDocDisposalBarriers = new Map<string, Promise<void>>();
let engineDocLeaseCounter = 0;

function emptyLeaseSnapshot(requestKey: string): EngineDocLeaseSnapshot {
  return {
    key: requestKey,
    outcome: null,
    saveState: "saved",
    saveError: null,
    deletion: null,
    readOnlyTransition: null,
    permanentFailure: null,
    sceneRecoveryAssets: null,
  };
}

async function settleEngineDocCleanup(
  cleanup: Promise<void> | undefined,
): Promise<void> {
  if (!cleanup) return;
  try {
    await cleanup;
  } catch (error: unknown) {
    console.error(
      "[desktop] could not fully clean up a live document session:",
      error,
    );
  }
}

function trackEngineDocDisposal(lease: EngineDocLease): Promise<void> {
  void lease.dispose();
  const disposal = lease.whenClosed();
  const previous = engineDocDisposalBarriers.get(lease.documentKey);
  const barrier = previous
    ? Promise.all([previous, disposal]).then(() => undefined)
    : disposal;
  engineDocDisposalBarriers.set(lease.documentKey, barrier);
  void barrier.then(() => {
    if (engineDocDisposalBarriers.get(lease.documentKey) === barrier) {
      engineDocDisposalBarriers.delete(lease.documentKey);
    }
  });
  return barrier;
}

function createEngineDocSession(
  input: EngineDocInput,
  requestKey: string,
): EngineDocSession {
  const { workspaceId, path } = input;
  const documentKind = input.kind ?? "richdoc";
  const token = ++engineDocLeaseCounter;
  const sessionId = nextSessionId();
  const listeners = new Set<() => void>();
  const saveStateRef = { current: "saved" as EngineDocSaveState };
  const writesRefused = { current: false };
  const localSeq = { current: 0 };
  const transport = makeTransport(
    workspaceId,
    path,
    sessionId,
    localSeq,
    writesRefused,
    documentKind,
  );

  let snapshot = emptyLeaseSnapshot(requestKey);
  let started = false;
  let disposed = false;
  let binding: EngineYDocBinding | null = null;
  let retiredBinding: EngineYDocBinding | null = null;
  let bindingDestroyed = false;
  let detachSaveObserver: (() => void) | null = null;
  let unsubscribeSaveState: (() => void) | null = null;
  let deletionPending = false;
  let deliveryPending = false;
  let pendingSavedSeq: number | null = null;
  const retiredDraftObservers = new Map<Y.Doc, () => void>();
  let lifecycle: Promise<void> = Promise.resolve();
  let disposePromise: Promise<void> | null = null;
  let closeBarrierPromise: Promise<void> | null = null;

  // The last recovery snapshot (for change dedup) and the draft it produced.
  // Terminal deletion, read-only transitions, and permanently refused local
  // updates share this path because the mirror holds the user's latest work.
  type RecoverySlot = {
    snapshotBytes: Uint8Array | null;
    draftId: number | null;
    transition: "deletion" | "read-only" | "permanent-failure" | null;
    revision: number;
  };
  const newRecoverySlot = (): RecoverySlot => ({
    snapshotBytes: null,
    draftId: null,
    transition: null,
    revision: 0,
  });
  let recovery = newRecoverySlot();
  // Serializes recovery snapshots in the order they were taken: a later
  // snapshot's capture must never be overwritten by an earlier one that
  // resolves late (the projection import, and each markdown conversion,
  // are async now).
  let recoveryQueue: Promise<void> = Promise.resolve();
  let recoveryStatusRevision = 0;
  let releaseStarted = false;
  const recoveryAssetReads = new Map<
    string,
    Promise<ArtifactAssetRead | null>
  >();

  const publish = (
    update: (current: EngineDocLeaseSnapshot) => EngineDocLeaseSnapshot,
  ): void => {
    if (disposed) return;
    snapshot = update(snapshot);
    for (const listener of listeners) listener();
  };

  const setOutcome = (outcome: EngineDocOpenOutcome | null): void => {
    publish((current) => ({ ...current, outcome }));
  };

  const reportSaveState = (
    state: EngineDocSaveState,
    error: string | null = null,
  ): void => {
    saveStateRef.current = state;
    publish((current) => ({ ...current, saveState: state, saveError: error }));
  };

  const onDeliveryPendingChange = (pending: boolean): void => {
    deliveryPending = pending;
    if (pending) {
      pendingSavedSeq = null;
      return;
    }
    if (
      pendingSavedSeq !== null &&
      !disposed &&
      !writesRefused.current &&
      pendingSavedSeq >= localSeq.current
    ) {
      reportSaveState("saved");
    }
    pendingSavedSeq = null;
  };

  const sceneAssetCacheKey = (
    descriptor: EngineYDocBinding["artifactAssets"][number],
  ): string =>
    JSON.stringify([
      descriptor.id,
      descriptor.mimeType,
      descriptor.created,
      descriptor.ref,
      descriptor.sha256,
      descriptor.lastRetrieved ?? null,
      descriptor.version ?? null,
    ]);

  const readSceneAsset = (
    cacheKey: string,
    descriptor: EngineYDocBinding["artifactAssets"][number],
    bound: EngineYDocBinding,
  ): Promise<ArtifactAssetRead | null> => {
    const cached = recoveryAssetReads.get(cacheKey);
    if (cached) return cached;
    const read: Promise<ArtifactAssetRead | null> = bound
      .readArtifactAsset(descriptor)
      .then((loaded) =>
        binaryFileDataFromArtifact(descriptor, loaded) ? loaded : null,
      );
    void read.catch(() => {
      // A transient read failure must not poison later recovery. Keep
      // successful bytes cached, but let deletion/replacement retry a
      // descriptor whose eager prewarm failed.
      if (recoveryAssetReads.get(cacheKey) === read) {
        recoveryAssetReads.delete(cacheKey);
      }
    });
    recoveryAssetReads.set(cacheKey, read);
    return read;
  };

  const cacheSceneAssetRead = (
    descriptor: EngineYDocBinding["artifactAssets"][number],
    bound: EngineYDocBinding,
  ): void => {
    void readSceneAsset(
      sceneAssetCacheKey(descriptor),
      descriptor,
      bound,
    ).catch(() => undefined);
  };

  const prepareSceneRecovery = (
    bytes: Uint8Array,
    bound: EngineYDocBinding | null,
  ): SceneRecoveryWork => {
    const initial = portableSceneRecovery(bytes, {});
    const descriptors = new Map(
      (bound?.artifactAssets ?? []).map((descriptor) => [
        descriptor.id,
        descriptor,
      ]),
    );
    const reads = initial.requiredAssetIds.map((assetId) => {
      const descriptor = descriptors.get(assetId);
      const cacheKey = descriptor
        ? sceneAssetCacheKey(descriptor)
        : JSON.stringify([assetId, null]);
      const read = descriptor && bound
        ? readSceneAsset(cacheKey, descriptor, bound)
            .catch(() => readSceneAsset(cacheKey, descriptor, bound))
            .then((loaded) =>
              loaded
                ? binaryFileDataFromArtifact(descriptor, loaded)
                : null,
            )
            .catch(() => null)
        : Promise.resolve(null);
      return read.then((file) => [assetId, file] as const);
    });
    return {
      immediateText: initial.text,
      requiredAssetCount: initial.requiredAssetIds.length,
      completed: Promise.all(reads).then((results) => {
        const files: Record<string, BinaryFileData> = {};
        let missingAssetCount = 0;
        for (const [assetId, file] of results) {
          if (file) files[assetId] = file;
          else missingAssetCount += 1;
        }
        return {
          text: portableSceneRecovery(bytes, files).text,
          missingAssetCount,
        };
      }),
    };
  };

  const setSceneRecoveryAssets = (
    value: EngineDocLeaseSnapshot["sceneRecoveryAssets"],
  ): void => {
    publish((current) => ({ ...current, sceneRecoveryAssets: value }));
  };

  // `forceCreate` false means: nothing was unsettled at the moment this
  // snapshot was taken (the dominant delete path, settled before removal)
  // — no draft is worth creating for it. A later snapshot always forces
  // creation: it only runs because the doc changed since the last one.
  const enqueueRecoverySnapshot = (
    bytes: Uint8Array,
    forceCreate: boolean,
    transition: "deletion" | "read-only" | "permanent-failure" | null,
    sceneRecovery: SceneRecoveryWork | null = null,
  ): void => {
    const slot = recovery;
    const revision = ++slot.revision;
    const statusRevision = transition && sceneRecovery
      ? ++recoveryStatusRevision
      : null;
    if (transition && sceneRecovery) {
      setSceneRecoveryAssets(
        sceneRecovery.requiredAssetCount === 0
          ? null
          : {
              token,
              state: "loading",
              count: sceneRecovery.requiredAssetCount,
            },
      );
    }
    recoveryQueue = recoveryQueue
      .then(async () => {
        // Every refinement projects the NEWEST snapshot its slot holds, so an
        // older capture that resolves late can never roll the durable row
        // back to text the user has already moved past — that row is the
        // only copy of the newer edit.
        const newest = slot.snapshotBytes ?? bytes;
        const text =
          sceneRecovery?.immediateText ??
          (await recoveryTextFromSnapshot(documentKind, newest));
        if (slot.snapshotBytes !== null && slot.snapshotBytes !== newest) {
          // A newer snapshot was captured while this one projected. Its own
          // refinement owns the row; applying this result would roll the
          // durable text back past an edit that exists nowhere else.
          return;
        }
        if (slot.draftId === null) {
          if (!forceCreate) return;
          slot.draftId = captureOrphanedDraft(workspaceId, path, text);
        } else {
          replaceOrphanedDraft(workspaceId, path, slot.draftId, text);
        }
        // Only the published render state dies with the session — the draft
        // itself is already durable in the module-level store, unmount or not.
        if (transition === "deletion" && slot === recovery) {
          publish((current) => ({
            ...current,
            deletion: { token, draftId: slot.draftId },
          }));
        }
        if (!sceneRecovery) return;
        // Asset I/O must not hold the recovery queue. A later scene update
        // must replace the immediate draft now, even if this older image
        // read is slow. Only the newest snapshot may apply its async result.
        void sceneRecovery.completed.then((recovered) => {
          if (revision !== slot.revision || slot.draftId === null) {
            return;
          }
          replaceOrphanedDraft(
            workspaceId,
            path,
            slot.draftId,
            recovered.text,
          );
          if (transition && statusRevision === recoveryStatusRevision) {
            setSceneRecoveryAssets(
              recovered.missingAssetCount === 0
                ? null
                : {
                    token,
                    state: "missing",
                    count: recovered.missingAssetCount,
                  },
            );
          }
        });
      })
      .catch((error: unknown) => {
        // This draft is the last copy of the user's text — a load failure
        // here must not disappear silently. When a crude draft already made
        // the text durable, only the faithful refinement was lost.
        console.error(
          transition === "deletion" || slot.draftId === null
            ? `[desktop] could not write a recovery draft for ${workspaceId}:${path}:`
            : `[desktop] could not refine the recovery draft for ${workspaceId}:${path}:`,
          error,
        );
      });
  };

  const captureDeletion = (doc: Y.Doc): void => {
    writesRefused.current = true;
    // The PATH is gone whichever lineage wins: deletion outlives any later
    // replacement, and a fresh recovery slot re-captures on its first edit.
    deletionPending = true;
    recovery.transition = "deletion";
    // Snapshot NOW, synchronously: the doc can be destroyed (unmount) or
    // the caller's reference can go stale before a lazily-loaded
    // serializer would otherwise get to read it.
    const bytes = Y.encodeStateAsUpdate(doc);
    recovery.snapshotBytes = bytes;
    const forceCreate = saveStateRef.current !== "saved";
    const sceneRecovery =
      forceCreate && documentKind === "scene" && binding
        ? prepareSceneRecovery(bytes, binding)
        : null;
    if (forceCreate) {
      // Persisted NOW, before the projection module is even guaranteed to
      // load: a renderer close/reload/crash while that import is still in
      // flight must not lose text that exists only in this queue's promise
      // closure, with the file already gone and no draft for the recovery
      // close guard to find. The queue below upgrades this row to the
      // faithful markdown a microtask later; it never creates a second one.
      recovery.draftId = captureOrphanedDraft(
        workspaceId,
        path,
        sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc, bytes),
      );
    }
    publish((current) => ({
      ...current,
      deletion: { token, draftId: recovery.draftId },
    }));
    reportSaveState("deleted");
    enqueueRecoverySnapshot(
      bytes,
      forceCreate,
      recovery.transition,
      sceneRecovery,
    );
  };

  const captureReadOnlyTransition = (doc: Y.Doc): void => {
    writesRefused.current = true;
    recovery.transition = "read-only";
    const bytes = Y.encodeStateAsUpdate(doc);
    recovery.snapshotBytes = bytes;
    const sceneRecovery =
      documentKind === "scene" && binding
        ? prepareSceneRecovery(bytes, binding)
        : null;
    // Main sends this state only after it has discarded a local update.
    // Persist the rejected document synchronously before the session closes.
    recovery.draftId = captureOrphanedDraft(
      workspaceId,
      path,
      sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc, bytes),
    );
    publish((current) => ({
      ...current,
      readOnlyTransition: { token },
    }));
    reportSaveState("read-only");
    enqueueRecoverySnapshot(bytes, true, recovery.transition, sceneRecovery);
  };

  const refreshRecoveryDraft = (doc: Y.Doc): void => {
    if (recovery.snapshotBytes === null) return;
    const bytes = Y.encodeStateAsUpdate(doc);
    if (snapshotsEqual(bytes, recovery.snapshotBytes)) return;
    recovery.snapshotBytes = bytes;
    const sceneRecovery =
      documentKind === "scene" && binding
        ? prepareSceneRecovery(bytes, binding)
        : null;
    if (recovery.draftId !== null) {
      // The newest text is durable IMMEDIATELY — the faithful projection
      // refines this row later, and a crash before it cannot lose the edit.
      replaceOrphanedDraft(
        workspaceId,
        path,
        recovery.draftId,
        sceneRecovery?.immediateText ??
          crudeRecoveryText(documentKind, doc, bytes),
      );
    }
    enqueueRecoverySnapshot(
      bytes,
      true,
      recovery.transition,
      sceneRecovery,
    );
  };

  const capturePermanentFailure = (error: Error, doc: Y.Doc): void => {
    writesRefused.current = true;
    recovery.transition = "permanent-failure";
    const bytes = Y.encodeStateAsUpdate(doc);
    recovery.snapshotBytes = bytes;
    const sceneRecovery =
      documentKind === "scene" && binding
        ? prepareSceneRecovery(bytes, binding)
        : null;
    recovery.draftId = captureOrphanedDraft(
      workspaceId,
      path,
      sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc, bytes),
    );
    if (!disposed) {
      publish((current) => ({
        ...current,
        permanentFailure: { token },
      }));
      reportSaveState("error", error.message);
    }
    enqueueRecoverySnapshot(bytes, true, recovery.transition, sceneRecovery);
  };

  const releaseBinding = (): void => {
    if (!binding || releaseStarted) return;
    releaseStarted = true;
    // The rejected apply is an acknowledged no-op. destroy() drains that
    // acknowledgement, refuses queued follow-ups through writesRefused, and
    // then closes the main session instead of leaving it alive to retry.
    void destroyBinding();
  };

  // The provider's one failure hook: an oversized update, or a refusal main
  // returned as data. Routed to the capture that owns the user-facing state.
  const captureDeliveryFailure = (
    _snapshot: Uint8Array,
    error: unknown,
    source: Y.Doc,
  ): void => {
    if (
      error instanceof EngineYDocDeliveryRefusedError &&
      error.reason === "lineage-transition"
    ) {
      // The replacement protocol preserves the retired mirror itself
      // (onDocumentReplacing persists it before main installs the winner).
      return;
    }
    if (recovery.snapshotBytes !== null) {
      refreshRecoveryDraft(source);
      return;
    }
    if (
      error instanceof EngineYDocDeliveryRefusedError &&
      error.reason === "read-only"
    ) {
      captureReadOnlyTransition(source);
      releaseBinding();
      return;
    }
    if (
      error instanceof EngineYDocDeliveryRefusedError &&
      error.reason === "deleted"
    ) {
      captureDeletion(source);
      return;
    }
    capturePermanentFailure(
      error instanceof Error ? error : new Error(String(error)),
      source,
    );
  };

  const captureLineageReplacementFailure = (
    error: unknown,
    retired: Y.Doc,
  ): void => {
    writesRefused.current = true;
    if (disposed) return;
    publish((current) => ({
      ...current,
      readOnlyTransition: { token },
    }));
    const bound = retiredBinding ?? binding;
    if (bound) {
      setOutcome({
        token,
        kind: "bound",
        doc: retired,
        objectId: bound.objectId,
        versionId: bound.versionId,
        artifactAssets: [...bound.artifactAssets],
        readArtifactAsset: (descriptor) => bound.readArtifactAsset(descriptor),
      });
    }
    reportSaveState(
      "error",
      error instanceof Error
        ? `dohc could not finish replacing this document: ${error.message}`
        : "dohc could not finish replacing this document.",
    );
  };

  const onSaveState = (event: EngineYDocSaveStateEvent): void => {
    if (disposed || event.sessionId !== sessionId) return;
    if (event.state === "deleted") {
      pendingSavedSeq = null;
      const doc = binding?.doc;
      if (!doc) {
        deletionPending = true;
        writesRefused.current = true;
        return;
      }
      if (recovery.snapshotBytes !== null) {
        deletionPending = true;
        recovery.transition = "deletion";
        publish((current) => ({
          ...current,
          deletion: { token, draftId: recovery.draftId },
        }));
        reportSaveState("deleted");
        refreshRecoveryDraft(doc);
        return;
      }
      captureDeletion(doc);
      return;
    }
    // Deletion is terminal for this session. A settle/update already in
    // flight can report after main's deletion notice, but it no longer
    // describes a path that exists and must not repaint this state.
    if (writesRefused.current) return;
    if (event.state === "read-only") {
      pendingSavedSeq = null;
      const doc = binding?.doc;
      // Unlike deletion, this report answers a local update, so it cannot
      // precede the binding that allowed that update.
      if (!doc) return;
      captureReadOnlyTransition(doc);
      releaseBinding();
      return;
    }
    if (event.state === "saved") {
      if (deliveryPending) {
        // Batches or unacknowledged deliveries are still outstanding — a
        // settle that raced ahead of them must not vouch for the mirror.
        pendingSavedSeq = Math.max(pendingSavedSeq ?? 0, event.seq);
        return;
      }
      if (event.seq >= localSeq.current) reportSaveState("saved");
      return;
    }
    pendingSavedSeq = null;
    if (event.state === "file-locked") {
      if (event.seq >= localSeq.current) reportSaveState(event.state);
      return;
    }
    if (event.state === "error" || event.state === "changed-on-disk") {
      reportSaveState(event.state);
      return;
    }
    if (event.state === "settling") {
      reportSaveState("saving");
      return;
    }
  };

  const observeSaveState = (doc: Y.Doc): void => {
    detachSaveObserver?.();
    const onUpdate = () => {
      if (disposed) return;
      if (writesRefused.current) {
        if (recovery.snapshotBytes === null && deletionPending) {
          // A replacement installed a fresh recovery slot while the path
          // stayed deleted. The first edit on the winner starts its own
          // draft instead of vanishing.
          captureDeletion(doc);
          return;
        }
        refreshRecoveryDraft(doc);
        return;
      }
      reportSaveState("saving");
    };
    doc.on("update", onUpdate);
    detachSaveObserver = () => doc.off("update", onUpdate);
  };

  const preserveRetiredDocument = (retired: Y.Doc): void => {
    writesRefused.current = true;
    const retiredRecoverySlot = recovery;
    // A deletion (or other capture) already owns a draft for this mirror —
    // the retired preserve refines that row instead of adding a sibling.
    let draftId: number | null = retiredRecoverySlot.draftId;
    let retiredRecoveryRevision = 0;
    let projectionQueue: Promise<void> = Promise.resolve();
    const activeBinding = binding;
    const retiredAssets = activeBinding
      ? [...activeBinding.artifactAssets]
      : [];
    const retiredAuthority: EngineYDocBinding | null = activeBinding
      ? {
          ...activeBinding,
          artifactAssets: retiredAssets,
          readArtifactAsset: async (descriptor) => {
            const retained = retiredAssets.find((candidate) =>
              sameArtifactAssetDescriptor(candidate, descriptor),
            );
            if (!retained) {
              throw new Error(
                `Artifact asset ${descriptor.id} does not belong to the retired document.`,
              );
            }
            const loaded = await readSceneAsset(
              sceneAssetCacheKey(retained),
              retained,
              activeBinding,
            );
            if (!loaded) {
              throw new Error(
                `Artifact asset ${descriptor.id} is invalid for the retired document.`,
              );
            }
            return loaded;
          },
        }
      : null;
    retiredBinding = retiredAuthority;
    if (documentKind === "scene" && activeBinding) {
      for (const descriptor of retiredAssets) {
        cacheSceneAssetRead(descriptor, activeBinding);
      }
    }
    const persist = (): void => {
      const bytes = Y.encodeStateAsUpdate(retired);
      if (documentKind === "scene") {
        const publishesRecoveryStatus = retiredRecoverySlot === recovery;
        const revision = ++retiredRecoveryRevision;
        const statusRevision = ++recoveryStatusRevision;
        const sceneRecovery = prepareSceneRecovery(bytes, retiredAuthority);
        if (draftId === null) {
          draftId = captureOrphanedDraft(
            workspaceId,
            path,
            sceneRecovery.immediateText,
          );
        } else {
          replaceOrphanedDraft(
            workspaceId,
            path,
            draftId,
            sceneRecovery.immediateText,
          );
        }
        if (publishesRecoveryStatus) {
          setSceneRecoveryAssets(
            sceneRecovery.requiredAssetCount === 0
              ? null
              : {
                  token,
                  state: "loading",
                  count: sceneRecovery.requiredAssetCount,
                },
          );
        }
        const capturedDraftId = draftId;
        void sceneRecovery.completed
          .then((recovered) => {
            if (revision !== retiredRecoveryRevision) return;
            replaceOrphanedDraft(
              workspaceId,
              path,
              capturedDraftId,
              recovered.text,
            );
            if (
              publishesRecoveryStatus &&
              statusRevision === recoveryStatusRevision
            ) {
              setSceneRecoveryAssets(
                recovered.missingAssetCount === 0
                  ? null
                  : {
                      token,
                      state: "missing",
                      count: recovered.missingAssetCount,
                    },
              );
            }
          })
          .catch((error: unknown) => {
            console.error(
              `[desktop] could not recover drawing assets for ${workspaceId}:${path} after lineage replacement:`,
              error,
            );
          });
        return;
      }
      const crude = durableMarkdownFromSnapshot(retired, bytes);
      if (draftId === null) {
        draftId = captureOrphanedDraft(workspaceId, path, crude);
      } else {
        replaceOrphanedDraft(workspaceId, path, draftId, crude);
      }
      const capturedDraftId = draftId;
      projectionQueue = projectionQueue
        .then(async () => {
          const markdown = await markdownFromSnapshot(bytes);
          replaceOrphanedDraft(
            workspaceId,
            path,
            capturedDraftId,
            markdown,
          );
        })
        .catch((error: unknown) => {
          console.error(
            `[desktop] could not refine the recovery draft for ${workspaceId}:${path} after lineage replacement:`,
            error,
          );
        });
    };
    // A dirty mirror may contain the update main refused when replacement
    // began. Persist it synchronously before acknowledging. If a transaction
    // already in the editor lands before React unmounts the retired doc, the
    // observer refreshes that same durable draft.
    if (saveStateRef.current !== "saved" || deliveryPending) persist();
    const onRetiredUpdate = () => persist();
    retired.on("update", onRetiredUpdate);
    retiredDraftObservers.set(retired, () => retired.off("update", onRetiredUpdate));
    setOutcome(null);
  };

  const destroyBinding = async (): Promise<void> => {
    if (!binding || bindingDestroyed) return;
    bindingDestroyed = true;
    await binding.destroy();
  };

  const session: EngineDocSession = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    start() {
      if (started) return;
      started = true;
      lifecycle = (async () => {
        if (disposed) return;

        try {
          // Main can publish deletion after registering the live session but
          // before open returns, so subscribe before opening the transport.
          unsubscribeSaveState = bridge().onEngineYDocSaveState(onSaveState);
          const bound = await bindEngineYDoc(transport, undefined, {
            onDeliveryFailure: captureDeliveryFailure,
            onDeliveryPendingChange,
            onDocumentReplacing: preserveRetiredDocument,
            onLineageReplacementFailure: captureLineageReplacementFailure,
          });
          binding = bound;
          if (disposed) {
            await destroyBinding();
            return;
          }

          // Preload, don't block: by the time any real deletion can arrive,
          // the module is very likely already resolved, so a draft's markdown
          // lands within the same microtask as its snapshot. The snapshot in
          // captureDeletion/refreshRecoveryDraft keeps a genuinely cold start
          // (import still in flight) correct regardless.
          if (documentKind === "richdoc") void loadProjectionModule();
          if (!bound.available || !bound.doc) {
            // Resolved: NOT engine-backed. The caller may offer the plain
            // local editor again — that is what `opening` was holding back.
            // EXCEPT when the path is not in this version, where offering it
            // would write the phantom the engine just refused (#534), and
            // when the engine may still hold the document, where a plain
            // autosave would race the session it still binds (#564, #657).
            if (bound.notInVersion) {
              setOutcome({ kind: "not-in-version" });
            } else if (bound.artifactAssetsInvalid) {
              setOutcome({ kind: "artifact-assets-invalid" });
            } else if (bound.engineMayHoldDocument) {
              setOutcome({ kind: "engine-may-hold-document" });
            } else if (bound.removalInProgress) {
              writesRefused.current = true;
              setOutcome({
                kind: "removal-in-progress",
                removal: bound.removalInProgress,
              });
            } else {
              setOutcome({ kind: "unavailable" });
            }
            return;
          }

          bound.onDocumentReplaced((replacement) => {
            if (disposed) return;
            // The losing slot owns its recovery draft and any pending image
            // reads. The winner starts a fresh slot so later delete/unmount
            // work cannot rewrite that draft with an independent lineage.
            recovery = newRecoverySlot();
            retiredBinding = null;
            // Deletion of the PATH outlives any lineage: the file is gone
            // whichever lineage wins, so only non-deletion refusals reset.
            if (!deletionPending) {
              writesRefused.current = false;
            }
            publish((current) => ({
              ...current,
              readOnlyTransition: null,
              permanentFailure: null,
              ...(deletionPending ? {} : { deletion: null }),
            }));
            if (!writesRefused.current && !deliveryPending) {
              reportSaveState("saved");
            }
            observeSaveState(replacement);
            setOutcome({
              token,
              kind: "bound",
              doc: replacement,
              objectId: bound.objectId,
              versionId: bound.versionId,
              artifactAssets: bound.artifactAssets,
              readArtifactAsset: (descriptor) =>
                bound.readArtifactAsset(descriptor),
            });
          });
          // An edit is unsaved the instant it happens. Only main's settle
          // report may clear it — nothing here guesses "saved". The seed apply
          // happened before this observer attached, so it never shows a
          // spurious "saving".
          const doc = bound.doc;
          observeSaveState(doc);
          if (deletionPending) captureDeletion(doc);
          setOutcome({
            token,
            kind: "bound",
            doc,
            objectId: bound.objectId,
            versionId: bound.versionId,
            artifactAssets: bound.artifactAssets,
            readArtifactAsset: (descriptor) =>
              bound.readArtifactAsset(descriptor),
          });
        } catch {
          if (!disposed) {
            setOutcome({ kind: "unavailable" });
          }
        }
      })();
    },
    dispose() {
      if (disposePromise) return disposePromise;

      // Belt-and-suspenders, not the sole catcher: the save observer already
      // snapshots synchronously for any doc mutation once writesRefused is
      // true. This guards a mutation landing between disposal and detach.
      if (binding?.doc) refreshRecoveryDraft(binding.doc);
      disposed = true;
      unsubscribeSaveState?.();
      unsubscribeSaveState = null;
      detachSaveObserver?.();
      detachSaveObserver = null;
      for (const detach of retiredDraftObservers.values()) detach();
      retiredDraftObservers.clear();
      const immediateDestroy = binding ? destroyBinding() : null;
      closeBarrierPromise = immediateDestroy
        ? immediateDestroy
        : lifecycle.then(
            () => undefined,
            () => undefined,
          );
      disposePromise = (async () => {
        if (immediateDestroy) {
          await closeBarrierPromise;
        } else {
          // An open can remain unanswered indefinitely. The lifecycle observes
          // disposed and closes a binding if it eventually arrives; cleanup
          // must not wait forever for that external answer.
          void lifecycle.catch(() => undefined);
        }
        // A recovery projection can outlive React cleanup. Production must
        // retain that recovery write; tests also need a join point before they
        // reset the process-wide recovery store.
        await recoveryQueue;
        listeners.clear();
      })();
      return disposePromise;
    },
    whenClosed() {
      return closeBarrierPromise ?? Promise.resolve();
    },
  };
  return session;
}

// A lease is stable for one path in one active version. Its session is not:
// retry replaces that session behind every subscriber, so duplicate panes
// become read-only together and then bind the same replacement Y.Doc.
function createEngineDocLease(
  input: EngineDocInput,
  requestKey: string,
  versionKey: string,
): EngineDocLease {
  const stableDocumentKey = documentKey(input.workspaceId, input.path);
  const listeners = new Set<() => void>();
  let snapshot = emptyLeaseSnapshot(requestKey);
  let refCount = 0;
  let releaseToken = 0;
  let started = false;
  let disposed = false;
  let transitionGeneration = 0;
  let transition: Promise<void> = Promise.resolve();
  let disposePromise: Promise<void> | null = null;
  let closeBarrierPromise: Promise<void> | null = null;
  const initialSession = createEngineDocSession(input, requestKey);
  let activeSession: EngineDocSession | null = null;
  let unsubscribeSession: (() => void) | null = null;

  const publish = (next: EngineDocLeaseSnapshot): void => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const attach = (session: EngineDocSession): void => {
    if (disposed) return;
    activeSession = session;
    unsubscribeSession = session.subscribe(() => {
      if (activeSession === session) publish(session.getSnapshot());
    });
    publish(session.getSnapshot());
    session.start();
  };

  let lease: EngineDocLease;
  const disposeReleasedLease = (): void => {
    if (refCount !== 0 || engineDocLeases.get(versionKey) !== lease) {
      return;
    }
    engineDocLeases.delete(versionKey);
    void trackEngineDocDisposal(lease);
  };

  lease = {
    documentKey: stableDocumentKey,
    retain() {
      refCount += 1;
      releaseToken += 1;
    },
    release() {
      if (refCount === 0) return;
      refCount -= 1;
      if (refCount !== 0) return;
      const pendingRelease = ++releaseToken;
      queueMicrotask(() => {
        if (releaseToken !== pendingRelease) return;
        disposeReleasedLease();
      });
    },
    disposeIfReleased() {
      if (refCount !== 0) return;
      releaseToken += 1;
      disposeReleasedLease();
    },
    reopenForRetry(nextInput, nextRequestKey) {
      if (disposed) return;
      if (snapshot.key === nextRequestKey && snapshot.outcome === null) return;

      const generation = ++transitionGeneration;
      const previous = activeSession;
      const replacement = createEngineDocSession(nextInput, nextRequestKey);
      activeSession = null;
      unsubscribeSession?.();
      unsubscribeSession = null;
      publish(emptyLeaseSnapshot(nextRequestKey));

      transition = settleEngineDocCleanup(
        transition.then(async () => {
          await settleEngineDocCleanup(previous?.dispose());
          await settleEngineDocCleanup(previous?.whenClosed());
          if (disposed || generation !== transitionGeneration) {
            await settleEngineDocCleanup(replacement.dispose());
            await settleEngineDocCleanup(replacement.whenClosed());
            return;
          }
          attach(replacement);
        }),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    startAfter(barrier) {
      if (started) return;
      started = true;
      if (!barrier) {
        attach(initialSession);
        return;
      }
      const generation = transitionGeneration;
      transition = settleEngineDocCleanup(
        settleEngineDocCleanup(barrier).then(async () => {
          if (disposed || generation !== transitionGeneration) {
            await settleEngineDocCleanup(initialSession.dispose());
            await settleEngineDocCleanup(initialSession.whenClosed());
            return;
          }
          attach(initialSession);
        }),
      );
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      transitionGeneration += 1;
      unsubscribeSession?.();
      unsubscribeSession = null;
      const current = activeSession;
      activeSession = null;
      const immediateDispose = settleEngineDocCleanup(current?.dispose());
      const immediateClose = settleEngineDocCleanup(current?.whenClosed());
      disposePromise = (async () => {
        await settleEngineDocCleanup(transition);
        await immediateDispose;
        listeners.clear();
      })();
      closeBarrierPromise = (async () => {
        await settleEngineDocCleanup(transition);
        await immediateDispose;
        await immediateClose;
      })();
      return disposePromise;
    },
    whenClosed() {
      return closeBarrierPromise ?? disposePromise ?? Promise.resolve();
    },
  };
  return lease;
}

// Test seam for process-wide renderer state. React StrictMode requires the
// ordinary zero-reference release to wait one microtask, while test cleanup
// must join every deletion recovery before resetting the global draft store.
export async function disposeEngineDocLeasesForTests(): Promise<void> {
  const leases = [...new Set(engineDocLeases.values())];
  engineDocLeases.clear();
  // Test bridges can deliberately leave an open request unanswered forever.
  // Clear its close barrier with the registry; ordinary disposal still marks
  // the session disposed so a late answer closes instead of binding.
  engineDocDisposalBarriers.clear();
  await Promise.all(leases.map((lease) => lease.dispose()));
}

function retainEngineDocLease(
  input: EngineDocInput,
  requestKey: string,
  isRetry: boolean,
): EngineDocLease {
  const versionKey = documentVersionKey(
    input.workspaceId,
    input.path,
    input.reopenKey,
  );
  let lease = engineDocLeases.get(versionKey);
  if (!lease) {
    const stableDocumentKey = documentKey(input.workspaceId, input.path);
    for (const candidate of engineDocLeases.values()) {
      if (candidate.documentKey === stableDocumentKey) {
        candidate.disposeIfReleased();
      }
    }
    lease = createEngineDocLease(input, requestKey, versionKey);
    engineDocLeases.set(versionKey, lease);
    lease.startAfter(engineDocDisposalBarriers.get(stableDocumentKey));
  } else if (isRetry) {
    lease.reopenForRetry(input, requestKey);
  }
  lease.retain();
  return lease;
}

export function useEngineDoc(input: EngineDocInput): UseEngineDoc {
  const requestKey = engineDocRequestKey(input);
  const retryKey = input.retryKey ?? 0;
  const versionKey = documentVersionKey(
    input.workspaceId,
    input.path,
    input.reopenKey,
  );
  const committedRequestRef = useRef<{
    versionKey: string;
    retryKey: number;
    lease: EngineDocLease | null;
  } | null>(null);
  const [leaseState, setLeaseState] = useState<{
    requestKey: string;
    snapshot: EngineDocLeaseSnapshot;
  } | null>(null);

  useEffect(() => {
    const previousRequest = committedRequestRef.current;
    if (!input.enabled) {
      previousRequest?.lease?.disposeIfReleased();
      committedRequestRef.current = { versionKey, retryKey, lease: null };
      setLeaseState(null);
      return;
    }

    const isRetry =
      previousRequest?.versionKey === versionKey &&
      previousRequest.retryKey !== retryKey;
    const lease = retainEngineDocLease(input, requestKey, isRetry);
    committedRequestRef.current = { versionKey, retryKey, lease };
    const update = () =>
      setLeaseState({
        requestKey,
        snapshot: lease.getSnapshot(),
      });
    const unsubscribe = lease.subscribe(update);
    update();
    return () => {
      unsubscribe();
      lease.release();
    };
    // Re-open only when the workspace, path, gate, kind, retry, or active
    // version changes. Other renders keep the same shared lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    input.workspaceId,
    input.path,
    input.enabled,
    input.kind,
    input.reopenKey,
    input.retryKey,
  ]);

  // Derive this during render. A result for an earlier request never grants
  // one editable frame while a version, path, gate, or retry request changes.
  const settled =
    leaseState?.requestKey === requestKey ? leaseState.snapshot : null;
  const outcome = settled?.outcome ?? null;
  const available = outcome?.kind === "bound";
  const doc = outcome?.kind === "bound" ? outcome.doc : null;
  const objectId = outcome?.kind === "bound" ? outcome.objectId : null;
  const versionId = outcome?.kind === "bound" ? outcome.versionId : null;
  const opening = input.enabled && outcome === null;
  const notInVersion = outcome?.kind === "not-in-version";
  const engineMayHoldDocument = outcome?.kind === "engine-may-hold-document";
  const artifactAssetsInvalid = outcome?.kind === "artifact-assets-invalid";
  const artifactAssets =
    outcome?.kind === "bound" ? outcome.artifactAssets : [];
  const readArtifactAsset =
    outcome?.kind === "bound"
      ? outcome.readArtifactAsset
      : (descriptor: ArtifactAssetDescriptor) =>
          Promise.reject(
            new Error(
              `Artifact asset ${descriptor.id} cannot load without a live document session.`,
            ),
          );
  const removalInProgress =
    outcome?.kind === "removal-in-progress" ? outcome.removal : null;
  const deletedWhileEditing =
    outcome?.kind === "bound" && settled?.deletion?.token === outcome.token;
  const deletedDraftId = deletedWhileEditing
    ? (settled?.deletion?.draftId ?? null)
    : null;
  const readOnlyWhileEditing =
    outcome?.kind === "bound" &&
    settled?.readOnlyTransition?.token === outcome.token;
  const permanentFailureWhileEditing =
    outcome?.kind === "bound" &&
    settled?.permanentFailure?.token === outcome.token;
  const recoveryAssets =
    settled?.sceneRecoveryAssets != null &&
    outcome?.kind === "bound" &&
    settled.sceneRecoveryAssets.token === outcome.token
      ? {
          state: settled.sceneRecoveryAssets.state,
          count: settled.sceneRecoveryAssets.count,
        }
      : null;

  return {
    available,
    opening,
    doc,
    objectId,
    versionId,
    saveState: settled?.saveState ?? "saved",
    saveError: settled?.saveError ?? null,
    notInVersion,
    engineMayHoldDocument,
    artifactAssetsInvalid,
    deletedWhileEditing,
    deletedDraftId,
    recoveryAssets,
    permanentFailureWhileEditing,
    readOnlyWhileEditing,
    removalInProgress,
    artifactAssets,
    readArtifactAsset,
  };
}
