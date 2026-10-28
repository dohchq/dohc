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
import {automationRecordDelivery} from "./automationRecordDelivery";
import {createAutomationAcceptedRecords} from "./automationAcceptedRecords";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, onTestFailed, vi } from "vitest";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import {parseAutomationsFile} from "@dohc/workspace-contracts/automations";
import {definitionHash} from "@dohc/automation-executor/automation-plan";
import {CollectionAutomations} from "@dohc/automation-executor/collection-automations";
import {startAutomationServer} from "./automationServer";
import type {AutomationReplica, startAutomationReplicas} from "./automationReplicas";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import type {VersionedTextMoment} from "@dohc/workspace-contracts/engine";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import { createCollectionRecord, setCollectionRecordFields } from "@dohc/automation-executor/collection-record-edits";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import { realDaemonReaderConfig } from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import { ChatsLiveAdapter, DaemonRefusalError, isEngineStoreBusyRefusal, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import {SHARED_BUTTON_HELD} from "@dohc/automation-executor/button-presser";
import {registerStopAndRestoreIpc} from "../../../apps/desktop/src/ipc/stopAndRestoreIpc";
import {CHANNELS} from "../../../apps/desktop/src/ipc/channels";
import {restoreDirectWrites} from "../../../apps/desktop/src/workspaces/stopAndRestore";
import type {WorkspaceEngineMomentDetail} from "../../../apps/desktop/src/workspaces/workspaceEngineCapture";
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
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeTestStorages();
});

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
  onTestFailed(() => {
    console.error(`[automation engine] ${JSON.stringify({root: input.root, command: engine.path, exitStatus: exitStatus ?? null})}\n${stderrTail || "(no engine stderr)"}`);
  });
  const client = await createEngineClient({
    env: {DOHC_ENGINE_OWNER_HOST_CONFIG: configPath, DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig()}, privateLiveApplication: profile.nativeClient,
    command: engine.require(), authToken: randomBytes(32).toString("base64url"),
    protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: DEADLINE_MS,
    onStderr: text => {stderrTail = (stderrTail + text).slice(-64 * 1024);},
    onExit: (code, signal) => {exitStatus = {code, signal, duringTeardown: teardownStarted};},
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
      catch (error) {throw new Error(`${request.method} on ${input.root}`, {cause: error});}
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

it.skipIf(engine.missing)("settles safe imported Markdown after body and field edits expire its witness", async () => {
  const root = await tempRoot("automation-witness-checker");
  const server = await computer({root, relayUrl: "http://127.0.0.1:1", bearerToken: "test:owner", identity: {kind: "claim"}});
  const original = `---\nid: ${ONE}\nStatus: Doing\n---\n\nPack the car.\n`;
  await server.request("versionedText.write", {versionId: "main", path: "Tasks/collection.yaml",
    text: "fields: {Status: {type: text}}\n", origin: "api", publish: true}, server.workspace);
  await server.request("versionedText.write", {versionId: "main", path: "Tasks/one.md", text: original,
    origin: "api", publish: true}, server.workspace);
  const native = replicaRecordEngine({...server, workspaceId: WORKSPACE});
  const session = await native.openSession({versionId: "main", path: "Tasks/one.md"});
  cleanup.push(() => session.close({settle: false}));
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, session.initialUpdate);
    expect(doc.getMap("meta").get("dohcMarkdownSource")).toBe(original);
    const before = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set("Status", "Done");
    const paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    text.insert(text.length, " Ready to leave.");
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(doc, before), {actorOriginId: "owner",
      attribution: {actorKind: "human"}, armSettle: false});
    await session.settleNow();
    const saved = await readFile(join(root, "Tasks/one.md"), "utf8");
    expect(saved).toContain("Status: Done");
    expect(saved).toContain("Pack the car. Ready to leave.");
    expect((await server.record(ONE)).record.values).toContainEqual(expect.objectContaining({field: "Status", value: "Done"}));
  } finally {doc.destroy();}
});

