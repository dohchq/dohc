// @vitest-environment jsdom
import {afterEach, expect, it, vi} from "vitest";
import {openLinkDocument} from "./linkLive";

const limits = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
it("opens the link socket with a one-use ticket and cookie credentials without account or capability material", async () => {
  const calls: {url: string; protocols: string[]}[] = [];
  class Socket extends EventTarget {
    readyState = 1; bufferedAmount = 0; protocol = "dohc-live-v1"; extensions = ""; binaryType = "arraybuffer";
    constructor(url: string, protocols: string[]) {super(); calls.push({url, protocols}); queueMicrotask(() => this.dispatchEvent(new Event("open")));}
    send() {} close() {this.readyState = 3;}
  }
  vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("location", {origin: "https://share.example.test"});
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("same-origin"); expect(init?.redirect).toBe("error");
    if (url === "/api/live/link-document") {
      expect(JSON.parse(String(init?.body))).toEqual({discriminator: "abcdefghijkl", path: "docs/a.md"});
      return Response.json({objectId: "object-a", limits});
    }
    expect(url).toBe("/api/live/link-ticket"); expect(JSON.parse(String(init?.body))).toEqual({discriminator: "abcdefghijkl", objectId: "object-a"});
    return Response.json({token: "ab".repeat(32), expiresAtMs: Date.now() + 60_000});
  });
  vi.stubGlobal("fetch", fetch);
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await session.reconnect();
    expect(calls).toEqual([{url: "wss://share.example.test/api/live/link?session=abcdefghijkl", protocols: ["dohc-live-v1", `dohc-live-ticket.${"ab".repeat(32)}`]}]);
    expect(fetch).toHaveBeenCalledTimes(2); expect(session.state().status).toBe("connecting");
  } finally {session.close();}
});
it("refuses unexpected metadata fields and responses arriving after selection cancellation", async () => {
  vi.stubGlobal("location", {origin: "https://share.example.test"});
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({objectId: "object-a", limits, capabilityToken: "private"})));
  await expect(openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal)).rejects.toThrow("Invalid file");
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async () => {controller.abort(); return Response.json({objectId: "object-a", limits});}));
  await expect(openLinkDocument("abcdefghijkl", "docs/a.md", controller.signal)).rejects.toThrow();
});
// The share service answers 404 when the owner's device cannot serve the file
// yet. The server answered, so the viewer must not blame the connection.
it("reports a refused link ticket as unavailable, not as a failed connection", async () => {
  vi.stubGlobal("location", {origin: "https://share.example.test"});
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => url === "/api/live/link-document"
    ? Response.json({objectId: "object-a", limits})
    : Response.json({ok: false, error: "not found"}, {status: 404})));
  const session = await openLinkDocument("abcdefghijkl", "docs/a.md", new AbortController().signal);
  try {
    await session.reconnect();
    expect(session.state()).toMatchObject({status: "disconnected", reason: "authority-unavailable"});
  } finally {session.close();}
});
