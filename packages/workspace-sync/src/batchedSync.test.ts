import { describe, expect, it } from "vitest";
import type {
  ChangeAuthor,
  ChangeProvenance,
  WatcherEvent,
  WatcherEventBatch,
} from "@dohc/workspace-core";
import { batchToChangeSet, createSettleBatcher } from "./batchedSync";

const userAuthor: ChangeAuthor = { kind: "user", userId: "user-1" };
const agentAuthor: ChangeAuthor = {
  kind: "agent",
  agentId: "codex-local",
  onBehalfOf: "user-1",
};

// Drives the batcher with an injected clock so tests are deterministic — no
// real timers. now() returns whatever we set; tick(ms) is the quiet-window
// probe a host would wire to a real interval.
function controllableClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
  };
}

describe("settle-window batcher", () => {
  it("emits one batch for a single markdown save after the window settles", () => {
    const clock = controllableClock();
    const batches: WatcherEventBatch[] = [];
    const batcher = createSettleBatcher({
      windowMs: 500,
      now: clock.now,
      onBatch: (batch) => batches.push(batch),
    });

    clock.set(0);
    batcher.push({ path: "notes/today.md", operation: "update", sha256: "a" });

    // Still inside the window — nothing should fire yet.
    clock.set(400);
    batcher.tick(400);
    expect(batches).toHaveLength(0);

    // Window has elapsed since the last event — one batch emits.
    clock.set(500);
    batcher.tick(500);
    expect(batches).toHaveLength(1);
    expect(batches[0].events).toHaveLength(1);
    expect(batches[0].events[0].path).toBe("notes/today.md");
    expect(batches[0].settledAtMs).toBe(500);
    expect(batches[0].windowMs).toBe(500);
  });

  it("groups 18 rapid writes within the window into one batch", () => {
    const clock = controllableClock();
    const batches: WatcherEventBatch[] = [];
    const batcher = createSettleBatcher({
      windowMs: 500,
      now: clock.now,
      onBatch: (batch) => batches.push(batch),
    });

    // 18 distinct app files written in quick succession (an agent build).
    for (let i = 0; i < 18; i++) {
      clock.set(i * 10);
      batcher.push({
        path: `finance/.apps/ledger/src/file-${i}.tsx`,
        operation: "create",
        sha256: `sha-${i}`,
      });
    }

    // No batch while events keep arriving inside the window.
    clock.set(180);
    batcher.tick(180);
    expect(batches).toHaveLength(0);

    // After windowMs of quiet, all 18 collapse into a single batch.
    clock.set(170 + 500);
    batcher.tick(170 + 500);
    expect(batches).toHaveLength(1);
    expect(batches[0].events).toHaveLength(18);
  });

  it("collapses rapid edits to the same path into one event with the latest sha256", () => {
    const clock = controllableClock();
    const batches: WatcherEventBatch[] = [];
    const batcher = createSettleBatcher({
      windowMs: 500,
      now: clock.now,
      onBatch: (batch) => batches.push(batch),
    });

    clock.set(0);
    batcher.push({ path: "notes/today.md", operation: "create", sha256: "v1" });
    clock.set(50);
    batcher.push({ path: "notes/today.md", operation: "update", sha256: "v2" });
    clock.set(100);
    batcher.push({ path: "notes/today.md", operation: "update", sha256: "v3" });

    clock.set(600);
    batcher.tick(600);

    expect(batches).toHaveLength(1);
    expect(batches[0].events).toHaveLength(1);
    expect(batches[0].events[0].sha256).toBe("v3");
  });

  it("starts a fresh batch after one settles", () => {
    const clock = controllableClock();
    const batches: WatcherEventBatch[] = [];
    const batcher = createSettleBatcher({
      windowMs: 500,
      now: clock.now,
      onBatch: (batch) => batches.push(batch),
    });

    clock.set(0);
    batcher.push({ path: "a.md", operation: "update", sha256: "a" });
    clock.set(500);
    batcher.tick(500);

    clock.set(1000);
    batcher.push({ path: "b.md", operation: "update", sha256: "b" });
    clock.set(1500);
    batcher.tick(1500);

    expect(batches).toHaveLength(2);
    expect(batches[0].events[0].path).toBe("a.md");
    expect(batches[1].events[0].path).toBe("b.md");
  });

  it("does not emit an empty batch when ticked with no pending events", () => {
    const clock = controllableClock();
    const batches: WatcherEventBatch[] = [];
    const batcher = createSettleBatcher({
      windowMs: 500,
      now: clock.now,
      onBatch: (batch) => batches.push(batch),
    });

    clock.set(1000);
    batcher.tick(1000);
    expect(batches).toHaveLength(0);
  });

  it("flush() emits the pending batch immediately regardless of the window", () => {
    const clock = controllableClock();
    const batches: WatcherEventBatch[] = [];
    const batcher = createSettleBatcher({
      windowMs: 500,
      now: clock.now,
      onBatch: (batch) => batches.push(batch),
    });

    clock.set(0);
    batcher.push({ path: "notes/today.md", operation: "update", sha256: "a" });
    clock.set(100);
    batcher.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0].events).toHaveLength(1);

    // Nothing left to emit after a flush.
    batcher.flush();
    expect(batches).toHaveLength(1);
  });
});

