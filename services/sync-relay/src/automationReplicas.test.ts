import { DiscussionActivityHub } from "./discussionActivity";
import { createAccountDeletionRoute } from "./accountDeletionRoute";
import { initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatsLiveAdapter, type JsonValue, type Request } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { phoneWriteIds, publicationStages, type WriteCommand } from "./accountChatWrites";
import {
  authorizeAutomationReplication,
  deriveAutomationReplicaBearer,
} from "./automationReplicaCredential";
import { removeAutomationReplicas, startAutomationReplicas } from "./automationReplicas";
import { createServiceHostReplication } from "./serviceHostReplication";
import { deriveServiceHostBearer } from "./serviceHostCredential";
import type { SyncRelayStorage } from "./storage";
import {
  AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS,
  AUTOMATION_WORKSPACE_LEAVE_AFTER_MS,
  type CopyReason,
} from "./storage/automationWorkspaces";
import { OPERATION_ACTIVE_MS, OPERATION_STALLED_KEEP_MS } from "./storage/operationRecords";
import type { PublicationCommand } from "./operationPublication";
import {
  closeTestStorages,
  inspectDatabase,
  storagePath,
  testStorage,
  closeTestStorage,
  reopenTestStorage,
} from "./testing";
import { notifyRelayWrite } from "./relayWriteChanges";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("@dohc/workspace-engine-client/daemon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>()),
  createEngineClient: spawn,
}));
// A folder a test names here can't be removed, as when the disk refuses. With `renamed`, so can the name
// it is renamed to on its way out. With `partly`, the removal first deletes the folder's settled marker.
const stuck = vi.hoisted(() => ({ path: null as string | null, renamed: false, partly: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = String(args[0]);
      if (
        stuck.path !== null &&
        (target === stuck.path || (stuck.renamed && target.startsWith(`${stuck.path}.discarded-`)))
      ) {
        if (stuck.partly) await actual.rm(joinPath(target, "settled"), { force: true });
        throw Object.assign(new Error("the folder is busy"), { code: "EBUSY" });
      }
      return await actual.rm(...args);
    },
  };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  // Every cleanup runs even after one fails; the first failure is reported once all have run.
  let failure: { error: unknown } | undefined;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= { error };
    }
  }
  spawn.mockReset();
  closeTestStorages();
  if (failure) throw failure.error;
});

const WORKSPACE = "workspace-trip";
const key = new Uint8Array(32).fill(7),
  namespace = "automation-replica-test";
// vi.waitFor has its own 1 s default, independent of the package's expect.poll timeout.
const WAIT_TIMEOUT_MS = 10_000;

type ReplicaOptions = Parameters<typeof startAutomationReplicas>[0];
// Most tests keep copies for automations; they name the workspaces, and this gives each its reason.
type AutomationOptions = Omit<ReplicaOptions, "wanted"> & { wanted: () => readonly string[] };
const automation = (ids: readonly string[]) =>
  new Map(ids.map((id) => [id, ["automation"] as const]));
const startReplicas = (options: AutomationOptions) =>
  startAutomationReplicas({ ...options, wanted: () => automation(options.wanted()) });

async function relay() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: 1 });
  storage.claimWorkspaceIdentity({
    workspaceId: WORKSPACE,
    replicationEpoch: "epoch-1",
    streamIdentity: "stream-1",
  });
  const raw = inspectDatabase(storagePath(storage));
  const log = (seq: number) =>
    raw
      .prepare(
        "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'desk', ?, 'moment.append', '{}', 1)",
      )
      .run(WORKSPACE, seq);
  return { storage, raw, log };
}

// An accepted press from a shared view, taken by `acceptedBy`.
function acceptedPress(
  raw: ReturnType<typeof inspectDatabase>,
  hostPressId: string,
  acceptedBy: string,
) {
  raw
    .prepare(
      `INSERT INTO sync_relay_automation_presses (host_press_id, workspace_id, share_id, grant_id, grant_generation, press_id, user_id,
       automation_id, collection_path, definition_hash, record_id, state, accepted_by, outcome, error, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'share', 'grant', 1, ?, 'ana', 'collection:Tasks#pay', 'Tasks', '0123456789abcdef', 'r1', 'accepted', ?, NULL, NULL, 1, 1)`,
    )
    .run(hostPressId, WORKSPACE, hostPressId, acceptedBy);
}
const pressState = (raw: ReturnType<typeof inspectDatabase>, hostPressId: string) =>
  raw
    .prepare("SELECT state, outcome FROM sync_relay_automation_presses WHERE host_press_id = ?")
    .get(hostPressId);

describe("the workspaces this server keeps a replica of", () => {
  it("joins once per identity, and a changed identity starts a new incarnation that ends the presses the server took", async () => {
    const { storage, raw } = await relay();
    const first = storage.joinAutomationWorkspace({
      workspaceId: WORKSPACE,
      nowMs: 10,
      reasons: ["automation"],
    })!;
    expect(first).toMatchObject({
      ownerUserId: "owner",
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
      incarnation: 1,
      startedAtMs: 10,
    });
    expect(
      storage.joinAutomationWorkspace({
        workspaceId: WORKSPACE,
        nowMs: 20,
        reasons: ["automation"],
      }),
    ).toEqual(first);

    acceptedPress(raw, "taken-here", "server");
    acceptedPress(raw, "taken-there", "laptop");
    storage.rotateWorkspaceIdentity({
      workspaceId: WORKSPACE,
      ownerUserId: "owner",
      replicationEpoch: "epoch-2",
      streamIdentity: "stream-2",
      rotatedAtMs: 30,
    });
    expect(
      storage.currentAutomationWorkspace(WORKSPACE),
      "the old replica's credential stops",
    ).toBeNull();
    const second = storage.joinAutomationWorkspace({
      workspaceId: WORKSPACE,
      nowMs: 40,
      reasons: ["automation"],
    })!;
    expect(second).toMatchObject({ replicationEpoch: "epoch-2", incarnation: 2, startedAtMs: 40 });
    expect(second.credentialNonce).not.toBe(first.credentialNonce);
    expect(pressState(raw, "taken-here")).toEqual({ state: "settled", outcome: "ended" });
    expect(pressState(raw, "taken-there")).toEqual({ state: "accepted", outcome: null });
    expect(
      storage.joinAutomationWorkspace({
        workspaceId: "unknown",
        nowMs: 1,
        reasons: ["automation"],
      }),
    ).toBeNull();
  });

  it("widens a relay's copy reasons once for the phone's writes, keeping every reason it had", async () => {
    const { storage } = await relay();
    storage.joinAutomationWorkspace({
      workspaceId: WORKSPACE,
      nowMs: 0,
      reasons: ["automation", "account"],
    });
    const path = storagePath(storage);
    closeTestStorage(storage);
    const older = inspectDatabase(path);
    older.exec(`DROP TABLE sync_relay_automation_workspace_reasons;
      CREATE TABLE sync_relay_automation_workspace_reasons (
        workspace_id TEXT NOT NULL REFERENCES sync_relay_automation_workspaces(workspace_id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('automation', 'account')),
        PRIMARY KEY (workspace_id, reason)
      ) STRICT;
      INSERT INTO sync_relay_automation_workspace_reasons VALUES ('${WORKSPACE}', 'automation'), ('${WORKSPACE}', 'account');
      DELETE FROM sync_relay_migrations WHERE migration_id = 'copy-publication-reason-v1';`);
    older.close();
    const upgraded = reopenTestStorage(path);
    expect(upgraded.listAutomationWorkspaces()[0]?.reasons).toEqual(["account", "automation"]);
    expect(
      upgraded.joinAutomationWorkspace({
        workspaceId: WORKSPACE,
        nowMs: 1,
        reasons: ["publication"],
      })?.reasons,
    ).toEqual(["account", "automation", "publication"]);
    closeTestStorage(upgraded);
    expect(
      reopenTestStorage(path).listAutomationWorkspaces()[0]?.reasons,
      "a second open changes nothing",
    ).toEqual(["account", "automation", "publication"]);
  });
});

