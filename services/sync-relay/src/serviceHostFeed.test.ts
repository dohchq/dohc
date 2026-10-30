import {afterEach, expect, it, vi} from "vitest";
import {sha256Hex} from "@dohc/workspace-core/hash";
import {fixture as ticketFixture, binding, preparedStop, retainServiceActivation, scope} from "./liveTickets.test-helper";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostFeedRoute} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {hostedRowDecision, hostedWriteAllowed} from "./serviceHostFeed";
import {parseLogOp, SERVICE_HOST_ORIGIN_PREFIX} from "./relayLogInputs";
import {referencedBlobShas} from "./storage/blobReferences";
import {stableJsonStringify} from "./canonicalJson";
import {filterOpForShare, type AnyShareSelector} from "./shareFilter";
import {createShareReadQueries} from "./shareReadQueries";
import {openSyncRelayStorage} from "./storage";
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
type PushAnswer = {accepted: number; inserted: number; skipped: number; currentMaxOriginSeq: number;
  refusals?: Array<{originId: string; originSeq: number; opKind: string; reason: string}>};

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

it.each(["owner-1", "reader-2"])("binds service-host moment context %s to its authenticated owner", async accountId => {
  const f = await fixture();
  const payload = write(binding.objectId, "docs/a.md", A, {authorContext: {kind: "account", accountId}});
  expect((await f.push([["moment.append", payload]])).status).toBe(200);
  expect(f.hostCoordinate(0)?.payloadJson).toBe(stableJsonStringify(write(binding.objectId, "docs/a.md", A)));
  expect(f.hostCoordinate(0)?.admittedAuthorSnapshot).toEqual(accountId === "owner-1"
    ? [{kind: "human", humanId: "owner-1", humanName: "Unnamed"}] : undefined);
});

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

it("refuses each write outside the hosted documents at its own coordinate and lets accepted edits settle after revocation", async () => {
  const f = await fixture();
  const update = blob("settled update");
  await f.upload(update);
  const outside: Array<[string, Record<string, unknown>]> = [
    ["moment.append", write("object-private", "private/secret.md", update)],
    ["ydoc.update", ydoc("object-private", "private/secret.md", update)],
    ["moment.append", rename(binding.objectId, "docs/a.md", "docs/moved.md", A)],
    ["moment.append", {...write(binding.objectId, "docs/a.md", update), operation: "delete"}],
    ["moment.append", write(binding.objectId, "docs/a.md", update, {beforeObjectId: "object-private"})],
    ["ydoc.update", {...ydoc(binding.objectId, "docs/a.md", update), path: "docs/b.md"}],
    ["workspace.init", {}],
    ["chat.channel.create", {wireId: "general", kind: "channel"}],
    ["version.create", {versionId: "branch", forkSnapshots: []}],
  ];
  const edit = ["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)] satisfies [string, Record<string, unknown>];
  const response = await f.push([...outside.slice(0, 4), edit, ...outside.slice(4)]);
  expect(response.status).toBe(200);
  const body = await response.json() as PushAnswer;
  expect(body).toMatchObject({accepted: 10, inserted: 10, skipped: 0, currentMaxOriginSeq: 9});
  const refusedSeqs = [0, 1, 2, 3, 5, 6, 7, 8, 9];
  expect(body.refusals).toEqual(refusedSeqs.map((originSeq, index) =>
    ({originId: HOST_ORIGIN, originSeq, opKind: outside[index]![0], reason: "outside-hosted-documents"})));
  // The relay keeps each coordinate with a digest of what it refused, never the payload.
  for (const [index, originSeq] of refusedSeqs.entries()) {
    const [opKind, payload] = outside[index]!;
    expect(f.hostCoordinate(originSeq)).toMatchObject({opKind: "relay.refused",
      payloadJson: stableJsonStringify({opKind, payloadSha256: sha256Hex(stableJsonStringify(payload)), reason: "outside-hosted-documents"})});
  }
  expect(f.hostCoordinate(4)).toMatchObject({opKind: "ydoc.update"});

  f.setGrant(scope.shareId, "status='revoked',revoked_at_ms=20");
  expect(f.objects(await f.read())).toEqual(["workspace"]);
  // The owner's content goes; bytes the host uploaded itself are still its own.
  expect(await f.blobStatus(A.sha256)).toBe(404);
  expect(await f.blobStatus(update.sha256)).toBe(200);
  // Still enrolled: work the relay accepted before revocation can settle.
  expect(await (await f.push([edit], 10)).json()).toMatchObject({inserted: 1, currentMaxOriginSeq: 10});
  // Once the session host releases it, the uncovered document retires and the credential ends.
  expect(f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: binding.objectId, nowMs: 30})).toMatchObject({enabled: false, retired: true});
  expect((await f.push([edit], 11)).status).toBe(404);
});

it("decides each new coordinate again under the append's writer", async () => {
  const f = await fixture();
  f.enroll("docs/b.md");
  const update = blob("raced update");
  await f.upload(update);
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  // The release lands after the route's first decision and before the append.
  f.storage.prepareLogAppend = async (...args) => {
    f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
    f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: binding.objectId, nowMs: 31});
    return prepare(...args);
  };
  const response = await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)], ["ydoc.update", ydoc("object-b", "docs/b.md", update)]]);
  expect(await response.json()).toMatchObject({inserted: 2, refusals: [{originSeq: 0, reason: "outside-hosted-documents"}]});
  expect(f.hostCoordinate(0)).toMatchObject({opKind: "relay.refused"});
  expect(f.hostCoordinate(1)).toMatchObject({opKind: "ydoc.update"});
});

