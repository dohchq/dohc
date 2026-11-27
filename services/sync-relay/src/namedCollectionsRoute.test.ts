import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { createRelayDatasetHost } from "./datasetHost";
import { fixture as baseFixture, limits, owner, pushFile } from "./datasetTestFixture";
import { errorResponse } from "./errors";
import { createNamedCollectionsRoute, NAMED_COLLECTIONS_PATH } from "./namedCollectionsRoute";
import { createPhoneCollections } from "./phoneCollections";
import { insertShareGrant } from "./storage/shares";
import type { StorageContext } from "./storage/context";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DATASET = id(1),
  TABLE = id(2),
  KEY = id(3),
  ITEM = id(4),
  AMOUNT = id(5),
  LIST = id(6),
  CREATE = id(7),
  EDIT = id(8),
  REMOVE = id(9);
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: DATASET,
  name: "Trip budget",
  schemaPath: "trip/schema.sql",
  operationsPath: "trip/operations.js",
  tables: [
    {
      tableId: TABLE,
      name: "Trip budget",
      sqlName: "records",
      primaryKey: "id",
      fields: [
        {
          fieldId: KEY,
          name: "Record ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: ITEM,
          name: "Item",
          sqlColumn: "item",
          type: "text",
          required: false,
          unique: false,
        },
        {
          fieldId: AMOUNT,
          name: "Amount",
          sqlColumn: "amount",
          type: "number",
          required: false,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: LIST,
      name: "records.list",
      label: "View records",
      tableId: TABLE,
      kind: "read",
      access: "helper",
      readOnly: true,
      fieldIds: [KEY, ITEM, AMOUNT],
    },
    {
      operationId: CREATE,
      name: "records.create",
      label: "Create record",
      tableId: TABLE,
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [ITEM, AMOUNT],
    },
    {
      operationId: EDIT,
      name: "records.edit",
      label: "Edit record",
      tableId: TABLE,
      kind: "edit",
      access: "helper",
      readOnly: false,
      fieldIds: [ITEM, AMOUNT],
    },
    {
      operationId: REMOVE,
      name: "records.delete",
      label: "Delete record",
      tableId: TABLE,
      kind: "delete",
      access: "owner",
      readOnly: false,
      fieldIds: [],
    },
  ],
};
const schemaSql = `CREATE TABLE records(id TEXT PRIMARY KEY NOT NULL,item TEXT,amount REAL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
const operationSource = generateDatasetOperations(definition);
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const scope = { workspaceId: "w", datasetId: DATASET };
const VIEWER = "https://viewer.test";
const EXCHANGE = "named-collections-exchange-key";

const revoked = new Set<string>();
const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^session=([\w-]+):([\w-]+):(browser|phone|desktop)$/u.exec(
    request.headers.get("cookie") ?? "",
  );
  if (!match || revoked.has(match[2]!)) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: match[3] as "browser" | "phone" | "desktop",
  };
};

function grant(storage: StorageContext, grantId: string, userId: string) {
  storage.createShare({
    share: {
      shareId: `share-${grantId}`,
      workspaceId: "w",
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["trip"], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId,
      shareId: `share-${grantId}`,
      principalKind: "user",
      principalUserId: userId,
      principalEmail: null,
      access: "edit",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
}

async function trip() {
  revoked.clear();
  const base = baseFixture(),
    directory = await mkdtemp(join(tmpdir(), "named-collections-"));
  const host = await createRelayDatasetHost({
    publicEditRelease: undefined,
    storage: base.storage,
    directory,
    limits,
    onShutdownError: (error) => {
      throw error;
    },
  });
  cleanups.push(async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  await host.activate(owner, {
    ...scope,
    revision,
    schemaSql,
    operationSource,
    capacityBytes: 1 << 20,
  });
  pushFile(base.storage, "dataset", null, {
    path: "trip/dataset.json",
    text: JSON.stringify({ datasetId: DATASET }),
  });
  const stamp = { ...scope, revision: 1, revisionSha256: revision.revisionSha256 };
  for (const [key, item, amount] of [
    ["flights", "Flights", 2560],
    ["hotel", "Hotel", 960],
  ] as const)
    await host.invoke(owner, {
      ...stamp,
      operationId: CREATE,
      input: { values: { [ITEM]: item, [AMOUNT]: amount } },
      idempotencyKey: key,
    });
  const storage = base.storage;
  initializeAccountDeletion(storage, "k".repeat(32));
  grant(storage, "ben-grant", "ben");
  host.setDataGrant(owner, {
    ...scope,
    grantId: "ben-grant",
    grant: {
      operationIds: [LIST, EDIT],
      discover: true,
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  const route = createNamedCollectionsRoute({
    storage,
    collections: createPhoneCollections({ storage, host }),
    resolveAccountSession,
    publicOrigin: VIEWER,
    hasExchangeKey: (request) => request.headers.get("x-dohc-relay-exchange-key") === EXCHANGE,
    limiter: new TokenBucketLimiter(1_000, 1_000, 4_096),
    nowMs: () => 2_000,
  });
  async function call(
    operation: string,
    args: unknown,
    options: {
      as?: string;
      grantId?: string;
      headers?: Record<string, string | null>;
      body?: unknown;
    } = {},
  ) {
    const headers = new Headers({
      cookie: `session=${options.as ?? "ben:s1:browser"}`,
      origin: VIEWER,
      "x-dohc-relay-exchange-key": EXCHANGE,
      "content-type": "application/json",
    });
    for (const [name, value] of Object.entries(options.headers ?? {}))
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    const response = await route(
      new Request(`http://relay.test${NAMED_COLLECTIONS_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          options.body ?? { grantId: options.grantId ?? "ben-grant", operation, args },
        ),
      }),
    ).catch((error: unknown) => errorResponse(error));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const rows = async () =>
    (
      (await call("collectionRecords", { datasetId: DATASET, tableId: TABLE })).body.result as {
        rows: { id: string; version: number; values: Record<string, unknown> }[];
      }
    ).rows;
  return { storage, host, call, rows, stamp };
}

