import { createHash } from "node:crypto";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { fileVersionError } from "@dohc/workspace-contracts/file-version";
import {
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  parseAppDatasetReference,
  parseDatasetDefinition,
  type DatasetDefinition,
} from "@dohc/security-contract/dataset";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { Check, EvalCase, RunRecord } from "./case";
import { createEverydayDesktop } from "./everydayDesktop";

const WS = "ws-everyday";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

// --- Seeded fixtures for everyday cases ------------------------------------

const CLIENTS_DEF: DatasetDefinition = {
  formatVersion: 1,
  datasetId: uuid("c1000000", 1),
  name: "Clients",
  schemaPath: "clients/schema.sql",
  operationsPath: "clients/operations.js",
  tables: [
    {
      tableId: uuid("c1000000", 2),
      name: "Clients",
      sqlName: "clients",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("c1000000", 3),
          name: "Record ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: uuid("c1000000", 4),
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("c1000000", 5),
          name: "Email",
          sqlColumn: "email",
          type: "text",
          required: false,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: uuid("c1000000", 6),
      name: "listClients",
      label: "List clients",
      tableId: uuid("c1000000", 2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [uuid("c1000000", 3), uuid("c1000000", 4), uuid("c1000000", 5)],
    },
    {
      operationId: uuid("c1000000", 7),
      name: "addClient",
      label: "Add client",
      tableId: uuid("c1000000", 2),
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [uuid("c1000000", 4), uuid("c1000000", 5)],
    },
  ],
};

const CLIENTS_SCHEMA = `CREATE TABLE "clients" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "_record_version" INTEGER NOT NULL DEFAULT 1
);
`;
const CLIENTS_OPS = generateDatasetOperations(CLIENTS_DEF);
const CLIENTS_REV1_SHA = sha256(
  datasetRevisionDigestContent({
    datasetId: CLIENTS_DEF.datasetId,
    revision: 1,
    revisionSha256: "0".repeat(64),
    definitionSha256: sha256(datasetDefinitionDigestContent(CLIENTS_DEF)),
    schemaSha256: sha256(CLIENTS_SCHEMA),
    operationsSha256: sha256(CLIENTS_OPS),
    definition: CLIENTS_DEF,
  }),
);

const EVENTS_DEF: DatasetDefinition = {
  formatVersion: 1,
  datasetId: uuid("e2000000", 1),
  name: "Events",
  schemaPath: "events/schema.sql",
  operationsPath: "events/operations.js",
  tables: [
    {
      tableId: uuid("e2000000", 2),
      name: "Sessions",
      sqlName: "sessions",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("e2000000", 3),
          name: "Record ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: uuid("e2000000", 4),
          name: "Title",
          sqlColumn: "title",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("e2000000", 5),
          name: "Internal Notes",
          sqlColumn: "internal_notes",
          type: "text",
          required: false,
          unique: false,
        },
      ],
    },
    {
      tableId: uuid("e2000000", 6),
      name: "Signups",
      sqlName: "signups",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("e2000000", 7),
          name: "Record ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: uuid("e2000000", 8),
          name: "Guest Name",
          sqlColumn: "guest_name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("e2000000", 9),
          name: "Session",
          sqlColumn: "session_id",
          type: "relation",
          required: true,
          unique: false,
          relation: {
            datasetId: uuid("e2000000", 1),
            tableId: uuid("e2000000", 2),
            fieldId: uuid("e2000000", 3),
            many: false,
          },
        },
      ],
    },
  ],
  operations: [
    {
      operationId: uuid("e2000000", 10),
      name: "readSessions",
      label: "Read sessions",
      tableId: uuid("e2000000", 2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [uuid("e2000000", 3), uuid("e2000000", 4), uuid("e2000000", 5)],
    },
    {
      operationId: uuid("e2000000", 11),
      name: "createSignup",
      label: "Register guest",
      tableId: uuid("e2000000", 6),
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [uuid("e2000000", 8), uuid("e2000000", 9)],
    },
  ],
};
const EVENTS_SCHEMA = `CREATE TABLE "sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "internal_notes" TEXT,
  "_record_version" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE "signups" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "guest_name" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "_record_version" INTEGER NOT NULL DEFAULT 1
);
`;
const EVENTS_OPS = generateDatasetOperations(EVENTS_DEF);