it("returns each coordinate's original decision when a batch is retried after its scope changed", async () => {
  const f = await fixture();
  const update = blob("retried update");
  await f.upload(update);
  const batch: Array<[string, Record<string, unknown>]> = [
    ["ydoc.update", ydoc(binding.objectId, "docs/a.md", update)],
    ["ydoc.update", ydoc("object-private", "private/secret.md", update)],
    ["ydoc.update", ydoc("object-b", "docs/b.md", update)],
  ];
  const first = await (await f.push(batch)).json() as PushAnswer;
  expect(first).toMatchObject({inserted: 3, currentMaxOriginSeq: 2});
  expect(first.refusals!.map(refusal => refusal.originSeq)).toEqual([1, 2]);
  // Two decisions would now differ: b joined the scope, and a left it.
  f.enroll("docs/b.md");
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
  f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: binding.objectId, nowMs: 31});
  const prepared: string[] = [];
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  f.storage.prepareLogAppend = async (input, signal) => {prepared.push(...input.ops.map(op => op.opKind)); return prepare(input, signal);};
  const retried = await (await f.push(batch)).json() as PushAnswer;
  expect(retried).toEqual({...first, inserted: 0, skipped: 3});
  // A retried refusal is answered from the log, without preparing its payload again.
  expect(prepared).toEqual(["ydoc.update", "relay.refused", "relay.refused"]);
  // A different payload at a decided coordinate conflicts, whichever the decision was.
  for (const originSeq of [0, 1]) {
    expect((await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", A)]], originSeq)).status).toBe(409);
  }
  // A later op lands after a refused one.
  expect(await (await f.push([batch[2]!], 3)).json()).toMatchObject({inserted: 1, currentMaxOriginSeq: 3});
});

it("keeps a refused row's coordinate without its payload, its blobs or any projection", async () => {
  const f = await fixture();
  const projections = () => ["sync_relay_current_files", "sync_relay_object_paths", "sync_relay_object_moments", "sync_relay_version_snapshot_blobs"]
    .map(table => f.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  const before = projections();
  const response = await f.push([["moment.append", write("object-new", "docs/new.md", P)], ["moment.append", write("object-private", "private/secret.md", P)]]);
  expect(await response.json()).toMatchObject({inserted: 2, refusals: [{originSeq: 0}, {originSeq: 1}]});
  expect(projections()).toEqual(before);
  expect(f.raw.prepare("SELECT relay_admission FROM sync_relay_log WHERE origin_id=? ORDER BY origin_seq").all(HOST_ORIGIN).map(row => row.relay_admission))
    .toEqual(["refused", "refused"]);
  expect(await f.blobStatus(P.sha256)).toBe(404);
  // The owner's ordinary pull reads the refusal, never what was refused.
  const owner = f.storage.fetchLogPage({workspaceId: ws, sinceRelaySeq: 0, limit: 100}).rows.filter(row => row.originId === HOST_ORIGIN);
  expect(owner.map(row => row.opKind)).toEqual(["relay.refused", "relay.refused"]);
  expect(JSON.stringify(owner)).not.toContain(P.sha256);
  // No reader serves it as a change: not the hosted feed, nor a file, group or chat share.
  expect(JSON.stringify(await f.read())).not.toContain("relay.refused");
  const selectors: AnyShareSelector[] = [{paths: ["docs"], versionId: null, access: "edit"},
    {kind: "group", channelWireId: "general", paths: ["docs"], versionId: null, access: "read-write"},
    {kind: "chat", channelWireId: "general", access: "read-write"}];
  for (const selector of selectors) expect(filterOpForShare(selector, "relay.refused", owner[0]!.payloadJson).allowed).toBe(false);
  // Only the relay writes one.
  const claimed = await f.request("POST", "log", JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: HOST_ORIGIN,
    ops: [{originSeq: 100, opKind: "relay.refused", recordedAtMs: 3, payload: {}}]}));
  expect(claimed.status).toBe(400);
  const next = f.storage.maxOriginSeq(ws, "owner-device") + 1;
  const forged = parseLogOp({originSeq: next, opKind: "moment.append", recordedAtMs: 3, payload: {}});
  forged.opKind = "relay.refused";
  expect(() => f.storage.appendLogBatch({workspaceId: ws, originId: "owner-device", ops: [forged]})).toThrow(/written only by the relay/);
  const marked = parseLogOp({originSeq: next, opKind: "moment.append", recordedAtMs: 3, payload: {}});
  marked.relayAdmission = "refused";
  expect(() => f.storage.appendLogBatch({workspaceId: ws, originId: "owner-device", ops: [marked]})).toThrow(/written only by the relay/);
});

it("lets collection take a blob whose digest only a refusal names, in a small or a scanned sweep", async () => {
  for (const others of [0, 20]) {
    const f = await fixture();
    const refused = ["moment.append", write("object-private", "private/secret.md", P)] satisfies [string, Record<string, unknown>];
    // Bytes equal to the refused payload, so its digest is the refusal's.
    const lookalike = blob(stableJsonStringify(refused[1]));
    for (const content of [lookalike, ...Array.from({length: others}, (_, index) => blob(`unreferenced ${index}`))]) {
      f.storage.putBlob({workspaceId: ws, sha256: content.sha256, content: content.content, createdAtMs: 1});
    }
    expect(await (await f.push([refused])).json()).toMatchObject({refusals: [{originSeq: 0}]});
    expect(f.hostCoordinate(0)!.payloadJson).toContain(lookalike.sha256);
    const swept = await f.storage.collectUnreferencedBlobs(ws, {nowMs: Number.MAX_SAFE_INTEGER});
    expect(swept.removedSha256s, `${others}`).toContain(lookalike.sha256);
    expect(swept.removed).toBe(others + 1);
  }
});

