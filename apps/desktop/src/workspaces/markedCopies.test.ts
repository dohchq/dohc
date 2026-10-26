import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ipcWireError, readError, withErrorWords } from "../ipc/errorWords";
import { workspaceFileOperations } from "../ipc/workspaceFileOperations";
import {
  fileOrigin,
  markAsDownloaded,
  markInPlace,
  markedCopyOf,
  removeEarlierMarkedCopies,
  removeMarkedCopies,
  systemMarkedCopies,
} from "./markedCopies";
import { withPrivacyDenial } from "./privacyDenial";
import type { RegistryEntry } from "./registryStore";
import { createTestScratch } from "./testTemp";

const linkType = process.platform === "win32" ? "junction" : "dir";
const unmarked = (profile: string) => ({ ...systemMarkedCopies(profile), mark: async () => undefined });

// What the toast and its Notices row say, and what Copy details keep, once
// main's error has crossed to the renderer.
function shown(error: unknown, platform: NodeJS.Platform) {
  const wire = String(ipcWireError(withPrivacyDenial(error, platform)));
  const received = new Error(`Error invoking remote method '${workspaceFileOperations.openFileExternally.channel}': ${wire}`);
  return { message: withErrorWords("dohc could not open this file externally.", received), details: readError(received).cause };
}

