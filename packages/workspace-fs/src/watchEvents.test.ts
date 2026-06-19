import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WatcherEvent } from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "./watchEvents";
import { nativeTmpdir } from "./testTemp";

describe("shouldIgnoreWatchPath", () => {
  it("ignores everything under the reserved .dohc/ tree", () => {
    // .dohc/ holds dohc's own derived/reserved state; raw fs noise from it must
    // never surface as user file ops or it would loop sync back on itself.
    expect(shouldIgnoreWatchPath(".dohc")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohc/registry.json")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohc/cache/blob-0001")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohc/cache/nested/deep/file")).toBe(true);
    // Case-insensitive: on macOS/Windows .DOHC aliases .dohc.
    expect(shouldIgnoreWatchPath(".DOHC/cache/x")).toBe(true);
    expect(shouldIgnoreWatchPath(".Dohc")).toBe(true);
  });

  it("does not ignore a sibling whose name merely starts with .dohc", () => {
    // ".dohcrc" is a distinct file, not the reserved ".dohc/" directory.
    expect(shouldIgnoreWatchPath(".dohcrc")).toBe(false);
    expect(shouldIgnoreWatchPath("notes/.dohc-notes.md")).toBe(false);
  });

  it("ignores editor temp / swap / autosave files", () => {
    expect(shouldIgnoreWatchPath("notes/draft.tmp")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/draft.tmp.1234")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/today.md.swp")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/today.md.swo")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/today.md~")).toBe(true);
    expect(shouldIgnoreWatchPath("#today.md#")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/#today.md#")).toBe(true);
    expect(shouldIgnoreWatchPath(".DS_Store")).toBe(true);
    expect(shouldIgnoreWatchPath("notes/.DS_Store")).toBe(true);
  });

  it("does NOT ignore SQLite sidecars — they signal a db change and are collapsed", () => {
    // A SQLite write often touches only the WAL; ignoring sidecars would make
    // the change invisible. They pass through here and collapseSqliteSidecars
    // folds them into one base-db update (so the sidecar path never surfaces).
    expect(shouldIgnoreWatchPath("finance/wallet.db-wal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.db-journal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-wal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-journal")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.db-shm")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite-shm")).toBe(false);
  });

  it("collapses a WAL-only change into a base-db update (db never missed)", () => {
    // The base .db file is untouched until checkpoint; only the WAL changed.
    expect(
      collapseSqliteSidecars([
        { path: "finance/wallet.sqlite-wal", operation: "update" },
      ]),
    ).toEqual([{ path: "finance/wallet.sqlite", operation: "update" }]);
  });

  it("preserves a real database delete even when sidecars are present", () => {
    // Deleting wallet.sqlite removes its sidecars too; the base's own delete
    // must NOT be downgraded to 'update' (history would lie about the delete).
    expect(
      collapseSqliteSidecars([
        { path: "finance/wallet.sqlite-wal", operation: "delete" },
        { path: "finance/wallet.sqlite", operation: "delete" },
        { path: "finance/wallet.sqlite-shm", operation: "delete" },
      ]),
    ).toEqual([{ path: "finance/wallet.sqlite", operation: "delete" }]);
  });

  it("treats a sidecar-only delete (WAL checkpoint) as a db update, not a delete", () => {
    // A checkpoint can remove the -wal while the database itself still exists.
    expect(
      collapseSqliteSidecars([
        { path: "finance/wallet.sqlite-wal", operation: "delete" },
      ]),
    ).toEqual([{ path: "finance/wallet.sqlite", operation: "update" }]);
  });

  it("keeps normal user files watchable", () => {
    expect(shouldIgnoreWatchPath("notes/today.md")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.sqlite")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/wallet.db")).toBe(false);
    expect(shouldIgnoreWatchPath("finance/.apps/ledger/app.json")).toBe(false);
    // A file that merely mentions "tmp"/"swp"/"wal" in its name is fine.
    expect(shouldIgnoreWatchPath("notes/tmp-ideas.md")).toBe(false);
    expect(shouldIgnoreWatchPath("notes/swap-meet.md")).toBe(false);
    expect(shouldIgnoreWatchPath("data/walmart.csv")).toBe(false);
  });

  it("normalizes backslash separators before matching", () => {
    // Watchers on Windows hand back backslash paths; the reserved/cache guard
    // must still fire.
    expect(shouldIgnoreWatchPath(".dohc\\cache\\blob")).toBe(true);
    expect(shouldIgnoreWatchPath("notes\\today.md")).toBe(false);
  });
});

