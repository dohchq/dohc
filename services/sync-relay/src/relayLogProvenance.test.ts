import { afterEach, describe, expect, it } from "vitest";
import { assertClientLogProvenance, namedShareOrigin, SHARE_MEMBER_ORIGIN_PREFIX, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX, SERVICE_HOST_ORIGIN_PREFIX, SHARED_REPLAY_ORIGIN_PREFIX } from "./relayLogInputs";
import { claimWorkspace, closeTestStorages, createShare, jsonBody, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const RELAY_ORIGIN_PREFIXES = [SHARE_MEMBER_ORIGIN_PREFIX, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX, SHARED_REPLAY_ORIGIN_PREFIX];
const RELAY_AUTHORS = [
  // A live author snapshot's account or link holder is the relay's to admit.
  {kind: "human", humanId: "recipient", humanName: "Recipient"},
  {kind: "link", publicPrincipalId: "public-link", label: "Link editor"},
  {kind: "human", humanId: "forged", onBehalfOf: "owner"},
  {kind: "public", principalId: "forged", grantId: "grant"},
  {kind: "named", userId: "forged", grantId: "grant", grantGeneration: 1},
  {kind: "link", grantId: "grant", grantGeneration: 1, principalId: "forged"},
  // A kind this relay does not know yet is refused, not passed through.
  {kind: "future", grantId: "grant"},
  {kind: "unattributed", humanId: "forged"},
  {kind: "unattributed", label: "Owner"},
  "link",
  [],
];

const nativeMomentId = `moment-ydoc-${"a".repeat(64)}`;
const publicLiveAuthors = [
  {kind: "human", humanId: "recipient", humanName: "Recipient"},
  {kind: "link", publicPrincipalId: "public-link", label: "Link editor"},
  {kind: "human", humanId: "owner", humanName: "Owner"},
  {kind: "unattributed"},
  {kind: "agent", agentId: "agent", agentName: "Agent", onBehalfOf: "owner", depth: 1},
];

describe("client log provenance", () => {
  it("does not acknowledge an altered retry as a refusal of an accepted moment", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const op = {originSeq:0,opKind:"moment.append",recordedAtMs:1,payload:{momentId:"ordinary"}};
    const upload = (payload: Record<string,unknown>) => handler(request("owner", "/sync/workspace/log",
      jsonBody({originId:"device",ops:[{...op,payload}]})));
    expect((await upload(op.payload)).status).toBe(200);
    const changed = await upload({...op.payload,authors:[RELAY_AUTHORS[0]]});
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({code:"conflict"});
    expect(storage.fetchLogCoordinate({workspaceId:"workspace",originId:"device",originSeq:0})?.settlementAdmission)
      .toBeUndefined();
  });
  it("keeps member origin tuple boundaries unambiguous", () => {
    const origins = [
      namedShareOrigin("share:a", "b", "c"),
      namedShareOrigin("share", "a:b", "c"),
      namedShareOrigin("share", "a", "b:c"),
    ];
    expect(new Set(origins).size).toBe(3);
    expect(origins.every(origin => /^relay:share-member:[a-f0-9]{64}$/.test(origin))).toBe(true);
  });
  it("reserves the relay origins even for an empty batch", () => {
    for (const prefix of [...RELAY_ORIGIN_PREFIXES, SERVICE_HOST_ORIGIN_PREFIX]) {
      expect(() => assertClientLogProvenance(`${prefix}grant`, [])).toThrow();
    }
  });
  it.each(["owner", "recipient"] as const)("refuses an %s that writes as a replayed link origin", async user => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    const body = {originId: "shared:x:relay:share-link:p", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {}}]};
    const url = user === "owner" ? "/sync/workspace/log" : `/sync/shares/${share}/log`;
    const response = await handler(request(user, url, jsonBody(body)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({code: "bad_request"});
    expect(storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 100}).rows).toEqual([]);
  });
  it("lets only the service host's feed write from its reserved origins", () => {
    expect(() => assertClientLogProvenance(`${SERVICE_HOST_ORIGIN_PREFIX}host`, [], {serviceHost: true})).not.toThrow();
    for (const origin of ["device", `${SHARE_MEMBER_ORIGIN_PREFIX}grant`]) {
      expect(() => assertClientLogProvenance(origin, [], {serviceHost: true})).toThrow();
    }
  });
  it("refuses client-stamped relay moments", () => {
    const agent = {kind: "agent", agentId: "agent", onBehalfOf: "owner"};
    for (const author of RELAY_AUTHORS) {
      expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {authors: [author]}}])).toThrow();
      expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {authors: [agent, author]}}])).toThrow();
    }
  });
  it("keeps neutral, unattributed, agent, and automation moments writable", () => {
    expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {}}, {opKind: "moment.append", payload: {authors: [{kind: "automation", automationId: "collection:Tasks#stamp", depth: 1}, {kind: "agent", agentId: "agent", onBehalfOf: "owner"}]}}])).not.toThrow();
    for (const authors of [[{kind: "unattributed"}], [{kind: "unattributed"}, {kind: "agent", agentId: "agent"}, {kind: "automation", automationId: "stamp"}]]) {
      expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {authors}}])).not.toThrow();
    }
  });
  it("enforces the reservation and author boundary on owner and recipient uploads", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    const refusals = [
      ...RELAY_ORIGIN_PREFIXES.map(prefix => [{originId: `${prefix}grant`, ops: []}, 400, "bad_request"] as const),
      ...RELAY_AUTHORS.map((author,index) => [{originId: `device-${index}`, ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {authors: [author]}}]}, 403, "authorship_mismatch"] as const),
      ...publicLiveAuthors.filter(author => author.kind !== "agent" && author.kind !== "unattributed").map((author,index) => [{originId: `native-device-${index}`, ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
        payload: {momentId: nativeMomentId, authors: [author]}}]}, 403, "authorship_mismatch"] as const),
    ];
    for (const [user, url] of [["owner", "/sync/workspace/log"], ["recipient", `/sync/shares/${share}/log`]]) {
      for (const [body, status, code] of refusals) {
        const response = await handler(request(user!, url!, jsonBody(body)));
        if(user === "owner" && code === "authorship_mismatch"){
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({currentMaxOriginSeq:0,settlementRefusals:[{originSeq:0,reason:"authorship-mismatch"}]});
        }else{
          expect(response.status).toBe(status);
          expect(await response.json()).toMatchObject({code});
        }
      }
    }
    const page=storage.fetchLogPage({workspaceId:"workspace",sinceRelaySeq:0,limit:100});
    expect(page.rows).toHaveLength(RELAY_AUTHORS.length + publicLiveAuthors.filter(author => author.kind !== "agent" && author.kind !== "unattributed").length);
    expect(page.rows.every(row=>row.settlementAdmission?.status === "refused")).toBe(true);
    expect(page.rows.every(row=>!Object.hasOwn(JSON.parse(row.payloadJson), "authors"))).toBe(true);
    const served = await handler(request("owner", "/sync/workspace/log?since=0&limit=100"));
    expect(served.status).toBe(200);
    const body = await served.json() as {ops: {payload: Record<string, unknown>}[]};
    expect(body.ops).toHaveLength(RELAY_AUTHORS.length + publicLiveAuthors.filter(author => author.kind !== "agent" && author.kind !== "unattributed").length);
    expect(body.ops.every(op=>!Object.hasOwn(op.payload, "authors"))).toBe(true);
    const retry = await handler(request("owner", "/sync/workspace/log", jsonBody({
      originId: "device-0", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
        payload: {authors: [RELAY_AUTHORS[0]]}}],
    })));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({inserted:0, skipped:1, currentMaxOriginSeq:0});
  });
  it("stores an owner's hosted agent settlement once its people are left out", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    // What the engine publishes for a settled [account holder, declared agent] snapshot.
    const authors = [{kind: "agent", agentId: "writer", agentName: "Writer", onBehalfOf: "owner", depth: 0}];
    const response = await handler(request("owner", "/sync/workspace/log", jsonBody({originId: "device", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {authors}}]})));
    expect(response.status).toBe(200);
    const [row, ...rest] = storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 100}).rows;
    expect(rest).toEqual([]);
    expect(row?.opKind).toBe("moment.append");
    expect(JSON.parse(row!.payloadJson)).toEqual({authors});
  });
  it("accepts owner device settlement coverage without granting recipients moment writes", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    const snapshots = [[{kind: "unattributed"}], [{kind: "unattributed"}, {kind: "agent", agentId: "agent", onBehalfOf: "owner"}]];
    for (const [originSeq, authors] of snapshots.entries()) {
      const response = await handler(request("owner", "/sync/workspace/log", jsonBody({originId: "owner-device", ops: [
        {originSeq, opKind: "moment.append", recordedAtMs: 1, payload: {momentId: nativeMomentId, path: "poll/record.md", authors}},
      ]})));
      expect(response.status).toBe(200);
      const recipient = await handler(request("recipient", `/sync/shares/${share}/log`, jsonBody({originId: "recipient-device", ops: [
        {originSeq, opKind: "moment.append", recordedAtMs: 1, payload: {momentId: nativeMomentId, path: "poll/record.md", authors}},
      ]})));
      expect(recipient.status).toBe(403);
      expect(await recipient.json()).toMatchObject({code: "share_op_rejected"});
    }
    const rows = storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 100}).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(JSON.parse(row.payloadJson).authors[0]).toEqual({kind: "unattributed"});
  });
});
