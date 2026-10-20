import { expect, it } from "vitest";
import { ChatFileMentionsInput, ChatFileMentionsPage } from "./chatFileMentions";
const page = { versionId:"main",subject:null,entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,sharedChannelRowsUncovered:0,nextCursor:null };
it("bounds combined records and the entire UTF-8 page including the cursor",()=>{
  expect(ChatFileMentionsPage.safeParse({...page,unchecked:Array.from({length:100},(_,i)=>String(i))}).success).toBe(true);
  expect(ChatFileMentionsPage.safeParse({...page,unchecked:Array(101).fill("a")}).success).toBe(false);
  expect(ChatFileMentionsPage.safeParse({...page,unchecked:Array(30).fill("x".repeat(4096))}).success).toBe(false);
});
it("rejects obsolete unpaged requests and invalid subjects",()=>{
  expect(ChatFileMentionsInput.safeParse({objectId:"o",limit:2000}).success).toBe(false);
  expect(ChatFileMentionsInput.parse({subject:{objectId:"o"},cursor:"sealed"})).toEqual({subject:{objectId:"o"},cursor:"sealed"});
  expect(ChatFileMentionsInput.safeParse({subject:{objectId:"o",path:"a.md"}}).success).toBe(false);
  expect(ChatFileMentionsPage.safeParse({...page,sharedChannelRowsUncovered:-1}).success).toBe(false);
});
