import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
import { Client, Pool } from "pg";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createLiveValidationExecutor } from "../../sync-relay/src/liveValidation.js";
import { createEngineClient } from "../../../packages/workspace-engine-client/src/daemon/engineClient.js";
import { YdocLiveAdapter } from "../../../packages/workspace-engine-client/src/ydoc/ydocLiveAdapter.js";
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
import { captureNamedLiveFrameHost, captureOwnerLiveFrameHost } from "../../sync-relay/src/namedLiveFrameHost.js";
import { liveBrowserActor } from "../../sync-relay/src/liveBrowserContext.js";
import type { LiveAuthorContext } from "@dohc/live-session-contract/live-authorship";
import {runNativeOwnerDeliveryPass} from "../../../apps/desktop/src/workspaces/nativeOwnerDelivery.js";
import {readyOwnerDeliveryDocuments} from "../../../apps/desktop/src/workspaces/serverOwnerDelivery.js";
import { createLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLinkLiveHttp } from "../../sync-relay/src/linkLiveHttp.js";
import { hashLinkBearer } from "../../sync-relay/src/linkSecurity.js";
import { linkRefusalBody } from "@dohc/security-contract/link-refusal";
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
  // A reply the engine sent that its caller never receives: the first one for `method` that `when` accepts.
  // The service host runs one engine request at a time, so it waits until the daemon stops.
  withhold: undefined as undefined | {method: string; when(result: Record<string, any>): boolean; held(result: Record<string, any>): void},
  // The reply to the next live application the engine completes, held until `release` or until its caller gives up.
  holdApplication: undefined as undefined | {applied(): void; release: Promise<void>},
  // Methods whose requests fail before they reach the engine.
  unreachable: new Set<string>(),
  // While set, each push is answered as though nothing were left to push, and never reaches the engine.
  unpublished: false,
  // The service host's hosted pull replies, in order.
  pulls: [] as Record<string, any>[],
  // The engine's replies to releasing a retiring activation, in order, including one withheld.
  releases: [] as Record<string, any>[],
  transforms: [] as {from: string; to: string; insecureLoopbackForTests: true}[],
  captures: [] as {activationId: string; requestedActivationId?: string; source: unknown}[],
  tracePath: "", calls: [] as {method: string; status: "started" | "complete" | "failed"; message?: string; code?: string}[],
}));
vi.mock("../../../packages/workspace-engine-client/src/daemon/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../packages/workspace-engine-client/src/daemon/index.js")>();
  return {...actual, createEngineClient: async (options: Parameters<typeof actual.createEngineClient>[0]) => {
    const configPath = options.env?.DOHC_ENGINE_LIVE_HOST_CONFIG;
    // The service host starts empty and attaches each workspace with its relay, so the loopback rewrite applies to the attach request.
    const loopback = (workspace: {relay: {baseUrl: string}}) => {
      const destination = new URL(harness.relayUrl);
      expect(destination.protocol).toBe("http:"); expect(destination.hostname).toBe("127.0.0.1");
      expect(destination.username + destination.password + destination.search + destination.hash).toBe("");
      expect(workspace.relay.baseUrl).toBe("https://service-activation-relay.example.test");
      harness.transforms.push({from: workspace.relay.baseUrl, to: destination.origin, insecureLoopbackForTests: true});
      return {...workspace, relay: {...workspace.relay, baseUrl: destination.origin, allowInsecureLoopbackForTests: true}};
    };
    // A held reply or request waits until its caller gives up, as a lost one does.
    const untilAborted = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason); return;}
      signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
    });
    if (configPath) expect(JSON.parse(readFileSync(configPath, "utf8")).workspaces).toEqual([]);
    const client = await actual.createEngineClient(options);
    if (!configPath) return client;
    const capture = client.captureOwnerActivation.bind(client), adopt = client.sendLiveOwnerAdoption.bind(client), apply = client.sendLiveApplication.bind(client);
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
      if (property === "sendRequest") return async (...args: Parameters<typeof client.sendRequest>) => {
        const method = args[0].method;
        if (method === "liveApplication.attachWorkspace") args[0] = {...args[0], params: loopback(args[0].params as {relay: {baseUrl: string}})};
        const response = await trace(method, async () => {
          if (harness.unreachable.has(method)) throw new Error(`${method} did not reach the engine.`);
          if (harness.unpublished && method === "sync.push") {
            return {id: args[0].id, result: {status: "complete", pushed: 0, hasMore: false, ownerAdmissionPending: [], sharingDeclined: []}};
          }
          return client.sendRequest(...args);
        });
        const result = response.result as Record<string, any>, withheld = harness.withhold;
        if (method === "sync.pullHosted") harness.pulls.push(result);
        if (method === "liveApplication.releaseActivation") harness.releases.push(result);
        if (withheld?.method === method && withheld.when(result)) {
          harness.withhold = undefined;
          withheld.held(result);
          await untilAborted(args[1]);
        }
        return response;
      };
      if (property === "captureOwnerActivation") return async (...args: Parameters<typeof capture>) => {
        const result = await trace("captureOwnerActivation", () => capture(...args));
        harness.captures.push({activationId: result.activationId, requestedActivationId: args[4], source: result.source});
        return result;
      };
      if (property === "sendLiveApplication") return async (...args: Parameters<typeof apply>) => {
        const result = await trace("sendLiveApplication", () => apply(...args)), held = harness.holdApplication;
        if (held) {
          harness.holdApplication = undefined;
          held.applied();
          await Promise.race([held.release, untilAborted(args[2])]);
        }
        return result;
      };
      if (property === "sendLiveOwnerAdoption") return async (...args: Parameters<typeof adopt>) => {
        const result = await adopt(...args);
        if (harness.holdAdoption) {
          harness.holdAdoption = false;
          harness.committed?.();
          await untilAborted(args[3]!);
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
  }};
});

function proofInputs() {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned service activation binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit Postgres proof inputs are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, {recursive: true});
  return {executable, expectedHash, output, connectionString};
}

