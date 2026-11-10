import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { engine, compiledRelayMain, type LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, pullAndExpect, expectTwoDaemonFileSync } from "./twoDaemonSync.fixture";
import { createTestScratch } from "./testTemp";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

it.skipIf(engine.missing)(
  "syncs a captured file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-sync",
      path: "notes/hello.md",
      contents: "hello from daemon A\n",
      contentKind: "text",
      reverse: {
        path: "notes/reply.md",
        contents: "hello from daemon B\n",
      },
      restart: { contents: "hello after daemon B restarted\n" },
      rejoin: true,
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "backfills a captured file when the first relay position follows capture",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-enrolment-window",
      path: "notes/before-first-push.md",
      contents: "captured before the first relay position\n",
      contentKind: "text",
      bootstrapRelayBeforeCapture: false,
    }),
  60_000,
);

// A rename that changes only case reaches a peer as a delete of the old
// spelling and a write of the new one. On a disk that ignores case, as macOS
// and Windows do by default, writing `Notes.md` rewrites the existing
// `notes.md`, so the page must delete first or the file is lost.
const caseProbeRoot = await createTestScratch("dohc-case-rename-probe-");
await writeFile(join(caseProbeRoot, "probe.md"), "");
const ignoresCase = await readFile(join(caseProbeRoot, "PROBE.md")).then(() => true, () => false);
await rm(join(caseProbeRoot, "probe.md"));
it.skipIf(engine.missing || !ignoresCase)(
  "keeps a file another daemon renamed only by case on a disk that ignores case",
  async () => {
    const workspaceId = "two-daemon-case-rename";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-case-rename-a-");
    const rootB = await createTestScratch("dohc-case-rename-b-");
    const relayRoot = await createTestScratch("dohc-case-rename-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: { baseUrl: relay.baseUrl, token } });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      await pushUntilDrained(daemonA.relay);
      await writeAndCapture(daemonA, rootA, "notes.md", "body\n");
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: { baseUrl: relay.baseUrl, token } });
      await pullAndExpect(daemonB, rootB, "notes.md", "body\n");

      const finish = await daemonA.capture.beginFileRename("notes.md", "Notes.md");
      await rename(join(rootA, "notes.md"), join(rootA, "Notes.md"));
      await finish(true);
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      const receiver = daemonB;
      const pull = await receiver.relay.pull(apply => receiver.capture.runRelaySync(apply));

      expect((await readdir(rootB)).filter((name) => !name.startsWith("."))).toEqual(["Notes.md"]);
      expect(await readFile(join(rootB, "Notes.md"), "utf8")).toBe("body\n");
      expect(pull.fastForwardedPaths.map(({ operation, path }) => [operation, path])).toEqual([
        ["delete", "notes.md"],
        ["write", "Notes.md"],
      ]);
    } finally {
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "syncs a captured secret file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-secret-sync",
      path: ".env",
      contents: "TOKEN=two-daemon-secret\n",
      passphrase: "two-daemon protected-files passphrase",
      restart: { contents: "TOKEN=after-restart\n" },
      rejoin: true,
    }),
  90_000,
);

it.skipIf(engine.missing)(
  "preserves binary bytes through a real product join",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-binary-sync",
      path: "assets/payload.bin",
      contents: Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f, 0x42]),
      contentKind: "binary",
    }),
  60_000,
);
