import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINK_HANDOFF_CODES_PER_GRANT_LIMIT,
  LinkReadRateLimiter,
  type ValidatedLinkCapability,
} from "./linkSecurity";
import { linkSecret } from "./linkTestHelpers";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

const OWNER = "owner";
const RECIPIENT = "recipient";
const OTHER_ACCOUNT = "other-account";
const WORKSPACE = "workspace-link-handoff";
const SHARE_ID = "share-link-handoff";
const LINK_KEY = "test-link-key-with-at-least-thirty-two-bytes";
const RELAY_EXCHANGE_KEY = "share-web-relay-exchange-key-at-least-32";
const HANDOFF_TTL_MS = 5 * 60 * 1_000;
const GENERIC_REFUSAL = {
  status: 404,
  body: '{"ok":false,"error":"not found","code":"not_found"}',
};

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId !== null) headers.set("authorization", `Bearer user:${userId}`);
  headers.set("x-dohc-relay-client-ip", "192.0.2.40");
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function hashLinkHandoffCode(code: string): string {
  return createHmac("sha256", LINK_KEY)
    .update("link-handoff\n")
    .update(code)
    .digest("base64url");
}

type HandlerOverrides = {
  storage?: SyncRelayStorage;
  nowMs?: () => number;
  relayExchangeKey?: string;
  shareWebOrigin?: string;
  linkRedeemRateLimiter?: LinkReadRateLimiter;
  linkReadRateLimiter?: LinkReadRateLimiter;
  linkGrantReadRateLimiter?: LinkReadRateLimiter;
  newGrantId?: () => string;
  newLinkHandoffCode?: () => string;
};

function handler(
  storage: SyncRelayStorage,
  overrides: HandlerOverrides = {},
): SyncRelayHandler {
  let id = 0;
  const options = {
    storage: overrides.storage ?? storage,
    resolveActor(request: Request, workspaceId: string) {
      const match = /^Bearer user:([^ ]+)$/u.exec(
        request.headers.get("authorization") ?? "",
      );
      if (!match) {
        throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      }
      return { userId: match[1]!, workspaceId };
    },
    nowMs: overrides.nowMs ?? (() => 10_000),
    newShareId: () => SHARE_ID,
    newGrantId: overrides.newGrantId ?? (() => `grant-handoff-${id++}`),
    newId: () => `id-handoff-${id++}`,
    resolveUserIdByEmail: () => null,
    lookupUserEmail: (userId: string) => `${userId}@example.test`,
    linkKey: LINK_KEY,
    shareWebOrigin: Object.hasOwn(overrides, "shareWebOrigin")
      ? overrides.shareWebOrigin
      : "https://share.example.test",
    relayExchangeKey: Object.hasOwn(overrides, "relayExchangeKey")
      ? overrides.relayExchangeKey
      : RELAY_EXCHANGE_KEY,
    linkRedeemRateLimiter: overrides.linkRedeemRateLimiter,
    linkReadRateLimiter: overrides.linkReadRateLimiter,
    linkGrantReadRateLimiter: overrides.linkGrantReadRateLimiter,
    newLinkHandoffCode: overrides.newLinkHandoffCode,
  };
  return createSyncRelayHandler(options);
}

async function newStorage(): Promise<{
  storage: SyncRelayStorage;
  dbPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-handoff-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  const storage = openSyncRelayStorage(dbPath);
  storages.push(storage);
  return { storage, dbPath };
}

function inspect(dbPath: string, readOnly = false): SqliteDatabase {
  const database = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
  }
  databases.push(database);
  return database;
}

type Setup = {
  storage: SyncRelayStorage;
  dbPath: string;
  h: SyncRelayHandler;
  now: { value: number };
  link: Record<string, unknown>;
  linkSecret: string;
  capability: string;
};

