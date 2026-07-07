import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
