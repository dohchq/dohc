import { expect, it } from "vitest";
import { parseCliArguments } from "./args";
import { OwnerAppResponsesRequest, OwnerAppResponsesResult } from "./appResponses";

it("offers the same response list and undo selections to agents",()=>{
  const input={workspaceId:"w",grantId:"g",publicPrincipalId:"public-a"};
  expect(parseCliArguments(["--as-agent","app","responses",JSON.stringify(input)],{})).toMatchObject({actor:"agent",verb:"ownerAppResponses",request:{action:"list",...input,limit:100}});
  expect(parseCliArguments(["app","undo-responses",JSON.stringify({...input,operationId:"undo-a"})],{})).toMatchObject({verb:"ownerAppResponses",request:{action:"undo",...input,operationId:"undo-a",limit:100}});
  expect(()=>parseCliArguments(["app","undo-responses",JSON.stringify(input)],{})).toThrow();
});

it("bounds owner response selections and rejects extra authority fields",()=>{
  expect(OwnerAppResponsesRequest.safeParse({action:"list",workspaceId:"w",grantId:"g",ownerUserId:"owner"}).success).toBe(false);
  expect(OwnerAppResponsesRequest.safeParse({action:"list",workspaceId:"w",grantId:"g",limit:101}).success).toBe(false);
  expect(OwnerAppResponsesResult.safeParse({action:"undo",items:[],nextCursor:null,acceptances:[]}).success).toBe(false);
});