describe("marked copies", () => {
  it("keeps each run's copies in its own folder inside the profile", () => {
    const first = systemMarkedCopies(join("profile"));
    const second = systemMarkedCopies(join("profile"));
    expect(dirname(dirname(first.folder))).toBe("profile");
    expect(dirname(second.folder)).toBe(dirname(first.folder));
    expect(second.folder).not.toBe(first.folder);
  });

  it("copies into a fresh folder with the same name and bytes, and leaves the original alone", async () => {
    const scratch = await createTestScratch("marked-copy-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "original bytes");
    const copies = unmarked(join(scratch, "profile"));
    const first = await markedCopyOf(copies, original);
    const second = await markedCopyOf(copies, original);
    expect(basename(first)).toBe("report.bin");
    expect(dirname(first)).not.toBe(dirname(second));
    expect(await readFile(first, "utf8")).toBe("original bytes");
    expect(await readFile(original, "utf8")).toBe("original bytes");
  });

  it.skipIf(process.platform === "win32")("gives the copy no run permission the original lacks", async () => {
    const scratch = await createTestScratch("marked-copy-mode-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "bytes");
    await chmod(original, 0o444);
    const copy = await markedCopyOf(unmarked(join(scratch, "profile")), original);
    expect((await stat(copy)).mode & 0o111).toBe(0);
  });

  it("removes only this run's copies at quit", async () => {
    const scratch = await createTestScratch("marked-copy-quit-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "bytes");
    const profile = join(scratch, "profile");
    const other = unmarked(profile);
    const current = unmarked(profile);
    const kept = await markedCopyOf(other, original);
    await markedCopyOf(current, original);
    await removeMarkedCopies(current);
    expect(await readdir(dirname(current.folder))).toEqual([basename(other.folder)]);
    expect(await readFile(kept, "utf8")).toBe("bytes");
  });

  it("removes earlier runs' copies at start, keeps this run's, and nothing outside", async () => {
    const scratch = await createTestScratch("marked-copy-start-");
    const outside = join(scratch, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    const original = join(outside, "keep.txt");
    const profile = join(scratch, "profile");
    const earlier = unmarked(profile);
    const current = unmarked(profile);
    await markedCopyOf(earlier, original);
    const kept = await markedCopyOf(current, original);
    await symlink(outside, join(dirname(current.folder), "link"), linkType);
    await removeEarlierMarkedCopies(current);
    expect(await readdir(dirname(current.folder))).toEqual([basename(current.folder)]);
    expect(await readFile(kept, "utf8")).toBe("keep");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it.each(["the copies folder", "this run's folder"] as const)("removes and opens nothing when %s is a link", async (linked) => {
    const scratch = await createTestScratch("marked-copy-link-");
    const outside = join(scratch, "outside");
    const profile = join(scratch, "profile");
    const copies = unmarked(profile);
    const run = join(outside, basename(copies.folder));
    await mkdir(join(outside, "earlier"), { recursive: true });
    await mkdir(run);
    await writeFile(join(run, "keep.txt"), "keep");
    if (linked === "the copies folder") {
      await mkdir(profile);
      await symlink(outside, dirname(copies.folder), linkType);
    } else {
      await mkdir(dirname(copies.folder), { recursive: true });
      await symlink(run, copies.folder, linkType);
    }
    await removeMarkedCopies(copies);
    await removeEarlierMarkedCopies(copies);
    expect(await readFile(join(run, "keep.txt"), "utf8")).toBe("keep");
    const failure = await markedCopyOf(copies, join(run, "keep.txt")).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "MarkedCopyError" });
    expect(shown(failure, process.platform).message).toBe("dohc could not open this file externally.");
    expect((await readdir(outside)).sort()).toEqual([basename(run), "earlier"].sort());
    expect(await readdir(run)).toEqual(["keep.txt"]);
  });

  const refusedMark = Object.assign(
    new Error("EPERM: operation not permitted, open 'C:\\profile\\opened\\run\\open-1\\report.bin:Zone.Identifier'"),
    { code: "EPERM", errno: -4048, syscall: "open", path: "C:\\profile\\opened\\run\\open-1\\report.bin:Zone.Identifier" },
  );
  const failedMarkCommand = Object.assign(
    new Error("Command failed: /usr/bin/xattr -w com.apple.quarantine 0081;6ade762a;dohc; /profile/opened/run/open-1/report.bin\nxattr: [Errno 1] Operation not permitted\n"),
    { code: 1, killed: false, signal: null },
  );
  const refusedCopy = Object.assign(
    new Error("ENOSPC: no space left on device, copyfile 'C:\\work\\report.bin' -> 'C:\\profile\\opened\\run\\open-1\\report.bin'"),
    { code: "ENOSPC", syscall: "copyfile" },
  );
  it.each([
    ["the mark", "win32", { mark: async () => { throw refusedMark; } }, "EPERM"],
    ["the mark", "darwin", { mark: async () => { throw failedMarkCommand; } }, "Command failed"],
    ["the copy", "win32", { copy: async () => { throw refusedCopy; } }, "ENOSPC"],
  ] as const)("says only that dohc could not open the file when %s fails on %s, and keeps the cause for Copy details", async (_step, platform, failing, cause) => {
    const scratch = await createTestScratch("marked-copy-words-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "bytes");
    const failure = await markedCopyOf({ ...systemMarkedCopies(join(scratch, "profile")), ...failing }, original)
      .catch((error: unknown) => error);
    const { message, details } = shown(failure, platform);
    expect(message).toBe("dohc could not open this file externally.");
    expect(details).toContain(cause);
  });

  it("counts a file as another person's when dohc cannot tell for the current workspace", async () => {
    const scratch = await createTestScratch("marked-copy-unclear-");
    await writeFile(join(scratch, "notes.bin"), "bytes");
    await expect(fileOrigin({ workspaceId: "own", rootPath: scratch }, [], join(scratch, "notes.bin"))).resolves.toBe("own");
    await expect(fileOrigin({ workspaceId: "own", rootPath: `${scratch}\0` }, [], join(scratch, "notes.bin"))).resolves.toBe("other");
  });

  it("knows the current shared view's own registry entry when its root is written another way", async () => {
    const scratch = await createTestScratch("marked-copy-self-");
    await writeFile(join(scratch, "notes.md"), "bytes");
    const shareView = {} as NonNullable<RegistryEntry["shareView"]>;
    const saved = { workspaceId: "view", rootPath: scratch.replaceAll("\\", "/"), shareView };
    await expect(fileOrigin({ ...saved, rootPath: scratch }, [saved], join(scratch, "notes.md"))).resolves.toBe("shared view");
  });

  it("counts a file as another person's when a registered workspace that could hold it fails to resolve", async () => {
    const scratch = await createTestScratch("marked-copy-registered-");
    const file = join(scratch, "inner", "shared-with-me", "sam", "notes.bin");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "bytes");
    const refused = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const resolve = vi.fn(async (path: string) => {
      if (path.startsWith(join(scratch, "inner"))) throw refused;
      return realpath(path);
    });
    await expect(fileOrigin({ workspaceId: "own", rootPath: scratch },
      [{ workspaceId: "inner", rootPath: join(scratch, "inner") }], file, resolve)).resolves.toBe("other");
    expect(resolve).toHaveBeenCalledWith(join(scratch, "inner", "shared-with-me"));
  });

  it("never resolves a registered workspace that could not hold the file", async () => {
    const scratch = await createTestScratch("marked-copy-unrelated-");
    await writeFile(join(scratch, "notes.bin"), "bytes");
    const unrelated = join(dirname(scratch), "elsewhere");
    const resolve = vi.fn(async (path: string) => {
      if (path.startsWith(unrelated)) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return realpath(path);
    });
    const registered = [
      { workspaceId: "own", rootPath: scratch },
      { workspaceId: "unrelated", rootPath: unrelated },
      { workspaceId: "unrelated view", rootPath: unrelated, shareView: {} as NonNullable<RegistryEntry["shareView"]> },
    ];
    await expect(fileOrigin({ workspaceId: "own", rootPath: scratch }, registered, join(scratch, "notes.bin"), resolve)).resolves.toBe("own");
    expect(resolve.mock.calls.map(([path]) => path)).toEqual([join(scratch, "shared-with-me")]);
  });

  it("makes the copy read-only after marking it, and leaves the original writable", async () => {
    const scratch = await createTestScratch("marked-copy-read-only-");
    const original = join(scratch, "data.bin");
    await writeFile(original, "bytes");
    let writableWhenMarked = false;
    const copy = await markedCopyOf({
      ...systemMarkedCopies(join(scratch, "profile")),
      mark: async (path) => { writableWhenMarked = ((await stat(path)).mode & 0o200) !== 0; },
    }, original);
    expect(writableWhenMarked).toBe(true);
    expect((await stat(copy)).mode & 0o222).toBe(0);
    await expect(writeFile(copy, "changed")).rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EACCES)$/) });
    expect((await stat(original)).mode & 0o200).not.toBe(0);
  });

  it("removes read-only copies at quit and at start", async () => {
    const scratch = await createTestScratch("marked-copy-remove-read-only-");
    const original = join(scratch, "data.bin");
    await writeFile(original, "bytes");
    const profile = join(scratch, "profile");
    const earlier = unmarked(profile);
    const current = unmarked(profile);
    const copies = [await markedCopyOf(earlier, original), await markedCopyOf(current, original)];
    for (const copy of copies) expect((await stat(copy)).mode & 0o222).toBe(0);
    await removeMarkedCopies(current);
    expect(await readdir(dirname(current.folder))).toEqual([basename(earlier.folder)]);
    await removeEarlierMarkedCopies(unmarked(profile));
    expect(await readdir(dirname(current.folder))).toEqual([]);
  });

  it("marks a file in place, and reports a failed mark with the same error", async () => {
    const scratch = await createTestScratch("marked-copy-in-place-");
    const file = join(scratch, "notes.md");
    await writeFile(file, "bytes");
    const mark = vi.fn(async (_path: string) => undefined);
    await markInPlace({ ...systemMarkedCopies(join(scratch, "profile")), mark }, file);
    expect(mark).toHaveBeenCalledExactlyOnceWith(file);
    const failure = await markInPlace({ ...systemMarkedCopies(join(scratch, "profile")), mark: async () => { throw refusedMark; } }, file)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "MarkedCopyError" });
    expect(shown(failure, "win32").message).toBe("dohc could not open this file externally.");
  });

  it.skipIf(process.platform !== "win32")("writes the Internet zone mark", async () => {
    const scratch = await createTestScratch("marked-copy-zone-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "bytes");
    await chmod(original, 0o444);
    const copy = await markedCopyOf(systemMarkedCopies(join(scratch, "profile")), original);
    expect(await readFile(`${copy}:Zone.Identifier`, "utf8")).toMatch(/^\[ZoneTransfer\]\r\nZoneId=3\r\n/);
    await expect(readFile(`${original}:Zone.Identifier`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "darwin")("writes the download mark that xattr reads back", async () => {
    const scratch = await createTestScratch("marked-copy-quarantine-");
    const file = join(scratch, "report.bin");
    await writeFile(file, "bytes");
    await markAsDownloaded(file, "darwin");
    const { stdout } = await promisify(execFile)("/usr/bin/xattr", ["-p", "com.apple.quarantine", file]);
    expect(stdout.trim()).toMatch(/^0081;[0-9a-f]{8};dohc;$/);
  });
});
