import { jsonResponse } from "@dohc/service-http";
import type {PublicEditRelease} from "@dohc/security-contract";
import { shareAccessRank } from "@dohc/security-contract/share-selector";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, RELAY_ERRORS, relayError } from "./errors";
import type { createLinkResponseStreams } from "./linkResponseStreams";
import { hashLinkBearer, isPublicLinkAccess } from "./linkSecurity";
import { parseShareId, parseString, parseWorkspaceId, readJsonObject } from "./requestInputs";
import { selectorTargetsBlockedChannel } from "./shareAuthorization";
import { parseStoredAnyShareSelectorJson, validateChatChannelShareSelector, validateChatShareAccess, validateFileShareAccess, validateGroupShareSelector, validateShareSelector } from "./shareFilter";
import type { createShareSummaries } from "./shareSummaries";
import type { SyncRelayShareGrantRow, SyncRelayShareWithGrantRow, SyncRelayStorage } from "./storage";
import { MAX_ORIGIN_ID_CHARS, MAX_SHARE_ID_CHARS } from "./wireLimits";

export type ShareGrantTransitionRoute =
  | { route: "share-link-rotate"; shareId: string; grantId: string }
  | { route: "share-link-retune"; shareId: string; grantId: string }
  | { route: "share-grant-promote"; shareId: string; grantId: string }
  | { route: "share-grant-revoke"; shareId: string; grantId: string }
  | { route: "share-revoke"; shareId: string };

export type WorkspaceShareCreationRoute =
  | { route: "shares-create"; workspaceId: string }
  | { route: "share-link-create-atomic"; workspaceId: string }
  | { route: "share-link-create"; workspaceId: string; shareId: string };

function composePublicLinkUrl(shareWebOrigin: string, secret: string): string {
  return `${shareWebOrigin}/s/#${secret}`;
}

function validatePublicLinkAccess(value: unknown, release?: PublicEditRelease): "view" | "comment" | "edit" {
  const validation = validateFileShareAccess(value);
  if (!validation.ok) {
    throw relayError(validation.code, validation.message);
  }
  if (!isPublicLinkAccess(validation.access, release)) {
    throw relayError("invalid_access", release ? 'access must be "view", "comment", or "edit"' : 'access must be "view" or "comment"');
  }
  return validation.access;
}

const MAX_EMAIL_CHARS = 320;

