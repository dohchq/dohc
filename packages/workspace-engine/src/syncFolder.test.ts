import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createLinkedChatStore } from "./linkedChatStore";
import {
  MAX_SECRET_FILE_BYTES,
  createSecretFileStore,
  installWorkspaceDataKey,
  readWorkspaceDataKeyForEnrollment,
} from "./secretFileStore";
import { applySyncQueues } from "./syncApply";
import type { SyncReplicationEnvelope } from "./syncReplication";
import { exportSyncBundle, importSyncBundle } from "./syncFolder";
import { VERSIONED_TEXT_STORE_RELATIVE_PATH, createVersionedTextStore } from "./versionedTextStore";
import { searchWorkspaceEngine } from "./workspaceSearch";

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

const WORKSPACE_ID = "workspace-sync";
const SECRET_MARKER = "SYNC_SECRET_MARKER_17b90d";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-${label}-`));
  roots.push(root);
  return root;
}

function createIdFactory(prefix = "") {
  const counters = { channel: 0, conflict: 0, message: 0, moment: 0, object: 0, thread: 0, version: 0 };
  return (kind: keyof typeof counters) => {
    counters[kind] += 1;
    return `${prefix}${kind}-${counters[kind]}`;
  };
}

function textStore(root: string, now: { value: number }) {
  const createId = createIdFactory();
  return createVersionedTextStore(root, {
    nowMs: () => {
      now.value += 10;
      return now.value;
    },
    createId,
  });
}

function chatStore(root: string, now: { value: number }) {
  const createId = createIdFactory();
  return createLinkedChatStore(root, {
    nowMs: () => {
      now.value += 10;
      return now.value;
    },
    createId,
  });
}

function rawDb(root: string): RawSqliteDb {
  return new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
}

function replicationRows(root: string): Array<Record<string, unknown>> {
  const db = rawDb(root);
  try {
    return db
      .prepare("SELECT * FROM replication_log ORDER BY origin_id, origin_seq")
      .all();
  } finally {
    db.close();
  }
}

function rowCount(root: string, table: string): number {
  const db = rawDb(root);
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
  } finally {
    db.close();
  }
}

function snapshotLatestMomentId(root: string, path: string): string | null {
  const db = rawDb(root);
  try {
    const row = db
      .prepare("SELECT latest_moment_id FROM snapshots WHERE workspace_id = ? AND version_id = 'main' AND path = ?")
      .get(WORKSPACE_ID, path);
    return typeof row?.latest_moment_id === "string" ? row.latest_moment_id : null;
  } finally {
    db.close();
  }
}

function secretCipherRows(root: string, versionId = "main"): Array<Record<string, unknown>> {
  const db = rawDb(root);
  try {
    return db
      .prepare(
        `SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length,
          updated_at_ms, latest_moment_id
         FROM secret_files
         WHERE workspace_id = ? AND version_id = ?
         ORDER BY path`,
      )
      .all(WORKSPACE_ID, versionId);
  } finally {
    db.close();
  }
}

function secretForkBaseRows(root: string, versionId: string): Array<Record<string, unknown>> {
  const db = rawDb(root);
  try {
    return db
      .prepare(
        `SELECT path, iv_base64, auth_tag_base64, ciphertext_base64, byte_length
         FROM secret_fork_bases
         WHERE workspace_id = ? AND version_id = ?
         ORDER BY path`,
      )
      .all(WORKSPACE_ID, versionId);
  } finally {
    db.close();
  }
}

function sealedTipDigest(root: string, versionId = "main"): string[] {
  return secretCipherRows(root, versionId).map(
    (row) =>
      `${row.path}\0${row.iv_base64}\0${row.auth_tag_base64}\0${row.ciphertext_base64}`,
  );
}

// Concatenates every UTF-8-decodable file under dir. Binary files (e.g.
// blobs-bin payloads) are skipped via a FATAL decode instead of being
// silently mangled by lossy utf8 conversion — mangled bytes could turn a
// "does not contain X" assertion into a false negative.
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

async function walkTextFiles(dir: string): Promise<string> {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += await walkTextFiles(path);
    if (entry.isFile()) {
      try {
        out += strictUtf8Decoder.decode(await readFile(path));
      } catch {
        // Not UTF-8-safe: binary content, skip.
      }
    }
  }
  return out;
}

async function walkFileBytes(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) chunks.push(await walkFileBytes(path));
    if (entry.isFile()) chunks.push(await readFile(path));
  }
  return Buffer.concat(chunks);
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Read/patch/rewrite the (single-origin) ops file of an exported bundle —
// the tamper hook for poison-op tests.
async function readBundleOps(
  bundle: string,
): Promise<{ file: string; ops: Array<Record<string, unknown>> }> {
  const file = join(bundle, "ops", (await readdir(join(bundle, "ops")))[0]!);
  const ops = (await readFile(file, "utf8"))
    .split(/\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { file, ops };
}

async function writeBundleOps(file: string, ops: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(file, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

async function syncBothWays(a: string, b: string, label: string): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const ab = await tempRoot(`${label}-ab-${round}`);
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    const toB = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    const ba = await tempRoot(`${label}-ba-${round}`);
    await exportSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, toDir: ba });
    const toA = await importSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, fromDir: ba });
    if (toA.applied === 0 && toB.applied === 0) return;
  }
  throw new Error(`sync did not quiesce for ${label}`);
}

describe("sync folder replication", () => {
  it("journals every reachable op kind beside its store mutation", async () => {
    const root = await tempRoot("sync-journal");
    const now = { value: 1000 };
    const versions = textStore(root, now);
    const chats = chatStore(root, now);
    try {
      const main = await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const first = await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        path: "docs/a.md",
        text: "base\n",
        metadata: { origin: "api", summary: "base" },
      });
      await versions.renameTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        fromPath: "docs/a.md",
        toPath: "docs/b.md",
        metadata: { origin: "api", summary: "rename" },
      });
      const named = await versions.createNamedVersion({
        workspaceId: WORKSPACE_ID,
        name: "Branch",
        fromVersionId: main.id,
      });
      await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        path: "docs/b.md",
        text: "main edit\n",
        metadata: { origin: "api" },
      });
      await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: named.id,
        path: "docs/b.md",
        text: "branch edit\n",
        metadata: { origin: "api" },
      });
      const merge = await versions.mergeTextFileFromVersion({
        workspaceId: WORKSPACE_ID,
        targetVersionId: main.id,
        sourceVersionId: named.id,
        path: "docs/b.md",
        metadata: { origin: "api", summary: "merge" },
      });
      expect(merge.kind).toBe("conflict");
      if (merge.kind !== "conflict") throw new Error("expected conflict");
      await versions.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: merge.conflict.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api", summary: "resolve" },
      });
      await versions.deleteTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        path: "docs/b.md",
        metadata: { origin: "api", summary: "delete" },
      });
      const thread = await chats.createThread({
        workspaceId: WORKSPACE_ID,
        title: "Thread",
        linkedFile: { objectId: first.object.id, pathHint: "docs/a.md" },
      });
      await chats.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: thread.id,
        author: { kind: "human", displayName: "Ice" },
        body: "hello journal",
      });

      const rows = replicationRows(root);
      expect(rows.map((row) => row.op_kind)).toEqual([
        "workspace.init",
        "moment.append",
        "moment.append",
        "version.create",
        "moment.append",
        "moment.append",
        "conflict.open",
        "moment.append",
        "conflict.resolve",
        "moment.append",
        "chat.thread.create",
        "chat.message.append",
      ]);
      const appendPayload = JSON.parse(String(rows.find((row) => row.op_kind === "moment.append")?.payload_json));
      expect(appendPayload).toMatchObject({
        momentId: "moment-1",
        versionId: "main",
        objectId: "object-1",
        beforePresent: "null",
        payloadAfterBlobSha256: expect.any(String),
      });
    } finally {
      await chats.close();
      await versions.close();
    }
  });

  it("round-trips, re-imports idempotently, and preserves original origin on transitive re-export", async () => {
    const a = await tempRoot("sync-a");
    const b = await tempRoot("sync-b");
    const c = await tempRoot("sync-c");
    const ab = await tempRoot("sync-ab");
    const bc = await tempRoot("sync-bc");
    const now = { value: 2000 };
    const versions = textStore(a, now);
    const chats = chatStore(a, now);
    try {
      const main = await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const file = await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        path: "docs/sync.md",
        text: "round trip searchable alpha\n",
        metadata: { origin: "api" },
      });
      const named = await versions.createNamedVersion({
        workspaceId: WORKSPACE_ID,
        name: "Snapshot",
        fromVersionId: main.id,
      });
      await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: named.id,
        path: "docs/sync.md",
        text: "named version text\n",
        metadata: { origin: "api" },
      });
      const thread = await chats.createThread({
        workspaceId: WORKSPACE_ID,
        title: "Sync thread",
        linkedFile: { objectId: file.object.id, pathHint: "docs/sync.md" },
      });
      await chats.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: thread.id,
        author: { kind: "agent", displayName: "Agent" },
        body: "chat alpha import",
      });
    } finally {
      await chats.close();
      await versions.close();
    }

    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab, nowMs: () => 3000 });
    const firstImport = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    expect(firstImport.applied).toBeGreaterThan(0);
    const counts = {
      moments: rowCount(b, "moments"),
      messages: rowCount(b, "chat_messages"),
      conflicts: rowCount(b, "conflicts"),
      log: rowCount(b, "replication_log"),
    };
    const secondImport = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    expect(secondImport.applied).toBe(0);
    expect({
      moments: rowCount(b, "moments"),
      messages: rowCount(b, "chat_messages"),
      conflicts: rowCount(b, "conflicts"),
      log: rowCount(b, "replication_log"),
    }).toEqual(counts);

    const bVersions = createVersionedTextStore(b);
    const bChats = createLinkedChatStore(b);
    try {
      await expect(
        bVersions.readTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "docs/sync.md",
        }),
      ).resolves.toMatchObject({ text: "round trip searchable alpha\n" });
      await expect(bChats.listMessages({ workspaceId: WORKSPACE_ID, threadId: "thread-1" })).resolves.toHaveLength(1);
    } finally {
      await bChats.close();
      await bVersions.close();
    }

    const aRows = replicationRows(a).map((row) => [row.origin_id, row.origin_seq]);
    await exportSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, toDir: bc, nowMs: () => 4000 });
    await importSyncBundle({ rootDir: c, workspaceId: WORKSPACE_ID, fromDir: bc });
    expect(replicationRows(c).map((row) => [row.origin_id, row.origin_seq])).toEqual(aRows);
  });

  it("opens a P0D-shaped conflict and leaves the importer live file untouched on divergence", async () => {
    const a = await tempRoot("sync-div-a");
    const b = await tempRoot("sync-div-b");
    const seed = await tempRoot("sync-div-seed");
    const ab = await tempRoot("sync-div-ab");
    const ba = await tempRoot("sync-div-ba");
    const nowA = { value: 1000 };
    const versionsA = textStore(a, nowA);
    try {
      const main = await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        path: "docs/diverge.md",
        text: "base\n",
        metadata: { origin: "api" },
      });
    } finally {
      await versionsA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });

    const editA = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a-") });
    const editB = createVersionedTextStore(b, { nowMs: () => 3000, createId: createIdFactory("b-") });
    try {
      await editA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/diverge.md",
        text: "from A\n",
        metadata: { origin: "api" },
      });
      await editB.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/diverge.md",
        text: "from B\n",
        metadata: { origin: "api" },
      });
    } finally {
      await editB.close();
      await editA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    await exportSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, toDir: ba });
    const result = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    expect(result.conflictsOpened).toBe(1);
    expect(replicationRows(b).filter((row) => row.op_kind === "conflict.open")).toHaveLength(0);
    const mirrorResult = await importSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, fromDir: ba });
    expect(mirrorResult.conflictsOpened).toBe(1);
    const check = createVersionedTextStore(b);
    const checkA = createVersionedTextStore(a);
    try {
      await expect(
        check.readTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "docs/diverge.md",
        }),
      ).resolves.toMatchObject({ text: "from B\n" });
      const conflicts = await check.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        base: { exists: true, text: "base\n" },
        current: { exists: true, text: "from B\n" },
        incoming: { exists: true, text: "from A\n" },
        chosenFrom: "current",
        metadata: { origin: "sync" },
      });
      await expect(
        checkA.readTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "docs/diverge.md",
        }),
      ).resolves.toMatchObject({ text: "from A\n" });
      const mirrored = await checkA.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(mirrored).toHaveLength(1);
      expect(mirrored[0]?.current.text).toBe(conflicts[0]?.incoming.text);
      expect(mirrored[0]?.incoming.text).toBe(conflicts[0]?.current.text);
    } finally {
      await checkA.close();
      await check.close();
    }
  });

  it("keeps record-only divergence rows valid after conflict resolution and reopen", async () => {
    const a = await tempRoot("sync-bug1-a");
    const b = await tempRoot("sync-bug1-b");
    const seed = await tempRoot("sync-bug1-seed");
    const ab = await tempRoot("sync-bug1-ab");
    const versionsA = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        text: "base",
        metadata: { origin: "api" },
      });
    } finally {
      await versionsA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });

    const editA = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a2-") });
    const editB = createVersionedTextStore(b, { nowMs: () => 3000, createId: createIdFactory("b-") });
    try {
      await editA.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from A", metadata: { origin: "api" } });
      await editB.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from B", metadata: { origin: "api" } });
    } finally {
      await editB.close();
      await editA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    const resolving = createVersionedTextStore(b, { nowMs: () => 4000, createId: createIdFactory("br-") });
    try {
      const [conflict] = await resolving.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(conflict).toBeTruthy();
      await resolving.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api" },
      });
    } finally {
      await resolving.close();
    }
    const reopened = createVersionedTextStore(b);
    try {
      await expect(reopened.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md" })).resolves.toMatchObject({ text: "from A" });
      const conflicts = await reopened.listTextConflicts({ workspaceId: WORKSPACE_ID });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.status).toBe("resolved");
    } finally {
      await reopened.close();
    }
  });

  it("does not fast-forward over a local file while a sync conflict is open", async () => {
    const a = await tempRoot("sync-bug2-a");
    const b = await tempRoot("sync-bug2-b");
    const seed = await tempRoot("sync-bug2-seed");
    const ab1 = await tempRoot("sync-bug2-ab1");
    const ab2 = await tempRoot("sync-bug2-ab2");
    const aStore = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await aStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await aStore.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "base", metadata: { origin: "api" } });
    } finally {
      await aStore.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });
    const editA = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a2-") });
    const editB = createVersionedTextStore(b, { nowMs: () => 3000, createId: createIdFactory("b-") });
    try {
      await editA.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from A", metadata: { origin: "api" } });
      await editB.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from B", metadata: { origin: "api" } });
    } finally {
      await editB.close();
      await editA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab1 });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab1 });
    const bHeadBefore = snapshotLatestMomentId(b, "docs/x.md");
    const aAgain = createVersionedTextStore(a, { nowMs: () => 5000, createId: createIdFactory("a3-") });
    try {
      await aAgain.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from A again", metadata: { origin: "api" } });
    } finally {
      await aAgain.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab2 });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab2 });
    const check = createVersionedTextStore(b);
    try {
      await expect(check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md" })).resolves.toMatchObject({ text: "from B" });
      expect(snapshotLatestMomentId(b, "docs/x.md")).toBe(bHeadBefore);
      const conflicts = await check.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      // Coalescing (0P sync-hardening item 2): the second divergent op from A
      // ("from A again") does NOT stack a second conflict on the same object —
      // it updates the one open conflict's incoming head. Exactly one open
      // conflict remains, now pointing at A's latest divergent content.
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.incoming.text).toBe("from A again");
    } finally {
      await check.close();
    }
  });

  it("syncs delete followed by recreate and still fails closed on origin sequence gaps", async () => {
    const a = await tempRoot("sync-bug3-a");
    const b = await tempRoot("sync-bug3-b");
    const seed = await tempRoot("sync-bug3-seed");
    const bundle = await tempRoot("sync-bug3-bundle");
    const gapBundle = await tempRoot("sync-gap-bundle");
    const versions = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versions.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "base", metadata: { origin: "api" } });
    } finally {
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });
    const edit = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a2-") });
    try {
      await edit.deleteTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", metadata: { origin: "api" } });
      await edit.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "recreated", metadata: { origin: "api" } });
    } finally {
      await edit.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const check = createVersionedTextStore(b);
    try {
      await expect(check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md" })).resolves.toMatchObject({ text: "recreated" });
    } finally {
      await check.close();
    }

    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: gapBundle });
    const [opsFile] = (await readdir(join(gapBundle, "ops"))).filter((file) => file.endsWith(".jsonl"));
    const opsPath = join(gapBundle, "ops", opsFile!);
    const lines = (await readFile(opsPath, "utf8")).trimEnd().split("\n");
    await writeFile(opsPath, `${[lines[0], ...lines.slice(2)].join("\n")}\n`, "utf8");
    // Keep the manifest consistent with the tampered file (count down one,
    // same min/max) so the STORE-level per-origin gap check is what trips,
    // not the earlier manifest/file verification.
    const manifestPath = join(gapBundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      origins: Array<{ originId: string; count: number }>;
    };
    const originId = String(JSON.parse(lines[0]!).originId);
    const origin = manifest.origins.find((entry) => entry.originId === originId);
    origin!.count -= 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const c = await tempRoot("sync-gap-c");
    await expect(importSyncBundle({ rootDir: c, workspaceId: WORKSPACE_ID, fromDir: gapBundle })).rejects.toThrow(/gap before sequence/u);
  });

  it("keeps active version and chat read cursors local-only in logs and bundles", async () => {
    const root = await tempRoot("sync-local-only");
    const bundle = await tempRoot("sync-local-only-bundle");
    const now = { value: 6000 };
    const versions = textStore(root, now);
    const chats = chatStore(root, now);
    try {
      const main = await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const named = await versions.createNamedVersion({ workspaceId: WORKSPACE_ID, name: "Local", fromVersionId: main.id });
      const beforeActiveRows = replicationRows(root).length;
      await versions.setActiveVersion({ workspaceId: WORKSPACE_ID, versionId: named.id });
      expect(replicationRows(root)).toHaveLength(beforeActiveRows);
      const general = await chats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const started = await chats.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: general.id,
        title: "Read cursor",
        author: { kind: "agent", displayName: "Agent" },
        body: "please read",
      });
      const beforeReadRows = replicationRows(root).length;
      await chats.markThreadRead({ workspaceId: WORKSPACE_ID, threadId: started.thread.id, upToSequence: 1 });
      expect(replicationRows(root)).toHaveLength(beforeReadRows);
      await exportSyncBundle({ rootDir: root, workspaceId: WORKSPACE_ID, toDir: bundle });
      const bytes = await walkTextFiles(bundle);
      expect(bytes).not.toContain("active_versions");
      expect(bytes).not.toContain("chat_thread_read_state");
      expect(bytes).not.toContain("engine_search_files_fts");
      expect(bytes).not.toContain("engine_search_chat_messages_fts");
    } finally {
      await chats.close();
      await versions.close();
    }
  });

  it("replicates secret store writes as ciphertext without leaking plaintext or the raw key", async () => {
    const root = await tempRoot("sync-secret");
    const bundle = await tempRoot("sync-secret-bundle");
    const versions = createVersionedTextStore(root);
    let secretMoment = 0;
    const secrets = createSecretFileStore(root, {
      createId: () => {
        secretMoment += 1;
        return `secret-moment-${secretMoment}`;
      },
    });
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: `TOKEN=${SECRET_MARKER}\n`,
        metadata: { origin: "local-file", summary: "secret" },
      });
      await secrets.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "local-file", summary: "secret delete" },
      });
      expect(replicationRows(root).map((row) => row.op_kind)).toEqual([
        "workspace.init",
        "secret.file.put",
        "secret.file.delete",
      ]);
      await exportSyncBundle({ rootDir: root, workspaceId: WORKSPACE_ID, toDir: bundle });
      const textBytes = await walkTextFiles(bundle);
      const allBytes = await walkFileBytes(bundle);
      const keyFile = await readFile(join(root, ".dohc/engine/secret.key"), "utf8");
      const keyBase64 = keyFile.trim().slice("dohc-secret-key-v1:".length);
      const rawKey = Buffer.from(keyBase64, "base64");
      expect(textBytes).toContain("workspace.init");
      expect(textBytes).toContain("secret.file.put");
      expect(textBytes).toContain("secret.file.delete");
      // 0P-D deliberately moved the boundary: secret paths may ride the
      // authenticated replication payload so the importer can reconstruct
      // AAD (see the design doc's Secrets section). Plaintext and the raw
      // workspace data key still must never leave the originating store.
      expect(textBytes).toContain(".env");
      expect(allBytes.includes(Buffer.from(SECRET_MARKER))).toBe(false);
      expect(allBytes.includes(Buffer.from(`TOKEN=${SECRET_MARKER}\n`))).toBe(false);
      expect(allBytes.includes(Buffer.from(keyBase64))).toBe(false);
      expect(allBytes.includes(rawKey)).toBe(false);
    } finally {
      await secrets.close();
      await versions.close();
    }
  });

  it("fails closed when replicated secret ciphertext is spliced across paths (AAD binding)", async () => {
    const a = await tempRoot("sync-secret-splice-a");
    const b = await tempRoot("sync-secret-splice-b");
    const bundle = await tempRoot("sync-secret-splice-bundle");
    const versions = createVersionedTextStore(a);
    const secrets = createSecretFileStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: `TOKEN=${SECRET_MARKER}\n`,
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "prod.env",
        text: "PROD=1\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected protected key");
    await installWorkspaceDataKey(b, key);
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    const opDir = join(bundle, "ops");
    const opFile = join(opDir, (await readdir(opDir))[0]!);
    const ops = (await readFile(opFile, "utf8"))
      .split(/\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const envPut = ops.find(
      (op) => op.opKind === "secret.file.put" && (op.payload as { path?: string }).path === ".env",
    )!;
    const prodPut = ops.find(
      (op) => op.opKind === "secret.file.put" && (op.payload as { path?: string }).path === "prod.env",
    )!;
    const envPayload = envPut.payload as Record<string, unknown>;
    const prodPayload = prodPut.payload as Record<string, unknown>;
    prodPayload.ivBase64 = envPayload.ivBase64;
    prodPayload.authTagBase64 = envPayload.authTagBase64;
    prodPayload.ciphertextSha256 = envPayload.ciphertextSha256;
    prodPayload.byteLength = envPayload.byteLength;
    await writeFile(opFile, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "prod.env",
        }),
      ).rejects.toMatchObject({ code: "decrypt-failed" });
    } finally {
      await imported.close();
    }
  });

  it("converges same-timestamp divergent secret writes with a deterministic content rank", async () => {
    const a = await tempRoot("sync-secret-tie-write-a");
    const b = await tempRoot("sync-secret-tie-write-b");
    const versionsA = createVersionedTextStore(a);
    const versionsB = createVersionedTextStore(b);
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsB.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    } finally {
      await versionsB.close();
      await versionsA.close();
    }
    const secretsA = createSecretFileStore(a, {
      nowMs: () => 9000,
      createId: createIdFactory("a-secret-"),
    });
    try {
      await secretsA.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "SIDE=a\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await secretsA.close();
    }
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected protected key");
    await installWorkspaceDataKey(b, key);
    const writeB = createSecretFileStore(b, {
      nowMs: () => 9000,
      createId: createIdFactory("b-secret-"),
    });
    try {
      await writeB.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "SIDE=b\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await writeB.close();
    }

    await syncBothWays(a, b, "sync-secret-tie-write");

    const checkA = createSecretFileStore(a);
    const checkB = createSecretFileStore(b);
    try {
      const tipA = await checkA.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      const tipB = await checkB.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(tipA).toEqual(tipB);
      expect(tipA.present ? ["SIDE=a\n", "SIDE=b\n"].includes(tipA.text) : false).toBe(true);
      expect(sealedTipDigest(b)).toEqual(sealedTipDigest(a));
    } finally {
      await checkB.close();
      await checkA.close();
    }
  });

  it("converges a same-timestamp secret delete-vs-write tie with the write winning on both machines", async () => {
    const a = await tempRoot("sync-secret-tie-delete-a");
    const b = await tempRoot("sync-secret-tie-delete-b");
    const versionsA = createVersionedTextStore(a);
    const versionsB = createVersionedTextStore(b);
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsB.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    } finally {
      await versionsB.close();
      await versionsA.close();
    }
    const seedA = createSecretFileStore(a, {
      nowMs: () => 1000,
      createId: createIdFactory("seed-secret-"),
    });
    try {
      await seedA.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "BASE=1\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await seedA.close();
    }
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected protected key");
    await installWorkspaceDataKey(b, key);
    await syncBothWays(a, b, "sync-secret-tie-delete-seed");

    const deleteA = createSecretFileStore(a, {
      nowMs: () => 9000,
      createId: createIdFactory("a-delete-secret-"),
    });
    const writeB = createSecretFileStore(b, {
      nowMs: () => 9000,
      createId: createIdFactory("b-write-secret-"),
    });
    try {
      await deleteA.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "local-file" },
      });
      await writeB.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "SIDE=b\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await writeB.close();
      await deleteA.close();
    }

    await syncBothWays(a, b, "sync-secret-tie-delete");

    const checkA = createSecretFileStore(a);
    const checkB = createSecretFileStore(b);
    try {
      const tipA = await checkA.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      const tipB = await checkB.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(tipA).toEqual({ present: true, text: "SIDE=b\n" });
      expect(tipB).toEqual(tipA);
      expect(sealedTipDigest(b)).toEqual(sealedTipDigest(a));
    } finally {
      await checkB.close();
      await checkA.close();
    }
  });

  it("round-trips a secret restore through folder sync", async () => {
    const a = await tempRoot("sync-secret-restore-a");
    const b = await tempRoot("sync-secret-restore-b");
    const bundle = await tempRoot("sync-secret-restore-bundle");
    const versions = createVersionedTextStore(a, { createId: createIdFactory("text-") });
    const secrets = createSecretFileStore(a, { createId: createIdFactory("secret-") });
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "RESTORE=old\n",
        metadata: { origin: "local-file" },
      });
      const updated = await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "RESTORE=new\n",
        metadata: { origin: "local-file" },
      });
      const updatedMomentId = updated.moment?.id;
      expect(updatedMomentId).toBeTruthy();
      await secrets.restoreSecretFileToBeforeMoment({
        workspaceId: WORKSPACE_ID,
        momentId: updatedMomentId!,
        metadata: { origin: "restore" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected protected key");
    await installWorkspaceDataKey(b, key);
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).resolves.toEqual({ present: true, text: "RESTORE=old\n" });
    } finally {
      await imported.close();
    }
  });

  it("replicates secret tips and fork bases through secret.version.fork", async () => {
    const a = await tempRoot("sync-secret-fork-a");
    const b = await tempRoot("sync-secret-fork-b");
    const bundle = await tempRoot("sync-secret-fork-bundle");
    const versions = createVersionedTextStore(a, { createId: createIdFactory("text-") });
    const secrets = createSecretFileStore(a, { createId: createIdFactory("secret-") });
    let versionId = "";
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "FORKED=1\n",
        metadata: { origin: "local-file" },
      });
      versionId = (
        await versions.createNamedVersion({
          workspaceId: WORKSPACE_ID,
          name: "Staging",
          fromVersionId: "main",
        })
      ).id;
      await secrets.forkVersion({
        workspaceId: WORKSPACE_ID,
        fromVersionId: "main",
        toVersionId: versionId,
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    expect(replicationRows(a).map((row) => row.op_kind)).toContain("secret.version.fork");
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected protected key");
    await installWorkspaceDataKey(b, key);
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });

    const imported = createSecretFileStore(b);
    try {
      expect(await imported.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId })).toEqual([
        expect.objectContaining({ path: ".env", byteLength: Buffer.byteLength("FORKED=1\n") }),
      ]);
      await expect(
        imported.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId,
          path: ".env",
        }),
      ).resolves.toEqual({ present: true, text: "FORKED=1\n" });
      expect(secretCipherRows(b, versionId)).toEqual(secretCipherRows(a, versionId));
      expect(secretForkBaseRows(b, versionId)).toEqual(secretForkBaseRows(a, versionId));
    } finally {
      await imported.close();
    }
  });

  it("rejects malformed replicated secret byteLength without poisoning secret rows", async () => {
    const a = await tempRoot("sync-secret-invalid-a");
    const b = await tempRoot("sync-secret-invalid-b");
    const bundle = await tempRoot("sync-secret-invalid-bundle");
    const versions = createVersionedTextStore(a);
    const secrets = createSecretFileStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "BAD_LENGTH=1\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    const opFile = join(bundle, "ops", (await readdir(join(bundle, "ops")))[0]!);
    const ops = (await readFile(opFile, "utf8"))
      .split(/\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const put = ops.find((op) => op.opKind === "secret.file.put");
    if (!put || !put.payload || typeof put.payload !== "object") throw new Error("expected put op");
    (put.payload as Record<string, unknown>).byteLength = "x";
    await writeFile(opFile, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");

    await expect(
      importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId: "main" }),
      ).resolves.toEqual([]);
      await imported.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "prod.env",
        text: "OTHER=1\n",
        metadata: { origin: "local-file" },
      });
      await expect(
        imported.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "prod.env",
        }),
      ).resolves.toEqual({ present: true, text: "OTHER=1\n" });
    } finally {
      await imported.close();
    }
  });

  // Gate finding (0P-D): secret ciphertext rides the 5 MiB binary-blob
  // transport while secrets cap at 1 MiB plaintext, and GCM here is
  // length-preserving (tag + IV travel separately), so the actual blob must
  // equal the declared byteLength exactly and stay under the secret cap.
  it("rejects secret ciphertext whose bytes mismatch the declared byteLength", async () => {
    const a = await tempRoot("sync-secret-lenmismatch-a");
    const b = await tempRoot("sync-secret-lenmismatch-b");
    const bundle = await tempRoot("sync-secret-lenmismatch-bundle");
    const versions = createVersionedTextStore(a);
    const secrets = createSecretFileStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "LENGTH_POISON=1\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    const { file, ops } = await readBundleOps(bundle);
    const put = ops.find((op) => op.opKind === "secret.file.put");
    if (!put || !put.payload || typeof put.payload !== "object") throw new Error("expected put op");
    const payload = put.payload as Record<string, unknown>;
    // Declared byteLength passes the standalone range check (integer, under
    // the cap) but disagrees with the actual ciphertext bytes by one.
    payload.byteLength = Number(payload.byteLength) - 1;
    await writeBundleOps(file, ops);

    await expect(
      importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId: "main" }),
      ).resolves.toEqual([]);
    } finally {
      await imported.close();
    }
  });

  it("rejects a secret ciphertext blob smuggled in above the 1 MiB secret cap", async () => {
    const a = await tempRoot("sync-secret-oversize-a");
    const b = await tempRoot("sync-secret-oversize-b");
    const bundle = await tempRoot("sync-secret-oversize-bundle");
    const versions = createVersionedTextStore(a);
    const secrets = createSecretFileStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "OVERSIZE_POISON=1\n",
        metadata: { origin: "local-file" },
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    // A blob above the secret plaintext cap but under the binary transport
    // cap (5 MiB) — the transport accepts it, the secret store must not.
    const oversized = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1, 0x41);
    const oversizedSha = createHash("sha256").update(oversized).digest("hex");
    await writeFile(join(bundle, "blobs-bin", oversizedSha), oversized);
    const { file, ops } = await readBundleOps(bundle);
    const put = ops.find((op) => op.opKind === "secret.file.put");
    if (!put || !put.payload || typeof put.payload !== "object") throw new Error("expected put op");
    (put.payload as Record<string, unknown>).ciphertextSha256 = oversizedSha;
    await writeBundleOps(file, ops);

    await expect(
      importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const imported = createSecretFileStore(b);
    try {
      await expect(
        imported.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId: "main" }),
      ).resolves.toEqual([]);
    } finally {
      await imported.close();
    }
  });

  // Gate finding (0P-D): an imported secret.version.fork must be verified
  // against the importer's own sealed source tips for fromVersionId — a
  // poison fork that swaps sealed rows between paths is rejected and the
  // destination version survives untouched (no partial wipe).
  it("rejects a poison secret fork with swapped rows and keeps the destination intact", async () => {
    const a = await tempRoot("sync-secret-poisonfork-a");
    const b = await tempRoot("sync-secret-poisonfork-b");
    const versions = createVersionedTextStore(a, { createId: createIdFactory("text-") });
    const secrets = createSecretFileStore(a, { createId: createIdFactory("secret-") });
    let versionId = "";
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "FORK_A=short\n",
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "prod.env",
        text: "FORK_B=deliberately-longer-content\n",
        metadata: { origin: "local-file" },
      });
      versionId = (
        await versions.createNamedVersion({
          workspaceId: WORKSPACE_ID,
          name: "Staging",
          fromVersionId: "main",
        })
      ).id;
      await secrets.forkVersion({
        workspaceId: WORKSPACE_ID,
        fromVersionId: "main",
        toVersionId: versionId,
      });
    } finally {
      await secrets.close();
      await versions.close();
    }
    const key = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!key) throw new Error("expected protected key");
    await installWorkspaceDataKey(b, key);
    // First round: the legitimate fork lands on b.
    const bundle1 = await tempRoot("sync-secret-poisonfork-bundle1");
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle1 });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle1 });
    const destinationBefore = secretCipherRows(b, versionId);
    const forkBasesBefore = secretForkBaseRows(b, versionId);
    expect(destinationBefore).toHaveLength(2);

    // Second round: a re-forks after an update; the bundle op is poisoned by
    // swapping the sealed tuples between the two paths (each still a REAL
    // ciphertext the importer holds — only the path binding lies).
    const update = createSecretFileStore(a, { createId: createIdFactory("secret2-") });
    try {
      await update.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "FORK_A=updated\n",
        metadata: { origin: "local-file" },
      });
      await update.forkVersion({
        workspaceId: WORKSPACE_ID,
        fromVersionId: "main",
        toVersionId: versionId,
      });
    } finally {
      await update.close();
    }
    const bundle2 = await tempRoot("sync-secret-poisonfork-bundle2");
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle2 });
    const { file, ops } = await readBundleOps(bundle2);
    const forks = ops.filter((op) => op.opKind === "secret.version.fork");
    const poisoned = forks[forks.length - 1];
    if (!poisoned) throw new Error("expected a second fork op");
    const rows = (poisoned.payload as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toHaveLength(2);
    const sealedFields = ["ivBase64", "authTagBase64", "ciphertextSha256", "byteLength"] as const;
    for (const field of sealedFields) {
      const swap = rows[0]![field];
      rows[0]![field] = rows[1]![field];
      rows[1]![field] = swap;
    }
    await writeBundleOps(file, ops);

    await expect(
      importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle2 }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    // Destination version intact: the poison fork neither wiped nor replaced
    // the previously replicated rows.
    expect(secretCipherRows(b, versionId)).toEqual(destinationBefore);
    expect(secretForkBaseRows(b, versionId)).toEqual(forkBasesBefore);
    const check = createSecretFileStore(b);
    try {
      await expect(
        check.materializeSecretFile({ workspaceId: WORKSPACE_ID, versionId, path: ".env" }),
      ).resolves.toEqual({ present: true, text: "FORK_A=short\n" });
    } finally {
      await check.close();
    }
  });

  // Gate finding (0P-D): a fork op without rows must be an honest rejection
  // at the payload boundary, not a TypeError inside blob-ref collection.
  it("rejects a secret fork op with missing rows without crashing", async () => {
    const root = await tempRoot("sync-secret-norows");
    const versions = createVersionedTextStore(root);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    } finally {
      await versions.close();
    }
    const malformed = {
      workspaceId: WORKSPACE_ID,
      originId: "poison-origin",
      originSeq: 0,
      opKind: "secret.version.fork",
      payload: { toVersionId: "staging", fromVersionId: "main" },
      recordedAtMs: 1234,
    } as unknown as SyncReplicationEnvelope;
    await expect(
      applySyncQueues({
        rootDir: root,
        workspaceId: WORKSPACE_ID,
        queues: [[malformed]],
        blobSource: async () => {
          throw new Error("no blobs should be fetched for a rowless fork");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rebuilds file and chat FTS surfaces after import", async () => {
    const a = await tempRoot("sync-fts-a");
    const b = await tempRoot("sync-fts-b");
    const bundle = await tempRoot("sync-fts-bundle");
    const now = { value: 5000 };
    const versions = textStore(a, now);
    const chats = chatStore(a, now);
    try {
      const main = await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const file = await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: main.id,
        path: "docs/search.md",
        text: "findable imported keyword\n",
        metadata: { origin: "api" },
      });
      const thread = await chats.createThread({
        workspaceId: WORKSPACE_ID,
        title: "Search thread",
        linkedFile: { objectId: file.object.id, pathHint: "docs/search.md" },
      });
      await chats.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: thread.id,
        author: { kind: "human", displayName: "Ice" },
        body: "chat imported keyword",
      });
    } finally {
      await chats.close();
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const importedVersions = createVersionedTextStore(b);
    const importedChats = createLinkedChatStore(b);
    try {
      const results = await searchWorkspaceEngine({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        query: "imported",
        versions: importedVersions,
        chats: importedChats,
      });
      expect(results.map((result) => result.surface).sort()).toEqual(["chat", "file"]);
      expect(results.map((result) => result.preview).join("\n")).not.toContain(SECRET_MARKER);
    } finally {
      await importedChats.close();
      await importedVersions.close();
    }
  });

  it("round-trips general channel threads, messages, search, and unread state", async () => {
    const a = await tempRoot("sync-channel-a");
    const b = await tempRoot("sync-channel-b");
    const bundle = await tempRoot("sync-channel-bundle");
    const now = { value: 7000 };
    const chats = chatStore(a, now);
    const versions = createVersionedTextStore(a);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const general = await chats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const started = await chats.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: general.id,
        title: "",
        author: { kind: "human", displayName: "Ice" },
        body: "channel first searchable",
      });
      await chats.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        author: { kind: "agent", displayName: "Agent" },
        body: "channel second message",
      });
      await chats.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        author: { kind: "human", displayName: "Ice" },
        body: "channel third message",
      });
    } finally {
      await versions.close();
      await chats.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const importedChats = createLinkedChatStore(b);
    const importedVersions = createVersionedTextStore(b);
    try {
      const channels = await importedChats.listChannels({ workspaceId: WORKSPACE_ID });
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({ name: "general", slug: "general", threadCount: 1, unreadCount: 3 });
      expect(channels[0]?.id).not.toBe("channel-1");
      const threads = await importedChats.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: channels[0]!.id });
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({
        messageCount: 3,
        lastReadSequence: 0,
        unreadCount: 3,
      });
      expect(threads[0]?.thread.title).toContain("channel first searchable");
      const messages = await importedChats.listMessages({ workspaceId: WORKSPACE_ID, threadId: threads[0]!.thread.id });
      expect(messages.map((message) => message.body)).toEqual([
        "channel first searchable",
        "channel second message",
        "channel third message",
      ]);
      const results = await searchWorkspaceEngine({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        query: "second",
        versions: importedVersions,
        chats: importedChats,
      });
      expect(results.some((result) => result.surface === "chat" && result.threadId === threads[0]?.thread.id)).toBe(true);
    } finally {
      await importedVersions.close();
      await importedChats.close();
    }
  });

  it("converges independently-created general channels by the well-known wire id", async () => {
    const a = await tempRoot("sync-general-a");
    const b = await tempRoot("sync-general-b");
    const nowA = { value: 8000 };
    const nowB = { value: 9000 };
    const chatsA = createLinkedChatStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("ga-"),
    });
    const chatsB = createLinkedChatStore(b, {
      nowMs: () => {
        nowB.value += 10;
        return nowB.value;
      },
      createId: createIdFactory("gb-"),
    });
    const versionsA = createVersionedTextStore(a);
    const versionsB = createVersionedTextStore(b);
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsB.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      const generalA = await chatsA.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const generalB = await chatsB.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      await chatsA.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: generalA.id,
        title: "A thread",
        author: { kind: "agent", displayName: "Agent A" },
        body: "hello from A",
      });
      await chatsB.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: generalB.id,
        title: "B thread",
        author: { kind: "agent", displayName: "Agent B" },
        body: "hello from B",
      });
      await syncBothWays(a, b, "sync-general");
      const [channelsA, channelsB] = await Promise.all([
        chatsA.listChannels({ workspaceId: WORKSPACE_ID }),
        chatsB.listChannels({ workspaceId: WORKSPACE_ID }),
      ]);
      expect(channelsA).toHaveLength(1);
      expect(channelsB).toHaveLength(1);
      expect(channelsA[0]).toMatchObject({ slug: "general", threadCount: 2 });
      expect(channelsB[0]).toMatchObject({ slug: "general", threadCount: 2 });
      const [threadsA, threadsB] = await Promise.all([
        chatsA.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: channelsA[0]!.id }),
        chatsB.listChannelThreads({ workspaceId: WORKSPACE_ID, channelId: channelsB[0]!.id }),
      ]);
      expect(threadsA.map(({ thread }) => thread.title).sort()).toEqual(["A thread", "B thread"]);
      expect(threadsB.map(({ thread }) => thread.title).sort()).toEqual(["A thread", "B thread"]);
      expect(rowCount(a, "chat_messages")).toBe(rowCount(b, "chat_messages"));
    } finally {
      await versionsB.close();
      await versionsA.close();
      await chatsB.close();
      await chatsA.close();
    }
  });

  it("round-trips binary files byte-exactly with bundled binary blobs", async () => {
    const a = await tempRoot("sync-bin-a");
    const b = await tempRoot("sync-bin-b");
    const bundle = await tempRoot("sync-bin-bundle");
    const bytes = Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00]);
    const now = { value: 7000 };
    const versions = textStore(a, now);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versions.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/logo.png",
        bytes,
        metadata: { origin: "api", summary: "binary seed" },
      });
    } finally {
      await versions.close();
    }
    const exported = await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    expect(exported.blobCount).toBeGreaterThan(0);
    const binDir = await readdir(join(bundle, "blobs-bin"));
    expect(binDir).toHaveLength(1);
    await expect(readFile(join(bundle, "blobs-bin", binDir[0]!))).resolves.toEqual(Buffer.from(bytes));

    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const imported = createVersionedTextStore(b);
    try {
      const read = await imported.readBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/logo.png",
      });
      expect(read && Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
      const files = await imported.listTextFiles({ workspaceId: WORKSPACE_ID, versionId: "main" });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: "assets/logo.png", contentKind: "binary" });
      // Binary content must never enter the FTS surface on the importer. No
      // optional chaining: if the search seam disappears this must FAIL, not
      // silently no-op the boundary check.
      const results = await imported.querySearchIndex!({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        query: "PNG",
        limit: 10,
      });
      expect(results).toHaveLength(0);
    } finally {
      await imported.close();
    }
  });

  // 0P-C gate fix: a binary blob's ANCHOR row in blobs (text = "") must
  // never satisfy a TEXT reference. A kind-confused op — claiming text kind
  // for a sha whose content is binary — has to fail closed as corruption,
  // not adopt/materialize empty text under a mismatched sha.
  it("rejects a kind-confused op whose text ref points at a binary anchor as state-corrupt", async () => {
    const a = await tempRoot("sync-kc-bin-a");
    const b = await tempRoot("sync-kc-bin-b");
    const bundle = await tempRoot("sync-kc-bin-bundle");
    const bytes = Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    const binarySha = createHash("sha256").update(bytes).digest("hex");
    const now = { value: 7000 };
    const versions = textStore(a, now);
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versions.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/logo.png",
        bytes,
        metadata: { origin: "api" },
      });
    } finally {
      await versions.close();
    }
    // B hydrates the binary blob through the real import path: binary_blobs
    // gets the bytes, blobs gets the text-side anchor row (text = "").
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });

    const confused = {
      workspaceId: WORKSPACE_ID,
      originId: "origin_confused",
      originSeq: 0,
      opKind: "moment.append" as const,
      payload: {
        momentId: "moment_confused_1",
        versionId: "main",
        objectId: "object_confused_1",
        path: "evil.md",
        recordedAtMs: 9000,
        operation: "write" as const,
        payloadBeforeBlobSha256: null,
        payloadBeforePath: null,
        // TEXT kind (absent contentKind) referencing the BINARY sha.
        payloadAfterBlobSha256: binarySha,
        payloadAfterPath: "evil.md",
        metadata: { origin: "api" as const },
        beforePresent: "absent" as const,
      },
      recordedAtMs: 9000,
    };

    // Direct store apply: requireBlobText must fail closed on the anchor.
    const store = createVersionedTextStore(b);
    try {
      await expect(store.applyReplicationOp(confused)).rejects.toMatchObject({
        code: "state-corrupt",
      });
      // Nothing was adopted: the confused path never materialized.
      expect(
        await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "evil.md" }),
      ).toBeNull();
    } finally {
      await store.close();
    }

    // Queue-level apply (the relay pull boundary): the anchor row must not
    // count as a hydrated text blob either — the ref is re-fetched and the
    // mismatching content is rejected as corruption before any op applies.
    await expect(
      applySyncQueues({
        rootDir: b,
        workspaceId: WORKSPACE_ID,
        queues: [[{ ...confused, originSeq: 1, payload: { ...confused.payload, momentId: "moment_confused_2" } }]],
        blobSource: async () => "",
      }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("preserves both sides as a conflict when the same binary path diverges", async () => {
    const a = await tempRoot("sync-bindiv-a");
    const b = await tempRoot("sync-bindiv-b");
    const seedDir = await tempRoot("sync-bindiv-seed");
    const abDir = await tempRoot("sync-bindiv-ab");
    const now = { value: 8000 };
    const seedStore = textStore(a, now);
    try {
      await seedStore.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await seedStore.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/data.bin",
        bytes: Uint8Array.from([1, 2, 3]),
        metadata: { origin: "api" },
      });
    } finally {
      await seedStore.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });

    const editA = createVersionedTextStore(a, { nowMs: () => 9000, createId: createIdFactory("ba-") });
    const editB = createVersionedTextStore(b, { nowMs: () => 9500, createId: createIdFactory("bb-") });
    try {
      await editA.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/data.bin",
        bytes: Uint8Array.from([0xaa, 0xaa]),
        metadata: { origin: "api" },
      });
      await editB.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/data.bin",
        bytes: Uint8Array.from([0xbb, 0xbb, 0xbb]),
        metadata: { origin: "api" },
      });
    } finally {
      await editB.close();
      await editA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: abDir });
    const result = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: abDir });
    expect(result.conflictsOpened).toBe(1);
    const check = createVersionedTextStore(b);
    try {
      const live = await check.readBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/data.bin",
      });
      expect(live && Buffer.from(live).equals(Buffer.from([0xbb, 0xbb, 0xbb]))).toBe(true);
      const conflicts = await check.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.current).toMatchObject({ exists: true, contentKind: "binary" });
      expect(conflicts[0]!.incoming).toMatchObject({ exists: true, contentKind: "binary" });
      expect(conflicts[0]!.current.sha256).not.toBe(conflicts[0]!.incoming.sha256);
      // The incoming binary bytes are already local (shipped in the bundle),
      // one restore away even though the live file kept the local edit.
      const incomingBytes = await check.readBinaryBlob({
        workspaceId: WORKSPACE_ID,
        sha256: conflicts[0]!.incoming.sha256 ?? "",
      });
      expect(incomingBytes && Buffer.from(incomingBytes).equals(Buffer.from([0xaa, 0xaa]))).toBe(true);
    } finally {
      await check.close();
    }
  });

  it("ignores non-manifest op files, clears reused export dirs, and fails closed on manifest mismatches", async () => {
    const a = await tempRoot("sync-m4-a");
    const b = await tempRoot("sync-m4-b");
    const bundle = await tempRoot("sync-m4-bundle");
    const versions = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        text: "manifest hygiene",
        metadata: { origin: "api" },
      });
    } finally {
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    // A stale/foreign op file that is NOT in the manifest is ignored — it
    // would crash any reader that touched it.
    await writeFile(join(bundle, "ops", "origin_stale.jsonl"), "not json at all\n", "utf8");
    const imported = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    expect(imported.applied).toBeGreaterThan(0);
    // Re-exporting into the same directory clears previous files first.
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await expect(readdir(join(bundle, "ops"))).resolves.not.toContain("origin_stale.jsonl");
    // An ops file that does not match its manifest entry fails closed.
    const [opsFile] = (await readdir(join(bundle, "ops"))).filter((file) => file.endsWith(".jsonl"));
    const opsPath = join(bundle, "ops", opsFile!);
    const lines = (await readFile(opsPath, "utf8")).trimEnd().split("\n");
    await writeFile(opsPath, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
    const c = await tempRoot("sync-m4-c");
    await expect(
      importSyncBundle({ rootDir: c, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toThrow(/do not match the manifest entry/u);
  });

  it("rejects tampered bundle blobs and detects poisoned pre-existing blob rows", async () => {
    const a = await tempRoot("sync-m5-a");
    const bundle = await tempRoot("sync-m5-bundle");
    const versions = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versions.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        text: "blob integrity content",
        metadata: { origin: "api" },
      });
      await versions.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/data.bin",
        bytes: Uint8Array.from([9, 8, 7, 0, 255]),
        metadata: { origin: "api" },
      });
    } finally {
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    const [textBlob] = (await readdir(join(bundle, "blobs"))).sort();
    const originalText = await readFile(join(bundle, "blobs", textBlob!), "utf8");
    // Tampered text blob: filename/content mismatch fails closed.
    await writeFile(join(bundle, "blobs", textBlob!), "tampered text", "utf8");
    const b1 = await tempRoot("sync-m5-b1");
    await expect(
      importSyncBundle({ rootDir: b1, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toThrow(/does not match its content hash/u);
    await writeFile(join(bundle, "blobs", textBlob!), originalText, "utf8");
    // Tampered binary blob likewise.
    const [binBlob] = await readdir(join(bundle, "blobs-bin"));
    const originalBin = await readFile(join(bundle, "blobs-bin", binBlob!));
    await writeFile(join(bundle, "blobs-bin", binBlob!), Buffer.from([1, 2, 3]));
    const b2 = await tempRoot("sync-m5-b2");
    await expect(
      importSyncBundle({ rootDir: b2, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toThrow(/does not match its content hash/u);
    await writeFile(join(bundle, "blobs-bin", binBlob!), originalBin);
    // Poisoned pre-existing row on the importer: same sha key, different
    // content. INSERT OR IGNORE would silently keep it; verification refuses.
    const b3 = await tempRoot("sync-m5-b3");
    const poisonedSetup = createVersionedTextStore(b3);
    try {
      await poisonedSetup.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    } finally {
      await poisonedSetup.close();
    }
    const db = rawDb(b3);
    try {
      db.prepare("INSERT INTO blobs (sha256, byte_length, text) VALUES (?, ?, ?)").run(
        textBlob,
        8,
        "poisoned",
      );
    } finally {
      db.close();
    }
    await expect(
      importSyncBundle({ rootDir: b3, workspaceId: WORKSPACE_ID, fromDir: bundle }),
    ).rejects.toThrow(/does not match the sync bundle content/u);
  });

  it("keeps same-slug channels with different wire ids distinct across sync", async () => {
    const a = await tempRoot("sync-m6-a");
    const b = await tempRoot("sync-m6-b");
    const nowA = { value: 1000 };
    const nowB = { value: 2000 };
    const versionsA = createVersionedTextStore(a);
    const versionsB = createVersionedTextStore(b);
    // Distinct id prefixes per side: wire ids are the creators' channel ids,
    // which are globally unique uuids in production.
    const chatsA = createLinkedChatStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("m6a-"),
    });
    const chatsB = createLinkedChatStore(b, {
      nowMs: () => {
        nowB.value += 10;
        return nowB.value;
      },
      createId: createIdFactory("m6b-"),
    });
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsB.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      // "a b" and "a_b" slugify identically — but they are DIFFERENT channels
      // (different wire ids) and must never merge under sync.
      await chatsA.createChannel({ workspaceId: WORKSPACE_ID, name: "a b" });
      await chatsB.createChannel({ workspaceId: WORKSPACE_ID, name: "a_b" });
      await syncBothWays(a, b, "sync-m6");
      const [channelsA, channelsB] = await Promise.all([
        chatsA.listChannels({ workspaceId: WORKSPACE_ID }),
        chatsB.listChannels({ workspaceId: WORKSPACE_ID }),
      ]);
      expect(channelsA).toHaveLength(2);
      expect(channelsB).toHaveLength(2);
      expect(channelsA.map((channel) => channel.name).sort()).toEqual(["a b", "a_b"]);
      expect(channelsB.map((channel) => channel.name).sort()).toEqual(["a b", "a_b"]);
      // The local channel keeps its slug; the imported same-slug channel gets
      // a numbered variant.
      expect(channelsA.map((channel) => channel.slug).sort()).toEqual(["a-b", "a-b-2"]);
      expect(channelsB.map((channel) => channel.slug).sort()).toEqual(["a-b", "a-b-2"]);
      expect(channelsA.find((channel) => channel.name === "a b")?.slug).toBe("a-b");
      expect(channelsB.find((channel) => channel.name === "a_b")?.slug).toBe("a-b");
    } finally {
      await chatsB.close();
      await chatsA.close();
      await versionsB.close();
      await versionsA.close();
    }
  });

  // Shared setup for the record-only divergence scenarios: seed docs/x.md on
  // A, replicate to B, then let both sides edit so importing A's op lands on B
  // as a record-only moment (aMomentId) newer than B's live head (bMomentId).
  async function seedRecordOnlyDivergence(label: string): Promise<{
    a: string;
    b: string;
    aMomentId: string;
    bMomentId: string;
  }> {
    const a = await tempRoot(`${label}-a`);
    const b = await tempRoot(`${label}-b`);
    const seed = await tempRoot(`${label}-seed`);
    const ab = await tempRoot(`${label}-ab`);
    const versionsA = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        text: "base",
        metadata: { origin: "api" },
      });
    } finally {
      await versionsA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });
    const editA = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a2-") });
    let aMomentId = "";
    try {
      aMomentId = (
        await editA.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "docs/x.md",
          text: "from A",
          metadata: { origin: "api" },
        })
      ).moment.id;
    } finally {
      await editA.close();
    }
    const editB = createVersionedTextStore(b, { nowMs: () => 3000, createId: createIdFactory("b-") });
    let bMomentId = "";
    try {
      bMomentId = (
        await editB.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "docs/x.md",
          text: "from B",
          metadata: { origin: "api" },
        })
      ).moment.id;
    } finally {
      await editB.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    return { a, b, aMomentId, bMomentId };
  }

  it("marks record-only divergence moments on timeline surfaces and rejects rolling them back", async () => {
    const { b, aMomentId, bMomentId } = await seedRecordOnlyDivergence("sync-c1");
    const store = createVersionedTextStore(b, { nowMs: () => 5000, createId: createIdFactory("bc1-") });
    try {
      // Timeline surfaces show the divergent history, explicitly marked.
      const page = await store.listMoments({ workspaceId: WORKSPACE_ID, versionId: "main" });
      const recordOnly = page.moments.find((moment) => moment.id === aMomentId);
      expect(recordOnly).toBeTruthy();
      expect(recordOnly?.syncRecordOnly).toBe(true);
      expect(page.moments.find((moment) => moment.id === bMomentId)?.syncRecordOnly).toBeUndefined();
      await expect(store.getMoment({ workspaceId: WORKSPACE_ID, momentId: aMomentId })).resolves.toMatchObject({
        syncRecordOnly: true,
      });
      // Rolling back the record-only moment must be rejected: pre-fix it
      // rewrote/deleted B's LIVE snapshot from A's divergent preimage.
      await expect(
        store.rollbackTextFileMutation({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "docs/x.md",
          mutationMomentId: aMomentId,
        }),
      ).rejects.toThrow(/record-only/u);
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md" }),
      ).resolves.toMatchObject({ text: "from B" });
      // B's own head stays rollback-able even though the record-only row has a
      // newer moment_order: record-only rows are inert for head selection.
      await store.rollbackTextFileMutation({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        mutationMomentId: bMomentId,
      });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md" }),
      ).resolves.toMatchObject({ text: "base" });
    } finally {
      await store.close();
    }
  });

  it("selects the materialized head as the fork point when record-only rows are newer", async () => {
    const { b, aMomentId, bMomentId } = await seedRecordOnlyDivergence("sync-c2-head");
    const store = createVersionedTextStore(b, { nowMs: () => 5000, createId: createIdFactory("bf-") });
    try {
      const version = await store.createNamedVersion({
        workspaceId: WORKSPACE_ID,
        name: "Fork",
        fromVersionId: "main",
      });
      expect(version.forkPoint?.momentId).toBe(bMomentId);
      expect(version.forkPoint?.momentId).not.toBe(aMomentId);
    } finally {
      await store.close();
    }
  });

  it("replays version.create from the origin fork-point state, not the importer's snapshots", async () => {
    const a = await tempRoot("sync-c2-a");
    const b = await tempRoot("sync-c2-b");
    const seed = await tempRoot("sync-c2-seed");
    const ab = await tempRoot("sync-c2-ab");
    const versionsA = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/shared.md",
        text: "shared base",
        metadata: { origin: "api" },
      });
    } finally {
      await versionsA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });

    // B makes unrelated main edits that must NOT be absorbed into A's fork.
    const editB = createVersionedTextStore(b, { nowMs: () => 2000, createId: createIdFactory("b-") });
    try {
      await editB.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/b-local.md",
        text: "b local only",
        metadata: { origin: "api" },
      });
      await editB.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/shared.md",
        text: "shared from B",
        metadata: { origin: "api" },
      });
    } finally {
      await editB.close();
    }

    const forkA = createVersionedTextStore(a, { nowMs: () => 3000, createId: createIdFactory("a2-") });
    let versionId = "";
    try {
      versionId = (
        await forkA.createNamedVersion({ workspaceId: WORKSPACE_ID, name: "Feature", fromVersionId: "main" })
      ).id;
    } finally {
      await forkA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });

    const check = createVersionedTextStore(b);
    try {
      const forkFiles = await check.listTextFiles({ workspaceId: WORKSPACE_ID, versionId });
      expect(forkFiles.map((file) => [file.path, file.text])).toEqual([["docs/shared.md", "shared base"]]);
      // B's own main state stays untouched.
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/shared.md" }),
      ).resolves.toMatchObject({ text: "shared from B" });
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/b-local.md" }),
      ).resolves.toMatchObject({ text: "b local only" });
    } finally {
      await check.close();
    }
  });

  it("models rename-vs-rename with an occupied destination as object + occupancy conflicts", async () => {
    const a = await tempRoot("sync-m2-a");
    const b = await tempRoot("sync-m2-b");
    const seed = await tempRoot("sync-m2-seed");
    const ab = await tempRoot("sync-m2-ab");
    const versionsA = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        text: "object content",
        metadata: { origin: "api" },
      });
    } finally {
      await versionsA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });
    const editA = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a2-") });
    const editB = createVersionedTextStore(b, { nowMs: () => 3000, createId: createIdFactory("b-") });
    try {
      await editA.renameTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        fromPath: "docs/x.md",
        toPath: "docs/z.md",
        metadata: { origin: "api" },
      });
      await editB.renameTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        fromPath: "docs/x.md",
        toPath: "docs/y.md",
        metadata: { origin: "api" },
      });
      await editB.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/z.md",
        text: "occupant",
        metadata: { origin: "api" },
      });
    } finally {
      await editB.close();
      await editA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    const result = await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    // One divergence conflict at the OBJECT (both paths recorded) plus one
    // path-occupancy conflict for the z occupant.
    expect(result.conflictsOpened).toBe(2);
    const check = createVersionedTextStore(b, { nowMs: () => 5000, createId: createIdFactory("bc-") });
    try {
      const conflicts = await check.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(conflicts).toHaveLength(2);
      const divergence = conflicts.find(
        (conflict) => conflict.current.objectId === conflict.incoming.objectId,
      );
      const occupancy = conflicts.find(
        (conflict) => conflict.current.objectId !== conflict.incoming.objectId,
      );
      expect(divergence).toMatchObject({
        current: { exists: true, path: "docs/y.md" },
        incoming: { exists: true, path: "docs/z.md" },
      });
      expect(occupancy).toMatchObject({
        path: "docs/z.md",
        current: { exists: true, path: "docs/z.md", text: "occupant" },
        incoming: { exists: true, path: "docs/z.md" },
      });
      // Applying the incoming MOVE while z is occupied fails closed instead
      // of silently writing the incoming state back at the local path y.
      await expect(
        check.resolveTextConflict({
          workspaceId: WORKSPACE_ID,
          conflictId: divergence!.id,
          resolution: { kind: "apply-incoming" },
          metadata: { origin: "api" },
        }),
      ).rejects.toThrow(/already exists/u);
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/y.md" }),
      ).resolves.toMatchObject({ text: "object content" });
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/z.md" }),
      ).resolves.toMatchObject({ text: "occupant" });
      // Once the occupant is handled (deleted here), applying incoming
      // performs the move to incoming.path.
      await check.deleteTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/z.md",
        metadata: { origin: "api" },
      });
      await check.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: divergence!.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api" },
      });
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/y.md" }),
      ).resolves.toBeNull();
      await expect(
        check.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/z.md" }),
      ).resolves.toMatchObject({ text: "object content" });
    } finally {
      await check.close();
    }
  });

  it("resolves the mirrored sync conflict from a peer's conflict.resolve and surfaces unmatched ones", async () => {
    const a = await tempRoot("sync-m3-a");
    const b = await tempRoot("sync-m3-b");
    const seed = await tempRoot("sync-m3-seed");
    const ab = await tempRoot("sync-m3-ab");
    const ba = await tempRoot("sync-m3-ba");
    const versionsA = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    try {
      await versionsA.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versionsA.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "docs/x.md",
        text: "base",
        metadata: { origin: "api" },
      });
    } finally {
      await versionsA.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seed });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seed });
    const editA = createVersionedTextStore(a, { nowMs: () => 2000, createId: createIdFactory("a2-") });
    const editB = createVersionedTextStore(b, { nowMs: () => 3000, createId: createIdFactory("b-") });
    try {
      await editA.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from A", metadata: { origin: "api" } });
      await editB.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "docs/x.md", text: "from B", metadata: { origin: "api" } });
    } finally {
      await editB.close();
      await editA.close();
    }
    // Both sides import the other's divergent edit: mirrored conflicts with
    // independent local ids.
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: ab });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: ab });
    await exportSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, toDir: ba });
    await importSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, fromDir: ba });

    const resolveB = createVersionedTextStore(b, { nowMs: () => 6000, createId: createIdFactory("br-") });
    try {
      const [conflict] = await resolveB.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      await resolveB.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api" },
      });
    } finally {
      await resolveB.close();
    }
    const checkA = createVersionedTextStore(a);
    let mirrorConflictId = "";
    try {
      const [mirror] = await checkA.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      mirrorConflictId = mirror!.id;
    } finally {
      await checkA.close();
    }
    const ba2 = await tempRoot("sync-m3-ba2");
    await exportSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, toDir: ba2 });
    const imported = await importSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, fromDir: ba2 });
    // B's resolve matched A's mirror conflict (by swapped heads): nothing
    // pending, and A's row is resolved with the choice mirrored — B applying
    // "incoming" (A's content) reads on A as keeping "current".
    expect(imported.pendingConflictResolves).toBe(0);
    const verifyA = createVersionedTextStore(a);
    try {
      const conflicts = await verifyA.listTextConflicts({ workspaceId: WORKSPACE_ID });
      const mirror = conflicts.find((conflict) => conflict.id === mirrorConflictId);
      expect(mirror).toMatchObject({
        status: "resolved",
        chosenFrom: "current",
        resolution: "kept-current",
      });
      // An unmatched resolve (unknown id, no head match) is applied but
      // surfaced, never silently acked away.
      const unmatched = await verifyA.applyReplicationOp({
        workspaceId: WORKSPACE_ID,
        originId: "origin_test_unmatched",
        originSeq: 0,
        opKind: "conflict.resolve",
        payload: {
          conflictId: "conflict_missing",
          status: "resolved",
          chosenFrom: "incoming",
          resolution: "applied-incoming",
          updatedAtMs: 9000,
          targetVersionId: "main",
          path: "docs/none.md",
          currentLatestMomentId: "moment_none_a",
          incomingLatestMomentId: "moment_none_b",
        },
        recordedAtMs: 9000,
      });
      expect(unmatched).toEqual({
        status: "applied",
        conflictsOpened: 0,
        pendingConflictResolves: 1,
        // Identity rides along (0P-C gate fix) so the desktop can lifecycle
        // its "needs a look" notice instead of accumulating a counter.
        pendingResolves: [
          { remoteConflictId: "conflict_missing", localConflictId: null, path: "docs/none.md" },
        ],
      });
    } finally {
      await verifyA.close();
    }
  });

  // 0P-C conflict round trip: resolving on one machine must SETTLE both
  // machines — mirror closed, contents equal, no residual identical-content
  // conflicts, and the next ordinary edit fast-forwards again.
  it("apply-incoming resolution round trip converges both machines and reconverges heads", async () => {
    const a = await tempRoot("sync-rt-a");
    const b = await tempRoot("sync-rt-b");
    const seedDir = await tempRoot("sync-rt-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-rt-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };

    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    await replicate(b, a);

    // A adopts B's copy.
    await withStore(a, 6000, "ar-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api" },
      });
    });
    const resolutionImport = await replicate(a, b);
    // The resolution WRITE lands on B — whose copy already matches — as a
    // content-convergent fast-forward, never a fresh identical-content
    // conflict; the conflict.resolve closes B's mirror by swapped heads.
    expect(resolutionImport.conflictsOpened).toBe(0);
    expect(resolutionImport.pendingConflictResolves).toBe(0);
    await withStore(b, 6500, "bc-", async (store) => {
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from B");
    });

    // Heads reconverged: the NEXT edit on A fast-forwards on B.
    await withStore(a, 8000, "a3-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "v2", metadata: { origin: "api" } }).then(() => {}),
    );
    const postResolve = await replicate(a, b);
    expect(postResolve.conflictsOpened).toBe(0);
    await withStore(b, 9000, "bf-", async (store) => {
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("v2");
    });
  });

  it("keep-current resolution applies its content consequence on the peer (no silent divergence)", async () => {
    const a = await tempRoot("sync-kc-a");
    const b = await tempRoot("sync-kc-b");
    const seedDir = await tempRoot("sync-kc-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-kc-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };

    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    await replicate(b, a);

    // A keeps ITS OWN copy. No write op is journaled on A — the mirrored
    // resolve must carry the content consequence to B by itself.
    await withStore(a, 6000, "ar-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      });
    });
    const resolutionImport = await replicate(a, b);
    expect(resolutionImport.pendingConflictResolves).toBe(0);
    await withStore(b, 6500, "bc-", async (store) => {
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      // B adopted the copy A chose — no silent forever-divergence.
      expect(text?.text).toBe("from A");
      const [resolved] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "resolved" });
      expect(resolved).toMatchObject({ status: "resolved", resolution: "applied-incoming" });
    });
    // B's adoption write replicates back: A converges heads with no conflict.
    const backImport = await replicate(b, a);
    expect(backImport.conflictsOpened).toBe(0);
    await withStore(a, 7000, "af-", async (store) => {
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from A");
    });
  });

  // 0P sync-hardening item 1: the same logical divergence must mint the SAME
  // conflict id on both machines, so a resolve on one closes the mirror on the
  // other BY ID (not the fragile swapped-head lookup).
  it("mints a deterministic, identical conflict id on both machines for one divergence (item 1)", async () => {
    const a = await tempRoot("sync-detid-a");
    const b = await tempRoot("sync-detid-b");
    const seedDir = await tempRoot("sync-detid-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-detid-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };
    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    // Both machines fork from the same base and edit the same path/object.
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    await replicate(b, a);

    let idOnA = "";
    let idOnB = "";
    await withStore(a, 4000, "ac-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      idOnA = conflict!.id;
    });
    await withStore(b, 4100, "bc-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      idOnB = conflict!.id;
    });
    // Machine-independent identity: same workspace + version + object + fork
    // point ⇒ byte-identical id, even though the two rows were minted
    // independently with current/incoming swapped.
    expect(idOnA).toBe(idOnB);
    expect(idOnA).toMatch(/^conflict_sync_/u);

    // A resolve on A closes B's mirror BY ID (the payload's conflictId matches
    // B's local row directly), and B adopts A's kept copy.
    await withStore(a, 5000, "ar-", async (store) => {
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: idOnA,
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      });
    });
    const resolveImport = await replicate(a, b);
    expect(resolveImport.pendingConflictResolves).toBe(0);
    await withStore(b, 5500, "bf-", async (store) => {
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const [resolved] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "resolved" });
      expect(resolved?.id).toBe(idOnA);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from A");
    });
  });

  // 0P sync-hardening item 2: many rapid divergent syncs on one path must NOT
  // stack duplicate conflicts — they coalesce onto one open row whose incoming
  // tracks the latest divergent head, resolvable exactly once.
  it("coalesces N rapid divergent syncs on one path into one resolvable conflict (item 2)", async () => {
    const a = await tempRoot("sync-coal-a");
    const b = await tempRoot("sync-coal-b");
    const seedDir = await tempRoot("sync-coal-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-coal-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };
    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    // B holds one divergent head; A extends its own side FIVE times, syncing
    // each new head to B as a separate rapid pass.
    await withStore(b, 1500, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    let openedTotal = 0;
    for (let index = 0; index < 5; index += 1) {
      await withStore(a, 2000 + index * 100, `a${index}-`, (store) =>
        store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: `from A v${index}`, metadata: { origin: "api" } }).then(() => {}),
      );
      const result = await replicate(a, b);
      openedTotal += result.conflictsOpened;
    }
    // Exactly one conflict is EVER opened across the five divergent syncs; the
    // rest coalesce onto it.
    expect(openedTotal).toBe(1);
    await withStore(b, 4000, "bc-", async (store) => {
      const open = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(open).toHaveLength(1);
      // Incoming tracks A's LATEST divergent head, not the first.
      expect(open[0]?.incoming.text).toBe("from A v4");
      expect(open[0]?.current.text).toBe("from B");
      // Resolvable exactly once — after resolving, no open conflict remains.
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: open[0]!.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api" },
      });
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from A v4");
    });
  });

  // 0P sync-hardening item 1 GATE FIX (N-way data loss). Three machines A/B/C
  // all fork the SAME object O from the SAME base moment M0 with different
  // edits. Before the fix, every pairwise divergence hashed to ONE id keyed
  // only on (workspace, version, object, baseMoment), so on A the C op
  // coalesced onto the A-vs-B row (dropping the "from B" branch) or a
  // resolve-by-id closed the wrong mirror. After the fix the id also folds in
  // the two branch roots, so A-vs-B and A-vs-C are DISTINCT rows and resolving
  // one leaves the other intact — no branch is silently dropped.
  it("keeps A-vs-B and A-vs-C distinct when three machines fork one object (item 1 N-way)", async () => {
    const a = await tempRoot("sync-nway-a");
    const b = await tempRoot("sync-nway-b");
    const c = await tempRoot("sync-nway-c");
    const seedDir = await tempRoot("sync-nway-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-nway-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };
    // Seed base on A, propagate the SAME object/base to B and C.
    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    await importSyncBundle({ rootDir: c, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    // Three independent forks of O from M0.
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(c, 4000, "c-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from C", metadata: { origin: "api" } }).then(() => {}),
    );
    // A imports B's fork, then C's fork: two SEPARATE pairwise conflicts.
    const importB = await replicate(b, a);
    const importC = await replicate(c, a);
    expect(importB.conflictsOpened).toBe(1);
    // The N-way data loss: before the fix this was 0 (C coalesced onto the
    // A-vs-B row, dropping the "from B" branch). After the fix it is a fresh row.
    expect(importC.conflictsOpened).toBe(1);

    let idAB = "";
    let idAC = "";
    await withStore(a, 5000, "ac-", async (store) => {
      const open = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(open).toHaveLength(2);
      const abRow = open.find((row) => row.incoming.text === "from B");
      const acRow = open.find((row) => row.incoming.text === "from C");
      expect(abRow).toBeDefined();
      expect(acRow).toBeDefined();
      expect(abRow!.current.text).toBe("from A");
      expect(acRow!.current.text).toBe("from A");
      // Two DIFFERENT pairwise conflicts on the SAME object get DIFFERENT ids.
      expect(abRow!.id).not.toBe(acRow!.id);
      idAB = abRow!.id;
      idAC = acRow!.id;
    });

    // Resolving A-vs-B must NOT close or corrupt A-vs-C: the "from C" branch
    // survives as its own actionable conflict.
    await withStore(a, 6000, "ar-", async (store) => {
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: idAB,
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      });
      const open = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(open).toHaveLength(1);
      expect(open[0]!.id).toBe(idAC);
      expect(open[0]!.incoming.text).toBe("from C");
      expect(open[0]!.current.text).toBe("from A");
    });
  });

  // 0P sync-hardening item 1: when ids genuinely cannot align (a resolve whose
  // conflictId has no local row), the swapped-head fallback still closes the
  // mirror — the ambiguous case the deterministic id does not cover.
  it("falls back to the swapped-head match when the resolve's id has no local row (item 1 fallback)", async () => {
    const a = await tempRoot("sync-fb-a");
    const b = await tempRoot("sync-fb-b");
    const seedDir = await tempRoot("sync-fb-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-fb-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };
    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    // B has an open conflict (current="from B", incoming="from A"). Hand it a
    // conflict.resolve whose conflictId is UNKNOWN locally but whose swapped
    // heads (current↔incoming) name B's open row — the fallback must find and
    // close it, adopting the peer's kept copy ("from A").
    await withStore(b, 4000, "bx-", async (store) => {
      const [open] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(open?.current.text).toBe("from B");
      const result = await store.applyReplicationOp({
        workspaceId: WORKSPACE_ID,
        originId: "origin_test_fallback",
        originSeq: 0,
        opKind: "conflict.resolve",
        payload: {
          // An id that exists on NO local row — forces the head-match fallback.
          conflictId: "conflict_sync_nonexistent_mirror_id",
          status: "resolved",
          chosenFrom: "current",
          resolution: "kept-current",
          updatedAtMs: 4000,
          targetVersionId: "main",
          path: "x.md",
          // The PEER's heads: its current is our incoming, its incoming is our
          // current — the swapped-head key the fallback matches on.
          currentLatestMomentId: open!.incoming.latestMomentId,
          incomingLatestMomentId: open!.current.latestMomentId,
        },
        recordedAtMs: 4000,
      });
      // Applied via the fallback, not surfaced as an unmatched pending resolve.
      expect(result).toEqual({ status: "applied", conflictsOpened: 0 });
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toEqual([]);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from A");
    });
  });

  it("a peer's resolution never clobbers a file that moved on locally — it surfaces for review", async () => {
    const a = await tempRoot("sync-mv-a");
    const b = await tempRoot("sync-mv-b");
    const seedDir = await tempRoot("sync-mv-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-mv-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };

    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    await replicate(b, a);

    // B keeps editing AFTER the mirror conflict opened: its heads move on.
    await withStore(b, 5000, "b2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B, newer", metadata: { origin: "api" } }).then(() => {}),
    );
    // A resolves keep-current ("from A"). B's mirror row heads no longer
    // match its live snapshot — applying would clobber the newer local edit.
    await withStore(a, 6000, "ar-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      });
    });
    const resolutionImport = await replicate(a, b);
    expect(resolutionImport.pendingConflictResolves).toBe(1);
    await withStore(b, 7000, "bc-", async (store) => {
      const open = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      // The conflict stays OPEN for local review; the newer local edit is
      // untouched.
      expect(open).toHaveLength(1);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from B, newer");
    });
  });

  // 0P-C gate fix (High): content equality is NOT convergence. Two machines
  // holding the SAME bytes at DIFFERENT paths (divergent renames) must keep
  // the mirror conflict open — auto-closing it would leave the machines
  // silently disagreeing about where the file lives, forever, with no open
  // conflict anywhere.
  it("same bytes at different paths never auto-close the mirrored conflict", async () => {
    const a = await tempRoot("sync-dp-a");
    const b = await tempRoot("sync-dp-b");
    const seedDir = await tempRoot("sync-dp-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-dp-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };

    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "same bytes", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    // Divergent renames: identical content, different destinations.
    await withStore(a, 2000, "a2-", (store) =>
      store.renameTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", fromPath: "x.md", toPath: "a.md", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.renameTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", fromPath: "x.md", toPath: "b.md", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    await replicate(b, a);
    // Each side holds one open divergent-move conflict.
    await withStore(b, 3500, "bck-", async (store) => {
      expect(await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" })).toHaveLength(1);
    });

    // A keeps ITS OWN destination (a.md). B's mirror reads that as
    // applied-incoming — but the incoming side lives at a DIFFERENT path, so
    // it must stay open for local review, never close as "already equal".
    await withStore(a, 6000, "ar-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      });
    });
    const resolutionImport = await replicate(a, b);
    expect(resolutionImport.pendingConflictResolves).toBe(1);
    await withStore(b, 7000, "bc-", async (store) => {
      const open = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      expect(open).toHaveLength(1);
      // B's copy is untouched at ITS path; nothing silently moved or closed.
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "b.md" });
      expect(text?.text).toBe("same bytes");
      expect(await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "a.md" })).toBeNull();
    });
  });

  // 0P-C gate fix (High): the mirrored-apply guard must compare EXACT live
  // state (head moment id, not just bytes). A file whose lineage moved on
  // after the conflict opened — even if its bytes were later reverted to the
  // recorded state — is newer local work and must never be overwritten.
  it("a moved-on-then-reverted-bytes file is never overwritten by a peer's resolution", async () => {
    const a = await tempRoot("sync-rb-a");
    const b = await tempRoot("sync-rb-b");
    const seedDir = await tempRoot("sync-rb-seed");
    const withStore = async (
      root: string,
      now: number,
      prefix: string,
      fn: (store: ReturnType<typeof createVersionedTextStore>) => Promise<void>,
    ) => {
      const store = createVersionedTextStore(root, { nowMs: () => now, createId: createIdFactory(prefix) });
      try {
        await fn(store);
      } finally {
        await store.close();
      }
    };
    const replicate = async (from: string, to: string) => {
      const bundle = await tempRoot("sync-rb-bundle");
      await exportSyncBundle({ rootDir: from, workspaceId: WORKSPACE_ID, toDir: bundle });
      return importSyncBundle({ rootDir: to, workspaceId: WORKSPACE_ID, fromDir: bundle });
    };

    await withStore(a, 1000, "a-", async (store) => {
      await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "base", metadata: { origin: "api" } });
    });
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: seedDir });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: seedDir });
    await withStore(a, 2000, "a2-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from A", metadata: { origin: "api" } }).then(() => {}),
    );
    await withStore(b, 3000, "b-", (store) =>
      store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } }).then(() => {}),
    );
    await replicate(a, b);
    await replicate(b, a);

    // B's lineage MOVES ON after the mirror conflict opened, then reverts to
    // the recorded bytes: the head moment id no longer matches the conflict
    // row even though the content does.
    await withStore(b, 5000, "b2-", async (store) => {
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B, interim", metadata: { origin: "api" } });
      await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md", text: "from B", metadata: { origin: "api" } });
    });
    // A keeps ITS copy ("from A"); the mirror on B would adopt it.
    await withStore(a, 6000, "ar-", async (store) => {
      const [conflict] = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      await store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: conflict!.id,
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      });
    });
    const resolutionImport = await replicate(a, b);
    expect(resolutionImport.pendingConflictResolves).toBe(1);
    await withStore(b, 7000, "bc-", async (store) => {
      const open = await store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" });
      // The conflict stays OPEN for local review; B's moved-on lineage keeps
      // its bytes — never clobbered by "content looked equal".
      expect(open).toHaveLength(1);
      const text = await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "x.md" });
      expect(text?.text).toBe("from B");
    });
  });

  it("replicates binary content_kind through version.create forks byte-exactly", async () => {
    const a = await tempRoot("sync-m1-a");
    const b = await tempRoot("sync-m1-b");
    const bundle = await tempRoot("sync-m1-bundle");
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
    const versions = createVersionedTextStore(a, { nowMs: () => 1000, createId: createIdFactory("a-") });
    let versionId = "";
    try {
      await versions.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await versions.writeBinaryFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "assets/logo.png",
        bytes,
        metadata: { origin: "api" },
      });
      versionId = (
        await versions.createNamedVersion({ workspaceId: WORKSPACE_ID, name: "BinFork", fromVersionId: "main" })
      ).id;
    } finally {
      await versions.close();
    }
    await exportSyncBundle({ rootDir: a, workspaceId: WORKSPACE_ID, toDir: bundle });
    await importSyncBundle({ rootDir: b, workspaceId: WORKSPACE_ID, fromDir: bundle });
    const check = createVersionedTextStore(b);
    try {
      const files = await check.listTextFiles({ workspaceId: WORKSPACE_ID, versionId });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: "assets/logo.png", contentKind: "binary" });
      const read = await check.readBinaryFile({ workspaceId: WORKSPACE_ID, versionId, path: "assets/logo.png" });
      expect(read && Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      await check.close();
    }
  });

  it("preserves conflicts and converges non-conflicted state under concurrent batch fuzz", async () => {
    const seed = 0x0f0a2026;
    const random = prng(seed);
    const a = await tempRoot("sync-fuzz-a");
    const b = await tempRoot("sync-fuzz-b");
    const nowA = { value: 10_000 };
    const nowB = { value: 20_000 };
    const paths = ["docs/fuzz-0.md", "docs/fuzz-1.md", "docs/fuzz-2.md", "docs/fuzz-3.md"];
    const secretPaths = [".env", "prod.env"];
    const setup = createVersionedTextStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("fs-"),
    });
    const setupChats = createLinkedChatStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("fsc-"),
    });
    let sharedThreadId = "";
    try {
      await setup.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      for (const [index, path] of paths.entries()) {
        await setup.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path,
          text: `seed ${index}\n`,
          metadata: { origin: "api" },
        });
      }
      const setupSecrets = createSecretFileStore(a, {
        nowMs: () => {
          nowA.value += 10;
          return nowA.value;
        },
        createId: createIdFactory("fss-"),
      });
      try {
        await setupSecrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: secretPaths[0]!,
          text: `seed secret ${seed}\n`,
          metadata: { origin: "local-file", summary: "fuzz seed secret" },
        });
      } finally {
        await setupSecrets.close();
      }
      const general = await setupChats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
      const started = await setupChats.startChannelThread({
        workspaceId: WORKSPACE_ID,
        channelId: general.id,
        title: "Fuzz thread",
        author: { kind: "agent", displayName: "Agent A" },
        body: "seed chat",
      });
      sharedThreadId = started.thread.id;
    } finally {
      await setupChats.close();
      await setup.close();
    }
    await syncBothWays(a, b, "sync-fuzz-seed");
    const seededKey = await readWorkspaceDataKeyForEnrollment(a, WORKSPACE_ID);
    if (!seededKey) throw new Error("expected seeded secret key");
    await installWorkspaceDataKey(b, seededKey);

    const aStore = createVersionedTextStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("fa-"),
    });
    const bStore = createVersionedTextStore(b, {
      nowMs: () => {
        nowB.value += 10;
        return nowB.value;
      },
      createId: createIdFactory("fb-"),
    });
    const aChats = createLinkedChatStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("fca-"),
    });
    const bChats = createLinkedChatStore(b, {
      nowMs: () => {
        nowB.value += 10;
        return nowB.value;
      },
      createId: createIdFactory("fcb-"),
    });
    const aSecrets = createSecretFileStore(a, {
      nowMs: () => {
        nowA.value += 10;
        return nowA.value;
      },
      createId: createIdFactory("fsa-"),
    });
    const bSecrets = createSecretFileStore(b, {
      nowMs: () => {
        nowB.value += 10;
        return nowB.value;
      },
      createId: createIdFactory("fsb-"),
    });

    // Binary snapshots read back with text "" — identity for them is the
    // content-addressed sha, so the comparator keys on kind + sha/text.
    const fileMapForVersion = async (store: typeof aStore, versionId: string) =>
      new Map(
        (await store.listTextFiles({ workspaceId: WORKSPACE_ID, versionId })).map(
          (file) =>
            [
              file.path,
              (file.contentKind ?? "text") === "binary" ? `bin:${file.sha256}` : `txt:${file.text}`,
            ] as const,
        ),
      );
    const fileMap = (store: typeof aStore) => fileMapForVersion(store, "main");
    // Conflicts mirror across peers with current/incoming SWAPPED, and a
    // divergent move records different paths per side (current at the local
    // path, incoming at the remote one). Keying by the SORTED pair of side
    // paths is therefore the symmetric identity: the same divergence (or
    // path-occupancy) produces the same key on both machines. Object ids stay
    // out of the key — per-op conflicts pair the remote op with whatever
    // object holds the path locally AT IMPORT TIME, so the object pairing is
    // legitimately side-local under create/delete races.
    type FuzzConflict = {
      targetVersionId: string;
      path: string;
      current: { path: string };
      incoming: { path: string };
    };
    const conflictKey = (conflict: FuzzConflict) =>
      `${conflict.targetVersionId}\0${[conflict.current.path, conflict.incoming.path]
        .sort()
        .join("\0")}`;
    const conflictCounts = (conflicts: FuzzConflict[]) => {
      const counts = new Map<string, number>();
      for (const conflict of conflicts) {
        const key = conflictKey(conflict);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };
    const chatDigest = async (chats: typeof aChats) => {
      const threads = await chats.listThreads({ workspaceId: WORKSPACE_ID });
      const rows: string[] = [];
      for (const thread of threads.sort((left, right) => left.id.localeCompare(right.id))) {
        const messages = await chats.listMessages({ workspaceId: WORKSPACE_ID, threadId: thread.id });
        for (const message of messages.sort(
          (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
        )) {
          rows.push(`${thread.id}\0${message.id}\0${message.createdAtMs}\0${message.author.kind}\0${message.author.displayName}\0${message.body}`);
        }
      }
      return rows;
    };
    const seqDigest = (root: string) =>
      replicationRows(root)
        .map((row) => `${row.origin_id}:${row.origin_seq}`)
        .sort();
    const secretCipherDigest = (root: string) => {
      const db = rawDb(root);
      try {
        return db
          .prepare(
            `SELECT path, iv_base64, auth_tag_base64, ciphertext_base64
             FROM secret_files
             WHERE workspace_id = ? AND version_id = 'main'
             ORDER BY path`,
          )
          .all(WORKSPACE_ID)
          .map(
            (row) =>
              `${row.path}\0${row.iv_base64}\0${row.auth_tag_base64}\0${row.ciphertext_base64}`,
          );
      } finally {
        db.close();
      }
    };
    const secretPlainDigest = async (secrets: typeof aSecrets) => {
      const rows = await secrets.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId: "main" });
      const out: string[] = [];
      for (const file of rows.sort((left, right) => left.path.localeCompare(right.path))) {
        const materialized = await secrets.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: file.path,
        });
        out.push(`${file.path}\0${materialized.present ? materialized.text : "<absent>"}`);
      }
      return out;
    };
    type FuzzPlan = {
      kind: "binary" | "chat" | "delete" | "rename" | "secret-write" | "write";
      path: string;
    };
    const applyBatch = async (
      store: typeof aStore,
      chats: typeof aChats,
      secrets: typeof aSecrets,
      side: "a" | "b",
      iteration: number,
      plans: FuzzPlan[],
    ) => {
      for (let opIndex = 0; opIndex < plans.length; opIndex += 1) {
        const plan = plans[opIndex]!;
        if (plan.kind === "chat") {
          await chats.sendMessage({
            workspaceId: WORKSPACE_ID,
            threadId: sharedThreadId,
            author: { kind: "agent", displayName: side === "a" ? "Agent A" : "Agent B" },
            body: `chat ${side} ${iteration}.${opIndex} seed ${seed}`,
          });
          continue;
        }
        if (plan.kind === "secret-write") {
          if ((iteration + opIndex) % 5 === 0) {
            await secrets.deleteSecretFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path: plan.path,
              metadata: { origin: "local-file", summary: `fuzz ${side} secret delete` },
            });
          } else {
            await secrets.writeSecretFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path: plan.path,
              text: `secret ${side} ${iteration}.${opIndex} seed ${seed}\n`,
              metadata: { origin: "local-file", summary: `fuzz ${side} secret write` },
            });
          }
          continue;
        }
        const files = await fileMap(store);
        const path = plan.path;
        if (plan.kind === "binary") {
          await store.writeBinaryFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path,
            bytes: Uint8Array.from([
              0x00,
              0xff,
              side === "a" ? 1 : 2,
              iteration & 0xff,
              opIndex & 0xff,
              0x7f,
            ]),
            metadata: { origin: "api", summary: `fuzz ${side} binary` },
          });
        } else if (plan.kind === "write" || !files.has(path)) {
          await store.writeTextFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path,
            text: `write ${side} ${iteration}.${opIndex} seed ${seed}\n`,
            metadata: { origin: "api", summary: `fuzz ${side} write` },
          });
        } else if (plan.kind === "delete") {
          await store.deleteTextFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path,
            metadata: { origin: "api", summary: `fuzz ${side} delete` },
          });
        } else {
          const target = paths.find((candidate) => candidate !== path && !files.has(candidate));
          if (target) {
            await store.renameTextFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              fromPath: path,
              toPath: target,
              metadata: { origin: "api", summary: `fuzz ${side} rename` },
            });
          } else {
            await store.writeTextFile({
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path,
              text: `rewrite ${side} ${iteration}.${opIndex} seed ${seed}\n`,
              metadata: { origin: "api", summary: `fuzz ${side} rewrite` },
            });
          }
        }
      }
    };

    try {
      for (let index = 0; index < 30; index += 1) {
        const collisionPath = paths[index % paths.length]!;
        const batchSize = 2 + Math.floor(random() * 4);
        const plans: FuzzPlan[] = Array.from({ length: batchSize }, (_, opIndex) => {
          if (opIndex > 0 && random() < 0.15) return { kind: "chat", path: collisionPath };
          if (opIndex > 0 && random() < 0.18) {
            return {
              kind: "secret-write",
              path: secretPaths[Math.floor(random() * secretPaths.length)]!,
            };
          }
          const roll = random();
          return {
            kind:
              opIndex === 0 || roll < 0.5
                ? "write"
                : roll < 0.62
                  ? "binary"
                  : roll < 0.8
                    ? "delete"
                    : "rename",
            path: random() < 0.72 ? collisionPath : paths[Math.floor(random() * paths.length)]!,
          };
        });
        try {
          await applyBatch(aStore, aChats, aSecrets, "a", index, plans);
          await applyBatch(bStore, bChats, bSecrets, "b", index, plans);
          // version-create divergence corpus: each side occasionally forks a
          // named version from main while the other side keeps editing main —
          // the replicated fork must converge on the ORIGIN's fork-point
          // state, never absorb the importer's edits.
          if (index % 7 === 3) {
            await aStore.createNamedVersion({
              workspaceId: WORKSPACE_ID,
              name: `Fuzz A ${index}`,
              fromVersionId: "main",
            });
          }
          if (index % 7 === 5) {
            await bStore.createNamedVersion({
              workspaceId: WORKSPACE_ID,
              name: `Fuzz B ${index}`,
              fromVersionId: "main",
            });
          }
          await syncBothWays(a, b, `sync-fuzz-${index}`);
          const [filesA, filesB] = await Promise.all([
            fileMap(aStore),
            fileMap(bStore),
          ]);
          const [conflictsA, conflictsB] = await Promise.all([
            aStore.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" }),
            bStore.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" }),
          ]);
          // A conflict shields BOTH of its side paths from the convergence
          // check: a divergent move legitimately leaves the two machines with
          // the object at different paths until a human resolves it.
          const conflictedPaths = new Set(
            [...conflictsA, ...conflictsB].flatMap((conflict) => [
              conflict.path,
              conflict.current.path,
              conflict.incoming.path,
            ]),
          );
          for (const path of new Set([...filesA.keys(), ...filesB.keys(), ...paths])) {
            if (conflictedPaths.has(path)) continue;
            expect(filesB.get(path) ?? null).toBe(filesA.get(path) ?? null);
          }
          expect([...conflictCounts(conflictsB)].sort()).toEqual([...conflictCounts(conflictsA)].sort());
          // Replicated named versions must be BYTE-IDENTICAL across peers:
          // fork state ships in the version.create payload, so no local edit
          // can leak into a peer's fork.
          const [versionsOnA, versionsOnB] = await Promise.all([
            aStore.listVersions({ workspaceId: WORKSPACE_ID }),
            bStore.listVersions({ workspaceId: WORKSPACE_ID }),
          ]);
          expect(versionsOnB.map((version) => version.id).sort()).toEqual(
            versionsOnA.map((version) => version.id).sort(),
          );
          for (const version of versionsOnA) {
            if (version.id === "main") continue;
            const [forkA, forkB] = await Promise.all([
              fileMapForVersion(aStore, version.id),
              fileMapForVersion(bStore, version.id),
            ]);
            expect([...forkB.entries()].sort()).toEqual([...forkA.entries()].sort());
          }
          // Coalescing (0P sync-hardening item 2) collapses a per-op divergence
          // to ONE row per (version, object): the incoming side tracks the
          // peer's LATEST divergent head while the current side stays this
          // machine's own head as first recorded (local writes advance the file
          // independently of the row). The strict per-op current/incoming
          // content mirror the non-coalesced model asserted here is therefore no
          // longer an invariant — a machine that keeps editing its own side
          // after the conflict opened legitimately holds a `current` that lags
          // its live head while the peer's `incoming` tracks that live head. The
          // surviving cross-machine guarantees are checked above (same conflict
          // KEY multiset, full non-conflicted-path convergence) and below (no
          // stacking), plus the resolve-by-id round trips in the dedicated
          // conflict tests.
          //
          // Item 2 guarantee, asserted directly: no machine ever stacks more
          // than one OPEN sync conflict for the same (version, object) lineage.
          // Each conflict is keyed by its PRIMARY (current-side) object — the
          // diverging object for a same-object conflict, the displaced occupant
          // for an occupancy conflict — which is what coalescing dedupes on.
          for (const conflicts of [conflictsA, conflictsB]) {
            const perLineage = new Map<string, number>();
            for (const conflict of conflicts) {
              if (conflict.metadata?.origin !== "sync") continue;
              const currentObjectId = conflict.current.objectId;
              if (typeof currentObjectId !== "string") continue;
              // Key by the (current, incoming) object PAIR so a same-object
              // divergence (O,O) and an occupancy conflict that merely displaces
              // O (O,Q) count as distinct lineages — both legitimate — while a
              // TRUE stack (two rows for the same divergence) is still caught.
              const lineageKey = `${conflict.targetVersionId}\0${currentObjectId}\0${conflict.incoming.objectId ?? "none"}`;
              perLineage.set(lineageKey, (perLineage.get(lineageKey) ?? 0) + 1);
            }
            for (const [, openCount] of perLineage) {
              expect(openCount).toBeLessThanOrEqual(1);
            }
          }
          await expect(chatDigest(bChats)).resolves.toEqual(await chatDigest(aChats));
          expect(seqDigest(b)).toEqual(seqDigest(a));
        } catch (error) {
          console.error(`sync fuzz seed=${seed} iteration=${index}`);
          throw error;
        }
      }
      expect(secretCipherDigest(b)).toEqual(secretCipherDigest(a));
      await expect(secretPlainDigest(bSecrets)).resolves.toEqual(await secretPlainDigest(aSecrets));
    } finally {
      await bSecrets.close();
      await aSecrets.close();
      await bChats.close();
      await aChats.close();
      await bStore.close();
      await aStore.close();
    }
  }, 60_000);
});
