import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSyncHistory, recordNeverSynced, recordSynced, recordReceivedShare, scheduleComputer } from "./syncHistory";
import { installWorkspaceDataKey, loadSecretDataKey, SECRET_KEY_RELATIVE_PATH } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

const fault = vi.hoisted(() => ({ write: false, link: null as string | null, remove: false, synced: [] as string[] }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    link: async (...args: Parameters<typeof fs.link>) => {
      if (fault.link) throw Object.assign(new Error("link failed"), { code: fault.link, syscall: "link" });
      return fs.link(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (fault.remove) throw new Error("temporary removal denied");
      return fs.rm(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (!fault.write) return fs.writeFile(...args);
      await fs.writeFile(args[0], "{", args[2]);
      throw new Error("interrupted write");
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); fault.synced.push(String(args[0])); };
      if (fault.write && args[1] === "wx") {
        handle.writeFile = async () => {
          await handle.write("{");
          throw new Error("interrupted write");
        };
      }
      return handle;
    },
  };
});
afterEach(() => { fault.write = false; fault.link = null; fault.remove = false; fault.synced = []; });

const here = { installId: "here", label: "Here" };
const there = { installId: "there", label: "There" };
const legacy = '{"version":1,"synced":false,"receivedShare":false}\n';
async function fixture() {
  const root = await createTestScratch("dohc-durable-records-");
  await mkdir(join(root, ".dohc", "engine"), { recursive: true });
  await mkdir(join(root, ".dohc", "sync-history"));
  return root;
}

it.each(["history", "schedules", "synced", "received-share"] as const)("falls back to a flushed claim and rename for a %s write", async (kind) => {
  const root = await fixture();
  if (kind === "schedules") await writeFile(join(root, ".dohc", "sync-history.json"), legacy);
  fault.link = "EACCES";
  const path = join(root, kind === "history" ? ".dohc/sync-history.json" : `.dohc/sync-history/${kind === "schedules" ? "schedules.json" : kind}`);
  if (kind === "history") {
    await recordNeverSynced(root, here);
    expect(await readSyncHistory(root)).toBe("never-synced");
  } else if (kind === "schedules") {
    expect(await scheduleComputer(root, here)).toEqual({ kind: "computer", computer: here });
  } else {
    await (kind === "synced" ? recordSynced(root) : recordReceivedShare(root));
    expect(await readFile(path, "utf8")).toBe("");
  }
  expect(fault.synced.some(synced => synced.startsWith(`${path}.tmp-`))).toBe(true);
  const winner = await readFile(path, "utf8");
  if (kind === "history") await recordNeverSynced(root, there);
  if (kind === "schedules") expect(await scheduleComputer(root, there)).toEqual({ kind: "computer", computer: here });
  expect(await readFile(path, "utf8")).toBe(winner);
  // A key falls back only where the drive has no hard links.
  await expect(loadSecretDataKey(root, { createIfMissing: true })).rejects.toMatchObject({ code: "key-corrupt" });
  await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 1))).rejects.toMatchObject({ code: "key-corrupt" });
  expect(await readdir(join(root, ".dohc", "engine"))).toEqual([]);
  expect(await readdir(dirname(path))).not.toEqual(expect.arrayContaining([expect.stringContaining(".tmp-")]));
});

it("publishes the key by a claim and rename on a drive without hard links", async () => {
  const root = await fixture();
  fault.link = "ENOTSUP";
  const key = await loadSecretDataKey(root, { createIfMissing: true });
  const path = join(root, SECRET_KEY_RELATIVE_PATH);
  expect(fault.synced.some(synced => synced.startsWith(`${path}.tmp-`))).toBe(true);
  expect(await loadSecretDataKey(root, { createIfMissing: false })).toEqual(key);
  await installWorkspaceDataKey(root, key);
  await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 1))).rejects.toThrow("A different workspace secret key");
  expect(await readdir(join(root, ".dohc", "engine"))).toEqual(["secret.key"]);
});

