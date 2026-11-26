import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NO_PASSPHRASE_YET } from "@dohc/security-contract/secret-passphrase";
import {
  compiledRelayMain,
  engine,
  openJoinedDaemonCapture,
  openLiveDaemonCapture,
  pullAndExpect,
  pushUntilDrained,
  writeAndCapture,
  type LiveDaemonCapture,
} from "./twoDaemonSync.fixture";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { createTestScratch } from "./testTemp";
import { installWorkspaceDataKey } from "./workspaceDataKey";
import {
  enrollWorkspaceKeyEnvelope,
  readProtectedFilesNeed,
} from "./workspaceKeyEnvelopeEnrollment";
import {
  readWorkspaceDataKeyForEnrollment,
  readWorkspaceSecretState,
} from "./workspaceSecretEnrollmentState";

const PASSPHRASE = "unlock after join passphrase";

const protectedFilesNeed = (daemon: LiveDaemonCapture) =>
  readProtectedFilesNeed(
    daemon.workspace.rootPath,
    () => readWorkspaceSecretState(daemon.workspace, daemon.sessions),
    daemon.relay,
  );

async function enrollLikeSettings(daemon: LiveDaemonCapture, passphrase?: string): Promise<void> {
  await enrollWorkspaceKeyEnvelope({
    workspaceId: daemon.workspace.workspaceId,
    dataKey: await readWorkspaceDataKeyForEnrollment(daemon.workspace, daemon.sessions),
    ...(passphrase === undefined ? {} : { passphrase }),
    transport: daemon.relay,
    installDataKey: async (key) => await installWorkspaceDataKey(daemon.workspace.rootPath, key),
  });
}

it.skipIf(engine.missing)(
  "keeps syncing a computer without the key, then unlocks the .env that arrived after it joined",
  async () => {
    const workspaceId = "two-daemon-secret-unlock";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-unlock-a-");
    const rootB = await createTestScratch("dohc-unlock-b-");
    const relayRoot = await createTestScratch("dohc-unlock-relay-");
    const relayServer = await spawnSyncRelay({
      dbPath: join(relayRoot, "relay", "relay.sqlite"),
      compiledMain: compiledRelayMain,
    });
    const relay = { baseUrl: relayServer.baseUrl, token };
    const lockedReports: boolean[] = [];
    let owner: LiveDaemonCapture | null = null;
    let other: LiveDaemonCapture | null = null;
    try {
      owner = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay });
      await owner.relay.claim();
      await enrollLikeSettings(owner);
      await owner.chats.ensureGeneralChannel({ workspaceId });
      await writeAndCapture(owner, rootA, "notes.md", "before secrets\n");
      expect((await pushUntilDrained(owner.relay)).pushed).toBeGreaterThan(0);
      expect(await protectedFilesNeed(owner)).toBeUndefined();

      other = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay,
        onProtectedFilesLocked: (locked) => lockedReports.push(locked),
      });
      await pullAndExpect(other, rootB, "notes.md", "before secrets\n");

      await writeAndCapture(owner, rootA, ".env", "TOKEN=after-join\n");
      await writeAndCapture(owner, rootA, ".env.local", "TOKEN=owner-local\n");
      await writeAndCapture(owner, rootA, "notes.md", "after secrets\n");
      expect(await readWorkspaceSecretState(owner.workspace, owner.sessions)).toBe(
        "protected-key-present",
      );
      expect(await protectedFilesNeed(owner)).toBe("need-passphrase");
      expect((await pushUntilDrained(owner.relay)).pushed).toBeGreaterThan(0);

      await pullAndExpect(other, rootB, "notes.md", "after secrets\n");
      expect(lockedReports).toContain(true);
      await expect(readFile(join(rootB, ".env"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readWorkspaceSecretState(other.workspace, other.sessions)).toBe(
        "protected-key-missing",
      );
      expect(await protectedFilesNeed(other)).toBe("locked");
      await writeFile(join(rootB, ".env.local"), "TOKEN=made-while-locked\n");

      await expect(enrollLikeSettings(other, PASSPHRASE)).rejects.toThrow(NO_PASSPHRASE_YET);

      await enrollLikeSettings(owner, PASSPHRASE);
      expect(await protectedFilesNeed(owner)).toBeNull();
      await expect(enrollLikeSettings(other, "not the passphrase")).rejects.toThrow(
        /Passphrase could not unlock/u,
      );
      await enrollLikeSettings(other, PASSPHRASE);
      expect(await readWorkspaceSecretState(other.workspace, other.sessions)).toBe(
        "protected-key-present",
      );

      expect(await protectedFilesNeed(other)).toBeNull();
      await other.capture.restoreLockedProtectedFiles();
      expect(await readFile(join(rootB, ".env"), "utf8")).toBe("TOKEN=after-join\n");
      expect(await readFile(join(rootB, ".env.local"), "utf8")).toBe("TOKEN=made-while-locked\n");
      expect(lockedReports.at(-1)).toBe(false);

      await writeAndCapture(owner, rootA, ".env", "TOKEN=after-unlock\n");
      expect((await pushUntilDrained(owner.relay)).pushed).toBeGreaterThan(0);
      await pullAndExpect(other, rootB, ".env", "TOKEN=after-unlock\n");
    } finally {
      await Promise.allSettled([other?.close(), owner?.close()]);
      await relayServer.stop();
    }
  },
  120_000,
);
