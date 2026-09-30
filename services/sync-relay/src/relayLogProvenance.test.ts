import { afterEach, describe, expect, it } from "vitest";
import { assertClientLogProvenance, namedShareOrigin, SHARE_MEMBER_ORIGIN_PREFIX, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX } from "./relayLogInputs";
import { claimWorkspace, closeTestStorages, createShare, jsonBody, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const RELAY_ORIGIN_PREFIXES = [SHARE_MEMBER_ORIGIN_PREFIX, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX];
const RELAY_AUTHORS = [
  {kind: "public", principalId: "forged", grantId: "grant"},
  {kind: "named", userId: "forged", grantId: "grant", grantGeneration: 1},
  {kind: "link", grantId: "grant", grantGeneration: 1, principalId: "forged"},
  // A kind this relay does not know yet is refused, not passed through.
  {kind: "future", grantId: "grant"},
  "link",
  [],
];

describe("client log provenance", () => {
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
  it("keeps neutral, person, and agent moments writable", () => {
    expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {}}, {opKind: "moment.append", payload: {authors: [{kind: "human", humanId: "ana"}, {kind: "agent", agentId: "agent", onBehalfOf: "owner"}]}}])).not.toThrow();
  });
  it("enforces the reservation and author boundary on owner and recipient uploads", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    const refusals = [
      ...RELAY_ORIGIN_PREFIXES.map(prefix => [{originId: `${prefix}grant`, ops: []}, 400, "bad_request"] as const),
      ...RELAY_AUTHORS.map(author => [{originId: "device", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {authors: [author]}}]}, 403, "authorship_mismatch"] as const),
    ];
    for (const [user, url] of [["owner", "/sync/workspace/log"], ["recipient", `/sync/shares/${share}/log`]]) {
      for (const [body, status, code] of refusals) {
        const response = await handler(request(user!, url!, jsonBody(body)));
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({code});
      }
    }
    expect(storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 100})).toEqual({rows: [], nextCursor: 0, hasMore: false});
  });
});
