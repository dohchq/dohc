import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";
import { DatasetRequest, DatasetResult } from "./dataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const definition = {formatVersion:1,datasetId:id(1),name:"Equipment",schemaPath:"equipment/schema.sql",operationsPath:"equipment/actions.ts",
  tables:[{tableId:id(2),name:"Equipment",sqlName:"equipment",primaryKey:"id",fields:[{fieldId:id(3),name:"ID",sqlColumn:"id",type:"text",required:true,unique:true}]}],
  operations:[{operationId:id(4),name:"list",label:"List equipment",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3)]}]};
const cursor = {workspaceId:"workspace",datasetId:id(1),hostEpoch:"epoch",approvedRevisionHash:"a".repeat(64),revision:0,digest:"b".repeat(64)};
const requests: unknown[] = [
  {action:"deletePreview",workspaceId:"workspace",datasetPath:"equipment/dataset.json",limit:10},
  {action:"delete",workspaceId:"workspace",datasetPath:"equipment/dataset.json",expected:cursor,reviewToken:"c".repeat(64),acknowledge:true},
  {action:"cancelAttempt",workspaceId:"workspace",datasetPath:"equipment/dataset.json",reference:"b".repeat(64),acknowledge:true},
  {action:"pendingAttempts",workspaceId:"workspace",datasetPath:"equipment/dataset.json",after:0,limit:10},
  {action:"reconcileAttempt",workspaceId:"workspace",datasetPath:"equipment/dataset.json",reference:"b".repeat(64),acknowledge:true},
  {action:"archive",workspaceId:"workspace",datasetPath:"equipment/dataset.json"},
  {action:"restore",workspaceId:"workspace",datasetPath:"equipment/dataset.json"},
  {action:"lifecycle",workspaceId:"workspace",datasetPath:"equipment/dataset.json",limit:50},
  {action:"list",workspaceId:"workspace",includeArchived:true},
  {action:"list",workspaceId:"workspace"},
  {action:"describe",workspaceId:"workspace",datasetPath:"equipment/dataset.json"},
  {action:"export",workspaceId:"workspace",datasetPath:"equipment/dataset.json",savePath:"C:/private/fundraiser.dohc-recovery"},
  {action:"create",workspaceId:"workspace",definition},
  {action:"prepare",workspaceId:"workspace",descriptorPath:"equipment/dataset.json"},
  {action:"approve",workspaceId:"workspace",preparationId:id(5),revisionSha256:"a".repeat(64)},
  {action:"discard",workspaceId:"workspace",preparationId:id(5)},
  {action:"invoke",workspaceId:"workspace",datasetPath:"equipment/dataset.json",operationId:id(4),revision:1,revisionSha256:"a".repeat(64),input:{limit:10},idempotencyKey:"read-1"},
];
describe("dataset CLI", () => {
  it("accepts caller-relative result addresses without accepting request traversal", () => {
    const dataset = { datasetId: id(1), name: "Equipment", revision: 1, revisionSha256: "a".repeat(64), tables: [], operations: [], datasetPath: "../equipment/dataset.json" };
    expect(DatasetResult.parse({ kind: "description", dataset })).toEqual({ kind: "description", dataset });
    const refused = DatasetRequest.safeParse({ action: "describe", workspaceId: "workspace", datasetPath: dataset.datasetPath });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("This Collection sits outside the MCP folder. Run the MCP server from the workspace root or a folder containing the Collection.");
    expect(DatasetResult.safeParse({ kind: "description", dataset: { ...dataset, datasetPath: "../equipment/../dataset.json" } }).success).toBe(false);
    const revision = { datasetId: id(1), revision: 1, revisionSha256: "d".repeat(64), definition: { ...definition, schemaPath: "../equipment/schema.sql", operationsPath: "../equipment/actions.ts" }, definitionSha256: "a".repeat(64), schemaSha256: "b".repeat(64), operationsSha256: "c".repeat(64) };
    expect(DatasetResult.parse({ kind: "approved", revision })).toEqual({ kind: "approved", revision });
  });
  it.each([false, true])("exits nonzero and preserves partial form facts (JSON: %s)", async json => {
    const partial = { kind: "partial", created: ["form/frontend.js"], failedStage: "capture", reason: "capture failed",
      retry: { mode: "resume", instruction: "Try again with the same form settings and folder." } };
    const fields = { workspaceId: "workspace", datasetPath: "equipment/dataset.json", revision: 1, revisionSha256: "a".repeat(64),
      tableId: id(2), createOperationId: id(4), appRoot: "form", fieldIds: [id(3)] };
    const result = await executeCli({ argv: ["dataset", "createForm", JSON.stringify(fields), ...(json ? ["--json"] : [])],
      env: {}, request: async () => partial });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject(partial);
  });
  it("requires a dataset.json address instead of an ID or folder", async () => {
    const send = vi.fn();
    for (const selection of [{ datasetId: id(1) }, { datasetPath: id(1) }, { datasetPath: "equipment" }, { datasetPath: "../equipment/dataset.json" }]) {
      const result = await executeCli({ argv: ["dataset", "describe", JSON.stringify({ workspaceId: "workspace", ...selection })], request: send });
      expect(result.exitCode).toBe(1);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("uses the dataset field envelope for forms and parses explicit relation preparation", () => {
    const form = { action: "createForm", workspaceId: "workspace", datasetPath: "equipment/dataset.json", revision: 1, revisionSha256: "a".repeat(64),
      tableId: id(2), createOperationId: id(4), appRoot: "form", fieldIds: Array.from({ length: 128 }, (_, index) => id(index + 10)),
      relationChoices: [{ fieldId: id(10), operationId: id(5), labelFieldId: id(3) }] };
    expect(DatasetRequest.parse(form)).toEqual(form);
    expect(() => DatasetRequest.parse({ ...form, fieldIds: [...form.fieldIds, id(999)] })).toThrow();
    const prepare = { action: "prepareRelationChoices", workspaceId: "workspace", datasetPath: "equipment/dataset.json", revision: 1, revisionSha256: "a".repeat(64), tableId: id(2), fieldId: id(3), labelFieldId: id(4) };
    expect(DatasetRequest.parse(prepare)).toEqual(prepare);
    expect(() => DatasetRequest.parse({ ...prepare, access: "owner" })).toThrow();
  });
  it("prepares a button as a name on a table, with no column, type or operation", () => {
    const request = { action: "prepareSchemaChange", workspaceId: "workspace", datasetPath: "equipment/dataset.json", revision: 1, revisionSha256: "a".repeat(64),
      change: { kind: "addButton", tableId: id(2), name: "Send receipt" } };
    expect(DatasetRequest.parse(request)).toEqual(request);
    for (const extra of [{ sqlColumn: "send_receipt" }, { type: "button" }, { fieldIds: [id(3)] }, { operationId: id(4) }]) {
      expect(() => DatasetRequest.parse({ ...request, change: { ...request.change, ...extra } })).toThrow();
    }
    expect(() => DatasetRequest.parse({ ...request, change: { ...request.change, name: " " } })).toThrow();
  });
  it.each(["describe", "invoke", "helper", "export", "restore"])("rejects the retired private app %s command before transport", async action => {
    const send = vi.fn();
    const result = await executeCli({ argv: ["app", action, JSON.stringify({ workspaceId: "workspace", publicationId: "a".repeat(64) })], request: send });
    expect(result.exitCode).toBe(1); expect(send).not.toHaveBeenCalled();
    expect(() => cliRequestSchema.parse({ token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: "appBackend", args: { cwd: "/workspace", actor: "agent", request: { action, workspaceId: "workspace", publicationId: "a".repeat(64) } } })).toThrow();
  });
  it.each(requests)("routes the supported request unchanged: $action", async raw => {
    const request = raw as DatasetRequest;
    const {action,...fields} = request;
    expect(parseCliArguments(["--as-agent","dataset",action,JSON.stringify(fields)],{})).toMatchObject({actor:"agent",verb:"dataset",request});
    const wire = {token:"a".repeat(64),protocolVersion:CLI_PROTOCOL_VERSION,verb:"dataset",args:{cwd:"/workspace",actor:"agent",request}};
    expect(cliRequestSchema.parse(wire)).toEqual(wire);
  });
  it("invokes the same operation identity and retry key, preserving structured output", async () => {
    const request = requests.at(-1) as DatasetRequest;
    const result = {kind:"invoked",result:{records:[{id:"one"}]},revision:2,replayed:true};
    const send = vi.fn(async () => result);
    const executed = await executeCli({argv:["--as-agent","dataset","invoke",JSON.stringify(request),"--json"],request:send,env:{}});
    expect(executed.exitCode).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual({schemaVersion:2,...result});
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({verb:"dataset",args:expect.objectContaining({actor:"agent",request})}));
    expect(parseCliResult("dataset",result)).toEqual(result);
  });
  it("refuses direct SQL, caller authority, wrong revisions and unsupported actions before transport", async () => {
    const valid = requests.at(-1) as Record<string,unknown>;
    const send = vi.fn();
    for (const request of [{...valid,sql:"DROP TABLE equipment"},{...valid,caller:{kind:"owner"}},{...valid,revision:0},{...valid,input:undefined},{...valid,action:"sql"}]) {
      const result = await executeCli({argv:["dataset","invoke",JSON.stringify(request)],request:send,env:{}});
      expect(result.exitCode).toBe(1);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("explains creation and approval without requiring a running desktop", async () => {
    const send = vi.fn();
    const help = async (...argv: string[]) => {
      const result = await executeCli({argv:["dataset",...argv,"--help"],request:send});
      expect(result.exitCode).toBe(0);
      return result.stdout.replace(/\s+/g," ");
    };
    expect(await help()).toContain("create Write source for a new Collection, ready to approve.");
    expect(await help("create")).toContain("Fields: workspaceId, definition");
    expect(await help("approve")).toContain("Fields: workspaceId, preparationId, revisionSha256");
    expect(await help("invoke")).toContain("same input and idempotencyKey");
    expect(await help("export")).toContain("Fields: workspaceId, datasetPath, savePath Optional fields: expectedDatasetId, overwrite");
    expect(send).not.toHaveBeenCalled();
  });
  it("requires a chosen export destination and returns no private archive bytes", async () => {
    const send = vi.fn(async () => ({kind:"exported",savedPath:"C:/private/backup.dohc-recovery"}));
    const missing = await executeCli({argv:["dataset","export",JSON.stringify({workspaceId:"workspace",datasetPath:"equipment/dataset.json"})],request:send});
    expect(missing.exitCode).toBe(1); expect(send).not.toHaveBeenCalled();
    const saved = await executeCli({argv:["dataset","export",JSON.stringify({workspaceId:"workspace",datasetPath:"equipment/dataset.json",savePath:"C:/private/backup.dohc-recovery"})],request:send});
    expect(saved.exitCode).toBe(0); expect(saved.stdout).toContain("savedPath");
  });
});

it("requires an exact deletion review and explicit acknowledgment before transport", async () => {
  const request = {workspaceId:"workspace",datasetPath:"equipment/dataset.json",expected:cursor,reviewToken:"c".repeat(64),acknowledge:true};
  const send = vi.fn(async () => ({kind:"deleted",deleted:true,datasetId:id(1)}));
  for (const invalid of [{...request,acknowledge:false},{...request,acknowledge:undefined},{...request,expected:undefined},
    {...request,expected:{...cursor,digest:"invalid"}},{...request,reviewToken:undefined},{...request,force:true}]) {
    expect((await executeCli({argv:["dataset","delete",JSON.stringify(invalid)],request:send})).exitCode).toBe(1);
  }
  expect(send).not.toHaveBeenCalled();
  expect((await executeCli({argv:["dataset","delete",JSON.stringify(request)],request:send})).exitCode).toBe(0);
  expect(() => parseCliResult("dataset",{kind:"deleted",deleted:true,datasetId:id(1),records:[]})).toThrow();
});

it("accepts an expected Collection identity and derives migration source from its address", () => {
  const request = { action: "prepareMigration", workspaceId: "workspace", datasetPath: "orders/dataset.json", expectedDatasetId: "00000000-0000-4000-8000-000000000001", migrationPath: "orders/change.sql" };
  expect(DatasetRequest.parse(request)).toEqual(request);
  expect(() => DatasetRequest.parse({ ...request, descriptorPath: "another/dataset.json" })).toThrow();
});
