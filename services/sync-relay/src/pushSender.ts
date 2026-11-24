import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes, sign } from "node:crypto";
import {
  isPublicInternetAddress,
  resolveSafeAddresses,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  sendSafeOutboundHttps,
  type SafeOutboundDestination,
} from "@dohc/service-http";
import { withholdChatFileLinks } from "@dohc/workspace-contracts/chat-mentions";
import type { ApnsClient } from "./apnsClient";
import { apnsPayload, apnsText } from "./apnsPayload";
import {
  isOwnAgentMessage,
  phoneCanShow,
  pushMessageAccess,
  pushPlainText,
  readPushMessage,
  type ChatMessageReason,
  type PushMessage,
} from "./chatMessageInterest";
import type { PushConfig } from "./pushConfig";
import { pushEndpointUrl } from "./pushEndpoints";
import { observeRelayWrites } from "./relayWriteChanges";
import type { StorageContext } from "./storage/context";
import {
  claimPushDelivery,
  finishPushDelivery,
  nextPushDeliveryAt,
  readPushLease,
  pausePushDelivery,
  type PushDelivery,
} from "./storage/pushDeliveries";
import { readLivePushDevice, removeUnregisteredPushDevice } from "./storage/pushDevices";
import { noticeIsListed } from "./storage/notices";
import {
  readPushSubscription,
  removePushSubscriptionGeneration,
  type PushSubscriptionRow,
} from "./storage/pushSubscriptions";

const SEND_TIMEOUT_MS = 10_000;
export const PUSH_DELIVERY_TTL_SECONDS = 60;
export const PUSH_STREAMS = 4;
export const APNS_PAUSE_MS = 20 * 60_000;

export function isPublicPushAddress(address: string): boolean {
  return isPublicInternetAddress(address);
}

export type PushLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type PushDestination = SafeOutboundDestination;
const unsafeEndpoint = () => new TypeError("Unsafe push endpoint");

async function resolvePushAddresses(hostname: string, signal: AbortSignal): ReturnType<PushLookup> {
  try {
    return await resolveSafeAddresses(hostname, signal);
  } catch (error) {
    if (error instanceof SafeOutboundError && error.code === "dns_failed") {
      throw Error("Push DNS lookup failed");
    }
    throw error;
  }
}

export async function validatePushEndpoint(
  endpoint: string,
  hosts: ReadonlySet<string>,
  lookup: PushLookup,
): Promise<PushDestination> {
  const url = pushEndpointUrl(endpoint, hosts);
  if (!url) throw unsafeEndpoint();
  try {
    return await resolveSafeOutboundDestination(endpoint, {
      allowedHosts: hosts,
      allowSubdomainPatterns: true,
      lookup: async (hostname) => await lookup(hostname),
    });
  } catch (error) {
    if (
      error instanceof SafeOutboundError &&
      (error.code === "unsafe_url" || error.code === "unsafe_address")
    ) {
      throw unsafeEndpoint();
    }
    throw error;
  }
}

export interface PreparedPushRequest {
  destination: PushDestination;
  headers: Record<string, string>;
  body: Buffer;
}
export type PushTransport = (request: PreparedPushRequest, signal: AbortSignal) => Promise<number>;

/** HTTPS uses the validated address for the connection and the provider hostname for TLS. It never follows redirects. */
export const sendPushRequest: PushTransport = async (prepared, signal) => {
  try {
    return await sendSafeOutboundHttps(
      {
        destination: prepared.destination,
        method: "POST",
        headers: prepared.headers,
        body: prepared.body,
        timeoutMs: SEND_TIMEOUT_MS,
        maxHeaderSize: 8192,
        maxResponseBytes: 8192,
        rejectRedirects: false,
      },
      signal,
    );
  } catch (error) {
    if (error instanceof SafeOutboundError) {
      if (error.code === "response_too_large") throw Error("Push response too large");
      if (error.code === "response_interrupted") throw Error("Push response interrupted");
    }
    throw error;
  }
};

