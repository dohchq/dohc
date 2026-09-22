import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { openSyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import type { AppBackendAuth } from "./appBackendAuthority";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => sha(JSON.stringify([domain, value]));
export const limits = {maxFiles: 20, maxMetadataBytes: 65536, maxBundleBytes: 65536};
export const owner: AppBackendAuth = {kind: "named", workspaceId: "w", userId: "owner"};
const cleanups: (() => void)[] = [];
afterEach(() => {for (const cleanup of cleanups.splice(0).reverse()) cleanup();});

/** A published browser app and share; no legacy backend is created. */
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dataset-relay-test-"));
  cleanups.push(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "relay.sqlite");
  let storage = openSyncRelayStorage(path) as StorageContext;
  cleanups.push(() => storage.close());
  storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
  storage.createShare({share: {shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({paths: ["app"], versionId: null}), createdAtMs: 1},
    grant: {grantId: "g", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  storage.tx(() => storage.db.prepare("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='g'").run());
  const bytes = Buffer.from("document.body.textContent='app'");
  const candidate = parseAppPublicationCandidate({versionId: "main", appRoot: "app", entryPath: "app/index.ts", packageMap: {},
    sourceRevision: "1".repeat(64), sourceDigest: "2".repeat(64), dependencyLockDigest: "3".repeat(64), bundleDigest: "4".repeat(64), buildDigest: "5".repeat(64),
    compilerIdentity: {recipe: "closed-esbuild", version: "0.28.1", binarySha256: "6".repeat(64)},
    inputs: [{path: "app/index.ts", sha256: "7".repeat(64), byteLength: 10}], dependencies: ["app/index.ts"],
    files: [{path: "bundle.js", sha256: sha(bytes), byteLength: bytes.byteLength, contentType: "text/javascript; charset=utf-8"}], capabilities: []}, limits);
  candidate.sourceDigest = digest("dohc-app-source-v2", {entry: candidate.entryPath, files: candidate.inputs, packages: []});
  candidate.dependencyLockDigest = digest("dohc-app-dependencies-v1", candidate.inputs);
  candidate.bundleDigest = digest("dohc-app-bundle-v1", candidate.files);
  candidate.buildDigest = digest("dohc-app-build-v1", {sourceDigest: candidate.sourceDigest, dependencyLockDigest: candidate.dependencyLockDigest, compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest});
  const publication = storage.publishAppPublication({workspaceId: "w", ownerUserId: "owner", shareId: "s", grantId: "g", generation: 1, candidate, limits, nowMs: 5,
    blobs: [{sha256: sha(bytes), bytes}]});
  return {get storage() {return storage;}, publicationId: publication.publicationId,
    restart() {storage.close(); storage = openSyncRelayStorage(path) as StorageContext;},
    link(id: string): AppBackendAuth {
      storage.mintLinkSession({session: {sessionId: `session-${id}`, capabilityHash: `capability-${id}`, grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: 1000}});
      return {kind: "link", capabilityHash: `capability-${id}`, profileTokenHash: `profile-${id}`};
    },
  };
}
