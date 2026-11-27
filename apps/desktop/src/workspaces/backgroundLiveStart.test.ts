import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_LIVE_START_MAX_QUEUED,
  createBackgroundLiveStart,
  syncedNotePaths,
  type BackgroundLiveStartOptions,
} from "./backgroundLiveStart";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "./workspaceTextLimits";

const QUIET = 5_000;
const GAP = 1_000;

function setup(overrides: Partial<BackgroundLiveStartOptions> = {}) {
  const started: string[] = [];
  const errors: unknown[] = [];
  const options: BackgroundLiveStartOptions = {
    eligible: () => true,
    noteIdentity: async (_workspaceId, path) => ({ versionId: "main", objectId: `object:${path}` }),
    showsOnPhone: async () => true,
    relayLiveNotes: async () => new Set(),
    noteBytes: async () => 10,
    isLossyNote: async () => false,
    start: async (workspaceId, path) => {
      started.push(`${workspaceId}:${path}`);
    },
    onError: (_message, error) => errors.push(error),
    quietMs: QUIET,
    gapMs: GAP,
    maxWaitMs: 60_000,
    ...overrides,
  };
  return { queue: createBackgroundLiveStart(options), started, errors };
}

describe("background live start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a written Markdown note once capture has been quiet", async () => {
    const { queue, started } = setup();
    queue.note("w", ["notes/agent.md"]);
    await vi.advanceTimersByTimeAsync(QUIET - 1);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["w:notes/agent.md"]);
  });

  it("starts only Markdown notes the server shows", async () => {
    const { queue, started } = setup();
    queue.note("w", ["data.csv", "app/index.html", "notes/a.MD", ".dohc/secret.md", ".env"]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(started).toEqual(["w:notes/a.MD"]);
  });

  it("does nothing for a workspace that doesn't sync to the owner's server", async () => {
    const { queue, started } = setup({ eligible: (workspaceId) => workspaceId === "synced" });
    queue.note("local", ["a.md"]);
    queue.note("synced", ["b.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(started).toEqual(["synced:b.md"]);
  });

  it("checks the workspace again when the note's turn comes", async () => {
    let syncs = true;
    const { queue, started } = setup({ eligible: () => syncs });
    queue.note("w", ["a.md"]);
    syncs = false;
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual([]);
  });

  it("starts one note at a time, a gap apart", async () => {
    let release!: () => void;
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    const { queue } = setup({
      start: async (_workspaceId, path) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        order.push(path);
        await new Promise<void>((resolve) => (release = resolve));
        inFlight -= 1;
      },
    });
    queue.note("w", ["a.md", "b.md", "c.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(order).toEqual(["a.md"]);
    // A note captured while one starts waits for it.
    queue.note("w", ["d.md"]);
    await vi.advanceTimersByTimeAsync(10 * GAP);
    expect(order).toEqual(["a.md"]);
    release();
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(order).toEqual(["a.md"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["a.md", "b.md"]);
    release();
    await vi.advanceTimersByTimeAsync(GAP);
    release();
    await vi.advanceTimersByTimeAsync(GAP);
    release();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(order).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(most).toBe(1);
  });

  it("waits while capture keeps recording, but no longer than the most wait", async () => {
    const { queue, started } = setup({ maxWaitMs: 12_000 });
    queue.note("w", ["a.md"]);
    for (let elapsed = 0; elapsed < 11_000; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      queue.note("w", ["a.md"]);
    }
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(["w:a.md"]);
  });

  it("keeps the gap between notes while capture records past the most wait", async () => {
    const { queue, started } = setup({ maxWaitMs: 12_000 });
    queue.note("w", ["a.md", "b.md", "c.md"]);
    for (let elapsed = 0; elapsed < 11_000; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      queue.note("w", ["x.md"]);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(["w:a.md"]);
    for (const next of ["w:b.md", "w:c.md"]) {
      const count = started.length;
      // Capture goes on recording within the gap.
      await vi.advanceTimersByTimeAsync(GAP / 2);
      queue.note("w", ["x.md"]);
      await vi.advanceTimersByTimeAsync(GAP / 2 - 1);
      expect(started).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(started.at(-1)).toBe(next);
    }
  });

  it("waits for capture to go quiet after a write recorded during a start", async () => {
    let release!: () => void;
    const order: string[] = [];
    const { queue } = setup({
      start: async (_workspaceId, path) => {
        order.push(path);
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    queue.note("w", ["a.md", "b.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(order).toEqual(["a.md"]);
    await vi.advanceTimersByTimeAsync(1_000);
    queue.note("w", ["c.md"]);
    await vi.advanceTimersByTimeAsync(500);
    release();
    // The gap ends at 7.5 s; capture is quiet only at 11 s.
    await vi.advanceTimersByTimeAsync(QUIET - 500 - 1);
    expect(order).toEqual(["a.md"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["a.md", "b.md"]);
  });

  it("waits only for capture in a workspace it can start notes in", async () => {
    let release!: () => void;
    const order: string[] = [];
    const { queue } = setup({
      eligible: (workspaceId) => workspaceId === "w",
      start: async (_workspaceId, path) => {
        order.push(path);
        if (path === "a.md") await new Promise<void>((resolve) => (release = resolve));
      },
    });
    queue.note("w", ["a.md", "b.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    queue.note("other", ["c.md"]);
    release();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(order).toEqual(["a.md", "b.md"]);
  });

  it("skips a note past the live size cap, and starts one at the cap", async () => {
    const sizes: Record<string, number> = {
      "big.md": WYSIWYG_MARKDOWN_THRESHOLD_BYTES + 1,
      "edge.md": WYSIWYG_MARKDOWN_THRESHOLD_BYTES,
    };
    const lossyChecks: string[] = [];
    const { queue, started } = setup({
      noteBytes: async (_workspaceId, path) => sizes[path] ?? null,
      isLossyNote: async (_workspaceId, path) => {
        lossyChecks.push(path);
        return false;
      },
    });
    queue.note("w", ["big.md", "edge.md", "gone.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(started).toEqual(["w:edge.md"]);
    // A big or missing note is never read whole.
    expect(lossyChecks).toEqual(["edge.md"]);
  });

  it("skips a lossy note, so the phone doesn't edit text dohc would change", async () => {
    const { queue, started } = setup({ isLossyNote: async (_w, path) => path === "lossy.md" });
    queue.note("w", ["lossy.md", "plain.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(started).toEqual(["w:plain.md"]);
  });

  it("starts a note once, however often it is written again", async () => {
    const { queue, started } = setup();
    queue.note("w", ["a.md", "a.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    queue.note("w", ["a.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual(["w:a.md"]);
  });

  it("starts a different note created at a started note's old path", async () => {
    const objects: Record<string, string> = { "agent.md": "first" };
    const { queue, started } = setup({
      noteIdentity: async (_workspaceId, path) =>
        objects[path] ? { versionId: "main", objectId: objects[path] } : null,
    });
    queue.note("w", ["agent.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual(["w:agent.md"]);

    // Rename the started note, then write a new one where it was.
    objects["archive.md"] = "first";
    objects["agent.md"] = "second";
    queue.note("w", ["archive.md", "agent.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(started).toEqual(["w:agent.md", "w:agent.md"]);
  });

  it("doesn't remember a note whose path held another object by the time it started", async () => {
    const objects: Record<string, string> = { "a.md": "first" };
    const { queue, started } = setup({
      noteIdentity: async (_workspaceId, path) =>
        objects[path] ? { versionId: "main", objectId: objects[path] } : null,
      start: async (workspaceId, path) => {
        started.push(`${workspaceId}:${path}`);
        objects["a.md"] = "second";
      },
    });
    queue.note("w", ["a.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    objects["b.md"] = "first";
    queue.note("w", ["b.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual(["w:a.md", "w:b.md"]);
  });

  it("skips a note that is already live on the relay, and can start it once it is no longer live", async () => {
    const live = new Set(["object:live.md"]);
    const { queue, started } = setup({
      relayLiveNotes: async () => new Set(live),
    });
    queue.note("w", ["live.md", "plain.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(started).toEqual(["w:plain.md"]);

    live.clear();
    queue.note("w", ["live.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual(["w:plain.md", "w:live.md"]);
  });

  it("fails closed when relay live-notes cannot be confirmed", async () => {
    const { queue, started } = setup({
      relayLiveNotes: async () => null,
    });
    queue.note("w", ["a.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + GAP);
    expect(started).toEqual([]);
  });

  it("skips starting if the path changed to another note during the relay live-notes check", async () => {
    const objects: Record<string, string> = { "a.md": "plain" };
    const { queue, started } = setup({
      noteIdentity: async (_workspaceId, path) =>
        objects[path] ? { versionId: "main", objectId: objects[path] } : null,
      relayLiveNotes: async () => {
        objects["a.md"] = "live-elsewhere";
        return new Set(["live-elsewhere"]);
      },
    });
    queue.note("w", ["a.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual([]);
  });

  it("extracts only tracked main Markdown text writes from synced fastForwardedPaths", async () => {
    const paths = syncedNotePaths([
      { versionId: "main", path: "notes/synced.md", operation: "write", contentKind: "text" },
      { versionId: "main", path: "notes/UPPER.MD", operation: "write", contentKind: "text" },
      { versionId: "main", path: "notes/deleted.md", operation: "delete", contentKind: "text" },
      { versionId: "main", path: "assets/img.png", operation: "write", contentKind: "binary" },
      { versionId: "main", path: ".env", operation: "write", contentKind: "secret" },
      { versionId: "main", path: ".dohc/internal.md", operation: "write", contentKind: "text" },
      { versionId: "main", path: "data/table.json", operation: "write", contentKind: "text" },
      { versionId: "draft-1", path: "notes/branch.md", operation: "write", contentKind: "text" },
    ]);
    expect(paths).toEqual(["notes/synced.md", "notes/UPPER.MD"]);

    const { queue, started } = setup();
    const burst = Array.from({ length: BACKGROUND_LIVE_START_MAX_QUEUED + 6 }, (_, i) => ({
      versionId: "main",
      path: `synced/n${i}.md`,
      operation: "write" as const,
      contentKind: "text" as const,
    }));
    queue.note("w", syncedNotePaths(burst));
    await vi.advanceTimersByTimeAsync(QUIET + burst.length * GAP);
    expect(started).toHaveLength(BACKGROUND_LIVE_START_MAX_QUEUED);
  });

  it("starts nothing in a workspace its server doesn't confirm shows on the phone", async () => {
    const asked: string[] = [];
    const { queue, started } = setup({
      showsOnPhone: async (workspaceId) => {
        asked.push(workspaceId);
        return workspaceId === "shown";
      },
    });
    queue.note("hidden", ["a.md"]);
    queue.note("shown", ["b.md"]);
    // The server is asked when the note's turn comes, not when capture records it.
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
    expect(asked).toEqual(["hidden", "shown"]);
    expect(started).toEqual(["shown:b.md"]);
  });

  it("tries a failed note again at its next write, and goes on to the next note", async () => {
    let fail = true;
    const { queue, started, errors } = setup({
      start: async (workspaceId, path) => {
        if (path === "a.md" && fail) throw new Error("engine busy");
        started.push(`${workspaceId}:${path}`);
      },
    });
    queue.note("w", ["a.md", "b.md"]);
    await vi.advanceTimersByTimeAsync(QUIET + GAP);
    expect(errors).toHaveLength(1);
    expect(started).toEqual(["w:b.md"]);
    fail = false;
    queue.note("w", ["a.md"]);
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(started).toEqual(["w:b.md", "w:a.md"]);
  });

  it("keeps a bounded queue, leaving the rest of a burst to its next write", async () => {
    const { queue, started } = setup();
    const paths = Array.from(
      { length: BACKGROUND_LIVE_START_MAX_QUEUED + 8 },
      (_, i) => `n${i}.md`,
    );
    queue.note("w", paths);
    await vi.advanceTimersByTimeAsync(QUIET + paths.length * GAP);
    expect(started).toHaveLength(BACKGROUND_LIVE_START_MAX_QUEUED);
    expect(started.at(-1)).toBe(`w:n${BACKGROUND_LIVE_START_MAX_QUEUED - 1}.md`);
  });

  describe("stopping", () => {
    // A start that holds its note open until released.
    function heldOpen() {
      const releases: Array<() => void> = [];
      const started: string[] = [];
      const ended: string[] = [];
      const start = async (workspaceId: string, path: string) => {
        started.push(`${workspaceId}:${path}`);
        await new Promise<void>((resolve) => releases.push(resolve));
        ended.push(`${workspaceId}:${path}`);
      };
      return { start, started, ended, release: () => releases.shift()!() };
    }

    function settledFlag(promise: Promise<void>) {
      const state = { settled: false };
      void promise.then(() => (state.settled = true));
      return state;
    }

    it("on quit, takes no more notes and waits for the start in flight to close", async () => {
      const held = heldOpen();
      const { queue } = setup({ start: held.start });
      queue.note("w", ["a.md", "b.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(held.started).toEqual(["w:a.md"]);

      const stopping = settledFlag(queue.stop());
      queue.note("w", ["c.md"]);
      await vi.advanceTimersByTimeAsync(10 * GAP);
      expect(stopping.settled).toBe(false);
      held.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopping.settled).toBe(true);
      expect(held.ended).toEqual(["w:a.md"]);
      await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
      expect(held.started).toEqual(["w:a.md"]);
    });

    it("on quit, cancels a start still checking its note, without waiting for the check", async () => {
      const { queue, started } = setup({ showsOnPhone: () => new Promise<boolean>(() => {}) });
      queue.note("w", ["a.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      const stopping = settledFlag(queue.stop());
      await vi.advanceTimersByTimeAsync(0);
      expect(stopping.settled).toBe(true);
      expect(started).toEqual([]);
    });

    it("on quit, aborts an in-flight relay live-notes check without waiting", async () => {
      let aborted = false;
      const { queue, started } = setup({
        relayLiveNotes: (_workspaceId, signal) =>
          new Promise<ReadonlySet<string> | null>(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      });
      queue.note("w", ["a.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      const stopping = settledFlag(queue.stop());
      await vi.advanceTimersByTimeAsync(0);
      expect(stopping.settled).toBe(true);
      expect(aborted).toBe(true);
      expect(started).toEqual([]);
    });

    it("on sign-out, forgets every waiting note and waits for the start in flight", async () => {
      const held = heldOpen();
      const { queue } = setup({ start: held.start });
      queue.note("one", ["a.md", "b.md"]);
      queue.note("two", ["c.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      const dropping = settledFlag(queue.drop());
      await vi.advanceTimersByTimeAsync(0);
      expect(dropping.settled).toBe(false);
      held.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(dropping.settled).toBe(true);
      await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
      expect(held.started).toEqual(["one:a.md"]);

      // The next session's notes start as usual.
      queue.note("one", ["d.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(held.started).toEqual(["one:a.md", "one:d.md"]);
      held.release();
    });

    it("on workspace close, forgets only that workspace's notes and waits only for its start", async () => {
      const held = heldOpen();
      const { queue } = setup({ start: held.start });
      queue.note("closing", ["a.md", "b.md"]);
      queue.note("open", ["c.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(held.started).toEqual(["closing:a.md"]);

      // Another workspace's close doesn't wait for this start.
      const other = settledFlag(queue.drop("elsewhere"));
      await vi.advanceTimersByTimeAsync(0);
      expect(other.settled).toBe(true);

      const closing = settledFlag(queue.drop("closing"));
      await vi.advanceTimersByTimeAsync(0);
      expect(closing.settled).toBe(false);
      held.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(closing.settled).toBe(true);
      await vi.advanceTimersByTimeAsync(GAP);
      expect(held.started).toEqual(["closing:a.md", "open:c.md"]);
      held.release();
    });

    it("on engine restart, takes no notes until the new engine launches", async () => {
      const { queue, started } = setup();
      queue.note("w", ["a.md"]);
      await queue.pause();
      queue.note("w", ["b.md"]);
      await vi.advanceTimersByTimeAsync(QUIET + 10 * GAP);
      expect(started).toEqual([]);

      queue.resume();
      queue.note("w", ["c.md"]);
      await vi.advanceTimersByTimeAsync(QUIET);
      expect(started).toEqual(["w:c.md"]);
    });
  });
});
