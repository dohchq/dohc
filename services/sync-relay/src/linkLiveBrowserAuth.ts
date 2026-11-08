import type { BinaryLike } from "node:crypto";
import type { PublicEditRelease } from "@dohc/security-contract";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { SyncRelayStorage } from "./storage";
import type { AgentLiveContext, LinkLiveBrowserContext } from "./liveBrowserContext";
import { isAgentRequest, type LinkAuthority, type LinkAuthorityResolver } from "./linkAuthority";
import { hashLinkBearer, hashLinkProfileSecret, validateLinkCapability } from "./linkSecurity";

/** Compose only behind the live route's trusted Host, Origin, and exchange-key check. */
export function createLinkLiveBrowserResolver(options: { storage: SyncRelayStorage; linkKey: BinaryLike; publicEditRelease: PublicEditRelease | undefined }) {
  const { storage } = options;
  const supplied = options.linkKey;
  const linkKey = typeof supplied === "string" ? supplied : Buffer.from(new Uint8Array(supplied.buffer, supplied.byteOffset, supplied.byteLength));
  return {
    async resolve(request: Request, discriminator: string, access: "read" | "edit" = "edit"): Promise<LinkLiveBrowserContext | null> {
      if (request.signal.aborted || !/^[A-Za-z0-9_-]{12}$/.test(discriminator)) return null;
      // The same scheme as every other link route, so a capability is never read as another credential.
      const bearer = /^LinkCapability ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const profile = request.headers.get("x-dohc-link-profile-secret");
      if (!bearer || !profile || !LINK_SECRET_PATTERN.test(profile)) return null;
      const current = validateLinkCapability({ storage, capabilityToken: bearer, linkKey, nowMs: Date.now(), publicEditRelease: options.publicEditRelease });
      if (!current || (access === "edit" && current.access !== "edit")) return null;
      const share = storage.getShare(current.shareId);
      if (!share) return null;
      return { kind: "link", workspaceId: share.workspaceId, shareId: current.shareId, grantId: current.grantId,
        sessionId: current.session.sessionId, capabilityHash: hashLinkBearer(bearer, linkKey),
        profileTokenHash: hashLinkProfileSecret(profile, linkKey) };
    },
  };
}

/**
 * A link holder's capability as above, or a connected agent's access token
 * through `linkAuthority`, the resolver the MCP tool loop's other link routes
 * use. Each later check of the session presents the agent's token again.
 */
export function createLinkLiveResolver(options: Parameters<typeof createLinkLiveBrowserResolver>[0] & {
  linkAuthority: Pick<LinkAuthorityResolver, "resolve">;
}) {
  const holder = createLinkLiveBrowserResolver(options);
  const { linkAuthority } = options;
  return {
    async resolve(request: Request, discriminator: string, access: "read" | "edit" = "edit"): Promise<LinkLiveBrowserContext | AgentLiveContext | null> {
      if (!isAgentRequest(request)) return holder.resolve(request, discriminator, access);
      if (request.signal.aborted || !/^[A-Za-z0-9_-]{12}$/.test(discriminator)) return null;
      let authority: LinkAuthority;
      try { authority = linkAuthority.resolve(request); } catch { return null; }
      const { credential } = authority;
      if (credential.kind !== "agent" || (access === "edit" && authority.access !== "edit")) return null;
      const { connection, check } = credential;
      return { kind: "link", workspaceId: connection.workspaceId, shareId: connection.shareId, grantId: connection.grantId,
        agentConnectionId: connection.connectionId, accessTokenHash: check.accessTokenHash, resourceHash: check.resourceHash };
    },
  };
}
