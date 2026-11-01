import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture as relayFixture, limits as relayLimits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { compileDatasetOperations } from "../../../../services/sync-relay/src/datasetCompiler";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { createDatasetHandler } from "../ipc/datasetIpc";
import { readDatasetResponse } from "../ipc/readDatasetResponse";
import { unguardedCollections } from "../testing/collectionsHolder";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { openedLocalState } from "../testing/preparedLocalState";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { collectionPlace, finishedTransfer, moveCollectionToServer } from "./collectionMove";
import { createLocalDatasetHost } from "./localDatasetHost";
import { createDatasetAuthorityRouter, createRemoteDatasetData } from "./remoteDataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Items", schemaPath: "items/schema.sql", operationsPath: "items/operations.js",
  tables: [{ tableId: id(2), name: "Items", sqlName: "items", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [
    { operationId: id(5), name: "list", label: "List items", tableId: id(2), kind: "read", access: "link", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "add", label: "Add item", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)] },
  ] };
const sources = new Map([
  ["items/dataset.json", JSON.stringify(definition)],
  [definition.schemaPath, "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);"],
  [definition.operationsPath, `globalThis.operations={
  list(ctx){return ctx.db.query('SELECT name FROM items ORDER BY name');},
  add(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.name]);return {name:input.name};}
};`],
]);
const roots: string[] = [], hosts: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * The owner's Collection on this computer, with one record, and the owner's server with the folder shared with a teammate who accepted it.
 * `relay` sees each request of the owner's move before it is sent. `restart` closes this computer's Collections and opens them again.
 * `changed` hears what this computer's Collections tell the automation runner.
 */
