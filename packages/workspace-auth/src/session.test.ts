import { expect, it, vi } from "vitest";
import type { WorkspaceAuth } from "./betterAuth";
import { createSessionActorResolver, UnauthorizedError } from "./session";

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
