import {afterEach, expect, it, vi} from "vitest";
import {getCookies} from "better-auth/cookies";
import {UnauthorizedError, type ResolveActor} from "@dohc/workspace-auth/session";
import {testStorage, closeTestStorages, moment, resetOpSeq, sha256} from "../../sync-relay/src/testing";
import {createNamedRecipientDocuments} from "../../sync-relay/src/namedRecipientDocuments";
import {createNamedRecipientDocumentsClient} from "./namedRecipientDocuments";

const origin = "https://share.example.test", exchangeKey = "named-navigation-exchange-key-at-least-32";
const cookieName = getCookies({baseURL: origin}).sessionToken.name;
const limits = {maxPendingRequests: 2, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000};
const browserLimits = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function request(user = "alice", body: unknown = {grantId: "grant"}) {
  return new Request(`${origin}/api/live/named-documents`, {method: "POST", body: JSON.stringify(body),
    headers: {host: "share.example.test", origin, "content-type": "application/json", cookie: `${cookieName}=${user}`}});
}
async function fixture(maxFiles = 8, access = "edit", lookup?: (storage: Awaited<ReturnType<typeof testStorage>>) => Promise<string>) {
  resetOpSeq();
  const storage = await testStorage(); storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1});
  storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: "owner", createdAtMs: 1,
    labels: {subjectName: "Trip"}, selectorJson: JSON.stringify({paths: ["docs"], versionId: null})},
    grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: "alice", principalEmail: null,
      access, generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  for (const content of ["# Shared", "# Private", "# Side", "{}"]) storage.putBlob({workspaceId: "workspace", sha256: sha256(content), content: Buffer.from(content), createdAtMs: 1});
  const ops = [moment("docs/a.md", "# Shared", {objectId: "a"}), moment("private/b.md", "# Private", {objectId: "b"}),
    moment("docs/a.md", "# Side", {objectId: "side", versionId: "side"}), moment("docs/c.excalidraw", "{}", {objectId: "c"})];
  storage.appendLogBatch({workspaceId: "workspace", originId: "owner", ops: ops.map(({payload, ...op}) => ({...op,
    payloadJson: JSON.stringify({...payload, payloadAfterContentKind: "text", payloadAfterByteLength: 8})}))});
  const actor = vi.fn<ResolveActor>((incoming, workspaceId) => {
    const cookie = incoming.headers.get("cookie");
    if (!cookie || !cookie.startsWith(`${cookieName}=`)) throw new UnauthorizedError();
    expect([...incoming.headers.keys()]).toEqual(["cookie"]);
    return {userId: cookie.slice(cookieName.length + 1), workspaceId};
  });
  const relay = createNamedRecipientDocuments({storage, resolveActor: actor, publicOrigin: origin, exchangeKey,
    limits: {...limits, maxSessions: 8, retentionMs: 60000}, maxFiles, shareSenderLabel: () => lookup ? lookup(storage) : Promise.resolve("Ana (owner@dohc.test)")});
  const forwarded: Request[] = [];
  const web = createNamedRecipientDocumentsClient({relayUrl: "https://relay.test", publicOrigin: origin, exchangeKey, limits, browserLimits,
    fetchRelay: async input => {forwarded.push(input.clone()); return relay(input);}});
  return {storage, actor, web, forwarded};
}
afterEach(closeTestStorages);
it("opens only current selected Markdown objects through the named account and keeps private and side-version files out", async () => {
  const f = await fixture(), input = request();
  input.headers.set("authorization", "Bearer forged"); input.headers.set("x-user-id", "owner"); input.headers.set("x-dohc-relay-exchange-key", "forged");
  const response = await f.web(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({subjectName: "Trip", sharerName: "Ana (owner@dohc.test)", access: "edit", userId: "alice", workspaceId: "workspace", grantId: "grant", shareId: "share",
    files: [{objectId: "a", path: "docs/a.md"}], limits: browserLimits});
  expect(f.actor).toHaveBeenCalledTimes(1);
  expect(f.forwarded[0]!.headers.has("authorization")).toBe(false);
  expect(f.forwarded[0]!.headers.has("x-user-id")).toBe(false);
  expect(f.forwarded[0]!.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
});
it.each(["other-account", "revoked", "view", "pinned", "oversized", "claims", "cross-origin"])("refuses named navigation for %s", async mode => {
  const f = await fixture(mode === "oversized" ? 1 : 8, mode === "view" ? "view" : "edit");
  if (mode === "revoked") f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 4});
  if (mode === "pinned") {
    const share = f.storage.getShare("share")!;
    vi.spyOn(f.storage, "getShare").mockReturnValue({...share, selectorJson: JSON.stringify({paths: ["docs"], versionId: "side"})});
  }
  const input = request(mode === "other-account" ? "bob" : "alice", mode === "claims" ? {grantId: "grant", userId: "alice"} : undefined);
  if (mode === "cross-origin") input.headers.set("origin", "https://other.test");
  const response = await f.web(input); expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ok: false, error: "not found"});
});
it("rechecks the grant after reading current files", async () => {
  const f = await fixture(), read = f.storage.readCurrentFileState.bind(f.storage);
  vi.spyOn(f.storage, "readCurrentFileState").mockImplementation(input => {
    const result = read(input); f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 4}); return result;
  });
  expect((await f.web(request())).status).toBe(404);
});
it("keeps cancelled navigation in capacity until account resolution finishes", async () => {
  const f = await fixture();
  const entered = deferred<void>(), release = deferred<void>();
  let count = 0;
  f.actor.mockImplementation(async (_incoming, workspaceId) => {
    if (++count === 2) entered.resolve();
    await release.promise;
    return {userId: "alice", workspaceId};
  });
  const controller = new AbortController();
  const first = f.web(new Request(request(), {signal: controller.signal}));
  const second = f.web(request());
  await entered.promise;
  controller.abort();
  expect((await first).status).toBe(404);
  expect((await f.web(request())).status).toBe(404);
  expect(f.actor).toHaveBeenCalledTimes(2);
  release.resolve();
  expect((await second).status).toBe(200);
  expect((await f.web(request())).status).toBe(200);
});

it("rechecks named navigation after revocation during the sender lookup", async () => {
  const f = await fixture(8, "edit", async storage => {
    storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 4});
    return "Ana (owner@dohc.test)";
  });
  expect((await f.web(request())).status).toBe(404);
});
it("opens named documents without a sender label when account lookup fails", async () => {
  const f = await fixture(8, "edit", async () => {throw Error("account unavailable");});
  const response = await f.web(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({sharerName: null, access: "edit"});
});
