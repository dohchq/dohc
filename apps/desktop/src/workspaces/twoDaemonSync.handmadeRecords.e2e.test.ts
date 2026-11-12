import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stableJsonStringify } from "../../../../services/sync-relay/src/canonicalJson";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { VersionedLiveAdapter, WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createRecordByHand, desktopRecordEditContext } from "./desktopRecordEdits";
import { onWorkspaceCaptureSettled } from "./captureActivityBridge";
import { createSuiteTestScratchSync, createTestScratch } from "./testTemp";
import { SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";
import { engine, compiledRelayMain, LiveDaemonCapture, pullCaptured, pushUntilDrained, openJoinedDaemonCapture, pullAndExpect } from "./twoDaemonSync.fixture";

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

  it.each(["new", "legacy", "accepted"] as const)(
    "syncs a %s hand-made Collection record with local human History through the real relay",
    async (queueStyle) => {
      const workspaceId = `two-daemon-human-record-${queueStyle}-${randomUUID()}`;
      const rootA = await createTestScratch("dohc-human-record-a-");
      const rootB = await createTestScratch("dohc-human-record-b-");
      const relayConnection = { baseUrl: relayServer.baseUrl, token: "test:" + workspaceId };
      let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
      let capture: WorkspaceEngineCapture | undefined;
      let peer: LiveDaemonCapture | undefined;
      try {
        owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0 });
        const source = owner;
        capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions });
        let relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
        await relay.claim();
        await source.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(relay);
        await capture.writeAuthoredFile(join(rootA, "tasks/collection.yaml"), "fields: {}\n", { kind: "human", humanId: "local-person" });
        const captureClient = await source.sessions.run(source.workspace, async ({ client }) => client);
        if (!captureClient.onEvent) throw new Error("The real daemon has no capture event source.");
        const onEvent = captureClient.onEvent.bind(captureClient);
        const person = { kind: "human", humanId: "local-person" } as const;
        const context = desktopRecordEditContext({
          capture, workspaceRoot: rootA, person, signal: new AbortController().signal,
          withAdapter: work => source.sessions.run(source.workspace, ({ client, workspace }) =>
            work(new VersionedLiveAdapter(client, workspace, { workspaceId }))),
          onCaptureSettled: listener => onWorkspaceCaptureSettled({ onEvent }, workspaceId, listener),
        });
        const record = await createRecordByHand({ collectionPath: "tasks", name: "hand-made" }, {
          author: createLocalChangeAuthor("Local person"),
          localPerson: async () => person,
          withWorkspaceOperation: work => work(undefined),
          editContext: async () => context,
        });
        if ("kind" in record) throw new Error(record.reason);
        const local = (await capture.listMoments({ limit: 100 })).moments.find(moment => moment.path === record.path);
        expect(local?.authors).toEqual([person]);
        if (queueStyle !== "new") {
          // Restore an older build's wire row with the daemon stopped.
          // Accepted agent rows also exist remotely, with a lost acknowledgement.
          if (queueStyle === "accepted") expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
          await capture.stop();
          await owner.close();
          capture = undefined;
          owner = undefined;
          const legacyAuthors = [
            ...(queueStyle === "legacy" ? [person] : []),
            { kind: "agent", agentId: "signed-out-agent", onBehalfOf: "local:123" },
            { kind: "automation", automationId: "signed-out-rule", onBehalfOf: "local:456", depth: 1 },
          ];
          const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH));
          try {
            const restored = db.prepare(
              "UPDATE replication_log SET payload_json=json_set(payload_json, '$.authors', json(?)) WHERE workspace_id=? AND imported=0 AND op_kind='moment.append' AND json_extract(payload_json, '$.path')=?",
            ).run(JSON.stringify(legacyAuthors), workspaceId, record.path);
            expect(restored.changes).toBe(1);
            const row = db.prepare(
              "SELECT origin_id, origin_seq, payload_json FROM replication_log WHERE workspace_id=? AND op_kind='moment.append' AND json_extract(payload_json, '$.path')=?",
            ).get(workspaceId, record.path) as { origin_id: string; origin_seq: number; payload_json: string };
            expect(JSON.parse(row.payload_json).authors).toEqual(legacyAuthors);
            // Older Rust builds also serialized the entire row with sorted keys.
            row.payload_json = stableJsonStringify(JSON.parse(row.payload_json));
            expect(db.prepare(
              "UPDATE replication_log SET payload_json=? WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
            ).run(row.payload_json, workspaceId, row.origin_id, row.origin_seq).changes).toBe(1);
            if (queueStyle === "accepted") {
              const relayDb = new DatabaseSync(relayServer.dbPath);
              try {
                expect(relayDb.prepare(
                  "UPDATE sync_relay_log SET payload_json=? WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
                ).run(row.payload_json, workspaceId, row.origin_id, row.origin_seq).changes).toBe(1);
              } finally {
                relayDb.close();
              }
              expect(db.prepare(
                "UPDATE sync_relay_push_state SET pushed_seq=? WHERE workspace_id=? AND origin_id=?",
              ).run(row.origin_seq - 1, workspaceId, row.origin_id).changes).toBe(1);
            }
          } finally {
            db.close();
          }
          owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0 });
          capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
          relay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
        }
        expect((await pushUntilDrained(relay)).pushed).toBeGreaterThan(0);
        const relayDb = new DatabaseSync(relayServer.dbPath, { readOnly: true });
        const engineDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
        try {
          const rows = relayDb.prepare(
            "SELECT origin_id, origin_seq, payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append'",
          ).all(workspaceId) as { origin_id: string; origin_seq: number; payload_json: string }[];
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            const payload = JSON.parse(row.payload_json);
            expect(payload.attributionUnavailable).toBeUndefined();
            expect(payload.authors).toEqual(queueStyle !== "new" && payload.path === record.path
              ? [{ kind: "agent", agentId: "signed-out-agent", onBehalfOf: "local:123" }, { kind: "automation", automationId: "signed-out-rule", onBehalfOf: "local:456", depth: 1 }]
              : undefined);
            if (queueStyle === "new") expect(row.payload_json).not.toContain("local:");
            expect(row.payload_json).not.toContain(person.humanId);
            const stored = engineDb.prepare(
              "SELECT payload_json FROM replication_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?",
            ).get(workspaceId, row.origin_id, row.origin_seq) as { payload_json: string };
            expect(stored.payload_json).toBe(row.payload_json);
          }
        } finally {
          engineDb.close();
          relayDb.close();
        }
        peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: relayConnection });
        await pullAndExpect(peer, rootB, record.path, await readFile(join(rootA, record.path)), "text");
        expect((await peer.capture.listMoments({ limit: 100 })).moments.some(moment => moment.path === record.path)).toBe(true);
        const echo = await pullCaptured(relay, capture);
        expect(echo.sharingDeclined).toEqual([]);
        expect(await owner.sessions.run(owner.workspace, ({ client, workspace }) =>
          new WorkspaceDaemonRequester(client).request("sync.refusalNotices", { workspaceId }, { workspace }),
        )).toEqual({ notices: [] });
        const afterEcho = (await capture.listMoments({ limit: 100 })).moments.find(moment => moment.path === record.path);
        expect(afterEcho?.authors).toEqual([person]);
      } finally {
        await peer?.close();
        await capture?.stop();
        await owner?.close();
      }
    },
    3 * REAL_DAEMON_DEADLINE_MS,
  );

});
