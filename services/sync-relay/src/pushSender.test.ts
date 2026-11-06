import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { readPushConfig } from "./pushConfig";
import { DEFAULT_PUSH_HOSTS } from "./pushEndpoints";
import { createPushSender as createSender, preparePushRequest, sendPushRequest, validatePushEndpoint, isPublicPushAddress, type PushTransport } from "./pushSender";
import { observeRelayWrites } from "./relayWriteChanges";
import { appendLogBatchInTransaction } from "./storage/log";
import { claimPushDelivery, finishPushDelivery, nextPushDeliveryAt, PUSH_DELIVERY_ATTEMPTS, PUSH_DELIVERY_EXPIRY_MS, PUSH_DELIVERY_LEASE_MS,
  PUSH_RECIPIENT_PENDING_LIMIT, PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE } from "./storage/pushDeliveries";
import type { StorageContext } from "./storage/context";
import { chatChannelCreate, chatThreadCreate, chatMessageAppend, sequenced, testStorage, closeTestStorages,
  closeTestStorage, reopenTestStorage, storagePath, testHandler, request, jsonBody, json,
  linkRequest, linkSecret, resolveTestActor, inspectDatabase, moment, putBlob, seedLinkGrant, seedDependentGrant,
  RELAY_EXCHANGE_KEY, SHARE_WEB_ORIGIN } from "./testing";

type TestHttpsOptions = {agent: boolean; signal: AbortSignal; maxHeaderSize: number;
  lookup(host: string, options: {all: boolean}, callback: (...args: unknown[]) => void): void};
const {httpsRequestMock} = vi.hoisted(() => ({httpsRequestMock: vi.fn<
  (url: URL, options: TestHttpsOptions, callback: (response: EventEmitter) => void) => EventEmitter
>(() => {throw Error("A real push service must never be contacted");})}));
vi.mock("node:https", () => ({request: httpsRequestMock}));

const vapid = createECDH("prime256v1"); vapid.generateKeys();
const browser = createECDH("prime256v1"); browser.generateKeys();
const auth = Buffer.alloc(16, 7);
const config = readPushConfig({DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"),
  DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()]).subarray(-32).toString("base64url"),
  DOHC_RELAY_PUSH_VAPID_SUBJECT: "mailto:push@example.test", DOHC_RELAY_PUSH_HOSTS: "push.example.test"})!;
const workspaceId = "workspace", threadId = "thread", channelWireId = "team", shareId = "share";
const installationId = "installation-000000001";
const publicAddress = {address: "8.8.8.8", family: 4};
const lookup = vi.fn(async () => [publicAddress]);
const rows = (s: StorageContext) => s.db.prepare("SELECT * FROM sync_relay_push_deliveries ORDER BY rowid").all();
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};
const createPushSender = (options: Omit<Parameters<typeof createSender>[0], "lookupAccountName"> &
  Partial<Pick<Parameters<typeof createSender>[0], "lookupAccountName">>) => createSender({
    lookupAccountName: userId => userId === "owner" ? "Owner" : "Alice",
    ...options,
  });

function decryptedPayload(body: Buffer): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const serverKey = body.subarray(21, 21 + body[20]!);
  const shared = browser.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const encrypted = body.subarray(21 + serverKey.length);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const clear = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  expect(clear.at(-1)).toBe(2);
  return JSON.parse(clear.subarray(0, -1).toString()) as Record<string, unknown>;
}

