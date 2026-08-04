import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it } from "vitest";
import { claimRelayWorkspace } from "../../e2e/helpers/relayPeer";
import {
  spawnSyncRelay,
  type SyncRelayHandle,
} from "../../e2e/helpers/syncRelay";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "../workspaces/engineRelayClient";
import { requireEngineBinaryOrSkip } from "./engineBinary";
import { RelayFilePeer } from "./relayFilePeer";
import { createTestScratch } from "../workspaces/testTemp";

interface RecordedRequest {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

function recordingRelay(): {
  requests: RecordedRequest[];
  fetch: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const stored = new Set<string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url: url.pathname,
      method: init?.method ?? "GET",
      body: init?.body,
    });
    if (url.pathname.endsWith("/blobs/have")) {
      const body = JSON.parse(String(init?.body)) as { sha256s: string[] };
      return Response.json({
        ok: true,
        missing: body.sha256s.filter((sha256) => !stored.has(sha256)),
      });
    }
    if (init?.method === "PUT") {
      stored.add(url.pathname.split("/").at(-1)!);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/log")) {
      const body = JSON.parse(String(init?.body)) as {
        ops: Array<{ originSeq: number }>;
      };
      return Response.json({
        ok: true,
        currentMaxOriginSeq: body.ops.at(-1)?.originSeq ?? -1,
      });
    }
    return new Response("unexpected route", { status: 500 });
  };
  return { requests, fetch: fetchImpl };
}

function logOperations(requests: RecordedRequest[]): Array<{
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
}> {
  return requests
    .filter((request) => request.url.endsWith("/log"))
    .flatMap((request) => {
      const body = JSON.parse(String(request.body)) as {
        ops: Array<{
          originSeq: number;
          opKind: string;
          payload: Record<string, unknown>;
        }>;
      };
      return body.ops;
    });
}

describe("RelayFilePeer", () => {
  it("uploads blobs and preserves contiguous coordinates with exact write preimages", async () => {
    const relay = recordingRelay();
    let nextId = 0;
    const peer = new RelayFilePeer({
      baseUrl: "https://relay.test",
      token: "peer-token",
      workspaceId: "workspace-a",
      originId: "peer-a",
      fetch: relay.fetch,
      nowMs: () => 1_000,
      newId: (kind) => `${kind}-${nextId++}`,
    });

    const [first] = await Promise.all([
      peer.writeText("notes/a.md", "first"),
      peer.writeText("notes/a.md", "second"),
    ]);

    const operations = logOperations(relay.requests);
    expect(
      operations.map((operation) => operation.originSeq),
      "MUTATION: a helper-owned origin must never skip or reuse a coordinate",
    ).toEqual([0, 1, 2]);
    expect(operations.map((operation) => operation.opKind)).toEqual([
      "workspace.init",
      "moment.append",
      "moment.append",
    ]);

    const firstPayload = operations[1]!.payload;
    expect(firstPayload).toMatchObject({
      objectId: first.objectId,
      objectCreatedAtMs: first.objectCreatedAtMs,
      path: "notes/a.md",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      beforePresent: "null",
    });
    expect(firstPayload).not.toHaveProperty("beforeLatestMomentId");

    expect(
      operations[2]!.payload,
      "MUTATION: a rewrite must carry the complete prior head, not only its blob hash",
    ).toMatchObject({
      objectId: first.objectId,
      objectCreatedAtMs: first.objectCreatedAtMs,
      path: first.path,
      payloadBeforeBlobSha256: first.blobSha256,
      payloadBeforePath: first.path,
      beforePresent: "present",
      beforeObjectId: first.objectId,
      beforeVersionId: "main",
      beforePath: first.path,
      beforeBlobSha256: first.blobSha256,
      beforeUpdatedAtMs: first.updatedAtMs,
      beforeLatestMomentId: first.latestMomentId,
      beforeMetadata: first.metadata,
    });

    const firstHave = relay.requests.findIndex((request) =>
      request.url.endsWith("/blobs/have"),
    );
    const firstPut = relay.requests.findIndex(
      (request) => request.method === "PUT",
    );
    const firstMomentAppend = relay.requests.findIndex((request) => {
      if (!request.url.endsWith("/log")) return false;
      return String(request.body).includes('"opKind":"moment.append"');
    });
    expect(
      [firstHave, firstPut, firstMomentAppend],
      "MUTATION: the peer must inventory and upload content before it appends the referencing moment",
    ).toEqual([1, 2, 3]);
    const uploaded = relay.requests[firstPut]!;
    expect(uploaded.url).toContain(first.blobSha256);
    expect(Buffer.from(uploaded.body as ArrayBuffer).toString("utf8")).toBe("first");
  });

  it("uses the staged head when one batch rewrites the same path", async () => {
    const relay = recordingRelay();
    let nextId = 0;
    const peer = new RelayFilePeer({
      baseUrl: "https://relay.test",
      token: "peer-token",
      workspaceId: "workspace-a",
      originId: "peer-a",
      fetch: relay.fetch,
      nowMs: () => 1_000,
      newId: (kind) => `${kind}-${nextId++}`,
    });

    const [first, second] = await peer.writeTextFiles([
      { path: "notes/a.md", text: "first" },
      { path: "notes/a.md", text: "second" },
    ]);

    const operations = logOperations(relay.requests);
    expect(operations.map((operation) => operation.originSeq)).toEqual([0, 1, 2]);
    expect(operations[2]!.payload).toMatchObject({
      objectId: first!.objectId,
      objectCreatedAtMs: first!.objectCreatedAtMs,
      path: first!.path,
      payloadBeforeBlobSha256: first!.blobSha256,
      payloadBeforePath: first!.path,
      beforePresent: "present",
      beforeObjectId: first!.objectId,
      beforeVersionId: "main",
      beforePath: first!.path,
      beforeBlobSha256: first!.blobSha256,
      beforeUpdatedAtMs: first!.updatedAtMs,
      beforeLatestMomentId: first!.latestMomentId,
      beforeMetadata: first!.metadata,
      payloadAfterBlobSha256: second!.blobSha256,
    });
  });

  it("creates a linked chat thread before its authored message", async () => {
    const relay = recordingRelay();
    let nextId = 0;
    const peer = new RelayFilePeer({
      baseUrl: "https://relay.test",
      token: "peer-token",
      workspaceId: "workspace-a",
      originId: "peer-a",
      fetch: relay.fetch,
      nowMs: () => 1_000,
      newId: (kind) => `${kind}-${nextId++}`,
    });

    const chat = await peer.createLinkedChat({
      linkedObjectId: "object-a",
      linkedPathHint: "notes/a.md",
      title: "Review",
      body: "Please review this note.",
      authorDisplayName: "Ada",
      authorUserId: "user-a",
    });

    const operations = logOperations(relay.requests);
    expect(operations.map((operation) => operation.originSeq)).toEqual([0, 1, 2]);
    expect(operations.map((operation) => operation.opKind)).toEqual([
      "workspace.init",
      "chat.thread.create",
      "chat.message.append",
    ]);
    expect(operations[1]!.payload).toMatchObject({
      threadId: chat.threadId,
      linkedObjectId: "object-a",
      linkedPathHint: "notes/a.md",
    });
    expect(operations[2]!.payload).toMatchObject({
      messageId: chat.messageId,
      threadId: chat.threadId,
      authorUserId: "user-a",
    });
  });

  it("names the relay request path and timeout when a request expires", async () => {
    const timeout = new Error("request expired");
    timeout.name = "TimeoutError";
    const peer = new RelayFilePeer({
      baseUrl: "https://relay.test",
      token: "peer-token",
      workspaceId: "workspace-a",
      originId: "peer-a",
      fetch: async () => {
        throw timeout;
      },
    });

    await expect(peer.initialize()).rejects.toThrow(
      "Relay request /sync/workspace-a/log timed out after 15000 ms.",
    );
  });

  it("keeps the relay timeout context while reading a response body", async () => {
    const timeout = new Error("body expired");
    timeout.name = "AbortError";
    const response = Response.json({ ok: true, missing: [] });
    Object.defineProperty(response, "json", {
      value: async () => {
        throw timeout;
      },
    });
    const peer = new RelayFilePeer({
      baseUrl: "https://relay.test",
      token: "peer-token",
      workspaceId: "workspace-a",
      originId: "peer-a",
      fetch: async () => response,
    });

    await expect(peer.writeText("notes/a.md", "hello")).rejects.toThrow(
      "Relay request /sync/workspace-a/blobs/have timed out after 15000 ms.",
    );
  });
});

