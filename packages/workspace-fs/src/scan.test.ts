import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWorkspaceFiles } from "./scan";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-scan-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, text = "content\n") {
  const fullPath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, text, "utf8");
}

describe("scanWorkspaceFiles", () => {
  it("skips the shared ignored segments used by watcher, export, and search", async () => {
    await write("notes/keep.md");
    await write(".dohc/history/internal.json");
    await write(".git/config");
    await write("node_modules/pkg/index.js");
    await write("nested/.git/config");
    await write("nested/node_modules/pkg/index.js");

    const files = await scanWorkspaceFiles(root);

    expect(files.map((file) => file.path)).toEqual(["notes/keep.md"]);
  });
});