async function fixture(kind: "channel" | "dm" = "channel", pushConfigured = true) {
  const storage = await testStorage({pushConfigured}) as StorageContext;
  storage.claimWorkspace({workspaceId, ownerUserId: "owner", createdAtMs: 1});
  const append = (ops: ReturnType<typeof chatMessageAppend>[], originId = "owner") => storage.appendLogBatch({workspaceId, originId,
    ops: sequenced(ops, storage.maxOriginSeq(workspaceId, originId) + 1).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
  append([chatChannelCreate(channelWireId, {kind, name: "Team", ...(kind === "channel" ? {type: "both", folderPath: "team"} : {})}), chatThreadCreate(threadId, channelWireId)]);
  storage.createShare({share: {shareId, workspaceId, granterUserId: "owner", createdAtMs: 1,
    selectorJson: JSON.stringify({kind: "chat", channelWireId}), labels: {subjectName: "Team"}},
    grant: {grantId: "grant", shareId, principalKind: "user", principalUserId: "alice", principalEmail: null,
      access: "read-write", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}});
  const bind = (changes: Record<string, unknown> = {}) => storage.bindPushSubscription({installationId, userId: "alice", sessionId: "session-alice",
    sessionExpiresAtMs: Date.now() + 1_000_000, endpoint: "https://push.example.test/send/device", p256dh: browser.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"), vapidKeyId: config.keyId, browserExpiresAtMs: null, nowMs: Date.now(), accountName: "Alice", ...changes});
  bind();
  return {storage, append, bind, message(body = "@Alice secret text", id = "message") {
    append([chatMessageAppend(id, threadId, body, {authorUserId: "owner", authorDisplayName: "Owner"})]);
  }};
}

async function fileChatFixture(recipientUserId = "alice") {
  const f = await fixture();
  await putBlob(testHandler(f.storage), "owner", workspaceId, "plan");
  f.storage.createShare({
    share: {shareId: "file-share", workspaceId, granterUserId: "owner", createdAtMs: 1,
      selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), labels: {subjectName: "Docs"}},
    grant: {grantId: "file-grant", shareId: "file-share", principalKind: "user", principalUserId: recipientUserId, principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null},
  });
  f.append([
    moment("docs/plan.md", "plan", {objectId: "plan"}),
    chatThreadCreate("file-thread", "", {channelWireId: null, channelSlug: null, linkedObjectId: "plan", linkedAtMs: 2}),
  ]);
  return {...f, message() {
    f.append([chatMessageAppend("file-message", "file-thread", "@Alice", {authorUserId: "owner"})]);
  }};
}

afterEach(async () => {vi.useRealTimers(); vi.restoreAllMocks(); lookup.mockClear(); httpsRequestMock.mockReset(); await closeTestStorages();});

it.each(["desktop", "agent", "named", "browser"])("records deliveries for %s ingress after authenticated admission", async ingress => {
  const f = await fixture();
  f.bind({installationId: "installation-000000002", userId: "owner", sessionId: "session-owner", accountName: "Owner",
    endpoint: "https://push.example.test/send/owner"});
  const handler = testHandler(f.storage, {relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: {maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 8, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 1000},
    lookupUserDisplayName: id => id === "alice" ? "Alice" : "Owner",
    resolveActor: (incoming, workspace) => incoming.headers.get("cookie") === "session=alice" ? {userId: "alice", workspaceId: workspace} : resolveTestActor(incoming, workspace)});
  let response: Response;
  if (ingress === "browser") {
    response = await handler(new Request("http://relay.test/sync/named-chat/messages", {method: "POST",
      headers: {cookie: "session=alice", origin: SHARE_WEB_ORIGIN, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, "content-type": "application/json"},
      body: JSON.stringify({shareId, channelWireId, threadId, id: "browser-post", body: "@Owner", authorKind: "human"})}));
  } else {
    const named = ingress === "named", author = named ? "alice" : "owner";
    const ops = sequenced([chatMessageAppend("ingress", threadId, named ? "@Owner" : "@Alice", {
      authorUserId: author, ...(ingress === "agent" ? {authorKind: "agent", authorDisplayName: "Planner", authorOwnerDisplayName: "Owner"} : {}),
    })]);
    response = await handler(request(author, named ? `/sync/shares/${shareId}/log` : `/sync/${workspaceId}/log`, jsonBody({originId: `ingress-${ingress}`, ops})));
  }
  expect(response.status, await response.clone().text()).toBe(200);
  expect(rows(f.storage)).toHaveLength(1);
  expect(rows(f.storage)[0]!.account_user_id).toBe(ingress === "named" || ingress === "browser" ? "owner" : "alice");
});

it("records a link-authored message and deduplicates its retry", async () => {
  const f = await fixture();
  const handler = testHandler(f.storage, {publicEditRelease: {version: 1}, relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: {maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 8, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 1000}});
  const shared = await handler(request("owner", `/sync/${workspaceId}/shares`, jsonBody({recipientUserId: "alice",
    channelWireId, paths: ["team"], access: "read-write", subjectName: "Team"})));
  expect(shared.status, await shared.clone().text()).toBe(200);
  const groupId = String((await json(shared)).shareId);
  const created = await handler(request("owner", `/sync/${workspaceId}/shares/${groupId}/links`, jsonBody({access: "read-write"})));
  expect(created.status, await created.clone().text()).toBe(200);
  const link = await json(created);
  const exchanged = await handler(request(null, "/sync/link-exchange", {method: "POST",
    headers: {"content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY}, body: JSON.stringify({secret: linkSecret(link.url)})}));
  expect(exchanged.status).toBe(200);
  const capability = String((await json(exchanged)).capabilityToken);
  const post = () => handler(linkRequest(capability, "/sync/link/chat/messages", {method: "POST",
    headers: {"content-type": "application/json", "x-dohc-link-profile-secret": "p".repeat(43)},
    body: JSON.stringify({channelWireId, threadId, body: "@Alice", claimedName: "Sam", idempotencyKey: "link-post"})}));
  expect((await post()).status).toBe(200); expect((await post()).status).toBe(200);
  expect(rows(f.storage)).toHaveLength(1);
  expect(rows(f.storage)[0]!.account_user_id).toBe("alice");
});

it("records one delivery for overlapping mention, DM, and prior participation; replay cannot add another", async () => {
  const f = await fixture("dm");
  f.append([chatMessageAppend("prior", threadId, "hello", {authorUserId: "alice", authorDisplayName: "Alice"})], "alice");
  expect(rows(f.storage)).toHaveLength(0);
  f.message();
  expect(rows(f.storage)).toHaveLength(1);
  expect(rows(f.storage)[0]!.reason).toBe("mention");
  f.message("@Alice secret text");
  expect(rows(f.storage)).toHaveLength(1);
  f.bind({sessionId: "replacement-session"});
  f.append([chatMessageAppend("message", threadId, "@Alice", {authorUserId: "owner"})], "another-origin");
  expect(rows(f.storage)).toHaveLength(1);
  const original = f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 0, limit: 100}).rows.filter(r => r.originId === "owner");
  f.storage.appendLogBatch({workspaceId, originId: "owner", ops: original});
  expect(rows(f.storage)).toHaveLength(1);
});

it("selects a later thread reply, ignores code mentions, self posts, unrelated chats, and supplied recipient lists", async () => {
  const f = await fixture();
  f.append([chatMessageAppend("listed", threadId, "hello", {authorUserId: "owner", recipients: ["alice"]})]);
  f.message("`@Alice` recipients: alice", "code");
  expect(rows(f.storage)).toHaveLength(0);
  f.append([chatMessageAppend("mine", threadId, "@Alice", {authorUserId: "alice"})], "alice");
  expect(rows(f.storage)).toHaveLength(0);
  f.message("reply without a mention", "reply");
  expect(rows(f.storage).map(r => r.reason)).toEqual(["reply"]);
  f.append([chatChannelCreate("private"), chatThreadCreate("private-thread", "private"),
    chatMessageAppend("private-message", "private-thread", "@Alice", {authorUserId: "owner", recipients: ["alice"]})]);
  expect(rows(f.storage)).toHaveLength(1);
});

it("rolls deliveries back with the append transaction", async () => {
  const f = await fixture();
  expect(() => f.storage.tx(() => {
    appendLogBatchInTransaction(f.storage, {workspaceId, originId: "rollback", ops: sequenced([
      chatMessageAppend("message", threadId, "@Alice", {authorUserId: "owner"}),
    ]).map(({payload, ...op}) => ({...op, payloadJson: JSON.stringify(payload)}))});
    throw Error("rollback");
  })).toThrow("rollback");
  expect(rows(f.storage)).toHaveLength(0);
  f.message();
  expect(rows(f.storage)).toHaveLength(1);
});

it("recovers expired leases after reopening, fences old workers, and stops at the retry limit", async () => {
  const f = await fixture(); f.message();
  const now = Date.now(), first = claimPushDelivery(f.storage, now)!;
  expect(first).not.toBeNull();
  expect(claimPushDelivery(f.storage, now)).toBeNull();
  const path = storagePath(f.storage); closeTestStorage(f.storage);
  const reopened = reopenTestStorage(path) as StorageContext;
  const recovered = claimPushDelivery(reopened, now + PUSH_DELIVERY_LEASE_MS + 1)!;
  expect(recovered.leaseToken).not.toBe(first.leaseToken);
  finishPushDelivery(reopened, first, "sent", now);
  expect(rows(reopened)[0]!.state).toBe("pending");
  finishPushDelivery(reopened, recovered, "retry", now);
  for (let n = 2; n < PUSH_DELIVERY_ATTEMPTS; n++) {
    const delivery = claimPushDelivery(reopened, now + n * 60_000)!;
    expect(delivery).not.toBeNull(); finishPushDelivery(reopened, delivery, "retry", now + n * 60_000);
  }
  expect(rows(reopened)[0]!.state).toBe("dropped");
  expect(claimPushDelivery(reopened, now + 400_000)).toBeNull();
});

it.each(["revoked", "session", "generation", "account", "message", "expired"])("drops %s work before transport", async reason => {
  const f = await fixture(); f.message();
  if (reason === "revoked") f.storage.revokeShare(shareId, Date.now());
  if (reason === "generation") f.bind({sessionId: "new-session"});
  if (reason === "account") f.bind({userId: "bob", sessionId: "session-bob"});
  if (reason === "expired") f.storage.replicaViewTx(() => f.storage.db.prepare(
    "UPDATE sync_relay_push_subscriptions SET expires_at_ms = ?").run(Date.now() + 1000));
  if (reason === "message") f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_log WHERE op_kind='chat.message.append'").run());
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => reason !== "session", now: () => Date.now() + (reason === "expired" ? 2000 : 0),
    resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce(); await sender.close();
  expect(transport).not.toHaveBeenCalled();
  expect(rows(f.storage)[0]!.state).toBe("dropped");
});

it.each(["access", "generation"])("rechecks %s after asynchronous DNS and session reads", async change => {
  const f = await fixture(); f.message();
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => {
      if (change === "access") f.storage.revokeShare(shareId, Date.now());
      else f.bind({userId: "bob", sessionId: "session-bob"});
      return true;
    },
    resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce(); await sender.close();
  expect(transport).not.toHaveBeenCalled();
});

it("selects an incoming DM without a mention or earlier participation", async () => {
  const f = await fixture("dm"); f.message("hello");
  expect(rows(f.storage).map(row => row.reason)).toEqual(["dm"]);
});

it("rechecks access after the link resolver returns", async () => {
  const f = await fixture(); f.message(); const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport, sessionIsValid: async () => true,
    resolveAlertLink: () => {f.storage.revokeShare(shareId, Date.now()); return "/l/opaque-reference";}});
  await sender.runOnce(); await sender.close(); expect(transport).not.toHaveBeenCalled();
});

it("encrypts only the bounded label, reference, reason, stable tag, delivery id, and generation; signs VAPID", async () => {
  const f = await fixture(); f.message();
  const seen: Array<Record<string, unknown>> = [];
  const transport: PushTransport = async prepared => {
    const authorization = /^vapid t=([^,]+), k=(.+)$/u.exec(prepared.headers.authorization!)!;
    expect(authorization[2]).toBe(config.publicKey);
    const [header, claims, signature] = authorization[1]!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({typ: "JWT", alg: "ES256"});
    const point = Buffer.from(config.publicKey, "base64url");
    const key = createPublicKey({format: "jwk", key: {kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url")}});
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), {key, dsaEncoding: "ieee-p1363"}, Buffer.from(signature!, "base64url"))).toBe(true);
    const claim = JSON.parse(Buffer.from(claims!, "base64url").toString()) as {aud: string; sub: string; exp: number};
    expect(claim).toMatchObject({aud: "https://push.example.test", sub: config.subject});
    expect(claim.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claim.exp).toBeLessThan(Date.now() / 1000 + 24 * 60 * 60);
    expect(prepared.headers.TTL).toBe("60");
    const body = prepared.body, salt = body.subarray(0, 16), serverKey = body.subarray(21, 21 + body[20]!);
    const shared = browser.computeSecret(serverKey);
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), serverKey]);
    const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const encrypted = body.subarray(21 + serverKey.length), decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(encrypted.subarray(-16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    expect(clear.at(-1)).toBe(2);
    const payload = JSON.parse(clear.subarray(0, -1).toString()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["deliveryId", "generation", "label", "link", "reason", "tag"]);
    expect(payload.label).toBe("Owner mentioned you in Team");
    expect(payload.link).toBe("/l/opaque-reference");
    expect(JSON.stringify(payload)).not.toContain("secret text");
    seen.push(payload); return seen.length === 1 ? 503 : 201;
  };
  let now = Date.now();
  const sender = createPushSender({storage: f.storage, config, lookup, transport, sessionIsValid: async () => true,
    resolveAlertLink: () => "/l/opaque-reference", now: () => now});
  await sender.runOnce(); now += 60_000; await sender.runOnce(); await sender.close();
  expect(seen).toHaveLength(2); expect(seen[0]).toEqual(seen[1]);
  expect(rows(f.storage)[0]!.state).toBe("sent");
});

it("stays unavailable without configuration and names missing values in partial configuration", () => {
  expect(readPushConfig({})).toBeUndefined();
  expect(() => readPushConfig({DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY: config.publicKey})).toThrow(
    "Missing push configuration: DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY, DOHC_RELAY_PUSH_VAPID_SUBJECT.");
  expect(() => readPushConfig({DOHC_RELAY_PUSH_HOSTS: "push.example.test"})).toThrow("DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY");
  const other = createECDH("prime256v1"); other.generateKeys();
  expect(() => readPushConfig({DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY: config.publicKey,
    DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY: other.getPrivateKey().toString("base64url"),
    DOHC_RELAY_PUSH_VAPID_SUBJECT: config.subject})).toThrow();
});

it.each(["http://push.example.test/a", "https://127.0.0.1/a", "https://[::1]/a", "https://2130706433/a",
  "https://push.example.test.evil/a", "https://user:secret@push.example.test/a", "https://push.example.test:444/a",
  "https://push.example.test/a#secret"])("refuses endpoint %s", async endpoint => {
  await expect(validatePushEndpoint(endpoint, config.hosts, lookup)).rejects.toThrow("Unsafe push endpoint");
});

it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
  "224.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::"])("refuses destination %s", async address => {
  expect(isPublicPushAddress(address)).toBe(false);
  await expect(validatePushEndpoint("https://push.example.test/a", config.hosts, async () => [publicAddress, {address, family: address.includes(":") ? 6 : 4}])).rejects.toThrow();
});

