import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBoundaryCrossing,
  addFileChanges,
  createChangeSet,
  type ChangeSet,
} from "@dohc/workspace-core";
import { createChangeSetStore, humanSummary } from "./changeSetStore";

const userAuthor = { kind: "user" as const, userId: "user-1" };
const agentAuthor = {
  kind: "agent" as const,
  agentId: "codex-local",
  onBehalfOf: "Maya",
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-history-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function userEdit(): ChangeSet {
  return addFileChanges(
    createChangeSet({
      kind: "user-edit",
      author: userAuthor,
      summary: "Edited today's notes",
      provenance: { source: "user-edit" },
    }),
    [{ path: "notes/today.md", operation: "write" }],
  );
}

function agentImport(): ChangeSet {
  const files = Array.from({ length: 18 }, (_, i) => ({
    path: `finance/import/file-${i}.csv`,
    operation: "write" as const,
  }));
  return addFileChanges(
    createChangeSet({
      kind: "import",
      author: agentAuthor,
      summary: "Imported transactions",
      provenance: { source: "import", importPath: "/tmp/transactions" },
    }),
    files,
  );
}

describe("changeSetStore persistence", () => {
  it("writes an inspectable JSON file under .dohc/history and round-trips via get", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(userEdit(), {
      id: "abc",
      recordedAtMs: 1000,
    });

    // The per-record file is plain, pretty JSON anyone can open and read.
    const historyDir = join(root, ".dohc", "history");
    const entries = await readdir(historyDir);
    const recordFile = entries.find((name) => name === "1000-abc.json");
    expect(recordFile).toBeDefined();

    const raw = await readFile(join(historyDir, recordFile!), "utf8");
    // Pretty-printed (indented), inspectable JSON — not a packed blob.
    expect(raw).toContain("\n  ");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("abc");
    expect(parsed.kind).toBe("user-edit");

    const got = await store.get("abc");
    expect(got).not.toBeNull();
    expect(got).toEqual(recorded);
    expect(got!.files).toHaveLength(1);
    expect(got!.author).toEqual(userAuthor);
    expect(got!.provenance).toEqual({ source: "user-edit" });
  });

  it("returns null from get for an unknown id", async () => {
    const store = createChangeSetStore(root);
    expect(await store.get("nope")).toBeNull();
  });

  it("rejects unsafe history ids before they can become filenames", async () => {
    const store = createChangeSetStore(root);
    await expect(
      store.record(userEdit(), { id: "../escape", recordedAtMs: 1000 }),
    ).rejects.toThrow(/invalid history record id/i);
    await expect(store.get("../escape")).rejects.toThrow(/invalid history record id/i);
  });

  it("lists the timeline newest first", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "third", recordedAtMs: 3000 });

    const timeline = await store.list();
    expect(timeline.map((r) => r.id)).toEqual(["third", "second", "first"]);
    // Each listed record is the full record read back from its own file.
    expect(timeline[1].files).toHaveLength(18);
    expect(timeline[1].kind).toBe("import");
  });

  it("lists display-ordered records with their durable append index", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "same-b", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "same-a", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "clock-skewed", recordedAtMs: 1500 });

    const indexed = await store.listIndexed();
    expect(indexed.map((entry) => entry.record.id)).toEqual([
      "same-b",
      "same-a",
      "clock-skewed",
      "first",
    ]);
    expect(indexed.map((entry) => entry.index)).toEqual([1, 2, 3, 0]);
  });

  it("appends to an ordered index.json carrying lightweight summaries", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });

    const indexPath = join(root, ".dohc", "history", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(2);
    const entry = index.find((e: { id: string }) => e.id === "second");
    expect(entry).toMatchObject({
      id: "second",
      recordedAtMs: 2000,
      kind: "import",
      summary: "Imported transactions",
      fileCount: 18,
    });
    expect(entry.author).toEqual(agentAuthor);
  });

  it("records carry kind, author, provenance, and boundary crossings", async () => {
    const store = createChangeSetStore(root);
    const set = addBoundaryCrossing(agentImport(), "external-export");
    const recorded = await store.record(set, { id: "x", recordedAtMs: 5000 });
    expect(recorded.kind).toBe("import");
    expect(recorded.author).toEqual(agentAuthor);
    expect(recorded.provenance).toEqual({
      source: "import",
      importPath: "/tmp/transactions",
    });
    expect(recorded.boundaryCrossings).toContain("external-export");

    const got = await store.get("x");
    expect(got!.boundaryCrossings).toContain("external-export");
  });

  it("migrates legacy persisted site history values while reading records", async () => {
    const legacyBuildKind = ["app", "build"].join("-");
    const legacyTrustBoundary = ["app", "trust"].join("-");
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "legacy-site",
            recordedAtMs: 1000,
            kind: legacyBuildKind,
            author: agentAuthor,
            summary: "Legacy site build",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-legacy-site.json"),
      `${JSON.stringify(
        {
          id: "legacy-site",
          recordedAtMs: 1000,
          kind: legacyBuildKind,
          author: agentAuthor,
          summary: "Legacy site build",
          files: [{ path: "sites/client/dist/index.html", operation: "write" }],
          provenance: { source: legacyBuildKind },
          boundaryCrossings: [legacyTrustBoundary],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    await expect(store.get("legacy-site")).resolves.toMatchObject({
      id: "legacy-site",
      kind: "site-build",
      provenance: { source: "site-build" },
      boundaryCrossings: ["site-publish"],
    });
    await expect(store.list()).resolves.toMatchObject([
      {
        id: "legacy-site",
        kind: "site-build",
        provenance: { source: "site-build" },
        boundaryCrossings: ["site-publish"],
      },
    ]);
    await expect(store.listIndexed()).resolves.toMatchObject([
      {
        record: {
          id: "legacy-site",
          kind: "site-build",
          provenance: { source: "site-build" },
          boundaryCrossings: ["site-publish"],
        },
      },
    ]);
  });

  it("rejects unknown persisted history enum values instead of type-casting them", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "corrupt",
            recordedAtMs: 1000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt record",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-corrupt.json"),
      `${JSON.stringify(
        {
          id: "corrupt",
          recordedAtMs: 1000,
          kind: "made-up-kind",
          author: userAuthor,
          summary: "Corrupt record",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: ["also-made-up"],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("corrupt")).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-history] skipping unreadable record corrupt:"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("skips corrupt index entries with unknown kinds", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "corrupt-index",
            recordedAtMs: 1000,
            kind: "made-up-kind",
            author: userAuthor,
            summary: "Corrupt index",
            fileCount: 1,
          },
          {
            id: "valid",
            recordedAtMs: 2000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Valid record",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "2000-valid.json"),
      `${JSON.stringify(
        {
          id: "valid",
          recordedAtMs: 2000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Valid record",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: [],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("corrupt-index")).resolves.toBeNull();
      await expect(store.list()).resolves.toMatchObject([{ id: "valid", kind: "user-edit" }]);
      await expect(store.listSince(0)).resolves.toMatchObject([
        { id: "valid", kind: "user-edit" },
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "[workspace-history] skipping unreadable index entry corrupt-index:",
        ),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects unknown persisted boundary crossings even when the kind is valid", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "bad-boundary",
            recordedAtMs: 1000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt boundary",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-bad-boundary.json"),
      `${JSON.stringify(
        {
          id: "bad-boundary",
          recordedAtMs: 1000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Corrupt boundary",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: ["also-made-up"],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("bad-boundary")).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-history] skipping unreadable record bad-boundary:"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects unknown persisted provenance source values", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "bad-provenance",
            recordedAtMs: 1000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt provenance",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-bad-provenance.json"),
      `${JSON.stringify(
        {
          id: "bad-provenance",
          recordedAtMs: 1000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Corrupt provenance",
          files: [{ path: "notes/today.md", operation: "write" }],
          provenance: { source: "made-up-source" },
          boundaryCrossings: [],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("bad-provenance")).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-history] skipping unreadable record bad-provenance:"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("humanSummary", () => {
  it("attributes an agent run to the person it acted on behalf of", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(agentImport(), {
      id: "agent",
      recordedAtMs: 1000,
    });
    const line = humanSummary(recorded);
    expect(line).toContain("Maya");
    expect(line).toContain("agent");
    expect(line).toContain("18");
  });

  it("attributes a user edit to the user, not an agent", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(userEdit(), {
      id: "user",
      recordedAtMs: 1000,
    });
    const line = humanSummary(recorded);
    expect(line.toLowerCase()).toContain("you");
    expect(line).not.toContain("agent");
  });

  it("summarizes history restore provenance as restore or undo", async () => {
    const restored = addFileChanges(
      createChangeSet({
        kind: "history-restore",
        author: userAuthor,
        summary: "Restored notes/today.md from history",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-1",
          restoreOfPath: "notes/today.md",
          restoreDirection: "restore",
        },
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );
    const undone = addFileChanges(
      createChangeSet({
        kind: "history-restore",
        author: userAuthor,
        summary: "Undid restore for notes/today.md",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-1",
          restoreOfPath: "notes/today.md",
          restoreDirection: "undo",
        },
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );

    const store = createChangeSetStore(root);
    const restoredRecord = await store.record(restored, {
      id: "restore",
      recordedAtMs: 1000,
    });
    const undoneRecord = await store.record(undone, {
      id: "undo",
      recordedAtMs: 2000,
    });

    expect(humanSummary(restoredRecord)).toBe("You restored notes/today.md");
    expect(humanSummary(undoneRecord)).toBe(
      "You undid restore for notes/today.md",
    );
  });

  it("produces different attributed summaries for a user edit vs an agent run", async () => {
    const store = createChangeSetStore(root);
    const userRec = await store.record(userEdit(), {
      id: "u",
      recordedAtMs: 1000,
    });
    const agentRec = await store.record(agentImport(), {
      id: "a",
      recordedAtMs: 2000,
    });
    expect(humanSummary(userRec)).not.toBe(humanSummary(agentRec));
  });

  it("never contains git conflict markers", async () => {
    const store = createChangeSetStore(root);
    const userRec = await store.record(userEdit(), {
      id: "u",
      recordedAtMs: 1000,
    });
    const agentRec = await store.record(agentImport(), {
      id: "a",
      recordedAtMs: 2000,
    });
    expect(humanSummary(userRec)).not.toMatch(/<{7}|>{7}|={7}/);
    expect(humanSummary(agentRec)).not.toMatch(/<{7}|>{7}|={7}/);
  });

  it("does not drop entries when records are fired concurrently", async () => {
    // The live watcher fires record() fire-and-forget; without serialization
    // two close-together records race on index.json and the second clobbers
    // the first's entry, silently dropping it from the timeline.
    const store = createChangeSetStore(root);
    const writes = Array.from({ length: 25 }, (_, i) =>
      store.record(userEdit(), { id: `c${i}`, recordedAtMs: 1000 + i }),
    );
    await Promise.all(writes);
    const listed = await store.list();
    expect(listed).toHaveLength(25);
    expect(new Set(listed.map((r) => r.id)).size).toBe(25);
  });
});

describe("listSince (cloud sync cursor)", () => {
  it("returns only records strictly newer than the cursor, oldest first", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "dohc-hist-"));
    try {
      const store = createChangeSetStore(root);
      const set = (summary: string) => ({
        kind: "user-edit" as const,
        author: { kind: "user" as const, userId: "u1" },
        summary,
        files: [{ path: "a.md", operation: "write" as const }],
        boundaryCrossings: [],
      });
      await store.record(set("first"), { id: "a", recordedAtMs: 100 });
      await store.record(set("second"), { id: "b", recordedAtMs: 200 });
      await store.record(set("third"), { id: "c", recordedAtMs: 300 });

      const since = await store.listSince(100);
      expect(since.map((r) => r.id)).toEqual(["b", "c"]);
      expect(await store.listSince(300)).toEqual([]);
      expect((await store.listSince(0)).map((r) => r.id)).toEqual(["a", "b", "c"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
