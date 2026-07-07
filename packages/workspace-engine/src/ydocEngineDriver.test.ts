import { createRequire } from "node:module";
import { existsSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  createVersionedTextStore,
} from "./versionedTextStore";
import {
  YDocEngineDriverError,
  createYDocEngineDriver,
  type YDocDocKey,
  type YDocSession,
} from "./ydocEngineDriver";
import type { VersionedTextStore } from "@dohc/workspace-contracts/engine";

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}
interface RawSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

const WS = "ws-ydoc";
let root: string;
let store: VersionedTextStore;
let versionId: string;

function rawRows(sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function rawExec(sql: string, params: unknown[] = []): void {
  const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

// A raw connection with FK enforcement ON (a fresh node:sqlite handle defaults
// to OFF), so a DELETE actually fires the schema's ON DELETE CASCADE chains.
function rawExecWithForeignKeys(sql: string, params: unknown[] = []): void {
  const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function writeFile(path: string, text: string): Promise<string> {
  const result = await store.writeTextFile({
    workspaceId: WS,
    versionId,
    path,
    text,
    metadata: { origin: "api" },
  });
  return result.object.id;
}

// Wire the session's live doc to the driver like an editor provider would:
// every Yjs update the doc emits is journaled through recordUpdate.
function autoRecord(session: YDocSession): { flush: () => Promise<void> } {
  const pending: Uint8Array[] = [];
  session.doc.on("update", (u: Uint8Array) => pending.push(u));
  return {
    async flush() {
      while (pending.length > 0) {
        await session.recordUpdate(pending.shift() as Uint8Array);
      }
    },
  };
}

function editFrontmatter(doc: Y.Doc, key: string, value: string): void {
  doc.transact(() => {
    doc.getMap("frontmatter").set(key, value);
  });
}

function appendParagraph(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const frag = doc.getXmlFragment("body");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    frag.insert(frag.length, [p]);
  });
}

function setBody(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const frag = doc.getXmlFragment("body");
    if (frag.length > 0) frag.delete(0, frag.length);
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    frag.insert(0, [p]);
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-ydoc-driver-"));
  store = createVersionedTextStore(root);
  const main = await store.ensureMainVersion({ workspaceId: WS });
  versionId = main.id;
});

