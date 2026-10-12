import {afterEach, expect, it, vi} from "vitest";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostFeedRoute} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {hostedRowDecision, hostedWriteAllowed} from "./serviceHostFeed";
import {parseLogOp, SERVICE_HOST_ORIGIN_PREFIX} from "./relayLogInputs";
import {referencedBlobShas} from "./storage/blobReferences";
import nativeAuthoredSettlement from "./testing/fixtures/nativeAuthoredSettlement.json";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const key = new Uint8Array(32).fill(17), namespace = "service-feed-test";
const identity = "replicationEpoch=epoch&streamIdentity=stream";
const ws = scope.workspaceId;
const HOST_ORIGIN = `${SERVICE_HOST_ORIGIN_PREFIX}native`;

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
  const push = (ops: Array<[string, Record<string, unknown>]>, firstSeq = 0, originId = HOST_ORIGIN) => request("POST", "log", JSON.stringify({replicationEpoch: "epoch",
    streamIdentity: "stream", originId, ops: ops.map(([opKind, payload], index) => ({originSeq: firstSeq + index, opKind, recordedAtMs: 3, payload}))}));
  const upload = async ({content, sha256}: Blob) => expect((await request("PUT", `blobs/${sha256}`, content, "application/octet-stream")).status).toBe(200);
  const blobStatus = async (sha256: string) => (await request("GET", `blobs/${sha256}`)).status;
  const hostCoordinate = (originSeq: number) => f.storage.fetchLogCoordinate({workspaceId: ws, originId: HOST_ORIGIN, originSeq});
  const objects = (feed: Page) => [...new Set(feed.ops.map(op => op.opKind === "workspace.init" ? "workspace" : String(op.payload.objectId)))];
  const uploads = () => f.raw.prepare("SELECT count(*) AS count FROM sync_relay_service_host_uploads WHERE workspace_id=?").get(ws)!.count;
  return {...f, handle, bearer, append, share, setGrant, enroll, request, page, read, push, upload, blobStatus, hostCoordinate, objects, uploads};
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
  await f.upload(update);
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
  expect(f.hostCoordinate(0)).toBeNull();

  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]])).status).toBe(200);
  f.setGrant(scope.shareId, "status='revoked',revoked_at_ms=20");
  expect(f.objects(await f.read())).toEqual(["workspace"]);
  // The owner's content goes; bytes the host uploaded itself are still its own.
  expect(await f.blobStatus(A.sha256)).toBe(404);
  expect(await f.blobStatus(update.sha256)).toBe(200);
  // Still enrolled: work the relay accepted before revocation can settle.
  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]], 1)).status).toBe(200);
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]], 2)).status).toBe(404);
});

it("rechecks the write scope under the append's writer", async () => {
  const f = await fixture();
  const update = blob("raced update");
  await f.upload(update);
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  // The rename lands after the route's first check and before the append.
  f.storage.prepareLogAppend = async (...args) => {
    f.append(["moment.append", rename(binding.objectId, "docs/a.md", "private/a.md", A)]);
    return prepare(...args);
  };
  const response = await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)]]);
  expect(response.status).toBe(403);
  expect(f.hostCoordinate(0)).toBeNull();
});

