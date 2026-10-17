import { expect, it } from "vitest";
import { WorkspaceSyncPause, WorkspaceSyncPauseStatus, workspaceSyncPauseStatus } from "./workspaceSync";

it("compares the stored local person id without adding profile names", () => {
  const pause = WorkspaceSyncPause.parse({ atMs: 42, author: { kind: "person", personId: "local:person" } });
  const before = JSON.stringify(pause);
  expect(WorkspaceSyncPauseStatus.parse(workspaceSyncPauseStatus(pause, "local:person")).author)
    .toEqual({ kind: "person", personId: "local:person", self: true });
  expect(workspaceSyncPauseStatus(pause, "local:other").author)
    .toEqual({ kind: "person", personId: "local:person", self: false });
  expect(JSON.stringify(pause)).toBe(before);
  expect(WorkspaceSyncPause.safeParse({ atMs: 42, author: { ...pause.author, displayName: "Frozen name" } }).success).toBe(false);
});

it("keeps agent provenance unchanged", () => {
  const pause = WorkspaceSyncPause.parse({ atMs: 42, author: { kind: "agent", agentId: "Claude", onBehalfOf: "owner", depth: 1 } });
  expect(workspaceSyncPauseStatus(pause, "local:person")).toEqual(pause);
});
