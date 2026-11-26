import { createHash } from "node:crypto";
import { LinksConnectionsResult, SHARE_OMITTED_CONNECTIONS } from "@dohc/workspace-contracts/links";
import { expect, it, vi } from "vitest";
import type { RegistryEntry } from "./registryStore";
import {
  createWorkspaceGraphConnections,
  fitConnections,
  type GraphApproval,
} from "./workspaceGraphConnections";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset = (n: number, folder: string, name: string) =>
  JSON.stringify({
    formatVersion: 1,
    datasetId: uuid(n),
    name,
    schemaPath: `${folder}/schema.sql`,
    operationsPath: `${folder}/operations.js`,
    tables: [
      {
        tableId: uuid(n + 1),
        name: "Rows",
        sqlName: "rows",
        primaryKey: "id",
        fields: [
          {
            fieldId: uuid(n + 2),
            name: "Record ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: uuid(n + 3),
        name: "list",
        label: "List",
        tableId: uuid(n + 1),
        kind: "read",
        access: "helper",
        readOnly: true,
        fieldIds: [uuid(n + 2)],
      },
    ],
  });
const AUTOMATIONS = `version: 1
automations:
  - id: from-chat
    name: Tasks from chat
    when:
      group-message: Trip
    do:
      - add-record:
          Name: '=message.text'
        collection: Ledger
      - post: Added
        group: Trip
      - run-file: scripts/sum.js
`;

function workspace(files: Record<string, string>, overrides: Partial<RegistryEntry> = {}) {
  const listing = () =>
    Object.entries(files).map(([path, text]) => ({
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
    }));
  const adapter = {
    getActiveVersion: vi.fn(async () => ({ id: "main" })),
    listTextFileMetadata: vi.fn(async () => listing()),
    readTextFile: vi.fn(async ({ path }: { path: string }) =>
      files[path] === undefined ? null : { text: files[path] },
    ),
    listCollections: vi.fn(async () => ({
      collections: [
        { path: "Tasks", objectId: "tasks-yaml", status: "valid", reasons: [] },
        { path: "People", objectId: "people-yaml", status: "valid", reasons: [] },
      ],
    })),
    getCollection: vi.fn(async ({ collectionPath }: { collectionPath: string }) => ({
      path: collectionPath,
      schema: {
        name: collectionPath === "Tasks" ? "Task list" : null,
        fields:
          collectionPath === "Tasks"
            ? [{ name: "Owner", type: "relation", collection: "People", many: false }]
            : [],
      },
      recordCount: collectionPath === "Tasks" ? 1 : 0,
    })),
    queryCollectionRecords: vi.fn(async ({ collectionPath }: { collectionPath: string }) => ({
      records: collectionPath === "Tasks" ? [{ path: "Tasks/one.md" }] : [],
      nextCursor: null,
    })),
  };
  const approvals: GraphApproval[] = [
    { appRoot: "apps/board", kind: "collection", resourceId: "Tasks" },
  ];
  const deps = {
    withAdapter: async <T>(_workspace: RegistryEntry, run: (value: never) => Promise<T>) =>
      run(adapter as never),
    apps: vi.fn(async () => [
      {
        root: "apps/board",
        title: "Board",
        entryPath: "apps/board/index.html",
        sourceFiles: ["apps/board/index.html"],
      },
    ]),
    approvals: vi.fn(async () => approvals),
    groups: vi.fn(async () => [{ id: "ch-1", kind: "channel", name: "Trip", slug: "trip" }]),
  };
  const entry = { workspaceId: "ws", rootPath: "root", ...overrides } as RegistryEntry;
  return { adapter, deps, approvals, entry, reader: createWorkspaceGraphConnections(deps) };
}

const FILES = {
  "Tasks/collection.yaml": "name: Task list",
  "Tasks/one.md": "# One",
  "Tasks/README.md": "# Not a record",
  "Tasks/automations.yaml": AUTOMATIONS,
  "Tasks/scripts/sum.js": "return 1",
  "People/collection.yaml": "",
  "Ledger/dataset.json": dataset(10, "Ledger", "Ledger"),
  "apps/board/index.html": "<p></p>",
  "apps/board/app.publish.json": JSON.stringify({
    version: 1,
    entryPath: "index.html",
    dataset: { kind: "dataset", datasetPath: "Ledger/dataset.json", operations: ["list"] },
  }),
};

it("connects Collections, Datasets, apps, automations, and Groups from workspace files", async () => {
  const { reader, entry } = workspace(FILES);
  const result = LinksConnectionsResult.parse(await reader.connections(entry));
  expect(result.scope).toBe("workspace");
  expect(result.complete).toBe(true);
  expect(result.nodes.map((node) => node.id)).toEqual([
    "app:apps/board",
    "automation:collection:tasks-yaml#from-chat",
    "collection:People",
    "collection:Tasks",
    "dataset:Ledger/dataset.json",
    "group:ch-1",
  ]);
  expect(result.nodes.find((node) => node.id === "dataset:Ledger/dataset.json")).toMatchObject({
    datasetId: uuid(10),
    firstTableId: uuid(11),
    tableCount: 1,
    title: "Ledger",
  });
  expect(result.edges).toEqual([
    {
      source: "app:apps/board",
      target: "collection:Tasks",
      kind: "app-uses-data",
      approval: "approved",
    },
    {
      source: "app:apps/board",
      target: "dataset:Ledger/dataset.json",
      kind: "app-uses-data",
      approval: "requested",
    },
    {
      source: "automation:collection:tasks-yaml#from-chat",
      target: "Tasks/scripts/sum.js",
      kind: "automation-runs-file",
    },
    {
      source: "automation:collection:tasks-yaml#from-chat",
      target: "dataset:Ledger/dataset.json",
      kind: "automation-action",
    },
    {
      source: "automation:collection:tasks-yaml#from-chat",
      target: "group:ch-1",
      kind: "automation-action",
    },
    {
      source: "collection:Tasks",
      target: "automation:collection:tasks-yaml#from-chat",
      kind: "automation-trigger",
    },
    { source: "collection:Tasks", target: "collection:People", kind: "relation" },
    {
      source: "group:ch-1",
      target: "automation:collection:tasks-yaml#from-chat",
      kind: "automation-trigger",
    },
  ]);
  expect(result.records).toEqual([{ collection: "collection:Tasks", paths: ["Tasks/one.md"] }]);
});

it("marks access the manifest requests but this computer has not approved", async () => {
  const { reader, entry, approvals } = workspace(FILES);
  approvals.splice(0);
  const result = await reader.connections(entry);
  expect(result.edges.filter((edge) => edge.kind === "app-uses-data")).toEqual([
    {
      source: "app:apps/board",
      target: "dataset:Ledger/dataset.json",
      kind: "app-uses-data",
      approval: "requested",
    },
  ]);
});

it("keeps one malformed manifest from failing the graph", async () => {
  const { reader, entry } = workspace({ ...FILES, "apps/board/app.publish.json": "{" });
  const result = await reader.connections(entry);
  expect(result.nodes.some((node) => node.id === "app:apps/board")).toBe(true);
  expect(result.edges.filter((edge) => edge.approval === "requested")).toEqual([]);
});

it("lists nothing for a received share and never reads its engine", async () => {
  const { reader, entry, adapter, deps } = workspace(FILES, {
    shareView: { shareId: "s" } as RegistryEntry["shareView"],
  });
  expect(await reader.connections(entry)).toEqual(SHARE_OMITTED_CONNECTIONS);
  expect(adapter.listTextFileMetadata).not.toHaveBeenCalled();
  expect(deps.apps).not.toHaveBeenCalled();
  expect(deps.approvals).not.toHaveBeenCalled();
  expect(deps.groups).not.toHaveBeenCalled();
});

it("reuses the answer until a structural file or an approval changes", async () => {
  const files: Record<string, string> = { ...FILES };
  const { reader, entry, adapter, approvals } = workspace(files);
  await reader.connections(entry);
  files["Tasks/one.md"] = "# Edited";
  await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(1);
  files["Tasks/automations.yaml"] = AUTOMATIONS.replace("Tasks from chat", "Chat tasks");
  const renamed = await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(2);
  expect(renamed.nodes.find((node) => node.kind === "automation")?.title).toBe("Chat tasks");
  approvals.splice(0);
  await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(3);
});

it("cuts an answer over 64 KiB to whole nodes and reports it incomplete", () => {
  const nodes = Array.from({ length: 2000 }, (_, index) => ({
    id: `app:apps/${String(index).padStart(4, "0")}`,
    kind: "app" as const,
    path: `apps/${index}`,
    title: "x".repeat(40),
    entryPath: null,
  }));
  const fitted = fitConnections({ ...SHARE_OMITTED_CONNECTIONS, scope: "workspace", nodes });
  expect(fitted.complete).toBe(false);
  expect(fitted.nodes.length).toBeGreaterThan(0);
  expect(fitted.nodes).toEqual(nodes.slice(0, fitted.nodes.length));
  expect(() => LinksConnectionsResult.parse(fitted)).not.toThrow();
});
