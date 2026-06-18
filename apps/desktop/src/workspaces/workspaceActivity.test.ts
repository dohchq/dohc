import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addBoundaryCrossing,
  addFileChanges,
  createChangeSet,
} from "@dohc/workspace-core";
import { createChangeSetStore } from "./workspaceWatcher";
import { createWorkspaceActivity } from "./workspaceActivity";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-activity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function workspace(): CreatedWorkspace {
  return {
    workspaceId: "activity-test",
    rootPath: root,
    kind: "personal",
    mode: "local-first",
  };
}

describe("workspaceActivity catch-up", () => {
  it("summarizes omitted unseen entries before advancing the catch-up cursor", async () => {
    const store = createChangeSetStore(root);
    for (let i = 0; i < 52; i++) {
      await store.record(
        addFileChanges(
          createChangeSet({
            kind: "user-edit",
            author: { kind: "user", userId: "ice" },
            summary: `Edited ${i}`,
          }),
          [{ path: `notes/${i}.md`, operation: "write" }],
        ),
        { id: `change-${String(i).padStart(2, "0")}`, recordedAtMs: 1000 + i },
      );
    }

    const activity = createWorkspaceActivity(() => {});
    const summary = await activity.readCatchUpSummary(workspace(), {
      workspaceId: "activity-test",
      sinceMs: 0,
    });

    expect(summary.lines).toHaveLength(50);
    expect(summary.lines[0]).toBe("ice edited notes/51.md");
    expect(summary.lines[summary.lines.length - 1]).toBe(
      "3 older changes not shown.",
    );
    expect(summary.latestChangeSetId).toBe("change-51");
    expect(summary.latestHistoryIndex).toBe(51);
  }, 15000);

  it("reads one detailed change set with file snapshots for history expansion", async () => {
    const store = createChangeSetStore(root);
    await store.record(
      addFileChanges(
        createChangeSet({
          kind: "user-edit",
          author: { kind: "user", userId: "ice" },
          summary: "Edited today",
        }),
        [
          {
            path: "notes/today.md",
            operation: "write",
            mediaType: "text/markdown",
            before: { text: "# Today\nBefore\n", truncated: false },
            after: { text: "# Today\nAfter\n", truncated: false },
          },
        ],
      ),
      { id: "change-detail", recordedAtMs: 1000 },
    );

    const activity = createWorkspaceActivity(() => {});
    const result = await activity.readChangeSet(workspace(), "change-detail");

    expect(result.changeSet?.humanSummary).toBe("You edited notes/today.md");
    expect(result.changeSet?.files[0]).toMatchObject({
      path: "notes/today.md",
      before: { text: "# Today\nBefore\n" },
      after: { text: "# Today\nAfter\n" },
    });
  });

  it("lists lightweight review metadata for scan-friendly history rows", async () => {
    const store = createChangeSetStore(root);
    await store.record(
      addBoundaryCrossing(
        addFileChanges(
          createChangeSet({
            kind: "sync",
            author: { kind: "user", userId: "ice" },
            summary: "Shared data",
          }),
          [
            {
              path: "notes/shared.md",
              operation: "write",
              before: { text: "old\nsame\n", truncated: false },
              after: { text: "new\nsame\nmore\n", truncated: false },
            },
            {
              path: "notes/brief.md",
              operation: "write",
              after: { text: "created\n", truncated: false },
            },
            {
              path: "data/old.csv",
              operation: "delete",
              before: { text: "gone\n", truncated: false },
              after: { unavailableReason: "missing" },
            },
            { path: "docs/renamed.md", operation: "rename" },
            { path: "docs/extra.md", operation: "write" },
          ],
        ),
        "private-to-shared",
      ),
      { id: "review-needed", recordedAtMs: 1000 },
    );

    const activity = createWorkspaceActivity(() => {});
    const [record] = await activity.listChangeSets(workspace());

    expect(record.reviewRequired).toBe(true);
    expect(record.boundaryCrossingCount).toBe(1);
    expect(record.boundaryCrossingPreview).toEqual(["private-to-shared"]);
    expect(record.fileCount).toBe(5);
    expect(record.filePreview).toEqual([
      { path: "notes/shared.md", operation: "write" },
      { path: "notes/brief.md", operation: "write" },
      { path: "data/old.csv", operation: "delete" },
      { path: "docs/renamed.md", operation: "rename" },
    ]);
    expect(record.lineStats).toEqual({
      added: 3,
      removed: 2,
      changedFileCount: 3,
      unavailableFileCount: 2,
    });
  });
});
