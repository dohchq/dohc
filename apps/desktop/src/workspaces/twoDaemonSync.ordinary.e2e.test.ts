import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";
import { createSuiteTestScratchSync, createTestScratch } from "./testTemp";
import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";
import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, pullAndExpect } from "./twoDaemonSync.fixture";

describe.skipIf(engine.missing)("ordinary relay scenarios", () => {
  let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>>;
  let starting: Promise<typeof relayServer> | undefined;

  // Cover the helper's 120 s startup guard and its shutdown drain.
  beforeAll(async () => {
    // Per-test scratch is removed after each case; this store belongs to the suite.
    const relayRoot = createSuiteTestScratchSync("dohc-ordinary-relay-");
    starting = spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    relayServer = await starting;
  }, 150_000);

  afterAll(async () => {
    await (await starting?.catch(() => undefined))?.stop();
  }, 30_000);

  it.each([true, false])(
    "settles adoption of an already-open Collection record through the real relay (has id=%s)",
    async (hasId) => {
      const workspaceId = `two-daemon-open-adoption-${hasId}-${randomUUID()}`;
      const rootA = await createTestScratch("dohc-open-adoption-a-");
      const rootB = await createTestScratch("dohc-open-adoption-b-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: `test:${workspaceId}` };
      const person = { kind: "human", humanId: "local-person" } as const;
      const path = "tasks/pending.md";
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      let peer: LiveDaemonCapture | undefined;
      let sync: CloudSyncEngine | undefined;
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0 });
        const source = owner;
        const relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
        await relay.claim();
        await source.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(relay);
        const adapter = await source.sessions.run(source.workspace, async ({ client, workspace }) =>
          new VersionedLiveAdapter(client, workspace, { workspaceId }));
        await adapter.ensureMainVersion({ workspaceId });
        for (const [filePath, text] of [
          ["tasks/collection.yaml", "fields:\n  Name:\n    type: text\n"],
          [path, `${hasId ? "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n" : ""}# Keep this body\n`],
        ]) {
          await adapter.writeTextFile({ workspaceId, versionId: "main", path: filePath!, text: text!, publish: true,
            metadata: { origin: "api" }, author: person });
        }
        // Reconciliation inserts the binding but cannot adopt it until desktop
        // imports the rich-document lineage. Open the editor in that window.
        await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.map(item => item.filePath),
          { timeout: REAL_DAEMON_DEADLINE_MS }).toEqual([path]);
        const errors: string[] = [];
        capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions,
          settleDebounceMs: 60_000, onError: (context, error) => errors.push(`${context}: ${String(error)}`) });
        const session = await capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
        expect((await adapter.listPendingCollectionAdoptions()).adoptions.map(item => item.filePath)).toEqual([path]);
        if (!hasId) await capture.flush();
        await session.applyDecidedLocalUpdate(doc => {
          const scratch = new Y.Doc();
          try {
            Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
            const before = Y.encodeStateVector(scratch);
            patchFrontmatter(scratch, new Map([["Name", "Manual"]]));
            return Y.encodeStateAsUpdate(scratch, before);
          } finally { scratch.destroy(); }
        }, undefined, { actorOriginId: "local-person", attribution: { actorKind: "human" }, idempotencyKey: "owner-name" });
        if (!hasId) await session.settleNow();
        // The editor keeps its lease throughout adoption and capture settlement.
        await capture.flush();
        capture.start();
        await expect.poll(async () => ({ pending: (await adapter.listPendingCollectionAdoptions()).adoptions.length,
          settled: (await adapter.flushCapture()).settled, errors }), { timeout: REAL_DAEMON_DEADLINE_MS })
          .toEqual({ pending: 0, settled: true, errors: [] });
        expect(errors).toEqual([]);
        await expect.poll(() => adapter.watcherStatus(), { timeout: REAL_DAEMON_DEADLINE_MS })
          .toMatchObject({ running: true, degraded: false, phase: "ready" });
        const markdown = await readFile(join(rootA, path), "utf8");
        expect(markdown).toContain("Name: Manual");
        expect(markdown).toContain("# Keep this body");
        expect(session.doc.getMap("frontmatter").get("Name")).toBe("Manual");
        const recordId = session.doc.getMap("frontmatter").get("id");
        if (typeof recordId !== "string") throw new Error("Adoption did not install the record id.");
        const record = await adapter.getCollectionRecord({ collectionPath: "tasks", recordId, historyLimit: 100 });
        expect(record.history.find(change => change.field === "Name")).toMatchObject({ authorOriginId: "local-person" });
        const head = await adapter.readTextFile({ workspaceId, versionId: "main", path });
        const moments = (await capture.listMoments({ limit: 100 })).moments;
        expect(moments.find(moment => moment.id === head?.latestMomentId)?.authors).toContainEqual(person);
        expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([]);
        sync = createRelaySyncEngine({ rootDir: rootA, relay: relayConnection, operations: relay, capture,
          onChange: () => undefined });
        sync.queueSync();
        await sync.start();
        expect(sync.snapshot()).toMatchObject({ pendingChangeCount: 0, syncFailure: null });
        await sync.stop();
        peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: relayConnection });
        await pullAndExpect(peer, rootB, path, markdown);
        await session.close();
      } finally {
        await sync?.stop();
        await peer?.close();
        try { await capture?.stop().catch(() => undefined); } finally { await owner?.close(); }
      }
    },
    60_000,
  );

  it(
    "names the person on their restore in local History after a reopen, and never sends them to the relay",
    async () => {
      const workspaceId = `two-daemon-person-restore-${randomUUID()}`;
      const root = await createTestScratch("dohc-person-restore-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      const person = { kind: "human", humanId: "local-person" } as const;
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      const restoreMoment = async (momentId: string) =>
        (await capture!.listMoments({ limit: 100 })).moments.find(moment => moment.id === momentId);
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
        const relay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
        await relay.claim();
        await owner.chats.ensureGeneralChannel({ workspaceId });
        await capture.writeAuthoredFile(join(root, "plan.md"), "first\n", person, { createOnly: true });
        await capture.writeAuthoredFile(join(root, "plan.md"), "second\n", person);
        const [edit] = await waitForPathMoments(capture, "plan.md", 2);
        const { restoredMomentId } = await capture.restoreFileToBeforeMoment(edit!.id, person);
        expect(await readFile(join(root, "plan.md"), "utf8")).toBe("first\n");
        expect(await restoreMoment(restoredMomentId)).toMatchObject({ metadata: { origin: "restore" }, authors: [person] });

        expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        try {
          const sent = relayDb.prepare(
            "SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append' AND json_extract(payload_json, '$.momentId')=?",
          ).get(workspaceId, restoredMomentId) as { payload_json: string } | undefined;
          expect(JSON.parse(sent!.payload_json)).toMatchObject({ metadata: { origin: "restore" } });
          expect(JSON.parse(sent!.payload_json).authors).toBeUndefined();
          expect(JSON.parse(sent!.payload_json).attributionUnavailable).toBeUndefined();
          expect(sent!.payload_json).not.toContain(person.humanId);
        } finally {
          relayDb.close();
        }

        await capture.stop();
        await owner.close();
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
        expect(await restoreMoment(restoredMomentId)).toMatchObject({ metadata: { origin: "restore" }, authors: [person] });
      } finally {
        await capture?.stop();
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  it("joins after a page in a folder was renamed in dohc", async () => {
    const workspaceId = `two-daemon-join-after-rename-${randomUUID()}`;
    const rootA = await createTestScratch("dohc-join-after-rename-a-");
    const rootB = await createTestScratch("dohc-join-after-rename-b-");
    const connection = { baseUrl: relayServer.baseUrl, token: `test:${workspaceId}` };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      await pushUntilDrained(daemonA.relay);
      await writeAndCapture(daemonA, rootA, "notes/before.md", "body\n");
      const finish = await daemonA.capture.beginFileRename("notes/before.md", "notes/after.md");
      await rename(join(rootA, "notes", "before.md"), join(rootA, "notes", "after.md"));
      await finish(true);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      const receiver = daemonB;
      const pull = await receiver.relay.pull(apply => receiver.capture.runRelaySync(apply));
      expect(pull.fastForwardedPaths.filter(({ path }) => path.startsWith("notes/"))
        .map(({ operation, path }) => [operation, path])).toEqual([["delete", "notes/before.md"], ["write", "notes/after.md"]]);
      expect(await readdir(join(rootB, "notes"))).toEqual(["after.md"]);
      expect(await readFile(join(rootB, "notes", "after.md"), "utf8")).toBe("body\n");
      const again = await receiver.relay.pull(apply => receiver.capture.runRelaySync(apply));
      expect(again).toMatchObject({ fetched: 0, applied: 0, fastForwardedPaths: [] });
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
    }
  }, 60_000);

});
