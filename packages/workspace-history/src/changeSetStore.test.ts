import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
