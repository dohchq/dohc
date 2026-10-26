import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { atomicReplaceFile, atomicReplaceFileSync } from "./atomicReplaceFile";
import { createTestScratch } from "./workspaces/testTemp";

interface Dependencies {
  rename: (source: string, destination: string) => void;
  wait: (milliseconds: number) => void;
  platform: NodeJS.Platform;
}

type Replace = (
  destination: string,
  write: (temporary: string) => void,
  dependencies: Dependencies,
) => void | Promise<void>;

const variants: { name: string; replace: Replace }[] = [
  { name: "synchronous", replace: atomicReplaceFileSync },
  {
    name: "asynchronous",
    replace: (destination, write, dependencies) => atomicReplaceFile(
      destination,
      async (temporary) => { write(temporary); },
      {
        platform: dependencies.platform,
        rename: async (source, target) => { dependencies.rename(source, target); },
        wait: async (milliseconds) => { dependencies.wait(milliseconds); },
      },
    ),
  },
];

describe.each(variants)("$name atomic replacement", ({ replace }) => {
  let directory: string;
  let destination: string;
  let write: ReturnType<typeof vi.fn<(temporary: string) => void>>;
  let dependencies: Dependencies;

  beforeEach(async () => {
    directory = await createTestScratch("dohc-atomic-replace-");
    destination = join(directory, "state.json");
    writeFileSync(destination, "previous");
    write = vi.fn((temporary: string) => { writeFileSync(temporary, "next"); });
    dependencies = { rename: vi.fn(renameSync), wait: vi.fn(), platform: "win32" };
  });

  const run = async () => { await replace(destination, write, dependencies); };

  it("replaces an existing file without waiting on success", async () => {
    await run();
    expect(dependencies.rename).toHaveBeenCalledTimes(1);
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(readFileSync(destination, "utf8")).toBe("next");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("retries transient %s errors without rewriting the temp file", async (code) => {
    const error = Object.assign(new Error("destination locked"), { code });
    const rename = vi.fn((source: string, target: string) => {
      expect(readFileSync(target, "utf8")).toBe("previous");
      expect(readFileSync(source, "utf8")).toBe("next");
      if (rename.mock.calls.length <= 3) throw error;
      renameSync(source, target);
    });
    dependencies.rename = rename;

    await run();

    expect(rename).toHaveBeenCalledTimes(4);
    expect(vi.mocked(dependencies.wait).mock.calls).toEqual([[8], [16], [32]]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(readFileSync(destination, "utf8")).toBe("next");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("stops after six attempts, removes the temp file, and rethrows the final error", async () => {
    const errors = Array.from({ length: 6 }, (_, attempt) =>
      Object.assign(new Error(`locked on attempt ${attempt}`), { code: "EPERM" }),
    );
    const rename = vi.fn(() => { throw errors[rename.mock.calls.length - 1]; });
    dependencies.rename = rename;

    await expect(run()).rejects.toBe(errors[5]);

    expect(rename).toHaveBeenCalledTimes(6);
    expect(vi.mocked(dependencies.wait).mock.calls).toEqual([[8], [16], [32], [64], [128]]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(readFileSync(destination, "utf8")).toBe("previous");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("does not retry a non-retryable error and removes the temp file", async () => {
    const error = Object.assign(new Error("missing destination directory"), { code: "ENOENT" });
    dependencies.rename = vi.fn(() => { throw error; });

    await expect(run()).rejects.toBe(error);

    expect(dependencies.rename).toHaveBeenCalledTimes(1);
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(readFileSync(destination, "utf8")).toBe("previous");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("does not retry Windows error codes on other platforms", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
    dependencies.platform = "linux";
    dependencies.rename = vi.fn(() => { throw error; });

    await expect(run()).rejects.toBe(error);

    expect(dependencies.rename).toHaveBeenCalledTimes(1);
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("cleans a partial write without retrying or replacing the destination", async () => {
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    write.mockImplementation((temporary) => {
      writeFileSync(temporary, "partial");
      throw error;
    });

    await expect(run()).rejects.toBe(error);

    expect(dependencies.rename).not.toHaveBeenCalled();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(readFileSync(destination, "utf8")).toBe("previous");
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });
});

describe("durable asynchronous replacement", () => {
  it("keeps the old file whole across a process death before rename, then retries", async () => {
    const directory = await createTestScratch("atomic-replace-crash-");
    const destination = join(directory, "note.txt");
    const temporary = join(directory, ".dohc-write-crashed");
    const childPath = join(directory, "crash.mjs");
    writeFileSync(destination, "previous");
    const moduleUrl = new URL("./atomicReplaceFile.ts", import.meta.url).href;
    await writeFile(childPath, `
      import { open } from 'node:fs/promises';
      import { atomicReplaceFile } from ${JSON.stringify(moduleUrl)};
      await atomicReplaceFile(${JSON.stringify(destination)}, async temporary => {
        const file = await open(temporary, 'wx');
        await file.writeFile('next'); await file.sync(); await file.close();
        process.send({ temporary });
        await new Promise(() => {});
      }, { temporary: ${JSON.stringify(temporary)} });
    `);
    const child = fork(pathToFileURL(childPath), [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
    try {
      const [message] = await once(child, "message");
      child.kill("SIGKILL");
      await once(child, "exit");
      expect(message.temporary).toBe(temporary);
      expect(readFileSync(destination, "utf8")).toBe("previous");
      expect(readFileSync(temporary, "utf8")).toBe("next");
      await atomicReplaceFile(destination, async next => { await writeFile(next, "next"); }, {
        temporary: join(directory, ".dohc-write-retry"),
      });
      expect(readFileSync(destination, "utf8")).toBe("next");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it("removes a caller-named sibling after a blocked rename", async () => {
    const directory = await createTestScratch("atomic-replace-named-");
    const destination = join(directory, "note.txt");
    const temporary = join(directory, ".dohc-write-blocked");
    writeFileSync(destination, "previous");
    await expect(atomicReplaceFile(destination, async path => {
      expect(path).toBe(temporary);
      await writeFile(path, "next");
    }, { temporary, platform: "win32", wait: async () => {}, rename: async () => {
      throw Object.assign(new Error("held open"), { code: "EPERM" });
    } })).rejects.toThrow("held open");
    expect(readdirSync(directory)).toEqual(["note.txt"]);
    expect(readFileSync(destination, "utf8")).toBe("previous");
  });

  it.each(["linux", "darwin", "win32"] as const)("syncs the directory after rename on %s only", async (platform) => {
    const destination = join(await createTestScratch("durable-replace-"), "state.json");
    const events: string[] = [];
    await atomicReplaceFile(destination, async () => { events.push("write"); }, {
      platform,
      syncDirectory: true,
      rename: async () => { events.push("rename"); },
      open: async (path, flags) => {
        expect(path).toBe(dirname(destination));
        expect(flags).toBe("r");
        events.push("open directory");
        return { sync: async () => { events.push("sync directory"); }, close: async () => { events.push("close directory"); } };
      },
    });
    expect(events).toEqual(platform === "win32" ? ["write", "rename"]
      : ["write", "rename", "open directory", "sync directory", "close directory"]);
  });

  it("keeps the default path free of directory sync", async () => {
    const open = vi.fn();
    await atomicReplaceFile("unused", async () => {}, { platform: "linux", rename: async () => {}, open });
    expect(open).not.toHaveBeenCalled();
  });

  it("closes a directory whose sync fails and surfaces the error without retrying the rename", async () => {
    const error = new Error("directory sync failed");
    const close = vi.fn(async () => { throw new Error("close also failed"); });
    const rename = vi.fn(async () => {});
    await expect(atomicReplaceFile("unused", async () => {}, {
      platform: "linux", syncDirectory: true, rename,
      open: async () => ({ sync: async () => { throw error; }, close }),
    })).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
