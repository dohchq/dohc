import { expect, it } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { fixture, limits, input } from "./appBackendTestFixture";
import { createSyncRelayHandler } from "./server";
import { hashLinkBearer } from "./linkSecurity";

function httpFixture(enabled = true, maxParticipantsPerGrant?: number) {
  const f = fixture();
  const key = "app-backend-test-key", token = "A".repeat(43), profile = "P".repeat(43);
  f.storage.mintLinkSession({session: {sessionId: "http-session", capabilityHash: hashLinkBearer(token, key), grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
  let authCalls = 0;
  const handler = createSyncRelayHandler({storage: f.storage, appPublicationLimits: limits, appBackendsEnabled: enabled, appBackendMaxParticipantsPerGrant:maxParticipantsPerGrant, nowMs: () => 10, linkKey: key,
    resolveActor: (request, workspaceId) => {
      authCalls++;
      const value = request.headers.get("authorization");
      if (value !== "Bearer owner" && value !== "Bearer helper-user" && value !== "Bearer stranger") throw new UnauthorizedError();
      return {workspaceId, userId: value.slice(7)};
    }});
  const namedPath = `/sync/w/app-publications/${f.publicationId}/backend`;
  const publicPath = `/sync/link/app-publications/${f.publicationId}/backend`;
  const http = (kind: "named" | "link", action: string, body?: unknown, extra: Record<string, string> = {}) => handler(new Request(`https://relay${kind === "named" ? namedPath : publicPath}/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {"content-type": "application/json", ...(kind === "named" ? {authorization: "Bearer owner"} : {authorization: `LinkCapability ${token}`, "x-dohc-link-profile-secret": profile}), ...extra},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  return {...f, http, handler, get authCalls() {return authCalls;}};
}

it("passes the deployment participant limit to the app host", async () => {
  const f=httpFixture(true,1);
  expect((await f.http("named","activate",{authorityRevision:1})).status).toBe(200);
  expect((await f.http("link","invoke",input("write","attach",{fileIds:[]}))).status).toBe(200);
  const token="B".repeat(43);
  f.storage.mintLinkSession({session:{sessionId:"other-http-session",capabilityHash:hashLinkBearer(token,"app-backend-test-key"),grantId:"g",generation:1,mintedAtMs:2,expiresAtMs:1000}});
  const other={authorization:`LinkCapability ${token}`,"x-dohc-link-profile-secret":"Q".repeat(43)};
  expect((await f.http("link","invoke",input("second","attach",{fileIds:[]}),other)).status).toBe(413);
  expect((await f.http("link","invoke",input("read","read"),other)).status).toBe(200);
});

it("runs public submission and private owner file management over the relay routes", async () => {
  const f = httpFixture();
  expect((await f.http("named", "activate", {authorityRevision: 1})).status).toBe(200);
  const response = await f.http("link", "upload", {authorityRevision: 1, idempotencyKey: "upload", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.7 receipt").toString("base64")});
  expect(response.status).toBe(200);
  const uploaded = await response.json();
  const invoke = await f.http("link", "invoke", input("reserve", "reserve", {fileId: uploaded.file.fileId}));
  expect(invoke.status).toBe(200);
  expect(invoke.headers.get("cache-control")).toBe("private, no-store");
  const first = await invoke.json();
  expect(await (await f.http("link", "invoke", input("reserve", "reserve", {fileId: uploaded.file.fileId}))).json()).toEqual({...first, replayed: true});
  const file = {authorityRevision: 1, fileId: uploaded.file.fileId, operation: "fileAccess", input: {fileId: uploaded.file.fileId}};
  expect((await f.http("link", "file", file)).status).toBe(404);
  const read = await f.http("named", "file", file);
  expect(read.status).toBe(200);
  expect((await read.json()).file.fileId).toBe(uploaded.file.fileId);
  expect((await f.http("named", "export", {})).status).toBe(200);
  expect((await f.http("link", "invoke", input("full"))).status).toBe(409);
});

it("requires backend opt-in and refuses ambient or forged authority before account resolution", async () => {
  const disabled = httpFixture(false);
  expect((await disabled.http("named", "activate", {authorityRevision: 1})).status).toBe(404);
  const f = httpFixture();
  const cookieHeaders: Record<string, string>[] = [{cookie: "ambient"}, {cookie: "ambient", origin: "https://attacker"}];
  for (const headers of cookieHeaders) {
    expect((await f.http("named", "activate", {authorityRevision: 1}, headers)).status).toBe(404);
    expect((await f.http("link", "invoke", input("a"), headers)).status).toBe(404);
  }
  expect(f.authCalls).toBe(0);
  expect((await f.http("named", "activate", {authorityRevision: 1}, {authorization: "Bearer stranger"})).status).toBe(404);
  expect((await f.http("named", "activate", {authorityRevision: 1, userId: "owner"})).status).toBe(400);
  expect((await f.http("named", "activate", {authorityRevision: 1}, {"content-type": "text/plain"})).status).toBe(400);
  expect((await f.http("link", "invoke", input("a"), {"x-dohc-link-profile-secret": ""})).status).toBe(404);
});

it("serves only browser bundles and limits helper operations to active named Edit grants", async () => {
  const f = httpFixture();
  expect((await f.http("named", "activate", {authorityRevision: 1})).status).toBe(200);
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper','s','user','helper-user',NULL,'edit',1,'active',1,NULL,NULL)`).run());
  const helper = {authorization: "Bearer helper-user"};
  expect((await f.http("named", "descriptor", undefined, helper)).status).toBe(404);
  expect((await f.http("named", "helper", {authorityRevision: 1, grantId: "helper", enabled: true})).status).toBe(200);
  const descriptorResponse = await f.http("named", "descriptor", undefined, helper);
  expect(descriptorResponse.status).toBe(200);
  const descriptor = await descriptorResponse.json();
  expect(descriptor.files.map((file: {path: string}) => file.path)).toEqual(["bundle.js"]);
  expect((await f.http("named", `blobs/${descriptor.files[0].sha256}?authorityRevision=1`, undefined, helper)).status).toBe(200);
  expect((await f.http("named", "invoke", input("admin", "administer"), helper)).status).toBe(200);
  expect((await f.http("named", "helper", {authorityRevision: 1, grantId: "helper", enabled: false}, helper)).status).toBe(404);
  expect((await f.http("named", "export", {}, helper)).status).toBe(404);
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET revoked_at_ms=10,status='revoked' WHERE grant_id='helper'").run());
  expect((await f.http("named", "descriptor", undefined, helper)).status).toBe(404);
});