describe("the automation replica's credential", () => {
  it("replicates only its own workspace, as its owner, while the replica is current", async () => {
    const { storage } = await relay();
    const row = storage.joinAutomationWorkspace({
      workspaceId: WORKSPACE,
      nowMs: 0,
      reasons: ["automation"],
    })!;
    const bearer = deriveAutomationReplicaBearer(row, { key, namespace });
    expect(bearer).toMatch(/^dohc-automation-v1\./u);
    const authorize = (input: {
      workspaceId?: string;
      bearer?: string;
      pathname?: string;
      method?: string;
    }) =>
      authorizeAutomationReplication(storage, {
        key,
        namespace,
        workspaceId: WORKSPACE,
        bearer,
        method: "GET",
        pathname: `/sync/${WORKSPACE}/bootstrap`,
        ...input,
      });
    expect(authorize({})).toBe("owner");
    expect(authorize({ pathname: `/sync/${WORKSPACE}/log`, method: "POST" }), "a push").toBe(
      "owner",
    );
    expect(authorize({ pathname: `/sync/${WORKSPACE}/live-host` }), "not replication").toBeNull();
    expect(authorize({ pathname: "/sync/workspaces" })).toBeNull();
    expect(authorize({ workspaceId: "other", pathname: "/sync/other/bootstrap" })).toBeNull();
    expect(
      authorize({
        bearer: deriveAutomationReplicaBearer(row, { key: new Uint8Array(32).fill(8), namespace }),
      }),
    ).toBeNull();
    expect(
      authorize({
        bearer: deriveAutomationReplicaBearer({ ...row, incarnation: 2 }, { key, namespace }),
      }),
    ).toBeNull();
    // A service host credential for the same values never verifies here.
    const service = deriveServiceHostBearer(row, { key, namespace });
    expect(authorize({ bearer: service })).toBeNull();

    const handler = createServiceHostReplication({
      activity: new DiscussionActivityHub(),
      storage,
      prefix: "dohc-automation-v1.",
      authorize: (input) => authorizeAutomationReplication(storage, { key, namespace, ...input }),
    });
    const get = (path: string, token = bearer) =>
      handler(
        new Request(`https://relay.test${path}`, { headers: { authorization: `Bearer ${token}` } }),
      );
    expect((await get(`/sync/${WORKSPACE}/bootstrap`)).status).toBe(200);
    expect((await get("/sync/workspaces")).status).toBe(404);
    // A push checks the credential again inside its write.
    const push = await handler(
      new Request(`https://relay.test/sync/${WORKSPACE}/log`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          replicationEpoch: "epoch-1",
          streamIdentity: "stream-1",
          originId: "server-replica",
          ops: [
            {
              originSeq: 0,
              opKind: "moment.append",
              recordedAtMs: 10,
              payload: { operation: "write" },
            },
          ],
        }),
      }),
    );
    expect(push.status, await push.clone().text()).toBe(200);
    expect(await push.json()).toMatchObject({ inserted: 1 });
    // An automation replica retains the client author boundary, including native-shaped moments.
    let originSeq = 1;
    for (const author of [
      { kind: "human", humanId: "recipient", humanName: "Recipient" },
      { kind: "link", publicPrincipalId: "public-link", label: "Link editor" },
      { kind: "unattributed", humanId: "recipient" },
    ]) {
      const refused = await handler(
        new Request(`https://relay.test/sync/${WORKSPACE}/log`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({
            replicationEpoch: "epoch-1",
            streamIdentity: "stream-1",
            originId: "server-replica",
            ops: [
              {
                originSeq,
                opKind: "moment.append",
                recordedAtMs: 10,
                payload: { momentId: `moment-ydoc-${"a".repeat(64)}`, authors: [author] },
              },
            ],
          }),
        }),
      );
      expect(refused.status).toBe(200);
      expect(await refused.json()).toMatchObject({
        accepted: 1,
        inserted: 1,
        settlementRefusals: [
          { originSeq, settlementId: "unavailable", reason: "authorship-mismatch" },
        ],
      });
      const stored = storage.fetchLogCoordinate({
        workspaceId: WORKSPACE,
        originId: "server-replica",
        originSeq,
      })!;
      expect(stored.settlementAdmission).toMatchObject({ status: "refused" });
      expect(stored.admittedAuthorSnapshot).toBeUndefined();
      expect(JSON.parse(stored.payloadJson).authors).toBeUndefined();
      originSeq++;
    }
    const later = await handler(
      new Request(`https://relay.test/sync/${WORKSPACE}/log`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          replicationEpoch: "epoch-1",
          streamIdentity: "stream-1",
          originId: "server-replica",
          ops: [
            {
              originSeq,
              opKind: "moment.append",
              recordedAtMs: 11,
              payload: { operation: "write" },
            },
          ],
        }),
      }),
    );
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({
      accepted: 1,
      inserted: 1,
      currentMaxOriginSeq: originSeq,
    });
    // Waiting to leave, it reads but writes nothing.
    storage.unwantAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0 });
    expect(authorize({}), "a read").toBe("owner");
    expect(authorize({ pathname: `/sync/${WORKSPACE}/log`, method: "POST" }), "a push").toBeNull();
    expect(
      authorize({ pathname: `/sync/${WORKSPACE}/blobs/${"a".repeat(64)}`, method: "PUT" }),
      "a blob",
    ).toBeNull();
    storage.unwantAutomationWorkspace({
      workspaceId: WORKSPACE,
      nowMs: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS,
    });
    expect((await get(`/sync/${WORKSPACE}/bootstrap`)).status, "left").toBe(404);
  });
});

