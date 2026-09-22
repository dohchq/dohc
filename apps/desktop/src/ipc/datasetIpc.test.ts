import { expect, it, vi } from "vitest";
import { createDatasetHandler } from "./datasetIpc";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { OwnerDatasetData } from "../workspaces/remoteDataset";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";

const datasetId = "00000000-0000-4000-8000-000000000001";
function fixture(remote?: OwnerDatasetData) {
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
  const host = { list: vi.fn(() => ({ datasets: [], nextCursor: null })), invoke: vi.fn(async () => ({ result: [], revision: 1, replayed: false })),
    approvedArtifacts: vi.fn(() => ({ active: true, revision })) };
  const createSources = vi.fn(async (_workspace: typeof workspace, _files: Record<string, string>, _signal: AbortSignal) => {});
  const handler = createDatasetHandler({
    async withWorkspaceOperation(_caller: string, workspaceId, work) {
      if (workspaceId !== workspace.workspaceId) throw Error("wrong workspace");
      return work({ workspace, signal: abort.signal, assertCurrent() { if (!current) throw Error("stale workspace"); } });
    },
    hostForWorkspace: vi.fn(async () => host as unknown as LocalDatasetHost),
    ...(remote ? { dataForWorkspace: async () => remote } : {}),
    withAdapter: vi.fn(), createSources,
  });
  const createForm = { action: "createForm", workspaceId: "workspace", datasetId, revision: 1, revisionSha256: revision.revisionSha256,
    tableId: definition.tables[0]!.tableId, createOperationId: definition.operations[0]!.operationId, appRoot: "apps/form", fieldIds: definition.operations[0]!.fieldIds };
  return { handler, host, workspace, abort, createSources, createForm, stale() { current = false; } };
}

it("uses owner authority before disclosing standalone Collections", async () => {
  const f = fixture();
  await expect(f.handler("window", { action: "list", workspaceId: "elsewhere" })).rejects.toThrow("wrong workspace");
  expect(f.host.list).not.toHaveBeenCalled();
  expect(await f.handler("window", { action: "list", workspaceId: "workspace" })).toEqual({ kind: "list", datasets: [], nextCursor: null });
});
it("routes owner reads and writes to shared authority without falling back locally", async () => {
  const remote = { list: vi.fn(async () => ({ datasets: [], nextCursor: null })), invoke: vi.fn(async () => { throw Error("shared server offline"); }) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { action: "list", workspaceId: "workspace" })).toMatchObject({ kind: "list" });
  expect(remote.list).toHaveBeenCalled();
  expect(f.host.list).not.toHaveBeenCalled();
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetId,
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" })).rejects.toThrow("shared server offline");
  expect(f.host.invoke).not.toHaveBeenCalled();
});
it("refuses stale workspace results after an asynchronous invocation", async () => {
  const f = fixture();
  f.host.invoke.mockImplementation(async () => { f.stale(); return { result: [], revision: 1, replayed: false }; });
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetId,
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" })).rejects.toThrow("stale workspace");
});
it("retains a remote operation refusal as a correction the owner can act on", async () => {
  const remote = { invoke: vi.fn(async () => { throw new AppBackendRuntimeError({ code: "capacity_full", message: "Choose another session." }); }) } as unknown as OwnerDatasetData;
  const f = fixture(remote);
  expect(await f.handler("window", { action: "invoke", workspaceId: "workspace", datasetId,
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" }))
    .toEqual({ kind: "refused", code: "capacity_full", message: "Choose another session." });
});
it("uses remote metadata and file operations after authority moves", async () => {
  const fieldId = "00000000-0000-4000-8000-000000000004";
  const remote = { describe: vi.fn(async () => ({ tables: [{ fields: [{ fieldId, type: "attachment" }] }], operations: [{ readOnly: false, fieldIds: [fieldId] }] })),
    upload: vi.fn(async () => ({ file: { fileId: "f".repeat(32) }, replayed: false })), file: vi.fn(async () => ({ file: { fileId: "f".repeat(32) }, bytesBase64: "cA==" })) } as unknown as OwnerDatasetData;
  const f = fixture(remote), pinned = { workspaceId: "workspace", datasetId, revision: 1, revisionSha256: "a".repeat(64) };
  expect(await f.handler("window", { ...pinned, action: "upload", fieldId, name: "receipt.png", contentType: "image/png", bytesBase64: "cA==", idempotencyKey: "upload" })).toMatchObject({ kind: "uploaded" });
  expect(remote.describe).toHaveBeenCalledWith(datasetId);
  expect(remote.upload).toHaveBeenCalled();
  expect(await f.handler("window", { ...pinned, action: "file", fileId: "f".repeat(32) })).toMatchObject({ kind: "file" });
  expect(remote.file).toHaveBeenCalled();
});
it("does not accept authority or raw SQL in an invocation", async () => {
  const f = fixture();
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetId,
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
  await expect(f.handler("window", f.createForm)).rejects.toThrow(/stale workspace/);
});
