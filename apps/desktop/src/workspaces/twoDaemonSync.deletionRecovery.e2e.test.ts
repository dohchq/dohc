import { readFile, rm } from "node:fs/promises";

import { join } from "node:path";

import { expect, it, vi } from "vitest";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { waitForPathMoments } from "./waitForPathMoments";

import { createTestScratch } from "./testTemp";

import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, openEditor, typeAtEnd, shown } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing).each(["H2c", "H2d"] as const)(
  "settles a synced deletion in fresh %s and keeps notes syncing both ways",
  async scenario => {
    const workspaceId = `deletion-revival-${scenario}`;
    const path = "trip.txt";
    const rootA = await createTestScratch("dohc-guard-a-");
    const rootB = await createTestScratch("dohc-guard-b-");
    const relayRoot = await createTestScratch("dohc-guard-relay-");
    const relay = await spawnSyncRelay({dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain});
    const connection = {baseUrl: relay.baseUrl, token: `test:${workspaceId}`};
    let a: LiveDaemonCapture | null = null;
    let b: LiveDaemonCapture | null = null;
    const pull = (device: LiveDaemonCapture) => device.relay.pull(apply => device.capture.runRelaySync(apply));
    const rounds = async () => {
      for (let i = 0; i < 3; i++) {
        await pushUntilDrained(a!.relay);
        await pushUntilDrained(b!.relay);
        await pull(a!);
        await pull(b!);
      }
    };
    const keepOtherCopyOnA = async () => {
      const reviewA = (await a!.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
      expect(reviewA).toMatchObject({current: {exists: false}, incoming: {exists: true, text: "Paris\nTokyo\n"}});
      await a!.capture.resolveConflict(reviewA.id, {kind: "apply-incoming"});
      await rounds();
      expect(await readFile(join(rootA, path), "utf8")).toBe("Paris\nTokyo\n");
      for (const device of [a!, b!]) expect(await device.capture.countOpenConflicts()).toBe(0);
    };
    try {
      a = await openLiveDaemonCapture({workspaceId, rootPath: rootA, relay: connection});
      await a.relay.claim();
      await writeAndCapture(a, rootA, path, "Paris\n");
      await pushUntilDrained(a.relay);
      b = await openJoinedDaemonCapture({workspaceId, rootPath: rootB, relay: connection});
      await rounds();
      for (const device of [b, a]) {
        const editor = await openEditor(device, path);
        await editor.session.close();
        await rounds();
      }
      // Both devices have opened the same exact editor lineage before going offline.
      const lineages = new Set<string>();
      for (const device of [a, b]) {
        const editor = await openEditor(device, path);
        expect(shown(editor)).toBe("Paris\n");
        expect(editor.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
        lineages.add(editor.session.lineageClaimId!);
        await editor.session.close();
      }
      expect(lineages.size).toBe(1);
      const beforeDelete = (await a.capture.listMoments({limit: 100})).moments.filter(row => row.path === path).length;
      await rm(join(rootA, path));
      a.capture.observeFileEvents([{path, operation: "delete"}]);
      const deletionMoments = await waitForPathMoments(a.capture, path, beforeDelete + 1);
      expect(deletionMoments.some(row => row.operation === "delete")).toBe(true);
      if (scenario === "H2d") {
        // A conflict opens on A only for a file change. An editor change waits there.
        await writeAndCapture(b, rootB, path, "Paris\nTokyo\n");
      } else {
        const editor = await openEditor(b, path);
        try { await typeAtEnd(editor, "Tokyo\n"); }
        finally { await editor.session.close(); }
      }
      expect(await readFile(join(rootB, path), "utf8")).toBe("Paris\nTokyo\n");
      await rounds();
      const reviewB = (await b.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
      expect(reviewB).toMatchObject({current: {exists: true, text: "Paris\nTokyo\n"}, incoming: {exists: false}});
      let kept = "Paris\nTokyo\n";
      if (scenario === "H2d") {
        await keepOtherCopyOnA();
      } else {
        await b.capture.resolveConflict(reviewB.id, {kind: "keep-current"});
        if (scenario === "H2c") {
          const editorB = await openEditor(b, path);
          try { await typeAtEnd(editorB, "Rome\n"); }
          finally { await editorB.session.close(); }
          kept += "Rome\n";
        }
        await rounds();
      }
      if (scenario === "H2c") {
        expect(await readFile(join(rootA, path), "utf8")).toBe(kept);
        for (const device of [a, b]) expect(await device.capture.countOpenConflicts()).toBe(0);
      }
      let expected = kept;
      for (const [writer, writerRoot, readerRoot, line] of [[a, rootA, rootB, "A by hand\n"], [b, rootB, rootA, "B by hand\n"]] as const) {
        expected += line;
        await writeAndCapture(writer, writerRoot, path, expected);
        await rounds();
        expect(await readFile(join(readerRoot, path), "utf8")).toBe(expected);
      }
      // Both editors stay open, so each machine must see the other's live edits.
      const editorA = await openEditor(a, path);
      const editorB = await openEditor(b, path);
      try {
        expect(shown(editorA)).toBe(expected);
        expect(shown(editorB)).toBe(expected);
        expect(editorA.session.lineageClaimId).toBe(editorB.session.lineageClaimId);
        await typeAtEnd(editorA, "A live\n");
        await rounds();
        await vi.waitFor(() => expect(shown(editorB)).toBe(`${expected}A live\n`), {timeout: REAL_DAEMON_DEADLINE_MS});
        await typeAtEnd(editorB, "B live\n");
        await rounds();
        await vi.waitFor(() => expect(shown(editorA)).toBe(`${expected}A live\nB live\n`), {timeout: REAL_DAEMON_DEADLINE_MS});
      } finally {
        await Promise.allSettled([editorA.session.close(), editorB.session.close()]);
      }
      await rounds();
      expected += "A live\nB live\n";
      expect(await readFile(join(rootA, path), "utf8")).toBe(expected);
      expect(await readFile(join(rootB, path), "utf8")).toBe(expected);
      for (const device of [a, b]) expect(await device.capture.countOpenConflicts()).toBe(0);
      expect(await pull(a)).toMatchObject({fetched: 0});
      expect(await pull(b)).toMatchObject({fetched: 0});
    } finally {
      await Promise.allSettled([b?.close(), a?.close()]);
      await relay.stop();
    }
  }, 150_000,
);
