import {afterEach, describe, expect, it, vi} from "vitest";
import {UnauthorizedError} from "@dohc/workspace-auth/session";
import {fixture as ticketFixture, scope} from "./liveTickets.test-helper";
import {createSyncRelayHandler} from "./server";
import {releasedLineageBindingDigest, type ReleasedLineageBinding} from "@dohc/workspace-engine-client/relay-wire";
import {MAX_HELD_DOCUMENTS_PAGE, type HeldDocumentHost, type HeldDocumentInspection, type HeldDocumentsPage} from "./heldDocumentRoutes";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});

const binding: ReleasedLineageBinding = {version: 2, workspaceId: scope.workspaceId, mainVersionId: "main", objectId: "object-1",
  lineageClaimId: "a".repeat(64), currentPath: "docs/a.md", restoreGeneration: 0,
  incoming: {relayNamespace: "relay", replicationEpoch: "epoch", streamIdentity: "stream", originId: "desktop", originSeq: 1, relaySeq: 3},
  headDigest: "b".repeat(64),
  tails: [{namespace: "relay", activationId: "activation", release: {path: "docs/a.md", restoreGeneration: 0},
    unproven: {count: 1, digest: "c".repeat(64)}}]};
const held: HeldDocumentsPage["documents"][number] = {objectId: binding.objectId, path: binding.currentPath!, binding,
  bindingDigest: releasedLineageBindingDigest(binding), continuation: "frozen", bindingStale: false};
const page: HeldDocumentsPage = {documents: [held], hasMore: false};
const inspection: HeldDocumentInspection = {...held, status: "stale", preservation: null, resolution: null};

// Each bearer names one account: the owner, a named Edit recipient, a View
// recipient, and the owner of another workspace.
const accounts: Record<string, string> = {"Bearer owner": "owner-1", "Bearer editor": scope.userId,
  "Bearer viewer": "viewer-1", "Bearer stranger": "owner-2"};

async function relay(host: HeldDocumentHost | undefined) {
  const f = await ticketFixture(); cleanups.push(f.close);
  f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('view-1', ?, 'user', 'viewer-1', NULL, 'view', 1, 'active', 0, NULL, NULL)`).run(scope.shareId);
  f.raw.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES ('workspace-2', 'owner-2', 0)").run();
  const resolveActor = vi.fn(async (request: Request, workspaceId: string) => {
    const userId = accounts[request.headers.get("authorization") ?? ""];
    if (!userId) throw new UnauthorizedError();
    return {userId, workspaceId};
  });
  let current = host;
  const handler = createSyncRelayHandler({storage: f.storage, resolveActor, heldDocumentHost: () => current});
  const get = (path: string, headers: Record<string, string> = {authorization: "Bearer owner"}, method = "GET") =>
    handler(new Request(`http://relay.test/sync/${path}`, {method, headers}));
  return {...f, get, resolveActor, replaceHost(next: HeldDocumentHost | undefined) {current = next;}};
}

function fakeHost(overrides: Partial<HeldDocumentHost> = {}): HeldDocumentHost & {calls: unknown[][]} {
  const calls: unknown[][] = [];
  return {calls,
    heldDocuments: overrides.heldDocuments ?? (async (...args) => {calls.push(["list", ...args.slice(0, 2)]); return page;}),
    heldDocument: overrides.heldDocument ?? (async (...args) => {calls.push(["one", ...args.slice(0, 2)]); return inspection;})};
}

describe("held document routes", () => {
  it("answer the workspace's owner, and an agent with the owner's credential, from the host", async () => {
    const host = fakeHost(), f = await relay(host);
    const list = await f.get(`${scope.workspaceId}/held-documents?after=a&limit=2`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(await list.json()).toEqual(page);
    const one = await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(inspection);
    expect(await (await f.get(`${scope.workspaceId}/held-documents`)).json()).toEqual(page);
    expect(host.calls).toEqual([
      ["list", scope.workspaceId, {afterObjectId: "a", limit: 2}],
      ["one", scope.workspaceId, held.objectId],
      ["list", scope.workspaceId, {limit: 50}],
    ]);
  });

  it.each([
    ["a named Edit recipient", {authorization: "Bearer editor"}, 404],
    ["a View recipient", {authorization: "Bearer viewer"}, 404],
    ["another workspace's owner", {authorization: "Bearer stranger"}, 404],
    ["an unauthenticated caller", {}, 404],
    ["an ambient browser cookie", {authorization: "Bearer owner", cookie: "session=owner"}, 404],
    ["an unknown credential", {authorization: "Bearer forged"}, new UnauthorizedError().statusCode],
  ])("refuse %s as they refuse elsewhere, naming nothing, and never ask the host", async (_case, headers, status) => {
    const host = fakeHost(), f = await relay(host);
    for (const path of [`${scope.workspaceId}/held-documents`, `${scope.workspaceId}/held-documents/${held.objectId}`]) {
      const refused = await f.get(path, headers);
      expect(refused.status).toBe(status);
      expect(JSON.stringify(await refused.json())).not.toContain(held.objectId);
    }
    expect(host.calls).toEqual([]);
  });

  it("refuse the owner of one workspace reading another's held documents", async () => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get("workspace-2/held-documents")).status).toBe(404);
    expect(host.calls).toEqual([]);
  });

  /** A host whose reads wait until `release`, and `asked` once one began. */
  function waitingHost() {
    let release!: () => void, began!: () => void;
    const answered = new Promise<void>(resolve => {release = resolve;});
    const asked = new Promise<void>(resolve => {began = resolve;});
    const host = fakeHost({
      heldDocument: async () => {began(); await answered; return inspection;},
      heldDocuments: async () => {began(); await answered; return page;},
    });
    return {host, asked, release};
  }

  it("recheck ownership and the answering host after the host's read", async () => {
    const owned = waitingHost(), f = await relay(owned.host);
    const transferred = f.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
    await owned.asked;
    f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);
    owned.release();
    const refused = await transferred;
    expect(refused.status).toBe(404);
    expect(JSON.stringify(await refused.json())).not.toContain(held.objectId);

    const answering = waitingHost(), g = await relay(answering.host);
    const replaced = g.get(`${scope.workspaceId}/held-documents`);
    await answering.asked;
    g.replaceHost(fakeHost());
    answering.release();
    expect((await replaced).status).toBe(404);
  });

  it("answer nothing held, and no host, as a missing document", async () => {
    const f = await relay(fakeHost({heldDocument: async () => null, heldDocuments: async () => null}));
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`)).status).toBe(404);
    expect((await f.get(`${scope.workspaceId}/held-documents`)).status).toBe(404);
    const g = await relay(undefined);
    expect((await g.get(`${scope.workspaceId}/held-documents`)).status, "no session host").toBe(404);
  });

  it.each([
    "limit=0", `limit=${MAX_HELD_DOCUMENTS_PAGE + 1}`, "limit=1.5", "limit=01", "limit=two",
    "after=", "limit=1&limit=2", "other=1",
  ])("refuse a bad page query, %s, before asking the host", async query => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get(`${scope.workspaceId}/held-documents?${query}`)).status).toBe(400);
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}?${query}`)).status).toBe(400);
    expect(host.calls).toEqual([]);
  });

  it("are read only", async () => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get(`${scope.workspaceId}/held-documents`, {authorization: "Bearer owner"}, "POST")).status).toBe(405);
    expect(host.calls).toEqual([]);
  });
});
