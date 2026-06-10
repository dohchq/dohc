import { describe, expect, it } from "vitest";
import type {
  ChangeAuthor,
  ChangeProvenance,
  WatcherEvent,
  WatcherEventBatch,
} from "@dohc/workspace-core";
import { batchToChangeSet } from "./batchedSync";

const userAuthor: ChangeAuthor = { kind: "user", userId: "user-1" };
const agentAuthor: ChangeAuthor = {
  kind: "agent",
  agentId: "codex-local",
  onBehalfOf: "user-1",
};

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
