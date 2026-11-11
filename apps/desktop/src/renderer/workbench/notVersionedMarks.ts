import { createContext, useContext, useSyncExternalStore } from "react";
import type { PathMarks } from "./pendingShareMarks";

// The files the active version does not track, while it is not Main. Each has
// one copy for every version, so a change to it changes Main too. Each row
// reads its own path, as the pending-share marks do.
export interface NotVersionedPaths extends PathMarks {
  // The marked files at or under any of `paths`.
  under(paths: readonly string[]): string[];
}

export function createNotVersionedMarks(): NotVersionedPaths & { set(paths: readonly string[]): void } {
  let marked: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    has: (path) => marked.has(path),
    under: (paths) => marked.size === 0 ? [] : [...marked].filter((file) =>
      paths.some((path) => file === path || file.startsWith(`${path}/`))),
    set(paths) {
      if (paths.length === marked.size && paths.every((path) => marked.has(path))) return;
      marked = new Set(paths);
      for (const listener of listeners) listener();
    },
  };
}

const NONE: NotVersionedPaths = { subscribe: () => () => undefined, has: () => false, under: () => [] };
export const NotVersionedMarks = createContext<NotVersionedPaths>(NONE);

export function useNotVersionedMark(path: string, file: boolean): boolean {
  const marks = useContext(NotVersionedMarks);
  return useSyncExternalStore(marks.subscribe, () => file && marks.has(path));
}

// The question before a rename, move or delete, in a version, reaches files
// that version does not track. `paths` are those files; `sources` are what the
// person chose to change.
export function notVersionedConfirmText(action: "delete" | "rename" | "move", sources: readonly string[], paths: readonly string[]): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  const name = sources.length === 1 ? (sources[0]!.split("/").pop() ?? sources[0]!) : `${sources.length} items`;
  const title = action === "delete" ? `Delete ${name} from Main too?`
    : action === "rename" ? `Rename ${name} in Main too?`
    : `Move ${name} in Main too?`;
  const itself = paths.length === 1 && sources.length === 1 && paths[0] === sources[0];
  const body = itself
    ? "It isn't versioned, so Main and every version have the same copy."
    : `${paths.length === 1 ? "1 file here isn't" : `${paths.length} files here aren't`} versioned, so Main and every version have the same copy.`;
  const confirmLabel = action === "delete" ? "Delete anyway" : action === "rename" ? "Rename anyway" : "Move anyway";
  return { title, body, confirmLabel };
}
