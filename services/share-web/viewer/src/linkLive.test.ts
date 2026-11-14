import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { encodeLiveFrameSync } from "@dohc/live-session-contract/live-frame";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { openLinkDocument } from "./linkLive";

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
const binding: LiveObjectBinding = {
  workspaceId: "workspace",
  mainVersionId: "main",
  objectId: "document",
  lineageClaimId: "lineage",
  currentPath: "docs/a.md",
  selectorPaths: ["docs/a.md"],
  restoreFenceGeneration: 0,
};
afterEach(() => {
  vi.unstubAllGlobals();
});

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
      return new Response(bytes, {
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
