import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, copyFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { openSyncRelayStorage, type SyncRelayStorage } from "../storage";
import { initializeRelayDeployment, openRelayDeployment } from "../relayDeployment";
import type { StorageContext } from "./context";
import { createSyncRelayHandler } from "../server";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { MAX_PAYLOAD_JSON_BYTES } from "../wireLimits";

const limits = { maxFiles: 10, maxMetadataBytes: 16_384, maxBundleBytes: 4096 };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const script = Buffer.from("document.body.textContent='Trip poll';");
const style = Buffer.from("body { color: red }");
const candidate = (): AppPublicationCandidate => ({
  versionId: "main", appRoot: "app", entryPath: "app/index.ts", packageMap: {}, sourceRevision: "1".repeat(64), sourceDigest: "2".repeat(64),
  dependencyLockDigest: "6".repeat(64), bundleDigest: "7".repeat(64), buildDigest: "8".repeat(64),
  compilerIdentity: {recipe: "closed-esbuild", version: "0.28.1", binarySha256: "3".repeat(64)},
  inputs: [{path: "app/index.ts", sha256: "4".repeat(64), byteLength: 20}, {path: "shared/util.ts", sha256: "5".repeat(64), byteLength: 10}],
  dependencies: ["app/index.ts", "shared/util.ts"],
  files: [{path: "bundle.js", sha256: digest(script), byteLength: script.byteLength, contentType: "text/javascript; charset=utf-8"},
    {path: "bundle.css", sha256: digest(style), byteLength: style.byteLength, contentType: "text/css; charset=utf-8"}],
  capabilities: [],
});
const owner = {workspaceId: "w", shareId: "s", grantId: "g", generation: 1, ownerUserId: "owner"};
const request = () => {
  const value = parseAppPublicationCandidate(candidate(), limits);
  const recordDigest = (domain: string, value: unknown) => digest(JSON.stringify([domain, value]));
  value.sourceDigest = recordDigest("dohc-app-source-v2", {entry: value.entryPath, files: value.inputs, packages: Object.entries(value.packageMap)});
  value.dependencyLockDigest = recordDigest("dohc-app-dependencies-v1", value.inputs);
  value.bundleDigest = recordDigest("dohc-app-bundle-v1", value.files);
  value.buildDigest = recordDigest("dohc-app-build-v1", {sourceDigest: value.sourceDigest, dependencyLockDigest: value.dependencyLockDigest, compiler: value.compilerIdentity, bundleDigest: value.bundleDigest});
  return {...owner, candidate: value, limits, nowMs: 10,
    blobs: [{sha256: digest(script), bytes: script}, {sha256: digest(style), bytes: style}]};
};
const cleanups: (() => void)[] = [];
afterEach(() => {for (const close of cleanups.splice(0).reverse()) close();});
function seed(storage: SyncRelayStorage, paths = ["app", "shared"]) {
  storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
  storage.claimWorkspace({workspaceId: "other", ownerUserId: "other-owner", createdAtMs: 1});
  storage.createShare({share: {shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({paths, versionId: null}), createdAtMs: 1},
    grant: {grantId: "g", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
}
function fixture(options: {paths?: string[]; quota?: number} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "publication-test-")), path = join(dir, "relay.sqlite");
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  let storage = openSyncRelayStorage(path, {blobGraceMs: 0, ...(options.quota ? {workspaceQuotaBytes: options.quota} : {})});
  cleanups.push(() => storage.close());seed(storage, options.paths);
  return {get storage() {return storage;}, restart() {storage.close(); storage = openSyncRelayStorage(path, {blobGraceMs: 0});},
    get raw() {return (storage as StorageContext).db;}};
}

it("canonicalizes selected shared dependencies and refuses malformed candidate contracts", () => {
  const input = candidate();input.inputs.reverse();input.dependencies.reverse();input.files.reverse();
  expect(parseAppPublicationCandidate(input, limits)).toEqual(parseAppPublicationCandidate(candidate(), limits));
  const invalid: unknown[] = [
    {...candidate(), unexpected: true}, {...candidate(), capabilities: [{kind: "read"}]},
    {...candidate(), inputs: [{path: "../private", sha256: "4".repeat(64), byteLength: 1}]},
    {...candidate(), dependencies: ["secret.ts"]}, {...candidate(), dependencies: ["app/index.ts", "app/index.ts"]},
    {...candidate(), files: [{...candidate().files[0], contentType: "text/html"}]},
    {...candidate(), files: [{...candidate().files[0], sha256: "bad"}]},
  ];
  for (const value of invalid) expect(() => parseAppPublicationCandidate(value, limits)).toThrow();
  expect(() => parseAppPublicationCandidate(candidate(), {...limits, maxBundleBytes: 1})).toThrow();
  expect(() => parseAppPublicationCandidate(candidate(), {...limits, maxMetadataBytes: 1})).toThrow();
  expect(() => parseAppPublicationCandidate(candidate(), {maxFiles: 10} as typeof limits)).toThrow();
});

it("stores complete bytes atomically, persists withdrawal, and retains immutable blobs during GC", async () => {
  const f = fixture(), published = f.storage.publishAppPublication(request());
  expect(f.storage.publishAppPublication({...request(), blobs: []})).toEqual(published);
  const read = {workspaceId: "w", publicationId: published.publicationId, ownerUserId: "owner", limits};
  expect(() => f.storage.withdrawAppPublication({...read, expectedAuthorityRevision: 2})).toThrow();
  const withdrawn = f.storage.withdrawAppPublication({...read, expectedAuthorityRevision: 1});
  expect(withdrawn.active).toBe(false);expect(withdrawn.authorityRevision).toBe(2);
  expect(f.storage.publishAppPublication(request())).toEqual({...withdrawn, candidate: published.candidate});
  expect(f.storage.withdrawAppPublication({...read, expectedAuthorityRevision: 2})).toEqual(withdrawn);
  await f.storage.collectUnreferencedBlobs("w", {nowMs: 1000});
  expect(f.storage.getBlob("w", digest(script))).toEqual(script);
  f.restart();expect(f.storage.readAppPublication(read)).toEqual({...withdrawn, candidate: published.candidate});
});

it.each(["owner", "workspace", "generation", "grant", "version", "selector", "revoked"])("rechecks %s authority before committing", kind => {
  const f = fixture({paths: kind === "selector" ? ["app"] : undefined}), input = request();
  if (kind === "owner") input.ownerUserId = "reader";
  if (kind === "workspace") input.workspaceId = "other";
  if (kind === "generation") input.generation = 2;
  if (kind === "grant") input.grantId = "missing";
  if (kind === "version") input.candidate.versionId = "fork";
  if (kind === "revoked") f.storage.revokeShareGrant({shareId: "s", grantId: "g", revokedAtMs: 2});
  expect(() => f.storage.publishAppPublication(input)).toThrow();
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_publications").get()?.n).toBe(0);
  expect(f.storage.getBlob("w", digest(script))).toBeNull();
});

it.each(["missing", "corrupt-upload", "corrupt-existing", "quota"])("rolls back all publication writes on %s", kind => {
  const f = fixture({quota: kind === "quota" ? 100 : undefined}), input = request();
  if (kind === "missing") input.blobs = input.blobs.slice(0, 1);
  if (kind === "corrupt-upload") input.blobs[0].bytes = Buffer.alloc(script.byteLength);
  if (kind === "corrupt-existing") {
    f.storage.putBlob({workspaceId: "w", sha256: digest(style), content: Buffer.alloc(style.byteLength), createdAtMs: 1});
    input.blobs = input.blobs.slice(0, 1);
  }
  expect(() => f.storage.publishAppPublication(input)).toThrow();
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_publications").get()?.n).toBe(0);
  expect(f.storage.getBlob("w", digest(script))).toBeNull();
});

it("checks owner authority before reading corrupt metadata", () => {
  const f = fixture(), published = f.storage.publishAppPublication(request());
  f.raw.prepare("UPDATE sync_relay_blobs SET content=x'00' WHERE sha256=(SELECT manifest_sha256 FROM sync_relay_app_publications)").run();
  expect(() => f.storage.readAppPublication({workspaceId: "w", publicationId: published.publicationId, ownerUserId: "reader", limits})).toThrow(/not found/i);
  expect(() => f.storage.readAppPublication({workspaceId: "other", publicationId: published.publicationId, ownerUserId: "owner", limits})).toThrow(/not found/i);
  expect(() => f.storage.readAppPublication({workspaceId: "w", publicationId: published.publicationId, ownerUserId: "owner", limits})).toThrow(/manifest/i);
  expect(f.storage.withdrawAppPublication({workspaceId: "w", publicationId: published.publicationId, ownerUserId: "owner", expectedAuthorityRevision: 1}).active).toBe(false);
});

it("refuses an actual stale deployment backup after withdrawal", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-continuity-"));
  cleanups.push(() => rmSync(root, {recursive: true, force: true}));
  const paths = {configPath: join(root, "deployment.json"), relayPath: join(root, "volume", "relay.sqlite"), continuityDirectory: join(root, "continuity")};
  initializeRelayDeployment(paths);const deployment = openRelayDeployment(paths.configPath);
  const backupPath = join(root, "backup.sqlite");
  try {
    seed(deployment.storage);const published = deployment.storage.publishAppPublication(request());
    const source = new DatabaseSync(paths.relayPath, {readOnly: true});
    try {await backup(source, backupPath);} finally {source.close();}
    deployment.storage.withdrawAppPublication({workspaceId: "w", publicationId: published.publicationId, ownerUserId: "owner", expectedAuthorityRevision: 1});
  } finally {deployment.storage.close();}
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(paths.relayPath + suffix)) renameSync(paths.relayPath + suffix, paths.relayPath + suffix + ".preserved");
  copyFileSync(backupPath, paths.relayPath);
  expect(() => openRelayDeployment(paths.configPath)).toThrow(/continuity/);
});