const engine = requireEngineBinaryOrSkip();

describe("RelayFilePeer receiver contract", () => {
  it.skipIf(engine.missing)(
    "opens a conflict when a rewrite names the wrong prior moment",
    async () => {
      const workspaceId = `relay-file-conflict-${process.pid}-${Date.now()}`;
      const token = "test:relay-file-conflict";
      const baseDir = await createTestScratch("relay-file-conflict-");
      const rootPath = join(baseDir, "receiver");
      const relayDb = join(baseDir, "relay.sqlite");
      let relay: SyncRelayHandle | null = null;
      let lifecycle: EngineDaemonLifecycle | null = null;
      let sessions: EngineWorkspaceSessions | null = null;
      try {
        await mkdir(join(rootPath, ".dohc", "engine"), { recursive: true });
        await writeFile(
          join(rootPath, ".dohc", "engine", "SHADOW_CLONE"),
          randomBytes(32).toString("hex"),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        relay = await spawnSyncRelay({ dbPath: relayDb });
        await claimRelayWorkspace({ baseUrl: relay.baseUrl, token, workspaceId });
        const identity = {
          replicationEpoch: "relay-file-conflict-epoch",
          streamIdentity: "relay-file-conflict-stream",
        };
        const peer = new RelayFilePeer({
          baseUrl: relay.baseUrl,
          token,
          workspaceId,
          originId: "remote-writer",
          identity,
        });
        const first = await peer.writeText("notes/conflict.md", "first\n");
        await peer.writeText({
          path: "notes/conflict.md",
          text: "second\n",
          beforeOverride: {
            ...first,
            latestMomentId: "wrong-prior-moment",
          },
        });

        lifecycle = new EngineDaemonLifecycle({
          command: engine.require(),
          requestTimeoutMs: 15_000,
        });
        await lifecycle.start();
        const routes = new RelayTransportRouteGuard();
        sessions = new EngineWorkspaceSessions(
          new RelayConfiguredDaemonClientSource(lifecycle, routes),
          { workspaceOpenDeadlineMs: 10_000 },
        );
        const receiver = new EngineRelayClient({
          sessions,
          routes,
          allowInsecureLoopbackForTests: true,
          requestDeadlineMs: 15_000,
        }).bind({
          workspaceId,
          rootPath,
          relay: { baseUrl: relay.baseUrl, token },
        });

        await receiver.bootstrapJoinIdentity(identity);
        const pulled = await receiver.pull();
        expect(
          pulled.conflictsOpened,
          "MUTATION: accepting a false beforeLatestMomentId would silently overwrite the receiver head",
        ).toBe(1);
        await pulled.commitFetchCursor();
      } finally {
        await sessions?.closeAll().catch(() => undefined);
        await lifecycle?.stop().catch(() => undefined);
        await relay?.stop().catch(() => undefined);
        await rm(baseDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
