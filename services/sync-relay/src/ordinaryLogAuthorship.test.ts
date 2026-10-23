import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { parseAuthenticatedLogOps } from "./relayLogInputs";
import { stableJsonStringify } from "./canonicalJson";
import { createShareReadQueries } from "./shareReadQueries";
import { claimWorkspace, closeTestStorage, closeTestStorages, inspectDatabase, jsonBody, putBlob, reopenTestStorage, request, storagePath, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

function update(payload: Record<string, unknown>, originSeq = 0) {
  return {originSeq, opKind: "ydoc.update", payload, recordedAtMs: 1};
}
const context = {kind: "account", accountId: "alice"};
const snapshot: LiveAuthorSnapshot = [{kind: "human", humanId: "alice", humanName: "Alice"}];

describe("ordinary admitted authorship", () => {
  it("reuses account names across pushes for five seconds and isolates accounts", async () => {
    let now = 2000;
    const lookup = vi.fn((id: string) => `${id} at ${now}`);
    const storage = await testStorage();
    const handler = testHandler(storage, {lookupUserDisplayName: lookup, nowMs: () => now});
    for (const id of ["alice", "bob"]) await claimWorkspace(handler, id, id);
    const push = async (id: string, seq: number) => {
      const response = await handler(request(id, `/sync/${id}/log`, jsonBody({originId: "device",
        ops: [update({authorContext: {kind: "account", accountId: id}}, seq)]})));
      expect(response.status).toBe(200);
      return storage.fetchLogCoordinate({workspaceId: id, originId: "device", originSeq: seq})?.admittedAuthorSnapshot;
    };
    expect(await push("alice", 0)).toEqual([{kind: "human", humanId: "alice", humanName: "alice at 2000"}]);
    now = 6999;
    expect(await push("alice", 1)).toEqual([{kind: "human", humanId: "alice", humanName: "alice at 2000"}]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await push("bob", 0)).toEqual([{kind: "human", humanId: "bob", humanName: "bob at 6999"}]);
    now = 7000;
    expect(await push("alice", 2)).toEqual([{kind: "human", humanId: "alice", humanName: "alice at 7000"}]);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("retries a failed account lookup on the next push", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error("accounts unavailable")).mockResolvedValue("Alice");
    const storage = await testStorage();
    const handler = testHandler(storage, {lookupUserDisplayName: lookup});
    await claimWorkspace(handler, "alice", "workspace");
    for (let seq = 0; seq < 2; seq++) {
      const response = await handler(request("alice", "/sync/workspace/log", jsonBody({originId: "device",
        ops: [update({authorContext: context}, seq)]})));
      expect(response.status).toBe(200);
    }
    expect(storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 0})?.admittedAuthorSnapshot)
      .toEqual([{kind: "human", humanId: "alice", humanName: "Unnamed"}]);
    expect(storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 1})?.admittedAuthorSnapshot).toEqual(snapshot);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(["ydoc.update", "moment.append"])("names solo owner typing on %s without trusting a client name", async opKind => {
    const storage = await testStorage();
    const handler = testHandler(storage, {lookupUserDisplayName: () => "Alice"});
    await claimWorkspace(handler, "alice", "workspace");
    const sha = await putBlob(handler, "alice", "workspace", "Owner typing");
    const payload = {authorContext: context, ...(opKind === "moment.append" ? {
      momentId: "solo-moment", versionId: "main", objectId: "doc", path: "doc.md", operation: "write",
      payloadAfterPath: "doc.md", payloadAfterBlobSha256: sha,
    } : {})};
    expect((await handler(request("alice", "/sync/workspace/log", jsonBody({originId: "solo-device",
      ops: [{...update(payload), opKind}]})))).status).toBe(200);
    expect(storage.fetchLogCoordinate({workspaceId: "workspace", originId: "solo-device", originSeq: 0})?.admittedAuthorSnapshot).toEqual(snapshot);
    if (opKind === "moment.append") {
      const queries = createShareReadQueries(storage, 500);
      for (const audience of ["authenticated", "accountless"] as const) {
        const page = queries.filteredLogPage("workspace", "share", {paths: ["doc.md"], versionId: null, access: "view"}, 0, 10, audience);
        expect(page.ops).toHaveLength(1);
        expect(page.ops[0]!.payload).not.toHaveProperty("authorContext");
        if (audience === "authenticated") expect(page.ops[0]!.payload).toHaveProperty("authors", snapshot);
        else expect(page.ops[0]!.payload).not.toHaveProperty("authors");
      }
    }
  });

  it.each(["ydoc.update", "moment.append"])("keeps a replayed recipient context unnamed under the owner on %s", async opKind => {
    const payload = {authorContext: {kind: "account", accountId: "recipient"}};
    const lookup = vi.fn(() => "Alice");
    const [admitted] = await parseAuthenticatedLogOps([{...update(payload), opKind}], "alice", lookup);
    expect(admitted?.admittedAuthorSnapshot).toBeUndefined();
    expect(admitted?.payloadJson).toBe(stableJsonStringify(opKind === "moment.append" ? {} : payload));
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["ydoc.update", "moment.append"])("binds a recipient's logged agent and preserves owner replay bytes on %s", async opKind => {
    const storage = await testStorage();
    const payload = {authorContext: {kind: "account", accountId: "recipient",
      agent: {agentId: "writer", agentName: "Writer", onBehalfOf: "owner", depth: 1}}};
    const ops = [{...update(payload), opKind}];
    const expected = [{kind: "human", humanId: "recipient", humanName: "Recipient"},
      {kind: "agent", ...payload.authorContext.agent, onBehalfOf: "recipient"}];
    storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1});
    const admitted = await parseAuthenticatedLogOps(ops, "recipient", () => "Recipient");
    expect(admitted[0]?.admittedAuthorSnapshot).toEqual(expected);
    expect(admitted[0]?.payloadJson).toBe(stableJsonStringify(payload));
    expect(storage.appendLogBatch({workspaceId: "workspace", originId: "recipient-device", ops: admitted}).inserted).toBe(1);
    const retry = await parseAuthenticatedLogOps(ops, "owner", () => "Owner");
    expect(storage.appendLogBatch({workspaceId: "workspace", originId: "recipient-device", ops: retry})).toMatchObject({inserted: 0, skipped: 1});
    expect(storage.fetchLogCoordinate({workspaceId: "workspace", originId: "recipient-device", originSeq: 0}))
      .toMatchObject({payloadJson: stableJsonStringify(payload), admittedAuthorSnapshot: expected});
  });

  it("uses the authenticated account and trusted name while retaining declared agent fields and payload bytes", async () => {
    const payload = {authorContext: {...context, agent: {agentId: "codex", agentName: "Codex", onBehalfOf: "alice", depth: 1}},
      attribution: {humanId: "forged", humanName: "Forged"}};
    const op = {...update(payload), admittedAuthorSnapshot: [{kind: "human", humanId: "forged", humanName: "Forged"}]};
    const lookup = vi.fn(async () => "Alice");
    const [admitted] = await parseAuthenticatedLogOps([op], "alice", lookup);
    expect(admitted?.admittedAuthorSnapshot).toEqual([...snapshot, {kind: "agent", agentId: "codex", agentName: "Codex", onBehalfOf: "alice", depth: 1}]);
    expect(admitted?.payloadJson).toBe(stableJsonStringify(payload));
    expect(lookup).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it.each([
    {},
    {attribution: {humanId: "alice", humanName: "Client name"}},
    {authorContext: {kind: "account", accountId: "bob", agent: {agentId: "forged"}}},
    {authorContext: {kind: "signed-out", agent: {agentId: "unsigned"}}},
    {authorContext: {kind: "link", publicPrincipalId: "public-link"}},
  ])("admits absent, legacy, mismatched, signed-out and link contexts unnamed: %j", async payload => {
    const lookup = vi.fn(() => "Alice");
    for (const opKind of ["ydoc.update", "moment.append"]) {
      const [admitted] = await parseAuthenticatedLogOps([{...update(payload), opKind}], "alice", lookup);
      expect(admitted?.admittedAuthorSnapshot).toBeUndefined();
      expect(admitted?.payloadJson).toBe(stableJsonStringify(payload));
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    {settlementReference: {}},
    {attributionUnavailable: {settlementId: "unavailable", reason: "unproven-hosted-authors"}},
    {authors: [{kind: "agent", agentId: "writer", onBehalfOf: "alice"}]},
    {authors: [{kind: "unattributed"}]},
  ])("does not replace settlement or declared moment authors with the owner: %j", async fields => {
    const payload = {...fields, authorContext: context};
    const lookup = vi.fn(() => "Alice");
    const [admitted] = await parseAuthenticatedLogOps([{...update(payload), opKind: "moment.append"}], "alice", lookup);
    expect(admitted?.admittedAuthorSnapshot).toBeUndefined();
    expect(admitted?.payloadJson).toBe(stableJsonStringify("authors" in fields ? fields : payload));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("ignores author-shaped fields on other op kinds and rejects malformed new context", async () => {
    const lookup = vi.fn(() => "Alice");
    const [admitted] = await parseAuthenticatedLogOps([{...update({authorContext: context}), opKind: "opaque"}], "alice", lookup);
    expect(admitted?.admittedAuthorSnapshot).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    await expect(parseAuthenticatedLogOps([update({authorContext: {...context, humanName: "Forged"}})], "alice", lookup)).rejects.toThrow("invalid ydoc.update authorContext");
    await expect(parseAuthenticatedLogOps([{...update({authorContext: {...context, humanName: "Forged"}}), opKind: "moment.append"}], "alice", lookup)).rejects.toThrow("invalid moment.append authorContext");
  });

  it("bounds server names and declared agent entries by serialized bytes", async () => {
    for (const name of [null, "", "x".repeat(513)]) {
      const [admitted] = await parseAuthenticatedLogOps([update({authorContext: context})], "alice", () => name);
      expect(admitted?.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "alice", humanName: "Unnamed"}]);
    }
    const escaped = "\u0001".repeat(350);
    await expect(parseAuthenticatedLogOps([update({authorContext: {...context, agent: {agentId: escaped, agentName: escaped}}})], "alice", () => "Alice")).rejects.toThrow("invalid ydoc.update authorContext");
  });

  it.each(["ydoc.update", "moment.append"])("stores an owner %s unnamed when the name lookup throws or rejects", async opKind => {
    for (const lookupUserDisplayName of [() => {throw new Error("accounts unavailable");},
      () => Promise.reject(new Error("accounts unavailable"))]) {
      const storage = await testStorage();
      const handler = testHandler(storage, {lookupUserDisplayName});
      await claimWorkspace(handler, "alice", "workspace");
      const sha = await putBlob(handler, "alice", "workspace", "Owner typing");
      const payload = {authorContext: context, ...(opKind === "moment.append" ? {
        momentId: "solo-moment", versionId: "main", objectId: "doc", path: "doc.md", operation: "write",
        payloadAfterPath: "doc.md", payloadAfterBlobSha256: sha,
      } : {})};
      const response = await handler(request("alice", "/sync/workspace/log", jsonBody({originId: "device",
        ops: [{...update(payload), opKind}]})));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({inserted: 1});
      const row = storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 0});
      const {authorContext: _claim, ...content} = payload;
      expect(row?.payloadJson).toBe(stableJsonStringify(opKind === "moment.append" ? content : payload));
      expect(row?.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "alice", humanName: "Unnamed"}]);
    }
  });

  it.each([undefined, null, ""])("rejects an account context without an account identity: %j", async accountId => {
    const lookup = vi.fn(() => "Alice");
    for (const opKind of ["ydoc.update", "moment.append"]) {
      await expect(parseAuthenticatedLogOps([{...update({authorContext: {kind: "account", accountId}}), opKind}],
        "alice", lookup)).rejects.toThrow(`invalid ${opKind} authorContext`);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps the first admitted snapshot through renamed account retries, restart and every owner retrieval path", async () => {
    const storage = await testStorage();
    let name = "Alice";
    const handler = testHandler(storage, {lookupUserDisplayName: () => name});
    await claimWorkspace(handler, "alice", "workspace");
    const payload = {authorContext: context, attribution: {humanName: "Client name"}};
    const body = {originId: "device", ops: [update(payload)]};
    expect((await handler(request("alice", "/sync/workspace/log", jsonBody(body)))).status).toBe(200);
    name = "Renamed";
    const retry = await handler(request("alice", "/sync/workspace/log", jsonBody(body)));
    expect(await retry.json()).toMatchObject({inserted: 0, skipped: 1});
    for (const row of [
      storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 10}).rows[0],
      storage.fetchLogPageDescending({workspaceId: "workspace", beforeRelaySeq: null, limit: 10})[0],
      storage.fetchLogPageDescending({workspaceId: "workspace", beforeRelaySeq: 2, limit: 10})[0],
      storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 0}),
    ]) {
      expect(row?.admittedAuthorSnapshot).toEqual(snapshot);
      expect(row?.payloadJson).toBe(stableJsonStringify(payload));
    }
    const page = await (await handler(request("alice", "/sync/workspace/log"))).json();
    expect(page.ops[0]).toMatchObject({admittedAuthorSnapshot: snapshot, payload});
    const coordinate = await (await handler(request("alice", "/sync/workspace/log/device/0"))).json();
    expect(coordinate).toMatchObject({status: "present", op: {admittedAuthorSnapshot: snapshot, payload}});
    const db = inspectDatabase(storagePath(storage));
    expect(db.prepare("SELECT admitted_author_snapshot_json FROM sync_relay_log").get()?.admitted_author_snapshot_json).toBe(JSON.stringify(snapshot));
    db.close();
    const path = storagePath(storage);
    closeTestStorage(storage);
    const reopened = reopenTestStorage(path);
    expect(reopened.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 0})?.admittedAuthorSnapshot).toEqual(snapshot);
    expect(reopened.appendLogBatch({workspaceId: "workspace", originId: "device",
      ops: await parseAuthenticatedLogOps(body.ops, "bob", () => "Bob")})).toMatchObject({inserted: 0, skipped: 1});
    expect(reopened.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 0})?.admittedAuthorSnapshot).toEqual(snapshot);
  });

  it("accounts snapshot bytes in quota admission and usage, then releases them on deletion", async () => {
    const [op] = await parseAuthenticatedLogOps([update({authorContext: context})], "alice", () => "Alice");
    const payloadBytes = Buffer.byteLength(op!.payloadJson);
    const stampBytes = Buffer.byteLength(JSON.stringify(snapshot));
    const storage = await testStorage({workspaceQuotaBytes: payloadBytes + stampBytes - 1});
    storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "alice", createdAtMs: 1});
    expect(() => storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: [op!]})).toThrow();
    expect(storage.fetchLogPage({workspaceId: "workspace", sinceRelaySeq: 0, limit: 10}).rows).toEqual([]);
    const other = await testStorage({workspaceQuotaBytes: payloadBytes + stampBytes});
    other.claimWorkspace({workspaceId: "workspace", ownerUserId: "alice", createdAtMs: 1});
    other.appendLogBatch({workspaceId: "workspace", originId: "device", ops: [op!]});
    const db = inspectDatabase(storagePath(other));
    expect(Number(db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()?.usage_bytes)).toBe(payloadBytes + stampBytes);
    db.exec("DELETE FROM sync_relay_log");
    expect(Number(db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage").get()?.usage_bytes)).toBe(0);
  });

  it("keeps non-moment snapshots out of authenticated and accountless share serialization", async () => {
    const storage = await testStorage();
    const row = {workspaceId: "workspace", originId: "device", originSeq: 0, opKind: "workspace.init",
      payloadJson: "{}", recordedAtMs: 1, relaySeq: 1, admittedAuthorSnapshot: snapshot};
    const queries = createShareReadQueries({...storage, fetchLogPage: () => ({rows: [row], nextCursor: 1, hasMore: false})}, 500);
    for (const audience of ["authenticated", "accountless"] as const) {
      const page = queries.filteredLogPage("workspace", "share", {paths: ["doc.md"], versionId: null, access: "view"}, 0, 10, audience);
      expect(page.ops).toHaveLength(1);
      expect(page.ops[0]).not.toHaveProperty("admittedAuthorSnapshot");
      expect(page.ops[0]!.payload).not.toHaveProperty("authors");
    }
    expect(row.admittedAuthorSnapshot).toEqual(snapshot);
  });
});
