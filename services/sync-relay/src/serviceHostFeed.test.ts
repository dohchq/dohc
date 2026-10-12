import {afterEach, expect, it} from "vitest";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostFeedRoute} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {hostedRowDecision, hostedWriteAllowed} from "./serviceHostFeed";
import {parseLogOp} from "./relayLogInputs";
import {referencedBlobShas} from "./storage/blobReferences";
import nativeAuthoredSettlement from "./testing/fixtures/nativeAuthoredSettlement.json";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const key = new Uint8Array(32).fill(17), namespace = "service-feed-test";
const identity = "replicationEpoch=epoch&streamIdentity=stream";
const ws = scope.workspaceId;

type Op = {relaySeq: number; originId: string; originSeq: number; opKind: string; payload: Record<string, unknown>};
type Page = {scope: {token: string; documents: Array<{objectId: string; path: string}>}; ops: Op[]; nextCursor: number; hasMore: boolean};

const blob = (text: string) => {
  const content = new Uint8Array(new TextEncoder().encode(text));
  return {content, sha256: sha256Hex(content)};
};
const A = blob("hosted a"), B = blob("hosted b"), C = blob("view c"), P = blob("private secret"), Y = blob("ydoc a"), YP = blob("ydoc private");

type Blob = ReturnType<typeof blob>;
function write(objectId: string, path: string, after: Blob, extra: Record<string, unknown> = {}) {
  return {momentId: `moment-${objectId}-${path}`, objectId, versionId: "main", operation: "write", path, payloadAfterPath: path,
    payloadAfterBlobSha256: after.sha256, payloadAfterByteLength: after.content.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1, ...extra};
}
function rename(objectId: string, from: string, to: string, content: Blob) {
  return {momentId: `moment-${objectId}-${to}`, objectId, versionId: "main", operation: "rename", path: to, beforePath: from,
    payloadBeforePath: from, payloadBeforeBlobSha256: content.sha256, payloadAfterPath: to, payloadAfterBlobSha256: content.sha256,
    payloadAfterByteLength: content.content.byteLength, payloadAfterContentKind: "text", recordedAtMs: 2};
}
function ydoc(objectId: string, path: string, update: {sha256: string}) {
  return {versionId: "main", objectId, path, contentKind: "richdoc", updateBlobSha256: update.sha256, isBaseState: false, lineageClaimId: binding.lineageClaimId};
}

async function fixture() {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: ws, replicationEpoch: "epoch", streamIdentity: "stream"});
  for (const {sha256, content} of [A, B, C, P, Y, YP]) f.storage.putBlob({workspaceId: ws, sha256, content, createdAtMs: 1});
  let ownerSeq = 0;
  const append = (...payloads: Array<[string, Record<string, unknown>]>) => f.storage.appendLogBatch({workspaceId: ws, originId: "owner-device",
    ops: payloads.map(([opKind, payload]) => parseLogOp({originSeq: ownerSeq++, opKind, recordedAtMs: 1, payload}))});
  append(["workspace.init", {}],
    ["moment.append", write(binding.objectId, "docs/a.md", A)],
    ["moment.append", write("object-private", "private/secret.md", P)],
    ["moment.append", write("object-view", "view/c.md", C)],
    ["moment.append", write("object-b", "docs/b.md", B)],
    ["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)],
    ["ydoc.update", ydoc("object-private", "private/secret.md", YP)]);
  const share = (shareId: string, paths: string[], access: string) => {
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, ws, JSON.stringify({paths, versionId: null}));
    f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','reader-2',NULL,?,1,'active',0,NULL,NULL)`).run(`grant-${shareId}`, shareId, access);
  };
  const setGrant = (shareId: string, change: string) => f.raw.prepare(`UPDATE sync_relay_share_grants SET ${change} WHERE share_id=?`).run(shareId);
  const enroll = (path: string, shareId = scope.shareId) => f.storage.enrollServiceHostDocument({workspaceId: ws, ownerUserId: "owner-1", shareId, path, nowMs: 10, guard() {}});
  const bearer = deriveServiceHostBearer(enroll("docs/a.md"), {key, namespace});
  const handle = createServiceHostReplication({storage: f.storage, prefix: "dohc-service-v1.", hostedFeed: true,
    authorize: input => authorizeServiceHostReplication(f.storage, {key, namespace, ...input})});
  const request = (method: string, suffix: string, body?: BodyInit, contentType = "application/json") => handle(new Request(`https://relay.test/sync/${ws}/hosted/${suffix}`,
    {method, headers: {authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : {"content-type": contentType})}, ...(body === undefined ? {} : {body})}));
  const page = async (query = "") => {
    const response = await request("GET", `log?${identity}${query}`);
    expect(response.status).toBe(200);
    return await response.json() as Page;
  };
  // Reads the scope, then the feed under it.
  const read = async (query = "") => {
    const {scope: current} = await page();
    return page(`&scope=${current.token}${query}`);
  };
  const push = (ops: Array<[string, Record<string, unknown>]>, firstSeq = 0) => request("POST", "log", JSON.stringify({replicationEpoch: "epoch",
    streamIdentity: "stream", originId: "native-service", ops: ops.map(([opKind, payload], index) => ({originSeq: firstSeq + index, opKind, recordedAtMs: 3, payload}))}));
  const blobStatus = async (sha256: string) => (await request("GET", `blobs/${sha256}`)).status;
  const objects = (feed: Page) => [...new Set(feed.ops.map(op => op.opKind === "workspace.init" ? "workspace" : String(op.payload.objectId)))];
  return {...f, append, share, setGrant, enroll, request, page, read, push, blobStatus, objects};
}

