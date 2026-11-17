import { describe, expect, it, vi } from "vitest";
import { createDirectStore } from "./directConversations";

type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };

function fakeApi() {
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  const api = {
    directConversations: vi.fn(async () => ({
      available: true as const,
      viewerId: "ana",
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
});