export function createShareGrantRoutes(
  storage: Pick<SyncRelayStorage,
    | "getShare"
    | "getShareGrant"
    | "workspaceIsOwnedBy"
    | "rotateLinkGrant"
    | "retuneShareGrant"
    | "promoteShareGrant"
    | "revokeShareGrant"
    | "revokeShare"
    | "createFileLinkShare"
    | "createLinkGrant"
    | "createShare"
    | "findChannelCreateKind"
    | "findChannelCreateFolderPath"
  >,
  nowMs: () => number,
  newShareId: () => string,
  newGrantId: () => string,
  newId: () => string,
  newLinkBearer: () => string,
  resolveUserIdByEmail: ((email: string) => Promise<string | null> | string | null) | undefined,
  lookupUserEmail: ((userId: string) => Promise<string | null> | string | null) | undefined,
  linkKey: string | Uint8Array | undefined,
  shareWebOrigin: string | undefined,
  requireShareWorkspace: (share: { workspaceId: string }, workspaceId: string) => void,
  terminateLinkStreamsForGrant: ReturnType<typeof createLinkResponseStreams>["terminateLinkStreamsForGrant"],
  terminateLinkStreamsForShare: ReturnType<typeof createLinkResponseStreams>["terminateLinkStreamsForShare"],
  discussionActivity: Pick<DiscussionActivityHub, "wake" | "wakeLog">,
  linkGrantBody: ReturnType<typeof createShareSummaries>["linkGrantBody"],
  namedGrantTransitionBody: ReturnType<typeof createShareSummaries>["namedGrantTransitionBody"],
  dependentGrantSummary: ReturnType<typeof createShareSummaries>["dependentGrantSummary"],
  namedBrowserInvitation: ReturnType<typeof createShareSummaries>["namedBrowserInvitation"],
  publicEditRelease?: PublicEditRelease,
) {
  const requireEditableSelector = (access: string, selectorJson: string) => {
    const selector = parseStoredAnyShareSelectorJson(selectorJson);
    if (access === "edit" && (!selector || "kind" in selector || selector.versionId !== null)) {
      throw relayError("invalid_access", "Edit links require files on the main version.");
    }
  };
  // The share and an active grant of `kind` on it, when the actor owns both
  // the share and its workspace right now. Anything else is a generic 404.
  // Lifecycle steps must reach any active grant, including one that is no
  // longer current, so this is not the current-grant rule.
  function requireOwnedGrant(
    kind: "link" | "user",
    shareId: string,
    grantId: string,
    actor: { userId: string },
  ): SyncRelayShareWithGrantRow {
    const share = storage.getShare(shareId);
    const grant = storage.getShareGrant(grantId);
    if (
      !share ||
      share.granterUserId !== actor.userId ||
      !storage.workspaceIsOwnedBy(share.workspaceId, actor.userId) ||
      !grant ||
      grant.shareId !== share.shareId ||
      grant.principalKind !== kind ||
      (kind === "user" && !grant.principalUserId) ||
      grant.status !== "active" ||
      grant.revokedAtMs !== null
    ) {
      throw notFound();
    }
    return { share, grant };
  }

  const dependentSetConflict = async (
    dependents: SyncRelayShareGrantRow[],
    workspaceId: string,
    actorUserId: string,
  ): Promise<Response> => {
    const projected = await Promise.all(dependents.map(dependentGrantSummary));
    if (!storage.workspaceIsOwnedBy(workspaceId, actorUserId)) throw notFound();
    return jsonResponse(
      {
        ok: false,
        error: "active dependent grants changed",
        code: RELAY_ERRORS.dependents_changed.code,
        dependents: projected,
      },
      RELAY_ERRORS.dependents_changed.status,
    );
  };

  async function respondToShareGrantTransition(
    request: Request,
    route: ShareGrantTransitionRoute,
    actor: { userId: string },
  ): Promise<Response> {
    if (route.route === "share-link-rotate" && request.method === "POST") {
      const input = await readJsonObject(request);
      const workspaceId = parseWorkspaceId(input.workspaceId);
      const { share, grant } = requireOwnedGrant(
        "link",
        route.shareId,
        route.grantId,
        actor,
      );
      requireShareWorkspace(share, workspaceId);
      validatePublicLinkAccess(grant.access, publicEditRelease);
      requireEditableSelector(grant.access, share.selectorJson);
      const expectedDependentGrantIds = parseExpectedDependentGrantIds(input, [
        "workspaceId",
        "expectedDependentGrantIds",
      ]);
      let secret: string | null = null;
      const result = storage.rotateLinkGrant({
        shareId: share.shareId,
        grantId: grant.grantId,
        rotatedAtMs: nowMs(),
        expectedDependentGrantIds,
        guard: () => {
          const current = requireOwnedGrant(
            "link",
            share.shareId,
            grant.grantId,
            actor,
          );
          requireShareWorkspace(current.share, workspaceId);
          validatePublicLinkAccess(current.grant.access, publicEditRelease);
          requireEditableSelector(current.grant.access, current.share.selectorJson);
        },
        mintCredential: () => {
          secret = newLinkBearer();
          return {
            credentialId: newId(),
            secretHash: hashLinkBearer(secret, linkKey!),
          };
        },
      });
      if (!result.ok) {
        if ("reason" in result && result.reason === "dependents-changed") {
          return dependentSetConflict(result.dependents, share.workspaceId, actor.userId);
        }
        throw notFound();
      }
      if (!secret) throw notFound();
      terminateLinkStreamsForGrant(result.grant.grantId);
      discussionActivity.wake(share.shareId);
      discussionActivity.wakeLog(share.workspaceId);
      return jsonResponse({
        ok: true,
        ...linkGrantBody(result.grant),
        url: composePublicLinkUrl(shareWebOrigin!, secret),
      });
    }
    if (route.route === "share-link-rotate") throw relayError("method_not_allowed");

    if (route.route === "share-link-retune" && request.method === "POST") {
      const input = await readJsonObject(request);
      const workspaceId = parseWorkspaceId(input.workspaceId);
      const { share, grant } = requireOwnedGrant(
        "link",
        route.shareId,
        route.grantId,
        actor,
      );
      requireShareWorkspace(share, workspaceId);
      if (!["view", "comment", "edit"].includes(grant.access)) throw notFound();
      const expectedDependentGrantIds = parseExpectedDependentGrantIds(input, [
        "workspaceId",
        "access",
        "expectedDependentGrantIds",
      ]);
      const access = validatePublicLinkAccess(input.access, publicEditRelease);
      requireEditableSelector(access, share.selectorJson);
      const widening = shareAccessRank(access) > shareAccessRank(grant.access);
      if (widening && (!linkKey || !shareWebOrigin)) throw notFound();
      let secret: string | null = null;
      const result = storage.retuneShareGrant({
        shareId: share.shareId,
        grantId: grant.grantId,
        access,
        changedAtMs: nowMs(),
        expectedDependentGrantIds,
        guard: () => {
          const current = requireOwnedGrant(
            "link",
            share.shareId,
            grant.grantId,
            actor,
          );
          requireShareWorkspace(current.share, workspaceId);
        },
        ...(widening
          ? {
              mintCredential: () => {
                secret = newLinkBearer();
                return {
                  credentialId: newId(),
                  secretHash: hashLinkBearer(secret, linkKey!),
                };
              },
            }
          : {}),
      });
      if (!result.ok) {
        if ("reason" in result && result.reason === "dependents-changed") {
          return dependentSetConflict(result.dependents, share.workspaceId, actor.userId);
        }
        throw notFound();
      }
      if (widening) terminateLinkStreamsForGrant(result.grant.grantId);
      discussionActivity.wake(share.shareId);
      discussionActivity.wakeLog(share.workspaceId);
      return jsonResponse({
        ok: true,
        ...linkGrantBody(result.grant),
        ...(secret === null
          ? {}
          : { url: composePublicLinkUrl(shareWebOrigin!, secret) }),
      });
    }
    if (route.route === "share-link-retune") throw relayError("method_not_allowed");

    if (route.route === "share-grant-promote" && request.method === "POST") {
      const input = await readJsonObject(request);
      const workspaceId = parseWorkspaceId(input.workspaceId);
      const { share } = requireOwnedGrant(
        "user",
        route.shareId,
        route.grantId,
        actor,
      );
      requireShareWorkspace(share, workspaceId);
      const { expectedParentGrantId, expectedParentGeneration } =
        parsePromotionExpectation(input);
      const result = storage.promoteShareGrant({
        shareId: route.shareId,
        grantId: route.grantId,
        expectedParentGrantId,
        expectedParentGeneration,
        guard: () => {
          const current = requireOwnedGrant(
            "user",
            route.shareId,
            route.grantId,
            actor,
          );
          requireShareWorkspace(current.share, workspaceId);
        },
      });
      if (!result.ok) throw notFound();
      discussionActivity.wake(route.shareId);
      discussionActivity.wakeLog(share.workspaceId);
      return jsonResponse({
        ok: true,
        ...namedGrantTransitionBody(result.grant),
      });
    }
    if (route.route === "share-grant-promote") throw relayError("method_not_allowed");

    if (route.route === "share-grant-revoke" && request.method === "POST") {
      const input = await readJsonObject(request);
      const workspaceId = parseWorkspaceId(input.workspaceId);
      if (Object.keys(input).some((key) => key !== "workspaceId")) {
        throw badRequest("request body contains an unknown field");
      }
      const { share } = requireOwnedGrant(
        "user",
        route.shareId,
        route.grantId,
        actor,
      );
      requireShareWorkspace(share, workspaceId);
      const result = storage.revokeShareGrant({
        shareId: route.shareId,
        grantId: route.grantId,
        revokedAtMs: nowMs(),
        guard: () => {
          const current = requireOwnedGrant(
            "user",
            route.shareId,
            route.grantId,
            actor,
          );
          requireShareWorkspace(current.share, workspaceId);
        },
      });
      if (!result.ok) throw notFound();
      discussionActivity.wake(route.shareId);
      discussionActivity.wakeLog(share.workspaceId);
      return jsonResponse({
        ok: true,
        ...namedGrantTransitionBody(result.grant),
      });
    }
    if (route.route === "share-grant-revoke") throw relayError("method_not_allowed");

    if (route.route === "share-revoke" && request.method === "POST") {
      const share = storage.getShare(route.shareId);
      // Only the granter may revoke; anyone else (including the recipient)
      // sees the byte-identical generic 404.
      if (!share || share.granterUserId !== actor.userId) {
        throw notFound();
      }
      if (!storage.workspaceIsOwnedBy(share.workspaceId, actor.userId)) throw notFound();
      const input = await readOptionalJsonObject(request);
      if (input !== null) {
        const grantId = parseShareId(
          typeof input.grantId === "string" ? input.grantId : undefined,
        );
        const workspaceId = parseWorkspaceId(input.workspaceId);
        requireShareWorkspace(share, workspaceId);
        const grant = storage.getShareGrant(grantId);
        if (
          !grant ||
          grant.shareId !== share.shareId ||
          grant.principalKind !== "link"
        ) {
          throw notFound();
        }
        const expectedDependentGrantIds = parseExpectedDependentGrantIds(input, [
          "grantId",
          "workspaceId",
          "expectedDependentGrantIds",
        ]);
        const result = storage.revokeShareGrant({
          shareId: share.shareId,
          grantId,
          revokedAtMs: nowMs(),
          expectedDependentGrantIds,
        });
        if (!result.ok) {
          if ("reason" in result && result.reason === "dependents-changed") {
            return dependentSetConflict(result.dependents, share.workspaceId, actor.userId);
          }
          throw notFound();
        }
        terminateLinkStreamsForGrant(result.grant.grantId);
        discussionActivity.wake(share.shareId);
        discussionActivity.wakeLog(share.workspaceId);
        return jsonResponse({ ok: true, ...linkGrantBody(result.grant) });
      }
      if (storage.revokeShare(route.shareId, nowMs())) {
        terminateLinkStreamsForShare(route.shareId);
        discussionActivity.wake(route.shareId);
        discussionActivity.wakeLog(share.workspaceId);
      }
      return jsonResponse({ ok: true, shareId: route.shareId });
    }
    throw relayError("method_not_allowed");
  }

  async function respondToWorkspaceShareCreation(
    request: Request,
    route: WorkspaceShareCreationRoute,
    actor: { userId: string },
  ): Promise<Response> {
    if (route.route === "share-link-create-atomic" && request.method === "POST") {
      const input = await readJsonObject(request);
      if (
        Object.keys(input).some(
          (key) => key !== "paths" && key !== "versionId" && key !== "access",
        )
      ) {
        throw badRequest("A link accepts only access, paths, and versionId.");
      }
      const access = validatePublicLinkAccess(input.access, publicEditRelease);
      const validation = validateShareSelector({
        paths: input.paths,
        versionId: input.versionId,
      });
      if (!validation.ok) {
        throw relayError(validation.code, validation.message);
      }
      const selector = validation.selector;
      requireEditableSelector(access, JSON.stringify(selector));
      const shareId = newShareId();
      const grantId = newGrantId();
      const createdAtMs = nowMs();
      const secret = newLinkBearer();
      const share = {
        shareId,
        workspaceId: route.workspaceId,
        granterUserId: actor.userId,
        selectorJson: JSON.stringify(selector),
        createdAtMs,
      };
      const grant = {
        grantId,
        shareId,
        principalKind: "link" as const,
        principalUserId: null,
        principalEmail: null,
        access,
        generation: 1,
        status: "active" as const,
        createdAtMs,
        revokedAtMs: null,
        parentGrantId: null,
      };
      const created = storage.createFileLinkShare({
        share,
        grant,
        credential: {
          credentialId: newId(),
          grantId,
          secretHash: hashLinkBearer(secret, linkKey!),
          generation: 1,
          mintedAtMs: createdAtMs,
          retiredAtMs: null,
        },
        guard: () => {
          if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();
        },
      });
      if (!created) throw notFound();
      return jsonResponse({
        ok: true,
        workspaceId: route.workspaceId,
        selector,
        ...linkGrantBody(grant),
        url: composePublicLinkUrl(shareWebOrigin!, secret),
      });
    }
    if (route.route === "share-link-create-atomic") throw relayError("method_not_allowed");

    if (route.route === "share-link-create" && request.method === "POST") {
      const input = await readJsonObject(request);
      if (Object.keys(input).some((key) => key !== "access")) {
        throw badRequest("A link accepts only access.");
      }
      const access = validatePublicLinkAccess(input.access, publicEditRelease);
      const share = storage.getShare(route.shareId);
      const selector = share
        ? parseStoredAnyShareSelectorJson(share.selectorJson)
        : null;
      if (
        !share ||
        share.workspaceId !== route.workspaceId ||
        share.granterUserId !== actor.userId ||
        !storage.workspaceIsOwnedBy(share.workspaceId, actor.userId) ||
        !selector ||
        "kind" in selector
      ) {
        throw notFound();
      }
      requireEditableSelector(access, share.selectorJson);
      const secret = newLinkBearer();
      const grantId = newGrantId();
      const createdAtMs = nowMs();
      const grant = {
        grantId,
        shareId: share.shareId,
        principalKind: "link" as const,
        principalUserId: null,
        principalEmail: null,
        access,
        generation: 1,
        status: "active" as const,
        createdAtMs,
        revokedAtMs: null,
        parentGrantId: null,
      };
      const created = storage.createLinkGrant({
        grant,
        credential: {
          credentialId: newId(),
          grantId,
          secretHash: hashLinkBearer(secret, linkKey!),
          generation: 1,
          mintedAtMs: createdAtMs,
          retiredAtMs: null,
        },
      });
      if (!created) throw notFound();
      return jsonResponse({
        ok: true,
        ...linkGrantBody(grant),
        url: composePublicLinkUrl(shareWebOrigin!, secret),
      });
    }
    if (route.route === "share-link-create") throw relayError("method_not_allowed");

    if (route.route === "shares-create" && request.method === "POST") {
      const input = await readJsonObject(request);
      // Two grant kinds share one create surface: a chat grant
      // (MU-C4, addressed by channelWireId + optional access) or the PR-18
      // path/version grant. The recipient addressing, pending-invite, and
      // anti-enumeration behavior below is identical for both.
      const { selector, access } = (() => {
        if (input.channelWireId !== undefined && input.paths !== undefined) {
          // One share for a group: the channel and its folder together.
          if (input.versionId !== undefined && input.versionId !== null) {
            throw relayError("ambiguous_selector", "a group share follows the live folder, never a version");
          }
          const groupValidation = validateGroupShareSelector(
            { channelWireId: input.channelWireId, paths: input.paths },
            {
              channelKind: (wireId) => storage.findChannelCreateKind(route.workspaceId, wireId),
              channelFolderPath: (wireId) => storage.findChannelCreateFolderPath(route.workspaceId, wireId),
            },
          );
          if (!groupValidation.ok) {
            throw relayError(groupValidation.code, groupValidation.message);
          }
          const accessValidation = validateChatShareAccess(input.access);
          if (!accessValidation.ok) {
            throw relayError(accessValidation.code, accessValidation.message);
          }
          const selector = groupValidation.selector;
          if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
            throw relayError("invalid_chat", "chat is not shareable");
          }
          return { selector, access: accessValidation.access };
        }
        if (input.channelWireId !== undefined) {
          // Fail closed on an ambiguous body: a chat selector must not
          // also carry a version selector. (A channel with paths is a group
          // share, handled above.)
          if (input.versionId !== undefined) {
            throw relayError("ambiguous_selector", "a chat share must not also carry versionId");
          }
          const chatValidation = validateChatChannelShareSelector({
            channelWireId: input.channelWireId,
          });
          if (!chatValidation.ok) {
            throw relayError(chatValidation.code, chatValidation.message);
          }
          const accessValidation = validateChatShareAccess(input.access);
          if (!accessValidation.ok) {
            throw relayError(accessValidation.code, accessValidation.message);
          }
          const selector = chatValidation.selector;
          if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
            throw relayError("invalid_chat", "chat is not shareable");
          }
          return { selector, access: accessValidation.access };
        }

        const accessValidation = validateFileShareAccess(input.access);
        if (!accessValidation.ok) {
          throw relayError(accessValidation.code, accessValidation.message);
        }
        const validation = validateShareSelector({
          paths: input.paths,
          versionId: input.versionId,
        });
        if (!validation.ok) {
          throw relayError(validation.code, validation.message);
        }
        const selector = validation.selector;
        return { selector, access: accessValidation.access };
      })();
      const shareId = newShareId();
      const grantId = newGrantId();
      const createdAtMs = nowMs();

      // Sharing by explicit user id: the granter already knows the id, so
      // there is no account existence to leak — echo it back.
      if (input.recipientUserId !== undefined) {
        const recipientUserId = parseString(
          input.recipientUserId,
          "recipientUserId",
          MAX_ORIGIN_ID_CHARS,
        );
        if (recipientUserId === actor.userId) throw relayError("self_share");
        if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
          throw relayError("invalid_chat", "chat is not shareable");
        }
        storage.createShare({
          share: {
            shareId,
            workspaceId: route.workspaceId,
            granterUserId: actor.userId,
            selectorJson: JSON.stringify(selector),
            createdAtMs,
          },
          grant: {
            grantId,
            shareId,
            principalKind: "user",
            principalUserId: recipientUserId,
            principalEmail: null,
            access,
            generation: 1,
            status: "active",
            createdAtMs,
            revokedAtMs: null,
            parentGrantId: null,
          },
        });
        return jsonResponse({
          ok: true,
          shareId,
          workspaceId: route.workspaceId,
          recipientUserId,
          selector,
          access,
          grantId,
          ...namedBrowserInvitation(grantId, selector, access),
          generation: 1,
          createdAtMs,
        });
      }

      // Sharing by email. To close the account-enumeration oracle, the
      // response is identical whether or not the email has a dohc account:
      // a verified account becomes an immediate recipient. Other addresses
      // become pending invites, claimed on a relay request after verification.
      // Either way the response never echoes a recipient user
      // id, so the granter cannot distinguish "has an account" from "does
      // not" by inspecting the reply.
      const email = parseString(input.recipientEmail, "recipientEmail", MAX_EMAIL_CHARS);
      if (!resolveUserIdByEmail) {
        throw badRequest("recipient email lookup is not available on this relay");
      }
      const granterEmail = await lookupUserEmail?.(actor.userId);
      if (granterEmail?.trim().toLowerCase() === email.trim().toLowerCase()) throw relayError("self_share");
      const resolved = await resolveUserIdByEmail(email);
      if (resolved === actor.userId) throw relayError("self_share");
      // Re-check after the asynchronous account lookup: a pre-provisioned
      // wire may have become an agent channel while this request was waiting.
      if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
        throw relayError("invalid_chat", "chat is not shareable");
      }
      storage.createShare({
        share: {
          shareId,
          workspaceId: route.workspaceId,
          granterUserId: actor.userId,
          selectorJson: JSON.stringify(selector),
          createdAtMs,
        },
        grant: {
          grantId,
          shareId,
          principalKind: resolved ? "user" : "email",
          principalUserId: resolved ?? null,
          principalEmail: resolved ? null : email.trim().toLowerCase(),
          access,
          generation: 1,
          status: "active",
          createdAtMs,
          revokedAtMs: null,
          parentGrantId: null,
        },
      });
      return jsonResponse({
        ok: true,
        shareId,
        workspaceId: route.workspaceId,
        selector,
        access,
        grantId,
        ...namedBrowserInvitation(grantId, selector, access),
        generation: 1,
        createdAtMs,
      });
    }
    throw relayError("method_not_allowed");
  }

  return { respondToShareGrantTransition, respondToWorkspaceShareCreation };
}