it("settles a moved or replaced document's work without taking back its old location", async () => {
  const f = await fixture();
  f.enroll("docs/b.md");
  const moved = blob("drained after move"), replaced = blob("drained after replace"), successor = blob("new b");
  f.storage.putBlob({workspaceId: ws, sha256: successor.sha256, content: successor.content, createdAtMs: 1});
  // Stored directly: an upload through the route would compute each document's reach while it is still shared.
  for (const content of [moved, replaced]) f.storage.putServiceHostBlob({workspaceId: ws, sha256: content.sha256, content: content.content, createdAtMs: 1});
  // The owner moves a out of the share, and deletes b and puts another file at its path.
  f.append(["moment.append", rename(binding.objectId, "docs/a.md", "private/a.md", A)],
    ["moment.append", {momentId: "delete-b", objectId: "object-b", versionId: "main", operation: "delete", path: "docs/b.md",
      payloadBeforePath: "docs/b.md", payloadBeforeBlobSha256: B.sha256, recordedAtMs: 2}],
    ["moment.append", write("object-successor", "docs/b.md", successor)]);
  const hostedScope = f.storage.readServiceHostFeedScope(ws)!;
  expect([...hostedScope.departed]).toEqual([binding.objectId, "object-b"]);
  expect([...hostedScope.shared.keys()]).toEqual([]);
  const placement = () => ({
    files: f.raw.prepare("SELECT path, blob_sha256 FROM sync_relay_current_files WHERE workspace_id=? ORDER BY path").all(ws).map(row => [row.path, row.blob_sha256]),
    paths: f.raw.prepare("SELECT object_id, path FROM sync_relay_object_paths WHERE workspace_id=? ORDER BY object_id").all(ws).map(row => [row.object_id, row.path]),
    atA: f.storage.objectIdAtPathInVersion({workspaceId: ws, versionId: "main", path: "docs/a.md"}),
    atB: f.storage.objectIdAtPathInVersion({workspaceId: ws, versionId: "main", path: "docs/b.md"}),
  });
  const before = placement();
  expect(before).toMatchObject({atA: undefined, atB: "object-successor"});
  // Each write names its own document's earlier content, which the host can no
  // longer read, so it uploads that content first, as the engine does.
  expect(await f.blobStatus(A.sha256)).toBe(404);
  const have = await f.request("POST", "blobs/have", JSON.stringify({sha256s: [A.sha256, B.sha256, moved.sha256, replaced.sha256]}));
  expect(await have.json()).toEqual({ok: true, missing: [A.sha256, B.sha256]});
  for (const content of [A, B]) await f.upload(content);
  const response = await f.push([
    ["moment.append", write(binding.objectId, "docs/a.md", moved, {momentId: "drain-a", payloadBeforePath: "docs/a.md", payloadBeforeBlobSha256: A.sha256})],
    ["moment.append", write("object-b", "docs/b.md", replaced, {momentId: "drain-b", payloadBeforePath: "docs/b.md", payloadBeforeBlobSha256: B.sha256})],
    ["ydoc.update", ydoc(binding.objectId, "docs/a.md", moved)],
  ]);
  const body = await response.json() as PushAnswer;
  expect(body).toMatchObject({inserted: 3, currentMaxOriginSeq: 2});
  expect(body.refusals).toBeUndefined();
  // The publications keep their history.
  expect(f.raw.prepare("SELECT op_kind, json_extract(payload_json,'$.momentId') AS moment, relay_admission FROM sync_relay_log WHERE origin_id=? ORDER BY origin_seq")
    .all(HOST_ORIGIN).map(row => [row.op_kind, row.moment, row.relay_admission]))
    .toEqual([["moment.append", "drain-a", "departed"], ["moment.append", "drain-b", "departed"], ["ydoc.update", null, "departed"]]);
  // Neither the location nor the current file moves back, and neither document is current again.
  expect(placement()).toEqual(before);
  expect([...f.storage.readServiceHostFeedScope(ws)!.departed]).toEqual([binding.objectId, "object-b"]);
  // A departed document's writes reach neither the owner's edits since it
  // left nor the file now at its path: each fails like a blob the relay never had.
  const privateEdit = blob("edited after leaving");
  f.storage.putBlob({workspaceId: ws, sha256: privateEdit.sha256, content: privateEdit.content, createdAtMs: 1});
  f.append(["moment.append", write(binding.objectId, "private/a.md", privateEdit, {momentId: "private-edit"})]);
  const answer = async (objectId: string, path: string, sha256: string) => {
    const response = await f.push([["moment.append", write(objectId, path, replaced,
      {momentId: "named", payloadBeforePath: path, payloadBeforeBlobSha256: sha256})]], 3);
    return [response.status, (await response.text()).replaceAll(sha256, "named")];
  };
  const absent = await answer(binding.objectId, "docs/a.md", "d".repeat(64));
  expect(absent[0]).toBe(422);
  expect(await answer(binding.objectId, "docs/a.md", privateEdit.sha256)).toEqual(absent);
  expect(await answer("object-b", "docs/b.md", successor.sha256)).toEqual(absent);
  expect(f.hostCoordinate(3)).toBeNull();
  // A reopened relay keeps which rows departed, and the column admits nothing else.
  openSyncRelayStorage(f.path, f.config).close();
  expect(f.raw.prepare("SELECT count(*) AS count FROM sync_relay_log WHERE relay_admission='departed'").get()!.count).toBe(3);
  expect(() => f.raw.prepare("UPDATE sync_relay_log SET relay_admission='elsewhere' WHERE origin_id=?").run(HOST_ORIGIN)).toThrow(/CHECK/);
});

// Proves: Stop's retirement obligation takes its document out of the host's
// reads and ordinary writes, and an early Resume does not bring it back. The
// scope names the obligation, and a sibling stays readable and writable. The
// retiring document's own write needs its bytes uploaded, and then a proof.
it("keeps a retiring document out of hosted reads and writes while its sibling stays readable", async () => {
  const f = await fixture(); f.enroll("docs/b.md");
  const activationId = retainServiceActivation(f.raw, namespace, true);
  const stop = preparedStop(f.storage, {workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, retire: true, nowMs: 20, guard() {}});
  expect(stop?.acceptedCursor).toBe(0);
  f.enroll("docs/a.md");
  expect(f.storage.readServiceHostEnrollment(ws, "docs/a.md")).toMatchObject({enabled: true, retired: false});
  const current = f.storage.readServiceHostFeedScope(ws)!;
  expect([[...current.hosted.keys()], [...current.shared.keys()]]).toEqual([["object-b"], ["object-b"]]);
  expect([...current.settling]).toEqual([[binding.objectId, {relayDatabaseNamespace: namespace, activationId, workspaceId: ws, mainVersionId: "main",
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, path: "docs/a.md", restoreFenceGeneration: 7, acceptedThrough: 0, requestedAtMs: 20}]]);
  expect(f.objects(await f.read())).toEqual(["workspace", "object-b"]);
  const writes = (): Array<[string, Record<string, unknown>]> => [["moment.append", write(binding.objectId, "docs/a.md", A, {momentId: "retiring"})],
    ["moment.append", write("object-b", "docs/b.md", B, {momentId: "sibling"})]];
  expect(await (await f.push(writes())).json()).toMatchObject({code: "blob_missing"});
  expect(await f.blobStatus(A.sha256)).toBe(404);
  await f.upload(A);
  expect(await (await f.push(writes())).json())
    .toMatchObject({inserted: 2, refusals: [{originSeq: 0, reason: "unproved-retirement-output"}]});
  // With every other document stopped, the scope still names the obligation.
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/b.md", ownerUserId: "owner-1", enabled: false, retire: true, nowMs: 30, guard() {}});
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, retire: true, nowMs: 30, guard() {}});
  const stopped = f.storage.readServiceHostFeedScope(ws)!;
  expect([stopped.hosted.size, stopped.shared.size, [...stopped.settling.keys()]]).toEqual([0, 0, [binding.objectId]]);
});

