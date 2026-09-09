import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
import { Client, Pool } from "pg";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
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
import { createNamedLiveRelayRoute, namedLiveGatewayRequest } from "./namedLiveRelayRoute.js";
import { createNamedLiveBrowserTransport, type NamedLiveBrowserState } from "@dohc/ydoc-projection/named-live-browser-transport";

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

const harness = vi.hoisted(() => ({
  relayUrl: "", holdAdoption: true, committed: undefined as undefined | (() => void),
  transforms: [] as {from: string; to: string; insecureLoopbackForTests: true}[],
  captures: [] as {activationId: string; requestedActivationId?: string; source: unknown}[],
}));
vi.mock("../../../packages/workspace-engine-client/src/daemon/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../packages/workspace-engine-client/src/daemon/index.js")>();
  return {...actual, createEngineClient: async (options: Parameters<typeof actual.createEngineClient>[0]) => {
    const configPath = options.env?.DOHC_ENGINE_LIVE_HOST_CONFIG;
    if (configPath) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const destination = new URL(harness.relayUrl);
      expect(destination.protocol).toBe("http:"); expect(destination.hostname).toBe("127.0.0.1");
      expect(destination.username + destination.password + destination.search + destination.hash).toBe("");
      for (const workspace of config.workspaces) {
        expect(workspace.relay.baseUrl).toBe("https://service-activation-relay.example.test");
        harness.transforms.push({from: workspace.relay.baseUrl, to: destination.origin, insecureLoopbackForTests: true});
        workspace.relay = {...workspace.relay, baseUrl: destination.origin, allowInsecureLoopbackForTests: true};
      }
      writeFileSync(configPath, JSON.stringify(config));
    }
    const client = await actual.createEngineClient(options);
    if (!configPath) return client;
    const capture = client.captureOwnerActivation.bind(client), adopt = client.sendLiveOwnerAdoption.bind(client);
    return new Proxy(client, {get(target, property) {
      if (property === "captureOwnerActivation") return async (...args: Parameters<typeof capture>) => {
        const result = await capture(...args);
        harness.captures.push({activationId: result.activationId, requestedActivationId: args[4], source: result.source});
        return result;
      };
      if (property === "sendLiveOwnerAdoption") return async (...args: Parameters<typeof adopt>) => {
        const result = await adopt(...args);
        if (harness.holdAdoption) {
          harness.holdAdoption = false;
          harness.committed?.();
          const signal = args[3]!;
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {reject(signal.reason); return;}
            signal.addEventListener("abort", () => reject(signal.reason), {once: true});
          });
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
  }};
});

