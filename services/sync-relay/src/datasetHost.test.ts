import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { resolveAppDatasetCapability, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture as appFixture, limits, owner } from "./appBackendTestFixture";
import type { AppBackendAuth } from "./appBackendAuthority";
import { createRelayDatasetHost, type RelayDatasetHost } from "./datasetHost";
import { workspaceUsageBytes } from "./storage/workspaces";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const schemaSql = "CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
const operationSource = `globalThis.operations={
  submit(ctx,input){ctx.db.execute('INSERT INTO people VALUES(?,?)',[ctx.requestId,input.name]);return {accepted:true};},
  read(ctx){return ctx.db.query('SELECT * FROM people ORDER BY id');},
  edit(ctx,input){ctx.db.execute('UPDATE people SET name=? WHERE id=?',[input.name,input.id]);return true;}
};`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "registrations/schema.sql", operationsPath: "registrations/operations.js",
  tables: [{tableId: id(2), name: "People", sqlName: "people", primaryKey: "id", fields: [
    {fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true},
    {fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false},
  ]}], operations: [
    {operationId: id(5), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)]},
    {operationId: id(6), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)]},
    {operationId: id(7), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "helper", readOnly: false, fieldIds: [id(4)]},
  ],
};
const revision = describeDatasetRevision({definition, revision: 1, schemaSql, operationSource});
const scope = {workspaceId: "w", datasetId: definition.datasetId};
const helper: AppBackendAuth = {kind: "named", workspaceId: "w", userId: "helper", grantId: "helper-grant"};

