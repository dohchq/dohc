import { readFile, rm } from "node:fs/promises";

import { join } from "node:path";

import { expect, it, vi } from "vitest";

import * as Y from "yjs";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";

import { waitForPathMoments } from "./waitForPathMoments";

import { createTestScratch } from "./testTemp";

import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, openIndependentPlaintextLineage, pullAndExpect, OpenEditor, openEditor, typeAtEnd, shown } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)(
  "kept text resolution without lineage: edit over peer deletion",
  async () => {
    const workspaceId = "text-keep-deletion";
    const path = "trip.txt";
    const initial = "Trip destination: undecided\n";
    const textB = "Trip destination: Tokyo\n";
    const later = `${textB}continued on B\n`;
    const rootA = await createTestScratch("dohc-text-keep-delete-a-");
    const rootB = await createTestScratch("dohc-text-keep-delete-b-");
    const relayRoot = await createTestScratch("dohc-text-keep-delete-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const pull = (daemon: LiveDaemonCapture) => daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
    const inspect = async (daemon: LiveDaemonCapture, root: string) => {
      const rows = (await daemon.capture.listOpenConflictsPage()).conflicts;
      const moments = (await daemon.capture.listMoments({ limit: 100 })).moments.filter(moment => moment.path === path);
      return { text: await readFile(join(root, path), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }), rows, history: await Promise.all(moments.map(async moment => ({
        summary: moment, detail: await daemon.capture.readMoment(moment.id),
      }))) };
    };
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await writeAndCapture(daemonA, rootA, path, initial);
      await pushUntilDrained(daemonA.relay);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(daemonB, rootB, path, initial);
      const before = (await daemonA.capture.listMoments({ limit: 100 })).moments.length;
      await rm(join(rootA, path));
      daemonA.capture.observeFileEvents([{ path, operation: "delete" }]);
      await waitForPathMoments(daemonA.capture, path, before + 1);
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
      expect(rowsA[0]).toMatchObject({ current: { exists: false }, incoming: { text: textB } });
      expect(rowsB[0]).toMatchObject({ current: { text: textB }, incoming: { exists: false } });
      await daemonB.capture.resolveConflict(rowsB[0]!.id, { kind: "keep-current" });
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const keptA = await inspect(daemonA, rootA);
      const keptB = await inspect(daemonB, rootB);
      console.log("deletion after keep", JSON.stringify({ A: keptA, B: keptB }));
      expect(keptA.text).toBeNull();
      expect(keptA.rows).toHaveLength(2);
      expect(keptB.text).toBe(textB);
      expect(keptB.rows).toHaveLength(0);
      await writeAndCapture(daemonB, rootB, path, later);
      await pushUntilDrained(daemonB.relay);
      await pull(daemonA);
      await pull(daemonB);
      const laterA = await inspect(daemonA, rootA);
      const laterB = await inspect(daemonB, rootB);
      console.log("deletion after later edit", JSON.stringify({ A: laterA, B: laterB }));
      expect(laterA.text).toBeNull();
      expect(laterA.rows.length).toBeGreaterThanOrEqual(2);
      expect(laterA.rows.some(row => row.incoming.text === later)).toBe(true);
      expect(laterB.text).toBe(later);
      expect(laterB.rows).toHaveLength(0);
      expect(await daemonA.refusalNotices()).toMatchObject({ notices: [] });
      expect(await daemonB.refusalNotices()).toMatchObject({ notices: [] });
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "preserves edits made on A while B reviews a seed conflict and converges without retries",
  async () => {
    const workspaceId = "two-daemon-diverged-seed-review";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const textA = "seed from A\n";
    const textB = "seed from B\n";
    const savedA = `${textA}saved on A during review\n`;
    const unsaved = "unsaved on A during review\n";
    const liveA = `${savedA}${unsaved}`;
    const rootA = await createTestScratch("dohc-diverged-seed-a-");
    const rootB = await createTestScratch("dohc-diverged-seed-b-");
    const relayRoot = await createTestScratch("dohc-diverged-seed-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const editors: OpenEditor[] = [];
    const pull = (daemon: LiveDaemonCapture) =>
      daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
        // Explicit settles control this test; the timer exceeds its deadline.
        settleDebounceMs: 120_000,
      });
      await daemonA.relay.claim();
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      const seedA = await openIndependentPlaintextLineage(daemonA, rootA, path, textA);
      const seedB = await openIndependentPlaintextLineage(daemonB, rootB, path, textB);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonA);
      await pull(daemonB);
      await seedB.close({ settle: false });
      await seedA.close({ settle: false });
      const { conflicts: seedConflicts } = await daemonB.capture.listOpenConflictsPage();
      expect(seedConflicts).toHaveLength(1);
      const seedConflict = seedConflicts[0]!;
      expect(seedConflict).toMatchObject({
        path,
        current: { text: textB },
        incoming: { text: textA },
      });
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);

      // B is still reviewing the old seed. A saves one edit and journals
      // another without settling it, so the disk cannot stand in for its Y.Doc.
      const editingA = await openEditor(daemonA, path);
      editors.push(editingA);
      await typeAtEnd(editingA, "saved on A during review\n");
      const before = Y.encodeStateVector(editingA.doc);
      editingA.doc.getText("plainText").insert(savedA.length, unsaved);
      await editingA.session.applyDecidedLocalUpdate(
        () => Y.encodeStateAsUpdate(editingA.doc, before),
      );
      expect(shown(editingA)).toBe(liveA);
      expect(await readFile(join(rootA, path), "utf8")).toBe(savedA);
      expect(await daemonB.capture.countOpenConflicts()).toBe(1);

      await daemonB.capture.resolveConflict(seedConflict.id, { kind: "keep-current" });
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      const deferredPull = await pull(daemonA);
      expect(deferredPull.fetched).toBeGreaterThan(0);
      expect(deferredPull.sharingDeclined).toEqual([]);
      expect(deferredPull.conflictsOpened).toBe(0);
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect(shown(editingA)).toBe(liveA);
      expect(await readFile(join(rootA, path), "utf8")).toBe(savedA);
      // The live lease defers the resolution. Closing settles the draft and
      // releases the lease so the resolution can review the complete local text.
      await editingA.session.close();
      const resolutionPull = await pull(daemonA);
      const { conflicts: reviews } = await daemonA.capture.listOpenConflictsPage();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        path,
        current: { text: liveA },
        incoming: { text: textB },
      });
      expect(await readFile(join(rootA, path), "utf8")).toBe(liveA);
      const idlePull = await pull(daemonA);
      expect(idlePull).toMatchObject({
        fetched: 0,
        applied: 0,
        conflictsOpened: 0,
        nextCursor: resolutionPull.nextCursor,
        sharingDeclined: [],
      });
      expect((await daemonA.capture.listOpenConflictsPage()).conflicts).toEqual(reviews);

      await daemonA.capture.resolveConflict(reviews[0]!.id, { kind: "keep-current" });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonB);
      await pull(daemonA);
      expect(await daemonA.capture.countOpenConflicts(), "A after review resolution").toBe(0);
      const { conflicts: peerReviews } = await daemonB.capture.listOpenConflictsPage();
      expect(peerReviews).toHaveLength(1);
      expect(peerReviews[0]).toMatchObject({
        path,
        current: { text: textB },
        incoming: { text: liveA },
      });
      await daemonB.capture.resolveConflict(peerReviews[0]!.id, { kind: "apply-incoming" });
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonA);
      await pull(daemonB);
      expect(await daemonB.capture.countOpenConflicts(), "B after review resolution").toBe(0);
      const editorA = await openEditor(daemonA, path);
      editors.push(editorA);
      const editorB = await openEditor(daemonB, path);
      editors.push(editorB);
      expect(shown(editorA)).toBe(liveA);
      expect(shown(editorB)).toBe(liveA);
      expect(editorA.session.lineageClaimId).toMatch(/^[a-f0-9]{64}$/);
      expect(editorB.session.lineageClaimId).toBe(editorA.session.lineageClaimId);
      await typeAtEnd(editorA, "continued on A\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonB);
      const arrival = { timeout: REAL_DAEMON_DEADLINE_MS };
      await vi.waitFor(() => expect(shown(editorB)).toBe(`${liveA}continued on A\n`), arrival);
      await typeAtEnd(editorB, "continued on B\n");
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
      await pull(daemonA);
      const finalText = `${liveA}continued on A\ncontinued on B\n`;
      await vi.waitFor(() => expect(shown(editorA)).toBe(finalText), arrival);
      await editorB.session.close();
      await editorA.session.close();

      // Drain both origins, then demand an empty, stable cursor on each peer.
      // Check durable refusal notices too: refused envelopes can advance cursors.
      for (const daemon of [daemonA, daemonB]) await pushUntilDrained(daemon.relay);
      for (const daemon of [daemonA, daemonB]) await pull(daemon);
      for (const [daemon, root] of [
        [daemonA, rootA],
        [daemonB, rootB],
      ] as const) {
        expect(await readFile(join(root, path), "utf8")).toBe(finalText);
        expect(await daemon.capture.countOpenConflicts()).toBe(0);
        expect(await daemon.refusalNotices()).toEqual({ notices: [] });
        expect(await pushUntilDrained(daemon.relay)).toMatchObject({
          pushed: 0,
          ownerAdmissionPending: [],
          sharingDeclined: [],
        });
        const idle = await pull(daemon);
        expect(idle).toMatchObject({
          fetched: 0, applied: 0, conflictsOpened: 0, sharingDeclined: [],
        });
        expect(await pull(daemon)).toMatchObject({
          fetched: 0, applied: 0, nextCursor: idle.nextCursor, sharingDeclined: [],
        });
      }
    } finally {
      await Promise.allSettled(editors.map((editor) => editor.session.close()));
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  90_000,
);
