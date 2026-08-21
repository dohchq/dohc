// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let lastEventSource: FakeEventSource | null = null;

/** A controllable EventSource stand-in: jsdom has no real implementation, and
 * chat.js only needs addEventListener/dispatchEvent (both real EventTarget
 * behavior) to receive what a test fires at it. Records itself as
 * lastEventSource on construction, so loadChatModule can hand the instance
 * chat.js actually built back to the test that imported it. */
class FakeEventSource extends EventTarget {
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    lastEventSource = this;
  }
  close(): void {}
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

/** Boots just enough of the page for ../ui/chat.js's own top-level guard to
 * pass, then imports it. A cache-busting query string forces a fresh module
 * instance per test, so one test's DOM and EventSource never leak into
 * another's. */
async function loadChatModule(): Promise<{
  module: typeof import("../ui/chat.js");
  eventSource: FakeEventSource;
}> {
  document.body.innerHTML = `
    <main id="transcript" class="transcript">
      <div id="empty-state" class="empty-state"><p>Empty</p></div>
    </main>
    <div id="status"></div>
    <span id="session-state"></span>
    <button id="stop" type="button"></button>
    <form id="composer">
      <textarea id="message"></textarea>
      <button id="send" type="submit"></button>
    </form>
    <meta name="chat-token" content="test-token">
  `;
  lastEventSource = null;
  const mod = await import(/* @vite-ignore */ `../ui/chat.js?t=${Date.now()}-${Math.random()}`);
  if (!lastEventSource) throw new Error("chat.js did not construct an EventSource.");
  return { module: mod, eventSource: lastEventSource };
}

function sendEvent(eventSource: FakeEventSource, data: unknown): void {
  eventSource.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
}

function textOf(selector: string): string | null {
  return document.querySelector(selector)?.textContent ?? null;
}

describe("mergedActivity", () => {
  it("keeps the existing title and detail when a completion event arrives sparse", async () => {
    const { module } = await loadChatModule();
    const existing = { title: "Read src/foo.ts", detail: "src/foo.ts" };
    const sparse = { title: "Tool finished", status: "completed" as const };
    expect(module.mergedActivity(existing, sparse)).toEqual({
      title: "Read src/foo.ts",
      detail: "src/foo.ts",
    });
  });

  it("uses the incoming title and detail when the completion actually carries them", async () => {
    const { module } = await loadChatModule();
    const existing = { title: "Read src/foo.ts", detail: "src/foo.ts" };
    const rich = {
      title: "Read",
      detail: "3 matches",
      locations: ["src/bar.ts"],
      status: "completed" as const,
    };
    expect(module.mergedActivity(existing, rich)).toEqual({
      title: "Read",
      detail: "3 matches\nsrc/bar.ts",
    });
  });

  it("always uses the item's own title and detail for a brand new card", async () => {
    const { module } = await loadChatModule();
    const started = { title: "Bash", status: "in_progress" as const };
    expect(module.mergedActivity(null, started)).toEqual({ title: "Bash", detail: "" });
  });

  it("keeps status-only changes from wiping a rich title even with no existing detail", async () => {
    const { module } = await loadChatModule();
    const existing = { title: "Edit src/foo.ts", detail: "" };
    const sparse = { title: "Tool failed", status: "failed" as const };
    expect(module.mergedActivity(existing, sparse)).toEqual({ title: "Edit src/foo.ts", detail: "" });
  });
});