async function fixture() {
  const base = appFixture(), directory = await mkdtemp(join(tmpdir(), "relay-dataset-test-"));
  let host: RelayDatasetHost;
  const shutdownErrors: unknown[] = [];
  const create = () => createRelayDatasetHost({storage: base.storage, directory, limits, nowMs: () => 10, onShutdownError(error) {shutdownErrors.push(error);}});
  host = await create();
  cleanups.push(async () => {await host.close(); await rm(directory, {recursive: true, force: true, maxRetries: 8, retryDelay: 25}); expect(shutdownErrors).toEqual([]);});
  const activate = () => host.activate(owner, {...scope, revision, schemaSql, operationSource, capacityBytes: 1024 * 1024});
  const invoke = (auth: AppBackendAuth, operationId: string, input = {}, publicationId?: string, key = "request") => host.invoke(auth,
    {...scope, revision: revision.revision, revisionSha256: revision.revisionSha256, operationId, input, idempotencyKey: key,
      ...(publicationId ? {access: {kind: "app" as const, appId: publicationId}} : {})});
  function addHelper() {
    base.storage.tx(() => base.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES('helper-grant','s','user','helper',NULL,'view',1,'active',1,NULL,NULL)`).run());
  }
  function publish(operationIds = [id(5)]) {
    const previous = base.storage.readAppPublication({...scope, publicationId: base.publicationId, ownerUserId: "owner", limits});
    const capability = resolveAppDatasetCapability({kind: "dataset", datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationIds}, revision);
    const candidate = {...previous.candidate, capabilities: [capability], files: previous.candidate.files.filter(file => file.path === "bundle.js")};
    const digest = (domain: string, value: unknown) => createHash("sha256").update(JSON.stringify([domain, value])).digest("hex");
    candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
    candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest, dependencyLockDigest: candidate.dependencyLockDigest,
      compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
    const result = base.storage.publishAppPublication({workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 1,
      candidate, blobs: [], limits, nowMs: 10});
    host.bindPublication(owner, {...scope, publicationId: result.publicationId});
    return result.publicationId;
  }
  return {...base, get host() {return host;}, activate, invoke, publish, addHelper,
    async reopen() {await host.close(); host = await create();}};
}

it("creates standalone data on the relay connection and recovers app writes after host restart", async () => {
  const f = await fixture(), before = workspaceUsageBytes(f.storage, "w");
  await f.activate();
  expect(f.host.list(owner, {workspaceId: "w"}).datasets.map(dataset => dataset.name)).toEqual(["Registrations"]);
  const publicationId = f.publish(), link = f.link("friend");
  const first = await f.invoke(link, id(5), {name: "Friend"}, publicationId);
  expect(first).toMatchObject({revision: 1, result: {accepted: true}, replayed: false});
  expect(workspaceUsageBytes(f.storage, "w")).toBeGreaterThan(before + 1024 * 1024);
  await f.reopen();
  expect(await f.invoke(link, id(5), {name: "Friend"}, publicationId)).toEqual({...first, replayed: true});
  expect((await f.invoke(owner, id(6))).result).toMatchObject([{name: "Friend"}]);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_events").get()?.n).toBe(1);
});

it("keeps public submission separate from discovery and rejects forged cross-workspace bindings", async () => {
  const f = await fixture(); await f.activate();
  const publicationId = f.publish(), link = f.link("friend");
  expect(() => f.host.list(link, {workspaceId: "w"})).toThrow();
  expect(() => f.host.describe(link, scope)).toThrow();
  await expect(f.invoke(link, id(6), {}, publicationId)).rejects.toThrow();
  await expect(f.invoke(link, id(5), {name: "friend"})).rejects.toThrow();
  const otherOwner: AppBackendAuth = {kind: "named", workspaceId: "other", userId: "other-owner"};
  f.storage.claimWorkspace({workspaceId: "other", ownerUserId: "other-owner", createdAtMs: 1});
  await expect(f.host.activate(otherOwner, {...scope, revision, schemaSql, operationSource})).rejects.toThrow();
  await expect(f.host.invoke(link, {...scope, workspaceId: "other", revision: 1, revisionSha256: revision.revisionSha256,
    operationId: id(5), input: {name: "bad"}, idempotencyKey: "bad", access: {kind: "app", appId: publicationId}})).rejects.toThrow();
  expect(() => f.host.bindPublication(otherOwner, {...scope, publicationId})).toThrow();
  expect(f.host.list(otherOwner, {workspaceId: "other"}).datasets).toEqual([]);
});

it("allows only explicitly granted helper operations with view-only source access", async () => {
  const f = await fixture(); await f.activate(); f.addHelper();
  const publicationId = f.publish([id(5), id(6), id(7)]);
  expect(f.host.list(helper, {workspaceId: "w"}).datasets).toEqual([]);
  await expect(f.invoke(helper, id(6), {}, publicationId)).rejects.toThrow();
  f.host.setDataGrant(owner, {...scope, grantId: "helper-grant", grant: {operationIds: [id(6)], discover: true, revision: 1, revisionSha256: revision.revisionSha256}});
  expect((await f.invoke(helper, id(6), {}, publicationId)).result).toEqual([]);
  await expect(f.invoke(helper, id(7), {id: "other", name: "bad"}, publicationId)).rejects.toThrow();
  expect(f.host.describe(helper, scope).operations.map(operation => operation.name)).toEqual(["read"]);
  expect(() => f.host.bindPublication(helper, {...scope, publicationId})).toThrow();
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='helper-grant'").run());
  expect(() => f.host.list(helper, {workspaceId: "w"})).toThrow();
  await expect(f.invoke(helper, id(6), {}, publicationId)).rejects.toThrow();
});

it("rejects cross-workspace grant targets and returns metadata quota on revocation", async () => {
  const f = await fixture(); await f.activate(); f.addHelper();
  const before = workspaceUsageBytes(f.storage, "w");
  f.host.setDataGrant(owner, {...scope, grantId: "helper-grant", grant: {operationIds: [id(6)], discover: true, revision: 1, revisionSha256: revision.revisionSha256}});
  expect(workspaceUsageBytes(f.storage, "w")).toBeGreaterThan(before);
  f.host.setDataGrant(owner, {...scope, grantId: "helper-grant", grant: null});
  expect(workspaceUsageBytes(f.storage, "w")).toBe(before);
  f.storage.claimWorkspace({workspaceId: "other", ownerUserId: "other-owner", createdAtMs: 1});
  f.storage.createShare({share: {shareId: "other-share", workspaceId: "other", granterUserId: "other-owner", selectorJson: JSON.stringify({paths: ["app"], versionId: null}), createdAtMs: 1},
    grant: {grantId: "other-grant", shareId: "other-share", principalKind: "user", principalUserId: "helper", principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  expect(() => f.host.setDataGrant(owner, {...scope, grantId: "other-grant", grant: {operationIds: [id(6)], discover: true, revision: 1, revisionSha256: revision.revisionSha256}})).toThrow();
  expect(() => f.host.setDataGrant(owner, {...scope, grantId: "missing", grant: {operationIds: [id(6)], discover: true, revision: 1, revisionSha256: revision.revisionSha256}})).toThrow();
});

it("rolls quota refusal back with the event and receipt, then accepts the same retry", async () => {
  const f = await fixture(); await f.activate();
  const before = workspaceUsageBytes(f.storage, "w"), quota = f.storage.options.workspaceQuotaBytes;
  f.storage.options.workspaceQuotaBytes = before + 10;
  await expect(f.invoke(owner, id(5), {name: "pending"})).rejects.toThrow("quota");
  expect(workspaceUsageBytes(f.storage, "w")).toBe(before);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_events").get()?.n).toBe(0);
  expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_receipts").get()?.n).toBe(0);
  f.storage.options.workspaceQuotaBytes = quota;
  expect((await f.invoke(owner, id(5), {name: "pending"})).revision).toBe(1);
  expect((await f.invoke(owner, id(6))).result).toMatchObject([{name: "pending"}]);
});

it("rolls failed activation back without leaving catalog rows or reserved quota", async () => {
  const f = await fixture(), before = workspaceUsageBytes(f.storage, "w"), quota = f.storage.options.workspaceQuotaBytes;
  f.storage.options.workspaceQuotaBytes = before + 100;
  await expect(f.activate()).rejects.toThrow("quota");
  expect(workspaceUsageBytes(f.storage, "w")).toBe(before);
  for (const table of ["dohc_dataset_catalog", "dohc_dataset_journals", "sync_relay_dataset_usage"]) {
    expect(f.storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
  }
  f.storage.options.workspaceQuotaBytes = quota;
  await f.activate();
});

it("stops workers when storage closes and reopens against the same durable journal", async () => {
  const f = await fixture(); await f.activate();
  await f.invoke(owner, id(5), {name: "saved"});
  f.restart();
  await expect(f.invoke(owner, id(6))).rejects.toThrow("unavailable");
  await f.reopen();
  expect((await f.invoke(owner, id(6))).result).toMatchObject([{name: "saved"}]);
});

it("refuses publication withdrawal and storage shutdown before further data disclosure", async () => {
  const f = await fixture(); await f.activate();
  const publicationId = f.publish(), link = f.link("friend");
  await f.invoke(link, id(5), {name: "friend"}, publicationId);
  f.storage.withdrawAppPublication({...scope, publicationId, ownerUserId: "owner", expectedAuthorityRevision: 1});
  await expect(f.invoke(link, id(5), {name: "friend"}, publicationId)).rejects.toThrow();
  await f.host.close();
  expect(() => f.host.list(owner, {workspaceId: "w"})).toThrow("closed");
  await expect(f.invoke(owner, id(6))).rejects.toThrow("closed");
});