it("resumes a real configured service activation after a lost native adoption reply and publishes a named edit", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned service activation binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit Postgres proof inputs are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, {recursive: true});
  const root = mkdtempSync(join(resolve(output), "service-activation-")), workspace = join(root, "service"), ownerRoot = join(root, "owner");
  mkdirSync(workspace); mkdirSync(ownerRoot);
  const schema = `service_activation_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({connectionString, connectionTimeoutMillis: 5000});
  const pool = new Pool({connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000});
  let schemaCreated = false, active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  let owner: Awaited<ReturnType<typeof createEngineClient>> | undefined;
  let deployment: ReturnType<typeof openRelayDeployment> | undefined;
  const closes: (() => Promise<void>)[] = [], sockets: WebSocket[] = [], providers: Provider[] = [], upgrades: Promise<void>[] = [];
  const ownerDoc = markdownToYDoc("Hello"), results: Record<string, unknown> = {};
  try {
    await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await pool.query(readFileSync(new URL("../../../packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url), "utf8"));
    const authOptions = {pool, baseURL: "https://auth.example.test", secret: "service-activation-proof-secret-at-least-32-characters", trustedOrigins: [audience], sendEmail: async () => undefined};
    const auth = createWorkspaceAuth(authOptions), relayAuth = createWorkspaceAuth(authOptions), password = "service-activation-proof-password";
    const ownerUser = (await auth.api.signUpEmail({body: {email: "owner@example.test", password, name: "Owner"}})).user;
    const namedUser = (await auth.api.signUpEmail({body: {email: "named@example.test", password, name: "Named"}})).user;
    const bearer = (await auth.api.signInEmail({body: {email: ownerUser.email, password}})).token;
    const authHttp = serveFetchHandler({handler: request => auth.handler(request), maxBodyBytes: () => 8192, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    authHttp.listen(0, "127.0.0.1"); await once(authHttp, "listening");
    closes.push(() => new Promise<void>(done => authHttp.close(() => done())));
    const authUrl = `http://127.0.0.1:${(authHttp.address() as {port: number}).port}`;
    const configPath = join(root, "deployment.json");
    initializeRelayDeployment({configPath, relayPath: join(root, "relay/relay.sqlite"), continuityDirectory: join(root, "continuity")});
    deployment = openRelayDeployment(configPath, {liveTickets: {retainedTicketsPerPrincipalGrant: 4, expiredTicketCleanupBatchSize: 2, now: Date.now}});
    const relayRead = new DatabaseSync(join(root, "relay/relay.sqlite"), {readOnly: true});
    closes.push(async () => relayRead.close());
    const {storage, history} = deployment, frameChanges = createNamedFrameChanges(16), validate = createLiveMarkdownJournalValidator(validationPolicy);
    let routes: ReturnType<typeof createNamedLiveRoutes> | undefined;
    const relayApp = createSyncRelayHandler({storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey, resolveActor: createSessionActorResolver(relayAuth),
      namedBrowserSessionLimits: {...browserLimits, maxSessions: 4, retentionMs: 120000}, ownerRestoreHost: () => active});
    const relayHttp = serveFetchHandler({handler: request => new URL(request.url).pathname === "/sync/live/named-tickets" ? routes!.handle(request) : relayApp(request),
      maxBodyBytes: () => 8_000_000, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`;
    harness.relayUrl = relayUrl;
    owner = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30000,
      env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: undefined}});
    let requestId = 1;
    const opened = await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId: "workspace", captureMode: "none",
      relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000});
    const handle = (opened.result as {workspace: string}).workspace;
    async function rpc(method: string, params: Record<string, any>) {
      return (await owner!.sendRequest({id: requestId++, workspace: handle, method, params, deadlineMs: 30000})).result as Record<string, any>;
    }
    results.claim = await rpc("sync.claim", {workspaceId: "workspace"});
    const mainVersionId = (await rpc("versions.ensureMain", {})).id as string;
    const written = await rpc("versionedText.write", {workspaceId: "workspace", versionId: mainVersionId, path: "docs/a.md", text: "Hello", origin: "api", requestId: randomUUID()});
    const objectId = written.object.id as string;
    expect(typeof objectId).toBe("string");
    const editor = await rpc("ydoc.open", {versionId: mainVersionId, path: "docs/a.md", expectedObjectId: objectId, contentKind: "richdoc"});
    expect(editor.seedContent).toBe("Hello");
    const baseline = Y.encodeStateAsUpdate(ownerDoc), lineageClaimId = hash(baseline), document = {workspaceId: "workspace", mainVersionId, objectId, lineageClaimId};
    await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(baseline).toString("base64"), seed: true});
    const vector = Y.encodeStateVector(ownerDoc); ownerDoc.getMap("frontmatter").set("beforeActivation", "ordinary-owner");
    await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(Y.encodeStateAsUpdate(ownerDoc, vector)).toString("base64")});
    await rpc("ydoc.settle", {sessionId: editor.sessionId}); await rpc("ydoc.close", {sessionId: editor.sessionId});
    results.initialPush = await rpc("sync.push", {workspaceId: "workspace"});
    expect(storage.workspaceIsOwnedBy("workspace", ownerUser.id)).toBe(true);
    expect(relayRead.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_documents").get()!.count).toBe(0);
    storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: ownerUser.id, selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: Date.now()},
      grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: namedUser.id, principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null}});
    expect(storage.provisionLiveHostControl({mode: "service", hostId: "service", updatedAtMs: Date.now(), guard: storage.captureStanding()}).ok).toBe(true);
    const identity = storage.getWorkspaceBootstrap("workspace").identity, serviceConfig = join(root, "service.json");
    if (!identity) throw new Error("Ordinary source owner did not establish a relay identity.");
    writeFileSync(serviceConfig, JSON.stringify({version: 1, engineExecutable: executable, hostId: "service", instanceId: "instance",
      workspaces: [{root: workspace, workspaceId: "workspace", maxRegistrations: 2, ordinaryReplication: {relay: {baseUrl: "https://service-activation-relay.example.test", bearerToken: bearer},
        identity: {kind: "join", replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity}, maxPagesPerPull: 8}}],
      settlement: {maxApplicationsPerSettlement: 8}, adoption: {maxBytes: 1_000_000, maxEvents: 100, ownerOutbox: {maxPendingBytes: 1_000_000, maxPendingAgeMs: 600000}},
      sync: {policy: {maxClientVectorBytes: 100000, maxHostVectorBytes: 100000, maxOutputBytes: 1_000_000, maxReadBytes: 4_000_000}, workingReserveBytes: 4_000_000},
      activation: {targets: [{workspaceId: "workspace", path: "docs/a.md", shareId: "share"}], validation: validationPolicy, maxCaptureBytes: 1_000_000, maxEntriesPerDrain: 8,
        maxBytesPerDrain: 1_000_000, maxDocumentsPerPass: 1, pollIntervalMs: 100, passDeadlineMs: 30000},
      ingress: {aggregateBytes: 400_000_000, applicationWorkingReserveBytes: 1_000_000, maxUploads: 4, uploadDeadlineMs: 30000},
      client: {aggregateBytes: 200_000_000, maxUploads: 4, connectTimeoutMs: 30000, requestDeadlineMs: 30000}}));
    let committed!: () => void; const adoptionCommitted = new Promise<void>(resolve => {committed = resolve;}); harness.committed = committed;
    active = await startServiceLiveHost({configPath: serviceConfig, storage, history, frameChanges});
    await adoptionCommitted;
    const pending = storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)!;
    expect(pending).not.toBeNull(); expect(pending.completed).toBe(false);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(ownerDoc));
    const firstConnectionId = active.coordinate.connectionId;
    await active.close(); active = undefined;
    expect(storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)!.activationId).toBe(pending.activationId);
    active = await startServiceLiveHost({configPath: serviceConfig, storage, history, frameChanges});
    expect(active.coordinate.connectionId).not.toBe(firstConnectionId);
    await vi.waitFor(() => expect(storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)?.completed).toBe(true), {timeout: 30000});
    const completed = storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)!;
    expect(completed.activationId).toBe(pending.activationId); expect(completed.source).toEqual(pending.source);
    expect(harness.captures.filter(row => row.requestedActivationId === pending.activationId).length).toBeGreaterThan(0);
    expect(new Set(harness.captures.map(row => row.activationId))).toEqual(new Set([pending.activationId]));
    results.activation = {activationId: pending.activationId, source: pending.source, resumedConnectionId: active.coordinate.connectionId, firstConnectionId, completed: true};
    const captureNative = (...args: Parameters<NonNullable<typeof active>["captureNative"]>) => active!.captureNative(...args);
    const tickets = createLiveTickets({storage, audience, key: ticketKey, hostReports: createLiveHostReports({storage, captureNative})});
    routes = createNamedLiveRoutes({kind: "named", storage, hosts: new Set([new URL(relayUrl).host]), publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: {maxClientVectorBytes: 100000, maxSyncOutputBytes: 1_000_000, maxAppliedUpdateBytes: 1_000_000, maxSubmissionBytes: 1_000_000, maxAdmissionBytes: 4_000_000},
      validate, sessions: {resolve: relayApp.resolveNamedBrowserSession}, tickets, captureNative});
    closes.push(async () => routes!.close());
    relayHttp.on("upgrade", (request, socket, head) => {upgrades.push(routes!.handleUpgrade(request, socket, head));});
    const application = createShareWebApplication({relayUrl, publicRelayUrl: audience, relayExchangeKey: exchangeKey, publicHosts: new Set([new URL(audience).host]),
      accountAuth: {publicOrigin: audience, upstreamUrl: authUrl}, namedBrowserSessionLimits: browserLimits, namedLiveTickets: true});
    const gateway = createLiveGateway({publicOrigin: audience, publicHosts: new Set([new URL(audience).host]),
      limits: {maxConnections: 4, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4, maxFrameBytes: 65536, maxPendingBytes: 2_000_000,
        maxPendingFrames: 64, maxFragments: 8, maxBufferedChunks: 64, upgradeTimeoutMs: 30000, idleTimeoutMs: 60000, drainTimeoutMs: 1000},
      resolveSession: async (request, discriminator, signal) => {const authenticated = namedLiveGatewayRequest(request, audience, signal); return authenticated ? application.resolveNamedBrowserSession(authenticated, discriminator) : null;},
      openHostRoute: createNamedLiveRelayRoute({relayUrl, publicOrigin: audience, exchangeKey, handshakeTimeoutMs: 30000})});
    const publicHttp = serveFetchHandler({handler: application.handle, maxBodyBytes: () => 8192, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    publicHttp.on("upgrade", (request, socket, head) => {upgrades.push(gateway.handleUpgrade(request, socket, head));});
    publicHttp.listen(0, "127.0.0.1"); await once(publicHttp, "listening");
    closes.push(() => new Promise<void>(done => publicHttp.close(() => done()))); closes.push(async () => gateway.close());
    const port = (publicHttp.address() as {port: number}).port;
    const signedIn = await browserRequest(port, "/api/account/sign-in", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({email: namedUser.email, password})});
    expect(signedIn.status).toBe(200);
    const cookieName = getCookies({baseURL: audience}).sessionToken.name, cookieLine = signedIn.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`))!;
    expect(parseSetCookieHeader(cookieLine).get(cookieName)).toMatchObject({secure: true, httponly: true, samesite: "lax"});
    const cookie = cookieLine.split(";", 1)[0]!;
    const manager = createNamedLiveBrowserTransport({publicOrigin: audience,
      limits: {provider: {frames, maxPendingUpdateBytes: 2_000_000, maxPendingUpdates: 4, maxDeliveryAttempts: 3}, maxHttpResponseBytes: 8192, maxSocketBufferedBytes: 2_000_000, connectTimeoutMs: 30000, sendTimeoutMs: 30000, drainPollMs: 10},
      fetch: (input, init) => {const url = new URL(input instanceof Request ? input.url : input.toString()); expect(url.origin).toBe(audience); return browserRequest(port, url.pathname + url.search, init, cookie);},
      openSocket: (input, protocols) => {const url = new URL(input); expect(url.origin).toBe(audience.replace("https:", "wss:"));
        const socket = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, protocols, {headers: {host: new URL(audience).host, origin: audience, cookie}, perMessageDeflate: false});
        sockets.push(socket); socket.on("error", () => undefined); socket.once("unexpected-response", (_request, response) => {response.resume(); socket.terminate();}); return socket as unknown as BrowserSocket;}});
    const provider = manager.select({accountId: namedUser.id, workspaceId: "workspace", grantId: "grant", objectId}); providers.push(provider);
    await provider.reconnect(); await stateWhen(provider, state => state.status === "live");
    expect(yDocToMarkdown(provider.doc)).toBe(yDocToMarkdown(ownerDoc));
    const beforeNamedCursor = provider.state().lastApplied?.journalCursor ?? 0;
    expect(provider.edit(() => provider.doc.getMap("frontmatter").set("named", "after-service-resume"))).toBe(true);
    const ack = (await stateWhen(provider, state => (state.lastApplied?.journalCursor ?? 0) > beforeNamedCursor && state.pendingUpdates === 0)).lastApplied!;
    results.namedAck = ack;
    const binding = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: ownerUser.id, shareId: "share"}});
    if (binding.kind !== "current") throw new Error("Activated binding is unavailable.");
    const capture = await active.captureNative(binding.binding);
    expect(await capture.client.readLiveApplicationAck({id: capture.nextRequestId(), workspace: capture.workspace, registrationId: capture.registrationId, deadlineMs: capture.deadlineMs},
      {deliveryId: ack.deliveryId, updateDigest: ack.updateDigest})).toEqual(ack);
    const settled = await active.settle(document);
    const expected = yDocToMarkdown(provider.doc); expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(expected);
    await vi.waitFor(() => {
      const rows = relayRead.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append' ORDER BY relay_seq DESC").all("workspace");
      expect(rows.some(row => JSON.parse(String(row.payload_json)).payloadAfterBlobSha256 === hash(Buffer.from(expected)))).toBe(true);
    }, {timeout: 30000});
    for (let page = 0; page < 8; page++) {
      const pulled = await rpc("sync.pull", {workspaceId: "workspace"}); expect(pulled.refusals ?? []).toEqual([]);
      if (pulled.pendingCursor) await rpc("sync.commitCursor", {workspaceId: "workspace", pendingCursor: pulled.pendingCursor});
      if (!pulled.hasMore) break;
      if (page === 7) throw new Error("Owner pull exceeded its eight-page bound.");
    }
    expect((await rpc("versionedText.read", {versionId: mainVersionId, path: "docs/a.md"})).text).toBe(expected);
    results.settledAndPublished = {settled, markdownDigest: hash(Buffer.from(expected)), ordinaryOwnerReadMatched: true};
    provider.close(); provider.doc.destroy(); providers.length = 0;
    await active.close(); active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {results.persistedApplications = engine.prepare("SELECT delivery_id,update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(results.persistedApplications).toEqual(expect.arrayContaining([{delivery_id: ack.deliveryId, update_digest: ack.updateDigest}]));
    } finally {engine.close();}
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
      scope: "Cold native ordinary import, real configured service activation, native adoption committed with reply withheld until shutdown, retained-source restart, real named cookie/ticket/WS edit, native ACK, settlement and ordinary publication.",
      omitted: ["TLS transport", "browser UI", "restore cutover"], harness: {transforms: harness.transforms, captures: harness.captures}, results}, null, 2));
  } finally {
    for (const provider of providers) {provider.close(); provider.doc.destroy();}
    sockets.forEach(socket => socket.terminate());
    const errors: unknown[] = [];
    try {await active?.close();} catch (error) {errors.push(error);}
    if (owner) {owner.close(); try {await owner.waitForExit();} catch (error) {errors.push(error);}}
    for (const close of closes.reverse()) try {await close();} catch (error) {errors.push(error);}
    await Promise.allSettled(upgrades);
    deployment?.storage.close(); ownerDoc.destroy();
    await pool.end(); if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
    if (errors.length) throw new AggregateError(errors, "Service activation proof cleanup failed.");
  }
}, 120000);
