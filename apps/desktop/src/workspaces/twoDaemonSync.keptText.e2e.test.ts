import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { createTestScratch } from "./testTemp";
import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, pullAndExpect } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)(
  "keeps one device's text without rewriting it, then continues editing on both devices",
  async () => {
    const workspaceId = "text-keep-one-device-keeps";
    const path = "notes/shared.txt";
    const initial = "Trip destination: undecided\n";
    const textA = "Trip destination: Manila\n";
    const textB = "Trip destination: Tokyo\n";
    const rootA = await createTestScratch("dohc-text-keep-a-");
    const rootB = await createTestScratch("dohc-text-keep-b-");
    const relayRoot = await createTestScratch("dohc-text-keep-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const pull = (daemon: LiveDaemonCapture) => daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await writeAndCapture(daemonA, rootA, path, initial);
      await pushUntilDrained(daemonA.relay);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pull(daemonB);
      expect(await readFile(join(rootB, path), "utf8")).toBe(initial);
      // No editor or sync runs between these independent file saves.
      await writeAndCapture(daemonA, rootA, path, textA);
      await writeAndCapture(daemonB, rootB, path, textB);
      await pushUntilDrained(daemonA.relay);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const rowsA = (await daemonA.capture.listOpenConflictsPage()).conflicts;
      const rowsB = (await daemonB.capture.listOpenConflictsPage()).conflicts;
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]!.id).toBe(rowsB[0]!.id);
      expect(rowsA[0]).toMatchObject({ current: { text: textA }, incoming: { text: textB } });
      expect(rowsB[0]).toMatchObject({ current: { text: textB }, incoming: { text: textA } });
      const id = rowsA[0]!.id;
      const modified = (await stat(join(rootB, path))).mtimeMs;
      await daemonB.capture.resolveConflict(id, { kind: "keep-current" });
      expect((await stat(join(rootB, path))).mtimeMs).toBe(modified);
      await pushUntilDrained(daemonA.relay);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      for (const [daemon, root] of [[daemonA, rootA], [daemonB, rootB]] as const) {
        expect(await readFile(join(root, path), "utf8")).toBe(textB);
        expect(await daemon.capture.countOpenConflicts()).toBe(0);
      }
      await writeAndCapture(daemonA, rootA, path, `${textB}continued on A\n`);
      await pushUntilDrained(daemonA.relay);
      await pullAndExpect(daemonB, rootB, path, `${textB}continued on A\n`);
      await writeAndCapture(daemonB, rootB, path, `${textB}continued on B\n`);
      await pushUntilDrained(daemonB.relay);
      await pullAndExpect(daemonA, rootA, path, `${textB}continued on B\n`);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);
