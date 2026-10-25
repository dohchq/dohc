import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  cameFromAnotherPerson,
  markAsDownloaded,
  markedCopiesRoot,
  markedCopyOf,
  removeEarlierMarkedCopies,
  removeMarkedCopies,
  systemMarkedCopies,
} from "./markedCopies";
import { createTestScratch } from "./testTemp";

const linkType = process.platform === "win32" ? "junction" : "dir";

describe("marked copies", () => {
  it("keeps one folder per profile inside the temp folder", () => {
    const first = markedCopiesRoot(join("temp"), join("profiles", "a"));
    expect(dirname(first)).toBe("temp");
    expect(markedCopiesRoot(join("temp"), join("profiles", "a"))).toBe(first);
    expect(markedCopiesRoot(join("temp"), join("profiles", "b"))).not.toBe(first);
  });

  it("copies into a fresh folder with the same name and bytes, and leaves the original alone", async () => {
    const scratch = await createTestScratch("marked-copy-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "original bytes");
    const copies = { ...systemMarkedCopies(join(scratch, "copies")), mark: async () => undefined };
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
    const copy = await markedCopyOf({ ...systemMarkedCopies(join(scratch, "copies")), mark: async () => undefined }, original);
    expect((await stat(copy)).mode & 0o111).toBe(0);
  });

  it("removes this run's copies and earlier runs' at quit, and nothing outside its folder", async () => {
    const scratch = await createTestScratch("marked-copy-quit-");
    const outside = join(scratch, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    const root = join(scratch, "copies");
    const copies = { ...systemMarkedCopies(root), mark: async () => undefined };
    const original = join(outside, "keep.txt");
    await markedCopyOf(copies, original);
    await mkdir(join(root, "earlier-run"));
    await writeFile(join(root, "earlier-run", "left.txt"), "left");
    await symlink(outside, join(root, "link"), linkType);
    await removeMarkedCopies(copies);
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("removes earlier runs' copies at start and keeps this run's", async () => {
    const scratch = await createTestScratch("marked-copy-start-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "bytes");
    const root = join(scratch, "copies");
    const earlier = { ...systemMarkedCopies(root), mark: async () => undefined };
    const current = { ...systemMarkedCopies(root), mark: async () => undefined };
    await markedCopyOf(earlier, original);
    const kept = await markedCopyOf(current, original);
    await removeEarlierMarkedCopies(current);
    expect(await readdir(root)).toEqual([basename(current.folder)]);
    expect(await readFile(kept, "utf8")).toBe("bytes");
  });

  it("removes nothing through a folder that is a link", async () => {
    const scratch = await createTestScratch("marked-copy-link-");
    const outside = join(scratch, "outside");
    await mkdir(join(outside, "run"), { recursive: true });
    await writeFile(join(outside, "run", "keep.txt"), "keep");
    await symlink(outside, join(scratch, "copies"), linkType);
    const copies = { ...systemMarkedCopies(join(scratch, "copies")), mark: async () => undefined };
    await removeEarlierMarkedCopies(copies);
    await removeMarkedCopies(copies);
    expect(await readFile(join(outside, "run", "keep.txt"), "utf8")).toBe("keep");
    await expect(markedCopyOf(copies, join(outside, "run", "keep.txt"))).rejects.toThrow("is not a private folder");
    expect(await readdir(outside)).toEqual(["run"]);
  });

  it("counts a file as another person's when dohc cannot tell", async () => {
    const scratch = await createTestScratch("marked-copy-unclear-");
    await writeFile(join(scratch, "notes.bin"), "bytes");
    await expect(cameFromAnotherPerson({ rootPath: scratch }, join(scratch, "notes.bin"))).resolves.toBe(false);
    await expect(cameFromAnotherPerson({ rootPath: `${scratch}\0` }, join(scratch, "notes.bin"))).resolves.toBe(true);
  });

  it.skipIf(process.platform === "linux")("compares paths without case where the file system does", async () => {
    const scratch = await createTestScratch("marked-copy-case-");
    await mkdir(join(scratch, "shared-with-me", "alex"), { recursive: true });
    await writeFile(join(scratch, "shared-with-me", "alex", "report.bin"), "bytes");
    const spelled = join(scratch, "SHARED-WITH-ME", "alex", "report.bin");
    await expect(cameFromAnotherPerson({ rootPath: scratch }, spelled)).resolves.toBe(true);
  });

  it.skipIf(process.platform !== "win32")("writes the Internet zone mark, and a copy keeps it", async () => {
    const scratch = await createTestScratch("marked-copy-zone-");
    const original = join(scratch, "report.bin");
    await writeFile(original, "bytes");
    await chmod(original, 0o444);
    const copy = await markedCopyOf(systemMarkedCopies(join(scratch, "copies")), original);
    expect(await readFile(`${copy}:Zone.Identifier`, "utf8")).toMatch(/^\[ZoneTransfer\]\r\nZoneId=3\r\n/);
    await expect(readFile(`${original}:Zone.Identifier`)).rejects.toMatchObject({ code: "ENOENT" });
    const again = join(scratch, "again.bin");
    await copyFile(copy, again);
    expect(await readFile(`${again}:Zone.Identifier`, "utf8")).toContain("ZoneId=3");
  });

  it.skipIf(process.platform !== "darwin")("writes the download mark that xattr reads back", async () => {
    const scratch = await createTestScratch("marked-copy-quarantine-");
    const file = join(scratch, "report.bin");
    await writeFile(file, "bytes");
    await markAsDownloaded(file, "darwin");
    const { stdout } = await promisify(execFile)("/usr/bin/xattr", ["-p", "com.apple.quarantine", file]);
    expect(stdout.trim()).toMatch(/^0001;[0-9a-f]{8};dohc;$/);
  });
});
