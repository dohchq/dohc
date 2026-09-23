import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShareWebApplication, SHARE_WEB_CSP } from "./server";
import { createHash } from "node:crypto";
import { getCookies } from "better-auth/cookies";

it("routes an authenticated viewer launch and allows only app form navigation in viewer CSP", async () => {
  const assets = await mkdtemp(join(tmpdir(), "dohc-app-viewer-"));
  try {
    await writeFile(join(assets, "index.html"), "<!doctype html><title>Viewer</title>");
    const capability = Buffer.alloc(32, 1).toString("base64url"), profile = Buffer.alloc(32, 2).toString("base64url");
    const publicationId = "a".repeat(64), host = "viewer.example.com", viewer = `https://${host}`;
    const application = createShareWebApplication({publicHosts: new Set([host]), relayUrl: "https://relay.example.org", publicRelayUrl: "https://relay.example.org",
      appLaunch: {viewerOrigin: viewer, appDomain: "example.net"}, viewerAssetsDir: assets, newProfileSecret: () => profile,
      fetchRelay: async request => {
        if (new URL(request.url).pathname === "/sync/link-exchange") return Response.json({ok: true, grantId: "grant-alpha", capabilityToken: capability, capabilityExpiresAtMs: Date.now() + 900_000});
        expect(request.headers.get("authorization")).toBe(`LinkCapability ${capability}`);
        expect(request.headers.get("x-dohc-link-profile-secret")).toBe(profile);
        expect(request.headers.has("cookie")).toBe(false);
        return Response.json({publicationId, authorityRevision: 1, files: [{path: "bundle.js", sha256: "b".repeat(64), byteLength: 1, contentType: "text/javascript; charset=utf-8"}]});
      }});
    const viewerResponse = await application.handle(new Request(viewer + "/s/?app=" + publicationId, {headers: {host}}));
    expect(viewerResponse.status).toBe(200);
    expect(viewerResponse.headers.get("content-security-policy")).toBe(SHARE_WEB_CSP.replace("form-action 'none'", "form-action https://*.example.net"));
    const exchange = await application.handle(new Request(viewer + "/api/exchange", {method: "POST", body: JSON.stringify({secret: Buffer.alloc(32, 3).toString("base64url")}), headers: {host, "content-type": "application/json"}}));
    expect(exchange.status).toBe(200);const {session} = await exchange.json();
    const cookie = exchange.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const issued = await application.handle(new Request(viewer + "/api/apps/launch", {method: "POST", body: JSON.stringify({discriminator: session, publicationId}), headers: {host, origin: viewer, cookie, "content-type": "application/json"}}));
    expect(issued.status).toBe(200);expect(await issued.json()).toMatchObject({action: expect.stringMatching(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/), handoff: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
  } finally { await rm(assets, {recursive: true, force: true}); }
});

it("binds a named launch to the account cookie and rechecks its relay authority", async () => {
  const publicationId = "a".repeat(64), workspaceId = "workspace-1", viewer = "https://viewer.example.com";
  const account = getCookies({ baseURL: viewer });
  const cookie = `${account.sessionToken.name}=account-secret`, exchangeKey = "k".repeat(32);
  const bytes = Buffer.from("document.getElementById('root').textContent='Admin';");
  const file = { path: "bundle.js", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, contentType: "text/javascript; charset=utf-8" };
  let active = true;
  const calls: string[] = [];
  const application = createShareWebApplication({ publicHosts: new Set(["viewer.example.com"]), relayUrl: "https://relay.example.org", publicRelayUrl: "https://relay.example.org",
    appLaunch: { viewerOrigin: viewer, appDomain: "example.net" }, relayExchangeKey: exchangeKey,
    accountAuth: { publicOrigin: viewer, upstreamUrl: "https://auth.example.org" },
    fetchRelay: async request => {
      calls.push(request.url);
      expect(request.headers.get("cookie")).toBe(cookie);
      expect(request.headers.get("origin")).toBe(viewer);
      expect(request.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("x-dohc-link-profile-secret")).toBe(false);
      if (!active) return new Response(null, { status: 403 });
      const url = new URL(request.url), prefix = `/sync/${workspaceId}/app-publications/${publicationId}/backend`;
      if (url.pathname === prefix + "/descriptor") return Response.json({ publicationId, authorityRevision: 1, files: [file] });
      if (url.pathname === prefix + "/blobs/" + file.sha256) return new Response(bytes, { headers: { "content-type": file.contentType } });
      if (url.pathname === prefix + "/invoke") return Response.json({ result: { saved: true }, revision: 1, replayed: false });
      throw Error("Unexpected named destination " + url.pathname);
    } });
  const post = (url: string, body: string, headers: Record<string, string>) => application.handle(new Request(url, { method: "POST", body, headers: { host: new URL(url).host, ...headers } }));
  const issue = (suppliedCookie: string) => post(viewer + "/api/apps/launch", JSON.stringify({ workspaceId, publicationId }), { origin: viewer, cookie: suppliedCookie, "content-type": "application/json" });
  expect((await issue("unrelated=secret")).status).toBe(404); expect(calls).toHaveLength(0);
  const issued = await issue(cookie + "; unrelated=private"); expect(issued.status).toBe(200);
  const handoff = await issued.json();
  const bootstrap = await post(handoff.action, new URLSearchParams({ handoff: handoff.handoff }).toString(), { origin: viewer, "content-type": "application/x-www-form-urlencoded" });
  expect(bootstrap.status).toBe(200);
  const html = await bootstrap.text(), origin = new URL(handoff.action).origin;
  expect(html).not.toContain("account-secret"); expect(html).not.toContain(exchangeKey);
  const proof = /const proof="([A-Za-z0-9_-]{43})"/.exec(html)![1]!, appCookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const invoke = () => post(origin + "/backend", JSON.stringify({ id: "update", op: "backend.invoke", operation: "registrations.update", idempotencyKey: "attempt-1", input: {} }), { origin, cookie: appCookie, "x-dohc-app-proof": proof, "content-type": "application/json" });
  expect((await invoke()).status).toBe(200);
  active = false; expect((await invoke()).status).toBe(404);
});
