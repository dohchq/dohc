import * as disk from "node:fs/promises";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryEntry } from "./registryStore";
import {
  provedNeverShared,
  readSyncHistory,
  recordNeverSynced,
  recordReceivedShare,
  recordSynced,
} from "./syncHistory";
import { createTestScratch } from "./testTemp";

const io = vi.hoisted(() => ({
  rename: vi.fn<typeof disk.rename>(), readFile: vi.fn<typeof disk.readFile>(), realpath: vi.fn<typeof disk.realpath>(),
  delay: vi.fn<typeof timers.setTimeout>(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof disk>(), rename: io.rename, readFile: io.readFile, realpath: io.realpath,
}));
vi.mock("node:timers/promises", async (original) => ({
  ...await original<typeof timers>(), setTimeout: io.delay,
}));
const actual = await vi.importActual<typeof disk>("node:fs/promises");
const clock = await vi.importActual<typeof timers>("node:timers/promises");

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
  io.rename.mockImplementation(actual.rename);
  io.readFile.mockImplementation(actual.readFile);
  io.realpath.mockImplementation(actual.realpath);
  io.delay.mockImplementation(clock.setTimeout);
  root = await createTestScratch("dohc-sync-history-");
  await mkdir(join(root, ".dohc"));
  entry = { workspaceId: "w-1", rootPath: root, kind: "personal", mode: "local-first" };
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("a workspace proved never shared", () => {
  it("records sync after transient Windows destination locks", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await recordNeverSynced(root);
    const locked = Object.assign(new Error("destination locked"), { code: "EPERM" });
    io.rename.mockRejectedValueOnce(locked).mockRejectedValueOnce(locked);
    io.delay.mockResolvedValue(undefined);
    await recordSynced(root);
    expect(io.rename).toHaveBeenCalledTimes(3);
    expect(io.delay).toHaveBeenCalledTimes(2);
    expect(await readSyncHistory(root)).toBe("synced");
    expect(await readdir(join(root, ".dohc"))).toEqual(["sync-history.json"]);
  });

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
    await recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
  });

  it("is never one that synced or opened as a share, even after it is forgotten and attached again", async () => {
    await recordNeverSynced(root);
    await recordSynced(root);
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
    await recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
    // Schedules still run here: the workspace itself never synced.
    expect(await readSyncHistory(root)).toBe("never-synced");
    await recordReceivedShare(root);
    expect(await provedNeverShared(entry, none)).toBe(false);
  });

  it("leaves a record that synced, or that dohc cannot read, as it is when a share comes in", async () => {
    const path = join(root, ".dohc", "sync-history.json");
    await recordSynced(root);
    const synced = await readFile(path, "utf8");
    await recordReceivedShare(root);
    expect(await readFile(path, "utf8")).toBe(synced);
    await writeFile(path, "{");
    await recordReceivedShare(root);
    expect(await readFile(path, "utf8")).toBe("{");
    await rm(path);
    await recordReceivedShare(root);
    expect(await readSyncHistory(root)).toBe("absent");
  });

  it("reads a record it cannot read as unknown, and only a missing one as absent", async () => {
    const path = join(root, ".dohc", "sync-history.json");
    expect(await readSyncHistory(root)).toBe("absent");
    // A directory where the record should be fails the read with an error other than ENOENT.
    await mkdir(path);
    expect(await readSyncHistory(root)).toBe("unknown");
    await rm(path, { recursive: true });
    await recordSynced(root);
    const synced = await readFile(path, "utf8");
    await writeFile(path, synced.slice(0, 10));
    expect(await readSyncHistory(root), "a record cut off mid-write").toBe("unknown");
  });

  it("replaces the record whole, leaving nothing beside it", async () => {
    await recordNeverSynced(root);
    await recordReceivedShare(root);
    await recordSynced(root);
    expect(await readSyncHistory(root)).toBe("synced");
    expect(await readdir(join(root, ".dohc"))).toEqual(["sync-history.json"]);
  });

  it("refuses to keep a share whose coming in it cannot record", async () => {
    await mkdir(join(root, ".dohc", "sync-history.json"));
    await expect(recordReceivedShare(root)).rejects.toThrow();
  });

  it("is never one whose engine applied a change from another computer, or did not answer", async () => {
    await recordNeverSynced(root);
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

describe("replacing the record", () => {
  const path = () => join(root, ".dohc", "sync-history.json");

  it.skipIf(process.platform !== "win32")("records a sync once a program reading the record closes it", async () => {
    await recordNeverSynced(root);
    const reader = await actual.open(path(), "r");
    const conflicts: string[] = [];
    io.rename.mockImplementation(async (from, to) => {
      try {
        await actual.rename(from, to);
      } catch (error) {
        conflicts.push((error as NodeJS.ErrnoException).code!);
        await reader.close();
        throw error;
      }
    });
    try {
      await expect(recordSynced(root)).resolves.toBeUndefined();
    } finally {
      await reader.close();
    }
    expect(conflicts).toEqual(["EPERM"]);
    expect(await readSyncHistory(root)).toBe("synced");
    expect(await readdir(join(root, ".dohc"))).toEqual(["sync-history.json"]);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("gives up on a Windows %s that does not clear, keeping the old record", async (code) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await recordNeverSynced(root);
    const before = await actual.readFile(path(), "utf8");
    const error = Object.assign(new Error("the record is still open"), { code });
    io.rename.mockRejectedValue(error);
    io.delay.mockResolvedValue(undefined);
    await expect(recordSynced(root)).rejects.toBe(error);
    expect(io.rename).toHaveBeenCalledTimes(100);
    expect(io.delay.mock.calls.reduce((total, [ms]) => total + ms!, 0)).toBe(2381);
    expect(await actual.readFile(path(), "utf8")).toBe(before);
    expect(await readdir(join(root, ".dohc")), "only its own temporary file is removed").toEqual(["sync-history.json"]);
    io.rename.mockImplementation(actual.rename);
    await recordSynced(root);
    expect(await readSyncHistory(root)).toBe("synced");
  });

  it.each([["win32", "EIO"], ["linux", "EACCES"]])("fails at once on %s %s, which waiting cannot fix", async (platform, code) => {
    vi.stubGlobal("process", { ...process, platform });
    await recordNeverSynced(root);
    const before = await actual.readFile(path(), "utf8");
    const error = Object.assign(new Error("cannot replace"), { code });
    io.rename.mockRejectedValue(error);
    await expect(recordReceivedShare(root)).rejects.toBe(error);
    expect(io.rename).toHaveBeenCalledTimes(1);
    expect(io.delay).not.toHaveBeenCalled();
    expect(await actual.readFile(path(), "utf8")).toBe(before);
    expect(await readdir(join(root, ".dohc"))).toEqual(["sync-history.json"]);
  });

  it("never writes a share it read before a sync over that sync", async () => {
    await recordNeverSynced(root);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    io.readFile.mockImplementationOnce((async (file, options) => {
      const text = await actual.readFile(file, options);
      reading.resolve();
      await release.promise;
      return text;
    }) as typeof disk.readFile);
    const written: string[] = [];
    io.rename.mockImplementation(async (from, to) => {
      written.push(await actual.readFile(from, "utf8"));
      await actual.rename(from, to);
    });
    const share = recordReceivedShare(root);
    await reading.promise;
    const synced = recordSynced(root);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(io.rename).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([share, synced]);
    }
    expect(written.map(text => JSON.parse(text))).toEqual([
      { version: 1, synced: false, receivedShare: true },
      { version: 1, synced: true },
    ]);
    expect(await readSyncHistory(root)).toBe("synced");
  });

  it("never writes a share read through a junction over a sync through the folder it reaches", async () => {
    const alias = join(await createTestScratch("dohc-sync-history-alias-"), "workspace");
    await symlink(root, alias, "junction");
    await recordNeverSynced(root);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    io.readFile.mockImplementationOnce((async (file, options) => {
      const text = await actual.readFile(file, options);
      reading.resolve();
      await release.promise;
      return text;
    }) as typeof disk.readFile);
    // The sync either waits its turn once its folder is resolved, or writes at once.
    const waiting = Promise.withResolvers<void>();
    io.realpath.mockImplementation((async (folder) => {
      try {
        return await actual.realpath(folder);
      } finally {
        if (folder === root) waiting.resolve();
      }
    }) as typeof disk.realpath);
    const written: string[] = [];
    io.rename.mockImplementation(async (from, to) => {
      const text = await actual.readFile(from, "utf8");
      written.push(text);
      if (JSON.parse(text).synced) waiting.resolve();
      await actual.rename(from, to);
    });
    const share = recordReceivedShare(alias);
    await reading.promise;
    const synced = recordSynced(root);
    try {
      await waiting.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(io.rename).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([share, synced]);
    }
    expect(written.map(text => JSON.parse(text))).toEqual([
      { version: 1, synced: false, receivedShare: true },
      { version: 1, synced: true },
    ]);
    expect(await readSyncHistory(alias)).toBe("synced");
  });

  it("records another folder's sync while one folder's record is held", async () => {
    const other = await createTestScratch("dohc-sync-history-other-");
    await mkdir(join(other, ".dohc"));
    await recordNeverSynced(root);
    await recordNeverSynced(other);
    const renaming = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    io.rename.mockImplementation(async (from, to) => {
      if (to === path()) {
        renaming.resolve();
        await release.promise;
      }
      await actual.rename(from, to);
    });
    const held = recordSynced(root);
    try {
      await renaming.promise;
      await recordSynced(other);
      expect(await readSyncHistory(other)).toBe("synced");
      expect(await readSyncHistory(root)).toBe("never-synced");
    } finally {
      release.resolve();
      await held;
    }
    expect(await readSyncHistory(root)).toBe("synced");
  });

  it("lets a later change run after an earlier one fails", async () => {
    await recordNeverSynced(root);
    io.rename.mockRejectedValueOnce(Object.assign(new Error("disk error"), { code: "EIO" }));
    const failed = recordReceivedShare(root);
    const synced = recordSynced(root);
    await expect(failed).rejects.toThrow("disk error");
    await expect(synced).resolves.toBeUndefined();
    expect(await readSyncHistory(root)).toBe("synced");
  });
});
