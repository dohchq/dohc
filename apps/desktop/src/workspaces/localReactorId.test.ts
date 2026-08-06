import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readOrCreateLocalReactorId } from "./localReactorId";
import { createTestScratch } from "./testTemp";

let dir: string;

beforeEach(async () => {
  dir = await createTestScratch("dohc-local-id-");
});

function idFile(): string {
  return join(dir, "dohc-local-id.json");
}

describe("local reactor id", () => {
  it("mints, persists, and round-trips a stable id", async () => {
    const first = readOrCreateLocalReactorId(idFile());
    expect(first).toMatch(/^local:/);

    // A fresh call (simulating a later launch) reads the SAME id back off disk.
    const second = readOrCreateLocalReactorId(idFile());
    expect(second).toBe(first);

    const onDisk = JSON.parse(await readFile(idFile(), "utf8")) as { id?: string };
    expect(onDisk.id).toBe(first);
  });

  it("writes atomically — no temp file is left behind", async () => {
    readOrCreateLocalReactorId(idFile());
    // The write goes through a temp file then rename; after it completes the
    // directory holds only the final file, never a half-written .tmp-* sibling.
    const entries = await readdir(dir);
    expect(entries).toEqual(["dohc-local-id.json"]);
  });

  it("honors an existing id file and does not overwrite it", async () => {
    await writeFile(idFile(), `${JSON.stringify({ id: "local:preexisting" }, null, 2)}\n`);
    expect(readOrCreateLocalReactorId(idFile())).toBe("local:preexisting");
  });

  it("mints a fresh id when the existing file is corrupt", async () => {
    await writeFile(idFile(), "not json {");
    const id = readOrCreateLocalReactorId(idFile());
    expect(id).toMatch(/^local:/);
    // And it repaired the file so the next read round-trips.
    expect(readOrCreateLocalReactorId(idFile())).toBe(id);
  });
});
