import { expect, it, vi } from "vitest";
import type { WorkspaceAuth } from "./betterAuth";
import {
  accountSessionFrom,
  createAccountSessionResolver,
  createPhoneCapableAccountSessionResolver,
  createSessionActorResolver,
  UnauthorizedError,
  type SessionKind,
} from "./session";

vi.mock("./betterAuth", () => {
  throw new Error("Session helpers must not initialize Better Auth.");
});

function fixture(session: { user: { id: string }; session: { clientKind: string } } | null) {
  const getSession = vi.fn(async () => session);
  const auth = { api: { getSession } } as unknown as WorkspaceAuth;
  return { getSession, resolve: createSessionActorResolver(auth) };
}

it("uses the validated session identity and the requested workspace", async () => {
  const { getSession, resolve } = fixture({
    user: { id: "session-user" },
    session: { clientKind: "desktop" },
  });
  const request = new Request("https://workspace.example/files?userId=caller-user", {
    headers: { authorization: "Bearer session-token" },
  });
  await expect(resolve(request, "workspace-one")).resolves.toEqual({
    userId: "session-user",
    workspaceId: "workspace-one",
  });
  expect(getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers });
});

it("refuses a request without a validated session", async () => {
  const { resolve } = fixture(null);
  await expect(
    resolve(new Request("https://workspace.example/files"), "workspace-one"),
  ).rejects.toMatchObject(new UnauthorizedError());
});

it("does not turn a session lookup failure into an actor", async () => {
  const { getSession, resolve } = fixture(null);
  const failure = new Error("Session lookup failed");
  getSession.mockRejectedValueOnce(failure);
  await expect(
    resolve(new Request("https://workspace.example/files"), "workspace-one"),
  ).rejects.toBe(failure);
});

it("binds an account session to the validated sign-in, never to request fields", async () => {
  const getSession = vi.fn(async () => ({
    user: { id: "session-user" },
    session: {
      id: "sign-in-1",
      userId: "session-user",
      expiresAt: new Date(5_000),
      clientKind: "browser",
    },
  }));
  const resolve = createAccountSessionResolver({ api: { getSession } } as unknown as WorkspaceAuth);
  const request = new Request(
    "https://workspace.example/push?userId=caller-user&sessionId=forged",
    {
      headers: { cookie: "session=token" },
    },
  );
  await expect(resolve(request)).resolves.toEqual({
    userId: "session-user",
    sessionId: "sign-in-1",
    expiresAtMs: 5_000,
    clientKind: "browser",
  });
  expect(getSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers });
});

it("refuses an account session without a validated, consistent sign-in", async () => {
  const resolve = createAccountSessionResolver({
    api: { getSession: async () => null },
  } as unknown as WorkspaceAuth);
  await expect(resolve(new Request("https://workspace.example/push"))).rejects.toMatchObject(
    new UnauthorizedError(),
  );
  expect(() =>
    accountSessionFrom({
      user: { id: "a" },
      session: { id: "s", userId: "b", expiresAt: 1, clientKind: "desktop" },
    }),
  ).toThrow(UnauthorizedError);
  expect(() =>
    accountSessionFrom({
      user: { id: "a" },
      session: { id: "", userId: "a", expiresAt: 1, clientKind: "desktop" },
    }),
  ).toThrow(UnauthorizedError);
  expect(() =>
    accountSessionFrom({
      user: { id: "a" },
      session: { id: "s", userId: "a", expiresAt: "never", clientKind: "desktop" },
    }),
  ).toThrow(UnauthorizedError);
  for (const clientKind of [undefined, null, "", "Phone", "agent"])
    expect(
      () =>
        accountSessionFrom({
          user: { id: "a" },
          session: { id: "s", userId: "a", expiresAt: 1, clientKind },
        }),
      `kind ${String(clientKind)}`,
    ).toThrow(UnauthorizedError);
});

it("takes the alert mention name from the validated account", () => {
  expect(
    accountSessionFrom({
      user: { id: "account", name: "Alice" },
      session: { id: "sign-in", userId: "account", expiresAt: 5000, clientKind: "desktop" },
    }),
  ).toEqual({
    userId: "account",
    sessionId: "sign-in",
    expiresAtMs: 5000,
    clientKind: "desktop",
    displayName: "Alice",
  });
});

function kindAuth(clientKind: SessionKind) {
  const getSession = vi.fn(async () => ({
    user: { id: "account" },
    session: { id: "sign-in", userId: "account", expiresAt: 5000, clientKind },
  }));
  return { api: { getSession } } as unknown as WorkspaceAuth;
}

it("refuses a phone session on every workspace route, and accepts desktop and browser ones", async () => {
  const request = new Request("https://workspace.example/files", {
    headers: { authorization: "Bearer session-token" },
  });
  await expect(createSessionActorResolver(kindAuth("phone"))(request, "ws")).rejects.toMatchObject(
    new UnauthorizedError(),
  );
  for (const kind of ["desktop", "browser"] as const)
    await expect(createSessionActorResolver(kindAuth(kind))(request, "ws")).resolves.toEqual({
      userId: "account",
      workspaceId: "ws",
    });
});

it("refuses a phone session by default, and only the phone-capable resolver accepts it", async () => {
  const request = new Request("https://workspace.example/push", {
    headers: { authorization: "Bearer session-token" },
  });
  await expect(createAccountSessionResolver(kindAuth("phone"))(request)).rejects.toMatchObject(
    new UnauthorizedError(),
  );
  await expect(createAccountSessionResolver(kindAuth("desktop"))(request)).resolves.toMatchObject({
    clientKind: "desktop",
  });
  for (const kind of ["phone", "desktop", "browser"] as const)
    await expect(
      createPhoneCapableAccountSessionResolver(kindAuth(kind))(request),
    ).resolves.toMatchObject({ sessionId: "sign-in", clientKind: kind });
});
