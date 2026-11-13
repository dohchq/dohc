import type {StorageContext} from "./storage/context";
import {afterEach, describe, expect, it} from "vitest";
import {hashLinkBearer} from "./linkSecurity";
import {LINK_KEY, RELAY_EXCHANGE_KEY, linkRequest, seedLinkGrant, seedLinkSession} from "./testing";
import {appendLog, chatChannelCreate, chatMessageAppend, chatThreadCreate, claimWorkspace, closeTestStorages, createShare, denialBytes, inspectDatabase, json, jsonBody, moment, putBlob, request, sequenced, storagePath, testHandler, testStorage} from "./testing";

afterEach(closeTestStorages);
const ws = "references";
const target = {kind: "file", versionId: "main", objectId: "plan"} as const;
const ref = "A".repeat(43);
type ReferencePage = Awaited<ReturnType<StorageContext["listWorkReferences"]>>;

function mintBody(target: unknown): RequestInit {
  return {...jsonBody({workspaceId: ws, target}), headers: {"content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY}};
}
async function register(handler: ReturnType<typeof testHandler>, references: unknown[]) {
  return handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: references})));
}

async function fixture() {
  const storage = await testStorage() as StorageContext;
  const handler = testHandler(storage, {relayExchangeKey: RELAY_EXCHANGE_KEY});
  await claimWorkspace(handler, "owner", ws);
  await putBlob(handler, "owner", ws, "Plan");
  await appendLog(handler, "owner", ws, [moment("notes/plan.md", "Plan", {originSeq: 0, objectId: "plan", recordedAtMs: 1})], {originId: "device"});
  return {storage, handler};
}

