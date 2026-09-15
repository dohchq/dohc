import { afterEach, describe, expect, it } from "vitest";
import { assertClientLogProvenance, COLLECTION_CREATE_ORIGIN_PREFIX } from "./relayLogInputs";
import { claimWorkspace, closeTestStorages, createShare, jsonBody, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

describe("client log provenance", () => {
  it("reserves the relay create origin even for an empty batch", () => {
    expect(() => assertClientLogProvenance(`${COLLECTION_CREATE_ORIGIN_PREFIX}grant`, [])).toThrow();
  });
  it("refuses client-stamped public moments", () => {
    expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {author: {kind: "public", principalId: "forged", grantId: "grant"}}}])).toThrow();
  });
  it("keeps neutral and agent moments writable", () => {
    expect(() => assertClientLogProvenance("device", [{opKind: "moment.append", payload: {}}, {opKind: "moment.append", payload: {author: {kind: "agent", agentId: "agent", onBehalfOf: "owner"}}}])).not.toThrow();
  });
  it("enforces the reservation and author boundary on owner and recipient uploads", async () => {
    const storage = await testStorage();
    const handler = testHandler(storage);
    await claimWorkspace(handler, "owner", "workspace");
    const share = await createShare(handler, "owner", "workspace", {recipientUserId: "recipient", paths: ["poll"], access: "edit"});
    for (const [user, url] of [["owner", "/sync/workspace/log"], ["recipient", `/sync/shares/${share}/log`]]) {
      for (const [body, status, code] of [
        [{originId: `${COLLECTION_CREATE_ORIGIN_PREFIX}grant`, ops: []},400,"bad_request"],
        [{originId: "device", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 1, payload: {author: {kind: "public", principalId: "forged", grantId: "grant"}}}]},403,"authorship_mismatch"],
      ] as const) {
        const response = await handler(request(user!, url!, jsonBody(body)));
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({code});
      }
    }
    expect(storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 100})).toEqual({rows: [], nextCursor: 0, hasMore: false});
  });
});
