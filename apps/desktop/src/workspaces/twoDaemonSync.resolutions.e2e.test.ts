import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { createTestScratch } from "./testTemp";

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

it.each([
  ["keep-current", "unopened"],
  ["apply-merged", "unopened"],
  ["keep-current", "mirrored"],
] as const)(
  "a %s decision closes the conflict on the computer whose edit it settled (%s)",
  async (kind, order) => {
    if (engine.missing) return;
    const path = "note.md";
    await withPair(`${order}-${kind}`, path, "base\n", async (pair) => {
      await writeAndCapture(pair.a, pair.rootA, path, "from A\n");
      expect((await pushUntilDrained(pair.a.relay)).pushed).toBeGreaterThan(0);
      await writeAndCapture(pair.b, pair.rootB, path, "from B\n");
      if (order === "mirrored") {
        await pushUntilDrained(pair.b.relay);
        await pullCaptured(pair.a.relay, pair.a.capture);
        const opened = (await openConflicts(pair.a)).length;
        console.log(`REPRO-OBS ${JSON.stringify({ case: `${order}-${kind}:a`, opened })}`);
      }
      await pullCaptured(pair.b.relay, pair.b.capture);
      const onB = await openConflicts(pair.b);
      expect(onB).toHaveLength(1);
      const kept = kind === "keep-current" ? "from B\n" : "merged on B\n";
      await pair.b.capture.resolveConflict(
        onB[0]!.id,
        kind === "keep-current" ? { kind } : { kind, text: kept },
      );
      const end = await settled(pair, path);
      console.log(`REPRO-OBS ${JSON.stringify({ case: `${order}-${kind}`, end })}`);
      expect(end).toMatchObject({
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
        const onA = await openConflicts(pair.a);
        const onB = await openConflicts(pair.b);
        console.log(
          `REPRO-OBS ${JSON.stringify({ case: "first-editor-offline:opened", a: onA.length, b: onB.length })}`,
        );
        expect(onB).toHaveLength(1);
        await pair.b.capture.resolveConflict(onB[0]!.id, { kind: "keep-current" });
        const end = await settled(pair, path);
        console.log(`REPRO-OBS ${JSON.stringify({ case: "first-editor-offline", end })}`);
        expect(end).toMatchObject({
          a: { text: "changed on B\n", open: [], notices: { notices: [] } },
          b: { text: "changed on B\n", open: [], notices: { notices: [] } },
        });
        const later = await openEditor(pair.a, path);
        editors.push(later);
        await typeAtEnd(later, "later on A\n");
        await later.session.close();
        const after = await settled(pair, path);
        expect(after).toMatchObject({
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
      const objectBefore = await pair.a.capture.fileObjectIdForPath(path);
      await rm(join(pair.rootB, path));
      pair.b.capture.observeFileEvents([{ path, operation: "delete" }]);
      await vi.waitFor(async () => expect(await pair.b.capture.fileObjectIdForPath(path)).toBeNull(), {
        timeout: 30_000,
      });
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
      const objects = {
        before: objectBefore,
        a: await pair.a.capture.fileObjectIdForPath(path),
        b: await pair.b.capture.fileObjectIdForPath(path),
      };
      const open = {
        a: (await openConflicts(pair.a)).length,
        b: (await openConflicts(pair.b)).length,
      };
      console.log(`REPRO-OBS ${JSON.stringify({ case: "binary-revival", objects, open })}`);
      expect(objects.b).toBe(objects.a);
      expect(open).toEqual({ a: 0, b: 0 });
      const again = Buffer.from([10, 11, 12]);
      await writeAndCapture(pair.a, pair.rootA, path, again);
      await pushUntilDrained(pair.a.relay);
      await pullCaptured(pair.b.relay, pair.b.capture);
      expect(await readFile(join(pair.rootB, path))).toEqual(again);
    });
  },
  120_000,
);
