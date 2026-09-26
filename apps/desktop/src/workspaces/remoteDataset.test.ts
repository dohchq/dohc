import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { datasetColumnFields, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { createRemoteDatasetData, createDatasetAuthorityRouter, resolveRemoteDatasetRevision } from "./remoteDataset";
import type { OwnerDatasetData } from "./remoteDataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Responses", schemaPath: "private/schema.sql", operationsPath: "private/actions.js",
  tables: [{ tableId: id(2), name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
  ] }], operations: [{ operationId: id(4), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }] };
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "SQL", operationSource: "RULES" });
const approved = { revision, schemaSql: "SQL", operationSource: "RULES", active: true,
  cursor: { workspaceId: "workspace", datasetId: id(1), hostEpoch: "epoch", approvedRevisionHash: revision.revisionSha256, revision: 0, digest: "0".repeat(64) } };
const description = { datasetId: id(1), name: "Responses", revision: 1, revisionSha256: revision.revisionSha256,
  tables: definition.tables.map(table => ({ tableId: table.tableId, name: table.name, fields: datasetColumnFields(table).map(({ sqlColumn: _, ...field }) => field) })), operations: definition.operations };
const invocation = { datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationId: id(4), input: {}, idempotencyKey: "retry" };
function fixture() {
  const credentials = { serverUrl: "https://account.example", relayUrl: "https://relay.example", userId: "owner", token: "test-only", email: "owner@example.test" };
  const controller = new AbortController();
  let generation = 1, current = true;
  const relay = vi.fn(async (_auth: typeof credentials, path: string, _init: RequestInit): Promise<unknown> => {
    if (path.endsWith("/artifacts")) return structuredClone(approved);
    if (path.endsWith("/invoke")) return { result: [], revision: 3, replayed: false };
    if (path.endsWith(id(1))) return description;
    return { datasets: [description], nextCursor: null };
  });
  const data = createRemoteDatasetData({ workspaceId: "workspace", credentials, credentialGeneration: generation, signal: controller.signal,
    currentCredentialGeneration: () => generation, assertCurrent() { if (!current) throw Error("workspace changed"); }, relayJson: relay });
  return { data, relay, controller, switchCredential() { generation++; }, switchWorkspace() { current = false; } };
}