/** RFC 8291 aes128gcm, one record, with RFC 8292 VAPID authentication. */
export function preparePushRequest(
  config: PushConfig,
  subscription: PushSubscriptionRow,
  destination: PushDestination,
  payload: Record<string, unknown>,
  nowMs: number,
  ttlSeconds = PUSH_DELIVERY_TTL_SECONDS,
): PreparedPushRequest {
  const clear = Buffer.from(JSON.stringify(payload));
  if (clear.length > 2048) throw new RangeError("Push payload too large");
  const sender = createECDH("prime256v1");
  sender.generateKeys();
  const receiverKey = Buffer.from(subscription.p256dh, "base64url");
  const senderKey = sender.getPublicKey();
  const shared = sender.computeSecret(receiverKey);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from(subscription.auth, "base64url"),
      Buffer.concat([Buffer.from("WebPush: info\0"), receiverKey, senderKey]),
      32,
    ),
  );
  const salt = randomBytes(16);
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([clear, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = senderKey.length;
  const body = Buffer.concat([header, senderKey, encrypted]);
  const jwtHeader = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const jwtClaims = Buffer.from(
    JSON.stringify({
      aud: destination.url.origin,
      exp: Math.floor(nowMs / 1000) + 3600,
      sub: config.subject,
    }),
  ).toString("base64url");
  const unsigned = `${jwtHeader}.${jwtClaims}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    destination,
    body,
    headers: {
      authorization: `vapid t=${unsigned}.${signature}, k=${config.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      TTL: String(ttlSeconds),
      urgency: "normal",
    },
  };
}

export type ResolvePushAlertLink = (
  message: Pick<PushMessage, "workspaceId" | "threadId" | "messageId">,
  recipientUserId: string,
) => string | null;
export const noPushAlertLink: ResolvePushAlertLink = () => null;

function alertLabel(
  { message, access }: { message: PushMessage; access: { place: string } },
  reason: ChatMessageReason,
  accountName: string | null,
  forPhone: boolean,
): string {
  const part = forPhone ? apnsText : (text: string) => text;
  const ownerName = part(pushPlainText(accountName, "Someone"));
  const senderLabel = part(message.senderLabel);
  const place = part(access.place);
  const authorKind = message.authorKind;
  const sender =
    authorKind === "agent" || authorKind === "automation"
      ? `${senderLabel} (${ownerName}'s ${authorKind})`
      : message.authorUserId
        ? ownerName
        : forPhone
          ? `${senderLabel} (via link)`
          : senderLabel;
  // A push names no share, so its words keep no file link.
  return withholdChatFileLinks(
    reason === "mention"
      ? `${sender} mentioned you in ${place}`
      : reason === "dm"
        ? `${sender} sent you a message`
        : `${sender} replied in ${place}`,
    () => false,
  );
}

