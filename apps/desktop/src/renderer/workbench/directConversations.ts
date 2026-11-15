import { useSyncExternalStore } from "react";
import { actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import type { DirectConversation, DirectMessage, DirectPerson } from "@dohc/security-contract/direct-messages";
import type { ChatMessageRecord, DohcDesktopBridge } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { ownPresentation, relayPresentation } from "./actorPresentation";

// The signed-in account's direct conversations, shared by every Chats view in
// this window. They belong to the account on its server, not to a workspace,
// so a workspace switch keeps them and a change of account starts over.

export type DirectListState =
  | { status: "loading" }
  | { status: "signed-out" }
  // `saved`: dohc could not reach the server, and this is this computer's copy.
  // `failure`: the latest read failed; the list is the one read before it.
  | { status: "ready"; viewerId: string; saved: boolean; conversations: readonly DirectConversation[]; failure: string | null }
  | { status: "failed"; message: string };

type Api = Pick<DohcDesktopBridge, "directConversations" | "directMarkRead" | "directBlock" | "onDirectChanged" | "onCloudSessionChanged">;

const LIST_FAILED = "dohc could not read your direct messages.";

export function createDirectStore(api: Api) {
  let state: DirectListState = { status: "loading" };
  const listeners = new Set<() => void>();
  // Moves with each change of account. An answer read for an older one is dropped.
  let session = 0;
  let sessionKey: string | null | undefined;
  let reading = false;
  let again = false;
  let stopEvents: (() => void) | null = null;
  // The newest seq this computer told the server it read, per conversation.
  const readSent = new Map<string, number>();
  // Unsent typing and each failed send's id, so Try again never sends twice.
  const drafts = new Map<string, string>();
  const unsent = new Map<string, { messageId: string; body: string }>();

  const set = (next: DirectListState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const patch = (conversationId: string, change: (conversation: DirectConversation) => DirectConversation) => {
    if (state.status !== "ready") return;
    set({ ...state, conversations: state.conversations.map((entry) => entry.conversationId === conversationId ? change(entry) : entry) });
  };

  async function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const mine = session;
        try {
          const result = await api.directConversations({});
          if (mine !== session) continue;
          if (!result.available) set({ status: "signed-out" });
          else {
            // A mark read still on its way keeps the row read.
            const conversations = result.conversations.map((conversation) => {
              const sent = readSent.get(conversation.conversationId);
              return sent !== undefined && conversation.last !== null && sent >= conversation.last.seq ? { ...conversation, unread: 0 } : conversation;
            });
            set({ status: "ready", viewerId: result.viewerId, saved: result.saved, conversations, failure: null });
          }
        } catch (cause) {
          if (mine !== session) continue;
          const message = ipcErrorMessage(cause, LIST_FAILED);
          set(state.status === "ready" ? { ...state, failure: message } : { status: "failed", message });
        }
      } while (again);
    } finally {
      reading = false;
    }
  }

  function startEvents() {
    const offChanged = api.onDirectChanged(() => void refresh());
    const offSession = api.onCloudSessionChanged(({ sessionKey: key, phase }) => {
      // The first event counts too: a read started before it may be for the account signed in before.
      if (key !== sessionKey) {
        sessionKey = key;
        session += 1;
        readSent.clear();
        drafts.clear();
        unsent.clear();
        set({ status: "loading" });
      }
      if (phase === "ready") void refresh();
    });
    stopEvents = () => {
      offChanged();
      offSession();
    };
  }

  return {
    snapshot: () => state,
    session: () => session,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!stopEvents) {
        startEvents();
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopEvents?.();
          stopEvents = null;
        }
      };
    },
    refresh,
    /** Marks the conversation read up to `seq`, once per seq. A failed mark reads the list again. */
    markRead(conversationId: string, seq: number): void {
      if ((readSent.get(conversationId) ?? -1) >= seq) return;
      readSent.set(conversationId, seq);
      patch(conversationId, (conversation) =>
        conversation.unread === 0 || (conversation.last !== null && conversation.last.seq > seq) ? conversation : { ...conversation, unread: 0 });
      const mine = session;
      api.directMarkRead({ conversationId, seq }).catch(() => {
        if (mine !== session) return;
        if (readSent.get(conversationId) === seq) readSent.delete(conversationId);
        void refresh();
      });
    },
    /** Blocks or unblocks one person. Rejects with the server's reason. */
    async setBlocked(conversationId: string, personId: string, blocked: boolean): Promise<void> {
      const mine = session;
      await api.directBlock({ conversationId, personId, blocked });
      if (mine !== session) return;
      patch(conversationId, (conversation) => {
        const people = conversation.people.map((person) => person.personId === personId ? { ...person, blocked } : person);
        return { ...conversation, people, blocked: people.length === 1 && people[0]!.blocked };
      });
      void refresh();
    },
    draft: (key: string) => drafts.get(key) ?? "",
    setDraft(key: string, value: string): void {
      if (value) drafts.set(key, value);
      else drafts.delete(key);
    },
    /** The id to send `body` with: the failed send's id when the words are the same. */
    messageIdFor(key: string, body: string): string {
      const failed = unsent.get(key);
      if (failed && failed.body === body) return failed.messageId;
      const messageId = crypto.randomUUID().replaceAll("-", "");
      unsent.set(key, { messageId, body });
      return messageId;
    },
    sent(key: string, messageId: string): void {
      if (unsent.get(key)?.messageId === messageId) unsent.delete(key);
    },
  };
}