it("serves hosted rows unchanged and refuses private files, their blobs and coordinates", async () => {
  const f = await fixture();
  const first = await f.page();
  expect(first.ops).toEqual([]);
  expect(first.scope.documents).toEqual([{objectId: binding.objectId, path: "docs/a.md"}]);
  const feed = await f.read();
  expect(f.objects(feed)).toEqual(["workspace", binding.objectId]);
  expect(feed.ops.map(op => op.opKind)).toEqual(["workspace.init", "moment.append", "ydoc.update"]);
  // Identity survives: the host needs the object, moment and lineage coordinates.
  expect(feed.ops[1]!.payload).toEqual(write(binding.objectId, "docs/a.md", A));
  expect(feed.ops[1]).toMatchObject({originId: "owner-device", originSeq: 1});
  expect(feed.ops[2]!.payload).toEqual(ydoc(binding.objectId, "docs/a.md", Y));
  // The cursor passes the private rows it withheld.
  expect(feed.nextCursor).toBeGreaterThan(feed.ops.at(-1)!.relaySeq);
  expect(feed.hasMore).toBe(false);
  expect(JSON.stringify(feed)).not.toMatch(/secret|object-private|object-view|object-b/);

  for (const sha256 of [A.sha256, Y.sha256]) expect(await f.blobStatus(sha256)).toBe(200);
  for (const sha256 of [P.sha256, YP.sha256, B.sha256, C.sha256]) expect(await f.blobStatus(sha256)).toBe(404);
  const absent = "f".repeat(64);
  const have = await f.request("POST", "blobs/have", JSON.stringify({sha256s: [A.sha256, P.sha256, absent]}));
  expect(await have.json()).toEqual({ok: true, missing: [P.sha256, absent]});
  // Uploading bytes does not reveal whether the owner already held them.
  const put = async (content: Uint8Array<ArrayBuffer>, sha256: string) => (await f.request("PUT", `blobs/${sha256}`, content, "application/octet-stream")).json();
  expect(await put(P.content, P.sha256)).toMatchObject({alreadyHad: false});
  expect(await put(A.content, A.sha256)).toMatchObject({alreadyHad: true});

  const coordinate = async (seq: number) => (await f.request("GET", `log/owner-device/${seq}?${identity}`)).json();
  expect(await coordinate(1)).toMatchObject({status: "present", op: {payload: write(binding.objectId, "docs/a.md", A)}});
  expect(await coordinate(2)).toEqual({ok: true, status: "absent"});
  expect(await coordinate(6)).toEqual({ok: true, status: "absent"});
});

