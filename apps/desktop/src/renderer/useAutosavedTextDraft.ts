import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { captureOrphanedDraft, useOrphanedDrafts } from "./orphanedDrafts";
import type { SharedLocalDocument } from "./sharedLocalDocument";

export function publishOwnedUnmountDraft(
  buffer: SharedLocalDocument,
  body: string,
  source: object,
): void {
  const current = buffer.getSnapshot();
  if (current.source !== null && current.source !== source) return;
  buffer.publishDraft(body, source);
}

export type SaveState = "saved" | "saving" | "error";

export type DraftFlushOptions = { captureOnFailure?: boolean };

export type DraftFlush = (options?: DraftFlushOptions) => Promise<void>;

// The plain-text autosave, used by every NON-markdown editable view (CSV,
// JSON, text). It carries the same three write seams as MarkdownView — an
// armed timer, an unmount flush, and the shell's flush — and until #579's
// adversarial review it carried none of the opening gate, because `opening`
// only ever existed inside MarkdownView. A version switch bumps `reopenKey`,
// the reread it triggers leaves the PRE-switch body on screen, and the armed
// timer landed that body on the POST-switch tree. That is the exact
// mechanism on the surfaces #567 never covered.
//
// Every gate here reads a REF at call time, never a prop. Routing the signal
// through `disabled` (or any dep) is actively worse: the unmount-flush effect
// would re-run on the flip, and its previous cleanup — whose closure still
// says writes are allowed — would issue the very write the flip was meant to
// stop.
export function useAutosavedTextDraft(props: {
  body: string;
  contentHash: string | null;
  contentRequestId: number;
  contentReadTicket: number;
  latestContentRequestId: number;
  workspaceId: string;
  path: string;
  disabled?: boolean;
  // Bumped when the active version changes. The transition sets a pending
  // draft aside exactly as MarkdownView's render-phase capture does.
  reopenKey?: number;
  // Reactive wake signal for the reread landing. The shared ref below remains
  // armed until this hook applies the landed body.
  switchReadPending: boolean;
  switchUnresyncedRef: { current: boolean };
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  refreshAfterConflict: () => void;
  localBuffer: SharedLocalDocument;
}) {
  const [draft, setDraft] = useState(props.body);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [writerSettledEpoch, setWriterSettledEpoch] = useState(0);
  const localSource = useRef<object>({});
  const activeLocalBuffer = useRef(props.localBuffer);
  activeLocalBuffer.current = props.localBuffer;
  const sharedSnapshot = useSyncExternalStore(
    props.localBuffer.subscribe,
    props.localBuffer.getSnapshot,
    props.localBuffer.getSnapshot,
  );
  const sharedRevision = useRef<{
    buffer: SharedLocalDocument;
    revision: number;
  } | null>(null);
  const orphanedDrafts = useOrphanedDrafts(props.workspaceId, props.path);
  const latestDraft = useRef(props.body);
  const baseContentRequestId = useRef(props.contentRequestId);
  const latestSnapshot = useRef({
    body: props.body,
    contentHash: props.contentHash,
    requestId: props.contentRequestId,
    readTicket: props.contentReadTicket,
  });
  latestSnapshot.current = {
    body: props.body,
    contentHash: props.contentHash,
    requestId: props.contentRequestId,
    readTicket: props.contentReadTicket,
  };
  const latestContentRequestId = useRef(props.latestContentRequestId);
  latestContentRequestId.current = props.latestContentRequestId;
  const acceptedRequestFloor = useRef(0);
  const staleBaseline = useRef(false);
  const flushConflict = useRef(false);
  const conflictContentHash = useRef<string | null>(null);
  const conflictRequestId = useRef(0);
  const conflictRefreshRequestId = useRef<number | null>(null);
  const verifyAfterRequestId = useRef<number | null>(null);
  const editGeneration = useRef(0);
  const blockedEditGeneration = useRef(-1);
  const capturedConflictDraft = useRef<string | null>(null);
  const conflictDraftId = useRef<number | null>(null);
  const unmounted = useRef(false);
  // Only accepted external values advance this revision. Local draft echoes
  // must not make CodeMirror replay an older controlled value.
  const valueRevision = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsavedDraft = useRef(false);
  // One tail owns every writer that has entered, including writers waiting
  // behind an in-flight save. The shell flush can therefore join the whole
  // obligation instead of observing only the write that currently holds it.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const writersLive = useRef(0);
  const flushBarrier = useRef(false);
  const flushInFlight = useRef<Promise<void> | null>(null);

  // Assigned during render, read at call time — `readOnlyRef` precedent.
  const disabledRef = useRef(props.disabled);
  disabledRef.current = props.disabled;
  const switchReadPendingRef = useRef(props.switchReadPending);
  switchReadPendingRef.current = props.switchReadPending;
  const writesBlocked = () =>
    disabledRef.current === true ||
    props.switchUnresyncedRef.current === true ||
    staleBaseline.current;

  useEffect(() => {
    if (
      !sharedSnapshot.initialized ||
      (sharedRevision.current?.buffer === props.localBuffer &&
        sharedRevision.current.revision === sharedSnapshot.revision)
    ) {
      return;
    }
    sharedRevision.current = {
      buffer: props.localBuffer,
      revision: sharedSnapshot.revision,
    };
    const bodyChanged = latestDraft.current !== sharedSnapshot.body;
    latestDraft.current = sharedSnapshot.body;
    setSaveState(sharedSnapshot.saveState);
    if (
      sharedSnapshot.saveState === "saved" &&
      !sharedSnapshot.dirty &&
      !bodyChanged
    ) {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      unsavedDraft.current = false;
    }
    if (
      sharedSnapshot.source === localSource.current ||
      !bodyChanged
    ) {
      return;
    }
    valueRevision.current += 1;
    setDraft(sharedSnapshot.body);
  }, [sharedSnapshot]);

  function captureLatestConflictDraft(text = latestDraft.current) {
    if (capturedConflictDraft.current === text) return;
    conflictDraftId.current = captureOrphanedDraft(
      props.workspaceId,
      props.path,
      text,
    );
    capturedConflictDraft.current = text;
  }

  function captureFailedFlush() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    unsavedDraft.current = false;
    blockedEditGeneration.current = Math.max(
      blockedEditGeneration.current,
      editGeneration.current,
    );
    captureLatestConflictDraft();
    if (!unmounted.current) setSaveState("error");
  }

  function acceptSnapshot(
    snapshot: {
      body: string;
      contentHash: string | null;
      requestId: number;
      readTicket: number;
    },
    state: SaveState,
  ): boolean {
    if (
      !props.localBuffer.acceptRead(
        snapshot.body,
        snapshot.contentHash,
        localSource.current,
        state === "error",
        snapshot.readTicket,
      )
    ) {
      const current = props.localBuffer.getSnapshot();
      if (
        activeLocalBuffer.current === props.localBuffer &&
        props.switchUnresyncedRef.current &&
        !switchReadPendingRef.current &&
        current.initialized &&
        current.contentHash === snapshot.contentHash
      ) {
        props.switchUnresyncedRef.current = false;
      }
      return false;
    }
    sharedRevision.current = {
      buffer: props.localBuffer,
      revision: props.localBuffer.getSnapshot().revision,
    };
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (staleBaseline.current && unsavedDraft.current) {
      captureLatestConflictDraft();
    }
    unsavedDraft.current = false;
    blockedEditGeneration.current = Math.max(
      blockedEditGeneration.current,
      editGeneration.current,
    );
    staleBaseline.current = false;
    baseContentRequestId.current = snapshot.requestId;
    if (
      verifyAfterRequestId.current !== null &&
      snapshot.requestId > verifyAfterRequestId.current
    ) {
      verifyAfterRequestId.current = null;
    }
    acceptedRequestFloor.current = Math.max(
      acceptedRequestFloor.current,
      snapshot.requestId,
    );
    if (latestDraft.current !== snapshot.body) valueRevision.current += 1;
    setDraft(snapshot.body);
    latestDraft.current = snapshot.body;
    setSaveState(state);
    props.switchUnresyncedRef.current = false;
    return true;
  }

  function acceptConflictSnapshotIfCurrent(): boolean {
    const snapshot = latestSnapshot.current;
    const shared = props.localBuffer.getSnapshot();
    if (
      (snapshot.contentHash !== conflictContentHash.current &&
        snapshot.requestId <= conflictRequestId.current) ||
      (shared.initialized &&
        !shared.dirty &&
        shared.contentHash !== snapshot.contentHash)
    ) {
      return false;
    }
    return acceptSnapshot(snapshot, "error");
  }

  function reconcileConflictSnapshot() {
    if (acceptConflictSnapshotIfCurrent()) return;
    const shared = props.localBuffer.getSnapshot();
    if (
      shared.dirty &&
      (shared.source !== localSource.current || writersLive.current > 0)
    ) {
      return;
    }
    const requestId = latestSnapshot.current.requestId;
    if (conflictRefreshRequestId.current === requestId) return;
    conflictRefreshRequestId.current = requestId;
    props.refreshAfterConflict();
  }

  useEffect(() => {
    props.onSaveStateChange?.(saveState);
  }, [saveState, props.onSaveStateChange]);

  useEffect(() => {
    const id = conflictDraftId.current;
    if (!flushConflict.current || staleBaseline.current || id === null) return;
    if (orphanedDrafts.some((draft) => draft.id === id)) return;
    conflictDraftId.current = null;
    capturedConflictDraft.current = null;
    flushConflict.current = false;
    setSaveState("saved");
  }, [orphanedDrafts, saveState, props.contentRequestId]);

  useEffect(() => {
    if (props.switchReadPending) return;
    if (staleBaseline.current) {
      reconcileConflictSnapshot();
      return;
    }
    if (
      verifyAfterRequestId.current !== null &&
      latestSnapshot.current.requestId <= verifyAfterRequestId.current
    ) {
      return;
    }
    if (unsavedDraft.current) return;
    if (writersLive.current > 0) return;
    if (props.contentRequestId <= acceptedRequestFloor.current) return;
    acceptSnapshot(latestSnapshot.current, "saved");
    // acceptSnapshot reads mutable write state and the exact body/hash pair
    // above. The dependencies name the authoritative snapshot identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.body,
    props.contentHash,
    props.contentRequestId,
    props.path,
    sharedSnapshot,
    props.switchReadPending,
    props.switchUnresyncedRef,
    writerSettledEpoch,
  ]);

  // Cancel-and-restore, during the render that first sees the new version
  // (#567, extended to these views by the adversarial review). The armed
  // write would land the previous version's text on the tree the switch just
  // bound; dropping it silently would lose keystrokes. So it is set aside into
  // the same store the markdown notice reads, and the surface goes back to the
  // document.
  const reopenKeyRef = useRef(props.reopenKey);
  const wasRefused = useRef(props.switchReadPending);
  // Two moments, one transition: the switch itself, and the reread landing
  // with something typed while writes were refused. Both leave a draft built
  // on the version the user has left.
  const refusalLifted =
    wasRefused.current === true && props.switchReadPending !== true;
  wasRefused.current = props.switchReadPending;
  if (props.reopenKey !== reopenKeyRef.current || refusalLifted) {
    reopenKeyRef.current = props.reopenKey;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (unsavedDraft.current) {
      unsavedDraft.current = false;
      captureOrphanedDraft(props.workspaceId, props.path, latestDraft.current);
      let resyncBody = props.body;
      let resyncSaveState: SaveState = "saved";
      if (refusalLifted) {
        // A duplicate pane whose read landed first can already have published
        // an edit built on this version. That draft owns the shared buffer,
        // and resetting to the disk snapshot would discard it — the same
        // ownership rule the markdown resync applies.
        const sharedBeforeResync = props.localBuffer.getSnapshot();
        const peerDraftPending =
          sharedBeforeResync.dirty &&
          sharedBeforeResync.source !== localSource.current;
        if (peerDraftPending) {
          resyncBody = sharedBeforeResync.body;
          resyncSaveState = sharedBeforeResync.saveState;
        } else {
          props.localBuffer.reset(
            props.body,
            props.contentHash,
            localSource.current,
          );
        }
      }
      valueRevision.current += 1;
      setSaveState(resyncSaveState);
      setDraft(resyncBody);
      latestDraft.current = resyncBody;
      baseContentRequestId.current = props.contentRequestId;
      acceptedRequestFloor.current = Math.max(
        acceptedRequestFloor.current,
        props.contentRequestId,
      );
    }
  }

  async function writeDraftNow(
    options: {
      rejectOnError?: boolean;
      fromFlush?: boolean;
      textSnapshot?: string;
      captureOnFailure?: boolean;
      releaseUnusedDraft?: boolean;
    } = {},
  ): Promise<void> {
    if (flushBarrier.current && !options.fromFlush) {
      if (options.captureOnFailure && options.textSnapshot !== undefined) {
        captureLatestConflictDraft(options.textSnapshot);
        if (options.releaseUnusedDraft) props.localBuffer.releaseUnusedDraft();
      }
      return;
    }
    const enteredEditGeneration = editGeneration.current;
    const run = async (): Promise<void> => {
      if (
        enteredEditGeneration <= blockedEditGeneration.current &&
        !props.localBuffer.getSnapshot().dirty
      ) {
        return;
      }
      const current = props.localBuffer.getSnapshot();
      if (
        activeLocalBuffer.current === props.localBuffer &&
        props.switchUnresyncedRef.current &&
        !switchReadPendingRef.current &&
        current.initialized &&
        current.contentHash === latestSnapshot.current.contentHash
      ) {
        props.switchUnresyncedRef.current = false;
      }
      if (writesBlocked()) {
        if (props.localBuffer.getSnapshot().dirty) {
          props.localBuffer.markError();
        }
        if (options.captureOnFailure && options.textSnapshot !== undefined) {
          captureLatestConflictDraft(options.textSnapshot);
          if (options.releaseUnusedDraft) props.localBuffer.releaseUnusedDraft();
        }
        return;
      }
      if (options.textSnapshot !== undefined) {
        publishOwnedUnmountDraft(
          props.localBuffer,
          options.textSnapshot,
          localSource.current,
        );
      }
      const issuedBaseRequestId = baseContentRequestId.current;
      unsavedDraft.current = false;
      if (!unmounted.current) setSaveState("saving");
      let issuedText: string | null = null;
      try {
        const writing = props.localBuffer.write(
          localSource.current,
          (text, expectedContentHash) => {
            issuedText = text;
            return bridge().writeWorkspaceText({
              workspaceId: props.workspaceId,
              relativePath: props.path,
              text,
              expectedContentHash,
            });
          },
        );
        if (options.releaseUnusedDraft) props.localBuffer.releaseUnusedDraft();
        const result = await writing;
        if (activeLocalBuffer.current !== props.localBuffer) {
          if (result.status === "conflict" || result.status === "no-baseline") {
            captureOrphanedDraft(props.workspaceId, props.path, result.body);
          }
          return;
        }
        const text = result.body;
        latestDraft.current = props.localBuffer.getSnapshot().body;
        if (result.status === "skipped") {
          if (!unmounted.current) setSaveState("saved");
          return;
        }
        if (result.status === "no-baseline") {
          unsavedDraft.current = true;
          if (options.captureOnFailure && options.textSnapshot !== undefined) {
            captureLatestConflictDraft(options.textSnapshot);
          }
          if (!unmounted.current) setSaveState("error");
          if (options.rejectOnError) {
            throw new Error("dohc cannot save this draft without a content hash.");
          }
          return;
        }
        if (result.status === "conflict") {
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          staleBaseline.current = true;
          flushConflict.current = true;
          conflictContentHash.current = result.currentContentHash;
          conflictRequestId.current = latestSnapshot.current.requestId;
          blockedEditGeneration.current = Math.max(
            blockedEditGeneration.current,
            editGeneration.current,
          );
          unsavedDraft.current = false;
          captureLatestConflictDraft();
          if (!unmounted.current) {
            setSaveState("error");
            reconcileConflictSnapshot();
          }
          if (options.rejectOnError) {
            throw new Error("The file changed on disk while dohc saved it.");
          }
          return;
        }
        acceptedRequestFloor.current = Math.max(
          acceptedRequestFloor.current,
          issuedBaseRequestId,
        );
        if (latestContentRequestId.current > issuedBaseRequestId) {
          verifyAfterRequestId.current = latestContentRequestId.current;
          if (!unmounted.current) {
            setSaveState("saving");
            props.refreshAfterConflict();
          }
          return;
        }
        // A user can keep typing while this write is in flight. Never repaint
        // that newer draft with the older text that just reached disk.
        if (!unmounted.current && latestDraft.current === text) {
          setDraft(text);
          setSaveState("saved");
        }
      } catch (error) {
        if (activeLocalBuffer.current !== props.localBuffer) {
          if (issuedText !== null) {
            captureOrphanedDraft(props.workspaceId, props.path, issuedText);
          }
          if (options.rejectOnError) throw error;
          return;
        }
        unsavedDraft.current = true;
        if (options.captureOnFailure && options.textSnapshot !== undefined) {
          captureLatestConflictDraft(options.textSnapshot);
        }
        if (!unmounted.current) setSaveState("error");
        if (options.rejectOnError) throw error;
      }
    };
    const runsNow = writersLive.current === 0;
    writersLive.current += 1;
    const queued = (runsNow ? run() : writeChain.current.then(run)).finally(
      () => {
        writersLive.current -= 1;
        if (!unmounted.current) setWriterSettledEpoch((epoch) => epoch + 1);
      },
    );
    writeChain.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function saveNow(): Promise<void> {
    await writeDraftNow();
  }

  function scheduleSave(next: string) {
    setDraft(next);
    latestDraft.current = next;
    props.localBuffer.publishDraft(next, localSource.current);
    editGeneration.current += 1;
    // Deliberately not gated on writesBlocked(): swallowing the keystroke here
    // would lose it silently when the reread lands and the sync effect
    // repaints. It arms as normal, the write seams refuse it, and the capture
    // below sets it aside when the refusal lifts.
    if (disabledRef.current === true) return;
    unsavedDraft.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 800);
  }

  const { workspaceId, path, registerDraftFlush, localBuffer } = props;
  useEffect(() => {
    unmounted.current = false;
    const retireAfterSettlement = () => {
      localBuffer.retireCapturedDraft(localSource.current);
      localBuffer.releaseUnusedDraft();
      void localBuffer.settled().then(() => {
        localBuffer.retireCapturedDraft(localSource.current);
        localBuffer.releaseUnusedDraft();
      });
    };
    return () => {
      unmounted.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!unsavedDraft.current) {
        if (writersLive.current > 0) {
          void writeChain.current.then(() => {
            // A replacement effect means the component is still mounted on a
            // different buffer. Its refs now belong to that version; only
            // settle this cleanup's captured buffer.
            if (activeLocalBuffer.current !== localBuffer) {
              retireAfterSettlement();
              return;
            }
            if (unsavedDraft.current) {
              unsavedDraft.current = false;
              captureOrphanedDraft(workspaceId, path, latestDraft.current);
            }
            retireAfterSettlement();
          });
        } else {
          // A version-switch render can move the draft into recovery before
          // this buffer-scoped cleanup runs. Retire only this pane's work on
          // the buffer the effect captured; the replacement version may
          // already contain a peer draft.
          retireAfterSettlement();
        }
        return;
      }
      // A pending draft that cannot be written is SET ASIDE, never dropped.
      // A reread that rejects selects the error
      // branch while the refusal stays live, so this view is gone before a
      // later success can let it act on the lift. Capturing here needs nothing
      // to survive: it is the last moment this draft exists.
      const current = localBuffer.getSnapshot();
      if (
        activeLocalBuffer.current === localBuffer &&
        props.switchUnresyncedRef.current &&
        !switchReadPendingRef.current &&
        current.initialized &&
        current.contentHash === latestSnapshot.current.contentHash
      ) {
        props.switchUnresyncedRef.current = false;
      }
      if (writesBlocked()) {
        unsavedDraft.current = false;
        captureOrphanedDraft(workspaceId, path, latestDraft.current);
        retireAfterSettlement();
        return;
      }
      const text = latestDraft.current;
      const operationSettlement = flushInFlight.current;
      void writeDraftNow({
        textSnapshot: text,
        captureOnFailure: true,
        releaseUnusedDraft: true,
      }).then(() => {
        if (operationSettlement) {
          void operationSettlement.then(
            retireAfterSettlement,
            retireAfterSettlement,
          );
        } else {
          retireAfterSettlement();
        }
      });
    };
    // `disabled` is deliberately not a dep: as one it made every flip run this
    // cleanup with the previous render's value captured, so turning writes off
    // was itself a write (the lesson, and the adversarial review found
    // the same trap waiting here). The ref carries the current value to a real
    // unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path, localBuffer]);

  useEffect(() => {
    if (!registerDraftFlush) return;
    registerDraftFlush((options) => {
      if (flushInFlight.current) {
        const inFlight = flushInFlight.current;
        if (!options?.captureOnFailure) return inFlight;
        return inFlight.catch((error) => {
          captureFailedFlush();
          throw error;
        });
      }
      flushBarrier.current = true;
      const localWritePending = writersLive.current > 0;
      const flush = (async () => {
        try {
          await writeChain.current;
          if (!localWritePending) await props.localBuffer.settled();
          if (flushConflict.current) {
            throw new Error("The file changed on disk while dohc saved it.");
          }
          while (
            (unsavedDraft.current || props.localBuffer.getSnapshot().dirty) &&
            !writesBlocked()
          ) {
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
            await writeDraftNow({ rejectOnError: true, fromFlush: true });
          }
          if (flushConflict.current) {
            throw new Error("The file changed on disk while dohc saved it.");
          }
        } catch (error) {
          if (options?.captureOnFailure) captureFailedFlush();
          throw error;
        } finally {
          flushBarrier.current = false;
          flushInFlight.current = null;
        }
      })();
      flushInFlight.current = flush;
      return flush;
    });
    return () => registerDraftFlush(null);
    // writeDraftNow uses refs for the draft; workspace/path are stable per keyed inspector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush]);

  return {
    draft,
    saveState,
    setDraft: scheduleSave,
    saveNow,
    getDraft: () => latestDraft.current,
    valueRevision: valueRevision.current,
  };
}
