import { createHash } from "node:crypto";
import {
  jsonResponse,
  readBoundedJson,
  senderAddressKey,
  TokenBucketLimiter,
} from "@dohc/service-http";
import {
  extractAllowedIncomingWebhookHeaders,
  INCOMING_WEBHOOK_BURST_CAPACITY,
  INCOMING_WEBHOOK_FORM_SENDER_BURST,
  INCOMING_WEBHOOK_FORM_SENDER_DAILY,
  keepIncomingWebhookFormFields,
  INCOMING_WEBHOOK_DAILY_DELIVERY_CAP,
  INCOMING_WEBHOOK_DELIVERY_KEY_PATTERN,
  INCOMING_WEBHOOK_MAX_CHAIN_DEPTH,
  INCOMING_WEBHOOK_READ_TIMEOUT_MS,
  INCOMING_WEBHOOK_REFILL_PER_SECOND,
  INCOMING_WEBHOOK_TOKEN_PATTERN,
  IncomingWebhookCreateInput,
  IncomingWebhookId,
  IncomingWebhookUpdateInput,
  MAX_INCOMING_WEBHOOK_BODY_BYTES,
  MAX_INCOMING_WEBHOOK_FORM_BODY_BYTES,
  MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
  parseIncomingWebhookContentType,
} from "@dohc/workspace-contracts/incoming-webhooks";
import { cutText } from "@dohc/workspace-contracts/names";
import { NOTICE_TITLE_MAX_CHARS } from "@dohc/workspace-contracts/relay";
import type { AutomationServer } from "./storage/automationHosts";
import { badRequest, notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { SyncRelayQuotaExceededError } from "./storage/errors";
import {
  hashIncomingWebhookToken,
  mintIncomingWebhookDeliveryId,
  mintIncomingWebhookId,
  mintIncomingWebhookToken,
} from "./storage/incomingWebhooks";

export const MAX_INCOMING_WEBHOOK_ADMIN_BODY_BYTES = 16 * 1024;
const UNKNOWN_TOKEN_PROBE_CAPACITY = 120;
const UNKNOWN_TOKEN_PROBE_REFILL_PER_SECOND = 2;
const ADMIN_BUCKET_CAPACITY = 30;
const ADMIN_REFILL_PER_SECOND = 1;
const MAX_TRACKED_KEYS = 20_000;

export type IncomingWebhookRoute =
  | { readonly route: "incoming-webhook"; readonly token: string }
  | { readonly route: "workspace-webhooks"; readonly workspaceId: string }
  | {
      readonly route: "workspace-webhook";
      readonly workspaceId: string;
      readonly webhookId: string;
    }
  | {
      readonly route: "workspace-webhook-rotate";
      readonly workspaceId: string;
      readonly webhookId: string;
    };

export function createIncomingWebhookLimiters() {
  return {
    endpoint: new TokenBucketLimiter(
      INCOMING_WEBHOOK_BURST_CAPACITY,
      INCOMING_WEBHOOK_REFILL_PER_SECOND,
      MAX_TRACKED_KEYS,
    ),
    unknownProbe: new TokenBucketLimiter(
      UNKNOWN_TOKEN_PROBE_CAPACITY,
      UNKNOWN_TOKEN_PROBE_REFILL_PER_SECOND,
      1,
    ),
    admin: new TokenBucketLimiter(ADMIN_BUCKET_CAPACITY, ADMIN_REFILL_PER_SECOND, MAX_TRACKED_KEYS),
    formSender: new TokenBucketLimiter(
      INCOMING_WEBHOOK_FORM_SENDER_BURST,
      INCOMING_WEBHOOK_FORM_SENDER_DAILY / 86_400,
      MAX_TRACKED_KEYS,
    ),
  };
}

function webhookJson(
  payload: Record<string, unknown>,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(payload, status, {
    "cache-control": "no-store",
    ...extraHeaders,
  });
}

function pendingError(
  reason: "pending-count" | "pending-bytes" | "form-pending-count",
  current: number | undefined,
  limit: number | undefined,
): string {
  if (reason === "form-pending-count")
    return `form webhook pending queue full (${current} of ${limit} deliveries)`;
  return reason === "pending-count"
    ? `workspace pending webhook queue full (${current} of ${limit} deliveries)`
    : `workspace pending webhook buffer full (${current} of ${limit} bytes)`;
}

function opaqueNotFound(): Response {
  return webhookJson({ ok: false, error: "not found" }, 404);
}

class PayloadTooLargeError extends Error {
  constructor() {
    super(`Payload exceeds ${MAX_INCOMING_WEBHOOK_BODY_BYTES} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

class BodyReadTimeoutError extends Error {
  constructor() {
    super("Request body timed out.");
    this.name = "BodyReadTimeoutError";
  }
}

class BodyAbortedError extends Error {
  constructor() {
    super("Request body aborted.");
    this.name = "BodyAbortedError";
  }
}

async function readStreamingBoundedBody(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (request.signal.aborted) {
    throw new BodyAbortedError();
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength.trim())) {
    const parsed = Number(declaredLength.trim());
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new PayloadTooLargeError();
    }
  }
  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (aborted || request.signal.aborted) throw new BodyAbortedError();
      const next = await reader.read();
      if (timedOut) throw new BodyReadTimeoutError();
      if (aborted || request.signal.aborted) throw new BodyAbortedError();
      if (next.done) break;
      const chunk = next.value;
      if (!chunk || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      chunks.push(chunk);
    }
    if (timedOut) throw new BodyReadTimeoutError();
    if (aborted || request.signal.aborted) throw new BodyAbortedError();
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  } catch (error) {
    if (timedOut) throw new BodyReadTimeoutError();
    if (aborted || request.signal.aborted) throw new BodyAbortedError();
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseChainDepthHeader(
  raw: string | null,
): { readonly ok: true; readonly depth: number } | { readonly ok: false } {
  if (raw === null || raw.trim() === "") return { ok: true, depth: 0 };
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return { ok: false };
  const depth = Number(trimmed);
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= INCOMING_WEBHOOK_MAX_CHAIN_DEPTH) {
    return { ok: false };
  }
  return { ok: true, depth };
}

function resolveEndpointUrl(
  request: Request,
  publicOrigin: string | undefined,
  token: string,
): string {
  const origin = publicOrigin ? publicOrigin.replace(/\/+$/u, "") : new URL(request.url).origin;
  return `${origin}/sync/hooks/${encodeURIComponent(token)}`;
}

export function createIncomingWebhookRoutes(options: {
  readonly storage: SyncRelayStorage;
  readonly linkKey: string | Uint8Array | undefined;
  readonly publicOrigin?: string;
  readonly nowMs: () => number;
  readonly limiters: ReturnType<typeof createIncomingWebhookLimiters>;
  readonly automationServer: AutomationServer | null;
}) {
  const automationServerEnabled = options.automationServer !== null;

  function postDailyCapNotice(input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly webhookId: string;
    readonly webhookName: string;
    readonly collectionPath: string;
    readonly nowMs: number;
  }): void {
    const utcDay = new Date(input.nowMs).toISOString().slice(0, 10);
    const noticeId = `incoming-webhook-cap:${input.webhookId}:${utcDay}`;
    try {
      options.storage.postNotice({
        noticeId,
        recipientUserId: input.ownerUserId,
        reach: { workspaceId: input.workspaceId },
        kind: "automation-failed",
        title: cutText(
          `Incoming webhook "${input.webhookName}" hit its daily limit`,
          NOTICE_TITLE_MAX_CHARS,
        ),
        body: `This webhook reached ${INCOMING_WEBHOOK_DAILY_DELIVERY_CAP} deliveries/day. Additional deliveries are rejected with HTTP 429 until tomorrow UTC.`,
        target: {
          path: input.collectionPath,
        },
        originInstallId: "sync-relay",
        senderUserId: input.ownerUserId,
        senderLabel: "dohc server",
        nowMs: input.nowMs,
      });
    } catch {
      // Notice delivery failure must never mask the 429 webhook refusal.
    }
  }

  /**
   * Public ingress: `POST /sync/hooks/:token`.
   * Queue-only: NEVER opens a ServerCopy on ingress.
   */
  async function respondToPublicIngress(request: Request, token: string): Promise<Response> {
    if (request.method !== "POST") {
      return webhookJson({ ok: false, error: "method not allowed" }, 405, { allow: "POST" });
    }
    const parsedDepth = parseChainDepthHeader(request.headers.get("x-dohc-chain-depth"));
    if (!parsedDepth.ok) {
      return webhookJson(
        {
          ok: false,
          error: `webhook chain depth exceeds limit of ${INCOMING_WEBHOOK_MAX_CHAIN_DEPTH}`,
        },
        422,
      );
    }
    if (!options.linkKey) {
      return webhookJson({ ok: false, error: "incoming webhooks are not configured" }, 503);
    }

    const now = options.nowMs();

    // Token lookup FIRST so unknown-token scanners behind a reverse proxy cannot exhaust valid endpoints' rate limits.
    const resolved = INCOMING_WEBHOOK_TOKEN_PATTERN.test(token)
      ? options.storage.lookupActiveIncomingWebhookByToken(options.linkKey, token)
      : null;
    if (resolved === null) {
      if (!options.limiters.unknownProbe.allow("global", now)) {
        return webhookJson({ ok: false, error: "rate limit exceeded" }, 429);
      }
      return opaqueNotFound();
    }

    if (!automationServerEnabled || !resolved.hostReady) {
      return webhookJson(
        {
          ok: false,
          error:
            "incoming webhook delivery is unavailable while this workspace's automation host is not this server",
        },
        503,
      );
    }

    const form = resolved.form;
    if (form) {
      const sender = senderAddressKey(request.headers.get("x-dohc-relay-client-ip") ?? "");
      if (!options.limiters.formSender.allow(`${resolved.webhookId}|${sender}`, now)) {
        return webhookJson({ ok: false, error: "too many submissions from this network" }, 429);
      }
    }

    // Per-endpoint rate limit (30 burst, 0.5/s refill), checked BEFORE reading the body.
    if (!options.limiters.endpoint.allow(resolved.webhookId, now)) {
      return webhookJson({ ok: false, error: "webhook rate limit exceeded" }, 429);
    }

    const rawDeliveryKey =
      request.headers.get("idempotency-key") ?? request.headers.get("x-webhook-delivery");
    let deliveryKey: string | null = null;
    if (rawDeliveryKey !== null && rawDeliveryKey.trim() !== "") {
      const trimmedKey = rawDeliveryKey.trim();
      if (!INCOMING_WEBHOOK_DELIVERY_KEY_PATTERN.test(trimmedKey)) {
        return webhookJson(
          {
            ok: false,
            error: "idempotency key must be 1 to 128 printable ASCII characters",
          },
          400,
        );
      }
      deliveryKey = trimmedKey;
    }

    // Fast pre-check for daily cap and workspace pending budgets BEFORE streaming up to 256 KiB.
    const precheck = options.storage.precheckIncomingWebhookBudgets(
      resolved.webhookId,
      resolved.workspaceId,
      now,
      deliveryKey,
    );
    if (!precheck.ok) {
      if (precheck.reason === "daily-cap") {
        if (precheck.shouldNotifyDailyCap) {
          postDailyCapNotice({
            workspaceId: resolved.workspaceId,
            ownerUserId: resolved.ownerUserId,
            webhookId: resolved.webhookId,
            webhookName: resolved.name,
            collectionPath: resolved.collectionPath,
            nowMs: now,
          });
        }
        return webhookJson(
          {
            ok: false,
            error: `daily webhook delivery limit reached (${precheck.current} of ${precheck.limit} deliveries/day)`,
          },
          429,
        );
      }
      return webhookJson(
        { ok: false, error: pendingError(precheck.reason, precheck.current, precheck.limit) },
        429,
      );
    }

    const contentType = parseIncomingWebhookContentType(request.headers.get("content-type"));
    if (form && contentType !== "application/x-www-form-urlencoded") {
      return webhookJson(
        { ok: false, error: "unsupported content-type; use application/x-www-form-urlencoded" },
        415,
      );
    }
    if (contentType === null) {
      return webhookJson(
        {
          ok: false,
          error:
            "unsupported content-type; use application/json, text/plain, or application/x-www-form-urlencoded",
        },
        415,
      );
    }

    const maxBodyBytes = form
      ? MAX_INCOMING_WEBHOOK_FORM_BODY_BYTES
      : MAX_INCOMING_WEBHOOK_BODY_BYTES;
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = await readStreamingBoundedBody(
        request,
        maxBodyBytes,
        INCOMING_WEBHOOK_READ_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return webhookJson({ ok: false, error: `payload exceeds ${maxBodyBytes} bytes` }, 413);
      }
      if (error instanceof BodyReadTimeoutError) {
        return webhookJson({ ok: false, error: "request body timed out" }, 408);
      }
      if (error instanceof BodyAbortedError) {
        return webhookJson({ ok: false, error: "request body aborted" }, 400);
      }
      return webhookJson({ ok: false, error: "invalid request body" }, 400);
    }

    if (form) {
      const kept = keepIncomingWebhookFormFields(form, new TextDecoder().decode(payloadBytes));
      if (!kept.ok) return webhookJson({ ok: false, error: kept.error }, 422);
      payloadBytes = new TextEncoder().encode(kept.body);
    }

    const allowedHeaders = extractAllowedIncomingWebhookHeaders(request.headers);
    const payloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");
    const deliveryId = mintIncomingWebhookDeliveryId();

    let queued;
    try {
      queued = options.storage.enqueueIncomingWebhookDelivery({
        webhookId: resolved.webhookId,
        expectedTokenHash: resolved.tokenHash,
        deliveryId,
        deliveryKey,
        payloadSha256,
        contentType,
        headersJson: JSON.stringify(allowedHeaders),
        payloadBlob: payloadBytes,
        chainDepth: parsedDepth.depth,
        automationServerEnabled,
        nowMs: now,
      });
    } catch (error) {
      if (error instanceof SyncRelayQuotaExceededError) {
        return webhookJson({ ok: false, error: "workspace storage quota exceeded" }, 429);
      }
      throw error;
    }

    if (!queued.ok) {
      switch (queued.reason) {
        case "not-found":
          return opaqueNotFound();
        case "host-unavailable":
          return webhookJson(
            {
              ok: false,
              error:
                "incoming webhook delivery is unavailable while this workspace's automation host is not this server",
            },
            503,
          );
        case "idempotency-conflict":
          return webhookJson(
            { ok: false, error: "idempotency key already used with a different payload" },
            409,
          );
        case "daily-cap":
          if (queued.shouldNotifyDailyCap) {
            postDailyCapNotice({
              workspaceId: resolved.workspaceId,
              ownerUserId: resolved.ownerUserId,
              webhookId: resolved.webhookId,
              webhookName: resolved.name,
              collectionPath: resolved.collectionPath,
              nowMs: now,
            });
          }
          return webhookJson(
            {
              ok: false,
              error: `daily webhook delivery limit reached (${queued.current ?? INCOMING_WEBHOOK_DAILY_DELIVERY_CAP} of ${queued.limit ?? INCOMING_WEBHOOK_DAILY_DELIVERY_CAP} deliveries/day)`,
            },
            429,
          );
        case "pending-count":
        case "pending-bytes":
        case "form-pending-count":
          return webhookJson(
            { ok: false, error: pendingError(queued.reason, queued.current, queued.limit) },
            429,
          );
      }
    }

    return webhookJson(
      {
        ok: true,
        deliveryId: queued.deliveryId,
        ...(queued.deduplicated ? { deduplicated: true } : {}),
      },
      202,
    );
  }

  /**
   * Owner management routes under `/sync/:workspaceId/webhooks*`.
   * Desktop-owner Bearer session only (checked by server.ts + recheckAuthority before mutation).
   */
  async function respondToOwnerManagement(
    request: Request,
    route: Exclude<IncomingWebhookRoute, { route: "incoming-webhook" }>,
    ownerUserId: string,
    recheckAuthority: () => Promise<void>,
  ): Promise<Response> {
    if (!options.limiters.admin.allow(ownerUserId, options.nowMs())) {
      return webhookJson({ ok: false, error: "too many webhook management requests" }, 429);
    }
    if (!options.linkKey) {
      return webhookJson(
        { ok: false, error: "incoming webhooks are not configured on this server" },
        503,
      );
    }

    if (route.route === "workspace-webhooks") {
      if (request.method === "GET") {
        const webhooks = options.storage.listIncomingWebhooks(route.workspaceId);
        if (!automationServerEnabled && webhooks.length === 0) {
          return webhookJson(
            {
              ok: false,
              error:
                "Incoming webhooks require server-hosted automations, which are not enabled on this server.",
            },
            503,
          );
        }
        return webhookJson(
          {
            ok: true,
            webhooks,
            limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
          },
          200,
        );
      }
      if (request.method === "POST") {
        const body = await readBoundedJson(
          request,
          MAX_INCOMING_WEBHOOK_ADMIN_BODY_BYTES,
          request.signal,
        ).catch((error: unknown) => {
          if (error instanceof RangeError) throw relayError("payload_too_large");
          throw badRequest("Request body must be valid JSON.");
        });
        const parsed = IncomingWebhookCreateInput.safeParse(body);
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? "Invalid webhook payload.");
        }
        await recheckAuthority();
        const token = mintIncomingWebhookToken();
        const tokenHash = hashIncomingWebhookToken(options.linkKey, token);
        const webhookId = mintIncomingWebhookId();
        let created;
        try {
          created = options.storage.createIncomingWebhook({
            workspaceId: route.workspaceId,
            ownerUserId,
            webhookId,
            name: parsed.data.name,
            collectionPath: parsed.data.collectionPath,
            form: parsed.data.form ?? null,
            tokenHash,
            nowMs: options.nowMs(),
            automationServer: options.automationServer,
          });
        } catch (error) {
          if (error instanceof SyncRelayQuotaExceededError) {
            throw relayError("quota_exceeded");
          }
          throw error;
        }
        if (!created.ok) {
          switch (created.reason) {
            case "unauthorized":
              throw notFound();
            case "automation-server-disabled":
              return webhookJson(
                {
                  ok: false,
                  error:
                    "Incoming webhooks require server-hosted automations, which are not enabled on this server.",
                },
                503,
              );
            case "automation-server-full":
              return webhookJson(
                {
                  ok: false,
                  error:
                    "This server has reached its automation workspace capacity. Free a workspace slot before creating an incoming webhook.",
                },
                503,
              );
            case "host-not-server":
              return webhookJson(
                {
                  ok: false,
                  error:
                    "Incoming webhooks require this workspace's automation host to be set to your sync server. Switch the automation host in Settings first.",
                },
                409,
              );
            case "invalid-collection":
              throw badRequest("Choose an owned Collection folder in this workspace.");
            case "collection-not-found":
              return webhookJson(
                {
                  ok: false,
                  error: `Collection "${parsed.data.collectionPath}" was not found in this workspace.`,
                },
                404,
              );
            case "collection-shared":
              return webhookJson(
                {
                  ok: false,
                  error:
                    "Incoming webhooks can only deliver to private Collections. Stop sharing this Collection or its parent folder first.",
                },
                409,
              );
            case "limit-reached":
              return webhookJson(
                {
                  ok: false,
                  error: `Incoming webhook limit reached (${created.count} of ${created.limit} webhooks). Delete an unused webhook first.`,
                },
                409,
              );
          }
        }
        return webhookJson(
          {
            ok: true,
            webhook: created.webhook,
            token,
            endpointUrl: resolveEndpointUrl(request, options.publicOrigin, token),
            webhooks: created.webhooks,
            limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
          },
          201,
        );
      }
      throw relayError("method_not_allowed");
    }

    const parsedId = IncomingWebhookId.safeParse(route.webhookId);
    if (!parsedId.success) {
      throw notFound();
    }
    const webhookId = parsedId.data;

    if (route.route === "workspace-webhook-rotate") {
      if (request.method !== "POST") throw relayError("method_not_allowed");
      await recheckAuthority();
      const token = mintIncomingWebhookToken();
      const newTokenHash = hashIncomingWebhookToken(options.linkKey, token);
      const rotated = options.storage.rotateIncomingWebhookToken({
        workspaceId: route.workspaceId,
        ownerUserId,
        webhookId,
        newTokenHash,
        nowMs: options.nowMs(),
      });
      if (!rotated.ok) throw notFound();
      return webhookJson(
        {
          ok: true,
          webhook: rotated.webhook,
          token,
          endpointUrl: resolveEndpointUrl(request, options.publicOrigin, token),
          webhooks: rotated.webhooks,
          limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
        },
        200,
      );
    }

    if (request.method === "PATCH") {
      const body = await readBoundedJson(
        request,
        MAX_INCOMING_WEBHOOK_ADMIN_BODY_BYTES,
        request.signal,
      ).catch((error: unknown) => {
        if (error instanceof RangeError) throw relayError("payload_too_large");
        throw badRequest("Request body must be valid JSON.");
      });
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Request body must be a JSON object.");
      }
      const parsed = IncomingWebhookUpdateInput.safeParse({ ...body, webhookId });
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? "Invalid webhook update.");
      }
      await recheckAuthority();
      const updated = options.storage.updateIncomingWebhook({
        workspaceId: route.workspaceId,
        ownerUserId,
        webhookId,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.paused !== undefined ? { paused: parsed.data.paused } : {}),
        automationServerEnabled,
        nowMs: options.nowMs(),
      });
      if (!updated.ok) {
        switch (updated.reason) {
          case "collection-shared":
            return webhookJson(
              {
                ok: false,
                error:
                  "Cannot resume while this Collection or a parent folder is shared. Stop sharing it first.",
              },
              409,
            );
          case "automation-server-disabled":
            return webhookJson(
              {
                ok: false,
                error: "Cannot resume while server-hosted automations are disabled on this server.",
              },
              503,
            );
          case "host-not-server":
            return webhookJson(
              {
                ok: false,
                error:
                  "Cannot resume while this workspace's automation host is not your sync server. Switch the automation host in Settings first.",
              },
              409,
            );
          default:
            throw notFound();
        }
      }
      return webhookJson(
        {
          ok: true,
          webhook: updated.webhook,
          webhooks: updated.webhooks,
          limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
        },
        200,
      );
    }

    if (request.method === "DELETE") {
      await recheckAuthority();
      const deleted = options.storage.deleteIncomingWebhook(
        route.workspaceId,
        ownerUserId,
        webhookId,
      );
      if (!deleted.ok) throw notFound();
      return webhookJson(
        {
          ok: true,
          deleted: deleted.deleted,
          webhooks: deleted.webhooks,
          limit: MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
        },
        200,
      );
    }

    throw relayError("method_not_allowed");
  }

  return {
    async respondToPublicIngress(request: Request, token: string): Promise<Response> {
      const response = await respondToPublicIngress(request, token);
      response.headers.set("access-control-allow-origin", "*");
      return response;
    },
    respondToOwnerManagement,
  };
}