it.each(["load", "install"] as const)("a failed temporary removal still returns the published %s key", async (kind) => {
  const root = await fixture();
  fault.remove = true;
  const key = kind === "load" ? await loadSecretDataKey(root, { createIfMissing: true }) : Buffer.alloc(32, 1);
  if (kind === "install") await installWorkspaceDataKey(root, key);
  expect(await loadSecretDataKey(root, { createIfMissing: false })).toEqual(key);
  expect(await readFile(join(root, SECRET_KEY_RELATIVE_PATH), "utf8")).toBe(`dohc-secret-key-v1:${key.toString("base64")}\n`);
});

it("keeps cut-off history unknown and runs no schedules", async () => {
  const root = await fixture();
  const path = join(root, ".dohc", "sync-history.json");
  await writeFile(path, "{");
  await recordNeverSynced(root, here);
  expect(await readSyncHistory(root)).toBe("unknown");
  expect(await scheduleComputer(root, here)).toBeNull();
  expect(await readFile(path, "utf8")).toBe("{");
});

it("keeps cut-off schedules unreadable on every computer", async () => {
  const root = await fixture();
  await writeFile(join(root, ".dohc", "sync-history.json"), legacy);
  const path = join(root, ".dohc", "sync-history", "schedules.json");
  await writeFile(path, "{");
  for (const computer of [here, there]) {
    expect(await scheduleComputer(root, computer)).toMatchObject({ kind: "unreadable" });
  }
  expect(await readFile(path, "utf8")).toBe("{");
});

it("refuses to load or install over a cut-off key", async () => {
  const root = await fixture();
  const path = join(root, SECRET_KEY_RELATIVE_PATH);
  await writeFile(path, "dohc-secret-key-v1:AA");
  for (const createIfMissing of [false, true]) {
    await expect(loadSecretDataKey(root, { createIfMissing })).rejects.toMatchObject({ code: "key-corrupt" });
  }
  await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 1))).rejects.toThrow("malformed");
  expect(await readFile(path, "utf8")).toBe("dohc-secret-key-v1:AA");
});

it.each(["history", "schedules", "load-key", "install-key"] as const)("an interrupted %s write leaves no destination or temporary file", async (kind) => {
  const root = await fixture();
  if (kind === "schedules") await writeFile(join(root, ".dohc", "sync-history.json"), legacy);
  const path = join(root, kind === "history" ? ".dohc/sync-history.json"
    : kind === "schedules" ? ".dohc/sync-history/schedules.json" : SECRET_KEY_RELATIVE_PATH);
  const before = await readdir(dirname(path));
  fault.write = true;
  if (kind === "history") await expect(recordNeverSynced(root, here)).rejects.toThrow();
  if (kind === "schedules") expect(await scheduleComputer(root, here)).toMatchObject({ kind: "unreadable" });
  if (kind === "load-key") await expect(loadSecretDataKey(root, { createIfMissing: true })).rejects.toMatchObject({ code: "key-corrupt" });
  if (kind === "install-key") await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 1))).rejects.toMatchObject({ code: "key-corrupt" });
  expect(await readdir(dirname(path))).toEqual(before);
});

it("concurrent readers agree on one schedules host and one generated key", async () => {
  const root = await fixture();
  await writeFile(join(root, ".dohc", "sync-history.json"), legacy);
  const hosts = await Promise.all([scheduleComputer(root, here), scheduleComputer(root, there)]);
  expect(hosts[0]).toEqual(hosts[1]);
  expect(hosts[0]).toMatchObject({ kind: "computer" });
  const keys = await Promise.all([loadSecretDataKey(root, { createIfMissing: true }), loadSecretDataKey(root, { createIfMissing: true })]);
  expect(keys[0]).toEqual(keys[1]);
  expect(await readdir(join(root, ".dohc", "engine"))).toEqual(["secret.key"]);
  expect(await readdir(join(root, ".dohc", "sync-history"))).toEqual(["schedules.json"]);
});