function httpFixture(configured = true) {
  const f = fixture();
  const handler = createSyncRelayHandler({storage: f.storage, ...(configured ? {appPublicationLimits: limits} : {}), nowMs: () => 20,
    resolveActor: (request, workspaceId) => {
      const token = request.headers.get("authorization");
      if (token !== "Bearer owner" && token !== "Bearer reader") throw new UnauthorizedError();
      return {userId: token.slice(7), workspaceId};
    }});
  const http = (path: string, body?: unknown, token = "owner") => handler(new Request(`http://relay/sync/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  const input = request();
  const upload = async () => {
    for (const blob of input.blobs) expect((await handler(new Request(`http://relay/sync/w/blobs/${blob.sha256}`, {
      method: "PUT", headers: {authorization: "Bearer owner"}, body: blob.bytes,
    }))).status).toBe(200);
  };
  return {...f, handler, http, upload, body: {shareId: "s", grantId: "g", expectedGrantGeneration: 1, candidate: input.candidate}};
}

it("publishes through authenticated bounded HTTP and withdraws without disclosing other workspaces", async () => {
  const f = httpFixture();await f.upload();
  expect((await f.http("w/app-publications", f.body, "unknown")).status).toBe(401);
  expect((await f.http("w/app-publications", f.body, "reader")).status).toBe(404);
  expect((await f.http("w/app-publications", {...f.body, ownerUserId: "owner"})).status).toBe(400);
  expect((await f.http("w/app-publications", {...f.body, expectedGrantGeneration: 2})).status).toBe(409);
  const response = await f.http("w/app-publications", f.body);expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const published = await response.json();expect(published.owner.ownerUserId).toBe("owner");expect(published.createdAtMs).toBe(20);
  const path = `w/app-publications/${published.publicationId}`;
  expect((await f.http(path)).status).toBe(200);
  f.storage.claimWorkspace({workspaceId: "same-owner", ownerUserId: "owner", createdAtMs: 1});
  expect((await f.http(`same-owner/app-publications/${published.publicationId}`)).status).toBe(404);
  expect((await f.http(`same-owner/app-publications/${published.publicationId}/withdraw`, {expectedAuthorityRevision: 1})).status).toBe(404);
  const withdrawn = await f.http(`${path}/withdraw`, {expectedAuthorityRevision: 1});expect(withdrawn.status).toBe(200);
  expect((await withdrawn.json()).active).toBe(false);
  expect((await (await f.http("w/app-publications", f.body)).json()).active).toBe(false);
});