it("keeps documents shared only with View or Comment access out of the feed", async () => {
  const f = await fixture();
  f.share("view-share", ["view"], "view");
  f.enroll("view/c.md", "view-share");
  expect((await f.page()).scope.documents.map(row => row.objectId)).toEqual([binding.objectId]);
  expect(f.objects(await f.read())).not.toContain("object-view");
  expect(await f.blobStatus(C.sha256)).toBe(404);
  f.setGrant("view-share", "access='comment'");
  expect(f.objects(await f.read())).not.toContain("object-view");
  f.setGrant("view-share", "access='edit'");
  expect(f.objects(await f.read())).toContain("object-view");
  expect(await f.blobStatus(C.sha256)).toBe(200);
});

it("serves the union of overlapping Edit grants until the last covering grant is revoked", async () => {
  const f = await fixture();
  f.share("single-share", ["docs/a.md"], "edit");
  f.enroll("docs/b.md");
  expect(f.objects(await f.read())).toEqual(["workspace", binding.objectId, "object-b"]);
  f.setGrant(scope.shareId, "status='revoked',revoked_at_ms=20");
  expect(f.objects(await f.read())).toEqual(["workspace", binding.objectId]);
  expect(await f.blobStatus(B.sha256)).toBe(404);
  f.setGrant("single-share", "status='revoked',revoked_at_ms=20");
  const empty = await f.read();
  expect(empty.scope.documents).toEqual([]);
  expect(f.objects(empty)).toEqual(["workspace"]);
  expect(await f.blobStatus(A.sha256)).toBe(404);
});

it("announces a grown scope before any row and backfills the new document below the cursor", async () => {
  const f = await fixture();
  const before = await f.read();
  const cursor = before.nextCursor;
  f.enroll("docs/b.md");
  // The old scope serves nothing, so the reader cannot pass the new document's rows.
  const stale = await f.page(`&scope=${before.scope.token}&since=${cursor}`);
  expect(stale.ops).toEqual([]);
  expect(stale.nextCursor).toBe(cursor);
  expect(stale.scope.token).not.toBe(before.scope.token);
  expect(stale.scope.documents.map(row => row.objectId)).toEqual([binding.objectId, "object-b"]);
  expect((await f.page(`&scope=${stale.scope.token}&since=${cursor}`)).ops).toEqual([]);
  const backfill = await f.page(`&scope=${stale.scope.token}&since=0&object=object-b`);
  expect(backfill.ops.map(op => [op.opKind, op.payload.objectId])).toEqual([["moment.append", "object-b"]]);
  const refused = await f.request("GET", `log?${identity}&scope=${stale.scope.token}&object=object-private`);
  expect(refused.status).toBe(400);
});

it("follows a document across the share boundary by enrollment, never by path alone", async () => {
  const f = await fixture();
  f.enroll("docs/b.md");
  f.append(["moment.append", rename("object-b", "docs/b.md", "private/b.md", B)]);
  const moved = await f.read();
  expect(moved.scope.documents.map(row => row.objectId)).toEqual([binding.objectId]);
  expect(f.objects(moved)).not.toContain("object-b");
  expect(await f.blobStatus(B.sha256)).toBe(404);
  f.append(["moment.append", rename("object-private", "private/secret.md", "docs/secret.md", P)]);
  expect(f.objects(await f.read())).not.toContain("object-private");
  // Once enrolled, the document's own lineage includes where it lived before.
  f.enroll("docs/secret.md");
  const joined = await f.read();
  expect(joined.ops.filter(op => op.payload.objectId === "object-private").map(op => op.payload.path))
    .toEqual(["private/secret.md", "private/secret.md", "docs/secret.md"]);
});

