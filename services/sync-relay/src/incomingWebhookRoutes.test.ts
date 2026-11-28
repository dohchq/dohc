import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { INBOX_COLLECTION_YAML, INBOX_SCHEMA_PATH } from "@dohc/workspace-contracts/inbox";
import {
  INCOMING_WEBHOOK_DAILY_DELIVERY_CAP,
  INCOMING_WEBHOOK_FORM_SENDER_BURST,
  MAX_INCOMING_WEBHOOK_BODY_BYTES,
  MAX_INCOMING_WEBHOOK_FORM_BODY_BYTES,
  MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT,
  MAX_INCOMING_WEBHOOK_PENDING_BYTES,
  MAX_INCOMING_WEBHOOK_PENDING_COUNT,
  MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
} from "@dohc/workspace-contracts/incoming-webhooks";
import {
  AUTOMATION_SERVER_INSTALL_ID,
  AUTOMATION_SERVER_MAX_WORKSPACES,
} from "@dohc/workspace-contracts/relay";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainIncomingWebhooksForWorkspace,
  type IncomingWebhookDrainAdapter,
} from "./incomingWebhookDrain";
import {
  fenceAccount,
  initializeAccountDeletion,
  purgeAccountRows,
} from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import {
  MAX_INCOMING_WEBHOOK_DRAIN_ATTEMPTS,
  INCOMING_WEBHOOK_RETRY_BASE_MS,
} from "./storage/incomingWebhooks";
import {
  closeTestStorage,
  closeTestStorages,
  countRows,
  createShare,
  inspect,
  inspectDatabase,
  jsonBody,
  LINK_KEY,
  reopenTestStorage,
  request,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

afterEach(async () => {
  await closeTestStorages();
});

const resolveDesktopOrOtherSession: ResolveAccountSession = async (req) => {
  const match = /^Bearer (user|browser|phone):([^ ]+)$/u.exec(
    req.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  const kind = match[1] === "browser" ? "browser" : match[1] === "phone" ? "phone" : "desktop";
  return {
    userId: match[2]!,
    sessionId: `${kind}:${match[2]!}`,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: kind,
  };
};

async function setup(options?: { nowMs?: () => number; automationServerEnabled?: boolean }) {
  let clock = 1_760_000_000_000;
  const nowMs = options?.nowMs ?? (() => clock);
  const storage = (await testStorage()) as StorageContext;
  storage.claimWorkspace({ workspaceId: "ws-1", ownerUserId: "owner", createdAtMs: 1 });
  const automationServerEnabled = options?.automationServerEnabled ?? true;
  const handler = testHandler(storage, {
    nowMs,
    relayPublicOrigin: "https://sync.example.com",
    resolvePhoneCapableAccountSession: resolveDesktopOrOtherSession,
    ...(automationServerEnabled
      ? {
          automationServer: { label: "dohc server" },
        }
      : {}),
  });
  return {
    storage,
    handler,
    advanceMs: (delta: number) => {
      clock += delta;
    },
    setNowMs: (value: number) => {
      clock = value;
    },
  };
}

function publicHookRequest(token: string, init: RequestInit = {}): Request {
  return new Request(`https://sync.example.com/sync/hooks/${token}`, {
    method: "POST",
    ...init,
  });
}

describe("incoming webhooks relay routes and drain", () => {
  it("enforces desktop-only owner auth, CRUD, one-time token reveal, rotation, and 20-webhook limit", async () => {
    const { storage, handler } = await setup();

    // Non-desktop, cookie, unauthenticated, and non-owner sessions all get opaque 404 (no workspace oracle).
    const unauth = await handler(new Request("https://sync.example.com/sync/ws-1/webhooks"));
    expect(unauth.status).toBe(404);

    const browser = await handler(
      new Request("https://sync.example.com/sync/ws-1/webhooks", {
        headers: { authorization: "Bearer browser:owner" },
      }),
    );
    expect(browser.status).toBe(404);

    const phone = await handler(
      new Request("https://sync.example.com/sync/ws-1/webhooks", {
        headers: { authorization: "Bearer phone:owner" },
      }),
    );
    expect(phone.status).toBe(404);

    const withCookie = await handler(
      new Request("https://sync.example.com/sync/ws-1/webhooks", {
        headers: {
          authorization: "Bearer user:owner",
          cookie: "dohc_session=abc",
        },
      }),
    );
    expect(withCookie.status).toBe(404);

    const otherUser = await handler(request("other-user", "/sync/ws-1/webhooks"));
    expect(otherUser.status).toBe(404);

    // `/sync/hooks/:token` matches BEFORE `/sync/:workspaceId`, and deeper `/sync/hooks/...` paths are rejected.
    const hooksGet = await handler(request("owner", "/sync/hooks/webhooks"));
    expect(hooksGet.status).toBe(405);
    const reserved = await handler(request("owner", "/sync/hooks/blobs/have", { method: "POST" }));
    expect(reserved.status).toBe(404);

    // Create returns token once; GET never returns raw token or token_hash.
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "iPhone Shortcut", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const createdJson = (await created.json()) as {
      ok: boolean;
      webhook: { webhookId: string; name: string; collectionPath: string; paused: boolean };
      token: string;
      endpointUrl: string;
      webhooks: unknown[];
      limit: number;
    };
    expect(createdJson.ok).toBe(true);
    expect(createdJson.token.length).toBeGreaterThanOrEqual(32);
    expect(createdJson.endpointUrl).toBe(
      `https://sync.example.com/sync/hooks/${createdJson.token}`,
    );
    expect(createdJson.limit).toBe(MAX_INCOMING_WEBHOOKS_PER_WORKSPACE);

    const listed = await handler(request("owner", "/sync/ws-1/webhooks"));
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(createdJson.token);
    expect(listedText).not.toContain("tokenHash");
    expect(listedText).not.toContain("token_hash");

    // Rename & pause & resume.
    const webhookId = createdJson.webhook.webhookId;
    const paused = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhookId}`, {
        ...jsonBody({ name: "Renamed Shortcut", paused: true }),
        method: "PATCH",
      }),
    );
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as {
      webhook: { name: string; paused: boolean };
    };
    expect(pausedBody.webhook.name).toBe("Renamed Shortcut");
    expect(pausedBody.webhook.paused).toBe(true);

    // Paused webhook returns opaque 404 on public ingress.
    const pausedPost = await handler(
      publicHookRequest(createdJson.token, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Ignored" }),
      }),
    );
    expect(pausedPost.status).toBe(404);
    expect(await pausedPost.json()).toEqual({ ok: false, error: "not found" });

    // Resume then rotate: old token immediately returns opaque 404, new token returns 202.
    const resumed = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhookId}`, {
        ...jsonBody({ paused: false }),
        method: "PATCH",
      }),
    );
    expect(resumed.status).toBe(200);

    const rotated = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhookId}/rotate`, { method: "POST" }),
    );
    expect(rotated.status).toBe(200);
    const rotatedJson = (await rotated.json()) as { token: string };
    expect(rotatedJson.token).not.toBe(createdJson.token);

    const oldTokenPost = await handler(
      publicHookRequest(createdJson.token, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Stale token" }),
      }),
    );
    expect(oldTokenPost.status).toBe(404);
    expect(await oldTokenPost.json()).toEqual({ ok: false, error: "not found" });

    const newTokenPost = await handler(
      publicHookRequest(rotatedJson.token, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Fresh token" }),
      }),
    );
    expect(newTokenPost.status).toBe(202);

    // Create up to 20 webhooks -> 21st returns 409 limit reached.
    for (let i = 1; i < MAX_INCOMING_WEBHOOKS_PER_WORKSPACE; i += 1) {
      const res = await handler(
        request("owner", "/sync/ws-1/webhooks", {
          ...jsonBody({ name: `Hook ${i}`, collectionPath: "Inbox" }),
          method: "POST",
        }),
      );
      expect(res.status).toBe(201);
    }
    const overLimit = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Hook 21", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(overLimit.status).toBe(409);

    // Delete removes webhook and makes its token return opaque 404.
    const deleted = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhookId}`, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await handler(
      publicHookRequest(rotatedJson.token, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Deleted" }),
      }),
    );
    expect(afterDelete.status).toBe(404);
    expect(countRows(storagePath(storage), "sync_relay_incoming_webhooks")).toBe(
      MAX_INCOMING_WEBHOOKS_PER_WORKSPACE - 1,
    );
  });

  it("lets a form on another website read each delivery answer, but not the owner's routes", async () => {
    const { handler } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Waitlist", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.headers.get("access-control-allow-origin")).toBeNull();
    const { token } = (await created.json()) as { token: string };
    const formPost = (hookToken: string, init: RequestInit = {}) =>
      handler(
        publicHookRequest(hookToken, {
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://dohc.computer",
          },
          body: "email=ada%40example.com",
          ...init,
        }),
      );

    const accepted = await formPost(token);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("access-control-allow-origin")).toBe("*");
    const unknown = await formPost("a".repeat(43));
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("access-control-allow-origin")).toBe("*");
    const unsupported = await formPost(token, {
      headers: { "content-type": "text/html", origin: "https://dohc.computer" },
    });
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers.get("access-control-allow-origin")).toBe("*");

    const listed = await handler(request("owner", "/sync/ws-1/webhooks"));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps a website form to its fields, gives each network a share, and gives the form its own queue", async () => {
    const { storage, handler, advanceMs } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({
          name: "Waitlist",
          collectionPath: "Inbox",
          form: { fields: ["email", "source"] },
        }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { token, webhook } = (await created.json()) as {
      token: string;
      webhook: { form: unknown };
    };
    expect(webhook.form).toEqual({ fields: ["email", "source"] });
    const plain = (await (
      await handler(
        request("owner", "/sync/ws-1/webhooks", {
          ...jsonBody({ name: "Shortcut", collectionPath: "Inbox" }),
          method: "POST",
        }),
      )
    ).json()) as { token: string };

    let nextSender = 0;
    const post = (
      body: string,
      init: { sender?: string; contentType?: string; hook?: string } = {},
    ) =>
      handler(
        publicHookRequest(init.hook ?? token, {
          headers: {
            "content-type": init.contentType ?? "application/x-www-form-urlencoded",
            "x-dohc-relay-client-ip": init.sender ?? `198.51.100.${++nextSender}`,
          },
          body,
        }),
      );
    const answer = async (response: Response) => ({
      status: response.status,
      error: ((await response.json()) as { error?: string }).error,
    });

    const kept = await post("email=ada%40example.com&source=site&card=4111111111111111");
    expect(kept.status).toBe(202);
    const { deliveryId } = (await kept.json()) as { deliveryId: string };
    const stored = inspect(storagePath(storage), (db) =>
      db
        .prepare("SELECT payload_blob FROM sync_relay_webhook_deliveries WHERE delivery_id = ?")
        .get(deliveryId),
    ) as { payload_blob: Uint8Array };
    expect(Buffer.from(stored.payload_blob).toString("utf8")).toBe(
      "email=ada%40example.com&source=site",
    );

    expect(
      (await post('{"email":"ada@example.com"}', { contentType: "application/json" })).status,
    ).toBe(415);
    expect(await answer(await post("card=4111111111111111"))).toMatchObject({ status: 422 });
    expect(await answer(await post("email=not-an-address"))).toMatchObject({ status: 422 });
    expect(await answer(await post("email=a%40example.com&email=b%40example.com"))).toMatchObject({
      status: 422,
    });
    expect((await post(`email=${"a".repeat(MAX_INCOMING_WEBHOOK_FORM_BODY_BYTES)}`)).status).toBe(
      413,
    );

    // One network's burst, then a refusal. Addresses in the same IPv6 /64 share it; the next /64 does not.
    const burst = async (sender: string) => {
      const statuses: number[] = [];
      for (let i = 0; i <= INCOMING_WEBHOOK_FORM_SENDER_BURST; i += 1) {
        statuses.push(
          (await post(`email=s${i}%40example.com`, { sender: `${sender}${i + 1}` })).status,
        );
      }
      return statuses;
    };
    expect(await burst("2001:db8:1:2::")).toEqual([
      ...Array.from({ length: INCOMING_WEBHOOK_FORM_SENDER_BURST }, () => 202),
      429,
    ]);
    expect(
      await answer(await post("email=late%40example.com", { sender: "2001:db8:1:2:ffff::1" })),
    ).toEqual({ status: 429, error: "too many submissions from this network" });
    expect((await post("email=next%40example.com", { sender: "2001:db8:1:3::1" })).status).toBe(
      202,
    );
    advanceMs(86_400_000);
    expect((await post("email=tomorrow%40example.com", { sender: "2001:db8:1:2::9" })).status).toBe(
      202,
    );

    // The form's own queue fills while the workspace's other webhooks keep their share.
    const pending = () =>
      inspect(storagePath(storage), (db) =>
        Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM sync_relay_webhook_deliveries WHERE state IN ('pending', 'accepted')",
              )
              .get() as { count: number }
          ).count,
        ),
      );
    while (pending() < MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT) {
      advanceMs(60_000);
      expect((await post("email=fill%40example.com")).status).toBe(202);
    }
    advanceMs(60_000);
    expect(await answer(await post("email=full%40example.com"))).toEqual({
      status: 429,
      error: `form webhook pending queue full (${MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT} of ${MAX_INCOMING_WEBHOOK_FORM_PENDING_COUNT} deliveries)`,
    });
    expect(
      (await post('{"title":"still open"}', { hook: plain.token, contentType: "application/json" }))
        .status,
    ).toBe(202);
  });

  it("adds the form column to a store opened by an older build", async () => {
    const storage = await testStorage();
    const dbPath = storagePath(storage);
    closeTestStorage(storage);
    const db = inspectDatabase(dbPath);
    db.exec("ALTER TABLE sync_relay_incoming_webhooks DROP COLUMN form_json");
    db.exec("DELETE FROM sync_relay_migrations WHERE migration_id = 'incoming-webhook-form-v1'");
    db.close();
    closeTestStorage(reopenTestStorage(dbPath));
    expect(
      inspect(dbPath, (inspected) => ({
        column: inspected
          .prepare(
            "SELECT name FROM pragma_table_info('sync_relay_incoming_webhooks') WHERE name = 'form_json'",
          )
          .get(),
        marked: inspected
          .prepare(
            "SELECT 1 AS marked FROM sync_relay_migrations WHERE migration_id = 'incoming-webhook-form-v1'",
          )
          .get(),
      })),
    ).toEqual({ column: { name: "form_json" }, marked: { marked: 1 } });
  });

  it("enforces public ingress defenses: method, loop depth, opaque 404 before rate limit, content-type, streaming 256 KiB cap, allowlisted headers, idempotency, and per-endpoint burst", async () => {
    const { storage, handler } = await setup();

    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Ingest", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    const { token } = (await created.json()) as { token: string };

    // Non-POST -> 405
    const getResp = await handler(publicHookRequest(token, { method: "GET" }));
    expect(getResp.status).toBe(405);

    // Chain depth >= 4 -> 422
    const loopResp = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "application/json",
          "x-dohc-chain-depth": "4",
        },
        body: JSON.stringify({ title: "Loop" }),
      }),
    );
    expect(loopResp.status).toBe(422);

    // Unknown / malformed token probing uses its own probe bucket and does not starve valid tokens.
    for (let i = 0; i < 40; i += 1) {
      const probe = await handler(
        publicHookRequest(`unknown_${String(i).padStart(32, "0")}`, {
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(probe.status).toBe(404);
      expect(await probe.json()).toEqual({ ok: false, error: "not found" });
    }

    // Disallowed Content-Type -> 415
    const badType = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/html" },
        body: "<h1>no</h1>",
      }),
    );
    expect(badType.status).toBe(415);

    // Oversized body > 256 KiB (with Content-Length) -> 413
    const tooLarge = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_INCOMING_WEBHOOK_BODY_BYTES + 1),
        },
        body: "x".repeat(MAX_INCOMING_WEBHOOK_BODY_BYTES + 1),
      }),
    );
    expect(tooLarge.status).toBe(413);

    // Oversized streamed body without Content-Length -> 413
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(64 * 1024).fill(65);
        for (let i = 0; i < 5; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamedTooLarge = await handler(
      new Request(`https://sync.example.com/sync/hooks/${token}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: oversizedStream,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamedTooLarge.status).toBe(413);

    // Valid POST strips non-allowlisted headers (Authorization, Cookie, X-Custom-Secret) and supports idempotency.
    const body = JSON.stringify({ title: "Receipt from shortcut" });
    const first = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "idempotency-key": "evt-001",
          "x-event-type": "shortcut.capture",
          authorization: "Bearer should-be-stripped",
          cookie: "session=should-be-stripped",
          "x-api-key": "secret-should-be-stripped",
        },
        body,
      }),
    );
    expect(first.status).toBe(202);
    const firstJson = (await first.json()) as { ok: boolean; deliveryId: string };
    expect(firstJson.ok).toBe(true);
    expect(firstJson.deliveryId).toMatch(/^whd_/u);

    const storedRow = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT headers_json, payload_bytes FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(firstJson.deliveryId),
    ) as { headers_json: string; payload_bytes: number };
    const storedHeaders = JSON.parse(storedRow.headers_json) as Record<string, string>;
    expect(storedHeaders["x-event-type"]).toBe("shortcut.capture");
    expect(storedHeaders["idempotency-key"]).toBe("evt-001");
    expect(storedHeaders).not.toHaveProperty("authorization");
    expect(storedHeaders).not.toHaveProperty("cookie");
    expect(storedHeaders).not.toHaveProperty("x-api-key");

    // Same Idempotency-Key + same body -> 202 deduplicated
    const replay = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "application/json",
          "idempotency-key": "evt-001",
        },
        body,
      }),
    );
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({
      ok: true,
      deliveryId: firstJson.deliveryId,
      deduplicated: true,
    });

    // Same Idempotency-Key + different body -> 409 conflict
    const conflict = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "application/json",
          "idempotency-key": "evt-001",
        },
        body: JSON.stringify({ title: "Tampered body" }),
      }),
    );
    expect(conflict.status).toBe(409);

    // Per-endpoint burst limit (30 burst) -> 429 once exhausted.
    let hit429 = false;
    for (let i = 0; i < 35; i += 1) {
      const res = await handler(
        publicHookRequest(token, {
          headers: { "content-type": "text/plain" },
          body: `msg-${i}`,
        }),
      );
      if (res.status === 429) {
        hit429 = true;
        break;
      }
      expect(res.status).toBe(202);
    }
    expect(hit429).toBe(true);
  });

  it("enforces 500/day cap with at most one daily Notice, 100 pending count, and 4 MiB pending byte budget", async () => {
    const { storage, handler, advanceMs } = await setup();

    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Budget Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    const { webhook, token } = (await created.json()) as {
      webhook: { webhookId: string };
      token: string;
    };

    // Pending byte budget (4 MiB): 17 x 250 KiB -> 17th exceeds 4 MiB pending bytes!
    const largeChunk = "a".repeat(250 * 1024);
    let pendingBytesHit = false;
    for (let i = 0; i < 20; i += 1) {
      advanceMs(5_000); // refill token bucket
      const res = await handler(
        publicHookRequest(token, {
          headers: { "content-type": "text/plain" },
          body: largeChunk,
        }),
      );
      if (res.status === 429) {
        const json = (await res.json()) as { error: string };
        expect(json.error).toContain(String(MAX_INCOMING_WEBHOOK_PENDING_BYTES));
        pendingBytesHit = true;
        break;
      }
      expect(res.status).toBe(202);
    }
    expect(pendingBytesHit).toBe(true);

    // Clear those large pending deliveries directly as settled so we can test pending count (100) and daily cap (500).
    storage.db
      .prepare(
        "UPDATE sync_relay_webhook_deliveries SET state = 'settled', payload_blob = NULL, payload_bytes = 0, storage_bytes = 0 WHERE webhook_id = ?",
      )
      .run(webhook.webhookId);

    // Pending count cap (100): enqueue 100 small pending deliveries -> 101st returns 429 naming 100!
    for (let i = 0; i < MAX_INCOMING_WEBHOOK_PENDING_COUNT; i += 1) {
      advanceMs(5_000);
      const res = await handler(
        publicHookRequest(token, {
          headers: { "content-type": "text/plain" },
          body: `small-${i}`,
        }),
      );
      expect(res.status).toBe(202);
    }
    advanceMs(5_000);
    const overPendingCount = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "small-overflow",
      }),
    );
    expect(overPendingCount.status).toBe(429);
    expect(((await overPendingCount.json()) as { error: string }).error).toContain(
      String(MAX_INCOMING_WEBHOOK_PENDING_COUNT),
    );

    // Simulate 500 deliveries already received today (keeping one with idempotency key to prove retry still works!).
    const baseMs = 1_760_054_400_000; // Clean UTC day boundary
    const { handler: cappedHandler, storage: cappedStorage } = await setup({
      nowMs: () => baseMs + 10_000,
    });
    const created2 = await cappedHandler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Daily Cap Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created2.status).toBe(201);
    const { webhook: wh2, token: tok2 } = (await created2.json()) as {
      webhook: { webhookId: string };
      token: string;
    };
    const insert = cappedStorage.db.prepare(
      `INSERT INTO sync_relay_webhook_deliveries (
         delivery_id, webhook_id, workspace_id, delivery_key, payload_sha256, content_type,
         headers_json, payload_blob, payload_bytes, storage_bytes, state, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 'ws-1', ?, ?, 'text/plain', '{}', NULL, 0, 0, 'settled', ?, ?)`,
    );
    for (let i = 0; i < INCOMING_WEBHOOK_DAILY_DELIVERY_CAP; i += 1) {
      insert.run(
        `whd_cap_${String(i).padStart(6, "0")}`,
        wh2.webhookId,
        i === 0 ? "retry-key" : null,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        baseMs + i,
        baseMs + i,
      );
    }

    // Idempotency retry STILL succeeds at 500/day cap!
    const retryAtCap = await cappedHandler(
      publicHookRequest(tok2, {
        headers: { "content-type": "text/plain", "idempotency-key": "retry-key" },
        body: "hello world",
      }),
    );
    expect(retryAtCap.status).toBe(202);
    expect(await retryAtCap.json()).toEqual({
      ok: true,
      deliveryId: "whd_cap_000000",
      deduplicated: true,
    });

    // Two new deliveries past 500/day both return 429, and record strictly ONE Notice naming 500 deliveries/day.
    const cap1 = await cappedHandler(
      publicHookRequest(tok2, {
        headers: { "content-type": "text/plain" },
        body: "one too many",
      }),
    );
    expect(cap1.status).toBe(429);
    const cap2 = await cappedHandler(
      publicHookRequest(tok2, {
        headers: { "content-type": "text/plain" },
        body: "two too many",
      }),
    );
    expect(cap2.status).toBe(429);

    const notices = inspect(storagePath(cappedStorage), (db) =>
      db
        .prepare(
          "SELECT body FROM sync_relay_notices WHERE workspace_id = ? AND recipient_user_id = ?",
        )
        .all("ws-1", "owner"),
    ) as Array<{ body: string }>;
    const capNotices = notices.filter((n) => n.body.includes("500 deliveries/day"));
    expect(capNotices).toHaveLength(1);
  });

  it("drains deliveries under host generation fence, lazily initializes Inbox, quarantines payload, survives handover crash idempotently, releases usage bytes, auto-pauses on View share, and purges on account deletion", async () => {
    const { storage, handler } = await setup({ automationServerEnabled: true });

    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Phone Capture", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { webhook, token } = (await created.json()) as {
      webhook: { webhookId: string };
      token: string;
    };

    const hostState = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    });
    expect(hostState.host?.installId).toBe(AUTOMATION_SERVER_INSTALL_ID);
    const generation1 = hostState.host!.generation;

    // Enqueue a payload with hostile triple backticks and frontmatter-like lines to prove quarantine.
    const hostilePayload = JSON.stringify({
      title: "Lunch receipt",
      note: "```\n---\nStatus: Archived\n---\n```",
    });
    const post = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "application/json",
          "x-event-type": "ios.shortcut",
        },
        body: hostilePayload,
      }),
    );
    expect(post.status).toBe(202);
    const { deliveryId } = (await post.json()) as { deliveryId: string };

    const usageBeforeDrain = inspect(storagePath(storage), (db) =>
      db
        .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?")
        .get("ws-1"),
    ) as { usage_bytes: number };

    const files = new Map<string, { objectId: string; text: string }>();
    const recordsById = new Map<string, string>();
    const writeCalls: Array<{ path: string; author: unknown; requestId?: string }> = [];
    const onWritten = vi.fn();

    const makeAdapter = (options?: {
      simulateCrashAfterWrite?: boolean;
    }): IncomingWebhookDrainAdapter => ({
      getActiveVersion: async () => ({ id: "ver-main" }),
      readTextFile: async ({ path }) => files.get(path) ?? null,
      writeTextFile: async ({ path, text, author, requestId }) => {
        writeCalls.push({ path, author, ...(requestId ? { requestId } : {}) });
        const objectId = files.get(path)?.objectId ?? `obj_${files.size + 1}`;
        files.set(path, { objectId, text });
        const idMatch = /^id:\s*([^\r\n]+)/mu.exec(text);
        if (idMatch) recordsById.set(idMatch[1]!.trim(), path);
        if (options?.simulateCrashAfterWrite && path !== INBOX_SCHEMA_PATH) {
          throw new Error("Simulated crash right after engine write");
        }
        return { objectId };
      },
      getCollectionRecord: async ({ recordId }) => {
        if (options?.simulateCrashAfterWrite && recordsById.has(recordId)) {
          throw new Error("Simulated crashed engine before settle");
        }
        const path = recordsById.get(recordId);
        if (!path) throw new Error("record_not_found");
        return { record: { path } };
      },
    });

    // Generation 1 writes Inbox/collection.yaml + record, then crashes before settling.
    await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      adapter: makeAdapter({ simulateCrashAfterWrite: true }),
      currentGeneration: () => generation1,
      nowMs: () => 1_760_000_010_000,
      hold: () => () => undefined,
      onWritten,
      onError: () => undefined,
    });

    // Also simulate a SIGKILL leaving the row in state='accepted' under generation 1 so gen 2 must reclaim it.
    storage.db
      .prepare(
        "UPDATE sync_relay_webhook_deliveries SET state = 'accepted', accepted_by = ?, accepted_generation = ? WHERE delivery_id = ?",
      )
      .run(AUTOMATION_SERVER_INSTALL_ID, generation1, deliveryId);

    expect(files.get(INBOX_SCHEMA_PATH)?.text).toBe(INBOX_COLLECTION_YAML);
    const expectedRecordId = derivedRecordId(`webhook:${deliveryId}`);
    const writtenPath = recordsById.get(expectedRecordId);
    expect(writtenPath).toBeTruthy();
    const writtenText = files.get(writtenPath!)!.text;
    expect(writtenText).toContain(`id: ${expectedRecordId}`);
    expect(writtenText).toContain("Source: webhook");
    expect(writtenText).toContain("Kind: webhook");
    expect(writtenText).toContain("Status: New");
    // Hostile triple-backtick sequence is fenced with a longer fence (`~~~~` or 4+ backticks) so payload cannot escape!
    expect(writtenText).toMatch(/(````|~~~~)json/u);

    // Author provenance has kind: "automation", automationId: "webhook:<id>", onBehalfOf: "owner", depth: 0.
    const recordWrite = writeCalls.find((call) => call.path === writtenPath);
    expect(recordWrite?.author).toEqual({
      kind: "automation",
      automationId: `webhook:${webhook.webhookId}`,
      onBehalfOf: "owner",
      depth: 0,
    });

    // Generation 2 handover reclaims accepted delivery and settles WITHOUT writing a duplicate file!
    const generation2 = generation1 + 1;
    storage.db
      .prepare("UPDATE sync_relay_automation_hosts SET generation = ? WHERE workspace_id = ?")
      .run(generation2, "ws-1");
    const writeCountBeforeHandover = writeCalls.length;
    const drainGen2 = await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      adapter: makeAdapter(),
      currentGeneration: () => generation2,
      nowMs: () => 1_760_000_020_000,
      hold: () => () => undefined,
      onWritten,
      onError: () => undefined,
    });
    expect(drainGen2.settled).toBe(1);
    expect(writeCalls.length).toBe(writeCountBeforeHandover); // Zero duplicate writes!
    expect(onWritten).toHaveBeenCalled();

    // Settled delivery immediately clears payload_blob + storage_bytes and reduces sync_relay_workspace_usage!
    const settledRow = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT state, payload_blob, payload_bytes, storage_bytes, record_path FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(deliveryId),
    ) as {
      state: string;
      payload_blob: unknown;
      payload_bytes: number;
      storage_bytes: number;
      record_path: string;
    };
    expect(settledRow.state).toBe("settled");
    expect(settledRow.payload_blob).toBeNull();
    expect(settledRow.payload_bytes).toBe(0);
    expect(settledRow.storage_bytes).toBe(0);
    expect(settledRow.record_path).toBe(writtenPath);

    const usageAfterDrain = inspect(storagePath(storage), (db) =>
      db
        .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?")
        .get("ws-1"),
    ) as { usage_bytes: number };
    expect(usageAfterDrain.usage_bytes).toBeLessThan(usageBeforeDrain.usage_bytes);

    // Enqueue a second pending delivery, then create a View share covering Inbox -> atomically auto-pauses webhook & zeroes pending payload!
    const post2 = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "Queued before View share",
      }),
    );
    expect(post2.status).toBe(202);
    const { deliveryId: delivery2Id } = (await post2.json()) as { deliveryId: string };

    await createShare(handler, "owner", "ws-1", {
      recipientUserId: "viewer-1",
      paths: ["Inbox"],
      access: "view",
    });

    const listedAfterShare = storage.listIncomingWebhooks("ws-1");
    expect(listedAfterShare[0]?.paused).toBe(true);
    expect(listedAfterShare[0]?.pauseReason).toMatch(/shared/iu);

    const pausedDelivery2 = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT state, payload_blob, storage_bytes FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(delivery2Id),
    ) as { state: string; payload_blob: unknown; storage_bytes: number };
    expect(pausedDelivery2.state).toBe("paused");
    expect(pausedDelivery2.payload_blob).toBeNull();
    expect(pausedDelivery2.storage_bytes).toBe(0);

    // Attempting to resume while View share is active fails with 409!
    const resumeWhileShared = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}`, {
        ...jsonBody({ paused: false }),
        method: "PATCH",
      }),
    );
    expect(resumeWhileShared.status).toBe(409);

    // Account deletion purges all webhook definitions and deliveries automatically.
    initializeAccountDeletion(storage, LINK_KEY);
    const fenced = fenceAccount(storage, LINK_KEY, "owner", "owner@dohc.test");
    expect(fenced.manifest).not.toBeNull();
    purgeAccountRows(storage, "owner", "owner@dohc.test", fenced.manifest!);
    expect(countRows(storagePath(storage), "sync_relay_incoming_webhooks")).toBe(0);
    expect(countRows(storagePath(storage), "sync_relay_webhook_deliveries")).toBe(0);
  });

  it("refuses in-flight webhook ops atomically at log admission when a concurrent View share arrives", async () => {
    const { storage, handler } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Race Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { webhook, token } = (await created.json()) as {
      webhook: { webhookId: string };
      token: string;
    };
    const host = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    }).host!;

    const post = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "TOP_SECRET_IN_FLIGHT_PAYLOAD",
      }),
    );
    expect(post.status).toBe(202);
    const { deliveryId } = (await post.json()) as { deliveryId: string };

    // Simulate a View share being created DURING await adapter.writeTextFile.
    let writtenPath = "";
    let writtenMarkdown = "";
    let viewerShareId = "";
    const onWritten = vi.fn();
    const adapter: IncomingWebhookDrainAdapter = {
      getActiveVersion: async () => ({ id: "main" }),
      readTextFile: async ({ path }) =>
        path === INBOX_SCHEMA_PATH ? { objectId: "obj_inbox", text: INBOX_COLLECTION_YAML } : null,
      writeTextFile: async ({ path, text }) => {
        writtenPath = path;
        writtenMarkdown = text;
        viewerShareId = await createShare(handler, "owner", "ws-1", {
          recipientUserId: "viewer-race",
          paths: ["Inbox"],
          access: "view",
        });
        return { objectId: "obj_record_1" };
      },
      getCollectionRecord: async () => {
        throw new Error("not_found");
      },
    };

    const raceResult = await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      leaseId: "lease-race-1",
      adapter,
      currentGeneration: () => host.generation,
      nowMs: () => 1_760_000_001_000,
      hold: () => () => undefined,
      onWritten,
      onError: () => undefined,
    });
    expect(raceResult.settled).toBe(0);
    expect(raceResult.progressed).toBe(true);
    expect(onWritten).not.toHaveBeenCalled();

    // Even if the replica subsequently replicates the written op through POST /sync/:workspaceId/log,
    // appendLogBatch marks it `relay_admission = 'departed'` atomically under BEGIN IMMEDIATE:
    // - HTTP push response omits `refusals` (hosted.rs:187)
    // - Owner pull GET /sync/ws-1/log returns the exact `moment.append` op (no OriginDiverged in relay.rs:6309)
    // - ZERO rows enter sync_relay_current_files or sync_relay_object_moments
    // - View share recipient gets ZERO ops on /sync/shares/:shareId/log and 404 on /sync/shares/:shareId/blobs/:sha!
    const blobBytes = new TextEncoder().encode(writtenMarkdown);
    const blobSha = createHash("sha256").update(blobBytes).digest("hex");
    storage.putBlob({
      workspaceId: "ws-1",
      sha256: blobSha,
      content: blobBytes,
      createdAtMs: 1_760_000_002_000,
    });
    const momentPayloadObj = {
      versionId: "main",
      objectId: "obj_record_1",
      momentId: "mom_webhook_race_1",
      operation: "write",
      path: writtenPath,
      payloadAfterPath: writtenPath,
      payloadAfterBlobSha256: blobSha,
      payloadAfterContentKind: "text",
      payloadAfterByteLength: blobBytes.byteLength,
      recordedAtMs: 1_760_000_002_000,
      authors: [
        {
          kind: "automation",
          automationId: `webhook:${webhook.webhookId}`,
          onBehalfOf: "owner",
          depth: 0,
        },
      ],
    };
    const pushReq = () =>
      request("owner", "/sync/ws-1/log", {
        ...jsonBody({
          originId: "automation-server-origin",
          ops: [
            {
              originSeq: 0,
              opKind: "moment.append",
              payload: momentPayloadObj,
              recordedAtMs: 1_760_000_002_000,
            },
          ],
        }),
        method: "POST",
      });
    const firstPushResp = await handler(pushReq());
    expect(firstPushResp.status).toBe(200);
    const firstPushJson = (await firstPushResp.json()) as Record<string, unknown>;
    expect(firstPushJson.inserted).toBe(1);
    expect(firstPushJson).not.toHaveProperty("refusals");

    const logRow = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT op_kind, relay_admission FROM sync_relay_log WHERE workspace_id = ? AND origin_id = ? AND origin_seq = 0",
        )
        .get("ws-1", "automation-server-origin"),
    ) as { op_kind: string; relay_admission: string };
    expect(logRow.op_kind).toBe("moment.append");
    expect(logRow.relay_admission).toBe("departed");

    // Pulling from the owner/replica log returns the matching `moment.append` coordinate so replica.sync() advances without OriginDiverged!
    const replicaPullResp = await handler(
      request("owner", "/sync/ws-1/log?since=0&limit=100&includeReferences=false"),
    );
    expect(replicaPullResp.status).toBe(200);
    const replicaPullJson = (await replicaPullResp.json()) as {
      ops: Array<{ originId: string; originSeq: number; opKind: string; recordedAtMs: number }>;
      nextCursor: number;
    };
    expect(replicaPullJson.ops).toHaveLength(1);
    expect(replicaPullJson.ops[0]).toMatchObject({
      originId: "automation-server-origin",
      originSeq: 0,
      opKind: "moment.append",
      recordedAtMs: 1_760_000_002_000,
    });
    expect(replicaPullJson.nextCursor).toBeGreaterThan(0);

    // Zero rows in current_files or object_moments, AND View share recipient sees ZERO ops and 404 for the blob!
    const currentFile = inspect(storagePath(storage), (db) =>
      db
        .prepare("SELECT 1 FROM sync_relay_current_files WHERE workspace_id = ? AND path = ?")
        .get("ws-1", writtenPath),
    );
    expect(currentFile).toBeUndefined();

    const viewerLogResp = await handler(
      request(
        "viewer-race",
        `/sync/shares/${encodeURIComponent(viewerShareId)}/log?since=0&limit=100`,
      ),
    );
    expect(viewerLogResp.status).toBe(200);
    const viewerLogJson = (await viewerLogResp.json()) as { ops: unknown[] };
    expect(viewerLogJson.ops).toEqual([]);

    const viewerBlobResp = await handler(
      request("viewer-race", `/sync/shares/${encodeURIComponent(viewerShareId)}/blobs/${blobSha}`),
    );
    expect(viewerBlobResp.status).toBe(404);

    // Retrying the exact same departed op over HTTP is idempotent and also omits `refusals`.
    const retryPushResp = await handler(pushReq());
    expect(retryPushResp.status).toBe(200);
    const retryPushJson = (await retryPushResp.json()) as Record<string, unknown>;
    expect(retryPushJson.skipped).toBe(1);
    expect(retryPushJson.inserted).toBe(0);
    expect(retryPushJson).not.toHaveProperty("refusals");

    const row = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT state, payload_blob FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(deliveryId),
    ) as { state: string; payload_blob: unknown };
    expect(row.state).toBe("paused");
    expect(row.payload_blob).toBeNull();

    // Also prove the post-write / pre-sync share race: share commits AFTER writeTextFile finishes
    // and BEFORE sync() runs; drain waits for sync + publication check and NEVER marks the delivery 'settled'!
    const { storage: storage2, handler: handler2 } = await setup();
    const created2 = await handler2(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Pre-Sync Race Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    const { webhook: wh2, token: tok2 } = (await created2.json()) as {
      webhook: { webhookId: string };
      token: string;
    };
    const host2 = storage2.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    }).host!;
    const post2 = await handler2(
      publicHookRequest(tok2, {
        headers: { "content-type": "text/plain" },
        body: "SHARED_BEFORE_SYNC_PAYLOAD",
      }),
    );
    const { deliveryId: delivery2Id } = (await post2.json()) as { deliveryId: string };
    let path2 = "";
    let text2 = "";
    const adapter2: IncomingWebhookDrainAdapter = {
      getActiveVersion: async () => ({ id: "main" }),
      readTextFile: async ({ path }) =>
        path === INBOX_SCHEMA_PATH
          ? { objectId: "obj_inbox_2", text: INBOX_COLLECTION_YAML }
          : null,
      writeTextFile: async ({ path, text }) => {
        path2 = path;
        text2 = text;
        return { objectId: "obj_rec_2" };
      },
      getCollectionRecord: async () => {
        throw new Error("not_found");
      },
    };
    const preSyncDrain = await drainIncomingWebhooksForWorkspace({
      storage: storage2,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      leaseId: "lease-presync-1",
      adapter: adapter2,
      currentGeneration: () => host2.generation,
      nowMs: () => 1_760_000_010_000,
      hold: () => () => undefined,
      sync: async () => {
        // View share commits RIGHT BEFORE replica push arrives at POST /log!
        await createShare(handler2, "owner", "ws-1", {
          recipientUserId: "viewer-presync",
          paths: ["Inbox"],
          access: "view",
        });
        const bytes = new TextEncoder().encode(text2);
        const sha = createHash("sha256").update(bytes).digest("hex");
        storage2.putBlob({
          workspaceId: "ws-1",
          sha256: sha,
          content: bytes,
          createdAtMs: 1_760_000_011_000,
        });
        const resp = await handler2(
          request("owner", "/sync/ws-1/log", {
            ...jsonBody({
              originId: "automation-server-origin",
              ops: [
                {
                  originSeq: 0,
                  opKind: "moment.append",
                  payload: {
                    versionId: "main",
                    objectId: "obj_rec_2",
                    momentId: "mom_presync_1",
                    operation: "write",
                    path: path2,
                    payloadAfterPath: path2,
                    payloadAfterBlobSha256: sha,
                    payloadAfterContentKind: "text",
                    payloadAfterByteLength: bytes.byteLength,
                    recordedAtMs: 1_760_000_011_000,
                    authors: [
                      {
                        kind: "automation",
                        automationId: `webhook:${wh2.webhookId}`,
                        onBehalfOf: "owner",
                        depth: 0,
                      },
                    ],
                  },
                  recordedAtMs: 1_760_000_011_000,
                },
              ],
            }),
            method: "POST",
          }),
        );
        expect(resp.status).toBe(200);
        expect(await resp.json()).not.toHaveProperty("refusals");
        // Simulate replica.sync()'s pull phase after push: exact matching moment.append comes back so pull advances without OriginDiverged.
        const pullResp = await handler2(
          request("owner", "/sync/ws-1/log?since=0&limit=100&includeReferences=false"),
        );
        expect(pullResp.status).toBe(200);
        const pullJson = (await pullResp.json()) as {
          ops: Array<{ opKind: string; originId: string; originSeq: number }>;
        };
        expect(pullJson.ops).toHaveLength(1);
        expect(pullJson.ops[0]).toMatchObject({
          opKind: "moment.append",
          originId: "automation-server-origin",
          originSeq: 0,
        });
      },
      isRecordPublished: (recordPath) =>
        storage2.currentFileObjectId({
          workspaceId: "ws-1",
          versionId: "main",
          path: recordPath,
        }) !== undefined,
      onWritten: () => undefined,
      onError: () => undefined,
    });
    expect(preSyncDrain.settled).toBe(0);
    expect(
      storage2.currentFileObjectId({ workspaceId: "ws-1", versionId: "main", path: path2 }),
    ).toBeUndefined();
    const delivery2Row = inspect(storagePath(storage2), (db) =>
      db
        .prepare(
          "SELECT state, payload_blob FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(delivery2Id),
    ) as { state: string; payload_blob: unknown };
    expect(delivery2Row.state).toBe("paused");
    expect(delivery2Row.payload_blob).toBeNull();
  });

  it("recovers accepted deliveries after a same-generation relay restart without writing duplicates", async () => {
    const { storage, handler } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Restart Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    const host = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    }).host!;

    const post = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "Survives SIGKILL at same generation",
      }),
    );
    expect(post.status).toBe(202);
    const { deliveryId } = (await post.json()) as { deliveryId: string };

    const files = new Map<string, { objectId: string; text: string }>();
    files.set(INBOX_SCHEMA_PATH, { objectId: "obj_inbox", text: INBOX_COLLECTION_YAML });
    const recordsById = new Map<string, string>();
    let writes = 0;

    // Simulate process 1 claiming delivery at generation G with lease-1, writing the record, then getting SIGKILLed.
    const claimed1 = storage.claimNextIncomingWebhookDelivery({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      installId: AUTOMATION_SERVER_INSTALL_ID,
      generation: host.generation,
      leaseId: "1:old-process-lease",
      nowMs: 1_760_000_001_000,
    });
    expect(claimed1?.deliveryId).toBe(deliveryId);
    const recordId = derivedRecordId(`webhook:${deliveryId}`);
    recordsById.set(recordId, "Inbox/2026-11-23-existing.md");

    // Process 2 starts at the EXACT SAME generation (no generation bump!) with a new leaseId.
    const adapter: IncomingWebhookDrainAdapter = {
      getActiveVersion: async () => ({ id: "main" }),
      readTextFile: async ({ path }) => files.get(path) ?? null,
      writeTextFile: async ({ path, text }) => {
        writes += 1;
        files.set(path, { objectId: `obj_${writes}`, text });
        return { objectId: `obj_${writes}` };
      },
      getCollectionRecord: async ({ recordId: id }) => {
        const p = recordsById.get(id);
        if (!p) throw new Error("not_found");
        return { record: { path: p } };
      },
    };
    const restartDrain = await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      leaseId: "1:restarted-process-lease",
      adapter,
      currentGeneration: () => host.generation,
      nowMs: () => 1_760_000_002_000,
      hold: () => () => undefined,
      onWritten: () => undefined,
      onError: () => undefined,
    });
    expect(restartDrain.settled).toBe(1);
    expect(writes).toBe(0);

    // Also verify recoverAcceptedIncomingWebhookDeliveries resets any accepted rows back to pending on copy open.
    const post2 = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "Second crash row",
      }),
    );
    const { deliveryId: delivery2Id } = (await post2.json()) as { deliveryId: string };
    storage.claimNextIncomingWebhookDelivery({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      installId: AUTOMATION_SERVER_INSTALL_ID,
      generation: host.generation,
      leaseId: "1:crashed-again",
      nowMs: 1_760_000_003_000,
    });
    const recovered = storage.recoverAcceptedIncomingWebhookDeliveries({
      workspaceId: "ws-1",
      installId: AUTOMATION_SERVER_INSTALL_ID,
      nowMs: 1_760_000_004_000,
    });
    expect(recovered).toBe(1);
    const recoveredRow = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT state, accepted_lease_id FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(delivery2Id),
    ) as { state: string; accepted_lease_id: string | null };
    expect(recoveredRow).toEqual({ state: "pending", accepted_lease_id: null });
  });

  it("requires server-hosted automations and an active server automation host at create, resume, and ingress", async () => {
    // 1. Server without automationServer enabled -> GET 503, POST 503.
    const disabled = await setup({ automationServerEnabled: false });
    const getDisabled = await disabled.handler(request("owner", "/sync/ws-1/webhooks"));
    expect(getDisabled.status).toBe(503);
    const createDisabled = await disabled.handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "No Server", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(createDisabled.status).toBe(503);

    // 2. Workspace whose active automation host is a desktop computer -> POST create returns 409.
    const { storage, handler } = await setup({ automationServerEnabled: true });
    storage.checkInAutomationComputer({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      installId: "desktop-computer-1",
      label: "Ice Laptop",
      claim: true,
      server: null,
      nowMs: 1_760_000_000_000,
    });
    const createOnComputer = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Computer Hosted", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(createOnComputer.status).toBe(409);
    expect(countRows(storagePath(storage), "sync_relay_incoming_webhooks")).toBe(0);

    // 2b. Desktop-to-server handover in progress (installId = server, handoverFrom = desktop-computer-1)
    // must also be refused until handover completes (handoverFrom === null)!
    const genBeforeHandover = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    }).host!.generation;
    storage.chooseAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      installId: AUTOMATION_SERVER_INSTALL_ID,
      generation: genBeforeHandover,
      server: { label: "dohc server" },
      nowMs: 1_760_000_001_000,
    });
    const createDuringHandover = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Mid-Handover", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(createDuringHandover.status).toBe(409);

    // 3. After switching host to server (completed handover), creating works; if host later switches back to computer, ingress refuses with 503 and resume refuses with 409!
    storage.db
      .prepare("DELETE FROM sync_relay_automation_hosts WHERE workspace_id = ?")
      .run("ws-1");
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Server Hosted", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { webhook, token } = (await created.json()) as {
      webhook: { webhookId: string };
      token: string;
    };

    // Pause it, then switch host to computer.
    await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}`, {
        ...jsonBody({ paused: true }),
        method: "PATCH",
      }),
    );
    storage.db
      .prepare("UPDATE sync_relay_automation_hosts SET install_id = ? WHERE workspace_id = ?")
      .run("desktop-computer-1", "ws-1");
    const resumeOnComputer = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}`, {
        ...jsonBody({ paused: false }),
        method: "PATCH",
      }),
    );
    expect(resumeOnComputer.status).toBe(409);

    // Unpause directly in DB to verify public ingress also refuses with 503 when host is a computer.
    storage.db
      .prepare("UPDATE sync_relay_incoming_webhooks SET paused = 0 WHERE webhook_id = ?")
      .run(webhook.webhookId);
    const ingressOnComputer = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "must not queue into undrained workspace",
      }),
    );
    expect(ingressOnComputer.status).toBe(503);
    expect(countRows(storagePath(storage), "sync_relay_webhook_deliveries")).toBe(0);

    // Also verify ingress and resume refuse with 503 / 409 during a desktop-to-server handover.
    storage.db
      .prepare(
        "UPDATE sync_relay_automation_hosts SET install_id = ?, handover_from = ? WHERE workspace_id = ?",
      )
      .run(AUTOMATION_SERVER_INSTALL_ID, "desktop-computer-1", "ws-1");
    const ingressDuringHandover = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "must not queue during handover",
      }),
    );
    expect(ingressDuringHandover.status).toBe(503);
    storage.db
      .prepare("UPDATE sync_relay_incoming_webhooks SET paused = 1 WHERE webhook_id = ?")
      .run(webhook.webhookId);
    const resumeDuringHandover = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}`, {
        ...jsonBody({ paused: false }),
        method: "PATCH",
      }),
    );
    expect(resumeDuringHandover.status).toBe(409);
    expect(countRows(storagePath(storage), "sync_relay_webhook_deliveries")).toBe(0);

    // 4. Server automation capacity full -> POST create returns 503 and inserts no webhook.
    const full = await setup({ automationServerEnabled: true });
    for (let i = 0; i < AUTOMATION_SERVER_MAX_WORKSPACES; i += 1) {
      const wsId = `ws-cap-${i}`;
      full.storage.claimWorkspace({ workspaceId: wsId, ownerUserId: "owner", createdAtMs: 1 });
      full.storage.chooseAutomationHost({
        workspaceId: wsId,
        ownerUserId: "owner",
        installId: AUTOMATION_SERVER_INSTALL_ID,
        generation: 0,
        server: { label: "dohc server" },
        nowMs: 1_760_000_000_000,
      });
    }
    const createWhenFull = await full.handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Over Capacity", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(createWhenFull.status).toBe(503);
    expect(countRows(storagePath(full.storage), "sync_relay_incoming_webhooks")).toBe(0);
  });

  it("preserves X-Dohc-Chain-Depth on drained record author and rejects mid-upload token rotation", async () => {
    const { storage, handler } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Depth & Rotation Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { webhook, token } = (await created.json()) as {
      webhook: { webhookId: string };
      token: string;
    };
    const host = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    }).host!;

    // 1. X-Dohc-Chain-Depth: 2 propagates into webhookAuthor.depth = 2, AND leading UTF-8 BOM (EF BB BF) is preserved verbatim!
    const bomPayload = new Uint8Array([0xef, 0xbb, 0xbf, 0x78]);
    const depthPost = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "text/plain",
          "x-dohc-chain-depth": "2",
        },
        body: bomPayload,
      }),
    );
    expect(depthPost.status).toBe(202);
    const authors: unknown[] = [];
    const writtenTexts: string[] = [];
    const adapter: IncomingWebhookDrainAdapter = {
      getActiveVersion: async () => ({ id: "main" }),
      readTextFile: async ({ path }) =>
        path === INBOX_SCHEMA_PATH ? { objectId: "obj_inbox", text: INBOX_COLLECTION_YAML } : null,
      writeTextFile: async ({ author, text }) => {
        authors.push(author);
        writtenTexts.push(text);
        return { objectId: "obj_depth_1" };
      },
      getCollectionRecord: async () => {
        throw new Error("not_found");
      },
    };
    const depthDrain = await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      leaseId: "lease-depth-1",
      adapter,
      currentGeneration: () => host.generation,
      nowMs: () => 1_760_000_001_000,
      hold: () => () => undefined,
      onWritten: () => undefined,
      onError: () => undefined,
    });
    expect(depthDrain.settled).toBe(1);
    expect(writtenTexts[0]).toContain("\ufeffx");
    expect(authors).toEqual([
      {
        kind: "automation",
        automationId: `webhook:${webhook.webhookId}`,
        onBehalfOf: "owner",
        depth: 2,
      },
    ]);

    // 2. Rotate token while a streaming POST is mid-upload -> returns opaque 404 and enqueues nothing!
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let streamStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const slowStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first-chunk-"));
        streamStarted();
        await bodyGate;
        controller.enqueue(new TextEncoder().encode("after-rotation"));
        controller.close();
      },
    });
    const inFlightPromise = handler(
      new Request(`https://sync.example.com/sync/hooks/${token}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: slowStream,
        duplex: "half",
      } as RequestInit),
    );
    await startedPromise;

    const rotated = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}/rotate`, { method: "POST" }),
    );
    expect(rotated.status).toBe(200);

    releaseBody();
    const inFlightResponse = await inFlightPromise;
    expect(inFlightResponse.status).toBe(404);
    expect(await inFlightResponse.json()).toEqual({ ok: false, error: "not found" });
    // Only the earlier depth delivery exists; the mid-rotation delivery was not enqueued.
    expect(countRows(storagePath(storage), "sync_relay_webhook_deliveries")).toBe(1);
  });

  it("auto-pauses on whole-workspace version shares (paths: []) and on undoShareRemoval", async () => {
    const { storage, handler } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Share Boundary Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { webhook, token } = (await created.json()) as {
      webhook: { webhookId: string };
      token: string;
    };

    // 1. Whole-workspace version share ({ paths: [], versionId: "main" }) pauses webhook & rejects resume with 409!
    const wholeVersionShare = await handler(
      request("owner", "/sync/ws-1/shares", {
        ...jsonBody({
          recipientUserId: "viewer-all",
          paths: [],
          versionId: "main",
          access: "view",
        }),
        method: "POST",
      }),
    );
    expect(wholeVersionShare.status).toBe(200);
    const shareBody = (await wholeVersionShare.json()) as {
      shareId?: string;
      grantId?: string;
      share?: { shareId: string };
      grant?: { grantId: string };
    };
    const shareId = shareBody.shareId ?? shareBody.share!.shareId;
    const grantId = shareBody.grantId ?? shareBody.grant!.grantId;

    expect(storage.listIncomingWebhooks("ws-1")[0]?.paused).toBe(true);
    const resumeWhileWholeShared = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}`, {
        ...jsonBody({ paused: false }),
        method: "PATCH",
      }),
    );
    expect(resumeWhileWholeShared.status).toBe(409);

    // 2. Revoke the share, resume the webhook, enqueue a delivery, then UNDO the share removal -> webhook atomically pauses & delivery clears!
    const revoked = storage.removeShareAccess({
      shareId,
      grantId,
      actorUserId: "owner",
      nowMs: 1_760_000_005_000,
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok || !revoked.undo) throw new Error("expected undo receipt");

    const resumedAfterRevoke = await handler(
      request("owner", `/sync/ws-1/webhooks/${webhook.webhookId}`, {
        ...jsonBody({ paused: false }),
        method: "PATCH",
      }),
    );
    expect(resumedAfterRevoke.status).toBe(200);

    const queuedBeforeUndo = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "Queued before undoShareRemoval",
      }),
    );
    expect(queuedBeforeUndo.status).toBe(202);
    const { deliveryId } = (await queuedBeforeUndo.json()) as { deliveryId: string };

    storage.undoShareRemoval({
      shareId,
      actorUserId: "owner",
      undoId: revoked.undo.undoId,
      nowMs: 1_760_000_006_000,
    });

    expect(storage.listIncomingWebhooks("ws-1")[0]?.paused).toBe(true);
    const clearedDelivery = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT state, payload_blob, storage_bytes FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(deliveryId),
    ) as { state: string; payload_blob: unknown; storage_bytes: number };
    expect(clearedDelivery).toEqual({ state: "paused", payload_blob: null, storage_bytes: 0 });
  });

  it("backs off failing deliveries without head-of-line blocking and settles as failed after 5 attempts", async () => {
    let clock = 1_760_000_000_000;
    const { storage, handler } = await setup({ nowMs: () => clock });
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Retry Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    const host = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: clock,
    }).host!;

    // Enqueue failing delivery #1 and healthy delivery #2.
    const post1 = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "FAIL_ME",
      }),
    );
    const { deliveryId: badId } = (await post1.json()) as { deliveryId: string };
    clock += 100;
    const post2 = await handler(
      publicHookRequest(token, {
        headers: { "content-type": "text/plain" },
        body: "SUCCEED_ME",
      }),
    );
    const { deliveryId: goodId } = (await post2.json()) as { deliveryId: string };

    const adapter: IncomingWebhookDrainAdapter = {
      getActiveVersion: async () => ({ id: "main" }),
      readTextFile: async ({ path }) =>
        path === INBOX_SCHEMA_PATH ? { objectId: "obj_inbox", text: INBOX_COLLECTION_YAML } : null,
      writeTextFile: async ({ text }) => {
        if (text.includes("FAIL_ME")) {
          throw new Error("Simulated persistent engine write failure");
        }
        return { objectId: "obj_good_1" };
      },
      getCollectionRecord: async () => {
        throw new Error("not_found");
      },
    };

    // Attempt 1: badId fails & backs off, while goodId IMMEDIATELY drains in the same pass (zero head-of-line blocking!).
    const firstPass = await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      leaseId: "lease-retry-1",
      adapter,
      currentGeneration: () => host.generation,
      nowMs: () => clock,
      hold: () => () => undefined,
      onWritten: () => undefined,
      onError: () => undefined,
    });
    expect(firstPass.settled).toBe(1);
    expect(firstPass.progressed).toBe(true);

    const goodRow = inspect(storagePath(storage), (db) =>
      db
        .prepare("SELECT state FROM sync_relay_webhook_deliveries WHERE delivery_id = ?")
        .get(goodId),
    ) as { state: string };
    expect(goodRow.state).toBe("settled");

    // While backed off, hasPendingIncomingWebhookDeliveries(ws, clock) is FALSE (zero spin loop!) and nextRetryAtMs is clock + base.
    expect(storage.hasPendingIncomingWebhookDeliveries("ws-1", clock)).toBe(false);
    expect(storage.nextIncomingWebhookRetryAtMs("ws-1")).toBe(
      clock + INCOMING_WEBHOOK_RETRY_BASE_MS,
    );

    // Exhaust remaining attempts up to MAX_INCOMING_WEBHOOK_DRAIN_ATTEMPTS (5).
    for (let attempt = 2; attempt <= MAX_INCOMING_WEBHOOK_DRAIN_ATTEMPTS; attempt += 1) {
      const nextRetry = storage.nextIncomingWebhookRetryAtMs("ws-1");
      expect(nextRetry).not.toBeNull();
      clock = nextRetry!;
      expect(storage.hasPendingIncomingWebhookDeliveries("ws-1", clock)).toBe(true);
      await drainIncomingWebhooksForWorkspace({
        storage,
        workspaceId: "ws-1",
        ownerUserId: "owner",
        leaseId: "lease-retry-1",
        adapter,
        currentGeneration: () => host.generation,
        nowMs: () => clock,
        hold: () => () => undefined,
        onWritten: () => undefined,
        onError: () => undefined,
      });
    }

    // After 5 failures, delivery settles permanently as 'failed' with payload_blob & storage_bytes released!
    const failedRow = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT state, attempt_count, payload_blob, payload_bytes, storage_bytes, error, settled_at_ms FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
        )
        .get(badId),
    ) as {
      state: string;
      attempt_count: number;
      payload_blob: unknown;
      payload_bytes: number;
      storage_bytes: number;
      error: string;
      settled_at_ms: number;
    };
    expect(failedRow.state).toBe("failed");
    expect(failedRow.attempt_count).toBe(MAX_INCOMING_WEBHOOK_DRAIN_ATTEMPTS);
    expect(failedRow.payload_blob).toBeNull();
    expect(failedRow.payload_bytes).toBe(0);
    expect(failedRow.storage_bytes).toBe(0);
    expect(failedRow.error).toContain("Simulated persistent engine write failure");
    expect(failedRow.settled_at_ms).toBe(clock);
    expect(storage.nextIncomingWebhookRetryAtMs("ws-1")).toBeNull();
    expect(storage.hasPendingIncomingWebhookDeliveries("ws-1", clock)).toBe(false);

    const failureNotices = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT notice_id, kind, title, body FROM sync_relay_notices WHERE workspace_id = ? AND recipient_user_id = ? AND notice_id = ?",
        )
        .all("ws-1", "owner", `incoming-webhook-failed:${badId}`),
    ) as Array<{ notice_id: string; kind: string; title: string; body: string }>;
    expect(failureNotices).toHaveLength(1);
    expect(failureNotices[0]!.kind).toBe("automation-failed");
    expect(failureNotices[0]!.title).toContain("Retry Hook");
    expect(failureNotices[0]!.body).toContain(badId);
    expect(failureNotices[0]!.body).toContain("5 attempts");
    expect(failureNotices[0]!.body).toContain("Simulated persistent engine write failure");
  });

  it("rejects aborted streaming uploads without enqueueing partial bodies so idempotent retries succeed", async () => {
    const { storage, handler } = await setup();
    const created = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Abort Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };

    const abortController = new AbortController();
    let chunkSent!: () => void;
    const chunkSentPromise = new Promise<void>((resolve) => {
      chunkSent = resolve;
    });
    const truncatedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        chunkSent();
      },
    });
    const abortedPromise = handler(
      new Request(`https://sync.example.com/sync/hooks/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "abort-retry-001",
        },
        body: truncatedStream,
        signal: abortController.signal,
        duplex: "half",
      } as RequestInit),
    );
    await chunkSentPromise;
    abortController.abort();

    const abortedResponse = await abortedPromise;
    expect(abortedResponse.status).toBe(400);
    expect(await abortedResponse.json()).toEqual({ ok: false, error: "request body aborted" });
    expect(countRows(storagePath(storage), "sync_relay_webhook_deliveries")).toBe(0);

    const retry = await handler(
      publicHookRequest(token, {
        headers: {
          "content-type": "application/json",
          "idempotency-key": "abort-retry-001",
        },
        body: JSON.stringify({ partial: false, complete: true }),
      }),
    );
    expect(retry.status).toBe(202);
    expect(countRows(storagePath(storage), "sync_relay_webhook_deliveries")).toBe(1);
  });

  it("drains a second webhook immediately when a concurrent share fences the first delivery, and stops retry scheduling for fenced owners", async () => {
    const { storage, handler } = await setup();

    // Commit a second private Collection `Receipts/collection.yaml` so we can point webhook B at it.
    const receiptsSchema = new TextEncoder().encode("version: 1\nname: Receipts\n");
    const receiptsSha = createHash("sha256").update(receiptsSchema).digest("hex");
    storage.putBlob({
      workspaceId: "ws-1",
      sha256: receiptsSha,
      content: receiptsSchema,
      createdAtMs: 1_760_000_000_000,
    });
    storage.appendLogBatch({
      workspaceId: "ws-1",
      originId: "owner-desktop",
      ops: [
        {
          originSeq: 0,
          opKind: "moment.append",
          payloadJson: JSON.stringify({
            versionId: "main",
            objectId: "obj_receipts_col",
            momentId: "mom_receipts_schema",
            operation: "write",
            path: "Receipts/collection.yaml",
            payloadAfterPath: "Receipts/collection.yaml",
            payloadAfterBlobSha256: receiptsSha,
            payloadAfterContentKind: "text",
            payloadAfterByteLength: receiptsSchema.byteLength,
            recordedAtMs: 1_760_000_000_000,
          }),
          recordedAtMs: 1_760_000_000_000,
        },
      ],
    });

    const hookA = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Inbox Hook", collectionPath: "Inbox" }),
        method: "POST",
      }),
    );
    expect(hookA.status).toBe(201);
    const { token: tokenA } = (await hookA.json()) as { token: string };

    const hookB = await handler(
      request("owner", "/sync/ws-1/webhooks", {
        ...jsonBody({ name: "Receipts Hook", collectionPath: "Receipts" }),
        method: "POST",
      }),
    );
    expect(hookB.status).toBe(201);
    const { token: tokenB } = (await hookB.json()) as { token: string };

    const host = storage.readAutomationHost({
      workspaceId: "ws-1",
      ownerUserId: "owner",
      server: { label: "dohc server" },
      nowMs: 1_760_000_000_000,
    }).host!;

    // Enqueue one delivery for webhook A (older) and one for webhook B (newer).
    const postA = await handler(
      publicHookRequest(tokenA, {
        headers: { "content-type": "text/plain" },
        body: "FOR_INBOX_A",
      }),
    );
    const { deliveryId: deliveryA } = (await postA.json()) as { deliveryId: string };
    const postB = await handler(
      publicHookRequest(tokenB, {
        headers: { "content-type": "text/plain" },
        body: "FOR_RECEIPTS_B",
      }),
    );
    const { deliveryId: deliveryB } = (await postB.json()) as { deliveryId: string };

    const adapter: IncomingWebhookDrainAdapter = {
      getActiveVersion: async () => ({ id: "main" }),
      readTextFile: async ({ path }) => {
        if (path === INBOX_SCHEMA_PATH) {
          return { objectId: "obj_inbox_col", text: INBOX_COLLECTION_YAML };
        }
        if (path === "Receipts/collection.yaml") {
          return { objectId: "obj_receipts_col", text: "version: 1\nname: Receipts\n" };
        }
        return null;
      },
      writeTextFile: async ({ path }) => {
        if (path.startsWith("Inbox/")) {
          // Share Inbox mid-write -> pauses delivery A without blocking Receipts!
          await createShare(handler, "owner", "ws-1", {
            recipientUserId: "viewer-a",
            paths: ["Inbox"],
            access: "view",
          });
        }
        return { objectId: `obj_${path}` };
      },
      getCollectionRecord: async () => {
        throw new Error("not_found");
      },
    };

    const result = await drainIncomingWebhooksForWorkspace({
      storage,
      workspaceId: "ws-1",
      ownerUserId: "owner",
      leaseId: "lease-multi-1",
      adapter,
      currentGeneration: () => host.generation,
      nowMs: () => 1_760_000_005_000,
      hold: () => () => undefined,
      onWritten: () => undefined,
      onError: () => undefined,
    });
    expect(result).toEqual({ settled: 1, progressed: true });

    const states = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT delivery_id, state FROM sync_relay_webhook_deliveries ORDER BY delivery_id",
        )
        .all(),
    ) as Array<{ delivery_id: string; state: string }>;
    expect(states.find((s) => s.delivery_id === deliveryA)?.state).toBe("paused");
    expect(states.find((s) => s.delivery_id === deliveryB)?.state).toBe("settled");

    // Verify fenced owner gets null retry timer and false ready check (no 0ms timer spin).
    const postB2 = await handler(
      publicHookRequest(tokenB, {
        headers: { "content-type": "text/plain" },
        body: "RETRY_BEFORE_FENCE",
      }),
    );
    const { deliveryId: deliveryB2 } = (await postB2.json()) as { deliveryId: string };
    storage.db
      .prepare(
        "UPDATE sync_relay_webhook_deliveries SET next_attempt_at_ms = ? WHERE delivery_id = ?",
      )
      .run(1_760_000_010_000, deliveryB2);
    expect(storage.nextIncomingWebhookRetryAtMs("ws-1", "owner")).toBe(1_760_000_010_000);

    initializeAccountDeletion(storage, LINK_KEY);
    fenceAccount(storage, LINK_KEY, "owner", "owner@dohc.test");
    expect(storage.nextIncomingWebhookRetryAtMs("ws-1", "owner")).toBeNull();
    expect(
      storage.hasPendingIncomingWebhookDeliveries(
        "ws-1",
        1_760_000_020_000,
        "owner",
        "lease-multi-1",
      ),
    ).toBe(false);
  });
});
