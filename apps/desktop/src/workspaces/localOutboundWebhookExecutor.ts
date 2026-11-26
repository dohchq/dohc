import {
  parseSafeOutboundHttpsUrl,
  parseSafeOutboundJson,
  readSafeOutboundHttps,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  sendSafeOutboundHttps,
  type SafeOutboundDestination,
  type SafeOutboundRequest,
  type SafeOutboundResponse,
} from "@dohc/service-http";
import {
  AUTOMATION_HTTP_USER_AGENT,
  HTTP_HEADER_VALUE_PATTERN,
  isForbiddenHttpHeader,
  MAX_HTTP_BODY_BYTES,
  MAX_HTTP_HEADERS,
  MAX_HTTP_HEADER_VALUE_BYTES,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_HTTP_TOTAL_HEADER_BYTES,
} from "@dohc/workspace-contracts/automations";
import {
  AUTOMATION_CHAIN_DEPTH_CAP,
  sanitizeHttpFailureReason,
  scrubSecretsFromJson,
  secretUrlScrubValues,
  workspaceSecretApprovalBinding,
  type HttpJsonValue,
} from "@dohc/workspace-contracts/http-step-approvals";
import { AUTOMATION_LIMITS } from "@dohc/app-backend-runtime/automation";
import type { AutomationHttpWebhookExecutor } from "@dohc/automation-executor/collection-automation-run";
import type { WorkspaceSecretSummary } from "@dohc/workspace-contracts/workspace-secrets";
import type { LocalWorkspaceSecretStore } from "./localWorkspaceSecretStore";

const OUTBOUND_TIMEOUT_MS = 10_000;
const OUTBOUND_MAX_HEADER_SIZE = 8_192;
const OUTBOUND_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_LOCAL_CONCURRENT_OUTBOUND = 2;

function fixedSafeOutboundReason(
  error: unknown,
  secrets: readonly string[],
  maxResponseBytes: number,
): string {
  if (error instanceof SafeOutboundError) {
    switch (error.code) {
      case "unsafe_url":
        return sanitizeHttpFailureReason("Webhook destination URL is not allowed.", secrets);
      case "unsafe_address":
        return "Webhook destination resolved to a blocked or non-public network address.";
      case "dns_failed":
        return "Webhook destination hostname could not be resolved.";
      case "redirect_refused":
        return "Webhook destination returned a redirect, which is not allowed.";
      case "response_too_large":
        return `Webhook destination response exceeded the ${maxResponseBytes / 1024} KiB limit.`;
      case "response_interrupted":
        return "Webhook connection closed before a complete response arrived.";
      case "unsupported_response":
        return "Webhook destination did not answer with uncompressed UTF-8 JSON.";
      case "invalid_json":
        return `Webhook destination answered with JSON that is invalid or nested more than ${AUTOMATION_LIMITS.resultDepth} levels deep.`;
      default:
        return "Webhook request failed or timed out.";
    }
  }
  return "Webhook request failed or timed out.";
}

