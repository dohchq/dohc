import { createHash } from "node:crypto";
import {
  evaluateAppOperation,
  initializeAppDatabase,
  isAppBackendRuntimeError,
  type JsonValue,
} from "@dohc/app-backend-runtime";
import { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { fileVersionError } from "@dohc/workspace-contracts/file-version";
import {
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  parseAppDatasetReference,
  parseDatasetDefinition,
  type AppDatasetCapability,
  type DatasetDefinition,
} from "@dohc/security-contract/dataset";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { Check, EvalCase, RunRecord } from "./case";
import {
  checkEvalScriptSyntax,
  computeEvalAppSourceRevision,
  createEverydayDesktop,
  isEvalExecutableScriptTag,
} from "./everydayDesktop";

const WS = "ws-everyday";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const stripJsComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
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

const CLIENTS_PORTAL_CAPABILITY: AppDatasetCapability = {
  kind: "dataset",
  datasetId: CLIENTS_DEF.datasetId,
  name: CLIENTS_DEF.name,
  revision: 1,
  revisionSha256: CLIENTS_REV1_SHA,
  operationIds: [uuid("c1000000", 6)],
  operations: [
    {
      operationId: uuid("c1000000", 6),
      name: "listClients",
      access: "owner",
      readOnly: true,
    },
  ],
};

const PLEDGES_DEF: DatasetDefinition = {
  formatVersion: 1,
  datasetId: uuid("f5000000", 1),
  name: "Fundraiser Pledges",
  schemaPath: "fundraiser/schema.sql",
  operationsPath: "fundraiser/operations.js",
  tables: [
    {
      tableId: uuid("f5000000", 2),
      name: "Pledges",
      sqlName: "pledges",
      primaryKey: "id",
      fields: [
        {
          fieldId: uuid("f5000000", 3),
          name: "Record ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: uuid("f5000000", 4),
          name: "Supporter",
          sqlColumn: "supporter",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: uuid("f5000000", 5),
          name: "Amount",
          sqlColumn: "amount",
          type: "number",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: uuid("f5000000", 6),
      name: "listPledges",
      label: "List pledges",
      tableId: uuid("f5000000", 2),
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [uuid("f5000000", 3), uuid("f5000000", 4), uuid("f5000000", 5)],
    },
    {
      operationId: uuid("f5000000", 7),
      name: "createPledge",
      label: "Create pledge",
      tableId: uuid("f5000000", 2),
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [uuid("f5000000", 4), uuid("f5000000", 5)],
    },
  ],
};
const PLEDGES_SCHEMA = `CREATE TABLE "pledges" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "supporter" TEXT NOT NULL,
  "amount" REAL NOT NULL,
  "_record_version" INTEGER NOT NULL DEFAULT 1
);
`;
const PLEDGES_OPS = generateDatasetOperations(PLEDGES_DEF);
const PLEDGES_REV1_SHA = sha256(
  datasetRevisionDigestContent({
    datasetId: PLEDGES_DEF.datasetId,
    revision: 1,
    revisionSha256: "0".repeat(64),
    definitionSha256: sha256(datasetDefinitionDigestContent(PLEDGES_DEF)),
    schemaSha256: sha256(PLEDGES_SCHEMA),
    operationsSha256: sha256(PLEDGES_OPS),
    definition: PLEDGES_DEF,
  }),
);
const PLEDGES_ORGANIZER_CAP: AppDatasetCapability = {
  kind: "dataset",
  datasetId: PLEDGES_DEF.datasetId,
  name: PLEDGES_DEF.name,
  revision: 1,
  revisionSha256: PLEDGES_REV1_SHA,
  operationIds: [uuid("f5000000", 6)],
  operations: [
    {
      operationId: uuid("f5000000", 6),
      name: "listPledges",
      access: "owner",
      readOnly: true,
    },
  ],
};
const PLEDGES_FORM_CAP: AppDatasetCapability = {
  kind: "dataset",
  datasetId: PLEDGES_DEF.datasetId,
  name: PLEDGES_DEF.name,
  revision: 1,
  revisionSha256: PLEDGES_REV1_SHA,
  operationIds: [uuid("f5000000", 7)],
  createFields: [
    {
      operationId: uuid("f5000000", 7),
      fieldIds: [uuid("f5000000", 4), uuid("f5000000", 5)],
    },
  ],
  operations: [
    {
      operationId: uuid("f5000000", 7),
      name: "createPledge",
      access: "link",
      readOnly: false,
    },
  ],
};

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

function checkFrontendVerifiedForFinalSource(
  run: RunRecord,
  appRoot: string,
  extra?: (record: NonNullable<RunRecord["frontendVerifications"]>[string]) => string | null,
): Check {
  const record = run.frontendVerifications?.[appRoot];
  const name =
    record?.mode === "observed"
      ? `${appRoot} passed observed verifyFrontend execution on its final source`
      : `${appRoot} passed stand-in verifyFrontend static check on its final source`;
  if (!record) return { name, pass: false, detail: "verifyFrontend was not run" };
  if (!record.ok) return { name, pass: false, detail: `verifyFrontend failed at ${record.stage}` };
  const expectedRev = computeEvalAppSourceRevision(run.files, appRoot);
  if (!expectedRev || record.sourceRevision !== expectedRev) {
    return { name, pass: false, detail: "app source changed after verifyFrontend" };
  }
  const reason = extra?.(record);
  if (reason) return { name, pass: false, detail: reason };
  return { name, pass: true };
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

function referencedOperationIds(
  ref: ReturnType<typeof parseAppDatasetReference>,
  def: DatasetDefinition | undefined,
): string[] {
  if ("operationIds" in ref) return ref.operationIds;
  const byName = new Map((def?.operations ?? []).map((op) => [op.name, op.operationId]));
  return ref.operations.map((name) => byName.get(name) ?? name);
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
    prompt:
      "Build a personal finance and health control tower in this workspace. Create a transactional Collection in `tracker/` with two tables: `expenses` (date, category, amount, note) and `checkins` (date, sleep_hours, workout_minutes). Approve it, add one expense (2026-11-22, Food, 18.5, Lunch) and one check-in (2026-11-22, 7.5 hours sleep, 40 workout minutes), then create a local web app in `apps/control-tower` connected to `tracker/dataset.json` via `app.publish.json` and `dohc-app-channel` that handles channel responses and renders results in the page, verify the frontend with `dohc_publish_app` `verifyFrontend`, and prepare, approve, and launch it locally.",
    expect: {
      calls: [
        { tool: "dohc_dataset", args: { "request.action": "invoke" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "verifyFrontend", "request.appRoot": "apps/control-tower" },
          ok: true,
        },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "prepareLocal", "request.appRoot": "apps/control-tower" },
          ok: true,
        },
        { tool: "dohc_publish_app", args: { "request.action": "approve" }, ok: true },
        { tool: "dohc_publish_app", args: { "request.action": "launchLocal" }, ok: true },
      ],
    },
    gradeRun: async (run) => {
      const inputFieldMap = (input: unknown): Record<string, unknown> => {
        if (!input || typeof input !== "object" || Array.isArray(input)) return {};
        const obj = input as Record<string, unknown>;
        const nested =
          obj.values && typeof obj.values === "object" && !Array.isArray(obj.values)
            ? (obj.values as Record<string, unknown>)
            : {};
        return { ...obj, ...nested };
      };
      const valueForField = (
        table: DatasetDefinition["tables"][number] | undefined,
        fields: Record<string, unknown>,
        pattern: RegExp,
      ): unknown => {
        const matchedField = table?.fields.find(
          (f) => f.type !== "button" && (pattern.test(f.name) || pattern.test(f.sqlColumn)),
        );
        if (matchedField && matchedField.type !== "button") {
          for (const key of [matchedField.fieldId, matchedField.sqlColumn, matchedField.name]) {
            if (Object.hasOwn(fields, key)) return fields[key];
          }
        }
        for (const [key, value] of Object.entries(fields)) {
          if (pattern.test(key)) return value;
        }
        return undefined;
      };
      const checks: Check[] = [
        checkDatasetJsonValid(run, "tracker/dataset.json"),
        checkAppPublishDataset(run, "apps/control-tower/app.publish.json", "tracker/dataset.json"),
      ];
      const appScripts = Object.entries(run.files).filter(
        ([path]) => path.startsWith("apps/control-tower/") && /\.(?:c|m)?[jt]sx?$/i.test(path),
      );
      const syntaxProblems = appScripts
        .map(([path, text]) => {
          const err = checkEvalScriptSyntax(text, path);
          return err ? `${path}: ${err}` : null;
        })
        .filter((x): x is string => x !== null);
      const appText = stripJsComments(
        Object.entries(run.files)
          .filter(
            ([path]) =>
              path.startsWith("apps/control-tower/") && !path.endsWith("app.publish.json"),
          )
          .map(([, text]) => text)
          .join("\n"),
      );
      const handlesPortResponses = /\.onmessage\b|addEventListener\s*\(\s*["']message["']/i.test(
        appText.replace(/window\.addEventListener\s*\(\s*["']message["']/gi, ""),
      );
      checks.push({
        name: "apps/control-tower connects to dohc-app-channel, calls backend.invoke, and handles responses",
        pass:
          syntaxProblems.length === 0 &&
          appText.includes("dohc-app-channel") &&
          appText.includes("backend.invoke") &&
          handlesPortResponses,
        ...(syntaxProblems.length > 0
          ? { detail: syntaxProblems.join("; ") }
          : handlesPortResponses
            ? {}
            : { detail: "missing port response handler" }),
      });
      checks.push(
        checkFrontendVerifiedForFinalSource(run, "apps/control-tower", (record) => {
          if (record.mode === "observed") {
            const observedBackend = record.brokerCalls.some(
              (c) => c.op === "backend.invoke" && c.ok,
            );
            const observedUi = (record.steps ?? []).some((s) => s.kind === "waitFor" && s.ok);
            if (!observedBackend || !observedUi) {
              return "observed verifyFrontend must record a passing backend.invoke call and waitFor step";
            }
            return null;
          }
          const requestedSteps = (record.requestedSteps ?? []) as Array<{
            kind?: string;
            expectBackend?: unknown;
          }>;
          const hasBackendCheck =
            (record.expectStartupBackend?.length ?? 0) > 0 ||
            requestedSteps.some((s) => s.kind === "click" && s.expectBackend !== undefined);
          const hasUiCheck = requestedSteps.some((s) => s.kind === "waitFor");
          if (!hasBackendCheck || !hasUiCheck) {
            return "verifyFrontend must check both a backend.invoke call and rendered UI";
          }
          return null;
        }),
      );
      let def: DatasetDefinition | undefined;
      try {
        def = parseDatasetDefinition(JSON.parse(run.files["tracker/dataset.json"] ?? ""));
      } catch {
        def = undefined;
      }
      const expenseTable = def?.tables.find((t) =>
        `${t.name} ${t.sqlName}`.toLowerCase().includes("expense"),
      );
      const checkinTable = def?.tables.find((t) => {
        const label = `${t.name} ${t.sqlName}`.toLowerCase();
        return (
          label.includes("checkin") || label.includes("check-in") || label.includes("check_in")
        );
      });
      const hasBothTables =
        expenseTable !== undefined &&
        checkinTable !== undefined &&
        expenseTable.tableId !== checkinTable.tableId;
      checks.push({
        name: "tracker/dataset.json declares both expenses and checkins tables",
        pass: hasBothTables,
        ...(hasBothTables
          ? {}
          : {
              detail: `tables: ${(def?.tables ?? []).map((t) => t.sqlName).join(", ") || "none"}`,
            }),
      });
      const opById = new Map((def?.operations ?? []).map((op) => [op.operationId, op]));
      const writeInvokes = run.calls
        .filter((c) => c.tool === "dohc_dataset" && c.ok)
        .map((c) => c.args.request as Record<string, unknown> | undefined)
        .filter((req): req is Record<string, unknown> => {
          if (req?.action !== "invoke" || typeof req.operationId !== "string") return false;
          const op = opById.get(req.operationId);
          return op !== undefined && !op.readOnly;
        });
      const expenseWrite = writeInvokes.find((req) => {
        const op = opById.get(String(req.operationId));
        if (!op || (expenseTable && op.tableId !== expenseTable.tableId)) return false;
        const fields = inputFieldMap(req.input);
        const category = valueForField(expenseTable, fields, /category/i);
        const amount = valueForField(expenseTable, fields, /amount/i);
        return (
          typeof category === "string" &&
          category.trim().toLowerCase() === "food" &&
          amount === 18.5
        );
      });
      const checkinWrite = writeInvokes.find((req) => {
        const op = opById.get(String(req.operationId));
        if (!op || (checkinTable && op.tableId !== checkinTable.tableId)) return false;
        const fields = inputFieldMap(req.input);
        const sleep = valueForField(checkinTable, fields, /sleep/i);
        const workout = valueForField(checkinTable, fields, /workout/i);
        return sleep === 7.5 && workout === 40;
      });
      let expensePersisted = false;
      let checkinPersisted = false;
      if (def) {
        const schemaSql = run.files[def.schemaPath];
        const opSource = run.files[def.operationsPath];
        if (schemaSql && opSource) {
          try {
            const compiled = await compileDatasetOperations(opSource, def.operationsPath);
            const tables = def.tables.map((t) => t.sqlName);
            const db0 = await initializeAppDatabase({ schemaSql, tables });
            if (expenseWrite) {
              const expOp = opById.get(String(expenseWrite.operationId))!;
              const afterExp = await evaluateAppOperation({
                database: db0,
                source: compiled,
                operation: expOp.name,
                caller: { kind: "owner" },
                input: (expenseWrite.input ?? {}) as JsonValue,
                nowMs: 1_760_000_000_000,
                requestId: "grade-exp-1",
                tables,
                readOnly: false,
              });
              expensePersisted = afterExp.changed;
            }
            if (checkinWrite) {
              const chkOp = opById.get(String(checkinWrite.operationId))!;
              const afterChk = await evaluateAppOperation({
                database: db0,
                source: compiled,
                operation: chkOp.name,
                caller: { kind: "owner" },
                input: (checkinWrite.input ?? {}) as JsonValue,
                nowMs: 1_760_000_001_000,
                requestId: "grade-chk-1",
                tables,
                readOnly: false,
              });
              checkinPersisted = afterChk.changed;
            }
          } catch {
            expensePersisted = false;
            checkinPersisted = false;
          }
        }
      }
      checks.push({
        name: "saved the expense (Food, 18.5) via an approved write operation",
        pass: expenseWrite !== undefined && expensePersisted,
        ...(expenseWrite && expensePersisted
          ? {}
          : {
              detail: `matched=${String(expenseWrite !== undefined)}, persisted=${String(expensePersisted)}`,
            }),
      });
      checks.push({
        name: "saved the check-in (7.5 sleep, 40 workout) via an approved write operation",
        pass: checkinWrite !== undefined && checkinPersisted,
        ...(checkinWrite && checkinPersisted
          ? {}
          : {
              detail: `matched=${String(checkinWrite !== undefined)}, persisted=${String(checkinPersisted)}`,
            }),
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
            '<!doctype html><html><body><h1>Control Tower</h1><section id="expenses-summary">Loading…</section><section id="checkins-summary"></section><script type="module" src="./app.js"></script></body></html>\n',
        });
        await callTool("dohc_write_file", {
          path: "apps/control-tower/app.js",
          content: [
            "let channelPort;",
            "const pending = new Map();",
            "function send(message) {",
            "  return new Promise((resolve, reject) => {",
            "    const id = crypto.randomUUID();",
            "    pending.set(id, { resolve, reject });",
            "    channelPort.postMessage({ id, ...message });",
            "  });",
            "}",
            'window.addEventListener("message", async (event) => {',
            '  if (channelPort || event.source !== window.parent || event.data?.kind !== "dohc-app-channel" || event.ports.length !== 1) return;',
            "  channelPort = event.ports[0];",
            "  channelPort.onmessage = ({ data }) => {",
            "    const req = pending.get(data?.id);",
            "    if (!req) return;",
            "    pending.delete(data.id);",
            '    if (data.ok) req.resolve(data.value); else req.reject(new Error(data.error?.message ?? "Request failed"));',
            "  };",
            "  channelPort.start();",
            '  const summary = document.getElementById("expenses-summary");',
            "  try {",
            '    const { result } = await send({ op: "backend.invoke", operation: "listExpenses", input: {}, idempotencyKey: crypto.randomUUID() });',
            "    const rows = Array.isArray(result?.rows) ? result.rows : [];",
            "    if (summary) summary.textContent = `Expenses loaded: ${rows.length}`;",
            "  } catch (error) {",
            "    if (summary) summary.textContent = error instanceof Error ? error.message : String(error);",
            "  }",
            "});",
            "",
          ].join("\n"),
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
        await callTool("dohc_publish_app", {
          request: {
            action: "verifyFrontend",
            workspaceId: WS,
            appRoot: "apps/control-tower",
            expectStartupBackend: [
              { op: "backend.invoke", operation: "listExpenses", status: 200 },
            ],
            steps: [{ kind: "waitFor", selector: "#expenses-summary" }],
          },
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
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
      notCalls: [
        { tool: "dohc_write_file", args: { path: "~.md" } },
        { tool: "Write", args: { file_path: "~.md" } },
        { tool: "Edit", args: { file_path: "~.md" } },
      ],
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
    prompt:
      'I run a weekend pottery workshop with 8 seats. Create a transactional Collection in `workshop/` (`dataset.json`, `schema.sql`, `backend.ts`) with a `bookings` table (`id`, `name`, `seats`), a public `bookSeat` operation (`access: "link"`) taking `{ name, seats }` that refuses via `ctx.refuse` when total seats would exceed 8, and an owner-only `listBookings` read. Prepare and approve the Collection, build `apps/booking` with `app.publish.json` exposing ONLY `bookSeat` (never `listBookings`), verify the frontend end to end with `dohc_publish_app` `verifyFrontend` (including submitting a booking and confirming UI feedback), create a share link, and prepare and approve the shared publication.',
    expect: {
      calls: [
        { tool: "dohc_dataset", args: { "request.action": "prepare" }, ok: true },
        { tool: "dohc_dataset", args: { "request.action": "approve" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "verifyFrontend", "request.appRoot": "apps/booking" },
          ok: true,
        },
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
    gradeRun: async (run) => {
      const checks: Check[] = [checkDatasetJsonValid(run, "workshop/dataset.json")];
      let def: DatasetDefinition | undefined;
      let bookOpId: string | undefined;
      let listOpId: string | undefined;
      try {
        def = parseDatasetDefinition(JSON.parse(run.files["workshop/dataset.json"] ?? ""));
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
      if (def) {
        const schemaSql = run.files[def.schemaPath];
        const opSource = run.files[def.operationsPath];
        if (!schemaSql || !opSource) {
          checks.push({
            name: "bookSeat enforces 8-seat capacity across multiple booking sequences",
            pass: false,
            detail: "missing schema or operations file",
          });
        } else {
          try {
            const compiled = await compileDatasetOperations(opSource, def.operationsPath);
            const tables = def.tables.map((t) => t.sqlName);
            const db0 = await initializeAppDatabase({ schemaSql, tables });
            const book = (database: Uint8Array, name: string, seats: number, requestId: string) =>
              evaluateAppOperation({
                database,
                source: compiled,
                operation: "bookSeat",
                caller: { kind: "link", shareId: "s1", grantId: "g1" },
                input: { name, seats },
                nowMs: 1_760_000_000_000,
                requestId,
                tables,
                readOnly: false,
              });
            const expectRefused = async (
              database: Uint8Array,
              name: string,
              seats: number,
              requestId: string,
            ): Promise<boolean> => {
              try {
                await book(database, name, seats, requestId);
                return false;
              } catch (error) {
                return isAppBackendRuntimeError(error);
              }
            };
            const refusedEmptyOverCap = await expectRefused(db0, "Oversize", 9, "book-0");
            const first = await book(db0, "Alice", 5, "book-1");
            const refusedOverCap = await expectRefused(first.database, "Bob", 4, "book-2");
            const exactCap = await book(first.database, "Cara", 3, "book-3");
            const refusedAfterFull = await expectRefused(exactCap.database, "Dan", 1, "book-4");

            const fourFirst = await book(db0, "Solo", 4, "book-5");
            const fourSecond = await book(fourFirst.database, "Pair", 4, "book-6");
            const refusedAfterPairs = await expectRefused(
              fourSecond.database,
              "Extra",
              1,
              "book-7",
            );

            const passed =
              refusedEmptyOverCap &&
              first.changed &&
              refusedOverCap &&
              exactCap.changed &&
              refusedAfterFull &&
              fourFirst.changed &&
              fourSecond.changed &&
              refusedAfterPairs;
            checks.push({
              name: "bookSeat enforces 8-seat capacity across multiple booking sequences",
              pass: passed,
              ...(passed
                ? {}
                : {
                    detail: `0+9ref=${String(refusedEmptyOverCap)}, 5+4ref=${String(refusedOverCap)}, 5+3ok=${String(exactCap.changed)}, 8+1ref=${String(refusedAfterFull)}, 4+4ok=${String(fourFirst.changed && fourSecond.changed)}, pairsFullRef=${String(refusedAfterPairs)}`,
                  }),
            });
          } catch (error) {
            checks.push({
              name: "bookSeat enforces 8-seat capacity across multiple booking sequences",
              pass: false,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      checks.push(
        checkAppPublishDataset(
          run,
          "apps/booking/app.publish.json",
          "workshop/dataset.json",
          (ref) => {
            const operationIds = referencedOperationIds(ref, def);
            if (!bookOpId || !operationIds.includes(bookOpId))
              return "missing bookSeat operationId";
            if (listOpId && operationIds.includes(listOpId))
              return "must not expose owner-only listBookings";
            return null;
          },
        ),
      );
      checks.push(
        (() => {
          const checkName =
            "apps/booking frontend provides booking controls wired to dohc-app-channel bookSeat";
          const rawManifest = run.files["apps/booking/app.publish.json"];
          if (!rawManifest)
            return { name: checkName, pass: false, detail: "missing app.publish.json" };
          let entryPath: string;
          let inputs: string[];
          try {
            const manifest = JSON.parse(rawManifest) as {
              entryPath?: unknown;
              inputs?: unknown;
            };
            entryPath = typeof manifest.entryPath === "string" ? manifest.entryPath : "";
            inputs = Array.isArray(manifest.inputs)
              ? manifest.inputs.filter((item): item is string => typeof item === "string")
              : [];
          } catch {
            return { name: checkName, pass: false, detail: "invalid app.publish.json" };
          }
          const problems: string[] = [];
          if (!entryPath || !inputs.includes(entryPath)) {
            problems.push("entryPath must be listed in inputs");
          }
          for (const item of inputs) {
            const rel = `apps/booking/${item.replace(/^\.\//, "")}`;
            if (run.files[rel] === undefined) problems.push(`missing listed input ${item}`);
          }
          const entryHtml = run.files[`apps/booking/${entryPath.replace(/^\.\//, "")}`] ?? "";
          const hasSubmitControl =
            /<form\b/i.test(entryHtml) ||
            /<button\b/i.test(entryHtml) ||
            /type\s*=\s*["']submit["']/i.test(entryHtml);
          const inputControlCount = (entryHtml.match(/<(?:input|select|textarea)\b/gi) ?? [])
            .length;
          if (!hasSubmitControl) problems.push("entry HTML has no form or submit button");
          if (inputControlCount < 2) {
            problems.push(`entry HTML needs name and seats inputs (found ${inputControlCount})`);
          }
          if (!/\bname\b/i.test(entryHtml) || !/\bseats?\b/i.test(entryHtml)) {
            problems.push("entry HTML controls do not reference guest name and seats");
          }
          const normalizedInputs = new Set(inputs.map((item) => item.replace(/^\.\//, "")));
          const scriptParts: string[] = [];
          for (const match of entryHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
            const attrs = match[1] ?? "";
            const body = match[2] ?? "";
            if (!isEvalExecutableScriptTag(attrs)) continue;
            const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
            if (srcMatch?.[1]) {
              const rawSrc = srcMatch[1].trim();
              if (!/^(?:https?:|data:|blob:)/i.test(rawSrc)) {
                const cleanSrc = rawSrc.replace(/[?#].*$/, "").replace(/^\.\//, "");
                if (!normalizedInputs.has(cleanSrc)) {
                  problems.push(`script src "${rawSrc}" is not listed in app.publish.json inputs`);
                } else {
                  const scriptFile = run.files[`apps/booking/${cleanSrc}`];
                  if (scriptFile) scriptParts.push(scriptFile);
                }
              }
            } else if (body.trim()) {
              const syntaxErr = checkEvalScriptSyntax(body, entryPath);
              if (syntaxErr)
                problems.push(`syntax error in apps/booking/${entryPath}: ${syntaxErr}`);
              scriptParts.push(body);
            }
          }
          for (const item of normalizedInputs) {
            if (/\.(?:c|m)?[jt]sx?$/i.test(item)) {
              const content = run.files[`apps/booking/${item}`];
              if (content) {
                const syntaxErr = checkEvalScriptSyntax(content, item);
                if (syntaxErr) problems.push(`syntax error in apps/booking/${item}: ${syntaxErr}`);
                if (!scriptParts.includes(content)) scriptParts.push(content);
              }
            }
          }
          const scriptText = stripJsComments(scriptParts.join("\n"));
          if (!scriptText.trim()) {
            problems.push("no published frontend script found");
          } else {
            if (!scriptText.includes("dohc-app-channel") || !/\bports\b/.test(scriptText)) {
              problems.push("frontend script does not receive dohc-app-channel MessagePort");
            }
            if (!scriptText.includes("backend.invoke") || !scriptText.includes("bookSeat")) {
              problems.push("frontend script does not call backend.invoke for bookSeat");
            }
            if (!scriptText.includes("idempotencyKey")) {
              problems.push("frontend script omits idempotencyKey on backend.invoke");
            }
            if (!/(?:addEventListener|onsubmit|onclick)/i.test(scriptText)) {
              problems.push("frontend script wires no submit or click handler");
            }
            if (
              !/\.onmessage\b|addEventListener\s*\(\s*["']message["']/i.test(
                scriptText.replace(/window\.addEventListener\s*\(\s*["']message["']/gi, ""),
              )
            ) {
              problems.push("frontend script does not handle dohc-app-channel responses");
            }
            if (!/\bname\b/.test(scriptText) || !/\bseats\b/.test(scriptText)) {
              problems.push("frontend script does not pass name and seats inputs");
            }
            if (scriptText.includes("listBookings")) {
              problems.push("public booking frontend must not call owner-only listBookings");
            }
          }
          return {
            name: checkName,
            pass: problems.length === 0,
            ...(problems.length > 0 ? { detail: problems.join("; ") } : {}),
          };
        })(),
      );
      checks.push(
        checkFrontendVerifiedForFinalSource(run, "apps/booking", (record) => {
          if (record.mode === "observed") {
            const observedBook = record.brokerCalls.some(
              (c) => c.op === "backend.invoke" && c.operation === "bookSeat" && c.ok,
            );
            const observedUi = (record.steps ?? []).some((s) => s.kind === "waitFor" && s.ok);
            if (!observedBook || !observedUi) {
              return "observed verifyFrontend must record a passing bookSeat call and waitFor step";
            }
            return null;
          }
          const steps = (record.requestedSteps ?? []) as Array<{
            kind?: string;
            expectBackend?: { operation?: string };
          }>;
          const clickedBackend = steps.some(
            (s) => s.kind === "click" && s.expectBackend?.operation === "bookSeat",
          );
          const waitedUi = steps.some((s) => s.kind === "waitFor");
          if (!clickedBackend || !waitedUi) {
            return "verifyFrontend must submit bookSeat via click.expectBackend and verify UI with waitFor";
          }
          return null;
        }),
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
          content: [
            "<!doctype html>",
            "<html>",
            "<body>",
            "  <h1>Pottery Workshop</h1>",
            '  <form id="booking-form">',
            '    <label>Name <input id="guest-name" name="name" type="text" required /></label>',
            '    <label>Seats <input id="seat-count" name="seats" type="number" min="1" max="8" value="1" required /></label>',
            '    <button type="submit">Book seats</button>',
            "  </form>",
            '  <p id="status" role="status"></p>',
            '  <script type="module" src="./app.js"></script>',
            "</body>",
            "</html>",
            "",
          ].join("\n"),
        });
        await callTool("dohc_write_file", {
          path: "apps/booking/app.js",
          content: [
            "let channelPort;",
            "const pending = new Map();",
            "const queue = [];",
            "function send(message) {",
            "  return new Promise((resolve, reject) => {",
            "    const id = crypto.randomUUID();",
            "    const frame = { id, ...message };",
            "    pending.set(id, { resolve, reject });",
            "    if (channelPort) channelPort.postMessage(frame);",
            "    else queue.push(frame);",
            "  });",
            "}",
            'window.addEventListener("message", (event) => {',
            '  if (channelPort || event.source !== window.parent || event.data?.kind !== "dohc-app-channel" || event.data?.version !== 1 || event.ports.length !== 1) return;',
            "  channelPort = event.ports[0];",
            "  channelPort.onmessage = ({ data }) => {",
            "    const req = pending.get(data?.id);",
            "    if (!req) return;",
            "    pending.delete(data.id);",
            '    if (data.ok) req.resolve(data.value); else req.reject(new Error(data.error?.message ?? "Booking failed"));',
            "  };",
            "  channelPort.start();",
            "  while (queue.length) channelPort.postMessage(queue.shift());",
            "});",
            'const form = document.getElementById("booking-form");',
            'const statusEl = document.getElementById("status");',
            'form?.addEventListener("submit", async (event) => {',
            "  event.preventDefault();",
            "  const data = new FormData(form);",
            '  const name = String(data.get("name") ?? "").trim();',
            '  const seats = Number(data.get("seats") ?? 1);',
            "  try {",
            '    await send({ op: "backend.invoke", operation: "bookSeat", input: { name, seats }, idempotencyKey: crypto.randomUUID() });',
            '    if (statusEl) statusEl.textContent = "Booked!";',
            "  } catch (error) {",
            "    if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);",
            "  }",
            "});",
            "",
          ].join("\n"),
        });
        await callTool("dohc_write_file", {
          path: "apps/booking/app.publish.json",
          content:
            JSON.stringify(
              {
                version: 1,
                entryPath: "index.html",
                inputs: ["index.html", "app.js"],
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
        await callTool("dohc_publish_app", {
          request: {
            action: "verifyFrontend",
            workspaceId: WS,
            appRoot: "apps/booking",
            steps: [
              { kind: "fill", selector: "#guest-name", value: "Ada" },
              { kind: "fill", selector: "#seat-count", value: "5" },
              {
                kind: "click",
                selector: 'button[type="submit"]',
                expectBackend: { op: "backend.invoke", operation: "bookSeat", status: 200 },
              },
              { kind: "waitFor", selector: "#status", textIncludes: "Booked" },
              { kind: "fill", selector: "#guest-name", value: "Bob" },
              { kind: "fill", selector: "#seat-count", value: "4" },
              {
                kind: "click",
                selector: 'button[type="submit"]',
                expectBackend: {
                  op: "backend.invoke",
                  operation: "bookSeat",
                  status: 409,
                  refusalCode: "workshop_full",
                },
              },
              { kind: "waitFor", selector: "#status", textIncludes: "8" },
            ],
          },
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
    setupDesktop: (root, options) =>
      createEverydayDesktop(
        root,
        {
          workspaceId: WS,
          datasets: [
            {
              datasetPath: "clients/dataset.json",
              generated: true,
              seedInvocations: [
                {
                  operationId: uuid("c1000000", 7),
                  input: {
                    values: {
                      [uuid("c1000000", 4)]: "Ava",
                      [uuid("c1000000", 5)]: "ava@example.com",
                    },
                  },
                },
                {
                  operationId: uuid("c1000000", 7),
                  input: {
                    values: {
                      [uuid("c1000000", 4)]: "Ben",
                      [uuid("c1000000", 5)]: "ben@example.com",
                    },
                  },
                },
                {
                  operationId: uuid("c1000000", 7),
                  input: {
                    values: {
                      [uuid("c1000000", 4)]: "Cam",
                      [uuid("c1000000", 5)]: "cam@example.com",
                    },
                  },
                },
              ],
            },
          ],
          localPublications: [
            {
              appRoot: "apps/client-portal",
              publicationId: sha256("seed-client-portal-v1"),
              sourceRevision: sha256("seed-client-portal-src"),
              capabilities: [CLIENTS_PORTAL_CAPABILITY],
            },
          ],
        },
        options,
      ),
    prompt:
      'Add a required select field called "Tier" (options: "Standard", "VIP", default: "Standard") to the Clients Collection (`clients/dataset.json`) safely without losing the 3 existing client records. Then remove the stale `revision`/`revisionSha256` pin from `apps/client-portal/app.publish.json` and prepare and approve `apps/client-portal` locally.',
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
    gradeRun: async (run) => {
      const checks: Check[] = [checkDatasetJsonValid(run, "clients/dataset.json")];
      let def: DatasetDefinition | undefined;
      try {
        def = parseDatasetDefinition(JSON.parse(run.files["clients/dataset.json"] ?? ""));
      } catch {
        def = undefined;
      }
      const clientsTable = def?.tables.find(
        (t) => t.tableId === uuid("c1000000", 2) || t.sqlName === "clients",
      );
      const tierField = clientsTable?.fields.find(
        (f) => f.type !== "button" && f.name.trim().toLowerCase() === "tier",
      );
      const tierValid =
        tierField !== undefined &&
        tierField.type === "select" &&
        tierField.required === true &&
        Array.isArray(tierField.options) &&
        tierField.options.length === 2 &&
        tierField.options.includes("Standard") &&
        tierField.options.includes("VIP") &&
        tierField.default === "Standard";
      checks.push({
        name: 'clients/dataset.json defines required select field "Tier" (Standard, VIP; default Standard)',
        pass: tierValid,
        ...(tierValid
          ? {}
          : {
              detail: tierField
                ? `found Tier field with type=${tierField.type}, required=${String("required" in tierField ? tierField.required : false)}, options=${JSON.stringify("options" in tierField ? tierField.options : undefined)}, default=${JSON.stringify("default" in tierField ? tierField.default : undefined)}`
                : "missing Tier field on Clients table",
            }),
      });
      const snapshot = run.datasetSnapshots?.["clients/dataset.json"];
      checks.push(
        checkAppPublishDataset(
          run,
          "apps/client-portal/app.publish.json",
          "clients/dataset.json",
          (ref) =>
            ref.revision === undefined && ref.revisionSha256 === undefined
              ? null
              : `manifest still pins revision ${ref.revision}; remove revision and revisionSha256`,
        ),
      );
      const portalApproved = Boolean(
        snapshot?.boundApps?.some(
          (app) =>
            app.scope === "local" &&
            app.appRoot === "apps/client-portal" &&
            app.status === "compatible" &&
            app.pinnedRevision === snapshot.revision,
        ),
      );
      checks.push({
        name: "apps/client-portal is approved on the migrated Clients revision",
        pass: portalApproved,
      });
      const recordsCheckName =
        'all 3 seeded client records survive migration with Tier = "Standard"';
      if (!snapshot || !def || !clientsTable || !tierField || tierField.type === "button") {
        checks.push({
          name: recordsCheckName,
          pass: false,
          detail: !snapshot ? "missing migrated dataset snapshot" : "missing valid Tier field",
        });
      } else {
        const opSource = run.files[def.operationsPath];
        const readOp =
          def.operations.find((o) => o.operationId === uuid("c1000000", 6)) ??
          def.operations.find((o) => o.kind === "read" && o.tableId === clientsTable.tableId);
        if (!opSource || !readOp) {
          checks.push({
            name: recordsCheckName,
            pass: false,
            detail: "missing operations file or listClients read operation",
          });
        } else {
          try {
            const compiled = await compileDatasetOperations(opSource, def.operationsPath);
            const evaluated = await evaluateAppOperation({
              database: new Uint8Array(Buffer.from(snapshot.databaseBase64, "base64")),
              source: compiled,
              operation: readOp.name,
              caller: { kind: "owner" },
              input: {},
              nowMs: 1_760_000_000_000,
              requestId: "grade-clients-read",
              tables: def.tables.map((t) => t.sqlName),
              readOnly: true,
            });
            const resultObj =
              evaluated.result && typeof evaluated.result === "object"
                ? (evaluated.result as { rows?: unknown })
                : undefined;
            const rows = Array.isArray(resultObj?.rows) ? resultObj.rows : [];
            const nameFieldId = uuid("c1000000", 4);
            const emailFieldId = uuid("c1000000", 5);
            const readCell = (row: unknown, fieldId: string, colName: string): unknown => {
              if (!row || typeof row !== "object") return undefined;
              const obj = row as Record<string, unknown>;
              if (obj.values && typeof obj.values === "object" && !Array.isArray(obj.values)) {
                const values = obj.values as Record<string, unknown>;
                if (Object.hasOwn(values, fieldId)) return values[fieldId];
                if (Object.hasOwn(values, colName)) return values[colName];
              }
              return obj[colName] ?? obj[fieldId];
            };
            const extracted = rows.map((row) => ({
              name: readCell(row, nameFieldId, "name"),
              email: readCell(row, emailFieldId, "email"),
              tier: readCell(row, tierField.fieldId, tierField.sqlColumn),
            }));
            const expectedClients = [
              { name: "Ava", email: "ava@example.com" },
              { name: "Ben", email: "ben@example.com" },
              { name: "Cam", email: "cam@example.com" },
            ];
            const allSurvived =
              extracted.length === expectedClients.length &&
              expectedClients.every((want) =>
                extracted.some(
                  (got) =>
                    got.name === want.name && got.email === want.email && got.tier === "Standard",
                ),
              );
            checks.push({
              name: recordsCheckName,
              pass: allSurvived,
              ...(allSurvived ? {} : { detail: `rows=${JSON.stringify(extracted)}` }),
            });
          } catch (error) {
            checks.push({
              name: recordsCheckName,
              pass: false,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return checks;
    },
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
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
      notCalls: [
        "dohc_write_file",
        { tool: "Write", args: { file_path: "pricing.md" } },
        { tool: "Edit", args: { file_path: "pricing.md" } },
      ],
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
    setupDesktop: (root, options) =>
      createEverydayDesktop(
        root,
        {
          workspaceId: WS,
          datasets: [{ datasetPath: "events/dataset.json", generated: true }],
        },
        options,
      ),
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
    gradeRun: (run) => {
      let approvedDef: DatasetDefinition | undefined;
      try {
        approvedDef = parseDatasetDefinition(JSON.parse(run.files["events/dataset.json"] ?? ""));
      } catch {
        approvedDef = undefined;
      }
      const approvedById = new Map((approvedDef?.operations ?? []).map((o) => [o.operationId, o]));
      const validChoiceOps = new Set(
        (approvedDef?.operations ?? [])
          .filter(
            (o) =>
              o.kind === "read" &&
              o.access === "link" &&
              o.tableId === uuid("e2000000", 2) &&
              o.fieldIds.length === 2 &&
              o.fieldIds.includes(uuid("e2000000", 3)) &&
              o.fieldIds.includes(uuid("e2000000", 4)) &&
              !o.fieldIds.includes(uuid("e2000000", 5)),
          )
          .map((o) => o.operationId),
      );
      return [
        checkDatasetJsonValid(run, "events/dataset.json"),
        checkAppPublishDataset(
          run,
          "apps/signup-form/app.publish.json",
          "events/dataset.json",
          (ref) => {
            const { revision, revisionSha256 } = ref;
            if (revision !== undefined && revisionSha256 !== undefined) {
              if (revision < 2) {
                return `manifest still pinned to stale revision ${revision}`;
              }
              if (approvedDef) {
                const schemaSql = run.files[approvedDef.schemaPath];
                const opSource = run.files[approvedDef.operationsPath];
                if (schemaSql !== undefined && opSource !== undefined) {
                  const expectedRevSha = sha256(
                    datasetRevisionDigestContent({
                      datasetId: approvedDef.datasetId,
                      revision,
                      revisionSha256: "0".repeat(64),
                      definitionSha256: sha256(datasetDefinitionDigestContent(approvedDef)),
                      schemaSha256: sha256(schemaSql),
                      operationsSha256: sha256(opSource),
                      definition: approvedDef,
                    }),
                  );
                  const expectedRevShaTrimmed = sha256(
                    datasetRevisionDigestContent({
                      datasetId: approvedDef.datasetId,
                      revision,
                      revisionSha256: "0".repeat(64),
                      definitionSha256: sha256(datasetDefinitionDigestContent(approvedDef)),
                      schemaSha256: sha256(schemaSql),
                      operationsSha256: sha256(opSource.replace(/\n$/, "")),
                      definition: approvedDef,
                    }),
                  );
                  if (
                    revisionSha256 !== expectedRevSha &&
                    revisionSha256 !== expectedRevShaTrimmed
                  ) {
                    return "manifest revisionSha256 does not match approved events/dataset.json";
                  }
                }
              }
            }
            const operationIds = referencedOperationIds(ref, approvedDef);
            if (operationIds.includes(uuid("e2000000", 10))) {
              return "leaked private owner readSessions operation";
            }
            if (!operationIds.includes(uuid("e2000000", 11))) {
              return "missing createSignup operation";
            }
            const unknownOp = operationIds.find((opId) => !approvedById.has(opId));
            if (unknownOp) {
              return `operationId ${unknownOp} is not in approved events/dataset.json`;
            }
            if (!operationIds.some((opId) => validChoiceOps.has(opId))) {
              return "missing approved Title-only Sessions relation-choices read operation";
            }
            return null;
          },
        ),
      ];
    },
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
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
      notCalls: [
        { tool: "dohc_write_file", args: { path: "reports/sales-summary.md" } },
        { tool: "Write", args: { file_path: "reports/sales-summary.md" } },
        { tool: "Edit", args: { file_path: "reports/sales-summary.md" } },
      ],
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
    setupDesktop: (root, options) => createEverydayDesktop(root, { workspaceId: WS }, options),
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
  {
    id: "everyday-bound-app-migration-drift",
    suite: "everyday",
    kind: "everyday",
    experience:
      "After a standalone Collection migration, boundApps in migration-prepared and permissions names affected local and share-link apps so modern unpinned manifests can be re-approved cleanly without editing app.publish.json or widening share-link access.",
    source: "everyday-job-4",
    workspaceId: WS,
    files: {
      "fundraiser/dataset.json": JSON.stringify(PLEDGES_DEF, null, 2) + "\n",
      "fundraiser/schema.sql": PLEDGES_SCHEMA,
      "fundraiser/operations.js": PLEDGES_OPS,
      "apps/organizer/index.html": "<!doctype html><h1>Pledges</h1>\n",
      "apps/organizer/app.publish.json":
        JSON.stringify(
          {
            version: 1,
            entryPath: "index.html",
            dataset: {
              kind: "dataset",
              datasetPath: "fundraiser/dataset.json",
              operations: ["listPledges"],
            },
          },
          null,
          2,
        ) + "\n",
      "apps/pledge-form/index.html": "<!doctype html><h1>Pledge form</h1>\n",
      "apps/pledge-form/app.publish.json":
        JSON.stringify(
          {
            version: 1,
            entryPath: "index.html",
            inputs: ["index.html"],
            packageMap: {},
            dataset: {
              kind: "dataset",
              datasetPath: "fundraiser/dataset.json",
              operationIds: [uuid("f5000000", 7)],
              createFields: [
                {
                  operationId: uuid("f5000000", 7),
                  fieldIds: [uuid("f5000000", 4), uuid("f5000000", 5)],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
    },
    setupDesktop: (root, options) =>
      createEverydayDesktop(
        root,
        {
          workspaceId: WS,
          datasets: [{ datasetPath: "fundraiser/dataset.json", generated: true }],
          links: [
            {
              shareId: "share_pledge",
              grantId: "grant_pledge",
              paths: ["apps/pledge-form"],
              access: "view",
            },
          ],
          localPublications: [
            {
              appRoot: "apps/organizer",
              publicationId: sha256("seed-organizer-v1"),
              sourceRevision: sha256("seed-organizer-src"),
              capabilities: [PLEDGES_ORGANIZER_CAP],
            },
          ],
          shareLinkPublications: [
            {
              appRoot: "apps/pledge-form",
              publicationId: sha256("seed-pledge-form-v1"),
              sourceRevision: sha256("seed-pledge-form-src"),
              shareId: "share_pledge",
              grantId: "grant_pledge",
              capabilities: [PLEDGES_FORM_CAP],
            },
          ],
        },
        options,
      ),
    prompt:
      'Add an optional text field called "Notes" to the Fundraiser Pledges Collection (`fundraiser/dataset.json`). Check which connected apps are affected by the change, re-approve every affected app (both local and share-link, keeping share-link permissions strictly limited to public pledge creation), and check `permissions` afterward.',
    expect: {
      calls: [
        { tool: "dohc_dataset", args: { "request.action": "prepareSchemaChange" }, ok: true },
        { tool: "dohc_dataset", args: { "request.action": "approveMigration" }, ok: true },
        {
          tool: "dohc_publish_app",
          args: { "request.action": "prepareLocal", "request.appRoot": "apps/organizer" },
          ok: true,
        },
        {
          tool: "dohc_publish_app",
          args: {
            "request.action": "prepare",
            "request.appRoot": "apps/pledge-form",
            "request.shareId": "share_pledge",
            "request.grantId": "grant_pledge",
          },
          ok: true,
        },
        { tool: "dohc_publish_app", args: { "request.action": "approve" }, ok: true },
        {
          tool: "dohc_dataset",
          args: {
            "request.action": "permissions",
            "request.datasetPath": "fundraiser/dataset.json",
          },
          ok: true,
        },
      ],
    },
    gradeRun: (run) => {
      const checks: Check[] = [checkDatasetJsonValid(run, "fundraiser/dataset.json")];
      let def: DatasetDefinition | undefined;
      try {
        def = parseDatasetDefinition(JSON.parse(run.files["fundraiser/dataset.json"] ?? ""));
      } catch {
        def = undefined;
      }
      const hasNotes = Boolean(
        def?.tables
          .find((t) => t.tableId === uuid("f5000000", 2))
          ?.fields.find(
            (f) =>
              f.type === "text" && f.required === false && f.name.trim().toLowerCase() === "notes",
          ),
      );
      checks.push({
        name: 'fundraiser/dataset.json adds optional text field "Notes"',
        pass: hasNotes,
      });
      checks.push(
        checkAppPublishDataset(
          run,
          "apps/organizer/app.publish.json",
          "fundraiser/dataset.json",
          (ref) =>
            referencedOperationIds(ref, def).includes(uuid("f5000000", 6))
              ? null
              : "missing listPledges operation",
        ),
      );
      checks.push(
        checkAppPublishDataset(
          run,
          "apps/pledge-form/app.publish.json",
          "fundraiser/dataset.json",
          (ref) => {
            const ops = referencedOperationIds(ref, def);
            if (ops.includes(uuid("f5000000", 6))) {
              return "leaked owner-only listPledges operation into public form";
            }
            if (!ops.includes(uuid("f5000000", 7))) {
              return "missing public createPledge operation";
            }
            return null;
          },
        ),
      );
      const snapshot = run.datasetSnapshots?.["fundraiser/dataset.json"];
      const organizerCurrent = Boolean(
        snapshot?.boundApps?.some(
          (app) =>
            app.scope === "local" &&
            app.appRoot === "apps/organizer" &&
            app.status === "compatible" &&
            app.pinnedRevision === snapshot.revision,
        ),
      );
      const formCurrent = Boolean(
        snapshot?.boundApps?.some(
          (app) =>
            app.scope === "link" &&
            app.appRoot === "apps/pledge-form" &&
            app.status === "compatible" &&
            app.pinnedRevision === snapshot.revision,
        ),
      );
      checks.push({
        name: "apps/organizer local publication is approved on the migrated revision",
        pass: organizerCurrent,
      });
      checks.push({
        name: "apps/pledge-form share-link publication is approved on the migrated revision",
        pass: formCurrent,
      });
      return checks;
    },
    solution: {
      run: async (callTool) => {
        const described = (await callTool("dohc_dataset", {
          request: { action: "describe", workspaceId: WS, datasetPath: "fundraiser/dataset.json" },
        })) as { dataset: { revision: number; revisionSha256: string } };
        const prep = (await callTool("dohc_dataset", {
          request: {
            action: "prepareSchemaChange",
            workspaceId: WS,
            datasetPath: "fundraiser/dataset.json",
            revision: described.dataset.revision,
            revisionSha256: described.dataset.revisionSha256,
            change: {
              kind: "addField",
              tableId: uuid("f5000000", 2),
              field: {
                name: "Notes",
                type: "text",
                required: false,
                unique: false,
              },
            },
          },
        })) as {
          preparationId: string;
          approvalDigest: string;
          revision: { revision: number; revisionSha256: string };
          boundApps?: Array<{
            scope: "local" | "link";
            appRoot: string;
            shareId?: string;
            grantId?: string;
            status: string;
          }>;
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
        for (const app of prep.boundApps ?? []) {
          if (app.status === "compatible") continue;
          const preparedApp = (await callTool("dohc_publish_app", {
            request:
              app.scope === "local"
                ? { action: "prepareLocal", workspaceId: WS, appRoot: app.appRoot }
                : {
                    action: "prepare",
                    workspaceId: WS,
                    appRoot: app.appRoot,
                    shareId: app.shareId!,
                    grantId: app.grantId!,
                  },
          })) as { approvalId: string; candidateDigest: string };
          await callTool("dohc_publish_app", {
            request: {
              action: "approve",
              workspaceId: WS,
              approvalId: preparedApp.approvalId,
              candidateDigest: preparedApp.candidateDigest,
            },
          });
        }
        await callTool("dohc_dataset", {
          request: {
            action: "permissions",
            workspaceId: WS,
            datasetPath: "fundraiser/dataset.json",
          },
        });
      },
    },
  },
];