function parseExpectedDependentGrantIds(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
): string[] {
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw badRequest("request body contains an unknown field");
  }
  const value = input.expectedDependentGrantIds;
  if (!Array.isArray(value)) {
    throw badRequest("expectedDependentGrantIds must be an array of grant ids");
  }
  const normalized = new Set<string>();
  for (const grantId of value) {
    if (
      typeof grantId !== "string" ||
      grantId.length === 0 ||
      grantId.length > MAX_SHARE_ID_CHARS ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(grantId)
    ) {
      throw badRequest("expectedDependentGrantIds must be an array of grant ids");
    }
    normalized.add(grantId);
  }
  return [...normalized];
}

function parsePromotionExpectation(input: Record<string, unknown>): {
  expectedParentGrantId: string;
  expectedParentGeneration: number;
} {
  const allowedKeys = [
    "workspaceId",
    "expectedParentGrantId",
    "expectedParentGeneration",
  ];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw badRequest("request body contains an unknown field");
  }
  const expectedParentGrantId = parseShareId(
    typeof input.expectedParentGrantId === "string"
      ? input.expectedParentGrantId
      : undefined,
  );
  if (
    !Number.isSafeInteger(input.expectedParentGeneration) ||
    Number(input.expectedParentGeneration) < 1
  ) {
    throw badRequest("expectedParentGeneration must be a positive integer");
  }
  return {
    expectedParentGrantId,
    expectedParentGeneration: Number(input.expectedParentGeneration),
  };
}

async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}