it.skipIf(engine.missing)("writes an automation's records and posts on the server's replica, and the owner's computer receives them", async () => {
  const root = await tempRoot("automation-record-e2e");
  const storage = await testStorage();
  const key = new Uint8Array(32).fill(7), namespace = "automation-record-e2e";
  // The relay as main.ts mounts it, with the automation replica's credential beside the owner's.
  const relay = createSyncRelayHandler({ storage, resolveActor: testActor });
  const replicas = createServiceHostReplication({
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
  const row = storage.joinAutomationWorkspace({ workspaceId: WORKSPACE, nowMs: Date.now() });
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


it.skipIf(engine.missing).each(["write", "undo"] as const)("delivers a server record draft and its reversal natively to a live-bound owner, and reports refused %s admission", async failure => {
  const root = await tempRoot("automation-native-record"), storage = await testStorage({liveTickets: {retainedTicketsPerPrincipalGrant: 32, expiredTicketCleanupBatchSize: 32, now: Date.now}});
  const namespace = "native-record", key = new Uint8Array(32).fill(7);
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  attachLiveJournalHistory(storage as StorageContext, history);
  const serverHost = {label: "Test server"};
  const relay = createSyncRelayHandler({storage, resolveActor: testActor, automationServer: serverHost});
  const replicas = createServiceHostReplication({storage, prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: credential => authorizeAutomationReplication(storage, {key, namespace, ...credential})});
  const http = serveFetchHandler({handler: request => request.headers.get("authorization")?.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`) ? replicas(request) : relay(request),
    streamBody: streamsRequestBody, maxBodyBytes: () => 21 * 1024 * 1024, oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));});
  const relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const owner = await computer({root: join(root, "owner"), relayUrl, bearerToken: "test:owner", identity: {kind: "claim"}});
  const markText = "version: 1\nautomations:\n  - id: mark\n    name: Mark done\n    when: {button: Mark}\n    if: record.Priority == \"High\"\n    do: [{set: {Status: Done}}]\n  - id: stamp\n    name: Stamp finish date\n    when: {field-changed: Status}\n    if: record.Status == \"Done\"\n    do: [{set: {Finished: \"2026-10-06\"}}]\n";
  for (const [path, text] of [["Tasks/collection.yaml", "fields:\n  Status: {type: text}\n  Priority: {type: text}\n  Mark: {type: button}\n  Finished: {type: date}\n"],
    ["Tasks/automations.yaml", markText], ["Tasks/two.md", `---\nid: ${TWO}\nStatus: Doing\nPriority: High\n---\n`], ["Tasks/one.md", `---\nid: ${ONE}\nStatus: Doing\n---\n\nPack the car.\n`]]) {
    await owner.request("versionedText.write", {versionId: "main", path: path!, text: text!, origin: "api", publish: true}, owner.workspace);
  }
  const ownerEngine = replicaRecordEngine({...owner, workspaceId: WORKSPACE});
  await owner.sync();
  const session = await ownerEngine.openSession({versionId: "main", path: "Tasks/one.md"});
  cleanup.push(() => session.close({settle: false}));
  const seed = new Y.Doc();
  try {
    Y.applyUpdate(seed, session.initialUpdate);
    const vector = Y.encodeStateVector(seed);
    seed.getMap("frontmatter").set("Status", "Doing");
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(seed, vector), {actorOriginId: "owner", attribution: {actorKind: "human"}, armSettle: false});
  } finally {seed.destroy();}
  await session.settleNow();
  await owner.sync();
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
  storage.createShare({share: {shareId: "native-share", workspaceId: WORKSPACE, granterUserId: "owner", selectorJson: JSON.stringify({paths: ["Tasks"], versionId: null}), createdAtMs: 0},
    grant: {grantId: "native-grant", shareId: "native-share", principalKind: "user", principalUserId: "reader", principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: 0, revokedAtMs: null, parentGrantId: null}});
  await owner.request("liveApplication.provisionOwner", {relayNamespace: namespace, host: {hostId: host.hostId, hostEpoch: host.hostEpoch, instanceId: host.instanceId, connectionId: host.connectionId}}, owner.workspace);
  const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner", shareId: "native-share"}});
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
    ownerAdmission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([[WORKSPACE, "native-share"]]), maxEntriesPerDrain: 128, maxBytesPerDrain: profile.nativeIngress.maxAdoptionBytes, refusals: new OwnerKnownRefusals(), validate}});
  await consumer.drain(document);
  const row = storage.joinAutomationWorkspace({workspaceId: WORKSPACE, nowMs: Date.now()})!;
  const copy = await computer({root: join(root, "server"), relayUrl, bearerToken: deriveAutomationReplicaBearer(row, {key, namespace}), identity: {kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity}});
  const recipient = await computer({root: join(root, "recipient"), relayUrl, bearerToken: "test:owner", identity: {kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity}});
  await copy.sync(); await recipient.sync();
  const replica = {...copy, workspaceId: WORKSPACE, signal: copy.lifetime};
  let refused = false, loseAck = false, staleRecipient = false;
  let ownerDeliveryShare = "native-share";
  const capture = async () => {
    await consumer.drain(document);
    const registration = consumer.captureRegistration(binding);
    const captured = captureOwnerLiveFrameHost({authenticatedUserId: "owner", shareId: ownerDeliveryShare, storage,
      trustedAccount: {accountId: "owner", name: "Owner"}, bounds: profile.namedLive.host, validate,
      native: {client: native, workspace: owner.workspace, registrationId: registration.id, coordinate: host, binding,
        invalidated: registration.invalidated, changes: createNamedFrameChanges(16), deadlineMs: DEADLINE_MS, nextRequestId: owner.nextRequestId, drain: (doc, signal) => consumer.drain(doc, signal)}});
    const submit = captured.submit;
    captured.submit = async (input, signal) => {
      if (staleRecipient && input.trustedAutomationPress) return {result: "refused", reason: "stale-session"};
      if (refused) return {result: "refused", reason: "authority-refused"};
      const result = await submit(input, signal);
      if (loseAck) {loseAck = false; throw new Error("Lost native acknowledgement");}
      return result;
    };
    return captured;
  };
  const delivery = automationRecordDelivery({replica, namespace, ownerUserId: "owner", capture});
  const recordEngine = replicaRecordEngine(replica);
  recordEngine.prepareSharedRecord = (_path, signal) => delivery.synchronize(binding, signal);
  recordEngine.deliverSharedRecord = async (_path, signal) => { await delivery.drain(binding, signal); };
  const context = replicaRecordEditContext(replica, recordEngine, copy.lifetime);
  const author = {...AUTOMATION, onBehalfOf: "owner"};
  loseAck = true;
  const write = await setCollectionRecordFields(context, {recordPath: "Tasks/one.md", fields: {Status: "Done"}, author, idempotencyKeyPrefix: "native-press", allowPendingSharedSettlement: true});
  expect(write.sharedFileUpdates?.Status).toBeDefined();
  await delivery.drain(binding, copy.lifetime);
  await consumer.settle(document);
  await owner.sync(); await copy.sync(); await recipient.sync();
  for (const side of [owner, copy, recipient]) {
    await vi.waitFor(async () => expect(await readFile(join(side.root, "Tasks/one.md"), "utf8")).toContain("Status: Done"), {timeout: DEADLINE_MS});
    expect((await side.record(ONE)).record.values).toContainEqual(expect.objectContaining({field: "Status", value: "Done"}));
  }
  expect((await owner.record(ONE)).history[0]).toMatchObject({actorKind: "automation", onBehalfOf: "owner", automationRun: AUTOMATION.run});

  // An enrolled server copy receives another person's accepted edit before
  // ordinary replication pulls that edit and before the next automation reads it.
  const acceptedRecords = createAutomationAcceptedRecords({replica: {...replica, ownerUserId: "owner", withRecordWork: work => work()},
    namespace, storage, synchronize: delivery.synchronize, onError: (_path, error) => {throw error;}});
  await acceptedRecords.initialize();
  const viewer = {kind: "named" as const, workspaceId: WORKSPACE, userId: "reader", shareId: "native-share", grantId: "native-grant"};
  const tickets = createLiveTickets({storage, audience: "https://relay.example.test", key,
    hostReports: {currentBinding: async () => ({connection: host, binding})}});
  const minted = await tickets.mint({objectId: document.objectId}, viewer);
  const ticket = await tickets.redeem(minted!.token, viewer);
  const liveRegistration = consumer.captureRegistration(binding);
  const readerHost = captureNamedLiveFrameHost({ticket: ticket!, actor: liveBrowserActor(viewer), storage,
    bounds: profile.namedLive.host, validate, native: {client: native, workspace: owner.workspace, registrationId: liveRegistration.id,
      coordinate: host, binding, invalidated: liveRegistration.invalidated, changes: createNamedFrameChanges(16),
      deadlineMs: DEADLINE_MS, nextRequestId: owner.nextRequestId, drain: (doc, signal) => consumer.drain(doc, signal)}});
  const readerDoc = new Y.Doc();
  try {
    const sync = await readerHost.openSync(Uint8Array.of(0), copy.lifetime);
    try {Y.applyUpdate(readerDoc, sync.missingStateUpdate);} finally {sync.close();}
    const vector = Y.encodeStateVector(readerDoc);
    readerDoc.getMap("frontmatter").set("Priority", "High");
    const updateBytes = Y.encodeStateAsUpdate(readerDoc, vector);
    expect(await readerHost.submit({deliveryId: "reader-priority", updateDigest: createHash("sha256").update(updateBytes).digest("hex"), updateBytes}, copy.lifetime))
      .toMatchObject({result: "success"});
  } finally {readerHost.close(); readerDoc.destroy();}
  await consumer.settle(document); await owner.sync();
  await acceptedRecords.refreshChanged(); await copy.sync();
  const beforeSecondWrite = await copy.record(ONE);
  expect(beforeSecondWrite.record.values).toContainEqual(expect.objectContaining({field: "Priority", value: "High"}));
  await setCollectionRecordFields(context, {recordPath: "Tasks/one.md", fields: {Status: "Reviewed"}, author,
    idempotencyKeyPrefix: "native-second-write", allowPendingSharedSettlement: true});
  expect((await copy.record(ONE)).record.values).toContainEqual(expect.objectContaining({field: "Priority", value: "High"}));
  const undo = replicaRecordEditContext(replica, recordEngine, copy.lifetime, true);
  const reverse = await setCollectionRecordFields(undo, {recordPath: "Tasks/one.md", fields: {Status: "Doing"}, author: {kind: "user", userId: "owner"}, idempotencyKeyPrefix: "native-undo", allowPendingSharedSettlement: true});
  expect(reverse.sharedFileUpdates?.Status).toBeDefined();
  await consumer.settle(document);
  await owner.sync();
  await copy.sync(); await recipient.sync();
  for (const side of [owner, copy, recipient]) expect(await readFile(join(side.root, "Tasks/one.md"), "utf8")).toContain("Status: Doing");

  // The real server executor inspects and runs an authenticated shared press.
  const route = (user: string, path: string, body?: unknown) => relay(new Request(`${relayUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: {authorization: `Bearer test:${user}`, "content-type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  expect((await route("owner", `/sync/${WORKSPACE}/automation-host/check-in`, {installId: "laptop", label: "Laptop", claim: true})).status).toBe(200);
  const metadataDir = join(copy.root, ".dohc/server-automations");
  await mkdir(metadataDir, {recursive: true});
  let hooks: Parameters<typeof startAutomationReplicas>[0] | undefined;
  const errors: string[] = [];
  let recordWork = Promise.resolve();
  const withRecordWork = <T>(work: () => Promise<T>): Promise<T> => {
    const run = recordWork.then(work);
    recordWork = run.then(() => undefined, () => undefined);
    return run;
  };
  let hostedReplica: AutomationReplica = {...replica, ownerUserId: "owner", incarnation: row.incarnation, startedAtMs: row.startedAtMs,
    metadataDir, withRecordWork, pulledHead: storage.automationWorkspaceLogHead(WORKSPACE), sync: () => withRecordWork(async () => {await copy.sync(); hooks?.onPulled?.(WORKSPACE, []);})};
  let executor: CollectionAutomations | undefined;
  const serverOptions: Parameters<typeof startAutomationServer>[0] = {storage, server: serverHost,
    createExecutor: options => {executor = new CollectionAutomations(options); return executor;},
    replicas: {root: copy.root, engineExecutable: engine.require(), relayOrigin: "https://relay.example.test", key, namespace},
    recordDelivery: {namespace, capture}, readOwnerShares: relay.readOwnerShares, lookupUserDisplayName: () => "Owner",
    noticeLimiter: new TokenBucketLimiter(10, 1, 100), onError: (context, error) => errors.push(`${context}: ${String(error)}`),
    startReplicas: async options => {hooks = options; const stop = hostedReplica.client.onEvent(event => options.onEngineEvent?.(event));
      return {unavailable: false, replica: () => hostedReplica, reconcile: () => undefined, deleteWorkspaces: async () => undefined,
      failedSyncs: () => new Map(), settled: async () => undefined, close: async () => stop()};},
  };
  let running = await startAutomationServer(serverOptions);
  cleanup.push(() => running.close());
  hooks!.onChanged?.(WORKSPACE);
  await vi.waitFor(() => expect(executor).toBeDefined(), {timeout: DEADLINE_MS});
  await executor!.open();
  const scope = {workspaceId: WORKSPACE, ownerUserId: "owner"};
  const markId = (await executor!.automationIdAt("Tasks", "mark"))!;
  expect(markId).toBeTruthy();
  const parsed = parseAutomationsFile(markText);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("Invalid fixture automation.");
  const hash = definitionHash(parsed.entries[0].automation);
  let inspectionId = 0;
  const inspect = (shareId: string, grantId: string) => storage.inspectAutomationButton({
    target: {automationId: "mark", collectionPath: "Tasks", definitionHash: hash},
    source: {workspaceId: WORKSPACE, shareId, grantId, grantGeneration: 1, userId: "reader"},
    id: `native-inspection-${++inspectionId}`, signal: copy.lifetime, wake: () => undefined});
  const grantButton = async () => {
    const response = await route("owner", `/sync/${WORKSPACE}/shares`, {recipientUserId: "reader", paths: ["Tasks"], access: "edit"});
    expect(response.status).toBe(200);
    const {shareId} = await response.json() as {shareId: string};
    return {shareId, grantId: storage.listActiveShareGrantsForRecipient(shareId, "reader")[0]!.grantId};
  };
  const firstGrant = await grantButton();
  const sharedValue = async (grant: {shareId: string; grantId: string}) => {
    const viewer = {kind: "named" as const, workspaceId: WORKSPACE, userId: "reader", ...grant};
    const current = storage.resolveCurrentLiveDocumentBinding({document, actor: liveBrowserActor(viewer)});
    if (current.kind !== "current") throw new Error("The recipient cannot read the live record.");
    const tickets = createLiveTickets({storage, audience: "https://relay.example.test", key,
      hostReports: {currentBinding: async () => ({connection: host, binding: current.binding})}});
    const minted = await tickets.mint({objectId: document.objectId}, viewer);
    const ticket = await tickets.redeem(minted!.token, viewer);
    const registration = consumer.captureRegistration(current.binding);
    const shared = captureNamedLiveFrameHost({ticket: ticket!, actor: liveBrowserActor(viewer), storage,
      bounds: profile.namedLive.host, validate, native: {client: native, workspace: owner.workspace, registrationId: registration.id,
        coordinate: host, binding: current.binding, invalidated: registration.invalidated, changes: createNamedFrameChanges(16),
        deadlineMs: DEADLINE_MS, nextRequestId: owner.nextRequestId, drain: (doc, signal) => consumer.drain(doc, signal)}});
    const view = new Y.Doc();
    try {
      const sync = await shared.openSync(Uint8Array.of(0), copy.lifetime);
      try {Y.applyUpdate(view, sync.missingStateUpdate); return view.getMap("frontmatter").get("Status");}
      finally {sync.close();}
    } finally {shared.close(); view.destroy();}
  };
  await vi.waitFor(() => expect(running.runs.holds(scope).some(hold => hold.automationId === markId)).toBe(true), {timeout: DEADLINE_MS});
  expect(await inspect(firstGrant.shareId, firstGrant.grantId)).toMatchObject({kind: "denied", reason: SHARED_BUTTON_HELD});
  expect(errors.some(error => error.includes("held-step"))).toBe(true);
  await vi.waitFor(async () => {
    const notices = await (await route("owner", "/sync/notices?limit=100")).json() as {notices: Array<{body: string}>};
    expect(notices.notices.some(notice => notice.body.includes("Allow it in Notices") && notice.body.includes("your server"))).toBe(true);
    const recipientNotices = await (await route("reader", "/sync/notices?limit=100")).json() as {notices: Array<{body: string}>};
    expect(recipientNotices.notices.some(notice => notice.body.includes("Allow it in Notices"))).toBe(false);
  }, {timeout: DEADLINE_MS});
  for (const hold of running.runs.holds(scope)) await running.runs.allow(scope, hold);
  await vi.waitFor(async () => expect(await inspect(firstGrant.shareId, firstGrant.grantId)).toMatchObject({kind: "ready"}), {timeout: DEADLINE_MS});
  const press = async (shareId: string, pressId: string, delayed = false) => {
    staleRecipient = delayed;
    expect((await route("reader", `/sync/shares/${shareId}/automation-presses`, {pressId, automationId: markId, collectionPath: "Tasks", definitionHash: hash, recordId: ONE, confirmed: []})).status).toBe(200);
    let claimId = "";
    if (delayed) {
      await vi.waitFor(async () => {
        const {runs} = await running.runs.list(scope, markId);
        expect(runs[0]?.state).toBe("done");
        expect(runs[0]?.sharedSettlementPending).toBe(true);
        const receipt = await route("reader", `/sync/shares/${shareId}/automation-presses`, {pressId, automationId: markId,
          collectionPath: "Tasks", definitionHash: hash, recordId: ONE, confirmed: []});
        expect(await receipt.json()).toMatchObject({state: "settled"});
      }, {timeout: DEADLINE_MS});
      await running.close();
      staleRecipient = false;
      running = await startAutomationServer(serverOptions);
      hooks!.onChanged?.(WORKSPACE);
      await executor!.open();
    }
    await vi.waitFor(async () => {
      const {runs} = await running.runs.list(scope, markId);
      const run = runs.find(candidate => !candidate.undone);
      expect(run?.state, JSON.stringify({run, errors})).toBe("done");
      expect(run?.writes).toContainEqual(expect.objectContaining({field: "Status", sharedFileUpdateState: "settled"}));
      expect(run?.sharedSettlementPending).toBeUndefined();
      expect(run?.sharedSettlementNotAccepted).toBeUndefined();
      claimId = run!.claimId;
    }, {timeout: DEADLINE_MS});
    await consumer.settle(document); await owner.sync(); await recipient.sync();
    for (const side of [owner, recipient]) {
      expect(await readFile(join(side.root, "Tasks/one.md"), "utf8")).toContain("Status: Done");
      expect((await side.record(ONE)).record.values).toContainEqual(expect.objectContaining({field: "Status", value: "Done"}));
    }
    expect(await sharedValue({shareId, grantId: storage.listActiveShareGrantsForRecipient(shareId, "reader")[0]!.grantId})).toBe("Done");
    return claimId;
  };
  const claimId = await press(firstGrant.shareId, "button-native-first", true);
  expect((await route("reader", `/sync/shares/${firstGrant.shareId}/automation-presses`, {pressId: "button-native-first", automationId: markId,
    collectionPath: "Tasks", definitionHash: hash, recordId: ONE, confirmed: []})).status).toBe(200);
  expect((await running.runs.list(scope, markId)).runs).toHaveLength(1);
  expect((await owner.record(ONE)).history.filter(entry => entry.automationRun?.claimId === claimId)).toHaveLength(1);
  expect(await running.runs.undo(scope, {automationId: markId, claimId, deletes: null})).toMatchObject({status: "undone"});
  await vi.waitFor(async () => expect((await running.runs.get(scope, markId, claimId))?.undone).toBe(true), {timeout: DEADLINE_MS});
  await consumer.settle(document); await owner.sync(); await recipient.sync();
  for (const side of [owner, recipient]) expect(await readFile(join(side.root, "Tasks/one.md"), "utf8")).toContain("Status: Doing");
  expect(await sharedValue(firstGrant)).toBe("Doing");
  const restoredClaim = await press(firstGrant.shareId, "button-native-before-stop");
  expect(await running.runs.restore(scope, [{collectionPath: "Tasks", id: "mark", definitionHash: hash}], false, "restore-test")).toMatchObject({undone: 1, left: 0, errorMessage: null});
  await vi.waitFor(async () => expect((await running.runs.get(scope, markId, restoredClaim))?.undone).toBe(true), {timeout: DEADLINE_MS});
  await consumer.settle(document); await owner.sync(); await recipient.sync();
  for (const side of [owner, recipient]) expect(await readFile(join(side.root, "Tasks/one.md"), "utf8")).toContain("Status: Doing");
  // QA5's product path also restores the recipient's definition-file edit.
  // Keep Mark's definition identical while adding another definition, so
  // Stop and restore cannot hide a Mark readiness problem behind a new hash.
  const changedDefinition = `${markText}  - id: other\n    name: Other\n    when: {button: Other}\n    do: [{set: {Status: Other}}]\n`;
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const upload = await relay(new Request(`${relayUrl}/sync/shares/${firstGrant.shareId}/blobs/${digest(changedDefinition)}`, {
    method: "PUT", headers: {authorization: "Bearer test:reader"}, body: changedDefinition,
  }));
  expect(upload.status).toBe(200);
  const written = await route("reader", `/sync/shares/${firstGrant.shareId}/collection-writes`, {submitId: "qa5-definition", changes: [{
    basedOnPath: "Tasks/automations.yaml", basedOnBlobSha256: digest(markText), operation: "write", afterPath: "Tasks/automations.yaml",
    afterBlobSha256: digest(changedDefinition), afterContentKind: "text", afterByteLength: Buffer.byteLength(changedDefinition), recordedAtMs: Date.now(),
  }]});
  expect(written.status, await written.clone().text()).toBe(200);
  await owner.sync(); await copy.sync();
  const ownerHistory = new VersionedLiveAdapter(owner.client, owner.workspace, {workspaceId: WORKSPACE});
  const readMoment = async (momentId: string): Promise<WorkspaceEngineMomentDetail | null> => {
    const moment = await ownerHistory.getMoment({workspaceId: WORKSPACE, momentId});
    if (!moment) return null;
    const text = async (side: "before" | "after") => {
      const inline = side === "before" ? moment.beforeText : moment.afterText;
      if (inline !== null) return inline;
      const sha256 = side === "before" ? moment.beforeBlobSha256 : moment.afterBlobSha256;
      return sha256 === null ? "" : (await ownerHistory.readTextBlob({workspaceId: WORKSPACE, sha256}))!;
    };
    return {protected: false, moment: {id: moment.momentId, objectId: moment.objectId, workspaceId: WORKSPACE, versionId: moment.versionId,
      path: moment.path, operation: moment.operation, recordedAtMs: moment.recordedAtMs, metadata: {origin: "sync"},
      payload: {before: moment.beforePresent ? {path: moment.beforePath!, text: await text("before")} : null,
        after: {path: moment.path, text: await text("after")}}}};
  };
  const handlers = new Map<string, (event: {sender: string}, payload: unknown) => unknown>();
  registerStopAndRestoreIpc({
    currentAutomations: () => executor!, canReleaseRuns: () => true,
    registerHandler: (channel, handler) => handlers.set(channel, handler), assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_sender: string, _workspaceId, _message, work) => work({
      workspace: {workspaceId: WORKSPACE, rootPath: owner.root}, state: {collectionAutomations: executor!}, assertCurrent: () => undefined,
    }),
    remoteForWorkspace: async () => ({credentials: "owner", credentialGeneration: 1}), currentCredentialGeneration: () => 1,
    relayJson: async <T>(_credentials: string, path: string, init?: RequestInit) => {
      const response = await relay(new Request(`${relayUrl}${path}`, {...init, headers: {authorization: "Bearer test:owner", "content-type": "application/json"}}));
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as T;
    },
    endLink: async () => "ended", sharesChanged: () => executor!.rosterChanged(),
    localPerson: async () => ({kind: "human", humanId: "owner"}), queuePull: () => undefined,
    syncNow: async () => {await owner.sync(); await copy.sync();}, deletePath: async () => undefined,
    notifyRenderer: () => undefined, assertOriginalWorkspace: () => undefined,
    serverRuns: {
      restore: (_workspaceId, definitions, again, retentionId) => running.runs.restore(scope, definitions, again, retentionId),
      releaseRestore: async (_workspaceId, retentionId) => {await running.runs.restore(scope, [], false, retentionId); return true;},
    },
    requireEngineCapture: async () => ({capture: {
      readMoment,
      findRestoreReceipt: async () => {throw new Error("This fixture has no unjournaled restore to recover.");},
      publicationApplied: async () => {throw new Error("This fixture has no unjournaled restore to recover.");},
      listObjectMomentsAfter: async (objectId, momentId) => {
        const page = await ownerHistory.listMoments({workspaceId: WORKSPACE, versionId: "main", objectId, limit: 100});
        const before = page.moments.findIndex(moment => moment.momentId === momentId);
        return page.moments.slice(0, before).map(moment => moment.momentId);
      },
      restoreFileToBeforeMoment: async (momentId, _person, options) => {
        const moment = await readMoment(momentId);
        if (!moment || moment.protected || !moment.moment.payload.before) throw new Error("Missing definition moment.");
        const current = await ownerHistory.readTextFile({workspaceId: WORKSPACE, versionId: "main", path: moment.moment.path});
        expect(current?.latestMomentId).toBe(options?.expectedHeadMomentId);
        const restored = await ownerHistory.writeTextFile({workspaceId: WORKSPACE, versionId: "main", path: moment.moment.path,
          text: moment.moment.payload.before.text, restoreBeforeMomentId: momentId, publish: true, metadata: {origin: "restore"}, author: {kind: "human", humanId: "owner"}});
        return {restored: "text" as const, restoredMomentId: restored.moment.momentId, path: moment.moment.path};
      },
    }}),
  });
  expect(await handlers.get(CHANNELS.stopAndRestore)!({sender: "owner-window"}, {workspaceId: WORKSPACE, target: {kind: "person", userId: "reader"}}))
    .toMatchObject({status: "restored", restored: [{path: "Tasks/automations.yaml"}], unfinished: null});
  await owner.sync(); await copy.sync();
  expect(await readFile(join(owner.root, "Tasks/automations.yaml"), "utf8")).toBe(markText);
  expect(await readFile(join(copy.root, "Tasks/automations.yaml"), "utf8")).toBe(markText);
  const freshGrant = await grantButton();
  ownerDeliveryShare = freshGrant.shareId;
  await vi.waitFor(async () => expect(await inspect(freshGrant.shareId, freshGrant.grantId)).toMatchObject({kind: "ready"}), {timeout: DEADLINE_MS});
  // A fresh server replica cannot infer the prior host's Allow from identical
  // definition bytes, even though the prior replica was ready.
  await running.close();
  const afterRestore = await computer({root: join(root, "after-restore"), relayUrl,
    bearerToken: deriveAutomationReplicaBearer(row, {key, namespace}),
    identity: {kind: "join", replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity}});
  await afterRestore.sync();
  const freshMetadataDir = join(afterRestore.root, ".dohc/server-automations");
  await mkdir(freshMetadataDir, {recursive: true});
  hostedReplica = {...afterRestore, workspaceId: WORKSPACE, signal: afterRestore.lifetime, ownerUserId: "owner",
    incarnation: row.incarnation, startedAtMs: row.startedAtMs, metadataDir: freshMetadataDir, withRecordWork,
    pulledHead: storage.automationWorkspaceLogHead(WORKSPACE), sync: () => withRecordWork(async () => {await afterRestore.sync(); hooks?.onPulled?.(WORKSPACE, []);})};
  running = await startAutomationServer(serverOptions);
  cleanup.push(() => running.close());
  hooks!.onChanged?.(WORKSPACE);
  await vi.waitFor(async () => expect(await inspect(freshGrant.shareId, freshGrant.grantId)).toEqual({kind: "denied", reason: SHARED_BUTTON_HELD}), {timeout: DEADLINE_MS});
  expect(await readFile(join(afterRestore.root, "Tasks/automations.yaml"), "utf8")).toBe(markText);
  for (const hold of running.runs.holds(scope)) await running.runs.allow(scope, hold);
  await vi.waitFor(async () => expect(await inspect(freshGrant.shareId, freshGrant.grantId)).toMatchObject({kind: "ready"}), {timeout: DEADLINE_MS});
  const secondClaim = await press(freshGrant.shareId, "button-native-after-restore");
  refused = failure === "undo";
  await running.runs.undo(scope, {automationId: markId, claimId: secondClaim, deletes: null});
  if (failure === "undo") {
    await vi.waitFor(async () => expect(await running.runs.get(scope, markId, secondClaim)).toMatchObject({undone: false, undoSettlementNotAccepted: true,
      reversals: [expect.objectContaining({state: "not-accepted"})]}), {timeout: DEADLINE_MS});
  } else {
    await vi.waitFor(async () => expect((await running.runs.get(scope, markId, secondClaim))?.undone).toBe(true), {timeout: DEADLINE_MS});
    await consumer.settle(document); await owner.sync(); await recipient.sync();
    refused = true;
    expect((await route("reader", `/sync/shares/${freshGrant.shareId}/automation-presses`, {pressId: "button-native-refused", automationId: markId,
      collectionPath: "Tasks", definitionHash: hash, recordId: ONE, confirmed: []})).status).toBe(200);
    await vi.waitFor(async () => {
      const run = (await running.runs.list(scope, markId)).runs.find(run => !run.undone);
      expect(run).toMatchObject({sharedSettlementNotAccepted: true, writes: [expect.objectContaining({sharedFileUpdateState: "not-accepted"})]});
      expect(run?.writes.some(write => write.kind === "field" && write.sharedFileUpdateState === "settled")).toBe(false);
    }, {timeout: DEADLINE_MS});
  }
  for (const side of [owner, recipient]) expect(await readFile(join(side.root, "Tasks/one.md"), "utf8")).toContain(`Status: ${failure === "undo" ? "Done" : "Doing"}`);
  expect(await sharedValue(freshGrant)).toBe(failure === "undo" ? "Done" : "Doing");
  refused = false;
  const stampId = (await executor!.automationIdAt("Tasks", "stamp"))!;
  const pressChain = async (pressId: string) => {
    expect((await route("reader", `/sync/shares/${freshGrant.shareId}/automation-presses`, {pressId, automationId: markId,
      collectionPath: "Tasks", definitionHash: hash, recordId: TWO, confirmed: []})).status).toBe(200);
  };
  for (const hold of running.runs.holds(scope)) await running.runs.allow(scope, hold);
  await pressChain("native-chain-allowed");
  await vi.waitFor(async () => {
    const runs = (await running.runs.list(scope, stampId)).runs;
    expect(runs.some(run => run.state === "done" && run.writes.some(write => write.kind === "field" && write.field === "Finished")), JSON.stringify({runs, errors})).toBe(true);
  }, {timeout: DEADLINE_MS});
  await hostedReplica.sync(); await owner.sync();
  expect((await owner.record(TWO)).record.values).toContainEqual(expect.objectContaining({field: "Finished", value: "2026-10-06"}));
  expect((await owner.record(TWO)).history.find(entry => entry.automationRun?.automationName === "Stamp finish date"))
    .toMatchObject({actorKind: "automation", onBehalfOf: "reader"});
  const latestStamp = (await running.runs.list(scope, stampId)).runs.find(run => run.trigger.recordId === TWO)!;
  await running.runs.undo(scope, {automationId: stampId, claimId: latestStamp.claimId, deletes: null});
  const latestMark = (await running.runs.list(scope, markId)).runs.find(run => run.trigger.recordId === TWO)!;
  await running.runs.undo(scope, {automationId: markId, claimId: latestMark.claimId, deletes: null});
  await hostedReplica.sync(); await owner.sync();
  let chainClaim = "";
  let reached!: () => void, release!: () => void;
  const atChain = new Promise<void>(resolve => {reached = resolve;});
  const resume = new Promise<void>(resolve => {release = resolve;});
  const sendRequest = hostedReplica.client.sendRequest.bind(hostedReplica.client);
  const claimGate = vi.spyOn(hostedReplica.client, "sendRequest").mockImplementation(async (...args) => {
    const response = await sendRequest(...args);
    if (args[0].method === "automations.getClaim") {
      const result = response.result as {claim?: {claimId?: string; automationId?: string; parentClaimId?: string}};
      if (result.claim?.automationId === stampId && result.claim.parentClaimId && result.claim.claimId !== latestStamp.claimId) {
        chainClaim = result.claim.claimId!;
        reached(); await resume;
      }
    }
    return response;
  });
  try {
    await pressChain("native-chain-revoked");
    await vi.waitFor(() => expect(chainClaim).not.toBe(""), {timeout: DEADLINE_MS});
    await atChain;
    (storage as StorageContext).db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=? WHERE grant_id=?").run(Date.now(), freshGrant.grantId);
    release();
    await vi.waitFor(async () => {
      const run = await running.runs.get(scope, stampId, chainClaim);
      expect(run).toMatchObject({state: "failed", writes: []});
      expect(run?.error).toContain("This automation cannot change this record");
    }, {timeout: DEADLINE_MS});
    expect((await new VersionedLiveAdapter(hostedReplica.client, hostedReplica.workspace, {workspaceId: WORKSPACE})
      .getCollectionRecord({collectionPath: "Tasks", recordId: TWO, historyLimit: 1})).record.values)
      .not.toContainEqual(expect.objectContaining({field: "Finished", value: "2026-10-06"}));
  } finally {release(); claimGate.mockRestore();}
  await running.close();
}, 120_000);

it.skipIf(engine.missing)("finds one filtered record among 5000 without refreshing or enrolling unrelated records", async () => {
  const root = await tempRoot("automation-find-5000");
  const storage = await testStorage();
  const relay = createSyncRelayHandler({storage, resolveActor: testActor});
  storage.claimWorkspace({workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: Date.now()});
  const localRoot = join(root, "copy");
  await mkdir(join(localRoot, "Tasks"), {recursive: true});
  await writeFile(join(localRoot, "Tasks/collection.yaml"), "name: Tasks\nfields:\n  Status: {type: text}\n");
  for (let start = 0; start < 5000; start += 100) await Promise.all(Array.from({length: 100}, (_, offset) => {
    const index = start + offset;
    return writeFile(join(localRoot, `Tasks/${String(index).padStart(4, "0")}.md`), `---\nid: ${derivedRecordId(`benchmark-${index}`)}\nStatus: ${index === 4999 ? "Wanted" : "Other"}\n---\n\nRecord ${index}.\n`);
  }));
  const copy = await computer({root: localRoot, relayUrl: "http://127.0.0.1:1", bearerToken: "test:owner", identity: {kind: "claim"}, captureMode: "full"});
  const adapter = new VersionedLiveAdapter(copy.client, copy.workspace, {workspaceId: WORKSPACE});
  await vi.waitFor(async () => expect(await adapter.flushCapture()).toMatchObject({settled: true}), {timeout: 120_000});
  await mkdir(join(localRoot, ".dohc/bench"), {recursive: true});
  let laneEntries = 0;
  const replica: AutomationReplica = {...copy, workspaceId: WORKSPACE, ownerUserId: "owner", root: localRoot, metadataDir: join(localRoot, ".dohc/bench"),
    signal: copy.lifetime, incarnation: 1, startedAtMs: Date.now(), pulledHead: 0,
    sync: async () => undefined, withRecordWork: async work => {laneEntries++; return work();}};
  const bindingReads = vi.spyOn(storage, "automationRecordBinding");
  const capture = vi.fn(async (): Promise<never> => {throw Error("Find must not capture the owner host");});
  const errors: Array<{context: string; error: unknown}> = [];
  const tracker = createAutomationAcceptedRecords({replica, namespace: "find-5000", storage, synchronize: capture, onError: (_path, error) => {throw error;}});
  const prune = vi.spyOn(VersionedLiveAdapter.prototype, "pruneAutomationHistory").mockRejectedValue(
    new DaemonRefusalError({code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff"}, undefined));
  cleanup.push(async () => {prune.mockRestore();});
  let hooks: Parameters<typeof startAutomationReplicas>[0] | undefined;
  let options: ConstructorParameters<typeof CollectionAutomations>[0] | undefined;
  const running = await startAutomationServer({storage, server: {label: "Benchmark"},
    replicas: {root: localRoot, engineExecutable: engine.require(), relayOrigin: "https://relay.example.test", key: new Uint8Array(32), namespace: "find-5000"},
    recordDelivery: {namespace: "find-5000", capture}, readOwnerShares: relay.readOwnerShares, lookupUserDisplayName: () => "Owner",
    noticeLimiter: new TokenBucketLimiter(10, 1, 100), onError: (context, error) => {errors.push({context, error});},
    createExecutor: input => {options = input; return new CollectionAutomations(input);},
    startReplicas: async input => {hooks = input; return {unavailable: false, replica: () => replica, reconcile: () => undefined, deleteWorkspaces: async () => undefined,
      failedSyncs: () => new Map(), settled: async () => undefined, close: async () => undefined};}});
  cleanup.push(() => running.close());
  hooks!.onChanged?.(WORKSPACE);
  await vi.waitFor(() => expect(options).toBeDefined(), {timeout: DEADLINE_MS});
  const query = {collectionPath: "Tasks", filter: {field: "Status", operator: "equals" as const, value: "Wanted"}, limit: 1};
  const baseline: number[] = [], changed: number[] = [];
  // Warm both paths, then alternate five runs with the same native index and machine.
  for (let iteration = 0; iteration < 6; iteration++) {
    const before = performance.now();
    let cursor;
    let visited = 0;
    do {
      const page = await adapter.queryCollectionRecords({collectionPath: "Tasks", ...(cursor ? {cursor} : {})});
      for (const record of page.records) {await tracker.refresh(record.path); visited++;}
      cursor = page.nextCursor;
    } while (cursor);
    expect(visited).toBe(5000);
    expect((await adapter.queryCollectionRecords(query)).records).toHaveLength(1);
    const beforeMs = performance.now() - before;
    bindingReads.mockClear(); laneEntries = 0;
    const after = performance.now();
    const result = await options!.withEngine(native => native.queryCollectionRecords(query));
    const afterMs = performance.now() - after;
    expect(result?.records).toHaveLength(1);
    expect(bindingReads).not.toHaveBeenCalled(); expect(laneEntries).toBe(0); expect(capture).not.toHaveBeenCalled();
    if (iteration > 0) {baseline.push(beforeMs); changed.push(afterMs);}
  }
  const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[2]!;
  const measurement = {baseline, changed, beforeMedianMs: median(baseline), afterMedianMs: median(changed),
    beforeRecordLanes: 5000, afterRecordLanes: 0, liveRecords: 0, filter: query.filter, limit: query.limit};
  console.log("FIND_5000 " + JSON.stringify(measurement));
  if (process.env.DOHC_AUTOMATION_FIND_MEASUREMENT) await writeFile(process.env.DOHC_AUTOMATION_FIND_MEASUREMENT, JSON.stringify(measurement));
  await vi.waitFor(() => expect(prune).toHaveBeenCalled(), {timeout: DEADLINE_MS});
  await running.close();
  const unexpectedErrors = errors.filter(({context, error}) =>
    context !== `automations in workspace "${WORKSPACE}": expire automation run history` ||
    !(error instanceof DaemonRefusalError && isEngineStoreBusyRefusal(error) && error.retry === "afterBackoff"));
  expect(unexpectedErrors.map(({context, error}) => `${context}: ${String(error)}`)).toEqual([]);
}, 180_000);

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
  const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner", shareId: "native-share"}});
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
    ownerAdmission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([[WORKSPACE, "native-share"]]), maxEntriesPerDrain: 128, maxBytesPerDrain: profile.nativeIngress.maxAdoptionBytes, refusals: new OwnerKnownRefusals(), validate}});
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
    const ownerHost = captureOwnerLiveFrameHost({...common, authenticatedUserId: "owner", shareId: "native-share",
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
  let deduped = false;
  const write = native.adapter.writeTextFile.bind(native.adapter);
  native.adapter.writeTextFile = async input => { const result = await write(input); deduped ||= result.deduped === true; return result; };
  const context = replicaRecordEditContext(replica, native, new AbortController().signal);
  const db = new DatabaseSync(join(root, ".dohc/engine/engine.db"));
  db.exec("PRAGMA busy_timeout=10000");
  db.exec("CREATE TRIGGER block_adoption BEFORE INSERT ON collection_records WHEN NEW.file_path = 'Tasks/made.md' BEGIN SELECT RAISE(FAIL, 'test adoption failure'); END");
  const input = { collectionPath: "Tasks", name: "made", recordId: TWO, fields: { Status: "New" }, author: AUTOMATION, idempotencyKeyPrefix: "unadopted" };
  try {
    await expect(createCollectionRecord(context, input)).resolves.toMatchObject({ kind: "partial" });
    expect((await adapter.readTextFile({ workspaceId: WORKSPACE, versionId: "main", path: "Tasks/made.md" }))?.text).toContain(TWO);
    expect(db.prepare("SELECT count(*) AS n FROM collection_records WHERE record_id = ?").get(TWO)?.n).toBe(0);
    db.exec("DROP TRIGGER block_adoption");
    await expect(createCollectionRecord(context, input)).resolves.toEqual({ path: "Tasks/made.md", recordId: TWO });
    expect(deduped).toBe(true);
    expect((await adapter.getCollectionRecord({ collectionPath: "Tasks", recordId: TWO, historyLimit: 1 })).record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "New" }));
  } finally { db.exec("DROP TRIGGER IF EXISTS block_adoption"); db.close(); }
}, 120_000);
