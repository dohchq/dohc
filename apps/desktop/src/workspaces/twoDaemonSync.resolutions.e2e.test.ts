import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { createTestScratch } from "./testTemp";
import { deleteWorkspacePathByHand } from "./workspaceFileMoves";

import {
  engine,
  compiledRelayMain,
  type LiveDaemonCapture,
  pullCaptured,
  pushUntilDrained,
  openLiveDaemonCapture,
  openJoinedDaemonCapture,
  openEditor,
  typeAtEnd,
  writeAndCapture,
  pullAndExpect,
  type OpenEditor,
} from "./twoDaemonSync.fixture";
import { waitForPathMoments } from "./waitForPathMoments";

interface Pair {
  a: LiveDaemonCapture;
  b: LiveDaemonCapture;
  rootA: string;
  rootB: string;
}

async function withPair(
  name: string,
  path: string,
  seed: string | Buffer,
  run: (pair: Pair) => Promise<void>,
): Promise<void> {
  const workspaceId = `two-daemon-resolution-${name}`;
  const token = `test:${workspaceId}`;
  const rootA = await createTestScratch(`dohc-resolution-${name}-a-`);
  const rootB = await createTestScratch(`dohc-resolution-${name}-b-`);
  const relayRoot = await createTestScratch(`dohc-resolution-${name}-relay-`);
  const relay = await spawnSyncRelay({
    dbPath: join(relayRoot, "relay", "relay.sqlite"),
    compiledMain: compiledRelayMain,
  });
  let a: LiveDaemonCapture | null = null;
  let b: LiveDaemonCapture | null = null;
  try {
    a = await openLiveDaemonCapture({
      workspaceId,
      rootPath: rootA,
      relay: { baseUrl: relay.baseUrl, token },
      settleDebounceMs: 120_000,
    });
    await a.relay.claim();
    await a.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(a.relay);
    await writeAndCapture(a, rootA, path, seed);
    expect((await pushUntilDrained(a.relay)).pushed).toBeGreaterThan(0);
    b = await openJoinedDaemonCapture({
      workspaceId,
      rootPath: rootB,
      relay: { baseUrl: relay.baseUrl, token },
    });
    await pullAndExpect(b, rootB, path, seed);
    await run({ a, b, rootA, rootB });
  } finally {
    await Promise.allSettled([b?.close(), a?.close()]);
    await relay.stop();
  }
}

async function openConflicts(daemon: LiveDaemonCapture) {
  return (await daemon.capture.listOpenConflictsPage()).conflicts;
}

async function settled(pair: Pair, path: string) {
  for (const daemon of [pair.a, pair.b]) await pushUntilDrained(daemon.relay);
  for (const daemon of [pair.a, pair.b]) await pullCaptured(daemon.relay, daemon.capture);
  return {
    a: {
      text: await readFile(join(pair.rootA, path), "utf8").catch(() => null),
      open: (await openConflicts(pair.a)).map((row) => row.path),
      notices: await pair.a.refusalNotices(),
    },
    b: {
      text: await readFile(join(pair.rootB, path), "utf8").catch(() => null),
      open: (await openConflicts(pair.b)).map((row) => row.path),
      notices: await pair.b.refusalNotices(),
    },
  };
}

it.skipIf(engine.missing).each([
  ["keeping this computer's copy", { kind: "keep-current" }, "from B\n"],
  ["merging the copies", { kind: "apply-merged", text: "merged on B\n" }, "merged on B\n"],
] as const)(
  "%s closes the conflict on the computer whose edit it settled",
  async (_name, choice, kept) => {
    const path = "note.md";
    await withPair(choice.kind, path, "base\n", async (pair) => {
      await writeAndCapture(pair.a, pair.rootA, path, "from A\n");
      expect((await pushUntilDrained(pair.a.relay)).pushed).toBeGreaterThan(0);
      await writeAndCapture(pair.b, pair.rootB, path, "from B\n");
      await pullCaptured(pair.b.relay, pair.b.capture);
      const onB = await openConflicts(pair.b);
      expect(onB).toHaveLength(1);
      await pair.b.capture.resolveConflict(onB[0]!.id, choice);
      expect(await settled(pair, path)).toMatchObject({
        a: { text: kept, open: [], notices: { notices: [] } },
        b: { text: kept, open: [], notices: { notices: [] } },
      });
    });
  },
  120_000,
);

it.skipIf(engine.missing)(
  "keeping a copy closes the conflict on a computer that first edited the note in the editor offline",
  async () => {
    const path = "note.md";
    const editors: OpenEditor[] = [];
    await withPair("first-editor-offline", path, "base\n", async (pair) => {
      try {
        const editorA = await openEditor(pair.a, path);
        editors.push(editorA);
        await typeAtEnd(editorA, "typed on A\n");
        await editorA.session.close();
        await writeAndCapture(pair.b, pair.rootB, path, "changed on B\n");
        await pushUntilDrained(pair.a.relay);
        await pushUntilDrained(pair.b.relay);
        await pullCaptured(pair.a.relay, pair.a.capture);
        await pullCaptured(pair.b.relay, pair.b.capture);
        const onB = await openConflicts(pair.b);
        expect(onB).toHaveLength(1);
        await pair.b.capture.resolveConflict(onB[0]!.id, { kind: "keep-current" });
        expect(await settled(pair, path)).toMatchObject({
          a: { text: "changed on B\n", open: [], notices: { notices: [] } },
          b: { text: "changed on B\n", open: [], notices: { notices: [] } },
        });
        const later = await openEditor(pair.a, path);
        editors.push(later);
        await typeAtEnd(later, "later on A\n");
        await later.session.close();
        expect(await settled(pair, path)).toMatchObject({
          a: { text: "changed on B\nlater on A\n", open: [] },
          b: { text: "changed on B\nlater on A\n", open: [] },
        });
      } finally {
        await Promise.allSettled(editors.map((editor) => editor.session.close()));
      }
    });
  },
  120_000,
);

