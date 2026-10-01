import { strict as assert } from "node:assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createServer as createHttpServer, request as requestHttp, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import {
  ACCOUNT_TEST_SECRET,
  startAccountServer,
} from "../../../../services/workspace-api/e2e/harness";
import { mailLinks } from "../../../../services/workspace-api/e2e/smtpCapture";
import { mintLocalhostCa, type LocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { resolveEngineBinary } from "../../src/testing/engineBinary";
import type { LaunchedDesktopApp } from "./desktopApp";

const relayRoot = fileURLToPath(new URL("../../../../services/sync-relay/", import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * `live` serves the stack over HTTPS from a fixture CA and runs the self-host
 * live service with the native engine. `trustEnv` is the environment a desktop
 * needs to trust that CA: Node reads it, and the debug engine accepts it only
 * for an HTTPS loopback relay.
 */
export async function startSelfHostOnboardingStack(directory: string, options: { live?: boolean } = {}) {
  assert.ok(process.env.POSTGRES_URL, "Supply a disposable POSTGRES_URL.");
  assert.equal(process.env.DOHC_REQUIRE_POSTGRES, "1", "Require the real Postgres dependency.");
  const ca = options.live ? await mintLocalhostCa(directory) : undefined;
  // Desktop launches enable the plaintext loopback opt-in by default. A live
  // desktop turns it off, so only the test CA carries its relay traffic; the
  // engine refuses the two together.
  const trustEnv: Record<string, string> = ca
    ? { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1", DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" }
    : {};
  const proxy = await startServerProxy(ca);
  let relay: Awaited<ReturnType<typeof startAuthenticatedRelay>> | undefined;
  try {
    relay = await startAuthenticatedRelay(directory, proxy.origin, ca ? { ...trustEnv, ...selfHostLiveEnv(directory, proxy.origin) } : {});
    proxy.routeRelayTo(relay.url);
    const account = await startAccountServer({ publicOrigin: proxy.origin });
    proxy.routeAuthTo(account.listenOrigin);
    return {
      account,
      ca,
      trustEnv,
      relayUrl: proxy.origin,
      // The relay's recent console output, such as a failed service host pass,
      // for a failure report. Bearer values are removed.
      relayOutput: () => relay!.output().replace(/(bearer\s+)\S+/giu, "$1[redacted]"),
      // Counts and cursors only, for a failure report: the live settlements the
      // service host made, held for export, or journaled, and those the relay holds.
      settlementEvidence: () => settlementEvidence(directory),
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
// With a certificate it terminates TLS, and it forwards live editing's WebSocket upgrades.
async function startServerProxy(tls?: Pick<LocalhostCa, "certificate" | "key">) {
  let authInternalUrl: string | undefined;
  let relayUrl: string | undefined;
  const upstreams = new Set<ReturnType<typeof requestHttp>>();
  const upgraded = new Set<Duplex>();
  const route = (path: string) => path.startsWith("/sync/") || path === "/health" ? relayUrl : authInternalUrl;
  const handle: RequestListener = (incoming, outgoing) => {
    const path = incoming.url ?? "/";
    const target = route(path);
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
  };
  const server: Server = tls ? createHttpsServer({ cert: tls.certificate, key: tls.key }, handle) : createHttpServer(handle);
  server.on("upgrade", (incoming, socket, head) => {
    const target = route(incoming.url ?? "/");
    if (!target) { socket.destroy(); return; }
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    const upstream = requestHttp(new URL(incoming.url ?? "/", target), { method: incoming.method, headers: incoming.headers });
    const answer = (response: IncomingMessage) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      return `${lines.join("\r\n")}\r\n\r\n`;
    };
    upstream.once("upgrade", (response, relaySocket, relayHead) => {
      upgraded.add(relaySocket);
      relaySocket.once("close", () => { upgraded.delete(relaySocket); socket.destroy(); });
      socket.once("close", () => relaySocket.destroy());
      relaySocket.on("error", () => relaySocket.destroy());
      socket.write(answer(response));
      socket.write(relayHead);
      relaySocket.write(head);
      relaySocket.pipe(socket).pipe(relaySocket);
    });
    // A refused upgrade keeps the relay's status and body.
    upstream.once("response", (response) => { socket.write(answer(response)); response.pipe(socket); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`,
    routeAuthTo(url: string) { authInternalUrl = url; },
    routeRelayTo(url: string) { relayUrl = url; },
    async close() {
      for (const request of upstreams) request.destroy();
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function settlementEvidence(directory: string) {
  const read = <T>(path: string, query: (db: InstanceType<typeof DatabaseSync>) => T) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return query(db); } finally { db.close(); }
  };
  const cursors = (db: InstanceType<typeof DatabaseSync>, sql: string) => db.prepare(sql).all().map((row) => Number(row.cursor));
  const hostRoot = join(directory, "relay-deployment", "live-host");
  return {
    host: readdirSync(hostRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "automations")
      .map((entry) => read(join(hostRoot, entry.name, ".dohc", "engine", "engine.db"), (db) => ({
        settled: cursors(db, "SELECT terminal_cursor AS cursor FROM live_device_settlements ORDER BY terminal_cursor"),
        heldForExport: Number(db.prepare("SELECT COUNT(*) AS n FROM live_audit_pending_exports").get()?.n ?? 0),
        journaled: cursors(db, `SELECT json_extract(payload_json,'$.record.terminalCursor') AS cursor FROM replication_log
          WHERE imported=0 AND op_kind='live.audit.settlement' ORDER BY cursor`),
        acceptedEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM live_accepted_updates").get()?.n ?? 0),
      }))),
    relay: read(join(directory, "relay-data", "relay.sqlite"), (db) => db.prepare(
      `SELECT json_extract(s.payload_json,'$.record.terminalCursor') AS cursor,
         EXISTS(SELECT 1 FROM sync_relay_log m WHERE m.workspace_id=s.workspace_id AND m.op_kind='moment.append'
           AND json_extract(m.payload_json,'$.momentId')=json_extract(s.payload_json,'$.record.momentId')) AS moment
       FROM sync_relay_log s WHERE s.op_kind='live.audit.settlement' ORDER BY s.relay_seq`,
    ).all().map((row) => ({ terminalCursor: Number(row.cursor), momentPublished: Number(row.moment) === 1 }))),
  };
}

// The supported self-host profile: an initialized deployment whose service
// host runs the native engine and replicates through the public HTTPS origin.
function selfHostLiveEnv(directory: string, origin: string): NodeJS.ProcessEnv {
  const deployment = join(directory, "relay-deployment");
  execFileSync(process.execPath, ["--import", "tsx/esm", "src/relayDeploymentCommand.ts", "initialize",
    "--config", join(deployment, "deployment.json"), "--database", join(directory, "relay-data", "relay.sqlite"), "--continuity-directory", join(deployment, "continuity")],
  { cwd: relayRoot, stdio: "pipe", windowsHide: true });
  mkdirSync(join(deployment, "live-host"));
  return {
    SYNC_RELAY_DB_PATH: undefined,
    DOHC_RELAY_DEPLOYMENT_CONFIG: join(deployment, "deployment.json"),
    DOHC_SELF_HOST_LIVE: "1",
    DOHC_RELAY_AUTOMATIONS: "0",
    // The live host requires canonical paths.
    DOHC_RELAY_SERVICE_HOST_ROOT: realpathSync.native(join(deployment, "live-host")),
    DOHC_RELAY_ENGINE_EXECUTABLE: realpathSync.native(resolveEngineBinary()),
    DOHC_RELAY_PUBLIC_ORIGIN: origin,
    DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
    DOHC_RELAY_NAMED_LIVE_HOSTS: new URL(origin).host,
    DOHC_RELAY_LINK_KEY: randomBytes(32).toString("hex"),
    DOHC_RELAY_EXCHANGE_KEY: randomBytes(32).toString("hex"),
  };
}

async function startAuthenticatedRelay(directory: string, authUrl: string, liveEnv: NodeJS.ProcessEnv) {
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
    ...liveEnv,
  };
  // This assertion runs inside the service process, before its production entry.
  // IPC requests orderly shutdown on Windows too, where SIGTERM would skip closing the live host's engine.
  const bootstrap = 'import { strict as assert } from "node:assert"; assert.equal(process.env.SYNC_RELAY_TEST_AUTH, undefined); assert.equal(process.env.DOHC_TEST_AUTH, undefined); process.on("message", (message) => { if (message === "SIGTERM") process.emit("SIGTERM"); }); await import("./src/main.ts");';
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", bootstrap], {
    cwd: relayRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const { stdout, stderr } = child;
  assert.ok(stdout && stderr, "The relay's output pipes are configured.");
  // Enough to keep a service host failure that is logged once behind later engine output.
  let output = "";
  stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-262_144); });
  stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-262_144); });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = () => stopChild(child, exited);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Authenticated relay did not start. ${output}`)), 30_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`Authenticated relay exited (${code}). ${output}`)));
      stdout.on("data", () => {
        const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(output);
        if (!match) return;
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      });
    });
    return { url, close, output: () => output };
  } catch (error) {
    await close();
    throw error;
  }
}

async function stopChild(child: ChildProcess, exited: Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Allow the relay's HTTP drain and live host close, then bound a wedged child.
  const force = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    if (child.connected) child.send("SIGTERM", (error) => { if (error) child.kill("SIGTERM"); });
    else child.kill("SIGTERM");
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

/** Signs up from a desktop's approval page, or on its own when no approval is waiting. */
export async function createVerifiedAccount(page: Page, server: Awaited<ReturnType<typeof startAccountServer>>, account: { email: string; password: string; name?: string }, approvalUrl?: string) {
  const before = server.mail.messages.length;
  if (approvalUrl) await page.getByRole("link", { name: /create (an )?account|sign up/i }).click();
  else await page.goto(`${server.origin}/account/sign-up`);
  await page.getByLabel(/^name$/i).fill(account.name ?? "Self-host desktop proof");
  await page.getByLabel(/^email$/i).fill(account.email);
  await page.getByLabel(/^password$/i).fill(account.password);
  await page.getByRole("button", { name: /create account|sign up/i }).click();
  await expect(page).toHaveURL(/\/account\/verify-email\?next=/);
  await expect.poll(() => server.mail.messages.length).toBeGreaterThan(before);
  const verification = mailLinks(server.mail.messages[before]!).find(link => link.includes("verify-email"));
  expect(verification).toBeTruthy();
  await page.goto(verification!);
  if (!approvalUrl) {
    await expect(page.getByRole("link", { name: "Go to your account" })).toBeVisible();
    return;
  }
  await page.getByRole("link", { name: "Continue connecting your device" }).click();
  await expect(page).toHaveURL(approvalUrl);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);

/**
 * Approval browsers stand in for each person's own browser. This test process
 * adds the fixture CA to its trusted roots and makes their requests to the
 * stack, verifying the certificate chain and address; Chromium never skips a
 * certificate check. `restore` puts this process's roots back.
 *
 * The fixture boundary: Chromium follows a fulfilled redirect itself, outside
 * the route, and would then meet the fixture CA it does not trust. So a GET
 * navigation the server redirects within its origin is answered with the
 * server's own headers and cookies and a page that navigates at once to the
 * same destination, which comes back through this route. Every other response
 * is the server's own, and any other redirect is refused.
 */
export function trustFixtureCa(ca: string) {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, ca]);
  return {
    route: (context: BrowserContext, origin: string) => context.route(`${origin}/**`, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      if (!REDIRECTS.has(response.status())) return route.fulfill({ response });
      const request = route.request();
      const location = response.headers()["location"];
      const target = location === undefined ? undefined : new URL(location, request.url());
      if (!target || target.origin !== origin || request.method() !== "GET" || !request.isNavigationRequest()) {
        return route.abort("blockedbyclient");
      }
      const headers: Record<string, string> = { ...response.headers(), "content-type": "text/html; charset=utf-8" };
      for (const name of ["location", "content-length", "content-encoding", "transfer-encoding"]) delete headers[name];
      return route.fulfill({ status: 200, headers,
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeHtml(target.href)}">` });
    }),
    restore: () => setDefaultCACertificates(previous),
  };
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
