import { DiscussionActivityHub } from "./discussionActivity";
import * as Y from "yjs";
import {DatabaseSync} from "node:sqlite";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createLiveMarkdownRegistrationValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation";
import {liveValidation} from "./liveValidation";
import {attachLiveJournalHistory, createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import type {StorageContext} from "./storage/context";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {captureNamedLiveFrameHost, captureOwnerLiveFrameHost, createNamedFrameChanges} from "./namedLiveFrameHost";
import {createLiveTickets} from "./liveTickets";
import {liveBrowserActor} from "./liveBrowserContext";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, onTestFailed, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import type {VersionedTextMoment} from "@dohc/workspace-contracts/engine";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import { createCollectionRecord, setCollectionRecordFields } from "@dohc/automation-executor/collection-record-edits";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import { realDaemonReaderConfig } from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import { ChatsLiveAdapter, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {restoreDirectWrites} from "../../../apps/desktop/src/workspaces/stopAndRestore";
import { replicaAutomationChat, replicaChatStore } from "./automationChatWrites";
import { replicaRecordEditContext, replicaRecordEngine } from "./automationRecordEdits";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
  deriveAutomationReplicaBearer,
} from "./automationReplicaCredential";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { createServiceHostReplication } from "./serviceHostReplication";
import { ServiceOrdinaryReplication, type ServiceOrdinaryReplicationConfig } from "./serviceOrdinaryReplication";
import { closeTestStorages, tempRoot, testStorage } from "./testing";

// A server's automation writes records and posts in its own replica of the
// owner's workspace, through the real engine: a plain daemon, a workspace
// opened without capture, the relay route, and a join as the owner. The
// owner's computer then receives each change with the automation as its
// author.

const engine = requireEngineBinaryOrSkip();
const WORKSPACE = "workspace-trip";
const AUTOMATION = { kind: "automation", automationId: "collection:Tasks#stamp", onBehalfOf: "owner", depth: 1,
  run: { claimId: "claim-1", automationName: "Stamp the finish date" } } as const;
const ONE = derivedRecordId("seeded-one");
const TWO = derivedRecordId("claim-1/0");
const DEADLINE_MS = 30_000;

const cleanup: Array<() => Promise<void>> = [];
async function closeTestComputers() {
  const failures: unknown[] = [];
  for (const close of [...cleanup.splice(0).reverse(), closeTestStorages]) {
    try {await close();} catch (error) {failures.push(error);}
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Automation test cleanup failed");
}
afterEach(closeTestComputers);

// The relay's test seam: "Bearer test:<user>" is that user.
const testActor: ResolveActor = (request, workspaceId) => {
  const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, workspaceId };
};

/** One computer's engine, with its workspace open on the relay route and ordinary replication. */
async function computer(input: {
  root: string;
  relayUrl: string;
  bearerToken: string;
  identity: ServiceOrdinaryReplicationConfig["identity"];
  captureMode?: "full" | "none";
}) {
  await mkdir(input.root, { recursive: true });
  const profile = selfHostLiveProfile();
  const configPath = join(input.root, "owner-ingress.json");
  await writeFile(configPath, JSON.stringify(profile.nativeIngress));
  let stderrTail = "";
  let teardownStarted = false;
  let exitStatus: {code: number | null; signal: NodeJS.Signals | null; duringTeardown: boolean} | undefined;
  const diagnostic = () => `[automation engine] ${JSON.stringify({at: new Date().toISOString(), root: input.root, command: engine.path, exitStatus: exitStatus ?? null})}\n${stderrTail || "(no engine stderr)"}`;
  onTestFailed(() => {
    console.error(diagnostic());
  });
  const client = await createEngineClient({
    env: {DOHC_ENGINE_OWNER_HOST_CONFIG: configPath, DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig()}, privateLiveApplication: profile.nativeClient,
    command: engine.require(), authToken: randomBytes(32).toString("base64url"),
    protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: DEADLINE_MS,
    onStderr: text => {stderrTail = (stderrTail + text).slice(-64 * 1024);},
    onExit: (code, signal) => {
      exitStatus = {code, signal, duringTeardown: teardownStarted};
      if (!teardownStarted) console.error(diagnostic());
    },
  });
  cleanup.push(async () => {teardownStarted = true; client.close(); await client.waitForExit();});
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  const request = async (method: string, params: { [key: string]: JsonValue }, workspace?: string) =>
    (await client.sendRequest({ id: nextRequestId(), method, params, ...(workspace ? { workspace } : {}), deadlineMs: DEADLINE_MS }))
      .result as { [key: string]: JsonValue };
  const opened = await request("workspace.open", {
    rootDir: input.root, workspaceId: WORKSPACE, ...(input.captureMode === "full" ? {} : {captureMode: "none", reconcileCollections: true}),
    relay: { baseUrl: input.relayUrl, bearerToken: input.bearerToken, allowInsecureLoopbackForTests: true },
  });
  const workspace = opened.workspace as string;
  // Pulled moments land in the main version, as the server's replica makes it at open.
  await vi.waitFor(() => request("versions.ensureMain", { workspaceId: WORKSPACE }, workspace), {timeout: 120_000});
  const lifetime = new AbortController();
  // The engine reaches the relay through the route it opened with; this
  // configuration only checks the credential's shape, so it names the
  // relay's public origin as a deployment would.
  const replication = new ServiceOrdinaryReplication(
    { client: {sendRequest: async (request, signal) => {
      try {return await client.sendRequest(request, signal);}
      catch (error) {throw new Error(`${request.method} on ${input.root}\n${diagnostic()}`, {cause: error});}
    }}, workspace, workspaceId: WORKSPACE, nextRequestId, deadlineMs: DEADLINE_MS, signal: lifetime.signal, assertCurrent: () => undefined },
    { relay: { baseUrl: "https://relay.example.test", bearerToken: input.bearerToken }, identity: input.identity, maxPagesPerPull: 8 },
  );
  const closeEngine = async () => {
    teardownStarted = true;
    lifetime.abort();
    await request("workspace.close", {}, workspace).catch(() => undefined);
    client.close();
    await client.waitForExit();
  };
  cleanup.push(closeEngine);
  // Like automationReplicas, queue complete passes from every caller.
  let syncChain: Promise<void> = Promise.resolve();
  return {
    root: input.root, nextRequestId, client, workspace, lifetime: lifetime.signal, request,
    async sync() {
      const run = syncChain.then(async () => {
        for (let more = true; more;) more = (await replication.push()).hasMore;
        for (let more = true; more;) more = (await replication.pull()).hasMore;
      });
      syncChain = run.catch(() => undefined);
      await run;
    },
    record: async (recordId: string) =>
      await request("collections.getRecord", { collectionPath: "Tasks", recordId, historyLimit: 10 }, workspace) as unknown as CollectionGetRecordResult,
  };
}

it.skipIf(engine.missing)("writes an automation's records and posts on the server's replica, and the owner's computer receives them", async () => {
  const root = await tempRoot("automation-record-e2e");
  const storage = await testStorage();
  const key = new Uint8Array(32).fill(7), namespace = "automation-record-e2e";
  // The relay as main.ts mounts it, with the automation replica's credential beside the owner's.
  const relay = createSyncRelayHandler({ storage, resolveActor: testActor });
  const replicas = createServiceHostReplication({activity: new DiscussionActivityHub(), 
    storage, prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: (credential) => authorizeAutomationReplication(storage, { key, namespace, ...credential }),
  });
  const http = serveFetchHandler({
    handler: (request) => request.headers.get("authorization")?.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`)
      ? replicas(request) : relay(request),
    streamBody: streamsRequestBody,
    maxBodyBytes: () => 21 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  // The owner's computer makes the Collection and one record, and syncs.
  const owner = await computer({ root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: { kind: "claim" } });
  const main = await owner.request("versions.ensureMain", {}, owner.workspace);
  for (const [path, text] of [
    ["Tasks/collection.yaml", "name: Tasks\nfields:\n  Status:\n    type: text\n"],
    ["Tasks/one.md", `---\nid: ${ONE}\nStatus: Doing\n---\n\nPack the car.\n`],
  ] as const) {
    await owner.request("versionedText.write", { versionId: main.id, path, text, origin: "api", publish: true, createOnly: true }, owner.workspace);
  }
  const ownerChats = new ChatsLiveAdapter(owner.client, owner.workspace, { workspaceId: WORKSPACE });
  const planning = await ownerChats.createChannel({ workspaceId: WORKSPACE, name: "Planning", type: "posts" });
  await owner.sync();

  // The server joins the workspace as its owner and pulls it.
  const row = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: Date.now(), reasons: ["automation"] });
  if (row === null) throw new Error("The relay did not let the server join the workspace.");
  const server = await computer({
    root: join(root, "server"), relayUrl,
    bearerToken: deriveAutomationReplicaBearer(row, { key, namespace }),
    identity: { kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity },
  });
  await server.sync();
  expect((await server.record(ONE)).record.path, "the pulled record is in its Collection on the server").toBe("Tasks/one.md");

  // The automation adds a record and changes one, then the server pushes.
  const replica = { workspaceId: WORKSPACE, client: server.client, workspace: server.workspace, signal: server.lifetime };
  const context = replicaRecordEditContext(replica, replicaRecordEngine(replica), new AbortController().signal);
  await expect(createCollectionRecord(context, {
    collectionPath: "Tasks", name: "Two", fields: { Status: "Open" }, author: AUTOMATION, recordId: TWO, idempotencyKeyPrefix: "claim-1/1/0",
  })).resolves.toEqual({ path: "Tasks/Two.md", recordId: TWO });
  await expect(setCollectionRecordFields(context, {
    recordPath: "Tasks/one.md", fields: { Status: "Done" }, author: AUTOMATION, idempotencyKeyPrefix: "claim-1/1/1",
  })).resolves.toEqual({ path: "Tasks/one.md", replaced: { Status: "Doing" }, kept: {} });
  // It posts in the Group, found by its name, as the automation.
  const chat = replicaAutomationChat({ runStore: { supersedeWake: async () => undefined }, storage: { postAutomationWake: () => { throw new Error("unexpected wake"); } }, nowMs: Date.now, replica: { ...replica, ownerUserId: "owner" }, store: replicaChatStore(replica), ownerName: async () => "Owner" });
  const directory = await chat.directory({ kind: "owner", ownerUserId: "owner", grants: [] }, { groups: new Set(["Planning"]), people: new Set() });
  const group = directory?.group("Planning");
  if (!group || "problem" in group) throw new Error("The server did not find the Group.");
  await chat.write(new AbortController().signal, {
    target: { kind: "group", channelId: group.channelId, lane: group.lane }, effectId: "claim-1/1/2", messageId: "message-auto-e2e",
    threadId: "thread-auto-e2e", automation: { automationId: AUTOMATION.automationId, name: "Stamp", depth: 1 }, body: "Two is open.",
  }, { claimId: "claim-1", keySeed: "1", startedAtMs: Date.now() });
  await server.sync();

  // The owner's computer receives both, with the automation as their author.
  await owner.sync();
  const byAutomation = { authorOriginId: AUTOMATION.automationId, actorKind: "automation", onBehalfOf: "owner", depth: 1, automationRun: AUTOMATION.run };
  const one = await owner.record(ONE);
  expect(one.record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "Done" }));
  expect(one.history[0]).toMatchObject({ field: "Status", next: { value: "Done" }, ...byAutomation });
  const two = await owner.record(TWO);
  expect(two.record.path).toBe("Tasks/Two.md");
  expect(two.record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "Open" }));
  // A record added as a whole file carries no field history to other
  // computers, whoever adds it; the server's copy names the automation.
  expect((await server.record(TWO)).history[0]).toMatchObject({ field: "Status", next: { value: "Open" }, ...byAutomation });
  const [post] = await ownerChats.listMessages({ workspaceId: WORKSPACE, threadId: "thread-auto-e2e" });
  expect(post).toMatchObject({
    id: "message-auto-e2e", body: "Two is open.", author: { kind: "automation", displayName: "Stamp" },
    authorOwnerDisplayName: "Owner", authorUserId: "owner",
  });
  // Which automation wrote it stays on the computer that ran it, as on a desktop.
  expect(await replicaChatStore(replica).getMessage({ workspaceId: WORKSPACE, messageId: "message-auto-e2e" }))
    .toMatchObject({ automation: { automationId: AUTOMATION.automationId } });
  expect((await ownerChats.listChannelThreads({ workspaceId: WORKSPACE, channelId: planning.channelId })).map((row) => row.thread.id))
    .toContain("thread-auto-e2e");
});

it.skipIf(engine.missing).each(["recipient-only", "owner-and-recipient"] as const)(
  "pushes %s proved settlements, restores by contributor coverage, and checks hosting engine refusal", async (authors) => {
  const root = await tempRoot("device-settlement"), storage = await testStorage({liveTickets: {retainedTicketsPerPrincipalGrant: 32, expiredTicketCleanupBatchSize: 32, now: Date.now}});
  const namespace = "device-settlement", key = new Uint8Array(32).fill(7);
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  attachLiveJournalHistory(storage as StorageContext, history);
  const serverHost = {label: "Test server"};
  const relay = createSyncRelayHandler({storage, resolveActor: testActor, automationServer: serverHost});
  const http = serveFetchHandler({handler: relay,
    streamBody: streamsRequestBody, maxBodyBytes: () => 21 * 1024 * 1024, oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));});
  const relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const owner = await computer({root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: {kind: "claim"}});
  await owner.request("versionedText.write", {versionId: "main", path: "Tasks/collection.yaml", text: "fields: {}\n", origin: "api", publish: true}, owner.workspace);
  await owner.sync();
  storage.createShare({share: {shareId: "native-share", workspaceId: WORKSPACE, granterUserId: "owner", selectorJson: JSON.stringify({paths: ["Tasks"], versionId: null}), createdAtMs: 0},
    grant: {grantId: "native-grant", shareId: "native-share", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: 0, revokedAtMs: null, parentGrantId: null}});
  const text = `---\nid: ${ONE}\nStatus: Doing\n---\n\nPack the car.\n`;
  const digest = createHash("sha256").update(text).digest("hex");
  const upload = await relay(new Request(`${relayUrl}/sync/shares/native-share/blobs/${digest}`, {
    method: "PUT", headers: {authorization: "Bearer test:reader"}, body: text,
  }));
  expect(upload.status).toBe(200);
  const created = await relay(new Request(`${relayUrl}/sync/shares/native-share/collection-writes`, {
    method: "POST", headers: {authorization: "Bearer test:reader", "content-type": "application/json"},
    body: JSON.stringify({submitId: "recipient-record", changes: [{basedOnPath: null, basedOnBlobSha256: null,
      operation: "write", afterPath: "Tasks/one.md", afterBlobSha256: digest, afterContentKind: "text",
      afterByteLength: Buffer.byteLength(text), recordedAtMs: Date.now()}]}),
  }));
  expect(created.status, await created.clone().text()).toBe(200);
  const ownerEngine = replicaRecordEngine({...owner, workspaceId: WORKSPACE});
  await owner.sync();
  const session = await ownerEngine.openSession({versionId: "main", path: "Tasks/one.md"});
  cleanup.push(() => session.close({settle: false}));
  const profile = selfHostLiveProfile(), validate = liveValidation.validator(profile.validation);
  const host = {mode: "device" as const, hostId: "native-owner", hostEpoch: parseHostEpoch(1), instanceId: "instance", connectionId: "connection"};
  storage.provisionLiveHostControl({mode: host.mode, hostId: host.hostId, updatedAtMs: 1, guard() {}});
  storage.registerLiveHost({...host, updatedAtMs: 2, guard() {}});
  const document = {workspaceId: WORKSPACE, mainVersionId: "main", objectId: session.objectId!, lineageClaimId: session.lineageClaimId!};
  const database = new DatabaseSync(join(owner.root, ".dohc/engine/engine.db"), {readOnly: true});
  let baselineBytes: Uint8Array;
  try {
    const blob = database.prepare("SELECT bytes FROM binary_blobs WHERE sha256 = ?").get(document.lineageClaimId);
    baselineBytes = blob!.bytes as Uint8Array;
  } finally {database.close();}
  const validated = createLiveMarkdownRegistrationValidator(profile.validation)({document, currentPath: session.path, checkpoint: baselineBytes});
  if (validated.kind !== "accepted") throw new Error(JSON.stringify(validated));
  const registrationResult = storage.registerLiveDocumentBaseline({host, baselineBytes, evidence: validated.evidence, registeredAtMs: 3});
  expect(registrationResult, JSON.stringify(registrationResult)).toMatchObject({kind: "registered"});
  await owner.request("liveApplication.provisionOwner", {relayNamespace: namespace, host: {hostId: host.hostId, hostEpoch: host.hostEpoch, instanceId: host.instanceId, connectionId: host.connectionId}}, owner.workspace);
  const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner"}});
  if (current.kind !== "current") throw new Error(JSON.stringify(current));
  const {binding} = current;
  const nativeSession = session.nativeOwner!.sessionId;
  // The desktop bridge holds this exact native session and forwards only its private methods.
  const native = {
    sendRequest: async (request, signal) => {
      if (request.method === "liveApplication.ownerState") {
        const result = (await owner.client.sendRequest({...request, params: {...(request.params as {[key: string]: JsonValue}), sessionId: nativeSession}}, signal)).result as {adoptionId: string; expectedLocalSequence: number; throughCursor: number | null};
        return {id: request.id, result: {adoptionId: result.adoptionId, expectedLocalSequence: result.expectedLocalSequence, throughCursor: result.throughCursor ?? 0, sessionId: nativeSession}};
      }
      if (request.method === "liveApplication.ownerOutbox") {
        const result = (await owner.client.sendRequest({...request, method: "liveApplication.ownerState", params: {...(request.params as {[key: string]: JsonValue}), sessionId: nativeSession}}, signal)).result as {outboxId: string | null; pendingBytes: number; outboxState: string | null; retryDeliveryId: string | null};
        return {id: request.id, result: {outboxId: result.outboxId, pendingBytes: result.pendingBytes, state: result.outboxState, retryDeliveryId: result.retryDeliveryId}};
      }
      if (request.method === "liveApplication.readOwnerOutbox" || request.method === "liveApplication.acknowledgeOwnerOutbox") {
        const params = request.params as {[key: string]: JsonValue};
        const state = (await owner.client.sendRequest({...request, id: owner.nextRequestId(), method: "liveApplication.ownerState", params: {registrationId: params.registrationId!, sessionId: nativeSession}}, signal)).result as {outboxId: string};
        const {registrationId: _registration, ...rest} = params;
        return owner.client.sendRequest({...request, method: request.method === "liveApplication.readOwnerOutbox" ? "ydoc.ownerOutbox.readPending" : "ydoc.ownerOutbox.acknowledge", params: {outboxId: state.outboxId, ...rest}}, signal);
      }
      return owner.client.sendRequest(request, signal);
    },
    sendLiveOwnerAdoption: (request, cut, bounds, signal) => owner.client.sendLiveOwnerAdoption({...request, sessionId: nativeSession}, cut, bounds, signal),
    sendLiveApplication: async (request, admitted, signal) => {
      const result = await owner.client.sendLiveApplication(request, admitted, signal);
      await session.nativeOwner!.applyRemoteUpdate(admitted.updateBytes);
      return result;
    },
    readLiveApplicationAck: (request, receipt, signal) => owner.client.readLiveApplicationAck(request, receipt, signal),
    openLiveAppliedSync: (request, vector, bounds, signal) => owner.client.openLiveAppliedSync(request, vector, bounds, signal),
    readNextLiveApplied: (request, after, maximum, signal) => owner.client.readNextLiveApplied(request, after, maximum, signal),
  } satisfies Pick<EngineClient, "sendRequest" | "sendLiveOwnerAdoption" | "sendLiveApplication" | "readLiveApplicationAck" | "openLiveAppliedSync" | "readNextLiveApplied">;
  const consumer = new OwnerCommittedDelivery(storage, history, {client: native as EngineClient, workspace: owner.workspace, host, deadlineMs: DEADLINE_MS, nextRequestId: owner.nextRequestId,
    bounds: {maxBytes: profile.nativeIngress.maxAdoptionBytes, maxEvents: profile.nativeIngress.maxAdoptionEvents},
    ownerAdmission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), workspaceIds: new Set([WORKSPACE]), maxEntriesPerDrain: 128, maxBytesPerDrain: profile.nativeIngress.maxAdoptionBytes, refusals: new OwnerKnownRefusals(), validate}});
  await consumer.drain(document);
  const nativeRegistration = consumer.captureRegistration(binding);
  const common = {storage, bounds: profile.namedLive.host, validate,
    native: {client: native, workspace: owner.workspace, registrationId: nativeRegistration.id, coordinate: host, binding,
      invalidated: nativeRegistration.invalidated, changes: createNamedFrameChanges(16), deadlineMs: DEADLINE_MS,
      nextRequestId: owner.nextRequestId, drain: (doc: typeof document, signal: AbortSignal) => consumer.drain(doc, signal)}};
  const edit = async (host: ReturnType<typeof captureOwnerLiveFrameHost>, field: string, authorContext: {kind: "account"; accountId: string}, settle = true) => {
    const doc = new Y.Doc();
    try {
      const sync = await host.openSync(Uint8Array.of(0), owner.lifetime);
      try {Y.applyUpdate(doc, sync.missingStateUpdate);} finally {sync.close();}
      const vector = Y.encodeStateVector(doc);
      doc.getMap("frontmatter").set(field, "Keep this text");
      const updateBytes = Y.encodeStateAsUpdate(doc, vector);
      expect(await host.submit({deliveryId: `edit-${field}`, updateDigest: createHash("sha256").update(updateBytes).digest("hex"), updateBytes,
        authorContext}, owner.lifetime)).toMatchObject({result: "success"});
    } finally {doc.destroy(); host.close();}
    if (settle) await consumer.settle(document);
  };
  const moments = async () => (await owner.request("moments.list", {limit: 100}, owner.workspace)).moments as unknown as Array<{momentId: string; authors?: unknown}>;
  const creationMoment = (await moments()).find(moment => Array.isArray(moment.authors) && moment.authors[0]?.kind === "named")!;
  expect(creationMoment).toBeDefined();
  const viewer = {kind: "named" as const, workspaceId: WORKSPACE, userId: "reader", shareId: "native-share", grantId: "native-grant"};
  const tickets = createLiveTickets({storage, audience: "https://relay.example.test", key,
    hostReports: {currentBinding: async () => ({connection: host, binding})}});
  const minted = await tickets.mint({objectId: document.objectId}, viewer);
  const ticket = await tickets.redeem(minted!.token, viewer);
  if (authors === "owner-and-recipient") {
    const ownerHost = captureOwnerLiveFrameHost({...common, authenticatedUserId: "owner",
      trustedAccount: {accountId: "owner", name: "Owner"}});
    await edit(ownerHost, "OwnerNote", {kind: "account", accountId: "owner"}, false);
  }
  const recipientHost = captureNamedLiveFrameHost({...common, ticket: ticket!, actor: liveBrowserActor(viewer), trustedAccount: {accountId: "reader", name: "Reader"}});
  await edit(recipientHost, "RecipientNote", {kind: "account", accountId: "reader"});
  const recipientMoment = (await moments())[0]!;
  // Until publication, the hosting computer credits the owner snapshot's
  // account holder and the recipient once, by the grant the relay accepted the
  // edit under. The relay admits each snapshot's account holder instead, and
  // publication replaces the host's credit with those authors.
  const ownerCredit = authors === "recipient-only" ? [] : [{kind: "human", humanId: "owner", humanName: "Owner"}];
  const localAuthors = [...ownerCredit, {kind: "named", userId: "reader", grantId: "native-grant", grantGeneration: 1}];
  const admittedAuthors = [...ownerCredit, {kind: "human", humanId: "reader", humanName: "Reader"}];
  expect(recipientMoment.authors).toEqual(expect.arrayContaining(localAuthors));
  expect(recipientMoment.authors).toHaveLength(localAuthors.length);
  await owner.sync();
  // A later operation proves that no refused batch blocks the owner's log.
  await owner.request("versionedText.write", {versionId: "main", path: "after.txt", text: "After recipient settlement", origin: "api", publish: true}, owner.workspace);
  await owner.sync();
  const rows = storage.fetchLogPage({workspaceId: WORKSPACE, sinceRelaySeq: 0, limit: 1000}).rows;
  expect(rows.some(row => JSON.parse(row.payloadJson).path === "after.txt")).toBe(true);
  const published = rows.find(row => JSON.parse(row.payloadJson).momentId === recipientMoment.momentId)!;
  expect(published).toBeDefined();
  expect(JSON.parse(published.payloadJson).authors).toBeUndefined();
  expect(JSON.parse(published.payloadJson).settlementReference).toBeDefined();
  expect(published.settlementAdmission).toMatchObject({status: "accepted"});
  expect(published.admittedAuthorSnapshot).toEqual(expect.arrayContaining(admittedAuthors));
  expect(published.admittedAuthorSnapshot).toHaveLength(admittedAuthors.length);
  const ownerDatabase = new DatabaseSync(join(owner.root, ".dohc/engine/engine.db"), {readOnly: true});
  try {
    expect(ownerDatabase.prepare("SELECT COUNT(*) AS total FROM replication_pending_refusals WHERE workspace_id=?").get(WORKSPACE)?.total).toBe(0);
  } finally {ownerDatabase.close();}
  const identity = storage.getWorkspaceIdentity(WORKSPACE)!;
  const peer = await computer({root: join(root, "peer"), relayUrl, bearerToken: "test:owner",
    identity: {kind: "join", replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity}});
  await peer.sync();
  const imported = (await peer.request("moments.list", {limit: 100}, peer.workspace)).moments as unknown as Array<{momentId: string; authors?: unknown}>;
  // The peer imports the relay's admitted authors and its retained audit
  // evidence adds no credit to the moment. The relay confirms each person.
  const confirmedAuthors = (admittedAuthors as Array<Record<string, unknown>>)
    .map(author => author.kind === "human" ? {...author, relayConfirmed: true} : author);
  const importedAuthors = imported.find(moment => moment.momentId === recipientMoment.momentId)?.authors;
  expect(importedAuthors).toEqual(expect.arrayContaining(confirmedAuthors));
  expect(importedAuthors).toHaveLength(confirmedAuthors.length);
  const peerHistory = new VersionedLiveAdapter(peer.client, peer.workspace, {workspaceId: WORKSPACE});
  const peerMoment = await peerHistory.getMoment({workspaceId: WORKSPACE, momentId: recipientMoment.momentId});
  expect(peerMoment).toMatchObject({syncRecordOnly: true, authors: expect.arrayContaining(confirmedAuthors)});
  expect(peerMoment?.authors).toHaveLength(confirmedAuthors.length);
  // Publication refreshed the hosting computer's moment to the admitted
  // authors, and the relay's acceptance confirms each person there too.
  const refreshedAuthors = (await moments()).find(moment => moment.momentId === recipientMoment.momentId)?.authors;
  expect(refreshedAuthors).toEqual(expect.arrayContaining(confirmedAuthors));
  expect(refreshedAuthors).toHaveLength(confirmedAuthors.length);
  expect(await readFile(join(peer.root, "Tasks/one.md"), "utf8")).toContain("RecipientNote: Keep this text");
  await session.close({settle: false});
  const restore = async (side: typeof owner) => {
    const adapter = new VersionedLiveAdapter(side.client, side.workspace, {workspaceId: WORKSPACE});
    return restoreDirectWrites({
      moment: async (momentId): Promise<VersionedTextMoment | null> => {
        const moment = await adapter.getMoment({workspaceId: WORKSPACE, momentId});
        if (!moment) return null;
        const text = async (side: "before" | "after") => {
          const inline = side === "before" ? moment.beforeText : moment.afterText;
          const sha256 = side === "before" ? moment.beforeBlobSha256 : moment.afterBlobSha256;
          return inline ?? (sha256 === null ? "" : (await adapter.readTextBlob({workspaceId: WORKSPACE, sha256}))!);
        };
        return {id: moment.momentId, workspaceId: WORKSPACE, versionId: moment.versionId, objectId: moment.objectId,
          path: moment.path, recordedAtMs: moment.recordedAtMs, operation: moment.operation,
          authors: moment.authors as VersionedTextMoment["authors"], syncRecordOnly: moment.syncRecordOnly,
          metadata: {origin: moment.metadataOrigin as VersionedTextMoment["metadata"]["origin"]},
          payload: {before: moment.beforePresent ? {path: moment.beforePath!, text: await text("before")} : null,
            after: {path: moment.path, text: await text("after")}}};
      },
      assertCurrent() {},
      momentsAfter: async (objectId, momentId) => {
        const page = await adapter.listMoments({workspaceId: WORKSPACE, objectId, versionId: "main", limit: 100});
        return page.moments.slice(0, page.moments.findIndex(moment => moment.momentId === momentId)).map(moment => moment.momentId);
      },
      restore: async (_momentId, expectedHeadMomentId) => {
        const current = await adapter.readTextFile({workspaceId: WORKSPACE, versionId: "main", path: "Tasks/one.md"});
        const page = await adapter.listMoments({workspaceId: WORKSPACE, versionId: "main", objectId: document.objectId, limit: 1});
        expect(current?.objectId).toBe(document.objectId);
        expect(page.moments[0]?.momentId).toBe(expectedHeadMomentId);
        const result = await adapter.deleteTextFile({workspaceId: WORKSPACE, versionId: "main", path: "Tasks/one.md",
          expectedObjectId: document.objectId, metadata: {origin: "restore"}, author: {kind: "human", humanId: "local:owner"}});
        return {kind: "restored", receipt: {path: "Tasks/one.md", restoredMomentId: result.moment.momentId, removed: true}};
      },
      folderEntries: async () => [], removeEmptyFolder: async () => undefined,
      undoRuns: async () => ({undone: 0, left: 0, keptFields: [], missing: 0, otherKept: 0, errorMessage: null}),
    }, [{path: "Tasks/one.md", objectId: document.objectId, momentId: creationMoment.momentId, created: true}]);
  };
  // The relay-admitted settlement and the relay-checked live audit both retain the confirmed recipient.
  expect(imported).toContainEqual(expect.objectContaining({authors: [{kind: "human", humanId: "reader", humanName: "Reader", relayConfirmed: true}]}));
  if (authors === "owner-and-recipient") {
    expect(await restore(peer)).toMatchObject({status: "restored", restored: [],
      review: [{path: "Tasks/one.md", reason: "changed-since"}], unfinished: null});
    expect(await readFile(join(peer.root, "Tasks/one.md"), "utf8")).toContain("RecipientNote: Keep this text");
    expect(await readFile(join(peer.root, "Tasks/one.md"), "utf8")).toContain("OwnerNote: Keep this text");
    expect(await restore(owner)).toMatchObject({status: "restored", restored: [],
      review: [{path: "Tasks/one.md", reason: "changed-since"}], unfinished: null});
  } else {
    expect(await restore(peer)).toMatchObject({status: "restored",
      restored: [{path: "Tasks/one.md", removed: true}], review: [], unfinished: null});
    expect(await peerHistory.readTextFile({workspaceId: WORKSPACE, versionId: "main", path: "Tasks/one.md"})).toBeNull();
    // This checks the engine refusal only. The product IPC maps an active live
    // binding to review. recipient-record-creation.spec.ts covers removal on
    // the hosting computer through the product path.
    expect(await restore(owner)).toMatchObject({status: "restored", restored: [], review: [],
      unfinished: {step: "files", message: "live-document-binding-active"}});
  }

}, 120_000);

it.skipIf(engine.missing)("finishes a written but unadopted creation on native relay replay", async () => {
  const root = await tempRoot("automation-unadopted");
  const server = await computer({ root, relayUrl: "http://127.0.0.1:1", bearerToken: "test:owner", identity: { kind: "claim" } });
  const adapter = new VersionedLiveAdapter(server.client, server.workspace, { workspaceId: WORKSPACE });
  await adapter.writeTextFile({ workspaceId: WORKSPACE, versionId: "main", path: "Tasks/collection.yaml", text: "name: Tasks\nfields: {Status: {type: text}}\n", publish: true, metadata: { origin: "api" } });
  const replica = { workspaceId: WORKSPACE, client: server.client, workspace: server.workspace, signal: server.lifetime };
  const native = replicaRecordEngine(replica);
  let deduped = false, written = false, adoptionLookups = 0;
  const write = native.adapter.writeTextFile.bind(native.adapter);
  native.adapter.writeTextFile = async input => { const result = await write(input); written = true; deduped ||= result.deduped === true; return result; };
  const firstAttempt = new AbortController();
  const lookup = native.adapter.getCollectionRecord.bind(native.adapter);
  native.adapter.getCollectionRecord = async input => {
    try {return await lookup(input);}
    finally {
      if (written && input.recordId === TWO && !firstAttempt.signal.aborted) {
        adoptionLookups++;
        firstAttempt.abort();
      }
    }
  };
  const context = replicaRecordEditContext(replica, native, firstAttempt.signal);
  const db = new DatabaseSync(join(root, ".dohc/engine/engine.db"));
  db.exec("PRAGMA busy_timeout=10000");
  db.exec("CREATE TRIGGER block_adoption BEFORE INSERT ON collection_records WHEN NEW.file_path = 'Tasks/made.md' BEGIN SELECT RAISE(FAIL, 'test adoption failure'); END");
  const input = { collectionPath: "Tasks", name: "made", recordId: TWO, fields: { Status: "New" }, author: AUTOMATION, idempotencyKeyPrefix: "unadopted" };
  try {
    await expect(createCollectionRecord(context, input)).resolves.toMatchObject({ kind: "partial",failedStage: "index" });
    expect(adoptionLookups).toBeGreaterThan(0);
    expect((await adapter.readTextFile({ workspaceId: WORKSPACE, versionId: "main", path: "Tasks/made.md" }))?.text).toContain(TWO);
    expect(db.prepare("SELECT count(*) AS n FROM collection_records WHERE record_id = ?").get(TWO)?.n).toBe(0);
    db.exec("DROP TRIGGER block_adoption");
    const retry = replicaRecordEditContext(replica, native, new AbortController().signal);
    await expect(createCollectionRecord(retry, input)).resolves.toEqual({ path: "Tasks/made.md", recordId: TWO });
    expect(deduped).toBe(true);
    expect((await adapter.getCollectionRecord({ collectionPath: "Tasks", recordId: TWO, historyLimit: 1 })).record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "New" }));
  } finally { db.exec("DROP TRIGGER IF EXISTS block_adoption"); db.close(); }
}, 120_000);
