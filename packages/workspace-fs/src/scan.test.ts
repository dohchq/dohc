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

async function writeFixture(path: string, text = "content\n") {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

describe("scanWorkspaceFiles", () => {
  it("skips shared ignored segments and database sidecars", async () => {
    await writeFixture("notes/keep.md");
    await writeFixture("notes/today.md", "# Today\n");
    await writeFixture(".dohc/history.json", "internal\n");
    await writeFixture(".git/config", "internal\n");
    await writeFixture("node_modules/pkg/index.js", "internal\n");
    await writeFixture(".dohc-write-123.tmp", "internal\n");
    await writeFixture("notes/.dohc-write-456.tmp", "internal\n");
    await writeFixture("notes/.DOHC/hidden.md", "internal\n");
    await writeFixture("nested/.git/config");
    await writeFixture("nested/node_modules/pkg/index.js");
    await writeFixture("finance/ledger.sqlite", "SQLite format 3\0");
    await writeFixture("finance/ledger.sqlite-wal", "transient\n");
    await writeFixture("finance/ledger.sqlite-shm", "transient\n");
    await writeFixture("finance/ledger.sqlite-journal", "transient\n");
    await writeFixture("finance/cache-wal", "normal file\n");
    await writeFixture("finance/archive.sqlite-wal/keep.md");
    await writeFixture("scripts/run.sh", "#!/bin/sh\ntrue\n");

    const files = await scanWorkspaceFiles(root);

    expect(files.map((file) => file.path)).toEqual([
      "finance/archive.sqlite-wal/keep.md",
      "finance/cache-wal",
      "finance/ledger.sqlite",
      "notes/keep.md",
      "notes/today.md",
      "scripts/run.sh",
    ]);
    expect(files.find((file) => file.path === "scripts/run.sh")?.mediaType).toBe(
      "text/plain",
    );
  });
});
