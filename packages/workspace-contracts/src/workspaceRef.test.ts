import { expect, it } from "vitest";
import { workspaceRefsEqual, type WorkspaceRef, type WorkspaceRefTarget } from "./workspaceRef";

const targets: WorkspaceRefTarget[] = [
  { kind: "file", objectId: "id" }, { kind: "channel", channelId: "id" },
  { kind: "thread", threadId: "id" }, { kind: "dataset", datasetId: "id" },
  { kind: "table", datasetId: "dataset", tableId: "id" }, { kind: "version", versionId: "id" },
];
const ref = (target: WorkspaceRefTarget): WorkspaceRef => ({ workspaceId: "source", target,
  labels: { path: "old.md", name: "Old", displayKind: "markdown" } });
it.each(targets)("ignores labels for $kind identity", target => {
  expect(workspaceRefsEqual(ref(target), { ...ref(target), labels: { name: "Renamed", displayKind: "binary" } })).toBe(true);
  expect(workspaceRefsEqual(ref(target), { ...ref(target), workspaceId: "mount" })).toBe(false);
});
it("compares every native target component and discriminant", () => {
  for (const left of targets) for (const right of targets) expect(workspaceRefsEqual(ref(left), ref(right))).toBe(left === right);
  expect(workspaceRefsEqual(ref({ kind: "file", objectId: "a" }), ref({ kind: "file", objectId: "b" }))).toBe(false);
  expect(workspaceRefsEqual(ref({ kind: "table", datasetId: "a", tableId: "t" }), ref({ kind: "table", datasetId: "b", tableId: "t" }))).toBe(false);
  expect(workspaceRefsEqual(ref({ kind: "table", datasetId: "a", tableId: "t" }), ref({ kind: "table", datasetId: "a", tableId: "u" }))).toBe(false);
});
