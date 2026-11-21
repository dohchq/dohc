import type { DohcDesktopBridge, SetAsideDraftChange } from "../ipc/bridgeContract";

type DraftFileCalls = Pick<
  DohcDesktopBridge,
  "listSetAsideDrafts" | "writeSetAsideDraft" | "removeSetAsideDraft" | "onSetAsideDraftChanged"
>;

export function draftFilesForTests() {
  const files = new Map<string, string>();
  const listeners = new Set<(change: SetAsideDraftChange) => void>();
  let failure: Error | null = null;
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
  const calls: DraftFileCalls = {
    listSetAsideDrafts: async (_payload) => [...files].map(([key, raw]) => ({ key, raw })),
    writeSetAsideDraft: async ({ key, raw, ifCurrent }) => {
      if (failure) throw failure;
      if ((files.get(key) ?? null) !== ifCurrent) return false;
      set(key, raw);
      return true;
    },
    removeSetAsideDraft: async ({ key, ifCurrent }) => {
      if (failure) throw failure;
      if (files.get(key) !== ifCurrent) return false;
      remove(key);
      return true;
    },
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
    fail: (error: Error | null) => {
      failure = error;
    },
  };
}
