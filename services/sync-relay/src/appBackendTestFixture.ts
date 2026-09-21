import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { evaluateAppOperation, initializeAppDatabase } from "@dohc/app-backend-runtime";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { createAppBackendHost, type AppBackendAuth } from "./appBackendHost";
import { openSyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { initializeAppBackendSchema } from "./storage/appBackendSchema";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
export const limits = {maxFiles: 20, maxMetadataBytes: 65536, maxBundleBytes: 65536};
export const owner: AppBackendAuth = {kind: "named", workspaceId: "w", userId: "owner"};
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
export function fixture(evaluate: typeof evaluateAppOperation = evaluateAppOperation) {
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
export const input = (idempotencyKey: string, operation = "reserve", payload = {}) => ({authorityRevision: 1, operation, idempotencyKey, input: payload});