describe("the automation replicas", () => {
  type Sent = { method: string; params: Record<string, unknown>; workspace?: string };

  // An engine daemon that opens each workspace and answers ordinary replication.
  function fakeEngine() {
    const sent: Sent[] = [];
    let failPush: boolean | Error = false;
    let failingWorkspace: string | undefined;
    // What the engine answers for the phone's writes' receipts, by stage key. A key it doesn't hold is absent.
    let receipts: Map<string, unknown> | Error | (() => Promise<Map<string, unknown>>) = new Map();
    // Handles opened without a relay, as a read of a closed copy's folder opens them, and how many of their closes fail next.
    const folderHandles: string[] = [];
    let failFolderCloses = 0;
    // The copies' chats, which every engine the test starts shares.
    const chats = new ChatsLoopbackEngine();
    // Where the copy's folder holds each file, by object, and where a pull puts them next.
    const filePaths = new Map<string, string>();
    let pulledPaths: Map<string, string> | null = null;
    // Pull pages the relay holds for the copy beyond the one every pull answers, and the cursor each page moves to.
    let pullPages = 0;
    let pullCursor = 0;
    let pullGate: { reached(): void; open: Promise<void> } | null = null;
    const engines: Array<{
      exit(): void;
      close: ReturnType<typeof vi.fn>;
      waitForExit: ReturnType<typeof vi.fn>;
    }> = [];
    spawn.mockImplementation(
      async (spawned: {
        env?: Record<string, string>;
        onExit?: () => void;
        authToken?: string;
      }) => {
        expect(
          spawned.env?.DOHC_ENGINE_LIVE_HOST_CONFIG,
          "a plain engine, not the live host's",
        ).toBeUndefined();
        const configPath = spawned.env?.DOHC_ENGINE_OWNER_HOST_CONFIG;
        expect(configPath).toBeTypeOf("string");
        expect(JSON.parse(readFileSync(configPath!, "utf8"))).toHaveProperty(
          "ingress.aggregateBytes",
        );
        let handles = 0;
        const engine = {
          sendRequest: vi.fn(async (request: Sent) => {
            sent.push(request);
            if (
              request.method === "sync.push" &&
              failPush &&
              (!failingWorkspace || request.workspace === failingWorkspace)
            ) {
              throw failPush instanceof Error ? failPush : new Error("replica cannot push");
            }
            switch (request.method) {
              case "workspace.open": {
                const handle = `handle-${++handles}`;
                if (request.params.relay === undefined) folderHandles.push(handle);
                return { result: { workspace: handle } };
              }
              case "workspace.close":
                if (failFolderCloses > 0 && folderHandles.includes(request.workspace ?? "")) {
                  failFolderCloses -= 1;
                  throw new Error("the engine didn't answer the close");
                }
                return { result: {} };
              case "sync.adoptJoinIdentity":
                return { result: { adopted: true } };
              case "versions.ensureMain":
                return { result: { id: "main" } };
              case "sync.ordinary.publicationState": {
                if (receipts instanceof Error) throw receipts;
                const held = typeof receipts === "function" ? await receipts() : receipts;
                return {
                  result: {
                    stages: (request.params.stageKeys as string[]).map(
                      (stageKey) => held.get(stageKey) ?? { stageKey, state: "absent" },
                    ),
                  },
                };
              }
              case "sync.push":
                return {
                  result: {
                    status: "complete",
                    pushed: 0,
                    hasMore: false,
                    sharingDeclined: [],
                    ownerAdmissionPending: [],
                  },
                };
              case "sync.materializePendingCursor":
                return { result: { materialized: true } };
              case "sync.commitCursor":
                return { result: { committed: true, sharingDeclined: [] } };
              case "sync.fetchPull":
                if (pullGate !== null) {
                  pullGate.reached();
                  await pullGate.open;
                }
                return { result: { pageToken: "fetched" } };
              // The file adapter's requester checks that the answer names its request.
              case "files.resolve":
                return {
                  id: (request as Sent & { id: number }).id,
                  result: {
                    versionId: "main",
                    results: (request.params.targets as Array<{ objectId?: string }>).map(
                      (target) => {
                        const path =
                          target.objectId === undefined
                            ? undefined
                            : filePaths.get(target.objectId);
                        return path === undefined
                          ? { status: "absent" }
                          : { status: "found", objectId: target.objectId, path };
                      },
                    ),
                  },
                };
              case "sync.applyPull":
                for (const [objectId, path] of pulledPaths ?? []) filePaths.set(objectId, path);
                pulledPaths = null;
                if (pullPages > 0) pullPages -= 1;
                return {
                  result: {
                    status: "complete",
                    nextCursor: ++pullCursor,
                    pendingCursor: { kind: "relay", token: "t" },
                    hasMore: pullPages > 0,
                    fetched: 0,
                    applied: 0,
                    refused: 0,
                    skipped: 0,
                    conflictsOpened: 0,
                    refusals: [],
                    sharingDeclined: [],
                    changedPaths: [
                      {
                        versionId: "main",
                        path: "Tasks/automations.yaml",
                        operation: "write",
                        contentKind: "text",
                      },
                    ],
                  },
                };
              default:
                if (request.method.startsWith("chats."))
                  return await chats.sendRequest(request as unknown as Request);
                throw new Error(`unexpected ${request.method}`);
            }
          }),
          close: vi.fn(),
          waitForExit: vi.fn(async () => undefined),
          // As the real client keeps it, so a test can tell whether it reaches a log.
          connectOptions: { authToken: spawned.authToken },
        };
        engines.push({
          exit: () => spawned.onExit?.(),
          close: engine.close,
          waitForExit: engine.waitForExit,
        });
        return engine;
      },
    );
    return {
      sent,
      engines,
      failPush: (value: boolean | Error, workspace?: string) => {
        failPush = value;
        failingWorkspace = workspace;
      },
      receipts: (value: Map<string, unknown> | Error | (() => Promise<Map<string, unknown>>)) => {
        receipts = value;
      },
      folderHandles,
      failFolderCloses: (count: number) => {
        failFolderCloses = count;
      },
      chats,
      filePaths,
      /** The relay moved these files since the copy last pulled; its next pull brings them. */
      movedOnRelay: (paths: Map<string, string>) => {
        pulledPaths = paths;
      },
      /** The relay holds this many more pull pages for the copy than one pull answers. */
      backlog: (pages: number) => {
        pullPages = pages;
      },
      /** Holds the next pulls. `reached` resolves once one is waiting. */
      holdPulls: () => {
        let reached!: () => void, release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        pullGate = {
          reached,
          open: new Promise<void>((resolve) => {
            release = resolve;
          }),
        };
        return {
          reached: waiting,
          release: () => {
            pullGate = null;
            release();
          },
        };
      },
      methods: () => sent.map((request) => request.method),
    };
  }

  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function holdStartups() {
    const answer = spawn.getMockImplementation()!;
    let held: Promise<void> = Promise.resolve();
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      await held;
      return await answer(spawned);
    });
    return () => {
      const started = gate();
      held = started.promise;
      return started.resolve;
    };
  }

  // Fake time does not wait for a pass's file work, so a test waits for the pass's end.
  function passEnds() {
    const waiting: Array<() => void> = [];
    return {
      onReconciled: () => {
        for (const resolve of waiting.splice(0)) resolve();
      },
      next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    };
  }

  // One turn of the event loop: whatever only waited on promises has run.
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  // Errors no test expects: the test fails if one is reported before it ends.
  function unexpectedErrors() {
    const errors: unknown[] = [];
    cleanup.push(async () => {
      expect(errors).toEqual([]);
    });
    return (error: unknown) => {
      errors.push(error);
    };
  }

  async function start(
    storage: SyncRelayStorage,
    options: Partial<AutomationOptions> = {},
    closes = true,
  ) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted: () => [],
      onError: unexpectedErrors(),
      ...options,
    });
    cleanup.push(async () => {
      if (closes) await running.close();
      await rm(root, { recursive: true, force: true });
    });
    return running;
  }

  async function replicas(
    storage: SyncRelayStorage,
    wanted: () => string[],
    clock: { ms: number },
    onError: (error: unknown) => void = unexpectedErrors(),
    onPulled?: (workspaceId: string, paths: readonly string[]) => void,
  ) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const started = await startReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted,
      nowMs: () => clock.ms,
      onError,
      ...(onPulled ? { onPulled } : {}),
    });
    cleanup.push(async () => {
      await started.close();
      await rm(root, { recursive: true, force: true });
    });
    await started.settled();
    return { replicas: started, root };
  }

  it("does not recreate a copy after a restart between runtime and SQL deletion", async () => {
    const { storage } = await relay();
    fakeEngine();
    const { replicas: running, root } = await replicas(storage, () => [WORKSPACE], { ms: 0 });
    const deletedRoot = running.replica(WORKSPACE)!.root;
    const deletion = createAccountDeletionRoute({
      storage: storage as StorageContext,
      key: "bearer",
      fenceKey: "fence",
      invalidate() {},
      deleteRuntime: async () => running.deleteWorkspaces([WORKSPACE]),
      afterPhase(phase) {
        if (phase === "runtime") throw Error("crash after runtime");
      },
    });
    await expect(deletion.purge("owner", "owner@example.test")).rejects.toThrow(
      "crash after runtime",
    );
    expect(storage.listAutomationWorkspaces()).toHaveLength(1);
    expect(existsSync(deletedRoot)).toBe(false);
    await running.close();
    const path = storagePath(storage);
    closeTestStorage(storage);
    const restartedStorage = reopenTestStorage(path) as StorageContext;
    initializeAccountDeletion(restartedStorage, "fence");
    const restarted = await startReplicas({
      storage: restartedStorage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted: () => [WORKSPACE],
      onError: unexpectedErrors(),
    });
    cleanup.push(() => restarted.close());
    await restarted.settled();
    expect(restarted.replica(WORKSPACE)).toBeUndefined();
    expect(existsSync(deletedRoot)).toBe(false);
    const resume = createAccountDeletionRoute({
      storage: restartedStorage,
      key: "bearer",
      fenceKey: "fence",
      invalidate() {},
      deleteRuntime: async () => {
        throw Error("runtime must not repeat");
      },
    });
    await resume.purge("owner", "owner@example.test");
    expect(restartedStorage.listAutomationWorkspaces()).toEqual([]);
  });

  it("retries a lease-deferred collection reconciliation without advancing pulledHead or another relay write", async () => {
    const { storage, log } = await relay();
    const engine = fakeEngine();
    let held = false;
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (options: Parameters<typeof answer>[0]) => {
      const client = await answer(options);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "sync.commitCursor" && held) {
          engine.sent.push(request);
          throw Object.assign(new Error("collection reconciliation waits for a document lease"), {
            code: "OVERLOADED",
            retry: "afterBackoff",
          });
        }
        return send(request);
      });
      return client;
    });
    const { replicas: running } = await replicas(storage, () => [WORKSPACE], { ms: 0 });
    const replica = running.replica(WORKSPACE)!;
    const before = replica.pulledHead;
    held = true;
    log(2);
    await expect(replica.sync()).rejects.toMatchObject({ code: "OVERLOADED" });
    expect(replica.pulledHead).toBe(before);
    expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    const pulls = engine.methods().filter((method) => method === "sync.applyPull").length;
    held = false;
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.applyPull").length).toBeGreaterThan(
      pulls,
    );
    expect(replica.pulledHead).toBe(storage.automationWorkspaceLogHead(WORKSPACE));
    expect(running.failedSyncs().size).toBe(0);
  });

  it("syncs healthy relay writes and retention deadlines without retrying a failing step early", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    cleanup.push(async () => {
      vi.useRealTimers();
    });
    const { storage, raw, log } = await relay();
    for (const workspaceId of ["healthy", "leaving"]) {
      storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
      storage.claimWorkspaceIdentity({
        workspaceId,
        replicationEpoch: "epoch-1",
        streamIdentity: "stream-1",
      });
      storage.joinAutomationWorkspace({ workspaceId, nowMs: 0, reasons: ["automation"] });
    }
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: 0, reasons: ["automation"] });
    const engine = fakeEngine();
    const passes = passEnds();
    const errors: unknown[] = [];
    const steps: Array<[string, number]> = [];
    const running = await start(storage, {
      wanted: () => [WORKSPACE, "healthy"],
      nowMs: () => AUTOMATION_WORKSPACE_LEAVE_AFTER_MS - 1_000 + Date.now(),
      onReconciled: passes.onReconciled,
      onError: (error) => errors.push(error),
      onBeforeSync: async (workspaceId) => {
        steps.push([workspaceId, Date.now()]);
      },
    });
    const opened = passes.next();
    await vi.advanceTimersByTimeAsync(0);
    await opened;
    steps.length = 0;
    engine.failPush(true, running.replica(WORKSPACE)!.workspace);
    log(1);
    notifyRelayWrite(storage);
    const failed = passes.next();
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    // Writes to either workspace wake promptly, but never shorten the failed step's delay.
    for (let seq = 2; seq <= 4; seq++) {
      raw
        .prepare(
          "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES ('healthy', 'desk', ?, 'moment.append', '{}', 1)",
        )
        .run(seq);
      log(seq);
      notifyRelayWrite(storage);
      const written = passes.next();
      await vi.advanceTimersByTimeAsync(100);
      await written;
      expect(steps.filter(([id]) => id === "healthy")).toHaveLength(seq - 1);
      expect(steps.filter(([id]) => id === WORKSPACE)).toEqual([[WORKSPACE, 100]]);
      expect(running.failedSyncs().has(WORKSPACE)).toBe(true);
    }
    expect(steps.filter(([id]) => id === "healthy")).toEqual([
      ["healthy", 200],
      ["healthy", 300],
      ["healthy", 400],
    ]);
    const leaving = passes.next();
    await vi.advanceTimersByTimeAsync(600);
    // The deadline queues a pass whose zero-delay timer runs on the next tick.
    await vi.advanceTimersByTimeAsync(1);
    await leaving;
    expect(storage.currentAutomationWorkspace("leaving")).toBeNull();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_098);
    expect(steps.filter(([id]) => id === WORKSPACE)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(steps.filter(([id]) => id === WORKSPACE)).toEqual([
      [WORKSPACE, 100],
      [WORKSPACE, 2_100],
    ]);
    expect(errors).toHaveLength(2);
  });

  it("opens a replica for each wanted workspace, joins its identity, and pulls when its log moves", async () => {
    const { storage, log } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 5 };
    const pulled: Array<[string, readonly string[]]> = [];
    const { replicas: running } = await replicas(
      storage,
      () => [WORKSPACE],
      clock,
      undefined,
      (workspaceId, paths) => pulled.push([workspaceId, paths]),
    );
    const replica = running.replica(WORKSPACE)!;
    expect(replica).toMatchObject({
      workspaceId: WORKSPACE,
      ownerUserId: "owner",
      incarnation: 1,
      startedAtMs: 5,
      workspace: "handle-1",
    });
    expect(pulled, "the executor hears which files a pull wrote").toEqual([
      [WORKSPACE, ["Tasks/automations.yaml"]],
    ]);
    const open = engine.sent.find((request) => request.method === "workspace.open")!;
    expect(open.params).toMatchObject({
      workspaceId: WORKSPACE,
      captureMode: "none",
      reconcileCollections: true,
      rootDir: replica.root,
      relay: {
        baseUrl: "https://relay.example",
        bearerToken: deriveAutomationReplicaBearer(storage.currentAutomationWorkspace(WORKSPACE)!, {
          key,
          namespace,
        }),
      },
    });
    expect(replica.metadataDir.startsWith(replica.root)).toBe(false);
    expect(engine.methods()).toEqual([
      "workspace.open",
      "chats.readState.seedAccount",
      "versions.ensureMain",
      "sync.adoptJoinIdentity",
      "sync.push",
      "sync.fetchPull",
      "sync.applyPull",
      "sync.materializePendingCursor",
      "sync.commitCursor",
    ]);
    expect(
      engine.sent.find((request) => request.method === "chats.readState.seedAccount")?.params,
      "a server copy seeds no local count",
    ).toEqual({ accountUserId: "owner", seedLocal: false });

    // Nothing changed at the relay: a pass pulls nothing.
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.applyPull")).toHaveLength(1);
    log(1);
    running.reconcile();
    await running.settled();
    expect(engine.methods().filter((method) => method === "sync.applyPull")).toHaveLength(2);
  });

  it("closes a replica whose workspace was deleted, and removes every folder no row names", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    let wanted = [WORKSPACE];
    const { replicas: running, root } = await replicas(storage, () => wanted, { ms: 0 });
    const replica = running.replica(WORKSPACE)!;
    await mkdir(join(root, "0".repeat(64)));
    // Deleting the workspace deletes its host record and replica row with it.
    raw.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run(WORKSPACE);
    wanted = [];
    running.reconcile();
    await running.settled();
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(replica.signal.aborted).toBe(true);
    expect(engine.methods()).toContain("workspace.close");
    expect(readdirSync(root).filter((entry) => !entry.startsWith("owner-ingress-"))).toEqual([]);
  });

  // Copies an owner's account reads, beside those automations keep.
  async function copies(
    storage: SyncRelayStorage,
    wanted: () => ReadonlyMap<string, readonly CopyReason[]>,
    clock: { ms: number },
    onChanged?: (workspaceId: string) => void,
  ) {
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const started = await startAutomationReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted,
      nowMs: () => clock.ms,
      onError: unexpectedErrors(),
      ...(onChanged ? { onChanged } : {}),
    });
    cleanup.push(async () => {
      await started.close();
      await rm(root, { recursive: true, force: true });
    });
    await started.settled();
    return { replicas: started, root };
  }
  const folders = (root: string) =>
    readdirSync(root).filter((entry) => /^[0-9a-f]{64}$/u.test(entry));

  it("closes an account copy as soon as nothing wants it, and removes its folder and row when it leaves", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { replicas: running, root } = await copies(storage, () => wanted, clock);
    expect(running.replica(WORKSPACE)?.reasons).toEqual(["account"]);
    wanted = new Map();
    running.reconcile();
    await running.settled();
    expect(running.replica(WORKSPACE), "an idle account copy holds no engine").toBeUndefined();
    expect(engine.methods()).toContain("workspace.close");
    expect(folders(root), "its folder stays a day, so the next visit only catches up").toHaveLength(
      1,
    );
    wanted = new Map([[WORKSPACE, ["account"]]]);
    running.reconcile();
    await running.settled();
    expect(running.replica(WORKSPACE)).toBeDefined();
    wanted = new Map();
    running.reconcile();
    await running.settled();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    running.reconcile();
    await running.settled();
    expect(folders(root), "no hold for run history").toEqual([]);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("keeps the 30-day hold of copies a relay made before copies had reasons", async () => {
    const { storage, raw } = await relay();
    storage.claimWorkspace({ workspaceId: "ledger", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({
      workspaceId: "ledger",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    fakeEngine();
    const clock = { ms: 0 };
    let wanted = [WORKSPACE, "ledger"];
    const { replicas: before, root } = await replicas(storage, () => wanted, clock);
    // The workspace's automations moved to a computer: its copy leaves, and is retained.
    wanted = ["ledger"];
    before.reconcile();
    await before.settled();
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS;
    before.reconcile();
    await before.settled();
    await before.close();
    expect(folders(root)).toHaveLength(2);
    const path = storagePath(storage);
    closeTestStorage(storage);
    // The store as the previous schema left it: the rows, and no reasons.
    raw.exec("DROP TABLE sync_relay_automation_workspace_reasons");
    expect(
      raw
        .prepare(
          "SELECT workspace_id, left_at_ms FROM sync_relay_automation_workspaces ORDER BY workspace_id",
        )
        .all(),
    ).toEqual([
      { workspace_id: "ledger", left_at_ms: null },
      { workspace_id: WORKSPACE, left_at_ms: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS },
    ]);

    const upgraded = reopenTestStorage(path);
    expect(
      upgraded.listAutomationWorkspaces().map((row) => [row.workspaceId, row.reasons]),
    ).toEqual([
      ["ledger", ["automation"]],
      [WORKSPACE, ["automation"]],
    ]);
    clock.ms = AUTOMATION_WORKSPACE_LEAVE_AFTER_MS + AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS - 1;
    const after = await start(upgraded, { root, wanted: () => ["ledger"], nowMs: () => clock.ms });
    await after.settled();
    expect(folders(root), "the retired copy keeps its hold").toHaveLength(2);
    expect(upgraded.listAutomationWorkspaces()).toHaveLength(2);
    clock.ms += 1;
    after.reconcile();
    await after.settled();
    expect(upgraded.listAutomationWorkspaces().map((row) => row.workspaceId)).toEqual(["ledger"]);
    expect(folders(root)).toHaveLength(1);
  });

  it("replaces a replica whose workspace identity changed, and reopens every replica after its engine exits", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 1 };
    const { replicas: running } = await replicas(storage, () => [WORKSPACE], clock);
    const first = running.replica(WORKSPACE)!;
    storage.rotateWorkspaceIdentity({
      workspaceId: WORKSPACE,
      ownerUserId: "owner",
      replicationEpoch: "epoch-2",
      streamIdentity: "stream-2",
      rotatedAtMs: 2,
    });
    running.reconcile();
    await running.settled();
    const second = running.replica(WORKSPACE)!;
    expect(first.signal.aborted).toBe(true);
    expect(second).toMatchObject({ incarnation: 2 });
    expect(existsSync(first.root), "the old incarnation's replica goes").toBe(false);

    engine.engines[0]!.exit();
    expect(second.signal.aborted).toBe(true);
    await running.settled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(running.replica(WORKSPACE)).toMatchObject({ incarnation: 2, workspace: "handle-1" });
  });

  it("closes a replica that never opened fully, and tries again later", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const errors: unknown[] = [];
    const failing = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: never) => {
      const client = await failing(spawned);
      const answer = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) =>
        request.method === "sync.adoptJoinIdentity"
          ? (engine.sent.push(request), { result: { adopted: false } })
          : answer(request),
      );
      return client;
    });
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted: () => [WORKSPACE],
      onError: (error) => errors.push(error),
    });
    cleanup.push(async () => {
      await running.close();
      await rm(root, { recursive: true, force: true });
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: WAIT_TIMEOUT_MS });
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(engine.methods().slice(0, 5)).toEqual([
      "workspace.open",
      "chats.readState.seedAccount",
      "versions.ensureMain",
      "sync.adoptJoinIdentity",
      "workspace.close",
    ]);
  });

  it("keeps opening, pulling, and letting go of the others while one workspace always fails", async () => {
    // Only the timers are fake: each pass still does real file work, and the test waits for it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => {
      vi.useRealTimers();
    });
    const { storage, log } = await relay();
    for (const workspaceId of ["broken", "leaving"]) {
      storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
      storage.claimWorkspaceIdentity({
        workspaceId,
        replicationEpoch: "epoch-1",
        streamIdentity: "stream-1",
      });
    }
    const engine = fakeEngine();
    // The engine refuses every open of one workspace.
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        if (request.method === "workspace.open" && request.params.workspaceId === "broken") {
          engine.sent.push(request);
          throw new Error("the engine refused this workspace");
        }
        return await send(request);
      });
      return client;
    });
    // "leaving" has not been wanted for a day.
    storage.joinAutomationWorkspace({ workspaceId: "leaving", nowMs: 0, reasons: ["automation"] });
    storage.unwantAutomationWorkspace({ workspaceId: "leaving", nowMs: 0 });
    const clock = { ms: AUTOMATION_WORKSPACE_LEAVE_AFTER_MS };
    const errors: Array<[unknown, string | undefined]> = [];
    let passes = 0;
    const waiting: Array<() => void> = [];
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted: () => ["broken", WORKSPACE],
      nowMs: () => clock.ms,
      onError: (error, workspaceId) => errors.push([error, workspaceId]),
      onReconciled: () => {
        passes += 1;
        for (const resolve of waiting.splice(0)) resolve();
      },
    });
    cleanup.push(async () => {
      await running.close();
      await rm(root, { recursive: true, force: true });
    });
    const nextPass = () => new Promise<void>((resolve) => waiting.push(resolve));
    const first = nextPass();
    await vi.advanceTimersByTimeAsync(0);
    await first;

    expect(running.replica(WORKSPACE), "the workspace after the broken one opens").toBeDefined();
    expect(running.replica("broken")).toBeUndefined();
    expect([...running.failedSyncs().keys()]).toEqual(["broken"]);
    expect(running.unavailable, "a completed pass keeps the server on").toBe(false);
    expect(errors.map(([, workspaceId]) => workspaceId)).toEqual(["broken"]);
    expect(
      storage.listAutomationWorkspaces().find((row) => row.workspaceId === "leaving")?.leftAtMs,
      "an unwanted copy still leaves on time",
    ).toBe(AUTOMATION_WORKSPACE_LEAVE_AFTER_MS);

    // A write to the good workspace still pulls it, and the broken one keeps being tried.
    const pulls = () =>
      engine.sent.filter(
        (request) =>
          request.method === "sync.applyPull" &&
          request.workspace === running.replica(WORKSPACE)!.workspace,
      ).length;
    // The first pass's joins asked for one more; after it only the broken one's retry is left.
    const second = nextPass();
    await vi.advanceTimersByTimeAsync(100);
    await second;
    // The pass ends, and arms the broken one's retry, a tick after it reports.
    await vi.advanceTimersByTimeAsync(0);
    const before = pulls();
    log(1);
    const asked = nextPass();
    running.reconcile();
    await vi.advanceTimersByTimeAsync(100);
    await asked;
    expect(pulls()).toBe(before + 1);
    expect(running.failedSyncs().has("broken")).toBe(true);
    expect(passes).toBeGreaterThanOrEqual(1);
  });

  it("pulls a busy workspace a bounded amount per pass, so the next one is pulled too", async () => {
    const { storage } = await relay();
    storage.claimWorkspace({ workspaceId: "busy", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({
      workspaceId: "busy",
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
    });
    const engine = fakeEngine();
    // The busy workspace's pulls always have more.
    const answer = spawn.getMockImplementation()!;
    let busyHandle: string | undefined;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      const send = client.sendRequest.getMockImplementation()!;
      client.sendRequest.mockImplementation(async (request: Sent) => {
        const result = (await send(request)) as { result: Record<string, unknown> };
        if (request.method === "workspace.open" && request.params.workspaceId === "busy")
          busyHandle = result.result.workspace as string;
        if (
          request.method === "sync.applyPull" &&
          request.workspace === busyHandle &&
          busyHandle !== undefined &&
          opened
        ) {
          return { result: { ...result.result, hasMore: true, nextCursor: ++cursor } };
        }
        return result;
      });
      return client;
    });
    // Its pulls have more from the start, even while it first opens.
    let opened = true,
      cursor = 1;
    const clock = { ms: 5 };
    const root = await mkdtemp(join(tmpdir(), "automation-replicas-"));
    const running = await startReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted: () => ["busy", WORKSPACE],
      nowMs: () => clock.ms,
      onError: unexpectedErrors(),
    });
    cleanup.push(async () => {
      await running.close();
      await rm(root, { recursive: true, force: true });
    });
    // The busy one never catches up, and the quiet one still opens.
    await vi.waitFor(() => expect(running.replica(WORKSPACE)).toBeDefined(), {
      timeout: WAIT_TIMEOUT_MS,
    });
    const pulls = (handle: string) =>
      engine.sent.filter(
        (request) => request.method === "sync.applyPull" && request.workspace === handle,
      ).length;
    const busy = running.replica("busy")!,
      quiet = running.replica(WORKSPACE)!;
    const [busyBefore, quietBefore] = [pulls(busy.workspace), pulls(quiet.workspace)];
    const raw = inspectDatabase(storagePath(storage));
    for (const workspaceId of ["busy", WORKSPACE]) {
      raw
        .prepare(
          "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'desk', 1, 'moment.append', '{}', 1)",
        )
        .run(workspaceId);
    }
    raw.close();
    running.reconcile();
    await vi.waitFor(
      () => expect(pulls(quiet.workspace), "the quiet workspace is pulled").toBe(quietBefore + 1),
      { timeout: WAIT_TIMEOUT_MS },
    );
    // At most four rounds of eight pages for the busy one before the quiet one.
    expect(pulls(busy.workspace) - busyBefore).toBeLessThanOrEqual(32);
    expect(pulls(busy.workspace) - busyBefore).toBeGreaterThan(0);
  });

  it("closes only after an engine start and exit that ignore its abort, and every close waits for them", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const exited = gate();
    const answer = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (spawned: Parameters<typeof answer>[0]) => {
      const client = await answer(spawned);
      client.waitForExit.mockImplementation(() => exited.promise);
      return client;
    });
    const started = holdStartups()();
    const running = await start(storage);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: WAIT_TIMEOUT_MS });
    const first = running.close(),
      second = running.close();
    expect(second).toBe(first);
    expect(
      (spawn.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted,
      "it aborts at once",
    ).toBe(true);
    let closed = false;
    void second.then(() => {
      closed = true;
    });
    await turn();
    expect(closed, "the engine is still starting").toBe(false);
    started();
    await vi.waitFor(() => expect(engine.engines[0]?.close).toHaveBeenCalled(), {
      timeout: WAIT_TIMEOUT_MS,
    });
    await turn();
    expect(closed, "the engine has not exited").toBe(false);
    exited.resolve();
    await first;
    expect(closed).toBe(true);
  });

  // A phone write the owner's account recorded on the copy, sending one message.
  function phoneWrite(storage: SyncRelayStorage, id: string) {
    const command: PublicationCommand = {
      stages: [
        {
          key: `${id}:send`,
          role: "post",
          records: [{ kind: "chat.message.append", fields: { messageId: id } }],
        },
      ],
    };
    const claim = storage.recordAccountOperation({
      accountId: "owner",
      operationId: id,
      binding: { workspaceId: WORKSPACE, operation: "send", args: { id } },
      incarnation: 1,
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
      command,
      writesMessage: true,
      nowMs: 0,
    });
    if (claim.kind !== "recorded") throw new Error(`expected a new record, got ${claim.kind}`);
  }
  // The receipt of a write's one stage, whose message the copy journaled at `originSeq`.
  const receipt = (
    id: string,
    originSeq: number,
    state: "pushed" | "pending" = "pushed",
  ): [string, unknown] => [
    `${id}:send`,
    {
      stageKey: `${id}:send`,
      state: "present",
      outcome: "written",
      threadId: "thread",
      coordinates: [{ originId: "copy", originSeq, state }],
    },
  ];
  // The relay accepted the message at the copy's coordinate.
  const accept = (raw: ReturnType<typeof inspectDatabase>, id: string, originSeq: number) =>
    raw
      .prepare(
        "INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES (?, 'copy', ?, 'chat.message.append', ?, 1)",
      )
      .run(WORKSPACE, originSeq, JSON.stringify({ messageId: id, threadId: "thread" }));
  const outcome = (raw: ReturnType<typeof inspectDatabase>, id: string) => {
    const row = raw
      .prepare(
        "SELECT stage, message_state, result_json FROM sync_relay_account_operations WHERE operation_id = ?",
      )
      .get(id);
    return [
      row?.stage,
      row?.message_state,
      row?.result_json == null ? null : JSON.parse(String(row?.result_json)),
    ];
  };
  const publishing = (storage: SyncRelayStorage) => () =>
    new Map(
      storage
        .publishingCopies()
        .map((copy): [string, readonly CopyReason[]] => [copy.workspaceId, ["publication"]]),
    );
  const count = (engine: ReturnType<typeof fakeEngine>, method: string) =>
    engine.methods().filter((sent) => sent === method).length;
  /**
   * Copies whose passes run only as the test moves fake time. `pass` asks
   * for one, as a write or an owner's action does, moves time past the
   * delay a pass waits, and resolves once that pass ended. Nothing else
   * moves time, so no retry or deadline fires unless a test advances to it.
   */
  async function stepped(
    storage: SyncRelayStorage,
    wanted: () => ReadonlyMap<string, readonly CopyReason[]>,
    options: {
      clock?: { ms: number };
      root?: string;
      onError?: (error: unknown, workspaceId?: string) => void;
    } = {},
  ) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(async () => {
      vi.useRealTimers();
    });
    const root = options.root ?? (await mkdtemp(join(tmpdir(), "automation-replicas-")));
    const clock = options.clock ?? { ms: 0 };
    const passes = passEnds();
    const first = passes.next();
    const report: (error: unknown, workspaceId?: string) => void =
      options.onError ?? unexpectedErrors();
    const running = await startAutomationReplicas({
      storage,
      root,
      engineExecutable: process.execPath,
      relayOrigin: "https://relay.example",
      key,
      namespace,
      wanted,
      nowMs: () => clock.ms,
      onReconciled: passes.onReconciled,
      onError: (error, workspaceId) => {
        report(error, workspaceId);
        if (workspaceId === undefined) passes.onReconciled();
      },
    });
    cleanup.push(async () => {
      await running.close();
      await rm(root, { recursive: true, force: true });
    });
    // The first pass is asked for at once.
    await vi.advanceTimersByTimeAsync(0);
    await first;
    // `waitMs` is how long the pass waits: 100 ms once asked for, or a failed pass's delay.
    const pass = async (workspaceId?: string, waitMs = 100) => {
      const ended = passes.next();
      running.reconcile(workspaceId);
      await vi.advanceTimersByTimeAsync(waitMs);
      await ended;
    };
    return { running, root, pass };
  }
  // An account visit opens the copy, so its folder exists, as a write needs.
  // Once the visit ends, only the copy's unsent writes keep it.
  async function visitedThenPublishing(storage: SyncRelayStorage, clock: { ms: number }) {
    let wanted = (): ReadonlyMap<string, readonly CopyReason[]> =>
      new Map([[WORKSPACE, ["account"]]]);
    const opened = await stepped(storage, () => wanted(), { clock });
    expect(opened.running.replica(WORKSPACE)).toBeDefined();
    return {
      ...opened,
      wantPublishing: () => {
        wanted = publishing(storage);
      },
    };
  }

  it("closes a retiring copy before reading its phone writes' receipts from the folder, and saves one whose push answer was lost", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const { running, root, pass } = await stepped(storage, () => wanted);
    phoneWrite(storage, "lost");
    phoneWrite(storage, "unwritten");
    // The relay holds the message, but the copy never heard its push answered.
    accept(raw, "lost", 1);
    engine.receipts(new Map([receipt("lost", 1, "pending")]));
    await pass();
    expect(outcome(raw, "lost")[0], "the copy waits to see its push").toBe("recorded");
    // "Show on phone" goes off, so the writes no longer keep the copy, and it retires.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    wanted = new Map();
    const handle = running.replica(WORKSPACE)!.workspace;
    const before = engine.sent.length;
    await pass();
    const sentAfter = engine.sent.slice(before);
    const after = sentAfter.map((request) => request.method);
    const closedAt = after.indexOf("workspace.close");
    expect(closedAt, "the copy closed").toBeGreaterThanOrEqual(0);
    expect(sentAfter[closedAt]?.workspace, "the close is the copy's own").toBe(handle);
    expect(closedAt, "closed before its receipts are read").toBeLessThan(
      after.indexOf("sync.ordinary.publicationState"),
    );
    expect(after.slice(closedAt + 1)).not.toContain("sync.push");
    expect([outcome(raw, "lost"), outcome(raw, "unwritten")]).toEqual([
      ["saved", "published", { threadId: "thread" }],
      ["refused", "pending", { threadId: null, reason: "Couldn't send" }],
    ]);
    expect(folders(root)).toEqual([]);
    expect(storage.listAutomationWorkspaces()).toEqual([]);

    // Showing the workspace again makes a new copy, which replays nothing.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: true });
    const reads = count(engine, "sync.ordinary.publicationState");
    wanted = new Map([[WORKSPACE, ["account"]]]);
    await pass();
    expect(running.replica(WORKSPACE)).toMatchObject({ incarnation: 1 });
    expect(count(engine, "sync.ordinary.publicationState")).toBe(reads);
  });

  // A copy that retired with an unsent write: settlement read its folder and refused the write, and the
  // read's close failed, so the folder stayed. The sentinel shows whether a later copy reuses that folder.
  async function refusedBehindFailedClose(
    storage: SyncRelayStorage,
    raw: ReturnType<typeof inspectDatabase>,
    engine: ReturnType<typeof fakeEngine>,
  ) {
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const errors: unknown[] = [];
    const copy = await stepped(storage, () => wanted, { onError: (error) => errors.push(error) });
    const home = join(copy.running.replica(WORKSPACE)!.root, "..");
    const sentinel = join(home, "workspace", "sentinel");
    await writeFile(sentinel, "");
    phoneWrite(storage, "unsent");
    engine.receipts(new Map([receipt("unsent", 1, "pending")]));
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    wanted = new Map();
    engine.failFolderCloses(1);
    await copy.pass();
    expect(outcome(raw, "unsent")).toEqual([
      "refused",
      "pending",
      { threadId: "thread", reason: "Couldn't send" },
    ]);
    expect(existsSync(sentinel), "the folder stays while its read's handle is open").toBe(true);
    expect(existsSync(join(home, "settled")), "marked settled").toBe(true);
    expect(errors).toHaveLength(1);
    // An account visit wants the copy again.
    return {
      ...copy,
      home,
      sentinel,
      wantAgain: () => {
        wanted = new Map([[WORKSPACE, ["account"]]]);
      },
    };
  }
  // Whether the copy open now is a fresh one: the settled folder, with its unsent records, is gone, and the write stays refused.
  function freshCopy(
    running: { replica(workspaceId: string): unknown },
    raw: ReturnType<typeof inspectDatabase>,
    sentinel: string,
  ) {
    expect(running.replica(WORKSPACE), "the visit has a copy").toBeDefined();
    expect(existsSync(sentinel), "not the settled folder").toBe(false);
    expect(outcome(raw, "unsent")[0], "the refused write stays refused").toBe("refused");
  }

  it("never reopens a settled folder whose removal failed partway, and removes what it left later", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { running, pass, home, sentinel, wantAgain } = await refusedBehindFailedClose(
      storage,
      raw,
      engine,
    );
    const folder = join(home, "..");
    const relayOpens = () =>
      engine.sent.filter(
        (request) => request.method === "workspace.open" && request.params.relay !== undefined,
      ).length;
    const opens = relayOpens();
    // The visit's pass removes the settled folder, and the removal deletes the marker, then fails.
    stuck.path = home;
    stuck.renamed = true;
    stuck.partly = true;
    cleanup.push(async () => {
      stuck.path = null;
      stuck.renamed = false;
      stuck.partly = false;
    });
    wantAgain();
    await pass(WORKSPACE);
    expect(relayOpens(), "nothing opened for sync").toBe(opens);
    expect(running.replica(WORKSPACE)).toBeUndefined();
    expect(existsSync(home), "the settled folder is no incarnation's any more").toBe(false);
    const [leftover] = readdirSync(folder).filter((entry) => entry.startsWith("1.discarded-"));
    expect(leftover, "what the failed removal left").toBeDefined();
    expect(existsSync(join(folder, leftover!, "settled")), "its marker went first").toBe(false);
    expect(existsSync(join(folder, leftover!, "workspace", "sentinel"))).toBe(true);

    // A retry whose removal fails again removes the leftover in place: renaming it again would lengthen its name each time.
    await pass(WORKSPACE);
    expect(
      readdirSync(folder).filter((entry) => entry.includes(".discarded-")),
      "the leftover kept its name",
    ).toEqual([leftover]);

    // The removal works again; the retry opens a fresh copy and removes the leftover.
    stuck.path = null;
    await pass(WORKSPACE);
    freshCopy(running, raw, sentinel);
    expect(relayOpens()).toBe(opens + 1);
    expect(readdirSync(folder), "only the fresh incarnation").toEqual(["1"]);
  });

  // An account's deletion, as main.ts runs it, over the copies, and the folder of the copy of WORKSPACE.
  async function deletingAccount(storage: SyncRelayStorage) {
    const errors: Array<[unknown, string | undefined]> = [];
    const { running } = await stepped(storage, () => automation([WORKSPACE]), {
      onError: (error, workspaceId) => errors.push([error, workspaceId]),
    });
    const folder = join(running.replica(WORKSPACE)!.root, "..", "..");
    cleanup.push(async () => {
      stuck.path = null;
      stuck.renamed = false;
      stuck.partly = false;
    });
    let runtimeDone = false;
    const deletion = createAccountDeletionRoute({
      storage: storage as StorageContext,
      key: "bearer",
      fenceKey: "fence",
      invalidate() {},
      deleteRuntime: async () => running.deleteWorkspaces([WORKSPACE]),
      afterPhase(phase) {
        if (phase === "runtime") runtimeDone = true;
      },
    });
    return { running, folder, errors, deletion, runtimeDone: () => runtimeDone };
  }
  const operationRows = (raw: ReturnType<typeof inspectDatabase>) =>
    raw.prepare("SELECT count(*) AS n FROM sync_relay_account_operations").get();

  it("keeps an account's deletion pending while its copy's folder can't be removed, and finishes once it can", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const { folder, deletion, runtimeDone } = await deletingAccount(storage);
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    engine.receipts(new Map([receipt("sent", 1)]));
    stuck.path = folder;
    await expect(deletion.purge("owner", "owner@example.test")).rejects.toThrow(
      "the folder is busy",
    );
    expect(runtimeDone(), "the deletion stays in its fenced phase").toBe(false);
    expect(existsSync(folder)).toBe(true);
    expect(outcome(raw, "sent"), "its writes settled before the folder was to go").toEqual([
      "saved",
      "published",
      { threadId: "thread" },
    ]);

    stuck.path = null;
    await deletion.purge("owner", "owner@example.test");
    expect(runtimeDone()).toBe(true);
    expect(existsSync(folder)).toBe(false);
    expect(operationRows(raw)).toEqual({ n: 0 });
  });

  it("refuses the phone's writes in a copy whose folder was lost, and replays none of them in its new folder", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const {
      running: first,
      root,
      pass,
    } = await stepped(storage, () => automation([WORKSPACE]), { clock: { ms: 1 } });
    phoneWrite(storage, "lost");
    await pass();
    await first.close();
    await rm(join(root, folders(root)[0]!), { recursive: true, force: true });
    const reads = count(engine, "sync.ordinary.publicationState");
    const { running: restarted } = await stepped(storage, () => automation([WORKSPACE]), {
      root,
      clock: { ms: 2 },
    });
    expect(outcome(raw, "lost")).toEqual([
      "refused",
      "pending",
      { threadId: null, reason: "Couldn't send" },
    ]);
    expect(
      count(engine, "sync.ordinary.publicationState"),
      "no folder, so no receipt to read",
    ).toBe(reads);
    expect(restarted.replica(WORKSPACE)).toMatchObject({ incarnation: 1 });
  });

  it("settles the phone's writes before removing every copy when copies are off, and keeps one whose receipts can't be read", async () => {
    const { storage, raw } = await relay();
    storage.claimWorkspace({ workspaceId: "ledger", ownerUserId: "owner", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({
      workspaceId: "ledger",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    const engine = fakeEngine();
    const { running, root, pass } = await stepped(storage, () => automation([WORKSPACE, "ledger"]));
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    phoneWrite(storage, "sent");
    accept(raw, "sent", 1);
    await pass();
    await running.close();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(async () => {
      logged.mockRestore();
    });
    const settle = { namespace, engineExecutable: process.execPath };
    engine.receipts(new Error("the engine is busy"));
    await removeAutomationReplicas(storage, root, settle);
    expect(storage.listAutomationWorkspaces().map((row) => row.workspaceId)).toEqual([WORKSPACE]);
    expect(folders(root)).toHaveLength(1);
    expect(outcome(raw, "sent")[0]).toBe("recorded");
    expect(logged).toHaveBeenCalled();

    engine.receipts(new Map([receipt("sent", 1)]));
    await removeAutomationReplicas(storage, root, settle);
    expect(outcome(raw, "sent")).toEqual(["saved", "published", { threadId: "thread" }]);
    expect(existsSync(root)).toBe(false);
    expect(storage.listAutomationWorkspaces()).toEqual([]);
  });

  it("keeps publishing a copy's phone writes when nothing new reaches the relay, stalls them past their active time, and saves them later", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    const { running, pass, wantPublishing } = await visitedThenPublishing(storage, clock);
    // The visit's write stays to publish once the visit ends.
    phoneWrite(storage, "sent");
    engine.receipts(new Map([receipt("sent", 1, "pending")]));
    wantPublishing();
    await pass();
    expect(running.replica(WORKSPACE)?.reasons).toEqual(["account", "publication"]);
    const reads = count(engine, "sync.ordinary.publicationState"),
      pushes = count(engine, "sync.push");
    expect(reads).toBeGreaterThan(0);
    // The relay's head doesn't move, and the copy still pushes and looks again.
    await pass(WORKSPACE);
    expect(count(engine, "sync.ordinary.publicationState")).toBeGreaterThan(reads);
    expect(count(engine, "sync.push")).toBeGreaterThan(pushes);
    expect(outcome(raw, "sent")[0]).toBe("recorded");

    clock.ms = OPERATION_ACTIVE_MS;
    await pass(WORKSPACE);
    expect(outcome(raw, "sent")[0]).toBe("stalled");
    expect(running.replica(WORKSPACE), "a stalled write still keeps its copy").toBeDefined();

    engine.receipts(new Map([receipt("sent", 1)]));
    accept(raw, "sent", 1);
    await pass(WORKSPACE);
    expect(outcome(raw, "sent")).toEqual(["saved", "published", { threadId: "thread" }]);
    // The next pass gives back the reason the saved write held.
    await pass();
    expect(
      storage.listAutomationWorkspaces()[0]?.reasons,
      "saved, it keeps the copy no more",
    ).toEqual(["account"]);
  });

  it("replays a phone write's stage that never committed from its stored command when the server restarts, before the copy pushes", async () => {
    const { storage } = await relay();
    const engine = fakeEngine();
    const wanted = () => new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const first = await stepped(storage, wanted);
    const opened = first.running.replica(WORKSPACE)!;
    // The copy's chats live under its handle, which the restarted engine gives it again.
    const chats = new ChatsLiveAdapter(engine.chats, opened.workspace, { workspaceId: WORKSPACE });
    const group = await chats.createChannel({
      workspaceId: WORKSPACE,
      name: "Planning",
      type: "both",
    });
    const ids = phoneWriteIds("owner", WORKSPACE, "unsent");
    const author = { accountId: "owner", displayName: "Owner", actorKey: null };
    const write: WriteCommand = {
      kind: "start",
      lane: "chat",
      channelId: group.channelId,
      threadId: ids.threadId,
      messageId: ids.messageId("post"),
      body: "Lunch?",
    };
    // A crash after the row and before the engine's stage, on the copy that is open: the row is all there is.
    const claim = storage.recordAccountOperation({
      accountId: "owner",
      operationId: "unsent",
      binding: { workspaceId: WORKSPACE, operation: "send", args: { operationId: "unsent" } },
      incarnation: opened.incarnation,
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
      writesMessage: true,
      nowMs: 0,
      command: JSON.parse(
        JSON.stringify({ stages: publicationStages(write, author, ids.key), write, author }),
      ) as JsonValue,
    });
    expect(claim.kind).toBe("recorded");
    await first.running.close();

    const before = engine.sent.length;
    const restarted = await stepped(storage, wanted, { root: first.root });
    expect(restarted.running.replica(WORKSPACE)).toMatchObject({
      incarnation: opened.incarnation,
      workspace: opened.workspace,
    });
    const after = engine.sent.slice(before);
    const started = after.find((request) => request.method === "chats.threads.start");
    expect(started, "the stored command's stage").toMatchObject({
      workspace: opened.workspace,
      idempotencyKey: ids.key("post"),
      params: {
        channelId: group.channelId,
        lane: "chat",
        messageId: ids.messageId("post"),
        body: "Lunch?",
        authorKind: "human",
        authorDisplayName: "Owner",
        authorUserId: "owner",
        stageReceipt: true,
      },
    });
    const methods = after.map((request) => request.method);
    const replayedAt = methods.indexOf("chats.threads.start");
    expect(methods.indexOf("sync.applyPull"), "replayed once the copy pulled").toBeLessThan(
      replayedAt,
    );
    expect(methods.lastIndexOf("sync.push"), "and pushed after").toBeGreaterThan(replayedAt);
  });

  it("replays an owed write only after a full sync, when a later sync failed before pulling its file's move to a secret path", async () => {
    for (const moved of [true, false]) {
      const { storage } = await relay();
      const engine = fakeEngine();
      const errors: unknown[] = [];
      const wanted = () => new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
      const first = await stepped(storage, wanted);
      const opened = first.running.replica(WORKSPACE)!;
      const chats = new ChatsLiveAdapter(engine.chats, opened.workspace, {
        workspaceId: WORKSPACE,
      });
      engine.filePaths.set("object-plan", "docs/plan.md");
      const onPage = await chats.createThread({
        workspaceId: WORKSPACE,
        title: "Plan",
        linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" },
      });
      const ids = phoneWriteIds("owner", WORKSPACE, "unsent");
      const author = { accountId: "owner", displayName: "Owner", actorKey: null };
      const write: WriteCommand = {
        kind: "reply",
        threadId: onPage.id,
        messageId: ids.messageId("reply"),
        body: "Ship it",
      };
      storage.recordAccountOperation({
        accountId: "owner",
        operationId: "unsent",
        binding: { workspaceId: WORKSPACE, operation: "reply", args: { operationId: "unsent" } },
        incarnation: opened.incarnation,
        replicationEpoch: "epoch-1",
        streamIdentity: "stream-1",
        writesMessage: true,
        nowMs: 0,
        command: JSON.parse(
          JSON.stringify({ stages: publicationStages(write, author, ids.key), write, author }),
        ) as JsonValue,
      });
      await first.running.close();
      // The restarted copy catches up, but its receipts can't be read, so the replay stays owed.
      engine.receipts(new Error("the engine is busy"));
      const restarted = await stepped(storage, wanted, {
        root: first.root,
        onError: (error) => {
          errors.push(error);
        },
      });
      const sends = () =>
        engine.sent.filter((request) => request.method === "chats.messages.send").length;
      expect(sends()).toBe(0);
      expect(errors, `moved: ${moved}; the setup's unread receipts`).toContainEqual(
        new Error("the engine is busy"),
      );
      expect(
        errors.filter(
          (error) => !(error instanceof Error && error.message === "the engine is busy"),
        ),
        `moved: ${moved}; no other setup error`,
      ).toEqual([]);
      engine.receipts(new Map());

      // A visit's sync fails before it pulls, while the relay may have moved the page to a secret path.
      if (moved) engine.movedOnRelay(new Map([["object-plan", ".env"]]));
      engine.failPush(new Error("the relay is unreachable"));
      const replica = restarted.running.replica(WORKSPACE)!;
      await expect(replica.sync()).rejects.toThrow();
      await restarted.pass();
      expect(sends(), `moved: ${moved}; the copy is behind the relay, so nothing replays`).toBe(0);

      // A full sync catches it up again and asks for the pass that replays, into a thread still visible.
      const before = errors.length;
      engine.failPush(false);
      await replica.sync();
      await restarted.pass();
      expect(sends(), `moved: ${moved}`).toBe(moved ? 0 : 1);
      expect(errors.slice(before), `moved: ${moved}; the final pass`).toEqual([]);
    }
  });

  it("stops a replay, owed, when a sync starts while it reads, and sends nothing until a pass after the sync", async () => {
    for (const moved of [true, false]) {
      const { storage } = await relay();
      const engine = fakeEngine();
      const wanted = () => new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
      const first = await stepped(storage, wanted);
      const opened = first.running.replica(WORKSPACE)!;
      const chats = new ChatsLiveAdapter(engine.chats, opened.workspace, {
        workspaceId: WORKSPACE,
      });
      engine.filePaths.set("object-plan", "docs/plan.md");
      const onPage = await chats.createThread({
        workspaceId: WORKSPACE,
        title: "Plan",
        linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" },
      });
      const ids = phoneWriteIds("owner", WORKSPACE, "unsent");
      const author = { accountId: "owner", displayName: "Owner", actorKey: null };
      const write: WriteCommand = {
        kind: "reply",
        threadId: onPage.id,
        messageId: ids.messageId("reply"),
        body: "Ship it",
      };
      storage.recordAccountOperation({
        accountId: "owner",
        operationId: "unsent",
        binding: { workspaceId: WORKSPACE, operation: "reply", args: { operationId: "unsent" } },
        incarnation: opened.incarnation,
        replicationEpoch: "epoch-1",
        streamIdentity: "stream-1",
        writesMessage: true,
        nowMs: 0,
        command: JSON.parse(
          JSON.stringify({ stages: publicationStages(write, author, ids.key), write, author }),
        ) as JsonValue,
      });
      await first.running.close();
      // The restarted copy catches up, but its receipts can't be read, so the replay stays owed.
      engine.receipts(new Error("the engine is busy"));
      const errors: unknown[] = [];
      const restarted = await stepped(storage, wanted, {
        root: first.root,
        onError: (error) => {
          errors.push(error);
        },
      });
      expect(errors, `moved: ${moved}; the setup's unread receipts`).toContainEqual(
        new Error("the engine is busy"),
      );
      expect(
        errors.filter(
          (error) => !(error instanceof Error && error.message === "the engine is busy"),
        ),
        `moved: ${moved}; no other setup error`,
      ).toEqual([]);
      const sends = () =>
        engine.sent.filter((request) => request.method === "chats.messages.send").length;

      // The next pass's replay starts while the copy is current, and waits on its receipt read.
      let readReached!: () => void, releaseRead!: () => void;
      const reading = new Promise<void>((resolve) => {
        readReached = resolve;
      });
      const readHeld = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      engine.receipts(async () => {
        readReached();
        await readHeld;
        return new Map();
      });
      const passing = restarted.pass();
      await reading;
      // Meanwhile the relay may move the page to a secret path, and a visit's sync starts and waits before it pulls.
      if (moved) engine.movedOnRelay(new Map([["object-plan", ".env"]]));
      const gate = engine.holdPulls();
      const syncing = restarted.running.replica(WORKSPACE)!.sync();
      await gate.reached;
      releaseRead();
      await passing;
      expect(sends(), `moved: ${moved}; the replay stopped`).toBe(0);

      // Still owed: a pass after the sync replays, into a thread still visible.
      const before = errors.length;
      gate.release();
      await syncing;
      await restarted.pass();
      expect(sends(), `moved: ${moved}`).toBe(moved ? 0 : 1);
      expect(errors.slice(before), `moved: ${moved}; the final pass`).toEqual([]);
    }
  });

  it("doesn't replay a phone write into a thread whose file the relay made secret while the copy was stopped, and settles it as unsent", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    let wanted = new Map<string, readonly CopyReason[]>([[WORKSPACE, ["account"]]]);
    const first = await stepped(storage, () => wanted);
    const opened = first.running.replica(WORKSPACE)!;
    const chats = new ChatsLiveAdapter(engine.chats, opened.workspace, { workspaceId: WORKSPACE });
    engine.filePaths.set("object-plan", "docs/plan.md");
    const onPage = await chats.createThread({
      workspaceId: WORKSPACE,
      title: "Plan",
      linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" },
    });
    const ids = phoneWriteIds("owner", WORKSPACE, "unsent");
    const author = { accountId: "owner", displayName: "Owner", actorKey: null };
    const write: WriteCommand = {
      kind: "reply",
      threadId: onPage.id,
      messageId: ids.messageId("reply"),
      body: "Ship it",
    };
    const claim = storage.recordAccountOperation({
      accountId: "owner",
      operationId: "unsent",
      binding: { workspaceId: WORKSPACE, operation: "reply", args: { operationId: "unsent" } },
      incarnation: opened.incarnation,
      replicationEpoch: "epoch-1",
      streamIdentity: "stream-1",
      writesMessage: true,
      nowMs: 0,
      command: JSON.parse(
        JSON.stringify({ stages: publicationStages(write, author, ids.key), write, author }),
      ) as JsonValue,
    });
    expect(claim.kind).toBe("recorded");
    await first.running.close();

    // While the server is stopped, the page moves to a secret path at the relay. The folder still has it where it was.
    raw
      .prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
      VALUES (?, 'object-plan', 1, 'moment-1', 'main', '.env', 1)`)
      .run(WORKSPACE);
    engine.movedOnRelay(new Map([["object-plan", ".env"]]));
    const before = engine.sent.length;
    const restarted = await stepped(storage, () => wanted, { root: first.root });
    expect(
      engine.sent.slice(before).map((request) => request.method),
      "nothing replays into a hidden thread",
    ).not.toContain("chats.messages.send");
    expect(outcome(raw, "unsent")[0], "the write stays unsent").not.toBe("refused");

    // Its copy retires as any copy does, and the write settles as unsent.
    storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: WORKSPACE, showOnPhone: false });
    wanted = new Map();
    await restarted.pass();
    expect(outcome(raw, "unsent")).toEqual([
      "refused",
      "pending",
      { threadId: null, reason: "Couldn't send" },
    ]);
    expect(engine.sent.map((request) => request.method)).not.toContain("chats.messages.send");
  });

  it("refuses a copy's phone writes once its oldest stayed unknown thirty days past its active time, and opens the next visit a fresh copy", async () => {
    const { storage, raw } = await relay();
    fakeEngine();
    const clock = { ms: 0 };
    const { running, pass } = await stepped(storage, () => new Map([[WORKSPACE, ["account"]]]), {
      clock,
    });
    phoneWrite(storage, "stuck");
    clock.ms = OPERATION_ACTIVE_MS;
    await pass(WORKSPACE);
    expect(outcome(raw, "stuck")[0]).toBe("stalled");
    const kept = join(running.replica(WORKSPACE)!.root, "..", "kept");
    await writeFile(kept, "");

    clock.ms = OPERATION_ACTIVE_MS + OPERATION_STALLED_KEEP_MS - 1;
    await pass(WORKSPACE);
    expect(outcome(raw, "stuck")[0], "a day short of the bound").toBe("stalled");
    expect(existsSync(kept)).toBe(true);

    clock.ms += 1;
    await pass(WORKSPACE);
    // The folder settled, so nothing in it publishes again, and the write says so.
    expect(outcome(raw, "stuck")).toEqual([
      "refused",
      "pending",
      { threadId: null, reason: "Couldn't send" },
    ]);
    expect(existsSync(kept), "the settled folder went").toBe(false);
    expect(running.replica(WORKSPACE), "the visit has a fresh copy").toMatchObject({
      incarnation: 1,
    });
    expect(storage.listUnfinishedOperationCopies()).toEqual([]);
  });

  it("waits for its retry, while the copy syncs, before closing a copy again whose overdue writes couldn't settle", async () => {
    const { storage, raw } = await relay();
    const engine = fakeEngine();
    const clock = { ms: 0 };
    const errors: unknown[] = [];
    const { running, pass } = await stepped(storage, () => new Map([[WORKSPACE, ["account"]]]), {
      clock,
      onError: (error) => errors.push(error),
    });
    phoneWrite(storage, "stuck");
    clock.ms = OPERATION_ACTIVE_MS + OPERATION_STALLED_KEEP_MS;
    engine.receipts(new Error("the engine is busy"));
    const closes = () => count(engine, "workspace.close");

    await pass(WORKSPACE);
    expect(errors).toContainEqual(new Error("the engine is busy"));
    expect(outcome(raw, "stuck")[0], "nothing settled").not.toBe("refused");
    const reopened = running.replica(WORKSPACE);
    expect(reopened, "the copy opened again and synced").toBeDefined();
    const closed = closes();

    await pass(WORKSPACE);
    await pass();
    expect(closes()).toBe(closed);
    expect(running.replica(WORKSPACE)).toBe(reopened);

    engine.receipts(new Map());
    clock.ms += 60_000;
    await pass();
    expect(outcome(raw, "stuck")).toEqual([
      "refused",
      "pending",
      { threadId: null, reason: "Couldn't send" },
    ]);
    expect(running.replica(WORKSPACE), "a fresh copy").toBeDefined();
    expect(running.replica(WORKSPACE)).not.toBe(reopened);
  });
});
