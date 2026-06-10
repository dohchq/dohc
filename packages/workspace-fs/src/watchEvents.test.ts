import { describe, expect, it } from "vitest";
import type { WatcherEvent } from "@dohc/workspace-core";
import {
  collapseSqliteSidecars,
  shouldIgnoreWatchPath,
  watchWorkspaceEvents,
} from "./watchEvents";

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
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "dohc-watch-"));
    try {
      const controller = new AbortController();
      controller.abort();
      const stopAborted = watchWorkspaceEvents(
        { rootDir: root, signal: controller.signal },
        () => undefined,
      );
      expect(typeof stopAborted).toBe("function");
      stopAborted();

      const stop = watchWorkspaceEvents({ rootDir: root, settleMs: 10 }, () => undefined);
      expect(typeof stop).toBe("function");
      stop();
      // Calling stop twice must not throw.
      stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores .dohc writes but reports user files (chokidar passes absolute paths to ignored)", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "dohc-watch-"));
    try {
      const batches: string[][] = [];
      const stop = watchWorkspaceEvents({ rootDir: root, settleMs: 80 }, (paths) =>
        batches.push(paths),
      );
      // Give chokidar a moment to attach before writing.
      await new Promise((r) => setTimeout(r, 200));
      await mkdir(join(root, ".dohc", "history"), { recursive: true });
      await writeFile(join(root, ".dohc", "history", "1.json"), "{}");
      await writeFile(join(root, "notes.md"), "hi");
      await new Promise((r) => setTimeout(r, 600));
      stop();
      const seen = batches.flat();
      // The user file is reported; nothing under .dohc/ ever is (no feedback loop).
      expect(seen).toContain("notes.md");
      expect(seen.some((p) => p.includes(".dohc"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
