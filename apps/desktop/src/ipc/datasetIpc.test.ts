import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTestScratch } from "../workspaces/testTemp";
import { createDatasetSources, type SourceCreationProgress } from "../workspaces/datasetSourceCreation";
import { invalidateDatasetAddresses } from "../workspaces/datasetAddress";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { expect, it, vi } from "vitest";
import { createDatasetHandler } from "./datasetIpc";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { OwnerDatasetData } from "../workspaces/remoteDataset";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";

const datasetId = "00000000-0000-4000-8000-000000000001";
function fixture(remote?: OwnerDatasetData, named?: Pick<OwnerDatasetData, "list" | "describe" | "invoke" | "upload" | "file">,
  automationName?: (workspace: { workspaceId: string }, automationId: string) => Promise<string | null>) {
  const abort = new AbortController();
  const workspace = { workspaceId: "workspace", shareView: undefined as unknown };
  let current = true;
  const definition: DatasetDefinition = { formatVersion: 1, datasetId, name: "Responses", schemaPath: "data/schema.sql", operationsPath: "data/operations.js", tables: [
    { tableId: "00000000-0000-4000-8000-000000000002", name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
      { fieldId: "00000000-0000-4000-8000-000000000003", name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: "00000000-0000-4000-8000-000000000004", name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    ] }], operations: [{ operationId: "00000000-0000-4000-8000-000000000005", name: "submit", label: "Submit", tableId: "00000000-0000-4000-8000-000000000002",
      kind: "create", access: "link", readOnly: false, fieldIds: ["00000000-0000-4000-8000-000000000004"] }] };
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "SCHEMA", operationSource: "OPERATIONS" });
  const host = { prepareRecovery:vi.fn(async()=>({transferId:datasetId,manifestSha256:"a".repeat(64),sourceCursor:{workspaceId:"workspace",datasetId,hostEpoch:"epoch",approvedRevisionHash:revision.revisionSha256,revision:0,digest:"b".repeat(64)},revision})), claimRecovery:vi.fn(), discardRecovery:vi.fn(async()=>{}), list: vi.fn(() => ({ datasets: [], nextCursor: null })), invoke: vi.fn(async () => ({ result: [], revision: 1, replayed: false })),
    approvedArtifacts: vi.fn(() => ({ active: true, revision, schemaSql: "SCHEMA", operationSource: "OPERATIONS" })) };
  const createSources = vi.fn(async (_workspace: typeof workspace, files: Record<string, string>, _signal: AbortSignal, _progress?: SourceCreationProgress) => {
    for (const [path, source] of Object.entries(files)) sources.set(path, source);
    invalidateDatasetAddresses({ workspaceId: "workspace" });
  });
  const flushSourceCapture = vi.fn(async (_workspace: typeof workspace, _signal: AbortSignal) => {});
  const sources = new Map([["data/dataset.json", JSON.stringify(definition)]]);
  const adapter = sourceCaptureAdapter(sources, { workspaceId: "workspace" });
  const withAdapter = vi.fn(async (_workspace, work) => work(adapter));
  const handler = createDatasetHandler({ flushSourceCapture,
    async withWorkspaceOperation(_caller: string, workspaceId, work) {
      if (workspaceId !== workspace.workspaceId) throw Error("wrong workspace");
      const result = await work({ workspace, signal: abort.signal, assertCurrent() { if (!current) throw Error("stale workspace"); } });
      if (!current) throw Error("stale workspace");
      return result;
    },
    hostForWorkspace: vi.fn(async () => host as unknown as LocalDatasetHost),
    ...(remote ? { dataForWorkspace: async () => remote } : {}),
    ...(named ? { namedDataForWorkspace: async () => named } : {}),
    withAdapter, createSources, ...(automationName ? { automationName } : {}),
  });
  const createForm = { action: "createForm", workspaceId: "workspace", datasetPath: "data/dataset.json", revision: 1, revisionSha256: revision.revisionSha256,
    tableId: definition.tables[0]!.tableId, createOperationId: definition.operations[0]!.operationId, appRoot: "apps/form", fieldIds: definition.operations[0]!.fieldIds };
  return { revision, sources, handler, host, workspace, abort, createSources, createForm, flushSourceCapture, withAdapter, stale() { current = false; } };
}

