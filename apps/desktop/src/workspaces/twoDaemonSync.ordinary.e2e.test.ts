import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createBackgroundLiveStart, syncedNotePaths } from "./backgroundLiveStart";
import { createRelaySyncEngine } from "./relaySyncEngine";
import { RELAY_FETCH_TIMEOUT_MS, relayFetchWithTimeout } from "./sharedChannels";
import { createShowOnPhone } from "./showOnPhone";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";
import { createSuiteTestScratchSync, createTestScratch } from "./testTemp";
import {
  engine,
  compiledRelayMain,
  openJoinedDaemonCapture,
  openLiveDaemonCapture,
  pullAndExpect,
  pullCaptured,
  pushUntilDrained,
  writeAndCapture,
  type LiveDaemonCapture,
} from "./twoDaemonSync.fixture";

describe.skipIf(engine.missing)("ordinary relay scenarios", () => {
  let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>>;
  let starting: Promise<typeof relayServer> | undefined;

  // Cover the helper's 120 s startup guard and its shutdown drain.
  beforeAll(async () => {
    // Per-test scratch is removed after each case; this store belongs to the suite.
    const relayRoot = createSuiteTestScratchSync("dohc-ordinary-relay-");
    starting = spawnSyncRelay({
      dbPath: join(relayRoot, "relay", "relay.sqlite"),
      compiledMain: compiledRelayMain,
    });
    relayServer = await starting;
  }, 150_000);

  afterAll(async () => {
    await (await starting?.catch(() => undefined))?.stop();
  }, 30_000);

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
        (await capture!.listMoments({ limit: 100 })).moments.find(
          (moment) => moment.id === momentId,
        );
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        capture = createWorkspaceEngineCapture({
          ...owner.workspace,
          rustEngineSessions: owner.sessions,
        });
        const relay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
        await relay.claim();
        await owner.chats.ensureGeneralChannel({ workspaceId });
        await capture.writeAuthoredFile(join(root, "plan.md"), "first\n", person, {
          createOnly: true,
        });
        await capture.writeAuthoredFile(join(root, "plan.md"), "second\n", person);
        const [edit] = await waitForPathMoments(capture, "plan.md", 2);
        const { restoredMomentId } = await capture.restoreFileToBeforeMoment(edit!.id, person);
        expect(await readFile(join(root, "plan.md"), "utf8")).toBe("first\n");
        expect(await restoreMoment(restoredMomentId)).toMatchObject({
          metadata: { origin: "restore" },
          authors: [person],
        });

        expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        try {
          const sent = relayDb
            .prepare(
              "SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append' AND json_extract(payload_json, '$.momentId')=?",
            )
            .get(workspaceId, restoredMomentId) as { payload_json: string } | undefined;
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
        capture = createWorkspaceEngineCapture({
          ...owner.workspace,
          rustEngineSessions: owner.sessions,
        });
        expect(await restoreMoment(restoredMomentId)).toMatchObject({
          metadata: { origin: "restore" },
          authors: [person],
        });
      } finally {
        await capture?.stop();
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  it(
    "gives the server a live history for a note written as a file once a background start opens and closes it, and knows it has one the next time",
    async () => {
      const workspaceId = `two-daemon-background-live-${randomUUID()}`;
      const root = await createTestScratch("dohc-background-live-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      const person = { kind: "human", humanId: "local-person" } as const;
      // Markdown the editor would write differently, so an unchanged file proves the stored source was kept.
      const text = "---\ntitle: x\n---\nTitle\n=====\n\n* one\n* two  \n";
      const file = join(root, "agent.md");
      const onDisk = async () => ({
        bytes: await readFile(file),
        modified: (await stat(file, { bigint: true })).mtimeNs,
      });
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      // The relay's own test for a page a phone can edit (mainLiveLineageExists).
      const serverHoldsLineage = (objectId: string) => {
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        try {
          return (
            relayDb
              .prepare(
                "SELECT 1 FROM sync_relay_log WHERE workspace_id=? AND op_kind='ydoc.update' AND json_extract(payload_json, '$.objectId')=? AND json_extract(payload_json, '$.versionId')='main' AND relay_admission IS NULL LIMIT 1",
              )
              .get(workspaceId, objectId) !== undefined
          );
        } finally {
          relayDb.close();
        }
      };
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        capture = createWorkspaceEngineCapture({
          ...owner.workspace,
          rustEngineSessions: owner.sessions,
        });
        const relay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
        await relay.claim();
        const { objectId } = await capture.writeAuthoredFile(file, text, person, {
          createOnly: true,
        });
        await pushUntilDrained(relay);
        expect(serverHoldsLineage(objectId)).toBe(false);
        const written = await onDisk();
        expect(written.bytes).toEqual(Buffer.from(text));

        // What startLiveInBackground does once no editor holds the note: open with no window, then close.
        const backgroundStart = async () => {
          const session = await capture!.openYDocSession({
            path: "agent.md",
            contentKind: "richdoc",
            onRemoteUpdate: () => undefined,
          });
          await session.close();
          return session.lineageAtOpen;
        };
        expect(await backgroundStart()).toBe("absent");
        expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
        expect(serverHoldsLineage(objectId)).toBe(true);
        // Nothing changed the text, so the close wrote no file.
        expect(await onDisk()).toEqual(written);

        // A later run starts the note again. The engine says it has the history, so main asks for no pass.
        expect(await backgroundStart()).toBe("existing");
        expect(await onDisk()).toEqual(written);
      } finally {
        await capture?.stop();
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  it(
    "drops a page from the other computer when it is deleted in a file manager, whoever wrote it",
    async () => {
      const workspaceId = `two-daemon-outside-delete-${randomUUID()}`;
      const relay = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      const rootA = await createTestScratch("dohc-outside-delete-a-");
      const rootB = await createTestScratch("dohc-outside-delete-b-");
      const agent = { kind: "agent", agentId: "helper", onBehalfOf: "local:person" } as const;
      const deletedOutside = async (daemon: LiveDaemonCapture, root: string, path: string) => {
        await daemon.reconcileCapture();
        await rm(join(root, path));
        const [latest] = (await waitForPathMoments(daemon.capture, path, 2)).sort(
          (a, b) => b.momentOrder - a.momentOrder,
        );
        expect(latest?.operation, `${path} is recorded as deleted`).toBe("delete");
      };
      const onDisk = (root: string, path: string) =>
        access(join(root, path)).then(
          () => true,
          () => false,
        );
      let a: LiveDaemonCapture | undefined;
      let b: LiveDaemonCapture | undefined;
      try {
        a = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay });
        await a.relay.claim();
        await a.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(a.relay);
        await a.capture.writeAuthoredFile(join(rootA, "by-agent.md"), "from an agent\n", agent, {
          createOnly: true,
        });
        await waitForPathMoments(a.capture, "by-agent.md", 1);
        await writeAndCapture(a, rootA, "synced.md", "from the other computer\n");
        expect((await pushUntilDrained(a.relay)).pushed).toBeGreaterThan(0);

        b = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay });
        await pullAndExpect(b, rootB, "by-agent.md", "from an agent\n");
        expect(await readFile(join(rootB, "synced.md"), "utf8")).toBe("from the other computer\n");

        await deletedOutside(a, rootA, "by-agent.md");
        await deletedOutside(b, rootB, "synced.md");
        expect((await pushUntilDrained(a.relay)).pushed).toBeGreaterThan(0);
        expect((await pushUntilDrained(b.relay)).pushed).toBeGreaterThan(0);
        await pullCaptured(b.relay, b.capture);
        await pullCaptured(a.relay, a.capture);
        expect(await onDisk(rootB, "by-agent.md"), "the agent's page leaves B").toBe(false);
        expect(await onDisk(rootA, "synced.md"), "the synced page leaves A").toBe(false);
      } finally {
        await Promise.allSettled([b?.close(), a?.close()]);
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  it(
    "replays renameTextFile with a caller requestId on both VersionedLiveAdapter and VersionedTextStore",
    async () => {
      const workspaceId = `two-daemon-rename-replay-${randomUUID()}`;
      const root = await createTestScratch("dohc-rename-replay-");
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: root }, { maxRestarts: 0 });
        const { store } = createCaptureLiveStores(owner.workspace, owner.sessions);
        await store.ensureMainVersion({ workspaceId });
        await store.writeTextFile({
          workspaceId,
          versionId: "main",
          path: "notes/original.md",
          text: "hello\n",
          metadata: { origin: "api" },
        });
        await store.writeTextFile({
          workspaceId,
          versionId: "main",
          path: "notes/other.md",
          text: "other\n",
          metadata: { origin: "api" },
        });

        await owner.sessions.run(owner.workspace, async ({ client, workspace: handle }) => {
          const adapter = new VersionedLiveAdapter(client, handle, { workspaceId });
          const input = {
            workspaceId,
            versionId: "main",
            fromPath: "notes/original.md",
            toPath: "notes/adapter-moved.md",
            requestId: "rename-adapter-replay",
            metadata: { origin: "api" as const },
          };
          const first = await adapter.renameTextFile(input);
          const replay = await adapter.renameTextFile(input);
          expect(first.deduped).toBe(false);
          expect(replay.deduped).toBe(true);
          expect(replay.object.id).toBe(first.object.id);
          expect(replay.moment.momentId).toBe(first.moment.momentId);
          await expect(
            adapter.renameTextFile({
              ...input,
              fromPath: "notes/other.md",
              toPath: "notes/other-moved.md",
            }),
          ).rejects.toThrow("idempotency-key-reuse-mismatch");
        });

        const storeInput = {
          workspaceId,
          versionId: "main",
          fromPath: "notes/adapter-moved.md",
          toPath: "notes/store-moved.md",
          requestId: "rename-store-replay",
          metadata: { origin: "api" as const },
        };
        const firstStore = await store.renameTextFile(storeInput);
        const replayStore = await store.renameTextFile(storeInput);
        expect(replayStore.object.id).toBe(firstStore.object.id);
        expect(replayStore.moment.id).toBe(firstStore.moment.id);
        expect(replayStore.before).toMatchObject({
          path: "notes/adapter-moved.md",
          text: "hello\n",
        });
        expect(replayStore.after).toMatchObject({ path: "notes/store-moved.md", text: "hello\n" });
        expect(
          await store.readTextFile({
            workspaceId,
            versionId: "main",
            path: "notes/adapter-moved.md",
          }),
        ).toBeNull();
        expect(
          await store.readTextFile({
            workspaceId,
            versionId: "main",
            path: "notes/store-moved.md",
          }),
        ).toMatchObject({ text: "hello\n" });
        await expect(
          store.renameTextFile({
            ...storeInput,
            fromPath: "notes/other.md",
            toPath: "notes/other-store-moved.md",
          }),
        ).rejects.toThrow("idempotency-key-reuse-mismatch");
      } finally {
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

  it(
    "warms a synced-in Markdown note in the background while skipping notes already seeded or live on the relay",
    async () => {
      const workspaceId = `two-daemon-synced-live-start-${randomUUID()}`;
      const relay = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      const rootA = await createTestScratch("dohc-synced-live-a-");
      const rootB = await createTestScratch("dohc-synced-live-b-");
      const plainText = "---\ntitle: synced\n---\nSynced\n======\n\n* one\n";
      const seededText = "# Seeded on peer A\n";
      const liveText = "# Already live\n";
      const relayLineageUpdates = (objectId: string) => {
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        try {
          const row = relayDb
            .prepare(
              "SELECT COUNT(*) AS count FROM sync_relay_log WHERE workspace_id=? AND op_kind='ydoc.update' AND json_extract(payload_json, '$.objectId')=? AND json_extract(payload_json, '$.versionId')='main' AND relay_admission IS NULL",
            )
            .get(workspaceId, objectId) as { count: number };
          return row.count;
        } finally {
          relayDb.close();
        }
      };
      let a: LiveDaemonCapture | undefined;
      let b: LiveDaemonCapture | undefined;
      let syncB: ReturnType<typeof createRelaySyncEngine> | undefined;
      let backgroundLiveStart: ReturnType<typeof createBackgroundLiveStart> | undefined;
      try {
        a = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay });
        await a.relay.claim();
        await a.chats.ensureGeneralChannel({ workspaceId });
        expect((await pushUntilDrained(a.relay)).pushed).toBeGreaterThan(0);

        b = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay });
        await pullCaptured(b.relay, b.capture);

        await writeAndCapture(a, rootA, "already-live.md", liveText);
        await writeAndCapture(a, rootA, "already-seeded.md", seededText);
        await writeAndCapture(a, rootA, "synced-plain.md", plainText);
        const plainObjectId = await a.capture.fileObjectIdForPath("synced-plain.md");
        const seededObjectId = await a.capture.fileObjectIdForPath("already-seeded.md");
        const liveObjectId = await a.capture.fileObjectIdForPath("already-live.md");
        expect(plainObjectId).toBeTruthy();
        expect(seededObjectId).toBeTruthy();
        expect(liveObjectId).toBeTruthy();
        expect((await pushUntilDrained(a.relay)).pushed).toBeGreaterThan(0);
        expect(relayLineageUpdates(plainObjectId!)).toBe(0);
        expect(relayLineageUpdates(seededObjectId!)).toBe(0);
        expect(relayLineageUpdates(liveObjectId!)).toBe(0);

        const relayDb = new DatabaseSync(relayServer.dbPath);
        try {
          const ws = relayDb
            .prepare(
              "SELECT owner_user_id, replication_epoch, stream_identity FROM sync_relay_workspaces WHERE workspace_id=?",
            )
            .get(workspaceId) as {
            owner_user_id: string;
            replication_epoch: string;
            stream_identity: string;
          };
          relayDb
            .prepare(
              `INSERT INTO sync_relay_service_host_enrollments(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
                created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes,generation,state,since_ms,changed_by)
                VALUES (?,?,?,?,NULL,?,?,1,1,1,1,64,1,'live',1,'server')`,
            )
            .run(
              workspaceId,
              liveObjectId!,
              "already-live.md",
              ws.owner_user_id,
              ws.replication_epoch,
              ws.stream_identity,
            );
        } finally {
          relayDb.close();
        }

        const phoneErrors: unknown[] = [];
        const showOnPhone = createShowOnPhone({
          session: async () => ({
            generation: 1,
            relay: { ...relay, fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS) },
            unauthorized: async () => undefined,
          }),
          onError: (_message, error) => phoneErrors.push(error),
        });
        expect(await showOnPhone.liveNotes(workspaceId)).toEqual(new Set([liveObjectId!]));

        const outcomes = new Map<string, "existing" | "absent">();
        let activePath: string | undefined;
        let peerSeeded = false;
        let liveNotesChecks = 0;
        let pulledPlainDisk: { bytes: Buffer; modified: bigint } | undefined;
        backgroundLiveStart = createBackgroundLiveStart({
          eligible: () => true,
          noteIdentity: async (targetWorkspaceId, path) => {
            activePath = path;
            return await b!.sessions.run(b!.workspace, async ({ client, workspace: handle }) => {
              const resolved = await new VersionedLiveAdapter(client, handle, {
                workspaceId: targetWorkspaceId,
              }).resolveFiles({ workspaceId: targetWorkspaceId, targets: [{ path }] });
              const file = resolved.results[0];
              return resolved.versionId === "main" && file?.status === "found"
                ? { versionId: resolved.versionId, objectId: file.objectId }
                : null;
            });
          },
          showsOnPhone: async () => true,
          catchUp: async (_targetWorkspaceId, signal) => {
            await syncB!.catchUp({ signal });
            const snap = syncB!.snapshot();
            return (
              !signal.aborted &&
              snap.syncFailure === null &&
              !snap.authExpired &&
              !snap.updateRequired
            );
          },
          relayLiveNotes: async (targetWorkspaceId, signal) => {
            liveNotesChecks += 1;
            const live = await showOnPhone.liveNotes(targetWorkspaceId, signal);
            if (activePath === "already-seeded.md" && !peerSeeded) {
              peerSeeded = true;
              const peerSeed = await a!.capture.openYDocSession({
                path: "already-seeded.md",
                contentKind: "richdoc",
                onRemoteUpdate: () => undefined,
              });
              await peerSeed.close();
              expect(peerSeed.lineageAtOpen).toBe("absent");
              expect((await pushUntilDrained(a!.relay)).pushed).toBeGreaterThan(0);
              expect(relayLineageUpdates(seededObjectId!)).toBe(1);
            }
            return live;
          },
          noteBytes: async (_targetWorkspaceId, path) =>
            await stat(join(rootB, path)).then(
              (entry) => entry.size,
              () => null,
            ),
          isLossyNote: async () => false,
          start: async (_targetWorkspaceId, path) => {
            const session = await b!.capture.openYDocSession({
              path,
              contentKind: "richdoc",
              onRemoteUpdate: () => undefined,
            });
            await session.close();
            outcomes.set(path, session.lineageAtOpen);
            if (session.lineageAtOpen === "absent") syncB?.queuePull();
          },
          onError: (_message, error) => phoneErrors.push(error),
          quietMs: 50,
          gapMs: 50,
          maxWaitMs: 500,
        });

        syncB = createRelaySyncEngine({
          rootDir: rootB,
          relay,
          operations: b.relay,
          capture: b.capture,
          onChange: () => undefined,
          debounceMs: 50,
          afterSuccessfulPull: async ({ fastForwardedPaths }) => {
            const notes = syncedNotePaths(fastForwardedPaths);
            if (notes.includes("synced-plain.md") && !pulledPlainDisk) {
              const file = join(rootB, "synced-plain.md");
              pulledPlainDisk = {
                bytes: await readFile(file),
                modified: (await stat(file, { bigint: true })).mtimeNs,
              };
            }
            if (notes.length > 0) backgroundLiveStart!.note(workspaceId, notes);
            backgroundLiveStart!.retry(workspaceId);
          },
        });

        await syncB.start();

        await vi.waitFor(
          () => {
            expect(liveNotesChecks).toBeGreaterThanOrEqual(3);
            expect(relayLineageUpdates(plainObjectId!)).toBe(1);
          },
          {
            timeout: REAL_DAEMON_DEADLINE_MS,
            interval: 50,
          },
        );
        expect(peerSeeded).toBe(true);
        expect(outcomes.get("synced-plain.md")).toBe("absent");
        expect(outcomes.get("already-seeded.md")).toBe("existing");
        expect(outcomes.has("already-live.md")).toBe(false);
        expect(relayLineageUpdates(seededObjectId!)).toBe(1);
        expect(relayLineageUpdates(liveObjectId!)).toBe(0);
        expect(phoneErrors).toEqual([]);
        expect(pulledPlainDisk?.bytes).toEqual(Buffer.from(plainText));
        const afterFile = join(rootB, "synced-plain.md");
        expect({
          bytes: await readFile(afterFile),
          modified: (await stat(afterFile, { bigint: true })).mtimeNs,
        }).toEqual(pulledPlainDisk);
      } finally {
        await backgroundLiveStart?.stop();
        await syncB?.stop();
        await Promise.allSettled([b?.close(), a?.close()]);
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );
});
