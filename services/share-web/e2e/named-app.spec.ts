import { test, expect, chromium } from "@playwright/test";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCookies } from "better-auth/cookies";
import { createShareWebApplication } from "../src/server";

// Real viewer, auth proxy, HTTPS handoff, sandbox, and backend transport; auth and relay responses are fixtures.
test("signed-in organizer opens an isolated app and loses backend access when revoked", async ({}, testInfo) => {
  const viewer = "https://viewer.example.com", workspaceId = "workspace-1", publicationId = "a".repeat(64);
  const account = getCookies({ baseURL: viewer }), sessionCookie = `${account.sessionToken.name}=fixture-account-secret`;
  const exchangeKey = "fixture-exchange-key".padEnd(32, "x");
  let signedIn = false, active = true;
  const failures: string[] = [], invocations: unknown[] = [], backendRequests: Array<{ origin: string | null; status: number }> = [];
  const bytes = Buffer.from(`
const root=document.getElementById('root');root.innerHTML='<button id="save">Update registration</button><button id="read">Read registrations</button><p id="result" role="status">Ready</p><a id="recovery" download="recovery.json">Download recovery file</a>';
document.getElementById('recovery').href=URL.createObjectURL(new Blob(['{"idempotencyKey":"attempt-1"}'],{type:'application/json'}));
addEventListener('message',event=>{if(event.data?.kind!=='dohc-app-channel')return;const port=event.ports[0];port.onmessage=event=>{document.getElementById('result').textContent=event.data.ok?(event.data.id==='read'?'Loaded':'Saved'):'Access ended';};port.start();document.getElementById('save').onclick=()=>port.postMessage({id:'save',op:'backend.invoke',operation:'registrations.update',idempotencyKey:'attempt-1',input:{status:'approved'}});document.getElementById('read').onclick=()=>port.postMessage({id:'read',op:'backend.invoke',operation:'registrations.list',idempotencyKey:'read-1',input:{}});},{once:true});
`);
  const file = { path: "bundle.js", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, contentType: "text/javascript; charset=utf-8" };
  const application = createShareWebApplication({
    publicHosts: new Set(["viewer.example.com"]), relayUrl: "https://relay.example.org", publicRelayUrl: "https://relay.example.org", relayExchangeKey: exchangeKey,
    appLaunch: { viewerOrigin: viewer, appDomain: "example.net" }, viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
    accountAuth: { publicOrigin: viewer, upstreamUrl: "https://auth.example.org" },
    fetchAuth: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session") return Response.json(signedIn && request.headers.get("cookie") === sessionCookie ? { user: { id: "helper", name: "Alex" }, session: { userId: "helper" } } : null);
      if (path === "/api/auth/sign-in/email") {
        const body = await request.json();
        if (body.email !== "alex@example.test" || body.password !== "fixture-password") return new Response(null, { status: 401 });
        signedIn = true;
        return Response.json({ redirect: false, user: { id: "helper", name: "Alex" } }, { headers: { "set-cookie": sessionCookie + "; Secure; HttpOnly; SameSite=Lax; Path=/" } });
      }
      return new Response(null, { status: 404 });
    },
    fetchRelay: async request => {
      expect(request.headers.get("cookie")).toBe(sessionCookie);
      expect(request.headers.get("origin")).toBe(viewer);
      expect(request.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
      expect(request.headers.has("authorization")).toBe(false);
      if (!active) return new Response(null, { status: 403 });
      const prefix = `/sync/${workspaceId}/app-publications/${publicationId}/backend`, path = new URL(request.url).pathname;
      if (path === prefix + "/descriptor") return Response.json({ publicationId, authorityRevision: 1, files: [file] });
      if (path === prefix + "/blobs/" + file.sha256) return new Response(bytes, { headers: { "content-type": file.contentType } });
      if (path === prefix + "/invoke") { invocations.push(await request.json()); return Response.json({ result: { saved: true }, revision: 1, replayed: false }); }
      return new Response(null, { status: 404 });
    },
  });
  const certificateScript = `$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=dohc-named-app-test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('viewer.example.com');$san.AddDnsName('*.example.net')
$req.CertificateExtensions.Add($san.Build())
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[Convert]::ToBase64String($cert.RawData)
$cert.Dispose();$rsa.Dispose()`;
  const [pfxText, certText] = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", certificateScript], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
  const cert = new X509Certificate(Buffer.from(certText!, "base64"));
  const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const server = https.createServer({ pfx: Buffer.from(pfxText!, "base64"), passphrase: "" }, async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const result = await application.handle(new Request(`https://${request.headers.host}${request.url}`, { method: request.method, headers, ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }));
      if (request.url === "/backend") backendRequests.push({ origin: headers.get("origin"), status: result.status });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { failures.push(String(error)); response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No listener");
  const browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`, `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`, "--no-proxy-server"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" }), page = await context.newPage();
    page.on("pageerror", error => failures.push(String(error)));
    await page.goto(`${viewer}/s/apps/${workspaceId}/${publicationId}`);
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("named-app-signin-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: testInfo.outputPath("named-app-signin-mobile-dark.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Email", { exact: true }).fill("alex@example.test");
    await page.getByLabel("Password", { exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill("alex@example.test");
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open app", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open app", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const child = page.frameLocator("iframe");
    await child.getByRole("button", { name: "Update registration" }).click();
    await expect(child.getByRole("status")).toHaveText("Saved");
    expect(invocations).toEqual([{ authorityRevision: 1, operation: "registrations.update", idempotencyKey: "attempt-1", input: { status: "approved" } }]);
    await child.getByRole("button", { name: "Read registrations" }).click();
    await expect(child.getByRole("status")).toHaveText("Loaded");
    expect(invocations.at(-1)).toMatchObject({ operation: "registrations.list", input: {} });
    const download = page.waitForEvent("download"); await child.getByRole("link", { name: "Download recovery file" }).click();
    expect((await download).suggestedFilename()).toBe("recovery.json");
    const frame = page.frames().find(item => item.url() === "about:srcdoc")!;
    const access = await frame.evaluate(() => {
      const blocked: Record<string, boolean> = {};
      for (const [name, read] of Object.entries({ parent: () => parent.document, cookies: () => document.cookie, storage: () => localStorage.length })) {
        try { read(); blocked[name] = false; } catch { blocked[name] = true; }
      }
      return blocked;
    });
    expect(access).toEqual({ parent: true, cookies: true, storage: true });
    await frame.evaluate(async origin => { try { await fetch(origin + "/backend", { method: "POST", credentials: "include", body: "{}" }); } catch {} }, new URL(page.url()).origin);
    await expect.poll(() => backendRequests.some(request => request.origin === "null" && request.status === 404)).toBe(true);
    const noCookie = await page.evaluate(async () => (await fetch("/backend", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: "{}" })).status);
    expect(noCookie).toBe(404);
    expect(await page.content()).not.toContain("fixture-account-secret");
    active = false;
    await child.getByRole("button", { name: "Update registration" }).click();
    await expect(child.getByRole("status")).toHaveText("Access ended");
    expect(invocations).toHaveLength(2); expect(failures).toEqual([]);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
