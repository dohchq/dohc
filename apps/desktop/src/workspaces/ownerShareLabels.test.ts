import {expect, it, vi} from "vitest";
import {ownerShareLabels, refreshOwnerShareLabels, createOwnerShareLabelRefresh} from "./ownerShareLabels";
it("names a workspace, selected file, and Group from the owner's local state", async () => {
  const base = {rootPath: "C:\\work\\Trip", sharerName: " Ana\n ", groupName: async () => "Travel group"};
  expect(await ownerShareLabels({...base, selector: {}})).toEqual({subjectName: "Trip", sharerName: "Ana"});
  expect((await ownerShareLabels({...base, selector: {paths: ["docs/plan.md"]}})).subjectName).toBe("plan.md");
  expect((await ownerShareLabels({...base, selector: {paths: ["apps/trip"]}, appName: async () => "Trip planner"})).subjectName).toBe("Trip planner");
  expect((await ownerShareLabels({...base, selector: {channelWireId: "wire", paths: ["folder"]}})).subjectName).toBe("Travel group");
});
it("refreshes legacy and renamed shares once, scoped to this workspace", async () => {
  const labels = {subjectName: "Trip", sharerName: "Ana"}, update = vi.fn();
  const row = {shareId: "s", workspaceId: "w", selector: {paths: []}};
  await refreshOwnerShareLabels({workspaceId: "w", list: async () => ({granted: [row, row, {...row, shareId: "other", workspaceId: "elsewhere"}, {...row, shareId: "current", ...labels}]}), labels: async () => labels, update});
  expect(update.mock.calls).toEqual([["s", labels]]);
});

it("never substitutes the owner's workspace for an unknown Group", async () => {
  const input = {rootPath: "C:/private-work", selector: {channelWireId: "unmapped"}, sharerName: "Ana", groupName: async () => null};
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
  const input = {rootPath: "C:/Trip", selector: {channelWireId: "group"}, sharerName: "Ana", groupName: async () => {throw Error("offline");}};
  await expect(refreshOwnerShareLabels({workspaceId: "w", list: async () => ({granted: [{shareId: "s", workspaceId: "w", selector: input.selector, subjectName: "Travel", sharerName: "Ana"}]}), labels: () => ownerShareLabels(input), update})).rejects.toThrow("offline");
  expect(update).not.toHaveBeenCalled();
  await expect(ownerShareLabels({...input, selector: {paths: ["apps/trip"]}, appName: async () => {throw Error("offline");}})).rejects.toThrow("offline");
});
