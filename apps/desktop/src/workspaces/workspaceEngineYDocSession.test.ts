import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  createSecretFileStore,
  createVersionedTextStore,
  type SecretFileStore,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import { closeTrackedEngineDbHandlesForTest } from "@dohc/workspace-engine/testing";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  openEngineYDocProviderSession,
  type EngineYDocProviderSession,
} from "../collab/ydocEngineProviderSession";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";

// WS-G2-C-2: the capture's legacy-fixture Y.Doc session wiring and watcher
// coexistence. A live Y.Doc path's settle is journaled only as ydoc.update,
// never double-captured as a moment.append that would collide (P0D) on a
// shared workspace. A real store + real Yjs, no Electron. Production uses the
// Rust provider directly; this suite retains focused coverage of the retired
// provider while its remaining test callers migrate.

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
let root: string;
let store: VersionedTextStore;
let secretStore: SecretFileStore;
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
  root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-ydoc-session-"));
  roots.push(root);
  store = createVersionedTextStore(root);
  secretStore = createSecretFileStore(root);
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
  await secretStore.close().catch(() => undefined);
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function legacyProviderOptions(providerStore: VersionedTextStore) {
  return {
    store: providerStore,
    secretStore,
    rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    // Keep the retired provider executable as a test subject without leaving
    // a production import or engine-selection branch in the capture factory.
    openRustYDocProviderSession: async (options) =>
      await openEngineYDocProviderSession({
        store: providerStore,
        rootDir: root,
        workspaceId: WS,
        versionId: options.versionId,
        path: options.path,
        ...(options.contentKind ? { contentKind: options.contentKind } : {}),
        onRemoteUpdate: options.onRemoteUpdate,
        onSettled: options.onSettled as never,
        onSettleStart: options.onSettleStart,
        onSettleError: options.onSettleError,
      }) as never,
  } satisfies Pick<
    Parameters<typeof createWorkspaceEngineCapture>[0],
    "store" | "secretStore" | "rustEngineSessions" | "openRustYDocProviderSession"
  >;
}

function makeCapture() {
  // The capture and retired provider fixture must inspect the same persisted
  // state. Production's Rust Y.Doc provider does not use VersionedTextStore.
  return createWorkspaceEngineCapture({
    workspaceId: WS,
    rootPath: root,
    ...legacyProviderOptions(store),
  });
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

it("a settle past the 128 KiB CAPTURE cap keeps the engine record — the watcher must not retire our own write", async () => {
  // AUDIT-SILENTSAVE round 2 (codex P1). A Y.Doc is not bounded by
  // MAX_ENGINE_CAPTURE_TEXT_BYTES (128 KiB), but the capture reader is: a
  // settle that materializes a bigger file comes back `untracked-content`,
  // and that branch retired the path WITHOUT checking the expected-event
  // registry — deleting the document's engine record while the editor
  // reported "Saved". The dogfood journey's repro was 131,442 bytes, i.e.
  // exactly here.
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });

  // Past 128 KiB, like the journey.
  const huge = "Oversized settled paragraph for the capture cap.\n".repeat(3_000);
  expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(128 * 1024);
  const editor = mirrorEditor(session);
  typeIntoBody(editor, huge);
  await session.settleNow();

  const momentsAfterSettle = momentCountForPath(PATH);
  expect(momentsAfterSettle).toBeGreaterThan(0);
  const onDisk = await readFile(join(root, PATH), "utf8");
  expect(Buffer.byteLength(onDisk, "utf8")).toBeGreaterThan(128 * 1024);

  // The watcher now observes the settle's OWN oversized write.
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  // THE load-bearing assertion: the record survives. Before the fix this
  // path ran deleteIfTracked and the document vanished from the engine.
  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(projected).not.toBeNull();
  expect(projected?.text).toContain("Oversized settled paragraph for the capture cap.");
  // And it was not retired-then-recreated: no new moment was journaled for
  // our own write.
  expect(momentCountForPath(PATH)).toBe(momentsAfterSettle);

  await session.close();
  await capture.stop();
});

