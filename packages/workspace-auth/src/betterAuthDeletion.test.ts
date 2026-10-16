import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
import { CLIENT_IP_HEADER, createWorkspaceAuth } from "./betterAuth";

const pools: Pool[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(pools.splice(0).map(pool => pool.end())); });

async function fixture() {
  const pool = new Pool(); pools.push(pool);
  const password = "account-deletion-password", userId = randomUUID(), now = new Date();
  const recorded = vi.fn();
  const auth = createWorkspaceAuth({pool, baseURL: "http://localhost:1786", secret: "account-deletion-test-secret-at-least-thirty-two-bytes",
    accountDeletion: {
      preview: async () => ({previewToken: "preview", passwordRequired: true}),
      delete: async (_user, token, confirmPassword) => {
        if (token !== "preview") throw new APIError("CONFLICT", {code: "PREVIEW_CHANGED"});
        await confirmPassword(); recorded(); return {finished: true};
      },
    },
  });
  const context = await auth.$context;
  vi.spyOn(context.internalAdapter, "findSession").mockResolvedValue({
    user: {id: userId, email: "person@example.test", name: "Person", emailVerified: true, createdAt: now, updatedAt: now},
    session: {id: "session", token: "session-token", userId, expiresAt: new Date(Date.now()+context.sessionConfig.expiresIn*1000),
      createdAt: new Date(Date.now()-86_400_000), updatedAt: now},
  });
  const accounts = vi.spyOn(context.internalAdapter, "findAccounts").mockResolvedValue([
    {id: "credential", userId, accountId: userId, providerId: "credential", password: await context.password.hash(password), createdAt: now, updatedAt: now},
  ]);
  const verify = vi.spyOn(context.password, "verify");
  const clientIp = `2001:db8:${userId.replaceAll("-", "").slice(0,4)}:${userId.replaceAll("-", "").slice(4,8)}::1`;
  const post = (body: unknown) => auth.handler(new Request("http://localhost:1786/api/auth/account/delete", {
    method: "POST", headers: {authorization: "Bearer session-token", "content-type": "application/json", [CLIENT_IP_HEADER]: clientIp}, body: JSON.stringify(body),
  }));
  return {post, password, userId, accounts, verify, recorded};
}

it("verifies the account password through Better Auth even with an old session", async () => {
  const f = await fixture();
  const result = await f.post({previewToken: "preview", password: f.password});
  expect(result.status).toBe(200); expect(await result.json()).toEqual({finished: true});
  expect(f.accounts).toHaveBeenCalledWith(f.userId);
  expect(f.verify).toHaveBeenCalledWith({hash: expect.any(String), password: f.password});
  expect(f.recorded).toHaveBeenCalledOnce();
});

it.each([undefined, "", null, 123, "wrong-password"])("refuses password %j before recording deletion", async password => {
  const f = await fixture(), result = await f.post({previewToken: "preview", password});
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({code: password === "wrong-password" ? "INVALID_PASSWORD" : "PASSWORD_REQUIRED"});
  expect(f.recorded).not.toHaveBeenCalled();
});

it("checks the preview before verifying a password", async () => {
  const f = await fixture(), result = await f.post({previewToken: "changed", password: f.password});
  expect(result.status).toBe(409); expect(f.verify).not.toHaveBeenCalled(); expect(f.recorded).not.toHaveBeenCalled();
});

it("rate limits password attempts through Better Auth", async () => {
  const f = await fixture();
  for (let attempt = 0; attempt < 10; attempt++) expect((await f.post({previewToken: "preview", password: "wrong-password"})).status).toBe(400);
  const result = await f.post({previewToken: "preview", password: f.password});
  expect(result.status).toBe(429); expect(result.headers.get("x-retry-after")).toBeTruthy();
  expect(f.verify).toHaveBeenCalledTimes(10); expect(f.recorded).not.toHaveBeenCalled();
});
