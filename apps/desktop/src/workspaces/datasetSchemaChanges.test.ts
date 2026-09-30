import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { datasetColumnFields, datasetRevisionsPreserveAccess, type DatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { generateDatasetSchemaChange } from "./datasetSchemaChanges";
import { generateDatasetSources } from "./datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createDatasetHandler } from "../ipc/datasetIpc";
import { datasetDefinitionFromDrafts } from "../renderer/collections/datasetDefinitionFromDrafts";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";

const compileFixture = createDatasetFixtureCompiler();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "People", schemaPath: "people/schema.sql", operationsPath: "people/operations.js",
  tables: [{ tableId: id(2), name: "People", sqlName: "people", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [
    { operationId: id(5), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "add", label: "Add", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(7), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "owner", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(8), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)] },
  ] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
async function fixture(initial: DatasetDefinition = definition, remote = false) {
  const root = await mkdtemp(join(tmpdir(), "dohc-schema-evolution-"));
  const host = await createLocalDatasetHost({ localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: root, capacityBytes: 1024 * 1024, compile: compileFixture });
  cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const files = new Map(Object.entries(generateDatasetSources(initial).files));
  const adapter = sourceCaptureAdapter(files);
  const first = await host.prepare({ descriptorPath: "people/dataset.json", adapter });
  const revision = await host.approve({ preparationId: first.preparationId, revisionSha256: first.revision.revisionSha256 });
  const workspace = { workspaceId: "w" };
  let signal = new AbortController().signal, scope = "window:1", credentialGeneration = 1;
  let alterSources: ((paths: string[]) => void) | undefined;
  const local = remote ? { approvedArtifacts() { throw new Error("Local store is fenced"); }, prepareMigrationCandidate() { throw new Error("Local store is fenced"); }, approveMigrationCandidate() { throw new Error("Local store is fenced"); } } as unknown as LocalDatasetHost : host;
  const handler = createDatasetHandler({ flushSourceCapture: async () => {}, withWorkspaceOperation: async (_caller, _id, work) => {
    let active = true;
    try { return await work({ workspace, signal, scope, assertCurrent() { if (!active) throw new Error("This workspace authority lease was released."); } }); }
    finally { active = false; }
  }, currentCredentialGeneration: () => credentialGeneration,
    hostForWorkspace: async () => local, ...(remote ? { dataForWorkspace: async () => ({ approvedArtifacts: async (datasetId: string) => host.approvedArtifacts(datasetId),
      prepareMigrationCandidate: host.prepareMigrationCandidate, approveMigrationCandidate: host.approveMigrationCandidate, discardMigrationCandidate: host.discardMigrationCandidate,
      migrationPreviewPage: host.migrationPreviewPage }) as unknown as import("./remoteDataset").OwnerDatasetData } : {}), withAdapter: async (_workspace, work) => work(adapter), createSources: async (_workspace, sources) => {
      for (const [path, source] of Object.entries(sources)) { if (files.has(path)) throw new Error("Existing source"); files.set(path, source); }
      alterSources?.(Object.keys(sources));
    } });
  async function prepare(change: DatasetSchemaChange, current = host.approvedArtifacts(id(1)).revision) {
    const result = await handler("owner", { action: "prepareSchemaChange", workspaceId: "w", datasetPath: "people/dataset.json", revision: current.revision, revisionSha256: current.revisionSha256, change });
    if (result.kind !== "migration-prepared") throw new Error("Expected a review"); return result;
  }
  return { host, files, adapter, revision, prepare, handler, tamper(fn: (paths: string[]) => void) { alterSources = fn; },
    changeCredentials() { credentialGeneration++; }, changeScope() { scope = "window:2"; }, changeLifetime() { signal = new AbortController().signal; } };
}
const call = (revision: DatasetRevision, operationId: string, input = {}, key = "read") => ({ datasetId: id(1), revision: revision.revision,
  revisionSha256: revision.revisionSha256, operationId, input, idempotencyKey: key });
const approve = async (setup: Awaited<ReturnType<typeof fixture>>, review: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["prepare"]>>) => {
  const result = await setup.handler("owner", { action: "approveMigration", workspaceId: "w", preparationId: review.preparationId,
    revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest });
  if (result.kind !== "migrated") throw new Error("Expected migration");
  return result;
};

it("keeps schema edits beside revisions at the workspace root", () => {
  const rootDefinition = { ...definition, schemaPath: "revisions/2-original/schema.sql", operationsPath: "revisions/2-original/operations.js" };
  const generated = generateDatasetSources(rootDefinition);
  const schemaSql = generated.files[rootDefinition.schemaPath]!, operationSource = generated.files[rootDefinition.operationsPath]!;
  const revision = describeDatasetRevision({ definition: rootDefinition, revision: 2, schemaSql, operationSource });
  const next = generateDatasetSchemaChange({ revision, schemaSql, operationSource, change: { kind: "renameCollection", name: "Guests" } });
  expect(next.definition.schemaPath).toMatch(/^revisions\/3-[^/]+\/schema\.sql$/);
});

it("adds a required defaulted field through captured approval and keeps row IDs, values and stable operation IDs", async () => {
  const f = await fixture();
  const added = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Camera" } }, "first"));
  const review = await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Status", type: "select", required: true, unique: false, options: ["New", "Done"], default: "New" } });
  expect(f.host.describe(id(1)).revision).toBe(1);
  const field = review.revision.definition.tables[0]!.fields.at(-1)!;
  expect(review.revision.definition.operations.find(op => op.operationId === id(8))!.fieldIds).toEqual([id(4)]);
  const next = await approve(f, review);
  const rows = (await f.host.query(call(next.revision, id(5)))).result as { rows: Array<{ id: string; version: number; values: Record<string, unknown> }> };
  expect(rows.rows[0]!.id).toBe((added.result as { id: string }).id);
  expect(rows.rows[0]!.values).toMatchObject({ [id(4)]: "Camera", [field.fieldId]: "New" });
  await f.host.action(call(next.revision, id(7), { id: rows.rows[0]!.id, expectedVersion: 1, values: { [field.fieldId]: "Done" } }, "edit"));
  expect(f.files.get("people/operations.js")).toBe(generateDatasetSources(definition).files[definition.operationsPath]);
  await expect(f.host.query(call(f.revision, id(5)))).rejects.toThrow("The Collection's rules changed. Its owner must approve this access again.");
});

it("adds a button through owner approval without SQL, operation changes, or new access", async () => {
  const f = await fixture();
  const created = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "first"));
  const review = await f.prepare({ kind: "addButton", tableId: id(2), name: "Send receipt" });
  expect(review.migrationSql).toBe("SELECT 1;");
  const next = await approve(f, review);
  const button = next.revision.definition.tables[0]!.fields.at(-1)!;
  expect(button).toEqual({ fieldId: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Send receipt", type: "button" });
  expect(next.revision.definition.operations).toEqual(f.revision.definition.operations);
  expect([next.revision.schemaSha256, next.revision.operationsSha256]).toEqual([f.revision.schemaSha256, f.revision.operationsSha256]);
  expect(datasetRevisionsPreserveAccess(f.revision, next.revision)).toBe(true);
  expect(f.host.describe(id(1)).tables[0]!.fields.at(-1)).toEqual(button);
  const rows = (await f.host.query(call(next.revision, id(5)))).result as { rows: Array<{ id: string; values: Record<string, unknown> }> };
  expect(rows.rows).toEqual([expect.objectContaining({ id: (created.result as { id: string }).id, values: { [id(3)]: (created.result as { id: string }).id, [id(4)]: "Ada" } })]);
  await expect(f.prepare({ kind: "changeField", tableId: id(2), fieldId: button.fieldId, type: "text", required: false })).rejects.toThrow("Send receipt is a button.");
  await expect(f.prepare({ kind: "addButton", tableId: id(2), name: "Name" })).rejects.toThrow();
  const renamed = await f.prepare({ kind: "renameField", tableId: id(2), fieldId: button.fieldId, name: "Email receipt" });
  expect(renamed.migrationSql).toBe("SELECT 1;");
  expect((await approve(f, renamed)).revision.definition.tables[0]!.fields.at(-1)).toEqual({ ...button, name: "Email receipt" });
  const added = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Email", type: "text", required: false, unique: false } }));
  const email = datasetColumnFields(added.revision.definition.tables[0]!).at(-1)!;
  expect(added.revision.definition.operations.find(operation => operation.operationId === id(5))!.fieldIds).toEqual([id(3), id(4), email.fieldId]);
  expect(added.revision.definition.tables[0]!.fields.map(field => field.name)).toEqual(["ID", "Name", "Email receipt", "Email"]);
});

it("refuses a button from a shared view before writing any source", async () => {
  const f = await fixture();
  const written: string[] = [];
  const shareView = { shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false,
    grantedSelector: { paths: ["people"], versionId: null, access: "edit" } };
  const recipient = createDatasetHandler({ flushSourceCapture: async () => {}, hostForWorkspace: async () => f.host,
    withWorkspaceOperation: async (_caller, _id, work) => work({ workspace: { workspaceId: "w", shareView }, signal: new AbortController().signal, assertCurrent() {} }),
    withAdapter: async (_workspace, work) => work(f.adapter),
    createSources: async (_workspace, sources) => { written.push(...Object.keys(sources)); } });
  await expect(recipient("editor", { action: "prepareSchemaChange", workspaceId: "w", datasetPath: "people/dataset.json", revision: f.revision.revision,
    revisionSha256: f.revision.revisionSha256, change: { kind: "addButton", tableId: id(2), name: "Send receipt" } })).rejects.toThrow("Open the original workspace to manage this Collection.");
  expect(written).toEqual([]);
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("keeps stable field/table IDs across consecutive add and label changes", async () => {
  const f = await fixture();
  await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "first"));
  const first = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Note", type: "text", required: false, unique: false } }));
  const second = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Amount", type: "number", required: false, unique: false, default: 3 } }));
  const noteId = first.revision.definition.tables[0]!.fields.at(-1)!.fieldId;
  const renamed = await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: noteId, name: "Notes" }));
  expect(renamed.revision.definition.tables[0]!.fields.find(f => f.fieldId === noteId)!.name).toBe("Notes");
  const renamedTable = await approve(f, await f.prepare({ kind: "renameTable", tableId: id(2), name: "Guests" }));
  expect(renamedTable.revision.definition.tables[0]!).toMatchObject({ tableId: id(2), sqlName: "people", name: "Guests" });
  expect(second.revision.definition.tables[0]!.fields.map(f => f.fieldId)).toEqual(renamedTable.revision.definition.tables[0]!.fields.map(f => f.fieldId));
  const result = (await f.host.query(call(renamedTable.revision, id(5)))).result as { rows: Array<{ values: Record<string, unknown> }> };
  expect(result.rows[0]!.values[id(4)]).toBe("Ada");
  expect(result.rows[0]!.values[noteId]).toBeNull();
});

