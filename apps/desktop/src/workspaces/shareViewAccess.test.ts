import { expect, it } from "vitest";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { fetchShareViewAccess } from "./shareViewInfo";

it.each([401, 403, 404, 429, 500, 502])("does not infer removal from a bare %s", async status => {
  const check = fetchShareViewAccess({ shareId: "share", relay: { baseUrl: "https://relay.test", token: "session",
    fetch: async () => new Response("proxy error", { status }) } });
  await expect(check).rejects.not.toBeInstanceOf(ShareUnavailableError);
});

it("recognizes only the relay's access-removed reason", async () => {
  const check = (status: number, body: unknown) => fetchShareViewAccess({ shareId: "share", relay: { baseUrl: "https://relay.test", token: "session",
    fetch: async () => Response.json(body, { status }) } });
  await expect(check(404, { code: "share_access_removed" })).rejects.toBeInstanceOf(ShareUnavailableError);
  await expect(check(404, { code: "not_found" })).rejects.not.toBeInstanceOf(ShareUnavailableError);
  await expect(check(401, {})).rejects.toBeInstanceOf(RelayUnauthorizedError);
  await expect(check(200, { status: "current", access: "edit" })).resolves.toBe("edit");
  await expect(check(200, { access: "admin" })).rejects.toThrow();
});
