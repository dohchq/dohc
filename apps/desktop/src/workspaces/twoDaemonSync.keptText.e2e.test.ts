import { readFile, stat } from "node:fs/promises";

import { join } from "node:path";

import { expect, it } from "vitest";

import * as Y from "yjs";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { createTestScratch } from "./testTemp";

import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, pullAndExpect } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing).each([
  "one device keeps",
  "both keep",
  "keep and incoming",
  "same merged text",
] as const)(
  "kept text resolution without lineage: %s",
  async (scenario) => {
    const workspaceId = `text-keep-${scenario.replaceAll(" ", "-")}`;
    const path = "notes/shared.txt";
    const initial = "Trip destination: undecided\n";
    const textA = "Trip destination: Manila\n";
    const textB = "Trip destination: Tokyo\n";
    const merged = "Trip destination: together\n";
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
      if (scenario === "one device keeps") {
        const modified = (await stat(join(rootB, path))).mtimeMs;
        await daemonB.capture.resolveConflict(id, { kind: "keep-current" });
        expect((await stat(join(rootB, path))).mtimeMs).toBe(modified);
      } else if (scenario === "same merged text") {
        await daemonA.capture.resolveConflict(id, { kind: "apply-merged", text: merged });
        await daemonB.capture.resolveConflict(id, { kind: "apply-merged", text: merged });
      } else {
        await daemonA.capture.resolveConflict(id, { kind: "keep-current" });
        await daemonB.capture.resolveConflict(id, { kind: scenario === "both keep" ? "keep-current" : "apply-incoming" });
      }
      await pushUntilDrained(daemonA.relay);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      if (scenario === "both keep") {
        for (const [daemon, root, current, incoming] of [
          [daemonA, rootA, textA, textB], [daemonB, rootB, textB, textA],
        ] as const) {
          expect(await readFile(join(root, path), "utf8")).toBe(current);
          const rows = (await daemon.capture.listOpenConflictsPage()).conflicts;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ current: { text: current }, incoming: { text: incoming } });
        }
      } else {
        const chosen = scenario === "one device keeps" ? textB : scenario === "same merged text" ? merged : textA;
        for (const [daemon, root] of [[daemonA, rootA], [daemonB, rootB]] as const) {
          expect(await readFile(join(root, path), "utf8")).toBe(chosen);
          expect(await daemon.capture.countOpenConflicts()).toBe(0);
        }
        await writeAndCapture(daemonA, rootA, path, `${chosen}continued on A\n`);
        await pushUntilDrained(daemonA.relay);
        await pullAndExpect(daemonB, rootB, path, `${chosen}continued on A\n`);
        await writeAndCapture(daemonB, rootB, path, `${chosen}continued on B\n`);
        await pushUntilDrained(daemonB.relay);
        await pullAndExpect(daemonA, rootA, path, `${chosen}continued on B\n`);
        expect(await daemonA.capture.countOpenConflicts()).toBe(0);
        expect(await daemonB.capture.countOpenConflicts()).toBe(0);
      }
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);