it("uses owner authority before disclosing standalone Collections", async () => {
  const f = fixture();
  await expect(f.handler("window", { action: "list", workspaceId: "elsewhere" })).rejects.toThrow("wrong workspace");
  expect(f.host.list).not.toHaveBeenCalled();
  expect(await f.handler("window", { action: "list", workspaceId: "workspace" })).toEqual({ kind: "list", datasets: [], nextCursor: null });
});

it("resolves request paths through the engine and sends only the ID to the current host", async () => {
  const f = fixture();
  const request = { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json", operationId: datasetId,
    revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "by-path" };
  await f.handler("agent", request);
  expect(f.host.invoke).toHaveBeenCalledWith(expect.objectContaining({ datasetId, workspaceId: "workspace" }));
  expect(f.host.invoke).toHaveBeenCalledWith(expect.not.objectContaining({ datasetPath: request.datasetPath }));
  await expect(f.handler("agent", { ...request, datasetId })).rejects.toThrow();
  f.sources.set("moved/dataset.json", f.sources.get("data/dataset.json")!);
  f.sources.delete("data/dataset.json");
  invalidateDatasetAddresses({ workspaceId: "workspace" });
  await expect(f.handler("agent", request)).rejects.toThrow("Collection reference broken: data/dataset.json");
  expect(f.host.invoke).toHaveBeenCalledTimes(1);
  await f.handler("agent", { ...request, datasetPath: "moved/dataset.json" });
  expect(f.host.invoke).toHaveBeenCalledTimes(2);
});

it("does not treat a descriptor's ID as a grant", async () => {
  const remote = { invoke: vi.fn(async () => { throw Error("Dataset access denied"); }) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  await expect(f.handler("agent", { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json", operationId: datasetId,
    revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "denied" })).rejects.toThrow("Dataset access denied");
  expect(f.host.invoke).not.toHaveBeenCalled();
});

it("restores absent source files after recovery so the recovered dataset has an address", async () => {
  const f = fixture();
  f.sources.clear();
  f.sources.set("data/schema.sql", "keep existing source");
  const sourceCursor = { workspaceId: "workspace", datasetId, hostEpoch: "old", approvedRevisionHash: f.revision.revisionSha256, revision: 1, digest: "b".repeat(64) };
  f.host.claimRecovery.mockResolvedValue({ transferId: datasetId, manifestSha256: "a".repeat(64), sourceCursor, targetCursor: { ...sourceCursor, hostEpoch: "new" } });
  f.host.approvedArtifacts.mockResolvedValue({ active: true, revision: f.revision, schemaSql: "approved schema", operationSource: "approved operations" });
  const request = { action: "claimRecovery", workspaceId: "workspace", transferId: datasetId, manifestSha256: "a".repeat(64), sourceCursor, oldHostStopped: true };
  expect(await f.handler("window", request)).toMatchObject({ kind: "recovery-claimed", datasetPath: "data/dataset.json" });
  expect(f.sources.get("data/schema.sql")).toBe("keep existing source");
  expect(f.sources.get("data/operations.js")).toBe("approved operations");
  expect(JSON.parse(f.sources.get("data/dataset.json")!)).toEqual(f.revision.definition);
  await f.handler("window", request);
  expect(f.createSources).toHaveBeenCalledOnce();
  f.sources.clear();
  f.createSources.mockRejectedValue(new Error("Source folder is read-only"));
  expect(await f.handler("window", request)).toMatchObject({ kind: "recovery-claimed", datasetPath: null, sourceError: "Source folder is read-only" });
});

it("tells a recipient which source the owner must share", async () => {
  const f = fixture(); f.sources.clear(); f.workspace.shareView = { shareId: "shared" };
  f.flushSourceCapture.mockRejectedValue(new Error("Capture unavailable"));
  await expect(f.handler("window", { action: "describe", workspaceId: "workspace", datasetPath: "private/dataset.json" }))
    .rejects.toThrow("Ask the owner to include its dataset.json file in this share.");
  expect(f.flushSourceCapture).not.toHaveBeenCalled();
});

it("routes explicit cancellation to the current host and rejects stale completion", async () => {
  const remote = { cancelAttempt: vi.fn(async () => ({ cancelled: true })) } as unknown as OwnerDatasetData;
  const f = fixture(remote), request = { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "cancelAttempt", reference: "a".repeat(64), acknowledge: true };
  expect(await f.handler("window", request)).toEqual({ kind: "attempt-cancelled", cancelled: true });
  await expect(f.handler("window", { ...request, acknowledge: false })).rejects.toThrow();
  vi.mocked(remote.cancelAttempt!).mockImplementation(async () => { f.stale(); return { cancelled: true }; });
  await expect(f.handler("window", request)).rejects.toThrow("stale workspace");
});

it("routes lifecycle changes to current authority and refuses shared recipients", async () => {
  const remote = { archive: vi.fn(async () => ({ archived: true, generation: 1 })), restore: vi.fn(async () => ({ archived: false, generation: 2 })), lifecycle: vi.fn(async () => ({ archived: false, generation: 0, reason: "", apps: [], nextCursor: null })) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "archive" })).toMatchObject({ kind: "lifecycle-updated", archived: true });
  expect(remote.archive).toHaveBeenCalled();
  f.workspace.shareView = {};
  await expect(f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "restore" })).rejects.toThrow("original workspace");
  expect(remote.restore).not.toHaveBeenCalled();
});

