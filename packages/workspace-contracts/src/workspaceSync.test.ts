import { expect, it } from "vitest";
import { WorkspaceSyncPause, WorkspaceSyncPauseStatus, workspaceSyncPauseStatus } from "./workspaceSync";

it("stores a local person id and resolves self and their current name when read", () => {
  const pause = WorkspaceSyncPause.parse({ atMs: 42, author: { kind: "person", personId: "local:person" } });
  const before = JSON.stringify(pause);
  let name: string | undefined;
  const read = () => WorkspaceSyncPauseStatus.parse(workspaceSyncPauseStatus(pause, "local:person", () => name));
  expect(read().author).toEqual({ kind: "person", personId: "local:person", self: true });
  name = "Mira";
  expect(read().author).toEqual({ kind: "person", personId: "local:person", self: true, displayName: "Mira" });
  expect(workspaceSyncPauseStatus(pause, "local:other", () => "Current name").author)
    .toEqual({ kind: "person", personId: "local:person", self: false, displayName: "Current name" });
  expect(JSON.stringify(pause)).toBe(before);
  expect(WorkspaceSyncPause.safeParse({ atMs: 42, author: { ...pause.author, displayName: "Frozen name" } }).success).toBe(false);
});

it("keeps agent provenance unchanged", () => {
  const pause = WorkspaceSyncPause.parse({ atMs: 42, author: { kind: "agent", agentId: "Claude", onBehalfOf: "owner", depth: 1 } });
  expect(workspaceSyncPauseStatus(pause, "local:person", () => "Mira")).toEqual(pause);
});
