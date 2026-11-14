import { describe, expect, it, vi } from "vitest";
import type { NativeDurableFile } from "../../modules/durable-file";
import { createDurableFiles, DurableFileError, RECORD_MAX_BYTES } from "./durableFiles";
import { durableDisk } from "./testDurableDisk";

/** One run of the app over `disk`. */
const launch = (disk: ReturnType<typeof durableDisk>) => createDurableFiles(disk.launch());
const temporaries = (disk: ReturnType<typeof durableDisk>) =>
  disk.names().filter((name) => name.endsWith(".tmp"));
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
const kindOf = async (promise: Promise<unknown>) => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(DurableFileError);
  return error instanceof DurableFileError ? error.kind : null;
};

describe("a record", () => {
  it("survives a relaunch once its write resolves, and leaves no temporary file", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", '{"body":"Hello"}');
    await files.write("op-2", '{"body":"Bonjour, é 🙂"}');

    const next = launch(disk);
    await expect(next.read("op-1")).resolves.toBe('{"body":"Hello"}');
    await expect(next.read("op-2")).resolves.toBe('{"body":"Bonjour, é 🙂"}');
    await expect(next.list()).resolves.toEqual(["op-1", "op-2"]);
    await expect(next.read("op-3")).resolves.toBeNull();
    expect(temporaries(disk)).toEqual([]);
  });

  it("is replaced only once the new text is whole", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", "before");

    const release = disk.holdWrites();
    const writing = files.write("op-1", "after, and longer");
    await vi.waitFor(() => expect(temporaries(disk)).toHaveLength(1));
    // Half the new text is on disk, and another run still reads the whole previous record.
    await expect(launch(disk).read("op-1")).resolves.toBe("before");
    release();
    await writing;
    await expect(launch(disk).read("op-1")).resolves.toBe("after, and longer");
    expect(disk.names()).toEqual(["op-1"]);
  });

  it("keeps the previous record when a write fails, and the write rejects", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", "before");
    disk.failWrites = "write";
    expect(await kindOf(files.write("op-1", "after"))).toBe("failed");
    expect(await kindOf(files.write("op-2", "new"))).toBe("failed");

    disk.failWrites = null;
    const next = launch(disk);
    await expect(next.read("op-1")).resolves.toBe("before");
    await expect(next.read("op-2")).resolves.toBeNull();
    await expect(next.recover()).resolves.toEqual({ leftovers: [], unreadable: [] });
    expect(disk.names()).toEqual(["op-1"]);
  });

  it("rejects as unsynced when the folder sync after the rename fails", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", "before");
    disk.failWrites = "sync-folder";
    // The new record may stand, but isn't known to survive power loss, so the caller can't count it as saved.
    expect(await kindOf(files.write("op-1", "after"))).toBe("unsynced");
  });

  it("is kept whole by a write cut off part way, whose temporary file recovery reports and keeps", async () => {
    const disk = durableDisk();
    await launch(disk).write("op-1", "before");

    // The app closes while the write is half done: its promise never settles.
    disk.holdWrites();
    void launch(disk).write("op-1", "after, never finished");
    await vi.waitFor(() => expect(temporaries(disk)).toHaveLength(1));
    disk.crash();
    const [temp] = temporaries(disk);

    const next = launch(disk);
    await expect(next.read("op-1")).resolves.toBe("before");
    await expect(next.list()).resolves.toEqual(["op-1"]);
    await expect(next.recover()).resolves.toEqual({ leftovers: [temp], unreadable: [] });
    await expect(next.recover()).resolves.toEqual({ leftovers: [temp], unreadable: [] });
    expect(disk.names()).toEqual(["op-1", temp].sort());

    // Only an explicit call removes it.
    await next.removeLeftover(temp);
    expect(disk.names()).toEqual(["op-1"]);
  });

  it("can be written again after a crash, and the crashed run's write never lands", async () => {
    const disk = durableDisk();
    await launch(disk).write("op-1", "before");
    disk.holdWrites();
    let settled = false;
    void launch(disk)
      .write("op-1", "from the run that crashed")
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(temporaries(disk)).toHaveLength(1));
    disk.crash();

    const next = launch(disk);
    const { leftovers } = await next.recover();
    expect(leftovers).toHaveLength(1);
    await next.removeLeftover(leftovers[0]!);
    await next.write("op-1", "after the crash");
    await next.write("op-2", "new");

    await expect(launch(disk).read("op-1")).resolves.toBe("after the crash");
    await expect(launch(disk).list()).resolves.toEqual(["op-1", "op-2"]);
    expect(temporaries(disk)).toEqual([]);
    expect(settled).toBe(false);
  });
});

