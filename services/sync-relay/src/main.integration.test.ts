import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  claimRelayWorkspace,
  createLinkedChatStore,
  createSecretFileStore,
  createVersionedTextStore,
  createYDocEngineDriver,
  type YDocSession,
  downloadKeyEnvelope,
  installWorkspaceDataKey,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  readWorkspaceDataKeyForEnrollment,
  unwrapWorkspaceDataKey,
  uploadKeyEnvelope,
  wrapWorkspaceDataKey,
  type SyncReplicationEnvelope,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface RawSqliteDb {
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

const WORKSPACE_ID = "workspace-live-relay";
const USER_ID = "sync-user";
const FUZZ_SEED = 0x0f0b2026;

let roots: string[] = [];
let children: ChildProcess[] = [];

beforeEach(() => {
  roots = [];
  children = [];
});

afterEach(async () => {
  // Wait for each relay child to actually exit before removing temp dirs:
  // kill() only requests termination, and Windows cannot unlink the child's
  // still-open relay.sqlite handles (EBUSY) until the process is gone.
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("close", () => {
            clearTimeout(forceKill);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-sync-relay-it-${label}-`));
  roots.push(root);
  return root;
}

function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

async function spawnRelay(dbPath: string): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts"], {
    cwd: packageRoot(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not report a port\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (/listen EPERM/u.test(stderr)) {
        reject(new ListenPermissionError(stderr));
        return;
      }
      reject(new Error(`sync relay exited before listening: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

class ListenPermissionError extends Error {
  constructor(stderr: string) {
    super(`loopback listen denied by test environment\n${stderr}`);
  }
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer test:${USER_ID}`);
  return headers;
}

function relayConnection(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  return {
    baseUrl,
    token: `test:${USER_ID}`,
    fetch: fetchImpl,
  };
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Pull and commit the fetch cursor, standing in for the desktop capture's
// materialize-then-commit sequence (no disk materialization in these tests).
async function pullAndCommit(input: Parameters<typeof pullWorkspaceFromRelay>[0]) {
  const result = await pullWorkspaceFromRelay(input);
  await result.commitFetchCursor();
  return result;
}

async function syncQuiescent(baseUrl: string, a: string, b: string): Promise<void> {
  const relay = relayConnection(baseUrl);
  for (let index = 0; index < 4; index += 1) {
    const pushA = await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay });
    const pushB = await pushWorkspaceToRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
    await pullAndCommit({ rootDir: a, workspaceId: WORKSPACE_ID, relay });
    await pullAndCommit({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
    if (pushA.pushed === 0 && pushB.pushed === 0) return;
  }
  throw new Error("relay convergence did not quiesce");
}

async function fileDigest(root: string): Promise<Map<string, string>> {
  const store = createVersionedTextStore(root);
  try {
    const rows = await store.listTextFiles({ workspaceId: WORKSPACE_ID, versionId: "main" });
    return new Map(
      rows.map((row) => [
        row.path,
        (row.contentKind ?? "text") === "binary" ? `bin:${row.sha256}` : `txt:${row.text}`,
      ]),
    );
  } finally {
    await store.close();
  }
}

async function conflictPaths(root: string): Promise<Set<string>> {
  const store = createVersionedTextStore(root);
  try {
    const conflicts = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
    return new Set(conflicts.flatMap((conflict) => [conflict.path, conflict.current.path, conflict.incoming.path]));
  } finally {
    await store.close();
  }
}

async function chatDigest(root: string): Promise<string[]> {
  const chats = createLinkedChatStore(root);
  try {
    const threads = await chats.listThreads({ workspaceId: WORKSPACE_ID });
    const rows: string[] = [];
    for (const thread of threads) {
      const messages = await chats.listMessages({ workspaceId: WORKSPACE_ID, threadId: thread.id });
      rows.push(...messages.map((message) => `${thread.id}:${message.id}:${message.body}`));
    }
    return rows.sort();
  } finally {
    await chats.close();
  }
}

async function postJson(baseUrl: string, path: string, value: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(value),
  });
}

async function putBytes(baseUrl: string, path: string, bytes: Uint8Array): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: authHeaders(),
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
}

async function getAuthed(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: authHeaders() });
}

function rawDb(root: string): RawSqliteDb {
  return new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
}

function replicationOps(root: string): SyncReplicationEnvelope[] {
  const db = rawDb(root);
  try {
    return db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
         FROM replication_log
         WHERE workspace_id = ?
         ORDER BY origin_id, origin_seq`,
      )
      .all(WORKSPACE_ID)
      .map((row) => ({
        workspaceId: String(row.workspace_id),
        originId: String(row.origin_id),
        originSeq: Number(row.origin_seq),
        opKind: String(row.op_kind),
        payload: JSON.parse(String(row.payload_json)) as unknown,
        recordedAtMs: Number(row.recorded_at_ms),
      })) as SyncReplicationEnvelope[];
  } finally {
    db.close();
  }
}

function blobRows(root: string): Array<{ kind: "text" | "binary"; sha256: string; bytes: Buffer }> {
  const db = rawDb(root);
  try {
    // Binary contents keep a compatibility anchor row in `blobs` (empty text,
    // same sha as the binary_blobs row) so *_blob_sha256 foreign keys resolve.
    // Anchors are not shippable text blobs — the sha is the hash of the BINARY
    // bytes — so exclude them here and recreate them on hydrate below, exactly
    // like syncFolder's hydrateBinaryBlob does.
    const textRows = db
      .prepare(
        `SELECT sha256, text FROM blobs
         WHERE sha256 NOT IN (SELECT sha256 FROM binary_blobs)
         ORDER BY sha256`,
      )
      .all()
      .map((row) => ({
        kind: "text" as const,
        sha256: String(row.sha256),
        bytes: Buffer.from(String(row.text), "utf8"),
      }));
    const binaryRows = db
      .prepare("SELECT sha256, content FROM binary_blobs ORDER BY sha256")
      .all()
      .map((row) => {
        const content = row.content;
        return {
          kind: "binary" as const,
          sha256: String(row.sha256),
          bytes: Buffer.isBuffer(content)
            ? content
            : content instanceof Uint8Array
              ? Buffer.from(content)
              : Buffer.alloc(0),
        };
      });
    return [...textRows, ...binaryRows];
  } finally {
    db.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pushStoreToRelay(baseUrl: string, root: string): Promise<void> {
  for (const blob of blobRows(root)) {
    expect(sha256(blob.bytes)).toBe(blob.sha256);
    const response = await putBytes(baseUrl, `/sync/${WORKSPACE_ID}/blobs/${blob.sha256}`, blob.bytes);
    expect(response.status).toBe(200);
  }
  const byOrigin = new Map<string, SyncReplicationEnvelope[]>();
  for (const op of replicationOps(root)) {
    const bucket = byOrigin.get(op.originId) ?? [];
    bucket.push(op);
    byOrigin.set(op.originId, bucket);
  }
  for (const [originId, ops] of byOrigin) {
    ops.sort((a, b) => a.originSeq - b.originSeq);
    const response = await postJson(baseUrl, `/sync/${WORKSPACE_ID}/log`, {
      originId,
      ops: ops.map(({ originSeq, opKind, payload, recordedAtMs }) => ({
        originSeq,
        opKind,
        payload,
        recordedAtMs,
      })),
    });
    expect(response.status).toBe(200);
  }
}

async function hydrateBlobsFromRelay(baseUrl: string, targetRoot: string, sourceRoot: string): Promise<void> {
  const targetStore = createVersionedTextStore(targetRoot);
  await targetStore.getMainVersion({ workspaceId: WORKSPACE_ID }).catch(() => null);
  await targetStore.close();
  const db = rawDb(targetRoot);
  try {
    for (const blob of blobRows(sourceRoot)) {
      const response = await getAuthed(baseUrl, `/sync/${WORKSPACE_ID}/blobs/${blob.sha256}`);
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes).toEqual(blob.bytes);
      if (blob.kind === "text") {
        db.prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, ?)").run(
          blob.sha256,
          bytes.byteLength,
          bytes.toString("utf8"),
        );
      } else {
        db.prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)").run(
          blob.sha256,
          bytes.byteLength,
          bytes,
        );
        // Compatibility anchor, mirroring the engine's putBinaryBlob /
        // syncFolder.hydrateBinaryBlob: *_blob_sha256 FKs reference `blobs`.
        db.prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, '')").run(
          blob.sha256,
          bytes.byteLength,
        );
      }
    }
  } finally {
    db.close();
  }
}