it("refuses writes outside the hosted documents and lets accepted edits settle after revocation", async () => {
  const f = await fixture();
  const update = blob("settled update");
  expect((await f.request("PUT", `blobs/${update.sha256}`, update.content, "application/octet-stream")).status).toBe(200);
  const refused = async (ops: Array<[string, Record<string, unknown>]>) => {
    const response = await f.push(ops);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code: "share_op_rejected"});
  };
  await refused([["moment.append", write("object-private", "private/secret.md", update)]]);
  await refused([["ydoc.update", ydoc("object-private", "private/secret.md", update)]]);
  await refused([["moment.append", rename(binding.objectId, "docs/a.md", "docs/moved.md", A)]]);
  await refused([["moment.append", {...write(binding.objectId, "docs/a.md", update), operation: "delete"}]]);
  await refused([["moment.append", write(binding.objectId, "docs/a.md", update, {beforeObjectId: "object-private"})]]);
  await refused([["ydoc.update", {...ydoc(binding.objectId, "docs/a.md", update), path: "docs/b.md"}]]);
  await refused([["workspace.init", {}]]);
  await refused([["chat.channel.create", {wireId: "general", kind: "channel"}]]);
  await refused([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)], ["version.create", {versionId: "branch", forkSnapshots: []}]]);
  expect(f.storage.fetchLogCoordinate({workspaceId: ws, originId: "native-service", originSeq: 0})).toBeNull();

  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]])).status).toBe(200);
  f.setGrant(scope.shareId, "status='revoked',revoked_at_ms=20");
  expect(f.objects(await f.read())).toEqual(["workspace"]);
  expect(await f.blobStatus(update.sha256)).toBe(404);
  // Still enrolled: work the relay accepted before revocation can settle.
  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]], 1)).status).toBe(200);
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]], 2)).status).toBe(404);
});

it("rechecks the write scope under the append's writer", async () => {
  const f = await fixture();
  const update = blob("raced update");
  f.storage.putBlob({workspaceId: ws, sha256: update.sha256, content: update.content, createdAtMs: 1});
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  // The rename lands after the route's first check and before the append.
  f.storage.prepareLogAppend = async (...args) => {
    f.append(["moment.append", rename(binding.objectId, "docs/a.md", "private/a.md", A)]);
    return prepare(...args);
  };
  const response = await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]]);
  expect(response.status).toBe(403);
  expect(f.storage.fetchLogCoordinate({workspaceId: ws, originId: "native-service", originSeq: 0})).toBeNull();
});

it("admits the engine's own settlement batch for its hosted document, both ways", () => {
  const settlement = nativeAuthoredSettlement.find(op => op.opKind === "live.audit.settlement")!;
  const document = (settlement.payload as {record: {binding: {workspaceId: string; objectId: string; currentPath: string}}}).record.binding;
  const held = new Map([[document.objectId, document.currentPath]]);
  const hosted = {workspaceId: document.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream", hosted: held, shared: held, token: "token"};
  for (const op of nativeAuthoredSettlement) {
    expect(hostedWriteAllowed(hosted, op.opKind, op.payload), op.opKind).toBe(true);
    const row = {opKind: op.opKind, payloadJson: JSON.stringify(op.payload), recordedAtMs: op.recordedAtMs};
    expect(hostedRowDecision(hosted, row), op.opKind).toEqual({allowed: true, objectId: document.objectId,
      blobSha256s: referencedBlobShas(op.opKind, row.payloadJson, {workspaceId: document.workspaceId, recordedAtMs: op.recordedAtMs})});
  }
  const other = {...hosted, workspaceId: "other-workspace"};
  expect(hostedWriteAllowed(other, settlement.opKind, settlement.payload)).toBe(false);
  const unhosted = {...hosted, hosted: new Map<string, string>(), shared: new Map<string, string>()};
  for (const op of nativeAuthoredSettlement) expect(hostedWriteAllowed(unhosted, op.opKind, op.payload), op.opKind).toBe(false);
});

it("authorizes the hosted routes only for the replication shapes", () => {
  const route = (method: string, suffix: string) => serviceHostFeedRoute({workspaceId: ws, method, pathname: `/sync/${ws}/hosted/${suffix}`});
  for (const [method, suffix] of [["GET", "bootstrap"], ["GET", "log"], ["POST", "log"], ["GET", "log/owner/0"],
    ["GET", `blobs/${"a".repeat(64)}`], ["PUT", `blobs/${"a".repeat(64)}`], ["POST", "blobs/have"]]) expect(route(method!, suffix!)).toBe(true);
  for (const [method, suffix] of [["POST", "epoch"], ["GET", "live-host"], ["PUT", "blobs/have"], ["GET", "hosted/log"], ["DELETE", "log"]]) {
    expect(route(method!, suffix!)).toBe(false);
  }
  expect(serviceHostFeedRoute({workspaceId: ws, method: "GET", pathname: "/sync/other/hosted/log"})).toBe(false);
});
