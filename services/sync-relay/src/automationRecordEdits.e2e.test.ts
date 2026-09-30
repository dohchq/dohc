import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import { createCollectionRecord, setCollectionRecordFields } from "@dohc/automation-executor/collection-record-edits";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
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

// A server's automation writes records in its own replica of the owner's
// workspace, through the real engine: a plain daemon, a workspace opened
// without capture, the relay route, and a join as the owner. The owner's
// computer then receives each change with the automation as its author.

const engine = requireEngineBinaryOrSkip();
const WORKSPACE = "workspace-trip";
const AUTOMATION = { kind: "automation", automationId: "collection:Tasks#stamp", onBehalfOf: "owner", depth: 1 } as const;
const ONE = derivedRecordId("seeded-one");
const TWO = derivedRecordId("claim-1/0");
const DEADLINE_MS = 30_000;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  closeTestStorages();
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
}) {
  await mkdir(input.root, { recursive: true });
  const client = await createEngineClient({
    command: engine.require(), authToken: randomBytes(32).toString("base64url"),
    protocolVersion: 2, capabilities: ["blobs"], connectTimeoutMs: DEADLINE_MS,
  });
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  const request = async (method: string, params: { [key: string]: JsonValue }, workspace?: string) =>
    (await client.sendRequest({ id: nextRequestId(), method, params, ...(workspace ? { workspace } : {}), deadlineMs: DEADLINE_MS }))
      .result as { [key: string]: JsonValue };
  const opened = await request("workspace.open", {
    rootDir: input.root, workspaceId: WORKSPACE, captureMode: "none", reconcileCollections: true,
    relay: { baseUrl: input.relayUrl, bearerToken: input.bearerToken, allowInsecureLoopbackForTests: true },
  });
  const workspace = opened.workspace as string;
  // Pulled moments land in the main version, as the server's replica makes it at open.
  await request("versions.ensureMain", { workspaceId: WORKSPACE }, workspace);
  const lifetime = new AbortController();
  // The engine reaches the relay through the route it opened with; this
  // configuration only checks the credential's shape, so it names the
  // relay's public origin as a deployment would.
  const replication = new ServiceOrdinaryReplication(
    { client, workspace, workspaceId: WORKSPACE, nextRequestId, deadlineMs: DEADLINE_MS, signal: lifetime.signal, assertCurrent: () => undefined },
    { relay: { baseUrl: "https://relay.example.test", bearerToken: input.bearerToken }, identity: input.identity, maxPagesPerPull: 8 },
  );
  const closeEngine = async () => {
    lifetime.abort();
    await request("workspace.close", {}, workspace).catch(() => undefined);
    client.close();
    await client.waitForExit();
  };
  cleanup.push(closeEngine);
  return {
    client, workspace, lifetime: lifetime.signal, request,
    async sync() {
      for (let more = true; more;) more = (await replication.push()).hasMore;
      for (let more = true; more;) more = (await replication.pull()).hasMore;
    },
    record: async (recordId: string) =>
      await request("collections.getRecord", { collectionPath: "Tasks", recordId, historyLimit: 10 }, workspace) as unknown as CollectionGetRecordResult,
  };
}

it.skipIf(engine.missing)("writes an automation's records on the server's replica, and the owner's computer receives them", async () => {
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
  await server.sync();

  // The owner's computer receives both, with the automation as their author.
  await owner.sync();
  const byAutomation = { authorOriginId: AUTOMATION.automationId, actorKind: "automation", onBehalfOf: "owner", depth: 1 };
  const one = await owner.record(ONE);
  expect(one.record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "Done" }));
  expect(one.history[0]).toMatchObject({ field: "Status", next: { value: "Done" }, ...byAutomation });
  const two = await owner.record(TWO);
  expect(two.record.path).toBe("Tasks/Two.md");
  expect(two.record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "Open" }));
  // A record added as a whole file carries no field history to other
  // computers, whoever adds it; the server's copy names the automation.
  expect((await server.record(TWO)).history[0]).toMatchObject({ field: "Status", next: { value: "Open" }, ...byAutomation });
});
