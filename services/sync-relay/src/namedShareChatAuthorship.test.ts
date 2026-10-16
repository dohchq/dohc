import { afterEach, describe, expect, it } from "vitest";
import { namedShareOrigin, type LogAuthorNameLookup } from "./relayLogInputs";
import {
  chatChannelCreate, chatMessageAppend, chatThreadCreate, claimWorkspace,
  closeTestStorage, closeTestStorages, json, jsonBody, reopenTestStorage,
  request, sequenced, storagePath, testHandler, testStorage,
} from "./testing";

afterEach(closeTestStorages);

async function fixture(lookupUserDisplayName: LogAuthorNameLookup = () => "Recipient") {
  const storage = await testStorage();
  const h = testHandler(storage, {lookupUserDisplayName});
  await claimWorkspace(h, "owner", "workspace");
  expect((await h(request("owner", "/sync/workspace/log", jsonBody({originId: "owner-device", ops: sequenced([
    chatChannelCreate("wire", {name: "Team", slug: "team", type: "chat"}),
    chatThreadCreate("thread", "wire"),
  ])})))).status).toBe(200);
  const share = await h(request("owner", "/sync/workspace/shares", jsonBody({recipientUserId: "recipient", channelWireId: "wire", access: "read-write"})));
  expect(share.status).toBe(200);
  const {shareId} = await json(share) as {shareId: string};
  const push = (ops: ReturnType<typeof sequenced>) => h(request("recipient", "/sync/shares/" + shareId + "/log", jsonBody({originId: "device", ops})));
  const coordinate = (originSeq: number) => storage.fetchLogCoordinate({workspaceId: "workspace", originId: namedShareOrigin(shareId, "recipient", "device"), originSeq});
  return {storage, h, shareId, push, coordinate};
}

function message(authorKind: "human" | "agent" | "automation", extra: Record<string, unknown> = {}) {
  return chatMessageAppend("message", "thread", "hello", {
    authorKind, authorUserId: "recipient", authorDisplayName: authorKind === "human" ? "Owner" : "Writer",
    authorOwnerDisplayName: "Owner", ...extra,
  });
}

