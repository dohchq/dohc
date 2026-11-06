import { createCipheriv, createECDH, hkdfSync, randomBytes, sign } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { pushMessageAccess, pushPlainText, readPushMessage, type PushMessage } from "./chatMessageInterest";
import type { PushConfig } from "./pushConfig";
import { pushEndpointUrl } from "./pushEndpoints";
import { observeRelayWrites } from "./relayWriteChanges";
import type { StorageContext } from "./storage/context";
import { claimPushDelivery, configurePushDeliveries, finishPushDelivery, nextPushDeliveryAt, ownsPushLease, type PushDelivery } from "./storage/pushDeliveries";
import { readPushSubscription, removePushSubscriptionGeneration, type PushSubscriptionRow } from "./storage/pushSubscriptions";

const SEND_TIMEOUT_MS = 10_000;
export const PUSH_DELIVERY_TTL_SECONDS = 60;
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export function isPublicPushAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export type PushLookup = (hostname: string) => Promise<Array<{address: string; family: number}>>;
export interface PushDestination {
  url: URL;
  address: string;
  family: 4 | 6;
}
const unsafeEndpoint = () => new TypeError("Unsafe push endpoint");

async function resolvePushAddresses(hostname: string, signal: AbortSignal): ReturnType<PushLookup> {
  signal.throwIfAborted();
  const resolver = new Resolver({timeout: 2000, tries: 1});
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, {once: true});
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    const addresses: Array<{address: string; family: number}> = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        addresses.push(...result.value.map(address => ({address, family: index === 0 ? 4 : 6})));
      } else if (!["ENODATA", "ENOTFOUND"].includes(String((result.reason as NodeJS.ErrnoException)?.code))) {
        throw Error("Push DNS lookup failed");
      }
    }
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function validatePushEndpoint(endpoint: string, hosts: ReadonlySet<string>, lookup: PushLookup): Promise<PushDestination> {
  const url = pushEndpointUrl(endpoint, hosts);
  if (!url) throw unsafeEndpoint();
  const addresses = await lookup(url.hostname);
  if (!addresses.length || addresses.some(row => !isPublicPushAddress(row.address) || isIP(row.address) !== row.family)) throw unsafeEndpoint();
  const address = addresses[0]!;
  return {url, address: address.address, family: address.family as 4 | 6};
}

export interface PreparedPushRequest {
  destination: PushDestination;
  headers: Record<string, string>;
  body: Buffer;
}
export type PushTransport = (request: PreparedPushRequest, signal: AbortSignal) => Promise<number>;

/** HTTPS uses the validated address for the connection and the provider hostname for TLS. It never follows redirects. */
export const sendPushRequest: PushTransport = (prepared, signal) => new Promise((resolve, reject) => {
  const {destination, body, headers} = prepared;
  let completedStatus: number | undefined;
  let failure: Error | undefined;
  const request = httpsRequest(destination.url, {method: "POST", headers, signal, agent: false,
    lookup: (_hostname, options, callback) => {
      // The address cannot be looked up again between the policy check and connect.
      if (options.all) callback(null, [{address: destination.address, family: destination.family}]);
      else callback(null, destination.address, destination.family);
    }, maxHeaderSize: 8192}, response => {
    const status = response.statusCode ?? 0;
    response.on("error", error => {
      failure ??= error;
      request.destroy(error);
    });
    response.on("aborted", () => request.destroy(Error("Push response interrupted")));
    let received = 0;
    response.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > 8192) request.destroy(Error("Push response too large"));
    });
    response.on("end", () => {completedStatus = status;});
  });
  request.on("error", error => {failure ??= error;});
  request.on("close", () => {
    if (failure) reject(failure);
    else if (completedStatus === undefined) reject(Error("Push response interrupted"));
    else resolve(completedStatus);
  });
  request.end(body);
});

