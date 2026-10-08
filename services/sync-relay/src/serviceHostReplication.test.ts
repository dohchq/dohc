import {afterEach, expect, it} from "vitest";
import nativeAuthoredSettlement from "./testing/fixtures/nativeAuthoredSettlement.json";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {parseLogOp} from "./relayLogInputs";
import {referencedBlobShas} from "./storage/blobReferences";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const key = new Uint8Array(32).fill(17), namespace = "service-provenance-test";

async function fixture(provenance?: "native-settlements") {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const enrollment = f.storage.enrollServiceHostDocument({workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId,
    path: binding.currentPath, nowMs: 10, guard() {}});
  const bearer = deriveServiceHostBearer(enrollment, {key, namespace});
  const handle = createServiceHostReplication({storage: f.storage, prefix: "dohc-service-v1.", provenance,
    authorize: input => authorizeServiceHostReplication(f.storage, {key, namespace, ...input})});
  const post = (ops: unknown[], originId = "native-service") => handle(new Request(`https://relay.test/sync/${scope.workspaceId}/log`, {
    method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
    body: JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId, ops}),
  }));
  return {...f, post};
}

it("publishes the native mixed batch beyond its cursor while refusing unproved authors", async () => {
  const f = await fixture("native-settlements");
  f.storage.appendLogBatch({workspaceId: scope.workspaceId, originId: "native-service", ops: [0, 1, 2].map(originSeq => parseLogOp({
    originSeq, opKind: "moment.append", recordedAtMs: 1, payload: {},
  }))});
  // Provenance replay: the relay validates blob presence; native blob contents are tested by the engine.
  for (const op of nativeAuthoredSettlement) {
    for (const sha256 of referencedBlobShas(op.opKind, JSON.stringify(op.payload), {workspaceId: scope.workspaceId, recordedAtMs: op.recordedAtMs})) {
      f.storage.putBlob({workspaceId: scope.workspaceId, sha256, content: new Uint8Array([0]), createdAtMs: 1});
    }
  }
  const response = await f.post(nativeAuthoredSettlement);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ok: true, accepted: 10, inserted: 10, skipped: 0, currentMaxOriginSeq: 12});
  for (const op of nativeAuthoredSettlement) {
    const row = f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "native-service", originSeq: op.originSeq});
    expect(row?.opKind).toBe(op.opKind);
    if (op.opKind === "moment.append" && Object.hasOwn(op.payload, "authors")) {
      const {authors: _authors, ...expected} = op.payload as Record<string, unknown>;
      expect(JSON.parse(row!.payloadJson)).toEqual(expected);
      expect(row?.settlementAdmission?.status).toBe("refused");
      expect(row?.admittedAuthorSnapshot).toBeUndefined();
    } else expect(JSON.parse(row!.payloadJson)).toEqual(op.payload);
  }
});

it("consumes unproved authored settlements on the client route without granting attribution", async () => {
  const f = await fixture();
  f.storage.appendLogBatch({workspaceId: scope.workspaceId, originId: "native-service", ops: [0, 1, 2].map(originSeq => parseLogOp({originSeq, opKind: "moment.append", recordedAtMs: 1, payload: {}}))});
  for (const op of nativeAuthoredSettlement) {
    for (const sha256 of referencedBlobShas(op.opKind, JSON.stringify(op.payload), {workspaceId: scope.workspaceId, recordedAtMs: op.recordedAtMs})) {
      f.storage.putBlob({workspaceId: scope.workspaceId, sha256, content: new Uint8Array([0]), createdAtMs: 1});
    }
  }
  const response = await f.post(nativeAuthoredSettlement);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({currentMaxOriginSeq: 12});
  for (const op of nativeAuthoredSettlement.filter(op => op.opKind === "moment.append")) {
    const row = f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "native-service", originSeq: op.originSeq});
    expect(JSON.parse(row!.payloadJson)).not.toHaveProperty("authors");
  }
});

it("refuses unproved mixed service authors without stalling the next coordinate", async () => {
  const f = await fixture("native-settlements");
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

it("keeps chat validation and origin reservations on the trusted service route", async () => {
  const f = await fixture("native-settlements");
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