describe("work reference registration and resolution", () => {
  it("keeps immutable bindings and accepts an older backup's second reference", async () => {
    const {handler} = await fixture();
    const register = (reference: string, binding: {kind: "file"; versionId: string; objectId: string} = target, user = "owner") => handler(request(user, `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference, target: binding, createdAtMs: 1}]})));
    expect((await register(ref)).status).toBe(200);
    expect((await register(ref)).status).toBe(200);
    expect((await register("B".repeat(43))).status).toBe(200);
    expect((await register(ref, {...target, objectId: "forged"})).status).toBe(404);
    expect(await json(await register("C".repeat(43), {...target, objectId: "forged"}))).toMatchObject({registeredReferences: []});
    expect((await register("C".repeat(43), target, "reader")).status).toBe(404);
    const resolved = await json(await handler(request("owner", `/sync/work-references/${ref}`)));
    expect(resolved).toMatchObject({status: "found", target});
  });

  it("filters mappings by target access, projects identities, and rechecks revocation", async () => {
    const {handler} = await fixture();
    await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: ref, target, createdAtMs: 1}]})));
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const found = await json(await handler(request("reader", `/sync/work-references/${ref}`)));
    expect(found.status).toBe("found");
    expect(JSON.stringify(found)).not.toContain('"objectId":"plan"');
    expect((found.target as {objectId: string}).objectId).toMatch(/^share-object:v1:/);
    expect((await handler(request("reader", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: "B".repeat(43), target, createdAtMs: 1}]})))).status).toBe(404);
    const hidden = await denialBytes(await handler(request("stranger", `/sync/work-references/${ref}`)));
    const missing = await denialBytes(await handler(request("reader", `/sync/work-references/${"Z".repeat(43)}`)));
    expect(hidden).toBe(missing);
    expect((await handler(request("owner", `/sync/shares/${shareId}/revoke`, {method: "POST"}))).status).toBe(200);
    expect(await denialBytes(await handler(request("reader", `/sync/work-references/${ref}`)))).toBe(missing);
  });

  it("keeps unknown, deleted, and forbidden responses identical and retains the deletion scope", async () => {
    const {handler, storage} = await fixture();
    await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: ref, target, createdAtMs: 1}]})));
    await appendLog(handler, "owner", ws, [moment("notes/plan.md", "", {originSeq: 1, objectId: "plan", operation: "delete", beforePath: "notes/plan.md", beforeContent: "Plan", afterPath: null, afterContent: null})], {originId: "device"});
    const deleted = await denialBytes(await handler(request("owner", `/sync/work-references/${ref}`)));
    expect(deleted).toBe(await denialBytes(await handler(request("owner", `/sync/work-references/${"Z".repeat(43)}`))));
    expect(deleted).toBe(await denialBytes(await handler(request("stranger", `/sync/work-references/${ref}`))));
    const db = inspectDatabase(storagePath(storage));
    expect(db.prepare("SELECT last_path,deleted FROM sync_relay_work_reference_scopes WHERE reference=?").get(ref))
      .toMatchObject({last_path: "notes/plan.md", deleted: 1});
    await appendLog(handler, "owner", ws, [moment("notes/plan.md", "Plan", {originSeq: 2, objectId: "replacement"})], {originId: "device"});
    expect(await denialBytes(await handler(request("owner", `/sync/work-references/${ref}`)))).toBe(deleted);
  });

  it("does not resolve a pinned version through a grant on another version", async () => {
    const {handler} = await fixture();
    await appendLog(handler, "owner", ws, [moment("notes/plan.md", "Plan", {originSeq: 1, objectId: "plan", versionId: "draft"})], {originId: "device"});
    const pinned = {...target, versionId: "draft"};
    await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: ref, target: pinned, createdAtMs: 1}]})));
    await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view", versionId: "main"});
    expect((await handler(request("reader", `/sync/work-references/${ref}`))).status).toBe(404);
    expect(await json(await handler(request("owner", `/sync/work-references/${ref}`)))).toMatchObject({status: "found", target: pinned});
  });

  it("requires the reader's own received token when minting through a share", async () => {
    const {handler} = await fixture();
    await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: ref, target, createdAtMs: 1}]})));
    await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "other", access: "view"});
    const found = await json(await handler(request("reader", `/sync/work-references/${ref}`)));
    const make = (user: string, binding: unknown) => handler(request(user, `/sync/internal/work-references`, mintBody(binding)));
    expect(await json(await make("reader", found.target))).toMatchObject({reference: ref, target: found.target});
    expect((await make("reader", target)).status).toBe(404);
    expect((await make("other", found.target)).status).toBe(404);
    expect((await handler(request("reader", `/sync/work-references/${ref}`, {headers: {cookie: "session=ignored"}}))).status).toBe(404);
  });

  it("resolves version snapshots and rechecks link sessions and grant revocation", async () => {
    const {handler, storage} = await fixture();
    const sha = await putBlob(handler, "owner", ws, "Snapshot");
    await appendLog(handler, "owner", ws, [{originSeq: 0, opKind: "version.create", recordedAtMs: 2,
      payload: {versionId: "fork", forkSnapshots: [{path: "notes/fork.md", objectId: "snapshot-object", blobSha256: sha}]},
    }], {originId: "fork-device"});
    const pinned = {...target, versionId: "fork", objectId: "snapshot-object"};
    expect((await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: ref, target: pinned, createdAtMs: 2}]})))).status).toBe(200);
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view", versionId: "fork"});
    const token = "L".repeat(43);
    seedLinkGrant(storage, {shareId, grantId: "link-grant", secretHash: hashLinkBearer("secret", LINK_KEY)});
    seedLinkSession(storage, {grantId: "link-grant", capabilityHash: hashLinkBearer(token, LINK_KEY)});
    const found = await json(await handler(linkRequest(token, `/sync/work-references/${ref}`)));
    expect(found).toMatchObject({status: "found", target: {versionId: "fork"}});
    expect(JSON.stringify(found)).not.toContain("snapshot-object");
    expect(await json(await handler(linkRequest(token,"/sync/internal/work-references",{
      ...jsonBody({target:found.target}),headers:{"content-type":"application/json","x-dohc-relay-exchange-key":RELAY_EXCHANGE_KEY},
    })))).toMatchObject({reference:ref,target:found.target});
    expect((await handler(linkRequest("X".repeat(43), `/sync/work-references/${ref}`))).status).toBe(404);
    expect((await handler(linkRequest(token, `/sync/shares/${shareId}/work-references`, jsonBody({references: []})))).status).toBe(404);
    storage.revokeShareGrant({shareId, grantId: "link-grant", revokedAtMs: 3});
    expect(await denialBytes(await handler(linkRequest(token, `/sync/work-references/${ref}`)))).toBe(
      await denialBytes(await handler(request("owner", `/sync/work-references/${"Z".repeat(43)}`))),
    );
  });
  it("keeps both public mint routes and standalone registration closed", async () => {
    const {handler, storage} = await fixture();
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    for (const user of ["owner", "reader", "stranger"]) {
      for (const path of [`/sync/${ws}/work-references/make`, `/sync/shares/${shareId}/work-references/make`, `/sync/${ws}/work-references`]) {
        expect((await handler(request(user, path, jsonBody({target, references: []})))).status).toBe(404);
      }
    }
    expect((await handler(request("owner", "/sync/internal/work-references", jsonBody({workspaceId: ws, target})))).status).toBe(404);
    expect((await handler(request("stranger", "/sync/internal/work-references", mintBody(target)))).status).toBe(404);
    expect(storage.db.prepare("SELECT count(*) AS n FROM sync_relay_work_references").get()!.n).toBe(0);
  });

  it("randomizes empty recipient cursors before and after hidden registrations", async () => {
    const {handler} = await fixture();
    const shareId = await createShare(handler, "owner", ws, {paths: ["private"], recipientUserId: "reader", access: "view"});
    const read = (after?: string) => handler(request("reader", `/sync/shares/${shareId}/work-references${after ? `?after=${encodeURIComponent(after)}` : ""}`)).then(json) as Promise<ReferencePage>;
    const after = (await read()).nextAfter;
    const first = await read(after);
    const second = await read(after);
    expect(first).toMatchObject({references: [], hasMore: false});
    expect(second).toMatchObject({references: [], hasMore: false});
    expect(first.nextAfter).toBeTypeOf("string");
    expect(second.nextAfter).toBeTypeOf("string");
    expect(second.nextAfter).not.toBe(first.nextAfter);
    expect(second.nextAfter).toHaveLength(first.nextAfter.length);

    expect(await json(await register(handler, [{reference: ref, target, createdAtMs: 1}])))
      .toMatchObject({registeredReferences: [ref]});
    const hidden = await read(after);
    const hiddenAgain = await read(after);
    expect(hidden).toMatchObject({references: [], hasMore: false});
    expect(hiddenAgain).toMatchObject({references: [], hasMore: false});
    expect(hidden.nextAfter).toBeTypeOf("string");
    expect(hiddenAgain.nextAfter).toBeTypeOf("string");
    expect(hidden.nextAfter).toHaveLength(first.nextAfter.length);
    expect(hiddenAgain.nextAfter).toHaveLength(first.nextAfter.length);
    expect(hiddenAgain.nextAfter).not.toBe(hidden.nextAfter);
  });

  it("resolves a chat only through a share of that chat, and a thread as its messages read", async () => {
    const {handler, storage} = await fixture();
    await appendLog(handler, "owner", ws, sequenced([
      chatChannelCreate("group", {type: "both", folderPath: "notes"}), chatThreadCreate("thread", "group"),
      chatMessageAppend("message", "thread", "Plan", {authorUserId: "owner"}),
    ]), {originId: "chat-device"});
    const chatRef = "C".repeat(43);
    const chat = {kind: "chat", channelId: "channel-group"};
    const thread = {kind: "thread", threadId: "thread", channelId: "channel-group"};
    expect(await json(await register(handler, [{reference: chatRef, target: chat, createdAtMs: 1}, {reference: ref, target: thread, createdAtMs: 1}])))
      .toMatchObject({registeredReferences: [chatRef, ref]});
    expect(await json(await register(handler, [{reference: "D".repeat(43), target: {kind: "chat", channelId: "forged"}, createdAtMs: 1}, {reference: "E".repeat(43), target: {...thread, channelId: "forged"}, createdAtMs: 1}])))
      .toMatchObject({registeredReferences: []});
    await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "filer", access: "view"});
    const missing = await denialBytes(await handler(request("filer", `/sync/work-references/${"Z".repeat(43)}`)));
    expect(await denialBytes(await handler(request("filer", `/sync/work-references/${chatRef}`)))).toBe(missing);
    expect(await denialBytes(await handler(request("filer", `/sync/work-references/${ref}`)))).toBe(missing);
    const shareId = await createShare(handler, "owner", ws, {channelWireId: "group", paths: ["notes"], recipientUserId: "reader", access: "read-only"});
    expect(await json(await handler(request("reader", `/sync/work-references/${chatRef}`)))).toMatchObject({status: "found", target: chat});
    // A Group share's reader reads a thread as they read its messages: without the owner's channel id.
    expect((await json(await handler(request("reader", `/sync/work-references/${ref}`)))).target).toEqual({kind: "thread", threadId: "thread"});
    expect(await json(await handler(request("reader", "/sync/internal/work-references", mintBody(chat))))).toMatchObject({reference: chatRef, target: chat});
    const token = "L".repeat(43);
    seedLinkGrant(storage, {shareId, grantId: "chat-link", access: "read-only", secretHash: hashLinkBearer("secret", LINK_KEY)});
    seedLinkSession(storage, {grantId: "chat-link", capabilityHash: hashLinkBearer(token, LINK_KEY)});
    expect((await json(await handler(linkRequest(token, `/sync/work-references/${ref}`)))).target).toEqual({kind: "thread", threadId: "thread"});
    // A link holds the chat's wire id, never the owner's engine id.
    expect(await denialBytes(await handler(linkRequest(token, `/sync/work-references/${chatRef}`)))).toBe(missing);
    expect(await json(await handler(request("stranger", `/sync/work-references/${chatRef}`)))).not.toMatchObject({status: "found"});
    // A later create of the same wire names no chat.
    await appendLog(handler, "owner", ws, sequenced([chatChannelCreate("group", {channelId: "later"})]), {originId: "other-device"});
    expect(await json(await register(handler, [{reference: "F".repeat(43), target: {kind: "chat", channelId: "later"}, createdAtMs: 1}])))
      .toMatchObject({registeredReferences: []});
    expect(await json(await handler(request("reader", "/sync/internal/work-references", mintBody({kind: "chat", channelId: "later"})))))
      .not.toMatchObject({target: {channelId: "later"}});
  });

  it("rechecks revocation after an asynchronous dataset proof", async () => {
    const {handler, storage} = await fixture();
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const datasetTarget = {kind: "transactionalCollection", datasetId: "00000000-0000-4000-8000-000000000001", tableId: "00000000-0000-4000-8000-000000000002"};
    storage.workReferenceDatasetAccess = async () => () => true;
    await register(handler, [{reference: ref, target: datasetTarget, createdAtMs: 1}]);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => {release = resolve;});
    const suspended = new Promise<void>(resolve => {entered = resolve;});
    storage.workReferenceDatasetAccess = async () => {entered(); await waiting; return () => true;};
    const read = handler(request("reader", `/sync/work-references/${ref}`));
    await suspended;
    expect((await handler(request("owner", `/sync/shares/${shareId}/revoke`, {method: "POST"}))).status).toBe(200);
    release();
    expect((await read).status).toBe(404);
  });

});
