import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { link, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { openedLocalState } from "../testing/preparedLocalState";
import { createTestScratch } from "./testTemp";
import { outsideWriteCopies, OutsideWriteCopyError } from "./outsideWriteCopies";
import * as durableFiles from "../atomicReplaceFile";
import * as realPaths from "./workspaceRealPath";

vi.mock("../atomicReplaceFile", { spy: true });
vi.mock("node:fs/promises", { spy: true });
vi.mock("./workspaceRealPath", { spy: true });
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

async function setup() {
  const recorded = new Map<string, string>();
  const isRecorded = async (path: string, sha256: string) => recorded.get(path) === sha256;
  const rootPath = await createTestScratch("outside-copy-");
  const workspace = { workspaceId: "outside-copy", rootPath };
  await openedLocalState(workspace);
  return { rootPath, workspace, recorded, isRecorded, copies: outsideWriteCopies(workspace) };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("materialization keeps outside bytes before replacement", () => {
  it.each([undefined, ".dohc", ".dohc/local", ".dohc/local/outside-write-copies"])("reports the cause and exact recovery path, blocker=%s", blockingPath => {
    const rootPath = "C:\\workspace";
    const error = new OutsideWriteCopyError("n.md", new Error("write refused"), rootPath, blockingPath);
    expect(error.message.split("\n")[0]).toBe(blockingPath
      ? `dohc could not keep a copy of n.md, because ${blockingPath} is in the way, so it left n.md as it was. Move ${blockingPath} somewhere else, then choose Try again.`
      : "dohc could not keep a copy of n.md, so it left n.md as it was. Check that dohc can write to the workspace folder, then choose Try again.");
    expect(error.message).toContain("Cause: write refused");
    expect(error.message).toContain(blockingPath ? `Blocking file: ${join(rootPath, blockingPath)}` : `Workspace folder: ${rootPath}`);
    expect(error.message).not.toContain("Move it somewhere else.");
  });

  it.each([".dohc", ".dohc/local", ".dohc/local/outside-write-copies"])("names a blocking file at %s after the local-state guard refuses", async blockingPath => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await rm(join(rootPath, blockingPath), { recursive: true, force: true });
    await writeFile(join(rootPath, blockingPath), "blocker");
    const cause = await copies.beforeWrite("n.md", Buffer.from("incoming"), () => undefined, isRecorded).catch(error => error as unknown);
    expect(cause).toBeInstanceOf(Error);
    const error = await OutsideWriteCopyError.from("n.md", cause, rootPath);
    expect(error.message).toContain(`because ${blockingPath} is in the way`);
    expect(error.message).toContain(`Move ${blockingPath} somewhere else, then choose Try again.`);
    expect(error.message).toContain(`Blocking file: ${join(rootPath, blockingPath)}`);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("outside");
  });

  it("names a malformed copy record as the blocking file", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await copies.list();
    const blockingPath = ".dohc/local/outside-write-copies/broken.json";
    await writeFile(join(rootPath, blockingPath), "invalid");
    await writeFile(join(rootPath, "n.md"), "outside");
    const fresh = outsideWriteCopies({ rootPath, workspaceId: "outside-copy" });
    const cause = await fresh.beforeWrite("n.md", null, () => undefined, isRecorded).catch(error => error as unknown);
    const error = await OutsideWriteCopyError.from("n.md", cause, rootPath);
    expect(error.message).toContain(`Move ${blockingPath} somewhere else, then choose Try again.`);
    expect(error.message).toContain(`Blocking file: ${join(rootPath, blockingPath)}`);
  });

  it.each(["different", "unknown"])("keeps bytes with a %s baseline and rediscovers the copy after restart", async baseline => {
    const { rootPath, workspace, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), Buffer.from([65, 255, 0, 10]));
    if (baseline === "different") recorded.set("n.md", hash("BASE"));
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    const rows = await outsideWriteCopies(workspace).list();
    expect(rows).toEqual([["n.md", "n (kept copy).md", expect.any(String)]]);
    expect(await readFile(join(rootPath, rows[0]![1]))).toEqual(Buffer.from([65, 255, 0, 10]));
    expect(await readFile(join(rootPath, "n.md"))).toEqual(Buffer.from([65, 255, 0, 10]));
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    expect(await copies.list()).toEqual(rows);
  });

  it.each(["baseline", "incoming"])("does not copy bytes equal to the %s", async same => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "same");
    if (same === "baseline") recorded.set("n.md", hash("same"));
    const admit = vi.fn();
    await copies.beforeWrite("n.md", Buffer.from(same === "incoming" ? "same" : "OWNER-1"), admit, isRecorded);
    expect(admit).not.toHaveBeenCalled();
    expect(await copies.list()).toEqual([]);
  });

  it("prunes missing copy receipts on the first list", async () => {
    const { rootPath, workspace, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    await rm(join(rootPath, "n (kept copy).md"));
    expect(await copies.list()).toEqual([]);
    expect(await readdir(join(rootPath, ".dohc/local/outside-write-copies"))).toEqual([]);
    expect(await outsideWriteCopies(workspace).list()).toEqual([]);
  });

  it("prunes a cached receipt already removed outside dohc without poisoning later lists", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    const folder = join(rootPath, ".dohc/local/outside-write-copies");
    const [receipt] = await readdir(folder);
    await rm(join(rootPath, "n (kept copy).md"));
    await rm(join(folder, receipt!));
    const prune = vi.spyOn(files, "unlink");
    const errors = vi.fn();
    expect(await copies.list(errors)).toEqual([]);
    expect(prune).toHaveBeenCalledExactlyOnceWith(join(folder, receipt!));
    expect(await copies.list(errors)).toEqual([]);
    expect(prune).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    expect(await copies.list(errors)).toEqual([["n.md", "n (kept copy).md", expect.any(String)]]);
  });

  it("retains a stale cached receipt when pruning fails with EACCES and retries later", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    await rm(join(rootPath, "n (kept copy).md"));
    const failure = Object.assign(new Error("receipt access denied"), { code: "EACCES" });
    const prune = vi.spyOn(files, "unlink").mockRejectedValueOnce(failure);
    await expect(copies.list()).rejects.toBe(failure);
    expect(await readdir(join(rootPath, ".dohc/local/outside-write-copies"))).toHaveLength(1);
    expect(await copies.list()).toEqual([]);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(await readdir(join(rootPath, ".dohc/local/outside-write-copies"))).toEqual([]);
  });

  it.each(["malformed", "unreadable"])("reports %s receipts in path order regardless of read completion order", async damage => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    const expected = await copies.list();
    const folder = join(rootPath, ".dohc/local/outside-write-copies");
    const paths = [join(folder, "a.json"), join(folder, "z.json")];
    for (const path of paths) await writeFile(path, "invalid");
    const fresh = outsideWriteCopies({ rootPath, workspaceId: "outside-copy" });
    const { readFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const reported: string[][] = [];
    for (const order of [[1, 0], [0, 1]]) {
      const entered = paths.map(() => deferred<void>());
      const release = paths.map(() => deferred<void>());
      const finished = paths.map(() => deferred<void>());
      const completed: string[] = [];
      const reads = vi.spyOn(files, "readFile").mockImplementation((async (...args: Parameters<typeof readFile>) => {
        const index = paths.indexOf(String(args[0]));
        if (index !== -1) {
          entered[index]!.resolve();
          await release[index]!.promise;
        }
        try {
          if (index !== -1 && damage === "unreadable") throw Object.assign(new Error("EACCES: receipt access denied"), { code: "EACCES" });
          return await readFile(...args);
        } finally {
          if (index !== -1) {
            completed.push(paths[index]!);
            finished[index]!.resolve();
          }
        }
      }) as typeof readFile);
      const errors: string[] = [];
      const listing = fresh.list(error => errors.push(String(error)));
      try {
        await Promise.all(entered.map(signal => signal.promise));
        for (const index of order) {
          release[index]!.resolve();
          await finished[index]!.promise;
        }
        expect(await listing).toEqual(expected);
      } finally {
        release.forEach(signal => signal.resolve());
        await listing;
        reads.mockRestore();
      }
      expect(completed).toEqual(order.map(index => paths[index]));
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(paths[0]);
      expect(errors[1]).toContain(paths[1]);
      reported.push(errors);
    }
    expect(reported[0]).toEqual(reported[1]);
  });

  it("lists readable receipts but refuses a copy when another receipt has EACCES", async () => {
    const { rootPath, workspace, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    const expected = await copies.list();
    const broken = join(rootPath, ".dohc/local/outside-write-copies/blocked.json");
    await writeFile(broken, "unreadable");
    const { readFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const cause = Object.assign(new Error("EACCES: receipt access denied"), { code: "EACCES" });
    vi.spyOn(files, "readFile").mockImplementation((...args) => String(args[0]) === broken ? Promise.reject(cause) : readFile(...args));
    const fresh = outsideWriteCopies(workspace);
    const errors = vi.fn();
    expect(await fresh.list(errors)).toEqual(expected);
    expect(errors).toHaveBeenCalledOnce();
    const error = errors.mock.calls[0]![0] as Error;
    expect(error.message).toContain(broken);
    expect(error.cause).toBe(cause);
    await writeFile(join(rootPath, "other.md"), "another outside edit");
    const failure = await fresh.beforeWrite("other.md", null, () => undefined, isRecorded).catch(error => error as unknown);
    expect(failure).toBeInstanceOf(OutsideWriteCopyError);
    expect(String(failure)).toContain(`Blocking file: ${broken}`);
    expect(String(failure)).toContain("EACCES: receipt access denied");
    expect(await readFile(join(rootPath, "other.md"), "utf8")).toBe("another outside edit");
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toEqual(["n (kept copy).md"]);
  });

  it("leaves the original when preserving the copy fails", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    const replace = vi.fn();
    await expect((async () => {
      await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => { throw new Error("copy refused"); }, isRecorded);
      replace();
    })()).rejects.toThrow("copy refused");
    expect(replace).not.toHaveBeenCalled();
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("AGENT-1");
  });

  it("does not replace the original if the durable receipt fails", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    vi.spyOn(durableFiles, "atomicWriteFile").mockRejectedValueOnce(new Error("receipt flush failed"));
    const cause = await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded).catch(error => error as unknown);
    expect(cause).toBeInstanceOf(Error);
    const error = await OutsideWriteCopyError.from("n.md", cause, rootPath);
    expect(error.message.split("\n")[0]).toBe("dohc could not keep a copy of n.md, so it left n.md as it was. Check that dohc can write to the workspace folder, then choose Try again.");
    expect(error.message).toContain(`Workspace folder: ${rootPath}\nCause: receipt flush failed`);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("AGENT-1");
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toEqual([]);
    expect(await outsideWriteCopies({ workspaceId: "outside-copy", rootPath }).list()).toEqual([]);
  });

  it("removes the incomplete copy after a hash mismatch and reuses its name on retry", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "first outside edit");
    await expect(copies.beforeWrite("n.md", null, () => {
      writeFileSync(join(rootPath, "n.md"), "second outside edit");
    }, isRecorded)).rejects.toThrow("n.md changed while dohc kept its copy.");
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toEqual([]);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("second outside edit");
    expect(await copies.list()).toEqual([]);
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    expect((await copies.list())[0]?.[1]).toBe("n (kept copy).md");
  });

  it("skips malformed receipts while listing but still refuses an unrecordable copy", async () => {
    const { rootPath, copies, workspace, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    const broken = join(rootPath, ".dohc/local/outside-write-copies/broken.json");
    await writeFile(broken, "invalid");
    const fresh = outsideWriteCopies(workspace);
    const errors = vi.fn();
    expect(await fresh.list(errors)).toEqual(await copies.list());
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0]?.[0])).toContain(broken);
    await expect(fresh.beforeWrite("n.md", null, () => undefined, isRecorded)).rejects.toBeInstanceOf(OutsideWriteCopyError);
    await rm(broken);
    expect(await fresh.list(errors)).toHaveLength(1);
    expect(errors).toHaveBeenCalledOnce();
  });

  it("retains a cached row and receipt when checking its file fails with ENOTDIR", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    const rows = await copies.list();
    const { lstat } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const failure = Object.assign(new Error("cannot check copy"), { code: "ENOTDIR" });
    vi.spyOn(files, "lstat").mockImplementation((...args) =>
      String(args[0]) === join(rootPath, rows[0]![1]) ? Promise.reject(failure) : lstat(...args));
    const errors = vi.fn();
    expect(await copies.list(errors)).toEqual(rows);
    expect(errors).toHaveBeenCalledWith(failure);
    expect(await readdir(join(rootPath, ".dohc/local/outside-write-copies"))).toHaveLength(1);
  });

  it("serializes receipt pruning before a replacement and preserves an unrelated row", async () => {
    const { rootPath, copies, workspace, isRecorded } = await setup();
    for (const path of ["n.md", "other.md"]) {
      await writeFile(join(rootPath, path), "outside");
      await copies.beforeWrite(path, null, () => undefined, isRecorded);
    }
    const other = (await copies.list()).find(row => row[0] === "other.md");
    await rm(join(rootPath, "n (kept copy).md"));
    const entered = deferred<void>();
    const release = deferred<void>();
    const { unlink } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.spyOn(files, "unlink").mockImplementationOnce(async path => {
      entered.resolve();
      await release.promise;
      return unlink(path);
    });
    const listing = copies.list();
    await entered.promise;
    vi.mocked(realPaths.assertResolvedWorkspacePath).mockClear();
    const admit = vi.fn();
    const replacing = copies.beforeWrite("n.md", null, admit, isRecorded);
    try {
      await Promise.resolve();
      expect(realPaths.assertResolvedWorkspacePath).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([listing, replacing]);
    }
    expect(await listing).toEqual([other]);
    expect(await replacing).toBe(true);
    const rows = await copies.list();
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(other);
    expect(rows.find(row => row[0] === "n.md")?.[1]).toBe("n (kept copy).md");
    expect(await outsideWriteCopies(workspace).list()).toEqual(rows);
  });

  it.each(["directory", "symlink"])("makes no copy for a %s", async kind => {
    const { rootPath, copies } = await setup();
    if (kind === "directory") await mkdir(join(rootPath, "n.md"));
    else {
      await writeFile(join(rootPath, "target.md"), "target");
      await symlink(join(rootPath, "target.md"), join(rootPath, "n.md"));
    }
    const isRecorded = vi.fn();
    const admit = vi.fn();
    expect(await copies.beforeWrite("n.md", null, admit, isRecorded)).toBe(false);
    expect(isRecorded).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it.each(["a".repeat(250), "\u754c".repeat(process.platform === "win32" ? 90 : 80), "\u{1f30d}".repeat(60)])(
    "shortens a long stem without cutting characters or its extension (%s)", async stem => {
      const { rootPath, copies, isRecorded } = await setup();
      const path = `${stem}.md`;
      await writeFile(join(rootPath, path), "outside");
      await copies.beforeWrite(path, null, () => undefined, isRecorded);
      const copy = (await copies.list())[0]![1];
      expect(copy.endsWith(" (kept copy).md")).toBe(true);
      expect(Buffer.byteLength(copy)).toBeLessThanOrEqual(255);
      expect(copy.length).toBeLessThanOrEqual(255);
      expect(copy.isWellFormed()).toBe(true);
      expect(stem.startsWith(copy.slice(0, -" (kept copy).md".length))).toBe(true);
      expect(await readFile(join(rootPath, copy), "utf8")).toBe("outside");
      await writeFile(join(rootPath, copy), "edited copy");
      await copies.beforeWrite(path, null, () => undefined, isRecorded);
      const next = (await copies.list())[0]![1];
      expect(next.endsWith(" (kept copy 2).md")).toBe(true);
      expect(Buffer.byteLength(next)).toBeLessThanOrEqual(255);
      expect(next.length).toBeLessThanOrEqual(255);
      expect(next.isWellFormed()).toBe(true);
      expect(await readFile(join(rootPath, next), "utf8")).toBe("outside");
      expect(await readFile(join(rootPath, copy), "utf8")).toBe("edited copy");
    });

  it("preserves a History lookup failure without copy-folder advice", async () => {
    const { rootPath, copies } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    const failure = new Error("History store is corrupt");
    await expect(copies.beforeWrite("n.md", null, () => undefined, async () => { throw failure; })).rejects.toBe(failure);
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toEqual([]);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("outside");
  });

  it("removes a partial copy after its write fails", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    const { open } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.spyOn(files, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith("n (kept copy).md")) {
        const writePartial = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
          await writePartial("partial");
          throw new Error("copy write failed");
        });
      }
      return file;
    });
    await expect(copies.beforeWrite("n.md", null, () => undefined, isRecorded)).rejects.toThrow("copy write failed");
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toEqual([]);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("outside");
    expect(await copies.list()).toEqual([]);
  });

  it("does not reuse a copy replaced with a hard link to the original", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    await rm(join(rootPath, "n (kept copy).md"));
    await link(join(rootPath, "n.md"), join(rootPath, "n (kept copy).md"));
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    expect(await copies.list()).toEqual([["n.md", "n (kept copy 2).md", expect.any(String)]]);
    await writeFile(join(rootPath, "n.md"), "OWNER-1");
    expect(await readFile(join(rootPath, "n (kept copy 2).md"), "utf8")).toBe("AGENT-1");
  });

  it("never overwrites an existing copy name", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await writeFile(join(rootPath, "n (kept copy).md"), "earlier copy");
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    expect(await copies.list()).toEqual([["n.md", "n (kept copy 2).md", expect.any(String)]]);
    expect(await readFile(join(rootPath, "n (kept copy).md"), "utf8")).toBe("earlier copy");
  });

  it("keeps outside bytes before deletion, but creates nothing for an absent file", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await copies.beforeWrite("absent.md", null, () => undefined, isRecorded);
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    expect(await copies.list()).toEqual([["n.md", "n (kept copy).md", expect.any(String)]]);
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toHaveLength(1);
  });
});
