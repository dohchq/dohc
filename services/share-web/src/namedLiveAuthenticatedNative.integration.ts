import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
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
import { createNamedLiveBrowserTransport, type NamedLiveBrowserState } from "../viewer/src/namedLiveBrowserTransport.js";

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
const audience = "https://share.example.test", exchangeKey = "native-network-exchange-".repeat(2), ticketKey = "native-network-tickets-".repeat(2);
type Manager = ReturnType<typeof createNamedLiveBrowserTransport>;
type Provider = ReturnType<Manager["select"]>;
type BrowserSocket = ReturnType<NonNullable<Parameters<typeof createNamedLiveBrowserTransport>[0]["openSocket"]>>;

function stateWhen(provider: Provider, condition: (state: NamedLiveBrowserState) => boolean): Promise<NamedLiveBrowserState> {
  const current = provider.state();
  if (condition(current)) return Promise.resolve(current);
  if (current.status === "quarantined" || current.status === "disconnected" || current.status === "closed") {
    return Promise.reject(new Error(`Provider retired: ${JSON.stringify(current)}`));
  }
  return new Promise((resolve, reject) => {
    const unsubscribe = provider.subscribe(state => {
      if (condition(state)) { unsubscribe(); resolve(state); }
      else if (state.status === "quarantined" || state.status === "disconnected" || state.status === "closed") {
        unsubscribe(); reject(new Error(`Provider retired: ${JSON.stringify(state)}`));
      }
    });
  });
}
function fieldWhen(provider: Provider, name: string, value: string): Promise<void> {
  if (provider.doc.getMap("frontmatter").get(name) === value) return Promise.resolve();
  const current = provider.state();
  if (current.status === "quarantined" || current.status === "disconnected" || current.status === "closed") {
    return Promise.reject(new Error(`Provider retired: ${JSON.stringify(current)}`));
  }
  const pending = new Promise<void>((resolve, reject) => {
    const update = () => { if (provider.doc.getMap("frontmatter").get(name) === value) { stop(); resolve(); } };
    const unsubscribe = provider.subscribe(state => {
      if (state.status === "quarantined" || state.status === "disconnected" || state.status === "closed") { stop(); reject(new Error(`Provider retired: ${JSON.stringify(state)}`)); }
    });
    function stop() { provider.doc.off("update", update); unsubscribe(); }
    provider.doc.on("update", update);
  });
  void pending.catch(() => undefined);
  return pending;
}
// Preserve the logical HTTPS origin and real cookie while using owned loopback I/O.
// This executes the production adapter but does not exercise browser UI or TLS.
async function browserRequest(port: number, path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "GET", signal: init.signal ?? undefined, headers: {
      ...Object.fromEntries(new Headers(init.headers)), host: new URL(audience).host, origin: audience,
      "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) } }, response => {
      const bytes: Buffer[] = []; response.on("data", chunk => bytes.push(Buffer.from(chunk)));
      response.once("end", () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        resolve(new Response(Buffer.concat(bytes), { status: response.statusCode, headers }));
      });
      response.once("error", reject);
    });
    request.once("error", reject); request.end(init.body);
  });
}

