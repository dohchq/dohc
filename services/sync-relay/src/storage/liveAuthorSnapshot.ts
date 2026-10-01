import { randomUUID } from "node:crypto";
import { parseLiveAuthorContext, parseLiveAuthorSnapshot, type LiveAuthorContext, type LiveAuthorEntry, type LiveAuthorSnapshot } from "@dohc/live-session-contract";
import { parseLiveUpdateIdentifier, type ServerDerivedLiveUpdateAuthority } from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";
import { assertWorkspaceQuota } from "./workspaces";

export interface TrustedLiveAccount {
  readonly accountId: string;
  readonly name: string;
}

/** The caller holds the transaction that admits the update or enrolls the link principal. */
export function ensureLiveLinkPublicPrincipal(storage: StorageContext, authority: Extract<ServerDerivedLiveUpdateAuthority, {principalKind: "named" | "link"}>): string {
  if (authority.principalKind !== "link") throw new TypeError("A link principal is required.");
  const principal = storage.getLinkPrincipal(authority.principalId);
  const grant = storage.getShareGrant(authority.grantId);
  const share = grant && storage.getShare(grant.shareId);
  if (!principal || principal.grantId !== authority.grantId || grant?.principalKind !== "link" || !share) throw new TypeError("The enrolled link principal is unavailable.");
  const mapping = storage.db.prepare("SELECT workspace_id,public_principal_id FROM sync_relay_app_public_principals WHERE grant_id=? AND principal_id=?")
    .get(authority.grantId,authority.principalId);
  if (mapping) {
    if (mapping.workspace_id !== share.workspaceId) throw new Error("The public link principal mapping is damaged.");
    return parseLiveUpdateIdentifier(mapping.public_principal_id);
  }
  const publicId = `public_${randomUUID()}`;
  const storageBytes = Buffer.byteLength(JSON.stringify([share.workspaceId,authority.grantId,authority.principalId,publicId]))+128;
  assertWorkspaceQuota(storage,share.workspaceId,storageBytes);
  storage.db.prepare("INSERT INTO sync_relay_app_public_principals(workspace_id,grant_id,principal_id,public_principal_id,storage_bytes) VALUES(?,?,?,?,?)")
    .run(share.workspaceId,authority.grantId,authority.principalId,publicId,storageBytes);
  return publicId;
}

/** Only an explicit recording context matching the authenticated principal earns a snapshot. */
export function deriveLiveAuthorSnapshot(storage: StorageContext, authority: ServerDerivedLiveUpdateAuthority,
  recordingContext: LiveAuthorContext | undefined, trustedAccount?: TrustedLiveAccount): LiveAuthorSnapshot {
  if (recordingContext === undefined) return [];
  const context = parseLiveAuthorContext(recordingContext);
  const authors: LiveAuthorEntry[] = [];
  if (context.kind === "account") {
    if (authority.principalKind === "link" || context.accountId !== authority.principalId ||
        trustedAccount?.accountId !== authority.principalId) return [];
    authors.push({kind: "human",humanId: trustedAccount.accountId,humanName: trustedAccount.name});
  } else if (context.kind === "link") {
    if (authority.principalKind !== "link") return [];
    const publicId = ensureLiveLinkPublicPrincipal(storage,authority);
    if (context.publicPrincipalId !== publicId) return [];
    const principal = storage.getLinkPrincipal(authority.principalId);
    if (!principal || principal.grantId !== authority.grantId) throw new Error("The enrolled link principal changed.");
    authors.push({kind: "link",publicPrincipalId: publicId,label: principal.displayName ?? "Anonymous"});
  } else return [];
  if (context.agent) authors.push({kind: "agent",...context.agent});
  return parseLiveAuthorSnapshot(authors);
}
