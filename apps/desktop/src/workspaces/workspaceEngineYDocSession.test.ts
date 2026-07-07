import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  createVersionedTextStore,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import { closeTrackedEngineDbHandlesForTest } from "@dohc/workspace-engine/testing";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import type { EngineYDocProviderSession } from "../collab/ydocEngineProviderSession";
import { nativeTmpdir } from "./testTemp";

// WS-G2-C-2: the capture's engine Y.Doc session wiring — store sharing (one
// store / one write lane, no second engine.db connection) + watcher
// coexistence (a live ydoc path's settle is journaled ONLY as ydoc.update, never
// double-captured as a moment.append that would collide (P0D) on a shared
// workspace). A real store + real Yjs, no Electron.

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      all(...p: unknown[]): Array<Record<string, unknown>>;
      get(...p: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

const WS = "engine-ydoc-session-test";
const PATH = "notes/solo.md";
const roots: string[] = [];
const ORIGINAL_KERNEL_SIDECAR = process.env.DOHC_KERNEL_SIDECAR;
let root: string;
let store: VersionedTextStore;
let versionId: string;

function enginePath(): string {
  return join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH);
}

function readEngineDb<T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(enginePath(), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function replicationOpKindCounts(): Record<string, number> {
  return readEngineDb((db) => {
    const rows = db
      .prepare("SELECT op_kind AS opKind, COUNT(*) AS n FROM replication_log GROUP BY op_kind")
      .all() as Array<{ opKind: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.opKind] = Number(row.n);
    return counts;
  });
}

function ydocUpdateRowCount(): number {
  return readEngineDb((db) => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM ydoc_updates").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  });
}

function momentCountForPath(path: string): number {
  return readEngineDb((db) => {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM moments WHERE path = ?")
      .get(path) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  });
}

function mirrorEditor(session: EngineYDocProviderSession): Y.Doc {
  const doc = new Y.Doc();
  const REMOTE = Symbol("mirror-remote");
  Y.applyUpdate(doc, session.initialUpdate, REMOTE);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    session.applyLocalUpdate(update);
  });
  return doc;
}

function typeIntoBody(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const frag = doc.getXmlFragment("body");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    frag.insert(frag.length, [p]);
  });
}

