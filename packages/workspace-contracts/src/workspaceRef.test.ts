import { expect, it } from "vitest";
import { workspaceRefsEqual, type WorkspaceRef, type WorkspaceRefTarget } from "./workspaceRef";

const targets: WorkspaceRefTarget[] = [
  { kind: "file", objectId: "id" }, { kind: "channel", channelId: "id" },
  { kind: "thread", threadId: "id" }, { kind: "dataset", datasetId: "id" },
  { kind: "table", datasetId: "dataset", tableId: "id" }, { kind: "version", versionId: "id" },
];
const ref = (target: WorkspaceRefTarget): WorkspaceRef => ({ source: { workspaceId: "source" }, target,
  labels: { path: "old.md", name: "Old", displayKind: "markdown" } });
it.each(targets)("ignores labels for $kind identity", target => {
  expect(workspaceRefsEqual(ref(target), { ...ref(target), labels: { name: "Renamed", displayKind: "binary" } })).toBe(true);
  expect(workspaceRefsEqual(ref(target), { ...ref(target), source: { workspaceId: "mount" } })).toBe(false);
});
it("compares every native target component and discriminant", () => {
  for (const left of targets) for (const right of targets) expect(workspaceRefsEqual(ref(left), ref(right))).toBe(left === right);
  expect(workspaceRefsEqual(ref({ kind: "file", objectId: "a" }), ref({ kind: "file", objectId: "b" }))).toBe(false);
  expect(workspaceRefsEqual(ref({ kind: "table", datasetId: "a", tableId: "t" }), ref({ kind: "table", datasetId: "b", tableId: "t" }))).toBe(false);
  expect(workspaceRefsEqual(ref({ kind: "table", datasetId: "a", tableId: "t" }), ref({ kind: "table", datasetId: "a", tableId: "u" }))).toBe(false);
});

it("separates source variants even when their strings match", () => {
  const owned=ref({kind:"file",objectId:"o"});
  const handle="share-source:v1:"+"a".repeat(64);
  expect(workspaceRefsEqual({...owned,source:{workspaceId:handle}},{...owned,source:{receivedSource:handle}})).toBe(false);
  expect(workspaceRefsEqual({...owned,source:{receivedSource:handle}},{...owned,source:{receivedSource:handle}})).toBe(true);
});
it("rejects both source fields, neither field, and malformed handles", async () => {
  const {isWorkspaceRefSource}=await import("./workspaceRef");
  for(const source of [{}, {workspaceId:"w",receivedSource:"share-source:v1:"+"a".repeat(64)}, {receivedSource:"w"}, {workspaceId:""}]) expect(isWorkspaceRefSource(source)).toBe(false);
});
