import { jsonResponse, readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import type { LinkExchangeResult, PublicEditRelease } from "@dohc/security-contract";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import {
  errorResponse,
  invalidLinkCapability,
  notFound,
  RELAY_ERRORS,
  relayError,
  RelayError,
} from "./errors";
import {
  constantTimeHashEqual,
  hashLinkBearer,
  hashLinkHandoffCode,
  isPublicLinkAccess,
  LINK_HANDOFF_CODE_TTL_MS,
  LINK_SESSION_RENEWAL_GRACE_MS,
  LINK_SESSION_TTL_MS,
  validateLinkCapability,
  type ValidatedLinkCapability,
} from "./linkSecurity";
import { readJsonObject } from "./requestInputs";
import {
  authorizeLinkShareAction,
  type AuthorizedShareAction,
} from "./shareAuthorization";
import {isLiveEditShareSelector, type ShareSelector} from "./shareFilter";
import type { SyncRelayStorage } from "./storage";

export function createLinkCredentialRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "findLinkGrantByCredentialHash"
    | "findLinkSessionByCapabilityHash"
    | "mintLinkSession"
    | "replaceLinkSession"
    | "mintLinkHandoffCode"
    | "hasLinkHandoffCode"
    | "redeemLinkHandoffCode"
    | "getShare"
    | "getShareGrant"
    | "workspaceIsOwnedBy"
    | "findChannelCreateKind"
  >,
  linkKey: string | Uint8Array | undefined,
  relayExchangeKeyConfigured: boolean,
  hasValidRelayExchangeKey: (request: Request) => boolean,
  requireLinkRead: (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => { capabilityToken: string; capability: ValidatedLinkCapability },
  nowMs: () => number,
  newId: () => string,
  newGrantId: () => string,
  newLinkBearer: () => string,
  newLinkHandoffCode: () => string,
  linkExchangeRateLimiter: TokenBucketLimiter,
  linkExchangeGlobalRateLimiter: TokenBucketLimiter,
  linkExchangeGrantRateLimiter: TokenBucketLimiter,
  linkRedeemRateLimiter: TokenBucketLimiter,
  linkReadRateLimiter: TokenBucketLimiter,
  linkGrantReadRateLimiter: TokenBucketLimiter,
  publicEditRelease?: PublicEditRelease,
) {
  const requireRefreshableLinkSession = (request: Request, refreshedAtMs: number) => {
    if (!linkKey) throw invalidLinkCapability();
    const match = /^LinkCapability ([A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match) throw invalidLinkCapability();
    const capabilityToken = match[1]!;
    const capabilityHash = hashLinkBearer(capabilityToken, linkKey);
    const session = storage.findLinkSessionByCapabilityHash(capabilityHash);
    if (
      !session ||
      !constantTimeHashEqual(capabilityHash, session.capabilityHash) ||
      session.expiresAtMs + LINK_SESSION_RENEWAL_GRACE_MS < refreshedAtMs
    ) {
      throw invalidLinkCapability();
    }
    return { capabilityHash, session };
  };

  const linkExchangeResult = (
    authorized: AuthorizedShareAction<ShareSelector>,
    capabilityToken: string,
    capabilityExpiresAtMs: number,
  ): LinkExchangeResult => {
    const presentation = createAccountlessPathProjection(
      authorized.effectiveSelector,
    );
    return {
      shareId: authorized.share.shareId,
      grantId: authorized.grant.grantId,
      generation: authorized.grant.generation,
      access: authorized.effectiveSelector.access,
      effectiveSelector: presentation.selector,
      capabilityToken,
      capabilityExpiresAtMs,
    };
  };

  let exchangesInFlight = 0;
  const respondToLinkExchange = async (request: Request): Promise<Response> => {
    if (!linkKey) return refused();
    if (!hasValidRelayExchangeKey(request)) return refused();
    const ip = request.headers.get("x-dohc-relay-client-ip") ?? "unknown";
    if (exchangesInFlight >= 64 || !linkExchangeGlobalRateLimiter.allow("global", nowMs())) throw relayError("link_read_rate_limited");
    exchangesInFlight++;
    try {

      let secret = "";
      let wellFormed = false;
      try {
        const input = await readBoundedJson(request, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
        if (input && typeof input === "object" && !Array.isArray(input) && "secret" in input && typeof input.secret === "string") {
          secret = input.secret;
          wellFormed = LINK_SECRET_PATTERN.test(secret);
        }
      } catch {
        // The exchange never distinguishes malformed JSON from a bad bearer.
      }

      try {
        // Hash before deciding whether the input was well formed. The lookup and
        // comparison also run for garbage, against a digest that cannot match.
        const secretHash = hashLinkBearer(secret, linkKey);
        const dummyHash = hashLinkBearer("", linkKey);
        const found = storage.findLinkGrantByCredentialHash(secretHash);
        const hashMatches = constantTimeHashEqual(
          secretHash,
          found?.credential.secretHash ?? dummyHash,
        );
        if (!wellFormed || !found || !hashMatches) {
          if (!linkExchangeRateLimiter.allow(ip, nowMs())) throw relayError("link_read_rate_limited");
          return refused();
        }

        const authorized = authorizeLinkShareAction({
          storage,
          grantId: found.grant.grantId,
          action: "read",
        });
        if (
          !authorized.ok ||
          authorized.grant.generation !== found.credential.generation ||
          (!isPublicLinkAccess(authorized.grant.access, publicEditRelease) || (authorized.grant.access === "edit" && !isLiveEditShareSelector(authorized.effectiveSelector)))
        ) {
          if (!linkExchangeRateLimiter.allow(ip, nowMs())) throw relayError("link_read_rate_limited");
          return refused();
        }
        if (!linkExchangeGrantRateLimiter.allow(found.grant.grantId, nowMs())) throw relayError("link_read_rate_limited");

        const capabilityToken = newLinkBearer();
        const mintedAtMs = nowMs();
        const capabilityExpiresAtMs = mintedAtMs + LINK_SESSION_TTL_MS;
        const minted = storage.mintLinkSession({
          session: {
            sessionId: newId(),
            capabilityHash: hashLinkBearer(capabilityToken, linkKey),
            grantId: authorized.grant.grantId,
            generation: authorized.grant.generation,
            mintedAtMs,
            expiresAtMs: capabilityExpiresAtMs,
          },
          // This is the commit-time check. Rotation, retuning, revocation, owner
          // loss, or selector damage that lands after the first lookup wins.
          guard: () => {
            const current = storage.findLinkGrantByCredentialHash(secretHash);
            const currentMatches = constantTimeHashEqual(
              secretHash,
              current?.credential.secretHash ?? dummyHash,
            );
            if (
              !current ||
              !currentMatches ||
              current.credential.credentialId !== found.credential.credentialId
            ) {
              throw notFound();
            }
            const fresh = authorizeLinkShareAction({
              storage,
              grantId: current.grant.grantId,
              action: "read",
            });
            if (
              !fresh.ok ||
              fresh.grant.generation !== found.grant.generation ||
              fresh.grant.generation !== current.credential.generation ||
              fresh.grant.access !== authorized.grant.access
            ) {
              throw notFound();
            }
          },
        });
        if (!minted) return refused();

        const exchange = linkExchangeResult(
          authorized,
          capabilityToken,
          capabilityExpiresAtMs,
        );
        return jsonResponse({ ok: true, ...exchange });
      } catch (error) {
        if (error instanceof RelayError && error.code !== RELAY_ERRORS.link_read_rate_limited.code) return refused();
        throw error;
      }
    } finally {exchangesInFlight--;}
  };

  const respondToLinkRefresh = (request: Request): Response => {
    if (!hasValidRelayExchangeKey(request)) {
      return errorResponse(notFound());
    }
    if (!linkKey) throw invalidLinkCapability();
    const refreshLinkKey = linkKey;
    const refreshedAtMs = nowMs();
    const current = requireRefreshableLinkSession(request, refreshedAtMs);
    if (
      !linkReadRateLimiter.allow(current.capabilityHash, refreshedAtMs) ||
      !linkGrantReadRateLimiter.allow(current.session.grantId, refreshedAtMs)
    ) {
      throw relayError("link_read_rate_limited");
    }
    const authorized = authorizeLinkShareAction({
      storage,
      grantId: current.session.grantId,
      action: "read",
    });
    if (
      !authorized.ok ||
      authorized.grant.generation !== current.session.generation ||
      (!isPublicLinkAccess(authorized.grant.access, publicEditRelease) || (authorized.grant.access === "edit" && !isLiveEditShareSelector(authorized.effectiveSelector)))
    ) {
      throw invalidLinkCapability();
    }

    const capabilityToken = newLinkBearer();
    const capabilityExpiresAtMs = refreshedAtMs + LINK_SESSION_TTL_MS;
    const replaced = storage.replaceLinkSession({
      currentSession: current.session,
      session: {
        sessionId: current.session.sessionId,
        capabilityHash: hashLinkBearer(capabilityToken, refreshLinkKey),
        grantId: authorized.grant.grantId,
        generation: authorized.grant.generation,
        mintedAtMs: refreshedAtMs,
        expiresAtMs: capabilityExpiresAtMs,
      },
      guard: () => {
        const fresh = authorizeLinkShareAction({
          storage,
          grantId: current.session.grantId,
          action: "read",
        });
        if (
          !fresh.ok ||
          fresh.share.shareId !== authorized.share.shareId ||
          fresh.grant.grantId !== authorized.grant.grantId ||
          fresh.grant.generation !== authorized.grant.generation ||
          fresh.grant.access !== authorized.grant.access
        ) {
          throw invalidLinkCapability();
        }
      },
    });
    if (!replaced) throw invalidLinkCapability();

    const refresh = linkExchangeResult(
      authorized,
      capabilityToken,
      capabilityExpiresAtMs,
    );
    return jsonResponse({ ok: true, ...refresh });
  };

  const respondToLinkHandoff = (request: Request): Response => {
    if (!linkKey || !relayExchangeKeyConfigured) return refused();
    if (!hasValidRelayExchangeKey(request)) return refused();
    if (request.body !== null) return refused();
    try {
      const { capabilityToken, capability } = requireLinkRead(
        request,
        linkReadRateLimiter,
        linkGrantReadRateLimiter,
      );
      const code = newLinkHandoffCode();
      if (!LINK_SECRET_PATTERN.test(code)) return refused();
      const mintedAtMs = nowMs();
      const expiresAtMs = mintedAtMs + LINK_HANDOFF_CODE_TTL_MS;
      const minted = storage.mintLinkHandoffCode({
        code: {
          codeId: newId(),
          codeHash: hashLinkHandoffCode(code, linkKey),
          grantId: capability.grantId,
          generation: capability.generation,
          mintedAtMs,
          expiresAtMs,
        },
        guard: () => {
          try {
            const fresh = validateLinkCapability({
              storage,
              capabilityToken,
              linkKey,
              nowMs: nowMs(),
            });
            return (
              fresh !== null &&
              fresh.shareId === capability.shareId &&
              fresh.grantId === capability.grantId &&
              fresh.generation === capability.generation &&
              fresh.access === capability.access &&
              isPublicLinkAccess(fresh.access, publicEditRelease) &&
              (fresh.access !== "edit" || isLiveEditShareSelector(fresh.effectiveSelector))
            );
          } catch {
            return false;
          }
        },
      });
      if (!minted) return refused();
      return jsonResponse({ ok: true, code, expiresAtMs });
    } catch (error) {
      if (
        error instanceof RelayError &&
        error.code !== RELAY_ERRORS.link_read_rate_limited.code
      ) {
        return refused();
      }
      throw error;
    }
  };

  const respondToLinkRedeem = async (
    request: Request,
    principalUserId: string,
  ): Promise<Response> => {
    if (!linkKey) return refused();
    let code = "";
    try {
      const input = await readJsonObject(request);
      if (
        Object.keys(input).length !== 1 ||
        typeof input.code !== "string" ||
        !LINK_SECRET_PATTERN.test(input.code)
      ) {
        return refused();
      }
      code = input.code;
    } catch {
      return refused();
    }

    const admittedAtMs = nowMs();
    if (!linkRedeemRateLimiter.allow(principalUserId, admittedAtMs)) {
      throw relayError("link_read_rate_limited");
    }
    const codeHash = hashLinkHandoffCode(code, linkKey);
    if (!storage.hasLinkHandoffCode(codeHash)) return refused();

    const result = storage.redeemLinkHandoffCode({
      codeHash,
      principalUserId,
      redeemedAtMs: admittedAtMs,
      mintGrantId: newGrantId,
      guard: (storedCode) => {
        try {
          const authorized = authorizeLinkShareAction({
            storage,
            grantId: storedCode.grantId,
            action: "read",
          });
          return (
            authorized.ok &&
            authorized.grant.grantId === storedCode.grantId &&
            authorized.grant.generation === storedCode.generation &&
            isPublicLinkAccess(authorized.grant.access, publicEditRelease) &&
            (authorized.grant.access !== "edit" || isLiveEditShareSelector(authorized.effectiveSelector))
          );
        } catch {
          return false;
        }
      },
    });
    if (!result.ok || !isPublicLinkAccess(result.grant.access, publicEditRelease)) return refused();
    return jsonResponse({
      ok: true,
      shareId: result.shareId,
      grantId: result.grant.grantId,
      access: result.grant.access,
    });
  };

  return {
    respondToLinkExchange,
    respondToLinkRefresh,
    respondToLinkHandoff,
    respondToLinkRedeem,
  };
}

// The public refusal: every route answers an unauthorized probe with the same bytes.
function refused(): Response {
  return errorResponse(notFound());
}