it.each([301, 302, 307, 308, 404, 410])("does not follow or retry terminal response %s", async status => {
  const f = await fixture(); f.message(); const transport = vi.fn<PushTransport>(async () => status);
  const sender = createPushSender({storage: f.storage, config, lookup, transport, sessionIsValid: async () => true,
    resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce(); await sender.runOnce(); await sender.close();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(rows(f.storage)[0]!.state).toBe("dropped");
  if (status === 404 || status === 410) expect(f.storage.readPushSubscription(installationId)).toBeNull();
});

it("waits for an in-flight send on shutdown and leaves other work durable", async () => {
  const f = await fixture(); f.message(); f.message("@Alice", "second");
  const entered = deferred(), release = deferred();
  const sender = createPushSender({storage: f.storage, config, lookup, sessionIsValid: async () => true,
    resolveAlertLink: () => "/l/opaque-reference", transport: async () => {entered.resolve(); await release.promise; return 201;}});
  const run = sender.runOnce(); await entered.promise;
  let closed = false; const close = sender.close().then(() => {closed = true;});
  await Promise.resolve(); expect(closed).toBe(false);
  release.resolve(); await run; await close;
  expect(rows(f.storage).map(r => r.state)).toEqual(["sent", "pending"]);
  expect(await sender.runOnce()).toBe(false);
});

it("does not disclose labels when the link resolver has no reference", async () => {
  const f = await fixture(); f.message(); const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport, sessionIsValid: async () => true});
  await sender.runOnce(); await sender.close(); expect(transport).not.toHaveBeenCalled();
});

