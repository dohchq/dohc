import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import {
  MAX_WORKSPACE_SECRETS,
  WorkspaceSecretName,
  WorkspaceSecretWriteInput,
} from "@dohc/workspace-contracts/workspace-secrets";
import { badRequest, notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { SyncRelayQuotaExceededError } from "./storage/errors";
import { sealWorkspaceSecret, WORKSPACE_SECRET_KEY_ID } from "./workspaceSecretCrypto";

export const WORKSPACE_SECRET_MAX_BODY_BYTES = 16 * 1024;
export const WORKSPACE_SECRET_BUCKET_CAPACITY = 20;
export const WORKSPACE_SECRET_REFILL_PER_SECOND = 0.5;
export const WORKSPACE_SECRET_MAX_OWNERS = 10_000;

export type WorkspaceSecretRoute =
  | { readonly route: "workspace-secrets"; readonly workspaceId: string }
  | { readonly route: "workspace-secret"; readonly workspaceId: string; readonly name: string };

export function createWorkspaceSecretRateLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    WORKSPACE_SECRET_BUCKET_CAPACITY,
    WORKSPACE_SECRET_REFILL_PER_SECOND,
    WORKSPACE_SECRET_MAX_OWNERS,
  );
}

function secretErrorResponse(code: string, status: number, error: string): Response {
  return jsonResponse({ ok: false, code, error }, status, { "cache-control": "no-store" });
}

export function createWorkspaceSecretRoutes(options: {
  readonly storage: Pick<
    SyncRelayStorage,
    "listWorkspaceSecrets" | "upsertWorkspaceSecret" | "deleteWorkspaceSecret"
  >;
  readonly linkKey: string | Uint8Array | undefined;
  readonly nowMs: () => number;
  readonly rateLimiter: TokenBucketLimiter;
}) {
  return async function respondToWorkspaceSecrets(
    request: Request,
    route: WorkspaceSecretRoute,
    ownerUserId: string,
    recheckAuthority: () => Promise<void>,
  ): Promise<Response> {
    if (!options.rateLimiter.allow(ownerUserId, options.nowMs())) {
      return secretErrorResponse(
        "workspace_secret_rate_limited",
        429,
        "too many workspace secret requests",
      );
    }

    if (route.route === "workspace-secrets") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      if (!options.linkKey) {
        return secretErrorResponse(
          "secrets_unavailable",
          503,
          "workspace secrets are not configured on this server",
        );
      }
      const secrets = options.storage.listWorkspaceSecrets(route.workspaceId);
      return jsonResponse({ ok: true, secrets, limit: MAX_WORKSPACE_SECRETS }, 200, {
        "cache-control": "no-store",
      });
    }

    const parsedName = WorkspaceSecretName.safeParse(route.name);
    if (!parsedName.success) {
      throw badRequest(parsedName.error.issues[0]?.message ?? "Invalid secret name.");
    }
    const name = parsedName.data;

    if (request.method === "PUT") {
      if (!options.linkKey) {
        return secretErrorResponse(
          "secrets_unavailable",
          503,
          "workspace secrets are not configured on this server",
        );
      }
      const body = await readBoundedJson(
        request,
        WORKSPACE_SECRET_MAX_BODY_BYTES,
        request.signal,
      ).catch((error: unknown) => {
        if (error instanceof RangeError) throw relayError("payload_too_large");
        throw badRequest("Request body must be valid JSON.");
      });
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Request body must be a JSON object.");
      }
      const parsed = WorkspaceSecretWriteInput.safeParse({ ...body, name });
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? "Invalid secret payload.");
      }
      await recheckAuthority();
      const input = parsed.data;
      const allowedHosts = input.usage === "http-header" ? input.allowedHosts : [];
      const linkKey = options.linkKey;
      try {
        const result = options.storage.upsertWorkspaceSecret({
          workspaceId: route.workspaceId,
          ownerUserId,
          name: input.name,
          mode: input.mode,
          usage: input.usage,
          allowedHosts,
          keyId: WORKSPACE_SECRET_KEY_ID,
          nowMs: options.nowMs(),
          seal: (generation) =>
            sealWorkspaceSecret({
              plaintext: input.value,
              linkKey,
              workspaceId: route.workspaceId,
              ownerUserId,
              name: input.name,
              usage: input.usage,
              allowedHosts,
              generation,
              keyId: WORKSPACE_SECRET_KEY_ID,
            }),
        });
        if (!result.ok) {
          switch (result.reason) {
            case "unauthorized":
              throw notFound();
            case "already-exists":
              return secretErrorResponse(
                "workspace_secret_already_exists",
                409,
                `A secret named ${input.name} already exists. Use Replace to update it.`,
              );
            case "not-found":
              return secretErrorResponse(
                "workspace_secret_not_found",
                404,
                `Secret ${input.name} no longer exists.`,
              );
            case "limit-reached":
              return secretErrorResponse(
                "workspace_secret_limit_reached",
                409,
                `Workspace secret limit reached (${result.count} of ${result.limit} secrets). Delete an unused secret first.`,
              );
          }
        }
        return jsonResponse(
          {
            ok: true,
            secret: result.secret,
            secrets: result.secrets,
            limit: MAX_WORKSPACE_SECRETS,
          },
          200,
          { "cache-control": "no-store" },
        );
      } catch (error) {
        if (error instanceof SyncRelayQuotaExceededError) {
          throw relayError("quota_exceeded");
        }
        throw error;
      }
    }

    if (request.method === "DELETE") {
      if (!options.linkKey) {
        return secretErrorResponse(
          "secrets_unavailable",
          503,
          "workspace secrets are not configured on this server",
        );
      }
      const result = options.storage.deleteWorkspaceSecret(route.workspaceId, ownerUserId, name);
      if (!result.ok) throw notFound();
      return jsonResponse(
        {
          ok: true,
          deleted: result.deleted,
          secrets: result.secrets,
          limit: MAX_WORKSPACE_SECRETS,
        },
        200,
        { "cache-control": "no-store" },
      );
    }

    throw relayError("method_not_allowed");
  };
}
