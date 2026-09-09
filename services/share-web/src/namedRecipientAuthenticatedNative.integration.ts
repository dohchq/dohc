import {createServer as createHttpsServer} from "node:https";
import {chromium, expect as browserExpect, type Browser, type BrowserContext} from "@playwright/test";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {getCookies} from "better-auth/cookies";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import { createEngineClient } from "../../../packages/workspace-engine-client/src/daemon/engineClient.js";
import { serveFetchHandler } from "@dohc/service-http";
import { createWorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import { createSessionActorResolver } from "@dohc/workspace-auth/session";
import { initializeRelayDeployment, openRelayDeployment } from "../../sync-relay/src/relayDeployment.js";
import { startServiceLiveHost } from "../../sync-relay/src/serviceLiveHost.js";
import { createSyncRelayHandler } from "../../sync-relay/src/server.js";
import { createNamedLiveRoutes } from "../../sync-relay/src/namedLiveRoutes.js";
import { createNamedLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createNamedLiveHostReports } from "../../sync-relay/src/namedLiveHostReports.js";
import { createNamedFrameChanges } from "../../sync-relay/src/liveHostChanges.js";
import { createShareWebApplication } from "./server.js";
import { createLiveGateway } from "./liveGateway.js";
import { createNamedLiveRelayRoute, namedLiveGatewayRequest } from "./namedLiveRelayRoute.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Explicit proof inputs, not product limits or release defaults.
const validationPolicy = { maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000 };
const frames = { receive: { maxFrameBytes: 65536, maxStateVectorBytes: 100000, maxUpdateBytes: 1000000, maxSyncBytes: 2000000 },
  maxQueuedBytes: 2000000, maxQueuedFrames: 64, maxControlBytes: 131072, maxControlFrames: 8, maxAssemblyBytes: 2000000 };
const browserLimits = { maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 8192, timeoutMs: 30000 };
const routeLimits = { maxConnections: 4, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 8192, maxPendingBytes: 2000000, maxFragments: 8, maxBufferedChunks: 64,
  upgradeTimeoutMs: 30000, idleTimeoutMs: 60000, drainTimeoutMs: 1000 };
const exchangeKey = "native-network-exchange-".repeat(2), ticketKey = "native-network-tickets-".repeat(2);
// Opt-in integration filename. The pinned serial harness must select this file explicitly.
it("edits through real Chromium invitations, BetterAuth and the native daemon over HTTPS and WSS", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned named network proof binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1 are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(resolve(output), "named-network-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const schema = `share_web_native_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
  let schemaCreated = false;
  const publicHttps = createHttpsServer({key: readFileSync(new URL("./testing/device-control/localhost-key.pem", import.meta.url)),
    cert: readFileSync(new URL("./testing/device-control/localhost-cert.pem", import.meta.url))});
  publicHttps.listen(0, "127.0.0.1"); await once(publicHttps, "listening");
  const audience = `https://127.0.0.1:${(publicHttps.address() as {port: number}).port}`;
  try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  await pool.query(readFileSync(new URL("../../../packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url), "utf8"));
  const authOptions = { pool, baseURL: "https://auth.example.test", secret: "native-auth-proof-secret-at-least-32-characters",
    trustedOrigins: [audience], sendEmail: async () => undefined };
  const auth = createWorkspaceAuth(authOptions), relayAuth = createWorkspaceAuth(authOptions);
  const password = "native-auth-proof-password-123";
  const users: { id: string; name: string; email: string }[] = [];
  for (const name of ["Alice", "Bob"]) {
    users.push((await auth.api.signUpEmail({ body: { email: `${name.toLowerCase()}@example.test`, password, name } })).user);
  }
  const seed = await createEngineClient({ command: executable, authToken: "named-proof-seed", protocolVersion: 2, capabilities: ["core"], connectTimeoutMs: 30000 });
  let mainVersionId: string;
  try {
    const opened = await seed.sendRequest({ id: 1, method: "workspace.open", params: { rootDir: workspace, workspaceId: "workspace", captureMode: "none" }, deadlineMs: 30000 });
    const handle = (opened.result as { workspace: string }).workspace;
    const main = await seed.sendRequest({ id: 2, method: "versions.ensureMain", workspace: handle, params: {}, deadlineMs: 30000 });
    mainVersionId = (main.result as { id: string }).id;
  } finally { seed.close(); await seed.waitForExit(); }
  const configPath = join(root, "deployment.json");
  initializeRelayDeployment({ configPath, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") });
  const deployment = openRelayDeployment(configPath, { liveTickets: { retainedTicketsPerPrincipalGrant: 4, expiredTicketCleanupBatchSize: 2, now: Date.now } });
  const serviceConfig = join(root, "service.json");
  writeFileSync(serviceConfig, JSON.stringify({ version: 1, engineExecutable: executable, hostId: "service", instanceId: "instance",
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 8 }], settlement: { maxApplicationsPerSettlement: 8 },
    sync: { policy: { maxClientVectorBytes: 100000, maxHostVectorBytes: 100000, maxOutputBytes: 1000000, maxReadBytes: 4000000 }, workingReserveBytes: 4000000 },
    ingress: { aggregateBytes: 400000000, applicationWorkingReserveBytes: 1000000, maxUploads: 4, uploadDeadlineMs: 30000 },
    client: { aggregateBytes: 200000000, maxUploads: 4, connectTimeoutMs: 30000, requestDeadlineMs: 30000 } }));
  const ownerDoc = markdownToYDoc("Hello"), sharedChanges = createNamedFrameChanges(16), validate = createLiveMarkdownJournalValidator(validationPolicy);
  let released!: () => void;
  const noListeners = new Promise<void>(resolve => { released = resolve; });
  const frameChanges = { ...sharedChanges, subscribe(changed: () => void) {
    const remove = sharedChanges.subscribe(changed);
    return () => { remove(); if (sharedChanges.listenerCount() === 0) released(); };
  } };
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  const closes: (() => Promise<void>)[] = [], contexts: BrowserContext[] = [], upgrades: Promise<void>[] = [];
  let browser: Browser | undefined;
  const browserErrors: string[] = [];
  const requests: {accountId: string; path: string; status: number}[] = [];
  const results: Record<string, unknown> = {};
  try {
    const authHttp = serveFetchHandler({ handler: request => auth.handler(request), maxBodyBytes: () => 8192,
      oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
    authHttp.listen(0, "127.0.0.1"); await once(authHttp, "listening");
    closes.push(() => new Promise<void>(done => authHttp.close(() => done())));
    const authUrl = `http://127.0.0.1:${(authHttp.address() as { port: number }).port}`;
    const { storage } = deployment;
    expect(storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
    expect(storage.provisionLiveHostControl({ mode: "service", hostId: "service", updatedAtMs: 1, guard: storage.captureStanding() }).ok).toBe(true);
    active = await startServiceLiveHost({ configPath: serviceConfig, ...deployment, frameChanges });
    const baseline = Y.encodeStateAsUpdate(ownerDoc), document = { workspaceId: "workspace", mainVersionId: mainVersionId!, objectId: "object", lineageClaimId: hash(baseline) };
    const registration = createLiveMarkdownRegistrationValidator(validationPolicy)({ document, currentPath: "docs/a.md", checkpoint: baseline });
    if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
    const evidence = registration.evidence, markdown = Buffer.from("Hello");
    expect(hash(markdown)).toBe(evidence.projectedMarkdownSha256);
    storage.putBlob({ workspaceId: "workspace", sha256: hash(markdown), content: markdown, createdAtMs: 2 });
    storage.appendLogBatch({ workspaceId: "workspace", originId: "owner", ops: [{ originSeq: 0, opKind: "moment.append", recordedAtMs: 2,
      payloadJson: JSON.stringify({ objectId: "object", momentId: "baseline", versionId: mainVersionId!, recordedAtMs: 2, operation: "write", path: "docs/a.md",
        payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: evidence.projectedMarkdownSha256, payloadAfterContentKind: "text", payloadAfterByteLength: evidence.projectedMarkdownByteLength }) }] });
    expect(storage.registerLiveDocumentBaseline({ host: active.coordinate, evidence, baselineBytes: baseline, registeredAtMs: 3 }).kind).toBe("registered");
    for (const [index, user] of users.entries()) storage.createShare({
      share: { shareId: `share-${index}`, workspaceId: "workspace", granterUserId: "owner", selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 3 },
      grant: { grantId: `grant-${index}`, shareId: `share-${index}`, principalKind: "user", principalUserId: user.id, principalEmail: null, access: "edit", generation: 1,
        status: "active", createdAtMs: 3, revokedAtMs: null, parentGrantId: null } });
    const relayApp = createSyncRelayHandler({ storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      namedBrowserSessionLimits: { ...browserLimits, maxSessions: 8, retentionMs: 120000 },
      resolveActor: createSessionActorResolver(relayAuth) });
    let routes!: ReturnType<typeof createNamedLiveRoutes>;
    const relayHttp = serveFetchHandler({ handler: request => new URL(request.url).pathname === "/sync/live/named-tickets" ? routes.handle(request) : relayApp(request),
      maxBodyBytes: () => 8192, oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as { port: number }).port}`;
    const captureNative = active.captureNative.bind(active);
    const tickets = createNamedLiveTickets({ storage, audience, key: ticketKey, hostReports: createNamedLiveHostReports({ storage, captureNative }) });
    routes = createNamedLiveRoutes({ storage, hosts: new Set([new URL(relayUrl).host]), publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: { maxClientVectorBytes: 100000, maxSyncOutputBytes: 1000000, maxAppliedUpdateBytes: 1000000, maxSubmissionBytes: 1000000, maxAdmissionBytes: 4000000 },
      validate, sessions: { resolve: relayApp.resolveNamedBrowserSession }, tickets, captureNative });
    closes.push(async () => routes.close());
    relayHttp.on("upgrade", (request, socket, head) => { upgrades.push(routes.handleUpgrade(request, socket, head)); });
    const application = createShareWebApplication({ relayUrl, publicRelayUrl: audience, relayExchangeKey: exchangeKey, publicHosts: new Set([new URL(audience).host]),
      accountAuth: { publicOrigin: audience, upstreamUrl: authUrl }, namedBrowserSessionLimits: browserLimits, namedLiveTickets: true,
      viewerAssetsDir: resolve(new URL("../viewer/dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
      namedRecipientBrowserLimits: {provider: {frames, maxPendingUpdateBytes: 2000000, maxPendingUpdates: 4, maxDeliveryAttempts: 3},
        maxHttpResponseBytes: 8192, maxSocketBufferedBytes: 2000000, connectTimeoutMs: 30000, sendTimeoutMs: 30000, drainPollMs: 10} });
    const gateway = createLiveGateway({ publicOrigin: audience, publicHosts: new Set([new URL(audience).host]),
      limits: { maxConnections: 4, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4, maxFrameBytes: 65536,
        maxPendingBytes: 2000000, maxPendingFrames: 64, maxFragments: 8, maxBufferedChunks: 64, upgradeTimeoutMs: 30000, idleTimeoutMs: 60000, drainTimeoutMs: 1000 },
      resolveNamedSession: async (request, discriminator, signal) => { const authenticated = namedLiveGatewayRequest(request, audience, signal);
        return authenticated ? application.resolveNamedBrowserSession(authenticated, discriminator) : null; },
      openHostRoute: createNamedLiveRelayRoute({ relayUrl, publicOrigin: audience, exchangeKey, handshakeTimeoutMs: 30000 }),
    });
    const publicHttp = serveFetchHandler({ handler: application.handle, maxBodyBytes: () => 8192,
      oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
    publicHttps.on("request", (request, response) => publicHttp.emit("request", request, response));
    publicHttps.on("upgrade", (request, socket, head) => {upgrades.push(gateway.handleUpgrade(request, socket, head));});
    closes.push(async () => gateway.close());
    browser = await chromium.launch({headless: true});
    async function openInvitation(user: typeof users[number], grantId: string) {
      const context = await browser!.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 860}});
      contexts.push(context); await context.tracing.start({screenshots: true, snapshots: true, sources: true});
      const page = await context.newPage();
      page.on("pageerror", error => browserErrors.push(String(error)));
      page.on("response", response => {const url = new URL(response.url());
        if (url.pathname.startsWith("/api/")) requests.push({accountId: user.id, path: url.pathname, status: response.status()});});
      await page.goto(`${audience}/s/edit/${encodeURIComponent(grantId)}`);
      await page.getByLabel("Email", {exact: true}).fill(user.email);
      await page.getByLabel("Password", {exact: true}).fill(password);
      await page.getByRole("button", {name: "Sign in", exact: true}).click();
      await browserExpect(page.getByRole("button", {name: "Sign out", exact: true})).toBeVisible();
      const cookieName = getCookies({baseURL: audience}).sessionToken.name;
      const cookie = (await context.cookies()).find(row => row.name === cookieName);
      expect(cookie).toMatchObject({secure: true, httpOnly: true, sameSite: "Lax", path: "/", domain: "127.0.0.1"});
      const editor = page.getByRole("textbox", {name: "Shared file editor"});
      return {context, page, editor};
    }
    const first = await openInvitation(users[0]!, "grant-0"), peer = await openInvitation(users[1]!, "grant-1");
    for (const recipient of [first, peer]) {
      await recipient.page.getByRole("button", {name: "docs/a.md", exact: true}).click();
      await browserExpect(recipient.editor).toHaveAttribute("contenteditable", "true");
      await browserExpect(recipient.editor).toHaveText("Hello");
    }
    for (const user of users) for (const path of ["/api/account/session", "/api/account/sign-in", "/api/live/named-documents", "/api/live/named-session", "/api/live/named-ticket"]) {
      expect(requests).toContainEqual({accountId: user.id, path, status: 200});
    }
    const wrongGrant = await openInvitation(users[1]!, "grant-0");
    await browserExpect(wrongGrant.page.getByRole("alert")).toBeVisible();
    await browserExpect(wrongGrant.page.getByRole("button", {name: "docs/a.md", exact: true})).toHaveCount(0);
    expect(requests).toContainEqual({accountId: users[1]!.id, path: "/api/live/named-documents", status: 404});
    results.authentication = {accountIds: users.map(user => user.id), requests, wrongGrantRefused: true};
    const actor = {kind: "owner", userId: "owner", shareId: "share-0"} as const;
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor});
    if (current.kind !== "current") throw Error("Current binding unavailable.");
    const capture = await active.captureNative(current.binding);
    results.registrationId = capture.registrationId;
    const nativeRequest = () => ({id: capture.nextRequestId(), workspace: capture.workspace, registrationId: capture.registrationId, deadlineMs: capture.deadlineMs});
    const nativeAck = async () => {
      const cut = storage.readLiveUpdateJournalCut({document});
      if (cut.kind !== "cut") throw Error("Journal cut unavailable.");
      const metadata = cut.cut.suffix.at(-1)?.metadata ?? cut.cut.checkpoint.metadata;
      if (!metadata) throw Error("Accepted browser update missing.");
      const receipt = metadata.accepted.receipt;
      const ack = await capture.client.readLiveApplicationAck(nativeRequest(), {deliveryId: receipt.deliveryId, updateDigest: receipt.updateDigest});
      expect(ack).toMatchObject(receipt); return ack;
    };
    await first.editor.click(); await first.page.keyboard.press("Control+End"); await first.page.keyboard.insertText(" From Alice in Chromium.");
    await browserExpect(first.page.getByRole("status")).toContainText("Changes reached the host");
    await browserExpect(peer.editor).toContainText("From Alice in Chromium.");
    const browserAck = await nativeAck(); results.browserAck = browserAck;
    const firstSettlement = await active.settle(document); expect(firstSettlement.materialized).toBe(true);
    const firstMarkdown = readFileSync(join(workspace, "docs/a.md"), "utf8");
    expect(firstMarkdown).toContain("From Alice in Chromium."); results.firstSettlement = firstSettlement;
    expect((await active.captureNative(current.binding)).registrationId).toBe(capture.registrationId);
    await peer.editor.click(); await peer.page.keyboard.press("Control+End"); await peer.page.keyboard.insertText(" From Bob after settlement.");
    await browserExpect(peer.page.getByRole("status")).toContainText("Changes reached the host");
    await browserExpect(first.editor).toContainText("From Bob after settlement.");
    const afterAck = await nativeAck(); results.afterSettlementAck = afterAck;
    expect(afterAck!.journalCursor).toBeGreaterThan(browserAck!.journalCursor);
    const secondSettlement = await active.settle(document); expect(secondSettlement.materialized).toBe(true);
    const settledMarkdown = readFileSync(join(workspace, "docs/a.md"), "utf8");
    expect(settledMarkdown).toContain("From Alice in Chromium."); expect(settledMarkdown).toContain("From Bob after settlement.");
    results.secondSettlement = secondSettlement; results.settledMarkdown = settledMarkdown;
    await first.page.screenshot({path: join(root, "alice-edited.png"), fullPage: true});
    await peer.page.screenshot({path: join(root, "bob-edited.png"), fullPage: true});
    for (const index of [0, 1]) expect(storage.revokeShareGrant({shareId: `share-${index}`, grantId: `grant-${index}`,
      revokedAtMs: Date.now(), expectedDependentGrantIds: [], guard: storage.captureStanding()}).ok).toBe(true);
    await noListeners;
    for (const recipient of [first, peer]) await browserExpect(recipient.editor).toHaveAttribute("contenteditable", "false");
    expect(frameChanges.listenerCount()).toBe(0); expect(capture.invalidated.aborted).toBe(false); results.grantRetired = true;
    await first.page.getByRole("button", {name: "Refresh files", exact: true}).click();
    await browserExpect(first.page.getByRole("alert")).toContainText("could not open this invitation");
    await browserExpect(first.page.getByRole("button", {name: "docs/a.md", exact: true})).toHaveCount(0);
    await first.page.screenshot({path: join(root, "revoked.png"), fullPage: true});
    expect(browserErrors).toEqual([]);
    await active.close(); active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), { readOnly: true });
    try {
      const applications = engine.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(applications).toHaveLength(2);
      expect(applications[0]).toEqual({ delivery_id: browserAck!.deliveryId, update_digest: browserAck!.updateDigest });
      expect(applications[1]).toEqual({ delivery_id: afterAck!.deliveryId, update_digest: afterAck!.updateDigest });
      results.persistedApplications = applications;
    } finally { engine.close(); }
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({ verdict: "PASS", executable, sha256: expectedHash,
      scope: "Real Chromium invitation UI over HTTPS/WSS, BetterAuth/Postgres sign-in, integrated selected-grant navigation, native daemon ACKs and persisted applications, two named principals, peer updates, settlement and revocation. Test TLS certificate trusted only by isolated browser contexts.", results }, null, 2));
  } finally {
    for (const [index, context] of contexts.entries()) {
      try {await context.tracing.stop({path: join(root, `browser-${index}.zip`)});} finally {await context.close();}
    }
    await browser?.close();
    for (const close of closes.reverse()) await close();
    await Promise.allSettled(upgrades);
    await active?.close(); deployment.storage.close(); ownerDoc.destroy();
  }
  } finally {
    await new Promise<void>(done => publicHttps.close(() => done()));
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 120000);
