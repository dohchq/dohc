import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { DohcDesktopBridge, SetAsideDraftChange } from "../ipc/bridgeContract";
import { movedSetAsideDraft } from "../workspaces/movedSetAsideDraft";

type DraftFileCalls = Pick<
  DohcDesktopBridge,
  | "listSetAsideDrafts"
  | "writeSetAsideDraft"
  | "removeSetAsideDraft"
  | "moveSetAsideDrafts"
  | "onSetAsideDraftChanged"
>;

export function draftFilesForTests() {
  const files = new Map<string, string>();
  const listeners = new Set<(change: SetAsideDraftChange) => void>();
  let failure: { error: Error; when: (raw: string) => boolean } | null = null;
  const queue: (() => void)[] = [];
  let holds = 0;
  const emit = (change: SetAsideDraftChange) => {
    for (const listener of [...listeners]) listener(change);
  };
  const set = (key: string, raw: string) => {
    files.set(key, raw);
    emit({ key, raw });
  };
  const remove = (key: string) => {
    if (files.delete(key)) emit({ key, raw: null });
  };
  const drain = () => {
    while (holds === 0 && queue.length > 0) queue.shift()!();
  };
  const inOrder = <T>(step: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        try {
          resolve(step());
        } catch (error) {
          reject(error);
        }
      });
      drain();
    });
  const refuse = (raw: string) => {
    if (failure?.when(raw)) throw failure.error;
  };
  const calls: DraftFileCalls = {
    listSetAsideDrafts: (_payload) => inOrder(() => [...files].map(([key, raw]) => ({ key, raw }))),
    writeSetAsideDraft: ({ key, raw, ifCurrent }) =>
      inOrder(() => {
        refuse(raw);
        if ((files.get(key) ?? null) !== ifCurrent) return false;
        set(key, raw);
        return true;
      }),
    removeSetAsideDraft: ({ key, ifCurrent }) =>
      inOrder(() => {
        refuse(ifCurrent);
        if (files.get(key) !== ifCurrent) return false;
        remove(key);
        return true;
      }),
    moveSetAsideDrafts: ({ workspaceId, changes }) =>
      inOrder(() => {
        for (const [key, raw] of [...files]) {
          const moved = movedSetAsideDraft(raw, workspaceId, changes);
          if (moved === null) continue;
          refuse(raw);
          if (classifyEngineFilePathForRead(moved.path, "linux").kind === "tracked")
            set(key, moved.raw);
          else remove(key);
        }
        return null;
      }),
    onSetAsideDraftChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    files,
    calls,
    set,
    delete: remove,
    clear: () => {
      for (const key of [...files.keys()]) remove(key);
    },
    rows: () => [...files.values()].map((raw) => JSON.parse(raw) as Record<string, unknown>),
    fail: (error: Error | null, when: (raw: string) => boolean = () => true) => {
      failure = error && { error, when };
    },
    hold: () => {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        drain();
      };
    },
  };
}
