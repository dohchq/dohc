import { link, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicCreateFile } from "./atomicReplaceFile";
import { createTestScratch } from "./workspaces/testTemp";

describe("durable create-once publication", () => {
  it("flushes and closes complete bytes before linking, then removes the sibling and flushes the directory", async () => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "record");
    const events: string[] = [];
    const created = await atomicCreateFile(path, "complete", 0o600, {
      platform: "linux",
      open: async (name, flags, mode) => {
        if (name === root) {
          expect(flags).toBe("r");
          expect(await readdir(root)).toEqual(["record"]);
          return {
            writeFile: async () => { throw new Error("directory write"); },
            sync: async () => { events.push("directory sync"); },
            close: async () => { events.push("directory close"); },
          };
        }
        expect(dirname(name)).toBe(root);
        expect(flags).toBe("wx");
        expect(mode).toBe(0o600);
        const handle = await open(name, flags, mode);
        return {
          writeFile: async (data) => {
            await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
            await handle.writeFile(data);
            events.push("write");
          },
          sync: async () => { await handle.sync(); events.push("file sync"); },
          close: async () => { await handle.close(); events.push("file close"); },
        };
      },
      link: async (source, destination) => {
        expect(await readFile(source, "utf8")).toBe("complete");
        events.push("link");
        await link(source, destination);
      },
    });
    expect(created).toBe(true);
    expect(events).toEqual(["write", "file sync", "file close", "link", "directory sync", "directory close"]);
    expect(await readFile(path, "utf8")).toBe("complete");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing winner, including an empty or cut-off file", async () => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "record");
    for (const existing of ["", "{", "winner"]) {
      await writeFile(path, existing);
      expect(await atomicCreateFile(path, "loser", 0o666)).toBe(false);
      expect(await readFile(path, "utf8")).toBe(existing);
      expect(await readdir(root)).toEqual(["record"]);
    }
  });

  it.each(["write", "sync", "close", "link"] as const)("a failed %s leaves neither destination nor temporary file", async (phase) => {
    const root = await createTestScratch("dohc-create-once-");
    const failure = Object.assign(new Error(phase), { code: "EIO" });
    await expect(atomicCreateFile(join(root, "record"), "complete", 0o600, {
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          writeFile: async (data) => {
            if (phase === "write") { await handle.writeFile("{"); throw failure; }
            await handle.writeFile(data);
          },
          sync: async () => {
            if (phase === "sync") throw failure;
            await handle.sync();
          },
          close: async () => {
            await handle.close();
            if (phase === "close") throw failure;
          },
        };
      },
      link: async (source, destination) => {
        if (phase === "link") throw failure;
        await link(source, destination);
      },
    })).rejects.toBe(failure);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses unsupported hard links without a direct-write fallback", async () => {
    const root = await createTestScratch("dohc-create-once-");
    const failure = Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
    await expect(atomicCreateFile(join(root, "record"), "key", 0o600, {
      link: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["ENOTSUP", "EACCES", "EIO"])("allows an exclusive-write fallback after %s, preserving a racing winner", async (code) => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "record");
    expect(await atomicCreateFile(path, "loser", 0o666, {
      directWriteAfter: () => true,
      link: async () => {
        await writeFile(path, "winner");
        throw Object.assign(new Error(code), { code });
      },
    })).toBe(false);
    expect(await readFile(path, "utf8")).toBe("winner");
    expect(await readdir(root)).toEqual(["record"]);
  });

  it.each(["write", "sync"] as const)("a failed fallback %s removes its new entry and allows a retry", async (phase) => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "record.json");
    const payload = '{"version":1}\n';
    const failure = Object.assign(new Error(phase), { code: phase === "write" ? "ENOSPC" : "EIO" });
    let fail = true;
    const dependencies = {
      directWriteAfter: () => true,
      link: async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); },
      open: async (name: string, flags: string, mode?: number) => {
        const handle = await open(name, flags, mode);
        if (name !== path) return handle;
        return {
          writeFile: async (data: string) => {
            if (fail && phase === "write") { await handle.writeFile("{"); throw failure; }
            await handle.writeFile(data);
          },
          sync: async () => {
            if (fail && phase === "sync") throw failure;
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    };
    await expect(atomicCreateFile(path, payload, 0o666, dependencies)).rejects.toBe(failure);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
    fail = false;
    expect(await atomicCreateFile(path, payload, 0o666, dependencies)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(payload);
    expect(await readdir(root)).toEqual(["record.json"]);
  });

  it("still flushes the folder when removing a published key's temporary file fails", async () => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "secret.key");
    const events: string[] = [];
    expect(await atomicCreateFile(path, "key", 0o600, {
      platform: "linux",
      rm: async () => { events.push("remove"); throw new Error("denied"); },
      open: async (name, flags, mode) => name === root ? {
        writeFile: async () => {},
        sync: async () => { events.push("directory sync"); },
        close: async () => { events.push("directory close"); },
      } : open(name, flags, mode),
    })).toBe(true);
    expect(events).toEqual(["remove", "directory sync", "directory close"]);
    expect(await readFile(path, "utf8")).toBe("key");
  });

  it("reports directory sync failure without deleting the published winner", async () => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "record");
    const failure = new Error("directory sync");
    let closed = false;
    await expect(atomicCreateFile(path, "winner", 0o600, {
      platform: "linux",
      open: async (name, flags, mode) => name === root ? {
        writeFile: async () => {},
        sync: async () => { throw failure; },
        close: async () => { closed = true; },
      } : open(name, flags, mode),
    })).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("winner");
    expect(await readdir(root)).toEqual(["record"]);
  });

  it("two concurrent creators publish one complete winner and read the same answer", async () => {
    const root = await createTestScratch("dohc-create-once-");
    const path = join(root, "record");
    const payloads = ["first", "second"];
    const results = await Promise.all(payloads.map(async (payload) => ({
      created: await atomicCreateFile(path, payload, 0o600),
      answer: await readFile(path, "utf8"),
    })));
    expect(results.filter(result => result.created)).toHaveLength(1);
    const winner = results.findIndex(result => result.created);
    expect(results.map(result => result.answer)).toEqual([payloads[winner], payloads[winner]]);
    expect(await readdir(root)).toEqual(["record"]);
  });
});