export type DirectStore = ReturnType<typeof createDirectStore>;

const stores = new WeakMap<object, DirectStore>();

/** The window's store. Each bridge gets its own, so a test's fresh bridge starts empty. */
export function directStore(): DirectStore {
  const api = bridge();
  let store = stores.get(api);
  if (!store) {
    store = createDirectStore(api);
    stores.set(api, store);
  }
  return store;
}

export function useDirectConversations(): { state: DirectListState; store: DirectStore } {
  const store = directStore();
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return { state, store };
}

export function directPersonName(person: Pick<DirectPerson, "name">): string {
  return person.name ?? "Someone";
}

/** Everyone in the conversation but the viewer, by name. */
export function directTitle(people: readonly Pick<DirectPerson, "name">[]): string {
  return people.length === 0 ? "Nobody else" : people.map(directPersonName).join(", ");
}

/** A person's color, the same on every computer. */
export function directPresentation(personId: string, viewerId: string | null) {
  return personId === viewerId ? ownPresentation : relayPresentation(actorHueSlot(personId));
}

/** A direct message as the chat list draws it. */
export function directMessageRecord(conversationId: string, message: DirectMessage, viewerId: string | null): ChatMessageRecord {
  const self = message.authorId === viewerId;
  return {
    id: message.messageId,
    threadId: conversationId,
    presentation: directPresentation(message.authorId, viewerId),
    authorKind: "human",
    authorDisplayName: message.authorName ?? (self ? "You" : "Someone"),
    authorUserId: message.authorId,
    body: message.body,
    createdAtMs: message.createdAtMs,
  };
}

/**
 * Merges a page into what is shown, by seq. A newest page with more before it
 * that starts after the shown messages may leave a gap, so it replaces them.
 * Seqs alone cannot tell: a group hides the messages of people the viewer blocked.
 */
export function mergeDirectPage(shown: readonly DirectMessage[], page: { messages: readonly DirectMessage[]; more: boolean }, newest: boolean): DirectMessage[] {
  if (page.messages.length === 0) return [...shown];
  const lastShown = shown.at(-1)?.seq ?? 0;
  if (newest && page.more && shown.length > 0 && page.messages[0]!.seq > lastShown) return [...page.messages];
  const bySeq = new Map(shown.map((message) => [message.seq, message]));
  for (const message of page.messages) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
