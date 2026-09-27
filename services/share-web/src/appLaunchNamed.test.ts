import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createAppLaunchHandler } from "./appLaunch";

const config = { viewerOrigin: "https://viewer.example.com", appDomain: "example.net" };
const publicationId = "a".repeat(64), workspaceId = "workspace-1";
function fixture() {
  let active = true, revision = 1, relayDown = false, materialDown = false;
  const requests: Request[] = [], resolutions: unknown[] = [];
  const bytes = Buffer.from("document.getElementById('root').textContent='Admin app';");
  const file = { path: "bundle.js", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, contentType: "text/javascript; charset=utf-8" };
  const handler = createAppLaunchHandler({
    config, relayUrl: "https://relay.example.org",
    fetchRelay: async () => { throw Error("Named launches must use their bound transport."); },
    resolveMaterial: async () => { throw Error("Named launches must not resolve a link session."); },
    resolveNamedMaterial: async (workspace, publication, cookie) => {
      resolutions.push({ workspace, publication, cookie });
      if (materialDown) return { ok: false, status: 503 };
      if (workspace !== workspaceId || publication !== publicationId || cookie !== "account=owner-session") return { ok: false, status: 401 };
      return { ok: true, kind: "named", admissionKey: "owner-session-key", setCookie: null, fetchRelay: async request => {
        requests.push(request);
        expect(request.headers.has("cookie")).toBe(false);
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.headers.has("x-dohc-link-profile-secret")).toBe(false);
        if (relayDown) throw Error("Relay unavailable");
        if (!active) return new Response(null, { status: 403 });
        const url = new URL(request.url);
        expect(url.pathname).toContain(`/sync/link/app-publications/${publicationId}`);
        if (url.pathname.endsWith("/summary")) return Response.json({subjectName: "Trip planner", sharerName: "Ana", access: "comment"});
        if (url.pathname.endsWith(`/blobs/${file.sha256}`)) return new Response(bytes, { headers: { "content-type": file.contentType } });
        if (url.pathname.endsWith("/backend/invoke")) {
          const body = await request.json();
          return body.authorityRevision === revision ? Response.json({ result: { updated: true }, revision: 2, replayed: false }) : new Response(null, { status: 404 });
        }
        return Response.json({ publicationId, authorityRevision: revision, files: [file] });
      } };
    },
  });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => handler.handle(new Request(url, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { host: new URL(url).host, "content-type": "application/json", ...headers },
  }));
  const issue = (body: unknown = { workspaceId, publicationId }, headers: Record<string, string> = {}) => post(`${config.viewerOrigin}/api/apps/launch`, body, { origin: config.viewerOrigin, cookie: "account=owner-session", ...headers });
  const open = async () => {
    const issued = await issue(); expect(issued.status).toBe(200);
    const handoff = await issued.json();
    const bootstrap = await post(handoff.action, new URLSearchParams({ handoff: handoff.handoff }).toString(), { origin: config.viewerOrigin, "content-type": "application/x-www-form-urlencoded" });
    expect(bootstrap.status).toBe(200);
    const html = await bootstrap.text(), origin = new URL(handoff.action).origin;
    const proof = /const proof="([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const call = (path: string, body: unknown = "", custom: Record<string, string> = {}) => post(origin + path, body, { origin, cookie, "x-dohc-app-proof": proof, ...custom });
    return { html, call };
  };
  const summary = (cookie = "account=owner-session") => post(`${config.viewerOrigin}/api/apps/summary`, {workspaceId, publicationId}, {origin: config.viewerOrigin, cookie});
  return { summary, issue, open, resolutions, requests, revoke() { active = false; }, narrow() { revision++; }, disconnect() { relayDown = true; }, failMaterial() { materialDown = true; } };
}

it("launches a signed-in app without exposing account cookies or named credentials to its document", async () => {
  const f = fixture(), app = await f.open();
  expect(f.resolutions).toEqual([{ workspace: workspaceId, publication: publicationId, cookie: "account=owner-session" }]);
  expect(app.html).not.toContain("owner-session");
  expect(app.html).not.toContain(workspaceId);
  const doc = await app.call("/document"); expect(doc.status).toBe(200);
  expect(await doc.text()).toContain("Admin app");
  const response = await app.call("/backend", { id: "update", op: "backend.invoke", operation: "registrations.update", idempotencyKey: "update-1", input: {} });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ result: { updated: true }, revision: 2, replayed: false });
  expect((await app.call("/collection", { id: "list", op: "collection.list", limit: 1 })).status).toBe(404);
});

it("rejects mixed launch authority, unsafe workspace identifiers, and untrusted origins", async () => {
  const f = fixture();
  for (const body of [
    { workspaceId, publicationId, discriminator: "abcdefghijkl" }, { workspaceId, publicationId, userId: "owner" },
    { workspaceId: "../private", publicationId }, { workspaceId: workspaceId + "\n", publicationId },
    { workspaceId, publicationId: publicationId + "\n" },
  ]) expect((await f.issue(body)).status).toBe(404);
  expect((await f.issue(undefined, { origin: "null" })).status).toBe(404);
  expect(f.resolutions).toHaveLength(0);
  expect((await f.issue(undefined, { cookie: "account=attacker" })).status).toBe(404);
});

it("rechecks named authorization on backend, document, and status requests", async () => {
  const f = fixture(), app = await f.open();
  const input = { id: "update", op: "backend.invoke", operation: "registrations.update", idempotencyKey: "update-1", input: {} };
  expect((await app.call("/backend", input, { origin: "null" })).status).toBe(404);
  f.narrow(); expect((await app.call("/backend", input)).status).toBe(404);
  f.revoke();
  for (const path of ["/backend", "/document", "/status"]) expect((await app.call(path, path === "/backend" ? input : "")).status).toBe(404);
});

it("distinguishes unavailable named session resolution and relay transport from refusal", async () => {
  const f = fixture(), app = await f.open();
  f.disconnect(); expect((await app.call("/status")).status).toBe(503);
  f.failMaterial(); expect((await f.issue()).status).toBe(503);
});

it("names an authorized named app without issuing a launch or exposing labels to probes", async () => {
  const f = fixture();
  expect(await (await f.summary()).json()).toEqual({subjectName: "Trip planner", sharerName: "Ana", access: "comment"});
  expect((await f.summary("account=attacker")).status).toBe(404);
  f.revoke(); const response = await f.summary(); expect(response.status).toBe(404); expect(await response.text()).not.toContain("Trip planner");
});
