import { describe, expect, it, vi } from "vitest";
import {
  createTryInVersionSessions,
  tryVersionName,
  type TryVersionOperations,
  type TryVersionSnapshotLike,
} from "./tryInVersion";

// PR 0N-2 "Try it in a version": one gesture composes EXISTING operations —
// create a fork named after the task, which activates it (0M-4
// create-and-switch), then start a dohc-tracked agent run. On run end the
// session turns into a review state carrying the changed-file count vs Main.

function snapshotWith(
  versions: Array<{ id: string; name: string; kind?: "main" | "named"; fork?: string }>,
  activeVersionId: string,
): TryVersionSnapshotLike {
  return {
    versions: versions.map((version) => ({
      id: version.id,
      name: version.name,
      kind: version.kind ?? "named",
      ...(version.fork ? { forkPoint: { versionId: version.fork } } : {}),
    })),
    activeVersionId,
  };
}

function fakeOperations(input?: {
  existingNames?: string[];
  compare?: () => Promise<Array<{ path: string }>>;
  fromVersionId?: string;
}): TryVersionOperations & { created: string[] } {
  const created: string[] = [];
  const existing = (input?.existingNames ?? []).map((name, index) => ({
    id: `v-${index}`,
    name,
  }));
  return {
    created,
    async listVersions() {
      return snapshotWith(
        [{ id: "main", name: "Main", kind: "main" }, ...existing],
        "main",
      );
    },
    async createVersion(name: string) {
      created.push(name);
      return snapshotWith(
        [
          { id: "main", name: "Main", kind: "main" },
          ...existing,
          { id: "try-1", name, fork: input?.fromVersionId ?? "main" },
        ],
        "try-1",
      );
    },
    compareVersions:
      input?.compare ?? (async () => [{ path: "a.md" }, { path: "b.md" }]),
  };
}

function manager(input?: {
  ops?: TryVersionOperations;
  startRun?: (workspaceId: string, task: string, driverId?: string) => Promise<{ id: string }>;
  onStateChanged?: (workspaceId: string) => void;
  now?: () => number;
}) {
  const ops = input?.ops ?? fakeOperations();
  return createTryInVersionSessions({
    operationsFor: async () => ops,
    startRun: input?.startRun ?? (async () => ({ id: "run-1" })),
    onStateChanged: input?.onStateChanged,
    now: input?.now,
  });
}