export function createLocalOutboundWebhookExecutor(options: {
  readonly workspaceId: string;
  readonly secrets: LocalWorkspaceSecretStore;
  readonly resolveDestination?: (rawUrl: string) => Promise<SafeOutboundDestination>;
  readonly sendRequest?: (request: SafeOutboundRequest, signal?: AbortSignal) => Promise<number>;
  readonly readRequest?: (
    request: SafeOutboundRequest,
    signal?: AbortSignal,
  ) => Promise<SafeOutboundResponse>;
}): AutomationHttpWebhookExecutor {
  let inFlight = 0;

  return {
    async execute({ effect, method, readResponse, depth, signal, secrets }) {
      const maxResponseBytes = readResponse ? MAX_HTTP_RESPONSE_BYTES : OUTBOUND_MAX_RESPONSE_BYTES;
      const approvedBindings = new Map(
        secrets.map((secret) => [secret.name, workspaceSecretApprovalBinding(secret)]),
      );
      const changedSince = (summary: WorkspaceSecretSummary) =>
        approvedBindings.get(summary.name) !== workspaceSecretApprovalBinding(summary);
      if (depth >= AUTOMATION_CHAIN_DEPTH_CAP) {
        return {
          ok: false,
          reason: `Automation chain reached the maximum depth of ${AUTOMATION_CHAIN_DEPTH_CAP}.`,
          beforeSend: true,
        };
      }
      if (inFlight >= MAX_LOCAL_CONCURRENT_OUTBOUND) {
        return {
          ok: false,
          reason: `At most ${MAX_LOCAL_CONCURRENT_OUTBOUND} webhook requests can run at once.`,
          beforeSend: true,
        };
      }
      if (effect.body !== null && Buffer.byteLength(effect.body, "utf8") > MAX_HTTP_BODY_BYTES) {
        return {
          ok: false,
          reason: `Webhook body exceeds the ${MAX_HTTP_BODY_BYTES}-byte limit.`,
          beforeSend: true,
        };
      }
      if (effect.headers.length + effect.secretHeaders.length > MAX_HTTP_HEADERS) {
        return {
          ok: false,
          reason: `Webhook requests allow at most ${MAX_HTTP_HEADERS} headers.`,
          beforeSend: true,
        };
      }

      inFlight += 1;
      const secretsToScrub: string[] = [];
      try {
        let rawUrl: string;
        if (effect.url.kind === "literal") {
          rawUrl = effect.url.url;
        } else {
          if (!options.secrets.canKeep()) {
            return {
              ok: false,
              reason:
                "This computer's system keychain is unavailable, so dohc cannot read workspace secrets.",
              beforeSend: true,
            };
          }
          const secret = await options.secrets.readSecretForExecution(
            options.workspaceId,
            effect.url.secret,
          );
          if (!secret) {
            return {
              ok: false,
              reason: `Secret "${effect.url.secret}" was not found or could not be read in Settings.`,
              beforeSend: true,
            };
          }
          if (secret.summary.usage !== "http-url") {
            return {
              ok: false,
              reason: `Secret "${effect.url.secret}" is not configured as a webhook URL secret.`,
              beforeSend: true,
            };
          }
          if (changedSince(secret.summary)) {
            return {
              ok: false,
              reason: `Secret "${effect.url.secret}" changed while dohc was sending. Try again.`,
              beforeSend: true,
            };
          }
          rawUrl = secret.value;
          secretsToScrub.push(...secretUrlScrubValues(rawUrl));
        }

        let destination: SafeOutboundDestination;
        try {
          const parsedUrl = parseSafeOutboundHttpsUrl(rawUrl);
          if (parsedUrl === null) {
            throw new SafeOutboundError("unsafe_url", "Outbound destination URL is not allowed.");
          }
          destination = await (options.resolveDestination ?? resolveSafeOutboundDestination)(
            parsedUrl.href,
          );
        } catch (error) {
          return {
            ok: false,
            reason: fixedSafeOutboundReason(error, secretsToScrub, maxResponseBytes),
            beforeSend: true,
          };
        }
        if (effect.url.kind === "secret") {
          secretsToScrub.push(destination.canonicalHost);
          const name = effect.url.secret;
          const current = await options.secrets.list(options.workspaceId).catch(() => []);
          const now = current.find((secret) => secret.name === name);
          if (!now || changedSince(now)) {
            return {
              ok: false,
              reason: `Secret "${name}" changed while dohc was sending. Try again.`,
              beforeSend: true,
            };
          }
        }

        const outboundHeaders = Object.create(null) as Record<string, string>;
        const seenLower = new Set<string>();
        let totalHeaderBytes = 0;
        let hasContentType = false;

        for (const header of effect.headers) {
          const lower = header.name.toLowerCase();
          if (
            seenLower.has(lower) ||
            isForbiddenHttpHeader(header.name) ||
            !HTTP_HEADER_VALUE_PATTERN.test(header.value) ||
            Buffer.byteLength(header.value, "utf8") > MAX_HTTP_HEADER_VALUE_BYTES
          ) {
            return {
              ok: false,
              reason: `Webhook header "${header.name}" is invalid.`,
              beforeSend: true,
            };
          }
          seenLower.add(lower);
          outboundHeaders[header.name] = header.value;
          totalHeaderBytes +=
            Buffer.byteLength(header.name, "utf8") + Buffer.byteLength(header.value, "utf8");
          if (lower === "content-type") hasContentType = true;
        }
        if (totalHeaderBytes > MAX_HTTP_TOTAL_HEADER_BYTES) {
          return {
            ok: false,
            reason: `Webhook headers exceed the ${MAX_HTTP_TOTAL_HEADER_BYTES}-byte limit.`,
            beforeSend: true,
          };
        }

        for (const secretHeader of effect.secretHeaders) {
          const lower = secretHeader.name.toLowerCase();
          if (seenLower.has(lower) || isForbiddenHttpHeader(secretHeader.name)) {
            return {
              ok: false,
              reason: `Secret header "${secretHeader.name}" is invalid.`,
              beforeSend: true,
            };
          }
          if (!options.secrets.canKeep()) {
            return {
              ok: false,
              reason:
                "This computer's system keychain is unavailable, so dohc cannot read workspace secrets.",
              beforeSend: true,
            };
          }
          const secret = await options.secrets.readSecretForExecution(
            options.workspaceId,
            secretHeader.secret,
          );
          if (!secret) {
            return {
              ok: false,
              reason: `Secret "${secretHeader.secret}" was not found or could not be read in Settings.`,
              beforeSend: true,
            };
          }
          if (secret.summary.usage !== "http-header") {
            return {
              ok: false,
              reason: `Secret "${secretHeader.secret}" is not configured as a header secret.`,
              beforeSend: true,
            };
          }
          if (changedSince(secret.summary)) {
            return {
              ok: false,
              reason: `Secret "${secretHeader.secret}" changed while dohc was sending. Try again.`,
              beforeSend: true,
            };
          }
          if (!secret.summary.allowedHosts.includes(destination.canonicalHost)) {
            return {
              ok: false,
              reason:
                effect.url.kind === "secret"
                  ? `Secret "${secretHeader.secret}" is not allowed for the webhook destination host.`
                  : `Secret "${secretHeader.secret}" is not allowed for host "${destination.canonicalHost}".`,
              beforeSend: true,
            };
          }
          secretsToScrub.push(secret.value);
          const combinedValue = `${secretHeader.prefix ?? ""}${secret.value}`;
          if (!HTTP_HEADER_VALUE_PATTERN.test(combinedValue)) {
            return {
              ok: false,
              reason: `Secret header "${secretHeader.name}" contains disallowed characters.`,
              beforeSend: true,
            };
          }
          totalHeaderBytes +=
            Buffer.byteLength(secretHeader.name, "utf8") + Buffer.byteLength(combinedValue, "utf8");
          if (totalHeaderBytes > MAX_HTTP_TOTAL_HEADER_BYTES) {
            return {
              ok: false,
              reason: `Webhook headers exceed the ${MAX_HTTP_TOTAL_HEADER_BYTES}-byte limit.`,
              beforeSend: true,
            };
          }
          seenLower.add(lower);
          outboundHeaders[secretHeader.name] = combinedValue;
          if (lower === "content-type") hasContentType = true;
        }

        if (effect.body !== null && !hasContentType) {
          outboundHeaders["Content-Type"] = effect.defaultContentType ?? "application/json";
        }
        outboundHeaders["User-Agent"] = AUTOMATION_HTTP_USER_AGENT;
        outboundHeaders["X-Dohc-Delivery-Id"] = effect.deliveryId;
        outboundHeaders["X-Dohc-Chain-Depth"] = String(depth + 1);

        const request: SafeOutboundRequest = {
          destination,
          method,
          headers: outboundHeaders,
          body: effect.body !== null ? Buffer.from(effect.body, "utf8") : undefined,
          timeoutMs: OUTBOUND_TIMEOUT_MS,
          maxHeaderSize: OUTBOUND_MAX_HEADER_SIZE,
          maxResponseBytes,
          rejectRedirects: true,
        };
        let status: number;
        let response: HttpJsonValue | undefined;
        try {
          if (readResponse) {
            const read = await (options.readRequest ?? readSafeOutboundHttps)(request, signal);
            status = read.status;
            if (status >= 200 && status < 300) {
              const scrubbed = scrubSecretsFromJson(
                parseSafeOutboundJson(read, AUTOMATION_LIMITS.resultDepth) as HttpJsonValue,
                secretsToScrub,
              );
              if (!scrubbed.ok) return { ok: false, status, reason: scrubbed.reason };
              response = scrubbed.value;
            }
          } else {
            status = await (options.sendRequest ?? sendSafeOutboundHttps)(request, signal);
          }
        } catch (error) {
          return {
            ok: false,
            reason: fixedSafeOutboundReason(error, secretsToScrub, maxResponseBytes),
          };
        }

        if (status >= 200 && status < 300) {
          return response === undefined ? { ok: true, status } : { ok: true, status, response };
        }
        return {
          ok: false,
          status,
          reason: sanitizeHttpFailureReason(
            `Webhook destination returned HTTP ${status}.`,
            secretsToScrub,
          ),
        };
      } finally {
        inFlight = Math.max(0, inFlight - 1);
      }
    },
  };
}
