import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UnauthorizedError,
  type AccountSession,
  type AccountSessions,
  type ResolveAccountSession,
  type SessionKind,
} from "@dohc/workspace-auth/session";
import { generateKeyPairSync } from "node:crypto";
import { readApnsConfig } from "./pushConfig";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { PUSH_SCHEMA } from "./storage/pushSchema";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  denialBytes,
  inspect,
  inspectDatabase,
  reopenTestStorage,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const TOPIC = "com.example.phone";
const token = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const DELETION_KEY = "account-deletion-key-at-least-32-bytes";
const KEY_PATH = "/run/secrets/apns-key.p8";
const pem = (curve: string, type: "pkcs8" | "sec1" = "pkcs8") =>
  generateKeyPairSync("ec", { namedCurve: curve })
    .privateKey.export({ type, format: "pem" })
    .toString();
const PEM = pem("prime256v1");
// Apple's key settings, a throwaway key in place of the `.p8` file.
const apnsEnv = (environments: string, overrides: Record<string, string | undefined> = {}) => ({
  DOHC_RELAY_APNS_TOPIC: TOPIC,
  DOHC_RELAY_APNS_ENVIRONMENTS: environments,
  DOHC_RELAY_APNS_KEY_FILE: KEY_PATH,
  DOHC_RELAY_APNS_KEY_ID: "KEY1234567",
  DOHC_RELAY_APNS_TEAM_ID: "TEAM123456",
  ...overrides,
});