describe("remote Collection authority", () => {
  it("sends explicit cancellation and requires the dedicated acknowledgement", async () => {
    const f = fixture(), value = { datasetId: id(1), reference: "a".repeat(64), acknowledge: true as const };
    f.relay.mockResolvedValue({ cancelled: true });
    expect(await f.data.cancelAttempt!(value)).toEqual({ cancelled: true });
    expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/cancel-attempt`);
    expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({ reference: value.reference, acknowledge: true });
    f.relay.mockResolvedValue({ cleared: true }); await expect(f.data.cancelAttempt!(value)).rejects.toThrow();
  });
  it("sends captured migration bytes and approves the resulting candidate", async () => {
    const f = fixture();
    const next = describeDatasetRevision({ definition: { ...definition, name: "Renamed" }, revision: 2, schemaSql: "SQL", operationSource: "RULES" });
    const value = { workspaceId: "workspace", revision: next, schemaSql: "SQL", operationSource: "RULES", migrationSql: "SELECT 1;", expected: approved.cursor };
    const committed = { revision: next, cursor: { ...approved.cursor, approvedRevisionHash: next.revisionSha256, revision: 1, digest: "a".repeat(64) } };
    const candidate = { candidateId: id(9), expected: approved.cursor, approvedRevisionHash: next.revisionSha256, checkpointSha256: "f".repeat(64), expiresAtMs: Date.now() + 10000, preview: { tables: [], firstPage: { changes: [], nextCursor: null } } };
    f.relay.mockResolvedValue(candidate);
    expect(await f.data.prepareMigrationCandidate!(value)).toEqual(candidate);
    expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/prepare-migration`);
    expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({ revision: next, schemaSql: "SQL", operationSource: "RULES", migrationSql: "SELECT 1;", expected: approved.cursor });
    for (const patch of [{ hostEpoch: "other" }, { datasetId: id(9) }, { revision: 7 }, { approvedRevisionHash: next.revisionSha256 }]) {
      f.relay.mockResolvedValue({ ...candidate, expected: { ...candidate.expected, ...patch } });
      await expect(f.data.prepareMigrationCandidate!(value)).rejects.toThrow(/different Collection review/);
    }
    const approval = { workspaceId: "workspace", datasetId: id(1), candidateId: candidate.candidateId, checkpointSha256: candidate.checkpointSha256 };
    f.relay.mockResolvedValue(committed);
    expect(await f.data.approveMigrationCandidate!(approval)).toEqual(committed);
    expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/approve-migration`);
    for (const patch of [{ datasetId: id(9) }, { approvedRevisionHash: revision.revisionSha256 }]) {
      f.relay.mockResolvedValue({ ...committed, cursor: { ...committed.cursor, ...patch } });
      await expect(f.data.approveMigrationCandidate!(approval)).rejects.toThrow(/did not confirm/);
    }
  });

  it("pins explicit data grants and can remove a stored principal after its source share ends", async () => {
    const f = fixture(), grant = { revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(4)], discover: true };
    f.relay.mockResolvedValueOnce({ ok: true });
    await f.data.setGrant!({ action: "setGrant", workspaceId: "workspace", datasetId: id(1), grantId: "accepted-share", grant });
    expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/grants`);
    expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({ grantId: "accepted-share", grant });
    f.relay.mockResolvedValueOnce({ permissions: [{ kind: "data", principal: "stored-principal", current: false, metadata: grant }], nextCursor: null });
    expect((await f.data.permissions!({ action: "permissions", workspaceId: "workspace", datasetId: id(1) })).permissions[0]?.current).toBe(false);
    f.relay.mockResolvedValueOnce({ ok: true });
    await f.data.setGrant!({ action: "removeGrant", workspaceId: "workspace", datasetId: id(1), principalKey: "stored-principal" });
    expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({ principalKey: "stored-principal", grant: null });
  });
  it("validates scoped history pages and fails closed on another dataset or extra private fields", async () => {
    const f = fixture();
    const entry = { revision: 3, operation: "submit", callerReference: "a".repeat(64), recordedAtMs: 1, approvedRevisionHash: "b".repeat(64), changesetBytes: 10, attachmentCount: 0 };
    const page = { datasetId: id(1), headRevision: 3, entries: [entry], nextBeforeRevision: 3 };
    f.relay.mockResolvedValue(page);
    expect(await f.data.history({ datasetId: id(1), beforeRevision: 4, limit: 1 })).toEqual(page);
    expect(f.relay.mock.calls[0]![1]).toBe(`/sync/workspace/datasets/${id(1)}/history?beforeRevision=4&limit=1`);
    f.relay.mockResolvedValue({ ...page, datasetId: id(9) }); await expect(f.data.history({ datasetId: id(1) })).rejects.toThrow("invalid");
    f.relay.mockResolvedValue({ ...page, entries: [{ ...entry, idempotencyKey: "secret" }] }); await expect(f.data.history({ datasetId: id(1) })).rejects.toThrow();
    f.relay.mockResolvedValue(page); await expect(f.data.history({ datasetId: id(1), beforeRevision: 3 })).rejects.toThrow("invalid");
  });
  it("reads approved artifacts and invokes exactly the requested revision without local fallback", async () => {
    const f = fixture();
    expect(await f.data.list({ limit: 10 })).toEqual({ datasets: [description], nextCursor: null });
    expect(f.relay.mock.calls[0]![1]).toBe("/sync/workspace/datasets?limit=10");
    expect(await f.data.describe(id(1))).toEqual(description);
    expect(await resolveRemoteDatasetRevision(f.data, { kind: "dataset", ...invocation, operationIds: [id(4)] })).toEqual(revision);
    expect(await f.data.invoke(invocation)).toEqual({ result: [], revision: 3, replayed: false });
    expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({ revision: 1, revisionSha256: revision.revisionSha256, operationId: id(4), input: {}, idempotencyKey: "retry" });
  });
  it.each(["credential", "workspace", "abort"])('refuses a late response after %s changes', async kind => {
    const f = fixture();
    f.relay.mockImplementation(async () => {
      if (kind === "credential") f.switchCredential();
      if (kind === "workspace") f.switchWorkspace();
      if (kind === "abort") f.controller.abort();
      return { result: [], revision: 3, replayed: false };
    });
    await expect(f.data.invoke(invocation)).rejects.toThrow();
  });
  it.each(["dataset", "workspace", "hash", "source"])('refuses %s artifact mismatch', async kind => {
    const f = fixture(), forged = structuredClone(approved);
    if (kind === "dataset") forged.cursor.datasetId = id(9);
    if (kind === "workspace") forged.cursor.workspaceId = "different";
    if (kind === "hash") forged.cursor.approvedRevisionHash = "1".repeat(64);
    if (kind === "source") forged.operationSource = "NEW RULES";
    f.relay.mockResolvedValue(forged);
    await expect(f.data.approvedArtifacts(id(1))).rejects.toThrow();
  });
  it("rejects mismatched descriptions and nonadvancing catalog cursors", async () => {
    const f = fixture();
    f.relay.mockResolvedValue({ ...description, datasetId: id(9) });
    await expect(f.data.describe(id(1))).rejects.toThrow(/different/);
    f.relay.mockResolvedValue({ datasets: [description], nextCursor: id(9) });
    await expect(f.data.list({})).rejects.toThrow(/list changed/);
  });
  it("preserves offline failure and refuses an unapproved or changed remote revision", async () => {
    const f = fixture();
    f.relay.mockRejectedValueOnce(Error("offline"));
    await expect(f.data.invoke(invocation)).rejects.toThrow("offline");
    f.relay.mockResolvedValue({ ...approved, active: false });
    await expect(resolveRemoteDatasetRevision(f.data, { kind: "dataset", ...invocation, operationIds: [id(4)] })).rejects.toThrow(/rules changed/);
  });
  it("uploads and retrieves owner files through the same remote authority and verifies returned bytes", async () => {
    const f = fixture(), bytes = Buffer.from("receipt");
    const file = { fileId: "a".repeat(32), name: "receipt.png", contentType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    f.relay.mockResolvedValueOnce({ file, replayed: false });
    expect(await f.data.upload({ action: "upload", workspaceId: "workspace", ...invocation, fieldId: id(3), name: file.name, contentType: file.contentType, bytesBase64: bytes.toString("base64") })).toEqual({ file, replayed: false });
    expect(f.relay.mock.calls.at(-1)![1]).toMatch(/\/upload$/);
    f.relay.mockResolvedValueOnce({ file, bytesBase64: bytes.toString("base64") });
    expect(await f.data.file({ action: "file", workspaceId: "workspace", ...invocation, fileId: file.fileId })).toEqual({ file, bytesBase64: bytes.toString("base64") });
    f.relay.mockResolvedValueOnce({ file, bytesBase64: Buffer.from("wrong").toString("base64") });
    await expect(f.data.file({ action: "file", workspaceId: "workspace", ...invocation, fileId: file.fileId })).rejects.toThrow(/different Collection file/);
  });
});

