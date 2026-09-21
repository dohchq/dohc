import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluateAppOperation, initializeAppDatabase, type EvaluateAppOperationInput } from "@dohc/app-backend-runtime";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { createAppBackendHost, type AppBackendAuth } from "./appBackendHost";
import { openSyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { initializeAppBackendSchema } from "./storage/appBackendSchema";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
const limits = {maxFiles: 20, maxMetadataBytes: 65536, maxBundleBytes: 65536};
const owner: AppBackendAuth = {kind: "named", workspaceId: "w", userId: "owner"};
const schema = "CREATE TABLE slots(id TEXT PRIMARY KEY NOT NULL, remaining INTEGER NOT NULL); INSERT INTO slots VALUES('only',1); CREATE TABLE registrations(id TEXT PRIMARY KEY NOT NULL, file TEXT);";
const source = `globalThis.operations = {
  reserve(ctx,input) {
    const remaining=ctx.db.query("SELECT remaining FROM slots WHERE id='only'")[0].remaining;
    if(remaining<1)ctx.refuse('full','No slots remain.');
    ctx.db.execute("UPDATE slots SET remaining=remaining-1 WHERE id='only'");
    if(input.fileId)ctx.files.attach(input.fileId);
    ctx.db.execute('INSERT INTO registrations(id,file) VALUES(?,?)',[ctx.requestId,input.fileId||null]);
    return {id:ctx.requestId,secret:ctx.secret};
  },
  read(ctx) {return ctx.db.query('SELECT * FROM slots');},
  fileAccess(ctx,input) {return {fileId:input.fileId};},
  administer(ctx) {return {kind:ctx.caller.kind};},
  ownerOnly(ctx) {return {kind:ctx.caller.kind};}
};`;
const cleanups: (() => void)[] = [];
afterEach(() => {for (const cleanup of cleanups.splice(0).reverse()) cleanup();});
function fixture(evaluate: typeof evaluateAppOperation = evaluateAppOperation) {
  const dir = mkdtempSync(join(tmpdir(), "app-backend-host-test-"));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  let storage = openSyncRelayStorage(join(dir, "relay.sqlite")) as StorageContext;
  cleanups.push(() => storage.close());
  initializeAppBackendSchema(storage.db);
  storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
  storage.createShare({share: {shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({paths: ["app"], versionId: null}), createdAtMs: 1},
    grant: {grantId: "g", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  storage.tx(() => storage.db.prepare("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='g'").run());
  const blobs = [{path: "bundle.js", bytes: Buffer.from("document.body.textContent='app'"), contentType: "text/javascript; charset=utf-8"},
    {path: "backend.js", bytes: Buffer.from(source), contentType: "text/javascript; charset=utf-8"},
    {path: "schema.sql", bytes: Buffer.from(schema), contentType: "application/sql; charset=utf-8"}];
  const candidate = parseAppPublicationCandidate({versionId: "main", appRoot: "app", entryPath: "app/index.ts", packageMap: {},
    sourceRevision: "1".repeat(64), sourceDigest: "2".repeat(64), dependencyLockDigest: "3".repeat(64), bundleDigest: "4".repeat(64), buildDigest: "5".repeat(64),
    compilerIdentity: {recipe: "closed-esbuild", version: "0.28.1", binarySha256: "6".repeat(64)},
    inputs: [{path: "app/index.ts", sha256: "7".repeat(64), byteLength: 10}], dependencies: ["app/index.ts"],
    files: blobs.map(({path, bytes, contentType}) => ({path, sha256: sha(bytes), byteLength: bytes.byteLength, contentType})),
    capabilities: [{kind: "app-backend", dataPath: "data/signups", backendPath: "backend.js", schemaPath: "schema.sql", backendSha256: sha(source), schemaSha256: sha(schema), schemaVersion: 1,
      operations: [{name: "reserve", access: "link", readOnly: false}, {name: "read", access: "link", readOnly: true},
        {name: "fileAccess", access: "helper", readOnly: true}, {name: "administer", access: "helper", readOnly: true}, {name: "ownerOnly", access: "owner", readOnly: true}],
      tables: [{name: "slots", primaryKey: "id", readOperation: "read", writeOperation: "reserve"}, {name: "registrations", primaryKey: "id", readOperation: "read", writeOperation: null}]}]}, limits);
  candidate.sourceDigest = digest("dohc-app-source-v2", {entry: candidate.entryPath, files: candidate.inputs, packages: []});
  candidate.dependencyLockDigest = digest("dohc-app-dependencies-v1", candidate.inputs);
  candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
  candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest, dependencyLockDigest: candidate.dependencyLockDigest, compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
  const publication = storage.publishAppPublication({workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 1, candidate, limits, nowMs: 5,
    blobs: blobs.map(({bytes}) => ({sha256: sha(bytes), bytes}))});
  let host = createAppBackendHost({storage, limits, nowMs: () => 10, runtime: {initializeAppDatabase, evaluateAppOperation: evaluate}});
  const link = (id: string): AppBackendAuth => {
    storage.mintLinkSession({session: {sessionId: `session-${id}`, capabilityHash: `capability-${id}`, grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
    return {kind: "link", capabilityHash: `capability-${id}`, profileTokenHash: `profile-${id}`};
  };
  return {get storage() { return storage; }, get host() { return host; }, publicationId: publication.publicationId, link,
    restart() {
      storage.close();
      storage = openSyncRelayStorage(join(dir, "relay.sqlite")) as StorageContext;
      host = createAppBackendHost({storage, limits, nowMs: () => 10, runtime: {initializeAppDatabase, evaluateAppOperation: evaluate}});
    },
    publishUpgrade() {
      return storage.publishAppPublication({workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 1,
        candidate: {...candidate, sourceRevision: "a".repeat(64)}, limits, nowMs: 5, blobs: []}).publicationId;
    }};
}
const input = (idempotencyKey: string, operation = "reserve", payload = {}) => ({authorityRevision: 1, operation, idempotencyKey, input: payload});

it("serializes concurrent last-slot reservations, preserving an invocation identity across retries", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => {release = resolve;});
  const seen: EvaluateAppOperationInput[] = [];
  const f = fixture(async value => {
    seen.push(value);
    if (seen.length === 2) release();
    if (seen.length <= 2) await ready;
    return evaluateAppOperation(value);
  });
  await f.host.activate(owner, f.publicationId, 1);
  const outcomes = await Promise.allSettled([f.host.invoke(f.link("a"), f.publicationId, input("a")), f.host.invoke(f.link("b"), f.publicationId, input("b"))]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
  expect(seen).toHaveLength(3);
  const repeated = seen.slice(0, 2).find(value => value.requestId === seen[2]!.requestId)!;
  expect(repeated.secret).toBe(seen[2]!.secret);
  expect((await f.host.invoke(owner, f.publicationId, input("read", "read"))).result).toEqual([{id: "only", remaining: 0}]);
});

it("replays committed replies without executing again and checks authority before replay", async () => {
  let evaluations = 0;
  const f = fixture(value => {evaluations++; return evaluateAppOperation(value);});
  await f.host.activate(owner, f.publicationId, 1);
  const caller = f.link("a");
  const first = await f.host.invoke(caller, f.publicationId, input("one"));
  expect(await f.host.invoke(caller, f.publicationId, input("one"))).toEqual({...first, replayed: true});
  expect(evaluations).toBe(1);
  await expect(f.host.invoke(caller, f.publicationId, input("one", "reserve", {changed: true}))).rejects.toMatchObject({code: "conflict"});
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_shares SET link_writes_paused_at_ms=10 WHERE share_id='s'").run());
  await expect(f.host.invoke(caller, f.publicationId, input("one"))).rejects.toMatchObject({code: "not_found"});
});

it.each(["withdraw", "block", "pause", "owner", "abort"])("refuses %s between evaluation and commit", async kind => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const ready = new Promise<void>(resolve => {release = resolve;});
  const f = fixture(async value => {const result = await evaluateAppOperation(value); entered(); await ready; return result;});
  await f.host.activate(owner, f.publicationId, 1);
  const controller = new AbortController();
  const operation = f.host.invoke(f.link("a"), f.publicationId, input("one"), controller.signal);
  const refused = expect(operation).rejects.toThrow();
  await started;
  if (kind === "withdraw") f.storage.withdrawAppPublication({workspaceId: "w", ownerUserId: "owner", publicationId: f.publicationId, expectedAuthorityRevision: 1});
  if (kind === "abort") controller.abort();
  if (kind === "block") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_link_principals SET blocked_at_ms=10").run());
  if (kind === "pause") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_shares SET link_writes_paused_at_ms=10").run());
  if (kind === "owner") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other'").run());
  release(); await refused;
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_app_backend_receipts").get()?.n).toBe(0);
  expect(f.storage.db.prepare("SELECT revision FROM sync_relay_app_backends").get()?.revision).toBe(1);
});

it("keeps staged files private, attaches atomically, and refuses arbitrary public reads", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  const caller = f.link("a");
  const upload = {authorityRevision: 1, idempotencyKey: "file", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.7 test").toString("base64")};
  const staged = f.host.upload(caller, f.publicationId, upload);
  expect(f.host.upload(caller, f.publicationId, upload)).toEqual({...staged, replayed: true});
  await expect(f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId})).rejects.toThrow();
  await f.host.invoke(caller, f.publicationId, input("one", "reserve", {fileId: staged.file.fileId}));
  await expect(f.host.readFile(caller, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId})).rejects.toThrow();
  await expect(f.host.readFile(caller, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId, operation: "fileAccess", input: {fileId: staged.file.fileId}})).rejects.toThrow();
  expect((await f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId})).bytesBase64).toBe(upload.bytesBase64);
  expect(() => f.host.upload(caller, f.publicationId, {...upload, idempotencyKey: "spoof", bytesBase64: Buffer.from("html").toString("base64")})).toThrow();
});