describe("tryVersionName", () => {
  it("prefixes the task and collapses whitespace", () => {
    expect(tryVersionName("tidy   the\n notes", [])).toBe("Try: tidy the notes");
  });

  it("truncates long tasks to a short readable snippet", () => {
    const task = "rewrite every heading so the whole plan reads as one calm story";
    const name = tryVersionName(task, []);
    expect(name.startsWith("Try: rewrite every heading")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(46);
  });

  it("suffixes on collision until the name is free", () => {
    const taken = ["Try: tidy notes", "Try: tidy notes 2"];
    expect(tryVersionName("tidy notes", taken)).toBe("Try: tidy notes 3");
  });
});

describe("createTryInVersionSessions", () => {
  it("composes name -> create-and-switch -> run start, and reports running", async () => {
    const ops = fakeOperations();
    const startRun = vi.fn(async () => ({ id: "run-9" }));
    const changed: string[] = [];
    const sessions = manager({
      ops,
      startRun,
      onStateChanged: (id) => changed.push(id),
      now: () => 1000,
    });

    const started = await sessions.start("ws", "  tidy the notes ", "codex");
    expect(ops.created).toEqual(["Try: tidy the notes"]);
    expect(startRun).toHaveBeenCalledWith("ws", "tidy the notes", "codex");
    expect(started).toEqual({
      versionId: "try-1",
      versionName: "Try: tidy the notes",
      runId: "run-9",
    });
    expect(changed).toEqual(["ws"]);
    expect(sessions.snapshot("ws")).toMatchObject({
      status: "running",
      task: "tidy the notes",
      versionId: "try-1",
      versionName: "Try: tidy the notes",
      runId: "run-9",
      startedAtMs: 1000,
      mergeAvailable: true,
    });
  });

  it("suffixes the version name when the task collides with an existing version", async () => {
    const ops = fakeOperations({ existingNames: ["Try: tidy notes"] });
    const sessions = manager({ ops });
    const started = await sessions.start("ws", "tidy notes");
    expect(started.versionName).toBe("Try: tidy notes 2");
  });

  it("refuses a blank task and a second concurrent try in the same workspace", async () => {
    const sessions = manager();
    await expect(sessions.start("ws", "   ")).rejects.toThrow(/what the agent should try/i);
    await sessions.start("ws", "first task");
    await expect(sessions.start("ws", "second task")).rejects.toThrow(/already trying/i);
    // A different workspace is unaffected.
    await expect(sessions.start("other", "second task")).resolves.toMatchObject({
      versionName: "Try: second task",
    });
  });

  it("does not record a session when the run fails to start, and says the version exists", async () => {
    const sessions = manager({
      startRun: async () => {
        throw new Error("driver missing");
      },
    });
    await expect(sessions.start("ws", "tidy notes")).rejects.toThrow(
      /version .* was created.*agent could not start.*driver missing/is,
    );
    expect(sessions.snapshot("ws")).toBeNull();
    // The workspace is free to try again.
    await expect(manager().start("ws", "tidy notes")).resolves.toMatchObject({
      runId: "run-1",
    });
  });

  it("turns run end into a review state with the changed-file count vs Main", async () => {
    const changed: string[] = [];
    let nowMs = 1000;
    const sessions = manager({
      onStateChanged: (id) => changed.push(id),
      now: () => nowMs,
    });
    await sessions.start("ws", "tidy notes");
    nowMs = 5000;
    sessions.handleRunEnded("ws", "run-1", "complete");
    await sessions.settled();
    expect(sessions.snapshot("ws")).toMatchObject({
      status: "review",
      runOutcome: "complete",
      changedFileCount: 2,
      endedAtMs: 5000,
      mergeAvailable: true,
    });
    // One notification for start, one for the review transition.
    expect(changed).toEqual(["ws", "ws"]);
  });

  it("reports a zero-change run honestly", async () => {
    const ops = fakeOperations({ compare: async () => [] });
    const sessions = manager({ ops });
    await sessions.start("ws", "tidy notes");
    sessions.handleRunEnded("ws", "run-1", "complete");
    await sessions.settled();
    expect(sessions.snapshot("ws")).toMatchObject({
      status: "review",
      changedFileCount: 0,
    });
  });

  it("keeps the review honest when the count is unavailable (compare failed)", async () => {
    const ops = fakeOperations({
      compare: async () => {
        throw new Error("store busy");
      },
    });
    const sessions = manager({ ops });
    await sessions.start("ws", "tidy notes");
    sessions.handleRunEnded("ws", "run-1", "failed");
    await sessions.settled();
    expect(sessions.snapshot("ws")).toMatchObject({
      status: "review",
      runOutcome: "failed",
      changedFileCount: null,
    });
  });

  it("ignores runs it does not own and duplicate end signals", async () => {
    const compare = vi.fn(async () => [{ path: "a.md" }]);
    const ops = fakeOperations({ compare });
    const sessions = manager({ ops });
    await sessions.start("ws", "tidy notes");
    sessions.handleRunEnded("ws", "someone-elses-run", "complete");
    await sessions.settled();
    expect(sessions.snapshot("ws")).toMatchObject({ status: "running" });
    sessions.handleRunEnded("ws", "run-1", "complete");
    sessions.handleRunEnded("ws", "run-1", "complete");
    await sessions.settled();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(sessions.snapshot("ws")).toMatchObject({ status: "review" });
  });

  it("still reaches review when the run ended before the session was recorded", async () => {
    // startSession can finalize a failed run BEFORE tryInVersion.start returns
    // its runId — the end signal must not be lost in that gap.
    const gate: { release: (() => void) | null } = { release: null };
    const sessions = manager({
      startRun: async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { id: "run-1" };
      },
    });
    const starting = sessions.start("ws", "tidy notes");
    await vi.waitFor(() => {
      if (!gate.release) throw new Error("startRun not reached yet");
    });
    // The run ends while start() is still awaiting the run id.
    sessions.handleRunEnded("ws", "run-1", "failed");
    gate.release?.();
    await starting;
    await sessions.settled();
    expect(sessions.snapshot("ws")).toMatchObject({
      status: "review",
      runOutcome: "failed",
    });
  });

  it("merge availability is false when the try was forked from a named version", async () => {
    const ops = fakeOperations({ fromVersionId: "v-feature" });
    const sessions = manager({ ops });
    await sessions.start("ws", "tidy notes");
    expect(sessions.snapshot("ws")).toMatchObject({ mergeAvailable: false });
  });

  it("dismiss clears only a review session", async () => {
    const changed: string[] = [];
    const sessions = manager({ onStateChanged: (id) => changed.push(id) });
    await sessions.start("ws", "tidy notes");
    // Running sessions are honest status, not dismissible.
    sessions.dismiss("ws");
    expect(sessions.snapshot("ws")).toMatchObject({ status: "running" });
    sessions.handleRunEnded("ws", "run-1", "complete");
    await sessions.settled();
    sessions.dismiss("ws");
    expect(sessions.snapshot("ws")).toBeNull();
    // start, review, dismiss.
    expect(changed).toEqual(["ws", "ws", "ws"]);
    // After a dismiss the workspace can try again.
    await expect(sessions.start("ws", "again")).resolves.toMatchObject({
      versionName: "Try: again",
    });
  });
});
