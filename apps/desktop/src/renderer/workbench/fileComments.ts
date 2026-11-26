import { useSyncExternalStore } from "react";

export type CommentAnchor = { threadId: string; quote: string };

export function anchorsOf(threads: ReadonlyArray<{ id: string; quote?: string }>): CommentAnchor[] {
  return threads.flatMap((thread) =>
    thread.quote ? [{ threadId: thread.id, quote: thread.quote }] : [],
  );
}

export type FileComments = {
  anchors: CommentAnchor[];
  canComment: boolean;
};

export type FileCommentRequest =
  | { kind: "comment"; quote: string }
  | { kind: "open"; threadIds: string[] };

type Entry = {
  comments?: FileComments;
  request?: FileCommentRequest;
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
