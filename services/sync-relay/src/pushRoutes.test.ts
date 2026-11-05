import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError, type AccountSession, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { isPushStatus } from "@dohc/workspace-contracts/push-subscriptions";
import { parsePushVapidPublicKey } from "./pushRoutes";
import { fenceAccount, initializeAccountDeletion, purgeAccountRows } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { PUSH_INSTALLATIONS_PER_ACCOUNT } from "./storage/pushSubscriptions";
import type { SyncRelayStorage } from "./storage";
import {
  closeTestStorage, closeTestStorages, inspect, inspectDatabase, RELAY_EXCHANGE_KEY, reopenTestStorage, SHARE_WEB_ORIGIN,
  storagePath, testHandler, testStorage,
} from "./testing";

const limits = {maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 8, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 1000};

function p256Point(): string {
  const jwk = generateKeyPairSync("ec", {namedCurve: "P-256"}).publicKey.export({format: "jwk"});
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
}
const VAPID = p256Point(), ROTATED_VAPID = p256Point();
const VAPID_KEY_ID = parsePushVapidPublicKey(VAPID).keyId;
const installation = (n: number) => `installation-${String(n).padStart(9, "0")}`;
const endpoint = (name: string) => `https://push.example.test/send/${name}`;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const browserKeys = {p256dh: p256Point(), auth: Buffer.alloc(16, 7).toString("base64url")};

// Cookie `session=<token>` names a sign-in; the test decides which are valid.
function sessions() {
  const valid = new Map<string, AccountSession>();
  const resolve = vi.fn<ResolveAccountSession>(async (request) => {
    expect([...request.headers.keys()]).toEqual(["cookie"]);
    const token = /^session=([\w-]+)$/u.exec(request.headers.get("cookie") ?? "")?.[1];
    const session = token === undefined ? undefined : valid.get(token);
    if (!session) throw new UnauthorizedError();
    return session;
  });
  return {valid, resolve, signIn(token: string, userId: string, expiresAtMs = 1_000_000) {
    valid.set(token, {userId, sessionId: `sign-in-${token}`, expiresAtMs});
  }};
}