it("adds a unique field as an index and rejects duplicate values through existing operations", async () => {
  const f = await fixture(), next = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Email", type: "text", required: false, unique: true } }));
  const field = next.revision.definition.tables[0]!.fields.at(-1)!;
  await f.host.action(call(next.revision, id(6), { values: { [id(4)]: "One", [field.fieldId]: "one@example.com" } }, "one"));
  await expect(f.host.action(call(next.revision, id(6), { values: { [id(4)]: "Two", [field.fieldId]: "one@example.com" } }, "two"))).rejects.toThrow(/already uses/);
});

it("refuses changed capture, stale revision and missing required defaults while preserving authored rules", async () => {
  const f = await fixture();
  await expect(f.prepare({ kind: "addField", tableId: id(2), field: { name: "Required", type: "text", required: true, unique: false } })).rejects.toThrow("needs a default");
  await expect(f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Person" }, { ...f.revision, revisionSha256: "0".repeat(64) })).rejects.toThrow("rules changed");
  const artifacts = f.host.approvedArtifacts(id(1));
  const customSource = artifacts.operationSource + "\n// custom";
  const renamed = generateDatasetSchemaChange({ ...artifacts, operationSource: customSource, change: { kind: "renameCollection", name: "Guests" } });
  expect(renamed.operationSource).toBe(customSource);
  expect(renamed.schemaSql).toBe(artifacts.schemaSql);
  const addition = generateDatasetSchemaChange({ ...artifacts, operationSource: customSource, change: { kind: "addField", tableId: id(2), field: {name:"Notes",type:"text",required:false,unique:false} } });
  expect(addition.operationSource).toBe(customSource);
  expect(addition.definition.operations).toEqual(artifacts.revision.definition.operations);
  expect(() => generateDatasetSchemaChange({ ...artifacts, operationSource: customSource, change: { kind: "changeField", tableId:id(2), fieldId:id(4), type:"number",required:true } })).toThrow(/custom rules.*people\/operations.js/);
  f.tamper(paths => { const migration = paths.find(path => path.endsWith("migration.sql"))!; f.files.set(migration, "DELETE FROM people;"); });
  await expect(f.prepare({ kind: "renameCollection", name: "Guests" })).rejects.toThrow("differs from this review");
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("updates the default no-agent Collection actions so new fields are visible and editable", async () => {
  const initial = datasetDefinitionFromDrafts({ datasetId:id(1),tableId:id(2),name:"People",schemaPath:"people/schema.sql",operationsPath:"people/operations.js",
    fields:[{name:"Name",type:"text",required:false,unique:false}] });
  const f=await fixture(initial), next=await approve(f,await f.prepare({kind:"addField",tableId:id(2),field:{name:"Note",type:"text",required:false,unique:false}}));
  const field=next.revision.definition.tables[0]!.fields.at(-1)!;
  expect(f.host.describe(id(1)).tables[0]!.fields.some(candidate=>candidate.fieldId===field.fieldId)).toBe(true);
  const create=next.revision.definition.operations.find(operation=>operation.kind==="create")!;
  const read=next.revision.definition.operations.find(operation=>operation.kind==="read")!;
  await f.host.action(call(next.revision,create.operationId,{values:{[field.fieldId]:"Visible"}},"native"));
  const result=(await f.host.query(call(next.revision,read.operationId))).result as {rows:Array<{values:Record<string,unknown>}>};
  expect(result.rows[0]!.values[field.fieldId]).toBe("Visible");
});

it("previews text to number changes and preserves record identities and later edits", async () => {
  const f = await fixture();
  const created = await f.host.action(call(f.revision,id(6),{values:{[id(4)]:"12.5"}},"first"));
  const review = await f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"number",required:true});
  expect(review.candidate.preview.firstPage.changes[0]).toMatchObject({kind:"update",before:{name:"12.5"},after:{name:12.5}});
  const next = await approve(f,review);
  const result = (await f.host.query(call(next.revision,id(5)))).result as {rows:Array<{id:string;version:number;values:Record<string,unknown>}>};
  expect(result.rows[0]).toMatchObject({id:(created.result as {id:string}).id,version:1,values:{[id(4)]:12.5}});
  await f.host.action(call(next.revision,id(7),{id:result.rows[0]!.id,expectedVersion:1,values:{[id(4)]:15}},"later"));
  const reverse = await approve(f,await f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"text",required:true}));
  const restored=(await f.host.query(call(reverse.revision,id(5)))).result as typeof result;
  expect(restored.rows[0]).toMatchObject({version:2,values:{[id(4)]:"15"}});
});

