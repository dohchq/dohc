import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import {
  evaluateAppOperation,
  initializeAppDatabase,
  isAppBackendRuntimeError,
  type JsonValue,
} from "@dohc/app-backend-runtime";
import { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";
import { openPersistentAppBackend } from "@dohc/app-backend-runtime/persistent";
import { parseAppCollectionCapability } from "@dohc/security-contract/app-publication";
import {
  datasetColumnFields,
  datasetDefinitionDigestContent,
  datasetRevisionDigestContent,
  describeApprovedDataset,
  parseAppDatasetReference,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
  type DatasetDefinition,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { automationDefinitionList } from "@dohc/workspace-contracts/automation-controls";
import { fileVersionError } from "@dohc/workspace-contracts/file-version";
import { WorkspaceSearchInput, WorkspaceSearchResult } from "@dohc/workspace-contracts/retrieval";
import { validateUserMaterializePath, validateUserReadPath } from "@dohc/workspace-core/paths";
import { realRelativeInRoot, resolvedAreaRefusal } from "@dohc/workspace-core/realPath";
import type { DatasetRequest, DatasetSchemaChange } from "@dohc/cli/dataset";
import type {
  AppFrontendBrokerCall,
  AppFrontendDiagnostic,
  AppFrontendStepResult,
  OwnerAppPublicationRequest,
  OwnerAppPublicationResult,
} from "@dohc/cli/app-publication";
import type { DatasetSnapshot, DesktopAnswer, FrontendVerificationRecord } from "./case";
import { workspaceVerbs } from "./desktop";

type Args = Record<string, unknown>;

const AT = 1_760_000_000_000;
const MANIFEST_LIMIT_BYTES = 64 * 1024;
const MAX_MANIFEST_INPUTS = 512;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function describeJsonSyntaxLocation(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const posLineCol = / at position \d+ \(line (\d+) column (\d+)\)$/.exec(error.message);
  if (posLineCol) return `at line ${posLineCol[1]}, column ${posLineCol[2]}`;
  const posOnly = / at position (\d+)$/.exec(error.message);
  if (posOnly) return `at position ${posOnly[1]}`;
  return undefined;
}

async function resolveWorkspacePath(
  root: string,
  relPath: string,
  access: "read" | "write",
): Promise<{ absolute: string; normalized: string; realRelative: string }> {
  const validated =
    access === "read"
      ? validateUserReadPath(relPath, { platform: process.platform })
      : validateUserMaterializePath(relPath, { platform: process.platform });
  if (!validated.ok) {
    throw new Error(`path rejected (${validated.reason}): ${relPath}`);
  }
  const absolute = join(root, validated.normalized);
  const target = await realRelativeInRoot(root, absolute);
  if (!target.ok) {
    throw new Error(`path rejected (${target.reason}): ${relPath}`);
  }
  const refused = resolvedAreaRefusal(target.relative, access);
  if (refused) {
    throw new Error(`path rejected: ${refused.explain}`);
  }
  return {
    absolute: target.resolvedAbsolute,
    normalized: validated.normalized,
    realRelative: target.relative,
  };
}

async function readWorkspaceText(root: string, relPath: string): Promise<string | null> {
  const resolved = await resolveWorkspacePath(root, relPath, "read");
  try {
    return await readFile(resolved.absolute, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function writeWorkspaceText(
  root: string,
  relPath: string,
  content: string,
  onWrite?: (path: string, contentSha256: string) => void,
): Promise<void> {
  const resolved = await resolveWorkspacePath(root, relPath, "write");
  await mkdir(dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, content, "utf8");
  onWrite?.(resolved.normalized, sha256(content));
}

function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlColumnType(type: string): string {
  if (type === "number") return "REAL";
  if (type === "checkbox") return "INTEGER";
  return "TEXT";
}

function tableSqlNames(definition: DatasetDefinition): string[] {
  return definition.tables.map((table) => table.sqlName);
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

interface StoredDataset {
  datasetPath: string;
  revision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
  compiledSource: string;
  database: Uint8Array;
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
  compiledSource: string;
  database: Uint8Array;
  generated: boolean;
}

interface PendingMigration {
  preparationId: string;
  datasetPath: string;
  previousRevision: DatasetRevision;
  nextRevision: DatasetRevision;
  schemaSql: string;
  operationSource: string;
  compiledSource: string;
  migrationSql: string;
  nextDatabase: Uint8Array;
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
  seedInvocations?: Array<{ operationId: string; input: JsonValue }>;
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

async function runAuthorizedMigration(input: {
  workspaceId: string;
  stored: StoredDataset;
  nextSchemaSql: string;
  nextTables: string[];
  migrationSql: string;
}) {
  const migDir = await mkdtemp(join(tmpdir(), "dohc-eval-mig-"));
  const workerDir = join(migDir, "worker");
  const inPath = join(migDir, "before.sqlite");
  const outPath = join(migDir, "after.sqlite");
  const reportPath = join(migDir, "report.sqlite");
  await mkdir(workerDir, { recursive: true });
  await writeFile(inPath, input.stored.database);
  const worker = await openPersistentAppBackend({
    directory: workerDir,
    checkpointPath: inPath,
    schemaSql: input.stored.schemaSql,
    tables: tableSqlNames(input.stored.revision.definition),
    scope: {
      workspaceId: input.workspaceId,
      datasetId: input.stored.revision.datasetId,
      hostEpoch: "eval-host-epoch",
      approvedRevisionHash: input.stored.revision.revisionSha256,
    },
    cursor: { revision: 0, digest: sha256("eval-mig-open") },
  });
  try {
    const migrated = await worker.migrateCheckpoint({
      path: outPath,
      schemaSql: input.nextSchemaSql,
      tables: input.nextTables,
      migrationSql: input.migrationSql,
      reportPath,
    });
    const nextDatabase = new Uint8Array(await readFile(outPath));
    return { nextDatabase, previewTables: migrated.report?.tables ?? [] };
  } finally {
    await worker.close().catch(() => {});
    await rm(migDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function parseAppManifestForEval(root: string, appRootInput: string) {
  const appRoot = (await resolveWorkspacePath(root, appRootInput, "read")).normalized;
  const manifestRel = posix.join(appRoot, "app.publish.json");
  const raw = await readWorkspaceText(root, manifestRel);
  if (raw === null) {
    throw new Error(
      `${manifestRel} is missing. Add app.publish.json with version: 1, entryPath, inputs, packageMap, and optional dataset binding.`,
    );
  }
  if (Buffer.byteLength(raw, "utf8") > MANIFEST_LIMIT_BYTES) {
    throw new Error(`${manifestRel} is larger than 64 KB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const location = describeJsonSyntaxLocation(error);
    throw new Error(
      `${manifestRel} is not valid JSON${location ? ` (${location})` : ""}. Check its syntax.`,
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
  if (Object.hasOwn(row, "collection") && Object.hasOwn(row, "dataset")) {
    throw new Error(`${manifestRel} must hold at most one of collection or dataset.`);
  }
  const resolveRel = async (value: unknown, field: string): Promise<string> => {
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
    return (await resolveWorkspacePath(root, resolved, "read")).normalized;
  };
  const entryPath = await resolveRel(row.entryPath, "entryPath");
  if (!Array.isArray(row.inputs) || row.inputs.length === 0) {
    throw new Error(`${manifestRel} must list at least one input.`);
  }
  if (row.inputs.length >= MAX_MANIFEST_INPUTS) {
    throw new Error(`${manifestRel} lists more than ${MAX_MANIFEST_INPUTS - 1} inputs.`);
  }
  const inputs: string[] = [];
  for (const entry of row.inputs) {
    inputs.push(await resolveRel(entry, "input"));
  }
  const repeated = inputs.find((path, index) => inputs.indexOf(path) !== index);
  if (repeated) {
    throw new Error(`${manifestRel} lists ${repeated} twice.`);
  }
  if (!inputs.includes(entryPath)) {
    throw new Error(`${manifestRel} must list its entryPath ${entryPath} among its inputs.`);
  }
  if (!row.packageMap || typeof row.packageMap !== "object" || Array.isArray(row.packageMap)) {
    throw new Error(`${manifestRel} has a packageMap that is not an object.`);
  }
  for (const [name, target] of Object.entries(row.packageMap)) {
    if (name.length > 256) {
      throw new Error(`${manifestRel} maps a package name longer than 256 characters.`);
    }
    const mapped = await resolveRel(target, `packageMap target for ${name}`);
    if (!inputs.includes(mapped)) {
      throw new Error(`${manifestRel} maps ${name} to ${mapped}, which is not among its inputs.`);
    }
  }
  for (const inputPath of inputs) {
    if ((await readWorkspaceText(root, inputPath)) === null) {
      throw new Error(`${manifestRel} lists ${inputPath}, which does not exist.`);
    }
  }
  if (Object.hasOwn(row, "collection")) {
    if (
      !row.collection ||
      typeof row.collection !== "object" ||
      Array.isArray(row.collection) ||
      Object.hasOwn(row.collection, "schemaSha256")
    ) {
      throw new Error(
        `${manifestRel} has a collection that is not an object without schemaSha256.`,
      );
    }
    const declared = row.collection as Record<string, unknown>;
    const collectionPath = await resolveRel(declared.collectionPath, "collectionPath");
    parseAppCollectionCapability({
      ...declared,
      collectionPath,
      schemaSha256: "0".repeat(64),
    });
  }
  const dataset = Object.hasOwn(row, "dataset") ? parseAppDatasetReference(row.dataset) : undefined;
  return { appRoot, entryPath, inputs, dataset };
}

async function listWorkspaceTextFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const rel = relative(root, absolute).split(sep).join("/");
    if (rel === ".dohc" || rel.startsWith(".dohc/")) continue;
    const text = await readWorkspaceText(root, rel).catch(() => null);
    if (text !== null) files.set(rel, text);
  }
  return files;
}

/**
 * Stateful desktop stand-in for everyday building evals. Runs real dohc contracts,
 * path/symlink containment, esbuild/acorn compilation, and isolated QuickJS + SQLite workers.
 */
export async function createEverydayDesktop(
  root: string,
  seed: EverydayDesktopSeed = {},
  options: {
    onWrite?: (path: string, contentSha256: string) => void;
    onDatasetSnapshot?: (datasetPath: string, snapshot: DatasetSnapshot) => void;
    onFrontendVerified?: (appRoot: string, record: FrontendVerificationRecord) => void;
    verifyFrontend?: (
      req: Extract<OwnerAppPublicationRequest, { action: "verifyFrontend" }>,
    ) => Promise<Extract<OwnerAppPublicationResult, { kind: "frontendVerified" }>>;
  } = {},
): Promise<Record<string, DesktopAnswer>> {
  const workspaceId = seed.workspaceId ?? "ws-everyday";
  const onWrite = options.onWrite;
  const onDatasetSnapshot = options.onDatasetSnapshot;
  const onFrontendVerified = options.onFrontendVerified;
  function reportSnapshot(stored: StoredDataset): void {
    onDatasetSnapshot?.(stored.datasetPath, {
      revision: stored.revision.revision,
      revisionSha256: stored.revision.revisionSha256,
      databaseBase64: Buffer.from(stored.database).toString("base64"),
    });
  }
  let datasetQueue: Promise<void> = Promise.resolve();
  function serializeDataset<T>(fn: () => Promise<T>): Promise<T> {
    const next = datasetQueue.then(fn, fn);
    datasetQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
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
      snapshots: await listWorkspaceTextFiles(root),
    },
  ];
  let recordCounter = 0;

  async function loadSeededDataset(spec: SeededDatasetSpec): Promise<void> {
    const rawDef = await readWorkspaceText(root, spec.datasetPath);
    if (rawDef === null) throw new Error(`Seeded dataset missing: ${spec.datasetPath}`);
    const definition = parseDatasetDefinition(JSON.parse(rawDef));
    const schemaSql = (await readWorkspaceText(root, definition.schemaPath)) ?? "";
    const operationSource = (await readWorkspaceText(root, definition.operationsPath)) ?? "";
    const compiledSource = await compileDatasetOperations(
      operationSource,
      definition.operationsPath,
    );
    const tables = tableSqlNames(definition);
    let database = await initializeAppDatabase({ schemaSql, tables });
    let dataRevision = 1;
    for (let index = 0; index < (spec.seedInvocations ?? []).length; index += 1) {
      const seedInvoke = spec.seedInvocations![index]!;
      const op = definition.operations.find((o) => o.operationId === seedInvoke.operationId);
      if (!op) throw new Error(`Seeded operationId missing: ${seedInvoke.operationId}`);
      const res = await evaluateAppOperation({
        database,
        source: compiledSource,
        operation: op.name,
        caller: { kind: "owner" },
        input: seedInvoke.input,
        nowMs: AT + index,
        requestId: `seed-${index + 1}`,
        tables,
        readOnly: false,
      });
      database = res.database;
      dataRevision += 1;
    }
    const rev = buildDatasetRevision({
      definition,
      schemaSql,
      operationSource,
      revisionNumber: 1,
    });
    const stored: StoredDataset = {
      datasetPath: spec.datasetPath,
      revision: rev,
      schemaSql,
      operationSource,
      compiledSource,
      database,
      generated: spec.generated ?? false,
      dataRevision,
      idempotency: new Map(),
    };
    datasetsByPath.set(spec.datasetPath, stored);
    reportSnapshot(stored);
  }

  for (const spec of seed.datasets ?? []) {
    await loadSeededDataset(spec);
  }

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
      const oldCols = [...datasetColumnFields(table).map((f) => f.sqlColumn)];
      if (!oldCols.includes("_record_version")) oldCols.push("_record_version");
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
      const tmp = `migration_${randomUUID().replaceAll("-", "")}`;
      const newTableDdl = generateSchemaSql({ ...nextDefinition, tables: [table] });
      const oldColList = oldCols.map(sqlIdent).join(", ");
      migrationSql = [
        `CREATE TABLE ${sqlIdent(tmp)} AS SELECT ${oldColList} FROM ${sqlIdent(table.sqlName)};`,
        `DROP TABLE ${sqlIdent(table.sqlName)};`,
        newTableDdl,
        `INSERT INTO ${sqlIdent(table.sqlName)} (${oldColList}, ${sqlIdent(colName)}) SELECT ${oldColList}, ${defaultLiteral} FROM ${sqlIdent(tmp)};`,
        `DROP TABLE ${sqlIdent(tmp)};`,
      ].join("\n");
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

  async function handleDataset(req: DatasetRequest): Promise<unknown> {
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
        const datasetPath = (await resolveWorkspacePath(root, req.datasetPath, "read")).normalized;
        const stored = datasetsByPath.get(datasetPath);
        if (!stored) {
          throw new Error(
            `Collection reference broken: ${datasetPath}. Run dohc_dataset with action "list" to find approved dataset.json paths, or prepare and approve it first.`,
          );
        }
        return { kind: "description", dataset: describeStored(stored) };
      }
      case "create": {
        const definition = parseDatasetDefinition(req.definition);
        const schemaPath = (await resolveWorkspacePath(root, definition.schemaPath, "write"))
          .normalized;
        const operationsPath = (
          await resolveWorkspacePath(root, definition.operationsPath, "write")
        ).normalized;
        const folder = dirname(schemaPath).replaceAll("\\", "/");
        const datasetPath = (
          await resolveWorkspacePath(
            root,
            folder === "." ? "dataset.json" : posix.join(folder, "dataset.json"),
            "write",
          )
        ).normalized;
        const normalizedDef: DatasetDefinition = {
          ...definition,
          schemaPath,
          operationsPath,
        };
        const schemaSql = generateSchemaSql(normalizedDef);
        const operationSource = generateDatasetOperations(normalizedDef);
        const compiledSource = await compileDatasetOperations(operationSource, operationsPath);
        const database = await initializeAppDatabase({
          schemaSql,
          tables: tableSqlNames(normalizedDef),
        });
        const rev = buildDatasetRevision({
          definition: normalizedDef,
          schemaSql,
          operationSource,
          revisionNumber: 1,
        });
        await writeWorkspaceText(
          root,
          datasetPath,
          JSON.stringify(normalizedDef, null, 2) + "\n",
          onWrite,
        );
        await writeWorkspaceText(root, schemaPath, schemaSql + "\n", onWrite);
        await writeWorkspaceText(root, operationsPath, operationSource + "\n", onWrite);
        const stored: StoredDataset = {
          datasetPath,
          revision: rev,
          schemaSql,
          operationSource,
          compiledSource,
          database,
          generated: true,
          dataRevision: 1,
          idempotency: new Map(),
        };
        datasetsByPath.set(datasetPath, stored);
        reportSnapshot(stored);
        return { kind: "approved", revision: rev };
      }
      case "prepare": {
        const descriptorPath = (await resolveWorkspacePath(root, req.descriptorPath, "read"))
          .normalized;
        const raw = await readWorkspaceText(root, descriptorPath);
        if (raw === null) {
          throw new Error(`Descriptor file not found: ${descriptorPath}.`);
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch (error) {
          const location = describeJsonSyntaxLocation(error);
          throw new Error(
            `${descriptorPath} is not valid JSON${location ? ` (${location})` : ""}. Check its syntax.`,
          );
        }
        const definition = parseDatasetDefinition(parsedJson);
        const schemaSql = await readWorkspaceText(root, definition.schemaPath);
        if (schemaSql === null) {
          throw new Error(`Schema file not found: ${definition.schemaPath}.`);
        }
        const operationSource = await readWorkspaceText(root, definition.operationsPath);
        if (operationSource === null) {
          throw new Error(`Operations file not found: ${definition.operationsPath}.`);
        }
        const compiledSource = await compileDatasetOperations(
          operationSource,
          definition.operationsPath,
        );
        const database = await initializeAppDatabase({
          schemaSql,
          tables: tableSqlNames(definition),
        });
        const existing = datasetsByPath.get(descriptorPath);
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
          datasetPath: descriptorPath,
          revision: rev,
          schemaSql,
          operationSource,
          compiledSource,
          database,
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
        const stored: StoredDataset = {
          datasetPath: prep.datasetPath,
          revision: prep.revision,
          schemaSql: prep.schemaSql,
          operationSource: prep.operationSource,
          compiledSource: prep.compiledSource,
          database: prep.database,
          generated: prep.generated,
          dataRevision: 1,
          idempotency: new Map(),
        };
        datasetsByPath.set(prep.datasetPath, stored);
        reportSnapshot(stored);
        return { kind: "approved", revision: prep.revision };
      }
      case "prepareSchemaChange": {
        const datasetPath = (await resolveWorkspacePath(root, req.datasetPath, "read")).normalized;
        const stored = datasetsByPath.get(datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${datasetPath}.`);
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
        const compiledSource = await compileDatasetOperations(
          operationSource,
          nextDefinition.operationsPath,
        );
        const migrated = await runAuthorizedMigration({
          workspaceId,
          stored,
          nextSchemaSql: schemaSql,
          nextTables: tableSqlNames(nextDefinition),
          migrationSql,
        });
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
        migrations.set(preparationId, {
          preparationId,
          datasetPath,
          previousRevision: stored.revision,
          nextRevision,
          schemaSql,
          operationSource,
          compiledSource,
          migrationSql,
          nextDatabase: migrated.nextDatabase,
          generated: stored.generated,
          approvalDigest,
          changeSha256,
          updatedFiles: {
            [datasetPath]: JSON.stringify(nextDefinition, null, 2) + "\n",
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
              tables: migrated.previewTables,
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
        const datasetPath = (await resolveWorkspacePath(root, req.datasetPath, "read")).normalized;
        const stored = datasetsByPath.get(datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${datasetPath}.`);
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
        const compiledSource = await compileDatasetOperations(
          operationSource,
          nextDefinition.operationsPath,
        );
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
          datasetPath,
          previousRevision: stored.revision,
          nextRevision,
          schemaSql,
          operationSource,
          compiledSource,
          migrationSql,
          nextDatabase: stored.database,
          generated: stored.generated,
          approvalDigest,
          changeSha256,
          updatedFiles: {
            [datasetPath]: JSON.stringify(nextDefinition, null, 2) + "\n",
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
        const datasetPath = (await resolveWorkspacePath(root, req.datasetPath, "read")).normalized;
        const migrationPath = req.migrationPath
          ? (await resolveWorkspacePath(root, req.migrationPath, "read")).normalized
          : null;
        const stored = datasetsByPath.get(datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${datasetPath}.`);
        const rawDef = await readWorkspaceText(root, datasetPath);
        if (rawDef === null) throw new Error(`Descriptor missing: ${datasetPath}.`);
        let migrationSql = "";
        if (migrationPath !== null) {
          const text = await readWorkspaceText(root, migrationPath);
          if (text === null || !text.trim()) {
            throw new Error(`Migration SQL file missing or empty: ${migrationPath}.`);
          }
          migrationSql = text;
        }
        let parsedDef: unknown;
        try {
          parsedDef = JSON.parse(rawDef);
        } catch (error) {
          const location = describeJsonSyntaxLocation(error);
          throw new Error(
            `${datasetPath} is not valid JSON${location ? ` (${location})` : ""}. Check its syntax.`,
          );
        }
        const nextDefinition = parseDatasetDefinition(parsedDef);
        const schemaSql =
          (await readWorkspaceText(root, nextDefinition.schemaPath)) ?? stored.schemaSql;
        const operationSource =
          (await readWorkspaceText(root, nextDefinition.operationsPath)) ?? stored.operationSource;
        const compiledSource = await compileDatasetOperations(
          operationSource,
          nextDefinition.operationsPath,
        );
        const migrated = await runAuthorizedMigration({
          workspaceId,
          stored,
          nextSchemaSql: schemaSql,
          nextTables: tableSqlNames(nextDefinition),
          migrationSql,
        });
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
          datasetPath,
          previousRevision: stored.revision,
          nextRevision,
          schemaSql,
          operationSource,
          compiledSource,
          migrationSql,
          nextDatabase: migrated.nextDatabase,
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
            preview: {
              tables: migrated.previewTables,
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
        if (pending.updatedFiles) {
          for (const [relPath, content] of Object.entries(pending.updatedFiles)) {
            await writeWorkspaceText(root, relPath, content, onWrite);
          }
        }
        stored.revision = pending.nextRevision;
        stored.schemaSql = pending.schemaSql;
        stored.operationSource = pending.operationSource;
        stored.compiledSource = pending.compiledSource;
        stored.database = pending.nextDatabase;
        stored.dataRevision += 1;
        migrations.delete(req.preparationId);
        reportSnapshot(stored);
        return {
          kind: "migrated",
          revision: stored.revision,
          cursor: makeCursor(workspaceId, stored),
        };
      }
      case "createForm": {
        const datasetPath = (await resolveWorkspacePath(root, req.datasetPath, "read")).normalized;
        const appRoot = (await resolveWorkspacePath(root, req.appRoot, "write")).normalized;
        const stored = datasetsByPath.get(datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${datasetPath}.`);
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
            datasetPath,
            revision: stored.revision.revision,
            revisionSha256: stored.revision.revisionSha256,
            operationIds: opIds,
          },
        };
        const htmlPath = posix.join(appRoot, "index.html");
        const jsPath = posix.join(appRoot, "form.js");
        const manifestPath = posix.join(appRoot, "app.publish.json");
        await writeWorkspaceText(
          root,
          htmlPath,
          `<!doctype html><title>${req.title ?? table.name}</title><script type="module" src="./form.js"></script>\n`,
          onWrite,
        );
        await writeWorkspaceText(
          root,
          jsPath,
          `// Connected form for ${table.name}\nwindow.addEventListener("message", () => {});\n`,
          onWrite,
        );
        await writeWorkspaceText(
          root,
          manifestPath,
          JSON.stringify(manifest, null, 2) + "\n",
          onWrite,
        );
        return {
          kind: "form-created",
          appRoot,
          paths: [htmlPath, jsPath, manifestPath],
        };
      }
      case "invoke": {
        const datasetPath = (await resolveWorkspacePath(root, req.datasetPath, "read")).normalized;
        const stored = datasetsByPath.get(datasetPath);
        if (!stored) throw new Error(`Collection reference broken: ${datasetPath}.`);
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
        try {
          const evaluated = await evaluateAppOperation({
            database: stored.database,
            source: stored.compiledSource,
            operation: op.name,
            caller: { kind: "owner" },
            input: req.input as JsonValue,
            nowMs: Date.now(),
            requestId: req.idempotencyKey,
            tables: tableSqlNames(stored.revision.definition),
            readOnly: op.readOnly,
          });
          if (!op.readOnly) {
            stored.database = evaluated.database;
            stored.dataRevision += 1;
            reportSnapshot(stored);
          }
          stored.idempotency.set(replayKey, {
            inputJson,
            result: evaluated.result,
            revision: stored.dataRevision,
          });
          return {
            kind: "invoked",
            result: evaluated.result,
            revision: stored.dataRevision,
            replayed: false,
          };
        } catch (error) {
          if (isAppBackendRuntimeError(error)) {
            return {
              kind: "refused",
              code: error.refusal.code,
              message: error.refusal.message,
            };
          }
          throw error;
        }
      }
      default:
        throw new Error(`Unsupported dataset action in everyday eval: ${req.action}.`);
    }
  }

  async function handleAppPublication(req: OwnerAppPublicationRequest): Promise<unknown> {
    assertWorkspace(req.workspaceId);
    switch (req.action) {
      case "verifyFrontend": {
        if (options.verifyFrontend) {
          const result = await options.verifyFrontend(req);
          onFrontendVerified?.(result.target.appRoot, {
            ...(result.target.kind === "candidate" && result.target.sourceRevision
              ? { sourceRevision: result.target.sourceRevision }
              : {}),
            ok: result.ok,
            stage: result.stage,
            ...(req.expectStartupBackend ? { expectStartupBackend: req.expectStartupBackend } : {}),
            ...(req.steps ? { steps: req.steps } : {}),
            brokerCalls: result.brokerCalls.map((call) => ({
              op: call.op,
              ...(call.operation ? { operation: call.operation } : {}),
              status: call.status,
              ok: call.ok,
              ...(call.refusalCode ? { refusalCode: call.refusalCode } : {}),
            })),
          });
          return result;
        }
        let targetAppRoot: string;
        let pubMeta: StoredAppPublication | undefined;
        if (req.publicationId !== undefined) {
          pubMeta = appPublications.get(req.publicationId);
          if (!pubMeta || !pubMeta.local) {
            throw new Error("This app approval changed. Prepare the app again.");
          }
          targetAppRoot = pubMeta.appRoot;
        } else {
          targetAppRoot = (await resolveWorkspacePath(root, req.appRoot!, "read")).normalized;
        }
        let manifest: Awaited<ReturnType<typeof parseAppManifestForEval>>;
        try {
          manifest = await parseAppManifestForEval(root, targetAppRoot);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const code: AppFrontendDiagnostic["code"] = /does not exist|not among its inputs/i.test(
            detail,
          )
            ? "missing_input"
            : "manifest_error";
          const failed = {
            kind: "frontendVerified" as const,
            ok: false,
            stage: "compile" as const,
            target: pubMeta
              ? {
                  kind: "publication" as const,
                  publicationId: pubMeta.publicationId,
                  appRoot: pubMeta.appRoot,
                  authorityRevision: pubMeta.authorityRevision,
                }
              : { kind: "candidate" as const, appRoot: targetAppRoot },
            startupOk: false,
            stepsOk: false,
            handshake: { delivered: false, messageCount: 0 },
            brokerCalls: [] as AppFrontendBrokerCall[],
            steps: [] as AppFrontendStepResult[],
            diagnostics: [
              {
                code,
                severity: "error" as const,
                detail: detail.slice(0, 200),
                remedy: "Fix app.publish.json and ensure all listed inputs exist.",
              },
            ],
            externalRequestsBlocked: 0,
          };
          onFrontendVerified?.(targetAppRoot, {
            ok: false,
            stage: "compile",
            brokerCalls: [],
          });
          return failed;
        }
        const contents = await Promise.all(
          manifest.inputs.map(async (p) => `${p}:${(await readWorkspaceText(root, p)) ?? ""}`),
        );
        const sourceRevision = sha256(contents.join("\n"));
        const target = pubMeta
          ? {
              kind: "publication" as const,
              publicationId: pubMeta.publicationId,
              appRoot: pubMeta.appRoot,
              authorityRevision: pubMeta.authorityRevision,
            }
          : { kind: "candidate" as const, appRoot: manifest.appRoot, sourceRevision };
        let approvedOpNames: Set<string> | undefined;
        if (manifest.dataset) {
          try {
            const datasetPath = (
              await resolveWorkspacePath(root, manifest.dataset.datasetPath, "read")
            ).normalized;
            const stored = datasetsByPath.get(datasetPath);
            if (!stored) throw new Error(`Collection reference broken: ${datasetPath}.`);
            const cap = resolveAppDatasetCapability(
              {
                kind: "dataset",
                datasetId: stored.revision.datasetId,
                revision: manifest.dataset.revision,
                revisionSha256: manifest.dataset.revisionSha256,
                operationIds: manifest.dataset.operationIds,
              },
              stored.revision,
              () => stored.generated,
            );
            approvedOpNames = new Set(cap.operations.map((op) => op.name));
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            onFrontendVerified?.(manifest.appRoot, {
              sourceRevision,
              ok: false,
              stage: "compile",
              brokerCalls: [],
            });
            return {
              kind: "frontendVerified" as const,
              ok: false,
              stage: "compile" as const,
              target,
              startupOk: false,
              stepsOk: false,
              handshake: { delivered: false, messageCount: 0 },
              brokerCalls: [],
              steps: [],
              diagnostics: [
                {
                  code: "dataset_binding_error" as const,
                  severity: "error" as const,
                  detail: detail.slice(0, 200),
                  remedy: "Verify datasetPath, revision, revisionSha256, and operationIds.",
                },
              ],
              externalRequestsBlocked: 0,
            };
          }
        }
        const entryHtml = (await readWorkspaceText(root, manifest.entryPath)) ?? "";
        const diagnostics: AppFrontendDiagnostic[] = [];
        const brokerCalls: AppFrontendBrokerCall[] = [];
        const stepResults: AppFrontendStepResult[] = [];
        const scriptParts: string[] = [];
        const normalizedInputs = new Set(manifest.inputs);
        if (/\bon(?:click|submit|change|input|load|error)\s*=/i.test(entryHtml)) {
          diagnostics.push({
            code: "csp_violation",
            severity: "error",
            directive: "script-src-attr",
            detail:
              "Inline event handler attribute violates the sandboxed app Content Security Policy.",
            remedy: "Attach event listeners with addEventListener in a listed module script.",
          });
        }
        for (const match of entryHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          const attrs = match[1] ?? "";
          const body = match[2] ?? "";
          const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
          if (srcMatch?.[1]) {
            const rawSrc = srcMatch[1].trim();
            if (!/^(?:https?:|data:|blob:)/i.test(rawSrc)) {
              const resolved = posix.normalize(
                posix.join(manifest.appRoot, rawSrc.replace(/[?#].*$/, "")),
              );
              if (!normalizedInputs.has(resolved)) {
                diagnostics.push({
                  code: "missing_input",
                  severity: "error",
                  detail: `Script src "${rawSrc}" is not listed in app.publish.json inputs.`,
                  remedy: "Add the referenced script path to inputs in app.publish.json.",
                });
              }
            }
          } else if (body.trim()) {
            scriptParts.push(body);
          }
        }
        for (const file of manifest.inputs) {
          if (/\.(?:c|m)?[jt]sx?$/i.test(file)) {
            const text = await readWorkspaceText(root, file);
            if (text) scriptParts.push(text);
          }
        }
        const scriptText = scriptParts.join("\n");
        const hasHandshake =
          scriptText.includes("dohc-app-channel") && /\bports\b/.test(scriptText);
        const handlesResponses = /\.onmessage\b|addEventListener\s*\(\s*["']message["']/i.test(
          scriptText.replace(/window\.addEventListener\s*\(\s*["']message["']/gi, ""),
        );
        if (approvedOpNames) {
          for (const opMatch of scriptText.matchAll(
            /\boperation\s*:\s*["']([A-Za-z][A-Za-z0-9_.-]{0,63})["']/g,
          )) {
            const opName = opMatch[1]!;
            if (!approvedOpNames.has(opName)) {
              brokerCalls.push({
                op: "backend.invoke",
                operation: opName,
                status: 404,
                ok: false,
                rejectedBy: "backend",
                reasonCode: "operation_not_approved",
              });
              diagnostics.push({
                code: "broker_operation_not_approved",
                severity: "error",
                op: "backend.invoke",
                operation: opName,
                detail: `Operation "${opName}" is not in app.publish.json dataset.operationIds.`,
                remedy: "Remove the unapproved operation call or add its operationId.",
              });
            }
          }
        }
        const checkBackendExpectation = (
          expected: NonNullable<typeof req.expectStartupBackend>[number],
          stepIndex?: number,
        ): boolean => {
          const opName = expected.operation;
          if (
            !hasHandshake ||
            !handlesResponses ||
            !scriptText.includes("backend.invoke") ||
            (opName && !scriptText.includes(opName)) ||
            (opName && approvedOpNames && !approvedOpNames.has(opName))
          ) {
            diagnostics.push({
              code: !hasHandshake ? "handshake_not_delivered" : "expected_backend_missing",
              severity: "error",
              ...(expected.op ? { op: expected.op } : {}),
              ...(opName ? { operation: opName } : {}),
              ...(stepIndex !== undefined ? { stepIndex } : {}),
              detail: !handlesResponses
                ? "Frontend sends backend.invoke without handling port responses."
                : `Expected backend call ${opName ?? expected.op ?? ""} did not match frontend code.`,
              remedy: "Wire dohc-app-channel port.onmessage and handle backend.invoke responses.",
            });
            return false;
          }
          const status = expected.status ?? 200;
          brokerCalls.push({
            op: expected.op ?? "backend.invoke",
            ...(opName ? { operation: opName } : {}),
            status,
            ok: status >= 200 && status < 300,
            ...(status === 409
              ? {
                  rejectedBy: "backend" as const,
                  reasonCode: "refused" as const,
                  ...(expected.refusalCode ? { refusalCode: expected.refusalCode } : {}),
                }
              : {}),
          });
          return true;
        };
        for (const expected of req.expectStartupBackend ?? []) {
          checkBackendExpectation(expected);
        }
        const startupOk = diagnostics.every((item) => item.severity !== "error");
        let stepsOk = true;
        const selectorMatches = (selector: string): boolean => {
          const idMatch = /#([A-Za-z0-9_-]+)/.exec(selector);
          if (idMatch?.[1]) {
            const id = idMatch[1];
            return (
              new RegExp(`id\\s*=\\s*["']${id}["']`).test(entryHtml) ||
              scriptText.includes(`"${id}"`) ||
              scriptText.includes(`'${id}'`)
            );
          }
          const nameMatch = /\[name\s*=\s*["']?([^"'\]]+)["']?\]/.exec(selector);
          if (nameMatch?.[1]) {
            return new RegExp(`name\\s*=\\s*["']${nameMatch[1]}["']`).test(entryHtml);
          }
          const tagMatch = /^([a-z][a-z0-9-]*)/i.exec(selector.trim());
          if (tagMatch?.[1]) {
            return new RegExp(`<${tagMatch[1]}\\b`, "i").test(entryHtml);
          }
          return true;
        };
        if (startupOk) {
          for (let index = 0; index < (req.steps ?? []).length; index++) {
            const step = req.steps![index]!;
            if (!selectorMatches(step.selector)) {
              stepsOk = false;
              const remedy = `Ensure selector "${step.selector}" exists in the app DOM.`;
              stepResults.push({
                index,
                kind: step.kind,
                ok: false,
                code: "step_selector_not_found",
                remedy,
              });
              diagnostics.push({
                code: "step_selector_not_found",
                severity: "error",
                stepIndex: index,
                detail: `Selector "${step.selector}" not found in app markup.`,
                remedy,
              });
              break;
            }
            if (
              step.kind === "click" &&
              /<form\b/i.test(entryHtml) &&
              /submit|button/i.test(step.selector) &&
              !scriptText.includes("preventDefault")
            ) {
              stepsOk = false;
              const remedy = "Call event.preventDefault() in the form submit handler.";
              stepResults.push({
                index,
                kind: step.kind,
                ok: false,
                code: "csp_violation",
                remedy,
              });
              diagnostics.push({
                code: "csp_violation",
                severity: "error",
                directive: "form-action",
                stepIndex: index,
                detail: "Form submission without preventDefault() violates form-action 'none'.",
                remedy,
              });
              break;
            }
            if (step.kind === "click" && step.expectBackend) {
              if (!checkBackendExpectation(step.expectBackend, index)) {
                stepsOk = false;
                const last = diagnostics[diagnostics.length - 1]!;
                stepResults.push({
                  index,
                  kind: step.kind,
                  ok: false,
                  code: last.code,
                  remedy: last.remedy,
                });
                break;
              }
            }
            stepResults.push({ index, kind: step.kind, ok: true });
          }
        } else {
          stepsOk = (req.steps ?? []).length === 0;
        }
        const ok = startupOk && stepsOk && diagnostics.every((item) => item.severity !== "error");
        const stage = !startupOk ? "runtime" : !stepsOk ? "steps" : "complete";
        onFrontendVerified?.(manifest.appRoot, {
          sourceRevision,
          ok,
          stage,
          ...(req.expectStartupBackend ? { expectStartupBackend: req.expectStartupBackend } : {}),
          ...(req.steps ? { steps: req.steps } : {}),
          brokerCalls: brokerCalls.map((call) => ({
            op: call.op,
            ...(call.operation ? { operation: call.operation } : {}),
            status: call.status,
            ok: call.ok,
            ...(call.refusalCode ? { refusalCode: call.refusalCode } : {}),
          })),
        });
        return {
          kind: "frontendVerified" as const,
          ok,
          stage,
          target,
          startupOk,
          stepsOk,
          handshake: { delivered: true, messageCount: brokerCalls.length },
          brokerCalls,
          steps: stepResults,
          diagnostics,
          externalRequestsBlocked: 0,
        };
      }
      case "createLink": {
        const appRoot = (await resolveWorkspacePath(root, req.appRoot, "read")).normalized;
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
        const paths: string[] = [];
        for (const p of req.paths ?? [appRoot]) {
          paths.push((await resolveWorkspacePath(root, p, "read")).normalized);
        }
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
        const appRoot = (await resolveWorkspacePath(root, req.appRoot, "read")).normalized;
        const publications = [...appPublications.values()]
          .filter((p) => p.local && p.appRoot === appRoot)
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
        const manifest = await parseAppManifestForEval(root, req.appRoot);
        const contents = await Promise.all(
          manifest.inputs.map(async (p) => `${p}:${(await readWorkspaceText(root, p)) ?? ""}`),
        );
        const sourceRevision = sha256(contents.join("\n"));
        return {
          kind: "localChecked",
          appRoot: manifest.appRoot,
          sourceRevision,
          sourcePaths: manifest.inputs,
        };
      }
      case "prepareLocal":
      case "prepare": {
        const manifest = await parseAppManifestForEval(root, req.appRoot);
        const capabilities = [];
        if (manifest.dataset) {
          const datasetPath = (
            await resolveWorkspacePath(root, manifest.dataset.datasetPath, "read")
          ).normalized;
          const stored = datasetsByPath.get(datasetPath);
          if (!stored) {
            throw new Error(
              `Collection reference broken: ${datasetPath}. Approve the Collection first or fix datasetPath in ${manifest.appRoot}/app.publish.json.`,
            );
          }
          const binding = resolveAppDatasetReferenceBinding(
            manifest.dataset,
            stored.revision.datasetId,
            stored.revision,
          );
          capabilities.push(
            resolveAppDatasetCapability(binding, stored.revision, () => stored.generated),
          );
        }
        const contents = await Promise.all(
          manifest.inputs.map(async (p) => `${p}:${(await readWorkspaceText(root, p)) ?? ""}`),
        );
        const sourceRevision = sha256(contents.join("\n"));
        const approvalId = randomUUID();
        const candidateDigest = sha256(
          `${manifest.appRoot}:${sourceRevision}:${JSON.stringify(capabilities)}`,
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
          appRoot: manifest.appRoot,
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
          appRoot: manifest.appRoot,
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

  async function handleWorkspaceSearch(args: Args) {
    const input = WorkspaceSearchInput.parse({
      query: args.query,
      ...(args.surfaces !== undefined ? { surfaces: args.surfaces } : {}),
      ...(args.pathPrefix !== undefined ? { pathPrefix: args.pathPrefix } : {}),
      ...(args.collectionPath !== undefined ? { collectionPath: args.collectionPath } : {}),
      ...(args.includeNeighbors !== undefined ? { includeNeighbors: args.includeNeighbors } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    const terms = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    const allowedSurfaces = new Set(input.surfaces ?? ["page", "collection", "record", "chat"]);
    const pathPrefix = input.pathPrefix
      ? (await resolveWorkspacePath(root, input.pathPrefix, "read")).normalized
      : undefined;
    const collectionFilter = input.collectionPath
      ? (await resolveWorkspacePath(root, input.collectionPath, "read")).normalized
      : undefined;
    const limit = input.limit ?? 20;
    const hits: WorkspaceSearchResult["results"] = [];
    const files = await listWorkspaceTextFiles(root);

    if (allowedSurfaces.has("page") || allowedSurfaces.has("collection")) {
      for (const [relPath, text] of files.entries()) {
        if (pathPrefix && relPath !== pathPrefix && !relPath.startsWith(`${pathPrefix}/`)) continue;
        const lower = `${relPath}\n${text}`.toLowerCase();
        const matchedTerms = terms.filter((term) => lower.includes(term));
        if (matchedTerms.length === 0) continue;
        const isCollection =
          relPath === "collection.yaml" ||
          relPath.endsWith("/collection.yaml") ||
          relPath === "dataset.json" ||
          relPath.endsWith("/dataset.json");
        if (isCollection && allowedSurfaces.has("collection")) {
          const folder = dirname(relPath).replaceAll("\\", "/");
          const colPath = folder === "." ? "" : folder;
          if (collectionFilter && colPath !== collectionFilter) continue;
          const isDataset = relPath.endsWith("dataset.json");
          hits.push({
            id: `collection:${relPath}`,
            kind: "collection",
            title: colPath || relPath,
            path: relPath,
            collectionKind: isDataset ? "transactional" : "document",
            ...(colPath ? { collectionPath: colPath } : {}),
            ...(isDataset ? { datasetPath: relPath } : {}),
            snippet: text.slice(0, 180).replace(/\s+/g, " ").trim(),
            matchedTerms,
            related: [],
          });
        } else if (relPath.endsWith(".md") && allowedSurfaces.has("page") && !collectionFilter) {
          hits.push({
            id: `page:${relPath}`,
            kind: "page",
            title: posix.basename(relPath, ".md"),
            path: relPath,
            snippet: text.slice(0, 180).replace(/\s+/g, " ").trim(),
            matchedTerms,
            related: [],
          });
        }
      }
    }

    if (allowedSurfaces.has("record")) {
      for (const [colPath, rows] of collections.entries()) {
        if (collectionFilter && colPath !== collectionFilter) continue;
        if (pathPrefix && colPath !== pathPrefix && !colPath.startsWith(`${pathPrefix}/`)) continue;
        for (const row of rows) {
          const serialized = `${row.path} ${JSON.stringify(row.values)}`.toLowerCase();
          const matchedTerms = terms.filter((term) => serialized.includes(term));
          if (matchedTerms.length === 0) continue;
          hits.push({
            id: `record:${row.id}`,
            kind: "record",
            title: posix.basename(row.path, ".md"),
            path: row.path,
            collectionPath: colPath,
            recordId: row.id,
            matchedFields: Object.entries(row.values)
              .filter(([, value]) =>
                matchedTerms.some((term) => String(value).toLowerCase().includes(term)),
              )
              .map(([name, value]) => ({ name, value: String(value) })),
            snippet: JSON.stringify(row.values).slice(0, 180),
            matchedTerms,
            related: [],
          });
        }
      }
    }

    const truncated = hits.length > limit;
    return WorkspaceSearchResult.parse({
      versionId: activeVersionId,
      results: hits.slice(0, limit),
      neighbors: [],
      complete: true,
      indexBuilding: false,
      policyDegraded: false,
      mountsCovered: true,
      sharedChannelRowsUncovered: 0,
      truncated,
    });
  }

  return {
    dataset: (args: Args) => serializeDataset(() => handleDataset(args.request as DatasetRequest)),
    appPublication: (args: Args) =>
      handleAppPublication(args.request as OwnerAppPublicationRequest),
    workspaceSearch: (args: Args) => handleWorkspaceSearch(args),
    automationList: async (args: Args) => {
      const colPath = (await resolveWorkspacePath(root, String(args.collectionPath), "read"))
        .normalized;
      const filePath = posix.join(colPath, "automations.yaml");
      const text = await readWorkspaceText(root, filePath);
      const content = text === null ? null : { text, contentHash: sha256(text), truncated: false };
      return { ok: true, definitions: automationDefinitionList(content, true) };
    },
    collectionQuery: async (args: Args) => {
      const colPath = (await resolveWorkspacePath(root, String(args.collectionPath), "read"))
        .normalized;
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
    collectionCreateRecord: async (args: Args) => {
      const colPath = (await resolveWorkspacePath(root, String(args.collectionPath), "write"))
        .normalized;
      const name = String(args.name);
      const fields = (args.fields as Record<string, unknown> | undefined) ?? {};
      const recordId =
        typeof args.recordId === "string" ? args.recordId : recordIdFor(recordCounter++);
      const recordPath = (
        await resolveWorkspacePath(root, posix.join(colPath, `${name}.md`), "write")
      ).normalized;
      const frontmatterLines = [
        "---",
        `dohc_record_id: ${recordId}`,
        ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
        "---",
        "",
        typeof args.body === "string" ? args.body : "",
      ];
      await writeWorkspaceText(root, recordPath, frontmatterLines.join("\n"), onWrite);
      const rows = collections.get(colPath) ?? [];
      rows.push({ id: recordId, path: recordPath, values: { ...fields } });
      collections.set(colPath, rows);
      return { ok: true, recordId, recordPath };
    },
    collectionSetFields: async (args: Args) => {
      const path = (await resolveWorkspacePath(root, String(args.path), "write")).normalized;
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
    versionCreate: async (args: Args) => {
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
        snapshots: await listWorkspaceTextFiles(root),
      };
      versions.push(created);
      activeVersionId = id;
      return { ok: true, version: { id: created.id, name: created.name } };
    },
    versionSwitch: async (args: Args) => {
      const wanted = String(args.version);
      const target = versions.find((v) => v.id === wanted || v.name === wanted);
      if (!target) return { ok: false, reason: `No version named "${wanted}".` };
      const current = versions.find((v) => v.id === activeVersionId);
      if (current) current.snapshots = await listWorkspaceTextFiles(root);
      let changed = 0;
      for (const [path, text] of target.snapshots.entries()) {
        if ((await readWorkspaceText(root, path)) !== text) {
          await writeWorkspaceText(root, path, text, onWrite);
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
    versionCompare: async (args: Args) => {
      const wanted = String(args.version);
      const target = versions.find((v) => v.id === wanted || v.name === wanted);
      if (!target) return { ok: false, reason: `No version named "${wanted}".` };
      const current = versions.find((v) => v.id === activeVersionId);
      if (current) current.snapshots = await listWorkspaceTextFiles(root);
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
    versionMerge: async (args: Args) => {
      const wanted = String(args.version);
      const target = versions.find((v) => v.id === wanted || v.name === wanted);
      if (!target) return { ok: false, reason: `No version named "${wanted}".` };
      const current = versions.find((v) => v.id === activeVersionId);
      if (current) current.snapshots = await listWorkspaceTextFiles(root);
      const main = versions[0]!;
      let merged = 0;
      let unchanged = 0;
      for (const [path, text] of target.snapshots.entries()) {
        if (main.snapshots.get(path) !== text) {
          main.snapshots.set(path, text);
          await writeWorkspaceText(root, path, text, onWrite);
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
    documentRead: (args: Args) => workspaceVerbs.documentRead!(root, args, onWrite),
    documentEdit: (args: Args) => workspaceVerbs.documentEdit!(root, args, onWrite),
    documentCreate: (args: Args) => workspaceVerbs.documentCreate!(root, args, onWrite),
    fileWrite: (args: Args) => workspaceVerbs.fileWrite!(root, args, onWrite),
  };
}
