import { engineMomentDetailForIpc } from "../ipc/engineHistoryIpc";

import { DatabaseSync } from "node:sqlite";

import { copyFile, readFile, rm } from "node:fs/promises";

import { join } from "node:path";

import { expect, it } from "vitest";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { waitForPathMoments } from "./waitForPathMoments";

import { createTestScratch } from "./testTemp";

import { SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";

import { createRelaySyncEngine } from "./relaySyncEngine";

import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, pullAndExpect, openEditor, typeAtEnd, shown } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)(
  "recovers a restored origin through the real relay without losing its local suffix",
  async () => {
    const workspaceId = "two-daemon-origin-recovery";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-origin-recovery-a-");
    const rootB = await createTestScratch("dohc-origin-recovery-b-");
    const relayRoot = await createTestScratch("dohc-origin-recovery-relay-");
    const backupRoot = await createTestScratch("dohc-origin-recovery-backup-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const relayConnection = { baseUrl: relay.baseUrl, token };
    const engineDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);
    const backupDb = join(backupRoot, "engine.db");
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await writeAndCapture(daemonA, rootA, "notes/base.md", "base\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await daemonA.close();
      daemonA = null;
      const retainedWal = await readFile(`${engineDb}-wal`);
      expect(retainedWal.byteLength).toBeGreaterThan(0);
      const snapshot = new DatabaseSync(engineDb, { readOnly: true });
      try {
        snapshot.prepare("VACUUM INTO ?").run(backupDb);
      } finally {
        snapshot.close();
      }
      expect(await readFile(`${engineDb}-wal`)).toEqual(retainedWal);

      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await writeAndCapture(
        daemonA,
        rootA,
        "notes/relay-ahead.md",
        "relay is ahead of the backup\n",
      );
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await daemonA.close();
      daemonA = null;

      await copyFile(backupDb, engineDb);
      await rm(`${engineDb}-wal`, { force: true });
      await rm(`${engineDb}-shm`, { force: true });
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await writeAndCapture(
        daemonA,
        rootA,
        "notes/local-after-restore.md",
        "local work after restore\n",
      );

      const sync = createRelaySyncEngine({
        rootDir: rootA,
        relay: relayConnection,
        operations: daemonA.relay,
        capture: daemonA.capture,
        onChange: () => undefined,
        debounceMs: 0,
      });
      await sync.start();
      expect(sync.snapshot().lastSyncedAtMs).not.toBeNull();
      await sync.stop();

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: relayConnection,
      });
      await pullAndExpect(
        daemonB,
        rootB,
        "notes/local-after-restore.md",
        "local work after restore\n",
      );
      expect(await readFile(join(rootB, "notes/relay-ahead.md"), "utf8")).toBe(
        "relay is ahead of the backup\n",
      );
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "settles a synced deletion both machines keep, then copies its text out of History",
  async () => {
    for (const choice of ["keep-current"] as const) {
      const workspaceId = `deletion-both-kept-${choice}`;
      const path = "trip.txt";
      const copyPath = "trip copy.txt";
      const aRemovedAgainstBEdit = {path, current: {exists: false}, incoming: {exists: true, text: "Paris\nTokyo\n"}};
      const bEditedAgainstARemoval = {path, current: {exists: true, text: "Paris\nTokyo\n"}, incoming: {exists: false}};
      const aBothDeletedReview = {path, current: {exists: false}, incoming: {exists: false}};
      const rootA = await createTestScratch("dohc-guard-a-");
      const rootB = await createTestScratch("dohc-guard-b-");
      const relayRoot = await createTestScratch("dohc-guard-relay-");
      const relay = await spawnSyncRelay({dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain});
      const connection = {baseUrl: relay.baseUrl, token: `test:${workspaceId}`};
      let a: LiveDaemonCapture | null = null;
      let b: LiveDaemonCapture | null = null;
      const pull = (device: LiveDaemonCapture) => device.relay.pull(apply => device.capture.runRelaySync(apply));
      type ExpectedRow = {path: string; current: {exists: boolean}; incoming: {exists: boolean}};
      const rounds = async (expectedA: ExpectedRow[] = [], expectedB: ExpectedRow[] = []) => {
        for (let i = 0; i < 3; i++) {
          await pushUntilDrained(a!.relay);
          await pushUntilDrained(b!.relay);
          await pull(a!);
          await pull(b!);
          expect(await a!.refusalNotices()).toEqual({notices: []});
          expect(await b!.refusalNotices()).toEqual({notices: []});
          for (const [machine, device, expected] of [["A", a!, expectedA], ["B", b!, expectedB]] as const) {
            const page = await device.capture.listOpenConflictsPage();
            expect(page.conflicts, `${machine}: only the expected conflict rows after round ${i + 1}`).toMatchObject(expected);
            expect(page.nextAfterConflictId).toBeNull();
          }
        }
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
        // B changes the file by hand, so both machines review. An editor change would wait on A and open none there.
        await writeAndCapture(b, rootB, path, "Paris\nTokyo\n");
        await rounds([aRemovedAgainstBEdit], [bEditedAgainstARemoval]);
        // Both keep the removal before either hears the other's choice.
        const reviewA = (await a.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
        const reviewB = (await b.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
        await a.capture.resolveConflict(reviewA.id, {kind: "keep-current"});
        await b.capture.resolveConflict(reviewB.id, {kind: "apply-incoming"});
        await rounds([aBothDeletedReview]);
        const absentA = (await a.capture.listOpenConflictsPage()).conflicts.find(row => row.path === path)!;
        await a.capture.resolveConflict(absentA.id, {kind: choice});
        await rounds();
        // History Restore stays refused, so B copies its text out of History into a new file.
        const removal = (await b.capture.listMoments({limit: 100})).moments.find(row => row.path === path && row.operation === "delete")!;
        await expect(b.capture.restoreFileToBeforeMoment(removal.id, {kind: "human", humanId: "guard-person"}))
          .rejects.toMatchObject({name: "SyncedDeletionRevivalError"});
        let copied: string | null = null;
        const history = (await b.capture.listMoments({limit: 100})).moments.filter(row => row.path === path);
        for (const row of history) {
          const detail = await b.capture.readMoment(row.id);
          if (!detail || detail.protected) continue;
          const ipcMoment = engineMomentDetailForIpc(detail, {
            agent: () => undefined, person: () => undefined, automation: () => null,
            named: author => author.userId, presentations: () => [],
          });
          if (ipcMoment.afterText === "Paris\nTokyo\n") {
            copied = ipcMoment.afterText;
            break;
          }
        }
        expect(copied, "B's History still exposes its text through readEngineMoment after the removal").toBe("Paris\nTokyo\n");
        if (copied === null) throw new Error("B's text is missing from its History after the removal");
        await writeAndCapture(b, rootB, copyPath, copied);
        await rounds();
        expect(await readFile(join(rootA, copyPath), "utf8")).toBe(copied);
        for (const [device, text] of [[b, "B later\n"], [a, "A later\n"]] as const) {
          const editor = await openEditor(device, copyPath);
          try { await typeAtEnd(editor, text); }
          finally { await editor.session.close(); }
          await rounds();
          for (const otherRoot of [rootA, rootB]) {
            expect(await readFile(join(otherRoot, copyPath), "utf8")).toContain(text);
          }
        }
        for (const [device, root] of [[a, rootA], [b, rootB]] as const) {
          expect((await device.capture.listOpenConflictsPage()).conflicts).toEqual([]);
          expect(await device.capture.countOpenConflicts()).toBe(0);
          expect(await readFile(join(root, copyPath), "utf8")).toBe(`${copied}B later\nA later\n`);
          await expect(readFile(join(root, path))).rejects.toMatchObject({code: "ENOENT"});
        }
        expect(await pull(a)).toMatchObject({fetched: 0});
        expect(await pull(b)).toMatchObject({fetched: 0});
      } finally {
        await Promise.allSettled([b?.close(), a?.close()]);
        await relay.stop();
      }
    }
  }, 180_000,
);