const notFound = { status: 404, body: expect.objectContaining({ ok: false, code: "not_found" }) };

it("lets a person invited by name read the table and change one field, and nothing else", async () => {
  const f = await trip();
  expect((await f.call("collections", {})).body).toEqual({
    ok: true,
    result: { collections: [{ datasetId: DATASET, name: "Trip budget" }], nextCursor: null },
  });
  const described = (await f.call("collection", { datasetId: DATASET })).body.result as {
    tables: { fields: { name: string; editable: boolean }[] }[];
  };
  expect(described.tables[0]!.fields.map(({ name, editable }) => [name, editable])).toEqual([
    ["Item", true],
    ["Amount", true],
  ]);
  const before = await f.rows();
  const hotel = before.find((row) => row.values[ITEM] === "Hotel")!;
  const edit = (value: unknown, expectedVersion: number, idempotencyKey: string) =>
    f.call("collectionEdit", {
      datasetId: DATASET,
      tableId: TABLE,
      recordId: hotel.id,
      fieldId: AMOUNT,
      value,
      expectedVersion,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      idempotencyKey,
    });
  expect(await edit(1010, hotel.version, id(100))).toEqual({
    status: 200,
    body: { ok: true, result: { saved: { version: hotel.version + 1, priorValue: 960 } } },
  });
  expect((await edit(1010, hotel.version, id(100))).body).toEqual({
    ok: true,
    result: { saved: { version: hotel.version + 1, priorValue: 960 } },
  });
  const owners = await f.host.invoke(owner, {
    ...f.stamp,
    operationId: LIST,
    input: {},
    idempotencyKey: id(101),
  });
  expect(
    (owners.result as { rows: { id: string; values: Record<string, unknown> }[] }).rows.find(
      (row) => row.id === hotel.id,
    )?.values[AMOUNT],
  ).toBe(1010);
  expect((await edit(5, hotel.version, id(102))).body).toEqual({
    ok: true,
    result: { refused: { code: "stale_record", message: expect.any(String) } },
  });
  expect((await f.rows()).find((row) => row.id === hotel.id)?.values[AMOUNT]).toBe(1010);
  const one = await f.call("collectionRecords", {
    datasetId: DATASET,
    tableId: TABLE,
    recordId: hotel.id,
  });
  expect((one.body.result as { rows: unknown[] }).rows).toEqual([
    {
      id: hotel.id,
      version: hotel.version + 1,
      values: { [KEY]: hotel.id, [ITEM]: "Hotel", [AMOUNT]: 1010 },
    },
  ]);
  for (const operation of ["collectionCreate", "collectionDelete", "invoke", "changes"])
    expect(
      await f.call(operation, { datasetId: DATASET, tableId: TABLE }),
      operation,
    ).toMatchObject(notFound);
});

