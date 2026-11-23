import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, posix } from "node:path";
import { Script, createContext } from "node:vm";
import {
  datasetColumnFields,
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  describeApprovedDataset,
  parseAppDatasetReference,
  parseDatasetDefinition,
  type AppDatasetBinding,
  type DatasetDefinition,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { automationDefinitionList } from "@dohc/workspace-contracts/automation-controls";
import { fileVersionError } from "@dohc/workspace-contracts/file-version";
import type { DatasetRequest, DatasetSchemaChange } from "@dohc/cli/dataset";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import type { DesktopAnswer } from "./case";
import { workspaceVerbs } from "./desktop";

type Args = Record<string, unknown>;
type SqlParam = string | number | null;
interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: SqlParam[]): Record<string, unknown>[];
    run(...params: SqlParam[]): { changes: number | bigint };
  };
  close(): void;
}
type NodeSqliteModule = { DatabaseSync: new (path: string) => NodeSqliteDatabase };

const require = createRequire(import.meta.url);
const AT = 1_760_000_000_000;

function openMemorySqlite(): NodeSqliteDatabase {
  const mod = require("node:sqlite") as NodeSqliteModule;
  return new mod.DatabaseSync(":memory:");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readWorkspaceText(root: string, relPath: string): string | null {
  const full = join(root, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

function writeWorkspaceText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlColumnType(type: string): string {
  if (type === "number") return "REAL";
  if (type === "checkbox") return "INTEGER";
  return "TEXT";
}

function generateSchemaSql(definition: DatasetDefinition): string {
  return definition.tables
    .map((table) => {
      const cols = datasetColumnFields(table).map((field) => {
        const parts = [sqlIdent(field.sqlColumn), sqlColumnType(field.type)];
        if (field.sqlColumn === table.primaryKey) parts.push("PRIMARY KEY");
        if (field.required) parts.push("NOT NULL");
        if (field.unique && field.sqlColumn !== table.primaryKey) parts.push("UNIQUE");
        return `  ${parts.join(" ")}`;
      });
      if (!datasetColumnFields(table).some((field) => field.sqlColumn === "_record_version")) {
        cols.push('  "_record_version" INTEGER NOT NULL DEFAULT 1');
      }
      return `CREATE TABLE ${sqlIdent(table.sqlName)} (\n${cols.join(",\n")}\n);`;
    })
    .join("\n\n");
}

class GuestRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type OperationsMap = Record<string, (ctx: unknown, input: unknown) => unknown>;

function compileOperationsForEval(source: string, path: string): OperationsMap {
  if (/\b(?:import|export)\b/.test(source) || /\brequire\s*\(/.test(source)) {
    throw new Error("Collection actions cannot import modules or use require.");
  }
  const js = path.endsWith(".ts") ? stripTypeScriptTypes(source, { mode: "strip" }) : source;
  const sandbox: Record<string, unknown> = {
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  };
  sandbox.globalThis = sandbox;
  const script = new Script(js, { filename: path });
  script.runInContext(createContext(sandbox), { timeout: 1_000 });
  const operations = sandbox.operations;
  if (!operations || typeof operations !== "object") {
    throw new Error(`${path} must assign operation functions to globalThis.operations = { ... }.`);
  }
  return operations as OperationsMap;
}

interface StoredDataset {
  datasetPath: string;
  revision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
  operations: OperationsMap;
  db: NodeSqliteDatabase;
  generated: boolean;
  dataRevision: number;
  idempotency: Map<string, { inputJson: string; result: unknown; revision: number }>;
}

interface PendingPreparation {
  preparationId: string;
  datasetPath: string;
  revision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
  operations: OperationsMap;
  generated: boolean;
}

interface PendingMigration {
  preparationId: string;
  datasetPath: string;
  previousRevision: DatasetRevision;
  nextRevision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
  migrationSql: string;
  operations: OperationsMap;
  generated: boolean;
  approvalDigest: string;
  changeSha256: string;
  updatedFiles?: Record<string, string>;
}

interface PendingAppApproval {
  approvalId: string;
  candidateDigest: string;
  appRoot: string;
  local: boolean;
  sourceRevision: string;
  shareId?: string;
  grantId?: string;
  access?: "view" | "comment" | "edit";
}

interface StoredAppPublication {
  publicationId: string;
  appRoot: string;
  authorityRevision: number;
  sourceRevision: string;
  local: boolean;
  shareId?: string;
  grantId?: string;
}

export interface SeededDatasetSpec {
  datasetPath: string;
  generated?: boolean;
  seedSql?: string;
}

export interface EverydayDesktopSeed {
  workspaceId?: string;
  groups?: Array<{ id: string; name: string; kind?: "group" | "dm" }>;
  datasets?: SeededDatasetSpec[];
  collections?: Record<
    string,
    Array<{ id: string; path: string; values: Record<string, unknown> }>
  >;
  localPublications?: Array<{ appRoot: string; publicationId: string; sourceRevision: string }>;
}

function buildDatasetRevision(input: {
  definition: DatasetDefinition;
  schemaSql: string;
  operationSource: string;
  revisionNumber: number;
}): DatasetRevision {
  const definitionSha256 = sha256(datasetDefinitionDigestContent(input.definition));
  const schemaSha256 = sha256(input.schemaSql);
  const operationsSha256 = sha256(input.operationSource);
  const draft: DatasetRevision = {
    datasetId: input.definition.datasetId,
    revision: input.revisionNumber,
    revisionSha256: "0".repeat(64),
    definitionSha256,
    schemaSha256,
    operationsSha256,
    definition: input.definition,
  };
  draft.revisionSha256 = sha256(datasetRevisionDigestContent(draft));
  return draft;
}

function makeCursor(workspaceId: string, stored: StoredDataset) {
  return {
    workspaceId,
    datasetId: stored.revision.datasetId,
    hostEpoch: "eval-host-epoch",
    approvedRevisionHash: stored.revision.revisionSha256,
    revision: stored.dataRevision,
    digest: sha256(`${stored.revision.datasetId}:${stored.dataRevision}`),
  };
}

function describeStored(stored: StoredDataset) {
  return {
    ...describeApprovedDataset(stored.revision, stored.revision.definition.operations),
    datasetPath: stored.datasetPath,
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "group"
  );
}

function recordIdFor(index: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz234567";
  let value = "";
  let n = index + 1;
  for (let i = 0; i < 26; i++) {
    value += chars[n % chars.length]!;
    n = Math.floor(n / chars.length) + i + 3;
  }
  return `rec_${value}`;
}

function parseAppManifestForEval(root: string, appRoot: string) {
  const manifestRel = posix.join(appRoot, "app.publish.json");
  const raw = readWorkspaceText(root, manifestRel);
  if (raw === null) {
    throw new Error(
      `${manifestRel} is missing. Add app.publish.json with version: 1, entryPath, inputs, packageMap, and optional dataset binding.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${manifestRel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestRel} must be a JSON object.`);
  }
  const row = parsed as Record<string, unknown>;
  const versionErr = fileVersionError(row.version, manifestRel);
  if (versionErr) throw new Error(versionErr);
  const unknownKey = Object.keys(row).find(
    (key) =>
      !["version", "entryPath", "inputs", "packageMap", "collection", "dataset"].includes(key),
  );
  if (unknownKey) {
    throw new Error(`${manifestRel} has an unknown key: ${unknownKey}.`);
  }
  if (typeof row.entryPath !== "string" || !row.entryPath) {
    throw new Error(`${manifestRel} names no file in entryPath.`);
  }
  if (!Array.isArray(row.inputs) || row.inputs.length === 0) {
    throw new Error(`${manifestRel} must list at least one input.`);
  }
  const resolveRel = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value)
      throw new Error(`${manifestRel} names no file in ${field}.`);
    if (value.startsWith("/")) {
      throw new Error(
        `${manifestRel} lists ${value}. Write the path relative to ${appRoot}, without a leading /.`,
      );
    }
    const resolved = posix.normalize(posix.join(appRoot, value));
    if (resolved === ".." || resolved.startsWith("../")) {
      throw new Error(`${manifestRel} lists ${value}, which is outside the workspace.`);
    }
    return resolved;
  };
  const entryPath = resolveRel(row.entryPath, "entryPath");
  const inputs = row.inputs.map((entry) => resolveRel(entry, "input"));
  if (!inputs.includes(entryPath)) {
    throw new Error(`${manifestRel} must list its entryPath ${entryPath} among its inputs.`);
  }
  if (!row.packageMap || typeof row.packageMap !== "object" || Array.isArray(row.packageMap)) {
    throw new Error(`${manifestRel} has a packageMap that is not an object.`);
  }
  for (const inputPath of inputs) {
    if (readWorkspaceText(root, inputPath) === null) {
      throw new Error(`${manifestRel} lists ${inputPath}, which does not exist.`);
    }
  }
  const dataset = Object.hasOwn(row, "dataset") ? parseAppDatasetReference(row.dataset) : undefined;
  return { entryPath, inputs, dataset };
}

/**
 * Stateful desktop stand-in for everyday building evals. Runs real dohc contracts
 * (dataset definitions, app bindings, automations.yaml) and real SQLite/JS execution.
 */
export function createEverydayDesktop(
  root: string,
  seed: EverydayDesktopSeed = {},
): Record<string, DesktopAnswer> {
  const workspaceId = seed.workspaceId ?? "ws-everyday";
  const datasetsByPath = new Map<string, StoredDataset>();
  const preparations = new Map<string, PendingPreparation>();
  const migrations = new Map<string, PendingMigration>();
  const links = new Map<
    string,
    {
      shareId: string;
      grantId: string;
      operationId: string;
      paths: string[];
      access: "view" | "comment" | "edit";
      url: string;
    }
  >();
  const appApprovals = new Map<string, PendingAppApproval>();
  const appPublications = new Map<string, StoredAppPublication>();
  const collections = new Map<
    string,
    Array<{ id: string; path: string; values: Record<string, unknown> }>
  >();

  for (const [colPath, rows] of Object.entries(seed.collections ?? {})) {
    collections.set(
      colPath,
      rows.map((row) => ({ ...row, values: { ...row.values } })),
    );
  }
  for (const pub of seed.localPublications ?? []) {
    appPublications.set(pub.publicationId, {
      publicationId: pub.publicationId,
      appRoot: pub.appRoot,
      authorityRevision: 1,
      sourceRevision: pub.sourceRevision,
      local: true,
    });
  }

  const groups = (
    seed.groups ?? [
      { id: "channel-general", name: "General", kind: "group" as const },
      { id: "channel-planning", name: "Planning", kind: "group" as const },
      { id: "channel-finance", name: "Finance", kind: "group" as const },
    ]
  ).map((g) => ({
    id: g.id,
    name: g.name,
    slug: slug(g.name),
    kind: g.kind ?? ("group" as const),
    threadCount: 0,
    threads: [] as {
      id: string;
      title: string;
      messageCount: number;
      unreadCount: number;
      updatedAtMs: number;
    }[],
  }));

  let activeVersionId = "version-main";
  const versions: Array<{
    id: string;
    name: string;
    kind: "main" | "named";
    createdAtMs: number;
    canMergeIntoMain: boolean;
    madeFromVersionId?: string;
    snapshots: Map<string, string>;
  }> = [
    {
      id: "version-main",
      name: "Main",
      kind: "main",
      createdAtMs: AT,
      canMergeIntoMain: false,
      snapshots: new Map(),
    },
  ];
  let recordCounter = 0;

  function loadSeededDataset(spec: SeededDatasetSpec): void {
    const rawDef = readWorkspaceText(root, spec.datasetPath);
    if (!rawDef) throw new Error(`Seeded dataset missing: ${spec.datasetPath}`);
    const definition = parseDatasetDefinition(JSON.parse(rawDef));
    const schemaSql = readWorkspaceText(root, definition.schemaPath) ?? "";
    const operationSource = readWorkspaceText(root, definition.operationsPath) ?? "";
    const operations = compileOperationsForEval(operationSource, definition.operationsPath);
    const db = openMemorySqlite();
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(schemaSql);
    if (spec.seedSql) db.exec(spec.seedSql);
    const rev = buildDatasetRevision({
      definition,
      schemaSql,
      operationSource,
      revisionNumber: 1,
    });
    datasetsByPath.set(spec.datasetPath, {
      datasetPath: spec.datasetPath,
      revision: rev,
      schemaSql,
      operationSource,
      operations,
      db,
      generated: spec.generated ?? false,
      dataRevision: 1,
      idempotency: new Map(),
    });
  }

  for (const spec of seed.datasets ?? []) {
    loadSeededDataset(spec);
  }

  function snapshotTrackedFiles(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const rel of ["pricing.md", "README.md"]) {
      const content = readWorkspaceText(root, rel);
      if (content !== null) snap.set(rel, content);
    }
    return snap;
  }

  versions[0]!.snapshots = snapshotTrackedFiles();

  function assertWorkspace(requested: string): void {
    if (requested !== workspaceId) {
      throw new Error(
        `Unknown workspaceId "${requested}". Use "${workspaceId}" from dohc_list_workspaces or .dohc/manifest.json.`,
      );
    }
  }

  function applySchemaChange(
    stored: StoredDataset,
    change: DatasetSchemaChange,
  ): {
    nextDefinition: DatasetDefinition;
    schemaSql: string;
    operationSource: string;
    migrationSql: string;
  } {
    const nextDefinition: DatasetDefinition = structuredClone(stored.revision.definition);
    let migrationSql = "-- schema metadata update";
    if (change.kind === "renameCollection") {
      nextDefinition.name = change.name;
    } else if (change.kind === "renameTable") {
      const table = nextDefinition.tables.find((t) => t.tableId === change.tableId);
      if (!table) throw new Error(`Unknown tableId: ${change.tableId}.`);
      table.name = change.name;
    } else if (change.kind === "renameField") {
      const table = nextDefinition.tables.find((t) => t.tableId === change.tableId);
      const field = table?.fields.find((f) => f.fieldId === change.fieldId);
      if (!field) throw new Error(`Unknown fieldId: ${change.fieldId}.`);
      field.name = change.name;
    } else if (change.kind === "addField") {
      const table = nextDefinition.tables.find((t) => t.tableId === change.tableId);
      if (!table) throw new Error(`Unknown tableId: ${change.tableId}.`);
      const colName =
        change.field.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || "field";
      const newFieldId = randomUUID();
      if (change.field.required && change.field.default === undefined) {
        throw new Error(
          `Adding required field "${change.field.name}" requires a default value for existing records.`,
        );
      }
      table.fields.push({
        fieldId: newFieldId,
        name: change.field.name,
        sqlColumn: colName,
        type: change.field.type,
        required: change.field.required,
        unique: change.field.unique,
        ...(change.field.options ? { options: change.field.options } : {}),
        ...(change.field.default !== undefined ? { default: change.field.default } : {}),
      });
      for (const op of nextDefinition.operations) {
        if (
          op.tableId === table.tableId &&
          (op.kind === "read" || op.kind === "create" || op.kind === "edit")
        ) {
          if (!op.fieldIds.includes(newFieldId)) op.fieldIds.push(newFieldId);
        }
      }
      const defaultLiteral =
        change.field.default === undefined || change.field.default === null
          ? "NULL"
          : typeof change.field.default === "string"
            ? `'${change.field.default.replaceAll("'", "''")}'`
            : typeof change.field.default === "boolean"
              ? change.field.default
                ? "1"
                : "0"
              : String(change.field.default);
      const notNull = change.field.required ? ` NOT NULL DEFAULT ${defaultLiteral}` : "";
      migrationSql = `ALTER TABLE ${sqlIdent(table.sqlName)} ADD COLUMN ${sqlIdent(colName)} ${sqlColumnType(change.field.type)}${notNull};`;
    } else if (change.kind === "addButton") {
      const table = nextDefinition.tables.find((t) => t.tableId === change.tableId);
      if (!table) throw new Error(`Unknown tableId: ${change.tableId}.`);
      table.fields.push({ fieldId: randomUUID(), name: change.name, type: "button" });
    } else {
      throw new Error(`Unsupported schema change kind in eval: ${change.kind}.`);
    }
    parseDatasetDefinition(nextDefinition);
    const schemaSql = generateSchemaSql(nextDefinition);
    const operationSource = stored.generated
      ? generateDatasetOperations(nextDefinition)
      : stored.operationSource;
    return { nextDefinition, schemaSql, operationSource, migrationSql };
  }

  function handleDataset(req: DatasetRequest): unknown {
    assertWorkspace(req.workspaceId);
    switch (req.action) {
      case "list": {
        return {
          kind: "list",
          datasets: [...datasetsByPath.values()].map(describeStored),
          nextCursor: null,
        };
      }
      case "describe": {
        const stored = datasetsByPath.get(req.datasetPath);
        if (!stored) {
          throw new Error(
            `Collection reference broken: ${req.datasetPath}. Run dohc_dataset with action "list" to find approved dataset.json paths, or prepare and approve it first.`,
          );
        }
        return { kind: "description", dataset: describeStored(stored) };
      }
      case "create": {
        const definition = parseDatasetDefinition(req.definition);
        const folder = dirname(definition.schemaPath).replaceAll("\\", "/");
        const datasetPath = folder === "." ? "dataset.json" : posix.join(folder, "dataset.json");
        const schemaSql = generateSchemaSql(definition);
        const operationSource = generateDatasetOperations(definition);
        const operations = compileOperationsForEval(operationSource, definition.operationsPath);
        const db = openMemorySqlite();
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(schemaSql);
        const rev = buildDatasetRevision({
          definition,
          schemaSql,
          operationSource,
          revisionNumber: 1,
        });
        writeWorkspaceText(root, datasetPath, JSON.stringify(definition, null, 2) + "\n");
        writeWorkspaceText(root, definition.schemaPath, schemaSql + "\n");
        writeWorkspaceText(root, definition.operationsPath, operationSource + "\n");
        datasetsByPath.set(datasetPath, {
          datasetPath,
          revision: rev,
          schemaSql,
          operationSource,
          operations,
          db,
          generated: true,
          dataRevision: 1,
          idempotency: new Map(),
        });
        return { kind: "approved", revision: rev };
      }
      case "prepare": {
        const raw = readWorkspaceText(root, req.descriptorPath);
        if (raw === null) {
          throw new Error(`Descriptor file not found: ${req.descriptorPath}.`);
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch (error) {
          throw new Error(
            `${req.descriptorPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const definition = parseDatasetDefinition(parsedJson);
        const schemaSql = readWorkspaceText(root, definition.schemaPath);
        if (schemaSql === null) {
          throw new Error(`Schema file not found: ${definition.schemaPath}.`);
        }
        const operationSource = readWorkspaceText(root, definition.operationsPath);
        if (operationSource === null) {
          throw new Error(`Operations file not found: ${definition.operationsPath}.`);
        }
        const operations = compileOperationsForEval(operationSource, definition.operationsPath);
        for (const op of definition.operations) {
          if (typeof operations[op.name] !== "function") {
            throw new Error(
              `Operation "${op.name}" declared in ${req.descriptorPath} is missing from globalThis.operations in ${definition.operationsPath}.`,
            );
          }
        }
        const checkDb = openMemorySqlite();
        try {
          checkDb.exec("PRAGMA foreign_keys = ON;");
          checkDb.exec(schemaSql);
        } finally {
          checkDb.close();
        }
        const existing = datasetsByPath.get(req.descriptorPath);
        const nextNumber = existing ? existing.revision.revision + 1 : 1;
        const rev = buildDatasetRevision({
          definition,
          schemaSql,
          operationSource,
          revisionNumber: nextNumber,
        });
        const preparationId = randomUUID();
        preparations.set(preparationId, {
          preparationId,
          datasetPath: req.descriptorPath,
          revision: rev,
          schemaSql,
          operationSource,
          operations,
          generated: false,
        });
        return {
          kind: "prepared",
          preparationId,
          revision: rev,
          sourceDigest: rev.revisionSha256,
        };
      }
      case "approve": {
        const prep = preparations.get(req.preparationId);
        if (!prep) throw new Error(`Unknown or expired preparationId: ${req.preparationId}.`);
        if (prep.revision.revisionSha256 !== req.revisionSha256) {
          throw new Error(
            `revisionSha256 does not match the prepared revision (${prep.revision.revisionSha256}).`,
          );
        }
        preparations.delete(req.preparationId);
        const db = openMemorySqlite();
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(prep.schemaSql);
        datasetsByPath.set(prep.datasetPath, {
          datasetPath: prep.datasetPath,
          revision: prep.revision,
          schemaSql: prep.schemaSql,
          operationSource: prep.operationSource,
          operations: prep.operations,
          db,
          generated: prep.generated,
          dataRevision: 1,
          idempotency: new Map(),
        });
        return { kind: "approved", revision: prep.revision };
      }
      case "prepareSchemaChange": {
        const stored = datasetsByPath.get(req.datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${req.datasetPath}.`);
        if (
          stored.revision.revision !== req.revision ||
          stored.revision.revisionSha256 !== req.revisionSha256
        ) {
          throw new Error(
            `Stale revision: current revision is ${stored.revision.revision} (${stored.revision.revisionSha256}).`,
          );
        }
        const { nextDefinition, schemaSql, operationSource, migrationSql } = applySchemaChange(
          stored,
          req.change,
        );
        const operations = compileOperationsForEval(operationSource, nextDefinition.operationsPath);
        const nextRevision = buildDatasetRevision({
          definition: nextDefinition,
          schemaSql,
          operationSource,
          revisionNumber: stored.revision.revision + 1,
        });
        const preparationId = randomUUID();
        const approvalDigest = sha256(`approve:${nextRevision.revisionSha256}:${migrationSql}`);
        const changeSha256 = sha256(migrationSql);
        const expected = makeCursor(workspaceId, stored);
        const firstTable = nextDefinition.tables[0]!;
        const countRow = stored.db
          .prepare(`SELECT COUNT(*) AS c FROM ${sqlIdent(firstTable.sqlName)}`)
          .all()[0];
        const rowCount = Number(countRow?.c ?? 0);
        migrations.set(preparationId, {
          preparationId,
          datasetPath: req.datasetPath,
          previousRevision: stored.revision,
          nextRevision,
          schemaSql,
          operationSource,
          migrationSql,
          operations,
          generated: stored.generated,
          approvalDigest,
          changeSha256,
          updatedFiles: {
            [req.datasetPath]: JSON.stringify(nextDefinition, null, 2) + "\n",
            [nextDefinition.schemaPath]: schemaSql + "\n",
            ...(stored.generated
              ? { [nextDefinition.operationsPath]: operationSource + "\n" }
              : {}),
          },
        });
        return {
          kind: "migration-prepared",
          preparationId,
          previousRevision: stored.revision,
          revision: nextRevision,
          expected,
          candidate: {
            candidateId: randomUUID(),
            expected,
            approvedRevisionHash: nextRevision.revisionSha256,
            checkpointSha256: sha256(`ckpt:${nextRevision.revisionSha256}`),
            changeSha256,
            expiresAtMs: Date.now() + 600_000,
            preview: {
              tables: [
                {
                  table: firstTable.name,
                  beforeRows: rowCount,
                  afterRows: rowCount,
                  changedRows: rowCount,
                  deletedRows: 0,
                  beforeValues: {},
                  afterValues: {},
                  clearedValues: {},
                },
              ],
              firstPage: { changes: [], nextCursor: null },
            },
          },
          sourceDigest: nextRevision.revisionSha256,
          approvalDigest,
          schemaSql,
          operationSource,
          migrationSql,
          expiresAtMs: Date.now() + 600_000,
        };
      }
      case "prepareRelationChoices": {
        const stored = datasetsByPath.get(req.datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${req.datasetPath}.`);
        if (
          stored.revision.revision !== req.revision ||
          stored.revision.revisionSha256 !== req.revisionSha256
        ) {
          throw new Error(
            `Stale revision: current revision is ${stored.revision.revision} (${stored.revision.revisionSha256}).`,
          );
        }
        const sourceTable = stored.revision.definition.tables.find(
          (t) => t.tableId === req.tableId,
        );
        const relField = sourceTable?.fields.find((f) => f.fieldId === req.fieldId);
        if (!sourceTable || !relField || relField.type !== "relation" || !relField.relation) {
          throw new Error("fieldId must name a relation field on tableId.");
        }
        const targetTable = stored.revision.definition.tables.find(
          (t) => t.tableId === relField.relation!.tableId,
        );
        const targetPrimary = targetTable
          ? datasetColumnFields(targetTable).find((f) => f.sqlColumn === targetTable.primaryKey)
          : undefined;
        const labelField = targetTable?.fields.find((f) => f.fieldId === req.labelFieldId);
        if (!targetTable || !targetPrimary || !labelField || labelField.type === "button") {
          throw new Error("labelFieldId must name a column field on the relation's target table.");
        }
        const nextDefinition: DatasetDefinition = structuredClone(stored.revision.definition);
        const choiceOpId = randomUUID();
        const opName = `choices_${targetTable.sqlName}_${labelField.sqlColumn}`;
        nextDefinition.operations.push({
          operationId: choiceOpId,
          name: opName,
          label: `Public choices for ${targetTable.name} (${labelField.name})`,
          tableId: targetTable.tableId,
          kind: "read",
          access: "link",
          readOnly: true,
          fieldIds: [targetPrimary.fieldId, labelField.fieldId],
        });
        parseDatasetDefinition(nextDefinition);
        const schemaSql = stored.schemaSql;
        const operationSource = stored.generated
          ? generateDatasetOperations(nextDefinition)
          : `${stored.operationSource}\nglobalThis.operations.${opName} = function(ctx) { return { rows: ctx.db.query("SELECT ${sqlIdent(targetPrimary.sqlColumn)} AS id, ${sqlIdent(labelField.sqlColumn)} AS label FROM ${sqlIdent(targetTable.sqlName)}") }; };\n`;
        const operations = compileOperationsForEval(operationSource, nextDefinition.operationsPath);
        const nextRevision = buildDatasetRevision({
          definition: nextDefinition,
          schemaSql,
          operationSource,
          revisionNumber: stored.revision.revision + 1,
        });
        const preparationId = randomUUID();
        const migrationSql = `-- public relation choices ${opName}`;
        const approvalDigest = sha256(`relchoices:${nextRevision.revisionSha256}`);
        const changeSha256 = sha256(migrationSql);
        const expected = makeCursor(workspaceId, stored);
        migrations.set(preparationId, {
          preparationId,
          datasetPath: req.datasetPath,
          previousRevision: stored.revision,
          nextRevision,
          schemaSql,
          operationSource,
          migrationSql,
          operations,
          generated: stored.generated,
          approvalDigest,
          changeSha256,
          updatedFiles: {
            [req.datasetPath]: JSON.stringify(nextDefinition, null, 2) + "\n",
            [nextDefinition.operationsPath]: operationSource + "\n",
          },
        });
        return {
          kind: "migration-prepared",
          preparationId,
          previousRevision: stored.revision,
          revision: nextRevision,
          expected,
          candidate: {
            candidateId: randomUUID(),
            expected,
            approvedRevisionHash: nextRevision.revisionSha256,
            checkpointSha256: sha256(`ckpt:${nextRevision.revisionSha256}`),
            changeSha256,
            expiresAtMs: Date.now() + 600_000,
            preview: { tables: [], firstPage: { changes: [], nextCursor: null } },
          },
          sourceDigest: nextRevision.revisionSha256,
          approvalDigest,
          schemaSql,
          operationSource,
          migrationSql,
          expiresAtMs: Date.now() + 600_000,
        };
      }
      case "prepareMigration": {
        const stored = datasetsByPath.get(req.datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${req.datasetPath}.`);
        const rawDef = readWorkspaceText(root, req.datasetPath);
        const migrationSql = readWorkspaceText(root, req.migrationPath);
        if (rawDef === null) throw new Error(`Descriptor missing: ${req.datasetPath}.`);
        if (migrationSql === null || !migrationSql.trim()) {
          throw new Error(`Migration SQL file missing or empty: ${req.migrationPath}.`);
        }
        const nextDefinition = parseDatasetDefinition(JSON.parse(rawDef));
        const schemaSql = readWorkspaceText(root, nextDefinition.schemaPath) ?? stored.schemaSql;
        const operationSource =
          readWorkspaceText(root, nextDefinition.operationsPath) ?? stored.operationSource;
        const operations = compileOperationsForEval(operationSource, nextDefinition.operationsPath);
        const nextRevision = buildDatasetRevision({
          definition: nextDefinition,
          schemaSql,
          operationSource,
          revisionNumber: stored.revision.revision + 1,
        });
        const preparationId = randomUUID();
        const approvalDigest = sha256(`mig:${nextRevision.revisionSha256}:${migrationSql}`);
        const changeSha256 = sha256(migrationSql);
        const expected = makeCursor(workspaceId, stored);
        migrations.set(preparationId, {
          preparationId,
          datasetPath: req.datasetPath,
          previousRevision: stored.revision,
          nextRevision,
          schemaSql,
          operationSource,
          migrationSql,
          operations,
          generated: stored.generated,
          approvalDigest,
          changeSha256,
        });
        return {
          kind: "migration-prepared",
          preparationId,
          previousRevision: stored.revision,
          revision: nextRevision,
          expected,
          candidate: {
            candidateId: randomUUID(),
            expected,
            approvedRevisionHash: nextRevision.revisionSha256,
            checkpointSha256: sha256(`ckpt:${nextRevision.revisionSha256}`),
            changeSha256,
            expiresAtMs: Date.now() + 600_000,
            preview: { tables: [], firstPage: { changes: [], nextCursor: null } },
          },
          sourceDigest: nextRevision.revisionSha256,
          approvalDigest,
          schemaSql,
          operationSource,
          migrationSql,
          expiresAtMs: Date.now() + 600_000,
        };
      }
      case "approveMigration": {
        const pending = migrations.get(req.preparationId);
        if (!pending)
          throw new Error(`Unknown or expired migration preparationId: ${req.preparationId}.`);
        if (pending.nextRevision.revisionSha256 !== req.revisionSha256) {
          throw new Error("revisionSha256 does not match prepared migration.");
        }
        if (pending.approvalDigest !== req.approvalDigest) {
          throw new Error("approvalDigest does not match prepared migration.");
        }
        const stored = datasetsByPath.get(pending.datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${pending.datasetPath}.`);
        if (!pending.migrationSql.trim().startsWith("--")) {
          stored.db.exec(pending.migrationSql);
        }
        if (pending.updatedFiles) {
          for (const [relPath, content] of Object.entries(pending.updatedFiles)) {
            writeWorkspaceText(root, relPath, content);
          }
        }
        stored.revision = pending.nextRevision;
        stored.schemaSql = pending.schemaSql;
        stored.operationSource = pending.operationSource;
        stored.operations = pending.operations;
        stored.dataRevision += 1;
        migrations.delete(req.preparationId);
        return {
          kind: "migrated",
          revision: stored.revision,
          cursor: makeCursor(workspaceId, stored),
        };
      }
      case "createForm": {
        const stored = datasetsByPath.get(req.datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${req.datasetPath}.`);
        if (
          stored.revision.revision !== req.revision ||
          stored.revision.revisionSha256 !== req.revisionSha256
        ) {
          throw new Error(
            `Stale revision: current revision is ${stored.revision.revision} (${stored.revision.revisionSha256}).`,
          );
        }
        const table = stored.revision.definition.tables.find((t) => t.tableId === req.tableId);
        const createOp = stored.revision.definition.operations.find(
          (o) =>
            o.operationId === req.createOperationId &&
            o.tableId === req.tableId &&
            o.kind === "create",
        );
        if (!table || !createOp) {
          throw new Error("createOperationId must name a create operation on tableId.");
        }
        const opIds = [createOp.operationId];
        for (const choice of req.relationChoices ?? []) {
          const choiceOp = stored.revision.definition.operations.find(
            (o) => o.operationId === choice.operationId && o.kind === "read",
          );
          if (!choiceOp) {
            throw new Error(
              `relationChoices operationId ${choice.operationId} is not an approved read operation.`,
            );
          }
          if (choiceOp.fieldIds.length !== 2 || !choiceOp.fieldIds.includes(choice.labelFieldId)) {
            throw new Error(
              "A relation choices operation must declare only its key and label fields.",
            );
          }
          opIds.push(choiceOp.operationId);
        }
        const manifest = {
          version: 1,
          entryPath: "index.html",
          inputs: ["index.html", "form.js"],
          packageMap: {},
          dataset: {
            kind: "dataset",
            datasetPath: req.datasetPath,
            revision: stored.revision.revision,
            revisionSha256: stored.revision.revisionSha256,
            operationIds: opIds,
          },
        };
        const htmlPath = posix.join(req.appRoot, "index.html");
        const jsPath = posix.join(req.appRoot, "form.js");
        const manifestPath = posix.join(req.appRoot, "app.publish.json");
        writeWorkspaceText(
          root,
          htmlPath,
          `<!doctype html><title>${req.title ?? table.name}</title><script type="module" src="./form.js"></script>\n`,
        );
        writeWorkspaceText(
          root,
          jsPath,
          `// Connected form for ${table.name}\nwindow.addEventListener("message", () => {});\n`,
        );
        writeWorkspaceText(root, manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        return {
          kind: "form-created",
          appRoot: req.appRoot,
          paths: [htmlPath, jsPath, manifestPath],
        };
      }
      case "invoke": {
        const stored = datasetsByPath.get(req.datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${req.datasetPath}.`);
        if (
          stored.revision.revision !== req.revision ||
          stored.revision.revisionSha256 !== req.revisionSha256
        ) {
          throw new Error(
            "The Collection's rules changed. Its owner must approve this access again.",
          );
        }
        const op = stored.revision.definition.operations.find(
          (candidate) => candidate.operationId === req.operationId,
        );
        if (!op) throw new Error(`Unknown operationId: ${req.operationId}.`);
        const fn = stored.operations[op.name];
        if (!fn) throw new Error(`Operation "${op.name}" is missing from compiled operations.`);
        const replayKey = `${op.operationId}:${req.idempotencyKey}`;
        const inputJson = JSON.stringify(req.input);
        const prev = stored.idempotency.get(replayKey);
        if (prev) {
          if (prev.inputJson !== inputJson) {
            return {
              kind: "refused",
              code: "idempotency_conflict",
              message: "This idempotencyKey was already used with different input.",
            };
          }
          return { kind: "invoked", result: prev.result, revision: prev.revision, replayed: true };
        }
        const ctx = {
          requestId: req.idempotencyKey,
          nowMs: Date.now(),
          secret: sha256(`${req.idempotencyKey}:${stored.dataRevision}`).slice(0, 43),
          caller: { kind: "owner" },
          db: {
            query(sql: string, params: SqlParam[] = []) {
              return stored.db.prepare(sql).all(...params);
            },
            execute(sql: string, params: SqlParam[] = []) {
              if (op.readOnly)
                throw new Error("Read-only operations cannot write to the database.");
              const out = stored.db.prepare(sql).run(...params);
              return { changes: Number(out.changes) };
            },
          },
          refuse(code: string, message: string): never {
            throw new GuestRefusal(code, message);
          },
          files: {
            attach(): never {
              throw new GuestRefusal("file_not_found", "File attachment not available in eval.");
            },
          },
        };
        if (!op.readOnly) stored.db.exec("BEGIN;");
        try {
          const rawResult = fn(ctx, req.input);
          const result = rawResult === undefined ? null : JSON.parse(JSON.stringify(rawResult));
          if (!op.readOnly) {
            stored.db.exec("COMMIT;");
            stored.dataRevision += 1;
          }
          stored.idempotency.set(replayKey, {
            inputJson,
            result,
            revision: stored.dataRevision,
          });
          return {
            kind: "invoked",
            result,
            revision: stored.dataRevision,
            replayed: false,
          };
        } catch (error) {
          if (!op.readOnly) stored.db.exec("ROLLBACK;");
          if (error instanceof GuestRefusal) {
            return { kind: "refused", code: error.code, message: error.message };
          }
          throw error;
        }
      }
      default:
        throw new Error(`Unsupported dataset action in everyday eval: ${req.action}.`);
    }
  }

  function handleAppPublication(req: OwnerAppPublicationRequest): unknown {
    assertWorkspace(req.workspaceId);
    switch (req.action) {
      case "createLink": {
        const existing = [...links.values()].find((l) => l.operationId === req.operationId);
        if (existing) {
          return {
            kind: "linkCreated",
            shareId: existing.shareId,
            grantId: existing.grantId,
            selector: { paths: existing.paths, versionId: null },
            access: existing.access,
            bearerWarning: `This URL is a bearer credential at ${existing.access} access, usable by anyone who holds it.`,
            url: existing.url,
          };
        }
        const shareId = `share_${randomUUID().slice(0, 8)}`;
        const grantId = `grant_${randomUUID().slice(0, 8)}`;
        const paths = req.paths ?? [req.appRoot];
        const url = `https://share.dohc.local/s/${shareId}#secret_${grantId}`;
        links.set(`${shareId}:${grantId}`, {
          shareId,
          grantId,
          operationId: req.operationId,
          paths,
          access: req.access,
          url,
        });
        return {
          kind: "linkCreated",
          shareId,
          grantId,
          selector: { paths, versionId: null },
          access: req.access,
          bearerWarning: `This URL is a bearer credential at ${req.access} access, usable by anyone who holds it.`,
          url,
        };
      }
      case "listLocal": {
        const publications = [...appPublications.values()]
          .filter((p) => p.local && p.appRoot === req.appRoot)
          .map((p) => ({
            publicationId: p.publicationId,
            authorityRevision: p.authorityRevision,
            appRoot: p.appRoot,
            sourceRevision: p.sourceRevision,
            approved: true,
            active: true,
          }));
        return { kind: "localListed", publications };
      }
      case "checkLocal": {
        const manifest = parseAppManifestForEval(root, req.appRoot);
        const sourceRevision = sha256(
          manifest.inputs.map((p) => `${p}:${readWorkspaceText(root, p) ?? ""}`).join("\n"),
        );
        return {
          kind: "localChecked",
          appRoot: req.appRoot,
          sourceRevision,
          sourcePaths: manifest.inputs,
        };
      }
      case "prepareLocal":
      case "prepare": {
        const manifest = parseAppManifestForEval(root, req.appRoot);
        const capabilities = [];
        if (manifest.dataset) {
          const stored = datasetsByPath.get(manifest.dataset.datasetPath);
          if (!stored) {
            throw new Error(
              `Collection reference broken: ${manifest.dataset.datasetPath}. Approve the Collection first or fix datasetPath in ${req.appRoot}/app.publish.json.`,
            );
          }
          const binding: AppDatasetBinding = {
            kind: "dataset",
            datasetId: stored.revision.datasetId,
            revision: manifest.dataset.revision,
            revisionSha256: manifest.dataset.revisionSha256,
            operationIds: manifest.dataset.operationIds,
            ...(manifest.dataset.linkReads ? { linkReads: manifest.dataset.linkReads } : {}),
            ...(manifest.dataset.createFields
              ? { createFields: manifest.dataset.createFields }
              : {}),
          };
          capabilities.push(
            resolveAppDatasetCapability(binding, stored.revision, () => stored.generated),
          );
        }
        const sourceRevision = sha256(
          manifest.inputs.map((p) => `${p}:${readWorkspaceText(root, p) ?? ""}`).join("\n"),
        );
        const approvalId = randomUUID();
        const candidateDigest = sha256(
          `${req.appRoot}:${sourceRevision}:${JSON.stringify(capabilities)}`,
        );
        const isLocal = req.action === "prepareLocal";
        let audience:
          | {
              shareId: string;
              grantId: string;
              selector: { paths: string[]; versionId: string | null };
              access: "view" | "comment" | "edit";
            }
          | undefined;
        if (!isLocal) {
          const link = links.get(`${req.shareId}:${req.grantId}`);
          if (!link) throw new Error("This app link is unavailable. Choose an active link.");
          audience = {
            shareId: link.shareId,
            grantId: link.grantId,
            selector: { paths: link.paths, versionId: null },
            access: link.access,
          };
        }
        appApprovals.set(approvalId, {
          approvalId,
          candidateDigest,
          appRoot: req.appRoot,
          local: isLocal,
          sourceRevision,
          ...(audience
            ? { shareId: audience.shareId, grantId: audience.grantId, access: audience.access }
            : {}),
        });
        return {
          kind: "prepared",
          approvalId,
          candidateDigest,
          appRoot: req.appRoot,
          versionId: "main",
          sourceRevision,
          ...(audience ? { audience } : {}),
          sourcePaths: manifest.inputs,
          capabilities,
          externalNetwork: true as const,
          ...(isLocal ? { local: true as const } : {}),
        };
      }
      case "approve": {
        const pending = appApprovals.get(req.approvalId);
        if (!pending) throw new Error(`Unknown or expired approvalId: ${req.approvalId}.`);
        if (pending.candidateDigest !== req.candidateDigest) {
          throw new Error("candidateDigest does not match prepared app.");
        }
        appApprovals.delete(req.approvalId);
        const publicationId = sha256(`pub:${pending.appRoot}:${pending.candidateDigest}`);
        const existing = appPublications.get(publicationId);
        const authorityRevision = (existing?.authorityRevision ?? 0) + 1;
        appPublications.set(publicationId, {
          publicationId,
          appRoot: pending.appRoot,
          authorityRevision,
          sourceRevision: pending.sourceRevision,
          local: pending.local,
          ...(pending.shareId ? { shareId: pending.shareId } : {}),
          ...(pending.grantId ? { grantId: pending.grantId } : {}),
        });
        return pending.local
          ? {
              kind: "published",
              publicationId,
              authorityRevision,
              local: true as const,
            }
          : {
              kind: "published",
              publicationId,
              authorityRevision,
              appQuery: `?app=${publicationId}`,
              access: pending.access ?? "view",
              bearerWarning: `This URL is a bearer credential at ${pending.access ?? "view"} access, usable by anyone who holds it.`,
            };
      }
      case "launchLocal": {
        const pub = appPublications.get(req.publicationId);
        if (!pub || !pub.local) {
          throw new Error(
            `Unknown local publicationId: ${req.publicationId}. Run prepareLocal and approve first.`,
          );
        }
        return {
          kind: "localLaunched",
          publicationId: pub.publicationId,
          url: `http://127.0.0.1:4173/?app=${pub.publicationId}`,
        };
      }
      default:
        throw new Error(`Unsupported app publication action in everyday eval: ${req.action}.`);
    }
  }

  return {
    dataset: (args: Args) => handleDataset(args.request as DatasetRequest),
    appPublication: (args: Args) =>
      handleAppPublication(args.request as OwnerAppPublicationRequest),
    automationList: (args: Args) => {
      const colPath = String(args.collectionPath);
      const filePath = posix.join(colPath, "automations.yaml");
      const text = readWorkspaceText(root, filePath);
      const content = text === null ? null : { text, contentHash: sha256(text), truncated: false };
      return { ok: true, definitions: automationDefinitionList(content, true) };
    },
    collectionQuery: (args: Args) => {
      const colPath = String(args.collectionPath);
      const rows = collections.get(colPath) ?? [];
      return {
        ok: true,
        collection: { path: colPath, status: "valid", reasons: [] },
        records: rows.map((row) => ({
          id: row.id,
          path: row.path,
          conflicted: false,
          values: Object.entries(row.values).map(([field, value]) => ({
            field,
            value,
            validation: { status: "valid" },
            resolvedRelations: [],
          })),
        })),
        groups: null,
        nextCursor: null,
      };
    },
    collectionCreateRecord: (args: Args) => {
      const colPath = String(args.collectionPath);
      const name = String(args.name);
      const fields = (args.fields as Record<string, unknown> | undefined) ?? {};
      const recordId =
        typeof args.recordId === "string" ? args.recordId : recordIdFor(recordCounter++);
      const recordPath = posix.join(colPath, `${name}.md`);
      const frontmatterLines = [
        "---",
        `dohc_record_id: ${recordId}`,
        ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
        "---",
        "",
        typeof args.body === "string" ? args.body : "",
      ];
      writeWorkspaceText(root, recordPath, frontmatterLines.join("\n"));
      const rows = collections.get(colPath) ?? [];
      rows.push({ id: recordId, path: recordPath, values: { ...fields } });
      collections.set(colPath, rows);
      return { ok: true, recordId, recordPath };
    },
    collectionSetFields: (args: Args) => {
      const path = String(args.path);
      const fields = (args.fields as Record<string, unknown>) ?? {};
      for (const rows of collections.values()) {
        const hit = rows.find((row) => row.path === path);
        if (hit) Object.assign(hit.values, fields);
      }
      return { ok: true, path, updated: Object.keys(fields) };
    },
    versionList: () => ({
      ok: true,
      versions: versions.map(({ snapshots: _s, ...v }) => v),
      activeVersionId,
    }),
    versionCreate: (args: Args) => {
      const name = String(args.name);
      if (versions.some((v) => v.name === name)) {
        return { ok: false, reason: `A version named "${name}" already exists.` };
      }
      const id = `version-${slug(name)}-${versions.length}`;
      const created = {
        id,
        name,
        kind: "named" as const,
        createdAtMs: AT + versions.length * 1000,
        canMergeIntoMain: activeVersionId === "version-main",
        madeFromVersionId: activeVersionId,
        snapshots: snapshotTrackedFiles(),
      };
      versions.push(created);
      activeVersionId = id;
      return { ok: true, version: { id: created.id, name: created.name } };
    },
    versionSwitch: (args: Args) => {
      const wanted = String(args.version);
      const target = versions.find((v) => v.id === wanted || v.name === wanted);
      if (!target) return { ok: false, reason: `No version named "${wanted}".` };
      const current = versions.find((v) => v.id === activeVersionId);
      if (current) current.snapshots = snapshotTrackedFiles();
      let changed = 0;
      for (const [path, text] of target.snapshots.entries()) {
        if (readWorkspaceText(root, path) !== text) {
          writeWorkspaceText(root, path, text);
          changed += 1;
        }
      }
      activeVersionId = target.id;
      return {
        ok: true,
        version: { id: target.id, name: target.name },
        changedFileCount: changed,
      };
    },
    versionCompare: (args: Args) => {
      const wanted = String(args.version);
      const target = versions.find((v) => v.id === wanted || v.name === wanted);
      if (!target) return { ok: false, reason: `No version named "${wanted}".` };
      const current = versions.find((v) => v.id === activeVersionId);
      if (current) current.snapshots = snapshotTrackedFiles();
      const mainSnap = versions[0]!.snapshots;
      const targetSnap = target.snapshots;
      const allPaths = new Set([...mainSnap.keys(), ...targetSnap.keys()]);
      const files: Array<{
        path: string;
        status: "added" | "modified" | "deleted";
        currentText?: string;
        incomingText?: string;
      }> = [];
      for (const path of [...allPaths].sort()) {
        const before = mainSnap.get(path);
        const after = targetSnap.get(path);
        if (before === after) continue;
        if (before === undefined && after !== undefined) {
          files.push({ path, status: "added", incomingText: after });
        } else if (before !== undefined && after === undefined) {
          files.push({ path, status: "deleted", currentText: before });
        } else {
          files.push({ path, status: "modified", currentText: before, incomingText: after });
        }
      }
      return {
        ok: true,
        version: { id: target.id, name: target.name },
        files,
        nextAfterPath: null,
      };
    },
    versionMerge: (args: Args) => {
      const wanted = String(args.version);
      const target = versions.find((v) => v.id === wanted || v.name === wanted);
      if (!target) return { ok: false, reason: `No version named "${wanted}".` };
      const current = versions.find((v) => v.id === activeVersionId);
      if (current) current.snapshots = snapshotTrackedFiles();
      const main = versions[0]!;
      let merged = 0;
      let unchanged = 0;
      for (const [path, text] of target.snapshots.entries()) {
        if (main.snapshots.get(path) !== text) {
          main.snapshots.set(path, text);
          writeWorkspaceText(root, path, text);
          merged += 1;
        } else {
          unchanged += 1;
        }
      }
      activeVersionId = main.id;
      return {
        ok: true,
        version: { id: target.id, name: target.name },
        mergedFileCount: merged,
        unchangedFileCount: unchanged,
        conflictCount: 0,
        conflicts: [],
        nextAfterConflictId: null,
      };
    },
    groupsFull: () => ({ ok: true, groups }),
    collectionsWaiting: () => ({ ok: true, waiting: false }),
    liveKeptEdits: () => ({ ok: true, keptEdits: [], pendingShare: [], pendingShareWhileOpen: [] }),
    sharedFilesHeld: () => ({ ok: true, heldFiles: null }),
    syncFailure: () => ({ ok: true, syncFailure: null }),
    chat: (args: Args) => {
      if (args.group !== undefined) {
        const name = String(args.group).replace(/^#/, "");
        const found = groups.find(
          (g) => g.name.toLowerCase() === name.toLowerCase() || g.slug === slug(name),
        );
        return {
          ok: true,
          stream: {
            group: {
              id: found?.id ?? `ch_${slug(name)}`,
              name: found?.name ?? name,
              kind: found?.kind ?? "group",
            },
            items: [],
            nextBefore: null,
            readPosition: null,
          },
        };
      }
      const threadId = String(args.threadId ?? "th_1");
      return {
        ok: true,
        thread: { id: threadId, title: "Thread", createdAtMs: AT, updatedAtMs: AT },
        dispatch: { paused: null, lastRun: null },
        messages: [],
        projection: { path: `chats/${threadId}.md`, readOnly: true, text: "" },
      };
    },
    post: (args: Args) => {
      const name = String(args.group).replace(/^#/, "");
      const found = groups.find(
        (g) => g.name.toLowerCase() === name.toLowerCase() || g.slug === slug(name),
      );
      return {
        group: {
          id: found?.id ?? `ch_${slug(name)}`,
          name: found?.name ?? name,
          slug: found?.slug ?? slug(name),
          kind: "group" as const,
        },
        threadId: `th_${slug(name)}_1`,
        messageId: `msg_${slug(name)}_1`,
        title: typeof args.title === "string" ? args.title : "",
      };
    },
    reply: (args: Args) => ({ threadId: String(args.thread), messageId: "msg_reply" }),
    fileChatStart: (args: Args) => ({
      ok: true,
      path: String(args.path),
      threadId: "thread-file-1",
      messageId: "message-file-1",
    }),
    documentRead: (args: Args) => workspaceVerbs.documentRead!(root, args),
    documentEdit: (args: Args) => workspaceVerbs.documentEdit!(root, args),
    documentCreate: (args: Args) => workspaceVerbs.documentCreate!(root, args),
    fileWrite: (args: Args) => workspaceVerbs.fileWrite!(root, args),
  };
}
