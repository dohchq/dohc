import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { resolveAppDatasetCapability, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture, limits } from "./datasetTestFixture";
import { createSyncRelayHandler } from "./server";
import { hashLinkBearer } from "./linkSecurity";
import { createDatasetJournal } from "@dohc/app-backend-runtime/journal";
import { encodeRecoveryManifest } from "@dohc/app-backend-runtime/recovery";
import { DatasetReopenWaitError } from "@dohc/app-backend-runtime/supervisor";
import { PersistentRuntimeError } from "@dohc/app-backend-runtime/persistent";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = {formatVersion: 1, datasetId: id(1), name: "Requests", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
  tables: [{tableId: id(2), name: "Requests", sqlName: "requests", primaryKey: "id", fields: [
    {fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true},
    {fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false},
    {fieldId: id(7), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: false, unique: false},
  ]}], operations: [
    {operationId: id(5), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)]},
    {operationId: id(6), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)]},
    {operationId: id(8), name: "receipt", label: "Receipt", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(7)]},
  ]};
const schemaSql = "CREATE TABLE requests(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,receipt TEXT);";
const operationSource = `globalThis.operations={submit(ctx,input){if(input.fileId)ctx.files.attach(input.fileId);if(!input.name)ctx.refuse('missing_name','A name is required.');ctx.db.execute('INSERT INTO requests VALUES(?,?,?)',[ctx.requestId,input.name,input.fileId??null]);return {accepted:true};},read(ctx){return ctx.db.query('SELECT * FROM requests ORDER BY id');},receipt(ctx,input){const row=ctx.db.query('SELECT receipt FROM requests WHERE receipt=?',[input.fileId])[0];if(!row)ctx.refuse('missing_receipt','Receipt unavailable.');return {fileId:row.receipt};}};`;
const revision = describeDatasetRevision({definition, revision: 1, schemaSql, operationSource});

