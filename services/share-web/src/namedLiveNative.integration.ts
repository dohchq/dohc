import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { getCookies } from "better-auth/cookies";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import { createEngineClient } from "../../../packages/workspace-engine-client/src/daemon/engineClient.js";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
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
import { createNamedLiveProvider, type NamedLiveProviderState } from "../viewer/src/namedLiveProvider.js";

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
const cookie = `${getCookies({ baseURL: audience }).sessionToken.name}=reader-proof`;
type Provider = ReturnType<typeof createNamedLiveProvider>;

function stateWhen(provider: Provider, condition: (state: NamedLiveProviderState) => boolean): Promise<NamedLiveProviderState> {
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
async function post(port: number, path: string, input: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: {
      host: new URL(audience).host, origin: audience, cookie, "content-type": "application/json" } }, response => {
      const bytes: Buffer[] = []; response.on("data", chunk => bytes.push(Buffer.from(chunk)));
      response.once("end", () => resolve(new Response(Buffer.concat(bytes), { status: response.statusCode })));
      response.once("error", reject);
    });
    request.once("error", reject); request.end(JSON.stringify(input));
  });
}

// Opt-in integration filename. The pinned serial harness must select this file explicitly.
it("preserves native ACKs, accepted feed, and registration lifetime through the public named network chain", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned named network proof binary, digest, and output are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(resolve(output), "named-network-")), workspace = join(root, "workspace"); mkdirSync(workspace);
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
    storage.createShare({ share: { shareId: "share", workspaceId: "workspace", granterUserId: "owner", selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 3 },
      grant: { grantId: "grant", shareId: "share", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "edit", generation: 1,
        status: "active", createdAtMs: 3, revokedAtMs: null, parentGrantId: null } });
    const relayApp = createSyncRelayHandler({ storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      namedBrowserSessionLimits: { ...browserLimits, maxSessions: 8, retentionMs: 120000 },
      resolveActor: async (request, workspaceId) => { if (request.headers.get("cookie") !== cookie) throw new UnauthorizedError(); return { userId: "reader", workspaceId }; } });
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
      accountAuth: { publicOrigin: audience, upstreamUrl: "http://127.0.0.1:1" }, namedBrowserSessionLimits: browserLimits, namedLiveTickets: true });
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
    const bootstrap = await post(port, "/api/live/named-session", { grantId: "grant" }); expect(bootstrap.status).toBe(200);
    const { discriminator } = await bootstrap.json() as { discriminator: string };
    async function browser() {
      const minted = await post(port, "/api/live/named-ticket", { discriminator, objectId: document.objectId }); expect(minted.status).toBe(200);
      const { token } = await minted.json() as { token: string };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?session=${discriminator}`, ["dohc-live-v1", `dohc-live-ticket.${token}`], {
        headers: { host: new URL(audience).host, origin: audience, cookie }, perMessageDeflate: false });
      sockets.push(ws); ws.on("error", () => undefined);
      const pending: Buffer[] = []; let route: ReturnType<Provider["connect"]> | undefined;
      ws.on("message", bytes => { const owned = Buffer.from(bytes as Buffer); if (route) void route.receive(owned); else pending.push(owned); });
      ws.once("close", () => route?.disconnect());
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject);
        ws.once("unexpected-response", (_request, response) => { response.resume(); reject(new Error(`Upgrade returned ${response.statusCode}`)); ws.terminate(); }); });
      const provider = createNamedLiveProvider({ frames, maxPendingUpdateBytes: 2000000, maxPendingUpdates: 4, maxDeliveryAttempts: 3 }); providers.push(provider);
      route = provider.connect({ send(bytes) { return new Promise<void>((resolve, reject) => ws.send(bytes, { binary: true, compress: false }, error => error ? reject(error) : resolve())); }, close() { ws.terminate(); } });
      for (const bytes of pending) void route.receive(bytes);
      await stateWhen(provider, state => state.status === "live");
      return { provider, ws, token };
    }
    const first = await browser(), peer = await browser();
    expect(yDocToMarkdown(first.provider.doc)).toBe("Hello"); expect(yDocToMarkdown(peer.provider.doc)).toBe("Hello");
    const actor = { kind: "owner", userId: "owner", shareId: "share" } as const;
    const current = storage.resolveCurrentLiveDocumentBinding({ document, actor }); if (current.kind !== "current") throw new Error("Current binding unavailable.");
    const capture = await active.captureNative(current.binding);
    results.registrationId = capture.registrationId;
    const nativeRequest = () => ({ id: capture.nextRequestId(), workspace: capture.workspace, registrationId: capture.registrationId, deadlineMs: capture.deadlineMs });
    let localBytes!: Uint8Array;
    first.provider.doc.once("update", bytes => { localBytes = bytes.slice(); });
    const peerSawBrowser = fieldWhen(peer.provider, "title", "from-browser");
    first.provider.doc.getMap("frontmatter").set("title", "from-browser");
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
    const peerAfterSettlement = fieldWhen(peer.provider, "after", "settlement");
    first.provider.doc.getMap("frontmatter").set("after", "settlement");
    const afterAck = (await stateWhen(first.provider, state => state.pendingUpdates === 0 && (state.lastApplied?.journalCursor ?? 0) > browserAck.journalCursor)).lastApplied!;
    await peerAfterSettlement; results.afterSettlementAck = afterAck;
    expect(capture.invalidated.aborted).toBe(false); expect((await active.captureNative(current.binding)).registrationId).toBe(capture.registrationId);
    await active.settle(document);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(first.provider.doc));
    const disconnected = sockets.map(socket => new Promise<void>(done => socket.once("close", () => done())));
    storage.revokeShareGrant({ shareId: "share", grantId: "grant", revokedAtMs: Date.now(), expectedDependentGrantIds: [], guard: storage.captureStanding() });
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
      scope: "Real public HTTP/WS, relay storage/admission, service daemon, and browser Yjs provider; test account resolver", results }, null, 2));
  } finally {
    for (const provider of providers) { provider.close(); provider.doc.destroy(); }
    sockets.forEach(socket => socket.terminate());
    for (const close of closes.reverse()) await close();
    await Promise.allSettled(upgrades);
    await active?.close(); deployment.storage.close(); ownerDoc.destroy();
  }
}, 90000);