it("refuses invalid numeric values with the affected record ID and leaves live data intact", async () => {
  const f = await fixture();
  const created = await f.host.action(call(f.revision,id(6),{values:{[id(4)]:"pay later"}},"first"));
  await expect(f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"number",required:true})).rejects.toThrow(`Fix record ${(created.result as {id:string}).id}`);
  expect(f.host.describe(id(1)).revision).toBe(1);
  const result=(await f.host.query(call(f.revision,id(5)))).result as {rows:Array<{values:Record<string,unknown>}>};
  expect(result.rows[0]!.values[id(4)]).toBe("pay later");
});

it("refuses a required field change until missing values are filled", async () => {
  const optional=structuredClone(definition); datasetColumnFields(optional.tables[0]!)[1]!.required=false;
  const f = await fixture(optional);
  const created=await f.host.action(call(f.revision,id(6),{values:{}},"first"));
  await expect(f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"text",required:true})).rejects.toThrow(/Fix record/);
  await f.host.action(call(f.revision,id(7),{id:(created.result as {id:string}).id,expectedVersion:1,values:{[id(4)]:"Ada"}},"filled"));
  const next=await approve(f,await f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"text",required:true}));
  expect(datasetColumnFields(next.revision.definition.tables[0]!)[1]!.required).toBe(true);
});