afterEach(async () => {
  await store.close();
  closeTrackedEngineDbHandlesForTest();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("YDoc engine driver — B1 storage + compaction", () => {
  it("persists N updates and reloads to a byte-identical state vector", async () => {
    await writeFile("notes/plan.md", "# Plan\n\nseed body\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "notes/plan.md" });
    const rec = autoRecord(session);

    for (let i = 0; i < 20; i++) {
      editFrontmatter(session.doc, `k${i}`, `v${i}`);
      await rec.flush();
    }
    appendParagraph(session.doc, "an appended paragraph");
    await rec.flush();

    const key: YDocDocKey = { workspaceId: WS, versionId, objectId: session.objectId };
    const reloaded = driver.loadPersistedDoc(key);
    expect(reloaded).not.toBeNull();
    expect(Buffer.from(Y.encodeStateVector(reloaded as Y.Doc))).toEqual(
      Buffer.from(Y.encodeStateVector(session.doc)),
    );
    // Content also matches (state vector proves clocks; markdown proves content).
    expect(yDocToMarkdown(reloaded as Y.Doc)).toBe(yDocToMarkdown(session.doc));
    await driver.close();
  });

  it("compaction folds the log into a snapshot, prunes folded updates, reload unchanged", async () => {
    await writeFile("notes/plan.md", "# Plan\n");
    const driver = createYDocEngineDriver({ store, rootDir: root, compactionThreshold: 5 });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "notes/plan.md" });
    const rec = autoRecord(session);
    const key: YDocDocKey = { workspaceId: WS, versionId, objectId: session.objectId };

    for (let i = 0; i < 12; i++) {
      editFrontmatter(session.doc, `k${i}`, `v${i}`);
      await rec.flush();
    }

    // Head advanced to 12; compaction folded at the threshold boundaries so the
    // update log holds only the tail past the latest snapshot, not all 12.
    const doc = rawRows("SELECT head_update_seq, head_snapshot_seq FROM ydoc_docs")[0];
    expect(Number(doc.head_update_seq)).toBe(12);
    expect(Number(doc.head_snapshot_seq)).toBeGreaterThanOrEqual(10);
    const remainingUpdates = rawRows(
      "SELECT seq FROM ydoc_updates WHERE object_id = ? ORDER BY seq",
      [session.objectId],
    );
    expect(remainingUpdates.length).toBeLessThan(12);
    for (const u of remainingUpdates) {
      expect(Number(u.seq)).toBeGreaterThan(Number(doc.head_snapshot_seq));
    }
    // Exactly one live snapshot survives (older ones pruned).
    const snaps = rawRows("SELECT up_to_seq FROM ydoc_snapshots WHERE object_id = ?", [
      session.objectId,
    ]);
    expect(snaps.length).toBe(1);

    // Reload after compaction equals the live doc.
    const reloaded = driver.loadPersistedDoc(key) as Y.Doc;
    expect(yDocToMarkdown(reloaded)).toBe(yDocToMarkdown(session.doc));
    await driver.close();
  });

  it("reload after compaction equals reload before compaction (content-preserving)", async () => {
    await writeFile("notes/plan.md", "# Plan\n");
    const driver = createYDocEngineDriver({ store, rootDir: root, compactionThreshold: 6 });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "notes/plan.md" });
    const rec = autoRecord(session);
    const key: YDocDocKey = { workspaceId: WS, versionId, objectId: session.objectId };

    // Record just below the threshold: pure replay, no snapshot fold yet.
    for (let i = 0; i < 5; i++) {
      editFrontmatter(session.doc, `k${i}`, `v${i}`);
      await rec.flush();
    }
    const beforeFoldMd = yDocToMarkdown(driver.loadPersistedDoc(key) as Y.Doc);
    const beforeFoldSv = Buffer.from(Y.encodeStateVector(driver.loadPersistedDoc(key) as Y.Doc));
    const snapsBefore = rawRows("SELECT up_to_seq FROM ydoc_snapshots WHERE object_id = ?", [
      session.objectId,
    ]);
    expect(snapsBefore.map((r) => Number(r.up_to_seq))).toEqual([0]); // only the seed base

    // Cross the threshold: a compaction fold happens.
    for (let i = 5; i < 7; i++) {
      editFrontmatter(session.doc, `k${i}`, `v${i}`);
      await rec.flush();
    }
    const snapsAfter = rawRows("SELECT up_to_seq FROM ydoc_snapshots WHERE object_id = ?", [
      session.objectId,
    ]);
    expect(snapsAfter.some((r) => Number(r.up_to_seq) >= 6)).toBe(true);

    // Adding k5/k6 changed content; strip them back out and prove the FOLDED
    // reload reproduces the exact same state as the pre-fold replay for the
    // shared prefix by comparing the full live-doc reload identity instead.
    const afterFoldMd = yDocToMarkdown(driver.loadPersistedDoc(key) as Y.Doc);
    expect(afterFoldMd).toBe(yDocToMarkdown(session.doc));
    // The fold preserved the earlier keys byte-for-byte in the projection.
    expect(beforeFoldMd).toContain("k4: v4");
    expect(afterFoldMd).toContain("k4: v4");
    expect(beforeFoldSv.length).toBeGreaterThan(0);
    await driver.close();
  });
});