// Proves: Pause takes a document with an activation out of the host's hosted
// documents and into settling, and Resume leaves it settling while its
// retirement obligation is open.
it("moves a paused document with an activation from hosted to settling and keeps it there on Resume", async () => {
  const f = await fixture();
  const activationId = retainServiceActivation(f.raw, namespace, true);
  const documents = () => {
    const current = f.storage.readServiceHostFeedScope(ws)!;
    return {hosted: [...current.hosted.keys()], settling: [...current.settling.keys()]};
  };
  expect(documents()).toEqual({hosted: [binding.objectId], settling: []});
  for (const enabled of [false, true]) {
    f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled, nowMs: 20, guard() {}});
    expect(f.storage.readServiceHostEnrollment(ws, "docs/a.md")).toMatchObject({ownerStop: enabled ? null : "pause"});
    expect(documents()).toEqual({hosted: [], settling: [binding.objectId]});
  }
  expect(f.storage.readServiceHostFeedScope(ws)!.settling.get(binding.objectId)).toMatchObject({activationId, requestedAtMs: 20});
});

it("answers a write naming the owner's edits to a revoked document exactly like an absent digest", async () => {
  const f = await fixture();
  const own = blob("host edit"), edited = blob("edited after revocation"), away = blob("edited while moved away");
  await f.upload(own);
  for (const content of [edited, away]) f.storage.putBlob({workspaceId: ws, sha256: content.sha256, content: content.content, createdAtMs: 1});
  f.setGrant(scope.shareId, "status='revoked',revoked_at_ms=20");
  const answer = async (sha256: string) => {
    const response = await f.push([["moment.append", write(binding.objectId, "docs/a.md", own,
      {momentId: "named", payloadBeforePath: "docs/a.md", payloadBeforeBlobSha256: sha256})]]);
    return [response.status, (await response.text()).replaceAll(sha256, "named")];
  };
  const absent = await answer("d".repeat(64));
  expect(absent[0]).toBe(422);
  // Still enrolled and at its path, so writable, but out of the share.
  f.append(["moment.append", write(binding.objectId, "docs/a.md", edited, {momentId: "edit-after-revocation"})]);
  const revoked = f.storage.readServiceHostFeedScope(ws)!;
  expect([[...revoked.hosted.keys()], revoked.shared.size, revoked.departed.size]).toEqual([[binding.objectId], 0, 0]);
  expect(await answer(edited.sha256)).toEqual(absent);
  // Moved away, edited there, and moved back to its enrolled path.
  f.append(["moment.append", rename(binding.objectId, "docs/a.md", "private/a.md", edited)],
    ["moment.append", write(binding.objectId, "private/a.md", away, {momentId: "edit-away"})],
    ["moment.append", {...rename(binding.objectId, "private/a.md", "docs/a.md", away), momentId: "move-back"}]);
  expect(f.storage.readServiceHostFeedScope(ws)!.departed.size).toBe(0);
  expect(await answer(away.sha256)).toEqual(absent);
  expect(f.hostCoordinate(0)).toBeNull();
  for (const sha256 of [edited.sha256, away.sha256]) expect(await f.blobStatus(sha256)).toBe(404);
});

it("keeps a departed document's writes out of share delivery and in the owner's log", async () => {
  const f = await fixture();
  const drained = blob("drained after move");
  f.storage.putServiceHostBlob({workspaceId: ws, sha256: drained.sha256, content: drained.content, createdAtMs: 1});
  f.append(["moment.append", rename(binding.objectId, "docs/a.md", "private/a.md", A)]);
  await f.upload(A);
  const queries = createShareReadQueries(f.storage, 500);
  const selector: AnyShareSelector = {paths: ["docs"], versionId: null, access: "edit"};
  const freshness = () => queries.newestFilteredOpFreshness(ws, selector, 0);
  const before = freshness();
  expect(await (await f.push([["moment.append", write(binding.objectId, "docs/a.md", drained,
    {momentId: "drain-a", payloadBeforePath: "docs/a.md", payloadBeforeBlobSha256: A.sha256})]])).json()).toMatchObject({inserted: 1});
  expect(f.storage.fetchLogPage({workspaceId: ws, sinceRelaySeq: 0, limit: 100}).rows.filter(row => row.originId === HOST_ORIGIN)
    .map(row => [row.opKind, row.relayAdmission])).toEqual([["moment.append", "departed"]]);
  // A recipient replays every write it is served, so each one's content must be readable through the share.
  for (const audience of ["authenticated", "accountless"] as const) {
    const page = queries.filteredLogPage(ws, scope.shareId, selector, 0, 100, audience);
    expect(JSON.stringify(page)).not.toContain(drained.sha256);
    for (const op of page.ops) {
      const after = (op.payload as Record<string, unknown>).payloadAfterBlobSha256;
      if (typeof after === "string") expect(queries.historicalSharedBlob(ws, selector, after), audience).not.toBeNull();
    }
  }
  expect(freshness()).toEqual(before);
});