it("allows generated field edits after a metadata rename without replacing custom SQL constraints", async () => {
  const f=await fixture();
  await approve(f,await f.prepare({kind:"renameField",tableId:id(2),fieldId:id(4),name:"Amount"}));
  await approve(f,await f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"number",required:true}));
  const artifacts=f.host.approvedArtifacts(id(1));
  expect(()=>generateDatasetSchemaChange({...artifacts,schemaSql:artifacts.schemaSql.replace('"name" REAL NOT NULL','"name" REAL NOT NULL CHECK ("name" > 0)'),
    change:{kind:"changeField",tableId:id(2),fieldId:id(4),type:"number",required:false}})).toThrow(/custom SQL constraints/);
});

it("changes fields added through ALTER ADD without losing earlier field values", async () => {
  const f=await fixture();
  const added=await approve(f,await f.prepare({kind:"addField",tableId:id(2),field:{name:"Amount",type:"text",required:false,unique:false}}));
  const field=added.revision.definition.tables[0]!.fields.at(-1)!;
  await f.host.action(call(added.revision,id(6),{values:{[id(4)]:"Ada",[field.fieldId]:"42"}},"added"));
  const next=await approve(f,await f.prepare({kind:"changeField",tableId:id(2),fieldId:field.fieldId,type:"number",required:false}));
  const result=(await f.host.query(call(next.revision,id(5)))).result as {rows:Array<{values:Record<string,unknown>}>};
  expect(result.rows[0]!.values).toMatchObject({[id(4)]:"Ada",[field.fieldId]:42});
});

