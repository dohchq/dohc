// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { encodeLiveFrameSync } from "@dohc/live-session-contract/live-frame";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { openLinkDocument, showLinkDocument, SHOWN_STATE_FRESH_MS } from "./linkLive";
import * as browserTransport from "@dohc/ydoc-projection/named-live-browser-transport";
import {
  LINK_REFUSALS,
  linkRefusalBody,
  type LinkRefusalCode,
} from "@dohc/security-contract/link-refusal";

const limits = {
  provider: {
    frames: {
      receive: {
        maxFrameBytes: 1024,
        maxStateVectorBytes: 4096,
        maxUpdateBytes: 8192,
        maxSyncBytes: 16384,
      },
      maxQueuedBytes: 16384,
      maxQueuedFrames: 64,
      maxControlBytes: 4096,
      maxControlFrames: 8,
      maxAssemblyBytes: 16384,
    },
    maxPendingUpdateBytes: 16384,
    maxPendingUpdates: 8,
    maxDeliveryAttempts: 4,
  },
  maxHttpResponseBytes: 16384,
  maxSocketBufferedBytes: 16384,
  connectTimeoutMs: 2000,
  sendTimeoutMs: 500,
  drainPollMs: 10,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
// app_collection_missing comes only from an app's routes, and link_too_many_files only from a
// member's file list, never from a live link.
const liveLinkRefusals = (Object.keys(LINK_REFUSALS) as LinkRefusalCode[]).filter(
  (code) => code !== "app_collection_missing" && code !== "link_too_many_files",
);
it.each(liveLinkRefusals)("shows the scoped refusal %s", async (code) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(linkRefusalBody(code), { status: LINK_REFUSALS[code].status })),
  );
  await expect(
    openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal),
  ).rejects.toThrow(LINK_REFUSALS[code].error);
});
it("opens the link socket with a one-use ticket and cookie credentials without account or capability material", async () => {
  const create = vi.spyOn(browserTransport, "createNamedLiveBrowserTransport");
  const calls: { url: string; protocols: string[] }[] = [];
  class Socket extends EventTarget {
    readyState = 1;
    bufferedAmount = 0;
    protocol = "dohc-live-v1";
    extensions = "";
    binaryType = "arraybuffer";
    constructor(url: string, protocols: string[]) {
      super();
      calls.push({ url, protocols });
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://share.example.test" });
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("same-origin");
    expect(init?.redirect).toBe("error");
    if (url === "/api/live/link-document") {
      expect(JSON.parse(String(init?.body))).toEqual({
        discriminator: "abcdefghijkl",
        path: "docs/a.md",
      });
      return Response.json({ objectId: "object-a", limits });
    }
    if (url === "/api/live/link-document-state") return new Response(null, { status: 204 });
    expect(url).toBe("/api/live/link-ticket");
    expect(JSON.parse(String(init?.body))).toEqual({
      discriminator: "abcdefghijkl",
      objectId: "object-a",
    });
    return Response.json({
      token: "ab".repeat(32),
      publicPrincipalId: "public-link-a",
      expiresAtMs: Date.now() + 60_000,
    });
  });
  vi.stubGlobal("fetch", fetch);
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await session.reconnect();
    expect(calls).toEqual([
      {
        url: "wss://share.example.test/api/live/link?session=abcdefghijkl",
        protocols: ["dohc-live-v1", `dohc-live-ticket.${"ab".repeat(32)}`],
      },
    ]);
    // The file, its early state, then the ticket.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(session.state().status).toBe("connecting");
    expect(create.mock.calls[0]![0].recordingContext!({ objectId: "object-a" })).toEqual({
      kind: "link",
      publicPrincipalId: "public-link-a",
    });
    fetch.mockImplementationOnce(async () =>
      Response.json({
        token: "cd".repeat(32),
        publicPrincipalId: "public-link-b",
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    await session.reconnect();
    expect(calls).toHaveLength(1);
    expect(create.mock.calls[0]![0].recordingContext!({ objectId: "object-a" })).toEqual({
      kind: "link",
      publicPrincipalId: "public-link-a",
    });
  } finally {
    session.close();
  }
});
it("refuses unexpected metadata fields and responses arriving after selection cancellation", async () => {
  vi.stubGlobal("location", { origin: "https://share.example.test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ objectId: "object-a", limits, capabilityToken: "private" })),
  );
  await expect(
    openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal),
  ).rejects.toThrow("Invalid file");
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      controller.abort();
      return Response.json({ objectId: "object-a", limits });
    }),
  );
  await expect(openLinkDocument("abcdefghijkl", "docs/a.md", controller.signal)).rejects.toThrow();
});
it("reports a link ticket that is not found as a file that moved or was removed, not as a failed connection", async () => {
  vi.stubGlobal("location", { origin: "https://share.example.test" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) =>
      url === "/api/live/link-document"
        ? Response.json({ objectId: "object-a", limits })
        : Response.json({ ok: false, error: "not found" }, { status: 404 }),
    ),
  );
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await session.reconnect();
    expect(session.state()).toMatchObject({
      status: "disconnected",
      reason: "document-gone",
    });
  } finally {
    session.close();
  }
});
// The answer doesn't change until the owner makes a new link.
it.each([["link_full", "link-full"]] as const)(
  "stops on %s without trying again",
  async (code, reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "https://share.example.test" });
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      url === "/api/live/link-document"
        ? Response.json({ objectId: "object-a", limits })
        : Response.json(linkRefusalBody(code), { status: LINK_REFUSALS[code].status }),
    );
    vi.stubGlobal("fetch", fetch);
    const session = await openLinkDocument(
      "abcdefghijkl",
      "docs/a.md",
      new AbortController().signal,
    );
    try {
      await session.reconnect();
      expect(session.state()).toMatchObject({ status: "disconnected", reason });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  },
);
// Only the owner can start live editing again, so the page asks every 30 seconds and opens the file once it started.
it("asks every 30 seconds while live editing is stopped, and opens the file once it started again", async () => {
  vi.useFakeTimers();
  class Socket extends EventTarget {
    readyState = 1;
    bufferedAmount = 0;
    protocol = "dohc-live-v1";
    extensions = "";
    binaryType = "arraybuffer";
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://share.example.test" });
  let stopped = true;
  const fetch = vi.fn(async (url: RequestInfo | URL) =>
    url === "/api/live/link-document"
      ? Response.json({ objectId: "object-a", limits })
      : stopped
        ? Response.json(linkRefusalBody("link_live_stopped"), { status: 503 })
        : Response.json({
            token: "ab".repeat(32),
            publicPrincipalId: "public-link-a",
            expiresAtMs: Date.now() + 60_000,
          }),
  );
  vi.stubGlobal("fetch", fetch);
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await session.reconnect();
    expect(session.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(session.state()).toMatchObject({ status: "disconnected", reason: "live-stopped" });
    stopped = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.state().status).toBe("connecting");
    expect(fetch).toHaveBeenCalledTimes(6);
  } finally {
    session.close();
    vi.useRealTimers();
  }
});
// After a server restart the share service answers 503 until live editing can start again.
it("tries a busy link ticket again by itself and opens the file once the server answers", async () => {
  class Socket extends EventTarget {
    readyState = 1;
    bufferedAmount = 0;
    protocol = "dohc-live-v1";
    extensions = "";
    binaryType = "arraybuffer";
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://share.example.test" });
  let busy = true;
  const fetch = vi.fn(async (url: RequestInfo | URL) =>
    url === "/api/live/link-document"
      ? Response.json({ objectId: "object-a", limits })
      : busy
        ? Response.json(linkRefusalBody("link_live_unavailable"), { status: 503 })
        : Response.json({
            token: "ab".repeat(32),
            publicPrincipalId: "public-link-a",
            expiresAtMs: Date.now() + 60_000,
          }),
  );
  vi.stubGlobal("fetch", fetch);
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await session.reconnect();
    expect(session.state()).toMatchObject({ status: "disconnected", reason: "host-unavailable" });
    busy = false;
    await vi.waitFor(() => expect(session.state().status).toBe("connecting"));
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally {
    session.close();
  }
});
const binding: LiveObjectBinding = {
  workspaceId: "workspace",
  mainVersionId: "main",
  objectId: "document",
  lineageClaimId: "lineage",
  currentPath: "docs/a.md",
  selectorPaths: ["docs/a.md"],
  restoreFenceGeneration: 0,
};
it("takes the host's early state for a link's file before the page asks for a ticket", async () => {
  const host = markdownToYDoc("Shared text");
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/live/link-document") return Response.json({ objectId: "document", limits });
    if (path === "/api/live/link-document-state") {
      expect(JSON.parse(init.body as string)).toEqual({
        discriminator: "abcdefghijkl",
        path: "docs/a.md",
      });
      const bytes = encodeLiveFrameSync(
        {
          binding,
          hostVector: Y.encodeStateVector(host),
          missingStateUpdate: Y.encodeStateAsUpdate(host),
        },
        limits.provider.frames.receive,
      );
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          "content-type": "application/octet-stream",
          "x-dohc-live-object-id": "document",
          "x-dohc-live-applied-through": "7",
        },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("location", { origin: "https://share.example" });
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await vi.waitFor(() => expect(session.state().typingAhead).toBe(true));
    expect(session.state()).toMatchObject({ status: "disconnected", binding });
    expect(session.body.toString()).toContain("Shared text");
  } finally {
    session.close();
  }
});

