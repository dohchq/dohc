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
 * another's.
 *
 * Every call starts from a clean sessionStorage and a fresh fragment token,
 * simulating a genuine first load -- unless `reload` is set, which leaves
 * both alone: sessionStorage keeps whatever a prior call in the SAME test
 * already stored, and the fragment stays whatever chat.js's own
 * history.replaceState last left it as (empty, after a real first load).
 * That is exactly what a real page reload looks like: the same origin's
 * sessionStorage survives, the URL's fragment does not. */
async function loadChatModule(options: { reload?: boolean } = {}): Promise<{
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
  `;
  lastEventSource = null;
  if (!options.reload) {
    sessionStorage.clear();
    // The page's own credential, exactly as startWebApp hands it to the
    // guest: in the URL fragment, not a meta tag.
    location.hash = "token=test-token";
  }
  const mod = await import(/* @vite-ignore */ `../ui/chat.js?t=${Date.now()}-${Math.random()}`);
  if (!lastEventSource) throw new Error("chat.js did not construct an EventSource.");
  return { module: mod, eventSource: lastEventSource };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it("reads its token from the URL fragment and strips it from the visible URL", async () => {
    await loadChatModule();
    // chat.js already read TOKEN out of location.hash by the time it
    // constructed the EventSource above (its very first act) -- what
    // remains is what the page's own history.replaceState left behind.
    expect(location.hash).toBe("");
  });

  it("recovers its token from sessionStorage on a reload, after the fragment was already stripped", async () => {
    await loadChatModule();
    expect(location.hash).toBe("");

    // A real reload re-requests the already-stripped URL: no fragment left
    // to read at all. Without sessionStorage recovery this throws instead
    // of reattaching -- the exact regression this fix exists to prevent.
    const { eventSource } = await loadChatModule({ reload: true });
    expect(eventSource.url).toContain("test-token");
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

  it("renders a default boundary for a reasonless close, so the next message doesn't silently start a fresh session", async () => {
    const { eventSource } = await loadChatModule();
    // Not the initial snapshot -- a real, later transition, exactly what an
    // idle CLI process exiting on its own looks like: closed, no reason.
    sendEvent(eventSource, { kind: "session-state", state: "closed" });
    expect(textOf("#session-state")).toBe("Closed");
    const card = document.querySelector(".error-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("This session ended.");
    expect(card?.textContent).toContain("Send a message to start a new session.");
  });

  it("announces a fatal failure as an alert carrying the explanation and next step", async () => {
    // The live status region only ever speaks the state label ("Error");
    // the alert role on the recovery card is what actually carries the
    // failure text and the next step to a screen reader.
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, { kind: "error", message: "Claude Code exited unexpectedly.", fatal: true });
    expect(textOf("#session-state")).toBe("Error");
    const card = document.querySelector(".error-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("Claude Code exited unexpectedly.");
    expect(card?.textContent).toContain("Send a message to start a new session.");
  });

  it("renders a fallback failure line for a failed turn with no errorMessage, so it doesn't look like it succeeded", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, { kind: "turn-completed", turnId: "t1", status: "failed" });
    expect(textOf("#session-state")).toBe("Ready");
    const card = document.querySelector(".error-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("This response failed.");
  });

  it("labels a failed activity item as Failed in text, not just a border color", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, {
      kind: "item",
      phase: "completed",
      item: { id: "tool-1", type: "command", title: "Run tests", status: "failed" },
    });
    const status = document.querySelector(".activity-status");
    expect(status?.textContent).toBe("Failed");
  });

  it("keeps replayed failures out of live regions while live failures alert", async () => {
    // A reconnect's replay rebuilds cards the reader already heard; only a
    // failure happening now may interrupt as an alert.
    const { eventSource } = await loadChatModule();
    const priorStatus = textOf("#status");
    sendEvent(eventSource, { kind: "error", message: "Old failure.", fatal: true, replay: true });
    expect(textOf("#status")).toBe(priorStatus);
    sendEvent(eventSource, { kind: "session-state", state: "closed", reason: "Stopped", replay: true });
    for (const card of document.querySelectorAll(".error-card")) {
      expect(card.getAttribute("role")).toBeNull();
    }
    sendEvent(eventSource, { kind: "error", message: "New failure.", fatal: true });
    expect(textOf("#status")).toBe("Error");
    const cards = document.querySelectorAll(".error-card");
    expect(cards).toHaveLength(3);
    expect(cards[2]?.getAttribute("role")).toBe("alert");
    expect(cards[2]?.textContent).toContain("New failure.");
  });

  it("says earlier messages are missing when the replay was trimmed", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, { kind: "history-trimmed", replay: true });
    const notice = document.querySelector(".notice");
    expect(notice?.textContent).toBe(
      "Only recent messages are shown. Earlier ones were trimmed to save memory.",
    );
  });

  it("renders a streamed reply's fragments in order, each stream in its own card", async () => {
    const { eventSource } = await loadChatModule();
    let full = "";
    for (let index = 0; index < 40; index += 1) {
      const text = "word" + index + " ";
      full += text;
      sendEvent(eventSource, { kind: "text-delta", itemId: "i1", stream: "assistant", text });
    }
    expect(textOf(".message.agent:not(.reasoning) .message-body")).toBe(full);
    // The reasoning stream renders separately, not appended into the reply.
    sendEvent(eventSource, { kind: "text-delta", itemId: "i1", stream: "reasoning", text: "thinking" });
    expect(textOf(".message.reasoning .message-body")).toBe("thinking");
    expect(textOf(".message.agent:not(.reasoning) .message-body")).toBe(full);
    // All 40 fragments grew one Text node in place -- per-delta appends
    // would leave one child per fragment behind.
    const body = document.querySelector(".message.agent:not(.reasoning) .message-body");
    expect(body?.childNodes.length).toBe(1);
  });

  it("batches transcript scrolling to one layout read per frame while a reply streams", async () => {
    // Reading scrollHeight forces layout; doing it once per delta made a
    // long streamed answer quadratic. The scroll is batched through
    // requestAnimationFrame instead.
    const { eventSource } = await loadChatModule();
    const transcriptElement = document.querySelector("#transcript");
    if (!transcriptElement) throw new Error("The transcript is missing.");
    let layoutReads = 0;
    Object.defineProperty(transcriptElement, "scrollHeight", {
      configurable: true,
      get: () => {
        layoutReads += 1;
        return 1000;
      },
    });
    for (let index = 0; index < 50; index += 1) {
      sendEvent(eventSource, { kind: "text-delta", itemId: "i1", stream: "assistant", text: "x" });
    }
    expect(layoutReads).toBe(0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(layoutReads).toBe(1);
  });

  it("keeps a pending message's card recoverable across a reconnect that races its request", async () => {
    const { eventSource } = await loadChatModule();
    let capturedBody: string | undefined;
    const entered = deferred();
    let settleFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      entered.resolve();
      return pending;
    }) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    messageInput.value = "Hello";
    composer.requestSubmit();
    // Tied to the submit handler actually reaching its fetch call -- not a
    // guessed number of microtask hops.
    await entered.promise;

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
    // Awaiting the same promise the submit handler itself awaits: its
    // continuation was registered first, so it has already run once this
    // resolves (promise reactions fire in registration order).
    settleFetch(new Response(null, { status: 202 }));
    await pending;
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
    const entered = deferred();
    let settleFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    globalThis.fetch = (() => {
      entered.resolve();
      return pending;
    }) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    messageInput.value = "Hello";
    composer.requestSubmit();
    await entered.promise;
    const card = document.querySelector(".message.user");
    expect(card).not.toBeNull();

    eventSource.dispatchEvent(new Event("open"));
    expect(document.querySelector(".message.user")).toBeNull();

    settleFetch(new Response(null, { status: 500 }));
    await pending;

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

  it("re-enables Stop after a successful cancel, with no turn-completed event of its own to bring it back", async () => {
    await loadChatModule();
    let settleFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    globalThis.fetch = (() => pending) as typeof fetch;

    const stopButton = document.querySelector("#stop") as HTMLButtonElement;
    stopButton.click();
    expect(stopButton.disabled).toBe(true);

    // Stop now cancels the turn rather than ending the session -- if
    // nothing was running, cancel() is a documented no-op on both
    // concrete drivers, so no turn-completed event ever arrives to
    // re-enable this button otherwise.
    settleFetch(new Response(null, { status: 204 }));
    await pending;

    expect(stopButton.disabled).toBe(false);
  });

  it("keeps Send disabled for a newer turn when a stale, stop-abandoned request's late failure arrives", async () => {
    const { eventSource } = await loadChatModule();
    const enteredFirst = deferred();
    const enteredSecond = deferred();
    let settleFirst!: (response: Response) => void;
    let settleSecond!: (response: Response) => void;
    const pendingFirst = new Promise<Response>((resolve) => {
      settleFirst = resolve;
    });
    const pendingSecond = new Promise<Response>((resolve) => {
      settleSecond = resolve;
    });
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        enteredFirst.resolve();
        return pendingFirst;
      }
      enteredSecond.resolve();
      return pendingSecond;
    }) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;

    // First message: its request is abandoned server-side by a stop during
    // driver startup (round-6), which publishes session-state: closed and
    // re-enables Send immediately -- long before this request's own
    // response ever lands.
    messageInput.value = "First";
    composer.requestSubmit();
    await enteredFirst.promise;
    expect(sendButton.disabled).toBe(true);
    sendEvent(eventSource, { kind: "session-state", state: "closed", reason: "Stopped" });
    expect(sendButton.disabled).toBe(false);

    // A fresh second message is sent while the first request is still
    // outstanding, and its own turn starts running.
    messageInput.value = "Second";
    composer.requestSubmit();
    await enteredSecond.promise;
    expect(sendButton.disabled).toBe(true);
    sendEvent(eventSource, { kind: "session-state", state: "running" });
    expect(sendButton.disabled).toBe(true);

    // The abandoned first request finally settles with the 503 the
    // unwound handshake produces. Without the fix this unconditionally
    // re-enables Send while the second turn is still running.
    settleFirst(new Response(null, { status: 503 }));
    await pendingFirst;
    expect(sendButton.disabled).toBe(true);

    // The second turn actually settling is what correctly restores Send.
    sendEvent(eventSource, { kind: "session-state", state: "ready" });
    expect(sendButton.disabled).toBe(false);
    settleSecond(new Response(null, { status: 202 }));
    await pendingSecond;
  });

  it("keeps Send enabled when retry rejection and stale failure follow a fatal event", async () => {
    const { eventSource } = await loadChatModule();
    const enteredFirst = deferred();
    const enteredSecond = deferred();
    let settleFirst!: (response: Response) => void;
    let settleSecond!: (response: Response) => void;
    const pendingFirst = new Promise<Response>((resolve) => {
      settleFirst = resolve;
    });
    const pendingSecond = new Promise<Response>((resolve) => {
      settleSecond = resolve;
    });
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        enteredFirst.resolve();
        return pendingFirst;
      }
      enteredSecond.resolve();
      return pendingSecond;
    }) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;

    messageInput.value = "First";
    composer.requestSubmit();
    await enteredFirst.promise;
    expect(sendButton.disabled).toBe(true);

    sendEvent(eventSource, { kind: "error", message: "Driver exited unexpectedly.", fatal: true });
    expect(sendButton.disabled).toBe(false);

    messageInput.value = "Second";
    composer.requestSubmit();
    await enteredSecond.promise;
    expect(sendButton.disabled).toBe(true);

    settleSecond(new Response(null, { status: 409 }));
    await pendingSecond;
    expect(sendButton.disabled).toBe(false);

    // The fatal event is the last session-state update. Generation checks made
    // the retry's 409 and first request's late 500 both refuse to restore Send.
    // The user could recover only by reloading the page.
    settleFirst(new Response(null, { status: 500 }));
    await pendingFirst;
    expect(sendButton.disabled).toBe(false);
  });
});
