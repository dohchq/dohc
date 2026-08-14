import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { bridge } from "../bridge";
import { documentKey, documentVersionKey } from "../documentVersionKey";
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

function snapshotsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// The engine Y.Doc editor hook for rich-text files. Given a workspace + rich
// file, it opens a
// live engine Y.Doc session in MAIN over IPC and binds a mirror Y.Doc the Tiptap
// Collaboration extension drives via its "body" XmlFragment — no websocket, no
// token, no cloud. Solo editing runs entirely on the engine; a co-editor's edit
// arrives as a forwarded remote delta on the same channel.
//
// available:false AND opening:false => the doc is NOT engine-backed (unflagged
// workspace, secret path, or already live) — the caller stays on the plain
// local autosave editor showing the real on-disk content. While opening:true
// the answer is not known yet and the caller must stay read-only. The other
// exception is `notInVersion`, where the answer IS known and the caller must
// stop editing rather than fall back (#534). Undo/redo is intact: the
// Collaboration extension bundles the Yjs UndoManager binding (COLLAB_STARTER_KIT
// disables the plain history), so Mod-z/Mod-y drive the CRDT undo stack.
//
// Renderer async-state invariant (product invariant): every open response is
// guarded by the per-open request token (a monotonic id + the effect's cancelled
// flag). A slow open for workspace/path A can never bind or repaint after the
// user has switched to B — the stale response is dropped and its session closed.

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
  // The mirror Y.Doc Tiptap binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // The document's REAL save state. "saving" the moment an edit is made,
  // "saved" ONLY when main reports a settle that covered that edit actually
  // committed and wrote the .md, "error" when a settle failed. This used to be
  // a 1s timer that flipped to "saved" regardless of what the engine did —
  // three dogfood journeys watched a doc read "Saved" over a zero-byte file.
  saveState: EngineDocSaveState;
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
  // Main confirmed that it removed this file while the live session was
  // bound. The current document is retained for recovery only.
  deletedWhileEditing: boolean;
  // The recovery row created for this deletion, if it still exists.
  deletedDraftId: number | null;
  // An open lost to a delete or move interval. This is not a terminal outcome:
  // the operation can still fail, so the caller stays read-only and retries.
  removalInProgress: EngineRemovalInProgress | null;
};

// What ONE open answers: a workspace, a path, the gate, and the active-version
// token. Everything this hook returns belongs to exactly one of these. JSON
// quotes each part, so two different requests cannot produce one key.
function engineDocRequestKey(input: {
  workspaceId: string;
  path: string;
  enabled: boolean;
  reopenKey?: number;
  retryKey?: number;
}): string {
  return JSON.stringify([
    input.enabled,
    input.workspaceId,
    input.path,
    input.reopenKey ?? null,
    input.retryKey ?? null,
  ]);
}

// The settled result of one open.
type EngineDocOpenOutcome =
  | { token: number; kind: "bound"; doc: Y.Doc }
  | { kind: "unavailable" }
  // Their OWN kinds, not flags on "unavailable": every other unavailable
  // answer means "fall back to the plain editor", and these two mean the
  // opposite (#534, #564). Collapsing them would put the branches back
  // behind one flag.
  | { kind: "not-in-version" }
  | { kind: "engine-may-hold-document" }
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
): EngineYDocTransport {
  let lineageGeneration = 1;
  return {
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
        ...(result.available && result.lineageGeneration !== undefined
          ? { lineageGeneration: result.lineageGeneration }
          : {}),
        ...(result.notInVersion ? { notInVersion: true } : {}),
        ...(result.engineMayHoldDocument ? { engineMayHoldDocument: true } : {}),
        ...(result.removalInProgress
          ? { removalInProgress: result.removalInProgress }
          : {}),
      };
    },
    async applyLocalUpdate(update, updateGeneration) {
      if (writesRefused.current) {
        throw new EngineYDocDeliveryRefusedError("document-writes-refused");
      }
      // Main journals + settles. The provider owns the asynchronous delivery
      // tail and repairs a rejected delta with the full mirror state before
      // close. The seq is NOT rolled back on failure — the edit is genuinely
      // unsaved until that repair or a later settle covers it.
      localSeq.current += 1;
      const seq = localSeq.current;
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
  // The caller gates: only a rich (markdown) file that is not truncated / read-
  // only opens an engine session. Everything else keeps the local editor.
  enabled: boolean;
  // Bump to retry after engineMayHoldDocument (#564): part of the request
  // key, so a retry is a fresh open with the same stale-response guard as any
  // other.
  retryKey?: number;
  // G2-C-3 version-switch re-bind: a monotonic token that changes whenever the
  // active version of this workspace changes while the same file stays open.
  reopenKey?: number;
};

