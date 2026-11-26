import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { LINK_REFUSALS, linkRefusalBody } from "@dohc/security-contract/link-refusal";
import { createAppLaunchHandler } from "./appLaunch";

const config = { viewerOrigin: "https://viewer.example.com", appDomain: "example.net" };
const publicationId = "a".repeat(64),
  workspaceId = "workspace-1";
function fixture() {
  let active = true,
    revision = 1,
    relayDown = false,
    materialDown = false,
    collectionMissing = false,
    member = false;
  const requests: Request[] = [],
    resolutions: unknown[] = [];
  const bytes = Buffer.from("document.getElementById('root').textContent='Admin app';");
  const file = {
    path: "bundle.js",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    contentType: "text/javascript; charset=utf-8",
  };
  const reviewed = {
    path: `app/${"long-folder/".repeat(30)}index.ts`,
    sha256: file.sha256,
    byteLength: file.byteLength,
  };
  const handler = createAppLaunchHandler({
    config,
    relayUrl: "https://relay.example.org",
    fetchRelay: async () => {
      throw Error("Named launches must use their bound transport.");
    },
    resolveMaterial: async () => {
      throw Error("Named launches must not resolve a link session.");
    },
    resolveNamedMaterial: async (workspace, publication, cookie) => {
      resolutions.push({ workspace, publication, cookie });
      if (materialDown) return { ok: false, status: 503 };
      if (
        workspace !== workspaceId ||
        publication !== publicationId ||
        cookie !== "account=owner-session"
      )
        return { ok: false, status: 401 };
      return {
        ok: true,
        kind: "named",
        admissionKey: "owner-session-key",
        setCookie: null,
        fetchRelay: async (request) => {
          requests.push(request);
          expect(request.headers.has("cookie")).toBe(false);
          expect(request.headers.has("authorization")).toBe(false);
          expect(request.headers.has("x-dohc-link-profile-secret")).toBe(false);
          if (relayDown) throw Error("Relay unavailable");
          if (!active) return new Response(null, { status: 403 });
          if (collectionMissing)
            return Response.json(linkRefusalBody("app_collection_missing"), { status: 410 });
          const url = new URL(request.url);
          expect(url.pathname).toContain(`/sync/link/app-publications/${publicationId}`);
          if (member && url.pathname.endsWith("/summary"))
            return Response.json({
              ...memberSummary,
              review: { ...memberSummary.review, source: [reviewed] },
            });
          if (url.pathname.endsWith("/consent"))
            return (await request.json()).scopeDigest === memberSummary.review.scopeDigest
              ? Response.json({ consent: "current" })
              : Response.json({ code: "member_app_review_changed" }, { status: 409 });
          if (url.pathname.endsWith("/summary"))
            return Response.json({
              subjectName: "Trip planner",
              sharerName: "Ana",
              access: "comment",
            });
          if (url.pathname.endsWith(`/blobs/${file.sha256}`))
            return new Response(bytes, { headers: { "content-type": file.contentType } });
          if (url.pathname.endsWith("/backend/invoke")) {
            const body = await request.json();
            return body.authorityRevision === revision
              ? Response.json({ result: { updated: true }, revision: 2, replayed: false })
              : new Response(null, { status: 404 });
          }
          return Response.json({ publicationId, authorityRevision: revision, files: [file] });
        },
      };
    },
  });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    handler.handle(
      new Request(url, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { host: new URL(url).host, "content-type": "application/json", ...headers },
      }),
    );
  const issue = (
    body: unknown = { workspaceId, publicationId },
    headers: Record<string, string> = {},
  ) =>
    post(`${config.viewerOrigin}/api/apps/launch`, body, {
      origin: config.viewerOrigin,
      cookie: "account=owner-session",
      ...headers,
    });
  const open = async () => {
    const issued = await issue();
    expect(issued.status).toBe(200);
    const handoff = await issued.json();
    const bootstrap = await post(
      handoff.action,
      new URLSearchParams({ handoff: handoff.handoff }).toString(),
      { origin: config.viewerOrigin, "content-type": "application/x-www-form-urlencoded" },
    );
    expect(bootstrap.status).toBe(200);
    const html = await bootstrap.text(),
      origin = new URL(handoff.action).origin;
    const proof = /const proof="([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const call = (path: string, body: unknown = "", custom: Record<string, string> = {}) =>
      post(origin + path, body, { origin, cookie, "x-dohc-app-proof": proof, ...custom });
    return { html, call, origin, cookie };
  };
  const summary = (cookie = "account=owner-session") =>
    post(
      `${config.viewerOrigin}/api/apps/summary`,
      { workspaceId, publicationId },
      { origin: config.viewerOrigin, cookie },
    );
  return {
    handler,
    summary,
    issue,
    open,
    resolutions,
    requests,
    revoke() {
      active = false;
    },
    narrow() {
      revision++;
    },
    disconnect() {
      relayDown = true;
    },
    failMaterial() {
      materialDown = true;
    },
    loseCollection() {
      collectionMissing = true;
    },
    becomeMemberApp() {
      member = true;
      return reviewed;
    },
    post,
  };
}

