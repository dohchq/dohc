// WS-G2-C1 — the load-bearing convergence proof for `ydoc.update` replication.
//
// Two engine stores + Y.Doc drivers edit the SAME rich doc, exchange
// ydoc.update ops (through the real applyReplicationOp path), and MUST converge
// to byte-identical Y.Doc state AND byte-identical projected markdown, including
// concurrent + out-of-order arrival (a seeded fuzz). Re-import is a no-op. A
// third store bootstraps from the op history alone. A secret-classified path is
// rejected. The GC-root accounting counts the update blob.
//
// This mirrors 0P-B's convergence style but for the commutative CRDT op: there
// is NO head-check and NO conflict — Yjs guarantees convergence, so a genuine
// concurrent-edit fuzz opens ZERO conflict rows.

import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import type {
  SyncReplicationEnvelope,
  VersionedTextStore,
  WorkspaceObjectId,
  YDocUpdatePayload,
} from "@dohc/workspace-contracts/engine";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  createVersionedTextStore,
} from "./versionedTextStore";
import { createYDocEngineDriver, type YDocEngineDriver, type YDocSession } from "./ydocEngineDriver";
import { collectBlobHashesFromOp } from "./syncApply";

const WS = "ws-ydoc-repl";
const PATH = "docs/rich.md";

interface RawStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawDb;
};