it("fails a write naming a blob the host never fetched or uploaded as missing, and keeps it unreadable", async () => {
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
  // Preparation would probe a settlement's digest, so it must never see one out of reach.
  const prepared: string[] = [];
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  f.storage.prepareLogAppend = async (input, signal) => {prepared.push(...input.ops.map(op => op.payloadJson)); return prepare(input, signal);};
  const answer = async (op: [string, Record<string, unknown>], sha256: string) => {
    const response = await f.push([op]);
    return [response.status, (await response.text()).replaceAll(sha256, "named")];
  };
  const absentSha256 = "e".repeat(64);
  const hostedScope = f.storage.readServiceHostFeedScope(ws)!;
  for (const [index, op] of named(P.sha256).entries()) {
    // Only the blob stops it: the document, path and operation are the host's to write.
    expect(hostedWriteAllowed(hostedScope, op[0], op[1]), op[0]).toBe(true);
    const missing = await answer(op, P.sha256);
    expect(missing[0], op[0]).toBe(422);
    expect(JSON.parse(String(missing[1])), op[0]).toMatchObject({code: "blob_missing"});
    // A digest the relay holds fails exactly like one it never saw.
    expect(await answer(named(absentSha256)[index]!, absentSha256), op[0]).toEqual(missing);
  }
  expect((await answer(["ydoc.update", ydoc(binding.objectId, "docs/a.md", YP)], YP.sha256))[0]).toBe(422);
  expect(prepared).toEqual([]);
  expect(f.hostCoordinate(0)).toBeNull();
  for (const sha256 of [P.sha256, YP.sha256]) expect(await f.blobStatus(sha256)).toBe(404);

  // Blobs the host fetched or uploaded remain writable.
  expect(await (await f.push([["moment.append", write(binding.objectId, "docs/a.md", own,
    {momentId: "host-edit", payloadBeforePath: "docs/a.md", payloadBeforeBlobSha256: replacement.sha256})],
    ["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)]])).json()).toMatchObject({inserted: 2});
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
  // The host's credential has no ordinary route; ordinary provenance refuses these origins from everyone else.
  const ordinary = await f.handle(new Request(`https://relay.test/sync/${ws}/log`, {method: "POST",
    headers: {authorization: `Bearer ${f.bearer}`, "content-type": "application/json"},
    body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: `${SERVICE_HOST_ORIGIN_PREFIX}other`,
      ops: [{originSeq: 0, opKind: edit[0], recordedAtMs: 3, payload: edit[1]}]})}));
  expect(ordinary.status).toBe(404);
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
  // The warm-up scans a document with no reach, then the request catches up each one.
  expect(await scans()).toEqual([[binding.objectId, false], [binding.objectId, true]]);
  // A joining document is scanned; the unchanged one resumes where it stopped.
  f.enroll("docs/b.md");
  expect(await scans()).toEqual([["object-b", false], [binding.objectId, true], ["object-b", true]]);
  vi.setSystemTime(1_000_000 + 10 * 60_000);
  expect(await scans()).toEqual([[binding.objectId, false], ["object-b", false], [binding.objectId, true], ["object-b", true]]);
});

// Proves: a cold reach over a long history lets other work run between its
// pages, and concurrent requests share one warm-up that reads each page once.
it("rebuilds a cold blob reach a page at a time in one warm-up that concurrent requests share", async () => {
  const f = await fixture();
  f.append(...Array.from({length: 1_100}, (): [string, Record<string, unknown>] => ["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)]));
  const reads: number[] = [];
  const list = f.storage.listServiceHostDocumentRows.bind(f.storage);
  f.storage.listServiceHostDocumentRows = input => {reads.push(input.afterRelaySeq); return list(input);};
  const order: string[] = [];
  setImmediate(() => order.push("other work"));
  const answered = async (status: Promise<number>) => {const value = await status; order.push("answer"); return value;};
  expect(await Promise.all([answered(f.blobStatus(Y.sha256)), answered(f.blobStatus(A.sha256))])).toEqual([200, 200]);
  expect(order).toEqual(["other work", "answer", "answer"]);
  // Three pages of history, read once, then each request's catch-up from the end.
  const end = reads.at(-1)!;
  expect(reads.slice(0, 3)).toEqual([0, expect.any(Number), expect.any(Number)]);
  expect(reads.slice(3)).toEqual([end, end]);
  expect(new Set(reads.slice(0, 3)).size).toBe(3);
});

it("warms a cold reach before the first admission check of a write", async () => {
  const f = await fixture();
  f.append(...Array.from({length: 1_100}, (): [string, Record<string, unknown>] => ["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)]));
  const order: string[] = [];
  setImmediate(() => order.push("other work"));
  const pushed = f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", Y)]]).then(response => {order.push("answer"); return response;});
  expect(await (await pushed).json()).toMatchObject({inserted: 1});
  expect(order).toEqual(["other work", "answer"]);
});

// Proves: a write whose credential is revoked during its warm-up answers like
// any revoked credential, and nothing is screened or prepared under it.
it("answers a write whose credential is revoked during its warm-up like any revoked credential", async () => {
  const f = await fixture();
  let revoked = false;
  const authorize = (input: {workspaceId: string; bearer: string; method: string; pathname: string}) =>
    authorizeServiceHostReplication(f.storage, {key, namespace, ...input});
  const handle = createServiceHostReplication({storage: f.storage, prefix: "dohc-service-v1.", hostedFeed: true,
    authorize, revalidate: input => revoked ? null : authorize(input)});
  const list = f.storage.listServiceHostDocumentRows.bind(f.storage);
  f.storage.listServiceHostDocumentRows = input => {revoked = true; return list(input);};
  const steps: string[] = [];
  const held = f.storage.maxOriginSeq.bind(f.storage), prepare = f.storage.prepareLogAppend.bind(f.storage);
  f.storage.maxOriginSeq = (...args) => {steps.push("screen"); return held(...args);};
  f.storage.prepareLogAppend = async (...args) => {steps.push("prepare"); return prepare(...args);};
  // The private blob would fail screening as missing.
  const push = async () => {
    const response = await handle(new Request(`https://relay.test/sync/${ws}/hosted/log`, {method: "POST",
      headers: {authorization: `Bearer ${f.bearer}`, "content-type": "application/json"},
      body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: HOST_ORIGIN,
        ops: [{originSeq: 0, opKind: "ydoc.update", recordedAtMs: 3, payload: ydoc(binding.objectId, "docs/a.md", P)}]})}));
    return [response.status, await response.json()];
  };
  const during = await push();
  expect(revoked).toBe(true);
  expect(during).toEqual(await push());
  expect(during[0]).toBe(404);
  expect(steps).toEqual([]);
});

// Proves: a document that joins after a write's warm-up is not scanned inside
// the append's writer, and the host's next write warms it first.
it("never scans a document that joins after the warm-up inside the append's writer", async () => {
  const f = await fixture();
  f.append(...Array.from({length: 1_100}, (): [string, Record<string, unknown>] => ["ydoc.update", ydoc("object-b", "docs/b.md", B)]));
  const own = blob("host edit");
  await f.upload(own);
  let writing = false;
  const written: Array<[string, boolean]> = [];
  const list = f.storage.listServiceHostDocumentRows.bind(f.storage);
  f.storage.listServiceHostDocumentRows = input => {if (writing) written.push([input.objectId, input.afterRelaySeq > 0]); return list(input);};
  const append = f.storage.appendLogBatch.bind(f.storage);
  f.storage.appendLogBatch = input => {writing = true; try {return append(input);} finally {writing = false;}};
  const prepare = f.storage.prepareLogAppend.bind(f.storage);
  // The document joins after the write's warm-up and screening.
  f.storage.prepareLogAppend = async (...args) => {f.storage.prepareLogAppend = prepare; f.enroll("docs/b.md"); return prepare(...args);};
  expect(await (await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", own)]])).json()).toMatchObject({inserted: 1});
  // The writer only caught up the document it already had.
  expect(written).toEqual([[binding.objectId, true]]);
  written.length = 0;
  // The next write warms the joined document first, so naming its blob lands and the writer only catches up.
  expect(await (await f.push([["moment.append", write(binding.objectId, "docs/a.md", B, {momentId: "copied"})]], 1)).json())
    .toMatchObject({inserted: 1});
  expect(written).toEqual([[binding.objectId, true], ["object-b", true]]);
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

it("drops upload proof with its collected blob, and fails the write as retryable until the host uploads it again", async () => {
  const f = await fixture();
  const collected = blob("collected upload");
  await f.upload(collected);
  expect(f.uploads()).toBe(1);
  const swept = await f.storage.collectUnreferencedBlobs(ws, {nowMs: Number.MAX_SAFE_INTEGER});
  expect(swept.removedSha256s).toEqual([collected.sha256]);
  expect(f.uploads()).toBe(0);
  await expectMissingUntilUploaded(f, collected);
});

it("fails a write naming a blob it read through a document that left, until the host uploads it", async () => {
  const f = await fixture();
  f.enroll("docs/b.md");
  expect(await f.blobStatus(B.sha256)).toBe(200);
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/b.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
  f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: "object-b", nowMs: 31});
  await expectMissingUntilUploaded(f, B);
});

// A write naming a blob out of reach fails without taking its coordinate,
// `blobs/have` asks for the blob, and the upload lets the same write land.
async function expectMissingUntilUploaded(f: Awaited<ReturnType<typeof fixture>>, content: Blob) {
  const edit = ["ydoc.update", ydoc(binding.objectId, "docs/a.md", content)] satisfies [string, Record<string, unknown>];
  const failed = await f.push([edit]);
  expect(failed.status).toBe(422);
  expect(await failed.json()).toMatchObject({code: "blob_missing"});
  expect(f.hostCoordinate(0)).toBeNull();
  const have = await f.request("POST", "blobs/have", JSON.stringify({sha256s: [content.sha256]}));
  expect(await have.json()).toEqual({ok: true, missing: [content.sha256]});
  await f.upload(content);
  expect(f.uploads()).toBe(1);
  const landed = await (await f.push([edit])).json() as PushAnswer;
  expect(landed).toMatchObject({inserted: 1, currentMaxOriginSeq: 0});
  expect(landed.refusals).toBeUndefined();
}

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
  const release = (objectId: string) => f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId, nowMs: 31});
  const kept = blob("kept upload");
  await f.upload(kept);
  f.enroll("docs/b.md");
  // Another document is still hosted.
  setEnabled("docs/b.md", false);
  release("object-b");
  expect(uploads()).toBe(1);
  // A Pause waits for the session host to release the document.
  setEnabled("docs/a.md", false);
  expect(uploads()).toBe(1);
  release(binding.objectId);
  expect(uploads()).toBe(0);
  setEnabled("docs/a.md", true);
  const edit = ["ydoc.update", ydoc(binding.objectId, "docs/a.md", kept)] satisfies [string, Record<string, unknown>];
  expect((await f.push([edit])).status).toBe(422);
  await f.upload(kept);
  expect(await (await f.push([edit])).json()).toMatchObject({inserted: 1});
  // A new workspace identity leaves every enrollment behind.
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: ws, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 40})).toBe("rotated");
  expect(uploads()).toBe(0);
});

it("drops upload proof when Stop retires the last hosted document", async () => {
  const f = await fixture();
  await f.upload(blob("stopped upload"));
  expect(f.uploads()).toBe(1);
  // Stop retires at once, with no release.
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, retire: true, nowMs: 30, guard() {}});
  expect(f.uploads()).toBe(0);
});

