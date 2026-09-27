import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RegistryEntry } from "./registryStore";
import {
  provedNeverShared,
  readSyncHistory,
  recordNeverSynced,
  recordReceivedShare,
  recordSynced,
} from "./syncHistory";
import { createTestScratch } from "./testTemp";

const selector = { paths: ["Trip"], versionId: null, access: "view" as const };
const channel = {
  shareId: "s-chat", channelWireId: "wire", access: "read-write" as const, granterEmail: "ana@dohc.test",
  relayUrl: "https://relay.dohc.test", recipientUserId: "u-me",
};
const mount = {
  shareId: "s-mount", label: "Ana", granterEmail: "ana@dohc.test", relayUrl: "https://relay.dohc.test", grantedSelector: selector,
};

let root: string;
let entry: RegistryEntry;
const none = async () => 0;

beforeEach(async () => {
  root = await createTestScratch("dohc-sync-history-");
  await mkdir(join(root, ".dohc"));
  entry = { workspaceId: "w-1", rootPath: root, kind: "personal", mode: "local-first" };
});

describe("a workspace proved never shared", () => {
  it("is a new workspace that never synced, whose engine applied nothing from another computer", async () => {
    await recordNeverSynced(root);
    expect(await provedNeverShared(entry, none)).toBe(true);
  });

  it("is never one whose record is missing or unreadable", async () => {
    expect(await provedNeverShared(entry, none), "no record").toBe(false);
    const path = join(root, ".dohc", "sync-history.json");
    for (const text of ["{", "[]", "{\"version\": 2, \"synced\": false}", "{\"version\": 1}", "{\"version\": 1, \"synced\": false, \"receivedShare\": \"no\"}"]) {
      await writeFile(path, text);
      expect(await provedNeverShared(entry, none), text).toBe(false);
    }
  });

  it("is never one whose record comes from before dohc kept received shares", async () => {
    await writeFile(join(root, ".dohc", "sync-history.json"), "{\"version\": 1, \"synced\": false}");
    expect(await provedNeverShared(entry, none)).toBe(false);
    // Its schedules still run here.
    expect(await readSyncHistory(root)).toBe("never-synced");
    recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
  });

  it("is never one that synced or opened as a share, even after it is forgotten and attached again", async () => {
    await recordNeverSynced(root);
    recordSynced(root);
    // Attached again, the registry entry has no server connection or share.
    expect(await provedNeverShared(entry, none)).toBe(false);
    await recordNeverSynced(root);
    expect(await provedNeverShared(entry, none), "a new-workspace record does not replace it").toBe(false);
  });

  it("is never one the registry connects to a server or a share, whatever the folder says", async () => {
    await recordNeverSynced(root);
    const cases: RegistryEntry[] = [
      { ...entry, remote: { serverUrl: "https://server.dohc.test", ownerUserId: "u-me" } },
      { ...entry, shareView: { shareId: "s-view", granterEmail: null, genericChatWritable: false, grantedSelector: selector } },
      { ...entry, sharedChannels: [{ ...channel, ended: true }] },
      { ...entry, shareMounts: [mount] },
    ];
    for (const connected of cases) expect(await provedNeverShared(connected, none), JSON.stringify(connected)).toBe(false);
  });

  it("stays unproved after a joined chat or a mount is left or removed", async () => {
    await recordNeverSynced(root);
    recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
    // Schedules still run here: the workspace itself never synced.
    expect(await readSyncHistory(root)).toBe("never-synced");
    recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
  });

  it("leaves a record that synced, or that dohc cannot read, as it is when a share comes in", async () => {
    const path = join(root, ".dohc", "sync-history.json");
    recordSynced(root);
    const synced = await readFile(path, "utf8");
    recordReceivedShare(root);
    expect(await readFile(path, "utf8")).toBe(synced);
    await writeFile(path, "{");
    recordReceivedShare(root);
    expect(await readFile(path, "utf8")).toBe("{");
    await rm(path);
    recordReceivedShare(root);
    expect(await readSyncHistory(root)).toBe("unknown");
  });

  it("refuses to keep a share whose coming in it cannot record", async () => {
    await mkdir(join(root, ".dohc", "sync-history.json"));
    expect(() => recordReceivedShare(root)).toThrow();
  });

  it("is never one whose engine applied a change from another computer, or did not answer", async () => {
    await recordNeverSynced(root);
    expect(await provedNeverShared(entry, async () => 3)).toBe(false);
    expect(await provedNeverShared(entry, async () => null)).toBe(false);
  });

  it("does not ask the engine when the registry or the folder already disproves it", async () => {
    let asked = 0;
    const count = async () => { asked += 1; return 0; };
    recordSynced(root);
    await provedNeverShared(entry, count);
    await provedNeverShared({ ...entry, remote: { serverUrl: "https://server.dohc.test", ownerUserId: "u-me" } }, count);
    expect(asked).toBe(0);
  });
});
