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

describe("workspaceActivity history", () => {
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

  it("merges durable and ephemeral history when durable recording is unsupported", async () => {
    const durable = createChangeSetStore(root);
    await durable.record(
      addFileChanges(
        createChangeSet({
          kind: "user-edit",
          author: { kind: "user", userId: "ice" },
          summary: "Durable edit",
        }),
        [{ path: "notes/durable.md", operation: "write" }],
      ),
      { id: "durable-record", recordedAtMs: 1000 },
    );
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const ephemeral = createChangeSetStore(root, { ephemeralIfUnsupported: true });
      await ephemeral.record(
        addFileChanges(
          createChangeSet({
            kind: "user-edit",
            author: { kind: "user", userId: "ice" },
            summary: "Ephemeral edit",
          }),
          [{ path: "notes/ephemeral.md", operation: "write" }],
        ),
        { id: "ephemeral-record", recordedAtMs: 1001 },
      );
      const activity = createWorkspaceActivity(() => {});

      await expect(activity.listChangeSets(workspace())).resolves.toMatchObject([
        { id: "ephemeral-record" },
        { id: "durable-record" },
      ]);
      await expect(activity.readChangeSet(workspace(), "durable-record")).resolves.toMatchObject({
        changeSet: { id: "durable-record" },
      });
      await expect(activity.readChangeSet(workspace(), "ephemeral-record")).resolves.toMatchObject({
        changeSet: { id: "ephemeral-record" },
      });
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});
