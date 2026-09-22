import { getCookies } from "better-auth/cookies";
import { expect, it } from "vitest";
import { createNamedAppMaterialResolver } from "./namedAppMaterial";

const publicOrigin = "https://viewer.example.com", relayUrl = "https://relay.example.org", publicationId = "a".repeat(64), workspaceId = "workspace-1";
const account = getCookies({ baseURL: publicOrigin });
const cookie = `${account.sessionToken.name}=account-secret`, exchangeKey = "k".repeat(32);
const prefix = `${relayUrl}/sync/link/app-publications/${publicationId}`;
const target = `${relayUrl}/sync/${workspaceId}/app-publications/${publicationId}/backend`;

async function fixture() {
  const requests: Request[] = [];
  const resolve = createNamedAppMaterialResolver({ relayUrl, publicOrigin, exchangeKey, fetchRelay: async request => { requests.push(request); return Response.json({ ok: true }); } });
  const material = await resolve(workspaceId, publicationId, cookie + "; unrelated=private; __Host-dohc-app=app-secret", new AbortController().signal);
  if (!material.ok) throw Error("Expected named launch material");
  return { resolve, material, requests };
}

it("maps only the bound publication routes and forwards filtered account authority", async () => {
  const f = await fixture();
  for (const [method, suffix, mapped] of [
    ["GET", "", "/descriptor"], ["GET", `/blobs/${"b".repeat(64)}?authorityRevision=3`, `/blobs/${"b".repeat(64)}?authorityRevision=3`],
    ["POST", "/backend/attempt", "/attempt"], ["POST", "/backend/invoke", "/invoke"], ["POST", "/backend/upload", "/upload"], ["POST", "/backend/file", "/file"],
  ] as const) {
    const request = new Request(prefix + suffix, { method, body: method === "POST" ? '{"authorityRevision":3}' : undefined, headers: {
      "content-type": "application/json", authorization: "Bearer attacker", cookie: "stolen=secret", origin: "https://attacker.example", "x-dohc-relay-exchange-key": "attacker", "x-dohc-link-profile-secret": "link-secret",
    } });
    expect((await f.material.fetchRelay(request)).status).toBe(200);
    const sent = f.requests.at(-1)!;
    expect(sent.url).toBe(target + mapped); expect(sent.redirect).toBe("manual");
    expect(Object.fromEntries(sent.headers)).toEqual({ cookie, origin: publicOrigin, "x-dohc-relay-exchange-key": exchangeKey, ...(method === "POST" ? { "content-type": "application/json" } : {}) });
    if (method === "POST") expect(await sent.text()).toBe('{"authorityRevision":3}');
  }
});

it("refuses destination, publication, query, and method widening before forwarding credentials", async () => {
  const f = await fixture();
  for (const [url, method] of [
    [prefix.replace("relay.example.org", "attacker.example"), "GET"],
    [prefix.replace(publicationId, "b".repeat(64)), "GET"], [prefix + "?private=1", "GET"],
    [prefix + "/backend/describe", "GET"], [prefix + "/backend/helpers", "POST"], [prefix + "/collection", "GET"],
    [prefix + `/blobs/${"b".repeat(64)}?authorityRevision=1&authorityRevision=2`, "GET"],
    [prefix + `/blobs/${"b".repeat(64)}?authorityRevision=1&extra=true`, "GET"],
    [prefix + `/blobs/${"b".repeat(64)}?authorityRevision=0`, "GET"],
    [prefix + "/backend/invoke", "DELETE"], [prefix + "/backend/invoke?caller=owner", "POST"],
  ]) expect((await f.material.fetchRelay(new Request(url!, { method, headers: { "content-type": "application/json" } }))).status).toBe(404);
  expect(f.requests).toHaveLength(0);
});

it("rejects missing or ambiguous account cookies and invalid launch identifiers", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  for (const supplied of [null, "unrelated=secret", cookie + "; " + cookie]) expect((await f.resolve(workspaceId, publicationId, supplied, signal)).ok).toBe(false);
  for (const workspace of ["../workspace", "workspace\n", "x".repeat(129)]) expect((await f.resolve(workspace, publicationId, cookie, signal)).ok).toBe(false);
  expect((await f.resolve(workspaceId, publicationId + "\n", cookie, signal)).ok).toBe(false);
  expect(f.requests).toHaveLength(0);
});

it("requires secure configuration and retains cancellation", async () => {
  const fetchRelay = async () => new Response(null);
  for (const patch of [{ publicOrigin: "http://viewer.example.com" }, { publicOrigin: publicOrigin + "/path" }, { exchangeKey: "short" }]) {
    expect(() => createNamedAppMaterialResolver({ relayUrl, publicOrigin, exchangeKey, fetchRelay, ...patch })).toThrow();
  }
  const f = await fixture(), controller = new AbortController(); controller.abort();
  await expect(f.material.fetchRelay(new Request(prefix, { signal: controller.signal }))).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});