async function httpFixture(maxParticipantsPerGrant?: number) {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "relay-dataset-routes-"));
  let now = 10;
  const host = await f.storage.createDatasetHost({directory, limits, maxParticipantsPerGrant, nowMs: () => now, onShutdownError(error) {throw error;}});
  cleanups.push(async () => {await host.close(); await rm(directory, {recursive: true, force: true, maxRetries: 8, retryDelay: 25});});
  const linkKey = "dataset-http-test-key", token = "T".repeat(43);
  f.storage.mintLinkSession({session: {sessionId: "dataset-http", capabilityHash: hashLinkBearer(token, linkKey), grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
  const handler = createSyncRelayHandler({storage: f.storage, datasetHost: host, appPublicationLimits: limits, linkKey, nowMs: () => 10,
    resolveActor(request, workspaceId) {
      const credential = request.headers.get("authorization");
      if (credential !== "Bearer owner" && credential !== "Bearer helper" && credential !== "Bearer stranger") throw new UnauthorizedError();
      return {workspaceId, userId: credential.slice(7)};
    }});
  const http = (path: string, body?: unknown, headers: Record<string,string> = {}) => handler(new Request(`https://relay/sync/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {authorization: "Bearer owner", "content-type": "application/json", ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  const publicHeaders = {authorization: `LinkCapability ${token}`, "x-dohc-link-profile-secret": "P".repeat(43)};
  const path = `w/datasets/${id(1)}`;
  const activate = () => http(`${path}/activate`, {revision, schemaSql, operationSource, capacityBytes: 1024 * 1024});
  const invoke = (operationId = id(6), headers = {}) => http(`${path}/invoke`, {revision: 1, revisionSha256: revision.revisionSha256,
    operationId, input: {}, idempotencyKey: "read"}, headers);
  function publish(sourceRevision?: string) {
    const previous = f.storage.readAppPublication({workspaceId: "w", publicationId: f.publicationId, ownerUserId: "owner", limits});
    const capability = resolveAppDatasetCapability({kind: "dataset", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(5), id(6), id(8)]}, revision);
    const candidate = {...previous.candidate, ...(sourceRevision ? {sourceRevision} : {}), files: previous.candidate.files.filter(file => file.path === "bundle.js"), capabilities: [capability]};
    const digest = (domain: string, value: unknown) => createHash("sha256").update(JSON.stringify([domain, value])).digest("hex");
    candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
    candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest, dependencyLockDigest: candidate.dependencyLockDigest,
      compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
    return f.storage.publishAppPublication({workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 1, candidate, blobs: [], limits, nowMs: 10}).publicationId;
  }
  return {...f, host, handler, http, path, activate, invoke, publish, publicHeaders, advance(ms: number) {now += ms;}};
}

it("exposes bounded owner history and denies helpers, strangers, and malformed cursors", async () => {
  const f = await httpFixture(); await f.activate();
  const result = await f.http(`${f.path}/invoke`, { revision: 1, revisionSha256: revision.revisionSha256, operationId: id(5), input: { name: "Private name" }, idempotencyKey: "private-retry" });
  expect(result.status).toBe(200);
  const response = await f.http(`${f.path}/history?limit=1`); expect(response.status).toBe(200);
  const page = await response.json(); expect(page.entries).toHaveLength(1); expect(page.entries[0].operation).toBe("submit");
  expect(JSON.stringify(page)).not.toMatch(/private-retry|Private name|idempotencyKey|resultJson/);
  expect((await f.http(`${f.path}/history`, undefined, { authorization: "Bearer helper" })).status).toBe(404);
  expect((await f.http(`${f.path}/history`, undefined, { authorization: "Bearer stranger" })).status).toBe(404);
  expect((await f.http(`${f.path}/history?beforeRevision=0`)).status).toBe(400);
  expect((await f.http(`${f.path}/history?limit=101`)).status).toBe(400);
  expect((await f.http(`${f.path}/history?after=x`)).status).toBe(400);
});

it("creates and manages one dataset through authenticated routes and the public app broker", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  expect((await (await f.http("w/datasets")).json()).datasets[0].name).toBe("Requests");
  expect((await f.http(f.path)).status).toBe(200);
  const publicationId = f.publish(), publicPath = `link/app-publications/${publicationId}/backend/invoke`;
  const listing = await (await f.http("w/app-publications")).json();
  const listed = listing.publications.find((row: { publicationId: string }) => row.publicationId === publicationId);
  expect(listed).toMatchObject({ datasetCapability: { kind: "dataset", datasetId: id(1), operationIds: [id(5), id(6), id(8)] }, collectionCapability: null });
  expect(JSON.stringify(listed)).not.toContain(operationSource);
  const body = {authorityRevision: 1, operation: "submit", input: {name: "Friend"}, idempotencyKey: "submission"};
  expect((await f.http(publicPath, body, f.publicHeaders)).status).toBe(404);
  expect((await f.http(`${f.path}/binding`, {publicationId, enabled: true})).status).toBe(200);
  const first = await f.http(publicPath, body, f.publicHeaders);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({result: {accepted: true}, revision: 1});
  expect(await (await f.http(publicPath, body, f.publicHeaders)).json()).toMatchObject({replayed: true, revision: 1});
  expect(await (await f.invoke()).json()).toMatchObject({result: [{name: "Friend"}]});
  expect((await f.http(publicPath, {...body, operation: "read"}, f.publicHeaders)).status).toBe(404);
  const refusal = await f.http(publicPath, {...body, input: {}, idempotencyKey: "missing"}, f.publicHeaders);
  expect(refusal.status).toBe(409);
  expect(await refusal.json()).toEqual({code: "missing_name", message: "A name is required."});
  expect((await f.http(`${f.path}/binding`, {publicationId, enabled: false})).status).toBe(200);
  expect((await f.http(publicPath, body, f.publicHeaders)).status).toBe(404);
});

it("tells callers when to retry a dataset that waits to reopen", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  f.host.invoke = async () => { throw new DatasetReopenWaitError(9_500); };
  const waiting = await f.invoke();
  expect(waiting.status).toBe(503);
  expect(waiting.headers.get("retry-after")).toBe("10");
  expect(await waiting.json()).toEqual({code: "dataset_reopen_wait", message: "The dataset stopped before its work finished. Try again in 10 s."});
  // The failure that starts a wait says why, and when to retry.
  const message = "The app's code ran too long: it used more than 5 s of CPU time while replaying journal event 3 of 64. Try again.";
  f.host.invoke = async () => { throw Object.assign(new PersistentRuntimeError("worker_budget", message), {retryAfterMs: 5_000}); };
  const failed = await f.invoke();
  expect(failed.status).toBe(503);
  expect(failed.headers.get("retry-after")).toBe("5");
  expect(await failed.json()).toEqual({code: "worker_budget", message});
  // A reopen that failed on storage or a checkpoint says only that, with its wait.
  f.host.invoke = async () => { throw Object.assign(new PersistentRuntimeError("reopen_failed", "The dataset could not be reopened. Try again."), {retryAfterMs: 10_000}); };
  const reopen = await f.invoke();
  expect(reopen.status).toBe(503);
  expect(reopen.headers.get("retry-after")).toBe("10");
  expect(await reopen.json()).toEqual({code: "reopen_failed", message: "The dataset could not be reopened. Try again."});
  // A failed operation starts no wait.
  f.host.invoke = async () => { throw new PersistentRuntimeError("worker_stalled", "The dataset worker made no progress for 30 s while running the app operation. Try again."); };
  const stalled = await f.invoke();
  expect(stalled.status).toBe(503);
  expect(stalled.headers.get("retry-after")).toBeNull();
  expect((await stalled.json()).code).toBe("worker_stalled");
});

it("archives and restores a dataset with its rows, app bindings, and retry receipts intact", async () => {
  const f = await httpFixture(); await f.activate();
  const publicationId = f.publish(), secondPublicationId = f.publish("a".repeat(64));
  for (const app of [publicationId, secondPublicationId]) expect((await f.http(`${f.path}/binding`, {publicationId: app, enabled: true})).status).toBe(200);
  const publicPath = `link/app-publications/${publicationId}/backend/invoke`;
  const submission = {authorityRevision: 1, operation: "submit", input: {name: "Retained"}, idempotencyKey: "retained-submission"};
  expect((await f.http(publicPath, submission, f.publicHeaders)).status).toBe(200);
  const page = await (await f.http(`${f.path}/lifecycle?limit=1`)).json();
  expect(page).toMatchObject({archived: false, generation: 0, apps: [{appId: [publicationId, secondPublicationId].sort()[0]}]});
  expect(page.nextCursor).toBe(page.apps[0].appId);
  const next = await (await f.http(`${f.path}/lifecycle?limit=1&after=${page.nextCursor}`)).json();
  expect(next.apps.map((app: {appId: string}) => app.appId)).toEqual([[publicationId, secondPublicationId].sort()[1]]);
  expect(next.nextCursor).toBeNull();

  const archived = await f.http(`${f.path}/archive`, {}); expect(archived.status).toBe(200);
  expect(await archived.json()).toMatchObject({archived: true, generation: 1});
  const usage = f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!.storage_bytes;
  expect(await (await f.http(`${f.path}/archive`, {})).json()).toMatchObject({archived: true, generation: 1});
  expect(f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!.storage_bytes).toBe(usage);
  expect(await (await f.http("w/datasets")).json()).toEqual({datasets: [], nextCursor: null});
  expect(await (await f.http("w/datasets?includeArchived=true")).json()).toMatchObject({datasets: [{datasetId: id(1), archived: true}]});
  expect((await f.http(f.path)).status).toBe(409);
  expect(await (await f.http(`${f.path}?includeArchived=true`)).json()).toMatchObject({datasetId: id(1), archived: true, operations: []});
  expect((await f.invoke()).status).toBe(409);
  expect((await f.http(publicPath, {...submission, idempotencyKey: "while-archived"}, f.publicHeaders)).status).toBe(409);

  expect(await (await f.http(`${f.path}/restore`, {})).json()).toEqual({archived: false, generation: 2});
  expect(await (await f.http(`${f.path}/restore`, {})).json()).toEqual({archived: false, generation: 2});
  expect(await (await f.http(publicPath, submission, f.publicHeaders)).json()).toMatchObject({replayed: true, revision: 1});
  expect(await (await f.invoke()).json()).toMatchObject({result: [{name: "Retained"}]});
  expect(await (await f.http(`${f.path}/lifecycle`)).json()).toMatchObject({archived: false, generation: 2, apps: expect.arrayContaining([{appId: publicationId, binding: expect.any(Object)}, {appId: secondPublicationId, binding: expect.any(Object)}])});
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w' AND dataset_id=?").run(id(1)));
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM dohc_dataset_lifecycle").get()!.n).toBe(0);
});

it("restricts lifecycle management and archived discovery to owners and rejects malformed requests", async () => {
  const f = await httpFixture(); await f.activate();
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper-grant','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  const helper = {authorization: "Bearer helper", "x-dohc-dataset-grant": "helper-grant"};
  expect((await f.http(`${f.path}/grants`, {grantId: "helper-grant", grant: {revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6)], discover: true}})).status).toBe(200);
  for (const headers of [helper, {authorization: "Bearer stranger"}]) {
    expect((await f.http(`${f.path}/lifecycle`, undefined, headers)).status).toBe(404);
    for (const action of ["archive", "restore"]) expect((await f.http(`${f.path}/${action}`, {}, headers)).status).toBe(404);
    expect((await f.http("w/datasets?includeArchived=true", undefined, headers)).status).toBe(404);
    expect((await f.http(`${f.path}?includeArchived=true`, undefined, headers)).status).toBe(404);
  }
  for (const query of ["includeArchived=1", "includeArchived=", "includeArchived=TRUE", "includeArchived=true&includeArchived=false"]) {
    expect((await f.http(`w/datasets?${query}`)).status).toBe(400);
    expect((await f.http(`${f.path}?${query}`)).status).toBe(400);
  }
  for (const suffix of ["?limit=1", "?after=x", "/lifecycle?includeArchived=true", "/lifecycle?limit=101", "/lifecycle?after=", "/lifecycle?limit=1&limit=2"]) {
    expect((await f.http(`${f.path}${suffix}`)).status).toBe(400);
  }
  for (const action of ["archive", "restore"]) {
    expect((await f.http(`${f.path}/${action}`)).status).toBe(405);
    expect((await f.http(`${f.path}/${action}`, {userId: "owner"})).status).toBe(400);
    expect((await f.http(`${f.path}/${action}?includeArchived=true`, {})).status).toBe(400);
  }
  expect((await f.http(`${f.path}/lifecycle`, {})).status).toBe(405);
  expect((await f.http("w/datasets?includeArchived=false", undefined, helper)).status).toBe(200);
  await f.http(`${f.path}/archive`, {});
  expect(await (await f.http("w/datasets", undefined, helper)).json()).toEqual({datasets: [], nextCursor: null});
});

it("uses verified named grant membership and explicit data grants without source Edit", async () => {
  const f = await httpFixture(); await f.activate();
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper-grant','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  const headers = {authorization: "Bearer helper", "x-dohc-dataset-grant": "helper-grant"};
  expect((await f.invoke(id(6), headers)).status).toBe(404);
  expect((await f.http(`${f.path}/grants`, {grantId: "helper-grant", grant: {revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6)], discover: true}})).status).toBe(200);
  expect((await f.invoke(id(6), headers)).status).toBe(200);
  expect((await f.http("w/datasets", undefined, headers)).status).toBe(200);
  expect((await f.http(`${f.path}/artifacts`, undefined, headers)).status).toBe(404);
  expect((await f.http(`${f.path}/permissions`, undefined, headers)).status).toBe(404);
  expect((await f.invoke(id(6), {...headers, authorization: "Bearer stranger"})).status).toBe(404);
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='helper-grant'").run());
  expect((await f.invoke(id(6), headers)).status).toBe(404);
  const permissions = await (await f.http(`${f.path}/permissions`)).json();
  const principalKey = permissions.permissions.find((permission: {kind: string}) => permission.kind === "data").principal;
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_share_grants WHERE grant_id='helper-grant'").run());
  expect((await f.http(`${f.path}/grants`, {principalKey, grant: null})).status).toBe(200);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_data_grants").get()?.n).toBe(0);
});
it("resolves a desktop recipient's Collection grant from the named share route", async () => {
  const f = await httpFixture(); await f.activate();
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('desktop-helper','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  const named = { authorization: "Bearer helper" }, path = `shares/s/datasets/${id(1)}`;
  const invoke = () => f.http(`${path}/invoke`, { revision: 1, revisionSha256: revision.revisionSha256, operationId: id(6), input: {}, idempotencyKey: "desktop-read" }, named);
  expect((await (await f.http("shares/s/datasets", undefined, named)).json()).datasets).toEqual([]);
  expect((await invoke()).status).toBe(404);
  await f.http(`${f.path}/grants`, { grantId: "desktop-helper", grant: { revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6)], discover: true } });
  expect((await (await f.http("shares/s/datasets", undefined, named)).json()).datasets).toMatchObject([{ datasetId: id(1), operations: [{ operationId: id(6) }] }]);
  expect((await f.http(path, undefined, named)).status).toBe(200);
  expect((await invoke()).status).toBe(200);
  expect((await f.http(`${path}/artifacts`, undefined, named)).status).toBe(404);
  expect((await f.http("shares/s/datasets", undefined, { ...named, "x-dohc-dataset-grant": "g" })).status).toBe(404);
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='desktop-helper'").run());
  expect((await invoke()).status).toBe(404);
});
it("binds named saved pages to grant, discovery, schema and lifecycle authority without exposing that metadata", async () => {
  const f = await httpFixture(); await f.activate();
  for (const user of ["helper", "stranger"]) f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES(?, 's','user',?,NULL,'view',1,'active',1,NULL,NULL)`).run(`${user}-offline`, user));
  const named = { authorization: "Bearer helper" };
  const grant = { revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6)], discover: true };
  const token = async (headers = named) => {
    const response = await f.http("shares/s/datasets", undefined, headers);
    expect(response.status).toBe(200);
    const digest = response.headers.get("x-dohc-dataset-access"); expect(digest).toMatch(/^[a-f0-9]{64}$/);
    return digest;
  };
  const empty = await token();
  await f.http(`${f.path}/grants`, { grantId: "helper-offline", grant });
  const allowed = await token(); expect(allowed).not.toBe(empty);
  expect(await token({ authorization: "Bearer stranger" })).not.toBe(allowed);
  await f.http(`${f.path}/grants`, { grantId: "helper-offline", grant: { ...grant, discover: false } });
  const hidden = await token(); expect(hidden).not.toBe(allowed);
  await f.http(`${f.path}/grants`, { grantId: "helper-offline", grant });
  const visible = await token();
  expect((await f.http(`${f.path}/archive`, {})).status).toBe(200);
  expect(await token()).not.toBe(visible);
  const archived = await token();
  expect((await f.http(`${f.path}/restore`, {})).status).toBe(200);
  expect(await token()).not.toBe(archived);
  const restored = await token();
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id='helper-offline'").run());
  expect(await token()).not.toBe(restored);
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='helper-offline'").run());
  const denied = await f.http("shares/s/datasets", undefined, named);
  expect(denied.status).toBe(404); expect(denied.headers.has("x-dohc-dataset-access")).toBe(false);
});

