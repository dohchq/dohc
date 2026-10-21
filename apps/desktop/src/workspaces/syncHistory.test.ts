import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RegistryEntry } from "./registryStore";
import {
  provedNeverShared,
  readSyncHistory,
  recordNeverSynced,
  recordReceivedShare,
  recordSynced,
  runSchedulesOn,
  scheduleComputer,
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
const laptop = { installId: "install-laptop", label: "Laptop" };
const desk = { installId: "install-desk", label: "Desk" };

let root: string;
let entry: RegistryEntry;
const none = async () => 0;
const recordPath = () => join(root, ".dohc", "sync-history.json");

beforeEach(async () => {
  root = await createTestScratch("dohc-sync-history-");
  await mkdir(join(root, ".dohc"));
  entry = { workspaceId: "w-1", rootPath: root, kind: "personal", mode: "local-first" };
});

describe("a workspace proved never shared", () => {
  it("is a new workspace that never synced, whose engine applied nothing from another computer", async () => {
    await recordNeverSynced(root, laptop);
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
    await recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
  });

  it("is never one that synced or opened as a share, even after it is forgotten and attached again", async () => {
    await recordNeverSynced(root, laptop);
    await recordSynced(root);
    // Attached again, the registry entry has no server connection or share.
    expect(await provedNeverShared(entry, none)).toBe(false);
    await recordNeverSynced(root, laptop);
    expect(await provedNeverShared(entry, none), "a new-workspace record does not replace it").toBe(false);
  });

  it("is never one the registry connects to a server or a share, whatever the folder says", async () => {
    await recordNeverSynced(root, laptop);
    const cases: RegistryEntry[] = [
      { ...entry, remote: { serverUrl: "https://server.dohc.test", ownerUserId: "u-me" } },
      { ...entry, shareView: { shareId: "s-view", granterEmail: null, genericChatWritable: false, grantedSelector: selector } },
      { ...entry, sharedChannels: [{ ...channel, ended: true }] },
      { ...entry, shareMounts: [mount] },
    ];
    for (const connected of cases) expect(await provedNeverShared(connected, none), JSON.stringify(connected)).toBe(false);
  });

  it("stays unproved after a joined chat or a mount is left or removed", async () => {
    await recordNeverSynced(root, laptop);
    await recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
    // Schedules still run here: the workspace itself never synced.
    expect(await readSyncHistory(root)).toBe("never-synced");
    await recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
  });

  it("keeps a sync or a share whatever a stale copy of the record says", async () => {
    await recordNeverSynced(root, laptop);
    // The desk's copy of the folder from before either was recorded.
    const stale = await readFile(recordPath(), "utf8");
    await recordReceivedShare(root);
    await writeFile(recordPath(), stale);
    expect(await provedNeverShared(entry, none), "the share stays").toBe(false);
    expect(await readSyncHistory(root), "a share does not make it sync").toBe("never-synced");
    await recordSynced(root);
    await writeFile(recordPath(), stale);
    expect(await readSyncHistory(root), "the sync stays").toBe("synced");
    expect(await scheduleComputer(root, laptop), "so the relay chooses the host").toBeNull();
  });

  it("reads a record it cannot read as unknown, and only a missing one as absent", async () => {
    const path = join(root, ".dohc", "sync-history.json");
    expect(await readSyncHistory(root)).toBe("absent");
    // A directory where the record should be fails the read with an error other than ENOENT.
    await mkdir(path);
    expect(await readSyncHistory(root)).toBe("unknown");
    await rm(path, { recursive: true });
    await recordNeverSynced(root, laptop);
    const record = await readFile(path, "utf8");
    await writeFile(path, record.slice(0, 10));
    expect(await readSyncHistory(root), "a record cut off mid-write").toBe("unknown");
    await writeFile(path, record);
    // A file where the marks should be fails their read with an error other than ENOENT.
    await writeFile(join(root, ".dohc", "sync-history"), "");
    expect(await readSyncHistory(root), "a mark dohc cannot check may say synced").toBe("unknown");
  });

  it("records each fact once, leaving nothing beside it", async () => {
    await recordNeverSynced(root, laptop);
    await recordReceivedShare(root);
    await recordReceivedShare(root);
    await recordSynced(root);
    await recordSynced(root);
    expect(await readSyncHistory(root)).toBe("synced");
    expect(await readdir(join(root, ".dohc"))).toEqual(["sync-history", "sync-history.json"]);
    expect((await readdir(join(root, ".dohc", "sync-history"))).sort()).toEqual(["received-share", "synced"]);
  });

  it("does not bring back a workspace folder that is gone", async () => {
    await rm(root, { recursive: true });
    await expect(recordSynced(root)).rejects.toThrow();
    await expect(recordReceivedShare(root)).rejects.toThrow();
    await expect(readdir(root)).rejects.toThrow();
  });

  it("refuses to keep a share whose coming in it cannot record", async () => {
    await writeFile(join(root, ".dohc", "sync-history"), "");
    await expect(recordReceivedShare(root)).rejects.toThrow();
  });

  it("is never one whose engine applied a change from another computer, or did not answer", async () => {
    await recordNeverSynced(root, laptop);
    expect(await provedNeverShared(entry, async () => 3)).toBe(false);
    expect(await provedNeverShared(entry, async () => null)).toBe(false);
  });

  it("does not ask the engine when the registry or the folder already disproves it", async () => {
    let asked = 0;
    const count = async () => { asked += 1; return 0; };
    await recordSynced(root);
    await provedNeverShared(entry, count);
    await provedNeverShared({ ...entry, remote: { serverUrl: "https://server.dohc.test", ownerUserId: "u-me" } }, count);
    expect(asked).toBe(0);
  });
});

describe("the computer that runs a never-synced workspace's schedules", () => {
  const schedulesPath = () => join(root, ".dohc", "sync-history", "schedules.json");

  it("is the computer that made it, on every computer the folder reaches", async () => {
    await recordNeverSynced(root, laptop);
    expect(await scheduleComputer(root, laptop)).toEqual({ kind: "computer", computer: laptop });
    expect(await scheduleComputer(root, desk)).toEqual({ kind: "computer", computer: laptop });
    expect(await readdir(join(root, ".dohc")), "reading writes nothing").toEqual(["sync-history.json"]);
  });

  it("moves to the computer chosen, and stays there for every reader", async () => {
    await recordNeverSynced(root, laptop);
    expect(await runSchedulesOn(root, desk)).toBe(true);
    expect(await scheduleComputer(root, laptop)).toEqual({ kind: "computer", computer: desk });
    expect(await scheduleComputer(root, desk)).toEqual({ kind: "computer", computer: desk });
    expect(await runSchedulesOn(root, laptop)).toBe(true);
    expect(await scheduleComputer(root, desk)).toEqual({ kind: "computer", computer: laptop });
    expect(await readdir(join(root, ".dohc", "sync-history")), "nothing left beside it").toEqual(["schedules.json"]);
  });

  it("belongs to the first computer that reads a record from before dohc named one", async () => {
    await writeFile(recordPath(), "{\"version\": 1, \"synced\": false, \"receivedShare\": false}");
    expect(await scheduleComputer(root, laptop)).toEqual({ kind: "computer", computer: laptop });
    expect(await scheduleComputer(root, desk)).toEqual({ kind: "computer", computer: laptop });
    expect(await provedNeverShared(entry, none), "the record keeps what it said").toBe(true);
  });

  it("is no computer when the workspace synced, has no history, or its history cannot be read", async () => {
    expect(await scheduleComputer(root, laptop), "no record").toBeNull();
    await writeFile(recordPath(), "{");
    expect(await scheduleComputer(root, laptop), "unreadable").toBeNull();
    expect(await runSchedulesOn(root, laptop)).toBe(false);
    await rm(recordPath());
    await recordNeverSynced(root, laptop);
    await recordSynced(root);
    expect(await scheduleComputer(root, laptop)).toBeNull();
    expect(await runSchedulesOn(root, desk), "the relay chooses instead").toBe(false);
    await expect(readFile(schedulesPath())).rejects.toThrow();
  });

  it("is none dohc can name when its record cannot be read, until a computer takes over", async () => {
    await recordNeverSynced(root, laptop);
    await mkdir(join(root, ".dohc", "sync-history"));
    for (const text of ["{", "{\"version\": 1, \"installId\": \"\", \"label\": \"Desk\"}", "{\"version\": 2, \"installId\": \"d\", \"label\": \"Desk\"}"]) {
      await writeFile(schedulesPath(), text);
      expect(await scheduleComputer(root, laptop), text).toMatchObject({ kind: "unreadable" });
    }
    expect(await runSchedulesOn(root, laptop)).toBe(true);
    expect(await scheduleComputer(root, desk)).toEqual({ kind: "computer", computer: laptop });
  });
});

describe("a workspace's history stays inside it", () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";

  it("refuses a link at .dohc/sync-history, and writes nothing where it leads", async () => {
    const outside = await createTestScratch("dohc-sync-history-outside-");
    await recordNeverSynced(root, laptop);
    await symlink(outside, join(root, ".dohc", "sync-history"), linkType);
    const refusal = "dohc could not record this workspace's sync history. A link is at .dohc/sync-history, which must be a real folder. Remove or rename that link. Then retry.";
    await expect(recordSynced(root)).rejects.toThrow(refusal);
    await expect(recordReceivedShare(root)).rejects.toThrow(refusal);
    // A link proves nothing, so no computer runs the schedules and none can take them.
    expect(await readSyncHistory(root)).toBe("unknown");
    expect(await scheduleComputer(root, laptop)).toBeNull();
    expect(await runSchedulesOn(root, desk)).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a file at .dohc/sync-history, and a .dohc that is a link", async () => {
    await writeFile(join(root, ".dohc", "sync-history"), "");
    await expect(recordSynced(root)).rejects.toThrow("A file is at .dohc/sync-history, which must be a real folder.");
    const outside = await createTestScratch("dohc-sync-history-outside-");
    await rm(join(root, ".dohc"), { recursive: true });
    await symlink(outside, join(root, ".dohc"), linkType);
    await expect(recordSynced(root)).rejects.toThrow("A link is at .dohc, which must be a real folder.");
    await expect(recordNeverSynced(root, laptop)).rejects.toThrow("A link is at .dohc, which must be a real folder.");
    expect(await readSyncHistory(root)).toBe("unknown");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("a mark that a link stands in for", () => {
  it.each(["synced", "received-share"] as const)("counts a link that leads nowhere at %s as there, and refuses to write over it", async (name) => {
    await recordNeverSynced(root, laptop);
    await mkdir(join(root, ".dohc", "sync-history"));
    await symlink(join(root, "nowhere"), join(root, ".dohc", "sync-history", name));
    const write = name === "synced" ? recordSynced : recordReceivedShare;
    await expect(write(root)).rejects.toThrow(
      `dohc could not record this workspace's sync history. A link is at .dohc/sync-history/${name}, which must be a file. Remove or rename that link. Then retry.`,
    );
    expect(await provedNeverShared(entry, none), "never proved never shared").toBe(false);
    if (name === "synced") {
      expect(await readSyncHistory(root), "a stale never-synced record cannot undo it").toBe("synced");
      expect(await scheduleComputer(root, laptop), "so no schedules run here").toBeNull();
    }
    expect((await lstat(join(root, ".dohc", "sync-history", name))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(root, "nowhere"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("a record from before the marks", () => {
  it("keeps a sync it says, whatever a stale copy says after", async () => {
    await writeFile(recordPath(), "{\"version\": 1, \"synced\": true}");
    expect(await readSyncHistory(root)).toBe("synced");
    await writeFile(recordPath(), "{\"version\": 1, \"synced\": false, \"receivedShare\": false}");
    expect(await readSyncHistory(root)).toBe("synced");
  });

  it("keeps a share it says, whatever a stale copy says after", async () => {
    await writeFile(recordPath(), "{\"version\": 1, \"synced\": false, \"receivedShare\": true}");
    expect(await provedNeverShared(entry, none)).toBe(false);
    await writeFile(recordPath(), "{\"version\": 1, \"synced\": false, \"receivedShare\": false}");
    expect(await provedNeverShared(entry, none)).toBe(false);
    expect(await readSyncHistory(root), "a share does not make it sync").toBe("never-synced");
  });
});

describe("a schedules record that names no computer", () => {
  const legacy = "{\"version\": 1, \"synced\": false, \"receivedShare\": false}";

  it("is unreadable whatever its words, and never loops", async () => {
    await writeFile(recordPath(), legacy);
    await mkdir(join(root, ".dohc", "sync-history"));
    await writeFile(join(root, ".dohc", "sync-history", "schedules.json"), "absent");
    expect(await scheduleComputer(root, laptop)).toMatchObject({ kind: "unreadable" });
  });

  it.each(["legacy", "named"])("is unreadable when a link that leads nowhere is there with a %s host, and never loops", async (host) => {
    if (host === "legacy") await writeFile(recordPath(), legacy);
    else await recordNeverSynced(root, laptop);
    await mkdir(join(root, ".dohc", "sync-history"));
    const target = join(root, "nowhere.json");
    const path = join(root, ".dohc", "sync-history", "schedules.json");
    await symlink(target, path);
    const link = await readlink(path);
    expect(await scheduleComputer(root, laptop)).toMatchObject({ kind: "unreadable" });
    await expect(runSchedulesOn(root, desk)).rejects.toThrow("A link is at .dohc/sync-history/schedules.json");
    expect(await readlink(path)).toBe(link);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reads or replaces a link to an existing schedules record", async () => {
    await recordNeverSynced(root, laptop);
    await mkdir(join(root, ".dohc", "sync-history"));
    const outside = await createTestScratch("dohc-sync-history-outside-");
    const target = join(outside, "schedules.json");
    const text = JSON.stringify({ version: 1, ...desk });
    await writeFile(target, text);
    const path = join(root, ".dohc", "sync-history", "schedules.json");
    await symlink(target, path);
    const link = await readlink(path);
    expect(await scheduleComputer(root, laptop)).toMatchObject({ kind: "unreadable" });
    await expect(runSchedulesOn(root, laptop)).rejects.toThrow("A link is at .dohc/sync-history/schedules.json");
    expect(await readlink(path)).toBe(link);
    expect(await readFile(target, "utf8")).toBe(text);
  });

  it("never creates a history record through a dangling link", async () => {
    const target = join(root, "nowhere.json");
    await symlink(target, recordPath());
    expect(await readSyncHistory(root)).toBe("unknown");
    await expect(recordNeverSynced(root, laptop)).rejects.toThrow("A link is at .dohc/sync-history.json");
    expect((await lstat(recordPath())).isSymbolicLink()).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