it("enrolls a self-hosted document, resumes native activation, and publishes owner and named edits", async () => {
  const {executable, expectedHash, output, connectionString} = proofInputs();
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
  let peer: Awaited<ReturnType<typeof createEngineClient>> | undefined;
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
    const validation = createLiveValidationExecutor();
    closes.push(() => validation.close());
    const {storage, history} = deployment, frameChanges = createNamedFrameChanges(profile.namedLive.maxListeners), validate = validation.validator(profile.validation);
    const resolveActor = createSessionActorResolver(relayAuth);
    const serviceReplication = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true,
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
    async function rpc(method: string, params: Record<string, any>, idempotencyKey?: string) {
      try {return (await owner!.sendRequest({id: requestId++, workspace: handle, method, params, deadlineMs: 30000,
        ...(idempotencyKey === undefined ? {} : {idempotencyKey})})).result as Record<string, any>;}
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
    const written = await rpc("versionedText.write", {workspaceId: "workspace", versionId: mainVersionId, path: "docs/a.md", text: "Hello", origin: "api"}, randomUUID());
    const objectId = written.object.id as string;
    expect(typeof objectId).toBe("string");
    const editor = await rpc("ydoc.open", {versionId: mainVersionId, path: "docs/a.md", expectedObjectId: objectId, contentKind: "richdoc"});
    expect(editor.seedContent).toBe("Hello");
    const baseline = Y.encodeStateAsUpdate(ownerDoc), lineageClaimId = hash(baseline), document = {workspaceId: "workspace", mainVersionId, objectId, lineageClaimId};
    const seeded = await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(baseline).toString("base64"), seed: true, expectedLineageClaimId: editor.lineageClaimId});
    const vector = Y.encodeStateVector(ownerDoc); ownerDoc.getMap("frontmatter").set("beforeActivation", "ordinary-owner");
    await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(Y.encodeStateAsUpdate(ownerDoc, vector)).toString("base64"), expectedLineageClaimId: seeded.lineageClaimId});
    await rpc("ydoc.settle", {sessionId: editor.sessionId}); await rpc("ydoc.close", {sessionId: editor.sessionId});
    results.initialPush = await push();
    expect(storage.workspaceIsOwnedBy("workspace", ownerUser.id)).toBe(true);
    expect(relayRead.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_documents").get()!.count).toBe(0);
    storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: ownerUser.id, selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: Date.now()},
      grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: namedUser.id, principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null}});
    const identity = storage.getWorkspaceBootstrap("workspace").identity;
    if (!identity) throw new Error("Ordinary source owner did not establish a relay identity.");
    workspace = join(hostRoot, hash(Buffer.from(JSON.stringify(["hosted-v1", history.namespace, "workspace", identity.replicationEpoch, identity.streamIdentity]))));
    async function startSupervisor() {
      supervisor = await startSelfHostedLiveHost({trustedAccount: (accountId: string) => ({accountId, name: accountId}), storage, history, frameChanges, root: hostRoot, engineExecutable: executable!,
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
    const browserTransport = (recordingContext?: () => LiveAuthorContext) => createNamedLiveBrowserTransport({publicOrigin: audience,
      ...(recordingContext ? {recordingContext} : {}),
      limits: profile.editor,
      fetch: (input, init) => {const url = new URL(input instanceof Request ? input.url : input.toString()); expect(url.origin).toBe(audience); return browserRequest(port, url.pathname + url.search, init, cookie);},
      openSocket: (input, protocols) => {const url = new URL(input); expect(url.origin).toBe(audience.replace("https:", "wss:"));
        const socket = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, protocols, {headers: {host: new URL(audience).host, origin: audience, cookie}, perMessageDeflate: false});
        sockets.push(socket); socket.on("error", () => undefined); socket.once("unexpected-response", (_request, response) => {response.resume(); socket.terminate();}); return socket as unknown as BrowserSocket;}});
    // The baseline named client sends no recording context.
    const manager = browserTransport();
    const provider = manager.select({accountId: namedUser.id, workspaceId: "named:grant", grantId: "grant", objectId}); providers.push(provider);
    await provider.reconnect(); await stateWhen(provider, state => state.status === "live");
    expect(yDocToMarkdown(provider.doc)).toBe(yDocToMarkdown(ownerDoc));
    const discovered = await fetch(`${relayUrl}/sync/workspace/live-host`, {headers: {authorization: `Bearer ${bearer}`}});
    expect(discovered.status).toBe(200);
    const ownerTarget = readyOwnerDeliveryDocuments(await discovered.json(), "workspace")[0]!;
    expect(ownerTarget).toBeDefined();
    const runOwnerPass = () => runNativeOwnerDeliveryPass({client: owner!, workspaceHandle: handle, document: ownerTarget,
      config: {...profile.owner, nativeConfigPath: ownerConfigPath, relayUrl, documents: [ownerTarget]},
      signal: AbortSignal.timeout(30_000), bearer, accountId: ownerUser.id, assertCurrent() {expect(owner).toBeDefined();}});
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
    type AuditSettlement = {record: {settlementId: string; momentId: string; previousCursor: number; terminalCursor: number; markdownDigest: string;
      binding: {workspaceId: string; mainVersionId: string; objectId: string; lineageClaimId: string}}};
    // This document's audit settlements, newest first.
    const auditSettlements = () => relayRead.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='live.audit.settlement' ORDER BY relay_seq DESC").all("workspace")
      .map(row => JSON.parse(String(row.payload_json)) as AuditSettlement).filter(({record}) =>
        record?.binding?.workspaceId === document.workspaceId && record?.binding?.mainVersionId === mainVersionId &&
          record?.binding?.objectId === objectId && record?.binding?.lineageClaimId === lineageClaimId);
    const baselineSettlement = await vi.waitFor(() => {
      const settlement = auditSettlements().find(({record}) =>
        record.terminalCursor === finalAck.journalCursor && record.markdownDigest === hash(Buffer.from(expected)));
      expect(settlement).toBeDefined();
      return settlement!;
    }, {timeout: 30000});
    const settledMomentId = baselineSettlement.record.momentId;
    // A proof-backed moment carries no client authors. Its settlement reference
    // is the audit settlement itself. The relay records the accepted admission
    // and the authors it derived from admitted first-seen content beside it.
    const publication = (settlement: AuditSettlement, admitted: readonly unknown[]) => vi.waitFor(() => {
      const rows = relayRead.prepare("SELECT payload_json,admitted_author_snapshot_json,settlement_admission_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='moment.append'").all("workspace")
        .filter(row => JSON.parse(String(row.payload_json)).momentId === settlement.record.momentId);
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(String(rows[0]!.payload_json));
      expect(Object.hasOwn(payload, "authors")).toBe(false);
      expect(Object.hasOwn(payload, "attributionUnavailable")).toBe(false);
      expect(payload.settlementReference).toEqual(settlement);
      expect(JSON.parse(String(rows[0]!.settlement_admission_json))).toEqual({status: "accepted", settlementId: settlement.record.settlementId});
      expect(JSON.parse(String(rows[0]!.admitted_author_snapshot_json))).toEqual(admitted);
    }, {timeout: 30000});
    // None of these edits sent recording context. The relay credits no person,
    // agent, grant or automation for content that declared none. It admits only
    // the explicit marker for that unknown first-seen content.
    const unattributed = [{kind: "unattributed"}];
    await publication(baselineSettlement, unattributed);
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
    // The owner imports the relay-admitted marker, not the service's private
    // grant authority. Retained audit evidence adds no credit, and the owner
    // keeps the marker across restart.
    const ownerHistoryAuthors = async () => {
      const moment = ((await rpc("moments.list", {versionId: mainVersionId})).moments as {momentId: string; authors?: unknown[] | null}[])
        .find(moment => moment.momentId === settledMomentId);
      expect(moment).toBeDefined();
      return moment!.authors;
    };
    const ownerAuthors = await ownerHistoryAuthors();
    results.ownerSettledAuthors = {settledMomentId, admitted: unattributed, owner: ownerAuthors};
    writeFileSync(join(root, "owner-settled-authors.json"), JSON.stringify(results.ownerSettledAuthors, null, 2));
    expect(ownerAuthors).toEqual(unattributed);
    owner!.close(); await owner!.waitForExit();
    owner = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30000,
      onStderr: value => appendFileSync(join(root, "owner-stderr.log"), value),
      privateLiveApplication: profile.nativeClient,
      env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: ownerConfigPath}});
    handle = ((await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId: "workspace", captureMode: "none",
      relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000})).result as {workspace: string}).workspace;
    expect(await ownerHistoryAuthors()).toEqual(ownerAuthors);
    provider.close(); provider.doc.destroy(); providers.length = 0;

    // Declared work: one isolated interval per case, each settled and
    // published by the service under its own derived credential.
    const human = {kind: "human", humanId: namedUser.id, humanName: "Unnamed"};
    const agent = {kind: "agent", agentId: "proof-agent", agentName: "Proof agent", onBehalfOf: namedUser.id, depth: 2};
    const automation = {kind: "automation", automationId: "proof-automation", onBehalfOf: ownerUser.id, depth: 1};
    // Admission keeps the nested declaration; History stores the flat author.
    const automationAdmitted = {kind: "automation", automationId: automation.automationId,
      attribution: {actorKind: "automation", onBehalfOf: automation.onBehalfOf, depth: automation.depth}};
    const admittedSnapshot = (deliveryId: string) => JSON.parse(String((relayRead.prepare(
      "SELECT author_snapshot_json FROM sync_relay_live_update_journal WHERE delivery_id=?").get(deliveryId) as {author_snapshot_json: unknown} | undefined)?.author_snapshot_json ?? "null"));
    // The audit settlement whose interval holds exactly this receipt.
    const settlementOf = (receipt: {journalCursor: number}, previousCursor: number, markdown: string) => vi.waitFor(() => {
      const settlement = auditSettlements().find(({record}) => record.previousCursor < receipt.journalCursor && receipt.journalCursor <= record.terminalCursor);
      expect(settlement).toBeDefined();
      const {record} = settlement!;
      expect(record.previousCursor).toBe(previousCursor);
      expect(record.terminalCursor).toBe(receipt.journalCursor);
      expect(record.markdownDigest).toBe(hash(Buffer.from(markdown)));
      return settlement!;
    }, {timeout: 30000});

    // A named recipient's agent, declared through the real browser transport.
    const agentProvider = browserTransport(() => ({kind: "account", accountId: namedUser.id,
      agent: {agentId: agent.agentId, agentName: agent.agentName, onBehalfOf: agent.onBehalfOf, depth: agent.depth}}))
      .select({accountId: namedUser.id, workspaceId: "named:grant", grantId: "grant", objectId});
    providers.push(agentProvider);
    await agentProvider.reconnect(); await stateWhen(agentProvider, state => state.status === "live");
    const beforeAgentCursor = agentProvider.state().lastApplied?.journalCursor ?? 0;
    expect(agentProvider.edit(() => agentProvider.doc.getMap("frontmatter").set("agentProof", "declared"))).toBe(true);
    const agentAck = (await stateWhen(agentProvider, state => (state.lastApplied?.journalCursor ?? 0) > beforeAgentCursor && state.pendingUpdates === 0)).lastApplied!;
    expect(admittedSnapshot(agentAck.deliveryId)).toEqual([human, {kind: "agent", agentId: agent.agentId, agentName: agent.agentName, onBehalfOf: agent.onBehalfOf, depth: agent.depth}]);
    expect(await capture.client.readLiveApplicationAck({id: capture.nextRequestId(), workspace: capture.workspace, registrationId: capture.registrationId, deadlineMs: capture.deadlineMs},
      {deliveryId: agentAck.deliveryId, updateDigest: agentAck.updateDigest})).toEqual(agentAck);
    const agentMarkdown = yDocToMarkdown(agentProvider.doc);
    agentProvider.close(); agentProvider.doc.destroy(); providers.length = 0;
    await active!.settle(document);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(agentMarkdown);
    const agentSettlement = await settlementOf(agentAck, finalAck.journalCursor, agentMarkdown);
    // The relay admits the snapshot's account holder and declared agent. The grant authority stays private.
    await publication(agentSettlement, [human, agent]);

    // A trusted automation the owner runs, through the production owner capture.
    const automationHost = captureOwnerLiveFrameHost({authenticatedUserId: ownerUser.id, shareId: "share", storage,
      native: await active!.captureNative(binding.binding), bounds: profile.namedLive.host, validate});
    const {automationAck, automationMarkdown} = await (async () => {
      const automationDoc = new Y.Doc();
      try {
        const sync = await automationHost.openSync(Y.encodeStateVector(automationDoc), AbortSignal.timeout(30_000));
        try {Y.applyUpdate(automationDoc, sync.missingStateUpdate);} finally {sync.close();}
        const beforeAutomation = Y.encodeStateVector(automationDoc);
        automationDoc.getMap("frontmatter").set("automationProof", "trusted");
        const updateBytes = Y.encodeStateAsUpdate(automationDoc, beforeAutomation);
        const submitted = await automationHost.submit({deliveryId: "self-host-proof-automation", updateDigest: hash(updateBytes), updateBytes,
          trustedAutomation: {automationId: automation.automationId, attribution: {actorKind: "automation", onBehalfOf: ownerUser.id, depth: 1}}}, AbortSignal.timeout(30_000));
        if (submitted.result !== "success") throw new Error(`Trusted automation edit was not admitted: ${JSON.stringify(submitted)}`);
        return {automationAck: submitted.ack, automationMarkdown: yDocToMarkdown(automationDoc)};
      } finally {automationHost.close(); automationDoc.destroy();}
    })();
    expect(admittedSnapshot(automationAck.deliveryId)).toEqual([automationAdmitted]);
    expect(automationAck.journalCursor).toBeGreaterThan(agentAck.journalCursor);
    await active!.settle(document);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(automationMarkdown);
    const automationSettlement = await settlementOf(automationAck, agentAck.journalCursor, automationMarkdown);
    await publication(automationSettlement, [automationAdmitted]);

    // Publication credits each interval with the relay-admitted authors in
    // History's flat form: the snapshot person and the declared agent, never
    // the grant authority. The service keeps the same credit that owner
    // devices import.
    // Import marks the relay-admitted person confirmed; the admitted snapshot carries no marker.
    const importedHuman = {...human, relayConfirmed: true};
    const declaredCredit = [
      {momentId: agentSettlement.record.momentId, imported: [agent, importedHuman]},
      {momentId: automationSettlement.record.momentId, imported: [automation]},
    ] as const;
    const expectAuthors = (actual: unknown, expected: readonly unknown[]) => {
      expect(actual).toHaveLength(expected.length);
      expect(actual).toEqual(expect.arrayContaining([...expected]));
    };
    const momentAuthors = async (call: typeof rpc, momentId: string) => {
      const moment = ((await call("moments.list", {versionId: mainVersionId})).moments as {momentId: string; authors?: unknown[] | null}[])
        .find(moment => moment.momentId === momentId);
      expect(moment).toBeDefined();
      return moment!.authors;
    };
    const pullAll = async (call: typeof rpc) => {
      for (let page = 0; page < 8; page++) {
        const pulled = await call("sync.pull", {workspaceId: "workspace"}); expect(pulled.refusals ?? []).toEqual([]);
        if (pulled.pendingCursor) {
          const cursor = {workspaceId: "workspace", pendingCursor: pulled.pendingCursor};
          expect((await call("sync.materializePendingCursor", cursor)).materialized).toBe(true);
          expect((await call("sync.commitCursor", cursor)).committed).toBe(true);
        }
        if (!pulled.hasMore) return;
      }
      throw new Error("Pull exceeded its eight-page bound.");
    };
    // The enrolled owner first receives both admitted intervals through its
    // authenticated native delivery, as after the baseline's idle edit.
    expect(await runOwnerPass()).toBe("empty");
    expect((await owner!.ownerYDocReadState(nativeRequest(), target)).acceptedCursor).toBeGreaterThanOrEqual(automationAck.journalCursor);
    // Imported audit evidence adds no credit to the published moments.
    await pullAll(rpc);
    expect((await rpc("versionedText.read", {versionId: mainVersionId, path: "docs/a.md"})).text).toBe(automationMarkdown);
    for (const {momentId, imported} of declaredCredit) expectAuthors(await momentAuthors(rpc, momentId), imported);

    // A fresh ordinary peer imports the same credit without any live feed.
    const peerRoot = join(root, "peer"); mkdirSync(peerRoot);
    peer = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30000,
      onStderr: value => appendFileSync(join(root, "peer-stderr.log"), value),
      privateLiveApplication: profile.nativeClient,
      env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: undefined}});
    const peerHandle = ((await peer.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: peerRoot, workspaceId: "workspace", captureMode: "none",
      relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000})).result as {workspace: string}).workspace;
    const peerRpc = async (method: string, params: Record<string, any>) => {
      try {return (await peer!.sendRequest({id: requestId++, workspace: peerHandle, method, params, deadlineMs: 30000})).result as Record<string, any>;}
      catch (cause) {throw new Error(`Service proof peer RPC failed: ${method}`, {cause});}
    };
    await vi.waitFor(() => peerRpc("versions.ensureMain", {}), {timeout: 30000});
    expect((await peerRpc("sync.adoptJoinIdentity", {workspaceId: "workspace", replicationEpoch: identity.replicationEpoch,
      streamIdentity: identity.streamIdentity})).adopted).toBe(true);
    await pullAll(peerRpc);
    expect((await peerRpc("versionedText.read", {versionId: mainVersionId, path: "docs/a.md"})).text).toBe(automationMarkdown);
    expect(readFileSync(join(peerRoot, "docs/a.md"), "utf8")).toBe(automationMarkdown);
    for (const {momentId, imported} of declaredCredit) expectAuthors(await momentAuthors(peerRpc, momentId), imported);
    expect(await momentAuthors(peerRpc, settledMomentId)).toEqual(unattributed);
    peer.close(); await peer.waitForExit(); peer = undefined;
    results.declaredAuthors = {
      agent: {receipt: agentAck, settlement: agentSettlement, admitted: [human, agent], imported: [agent, importedHuman]},
      automation: {receipt: automationAck, settlement: automationSettlement, admitted: [automationAdmitted], imported: [automation]},
    };
    // The service imports the admitted credit through its own background pull.
    // Poll its store until that credit lands. A missing row reads as undefined, not null.
    const authorJson = (database: DatabaseSync, momentId = settledMomentId) => (database.prepare("SELECT author_json FROM moments WHERE moment_id=?").get(momentId) as {author_json: string | null} | undefined)?.author_json;
    const serviceEngine = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {
      await vi.waitFor(() => {
        expect(JSON.parse(authorJson(serviceEngine) ?? "null")).toEqual(unattributed);
        for (const {momentId, imported} of declaredCredit) expectAuthors(JSON.parse(authorJson(serviceEngine, momentId) ?? "null"), imported);
      }, {timeout: 30000});
    } finally {serviceEngine.close();}
    await supervisor!.close(); supervisor = undefined; active = undefined;
    const engine = new DatabaseSync(toNamespacedPath(join(workspace, ".dohc/engine/engine.db")), {readOnly: true});
    try {results.persistedApplications = engine.prepare("SELECT delivery_id,update_digest FROM live_device_update_applications ORDER BY journal_cursor").all();
      expect(results.persistedApplications).toEqual(expect.arrayContaining([{delivery_id: ack.deliveryId, update_digest: ack.updateDigest}]));
      // Publication replaced the service's private credit with the
      // relay-admitted authors. The service, the owner and the fresh peer hold
      // exactly those authors, and only the unknown-content marker for the
      // baseline moment that declared none.
      const ownerEngine = new DatabaseSync(join(ownerRoot, ".dohc/engine/engine.db"), {readOnly: true});
      const peerEngine = new DatabaseSync(join(root, "peer", ".dohc/engine/engine.db"), {readOnly: true});
      try {
        const host = authorJson(engine), owned = authorJson(ownerEngine);
        Object.assign(results.ownerSettledAuthors as object, {hostRaw: host, ownerRaw: owned});
        for (const database of [engine, ownerEngine, peerEngine]) expect(JSON.parse(authorJson(database) ?? "null")).toEqual(unattributed);
        for (const {momentId, imported} of declaredCredit) {
          for (const database of [engine, ownerEngine, peerEngine]) expectAuthors(JSON.parse(authorJson(database, momentId) ?? "null"), imported);
        }
      } finally {ownerEngine.close(); peerEngine.close();}
    } finally {engine.close();}
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
      scope: "Default self-host profile, scoped replication credentials, automatic discovery, native cold import and adoption-reply-loss recovery, service restart, owner draft restart, concurrent named and owner edits, idle owner receive, native acknowledgements, settlement and ordinary publication, declared agent and trusted automation credit through service publication, owner and fresh peer import.",
      omitted: ["TLS transport", "browser UI", "restore cutover"], harness: {transforms: harness.transforms, captures: harness.captures}, results}, null, 2));
  } finally {
    for (const provider of providers) {provider.close(); provider.doc.destroy();}
    sockets.forEach(socket => socket.terminate());
    const errors: unknown[] = [];
    try {await supervisor?.close();} catch (error) {errors.push(error);}
    if (owner) {owner.close(); try {await owner.waitForExit();} catch (error) {errors.push(error);}}
    if (peer) {peer.close(); try {await peer.waitForExit();} catch (error) {errors.push(error);}}
    for (const close of closes.reverse()) try {await close();} catch (error) {errors.push(error);}
    await Promise.allSettled(upgrades);
    deployment?.storage.close(); ownerDoc.destroy();
    await pool.end(); if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
    if (errors.length) throw new AggregateError(errors, "Service activation proof cleanup failed.");
  }
}, 120000);

