import type {StorageContext} from "./storage/context";
import {afterEach, describe, expect, it, vi} from "vitest";
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

  it("reuses a device reference when the server needs one", async () => {
    const {handler} = await fixture();
    await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: ref, target, createdAtMs: 1}]})));
    const make = () => handler(request("owner", `/sync/internal/work-references`, mintBody(target)));
    const first = await json(await make());
    expect(first.reference).toBe(ref);
    expect((await json(await make())).reference).toBe(first.reference);
    expect((await handler(request("stranger", `/sync/internal/work-references`, mintBody(target)))).status).toBe(404);
  });

  it("makes a server reference when no device has one", async () => {
    const {handler} = await fixture();
    const made = await json(await handler(request("owner", `/sync/internal/work-references`, mintBody(target))));
    expect(made.reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await json(await handler(request("owner", `/sync/work-references/${made.reference}`)))).toMatchObject({status: "found", target});
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

  it("registers a target atomically with a message and accepts unavailable mentions", async () => {
    const {handler} = await fixture();
    const ops = sequenced([
      chatChannelCreate("group"), chatThreadCreate("thread", "group"),
      chatMessageAppend("message", "thread", `See @[work:${ref}]`, {authorUserId: "owner"}),
    ]);
    const post = (workReferences: unknown[]) => handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "chat-device", ops, workReferences})));
    expect((await post([])).status).toBe(200);
    expect((await post([{reference: ref, target, createdAtMs: 1}])).status).toBe(200);
    expect((await post([{reference: ref, target, createdAtMs: 1}])).status).toBe(200);
    expect(await json(await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: [{reference: "C".repeat(43), target: {kind: "message", messageId: "message", threadId: "forged", channelId: "channel-group"}, createdAtMs: 1}]}))))).toMatchObject({registeredReferences: []});
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

  it("bounds mapping pages and binds opaque cursors to the reader and share", async () => {
    const {handler} = await fixture();
    const bindings = Array.from({length: 129}, (_, index) => ({
      reference: index.toString().padStart(43, "0"), target, createdAtMs: 1,
    }));
    for (const references of [bindings.slice(0, 128), bindings.slice(128)]) {
      expect((await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "reference-probe", ops: [], workReferences: references})))).status).toBe(200);
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
      .toMatchObject({references: [{reference: bindings[128]!.reference}], hasMore: false});
    expect((await handler(request("other", `/sync/shares/${otherShare}/work-references${query}`))).status).toBe(404);
    expect((await handler(request("reader", `/sync/shares/${shareId}/work-references?after=forged`))).status).toBe(404);
    expect(await json(await handler(request("hidden", `/sync/shares/${hiddenShare}/work-references`))))
      .toMatchObject({references: [], nextAfter: expect.any(String), hasMore: false});
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

  it("keeps mixed and empty recipient cursors fixed-width and skips scanned hidden rows", async () => {
    const {handler, storage} = await fixture();
    await appendLog(handler, "owner", ws, [moment("private/hidden.md", "Plan", {originSeq: 1, objectId: "hidden", momentId: "hidden-write"})], {originId: "device"});
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const read = (after?: string) => handler(request("reader", `/sync/shares/${shareId}/work-references${after ? `?after=${encodeURIComponent(after)}` : ""}`)).then(json) as Promise<ReferencePage>;
    const empty = await read();
    await register(handler, [{reference: ref, target, createdAtMs: 1}]);
    const one = await read();
    for (let start = 0; start < 500; start += 128) {
      await register(handler, Array.from({length: Math.min(128, 500 - start)}, (_, i) => ({reference: String(start + i).padStart(43, "0"), target: {...target, objectId: "hidden"}, createdAtMs: 1})));
    }
    const mixed = await read();
    expect(mixed.references).toEqual(one.references);
    expect(mixed.hasMore).toBe(false);
    expect(await read()).toEqual(mixed);
    expect(mixed.nextAfter.length).toBe(one.nextAfter.length);
    expect(empty.nextAfter.length).toBe(one.nextAfter.length);
    const objects = vi.spyOn(storage, "objectMoment");
    try {
      const caughtUp = await read(mixed.nextAfter);
      expect(caughtUp).toMatchObject({references: [], hasMore: false});
      expect(caughtUp.nextAfter.length).toBe(empty.nextAfter.length);
      expect(objects).not.toHaveBeenCalled();
    } finally { objects.mockRestore(); }
  });

  it("caps a recipient scan at 1024 rows and continues from its hidden tail", async () => {
    const {handler, storage} = await fixture();
    const shareId = await createShare(handler, "owner", ws, {paths: ["private"], recipientUserId: "reader", access: "view"});
    for (let start = 0; start < 1100; start += 128) {
      await register(handler, Array.from({length: Math.min(128, 1100 - start)}, (_, i) => ({reference: String(start + i).padStart(43, "0"), target, createdAtMs: 1})));
    }
    await appendLog(handler, "owner", ws, [moment("private/visible.md", "Plan", {originSeq: 1, objectId: "visible", momentId: "visible-write"})], {originId: "device"});
    await register(handler, [{reference: ref, target: {...target, objectId: "visible"}, createdAtMs: 1}]);
    const objects = vi.spyOn(storage, "objectMoment");
    try {
      const first = await json(await handler(request("reader", `/sync/shares/${shareId}/work-references`)));
      expect(first).toMatchObject({references: [], hasMore: true});
      expect(objects).toHaveBeenCalledTimes(1024);
      const second = await json(await handler(request("reader", `/sync/shares/${shareId}/work-references?after=${first.nextAfter}`)));
      expect(second).toMatchObject({references: [{reference: ref}], hasMore: false});
    } finally { objects.mockRestore(); }
  });

  it("resends a binding moved into a share after its saved cursor", async () => {
    const {handler} = await fixture();
    await register(handler, [{reference: ref, target, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {paths: ["private"], recipientUserId: "reader", access: "view"});
    const first = await json(await handler(request("reader", `/sync/shares/${shareId}/work-references`)));
    expect(first.references).toEqual([]);
    await appendLog(handler, "owner", ws, [moment("private/plan.md", "Plan", {originSeq: 1, objectId: "plan", momentId: "move-plan", operation: "rename", beforePath: "notes/plan.md", beforeContent: "Plan", afterPath: "private/plan.md", afterContent: "Plan"})], {originId: "device"});
    expect(await json(await handler(request("reader", `/sync/shares/${shareId}/work-references?after=${first.nextAfter}`))))
      .toMatchObject({references: [{reference: ref, target: {kind: "file"}}], hasMore: false});
  });

  it.each(["selector", "generation"] as const)("restarts a recipient cursor when only its %s changes", async change => {
    const {handler, storage} = await fixture();
    await register(handler, [{reference: ref, target, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {paths: [change === "selector" ? "private" : "notes"], recipientUserId: "reader", access: "view"});
    const path = `/sync/shares/${shareId}/work-references`;
    const first = await json(await handler(request("reader", path)));
    expect(first.references).toHaveLength(change === "selector" ? 0 : 1);
    storage.tx(() => {
      if (change === "selector") {
        const selector = storage.db.prepare("SELECT selector_json FROM sync_relay_shares WHERE share_id=?").get(shareId)!;
        storage.db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
          .run(JSON.stringify({...JSON.parse(String(selector.selector_json)), paths: ["notes"]}), shareId);
      } else storage.db.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE share_id=?").run(shareId);
    });
    expect(await json(await handler(request("reader", `${path}?after=${first.nextAfter}`))))
      .toMatchObject({references: [{reference: ref}], hasMore: false});
  });

  it("advances a cursor across only hidden rows without scanning them twice", async () => {
    const {handler, storage} = await fixture();
    const shareId = await createShare(handler, "owner", ws, {paths: ["private"], recipientUserId: "reader", access: "view"});
    for (let start = 0; start < 500; start += 128) {
      await register(handler, Array.from({length: Math.min(128, 500 - start)}, (_, i) => ({reference: String(start + i).padStart(43, "0"), target, createdAtMs: 1})));
    }
    const objects = vi.spyOn(storage, "objectMoment");
    try {
      const first = await json(await handler(request("reader", `/sync/shares/${shareId}/work-references`))) as ReferencePage;
      expect(first).toMatchObject({references: [], hasMore: false});
      expect(first.nextAfter).toHaveLength(144);
      expect(objects).toHaveBeenCalledTimes(500);
      objects.mockClear();
      const second = await json(await handler(request("reader", `/sync/shares/${shareId}/work-references?after=${first.nextAfter}`)));
      expect(second).toMatchObject({references: [], hasMore: false});
      expect(second.nextAfter).toHaveLength(first.nextAfter.length);
      expect(objects).not.toHaveBeenCalled();
    } finally { objects.mockRestore(); }
  });

  it("accepts an empty referenceAfter on owner and share log routes", async () => {
    const {handler} = await fixture();
    await register(handler, [{reference: ref, target, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    for (const [user, path] of [["owner", `/sync/${ws}/log`], ["reader", `/sync/shares/${shareId}/log`]]) {
      const response = await handler(request(user!, `${path}?since=0&referenceAfter=`));
      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({workReferences: [{reference: ref}]});
    }
  });

  it("accepts an empty after on owner and share listing routes", async () => {
    const {handler} = await fixture();
    await register(handler, [{reference: ref, target, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    for (const [user, path] of [["owner", `/sync/${ws}/work-references`], ["reader", `/sync/shares/${shareId}/work-references`]]) {
      const response = await handler(request(user!, `${path}?after=`));
      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({references: [{reference: ref}]});
    }
  });

  it("lists share mappings only on the final log page", async () => {
    const {handler, storage} = await fixture();
    await appendLog(handler, "owner", ws, [moment("notes/later.md", "Plan", {originSeq: 1, objectId: "later", momentId: "later-write"})], {originId: "device"});
    await register(handler, [{reference: ref, target: {...target, objectId: "later"}, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const list = vi.spyOn(storage, "listWorkReferences");
    try {
      const first = await json(await handler(request("reader", `/sync/shares/${shareId}/log?since=0&limit=1&referenceAfter=`)));
      expect(first.hasMore).toBe(true);
      expect(first.workReferences).toBeUndefined();
      expect(list).not.toHaveBeenCalled();
      const last = await json(await handler(request("reader", `/sync/shares/${shareId}/log?since=${first.nextCursor}&referenceAfter=`)));
      expect(last).toMatchObject({hasMore: false, workReferences: [{reference: ref}]});
      expect(list).toHaveBeenCalledTimes(1);
    } finally { list.mockRestore(); }
  });

  it("lists owner bindings without probing their targets", async () => {
    const {handler, storage} = await fixture();
    const datasetTarget = {kind: "transactionalCollection", datasetId: "00000000-0000-4000-8000-000000000001", tableId: "00000000-0000-4000-8000-000000000002"};
    await register(handler, [{reference: ref, target, createdAtMs: 1}, {reference: "D".repeat(43), target: datasetTarget, createdAtMs: 1}]);
    const dataset = vi.fn(async () => { throw new Error("owner listing must not read dataset targets"); });
    storage.workReferenceDatasetAccess = dataset;
    const objects = vi.spyOn(storage, "objectMoment");
    try {
      const response = await handler(request("owner", `/sync/${ws}/work-references`));
      expect(response.status).toBe(200);
      const page = await json(response) as ReferencePage;
      expect(page.references.map((mapping: {reference: string}) => mapping.reference)).toEqual([ref, "D".repeat(43)]);
      expect(page.references.every((mapping: object) => !("deleted" in mapping))).toBe(true);
      expect(objects).not.toHaveBeenCalled();
      expect(dataset).not.toHaveBeenCalled();
    } finally { objects.mockRestore(); }
  });

  it("mints through a link using the message's non-null canonical channel binding", async () => {
    const {handler, storage} = await fixture();
    await appendLog(handler, "owner", ws, sequenced([
      chatChannelCreate("group", {type: "both", folderPath: "notes"}), chatThreadCreate("thread", "group"),
      chatMessageAppend("message", "thread", "Plan", {authorUserId: "owner"}),
    ]), {originId: "chat-device"});
    const message = {kind: "message", messageId: "message", threadId: "thread", channelId: "channel-group"};
    await register(handler, [{reference: ref, target: message, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {channelWireId: "group", paths: ["notes"], recipientUserId: "reader", access: "read-only"});
    const token = "L".repeat(43);
    seedLinkGrant(storage, {shareId, grantId: "channel-link", access: "read-only", secretHash: hashLinkBearer("secret", LINK_KEY)});
    seedLinkSession(storage, {grantId: "channel-link", capabilityHash: hashLinkBearer(token, LINK_KEY)});
    const resolved = await handler(linkRequest(token, `/sync/work-references/${ref}`));
    expect(resolved.status).toBe(200);
    const projected = await json(resolved);
    expect(projected.target).toEqual({kind: "message", messageId: "message", threadId: "thread"});
    const minted = await handler(linkRequest(token, "/sync/internal/work-references", mintBody(projected.target)));
    expect(minted.status).toBe(200);
    expect(await json(minted)).toMatchObject({reference: ref, target: projected.target});
    expect(await json(await handler(request("owner", `/sync/work-references/${ref}`)))).toMatchObject({target: message});
  });

  it("omits the local channel id for file-share and link message readers", async () => {
    const {handler, storage} = await fixture();
    await appendLog(handler, "owner", ws, sequenced([
      chatChannelCreate("group"), chatThreadCreate("thread", "group", {linkedObjectId: "plan", linkedPathHint: "notes/plan.md"}),
      chatMessageAppend("message", "thread", "Plan", {authorUserId: "owner"}),
    ]), {originId: "chat-device"});
    const message = {kind: "message", messageId: "message", threadId: "thread", channelId: null};
    await register(handler, [{reference: ref, target: message, createdAtMs: 1}]);
    const shareId = await createShare(handler, "owner", ws, {paths: ["notes"], recipientUserId: "reader", access: "view"});
    const token = "L".repeat(43);
    seedLinkGrant(storage, {shareId, grantId: "message-link", secretHash: hashLinkBearer("secret", LINK_KEY)});
    seedLinkSession(storage, {grantId: "message-link", capabilityHash: hashLinkBearer(token, LINK_KEY)});
    for (const response of [await handler(request("reader", `/sync/work-references/${ref}`)), await handler(linkRequest(token, `/sync/work-references/${ref}`))]) {
      expect(response.status).toBe(200);
      const found = await json(response);
      expect(found.target).toEqual({kind: "message", messageId: "message", threadId: "thread"});
      expect(await json(await handler(request("reader", "/sync/internal/work-references", mintBody(found.target)))))
        .toMatchObject({reference: ref, target: found.target});
    }
    expect(await json(await handler(request("owner", `/sync/work-references/${ref}`)))).toMatchObject({target: message});
  });

  it("registers a new target in the same batch as its referencing message", async () => {
    const {handler} = await fixture();
    const fresh = {...target, objectId: "fresh"};
    const ops = [moment("notes/fresh.md", "Plan", {originSeq: 0, objectId: "fresh", momentId: "fresh-target"}), ...sequenced([
      chatChannelCreate("group"), chatThreadCreate("thread", "group"),
      chatMessageAppend("message", "thread", `@[work:${ref}]`, {authorUserId: "owner"}),
    ], 1)];
    const result = await json(await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "fresh-device", ops,
      workReferences: [{reference: ref, target: fresh, createdAtMs: 1}]}))));
    expect(result.registeredReferences).toEqual([ref]);
    expect(await json(await handler(request("owner", `/sync/work-references/${ref}`)))).toMatchObject({target: fresh});
  });

  it("acknowledges deleted targets, keeps their scope, and restores their live state", async () => {
    const {handler, storage} = await fixture();
    await appendLog(handler, "owner", ws, [moment("notes/plan.md", "", {originSeq: 1, objectId: "plan", operation: "delete", beforePath: "notes/plan.md", beforeContent: "Plan", afterPath: null, afterContent: null})], {originId: "device"});
    const references = Array.from({length: 129}, (_, i) => ({reference: String(i).padStart(43, "0"), target, createdAtMs: 1}));
    for (const batch of [references.slice(0, 128), references.slice(128)]) {
      expect(await json(await register(handler, batch))).toMatchObject({registeredReferences: batch.map(row => row.reference)});
    }
    expect(storage.db.prepare("SELECT count(*) AS n FROM sync_relay_work_reference_scopes WHERE deleted=1").get()!.n).toBe(129);
    expect(storage.db.prepare("SELECT last_path FROM sync_relay_work_reference_scopes LIMIT 1").get()!.last_path).toBe("notes/plan.md");
    const first = await json(await handler(request("owner", `/sync/${ws}/work-references`)));
    expect(first.references).toHaveLength(128);
    const deleted = await json(await handler(request("owner", `/sync/${ws}/work-references?after=${first.nextAfter}`)));
    expect(deleted.references).toMatchObject([{reference: references[128]!.reference}]);
    expect(deleted.hasMore).toBe(false);
    await appendLog(handler, "owner", ws, [moment("notes/plan.md", "Plan", {originSeq: 2, objectId: "plan", momentId: "restore-plan"})], {originId: "device"});
    const restored = await json(await handler(request("owner", `/sync/${ws}/work-references?after=${deleted.nextAfter}`))) as ReferencePage;
    expect(restored.references).toHaveLength(128);
    const tail = await json(await handler(request("owner", `/sync/${ws}/work-references?after=${restored.nextAfter}`))) as ReferencePage;
    expect([...restored.references, ...tail.references].map((mapping: {reference: string}) => mapping.reference).sort()).toEqual(references.map(mapping => mapping.reference).sort());
    expect(tail.hasMore).toBe(false);
    expect((await handler(request("owner", `/sync/work-references/${references[0]!.reference}`))).status).toBe(200);
  });

  it("accepts an offline deletion and foreign mention and a recipient channel post", async () => {
    const {handler} = await fixture();
    await claimWorkspace(handler, "foreign-owner", "foreign");
    await putBlob(handler, "foreign-owner", "foreign", "Plan");
    await appendLog(handler, "foreign-owner", "foreign", [moment("notes/plan.md", "Plan", {originSeq: 0, objectId: "plan"})]);
    expect((await handler(request("foreign-owner", "/sync/foreign/log", jsonBody({originId: "probe",ops:[],workReferences:[{reference:"Z".repeat(43),target,createdAtMs:1}]})))).status).toBe(200);
    const ops = [moment("notes/plan.md", "", {originSeq: 0, objectId: "plan", momentId: "offline-delete", operation: "delete", beforePath: "notes/plan.md", beforeContent: "Plan", afterPath: null, afterContent: null}), ...sequenced([
      chatChannelCreate("group"), chatThreadCreate("thread", "group"),
      chatMessageAppend("message", "thread", `@[work:${ref}] @[work:${"Z".repeat(43)}]`, {authorUserId: "owner"}),
    ], 1)];
    expect(await json(await handler(request("owner", `/sync/${ws}/log`, jsonBody({originId: "offline-device", ops,
      workReferences: [{reference: ref, target, createdAtMs: 1}]}))))).toMatchObject({registeredReferences: [ref]});
    const {shareId} = await json(await handler(request("owner", `/sync/${ws}/shares`, jsonBody({recipientUserId: "reader", channelWireId: "group", access: "read-write"}))));
    expect((await handler(request("reader", `/sync/shares/${shareId}/log`, jsonBody({originId: "recipient", ops: sequenced([
      chatMessageAppend("reply", "thread", `@[work:${"Z".repeat(43)}]`, {authorUserId: "reader"}),
    ])})))).status).toBe(200);
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

  it("keeps an incremental owner cursor when caught up and reads only later registrations", async () => {
    const {handler} = await fixture();
    await register(handler, [{reference: "Z".repeat(43), target, createdAtMs: 1}]);
    const first = await json(await handler(request("owner", `/sync/${ws}/work-references`)));
    expect(first).toMatchObject({references:[{reference:"Z".repeat(43)}],hasMore:false});
    const path = `/sync/${ws}/work-references?after=${first.nextAfter}`;
    expect(await json(await handler(request("owner", path)))).toEqual({references:[],nextAfter:first.nextAfter,hasMore:false});
    await register(handler, [{reference: ref, target, createdAtMs: 1}]);
    expect(await json(await handler(request("owner", path)))).toMatchObject({references:[{reference:ref}],hasMore:false});
  });

  it("acknowledges an offline record deletion without admitting a nonexistent record", async () => {
    const {handler, storage} = await fixture();
    const recordId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const text = `---\nid: ${recordId}\n---\nRecord`;
    await putBlob(handler,"owner",ws,"name: Tasks");
    await putBlob(handler,"owner",ws,text);
    await appendLog(handler,"owner",ws,[
      moment("Tasks/collection.yaml","name: Tasks",{originSeq:0,objectId:"schema",momentId:"schema-write"}),
      moment("Tasks/one.md",text,{originSeq:1,objectId:"record",momentId:"record-write"}),
      moment("Tasks/one.md","",{originSeq:2,objectId:"record",momentId:"record-delete",operation:"delete",beforePath:"Tasks/one.md",beforeContent:text,afterPath:null,afterContent:null}),
    ],{originId:"record-device"});
    const target = {kind:"documentRecord",versionId:"main",recordId};
    expect(await json(await register(handler,[{reference:ref,target,createdAtMs:1}]))).toMatchObject({registeredReferences:[ref]});
    expect(storage.db.prepare("SELECT deleted,last_path FROM sync_relay_work_reference_scopes WHERE reference=?").get(ref)).toMatchObject({deleted:1,last_path:"Tasks/one.md"});
    expect(await json(await register(handler,[{reference:"B".repeat(43),target:{...target,recordId:"rec_bbbbbbbbbbbbbbbbbbbbbbbbbb"},createdAtMs:1}]))).toMatchObject({registeredReferences:[]});
  });

});
