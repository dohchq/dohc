import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayUnauthorizedError,
  claimRelayWorkspace,
  createLinkedChatStore,
  createVersionedTextStore,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  type SyncReplicationEnvelope,
} from ".";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKSPACE_ID = "workspace-relay-unit";
const TOKEN = "token-a";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-relay-unit-${label}-`));
  roots.push(root);
  return root;
}

function sha256(bytes: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof bytes === "string") hash.update(bytes, "utf8");
  else hash.update(bytes);
  return hash.digest("hex");
}

class FakeRelay {
  readonly baseUrl = "http://relay.test";
  readonly blobs = new Map<string, Uint8Array>();
  readonly log: Array<SyncReplicationEnvelope & { relaySeq: number }> = [];
  readonly owners = new Map<string, string>();
  nextRelaySeq = 1;
  corruptBlobGets = false;
  failAuth = false;
  logPostCount = 0;

  connection(token = TOKEN) {
    return {
      baseUrl: this.baseUrl,
      token,
      fetch: this.fetch,
    };
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request =
      url instanceof Request
        ? url
        : new Request(String(url), init);
    const parsed = new URL(request.url);
    const auth = request.headers.get("authorization") ?? "";
    if (this.failAuth || auth !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const userId = "user-a";
    const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "sync") return new Response("not found", { status: 404 });

    if (parts[1] === "workspaces" && request.method === "POST") {
      const body = (await request.json()) as { workspaceId: string };
      const existing = this.owners.get(body.workspaceId);
      if (existing && existing !== userId) return new Response("not found", { status: 404 });
      this.owners.set(body.workspaceId, userId);
      return Response.json({ ok: true, workspaceId: body.workspaceId, created: !existing });
    }

    const workspaceId = parts[1];
    if (!workspaceId || this.owners.get(workspaceId) !== userId) {
      return new Response("not found", { status: 404 });
    }

    if (parts[2] === "blobs" && parts[3] === "have" && request.method === "POST") {
      const body = (await request.json()) as { sha256s: string[] };
      return Response.json({
        ok: true,
        missing: body.sha256s.filter((hash) => !this.blobs.has(hash)),
      });
    }

    if (parts[2] === "blobs" && parts[3] && request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (sha256(bytes) !== parts[3]) {
        return Response.json({ ok: false, error: "hash mismatch" }, { status: 400 });
      }
      this.blobs.set(parts[3], bytes);
      return Response.json({ ok: true, sha256: parts[3], byteLength: bytes.byteLength });
    }

    if (parts[2] === "blobs" && parts[3] && request.method === "GET") {
      const bytes = this.blobs.get(parts[3]);
      if (!bytes) return new Response("not found", { status: 404 });
      const body = this.corruptBlobGets ? Buffer.from("corrupt") : Buffer.from(bytes);
      return new Response(body);
    }

    if (parts[2] === "log" && request.method === "GET") {
      const since = Number(parsed.searchParams.get("since") ?? "0");
      const limit = Number(parsed.searchParams.get("limit") ?? "100");
      const rows = this.log.filter((op) => op.relaySeq > since).slice(0, limit);
      const nextCursor = rows.at(-1)?.relaySeq ?? since;
      return Response.json({
        ok: true,
        ops: rows.map(({ relaySeq, workspaceId, originId, originSeq, opKind, payload, recordedAtMs }) => ({
          relaySeq,
          workspaceId,
          originId,
          originSeq,
          opKind,
          payload,
          recordedAtMs,
        })),
        nextCursor,
        hasMore: this.log.some((op) => op.relaySeq > nextCursor),
      });
    }

    if (parts[2] === "log" && request.method === "POST") {
      this.logPostCount += 1;
      const body = (await request.json()) as {
        originId: string;
        ops: Array<{
          originSeq: number;
          opKind: SyncReplicationEnvelope["opKind"];
          payload: unknown;
          recordedAtMs: number;
        }>;
      };
      const currentMax = Math.max(
        -1,
        ...this.log
          .filter((op) => op.workspaceId === workspaceId && op.originId === body.originId)
          .map((op) => op.originSeq),
      );
      let inserted = 0;
      let skipped = 0;
      for (const op of body.ops) {
        if (op.originSeq <= currentMax) {
          const existing = this.log.find(
            (row) =>
              row.workspaceId === workspaceId &&
              row.originId === body.originId &&
              row.originSeq === op.originSeq,
          );
          if (
            !existing ||
            existing.opKind !== op.opKind ||
            JSON.stringify(existing.payload) !== JSON.stringify(op.payload)
          ) {
            return Response.json({ ok: false, error: "conflict" }, { status: 409 });
          }
          skipped += 1;
          continue;
        }
        const expected = Math.max(
          -1,
          ...this.log
            .filter((row) => row.workspaceId === workspaceId && row.originId === body.originId)
            .map((row) => row.originSeq),
        ) + 1;
        if (op.originSeq !== expected) {
          return Response.json({ ok: false, error: "gap" }, { status: 409 });
        }
        this.log.push({
          workspaceId,
          originId: body.originId,
          originSeq: op.originSeq,
          opKind: op.opKind,
          payload: op.payload as never,
          recordedAtMs: op.recordedAtMs,
          relaySeq: this.nextRelaySeq,
        } as SyncReplicationEnvelope & { relaySeq: number });
        this.nextRelaySeq += 1;
        inserted += 1;
      }
      const maxAfter = Math.max(
        -1,
        ...this.log
          .filter((op) => op.workspaceId === workspaceId && op.originId === body.originId)
          .map((op) => op.originSeq),
      );
      return Response.json({
        ok: true,
        accepted: body.ops.length,
        inserted,
        skipped,
        currentMaxOriginSeq: maxAfter,
      });
    }

    return new Response("not found", { status: 404 });
  };
}

async function seedText(root: string, path = "docs/a.md", text = "hello\n") {
  const store = createVersionedTextStore(root, { nowMs: () => 1000 });
  try {
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path,
      text,
      metadata: { origin: "api" },
    });
  } finally {
    await store.close();
  }
}

async function readText(root: string, path = "docs/a.md"): Promise<string | null> {
  const store = createVersionedTextStore(root);
  try {
    return (await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path }))?.text ?? null;
  } finally {
    await store.close();
  }
}

describe("sync relay client", () => {
  it("round-trips push and bootstrap pull through an injected relay", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("a");
    const b = await tempRoot("b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await expect(pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() })).resolves.toMatchObject({
      pushed: 2,
    });

    const pulled = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    expect(pulled.fetched).toBe(2);
    expect(await readText(b)).toBe("hello\n");
    expect(pulled.fastForwardedPaths).toContainEqual({
      path: "docs/a.md",
      operation: "write",
      contentKind: "text",
    });
  });

  it("persists push and fetch cursors across store handles", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("cursor-a");
    const b = await tempRoot("cursor-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    const firstLogPosts = relay.logPostCount;

    await expect(pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() })).resolves.toMatchObject({
      pushed: 0,
    });
    await expect(pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() })).resolves.toMatchObject({
      fetched: 0,
    });
    expect(relay.logPostCount).toBe(firstLogPosts);
  });

  it("recovers one 409 by probing the relay high-water mark", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("recover-a");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });

    const store = createVersionedTextStore(a, { nowMs: () => 2000 });
    try {
      await store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/b.md",
        text: "second\n",
        metadata: { origin: "api" },
      });
    } finally {
      await store.close();
    }
    // Simulate a lost local push cursor after restart.
    const dbRoot = await import("./syncApply");
    const db = dbRoot.openEngineDb(a);
    try {
      db.prepare("DELETE FROM sync_relay_push_state WHERE workspace_id = ?").run(WORKSPACE_ID);
    } finally {
      db.close();
    }

    await expect(pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() })).resolves.toMatchObject({
      pushed: 1,
    });
    expect(relay.log).toHaveLength(3);
  });

  it("throws a typed unauthorized error on 401", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("unauth");
    await seedText(a);
    await expect(
      pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection("bad") }),
    ).rejects.toBeInstanceOf(RelayUnauthorizedError);
  });

  it("fails closed when a downloaded blob does not match its sha", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("hash-a");
    const b = await tempRoot("hash-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    relay.corruptBlobGets = true;
    await expect(
      pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).rejects.toThrow(/hash verification/u);
  });

  it("replicates chat messages through bootstrap pull", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("chat-a");
    const b = await tempRoot("chat-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    const chats = createLinkedChatStore(a, { nowMs: () => 1000 });
    try {
      const channel = await chats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      await chats.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: channel.id,
        title: "Relay",
        author: { kind: "agent", displayName: "Agent" },
        body: "hello relay",
      });
    } finally {
      await chats.close();
    }
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    const bChats = createLinkedChatStore(b);
    try {
      const threads = await bChats.listThreads({ workspaceId: WORKSPACE_ID });
      expect(threads).toHaveLength(1);
      const messages = await bChats.listMessages({ workspaceId: WORKSPACE_ID, threadId: threads[0]!.id });
      expect(messages.map((message) => message.body)).toEqual(["hello relay"]);
    } finally {
      await bChats.close();
    }
  });
});
