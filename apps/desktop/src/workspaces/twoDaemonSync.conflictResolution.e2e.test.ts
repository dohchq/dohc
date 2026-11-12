import { readFile, readdir } from "node:fs/promises";

import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";

import { createTestScratch } from "./testTemp";

import { engine, compiledRelayMain, LiveDaemonCapture, pullCaptured, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, openIndependentPlaintextLineage, pullAndExpect, openEditor, typeAtEnd, shown } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing).each(["keep-current", "apply-incoming"] as const)(
  "preserves independent Y.Doc bases in a version conflict and converges after %s",
  async (resolution) => {
    const workspaceId = `two-daemon-independent-bases-${resolution}`;
    const textA = "seed from A\n";
    const textB = "seed from B\n";
    const chosen = resolution === "keep-current" ? textB : textA;
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const rootA = await createTestScratch("dohc-independent-base-a-");
    const rootB = await createTestScratch("dohc-independent-base-b-");
    const rootC = await createTestScratch("dohc-independent-base-c-");
    const relayRoot = await createTestScratch("dohc-independent-base-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    let daemonC: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });

      const sessionA = await openIndependentPlaintextLineage(
        daemonA,
        rootA,
        path,
        textA,
      );
      const sessionB = await openIndependentPlaintextLineage(
        daemonB,
        rootB,
        path,
        textB,
      );
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);

      // Both editors remain live. Each pull may persist the foreign base, but
      // it must not arbitrate behind the editor or change either projection.
      await pullCaptured(daemonA.relay, daemonA.capture);
      await pullCaptured(daemonB.relay, daemonB.capture);
      expect(await readFile(join(rootA, path), "utf8")).toBe(textA);
      expect(await readFile(join(rootB, path), "utf8")).toBe(textB);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);

      // Closing releases the leases. A's earlier relay position wins the
      // lineage; B keeps its file and reviews both complete texts in a conflict.
      await sessionB.close({ settle: false });
      await sessionA.close({ settle: false });
      expect(await readFile(join(rootA, path), "utf8")).toBe(textA);
      expect(await readFile(join(rootB, path), "utf8")).toBe(textB);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(await daemonB.capture.countOpenConflicts()).toBe(1);
      const { conflicts } = await daemonB.capture.listOpenConflictsPage();
      expect(conflicts).toHaveLength(1);
      const conflict = conflicts[0]!;
      expect(conflict).toMatchObject({
        path,
        status: "open",
        current: { text: textB },
        incoming: { text: textA },
      });
      for (const root of [rootA, rootB]) {
        expect(await readdir(join(root, "notes"))).toEqual(["shared.txt"]);
      }

      await daemonB.capture.resolveConflict(conflict.id, { kind: resolution });
      expect(await readFile(join(rootB, path), "utf8")).toBe(chosen);
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pullAndExpect(daemonA, rootA, path, chosen);
      // Advance B's cursor past its own resolution before reopening editors.
      await pullCaptured(daemonB.relay, daemonB.capture);

      // Reopen both editors to inspect the daemon's chosen CRDT lineage,
      // then prove it accepts edits from either machine without another conflict.
      const afterA = `${chosen}continued on A\n`;
      const finalText = `${afterA}continued on B\n`;
      const arrival = { timeout: REAL_DAEMON_DEADLINE_MS };
      const editorA = await openEditor(daemonA, path);
      const editorB = await openEditor(daemonB, path);
      try {
        expect(shown(editorA)).toBe(chosen);
        expect(shown(editorB)).toBe(chosen);
        expect(editorA.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
        expect(editorB.session.lineageClaimId).toBe(
          editorA.session.lineageClaimId,
        );
        await typeAtEnd(editorA, "continued on A\n");
        expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
        await pullCaptured(daemonB.relay, daemonB.capture);
        await vi.waitFor(() => expect(shown(editorB)).toBe(afterA), arrival);
        await typeAtEnd(editorB, "continued on B\n");
        expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
        await pullCaptured(daemonA.relay, daemonA.capture);
        await vi.waitFor(() => expect(shown(editorA)).toBe(finalText), arrival);
        expect(shown(editorB)).toBe(finalText);
      } finally {
        await editorB.session.close();
        await editorA.session.close();
      }
      for (const [daemon, root] of [
        [daemonA, rootA],
        [daemonB, rootB],
      ] as const) {
        expect(await readFile(join(root, path), "utf8")).toBe(finalText);
        expect(await daemon.capture.countOpenConflicts()).toBe(0);
        expect(await readdir(join(root, "notes"))).toEqual(["shared.txt"]);
      }

      daemonC = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootC,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullCaptured(daemonC.relay, daemonC.capture);
      expect(await readFile(join(rootC, path), "utf8")).toBe(finalText);
      expect(await daemonC.capture.countOpenConflicts()).toBe(0);
      expect(await readdir(join(rootC, "notes"))).toEqual(["shared.txt"]);
    } finally {
      await Promise.allSettled([daemonC?.close(), daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "reviews and settles concurrent offline edits between two real daemons",
  async () => {
    const workspaceId = "two-daemon-offline-conflict";
    const token = `test:${workspaceId}`;
    const path = "notes/offline.md";
    const rootA = await createTestScratch("dohc-offline-conflict-a-");
    const rootB = await createTestScratch("dohc-offline-conflict-b-");
    const relayRoot = await createTestScratch("dohc-offline-conflict-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await writeAndCapture(daemonA, rootA, path, "shared base\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullAndExpect(daemonB, rootB, path, "shared base\n", "text");

      await writeAndCapture(daemonA, rootA, path, "edit from A\n");
      await writeAndCapture(daemonB, rootB, path, "edit from B\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);

      await pullCaptured(daemonA.relay, daemonA.capture);
      const conflictPage = await daemonA.capture.listOpenConflictsPage();
      const conflict = conflictPage.conflicts.find((entry) => entry.path === path);
      expect(conflict).toBeDefined();
      expect(conflict?.current.text).toBe("edit from A\n");
      expect(conflict?.incoming.text, "the conflict's incoming text on A").toBe("edit from B\n");
      expect(await readFile(join(rootA, path), "utf8")).toBe("edit from A\n");

      await daemonA.capture.resolveConflict(conflict!.id, {
        kind: "apply-incoming",
      });
      expect(await readFile(join(rootA, path), "utf8"), "A's file after it applies B's edit").toBe("edit from B\n");
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);

      await pullCaptured(daemonB.relay, daemonB.capture);
      expect(await readFile(join(rootB, path), "utf8"), "B's file after it pulls the resolution").toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);

      await daemonB.close();
      daemonB = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      expect(await readFile(join(rootB, path), "utf8"), "B's file after its daemon reopens").toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);