const memberSummary = {
  subjectName: "tracker",
  sharerName: "Ana",
  access: "member",
  review: {
    authorityRevision: 1,
    consent: "none",
    scopeDigest: "c".repeat(64),
    collections: [
      {
        name: "Registrations",
        access: "edit",
        operations: [{ name: "edit", readOnly: false }],
      },
    ],
  },
};

it("shows a Member app's review and source, and records the viewer's consent only for the digest shown", async () => {
  const f = fixture(),
    file = f.becomeMemberApp();
  const viewer = (path: string, body: unknown) =>
    f.post(`${config.viewerOrigin}${path}`, body, {
      origin: config.viewerOrigin,
      cookie: "account=owner-session",
    });
  expect(await (await f.summary()).json()).toEqual({
    ...memberSummary,
    review: { ...memberSummary.review, source: [file] },
  });
  const source = await viewer("/api/apps/source", {
    workspaceId,
    publicationId,
    sha256: file.sha256,
    authorityRevision: 1,
  });
  expect(await source.json()).toEqual({ text: expect.stringContaining("Admin app") });
  expect(f.requests.at(-1)!.url).toContain(`/blobs/${file.sha256}?authorityRevision=1`);
  const consent = (scopeDigest: string) =>
    viewer("/api/apps/consent", { workspaceId, publicationId, scopeDigest });
  expect(await (await consent(memberSummary.review.scopeDigest)).json()).toEqual({
    consent: "current",
  });
  const changed = await consent("d".repeat(64));
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ code: "member_app_review_changed" });
  for (const body of [
    { workspaceId, publicationId, scopeDigest: "not-a-digest" },
    { workspaceId, publicationId, scopeDigest: memberSummary.review.scopeDigest, agent: {} },
  ])
    expect((await viewer("/api/apps/consent", body)).status).toBe(404);
  expect(
    (
      await viewer("/api/apps/source", {
        workspaceId,
        publicationId,
        sha256: file.sha256,
        authorityRevision: 0,
      })
    ).status,
  ).toBe(404);
});

it("launches a signed-in app without exposing account cookies or named credentials to its document", async () => {
  const f = fixture(),
    app = await f.open();
  expect(f.resolutions).toEqual([
    { workspace: workspaceId, publication: publicationId, cookie: "account=owner-session" },
  ]);
  expect(app.html).not.toContain("owner-session");
  expect(app.html).not.toContain(workspaceId);
  const doc = await app.call("/document");
  expect(doc.status).toBe(200);
  expect(await doc.text()).toContain("Admin app");
  const response = await app.call("/backend", {
    id: "update",
    op: "backend.invoke",
    operation: "registrations.update",
    idempotencyKey: "update-1",
    input: {},
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    result: { updated: true },
    revision: 2,
    replayed: false,
  });
  expect(
    (await app.call("/collection", { id: "list", op: "collection.list", limit: 1 })).status,
  ).toBe(404);
});