async function fixture(options: {vapid?: string | null; storage?: SyncRelayStorage} = {}) {
  const storage = options.storage ?? await testStorage();
  const auth = sessions();
  let clock = 2_000;
  const handler = testHandler(storage, {namedBrowserSessionLimits: limits, relayExchangeKey: RELAY_EXCHANGE_KEY,
    resolveAccountSession: auth.resolve, nowMs: () => clock,
    ...(options.vapid === null ? {} : {pushVapidPublicKey: options.vapid ?? VAPID})});
  const call = (path: string, token: string | null, init: RequestInit & {headers?: Record<string, string>} = {}) =>
    handler(new Request(`http://relay.test/sync/push/${path}`, {...init, headers: {
      origin: SHARE_WEB_ORIGIN, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
      ...(token === null ? {} : {cookie: `session=${token}`}), ...init.headers}}));
  const post = (path: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
    call(path, token, {method: "POST", body: JSON.stringify(body), headers: {"content-type": "application/json", ...headers}});
  const status = (token: string | null, id = installation(1)) => post("status", token, {installationId: id});
  const subscribe = (token: string | null, changes: Record<string, unknown> = {}) => post("subscribe", token, {
    installationId: installation(1), vapidKeyId: VAPID_KEY_ID, endpoint: endpoint("one"), ...browserKeys, expiresAtMs: null, ...changes});
  const unsubscribe = (token: string | null, id = installation(1)) => post("unsubscribe", token, {installationId: id});
  return {storage, auth, handler, call, post, status, subscribe, unsubscribe, setClock(value: number) {clock = value;}};
}

async function body(response: Response) {
  return await response.json() as Record<string, unknown>;
}
const rows = (storage: SyncRelayStorage) => inspect(storagePath(storage), db =>
  db.prepare("SELECT installation_id, account_user_id, session_id, endpoint, generation FROM sync_relay_push_subscriptions ORDER BY installation_id").all());

afterEach(async () => {await closeTestStorages();});

describe("push subscriptions", () => {
  it("binds a subscription to the caller's sign-in and keeps it across a restart", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    const off = await body(await f.status("alice-1"));
    expect(off).toEqual({ok: true, available: true, vapidPublicKey: VAPID, vapidKeyId: VAPID_KEY_ID, enabled: false, generation: null, fingerprint: null});
    const on = await f.subscribe("alice-1");
    expect(on.status).toBe(200);
    expect(on.headers.get("cache-control")).toBe("private, no-store");
    const enabled = await body(on);
    expect(isPushStatus(enabled)).toBe(true);
    expect(enabled).toMatchObject({enabled: true, generation: 1, fingerprint: fingerprint(endpoint("one"))});
    expect(JSON.stringify(enabled)).not.toContain("push.example.test");

    const dbPath = storagePath(f.storage);
    closeTestStorage(f.storage);
    expect(inspect(dbPath, db => db.prepare("SELECT 1 AS marked FROM sync_relay_migrations WHERE migration_id = 'push-subscriptions-v1'").get())).toEqual({marked: 1});
    const reopened = await fixture({storage: reopenTestStorage(dbPath)});
    reopened.auth.signIn("alice-1", "alice");
    expect(await body(await reopened.status("alice-1"))).toEqual(enabled);
  });

  it("refuses to open a store whose push schema was changed", async () => {
    const storage = await testStorage();
    const dbPath = storagePath(storage);
    closeTestStorage(storage);
    const db = inspectDatabase(dbPath);
    db.exec("DROP INDEX idx_sync_relay_push_subscriptions_account");
    db.close();
    expect(() => reopenTestStorage(dbPath)).toThrow("push subscription schema is missing or damaged");
  });

  it("takes identity only from the validated session, never from request fields or headers", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    expect((await f.subscribe("alice-1", {userId: "bob"})).status).toBe(400);
    expect((await f.subscribe("alice-1", {sessionId: "sign-in-bob"})).status).toBe(400);
    expect((await f.post("status", "alice-1", {installationId: installation(1), userId: "bob"})).status).toBe(400);
    expect((await f.subscribe(null)).status).toBe(401);
    expect((await f.post("subscribe", null, {installationId: installation(1), vapidKeyId: VAPID_KEY_ID, endpoint: endpoint("one"),
      ...browserKeys, expiresAtMs: null}, {authorization: "Bearer test:alice", "x-user-id": "alice"})).status).toBe(401);
    expect(rows(f.storage)).toEqual([]);
    await f.subscribe("alice-1");
    expect(rows(f.storage)).toEqual([{installation_id: installation(1), account_user_id: "alice", session_id: "sign-in-alice-1",
      endpoint: endpoint("one"), generation: 1}]);
  });

  it("refuses requests that did not come through share-web, before authenticating", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    await f.subscribe("alice-1");
    f.auth.resolve.mockClear();
    expect((await f.post("subscribe", "alice-1", {installationId: installation(1), vapidKeyId: VAPID_KEY_ID,
      endpoint: endpoint("evil"), ...browserKeys, expiresAtMs: null}, {origin: "https://evil.example"})).status).toBe(404);
    const forged: Record<string, string>[] = [{origin: "https://evil.example"}, {"x-dohc-relay-exchange-key": "forged-exchange-key-at-least-32-chars"}];
    for (const headers of forged) {
      expect((await f.post("unsubscribe", "alice-1", {installationId: installation(1)}, headers)).status).toBe(404);
      expect((await f.post("status", "alice-1", {installationId: installation(1)}, headers)).status).toBe(404);
    }
    expect((await f.call("subscribe", "alice-1")).status).toBe(404);
    expect((await f.call(`status?installationId=${installation(1)}`, "alice-1")).status).toBe(404);
    expect((await f.post("unsubscribe", "alice-1", {installationId: installation(1)}, {"content-type": "text/plain"})).status).toBe(400);
    expect(f.auth.resolve).not.toHaveBeenCalled();
    expect(rows(f.storage)).toHaveLength(1);
  });

  it("refuses a link holder, who has no account session", async () => {
    const f = await fixture();
    const linkHolders: Record<string, string>[] = [{authorization: "LinkCapability " + "a".repeat(43)}, {cookie: "dohc_link=secret"}];
    for (const headers of linkHolders) {
      const response = await f.post("subscribe", null, {installationId: installation(1), vapidKeyId: VAPID_KEY_ID,
        endpoint: endpoint("one"), ...browserKeys, expiresAtMs: null}, headers);
      expect(response.status).toBe(401);
      expect((await f.post("status", null, {installationId: installation(1)}, headers)).status).toBe(401);
    }
    expect(rows(f.storage)).toEqual([]);
  });

  it("never lets one installation or account take another's endpoint or binding", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    f.auth.signIn("bob-1", "bob");
    await f.subscribe("alice-1");
    const before = rows(f.storage);
    expect((await f.subscribe("bob-1", {installationId: installation(2)})).status).toBe(409);
    expect((await f.subscribe("alice-1", {installationId: installation(2)})).status).toBe(409);
    expect((await f.subscribe("bob-1", {endpoint: endpoint("bob")})).status).toBe(409);
    expect(rows(f.storage)).toEqual(before);
    // Bob learns nothing about Alice's installation, and cannot end it.
    expect(await body(await f.status("bob-1"))).toMatchObject({enabled: false, generation: null, fingerprint: null});
    expect((await f.unsubscribe("bob-1")).status).toBe(200);
    expect(rows(f.storage)).toEqual(before);
    // An endpoint moves only once its installation lets it go.
    await f.unsubscribe("alice-1");
    expect(await body(await f.subscribe("bob-1", {installationId: installation(2)}))).toMatchObject({enabled: true, generation: 2});
  });

  it.each([["after Alice signs out", true], ["while Alice is still signed in", false]])(
    "moves this browser's alerts to Bob when Bob signs in on it %s", async (_case, signsOut) => {
      const f = await fixture();
      f.auth.signIn("alice-1", "alice");
      await f.subscribe("alice-1");
      if (signsOut) f.auth.valid.delete("alice-1");
      f.auth.signIn("bob-1", "bob");
      // The installation alone, or the endpoint alone, still moves nothing.
      expect((await f.subscribe("bob-1", {endpoint: endpoint("bob")})).status).toBe(409);
      expect((await f.subscribe("bob-1", {installationId: installation(2)})).status).toBe(409);
      expect(rows(f.storage)).toEqual([expect.objectContaining({account_user_id: "alice", generation: 1})]);

      const moved = await f.subscribe("bob-1");
      expect(moved.status).toBe(200);
      expect(await body(moved)).toMatchObject({enabled: true, generation: 2, fingerprint: fingerprint(endpoint("one"))});
      expect(await body(await f.status("bob-1"))).toMatchObject({enabled: true, generation: 2});
      expect(rows(f.storage)).toEqual([{installation_id: installation(1), account_user_id: "bob", session_id: "sign-in-bob-1",
        endpoint: endpoint("one"), generation: 2}]);
      f.auth.signIn("alice-2", "alice");
      const aliceTokens = signsOut ? ["alice-2"] : ["alice-1", "alice-2"];
      for (const token of aliceTokens) {
        expect(await body(await f.status(token))).toMatchObject({enabled: false, generation: null, fingerprint: null});
        // Alice can no longer end Bob's alerts either.
        expect((await f.unsubscribe(token)).status).toBe(200);
      }
      expect(rows(f.storage)).toEqual([expect.objectContaining({account_user_id: "bob", generation: 2})]);
    });

  it("bounds how many installations one account binds", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    for (let n = 0; n < PUSH_INSTALLATIONS_PER_ACCOUNT; n++) {
      expect((await f.subscribe("alice-1", {installationId: installation(n), endpoint: endpoint(`e${n}`)})).status).toBe(200);
    }
    expect((await f.subscribe("alice-1", {installationId: installation(99), endpoint: endpoint("e99")})).status).toBe(409);
  });

  it("ends with the sign-in: another sign-in sees alerts off and must bind again", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    await f.subscribe("alice-1");
    // Signing out ends the session; Better Auth stops validating its cookie.
    f.auth.valid.delete("alice-1");
    expect((await f.status("alice-1")).status).toBe(401);
    expect((await f.unsubscribe("alice-1")).status).toBe(401);
    // The row stays, still naming the ended sign-in, so a sender checking that sign-in skips it.
    expect(rows(f.storage)).toEqual([{installation_id: installation(1), account_user_id: "alice", session_id: "sign-in-alice-1",
      endpoint: endpoint("one"), generation: 1}]);
    f.auth.signIn("alice-2", "alice");
    expect(await body(await f.status("alice-2"))).toMatchObject({enabled: false, generation: null, fingerprint: null});
    expect(await body(await f.subscribe("alice-2"))).toMatchObject({enabled: true, generation: 2});
    expect(rows(f.storage)).toEqual([expect.objectContaining({session_id: "sign-in-alice-2", generation: 2})]);
    // Another account signing in on the same browser sees alerts off until it binds them itself.
    f.auth.signIn("bob-1", "bob");
    expect(await body(await f.status("bob-1"))).toMatchObject({enabled: false, fingerprint: null});
  });

  it("ends when the sign-in or browser subscription expires, and an expired binding blocks nobody", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice", 5_000);
    f.auth.signIn("alice-long", "alice", 50_000);
    await f.subscribe("alice-1");
    f.setClock(5_000);
    expect((await f.status("alice-1")).status).toBe(401);
    expect(await body(await f.status("alice-long"))).toMatchObject({enabled: false});
    expect(await body(await f.subscribe("alice-long", {expiresAtMs: 9_000}))).toMatchObject({enabled: true, generation: 2});
    f.setClock(9_000);
    expect(await body(await f.status("alice-long"))).toMatchObject({enabled: false});
    expect((await f.subscribe("alice-long", {expiresAtMs: 9_000})).status).toBe(400);
    f.auth.signIn("bob-1", "bob", 50_000);
    expect(await body(await f.subscribe("bob-1"))).toMatchObject({enabled: true, generation: 3});
  });

  it("subscribes and unsubscribes idempotently", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    const first = await body(await f.subscribe("alice-1"));
    expect(await body(await f.subscribe("alice-1"))).toEqual(first);
    expect(rows(f.storage)).toEqual([expect.objectContaining({generation: 1})]);
    // A new browser subscription on the same installation is a new binding.
    expect(await body(await f.subscribe("alice-1", {endpoint: endpoint("two")}))).toMatchObject({generation: 2, fingerprint: fingerprint(endpoint("two"))});
    const off = await body(await f.unsubscribe("alice-1"));
    expect(off).toMatchObject({enabled: false, generation: null});
    expect(await body(await f.unsubscribe("alice-1"))).toEqual(off);
    expect(rows(f.storage)).toEqual([]);
    // A generation is never reused.
    expect(await body(await f.subscribe("alice-1"))).toMatchObject({generation: 3});
  });

  it("reports alerts unavailable without a VAPID key, and a rotated key ends old bindings", async () => {
    const unconfigured = await fixture({vapid: null});
    unconfigured.auth.signIn("alice-1", "alice");
    expect(await body(await unconfigured.status("alice-1"))).toEqual({ok: true, available: false});
    expect((await unconfigured.subscribe("alice-1")).status).toBe(409);
    expect(rows(unconfigured.storage)).toEqual([]);
    expect(await body(await unconfigured.unsubscribe("alice-1"))).toEqual({ok: true, available: false});

    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    await f.subscribe("alice-1");
    const rotated = await fixture({vapid: ROTATED_VAPID, storage: f.storage});
    rotated.auth.signIn("alice-1", "alice");
    const status = await body(await rotated.status("alice-1"));
    expect(status).toMatchObject({vapidPublicKey: ROTATED_VAPID, enabled: false});
    expect(JSON.stringify(status)).not.toContain(VAPID);
    expect((await rotated.subscribe("alice-1")).status).toBe(409);
    expect(await body(await rotated.subscribe("alice-1", {vapidKeyId: status.vapidKeyId}))).toMatchObject({enabled: true, generation: 2});
  });

  it("refuses keys that are not P-256 points and endpoints that are not plain HTTPS", async () => {
    expect(() => parsePushVapidPublicKey("B" + "A".repeat(86))).toThrow(TypeError);
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    for (const changes of [{p256dh: "B" + "A".repeat(86)}, {auth: "short"}, {endpoint: "http://push.example.test/x"},
      {endpoint: "https://user:pass@push.example.test/x"}, {endpoint: "https://push.example.test/x#frag"},
      {endpoint: "https://PUSH.example.test/x"}, {installationId: "short"}, {expiresAtMs: 1.5}]) {
      expect((await f.subscribe("alice-1", changes)).status).toBe(400);
    }
    expect(rows(f.storage)).toEqual([]);
  });

  it("ends an account's subscriptions when the account is deleted", async () => {
    const f = await fixture();
    f.auth.signIn("alice-1", "alice");
    f.auth.signIn("bob-1", "bob");
    await f.subscribe("alice-1");
    await f.subscribe("bob-1", {installationId: installation(2), endpoint: endpoint("bob")});
    const context = f.storage as unknown as StorageContext;
    initializeAccountDeletion(context, "account-deletion-key-at-least-32-bytes");
    fenceAccount(context, "account-deletion-key-at-least-32-bytes", "alice", "alice@dohc.test");
    expect(rows(f.storage)).toEqual([expect.objectContaining({account_user_id: "bob"})]);
    expect((await f.status("alice-1")).status).toBe(404);
    expect((await f.subscribe("alice-1", {installationId: installation(3), endpoint: endpoint("three")})).status).toBe(404);
    // A bind that passed the route's check before the fence still cannot land.
    expect(() => f.storage.bindPushSubscription({installationId: installation(3), userId: "alice", sessionId: "sign-in-alice-1",
      sessionExpiresAtMs: 1_000_000, endpoint: endpoint("three"), ...browserKeys, vapidKeyId: VAPID_KEY_ID,
      browserExpiresAtMs: null, nowMs: 2_000})).toThrow(expect.objectContaining({code: "not_found"}));
    expect(rows(f.storage)).toEqual([expect.objectContaining({account_user_id: "bob"})]);
    // The final purge removes whatever an account still binds.
    purgeAccountRows(context, "bob", "bob@dohc.test", {workspaces: [], shareIds: [], datasets: [], grantIds: [], publicationIds: []});
    expect(rows(f.storage)).toEqual([]);
  });
});
