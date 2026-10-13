import {expect,it} from "vitest";
import {accountDeletionKey,mintDeletionPreviewToken,matchesDeletionPreviewToken} from "./accountDeletion";
it("binds the preview to its account, server and exact scope for five minutes",()=>{
  const key=accountDeletionKey("test-secret-with-at-least-thirty-two-bytes"),now=10_000;
  const preview={email:"person@example.test",serverOrigin:"https://server.example.test",workspaceIds:["owned"],workspaceCount:1,ownedShareCount:2,heldGrantCount:3,storedBytes:123};
  const token=mintDeletionPreviewToken(key,"account",preview,now);
  expect(matchesDeletionPreviewToken(key,token,"account",preview,now)).toBe(true);
  expect(matchesDeletionPreviewToken(key,token,"other-account",preview,now)).toBe(false);
  expect(matchesDeletionPreviewToken(key,token,"account",{...preview,serverOrigin:"https://other.example.test"},now)).toBe(false);
  expect(matchesDeletionPreviewToken(key,token,"account",{...preview,workspaceIds:["replacement"]},now)).toBe(false);
  expect(matchesDeletionPreviewToken(key,token,"account",preview,now+5*60_000)).toBe(false);
  expect(matchesDeletionPreviewToken(key,token+"tampered","account",preview,now)).toBe(false);
});