it("preserves authored TypeScript actions and source extension when renaming fields", () => {
  const initial=generateDatasetSources(definition), custom=structuredClone(initial.definition);
  custom.operationsPath="people/operations.ts";
  custom.operations.push({operationId:id(20),name:"custom",label:"Confirm booking",tableId:id(2),kind:"action",access:"owner",readOnly:false,fieldIds:[id(4)]});
  const source="const amount: number = 1; globalThis.operations = { custom() { return amount; } };";
  const schemaSql=initial.files[custom.schemaPath]!;
  const revision=describeDatasetRevision({definition:custom,revision:1,schemaSql,operationSource:source});
  const changed=generateDatasetSchemaChange({revision,schemaSql,operationSource:source,change:{kind:"renameField",tableId:id(2),fieldId:id(4),name:"Full name"}});
  expect(changed.operationSource).toBe(source);
  expect(changed.definition.operationsPath).toMatch(/operations.ts$/);
  expect(changed.definition.operations).toEqual(custom.operations);
});

it("preserves convertible defaults and refuses incompatible defaults", async () => {
  const f=await fixture();
  const added=await approve(f,await f.prepare({kind:"addField",tableId:id(2),field:{name:"Amount",type:"text",required:false,unique:false,default:"5"}}));
  const field=added.revision.definition.tables[0]!.fields.at(-1)!;
  const next=await approve(f,await f.prepare({kind:"changeField",tableId:id(2),fieldId:field.fieldId,type:"number",required:false}));
  expect(datasetColumnFields(next.revision.definition.tables[0]!).at(-1)!.default).toBe(5);
  const artifacts=f.host.approvedArtifacts(id(1));
  const initial=generateDatasetSources(definition), bad=structuredClone(initial.definition);
  datasetColumnFields(bad.tables[0]!)[1]!.default="pay later";
  const generated=generateDatasetSources(bad), schemaSql=generated.files[bad.schemaPath]!,operationSource=generated.files[bad.operationsPath]!;
  const revision=describeDatasetRevision({definition:bad,revision:1,schemaSql,operationSource});
  expect(()=>generateDatasetSchemaChange({revision,schemaSql,operationSource,change:{kind:"changeField",tableId:id(2),fieldId:id(4),type:"number",required:true}})).toThrow(/without losing information/);
  expect(()=>generateDatasetSchemaChange({...artifacts,schemaSql:artifacts.schemaSql+"\nATTACH DATABASE ':memory:' AS other;",change:{kind:"changeField",tableId:id(2),fieldId:id(4),type:"text",required:false}})).toThrow(/custom SQL constraints/);
});

it.each(["9007199254740993","1e-999","0.10000000000000001"])("refuses a conversion that would lose numeric information: %s",async value=>{
  const f=await fixture();
  const created=await f.host.action(call(f.revision,id(6),{values:{[id(4)]:value}},"first"));
  await expect(f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"number",required:true})).rejects.toThrow(`Fix record ${(created.result as {id:string}).id}`);
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("keeps all significant numeric digits when converting a stored number to text",async()=>{
  const initial=structuredClone(definition); initial.tables[0]!.fields[1]!.type="number";
  const f=await fixture(initial), value=1.2345678901234567;
  await f.host.action(call(f.revision,id(6),{values:{[id(4)]:value}},"first"));
  const next=await approve(f,await f.prepare({kind:"changeField",tableId:id(2),fieldId:id(4),type:"text",required:true}));
  const result=(await f.host.query(call(next.revision,id(5)))).result as {rows:Array<{values:Record<string,unknown>}>};
  expect(result.rows[0]!.values[id(4)]).toBe("1.2345678901234567");
});