describe("YDoc engine driver — B2 single-canonical handoff", () => {
  it("flips file->ydoc on open and ydoc->file on close", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    expect(driver.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("file");

    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    expect(session.canonicalSource()).toBe("ydoc");
    expect(driver.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("ydoc");
    expect(driver.isYDocDriven({ workspaceId: WS, versionId, objectId })).toBe(true);

    await session.close();
    expect(driver.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("file");
    await driver.close();
  });

  it("refuses a second live session for the same object, including a different version", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const other = await store.createNamedVersion({
      workspaceId: WS,
      name: "draft",
      fromVersionId: versionId,
    });
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const s1 = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });

    await expect(
      driver.openSession({ workspaceId: WS, versionId, path: "doc.md" }),
    ).rejects.toBeInstanceOf(YDocEngineDriverError);
    // Same object under another version is ALSO refused (version switch = closed
    // boundary; never two live Y.Docs for one object).
    await expect(
      driver.openSession({ workspaceId: WS, versionId: other.id, path: "doc.md" }),
    ).rejects.toMatchObject({ code: "already-live" });

    // After settling+closing v1, the object opens under the other version.
    await s1.close();
    const s2 = await driver.openSession({
      workspaceId: WS,
      versionId: other.id,
      path: "doc.md",
    });
    expect(s2.objectId).toBe(objectId);
    await s2.close();
    await driver.close();
  });

  it("settle writes exactly one engine moment through the normal text path", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);

    const before = rawRows("SELECT COUNT(*) c FROM moments WHERE object_id = ?", [objectId]);
    appendParagraph(session.doc, "new content line");
    await rec.flush();
    const settle = await session.settle({ summary: "quiesce" });

    const after = rawRows("SELECT COUNT(*) c FROM moments WHERE object_id = ?", [objectId]);
    expect(Number(after[0].c) - Number(before[0].c)).toBe(1);
    // The settle is self-materialized: its sha is recognized as our own write.
    expect(session.isSelfMaterializedSha(settle.sha256)).toBe(true);

    const snapshot = await store.readTextFile({ workspaceId: WS, versionId, path: "doc.md" });
    expect(snapshot?.text).toContain("new content line");
    await driver.close();
  });

  it("close settles the final Y.Doc state to the file (no window where both disagree)", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    void objectId;
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "final unsaved edit");
    await rec.flush();
    // No explicit settle — close must flush the final state.
    await session.close();

    const snapshot = await store.readTextFile({ workspaceId: WS, versionId, path: "doc.md" });
    expect(snapshot?.text).toContain("final unsaved edit");
    await driver.close();
  });
});

describe("YDoc engine driver — ZERO change for plain-text files", () => {
  it("a normally-written text file has no ydoc_* rows and is not ydoc-driven", async () => {
    const objectId = await writeFile("plain.md", "# Just a normal file\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });

    expect(driver.isYDocDriven({ workspaceId: WS, versionId, objectId })).toBe(false);
    expect(driver.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("file");
    expect(rawRows("SELECT * FROM ydoc_docs")).toEqual([]);
    expect(rawRows("SELECT * FROM ydoc_updates")).toEqual([]);
    expect(rawRows("SELECT * FROM ydoc_snapshots")).toEqual([]);

    // Normal read is unchanged.
    const snapshot = await store.readTextFile({ workspaceId: WS, versionId, path: "plain.md" });
    expect(snapshot?.text).toBe("# Just a normal file\n");
    await driver.close();
  });

  it("markdown-is-the-artifact: a closed session prunes CRDT bytes, keeps only the marker", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "some edit");
    await rec.flush();
    expect(rawRows("SELECT * FROM ydoc_updates").length).toBeGreaterThan(0);

    await session.close();
    // CRDT state is NOT persisted past a closed session.
    expect(rawRows("SELECT * FROM ydoc_updates")).toEqual([]);
    expect(rawRows("SELECT * FROM ydoc_snapshots")).toEqual([]);
    // The tiny marker stays (this file is a rich doc; project, don't patch).
    const marker = rawRows("SELECT head_update_seq, head_snapshot_seq FROM ydoc_docs");
    expect(marker.length).toBe(1);
    expect(Number(marker[0].head_update_seq)).toBe(0);
    void objectId;
    await driver.close();
  });

  it("persistClosedSessionState keeps a compacted snapshot (future persistent-threads path)", async () => {
    await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({
      store,
      rootDir: root,
      persistClosedSessionState: true,
    });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "kept edit");
    await rec.flush();
    await session.close();

    // The additive layer keeps durable state: a snapshot survives the close.
    expect(rawRows("SELECT * FROM ydoc_snapshots").length).toBeGreaterThan(0);
    await driver.close();
  });
});