// Opt-in integration filename. The pinned serial harness must select this file explicitly.
it("authenticates two accounts through the production browser transport and preserves native ACKs and peer feed", async () => {
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
  const closes: (() => Promise<void>)[] = [], providers: Provider[] = [], sockets: WebSocket[] = [], upgrades: Promise<void>[] = [];
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
      accountAuth: { publicOrigin: audience, upstreamUrl: authUrl }, namedBrowserSessionLimits: browserLimits, namedLiveTickets: true });
    const gateway = createLiveGateway({ publicOrigin: audience, publicHosts: new Set([new URL(audience).host]),
      limits: { maxConnections: 4, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4, maxFrameBytes: 65536,
        maxPendingBytes: 2000000, maxPendingFrames: 64, maxFragments: 8, maxBufferedChunks: 64, upgradeTimeoutMs: 30000, idleTimeoutMs: 60000, drainTimeoutMs: 1000 },
      resolveNamedSession: async (request, discriminator, signal) => { const authenticated = namedLiveGatewayRequest(request, audience, signal);
        return authenticated ? application.resolveNamedBrowserSession(authenticated, discriminator) : null; },
      openHostRoute: createNamedLiveRelayRoute({ relayUrl, publicOrigin: audience, exchangeKey, handshakeTimeoutMs: 30000 }),
    });
    const publicHttp = serveFetchHandler({ handler: application.handle, maxBodyBytes: () => 8192,
      oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
    publicHttp.on("upgrade", (request, socket, head) => { upgrades.push(gateway.handleUpgrade(request, socket, head)); });
    publicHttp.listen(0, "127.0.0.1"); await once(publicHttp, "listening");
    closes.push(() => new Promise<void>(done => publicHttp.close(() => done())));
    closes.push(async () => gateway.close());
    const port = (publicHttp.address() as { port: number }).port;
    async function signIn(user: typeof users[number]) {
      const response = await browserRequest(port, "/api/account/sign-in", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ email: user.email, password }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, user: { id: user.id, name: user.name } });
      expect(response.headers.get("set-auth-token")).toBeNull();
      const name = getCookies({ baseURL: audience }).sessionToken.name;
      const line = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
      expect(line).toBeDefined();
      const attributes = parseSetCookieHeader(line!).get(name)!;
      expect(attributes).toMatchObject({ secure: true, httponly: true, samesite: "lax", path: "/" });
      expect(attributes).not.toHaveProperty("domain");
      return line!.split(";", 1)[0]!;
    }
    const cookies = [await signIn(users[0]!), await signIn(users[1]!)];
    const requests: { accountId: string; path: string; status: number }[] = [];
    function browser(cookie: string, accountId: string, grantId: string) {
      const manager = createNamedLiveBrowserTransport({ publicOrigin: audience,
        limits: { provider: { frames, maxPendingUpdateBytes: 2000000, maxPendingUpdates: 4, maxDeliveryAttempts: 3 },
          maxHttpResponseBytes: 8192, maxSocketBufferedBytes: 2000000, connectTimeoutMs: 30000, sendTimeoutMs: 30000, drainPollMs: 10 },
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          expect(url.origin).toBe(audience);
          const response = await browserRequest(port, url.pathname + url.search, init, cookie);
          requests.push({ accountId, path: url.pathname, status: response.status });
          return response;
        },
        openSocket: (input, protocols) => {
          const url = new URL(input); expect(url.origin).toBe(audience.replace("https:", "wss:"));
          const socket = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, protocols, {
            headers: { host: new URL(audience).host, origin: audience, cookie }, perMessageDeflate: false });
          sockets.push(socket); socket.on("error", () => undefined);
          socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); });
          return socket as unknown as BrowserSocket;
        } });
      const provider = manager.select({ accountId, workspaceId: document.workspaceId, grantId, objectId: document.objectId });
      providers.push(provider);
      return { provider, manager };
    }
    const first = browser(cookies[0]!, users[0]!.id, "grant-0"), peer = browser(cookies[1]!, users[1]!.id, "grant-1");
    await first.provider.reconnect(); await stateWhen(first.provider, state => state.status === "live");
    await peer.provider.reconnect(); await stateWhen(peer.provider, state => state.status === "live");
    for (const user of users) for (const path of ["/api/account/session", "/api/live/named-session", "/api/live/named-ticket"]) {
      expect(requests).toContainEqual({ accountId: user.id, path, status: 200 });
    }
    const socketCount = sockets.length;
    expect(socketCount).toBe(2);
    const wrongAccountStart = requests.length;
    const wrongAccount = browser(cookies[1]!, users[0]!.id, "grant-0");
    await wrongAccount.provider.reconnect();
    expect(wrongAccount.provider.state()).toMatchObject({ status: "refused", reason: "account-changed" });
    expect(requests.slice(wrongAccountStart)).toEqual([{ accountId: users[0]!.id, path: "/api/account/session", status: 200 }]);
    const wrongGrantStart = requests.length;
    const wrongGrant = browser(cookies[1]!, users[1]!.id, "grant-0");
    await wrongGrant.provider.reconnect();
    expect(wrongGrant.provider.state()).toMatchObject({ status: "disconnected", reason: "authority-unavailable" });
    expect(requests.slice(wrongGrantStart)).toEqual([
      { accountId: users[1]!.id, path: "/api/account/session", status: 200 },
      { accountId: users[1]!.id, path: "/api/live/named-session", status: 404 },
    ]);
    expect(sockets).toHaveLength(socketCount);
    results.authentication = { accountIds: users.map(user => user.id), requests, wrongAccount: wrongAccount.provider.state(), wrongGrant: wrongGrant.provider.state() };
    expect(yDocToMarkdown(first.provider.doc)).toBe("Hello"); expect(yDocToMarkdown(peer.provider.doc)).toBe("Hello");
    const actor = { kind: "owner", userId: "owner", shareId: "share-0" } as const;
    const current = storage.resolveCurrentLiveDocumentBinding({ document, actor }); if (current.kind !== "current") throw new Error("Current binding unavailable.");
    const capture = await active.captureNative(current.binding);
    results.registrationId = capture.registrationId;
    const nativeRequest = () => ({ id: capture.nextRequestId(), workspace: capture.workspace, registrationId: capture.registrationId, deadlineMs: capture.deadlineMs });
    let localBytes!: Uint8Array;
    first.provider.doc.once("update", bytes => { localBytes = bytes.slice(); });
    const peerSawBrowser = fieldWhen(peer.provider, "title", "from-browser");
    expect(first.provider.edit(() => first.provider.doc.getMap("frontmatter").set("title", "from-browser"))).toBe(true);
    const browserAck = (await stateWhen(first.provider, state => state.lastApplied !== null && state.pendingUpdates === 0)).lastApplied!;
    await peerSawBrowser;
    expect(browserAck.updateDigest).toBe(hash(localBytes));
    expect(await capture.client.readLiveApplicationAck(nativeRequest(), {
      deliveryId: browserAck.deliveryId, updateDigest: browserAck.updateDigest,
    })).toEqual(browserAck);
    Y.applyUpdate(ownerDoc, localBytes);
    results.browserAck = browserAck;
    const beforeOwner = Y.encodeStateVector(ownerDoc); ownerDoc.getMap("frontmatter").set("owner", "from-owner");
    const ownerBytes = Y.encodeStateAsUpdate(ownerDoc, beforeOwner), cut = storage.readLiveUpdateJournalCut({ document });
    const ownerAuthority = storage.resolveCurrentLiveDocumentBinding({ document, actor });
    if (cut.kind !== "cut" || ownerAuthority.kind !== "current") throw new Error("Owner admission cut unavailable.");
    const validation = validate({ document, currentPath: "docs/a.md", checkpoint: cut.cut.checkpoint.bytes, suffix: cut.cut.suffix.map(row => row.bytes), candidate: ownerBytes });
    const ownerAccepted = storage.commitLiveUpdateJournal({ host: ownerAuthority.host, actor, expectedAuthority: ownerAuthority.authority,
      metadata: { deliveryId: "owner-over-network", updateDigest: hash(ownerBytes), binding: ownerAuthority.binding }, cutToken: cut.cut, validation, updateBytes: ownerBytes, receivedAtMs: Date.now() });
    expect(ownerAccepted.result.kind).toBe("accepted");
    const ownerSeen = [fieldWhen(first.provider, "owner", "from-owner"), fieldWhen(peer.provider, "owner", "from-owner")];
    await active.drain(document); await Promise.all(ownerSeen);
    const settlement = await active.settle(document);
    expect(settlement.materialized).toBe(true); expect(capture.invalidated.aborted).toBe(false);
    expect((await active.captureNative(current.binding)).registrationId).toBe(capture.registrationId);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(ownerDoc));
    results.ownerAccepted = ownerAccepted.result; results.settlement = settlement;
    const peerAfterSettlement = fieldWhen(first.provider, "after", "settlement");
    expect(peer.provider.edit(() => peer.provider.doc.getMap("frontmatter").set("after", "settlement"))).toBe(true);
    const afterAck = (await stateWhen(peer.provider, state => state.pendingUpdates === 0 && (state.lastApplied?.journalCursor ?? 0) > browserAck.journalCursor)).lastApplied!;
    await peerAfterSettlement; results.afterSettlementAck = afterAck;
    expect(await capture.client.readLiveApplicationAck(nativeRequest(), { deliveryId: afterAck.deliveryId, updateDigest: afterAck.updateDigest })).toEqual(afterAck);
    expect(capture.invalidated.aborted).toBe(false); expect((await active.captureNative(current.binding)).registrationId).toBe(capture.registrationId);
    await active.settle(document);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(first.provider.doc));
    const disconnected = sockets.map(socket => new Promise<void>(done => socket.once("close", () => done())));
    for (const index of [0, 1]) expect(storage.revokeShareGrant({ shareId: `share-${index}`, grantId: `grant-${index}`,
      revokedAtMs: Date.now(), expectedDependentGrantIds: [], guard: storage.captureStanding() }).ok).toBe(true);
    await Promise.all(disconnected); await noListeners;
    expect(frameChanges.listenerCount()).toBe(0);
    expect(first.provider.state().status).toBe("disconnected"); expect(peer.provider.state().status).toBe("disconnected");
    expect(capture.invalidated.aborted).toBe(false); results.grantRetired = true;
    await active.close(); active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), { readOnly: true });
    try {
      const applications = engine.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(applications).toHaveLength(3);
      expect(applications[0]).toEqual({ delivery_id: browserAck.deliveryId, update_digest: browserAck.updateDigest });
      expect(applications[1]).toEqual({ delivery_id: "owner-over-network", update_digest: hash(ownerBytes) });
      expect(applications[2]).toEqual({ delivery_id: afterAck.deliveryId, update_digest: afterAck.updateDigest });
      results.persistedApplications = applications;
    } finally { engine.close(); }
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({ verdict: "PASS", executable, sha256: expectedHash,
      scope: "Real BetterAuth/Postgres sign-in and cookie resolution, production namedLiveBrowserTransport over loopback HTTP/WS test I/O, relay admission, native daemon ACKs, two distinct named principals and peer feeds; no browser UI or TLS execution", results }, null, 2));
  } finally {
    for (const provider of providers) { provider.close(); provider.doc.destroy(); }
    sockets.forEach(socket => socket.terminate());
    for (const close of closes.reverse()) await close();
    await Promise.allSettled(upgrades);
    await active?.close(); deployment.storage.close(); ownerDoc.destroy();
  }
  } finally {
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 120000);