it("captures remote schema changes without opening the fenced local store and binds approval to the caller", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const input = { action: "approveMigration", workspaceId: "w", preparationId: review.preparationId, revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest };
  const page = { action: "migrationPreviewPage", workspaceId: "w", preparationId: review.preparationId, limit: 1 };
  await expect(f.handler("another owner session", page)).rejects.toThrow(/review expired/);
  expect(await f.handler("owner", page)).toMatchObject({ kind: "migration-preview-page", changes: [], nextCursor: null });
  await expect(f.handler("another owner session", input)).rejects.toThrow(/review expired/);
  const changed = await approve(f, review);
  expect(changed.revision.definition.name).toBe("Remote people");
  await expect(f.handler("owner", input)).rejects.toThrow(/review expired/);
});

it.each(["changeCredentials", "changeScope", "changeLifetime"] as const)("refuses a saved review after %s", async change => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  f[change]();
  await expect(approve(f, review)).rejects.toThrow(/review expired/);
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("retains captured review bytes after the preparation operation releases its lease", async () => {
  const f = await fixture();
  const review = await f.prepare({ kind: "renameCollection", name: "Reviewed people" });
  review.revision.definition.name = "Changed after review";
  const result = await approve(f, review);
  expect(result.revision.definition.name).toBe("Reviewed people");
});

it("consumes approval before an uncertain remote migration reply", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const migrate = vi.spyOn(f.host, "approveMigrationCandidate").mockRejectedValue(new Error("Remote reply lost"));
  await expect(approve(f, review)).rejects.toThrow("Remote reply lost");
  await expect(approve(f, review)).rejects.toThrow(/review expired/);
  expect(migrate).toHaveBeenCalledTimes(1);
});

it("refuses a credential change during approval before sending migration SQL", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const approvedArtifacts = f.host.approvedArtifacts;
  vi.spyOn(f.host, "approvedArtifacts").mockImplementationOnce(datasetId => {
    f.changeCredentials();
    return approvedArtifacts(datasetId);
  });
  const migrate = vi.spyOn(f.host, "approveMigrationCandidate");
  await expect(approve(f, review)).rejects.toThrow(/server session changed/);
  expect(migrate).not.toHaveBeenCalled();
});

it.each([false, true])("reviews public relation choices on the current authority before activating them (remote=%s)", async remote => {
  const initial = structuredClone(definition);
  initial.tables[0]!.fields.push({ fieldId: id(10), name: "Referral", sqlColumn: "referral", type: "relation", required: false, unique: false,
    relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } });
  const f = await fixture(initial, remote);
  const added = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "relation-choice-record"));
  const result = await f.handler("owner", { action: "prepareRelationChoices", workspaceId: "w", datasetPath: "people/dataset.json",
    revision: f.revision.revision, revisionSha256: f.revision.revisionSha256, tableId: id(2), fieldId: id(10), labelFieldId: id(4) });
  if (result.kind !== "migration-prepared") throw Error("Expected explicit choice review");
  const choice = result.revision.definition.operations.at(-1)!;
  expect(choice).toMatchObject({ access: "link", readOnly: true, fieldIds: [id(3), id(4)] });
  expect(f.host.approvedArtifacts(id(1)).revision.revisionSha256).toBe(f.revision.revisionSha256);
  expect(result.operationSource.startsWith(generateDatasetSources(initial).files[initial.operationsPath]!)).toBe(true);
  const next = await approve(f, result);
  const response = await f.host.query(call(next.revision, choice.operationId, { limit: 10 }, "relation-choice-read"));
  expect(response.result).toEqual({ rows: [{ id: (added.result as { id: string }).id,
    values: { [id(3)]: (added.result as { id: string }).id, [id(4)]: "Ada" } }], nextCursor: null });
  expect(next.revision.definition.operations.slice(0, f.revision.definition.operations.length)).toEqual(f.revision.definition.operations);
});

it("refuses stale relation exposure requests before writing source", async () => {
  const f = await fixture();
  const before = f.files.size;
  await expect(f.handler("owner", { action: "prepareRelationChoices", workspaceId: "w", datasetPath: "people/dataset.json", revision: 1,
    revisionSha256: "0".repeat(64), tableId: id(2), fieldId: id(4), labelFieldId: id(4) })).rejects.toThrow("Collection rules changed");
  expect(f.files.size).toBe(before);
});
