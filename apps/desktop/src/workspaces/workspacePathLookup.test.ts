import * as fsPromises from "node:fs/promises";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { listFiles } from "./workspaceFiles";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

it("probes exact file names without walking unrelated folders, symlinks, or reserved paths", async () => {
  const root = await createTestScratch("path-lookup-");
  await mkdir(join(root, "notes"));
  await mkdir(join(root, "unrelated", "deep"), { recursive: true });
  await mkdir(join(root, ".dohc"));
  await writeFile(join(root, "notes", "one.txt"), "one");
  await writeFile(join(root, "unrelated", "deep", "two.txt"), "two");
  await writeFile(join(root, ".dohc", "private.txt"), "private");
  const outside = await createTestScratch("lookup-outside-");
  await writeFile(join(outside, "private.txt"), "outside");
  await symlink(outside, join(root, "linked"), "junction");
  const read = vi.mocked(fsPromises.readdir);
  read.mockClear();
  try {
    expect(await listFiles(root, { paths: ["notes/one.txt", "notes", "missing", ".dohc/private.txt", "linked/private.txt", "../private.txt", "NOTES/one.txt"] }))
      .toEqual({ files: [{ path: "notes/one.txt", kind: "file" }], folders: [] });
    expect(read.mock.calls.map(([path]) => String(path)).sort()).toEqual([root, join(root, "notes")].sort());
  } finally { read.mockClear(); }
});