it("routes pending submission review to current authority and rejects acknowledgement spoofing", async () => {
  const remote = { pendingAttempts: vi.fn(async () => ({ datasetId, entries: [], nextAfter: null })), reconcileAttempt: vi.fn(async () => ({ cleared: true })) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "pendingAttempts" })).toMatchObject({ kind: "pending-attempts" });
  await expect(f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "reconcileAttempt", reference: "a".repeat(64), acknowledge: false })).rejects.toThrow();
  expect(remote.reconcileAttempt).not.toHaveBeenCalled();
  await f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "reconcileAttempt", reference: "a".repeat(64), acknowledge: true });
  expect(remote.reconcileAttempt).toHaveBeenCalledOnce();
});
it("routes history to shared authority and rejects stale history replies", async () => {
  const page = { datasetId, headRevision: 0, entries: [], nextBeforeRevision: null };
  const remote = { history: vi.fn(async () => page) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "history", limit: 10 })).toEqual({ kind: "history", ...page });
  expect(remote.history).toHaveBeenCalledWith({ workspaceId: "workspace", datasetId, action: "history", limit: 10 });
  vi.mocked(remote.history).mockImplementation(async () => { f.stale(); return page; });
  await expect(f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "history" })).rejects.toThrow("stale workspace");
});
it("names each automation in History once, as its Collection's automations.yaml names it now", async () => {
  const entry = (revision: number, automationId?: string) => ({ revision, operation: "edit", callerReference: "a".repeat(64), recordedAtMs: 1000,
    approvedRevisionHash: "b".repeat(64), changesetBytes: 80, attachmentCount: 0, ...(automationId ? { automation: { automationId, depth: 1 } } : {}) });
  const page = { datasetId, headRevision: 3, nextBeforeRevision: null,
    entries: [entry(3, "collection:Budget#close-paid"), entry(2, "collection:Budget#gone"), entry(1, "collection:Budget#close-paid")] };
  const names = vi.fn(async (_workspace: { workspaceId: string }, automationId: string) => automationId.endsWith("close-paid") ? "Close paid invoices" : null);
  const f = fixture({ history: vi.fn(async () => page) } as unknown as OwnerDatasetData, undefined, names);
  expect(await f.handler("window", { workspaceId: "workspace", datasetPath: "data/dataset.json", action: "history" })).toEqual({ kind: "history", ...page, entries: [
    { ...page.entries[0], automation: { automationId: "collection:Budget#close-paid", depth: 1, name: "Close paid invoices" } },
    page.entries[1],
    { ...page.entries[2], automation: { automationId: "collection:Budget#close-paid", depth: 1, name: "Close paid invoices" } },
  ] });
  expect(names).toHaveBeenCalledTimes(2);
});
it("allows named Collection data actions without opening a local owner store or source controls", async () => {
  const named = { list: vi.fn(async () => ({ datasets: [], nextCursor: null })), describe: vi.fn(), invoke: vi.fn(), upload: vi.fn(), file: vi.fn() };
  const f = fixture(undefined, named); f.workspace.shareView = { shareId: "shared" };
  expect(await f.handler("window", { action: "list", workspaceId: "workspace" })).toMatchObject({ kind: "list" });
  expect(named.list).toHaveBeenCalled(); expect(f.host.list).not.toHaveBeenCalled();
  await expect(f.handler("window", f.createForm)).rejects.toThrow(/original workspace/);
  await expect(f.handler("window", { action: "prepare", workspaceId: "workspace", descriptorPath: "data/dataset.json" })).rejects.toThrow(/original workspace/);
  expect(f.host.approvedArtifacts).not.toHaveBeenCalled();
});
it("routes owner reads and writes to shared authority without falling back locally", async () => {
  const remote = { list: vi.fn(async () => ({ datasets: [], nextCursor: null })), invoke: vi.fn(async () => { throw Error("shared server offline"); }) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { action: "list", workspaceId: "workspace" })).toMatchObject({ kind: "list" });
  expect(remote.list).toHaveBeenCalled();
  expect(f.host.list).not.toHaveBeenCalled();
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json",
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" })).rejects.toThrow("shared server offline");
  expect(f.host.invoke).not.toHaveBeenCalled();
});
it("refuses stale workspace results after an asynchronous invocation", async () => {
  const f = fixture();
  f.host.invoke.mockImplementation(async () => { f.stale(); return { result: [], revision: 1, replayed: false }; });
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json",
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" })).rejects.toThrow("stale workspace");
});
it("retains a remote operation refusal as a correction the owner can act on", async () => {
  const remote = { invoke: vi.fn(async () => { throw new AppBackendRuntimeError({ code: "capacity_full", message: "Choose another session." }); }) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json",
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" }))
    .toEqual({ kind: "refused", code: "capacity_full", message: "Choose another session." });
});
it("uses remote metadata and file operations after authority moves", async () => {
  const fieldId = "00000000-0000-4000-8000-000000000004";
  const remote = { describe: vi.fn(async () => ({ tables: [{ fields: [{ fieldId, type: "attachment" }] }], operations: [{ readOnly: false, fieldIds: [fieldId] }] })),
    upload: vi.fn(async () => ({ file: { fileId: "f".repeat(32) }, replayed: false })), file: vi.fn(async () => ({ file: { fileId: "f".repeat(32) }, bytesBase64: "cA==" })) } as unknown as OwnerDatasetData;
  const f = fixture(remote), pinned = { workspaceId: "workspace", datasetPath: "data/dataset.json", revision: 1, revisionSha256: "a".repeat(64) };
  expect(await f.handler("window", { ...pinned, action: "upload", fieldId, name: "receipt.png", contentType: "image/png", bytesBase64: "cA==", idempotencyKey: "upload" })).toMatchObject({ kind: "uploaded" });
  expect(remote.describe).toHaveBeenCalledWith(datasetId);
  expect(remote.upload).toHaveBeenCalled();
  expect(await f.handler("window", { ...pinned, action: "file", fileId: "f".repeat(32) })).toMatchObject({ kind: "file" });
  expect(remote.file).toHaveBeenCalled();
});
it("carries the agent main derived into an owner CLI invocation, and nothing of it from the request", async () => {
  const f = fixture();
  const request = { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json",
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" };
  await f.handler("cli", request, { depth: 3 });
  expect(f.host.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: "retry", agent: { depth: 3 } }));
  // An agent outside a chain is still the agent.
  await f.handler("cli", request, { depth: 0 });
  expect(f.host.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { depth: 0 } }));
  // With no agent, the invocation is the owner's own.
  await f.handler("cli", request);
  expect(f.host.invoke).toHaveBeenLastCalledWith(expect.not.objectContaining({ agent: expect.anything() }));
  // A caller cannot name an agent or a depth itself.
  for (const forged of [{ agent: { depth: 0 } }, { agentDepth: 9 }]) await expect(f.handler("cli", { ...request, ...forged })).rejects.toThrow();
  expect(f.host.invoke).toHaveBeenCalledTimes(3);
});

