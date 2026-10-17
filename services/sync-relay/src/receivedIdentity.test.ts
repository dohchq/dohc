import { expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createReceivedIdentity, tokenizeReceivedPayload } from "./receivedIdentity";
import { filterOpForShare, type ShareSelector, type ChatShareThreadResolver } from "./shareFilter";
const identity = createReceivedIdentity("key");
it("uses the accepted full HMAC, separates recipient/source/domain, and rotates without aliases", () => {
  const expected = createHmac("sha256", "key").update(JSON.stringify(["dohc/received-source/v1",["user","r"],"w"])).digest("hex");
  expect(identity.source(["user","r"],"w")).toBe("share-source:v1:"+expected);
  const handles = [identity.source(["user","r"],"w"),identity.source(["user","other"],"w"),identity.source(["user","r"],"other"),identity.source(["link","r"],"w"),identity.source(["link","other"],"w"),createReceivedIdentity("new").source(["user","r"],"w")];
  expect(new Set(handles).size).toBe(handles.length);
  expect(identity.object(["user","r"],"w","o")).not.toBe(handles[0]);
  expect(identity.object(["user","r"],"w","o")).not.toBe(identity.object(["user","other"],"w","o"));
  expect(identity.source(["user","owner"],"w")).not.toBe("w");
});
it("no key means no handle/token and never the real id", () => {
  expect(createReceivedIdentity().source(["user","r"],"real-workspace")).toBeUndefined();
  expect(createReceivedIdentity().object(["user","r"],"real-workspace","real-object")).toBeUndefined();
});
const selector: ShareSelector = {paths:["docs"],versionId:null,access:"view" as const};
const chat: ChatShareThreadResolver = {channelKind:()=>"channel",threadChannelWireId:()=>"channel",threadFileBinding:()=>({kind:"object",objectId:"real-object"}),objectCurrentPath:id=>id==="real-object"?"docs/a.md":"private/a.md",objectIdAtPath:()=>"real-object"};
function served(opKind:string,original:Record<string,unknown>,key: string | null = "key",scope = selector) {
  const decision=filterOpForShare(scope,opKind,JSON.stringify(original),chat);
  if(!decision.allowed) throw Error("Fixture denied");
  const payload=decision.payload as Record<string,unknown>;
  tokenizeReceivedPayload({identity:createReceivedIdentity(key ?? undefined),recipient:["user","r"],workspaceId:"real-workspace",selector:scope,chat,opKind,original,served:payload});
  return payload;
}
it("matches moment, thread and in-selector chip tokens across shares without source ids",()=>{
  const moment=served("moment.append",{versionId:"main",objectId:"real-object",operation:"write",path:"docs/a.md",payloadAfterPath:"docs/a.md",payloadAfterBlobSha256:"a".repeat(64)});
  const thread=served("chat.thread.create",{threadId:"t",title:"Thread",linkedObjectId:"real-object",createdAtMs:1});
  const chip=served("chat.attachment.add",{threadId:"t",attachmentId:"a",objectId:"real-object",name:"a.md",createdAtMs:1});
  expect(thread.linkedObjectId).toBe(moment.objectId); expect(chip.objectId).toBe(moment.objectId);
  expect(JSON.stringify([moment,thread,chip])).not.toContain("real-object");
  expect(served("chat.attachment.add",{threadId:"t",attachmentId:"a",objectId:"private",pathHint:"private/a.md",createdAtMs:1})).not.toHaveProperty("objectId");
  expect(served("moment.append",{versionId:"main",objectId:"real-object",operation:"write",path:"docs/a.md",payloadAfterPath:"docs/a.md",payloadAfterBlobSha256:"a".repeat(64)},null)).not.toHaveProperty("objectId");
});
it("keyless filtered moments, snapshots, threads and chips never expose source ids", () => {
  const rows = [
    served("moment.append", { versionId: "main", objectId: "real-object", operation: "write", path: "docs/a.md", payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: "a".repeat(64) }, null),
    served("version.create", { versionId: "v", forkSnapshots: [{ path: "docs/a.md", objectId: "real-object", blobSha256: "a".repeat(64) }] }, null, { ...selector, versionId: "v" }),
    served("chat.thread.create", { threadId: "t", title: "Thread", linkedObjectId: "real-object", createdAtMs: 1 }, null),
    served("chat.attachment.add", { threadId: "t", attachmentId: "a", objectId: "real-object", pathHint: "docs/a.md", createdAtMs: 1 }, null),
  ];
  expect(JSON.stringify(rows)).not.toMatch(/real-object|real-workspace|share-object:v1:|share-source:v1:/);
});
it("tokens snapshots after accountless path projection", () => {
  const original = { versionId: "v", forkSnapshots: [{ path: "nested/docs/a.md", objectId: "real-object", blobSha256: "a".repeat(64) }] };
  const payload = { versionId: "v", forkSnapshots: [{ path: "docs/a.md", blobSha256: "a".repeat(64) }] };
  tokenizeReceivedPayload({ identity, recipient: ["link", "grant"], workspaceId: "real-workspace", selector: { ...selector, paths: ["nested/docs"], versionId: "v" }, chat, opKind: "version.create", original, served: payload, projectPath: path => path.replace(/^nested\//, "") });
  expect(payload.forkSnapshots[0]).toEqual({ path: "docs/a.md", blobSha256: "a".repeat(64), objectId: identity.object(["link", "grant"], "real-workspace", "real-object") });
});
it("tokens shared version snapshots only after path redaction",()=>{
  const result=served("version.create",{versionId:"v",forkSnapshots:[{path:"docs/a.md",objectId:"real-object",blobSha256:"a".repeat(64)},{path:"private/a.md",objectId:"private"}]},"key",{...selector,versionId:"v"});
  expect(result.forkSnapshots).toEqual([{path:"docs/a.md",objectId:identity.object(["user","r"],"real-workspace","real-object"),blobSha256:"a".repeat(64)}]);
});
