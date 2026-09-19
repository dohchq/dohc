import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request as requestHttp } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import {
  ACCOUNT_TEST_SECRET,
  startAccountServer,
} from "../../../../services/workspace-api/e2e/harness";
import { mailLinks } from "../../../../services/workspace-api/e2e/smtpCapture";
import type { LaunchedDesktopApp } from "./desktopApp";

export async function startSelfHostOnboardingStack(directory: string) {
  assert.ok(process.env.POSTGRES_URL, "Supply a disposable POSTGRES_URL.");
  assert.equal(process.env.DOHC_REQUIRE_POSTGRES, "1", "Require the real Postgres dependency.");
  const proxy = await startServerProxy();
  let relay: Awaited<ReturnType<typeof startAuthenticatedRelay>> | undefined;
  try {
    relay = await startAuthenticatedRelay(directory, proxy.origin);
    proxy.routeRelayTo(relay.url);
    const account = await startAccountServer({ publicOrigin: proxy.origin });
    proxy.routeAuthTo(account.listenOrigin);
    return {
      account,
      relayUrl: proxy.origin,
      async close() {
        const results = await Promise.allSettled([proxy.close(), relay!.close(), account.close()]);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Self-host services did not close.");
      },
    };
  } catch (error) {
    await Promise.allSettled([proxy.close(), relay?.close()]);
    throw error;
  }
}

