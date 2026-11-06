import { expect, it, vi } from "vitest";
import type { WorkspaceAuth } from "./betterAuth";
import { accountSessionFrom, createAccountSessionResolver, createSessionActorResolver, UnauthorizedError } from "./session";

vi.mock("./betterAuth", () => {
  throw new Error("Session helpers must not initialize Better Auth.");
});

function fixture(session: { user: { id: string } } | null) {
  const getSession = vi.fn(async () => session);
  const auth = { api: { getSession } } as unknown as WorkspaceAuth;
  return { getSession, resolve: createSessionActorResolver(auth) };
}

it("uses the validated session identity and the requested workspace", async () => {
  const { getSession, resolve } = fixture({ user: { id: "session-user" } });
  const request = new Request("https://workspace.example/files?userId=caller-user", {
    headers: { authorization: "Bearer session-token" },
  });
  await expect(resolve(request, "workspace-one")).resolves.toEqual({
    userId: "session-user", workspaceId: "workspace-one",
  });
  expect(getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers });
});

it("refuses a request without a validated session", async () => {
  const { resolve } = fixture(null);
  await expect(resolve(new Request("https://workspace.example/files"), "workspace-one"))
    .rejects.toMatchObject(new UnauthorizedError());
});

it("does not turn a session lookup failure into an actor", async () => {
  const { getSession, resolve } = fixture(null);
  const failure = new Error("Session lookup failed");
  getSession.mockRejectedValueOnce(failure);
  await expect(resolve(new Request("https://workspace.example/files"), "workspace-one"))
    .rejects.toBe(failure);
});

it("binds an account session to the validated sign-in, never to request fields", async () => {
  const getSession = vi.fn(async () => ({
    user: { id: "session-user" },
    session: { id: "sign-in-1", userId: "session-user", expiresAt: new Date(5_000) },
  }));
  const resolve = createAccountSessionResolver({ api: { getSession } } as unknown as WorkspaceAuth);
  const request = new Request("https://workspace.example/push?userId=caller-user&sessionId=forged", {
    headers: { cookie: "session=token" },
  });
  await expect(resolve(request)).resolves.toEqual({ userId: "session-user", sessionId: "sign-in-1", expiresAtMs: 5_000 });
  expect(getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers });
});

it("refuses an account session without a validated, consistent sign-in", async () => {
  const resolve = createAccountSessionResolver({ api: { getSession: async () => null } } as unknown as WorkspaceAuth);
  await expect(resolve(new Request("https://workspace.example/push"))).rejects.toMatchObject(new UnauthorizedError());
  expect(() => accountSessionFrom({ user: { id: "a" }, session: { id: "s", userId: "b", expiresAt: 1 } }))
    .toThrow(UnauthorizedError);
  expect(() => accountSessionFrom({ user: { id: "a" }, session: { id: "", userId: "a", expiresAt: 1 } }))
    .toThrow(UnauthorizedError);
  expect(() => accountSessionFrom({ user: { id: "a" }, session: { id: "s", userId: "a", expiresAt: "never" } }))
    .toThrow(UnauthorizedError);
});

it("takes the alert mention name from the validated account", () => {
  expect(accountSessionFrom({user: {id: "account", name: "Alice"},
    session: {id: "sign-in", userId: "account", expiresAt: 5000}})).toEqual({
    userId: "account", sessionId: "sign-in", expiresAtMs: 5000, displayName: "Alice",
  });
});