it("requires both an explicit helper mark and a current named Edit grant", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper','s','user','helper-user',NULL,'edit',1,'active',1,NULL,NULL)`).run());
  const caller: AppBackendAuth = {kind: "named", workspaceId: "w", userId: "helper-user"};
  await expect(f.host.invoke(caller, f.publicationId, input("admin", "administer"))).rejects.toThrow();
  f.host.helper(owner, f.publicationId, {authorityRevision: 1, grantId: "helper", enabled: true});
  expect((await f.host.invoke(caller, f.publicationId, input("admin", "administer"))).result).toEqual({kind: "named"});
  expect(f.host.descriptor(caller, f.publicationId).files.map(file => file.path)).toEqual(["bundle.js"]);
  await expect(f.host.invoke(caller, f.publicationId, input("owner", "ownerOnly"))).rejects.toThrow();
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE grant_id='helper'").run());
  await expect(f.host.invoke(caller, f.publicationId, input("admin", "administer"))).rejects.toThrow();
});

it("retains committed data and receipts through restart and source publication changes", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  const caller = f.link("a");
  const first = await f.host.invoke(caller, f.publicationId, input("one"));
  f.restart();
  expect(await f.host.invoke(caller, f.publicationId, input("one"))).toEqual({...first, replayed: true});
  expect(await f.host.activate(owner, f.publicationId, 1)).toMatchObject({revision: first.revision});
  const next = f.publishUpgrade();
  await f.host.activate(owner, next, 1);
  expect((await f.host.invoke(owner, next, input("read", "read"))).result).toEqual([{id: "only", remaining: 0}]);
  await expect(f.host.invoke(caller, f.publicationId, input("one"))).rejects.toThrow();
  expect(f.host.export(owner, next)).toBeDefined();
});

it("does not return private bytes when an access decision becomes stale", async () => {
  let revoke: (() => void) | undefined;
  const f = fixture(async value => {
    const result = await evaluateAppOperation(value);
    if (value.operation === "fileAccess") revoke?.();
    return result;
  });
  await f.host.activate(owner, f.publicationId, 1);
  const staged = f.host.upload(owner, f.publicationId, {authorityRevision: 1, idempotencyKey: "upload", name: "private.txt", contentType: "text/plain", bytesBase64: Buffer.from("private").toString("base64")});
  await f.host.invoke(owner, f.publicationId, input("attach", "reserve", {fileId: staged.file.fileId}));
  revoke = () => f.storage.withdrawAppPublication({workspaceId: "w", ownerUserId: "owner", publicationId: f.publicationId, expectedAuthorityRevision: 1});
  await expect(f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId, operation: "fileAccess", input: {fileId: staged.file.fileId}})).rejects.toThrow();
});