it("reads only the current scope with the workspace's one credential as documents join and leave", async () => {
  const f = await fixture();
  // Every enrollment derives the same workspace credential.
  expect(deriveServiceHostBearer(f.enroll("docs/b.md"), {key, namespace})).toBe(f.bearer);
  expect(f.objects(await f.read())).toEqual(["workspace", binding.objectId, "object-b"]);
  // A released Pause keeps the enrollment row, but not its scope.
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/b.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
  expect(f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: "object-b", nowMs: 31})).toMatchObject({enabled: false, retired: false});
  const left = await f.read();
  expect(left.scope.documents).toEqual([{objectId: binding.objectId, path: "docs/a.md"}]);
  expect(f.objects(left)).toEqual(["workspace", binding.objectId]);
  expect(await f.blobStatus(B.sha256)).toBe(404);
  expect((await f.request("GET", `log?${identity}&scope=${left.scope.token}&since=0&object=object-b`)).status).toBe(400);
  expect(await (await f.push([["moment.append", write("object-b", "docs/b.md", B)]])).json())
    .toMatchObject({refusals: [{reason: "outside-hosted-documents"}]});
  // The credential never reaches the workspace's ordinary replication.
  expect((await f.handle(new Request(`https://relay.test/sync/${ws}/log?${identity}`, {headers: {authorization: `Bearer ${f.bearer}`}}))).status).toBe(404);
  // A new workspace identity leaves the enrollments, and so the credential, behind.
  f.storage.rotateWorkspaceIdentity({workspaceId: ws, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 40});
  expect((await f.request("GET", "log?replicationEpoch=epoch-2&streamIdentity=stream-2")).status).toBe(404);
});

