import { expect, it, vi } from "vitest";
import { createDatasetAuthorityRouter, type OwnerDatasetData } from "./remoteDataset";
import type { DatasetTransferStatus } from "./localDatasetTransfer";

const localId = "00000000-0000-4000-8000-000000000001", remoteId = "00000000-0000-4000-8000-000000000002";
const marker = { workspaceId: "w", datasetId: remoteId, targetOrigin: "https://sharing.example", state: "imported", receipt: {} } as DatasetTransferStatus;
function fixture() {
  const local = { list: vi.fn(async () => ({ datasets: [{ datasetId: localId, name: "Local" }, { datasetId: remoteId, name: "Old local copy" }], nextCursor: null })),
    invoke: vi.fn(), describe: vi.fn(), approvedArtifacts: vi.fn(), upload: vi.fn(), file: vi.fn() } as unknown as OwnerDatasetData;
  const remote = { list: vi.fn(), invoke: vi.fn(async () => ({ result: "shared", revision: 5, replayed: false })), describe: vi.fn(async () => ({ datasetId: remoteId, name: "Shared" })),
    approvedArtifacts: vi.fn(), upload: vi.fn(), file: vi.fn() } as unknown as OwnerDatasetData;
  const status = vi.fn(async (datasetId: string) => datasetId === remoteId ? marker : null);
  const connect = vi.fn(async () => remote);
  return { local, remote, status, connect, data: createDatasetAuthorityRouter(local, { status, remote: connect }) };
}

it("uses one durable dataset route for discovery, owner operations, files and approved rules", async () => {
  const f = fixture();
  expect(await f.data.list({ limit: 10 })).toEqual({ datasets: [{ datasetId: localId, name: "Local" }, { datasetId: remoteId, name: "Shared" }], nextCursor: null });
  const input = { datasetId: remoteId, revision: 1, revisionSha256: "a".repeat(64), operationId: localId, input: {}, idempotencyKey: "retry" };
  expect(await f.data.invoke(input)).toMatchObject({ result: "shared" });
  expect(f.local.invoke).not.toHaveBeenCalled();
  await f.data.approvedArtifacts(remoteId);
  await f.data.upload({ ...input, action: "upload", workspaceId: "w", fieldId: localId, name: "receipt.png", contentType: "image/png", bytesBase64: "AA==" });
  await f.data.file({ ...input, action: "file", workspaceId: "w", fileId: "f".repeat(32) });
  expect(f.remote.approvedArtifacts).toHaveBeenCalledWith(remoteId);
  expect(f.remote.upload).toHaveBeenCalled(); expect(f.remote.file).toHaveBeenCalled();
  expect(f.connect).toHaveBeenCalledWith("https://sharing.example");
  await f.data.invoke({ ...input, datasetId: localId });
  expect(f.local.invoke).toHaveBeenCalled();
});

it("uses remote archive state and routes lifecycle changes without touching the fenced local host", async () => {
  const f = fixture();
  vi.mocked(f.remote.describe).mockResolvedValue({ datasetId: remoteId, name: "Shared", archived: true } as never);
  f.remote.archive = vi.fn(async () => ({ archived: true, generation: 1 }));
  f.remote.restore = vi.fn(async () => ({ archived: false, generation: 2 }));
  expect((await f.data.list({ limit: 10 })).datasets.map(row => row.datasetId)).toEqual([localId]);
  expect((await f.data.list({ includeArchived: true })).datasets).toMatchObject([{ datasetId: localId }, { datasetId: remoteId, archived: true }]);
  expect(f.remote.describe).toHaveBeenCalledWith(remoteId, { includeArchived: true });
  await f.data.archive!({ datasetId: remoteId }); await f.data.restore!({ datasetId: remoteId });
  expect(f.remote.archive).toHaveBeenCalledWith({ datasetId: remoteId }); expect(f.remote.restore).toHaveBeenCalledWith({ datasetId: remoteId });
});

it("refuses unconfirmed transfers without contacting either writable authority", async () => {
  const f = fixture(); f.status.mockResolvedValue({ ...marker, state: "ready", receipt: null });
  await expect(f.data.invoke({ datasetId: remoteId, revision: 1, revisionSha256: "a".repeat(64), operationId: localId, input: {}, idempotencyKey: "retry" })).rejects.toThrow(/transferring/);
  expect(f.local.invoke).not.toHaveBeenCalled(); expect(f.remote.invoke).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
});

it("does not read a stale local copy when shared authority is offline", async () => {
  const f = fixture(); vi.mocked(f.remote.describe).mockRejectedValue(Error("offline"));
  await expect(f.data.describe(remoteId)).rejects.toThrow("offline");
  await expect(f.data.list({})).rejects.toThrow("offline");
  expect(f.local.describe).not.toHaveBeenCalled();
});