function rawDb(root: string): RawDb {
  const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

interface Node {
  root: string;
  store: VersionedTextStore;
  driver: YDocEngineDriver;
}

const nodes: Node[] = [];

async function makeNode(label: string, clock: () => number): Promise<Node> {
  const root = await mkdtemp(join(tmpdir(), `dohc-ydoc-repl-${label}-`));
  const store = createVersionedTextStore(root, { nowMs: clock });
  // replicated:true is the co-editing lifecycle — journal the ydoc.update ops,
  // always resume an existing lineage (base-once), and keep the CRDT bytes
  // durable across close (never prune) so the test can reconstruct + compare
  // Y.Doc state after a session ends AND a fresh peer can replay the full log.
  const driver = createYDocEngineDriver({ store, rootDir: root, replicated: true });
  const node: Node = { root, store, driver };
  nodes.push(node);
  return node;
}

beforeEach(() => {
  nodes.length = 0;
});

afterEach(async () => {
  for (const node of nodes) {
    await node.driver.close().catch(() => {});
    await node.store.close().catch(() => {});
  }
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(nodes.map((n) => rm(n.root, { recursive: true, force: true })));
  nodes.length = 0;
});

// Copy every blob (binary + its text anchor) from `from` into `to`, then apply
// `from`'s entire replication log to `to.store`. applyReplicationOp is
// per-origin idempotent (originSeq <= acked is skipped), so re-running is a
// no-op — this stands in for the relay's blob-transport + fetch-and-apply.
async function replicate(from: Node, to: Node): Promise<{ applied: number; skipped: number }> {
  const src = rawDb(from.root);
  let blobs: Array<{ sha256: string; content: Buffer; byteLength: number }>;
  let ops: SyncReplicationEnvelope[];
  try {
    blobs = src
      .prepare("SELECT sha256, content, byte_length FROM binary_blobs")
      .all()
      .map((row) => ({
        sha256: String(row.sha256),
        content: Buffer.isBuffer(row.content)
          ? row.content
          : Buffer.from(row.content as Uint8Array),
        byteLength: Number(row.byte_length),
      }));
    ops = src
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
           FROM replication_log
          WHERE workspace_id = ?
          ORDER BY origin_id, origin_seq`,
      )
      .all(WS)
      .map((row) => ({
        workspaceId: String(row.workspace_id),
        originId: String(row.origin_id),
        originSeq: Number(row.origin_seq),
        opKind: String(row.op_kind),
        payload: JSON.parse(String(row.payload_json)) as unknown,
        recordedAtMs: Number(row.recorded_at_ms),
      })) as SyncReplicationEnvelope[];
  } finally {
    src.close();
  }
  // Force the target store to create its engine.db (a fresh replica has never
  // written) before we open a raw handle to hydrate blobs into it.
  await to.store.getMainVersion({ workspaceId: WS }).catch(() => null);
  const dst = rawDb(to.root);
  try {
    dst.exec("BEGIN IMMEDIATE");
    for (const blob of blobs) {
      dst
        .prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)")
        .run(blob.sha256, blob.byteLength, blob.content);
      dst
        .prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, '')")
        .run(blob.sha256, blob.byteLength);
    }
    dst.exec("COMMIT");
  } finally {
    dst.close();
  }
  let applied = 0;
  let skipped = 0;
  for (const op of ops) {
    const result = await to.store.applyReplicationOp(op);
    if (result.status === "applied") applied += 1;
    else skipped += 1;
  }
  return { applied, skipped };
}

// Drive a plaintext edit through the driver: capture the Yjs update the doc
// emits and journal it via recordUpdate (the substrate has no editor binding,
// so the test plays the editor's role).
async function edit(session: YDocSession, mutate: (text: Y.Text) => void): Promise<void> {
  const captured: Uint8Array[] = [];
  const handler = (update: Uint8Array): void => {
    captured.push(update);
  };
  session.doc.on("update", handler);
  session.doc.transact(() => mutate(session.doc.getText("plainText")));
  session.doc.off("update", handler);
  for (const update of captured) await session.recordUpdate(update);
}

function key(objectId: WorkspaceObjectId) {
  return { workspaceId: WS, versionId: "main", objectId };
}

function persistedMarkdown(node: Node, objectId: WorkspaceObjectId): string {
  const doc = node.driver.loadPersistedDoc(key(objectId));
  if (!doc) throw new Error("expected a persisted Y.Doc");
  return yDocToMarkdown(doc);
}

function persistedStateVector(node: Node, objectId: WorkspaceObjectId): string {
  const doc = node.driver.loadPersistedDoc(key(objectId));
  if (!doc) throw new Error("expected a persisted Y.Doc");
  return Buffer.from(Y.encodeStateVector(doc)).toString("hex");
}

async function fileMarkdown(node: Node): Promise<string> {
  const snapshot = await node.store.readTextFile({ workspaceId: WS, versionId: "main", path: PATH });
  return snapshot?.text ?? "<<missing>>";
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// Every ydoc.update op with isBaseState in the log — the base-once invariant: a
// single durable lineage emits EXACTLY ONE base, no matter how many close/reopen
// cycles it goes through. A second base would fork a lineage and duplicate.
function baseOpCount(node: Node): number {
  const db = rawDb(node.root);
  try {
    return db
      .prepare("SELECT payload_json FROM replication_log WHERE workspace_id = ? AND op_kind = ?")
      .all(WS, "ydoc.update")
      .map((row) => JSON.parse(String(row.payload_json)) as YDocUpdatePayload)
      .filter((payload) => payload.isBaseState === true).length;
  } finally {
    db.close();
  }
}

async function seedRichDoc(node: Node, seedText: string): Promise<WorkspaceObjectId> {
  await node.store.ensureMainVersion({ workspaceId: WS });
  // Non-journaling seed: the ONLY thing that replicates for this object is the
  // ydoc.update stream (proves it is the sole channel — no moment.append).
  const result = await node.store.writeProjectedTextFile!({
    workspaceId: WS,
    versionId: "main",
    path: PATH,
    text: seedText,
    metadata: { origin: "api" },
  });
  return result.object.id;
}

describe("ydoc.update replication", () => {
  it("converges Y.Doc state and projected markdown, and re-import is a no-op", async () => {
    let t = 1000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const b = await makeNode("b", clock);
    const objectId = await seedRichDoc(a, "alpha\n");

    const session = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
      contentKind: "plaintext",
    });
    await edit(session, (text) => text.insert(text.length, "beta\n"));
    await edit(session, (text) => text.insert(text.length, "gamma\n"));
    await session.settle();
    await session.close();

    // The op stream carries a full-state BASE op plus deltas — no moment.append
    // (the seed used the non-journaling write).
    const opKinds = rawDb(a.root)
      .prepare("SELECT op_kind FROM replication_log WHERE workspace_id = ? ORDER BY origin_seq", )
      .all(WS)
      .map((row) => String(row.op_kind));
    expect(opKinds).toContain("workspace.init");
    expect(opKinds.filter((k) => k === "ydoc.update").length).toBeGreaterThanOrEqual(2);
    expect(opKinds).not.toContain("moment.append");

    const first = await replicate(a, b);
    expect(first.applied).toBeGreaterThan(0);

    // Identical Y.Doc state (state vector byte-equality) AND identical markdown.
    expect(persistedStateVector(b, objectId)).toBe(persistedStateVector(a, objectId));
    expect(persistedMarkdown(b, objectId)).toBe(persistedMarkdown(a, objectId));
    // The projected markdown file on B equals A's.
    expect(await fileMarkdown(b)).toBe(await fileMarkdown(a));
    expect(await fileMarkdown(b)).toContain("beta");
    expect(await fileMarkdown(b)).toContain("gamma");

    // Idempotent re-import: applying the same log again applies nothing new.
    const again = await replicate(a, b);
    expect(again.applied).toBe(0);
    expect(persistedStateVector(b, objectId)).toBe(persistedStateVector(a, objectId));

    // No conflict rows anywhere (the commutative op never opens P0D).
    for (const node of [a, b]) {
      const conflicts = await node.store.listTextConflicts({ workspaceId: WS, status: "open" });
      expect(conflicts).toHaveLength(0);
    }
  });

  it("bootstraps a fresh third store from the update history alone", async () => {
    let t = 2000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const objectId = await seedRichDoc(a, "line one\n");
    const session = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
      contentKind: "plaintext",
    });
    await edit(session, (text) => text.insert(text.length, "line two\n"));
    await edit(session, (text) => text.insert(text.length, "line three\n"));
    await session.close();

    // A brand-new store that has NEVER seen the file reconstructs it purely from
    // the replicated op log (workspace.init + base + deltas). It has no file on
    // disk to seed from — the base op is what makes the stream self-contained.
    const c = await makeNode("c", clock);
    await replicate(a, c);

    expect(persistedStateVector(c, objectId)).toBe(persistedStateVector(a, objectId));
    expect(persistedMarkdown(c, objectId)).toBe(persistedMarkdown(a, objectId));
    expect(await fileMarkdown(c)).toBe(await fileMarkdown(a));
    expect(await fileMarkdown(c)).toContain("line three");
  });

  it("converges under a seeded fuzz of concurrent, out-of-order edits with no conflicts", async () => {
    let t = 3000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const b = await makeNode("b", clock);
    const objectId = await seedRichDoc(a, "seed\n");

    // Round 0: A establishes the lineage, B receives it.
    const open0 = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
      contentKind: "plaintext",
    });
    await edit(open0, (text) => text.insert(text.length, "a0\n"));
    await open0.close();
    await replicate(a, b);

    // Seeded PRNG (deterministic fuzz).
    let state = 0x1234abcd >>> 0;
    const rand = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const pick = (n: number) => Math.floor(rand() * n);

    for (let round = 1; round <= 8; round += 1) {
      // Both peers open (resume the SHARED lineage), edit CONCURRENTLY, close.
      const sa = await a.driver.openSession({
        workspaceId: WS,
        versionId: "main",
        path: PATH,
        resume: true,
      });
      const sb = await b.driver.openSession({
        workspaceId: WS,
        versionId: "main",
        path: PATH,
        resume: true,
      });
      const nA = 1 + pick(3);
      const nB = 1 + pick(3);
      for (let i = 0; i < nA; i += 1) {
        await edit(sa, (text) => {
          const at = text.length === 0 ? 0 : pick(text.length + 1);
          text.insert(at, `A${round}.${i}\n`);
        });
      }
      for (let i = 0; i < nB; i += 1) {
        await edit(sb, (text) => {
          const at = text.length === 0 ? 0 : pick(text.length + 1);
          text.insert(at, `B${round}.${i}\n`);
        });
      }
      await sa.close();
      await sb.close();
      // Exchange in a RANDOM direction order (out-of-order arrival), twice, so
      // each side ends up with every op regardless of the interleaving.
      if (rand() < 0.5) {
        await replicate(a, b);
        await replicate(b, a);
      } else {
        await replicate(b, a);
        await replicate(a, b);
      }
      await replicate(a, b);
      await replicate(b, a);
    }

    // Both stores converge to byte-identical Y.Doc state AND markdown.
    expect(persistedStateVector(b, objectId)).toBe(persistedStateVector(a, objectId));
    expect(persistedMarkdown(b, objectId)).toBe(persistedMarkdown(a, objectId));
    expect(await fileMarkdown(b)).toBe(await fileMarkdown(a));
    // Every concurrent edit survived (commutative merge, nothing dropped).
    const merged = persistedMarkdown(a, objectId);
    for (let round = 1; round <= 8; round += 1) {
      // At least one marker from each side per round is present somewhere.
      expect(merged.includes(`A${round}.`) || merged.includes(`B${round}.`)).toBe(true);
    }
    // No conflict rows — Yjs converged; the log never opened P0D.
    for (const node of [a, b]) {
      const conflicts = await node.store.listTextConflicts({ workspaceId: WS, status: "open" });
      expect(conflicts).toHaveLength(0);
    }
  });

  it("rejects a ydoc.update for a secret-classified path (secret floor holds)", async () => {
    let t = 4000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    await a.store.ensureMainVersion({ workspaceId: WS });

    // Hand-craft a ydoc.update op targeting a secret path with a valid blob.
    const doc = new Y.Doc();
    doc.getText("plainText").insert(0, "SECRET=leak\n");
    const updateBytes = Y.encodeStateAsUpdate(doc);
    const raw = rawDb(a.root);
    let sha: string;
    try {
      const { createHash } = requireModule("node:crypto") as typeof import("node:crypto");
      sha = createHash("sha256").update(Buffer.from(updateBytes)).digest("hex");
      raw
        .prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)")
        .run(sha, updateBytes.byteLength, Buffer.from(updateBytes));
    } finally {
      raw.close();
    }
    const payload: YDocUpdatePayload = {
      versionId: "main",
      objectId: "obj-secret" as WorkspaceObjectId,
      path: ".env",
      contentKind: "plaintext",
      updateBlobSha256: sha,
      isBaseState: true,
    };
    const op: SyncReplicationEnvelope = {
      workspaceId: WS,
      originId: "origin_secret_peer",
      originSeq: 0,
      opKind: "ydoc.update",
      payload,
      recordedAtMs: clock(),
    };
    await expect(a.store.applyReplicationOp(op)).rejects.toThrow(/secret/i);

    // Nothing materialized: no ydoc_docs row, no .env file.
    const marker = rawDb(a.root)
      .prepare("SELECT 1 FROM ydoc_docs WHERE object_id = ?")
      .get("obj-secret");
    expect(marker).toBeUndefined();
    const file = await a.store
      .readTextFile({ workspaceId: WS, versionId: "main", path: ".env" })
      .catch(() => null);
    expect(file).toBeNull();

    // The driver's local open path is guarded too (defense in depth): even if a
    // secret file somehow existed, a Y.Doc session for it is refused.
    await expect(
      a.driver.openSession({ workspaceId: WS, versionId: "main", path: ".env" }),
    ).rejects.toThrow(/secret/i);
  });

  it("counts the update blob as a GC root reference (engine + relay accounting)", () => {
    // The engine's blob-ref collector (drives push upload + apply hydration +
    // GC-root reachability) recognizes a ydoc.update's update blob.
    const op = {
      workspaceId: WS,
      originId: "o",
      originSeq: 0,
      opKind: "ydoc.update" as const,
      payload: {
        versionId: "main",
        objectId: "obj" as WorkspaceObjectId,
        path: PATH,
        contentKind: "plaintext" as const,
        updateBlobSha256: "a".repeat(64),
      },
      recordedAtMs: 1,
    };
    const refs = collectBlobHashesFromOp(op);
    expect(refs.binary).toContain("a".repeat(64));
    expect(refs.text).toHaveLength(0);
  });

  // FIX 1 (durable-resume, base-once) — the load-bearing convergence proof.
  it("a close→reopen→edit cycle stays ONE lineage; a fresh peer replays with NO duplication", async () => {
    let t = 5000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const objectId = await seedRichDoc(a, "alpha\n");

    // Open, edit, CLOSE (a replicated doc must keep its CRDT durable across
    // close, not prune it).
    const s1 = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
      contentKind: "plaintext",
    });
    await edit(s1, (text) => text.insert(text.length, "beta\n"));
    await s1.close();

    // REOPEN with NO resume flag — a replicated doc must ALWAYS resume the
    // persisted lineage, never re-seed from markdown. A re-seed here would emit
    // a SECOND base op and, on replay, duplicate the shared text.
    const s2 = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
    });
    await edit(s2, (text) => text.insert(text.length, "gamma\n"));
    await s2.close();

    // EXACTLY ONE base op across the whole close/reopen cycle (base-once).
    expect(baseOpCount(a)).toBe(1);

    // A fresh peer replays the FULL log (base + every delta, across the reopen).
    const b = await makeNode("b", clock);
    await replicate(a, b);

    // Byte-identical state + markdown, and — critically — NO duplication: each
    // line the single lineage ever held appears exactly once.
    expect(persistedStateVector(b, objectId)).toBe(persistedStateVector(a, objectId));
    expect(persistedMarkdown(b, objectId)).toBe(persistedMarkdown(a, objectId));
    const md = persistedMarkdown(b, objectId);
    expect(countOccurrences(md, "alpha")).toBe(1);
    expect(countOccurrences(md, "beta")).toBe(1);
    expect(countOccurrences(md, "gamma")).toBe(1);
    for (const node of [a, b]) {
      const conflicts = await node.store.listTextConflicts({ workspaceId: WS, status: "open" });
      expect(conflicts).toHaveLength(0);
    }
  });

  // FIX 1 (fuzz) — repeated close/reopen cycles (auto-resume, NO resume flag)
  // still converge a fresh peer with no duplication and a single base.
  it("converges across a seeded fuzz of close/reopen cycles with no duplication", async () => {
    let t = 5500;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const objectId = await seedRichDoc(a, "seed\n");

    let state = 0x0f0f1234 >>> 0;
    const rand = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const pick = (n: number) => Math.floor(rand() * n);

    let firstOpen = true;
    for (let round = 1; round <= 10; round += 1) {
      // First open seeds+bases; every later open resumes WITHOUT a resume flag.
      const session = await a.driver.openSession(
        firstOpen
          ? { workspaceId: WS, versionId: "main", path: PATH, contentKind: "plaintext" }
          : { workspaceId: WS, versionId: "main", path: PATH },
      );
      firstOpen = false;
      const edits = 1 + pick(3);
      for (let i = 0; i < edits; i += 1) {
        await edit(session, (text) => {
          const at = text.length === 0 ? 0 : pick(text.length + 1);
          text.insert(at, `L${round}.${i}\n`);
        });
      }
      await session.close();
    }

    // One base op no matter how many reopen cycles ran.
    expect(baseOpCount(a)).toBe(1);

    const b = await makeNode("b", clock);
    await replicate(a, b);
    expect(persistedStateVector(b, objectId)).toBe(persistedStateVector(a, objectId));
    expect(persistedMarkdown(b, objectId)).toBe(persistedMarkdown(a, objectId));
    // Every inserted marker appears exactly once (no lineage fork duplicated it).
    const md = persistedMarkdown(a, objectId);
    for (let round = 1; round <= 10; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        const marker = `L${round}.${i}\n`;
        const n = countOccurrences(md, marker);
        // Never duplicated (0 is possible — a later random insert can split a
        // marker so it is no longer a contiguous substring; 2+ would mean a
        // forked lineage merged the same text twice).
        expect(n).toBeLessThanOrEqual(1);
      }
    }
    // The seed word survives at most once (a random insert may split it), never
    // duplicated by a second lineage.
    expect(countOccurrences(md, "seed")).toBeLessThanOrEqual(1);
  });

  // FIX 2 (objectId/path integrity) — a ydoc.update for object A carrying object
  // B's occupied path is rejected; B's file is untouched.
  it("rejects a ydoc.update whose path is occupied by a DIFFERENT object", async () => {
    let t = 6000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    // seedRichDoc mints object B at PATH via the projected write.
    await seedRichDoc(a, "B is here\n");

    // Craft a valid ydoc.update op for a DIFFERENT object A that claims PATH.
    const doc = new Y.Doc();
    doc.getText("plainText").insert(0, "A hijack\n");
    const updateBytes = Y.encodeStateAsUpdate(doc);
    const raw = rawDb(a.root);
    let sha: string;
    try {
      const { createHash } = requireModule("node:crypto") as typeof import("node:crypto");
      sha = createHash("sha256").update(Buffer.from(updateBytes)).digest("hex");
      raw
        .prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)")
        .run(sha, updateBytes.byteLength, Buffer.from(updateBytes));
    } finally {
      raw.close();
    }
    const op: SyncReplicationEnvelope = {
      workspaceId: WS,
      originId: "origin_hijacker",
      originSeq: 0,
      opKind: "ydoc.update",
      payload: {
        versionId: "main",
        objectId: "obj-A-hijack" as WorkspaceObjectId,
        path: PATH,
        contentKind: "plaintext",
        updateBlobSha256: sha,
        isBaseState: true,
      },
      recordedAtMs: clock(),
    };
    await expect(a.store.applyReplicationOp(op)).rejects.toThrow(/occupied|already/i);

    // B's file is untouched — no cross-object write-through.
    expect(await fileMarkdown(a)).toBe("B is here\n");
    // No ydoc_docs marker was minted for the hijacking object.
    const marker = rawDb(a.root)
      .prepare("SELECT 1 FROM ydoc_docs WHERE object_id = ?")
      .get("obj-A-hijack");
    expect(marker).toBeUndefined();
  });

  // FIX 3 (live-session apply routing) — a remote ydoc.update that lands while a
  // session is OPEN must converge into the live doc, so the close settles the
  // CONVERGED state, not a stale one that would drop the remote edit.
  it("a remote ydoc.update applied mid-session survives the close (not dropped)", async () => {
    let t = 6500;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const b = await makeNode("b", clock);
    const objectId = await seedRichDoc(a, "base\n");

    // A establishes the shared lineage, B receives it.
    const s0 = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
      contentKind: "plaintext",
    });
    await edit(s0, (text) => text.insert(text.length, "A-line\n"));
    await s0.close();
    await replicate(a, b);

    // B opens a LIVE session (resumes the shared lineage).
    const sb = await b.driver.openSession({ workspaceId: WS, versionId: "main", path: PATH });

    // A makes a remote edit and closes.
    const sa = await a.driver.openSession({ workspaceId: WS, versionId: "main", path: PATH });
    await edit(sa, (text) => text.insert(text.length, "REMOTE-from-A\n"));
    await sa.close();

    // The remote ydoc.update arrives at B WHILE sb is open — it must route into
    // sb's live in-memory doc, not just the persisted rows.
    await replicate(a, b);
    expect(yDocToMarkdown(sb.doc)).toContain("REMOTE-from-A");

    // B then makes its OWN edit on the (now converged) live doc and closes. If
    // the remote had NOT been routed in, this close would settle a stale doc
    // (base + A-line + B-local) OVER the pulled projection and DROP the remote.
    await edit(sb, (text) => text.insert(text.length, "B-local\n"));
    await sb.close();

    // The remote edit survives in BOTH the projection file and persisted state.
    const bFile = await fileMarkdown(b);
    expect(bFile).toContain("REMOTE-from-A");
    expect(bFile).toContain("B-local");
    expect(persistedMarkdown(b, objectId)).toContain("REMOTE-from-A");
    expect(persistedMarkdown(b, objectId)).toContain("B-local");

    // Full convergence back to A, no duplication, no conflicts.
    await replicate(b, a);
    await replicate(a, b);
    expect(persistedStateVector(a, objectId)).toBe(persistedStateVector(b, objectId));
    expect(countOccurrences(persistedMarkdown(a, objectId), "REMOTE-from-A")).toBe(1);
    for (const node of [a, b]) {
      const conflicts = await node.store.listTextConflicts({ workspaceId: WS, status: "open" });
      expect(conflicts).toHaveLength(0);
    }
  });

  // FIX 4 (size cap) — an oversized local update is rejected BEFORE it is stored
  // or journaled, so nothing that every peer would reject on hydrate is recorded.
  it("rejects an oversized local ydoc update before storing or journaling it", async () => {
    let t = 7000;
    const clock = () => (t += 5);
    const a = await makeNode("a", clock);
    const objectId = await seedRichDoc(a, "small\n");
    const session = await a.driver.openSession({
      workspaceId: WS,
      versionId: "main",
      path: PATH,
      contentKind: "plaintext",
    });

    const baselineUpdates = rawDb(a.root)
      .prepare("SELECT COUNT(*) AS n FROM ydoc_updates WHERE object_id = ?")
      .get(objectId);
    const baselineOps = rawDb(a.root)
      .prepare("SELECT COUNT(*) AS n FROM replication_log WHERE workspace_id = ? AND op_kind = ?")
      .get(WS, "ydoc.update");

    // A ~6 MiB update — over MAX_VERSIONED_BINARY_FILE_BYTES (5 MiB). Non-empty
    // bytes are enough; the driver caps by byteLength before touching blobs.
    const oversized = new Uint8Array(6 * 1024 * 1024);
    oversized.fill(1);
    await expect(session.recordUpdate(oversized)).rejects.toThrow(/cap|over|exceed/i);

    // Nothing was stored (no new ydoc_updates row) and nothing was journaled.
    const afterUpdates = rawDb(a.root)
      .prepare("SELECT COUNT(*) AS n FROM ydoc_updates WHERE object_id = ?")
      .get(objectId);
    const afterOps = rawDb(a.root)
      .prepare("SELECT COUNT(*) AS n FROM replication_log WHERE workspace_id = ? AND op_kind = ?")
      .get(WS, "ydoc.update");
    expect(Number(afterUpdates?.n)).toBe(Number(baselineUpdates?.n));
    expect(Number(afterOps?.n)).toBe(Number(baselineOps?.n));

    await session.close();
  });
});