it("after an epoch rotation hosts only documents enrolled again from above the floor, and serves them from there", async () => {
  const f = await fixture();
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: ws, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 40})).toBe("rotated");
  const floor = Number(f.raw.prepare("SELECT epoch_log_floor FROM sync_relay_workspaces WHERE workspace_id=?").get(ws)!.epoch_log_floor);
  expect(floor).toBeGreaterThan(0);
  // A writer of the new epoch edits a, and creates a document with its Y.Doc base.
  const N = blob("new document"), base = blob("new document base"), edited = blob("hosted a, edited");
  for (const {sha256, content} of [N, base, edited]) f.storage.putBlob({workspaceId: ws, sha256, content, createdAtMs: 1});
  const written: Array<[string, Record<string, unknown>]> = [
    ["moment.append", write(binding.objectId, "docs/a.md", edited, {momentId: "edit-a"})],
    ["moment.append", write("object-new", "docs/new.md", N)],
    ["ydoc.update", {...ydoc("object-new", "docs/new.md", base), isBaseState: true, lineageClaimId: base.sha256}],
  ];
  f.storage.appendLogBatch({workspaceId: ws, originId: "epoch-2-device",
    ops: written.map(([opKind, payload], originSeq) => parseLogOp({originSeq, opKind, recordedAtMs: 50, payload}))});
  // a's enrollment belongs to the old epoch, so it can neither serve nor enroll again.
  expect(f.storage.readServiceHostFeedScope(ws)).toBeNull();
  expect(() => f.enroll("docs/a.md")).toThrow("obsolete");
  // b was never enrolled, and its only head is below the floor.
  expect(() => f.enroll("docs/b.md")).toThrow("current main document");

  const enrolled = f.enroll("docs/new.md");
  expect(enrolled).toMatchObject({objectId: "object-new", replicationEpoch: "epoch-2", streamIdentity: "stream-2"});
  const bearer = deriveServiceHostBearer(enrolled, {key, namespace});
  const page = async (query: string) => {
    const response = await f.handle(new Request(`https://relay.test/sync/${ws}/hosted/log?replicationEpoch=epoch-2&streamIdentity=stream-2${query}`,
      {headers: {authorization: `Bearer ${bearer}`}}));
    expect(response.status).toBe(200);
    return await response.json() as Page;
  };
  const {scope: current} = await page("");
  // a's old enrollment is still stored and enabled, but outside the scope.
  expect(f.storage.readServiceHostEnrollment(ws, "docs/a.md")).toMatchObject({enabled: true, retired: false, replicationEpoch: "epoch"});
  expect(current.documents).toEqual([{objectId: "object-new", path: "docs/new.md"}]);
  // The main feed and the new document's backfill both read only above the floor.
  for (const query of [`&scope=${current.token}`, `&scope=${current.token}&since=0&object=object-new`]) {
    const feed = await page(query);
    expect(feed.ops.map(op => [op.originId, op.opKind, op.payload.objectId]), query).toEqual([
      ["epoch-2-device", "moment.append", "object-new"], ["epoch-2-device", "ydoc.update", "object-new"]]);
    expect(feed.ops.every(op => op.relaySeq > floor), query).toBe(true);
  }
});

it("cuts a paused document's reads at once and keeps its writes until the session host releases it, and drops a stopped one at once", async () => {
  const f = await fixture();
  f.enroll("docs/b.md");
  const set = (path: string, enabled: boolean, retire = false) =>
    f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path, ownerUserId: "owner-1", enabled, retire, nowMs: 30, guard() {}});
  const release = (objectId: string) => f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId, nowMs: 31});
  const documents = async () => (await f.read()).scope.documents.map(row => row.objectId);
  for (const sha256 of [A.sha256, Y.sha256, B.sha256]) expect(await f.blobStatus(sha256)).toBe(200);
  // A pending Pause takes the document's rows and blobs out of reach now.
  set("docs/a.md", false);
  // Stop fences new acceptance at once; the relay's live journal already holds what the host accepted.
  set("docs/b.md", false, true);
  const paused = await f.read();
  expect(paused.scope.documents).toEqual([]);
  expect(f.objects(paused)).toEqual(["workspace"]);
  for (const sha256 of [A.sha256, Y.sha256, B.sha256]) expect(await f.blobStatus(sha256)).toBe(404);
  expect((await f.request("GET", `log?${identity}&scope=${paused.scope.token}&since=0&object=object-b`)).status).toBe(400);
  // The paused document keeps its binding, so the host's accepted work still lands while it settles.
  expect([...f.storage.readServiceHostFeedScope(ws)!.hosted.keys()]).toEqual([binding.objectId]);
  const settling = blob("settling edit");
  await f.upload(settling);
  expect(await (await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", settling)]])).json())
    .toMatchObject({inserted: 1, currentMaxOriginSeq: 0});
  expect(f.hostCoordinate(0)).toMatchObject({opKind: "ydoc.update"});
  // The stopped one takes no more writes.
  expect(await (await f.push([["ydoc.update", ydoc("object-b", "docs/b.md", settling)]], 1)).json())
    .toMatchObject({refusals: [{originSeq: 1, reason: "outside-hosted-documents"}]});
  expect(release("object-b")).toMatchObject({hostDrainedAtMs: 31});
  // Resuming before the release cancels the Pause and brings the document back.
  set("docs/a.md", true);
  expect(await documents()).toEqual([binding.objectId]);
  for (const sha256 of [A.sha256, Y.sha256]) expect(await f.blobStatus(sha256)).toBe(200);
  expect(release(binding.objectId)).toBeNull();
  expect(await documents()).toEqual([binding.objectId]);
  expect(await f.blobStatus(B.sha256)).toBe(404);
  // Revocation cuts reads at once; writes stay open until the release retires the document.
  f.setGrant(scope.shareId, "status='revoked',revoked_at_ms=40");
  expect(await documents()).toEqual([]);
  expect([...f.storage.readServiceHostFeedScope(ws)!.hosted.keys()]).toEqual([binding.objectId]);
  expect(release(binding.objectId)).toMatchObject({enabled: false, retired: true});
  expect(f.storage.readServiceHostFeedScope(ws)).toBeNull();
  expect((await f.request("GET", `log?${identity}`)).status).toBe(404);
});

