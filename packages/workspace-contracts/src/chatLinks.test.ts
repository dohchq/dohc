import { expect, it } from "vitest";
import { ChatLinksInput, ChatLinksPage, ChatLinksEnginePage } from "./chatLinks";
const page={versionId:"main",subject:{channelWireId:"wire"},entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,sharedChannelRowsUncovered:0,nextCursor:null};
it("accepts empty continuations and refuses caller page sizes or authority",()=>{
  expect(ChatLinksPage.parse({...page,nextCursor:"next"})).toMatchObject({entries:[],nextCursor:"next"});
  for(const extra of [{limit:1},{pageSize:1},{workspaceId:"other"},{scope:"owner"},{authorUserId:"secret"}])
    expect(ChatLinksInput.safeParse({channelWireId:"wire",...extra}).success).toBe(false);
});
it("keeps raw identity in the engine contract and refuses it at every public author boundary",()=>{
  const entry={file:{objectId:"o",path:"a.md",folder:""},attachmentId:"a",threadId:"t",messageId:"m",mentionedAtMs:1,
    author:{authorKind:"human",authorDisplayName:"Ada",authorUserId:"secret",authorActorKey:"secret"}};
  expect(ChatLinksEnginePage.parse({...page,entries:[entry]})).not.toBeNull();
  expect(ChatLinksPage.safeParse({...page,entries:[entry]}).success).toBe(false);
  const {attachmentId:_,...publicEntry}=entry;
  const author={kind:"human",displayName:"Ada",presentation:{group:"opaque",hue:null,self:false}};
  expect(ChatLinksPage.safeParse({...page,entries:[{...publicEntry,author}]}).success).toBe(true);
  for(const key of ["authorUserId","authorActorKey"])
    expect(ChatLinksPage.safeParse({...page,entries:[{...publicEntry,author:{...author,[key]:"secret"}}]}).success).toBe(false);
  expect(ChatLinksPage.safeParse({...page,entries:Array.from({length:101},()=>({...publicEntry,author}))}).success).toBe(false);
  expect(ChatLinksEnginePage.safeParse({...page,entries:[{...entry,author:{...entry.author,authorDisplayName:"a".repeat(65536)}}]}).success).toBe(false);
});
