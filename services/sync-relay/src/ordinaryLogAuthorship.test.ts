import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import { parseAuthenticatedLogOps } from "./relayLogInputs";
import { stableJsonStringify } from "./canonicalJson";
import { createShareReadQueries } from "./shareReadQueries";
import { claimWorkspace, closeTestStorage, closeTestStorages, inspectDatabase, jsonBody, reopenTestStorage, request, storagePath, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

function update(payload: Record<string, unknown>, originSeq = 0) {
  return {originSeq, opKind: "ydoc.update", payload, recordedAtMs: 1};
}
const context = {kind: "account", accountId: "alice"};
const snapshot: LiveAuthorSnapshot = [{kind: "human", humanId: "alice", humanName: "Alice"}];

describe("ordinary admitted authorship", () => {
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
    const [admitted] = await parseAuthenticatedLogOps([update(payload)], "alice", lookup);
    expect(admitted?.admittedAuthorSnapshot).toBeUndefined();
    expect(admitted?.payloadJson).toBe(stableJsonStringify(payload));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("ignores author-shaped fields on other op kinds and rejects malformed new context", async () => {
    const lookup = vi.fn(() => "Alice");
    const [admitted] = await parseAuthenticatedLogOps([{...update({authorContext: context}), opKind: "opaque"}], "alice", lookup);
    expect(admitted?.admittedAuthorSnapshot).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    await expect(parseAuthenticatedLogOps([update({authorContext: {...context, humanName: "Forged"}})], "alice", lookup)).rejects.toThrow("invalid ydoc.update authorContext");
  });

  it("bounds server names and declared agent entries by serialized bytes", async () => {
    for (const name of [null, "", "x".repeat(513)]) {
      const [admitted] = await parseAuthenticatedLogOps([update({authorContext: context})], "alice", () => name);
      expect(admitted?.admittedAuthorSnapshot).toEqual([{kind: "human", humanId: "alice", humanName: "alice"}]);
    }
    const escaped = "\u0001".repeat(350);
    await expect(parseAuthenticatedLogOps([update({authorContext: {...context, agent: {agentId: escaped, agentName: escaped}}})], "alice", () => "Alice")).rejects.toThrow("invalid ydoc.update authorContext");
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