it("refuses unconfigured routes and cancels oversized metadata streams before JSON parsing", async () => {
  const off = httpFixture(false);expect((await off.http("w/app-publications", off.body)).status).toBe(404);
  const f = httpFixture();let cancelled = false;
  const body = new ReadableStream<Uint8Array>({pull(controller) {controller.enqueue(new Uint8Array(MAX_PAYLOAD_JSON_BYTES + 1));}, cancel() {cancelled = true;}});
  const response = await f.handler(new Request("http://relay/sync/w/app-publications", {
    method: "POST", headers: {authorization: "Bearer owner", "content-type": "application/json"}, body, duplex: "half",
  } as RequestInit));
  expect(response.status).toBe(413);expect(cancelled).toBe(true);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_publications").get()?.n).toBe(0);
});

it("rechecks a revoked grant after request body parsing yields", async () => {
  const f = httpFixture();await f.upload();
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({start(controller) {send = controller;}});
  let reading!: () => void;
  const readerAcquired = new Promise<void>(resolve => {reading = resolve;});
  const getReader = body.getReader.bind(body);
  body.getReader = (() => {const reader = getReader();reading();return reader;}) as typeof body.getReader;
  const pending = f.handler(new Request("http://relay/sync/w/app-publications", {
    method: "POST", headers: {authorization: "Bearer owner", "content-type": "application/json"}, body, duplex: "half",
  } as RequestInit));
  await readerAcquired;
  f.storage.revokeShareGrant({shareId: "s", grantId: "g", revokedAtMs: 2});
  send.enqueue(Buffer.from(JSON.stringify(f.body)));send.close();
  expect((await pending).status).toBe(404);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_publications").get()?.n).toBe(0);
});

it("never falls back to ambient cookies for owner publication authentication", async () => {
  const f = httpFixture();await f.upload();
  let authCalls = 0;
  const handler = createSyncRelayHandler({storage: f.storage, appPublicationLimits: limits,
    resolveActor: request => {authCalls++;expect(request.headers.has("cookie")).toBe(false);return {userId: "owner", workspaceId: "w"};}});
  const cookieHeaders: Record<string, string>[] = [{cookie: "owner-session"}, {cookie: "owner-session", authorization: "Bearer fake"}];
  for (const headers of cookieHeaders) {
    const response = await handler(new Request("http://relay/sync/w/app-publications", {method: "POST", headers, body: JSON.stringify(f.body)}));
    expect(response.status).toBe(404);
  }
  expect(authCalls).toBe(0);
  expect((await f.handler(new Request("http://relay/sync/w/app-publications", {method: "POST", headers: {authorization: "Bearer owner", "content-type": "text/plain"}, body: JSON.stringify(f.body)}))).status).toBe(400);
});