async function fetchOps(baseUrl: string): Promise<SyncReplicationEnvelope[]> {
  const all: SyncReplicationEnvelope[] = [];
  let cursor = 0;
  for (;;) {
    const response = await getAuthed(baseUrl, `/sync/${WORKSPACE_ID}/log?since=${cursor}&limit=2`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ops: Array<SyncReplicationEnvelope & { relaySeq: number }>;
      nextCursor: number;
      hasMore: boolean;
    };
    all.push(...body.ops.map(({ relaySeq: _relaySeq, ...op }) => op));
    cursor = body.nextCursor;
    if (!body.hasMore) return all;
  }
}

describe("sync relay main process", () => {
  it("moves real engine journal ops and blobs through real HTTP with bearer auth", async (context) => {
    const relayRoot = await tempRoot("relay");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const unauth = await fetch(`${baseUrl}/sync/${WORKSPACE_ID}/log?since=0`);
    expect(unauth.status).toBe(401);

    const created = await postJson(baseUrl, "/sync/workspaces", { workspaceId: WORKSPACE_ID });
    expect(created.status).toBe(200);

    const a = await tempRoot("engine-a");
    const b = await tempRoot("engine-b");
    const clock = { value: 10_000 };
    const aStore = createVersionedTextStore(a, {
      nowMs: () => {
        clock.value += 10;
        return clock.value;
      },
      createId: (kind) => `a-${kind}-${clock.value}`,
    });
    try {
      await aStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await aStore.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/relay.md",
        text: "hello through relay\n",
        metadata: { origin: "api", summary: "seed" },
      });
      await aStore.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/relay.bin",
        bytes: Uint8Array.from([0, 1, 2, 253, 254, 255]),
        metadata: { origin: "api", summary: "binary" },
      });
    } finally {
      await aStore.close();
    }

    await pushStoreToRelay(baseUrl, a);
    await hydrateBlobsFromRelay(baseUrl, b, a);

    const fetched = await fetchOps(baseUrl);
    const bStore = createVersionedTextStore(b);
    try {
      for (const fetchedOp of fetched) await bStore.applyReplicationOp(fetchedOp);
      await expect(
        bStore.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/relay.md" }),
      ).resolves.toMatchObject({ text: "hello through relay\n" });
      const bin = await bStore.readBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/relay.bin",
      });
      expect(Buffer.from(bin ?? [])).toEqual(Buffer.from([0, 1, 2, 253, 254, 255]));
    } finally {
      await bStore.close();
    }
  });

  it("syncs two engine stores through the relay client and bootstraps a fresh third store", async (context) => {
    const relayRoot = await tempRoot("relay-client");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const relay = relayConnection(baseUrl);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });

    const a = await tempRoot("client-a");
    const b = await tempRoot("client-b");
    const c = await tempRoot("client-c");
    const aStore = createVersionedTextStore(a, { nowMs: () => 1000 });
    const bStore = createVersionedTextStore(b, { nowMs: () => 2000 });
    try {
      await aStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await aStore.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/a.md",
        text: "from a\n",
        metadata: { origin: "api" },
      });
      await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay });
      await pullAndCommit({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
      await bStore.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/b.bin",
        bytes: Uint8Array.from([1, 2, 3, 4]),
        metadata: { origin: "api" },
      });
      await pushWorkspaceToRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
      await pullAndCommit({ rootDir: a, workspaceId: WORKSPACE_ID, relay });
      await pullAndCommit({ rootDir: c, workspaceId: WORKSPACE_ID, relay });

      await expect(
        aStore.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/a.md" }),
      ).resolves.toMatchObject({ text: "from a\n" });
      const cStore = createVersionedTextStore(c);
      try {
        await expect(
          cStore.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/a.md" }),
        ).resolves.toMatchObject({ text: "from a\n" });
        const cBin = await cStore.readBinaryFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "assets/b.bin",
        });
        expect(Buffer.from(cBin ?? [])).toEqual(Buffer.from([1, 2, 3, 4]));
      } finally {
        await cStore.close();
      }
    } finally {
      await bStore.close();
      await aStore.close();
    }
  });

  it("replicates ydoc.update rich-doc edits through the real relay and bootstraps a fresh store", async (context) => {
    const relayRoot = await tempRoot("relay-ydoc");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const relay = relayConnection(baseUrl);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });

    const a = await tempRoot("ydoc-a");
    const b = await tempRoot("ydoc-b");
    const c = await tempRoot("ydoc-c");
    let clock = 1000;
    const aStore = createVersionedTextStore(a, { nowMs: () => (clock += 5) });
    const bStore = createVersionedTextStore(b, { nowMs: () => (clock += 5) });
    const aDriver = createYDocEngineDriver({ store: aStore, rootDir: a, replicated: true });
    const richPath = "docs/rich.md";

    // Play the editor: capture each Yjs update the doc emits and journal it via
    // the driver's recordUpdate (which also journals the ydoc.update op).
    const drive = async (session: YDocSession, insert: string): Promise<void> => {
      const captured: Uint8Array[] = [];
      const handler = (update: Uint8Array): void => {
        captured.push(update);
      };
      session.doc.on("update", handler);
      const text = session.doc.getText("plainText");
      session.doc.transact(() => text.insert(text.length, insert));
      session.doc.off("update", handler);
      for (const update of captured) await session.recordUpdate(update);
    };

    try {
      await aStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      // Non-journaling seed: the ONLY replication for this object is ydoc.update.
      await aStore.writeProjectedTextFile!({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: richPath,
        text: "seed\n",
        metadata: { origin: "api" },
      });
      const session = await aDriver.openSession({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: richPath,
        contentKind: "plaintext",
      });
      await drive(session, "hello through the relay\n");
      await drive(session, "a second rich line\n");
      await session.settle();
      await session.close();

      // FIX 1 (durable-resume): reopen the SAME lineage with NO resume flag — a
      // replicated doc must ALWAYS resume, never re-seed. A re-seed here would
      // emit a SECOND base op and, on the fresh-store replay below, duplicate the
      // shared text. Edit again to prove post-reopen deltas ride the same lineage.
      const reopened = await aDriver.openSession({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: richPath,
      });
      await drive(reopened, "a third line after reopen\n");
      await reopened.close();
      await aDriver.close();

      // The object's replication is PURELY ydoc.update ops (no moment.append),
      // and EXACTLY ONE of them is a base op no matter the close/reopen cycle.
      const ops = replicationOps(a);
      const kinds = ops.map((operation) => operation.opKind);
      expect(kinds.filter((k) => k === "ydoc.update").length).toBeGreaterThanOrEqual(4);
      expect(kinds).not.toContain("moment.append");
      const baseOps = ops.filter(
        (operation) =>
          operation.opKind === "ydoc.update" &&
          (operation.payload as { isBaseState?: boolean }).isBaseState === true,
      );
      expect(baseOps).toHaveLength(1);

      // Converge A <-> B through the real relay.
      await syncQuiescent(baseUrl, a, b);
      const aMarkdown = await aStore.readTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: richPath,
      });
      const bMarkdown = await bStore.readTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: richPath,
      });
      expect(bMarkdown?.text).toBe(aMarkdown?.text);
      expect(bMarkdown?.text).toContain("hello through the relay");
      expect(bMarkdown?.text).toContain("a second rich line");
      // The post-reopen edit rode the SAME lineage across the relay.
      expect(bMarkdown?.text).toContain("a third line after reopen");
      // NO duplication: the single durable lineage never forked, so each line
      // the doc ever held appears exactly once on the replaying peer.
      const occurrences = (haystack: string, needle: string): number =>
        haystack.split(needle).length - 1;
      for (const line of [
        "hello through the relay",
        "a second rich line",
        "a third line after reopen",
      ]) {
        expect(occurrences(bMarkdown?.text ?? "", line)).toBe(1);
      }

      // Idempotent re-pull applies nothing new.
      const again = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
      await again.commitFetchCursor();
      expect(again.applied).toBe(0);

      // A brand-new third store bootstraps the whole rich doc from the relay's
      // op history alone (workspace.init + base + deltas + update blobs).
      await pullAndCommit({ rootDir: c, workspaceId: WORKSPACE_ID, relay });
      const cStore = createVersionedTextStore(c);
      try {
        const cMarkdown = await cStore.readTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: richPath,
        });
        expect(cMarkdown?.text).toBe(aMarkdown?.text);
      } finally {
        await cStore.close();
      }

      // No conflict rows anywhere: the commutative op never opens P0D.
      for (const root of [a, b, c]) {
        expect(await conflictPaths(root)).toEqual(new Set());
      }
    } finally {
      await aDriver.close().catch(() => {});
      await bStore.close();
      await aStore.close();
    }
  });

  it("converges a bounded seeded operation fuzz over real HTTP", async (context) => {
    const relayRoot = await tempRoot("relay-fuzz");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay: relayConnection(baseUrl) });
    const random = prng(FUZZ_SEED);
    const a = await tempRoot("fuzz-a");
    const b = await tempRoot("fuzz-b");
    const paths = ["docs/fuzz-0.md", "docs/fuzz-1.md", "docs/fuzz-2.md"];
    const aStore = createVersionedTextStore(a, { nowMs: () => 10_000 + Math.floor(random() * 1000) });
    const bStore = createVersionedTextStore(b, { nowMs: () => 20_000 + Math.floor(random() * 1000) });
    const aChats = createLinkedChatStore(a, { nowMs: () => 30_000 + Math.floor(random() * 1000) });
    const bChats = createLinkedChatStore(b, { nowMs: () => 40_000 + Math.floor(random() * 1000) });
    try {
      await aStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await aStore.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: paths[0]!,
        text: "seed\n",
        metadata: { origin: "api" },
      });
      const channel = await aChats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const thread = await aChats.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: channel.id,
        title: "HTTP fuzz",
        author: { kind: "agent", displayName: "Agent A" },
        body: "seed chat",
      });
      await syncQuiescent(baseUrl, a, b);
      for (let index = 0; index < 10; index += 1) {
        const collisionPath = paths[index % paths.length]!;
        const aPath = random() < 0.35 ? collisionPath : paths[Math.floor(random() * paths.length)]!;
        const bPath = index % 4 === 0 ? collisionPath : paths[Math.floor(random() * paths.length)]!;
        try {
          await aStore.writeTextFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path: aPath,
            text: `a ${index} seed ${FUZZ_SEED}\n`,
            metadata: { origin: "api" },
          });
          if (index % 3 === 0) {
            await bStore.writeBinaryFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path: bPath,
              bytes: Uint8Array.from([index, 0xff, 0x7f, 2]),
              metadata: { origin: "api" },
            });
          } else if (index % 5 === 0) {
            await bStore.deleteTextFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path: bPath,
              metadata: { origin: "api" },
            }).catch(() => undefined);
          } else {
            await bStore.writeTextFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path: bPath,
              text: `b ${index} seed ${FUZZ_SEED}\n`,
              metadata: { origin: "api" },
            });
          }
          await bChats.sendMessage({
            workspaceId: WORKSPACE_ID,
            threadId: thread.thread.id,
            author: { kind: "agent", displayName: "Agent B" },
            body: `chat ${index} seed ${FUZZ_SEED}`,
          });
          await syncQuiescent(baseUrl, a, b);
          const [filesA, filesB, conflictsA, conflictsB] = await Promise.all([
            fileDigest(a),
            fileDigest(b),
            conflictPaths(a),
            conflictPaths(b),
          ]);
          const conflicted = new Set([...conflictsA, ...conflictsB]);
          for (const path of new Set([...filesA.keys(), ...filesB.keys()])) {
            if (conflicted.has(path)) continue;
            expect(filesB.get(path) ?? null).toBe(filesA.get(path) ?? null);
          }
          expect(await chatDigest(b)).toEqual(await chatDigest(a));
        } catch (error) {
          console.error(`relay HTTP fuzz seed=${FUZZ_SEED} iteration=${index}`);
          throw error;
        }
      }
    } finally {
      await bChats.close();
      await aChats.close();
      await bStore.close();
      await aStore.close();
    }
  }, 30_000);

  it("sends and stores secret ciphertext over the relay transport without plaintext or raw key", async (context) => {
    const relayRoot = await tempRoot("relay-secret");
    const dbPath = join(relayRoot, "relay.sqlite");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(dbPath);
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const requestBodies: Buffer[] = [];
    const responseBodies: Buffer[] = [];
    const capturingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      if (body) {
        if (typeof body === "string") requestBodies.push(Buffer.from(body, "utf8"));
        else if (body instanceof Uint8Array) requestBodies.push(Buffer.from(body));
        else if (body instanceof ArrayBuffer) requestBodies.push(Buffer.from(body));
      }
      const response = await fetch(input, init);
      // Byte-walk RESPONSE bodies too (gate fix): the pull direction returns
      // ops and blobs and must be exactly as plaintext- and key-free as the
      // push direction. clone() so the caller still gets a readable body.
      responseBodies.push(Buffer.from(await response.clone().arrayBuffer()));
      return response;
    }) as typeof fetch;
    const relay = relayConnection(baseUrl, capturingFetch);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });
    const root = await tempRoot("secret-a");
    const marker = "DOHC_SECRET_MARKER_0PB";
    const store = createVersionedTextStore(root);
    let secretMoment = 0;
    const secrets = createSecretFileStore(root, {
      createId: () => {
        secretMoment += 1;
        return `secret-moment-${secretMoment}`;
      },
    });
    try {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: `TOKEN=${marker}\n`,
        metadata: { origin: "local-file", summary: "secret" },
      });
      await secrets.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "local-file", summary: "secret delete" },
      });
    } finally {
      await secrets.close();
      await store.close();
    }
    const keyFile = await readFile(join(root, ".dohc/engine/secret.key"), "utf8");
    const keyBase64 = keyFile.trim().slice("dohc-secret-key-v1:".length);
    const rawKey = Buffer.from(keyBase64, "base64");
    await pushWorkspaceToRelay({ rootDir: root, workspaceId: WORKSPACE_ID, relay });
    // Pull into a second machine through the SAME capturing transport so the
    // response corpus contains the ops/blobs the relay serves back.
    const pullRoot = await tempRoot("secret-b");
    const pulled = await pullWorkspaceFromRelay({
      rootDir: pullRoot,
      workspaceId: WORKSPACE_ID,
      relay,
    });
    await pulled.commitFetchCursor();
    // The relay runs WAL mode: fresh writes live in relay.sqlite-wal until a
    // checkpoint, so an absence assertion over the main file alone could
    // trivially false-pass. Walk db + WAL + shm together, and prove the walk
    // sees real content by asserting a non-secret op DID land in those bytes.
    const relayBytes = Buffer.concat(
      await Promise.all(
        [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) =>
          readFile(file).catch(() => Buffer.alloc(0)),
        ),
      ),
    );
    expect(relayBytes.includes(Buffer.from("workspace.init"))).toBe(true);
    expect(relayBytes.includes(Buffer.from("secret.file.put"))).toBe(true);
    expect(relayBytes.includes(Buffer.from("secret.file.delete"))).toBe(true);
    // 0P-D intentionally replicates secret ciphertext and path metadata so
    // peers can reconstruct the same AAD. The relay may store `.env`, but
    // never the plaintext secret or the workspace data key.
    expect(relayBytes.includes(Buffer.from(".env"))).toBe(true);
    expect(relayBytes.includes(Buffer.from(marker))).toBe(false);
    expect(relayBytes.includes(Buffer.from(keyBase64))).toBe(false);
    expect(relayBytes.includes(rawKey)).toBe(false);
    // Positive controls on BOTH directions: the walk sees real op content in
    // the requests (push) and in the responses (pull), so the negative
    // assertions below cannot false-pass over an empty corpus.
    const requestBytes = Buffer.concat(requestBodies);
    const responseBytes = Buffer.concat(responseBodies);
    expect(requestBytes.includes(Buffer.from("workspace.init"))).toBe(true);
    expect(requestBytes.includes(Buffer.from("secret.file.put"))).toBe(true);
    expect(responseBytes.includes(Buffer.from("secret.file.put"))).toBe(true);
    expect(responseBytes.includes(Buffer.from("secret.file.delete"))).toBe(true);
    expect(responseBytes.includes(Buffer.from(".env"))).toBe(true);
    for (const body of [...requestBodies, ...responseBodies]) {
      expect(body.includes(Buffer.from(marker))).toBe(false);
      expect(body.includes(Buffer.from(keyBase64))).toBe(false);
      expect(body.includes(rawKey)).toBe(false);
    }
  });

  it("round-trips a protected file between two machines after passphrase unlock", async (context) => {
    const relayRoot = await tempRoot("relay-secret-roundtrip");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const relay = relayConnection(baseUrl);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });
    const a = await tempRoot("secret-roundtrip-a");
    const b = await tempRoot("secret-roundtrip-b");
    const plaintext = "TOKEN=relay-roundtrip-secret\n";
    const versions = createVersionedTextStore(a);
    const secrets = createSecretFileStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: plaintext,
        metadata: { origin: "local-file", summary: "secret" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected enrollment key");
    const { envelopeJson } = await wrapWorkspaceDataKey({
      dataKey: key,
      passphrase: "sync passphrase",
      workspaceId: WORKSPACE_ID,
    });
    await uploadKeyEnvelope({ workspaceId: WORKSPACE_ID, relay, envelopeJson });
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay });

    const downloaded = await downloadKeyEnvelope({ workspaceId: WORKSPACE_ID, relay });
    const unwrapped = await unwrapWorkspaceDataKey({
      envelopeJson: downloaded,
      passphrase: "sync passphrase",
      workspaceId: WORKSPACE_ID,
    });
    await installWorkspaceDataKey(b, unwrapped);
    const pulled = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
    expect(pulled.fetched).toBeGreaterThanOrEqual(2);
    expect(pulled.applied).toBeGreaterThanOrEqual(2);
    expect(pulled.fastForwardedPaths).toEqual([]);
    await pulled.commitFetchCursor();
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).resolves.toEqual({ present: true, text: plaintext });
    } finally {
      await imported.close();
    }
  });

  it("syncs protected rows on a no-key machine but materialization fails closed", async (context) => {
    const relayRoot = await tempRoot("relay-secret-no-key");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const relay = relayConnection(baseUrl);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });
    const a = await tempRoot("secret-no-key-a");
    const b = await tempRoot("secret-no-key-b");
    const versions = createVersionedTextStore(a);
    const secrets = createSecretFileStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "TOKEN=no-key-secret\n",
        metadata: { origin: "local-file", summary: "secret" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay });
    const pulled = await pullWorkspaceFromRelay({ rootDir: b, workspaceId: WORKSPACE_ID, relay });
    await pulled.commitFetchCursor();
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId: "main" }),
      ).resolves.toEqual([expect.objectContaining({ path: ".env" })]);
      await expect(
        imported.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).rejects.toMatchObject({ code: "key-corrupt" });
    } finally {
      await imported.close();
    }
  });

  it("retries cleanly after a network failure between blob upload and log append", async (context) => {
    const relayRoot = await tempRoot("relay-retry");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    let failed = false;
    let sawPut = false;
    const flakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.includes("/blobs/")) sawPut = true;
      if (!failed && sawPut && init?.method === "POST" && url.endsWith("/log")) {
        failed = true;
        throw new Error("network dropped after blob upload");
      }
      return fetch(input, init);
    }) as typeof fetch;
    const relay = relayConnection(baseUrl, flakyFetch);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });
    const a = await tempRoot("retry-a");
    const b = await tempRoot("retry-b");
    const store = createVersionedTextStore(a, { nowMs: () => 3000 });
    try {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/retry.md",
        text: "retry me\n",
        metadata: { origin: "api" },
      });
    } finally {
      await store.close();
    }
    await expect(pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay })).rejects.toThrow(/network dropped/u);
    await pushWorkspaceToRelay({ rootDir: a, workspaceId: WORKSPACE_ID, relay });
    await pullAndCommit({ rootDir: b, workspaceId: WORKSPACE_ID, relay: relayConnection(baseUrl) });
    const check = createVersionedTextStore(b);
    try {
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/retry.md" }),
      ).resolves.toMatchObject({ text: "retry me\n" });
    } finally {
      await check.close();
    }
    const fetched = await fetchOps(baseUrl);
    expect(fetched.map((op) => `${op.originId}:${op.originSeq}`).sort()).toEqual(
      [...new Set(fetched.map((op) => `${op.originId}:${op.originSeq}`))].sort(),
    );
  });

  // Gate finding: the transport must cap request bodies AT THE STREAM. A
  // client streaming an oversized body is cut off mid-upload (413 and/or a
  // destroyed socket) instead of being fully buffered, and the server stays
  // healthy afterwards.
  it("rejects an oversized streamed body before buffering it and stays healthy", async (context) => {
    const relayRoot = await tempRoot("relay-stream-cap");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const claim = await postJson(baseUrl, "/sync/workspaces", { workspaceId: WORKSPACE_ID });
    expect(claim.status).toBe(200);

    const chunk = Buffer.alloc(1024 * 1024, 7);
    const totalChunks = 48; // 48MB streamed; the cap is ~11MB.
    const outcome = await new Promise<{ status: number | null; sentAll: boolean }>((resolve) => {
      let sent = 0;
      let settled = false;
      const settle = (status: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ status, sentAll: sent >= totalChunks });
      };
      const clientRequest = httpRequest(
        `${baseUrl}/sync/${encodeURIComponent(WORKSPACE_ID)}/blobs/${"0".repeat(64)}`,
        { method: "PUT", headers: { authorization: `Bearer test:${USER_ID}` } },
        (response) => {
          response.resume();
          settle(response.statusCode ?? null);
        },
      );
      clientRequest.on("error", () => settle(null));
      const writeMore = (): void => {
        while (sent < totalChunks) {
          sent += 1;
          const canContinue = clientRequest.write(chunk);
          if (!canContinue) {
            clientRequest.once("drain", writeMore);
            return;
          }
        }
        clientRequest.end();
      };
      writeMore();
    });

    // The stream was cut off BEFORE the client could deliver the full body
    // (pre-fix, the server buffered all 48MB and only then rejected).
    expect(outcome.sentAll).toBe(false);
    if (outcome.status !== null) expect(outcome.status).toBe(413);

    // The server survived: still answering, and a normal-sized blob works.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const smallBytes = Buffer.from("small blob after oversized rejection");
    const put = await putBytes(baseUrl, `/sync/${WORKSPACE_ID}/blobs/${sha256(smallBytes)}`, smallBytes);
    expect(put.status).toBe(200);
  });
});