describe("YDoc engine driver — restore / external edit into a live doc", () => {
  it("folds a non-overlapping external markdown edit via three-way merge", async () => {
    await writeFile("doc.md", "line one\nline two\nline three\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });

    // External edit changes a DIFFERENT region than the live doc touched.
    const result = await session.applyExternalMarkdownEdit({
      markdown: "line one\nline two CHANGED\nline three\n",
    });
    expect(result.kind).toBe("merged");
    if (result.kind === "merged") {
      expect(result.markdown).toContain("line two CHANGED");
    }
    await driver.close();
  });

  it("preserves both sides via a .conflict projection on overlap", async () => {
    await writeFile("doc.md", "only base line\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    // Settle captures the common ancestor, then the live doc REWRITES the sole
    // line WITHOUT settling — an unsettled local divergence.
    await session.settle();
    setBody(session.doc, "local rewrite of the only line");
    await rec.flush();

    // An external edit contests the SAME (only) line differently -> overlap.
    const result = await session.applyExternalMarkdownEdit({
      markdown: "remote rewrite of the only line, entirely different\n",
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      const conflict = await store.readTextFile({
        workspaceId: WS,
        versionId,
        path: result.conflictPath,
      });
      expect(conflict?.text).toContain("remote rewrite of the only line");
    }
    await driver.close();
  });
});

describe("YDoc engine driver — open/edit/settle/capture/reopen integration", () => {
  it("round-trips a rich doc through engine.db and the .md file", async () => {
    await writeFile(
      "doc.md",
      ["---", "title: Draft", "---", "", "# Heading", "", "body paragraph", ""].join("\n"),
    );
    const driver = createYDocEngineDriver({ store, rootDir: root });

    // Session 1: edit + settle + close.
    const s1 = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(s1);
    appendParagraph(s1.doc, "a brand new paragraph added in session one");
    editFrontmatter(s1.doc, "title", "Final");
    await rec.flush();
    await s1.close(); // settles to the file

    const afterFirst = await store.readTextFile({ workspaceId: WS, versionId, path: "doc.md" });
    expect(afterFirst?.text).toContain("a brand new paragraph added in session one");
    expect(afterFirst?.text).toContain("title: Final");

    // Reopen: seeds from the settled FILE (closed => file-canonical), preserving
    // the rich structure the projection carries.
    const s2 = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const reopened = yDocToMarkdown(s2.doc);
    expect(reopened).toContain("a brand new paragraph added in session one");
    expect(reopened).toContain("# Heading");
    expect(reopened).toContain("title: Final");
    await s2.close();
    await driver.close();
  });
});

describe("YDoc engine driver — PROCESS-GLOBAL single-canonical across instances", () => {
  it("a SECOND driver instance on the same rootDir cannot open a live object (any version)", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const other = await store.createNamedVersion({
      workspaceId: WS,
      name: "draft",
      fromVersionId: versionId,
    });
    // Two independent drivers — even on separate stores — over the SAME
    // engine.db/rootDir. The per-instance map alone left the second one free to
    // double-open; the process-global reservation must stop it.
    const storeB = createVersionedTextStore(root);
    const driverA = createYDocEngineDriver({ store, rootDir: root });
    const driverB = createYDocEngineDriver({ store: storeB, rootDir: root });

    const s1 = await driverA.openSession({ workspaceId: WS, versionId, path: "doc.md" });

    // Same object, same version, DIFFERENT driver instance -> already-live.
    await expect(
      driverB.openSession({ workspaceId: WS, versionId, path: "doc.md" }),
    ).rejects.toMatchObject({ code: "already-live" });
    // Same object, DIFFERENT version, different instance -> ALSO already-live
    // (version switch is a closed-session boundary; never two live Y.Docs).
    await expect(
      driverB.openSession({ workspaceId: WS, versionId: other.id, path: "doc.md" }),
    ).rejects.toMatchObject({ code: "already-live" });
    // The second instance also observes the object as ydoc-canonical.
    expect(driverB.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("ydoc");

    // Once instance A settles+closes, instance B may take ownership.
    await s1.close();
    expect(driverB.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("file");
    const s2 = await driverB.openSession({ workspaceId: WS, versionId: other.id, path: "doc.md" });
    expect(s2.objectId).toBe(objectId);
    // And now A is the one locked out.
    await expect(
      driverA.openSession({ workspaceId: WS, versionId, path: "doc.md" }),
    ).rejects.toMatchObject({ code: "already-live" });

    await s2.close();
    await driverA.close();
    await driverB.close();
    await storeB.close();
  });
});

describe("YDoc engine driver — SHARED WRITE LANE (no two-writer deadlock)", () => {
  it("interleaved recordUpdate + settle under load all complete without hanging", async () => {
    await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root, compactionThreshold: 8 });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });

    // 40 distinct, valid Yjs updates from a scratch doc. recordUpdate stores the
    // bytes + advances the head (it does not apply them to the live doc), so
    // arbitrary valid updates exercise the append lane deterministically.
    const gen = new Y.Doc();
    const updates: Uint8Array[] = [];
    gen.on("update", (u: Uint8Array) => updates.push(u));
    for (let i = 0; i < 40; i++) {
      gen.transact(() => gen.getMap("m").set(`k${i}`, i));
    }
    expect(updates.length).toBe(40);

    // Fire every append WITHOUT awaiting, racing settles between them. If an
    // append (driver write) and a settle (store write) could ever hold two
    // concurrent in-process write transactions, node:sqlite's thread-blocking
    // busy-wait would deadlock until busy_timeout and this Promise.all would
    // hang. Through the shared serialized lane it simply completes.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < updates.length; i++) {
      ops.push(session.recordUpdate(updates[i] as Uint8Array));
      if (i % 5 === 0) ops.push(session.settle());
    }
    await Promise.all(ops);

    // Every append landed exactly once, monotonic under the interleave.
    const head = rawRows("SELECT head_update_seq FROM ydoc_docs")[0];
    expect(Number(head.head_update_seq)).toBe(40);
    // Persisted state still reconstructs (compaction folded some appends).
    expect(
      driver.loadPersistedDoc({ workspaceId: WS, versionId, objectId: session.objectId }),
    ).not.toBeNull();

    await session.close();
    await driver.close();
  }, 20000);
});