// Helper check builders
function checkDatasetJsonValid(run: RunRecord, path: string): Check {
  const raw = run.files[path];
  if (!raw)
    return {
      name: `${path} exists and is a valid dataset definition`,
      pass: false,
      detail: "missing",
    };
  try {
    parseDatasetDefinition(JSON.parse(raw));
    return { name: `${path} exists and is a valid dataset definition`, pass: true };
  } catch (error) {
    return {
      name: `${path} exists and is a valid dataset definition`,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkAutomationsValid(run: RunRecord, path: string): Check {
  const raw = run.files[path];
  if (!raw) return { name: `${path} parses with zero diagnostics`, pass: false, detail: "missing" };
  const parsed = parseAutomationsFile(raw);
  if (parsed.status !== "read") {
    return {
      name: `${path} parses with zero diagnostics`,
      pass: false,
      detail: parsed.diagnostic.code,
    };
  }
  const invalid = parsed.entries.filter((entry) => entry.status === "invalid");
  if (parsed.entries.length === 0 || invalid.length > 0) {
    return {
      name: `${path} parses with zero diagnostics`,
      pass: false,
      detail: invalid.length > 0 ? JSON.stringify(invalid[0]?.diagnostics) : "no automations",
    };
  }
  return { name: `${path} parses with zero diagnostics`, pass: true };
}

function checkCollectionYamlValid(run: RunRecord, path: string, expectedFields: string[]): Check {
  const raw = run.files[path];
  if (!raw) return { name: `${path} is valid collection.yaml`, pass: false, detail: "missing" };
  const parsed = parseCollectionSchema(raw);
  if (parsed.status !== "valid") {
    return {
      name: `${path} is valid collection.yaml`,
      pass: false,
      detail: JSON.stringify(parsed.reasons),
    };
  }
  const names = new Set(parsed.schema.fields.map((f) => f.name.toLowerCase()));
  const missing = expectedFields.filter((f) => !names.has(f.toLowerCase()));
  return {
    name: `${path} defines ${expectedFields.join(", ")}`,
    pass: missing.length === 0,
    ...(missing.length > 0 ? { detail: `missing fields: ${missing.join(", ")}` } : {}),
  };
}

function checkAppPublishDataset(
  run: RunRecord,
  manifestPath: string,
  expectedDatasetPath: string,
  predicate?: (ref: ReturnType<typeof parseAppDatasetReference>) => string | null,
): Check {
  const raw = run.files[manifestPath];
  if (!raw)
    return {
      name: `${manifestPath} binds to ${expectedDatasetPath}`,
      pass: false,
      detail: "missing",
    };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const versionErr = fileVersionError(parsed.version, manifestPath);
    if (versionErr) {
      return {
        name: `${manifestPath} binds to ${expectedDatasetPath}`,
        pass: false,
        detail: versionErr,
      };
    }
    const ref = parseAppDatasetReference(parsed.dataset);
    if (ref.datasetPath !== expectedDatasetPath) {
      return {
        name: `${manifestPath} binds to ${expectedDatasetPath}`,
        pass: false,
        detail: `datasetPath was ${ref.datasetPath}`,
      };
    }
    const extra = predicate?.(ref);
    if (extra)
      return {
        name: `${manifestPath} binds to ${expectedDatasetPath}`,
        pass: false,
        detail: extra,
      };
    return { name: `${manifestPath} binds to ${expectedDatasetPath}`, pass: true };
  } catch (error) {
    return {
      name: `${manifestPath} binds to ${expectedDatasetPath}`,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Solution helper constants for deterministic replay tests
const TRACKER_DEF: DatasetDefinition = {
  formatVersion: 1,
  datasetId: uuid("a1000000", 1),
  name: "Personal Tracker",
  schemaPath: "tracker/schema.sql",
  operationsPath: "tracker/operations.js",
  tables: [
    {
      tableId: uuid("a1000000", 2),
      name: "Expenses",
      sqlName: "expenses",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("a1000000", 3),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: uuid("a1000000", 4),
          name: "Date",
          sqlColumn: "date",
          type: "date",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("a1000000", 5),
          name: "Category",
          sqlColumn: "category",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("a1000000", 6),
          name: "Amount",
          sqlColumn: "amount",
          type: "number",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("a1000000", 7),
          name: "Note",
          sqlColumn: "note",
          type: "text",
          required: false,
          unique: false,
        },
      ],
    },
    {
      tableId: uuid("a1000000", 8),
      name: "Check-ins",
      sqlName: "checkins",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("a1000000", 9),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: uuid("a1000000", 10),
          name: "Date",
          sqlColumn: "date",
          type: "date",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("a1000000", 11),
          name: "Sleep Hours",
          sqlColumn: "sleep_hours",
          type: "number",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("a1000000", 12),
          name: "Workout Minutes",
          sqlColumn: "workout_minutes",
          type: "number",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: uuid("a1000000", 13),
      name: "addExpense",
      label: "Add expense",
      tableId: uuid("a1000000", 2),
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [
        uuid("a1000000", 4),
        uuid("a1000000", 5),
        uuid("a1000000", 6),
        uuid("a1000000", 7),
      ],
    },
    {
      operationId: uuid("a1000000", 14),
      name: "listExpenses",
      label: "List expenses",
      tableId: uuid("a1000000", 2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [
        uuid("a1000000", 3),
        uuid("a1000000", 4),
        uuid("a1000000", 5),
        uuid("a1000000", 6),
        uuid("a1000000", 7),
      ],
    },
    {
      operationId: uuid("a1000000", 15),
      name: "addCheckin",
      label: "Add check-in",
      tableId: uuid("a1000000", 8),
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [uuid("a1000000", 10), uuid("a1000000", 11), uuid("a1000000", 12)],
    },
    {
      operationId: uuid("a1000000", 16),
      name: "listCheckins",
      label: "List check-ins",
      tableId: uuid("a1000000", 8),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [
        uuid("a1000000", 9),
        uuid("a1000000", 10),
        uuid("a1000000", 11),
        uuid("a1000000", 12),
      ],
    },
  ],
};

const WORKSHOP_BOOK_OP_ID = uuid("b2000000", 6);
const WORKSHOP_LIST_OP_ID = uuid("b2000000", 7);
const WORKSHOP_DEF: DatasetDefinition = {
  formatVersion: 1,
  datasetId: uuid("b2000000", 1),
  name: "Pottery Workshop",
  schemaPath: "workshop/schema.sql",
  operationsPath: "workshop/backend.ts",
  tables: [
    {
      tableId: uuid("b2000000", 2),
      name: "Bookings",
      sqlName: "bookings",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("b2000000", 3),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: uuid("b2000000", 4),
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("b2000000", 5),
          name: "Seats",
          sqlColumn: "seats",
          type: "number",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: WORKSHOP_BOOK_OP_ID,
      name: "bookSeat",
      label: "Book a seat",
      tableId: uuid("b2000000", 2),
      kind: "action",
      access: "link",
      readOnly: false,
      fieldIds: [],
    },
    {
      operationId: WORKSHOP_LIST_OP_ID,
      name: "listBookings",
      label: "List bookings",
      tableId: uuid("b2000000", 2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [uuid("b2000000", 3), uuid("b2000000", 4), uuid("b2000000", 5)],
    },
  ],
};
const WORKSHOP_SCHEMA = `CREATE TABLE "bookings" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "seats" INTEGER NOT NULL
);
`;
const WORKSHOP_BACKEND = `globalThis.operations = {
  bookSeat(ctx, input) {
    const seats = Number(input?.seats ?? 1);
    if (!Number.isInteger(seats) || seats < 1) ctx.refuse("invalid_seats", "Choose at least 1 seat.");
    const row = ctx.db.query("SELECT COALESCE(SUM(seats), 0) AS taken FROM bookings")[0];
    if (Number(row.taken) + seats > 8) ctx.refuse("workshop_full", "All 8 seats are booked.");
    ctx.db.execute("INSERT INTO bookings(id, name, seats) VALUES(?, ?, ?)", [ctx.requestId, String(input?.name ?? ""), seats]);
    return { id: ctx.requestId, seats };
  },
  listBookings(ctx) {
    return { rows: ctx.db.query("SELECT id, name, seats FROM bookings ORDER BY id") };
  },
};
`;

const BROKEN_INVENTORY_DEF = {
  formatVersion: 1 as const,
  datasetId: uuid("d4000000", 1),
  name: "Inventory",
  schemaPath: "inventory/schema.sql",
  operationsPath: "inventory/actions.ts",
  tables: [
    {
      tableId: uuid("d4000000", 2),
      name: "Items",
      sqlName: "items",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("d4000000", 3),
          name: "ID",
          sqlColumn: "id",
          type: "text" as const,
          required: true,
          unique: true,
        },
        {
          fieldId: uuid("d4000000", 4),
          name: "Name",
          sqlColumn: "name",
          type: "text" as const,
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("d4000000", 5),
          name: "Count",
          sqlColumn: "count",
          type: "number" as const,
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: uuid("d4000000", 6),
      name: "addItem",
      label: "Add item",
      tableId: uuid("d4000000", 2),
      kind: "create" as const,
      access: "owner" as const,
      readOnly: true, // BUG 1: create cannot be readOnly
      fieldIds: [uuid("d4000000", 4), uuid("d4000000", 5)],
    },
    {
      operationId: uuid("d4000000", 7),
      name: "editCount",
      label: "Edit count",
      tableId: uuid("d4000000", 2),
      kind: "edit" as const,
      access: "owner" as const,
      readOnly: false,
      fieldIds: [uuid("d4000000", 3), uuid("d4000000", 5)], // BUG 2: edit cannot include primary key
    },
    {
      operationId: uuid("d4000000", 8),
      name: "listItems",
      label: "List items",
      tableId: uuid("d4000000", 2),
      kind: "read" as const,
      access: "owner" as const,
      readOnly: true,
      fieldIds: [uuid("d4000000", 3), uuid("d4000000", 4), uuid("d4000000", 5)],
    },
  ],
};

const FIXED_INVENTORY_DEF: DatasetDefinition = {
  ...BROKEN_INVENTORY_DEF,
  operations: [
    { ...BROKEN_INVENTORY_DEF.operations[0]!, kind: "create", access: "owner", readOnly: false },
    {
      ...BROKEN_INVENTORY_DEF.operations[1]!,
      kind: "edit",
      access: "owner",
      readOnly: false,
      fieldIds: [uuid("d4000000", 5)],
    },
    { ...BROKEN_INVENTORY_DEF.operations[2]!, kind: "read", access: "owner", readOnly: true },
  ],
};

const INVENTORY_SCHEMA = `CREATE TABLE "items" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "count" INTEGER NOT NULL
);
`;

const FIXED_INVENTORY_ACTIONS = `globalThis.operations = {
  addItem(ctx, input) {
    ctx.db.execute("INSERT INTO items(id, name, count) VALUES(?, ?, ?)", [ctx.requestId, String(input.name), Number(input.count)]);
    return { id: ctx.requestId };
  },
  editCount(ctx, input) {
    ctx.db.execute("UPDATE items SET count = ? WHERE id = ?", [Number(input.count), String(input.id)]);
    return { id: input.id };
  },
  listItems(ctx) {
    return { rows: ctx.db.query("SELECT id, name, count FROM items ORDER BY name") };
  },
};
`;

export const EVERYDAY_CASES: readonly EvalCase[] = [
  {
    id: "everyday-finance-health-tracker",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Building a personal finance and health control tower requires creating a multi-table transactional Collection, approving it, adding starter records, and wiring a local web app through app.publish.json and dohc-app-channel.",
    source: "everyday-job-1",
    workspaceId: WS,
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      "Build a personal finance and health control tower in this workspace. Create a transactional Collection in `tracker/` with two tables: `expenses` (date, category, amount, note) and `checkins` (date, sleep_hours, workout_minutes). Approve it, add one expense (2026-11-22, Food, 18.5, Lunch) and one check-in (2026-11-22, 7.5 hours sleep, 40 workout minutes), then create a local web app in `apps/control-tower` connected to `tracker/dataset.json` via `app.publish.json` and `dohc-app-channel`, and prepare, approve, and launch it locally.",
    expect: {
      calls: [
        { tool: "dohc_dataset", args: { "request.action": "invoke" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "prepareLocal", "request.appRoot": "apps/control-tower" },
          ok: true,
        },
        { tool: "dohc_publish_app", args: { "request.action": "approve" }, ok: true },
        { tool: "dohc_publish_app", args: { "request.action": "launchLocal" }, ok: true },
      ],
    },
    gradeRun: (run) => {
      const checks: Check[] = [
        checkDatasetJsonValid(run, "tracker/dataset.json"),
        checkAppPublishDataset(run, "apps/control-tower/app.publish.json", "tracker/dataset.json"),
      ];
      const appText = Object.entries(run.files)
        .filter(
          ([path]) => path.startsWith("apps/control-tower/") && !path.endsWith("app.publish.json"),
        )
        .map(([, text]) => text)
        .join("\n");
      checks.push({
        name: "apps/control-tower connects to dohc-app-channel and calls backend.invoke",
        pass: appText.includes("dohc-app-channel") && appText.includes("backend.invoke"),
      });
      const invokes = run.calls.filter(
        (c) =>
          c.tool === "dohc_dataset" &&
          c.ok &&
          (c.args.request as Record<string, unknown> | undefined)?.action === "invoke",
      );
      checks.push({
        name: "invoked approved Collection operations at least twice (expense + check-in)",
        pass: invokes.length >= 2,
        ...(invokes.length < 2 ? { detail: `invoked ${invokes.length} time(s)` } : {}),
      });
      return checks;
    },
    solution: {
      run: async (callTool) => {
        const created = (await callTool("dohc_dataset", {
          request: { action: "create", workspaceId: WS, definition: TRACKER_DEF },
        })) as { revision: { revision: number; revisionSha256: string } };
        const { revision, revisionSha256 } = created.revision;
        await callTool("dohc_dataset", {
          request: {
            action: "invoke",
            workspaceId: WS,
            datasetPath: "tracker/dataset.json",
            operationId: uuid("a1000000", 13),
            revision,
            revisionSha256,
            input: {
              values: {
                [uuid("a1000000", 4)]: "2026-11-22",
                [uuid("a1000000", 5)]: "Food",
                [uuid("a1000000", 6)]: 18.5,
                [uuid("a1000000", 7)]: "Lunch",
              },
            },
            idempotencyKey: "exp-1",
          },
        });
        await callTool("dohc_dataset", {
          request: {
            action: "invoke",
            workspaceId: WS,
            datasetPath: "tracker/dataset.json",
            operationId: uuid("a1000000", 15),
            revision,
            revisionSha256,
            input: {
              values: {
                [uuid("a1000000", 10)]: "2026-11-22",
                [uuid("a1000000", 11)]: 7.5,
                [uuid("a1000000", 12)]: 40,
              },
            },
            idempotencyKey: "chk-1",
          },
        });
        await callTool("dohc_write_file", {
          path: "apps/control-tower/index.html",
          content:
            '<!doctype html><html><body><h1>Control Tower</h1><script type="module" src="./app.js"></script></body></html>\n',
        });
        await callTool("dohc_write_file", {
          path: "apps/control-tower/app.js",
          content:
            'window.addEventListener("message", (e) => { if (e.data?.kind === "dohc-app-channel") e.ports[0]?.postMessage({ id: "r1", op: "backend.invoke", operation: "listExpenses", input: {}, idempotencyKey: "r1" }); });\n',
        });
        await callTool("dohc_write_file", {
          path: "apps/control-tower/app.publish.json",
          content:
            JSON.stringify(
              {
                version: 1,
                entryPath: "index.html",
                inputs: ["index.html", "app.js"],
                packageMap: {},
                dataset: {
                  kind: "dataset",
                  datasetPath: "tracker/dataset.json",
                  revision,
                  revisionSha256,
                  operationIds: [uuid("a1000000", 14), uuid("a1000000", 16)],
                },
              },
              null,
              2,
            ) + "\n",
        });
        const prepared = (await callTool("dohc_publish_app", {
          request: { action: "prepareLocal", workspaceId: WS, appRoot: "apps/control-tower" },
        })) as { approvalId: string; candidateDigest: string };
        const published = (await callTool("dohc_publish_app", {
          request: {
            action: "approve",
            workspaceId: WS,
            approvalId: prepared.approvalId,
            candidateDigest: prepared.candidateDigest,
          },
        })) as { publicationId: string };
        await callTool("dohc_publish_app", {
          request: {
            action: "launchLocal",
            workspaceId: WS,
            publicationId: published.publicationId,
          },
        });
      },
    },
  },
  {
    id: "everyday-family-trip-planner",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Planning a family trip combines a document Collection (collection.yaml + Markdown records), an itinerary note created through document tools, and a decision poll in a Group.",
    source: "everyday-job-2",
    workspaceId: WS,
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      'Set up a family trip planner for Kyoto. Create a document Collection in `trip/activities` with `collection.yaml` defining fields `Day` (number), `Status` (select: Idea, Booked, Done), and `Cost` (number). Add two records via dohc\'s Collection tool: "Fushimi Inari" (Day 1, Status Idea, Cost 0) and "Nishiki Market" (Day 2, Status Booked, Cost 45). Create `trip/itinerary.md` summarizing both activities, and post a poll in the Planning group asking whether to book the tea ceremony on "Day 2" or "Day 3".',
    expect: {
      calls: [
        {
          tool: "dohc_create_record",
          args: { collectionPath: "trip/activities", name: "~Fushimi Inari" },
          ok: true,
        },
        {
          tool: "dohc_create_record",
          args: { collectionPath: "trip/activities", name: "~Nishiki Market" },
          ok: true,
        },
        { tool: "dohc_create_document", args: { path: "trip/itinerary.md" }, ok: true },
        {
          tool: "dohc_start_group_chat",
          args: { group: "~planning", needsDecision: true },
          ok: true,
        },
      ],
      notCalls: [{ tool: "dohc_write_file", args: { path: "~.md" } }],
      files: {
        "trip/itinerary.md": { contains: ["Fushimi Inari", "Nishiki Market"] },
      },
    },
    gradeRun: (run) => [
      checkCollectionYamlValid(run, "trip/activities/collection.yaml", ["Day", "Status", "Cost"]),
    ],
    solution: {
      calls: [
        {
          tool: "dohc_write_file",
          args: {
            path: "trip/activities/collection.yaml",
            content:
              "version: 1\nname: Kyoto Activities\nfields:\n  Day:\n    type: number\n  Status:\n    type: select\n    options:\n      - Idea\n      - Booked\n      - Done\n  Cost:\n    type: number\n",
          },
        },
        {
          tool: "dohc_create_record",
          args: {
            collectionPath: "trip/activities",
            name: "Fushimi Inari",
            fields: { Day: 1, Status: "Idea", Cost: 0 },
          },
        },
        {
          tool: "dohc_create_record",
          args: {
            collectionPath: "trip/activities",
            name: "Nishiki Market",
            fields: { Day: 2, Status: "Booked", Cost: 45 },
          },
        },
        {
          tool: "dohc_create_document",
          args: {
            path: "trip/itinerary.md",
            markdown:
              "# Kyoto Itinerary\n\n- Day 1: [[Fushimi Inari]]\n- Day 2: [[Nishiki Market]]\n",
          },
        },
        {
          tool: "dohc_start_group_chat",
          args: {
            group: "Planning",
            title: "Tea ceremony day",
            body: "Which day should we book the tea ceremony?",
            needsDecision: true,
            options: ["Day 2", "Day 3"],
          },
        },
      ],
    },
  },
  {
    id: "everyday-booking-capacity-app",
    suite: "everyday",
    kind: "everyday",
    experience:
      "A small-business booking app requires a transactional Collection with custom QuickJS capacity enforcement (ctx.refuse) and a shared app publication that exposes only the public link operation, never owner reads.",
    source: "everyday-job-3",
    workspaceId: WS,
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      'I run a weekend pottery workshop with 8 seats. Create a transactional Collection in `workshop/` (`dataset.json`, `schema.sql`, `backend.ts`) with a `bookings` table (`id`, `name`, `seats`), a public `bookSeat` operation (`access: "link"`) that refuses via `ctx.refuse` when total seats would exceed 8, and an owner-only `listBookings` read. Prepare and approve the Collection, build `apps/booking` with `app.publish.json` exposing ONLY `bookSeat` (never `listBookings`), create a share link, and prepare and approve the shared publication.',
    expect: {
      calls: [
        { tool: "dohc_dataset", args: { "request.action": "prepare" }, ok: true },
        { tool: "dohc_dataset", args: { "request.action": "approve" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "createLink", "request.appRoot": "apps/booking" },
          ok: true,
        },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "prepare", "request.appRoot": "apps/booking" },
          ok: true,
        },
        { tool: "dohc_publish_app", args: { "request.action": "approve" }, ok: true },
      ],
    },
    gradeRun: (run) => {
      const checks: Check[] = [checkDatasetJsonValid(run, "workshop/dataset.json")];
      let bookOpId: string | undefined;
      let listOpId: string | undefined;
      try {
        const def = parseDatasetDefinition(JSON.parse(run.files["workshop/dataset.json"] ?? ""));
        const bookOp = def.operations.find((o) => o.name === "bookSeat");
        const listOp = def.operations.find((o) => o.name === "listBookings");
        bookOpId = bookOp?.operationId;
        listOpId = listOp?.operationId;
        checks.push({
          name: "bookSeat is link-accessible write and listBookings is owner-only read",
          pass:
            bookOp !== undefined &&
            bookOp.access === "link" &&
            !bookOp.readOnly &&
            listOp !== undefined &&
            listOp.access === "owner" &&
            listOp.readOnly,
        });
      } catch {
        checks.push({ name: "bookSeat and listBookings declared cleanly", pass: false });
      }
      const backendText =
        run.files["workshop/backend.ts"] ?? run.files["workshop/operations.js"] ?? "";
      checks.push({
        name: "backend enforces capacity with ctx.refuse",
        pass: backendText.includes("globalThis.operations") && backendText.includes("ctx.refuse"),
      });
      checks.push(
        checkAppPublishDataset(
          run,
          "apps/booking/app.publish.json",
          "workshop/dataset.json",
          (ref) => {
            if (!bookOpId || !ref.operationIds.includes(bookOpId))
              return "missing bookSeat operationId";
            if (listOpId && ref.operationIds.includes(listOpId))
              return "must not expose owner-only listBookings";
            return null;
          },
        ),
      );
      return checks;
    },
    solution: {
      run: async (callTool) => {
        await callTool("dohc_write_file", {
          path: "workshop/dataset.json",
          content: JSON.stringify(WORKSHOP_DEF, null, 2) + "\n",
        });
        await callTool("dohc_write_file", {
          path: "workshop/schema.sql",
          content: WORKSHOP_SCHEMA,
        });
        await callTool("dohc_write_file", {
          path: "workshop/backend.ts",
          content: WORKSHOP_BACKEND,
        });
        const prep = (await callTool("dohc_dataset", {
          request: { action: "prepare", workspaceId: WS, descriptorPath: "workshop/dataset.json" },
        })) as { preparationId: string; revision: { revision: number; revisionSha256: string } };
        await callTool("dohc_dataset", {
          request: {
            action: "approve",
            workspaceId: WS,
            preparationId: prep.preparationId,
            revisionSha256: prep.revision.revisionSha256,
          },
        });
        await callTool("dohc_write_file", {
          path: "apps/booking/index.html",
          content: "<!doctype html><h1>Pottery Workshop</h1>\n",
        });
        await callTool("dohc_write_file", {
          path: "apps/booking/app.publish.json",
          content:
            JSON.stringify(
              {
                version: 1,
                entryPath: "index.html",
                inputs: ["index.html"],
                packageMap: {},
                dataset: {
                  kind: "dataset",
                  datasetPath: "workshop/dataset.json",
                  revision: prep.revision.revision,
                  revisionSha256: prep.revision.revisionSha256,
                  operationIds: [WORKSHOP_BOOK_OP_ID],
                },
              },
              null,
              2,
            ) + "\n",
        });
        const link = (await callTool("dohc_publish_app", {
          request: {
            action: "createLink",
            workspaceId: WS,
            appRoot: "apps/booking",
            operationId: uuid("b2000000", 99),
          },
        })) as { shareId: string; grantId: string };
        const appPrep = (await callTool("dohc_publish_app", {
          request: {
            action: "prepare",
            workspaceId: WS,
            appRoot: "apps/booking",
            shareId: link.shareId,
            grantId: link.grantId,
          },
        })) as { approvalId: string; candidateDigest: string };
        await callTool("dohc_publish_app", {
          request: {
            action: "approve",
            workspaceId: WS,
            approvalId: appPrep.approvalId,
            candidateDigest: appPrep.candidateDigest,
          },
        });
      },
    },
  },
  {
    id: "everyday-add-field-and-migrate",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Adding a required field to an existing Collection with records requires prepareSchemaChange + approveMigration and updating any bound app's app.publish.json to the new revision.",
    source: "everyday-job-4",
    workspaceId: WS,
    files: {
      "clients/dataset.json": JSON.stringify(CLIENTS_DEF, null, 2) + "\n",
      "clients/schema.sql": CLIENTS_SCHEMA,
      "clients/operations.js": CLIENTS_OPS,
      "apps/client-portal/index.html": "<!doctype html><h1>Clients</h1>\n",
      "apps/client-portal/app.publish.json":
        JSON.stringify(
          {
            version: 1,
            entryPath: "index.html",
            inputs: ["index.html"],
            packageMap: {},
            dataset: {
              kind: "dataset",
              datasetPath: "clients/dataset.json",
              revision: 1,
              revisionSha256: CLIENTS_REV1_SHA,
              operationIds: [uuid("c1000000", 6)],
            },
          },
          null,
          2,
        ) + "\n",
    },
    setupDesktop: (root) =>
      createEverydayDesktop(root, {
        workspaceId: WS,
        datasets: [
          {
            datasetPath: "clients/dataset.json",
            generated: true,
            seedSql: `INSERT INTO clients(id, name, email) VALUES ('r1','Ava','ava@example.com'),('r2','Ben','ben@example.com'),('r3','Cam','cam@example.com');`,
          },
        ],
      }),
    prompt:
      'Add a required select field called "Tier" (options: "Standard", "VIP", default: "Standard") to the Clients Collection (`clients/dataset.json`) safely without losing the 3 existing client records. Then update `apps/client-portal/app.publish.json` to the new approved revision and prepare and approve `apps/client-portal` locally.',
    expect: {
      calls: [
        {
          tool: "dohc_dataset",
          args: { "request.action": "describe", "request.datasetPath": "clients/dataset.json" },
          ok: true,
        },
        { tool: "dohc_dataset", args: { "request.action": "prepareSchemaChange" }, ok: true },
        { tool: "dohc_dataset", args: { "request.action": "approveMigration" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "prepareLocal", "request.appRoot": "apps/client-portal" },
          ok: true,
        },
        { tool: "dohc_publish_app", args: { "request.action": "approve" }, ok: true },
      ],
    },
    gradeRun: (run) => [
      checkDatasetJsonValid(run, "clients/dataset.json"),
      checkAppPublishDataset(
        run,
        "apps/client-portal/app.publish.json",
        "clients/dataset.json",
        (ref) =>
          ref.revision >= 2 && ref.revisionSha256 !== CLIENTS_REV1_SHA
            ? null
            : `still pinned to revision ${ref.revision}`,
      ),
    ],
    solution: {
      run: async (callTool) => {
        const described = (await callTool("dohc_dataset", {
          request: { action: "describe", workspaceId: WS, datasetPath: "clients/dataset.json" },
        })) as { dataset: { revision: number; revisionSha256: string } };
        const prep = (await callTool("dohc_dataset", {
          request: {
            action: "prepareSchemaChange",
            workspaceId: WS,
            datasetPath: "clients/dataset.json",
            revision: described.dataset.revision,
            revisionSha256: described.dataset.revisionSha256,
            change: {
              kind: "addField",
              tableId: uuid("c1000000", 2),
              field: {
                name: "Tier",
                type: "select",
                required: true,
                unique: false,
                options: ["Standard", "VIP"],
                default: "Standard",
              },
            },
          },
        })) as {
          preparationId: string;
          approvalDigest: string;
          revision: { revision: number; revisionSha256: string };
        };
        await callTool("dohc_dataset", {
          request: {
            action: "approveMigration",
            workspaceId: WS,
            preparationId: prep.preparationId,
            revisionSha256: prep.revision.revisionSha256,
            approvalDigest: prep.approvalDigest,
          },
        });
        await callTool("dohc_write_file", {
          path: "apps/client-portal/app.publish.json",
          content:
            JSON.stringify(
              {
                version: 1,
                entryPath: "index.html",
                inputs: ["index.html"],
                packageMap: {},
                dataset: {
                  kind: "dataset",
                  datasetPath: "clients/dataset.json",
                  revision: prep.revision.revision,
                  revisionSha256: prep.revision.revisionSha256,
                  operationIds: [uuid("c1000000", 6)],
                },
              },
              null,
              2,
            ) + "\n",
        });
        const appPrep = (await callTool("dohc_publish_app", {
          request: { action: "prepareLocal", workspaceId: WS, appRoot: "apps/client-portal" },
        })) as { approvalId: string; candidateDigest: string };
        await callTool("dohc_publish_app", {
          request: {
            action: "approve",
            workspaceId: WS,
            approvalId: appPrep.approvalId,
            candidateDigest: appPrep.candidateDigest,
          },
        });
      },
    },
  },
  {
    id: "everyday-collection-automation",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Authoring automations.yaml requires exact version: 1, when/if/do syntax, '=today()' formula quoting, bare expressions in if conditions, and template braces in post messages, then verifying with dohc_list_automations.",
    source: "everyday-job-5",
    workspaceId: WS,
    files: {
      "expenses/collection.yaml":
        "version: 1\nname: Expenses\nfields:\n  Amount:\n    type: number\n  Category:\n    type: text\n  Status:\n    type: select\n    options:\n      - Open\n      - Needs Review\n      - Approved\n  Flagged On:\n    type: date\n",
    },
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      "Add an automation to the `expenses` Collection (`expenses/automations.yaml`) so whenever a record's `Amount` field changes and `Amount` is over 500, it sets `Status` to \"Needs Review\", sets `Flagged On` to today's date using `today()`, and posts a message to the `Finance` group showing the amount. Verify with `dohc_list_automations` that it loads with zero errors.",
    expect: {
      calls: [{ tool: "dohc_list_automations", args: { collectionPath: "expenses" }, ok: true }],
      files: {
        "expenses/automations.yaml": {
          contains: ["field-changed", "today()", "Needs Review", "Finance"],
        },
      },
    },
    gradeRun: (run) => [checkAutomationsValid(run, "expenses/automations.yaml")],
    solution: {
      calls: [
        {
          tool: "dohc_write_file",
          args: {
            path: "expenses/automations.yaml",
            content: [
              "version: 1",
              "automations:",
              "  - id: flag-large-expense",
              "    name: Flag expenses over 500",
              "    when:",
              "      field-changed: Amount",
              "    do:",
              "      - if: record.Amount > 500",
              "        do:",
              "          - set:",
              "              Status: Needs Review",
              "              Flagged On: '=today()'",
              "          - post: 'Expense needs review: {record.Amount}'",
              "            group: Finance",
              "",
            ].join("\n"),
          },
        },
        { tool: "dohc_list_automations", args: { collectionPath: "expenses" } },
      ],
    },
  },
  {
    id: "everyday-versions-safe-experiment",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Trying changes on a separate workspace Version requires create, edit via document tools, compare against Main, and merge into Main.",
    source: "everyday-job-6",
    workspaceId: WS,
    files: {
      "pricing.md": "# Pricing\n\n- Starter: $19/month\n- Pro: $49/month\n",
      "README.md": "# Store\n",
    },
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      'Use dohc Versions to test a pricing update safely: create a new Version named `q4-pricing-test`, edit `pricing.md` with dohc\'s document tools to change Starter from "$19/month" to "$29/month", compare `q4-pricing-test` against Main, and merge `q4-pricing-test` into Main.',
    expect: {
      calls: [
        { tool: "dohc_create_version", args: { name: "q4-pricing-test" }, ok: true },
        { tool: "dohc_edit_document", args: { path: "pricing.md" }, ok: true },
        { tool: "dohc_compare_version", args: { version: "~q4-pricing-test" }, ok: true },
        { tool: "dohc_merge_version", args: { version: "~q4-pricing-test" }, ok: true },
      ],
      order: [
        "dohc_create_version",
        "dohc_edit_document",
        "dohc_compare_version",
        "dohc_merge_version",
      ],
      notCalls: ["dohc_write_file"],
      files: { "pricing.md": { contains: ["$29/month"], lacks: ["$19/month"] } },
    },
    solution: {
      calls: [
        { tool: "dohc_create_version", args: { name: "q4-pricing-test" } },
        {
          tool: "dohc_edit_document",
          args: { path: "pricing.md", find: "$19/month", replacement: "$29/month" },
        },
        { tool: "dohc_compare_version", args: { version: "q4-pricing-test" } },
        { tool: "dohc_merge_version", args: { version: "q4-pricing-test" } },
      ],
    },
  },
  {
    id: "everyday-connected-form-relations",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Creating a public form with a related-record picker requires prepareRelationChoices on only the public label field, approveMigration, and createForm without exposing private target fields.",
    source: "everyday-job-7",
    workspaceId: WS,
    files: {
      "events/dataset.json": JSON.stringify(EVENTS_DEF, null, 2) + "\n",
      "events/schema.sql": EVENTS_SCHEMA,
      "events/operations.js": EVENTS_OPS,
    },
    setupDesktop: (root) =>
      createEverydayDesktop(root, {
        workspaceId: WS,
        datasets: [{ datasetPath: "events/dataset.json", generated: true }],
      }),
    prompt:
      "Create a public signup form in `apps/signup-form` for the `Signups` table in `events/dataset.json`. Guests should pick a `Session` by its `Title` without exposing `Internal Notes`. Prepare and approve public relation choices for the Session field first, then create the form.",
    expect: {
      calls: [
        {
          tool: "dohc_dataset",
          args: { "request.action": "describe", "request.datasetPath": "events/dataset.json" },
          ok: true,
        },
        {
          tool: "dohc_dataset",
          args: {
            "request.action": "prepareRelationChoices",
            "request.labelFieldId": uuid("e2000000", 4),
          },
          ok: true,
        },
        { tool: "dohc_dataset", args: { "request.action": "approveMigration" }, ok: true },
        {
          tool: "dohc_dataset",
          args: { "request.action": "createForm", "request.appRoot": "apps/signup-form" },
          ok: true,
        },
      ],
    },
    gradeRun: (run) => [
      checkAppPublishDataset(
        run,
        "apps/signup-form/app.publish.json",
        "events/dataset.json",
        (ref) =>
          ref.operationIds.includes(uuid("e2000000", 10))
            ? "leaked private owner readSessions operation"
            : null,
      ),
    ],
    solution: {
      run: async (callTool) => {
        const described = (await callTool("dohc_dataset", {
          request: { action: "describe", workspaceId: WS, datasetPath: "events/dataset.json" },
        })) as { dataset: { revision: number; revisionSha256: string } };
        const prep = (await callTool("dohc_dataset", {
          request: {
            action: "prepareRelationChoices",
            workspaceId: WS,
            datasetPath: "events/dataset.json",
            revision: described.dataset.revision,
            revisionSha256: described.dataset.revisionSha256,
            tableId: uuid("e2000000", 6),
            fieldId: uuid("e2000000", 9),
            labelFieldId: uuid("e2000000", 4),
          },
        })) as {
          preparationId: string;
          approvalDigest: string;
          revision: {
            revision: number;
            revisionSha256: string;
            definition: {
              operations: Array<{ operationId: string; kind: string; access: string }>;
            };
          };
        };
        await callTool("dohc_dataset", {
          request: {
            action: "approveMigration",
            workspaceId: WS,
            preparationId: prep.preparationId,
            revisionSha256: prep.revision.revisionSha256,
            approvalDigest: prep.approvalDigest,
          },
        });
        const choiceOp = prep.revision.definition.operations.find(
          (o) => o.kind === "read" && o.access === "link",
        )!;
        await callTool("dohc_dataset", {
          request: {
            action: "createForm",
            workspaceId: WS,
            datasetPath: "events/dataset.json",
            revision: prep.revision.revision,
            revisionSha256: prep.revision.revisionSha256,
            tableId: uuid("e2000000", 6),
            createOperationId: uuid("e2000000", 11),
            appRoot: "apps/signup-form",
            title: "Event Signup",
            fieldIds: [uuid("e2000000", 8), uuid("e2000000", 9)],
            relationChoices: [
              {
                fieldId: uuid("e2000000", 9),
                operationId: choiceOp.operationId,
                labelFieldId: uuid("e2000000", 4),
              },
            ],
          },
        });
      },
    },
  },
  {
    id: "everyday-csv-import-query-note",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Importing CSV data into a visible SQLite database, querying aggregates with SQL, and writing a summary document uses dohc_import_data, dohc_query_database, and dohc_create_document.",
    source: "everyday-job-8",
    workspaceId: WS,
    files: {
      "exports/sales.csv": [
        "category,item,revenue",
        "Coffee,Espresso,120",
        "Coffee,Latte,180",
        "Bakery,Croissant,95",
        "Bakery,Muffin,55",
        "Tea,Matcha,140",
        "",
      ].join("\n"),
    },
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      "Import `exports/sales.csv` into a visible database `data/sales.sqlite` as table `sales`, query total revenue by category, and create a Markdown summary document `reports/sales-summary.md` listing each category's total (Coffee, Bakery, Tea).",
    expect: {
      calls: [
        {
          tool: "dohc_import_data",
          args: {
            sourcePath: "exports/sales.csv",
            databasePath: "data/sales.sqlite",
            tableName: "sales",
          },
          ok: true,
        },
        { tool: "dohc_query_database", args: { databasePath: "data/sales.sqlite" }, ok: true },
        { tool: "dohc_create_document", args: { path: "reports/sales-summary.md" }, ok: true },
      ],
      order: ["dohc_import_data", "dohc_query_database", "dohc_create_document"],
      notCalls: [{ tool: "dohc_write_file", args: { path: "reports/sales-summary.md" } }],
      files: {
        "reports/sales-summary.md": { contains: ["300", "150", "140"] },
      },
    },
    solution: {
      calls: [
        {
          tool: "dohc_import_data",
          args: {
            sourcePath: "exports/sales.csv",
            databasePath: "data/sales.sqlite",
            tableName: "sales",
          },
        },
        {
          tool: "dohc_query_database",
          args: {
            databasePath: "data/sales.sqlite",
            sql: "SELECT category, SUM(CAST(revenue AS INTEGER)) AS total FROM sales GROUP BY category ORDER BY category",
          },
        },
        {
          tool: "dohc_create_document",
          args: {
            path: "reports/sales-summary.md",
            markdown: "# Sales Summary\n\n- Coffee: 300\n- Bakery: 150\n- Tea: 140\n",
          },
        },
      ],
    },
  },
  {
    id: "everyday-self-remedy-broken-app",
    suite: "everyday",
    kind: "everyday",
    experience:
      "Fixing broken dataset.json, actions.ts, app.publish.json, and automations.yaml tests whether CLI/MCP errors tell the agent exactly what failed and how to recover.",
    source: "everyday-job-9",
    workspaceId: WS,
    files: {
      "inventory/dataset.json": JSON.stringify(BROKEN_INVENTORY_DEF, null, 2) + "\n",
      "inventory/schema.sql": INVENTORY_SCHEMA,
      "inventory/actions.ts": `import { something } from "fs";\nglobalThis.operations = {\n  addItem(ctx, input) {\n    ctx.db.execute("INSERT INTO items(id, name, count) VALUES(?, ?, ?)", [ctx.requestId, String(input.name), Number(input.count)]);\n    return { id: ctx.requestId };\n  },\n  editCount(ctx, input) {\n    ctx.db.execute("UPDATE items SET count = ? WHERE id = ?", [Number(input.count), String(input.id)]);\n    return { id: input.id };\n  },\n  listItems(ctx) {\n    return { rows: ctx.db.query("SELECT id, name, count FROM items ORDER BY name") };\n  },\n};\n`,
      "inventory/automations.yaml": [
        "version: 1",
        "automations:",
        "  - id: low-stock",
        "    name: Low stock alert",
        "    when:",
        "      field-changed: Count",
        "    do:",
        "      - if: '=record.Count < 5'",
        "        do:",
        "          - post: 'Low stock: {record.Name}'",
        "            group: General",
        "",
      ].join("\n"),
      "apps/stock/index.html": "<!doctype html><h1>Stock</h1>\n",
      "apps/stock/app.publish.json":
        JSON.stringify(
          {
            version: "1",
            entryPath: "index.html",
            inputs: ["index.html"],
            packageMap: {},
            dataset: {
              kind: "dataset",
              datasetPath: "inventory",
              revision: 1,
              revisionSha256: "0".repeat(64),
              operationIds: [uuid("d4000000", 8)],
            },
          },
          null,
          2,
        ) + "\n",
    },
    setupDesktop: (root) => createEverydayDesktop(root, { workspaceId: WS }),
    prompt:
      "This workspace has validation errors in `inventory/dataset.json`, `inventory/actions.ts`, `inventory/automations.yaml`, and `apps/stock/app.publish.json`. Diagnose and fix all four files, prepare and approve the `inventory` Collection, prepare and approve `apps/stock` locally, and verify with `dohc_list_automations` that `inventory/automations.yaml` loads cleanly.",
    expect: {
      calls: [
        { tool: "dohc_dataset", args: { "request.action": "prepare" }, ok: true },
        { tool: "dohc_dataset", args: { "request.action": "approve" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "prepareLocal", "request.appRoot": "apps/stock" },
          ok: true,
        },
        { tool: "dohc_publish_app", args: { "request.action": "approve" }, ok: true },
        { tool: "dohc_list_automations", args: { collectionPath: "inventory" }, ok: true },
      ],
    },
    gradeRun: (run) => [
      checkDatasetJsonValid(run, "inventory/dataset.json"),
      checkAppPublishDataset(run, "apps/stock/app.publish.json", "inventory/dataset.json"),
      checkAutomationsValid(run, "inventory/automations.yaml"),
    ],
    solution: {
      run: async (callTool) => {
        await callTool("dohc_write_file", {
          path: "inventory/dataset.json",
          content: JSON.stringify(FIXED_INVENTORY_DEF, null, 2) + "\n",
        });
        await callTool("dohc_write_file", {
          path: "inventory/actions.ts",
          content: FIXED_INVENTORY_ACTIONS,
        });
        await callTool("dohc_write_file", {
          path: "inventory/automations.yaml",
          content: [
            "version: 1",
            "automations:",
            "  - id: low-stock",
            "    name: Low stock alert",
            "    when:",
            "      field-changed: Count",
            "    do:",
            "      - if: record.Count < 5",
            "        do:",
            "          - post: 'Low stock: {record.Name}'",
            "            group: General",
            "",
          ].join("\n"),
        });
        const prep = (await callTool("dohc_dataset", {
          request: { action: "prepare", workspaceId: WS, descriptorPath: "inventory/dataset.json" },
        })) as { preparationId: string; revision: { revision: number; revisionSha256: string } };
        await callTool("dohc_dataset", {
          request: {
            action: "approve",
            workspaceId: WS,
            preparationId: prep.preparationId,
            revisionSha256: prep.revision.revisionSha256,
          },
        });
        await callTool("dohc_write_file", {
          path: "apps/stock/app.publish.json",
          content:
            JSON.stringify(
              {
                version: 1,
                entryPath: "index.html",
                inputs: ["index.html"],
                packageMap: {},
                dataset: {
                  kind: "dataset",
                  datasetPath: "inventory/dataset.json",
                  revision: prep.revision.revision,
                  revisionSha256: prep.revision.revisionSha256,
                  operationIds: [uuid("d4000000", 8)],
                },
              },
              null,
              2,
            ) + "\n",
        });
        const appPrep = (await callTool("dohc_publish_app", {
          request: { action: "prepareLocal", workspaceId: WS, appRoot: "apps/stock" },
        })) as { approvalId: string; candidateDigest: string };
        await callTool("dohc_publish_app", {
          request: {
            action: "approve",
            workspaceId: WS,
            approvalId: appPrep.approvalId,
            candidateDigest: appPrep.candidateDigest,
          },
        });
        await callTool("dohc_list_automations", { collectionPath: "inventory" });
      },
    },
  },
];