it("bounds recipient backlog and persists the attempt rate across retries", async () => {
  const f = await fixture();
  for (let n = 0; n < PUSH_RECIPIENT_PENDING_LIMIT + 2; n++) f.message("@Alice", `message-${n}`);
  expect(rows(f.storage)).toHaveLength(PUSH_RECIPIENT_PENDING_LIMIT);
  const now = Date.now();
  for (let n = 0; n < PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE; n++) {
    const claimed = claimPushDelivery(f.storage, now)!;
    expect(claimed).not.toBeNull(); finishPushDelivery(f.storage, claimed, "sent", now);
  }
  expect(claimPushDelivery(f.storage, now)).toBeNull();
  expect(claimPushDelivery(f.storage, now + 60_000)).not.toBeNull();
});

it.each([404, 410])("does not invalidate a same-account replacement after an old send returns %s", async status => {
  const f = await fixture(); f.message();
  const sender = createPushSender({storage: f.storage, config, lookup, sessionIsValid: async () => true,
    resolveAlertLink: () => "/l/opaque-reference", transport: async () => {f.bind({sessionId: "new-session"}); return status;}});
  await sender.runOnce(); await sender.close();
  expect(f.storage.readPushSubscription(installationId)).toMatchObject({userId: "alice", sessionId: "new-session", generation: 2});
});