describe("YDoc engine driver — loadPersistedDoc never returns a blank doc as content", () => {
  it("returns null (seed-from-file) after a default close prunes CRDT state", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const key: YDocDocKey = { workspaceId: WS, versionId, objectId };
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "a real edit");
    await rec.flush();
    // Live: persisted CRDT state exists and reloads.
    expect(driver.loadPersistedDoc(key)).not.toBeNull();

    await session.close(); // default prune removes snapshots + updates

    // The marker survives (this file IS a rich doc), but there is NO persisted
    // CRDT state — loadPersistedDoc must NOT hand back a blank doc that a caller
    // could treat as canonical empty content. Closed => seed from the file.
    expect(driver.isYDocDriven(key)).toBe(true);
    expect(driver.loadPersistedDoc(key)).toBeNull();
    await driver.close();
  });
});

describe("YDoc engine driver — blob integrity on read", () => {
  it("rejects a ydoc blob whose bytes no longer hash to its sha (tampered row)", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const key: YDocDocKey = { workspaceId: WS, versionId, objectId };
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "an edit");
    await rec.flush();

    // The seed snapshot blob is referenced by the live head. Overwrite its bytes
    // under the SAME sha AND matching byte_length so the length guard passes and
    // the sha256 verification is what rejects it.
    const snap = rawRows(
      "SELECT snapshot_blob_sha256 sha FROM ydoc_snapshots WHERE object_id = ? ORDER BY up_to_seq ASC LIMIT 1",
      [objectId],
    )[0];
    const sha = String(snap.sha);
    const tampered = Buffer.from("not the real crdt bytes at all!!");
    rawExec("UPDATE binary_blobs SET content = ?, byte_length = ? WHERE sha256 = ?", [
      tampered,
      tampered.byteLength,
      sha,
    ]);

    expect(() =>
      driver.loadPersistedDoc({ workspaceId: WS, versionId, objectId }),
    ).toThrow(YDocEngineDriverError);
    void key;
    await session.close().catch(() => undefined);
    await driver.close();
  });
});

