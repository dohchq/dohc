import type { BinaryLike } from "node:crypto";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { SyncRelayStorage } from "./storage";
import type { LinkLiveBrowserContext } from "./liveBrowserContext";
import { hashLinkBearer, hashLinkProfileSecret, validateLinkCapability } from "./linkSecurity";

/** Compose only behind the live route's trusted Host, Origin, and exchange-key check. */
export function createLinkLiveBrowserResolver(options: { storage: SyncRelayStorage; linkKey: BinaryLike }) {
  const { storage } = options;
  const supplied = options.linkKey;
  const linkKey = typeof supplied === "string" ? supplied : Buffer.from(new Uint8Array(supplied.buffer, supplied.byteOffset, supplied.byteLength));
  return {
    async resolve(request: Request, discriminator: string): Promise<LinkLiveBrowserContext | null> {
      if (request.signal.aborted || !/^[A-Za-z0-9_-]{12}$/.test(discriminator)) return null;
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const profile = request.headers.get("x-dohc-link-profile-secret");
      if (!bearer || !profile || !LINK_SECRET_PATTERN.test(profile)) return null;
      const current = validateLinkCapability({ storage, capabilityToken: bearer, linkKey, nowMs: Date.now() });
      if (!current || current.access !== "edit") return null;
      const share = storage.getShare(current.shareId);
      if (!share) return null;
      return { kind: "link", workspaceId: share.workspaceId, shareId: current.shareId, grantId: current.grantId,
        sessionId: current.session.sessionId, capabilityHash: hashLinkBearer(bearer, linkKey),
        profileTokenHash: hashLinkProfileSecret(profile, linkKey) };
    },
  };
}