it("does not accept authority or raw SQL in an invocation", async () => {
  const f = fixture();
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json",
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry", caller: { kind: "owner" } })).rejects.toThrow();
  expect(f.host.invoke).not.toHaveBeenCalled();
});

it("creates form source from host approval with a server-enforced create field subset", async () => {
  const f = fixture();
  const result = await f.handler("window", f.createForm);
  expect(result).toEqual({ kind: "form-created", appRoot: "apps/form", paths: ["apps/form/frontend.js", "apps/form/frontend.css", "apps/form/dohc.json", "apps/form/app.publish.json"] });
  const files = f.createSources.mock.calls[0]![1];
  expect(JSON.parse(files["apps/form/app.publish.json"]!).dataset.createFields).toEqual([{ operationId: f.createForm.createOperationId, fieldIds: f.createForm.fieldIds }]);
  expect(Object.values(files).join("\n")).not.toMatch(/SCHEMA|OPERATIONS/);
});
it("refuses stale form configuration before writing and guards a late source write", async () => {
  const f = fixture();
  await expect(f.handler("window", { ...f.createForm, revisionSha256: "0".repeat(64) })).rejects.toThrow(/rules changed/);
  expect(f.createSources).not.toHaveBeenCalled();
  f.createSources.mockImplementation(async () => { f.stale(); });
  await expect(f.handler("window", f.createForm)).resolves.toMatchObject({ kind: "partial", failedStage: "scope", retry: { mode: "resume" } });
});

