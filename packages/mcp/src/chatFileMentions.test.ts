import { expect, it, vi } from "vitest";
import { chatFileMentions, type ToolContext } from "./tools";
it("forwards exactly one bounded chat page with unchanged scope and continuation data",async()=>{
  const page={versionId:"main",subject:null,entries:[],unchecked:[],complete:false,indexBuilding:false,mountsCovered:false,sharedChannelRowsUncovered:4,nextCursor:"next"};
  const request=vi.fn(async()=>page);
  const ctx:ToolContext={root:process.cwd(),home:process.cwd(),shareAccess:"view",request};
  expect(await chatFileMentions(ctx,{subject:{objectId:"file"},cursor:"previous"})).toEqual(page);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({door:"mcp",verb:"chatFileMentions",args:{cwd:ctx.root,actor:"agent",subject:{objectId:"file"},cursor:"previous"}}));
});