it("discards named read bytes if access changes after dispatch instead of labeling them with the new grant", async () => {
  const f = await httpFixture(); await f.activate();
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('race-offline','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  await f.http(`${f.path}/grants`, { grantId: "race-offline", grant: { revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(6)], discover: true } });
  const original = f.host.list;
  const spy = vi.spyOn(f.host, "list").mockImplementation((...args) => {
    const result = original(...args);
    f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id='race-offline'").run());
    return result;
  });
  try {
    const response = await f.http("shares/s/datasets", undefined, { authorization: "Bearer helper" });
    expect(response.status).toBe(409); expect(await response.text()).not.toContain("Requests");
    expect(response.headers.get("x-dohc-dataset-access")).toMatch(/^[a-f0-9]{64}$/);
  } finally { spy.mockRestore(); }
});
it("mediates named native file uploads and downloads through explicitly granted attachment actions", async () => {
  const f = await httpFixture();
  const nativeDefinition = structuredClone(definition); nativeDefinition.datasetId = id(20);
  nativeDefinition.operations[0]!.fieldIds.push(id(7));
  nativeDefinition.operations[1]!.fieldIds.push(id(7));
  const nativeSource = operationSource.replace("return ctx.db.query('SELECT * FROM requests ORDER BY id');", `return {rows:ctx.db.query('SELECT * FROM requests ORDER BY id').map(row=>({id:row.id,values:{'${id(7)}':row.receipt}}))};`);
  const nativeRevision = describeDatasetRevision({definition: nativeDefinition, revision: 1, schemaSql, operationSource: nativeSource});
  const ownerPath = `w/datasets/${id(20)}`, namedPath = `shares/s/datasets/${id(20)}`, headers = {authorization: "Bearer helper"};
  expect((await f.http(`${ownerPath}/activate`, {revision: nativeRevision, schemaSql, operationSource: nativeSource})).status).toBe(200);
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('native-files','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  const pinned = {revision: 1, revisionSha256: nativeRevision.revisionSha256};
  const bytesBase64 = Buffer.from([137,80,78,71,13,10,26,10,0]).toString("base64");
  const upload = {...pinned, fieldId: id(7), name: "receipt.png", contentType: "image/png", bytesBase64, idempotencyKey: "native-upload"};
  expect((await f.http(`${namedPath}/upload`, upload, headers)).status).toBe(404);
  await f.http(`${ownerPath}/grants`, {grantId: "native-files", grant: {...pinned, operationIds: [id(5),id(6)], discover: true}});
  const response = await f.http(`${namedPath}/upload`, upload, headers); expect(response.status).toBe(200);
  const {file} = await response.json();
  const read = {...pinned, fileId: file.fileId, read: {operationId: id(6), fieldId: id(7), input: {}}};
  expect((await f.http(`${namedPath}/file`, read, headers)).status).toBe(404);
  expect((await f.http(`${namedPath}/invoke`, {...pinned, operationId: id(5), input: {name: "Helper", fileId: file.fileId}, idempotencyKey: "native-submit"}, headers)).status).toBe(200);
  expect(await (await f.http(`${namedPath}/file`, read, headers)).json()).toEqual({file, bytesBase64});
  expect((await f.http(`${namedPath}/file`, {...read, read: {...read.read, fieldId: id(4)}}, headers)).status).toBe(404);
  expect((await f.http(`${namedPath}/upload`, {...upload, fieldId: id(4)}, headers)).status).toBe(404);
  await f.http(`${ownerPath}/grants`, {grantId: "native-files", grant: null});
  expect((await f.http(`${namedPath}/file`, read, headers)).status).toBe(404);
});

it("rejects ambient credentials and forged request authority before changing data", async () => {
  const f = await httpFixture(); await f.activate();
  const credentialCases: Record<string,string>[] = [{cookie: "ambient"}, {authorization: ""}, f.publicHeaders, {authorization: "Bearer stranger"}];
  for (const headers of credentialCases) {
    expect([401,404]).toContain((await f.http(f.path, undefined, headers)).status);
  }
  expect((await f.http(`${f.path}/invoke`, {revision: 1, revisionSha256: revision.revisionSha256, operationId: id(5), input: {name: "bad"}, idempotencyKey: "bad", userId: "owner"})).status).toBe(400);
  expect((await f.http(`${f.path}/activate`, {revision: {...revision, datasetId: id(9)}, schemaSql, operationSource})).status).toBe(400);
  expect((await f.http(`${f.path}?workspaceId=other`)).status).toBe(400);
  expect((await f.http("w/datasets?limit=1&limit=2")).status).toBe(400);
  const stale = await f.http(`${f.path}/invoke`, {revision: 2, revisionSha256: revision.revisionSha256, operationId: id(6), input: {}, idempotencyKey: "stale"});
  expect(stale.status).toBe(409);
  expect(await (await f.invoke()).json()).toMatchObject({result: []});
});

it("migrates through the owner route and removes retained history with dataset accounting", async () => {
  const f = await httpFixture(); await f.activate();
  const artifacts = await (await f.http(`${f.path}/artifacts`)).json();
  const nextSchema = `${schemaSql} CREATE INDEX requests_name ON requests(name);`;
  const next = describeDatasetRevision({definition, revision: 2, schemaSql: nextSchema, operationSource});
  const prepared = await f.http(`${f.path}/prepare-migration`, {revision: next, schemaSql: nextSchema, operationSource,
    expected: artifacts.cursor, migrationSql: "CREATE INDEX requests_name ON requests(name);"});
  expect(prepared.status).toBe(200);
  const candidate = await prepared.json();
  expect(candidate.preview.firstPage.changes).toEqual([]);
  const migrated = await f.http(`${f.path}/approve-migration`, { candidateId: candidate.candidateId, checkpointSha256: candidate.checkpointSha256 });
  expect(migrated.status).toBe(200);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_catalog_history").get()?.n).toBe(1);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_checkpoint_history").get()?.n).toBe(1);
  f.storage.tx(() => {
    for (const [stageId, workspaceId, datasetId] of [["pending-owned", "w", id(1)], ["pending-other-dataset", "w", id(99)], ["pending-other-workspace", "other", id(1)]]) {
      if (workspaceId === "other") f.storage.db.prepare("INSERT OR IGNORE INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES('other','owner',1)").run();
      f.storage.db.prepare("INSERT INTO dohc_dataset_checkpoints VALUES(?,?,?,?,?,?,?,?)").run(stageId, workspaceId, datasetId, 1, "a".repeat(64), 0, 0, 1);
      f.storage.db.prepare("INSERT INTO dohc_dataset_checkpoint_chunks VALUES(?,?,?,?)").run(stageId, 0, new Uint8Array([1]), "b".repeat(64));
    }
  });
  const current = f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes;
  const dataset = f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage WHERE workspace_id='w'").get()!.storage_bytes;
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w'").run());
  expect(f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes).toBe(Number(current) - Number(dataset));
  for (const table of ["dohc_dataset_catalog_history", "dohc_dataset_checkpoint_history", "dohc_dataset_catalog", "dohc_dataset_journals"]) {
    expect(f.storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  }
  expect(f.storage.db.prepare("SELECT stage_id FROM dohc_dataset_checkpoints ORDER BY stage_id").all().map(row => row.stage_id)).toEqual(["pending-other-dataset", "pending-other-workspace"]);
  expect(f.storage.db.prepare("SELECT stage_id FROM dohc_dataset_checkpoint_chunks ORDER BY stage_id").all().map(row => row.stage_id)).toEqual(["pending-other-dataset", "pending-other-workspace"]);
});

const upload = {authorityRevision: 1, idempotencyKey: "receipt-upload", name: "receipt.png", contentType: "image/png",
  bytesBase64: Buffer.from([137,80,78,71,13,10,26,10,1,2,3]).toString("base64")};
async function attachmentsFixture() {
  const f = await httpFixture(); await f.activate(); const publicationId = f.publish();
  const app = (action: string, body: unknown, headers = f.publicHeaders) => f.http(`link/app-publications/${publicationId}/backend/${action}`, body, headers);
  const named = (action: string, body: unknown) => f.http(`w/app-publications/${publicationId}/backend/${action}`, body);
  const bind = (enabled: boolean) => f.http(`${f.path}/binding`, {publicationId, enabled});
  return {...f, app, named, bind, publicationId};
}

it("uploads and atomically attaches a receipt, then discloses bytes only through the approved read operation", async () => {
  const f = await attachmentsFixture();
  expect((await f.app("upload", upload)).status).toBe(404);
  await f.bind(true);
  const uploaded = await f.app("upload", upload); expect(uploaded.status).toBe(200);
  const {file} = await uploaded.json();
  expect(await (await f.app("upload", upload)).json()).toMatchObject({file, replayed: true});
  expect((await f.app("upload", {...upload, name: "changed.png"})).status).toBe(409);
  const read = {authorityRevision: 1, operation: "receipt", fileId: file.fileId, input: {fileId: file.fileId}};
  expect((await f.named("file", read)).status).toBe(409);
  const submit = {authorityRevision: 1, operation: "submit", input: {name: "Friend", fileId: file.fileId}, idempotencyKey: "receipt-submit"};
  expect((await f.app("invoke", submit)).status).toBe(200);
  const usage = f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!.storage_bytes;
  expect(await (await f.app("invoke", submit)).json()).toMatchObject({replayed: true});
  expect(f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage").get()!.storage_bytes).toBe(usage);
  expect((await f.app("file", read)).status).toBe(404);
  expect((await f.named("file", {...read, operation: "read"})).status).toBe(404);
  expect(await (await f.named("file", read)).json()).toEqual({file, bytesBase64: upload.bytesBase64});
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('file-helper','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  const helper = () => f.http(`w/app-publications/${f.publicationId}/backend/file`, read, {authorization: "Bearer helper", "x-dohc-dataset-grant": "file-helper"});
  expect((await helper()).status).toBe(404);
  await f.http(`${f.path}/grants`, {grantId: "file-helper", grant: {revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(8)], discover: false}});
  expect(await (await helper()).json()).toEqual({file, bytesBase64: upload.bytesBase64});
  await f.http(`${f.path}/grants`, {grantId: "file-helper", grant: null});
  expect((await helper()).status).toBe(404);
  await f.bind(false);
  expect((await f.named("file", read)).status).toBe(404);
  expect((await f.app("upload", upload)).status).toBe(404);
});

it("keeps staged files private to their caller and rolls attachment back with a refused operation", async () => {
  const f = await attachmentsFixture(); await f.bind(true);
  const {file} = await (await f.app("upload", upload)).json();
  const submit = {authorityRevision: 1, operation: "submit", input: {name: "Other", fileId: file.fileId}, idempotencyKey: "submit"};
  const second = {...f.publicHeaders, "x-dohc-link-profile-secret": "Q".repeat(43)};
  expect((await f.app("invoke", submit, second)).status).toBe(500);
  const another = await (await f.app("upload", upload, second)).json();
  expect(another.file.fileId).not.toBe(file.fileId);
  const otherApp = f.publish("a".repeat(64));
  await f.http(`${f.path}/binding`, {publicationId: otherApp, enabled: true});
  expect((await f.http(`link/app-publications/${otherApp}/backend/invoke`, submit, f.publicHeaders)).status).toBe(500);
  expect((await f.app("invoke", {...submit, input: {fileId: file.fileId}})).status).toBe(409);
  expect(f.storage.db.prepare("SELECT attached_revision FROM sync_relay_dataset_files WHERE file_id=?").get(file.fileId)!.attached_revision).toBeNull();
  const quota = f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes;
  expect((await f.app("upload", {...upload, bytesBase64: Buffer.from("not a png").toString("base64")})).status).toBe(400);
  expect(f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes).toBe(quota);
  f.advance(86_400_001);
  // Owner credentials remain valid after public link expiry and trigger bounded staged-file cleanup.
  expect((await f.named("upload", {...upload, idempotencyKey: "owner-new"})).status).toBe(200);
  expect(f.storage.db.prepare("SELECT file_id FROM sync_relay_dataset_files WHERE file_id=?").get(file.fileId)).toBeUndefined();
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w'").run());
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_files").get()!.n).toBe(0);
});

it("bounds pending uploads and rolls quota refusals back without retaining file bytes", async () => {
  const f = await attachmentsFixture(); await f.bind(true);
  const owner = {kind: "named" as const, workspaceId: "w", userId: "owner"};
  for (let n = 0; n < 32; n++) f.host.upload(owner, f.publicationId, {...upload, idempotencyKey: `pending-${n}`});
  expect(() => f.host.upload(owner, f.publicationId, {...upload, idempotencyKey: "overflow"})).toThrow("Submit pending uploads");
  expect(f.host.upload(owner, f.publicationId, {...upload, idempotencyKey: "pending-0"}).replayed).toBe(true);
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_files").get()!.n).toBe(32);
  const quota = f.storage.options.workspaceQuotaBytes;
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='w'").run(quota));
  expect((await f.app("upload", upload)).status).toBe(413);
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_files").get()!.n).toBe(32);
  expect(f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes).toBe(quota);
});

it("lets the workspace owner upload and inspect files without an app publication", async () => {
  const f = await httpFixture(); await f.activate();
  const {authorityRevision: _revision, ...bytes} = upload;
  const body = {...bytes, revision: 1, revisionSha256: revision.revisionSha256};
  const uploaded = await f.http(`${f.path}/upload`, body); expect(uploaded.status).toBe(200);
  const {file} = await uploaded.json(), request = {revision: 1, revisionSha256: revision.revisionSha256, fileId: file.fileId};
  expect(await (await f.http(`${f.path}/file`, request)).json()).toEqual({file, bytesBase64: upload.bytesBase64});
  expect((await f.http(`${f.path}/file`, request, {authorization: "Bearer stranger"})).status).toBe(404);
  expect((await f.http(`${f.path}/upload`, body, {authorization: "Bearer stranger"})).status).toBe(404);
  expect((await f.http(`${f.path}/upload`, {...body, revision: 2})).status).toBe(409);
  expect((await f.http(`${f.path}/file`, {...request, revision: 2})).status).toBe(409);
});


it("retains the first participant attempt across lost replies and clears only its captured token", async () => {
  const f = await httpFixture(); await f.activate(); const publicationId = f.publish();
  await f.http(`${f.path}/binding`, {publicationId, enabled: true});
  const path = `link/app-publications/${publicationId}/backend`;
  const request = (action: object, headers = f.publicHeaders) => f.http(`${path}/attempt`, {authorityRevision: 1, operation: "submit", ...action}, headers);
  expect(await (await request({action: "get"})).json()).toEqual({attempt: null});
  const save = {action: "save", idempotencyKey: "original", input: {name: "Friend"}};
  const first = await request(save); expect(first.status).toBe(200);
  const saved = await first.json(); expect(saved.attempt).toMatchObject({idempotencyKey: "original", input: {name: "Friend"}});
  expect(await (await request({...save, idempotencyKey: "other-tab", input: {name: "Changed"}})).json()).toEqual(saved);
  expect(await (await request({action: "get"})).json()).toEqual(saved);
  const invoke = {authorityRevision: 1, operation: "submit", idempotencyKey: saved.attempt.idempotencyKey, input: saved.attempt.input};
  expect((await f.http(`${path}/invoke`, invoke, f.publicHeaders)).status).toBe(200);
  expect(await (await f.http(`${path}/invoke`, invoke, f.publicHeaders)).json()).toMatchObject({revision: 1, replayed: true});
  expect(await (await f.invoke()).json()).toMatchObject({result: [{name: "Friend"}]});
  expect(await (await request({action: "get"}, {...f.publicHeaders, "x-dohc-link-profile-secret": "Q".repeat(43)})).json()).toEqual({attempt: null});
  expect((await request({action: "clear", token: "x".repeat(43)})).status).not.toBe(200);
  expect(await (await request({action: "get"})).json()).toEqual(saved);
  expect(await (await request({action: "clear", token: saved.attempt.token})).json()).toEqual({attempt: null});
  const next = await (await request({...save, idempotencyKey: "next"})).json();
  expect(next.attempt.token).not.toBe(saved.attempt.token);
  expect((await request({action: "clear", token: saved.attempt.token})).status).not.toBe(200);
  expect((await request({...save, principalKey: "other"})).status).toBe(400);
  await f.http(`${f.path}/binding`, {publicationId, enabled: false});
  expect((await request({action: "get"})).status).toBe(404);
});
it("preserves the configured participant cap across app publications while keeping owner access", async () => {
  const f = await httpFixture(1); await f.activate(); const publicationId = f.publish();
  await f.http(`${f.path}/binding`, {publicationId, enabled: true});
  const path = `link/app-publications/${publicationId}/backend/invoke`;
  const submit = {authorityRevision: 1, operation: "submit", input: {name: "First"}, idempotencyKey: "first"};
  expect((await f.http(path, submit, f.publicHeaders)).status).toBe(200);
  expect((await f.http(path, {...submit, idempotencyKey: "again"}, f.publicHeaders)).status).toBe(200);
  expect((await f.http(path, submit, {...f.publicHeaders, "x-dohc-link-profile-secret": "Q".repeat(43)})).status).toBe(413);
  const otherApp = f.publish("a".repeat(64)); await f.http(`${f.path}/binding`, {publicationId: otherApp, enabled: true});
  expect((await f.http(`link/app-publications/${otherApp}/backend/upload`, upload, {...f.publicHeaders, "x-dohc-link-profile-secret": "Q".repeat(43)})).status).toBe(413);
  expect((await f.invoke()).status).toBe(200);
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_participants").get()!.n).toBe(1);
});

it("accepts 100 distinct public participants through the unified dataset backend", async () => {
  const f = await httpFixture(100); await f.activate(); const publicationId = f.publish();
  await f.http(`${f.path}/binding`, {publicationId, enabled: true});
  for (let index = 0; index < 100; index++) {
    const response = await f.http(`link/app-publications/${publicationId}/backend/invoke`,
      {authorityRevision: 1, operation: "submit", input: {name: `Friend ${index}`}, idempotencyKey: `submit-${index}`},
      {...f.publicHeaders, "x-dohc-link-profile-secret": String(index).padStart(43, "P")});
    expect(response.status).toBe(200);
  }
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_participants").get()!.n).toBe(100);
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM dohc_dataset_receipts").get()!.n).toBe(100);
  expect((await f.invoke()).status).toBe(200);
});

it("imports a fenced dataset and its receipt over HTTP with a durable retry receipt", async () => {
  const source = await httpFixture(), target = await httpFixture(); await source.activate();
  const owner = {kind: "named" as const, workspaceId: "w", userId: "owner"};
  const {authorityRevision: _authorityRevision, ...fileBody} = upload;
  const uploaded = source.host.ownerUpload(owner, {workspaceId: "w", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, ...fileBody});
  await source.host.invoke(owner, {workspaceId: "w", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationId: id(5), input: {name: "Restored", fileId: uploaded.file.fileId}, idempotencyKey: "saved"});
  const journal = createDatasetJournal({db: source.storage.db, transaction: run => source.storage.tx(run)});
  const scope = {workspaceId: "w", datasetId: id(1)}, cursor = journal.head(scope, () => {}).cursor;
  journal.fence({expected: cursor, authorize() {}});
  const archive = await source.host.exportRecovery(owner, scope);
  try {
    const chunks = []; for await (const bytes of archive.stream()) chunks.push(bytes);
    const body = Buffer.concat(chunks), transferId = "http-transfer", manifestSha256 = createHash("sha256").update(encodeRecoveryManifest(archive.manifest, {maxTotalBytes: source.storage.options.workspaceQuotaBytes})).digest("hex");
    const url = `https://relay/sync/w/datasets/${id(1)}/imports/${transferId}`;
    const request = () => new Request(url, {method: "POST", headers: {authorization: "Bearer owner", "content-type": "application/octet-stream",
      "x-dohc-dataset-manifest-sha256": manifestSha256, "x-dohc-dataset-source-cursor": JSON.stringify(cursor)}, body});
    expect(await (await target.handler(new Request(url, {headers: {authorization: "Bearer owner"}}))).json()).toBeNull();
    const before = Number(target.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes);
    target.storage.tx(() => target.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='w'").run(target.storage.options.workspaceQuotaBytes - 50_000));
    expect((await target.handler(request())).status).toBe(413);
    expect(target.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_usage").get()!.n).toBe(0);
    expect(target.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_import_files").get()!.n).toBe(0);
    target.storage.tx(() => target.storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='w'").run(before));
    const response = await target.handler(request()); expect(response.status).toBe(200);
    const receipt = await response.json(); expect(receipt).toMatchObject({transferId, manifestSha256, sourceCursor: cursor, targetCursor: {revision: cursor.revision + 1}});
    const usage = target.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes;
    expect(await (await target.handler(new Request(url, {headers: {authorization: "Bearer owner"}}))).json()).toEqual(receipt);
    expect(await (await target.handler(request())).json()).toEqual(receipt);
    expect(target.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes).toBe(usage);
    expect(await (await target.invoke()).json()).toMatchObject({result: [{name: "Restored", receipt: uploaded.file.fileId}]});
    expect(target.host.ownerReadFile(owner, {...scope, revision: 1, revisionSha256: revision.revisionSha256, fileId: uploaded.file.fileId})).toEqual({file: uploaded.file, bytesBase64: upload.bytesBase64});
    expect(target.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_dataset_import_files").get()!.n).toBe(0);
    expect((await target.handler(new Request(url, {headers: {authorization: "Bearer stranger"}}))).status).toBe(404);
    target.storage.tx(() => target.storage.db.prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w' AND dataset_id=?").run(id(1)));
    for (const table of ["dohc_dataset_imports", "dohc_dataset_import_records", "dohc_dataset_import_metadata", "dohc_dataset_import_checkpoints", "dohc_dataset_checkpoints", "dohc_dataset_checkpoint_chunks", "sync_relay_dataset_files"]) {
      expect(target.storage.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
    }
  } finally {await archive.dispose();}
});


it("transfers a lost-response attempt and replays it under the same publication without a second row", async () => {
  const source = await httpFixture(), target = await httpFixture(); await source.activate();
  const publicationId = source.publish(); await source.http(`${source.path}/binding`, {publicationId, enabled: true});
  const route = `link/app-publications/${publicationId}/backend`;
  const uploaded = await (await source.http(`${route}/upload`, upload, source.publicHeaders)).json();
  const input = {name: "Lost response", fileId: uploaded.file.fileId}, idempotencyKey = "lost-response";
  const pending = await (await source.http(`${route}/attempt`, {authorityRevision: 1, operation: "submit", action: "save", input, idempotencyKey}, source.publicHeaders)).json();
  // The write commits; the participant has not received its acknowledgement.
  expect((await source.http(`${route}/invoke`, {authorityRevision: 1, operation: "submit", input, idempotencyKey}, source.publicHeaders)).status).toBe(200);
  const owner = {kind: "named" as const, workspaceId: "w", userId: "owner"}, scope = {workspaceId: "w", datasetId: id(1)};
  const journal = createDatasetJournal({db: source.storage.db, transaction: run => source.storage.tx(run)}), cursor = journal.head(scope, () => {}).cursor;
  journal.fence({expected: cursor, authorize() {}});
  const archive = await source.host.exportRecovery(owner, scope);
  try {
    const chunks = []; for await (const bytes of archive.stream()) chunks.push(bytes);
    const manifestSha256 = createHash("sha256").update(encodeRecoveryManifest(archive.manifest, {maxTotalBytes: source.storage.options.workspaceQuotaBytes})).digest("hex");
    const response = await target.handler(new Request(`https://relay/sync/w/datasets/${id(1)}/imports/retry-transfer`, {method: "POST", headers: {
      authorization: "Bearer owner", "content-type": "application/octet-stream", "x-dohc-dataset-manifest-sha256": manifestSha256,
      "x-dohc-dataset-source-cursor": JSON.stringify(cursor)}, body: Buffer.concat(chunks)}));
    expect(response.status).toBe(200);
    expect(target.publish()).toBe(publicationId);
    const restored = await target.http(`${route}/attempt`, {authorityRevision: 1, operation: "submit", action: "get"}, target.publicHeaders);
    expect(restored.status).toBe(200); expect(await restored.json()).toEqual(pending);
    expect(await (await target.http(`${route}/invoke`, {authorityRevision: 1, operation: "submit", input: pending.attempt.input, idempotencyKey: pending.attempt.idempotencyKey}, target.publicHeaders)).json()).toMatchObject({replayed: true});
    expect(await (await target.invoke()).json()).toMatchObject({result: [{name: "Lost response", receipt: uploaded.file.fileId}]});
    const anotherPublication = target.publish("b".repeat(64));
    const refused = await target.http(`${target.path}/binding`, {publicationId: anotherPublication, enabled: true});
    expect(refused.status).toBe(409);
    const before = Number(target.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes);
    expect((await target.http(`${route}/attempt`, {authorityRevision: 1, operation: "submit", action: "clear", token: pending.attempt.token}, target.publicHeaders)).status).toBe(200);
    expect(Number(target.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes)).toBeLessThan(before);
    expect((await target.http(`${target.path}/binding`, {publicationId: anotherPublication, enabled: true})).status).toBe(200);
  } finally {await archive.dispose();}
});

it("requires an owner and a current, acknowledged deletion review", async () => {
  const f = await httpFixture(); await f.activate();
  const publicationId=f.publish(); await f.http(`${f.path}/binding`,{publicationId,enabled:true});
  expect(await (await f.http(`${f.path}/deletion-status`)).json()).toEqual({deleted:false});
  const response=await f.http(`${f.path}/delete-preview?limit=1`); expect(response.status).toBe(200);
  const preview=await response.json(); expect(preview).toMatchObject({name:"Requests",irreversible:true,apps:[{appId:publicationId}]});
  const request={expected:preview.cursor,reviewToken:preview.reviewToken,acknowledge:true};
  for(const user of ["helper","stranger"]){
    expect((await f.http(`${f.path}/deletion-status`,undefined,{authorization:`Bearer ${user}`})).status).toBe(404);
    expect((await f.http(`${f.path}/delete-preview`,undefined,{authorization:`Bearer ${user}`})).status).toBe(404);
    expect((await f.http(`${f.path}/delete`,request,{authorization:`Bearer ${user}`})).status).toBe(404);
  }
  expect((await f.http(`${f.path}/delete-preview?limit=101`)).status).toBe(400);
  expect((await f.http(`${f.path}/delete-preview?limit=1&limit=2`)).status).toBe(400);
  for(const invalid of [{...request,acknowledge:false},{...request,acknowledge:undefined},{...request,reviewToken:undefined},
    {...request,expected:{...preview.cursor,datasetId:id(9)}},{...request,force:true}]) expect((await f.http(`${f.path}/delete`,invalid)).status).toBe(400);
  await f.http(`${f.path}/invoke`,{revision:1,revisionSha256:revision.revisionSha256,operationId:id(5),input:{name:"Latest"},idempotencyKey:"latest"});
  expect((await f.http(`${f.path}/delete`,request)).status).toBe(409);
  const current=await (await f.http(`${f.path}/delete-preview`)).json();
  expect(await (await f.http(`${f.path}/delete`,{expected:current.cursor,reviewToken:current.reviewToken,acknowledge:true})).json()).toEqual({deleted:true,datasetId:id(1)});
  expect(await (await f.http(`${f.path}/deletion-status`)).json()).toEqual({deleted:true});
  expect((await f.http(`${f.path}/deletion-status?after=x`)).status).toBe(400);
  expect((await f.invoke()).status).not.toBe(200);
  expect((await f.activate()).status).not.toBe(200);
});


it("keeps published upload, saved submission, and protected file paths working after a display rename", async () => {
  const f = await attachmentsFixture(); await f.bind(true);
  const next = structuredClone(definition); next.tables[0].fields[1].name="Full name";
  const renamed = describeDatasetRevision({definition:next,revision:2,schemaSql,operationSource});
  const artifacts=await (await f.http(`${f.path}/artifacts`)).json();
  const prepared=await f.http(`${f.path}/prepare-migration`,{revision:renamed,schemaSql,operationSource,expected:artifacts.cursor,migrationSql:"SELECT 1;"});
  expect(prepared.status).toBe(200); const candidate=await prepared.json();
  expect((await f.http(`${f.path}/approve-migration`,{candidateId:candidate.candidateId,checkpointSha256:candidate.checkpointSha256})).status).toBe(200);
  const uploaded=await f.app("upload",upload); expect(uploaded.status).toBe(200); const {file}=await uploaded.json();
  const input={name:"After rename",fileId:file.fileId}, identity={authorityRevision:1,operation:"submit"};
  const saved=await f.app("attempt",{...identity,action:"save",idempotencyKey:"renamed-submit",input}); expect(saved.status).toBe(200);
  const attempt=await saved.json();
  expect((await f.app("invoke",{...identity,input,idempotencyKey:"renamed-submit"})).status).toBe(200);
  expect(await (await f.app("invoke",{...identity,input,idempotencyKey:"renamed-submit"})).json()).toMatchObject({replayed:true});
  expect((await f.app("attempt",{...identity,action:"clear",token:attempt.attempt.token})).status).toBe(200);
  const read={authorityRevision:1,operation:"receipt",fileId:file.fileId,input:{fileId:file.fileId}};
  expect(await (await f.named("file",read)).json()).toEqual({file,bytesBase64:upload.bytesBase64});
  expect((await f.app("file",read)).status).toBe(404);
  await f.bind(false);
  expect((await f.named("file",read)).status).toBe(404);
  expect((await f.app("upload",upload)).status).toBe(404);
});

it("exposes immutable approved rule history only through the owner route", async () => {
  const f = await httpFixture(); expect((await f.activate()).status).toBe(200);
  const path = `${f.path}/history-revision?revisionSha256=${revision.revisionSha256}`;
  const response = await f.http(path); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revision, schemaSql, operationSource });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await f.http(path, undefined, { authorization: "Bearer helper" })).status).toBe(404);
  expect((await f.http(path, undefined, { authorization: "Bearer stranger" })).status).toBe(404);
  expect((await f.http(`${f.path}/history-revision?revisionSha256=invalid`)).status).toBe(400);
  expect((await f.http(`${path}&revisionSha256=${revision.revisionSha256}`)).status).toBe(400);

});
