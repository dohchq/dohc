import { afterEach, describe, expect, it } from "vitest";
import { assertClientLogProvenance, COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX } from "./relayLogInputs";
import { claimWorkspace, closeTestStorages, createShare, jsonBody, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const RELAY_ORIGIN_PREFIXES = [COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX];
const RELAY_AUTHORS = [
  {kind: "public", principalId: "forged", grantId: "grant"},
  {kind: "named", userId: "forged", grantId: "grant", grantGeneration: 1},
];

describe("client log provenance", () => {
  it("reserves the relay origins even for an empty batch", () => {
    for (const prefix of RELAY_ORIGIN_PREFIXES) {
      expect(() => assertClientLogProvenance(`${prefix}grant`, [])).toThrow();
    }
  });
  it("refuses client-stamped public and named moments", () => {
    for (const author of RELAY_AUTHORS) {
      expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {author}}])).toThrow();
    }
  });
  it("keeps neutral and agent moments writable", () => {
    expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {}}, {opKind: "moment.append", payload: {author: {kind: "agent", agentId: "agent", onBehalfOf: "owner"}}}])).not.toThrow();
  });
  it("enforces the reservation and author boundary on owner and recipient uploads", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    const refusals = [
      ...RELAY_ORIGIN_PREFIXES.map(prefix => [{originId: `${prefix}grant`, ops: []}, 400, "bad_request"] as const),
      ...RELAY_AUTHORS.map(author => [{originId: "device", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {author}}]}, 403, "authorship_mismatch"] as const),
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