async function setup(
  overrides: HandlerOverrides = {},
  access: "view" | "comment" = "view",
): Promise<Setup> {
  const { storage, dbPath } = await newStorage();
  const now = { value: 10_000 };
  const h = handler(storage, {
    ...overrides,
    nowMs: overrides.nowMs ?? (() => now.value),
  });
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  expect(
    (
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({ recipientUserId: "seed-recipient", paths: ["docs"], access: "view" }),
        ),
      )
    ).status,
  ).toBe(200);
  const linkResponse = await h(
    request(
      OWNER,
      `/sync/${WORKSPACE}/shares/${SHARE_ID}/links`,
      jsonBody({ access }),
    ),
  );
  expect(linkResponse.status).toBe(200);
  const link = await json(linkResponse);
  const secret = linkSecret(link.url);
  const exchangeResponse = await h(
    request(null, "/sync/link-exchange", {
      ...jsonBody({ secret }),
      headers: {
        "content-type": "application/json",
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
      },
    }),
  );
  expect(exchangeResponse.status).toBe(200);
  const exchange = await json(exchangeResponse);
  return {
    storage,
    dbPath,
    h,
    now,
    link,
    linkSecret: secret,
    capability: String(exchange.capabilityToken),
  };
}

function handoffRequest(capability: string, exchangeKey = RELAY_EXCHANGE_KEY): Request {
  return request(null, "/sync/link-handoff", {
    method: "POST",
    headers: {
      authorization: `LinkCapability ${capability}`,
      "x-dohc-relay-exchange-key": exchangeKey,
    },
  });
}

async function mint(setupState: Setup): Promise<Record<string, unknown>> {
  const response = await setupState.h(handoffRequest(setupState.capability));
  expect(response.status).toBe(200);
  return json(response);
}

function redeemRequest(
  userId: string | null,
  code: unknown,
  extra: Record<string, unknown> = {},
): Request {
  return request(userId, "/sync/link-redeem", jsonBody({ code, ...extra }));
}