it.skipIf(engine.missing)(
  "keeping the other copy of a deleted binary file brings back the same object",
  async () => {
    const path = "picture.bin";
    const seed = Buffer.from([0, 1, 2, 3, 255, 0, 7]);
    await withPair("binary-revival", path, seed, async (pair) => {
      const trash = await createTestScratch("dohc-resolution-binary-trash-");
      await mkdir(trash, { recursive: true });
      await deleteWorkspacePathByHand(
        {
          workspace: { ...pair.b.workspace, readOnly: false, shareView: undefined },
          assertCurrent() {},
        },
        path,
        { kind: "human", humanId: "local-person" },
        {
          capture: pair.b.capture,
          requestId: randomUUID(),
          markDeleted: () => undefined,
          trashItem: (target) => rename(target, join(trash, randomUUID())),
        },
      );
      expect(await pair.b.capture.fileObjectIdForPath(path)).toBeNull();
      const changed = Buffer.from([0, 1, 2, 3, 255, 0, 8, 9]);
      await writeAndCapture(pair.a, pair.rootA, path, changed);
      await pushUntilDrained(pair.a.relay);
      await pushUntilDrained(pair.b.relay);
      await pullCaptured(pair.a.relay, pair.a.capture);
      await pullCaptured(pair.b.relay, pair.b.capture);
      const onB = await openConflicts(pair.b);
      expect(onB).toHaveLength(1);
      await pair.b.capture.resolveConflict(onB[0]!.id, { kind: "apply-incoming" });
      for (const daemon of [pair.a, pair.b]) await pushUntilDrained(daemon.relay);
      for (const daemon of [pair.a, pair.b]) await pullCaptured(daemon.relay, daemon.capture);
      expect(await pair.b.capture.fileObjectIdForPath(path)).toBe(
        await pair.a.capture.fileObjectIdForPath(path),
      );
      expect(await openConflicts(pair.a)).toEqual([]);
      expect(await openConflicts(pair.b)).toEqual([]);
      const again = Buffer.from([10, 11, 12]);
      await writeAndCapture(pair.a, pair.rootA, path, again);
      await pushUntilDrained(pair.a.relay);
      await pullCaptured(pair.b.relay, pair.b.capture);
      expect(await readFile(join(pair.rootB, path))).toEqual(again);
    });
  },
  120_000,
);

it.skipIf(engine.missing)(
  "keeping a changed copy of a page the other computer deleted closes the conflict on both computers",
  async () => {
    const path = "note.md";
    await withPair("keep-changed-over-delete", path, "base\n", async (pair) => {
      await rm(join(pair.rootA, path));
      await pair.a.reconcileCapture();
      expect(await pair.a.capture.fileObjectIdForPath(path)).toBeNull();
      await writeAndCapture(pair.b, pair.rootB, path, "changed on B\n");
      for (const daemon of [pair.a, pair.b]) await pushUntilDrained(daemon.relay);
      for (const daemon of [pair.a, pair.b]) await pullCaptured(daemon.relay, daemon.capture);
      const onB = await openConflicts(pair.b);
      expect(onB).toHaveLength(1);
      await pair.b.capture.resolveConflict(onB[0]!.id, { kind: "keep-current" });
      expect(await settled(pair, path)).toMatchObject({
        a: { text: "changed on B\n", open: [], notices: { notices: [] } },
        b: { text: "changed on B\n", open: [], notices: { notices: [] } },
      });
    });
  },
  120_000,
);

it.skipIf(engine.missing).each([
  ["the computer that deleted it", "a", { kind: "apply-incoming" }],
  ["the computer that changed it", "b", { kind: "keep-current" }],
] as const)(
  "a page deleted in a file manager on %s after it settled a delete conflict leaves both computers",
  async (_name, side, choice) => {
    const path = "note.md";
    await withPair(`hand-delete-${side}`, path, "base\n", async (pair) => {
      await rm(join(pair.rootA, path));
      await pair.a.reconcileCapture();
      expect(await pair.a.capture.fileObjectIdForPath(path)).toBeNull();
      await writeAndCapture(pair.b, pair.rootB, path, "changed on B\n");
      for (const daemon of [pair.a, pair.b]) await pushUntilDrained(daemon.relay);
      for (const daemon of [pair.a, pair.b]) await pullCaptured(daemon.relay, daemon.capture);
      const [resolver, root] = side === "a" ? [pair.a, pair.rootA] : [pair.b, pair.rootB];
      const open = await openConflicts(resolver);
      expect(open).toHaveLength(1);
      await resolver.capture.resolveConflict(open[0]!.id, choice);
      expect(await readFile(join(root, path), "utf8")).toBe("changed on B\n");
      const recorded = (await waitForPathMoments(resolver.capture, path, 1)).length;
      await rm(join(root, path));
      const [latest] = (await waitForPathMoments(resolver.capture, path, recorded + 1)).sort(
        (a, b) => b.momentOrder - a.momentOrder,
      );
      expect(latest?.operation).toBe("delete");
      expect(await settled(pair, path)).toMatchObject({
        a: { text: null, open: [] },
        b: { text: null, open: [] },
      });
    });
  },
  120_000,
);