describe("the fake disk's other faults", () => {
  it("fails a write at folder preparation before any temporary file, and the next write succeeds", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", "before");
    disk.failWrites = "prepare";
    expect(await kindOf(files.write("op-1", "after"))).toBe("failed");
    expect(disk.names()).toEqual(["op-1"]);
    disk.failWrites = null;
    await files.write("op-1", "after");
    await expect(files.read("op-1")).resolves.toBe("after");
  });

  it("rejects reads and recovery as locked while the phone hasn't been unlocked, without calling records unreadable", async () => {
    const disk = durableDisk();
    await launch(disk).write("op-1", "one");
    disk.locked = true;
    const files = launch(disk);
    expect(await kindOf(files.recover())).toBe("locked");
    expect(await kindOf(files.read("op-1"))).toBe("locked");
    expect(await kindOf(files.write("op-2", "two"))).toBe("failed");
    await expect(files.list()).resolves.toEqual(["op-1"]);
    disk.locked = false;
    await expect(files.recover()).resolves.toEqual({ leftovers: [], unreadable: [] });
    await expect(files.read("op-1")).resolves.toBe("one");
  });

  it("fails a delete at the unlink, keeping the record, or after it, at the folder sync", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", "one");
    disk.failRemoves = "unlink";
    expect(await kindOf(files.remove("op-1"))).toBe("failed");
    await expect(files.read("op-1")).resolves.toBe("one");
    disk.failRemoves = "sync-folder";
    // The delete may stand, but isn't known to survive power loss.
    expect(await kindOf(files.remove("op-1"))).toBe("unsynced");
    await expect(files.read("op-1")).resolves.toBeNull();
  });
});

describe("deleting a record", () => {
  it("lasts across a relaunch, and deleting a missing record resolves", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("op-1", "one");
    await files.write("op-2", "two");
    await files.remove("op-1");
    await files.remove("op-9");

    const next = launch(disk);
    await expect(next.read("op-1")).resolves.toBeNull();
    await expect(next.list()).resolves.toEqual(["op-2"]);
  });

  it("lands after a write made before it that's still on its way", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    const release = disk.holdWrites();
    const writing = files.write("op-1", "one");
    const removing = files.remove("op-1");
    release();
    await Promise.all([writing, removing]);
    await expect(launch(disk).read("op-1")).resolves.toBeNull();
    expect(disk.log).toEqual(["write op-1", "remove op-1", "read op-1"]);
  });
});

describe("recovery", () => {
  it("reports unreadable records and leftovers, and deletes none of them", async () => {
    const disk = durableDisk();
    const temp = `op-3.${"a".repeat(32)}.tmp`;
    disk.files.set("op-1", "fine");
    disk.files.set("op-2", "damaged");
    disk.unreadable.add("op-2");
    disk.files.set("op-4", "x".repeat(RECORD_MAX_BYTES + 1));
    disk.files.set(temp, "half");
    disk.files.set("notes.txt", "not ours");
    const before = disk.names();

    const files = launch(disk);
    await expect(files.recover()).resolves.toEqual({
      leftovers: ["notes.txt", temp],
      unreadable: ["op-2", "op-4"],
    });
    expect(disk.names()).toEqual(before);
    // An unreadable record stays listed, rejects its read, and goes only when it's deleted, as Discard will.
    await expect(files.list()).resolves.toEqual(["op-1", "op-2", "op-4"]);
    expect(await kindOf(files.read("op-2"))).toBe("unreadable");
    expect(await kindOf(files.read("op-4"))).toBe("unreadable");
    await expect(files.read("op-1")).resolves.toBe("fine");
    await files.remove("op-2");
    await expect(files.recover()).resolves.toEqual({
      leftovers: ["notes.txt", temp],
      unreadable: ["op-4"],
    });
    // A leftover that isn't one of the module's temporary files can't be removed.
    expect(await kindOf(files.removeLeftover("notes.txt"))).toBe("invalid");
    expect(await kindOf(files.removeLeftover("op-1"))).toBe("invalid");
    expect(await kindOf(files.removeLeftover(`${temp}\n`))).toBe("invalid");
    expect(disk.names()).toContain("notes.txt");
    expect(disk.names()).toContain(temp);
  });

  it("reads a record again once it is written over an unreadable one", async () => {
    const disk = durableDisk();
    disk.files.set("op-1", "damaged");
    disk.unreadable.add("op-1");
    const files = launch(disk);
    await files.write("op-1", "whole");
    await expect(files.read("op-1")).resolves.toBe("whole");
    await expect(files.recover()).resolves.toEqual({ leftovers: [], unreadable: [] });
  });
});