it("answers only share-web's browser sign-in for the person's own invitation by name", async () => {
  const f = await trip();
  grant(f.storage, "cara-grant", "cara");
  const joined = {
    shareId: "s",
    principalEmail: null,
    access: "view",
    generation: 1,
    status: "active",
  } as const;
  f.storage.tx(() => {
    insertShareGrant(f.storage, {
      ...joined,
      grantId: "trip-link",
      principalKind: "link",
      principalUserId: null,
      createdAtMs: 2,
      revokedAtMs: null,
      parentGrantId: null,
    });
    insertShareGrant(f.storage, {
      ...joined,
      grantId: "ben-link",
      principalKind: "user",
      principalUserId: "ben",
      createdAtMs: 3,
      revokedAtMs: null,
      parentGrantId: "trip-link",
    });
  });
  const refused: Array<[string, Parameters<typeof f.call>[2]]> = [
    ["no exchange key", { headers: { "x-dohc-relay-exchange-key": null } }],
    ["wrong exchange key", { headers: { "x-dohc-relay-exchange-key": "other" } }],
    ["another origin", { headers: { origin: "https://elsewhere.test" } }],
    ["a bearer as well", { headers: { authorization: "Bearer session" } }],
    ["no cookie", { headers: { cookie: null } }],
    ["a phone sign-in", { as: "ben:s1:phone" }],
    ["a desktop sign-in", { as: "ben:s1:desktop" }],
    ["someone else's invitation", { as: "cara:s2:browser" }],
    ["a redeemed link's grant", { grantId: "ben-link" }],
    ["an unknown grant", { grantId: "nobody" }],
    [
      "extra fields",
      { body: { grantId: "ben-grant", operation: "collections", args: {}, as: "x" } },
    ],
  ];
  for (const [reason, options] of refused)
    expect(await f.call("collections", {}, options), reason).toMatchObject(notFound);
  expect(
    (await f.call("collections", {}, { as: "cara:s2:browser", grantId: "cara-grant" })).body,
  ).toEqual({ ok: true, result: { collections: [], nextCursor: null } });
  expect(
    await f.call(
      "collection",
      { datasetId: DATASET },
      { as: "cara:s2:browser", grantId: "cara-grant" },
    ),
  ).toMatchObject(notFound);
  expect((await f.call("collections", {})).status).toBe(200);
  revoked.add("s1");
  expect(await f.call("collections", {})).toMatchObject(notFound);
  revoked.clear();
  fenceAccount(f.storage, "k".repeat(32), "ben", "ben@dohc.test");
  expect(await f.call("collections", {})).toMatchObject(notFound);
});

it("stops answering once the owner removes the invitation or its Collection access", async () => {
  const f = await trip();
  expect((await f.rows()).length).toBe(2);
  f.host.setDataGrant(owner, { ...scope, grantId: "ben-grant", grant: null });
  expect(await f.call("collectionRecords", { datasetId: DATASET, tableId: TABLE })).toMatchObject(
    notFound,
  );
  f.storage.tx(() =>
    f.storage.db
      .prepare(
        "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=10 WHERE grant_id='ben-grant'",
      )
      .run(),
  );
  expect(await f.call("collections", {})).toMatchObject(notFound);
});