async function seedDiskFile(path: string, contents: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

beforeEach(async () => {
  // No kernel sidecar in unit tests (matches workspaceEngineCapture.test.ts):
  // otherwise a reconcile scan spawns a real binary with a 30s timeout.
  process.env.DOHC_KERNEL_SIDECAR = "0";
  root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-ydoc-session-"));
  roots.push(root);
  store = createVersionedTextStore(root);
  const main = await store.ensureMainVersion({ workspaceId: WS });
  versionId = main.id;
  await store.writeTextFile({
    workspaceId: WS,
    versionId,
    path: PATH,
    text: "# Solo\n\nStart here.\n",
    metadata: { origin: "api" },
  });
  await seedDiskFile(PATH, "# Solo\n\nStart here.\n");
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  closeTrackedEngineDbHandlesForTest();
  if (ORIGINAL_KERNEL_SIDECAR === undefined) delete process.env.DOHC_KERNEL_SIDECAR;
  else process.env.DOHC_KERNEL_SIDECAR = ORIGINAL_KERNEL_SIDECAR;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function makeCapture() {
  // Inject THIS test's store: the capture must reuse this exact instance for the
  // ydoc session (single-writer safety). A second store on the same engine.db
  // would be a second write connection and node:sqlite would deadlock — if the
  // capture created its own store, the settle below would hang, not pass.
  return createWorkspaceEngineCapture({ workspaceId: WS, rootPath: root, store });
}

it("editing a live ydoc doc journals ONLY ydoc.update (no double moment.append, no P0D) and lands the .md", async () => {
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });

  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed with no collab server anywhere.");
  await session.settleNow();

  // The edit was journaled as a CRDT delta through the SHARED store.
  expect(ydocUpdateRowCount()).toBeGreaterThan(0);

  // The settle projected the edit into engine.db (the shared store's view).
  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(projected?.text).toContain("Typed with no collab server anywhere.");

  // The onSettled hook wrote the on-disk .md the user/agent sees.
  const onDisk = await readFile(join(root, PATH), "utf8");
  expect(onDisk).toContain("Typed with no collab server anywhere.");

  // Baseline: the ONLY moment.append is the beforeEach seed write of the file
  // (an ordinary text creation). The ydoc edit + settle above must not have
  // added another — the settle replicates solely as ydoc.update.
  const afterSettle = replicationOpKindCounts();
  expect(afterSettle["ydoc.update"] ?? 0).toBeGreaterThan(0);
  const baselineMomentAppend = afterSettle["moment.append"] ?? 0;
  expect(afterSettle["conflict.open"] ?? 0).toBe(0);

  // While the session is live, the watcher observes that same .md write. Drive
  // the watcher seam (captureBatch) for the live path and prove it is DEFERRED:
  // no NEW moment.append replication op, no conflict.open (P0D).
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  const counts = replicationOpKindCounts();
  // THE load-bearing assertion: the watcher's observation of the settle's own
  // .md write added ZERO moment.append ops (no double-journal, no P0D).
  expect(counts["moment.append"] ?? 0).toBe(baselineMomentAppend);
  expect(counts["conflict.open"] ?? 0).toBe(0);

  await session.close();
  await capture.stop();
});

it("captures a GENUINE external edit to a live doc — NOT silently dropped (gate fix 1)", async () => {
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Owner's live edit.");
  await session.settleNow();

  const momentsBefore = momentCountForPath(PATH);

  // An external editor/agent writes DIFFERENT content to the .md while the
  // session is live (a sha that matches NO settle self-write). The OLD blanket
  // live-path skip dropped every such event → the edit was lost and the next
  // settle overwrote it from the CRDT. It must now be captured normally.
  await seedDiskFile(PATH, "# Solo\n\nExternal agent wrote this line.\n");
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  // The external edit became a moment (content preserved in history) instead of
  // being silently dropped, and the projection reflects it.
  expect(momentCountForPath(PATH)).toBeGreaterThan(momentsBefore);
  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(projected?.text).toContain("External agent wrote this line.");

  await session.close();
  await capture.stop();
});

it("switchVersion settles + closes a live session BEFORE materializing (no stale projection, no two-lineage) (gate fix 2)", async () => {
  const capture = makeCapture();
  const mainId = versionId;
  const snapshot = await capture.createVersion("v2");
  const v2Id = snapshot.versions.find((v) => v.name === "v2")!.id;

  // Open on the now-active v2 and type WITHOUT a manual settle: the switch must
  // flush it (or the unsettled edit would be lost / a later settle would write a
  // stale projection into the version the session no longer owns).
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Live edit on v2 before switching.");

  await capture.switchVersion(mainId);

  // The unsettled edit was flushed into v2 (the version the session was on) by
  // the forced settle-on-close — not lost — and NOT written into Main after the
  // switch (Main keeps its own content).
  const v2Projected = await store.readTextFile({ workspaceId: WS, versionId: v2Id, path: PATH });
  expect(v2Projected?.text).toContain("Live edit on v2 before switching.");
  const mainProjected = await store.readTextFile({ workspaceId: WS, versionId: mainId, path: PATH });
  expect(mainProjected?.text ?? "").not.toContain("Live edit on v2 before switching.");

  // The session's reservation was released: reopening (now on Main) succeeds —
  // proof the switch closed it, not left two live docs / a leaked reservation.
  const reopened = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  await reopened.close();

  await session.close(); // idempotent — the switch already closed it
  await capture.stop();
});

it("shares one store instance: the ydoc session's edits are visible through the injected store", async () => {
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Through the shared store.");
  await session.settleNow();

  // Reading through the SAME injected store returns the settle projection with
  // no extra open — proving one store/one write lane served both the capture and
  // the driver (a second store would have deadlocked the settle above).
  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(projected?.text).toContain("Through the shared store.");

  await session.close();
  await capture.stop();
});

it("lifts the live-path guard on close so ordinary capture resumes for the path", async () => {
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Live edit.");
  await session.settleNow();
  await session.close();

  const momentsBefore = momentCountForPath(PATH);

  // After close the path is no longer ydoc-driven: an ORDINARY external edit is
  // captured normally again (proves the guard lifted, not a permanent skip).
  await seedDiskFile(PATH, "# Solo\n\nEdited on disk after close.\n");
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  expect(momentCountForPath(PATH)).toBeGreaterThan(momentsBefore);
  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(projected?.text).toContain("Edited on disk after close.");

  await capture.stop();
});

it("resumes the rich content on reopen (replicated lineage, no relay)", async () => {
  const capture = makeCapture();
  const first = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const editor = mirrorEditor(first);
  typeIntoBody(editor, "Persisted rich line.");
  await first.settleNow();
  await first.close();

  const second = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  await second.settleNow();
  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(projected?.text).toContain("Persisted rich line.");
  await second.close();
  await capture.stop();
});

it("refuses a secret-classified path (surfaced, not crashed) and never guards it", async () => {
  const capture = makeCapture();
  await expect(
    capture.openYDocSession({ path: ".env.local", onRemoteUpdate: () => {} }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await capture.stop();
});
