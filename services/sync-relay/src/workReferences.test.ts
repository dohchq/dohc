import {afterEach, describe, expect, it} from "vitest";
import {hashLinkBearer} from "./linkSecurity";
import {LINK_KEY, linkRequest, seedLinkGrant, seedLinkSession} from "./testing";
import {appendLog, chatChannelCreate, chatMessageAppend, chatThreadCreate, claimWorkspace, closeTestStorages, createShare, denialBytes, inspectDatabase, json, jsonBody, moment, putBlob, request, sequenced, storagePath, testHandler, testStorage} from "./testing";

afterEach(closeTestStorages);
const ws = "references";
const target = {kind: "file", versionId: "main", objectId: "plan"} as const;
const ref = "A".repeat(43);

async function fixture() {
  const storage = await testStorage();
  const handler = testHandler(storage);
  await claimWorkspace(handler, "owner", ws);
  await putBlob(handler, "owner", ws, "Plan");
  await appendLog(handler, "owner", ws, [moment("notes/plan.md", "Plan", {originSeq: 0, objectId: "plan", recordedAtMs: 1})], {originId: "device"});
  return {storage, handler};
}

describe("work reference registration and resolution", () => {
  it("keeps immutable bindings and accepts an older backup's second reference", async () => {
    const {handler} = await fixture();
    const register = (reference: string, binding: {kind: "file"; versionId: string; objectId: string} = target, user = "owner") => handler(request(user, `/sync/${ws}/work-references`, jsonBody({references: [{reference, target: binding, createdAtMs: 1}]})));
    expect((await register(ref)).status).toBe(200);
    expect((await register(ref)).status).toBe(200);
    expect((await register("B".repeat(43))).status).toBe(200);
    expect((await register(ref, {...target, objectId: "forged"})).status).toBe(404);
    expect((await register("C".repeat(43), {...target, objectId: "forged"})).status).toBe(404);
    expect((await register("C".repeat(43), target, "reader")).status).toBe(404);
    const resolved = await json(await handler(request("owner", `/sync/work-references/${ref}`)));
    expect(resolved).toMatchObject({status: "found", target});
  });

  it("filters mappings by target access, projects identities, and rechecks revocation", async () => {
    const {handler} = await fixture();
    await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: ref, target, createdAtMs: 1}]})));
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const found = await json(await handler(request("reader", `/sync/work-references/${ref}`)));
    expect(found.status).toBe("found");
    expect(JSON.stringify(found)).not.toContain('"objectId":"plan"');
    expect((found.target as {objectId: string}).objectId).toMatch(/^share-object:v1:/);
    expect((await handler(request("reader", `/sync/${ws}/work-references`, jsonBody({references: [{reference: "B".repeat(43), target, createdAtMs: 1}]})))).status).toBe(404);
    const hidden = await denialBytes(await handler(request("stranger", `/sync/work-references/${ref}`)));
    const missing = await denialBytes(await handler(request("reader", `/sync/work-references/${"Z".repeat(43)}`)));
    expect(hidden).toBe(missing);
    expect((await handler(request("owner", `/sync/shares/${shareId}/revoke`, jsonBody({})))).status).toBe(200);
    expect(await denialBytes(await handler(request("reader", `/sync/work-references/${ref}`)))).toBe(missing);
  });

  it("reuses a device reference when the server needs one", async () => {
    const {handler} = await fixture();
    await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: ref, target, createdAtMs: 1}]})));
    const make = () => handler(request("owner", `/sync/${ws}/work-references/make`, jsonBody({target})));
    const first = await json(await make());
    expect(first.reference).toBe(ref);
    expect((await json(await make())).reference).toBe(first.reference);
    expect((await handler(request("stranger", `/sync/${ws}/work-references/make`, jsonBody({target})))).status).toBe(404);
  });

  it("makes a server reference when no device has one", async () => {
    const {handler} = await fixture();
    const made = await json(await handler(request("owner", `/sync/${ws}/work-references/make`, jsonBody({target}))));
    expect(made.reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await json(await handler(request("owner", `/sync/work-references/${made.reference}`)))).toMatchObject({status: "found", target});
  });

  it("keeps unknown, deleted, and forbidden responses identical and retains the deletion scope", async () => {
    const {handler, storage} = await fixture();
    await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: ref, target, createdAtMs: 1}]})));
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

  it("registers a target atomically with a message and rejects unregistered mentions", async () => {
    const {handler} = await fixture();
    const ops = sequenced([
      chatChannelCreate("group"), chatThreadCreate("thread", "group"),
      chatMessageAppend("message", "thread", `See @[work:${ref}]`, {authorUserId: "owner"}),
    ]);
    const post = (workReferences: unknown[]) => handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "chat-device", ops, workReferences})));
    expect((await post([])).status).toBe(404);
    expect((await post([{reference: ref, target, createdAtMs: 1}])).status).toBe(200);
    expect((await post([{reference: ref, target, createdAtMs: 1}])).status).toBe(200);
    expect((await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: "C".repeat(43), target: {kind: "message", messageId: "message", threadId: "forged", channelId: "channel-group"}, createdAtMs: 1}]})))).status).toBe(404);
  });

  it("does not resolve a pinned version through a grant on another version", async () => {
    const {handler} = await fixture();
    await appendLog(handler, "owner", ws, [moment("notes/plan.md", "Plan", {originSeq: 1, objectId: "plan", versionId: "draft"})], {originId: "device"});
    const pinned = {...target, versionId: "draft"};
    await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: ref, target: pinned, createdAtMs: 1}]})));
    await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view", versionId: "main"});
    expect((await handler(request("reader", `/sync/work-references/${ref}`))).status).toBe(404);
    expect(await json(await handler(request("owner", `/sync/work-references/${ref}`)))).toMatchObject({status: "found", target: pinned});
  });

  it("requires the reader's own received token when minting through a share", async () => {
    const {handler} = await fixture();
    await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: ref, target, createdAtMs: 1}]})));
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const otherShare = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "other", access: "view"});
    const found = await json(await handler(request("reader", `/sync/work-references/${ref}`)));
    const make = (user: string, share: string, binding: unknown) => handler(request(user, `/sync/shares/${share}/work-references/make`, jsonBody({target: binding})));
    expect(await json(await make("reader", shareId, found.target))).toMatchObject({reference: ref, target: found.target});
    expect((await make("reader", shareId, target)).status).toBe(404);
    expect((await make("other", otherShare, found.target)).status).toBe(404);
    expect((await handler(request("reader", `/sync/work-references/${ref}`, {headers: {cookie: "session=ignored"}}))).status).toBe(404);
  });

  it("bounds mapping pages and binds opaque cursors to the reader and share", async () => {
    const {handler} = await fixture();
    const bindings = Array.from({length: 129}, (_, index) => ({
      reference: index.toString().padStart(43, "0"), target, createdAtMs: 1,
    }));
    for (const references of [bindings.slice(0, 128), bindings.slice(128)]) {
      expect((await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references})))).status).toBe(200);
    }
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const otherShare = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "other", access: "view"});
    const hiddenShare = await createShare(handler, "owner", ws, {paths: ["private"], recipientUserId: "hidden", access: "view"});
    const page = await json(await handler(request("reader", `/sync/shares/${shareId}/work-references`)));
    expect(page.references).toHaveLength(128);
    expect(page.nextAfter).toBeTypeOf("string");
    expect(page.nextAfter).not.toBe(bindings[127]!.reference);
    const query = `?after=${encodeURIComponent(String(page.nextAfter))}`;
    expect(await json(await handler(request("reader", `/sync/shares/${shareId}/work-references${query}`))))
      .toMatchObject({references: [{reference: bindings[128]!.reference}], nextAfter: null});
    expect((await handler(request("other", `/sync/shares/${otherShare}/work-references${query}`))).status).toBe(404);
    expect((await handler(request("reader", `/sync/shares/${shareId}/work-references?after=forged`))).status).toBe(404);
    expect(await json(await handler(request("hidden", `/sync/shares/${hiddenShare}/work-references`))))
      .toMatchObject({references: []});
  });

  it("resolves version snapshots and rechecks link sessions and grant revocation", async () => {
    const {handler, storage} = await fixture();
    const sha = await putBlob(handler, "owner", ws, "Snapshot");
    await appendLog(handler, "owner", ws, [{originSeq: 0, opKind: "version.create", recordedAtMs: 2,
      payload: {versionId: "fork", forkSnapshots: [{path: "notes/fork.md", objectId: "snapshot-object", blobSha256: sha}]},
    }], {originId: "fork-device"});
    const pinned = {...target, versionId: "fork", objectId: "snapshot-object"};
    expect((await handler(request("owner", `/sync/${ws}/work-references`, jsonBody({references: [{reference: ref, target: pinned, createdAtMs: 2}]})))).status).toBe(200);
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view", versionId: "fork"});
    const token = "L".repeat(43);
    seedLinkGrant(storage, {shareId, grantId: "link-grant", secretHash: hashLinkBearer("secret", LINK_KEY)});
    seedLinkSession(storage, {grantId: "link-grant", capabilityHash: hashLinkBearer(token, LINK_KEY)});
    const found = await json(await handler(linkRequest(token, `/sync/work-references/${ref}`)));
    expect(found).toMatchObject({status: "found", target: {versionId: "fork"}});
    expect(JSON.stringify(found)).not.toContain("snapshot-object");
    expect((await handler(linkRequest("X".repeat(43), `/sync/work-references/${ref}`))).status).toBe(404);
    expect((await handler(linkRequest(token, `/sync/shares/${shareId}/work-references`, jsonBody({references: []})))).status).toBe(404);
    storage.revokeShareGrant({shareId, grantId: "link-grant", revokedAtMs: 3});
    expect(await denialBytes(await handler(linkRequest(token, `/sync/work-references/${ref}`)))).toBe(
      await denialBytes(await handler(request("owner", `/sync/work-references/${"Z".repeat(43)}`))),
    );
  });
});