async function relay(environments: string | null = "sandbox,production") {
  const storage = (await testStorage()) as StorageContext;
  // Better Auth as the relay sees it: `Bearer <credential>` is the sign-in listed under it.
  const sessions = new Map<string, AccountSession>();
  const signIn = (
    credential: string,
    userId: string,
    clientKind: SessionKind = "phone",
    expiresAtMs = 1_000_000,
  ) =>
    sessions.set(credential, {
      userId,
      sessionId: `session-${credential}`,
      expiresAtMs,
      clientKind,
    });
  // A gate lets a call reach a point, then waits there until it is released.
  const gate = () => {
    let reached!: () => void, release!: () => void;
    const seen = new Promise<void>((resolve) => (reached = resolve));
    const open = new Promise<void>((resolve) => (release = resolve));
    return { seen, open, reached: () => reached(), release: () => release() };
  };
  type Gate = ReturnType<typeof gate>;
  const lookupGates = new Map<string, Gate>();
  let revokeGate: { gate: Gate; refuse: boolean } | undefined;
  let revokeThrows = false;
  const resolve: ResolveAccountSession = async (request) => {
    const credential = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = credential === undefined ? undefined : sessions.get(credential);
    if (!session) throw new UnauthorizedError();
    // A held lookup has already read its live session.
    const held = lookupGates.get(credential!);
    lookupGates.delete(credential!);
    held?.reached();
    await held?.open;
    return session;
  };
  const accountSessions: AccountSessions = {
    list: async (userId) =>
      [...sessions.values()]
        .filter((session) => session.userId === userId)
        .map(({ sessionId }) => ({ sessionId, createdAtMs: 0, userAgent: null })),
    revoke: async ({ userId, callerSessionId, sessionId }) => {
      // The account server's answer is lost; whether it deleted the session is unknown to the relay.
      if (revokeThrows) throw new Error("The account server didn't answer.");
      const held = revokeGate;
      revokeGate = undefined;
      const own = [...sessions].filter(([, session]) => session.userId === userId);
      const target = own.find(([, session]) => session.sessionId === sessionId);
      const caller = own.some(([, session]) => session.sessionId === callerSessionId);
      const revoked = target !== undefined && caller && !held?.refuse;
      // A held revoke has already deleted the session and waits to answer.
      if (revoked) sessions.delete(target[0]);
      held?.gate.reached();
      await held?.gate.open;
      return revoked ? target[1].expiresAtMs : null;
    },
    phoneSessionIsCurrent: async ({ userId, sessionId }) =>
      [...sessions.values()].some(
        (session) =>
          session.userId === userId &&
          session.sessionId === sessionId &&
          session.clientKind === "phone",
      ),
    read: async (sessionIds) =>
      new Map(
        [...sessions.values()]
          .filter((session) => sessionIds.includes(session.sessionId))
          .map(({ sessionId, userId, expiresAtMs, clientKind }) => [
            sessionId,
            { userId, expiresAtMs, clientKind },
          ]),
      ),
  };
  const hold = (credential: string) => {
    const held = gate();
    lookupGates.set(credential, held);
    return { reached: held.seen, release: held.release };
  };
  const holdRevoke = (refuse = false) => {
    const held = gate();
    revokeGate = { gate: held, refuse };
    return { reached: held.seen, release: held.release };
  };
  const h = testHandler(storage, {
    resolvePhoneCapableAccountSession: resolve,
    accountSessions,
    ...(environments === null
      ? {}
      : {
          apnsConfig: readApnsConfig(apnsEnv(environments), () => PEM)!,
        }),
  });
  await claimWorkspace(h, "ana", "trip");
  const call = (
    credential: string | null,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h(
      new Request("http://relay.test/sync/push/devices", {
        method,
        headers: {
          ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    storage,
    h,
    signIn,
    hold,
    holdRevoke,
    failRevoke: () => (revokeThrows = true),
    call,
    revoke: (credential: string, sessionId: string) =>
      h(
        new Request(`http://relay.test/sync/account/sessions/${sessionId}/revoke`, {
          method: "POST",
          headers: { authorization: `Bearer ${credential}` },
        }),
      ),
    revokedSessions: () =>
      storage.db
        .prepare("SELECT session_id, expires_at_ms FROM sync_relay_push_revoked_sessions")
        .all(),
    put: (credential: string, value = token(1), environment = "sandbox") =>
      call(credential, "PUT", { token: value, environment }),
    remove: (credential: string, generation: unknown) => call(credential, "DELETE", { generation }),
    status: async (credential: string) => (await call(credential, "GET")).json(),
    bindings: () =>
      storage.db
        .prepare(`SELECT account_user_id AS userId, session_id AS sessionId, apns_token AS token,
          generation FROM sync_relay_push_subscriptions WHERE kind = 'apns' ORDER BY generation`)
        .all(),
    // A queued alert for that binding, as the sender will claim it.
    queue: (generation: number, userId: string) =>
      storage.db
        .prepare(`INSERT INTO sync_relay_push_deliveries (delivery_id, workspace_id, thread_id, message_id,
          relay_seq, account_user_id, installation_id, generation, reason, state, attempts, created_at_ms,
          expires_at_ms, available_at_ms) VALUES (?, 'trip', 'thread', 'message', 1, ?, 'phone', ?,
          'mention', 'pending', 0, 2000, 900000, 2000)`)
        .run(`delivery-${generation}`, userId, generation),
    queued: () =>
      storage.db
        .prepare("SELECT generation FROM sync_relay_push_deliveries ORDER BY generation")
        .all()
        .map((row) => Number(row.generation)),
  };
}

const generationOf = async (response: Response) =>
  Number(((await response.json()) as { generation: number }).generation);

describe("a phone's alert binding", () => {
  it("answers only a phone's Bearer session", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ana-desktop", "ana", "desktop");
    f.signIn("ana-browser", "ana", "browser");
    const missing = await denialBytes(await f.call(null, "GET"));
    for (const credential of ["ana-desktop", "ana-browser"]) {
      expect(await denialBytes(await f.call(credential, "GET"))).toBe(missing);
      expect(await denialBytes(await f.put(credential))).toBe(missing);
      expect(await denialBytes(await f.remove(credential, 1))).toBe(missing);
    }
    const cookie = { cookie: "session=ana" };
    expect(await denialBytes(await f.call("ana-phone", "GET", undefined, cookie))).toBe(missing);
    expect(await denialBytes(await f.call(null, "GET", undefined, cookie))).toBe(missing);
    expect(
      await denialBytes(
        await f.call("ana-phone", "PUT", { token: token(1), environment: "sandbox" }, cookie),
      ),
    ).toBe(missing);
    expect((await f.call("nobody", "GET")).status).toBe(401);
    expect(f.bindings()).toEqual([]);

    const off = await f.call("ana-phone", "GET");
    expect(off.headers.get("cache-control")).toBe("private, no-store");
    expect(await off.json()).toEqual({
      ok: true,
      available: true,
      enabled: false,
      generation: null,
    });
    expect((await f.call("ana-phone", "POST")).status).toBe(405);
  });

  it("reports alerts unavailable without APNs configuration and binds nothing", async () => {
    const f = await relay(null);
    f.signIn("ana-phone", "ana");
    expect(await f.status("ana-phone")).toEqual({ ok: true, available: false });
    expect((await f.put("ana-phone")).status).toBe(409);
    expect(f.bindings()).toEqual([]);
    expect(readApnsConfig({})).toBeUndefined();
    // PR 1's two settings alone no longer turn alerts on: a server must be able to send what it accepts.
    expect(() =>
      readApnsConfig({ DOHC_RELAY_APNS_TOPIC: TOPIC, DOHC_RELAY_APNS_ENVIRONMENTS: "sandbox" }),
    ).toThrow(
      "Missing APNs configuration: DOHC_RELAY_APNS_KEY_FILE, DOHC_RELAY_APNS_KEY_ID, DOHC_RELAY_APNS_TEAM_ID.",
    );
    expect(
      readApnsConfig(
        apnsEnv("", {
          DOHC_RELAY_APNS_TOPIC: "",
          DOHC_RELAY_APNS_KEY_FILE: "",
          DOHC_RELAY_APNS_KEY_ID: "",
          DOHC_RELAY_APNS_TEAM_ID: "",
        }),
      ),
    ).toBeUndefined();
    expect(() =>
      readApnsConfig(
        apnsEnv("sandbox", { DOHC_RELAY_APNS_KEY_FILE: "", DOHC_RELAY_APNS_TEAM_ID: "" }),
        () => PEM,
      ),
    ).toThrow("Missing APNs configuration: DOHC_RELAY_APNS_KEY_FILE, DOHC_RELAY_APNS_TEAM_ID.");
    for (const environments of ["staging", "sandbox,sandbox", ""])
      expect(() => readApnsConfig(apnsEnv(environments), () => PEM)).toThrow("APNs configuration");
  });

  it("reads the key once at startup, as a P-256 PKCS#8 key, naming variables but never values", () => {
    const readKeyFile = vi.fn(() => PEM);
    const config = readApnsConfig(apnsEnv("sandbox"), readKeyFile)!;
    expect(readKeyFile).toHaveBeenCalledExactlyOnceWith(KEY_PATH);
    expect(config).toMatchObject({ keyId: "KEY1234567", teamId: "TEAM123456" });
    expect(config.privateKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const refusals: Array<[Record<string, string>, () => string, string]> = [
      [{}, () => pem("prime256v1", "sec1"), "DOHC_RELAY_APNS_KEY_FILE"],
      [{}, () => pem("secp384r1"), "DOHC_RELAY_APNS_KEY_FILE"],
      [{}, () => "not a key", "DOHC_RELAY_APNS_KEY_FILE"],
      [
        {},
        () => {
          throw new Error(`ENOENT: no such file, open '${KEY_PATH}'`);
        },
        "DOHC_RELAY_APNS_KEY_FILE",
      ],
      [{ DOHC_RELAY_APNS_KEY_ID: "key-1" }, () => PEM, "DOHC_RELAY_APNS_KEY_ID"],
      [{ DOHC_RELAY_APNS_TEAM_ID: "team123456" }, () => PEM, "DOHC_RELAY_APNS_TEAM_ID"],
    ];
    for (const [overrides, read, name] of refusals) {
      const error = (() => {
        try {
          readApnsConfig(apnsEnv("sandbox", overrides), read);
        } catch (thrown) {
          return thrown as Error;
        }
        throw new Error("expected a refusal");
      })();
      expect(error.message).toContain(name);
      for (const value of [KEY_PATH, "key-1", "team123456", PEM.split("\n")[1]!])
        expect(error.message).not.toContain(value);
    }
  });

  it("takes identity only from the session, and only a bounded token in an allowed environment", async () => {
    const f = await relay("production");
    f.signIn("ana-phone", "ana");
    const refused = [
      { token: token(1), environment: "production", userId: "ben" },
      { token: token(1), environment: "production", sessionId: "session-ben-phone" },
      { token: token(1), environment: "production", topic: "com.example.other" },
      { token: token(1), environment: "sandbox" },
      { token: token(0xab).toUpperCase(), environment: "production" },
      { token: "ab".repeat(31), environment: "production" },
      { token: "ab".repeat(101), environment: "production" },
      { token: token(1) },
    ];
    for (const body of refused) expect((await f.call("ana-phone", "PUT", body)).status).toBe(400);
    expect((await f.remove("ana-phone", "1")).status).toBe(400);
    expect((await f.remove("ana-phone", 0)).status).toBe(400);
    expect(f.bindings()).toEqual([]);
    expect((await f.put("ana-phone", token(1), "production")).status).toBe(200);
    expect(f.bindings()).toEqual([
      { userId: "ana", sessionId: "session-ana-phone", token: token(1), generation: 1 },
    ]);
  });

  it("holds one binding per sign-in; an unchanged upsert changes nothing, and a new token ends the old binding's queue", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    const first = await f.put("ana-phone");
    const on = await first.json();
    expect(on).toEqual({ ok: true, available: true, enabled: true, generation: 1 });
    expect(await (await f.put("ana-phone")).json()).toEqual(on);
    expect(await f.status("ana-phone")).toEqual(on);
    f.queue(1, "ana");
    expect(f.queued()).toEqual([1]);

    expect(await generationOf(await f.put("ana-phone", token(2)))).toBe(2);
    expect(f.bindings()).toEqual([
      { userId: "ana", sessionId: "session-ana-phone", token: token(2), generation: 2 },
    ]);
    expect(f.queued()).toEqual([]);
    // A generation is never used twice, even by a binding that ends and comes back.
    expect(await generationOf(await f.put("ana-phone", token(1)))).toBe(3);
  });

  it("moves a token to the sign-in that registers it, with the same answer whether it was held or free", async () => {
    const f = await relay();
    for (const [credential, userId] of [
      ["ana-phone", "ana"],
      ["ana-tablet", "ana"],
      ["ben-phone", "ben"],
      ["ben-tablet", "ben"],
    ] as const)
      f.signIn(credential, userId);
    const answer = async (response: Response) => ({
      status: response.status,
      headers: [...response.headers],
      body: { ...((await response.json()) as object), generation: "fresh" },
    });
    const anaGeneration = await generationOf(await f.put("ana-phone", token(1)));
    f.queue(anaGeneration, "ana");

    const held = await answer(await f.put("ben-phone", token(1)));
    const free = await answer(await f.put("ben-tablet", token(2)));
    expect(held).toEqual(free);
    expect(held.status).toBe(200);
    expect(await f.status("ana-phone")).toEqual({
      ok: true,
      available: true,
      enabled: false,
      generation: null,
    });
    expect(f.queued()).toEqual([]);

    // Within one account too: the account's other sign-in takes the token over.
    await f.put("ana-phone", token(3));
    await f.put("ana-tablet", token(3));
    // One token per topic and environment: the same token in the other environment is another binding.
    await f.put("ben-tablet", token(1), "production");
    expect(f.bindings()).toEqual([
      { userId: "ben", sessionId: "session-ben-phone", token: token(1), generation: 2 },
      { userId: "ana", sessionId: "session-ana-tablet", token: token(3), generation: 5 },
      { userId: "ben", sessionId: "session-ben-tablet", token: token(1), generation: 6 },
    ]);
  });

  it("removes a binding only at the generation it names, and only the caller's", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ben-phone", "ben");
    await f.put("ana-phone", token(1));
    await f.put("ana-phone", token(2));
    // A late removal of the earlier binding keeps the newer one.
    expect(await (await f.remove("ana-phone", 1)).json()).toEqual({
      ok: true,
      available: true,
      enabled: true,
      generation: 2,
    });
    expect(await (await f.remove("ben-phone", 2)).json()).toMatchObject({ enabled: false });
    expect(f.bindings()).toHaveLength(1);
    f.queue(2, "ana");
    expect(await (await f.remove("ana-phone", 2)).json()).toMatchObject({ enabled: false });
    expect(f.bindings()).toEqual([]);
    expect(f.queued()).toEqual([]);
    expect((await f.remove("ana-phone", 2)).status).toBe(200);
  });

  it("ends a revoked sign-in's binding and queue before the revoke answers", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ana-tablet", "ana");
    f.signIn("ana-desktop", "ana", "desktop");
    const revoked = await generationOf(await f.put("ana-phone", token(1)));
    const kept = await generationOf(await f.put("ana-tablet", token(2)));
    f.queue(revoked, "ana");
    f.queue(kept, "ana");
    expect((await f.revoke("ana-desktop", "session-ana-phone")).status).toBe(200);
    expect(f.bindings()).toEqual([expect.objectContaining({ sessionId: "session-ana-tablet" })]);
    expect(f.queued()).toEqual([kept]);
    expect((await f.call("ana-phone", "GET")).status).toBe(401);
    // The relay remembers the revoked sign-in until it would have expired, then forgets it.
    expect(f.revokedSessions()).toEqual([
      { session_id: "session-ana-phone", expires_at_ms: 1_000_000 },
    ]);
    f.storage.sweepExpiredPushDevices(999_999);
    expect(f.revokedSessions()).toHaveLength(1);
    f.storage.sweepExpiredPushDevices(1_000_000);
    expect(f.revokedSessions()).toEqual([]);
  });

  it("refuses a registration whose lookup began before its sign-in was revoked", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ana-desktop", "ana", "desktop");
    f.signIn("ben-phone", "ben");
    const missing = await denialBytes(await f.call(null, "GET"));
    // Ana's phone has already read a live session when the revoke lands.
    const held = f.hold("ana-phone");
    const late = f.put("ana-phone", token(1));
    await held.reached;
    expect((await f.revoke("ana-desktop", "session-ana-phone")).status).toBe(200);
    // Ben now uses the phone and registers its token.
    const ben = await generationOf(await f.put("ben-phone", token(1)));
    f.queue(ben, "ben");
    held.release();
    expect(await denialBytes(await late)).toBe(missing);
    expect(f.bindings()).toEqual([
      { userId: "ben", sessionId: "session-ben-phone", token: token(1), generation: ben },
    ]);
    expect(f.queued()).toEqual([ben]);
  });

  it("refuses a registration that lands while the revoke still waits for the account server's answer", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ana-desktop", "ana", "desktop");
    f.signIn("ben-phone", "ben");
    const missing = await denialBytes(await f.call(null, "GET"));
    const lookup = f.hold("ana-phone");
    const late = f.put("ana-phone", token(1));
    await lookup.reached;
    // The account server has deleted Ana's phone session, but the relay hasn't had its answer.
    const answer = f.holdRevoke();
    const revoking = f.revoke("ana-desktop", "session-ana-phone");
    await answer.reached;
    const ben = await generationOf(await f.put("ben-phone", token(1)));
    f.queue(ben, "ben");
    lookup.release();
    expect(await denialBytes(await late)).toBe(missing);
    answer.release();
    expect((await revoking).status).toBe(200);
    expect(f.bindings()).toEqual([
      { userId: "ben", sessionId: "session-ben-phone", token: token(1), generation: ben },
    ]);
    expect(f.queued()).toEqual([ben]);
    expect(f.revokedSessions()).toEqual([
      { session_id: "session-ana-phone", expires_at_ms: 1_000_000 },
    ]);
  });

  it("lifts a revoke's fence when the account server refuses the revoke", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ana-desktop", "ana", "desktop");
    const answer = f.holdRevoke(true);
    const revoking = f.revoke("ana-desktop", "session-ana-phone");
    await answer.reached;
    // While the revoke is out, the phone can't register.
    expect((await f.put("ana-phone", token(1))).status).toBe(404);
    answer.release();
    expect((await revoking).status).toBe(404);
    expect(f.revokedSessions()).toEqual([]);
    expect(await (await f.put("ana-phone", token(1))).json()).toMatchObject({ enabled: true });
  });

  it("never lets one account's revoke fence another account's sign-in", async () => {
    const f = await relay();
    f.signIn("ana-desktop", "ana", "desktop");
    f.signIn("ben-phone", "ben");
    expect((await f.revoke("ana-desktop", "session-ben-phone")).status).toBe(404);
    expect(await (await f.put("ben-phone", token(1))).json()).toMatchObject({ enabled: true });
  });

  it("keeps a revoke's fence when the account server's answer is lost", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ana-desktop", "ana", "desktop");
    f.failRevoke();
    expect((await f.revoke("ana-desktop", "session-ana-phone")).status).toBeGreaterThanOrEqual(500);
    // The delete may have landed, so the phone stays refused until the fence expires.
    expect(f.revokedSessions()).toHaveLength(1);
    expect((await f.put("ana-phone", token(1))).status).toBe(404);
  });

  it("ends bindings and their queue when the sign-in expires", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana", "phone", 10_000);
    f.signIn("ben-phone", "ben");
    const expiring = await generationOf(await f.put("ana-phone", token(1)));
    const kept = await generationOf(await f.put("ben-phone", token(2)));
    f.queue(expiring, "ana");
    f.queue(kept, "ben");
    f.storage.sweepExpiredPushDevices(9_999);
    expect(f.bindings()).toHaveLength(2);
    f.storage.sweepExpiredPushDevices(10_000);
    expect(f.bindings()).toEqual([expect.objectContaining({ userId: "ben" })]);
    expect(f.queued()).toEqual([kept]);
  });

  it("ends an account's bindings and queue when the account is deleted", async () => {
    const f = await relay();
    f.signIn("ana-phone", "ana");
    f.signIn("ben-phone", "ben");
    const ana = await generationOf(await f.put("ana-phone", token(1)));
    const ben = await generationOf(await f.put("ben-phone", token(2)));
    f.queue(ana, "ana");
    f.queue(ben, "ben");
    f.signIn("ana-old", "ana");
    expect((await f.revoke("ana-phone", "session-ana-old")).status).toBe(200);
    expect(f.revokedSessions()).toHaveLength(1);
    initializeAccountDeletion(f.storage, DELETION_KEY);
    fenceAccount(f.storage, DELETION_KEY, "ana", "ana@dohc.test");
    expect(f.bindings()).toEqual([expect.objectContaining({ userId: "ben" })]);
    expect(f.queued()).toEqual([ben]);
    expect(f.revokedSessions()).toEqual([]);
    expect((await f.put("ana-phone", token(3))).status).toBe(404);
    // A bind that passed the route's check before the fence still cannot land.
    expect(() =>
      f.storage.bindPushDevice({
        userId: "ana",
        sessionId: "session-ana-phone",
        sessionExpiresAtMs: 1_000_000,
        token: token(3),
        environment: "sandbox",
        topic: TOPIC,
        nowMs: 2_000,
      }),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

it("keeps browser subscriptions and the generation counter through the upgrade", async () => {
  const storage = await testStorage();
  const dbPath = storagePath(storage);
  closeTestStorage(storage);
  // Put the store back as the browser-only schema left it, with one subscription.
  const db = inspectDatabase(dbPath, { foreignKeys: true });
  db.exec(`DROP TABLE sync_relay_push_subscriptions;
    DELETE FROM sync_relay_migrations WHERE migration_id = 'push-native-devices-v1';
    UPDATE sync_relay_push_generations SET last_generation = 7;`);
  db.exec(PUSH_SCHEMA.sync_relay_push_subscriptions);
  db.exec(PUSH_SCHEMA.idx_sync_relay_push_subscriptions_account);
  const installationId = "installation-000000001";
  db.prepare(`INSERT INTO sync_relay_push_subscriptions (installation_id, account_user_id, session_id,
    endpoint, p256dh, auth, vapid_key_id, generation, created_at_ms, updated_at_ms, expires_at_ms)
    VALUES (?, 'ana', 'session-ana', 'https://push.example.test/send/one', ?, ?, ?, 7, 1, 1, 1000000)`).run(
    installationId,
    `B${"a".repeat(86)}`,
    "a".repeat(22),
    "0".repeat(64),
  );
  db.close();

  const reopened = reopenTestStorage(dbPath);
  expect(reopened.readPushSubscription(installationId)).toMatchObject({
    userId: "ana",
    sessionId: "session-ana",
    endpoint: "https://push.example.test/send/one",
    generation: 7,
  });
  expect(
    inspect(dbPath, (inspection) => [
      inspection.prepare("SELECT kind FROM sync_relay_push_subscriptions").all(),
      inspection
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'sync_relay_push_installation_names'")
        .all(),
    ]),
  ).toEqual([[{ kind: "web" }], []]);
  expect(
    reopened.bindPushDevice({
      userId: "ana",
      sessionId: "session-ana-phone",
      sessionExpiresAtMs: 1_000_000,
      token: token(1),
      environment: "sandbox",
      topic: TOPIC,
      nowMs: 2_000,
    }).generation,
  ).toBe(8);
  // The upgraded store opens again under its own marker.
  closeTestStorage(reopened);
  expect(reopenTestStorage(dbPath).readPushSubscription(installationId)).not.toBeNull();
});