it("refuses a write naming a blob the host never fetched or uploaded, and keeps it unreadable", async () => {
  const f = await fixture();
  // The owner replaced a private file's content into the hosted document, so
  // the served row names the private bytes it withholds.
  const replacement = blob("replacement");
  f.storage.putBlob({workspaceId: ws, sha256: replacement.sha256, content: replacement.content, createdAtMs: 1});
  f.append(["moment.append", write(binding.objectId, "docs/a.md", replacement,
    {momentId: "replace", beforeObjectId: "object-private", beforePath: "private/secret.md", beforeBlobSha256: P.sha256})]);
  expect(JSON.stringify(await f.read())).toContain(P.sha256);
  expect(await f.blobStatus(P.sha256)).toBe(404);

  const own = blob("host edit");
  await f.upload(own);
  const named = (sha256: string) => [
    ["moment.append", write(binding.objectId, "docs/a.md", own, {payloadBeforePath: "docs/a.md", payloadBeforeBlobSha256: sha256})],
    ["moment.append", write(binding.objectId, "docs/a.md", {sha256, content: own.content})],
    ["moment.append", write(binding.objectId, "docs/a.md", own, {beforePath: "docs/a.md", beforeBlobSha256: sha256})],
    ["live.audit.application", {objectId: binding.objectId, mainVersionId: "main", updateBlobSha256: sha256}],
    ["live.audit.application", {objectId: binding.objectId, mainVersionId: "main", updateBlobSha256: own.sha256, manifest: {chunks: [{sha256: own.sha256}, {sha256}]}}],
    ["ydoc.update", ydoc(binding.objectId, "docs/a.md", {sha256})],
    // Settlement preparation would probe this digest before final admission.
    ["moment.append", write(binding.objectId, "docs/a.md", own, {payloadBeforePath: "docs/a.md",
      settlementReference: {formatVersion: 1, record: {acceptedStateBlobSha256: sha256}}})],
  ] satisfies Array<[string, Record<string, unknown>]>;
  let prepared = 0;
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  f.storage.prepareLogAppend = async (...args) => {prepared++; return prepare(...args);};
  const answer = async (op: [string, Record<string, unknown>]) => {
    const response = await f.push([op]);
    return {status: response.status, body: await response.json() as unknown};
  };
  const absentSha256 = "e".repeat(64);
  const hostedScope = f.storage.readServiceHostFeedScope(ws)!;
  for (const [index, op] of named(P.sha256).entries()) {
    // Only the blob refuses it: the document, path and operation are the host's to write.
    expect(hostedWriteAllowed(hostedScope, op[0], op[1]), op[0]).toBe(true);
    const refused = await answer(op);
    expect(refused, op[0]).toMatchObject({status: 403, body: {code: "share_op_rejected"}});
    // A digest the relay holds is refused exactly like one it never saw.
    expect(await answer(named(absentSha256)[index]!), op[0]).toEqual(refused);
  }
  expect(await answer(["ydoc.update", ydoc(binding.objectId, "docs/a.md", YP)])).toMatchObject({status: 403, body: {code: "share_op_rejected"}});
  expect(prepared).toBe(0);
  expect(f.hostCoordinate(0)).toBeNull();
  for (const sha256 of [P.sha256, YP.sha256]) expect(await f.blobStatus(sha256)).toBe(404);

  // Blobs the host fetched or uploaded remain writable.
  expect((await f.push([["moment.append", write(binding.objectId, "docs/a.md", own,
    {momentId: "host-edit", payloadBeforePath: "docs/a.md", payloadBeforeBlobSha256: replacement.sha256})],
    ["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)]])).status).toBe(200);
});

it("serves a refused row and its status without granting its blobs", async () => {
  const f = await fixture();
  const op = parseLogOp({originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: write(binding.objectId, "docs/a.md", P, {momentId: "refused"})});
  op.settlementAdmission = {status: "refused", settlementId: "settlement", reason: "authorship-mismatch"};
  f.storage.appendLogBatch({workspaceId: ws, originId: "settling-device", ops: [op]});
  const served = (await f.read()).ops.find(row => row.originId === "settling-device");
  expect(served).toMatchObject({payload: {momentId: "refused", payloadAfterBlobSha256: P.sha256}, settlementAdmission: {status: "refused"}});
  expect(await f.blobStatus(P.sha256)).toBe(404);
  const have = await f.request("POST", "blobs/have", JSON.stringify({sha256s: [P.sha256]}));
  expect(await have.json()).toEqual({ok: true, missing: [P.sha256]});
});

it("writes only from the service host's reserved origins, which no other route accepts", async () => {
  const f = await fixture();
  const edit = ["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)] satisfies [string, Record<string, unknown>];
  expect((await f.push([edit], 0, "owner-device")).status).toBe(400);
  expect((await f.push([edit])).status).toBe(200);
  const ordinary = await f.handle(new Request(`https://relay.test/sync/${ws}/log`, {method: "POST",
    headers: {authorization: `Bearer ${f.bearer}`, "content-type": "application/json"},
    body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: `${SERVICE_HOST_ORIGIN_PREFIX}other`,
      ops: [{originSeq: 0, opKind: edit[0], recordedAtMs: 3, payload: edit[1]}]})}));
  expect(ordinary.status).toBe(400);
});

it("keeps each document's blob reach across scope changes and drops an idle workspace", async () => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(1_000_000);
  const f = await fixture();
  const reads: Array<{objectId: string; afterRelaySeq: number}> = [];
  const list = f.storage.listServiceHostDocumentRows.bind(f.storage);
  f.storage.listServiceHostDocumentRows = input => {reads.push(input); return list(input);};
  const scans = async () => {
    reads.length = 0;
    expect(await f.blobStatus(A.sha256)).toBe(200);
    return reads.map(({objectId, afterRelaySeq}) => [objectId, afterRelaySeq > 0]);
  };
  expect(await scans()).toEqual([[binding.objectId, false]]);
  // A joining document is scanned; the unchanged one resumes where it stopped.
  f.enroll("docs/b.md");
  expect(await scans()).toEqual([[binding.objectId, true], ["object-b", false]]);
  vi.setSystemTime(1_000_000 + 10 * 60_000);
  expect(await scans()).toEqual([[binding.objectId, false], ["object-b", false]]);
});

it("keeps upload proof through later uploads and idle time", async () => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(1_000_000);
  const f = await fixture();
  const first = blob("first upload");
  await f.upload(first);
  // Ten thousand later uploads in one commit, then one more through the route.
  const put = f.raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content,created_at_ms) VALUES (?,?,?,?,1)");
  const proof = f.raw.prepare("INSERT INTO sync_relay_service_host_uploads(workspace_id,sha256) VALUES (?,?)");
  f.raw.exec("BEGIN");
  for (let index = 0; index < 10_000; index++) {
    const later = blob(`later upload ${index}`);
    put.run(ws, later.sha256, later.content.byteLength, later.content);
    proof.run(ws, later.sha256);
  }
  f.raw.exec("COMMIT");
  await f.upload(blob("last upload"));
  vi.setSystemTime(1_000_000 + 10 * 60_000);
  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", first)]])).status).toBe(200);
  expect(await f.blobStatus(first.sha256)).toBe(200);
});

it("drops upload proof with its collected blob until the host uploads it again", async () => {
  const f = await fixture();
  const collected = blob("collected upload");
  await f.upload(collected);
  expect(f.uploads()).toBe(1);
  const swept = await f.storage.collectUnreferencedBlobs(ws, {nowMs: Number.MAX_SAFE_INTEGER});
  expect(swept.removedSha256s).toEqual([collected.sha256]);
  expect(f.uploads()).toBe(0);
  const edit = ["ydoc.update", ydoc(binding.objectId, "docs/a.md", collected)] satisfies [string, Record<string, unknown>];
  expect(await (await f.push([edit])).json()).toMatchObject({code: "share_op_rejected"});
  await f.upload(collected);
  expect(f.uploads()).toBe(1);
  expect((await f.push([edit])).status).toBe(200);
});

it("keeps an aged blob the host uploads again until its write lands", async () => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(1_000_000);
  const f = await fixture();
  const aged = blob("aged upload");
  f.storage.putBlob({workspaceId: ws, sha256: aged.sha256, content: aged.content, createdAtMs: 1});
  await f.upload(aged);
  const swept = await f.storage.collectUnreferencedBlobs(ws, {nowMs: Date.now()});
  expect(swept.removedSha256s).not.toContain(aged.sha256);
  expect(f.uploads()).toBe(1);
  expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", aged)]])).status).toBe(200);
});

it("drops upload proof when the workspace stops being hosted", async () => {
  const f = await fixture();
  const {uploads} = f;
  const setEnabled = (path: string, enabled: boolean) =>
    f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path, ownerUserId: "owner-1", enabled, nowMs: 30, guard() {}});
  const kept = blob("kept upload");
  await f.upload(kept);
  f.enroll("docs/b.md");
  // Another document is still hosted.
  setEnabled("docs/b.md", false);
  expect(uploads()).toBe(1);
  setEnabled("docs/a.md", false);
  expect(uploads()).toBe(0);
  setEnabled("docs/a.md", true);
  const edit = ["ydoc.update", ydoc(binding.objectId, "docs/a.md", kept)] satisfies [string, Record<string, unknown>];
  expect(await (await f.push([edit])).json()).toMatchObject({code: "share_op_rejected"});
  await f.upload(kept);
  expect((await f.push([edit])).status).toBe(200);
  // A new workspace identity leaves every enrollment behind.
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: ws, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 40})).toBe("rotated");
  expect(uploads()).toBe(0);
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