it("keeps the hosted credential alive for an undrained Stop and then drops it, never granting ordinary routes", async () => {
  const f = await fixture();
  const ordinary = () => authorizeServiceHostReplication(f.storage, {key, namespace, workspaceId: ws, bearer: f.bearer,
    method: "GET", pathname: `/sync/${ws}/log`});
  const hosted = () => authorizeServiceHostReplication(f.storage, {key, namespace, workspaceId: ws, bearer: f.bearer,
    method: "GET", pathname: `/sync/${ws}/hosted/log`});
  expect(ordinary()).toBeNull();
  expect(hosted()).toBe("owner-1");
  expect(f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1",
    enabled: false, retire: true, nowMs: 20, guard() {}})).toMatchObject({retired: true, enabled: false, hostDrainedAtMs: null});
  expect(ordinary()).toBeNull();
  expect(hosted()).toBe("owner-1");
  const undrained = f.storage.readServiceHostFeedScope(ws);
  expect(undrained).toMatchObject({replicationEpoch: "epoch", streamIdentity: "stream"});
  expect(undrained?.shared).toEqual(new Map());
  const empty = await f.read();
  expect(empty.scope.documents).toEqual([]);
  expect(f.objects(empty)).toEqual(["workspace"]);
  expect(await f.blobStatus(A.sha256)).toBe(404);
  // The host's last accepted work asks to upload nothing, writes no bytes, and is refused like any op outside the scope.
  const last = blob("last accepted edit");
  expect(await (await f.request("POST", "blobs/have", JSON.stringify({sha256s: [A.sha256, last.sha256]}))).json()).toEqual({ok: true, missing: []});
  expect((await f.request("PUT", `blobs/${last.sha256}`, last.content, "application/octet-stream")).status).toBe(404);
  expect(f.uploads()).toBe(0);
  expect(await (await f.push([["ydoc.update", ydoc(binding.objectId, "docs/a.md", last)]])).json())
    .toMatchObject({refusals: [{originSeq: 0, reason: "outside-hosted-documents"}]});
  expect(f.storage.getBlob(ws, last.sha256)).toBeNull();
  expect(await f.blobStatus(last.sha256)).toBe(404);

  expect(f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: binding.objectId, nowMs: 21}))
    .toMatchObject({retired: true, enabled: false, hostDrainedAtMs: 21});
  expect(hosted()).toBeNull();
  expect(f.storage.readServiceHostFeedScope(ws)).toBeNull();

  f.storage.enrollServiceHostDocument({workspaceId: ws, path: "docs/a.md", shareId: scope.shareId, ownerUserId: "owner-1", nowMs: 22, guard() {}});
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, retire: true, nowMs: 23, guard() {}});
  expect(f.storage.rotateWorkspaceIdentity({workspaceId: ws, ownerUserId: "owner-1", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 24})).toBe("rotated");
  expect(hosted()).toBeNull();
});

it("keeps the read replica's routes and guards apart from the session host's", async () => {
  const f = await fixture();
  const principal = createReplicaReadPrincipal(f.storage);
  const get = (handle: (request: Request) => Promise<Response>, bearer: string, suffix: string) =>
    handle(new Request(`https://relay.test/sync/${ws}/${suffix}`, {headers: {authorization: `Bearer ${bearer}`}}));
  const first = principal.issue(ws, "first");
  expect((await get(principal.handle, first.bearer, `log?${identity}`)).status).toBe(200);
  expect((await get(principal.handle, first.bearer, "live-journal")).status).toBe(200);
  // Neither credential reaches the other's routes.
  expect((await get(principal.handle, first.bearer, `hosted/log?${identity}`)).status).toBe(404);
  expect((await get(f.handle, first.bearer, `hosted/log?${identity}`)).status).toBe(404);
  expect((await get(f.handle, f.bearer, "live-journal")).status).toBe(404);
  expect((await get(principal.handle, f.bearer, `log?${identity}`)).status).toBe(404);
  // Ending either principal leaves the other reading.
  principal.revoke(first);
  expect((await get(principal.handle, first.bearer, "live-journal")).status).toBe(404);
  expect((await get(f.handle, f.bearer, `hosted/log?${identity}`)).status).toBe(200);
  const second = principal.issue(ws, "second");
  f.storage.setServiceHostEnrollmentEnabled({workspaceId: ws, path: "docs/a.md", ownerUserId: "owner-1", enabled: false, nowMs: 30, guard() {}});
  f.storage.releaseServiceHostEnrollment({workspaceId: ws, objectId: binding.objectId, nowMs: 31});
  expect((await get(f.handle, f.bearer, `hosted/log?${identity}`)).status).toBe(404);
  expect((await get(principal.handle, second.bearer, "live-journal")).status).toBe(200);
});

it("admits the engine's own settlement batch for its hosted document, both ways", () => {
  const settlement = nativeAuthoredSettlement.find(op => op.opKind === "live.audit.settlement")!;
  const document = (settlement.payload as {record: {binding: {workspaceId: string; objectId: string; currentPath: string}}}).record.binding;
  const held = new Map([[document.objectId, document.currentPath]]);
  const hosted = {workspaceId: document.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream", hosted: held,
    departed: new Set<string>(), shared: held, settling: new Map(), token: "token"};
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
