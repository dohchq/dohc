import { expect, it } from "vitest";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { fetchShareViewAccess } from "./shareViewInfo";

it.each([401, 403, 404, 429, 500, 502])("does not infer removal from a bare %s", async (status) => {
  const check = fetchShareViewAccess({
    shareId: "share",
    relay: {
      baseUrl: "https://relay.test",
      token: "session",
      fetch: async () => new Response("proxy error", { status }),
    },
  });
  await expect(check).rejects.not.toBeInstanceOf(ShareUnavailableError);
});

it("recognizes only the relay's access-removed reason", async () => {
  const check = (status: number, body: unknown) =>
    fetchShareViewAccess({
      shareId: "share",
      relay: {
        baseUrl: "https://relay.test",
        token: "session",
        fetch: async () => Response.json(body, { status }),
      },
    });
  await expect(check(404, { code: "share_access_removed" })).rejects.toBeInstanceOf(
    ShareUnavailableError,
  );
  await expect(check(404, { code: "not_found" })).rejects.not.toBeInstanceOf(ShareUnavailableError);
  await expect(check(401, {})).rejects.toBeInstanceOf(RelayUnauthorizedError);
  await expect(check(200, { status: "current", access: "edit" })).resolves.toEqual({
    access: "edit",
  });
  await expect(check(200, { access: "admin" })).rejects.toThrow();
  // A membership names its role, so the desktop can tell an admin at Edit
  // from a member at Edit.
  await expect(
    check(200, { status: "current", access: "comment", role: "admin" }),
  ).resolves.toEqual({ access: "comment", role: "admin" });
  await expect(
    check(200, { status: "current", access: "comment", role: "member" }),
  ).resolves.toEqual({ access: "comment", role: "member" });
  await expect(
    check(200, { status: "current", access: "comment", role: "owner" }),
  ).rejects.toThrow();
});

it("reads who set a membership's level, and only as a name", async () => {
  const check = (body: unknown) =>
    fetchShareViewAccess({
      shareId: "share",
      relay: {
        baseUrl: "https://relay.test",
        token: "session",
        fetch: async () => Response.json(body),
      },
    });
  await expect(
    check({ status: "current", access: "view", role: "member", levelChangedBy: "Ana" }),
  ).resolves.toEqual({ access: "view", role: "member", levelChangedBy: "Ana" });
  await expect(
    check({ status: "current", access: "view", role: "member", levelChangedBy: 7 }),
  ).rejects.toThrow();
  await expect(
    check({ status: "current", access: "view", role: "member", levelChangedBy: "" }),
  ).rejects.toThrow();
});