describe("named share chat author names", () => {
  it.each(["human", "agent", "automation"] as const)("stores and serves the account behind a %s post", async authorKind => {
    const f = await fixture();
    const payload = message(authorKind, authorKind === "automation" ? {chainDepth: 2} : {}).payload;
    const ops = sequenced([{opKind: "chat.message.append", payload}]);
    expect(await json(await f.push(ops))).toMatchObject({inserted: 1, skipped: 0});
    const expected: Record<string, unknown> = {...payload, authorDisplayName: authorKind === "human" ? "Recipient" : "Writer"};
    if (authorKind === "human") delete expected.authorOwnerDisplayName;
    else expected.authorOwnerDisplayName = "Recipient";
    expect(JSON.parse(f.coordinate(0)!.payloadJson)).toEqual(expected);
    expect(f.coordinate(0)?.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "recipient", humanName: "Recipient"}]);
    for (const [userId, path] of [
      ["owner", "/sync/workspace/log"],
      ["recipient", "/sync/shares/" + f.shareId + "/log"],
    ]) {
      const page = await json(await f.h(request(userId!, path!))) as {ops: Array<{opKind: string; payload: Record<string, unknown>}>};
      expect(page.ops.find(op => op.opKind === "chat.message.append")?.payload).toEqual(expected);
    }
  });

  it("names a post Unnamed when the account name lookup fails", async () => {
    const f = await fixture(() => Promise.reject(new Error("accounts unavailable")));
    expect(await json(await f.push(sequenced([message("human")])))).toMatchObject({inserted: 1, skipped: 0});
    expect(JSON.parse(f.coordinate(0)!.payloadJson)).toMatchObject({authorDisplayName: "Unnamed"});
    expect(f.coordinate(0)?.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "recipient", humanName: "Unnamed"}]);
  });

  it.each(["human", "agent", "automation"] as const)("stores and serves the account name for a %s reaction and reuses it after a rename", async authorKind => {
    let name = "Recipient";
    const f = await fixture(() => name);
    const payload = {
      reactionId: "reaction", messageId: "message", threadId: "thread", emoji: "👍",
      authorId: "recipient", authorKind, authorDisplayName: "Owner", state: "added", atMs: 4,
    };
    const ops = sequenced([message("human"), {opKind: "chat.reaction.set", payload}]);
    expect(await json(await f.push(ops))).toMatchObject({inserted: 2, skipped: 0});
    const expected = {...payload, authorDisplayName: "Recipient"};
    const original = f.coordinate(1)!;
    expect(JSON.parse(original.payloadJson)).toEqual(expected);
    expect(original.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "recipient", humanName: "Recipient"}]);
    for (const [userId, path] of [
      ["owner", "/sync/workspace/log"],
      ["recipient", "/sync/shares/" + f.shareId + "/log"],
    ]) {
      const page = await json(await f.h(request(userId!, path!))) as {ops: Array<{opKind: string; payload: Record<string, unknown>}>};
      expect(page.ops.find(op => op.opKind === "chat.reaction.set")?.payload).toEqual(expected);
    }
    name = "Renamed recipient";
    const retry = ops.map(op => op.opKind === "chat.reaction.set"
      ? {...op, payload: {...op.payload, authorDisplayName: "Another claim"}} : op);
    expect(await json(await f.push(retry))).toMatchObject({inserted: 0, skipped: 2});
    expect(f.coordinate(1)).toEqual(original);
    const changed = ops.map(op => op.opKind === "chat.reaction.set"
      ? {...op, payload: {...op.payload, emoji: "👎"}} : op);
    expect((await f.push(changed)).status).toBe(409);
  });

  it.each(["agent", "automation"] as const)("stores and serves a trimmed %s post name", async authorKind => {
    const f = await fixture();
    expect(await json(await f.push(sequenced([message(authorKind, {authorDisplayName: "  Writer \t"})])))).toMatchObject({inserted: 1});
    expect(JSON.parse(f.coordinate(0)!.payloadJson)).toMatchObject({authorDisplayName: "Writer", authorOwnerDisplayName: "Recipient"});
    const page = await json(await f.h(request("recipient", "/sync/shares/" + f.shareId + "/log"))) as {ops: Array<{opKind: string; payload: Record<string, unknown>}>};
    expect(page.ops.find(op => op.opKind === "chat.message.append")?.payload.authorDisplayName).toBe("Writer");
  });

  it.each(["human", "agent", "automation"] as const)("reuses the original %s name after a rename, restart, and overlapping batch retry", async authorKind => {
    let name = "Recipient";
    const f = await fixture(() => name);
    const ops = sequenced([
      chatThreadCreate("new-thread", "wire"),
      message(authorKind, {threadId: "new-thread"}),
    ]);
    expect(await json(await f.push(ops))).toMatchObject({inserted: 2, skipped: 0});
    const original = f.coordinate(1)!;
    name = "Renamed recipient";
    const dbPath = storagePath(f.storage);
    closeTestStorage(f.storage);
    const reopened = reopenTestStorage(dbPath);
    const h = testHandler(reopened, {lookupUserDisplayName: () => name});
    const push = (next: ReturnType<typeof sequenced>) => h(request("recipient", "/sync/shares/" + f.shareId + "/log", jsonBody({originId: "device", ops: next})));
    expect(await json(await push(ops))).toMatchObject({inserted: 0, skipped: 2});
    expect(await json(await push(ops))).toMatchObject({inserted: 0, skipped: 2});
    const next = sequenced([message(authorKind, {messageId: "new-message", threadId: "new-thread"})], 2);
    expect(await json(await push([...ops, ...next]))).toMatchObject({inserted: 1, skipped: 2});
    const row = reopened.fetchLogCoordinate({workspaceId: "workspace", originId: original.originId, originSeq: 1});
    expect(row).toEqual(original);
    const newPayload = JSON.parse(reopened.fetchLogCoordinate({workspaceId: "workspace", originId: original.originId, originSeq: 2})!.payloadJson) as Record<string, unknown>;
    expect(authorKind === "human" ? newPayload.authorDisplayName : newPayload.authorOwnerDisplayName).toBe(name);
    expect(reopened.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 20}).rows.filter(row => row.originId === original.originId)).toHaveLength(3);
    const changed = ops.map(op => op.opKind === "chat.message.append" ? {...op, payload: {...op.payload, body: "changed"}} : op);
    expect((await push(changed)).status).toBe(409);
    if (authorKind !== "human") {
      const renamedAgent = ops.map(op => op.opKind === "chat.message.append" ? {...op, payload: {...op.payload, authorDisplayName: "Another writer"}} : op);
      expect((await push(renamedAgent)).status).toBe(409);
    }
    const forged = ops.map(op => op.opKind === "chat.message.append" ? {...op, payload: {...op.payload, authorUserId: "owner"}} : op);
    expect((await push(forged)).status).toBe(403);
    expect(reopened.fetchLogCoordinate({workspaceId: "workspace", originId: original.originId, originSeq: 1})).toEqual(original);
  });

  it.each([null, "", "  ", "x".repeat(513), "x".repeat(201)])("names the person Unnamed when the account name is unavailable or invalid: %j", async name => {
    const f = await fixture(() => name);
    expect(await json(await f.push(sequenced([message("human")])))).toMatchObject({inserted: 1});
    expect(JSON.parse(f.coordinate(0)!.payloadJson).authorDisplayName).toBe("Unnamed");
  });

  it.each(["human", "agent", "automation"] as const)("leaves the owner's ordinary %s payload unchanged", async authorKind => {
    const f = await fixture(() => "Account name");
    const ops = sequenced([message(authorKind, {authorUserId: "owner", authorDisplayName: "Local name", authorOwnerDisplayName: "Local owner"})]);
    const response = await f.h(request("owner", "/sync/workspace/log", jsonBody({originId: "own-chat", ops})));
    expect(response.status).toBe(200);
    const row = f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "own-chat", originSeq: 0});
    expect(JSON.parse(row!.payloadJson)).toEqual(ops[0]!.payload);
    expect(row?.admittedAuthorSnapshot).toBeUndefined();
  });

  it.each(["agent", "automation"] as const)("replaces malformed and absent owner names on a %s post", async kind => {
    const f = await fixture();
    const ops = sequenced([message(kind, {authorOwnerDisplayName: ["Owner"]})]);
    expect(await json(await f.push(ops))).toMatchObject({inserted: 1});
    expect(JSON.parse(f.coordinate(0)!.payloadJson).authorOwnerDisplayName).toBe("Recipient");
    const retry = ops.map(op => {
      const {authorOwnerDisplayName: _owner, ...payload} = op.payload;
      return {...op, payload};
    });
    expect(await json(await f.push(retry))).toMatchObject({inserted: 0, skipped: 1});
  });

  it("ignores client snapshots and person names, including malformed owner names", async () => {
    const f = await fixture();
    const ops = sequenced([message("human", {authorDisplayName: {name: "Owner"}, authorOwnerDisplayName: ["Owner"]})]);
    const forgedSnapshot = [{kind: "human", humanId: "owner", humanName: "Owner"}];
    expect(await json(await f.push(ops.map(op => ({...op, admittedAuthorSnapshot: forgedSnapshot}))))).toMatchObject({inserted: 1});
    expect(JSON.parse(f.coordinate(0)!.payloadJson)).toMatchObject({authorDisplayName: "Recipient", authorUserId: "recipient"});
    expect(JSON.parse(f.coordinate(0)!.payloadJson)).not.toHaveProperty("authorOwnerDisplayName");
    const retry = ops.map(op => ({...op, payload: {...op.payload, authorDisplayName: "Another claim", authorOwnerDisplayName: null}}));
    expect(await json(await f.push(retry))).toMatchObject({inserted: 0, skipped: 1});
  });
});
