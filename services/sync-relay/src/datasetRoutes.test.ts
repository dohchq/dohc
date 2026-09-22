import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { resolveAppDatasetCapability, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture, limits } from "./appBackendTestFixture";
import { createSyncRelayHandler } from "./server";
import { hashLinkBearer } from "./linkSecurity";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = {formatVersion: 1, datasetId: id(1), name: "Requests", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
  tables: [{tableId: id(2), name: "Requests", sqlName: "requests", primaryKey: "id", fields: [
    {fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true},
    {fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false},
  ]}], operations: [
    {operationId: id(5), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)]},
    {operationId: id(6), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)]},
  ]};
const schemaSql = "CREATE TABLE requests(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
const operationSource = `globalThis.operations={submit(ctx,input){if(!input.name)ctx.refuse('missing_name','A name is required.');ctx.db.execute('INSERT INTO requests VALUES(?,?)',[ctx.requestId,input.name]);return {accepted:true};},read(ctx){return ctx.db.query('SELECT * FROM requests ORDER BY id');}};`;
const revision = describeDatasetRevision({definition, revision: 1, schemaSql, operationSource});

async function httpFixture() {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "relay-dataset-routes-"));
  const host = await f.storage.createDatasetHost({directory, limits, nowMs: () => 10, onShutdownError(error) {throw error;}});
  cleanups.push(async () => {await host.close(); await rm(directory, {recursive: true, force: true, maxRetries: 8, retryDelay: 25});});
  const linkKey = "dataset-http-test-key", token = "T".repeat(43);
  f.storage.mintLinkSession({session: {sessionId: "dataset-http", capabilityHash: hashLinkBearer(token, linkKey), grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
  const handler = createSyncRelayHandler({storage: f.storage, datasetHost: host, appBackendsEnabled: true, appPublicationLimits: limits, linkKey, nowMs: () => 10,
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
  function publish() {
    const previous = f.storage.readAppPublication({workspaceId: "w", publicationId: f.publicationId, ownerUserId: "owner", limits});
    const capability = resolveAppDatasetCapability({kind: "dataset", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationIds: [id(5), id(6)]}, revision);
    const candidate = {...previous.candidate, files: previous.candidate.files.filter(file => file.path === "bundle.js"), capabilities: [capability]};
    const digest = (domain: string, value: unknown) => createHash("sha256").update(JSON.stringify([domain, value])).digest("hex");
    candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
    candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest, dependencyLockDigest: candidate.dependencyLockDigest,
      compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
    return f.storage.publishAppPublication({workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 1, candidate, blobs: [], limits, nowMs: 10}).publicationId;
  }
  return {...f, host, http, path, activate, invoke, publish, publicHeaders};
}

it("creates and manages one dataset through authenticated routes and the public app broker", async () => {
  const f = await httpFixture();
  expect((await f.activate()).status).toBe(200);
  expect((await (await f.http("w/datasets")).json()).datasets[0].name).toBe("Requests");
  expect((await f.http(f.path)).status).toBe(200);
  const publicationId = f.publish(), publicPath = `link/app-publications/${publicationId}/backend/invoke`;
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
  const migrated = await f.http(`${f.path}/migrate`, {revision: next, schemaSql: nextSchema, operationSource,
    expected: artifacts.cursor, migrationSql: "CREATE INDEX requests_name ON requests(name);"});
  expect(migrated.status).toBe(200);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_catalog_history").get()?.n).toBe(1);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_checkpoint_history").get()?.n).toBe(1);
  const current = f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes;
  const dataset = f.storage.db.prepare("SELECT storage_bytes FROM sync_relay_dataset_usage WHERE workspace_id='w'").get()!.storage_bytes;
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id='w'").run());
  expect(f.storage.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='w'").get()!.usage_bytes).toBe(Number(current) - Number(dataset));
  for (const table of ["dohc_dataset_catalog_history", "dohc_dataset_checkpoint_history", "dohc_dataset_catalog", "dohc_dataset_journals"]) {
    expect(f.storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  }
});
