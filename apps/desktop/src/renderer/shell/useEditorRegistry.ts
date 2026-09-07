import { useCallback, useMemo, useRef, useState } from "react";
import type { DraftFlush, DraftFlushOptions } from "../useAutosavedTextDraft";
import type { FileSaveState } from "../fileInspectorUi";
import { beginCollectionLineageOperation } from "../collections/collectionLineageGate";
import type { ActiveUndoHandler } from "../workbench/EngineMomentDiffPage";
import type { TreeChangeOperation } from "../workbench/Explorer";
import type { WorkbenchTab } from "../workbench/workbenchState";

type MountedEditorRegistration = {
  tab: WorkbenchTab;
  flush?: DraftFlush;
  sourceToggle?: () => void;
  undo?: ActiveUndoHandler;
};

type EditorRegistrationCallbacks = {
  onSaveStateChange: (state: FileSaveState) => void;
  registerDraftFlush: (flush: DraftFlush | null) => void;
  registerSourceToggle: (toggle: (() => void) | null) => void;
  registerActiveUndo: (handler: ActiveUndoHandler | null) => void;
};

export function useEditorRegistry(
  workspaceId: string,
  openTabs: readonly WorkbenchTab[],
) {
  // Mounted editors are group-scoped. A split keeps every active surface
  // mounted, so a singleton flush/source/undo slot would let either pane
  // overwrite the other and could discard the surviving pane during cleanup.
  const mountedEditorsRef = useRef(new Map<string, MountedEditorRegistration>());
  const editorCallbacksRef = useRef(
    new WeakMap<WorkbenchTab, Map<string, EditorRegistrationCallbacks>>(),
  );
  const dirtyTabsRef = useRef(new WeakSet<WorkbenchTab>());
  const dirtyEpochsRef = useRef(new WeakMap<WorkbenchTab, number>());
  const [dirtyRevision, setDirtyRevision] = useState(0);
  // An Explorer operation retains every closure that is current while its
  // disk mutation is active. This keeps late drafts tied to the editor that
  // created them, including editors in inactive groups.
  const draftOperationScopesRef = useRef(
    new Set<{ flushes: Set<DraftFlush> }>(),
  );
  const callbacksForEditor = useCallback(
    (groupId: string, tab: WorkbenchTab): EditorRegistrationCallbacks => {
      let byGroup = editorCallbacksRef.current.get(tab);
      if (!byGroup) {
        byGroup = new Map();
        editorCallbacksRef.current.set(tab, byGroup);
      }
      const cached = byGroup.get(groupId);
      if (cached) return cached;

      const updateRegistration = <K extends keyof Omit<MountedEditorRegistration, "tab">>(
        key: K,
        value: MountedEditorRegistration[K] | null,
      ) => {
        const current = mountedEditorsRef.current.get(groupId);
        if (value === null) {
          if (current?.tab !== tab) return;
          const next = { ...current };
          delete next[key];
          if (!next.flush && !next.sourceToggle && !next.undo) {
            mountedEditorsRef.current.delete(groupId);
          } else {
            mountedEditorsRef.current.set(groupId, next);
          }
          return;
        }
        const next = current?.tab === tab ? { ...current } : { tab };
        next[key] = value;
        mountedEditorsRef.current.set(groupId, next);
      };
      const callbacks: EditorRegistrationCallbacks = {
        onSaveStateChange: (state) => {
          const dirty = state !== "saved" && state !== "deleted";
          if (dirty === dirtyTabsRef.current.has(tab)) return;
          if (dirty) {
            dirtyTabsRef.current.add(tab);
            dirtyEpochsRef.current.set(
              tab,
              (dirtyEpochsRef.current.get(tab) ?? 0) + 1,
            );
          } else {
            dirtyTabsRef.current.delete(tab);
          }
          setDirtyRevision((revision) => revision + 1);
        },
        registerDraftFlush: (flush) => {
          if (flush === null && dirtyTabsRef.current.delete(tab)) {
            setDirtyRevision((revision) => revision + 1);
          }
          updateRegistration("flush", flush);
          if (flush) {
            for (const scope of draftOperationScopesRef.current) {
              scope.flushes.add(flush);
            }
          }
        },
        registerSourceToggle: (toggle) => updateRegistration("sourceToggle", toggle),
        registerActiveUndo: (handler) => updateRegistration("undo", handler),
      };
      byGroup.set(groupId, callbacks);
      return callbacks;
    },
    [],
  );
  const flushStableDrafts = useCallback(
    async (
      shouldFlush: (groupId: string, tab: WorkbenchTab) => boolean = () => true,
    ) => {
      const flushedAtEpoch = new Map<DraftFlush, number>();
      while (true) {
        const batch = [...mountedEditorsRef.current.entries()]
          .filter(
            ([groupId, registration]) =>
              registration.flush &&
              (flushedAtEpoch.get(registration.flush) ?? -1) <
                (dirtyEpochsRef.current.get(registration.tab) ?? 0) &&
              shouldFlush(groupId, registration.tab),
          )
          .map(([, registration]) => ({
            flush: registration.flush as DraftFlush,
            epoch: dirtyEpochsRef.current.get(registration.tab) ?? 0,
          }));
        if (batch.length === 0) return;
        for (const { flush, epoch } of batch) {
          flushedAtEpoch.set(flush, epoch);
          await flush();
        }
      }
    },
    [],
  );
  const hasDrafts = useCallback(
    (predicate: (groupId: string, tab: WorkbenchTab) => boolean) =>
      [...mountedEditorsRef.current.entries()].some(
        ([groupId, registration]) =>
          Boolean(registration.flush) && predicate(groupId, registration.tab),
      ),
    [],
  );
  const undoForEditor = useCallback(
    (groupId: string) => mountedEditorsRef.current.get(groupId)?.undo,
    [],
  );
  const toggleSource = useCallback(
    (groupId: string) => mountedEditorsRef.current.get(groupId)?.sourceToggle?.(),
    [],
  );
  // Version switches, merges, and moment restores are workspace-wide lineage
  // changes: every mounted draft and queued collection write must settle
  // first, and no cell edit may be accepted while the change is in flight.
  // The caller holds the returned release across its IPCs.
  const beginLineageOperation = useCallback(
    () => beginCollectionLineageOperation(workspaceId, flushStableDrafts),
    [flushStableDrafts, workspaceId],
  );
  const beginDraftOperation = useCallback(async (): Promise<TreeChangeOperation> => {
    const scope = { flushes: new Set<DraftFlush>() };
    for (const registration of mountedEditorsRef.current.values()) {
      if (registration.flush) scope.flushes.add(registration.flush);
    }
    draftOperationScopesRef.current.add(scope);

    // A queued collection cell write names its record by PATH, which the
    // caller's move is about to change. The gate pauses new cell acceptance
    // for the whole operation and drains the queue — flushing drafts only
    // settles mounted editors — and refuses the operation over a retained
    // failure, whose retry would otherwise land on the vacated path.
    let releaseCollectionWrites: () => void;
    try {
      releaseCollectionWrites = await beginCollectionLineageOperation(
        workspaceId,
        flushStableDrafts,
      );
    } catch (error) {
      draftOperationScopesRef.current.delete(scope);
      throw error;
    }

    let settlement: Promise<void> | null = null;
    const settle = (options?: DraftFlushOptions) => {
      if (settlement) return settlement;
      settlement = (async () => {
        const drained = new Set<DraftFlush>();
        let firstError: unknown;
        let failed = false;
        try {
          while (true) {
            const batch = [...scope.flushes].filter(
              (flush) => !drained.has(flush),
            );
            if (batch.length === 0) break;
            for (const flush of batch) {
              drained.add(flush);
              try {
                await flush(options);
              } catch (error) {
                if (!failed) {
                  failed = true;
                  firstError = error;
                }
              }
            }
          }
        } finally {
          draftOperationScopesRef.current.delete(scope);
        }
        if (failed) throw firstError;
      })();
      return settlement;
    };
    return { settle, release: releaseCollectionWrites };
  }, [flushStableDrafts, workspaceId]);

  const dirtyPaths = useMemo(
    () =>
      new Set(
        openTabs
          .filter((tab) => dirtyTabsRef.current.has(tab))
          .map((tab) => tab.path),
      ),
    [dirtyRevision, openTabs],
  );

  return {
    callbacksForEditor,
    dirtyPaths,
    hasDrafts,
    flushStableDrafts,
    undoForEditor,
    toggleSource,
    beginLineageOperation,
    beginDraftOperation,
  };
}