it("a settled over-cap doc SURVIVES an app restart — the startup reconcile must not retire it", async () => {
  // AUDIT-SILENTSAVE round 3. Guarding only the live watcher path was not
  // enough: the STARTUP RECONCILE retires by the same "not engine-ownable
  // text" rule, and it cannot use the expected-event registry at all — those
  // entries expire in seconds while reconcile runs at launch. Without an
  // ownership check the user pastes 131 KB, sees an honest "Saved" with the
  // bytes on disk, quits, reopens — and the engine record is gone, the
  // document silently demoted out of the engine editor, on every launch.
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const huge = "Oversized settled paragraph that must survive a restart.\n".repeat(3_500);
  expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(128 * 1024);
  const editor = mirrorEditor(session);
  typeIntoBody(editor, huge);
  await session.settleNow();
  await session.close();
  await capture.stop();

  const beforeRestart = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(beforeRestart?.text).toContain("Oversized settled paragraph");

  // THE RESTART: a brand-new capture over the same store + root, started
  // exactly as the app does at launch.
  const relaunched = createWorkspaceEngineCapture({
    workspaceId: WS,
    rootPath: root,
    ...legacyProviderOptions(store),
  });
  relaunched.start();
  await relaunched.flush();

  const afterRestart = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(
    afterRestart,
    "the startup reconcile retired the engine record for the over-cap Y.Doc",
  ).not.toBeNull();
  expect(afterRestart?.text).toContain("Oversized settled paragraph");
  // The file itself was never in danger — only the engine record.
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    "Oversized settled paragraph",
  );

  await relaunched.stop();
});

it("an EXTERNAL oversized write to a CLOSED Y.Doc-owned doc keeps the record too", async () => {
  // AUDIT-SILENTSAVE round 4 (D2). The watcher path deferred only to a LIVE
  // session while the startup reconcile defers to ownership, so the two
  // disagreed: a Y.Doc-owned doc that is not open, rewritten on disk by an
  // agent / sync client / git checkout / formatter, got retired on evidence
  // the reconcile would have kept. Agents writing files directly is a
  // first-class dohc flow, so ownership has to decide in both places.
  const capture = makeCapture();
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => {} });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Owned by the Y.Doc editor.");
  await session.settleNow();
  // CLOSED: no live session guards this path any more.
  await session.close();

  // Somebody else rewrites the file, past the capture text cap.
  await seedDiskFile(PATH, "x".repeat(140 * 1024));
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  const projected = await store.readTextFile({ workspaceId: WS, versionId, path: PATH });
  expect(
    projected,
    "an external oversized write retired a Y.Doc-owned record the reconcile would keep",
  ).not.toBeNull();

  await capture.stop();
});

it("a FAILING settle is logged and reported as an error save-state — the doc never reads Saved", async () => {
  // AUDIT-SILENTSAVE. This is the seam the bug lived in: a settle failure went
  // to onSessionError, which the capture wires to a reconnect handler that
  // returns early for anything that is not a reconnect error. The refusal was
  // dropped with no log and no UI, and the editor kept reading "Saved" while
  // the .md never received a byte. Three dogfood journeys watched exactly this.
  const refusal = new Error("engine refused the projection");
  const failingStore: VersionedTextStore = {
    ...store,
    writeProjectedTextFile: async () => {
      throw refusal;
    },
  };
  const logged: Array<{ context: string; error: unknown }> = [];
  const states: string[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: WS,
    rootPath: root,
    ...legacyProviderOptions(failingStore),
    onError: (context, error) => logged.push({ context, error }),
  });
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => {},
    onSaveState: (state) => states.push(state),
  });

  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed into a doc that cannot save.");
  await expect(session.settleNow()).rejects.toBe(refusal);

  // (a) The failure is LOGGED with the path and the underlying error.
  const entry = logged.find((item) => item.error === refusal);
  expect(entry).toBeDefined();
  expect(entry?.context).toContain(PATH);

  // (b) It reaches the UI as an error — and "saved" is never claimed.
  expect(states).toContain("settling");
  expect(states).toContain("error");
  expect(states).not.toContain("saved");

  // The file on disk really is behind: it still holds only the seeded text.
  const onDisk = await readFile(join(root, PATH), "utf8");
  expect(onDisk).not.toContain("Typed into a doc that cannot save.");

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop().catch(() => undefined);
});

it("refuses a secret-classified path (surfaced, not crashed) and never guards it", async () => {
  const capture = makeCapture();
  await expect(
    capture.openYDocSession({ path: ".env.local", onRemoteUpdate: () => {} }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await capture.stop();
});