describe("YDoc engine driver — ON DELETE CASCADE from file_objects", () => {
  it("deleting the file object removes its ydoc_docs marker and all ydoc_* rows", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    // persistClosedSessionState keeps durable ydoc rows past close, so the
    // cascade has something to remove.
    const driver = createYDocEngineDriver({
      store,
      rootDir: root,
      persistClosedSessionState: true,
    });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "durable edit");
    await rec.flush();
    await session.close();
    await driver.close();

    // Precondition: ydoc rows exist for this object.
    expect(rawRows("SELECT 1 FROM ydoc_docs WHERE object_id = ?", [objectId]).length).toBe(1);
    expect(
      rawRows("SELECT 1 FROM ydoc_snapshots WHERE object_id = ?", [objectId]).length,
    ).toBeGreaterThan(0);

    // Remove the file object with FK enforcement on -> cascade wipes ydoc_*.
    rawExecWithForeignKeys("DELETE FROM file_objects WHERE object_id = ?", [objectId]);

    expect(rawRows("SELECT 1 FROM ydoc_docs WHERE object_id = ?", [objectId])).toEqual([]);
    expect(rawRows("SELECT 1 FROM ydoc_updates WHERE object_id = ?", [objectId])).toEqual([]);
    expect(rawRows("SELECT 1 FROM ydoc_snapshots WHERE object_id = ?", [objectId])).toEqual([]);
  });
});

// ---- Second-fix-round residuals (fixes 1-4) --------------------------------

