import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import {
  captureSharedViewLocalDivergence,
  materializeSharedViewPaths,
} from "./sharedView";
import { readWorkspaceText, writeWorkspaceText } from "./workspaceAssets";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import { applyShareViewTextWrite } from "./shareViewFileChanges";

// The seam the desktop e2e exposed and every unit test missed (#646 PR3a).
//
// A recipient's edit in an edit-level share view has to become a PROPOSABLE
// change, and "proposable" is not a UI state: it is a moment in this replica's
// engine store and a row in its `replication_log`, because the submit lane
// reads exactly that log. A write that only reached disk left both empty, and
// nothing in the suite noticed, because nothing in the suite drove a real
// store through the real write path.
//
// So this suite drives the mutation primitive that ShareViewFiles owns against
// a real daemon, and asserts the journal rather than the return value.

const engine = requireEngineBinaryOrSkip();
const SHARE_ID = "share-e2e";

const requireModule = createRequire(import.meta.url);

interface Harness {
  workspaceId: string;
  rootPath: string;
  store: CaptureVersionedTextStore;
  sessions: EngineWorkspaceSessions;
}

const lifecycles: EngineDaemonLifecycle[] = [];
const sessionSets: EngineWorkspaceSessions[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sessionSets.splice(0).map((sessions) => sessions.closeAll().catch(() => undefined)),
  );
  await Promise.all(
    lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * A real daemon, a real engine store, and — for a share view — the sync
 * identity its journal needs.
 *
 * The identity is not decoration. `workspace_journals_file_moments_in_tx`
 * (crates/dohc-engine-sync/src/journal.rs) journals a file moment only for a
 * workspace that replicates, and for a share view the `share_view_file_lane`
 * row recorded here is what makes that true. A test that skipped it would
 * assert an engine moment and never touch the log the submit lane reads.
 */
async function harness(prefix: string, access?: "comment" | "edit"): Promise<Harness> {
  const rootPath = await createTestScratch(prefix);
  roots.push(rootPath);
  const workspaceId = `${prefix}${process.pid}-${Date.now()}`;
  const lifecycle = new EngineDaemonLifecycle({
    command: engine.require(),
    requestTimeoutMs: 10_000,
  });
  lifecycles.push(lifecycle);
  await lifecycle.start();
  const routes = new RelayTransportRouteGuard();
  const sessions = new EngineWorkspaceSessions(
    new RelayConfiguredDaemonClientSource(lifecycle, routes),
  );
  sessionSets.push(sessions);
  if (access) {
    // The relay is never contacted: recording an identity writes local rows
    // only. The URL exists because the daemon refuses a relay operation on a
    // workspace opened without a relay configuration.
    const client = new EngineRelayClient({
      sessions,
      routes,
      allowInsecureLoopbackForTests: true,
      requestDeadlineMs: 10_000,
    }).bind({
      workspaceId,
      rootPath,
      relay: { baseUrl: "http://127.0.0.1:9", token: "share-view-test-token" },
    });
    await client.recordShareViewIdentity({
      grantedSelector: { paths: ["docs"], versionId: null, access },
    });
  }
  const { store } = createCaptureLiveStores({ workspaceId, rootPath }, sessions);
  return { workspaceId, rootPath, store, sessions };
}

/** The granter's file, as the share's pull leaves it: a moment and a projection. */
async function seedSharedFile(
  harnessed: Harness,
  path: string,
  text: string,
): Promise<{ momentId: string; contentHash: string }> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  const written = await harnessed.store.writeTextFile({
    workspaceId: harnessed.workspaceId,
    versionId: main.id,
    path,
    text,
    metadata: { origin: "sync" },
  });
  await materializeSharedViewPaths(
    harnessed.rootPath,
    harnessed.workspaceId,
    [{ path, operation: "write", contentKind: "text" }],
    harnessed.store,
  );
  const read = await readWorkspaceText(harnessed.rootPath, path);
  if (read.contentHash === null) throw new Error("Seeded file has no content hash.");
  return { momentId: written.moment.id, contentHash: read.contentHash };
}

async function momentIdsFor(harnessed: Harness, path: string): Promise<string[]> {
  const page = await harnessed.store.listMoments({
    workspaceId: harnessed.workspaceId,
    limit: 100,
  });
  return page.moments.filter((moment) => moment.path === path).map((moment) => moment.id);
}

// The journal itself, read the way the defect was measured. `replication_log`
// is what `push_share_ops` scans, so counting its rows is the difference
// between "the engine has the change" and "the recipient can send it".
function replicationLogRows(rootPath: string): number {
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => {
      prepare(sql: string): { get(): Record<string, unknown> | undefined };
      close(): void;
    };
  };
  const database = new DatabaseSync(
    join(rootPath, ".dohc", "engine", "engine.db"),
    { readOnly: true },
  );
  try {
    const row = database.prepare("SELECT COUNT(*) AS rows FROM replication_log").get();
    return Number(row?.rows ?? 0);
  } finally {
    database.close();
  }
}

