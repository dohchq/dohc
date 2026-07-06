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
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
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
  for (const child of children) child.kill("SIGTERM");
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

  it("does not send or store plaintext secret writes over the relay transport", async (context) => {
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
    const bodies: Buffer[] = [];
    const capturingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      if (body) {
        if (typeof body === "string") bodies.push(Buffer.from(body, "utf8"));
        else if (body instanceof Uint8Array) bodies.push(Buffer.from(body));
        else if (body instanceof ArrayBuffer) bodies.push(Buffer.from(body));
      }
      return fetch(input, init);
    }) as typeof fetch;
    const relay = relayConnection(baseUrl, capturingFetch);
    await claimRelayWorkspace({ workspaceId: WORKSPACE_ID, relay });
    const root = await tempRoot("secret-a");
    const marker = "DOHC_SECRET_MARKER_0PB";
    const store = createVersionedTextStore(root);
    const secrets = createSecretFileStore(root, { createId: () => "secret-moment-1" });
    try {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: `TOKEN=${marker}\n`,
        metadata: { origin: "local-file", summary: "secret" },
      });
    } finally {
      await secrets.close();
      await store.close();
    }
    await pushWorkspaceToRelay({ rootDir: root, workspaceId: WORKSPACE_ID, relay });
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
    expect(relayBytes.includes(Buffer.from(marker))).toBe(false);
    expect(relayBytes.includes(Buffer.from(".env"))).toBe(false);
    for (const body of bodies) {
      expect(body.includes(Buffer.from(marker))).toBe(false);
      expect(body.includes(Buffer.from(".env"))).toBe(false);
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
