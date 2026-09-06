import { createWorkspaceAuth, type WorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import { createSessionActorResolver, UnauthorizedError } from "@dohc/workspace-auth/session";
import { betterAuth } from "better-auth";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createShareWebApplication } from "./server";
import { createNamedLiveBrowserResolver } from "../../sync-relay/src/namedLiveBrowserAuth";
import { closeTestStorages, testStorage } from "../../sync-relay/src/testing";

const connectionString = process.env.POSTGRES_URL ?? "postgres://dohc:dohc@localhost:54329/dohc";
const probe = new Client({ connectionString, connectionTimeoutMillis: 2000 });
let available = false;
try {
  await probe.connect();
  available = true;
} catch {
  if (process.env.DOHC_REQUIRE_POSTGRES === "1") throw new Error("Named browser auth requires reachable Postgres.");
} finally {
  await probe.end();
}

const origin = "https://share.example.test";
const authOrigin = "https://auth.example.test";
const password = "a-real-browser-password-123";
const schema = `share_web_auth_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;
let admin: Client;
let schemaCreated = false;
let auth: WorkspaceAuth;
let relayAuth: WorkspaceAuth;

describe.skipIf(!available)("named browser production auth lifecycle", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await pool.query(await readFile(new URL("../../../packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url), "utf8"));
    const options = {
      pool, baseURL: authOrigin, secret: "browser-auth-test-secret-at-least-32-characters",
      trustedOrigins: [origin], sendEmail: async () => {},
    };
    auth = createWorkspaceAuth(options);
    relayAuth = createWorkspaceAuth(options);
  });

  afterAll(async () => {
    await closeTestStorages();
    await pool?.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("signs in on the viewer host, resolves real accounts server-side, and invalidates sign-out", async () => {
    const alice = await auth.api.signUpEmail({ body: { email: "alice@example.test", password, name: "Alice" } });
    const bob = await auth.api.signUpEmail({ body: { email: "bob@example.test", password, name: "Bob" } });
    const { handle: serve } = createShareWebApplication({
      relayUrl: "http://relay:1788", publicRelayUrl: "https://relay.example.test", publicHosts: new Set(["share.example.test"]),
      accountAuth: { upstreamUrl: "http://workspace-api:1786", publicOrigin: origin },
      fetchAuth: (request) => auth.handler(request),
    });
    const resolve = createSessionActorResolver(relayAuth);
    function browserRequest(operation: string, body?: unknown, cookie?: string) {
      return new Request(`${origin}/api/account/${operation}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: "share.example.test", origin, "sec-fetch-site": "same-origin",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function signIn(email: string, expected: { id: string; name: string }) {
      const response = await serve(browserRequest("sign-in", { email, password }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, user: expected });
      expect(response.headers.get("set-auth-token")).toBeNull();
      const name = getCookies({ baseURL: origin }).sessionToken.name;
      const line = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
      expect(line).toBeDefined();
      const attributes = parseSetCookieHeader(line!).get(name)!;
      expect(attributes).toMatchObject({ secure: true, httponly: true, samesite: "lax", path: "/" });
      expect(attributes).not.toHaveProperty("domain");
      return line!.split(";", 1)[0]!;
    }
    const aliceCookie = await signIn("alice@example.test", { id: alice.user.id, name: "Alice" });
    const bobCookie = await signIn("bob@example.test", { id: bob.user.id, name: "Bob" });
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
    const scopes = [alice.user, bob.user].map((user) => {
      const scope = { workspaceId: "workspace", shareId: `share-${user.id}`, grantId: `grant-${user.id}` };
      storage.createShare({
        share: {
          shareId: scope.shareId, workspaceId: scope.workspaceId, granterUserId: "owner",
          selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1,
        },
        grant: {
          grantId: scope.grantId, shareId: scope.shareId, principalKind: "user",
          principalUserId: user.id, principalEmail: null, access: "edit", generation: 1,
          status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null,
        },
      });
      return scope;
    });
    const aliceScope = scopes[0]!;
    const bobScope = scopes[1]!;
    const resolveBrowser = createNamedLiveBrowserResolver({ storage, resolveActor: resolve });
    const projected = await serve(browserRequest("session", undefined, `${aliceCookie}; dohc_share_link=link-secret; dohc_profile=profile-secret`));
    expect(await projected.json()).toEqual({ user: { id: alice.user.id, name: "Alice" } });

    const actorRequest = (cookie: string) => new Request("https://relay.example.test/sync/shares/share", {
      headers: { cookie, "x-user-id": bob.user.id },
    });
    expect(await resolve(actorRequest(aliceCookie), "workspace")).toEqual({ userId: alice.user.id, workspaceId: "workspace" });
    expect(await resolve(actorRequest(bobCookie), "workspace")).toEqual({ userId: bob.user.id, workspaceId: "workspace" });
    expect(await resolveBrowser(actorRequest(aliceCookie), aliceScope)).toEqual({ userId: alice.user.id, ...aliceScope });
    expect(await resolveBrowser(actorRequest(bobCookie), bobScope)).toEqual({ userId: bob.user.id, ...bobScope });
    expect(await resolveBrowser(actorRequest(aliceCookie), bobScope)).toBeNull();
    expect(await resolveBrowser(actorRequest(bobCookie), aliceScope)).toBeNull();
    expect(await resolveBrowser(actorRequest("dohc_share_link=link-secret; dohc_profile=profile-secret"), aliceScope)).toBeNull();
    await expect(resolve(actorRequest("dohc_share_link=link-secret; dohc_profile=profile-secret"), "workspace")).rejects.toBeInstanceOf(UnauthorizedError);

    const signOut = await serve(browserRequest("sign-out", {}, aliceCookie));
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ ok: true });
    expect(signOut.headers.getSetCookie().every((line) => !line.includes("dohc_"))).toBe(true);
    await expect(resolve(actorRequest(aliceCookie), "workspace")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await resolveBrowser(actorRequest(aliceCookie), aliceScope)).toBeNull();
    expect(await resolveBrowser(actorRequest(bobCookie), bobScope)).toEqual({ userId: bob.user.id, ...bobScope });
    expect(storage.revokeShareGrant({ shareId: bobScope.shareId, grantId: bobScope.grantId, revokedAtMs: 2 }).ok).toBe(true);
    expect(await resolveBrowser(actorRequest(bobCookie), bobScope)).toBeNull();
    expect(await resolve(actorRequest(bobCookie), "workspace")).toEqual({ userId: bob.user.id, workspaceId: "workspace" });
    expect(await (await serve(browserRequest("session", undefined, aliceCookie))).json()).toEqual({ user: null });
  });

  it("keeps the production sign-in rate limit separate for verified clients despite forged forwarding headers", async () => {
    // Test mode disables BetterAuth's production default; retain the real factory options and enable it explicitly.
    const limitedAuth = betterAuth({ ...auth.options, rateLimit: { enabled: true } });
    expect((await limitedAuth.$context).rateLimit.enabled).toBe(true);
    await limitedAuth.api.signUpEmail({ body: { email: "limited@example.test", password, name: "Limited" } });
    const { handle: serve } = createShareWebApplication({
      relayUrl: "http://relay:1788", publicRelayUrl: "https://relay.example.test", publicHosts: new Set(["share.example.test"]),
      accountAuth: { upstreamUrl: "http://workspace-api:1786", publicOrigin: origin },
      fetchAuth: (request) => limitedAuth.handler(request),
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const signIn = (verified: string, claimed: string) => serve(new Request(`${origin}/api/account/sign-in`, {
        method: "POST", headers: {
          host: "share.example.test", origin, "content-type": "application/json", "sec-fetch-site": "same-origin",
          "x-dohc-share-web-client-ip": verified, "x-forwarded-for": claimed,
        },
        body: JSON.stringify({ email: "limited@example.test", password }),
      }));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await signIn("198.51.100.31", `203.0.113.${attempt}`)).status).toBe(200);
      }
      const fourthA = await signIn("198.51.100.31", "203.0.113.4");
      expect(fourthA.status).toBe(429);
      expect(fourthA.headers.get("retry-after")).toBe("10");
      expect(await fourthA.json()).toEqual({ ok: false });
      expect(fourthA.headers.getSetCookie()).toEqual([]);
      expect(fourthA.headers.get("set-auth-token")).toBeNull();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await signIn("198.51.100.32", "198.51.100.31")).status).toBe(200);
      }
      expect((await signIn("198.51.100.32", "203.0.113.99")).status).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });
});
