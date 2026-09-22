import { expect, it, vi } from "vitest";
import { evaluateAppOperation, initializeAppDatabase } from "@dohc/app-backend-runtime";
import { createAppBackendHost } from "./appBackendHost";
import { createAppBackendAdmission, type AppBackendAdmissionLimits } from "./appBackendAdmission";
import { TokenBucketLimiter } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { fixture, limits, input } from "./appBackendTestFixture";
import { createSyncRelayHandler } from "./server";
import { hashLinkBearer } from "./linkSecurity";

function httpFixture(enabled = true, maxParticipantsPerGrant?: number,
  options: {admission?: Partial<AppBackendAdmissionLimits>; evaluate?: typeof evaluateAppOperation;
    nowMs?: () => number; documentReadLimit?: number} = {}) {
  const f = fixture();
  if (options.evaluate) vi.spyOn(f.storage, "createAppBackendHost").mockImplementation(hostOptions =>
    createAppBackendHost({...hostOptions, storage: f.storage, runtime: {initializeAppDatabase, evaluateAppOperation: options.evaluate!}}));
  const key = "app-backend-test-key", token = "A".repeat(43), profile = "P".repeat(43);
  f.storage.mintLinkSession({session: {sessionId: "http-session", capabilityHash: hashLinkBearer(token, key), grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
  let authCalls = 0;
  const handler = createSyncRelayHandler({storage: f.storage, appPublicationLimits: limits, appBackendsEnabled: enabled, appBackendMaxParticipantsPerGrant:maxParticipantsPerGrant,
    appBackendAdmissionLimits: options.admission, nowMs: options.nowMs ?? (() => 10), linkKey: key,
    ...(options.documentReadLimit ? {linkGrantReadRateLimiter: new TokenBucketLimiter(options.documentReadLimit, 1, 1)} : {}),
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

// These admission tests retain authentication, enrollment, receipts and route parsing.
// The evaluator is immediate so they measure admission, not process throughput.
const immediateEvaluation: typeof evaluateAppOperation = async value => ({result: null, database: value.database,
  changed: false, changeset: new Uint8Array(), attachedFileIds: []});
const profileHeaders = (index: number, token = "A".repeat(43)) => ({authorization: `LinkCapability ${token}`,
  "x-dohc-link-profile-secret": String(index).padStart(43, "P")});
function mintProfile(f: ReturnType<typeof fixture>, index: number): string {
  const token = String(index).padStart(43, "A");
  f.storage.mintLinkSession({session: {sessionId: `profile-${index}`, capabilityHash: hashLinkBearer(token, "app-backend-test-key"),
    grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
  return token;
}

it("admits 100 profiles reading and writing through one public link without consuming document-read allowance", async () => {
  const f = httpFixture(true, 100, {evaluate: immediateEvaluation, documentReadLimit: 1});
  expect((await f.http("named", "activate", {authorityRevision: 1})).status).toBe(200);
  for (let index = 0; index < 100; index++) {
    const token = mintProfile(f, index), headers = profileHeaders(index, token);
    for (const operation of ["read", "attach", "read"]) {
      expect((await f.http("link", "invoke", input(`request-${index}-${operation}`, operation, {fileIds: []}), headers)).status).toBe(200);
    }
  }
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_backend_participants").get()?.n).toBe(100);
});

it("limits one profile across renewed sessions without blocking another participant", async () => {
  const f = httpFixture(true, undefined, {evaluate: immediateEvaluation, admission: {participant: {capacity: 2, refillPerSecond: 0.5}}});
  expect((await f.http("named", "activate", {authorityRevision: 1})).status).toBe(200);
  for (let i = 0; i < 2; i++) expect((await f.http("link", "invoke", input(`read-${i}`, "read"))).status).toBe(200);
  const token = "B".repeat(43);
  f.storage.mintLinkSession({session: {sessionId: "renewed", capabilityHash: hashLinkBearer(token, "app-backend-test-key"),
    grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
  expect((await f.http("link", "invoke", input("limited", "read"), {authorization: `LinkCapability ${token}`})).status).toBe(429);
  const otherToken = mintProfile(f, 1);
  expect((await f.http("link", "invoke", input("another", "read"), profileHeaders(1, otherToken))).status).toBe(200);
});

it("bounds rotating public profiles while retaining verified owner and helper capacity", async () => {
  const f = httpFixture(true, undefined, {evaluate: immediateEvaluation, admission: {link: {capacity: 2, refillPerSecond: 0.5}}});
  expect((await f.http("named", "activate", {authorityRevision: 1})).status).toBe(200);
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper','s','user','helper-user',NULL,'edit',1,'active',1,NULL,NULL)`).run());
  expect((await f.http("named", "helper", {authorityRevision: 1, grantId: "helper", enabled: true})).status).toBe(200);
  for (let i = 0; i < 2; i++) { const token = mintProfile(f, i); expect((await f.http("link", "invoke", input(`read-${i}`, "read"), profileHeaders(i, token))).status).toBe(200); }
  const limitedToken = mintProfile(f, 3);
  expect((await f.http("link", "invoke", input("limited", "read"), profileHeaders(3, limitedToken))).status).toBe(429);
  const results = await Promise.all([
    f.http("named", "export", {}),
    f.http("named", "invoke", input("helper", "administer"), {authorization: "Bearer helper-user"}),
    f.http("named", "invoke", input("forged", "administer"), {authorization: "Bearer stranger"}),
  ]);
  expect(results.map(result => result.status)).toEqual([200, 200, 404]);
});

it("admits a ten-request public burst and reserves organizer slots while releasing failed requests", async () => {
  let startResolve!: () => void, finishResolve!: () => void;
  const started = new Promise<void>(resolve => {startResolve = resolve;});
  const finish = new Promise<void>(resolve => {finishResolve = resolve;});
  let calls = 0;
  const f = httpFixture(true, undefined, {admission: {maxPending: 10}, evaluate: async value => {
    if (++calls <= 10) { if (calls === 10) startResolve(); await finish; }
    return immediateEvaluation(value);
  }});
  expect((await f.http("named", "activate", {authorityRevision: 1})).status).toBe(200);
  const pending = Array.from({length: 10}, (_, index) => { const token = mintProfile(f, index); return f.http("link", "invoke", input(`burst-${index}`, "read"), profileHeaders(index, token)); });
  try {
    await started;
    const overflowToken = mintProfile(f, 11);
    expect((await f.http("link", "invoke", input("overflow", "read"), profileHeaders(11, overflowToken))).status).toBe(429);
    expect((await f.http("named", "invoke", input("owner", "ownerOnly"))).status).toBe(200);
  } finally { finishResolve(); }
  expect((await Promise.all(pending)).map(result => result.status)).toEqual(Array(10).fill(200));
  const afterToken = mintProfile(f, 12);
  expect((await f.http("link", "invoke", {}, profileHeaders(12, afterToken))).status).toBe(400);
  expect((await f.http("link", "invoke", input("after", "read"), profileHeaders(12, afterToken))).status).toBe(200);
});

it("bounds datasets, global work, large bodies and participant-map churn", () => {
  const admit = createAppBackendAdmission({maxKeys: 1, maxUploads: 1, maxRecovery: 1,
    dataset: {capacity: 2, refillPerSecond: 1}, global: {capacity: 3, refillPerSecond: 1}});
  const scope = (dataset: string, participant: string, organizer = false) => ({dataset, participant, organizer});
  admit(scope("a", "1"), "invoke", 0)();
  admit(scope("a", "2"), "invoke", 0)();
  expect(() => admit(scope("a", "3"), "invoke", 0)).toThrow();
  admit(scope("b", "4"), "invoke", 0)();
  expect(() => admit(scope("c", "5"), "invoke", 0)).toThrow();
  const upload = admit(scope("a", "owner", true), "upload", 0);
  expect(() => admit(scope("a", "helper", true), "upload", 0)).toThrow();
  const restore = admit(scope("a", "owner", true), "restore", 0);
  expect(() => admit(scope("b", "owner", true), "restore", 0)).toThrow();
  upload(); restore();
  admit(scope("a", "owner", true), "restore", 0)();
  admit(scope("c", "5"), "invoke", 1000)();
  expect(() => createAppBackendAdmission({maxPending: NaN})).toThrow();
  expect(() => createAppBackendAdmission({participant: {capacity: 1, refillPerSecond: Infinity}})).toThrow();
});

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
it("enforces transfer provenance and preservation conditions through owner activation", async () => {
  const f=httpFixture();
  expect((await f.http("named","activate",{authorityRevision:1,preserveData:true})).status).toBe(409);
  expect((await f.http("named","activate",{authorityRevision:1,preserveData:false})).status).toBe(400);
  expect((await f.http("named","activate",{authorityRevision:1,expectedRecoverySha256:"invalid"})).status).toBe(400);
  expect((await f.http("named","activate",{authorityRevision:1})).status).toBe(200);
  expect((await f.http("named","activate",{authorityRevision:1,preserveData:true,expectedRecoverySha256:"a".repeat(64)})).status).toBe(409);
  expect((await f.http("named","activate",{authorityRevision:1,preserveData:true})).status).toBe(200);
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
