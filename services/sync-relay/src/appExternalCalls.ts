import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { DatasetAuthority } from "@dohc/app-backend-runtime/dataset-host";
import {
  APP_EXTERNAL_TIMEOUT_MS,
  AppExternalInputError,
  renderAppExternalRequest,
  type AppExternalOperation,
} from "@dohc/security-contract/app-external";
import {
  DeclaredHttpsError,
  sendDeclaredHttps,
  TokenBucketLimiter,
  type DeclaredHttpsTransport,
} from "@dohc/service-http";
import { workspaceSecretApprovalBinding } from "@dohc/workspace-contracts/http-step-approvals";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { approvedSecretBindings } from "./storage/publications";
import { unsealWorkspaceSecret, type WorkspaceSecretKeyring } from "./workspaceSecretCrypto";

export const APP_EXTERNAL_LIMITS = {
  workspace: { burst: 120, perSecond: 1 },
  link: { burst: 30, perSecond: 0.5 },
  inFlight: 8,
  ownerReserved: 2,
};

export interface ServedExternalApp {
  publicationId: string;
  workspaceId: string;
  authorityRevision: number;
  external: AppExternalOperation[];
  authority: DatasetAuthority;
}

const refuse = (code: string, message: string) => new AppBackendRuntimeError({ code, message });

/** Runs a published app's declared outside calls with the server's sealed copy of the workspace secret. */
export function createAppExternalCalls(options: {
  storage: SyncRelayStorage;
  keyring: WorkspaceSecretKeyring | null;
  nowMs(): number;
  transport?: DeclaredHttpsTransport;
}) {
  const workspaces = new TokenBucketLimiter(
    APP_EXTERNAL_LIMITS.workspace.burst,
    APP_EXTERNAL_LIMITS.workspace.perSecond,
    8_192,
  );
  const links = new TokenBucketLimiter(
    APP_EXTERNAL_LIMITS.link.burst,
    APP_EXTERNAL_LIMITS.link.perSecond,
    8_192,
  );
  const inFlight = new Map<string, number>();
  return async (
    served: ServedExternalApp,
    raw: unknown,
    /** Throws once the caller can no longer run this app at the same revision. */
    stillServed: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ status: number; data: unknown }> => {
    const { workspaceId, authority } = served;
    const owner = authority.caller.kind === "owner";
    const body = raw as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join() !== "authorityRevision,input,operation" ||
      body.authorityRevision !== served.authorityRevision
    )
      throw refuse("external_input", "This app is out of date. Reload it and try again.");
    const operation = served.external.find((value) => value.name === body.operation);
    if (!operation || (operation.access === "owner" && !owner))
      throw refuse(
        "external_not_approved",
        `This app has no approved outside call named ${String(body.operation).slice(0, 64)} for you.`,
      );
    let request;
    try {
      request = renderAppExternalRequest(operation, body.input);
    } catch (error) {
      if (error instanceof AppExternalInputError) throw refuse("external_input", error.message);
      throw error;
    }
    const unavailable = (detail: string) =>
      refuse(
        "external_unavailable",
        owner ? detail : "This app's outside service isn't available right now.",
      );
    const nowMs = options.nowMs();
    if (authority.caller.kind === "link" && !links.has(authority.caller.grantId, nowMs))
      throw refuse(
        "external_rate_limited",
        `This share link reached its limit of ${APP_EXTERNAL_LIMITS.link.burst} outside calls in a row, then 1 every ${1 / APP_EXTERNAL_LIMITS.link.perSecond} seconds. Try again shortly.`,
      );
    if (!workspaces.allow(workspaceId, nowMs))
      throw refuse(
        "external_rate_limited",
        `This workspace's apps reached their limit of ${APP_EXTERNAL_LIMITS.workspace.burst} outside calls in a row, then ${APP_EXTERNAL_LIMITS.workspace.perSecond} each second. Try again shortly.`,
      );
    if (authority.caller.kind === "link") links.allow(authority.caller.grantId, nowMs);
    const running = inFlight.get(workspaceId) ?? 0;
    const cap = APP_EXTERNAL_LIMITS.inFlight - (owner ? 0 : APP_EXTERNAL_LIMITS.ownerReserved);
    if (running >= cap)
      throw refuse(
        "external_busy",
        `This workspace already has ${running} outside calls running, and ${cap} is the most ${owner ? "it can run" : "visitors can start"} at once. Try again when one finishes.`,
      );
    inFlight.set(workspaceId, running + 1);
    try {
      return await sendDeclaredHttps({
        request,
        host: operation.host,
        maxResponseBytes: operation.response.maxBytes,
        timeoutMs: APP_EXTERNAL_TIMEOUT_MS,
        signal,
        ...(options.transport ? { transport: options.transport } : {}),
        secret: async () => {
          const { name } = operation.secret;
          const ownerUserId = options.storage.workspaceOwner(workspaceId);
          if (!options.keyring || !ownerUserId)
            throw unavailable("This server can't read workspace secrets.");
          const stored = options.storage.readWorkspaceSecretForExecution(workspaceId, name);
          if (!stored) throw unavailable(`Secret ${name} isn't in Settings > Secrets.`);
          if (
            stored.summary.usage !== "http-header" ||
            !stored.summary.allowedHosts.includes(operation.host)
          )
            throw unavailable(
              `Secret ${name} must be a header value allowed for ${operation.host}. Fix it in Settings > Secrets.`,
            );
          const approved = approvedSecretBindings(
            options.storage as StorageContext,
            served.publicationId,
            served.authorityRevision,
          )[name];
          if (approved !== workspaceSecretApprovalBinding(stored.summary))
            throw unavailable(
              `Secret ${name} was replaced after you shared this app. Stop sharing it, then share it again to approve the new secret.`,
            );
          const value = unsealWorkspaceSecret({
            keyring: options.keyring,
            workspaceId,
            ownerUserId,
            name,
            usage: stored.summary.usage,
            allowedHosts: stored.summary.allowedHosts,
            generation: stored.summary.generation,
            keyId: stored.keyId,
            sealed: stored.sealedValue,
          });
          if (value === null)
            throw unavailable(
              `Secret ${name} can't be opened on this server. Replace it in Settings.`,
            );
          await stillServed();
          signal.throwIfAborted();
          return { header: operation.secret.header, prefix: operation.secret.prefix, value };
        },
      });
    } catch (error) {
      if (error instanceof DeclaredHttpsError) throw refuse(error.code, error.message);
      throw error;
    } finally {
      const left = (inFlight.get(workspaceId) ?? 1) - 1;
      if (left) inFlight.set(workspaceId, left);
      else inFlight.delete(workspaceId);
    }
  };
}