it("reports scope when the workspace changes during the final form rules check", async () => {
  const f = fixture();
  const approved = f.host.approvedArtifacts();
  f.host.approvedArtifacts.mockReturnValueOnce(approved).mockImplementationOnce(() => { f.stale(); return approved; });
  await expect(f.handler("window", f.createForm)).resolves.toMatchObject({ kind: "partial", failedStage: "scope",
    reason: "stale workspace", retry: { mode: "resume" } });
});

it("keeps recovery owner-only and rejects mismatched approval scope",async()=>{
 const f=fixture();
 const prepared=await f.handler("window",{workspaceId:"workspace",action:"prepareRecovery",sourcePath:"C:/private/backup.dohc-recovery"});
 expect(prepared.kind).toBe("recovery-prepared");expect(f.host.prepareRecovery).toHaveBeenCalledOnce();
 if(prepared.kind!=="recovery-prepared"||!prepared.recovery)throw Error("missing preparation");
 const {revision:_,...claim}=prepared.recovery;
 await expect(f.handler("window",{workspaceId:"workspace",action:"claimRecovery",...claim,sourceCursor:{...claim.sourceCursor,workspaceId:"other"},oldHostStopped:true})).rejects.toThrow(/another Collection/);
 expect(f.host.claimRecovery).not.toHaveBeenCalled();
 f.workspace.shareView={shareId:"shared"};
 await expect(f.handler("window",{workspaceId:"workspace",action:"prepareRecovery",sourcePath:"C:/private/backup.dohc-recovery"})).rejects.toThrow(/original workspace/);
 expect(f.host.prepareRecovery).toHaveBeenCalledOnce();
});

