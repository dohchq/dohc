import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { afterEach, describe, expect, it } from "vitest";
import {
  fenceAccount,
  initializeAccountDeletion,
  purgeAccountRows,
} from "./storage/accountDeletion";
import { unsealWorkspaceSecret } from "./workspaceSecretCrypto";
import {
  closeTestStorages,
  countRows,
  inspect,
  jsonBody,
  LINK_KEY,
  request,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";
import type { StorageContext } from "./storage/context";

afterEach(async () => {
  await closeTestStorages();
});

const resolveTestSecretSession: ResolveAccountSession = async (req) => {
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

async function setup() {
  const storage = (await testStorage()) as StorageContext;
  storage.claimWorkspace({ workspaceId: "ws-1", ownerUserId: "owner", createdAtMs: 1 });
  const handler = testHandler(storage, {
    resolvePhoneCapableAccountSession: resolveTestSecretSession,
  });
  return { storage, handler };
}

describe("workspace secrets relay routes", () => {
  it("enforces create/replace semantics, never returns plaintext, returns updated list atomically, and deletes cleanly", async () => {
    const { storage, handler } = await setup();

    const empty = await handler(request("owner", "/sync/ws-1/secrets"));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, secrets: [], limit: 50 });

    const replaceMissing = await handler(
      request("owner", "/sync/ws-1/secrets/RESEND_API_KEY", {
        ...jsonBody({
          mode: "replace",
          usage: "http-header",
          value: "re_live_super_secret_123",
          allowedHosts: ["api.resend.com"],
        }),
        method: "PUT",
      }),
    );
    expect(replaceMissing.status).toBe(404);
    expect(await replaceMissing.json()).toMatchObject({ code: "workspace_secret_not_found" });

    const created = await handler(
      request("owner", "/sync/ws-1/secrets/RESEND_API_KEY", {
        ...jsonBody({
          mode: "create",
          usage: "http-header",
          value: "re_live_super_secret_123",
          allowedHosts: ["API.Resend.com", "api.resend.com"],
        }),
        method: "PUT",
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      ok: boolean;
      secret: Record<string, unknown>;
      secrets: Record<string, unknown>[];
      limit: number;
    };
    const expectedSummary = {
      name: "RESEND_API_KEY",
      usage: "http-header",
      allowedHosts: ["api.resend.com"],
      generation: 1,
      createdAtMs: expect.any(Number),
      updatedAtMs: expect.any(Number),
    };
    expect(createdBody).toEqual({
      ok: true,
      secret: expectedSummary,
      secrets: [expectedSummary],
      limit: 50,
    });
    expect(JSON.stringify(createdBody)).not.toContain("re_live_super_secret_123");

    const duplicateCreate = await handler(
      request("owner", "/sync/ws-1/secrets/RESEND_API_KEY", {
        ...jsonBody({
          mode: "create",
          usage: "http-header",
          value: "re_live_overwrite_attempt",
          allowedHosts: ["evil.example.com"],
        }),
        method: "PUT",
      }),
    );
    expect(duplicateCreate.status).toBe(409);
    expect(await duplicateCreate.json()).toMatchObject({ code: "workspace_secret_already_exists" });

    const listed = await handler(request("owner", "/sync/ws-1/secrets"));
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain("re_live_super_secret_123");
    expect(JSON.parse(listedText)).toMatchObject({
      ok: true,
      secrets: [
        {
          name: "RESEND_API_KEY",
          usage: "http-header",
          allowedHosts: ["api.resend.com"],
          generation: 1,
        },
      ],
    });

    const rawRow = inspect(storagePath(storage), (db) =>
      db
        .prepare(
          "SELECT sealed_value, key_id, generation FROM sync_relay_workspace_secrets WHERE workspace_id = ?",
        )
        .get("ws-1"),
    );
    expect(String(rawRow?.sealed_value)).toMatch(/^v1\./u);
    expect(String(rawRow?.sealed_value)).not.toContain("re_live_super_secret_123");
    expect(rawRow?.key_id).toBe("relay-link-v1");

    const stored = storage.readWorkspaceSecretForExecution("ws-1", "RESEND_API_KEY");
    expect(stored).not.toBeNull();
    expect(
      unsealWorkspaceSecret({
        sealed: stored!.sealedValue,
        linkKey: LINK_KEY,
        workspaceId: "ws-1",
        ownerUserId: "owner",
        name: "RESEND_API_KEY",
        usage: "http-header",
        allowedHosts: ["api.resend.com"],
        generation: 1,
        keyId: stored!.keyId,
      }),
    ).toBe("re_live_super_secret_123");
    expect(
      unsealWorkspaceSecret({
        sealed: stored!.sealedValue,
        linkKey: LINK_KEY,
        workspaceId: "ws-1",
        ownerUserId: "owner",
        name: "RESEND_API_KEY",
        usage: "http-header",
        allowedHosts: ["evil.example.com"],
        generation: 1,
        keyId: stored!.keyId,
      }),
    ).toBeNull();
    expect(
      unsealWorkspaceSecret({
        sealed: stored!.sealedValue,
        linkKey: LINK_KEY,
        workspaceId: "ws-other",
        ownerUserId: "owner",
        name: "RESEND_API_KEY",
        usage: "http-header",
        allowedHosts: ["api.resend.com"],
        generation: 1,
        keyId: stored!.keyId,
      }),
    ).toBeNull();

    const readUsage = () =>
      inspect(storagePath(storage), (db) =>
        Number(
          db
            .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?")
            .get("ws-1")?.usage_bytes ?? 0,
        ),
      );
    expect(readUsage()).toBeGreaterThan(0);

    const rotated = await handler(
      request("owner", "/sync/ws-1/secrets/RESEND_API_KEY", {
        ...jsonBody({
          mode: "replace",
          usage: "http-url",
          value: "https://hooks.slack.com/services/T00/B00/XXX",
        }),
        method: "PUT",
      }),
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({
      ok: true,
      secret: {
        name: "RESEND_API_KEY",
        usage: "http-url",
        allowedHosts: [],
        generation: 2,
      },
      secrets: [
        {
          name: "RESEND_API_KEY",
          usage: "http-url",
          allowedHosts: [],
          generation: 2,
        },
      ],
      limit: 50,
    });

    const removed = await handler(
      request("owner", "/sync/ws-1/secrets/RESEND_API_KEY", { method: "DELETE" }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, deleted: true, secrets: [], limit: 50 });
    expect(readUsage()).toBe(0);
  });

  it("refuses cookies, browser/phone sessions, non-owners, missing linkKey, unsafe URLs, and mid-upload owner fencing", async () => {
    const { storage, handler } = await setup();

    const withCookie = await handler(
      new Request("https://relay.example.test/sync/ws-1/secrets", {
        headers: {
          authorization: "Bearer user:owner",
          cookie: "better-auth.session_token=abc",
        },
      }),
    );
    expect(withCookie.status).toBe(404);

    const browserBearer = await handler(
      new Request("https://relay.example.test/sync/ws-1/secrets", {
        headers: { authorization: "Bearer browser:owner" },
      }),
    );
    expect(browserBearer.status).toBe(404);

    const phoneBearer = await handler(
      new Request("https://relay.example.test/sync/ws-1/secrets", {
        headers: { authorization: "Bearer phone:owner" },
      }),
    );
    expect(phoneBearer.status).toBe(404);

    const otherUser = await handler(request("stranger", "/sync/ws-1/secrets"));
    expect(otherUser.status).toBe(404);

    const otherPut = await handler(
      request("stranger", "/sync/ws-1/secrets/HOOK", {
        ...jsonBody({
          mode: "create",
          usage: "http-url",
          value: "https://hooks.slack.com/services/A/B/C",
        }),
        method: "PUT",
      }),
    );
    expect(otherPut.status).toBe(404);

    const privateUrl = await handler(
      request("owner", "/sync/ws-1/secrets/HOOK", {
        ...jsonBody({
          mode: "create",
          usage: "http-url",
          value: "https://127.0.0.1/hook",
        }),
        method: "PUT",
      }),
    );
    expect(privateUrl.status).toBe(400);

    const noKeyHandler = testHandler(storage, {
      linkKey: undefined,
      resolvePhoneCapableAccountSession: resolveTestSecretSession,
    });
    const unavailable = await noKeyHandler(request("owner", "/sync/ws-1/secrets"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "secrets_unavailable" });

    initializeAccountDeletion(storage, LINK_KEY);
    const bodyBytes = new TextEncoder().encode(
      JSON.stringify({
        mode: "create",
        usage: "http-url",
        value: "https://hooks.slack.com/services/A/B/C",
      }),
    );
    let fencedDuringUpload = false;
    const delayedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!fencedDuringUpload) {
          fencedDuringUpload = true;
          fenceAccount(storage, LINK_KEY, "owner", "owner@dohc.test");
          controller.enqueue(bodyBytes);
          controller.close();
        }
      },
    });
    const fencedPut = await handler(
      new Request("https://relay.example.test/sync/ws-1/secrets/LATE_SECRET", {
        method: "PUT",
        headers: {
          authorization: "Bearer user:owner",
          "content-type": "application/json",
        },
        body: delayedStream,
        duplex: "half",
      } as RequestInit),
    );
    expect(fencedPut.status).toBe(404);
    expect(countRows(storagePath(storage), "sync_relay_workspace_secrets")).toBe(0);
  });

  it("enforces the 50-secret cap and purges secrets on account deletion", async () => {
    const storage = (await testStorage()) as StorageContext;
    storage.claimWorkspace({ workspaceId: "ws-cap", ownerUserId: "owner", createdAtMs: 1 });
    const handler = testHandler(storage, {
      resolvePhoneCapableAccountSession: resolveTestSecretSession,
      workspaceSecretRateLimiter: undefined,
    });

    for (let index = 0; index < 50; index++) {
      const result = storage.upsertWorkspaceSecret({
        workspaceId: "ws-cap",
        ownerUserId: "owner",
        name: `SECRET_${index}`,
        mode: "create",
        usage: "http-url",
        allowedHosts: [],
        keyId: "relay-link-v1",
        nowMs: index + 1,
        seal: () => "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb",
      });
      expect(result.ok).toBe(true);
    }

    const overflow = await handler(
      request("owner", "/sync/ws-cap/secrets/SECRET_50", {
        ...jsonBody({
          mode: "create",
          usage: "http-url",
          value: "https://hooks.slack.com/services/A/B/C",
        }),
        method: "PUT",
      }),
    );
    expect(overflow.status).toBe(409);
    const overflowBody = (await overflow.json()) as { error: string; code: string };
    expect(overflowBody.code).toBe("workspace_secret_limit_reached");
    expect(overflowBody.error).toContain("50");

    expect(countRows(storagePath(storage), "sync_relay_workspace_secrets")).toBe(50);
    initializeAccountDeletion(storage, LINK_KEY);
    const fenced = fenceAccount(storage, LINK_KEY, "owner", "owner@dohc.test");
    expect(fenced.manifest).not.toBeNull();
    purgeAccountRows(storage, "owner", "owner@dohc.test", fenced.manifest!);
    expect(countRows(storagePath(storage), "sync_relay_workspace_secrets")).toBe(0);
  });
});