async function serialized(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

async function expectGeneric(response: Response): Promise<void> {
  expect(await serialized(response)).toEqual(GENERIC_REFUSAL);
}

function countHandoffStorageCalls(storage: SyncRelayStorage): {
  storage: SyncRelayStorage;
  probes: string[];
  redeems: string[];
} {
  const probes: string[] = [];
  const redeems: string[] = [];
  return {
    storage: new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "hasLinkHandoffCode") {
          return (codeHash: string): boolean => {
            probes.push(codeHash);
            const has = Reflect.get(target, property, receiver) as
              | ((codeHash: string) => boolean)
              | undefined;
            return has?.call(target, codeHash) ?? false;
          };
        }
        if (property === "redeemLinkHandoffCode") {
          return (input: { codeHash: string }): unknown => {
            redeems.push(input.codeHash);
            return target.redeemLinkHandoffCode(input as Parameters<
              SyncRelayStorage["redeemLinkHandoffCode"]
            >[0]);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    probes,
    redeems,
  };
}

function codeCount(database: SqliteDatabase, grantId?: string): number {
  const row = grantId
    ? database
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_relay_link_handoff_codes WHERE grant_id = ?",
        )
        .get(grantId)
    : database
        .prepare("SELECT COUNT(*) AS count FROM sync_relay_link_handoff_codes")
        .get();
  return Number(row?.count ?? 0);
}

function dependentRows(
  database: SqliteDatabase,
  parentGrantId: string,
  principalUserId?: string,
): Array<Record<string, unknown>> {
  return principalUserId === undefined
    ? database
        .prepare(
          `SELECT * FROM sync_relay_share_grants
           WHERE parent_grant_id = ? ORDER BY grant_id`,
        )
        .all(parentGrantId)
    : database
        .prepare(
          `SELECT * FROM sync_relay_share_grants
           WHERE parent_grant_id = ? AND principal_user_id = ? ORDER BY grant_id`,
        )
        .all(parentGrantId, principalUserId);
}

async function ownerInventory(setupState: Setup): Promise<Array<Record<string, unknown>>> {
  const response = await setupState.h(
    request(OWNER, `/sync/${WORKSPACE}/shares/links`),
  );
  expect(response.status).toBe(200);
  return (await json(response)).links as Array<Record<string, unknown>>;
}

describe("single-use authenticated link handoff", () => {
  it("configures writable inspection connections for lock waits and foreign keys", async () => {
    const { dbPath } = await newStorage();
    const database = inspect(dbPath);

    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("probes handoff codes without a write transaction and rechecks present rows in the transaction", async () => {
    const state = await setup();
    const minted = await mint(state);
    const counted = countHandoffStorageCalls(state.storage);
    const h = handler(state.storage, {
      storage: counted.storage,
      newGrantId: () => "preflight-dependent-grant",
    });
    const unknownCode = "u".repeat(43);

    await expectGeneric(await h(redeemRequest(RECIPIENT, unknownCode)));
    expect(counted.probes).toEqual([hashLinkHandoffCode(unknownCode)]);
    expect(counted.redeems).toEqual([]);

    expect((await h(redeemRequest(RECIPIENT, minted.code))).status).toBe(200);
    expect(counted.probes).toEqual([
      hashLinkHandoffCode(unknownCode),
      hashLinkHandoffCode(String(minted.code)),
    ]);
    expect(counted.redeems).toEqual([hashLinkHandoffCode(String(minted.code))]);
  });

  it("rate-limits redemption per authenticated actor before handoff storage", async () => {
    const state = await setup();
    const codes = [await mint(state), await mint(state), await mint(state)];
    const counted = countHandoffStorageCalls(state.storage);
    let grantId = 0;
    const h = handler(state.storage, {
      storage: counted.storage,
      linkRedeemRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      newGrantId: () => `admitted-dependent-grant-${grantId++}`,
    });

    expect((await h(redeemRequest(RECIPIENT, codes[0]!.code))).status).toBe(200);
    expect(counted.redeems).toHaveLength(1);

    expect(await serialized(await h(redeemRequest(RECIPIENT, codes[1]!.code)))).toEqual({
      status: 429,
      body: '{"ok":false,"error":"too many link reads","code":"link_read_rate_limited"}',
    });
    expect(counted.probes).toHaveLength(1);
    expect(counted.redeems).toHaveLength(1);

    expect((await h(redeemRequest(OTHER_ACCOUNT, codes[2]!.code))).status).toBe(200);
    expect(counted.probes).toHaveLength(2);
    expect(counted.redeems).toHaveLength(2);
  });

  it("mints only with capability and exchange-key auth, with five-minute domain-separated state", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectGeneric(
      await state.h(
        request(null, "/sync/link-handoff", {
          method: "POST",
          headers: { "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY },
        }),
      ),
    );
    await expectGeneric(await state.h(handoffRequest(state.capability, "wrong-key")));
    await expectGeneric(await state.h(handoffRequest("x".repeat(43))));
    await expectGeneric(
      await state.h(
        request(null, "/sync/link-handoff", {
          ...jsonBody({ url: state.link.url, viewerSessionId: "viewer-session" }),
          headers: {
            authorization: `LinkCapability ${state.capability}`,
            "content-type": "application/json",
            "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
          },
        }),
      ),
    );
    expect(codeCount(database)).toBe(0);

    const before = await ownerInventory(state);
    expect(before).toHaveLength(1);
    expect(before[0]?.dependents).toEqual([]);
    expect(JSON.stringify(before)).not.toContain(RECIPIENT);

    const response = await state.h(handoffRequest(state.capability));
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const body = JSON.parse(responseText) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAtMs", "ok"]);
    expect(body).toMatchObject({ ok: true, expiresAtMs: state.now.value + HANDOFF_TTL_MS });
    const code = String(body.code);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(code, "base64url")).toHaveLength(32);
    expect(responseText).not.toContain(state.capability);
    expect(responseText).not.toContain(state.linkSecret);
    expect(responseText).not.toContain(String(state.link.grantId));
    expect(responseText).not.toContain(SHARE_ID);

    const row = database
      .prepare("SELECT * FROM sync_relay_link_handoff_codes")
      .get();
    expect(row).toMatchObject({
      code_hash: hashLinkHandoffCode(code),
      grant_id: state.link.grantId,
      generation: 1,
      minted_at_ms: state.now.value,
      expires_at_ms: state.now.value + HANDOFF_TTL_MS,
      result_grant_id: null,
    });
    expect(row?.code_hash).not.toBe(code);
    const columns = database
      .prepare("PRAGMA table_info(sync_relay_link_handoff_codes)")
      .all()
      .map((column) => String(column.name));
    expect(columns).toEqual([
      "code_id",
      "code_hash",
      "grant_id",
      "generation",
      "minted_at_ms",
      "expires_at_ms",
      "result_grant_id",
    ]);
    expect(columns.some((column) => /user|redeem|identity|session|secret|plain|ip/iu.test(column)))
      .toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("requires a configured exchange key, needs no public origin, and charges both read budgets", async () => {
    const capabilityLimiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const grantLimiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const state = await setup({
      linkReadRateLimiter: capabilityLimiter,
      linkGrantReadRateLimiter: grantLimiter,
    });
    const database = inspect(state.dbPath, true);

    expect((await state.h(handoffRequest(state.capability))).status).toBe(200);
    expect(await serialized(await state.h(handoffRequest(state.capability)))).toEqual({
      status: 429,
      body: '{"ok":false,"error":"too many link reads","code":"link_read_rate_limited"}',
    });
    expect(codeCount(database)).toBe(1);

    const noConfiguredKey = handler(state.storage, {
      relayExchangeKey: undefined,
      shareWebOrigin: undefined,
    });
    await expectGeneric(await noConfiguredKey(handoffRequest(state.capability)));
    expect(codeCount(database)).toBe(1);

    const withoutPublicOrigin = handler(state.storage, {
      shareWebOrigin: undefined,
      relayExchangeKey: RELAY_EXCHANGE_KEY,
    });
    expect((await withoutPublicOrigin(handoffRequest(state.capability))).status).toBe(200);
    expect(codeCount(database)).toBe(2);
  });

  it("reopens the normalized handoff schema without losing a live code", async () => {
    const state = await setup();
    const minted = await mint(state);
    const codeHash = hashLinkHandoffCode(String(minted.code));

    const storageIndex = storages.indexOf(state.storage);
    expect(storageIndex).toBeGreaterThanOrEqual(0);
    storages.splice(storageIndex, 1);
    state.storage.close();

    const reopened = openSyncRelayStorage(state.dbPath);
    storages.push(reopened);
    const database = inspect(state.dbPath, true);
    expect(
      database
        .prepare("PRAGMA table_info(sync_relay_link_handoff_codes)")
        .all()
        .map((column) => String(column.name)),
    ).toContain("result_grant_id");
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index'
             AND name = 'idx_sync_relay_link_handoff_codes_result_grant'`,
        )
        .get(),
    ).toEqual({ name: "idx_sync_relay_link_handoff_codes_result_grant" });

    const first = reopened.redeemLinkHandoffCode({
      codeHash,
      principalUserId: RECIPIENT,
      redeemedAtMs: state.now.value,
      mintGrantId: () => "reopened-dependent-grant",
      guard: () => true,
    });
    expect(first).toMatchObject({ ok: true, grant: { access: "view" } });
    const retry = reopened.redeemLinkHandoffCode({
      codeHash,
      principalUserId: RECIPIENT,
      redeemedAtMs: state.now.value,
      mintGrantId: () => {
        throw new Error("receipt retry minted a second grant");
      },
      guard: () => {
        throw new Error("receipt retry re-authorized the bearer code");
      },
    });
    expect(retry).toEqual(first);
  });

  it("revalidates the exact capability and generation inside the mint transaction", async () => {
    const base = await setup();
    const database = inspect(base.dbPath);
    let armed = true;
    const raced = new Proxy(base.storage, {
      get(storage, property, receiver) {
        if (property === "mintLinkHandoffCode") {
          const mintCode = Reflect.get(storage, property, receiver) as (
            input: unknown,
          ) => boolean;
          return (input: unknown): boolean => {
            if (armed) {
              armed = false;
              database
                .prepare(
                  "UPDATE sync_relay_share_grants SET generation = generation + 1 WHERE grant_id = ?",
                )
                .run(String(base.link.grantId));
            }
            return mintCode.call(storage, input);
          };
        }
        const value = Reflect.get(storage, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(storage) : value;
      },
    });
    const h = handler(base.storage, { storage: raced });

    await expectGeneric(await h(handoffRequest(base.capability)));
    expect(armed).toBe(false);
    expect(codeCount(database)).toBe(0);
  });

  it("sweeps expiry and evicts the oldest code so thirty-three mints retain at most thirty-two", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const codes: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      state.now.value += 1;
      codes.push(String((await mint(state)).code));
    }
    expect(codeCount(database, String(state.link.grantId))).toBe(32);
    expect(
      database
        .prepare(
          "SELECT code_id FROM sync_relay_link_handoff_codes WHERE code_hash = ?",
        )
        .get(hashLinkHandoffCode(codes[0]!)),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT code_id FROM sync_relay_link_handoff_codes WHERE code_hash = ?",
        )
        .get(hashLinkHandoffCode(codes[32]!)),
    ).toBeDefined();
    await expectGeneric(await state.h(redeemRequest(RECIPIENT, codes[0])));
    expect((await state.h(redeemRequest(RECIPIENT, codes[32]))).status).toBe(200);

    state.now.value += HANDOFF_TTL_MS + 1;
    await mint(state);
    expect(codeCount(database, String(state.link.grantId))).toBe(1);
  });

  it("preserves unexpired receipts under handoff-code cap pressure", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const receiptCode = await mint(state);
    const receipt = await serialized(
      await state.h(redeemRequest(RECIPIENT, receiptCode.code)),
    );
    expect(receipt.status).toBe(200);

    const unredeemed: Array<Record<string, unknown>> = [];
    for (let index = 1; index < LINK_HANDOFF_CODES_PER_GRANT_LIMIT; index += 1) {
      state.now.value += 1;
      unredeemed.push(await mint(state));
    }
    expect(codeCount(database, String(state.link.grantId))).toBe(
      LINK_HANDOFF_CODES_PER_GRANT_LIMIT,
    );

    state.now.value += 1;
    const newest = await mint(state);
    expect(codeCount(database, String(state.link.grantId))).toBe(
      LINK_HANDOFF_CODES_PER_GRANT_LIMIT,
    );
    expect(
      await serialized(
        await state.h(redeemRequest(RECIPIENT, receiptCode.code)),
      ),
    ).toEqual(receipt);

    for (const code of [...unredeemed.slice(1), newest]) {
      expect(
        await serialized(
          await state.h(redeemRequest(RECIPIENT, code.code)),
        ),
      ).toEqual(receipt);
    }

    state.now.value += 1;
    const refusedMint = await serialized(
      await state.h(handoffRequest(state.capability)),
    );
    expect(refusedMint.status).toBe(GENERIC_REFUSAL.status);
    expect(refusedMint).toEqual(GENERIC_REFUSAL);
    expect(codeCount(database, String(state.link.grantId))).toBe(
      LINK_HANDOFF_CODES_PER_GRANT_LIMIT,
    );
    expect(
      await serialized(
        await state.h(redeemRequest(RECIPIENT, receiptCode.code)),
      ),
    ).toEqual(receipt);
  });

  it("shows no redeemer identity before redeem and one server-derived View dependent after success", async () => {
    const state = await setup();
    const before = await ownerInventory(state);
    expect(before[0]?.dependents).toEqual([]);
    expect(JSON.stringify(before)).not.toContain(RECIPIENT);

    const minted = await mint(state);
    const response = await state.h(redeemRequest(RECIPIENT, minted.code));
    expect(response.status).toBe(200);
    const redeemed = await json(response);
    expect(Object.keys(redeemed).sort()).toEqual([
      "access",
      "grantId",
      "ok",
      "shareId",
    ]);
    expect(redeemed).toMatchObject({ ok: true, shareId: SHARE_ID, access: "view" });

    const after = await ownerInventory(state);
    expect(after[0]?.dependents).toEqual([
      {
        grantId: redeemed.grantId,
        recipientUserId: RECIPIENT,
        recipientEmail: `${RECIPIENT}@example.test`,
        access: "view",
        generation: 1,
        createdAtMs: state.now.value,
      },
    ]);
  });

  it("hands off Comment access and gives the named recipient the current link level", async () => {
    const state = await setup({}, "comment");
    expect(state.link).toMatchObject({ access: "comment", generation: 1 });

    const minted = await mint(state);
    const response = await state.h(redeemRequest(RECIPIENT, minted.code));
    expect(response.status).toBe(200);
    const redeemed = await json(response);
    expect(redeemed).toMatchObject({
      ok: true,
      shareId: SHARE_ID,
      access: "comment",
    });
    expect(state.storage.getShareGrant(String(redeemed.grantId))).toMatchObject({
      access: "comment",
      generation: 1,
      parentGrantId: state.link.grantId,
    });
  });

  it.each(["retune", "revoke"] as const)(
    "refuses a Comment handoff redeem when %s wins before the storage commit",
    async (transition) => {
      const state = await setup({}, "comment");
      const minted = await mint(state);
      let armed = true;
      const racedStorage = new Proxy(state.storage, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (property !== "redeemLinkHandoffCode" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (input: Parameters<SyncRelayStorage["redeemLinkHandoffCode"]>[0]) => {
            if (armed) {
              armed = false;
              if (transition === "retune") {
                expect(
                  target.retuneShareGrant({
                    shareId: SHARE_ID,
                    grantId: String(state.link.grantId),
                    access: "view",
                    changedAtMs: state.now.value + 1,
                    expectedDependentGrantIds: [],
                    guard: () => undefined,
                  }),
                ).toMatchObject({ ok: true });
              } else {
                expect(
                  target.revokeShareGrant({
                    shareId: SHARE_ID,
                    grantId: String(state.link.grantId),
                    revokedAtMs: state.now.value + 1,
                  }),
                ).toMatchObject({ ok: true });
              }
            }
            return target.redeemLinkHandoffCode(input);
          };
        },
      });
      const racedHandler = handler(state.storage, {
        storage: racedStorage,
        nowMs: () => state.now.value,
        newGrantId: () => `raced-${transition}-dependent`,
      });

      await expectGeneric(
        await racedHandler(redeemRequest(RECIPIENT, minted.code)),
      );
      expect(armed).toBe(false);
      expect(
        dependentRows(
          inspect(state.dbPath, true),
          String(state.link.grantId),
          RECIPIENT,
        ),
      ).toEqual([]);
    },
  );

  it("caps active dependents at the owner mutation boundary without blocking an existing account", async () => {
    const state = await setup();
    const database = inspect(state.dbPath);
    const existingCode = await mint(state);
    const overflowCode = await mint(state);
    const parentGrantId = String(state.link.grantId);
    const dependentIds: string[] = [];
    const insertDependent = database.prepare(
      `INSERT INTO sync_relay_share_grants (
         grant_id, share_id, principal_kind, principal_user_id, principal_email,
         access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
       ) VALUES (?, ?, 'user', ?, NULL, 'view', 1, 'active', ?, NULL, ?)`,
    );
    database.exec("BEGIN");
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const suffix = String(index).padStart(4, "0");
        const grantId = `dependent-grant-${suffix}`;
        dependentIds.push(grantId);
        insertDependent.run(
          grantId,
          SHARE_ID,
          index === 0 ? RECIPIENT : `dependent-user-${suffix}`,
          state.now.value + index,
          parentGrantId,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const existingFirst = await serialized(
      await state.h(redeemRequest(RECIPIENT, existingCode.code)),
    );
    expect(existingFirst.status).toBe(200);
    expect(JSON.parse(existingFirst.body)).toMatchObject({
      ok: true,
      grantId: dependentIds[0],
      access: "view",
    });
    expect(
      await serialized(
        await state.h(redeemRequest(RECIPIENT, existingCode.code)),
      ),
    ).toEqual(existingFirst);

    await expectGeneric(
      await state.h(redeemRequest(OTHER_ACCOUNT, overflowCode.code)),
    );
    expect(dependentRows(database, parentGrantId)).toHaveLength(1_000);
    expect(dependentRows(database, parentGrantId, OTHER_ACCOUNT)).toEqual([]);

    const inventory = await ownerInventory(state);
    expect(inventory).toHaveLength(1);
    const inventoryDependentIds = (
      inventory[0]?.dependents as Array<Record<string, unknown>>
    ).map((dependent) => String(dependent.grantId));
    expect(inventoryDependentIds).toEqual(dependentIds);

    const rotated = await state.h(
      request(
        OWNER,
        `/sync/shares/${SHARE_ID}/links/${parentGrantId}/rotate`,
        jsonBody({
          workspaceId: WORKSPACE,
          expectedDependentGrantIds: inventoryDependentIds,
        }),
      ),
    );
    expect(rotated.status).toBe(200);
    expect(dependentRows(database, parentGrantId)).toHaveLength(1_000);
  });

  it("returns the same receipt to the same account and refuses another account", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const minted = await mint(state);
    const first = await serialized(
      await state.h(redeemRequest(RECIPIENT, minted.code)),
    );
    expect(first.status).toBe(200);
    const firstBody = JSON.parse(first.body) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ ok: true, access: "view" });

    const retry = await serialized(
      await state.h(redeemRequest(RECIPIENT, minted.code)),
    );
    expect(retry).toEqual(first);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toHaveLength(1);
    expect(codeCount(database)).toBe(1);
    expect(
      database
        .prepare(
          "SELECT result_grant_id FROM sync_relay_link_handoff_codes WHERE code_hash = ?",
        )
        .get(hashLinkHandoffCode(String(minted.code))),
    ).toEqual({ result_grant_id: firstBody.grantId });

    expect(
      await serialized(
        await state.h(redeemRequest(OTHER_ACCOUNT, minted.code)),
      ),
    ).toEqual(GENERIC_REFUSAL);

    state.now.value = Number(minted.expiresAtMs);
    await expectGeneric(await state.h(redeemRequest(RECIPIENT, minted.code)));
    expect(codeCount(database)).toBe(0);
  });

  it("stops a raced redeem when the conditional receipt update changes zero rows", async () => {
    const state = await setup();
    const database = inspect(state.dbPath);
    const minted = await mint(state);
    const codeHash = hashLinkHandoffCode(String(minted.code));
    database.exec(`
      CREATE TRIGGER consume_handoff_before_redeem
      BEFORE UPDATE OF result_grant_id ON sync_relay_link_handoff_codes
      WHEN OLD.code_hash = '${codeHash}'
      BEGIN
        DELETE FROM sync_relay_link_handoff_codes WHERE code_id = OLD.code_id;
      END;
    `);

    await expectGeneric(await state.h(redeemRequest(RECIPIENT, minted.code)));
    expect(codeCount(database)).toBe(0);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toEqual([]);
  });

  it("returns the same active grant for two different valid codes redeemed by one account", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const firstCode = await mint(state);
    const secondCode = await mint(state);
    const first = await json(await state.h(redeemRequest(RECIPIENT, firstCode.code)));
    const second = await json(await state.h(redeemRequest(RECIPIENT, secondCode.code)));
    expect(first).toMatchObject({ ok: true, access: "view" });
    expect(second).toEqual(first);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toHaveLength(1);
  });

  it("makes a separately revoked dependent durable and consumes owner self-redeem", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const firstCode = await mint(state);
    const first = await json(await state.h(redeemRequest(RECIPIENT, firstCode.code)));
    expect(
      state.storage.revokeShareGrant({
        shareId: SHARE_ID,
        grantId: String(first.grantId),
        revokedAtMs: state.now.value + 1,
      }),
    ).toMatchObject({ ok: true });
    await expectGeneric(await state.h(redeemRequest(RECIPIENT, firstCode.code)));

    const freshCode = await mint(state);
    await expectGeneric(await state.h(redeemRequest(RECIPIENT, freshCode.code)));
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toMatchObject([
      { status: "revoked" },
    ]);

    const ownerCode = await mint(state);
    await expectGeneric(await state.h(redeemRequest(OWNER, ownerCode.code)));
    expect(codeCount(database)).toBe(0);
    expect(dependentRows(database, String(state.link.grantId), OWNER)).toEqual([]);
  });

  it("does not count a promoted grant as an existing dependent", async () => {
    const state = await setup();
    const database = inspect(state.dbPath, true);
    const first = await json(
      await state.h(redeemRequest(OTHER_ACCOUNT, (await mint(state)).code)),
    );
    expect(
      state.storage.promoteShareGrant({
        shareId: SHARE_ID,
        grantId: String(first.grantId),
        expectedParentGrantId: String(state.link.grantId),
        expectedParentGeneration: 1,
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true, grant: { parentGrantId: null } });

    const second = await json(
      await state.h(redeemRequest(OTHER_ACCOUNT, (await mint(state)).code)),
    );
    expect(second.grantId).not.toBe(first.grantId);
    expect(dependentRows(database, String(state.link.grantId), OTHER_ACCOUNT)).toHaveLength(1);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM sync_relay_share_grants
           WHERE principal_user_id = ? AND parent_grant_id IS NULL`,
        )
        .get(OTHER_ACCOUNT)?.count,
    ).toBe(1);
  });

  it.each([
    "rotation",
    "storage retune generation change",
  ] as const)("refuses a stale code after %s", async (transition) => {
    const state = await setup();
    const database = inspect(state.dbPath);
    const minted = await mint(state);
    if (transition === "rotation") {
      const rotated = await state.h(
        request(
          OWNER,
          `/sync/shares/${SHARE_ID}/links/${String(state.link.grantId)}/rotate`,
          jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
        ),
      );
      expect(rotated.status).toBe(200);
    } else {
      database
        .prepare(
          "UPDATE sync_relay_share_grants SET generation = generation + 1 WHERE grant_id = ?",
        )
        .run(String(state.link.grantId));
    }

    await expectGeneric(await state.h(redeemRequest(RECIPIENT, minted.code)));
    expect(codeCount(database)).toBe(0);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toEqual([]);
  });

  it.each([
    "expiry",
    "link revoke",
    "whole-share revoke",
    "granter ownership loss",
  ] as const)("consumes and generically refuses after %s", async (transition) => {
    const state = await setup();
    const database = inspect(state.dbPath);
    const minted = await mint(state);
    if (transition === "expiry") {
      state.now.value = Number(minted.expiresAtMs);
    } else if (transition === "link revoke") {
      expect(
        state.storage.revokeShareGrant({
          shareId: SHARE_ID,
          grantId: String(state.link.grantId),
          revokedAtMs: state.now.value + 1,
        }),
      ).toMatchObject({ ok: true });
    } else if (transition === "whole-share revoke") {
      expect(state.storage.revokeShare(SHARE_ID, state.now.value + 1)).toBe(true);
    } else {
      database
        .prepare(
          "UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?",
        )
        .run("new-owner", WORKSPACE);
    }

    await expectGeneric(await state.h(redeemRequest(RECIPIENT, minted.code)));
    expect(codeCount(database)).toBe(0);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toEqual([]);
  });

  it("keeps link secrets, live capabilities, malformed values, and unknown codes in separate credential families", async () => {
    const state = await setup();
    const minted = await mint(state);
    for (const candidate of [
      state.linkSecret,
      state.capability,
      "not-base64url",
      "u".repeat(43),
      "",
      null,
    ]) {
      await expectGeneric(await state.h(redeemRequest(RECIPIENT, candidate)));
    }
    await expectGeneric(
      await state.h(redeemRequest(RECIPIENT, minted.code, { accountId: "victim" })),
    );
    expect((await state.h(redeemRequest(null, minted.code))).status).toBe(401);

    const redeemed = await state.h(redeemRequest(RECIPIENT, minted.code));
    expect(redeemed.status).toBe(200);
    const database = inspect(state.dbPath, true);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toHaveLength(1);
    expect(dependentRows(database, String(state.link.grantId), "victim")).toEqual([]);
  });

  it("cascades codes with grant and share deletion and enforces one active dependent per parent account", async () => {
    const state = await setup();
    const database = inspect(state.dbPath);
    const firstCode = await mint(state);
    const redeemed = await json(
      await state.h(redeemRequest(RECIPIENT, firstCode.code)),
    );
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_relay_share_grants (
             grant_id, share_id, principal_kind, principal_user_id, principal_email,
             access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
           ) VALUES (?, ?, 'user', ?, NULL, 'view', 1, 'active', ?, NULL, ?)`,
        )
        .run(
          "duplicate-active-dependent",
          SHARE_ID,
          RECIPIENT,
          state.now.value,
          String(state.link.grantId),
        ),
    ).toThrow(/UNIQUE/iu);
    expect(dependentRows(database, String(state.link.grantId), RECIPIENT)).toMatchObject([
      { grant_id: redeemed.grantId, status: "active" },
    ]);

    await mint(state);
    expect(codeCount(database, String(state.link.grantId))).toBe(2);
    database
      .prepare("DELETE FROM sync_relay_share_grants WHERE parent_grant_id = ?")
      .run(String(state.link.grantId));
    database
      .prepare("DELETE FROM sync_relay_share_grants WHERE grant_id = ?")
      .run(String(state.link.grantId));
    expect(codeCount(database)).toBe(0);

    const secondLinkResponse = await state.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/${SHARE_ID}/links`,
        jsonBody({ access: "view" }),
      ),
    );
    expect(secondLinkResponse.status).toBe(200);
    const secondLink = await json(secondLinkResponse);
    const exchange = await json(
      await state.h(
        request(null, "/sync/link-exchange", {
          ...jsonBody({ secret: linkSecret(secondLink.url) }),
          headers: {
            "content-type": "application/json",
            "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
          },
        }),
      ),
    );
    expect(
      (
        await state.h(
          handoffRequest(String(exchange.capabilityToken)),
        )
      ).status,
    ).toBe(200);
    expect(codeCount(database, String(secondLink.grantId))).toBe(1);
    database.prepare("DELETE FROM sync_relay_shares WHERE share_id = ?").run(SHARE_ID);
    expect(codeCount(database)).toBe(0);
  });
});
