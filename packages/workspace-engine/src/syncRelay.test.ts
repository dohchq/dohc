import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_VERSIONED_BINARY_FILE_BYTES,
  RelayBlobMissingError,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  claimRelayWorkspace,
  probeRelayWorkspace,
  createLinkedChatStore,
  createVersionedTextStore,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  type SyncReplicationEnvelope,
} from ".";
import { openEngineDb } from "./syncApply";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// node:sqlite via createRequire: vitest's vite pipeline cannot statically
// resolve the node:sqlite builtin yet.
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

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
  // Simulates a buggy/malicious relay whose log pages never advance.
  stuckPagination = false;
  // Test hook observed on every blob GET (lock-contention probes).
  onBlobGet: (() => void) | undefined;

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
      this.onBlobGet?.();
      const bytes = this.blobs.get(parts[3]);
      if (!bytes) {
        // Mirrors the real relay's distinct blob-miss shape (vs the fixed
        // absent-workspace 404 above).
        return Response.json(
          { ok: false, error: "blob not found", code: "blob_not_found" },
          { status: 404 },
        );
      }
      const body = this.corruptBlobGets ? Buffer.from("corrupt") : Buffer.from(bytes);
      return new Response(body);
    }

    if (parts[2] === "log" && request.method === "GET") {
      const since = Number(parsed.searchParams.get("since") ?? "0");
      if (this.stuckPagination) {
        return Response.json({ ok: true, ops: [], nextCursor: since, hasMore: true });
      }
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
      // Mirrors the real relay's MAX_OPS_PER_REQUEST cap: an oversized
      // append is a 400, so the client MUST chunk.
      if (body.ops.length > 500) {
        return Response.json({ ok: false, error: "too many ops" }, { status: 400 });
      }
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

function readPersistedFetchCursor(root: string): number {
  const db = openEngineDb(root);
  try {
    const row = db
      .prepare("SELECT relay_fetch_cursor FROM sync_relay_cursors WHERE workspace_id = ?")
      .get(WORKSPACE_ID);
    return Number(row?.relay_fetch_cursor ?? 0);
  } finally {
    db.close();
  }
}

function readPersistedPushedSeq(root: string): number {
  const db = openEngineDb(root);
  try {
    const row = db
      .prepare("SELECT MAX(pushed_seq) AS pushed FROM sync_relay_push_state WHERE workspace_id = ?")
      .get(WORKSPACE_ID);
    return Number(row?.pushed ?? -1);
  } finally {
    db.close();
  }
}

// Simulates restoring an older engine.db snapshot: the newest local op is
// gone from the journal while the relay still holds it.
function dropNewestLocalOp(root: string): void {
  const db = openEngineDb(root);
  try {
    db.prepare(
      `DELETE FROM replication_log
       WHERE workspace_id = ? AND origin_seq = (
         SELECT MAX(origin_seq) FROM replication_log WHERE workspace_id = ?
       )`,
    ).run(WORKSPACE_ID, WORKSPACE_ID);
  } finally {
    db.close();
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
    const pulled = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await pulled.commitFetchCursor();
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

  it("chunks a large first push within the relay's per-request op cap (join/enable-sync scale)", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("chunk-a");
    const b = await tempRoot("chunk-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    const store = createVersionedTextStore(a, { nowMs: () => 1000 });
    try {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      for (let index = 0; index < 510; index += 1) {
        await store.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: `docs/f-${index}.md`,
          text: `file ${index}\n`,
          metadata: { origin: "api" },
        });
      }
    } finally {
      await store.close();
    }

    // 511 ops (workspace.init + 510 writes) > the 500-op request cap: the
    // push must land as multiple contiguous batches, not one failing 400.
    const pushedResult = await pushWorkspaceToRelay({
      rootDir: a,
      workspaceId: WORKSPACE_ID,
      relay: relay.connection(),
    });
    expect(pushedResult.pushed).toBe(511);
    expect(relay.logPostCount).toBeGreaterThanOrEqual(2);
    expect(relay.log).toHaveLength(511);

    // A fresh machine bootstraps the whole thing.
    const pulled = await pullWorkspaceFromRelay({
      rootDir: b,
      workspaceId: WORKSPACE_ID,
      relay: relay.connection(),
    });
    await pulled.commitFetchCursor();
    expect(pulled.applied).toBe(511);
    expect(await readText(b, "docs/f-42.md")).toBe("file 42\n");
  });

  it("probes a synced workspace without creating local state", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("probe-a");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });

    await expect(
      probeRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).resolves.toEqual({ hasContent: true });
  });

  it("probe reports an owned-but-empty workspace as having no content", async () => {
    const relay = new FakeRelay();
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await expect(
      probeRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).resolves.toEqual({ hasContent: false });
  });

  it("probe maps an absent/foreign workspace to the typed unavailable error", async () => {
    const relay = new FakeRelay();
    await expect(
      probeRelayWorkspace({ workspaceId: "workspace-never-claimed", relay: relay.connection() }),
    ).rejects.toBeInstanceOf(RelayWorkspaceUnavailableError);
  });

  it("probe maps a dead session to the typed unauthorized error", async () => {
    const relay = new FakeRelay();
    await expect(
      probeRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection("bad") }),
    ).rejects.toBeInstanceOf(RelayUnauthorizedError);
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

  // Data-safety gate finding 1: a failed disk materialization must never
  // permanently skip a remote op. The fetch cursor only moves when the
  // caller commits (after materialization), and a retry pass re-reports the
  // owed disk work even though the engine apply is an idempotent skip.
  it("does not advance the fetch cursor until the caller commits, and re-reports disk work on retry", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("commit-a");
    const b = await tempRoot("commit-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });

    const first = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    expect(first.fetched).toBe(2);
    expect(first.fastForwardedPaths).toContainEqual({
      path: "docs/a.md",
      operation: "write",
      contentKind: "text",
    });
    // Materialization failed: the caller never committed. The cursor must
    // not have moved.
    expect(readPersistedFetchCursor(b)).toBe(0);

    const second = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    expect(second.fetched).toBe(2);
    // The apply is a snapshot no-op this time, but the disk work is still
    // owed and must be re-reported.
    expect(second.fastForwardedPaths).toContainEqual({
      path: "docs/a.md",
      operation: "write",
      contentKind: "text",
    });
    await second.commitFetchCursor();
    expect(readPersistedFetchCursor(b)).toBe(second.nextCursor);

    const third = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    expect(third.fetched).toBe(0);
  });

  // Data-safety gate finding 2: the engine forbids binary files above
  // MAX_VERSIONED_BINARY_FILE_BYTES locally, so a peer shipping a bigger
  // binary blob through the relay is a protocol violation and must fail
  // closed before anything is hydrated.
  it("rejects an oversized binary blob from the relay as a protocol violation", async () => {
    const relay = new FakeRelay();
    const b = await tempRoot("oversized-bin");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    const big = new Uint8Array(MAX_VERSIONED_BINARY_FILE_BYTES + 1).fill(7);
    const bigSha = sha256(big);
    relay.blobs.set(bigSha, big);
    relay.log.push({
      workspaceId: WORKSPACE_ID,
      originId: "origin-remote",
      originSeq: 0,
      opKind: "moment.append",
      payload: {
        path: "assets/huge.bin",
        payloadAfterBlobSha256: bigSha,
        payloadAfterContentKind: "binary",
      },
      recordedAtMs: 1000,
      relaySeq: relay.nextRelaySeq,
    } as never);
    relay.nextRelaySeq += 1;

    await expect(
      pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).rejects.toThrow(/binary blob .* exceeds/iu);
    // Fails closed: nothing hydrated, cursor not advanced.
    const db = openEngineDb(b);
    try {
      expect(Number(db.prepare("SELECT COUNT(*) AS n FROM binary_blobs").get()?.n)).toBe(0);
    } finally {
      db.close();
    }
    expect(readPersistedFetchCursor(b)).toBe(0);
  });

  // Gate finding 3 (medium): a relay that is AHEAD of the local journal for
  // this origin means the local engine.db was restored/cloned from an older
  // snapshot. Pushing must fail closed instead of advancing pushed_seq past
  // local reality (which would silently drop future local ops).
  it("fails closed when the relay is ahead of the local journal for this origin", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("restored-a");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });

    // Restore an older engine.db: newest local op gone, push cursor reset.
    dropNewestLocalOp(a);
    const db = openEngineDb(a);
    try {
      db.prepare("DELETE FROM sync_relay_push_state WHERE workspace_id = ?").run(WORKSPACE_ID);
    } finally {
      db.close();
    }

    await expect(
      pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).rejects.toBeInstanceOf(RelayOriginDivergedError);
    // pushed_seq must never exceed the local journal's max (0 after restore).
    expect(readPersistedPushedSeq(a)).toBeLessThanOrEqual(0);
  });

  it("fails closed instead of silently dropping local ops on same-seq divergence after a 409", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("diverged-a");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });

    // Restored older snapshot (newest op gone, cursor consistent with it),
    // then NEW local work re-uses the origin seq the relay already holds
    // with different content.
    dropNewestLocalOp(a);
    const db = openEngineDb(a);
    try {
      db.prepare("UPDATE sync_relay_push_state SET pushed_seq = 0 WHERE workspace_id = ?").run(
        WORKSPACE_ID,
      );
    } finally {
      db.close();
    }
    const store = createVersionedTextStore(a, { nowMs: () => 5000 });
    try {
      await store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/diverged.md",
        text: "post-restore work\n",
        metadata: { origin: "api" },
      });
    } finally {
      await store.close();
    }

    const logBefore = relay.log.length;
    await expect(
      pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).rejects.toBeInstanceOf(RelayOriginDivergedError);
    // Nothing landed and the local op is still marked unpushed.
    expect(relay.log).toHaveLength(logBefore);
    expect(readPersistedPushedSeq(a)).toBe(0);
  });

  it("aborts a pull when relay pagination stops advancing", async () => {
    const relay = new FakeRelay();
    const b = await tempRoot("stuck-page");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    relay.stuckPagination = true;
    await expect(
      pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).rejects.toThrow(/did not advance/u);
  });

  it("maps a missing relay blob to RelayBlobMissingError, not workspace-unavailable", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("blobmiss-a");
    const b = await tempRoot("blobmiss-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });
    relay.blobs.clear();
    await expect(
      pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).rejects.toBeInstanceOf(RelayBlobMissingError);
  });

  // Gate finding: blob hydration must not hold the engine write transaction
  // open across network fetches. A concurrent writer taking BEGIN IMMEDIATE
  // mid-fetch must succeed instead of tripping SQLITE_BUSY.
  it("does not hold the engine write lock while fetching relay blobs", async () => {
    const relay = new FakeRelay();
    const a = await tempRoot("lock-a");
    const b = await tempRoot("lock-b");
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relay.connection() });
    await seedText(a);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay: relay.connection() });

    // Pre-create b's engine.db so the probe connection can open it.
    openEngineDb(b).close();
    let probes = 0;
    relay.onBlobGet = () => {
      const raw = new DatabaseSync(join(b, VERSIONED_TEXT_STORE_RELATIVE_PATH));
      try {
        raw.exec("PRAGMA busy_timeout = 200");
        raw.exec("BEGIN IMMEDIATE");
        raw.exec("ROLLBACK");
        probes += 1;
      } finally {
        raw.close();
      }
    };
    await expect(
      pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relay.connection() }),
    ).resolves.toMatchObject({ fetched: 2 });
    expect(probes).toBeGreaterThan(0);
  });
});
