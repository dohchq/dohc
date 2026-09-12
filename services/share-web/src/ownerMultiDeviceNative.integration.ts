import type {NamedFrameNativeHost} from "../../sync-relay/src/namedLiveFrameHost.js";
import {createOwnerLiveRoutes} from "../../sync-relay/src/namedLiveRoutes.js";
import { once } from "node:events";
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
import { createEngineClient, EngineRequestError } from "../../../packages/workspace-engine-client/src/daemon/engineClient.js";
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
import {openEngineYdocProviderSession} from "../../../packages/workspace-engine-client/src/ydoc/ydocProviderSession.js";
import {YdocOwnerDraftPendingError} from "../../../packages/workspace-engine-client/src/ydoc/ydocLiveAdapter.js";
import {isLiveSettlementCapacityRefusal} from "../../../packages/workspace-engine-client/src/live/daemonLiveAdapter.js";
import {runNativeOwnerDeliveryPass} from "../../../apps/desktop/src/workspaces/nativeOwnerDelivery.js";
import {startDesktopOwnerDelivery} from "../../../apps/desktop/src/workspaces/desktopOwnerDelivery.js";
import type {OwnerYDocDrainResult} from "../../../apps/desktop/src/workspaces/ownerYDocOutbox.js";
import {OwnerYDocOutbox} from "../../../packages/workspace-engine-client/src/ydoc/ownerYDocOutbox.js";
// Selected explicitly by the sealed proof runner. Never skipped for missing prerequisites.
it("preserves and delivers owner drafts across two real native replicas and authenticated WS", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY ? resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY) : undefined;
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned owner proof binary, digest, and output are required.");
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString || process.env.DOHC_REQUIRE_POSTGRES !== "1") throw new Error("Explicit POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1 are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(resolve(output), "owner-multi-device-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const schema = `owner_native_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
  let schemaCreated = false;
  const audience = "https://owner-proof.example.test";
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
  const ownerClients = new Set<Awaited<ReturnType<typeof createEngineClient>>>();
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
      payloadJson: JSON.stringify({ objectId: "object", momentId: "baseline", versionId: mainVersionId!, recordedAtMs: 2, operation: "write", path: "docs/a.md",
        metadata: {origin: "sync"}, beforePresent: "absent",
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
    const relayApp = createSyncRelayHandler({ storage, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      namedBrowserSessionLimits: { ...browserLimits, maxSessions: 8, retentionMs: 120000 },
      resolveActor: createSessionActorResolver(relayAuth), ownerRestoreHost: () => active });
    let routes!: ReturnType<typeof createOwnerLiveRoutes>;
    const relayHttp = serveFetchHandler({ handler: request => new URL(request.url).pathname === "/sync/live/named-tickets" ? routes.handle(request) : relayApp(request),
      maxBodyBytes: () => 8192, oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as { port: number }).port}`;
    let heldFeed: {digest: string; release: Promise<void>} | undefined;
    let heldCapture: {remaining: number; arrived(): void; release: Promise<void>} | undefined;
    const captureNative = async (...args: Parameters<NonNullable<typeof active>["captureNative"]>): Promise<NamedFrameNativeHost> => {
      const barrier = heldCapture;
      if (barrier && --barrier.remaining === 0) {
        barrier.arrived();
        await barrier.release;
        heldCapture = undefined;
      }
      const native = await active!.captureNative(...args);
      return {...native, client: {
        openLiveAppliedSync: native.client.openLiveAppliedSync.bind(native.client),
        readLiveApplicationAck: native.client.readLiveApplicationAck.bind(native.client),
        async readNextLiveApplied(...params: Parameters<typeof native.client.readNextLiveApplied>) {
          const next = await native.client.readNextLiveApplied(...params);
          const barrier = heldFeed;
          if (barrier && next?.ack.updateDigest === barrier.digest) await barrier.release;
          return next;
        },
      }};
    };
    routes = createOwnerLiveRoutes({ storage, hosts: new Set([new URL(relayUrl).host]), publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: { maxClientVectorBytes: 100000, maxSyncOutputBytes: 1000000, maxAppliedUpdateBytes: 1000000, maxSubmissionBytes: 1000000, maxAdmissionBytes: 4000000 },
      validate, resolveActor: createSessionActorResolver(relayAuth), captureNative });
    closes.push(async () => routes.close());
    relayHttp.on("upgrade", (request, socket, head) => { upgrades.push(routes.handleUpgrade(request, socket, head)); });
    const signedIn = await auth.api.signInEmail({body: {email: ownerUser.email, password}});
    const bearer = signedIn.token;
    expect(typeof bearer).toBe("string");
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: ownerUser.id, shareId: "share-0"}});
    if (current.kind !== "current") throw new Error("Owner binding unavailable.");
    const binding = current.binding;
    const nativeConfigPath = join(root, "ordinary-owner.json");
    writeFileSync(nativeConfigPath, JSON.stringify({
      // Owner delivery and provider refresh each reserve about 297 MB in this fixture.
      ingress: {aggregateBytes: 700000000, applicationWorkingReserveBytes: 1000000, maxUploads: 4, uploadDeadlineMs: 30000},
      maxRegistrations: 8, maxAdoptionBytes: 1000000, maxAdoptionEvents: 100, maxApplicationsPerSettlement: 8,
      ownerOutbox: {maxPendingBytes: 1000000, maxPendingAgeMs: 600000},
      sync: {policy: {maxClientVectorBytes: 100000, maxHostVectorBytes: 100000, maxOutputBytes: 1000000, maxReadBytes: 4000000}, workingReserveBytes: 4000000},
    }));
    const target = {binding, relayDatabaseNamespace: JSON.parse(readFileSync(configPath, "utf8")).namespace as string};
    const selected = {...target, shareId: "share-0"};
    const deliveryConfig = {nativeConfigPath, nativeClient: {aggregateBytes: 200000000, maxUploads: 4}, relayUrl,
      frames, attemptTimeoutMs: 30000, retryDelayMs: 1000, documents: [selected]};
    let id = 10;
    async function startOwner(name: string) {
      const dir = join(root, name); mkdirSync(dir, {recursive: true});
      const client = await createEngineClient({command: executable!, authToken: `owner-proof-${name}`, protocolVersion: 2,
        capabilities: ["core", "blobs"], privateLiveApplication: deliveryConfig.nativeClient, connectTimeoutMs: 30000,
        env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: nativeConfigPath}});
      ownerClients.add(client);
      const open = await client.sendRequest({id: id++, method: "workspace.open", params: {rootDir: dir, workspaceId: "workspace", captureMode: "none",
        relay: {baseUrl: relayUrl, bearerToken: bearer, allowInsecureLoopbackForTests: true}}, deadlineMs: 30000});
      const workspaceHandle = (open.result as {workspace: string}).workspace;
      const request = () => ({id: id++, workspace: workspaceHandle, deadlineMs: 30000});
      async function rpc(method: string, params: Record<string, any>) {
        const response = await client.sendRequest({...request(), method, params});
        return response.result as Record<string, any>;
      }
      async function pull() {
        for (let page = 0; page < 16; page++) {
          const result = await rpc("sync.pull", {workspaceId: "workspace"});
          expect(result.refusals ?? []).toEqual([]);
          if (result.pendingCursor) await rpc("sync.commitCursor", {workspaceId: "workspace", pendingCursor: result.pendingCursor});
          if (!result.hasMore) return result;
        }
        throw new Error("Owner pull exceeded explicit 16-page proof budget.");
      }
      expect((await rpc("versions.ensureMain", {})).id).toBe(mainVersionId);
      async function descriptor() {
        const result = await client.ownerYDocPrepareEnrollment(request(), target);
        if (result.status !== "observed") throw new Error("Expected durable enrolled owner state.");
        return result.draft;
      }
      const outbox = new OwnerYDocOutbox(client, workspaceHandle);
      async function pass(): Promise<OwnerYDocDrainResult> {
        const lifetime = AbortSignal.timeout(deliveryConfig.attemptTimeoutMs);
        let completed!: (result: OwnerYDocDrainResult) => void, failed!: (error: unknown) => void;
        const completion = new Promise<OwnerYDocDrainResult>((resolve, reject) => {completed = resolve; failed = reject;});
        const aborted = () => failed(lifetime.reason);
        lifetime.addEventListener("abort", aborted, {once: true});
        const delivery = startDesktopOwnerDelivery({config: deliveryConfig,
          async runPass(document, signal) {
            const result = await runNativeOwnerDeliveryPass({client, workspaceHandle, document, config: deliveryConfig,
              signal: AbortSignal.any([lifetime, signal]), bearer, assertCurrent() {expect(storage.unavailable.aborted).toBe(false);}});
            if (result !== "retry") completed(result);
            return result;
          },
          onError(error) {
            const refusals = (results.deliveryRefusals ??= []) as unknown[];
            refusals.push(error instanceof EngineRequestError ? error.wireError : String(error));
            if (!(error instanceof EngineRequestError && error.wireError?.code === "OVERLOADED" && error.wireError.retry === "afterBackoff")) failed(error);
          },
        });
        try {return await completion;}
        finally {lifetime.removeEventListener("abort", aborted); await delivery.stop();}
      }
      return {client, workspaceHandle, request, rpc, pull, outbox, dir, descriptor,
        openDraft: async () => client.ownerYDocOpenDraft(request(), {binding, expectedRevision: (await descriptor()).revision}),
        appendDraft: async (appendKey: string, updateBytes: Uint8Array) => client.ownerYDocAppendDraft(request(), {binding, expectedRevision: (await descriptor()).revision, appendKey, updateBytes}),
        pass,
        async close() {outbox.dispose(); client.close(); await client.waitForExit(); ownerClients.delete(client);}};
    }
    const first = await startOwner("owner-a");
    const second = await startOwner("owner-b");
    // The claim and join mint independent native origins; neither replica copies a database.
    const firstClaim = await first.rpc("sync.claim", {workspaceId: "workspace"});
    const bootstrapResponse = await fetch(`${relayUrl}/sync/workspace/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}});
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await bootstrapResponse.json() as {replicationEpoch: string; streamIdentity: string};
    const secondClaim = await second.rpc("sync.adoptJoinIdentity", {workspaceId: "workspace", replicationEpoch: bootstrap.replicationEpoch, streamIdentity: bootstrap.streamIdentity});
    results.claims = [firstClaim, secondClaim];
    await first.pull(); await second.pull();
    let updateObserved: (() => void) | undefined;
    let ownerRefreshObserved: ((draft: YdocOwnerDraftPendingError["draft"]) => void) | undefined;
    const rendererDoc = new Y.Doc();
    const provider = await openEngineYdocProviderSession({transport: first.client, workspace: first.workspaceHandle,
      versionId: mainVersionId!, path: "docs/a.md", expectedObjectId: "object", contentKind: "richdoc",
      onRemoteUpdate(update) {Y.applyUpdate(rendererDoc, update); updateObserved?.();},
      onSessionError(error) {
        if (isLiveSettlementCapacityRefusal(error)) {
          ((results.providerCapacityRefusals ??= []) as unknown[]).push(error instanceof EngineRequestError ? error.wireError : String(error));
        } else results.providerError = String(error);
      },
      onSettleError(error) {if (error instanceof YdocOwnerDraftPendingError) ownerRefreshObserved?.(error.draft);}});
    Y.applyUpdate(rendererDoc, provider.initialUpdate);
    async function expectProviderText(text: string, run: () => Promise<unknown>) {
      let observed!: () => void;
      const update = new Promise<void>(resolve => {observed = resolve;});
      const check = () => {if (yDocToMarkdown(rendererDoc) === text) observed();};
      updateObserved = check;
      try {await run(); check(); await update; expect(yDocToMarkdown(provider.doc)).toBe(text);}
      finally {updateObserved = undefined;}
    }
    const editor = await second.rpc("ydoc.open", {versionId: mainVersionId!, path: "docs/a.md", expectedObjectId: "object", contentKind: "richdoc"});
    expect(editor.lineageClaimId).toBe(binding.lineageClaimId);
    const local = new Y.Doc(); Y.applyUpdate(local, baseline);
    function append(text: string) {
      const before = Y.encodeStateVector(local), paragraph = new Y.XmlElement("paragraph"), content = new Y.XmlText();
      content.insert(0, text); paragraph.insert(0, [content]); local.getXmlFragment("body").push([paragraph]);
      return Y.encodeStateAsUpdate(local, before);
    }
    const divergent = append("Owner B offline edit");
    await second.rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: Buffer.from(divergent).toString("base64")});
    const captured = await second.client.ownerYDocPrepareEnrollment(second.request(), target);
    if (captured.status !== "capture") throw new Error("Fresh replica was already enrolled.");
    // No delivery runs yet. A restart must preserve the exact unenrolled local state.
    await second.close();
    const recovered = await startOwner("owner-b");
    expect(await recovered.client.ownerYDocPrepareEnrollment(recovered.request(), target)).toEqual(captured);
    results.stage = "enroll owner A and observe provider refresh";
    const enrollmentRefresh = new Promise<YdocOwnerDraftPendingError["draft"]>(resolve => {ownerRefreshObserved = resolve;});
    let providerDraft: YdocOwnerDraftPendingError["draft"];
    try {expect(await first.pass()).toBe("empty"); providerDraft = await enrollmentRefresh;}
    finally {ownerRefreshObserved = undefined;}
    results.stage = "read enrolled owner A descriptor";
    const firstDraft = await first.client.ownerYDocPrepareEnrollment(first.request(), target);
    expect(firstDraft.status).toBe("observed");
    if (firstDraft.status !== "observed") throw new Error("Owner A enrollment did not commit.");
    expect(providerDraft).toEqual(firstDraft.draft);
    results.stage = "refuse foreign owner account";
    const wrongAccount = await auth.api.signInEmail({body: {email: users[0]!.email, password}});
    const refused = await runNativeOwnerDeliveryPass({client: first.client, workspaceHandle: first.workspaceHandle,
      document: selected, config: deliveryConfig, signal: AbortSignal.timeout(30000), bearer: wrongAccount.token, assertCurrent() {}});
    expect(refused).toBe("retry");
    expect(await first.client.ownerYDocPrepareEnrollment(first.request(), target)).toEqual(firstDraft);
    // Hold the second authenticated capture: enrollment committed, submission has not started.
    let releaseCapture!: () => void, captureArrived!: () => void;
    const release = new Promise<void>(done => {releaseCapture = done;});
    const arrived = new Promise<void>(done => {captureArrived = done;});
    heldCapture = {remaining: 2, arrived: captureArrived, release};
    results.stage = "enroll divergent owner B and hold submission";
    const enrollmentPass = recovered.pass();
    let heldEvidence: {retainedDigest: string; draftDigest: string; push: Record<string, any>} | undefined;
    try {
      await Promise.race([arrived, enrollmentPass.then(result => {throw new Error(`Delivery ended before enrollment barrier: ${result}`);})]);
      const enrolled = await recovered.client.ownerYDocPrepareEnrollment(recovered.request(), target);
      if (enrolled.status !== "observed" || !enrolled.draft.outboxId) throw new Error("Enrollment lost the divergent local draft.");
      const retained = await recovered.outbox.readPending(enrolled.draft.outboxId);
      expect(retained.entries).toHaveLength(1);
      const localDraft = await recovered.openDraft();
      expect(hash(localDraft.initialUpdate)).toBe(captured.captured.localStateDigest);
      expect(storage.getBlob("workspace", hash(divergent))).toBeNull();
      const push = await recovered.rpc("sync.push", {workspaceId: "workspace"});
      expect(push.ownerAdmissionPending).toEqual([expect.objectContaining({workspaceId: "workspace", objectId: "object", path: "docs/a.md"})]);
      expect(storage.getBlob("workspace", hash(divergent))).toBeNull();
      heldEvidence = {retainedDigest: retained.entries[0]!.updateDigest, draftDigest: hash(localDraft.initialUpdate), push};
    } finally {releaseCapture();}
    results.stage = "finish divergent enrollment and release ordinary publication";
    const enrollment = await enrollmentPass;
    expect(["acknowledged", "empty"]).toContain(enrollment);
    const discovered = await recovered.client.ownerYDocPrepareEnrollment(recovered.request(), target);
    if (discovered.status !== "observed" || !discovered.draft.outboxId) throw new Error("Divergent enrollment failed to retain a real outbox.");
    const releasedPush = await recovered.rpc("sync.push", {workspaceId: "workspace"});
    expect(releasedPush.ownerAdmissionPending).toEqual([]);
    const relayRead = new DatabaseSync(join(root, "relay", "relay.sqlite"), {readOnly: true});
    try {
      const blocked = heldEvidence!.push.ownerAdmissionPending[0];
      const row = relayRead.prepare("SELECT origin_id, origin_seq, payload_json FROM sync_relay_log WHERE workspace_id=? AND origin_id=? AND origin_seq=?")
        .get("workspace", blocked.originId, blocked.originSeq);
      expect(row).toBeDefined();
      expect(JSON.parse(row!.payload_json as string).updateBlobSha256).toBe(hash(divergent));
    } finally {relayRead.close();}
    const settledPending = await recovered.outbox.readPending(discovered.draft.outboxId);
    expect(settledPending.entries).toHaveLength(0);
    results.stage = "observe accepted owner delivery in open provider";
    await expectProviderText(yDocToMarkdown(local), () => first.pass());
    const a = await first.openDraft();
    const b = await recovered.openDraft();
    const render = (bytes: Uint8Array) => {const doc = new Y.Doc(); try {Y.applyUpdate(doc, bytes); return yDocToMarkdown(doc);} finally {doc.destroy();}};
    expect(render(a.initialUpdate)).toContain("Owner B offline edit");
    expect(render(a.initialUpdate)).toBe(render(b.initialUpdate));
    // A durable draft waits while the bounded native delivery pass is deliberately not running.
    Y.applyUpdate(local, b.initialUpdate);
    results.stage = "retain pending update across owner restart";
    const pendingUpdate = append("Pending across restart");
    const pending = await recovered.appendDraft("pending-restart", pendingUpdate);
    const beforeRestart = await recovered.outbox.readPending(pending.outboxId);
    expect(beforeRestart.entries.map(row => row.deliveryId)).toContain(pending.deliveryId);
    expect(await recovered.client.ownerYDocIsReceiptApplied(recovered.request(), {...target,
      receipt: {deliveryId: pending.deliveryId, updateDigest: pending.updateDigest, journalCursor: discovered.draft.acceptedCursor + 1, acceptingHostEpoch: active.coordinate.hostEpoch}})).toBe(false);
    await recovered.close();
    const reopened = await startOwner("owner-b");
    expect(await reopened.outbox.readPending(pending.outboxId)).toEqual(beforeRestart);
    expect(await reopened.pass()).toBe("acknowledged");
    expect((await reopened.outbox.readPending(pending.outboxId)).entries).toHaveLength(0);
    results.stage = "observe accepted owner delivery in open provider";
    await expectProviderText(yDocToMarkdown(local), () => first.pass());
    const convergedA = await first.openDraft();
    const convergedB = await reopened.openDraft();
    expect(render(convergedA.initialUpdate)).toBe(render(convergedB.initialUpdate));
    expect(render(convergedB.initialUpdate)).toContain("Pending across restart");
    // Delete-only updates do not advance the vector. Containment must still wait for native application.
    Y.applyUpdate(local, convergedB.initialUpdate);
    const beforeDelete = Y.encodeStateVector(local);
    local.getXmlFragment("body").delete(0, local.getXmlFragment("body").length);
    const deletion = Y.encodeStateAsUpdate(local, beforeDelete);
    expect(Y.encodeStateVector(local)).toEqual(beforeDelete);
    const deleted = await reopened.appendDraft("delete-only", deletion);
    expect((await reopened.outbox.readPending(deleted.outboxId)).entries).toHaveLength(1);
    let releaseFeed!: () => void, observedReceipt!: () => void;
    const feedRelease = new Promise<void>(resolve => {releaseFeed = resolve;});
    const receiptSeen = new Promise<void>(resolve => {observedReceipt = resolve;});
    heldFeed = {digest: deleted.updateDigest, release: feedRelease};
    const nativeReceiptCheck = reopened.client.ownerYDocIsReceiptApplied.bind(reopened.client);
    let receiptWhileHeld: unknown;
    reopened.client.ownerYDocIsReceiptApplied = async (...params) => {
      const applied = await nativeReceiptCheck(...params);
      if (params[1].receipt.deliveryId === deleted.deliveryId && !applied) {
        receiptWhileHeld = params[1].receipt; observedReceipt();
      }
      return applied;
    };
    let deliveryFinished = false;
    const deletionPass = reopened.pass().finally(() => {deliveryFinished = true;});
    try {
      await Promise.race([receiptSeen, deletionPass.then(result => {throw new Error(`Delete delivery ended before receipt barrier: ${result}`);})]);
      expect(deliveryFinished).toBe(false);
      expect((await reopened.outbox.readPending(deleted.outboxId)).entries).toHaveLength(1);
      expect((await reopened.descriptor()).acceptedCursor).toBeLessThan((receiptWhileHeld as {journalCursor: number}).journalCursor);
    } finally {
      releaseFeed(); heldFeed = undefined;
      reopened.client.ownerYDocIsReceiptApplied = nativeReceiptCheck;
    }
    expect(await deletionPass).toBe("acknowledged");
    await expectProviderText("", () => first.pass());
    expect(render((await first.openDraft()).initialUpdate)).toBe("");
    expect((await reopened.outbox.readPending(deleted.outboxId)).entries).toHaveLength(0);
    const beforeEcho = await first.descriptor();
    const ownerRead = new DatabaseSync(join(first.dir, ".dohc", "engine", "engine.db"), {readOnly: true});
    let retainedFrames: unknown;
    try {
      const rows = ownerRead.prepare("SELECT journal_cursor FROM ydoc_owner_applied_frames WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor")
        .all(binding.workspaceId, binding.mainVersionId, binding.objectId, binding.lineageClaimId);
      expect(rows).toEqual([{journal_cursor: beforeEcho.acceptedCursor}]);
      expect(beforeEcho.acceptedCursor).toBeGreaterThan(discovered.draft.acceptedCursor);
      retainedFrames = rows;
    } finally {ownerRead.close();}
    // Re-deliver old content through ordinary authenticated sync after production pruning.
    storage.appendLogBatch({workspaceId: "workspace", originId: "delayed-replica", ops: [
      {originSeq: 0, opKind: "ydoc.update", recordedAtMs: Date.now(), payloadJson: JSON.stringify({
        versionId: mainVersionId!, objectId: "object", path: "docs/a.md", contentKind: "richdoc",
        updateBlobSha256: hash(divergent), lineageClaimId: binding.lineageClaimId, isBaseState: false})},
      {originSeq: 1, opKind: "ydoc.update", recordedAtMs: Date.now(), payloadJson: JSON.stringify({
        versionId: mainVersionId!, objectId: "object", path: "docs/a.md", contentKind: "richdoc",
        updateBlobSha256: hash(baseline), lineageClaimId: binding.lineageClaimId, isBaseState: true})},
    ]});
    const echoPull = await first.pull();
    expect(echoPull.refused).toBe(0);
    expect(echoPull.refusals).toEqual([]);
    expect(echoPull.hasMore).toBe(false);
    expect(await first.descriptor()).toEqual(beforeEcho);
    expect(render((await first.openDraft()).initialUpdate)).toBe("");
    expect(yDocToMarkdown(provider.doc)).toBe("");
    results.delayedEcho = {retainedFrames, oldAcceptedCursor: discovered.draft.acceptedCursor, echoPull,
      acceptedDescriptorUnchanged: true, ordinaryOriginalBaseAndOldUpdateReplayed: true};
    results.delivery = {enrollment, captured, heldEvidence, receiptWhileHeld, pending: {deliveryId: pending.deliveryId, updateDigest: pending.updateDigest},
      deletion: {deliveryId: deleted.deliveryId, updateDigest: deleted.updateDigest}, convergedMarkdown: render(convergedB.initialUpdate)};
    await provider.evict(); rendererDoc.destroy();
    expect(results.providerError).toBeUndefined();
    local.destroy(); await first.close(); await reopened.close();
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
      scope: "Real BetterAuth/Postgres owner bearer, configured native service, two ordinary native replicas, production owner WS delivery, divergent enrollment, held publication, exact origin release, durable restart, receipt held before accepted feed, native ACK, open provider convergence, delete-only update, old echo and original base after real pruning.",
      omitted: ["Electron renderer UI (production provider and renderer update callback are exercised)", "ordinary publication carrier matrix beyond pending ydoc update"], results}, null, 2));
  } catch (error) {
    try {writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "FAIL", executable, sha256: expectedHash,
      error: error instanceof Error ? {...error, name: error.name, message: error.message, stack: error.stack} : String(error), results}, null, 2));}
    catch (evidenceError) {console.error("Owner proof failure evidence could not be written", evidenceError);}
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const client of ownerClients) {try {client.close(); await client.waitForExit();} catch (error) {cleanupErrors.push(error);}}
    for (const close of closes.reverse()) {try {await close();} catch (error) {cleanupErrors.push(error);}}
    await Promise.allSettled(upgrades);
    try {await active?.close();} catch (error) {cleanupErrors.push(error);}
    try {deployment.storage.close();} catch (error) {cleanupErrors.push(error);}
    ownerDoc.destroy();
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Owner proof resource cleanup failed.");
  }
  } finally {
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}, 180000);
