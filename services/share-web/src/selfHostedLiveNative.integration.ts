import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import {startSelfHostedLiveHost} from "../../sync-relay/src/selfHostedLiveHost.js";
import {authorizeServiceHostReplication} from "../../sync-relay/src/serviceHostCredential.js";
import {createServiceHostReplication} from "../../sync-relay/src/serviceHostReplication.js";
import {createServiceHostEnrollmentRoutes} from "../../sync-relay/src/serviceHostEnrollmentRoutes.js";
import {selfHostLiveProfile} from "../../sync-relay/src/selfHostLiveProfile.js";
import { createSyncRelayHandler } from "../../sync-relay/src/server.js";
import { createNamedLiveRoutes, createOwnerLiveRoutes } from "../../sync-relay/src/namedLiveRoutes.js";
import {runNativeOwnerDeliveryPass} from "../../../apps/desktop/src/workspaces/nativeOwnerDelivery.js";
import {readyOwnerDeliveryDocuments} from "../../../apps/desktop/src/workspaces/serverOwnerDelivery.js";
import { createLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLiveHostReports } from "../../sync-relay/src/namedLiveHostReports.js";
import { createNamedFrameChanges } from "../../sync-relay/src/liveHostChanges.js";
import { createShareWebApplication } from "./server.js";
import { createLiveGateway } from "./liveGateway.js";
import { createNamedLiveRelayRoute, namedLiveGatewayRequest } from "./namedLiveRelayRoute.js";
import { createNamedLiveBrowserTransport, type NamedLiveBrowserState } from "@dohc/ydoc-projection/named-live-browser-transport";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const profile = selfHostLiveProfile();
const frames = profile.frames, browserLimits = profile.requests, routeLimits = profile.namedLive.transport;
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
  failed: undefined as undefined | ((error: Error) => void),
  transforms: [] as {from: string; to: string; insecureLoopbackForTests: true}[],
  captures: [] as {activationId: string; requestedActivationId?: string; source: unknown}[],
  tracePath: "", calls: [] as {method: string; status: "started" | "complete" | "failed"; message?: string; code?: string}[],
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
    async function trace<T>(method: string, operation: () => Promise<T>): Promise<T> {
      const record = (status: "started" | "complete" | "failed", error?: unknown) => {
        const wire = error as {wireError?: {code?: string}; code?: string} | undefined;
        harness.calls.push({method, status, ...(error instanceof Error ? {message: error.message, code: wire?.wireError?.code ?? wire?.code ?? ""} : {})});
        writeFileSync(harness.tracePath, JSON.stringify({calls: harness.calls, transforms: harness.transforms, captures: harness.captures}, null, 2));
      };
      record("started");
      try {const result = await operation(); record("complete"); return result;}
      catch (error) {
        record("failed", error);
        const wire = (error as {wireError?: {code: string; retry: string}})?.wireError;
        if (wire && wire.retry !== "afterBackoff") harness.failed?.(new Error(`Service activation RPC ${method} failed: ${wire.code}`, {cause: error}));
        throw error;
      }
    }
    return new Proxy(client, {get(target, property) {
      if (property === "sendRequest") return (...args: Parameters<typeof client.sendRequest>) => trace(args[0].method, () => client.sendRequest(...args));
      if (property === "captureOwnerActivation") return async (...args: Parameters<typeof capture>) => {
        const result = await trace("captureOwnerActivation", () => capture(...args));
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

it("enrolls a self-hosted document, resumes native activation, and publishes owner and named edits", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned service activation binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit Postgres proof inputs are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, {recursive: true});
  const root = mkdtempSync(join(resolve(output), "self-host-live-")), hostRoot = join(root, "service"), ownerRoot = join(root, "owner");
  let workspace = hostRoot;
  harness.tracePath = join(root, "service-rpc-trace.json");
  mkdirSync(workspace); mkdirSync(ownerRoot);
  mkdirSync(join(ownerRoot, "docs")); writeFileSync(join(ownerRoot, "docs/a.md"), "Hello");
  const schema = `service_activation_${randomUUID().replaceAll("-", "")}`;
  // The full gate once timed out a 2 s connect to a healthy Postgres (#1217).
  const admin = new Client({connectionString, connectionTimeoutMillis: 30_000});
  const pool = new Pool({connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 30_000});
  let schemaCreated = false, active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  let supervisor: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  let enrollment: ReturnType<typeof createServiceHostEnrollmentRoutes> | undefined;
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
    const profile = selfHostLiveProfile();
    const {storage, history} = deployment, frameChanges = createNamedFrameChanges(profile.namedLive.maxListeners), validate = createLiveMarkdownJournalValidator(profile.validation);
    const resolveActor = createSessionActorResolver(relayAuth);
    const serviceReplication = createServiceHostReplication({storage, prefix: "dohc-service-v1.",
      authorize: input => authorizeServiceHostReplication(storage, {key: Buffer.from(ticketKey), namespace: history.namespace, ...input})});
    let routes: ReturnType<typeof createNamedLiveRoutes> | undefined;
    const relayApp = createSyncRelayHandler({storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey, resolveActor: createSessionActorResolver(relayAuth),
      namedBrowserSessionLimits: profile.browserSessions, ownerRestoreHost: () => active});
    const relayHttp = serveFetchHandler({handler: request => request.headers.get("authorization")?.startsWith("Bearer dohc-service-v1.") ? serviceReplication(request)
      : new URL(request.url).pathname.endsWith("/live-host") ? enrollment!(request)
      : new URL(request.url).pathname === "/sync/live/named-tickets" ? routes!.handle(request) : relayApp(request),
      maxBodyBytes: () => 8_000_000, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`;
    harness.relayUrl = relayUrl;
    const ownerConfigPath = join(root, "owner-ingress.json");
    writeFileSync(ownerConfigPath, JSON.stringify(profile.nativeIngress));
    owner = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30000,
      onStderr: value => appendFileSync(join(root, "owner-stderr.log"), value),
      privateLiveApplication: profile.nativeClient,
      env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: ownerConfigPath}});
    let requestId = 1;
    const opened = await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId: "workspace", captureMode: "none",
      relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000});
    let handle = (opened.result as {workspace: string}).workspace;
    async function rpc(method: string, params: Record<string, any>) {
      try {return (await owner!.sendRequest({id: requestId++, workspace: handle, method, params, deadlineMs: 30000})).result as Record<string, any>;}
      catch (cause) {throw new Error(`Service proof source RPC failed: ${method}`, {cause});}
    }
    results.claim = await rpc("sync.claim", {workspaceId: "workspace"});
    const mainVersionId = (await rpc("versions.ensureMain", {})).id as string;
    async function push() {
      const pages: Record<string, any>[] = [];
      for (let page = 0; page < 8; page++) {
        const result = await rpc("sync.push", {workspaceId: "workspace"});
        pages.push(result);
        expect(result.status).toBe("complete");
        expect(result.refusals).toEqual([]);
        expect(result.sharingDeclined).toEqual([]);
        expect(result.ownerAdmissionPending).toEqual([]);
        if (!result.hasMore) return pages;
      }
      throw new Error("Owner push exceeded its eight-page bound.");
    }
    results.ownerEnrollmentPush = await push();
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
    results.initialPush = await push();
    expect(storage.workspaceIsOwnedBy("workspace", ownerUser.id)).toBe(true);
    expect(relayRead.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_documents").get()!.count).toBe(0);
    storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: ownerUser.id, selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: Date.now()},
      grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: namedUser.id, principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null}});
    const identity = storage.getWorkspaceBootstrap("workspace").identity;
    if (!identity) throw new Error("Ordinary source owner did not establish a relay identity.");
    workspace = join(hostRoot, hash(Buffer.from(JSON.stringify([history.namespace, "workspace", identity.replicationEpoch, identity.streamIdentity]))));
    async function startSupervisor() {
      supervisor = await startSelfHostedLiveHost({storage, history, frameChanges, root: hostRoot, engineExecutable: executable!,
        relayOrigin: "https://service-activation-relay.example.test", key: Buffer.from(ticketKey), onError: error => {harness.failed?.(error instanceof Error ? error : new Error(String(error)));}});
      enrollment = createServiceHostEnrollmentRoutes({storage, history, host: supervisor, resolveActor});
      await vi.waitFor(() => {active = supervisor!.current(); expect(active).toBeDefined();}, {timeout: 30000});
    }
    let committed!: () => void; const adoptionCommitted = new Promise<void>(resolve => {committed = resolve;}); harness.committed = committed;
    const activationFailed = new Promise<Error>(resolve => {harness.failed = resolve;});
    await startSupervisor();
    const activationOutcome = await Promise.race([adoptionCommitted, activationFailed]);
    if (activationOutcome instanceof Error) throw activationOutcome;
    const pending = storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)!;
    expect(pending).not.toBeNull(); expect(pending.completed).toBe(false);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(ownerDoc));
    const firstConnectionId = active!.coordinate.connectionId;
    await supervisor!.close(); supervisor = undefined; active = undefined;
    expect(storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)!.activationId).toBe(pending.activationId);
    await startSupervisor();
    expect(active!.coordinate.connectionId).not.toBe(firstConnectionId);
    await vi.waitFor(() => expect(storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)?.completed).toBe(true), {timeout: 30000});
    const completed = storage.createServiceActivationStore(history).read("workspace", "docs/a.md", 1_000_000)!;
    expect(completed.activationId).toBe(pending.activationId); expect(completed.source).toEqual(pending.source);
    expect(harness.captures.filter(row => row.requestedActivationId === pending.activationId).length).toBeGreaterThan(0);
    expect(new Set(harness.captures.map(row => row.activationId))).toEqual(new Set([pending.activationId]));
    results.activation = {activationId: pending.activationId, source: pending.source, resumedConnectionId: active!.coordinate.connectionId, firstConnectionId, completed: true};
    const captureNative = (...args: Parameters<NonNullable<typeof active>["captureNative"]>) => active!.captureNative(...args);
    const tickets = createLiveTickets({storage, audience, key: ticketKey, hostReports: createLiveHostReports({storage, captureNative})});
    routes = createNamedLiveRoutes({kind: "named", storage, hosts: new Set([new URL(relayUrl).host]), publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: profile.namedLive.host,
      validate, sessions: {resolve: relayApp.resolveNamedBrowserSession}, tickets, captureNative});
    closes.push(async () => routes!.close());
    const ownerRoutes = createOwnerLiveRoutes({storage, hosts: new Set([new URL(relayUrl).host]), publicOrigin: audience, exchangeKey,
      frames: profile.frames, limits: profile.namedLive.transport, bounds: profile.namedLive.host, validate, resolveActor, captureNative});
    closes.push(async () => ownerRoutes.close());
    relayHttp.on("upgrade", (request, socket, head) => {upgrades.push(new URL(request.url!, relayUrl).pathname.endsWith("/live/owner")
      ? ownerRoutes.handleUpgrade(request, socket, head) : routes!.handleUpgrade(request, socket, head));});
    const application = createShareWebApplication({relayUrl, publicRelayUrl: audience, relayExchangeKey: exchangeKey, publicHosts: new Set([new URL(audience).host]),
      accountAuth: {publicOrigin: audience, upstreamUrl: authUrl}, namedBrowserSessionLimits: browserLimits, namedLiveTickets: true});
    const gateway = createLiveGateway({publicOrigin: audience, publicHosts: new Set([new URL(audience).host]),
      limits: profile.gateway,
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
      limits: profile.editor,
      fetch: (input, init) => {const url = new URL(input instanceof Request ? input.url : input.toString()); expect(url.origin).toBe(audience); return browserRequest(port, url.pathname + url.search, init, cookie);},
      openSocket: (input, protocols) => {const url = new URL(input); expect(url.origin).toBe(audience.replace("https:", "wss:"));
        const socket = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, protocols, {headers: {host: new URL(audience).host, origin: audience, cookie}, perMessageDeflate: false});
        sockets.push(socket); socket.on("error", () => undefined); socket.once("unexpected-response", (_request, response) => {response.resume(); socket.terminate();}); return socket as unknown as BrowserSocket;}});
    const provider = manager.select({accountId: namedUser.id, workspaceId: "workspace", grantId: "grant", objectId}); providers.push(provider);
    await provider.reconnect(); await stateWhen(provider, state => state.status === "live");
    expect(yDocToMarkdown(provider.doc)).toBe(yDocToMarkdown(ownerDoc));
    const discovered = await fetch(`${relayUrl}/sync/workspace/live-host`, {headers: {authorization: `Bearer ${bearer}`}});
    expect(discovered.status).toBe(200);
    const ownerTarget = readyOwnerDeliveryDocuments(await discovered.json(), "workspace")[0]!;
    expect(ownerTarget).toBeDefined();
    const runOwnerPass = () => runNativeOwnerDeliveryPass({client: owner!, workspaceHandle: handle, document: ownerTarget,
      config: {...profile.owner, nativeConfigPath: ownerConfigPath, relayUrl, documents: [ownerTarget]},
      signal: AbortSignal.timeout(30_000), bearer, assertCurrent() {expect(owner).toBeDefined();}});
    expect(["empty", "acknowledged"]).toContain(await runOwnerPass());
    const nativeRequest = () => ({id: 0, workspace: handle, deadlineMs: 30_000});
    const target = {binding: ownerTarget.binding, relayDatabaseNamespace: ownerTarget.relayDatabaseNamespace};
    const prepared = await owner!.ownerYDocPrepareEnrollment(nativeRequest(), target);
    if (prepared.status !== "observed") throw new Error("Owner delivery did not enroll its native draft.");
    const local = await owner!.ownerYDocOpenDraft(nativeRequest(), {binding: ownerTarget.binding, expectedRevision: prepared.draft.revision});
    const concurrentOwner = new Y.Doc(); Y.applyUpdate(concurrentOwner, local.initialUpdate);
    const beforeOwnerVector = Y.encodeStateVector(concurrentOwner);
    concurrentOwner.getMap("frontmatter").set("ownerConcurrent", "survives-restart");
    await owner!.ownerYDocAppendDraft(nativeRequest(), {binding: ownerTarget.binding, expectedRevision: local.draft.revision,
      appendKey: "self-host-owner-concurrent", updateBytes: Y.encodeStateAsUpdate(concurrentOwner, beforeOwnerVector)});
    concurrentOwner.destroy();
    owner!.close(); await owner!.waitForExit();
    owner = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30000,
      onStderr: value => appendFileSync(join(root, "owner-stderr.log"), value),
      privateLiveApplication: profile.nativeClient,
      env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: ownerConfigPath}});
    const reopenedOwner = await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId: "workspace", captureMode: "none",
      relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000});
    handle = (reopenedOwner.result as {workspace: string}).workspace;
    const beforeNamedCursor = provider.state().lastApplied?.journalCursor ?? 0;
    expect(provider.edit(() => provider.doc.getMap("frontmatter").set("named", "after-service-resume"))).toBe(true);
    const ack = (await stateWhen(provider, state => (state.lastApplied?.journalCursor ?? 0) > beforeNamedCursor && state.pendingUpdates === 0)).lastApplied!;
    results.namedAck = ack;
    expect(await runOwnerPass()).toBe("acknowledged");
    await stateWhen(provider, () => provider.doc.getMap("frontmatter").get("ownerConcurrent") === "survives-restart");
    const beforeIdleCursor = provider.state().lastApplied?.journalCursor ?? 0;
    expect(provider.edit(() => provider.doc.getMap("frontmatter").set("idleOwnerPull", "recipient-only"))).toBe(true);
    const finalAck = (await stateWhen(provider, state => (state.lastApplied?.journalCursor ?? 0) > beforeIdleCursor && state.pendingUpdates === 0)).lastApplied!;
    expect(await runOwnerPass()).toBe("empty");
    const accepted = await owner!.ownerYDocPrepareEnrollment(nativeRequest(), target);
    if (accepted.status !== "observed") throw new Error("Owner draft disappeared after restart.");
    const acceptedDraft = await owner!.ownerYDocOpenDraft(nativeRequest(), {binding: ownerTarget.binding, expectedRevision: accepted.draft.revision});
    const acceptedDoc = new Y.Doc(); Y.applyUpdate(acceptedDoc, acceptedDraft.initialUpdate);
    expect(yDocToMarkdown(acceptedDoc)).toBe(yDocToMarkdown(provider.doc)); acceptedDoc.destroy();
    results.ownerDelivery = {restartPreservedDraft: true, concurrentOwnerAndNamedEditsMerged: true, idleOwnerPulledRecipientEdit: true, finalCursor: finalAck.journalCursor};
    const binding = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: ownerUser.id, shareId: "share"}});
    if (binding.kind !== "current") throw new Error("Activated binding is unavailable.");
    const capture = await active!.captureNative(binding.binding);
    expect(await capture.client.readLiveApplicationAck({id: capture.nextRequestId(), workspace: capture.workspace, registrationId: capture.registrationId, deadlineMs: capture.deadlineMs},
      {deliveryId: ack.deliveryId, updateDigest: ack.updateDigest})).toEqual(ack);
    const settled = await active!.settle(document);
    const expected = yDocToMarkdown(provider.doc); expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(expected);
    await vi.waitFor(() => {
      const rows = relayRead.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='live.audit.settlement' ORDER BY relay_seq DESC").all("workspace");
      expect(rows.some(row => {
        const payload = JSON.parse(String(row.payload_json));
        return payload.record?.binding?.workspaceId === document.workspaceId &&
          payload.record?.binding?.mainVersionId === mainVersionId && payload.record?.binding?.objectId === objectId &&
          payload.record?.binding?.lineageClaimId === lineageClaimId && payload.record?.terminalCursor === finalAck.journalCursor &&
          payload.record?.markdownDigest === hash(Buffer.from(expected));
      })).toBe(true);
    }, {timeout: 30000});
    for (let page = 0; page < 8; page++) {
      const pulled = await rpc("sync.pull", {workspaceId: "workspace"}); expect(pulled.refusals ?? []).toEqual([]);
      if (pulled.pendingCursor) {
        const cursor = {workspaceId: "workspace", pendingCursor: pulled.pendingCursor};
        expect((await rpc("sync.materializePendingCursor", cursor)).materialized).toBe(true);
        expect((await rpc("sync.commitCursor", cursor)).committed).toBe(true);
      }
      if (!pulled.hasMore) break;
      if (page === 7) throw new Error("Owner pull exceeded its eight-page bound.");
    }
    expect((await rpc("versionedText.read", {versionId: mainVersionId, path: "docs/a.md"})).text).toBe(expected);
    expect(readFileSync(join(ownerRoot, "docs/a.md"), "utf8")).toBe(expected);
    results.settledAndPublished = {settled, markdownDigest: hash(Buffer.from(expected)), ordinaryOwnerReadMatched: true};
    provider.close(); provider.doc.destroy(); providers.length = 0;
    await supervisor!.close(); supervisor = undefined; active = undefined;
    const engine = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {results.persistedApplications = engine.prepare("SELECT delivery_id,update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(results.persistedApplications).toEqual(expect.arrayContaining([{delivery_id: ack.deliveryId, update_digest: ack.updateDigest}]));
    } finally {engine.close();}
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
      scope: "Default self-host profile, scoped replication credentials, automatic discovery, native cold import and adoption-reply-loss recovery, service restart, owner draft restart, concurrent named and owner edits, idle owner receive, native acknowledgements, settlement and ordinary publication.",
      omitted: ["TLS transport", "browser UI", "restore cutover"], harness: {transforms: harness.transforms, captures: harness.captures}, results}, null, 2));
  } finally {
    for (const provider of providers) {provider.close(); provider.doc.destroy();}
    sockets.forEach(socket => socket.terminate());
    const errors: unknown[] = [];
    try {await supervisor?.close();} catch (error) {errors.push(error);}
    if (owner) {owner.close(); try {await owner.waitForExit();} catch (error) {errors.push(error);}}
    for (const close of closes.reverse()) try {await close();} catch (error) {errors.push(error);}
    await Promise.allSettled(upgrades);
    deployment?.storage.close(); ownerDoc.destroy();
    await pool.end(); if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
    if (errors.length) throw new AggregateError(errors, "Service activation proof cleanup failed.");
  }
}, 120000);
