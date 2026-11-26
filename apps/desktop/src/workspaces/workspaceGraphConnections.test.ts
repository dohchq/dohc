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
  - id: copy
    name: Copy task
    when: record-added
    do:
      - add-record:
          Name: '=record.Name'
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
    { appRoot: "apps/board", targets: ["collection:Tasks"], manifestSha256: null },
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
    "automation:collection:tasks-yaml#copy",
    "automation:collection:tasks-yaml#from-chat",
    "collection:People",
    "collection:Tasks",
    "dataset:Ledger/dataset.json",
    "group:ch-1",
  ]);
  expect(result.nodes.find((node) => node.id === "dataset:Ledger/dataset.json")).toMatchObject({
    datasetId: uuid(10),
    firstTableId: uuid(11),
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
      source: "automation:collection:tasks-yaml#copy",
      target: "collection:Tasks",
      kind: "automation-action",
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
      target: "automation:collection:tasks-yaml#copy",
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

it("shows every Dataset an app was approved for, until its manifest changes", async () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const files: Record<string, string> = {
    ...FILES,
    "Trips/dataset.json": dataset(20, "Trips", "Trips"),
  };
  const { reader, entry, approvals } = workspace(files);
  approvals.splice(0, 1, {
    appRoot: "apps/board",
    targets: [`dataset-id:${uuid(10)}`, `dataset-id:${uuid(20)}`],
    manifestSha256: sha(files["apps/board/app.publish.json"]!),
  });
  const appEdges = async () =>
    (await reader.connections(entry)).edges
      .filter((edge) => edge.kind === "app-uses-data")
      .map((edge) => [edge.target, edge.approval]);
  expect(await appEdges()).toEqual([
    ["dataset:Ledger/dataset.json", "approved"],
    ["dataset:Trips/dataset.json", "approved"],
  ]);
  files["apps/board/app.publish.json"] = files["apps/board/app.publish.json"]!.replace(
    '["list"]',
    '["list","submit"]',
  );
  expect(await appEdges()).toEqual([
    ["dataset:Ledger/dataset.json", "requested"],
    ["dataset:Trips/dataset.json", "approved"],
  ]);
});

it("marks a manifest's Dataset requested when another Dataset took the approved one's place", async () => {
  const files: Record<string, string> = {
    ...FILES,
    "Ledger/dataset.json": dataset(30, "Ledger", "New ledger"),
    "Moved/dataset.json": dataset(10, "Moved", "Ledger"),
  };
  const { reader, entry, approvals } = workspace(files);
  approvals.splice(0, 1, {
    appRoot: "apps/board",
    targets: [`dataset-id:${uuid(10)}`],
    manifestSha256: createHash("sha256")
      .update(files["apps/board/app.publish.json"]!)
      .digest("hex"),
  });
  const result = await reader.connections(entry);
  expect(
    result.edges
      .filter((edge) => edge.kind === "app-uses-data")
      .map((edge) => [edge.target, edge.approval]),
  ).toEqual([
    ["dataset:Ledger/dataset.json", "requested"],
    ["dataset:Moved/dataset.json", "approved"],
  ]);
});

it("cuts a long title so the answer stays valid", async () => {
  const { reader, entry, adapter } = workspace(FILES);
  adapter.getCollection.mockResolvedValue({
    path: "Tasks",
    schema: { name: "T".repeat(5000), fields: [] },
    recordCount: 0,
  } as never);
  const result = LinksConnectionsResult.parse(await reader.connections(entry));
  expect(result.nodes.find((node) => node.id === "collection:Tasks")?.title).toHaveLength(200);
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

it("reuses the answer until a structural file, a record, or an approval changes", async () => {
  const files: Record<string, string> = { ...FILES };
  const { reader, entry, adapter, approvals } = workspace(files);
  await reader.connections(entry);
  files["apps/board/index.html"] = "<p>Edited</p>";
  await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(1);
  files["Tasks/automations.yaml"] = AUTOMATIONS.replace("Tasks from chat", "Chat tasks");
  const renamed = await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(2);
  expect(renamed.nodes.find((node) => node.id.endsWith("#from-chat"))?.title).toBe("Chat tasks");
  files["Tasks/one.md"] = "---\nName: Fixed\n---\n";
  await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(3);
  approvals.splice(0);
  await reader.connections(entry);
  expect(adapter.listCollections).toHaveBeenCalledTimes(4);
});

it("reports mounted shares as uncovered once one is added", async () => {
  const { reader, entry } = workspace(FILES);
  expect((await reader.connections(entry)).mountsCovered).toBe(true);
  const mounted = { ...entry, shareMounts: [{}] } as unknown as RegistryEntry;
  expect((await reader.connections(mounted)).mountsCovered).toBe(false);
});

it("shows what a set step changes", async () => {
  const { reader, entry } = workspace({
    ...FILES,
    "Tasks/automations.yaml": `version: 1
automations:
  - id: close
    name: Close new tasks
    when: record-added
    do:
      - set:
          Done: true
`,
  });
  const result = await reader.connections(entry);
  expect(result.edges.filter((edge) => edge.kind === "automation-action")).toEqual([
    {
      source: "automation:collection:tasks-yaml#close",
      target: "collection:Tasks",
      kind: "automation-action",
    },
  ]);
});

it("reads a Collection again after its read failed", async () => {
  const { reader, entry, adapter } = workspace(FILES);
  adapter.getCollection.mockRejectedValueOnce(new Error("deadline"));
  const failed = await reader.connections(entry);
  expect(failed.complete).toBe(false);
  const retried = await reader.connections(entry);
  expect(retried.complete).toBe(true);
  expect(retried.edges).toContainEqual({
    source: "collection:Tasks",
    target: "collection:People",
    kind: "relation",
  });
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
