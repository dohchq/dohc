import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { createTestScratch } from "./testTemp";
import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";
import { createRelayLogWait } from "./relayLogWait";
import {
  engine,
  compiledRelayMain,
  LiveDaemonCapture,
  pullCaptured,
  pushUntilDrained,
  openLiveDaemonCapture,
  openJoinedDaemonCapture,
  OpenEditor,
  openEditor,
  typeAtEnd,
  shown,
} from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)(
  "shows each device's edit in the other device's idle open editor",
  async () => {
    const workspaceId = "two-daemon-idle-editors";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const rootA = await createTestScratch("dohc-idle-editor-a-");
    const rootB = await createTestScratch("dohc-idle-editor-b-");
    const relayRoot = await createTestScratch("dohc-idle-editor-relay-");
    const relay = await spawnSyncRelay({
      dbPath: join(relayRoot, "relay", "relay.sqlite"),
      compiledMain: compiledRelayMain,
    });
    const relayConnection = { baseUrl: relay.baseUrl, token };
    // Generous against one push, one held read's answer, one pull, and one
    // resync on a loaded machine.
    const arrival = { timeout: 60_000, interval: 100 };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const engines: CloudSyncEngine[] = [];
    const editors: OpenEditor[] = [];
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });

      // A opens the document before enrollment. Sync must claim it and send
      // those bytes on its own continuation timer, without another edit.
      await daemonA.relay.claim();
      await mkdir(join(rootA, "notes"), { recursive: true });
      await writeFile(join(rootA, path), "");
      const editorA = await openEditor(daemonA, path);
      editors.push(editorA);
      await typeAtEnd(editorA, "Starting together.\n");
      const pushes: { pushed: number; hasMore: boolean }[] = [];
      const ownerRelay = daemonA.relay;
      const syncA = createRelaySyncEngine({
        rootDir: rootA,
        relay: relayConnection,
        operations: {
          ...ownerRelay,
          async push() {
            const result = await ownerRelay.push();
            pushes.push(result);
            return result;
          },
        },
        capture: daemonA.capture,
        onChange: () => undefined,
        debounceMs: 0,
        waitForChange: createRelayLogWait({ workspaceId, relay: relayConnection }),
      });
      engines.push(syncA);
      await syncA.start();
      expect(pushes[0]).toMatchObject({ pushed: 0, hasMore: true });
      await vi.waitFor(() => {
        expect(pushes.some((push) => push.pushed > 0)).toBe(true);
        expect(pushes.at(-1)?.hasMore).toBe(false);
      }, arrival);

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: relayConnection,
      });
      await pullCaptured(daemonB.relay, daemonB.capture);
      const editorB = await openEditor(daemonB, path);
      editors.push(editorB);
      expect(shown(editorB)).toBe("Starting together.\n");

      // From here the typing device pushes as the desktop does after a local
      // write, and nothing asks the idle device to pull: it waits on the relay.
      const syncB = createRelaySyncEngine({
        rootDir: rootB,
        relay: relayConnection,
        operations: daemonB.relay,
        capture: daemonB.capture,
        onChange: () => undefined,
        debounceMs: 0,
        waitForChange: createRelayLogWait({ workspaceId, relay: relayConnection }),
      });
      engines.push(syncB);
      await syncB.start();

      await typeAtEnd(editorA, "Typed on A.\n");
      syncA.queueSync();
      await vi.waitFor(() => expect(shown(editorB)).toContain("Typed on A."), arrival);
      await typeAtEnd(editorB, "Typed on B.\n");
      syncB.queueSync();
      await vi.waitFor(() => expect(shown(editorA)).toContain("Typed on B."), arrival);

      const merged = shown(editorA);
      for (const line of ["Starting together.", "Typed on A.", "Typed on B."]) {
        expect(merged.split(line).length - 1, line).toBe(1);
      }
      expect(shown(editorB)).toBe(merged);
      await vi.waitFor(async () => {
        expect(await readFile(join(rootA, path), "utf8")).toBe(merged);
        expect(await readFile(join(rootB, path), "utf8")).toBe(merged);
      }, arrival);
    } finally {
      await Promise.allSettled(engines.map((sync) => sync.stop()));
      await Promise.allSettled(editors.map((editor) => editor.session.close()));
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  180_000,
);

it.skipIf(engine.missing)(
  "sends a new note's first file to the server while its editor stays open",
  async () => {
    const workspaceId = "two-daemon-open-new-note";
    const token = `test:${workspaceId}`;
    const path = "notes/new.txt";
    const text = "Written in an open tab.\n";
    const rootA = await createTestScratch("dohc-open-new-note-a-");
    const relayRoot = await createTestScratch("dohc-open-new-note-relay-");
    const relay = await spawnSyncRelay({
      dbPath: join(relayRoot, "relay", "relay.sqlite"),
      compiledMain: compiledRelayMain,
    });
    let daemonA: LiveDaemonCapture | null = null;
    const editors: OpenEditor[] = [];
    const fileRecords = () => {
      const relayDb = new DatabaseSync(relay.dbPath, { readOnly: true });
      try {
        return relayDb
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append' AND instr(payload_json, ?) > 0",
          )
          .get(workspaceId, JSON.stringify(path)) as { count: number };
      } finally {
        relayDb.close();
      }
    };
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      await mkdir(join(rootA, "notes"), { recursive: true });
      await writeFile(join(rootA, path), "");
      const editorA = await openEditor(daemonA, path);
      editors.push(editorA);
      await typeAtEnd(editorA, text);
      expect(await readFile(join(rootA, path), "utf8")).toBe(text);
      await pushUntilDrained(daemonA.relay);
      await pullCaptured(daemonA.relay, daemonA.capture);
      await pushUntilDrained(daemonA.relay);

      expect(fileRecords()).toEqual({ count: 1 });
      expect(shown(editorA)).toBe(text);
    } finally {
      await Promise.allSettled(editors.map((editor) => editor.session.close()));
      await daemonA?.close();
      await relay.stop();
    }
  },
  180_000,
);