describe("batchToChangeSet", () => {
  const batch = (events: WatcherEvent[]): WatcherEventBatch => ({
    settledAtMs: 1000,
    windowMs: 500,
    events,
  });

  it("maps a single markdown save to one write change", () => {
    const set = batchToChangeSet(
      batch([{ path: "notes/today.md", operation: "update", sha256: "a" }]),
      { author: userAuthor },
    );
    expect(set.files).toEqual([{ path: "notes/today.md", operation: "write" }]);
    expect(set.kind).toBe("user-edit");
    expect(set.author).toEqual(userAuthor);
  });

  it("maps create/update to write, delete to delete, rename to rename", () => {
    const set = batchToChangeSet(
      batch([
        { path: "new.md", operation: "create", sha256: "n" },
        { path: "edited.md", operation: "update", sha256: "e" },
        { path: "gone.md", operation: "delete" },
        { path: "to.md", operation: "rename", fromPath: "from.md" },
      ]),
      { author: userAuthor },
    );
    expect(set.files).toEqual([
      { path: "new.md", operation: "write" },
      { path: "edited.md", operation: "write" },
      { path: "gone.md", operation: "delete" },
      { path: "to.md", operation: "rename" },
    ]);
  });

  it("groups an 18-file batch into a single change set", () => {
    const events: WatcherEvent[] = Array.from({ length: 18 }, (_, i) => ({
      path: `finance/.apps/ledger/src/file-${i}.tsx`,
      operation: "create" as const,
      sha256: `sha-${i}`,
    }));
    const set = batchToChangeSet(batch(events), {
      author: agentAuthor,
      provenance: { source: "agent-run", agentRunId: "run-1" },
    });
    expect(set.files).toHaveLength(18);
  });

  it("derives kind agent-run from agent-run provenance", () => {
    const provenance: ChangeProvenance = {
      source: "agent-run",
      agentRunId: "run-1",
    };
    const set = batchToChangeSet(
      batch([{ path: "app.tsx", operation: "create", sha256: "a" }]),
      { author: agentAuthor, provenance },
    );
    expect(set.kind).toBe("agent-run");
    expect(set.provenance).toEqual(provenance);
  });

  it("defaults kind to user-edit when no provenance is given", () => {
    const set = batchToChangeSet(
      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
      { author: userAuthor },
    );
    expect(set.kind).toBe("user-edit");
  });

  it("derives a default summary that counts edited files", () => {
    const set = batchToChangeSet(
      batch([
        { path: "a.md", operation: "update", sha256: "a" },
        { path: "b.md", operation: "update", sha256: "b" },
        { path: "c.md", operation: "create", sha256: "c" },
      ]),
      { author: userAuthor },
    );
    expect(set.summary).toBe("Edited 3 files");
  });

  it("uses an import-flavored summary for import provenance", () => {
    const events: WatcherEvent[] = Array.from({ length: 18 }, (_, i) => ({
      path: `imported/file-${i}.csv`,
      operation: "create" as const,
      sha256: `sha-${i}`,
    }));
    const set = batchToChangeSet(batch(events), {
      author: userAuthor,
      provenance: { source: "import", importPath: "/tmp/data" },
    });
    expect(set.kind).toBe("import");
    expect(set.summary).toBe("Imported 18 files");
  });

  it("singularizes the default summary for a single file", () => {
    const set = batchToChangeSet(
      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
      { author: userAuthor },
    );
    expect(set.summary).toBe("Edited 1 file");
  });

  it("honors an explicit summary over the derived default", () => {
    const set = batchToChangeSet(
      batch([{ path: "a.md", operation: "update", sha256: "a" }]),
      { author: userAuthor, summary: "Reworded the intro" },
    );
    expect(set.summary).toBe("Reworded the intro");
  });
});
