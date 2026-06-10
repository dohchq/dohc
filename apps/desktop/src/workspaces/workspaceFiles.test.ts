import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { copyIntoWorkspace, createFile, listFiles } from "./workspaceFiles";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-files-"));
});

describe("createFile", () => {
  it("creates nested files through validated paths", async () => {
    const path = await createFile(root, "notes/./today.md");
    expect(path).toBe("notes/today.md");
    expect(await readFile(join(root, "notes/today.md"), "utf8")).toBe("");
  });

  it("rejects traversal and reserved paths", async () => {
    await expect(createFile(root, "../escape.md")).rejects.toThrow(/traversal/);
    await expect(createFile(root, ".dohc/x.md")).rejects.toThrow(/reserved/);
  });

  it("never overwrites an existing file", async () => {
    await writeFile(join(root, "keep.md"), "original");
    await createFile(root, "keep.md");
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("original");
  });
});

describe("listFiles", () => {
  it("lists files but skips internal directories", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(join(root, ".dohc", "manifest.json"), "{}");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "");
    await writeFile(join(root, "wallet.sqlite"), "");
    const files = await listFiles(root);
    expect(files).toEqual([
      { path: "notes/a.md", kind: "file" },
      { path: "wallet.sqlite", kind: "database" },
    ]);
  });
});

describe("copyIntoWorkspace", () => {
  it("copies external files into the workspace root by basename", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
    await writeFile(join(outside, "receipt.png"), "png-bytes");
    const imported = await copyIntoWorkspace(root, [join(outside, "receipt.png")]);
    expect(imported).toEqual(["receipt.png"]);
    expect(await readFile(join(root, "receipt.png"), "utf8")).toBe("png-bytes");
  });

  it("skips files that already exist instead of overwriting", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dohc-import-"));
    await writeFile(join(outside, "notes.md"), "incoming");
    await writeFile(join(root, "notes.md"), "existing");
    const imported = await copyIntoWorkspace(root, [join(outside, "notes.md")]);
    expect(imported).toEqual([]);
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("existing");
  });
});
