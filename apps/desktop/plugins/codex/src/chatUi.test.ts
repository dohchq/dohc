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
    <button id="stop" type="button" disabled></button>
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    sendEvent(eventSource, {
      kind: "auth",
      event: "account-updated",
      detail: "Logged in.",
      at,
      controls: { canSend: true, canStop: true, turnId: null },
      seq: 1,
    });
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
      controls: { canSend: true, canStop: true, turnId: null },
      seq: 1,
    });
    sendEvent(eventSource, {
      kind: "permission-resolved",
      requestId: "r1",
      decision: "allow_always",
      controls: { canSend: true, canStop: true, turnId: null },
      seq: 2,
    });
    expect(textOf(".permission-actions .timestamp")).toBe("Allowed for session");
  });

  it("applies the initial snapshot to the pill without a transcript card, even for a reasoned closed state", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, {
      kind: "session-state",
      state: "closed",
      reason: "Stopped",
      snapshot: true,
      controls: { canSend: true, canStop: false, turnId: null },
      seq: 1,
    });
    expect(textOf("#session-state")).toBe("Closed");
    expect(document.querySelectorAll(".error-card")).toHaveLength(0);

    // The same transition arriving as a real (non-snapshot) event does
    // render the card -- that is what actually narrates the transcript.
    sendEvent(eventSource, {
      kind: "session-state",
      state: "closed",
      reason: "Stopped",
      controls: { canSend: true, canStop: false, turnId: null },
      seq: 2,
    });
    expect(document.querySelectorAll(".error-card")).toHaveLength(1);
  });

  it("renders a default boundary for a reasonless close, so the next message doesn't silently start a fresh session", async () => {
    const { eventSource } = await loadChatModule();
    // Not the initial snapshot -- a real, later transition, exactly what an
    // idle CLI process exiting on its own looks like: closed, no reason.
    sendEvent(eventSource, {
      kind: "session-state",
      state: "closed",
      controls: { canSend: true, canStop: false, turnId: null },
      seq: 1,
    });
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
    sendEvent(eventSource, {
      kind: "error",
      message: "Codex exited unexpectedly.",
      fatal: true,
      controls: { canSend: true, canStop: false, turnId: null },
      seq: 1,
    });
    expect(textOf("#session-state")).toBe("Error");
    const card = document.querySelector(".error-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("Codex exited unexpectedly.");
    expect(card?.textContent).toContain("Send a message to start a new session.");
  });

  it("renders the restart-only next action for the MCP launcher error, not the generic resume instruction", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, {
      kind: "error",
      message: "dohc could not prepare its MCP launcher. Restart dohc to try again.",
      fatal: true,
      restartOnly: true,
      controls: { canSend: true, canStop: false, turnId: null },
      seq: 1,
    });

    const nextAction = textOf(".error-card .next-action");
    expect(nextAction).toBe("Restart dohc to try again.");
    expect(nextAction).not.toBe("Send a message to start a new session.");
  });

  it("renders a fallback failure line for a failed turn with no errorMessage, so it doesn't look like it succeeded", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, {
      kind: "turn-completed",
      turnId: 1,
      status: "failed",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 1,
    });
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
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 1,
    });
    const status = document.querySelector(".activity-status");
    expect(status?.textContent).toBe("Failed");
  });

  it("keeps replayed failures out of live regions while live failures alert", async () => {
    // A reconnect's replay rebuilds cards the reader already heard; only a
    // failure happening now may interrupt as an alert.
    const { eventSource } = await loadChatModule();
    const priorStatus = textOf("#status");
    sendEvent(eventSource, {
      kind: "error",
      message: "Old failure.",
      fatal: true,
      replay: true,
      controls: { canSend: true, canStop: false, turnId: 1 },
      seq: 1,
    });
    expect(textOf("#status")).toBe(priorStatus);
    sendEvent(eventSource, {
      kind: "session-state",
      state: "closed",
      reason: "Stopped",
      replay: true,
      controls: { canSend: true, canStop: false, turnId: 1 },
      seq: 2,
    });
    for (const card of document.querySelectorAll(".error-card")) {
      expect(card.getAttribute("role")).toBeNull();
    }
    sendEvent(eventSource, {
      kind: "error",
      message: "New failure.",
      fatal: true,
      controls: { canSend: true, canStop: false, turnId: 1 },
      seq: 3,
    });
    expect(textOf("#status")).toBe("Error");
    const cards = document.querySelectorAll(".error-card");
    expect(cards).toHaveLength(3);
    expect(cards[2]?.getAttribute("role")).toBe("alert");
    expect(cards[2]?.textContent).toContain("New failure.");
  });

  it("says earlier messages are missing when the replay was trimmed", async () => {
    const { eventSource } = await loadChatModule();
    sendEvent(eventSource, {
      kind: "history-trimmed",
      replay: true,
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 1,
    });
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
      sendEvent(eventSource, {
        kind: "text-delta",
        itemId: "i1",
        stream: "assistant",
        text,
        controls: { canSend: false, canStop: true, turnId: 1 },
        seq: 1,
      });
    }
    expect(textOf(".message.agent:not(.reasoning) .message-body")).toBe(full);
    // The reasoning stream renders separately, not appended into the reply.
    sendEvent(eventSource, {
      kind: "text-delta",
      itemId: "i1",
      stream: "reasoning",
      text: "thinking",
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 2,
    });
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
      sendEvent(eventSource, {
        kind: "text-delta",
        itemId: "i1",
        stream: "assistant",
        text: "x",
        controls: { canSend: false, canStop: true, turnId: 1 },
        seq: 1,
      });
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
    settleFetch(
      new Response(
        JSON.stringify({
          turnId: 1,
          controls: { canSend: false, canStop: true, turnId: 1 },
          seq: 1,
        }),
        { status: 202 },
      ),
    );
    await pending;
    const clientId = (JSON.parse(capturedBody ?? "{}") as { clientId?: string }).clientId;
    sendEvent(eventSource, {
      kind: "user-message",
      text: "Hello",
      clientId,
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 2,
    });

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

    settleFetch(
      new Response(
        JSON.stringify({
          message: "The message failed.",
          controls: { canSend: true, canStop: false, turnId: null },
          seq: 1,
        }),
        { status: 500 },
      ),
    );
    await pending;
    await flushMicrotasks();

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

  it("shows restart-only guidance on the optimistic message when the launcher is unavailable", async () => {
    await loadChatModule();
    const messageEntered = deferred();
    const messageResponse = deferred<Response>();
    globalThis.fetch = ((url: string) => {
      if (url !== "/message") throw new Error(`Unexpected fetch: ${url}`);
      messageEntered.resolve();
      return messageResponse.promise;
    }) as typeof fetch;

    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    messageInput.value = "Hello";
    composer.requestSubmit();
    await messageEntered.promise;

    messageResponse.resolve(
      new Response(
        JSON.stringify({
          message: "dohc could not prepare its MCP launcher. Restart dohc to try again.",
          kind: "restartOnly",
          controls: { canSend: true, canStop: false, turnId: null },
          seq: 1,
        }),
        { status: 503 },
      ),
    );
    await flushMicrotasks();

    expect(textOf(".message.user .send-failed")).toBe("Restart dohc to try again.");
  });

  it("keeps Send disabled when an older terminal frame arrives after a newer message acceptance", async () => {
    const { eventSource } = await loadChatModule();
    const messageResponse = deferred<Response>();
    globalThis.fetch = (() => messageResponse.promise) as typeof fetch;
    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;

    messageInput.value = "Hello";
    composer.requestSubmit();
    messageResponse.resolve(
      new Response(
        JSON.stringify({
          turnId: 1,
          controls: { canSend: false, canStop: true, turnId: 1 },
          seq: 5,
        }),
        { status: 202 },
      ),
    );
    await flushMicrotasks();
    expect(sendButton.disabled).toBe(true);

    sendEvent(eventSource, {
      kind: "turn-completed",
      controls: { canSend: true, canStop: true, turnId: null },
      seq: 4,
    });
    expect(textOf("#session-state")).toBe("Ready");
    expect(sendButton.disabled).toBe(true);

    sendEvent(eventSource, {
      kind: "turn-completed",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 6,
    });
    expect(sendButton.disabled).toBe(false);
  });

  it("follows server controls for Stop when message acceptance arrives before starting", async () => {
    const { eventSource } = await loadChatModule();
    const messageResponse = deferred<Response>();
    globalThis.fetch = (() => messageResponse.promise) as typeof fetch;
    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;
    const stopButton = document.querySelector("#stop") as HTMLButtonElement;

    messageInput.value = "Hello";
    composer.requestSubmit();
    messageResponse.resolve(
      new Response(
        JSON.stringify({
          turnId: 1,
          controls: { canSend: false, canStop: true, turnId: 1 },
          seq: 3,
        }),
        { status: 202 },
      ),
    );
    await flushMicrotasks();
    expect(sendButton.disabled).toBe(true);
    expect(stopButton.disabled).toBe(false);

    sendEvent(eventSource, {
      kind: "session-state",
      state: "starting",
      controls: { canSend: false, canStop: true, turnId: null },
      seq: 1,
    });
    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 2,
    });
    expect(stopButton.disabled).toBe(false);
    expect(sendButton.disabled).toBe(true);

    sendEvent(eventSource, {
      kind: "turn-completed",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 4,
    });
    expect(stopButton.disabled).toBe(false);
    expect(sendButton.disabled).toBe(false);

    sendEvent(eventSource, {
      kind: "error",
      message: "The session ended.",
      fatal: true,
      controls: { canSend: true, canStop: false, turnId: 1 },
      seq: 5,
    });
    expect(stopButton.disabled).toBe(true);
  });

  it("keeps Stop at the later click's state when an earlier response arrives last", async () => {
    const { eventSource } = await loadChatModule();
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return calls === 1 ? firstResponse.promise : secondResponse.promise;
    }) as typeof fetch;
    const stopButton = document.querySelector("#stop") as HTMLButtonElement;

    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 1,
    });
    stopButton.click();
    stopButton.click();
    expect(calls).toBe(2);

    secondResponse.resolve(
      new Response(
        JSON.stringify({
          controls: { canSend: true, canStop: false, turnId: 1 },
          seq: 10,
        }),
        { status: 200 },
      ),
    );
    await flushMicrotasks();
    expect(stopButton.disabled).toBe(true);

    firstResponse.resolve(
      new Response(
        JSON.stringify({
          controls: { canSend: false, canStop: true, turnId: 1 },
          seq: 5,
        }),
        { status: 200 },
      ),
    );
    await flushMicrotasks();
    expect(stopButton.disabled).toBe(true);
  });

  it("recovers Send from a live controls fact when the message response body is lost", async () => {
    const { eventSource } = await loadChatModule();
    const messageResponse = deferred<Response>();
    globalThis.fetch = (() => messageResponse.promise) as typeof fetch;
    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;

    sendEvent(eventSource, {
      kind: "session-state",
      state: "ready",
      controls: { canSend: true, canStop: true, turnId: null },
      seq: 1,
    });
    messageInput.value = "Hello";
    composer.requestSubmit();
    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 2,
    });
    expect(sendButton.disabled).toBe(true);

    messageResponse.resolve(new Response(null, { status: 202 }));
    await flushMicrotasks();
    expect(sendButton.disabled).toBe(true);

    sendEvent(eventSource, {
      kind: "turn-completed",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 3,
    });
    expect(sendButton.disabled).toBe(false);
  });

  it("re-enables Send from the reconnect snapshot when the turn settled while disconnected", async () => {
    const { eventSource } = await loadChatModule();
    const messageResponse = deferred<Response>();
    globalThis.fetch = (() => messageResponse.promise) as typeof fetch;
    const messageInput = document.querySelector("#message") as HTMLTextAreaElement;
    const composer = document.querySelector("#composer") as HTMLFormElement;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;

    messageInput.value = "Hello";
    composer.requestSubmit();
    messageResponse.resolve(
      new Response(
        JSON.stringify({
          turnId: 1,
          controls: { canSend: false, canStop: true, turnId: 1 },
          seq: 2,
        }),
        { status: 202 },
      ),
    );
    await flushMicrotasks();
    expect(sendButton.disabled).toBe(true);

    sendEvent(eventSource, {
      kind: "session-state",
      state: "ready",
      snapshot: true,
      controls: { canSend: true, canStop: false, turnId: 1 },
      seq: 3,
    });
    expect(sendButton.disabled).toBe(false);
  });

  it("shows an error card when Stop fails", async () => {
    const { eventSource } = await loadChatModule();
    const stopResponse = deferred<Response>();
    globalThis.fetch = (() => stopResponse.promise) as typeof fetch;
    const stopButton = document.querySelector("#stop") as HTMLButtonElement;

    sendEvent(eventSource, {
      kind: "session-state",
      state: "ready",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 1,
    });
    stopButton.click();
    stopResponse.resolve(
      new Response(
        JSON.stringify({
          message: "Stop failed.",
          controls: { canSend: true, canStop: true, turnId: 1 },
          seq: 2,
        }),
        { status: 500 },
      ),
    );
    await flushMicrotasks();

    expect(textOf(".error-card")).toContain("dohc could not stop this session.");
    expect(stopButton.disabled).toBe(false);
  });

  it("Stop 1 rejects during turn 2 -- no stale failure card", async () => {
    const { eventSource } = await loadChatModule();
    const stopResponse = deferred<Response>();
    globalThis.fetch = (() => stopResponse.promise) as typeof fetch;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;
    const stopButton = document.querySelector("#stop") as HTMLButtonElement;

    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 1,
    });
    stopButton.click();
    sendEvent(eventSource, {
      kind: "turn-completed",
      turnId: 1,
      status: "completed",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 2,
    });
    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 2 },
      seq: 3,
    });

    stopResponse.reject(new Error("The old Stop request lost its connection."));
    await flushMicrotasks();

    expect(document.querySelectorAll(".error-card")).toHaveLength(0);
    expect(sendButton.disabled).toBe(true);
    expect(stopButton.disabled).toBe(false);
  });

  it("Stop 1's old failure response arrives during turn 2 -- no stale failure card", async () => {
    const { eventSource } = await loadChatModule();
    const stopResponse = deferred<Response>();
    globalThis.fetch = (() => stopResponse.promise) as typeof fetch;
    const sendButton = document.querySelector("#send") as HTMLButtonElement;
    const stopButton = document.querySelector("#stop") as HTMLButtonElement;

    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 1 },
      seq: 1,
    });
    stopButton.click();
    sendEvent(eventSource, {
      kind: "turn-completed",
      turnId: 1,
      status: "completed",
      controls: { canSend: true, canStop: true, turnId: 1 },
      seq: 2,
    });
    sendEvent(eventSource, {
      kind: "session-state",
      state: "running",
      controls: { canSend: false, canStop: true, turnId: 2 },
      seq: 3,
    });

    stopResponse.resolve(
      new Response(
        JSON.stringify({
          message: "Stop failed.",
          controls: { canSend: true, canStop: true, turnId: 1 },
          seq: 2,
        }),
        { status: 500 },
      ),
    );
    await flushMicrotasks();

    expect(document.querySelectorAll(".error-card")).toHaveLength(0);
    expect(sendButton.disabled).toBe(true);
    expect(stopButton.disabled).toBe(false);
  });
});