const stateAnswer = (host: Y.Doc, through: number) =>
  new Response(
    encodeLiveFrameSync(
      {
        binding,
        hostVector: Y.encodeStateVector(host),
        missingStateUpdate: Y.encodeStateAsUpdate(host),
      },
      limits.provider.frames.receive,
    ) as Uint8Array<ArrayBuffer>,
    {
      headers: {
        "content-type": "application/octet-stream",
        "x-dohc-live-object-id": "document",
        "x-dohc-live-applied-through": String(through),
      },
    },
  );

it.each([
  { press: SHOWN_STATE_FRESH_MS, typesOn: "Shared text", asks: 1 },
  // Another person's edit lands after the page showed the note. A press past the age limit must not type on the copy
  // from before it.
  { press: SHOWN_STATE_FRESH_MS + 1, typesOn: "Shared text, edited", asks: 2 },
  // The clock was set back after the page showed the note, so the copy's real age is unknown.
  { press: -1, typesOn: "Shared text, edited", asks: 2 },
])(
  "takes the state fetched when the note was shown only while it is young ($press ms)",
  async ({ press, typesOn, asks }) => {
    const host = markdownToYDoc("Shared text");
    let through = 7;
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/live/link-document")
        return Response.json({ objectId: "document", limits });
      if (path === "/api/live/link-document-state") return stateAnswer(host, through);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { origin: "https://share.example" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    showLinkDocument("abcdefghijkl", "docs/a.md");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const paragraph = host.getXmlFragment("body").get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert("Shared text".length, ", edited");
    through = 8;
    now.mockReturnValue(1_000 + press);
    const session = await openLinkDocument(
      "abcdefghijkl",
      "docs/a.md",
      new AbortController().signal,
    );
    try {
      await vi.waitFor(() => expect(session.state().typingAhead).toBe(true));
      const text = (session.body.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      expect(text.toString()).toBe(typesOn);
      expect(
        fetch.mock.calls.filter(([path]) => path === "/api/live/link-document-state"),
      ).toHaveLength(asks);
    } finally {
      session.close();
    }
  },
);