async function collectionOnThisComputer(options: { relay?(path: string, init: RequestInit, send: (init: RequestInit) => Promise<unknown>): Promise<unknown>; changed?(): void } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-collection-move-")); roots.push(workspaceRoot);
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const open = async () => {
    const host = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, localPersonId: () => "person-local",
      compile: createDatasetFixtureCompiler(), holder: unguardedCollections, onDatasetsChanged: () => options.changed?.() }); hosts.push(host);
    return host;
  };
  let local = await open();
  const restart = async () => { hosts.splice(hosts.indexOf(local), 1); await local.close(); local = await open(); };
  const adapter = sourceCaptureAdapter(sources);
  const prepared = await local.prepare({ descriptorPath: "items/dataset.json", adapter });
  const approved = await local.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  const pinned = { revision: approved.revision, revisionSha256: approved.revisionSha256 };

  const relay = relayFixture(), relayDirectory = await mkdtemp(join(tmpdir(), "dohc-collection-move-relay-")); roots.push(relayDirectory);
  relay.storage.createShare({ share: { shareId: "team", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({ paths: ["items"], versionId: null }), createdAtMs: 1 },
    grant: { grantId: "team-grant", shareId: "team", principalKind: "user", principalUserId: "teammate", principalEmail: null, access: "edit",
      generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
  const relayHost = await relay.storage.createDatasetHost({ directory: relayDirectory, limits: relayLimits, compileOperations: compileDatasetOperations,
    onShutdownError(error) { throw error; } }); hosts.push(relayHost);
  const handler = createSyncRelayHandler({ storage: relay.storage, datasetHost: relayHost, appPublicationLimits: relayLimits,
    resolveActor(request, workspaceId) {
      const userId = { "Bearer owner-token": "owner", "Bearer teammate-token": "teammate" }[request.headers.get("authorization") ?? ""];
      if (!userId) throw Error("credentials");
      return { workspaceId, userId };
    } });
  const controller = new AbortController();
  const transport = async (_credentials: unknown, path: string, init: RequestInit) => {
    const response = await handler(new Request(`https://relay.test${path}`, { ...init, ...(init.body instanceof ReadableStream ? { duplex: "half" as const } : {}) }));
    const value = path.includes("/imports/") ? await response.json() : await readDatasetResponse(response, path.split("/").at(-1)!, controller.signal);
    if (!response.ok) throw Error(`Relay ${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  const credentials = (user: string) => ({ serverUrl: "https://account.test", relayUrl: "https://relay.test", token: `${user}-token`, userId: user, email: `${user}@example.test` });
  const session = { credentialGeneration: 1, currentCredentialGeneration: () => 1, signal: controller.signal, assertCurrent() {} };
  const authorized = (user: string) => async (credentials: { token: string }, path: string, init: RequestInit) =>
    transport(credentials, path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${user}-token` } });
  const relayStream = (credentials: { token: string }, path: string, init: RequestInit) => {
    const send = (next: RequestInit) => authorized("owner")(credentials, path, next);
    return options.relay ? options.relay(path, init, send) : send(init);
  };
  const move = { workspaceId: "w", credentials: credentials("owner"), credentialGeneration: 1, currentCredentialGeneration: () => 1, relayStream };
  const finished = (datasetId: string) => finishedTransfer({ local, datasetId, ...move, server: async () => move, signal: controller.signal });
  const owner = createRemoteDatasetData({ workspaceId: "w", credentials: credentials("owner"), ...session, relayJson: authorized("owner") });
  const teammate = createRemoteDatasetData({ workspaceId: "w", shareId: "team", credentials: credentials("teammate"), ...session, relayJson: authorized("teammate") });
  const workspace = { workspaceId: "w" };
  const collection = createDatasetHandler({
    async withWorkspaceOperation(_caller: string, workspaceId, work) {
      if (workspaceId !== "w") throw Error("wrong workspace");
      return work({ workspace, signal: controller.signal, assertCurrent() {} });
    },
    hostForWorkspace: async () => local,
    dataForWorkspace: async () => createDatasetAuthorityRouter(local, { status: finished,
      async remote(origin) { expect(origin).toBe("https://relay.test"); return owner; } }),
    collectionPlace: async (_workspace, datasetId) => collectionPlace({ transfer: await finished(datasetId), relayUrl: "https://relay.test",
      automations: async () => ({ automations: 0, scheduledAutomations: 0 }), runs: async () => { throw Error("Nothing asks without automations."); } }),
    moveToServer: (_workspace, datasetId, signal) => moveCollectionToServer({ local, datasetId, ...move, signal }),
    flushSourceCapture: async () => ({ heldFiles: [], deferredWrites: [] }),
    withAdapter: async (_workspace, work) => work(adapter),
    createSources: async () => { throw Error("Nothing creates sources here."); },
  });
  const address = { workspaceId: "w", datasetPath: "items/dataset.json", expectedDatasetId: id(1) };
  const invoke = (operationId: string, idempotencyKey: string, input = {}) => ({ datasetId: id(1), ...pinned, operationId, idempotencyKey, input });
  const ownerInvoke = (operationId: string, idempotencyKey: string, input = {}) =>
    collection("window", { ...address, action: "invoke", ...pinned, operationId, idempotencyKey, input });
  await ownerInvoke(id(6), "owner-before", { name: "Owner" });
  const setGrant = { ...address, action: "setGrant", grantId: "team-grant", grant: { ...pinned, operationIds: [id(6)], discover: true } };
  return { collection, teammate, address, invoke, ownerInvoke, setGrant, restart, controller, transferStatus: (datasetId: string) => local.transferStatus(datasetId) };
}

it("gives a teammate access to a Collection on this computer by moving it to the server, once the owner agrees", async () => {
  const { collection, teammate, address, invoke, ownerInvoke, setGrant, controller, transferStatus } = await collectionOnThisComputer();

  // Without the owner's agreement nothing moves, and the refusal says what moving means.
  expect(await collection("window", { ...address, action: "permissions" })).toMatchObject({ kind: "permissions",
    place: { kind: "here", server: { host: "relay.test", runs: null, automations: 0, scheduledAutomations: 0 } } });
  await expect(collection("window", setGrant)).rejects.toThrow("Giving a person access moves this Collection to relay.test.");
  expect(transferStatus(id(1))).toBeNull();
  await expect(teammate.invoke(invoke(id(6), "teammate-before", { name: "Too early" }))).rejects.toThrow();

  // Agreeing moves the Collection with its records, then gives the teammate exactly the chosen action.
  await expect(collection("window", { ...setGrant, moveToServer: true })).resolves.toEqual({ kind: "grant-updated" });
  expect(transferStatus(id(1))?.state).toBe("imported");
  expect(await collection("window", { ...address, action: "permissions" })).toMatchObject({ kind: "permissions",
    permissions: [{ kind: "data", current: true, metadata: { operationIds: [id(6)] } }], place: { kind: "server", host: "relay.test" } });
  await expect(teammate.invoke(invoke(id(6), "teammate-add", { name: "Teammate" }))).resolves.toMatchObject({ result: { name: "Teammate" } });
  await expect(teammate.invoke(invoke(id(5), "teammate-list"))).rejects.toThrow();
  expect(await ownerInvoke(id(5), "owner-list")).toMatchObject({ result: [{ name: "Owner" }, { name: "Teammate" }] });

  // Once the Collection is on the server, the owner changes access with no further agreement.
  await expect(collection("window", { ...setGrant, grant: { ...setGrant.grant, operationIds: [id(5), id(6)] } })).resolves.toEqual({ kind: "grant-updated" });
  await expect(teammate.invoke(invoke(id(5), "teammate-list-allowed"))).resolves.toMatchObject({ result: [{ name: "Owner" }, { name: "Teammate" }] });
  controller.abort();
});

// The first chunk of an upload, then a broken connection.
function firstChunkOnly(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let sent = false;
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    if (sent) { await reader.cancel(); controller.error(Error("The connection broke.")); return; }
    sent = true;
    const item = await reader.read();
    if (item.done) controller.close(); else controller.enqueue(item.value);
  } });
}

