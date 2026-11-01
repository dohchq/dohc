import {afterEach, expect, it} from "vitest";
import nativeAuthoredSettlement from "./testing/fixtures/nativeAuthoredSettlement.json";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {AUTOMATION_REPLICA_BEARER_PREFIX} from "./automationReplicaCredential";
import {parseLogOp} from "./relayLogInputs";
import {referencedBlobShas} from "./storage/blobReferences";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const key = new Uint8Array(32).fill(17), namespace = "service-provenance-test";

// Ordinary replication for a replica credential this server derived, as its automation replicas use.
async function fixture() {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const bearer = `${AUTOMATION_REPLICA_BEARER_PREFIX}${"a".repeat(43)}`;
  const handle = createServiceHostReplication({storage: f.storage, prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: input => input.bearer === bearer && input.workspaceId === scope.workspaceId ? "owner-1" : null});
  const post = (ops: unknown[], originId = "native-service") => handle(new Request(`https://relay.test/sync/${scope.workspaceId}/log`, {
    method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
    body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId, ops}),
  }));
  const get = (path: string) => handle(new Request(`https://relay.test/sync/${scope.workspaceId}${path}`, {
    headers: {authorization: `Bearer ${bearer}`},
  }));
  return {...f, post, get};
}

// Proves: the session host's credential reaches its scoped feed only. Every
// ordinary replication route answers as an absent one.
it("gives the service host credential 404 on every ordinary replication route", async () => {
  const f = await fixture();
  const enrollment = f.storage.enrollServiceHostDocument({workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId,
    path: binding.currentPath, nowMs: 10, guard() {}});
  const bearer = deriveServiceHostBearer(enrollment, {key, namespace});
  const handle = createServiceHostReplication({storage: f.storage, prefix: "dohc-service-v1.", hostedFeed: true,
    authorize: input => authorizeServiceHostReplication(f.storage, {key, namespace, ...input})});
  const request = (method: string, suffix: string, body?: string) => handle(new Request(`https://relay.test/sync/${scope.workspaceId}/${suffix}`,
    {method, headers: {authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : {"content-type": "application/json"})}, body}));
  const blob = "a".repeat(64);
  for (const [method, suffix, body] of [["GET", "bootstrap"], ["GET", "log?replicationEpoch=epoch&streamIdentity=stream&since=0"],
    ["POST", "log", JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: "service", ops: []})], ["GET", "log/owner/0"],
    ["GET", `blobs/${blob}`], ["PUT", `blobs/${blob}`, "x"], ["POST", "blobs/have", JSON.stringify({sha256s: [blob]})]] as const) {
    expect((await request(method, suffix, body)).status, `${method} ${suffix}`).toBe(404);
  }
  const hosted = await request("GET", "hosted/bootstrap");
  expect(hosted.status).toBe(200);
  expect(await hosted.json()).toMatchObject({replicationEpoch: "epoch", streamIdentity: "stream"});
});

