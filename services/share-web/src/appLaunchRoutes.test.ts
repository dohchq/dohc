import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShareWebApplication, SHARE_WEB_CSP } from "./server";

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