it.each([
  ["while its upload is under way", (init: RequestInit, send: (init: RequestInit) => Promise<unknown>) =>
    send({ ...init, body: firstChunkOnly(init.body as ReadableStream<Uint8Array>) })],
  ["after the server kept it, before its answer arrived", (init: RequestInit, send: (init: RequestInit) => Promise<unknown>) => send(init)],
])("finishes a move that stopped %s on the next read after a restart", async (_when, upload) => {
  // The server stops answering during the move's upload, and answers again after this computer restarts.
  let down = false, uploads = 0;
  const { collection, teammate, address, invoke, ownerInvoke, setGrant, restart, controller, transferStatus } = await collectionOnThisComputer({
    async relay(path, init, send) {
      if (down) throw Error("The server stopped answering.");
      if (init.method !== "POST" || !path.includes("/imports/") || uploads++) return send(init);
      down = true;
      await upload(init, send).catch(() => undefined);
      throw Error("The server stopped answering.");
    } });
  await expect(collection("window", { ...setGrant, moveToServer: true })).rejects.toThrow("The server stopped answering.");
  expect(transferStatus(id(1))?.state).toBe("ready");

  // After a restart, a read tries to finish the move. While the server is still away it fails, and the Collection stays fenced.
  await restart();
  await expect(collection("window", { ...address, action: "permissions" })).rejects.toThrow("The server stopped answering.");
  await expect(ownerInvoke(id(6), "owner-while-moving", { name: "Too late" })).rejects.toThrow("The server stopped answering.");
  expect(transferStatus(id(1))?.state).toBe("ready");

  // Once the server answers, the next read finishes the move with the owner's record, and access saves with no new agreement.
  down = false;
  expect(await collection("window", { ...address, action: "permissions" })).toMatchObject({ kind: "permissions", place: { kind: "server", host: "relay.test" } });
  expect(transferStatus(id(1))?.state).toBe("imported");
  expect(await ownerInvoke(id(5), "owner-list")).toMatchObject({ result: [{ name: "Owner" }] });
  await expect(collection("window", setGrant)).resolves.toEqual({ kind: "grant-updated" });
  await expect(teammate.invoke(invoke(id(6), "teammate-add", { name: "Teammate" }))).resolves.toMatchObject({ result: { name: "Teammate" } });
  expect(await ownerInvoke(id(5), "owner-list-after")).toMatchObject({ result: [{ name: "Owner" }, { name: "Teammate" }] });
  controller.abort();
});

it("leaves a stopped move alone until a person tries it again, so the reads a change sets off don't retry it while the server is away", async () => {
  // The Collection's page reads it again each time the automation runner hears its Collections changed.
  let down = false, uploads = 0, refusals = 0, readAgain = () => {};
  const reads: Promise<unknown>[] = [];
  const { collection, address, setGrant, controller, transferStatus } = await collectionOnThisComputer({
    changed: () => readAgain(),
    async relay(path, init, send) {
      if (down) { refusals++; throw Error("The server stopped answering."); }
      if (init.method !== "POST" || !path.includes("/imports/") || uploads++) return send(init);
      down = true;
      throw Error("The server stopped answering.");
    } });
  readAgain = () => { reads.push(collection("window", { ...address, action: "describe" }).catch(() => undefined)); };
  await expect(collection("window", { ...setGrant, moveToServer: true })).rejects.toThrow("The server stopped answering.");
  expect(transferStatus(id(1))?.state).toBe("ready");

  // The move's own check of its upload is the one refusal so far. Every read the move set off settles without trying it again.
  for (let round = 0; round < 5 && reads.length > 0; round++) await Promise.all(reads.splice(0));
  const pending = reads.length, afterStop = refusals;
  readAgain = () => {};
  await Promise.all(reads.splice(0));
  expect({ pending, afterStop }).toEqual({ pending: 0, afterStop: 1 });

  // A person's Try again tries the move once, and its stop sets off nothing either.
  await expect(collection("window", { ...setGrant, moveToServer: true })).rejects.toThrow("The server stopped answering.");
  expect(refusals).toBe(2);
  down = false;
  await expect(collection("window", { ...setGrant, moveToServer: true })).resolves.toEqual({ kind: "grant-updated" });
  expect(transferStatus(id(1))?.state).toBe("imported");
  controller.abort();
});