it("checks the deletion review scope, token, acknowledgment and returned identity", async () => {
  const f = fixture(), preview = {cursor:approved.cursor, reviewToken:"c".repeat(64),name:"Responses",archived:false,generation:0,reason:"",apps:[],nextCursor:null,irreversible:true};
  f.relay.mockResolvedValue(preview);
  expect(await f.data.deletePreview!({datasetId:id(1),limit:1})).toEqual(preview);
  expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/delete-preview?limit=1`);
  f.relay.mockResolvedValue({...preview,cursor:{...approved.cursor,workspaceId:"other"}});
  await expect(f.data.deletePreview!({datasetId:id(1)})).rejects.toThrow();
  const value = {datasetId:id(1),expected:approved.cursor,reviewToken:preview.reviewToken,acknowledge:true as const};
  f.relay.mockResolvedValue({deleted:true,datasetId:id(1)});
  expect(await f.data.deleteDataset!(value)).toEqual({deleted:true,datasetId:id(1)});
  expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({expected:approved.cursor,reviewToken:preview.reviewToken,acknowledge:true});
  const calls = f.relay.mock.calls.length;
  await expect(f.data.deleteDataset!({...value,expected:{...approved.cursor,datasetId:id(9)}})).rejects.toThrow();
  await expect(f.data.deleteDataset!({...value,acknowledge:false as never})).rejects.toThrow();
  expect(f.relay).toHaveBeenCalledTimes(calls);
  f.relay.mockResolvedValue({deleted:true,datasetId:id(9)});
  await expect(f.data.deleteDataset!(value)).rejects.toThrow(/did not confirm/);
});
it("does not fall back to a transferred local dataset when deletion is unavailable remotely", async () => {
  const local = {deleteDataset:vi.fn(),deletePreview:vi.fn()} as unknown as OwnerDatasetData;
  const remote = {deleteDataset:vi.fn(async()=>{throw Error("offline");}),deletePreview:vi.fn(async()=>{throw Error("offline");})} as unknown as OwnerDatasetData;
  const data = createDatasetAuthorityRouter(local,{status:async()=>({state:"imported",receipt:{},targetOrigin:"https://relay"} as never),remote:async()=>remote});
  await expect(data.deletePreview!({datasetId:id(1)})).rejects.toThrow("offline");
  await expect(data.deleteDataset!({datasetId:id(1),expected:approved.cursor,reviewToken:"c".repeat(64),acknowledge:true})).rejects.toThrow("offline");
  expect(local.deletePreview).not.toHaveBeenCalled(); expect(local.deleteDataset).not.toHaveBeenCalled();
});
it.each(["credential","workspace","abort"])("discards a late deletion response after %s changes", async kind => {
  const f = fixture();
  f.relay.mockImplementation(async()=>{if(kind==="credential")f.switchCredential();if(kind==="workspace")f.switchWorkspace();if(kind==="abort")f.controller.abort();return {deleted:true,datasetId:id(1)};});
  await expect(f.data.deleteDataset!({datasetId:id(1),expected:approved.cursor,reviewToken:"c".repeat(64),acknowledge:true})).rejects.toThrow();
});

it("validates the private deletion status response", async () => {
  const f=fixture(); f.relay.mockResolvedValue({deleted:true});
  expect(await f.data.deletionStatus!({datasetId:id(1)})).toEqual({deleted:true});
  expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/deletion-status`);
  for(const value of [{deleted:"true"},{deleted:true,datasetId:id(1)},{}]) {
    f.relay.mockResolvedValue(value); await expect(f.data.deletionStatus!({datasetId:id(1)})).rejects.toThrow();
  }
});
it.each(["delete", "status"])("bounds %s confirmation by timeout even with an explicit workspace signal", async kind => {
  const f=fixture(), deadline=new AbortController();
  const timeout=vi.spyOn(AbortSignal,"timeout").mockReturnValue(deadline.signal);
  try {
    f.relay.mockImplementation(async(_credentials,_path,init)=>new Promise((_,reject)=>{
      expect(init.signal).not.toBe(f.controller.signal);
      init.signal!.addEventListener("abort",()=>reject(init.signal!.reason),{once:true});
    }));
    const pending=kind==="delete" ? f.data.deleteDataset!({datasetId:id(1),expected:approved.cursor,reviewToken:"c".repeat(64),acknowledge:true}) : f.data.deletionStatus!({datasetId:id(1)});
    expect(timeout).toHaveBeenCalledWith(15_000);
    const refused=expect(pending).rejects.toThrow("deadline");
    deadline.abort(Error("deadline"));await refused;
  }finally{timeout.mockRestore();}
});
it("omits only confirmed remote deletions from the transfer catalog and keeps failures visible", async () => {
  const local={list:vi.fn(async()=>({datasets:[description],nextCursor:null}))} as unknown as OwnerDatasetData;
  const remote={deletionStatus:vi.fn(async()=>({deleted:true})),describe:vi.fn(async()=>description)} as unknown as OwnerDatasetData;
  const data=createDatasetAuthorityRouter(local,{status:async()=>({state:"imported",receipt:{},targetOrigin:"https://relay"} as never),remote:async()=>remote});
  expect(await data.list({})).toEqual({datasets:[],nextCursor:null}); expect(remote.describe).not.toHaveBeenCalled();
  expect(await data.deletionStatus!({datasetId:id(1)})).toEqual({deleted:true});
  vi.mocked(remote.deletionStatus!).mockResolvedValue({deleted:false});
  expect(await data.list({})).toEqual({datasets:[description],nextCursor:null});
  vi.mocked(remote.deletionStatus!).mockRejectedValue(Error("offline"));
  await expect(data.list({})).rejects.toThrow("offline");
  vi.mocked(remote.deletionStatus!).mockResolvedValue({deleted:false}); vi.mocked(remote.describe).mockRejectedValue(Error("permission changed"));
  await expect(data.list({})).rejects.toThrow("permission changed");
});

it("verifies immutable history source against the requested revision and current credential", async () => {
  const f = fixture(), value = { datasetId: id(1), revisionSha256: revision.revisionSha256 };
  f.relay.mockResolvedValue({ revision, schemaSql: "SQL", operationSource: "RULES" });
  expect(await f.data.historyRevision!(value)).toEqual({ revision, schemaSql: "SQL", operationSource: "RULES" });
  expect(f.relay.mock.calls.at(-1)![1]).toBe(`/sync/workspace/datasets/${id(1)}/history-revision?revisionSha256=${revision.revisionSha256}`);
  await expect(f.data.historyRevision!({ ...value, revisionSha256: "f".repeat(64) })).rejects.toThrow("another Collection revision");
  f.relay.mockResolvedValue({ revision, schemaSql: "SQL", operationSource: "tampered" });
  await expect(f.data.historyRevision!(value)).rejects.toThrow();
  f.switchCredential(); await expect(f.data.historyRevision!(value)).rejects.toThrow();
});
