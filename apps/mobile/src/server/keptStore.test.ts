import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { KeptStore } from "./keptStore";
import { keptDisk } from "./testKeptDisk";

const SETTINGS = [
  "journal_mode",
  "synchronous",
  "fullfsync",
  "checkpoint_fullfsync",
  "secure_delete",
  "busy_timeout",
];
const insert = (store: KeptStore) =>
  store.transaction((sql) =>
    sql.run("INSERT INTO outbox (origin, account_id, record) VALUES ('o', 'u-1', '{}')", []),
  );

describe("kept.db", () => {
  it("sets each durability setting at open and reads it back", async () => {
    const store = keptDisk().launch();
    const read = await Promise.all(SETTINGS.map((name) => store.read(`PRAGMA ${name}`, [])));
    expect(read.map(([row]) => Object.values(row ?? {})[0])).toEqual(["wal", 2, 1, 1, 1, 5000]);
  });

  it.each(SETTINGS)(
    "refuses to open, writing nothing, when %s doesn't read back as set, and opens once it does",
    async (setting) => {
      const disk = keptDisk();
      disk.ignored.add(setting);
      const store = disk.launch();
      await expect(insert(store)).rejects.toMatchObject({ kind: "refused" });
      expect(disk.rows()).toEqual([]);
      disk.ignored.delete(setting);
      await insert(store);
      expect(disk.rows()).toEqual([1]);
    },
  );

  it("calls a phone not unlocked since it started locked, never damaged, and opens the same file once unlocked", async () => {
    const disk = keptDisk();
    await insert(disk.launch());
    disk.crash();
    const before = readFileSync(disk.path);
    disk.locked = true;
    const store = disk.launch();
    await expect(store.read("SELECT sequence FROM outbox", [])).rejects.toMatchObject({
      kind: "locked",
    });
    expect(readFileSync(disk.path)).toEqual(before);
    disk.locked = false;
    await expect(store.read("SELECT sequence FROM outbox", [])).resolves.toEqual([{ sequence: 1 }]);
  });

  it("calls a damaged file damaged, never replaces it, and starts again only after destroy", async () => {
    const disk = keptDisk();
    writeFileSync(disk.path, "not a database ".repeat(400));
    const before = readFileSync(disk.path);
    const store = disk.launch();
    for (let i = 0; i < 2; i++)
      await expect(insert(store)).rejects.toMatchObject({ kind: "damaged" });
    expect(readFileSync(disk.path)).toEqual(before);
    await store.destroy();
    await insert(store);
    expect(disk.rows()).toEqual([1]);
  });

  it("reopens after the app died mid-transaction, without that transaction's rows, and writes after them", async () => {
    const disk = keptDisk();
    await insert(disk.launch());
    disk.crash();
    // A process inserts more than its page cache holds, so uncommitted pages reach the WAL, then is killed.
    const killed = spawnSync(process.execPath, [
      "--no-warnings",
      "-e",
      `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
      db.exec("PRAGMA cache_size = 1; BEGIN IMMEDIATE");
      const row = db.prepare("INSERT INTO outbox (origin, account_id, record) VALUES ('o', 'u-1', ?)");
      for (let i = 0; i < 200; i++) row.run("x".repeat(4000));
      process.kill(process.pid, "SIGKILL");`,
      disk.path,
    ]);
    expect(killed.signal).toBe("SIGKILL");
    expect(statSync(`${disk.path}-wal`).size).toBeGreaterThan(4000);
    const store = disk.launch();
    await expect(store.read("SELECT sequence FROM outbox", [])).resolves.toEqual([{ sequence: 1 }]);
    await insert(store);
    expect(disk.rows()).toEqual([1, 2]);
  });

  it("rolls back a failed statement, and calls a failed commit uncertain whether or not it stood", async () => {
    const disk = keptDisk();
    const store = disk.launch();
    disk.failWrites = /INSERT/;
    await expect(insert(store)).rejects.toMatchObject({ kind: "failed" });
    disk.failWrites = null;
    disk.failCommits = { match: /INSERT/, lands: false };
    await expect(insert(store)).rejects.toMatchObject({ kind: "uncertain" });
    expect(disk.rows()).toEqual([]);
    disk.failCommits = { match: /INSERT/, lands: true };
    await expect(insert(store)).rejects.toMatchObject({ kind: "uncertain" });
    expect(disk.rows()).toHaveLength(1);
    disk.failCommits = null;
    await insert(store);
    expect(disk.rows()).toHaveLength(2);
  });
});