it("keeps retries durable through transport errors and rechecks access on the next attempt", async () => {
  const f = await fixture(); f.message(); let now = Date.now();
  const transport = vi.fn<PushTransport>(async () => {throw Error("provider error with secret endpoint");});
  const report = vi.fn();
  const sender = createPushSender({storage: f.storage, config, lookup, transport, onError: report,
    sessionIsValid: async () => true, now: () => now, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce(); expect(rows(f.storage)[0]!.state).toBe("pending");
  expect(report.mock.calls).toEqual([[]]);
  f.storage.revokeShare(shareId, now); now += 60_000;
  await sender.runOnce(); await sender.close();
  expect(transport).toHaveBeenCalledTimes(1); expect(rows(f.storage)[0]!.state).toBe("dropped");
});

it("does not claim work when sender configuration is absent", async () => {
  const f = await fixture(); f.message(); const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config: undefined, transport, sessionIsValid: async () => true});
  sender.start(); expect(await sender.runOnce()).toBe(false); await sender.close();
  expect(transport).not.toHaveBeenCalled(); expect(rows(f.storage)[0]!.attempts).toBe(0);
});

it("pins HTTPS to the validated destination, bounds the response, and returns a redirect without following it", async () => {
  const f = await fixture();
  const destination = await validatePushEndpoint("https://push.example.test/send/device", config.hosts, lookup);
  const prepared = preparePushRequest(config, f.bind(), destination, {label: "An alert"}, Date.now());
  const controller = new AbortController();
  let responseBytes = 0;
  let closeRequest = () => {};
  httpsRequestMock.mockImplementation((_url, options, callback) => {
    expect(options.agent).toBe(false);
    expect(options.signal).toBe(controller.signal);
    expect(options.maxHeaderSize).toBe(8192);
    const connected = vi.fn();
    options.lookup("push.example.test", {all: false}, connected);
    expect(connected).toHaveBeenLastCalledWith(null, publicAddress.address, 4);
    options.lookup("push.example.test", {all: true}, connected);
    expect(connected).toHaveBeenLastCalledWith(null, [publicAddress]);
    const req = new EventEmitter() as EventEmitter & {end(body: Buffer): void; destroy(error: Error): void};
    req.destroy = error => {req.emit("error", error); req.emit("close");};
    req.end = body => {
      expect(body).toEqual(prepared.body);
      const response = Object.assign(new EventEmitter(), {statusCode: 307});
      callback(response);
      if (responseBytes) response.emit("data", Buffer.alloc(responseBytes));
      response.emit("end");
      closeRequest = () => {req.emit("close");};
    };
    return req;
  });
  let settled = false;
  const sent = sendPushRequest(prepared, controller.signal).then(status => {settled = true; return status;});
  await Promise.resolve(); expect(settled).toBe(false);
  closeRequest(); await expect(sent).resolves.toBe(307);
  expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  responseBytes = 8193;
  await expect(sendPushRequest(prepared, controller.signal)).rejects.toThrow("Push response too large");
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("refuses a damaged delivery schema on reopen", async () => {
  const f = await fixture(); const path = storagePath(f.storage); closeTestStorage(f.storage);
  const db = inspectDatabase(path); db.exec("DROP INDEX idx_push_deliveries_due"); db.close();
  expect(() => reopenTestStorage(path)).toThrow("push delivery schema is missing or damaged");
});

it("counts repeated attempts durably within the recipient's minute", async () => {
  const f = await fixture(); f.message();
  const now = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1000;
  const first = claimPushDelivery(f.storage, now)!;
  finishPushDelivery(f.storage, first, "retry", now);
  const retry = claimPushDelivery(f.storage, now + 4000)!;
  expect(retry.deliveryId).toBe(first.deliveryId);
  expect(retry.attempts).toBe(2);
  expect(f.storage.db.prepare("SELECT attempts FROM sync_relay_push_rate WHERE account_user_id = ? AND minute = ?")
    .get("alice", Math.floor(now / 60_000))?.attempts).toBe(2);
});

it("drains newly committed work from the relay write observer", async () => {
  const f = await fixture(); const transport = vi.fn<PushTransport>(async () => 201);
  vi.useFakeTimers();
  const sender = createPushSender({storage: f.storage, config, lookup, transport, sessionIsValid: async () => true,
    resolveAlertLink: () => "/l/opaque-reference"});
  try {
    sender.start();
    await sender.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    f.message();
    await vi.advanceTimersByTimeAsync(0);
    expect(rows(f.storage).map(row => row.state)).toEqual(["sent"]);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {await sender.close();}
});

it("drops an old key binding after sender key rotation without changing its generation", async () => {
  const f = await fixture();
  f.message();
  const replacement = createECDH("prime256v1");
  replacement.generateKeys();
  const rotatedConfig = readPushConfig({
    DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY: replacement.getPublicKey().toString("base64url"),
    DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), replacement.getPrivateKey()]).subarray(-32).toString("base64url"),
    DOHC_RELAY_PUSH_VAPID_SUBJECT: config.subject,
    DOHC_RELAY_PUSH_HOSTS: "push.example.test",
  })!;
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config: rotatedConfig, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  await sender.close();
  expect(f.storage.readPushSubscription(installationId)?.generation).toBe(1);
  expect(rows(f.storage)[0]!.generation).toBe(1);
  expect(rows(f.storage)[0]!.state).toBe("dropped");
  expect(transport).not.toHaveBeenCalled();
});

