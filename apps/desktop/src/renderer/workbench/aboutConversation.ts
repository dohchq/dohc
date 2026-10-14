import { useSyncExternalStore } from "react";
import type { PresencePeer } from "../collab/presenceChannel";

// The open conversation, as About shows it. A conversation tab's Chats page
// owns these facts and publishes them here while it is mounted, so About reads
// them without a second presence lease or channel read. Each entry is held to
// the workspace and tab it came from: a fast tab switch reads another key, and
// never the last conversation's facts.
export type AboutConversation = {
  kind: "group" | "person" | "agent";
  name: string;
  // What Access asks about: the conversation's cross-machine identity.
  channelWireId: string;
  // Whether this workspace reads the conversation through someone else's
  // share. Null until the Chats page knows.
  received: boolean | null;
  // People and agents here now, from the conversation's presence.
  present: PresencePeer[];
};

// "none": the tab's page is mounted and shows no conversation, such as a Group
// that no longer exists. A tab with no entry has not said yet.
export type AboutConversationEntry = AboutConversation | "none";

const entries = new Map<string, AboutConversationEntry>();
const listeners = new Set<() => void>();
const keyOf = (workspaceId: string, tabPath: string) => `${workspaceId}\0${tabPath}`;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Returns the withdrawal, which removes only this entry: a remounted page that
// already published its own keeps it.
export function publishAboutConversation(
  workspaceId: string,
  tabPath: string,
  entry: AboutConversationEntry,
): () => void {
  const key = keyOf(workspaceId, tabPath);
  entries.set(key, entry);
  notify();
  return () => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    notify();
  };
}

export function useAboutConversation(
  workspaceId: string,
  tabPath: string | null,
): AboutConversationEntry | undefined {
  return useSyncExternalStore(subscribe, () =>
    tabPath === null ? undefined : entries.get(keyOf(workspaceId, tabPath)));
}