// Spawn main.ts expecting it to refuse to start; resolves with the exit code
// and captured stderr instead of a listening URL.
async function spawnRelayExpectExit(
  envOverrides: Record<string, string | undefined>,
): Promise<{ code: number | null; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...envOverrides })) {
    if (value !== undefined) env[key] = value;
  }
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts"], {
    cwd: packageRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not exit\nstderr:\n${stderr}`));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

describe("sync relay startup guards", () => {
  it("refuses to start when SYNC_RELAY_PORT is not a number", async () => {
    const dbPath = join(await tempRoot("bad-port"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "not-a-port",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SYNC_RELAY_PORT must be an integer");
  });

  it("refuses to start when SYNC_RELAY_WORKSPACE_QUOTA_BYTES is not positive", async () => {
    const dbPath = join(await tempRoot("bad-quota"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_WORKSPACE_QUOTA_BYTES: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SYNC_RELAY_WORKSPACE_QUOTA_BYTES must be a positive integer");
  });

  it("refuses to start in production when POSTGRES_URL is unset", async () => {
    const dbPath = join(await tempRoot("no-pg"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: undefined,
      SYNC_RELAY_PORT: "0",
      // A valid-length secret so the guard under test is the one that fires.
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("POSTGRES_URL must be set");
  });
});
