import { mkdtemp, mkdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchWorkspaceEvents, type WorkspaceEventsWatcher } from "./watchEvents";

// Native watch events can lag well past vi.waitFor's 1 s default on a loaded gate host.
const wait = { timeout: 10_000 };

describe("workspace watcher filesystem changes", () => {
  const roots: string[] = [];
  const watchers: WorkspaceEventsWatcher[] = [];
  const makeRoot = async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-watch-files-"));
    roots.push(root);
    return root;
  };
  const start = async (rootDir: string, signal?: AbortSignal) => {
    const batches: string[][] = [];
    const watcher = watchWorkspaceEvents({ rootDir, settleMs: 10, signal }, paths => batches.push(paths));
    watchers.push(watcher);
    await watcher.ready;
    return { watcher, batches, seen: () => batches.flat() };
  };
  afterEach(async () => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("observes file additions, edits, atomic replacement, and deletion after ready", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "existing.md"), "before");
    const { batches, seen } = await start(root);
    expect(seen()).toEqual([]);
    await writeFile(join(root, "new.md"), "new");
    await writeFile(join(root, "existing.md"), "edited");
    await vi.waitFor(() => expect(seen()).toEqual(expect.arrayContaining(["existing.md", "new.md"])), wait);
    batches.length = 0;
    await writeFile(join(root, "replacement.tmp"), "replacement");
    await rename(join(root, "replacement.tmp"), join(root, "existing.md"));
    await vi.waitFor(() => expect(seen()).toContain("existing.md"), wait);
    expect(seen()).not.toContain("replacement.tmp");
    batches.length = 0;
    await rm(join(root, "existing.md"));
    await vi.waitFor(() => expect(seen()).toContain("existing.md"), wait);
  });

  it("reports descendants of created, moved, and removed directories", async () => {
    const root = await makeRoot();
    const { batches, seen } = await start(root);
    await mkdir(join(root, "folder", "nested"), { recursive: true });
    await writeFile(join(root, "folder", "nested", "note.md"), "note");
    await vi.waitFor(() => expect(seen()).toContain("folder/nested/note.md"), wait);
    batches.length = 0;
    await rename(join(root, "folder", "nested"), join(root, "moved"));
    await vi.waitFor(() => expect(seen()).toEqual(expect.arrayContaining([
      "folder/nested/note.md", "moved/note.md",
    ])), wait);
    batches.length = 0;
    await rm(join(root, "moved"), { recursive: true });
    await vi.waitFor(() => expect(seen()).toContain("moved/note.md"), wait);
  });

  it("prunes metadata and symlink targets while preserving SQLite sidecar events", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(join(root, ".dohc", "history"), { recursive: true });
    await writeFile(join(outside, "outside.md"), "before");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const { seen } = await start(root);
    await writeFile(join(root, ".dohc", "history", "event.json"), "{}");
    await writeFile(join(outside, "outside.md"), "after");
    await writeFile(join(root, "db.sqlite-wal"), "wal");
    await vi.waitFor(() => expect(seen()).toContain("db.sqlite-wal"), wait);
    expect(seen().some(path => path.includes(".dohc") || path.includes("outside.md"))).toBe(false);
  });

  it("keeps the remaining workspace owner live after one watcher aborts", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "note.md"), "before");
    const controller = new AbortController();
    const first = await start(root, controller.signal);
    const second = await start(root);
    controller.abort();
    await writeFile(join(root, "note.md"), "after");
    await vi.waitFor(() => expect(second.seen()).toContain("note.md"), wait);
    expect(first.seen()).toEqual([]);
  });

  it("reports same-length edits when the writer restores the old modification time", async () => {
    const root = await makeRoot();
    const path = join(root, "note.md");
    await writeFile(path, "before");
    const before = await stat(path);
    const { seen } = await start(root);
    await writeFile(path, "after!");
    await utimes(path, before.atime, before.mtime);
    await vi.waitFor(() => expect(seen()).toContain("note.md"), wait);
  });
});
