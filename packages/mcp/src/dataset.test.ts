import { describe, expect, it, vi } from "vitest";
import { dataset, type ToolContext } from "./tools";
const request = {action:"invoke",workspaceId:"workspace",datasetPath:"equipment/dataset.json",operationId:"00000000-0000-4000-8000-000000000002",revision:1,revisionSha256:"a".repeat(64),input:{name:"Camera"},idempotencyKey:"add-1"};
describe("dataset MCP transport", () => {
  it("rejects opaque IDs and folder paths before transport", async () => {
    const send = vi.fn(), context: ToolContext = { root: "/workspace", home: "/home", request: send };
    for (const selection of [{ datasetId: "00000000-0000-4000-8000-000000000001" }, { datasetPath: "equipment" }, { datasetPath: "../equipment/dataset.json" }]) {
      expect(await dataset(context, { action: "describe", workspaceId: "workspace", ...selection })).toMatchObject({ ok: false });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("explains how to address a Collection listed outside the MCP folder", async () => {
    const send = vi.fn(), context: ToolContext = { root: "/workspace/app", home: "/home", request: send };
    expect(await dataset(context, { action: "describe", workspaceId: "workspace", datasetPath: "../equipment/dataset.json" })).toMatchObject({ ok: false, reason: expect.stringContaining("Run the MCP server from the workspace root or a folder containing the Collection.") });
    expect(send).not.toHaveBeenCalled();
  });
  it("requires explicit owner cancellation acknowledgement and preserves the result", async () => {
    const reply = {kind:"attempt-cancelled",cancelled:true};
    const send = vi.fn(async () => reply), context:ToolContext = {root:"/workspace",home:"/home",request:send};
    const input = {action:"cancelAttempt",workspaceId:request.workspaceId,datasetPath:request.datasetPath,reference:"a".repeat(64),acknowledge:true};
    expect(await dataset(context,{...input,acknowledge:false})).toMatchObject({ok:false}); expect(send).not.toHaveBeenCalled();
    expect(await dataset(context,input)).toEqual(reply); expect(send).toHaveBeenCalledOnce();
  });
  it("exports only to an explicit owner-selected path without returning archive bytes", async () => {
    const reply = {kind:"exported",savedPath:"C:/private/backup.dohc-recovery"};
    const send = vi.fn(async () => reply), context:ToolContext = {root:"/workspace",home:"/home",request:send};
    const input = {action:"export",workspaceId:request.workspaceId,datasetPath:request.datasetPath};
    expect(await dataset(context,input)).toMatchObject({ok:false}); expect(send).not.toHaveBeenCalled();
    expect(await dataset(context,{...input,savePath:reply.savedPath})).toEqual(reply);
    expect(send).toHaveBeenCalledOnce();
  });
  it("uses the scoped desktop transport and validates its result", async () => {
    const reply = {kind:"invoked",result:{id:"record"},revision:2,replayed:false};
    const send = vi.fn(async () => reply), context:ToolContext = {root:"/workspace",home:"/home",request:send};
    expect(await dataset(context,request)).toEqual(reply);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({verb:"dataset",args:{cwd:context.root,actor:"agent",request}}));
    expect(await dataset({...context,request:async () => ({...reply,extraAuthority:true})},request)).toMatchObject({ok:false});
  });
  it("does not turn folder sharing or arbitrary SQL into dataset authority", async () => {
    const send = vi.fn(), context:ToolContext = {root:"/workspace",home:"/home",request:send};
    for (const shareAccess of ["view","comment","edit"] as const) expect(await dataset({...context,shareAccess},request)).toMatchObject({ok:false});
    expect(await dataset(context,{...request,sql:"SELECT * FROM private"})).toMatchObject({ok:false});
    expect(await dataset(context,{...request,caller:{kind:"owner"}})).toMatchObject({ok:false});
    expect(send).not.toHaveBeenCalled();
  });
});