type EngineDocLeaseSnapshot = {
  key: string;
  outcome: EngineDocOpenOutcome | null;
  saveState: EngineDocSaveState;
  deletion: { token: number; draftId: number | null } | null;
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
  );

  let snapshot: EngineDocLeaseSnapshot = {
    key: requestKey,
    outcome: null,
    saveState: "saved",
    deletion: null,
  };
  let started = false;
  let disposed = false;
  let binding: EngineYDocBinding | null = null;
  let bindingDestroyed = false;
  let detachSaveObserver: (() => void) | null = null;
  let unsubscribeSaveState: (() => void) | null = null;
  let deletionSnapshotBytes: Uint8Array | null = null;
  let deletionDraftId: number | null = null;
  let deletionDocument: Y.Doc | null = null;
  const recoveryDraftIds = new WeakMap<Y.Doc, number>();
  let deletionQueue: Promise<void> = Promise.resolve();
  let deletionPending = false;
  let deliveryPending = false;
  let pendingSavedSeq: number | null = null;
  const retiredDraftObservers = new Map<Y.Doc, () => void>();
  let lifecycle: Promise<void> = Promise.resolve();
  let disposePromise: Promise<void> | null = null;
  let closeBarrierPromise: Promise<void> | null = null;

  const publish = (
    update: (current: EngineDocLeaseSnapshot) => EngineDocLeaseSnapshot,
  ): void => {
    if (disposed) return;
    snapshot = update(snapshot);
    for (const listener of listeners) listener();
  };

  const setOutcome = (outcome: EngineDocOpenOutcome): void => {
    publish((current) => ({ ...current, outcome }));
  };

  const clearOutcome = (): void => {
    publish((current) => ({ ...current, outcome: null }));
  };

  const setDeletion = (draftId: number | null): void => {
    publish((current) => ({
      ...current,
      deletion: { token, draftId },
    }));
  };

  const reportSaveState = (state: EngineDocSaveState): void => {
    saveStateRef.current = state;
    publish((current) => ({ ...current, saveState: state }));
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

  // Refinement runs off a serial queue, so the user can capture a newer
  // snapshot while an earlier projection is still pending. Every refinement
  // therefore projects the NEWEST snapshot for its document, and drops a
  // result another one has overtaken. Projecting the bytes it was queued with
  // would roll the durable row back to text the user has already moved past —
  // and that row is the only copy of the newer edit.
  const newestSnapshots = new WeakMap<Y.Doc, Uint8Array>();
  const enqueueRefinement = (
    source: Y.Doc,
    bytes: Uint8Array,
    apply: (text: string) => void,
    failure: string,
  ): void => {
    newestSnapshots.set(source, bytes);
    deletionQueue = deletionQueue
      .then(async () => {
        const newest = newestSnapshots.get(source) ?? bytes;
        const text = await markdownFromSnapshot(newest);
        if (newestSnapshots.get(source) !== newest) return;
        apply(text);
      })
      .catch((error: unknown) => {
        console.error(
          `[desktop] could not ${failure} for ${workspaceId}:${path}:`,
          error,
        );
      });
  };

  // forceCreate false means the file was settled when main removed it. A later
  // snapshot always creates a draft because the retained document changed.
  const enqueueDeletionSnapshot = (
    source: Y.Doc,
    bytes: Uint8Array,
    forceCreate: boolean,
  ): void => {
    enqueueRefinement(
      source,
      bytes,
      (text) => {
        if (deletionDraftId === null) {
          if (!forceCreate) return;
          deletionDraftId = captureOrphanedDraft(workspaceId, path, text);
        } else {
          replaceOrphanedDraft(workspaceId, path, deletionDraftId, text);
        }
        setDeletion(deletionDraftId);
      },
      "write a recovery draft after deletion",
    );
  };

  const captureDeletion = (doc: Y.Doc): void => {
    writesRefused.current = true;
    deletionDocument = doc;
    const bytes = Y.encodeStateAsUpdate(doc);
    deletionSnapshotBytes = bytes;
    const forceCreate = saveStateRef.current !== "saved";
    if (forceCreate) {
      deletionDraftId = captureOrphanedDraft(
        workspaceId,
        path,
        durableMarkdownFromSnapshot(doc, bytes),
      );
    }
    setDeletion(deletionDraftId);
    reportSaveState("deleted");
    enqueueDeletionSnapshot(doc, bytes, forceCreate);
  };

  const recoveryDraftId = (source: Y.Doc): number | null => {
    if (source === deletionDocument) return deletionDraftId;
    return recoveryDraftIds.get(source) ?? null;
  };

  const setRecoveryDraftId = (source: Y.Doc, draftId: number): void => {
    if (source === deletionDocument) {
      deletionDraftId = draftId;
    } else {
      recoveryDraftIds.set(source, draftId);
    }
  };

  const captureUndeliveredSnapshot = (
    bytes: Uint8Array,
    _error: unknown,
    source: Y.Doc,
  ): void => {
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, bytes);
    const fallback = durableMarkdownFromSnapshot(rebuilt, bytes);
    rebuilt.destroy();
    let draftId = recoveryDraftId(source);
    if (draftId === null) {
      draftId = captureOrphanedDraft(workspaceId, path, fallback);
      setRecoveryDraftId(source, draftId);
    } else {
      replaceOrphanedDraft(workspaceId, path, draftId, fallback);
    }
    if (
      deletionSnapshotBytes === null &&
      saveStateRef.current !== "read-only"
    ) {
      reportSaveState("error");
    }
    const capturedDraftId = draftId;
    enqueueRefinement(
      source,
      bytes,
      (text) => replaceOrphanedDraft(workspaceId, path, capturedDraftId, text),
      "refine the recovery draft after update delivery failed",
    );
  };

  const refreshDeletionDraft = (doc: Y.Doc): void => {
    if (doc !== deletionDocument) return;
    if (deletionSnapshotBytes === null) return;
    const bytes = Y.encodeStateAsUpdate(doc);
    if (snapshotsEqual(bytes, deletionSnapshotBytes)) return;
    deletionSnapshotBytes = bytes;
    enqueueDeletionSnapshot(doc, bytes, true);
  };

  const observeSaveState = (doc: Y.Doc): void => {
    detachSaveObserver?.();
    const onUpdate = () => {
      if (disposed) return;
      if (writesRefused.current) {
        refreshDeletionDraft(doc);
        return;
      }
      reportSaveState("saving");
    };
    doc.on("update", onUpdate);
    detachSaveObserver = () => doc.off("update", onUpdate);
  };

  const preserveRetiredDocument = (retired: Y.Doc): void => {
    writesRefused.current = true;
    detachSaveObserver?.();
    detachSaveObserver = null;
    const persist = (): void => {
      const bytes = Y.encodeStateAsUpdate(retired);
      const fallback = durableMarkdownFromSnapshot(retired, bytes);
      let draftId = recoveryDraftId(retired);
      if (draftId === null) {
        draftId = captureOrphanedDraft(workspaceId, path, fallback);
        setRecoveryDraftId(retired, draftId);
      } else {
        replaceOrphanedDraft(workspaceId, path, draftId, fallback);
      }
      const capturedDraftId = draftId;
      enqueueRefinement(
        retired,
        bytes,
        (markdown) =>
          replaceOrphanedDraft(workspaceId, path, capturedDraftId, markdown),
        "refine the recovery draft after lineage replacement",
      );
    };
    if (saveStateRef.current !== "saved" || deliveryPending) persist();
    const onRetiredUpdate = () => persist();
    retired.on("update", onRetiredUpdate);
    retiredDraftObservers.set(retired, () => retired.off("update", onRetiredUpdate));
    clearOutcome();
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
      if (deletionSnapshotBytes !== null) {
        refreshDeletionDraft(doc);
        return;
      }
      captureDeletion(doc);
      return;
    }
    if (writesRefused.current) return;
    if (event.state === "saved") {
      if (deliveryPending) {
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
    if (
      event.state === "error" ||
      event.state === "read-only" ||
      event.state === "changed-on-disk"
    ) {
      reportSaveState(event.state);
      return;
    }
    if (event.state === "settling") {
      reportSaveState("saving");
      return;
    }
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
          const bound = await bindEngineYDoc(transport, {
            onDeliveryFailure: captureUndeliveredSnapshot,
            onDeliveryPendingChange,
            onDocumentReplacing: preserveRetiredDocument,
          });
          binding = bound;
          if (disposed) {
            await destroyBinding();
            return;
          }

          // Warm the deletion projection without delaying the open result.
          void loadProjectionModule();
          if (!bound.available || !bound.doc) {
            if (bound.notInVersion) {
              setOutcome({ kind: "not-in-version" });
            } else if (bound.engineMayHoldDocument) {
              setOutcome({ kind: "engine-may-hold-document" });
            } else if (bound.removalInProgress) {
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
            if (!deletionPending && deletionSnapshotBytes === null) {
              writesRefused.current = false;
            }
            if (!writesRefused.current && !deliveryPending) {
              reportSaveState("saved");
            }
            observeSaveState(replacement);
            setOutcome({ token, kind: "bound", doc: replacement });
          });
          const doc = bound.doc;
          observeSaveState(doc);
          if (deletionPending) captureDeletion(doc);
          setOutcome({ token, kind: "bound", doc });
        } catch {
          if (!disposed) {
            setOutcome({ kind: "unavailable" });
          }
        }
      })();
    },
    dispose() {
      if (disposePromise) return disposePromise;

      if (binding?.doc) refreshDeletionDraft(binding.doc);
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
        // A deletion projection can outlive React cleanup. Production must
        // retain that recovery write; tests also need a join point before they
        // reset the process-wide recovery store.
        await deletionQueue;
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
  let snapshot: EngineDocLeaseSnapshot = {
    key: requestKey,
    outcome: null,
    saveState: "saved",
    deletion: null,
  };
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
      publish({
        key: nextRequestKey,
        outcome: null,
        saveState: "saved",
        deletion: null,
      });

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
    // Re-open only when the workspace, path, gate, retry, or active version
    // changes. Other renders keep the same shared lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.workspaceId, input.path, input.enabled, input.reopenKey, input.retryKey]);

  // Derive this during render. A result for an earlier request never grants
  // one editable frame while a version, path, gate, or retry request changes.
  const settled =
    leaseState?.requestKey === requestKey ? leaseState.snapshot : null;
  const outcome = settled?.outcome ?? null;
  const available = outcome?.kind === "bound";
  const doc = outcome?.kind === "bound" ? outcome.doc : null;
  const opening = input.enabled && outcome === null;
  const notInVersion = outcome?.kind === "not-in-version";
  const engineMayHoldDocument =
    outcome?.kind === "engine-may-hold-document";
  const removalInProgress =
    outcome?.kind === "removal-in-progress" ? outcome.removal : null;
  const deletedWhileEditing =
    outcome?.kind === "bound" &&
    settled?.deletion?.token === outcome.token;
  const deletedDraftId = deletedWhileEditing
    ? (settled?.deletion?.draftId ?? null)
    : null;

  return {
    available,
    opening,
    doc,
    saveState: settled?.saveState ?? "saved",
    notInVersion,
    engineMayHoldDocument,
    deletedWhileEditing,
    deletedDraftId,
    removalInProgress,
  };
}
