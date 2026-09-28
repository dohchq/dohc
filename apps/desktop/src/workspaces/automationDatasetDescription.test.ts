import { expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { describeAutomationDataset } from "./automationDatasetDescription";

function fixture(shared = false) {
  const controller = new AbortController();
  const operation = { workspace: { workspaceId: "workspace", shareView: shared ? { shareId: "share" } : undefined },
    signal: controller.signal, assertCurrent: vi.fn() };
  const description = (datasetId: string): DatasetDescription => ({ datasetId, name: datasetId,
    revision: 1, revisionSha256: "a".repeat(64), tables: [], operations: [] });
  const owner = { describe: vi.fn(async (id: string) => description(id)) };
  const named = { describe: vi.fn(async (id: string) => description(id)) };
  const dependencies = { dataForWorkspace: vi.fn(async () => owner), namedDataForWorkspace: vi.fn(async () => named) };
  return { operation, controller, owner, named, dependencies };
}

it("describes both the pressed dataset and another Collection through the current authority", async () => {
  const f = fixture();
  for (const datasetId of ["pressed-dataset", "destination-dataset"]) {
    expect(await describeAutomationDataset(f.operation, datasetId, f.dependencies)).toMatchObject({ datasetId });
  }
  expect(f.owner.describe.mock.calls).toEqual([["pressed-dataset"], ["destination-dataset"]]);
  expect(f.dependencies.dataForWorkspace).toHaveBeenCalledWith(f.operation.workspace, f.operation.signal);
  expect(f.dependencies.namedDataForWorkspace).not.toHaveBeenCalled();
});

it("uses only recipient authority for a shared view and propagates its refusal", async () => {
  const f = fixture(true);
  f.named.describe.mockRejectedValue(new Error("No access to this Collection"));
  await expect(describeAutomationDataset(f.operation, "destination-dataset", f.dependencies)).rejects.toThrow("No access");
  expect(f.named.describe).toHaveBeenCalledWith("destination-dataset");
  expect(f.dependencies.dataForWorkspace).not.toHaveBeenCalled();
  expect(f.owner.describe).not.toHaveBeenCalled();
});

it("does not describe after authority acquisition loses the workspace", async () => {
  const f = fixture();
  f.dependencies.dataForWorkspace.mockImplementation(async () => {
    f.operation.assertCurrent.mockImplementation(() => { throw new Error("Workspace closed"); });
    return f.owner;
  });
  await expect(describeAutomationDataset(f.operation, "destination", f.dependencies)).rejects.toThrow("Workspace closed");
  expect(f.owner.describe).not.toHaveBeenCalled();
});

it("discards a description when the operation aborts while it is pending", async () => {
  const f = fixture();
  const described = await f.owner.describe("destination");
  f.owner.describe.mockImplementation(async () => { f.controller.abort(new Error("Workspace changed")); return described; });
  await expect(describeAutomationDataset(f.operation, "destination", f.dependencies)).rejects.toThrow("Workspace changed");
});
