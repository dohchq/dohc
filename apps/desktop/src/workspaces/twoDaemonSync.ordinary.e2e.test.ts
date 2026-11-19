import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";
import { createSuiteTestScratchSync, createTestScratch } from "./testTemp";
import { engine, compiledRelayMain, pushUntilDrained } from "./twoDaemonSync.fixture";

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
});