describe("names and sizes", () => {
  it('refuses a name outside letters, digits, "-" and "_", or longer than 100, before reaching the disk', async () => {
    const disk = durableDisk();
    const files = launch(disk);
    // "op-1\n" pins that the pattern's "$" doesn't match before a final newline.
    for (const name of [
      "",
      "a/b",
      "../op",
      ".",
      "op.json",
      "op 1",
      "é",
      "op\u0000",
      "op-1\n",
      "x".repeat(101),
    ]) {
      expect(await kindOf(files.write(name, "text")), name).toBe("invalid");
      expect(await kindOf(files.read(name)), name).toBe("invalid");
      expect(await kindOf(files.remove(name)), name).toBe("invalid");
    }
    expect(disk.log).toEqual([]);
    await files.write("x".repeat(100), "longest");
    await files.write("A-z_09", "mixed");
    await expect(files.list()).resolves.toEqual(["A-z_09", "x".repeat(100)]);
  });

  it("holds a record of exactly the bound in UTF-8 bytes, and refuses one byte more before reaching the disk", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    await files.write("ascii", "a".repeat(RECORD_MAX_BYTES));
    await files.write("two-byte", "é".repeat(RECORD_MAX_BYTES / 2));
    await files.write("four-byte", "🙂".repeat(RECORD_MAX_BYTES / 4));
    disk.log.length = 0;

    expect(await kindOf(files.write("ascii", "a".repeat(RECORD_MAX_BYTES + 1)))).toBe("too-large");
    expect(await kindOf(files.write("two-byte", "é".repeat(RECORD_MAX_BYTES / 2) + "a"))).toBe(
      "too-large",
    );
    expect(
      await kindOf(files.write("three-byte", "€".repeat(Math.floor(RECORD_MAX_BYTES / 3) + 1))),
    ).toBe("too-large");
    expect(await kindOf(files.write("four-byte", "🙂".repeat(RECORD_MAX_BYTES / 4) + "a"))).toBe(
      "too-large",
    );
    expect(disk.log).toEqual([]);
    await expect(files.read("ascii")).resolves.toHaveLength(RECORD_MAX_BYTES);
  });

  it("refuses text with a lone surrogate, which UTF-8 can't hold", async () => {
    const disk = durableDisk();
    const files = launch(disk);
    for (const text of ["\ud800", "a\ud83d", "\ude42b", "\ude42\ud83d"]) {
      expect(await kindOf(files.write("op-1", text)), JSON.stringify(text)).toBe("invalid");
    }
    expect(disk.log).toEqual([]);
  });
});

describe("native errors", () => {
  it("become a DurableFileError whose kind comes from the native code", async () => {
    const failing = (error: unknown): NativeDurableFile => ({
      write: () => Promise.reject(error),
      read: () => Promise.reject(error),
      list: () => Promise.reject(error),
      remove: () => Promise.reject(error),
      recover: () => Promise.reject(error),
      removeLeftover: () => Promise.reject(error),
    });
    const coded = (code: string) => Object.assign(new Error("native"), { code });
    const cases: [unknown, DurableFileError["kind"]][] = [
      [coded("ERR_DURABLE_LOCKED"), "locked"],
      [coded("ERR_DURABLE_UNREADABLE"), "unreadable"],
      [coded("ERR_DURABLE_UNSYNCED"), "unsynced"],
      [coded("ERR_DURABLE_TOO_LARGE"), "too-large"],
      [coded("ERR_DURABLE_INVALID"), "invalid"],
      [coded("ERR_DURABLE_FAILED"), "failed"],
      [coded("ERR_UNEXPECTED"), "failed"],
      [new Error("no code"), "failed"],
      ["a string", "failed"],
    ];
    for (const [error, kind] of cases) {
      const files = createDurableFiles(failing(error));
      expect(await kindOf(files.recover())).toBe(kind);
      expect(await kindOf(files.read("op-1"))).toBe(kind);
    }
  });
});
