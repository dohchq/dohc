import { afterEach, describe, expect, it } from "vitest";
import { assertClientLogProvenance, namedShareOrigin, SHARE_MEMBER_ORIGIN_PREFIX, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX } from "./relayLogInputs";
import { claimWorkspace, closeTestStorages, createShare, jsonBody, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const RELAY_ORIGIN_PREFIXES = [SHARE_MEMBER_ORIGIN_PREFIX, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX];
const RELAY_AUTHORS = [
  {kind: "human", humanId: "forged", onBehalfOf: "owner"},
  {kind: "public", principalId: "forged", grantId: "grant"},
  {kind: "named", userId: "forged", grantId: "grant", grantGeneration: 1},
  {kind: "link", grantId: "grant", grantGeneration: 1, principalId: "forged"},
  // A kind this relay does not know yet is refused, not passed through.
  {kind: "future", grantId: "grant"},
  "link",
  [],
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
    for (const prefix of RELAY_ORIGIN_PREFIXES) {
      expect(() => assertClientLogProvenance(`${prefix}grant`, [])).toThrow();
    }
  });
  it("refuses client-stamped relay moments", () => {
    const agent = {kind: "agent", agentId: "agent", onBehalfOf: "owner"};
    for (const author of RELAY_AUTHORS) {
      expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {authors: [author]}}])).toThrow();
      expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {authors: [agent, author]}}])).toThrow();
    }
  });
  it("keeps neutral, agent, and automation moments writable", () => {
    expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {}}, {opKind: "moment.append", payload: {authors: [{kind: "automation", automationId: "collection:Tasks#stamp", depth: 1}, {kind: "agent", agentId: "agent", onBehalfOf: "owner"}]}}])).not.toThrow();
  });
  it("enforces the reservation and author boundary on owner and recipient uploads", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    const refusals = [
      ...RELAY_ORIGIN_PREFIXES.map(prefix => [{originId: `${prefix}grant`, ops: []}, 400, "bad_request"] as const),
      ...RELAY_AUTHORS.map((author,index) => [{originId: `device-${index}`, ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {authors: [author]}}]}, 403, "authorship_mismatch"] as const),
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
    expect(page.rows).toHaveLength(RELAY_AUTHORS.length);
    expect(page.rows.every(row=>row.settlementAdmission?.status === "refused")).toBe(true);
    expect(page.rows.every(row=>!Object.hasOwn(JSON.parse(row.payloadJson), "authors"))).toBe(true);
    const served = await handler(request("owner", "/sync/workspace/log?since=0&limit=100"));
    expect(served.status).toBe(200);
    const body = await served.json() as {ops: {payload: Record<string, unknown>}[]};
    expect(body.ops).toHaveLength(RELAY_AUTHORS.length);
    expect(body.ops.every(op=>!Object.hasOwn(op.payload, "authors"))).toBe(true);
    const retry = await handler(request("owner", "/sync/workspace/log", jsonBody({
      originId: "device-0", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
        payload: {authors: [RELAY_AUTHORS[0]]}}],
    })));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({inserted:0, skipped:1, currentMaxOriginSeq:0});
  });
});
