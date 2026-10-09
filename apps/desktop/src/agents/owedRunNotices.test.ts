import { open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createOwedRunNotices } from "./owedRunNotices";

describe("owed run notices", () => {
  it("syncs and closes the temporary file before rename and caller completion", async () => {
    const path = join(await createTestScratch("owed-durable-"), "owed.json");
    const events: string[] = [];
    let completed = 0;
    let beginSync!: () => void;
    let releaseSync!: () => void;
    const started = new Promise<void>(resolve => { beginSync = resolve; });
    const released = new Promise<void>(resolve => { releaseSync = resolve; });
    const owed = createOwedRunNotices(() => path, {
      platform: "win32",
      open: async (...args) => {
        const handle = await open(...args);
        return {
          writeFile: async (data) => { events.push("write"); await handle.writeFile(data); },
          sync: async () => { events.push("sync"); beginSync(); await released; await handle.sync(); },
          close: async () => { events.push("close"); await handle.close(); },
        };
      },
      rename: async (...args) => { events.push("rename"); await rename(...args); },
    });
    const saved = owed.add("trip", "run-1").then(() => { completed += 1; });
    try {
      await Promise.race([started, saved]);
      expect(events).toEqual(["write", "sync"]);
      expect(completed).toBe(0);
    } finally {
      releaseSync();
      await saved;
    }
    expect(events).toEqual(["write", "sync", "close", "rename"]);
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual(["run-1"]);
  });

  it.each(["add", "remove"] as const)("reloads after directory sync fails following an %s rename", async (operation) => {
    const path = join(await createTestScratch("owed-directory-sync-failure-"), "owed.json");
    await writeFile(path, JSON.stringify([["trip", "first"]]));
    const error = new Error("directory sync failed");
    let fail = true;
    const directoryClose = vi.fn(async () => {});
    const owed = createOwedRunNotices(() => path, {
      platform: "linux",
      open: async (path, flags, mode) => flags === "r"
        ? { writeFile: async () => {}, sync: async () => { if (fail) throw error; }, close: directoryClose }
        : open(path, flags, mode),
    });
    expect(await owed.list("trip")).toEqual(["first"]);
    await expect(operation === "add" ? owed.add("trip", "second") : owed.remove("trip", "first")).rejects.toBe(error);
    expect(directoryClose).toHaveBeenCalledOnce();
    const replaced = operation === "add" ? ["first", "second"] : [];
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual(replaced);
    fail = false;
    // Go straight to another change, so stale cache contents would overwrite the renamed file.
    await owed.add("trip", "next");
    expect(await owed.list("trip")).toEqual([...replaced, "next"]);
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual([...replaced, "next"]);
  });

  it("keeps disk and memory unchanged when temp sync fails and allows a retry", async () => {
    const path = join(await createTestScratch("owed-sync-failure-"), "owed.json");
    await writeFile(path, JSON.stringify([["trip", "first"]]));
    const error = new Error("sync failed");
    let fail = true;
    const close = vi.fn();
    const owed = createOwedRunNotices(() => path, {
      open: async (...args) => {
        const handle = await open(...args);
        return { writeFile: handle.writeFile.bind(handle), sync: async () => { if (fail) throw error; await handle.sync(); },
          close: async () => { close(); await handle.close(); if (fail) throw new Error("close also failed"); } };
      },
    });
    await expect(owed.remove("trip", "first")).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(path, "utf8")).toBe(JSON.stringify([["trip", "first"]]));
    expect(await owed.list("trip")).toEqual(["first"]);
    expect(await readdir(join(path, ".."))).toEqual(["owed.json"]);
    fail = false;
    await owed.remove("trip", "first");
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual([]);
  });
  it("keeps each owed run in its file until it is removed", async () => {
    const path = join(await createTestScratch("dohc-owed-run-notices-"), "state", "owed-run-notices.json");
    const owed = createOwedRunNotices(() => path);
    await Promise.all([owed.add("trip", "run-1"), owed.add("trip", "run-1"), owed.add("work", "run-2")]);

    const reopened = createOwedRunNotices(() => path);
    expect(await reopened.list("trip")).toEqual(["run-1"]);
    expect(await reopened.list("work")).toEqual(["run-2"]);

    await owed.remove("trip", "run-1");
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual([]);
  });

  it("changes nothing when its file cannot be written, so the change can be tried again", async () => {
    const root = await createTestScratch("dohc-owed-run-notices-");
    const good = join(root, "owed-run-notices.json");
    const blocker = join(root, "blocker");
    await writeFile(blocker, "");
    let path = good;
    const owed = createOwedRunNotices(() => path);
    await owed.add("trip", "run-1");

    path = join(blocker, "owed-run-notices.json");
    await expect(owed.remove("trip", "run-1")).rejects.toThrow();
    expect(await owed.list("trip")).toEqual(["run-1"]);

    path = good;
    await owed.remove("trip", "run-1");
    expect(await createOwedRunNotices(() => good).list("trip")).toEqual([]);
  });

  it("sets a damaged file aside and starts empty", async () => {
    const root = await createTestScratch("dohc-owed-run-notices-");
    const path = join(root, "owed-run-notices.json");
    await writeFile(path, "{not json");
    const owed = createOwedRunNotices(() => path);
    expect(await owed.list("trip")).toEqual([]);
    await owed.add("trip", "run-1");
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual(["run-1"]);
    expect((await readdir(root)).sort()).toEqual(["owed-run-notices.json", "owed-run-notices.json.damaged"]);
  });
});