describe("permissionLocations", () => {
  it("lists a permission request's affected locations", async () => {
    const { module } = await loadChatModule();
    expect(
      module.permissionLocations({
        kind: "permission-request",
        requestId: "r1",
        requestType: "file-change",
        title: "Edit files",
        locations: ["src/a.ts", "src/b.ts"],
        options: [],
      }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("is empty when the request carries no locations", async () => {
    const { module } = await loadChatModule();
    expect(
      module.permissionLocations({
        kind: "permission-request",
        requestId: "r1",
        requestType: "command",
        title: "Run tests",
        options: [],
      }),
    ).toEqual([]);
  });
});

describe("replay fidelity (against the live EventSource wiring)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders a replayed event's own publish time, not the reconnect moment", async () => {
    const { eventSource } = await loadChatModule();
    const at = new Date("2020-01-01T03:04:00Z").getTime();
    sendEvent(eventSource, { kind: "auth", event: "account-updated", detail: "Logged in.", at });
    expect(textOf(".message .timestamp")).toBe(
      new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  });

  it("renders the decision's own label when a permission resolves, not a generic \"Resolved\"", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, {
      kind: "permission-request",
      requestId: "r1",
      requestType: "command",
      title: "Run tests",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    });
    sendEvent(eventSource, { kind: "permission-resolved", requestId: "r1", decision: "allow_always" });
    expect(textOf(".permission-actions .timestamp")).toBe("Allowed for session");
  });

  it("applies the initial snapshot to the pill without a transcript card, even for a reasoned closed state", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, { kind: "session-state", state: "closed", reason: "Stopped", snapshot: true });
    expect(textOf("#session-state")).toBe("Closed");
    expect(document.querySelectorAll(".error-card")).toHaveLength(0);

    // The same transition arriving as a real (non-snapshot) event does
    // render the card -- that is what actually narrates the transcript.
    sendEvent(eventSource, { kind: "session-state", state: "closed", reason: "Stopped" });
    expect(document.querySelectorAll(".error-card")).toHaveLength(1);
  });

  it("keeps a pending message's card recoverable across a reconnect that races its request", async () => {
    const { eventSource } = await loadChatModule();
    let capturedBody: string | undefined;
    let settleFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return pending;
    }) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    messageInput.value = "Hello";
    composer.requestSubmit();
    // Let the submit handler's async body run up to its own await.
    await Promise.resolve();
    await Promise.resolve();

    const card = document.querySelector(".message.user");
    expect(card).not.toBeNull();
    expect(card?.isConnected).toBe(true);

    // A reconnect fires while the /message fetch above is still pending --
    // without the fix, resetTranscript's own pendingMessages.clear() would
    // strand this card: it survives the DOM wipe (still tracked), but is
    // no longer attached.
    eventSource.dispatchEvent(new Event("open"));
    expect(card?.isConnected).toBe(false);
    expect(document.querySelector(".message.user")).toBeNull();

    // The request succeeds, and the server's own echo arrives over the
    // reconnected stream -- exactly what a real reconnect's replay does.
    settleFetch(new Response(null, { status: 202 }));
    await Promise.resolve();
    await Promise.resolve();
    const clientId = (JSON.parse(capturedBody ?? "{}") as { clientId?: string }).clientId;
    sendEvent(eventSource, { kind: "user-message", text: "Hello", clientId });

    // The exact same node comes back -- not a fresh lookalike card. Without
    // the fix, resetTranscript's pendingMessages.clear() loses the
    // correlation entirely: renderUserMessage's pendingMessages.get(clientId)
    // finds nothing, falls through to its "no local card" branch, and
    // creates a brand new card that would satisfy a content-only assertion
    // just as well as the real fix does.
    const restored = document.querySelector(".message.user");
    expect(restored).toBe(card);
    expect(restored?.isConnected).toBe(true);
    expect(restored?.querySelector(".message-body")?.textContent).toBe("Hello");
  });

  it("keeps a pending message's card recoverable across a reconnect when the request then fails", async () => {
    const { eventSource } = await loadChatModule();
    let settleFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    globalThis.fetch = (() => pending) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    messageInput.value = "Hello";
    composer.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
    const card = document.querySelector(".message.user");
    expect(card).not.toBeNull();

    eventSource.dispatchEvent(new Event("open"));
    expect(document.querySelector(".message.user")).toBeNull();

    settleFetch(new Response(null, { status: 500 }));
    await Promise.resolve();
    await Promise.resolve();

    // The exact same node comes back, now carrying the failure notice --
    // not a lookalike, and not silently lost. Without the fix,
    // markMessageFailed still finds its clientId (the map entry is not
    // what a detached card breaks) but appends the notice to a node that
    // is no longer in the document: the user sees nothing.
    const restored = document.querySelector(".message.user");
    expect(restored).toBe(card);
    expect(restored?.isConnected).toBe(true);
    expect(restored?.querySelector(".send-failed")?.textContent).toBe(
      "This message was not sent. Send it again.",
    );
  });
});
