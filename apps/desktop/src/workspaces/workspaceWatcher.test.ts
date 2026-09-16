import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatcherEvent } from "@dohc/workspace-core";
import { startWorkspaceWatch } from "./workspaceWatcher";

const watcher = vi.hoisted(() => ({
  onBatch: undefined as ((paths: string[]) => void) | undefined,
}));

vi.mock("@dohc/workspace-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dohc/workspace-fs")>();
  return {
    ...actual,
    watchWorkspaceEvents: (_options: unknown, onBatch: (paths: string[]) => void) => {
      watcher.onBatch = onBatch;
      return { ready: Promise.resolve(), stop: () => undefined };
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(), stat: vi.fn() };
});

const rootPath = join(process.cwd(), "watcher-test-workspace");
const contents = Buffer.from("# A normal document\n");

beforeEach(() => {
  vi.mocked(readFile).mockReset().mockResolvedValue(contents);
  vi.mocked(stat).mockReset().mockResolvedValue({
    isFile: () => true,
  } as Awaited<ReturnType<typeof stat>>);
});

async function deliver(paths: string[]): Promise<WatcherEvent[]> {
  const captured: WatcherEvent[][] = [];
  const settled: WatcherEvent[][] = [];
  const recorded: WatcherEvent[][] = [];
  const handle = startWorkspaceWatch(
    { workspaceId: "watcher-test", rootPath, kind: "personal", mode: "local-first" },
    {
      engineCapture: () => ({ captureBatch: events => captured.push([...events]) }),
      onSettledBatch: events => settled.push(events),
      onRecorded: events => recorded.push([...events]),
    },
  );
  watcher.onBatch!(paths);
  await handle.stop();
  expect(recorded).toHaveLength(1);
  expect(captured).toEqual(recorded);
  expect(settled).toEqual(recorded);
  return recorded[0]!;
}

describe("workspace watcher database events", () => {
  it.each(["db", "sqlite", "sqlite3", "DB", "SQLITE", "SQLITE3"])(
    "does not read database or sidecar contents for .%s files",
    async extension => {
      const path = `data/wallet.${extension}`;
      const paths = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
      expect(await deliver(paths)).toEqual([{ path, operation: "update" }]);
      expect(readFile).not.toHaveBeenCalled();
      expect(vi.mocked(stat).mock.calls.map(([path]) => path)).toEqual(
        paths.map(path => join(rootPath, path)),
      );
    },
  );

  it("keeps ordinary file digests and batch ordering beside database events", async () => {
    const sha256 = createHash("sha256").update(contents).digest("hex");
    expect(await deliver(["first.md", "wallet.sqlite-WAL", "wallet.sqlite", "last.bin"])).toEqual([
      { path: "first.md", operation: "update", sha256 },
      { path: "wallet.sqlite", operation: "update" },
      { path: "last.bin", operation: "update", sha256 },
    ]);
    expect(vi.mocked(readFile).mock.calls).toEqual([
      [join(rootPath, "first.md")],
      [join(rootPath, "last.bin")],
    ]);
  });

  it("preserves base deletion when a sidecar is still present", async () => {
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    expect(await deliver(["wallet.db", "wallet.db-wal"])).toEqual([
      { path: "wallet.db", operation: "delete" },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reports a database update when only its sidecar disappears", async () => {
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    expect(await deliver(["wallet.sqlite3-wal"])).toEqual([
      { path: "wallet.sqlite3", operation: "update" },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EBUSY"])("keeps unreadable database paths as updates (%s)", async code => {
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("unreadable"), { code }));
    expect(await deliver(["wallet.sqlite"])).toEqual([
      { path: "wallet.sqlite", operation: "update" },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("preserves ordinary-file update semantics when its content read fails", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
    expect(await deliver(["notes.md"])).toEqual([
      { path: "notes.md", operation: "update", sha256: undefined },
    ]);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(join(rootPath, "notes.md"));
  });
});
