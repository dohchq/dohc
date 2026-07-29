import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  REMOTE_YDOC_APPLY_ORIGIN,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  createVersionedTextStore,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import {
  openEngineYDocProviderSession,
  type EngineYDocProviderSession,
} from "./ydocEngineProviderSession";

// A real engine store on a temp dir + real Yjs: proves the provider's
// bind / observe / skip-reserved-origin / settle / close contract end to end,
// with no Electron and no network (the solo-on-engine proof).

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { get(...p: unknown[]): Record<string, unknown> | undefined };
    close(): void;
  };
};

const WS = "ws-provider";
let root: string;
let store: VersionedTextStore;
let versionId: string;

function ydocUpdateRowCount(): number {
  const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM ydoc_updates")
      .get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

// A renderer-side mirror doc: apply the initial state, then bridge every LOCAL
// editor update into the provider (like the IPC layer would). This is exactly
// the two-doc bridge the real provider runs over IPC.
function mirrorEditor(session: EngineYDocProviderSession): Y.Doc {
  const doc = new Y.Doc();
  const REMOTE = Symbol("mirror-remote");
  Y.applyUpdate(doc, session.initialUpdate, REMOTE);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return; // never echo an engine-sourced update back
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

async function projection(): Promise<string> {
  const snapshot = await store.readTextFile({
    workspaceId: WS,
    versionId,
    path: "notes/solo.md",
  });
  return snapshot?.text ?? "";
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-ydoc-provider-"));
  store = createVersionedTextStore(root);
  const main = await store.ensureMainVersion({ workspaceId: WS });
  versionId = main.id;
  await store.writeTextFile({
    workspaceId: WS,
    versionId,
    path: "notes/solo.md",
    text: "# Solo\n\nStart here.\n",
    metadata: { origin: "api" },
  });
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
});

async function open(
  overrides?: Partial<Parameters<typeof openEngineYDocProviderSession>[0]>,
): Promise<{
  session: EngineYDocProviderSession;
  remoteForwards: Uint8Array[];
  settled: string[];
}> {
  const remoteForwards: Uint8Array[] = [];
  const settled: string[] = [];
  const session = await openEngineYDocProviderSession({
    store,
    rootDir: root,
    workspaceId: WS,
    versionId,
    path: "notes/solo.md",
    onRemoteUpdate: (u) => remoteForwards.push(u),
    onSettled: (r) => {
      settled.push(r.markdown ?? "");
    },
    // Deterministic settle: fire synchronously so tests never wait wall-clock.
    scheduleSettle: (fn) => {
      fn();
      return () => undefined;
    },
    ...overrides,
  });
  return { session, remoteForwards, settled };
}

describe("engine Y.Doc provider session — contract heart", () => {
  it("solo: a local editor edit journals through recordUpdate and settles to the projection", async () => {
    const before = ydocUpdateRowCount();
    const { session, settled } = await open();
    const editor = mirrorEditor(session);

    typeIntoBody(editor, "Typed with no collab server anywhere.");
    await session.settleNow();

    // The edit was journaled as a CRDT delta (recordUpdate ran).
    expect(ydocUpdateRowCount()).toBeGreaterThan(before);
    // The settle projected the edit into engine.db AND handed markdown out for
    // the disk write.
    const projected = await store.readTextFile({
      workspaceId: WS,
      versionId,
      path: "notes/solo.md",
    });
    expect(projected?.text).toContain("Typed with no collab server anywhere.");
    expect(settled.at(-1)).toContain("Typed with no collab server anywhere.");

    await session.close();
  });

  it("skips a REMOTE_YDOC_APPLY_ORIGIN update: forwards to the editor but never re-journals (contract b, no echo storm)", async () => {
    const { session, remoteForwards } = await open();
    const rowsAfterOpen = ydocUpdateRowCount();

    // Build a remote co-editor's delta from a peer synced to the same state.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, session.initialUpdate);
    const before = Y.encodeStateVector(session.doc);
    typeIntoBody(peer, "Remote co-editor line.");
    const remoteDelta = Y.encodeStateAsUpdate(peer, before);

    // Route it into the LIVE session doc under the reserved origin — exactly
    // what the store's applyReplicationOp does via liveYDocRegistry.
    Y.applyUpdate(session.doc, remoteDelta, REMOTE_YDOC_APPLY_ORIGIN);

    // Forwarded to the editor so a co-editor's change appears live...
    expect(remoteForwards.length).toBeGreaterThan(0);
    // ...but NOT re-journaled (contract b): no new ydoc_updates row.
    expect(ydocUpdateRowCount()).toBe(rowsAfterOpen);
    // The remote content DID converge into the live doc (settle projects it),
    // proving the skip is only about journaling, not about dropping the edit.
    await session.settleNow();
    expect(await projection()).toContain("Remote co-editor line.");

    await session.close();
  });

  it("solo round-trip: edit → close → reopen resumes the rich content through the engine (no relay)", async () => {
    const first = await open();
    const editor = mirrorEditor(first.session);
    typeIntoBody(editor, "Persisted rich line.");
    await first.session.settleNow();
    await first.session.close();

    // Reopen the SAME object: a replicated doc always resumes its lineage, so a
    // fresh mirror bound to the resumed state carries the earlier edit, and a
    // settle re-projects it.
    const second = await open();
    await second.session.settleNow();
    expect(await projection()).toContain("Persisted rich line.");
    await second.session.close();
  });

  it("single-canonical: close releases the reservation so the object reopens (version-switch handoff)", async () => {
    const a = await open();
    // A second open of the same live object is refused (already-live).
    await expect(open()).rejects.toMatchObject({ code: "already-live" });
    await a.session.close();
    // After close the reservation is released — reopen succeeds.
    const b = await open();
    expect(b.session.path).toBe("notes/solo.md");
    await b.session.close();
  });

  it("external markdown edit on a replicated doc is handled gracefully (contract c: no crash)", async () => {
    const { session } = await open();
    const result = await session.applyExternalMarkdownEdit(
      "# Solo\n\nAn agent rewrote this.\n",
    );
    expect(result.supported).toBe(false);
    // The session is still alive and usable after the graceful refusal.
    const editor = mirrorEditor(session);
    typeIntoBody(editor, "Still editable after external edit.");
    const settle = await session.settleNow();
    expect(settle.markdown).toContain("Still editable after external edit.");
    await session.close();
  });

  it("a close whose settle throws is retryable: the reservation stays held until a retry succeeds (gate fix 5)", async () => {
    // A store whose projection write (the settle) fails on demand. The driver's
    // session.close settles by default, so this forces close() to reject.
    let failProjection = true;
    const proxy = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "writeProjectedTextFile") {
          return async (...args: unknown[]) => {
            if (failProjection) throw new Error("disk full during settle");
            return (
              target as unknown as {
                writeProjectedTextFile: (...a: unknown[]) => unknown;
              }
            ).writeProjectedTextFile(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as VersionedTextStore;

    const { session } = await open({ store: proxy });
    const editor = mirrorEditor(session);
    typeIntoBody(editor, "Edit that must survive a failed close.");

    // Close settles by default → the projection write throws → close REJECTS and
    // does NOT complete teardown. The error is surfaced, never swallowed.
    await expect(session.close()).rejects.toThrow("disk full during settle");

    // Proof the single-canonical reservation is STILL held (not stranded as
    // released): a fresh open of the same object is refused as already-live.
    await expect(open({ store: proxy })).rejects.toMatchObject({ code: "already-live" });

    // Clear the fault and RETRY the close: it now completes teardown and
    // releases the reservation, so the object reopens cleanly.
    failProjection = false;
    await session.close();
    const reopened = await open();
    expect(reopened.session.path).toBe("notes/solo.md");
    await reopened.session.close();
  });

  it("refuses to open a secret-classified path (surfaced, not crashed)", async () => {
    await expect(open({ path: ".env.local" })).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("announces a settle at the JOURNAL BARRIER, not when it finally runs", async () => {
    // Round 3 (D5), the IN-PROCESS half. The daemon provider was fixed first
    // and this one was left behind, so the over-claim window survived here:
    // onSettleStart fired inside settleChain.then, meaning a settle queued
    // behind an in-flight one announced itself only after the first finished
    // — by which point a caller's edit counter had moved past what this
    // settle actually carries.
    const events: string[] = [];
    // Hold the FIRST projection write open so the second settle is genuinely
    // queued behind an in-flight one — the only situation the two placements
    // differ in.
    let releaseFirstProjection!: () => void;
    const firstProjectionGate = new Promise<void>((resolve) => {
      releaseFirstProjection = resolve;
    });
    let projections = 0;
    const gated = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "writeProjectedTextFile") {
          return async (...args: unknown[]) => {
            projections += 1;
            if (projections === 1) await firstProjectionGate;
            return (
              target as unknown as {
                writeProjectedTextFile: (...a: unknown[]) => unknown;
              }
            ).writeProjectedTextFile(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as VersionedTextStore;

    const { session } = await open({
      store: gated,
      onSettleStart: () => events.push("settling"),
      onSettled: () => {
        events.push("settled");
      },
      // Disarm the debounce so the only settles are the two explicit ones
      // below (the shared harness fires it synchronously on every edit).
      scheduleSettle: () => () => undefined,
    });
    const editor = mirrorEditor(session);
    typeIntoBody(editor, "First burst.");

    const first = session.settleNow();
    const second = session.settleNow();
    // Both cross their barrier while the first is still stuck in its write.
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect(events.filter((event) => event === "settling")).toHaveLength(2);
    expect(events).not.toContain("settled");

    releaseFirstProjection();
    await first;
    await second;
    expect(events.filter((event) => event === "settled").length).toBeGreaterThan(0);
    await session.close();
  });
});
