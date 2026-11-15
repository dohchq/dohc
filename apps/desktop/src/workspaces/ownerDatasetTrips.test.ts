import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture, limits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { readDatasetResponse } from "../ipc/readDatasetResponse";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import { createRemoteDatasetData, type OwnerDatasetData } from "./remoteDataset";
import { createRemoteDatasetReplicaSource } from "./remoteDatasetReplica";

// The requests one change costs between a syncing owner's computer and the
// server that holds the Collection, through the real routes over a socket.
// DOHC_TRIP_TIMES=<round trip ms> also prints how long each takes over a
// network with that round trip.
const roundTripMs = Number(process.env.DOHC_TRIP_TIMES ?? 0);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: id(1),
  name: "Entries",
  schemaPath: "schema.sql",
  operationsPath: "actions.js",
  tables: [
    {
      tableId: id(2),
      name: "Entries",
      sqlName: "entries",
      primaryKey: "id",
      fields: [
        {
          fieldId: id(3),
          name: "ID",
          sqlColumn: "id",
          type: "number",
          required: true,
          unique: true,
        },
        {
          fieldId: id(4),
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: id(5),
      name: "add",
      label: "Add",
      kind: "create",
      tableId: id(2),
      access: "owner",
      readOnly: false,
      fieldIds: [id(4)],
    },
    {
      operationId: id(6),
      name: "read",
      label: "Read",
      kind: "read",
      tableId: id(2),
      access: "owner",
      readOnly: true,
      fieldIds: [id(4)],
    },
    {
      operationId: id(7),
      name: "rename",
      label: "Rename",
      kind: "edit",
      tableId: id(2),
      access: "owner",
      readOnly: false,
      fieldIds: [id(4)],
    },
  ],
};
const schemaSql = "CREATE TABLE entries(id INTEGER PRIMARY KEY,name TEXT NOT NULL);";
const operationSource =
  "globalThis.operations={add(ctx,input){ctx.db.execute('INSERT INTO entries(name) VALUES(?)',[input.name]);return null;},read(ctx){return ctx.db.query('SELECT * FROM entries ORDER BY id');},rename(ctx,input){ctx.db.execute('UPDATE entries SET name=? WHERE id=?',[input.name,input.id]);return null;}};";
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const pinned = { datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256 };

async function ownerOverSocket(latencyMs = 0) {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "desktop-owner-trips-"));
  const host = await f.storage.createDatasetHost({
    publicEditRelease: undefined,
    directory: join(directory, "host"),
    limits,
    onShutdownError(error) {
      throw error;
    },
  });
  const handler = createSyncRelayHandler({
    storage: f.storage,
    datasetHost: host,
    appPublicationLimits: limits,
    linkKey: "owner-trips-test-key",
    nowMs: () => Date.now(),
    // Only the owner calls in this test.
    resolveActor: (_request, workspaceId) => ({ workspaceId, userId: "owner" }),
  });
  const server = serveFetchHandler({
    handler,
    maxBodyBytes: () => 4 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const trips: string[] = [];
  const send = async (path: string, init: RequestInit) => {
    trips.push(`${init.method ?? "GET"} ${path.replace(/^\/sync\/w\/datasets\/[^/]+/, "")}`);
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer owner");
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return fetch(`${origin}${path}`, { ...init, headers });
  };
  const credentials = {
    serverUrl: origin,
    relayUrl: origin,
    email: "owner@example.test",
    userId: "owner",
    token: "owner",
  };
  const signal = new AbortController().signal;
  const remote = createRemoteDatasetData({
    workspaceId: "w",
    credentials,
    credentialGeneration: 1,
    signal,
    currentCredentialGeneration: () => 1,
    assertCurrent() {},
    async relayJson(_credentials, path, init) {
      const response = await send(path, init);
      const action = /\/datasets\/[^/]+\/([a-z-]+)/.exec(path)?.[1] ?? "describe";
      const value = await readDatasetResponse(response, action, signal);
      if (!response.ok) throw Error(`The server refused ${action}: ${JSON.stringify(value)}`);
      return value;
    },
  }) as OwnerDatasetData;
  const copyDirectory = join(directory, "copy");
  await mkdir(copyDirectory);
  const copy = await createOwnerDatasetCopy({
    directory: copyDirectory,
    scope: { workspaceId: "w", datasetId: id(1) },
    ownerKey: "owner",
    origin,
    assertOwner() {},
  });
  const source = createRemoteDatasetReplicaSource({
    workspaceId: "w",
    datasetId: id(1),
    origin,
    credentials,
    credentialGeneration: 1,
    currentCredentialGeneration: () => 1,
    signal,
    assertCurrent() {},
    relayResponse: (_credentials, path, init) => send(path, init),
    onAccessLost() {},
  });
  cleanups.push(async () => {
    await copy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  await host.activate(
    { kind: "named", workspaceId: "w", userId: "owner" },
    { workspaceId: "w", revision, schemaSql, operationSource },
  );
  const data = copy.data(remote, source, signal);
  let key = 0;
  return {
    trips,
    write: (operationId: string, input: Record<string, unknown>) =>
      data.invoke({ ...pinned, operationId, input, idempotencyKey: `change-${++key}` } as never),
    read: () =>
      data.invoke({ ...pinned, operationId: id(6), input: {}, idempotencyKey: "read" } as never),
  };
}

async function measure(run: () => Promise<unknown>, trips: string[], times = 20) {
  const requests = new Set<string>(),
    durations: number[] = [];
  for (let index = 0; index < times; index++) {
    const before = trips.length,
      started = performance.now();
    await run();
    durations.push(performance.now() - started);
    requests.add(JSON.stringify(trips.slice(before)));
  }
  durations.sort((a, b) => a - b);
  return {
    requests: [...requests].map((value) => JSON.parse(value) as string[]),
    medianMs: Math.round(durations[Math.floor(durations.length / 2)]! * 10) / 10,
  };
}

async function edits(latencyMs = 0) {
  const owner = await ownerOverSocket(latencyMs);
  await owner.write(id(5), { name: "First" });
  await owner.read();
  let name = 0;
  // A record edit in a table: the change, then the table's read that shows it.
  const edit = await measure(async () => {
    await owner.write(id(7), { id: 1, name: `Name ${++name}` });
    expect(await owner.read()).toMatchObject({
      result: [{ id: 1, name: `Name ${name}` }],
      copy: { offline: false },
    });
  }, owner.trips);
  // An app operation: one change, with no read after it.
  const operation = await measure(() => owner.write(id(5), { name: "Added" }), owner.trips);
  return { edit, operation };
}

it("sends one request for a change on a syncing owner's computer, and the table shows it", async () => {
  const { edit, operation } = await edits();
  expect(edit.requests).toEqual([["POST /invoke"]]);
  expect(operation.requests).toEqual([["POST /invoke"]]);
}, 120_000);

it.runIf(roundTripMs > 0)(
  "prints how long a change takes",
  async () => {
    console.log(JSON.stringify({ roundTripMs, ...(await edits(roundTripMs)) }));
  },
  300_000,
);