it("sends one delivery to each device of the same account", async () => {
  const f = await fixture();
  f.bind({installationId: "installation-000000002", endpoint: "https://push.example.test/send/second"});
  f.message();
  expect(rows(f.storage)).toHaveLength(2);
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  await sender.runOnce();
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(transport.mock.calls.map(([prepared]) => prepared.destination.url.pathname).sort())
    .toEqual(["/send/device", "/send/second"]);
  expect(rows(f.storage).map(row => row.state)).toEqual(["sent", "sent"]);
});

it("retries after the send deadline aborts the transport", async () => {
  const f = await fixture();
  f.message();
  vi.useFakeTimers();
  const entered = deferred();
  const transport = vi.fn<PushTransport>(async (_prepared, signal) => {
    entered.resolve();
    return new Promise<number>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  });
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  const sent = sender.runOnce();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  await sent;
  expect(rows(f.storage)[0]).toMatchObject({state: "pending", attempts: 1, lease_token: null});
  transport.mockResolvedValue(201);
  await vi.advanceTimersByTimeAsync(2000);
  await sender.runOnce();
  await sender.close();
  expect(rows(f.storage)[0]).toMatchObject({state: "sent", attempts: 2});
});

it("does not record new deliveries while sending is unconfigured", async () => {
  const f = await fixture("channel", false);
  const sender = createPushSender({storage: f.storage, config: undefined, sessionIsValid: async () => true});
  f.message();
  expect(rows(f.storage)).toEqual([]);
  await sender.close();
});

