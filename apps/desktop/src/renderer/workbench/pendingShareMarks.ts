import { createContext, useContext, useSyncExternalStore } from "react";

// Shared notes whose edits wait for the server and that no tab has open. Each
// row reads its own path, so a change re-renders only the rows whose answer
// changed, never the Explorer around them.
export interface PathMarks {
  subscribe(onChange: () => void): () => void;
  has(path: string): boolean;
}

export function createPathMarks(): PathMarks & { set(waiting: readonly string[], open: readonly string[]): void } {
  let marked: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    has: (path) => marked.has(path),
    set(waiting, open) {
      const opened = new Set(open);
      const paths = new Set(waiting.filter((path) => !opened.has(path)));
      if (paths.size === marked.size && [...paths].every((path) => marked.has(path))) return;
      marked = paths;
      for (const listener of listeners) listener();
    },
  };
}

const NO_MARKS: PathMarks = { subscribe: () => () => undefined, has: () => false };
export const PendingShareMarks = createContext<PathMarks>(NO_MARKS);

export function usePendingShareMark(path: string, file: boolean): boolean {
  const marks = useContext(PendingShareMarks);
  return useSyncExternalStore(marks.subscribe, () => file && marks.has(path));
}
