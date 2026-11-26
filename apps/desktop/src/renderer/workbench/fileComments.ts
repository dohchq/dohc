import { useSyncExternalStore } from "react";

// A document's comments on passages, shared between the editor that shows
// them and About, which lists them. About reads the file's comments and
// publishes them here; while About is hidden, the shell's FileCommentsReader
// does instead. Requests go the other way: the editor asks About to start a
// comment on a passage or open one, and About asks the editor to show the
// passage of the comment it opened. Every entry is held to its workspace and
// file, so a switch never shows another file's comments. An entry lasts the
// session: a few strings for each document opened.

export type CommentAnchor = { threadId: string; quote: string };

export function anchorsOf(threads: ReadonlyArray<{ id: string; quote?: string }>): CommentAnchor[] {
  return threads.flatMap((thread) =>
    thread.quote ? [{ threadId: thread.id, quote: thread.quote }] : [],
  );
}

export type FileComments = {
  anchors: CommentAnchor[];
  // Whether this person can comment on the file here.
  canComment: boolean;
};

export type FileCommentRequest =
  | { kind: "comment"; quote: string }
  // Several when the passages overlap: About lists them all.
  | { kind: "open"; threadIds: string[] };

type Entry = {
  comments?: FileComments;
  request?: FileCommentRequest;
  // The passage About last opened, numbered so the same one can show again.
  reveal?: { quote: string; token: number };
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const requestListeners = new Set<(workspaceId: string, path: string) => void>();
let revealTokens = 0;
const keyOf = (workspaceId: string, path: string) => `${workspaceId}\0${path}`;

function update(workspaceId: string, path: string, change: (entry: Entry) => Entry) {
  const key = keyOf(workspaceId, path);
  entries.set(key, change(entries.get(key) ?? {}));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The last read stays until the next replaces it, so the editor keeps its
// highlights while About and the reader hand over, and on a file opened again.
export function publishFileComments(
  workspaceId: string,
  path: string,
  comments: FileComments,
): void {
  update(workspaceId, path, (entry) => ({ ...entry, comments }));
}

export function useFileComments(workspaceId: string, path: string | null) {
  return useSyncExternalStore(subscribe, () =>
    path === null ? undefined : entries.get(keyOf(workspaceId, path))?.comments,
  );
}

export function requestFileComment(
  workspaceId: string,
  path: string,
  request: FileCommentRequest,
): void {
  update(workspaceId, path, (entry) => ({ ...entry, request }));
  for (const listener of requestListeners) listener(workspaceId, path);
}

// The shell shows About when a request arrives, so it is there to take it.
export function onFileCommentRequest(listener: (workspaceId: string, path: string) => void) {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

export function useFileCommentRequest(workspaceId: string, path: string | null) {
  return useSyncExternalStore(subscribe, () =>
    path === null ? undefined : entries.get(keyOf(workspaceId, path))?.request,
  );
}

// Clears the request only if it is still the one taken.
export function takeFileCommentRequest(
  workspaceId: string,
  path: string,
  request: FileCommentRequest,
): void {
  if (entries.get(keyOf(workspaceId, path))?.request !== request) return;
  update(workspaceId, path, ({ request: _, ...entry }) => entry);
}

export function revealFileComment(workspaceId: string, path: string, quote: string): void {
  revealTokens += 1;
  const reveal = { quote, token: revealTokens };
  update(workspaceId, path, (entry) => ({ ...entry, reveal }));
}

export function useFileCommentReveal(workspaceId: string, path: string) {
  return useSyncExternalStore(subscribe, () => entries.get(keyOf(workspaceId, path))?.reveal);
}