// #2088: an empty push to the hosted log is the session host's origin probe.
// It stores nothing and answers the highest position the relay holds at that origin.
it("answers an empty hosted push with its origin's highest position and stores nothing", async () => {
  const f = await fixture();
  const enrollment = f.storage.enrollServiceHostDocument({workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId,
    path: binding.currentPath, nowMs: 10, guard() {}});
  const bearer = deriveServiceHostBearer(enrollment, {key, namespace});
  const handle = createServiceHostReplication({storage: f.storage, prefix: "dohc-service-v1.", hostedFeed: true,
    authorize: input => authorizeServiceHostReplication(f.storage, {key, namespace, ...input})});
  const origin = "service-host:host";
  const probe = async () => {
    const response = await handle(new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/log`, {method: "POST",
      headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
      body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: origin, ops: []})}));
    expect(response.status).toBe(200);
    return response.json();
  };
  const rows = () => f.raw.prepare("SELECT origin_id,origin_seq FROM sync_relay_log WHERE workspace_id=? ORDER BY relay_seq").all(scope.workspaceId);
  const empty = rows();
  expect(await probe()).toMatchObject({ok: true, accepted: 0, inserted: 0, skipped: 0, currentMaxOriginSeq: -1});
  expect(rows()).toEqual(empty);
  f.storage.appendLogBatch({workspaceId: scope.workspaceId, originId: origin, ops: [0, 1].map(originSeq => parseLogOp({
    originSeq, opKind: "moment.append", recordedAtMs: 1, payload: {},
  }))});
  const held = rows();
  expect(await probe()).toMatchObject({ok: true, accepted: 0, inserted: 0, skipped: 0, currentMaxOriginSeq: 1});
  expect(rows()).toEqual(held);
});

it("answers a replica's held read at once and never reports a watch", async () => {
  const f = await fixture();
  const plain = await f.get("/log?replicationEpoch=epoch&streamIdentity=stream&since=1&hold=30000");
  const reported = await f.get("/log?replicationEpoch=epoch&streamIdentity=stream&since=1&hold=30000&watched=1");
  expect(plain.status).toBe(200);
  const body = await plain.text();
  expect(body).not.toContain("watched");
  expect(await reported.text()).toBe(body);
});

it("publishes the native batch beyond its cursor as the engine wrote it", async () => {
  const f = await fixture();
  f.storage.appendLogBatch({workspaceId: scope.workspaceId, originId: "native-service", ops: [0, 1, 2].map(originSeq => parseLogOp({
    originSeq, opKind: "moment.append", recordedAtMs: 1, payload: {},
  }))});
  const ops = nativeAuthoredSettlement.map(op => ({...op, originSeq: op.originSeq + 3}));
  // Provenance replay: the relay validates blob presence; native blob contents are tested by the engine.
  for (const op of ops) {
    for (const sha256 of referencedBlobShas(op.opKind, JSON.stringify(op.payload), {workspaceId: scope.workspaceId, recordedAtMs: op.recordedAtMs})) {
      f.storage.putBlob({workspaceId: scope.workspaceId, sha256, content: new Uint8Array([0]), createdAtMs: 1});
    }
  }
  const response = await f.post(ops);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ok: true, accepted: 8, inserted: 8, skipped: 0, currentMaxOriginSeq: 10});
  for (const op of ops) {
    const row = f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "native-service", originSeq: op.originSeq});
    expect(row?.opKind).toBe(op.opKind);
    expect(JSON.parse(row!.payloadJson)).toEqual(op.payload);
  }
});

it("refuses unproved mixed service authors without stalling the next coordinate", async () => {
  const f = await fixture();
  const authors = [
    {kind: "human", humanId: "recipient", humanName: "Recipient"},
    {kind: "link", publicPrincipalId: "public-link", label: "Link editor"},
    {kind: "human", humanId: "owner", humanName: "Owner"},
    {kind: "unattributed"},
    {kind: "agent", agentId: "agent", onBehalfOf: "owner", depth: 1},
  ];
  const response = await f.post([{originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
    payload: {momentId: `moment-ydoc-${"a".repeat(64)}`, authors}},
    {originSeq: 1, opKind: "moment.append", recordedAtMs: 2, payload: {momentId: "ordinary", authors: [{kind: "unattributed"}]}}]);
  expect(response.status).toBe(200);
  const row = f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "native-service", originSeq: 0});
  expect(JSON.parse(row!.payloadJson)).not.toHaveProperty("authors");
  expect(row?.settlementAdmission).toMatchObject({status: "refused"});
  expect(row?.admittedAuthorSnapshot).toBeUndefined();
  const next = f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "native-service", originSeq: 1});
  expect(JSON.parse(next!.payloadJson).authors).toEqual([{kind: "unattributed"}]);
  const retry = await f.post([{originSeq: 2, opKind: "moment.append", recordedAtMs: 3, payload: {momentId: "next"}}]);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({currentMaxOriginSeq: 2});
});

it("keeps chat validation and origin reservations on the trusted replica route", async () => {
  const f = await fixture();
  for (const origin of ["relay:share-member:grant", "relay:collection-create:grant", "relay:collection-file:grant"]) {
    const response = await f.post([], origin);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({code: "bad_request"});
  }
  for (const [opKind, payload, code] of [
    ["chat.message.append", {authorUserId: "recipient"}, "authorship_mismatch"],
    ["chat.message.append", {}, "authorship_mismatch"],
    ["chat.future.write", {authorUserId: "owner-1"}, "unknown_chat_op"],
  ] as const) {
    const response = await f.post([
      {originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {momentId: `moment-ydoc-${"a".repeat(64)}`,
        authors: [{kind: "human", humanId: "recipient", humanName: "Recipient"}]}},
      {originSeq: 1, opKind, recordedAtMs: 1, payload},
    ]);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code});
    expect(f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "native-service", originSeq: 0})).toBeNull();
  }
});
