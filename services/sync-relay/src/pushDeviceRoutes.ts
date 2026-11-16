import { readBoundedJson } from "@dohc/service-http";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import {
  isApnsDeviceToken,
  isApnsEnvironment,
  PUSH_MAX_REQUEST_BYTES,
  type PushDeviceStatus,
} from "@dohc/workspace-contracts/push-subscriptions";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { badRequest, notFound, relayError, RelayError } from "./errors";
import type { ApnsConfig } from "./pushConfig";
import type { SyncRelayStorage } from "./storage";

const cacheHeaders = { "cache-control": "private, no-store" };
// Each method's exact body keys; GET takes no body.
const BODY_KEYS = new Map<string, string | null>([
  ["GET", null],
  ["PUT", "environment,token"],
  ["DELETE", "generation"],
]);

/**
 * Status, upsert, and removal of the calling phone sign-in's native binding.
 * Only a phone's Bearer session reaches them: a cookie, a computer, or a
 * browser gets 404. Account, session, and
 * expiry come from that session, and the topic from configuration.
 */
export function createPushDeviceRoutes(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
  apns: ApnsConfig | undefined;
  nowMs: () => number;
}) {
  const { storage, apns } = options;

  const readBody = async (request: Request, keys: string): Promise<Record<string, unknown>> => {
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw badRequest("invalid request");
    let value: unknown;
    try {
      value = await readBoundedJson(request, PUSH_MAX_REQUEST_BYTES, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw error instanceof RangeError
        ? relayError("payload_too_large")
        : badRequest("invalid request");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !== keys
    )
      throw badRequest("invalid request");
    return value as Record<string, unknown>;
  };

  const statusFor = (userId: string, sessionId: string, nowMs: number): PushDeviceStatus => {
    if (!apns) return { ok: true, available: false };
    const row = storage.readPushDevice({ userId, sessionId, nowMs });
    return row
      ? { ok: true, available: true, enabled: true, generation: row.generation }
      : { ok: true, available: true, enabled: false, generation: null };
  };

  return async function respondToPushDevices(request: Request): Promise<Response> {
    if (new URL(request.url).search) throw badRequest("invalid request");
    const keys = BODY_KEYS.get(request.method);
    if (keys === undefined) throw relayError("method_not_allowed");
    const input: Record<string, unknown> = keys === null ? {} : await readBody(request, keys);
    // The session is checked last, so nothing waits between that check and the write.
    const session = await bearerAccountSession(storage, options.resolveAccountSession, request);
    if (session.clientKind !== "phone") throw notFound();
    const nowMs = options.nowMs();
    if (session.expiresAtMs <= nowMs) throw new UnauthorizedError();
    if (request.method === "PUT") {
      if (!apns) throw new RelayError("conflict", "alerts are not set up on this server");
      const { token, environment } = input;
      if (!isApnsEnvironment(environment) || !apns.environments.has(environment))
        throw badRequest("environment is invalid");
      if (!isApnsDeviceToken(token)) throw badRequest("token is invalid");
      storage.bindPushDevice({
        userId: session.userId,
        sessionId: session.sessionId,
        sessionExpiresAtMs: session.expiresAtMs,
        token,
        environment,
        topic: apns.topic,
        nowMs,
      });
    } else if (request.method === "DELETE") {
      const { generation } = input;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
        throw badRequest("generation is invalid");
      storage.removePushDevice({
        userId: session.userId,
        sessionId: session.sessionId,
        generation,
      });
    }
    return Response.json(statusFor(session.userId, session.sessionId, nowMs), {
      headers: cacheHeaders,
    });
  };
}
