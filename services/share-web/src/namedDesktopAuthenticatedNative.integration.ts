import { createNamedDesktopLive as createDesktopAdmission } from "../../sync-relay/src/namedDesktopLive.js";
import { createLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLiveHostReports } from "../../sync-relay/src/namedLiveHostReports.js";
import { createNamedDesktopLiveCapture } from "../../../apps/desktop/src/workspaces/namedDesktopLive.js";
import { preserveNamedLiveDraft } from "../../../apps/desktop/src/workspaces/namedLiveDraftRecovery.js";
import { createEngineYDocSessionIpc } from "../../../apps/desktop/src/workspaces/engineYDocSessionIpc.js";
import { bindEngineYDoc, EngineYDocDeliveryRefusedError } from "../../../apps/desktop/src/renderer/collab/engineYDocProvider.js";
import { CHANNELS } from "../../../apps/desktop/src/ipc/channels.js";
import { EngineYDocRemoteUpdateEvent, EngineYDocSaveStateEvent } from "../../../apps/desktop/src/ipc/bridgeContract.js";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { fileURLToPath } from "node:url";
import {createNamedLiveRoutes} from "../../sync-relay/src/namedLiveRoutes.js";
import { once, EventEmitter } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { createNamedFrameChanges } from "../../sync-relay/src/liveHostChanges.js";

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
const exchangeKey = "native-network-exchange-".repeat(2);
// Selected explicitly by the sealed proof runner. Never skipped for missing prerequisites.
it("edits and pauses through the desktop capture, IPC, renderer mirror and a real native host over TLS", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned owner proof binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1 are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(resolve(output), "desktop-named-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const schema = `desktop_named_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
  let schemaCreated = false;
  const certificate = new URL("./testing/device-control/localhost-cert.pem", import.meta.url);
  if (resolve(process.env.NODE_EXTRA_CA_CERTS ?? "") !== fileURLToPath(certificate)) throw new Error("Launch the proof child with its fixture CA in NODE_EXTRA_CA_CERTS.");
  const publicHttps = createHttpsServer({key: readFileSync(new URL("./testing/device-control/localhost-key.pem", import.meta.url)), cert: readFileSync(certificate)});
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
  const ownerUser = (await auth.api.signUpEmail({body: {email: "owner@example.test", password, name: "Owner"}})).user;
  const seed = await createEngineClient({ command: executable, env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: undefined}, authToken: "owner-proof-seed", protocolVersion: 2, capabilities: ["core"], connectTimeoutMs: 30000 });
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
    restore: {maxBytes: 1000000, maxEvents: 100, aggregateBytes: 20000000, workingReserveBytes: 1000000, maxOperations: 1, validation: validationPolicy},
    sync: { policy: { maxClientVectorBytes: 100000, maxHostVectorBytes: 100000, maxOutputBytes: 1000000, maxReadBytes: 4000000 }, workingReserveBytes: 4000000 },
    ingress: { aggregateBytes: 400000000, applicationWorkingReserveBytes: 1000000, maxUploads: 4, uploadDeadlineMs: 30000 },
    client: { aggregateBytes: 200000000, maxUploads: 4, connectTimeoutMs: 30000, requestDeadlineMs: 30000 } }));
  const ownerDoc = markdownToYDoc("Hello"), sharedChanges = createNamedFrameChanges(16), validate = createLiveMarkdownJournalValidator(validationPolicy);
  const frameChanges = sharedChanges;
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  const closes: (() => Promise<void>)[] = [], upgrades: Promise<void>[] = [];

  const results: Record<string, unknown> = {};
  try {
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
      payloadJson: JSON.stringify({ objectId: "object", momentId: "baseline", versionId: mainVersionId!, recordedAtMs: 2, operation: "write", path: "docs/a.md", metadata: { origin: "sync" }, beforePresent: "absent",
        payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: evidence.projectedMarkdownSha256, payloadAfterContentKind: "text", payloadAfterByteLength: evidence.projectedMarkdownByteLength }) }] });
    storage.putBlob({workspaceId: "workspace", sha256: hash(baseline), content: baseline, createdAtMs: 2});
    storage.appendLogBatch({workspaceId: "workspace", originId: "owner", ops: [{originSeq: 1, opKind: "ydoc.update", recordedAtMs: 2,
      payloadJson: JSON.stringify({versionId: mainVersionId!, objectId: "object", path: "docs/a.md", contentKind: "richdoc",
        updateBlobSha256: hash(baseline), lineageClaimId: hash(baseline), isBaseState: true})}]});
    expect(storage.registerLiveDocumentBaseline({ host: active.coordinate, evidence, baselineBytes: baseline, registeredAtMs: 3 }).kind).toBe("registered");
    for (const [index, user] of users.entries()) storage.createShare({
      share: { shareId: `share-${index}`, workspaceId: "workspace", granterUserId: ownerUser.id, selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 3 },
      grant: { grantId: `grant-${index}`, shareId: `share-${index}`, principalKind: "user", principalUserId: user.id, principalEmail: null, access: "edit", generation: 1,
        status: "active", createdAtMs: 3, revokedAtMs: null, parentGrantId: null } });
    const resolveActor = createSessionActorResolver(relayAuth);
    const relayApp = createSyncRelayHandler({storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      namedBrowserSessionLimits: {...browserLimits, maxSessions: 16, retentionMs: 120000}, resolveActor});
    const captureNative: Parameters<typeof createLiveHostReports>[0]["captureNative"] = async binding => {
      if (!active) throw new Error("The native host is offline.");
      return active.captureNative(binding);
    };
    const tickets = createLiveTickets({storage, audience, key: "desktop-proof-ticket-key-".repeat(2),
      hostReports: createLiveHostReports({storage, captureNative})});
    const hosts = new Set([new URL(audience).host]);
    const admission = createDesktopAdmission({storage, resolveActor, publicOrigin: audience, hosts, tickets,
      limits: {...browserLimits, maxSessions: 16, retentionMs: 120000},
      editorLimits: {provider: {frames, maxPendingUpdateBytes: 2000000, maxPendingUpdates: 4, maxDeliveryAttempts: 3},
        maxHttpResponseBytes: 8192, maxSocketBufferedBytes: 2000000, connectTimeoutMs: 30000, sendTimeoutMs: 30000, drainPollMs: 10}});
    const routes = createNamedLiveRoutes({kind: "named", desktopBearer: true, storage, hosts, publicOrigin: audience,
      exchangeKey, frames, limits: routeLimits,
      bounds: {maxClientVectorBytes: 100000, maxSyncOutputBytes: 1000000, maxAppliedUpdateBytes: 1000000,
        maxSubmissionBytes: 1000000, maxAdmissionBytes: 4000000}, validate, sessions: {resolve: admission.resolve}, tickets, captureNative});
    closes.push(async () => routes.close());
    const httpAdapter = serveFetchHandler({handler: request => {
      const path = new URL(request.url).pathname;
      return path === "/sync/live/desktop-open" ? admission.handle(request)
        : path.startsWith("/sync/live/desktop") ? routes.handle(request) : relayApp(request);
    }, maxBodyBytes: () => 8192, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
    publicHttps.on("request", (request, response) => httpAdapter.emit("request", request, response));
    publicHttps.on("upgrade", (request, socket, head) => {upgrades.push(routes.handleUpgrade(request, socket, head));});
    const tokens = await Promise.all(users.map(async user => (await auth.api.signInEmail({body: {email: user.email, password}})).token));
    let nextSenderId = 1;
    let ordinaryCaptureCalls = 0;
    async function desktop(index: number, suffix: string, overrides: {token?: string; shareId?: string; current?: boolean} = {}) {
      const localWorkspaceId = `local-${index}-${suffix}`, localRoot = join(root, localWorkspaceId);
      mkdirSync(join(localRoot, "docs"), {recursive: true}); writeFileSync(join(localRoot, "docs/a.md"), "Hello");
      const events = new EventEmitter();
      const sender = Object.assign(events, {id: nextSenderId++, isDestroyed: () => false,
        send(channel: string, payload: unknown) {events.emit(channel, payload);}});
      let current = overrides.current ?? true, sequence = 0;
      const assertCurrent = () => {if (!current) throw new Error("Workspace selection changed.");};
      const credentials = new AbortController();
      const capture = createNamedDesktopLiveCapture({shareId: overrides.shareId ?? `share-${index}`,
        selector: {access: "edit", versionId: null, paths: ["docs"]},
        credentials: {relayUrl: audience, token: overrides.token ?? tokens[index]!, userId: users[index]!.id, signal: credentials.signal},
        assertCurrent, preserveDraft: draft => preserveNamedLiveDraft(join(root, "profile"), localWorkspaceId, draft)});
      const ipc = createEngineYDocSessionIpc({sessionFor: () => ({workspaceId: localWorkspaceId, generation: 1, isCurrent: () => current}),
        acquireWorkspace: () => ({workspace: {workspaceId: localWorkspaceId, rootPath: localRoot, attachmentId: Symbol.for(localWorkspaceId)}, assertCurrent, release() {}}),
        captureFor: () => {ordinaryCaptureCalls++; throw new Error("Ordinary capture must not handle shared live editing.");},
        ensureCaptureFor: async () => {ordinaryCaptureCalls++; throw new Error("Ordinary capture must not handle shared live editing.");},
        isSharedView: () => true, sharedCaptureFor: async () => capture, resolveDocumentPath: async (_workspace, path) => path,
        onError: () => {}});
      const sessionId = `${localWorkspaceId}-session`;
      const states: EngineYDocSaveStateEvent[] = [];
      sender.on(CHANNELS.engineYDocSaveState, payload => states.push(EngineYDocSaveStateEvent.parse(payload)));
      const mirror = await bindEngineYDoc({initializeDoc(doc) {getDohcYDocBodyFragment(doc); doc.getMap("frontmatter");},
        open: () => ipc.open(sender, {workspaceId: localWorkspaceId, sessionId, path: "docs/a.md"}),
        stageLocalUpdate: () => current ? ++sequence : null,
        applyLocalUpdate(update, seq, lineageGeneration) {
          const result = ipc.applyUpdate(sender, {sessionId, update, seq, lineageGeneration});
          if (!result.accepted) throw new EngineYDocDeliveryRefusedError(result.reason);
        },
        onRemoteUpdate(listener) {
          const receive = (payload: unknown) => {const value = EngineYDocRemoteUpdateEvent.parse(payload); listener(value.update, value.lineageGeneration);};
          sender.on(CHANNELS.engineYDocRemoteUpdate, receive); return () => {sender.off(CHANNELS.engineYDocRemoteUpdate, receive);};
        },
        onLineageReplacement: () => () => {}, acknowledgeLineageReplacement: async () => [], close: () => ipc.close(sender, {sessionId})});
      const client = {mirror, sender, states, ipc, localRoot, retire: () => {current = false;},
        close: async () => {await mirror.destroy(); await ipc.shutdown(); credentials.abort();}};
      closes.push(client.close);
      return client;
    }
    function saveWhen(client: Awaited<ReturnType<typeof desktop>>, state: EngineYDocSaveStateEvent["state"]) {
      const previous = client.states.find(event => event.state === state);
      if (previous) return Promise.resolve(previous);
      return new Promise<EngineYDocSaveStateEvent>((resolve, reject) => {
        const timer = setTimeout(() => {client.sender.off(CHANNELS.engineYDocSaveState, receive); reject(new Error(`Missing ${state} save event.`));}, 30000);
        const receive = (payload: unknown) => {const event = EngineYDocSaveStateEvent.parse(payload); if (event.state !== state) return;
          clearTimeout(timer); client.sender.off(CHANNELS.engineYDocSaveState, receive); resolve(event);};
        client.sender.on(CHANNELS.engineYDocSaveState, receive);
      });
    }
    function fieldWhen(doc: Y.Doc, name: string, value: string) {
      const fields = doc.getMap("frontmatter");
      if (fields.get(name) === value) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {fields.unobserve(check); reject(new Error(`Missing peer field ${name}.`));}, 30000);
        const check = () => {if (fields.get(name) !== value) return; clearTimeout(timer); fields.unobserve(check); resolve();};
        fields.observe(check);
      });
    }
    const first = await desktop(0, "first"), peer = await desktop(1, "peer");
    expect(first.mirror.available).toBe(true); expect(peer.mirror.available).toBe(true);
    if (!first.mirror.doc || !peer.mirror.doc) throw new Error("Missing live renderer mirrors.");
    expect(yDocToMarkdown(first.mirror.doc)).toBe("Hello"); expect(yDocToMarkdown(peer.mirror.doc)).toBe("Hello");
    const peerSeen = fieldWhen(peer.mirror.doc, "title", "desktop-over-tls"), saved = saveWhen(first, "saved");
    let localUpdate!: Uint8Array;
    first.mirror.doc.once("update", update => {localUpdate = update.slice();});
    first.mirror.doc.getMap("frontmatter").set("title", "desktop-over-tls");
    await first.mirror.flushPendingLocalUpdates();
    const saveEvent = await saved; await peerSeen;
    expect(saveEvent.seq).toBe(1);
    expect(readFileSync(join(first.localRoot, "docs/a.md"), "utf8")).toBe("Hello");
    expect(readFileSync(join(peer.localRoot, "docs/a.md"), "utf8")).toBe("Hello");
    expect(ordinaryCaptureCalls).toBe(0);
    const actor = {kind: "owner", userId: ownerUser.id, shareId: "share-0"} as const;
    const binding = storage.resolveCurrentLiveDocumentBinding({document, actor});
    if (binding.kind !== "current") throw new Error("Missing current binding.");
    const native = await active.captureNative(binding.binding);
    const engine = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), {readOnly: true});
    try {
      const application = engine.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications WHERE update_digest = ?").get(hash(localUpdate));
      expect(application).toBeDefined();
      const ack = await native.client.readLiveApplicationAck({id: native.nextRequestId(), workspace: native.workspace,
        registrationId: native.registrationId, deadlineMs: native.deadlineMs},
        {deliveryId: application!.delivery_id as string, updateDigest: hash(localUpdate)});
      expect(ack).toMatchObject({deliveryId: application!.delivery_id, updateDigest: hash(localUpdate)});
      results.nativeAck = ack;
    } finally {engine.close();}
    const settlement = await active.settle(document); expect(settlement.materialized).toBe(true);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe(yDocToMarkdown(first.mirror.doc));
    results.edit = {saveEvent, peerMarkdown: yDocToMarkdown(peer.mirror.doc), ordinaryCaptureCalls, localMarkdown: "Hello", settlement};
    const wrong = await desktop(0, "wrong-bearer", {token: tokens[1]});
    expect(wrong.mirror.available).toBe(false); expect(wrong.mirror.liveHostUnavailable).toBe(true);
    const stale = await desktop(0, "stale", {current: false}); expect(stale.mirror.available).toBe(false);
    const paused = [saveWhen(first, "read-only"), saveWhen(peer, "read-only")];
    await active.close(); active = undefined; await Promise.all(paused);
    const unavailable = await desktop(0, "offline");
    expect(unavailable.mirror.available).toBe(false); expect(unavailable.mirror.liveHostUnavailable).toBe(true);
    expect(readFileSync(join(unavailable.localRoot, "docs/a.md"), "utf8")).toBe("Hello");
    active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});
    const reopened = await desktop(0, "reopened"); expect(reopened.mirror.available).toBe(true);
    if (!reopened.mirror.doc) throw new Error("Missing reopened live renderer mirror.");
    expect(yDocToMarkdown(reopened.mirror.doc)).toBe(yDocToMarkdown(first.mirror.doc));
    expect(ordinaryCaptureCalls).toBe(0);
    results.lifecycle = {wrongBearerRefused: true, staleSelectionRefused: true, hostLossReadOnly: true, offlineOpenReadOnly: true, freshOpenAfterRestart: true};
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
      scope: "Real BetterAuth bearer admission, production desktop capture, IPC session and renderer Y.Doc mirror, TLS/WSS, two named principals, native application ACK and service settlement, host-loss and explicit reopen",
      omissions: ["Electron window and UI rendering", "Pending-draft write failure and recovery UI", "Configured ordinary-import activation", "Admitted-load matrix"], results}, null, 2));
  } finally {
    for (const close of closes.reverse()) await close();
    await Promise.allSettled(upgrades);
    await active?.close(); deployment.storage.close(); ownerDoc.destroy();
  }
  } finally {
    publicHttps.closeAllConnections(); await new Promise<void>(done => publicHttps.close(() => done()));
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 180000);