it("records configured deliveries before the sender is constructed or started", async () => {
  const f = await fixture();
  f.message();
  expect(rows(f.storage)).toEqual([expect.objectContaining({state: "pending", attempts: 0, account_user_id: "alice"})]);
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  await sender.close();
  expect(transport).toHaveBeenCalledOnce();
  expect(rows(f.storage)[0]!.state).toBe("sent");
});

it("claims and finishes durably without notifying relay write observers", async () => {
  const f = await fixture();
  f.message();
  const observer = vi.fn();
  const stop = observeRelayWrites(f.storage, observer);
  const now = Date.now();
  const delivery = claimPushDelivery(f.storage, now)!;
  finishPushDelivery(f.storage, delivery, "retry", now);
  await Promise.resolve();
  stop();
  expect(observer).not.toHaveBeenCalled();
  expect(nextPushDeliveryAt(f.storage, now)).toBe(now + 2000);
  const path = storagePath(f.storage);
  closeTestStorage(f.storage);
  const reopened = reopenTestStorage(path) as StorageContext;
  expect(rows(reopened)[0]).toMatchObject({state: "pending", attempts: 1, available_at_ms: now + 2000});
});

it("uses the same Windows subdomain policy when resolving the send destination", async () => {
  const windowsConfig = readPushConfig({
    DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY: config.publicKey,
    DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()]).subarray(-32).toString("base64url"),
    DOHC_RELAY_PUSH_VAPID_SUBJECT: config.subject,
    DOHC_RELAY_PUSH_HOSTS: ".notify.windows.com",
  })!;
  await expect(validatePushEndpoint("https://wns1.notify.windows.com/send/device", DEFAULT_PUSH_HOSTS, lookup))
    .resolves.toMatchObject({address: publicAddress.address, family: 4});
  await expect(validatePushEndpoint("https://wns2.notify.windows.com/send/device", windowsConfig.hosts, lookup))
    .resolves.toMatchObject({address: publicAddress.address, family: 4});
  await expect(validatePushEndpoint("https://evilnotify.windows.com/send/device", DEFAULT_PUSH_HOSTS, lookup))
    .rejects.toThrow("Unsafe push endpoint");
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("waits for a lease or the recipient rate window before waking again", async () => {
  const f = await fixture();
  f.message();
  const now = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1000;
  const delivery = claimPushDelivery(f.storage, now)!;
  expect(nextPushDeliveryAt(f.storage, now)).toBe(now + PUSH_DELIVERY_LEASE_MS);
  finishPushDelivery(f.storage, delivery, "retry", now);
  f.storage.replicaViewTx(() => f.storage.db.prepare("UPDATE sync_relay_push_rate SET attempts = ?")
    .run(PUSH_RECIPIENT_ATTEMPTS_PER_MINUTE));
  expect(nextPushDeliveryAt(f.storage, now)).toBe((Math.floor(now / 60_000) + 1) * 60_000);
});

it.each([
  {authorKind: "human", authorName: "Claimed name", label: "Kim mentioned you in Team"},
  {authorKind: "agent", authorName: "Claude", label: "Claude (Kim's agent) mentioned you in Team"},
  {authorKind: "automation", authorName: "Weekly digest", label: "Weekly digest (Kim's automation) mentioned you in Team"},
])("uses the server account name for another person's $authorKind", async ({authorKind, authorName, label}) => {
  const f = await fixture();
  f.append([chatMessageAppend("label", threadId, "@Alice", {
    authorUserId: "owner", authorKind, authorDisplayName: authorName, authorOwnerDisplayName: "Claimed owner",
  })]);
  const transport = vi.fn<PushTransport>(async prepared => {
    expect(decryptedPayload(prepared.body).label).toBe(label);
    return 201;
  });
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    lookupAccountName: userId => userId === "owner" ? "Kim" : null,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  await sender.close();
  expect(transport).toHaveBeenCalledOnce();
  expect(rows(f.storage)[0]!.state).toBe("sent");
});