describe("share-view text writes through the real store", () => {
  it.skipIf(engine.missing)(
    "makes an edit recipient's save a proposable moment, not just a file",
    async () => {
      const view = await harness("dohc-share-edit-write-", "edit");
      const path = "docs/note.md";
      const seeded = await seedSharedFile(view, path, "granter\n");
      const journalBefore = replicationLogRows(view.rootPath);

      const result = await applyShareViewTextWrite({
        workspaceId: view.workspaceId,
        rootPath: view.rootPath,
        relativePath: path,
        text: "recipient\n",
        expectedContentHash: seeded.contentHash,
        shareViewStore: () => view.store,
      });

      expect(result.status).toBe("written");
      const moments = await momentIdsFor(view, path);
      expect(
        moments.filter((id) => id !== seeded.momentId),
        "MUTATION: a save that only writes the file leaves the granter's replayed moment alone in the store",
      ).toHaveLength(1);
      expect(
        replicationLogRows(view.rootPath),
        "MUTATION: a moment nothing journaled is a change the submit lane cannot see",
      ).toBeGreaterThan(journalBefore);
      await expect(readFile(join(view.rootPath, "docs", "note.md"), "utf8")).resolves.toBe(
        "recipient\n",
      );
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "repairs a save interrupted after the store write instead of capturing stale disk bytes",
    async () => {
      const view = await harness("dohc-share-interrupted-write-", "edit");
      const path = "docs/note.md";
      const seeded = await seedSharedFile(view, path, "granter\n");
      const failingStore: CaptureVersionedTextStore = {
        ...view.store,
        async writeTextFile(input) {
          await view.store.writeTextFile(input);
          throw new Error("simulated crash after store write");
        },
      };

      await expect(
        applyShareViewTextWrite({
          workspaceId: view.workspaceId,
          rootPath: view.rootPath,
          relativePath: path,
          text: "recipient\n",
          expectedContentHash: seeded.contentHash,
          shareViewStore: () => failingStore,
        }),
      ).rejects.toThrow("simulated crash after store write");

      const momentsBeforeRecovery = await momentIdsFor(view, path);
      await expect(
        captureSharedViewLocalDivergence(
          view.rootPath,
          view.workspaceId,
          view.store,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await momentIdsFor(view, path)).toEqual(momentsBeforeRecovery);
      await expect(
        readFile(join(view.rootPath, path), "utf8"),
      ).resolves.toBe("recipient\n");
      const main = await view.store.ensureMainVersion({
        workspaceId: view.workspaceId,
      });
      await expect(
        view.store.readTextFile({
          workspaceId: view.workspaceId,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "recipient\n" });
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "refuses a stale save before it journals anything",
    async () => {
      const view = await harness("dohc-share-stale-write-", "edit");
      const path = "docs/note.md";
      const seeded = await seedSharedFile(view, path, "granter\n");
      const journalBefore = replicationLogRows(view.rootPath);

      const result = await applyShareViewTextWrite({
        workspaceId: view.workspaceId,
        rootPath: view.rootPath,
        relativePath: path,
        text: "recipient\n",
        expectedContentHash:
          "0000000000000000000000000000000000000000000000000000000000000000",
        shareViewStore: () => view.store,
      });

      expect(result).toEqual({
        status: "conflict",
        currentContentHash: seeded.contentHash,
      });
      expect(
        await momentIdsFor(view, path),
        "MUTATION: journaling before the hash check sends the granter a change built on bytes the recipient never read",
      ).toEqual([seeded.momentId]);
      expect(replicationLogRows(view.rootPath)).toBe(journalBefore);
      await expect(readFile(join(view.rootPath, "docs", "note.md"), "utf8")).resolves.toBe(
        "granter\n",
      );
    },
    60_000,
  );

  // Authority is covered at the ShareViewFiles owner. These daemon tests stay
  // on the mutation primitive and prove only store/projection behavior.

  it.skipIf(engine.missing)(
    "leaves an ordinary workspace's save to disk, where the watcher records it",
    async () => {
      const workspace = await harness("dohc-ordinary-write-");
      const path = "note.md";
      await writeFile(join(workspace.rootPath, path), "before\n", "utf8");
      const read = await readWorkspaceText(workspace.rootPath, path);
      // The baseline is taken with the store already open, so the daemon's own
      // open-time reconciliation is counted here rather than mistaken for the
      // write's moment below.
      const before = await momentIdsFor(workspace, path);

      const result = await writeWorkspaceText(
        workspace.rootPath,
        path,
        "after\n",
        read.contentHash ?? "",
      );

      expect(result.status).toBe("written");
      await expect(readFile(join(workspace.rootPath, path), "utf8")).resolves.toBe(
        "after\n",
      );
      expect(
        await momentIdsFor(workspace, path),
        "MUTATION: an ordinary workspace writing engine-direct journals every save twice — once here, once from the watcher",
      ).toEqual(before);
    },
    60_000,
  );
});
