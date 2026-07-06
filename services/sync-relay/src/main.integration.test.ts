import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  createVersionedTextStore,
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
});