it("rejects mixed launch authority, unsafe workspace identifiers, and untrusted origins", async () => {
  const f = fixture();
  for (const body of [
    { workspaceId, publicationId, discriminator: "abcdefghijkl" },
    { workspaceId, publicationId, userId: "owner" },
    { workspaceId: "../private", publicationId },
    { workspaceId: workspaceId + "\n", publicationId },
    { workspaceId, publicationId: publicationId + "\n" },
  ])
    expect((await f.issue(body)).status).toBe(404);
  expect((await f.issue(undefined, { origin: "null" })).status).toBe(404);
  expect(f.resolutions).toHaveLength(0);
  expect((await f.issue(undefined, { cookie: "account=attacker" })).status).toBe(404);
});

it("rechecks named authorization on backend, document, and status requests", async () => {
  const f = fixture(),
    app = await f.open();
  const input = {
    id: "update",
    op: "backend.invoke",
    operation: "registrations.update",
    idempotencyKey: "update-1",
    input: {},
  };
  expect((await app.call("/backend", input, { origin: "null" })).status).toBe(404);
  f.narrow();
  expect((await app.call("/backend", input)).status).toBe(404);
  f.revoke();
  for (const path of ["/backend", "/document", "/status"])
    expect((await app.call(path, path === "/backend" ? input : "")).status).toBe(404);
});

it("gives a signed-in person a missing Collection's words on Open app, in an open app, and on reload", async () => {
  const f = fixture(),
    app = await f.open();
  f.loseCollection();
  const status = await app.call("/status");
  expect(status.status).toBe(410);
  expect(await status.json()).toEqual(linkRefusalBody("app_collection_missing"));
  expect(app.html).toContain("if(r.status===410){gone();return;}");
  const reload = (extra: Record<string, string> = {}) =>
    f.handler.handle(
      new Request(`${app.origin}/bootstrap`, {
        headers: { host: new URL(app.origin).host, cookie: app.cookie, ...extra },
      }),
    );
  const page = await reload({ "sec-fetch-mode": "navigate" });
  expect(page.status).toBe(410);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toContain(
    `<p id="status" role="status">${LINK_REFUSALS.app_collection_missing.error}</p>`,
  );
  const fetched = await reload();
  expect(fetched.status).toBe(410);
  expect(await fetched.json()).toEqual(linkRefusalBody("app_collection_missing"));
  const issued = await f.issue();
  expect(issued.status).toBe(410);
  expect(await issued.json()).toEqual(linkRefusalBody("app_collection_missing"));
});

it("distinguishes unavailable named session resolution and relay transport from refusal", async () => {
  const f = fixture(),
    app = await f.open();
  f.disconnect();
  expect((await app.call("/status")).status).toBe(503);
  expect((await f.issue()).status).toBe(503);
  f.failMaterial();
  expect((await f.issue()).status).toBe(503);
});

it("names an authorized named app without issuing a launch or exposing labels to probes", async () => {
  const f = fixture();
  expect(await (await f.summary()).json()).toEqual({
    subjectName: "Trip planner",
    sharerName: "Ana",
    access: "comment",
  });
  expect((await f.summary("account=attacker")).status).toBe(404);
  f.revoke();
  const response = await f.summary();
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("Trip planner");
});

it("gives a signed-in launch the same opening and stopped page, with no workspace, app or account details", async () => {
  const { html } = await fixture().open();
  expect(html).toContain('<body data-state="opening"><main id="message"><svg id="mark"');
  expect(html).toContain(
    "document.body.dataset.state='stopped';document.getElementById('status').textContent=\"This app session ended. Reopen the share link.\";",
  );
  for (const detail of [
    workspaceId,
    publicationId,
    "Trip planner",
    "owner-session",
    "relay.example.org",
  ])
    expect(html).not.toContain(detail);
});
