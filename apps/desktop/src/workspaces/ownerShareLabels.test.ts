import {expect, it, vi} from "vitest";
import {ownerShareLabels, refreshOwnerShareLabels, createOwnerShareLabelRefresh} from "./ownerShareLabels";
it("names a workspace, selected file, and Group from the owner's local state", async () => {
  const base = {rootPath: "C:\\work\\Trip", groupName: async () => "Travel group"};
  expect(await ownerShareLabels({...base, selector: {}})).toEqual({subjectName: "Trip"});
  expect((await ownerShareLabels({...base, selector: {paths: ["docs/plan.md"]}})).subjectName).toBe("plan.md");
  expect((await ownerShareLabels({...base, selector: {paths: ["apps/trip"]}, appName: async () => "Trip planner"})).subjectName).toBe("Trip planner");
  expect((await ownerShareLabels({...base, selector: {channelWireId: "wire", paths: ["folder"]}})).subjectName).toBe("Travel group");
});
it("refreshes legacy and renamed shares once, scoped to this workspace", async () => {
  const labels = {subjectName: "Trip"}, update = vi.fn();
  const row = {shareId: "s", workspaceId: "w", selector: {paths: []}};
  await refreshOwnerShareLabels({workspaceId: "w", list: async () => ({granted: [row, row, {...row, shareId: "other", workspaceId: "elsewhere"}, {...row, shareId: "current", ...labels}]}), labels: async () => labels, update});
  expect(update.mock.calls).toEqual([["s", labels]]);
});

it("never substitutes the owner's workspace for an unknown Group", async () => {
  const input = {rootPath: "C:/private-work", selector: {channelWireId: "unmapped"}, groupName: async () => null};
  expect((await ownerShareLabels(input)).subjectName).toBeNull();
  await expect(ownerShareLabels({...input, groupName: async () => {throw Error("offline");}})).rejects.toThrow("offline");
});
it("keeps cadence and in-flight state across engines for each workspace", async () => {
  let now = 1, finish!: () => void;
  const firstEngine = vi.fn(() => new Promise<void>(resolve => {finish = resolve;}));
  const nextEngine = vi.fn(async () => {}), failed = vi.fn();
  const schedule = createOwnerShareLabelRefresh(failed, () => now);
  expect(schedule("w", firstEngine)).toBeUndefined();
  schedule("w", nextEngine); expect(nextEngine).not.toHaveBeenCalled();
  now += 600_000; schedule("w", nextEngine); expect(nextEngine).not.toHaveBeenCalled();
  finish(); await firstEngine.mock.results[0]!.value; await Promise.resolve(); await Promise.resolve();
  schedule("w", nextEngine); expect(nextEngine).toHaveBeenCalledTimes(1);
  schedule("other", nextEngine); expect(nextEngine).toHaveBeenCalledTimes(2);
  expect(failed).not.toHaveBeenCalled();
});
it("does not overwrite saved labels after a lookup fails", async () => {
  const update = vi.fn();
  const input = {rootPath: "C:/Trip", selector: {channelWireId: "group"}, groupName: async () => {throw Error("offline");}};
  await expect(refreshOwnerShareLabels({workspaceId: "w", list: async () => ({granted: [{shareId: "s", workspaceId: "w", selector: input.selector, subjectName: "Travel"}]}), labels: () => ownerShareLabels(input), update})).rejects.toThrow("Some share labels could not be refreshed.");
  expect(update).not.toHaveBeenCalled();
  await expect(ownerShareLabels({...input, selector: {paths: ["apps/trip"]}, appName: async () => {throw Error("offline");}})).rejects.toThrow("offline");
});

it("skips revoked inventory rows but refreshes an active grant for the same share", async () => {
  const row = {shareId: "s", workspaceId: "w", selector: {paths: []}};
  const update = vi.fn(), labels = vi.fn(async () => ({subjectName: "Trip"}));
  await refreshOwnerShareLabels({workspaceId: "w", list: async () => ({granted: [{...row, revokedAtMs: 1}, {...row, shareId: "link", status: "revoked"}, row]}), labels, update});
  expect(update.mock.calls).toEqual([["s", {subjectName: "Trip"}]]);
  expect(labels).toHaveBeenCalledTimes(1);
});

it("continues after an update 404 or lookup failure, then reports the errors", async () => {
  const rows = ["missing", "lookup-fails", "current"].map(shareId => ({shareId, workspaceId: "w", selector: {paths: [shareId]}}));
  const update = vi.fn(async (shareId: string) => {if (shareId === "missing") throw Error("404");});
  const labels = vi.fn(async (selector: {paths?: unknown}) => {if ((selector.paths as string[])[0] === "lookup-fails") throw Error("offline"); return {subjectName: "Trip"};});
  await expect(refreshOwnerShareLabels({workspaceId: "w", list: async () => ({granted: rows}), labels, update})).rejects.toMatchObject({errors: [expect.objectContaining({message: "404"}), expect.objectContaining({message: "offline"})]});
  expect(update.mock.calls.map(call => call[0])).toEqual(["missing", "current"]);
});