it("routes deletion to current authority and rejects stale replies or another Collection cursor", async () => {
  const cursor = {workspaceId:"workspace",datasetId,hostEpoch:"epoch",approvedRevisionHash:"a".repeat(64),revision:0,digest:"b".repeat(64)};
  const preview = {cursor,reviewToken:"c".repeat(64),name:"Responses",archived:false,generation:0,reason:"",apps:[],nextCursor:null,irreversible:true};
  const remote = {deletePreview:vi.fn(async()=>preview),deleteDataset:vi.fn(async()=>({deleted:true,datasetId}))} as unknown as OwnerDatasetData;
  const f = fixture(remote), request = {action:"delete",workspaceId:"workspace",datasetPath: "data/dataset.json",expected:cursor,reviewToken:preview.reviewToken,acknowledge:true};
  expect(await f.handler("window",{action:"deletePreview",workspaceId:"workspace",datasetPath: "data/dataset.json"})).toEqual({kind:"delete-preview",...preview});
  await expect(f.handler("window",{...request,expected:{...cursor,workspaceId:"other"}})).rejects.toThrow(/another Collection/);
  expect(remote.deleteDataset).not.toHaveBeenCalled();
  expect(await f.handler("window",request)).toEqual({kind:"deleted",deleted:true,datasetId});
  vi.mocked(remote.deleteDataset!).mockImplementation(async()=>{f.stale();return {deleted:true,datasetId};});
  await expect(f.handler("window",request)).rejects.toThrow("stale workspace");
});
it("refuses shared-view deletion before reaching owner data", async () => {
  const remote = {deleteDataset:vi.fn(),deletePreview:vi.fn()} as unknown as OwnerDatasetData;
  const f = fixture(remote); f.workspace.shareView={shareId:"shared"};
  await expect(f.handler("window",{action:"deletePreview",workspaceId:"workspace",datasetPath: "data/dataset.json"})).rejects.toThrow(/original workspace/);
  expect(remote.deletePreview).not.toHaveBeenCalled();
});


it("waits for source capture before preparing authored Collection changes", async () => {
  for (const action of ["prepare", "prepareMigration"] as const) {
    const f = fixture();
    let finish!: () => void;
    f.flushSourceCapture.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    f.withAdapter.mockRejectedValue(new Error("source capture reached"));
    const request = action === "prepare" ? { workspaceId: "workspace", action, descriptorPath: "data/dataset.json" }
      : { workspaceId: "workspace", action, datasetPath: "data/dataset.json", migrationPath: "data/change.sql" };
    const pending = f.handler("window", request);
    const checked = expect(pending).rejects.toThrow("source capture reached");
    await vi.waitFor(() => expect(f.flushSourceCapture).toHaveBeenCalledOnce());
    expect(f.withAdapter).not.toHaveBeenCalled();
    finish();
    await checked;
    expect(f.withAdapter).toHaveBeenCalledOnce();
  }
});

it("refuses source review after failed settlement or changed workspace authority", async () => {
  const request = { workspaceId: "workspace", action: "prepareMigration", datasetPath: "data/dataset.json", migrationPath: "data/change.sql" };
  const failed = fixture();
  failed.flushSourceCapture.mockRejectedValue(new Error("capture not settled"));
  await expect(failed.handler("window", request)).rejects.toThrow("capture not settled");
  expect(failed.withAdapter).not.toHaveBeenCalled();
  const stale = fixture();
  stale.flushSourceCapture.mockImplementation(async () => { stale.stale(); });
  await expect(stale.handler("window", request)).rejects.toThrow("stale workspace");
  expect(stale.withAdapter).not.toHaveBeenCalled();
  const aborted = fixture();
  aborted.flushSourceCapture.mockImplementation(async () => { aborted.abort.abort(new Error("review cancelled")); });
  await expect(aborted.handler("window", request)).rejects.toThrow("review cancelled");
  expect(aborted.withAdapter).not.toHaveBeenCalled();
});