// The same public origin routes to separate services, like the self-host proxy.
// Bodies, headers, and status codes pass through unchanged; no route mints credentials.
async function startServerProxy() {
  let authInternalUrl: string | undefined;
  let relayUrl: string | undefined;
  const upstreams = new Set<ReturnType<typeof requestHttp>>();
  const server = createHttpServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    const target = path.startsWith("/sync/") || path === "/health" ? relayUrl : authInternalUrl;
    if (!target) { outgoing.writeHead(503).end(); return; }
    const upstream = requestHttp(new URL(path, target), { method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstreams.add(upstream);
    upstream.once("close", () => upstreams.delete(upstream));
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.once("close", () => upstream.destroy());
    incoming.on("error", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    routeAuthTo(url: string) { authInternalUrl = url; },
    routeRelayTo(url: string) { relayUrl = url; },
    async close() {
      for (const request of upstreams) request.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function startAuthenticatedRelay(directory: string, authUrl: string) {
  const relayRoot = fileURLToPath(new URL("../../../../services/sync-relay/", import.meta.url));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    SYNC_RELAY_TEST_AUTH: undefined,
    DOHC_TEST_AUTH: undefined,
    DOHC_RELAY_DEPLOYMENT_CONFIG: undefined,
    DOHC_RELAY_SERVICE_HOST_CONFIG: undefined,
    DOHC_RELAY_DEVICE_DELIVERY_CONFIG: undefined,
    DOHC_RELAY_OWNER_ADMISSION_CONFIG: undefined,
    DOHC_RELAY_NAMED_LIVE_CONFIG: undefined,
    DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS: undefined,
    DOHC_RELAY_LINK_LIVE: undefined,
    DOHC_PUBLIC_EDIT_RELEASE: undefined,
    DOHC_RELAY_APP_PUBLICATIONS: undefined,
    DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT: undefined,
    SYNC_RELAY_PORT: "0",
    SYNC_RELAY_BIND: "127.0.0.1",
    SYNC_RELAY_DB_PATH: join(directory, "onboarding-relay.sqlite"),
    SYNC_RELAY_AUTH_BASE_URL: authUrl,
    BETTER_AUTH_SECRET: ACCOUNT_TEST_SECRET,
    FORCE_COLOR: "0",
  };
  // This assertion runs inside the service process, before its production entry.
  const bootstrap = 'import { strict as assert } from "node:assert"; assert.equal(process.env.SYNC_RELAY_TEST_AUTH, undefined); assert.equal(process.env.DOHC_TEST_AUTH, undefined); await import("./src/main.ts");';
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", bootstrap], {
    cwd: relayRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-16_384); });
  child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-16_384); });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = () => stopChild(child, exited);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Authenticated relay did not start. ${output}`)), 30_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`Authenticated relay exited (${code}). ${output}`)));
      child.stdout.on("data", () => {
        const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(output);
        if (!match) return;
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      });
    });
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function stopChild(child: ChildProcess, exited: Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    child.kill("SIGTERM");
    await exited;
  } finally { clearTimeout(force); }
}

// The OS browser dispatcher is the only substituted boundary. Desktop discovery,
// IPC validation, device-code polling, browser approval, and credential storage run normally.
export async function openDesktopApproval(desktop: LaunchedDesktopApp, browserPage: Page, origin: string) {
  await desktop.app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { onboardingBrowserUrl?: string; onboardingOpenExternal?: typeof shell.openExternal };
    state.onboardingBrowserUrl = undefined;
    state.onboardingOpenExternal = shell.openExternal;
    shell.openExternal = async (url) => { state.onboardingBrowserUrl = url; };
  });
  try {
    await desktop.page.getByTestId("cloud-server-url").fill(origin);
    await desktop.page.getByTestId("cloud-connect-start").click();
    await expect(desktop.page.getByTestId("cloud-user-code")).toBeVisible();
    await desktop.page.getByTestId("cloud-open-browser").click();
    // Opening the approval URL uses the same external-link confirmation as a
    // person sees. Accept it before observing the test OS-open seam.
    const openLink = desktop.page.getByRole("button", { name: "Open link", exact: true });
    const captured = () => desktop.app.evaluate(() => (globalThis as typeof globalThis & { onboardingBrowserUrl?: string }).onboardingBrowserUrl);
    await expect.poll(async () => await openLink.isVisible() || Boolean(await captured())).toBe(true);
    if (await openLink.isVisible()) await openLink.click();
    await expect.poll(captured).toBeTruthy();
    const url = (await captured())!;
    expect(new URL(url).origin).toBe(origin);
    await browserPage.goto(url);
    return url;
  } finally {
    await desktop.app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { onboardingBrowserUrl?: string; onboardingOpenExternal?: typeof shell.openExternal };
      shell.openExternal = state.onboardingOpenExternal!;
      delete state.onboardingOpenExternal;
      delete state.onboardingBrowserUrl;
    });
  }
}

export async function createVerifiedAccount(page: Page, server: Awaited<ReturnType<typeof startAccountServer>>, account: { email: string; password: string }, approvalUrl: string) {
  const before = server.mail.messages.length;
  await page.getByRole("link", { name: /create (an )?account|sign up/i }).click();
  await page.getByLabel(/^name$/i).fill("Self-host desktop proof");
  await page.getByLabel(/^email$/i).fill(account.email);
  await page.getByLabel(/^password$/i).fill(account.password);
  await page.getByRole("button", { name: /create account|sign up/i }).click();
  await expect.poll(() => server.mail.messages.length).toBeGreaterThan(before);
  const verification = mailLinks(server.mail.messages[before]!).find(link => link.includes("verify-email"));
  expect(verification).toBeTruthy();
  await page.goto(verification!);
  await page.getByRole("link", { name: "Continue connecting your device" }).click();
  await expect(page).toHaveURL(approvalUrl);
}

export async function approveDesktop(page: Page, account: { email: string; password: string }) {
  const password = page.getByLabel(/^password$/i);
  const approve = page.getByRole("button", { name: /^approve|allow/i });
  await expect(password.or(approve).first()).toBeVisible();
  if (await password.isVisible()) {
    await page.getByLabel(/^email$/i).fill(account.email);
    await password.fill(account.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
  }
  await approve.click();
  await expect(page.getByText(/approved|connected|return to dohc/i).first()).toBeVisible();
}
