import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, cliRequestSchema, parseCliResult } from "./protocol";
import type { DatasetRequest } from "./dataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const definition = {formatVersion:1,datasetId:id(1),name:"Equipment",schemaPath:"equipment/schema.sql",operationsPath:"equipment/actions.ts",
  tables:[{tableId:id(2),name:"Equipment",sqlName:"equipment",primaryKey:"id",fields:[{fieldId:id(3),name:"ID",sqlColumn:"id",type:"text",required:true,unique:true}]}],
  operations:[{operationId:id(4),name:"list",label:"List equipment",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3)]}]};
const requests: unknown[] = [
  {action:"pendingAttempts",workspaceId:"workspace",datasetId:id(1),after:0,limit:10},
  {action:"reconcileAttempt",workspaceId:"workspace",datasetId:id(1),reference:"b".repeat(64),acknowledge:true},
  {action:"archive",workspaceId:"workspace",datasetId:id(1)},
  {action:"restore",workspaceId:"workspace",datasetId:id(1)},
  {action:"lifecycle",workspaceId:"workspace",datasetId:id(1),limit:50},
  {action:"list",workspaceId:"workspace",includeArchived:true},
  {action:"list",workspaceId:"workspace"},
  {action:"describe",workspaceId:"workspace",datasetId:id(1)},
  {action:"export",workspaceId:"workspace",datasetId:id(1),savePath:"C:/private/fundraiser.dohc-recovery"},
  {action:"create",workspaceId:"workspace",definition},
  {action:"prepare",workspaceId:"workspace",descriptorPath:"equipment/dataset.json"},
  {action:"approve",workspaceId:"workspace",preparationId:id(5),revisionSha256:"a".repeat(64)},
  {action:"discard",workspaceId:"workspace",preparationId:id(5)},
  {action:"invoke",workspaceId:"workspace",datasetId:id(1),operationId:id(4),revision:1,revisionSha256:"a".repeat(64),input:{limit:10},idempotencyKey:"read-1"},
];
describe("dataset CLI", () => {
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
    expect(JSON.parse(executed.stdout)).toEqual({schemaVersion:1,...result});
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
    const result = await executeCli({argv:["dataset","--help"],request:send});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("create: definition");
    expect(result.stdout).toContain("revisionSha256");
    expect(result.stdout).toContain("same input and idempotencyKey");
    expect(send).not.toHaveBeenCalled();
  });
  it("requires a chosen export destination and returns no private archive bytes", async () => {
    const send = vi.fn(async () => ({kind:"exported",savedPath:"C:/private/backup.dohc-recovery"}));
    const missing = await executeCli({argv:["dataset","export",JSON.stringify({workspaceId:"workspace",datasetId:id(1)})],request:send});
    expect(missing.exitCode).toBe(1); expect(send).not.toHaveBeenCalled();
    const saved = await executeCli({argv:["dataset","export",JSON.stringify({workspaceId:"workspace",datasetId:id(1),savePath:"C:/private/backup.dohc-recovery"})],request:send});
    expect(saved.exitCode).toBe(0); expect(saved.stdout).toContain("savedPath");
  });
});