export function createPushSender(options: {
  storage: StorageContext;
  config: PushConfig | undefined;
  apns?: ApnsClient | undefined;
  sessionIsValid(
    session: { userId: string; sessionId: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  lookupAccountName(userId: string, signal: AbortSignal): Promise<string | null> | string | null;
  resolveAlertLink?: ResolvePushAlertLink;
  lookup?: PushLookup;
  transport?: PushTransport;
  now?: () => number;
  onError?: () => void;
  onApnsRefused?: () => void;
}) {
  const { storage, config, apns } = options;
  const now = options.now ?? Date.now;
  const enabled = Boolean(config || apns);
  let closed = false;
  let started = false;
  let pausedUntilMs = 0;
  const inflight = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unobserve: (() => void) | undefined;
  const drop = (delivery: PushDelivery) => finishPushDelivery(storage, delivery, "dropped", now());

  const current = (delivery: PushDelivery) => {
    if (delivery.installationId === null) return null;
    const subscription = readPushSubscription(storage, delivery.installationId);
    const message = readPushMessage(storage, delivery.relaySeq);
    if (
      !subscription ||
      !message ||
      subscription.userId !== delivery.userId ||
      subscription.generation !== delivery.generation ||
      subscription.expiresAtMs <= now() ||
      subscription.vapidKeyId !== config?.keyId ||
      !readPushLease(storage, delivery, now())
    )
      return null;
    const access = pushMessageAccess(storage, message, delivery.userId);
    return access ? { subscription, message, access } : null;
  };

  const currentNative = (delivery: PushDelivery, client: ApnsClient) => {
    const nowMs = now();
    const binding = readLivePushDevice(storage, delivery.generation, nowMs);
    const message = readPushMessage(storage, delivery.relaySeq);
    const lease = readPushLease(storage, delivery, nowMs);
    if (
      !binding ||
      !message ||
      !lease ||
      binding.userId !== delivery.userId ||
      binding.topic !== client.config.topic ||
      !client.config.environments.has(binding.environment) ||
      !phoneCanShow(storage, delivery.userId, message.workspaceId, message.threadId)
    )
      return null;
    const { noticeId } = lease;
    const agentAlertWithdrawn =
      (delivery.reason === "agent" || noticeId !== null) &&
      (!isOwnAgentMessage(message, delivery.userId) ||
        (noticeId !== null && !noticeIsListed(storage, delivery.userId, noticeId, nowMs)));
    if (agentAlertWithdrawn) return null;
    const access = pushMessageAccess(storage, message, delivery.userId);
    return access ? { binding, message, access, noticeId } : null;
  };

  const attemptNative = async (
    delivery: PushDelivery,
    client: ApnsClient,
    signal: AbortSignal,
  ): Promise<void> => {
    const before = storage.readTx(() => currentNative(delivery, client));
    if (!before) return drop(delivery);
    const stream = await client.open(before.binding.environment, signal);
    const accountName = before.message.authorUserId
      ? await options.lookupAccountName(before.message.authorUserId, signal)
      : null;
    signal.throwIfAborted();
    const valid = await options.sessionIsValid(before.binding, signal);
    signal.throwIfAborted();
    const fresh = valid ? storage.readTx(() => currentNative(delivery, client)) : null;
    const nowMs = now();
    const expiration = Math.floor(
      Math.min(nowMs + PUSH_DELIVERY_TTL_SECONDS * 1000, delivery.expiresAtMs) / 1000,
    );
    if (
      !fresh ||
      fresh.binding.sessionId !== before.binding.sessionId ||
      expiration <= Math.floor(nowMs / 1000)
    )
      return drop(delivery);
    const { binding, message, noticeId } = fresh;
    const threadKey = createHash("sha256")
      .update(JSON.stringify([binding.generation, message.workspaceId, message.threadId]))
      .digest("base64url")
      .slice(0, 22);
    const response = await stream.send(
      binding.token,
      {
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-topic": client.config.topic,
        "apns-expiration": String(expiration),
        "apns-collapse-id": threadKey,
      },
      apnsPayload({
        title: alertLabel(fresh, delivery.reason, accountName, true),
        body: apnsText(message.body),
        threadKey,
        data: {
          generation: binding.generation,
          workspaceId: message.workspaceId,
          threadId: message.threadId,
          messageId: message.messageId,
          deliveryId: delivery.deliveryId,
          ...(noticeId === null ? {} : { noticeId }),
        },
      }),
      signal,
    );
    if (response.status === 403) {
      if (now() >= pausedUntilMs) options.onApnsRefused?.();
      pausedUntilMs = now() + APNS_PAUSE_MS;
      client.forgetToken();
      return pausePushDelivery(storage, delivery, pausedUntilMs);
    }
    const { status, timestampMs } = response;
    const gone = status === 410 && timestampMs !== null;
    if (gone) removeUnregisteredPushDevice(storage, binding.generation, timestampMs);
    finishPushDelivery(
      storage,
      delivery,
      status === 200
        ? "sent"
        : status === 429 || status >= 500 || (status === 410 && !gone)
          ? "retry"
          : "dropped",
      now(),
    );
  };

  const attempt = async (delivery: PushDelivery): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      if (delivery.installationId === null) {
        await (apns ? attemptNative(delivery, apns, controller.signal) : drop(delivery));
        return true;
      }
      const before = storage.readTx(() => current(delivery));
      if (!config || !before) {
        finishPushDelivery(storage, delivery, "dropped", now());
        return true;
      }
      const destination = await validatePushEndpoint(
        before.subscription.endpoint,
        config.hosts,
        options.lookup ?? ((hostname) => resolvePushAddresses(hostname, controller.signal)),
      );
      controller.signal.throwIfAborted();
      const accountName = before.message.authorUserId
        ? await options.lookupAccountName(before.message.authorUserId, controller.signal)
        : null;
      controller.signal.throwIfAborted();
      const valid = await options.sessionIsValid(before.subscription, controller.signal);
      controller.signal.throwIfAborted();
      if (!valid) {
        finishPushDelivery(storage, delivery, "dropped", now());
        return true;
      }
      const link = (options.resolveAlertLink ?? noPushAlertLink)(before.message, delivery.userId);
      if (!link || !/^\/l\/[A-Za-z0-9_-]{8,200}$/u.test(link)) {
        finishPushDelivery(storage, delivery, "dropped", now());
        return true;
      }
      // The generation fences the account, session, endpoint, and keys after asynchronous reads.
      const fresh = storage.readTx(() => current(delivery));
      if (!fresh) {
        finishPushDelivery(storage, delivery, "dropped", now());
        return true;
      }
      const label = alertLabel(fresh, delivery.reason, accountName, false);
      const prepared = preparePushRequest(
        config,
        fresh.subscription,
        destination,
        {
          label,
          link,
          reason: delivery.reason,
          deliveryId: delivery.deliveryId,
          generation: delivery.generation,
          tag: `dohc-${delivery.deliveryId}`,
        },
        now(),
        Math.max(
          1,
          Math.min(PUSH_DELIVERY_TTL_SECONDS, Math.floor((delivery.expiresAtMs - now()) / 1000)),
        ),
      );
      const status = await (options.transport ?? sendPushRequest)(prepared, controller.signal);
      if (status === 404 || status === 410)
        removePushSubscriptionGeneration(storage, fresh.subscription);
      const outcome =
        status >= 200 && status < 300
          ? "sent"
          : status === 429 || status >= 500
            ? "retry"
            : "dropped";
      finishPushDelivery(storage, delivery, outcome, now());
    } catch (error) {
      // Provider errors can contain endpoint secrets. Report only a fixed message upstream.
      options.onError?.();
      finishPushDelivery(
        storage,
        delivery,
        delivery.installationId !== null && error instanceof TypeError ? "dropped" : "retry",
        now(),
      );
    } finally {
      clearTimeout(timeout);
    }
    return true;
  };
  const nativeFromMs = () => (apns ? pausedUntilMs : Number.MAX_SAFE_INTEGER);
  const claim = () => claimPushDelivery(storage, now(), { native: now() >= nativeFromMs() });
  const track = (delivery: PushDelivery): Promise<unknown> => {
    const run = attempt(delivery)
      .catch(() => options.onError?.())
      .finally(() => {
        inflight.delete(run);
        pump();
      });
    inflight.add(run);
    return run;
  };
  const runOnce = async (): Promise<boolean> => {
    if (closed || !enabled) return false;
    const delivery = claim();
    if (!delivery) return false;
    await track(delivery);
    return true;
  };
  const schedule = (atMs: number | null): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || !started || atMs === null) return;
    timer = setTimeout(pump, Math.max(0, atMs - now()));
    timer.unref();
  };
  function pump(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || !started) return;
    try {
      while (inflight.size < PUSH_STREAMS) {
        const delivery = claim();
        if (!delivery) break;
        void track(delivery);
      }
      if (inflight.size < PUSH_STREAMS)
        schedule(storage.readTx(() => nextPushDeliveryAt(storage, now(), nativeFromMs())));
    } catch {
      options.onError?.();
    }
  }
  return {
    runOnce,
    start() {
      if (started || closed || !enabled) return;
      started = true;
      unobserve = observeRelayWrites(storage, () => {
        if (!closed) schedule(now());
      });
      pump();
    },
    async close() {
      closed = true;
      unobserve?.();
      if (timer) clearTimeout(timer);
      await Promise.all(inflight);
      await apns?.close();
    },
  };
}
