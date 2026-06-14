import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addFileChanges, createChangeSet } from "@dohc/workspace-core";
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
});
