import { expect, it, vi } from "vitest";
import { createRemoteDatasetTransferTarget } from "./remoteDataset";
import type { DatasetRecoveryManifest } from "@dohc/app-backend-runtime/recovery";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sourceCursor = { workspaceId: "w", datasetId: id(1), hostEpoch: "local", approvedRevisionHash: "a".repeat(64), revision: 3, digest: "b".repeat(64) };
const receipt = { transferId: id(2), manifestSha256: "c".repeat(64), sourceCursor, targetCursor: { ...sourceCursor, hostEpoch: "remote", revision: 4, digest: "d".repeat(64) } };
function fixture() {
  const controller = new AbortController(); let generation = 1;
  const credentials = { serverUrl: "https://account", relayUrl: "https://relay", token: "token", userId: "owner", email: "owner@example.test" };
  const relay = vi.fn(async (_credentials: typeof credentials, _path: string, init: RequestInit): Promise<unknown> => {
    if (init.method === "GET") return null;
    const reader = (init.body as ReadableStream<Uint8Array>).getReader(), chunks = [];
    try { for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(...next.value); } } finally { reader.releaseLock(); }
    expect(chunks).toEqual([1, 2, 3]); return receipt;
  });
  const input = { workspaceId: "w", datasetId: id(1), origin: "https://relay", credentials, credentialGeneration: 1,
    currentCredentialGeneration: () => generation, signal: controller.signal, assertCurrent() {}, relayStream: relay };
  const target = createRemoteDatasetTransferTarget(input);
  let closed = false;
  async function* stream() { try { yield Uint8Array.of(1); yield Uint8Array.of(2, 3); } finally { closed = true; } }
  const transfer = { transferId: id(2), manifestSha256: receipt.manifestSha256, sourceCursor, manifest: {} as DatasetRecoveryManifest, stream: stream() };
  return { target, relay, input, transfer, controller, closed: () => closed, switchCredentials() { generation++; } };
}

it("streams a fenced archive to its pinned server and returns its durable receipt", async () => {
  const f = fixture();
  expect(await f.target.importRecovery(f.transfer)).toEqual(receipt);
  expect(f.closed()).toBe(true);
  expect(f.relay.mock.calls.map(call => call[2].method)).toEqual(["GET", "POST"]);
  expect(f.relay.mock.calls[1]![1]).toBe(`/sync/w/datasets/${id(1)}/imports/${id(2)}`);
  expect(f.relay.mock.calls[1]![2].headers).toMatchObject({ "content-type": "application/octet-stream", "x-dohc-dataset-manifest-sha256": receipt.manifestSha256 });
});
it("recovers a committed transfer after its response is lost, without replaying the archive", async () => {
  const f = fixture(); f.relay.mockResolvedValueOnce(null).mockRejectedValueOnce(Error("response lost")).mockResolvedValueOnce(receipt);
  expect(await f.target.importRecovery(f.transfer)).toEqual(receipt);
  expect(f.relay.mock.calls.map(call => call[2].method)).toEqual(["GET", "POST", "GET"]);
  f.relay.mockResolvedValueOnce(receipt);
  expect(await f.target.importRecovery(f.transfer)).toEqual(receipt);
  expect(f.relay.mock.calls.filter(call => call[2].method === "POST")).toHaveLength(1);
});
it("refuses a wrong server, another dataset receipt, and credentials changed in flight", async () => {
  const f = fixture();
  expect(() => createRemoteDatasetTransferTarget({ ...f.input, origin: "https://different" })).toThrow(/sharing server/);
  f.relay.mockResolvedValueOnce({ ...receipt, sourceCursor: { ...sourceCursor, datasetId: id(9) } });
  await expect(f.target.status(id(2))).rejects.toThrow(/another transfer/);
  f.relay.mockImplementationOnce(async () => { f.switchCredentials(); return receipt; });
  await expect(f.target.importRecovery(f.transfer)).rejects.toThrow(/session changed/);
});
