import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform, version as esbuildVersion } from "esbuild";
import { beforeAll, expect, it } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { fixture, limits } from "./appBackendTestFixture";
import { createSyncRelayHandler } from "./server";
import { hashLinkBearer } from "./linkSecurity";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
const read = (name: string) => readFileSync(new URL(`../../../examples/fundraiser/${name}`, import.meta.url));
const linkKey = "fundraiser-acceptance-link-key";
const receiptBytes = Buffer.from("%PDF-1.7 synthetic fundraiser receipt\n%%EOF");
type Prepared = {candidate: AppPublicationCandidate; blobs: Array<{sha256: string; bytes: Uint8Array}>};
let prepared: Prepared;

beforeAll(async () => {
  const source = read("backend.ts"), schema = read("schema.sql");
  const manifest = JSON.parse(read("app.publish.json").toString("utf8"));
  // This test publishes the actual backend and schema. Browser UI is verified separately.
  const frontend = Buffer.from("document.body.textContent='Fundraiser HTTP acceptance fixture';");
  const backend = Buffer.from((await transform(source.toString("utf8"), {loader: "ts", format: "iife", target: "es2022"})).code);
  const bundle = Buffer.from((await transform(frontend.toString("utf8"), {loader: "ts", format: "iife", target: "es2022"})).code);
  const artifacts = [
    {path: "backend.js", bytes: backend, contentType: "text/javascript; charset=utf-8"},
    {path: "bundle.js", bytes: bundle, contentType: "text/javascript; charset=utf-8"},
    {path: "schema.sql", bytes: schema, contentType: "application/sql; charset=utf-8"},
  ];
  const inputs = [{path: "fundraiser/backend.ts", bytes: source}, {path: "fundraiser/frontend.ts", bytes: frontend}, {path: "fundraiser/schema.sql", bytes: schema}]
    .map(({path, bytes}) => ({path, sha256: sha(bytes), byteLength: bytes.byteLength}));
  const require = createRequire(import.meta.url), esbuildRequire = createRequire(require.resolve("esbuild"));
  const binary = esbuildRequire.resolve(process.platform === "win32" ? `@esbuild/win32-${process.arch}/esbuild.exe` : `@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
  const candidate = parseAppPublicationCandidate({
    versionId: "main", appRoot: "fundraiser", entryPath: "fundraiser/frontend.ts", packageMap: {},
    sourceRevision: sha(source), sourceDigest: "1".repeat(64), dependencyLockDigest: "2".repeat(64), bundleDigest: "3".repeat(64), buildDigest: "4".repeat(64),
    compilerIdentity: {recipe: "closed-esbuild", version: esbuildVersion, binarySha256: sha(readFileSync(binary))},
    inputs, dependencies: inputs.map(file => file.path),
    files: artifacts.map(({path, bytes, contentType}) => ({path, sha256: sha(bytes), byteLength: bytes.byteLength, contentType})),
    capabilities: [{kind: "app-backend", dataPath: manifest.backend.dataPath, schemaVersion: manifest.backend.schemaVersion,
      backendPath: "backend.js", schemaPath: "schema.sql", backendSha256: sha(backend), schemaSha256: sha(schema),
      operations: manifest.backend.operations, tables: manifest.backend.tables}],
  }, limits);
  candidate.sourceDigest = digest("dohc-app-source-v2", {entry: candidate.entryPath, files: candidate.inputs, packages: []});
  candidate.dependencyLockDigest = digest("dohc-app-dependencies-v1", candidate.inputs);
  candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
  candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest, dependencyLockDigest: candidate.dependencyLockDigest, compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
  prepared = {candidate, blobs: artifacts.map(({bytes}) => ({sha256: sha(bytes), bytes}))};
});

type Actor = "participant" | "other" | "third" | "owner" | "helper";
function httpFixture() {
  const f = fixture(undefined, () => 100, prepared);
  const tokens = {participant: "A".repeat(43), other: "B".repeat(43), third: "C".repeat(43)};
  const profiles = {participant: "P".repeat(43), other: "Q".repeat(43), third: "R".repeat(43)};
  for (const actor of ["participant", "other", "third"] as const) {
    f.storage.mintLinkSession({session: {sessionId: actor, capabilityHash: hashLinkBearer(tokens[actor], linkKey), grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 10000}});
  }
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper','s','user','helper-user',NULL,'edit',1,'active',1,NULL,NULL)`).run());
  const named = (actor: Actor) => actor === "owner" || actor === "helper";
  const headers = (actor: Actor): Record<string, string> => named(actor)
    ? {authorization: `Bearer ${actor === "owner" ? "owner" : "helper-user"}`}
    : {authorization: `LinkCapability ${tokens[actor as keyof typeof tokens]}`, "x-dohc-link-profile-secret": profiles[actor as keyof typeof profiles]};
  const createHandler = () => createSyncRelayHandler({storage: f.storage, appPublicationLimits: limits, appBackendsEnabled: true, nowMs: () => 100, linkKey,
    resolveActor: (request, workspaceId) => {
      const authorization = request.headers.get("authorization");
      if (authorization !== "Bearer owner" && authorization !== "Bearer helper-user") throw new UnauthorizedError();
      return {workspaceId, userId: authorization.slice(7)};
    }});
  let handler = createHandler();
  const raw = (actor: Actor, path: string, body?: unknown) => handler(new Request(`https://relay${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {...headers(actor), ...(body === undefined ? {} : {"content-type": "application/json"})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  const http = (actor: Actor, action: string, body?: unknown) => raw(actor, `/sync/${named(actor) ? "w" : "link"}/app-publications/${f.publicationId}/backend/${action}`, body);
  const invoke = (actor: Actor, key: string, operation: string, input: unknown = {}) => http(actor, "invoke", {authorityRevision: 1, idempotencyKey: key, operation, input});
  async function ok(response: Promise<Response>) {
    const value = await response, body = await value.json();
    expect(value.status, JSON.stringify(body)).toBe(200);
    return body;
  }
  const upload = (actor: Actor, key: string) => ok(http(actor, "upload", {
    authorityRevision: 1, idempotencyKey: key, name: "receipt.pdf", contentType: "application/pdf", bytesBase64: receiptBytes.toString("base64"),
  }));
  const activate = async () => { await ok(http("owner", "activate", {authorityRevision: 1})); };
  const enableHelper = async () => { await ok(http("owner", "helper", {authorityRevision: 1, grantId: "helper", enabled: true})); };
  return {f, raw, http, invoke, ok, upload, activate, enableHelper,
    restart() { f.restart(); handler = createHandler(); },
  };
}
function registration(receiptFileId: string, sessions = [{sessionId: "s1", players: ["First Player"], spectators: ["Watching Friend"]}]) {
  return {fullName: "Synthetic Contact", mobile: "0917 123 4567", paymentMethod: "gcash", receiptFileId, sessions,
    submissionId: randomUUID(), retrySecret: randomBytes(32).toString("base64url"), receiptSha256: sha(receiptBytes)};
}
const players = (sessionId: string, count: number) => ({sessionId, players: Array.from({length: count}, (_, i) => `Player Person${i}`), spectators: [] as string[]});

it("runs the published fundraiser through participant and organizer HTTP operations with durable replay", async () => {
  const f = httpFixture();
  await f.activate();
  const initial = await f.ok(f.invoke("participant", "sessions", "listPublicSessions"));
  expect(initial.result.map((session: {available: number}) => session.available)).toEqual([36, 36]);
  const uploaded = await f.upload("participant", "receipt");
  const input = registration(uploaded.file.fileId, [players("s1", 2), players("s2", 2)]);
  const firstResponse = await f.invoke("participant", "register", "register", input);
  expect(firstResponse.status).toBe(200);
  // Discard a committed response, then recover by retrying the original request.
  await firstResponse.body?.cancel();
  const accepted = await f.ok(f.invoke("participant", "register", "register", input));
  expect(accepted.replayed).toBe(true);
  expect(accepted.result).toMatchObject({total: 4000, status: "pending_verification", version: 1});
  expect(accepted.result.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await f.invoke("participant", "register", "register", {...input, fullName: "Changed Person"})).status).toBe(409);
  const id = accepted.result.id;
  const lookup = await f.ok(f.invoke("participant", "status", "lookupStatus", {token: accepted.result.statusToken}));
  expect(lookup.result.attendees).toHaveLength(4);
  expect(lookup.result).not.toHaveProperty("mobile");
  expect(lookup.result).not.toHaveProperty("receiptFileId");

  expect((await f.invoke("helper", "list-before-grant", "listRegistrations")).status).toBe(404);
  await f.enableHelper();
  const listed = await f.ok(f.invoke("helper", "list", "listRegistrations", {search: "Synthetic", status: "pending_verification"}));
  expect(listed.result.records).toHaveLength(1);
  expect(listed.result.records[0]).toMatchObject({id, mobile: "+639171234567", hasReceipt: true});
  expect(listed.result.records[0]).not.toHaveProperty("statusToken");
  const fileInput = {authorityRevision: 1, fileId: uploaded.file.fileId, operation: "receiptAccess", input: {id}};
  expect((await f.ok(f.http("helper", "file", fileInput))).bytesBase64).toBe(receiptBytes.toString("base64"));
  await f.ok(f.invoke("helper", "reject", "setStatus", {id, status: "rejected", expectedVersion: 1}));
  expect((await f.invoke("helper", "stale", "setStatus", {id, status: "verified", expectedVersion: 1})).status).toBe(409);
  expect((await f.ok(f.invoke("participant", "released", "listPublicSessions"))).result.map((session: {available: number}) => session.available)).toEqual([36, 36]);
  // Owner table edits invoke the declared operation against the same dataset.
  const restored = await f.ok(f.invoke("owner", "table-restore", "updateRegistration", {rowId: id, field: "status", value: "verified", expectedVersion: 2}));
  expect(restored.result).toMatchObject({id, status: "verified", version: 3});
  const manual = await f.ok(f.invoke("helper", "walkin", "manualEntry", {fullName: "Venue Friend", session: "both", role: "spectator", source: "reclub", status: "pay_at_venue", paymentMethod: "cash"}));
  expect(manual.result).toMatchObject({total: 300, status: "pay_at_venue"});
  const totals = await f.ok(f.invoke("helper", "totals", "totals"));
  expect(totals.result).toEqual([
    {paymentMethod: "cash", verified: 0, pending: 0, rejected: 0, dueAtVenue: 300, total: 300},
    {paymentMethod: "gcash", verified: 4000, pending: 0, rejected: 0, dueAtVenue: 0, total: 4000},
  ]);
  expect((await f.ok(f.invoke("helper", "attendees", "attendees"))).result.records).toHaveLength(6);
  const capability = prepared.candidate.capabilities.find(item => item.kind === "app-backend")!;
  for (const table of capability.tables) {
    const page = await f.ok(f.invoke("owner", `table-${table.name}`, table.readOperation, {offset: 0, limit: 1, search: ""}));
    expect(page.result.rows).toHaveLength(1);
    expect(page.result.rows[0][table.primaryKey]).toBeTypeOf("string");
    const absent = await f.ok(f.invoke("owner", `table-empty-${table.name}`, table.readOperation, {offset: 0, limit: 1, search: "no-such-synthetic-person"}));
    expect(absent.result.rows).toEqual([]);
    expect((await f.invoke("participant", `private-table-${table.name}`, table.readOperation, {})).status).toBe(404);
  }
  f.restart();
  expect(await f.ok(f.invoke("participant", "register", "register", input))).toEqual(accepted);
  expect((await f.ok(f.invoke("participant", "status-restart", "lookupStatus", {token: accepted.result.statusToken}))).result.status).toBe("verified");
  expect((await f.ok(f.http("helper", "file", fileInput))).bytesBase64).toBe(receiptBytes.toString("base64"));
  expect((await f.ok(f.invoke("owner", "list-restart", "listRegistrations"))).result.records).toHaveLength(2);
  await f.ok(f.http("owner", "helper", {authorityRevision: 1, grantId: "helper", enabled: false}));
  expect((await f.invoke("helper", "list-revoked", "listRegistrations")).status).toBe(404);
  expect((await f.http("helper", "file", fileInput)).status).toBe(404);
  expect((await f.invoke("helper", "walkin", "manualEntry", {fullName: "Venue Friend", session: "both", role: "spectator", source: "reclub", status: "pay_at_venue", paymentMethod: "cash"})).status).toBe(404);
}, 30000);

it("keeps private fundraiser records and receipts out of alternate anonymous read routes", async () => {
  const f = httpFixture();
  await f.activate();
  const uploaded = await f.upload("participant", "receipt");
  const accepted = await f.ok(f.invoke("participant", "register", "register", registration(uploaded.file.fileId)));
  const id = accepted.result.id;
  expect((await f.invoke("other", "list", "listRegistrations")).status).toBe(404);
  expect((await f.invoke("other", "phone", "lookupStatus", {mobile: "+639171234567"})).status).toBe(409);
  expect((await f.invoke("other", "guess", "lookupStatus", {token: "Z".repeat(43)})).status).toBe(409);
  expect((await f.http("other", "file", {authorityRevision: 1, fileId: uploaded.file.fileId, operation: "receiptAccess", input: {id}})).status).toBe(404);
  const current = await f.ok(f.raw("other", "/sync/link/current"));
  expect(current.files).toEqual([]);
  const log = await f.ok(f.raw("other", "/sync/link/log?since=0&limit=100"));
  expect(log.ops).toEqual([]);
  expect((await f.raw("other", `/sync/link/blobs/${sha(receiptBytes)}`)).status).toBe(404);
  const publication = await f.ok(f.raw("other", `/sync/link/app-publications/${f.f.publicationId}`));
  expect(publication.files.map((item: {path: string}) => item.path)).toEqual(["bundle.js"]);
  for (const file of prepared.candidate.files.filter(file => file.path !== "bundle.js")) {
    expect((await f.raw("other", `/sync/link/app-publications/${f.f.publicationId}/blobs/${file.sha256}?authorityRevision=1`)).status).toBe(404);
  }
  const description = await f.ok(f.http("owner", "describe", {}));
  expect(description.capability.dataPath).toBe("fundraiser/data.sqlite");
  const database = f.f.storage.db.prepare("SELECT database FROM sync_relay_app_backends WHERE workspace_id='w'").get()!;
  expect((await f.raw("other", `/sync/link/blobs/${sha(database.database as Uint8Array)}`)).status).toBe(404);
}, 30000);

it("serializes final-slot bookings and restores the same fundraiser after restart", async () => {
  const f = httpFixture();
  await f.activate();
  const bulkReceipt = await f.upload("participant", "bulk-receipt");
  await f.ok(f.invoke("participant", "bulk", "register", registration(bulkReceipt.file.fileId, [players("s1", 35), players("s2", 35)])));
  const a = await f.upload("other", "receipt-a"), b = await f.upload("third", "receipt-b");
  const inputs = [registration(a.file.fileId, [players("s1", 1), players("s2", 1)]), registration(b.file.fileId, [players("s1", 1), players("s2", 1)])];
  const responses = await Promise.all([f.invoke("other", "last-a", "register", inputs[0]), f.invoke("third", "last-b", "register", inputs[1])]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const replies = await Promise.all(responses.map(response => response.json()));
  const winner = responses.findIndex(response => response.status === 200);
  expect(replies[1 - winner]).toMatchObject({code: "capacity_unavailable"});
  expect((await f.ok(f.invoke("participant", "full", "listPublicSessions"))).result.map((session: {available: number}) => session.available)).toEqual([0, 0]);
  const winnerActor = winner === 0 ? "other" : "third", winnerKey = winner === 0 ? "last-a" : "last-b";
  f.restart();
  expect(await f.ok(f.invoke(winnerActor, winnerKey, "register", inputs[winner]))).toEqual({...replies[winner], replayed: true});
  expect((await f.ok(f.invoke("owner", "all", "listRegistrations"))).result.records).toHaveLength(2);
  expect((await f.ok(f.invoke("owner", "attendees", "attendees", {limit: 200}))).result.records).toHaveLength(72);
  const failedFileId = winner === 0 ? b.file.fileId : a.file.fileId;
  expect(f.f.storage.db.prepare("SELECT attached_revision FROM sync_relay_app_backend_files WHERE file_id=?").get(failedFileId)?.attached_revision).toBeNull();
}, 30000);

it("recovers an uncertain registration from another browser profile without reserving twice", async () => {
  const f = httpFixture();
  await f.activate();
  const upload = await f.upload("participant", "receipt");
  const savedAttempt = registration(upload.file.fileId, [players("s1", 2), players("s2", 2)]);
  const accepted = await f.ok(f.invoke("participant", "initial", "register", savedAttempt));
  f.restart();
  // A recovery file saved before upload has to upload the same bytes under the new profile.
  const replacement = await f.upload("other", "recovered-receipt");
  expect(replacement.file.fileId).not.toBe(upload.file.fileId);
  const resumed = {...savedAttempt, receiptFileId: replacement.file.fileId};
  const recovered = await f.ok(f.invoke("other", "recovered", "register", resumed));
  expect(recovered.result).toEqual(accepted.result);
  expect((await f.ok(f.invoke("owner", "records", "listRegistrations"))).result.records).toHaveLength(1);
  expect((await f.ok(f.invoke("other", "capacity", "listPublicSessions"))).result.map((session: {available: number}) => session.available)).toEqual([34, 34]);
  expect(f.f.storage.db.prepare("SELECT attached_revision FROM sync_relay_app_backend_files WHERE file_id=?").get(replacement.file.fileId)?.attached_revision).toBeNull();
  for (const [key, changed] of [
    ["wrong-secret", {...resumed, retrySecret: "Z".repeat(43)}],
    ["changed-details", {...resumed, fullName: "Changed Contact"}],
    ["changed-bytes", {...resumed, receiptSha256: "f".repeat(64)}],
  ] as const) {
    const response = await f.invoke("third", key, "register", changed);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ok: false, code: "submission_conflict", error: "This submission reference cannot be reused with these details."});
  }
  const fresh = await f.invoke("other", "mismatched-receipt", "register", {...registration(replacement.file.fileId), receiptSha256: "f".repeat(64)});
  expect(fresh.status).toBe(409);
  expect(await fresh.json()).toMatchObject({code: "invalid_receipt"});
}, 30000);