/**
 * A self-hosted session host with its own Postgres schema, relay and owner
 * engine. The owner has pushed docs/a.md and shared docs/ with Edit, and the
 * host has completed the document's activation.
 */
async function openSelfHostProof(name: string) {
  const {executable, expectedHash, output, connectionString} = proofInputs();
  const root = mkdtempSync(join(resolve(output), `${name}-`)), hostRoot = join(root, "service"), ownerRoot = join(root, "owner");
  mkdirSync(hostRoot); mkdirSync(join(ownerRoot, "docs"), {recursive: true});
  Object.assign(harness, {holdAdoption: false, committed: undefined, failed: undefined, withhold: undefined, holdApplication: undefined, unreachable: new Set(),
    unpublished: false, pulls: [], releases: [], transforms: [], captures: [], calls: [], tracePath: join(root, "service-rpc-trace.json")});
  const schema = `service_activation_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({connectionString, connectionTimeoutMillis: 30_000});
  const pool = new Pool({connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 30_000});
  const closes: (() => Promise<void>)[] = [];
  let schemaCreated = false, deployment: ReturnType<typeof openRelayDeployment> | undefined;
  let supervisor: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined, owner: Awaited<ReturnType<typeof createEngineClient>> | undefined;
  async function close() {
    const errors: unknown[] = [];
    try {await supervisor?.close();} catch (error) {errors.push(error);}
    if (owner) {owner.close(); try {await owner.waitForExit();} catch (error) {errors.push(error);}}
    for (const done of closes.reverse()) try {await done();} catch (error) {errors.push(error);}
    deployment?.storage.close();
    await pool.end(); if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
    if (errors.length) throw new AggregateError(errors, "Self-host proof cleanup failed.");
  }
  try {
    await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await pool.query(readFileSync(new URL("../../../packages/workspace-postgres/src/db/migrations/0001_better_auth.sql", import.meta.url), "utf8"));
    const auth = createWorkspaceAuth({pool, baseURL: "https://auth.example.test", secret: "service-activation-proof-secret-at-least-32-characters", trustedOrigins: [audience], sendEmail: async () => undefined});
    const password = "service-activation-proof-password";
    const ownerUser = (await auth.api.signUpEmail({body: {email: "owner@example.test", password, name: "Owner"}})).user;
    const namedUser = (await auth.api.signUpEmail({body: {email: "named@example.test", password, name: "Named"}})).user;
    const bearer = (await auth.api.signInEmail({body: {email: ownerUser.email, password}})).token;
    const configPath = join(root, "deployment.json");
    initializeRelayDeployment({configPath, relayPath: join(root, "relay/relay.sqlite"), continuityDirectory: join(root, "continuity")});
    const validation = createLiveValidationExecutor();
    closes.push(() => validation.close());
    const validate = validation.validator(profile.validation), resolveActor = createSessionActorResolver(auth);
    // The relay's storage and handlers, as one relay process opens them from its durable files.
    let storage!: ReturnType<typeof openRelayDeployment>["storage"], history!: ReturnType<typeof openRelayDeployment>["history"];
    let frameChanges!: ReturnType<typeof createNamedFrameChanges>, serviceReplication!: ReturnType<typeof createServiceHostReplication>;
    let relayApp!: ReturnType<typeof createSyncRelayHandler>, activations!: ReturnType<typeof storage.createServiceActivationStore>;
    const openRelay = () => {
      deployment = openRelayDeployment(configPath, {liveTickets: {retainedTicketsPerPrincipalGrant: 4, expiredTicketCleanupBatchSize: 2, now: Date.now}});
      ({storage, history} = deployment);
      frameChanges = createNamedFrameChanges(profile.namedLive.maxListeners);
      serviceReplication = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true,
        authorize: input => authorizeServiceHostReplication(storage, {key: Buffer.from(ticketKey), namespace: history.namespace, ...input})});
      relayApp = createSyncRelayHandler({storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey, resolveActor,
        namedBrowserSessionLimits: profile.browserSessions, ownerRestoreHost: () => supervisor?.current()});
      activations = storage.createServiceActivationStore(history);
    };
    openRelay();
    const relayRead = new DatabaseSync(join(root, "relay/relay.sqlite"), {readOnly: true});
    closes.push(async () => relayRead.close());
    let enrollment: ReturnType<typeof createServiceHostEnrollmentRoutes> | undefined;
    const relayHttp = serveFetchHandler({handler: request => request.headers.get("authorization")?.startsWith("Bearer dohc-service-v1.") ? serviceReplication(request)
      : new URL(request.url).pathname.endsWith("/live-host") ? enrollment!(request) : relayApp(request),
      maxBodyBytes: () => 8_000_000, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`;
    harness.relayUrl = relayUrl;
    owner = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30000,
      onStderr: value => appendFileSync(join(root, "owner-stderr.log"), value), privateLiveApplication: profile.nativeClient,
      env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: undefined}});
    let requestId = 1;
    const handle = ((await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId: "workspace", captureMode: "none",
      relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000})).result as {workspace: string}).workspace;
    const rpc = async (method: string, params: Record<string, any>, idempotencyKey?: string) => {
      try {return (await owner!.sendRequest({id: requestId++, workspace: handle, method, params, deadlineMs: 30000,
        ...(idempotencyKey === undefined ? {} : {idempotencyKey})})).result as Record<string, any>;}
      catch (cause) {throw new Error(`Self-host proof owner RPC failed: ${method}`, {cause});}
    };
    const push = async () => {
      for (let page = 0; page < 8; page++) {
        const result = await rpc("sync.push", {workspaceId: "workspace"});
        expect(result.status).toBe("complete"); expect(result.refusals).toEqual([]);
        expect(result.sharingDeclined).toEqual([]); expect(result.ownerAdmissionPending).toEqual([]);
        if (!result.hasMore) return;
      }
      throw new Error("Owner push exceeded its eight-page bound.");
    };
    await rpc("sync.claim", {workspaceId: "workspace"});
    const mainVersionId = (await rpc("versions.ensureMain", {})).id as string;
    await push();
    // A rich document the owner writes and edits ordinarily on their device, each change pushed to the relay.
    // Unless `seeded`, it is only written as text, as an agent writes it, until `open` opens it as the desktop does.
    const ownerDocument = async (path: string, text: string, {seeded = true} = {}) => {
      writeFileSync(join(ownerRoot, path), text);
      const objectId = (await rpc("versionedText.write", {workspaceId: "workspace", versionId: mainVersionId, path, text, origin: "api"}, randomUUID())).object.id as string;
      // The owner's Y.Doc, as its engine holds it.
      const doc = markdownToYDoc(text), baseline = Y.encodeStateAsUpdate(doc);
      closes.push(async () => doc.destroy());
      const edit = async (change: (doc: Y.Doc) => void, seed?: Uint8Array) => {
        const editor = await rpc("ydoc.open", {versionId: mainVersionId, path, expectedObjectId: objectId, contentKind: "richdoc"});
        const claim = seed
          ? (await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(seed).toString("base64"), seed: true, expectedLineageClaimId: editor.lineageClaimId})).lineageClaimId
          : editor.lineageClaimId;
        const vector = Y.encodeStateVector(doc); change(doc);
        await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"), expectedLineageClaimId: claim});
        await rpc("ydoc.settle", {sessionId: editor.sessionId}); await rpc("ydoc.close", {sessionId: editor.sessionId});
        await push();
      };
      // Opens it once and closes it, as the desktop does: its adapter seeds the Y.Doc of a file that has none.
      const open = async () => {
        const adapter = new YdocLiveAdapter(owner!);
        try {await (await adapter.openSession({workspace: handle, versionId: mainVersionId, path, expectedObjectId: objectId, contentKind: "richdoc"})).close();}
        finally {adapter.dispose();}
        await push();
      };
      if (seeded) await edit(doc => doc.getMap("frontmatter").set("beforeActivation", "ordinary-owner"), baseline);
      else await push();
      return {path, objectId, document: {workspaceId: "workspace", mainVersionId, objectId, lineageClaimId: hash(baseline)},
        markdown: () => yDocToMarkdown(doc), edit: (change: (doc: Y.Doc) => void) => edit(change), open};
    };
    const first = await ownerDocument("docs/a.md", "Hello"), objectId = first.objectId;
    storage.createShare({share: {shareId: "share", workspaceId: "workspace", granterUserId: ownerUser.id, selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: Date.now()},
      grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: namedUser.id, principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null}});
    const identity = storage.getWorkspaceBootstrap("workspace").identity;
    if (!identity) throw new Error("Ordinary source owner did not establish a relay identity.");
    const store = join(hostRoot, hash(Buffer.from(JSON.stringify(["hosted-v1", history.namespace, "workspace", identity.replicationEpoch, identity.streamIdentity]))));
    // What the supervisor tells the operator.
    const reports: string[] = [];
    const startSupervisor = async () => {
      supervisor = await startSelfHostedLiveHost({trustedAccount: (accountId: string) => ({accountId, name: accountId}), storage, history, frameChanges, root: hostRoot, engineExecutable: executable,
        relayOrigin: "https://service-activation-relay.example.test", key: Buffer.from(ticketKey), onError: error => {reports.push(error instanceof Error ? error.message : String(error));}});
      enrollment = createServiceHostEnrollmentRoutes({storage, history, host: supervisor, resolveActor});
    };
    const activation = (path = "docs/a.md") => activations.read("workspace", path, 1_000_000);
    await startSupervisor();
    const live = () => {const host = supervisor?.current(); if (!host) throw new Error("No service daemon is running."); return host;};
    // A live view of a document through the session host: the owner's, or the
    // named collaborator's through a live ticket, as their browser redeems one.
    const frameHost = async <T>(document: typeof first.document, use: (host: ReturnType<typeof captureOwnerLiveFrameHost>, doc: Y.Doc) => Promise<T>, by: "owner" | "collaborator" = "owner") => {
      let host: ReturnType<typeof captureOwnerLiveFrameHost>;
      if (by === "collaborator") {
        const viewer = {kind: "named" as const, workspaceId: "workspace", shareId: "share", grantId: "grant", userId: namedUser.id};
        const captureNative = (...args: Parameters<ReturnType<typeof live>["captureNative"]>) => live().captureNative(...args);
        const tickets = createLiveTickets({storage, audience, key: ticketKey, hostReports: createLiveHostReports({storage, captureNative})});
        const minted = await tickets.mint({objectId: document.objectId}, viewer), ticket = minted && await tickets.redeem(minted.token, viewer);
        if (!ticket) throw new Error("The collaborator's live ticket was refused.");
        host = captureNamedLiveFrameHost({ticket, actor: liveBrowserActor(viewer), storage, native: await live().captureNative(ticket.binding),
          bounds: profile.namedLive.host, validate});
      } else {
        const binding = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: ownerUser.id, shareId: "share"}});
        if (binding.kind !== "current") throw new Error("Activated binding is unavailable.");
        host = captureOwnerLiveFrameHost({authenticatedUserId: ownerUser.id, shareId: "share", storage,
          native: await live().captureNative(binding.binding), bounds: profile.namedLive.host, validate});
      }
      const doc = new Y.Doc();
      try {
        const sync = await host.openSync(Y.encodeStateVector(doc), AbortSignal.timeout(30_000));
        try {Y.applyUpdate(doc, sync.missingStateUpdate);} finally {sync.close();}
        return await use(host, doc);
      } finally {host.close(); doc.destroy();}
    };
    const route = async (method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>) => {
      const response = await fetch(`${relayUrl}/sync/workspace/live-host`, {method, headers: {authorization: `Bearer ${bearer}`,
        ...(body ? {"content-type": "application/json"} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
      return {status: response.status, body: await response.json() as Record<string, any>};
    };
    const serviceRead = <T>(read: (engine: DatabaseSync) => T) => {
      const engine = new DatabaseSync(toNamespacedPath(join(store, ".dohc/engine/engine.db")), {readOnly: true});
      try {return read(engine);} finally {engine.close();}
    };
    const stopSupervisor = async () => {const stopping = supervisor; supervisor = undefined; await stopping?.close();};
    const proof = {root, hostRoot, store, executable, expectedHash, relayRead, reports, ownerDocument, ownerEdit: first.edit, objectId, ownerUserId: ownerUser.id,
      route, serviceRead, activation, live, startSupervisor, stopSupervisor,
      /** The relay storage the running relay opened. */
      get storage() {return storage;},
      /** Stops the running daemon, as when it loses an engine reply. The supervisor starts another. */
      retire: () => live().close(),
      /**
       * Restarts the relay process: stops the supervisor and its daemon, closes
       * relay storage, reopens it from its durable files, and starts the supervisor again.
       */
      restartRelay: async () => {await stopSupervisor(); deployment!.storage.close(); openRelay(); await startSupervisor();},
      /** Whether browsers are told live editing of the document is unavailable, as the relay's `main.ts` decides it. */
      sessionHostBlocked: (document: {workspaceId: string; objectId: string}) =>
        storage.getLiveHostControl()?.configuredMode === "service" && supervisor!.stopped(document),
      /**
       * Holds the reply to the next live application the engine completes.
       * `applied` resolves once the engine applied it; `release` lets the reply through.
       */
      holdApplication() {
        let applied!: () => void, release!: () => void;
        const done = new Promise<void>(resolve => {applied = resolve;}), released = new Promise<void>(resolve => {release = resolve;});
        harness.holdApplication = {applied, release: released};
        return {applied: done, release};
      },
      /** The session host's Markdown once a live edit sets `key`, without submitting it. */
      markdownWith: (key: string, value: string) => frameHost(first.document, async (_host, doc) => {
        doc.getMap("frontmatter").set(key, value);
        return yDocToMarkdown(doc);
      }),
      /**
       * The journal cursor the relay recorded as the owner delivery tip of
       * docs/a.md, from its history once the activation that delivered it retired.
       */
      ownerTip: () => {
        const tips = relayRead.prepare(`SELECT tip_cursor FROM sync_relay_live_delivery_owners WHERE workspace_id='workspace' AND object_id=?1
          UNION ALL SELECT tip_cursor FROM sync_relay_live_delivery_owner_history WHERE workspace_id='workspace' AND object_id=?1`).all(objectId) as {tip_cursor: number}[];
        if (tips.length !== 1) throw new Error(`Expected one owner delivery of docs/a.md, found ${tips.length}.`);
        return tips[0]!.tip_cursor;
      },
      /** A document's owner delivery tips: the current one, and those its retired activations kept. */
      ownerTips: (object = objectId) => ({
        current: relayRead.prepare("SELECT tip_cursor FROM sync_relay_live_delivery_owners WHERE workspace_id='workspace' AND object_id=?").all(object),
        retired: relayRead.prepare("SELECT activation_id,tip_cursor FROM sync_relay_live_delivery_owner_history WHERE workspace_id='workspace' AND object_id=? ORDER BY rowid").all(object)}),
      /** Each activation of a document the relay recorded, in the order it prepared them. */
      activations: (object = objectId) => relayRead.prepare(`SELECT activation_id,predecessor_activation_id,state_digest,completion_json IS NOT NULL AS completed,
        retire_accepted_cursor,retired_at_ms IS NOT NULL AS retired,retired_boundary_json AS boundary,state_bytes IS NULL AS stateDropped
        FROM sync_relay_service_activations WHERE workspace_id='workspace' AND object_id=? ORDER BY rowid`).all(object)
        .map(row => ({...row, boundary: row.boundary === null ? null : JSON.parse(String(row.boundary))})),
      /** How the host lists a ready document: its current binding, through the activation that holds it. */
      ready: (path: string) => ({path, status: "ready", document: {binding: activation(path)!.binding, relayDatabaseNamespace: history.namespace, shareId: "share"}}),
      /** A document's rows in the relay's live journal. */
      journal: (object = objectId) => relayRead.prepare(`SELECT journal_cursor,delivery_id,update_digest,principal_kind,grant_id
        FROM sync_relay_live_update_journal WHERE workspace_id='workspace' AND object_id=? ORDER BY journal_cursor`).all(object),
      /** The delivery IDs at a journal cursor of docs/a.md: the one the relay accepted and the one the session host applied. */
      deliveryAt: (cursor: number) => ({
        accepted: (relayRead.prepare("SELECT delivery_id FROM sync_relay_live_update_journal WHERE workspace_id='workspace' AND object_id=? AND journal_cursor=?").get(objectId, cursor) as {delivery_id: string} | undefined)?.delivery_id,
        applied: serviceRead(engine => (engine.prepare("SELECT delivery_id FROM live_device_update_applications WHERE workspace_id='workspace' AND object_id=? AND journal_cursor=?").get(objectId, cursor) as {delivery_id: string} | undefined)?.delivery_id)}),
      /** A live edit the session host accepts. */
      liveEdit: (key: string, value: string, document = first.document, by: "owner" | "collaborator" = "owner") => frameHost(document, async (host, doc) => {
        const before = Y.encodeStateVector(doc);
        doc.getMap("frontmatter").set(key, value);
        const updateBytes = Y.encodeStateAsUpdate(doc, before);
        const submitted = await host.submit({deliveryId: randomUUID(), updateDigest: hash(updateBytes), updateBytes}, AbortSignal.timeout(30_000));
        if (submitted.result !== "success") throw new Error(`Live edit was not accepted: ${JSON.stringify(submitted)}`);
        return submitted.ack;
      }, by),
      /** Opens the owner's live view of docs/a.md, runs `between`, then submits a live edit. Resolves to why it was refused, or "accepted". */
      liveEditAfter: (between: () => unknown) => frameHost(first.document, async (host, doc) => {
        await between();
        const before = Y.encodeStateVector(doc);
        doc.getMap("frontmatter").set("afterwards", "live");
        const updateBytes = Y.encodeStateAsUpdate(doc, before);
        return host.submit({deliveryId: randomUUID(), updateDigest: hash(updateBytes), updateBytes}, AbortSignal.timeout(30_000))
          .then(submitted => submitted.result === "success" ? "accepted" : JSON.stringify(submitted), (error: Error) => error.message);
      }),
      /** The session host's Y.Doc: the digest of its state as a fresh document encodes it, and its Markdown. */
      hostState: () => frameHost(first.document, async (_host, doc) => ({digest: hash(Y.encodeStateAsUpdate(doc)), markdown: yDocToMarkdown(doc)})),
      documents: async () => (await route("GET")).body.documents as {path: string; status: string; reason?: string}[],
      hosted: (object = objectId) => serviceRead(engine => engine.prepare("SELECT state,held_reason AS reason FROM hosted_documents WHERE workspace_id='workspace' AND object_id=?")
        .get(object) as {state: string; reason: string | null} | undefined),
      /** Engine RPCs the service host started. */
      started: (method: string) => harness.calls.filter(call => call.method === method && call.status === "started").length,
      /** The rows the service host wrote that the relay does not have. */
      unpushed: () => serviceRead(engine => engine.prepare("SELECT origin_id,origin_seq,op_kind,payload_json FROM replication_log WHERE workspace_id='workspace' AND imported=0")
        .all() as {origin_id: string; origin_seq: number; op_kind: string; payload_json: string}[])
        .filter(row => relayRead.prepare("SELECT 1 FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id=? AND origin_seq=?").get(row.origin_id, row.origin_seq) === undefined),
      /** The operation the relay's log holds at each row's coordinates. A refused row holds `relay.refused`. */
      relayed: (rows: readonly {origin_id: string; origin_seq: number}[]) => rows.map(row =>
        (relayRead.prepare("SELECT op_kind FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id=? AND origin_seq=?").get(row.origin_id, row.origin_seq) as {op_kind: string} | undefined)?.op_kind),
      /** The last journal cursor the session host applied of a document, and the last it settled into the file. */
      settlement: (object = objectId) => serviceRead(engine => engine.prepare(`SELECT
        (SELECT COALESCE(MAX(journal_cursor),0) FROM live_device_update_applications WHERE workspace_id='workspace' AND object_id=?1) AS applied,
        (SELECT COALESCE(MAX(terminal_cursor),0) FROM live_device_settlements WHERE workspace_id='workspace' AND object_id=?1) AS settled`)
        .get(object) as {applied: number; settled: number}),
    };
    await vi.waitFor(async () => expect(await proof.documents()).toEqual([expect.objectContaining({path: "docs/a.md", status: "ready"})]), {timeout: 30000});
    return {proof, close};
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
type SelfHostProof = Awaited<ReturnType<typeof openSelfHostProof>>["proof"];

async function withSelfHostProof(name: string, run: (proof: SelfHostProof) => Promise<Record<string, unknown>>) {
  const {proof, close} = await openSelfHostProof(name);
  try {
    const results = await run(proof);
    expect(hash(readFileSync(proof.executable))).toBe(proof.expectedHash);
    writeFileSync(join(proof.root, "result.json"), JSON.stringify({verdict: "PASS", executable: proof.executable, sha256: proof.expectedHash,
      harness: {calls: harness.calls, captures: harness.captures}, results}, null, 2));
  } catch (error) {
    writeFileSync(join(proof.root, "failure.json"), JSON.stringify({error: String(error), pulls: harness.pulls, calls: harness.calls, reports: proof.reports}, null, 2));
    await close().catch(() => undefined);
    throw error;
  }
  await close();
}

// The live journal row of an accepted edit, as `journal` reads it.
const journaled = (ack: {journalCursor: number; deliveryId: string; updateDigest: string}, principal_kind = "owner", grant_id: string | null = null) =>
  ({journal_cursor: ack.journalCursor, delivery_id: ack.deliveryId, update_digest: ack.updateDigest, principal_kind, grant_id});

// The owner stops live editing. The document's activation retires: what the
// host accepted settles and publishes, its replica parks the document, and
// the host releases its enrollment, keeping the store. `stopped` runs once
// Stop has answered, which resolves to Stop's answer.
async function stopLiveEditing(proof: SelfHostProof, stopped: () => unknown = () => {}) {
  const answer = (await proof.route("DELETE", {path: "docs/a.md", retire: true})).body;
  expect(answer).toMatchObject({status: "retired"});
  await stopped();
  await vi.waitFor(() => {
    expect(proof.hosted()?.state).toBe("parked");
    expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")?.hostDrainedAtMs).not.toBeNull();
  }, {timeout: 30000});
  return answer;
}

it("parks a stopped document in its store and resumes it as a successor activation when it is shared again", () => withSelfHostProof("self-host-park", async proof => {
  // The owner stops while the host holds a live edit it accepted and has neither settled nor pushed.
  harness.unreachable.add("sync.push"); harness.unreachable.add("liveApplication.settle");
  const journal = proof.journal(), accepted = await proof.liveEdit("beforeStop", "live");
  const saved = proof.activation()!, before = await proof.hostState(), stores = readdirSync(proof.hostRoot);
  expect(stores).toEqual([basename(proof.store)]);
  expect(before.markdown).toBe("---\nbeforeActivation: ordinary-owner\nbeforeStop: live\n---\n\nHello");
  const waiting = proof.unpushed();
  expect(waiting.map(row => row.op_kind)).toEqual(["ydoc.update", "live.audit.application"]);
  const unsettled = proof.settlement();
  expect(unsettled.applied).toBe(accepted.journalCursor); expect(unsettled.settled).toBeLessThan(accepted.journalCursor);
  const stop = await stopLiveEditing(proof, () => {harness.unreachable.delete("sync.push"); harness.unreachable.delete("liveApplication.settle");});
  // Stop settled what the host accepted into the file before it parked.
  expect(proof.settlement()).toEqual({applied: accepted.journalCursor, settled: accepted.journalCursor});
  expect(proof.serviceRead(engine => engine.prepare("SELECT blob_sha256 FROM hosted_parked_snapshots WHERE workspace_id='workspace' AND object_id=?")
    .all(saved.source.objectId))).toEqual([{blob_sha256: hash(Buffer.from(before.markdown))}]);
  // Its retirement published that work as it was written before the document parked.
  expect(proof.relayed(waiting)).toEqual(["ydoc.update", "live.audit.application"]);
  // The relay's live journal still holds the edit, through the cursor Stop answered with.
  expect(stop.acceptedCursor).toBe(accepted.journalCursor);
  expect(proof.relayRead.prepare("SELECT delivery_id,update_digest FROM sync_relay_live_update_journal WHERE workspace_id='workspace' AND object_id=? AND journal_cursor=?")
    .get(saved.source.objectId, accepted.journalCursor)).toEqual({delivery_id: accepted.deliveryId, update_digest: accepted.updateDigest});
  const captures = harness.captures.length;
  expect((await proof.route("POST", {shareId: "share"})).status).toBe(202);
  await vi.waitFor(async () => expect(await proof.documents()).toEqual([proof.ready("docs/a.md")]), {timeout: 30000});
  // It resumed as the successor of its retired activation, from one capture, in
  // the store it parked in, with its Y.Doc as it was.
  const successor = proof.activation()!;
  expect(successor.activationId).not.toBe(saved.activationId);
  expect(successor.source.predecessorActivationId).toBe(saved.activationId);
  expect(successor.source.fullStateDigest).toBe(before.digest);
  expect(harness.captures.slice(captures)).toEqual([{activationId: successor.activationId, requestedActivationId: undefined, source: successor.source}]);
  expect(readdirSync(proof.hostRoot)).toEqual(stores);
  expect(proof.hosted()).toEqual({state: "ready", reason: null});
  const after = await proof.hostState();
  expect(after).toEqual(before);
  // Its state is the retired activation's boundary, so it journals no seed, and live editing continues at the next cursor.
  const continued = await proof.liveEdit("afterShare", "live");
  expect(proof.journal()).toEqual([...journal, journaled(accepted), journaled(continued)]);
  expect(continued.journalCursor).toBe(accepted.journalCursor + 1);
  return {activationId: saved.activationId, successor: successor.activationId, store: proof.store, ydoc: after};
}), 120000);

// The edit at `cursor` settled into the file of a document that then parked:
// the session host applied and settled it, the relay recorded it as the owner
// tip, the relay's journal holds that same edit there, and the parked head is
// the Markdown with it.
function expectParkedWith(proof: SelfHostProof, cursor: number, markdown: string) {
  expect(proof.hosted()?.state).toBe("parked");
  expect(proof.settlement()).toEqual({applied: cursor, settled: cursor});
  expect(proof.ownerTip()).toBe(cursor);
  const delivery = proof.deliveryAt(cursor);
  expect(delivery.accepted).toBeDefined(); expect(delivery.accepted).toBe(delivery.applied);
  expect(proof.serviceRead(engine => engine.prepare("SELECT blob_sha256 FROM hosted_parked_snapshots WHERE workspace_id='workspace' AND object_id=?")
    .all(proof.objectId))).toEqual([{blob_sha256: hash(Buffer.from(markdown))}]);
}

// The engine applies a live edit, and its reply carrying the ACK has not
// reached the relay when the owner stops. The reply then arrives on the same
// daemon, too late to be recorded; the departure reads the engine's own record.
it("settles a live edit whose application reply Stop overtook, then parks", () => withSelfHostProof("self-host-stop-held", async proof => {
  const markdown = await proof.markdownWith("heldAtStop", "live");
  const held = proof.holdApplication();
  const edit = proof.liveEdit("heldAtStop", "live").then(() => "accepted", () => "refused");
  await held.applied;
  const cursor = proof.settlement().applied;
  expect(proof.ownerTip()).toBeLessThan(cursor);
  const stop = await stopLiveEditing(proof, held.release);
  await edit;
  expect(stop.acceptedCursor).toBe(cursor);
  expectParkedWith(proof, cursor, markdown);
  return {cursor, acceptedCursor: stop.acceptedCursor};
}), 120000);

// The engine applies a live edit and its daemon goes before the relay records
// it. The owner stops while no daemon runs. The daemon after it never loaded
// the document, and settles it from the relay's journal and the engine's record.
it("settles a live edit its daemon applied before it went, after a Stop no daemon saw, then parks", () => withSelfHostProof("self-host-stop-restart", async proof => {
  const markdown = await proof.markdownWith("beforeRestart", "live");
  const held = proof.holdApplication();
  const edit = proof.liveEdit("beforeRestart", "live").then(() => "accepted", () => "refused");
  await held.applied;
  const cursor = proof.settlement().applied;
  await proof.stopSupervisor();
  expect(await edit).toBe("refused");
  expect(proof.ownerTip()).toBeLessThan(cursor);
  expect(proof.settlement().settled).toBeLessThan(cursor);
  const captures = harness.captures.length;
  const stop = await stopLiveEditing(proof, proof.startSupervisor);
  expect(stop.acceptedCursor).toBe(cursor);
  expectParkedWith(proof, cursor, markdown);
  // The replacement settled it without loading a session.
  expect(harness.captures.length).toBe(captures);
  return {cursor, acceptedCursor: stop.acceptedCursor};
}), 120000);

// Deleting the share ends live authority as Stop does, while its enrollment
// stays enabled until the host lets the document go. As before, the daemon
// that applied the edit goes first and the one after it settles it.
it("settles a live edit its daemon applied before it went, after the share was deleted, then parks", () => withSelfHostProof("self-host-share-deleted", async proof => {
  const markdown = await proof.markdownWith("beforeDeletion", "live");
  const held = proof.holdApplication();
  const edit = proof.liveEdit("beforeDeletion", "live").then(() => "accepted", () => "refused");
  await held.applied;
  const cursor = proof.settlement().applied;
  await proof.stopSupervisor();
  expect(await edit).toBe("refused");
  expect(proof.ownerTip()).toBeLessThan(cursor);
  expect(proof.storage.revokeShare("share", Date.now())).toBe(true);
  expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toMatchObject({enabled: true, retired: false});
  const captures = harness.captures.length;
  await proof.startSupervisor();
  await vi.waitFor(() => {
    expect(proof.hosted()?.state).toBe("parked");
    expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toMatchObject({retired: true, hostDrainedAtMs: expect.any(Number)});
  }, {timeout: 30000});
  expectParkedWith(proof, cursor, markdown);
  // The replacement settled from durable state, loading no session that could deliver.
  expect(harness.captures.length).toBe(captures);
  return {cursor};
}), 120000);

// Deleting the last Edit share cuts off admission at once, as Stop does. The
// owner's live view, open across the deletion, cannot submit again. The edit
// the running daemon accepted before it settles into the file, the document
// parks, and the relay's journal holds nothing after that edit.
it("refuses a live edit after the share was deleted, and parks with the edit accepted before it", () => withSelfHostProof("self-host-share-deleted-open", async proof => {
  const markdown = await proof.markdownWith("beforeDeletion", "live");
  const accepted = await proof.liveEdit("beforeDeletion", "live");
  const document = {workspaceId: "workspace", objectId: proof.activation()!.source.objectId};
  const refused = await proof.liveEditAfter(() => {
    expect(proof.storage.revokeShare("share", Date.now())).toBe(true);
    expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toMatchObject({enabled: true, retired: false});
    expect(proof.storage.serviceHostDocumentEnabled(document)).toBe(false);
  });
  expect(refused).toBe("Named host standing changed.");
  await vi.waitFor(() => {
    expect(proof.hosted()?.state).toBe("parked");
    expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toMatchObject({retired: true, hostDrainedAtMs: expect.any(Number)});
  }, {timeout: 30000});
  expectParkedWith(proof, accepted.journalCursor, markdown);
  expect(proof.deliveryAt(accepted.journalCursor + 1).accepted).toBeUndefined();
  return {cursor: accepted.journalCursor, refused};
}), 120000);

const bothReady = (proof: SelfHostProof) => vi.waitFor(async () => expect(await proof.documents()).toEqual([proof.ready("docs/a.md"), proof.ready("docs/b.md")]), {timeout: 30000});

// A stopped document's own output is pushed before it parks, so the write
// here is its sibling's.
it("pushes a write the host accepted before it reconnected, while another document resumes as a successor", () => withSelfHostProof("self-host-reconnect", async proof => {
  const second = await proof.ownerDocument("docs/b.md", "Second");
  await bothReady(proof);
  const saved = proof.activation()!;
  await stopLiveEditing(proof);
  // While docs/a.md is stopped its owner edits it on their device, where no session host admits the edit.
  await proof.ownerEdit(doc => doc.getMap("frontmatter").set("whileStopped", "ordinary-owner"));
  // The host accepts and settles a live edit of docs/b.md. Its pushes fail before they reach the engine, so the write waits in its store.
  harness.unreachable.add("sync.push");
  const accepted = await proof.liveEdit("beforeReconnect", "accepted", second.document);
  await vi.waitFor(() => expect(proof.settlement(second.objectId)).toEqual({applied: accepted.journalCursor, settled: accepted.journalCursor}), {timeout: 30000});
  const waiting = proof.unpushed();
  expect(waiting.map(row => [row.op_kind, JSON.parse(row.payload_json).objectId ?? null])).toEqual([["ydoc.update", second.objectId], ["live.audit.application", second.objectId],
    ["live.audit.settlement", null], ["moment.append", second.objectId]]);
  expect((await proof.route("POST", {shareId: "share"})).status).toBe(202);
  // The daemon goes, and the supervisor reconnects with another. docs/a.md resumes as a successor holding the owner's edit.
  const before = proof.live().coordinate.connectionId;
  await proof.retire();
  await vi.waitFor(async () => {
    expect(proof.live().coordinate.connectionId).not.toBe(before);
    expect(await proof.documents()).toEqual([proof.ready("docs/a.md"), proof.ready("docs/b.md")]);
  }, {timeout: 30000});
  expect(proof.activation()!.source.predecessorActivationId).toBe(saved.activationId);
  expect((await proof.hostState()).markdown).toBe("---\nbeforeActivation: ordinary-owner\nwhileStopped: ordinary-owner\n---\n\nHello");
  expect(proof.hosted()).toEqual({state: "ready", reason: null});
  // The write still waits first, as it was written.
  expect(proof.unpushed().slice(0, waiting.length)).toEqual(waiting);
  // Once pushes reach the engine again, the accepted write reaches the relay as it was written, not as refusals.
  harness.unreachable.delete("sync.push");
  await vi.waitFor(() => expect(proof.unpushed()).toEqual([]), {timeout: 30000});
  expect(proof.relayed(waiting)).toEqual(["ydoc.update", "live.audit.application", "live.audit.settlement", "moment.append"]);
  expect(proof.hosted()).toEqual({state: "ready", reason: null});
  expect(proof.hosted(second.objectId)).toEqual({state: "ready", reason: null});
  return {accepted, waiting: waiting.map(({origin_id, origin_seq, op_kind}) => ({origin_id, origin_seq, op_kind})), reconnected: proof.live().coordinate.connectionId};
}), 120000);

// Stop retires docs/a.md's activation while docs/b.md stays live. Its output
// never reaches the relay, so its replica cannot park it and the engine will
// not release it. The relay restarts inside that retirement, and the reply to
// the release is lost. Once it retired, its owner edits it on their
// device, and Resume activates a successor that holds that edit and takes the
// collaborator's live edit.
it("retires a stopped document while another stays live, then resumes it as a successor", () => withSelfHostProof("self-host-successor", async proof => {
  const second = await proof.ownerDocument("docs/b.md", "Second");
  await bothReady(proof);
  const predecessor = proof.activation()!, P = predecessor.activationId, journal = proof.journal(), secondJournal = proof.journal(second.objectId);
  const enrollment = (hostDrainedAtMs: unknown) => ({workspaceId: "workspace", objectId: proof.objectId, path: "docs/a.md", ownerUserId: proof.ownerUserId,
    shareId: "share", replicationEpoch: predecessor.source.replicationEpoch, streamIdentity: predecessor.source.streamIdentity, ownerStop: "retire",
    enabled: false, retired: true, createdAtMs: expect.any(Number), updatedAtMs: expect.any(Number), hostDrainedAtMs});
  const parking = {status: "pending", reason: "parking"}, onlyParking = () => expect(harness.releases).toEqual(harness.releases.map(() => parking));
  const sibling = () => ({tip: proof.ownerTips(second.objectId).current, ...proof.settlement(second.objectId)});
  expect(proof.activations()).toEqual([{activation_id: P, predecessor_activation_id: null, state_digest: predecessor.source.fullStateDigest, completed: 1,
    retire_accepted_cursor: null, retired: 0, boundary: null, stateDropped: 0}]);

  // From here each push answers that nothing is left, and none reaches the engine.
  harness.unpublished = true;
  const accepted = await proof.liveEdit("beforeStop", "live");
  expect((await proof.route("DELETE", {path: "docs/a.md", retire: true})).body).toEqual({ok: true, path: "docs/a.md", objectId: proof.objectId, status: "retired",
    acceptedCursor: accepted.journalCursor});
  const retiring = {activation_id: P, predecessor_activation_id: null, state_digest: predecessor.source.fullStateDigest, completed: 1,
    retire_accepted_cursor: accepted.journalCursor, retired: 0, boundary: null, stateDropped: 0};
  // Retirement settled the edit and its replica confirmed the document left. The engine still will not release it:
  // its replica cannot park it while that output has not reached the relay.
  await vi.waitFor(() => expect(harness.releases).toContainEqual(parking), {timeout: 30000});
  onlyParking();
  expect(proof.unpushed().map(row => [row.op_kind, JSON.parse(row.payload_json).objectId ?? null])).toEqual([["ydoc.update", proof.objectId],
    ["live.audit.application", proof.objectId], ["live.audit.settlement", null], ["moment.append", proof.objectId]]);
  expect(proof.settlement()).toEqual({applied: accepted.journalCursor, settled: accepted.journalCursor});
  expect(proof.hosted()).toEqual({state: "ready", reason: null});
  expect(proof.activations()).toEqual([retiring]);
  expect(proof.ownerTips()).toEqual({current: [{tip_cursor: accepted.journalCursor}], retired: []});
  expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toEqual(enrollment(null));
  expect(await proof.documents()).toEqual([proof.ready("docs/b.md")]);

  // Meanwhile docs/b.md accepts a live edit, and the host delivers it.
  const during = await proof.liveEdit("duringRetirement", "live", second.document);
  await vi.waitFor(() => expect(sibling()).toEqual({tip: [{tip_cursor: during.journalCursor}], applied: during.journalCursor, settled: during.journalCursor}), {timeout: 30000});
  expect(proof.journal(second.objectId)).toEqual([...secondJournal, journaled(during)]);
  onlyParking();
  expect(proof.activations()).toEqual([retiring]);

  // The relay restarts inside the retirement and reopens its storage from its durable files. The retirement is still open,
  // the daemon after it reaches the same barrier, and docs/b.md stays live.
  const beforeRestart = harness.releases.length, relayBefore = proof.storage;
  await proof.restartRelay();
  expect(() => relayBefore.readServiceHostEnrollment("workspace", "docs/a.md")).toThrow("Relay storage is unavailable.");
  expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toEqual(enrollment(null));
  expect(proof.activations()).toEqual([retiring]);
  await vi.waitFor(() => expect(harness.releases.length).toBeGreaterThan(beforeRestart), {timeout: 30000});
  onlyParking();
  const afterRestart = await proof.liveEdit("afterRestart", "live", second.document);
  await vi.waitFor(() => expect(sibling()).toEqual({tip: [{tip_cursor: afterRestart.journalCursor}], applied: afterRestart.journalCursor, settled: afterRestart.journalCursor}), {timeout: 30000});
  expect(proof.journal(second.objectId)).toEqual([...secondJournal, journaled(during), journaled(afterRestart)]);
  const secondMarkdown = "---\nafterRestart: live\nbeforeActivation: ordinary-owner\nduringRetirement: live\n---\n\nSecond";
  expect(readFileSync(join(proof.store, "docs/b.md"), "utf8")).toBe(secondMarkdown);
  expect(proof.activations()).toEqual([retiring]);

  // Pushes reach the engine again. Its replica parks the document and the engine releases it, and that reply is lost.
  let lost: Record<string, any> | undefined;
  harness.withhold = {method: "liveApplication.releaseActivation", when: result => result.status === "released", held: result => {lost = result;}};
  const waiting = proof.unpushed();
  harness.unpublished = false;
  await vi.waitFor(() => expect(lost).toBeDefined(), {timeout: 30000});
  const receipt = {deliveryId: accepted.deliveryId, updateDigest: accepted.updateDigest, journalCursor: accepted.journalCursor, acceptingHostEpoch: accepted.acceptingHostEpoch};
  // Its boundary is its last receipt, after two events: its seed and the live edit.
  expect(lost).toEqual({status: "released", replayed: false, boundary: {terminalReceipt: receipt, eventCount: 2, historyEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/)}});
  expect(proof.hosted()).toEqual({state: "parked", reason: null});
  expect(proof.activations()).toEqual([retiring]);
  expect(proof.ownerTips()).toEqual({current: [{tip_cursor: accepted.journalCursor}], retired: []});
  // Without the reply the daemon goes, and the next one's release replays it.
  await proof.retire();
  await vi.waitFor(() => {
    expect(proof.activations()).toEqual([{...retiring, retired: 1, boundary: lost!.boundary, stateDropped: 1}]);
    expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toEqual(enrollment(expect.any(Number)));
  }, {timeout: 30000});
  expect(harness.releases.slice(-2)).toEqual([lost, {...lost, replayed: true}]);
  expect(harness.releases.slice(0, -2)).toEqual(harness.releases.slice(0, -2).map(() => parking));
  expect(harness.releases.length).toBeGreaterThan(beforeRestart + 2);
  // The relay keeps its owner delivery in history, holds what was waiting as it was written, and the store holds the edit.
  expect(proof.ownerTips()).toEqual({current: [], retired: [{activation_id: P, tip_cursor: accepted.journalCursor}]});
  expect(proof.unpushed()).toEqual([]);
  expect(proof.relayed(waiting)).toEqual(waiting.map(row => row.op_kind));
  expect(proof.journal()).toEqual([...journal, journaled(accepted)]);
  const stopped = "---\nbeforeActivation: ordinary-owner\nbeforeStop: live\n---\n\nHello";
  expect(readdirSync(join(proof.store, "docs"))).toEqual(["b.md"]);
  expect(proof.serviceRead(engine => engine.prepare("SELECT blob_sha256 FROM hosted_parked_snapshots WHERE workspace_id='workspace' AND object_id=?")
    .all(proof.objectId))).toEqual([{blob_sha256: hash(Buffer.from(stopped))}]);
  expect(await proof.documents()).toEqual([proof.ready("docs/b.md")]);

  // Its owner edits it on their device while it is stopped, so its state differs from the relay's journal. Resume activates a successor.
  await proof.ownerEdit(doc => doc.getMap("frontmatter").set("whileStopped", "ordinary-owner"));
  const captures = harness.captures.length;
  expect((await proof.route("POST", {shareId: "share"})).status).toBe(202);
  await vi.waitFor(async () => expect(await proof.documents()).toEqual([proof.ready("docs/a.md"), proof.ready("docs/b.md")]), {timeout: 30000});
  const successor = proof.activation()!, S = successor.activationId, resumed = await proof.hostState();
  const markdown = "---\nbeforeActivation: ordinary-owner\nbeforeStop: live\nwhileStopped: ordinary-owner\n---\n\nHello";
  expect(resumed).toEqual({digest: successor.source.fullStateDigest, markdown});
  expect(S).not.toBe(P); expect(successor.completed).toBe(true);
  expect(successor.source).toEqual({...predecessor.source, committedCursor: expect.any(Number), sourceMomentId: expect.stringMatching(/^moment-ydoc-apply-[0-9a-f]{64}$/),
    sourceDigest: hash(Buffer.from(markdown)), sourceByteLength: Buffer.byteLength(markdown), nativeHeadSequence: expect.any(Number),
    fullStateDigest: resumed.digest, fullStateByteLength: successor.fullState.byteLength, predecessorActivationId: P});
  // One capture, which asked for no activation of its own.
  expect(harness.captures.slice(captures)).toEqual([{activationId: S, requestedActivationId: undefined, source: successor.source}]);
  const retired = {...retiring, retired: 1, boundary: lost!.boundary, stateDropped: 1};
  const current = {activation_id: S, predecessor_activation_id: P, state_digest: resumed.digest, completed: 1, retire_accepted_cursor: null, retired: 0, boundary: null, stateDropped: 0};
  expect(proof.activations()).toEqual([retired, current]);
  // Its seed is the next row of the relay's journal: the owner's full state, which the session host applied and settled.
  const seed = afterRestart.journalCursor + 1, seeded = proof.deliveryAt(seed);
  expect(seeded.accepted).toMatch(/^owner-delivery-[0-9a-f]{64}$/); expect(seeded.applied).toBe(seeded.accepted);
  const seedRow = journaled({journalCursor: seed, deliveryId: seeded.accepted!, updateDigest: resumed.digest});
  expect(proof.journal()).toEqual([...journal, journaled(accepted), seedRow]);
  expect(proof.ownerTips()).toEqual({current: [{tip_cursor: seed}], retired: [{activation_id: P, tip_cursor: accepted.journalCursor}]});
  expect(proof.settlement()).toEqual({applied: seed, settled: seed});
  expect(proof.hosted()).toEqual({state: "ready", reason: null});
  expect(readFileSync(join(proof.store, "docs/a.md"), "utf8")).toBe(markdown);
  expect(readdirSync(proof.hostRoot)).toEqual([basename(proof.store)]);
  expect(readdirSync(join(proof.store, "docs"))).toEqual(["a.md", "b.md"]);

  // The collaborator edits it live through the successor.
  const collaborated = await proof.liveEdit("collaborator", "named", undefined, "collaborator");
  expect(proof.journal()).toEqual([...journal, journaled(accepted), seedRow, journaled(collaborated, "named", "grant")]);
  await vi.waitFor(() => {
    expect(proof.ownerTips()).toEqual({current: [{tip_cursor: collaborated.journalCursor}], retired: [{activation_id: P, tip_cursor: accepted.journalCursor}]});
    expect(proof.settlement()).toEqual({applied: collaborated.journalCursor, settled: collaborated.journalCursor});
  }, {timeout: 30000});
  const edited = "---\nbeforeActivation: ordinary-owner\nbeforeStop: live\ncollaborator: named\nwhileStopped: ordinary-owner\n---\n\nHello";
  expect((await proof.hostState()).markdown).toBe(edited);
  expect(readFileSync(join(proof.store, "docs/a.md"), "utf8")).toBe(edited);
  expect(proof.activations()).toEqual([retired, current]);
  expect(await proof.documents()).toEqual([proof.ready("docs/a.md"), proof.ready("docs/b.md")]);
  // docs/b.md holds exactly its own live edits.
  expect(proof.journal(second.objectId)).toEqual([...secondJournal, journaled(during), journaled(afterRestart)]);
  expect(readFileSync(join(proof.store, "docs/b.md"), "utf8")).toBe(secondMarkdown);
  return {predecessor: P, successor: S, releases: harness.releases, accepted, seed, collaborated};
}), 180000);

it("converges on the next pull after the reply to a hosted commit is lost, and applies nothing twice", () => withSelfHostProof("self-host-commit", async proof => {
  // The host pulls docs/b.md only once its owner wrote all of it.
  harness.unreachable.add("sync.pullHosted");
  const second = await proof.ownerDocument("docs/b.md", "Second"), objectId = second.objectId;
  let commit: Record<string, any> | undefined;
  // The engine commits the pass that writes docs/b.md, and the reply never arrives.
  harness.withhold = {method: "sync.commitCursor", held: result => {commit = result;},
    when: () => harness.pulls.at(-1)?.changedPaths.some((row: {path: string}) => row.path === "docs/b.md") === true};
  harness.unreachable.delete("sync.pullHosted");
  await vi.waitFor(() => expect(commit).toBeDefined(), {timeout: 30000});
  expect(commit!.committed).toBe(true);
  // The owner's rows of docs/b.md, and what the replica made of them: its moments, and the Y.Doc updates it imported.
  const rows = `SELECT origin_id,origin_seq,op_kind FROM %s WHERE workspace_id='workspace' AND json_extract(payload_json,'$.objectId')=? AND origin_id NOT LIKE 'service-host:%' ORDER BY origin_id,origin_seq`;
  const relayed = proof.relayRead.prepare(rows.replace("%s", "sync_relay_log")).all(objectId);
  const applied = () => proof.serviceRead(engine => ({rows: engine.prepare(rows.replace("%s", "replication_log")).all(objectId),
    moments: engine.prepare("SELECT moment_id FROM moments WHERE workspace_id='workspace' AND object_id=? ORDER BY moment_order").all(objectId).map(row => row.moment_id),
    updates: engine.prepare(`SELECT u.update_blob_sha256 FROM ydoc_updates u WHERE u.workspace_id='workspace' AND u.object_id=? AND EXISTS(SELECT 1 FROM replication_log l
      WHERE l.workspace_id=u.workspace_id AND l.imported=1 AND json_extract(l.payload_json,'$.updateBlobSha256')=u.update_blob_sha256) ORDER BY u.seq`).all(objectId).map(row => row.update_blob_sha256)}));
  const committed = applied();
  expect(relayed.map(row => row.op_kind)).toEqual(expect.arrayContaining(["moment.append", "ydoc.update"]));
  expect(committed.rows).toEqual(relayed);
  // Without the reply the daemon goes, as after its deadline, and the supervisor starts another.
  const pulls = harness.pulls.length;
  await proof.retire();
  await bothReady(proof);
  expect(harness.pulls.length).toBeGreaterThan(pulls);
  const converged = applied();
  expect(converged.rows).toEqual(relayed);
  expect(converged.updates).toEqual(committed.updates);
  // Any moment after the commit is the host's own settlement, never one applied again.
  expect(converged.moments.slice(0, committed.moments.length)).toEqual(committed.moments);
  expect(new Set(converged.moments).size).toBe(converged.moments.length);
  expect(proof.hosted(objectId)?.state).toBe("ready");
  expect(readFileSync(join(proof.store, "docs/b.md"), "utf8")).toBe(second.markdown());
  return {commit, relayed, committed, converged, pullsAfterReconnect: harness.pulls.slice(pulls)};
}), 120000);

it("resumes a document its owner edited while live editing was stopped as a successor that holds the edit", () => withSelfHostProof("self-host-refused", async proof => {
  const saved = proof.activation()!;
  await stopLiveEditing(proof);
  // The owner keeps editing on their device, where no session host admits the edit.
  await proof.ownerEdit(doc => doc.getMap("frontmatter").set("whileStopped", "ordinary-owner"));
  const attempts = () => proof.started("captureOwnerActivation"), before = attempts();
  expect((await proof.route("POST", {shareId: "share"})).status).toBe(202);
  await vi.waitFor(async () => expect(await proof.documents()).toEqual([proof.ready("docs/a.md")]), {timeout: 30000});
  // One capture, in the store it parked in, starts a successor holding the edit.
  expect(attempts()).toBe(before + 1);
  expect(proof.activation()!.source.predecessorActivationId).toBe(saved.activationId);
  const markdown = "---\nbeforeActivation: ordinary-owner\nwhileStopped: ordinary-owner\n---\n\nHello";
  expect((await proof.hostState()).markdown).toBe(markdown);
  expect(readFileSync(join(proof.store, "docs/a.md"), "utf8")).toBe(markdown);
  expect(proof.hosted()).toEqual({state: "ready", reason: null});
  expect(readdirSync(proof.hostRoot)).toEqual([basename(proof.store)]);
  // Later passes capture nothing more, while its workspace keeps pulling. Each
  // pass pulls once and waits 250 ms, so twelve outlast a two-second reconciliation.
  const pulls = harness.pulls.length;
  await vi.waitFor(() => expect(harness.pulls.length).toBeGreaterThan(pulls + 12), {timeout: 30000});
  expect(attempts()).toBe(before + 1);
  // The operator is told of nothing they need to do.
  expect(proof.reports.filter(report => report.startsWith("Live editing of docs/a.md"))).toEqual([]);
  return {attemptsBeforeResume: before, reports: proof.reports};
}), 120000);

// Pause keeps the document's activation, so its owner's ordinary edit made
// while paused reaches the host's replica as an edit that activation never
// admitted. The replica holds the document and capture stops. Resume through
// the enrollment route then retires the held activation.
it("holds a document its owner edited while paused, and Resume retires the held activation", () => withSelfHostProof("self-host-held", async proof => {
  const saved = proof.activation()!, P = saved.activationId, [seed] = proof.journal() as {journal_cursor: number; delivery_id: string; update_digest: string}[];
  expect(proof.journal()).toEqual([journaled({journalCursor: seed!.journal_cursor, deliveryId: seed!.delivery_id, updateDigest: seed!.update_digest})]);
  const completed = {activation_id: P, predecessor_activation_id: null, state_digest: saved.source.fullStateDigest, completed: 1,
    retire_accepted_cursor: null, retired: 0, boundary: null, stateDropped: 0};
  // The owner's ordinary Y.Doc updates of docs/a.md the relay holds.
  const ownerUpdates = () => proof.relayRead.prepare(`SELECT origin_id,origin_seq,json_extract(payload_json,'$.updateBlobSha256') AS update_sha256 FROM sync_relay_log
    WHERE workspace_id='workspace' AND op_kind='ydoc.update' AND json_extract(payload_json,'$.objectId')=? AND origin_id NOT LIKE 'service-host:%' ORDER BY origin_id,origin_seq`).all(proof.objectId);
  const refused = () => proof.serviceRead(engine => engine.prepare("SELECT origin_id,origin_seq,update_sha256 FROM replication_refused_ydoc_blobs ORDER BY origin_id,origin_seq").all());
  const attempts = () => proof.started("captureOwnerActivation");

  expect(await proof.route("DELETE", {path: "docs/a.md"})).toEqual({status: 200, body: {ok: true, path: "docs/a.md", status: "paused"}});
  await vi.waitFor(() => {
    expect(proof.hosted()).toEqual({state: "parked", reason: null});
    expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toMatchObject({ownerStop: "pause", enabled: false, retired: false, hostDrainedAtMs: expect.any(Number)});
  }, {timeout: 30000});
  expect(proof.activations()).toEqual([completed]);
  const before = ownerUpdates();
  await proof.ownerEdit(doc => doc.getMap("frontmatter").set("whilePaused", "ordinary-owner"));
  const edit = ownerUpdates().slice(before.length);
  expect(edit).toHaveLength(1);

  // Resume: the replica refuses that edit and holds the document, and capture stops.
  const captured = attempts();
  expect(await proof.route("POST", {path: "docs/a.md"})).toEqual({status: 202, body: {ok: true, path: "docs/a.md", status: "preparing"}});
  await vi.waitFor(async () => expect(await proof.documents()).toEqual([{path: "docs/a.md", status: "unavailable", reason: "live-edit-unadmitted"}]), {timeout: 30000});
  expect(proof.hosted()).toEqual({state: "held", reason: "hosted-live-edit-unadmitted"});
  expect(refused()).toEqual(edit);
  const held = attempts(), pulls = harness.pulls.length;
  expect(held).toBeGreaterThan(captured);
  await vi.waitFor(() => expect(harness.pulls.length).toBeGreaterThan(pulls + 12), {timeout: 30000});
  expect(attempts()).toBe(held);
  expect(proof.reports.filter(report => report.startsWith("Live editing of docs/a.md"))).toEqual([`Live editing of docs/a.md in workspace workspace cannot resume: the document changed while live editing was off, and the session host's copy is missing that edit. Its owner can keep editing it in dohc. Its store is kept at ${proof.store}.`]);
  expect(proof.activations()).toEqual([completed]);

  // Resume again: the enrollment route retires the held activation at its seed, and the relay keeps its owner delivery in history.
  expect(await proof.route("POST", {path: "docs/a.md"})).toEqual({status: 202, body: {ok: true, path: "docs/a.md", status: "preparing"}});
  const epoch = (proof.relayRead.prepare("SELECT accepting_host_epoch FROM sync_relay_live_update_journal WHERE workspace_id='workspace' AND object_id=? AND journal_cursor=?")
    .get(proof.objectId, seed!.journal_cursor) as {accepting_host_epoch: number}).accepting_host_epoch;
  const boundary = {terminalReceipt: {deliveryId: seed!.delivery_id, updateDigest: seed!.update_digest, journalCursor: seed!.journal_cursor, acceptingHostEpoch: epoch},
    eventCount: 1, historyEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/)};
  await vi.waitFor(() => expect(proof.activations()).toEqual([{...completed, retire_accepted_cursor: seed!.journal_cursor, retired: 1, boundary, stateDropped: 1}]), {timeout: 30000});
  expect(proof.ownerTips()).toEqual({current: [], retired: [{activation_id: P, tip_cursor: seed!.journal_cursor}]});
  expect(proof.storage.readServiceHostEnrollment("workspace", "docs/a.md")).toMatchObject({ownerStop: null, enabled: true, retired: false});
  expect(proof.journal()).toEqual([journaled({journalCursor: seed!.journal_cursor, deliveryId: seed!.delivery_id, updateDigest: seed!.update_digest})]);
  return {activationId: P, refused: edit, attempts: held};
}), 120000);

// Until the session host starts a document's Y.Doc itself (#2069), a file only
// written as text has nothing to activate, so it blocks instead of retrying.
// Its owner only opens it, as the Notice tells them, and the lineage that
// reaches the relay gives it one more attempt, which activates it.
it("blocks a document written only as text, and activates it once its owner opens it", () => withSelfHostProof("self-host-without-lineage", async proof => {
  const attempts = () => proof.started("captureOwnerActivation"), from = harness.calls.length;
  const failures = () => harness.calls.slice(from).filter(call => call.method === "captureOwnerActivation" && call.status === "failed").map(call => call.message);
  const plain = await proof.ownerDocument("docs/plain.md", "Written as text", {seeded: false});
  const refused = {path: "docs/plain.md", status: "unavailable", reason: "live-document-without-lineage"};
  await vi.waitFor(async () => expect(await proof.documents()).toContainEqual(refused), {timeout: 30000});
  expect(failures().at(-1)).toContain("live-document-without-lineage");
  expect(failures().filter(message => !message?.includes("hosted-document-unready"))).toEqual([expect.stringContaining("live-document-without-lineage")]);
  // Later passes leave it alone, while its workspace keeps pulling.
  const blocked = attempts(), pulls = harness.pulls.length;
  await vi.waitFor(() => expect(harness.pulls.length).toBeGreaterThan(pulls + 12), {timeout: 30000});
  expect(attempts()).toBe(blocked);
  expect(proof.reports.filter(report => report.startsWith("Live editing of docs/plain.md"))).toEqual([
    `Live editing of docs/plain.md in workspace workspace cannot start: the document has no live-editing history. It starts once its owner opens it in dohc on a desktop. Its store is kept at ${proof.store}.`]);
  // Its owner opens it on their device without changing it, which starts its Y.Doc and pushes it to the relay.
  // The next pass pulls it into the host's replica and captures once more, with no Resume.
  await plain.open();
  await vi.waitFor(async () => expect(await proof.documents()).toContainEqual(expect.objectContaining({path: "docs/plain.md", status: "ready"})), {timeout: 30000});
  expect(attempts()).toBe(blocked + 1);
  const claim = proof.serviceRead(engine => engine.prepare("SELECT lineage_claim_status AS status, lineage_claim_id AS id FROM ydoc_docs WHERE workspace_id='workspace' AND object_id=?")
    .get(plain.objectId)) as {status: string; id: string | null} | undefined;
  expect(claim?.status).toBe("exact");
  expect(proof.activation("docs/plain.md")?.source.lineageClaimId).toBe(claim!.id);
  return {attemptsBeforeOpen: blocked, failures: failures(), reports: proof.reports};
}), 120000);

// #2088: the operator puts back an older copy of the session host's store,
// which lost live edits the host already pushed. The next attach finds that
// before anyone edits: the workspace detaches, no capture runs, and the relay
// keeps exactly what the host pushed.
it("detaches a store restored from an older copy before anyone edits it", () => withSelfHostProof("self-host-restored", async proof => {
  const objectId = proof.activation()!.source.objectId, document = {workspaceId: "workspace", objectId};
  // A link holder with Edit, asking the relay to open docs/a.md live.
  const linkKey = Buffer.alloc(32, 7), bearer = Buffer.alloc(32, 1).toString("base64url"), now = Date.now();
  expect(proof.storage.createLinkGrant({grant: {grantId: "link-grant", shareId: "share", principalKind: "link", principalUserId: null, principalEmail: null,
    access: "edit", generation: 1, status: "active", createdAtMs: now, revokedAtMs: null, parentGrantId: null},
  credential: {credentialId: "link-credential", grantId: "link-grant", secretHash: "s".repeat(64), generation: 1, mintedAtMs: now, retiredAtMs: null}})).toBe(true);
  expect(proof.storage.mintLinkSession({session: {sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, linkKey), grantId: "link-grant",
    generation: 1, mintedAtMs: now, expiresAtMs: now + 600_000}})).toBe(true);
  const linkHttp = createLinkLiveHttp({publicEditRelease:{version:1},storage: proof.storage, linkKey, hosts: new Set(["relay.test"]), publicOrigin: audience, exchangeKey,
    limits: routeLimits, sessionHostBlocked: proof.sessionHostBlocked});
  const openLive = async () => {
    const response = await linkHttp(new Request("https://relay.test/sync/live/link-document", {method: "POST",
      body: JSON.stringify({discriminator: "abcdefghijkl", path: "docs/a.md"}), headers: {host: "relay.test", origin: audience, "content-type": "application/json",
        "x-dohc-relay-exchange-key": exchangeKey, authorization: `Bearer ${bearer}`, "x-dohc-link-profile-secret": Buffer.alloc(32, 2).toString("base64url")}}));
    return {status: response.status, body: await response.json() as unknown};
  };
  expect(await openLive()).toEqual({status: 200, body: {objectId}});

  const [origin, numbered] = proof.serviceRead(engine => [(engine.prepare("SELECT origin_id FROM sync_identity WHERE workspace_id='workspace'").get() as {origin_id: string}).origin_id,
    (engine.prepare("SELECT last_outbound_seq FROM hosted_replicas WHERE workspace_id='workspace'").get() as {last_outbound_seq: number}).last_outbound_seq] as const);
  const relayRows = () => proof.relayRead.prepare("SELECT origin_seq,op_kind,payload_json FROM sync_relay_log WHERE workspace_id='workspace' AND origin_id=? ORDER BY origin_seq").all(origin);
  // The operator's older copy, taken while the daemon is stopped.
  await proof.stopSupervisor();
  const saved = join(proof.root, "older-store");
  cpSync(proof.store, saved, {recursive: true});
  await proof.startSupervisor();
  await vi.waitFor(async () => expect(await proof.documents()).toEqual([expect.objectContaining({path: "docs/a.md", status: "ready"})]), {timeout: 30000});
  // Live edits the host accepts and pushes after the copy.
  for (const value of ["one", "two"]) await proof.liveEdit(`afterCopy-${value}`, "live");
  await vi.waitFor(() => {
    expect(proof.unpushed()).toEqual([]);
    expect(relayRows().length).toBeGreaterThan(numbered + 1);
  }, {timeout: 30000});
  await proof.stopSupervisor();
  const pushed = relayRows();

  // The operator puts the older copy back, and the relay starts again.
  rmSync(proof.store, {recursive: true, force: true});
  cpSync(saved, proof.store, {recursive: true});
  expect(proof.serviceRead(engine => (engine.prepare("SELECT last_outbound_seq FROM hosted_replicas WHERE workspace_id='workspace'").get() as {last_outbound_seq: number}).last_outbound_seq)).toBe(numbered);
  const marker = `${proof.store}.diverged`, from = harness.calls.length, seen: string[] = [];
  expect(existsSync(marker)).toBe(false);
  await proof.startSupervisor();
  await vi.waitFor(async () => {
    const answer = (await proof.route("GET")).body;
    seen.push(...(answer.documents as {status: string}[]).map(row => row.status));
    expect(answer).toMatchObject({diverged: true, documents: [{path: "docs/a.md", status: "unavailable", reason: "session-host-diverged"}]});
    expect(existsSync(marker)).toBe(true);
  }, {timeout: 30000});
  expect(seen).not.toContain("ready");
  expect(proof.reports).toContainEqual(expect.stringContaining("The live editing copy of workspace workspace diverged from the relay."));
  const calls = harness.calls.slice(from);
  expect(calls).toContainEqual(expect.objectContaining({method: "sync.createHostedReplica", status: "failed", message: expect.stringContaining("relay-origin-diverged")}));
  for (const method of ["sync.pullHosted", "sync.push", "captureOwnerActivation"]) expect(calls.filter(call => call.method === method)).toEqual([]);
  expect(await openLive()).toEqual({status: 503, body: linkRefusalBody("link_live_unavailable")});
  expect(relayRows()).toEqual(pushed);
  return {origin, numbered, pushed: pushed.map(row => row.origin_seq), calls};
}), 120000);