const update = (path: string): WatcherEvent => ({ path, operation: "update" });

async function mkWatchRoot(): Promise<string> {
  return mkdtemp(join(nativeTmpdir(), "dohc-watch-"));
}

describe("collapseSqliteSidecars", () => {
  it("collapses a sidecar event into a single update for its base db", () => {
    // SQLite writes hit wallet.db-wal first; the base wallet.db may not emit an
    // fs event at all, so a WAL touch must still surface as one base-db update.
    const out = collapseSqliteSidecars([update("finance/wallet.db-wal")]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("collapses .sqlite-* and -shm sidecars to their base too", () => {
    expect(collapseSqliteSidecars([update("a/x.sqlite-journal")])).toEqual([
      update("a/x.sqlite"),
    ]);
    expect(collapseSqliteSidecars([update("a/x.sqlite-wal")])).toEqual([
      update("a/x.sqlite"),
    ]);
    expect(collapseSqliteSidecars([update("a/x.db-shm")])).toEqual([
      update("a/x.db"),
    ]);
  });

  it("drops the sidecar event when the base db also changed", () => {
    // Both base and WAL emitted: keep exactly one base update, drop the sidecar.
    const out = collapseSqliteSidecars([
      update("finance/wallet.db"),
      update("finance/wallet.db-wal"),
      update("finance/wallet.db-shm"),
    ]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("deduplicates multiple sidecars of the same base into one update", () => {
    const out = collapseSqliteSidecars([
      update("finance/wallet.db-wal"),
      update("finance/wallet.db-shm"),
      update("finance/wallet.db-journal"),
    ]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("forces the base-db event to 'update' even if the base arrived as create/delete", () => {
    // A WAL checkpoint reads as a delete of the sidecar, but the user-facing
    // truth is that the database content changed — never report it as a delete.
    const out = collapseSqliteSidecars([
      { path: "finance/wallet.db", operation: "create" },
      { path: "finance/wallet.db-wal", operation: "delete" },
    ]);
    expect(out).toEqual([update("finance/wallet.db")]);
  });

  it("preserves base-db event order while collapsing in place", () => {
    const out = collapseSqliteSidecars([
      update("notes/today.md"),
      update("finance/wallet.db-wal"),
      update("inbox/scan.png"),
    ]);
    expect(out).toEqual([
      update("notes/today.md"),
      update("finance/wallet.db"),
      update("inbox/scan.png"),
    ]);
  });

  it("collapses sidecars for several distinct databases independently", () => {
    const out = collapseSqliteSidecars([
      update("a/one.db-wal"),
      update("b/two.sqlite-shm"),
      update("b/two.sqlite-wal"),
    ]);
    expect(out).toEqual([update("a/one.db"), update("b/two.sqlite")]);
  });

  it("leaves non-sqlite and bare-db events untouched", () => {
    const events = [update("notes/today.md"), update("finance/wallet.db")];
    expect(collapseSqliteSidecars(events)).toEqual(events);
  });

  it("never emits a sidecar path as a user file op", () => {
    const out = collapseSqliteSidecars([
      update("finance/wallet.db-wal"),
      update("finance/wallet.db-shm"),
      update("finance/wallet.db-journal"),
      update("finance/wallet.sqlite-wal"),
    ]);
    for (const event of out) {
      expect(event.path).not.toMatch(/-(wal|shm|journal)$/);
    }
  });

  it("returns an empty array for no events", () => {
    expect(collapseSqliteSidecars([])).toEqual([]);
  });
});

describe("watchWorkspaceEvents", () => {
  it("returns a stop function that is idempotent and respects a pre-aborted signal", async () => {
    // Pure timing is covered by desktop E2E; here we just prove the wrapper
    // constructs against a real (empty) temp dir and the stop fn is safe.
    const { rm } = await import("node:fs/promises");
    const root = await mkWatchRoot();
    try {
      const controller = new AbortController();
      controller.abort();
      const aborted = watchWorkspaceEvents(
        { rootDir: root, signal: controller.signal },
        () => undefined,
      );
      expect(typeof aborted.stop).toBe("function");
      await aborted.ready;
      aborted.stop();

      const watcher = watchWorkspaceEvents({ rootDir: root, settleMs: 10 }, () => undefined);
      expect(typeof watcher.stop).toBe("function");
      // ready resolves once the initial scan completes.
      await watcher.ready;
      watcher.stop();
      // Calling stop twice must not throw.
      watcher.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores .dohc writes but reports user files (chokidar passes absolute paths to ignored)", async () => {
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const root = await mkWatchRoot();
    try {
      const batches: string[][] = [];
      const watcher = watchWorkspaceEvents({ rootDir: root, settleMs: 80 }, (paths) =>
        batches.push(paths),
      );
      // Writes after ready are guaranteed observed — no fixed attach sleep.
      await watcher.ready;
      await mkdir(join(root, ".dohc", "history"), { recursive: true });
      await writeFile(join(root, ".dohc", "history", "1.json"), "{}");
      await writeFile(join(root, "notes.md"), "hi");
      await new Promise((r) => setTimeout(r, 600));
      watcher.stop();
      const seen = batches.flat();
      // The user file is reported; nothing under .dohc/ ever is (no feedback loop).
      expect(seen).toContain("notes.md");
      expect(seen.some((p) => p.includes(".dohc"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("rule unification with workspace-core", () => {
  it("collapses .sqlite3 sidecars onto their base database", () => {
    // .sqlite3 was once missed by a local regex copy — sidecars surfaced as
    // standalone user files in history.
    const events = collapseSqliteSidecars([
      { path: "notes/log.sqlite3-wal", operation: "update" },
      { path: "notes/log.sqlite3-shm", operation: "update" },
    ]);
    expect(events).toEqual([{ path: "notes/log.sqlite3", operation: "update" }]);
  });

  it("folds a .sqlite3 base db's own events like .sqlite/.db", () => {
    const events = collapseSqliteSidecars([
      { path: "notes/log.sqlite3", operation: "delete" },
      { path: "notes/log.sqlite3-journal", operation: "update" },
    ]);
    expect(events).toEqual([{ path: "notes/log.sqlite3", operation: "delete" }]);
  });

  it("ignores nested .dohc, .git, and node_modules like the file tree does", () => {
    expect(shouldIgnoreWatchPath("sub/.dohc/manifest.json")).toBe(true);
    expect(shouldIgnoreWatchPath(".git/objects/ab/cdef")).toBe(true);
    expect(shouldIgnoreWatchPath("pkg/node_modules/x/index.js")).toBe(true);
    expect(shouldIgnoreWatchPath(".dohcrc")).toBe(false);
    expect(shouldIgnoreWatchPath("notes/git-notes.md")).toBe(false);
  });
});

describe("settle max-window cap", () => {
  it("flushes a batch under continuous writes instead of starving forever", async () => {
    const { rm, writeFile } = await import("node:fs/promises");
    const root = await mkWatchRoot();
    try {
      const batches: string[][] = [];
      const watcher = watchWorkspaceEvents(
        { rootDir: root, settleMs: 200, maxWindowMs: 600 },
        (paths) => batches.push(paths),
      );
      await watcher.ready;
      // Write faster than settleMs for well past maxWindowMs: the trailing
      // debounce alone would never flush, the deadline must.
      const start = Date.now();
      while (Date.now() - start < 1400) {
        await writeFile(join(root, "busy.md"), `tick ${Date.now()}`);
        await new Promise((r) => setTimeout(r, 90));
      }
      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0]).toContain("busy.md");
      watcher.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