it.each(["write", "register", "capture", "verify", "revision"] as const)("returns the saved paths and safely retries a form after %s fails", async stage => {
  const f = fixture();
  const root = await createTestScratch("dohc-form-retry-");
  let fail = true;
  let expected: Record<string, string> = {};
  f.createSources.mockImplementation(async (_workspace, files, signal, progress) => {
    expected = files;
    await createDatasetSources(root, files, signal, {
      register: async () => { if (fail && stage === "register") throw Error("register failed"); },
      capture: async () => { if (fail && stage === "capture") throw Error("capture failed"); },
      verify: async () => { if (fail && stage === "verify") throw Error("verify failed"); },
    }, (at, paths) => {
      progress?.(at, paths);
      if (fail && stage === "write" && paths.length === 1) throw Error("write failed");
    });
  });
  const approved = f.host.approvedArtifacts();
  f.host.approvedArtifacts.mockImplementation(() => {
    if (fail && stage === "revision" && f.createSources.mock.calls.length) throw Error("authority unavailable");
    return approved;
  });
  const partial = await f.handler("window", f.createForm);
  expect(partial).toMatchObject({ kind: "partial", failedStage: stage, retry: { mode: "resume" } });
  if (partial.kind !== "partial") throw Error("expected partial");
  expect(partial.created).toEqual(Object.keys(expected).slice(0, stage === "write" ? 1 : 4));
  fail = false;
  await expect(f.handler("window", f.createForm)).resolves.toMatchObject({ kind: "form-created" });
  await expect(f.handler("window", f.createForm)).resolves.toMatchObject({ kind: "form-created" });
  expect((await readdir(join(root, "apps/form"))).sort()).toEqual(["app.publish.json", "dohc.json", "frontend.css", "frontend.js"]);
  for (const [path, source] of Object.entries(expected)) expect(await readFile(join(root, path), "utf8")).toBe(source);
});

it("names saved files when rules change and supports remove-and-retry", async () => {
  const f = fixture();
  const root = await createTestScratch("dohc-form-rules-");
  const approved = f.host.approvedArtifacts();
  f.host.approvedArtifacts.mockReturnValueOnce(approved).mockReturnValueOnce({ ...approved, active: false });
  f.createSources.mockImplementation(async (_workspace, files, signal, progress) =>
    createDatasetSources(root, files, signal, { register: async () => {}, capture: async () => {}, verify: async () => {} }, progress));
  const partial = await f.handler("window", f.createForm);
  expect(partial).toMatchObject({ kind: "partial", failedStage: "revision", retry: { mode: "remove-and-retry" } });
  if (partial.kind !== "partial") throw Error("expected partial");
  for (const path of partial.created) await unlink(join(root, path));
  await expect(f.handler("window", f.createForm)).resolves.toMatchObject({ kind: "form-created" });
  expect(await readdir(join(root, "apps/form"))).toHaveLength(4);
});

it.each([
  { action: "describe" }, { action: "permissions" }, { action: "lifecycle" }, { action: "history" },
  { action: "archive" }, { action: "restore" }, { action: "export" }, { action: "deletePreview" },
  { action: "removeGrant", principalKey: "person" },
  { action: "setGrant", grantId: "grant", grant: { revision: 1, revisionSha256: "a".repeat(64), operationIds: [datasetId], discover: true } },
  { action: "pendingAttempts" }, { action: "prepareMigration", migrationPath: "data/change.sql" },
  { action: "invoke", operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "pinned" },
])("refuses $action when a selected path now names another Collection", async action => {
  const f = fixture();
  await f.handler("window", { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json", operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "before" });
  f.sources.set("data/dataset.json", JSON.stringify({ datasetId: "00000000-0000-4000-8000-000000000099" }));
  invalidateDatasetAddresses({ workspaceId: "workspace" });
  await expect(f.handler("window", { ...action, workspaceId: "workspace", datasetPath: "data/dataset.json", expectedDatasetId: datasetId })).rejects.toThrow("This Collection moved. Reopen it.");
  expect(f.host.invoke).toHaveBeenCalledTimes(1);
});

it("flushes and retries a missing address once after an agent moves its folder", async () => {
  const f = fixture();
  const request = { action: "invoke", workspaceId: "workspace", datasetPath: "data/dataset.json", operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "move" };
  await f.handler("agent", request);
  f.flushSourceCapture.mockImplementationOnce(async () => {
    f.sources.set("moved/dataset.json", f.sources.get("data/dataset.json")!);
    f.sources.delete("data/dataset.json");
  });
  await f.handler("agent", { ...request, datasetPath: "moved/dataset.json" });
  expect(f.flushSourceCapture).toHaveBeenCalledTimes(1);
  expect(f.host.invoke).toHaveBeenCalledTimes(2);
  await expect(f.handler("agent", { ...request, datasetPath: "absent/dataset.json" })).rejects.toThrow("Collection reference broken");
  expect(f.flushSourceCapture).toHaveBeenCalledTimes(2);
});