/** RFC 8291 aes128gcm, one record, with RFC 8292 VAPID authentication. */
export function preparePushRequest(config: PushConfig, subscription: PushSubscriptionRow, destination: PushDestination,
  payload: Record<string, unknown>, nowMs: number, ttlSeconds = PUSH_DELIVERY_TTL_SECONDS): PreparedPushRequest {
  const clear = Buffer.from(JSON.stringify(payload));
  if (clear.length > 2048) throw new RangeError("Push payload too large");
  const sender = createECDH("prime256v1");
  sender.generateKeys();
  const receiverKey = Buffer.from(subscription.p256dh, "base64url");
  const senderKey = sender.getPublicKey();
  const shared = sender.computeSecret(receiverKey);
  const ikm = Buffer.from(hkdfSync("sha256", shared, Buffer.from(subscription.auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), receiverKey, senderKey]), 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([clear, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = senderKey.length;
  const body = Buffer.concat([header, senderKey, encrypted]);
  const jwtHeader = Buffer.from(JSON.stringify({typ: "JWT", alg: "ES256"})).toString("base64url");
  const jwtClaims = Buffer.from(JSON.stringify({aud: destination.url.origin, exp: Math.floor(nowMs / 1000) + 3600, sub: config.subject})).toString("base64url");
  const unsigned = `${jwtHeader}.${jwtClaims}`;
  const signature = sign("sha256", Buffer.from(unsigned), {key: config.privateKey, dsaEncoding: "ieee-p1363"}).toString("base64url");
  return {destination, body, headers: {authorization: `vapid t=${unsigned}.${signature}, k=${config.publicKey}`,
    "content-encoding": "aes128gcm", "content-type": "application/octet-stream", "content-length": String(body.length),
    TTL: String(ttlSeconds), urgency: "normal"}};
}

export type ResolvePushAlertLink = (message: Pick<PushMessage, "workspaceId" | "threadId" | "messageId">, recipientUserId: string) => string | null;
export const noPushAlertLink: ResolvePushAlertLink = () => null;

export function createPushSender(options: {
  storage: StorageContext;
  config: PushConfig | undefined;
  sessionIsValid(session: {userId: string; sessionId: string}, signal: AbortSignal): Promise<boolean>;
  lookupAccountName(userId: string, signal: AbortSignal): Promise<string | null> | string | null;
  resolveAlertLink?: ResolvePushAlertLink;
  lookup?: PushLookup;
  transport?: PushTransport;
  now?: () => number;
  onError?: () => void;
}) {
  const {storage, config} = options;
  configurePushDeliveries(storage, config !== undefined);
  const now = options.now ?? Date.now;
  let closed = false;
  let started = false;
  let active: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unobserve: (() => void) | undefined;
  const current = (delivery: PushDelivery) => {
    const subscription = readPushSubscription(storage, delivery.installationId);
    const message = readPushMessage(storage, delivery.relaySeq);
    if (!subscription || !message || subscription.userId !== delivery.userId || subscription.generation !== delivery.generation ||
      subscription.expiresAtMs <= now() || subscription.vapidKeyId !== config?.keyId || !ownsPushLease(storage, delivery, now())) return null;
    const access = pushMessageAccess(storage, message, delivery.userId);
    return access ? {subscription, message, access} : null;
  };
  const attempt = async (): Promise<boolean> => {
    if (!config || closed) return false;
    const delivery = claimPushDelivery(storage, now());
    if (!delivery) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const before = storage.readTx(() => current(delivery));
      if (!before) {
        finishPushDelivery(storage, delivery, "dropped", now());
        return true;
      }
      const destination = await validatePushEndpoint(before.subscription.endpoint, config.hosts,
        options.lookup ?? (hostname => resolvePushAddresses(hostname, controller.signal)));
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
      const ownerName = pushPlainText(accountName, "Someone");
      const authorKind = fresh.message.authorKind;
      const sender = authorKind === "agent" || authorKind === "automation"
        ? `${fresh.message.senderLabel} (${ownerName}'s ${authorKind})`
        : fresh.message.authorUserId ? ownerName : fresh.message.senderLabel;
      const place = fresh.access.place;
      const label = delivery.reason === "mention" ? `${sender} mentioned you in ${place}` :
        delivery.reason === "dm" ? `${sender} sent you a message` : `${sender} replied in ${place}`;
      const prepared = preparePushRequest(config, fresh.subscription, destination, {
        label, link, reason: delivery.reason, deliveryId: delivery.deliveryId, generation: delivery.generation, tag: `dohc-${delivery.deliveryId}`,
      }, now(), Math.max(1, Math.min(PUSH_DELIVERY_TTL_SECONDS, Math.floor((delivery.expiresAtMs - now()) / 1000))));
      const status = await (options.transport ?? sendPushRequest)(prepared, controller.signal);
      if (status === 404 || status === 410) removePushSubscriptionGeneration(storage, delivery);
      const outcome = status >= 200 && status < 300 ? "sent" : status === 429 || status >= 500 ? "retry" : "dropped";
      finishPushDelivery(storage, delivery, outcome, now());
    } catch (error) {
      // Provider errors can contain endpoint secrets. Report only a fixed message upstream.
      options.onError?.();
      finishPushDelivery(storage, delivery, error instanceof TypeError ? "dropped" : "retry", now());
    } finally {
      clearTimeout(timeout);
    }
    return true;
  };
  const runOnce = (): Promise<boolean> => {
    if (closed || !config) return Promise.resolve(false);
    if (!active) active = attempt().finally(() => {active = undefined;});
    return active;
  };
  const schedule = (atMs: number | null): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || !started || atMs === null) return;
    timer = setTimeout(tick, Math.max(0, atMs - now()));
    timer.unref();
  };
  const tick = (): void => {
    timer = undefined;
    if (closed || !config) return;
    void runOnce().catch(() => {
      options.onError?.();
      return false;
    }).then(() => {
      if (!closed) schedule(storage.readTx(() => nextPushDeliveryAt(storage, now())));
    });
  };
  return {
    runOnce,
    start() {
      if (started || closed || !config) return;
      started = true;
      unobserve = observeRelayWrites(storage, () => {
        if (closed || active) return;
        schedule(now());
      });
      tick();
    },
    async close() {
      closed = true;
      unobserve?.();
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
