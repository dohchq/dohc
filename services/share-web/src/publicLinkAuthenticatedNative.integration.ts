import {OwnerRestoreActionResponse} from "../../../apps/desktop/src/ipc/ownerRestoreContract.js";
import {createServer as createHttpsServer} from "node:https";
import {chromium, expect as browserExpect, type Browser, type BrowserContext} from "@playwright/test";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {fileURLToPath} from "node:url";
import { DatabaseSync } from "node:sqlite";
import {LIVE_TICKET_TABLE} from "../../sync-relay/src/storage/schema.js";
import {createLinkLiveBrowserResolver} from "../../sync-relay/src/linkLiveBrowserAuth.js";
import {createLinkLiveHttp} from "../../sync-relay/src/linkLiveHttp.js";
import {createPublicLinkWireProof} from "./publicLinkWireProof.integration-helper.js";
import {readPublicWorkload} from "./publicLinkWorkload.integration-helper.js";
import {readPublicTransitionWorkload} from "./publicTransitionWorkload.integration-helper.js";
import {runPublicTransitions, type PublicTransitionHarness} from "./publicTransitionRuntime.integration-helper.js";
import {runPublicAutomaticView, type AutomaticViewAdmission} from "./publicAutomaticView.integration-helper.js";
import {runPublicMixedPresence} from "./publicMixedPresence.integration-helper.js";
import {createLiveMembershipRegistry} from "../../sync-relay/src/liveMembership.js";
import {createLiveConnectionAdmission} from "../../sync-relay/src/liveConnectionAdmission.js";
import {createNamedLiveRelayRoute, namedLiveGatewayRequest} from "./namedLiveRelayRoute.js";
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
import { createLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLiveHostReports } from "../../sync-relay/src/namedLiveHostReports.js";
import { createNamedFrameChanges } from "../../sync-relay/src/liveHostChanges.js";
import { createShareWebApplication } from "./server.js";
import { createLiveGateway } from "./liveGateway.js";


