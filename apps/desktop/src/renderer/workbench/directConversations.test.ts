import { describe, expect, it, vi } from "vitest";
import { createDirectStore } from "./directConversations";

type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };

function fakeApi() {
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  const api = {
    directConversations: vi.fn(async () => ({
      available: true as const,
      viewerId: "ana",
      scope: "a".repeat(64),
      conversations: [],
    })),
    directMarkRead: vi.fn(async () => undefined),
    directBlock: vi.fn(async () => undefined),
    onDirectChanged: vi.fn(() => () => {}),
    onCloudSessionChanged: vi.fn((listener: (event: SessionEvent) => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    }),
  };
  const emit = (event: SessionEvent) => {
    for (const listener of [...sessionListeners]) listener(event);
  };
  return { api, emit };
}

describe("direct store", () => {
  it("starts over on an account change made while no Chats view is open", async () => {
    const { api, emit } = fakeApi();
    const store = createDirectStore(api as unknown as Parameters<typeof createDirectStore>[0]);
    const stop = store.subscribe(() => {});
    emit({ sessionKey: "ana", phase: "ready" });
    await vi.waitFor(() => expect(store.snapshot().status).toBe("ready"));
    store.setDraft("new", "words for Ana's contacts");
    const firstSession = store.session();
    stop();

    // Chats is closed when the account changes in Settings.
    emit({ sessionKey: "bea", phase: "changing" });
    emit({ sessionKey: "bea", phase: "ready" });

    expect(store.draft("new")).toBe("");
    expect(store.session()).toBeGreaterThan(firstSession);
    expect(store.snapshot().status).toBe("loading");
  });

  it("keeps no read mark made before the list reads, so the same mark sends once it has", async () => {
    const { api } = fakeApi();
    api.directConversations.mockResolvedValue({
      available: true,
      viewerId: "ana",
      scope: "a".repeat(64),
      conversations: [
        {
          conversationId: "c1",
          person: { personId: "bob", name: "Bob", blocked: false },
          last: {
            seq: 7,
            messageId: "m7",
            authorId: "bob",
            authorName: "Bob",
            body: "hi",
            createdAtMs: 1,
          },
          unread: 1,
        },
      ] as never,
    });
    const store = createDirectStore(api as unknown as Parameters<typeof createDirectStore>[0]);
    store.markRead("c1", 7);
    expect(api.directMarkRead).not.toHaveBeenCalled();
    // The first view reads the list; no change of account clears anything in between.
    const stop = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.snapshot().status).toBe("ready"));
    const ready = store.snapshot();
    expect(ready.status === "ready" ? ready.conversations[0]!.unread : null).toBe(1);
    store.markRead("c1", 7);
    expect(api.directMarkRead).toHaveBeenCalledWith({
      viewerId: "ana",
      scope: "a".repeat(64),
      conversationId: "c1",
      seq: 7,
    });
    stop();
  });
});
