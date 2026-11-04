import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, test, type Page} from "@playwright/test";
import {LINK_REFUSALS, linkRefusalBody} from "@dohc/security-contract/link-refusal";
import {createAppLaunchHandler} from "../src/appLaunch";
import {viewerPage} from "../viewer/src/pages";

// Real browser, viewer bundle and share-web app handler. The account, summary and relay answers are fixtures;
// sync-relay's tests check the relay's own 410.
const viewer = "https://viewer.test", workspaceId = "ws_1", publicationId = "a".repeat(64);
const words = LINK_REFUSALS.app_collection_missing.error, service = fileURLToPath(new URL("..", import.meta.url));

async function serveViewer(page: Page) {
  await page.route(`${viewer}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/account/session") return route.fulfill({json: {user: {id: "alice", name: "Alice"}}});
    if (url.pathname === "/api/apps/summary") return route.fulfill({json: {subjectName: "Fundraiser", sharerName: "Ana (ana@example.test)", access: "edit"}});
    if (url.pathname === "/api/apps/launch") return route.fulfill({status: 410, json: linkRefusalBody("app_collection_missing")});
    if (url.pathname.startsWith("/api/")) return route.fulfill({status: 404});
    const asset = url.pathname.startsWith("/s/assets/") ? url.pathname.slice(3) : viewerPage(url.pathname);
    if (asset.includes("..")) return route.fulfill({status: 404});
    return route.fulfill({body: await readFile(join(service, "viewer/dist", asset)),
      contentType: asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html"});
  });
}

/** Opens a signed-in app through share-web's app handler, loses its Collection's files, and reloads its page. */
async function reloadAfterCollectionLost() {
  let missing = false;
  const bytes = Buffer.from("document.body.textContent='Fundraiser';");
  const file = {path: "bundle.js", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, contentType: "text/javascript; charset=utf-8"};
  const handler = createAppLaunchHandler({config: {viewerOrigin: viewer, appDomain: "apps.test"}, relayUrl: "https://relay.test",
    fetchRelay: async () => {throw Error("Signed-in apps use their own transport.");},
    resolveMaterial: async () => {throw Error("Signed-in apps have no link session.");},
    resolveNamedMaterial: async () => ({ok: true, kind: "named", admissionKey: "alice", setCookie: null, fetchRelay: async request => {
      if (missing) return Response.json(linkRefusalBody("app_collection_missing"), {status: 410});
      if (new URL(request.url).pathname.endsWith(`/blobs/${file.sha256}`)) return new Response(bytes, {headers: {"content-type": file.contentType}});
      return Response.json({publicationId, authorityRevision: 1, files: [file]});
    }}),
  });
  const post = (url: string, body: string, headers: Record<string, string>) =>
    handler.handle(new Request(url, {method: "POST", body, headers: {host: new URL(url).host, origin: viewer, ...headers}}));
  const issued = await post(`${viewer}/api/apps/launch`, JSON.stringify({workspaceId, publicationId}), {"content-type": "application/json"});
  expect(issued.status).toBe(200);
  const {action, handoff} = await issued.json() as {action: string; handoff: string};
  const opened = await post(action, new URLSearchParams({handoff}).toString(), {"content-type": "application/x-www-form-urlencoded"});
  expect(opened.status).toBe(200);
  missing = true;
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  return {url: action, response: await handler.handle(new Request(action, {headers: {host: new URL(action).host, cookie}}))};
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`a signed-in person sees why a shared app can't open, in ${colorScheme}`, async ({browser}, testInfo) => {
    const context = await browser.newContext({colorScheme, viewport: {width: 1280, height: 860}});
    try {
      const page = await context.newPage(); await serveViewer(page);
      await page.goto(`${viewer}/s/apps/${workspaceId}/${publicationId}`);
      await page.getByRole("button", {name: "Open app", exact: true}).click();
      await expect(page.getByRole("alert")).toHaveText(words);
      await expect(page.getByRole("button", {name: "Open app", exact: true})).toBeEnabled();
      await page.screenshot({path: testInfo.outputPath(`named-app-collection-missing-${colorScheme}.png`), fullPage: true});
    } finally {await context.close();}
  });

  test(`a reloaded app page says its data is missing, in ${colorScheme}`, async ({browser}, testInfo) => {
    const {url, response} = await reloadAfterCollectionLost();
    const body = await response.text();
    expect(response.status).toBe(410); expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8"); expect(body).toBe(words);
    const context = await browser.newContext({colorScheme, viewport: {width: 1280, height: 860}});
    try {
      const page = await context.newPage();
      await page.route(url, route => route.fulfill({status: response.status, headers: Object.fromEntries(response.headers), body}));
      await page.goto(url);
      await expect(page.locator("body")).toHaveText(words);
      await page.screenshot({path: testInfo.outputPath(`bootstrap-collection-missing-${colorScheme}.png`), fullPage: true});
    } finally {await context.close();}
  });
}