it("never sends an alert for the recipient's own human post", async () => {
  const f = await fixture("dm");
  const handler = testHandler(f.storage);
  const response = await handler(request("alice", `/sync/shares/${shareId}/log`, jsonBody({originId: "alice-device", ops: sequenced([
    chatMessageAppend("self", threadId, "@Alice", {authorUserId: "alice", authorKind: "human"}),
  ])})));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(rows(f.storage)).toEqual([]);
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ["agent", "mention"], ["agent", "dm"], ["agent", "reply"],
  ["automation", "mention"], ["automation", "dm"], ["automation", "reply"],
] as const)("sends one %s alert to its owner for a %s", async (authorKind, reason) => {
  const f = await fixture(reason === "dm" ? "dm" : "channel");
  f.bind({userId: "owner", sessionId: "session-owner", accountName: "Kim"});
  const handler = testHandler(f.storage);
  const post = (messageId: string, body: string, kind: string) => handler(request("owner", `/sync/${workspaceId}/log`, jsonBody({
    originId: "owner-device",
    ops: sequenced([chatMessageAppend(messageId, threadId, body, {
      authorUserId: "owner", authorKind: kind,
      authorDisplayName: kind === "automation" ? "Weekly digest" : "Claude", authorOwnerDisplayName: "Claimed owner",
    })], f.storage.maxOriginSeq(workspaceId, "owner-device") + 1),
  })));
  if (reason === "reply") {
    const prior = await post("prior", "hello", "human");
    expect(prior.status, await prior.clone().text()).toBe(200);
    expect(rows(f.storage)).toEqual([]);
  }
  const response = await post("self", reason === "mention" ? "@Kim" : "hello", authorKind);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(rows(f.storage)).toEqual([expect.objectContaining({account_user_id: "owner", reason})]);
  const authorName = authorKind === "agent" ? "Claude" : "Weekly digest";
  const senderLabel = `${authorName} (Kim's ${authorKind})`;
  const expectedLabel = reason === "mention" ? `${senderLabel} mentioned you in Team`
    : reason === "dm" ? `${senderLabel} sent you a message` : `${senderLabel} replied in Team`;
  const transport = vi.fn<PushTransport>(async prepared => {
    expect(decryptedPayload(prepared.body).label).toBe(expectedLabel);
    return 201;
  });
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    lookupAccountName: userId => userId === "owner" ? "Kim" : null,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(transport).toHaveBeenCalledOnce();
  expect(rows(f.storage)[0]!.state).toBe("sent");
});

it.each(["agent", "automation"])("does not count the owner's %s posts as thread participation", async authorKind => {
  const f = await fixture();
  f.bind({userId: "owner", sessionId: "session-owner", accountName: "Kim"});
  f.append([
    chatMessageAppend("first", threadId, "hello", {authorUserId: "owner", authorKind}),
    chatMessageAppend("reply", threadId, "reply", {authorUserId: "owner", authorKind}),
  ]);
  expect(rows(f.storage)).toEqual([]);
});

it.each(["rename", "delete"] as const)("drops a queued file-chat alert after the file %s", async operation => {
  const f = await fileChatFixture();
  f.message();
  expect(rows(f.storage)).toHaveLength(1);
  f.append([moment(operation === "rename" ? "private/plan.md" : "docs/plan.md", "plan", {
    objectId: "plan", operation, beforePath: "docs/plan.md", beforeContent: "plan",
    afterPath: operation === "rename" ? "private/plan.md" : null,
    afterContent: operation === "rename" ? "plan" : null,
  })]);
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  await sender.close();
  expect(rows(f.storage)[0]!.state).toBe("dropped");
  expect(transport).not.toHaveBeenCalled();
});

it("drops a queued alert when the dependent grant's parent is revoked", async () => {
  const f = await fileChatFixture("bob");
  seedLinkGrant(f.storage, {shareId: "file-share", grantId: "parent", secretHash: "parent-secret-hash", access: "view"});
  expect(seedDependentGrant(f.storage, {shareId: "file-share", parentGrantId: "parent", grantId: "dependent",
    principalUserId: "alice", createdAtMs: 3_000}).ok).toBe(true);
  f.message();
  expect(rows(f.storage)).toHaveLength(1);
  f.storage.tx(() => f.storage.db.prepare(
    "UPDATE sync_relay_share_grants SET status = 'revoked', revoked_at_ms = ? WHERE grant_id = 'parent'").run(Date.now()));
  expect(f.storage.getShareGrant("dependent")?.status).toBe("active");
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({storage: f.storage, config, lookup, transport,
    sessionIsValid: async () => true, resolveAlertLink: () => "/l/opaque-reference"});
  await sender.runOnce();
  await sender.close();
  expect(rows(f.storage)[0]!.state).toBe("dropped");
  expect(transport).not.toHaveBeenCalled();
});
