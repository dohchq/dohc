import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSyncHistory, recordNeverSynced, scheduleComputer } from "./syncHistory";
import { installWorkspaceDataKey, loadSecretDataKey, SECRET_KEY_RELATIVE_PATH } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

const fault = vi.hoisted(() => ({ write: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (!fault.write) return fs.writeFile(...args);
      await fs.writeFile(args[0], "{", args[2]);
      throw new Error("interrupted write");
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
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
afterEach(() => { fault.write = false; });

const here = { installId: "here", label: "Here" };
const there = { installId: "there", label: "There" };
const legacy = '{"version":1,"synced":false,"receivedShare":false}\n';
async function fixture() {
  const root = await createTestScratch("dohc-durable-records-");
  await mkdir(join(root, ".dohc", "engine"), { recursive: true });
  await mkdir(join(root, ".dohc", "sync-history"));
  return root;
}

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