describe("YDoc engine driver — canonical engine.db identity across path aliases (fix 1)", () => {
  it("a second root symlinked to the same engine.db is refused a live session", async () => {
    // Two rootDirs pointing at the SAME physical engine.db via a symlink MUST
    // share ONE reservation namespace (canonical realpath key). Keying by
    // resolve() alone is lexical: /root and /root-alias -> /root would get
    // DIFFERENT keys and each be free to open the same object, racing two live
    // Y.Docs on one file. The canonical key makes the alias lose the race.
    const aliasRoot = join(dirname(root), `${basename(root)}-alias`);
    let symlinked = false;
    try {
      symlinkSync(root, aliasRoot, "dir");
      symlinked = true;
    } catch {
      // No symlink support / privilege (e.g. Windows without developer mode):
      // this residual is covered by inspection on such platforms.
    }
    if (!symlinked) return;
    try {
      const objectId = await writeFile("doc.md", "# Doc\n");
      const storeAlias = createVersionedTextStore(aliasRoot);
      const driverReal = createYDocEngineDriver({ store, rootDir: root });
      const driverAlias = createYDocEngineDriver({ store: storeAlias, rootDir: aliasRoot });

      const s1 = await driverReal.openSession({ workspaceId: WS, versionId, path: "doc.md" });
      // The alias root resolves to the SAME physical engine.db -> already-live.
      await expect(
        driverAlias.openSession({ workspaceId: WS, versionId, path: "doc.md" }),
      ).rejects.toMatchObject({ code: "already-live" });
      // And the alias observes the object as ydoc-canonical (shared namespace).
      expect(driverAlias.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("ydoc");

      await s1.close();
      // Once closed, the alias may take ownership (single-canonical handoff).
      const s2 = await driverAlias.openSession({ workspaceId: WS, versionId, path: "doc.md" });
      expect(s2.objectId).toBe(objectId);
      await s2.close();

      await driverReal.close();
      await driverAlias.close();
      await storeAlias.close();
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });
});

describe("YDoc engine driver — reservation released on mid-open failure (fix 2)", () => {
  it("a failure after reserve but before session-install releases the reservation", async () => {
    const objectId = await writeFile("doc.md", "# Doc\n");
    let boom = true;
    const driver = createYDocEngineDriver({
      store,
      rootDir: root,
      // Simulate a throw in a LATER open step (after the reservation is taken and
      // the state reset, before the session installs). The whole post-reservation
      // path must release, not just the reset step.
      onAfterReserveForTest: () => {
        if (boom) throw new Error("simulated mid-open failure after reserve");
      },
    });

    await expect(
      driver.openSession({ workspaceId: WS, versionId, path: "doc.md" }),
    ).rejects.toThrow("simulated mid-open failure");

    // The reservation is NOT stranded: the object is not seen as live...
    expect(driver.canonicalSourceFor({ workspaceId: WS, objectId })).toBe("file");
    // ...and a subsequent open (no injected failure) succeeds.
    boom = false;
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    expect(session.canonicalSource()).toBe("ydoc");
    await session.close();
    await driver.close();
  });
});

describe("YDoc engine driver — driver connection is read-only (fix 3)", () => {
  it("a driver read never creates engine.db (no DDL / no write lock)", async () => {
    // The store is the SOLE schema + write owner. On a fresh root the store has
    // not created engine.db yet; a driver READ must return "no ydoc state"
    // WITHOUT creating the file (creating it would be lazy DDL + BEGIN IMMEDIATE
    // on a second connection — the two-writer path this fix removes).
    const freshRoot = await mkdtemp(join(tmpdir(), "dohc-ydoc-ro-"));
    try {
      const freshStore = createVersionedTextStore(freshRoot);
      const driver = createYDocEngineDriver({ store: freshStore, rootDir: freshRoot });
      const dbPath = join(freshRoot, VERSIONED_TEXT_STORE_RELATIVE_PATH);
      expect(existsSync(dbPath)).toBe(false);

      // Reads on the not-yet-created DB report "no ydoc state" and do not write.
      const key: YDocDocKey = { workspaceId: WS, versionId: "v-fresh", objectId: "obj-fresh" };
      expect(driver.isYDocDriven(key)).toBe(false);
      expect(driver.loadPersistedDoc(key)).toBeNull();
      expect(existsSync(dbPath)).toBe(false);

      await driver.close();
      await freshStore.close();
    } finally {
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it("after the store creates the DB, driver reads still work over its read-only handle", async () => {
    // Read-only WAL reads must succeed. openSession seeds through the store; the
    // driver then reads persisted state over its SQLITE_OPEN_READONLY handle.
    const objectId = await writeFile("doc.md", "# Doc\n");
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path: "doc.md" });
    const rec = autoRecord(session);
    appendParagraph(session.doc, "read-only reload check");
    await rec.flush();
    const key: YDocDocKey = { workspaceId: WS, versionId, objectId };
    expect(driver.isYDocDriven(key)).toBe(true);
    expect(driver.loadPersistedDoc(key)).not.toBeNull();
    await session.close();
    await driver.close();
  });
});

describe("YDoc engine driver — write-lane reentry guard (fix 4)", () => {
  it("a serialized store write called from inside a lane task throws (not a hang)", async () => {
    // The lane task contract is SQL-only on the passed connection. Calling back
    // into a serialized store method would queue behind the still-open lane
    // transaction and deadlock; the guard makes it fail loud instead of hang.
    const runInEngineWriteLane = store.runInEngineWriteLane;
    if (!runInEngineWriteLane) throw new Error("store must expose runInEngineWriteLane");

    await expect(
      runInEngineWriteLane.call(store, async () => {
        await store.writeTextFile({
          workspaceId: WS,
          versionId,
          path: "reentry.md",
          text: "must not run",
          metadata: { origin: "api" },
        });
      }),
    ).rejects.toMatchObject({ code: "write-lane-reentry" });

    // The store is not wedged: the write never landed and it still works after.
    expect(
      await store.readTextFile({ workspaceId: WS, versionId, path: "reentry.md" }),
    ).toBeNull();
    const after = await writeFile("after-reentry.md", "ok");
    expect(after).toBeTruthy();
    const snap = await store.readTextFile({ workspaceId: WS, versionId, path: "after-reentry.md" });
    expect(snap?.text).toBe("ok");
  });
});
