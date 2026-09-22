import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { JournalExportRecord } from "@dohc/app-backend-runtime/journal";
import { createRemoteDatasetReplicaSource, DatasetCopyOfflineError } from "./remoteDatasetReplica";

const datasetId = "00000000-0000-4000-8000-000000000001";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const head = { workspaceId: "w", datasetId, hostEpoch: "epoch", approvedRevisionHash: "a".repeat(64), revision: 0, digest: "" };
  const checkpoint: Extract<JournalExportRecord,{kind:"checkpoint"}> = { kind: "checkpoint", cursor: head, previous: null, source: "source", schemaSql: "schema", definitionJson: "{}", capacityBytes: 4096, byteLength: 100, sha256: "b".repeat(64) };
  head.digest = hash(JSON.stringify(["dohc-dataset-checkpoint-v1", "w", datasetId, "epoch", head.approvedRevisionHash, 0, null, checkpoint.sha256, hash("source"), hash("schema"), hash("{}"), 4096]));
  const controller = new AbortController(), credentials = { serverUrl: "https://account", relayUrl: "https://relay", token: "token", userId: "owner", email: "owner@example.test" };
  let generation = 1;
  const relayResponse = vi.fn(async (_credentials: typeof credentials, path: string, _init: RequestInit) => path.endsWith("/blob") ? new Response(new Uint8Array([1,2,3])) :
    Response.json(path.endsWith("/capture") ? { head, checkpoint } : { through: head, after: head, records: [] }));
  const onAccessLost = vi.fn();
  const options = { workspaceId: "w", datasetId, origin: "https://relay", credentials, relayResponse, onAccessLost, signal: controller.signal,
    credentialGeneration: 1, currentCredentialGeneration: () => generation, assertCurrent() {} };
  return { head, checkpoint, options, source: createRemoteDatasetReplicaSource(options), relayResponse, onAccessLost, controller, switchOwner: () => { generation++; } };
}
it("pins the owner and bounds pages and binary reads", async () => {
  const f = fixture(); expect(await f.source.capture()).toEqual({ head: f.head, checkpoint: f.checkpoint });
  await expect(f.source.page({ through: f.head, after: f.head, limit: 100 })).resolves.toEqual({ through: f.head, after: f.head, records: [] });
  expect(JSON.parse(f.relayResponse.mock.calls.at(-1)![2].body as string).limit).toBe(32);
  await expect(f.source.blob({ record: f.checkpoint, offset: 0, length: 3 })).resolves.toEqual(new Uint8Array([1,2,3]));
  expect(f.relayResponse.mock.calls.at(-1)![2]).toMatchObject({ headers: { authorization: "Bearer token" }, redirect: "error", cache: "no-store" });
});
it("reports definitive loss and only classifies network failures as offline", async () => {
  const f = fixture(); f.relayResponse.mockResolvedValueOnce(new Response(null,{status:404}));
  await expect(f.source.capture()).rejects.toThrow(/no longer available/); expect(f.onAccessLost).toHaveBeenCalledOnce();
  f.relayResponse.mockRejectedValueOnce(new TypeError("fetch failed")); await expect(f.source.capture()).rejects.toBeInstanceOf(DatasetCopyOfflineError);
  f.relayResponse.mockRejectedValueOnce(Error("authorization failed")); await expect(f.source.capture()).rejects.not.toBeInstanceOf(DatasetCopyOfflineError);
});
it("rejects cursor substitution and oversized bodies", async () => {
  const f = fixture(); f.relayResponse.mockResolvedValueOnce(Response.json({ through: {...f.head,revision:2}, after:f.head,records:[] }));
  await expect(f.source.page({ through:f.head,after:f.head,limit:2 })).rejects.toThrow(/another Collection history/);
  f.relayResponse.mockResolvedValueOnce(new Response("x".repeat(1024*1024+1))); await expect(f.source.capture()).rejects.toThrow(/exceeds limit/);
  f.relayResponse.mockResolvedValueOnce(new Response(new Uint8Array(4))); await expect(f.source.blob({ record:f.checkpoint,offset:0,length:3 })).rejects.toThrow(/exceeds its limit/);
});
it("checks ownership after response consumption and combines both abort signals", async () => {
  const f = fixture(); f.relayResponse.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    f.switchOwner(); controller.enqueue(new TextEncoder().encode(JSON.stringify({head:f.head,checkpoint:f.checkpoint}))); controller.close();
  } })));
  await expect(f.source.capture()).rejects.toThrow(/session changed/);
  const next = fixture(); next.controller.abort(); await expect(next.source.capture(new AbortController().signal)).rejects.toThrow(); expect(next.relayResponse).not.toHaveBeenCalled();
});
it("rejects another server before sending credentials", () => {
  const f = fixture(); expect(() => createRemoteDatasetReplicaSource({...f.options,origin:"https://other"})).toThrow(/Reconnect/); expect(f.relayResponse).not.toHaveBeenCalled();
});