const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Every admission bound comes from the coordinator's hashed release decision.
interface PublicProofAdmission {
  publicEditGateGranted: true;
  admittedConcurrency: number;
  workload: {path: string; sha256: string};
  transitions: {path: string; sha256: string};
  automaticView: AutomaticViewAdmission;
  namedSessions: NonNullable<Parameters<typeof createSyncRelayHandler>[0]["namedBrowserSessionLimits"]>;
  frames: Parameters<typeof createNamedLiveRoutes>[0]["frames"];
  route: Parameters<typeof createNamedLiveRoutes>[0]["limits"];
  bounds: Parameters<typeof createNamedLiveRoutes>[0]["bounds"];
  gateway: Parameters<typeof createLiveGateway>[0]["limits"];
  requests: NonNullable<Parameters<typeof createShareWebApplication>[0]["linkLive"]>["requests"];
  editor: NonNullable<Parameters<typeof createShareWebApplication>[0]["linkLive"]>["editor"];
  validation: Parameters<typeof createLiveMarkdownJournalValidator>[0];
  liveTickets: {retainedTicketsPerPrincipalGrant: number; expiredTicketCleanupBatchSize: number};
  maxRegistrations: number;
  maxChangeListeners: number;
  ordinaryMaxRequestBytes: number;
  native: {settlement: unknown; restore: unknown; sync: unknown; ingress: unknown; client: unknown};
}
const admissionPath = process.env.DOHC_PUBLIC_PROOF_ADMISSION;
const admissionDigest = process.env.DOHC_PUBLIC_PROOF_ADMISSION_SHA256;
if (!admissionPath || !admissionDigest) throw new Error("A hashed public release admission is required.");
const admissionBytes = readFileSync(admissionPath);
if (hash(admissionBytes) !== admissionDigest) throw new Error("Public release admission changed.");
const capacity = JSON.parse(admissionBytes.toString()) as PublicProofAdmission;
if (capacity.publicEditGateGranted !== true || !Number.isSafeInteger(capacity.admittedConcurrency) || capacity.admittedConcurrency < 2) {
  throw new Error("Public Edit release decision and at least two admitted sessions are required.");
}
if (!Number.isSafeInteger(capacity.ordinaryMaxRequestBytes) || capacity.ordinaryMaxRequestBytes < 1) throw new Error("Explicit ordinary HTTP request bound required.");
const publicEditRelease = {version: 1} as const;
const frames = capacity.frames, routeLimits = capacity.route, validationPolicy = capacity.validation;
const workload = readPublicWorkload(capacity.workload, capacity.admittedConcurrency);
const transitions = readPublicTransitionWorkload(capacity.transitions, capacity.admittedConcurrency);
const exchangeKey = "public-native-exchange-".repeat(2), ticketKey = "public-native-tickets-".repeat(2), linkKey = "public-native-links-".repeat(2);
// Opt-in integration filename. The pinned serial harness must select this file explicitly.
it("exercises public Edit through owner creation, exchange and native application at admitted concurrency", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned named network proof binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1 are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(resolve(output), "public-network-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const schema = `public_web_native_${randomUUID().replaceAll("-", "")}`;
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
  const ownerUser = (await auth.api.signUpEmail({body: {email: "owner@example.test", password, name: "Owner"}})).user;
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
  const deployment = openRelayDeployment(configPath, { liveTickets: {...capacity.liveTickets, now: Date.now} });
  const serviceConfig = join(root, "service.json");
  writeFileSync(serviceConfig, JSON.stringify({version: 1, ...capacity.native, engineExecutable: executable,
    hostId: "service", instanceId: "instance", workspaces: [{root: workspace, workspaceId: "workspace", maxRegistrations: capacity.maxRegistrations}]}));
  const ownerDoc = markdownToYDoc("Hello"), sharedChanges = createNamedFrameChanges(capacity.maxChangeListeners), validate = createLiveMarkdownJournalValidator(validationPolicy);
  let captureCount = 0;
  const frameChanges = { ...sharedChanges, subscribe(...args: Parameters<typeof sharedChanges.subscribe>) {
    const remove = sharedChanges.subscribe(...args);
    // Each capture has one standing listener plus temporary document wake listeners.
    const standing = args[1] === undefined;
    if (standing) captureCount++;
    let removed = false;
    return () => {
      if (removed) return; removed = true;
      remove(); if (standing) captureCount--;
    };
  }, captureCount: () => captureCount };
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  const closes: (() => Promise<void>)[] = [], contexts: BrowserContext[] = [], upgrades: Promise<void>[] = [];
  let browser: Browser | undefined;
  const browserErrors: string[] = [];
  const requests: {context: number; path: string; status: number}[] = [];
  const results: Record<string, unknown> = {};
  let proofPassed = false;
  const protectedSecrets = new Set<string>(), publicBodies: Promise<{body: string} | {error: unknown}>[] = [];
  try {
    const authHttp = serveFetchHandler({ handler: request => auth.handler(request), maxBodyBytes: () => 8192,
      oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
    authHttp.listen(0, "127.0.0.1"); await once(authHttp, "listening");
    closes.push(() => new Promise<void>(done => authHttp.close(() => done())));
    const authUrl = `http://127.0.0.1:${(authHttp.address() as { port: number }).port}`;
    const { storage } = deployment;
    expect(storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: ownerUser.id, createdAtMs: 1 })).toBe("created");
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
        metadata: {origin: "sync"}, beforePresent: "absent",
        payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: evidence.projectedMarkdownSha256, payloadAfterContentKind: "text", payloadAfterByteLength: evidence.projectedMarkdownByteLength }) }] });
    expect(storage.registerLiveDocumentBaseline({ host: active.coordinate, evidence, baselineBytes: baseline, registeredAtMs: 3 }).kind).toBe("registered");
    const outsideDocument = {...document, objectId: "outside-object"};
    const outsideRegistration = createLiveMarkdownRegistrationValidator(validationPolicy)({document: outsideDocument, currentPath: "docs/other.md", checkpoint: baseline});
    if (outsideRegistration.kind !== "accepted") throw new Error("Outside-selector control registration rejected.");
    storage.appendLogBatch({workspaceId: "workspace", originId: "outside-fixture", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 2,
      payloadJson: JSON.stringify({objectId: "outside-object", momentId: "outside-baseline", versionId: mainVersionId!, recordedAtMs: 2,
        operation: "write", metadata: {origin: "sync"}, beforePresent: "absent", path: "docs/other.md", payloadAfterPath: "docs/other.md", payloadAfterBlobSha256: evidence.projectedMarkdownSha256,
        payloadAfterContentKind: "text", payloadAfterByteLength: evidence.projectedMarkdownByteLength})}]});
    expect(storage.registerLiveDocumentBaseline({host: active.coordinate, evidence: outsideRegistration.evidence, baselineBytes: baseline, registeredAtMs: 3}).kind).toBe("registered");
    const relayApp = createSyncRelayHandler({storage, publicEditRelease, linkKey, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      namedBrowserSessionLimits: capacity.namedSessions, resolveActor: createSessionActorResolver(relayAuth), ownerRestoreHost: () => active});
    let routes!: ReturnType<typeof createNamedLiveRoutes>, namedRoutes!: ReturnType<typeof createNamedLiveRoutes>, linkHttp!: ReturnType<typeof createLinkLiveHttp>;
    const relayRequests: {method: string; path: string; status: number; logResponse?: unknown}[] = [];
    results.relayRequests = relayRequests;
    const relayHttp = serveFetchHandler({handler: async request => {
      const path = new URL(request.url).pathname;
      const response = await (path === "/sync/live/named-tickets" ? namedRoutes.handle(request) : path === "/sync/live/link-tickets" ? routes.handle(request)
        : ["/sync/live/link-session", "/sync/live/link-document"].includes(path) ? linkHttp(request) : relayApp(request));
      relayRequests.push({method: request.method, path, status: response.status,
        ...(request.method === "POST" && path === "/sync/workspace/log" ? {logResponse: await response.clone().json()} : {})}); return response;
    }, maxBodyBytes: url => url.pathname.startsWith("/sync/live/") ? capacity.requests.maxRequestBytes : capacity.ordinaryMaxRequestBytes,
      oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`, hosts = new Set([new URL(relayUrl).host]);
    const captureNative: Parameters<typeof createLiveHostReports>[0]["captureNative"] = async binding => {
      if (!active) throw new Error("Native host unavailable."); return active.captureNative(binding);
    };
    const tickets = createLiveTickets({storage, audience, key: ticketKey, hostReports: createLiveHostReports({storage, captureNative})});
    const membership = createLiveMembershipRegistry({maxSessions: routeLimits.maxConnections, maxMembers: routeLimits.maxConnections,
      maxSnapshotBytes: frames.receive.maxFrameBytes}, storage.readLiveAuthority.bind(storage)), sharedAdmission = createLiveConnectionAdmission();
    routes = createNamedLiveRoutes({kind: "link", storage, hosts, publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: capacity.bounds, validate, sessions: createLinkLiveBrowserResolver({storage, linkKey}), tickets, captureNative, membership, admission: sharedAdmission});
    namedRoutes = createNamedLiveRoutes({kind: "named", storage, hosts, publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: capacity.bounds, validate, sessions: {resolve: relayApp.resolveNamedBrowserSession}, tickets, captureNative, membership, admission: sharedAdmission});
    linkHttp = createLinkLiveHttp({storage, linkKey, hosts, publicOrigin: audience, exchangeKey, limits: routeLimits});
    closes.push(async () => routes.close());
    closes.push(async () => namedRoutes.close());
    relayHttp.on("upgrade", (request, socket, head) => {upgrades.push((new URL(request.url!, relayUrl).pathname === "/sync/live/link" ? routes : namedRoutes).handleUpgrade(request, socket, head));});
    const application = createShareWebApplication({publicEditRelease, relayUrl, publicRelayUrl: audience, relayExchangeKey: exchangeKey,
      fetchRelay: async request => {
        const bearer = request.headers.get("authorization")?.replace(/^(Bearer|LinkCapability) /, "");
        const profile = request.headers.get("x-dohc-link-profile-secret");
        if (bearer) protectedSecrets.add(bearer); if (profile) protectedSecrets.add(profile);
        return fetch(request);
      },
      publicHosts: new Set([new URL(audience).host]), accountAuth: {publicOrigin: audience, upstreamUrl: authUrl},
      namedBrowserSessionLimits: capacity.requests, namedLiveTickets: true, namedRecipientBrowserLimits: capacity.editor,
      viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
      linkLive: {publicOrigin: audience, requests: capacity.requests, editor: capacity.editor}});
    if (!application.linkLive) throw new Error("Public live composition missing.");
    const gateway = createLiveGateway({publicOrigin: audience, publicHosts: new Set([new URL(audience).host]), path: "/api/live/link",
      limits: capacity.gateway, resolveSession: application.linkLive.resolveSession, openHostRoute: application.linkLive.openHostRoute});
    closes.push(async () => gateway.close());
    const namedGateway = createLiveGateway({publicOrigin: audience, publicHosts: new Set([new URL(audience).host]), limits: capacity.gateway,
      resolveSession: async (request, discriminator, signal) => {const authenticated = namedLiveGatewayRequest(request, audience, signal);
        return authenticated ? application.resolveNamedBrowserSession(authenticated, discriminator) : null;},
      openHostRoute: createNamedLiveRelayRoute({relayUrl, publicOrigin: audience, exchangeKey, handshakeTimeoutMs: capacity.gateway.upgradeTimeoutMs})});
    closes.push(async () => namedGateway.close());
    const publicHttp = serveFetchHandler({handler: application.handle, maxBodyBytes: () => capacity.requests.maxRequestBytes,
      oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    publicHttps.on("request", (request, response) => publicHttp.emit("request", request, response));
    publicHttps.on("upgrade", (request, socket, head) => {upgrades.push((new URL(request.url!, audience).pathname === "/api/live/link" ? gateway : namedGateway).handleUpgrade(request, socket, head));});
    const ownerToken = (await auth.api.signInEmail({body: {email: ownerUser.email, password}})).token;
    async function ownerRequest(path: string, body?: unknown) {
      const response = await fetch(relayUrl + path, {method: body === undefined ? "GET" : "POST",
        headers: {authorization: `Bearer ${ownerToken}`, "content-type": "application/json"},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      const value = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200); return value;
    }
    function assertTicketCapacity(grantId: string) {
      const checkedAt = Date.now(), database = new DatabaseSync(join(root, "relay/relay.sqlite"), {readOnly: true});
      try {
        // An upper bound for every principal on this grant also bounds the refused caller.
        const row = database.prepare(`SELECT COALESCE(MAX(retained), 0) AS maximum FROM (
          SELECT COUNT(*) AS retained FROM ${LIVE_TICKET_TABLE}
          WHERE workspace_id = ? AND grant_id = ? AND expires_at_ms > ?
          GROUP BY principal_kind, principal_id
        )`).get("workspace", grantId, checkedAt);
        const maximum = Number(row!.maximum), limit = capacity.liveTickets.retainedTicketsPerPrincipalGrant;
        expect(maximum, "Ticket refusal must have unused retention capacity").toBeLessThan(limit);
        return {checkedAt, maximumRetainedPerPrincipal: maximum, admittedLimit: limit};
      } finally {database.close();}
    }
    // This fails closed until the release decision enables production owner Edit creation.
    const created = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/a.md"], access: "edit"});
    expect(created).toMatchObject({access: "edit", principalKind: "link", generation: 1});
    const shareId = created.shareId as string, grantId = created.grantId as string;
    browser = await chromium.launch({headless: true});
    async function openLink(url: string, index: number) {
      // Model independent clients at the trusted edge. The HTTP adapter used by
      // this fixture does not have the deployment proxy that supplies this IP.
      const context = await browser!.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 860},
        extraHTTPHeaders: {"x-dohc-share-web-client-ip": `192.0.2.${contexts.length + 1}`}}); contexts.push(context);
      const page = await context.newPage(); page.on("pageerror", error => browserErrors.push(String(error)));
      let exchangeBody: string | undefined;
      // Retain the browser-visible body before the exchange redirects the page.
      await page.route("**/api/exchange", async route => {
        const response = await route.fetch(), body = await response.text();
        exchangeBody = body; publicBodies.push(Promise.resolve({body}));
        await route.fulfill({response, body});
      });
      page.on("response", response => {const path = new URL(response.url()).pathname;
        if (path.startsWith("/api/")) {requests.push({context: index, path, status: response.status()});
          if (path.startsWith("/api/live/")) publicBodies.push(response.text().then(body => ({body}), error => ({error})));}});
      const exchange = page.waitForResponse(response => new URL(response.url()).pathname === "/api/exchange");
      await page.goto(url); const response = await exchange; expect(response.status()).toBe(200);
      expect(exchangeBody).toBeDefined();
      const exchanged = JSON.parse(exchangeBody!); expect(Object.keys(exchanged).sort()).toEqual(["ok", "session"]);
      const discriminator = exchanged.session as string;
      await browserExpect(page).toHaveURL(`${audience}/s/${discriminator}`);
      const cookies = await context.cookies(audience);
      const sessionCookie = cookies.find(row => row.name === `dohc_share_${discriminator}`);
      const profileCookie = cookies.find(row => row.name === `dohc_share_profile_${discriminator}`);
      for (const cookie of [sessionCookie, profileCookie]) expect(cookie).toMatchObject({secure: true, httpOnly: true, sameSite: "Strict", path: "/", domain: "127.0.0.1"});
      expect(sessionCookie!.value).not.toBe(profileCookie!.value);
      protectedSecrets.add(sessionCookie!.value); protectedSecrets.add(profileCookie!.value); protectedSecrets.add(new URL(url).hash.slice(1));
      expect(await page.evaluate(() => ({cookies: globalThis.document.cookie, fragment: location.hash}))).toEqual({cookies: "", fragment: ""});
      await page.getByRole("button", {name: "Edit file", exact: true}).click();
      const editor = page.getByRole("textbox", {name: "Shared file editor"});
      await browserExpect(editor).toHaveAttribute("contenteditable", "true");
      await browserExpect(page.getByRole("status")).toContainText("Ready to edit");
      return {context, page, editor, discriminator, profileDigest: hash(Buffer.from(profileCookie!.value)), sessionDigest: hash(Buffer.from(sessionCookie!.value))};
    }
    const peers = [];
    for (let index = 0; index < capacity.admittedConcurrency; index++) peers.push(await openLink(created.url, index));
    expect(new Set(peers.map(peer => peer.profileDigest)).size).toBe(capacity.admittedConcurrency);
    expect(new Set(peers.map(peer => peer.sessionDigest)).size).toBe(capacity.admittedConcurrency);
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency);
    await Promise.all(peers.map(async (peer, index) => {
      await peer.editor.click(); await peer.page.keyboard.press("Control+End"); await peer.page.keyboard.insertText(` Public peer ${index}.`);
      await browserExpect(peer.page.getByRole("status")).toContainText("Changes saved");
    }));
    for (const peer of peers) for (let index = 0; index < peers.length; index++) await browserExpect(peer.editor).toContainText(`Public peer ${index}.`);
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: ownerUser.id, shareId}});
    if (current.kind !== "current") throw new Error("Current native binding missing.");
    const native = await active.captureNative(current.binding);
    const journal = new DatabaseSync(join(root, "relay/relay.sqlite"), {readOnly: true});
    try {
      const rows = journal.prepare("SELECT delivery_id, update_digest, principal_kind, principal_id, grant_id FROM sync_relay_live_update_journal ORDER BY journal_cursor").all();
      expect(new Set(rows.map(row => row.principal_id)).size).toBe(capacity.admittedConcurrency);
      for (const row of rows) {
        expect(row).toMatchObject({principal_kind: "link", grant_id: grantId});
        const ack = await native.client.readLiveApplicationAck({id: native.nextRequestId(), workspace: native.workspace,
          registrationId: native.registrationId, deadlineMs: native.deadlineMs}, {deliveryId: String(row.delivery_id), updateDigest: String(row.update_digest)});
        expect(ack).toMatchObject({deliveryId: row.delivery_id, updateDigest: row.update_digest});
      }
      results.initialApplications = rows;
    } finally {journal.close();}
    const settlement = await active.settle(document); expect(settlement.materialized).toBe(true);
    const settledMarkdown = readFileSync(join(workspace, "docs/a.md"), "utf8");
    for (let index = 0; index < peers.length; index++) expect(settledMarkdown).toContain(`Public peer ${index}.`);
    results.tinyBrowserLifecycle = {concurrency: peers.length, settlement, settledMarkdown};
    const first = peers[0]!;
    await first.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency - 1);
    const wire = createPublicLinkWireProof({audience, root, frames, timeoutMs: routeLimits.upgradeTimeoutMs}); closes.push(wire.close);
    const consumed = await wire.ticket(first.context, first.discriminator, "object");
    const initialWire = await wire.connect(first.context, consumed, "consumed-ticket-first"); await initialWire.sync(); await initialWire.close();
    const replay = await wire.connect(first.context, consumed, "consumed-ticket-replay"); expect(await replay.status).toBe(404); await replay.close();
    const oldTicket = await wire.ticket(first.context, first.discriminator, "object");
    const hostile = await wire.connect(first.context, await wire.ticket(first.context, first.discriminator, "object"), "old-public-generation"); await hostile.sync();
    const staleDoc = new Y.Doc(); Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(hostile.doc)); staleDoc.getMap("frontmatter").set("stalePublic", "must refuse");
    const staleBytes = Y.encodeStateAsUpdate(staleDoc, Y.encodeStateVector(hostile.doc)); staleDoc.destroy();
    const partial = await hostile.partial(staleBytes, "public-old-partial");
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency);
    const options = OwnerRestoreActionResponse.options.parse(await ownerRequest("/sync/workspace/live-restores/options", {path: "docs/a.md"}));
    const point = options.points.find(row => row.cursor === 0); if (!point) throw new Error("Baseline restore point missing.");
    const planned = OwnerRestoreActionResponse.plan.parse(await ownerRequest("/sync/workspace/live-restores/plan", {document: options.document,
      shareId, grantId, restorePointCursor: point.cursor, restorePointReceiptDigest: point.receiptDigest}));
    const stopped = OwnerRestoreActionResponse.begin.parse(await ownerRequest("/sync/workspace/live-restores", {intent: planned.intent}));
    expect(stopped.phase).toBe("authority-invalidated");
    wire.events.push({authorityInvalidationObservedAt: Date.now()});
    await hostile.hostileSend(partial); await hostile.until(() => hostile.closed !== undefined);
    const prefix = `/sync/workspace/live-restores/${stopped.operationId}`;
    const prepared = OwnerRestoreActionResponse.prepare.parse(await ownerRequest(prefix + "/prepare", {})); expect(prepared.result.kind).toBe("prepared");
    const reviewed = OwnerRestoreActionResponse.review.parse(await ownerRequest(prefix + "/review", {}));
    if (!reviewed.result || "kind" in reviewed.result) throw new Error("Exact owner restore review missing.");
    expect(reviewed.result.content.frozenMarkdown).toBe(settledMarkdown); expect(reviewed.result.content.restoredMarkdown).toBe("Hello");
    const restored = OwnerRestoreActionResponse.confirm.parse(await ownerRequest(prefix + "/confirm", {proposalDigest: reviewed.result.proposalDigest}));
    expect(restored.result.kind).toBe("resumed"); expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello");
    const obsolete = await wire.connect(first.context, oldTicket, "old-unused-ticket"); expect(await obsolete.status).toBe(404); await obsolete.close();
    for (const peer of peers.slice(1)) await browserExpect(peer.editor).toHaveAttribute("contenteditable", "false");
    const revokedTicketCapacity = assertTicketCapacity(grantId);
    const denied = await first.context.request.post(audience + "/api/live/link-ticket", {data: {discriminator: first.discriminator, objectId: "object"}, headers: {origin: audience}});
    expect(denied.status()).toBe(404);
    for (const dbPath of [join(root, "relay/relay.sqlite"), join(workspace, ".dohc/engine/engine.db")]) {
      const database = new DatabaseSync(dbPath, {readOnly: true});
      try {const table = dbPath.includes("relay.sqlite") ? "sync_relay_live_update_journal" : "live_device_update_applications";
        expect(database.prepare(`SELECT delivery_id FROM ${table} WHERE delivery_id = ?`).all("public-old-partial")).toEqual([]);
      } finally {database.close();}
    }
    results.restore = {admittedConcurrency: capacity.admittedConcurrency, stalePartialRefused: true, oldTicketRefused: true, oldGrantRefused: true,
      revokedTicketCapacity, exactBefore: settledMarkdown, exactAfter: "Hello", proposalDigest: reviewed.result.proposalDigest};
    // Restore retires the stopped share grant. Create the replacement from the
    // current selector rather than trying to add a grant to that retired share.
    const freshLink = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/a.md"], access: "edit"});
    const freshPeers = [];
    for (let index = 0; index < capacity.admittedConcurrency; index++) freshPeers.push(await openLink(freshLink.url, peers.length + index));
    const freshFirst = freshPeers[0]!;
    await freshFirst.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency - 1);
    for (const origin of [null, "https://unapproved.example.test"]) {
      const invalidOrigin = await wire.connect(freshFirst.context, await wire.ticket(freshFirst.context, freshFirst.discriminator, "object"), `origin-${origin ?? "missing"}`, origin);
      expect(await invalidOrigin.status).toBe(404); await invalidOrigin.close();
    }
    const outsideLink = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/other.md"], access: "edit"});
    const outsidePeer = await openLink(outsideLink.url, peers.length + freshPeers.length);
    await browserExpect(outsidePeer.editor).toHaveText("Hello");
    await outsidePeer.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency - 1);
    const outsideTicketCapacity = assertTicketCapacity(freshLink.grantId);
    const outsideTicket = await freshFirst.context.request.post(audience + "/api/live/link-ticket", {
      data: {discriminator: freshFirst.discriminator, objectId: "outside-object"}, headers: {origin: audience}});
    expect(outsideTicket.status()).toBe(404);
    for (const path of ["a.txt", "other.md", "docs/a.md", "../docs/a.md"]) {
      const refused = await freshFirst.context.request.post(audience + "/api/live/link-document", {
        data: {discriminator: freshFirst.discriminator, path}, headers: {origin: audience}});
      expect(refused.status()).toBe(404);
    }
    const validDocument = await freshFirst.context.request.post(audience + "/api/live/link-document", {
      data: {discriminator: freshFirst.discriminator, path: "a.md"}, headers: {origin: audience}});
    expect(validDocument.status()).toBe(200); expect(Object.keys(await validDocument.json()).sort()).toEqual(["limits", "objectId"]);
    const pinned = await fetch(relayUrl + "/sync/workspace/shares/links", {method: "POST",
      headers: {authorization: `Bearer ${ownerToken}`, "content-type": "application/json"},
      body: JSON.stringify({paths: ["docs/a.md"], versionId: mainVersionId!, access: "edit"})});
    expect(pinned.status).toBe(400); expect(await pinned.json()).toMatchObject({code: "invalid_access"});
    results.boundaries = {missingOriginRefused: true, foreignOriginRefused: true, pinnedEditCreationRefused: true,
      nonMarkdownPathRefused: true, selectorEscapeRefused: true, validOutsideObjectControl: true, crossObjectTicketRefused: true,
      outsideTicketCapacity, samePrincipalTicketControl: true, traversalRefused: true, currentMarkdownMetadataAccepted: true};
    const oldEpoch = await wire.connect(freshFirst.context, await wire.ticket(freshFirst.context, freshFirst.discriminator, "object"), "pre-restart"); await oldEpoch.sync();
    const beforeRestartEpoch = oldEpoch.hostEpoch!;
    const epochDoc = new Y.Doc(); Y.applyUpdate(epochDoc, Y.encodeStateAsUpdate(oldEpoch.doc)); epochDoc.getMap("frontmatter").set("oldEpochProbe", "must refuse");
    const epochBytes = Y.encodeStateAsUpdate(epochDoc, Y.encodeStateVector(oldEpoch.doc)); epochDoc.destroy();
    const epochPartial = await oldEpoch.partial(epochBytes, "public-old-epoch");
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency);
    await active.close(); active = undefined;
    await oldEpoch.hostileSend(epochPartial); await oldEpoch.until(() => oldEpoch.closed !== undefined);
    active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});
    const newEpoch = await wire.connect(freshFirst.context, await wire.ticket(freshFirst.context, freshFirst.discriminator, "object"), "fresh-epoch-control"); await newEpoch.sync();
    // A service reconnect keeps the provisioned epoch; the closed old socket
    // is the restart fence. Epoch changes belong to an explicit host transition.
    expect(newEpoch.hostEpoch!).toBe(beforeRestartEpoch);
    for (const peer of freshPeers.slice(1)) {
      await peer.page.getByRole("button", {name: "Retry connection", exact: true}).click();
      await browserExpect(peer.editor).toHaveAttribute("contenteditable", "true");
    }
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency);
    const freshDoc = new Y.Doc(); Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(newEpoch.doc)); freshDoc.getMap("frontmatter").set("freshEpoch", "accepted");
    const freshBytes = Y.encodeStateAsUpdate(freshDoc, Y.encodeStateVector(newEpoch.doc)); freshDoc.destroy();
    const accepted = await newEpoch.submit(freshBytes, "public-fresh-epoch"); expect(accepted.kind).toBe("result");
    if (accepted.kind !== "result" || accepted.result !== "success") throw new Error("Fresh epoch control was not acknowledged.");
    await active.settle(document);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toContain("freshEpoch: accepted");
    const nativeDb = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {
      expect(nativeDb.prepare("SELECT delivery_id FROM live_device_update_applications WHERE delivery_id = ?").all("public-old-epoch")).toEqual([]);
      expect(nativeDb.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications WHERE delivery_id = ?").get("public-fresh-epoch"))
        .toEqual({delivery_id: "public-fresh-epoch", update_digest: hash(freshBytes)});
    } finally {nativeDb.close();}
    results.restart = {concurrencyAtRestart: capacity.admittedConcurrency, oldPartialRefused: true,
      beforeRestartEpoch, afterRestartEpoch: newEpoch.hostEpoch!, freshAck: accepted.ack};
    await newEpoch.close();
    for (const [index, peer] of freshPeers.entries()) await peer.page.screenshot({path: join(root, `public-peer-${index}.png`), fullPage: true});
    for (const peer of freshPeers.slice(1)) await peer.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(() => frameChanges.listenerCount()).toBe(0);
    const workloadDocument = {...document, objectId: "workload-object", lineageClaimId: hash(workload.checkpoint)};
    const browserWorkloadDocument = {...workloadDocument, objectId: "browser-workload-object"};
    for (const [fixtureDocument, path] of [[workloadDocument, "docs/workload.md"], [browserWorkloadDocument, "docs/browser-workload.md"]] as const) {
    const workloadRegistration = createLiveMarkdownRegistrationValidator(validationPolicy)({document: fixtureDocument,
      currentPath: path, checkpoint: workload.checkpoint});
    if (workloadRegistration.kind !== "accepted") throw new Error(JSON.stringify(workloadRegistration));
    expect(workloadRegistration.evidence.projectedMarkdownSha256).toBe(hash(workload.markdown));
    storage.putBlob({workspaceId: "workspace", sha256: hash(workload.markdown), content: workload.markdown, createdAtMs: 4});
    storage.appendLogBatch({workspaceId: "workspace", originId: fixtureDocument.objectId, ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 4,
      payloadJson: JSON.stringify({objectId: fixtureDocument.objectId, momentId: fixtureDocument.objectId, versionId: mainVersionId!, recordedAtMs: 4,
        operation: "write", metadata: {origin: "sync"}, beforePresent: "absent", path, payloadAfterPath: path,
        payloadAfterBlobSha256: hash(workload.markdown), payloadAfterContentKind: "text", payloadAfterByteLength: workload.markdown.length})}]});
    expect(storage.registerLiveDocumentBaseline({host: active.coordinate, evidence: workloadRegistration.evidence,
      baselineBytes: workload.checkpoint, registeredAtMs: 5}).kind).toBe("registered");
    }
    const workloadLink = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/workload.md"], access: "edit"});
    const browserWorkloadLink = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/browser-workload.md"], access: "edit"});
    const workloadBrowsers = [];
    for (let index = 0; index < capacity.admittedConcurrency; index++) workloadBrowsers.push(await openLink(browserWorkloadLink.url, contexts.length));
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency);
    results.workloadBrowserBaseline = {concurrency: workloadBrowsers.length, ready: true, checkpointSha256: hash(workload.checkpoint)};
    await Promise.all(workloadBrowsers.map(async (peer, index) => {
      await peer.editor.click(); await peer.page.keyboard.press("Control+End"); await peer.page.keyboard.insertText(` Workload peer ${index}.`);
      await browserExpect(peer.page.getByRole("status")).toContainText("Changes saved");
    }));
    for (const peer of workloadBrowsers) for (let index = 0; index < workloadBrowsers.length; index++) await browserExpect(peer.editor).toContainText(`Workload peer ${index}.`);
    const browserBinding = storage.resolveCurrentLiveDocumentBinding({document: browserWorkloadDocument, actor: {kind: "owner", userId: ownerUser.id, shareId: browserWorkloadLink.shareId}});
    if (browserBinding.kind !== "current") throw new Error("Browser workload native binding missing.");
    const browserNative = await active.captureNative(browserBinding.binding), browserJournal = new DatabaseSync(join(root, "relay/relay.sqlite"), {readOnly: true});
    try {
      const rows = browserJournal.prepare("SELECT delivery_id, update_digest, principal_id FROM sync_relay_live_update_journal WHERE grant_id = ? ORDER BY journal_cursor").all(browserWorkloadLink.grantId);
      expect(new Set(rows.map(row => row.principal_id)).size).toBe(capacity.admittedConcurrency);
      for (const row of rows) expect(await browserNative.client.readLiveApplicationAck({id: browserNative.nextRequestId(), workspace: browserNative.workspace,
        registrationId: browserNative.registrationId, deadlineMs: browserNative.deadlineMs}, {deliveryId: String(row.delivery_id), updateDigest: String(row.update_digest)}))
        .toMatchObject({deliveryId: row.delivery_id, updateDigest: row.update_digest});
      const settled = await active.settle(browserWorkloadDocument); expect(settled.materialized).toBe(true);
      const markdown = readFileSync(join(workspace, "docs/browser-workload.md"), "utf8");
      for (let index = 0; index < workloadBrowsers.length; index++) expect(markdown).toContain(`Workload peer ${index}.`);
      results.workloadBrowserEdits = {concurrency: workloadBrowsers.length, applications: rows, settled, markdownSha256: hash(Buffer.from(markdown))};
    } finally {browserJournal.close();}
    for (const peer of workloadBrowsers) await peer.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(() => frameChanges.listenerCount()).toBe(0);
    const wireIdentities = [];
    for (let index = 0; index < capacity.admittedConcurrency; index++) {
      const peer = await openLink(workloadLink.url, contexts.length);
      await peer.page.getByRole("button", {name: "Back to shared files", exact: true}).click(); wireIdentities.push(peer);
    }
    await browserExpect.poll(() => frameChanges.listenerCount()).toBe(0);
    const workloadWires: Awaited<ReturnType<typeof wire.connect>>[] = [];
    for (const [index, peer] of wireIdentities.entries()) {
      const socket = await wire.connect(peer.context, await wire.ticket(peer.context, peer.discriminator, workloadDocument.objectId), `workload-${index}`);
      await socket.sync(); expect(hash(Buffer.from(yDocToMarkdown(socket.doc)))).toBe(hash(workload.markdown)); workloadWires.push(socket);
    }
    await browserExpect.poll(() => frameChanges.captureCount()).toBe(capacity.admittedConcurrency);
    const workloadCurrent = storage.resolveCurrentLiveDocumentBinding({document: workloadDocument, actor: {kind: "owner", userId: ownerUser.id, shareId: workloadLink.shareId}});
    if (workloadCurrent.kind !== "current") throw new Error("Workload native binding missing.");
    const workloadNative = await active.captureNative(workloadCurrent.binding), workloadRounds = [];
    for (const [index, round] of workload.rounds.entries()) {
      const startedAt = Date.now();
      const acknowledgments = await Promise.all(round.updates.map(async update => {
        const outcome = await workloadWires[update.client]!.submit(update.content, update.deliveryId);
        if (outcome.kind !== "result" || outcome.result !== "success") throw new Error(`Workload application refused: ${update.deliveryId}`);
        const ack = await workloadNative.client.readLiveApplicationAck({id: workloadNative.nextRequestId(), workspace: workloadNative.workspace,
          registrationId: workloadNative.registrationId, deadlineMs: workloadNative.deadlineMs}, {deliveryId: update.deliveryId, updateDigest: hash(update.content)});
        expect(ack).toMatchObject({deliveryId: update.deliveryId, updateDigest: hash(update.content)}); return ack;
      }));
      for (const peer of workloadWires) await peer.until(() => hash(Buffer.from(yDocToMarkdown(peer.doc))) === hash(round.markdown));
      const settled = await active.settle(workloadDocument); expect(settled.materialized).toBe(true);
      expect(hash(readFileSync(join(workspace, "docs/workload.md")))).toBe(hash(round.markdown));
      workloadRounds.push({index, startedAt, finishedAt: Date.now(), acknowledgments, settled, markdownSha256: hash(round.markdown)});
    }
    for (const peer of workloadWires) await peer.close();
    results.suppliedWireWorkload = {concurrency: workloadWires.length, manifest: capacity.workload, assets: workload.pins, rounds: workloadRounds, verdict: "PASS"};
    readPublicWorkload(capacity.workload, capacity.admittedConcurrency);
    const transitionHarness: PublicTransitionHarness = {root, workspace, audience, concurrency: capacity.admittedConcurrency,
      timeoutMs: routeLimits.upgradeTimeoutMs, storage, evidence: results, ownerUserId: ownerUser.id, host: () => {
        if (!active) throw new Error("Transition host is offline."); return active;
      }, restart: async () => {await active!.close(); active = undefined; active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});},
      publishSettled: async (document, path) => {
        // These documents are registered directly, without an ordinary owner
        // history. Publish the actual native file through the fixture relay;
        // the separate automatic-View case tests real ordinary replication.
        const bytes = readFileSync(join(workspace, path)), digest = hash(bytes);
        const originId = `settled-${document.objectId}`, recordedAtMs = Date.now();
        storage.putBlob({workspaceId: document.workspaceId, sha256: digest, content: bytes, createdAtMs: recordedAtMs});
        const published = await ownerRequest(`/sync/${document.workspaceId}/log`, {originId,
          ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs,
            payload: {objectId: document.objectId, momentId: originId, versionId: document.mainVersionId,
              recordedAtMs, operation: "write", metadata: {origin: "sync"}, beforePresent: "present", path,
              payloadAfterPath: path, payloadAfterBlobSha256: digest, payloadAfterContentKind: "text", payloadAfterByteLength: bytes.length}}]});
        expect(published.inserted).toBe(1);
        results.restoreViewPublication = {kind: "fixture-relay-publication-of-native-file", objectId: document.objectId,
          path, blobSha256: digest, byteLength: bytes.length, automaticReplicationProven: false};
      },
      listeners: () => frameChanges.captureCount(), allListeners: () => sharedChanges.listenerCount(), ownerRequest, openLink, wire, validate, assertTicketCapacity,
      interruptedBounds: {maxSubmissionBytes: capacity.bounds.maxSubmissionBytes, maxAdmissionBytes: capacity.bounds.maxAdmissionBytes, maxUpdateBytes: frames.receive.maxUpdateBytes},
      register: async (id, checkpoint, markdown) => {
        const path = `docs/${id}.md`, document = {workspaceId: "workspace", mainVersionId: mainVersionId!, objectId: id, lineageClaimId: hash(checkpoint)};
        const registration = createLiveMarkdownRegistrationValidator(validationPolicy)({document, currentPath: path, checkpoint});
        if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
        expect(registration.evidence.projectedMarkdownSha256).toBe(hash(markdown));
        storage.putBlob({workspaceId: "workspace", sha256: hash(markdown), content: markdown, createdAtMs: Date.now()});
        storage.appendLogBatch({workspaceId: "workspace", originId: id, ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: Date.now(),
          payloadJson: JSON.stringify({objectId: id, momentId: id, versionId: mainVersionId!, recordedAtMs: Date.now(), operation: "write",
            metadata: {origin: "sync"}, beforePresent: "absent", path, payloadAfterPath: path, payloadAfterBlobSha256: hash(markdown),
            payloadAfterContentKind: "text", payloadAfterByteLength: markdown.length})}]});
        expect(storage.registerLiveDocumentBaseline({host: active!.coordinate, evidence: registration.evidence, baselineBytes: checkpoint, registeredAtMs: Date.now()}).kind).toBe("registered");
        const link = await ownerRequest("/sync/workspace/shares/links", {paths: [path], access: "edit"}); return {document, path, link};
      }};
    results.loadedTransitions = await runPublicTransitions(transitionHarness, transitions);
    const namedUser = (await auth.api.signUpEmail({body: {email: "public-proof-named@example.test", password, name: "Named collaborator"}})).user;
    const namedGrants = new Map<string, string>();
    results.publicMixedPresence = await runPublicMixedPresence(transitionHarness, transitions, async fixture => {
      let grantId = namedGrants.get(fixture.document.objectId);
      if (!grantId) {
        grantId = randomUUID(); namedGrants.set(fixture.document.objectId, grantId);
        const shareId = randomUUID();
        storage.createShare({share: {shareId, workspaceId: fixture.document.workspaceId, granterUserId: ownerUser.id,
          selectorJson: JSON.stringify({paths: [fixture.path], versionId: null}), createdAtMs: Date.now()}, grant: {grantId, shareId, principalKind: "user",
          principalUserId: namedUser.id, principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null}});
      }
      const context = await browser!.newContext({ignoreHTTPSErrors: true}); contexts.push(context); const page = await context.newPage();
      page.on("pageerror", error => browserErrors.push(String(error)));
      await page.goto(`${audience}/s/edit/${encodeURIComponent(grantId)}`);
      await page.getByLabel("Email", {exact: true}).fill(namedUser.email); await page.getByLabel("Password", {exact: true}).fill(password);
      await page.getByRole("button", {name: "Sign in", exact: true}).click();
      await browserExpect(page.getByRole("button", {name: "Sign out", exact: true})).toBeVisible();
      await page.getByRole("button", {name: fixture.path, exact: true}).click();
      const editor = page.getByRole("textbox", {name: "Shared file editor"});
      await browserExpect(editor).toHaveAttribute("contenteditable", "true");
      await browserExpect(page.getByRole("status")).toContainText("Ready to edit"); return {context, page, editor};
    });
    for (const context of contexts) await context.close();
    expect(browser!.contexts()).toHaveLength(0);
    await browserExpect.poll(() => frameChanges.listenerCount()).toBe(0);
    results.automaticView = await runPublicAutomaticView({h: transitionHarness, selected: transitions.cases.view, admission: capacity.automaticView,
      executable, relayUrl, ownerToken, native: capacity.native, validation: validationPolicy, maxRegistrations: capacity.maxRegistrations,
      replaceHost: async config => {await active!.close(); active = undefined; writeFileSync(serviceConfig, JSON.stringify(config));
        active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});},
      newView: async url => {
        const context = await browser!.newContext({ignoreHTTPSErrors: true}); contexts.push(context); const page = await context.newPage();
        page.on("pageerror", error => browserErrors.push(String(error)));
        const exchange = page.waitForResponse(response => new URL(response.url()).pathname === "/api/exchange");
        await page.goto(url); expect((await exchange).status()).toBe(200); return {context, page};
      }});
    readPublicTransitionWorkload(capacity.transitions, capacity.admittedConcurrency);
    const exposedBodies = (await Promise.all(publicBodies)).map(result => {
      if ("error" in result) throw result.error;
      return result.body;
    });
    for (const secret of protectedSecrets) for (const body of exposedBodies) expect(body).not.toContain(secret);
    for (const context of contexts) for (const page of context.pages()) {
      const exposed = await page.evaluate(() => JSON.stringify({html: globalThis.document.documentElement.outerHTML, local: {...localStorage}, session: {...sessionStorage}, hash: location.hash, cookie: globalThis.document.cookie}));
      for (const secret of protectedSecrets) expect(exposed).not.toContain(secret);
    }
    results.credentials = {protectedCookieProfiles: capacity.admittedConcurrency, protectedSecretsChecked: protectedSecrets.size, javascriptResponseBodiesChecked: exposedBodies.length, privateCredentialsExcluded: true, requests};
    expect(browserErrors).toEqual([]); expect(hash(readFileSync(executable))).toBe(expectedHash);
    proofPassed = true;
  } finally {
    try {
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: proofPassed ? "PASS" : "FAIL", executable, sha256: expectedHash, admissionSha256: admissionDigest,
      scope: "Owner HTTP Edit and protected-cookie exchange; tiny controls; pinned browser baseline and small edits; distinct wire workload; pinned restart/stale/selector/access and restore recipe with runtime-derived continuation at C with C-1 Chromium receivers; mixed named/link presence; actual automatic service settlement and View DOM within five seconds from pre-receipt submission",
      omissions: ["Owner UI creation control", "Private named158/160 rerun", "Throughput or latency guarantee beyond the separately admitted capacity", "Browser-restart draft recovery", "Large pinned updates are wire-authored; Chromium receives and renders them through the production provider", "Transition stages use one active submitter and C-1 browser receivers", "Internal ordinary replication TLS; native sync uses the recorded owned-loopback transport seam"], results}, null, 2));
    } catch (error) {
      if (proofPassed) throw error;
      console.error("Could not retain public proof results after failure:", error);

    } finally {
    for (const context of contexts) await context.close();
    await browser?.close();
    for (const close of closes.reverse()) await close();
    await Promise.allSettled(upgrades);
    await active?.close(); deployment.storage.close(); ownerDoc.destroy();
    }
  }
  } finally {
    publicHttps.closeAllConnections(); await new Promise<void>(done => publicHttps.close(() => done()));
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 300000);
