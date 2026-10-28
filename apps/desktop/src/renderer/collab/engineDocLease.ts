import type { SharedDocumentOpenState } from "../../ipc/sharedDocumentOpenState";
import { SAVED_HERE, SAVING, UNKNOWN_SAVE_STATE, saveProblem, saveStateEqual, type SaveState } from "@dohc/workspace-contracts/save-state";
import * as Y from "yjs";
import { authorCapacityMessage } from "./authorCapacityMessage";
import type { LiveDocumentKind } from "@dohc/workspace-contracts/live-documents";
import {
  declareSceneRoots,
  exportPortableScene,
  stableJson,
} from "@dohc/excalidraw-scene";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";
import type { EngineYDocSaveStateEvent, ReadOnlyTransitionCause } from "../../ipc/bridgeContract";
import { readError, withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { documentKey, documentVersionKey } from "../documentVersionKey";
import {
  binaryFileDataFromArtifact,
  sameArtifactAssetDescriptor,
} from "../excalidrawAssets";
import {
  captureOrphanedDraft,
  orphanedDraftStorageRefused,
  replaceOrphanedDraft,
} from "../orphanedDrafts";
import { reportDocumentReplacement } from "../shell/useDocumentSaveNotices";
import { bytesToBase64 } from "../base64";
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

// The immediate fallback the recovery boundary persists before the
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

// Why a document left its path while it was open.
export type DocumentGoneCause = "deleted" | "object-changed";

// What one open answers: a workspace, a path, the gate, and the active-version
// token. Everything this hook returns belongs to exactly one of these. JSON
// quotes each part, so two different requests cannot produce one key.
export function engineDocRequestKey(input: {
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
      headSha256?: string | null;
      objectId: string | null;
      versionId: string | null;
      artifactAssets: readonly ArtifactAssetDescriptor[];
      readArtifactAsset: EngineYDocBinding["readArtifactAsset"];
      flushPendingLocalUpdates: EngineYDocBinding["flushPendingLocalUpdates"];
    }
  | { kind: "unavailable" }
  | { kind: "capture-held" }
  // A close released the file, but capture has not recorded the version
  // changed outside dohc yet.
  | { kind: "outside-write-waiting" }
  // Their own kinds, not flags on "unavailable": only the unqualified outcome
  // means "fall back to the plain editor". Collapsing these outcomes would put
  // distinct user states and retry rules behind one flag.
  | { kind: "not-in-version" }
  | { kind: "document-unavailable" }
  | { kind: "live-host-unavailable" }
  | { kind: "shared-waiting"; waiting: SharedDocumentOpenState }
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
  // echoes back the seq each settle started at, and only a settle that covers
  // the newest edit may be reported as "Saved".
  localSeq: { current: number },
  writesRefused: { current: boolean },
  kind: LiveDocumentKind,
  allowLossySourceSha256?: string,
): EngineYDocTransport {
  let lineageGeneration = 1;
  return {
    ...(kind === "scene" ? { initializeDoc: declareSceneRoots } : {}),
    async open() {
      const result = await bridge().openEngineYDocSession({
        ...(allowLossySourceSha256 ? { allowLossySourceSha256 } : {}),
        workspaceId,
        path,
        sessionId,
      });
      if (result.available && result.lineageGeneration !== undefined) {
        lineageGeneration = result.lineageGeneration;
      }
      return {
        available: result.available,
        headSha256: result.headSha256,
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
        ...(result.liveHostUnavailable ? { liveHostUnavailable: true } : {}),
        ...(result.sharedWaiting ? { sharedWaiting: result.sharedWaiting } : {}),
        ...(result.documentUnavailable ? { documentUnavailable: true } : {}),
        ...(result.captureHeld ? { captureHeld: true } : {}),
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
    adoptOwner(generation) {
      return bridge().prepareEngineYDocOwnerHandoff({sessionId,lineageGeneration: generation});
    },
    onOwnerHandoff(listener) {
      return bridge().onEngineYDocOwnerHandoff(event => {
        if (event.sessionId === sessionId) listener(event.lineageGeneration);
      });
    },
    stageLocalUpdate() {
      if (writesRefused.current) return null;
      localSeq.current += 1;
      return localSeq.current;
    },
    async applyLocalUpdate(update, seq, updateGeneration, requestId) {
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
        requestId,
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
      if (!result.accepted) {
        throw new EngineYDocDeliveryRefusedError(result.reason);
      }
      lineageGeneration = nextLineageGeneration;
      return result.updates;
    },
    async close() {
      await bridge().closeEngineYDocSession({ sessionId }).catch(() => undefined);
    },
  };
}

export type EngineDocInput = {
  allowLossySourceSha256?: string;
  accessEnded?: boolean;
  workspaceId: string;
  path: string;
  // The caller gates which supported live files open an engine session.
  // Read-only shared views stay local. A scene can open even when the bounded
  // renderer text read is truncated because the engine owns the full scene.
  enabled: boolean;
  // Defaults to richdoc for existing direct hook callers. Product callers pass
  // the classifier result explicitly.
  kind?: LiveDocumentKind;
  // Bump to retry after engineMayHoldDocument: a retry replaces the
  // lease's session behind every subscriber, with the same stale-response
  // guard as any other open.
  retryKey?: number;
  // G2-C-3 version-switch re-bind: a monotonic token that changes whenever the
  // active version of this workspace changes while the same file stays open.
  reopenKey?: number;
};

export type EngineDocLeaseSnapshot = {
  key: string;
  outcome: EngineDocOpenOutcome | null;
  saveState: SaveState;
  saveError: string | null;
  authorCapacity: boolean;
  deletion: {
    token: number;
    draftId: number | null;
    cause: DocumentGoneCause;
  } | null;
  // The draft this transition set aside, when it set one aside. A failed
  // history replacement keeps its Try again here for the frozen editor.
  readOnlyTransition: {
    token: number;
    cause: ReadOnlyTransitionCause;
    draftId: number | null;
    retry?: () => void;
  } | null;
  permanentFailure: { token: number } | null;
  // The file changed outside dohc while this session held it, and whether
  // the document then had edits no save carried.
  changedOutside: { token: number; unsaved: boolean } | null;
  // The drafts holding edits a history replacement set aside, once the new
  // history shows.
  replacedDraftIds: readonly number[];
  sceneRecoveryAssets: {
    token: number;
    state: "loading" | "missing";
    count: number;
  } | null;
};

type EngineDocSession = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => EngineDocLeaseSnapshot;
  // Edits this editor made that main has not confirmed, asked at the moment.
  unsavedEditsPending: () => boolean;
  start: () => void;
  dispose: () => Promise<void>;
  whenClosed: () => Promise<void>;
};

export type EngineDocLease = Omit<EngineDocSession, "start"> & {
  workspaceId: string;
  documentKey: string;
  startAfter: (barrier: Promise<void> | undefined) => void;
  retain: () => void;
  release: () => void;
  disposeIfReleased: () => void;
  reopenForRetry: (input: EngineDocInput, requestKey: string) => void;
  withClosedSession: (work: () => Promise<void>) => Promise<void>;
};

const engineDocLeases = new Map<string, EngineDocLease>();
const engineDocDisposalBarriers = new Map<string, Promise<void>>();
let engineDocLeaseCounter = 0;

function emptyLeaseSnapshot(requestKey: string): EngineDocLeaseSnapshot {
  return {
    key: requestKey,
    outcome: null,
    saveState: UNKNOWN_SAVE_STATE,
    saveError: null,
    authorCapacity: false,
    deletion: null,
    readOnlyTransition: null,
    permanentFailure: null,
    changedOutside: null,
    replacedDraftIds: [],
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
  const saveStateRef = { current: UNKNOWN_SAVE_STATE as SaveState };
  const writesRefused = { current: false };
  const localSeq = { current: 0 };
  const transport = makeTransport(
    workspaceId,
    path,
    sessionId,
    localSeq,
    writesRefused,
    documentKind,
    input.allowLossySourceSha256,
  );

  let snapshot = emptyLeaseSnapshot(requestKey);
  let started = false;
  let disposed = false;
  let binding: EngineYDocBinding | null = null;
  let currentHeadSha256: string | null | undefined;
  const recoveryIdentity = (bytes: Uint8Array, objectId: string | null = binding?.objectId ?? null) =>
    objectId ? {objectId, updateBase64: bytesToBase64(bytes)} : undefined;
  let retiredBinding: EngineYDocBinding | null = null;
  let bindingDestroyed = false;
  let detachSaveObserver: (() => void) | null = null;
  let unsubscribeSaveState: (() => void) | null = null;
  let deletionPending = false;
  let deletionCause: DocumentGoneCause = "deleted";
  let deliveryPending = false;
  let typingUnresolved = false;
  let confirmedLocalSeq = 0;
  let pendingSavedSeq: number | null = null;
  let replacementPending = false;
  let replacementSaveState: EngineYDocSaveStateEvent | null = null;
  // The replacement in progress: the mirror it retires, the draft holding
  // that mirror's edits, and whether it follows a refusal main reported
  // against that mirror. Main announces that replacement right after the
  // refusal.
  let replacedDoc: Y.Doc | null = null;
  let replacedDraftId: number | null = null;
  let replacementFailed = false;
  let refusedDoc: Y.Doc | null = null;
  let replacementAfterRefusal = false;
  const replacedDraftUnstored = (): boolean =>
    replacedDraftId !== null && orphanedDraftStorageRefused(path, replacedDraftId);
  let pendingSavedState: SaveState = SAVED_HERE;
  // One draft per retired mirror, kept across Try again. Its queue serializes
  // the projections of every attempt.
  type RetiredDraft = {
    draftId: number | null;
    projection: Promise<void>;
    detach: () => void;
  };
  const retiredDrafts = new Map<Y.Doc, RetiredDraft>();
  // Every write to a set-aside draft takes the next revision of its draft ID,
  // from the recovery slot or a retired mirror. An async refinement writes
  // only while its revision is the newest, so an older one cannot overwrite
  // newer text, whichever path produced it.
  const draftRevisions = new Map<number, number>();
  const claimDraftRevision = (draftId: number): number => {
    const revision = (draftRevisions.get(draftId) ?? 0) + 1;
    draftRevisions.set(draftId, revision);
    return revision;
  };
  const isNewestDraftRevision = (draftId: number, revision: number): boolean =>
    (draftRevisions.get(draftId) ?? 0) === revision;
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
  };
  const newRecoverySlot = (): RecoverySlot => ({
    snapshotBytes: null,
    draftId: null,
    transition: null,
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

  const boundOutcome = (
    doc: Y.Doc,
    bound: EngineYDocBinding,
    artifactAssets: readonly ArtifactAssetDescriptor[],
  ): EngineDocOpenOutcome => ({
    token,
    kind: "bound",
    doc,
    objectId: bound.objectId,
    headSha256: currentHeadSha256 === undefined ? bound.headSha256 : currentHeadSha256,
    versionId: bound.versionId,
    artifactAssets,
    readArtifactAsset: (descriptor) => bound.readArtifactAsset(descriptor),
    flushPendingLocalUpdates: () => bound.flushPendingLocalUpdates(),
  });

  const reportSaveState = (
    state: SaveState,
    error: string | null = null,
    authorCapacity = false,
  ): void => {
    if (state.kind === "error" && error) state = saveProblem("error", error, "issueId" in state ? state.issueId : null);
    if (saveStateEqual(snapshot.saveState, state) && snapshot.saveError === error && snapshot.authorCapacity === authorCapacity) return;
    saveStateRef.current = state;
    publish((current) => ({ ...current, saveState: state, saveError: error, authorCapacity }));
  };

  // A change to the document from any origin, an agent's edit through main
  // included, after main said nothing was unsaved.
  let changedSinceCleanSignal = false;
  const unsavedEditsPending = (): boolean =>
    deliveryPending || localSeq.current > confirmedLocalSeq || changedSinceCleanSignal;
  // The file changed outside dohc. Edits main has not confirmed are unsaved
  // whatever main counted, so the document must not reload over them.
  const noteChangedOutside = (unsaved: boolean): void => {
    const current = snapshot.changedOutside;
    if (current?.token === token && (current.unsaved || !unsaved)) return;
    publish((latest) => ({ ...latest, changedOutside: { token, unsaved } }));
  };

  const onDeliveryPendingChange = (pending: boolean): void => {
    deliveryPending = pending;
    if (pending) {
      pendingSavedSeq = null;
      if (snapshot.changedOutside?.token === token) noteChangedOutside(true);
      return;
    }
    if (
      pendingSavedSeq !== null &&
      !disposed &&
      !writesRefused.current &&
      pendingSavedSeq >= localSeq.current
    ) {
      confirmedLocalSeq = pendingSavedSeq;
      reportSaveState(pendingSavedState);
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
    const snapshotObjectId = binding?.objectId ?? null;
    const draftId = slot.draftId;
    const revision = draftId === null ? 0 : claimDraftRevision(draftId);
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
        // Every refinement projects the newest snapshot its slot holds, so an
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
        let written: number;
        if (draftId === null) {
          if (!forceCreate || slot.draftId !== null) return;
          written = slot.draftId = captureOrphanedDraft(workspaceId, path, text, recoveryIdentity(newest, snapshotObjectId));
        } else {
          // A later write to this draft, from either path, holds newer text.
          if (!isNewestDraftRevision(draftId, revision)) return;
          written = draftId;
          replaceOrphanedDraft(workspaceId, path, draftId, text, recoveryIdentity(newest, snapshotObjectId));
        }
        // Only the published render state dies with the session — the draft
        // itself is already durable in the module-level store, unmount or not.
        if (transition === "deletion" && slot === recovery) {
          publish((current) => ({
            ...current,
            deletion: { token, draftId: slot.draftId, cause: deletionCause },
          }));
        }
        // An edit after a read-only status that set nothing aside.
        if (
          transition === "read-only" &&
          slot === recovery &&
          snapshot.readOnlyTransition &&
          snapshot.readOnlyTransition.draftId !== slot.draftId
        ) {
          publish((current) => ({
            ...current,
            readOnlyTransition: current.readOnlyTransition && {
              ...current.readOnlyTransition,
              draftId: slot.draftId,
            },
          }));
        }
        if (!sceneRecovery) return;
        // Asset I/O must not hold the recovery queue. A later scene update
        // must replace the immediate draft now, even if this older image
        // read is slow. Only the newest snapshot may apply its async result.
        void sceneRecovery.completed.then((recovered) => {
          if (!isNewestDraftRevision(written, revision)) return;
          replaceOrphanedDraft(
            workspaceId,
            path,
            written,
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

  const captureDeletion = (
    doc: Y.Doc,
    cause: DocumentGoneCause = "deleted",
    edited = false,
  ): void => {
    writesRefused.current = true;
    // The PATH is gone whichever lineage wins: deletion outlives any later
    // replacement, and a fresh recovery slot re-captures on its first edit.
    deletionPending = true;
    deletionCause = cause;
    recovery.transition = "deletion";
    // Snapshot now, synchronously: the doc can be destroyed (unmount) or
    // the caller's reference can go stale before a lazily-loaded
    // serializer would otherwise get to read it.
    const bytes = Y.encodeStateAsUpdate(doc);
    recovery.snapshotBytes = bytes;
    const forceCreate = edited || (saveStateRef.current.kind !== "saved-here" && saveStateRef.current.kind !== "unknown");
    const sceneRecovery =
      forceCreate && documentKind === "scene" && binding
        ? prepareSceneRecovery(bytes, binding)
        : null;
    if (forceCreate) {
      // Persisted now, before the projection module is even guaranteed to
      // load: a renderer close/reload/crash while that import is still in
      // flight must not lose text that exists only in this queue's promise
      // closure, with the file already gone and no draft for the recovery
      // close guard to find. The queue below upgrades this row to the
      // faithful markdown a microtask later; it never creates a second one.
      recovery.draftId = captureOrphanedDraft(
        workspaceId,
        path,
        sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc, bytes),
        recoveryIdentity(bytes),
      );
    }
    publish((current) => ({
      ...current,
      deletion: { token, draftId: recovery.draftId, cause },
    }));
    reportSaveState(UNKNOWN_SAVE_STATE);
    enqueueRecoverySnapshot(
      bytes,
      forceCreate,
      recovery.transition,
      sceneRecovery,
    );
  };

  // A refused update always leaves work behind. A read-only status can also
  // arrive after every edit saved; then `recoverEdits` is false, nothing is
  // set aside, and a later edit still starts a draft through the snapshot.
  const captureReadOnlyTransition = (doc: Y.Doc, recoverEdits = true, cause: ReadOnlyTransitionCause = "access-ended"): void => {
    writesRefused.current = true;
    recovery.transition = "read-only";
    const bytes = Y.encodeStateAsUpdate(doc);
    recovery.snapshotBytes = bytes;
    const sceneRecovery =
      recoverEdits && documentKind === "scene" && binding
        ? prepareSceneRecovery(bytes, binding)
        : null;
    if (recoverEdits) {
      // Persist the waiting document synchronously before the session closes.
      recovery.draftId = captureOrphanedDraft(
        workspaceId,
        path,
        sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc, bytes),
        recoveryIdentity(bytes),
      );
    }
    publish((current) => ({
      ...current,
      readOnlyTransition: { token, cause, draftId: recovery.draftId },
    }));
    reportSaveState(UNKNOWN_SAVE_STATE);
    if (recoverEdits) {
      enqueueRecoverySnapshot(bytes, true, recovery.transition, sceneRecovery);
    }
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
      // The newest text is durable immediately — the faithful projection
      // refines this row later, and a crash before it cannot lose the edit.
      replaceOrphanedDraft(
        workspaceId,
        path,
        recovery.draftId,
        sceneRecovery?.immediateText ??
          crudeRecoveryText(documentKind, doc, bytes),
        recoveryIdentity(bytes),
      );
    } else {
      const draftId = captureOrphanedDraft(
        workspaceId,
        path,
        sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc, bytes),
      );
      recovery.draftId = draftId;
      // An edit after a read-only status that set nothing aside. Name its
      // draft now: the projection below can fail, and disposal stops publishing.
      if (recovery.transition === "read-only") {
        publish((current) => ({
          ...current,
          readOnlyTransition: current.readOnlyTransition && {
            ...current.readOnlyTransition,
            draftId,
          },
        }));
      }
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
      recoveryIdentity(bytes),
    );
    if (!disposed) {
      publish((current) => ({
        ...current,
        permanentFailure: { token },
      }));
      reportSaveState(saveProblem("error", "dohc could not confirm the file was saved."), readError(error).words);
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
      (error.reason === "deleted" || error.reason === "object-changed")
    ) {
      captureDeletion(source, error.reason);
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
    retry: () => Promise<void>,
  ): void => {
    writesRefused.current = true;
    if (disposed) return;
    replacementFailed = true;
    const tryAgain = (): void => {
      if (!disposed) void retry().catch(() => undefined);
    };
    reportDocumentReplacement(workspaceId, path, replacedDraftId !== null, {
      setAsideFailed: replacedDraftUnstored(),
      cause: error,
      retry: tryAgain,
    });
    publish((current) => ({
      ...current,
      readOnlyTransition: { token, cause: "lineage-failure", draftId: null, retry: tryAgain },
    }));
    const bound = retiredBinding ?? binding;
    if (bound) {
      setOutcome(boundOutcome(retired, bound, [...bound.artifactAssets]));
    }
    reportSaveState(
      saveProblem("error", "dohc could not finish replacing this document."),
      withErrorWords("dohc could not finish replacing this document.", error),
    );
  };

  const onSaveState = (event: EngineYDocSaveStateEvent): void => {
    if (disposed || event.sessionId !== sessionId) return;
    if (event.headSha256 !== undefined) {
      currentHeadSha256 = event.headSha256;
      publish(current => ({ ...current, outcome: current.outcome?.kind === "bound"
        ? { ...current.outcome, headSha256: event.headSha256 } : current.outcome }));
    }
    refusedDoc = event.editRefusal !== undefined ? (binding?.doc ?? null) : null;
    if(event.typingUnresolved !== undefined) typingUnresolved=event.typingUnresolved;
    if (event.access === "deleted" || event.access === "object-changed") {
      pendingSavedSeq = null;
      const cause = event.access;
      const doc = binding?.doc;
      if (!doc) {
        deletionPending = true;
        deletionCause = cause;
        writesRefused.current = true;
        return;
      }
      if (recovery.snapshotBytes !== null) {
        deletionPending = true;
        deletionCause = cause;
        recovery.transition = "deletion";
        publish((current) => ({
          ...current,
          deletion: { token, draftId: recovery.draftId, cause },
        }));
        reportSaveState(UNKNOWN_SAVE_STATE);
        refreshRecoveryDraft(doc);
        return;
      }
      captureDeletion(doc, cause);
      return;
    }
    if (event.changedOutside) noteChangedOutside(event.changedOutside.unsaved || unsavedEditsPending());
    // Deletion is terminal for this session. A settle/update already in
    // flight can report after main's deletion notice, but it no longer
    // describes a path that exists and must not repaint this state.
    if (replacementPending && !event.access) {
      replacementSaveState = event;
      return;
    }
    if (writesRefused.current) return;
    if (event.access === "read-only") {
      pendingSavedSeq = null;
      const doc = binding?.doc;
      if (!doc) return;
      // Hosted status has seq 0. A refused apply names its staged edit.
      // Remote updates can change saveState without staging a local edit.
      captureReadOnlyTransition(doc,
        event.seq > 0 || deliveryPending || localSeq.current > confirmedLocalSeq,
        event.readOnlyCause ?? "access-ended",
      );
      releaseBinding();
      return;
    }
    if (event.state.kind === "saved-here" || event.state.kind === "saved-to-host") {
      if (deliveryPending) {
        // Batches or unacknowledged deliveries are still outstanding — a
        // settle that raced ahead of them must not vouch for the mirror.
        if (pendingSavedSeq === null || event.seq >= pendingSavedSeq) {
          pendingSavedSeq = event.seq;
          pendingSavedState = event.state;
        }
        return;
      }
      if (event.seq >= localSeq.current) {
        confirmedLocalSeq = event.seq;
        reportSaveState(event.state);
      }
      return;
    }
    if (event.state.kind === "file-locked" || event.state.kind === "pending-share") {
      // An older report covers no staged edit, so it must not drop a current
      // save that is waiting for delivery to finish.
      if (event.seq < localSeq.current) return;
      pendingSavedSeq = null;
      reportSaveState(event.state);
      return;
    }
    pendingSavedSeq = null;
    if (event.state.kind === "error" || event.state.kind === "changed-on-disk") {
      reportSaveState(event.state, event.editRefusal?.message ?? (event.authorCapacity ? authorCapacityMessage(input.path) : null), event.authorCapacity);
      return;
    }
    if (event.state.kind === "saving") {
      reportSaveState(SAVING);
      return;
    }
  };

  const observeSaveState = (doc: Y.Doc): void => {
    detachSaveObserver?.();
    const onUpdate = () => {
      if (disposed) return;
      if (snapshot.changedOutside?.token === token && !snapshot.changedOutside.unsaved) {
        changedSinceCleanSignal = true;
        noteChangedOutside(true);
      }
      if (writesRefused.current) {
        if (recovery.snapshotBytes === null && deletionPending) {
          // A replacement installed a fresh recovery slot while the path
          // stayed deleted. The first edit on the winner starts its own
          // draft instead of vanishing.
          captureDeletion(doc, deletionCause, true);
          return;
        }
        refreshRecoveryDraft(doc);
        return;
      }
      reportSaveState(SAVING);
    };
    doc.on("update", onUpdate);
    detachSaveObserver = () => doc.off("update", onUpdate);
  };

  const preserveRetiredDocument = (retired: Y.Doc): void => {
    writesRefused.current = true;
    const retiredRecoverySlot = recovery;
    // A deletion (or other capture) already owns a draft for this mirror —
    // the retired preserve refines that row instead of adding a sibling.
    // Try again reuses the draft an earlier attempt made.
    const earlier = retiredDrafts.get(retired);
    earlier?.detach();
    const retiredDraft: RetiredDraft = earlier ?? {
      draftId: retiredRecoverySlot.draftId,
      projection: Promise.resolve(),
      detach: () => undefined,
    };
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
                `Artifact asset ${descriptor.id} does not belong to this document. Open the document again.`,
              );
            }
            const loaded = await readSceneAsset(
              sceneAssetCacheKey(retained),
              retained,
              activeBinding,
            );
            if (!loaded) {
              throw new Error(
                `Artifact asset ${descriptor.id} could not load for this document. Open the document again.`,
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
        const statusRevision = ++recoveryStatusRevision;
        const sceneRecovery = prepareSceneRecovery(bytes, retiredAuthority);
        if (retiredDraft.draftId === null) {
          retiredDraft.draftId = captureOrphanedDraft(
            workspaceId,
            path,
            sceneRecovery.immediateText,
            recoveryIdentity(bytes, retiredAuthority?.objectId ?? null),
          );
        } else {
          replaceOrphanedDraft(
            workspaceId,
            path,
            retiredDraft.draftId,
            sceneRecovery.immediateText,
            recoveryIdentity(bytes, retiredAuthority?.objectId ?? null),
          );
        }
        const draftId = retiredDraft.draftId;
        const revision = claimDraftRevision(draftId);
        if (replacedDoc === retired) replacedDraftId = draftId;
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
        if (publishesRecoveryStatus) {
          // The slot must know about this draft and snapshot: a deletion or
          // read-only push arriving after the preserve refines this row
          // instead of capturing a sibling from the same mirror.
          retiredRecoverySlot.snapshotBytes = bytes;
          retiredRecoverySlot.draftId = draftId;
        }
        void sceneRecovery.completed
          .then((recovered) => {
            if (!isNewestDraftRevision(draftId, revision)) return;
            replaceOrphanedDraft(
              workspaceId,
              path,
              draftId,
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
      if (retiredDraft.draftId === null) {
        retiredDraft.draftId = captureOrphanedDraft(workspaceId, path, crude, recoveryIdentity(bytes, retiredAuthority?.objectId ?? null));
      } else {
        replaceOrphanedDraft(workspaceId, path, retiredDraft.draftId, crude, recoveryIdentity(bytes, retiredAuthority?.objectId ?? null));
      }
      const draftId = retiredDraft.draftId;
      const revision = claimDraftRevision(draftId);
      if (replacedDoc === retired) replacedDraftId = draftId;
      if (retiredRecoverySlot === recovery) {
        // The slot must know about this draft and snapshot: a deletion or
        // read-only push arriving after the preserve refines this row
        // instead of capturing a sibling from the same mirror.
        retiredRecoverySlot.snapshotBytes = bytes;
        retiredRecoverySlot.draftId = draftId;
      }
      retiredDraft.projection = retiredDraft.projection
        .then(async () => {
          const markdown = await markdownFromSnapshot(bytes);
          if (!isNewestDraftRevision(draftId, revision)) return;
          replaceOrphanedDraft(
            workspaceId,
            path,
            draftId,
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
    replacedDoc = retired;
    replacedDraftId = retiredDraft.draftId;
    // A dirty mirror may contain the update main refused when replacement
    // began. Persist it synchronously before acknowledging, and again for
    // Try again after storage refused it. If a transaction already in the
    // editor lands before React unmounts the retired doc, the observer
    // refreshes that same durable draft.
    if ((saveStateRef.current.kind !== "saved-here" && saveStateRef.current.kind !== "unknown") || deliveryPending || replacedDraftUnstored()) persist();
    const onRetiredUpdate = () => persist();
    retired.on("update", onRetiredUpdate);
    retiredDraft.detach = () => retired.off("update", onRetiredUpdate);
    retiredDrafts.set(retired, retiredDraft);
    assertRetiredDocumentStored();
    setOutcome(null);
  };

  // The retired editor stays until storage keeps its edits, and the winner
  // waits for Try again. Checked again right before the acknowledgement,
  // because a late edit can reach a draft that storage refuses.
  const assertRetiredDocumentStored = (): void => {
    if (replacedDraftUnstored()) throw new Error("Storage refused the earlier edits.");
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
    unsavedEditsPending,
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
            hasUnresolvedCheckpoint: ()=>typingUnresolved,
            checkpointForExit: async () => {await bridge().typingRecovery({workspaceId, action: "flush"});},
            onDocumentReplacementStarted: () => {
              // Try again restarts the replacement already held here.
              if (replacementPending) return;
              replacementPending = true;
              replacementSaveState = null;
              replacementAfterRefusal = refusedDoc !== null && refusedDoc === binding?.doc;
            },
            onDocumentReplacing: preserveRetiredDocument,
            beforeReplacementAcknowledged: assertRetiredDocumentStored,
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
            // Resolved: not engine-backed. The caller may offer the plain
            // local editor again — that is what `opening` was holding back.
            // Except when the path is not in this version, where offering it
            // would write the phantom the engine just refused, and
            // when the engine may still hold the document, where a plain
            // autosave would race the session it still binds.
            if (bound.captureHeld) {
              setOutcome({ kind: "capture-held" });
            } else if (bound.outsideWriteWaiting) {
              setOutcome({ kind: "outside-write-waiting" });
            } else if (bound.notInVersion) {
              setOutcome({ kind: "not-in-version" });
            } else if (bound.sharedWaiting) {
              setOutcome({ kind: "shared-waiting", waiting: bound.sharedWaiting });
            } else if (bound.liveHostUnavailable) {
              setOutcome({ kind: "live-host-unavailable" });
            } else if (bound.documentUnavailable) {
              setOutcome({ kind: "document-unavailable" });
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
            // A refusal main reported already has its own notice.
            const setAside = replacedDraftId !== null && !replacementAfterRefusal;
            if (setAside || replacementFailed) reportDocumentReplacement(workspaceId, path, setAside, null);
            const setAsideDraftId = replacedDraftId;
            replacedDoc = null;
            replacedDraftId = null;
            replacementFailed = false;
            // The losing slot owns its recovery draft and any pending image
            // reads. The winner starts a fresh slot so later delete/unmount
            // work cannot rewrite that draft with an independent lineage.
            recovery = newRecoverySlot();
            // The replacement owns new work; retired edits have their own draft.
            confirmedLocalSeq = localSeq.current;
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
              ...(setAsideDraftId === null ? {} : { replacedDraftIds: [...current.replacedDraftIds, setAsideDraftId] }),
            }));
            if (!writesRefused.current && !deliveryPending) {
              reportSaveState(UNKNOWN_SAVE_STATE);
            }
            replacementPending = false;
            const checkedState = replacementSaveState;
            replacementSaveState = null;
            if (checkedState) onSaveState(checkedState);
            observeSaveState(replacement);
            setOutcome(boundOutcome(replacement, bound, bound.artifactAssets));
          });
          // An edit is unsaved the instant it happens. Only main's settle
          // report may clear it — nothing here guesses "saved". The seed apply
          // happened before this observer attached, so it never shows a
          // spurious "saving".
          const doc = bound.doc;
          observeSaveState(doc);
          if (deletionPending) captureDeletion(doc, deletionCause);
          setOutcome(boundOutcome(doc, bound, bound.artifactAssets));
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
      // Try again needs this editor. Its earlier edits stay in Notices.
      if (replacementFailed) reportDocumentReplacement(workspaceId, path, false, null);
      disposed = true;
      unsubscribeSaveState?.();
      unsubscribeSaveState = null;
      detachSaveObserver?.();
      detachSaveObserver = null;
      for (const retired of retiredDrafts.values()) retired.detach();
      retiredDrafts.clear();
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
    workspaceId: input.workspaceId,
    documentKey: stableDocumentKey,
    withClosedSession(work) {
      const generation = ++transitionGeneration;
      const previous = activeSession;
      activeSession = null;
      unsubscribeSession?.();
      unsubscribeSession = null;
      publish(emptyLeaseSnapshot(requestKey));
      const operation = transition.then(async () => {
        try {
          await previous?.dispose();
          await previous?.whenClosed();
          if (disposed || generation !== transitionGeneration) throw new Error("dohc could not stop live editing. Try again.");
          await work();
        } finally {
          if (!disposed && generation === transitionGeneration) attach(createEngineDocSession(input, requestKey));
        }
      });
      transition = operation.catch(() => undefined);
      return operation;
    },
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
      input = nextInput;
      requestKey = nextRequestKey;

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
    unsavedEditsPending() {
      return activeSession?.unsavedEditsPending() ?? false;
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

/**
 * Flush and close every pane for this document before changing its live mode:
 * the panes at its path, or with its object id, the panes bound to it at
 * whatever path they opened it, and no pane of another document at its old path.
 */
export async function withClosedEngineDocSession(workspaceId: string, document: {path: string} | {objectId: string}, work: () => Promise<void>): Promise<void> {
  const held = (lease: EngineDocLease) => {
    if ("path" in document) return lease.documentKey === documentKey(workspaceId, document.path);
    const {outcome} = lease.getSnapshot();
    return lease.workspaceId === workspaceId && outcome?.kind === "bound" && outcome.objectId === document.objectId;
  };
  const leases = [...engineDocLeases.values()].filter(held);
  const close = (index: number): Promise<void> => index === leases.length ? work() : leases[index]!.withClosedSession(() => close(index + 1));
  await close(0);
}

export function retainEngineDocLease(
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
