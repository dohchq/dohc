import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import {
  parseAppPublicationCandidate,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import {
  parseApprovalAgent,
  type ApprovalAgent,
} from "@dohc/security-contract/approval-provenance";
import {
  isDatasetColumnField,
  parseDatasetDefinition,
  parseDatasetRevision,
  type AppDatasetReference,
  type DatasetDefinition,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { displayAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { MigrateDatasetInput } from "@dohc/app-backend-runtime/dataset-host";
import { DatasetMigrationCandidate } from "@dohc/cli/dataset";
import { StagedAppSummary, type StagedAppCollectionSummary } from "@dohc/cli/app-publication";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import { collectionChangeRows, describeCollectionChangeRow } from "./collectionChange";
import { hasGeneratedDatasetSources } from "./datasetFieldMigration";
import { assertSourcePathsNotDeferred } from "./datasetSourceCapture";
import type { LocalAppPrepared } from "./localAppStore";
import {
  APP_PUBLICATION_LIMITS,
  parseAppPublicationDeclaration,
  prepareLocalAppPublication,
} from "./ownerAppPublication";
import {
  localStateFolder,
  localStateOpened,
  LocalStateUnavailableError,
  readOwnedLocalStateFolder,
} from "./workspaceLocalState";

type SourceAdapter = Pick<
  VersionedLiveAdapter,
  "captureSourceMetadata" | "hydrateCapturedSources" | "listTextFileMetadata" | "workspace"
>;

const MAX_STAGE_COUNT = 8;
const MAX_COLLECTION_FILE_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

const activeStageApprovals = new Map<string, { stageId: string; appRoot: string | null }>();
const activeStageDiscards = new Map<string, number>();
const activeStagePublishes = new Map<string, Promise<void>>();

const normalizeStageId = (stageId: string): string => {
  if (!UUID_RE.test(stageId)) throw new Error("Invalid staged app id.");
  return stageId.toLowerCase();
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const decodeUtf8 = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const allowedWorkspacePath = (path: string) =>
  isShareablePath(path) &&
  !isSharedWithMePath(path) &&
  !path.toLowerCase().split("/").includes(".dohc");

const sameCursor = (a: DatasetCursor, b: DatasetCursor) =>
  a.workspaceId === b.workspaceId &&
  a.datasetId === b.datasetId &&
  a.hostEpoch === b.hostEpoch &&
  a.approvedRevisionHash === b.approvedRevisionHash &&
  a.revision === b.revision &&
  a.digest === b.digest;

export interface StagedDatasetApproved {
  revision: DatasetRevision;
  schemaSql: string;
  cursor: DatasetCursor;
  active: boolean;
  checkpointSha256?: string;
}

export interface LocalStagedAppsDependencies {
  workspaceId: string;
  workspaceRoot: string;
  attachmentId?: symbol;
  assertCurrent(): void;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  preflightCreate(input: {
    revision: DatasetRevision;
    schemaSql: string;
    operationSource: string;
    signal: AbortSignal;
  }): Promise<void>;
  tryApprovedArtifacts(
    datasetId: string,
    signal: AbortSignal,
  ): Promise<StagedDatasetApproved | null>;
  prepareCreate(input: {
    descriptorPath: string;
    adapter: Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
    signal: AbortSignal;
  }): Promise<{ preparationId: string; revision: DatasetRevision }>;
  approveCreate(input: {
    preparationId: string;
    revisionSha256: string;
    approvalAgent?: ApprovalAgent | null;
    signal: AbortSignal;
  }): Promise<DatasetRevision>;
  discardCreate(preparationId: string): void;
  prepareMigrationCandidate(input: MigrateDatasetInput): Promise<DatasetMigrationCandidate>;
  approveMigrationCandidate(input: {
    workspaceId: string;
    datasetId: string;
    candidateId: string;
    checkpointSha256: string;
    approvalAgent?: ApprovalAgent | null;
    signal?: AbortSignal;
  }): Promise<{ revision: DatasetRevision; cursor: DatasetCursor }>;
  discardMigrationCandidate(input: {
    workspaceId: string;
    datasetId: string;
    candidateId: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  activateApp(
    prepared: LocalAppPrepared,
    signal: AbortSignal,
    agent?: ApprovalAgent | null,
  ): Promise<{ publicationId: string; authorityRevision: number }>;
  withExclusiveDatasets?<T>(
    datasetIds: readonly string[],
    signal: AbortSignal,
    work: (exclusive?: {
      approveCreate?: LocalStagedAppsDependencies["approveCreate"];
      approveMigrationCandidate?: LocalStagedAppsDependencies["approveMigrationCandidate"];
    }) => Promise<T>,
  ): Promise<T>;
}

interface StoredCollectionStep {
  alias?: string;
  datasetId: string;
  name: string;
  datasetPath: string;
  schemaPath: string;
  operationsPath: string;
  action: "create" | "migrate" | "unchanged";
  previousRevision?: number;
  previousRevisionSha256?: string;
  expectedCursor?: DatasetCursor;
  targetRevision: number;
  targetRevisionSha256: string;
  migrationPath?: string | null;
  migrationSha256?: string;
  tables?: Array<{ name: string; fields: string[] }>;
  changes?: Array<{ kind: string; summary: string }>;
}

interface StoredReceipt {
  action: "create" | "migrate";
  revision: number;
  revisionSha256: string;
  completedAtMs: number;
}

interface StoredInProgressStep {
  datasetId: string;
  action: "create" | "migrate";
  targetRevisionSha256: string;
  migrationSha256?: string;
  checkpointSha256?: string;
}

interface StoredStageProposal {
  version: 1;
  stageId: string;
  workspaceId: string;
  appRoot: string;
  createdAtMs: number;
  reviewDigest: string;
  collections: StoredCollectionStep[];
  app: {
    candidate: AppPublicationCandidate;
    candidateDigest: string;
    sourceRevision: string;
    sourcePaths: string[];
    displayCapabilities: AppPublicationCandidate["capabilities"];
  };
  receipts: Record<string, StoredReceipt>;
  inProgress?: StoredInProgressStep;
}

function memorySourceAdapter(
  workspaceId: string,
  files: ReadonlyMap<string, Uint8Array>,
): Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources"> {
  return {
    async captureSourceMetadata({ paths }) {
      let totalBytes = 0;
      const captured = paths.map((path) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`Missing staged source file ${path}.`);
        totalBytes += bytes.byteLength;
        return {
          path,
          objectId: "",
          contentKind: "text" as const,
          sha256: sha256(bytes),
          byteLength: bytes.byteLength,
          latestMomentId: "",
        };
      });
      return {
        workspaceId,
        versionId: "main",
        sourceDigest: sha256(
          JSON.stringify(captured.map((entry) => [entry.path, entry.sha256, entry.byteLength])),
        ),
        totalBytes,
        files: captured,
      };
    },
    async hydrateCapturedSources(metadata) {
      return metadata.files.map((entry) => {
        const bytes = files.get(entry.path);
        if (!bytes) throw new Error(`Missing staged source file ${entry.path}.`);
        return { ...entry, bytes: Uint8Array.from(bytes) };
      });
    },
  };
}

async function writeAtomicFile(path: string, content: string | Uint8Array): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, content, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function summarizeStage(proposal: StoredStageProposal): StagedAppSummary {
  const collections: StagedAppCollectionSummary[] = proposal.collections.map((entry) => ({
    ...(entry.alias === undefined ? {} : { alias: entry.alias }),
    datasetId: entry.datasetId,
    name: entry.name,
    datasetPath: entry.datasetPath,
    action: entry.action,
    ...(entry.previousRevision === undefined ? {} : { previousRevision: entry.previousRevision }),
    targetRevision: entry.targetRevision,
    targetRevisionSha256: entry.targetRevisionSha256,
    ...(entry.migrationPath === undefined ? {} : { migrationPath: entry.migrationPath }),
    applied:
      entry.action === "unchanged" ||
      proposal.receipts[entry.datasetId]?.revisionSha256 === entry.targetRevisionSha256,
    ...(entry.tables === undefined ? {} : { tables: entry.tables }),
    ...(entry.changes === undefined ? {} : { changes: entry.changes }),
  }));
  return StagedAppSummary.parse({
    stageId: proposal.stageId,
    appRoot: proposal.appRoot,
    reviewDigest: proposal.reviewDigest,
    createdAtMs: proposal.createdAtMs,
    sourceRevision: proposal.app.sourceRevision,
    sourcePaths: proposal.app.sourcePaths,
    collections,
    capabilities: proposal.app.displayCapabilities,
    externalNetwork: true,
  });
}

function computeReviewDigest(input: {
  workspaceId: string;
  appRoot: string;
  collections: readonly StoredCollectionStep[];
  candidateDigest: string;
  sourceRevision: string;
  sourcePaths: readonly string[];
  displayCapabilities: readonly AppPublicationCandidate["capabilities"][number][];
}): string {
  return sha256(
    JSON.stringify([
      "dohc-staged-app-review-v2",
      input.workspaceId,
      input.appRoot,
      input.collections.map((entry) => [
        entry.alias ?? null,
        entry.datasetId,
        entry.name,
        entry.datasetPath,
        entry.action,
        entry.previousRevision ?? null,
        entry.previousRevisionSha256 ?? null,
        entry.targetRevision,
        entry.targetRevisionSha256,
        entry.migrationPath ?? null,
        entry.migrationSha256 ?? null,
        entry.tables ?? null,
        entry.changes ?? null,
      ]),
      input.candidateDigest,
      input.sourceRevision,
      input.sourcePaths,
      input.displayCapabilities,
    ]),
  );
}

function tablesSummary(definition: DatasetDefinition): Array<{ name: string; fields: string[] }> {
  return definition.tables.map((table) => ({
    name: table.name,
    fields: table.fields
      .filter((field) => !isDatasetColumnField(field) || field.sqlColumn !== table.primaryKey)
      .map((field) => field.name),
  }));
}

function formatChangeRow(row: Parameters<typeof describeCollectionChangeRow>[0]): {
  kind: string;
  summary: string;
} {
  const words = describeCollectionChangeRow(row, "present");
  const parts = [words.text, words.type, words.effect].filter(Boolean);
  return { kind: row.kind, summary: parts.join(" — ") };
}

export function createLocalStagedApps(deps: LocalStagedAppsDependencies) {
  const lockKey = `${deps.workspaceId}\0${deps.workspaceRoot}`;
  const discardKeyFor = (stageId: string) => `${lockKey}\0${stageId}`;
  const localState = {
    workspaceId: deps.workspaceId,
    rootPath: deps.workspaceRoot,
    attachmentId: deps.attachmentId,
  };
  const stagedRootForWrite = async (signal?: AbortSignal): Promise<string> => {
    const guard = { path: ".dohc/local/staged-apps", lead: "dohc could not stage this app." };
    try {
      return await localStateFolder(localState, "staged-apps", guard);
    } catch (error) {
      if (!(error instanceof LocalStateUnavailableError) || error.refusal !== "not-opened")
        throw error;
      await localStateOpened(localState, signal);
      return await localStateFolder(localState, "staged-apps", guard);
    }
  };
  const stageDirIn = (root: string, stageId: string) => join(root, normalizeStageId(stageId));
  const proposalPathIn = (root: string, stageId: string) =>
    join(stageDirIn(root, stageId), "proposal.json");
  const removeStageDir = async (
    root: string,
    rawStageId: string,
    strict: boolean,
  ): Promise<void> => {
    const id = normalizeStageId(rawStageId);
    if (activeStageApprovals.get(lockKey)?.stageId === id) {
      if (strict)
        throw new Error("This staged review is currently being approved and cannot be discarded.");
      return;
    }
    const discardKey = discardKeyFor(id);
    activeStageDiscards.set(discardKey, (activeStageDiscards.get(discardKey) ?? 0) + 1);
    try {
      await rm(stageDirIn(root, id), { recursive: true, force: true });
    } catch (error) {
      if (strict) throw error;
    } finally {
      const next = (activeStageDiscards.get(discardKey) ?? 1) - 1;
      if (next <= 0) activeStageDiscards.delete(discardKey);
      else activeStageDiscards.set(discardKey, next);
    }
  };

  async function readProposalIn(
    root: string,
    rawStageId: string,
  ): Promise<StoredStageProposal | null> {
    try {
      const stageId = normalizeStageId(rawStageId);
      const raw = await readFile(proposalPathIn(root, stageId), "utf8");
      const parsed = JSON.parse(raw) as StoredStageProposal;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.stageId !== "string" ||
        !UUID_RE.test(parsed.stageId) ||
        parsed.stageId.toLowerCase() !== stageId ||
        parsed.workspaceId !== deps.workspaceId ||
        !SHA256_RE.test(parsed.reviewDigest)
      )
        return null;
      parsed.stageId = stageId;
      parseAppPublicationCandidate(parsed.app.candidate, APP_PUBLICATION_LIMITS);
      if (
        sha256(JSON.stringify(parsed.app.candidate)) !== parsed.app.candidateDigest ||
        computeReviewDigest({
          workspaceId: parsed.workspaceId,
          appRoot: parsed.appRoot,
          collections: parsed.collections,
          candidateDigest: parsed.app.candidateDigest,
          sourceRevision: parsed.app.sourceRevision,
          sourcePaths: parsed.app.sourcePaths,
          displayCapabilities: parsed.app.displayCapabilities,
        }) !== parsed.reviewDigest
      )
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function listProposalsIn(root: string): Promise<StoredStageProposal[]> {
    deps.assertCurrent();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const found: StoredStageProposal[] = [];
    for (const name of entries) {
      if (!UUID_RE.test(name)) continue;
      const proposal = await readProposalIn(root, name);
      if (proposal) found.push(proposal);
    }
    found.sort((a, b) => b.createdAtMs - a.createdAtMs || a.stageId.localeCompare(b.stageId));
    return found;
  }

  return {
    async list(appRoot?: string): Promise<StagedAppSummary[]> {
      deps.assertCurrent();
      const proposals = await readOwnedLocalStateFolder(
        deps.workspaceRoot,
        "staged-apps",
        async (dir) => (dir === null || dir === "unusable" ? [] : listProposalsIn(dir)),
      );
      const filtered =
        appRoot === undefined
          ? proposals
          : proposals.filter((proposal) => proposal.appRoot === appRoot);
      return filtered.map(summarizeStage);
    },

    async discard(rawStageId: string): Promise<void> {
      deps.assertCurrent();
      const stageId = normalizeStageId(rawStageId);
      if (activeStageApprovals.get(lockKey)?.stageId === stageId)
        throw new Error("This staged review is currently being approved and cannot be discarded.");
      const root = await stagedRootForWrite();
      await removeStageDir(root, stageId, true);
    },

    async stage(input: {
      appRoot: string;
      migrations?: Record<string, string>;
      deferredWrites: readonly string[];
      adapter: SourceAdapter;
      signal: AbortSignal;
    }): Promise<StagedAppSummary> {
      deps.assertCurrent();
      input.signal.throwIfAborted();
      if (!allowedWorkspacePath(input.appRoot))
        throw new Error("Choose an app folder in this workspace.");
      const activeApproval = activeStageApprovals.get(lockKey);
      if (
        activeApproval &&
        (activeApproval.appRoot === null || activeApproval.appRoot === input.appRoot)
      )
        throw new Error(
          "A staged review for this app is currently being approved. Wait for it to finish.",
        );

      const captureFiles = async (paths: string[]) => {
        deps.assertCurrent();
        input.signal.throwIfAborted();
        const metadata = await input.adapter.captureSourceMetadata({
          workspaceId: deps.workspaceId,
          versionId: "main",
          paths,
          bounds: {
            maxInputFiles: Math.max(4, paths.length),
            maxInputBytes: MAX_COLLECTION_FILE_BYTES * Math.max(4, paths.length),
          },
          signal: input.signal,
        });
        const files = await input.adapter.hydrateCapturedSources(metadata, input.signal);
        deps.assertCurrent();
        input.signal.throwIfAborted();
        if (
          metadata.workspaceId !== deps.workspaceId ||
          files.length !== paths.length ||
          new Set(files.map((file) => file.path)).size !== paths.length ||
          files.some(
            (file) =>
              !paths.includes(file.path) ||
              file.bytes.byteLength > MAX_COLLECTION_FILE_BYTES ||
              sha256(file.bytes) !== file.sha256,
          )
        )
          throw new Error("Collection source capture failed. Stage the app again.");
        return files;
      };

      const manifestPath = `${input.appRoot}/app.publish.json`;
      assertSourcePathsNotDeferred(input.deferredWrites, [manifestPath]);
      const [manifestFile] = await captureFiles([manifestPath]);
      const folderListing = await input.adapter.listTextFileMetadata({
        workspaceId: deps.workspaceId,
        versionId: "main",
        under: input.appRoot,
      });
      deps.assertCurrent();
      input.signal.throwIfAborted();
      const declared = parseAppPublicationDeclaration(manifestFile!.bytes, input.appRoot, {
        folder: folderListing.map((entry) => entry.path),
      });
      const datasetBindings: ReadonlyArray<{ alias?: string; reference: AppDatasetReference }> =
        declared.datasets ?? (declared.dataset ? [{ reference: declared.dataset }] : []);

      const suppliedMigrations = input.migrations ?? {};
      const usedMigrationKeys = new Set<string>();
      const projectedRevisions = new Map<
        string,
        { revision: DatasetRevision; schemaSql: string }
      >();
      const capturedBlobs = new Map<
        string,
        {
          revision: DatasetRevision;
          definitionJson: string;
          schemaSql: string;
          operationSource: string;
          migrationSql?: string;
        }
      >();
      const steps: StoredCollectionStep[] = [];
      const seenDatasetIds = new Set<string>();

      for (const { alias, reference } of datasetBindings) {
        const descriptorPath = reference.datasetPath;
        if (
          !allowedWorkspacePath(descriptorPath) ||
          (descriptorPath !== "dataset.json" && !descriptorPath.endsWith("/dataset.json"))
        )
          throw new Error(`Choose a valid dataset.json path (${descriptorPath}).`);
        assertSourcePathsNotDeferred(input.deferredWrites, [descriptorPath]);

        const [firstDescriptor] = await captureFiles([descriptorPath]);
        const definition = parseDatasetDefinition(JSON.parse(decodeUtf8(firstDescriptor!.bytes)), {
          descriptorPath,
        });
        if (seenDatasetIds.has(definition.datasetId))
          throw new Error(
            `${input.appRoot}/app.publish.json binds the same Collection more than once.`,
          );
        seenDatasetIds.add(definition.datasetId);

        let migrationPath: string | null = null;
        if (alias !== undefined && Object.hasOwn(suppliedMigrations, alias)) {
          migrationPath = suppliedMigrations[alias]!;
          usedMigrationKeys.add(alias);
        } else if (Object.hasOwn(suppliedMigrations, descriptorPath)) {
          migrationPath = suppliedMigrations[descriptorPath]!;
          usedMigrationKeys.add(descriptorPath);
        }
        if (migrationPath !== null && !allowedWorkspacePath(migrationPath))
          throw new Error(`Choose a workspace migration file (${migrationPath}).`);

        const sourcePaths =
          migrationPath === null
            ? [descriptorPath, definition.schemaPath, definition.operationsPath]
            : [descriptorPath, definition.schemaPath, definition.operationsPath, migrationPath];
        if (
          new Set(sourcePaths).size !== sourcePaths.length ||
          sourcePaths.some((path) => !allowedWorkspacePath(path))
        )
          throw new Error("Choose separate Collection source files in this workspace.");
        assertSourcePathsNotDeferred(input.deferredWrites, sourcePaths);

        const captured = await captureFiles(sourcePaths);
        if (
          captured.find((file) => file.path === descriptorPath)!.sha256 !== firstDescriptor!.sha256
        )
          throw new Error("A Collection definition changed while staging. Stage again.");

        const readCaptured = (path: string) =>
          decodeUtf8(captured.find((file) => file.path === path)!.bytes);
        const schemaSql = readCaptured(definition.schemaPath);
        const operationSource = readCaptured(definition.operationsPath);

        const existing = await deps.tryApprovedArtifacts(definition.datasetId, input.signal);
        deps.assertCurrent();
        input.signal.throwIfAborted();

        if (!existing) {
          if (migrationPath !== null)
            throw new Error(
              `${definition.name} does not exist yet and does not take a migration file.`,
            );
          const targetRevision = describeDatasetRevision({
            definition,
            revision: 1,
            schemaSql,
            operationSource,
          });
          await deps.preflightCreate({
            revision: targetRevision,
            schemaSql,
            operationSource,
            signal: input.signal,
          });
          deps.assertCurrent();
          input.signal.throwIfAborted();

          projectedRevisions.set(definition.datasetId, { revision: targetRevision, schemaSql });
          capturedBlobs.set(definition.datasetId, {
            revision: targetRevision,
            definitionJson: JSON.stringify(definition),
            schemaSql,
            operationSource,
          });
          steps.push({
            ...(alias === undefined ? {} : { alias }),
            datasetId: definition.datasetId,
            name: definition.name,
            datasetPath: descriptorPath,
            schemaPath: definition.schemaPath,
            operationsPath: definition.operationsPath,
            action: "create",
            targetRevision: 1,
            targetRevisionSha256: targetRevision.revisionSha256,
            tables: tablesSummary(definition),
          });
          continue;
        }

        if (!existing.active)
          throw new Error(`Collection "${existing.revision.definition.name}" is unavailable.`);

        const sameRevisionCheck = describeDatasetRevision({
          definition,
          revision: existing.revision.revision,
          schemaSql,
          operationSource,
        });
        if (
          sameRevisionCheck.definitionSha256 === existing.revision.definitionSha256 &&
          sameRevisionCheck.schemaSha256 === existing.revision.schemaSha256 &&
          sameRevisionCheck.operationsSha256 === existing.revision.operationsSha256
        ) {
          if (migrationPath !== null)
            throw new Error(
              `${definition.name} already matches these rules (its migration may already have been applied) and does not take a migration file.`,
            );
          projectedRevisions.set(definition.datasetId, {
            revision: existing.revision,
            schemaSql: existing.schemaSql,
          });
          steps.push({
            ...(alias === undefined ? {} : { alias }),
            datasetId: definition.datasetId,
            name: existing.revision.definition.name,
            datasetPath: descriptorPath,
            schemaPath: definition.schemaPath,
            operationsPath: definition.operationsPath,
            action: "unchanged",
            previousRevision: existing.revision.revision,
            previousRevisionSha256: existing.revision.revisionSha256,
            targetRevision: existing.revision.revision,
            targetRevisionSha256: existing.revision.revisionSha256,
          });
          continue;
        }

        const targetRevision = describeDatasetRevision({
          definition,
          revision: existing.revision.revision + 1,
          schemaSql,
          operationSource,
        });
        let migrationSql: string;
        if (migrationPath === null) {
          if (targetRevision.schemaSha256 !== existing.revision.schemaSha256)
            throw new Error(
              `The schema for "${definition.name}" changed. Provide a migration file in migrations.`,
            );
          migrationSql = "SELECT 1;";
        } else {
          migrationSql = readCaptured(migrationPath);
          if (!migrationSql.trim() || migrationSql.includes("\0"))
            throw new Error(`The migration SQL for "${definition.name}" is empty or invalid.`);
        }

        const candidate = DatasetMigrationCandidate.parse(
          await deps.prepareMigrationCandidate({
            workspaceId: deps.workspaceId,
            revision: targetRevision,
            expected: existing.cursor,
            schemaSql,
            operationSource,
            migrationSql,
            signal: input.signal,
          }),
        );
        try {
          deps.assertCurrent();
          input.signal.throwIfAborted();
          if (
            !sameCursor(candidate.expected, existing.cursor) ||
            candidate.approvedRevisionHash !== targetRevision.revisionSha256
          )
            throw new Error(
              `Collection "${definition.name}" changed while staging. Stage the app again.`,
            );
          const rows = collectionChangeRows({
            previous: existing.revision,
            next: targetRevision,
            operationSource,
            migrationSql,
            migrationPath,
            counts: candidate.preview.tables,
          });
          projectedRevisions.set(definition.datasetId, { revision: targetRevision, schemaSql });
          capturedBlobs.set(definition.datasetId, {
            revision: targetRevision,
            definitionJson: JSON.stringify(definition),
            schemaSql,
            operationSource,
            migrationSql,
          });
          steps.push({
            ...(alias === undefined ? {} : { alias }),
            datasetId: definition.datasetId,
            name: definition.name,
            datasetPath: descriptorPath,
            schemaPath: definition.schemaPath,
            operationsPath: definition.operationsPath,
            action: "migrate",
            previousRevision: existing.revision.revision,
            previousRevisionSha256: existing.revision.revisionSha256,
            expectedCursor: existing.cursor,
            targetRevision: targetRevision.revision,
            targetRevisionSha256: targetRevision.revisionSha256,
            migrationPath,
            migrationSha256: sha256(migrationSql),
            changes: rows.map(formatChangeRow),
          });
        } finally {
          await deps
            .discardMigrationCandidate({
              workspaceId: deps.workspaceId,
              datasetId: definition.datasetId,
              candidateId: candidate.candidateId,
              signal: input.signal,
            })
            .catch(() => undefined);
        }
      }

      const unusedMigration = Object.keys(suppliedMigrations).find(
        (key) => !usedMigrationKeys.has(key),
      );
      if (unusedMigration !== undefined)
        throw new Error(
          `Migration entry "${unusedMigration}" does not match any Collection in ${manifestPath}.`,
        );

      steps.sort((a, b) => a.datasetId.localeCompare(b.datasetId));

      const preparedApp = await prepareLocalAppPublication(
        { workspaceId: deps.workspaceId, appRoot: input.appRoot },
        {
          adapter: input.adapter,
          signal: input.signal,
          assertCurrent: deps.assertCurrent,
          compile: deps.compile,
          deferredWrites: input.deferredWrites,
          resolveDatasetRevision: async (binding) => {
            const projected = projectedRevisions.get(binding.datasetId);
            if (!projected)
              throw new Error("A bound Collection was missing during staging. Stage again.");
            return projected.revision;
          },
        },
      );
      deps.assertCurrent();
      input.signal.throwIfAborted();
      if (preparedApp.candidate.external)
        throw new Error(
          "This app calls outside services with a workspace secret, so it can't be staged. Approve it in the dohc window.",
        );
      const compiledManifest = preparedApp.candidate.inputs.find(
        (entry) => entry.path === manifestPath,
      );
      if (!compiledManifest || compiledManifest.sha256 !== manifestFile!.sha256)
        throw new Error(`${manifestPath} changed while staging. Stage the app again.`);

      const candidateDigest = sha256(JSON.stringify(preparedApp.candidate));
      const displayCapabilities = preparedApp.candidate.capabilities.map((capability) => {
        if (capability.kind !== "dataset") return capability;
        const projected = projectedRevisions.get(capability.datasetId);
        return projected
          ? displayAppDatasetCapability(
              capability,
              projected.revision,
              hasGeneratedDatasetSources(projected.revision, projected.schemaSql),
            )
          : capability;
      });
      const sourcePaths = preparedApp.candidate.inputs.map((entry) => entry.path);
      const reviewDigest = computeReviewDigest({
        workspaceId: deps.workspaceId,
        appRoot: input.appRoot,
        collections: steps,
        candidateDigest,
        sourceRevision: preparedApp.candidate.sourceRevision,
        sourcePaths,
        displayCapabilities,
      });

      const stageId = randomUUID();
      const root = await stagedRootForWrite(input.signal);
      deps.assertCurrent();
      input.signal.throwIfAborted();
      const dir = stageDirIn(root, stageId);
      const bundleDir = join(dir, "bundle");
      const collectionsDir = join(dir, "collections");
      const proposal: StoredStageProposal = {
        version: 1,
        stageId,
        workspaceId: deps.workspaceId,
        appRoot: input.appRoot,
        createdAtMs: Date.now(),
        reviewDigest,
        collections: steps,
        app: {
          candidate: preparedApp.candidate,
          candidateDigest,
          sourceRevision: preparedApp.candidate.sourceRevision,
          sourcePaths,
          displayCapabilities,
        },
        receipts: {},
      };

      const publishKey = `${lockKey}\0${input.appRoot}`;
      const priorPublish = activeStagePublishes.get(publishKey) ?? Promise.resolve();
      let releasePublish!: () => void;
      const myTurn = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
      const publishTail = priorPublish.then(() => myTurn);
      activeStagePublishes.set(publishKey, publishTail);
      try {
        await priorPublish;
        deps.assertCurrent();
        input.signal.throwIfAborted();
        const activeNow = activeStageApprovals.get(lockKey);
        if (activeNow && (activeNow.appRoot === null || activeNow.appRoot === input.appRoot))
          throw new Error(
            "A staged review for this app is currently being approved. Wait for it to finish.",
          );

        const previousForRoot = (await listProposalsIn(root)).filter(
          (existing) => existing.appRoot === input.appRoot,
        );
        await mkdir(bundleDir, { recursive: true, mode: 0o700 });
        await mkdir(collectionsDir, { recursive: true, mode: 0o700 });
        try {
          for (const file of preparedApp.files) {
            if (!SHA256_RE.test(file.sha256))
              throw new Error("Invalid compiled app artifact hash.");
            await writeAtomicFile(join(bundleDir, file.sha256), file.bytes);
          }
          for (const [datasetId, blob] of capturedBlobs) {
            const colDir = join(collectionsDir, datasetId);
            await mkdir(colDir, { recursive: true, mode: 0o700 });
            await writeAtomicFile(join(colDir, "definition.json"), blob.definitionJson);
            await writeAtomicFile(join(colDir, "schema.sql"), blob.schemaSql);
            await writeAtomicFile(join(colDir, "operations.js"), blob.operationSource);
            await writeAtomicFile(join(colDir, "revision.json"), JSON.stringify(blob.revision));
            if (blob.migrationSql !== undefined) {
              await writeAtomicFile(join(colDir, "migration.sql"), blob.migrationSql);
            }
          }
          deps.assertCurrent();
          input.signal.throwIfAborted();
          await writeAtomicFile(proposalPathIn(root, stageId), JSON.stringify(proposal, null, 2));
          deps.assertCurrent();
          input.signal.throwIfAborted();
        } catch (error) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }

        for (const old of previousForRoot) {
          await removeStageDir(root, old.stageId, false);
        }
        const allNow = await listProposalsIn(root);
        for (const overflow of allNow.slice(MAX_STAGE_COUNT)) {
          if (Object.keys(overflow.receipts).length > 0 || overflow.inProgress !== undefined)
            continue;
          await removeStageDir(root, overflow.stageId, false);
        }
        return summarizeStage(proposal);
      } finally {
        releasePublish();
        if (activeStagePublishes.get(publishKey) === publishTail)
          activeStagePublishes.delete(publishKey);
      }
    },

    async approve(input: {
      stageId: string;
      reviewDigest: string;
      agent?: ApprovalAgent | null;
      signal: AbortSignal;
    }): Promise<{
      stageId: string;
      publicationId: string;
      authorityRevision: number;
      collectionsApplied: Array<{
        datasetId: string;
        action: "create" | "migrate";
        revision: number;
        revisionSha256: string;
      }>;
    }> {
      deps.assertCurrent();
      input.signal.throwIfAborted();
      const stageId = normalizeStageId(input.stageId);
      const running = activeStageApprovals.get(lockKey);
      if (running)
        throw new Error(
          running.stageId === stageId
            ? "This staged review is already being approved."
            : "Another staged review is currently being approved for this workspace. Wait for it to finish.",
        );
      if ((activeStageDiscards.get(discardKeyFor(stageId)) ?? 0) > 0)
        throw new Error("This staged review is being discarded. Stage the app again.");
      activeStageApprovals.set(lockKey, { stageId, appRoot: null });
      try {
        const agent = parseApprovalAgent(input.agent);
        const root = await stagedRootForWrite(input.signal);
        deps.assertCurrent();
        input.signal.throwIfAborted();
        const proposal = await readProposalIn(root, stageId);
        if (!proposal) throw new Error("This staged review was not found. Stage the app again.");
        activeStageApprovals.set(lockKey, { stageId, appRoot: proposal.appRoot });
        const recomputedDigest = computeReviewDigest({
          workspaceId: proposal.workspaceId,
          appRoot: proposal.appRoot,
          collections: proposal.collections,
          candidateDigest: proposal.app.candidateDigest,
          sourceRevision: proposal.app.sourceRevision,
          sourcePaths: proposal.app.sourcePaths,
          displayCapabilities: proposal.app.displayCapabilities,
        });
        if (
          proposal.reviewDigest !== input.reviewDigest ||
          recomputedDigest !== input.reviewDigest ||
          sha256(JSON.stringify(proposal.app.candidate)) !== proposal.app.candidateDigest
        )
          throw new Error("This staged review changed or expired. Stage the app again.");

        const dir = stageDirIn(root, stageId);
        const bundleDir = join(dir, "bundle");
        const collectionsDir = join(dir, "collections");

        const readStagedFile = async (path: string, message: string): Promise<Buffer> => {
          try {
            return await readFile(path);
          } catch {
            throw new Error(message);
          }
        };

        const verifiedBundleFiles: ClosedAppBuild["files"] = [];
        for (const fileMeta of proposal.app.candidate.files) {
          if (!SHA256_RE.test(fileMeta.sha256))
            throw new Error("Staged bundle metadata is invalid. Stage the app again.");
          const bytes = await readStagedFile(
            join(bundleDir, fileMeta.sha256),
            "Staged app bundle failed integrity check. Stage the app again.",
          );
          if (bytes.byteLength !== fileMeta.byteLength || sha256(bytes) !== fileMeta.sha256)
            throw new Error("Staged app bundle failed integrity check. Stage the app again.");
          verifiedBundleFiles.push({ ...fileMeta, bytes: Uint8Array.from(bytes) });
        }

        const verifiedCollections = new Map<
          string,
          {
            revision: DatasetRevision;
            definitionBytes: Uint8Array;
            schemaBytes: Uint8Array;
            operationsBytes: Uint8Array;
            schemaSql: string;
            operationSource: string;
            migrationSql?: string;
          }
        >();
        for (const step of proposal.collections) {
          if (step.action === "unchanged") continue;
          const colDir = join(collectionsDir, step.datasetId);
          const integrityMessage = `Staged files for Collection "${step.name}" failed integrity check. Stage the app again.`;
          const [definitionBytes, schemaBytes, operationsBytes, revisionBytes] = await Promise.all([
            readStagedFile(join(colDir, "definition.json"), integrityMessage),
            readStagedFile(join(colDir, "schema.sql"), integrityMessage),
            readStagedFile(join(colDir, "operations.js"), integrityMessage),
            readStagedFile(join(colDir, "revision.json"), integrityMessage),
          ]);
          let storedRevision: DatasetRevision;
          let schemaSql: string;
          let operationSource: string;
          let definition: DatasetDefinition;
          let checked: DatasetRevision;
          try {
            storedRevision = parseDatasetRevision(JSON.parse(decodeUtf8(revisionBytes)));
            schemaSql = decodeUtf8(schemaBytes);
            operationSource = decodeUtf8(operationsBytes);
            definition = parseDatasetDefinition(JSON.parse(decodeUtf8(definitionBytes)), {
              descriptorPath: step.datasetPath,
            });
            checked = parseDatasetRevision(
              describeDatasetRevision({
                definition,
                revision: step.targetRevision,
                schemaSql,
                operationSource,
              }),
            );
          } catch {
            throw new Error(integrityMessage);
          }
          if (
            definition.datasetId !== step.datasetId ||
            storedRevision.revisionSha256 !== step.targetRevisionSha256 ||
            checked.revisionSha256 !== step.targetRevisionSha256 ||
            JSON.stringify(storedRevision) !== JSON.stringify(checked)
          )
            throw new Error(integrityMessage);
          let migrationSql: string | undefined;
          if (step.action === "migrate") {
            const migrationMessage = `Staged migration for Collection "${step.name}" failed integrity check. Stage the app again.`;
            const migrationBytes = await readStagedFile(
              join(colDir, "migration.sql"),
              migrationMessage,
            );
            try {
              migrationSql = decodeUtf8(migrationBytes);
            } catch {
              throw new Error(migrationMessage);
            }
            if (sha256(migrationSql) !== step.migrationSha256) throw new Error(migrationMessage);
          }
          verifiedCollections.set(step.datasetId, {
            revision: checked,
            definitionBytes: Uint8Array.from(definitionBytes),
            schemaBytes: Uint8Array.from(schemaBytes),
            operationsBytes: Uint8Array.from(operationsBytes),
            schemaSql,
            operationSource,
            migrationSql,
          });
        }

        const runCommit = async (exclusive?: {
          approveCreate?: LocalStagedAppsDependencies["approveCreate"];
          approveMigrationCandidate?: LocalStagedAppsDependencies["approveMigrationCandidate"];
        }) => {
          const approveCreate = exclusive?.approveCreate ?? deps.approveCreate;
          const approveMigrationCandidate =
            exclusive?.approveMigrationCandidate ?? deps.approveMigrationCandidate;
          const matchesInProgress = (
            step: StoredCollectionStep,
            existing?: StagedDatasetApproved | null,
          ) => {
            if (
              step.action === "unchanged" ||
              proposal.inProgress?.datasetId !== step.datasetId ||
              proposal.inProgress.action !== step.action ||
              proposal.inProgress.targetRevisionSha256 !== step.targetRevisionSha256
            )
              return false;
            if (step.action === "create") {
              if (!existing) return true;
              return (
                existing.revision.revision === step.targetRevision &&
                existing.revision.revisionSha256 === step.targetRevisionSha256 &&
                existing.cursor.revision === 0
              );
            }
            if (
              proposal.inProgress.migrationSha256 !== step.migrationSha256 ||
              typeof proposal.inProgress.checkpointSha256 !== "string" ||
              !SHA256_RE.test(proposal.inProgress.checkpointSha256)
            )
              return false;
            if (!existing) return true;
            return (
              existing.revision.revision === step.targetRevision &&
              existing.revision.revisionSha256 === step.targetRevisionSha256 &&
              existing.checkpointSha256 === proposal.inProgress.checkpointSha256
            );
          };
          for (const step of proposal.collections) {
            deps.assertCurrent();
            input.signal.throwIfAborted();
            const existing = await deps.tryApprovedArtifacts(step.datasetId, input.signal);
            deps.assertCurrent();
            input.signal.throwIfAborted();
            const receiptMatches =
              step.action !== "unchanged" &&
              proposal.receipts[step.datasetId]?.revisionSha256 === step.targetRevisionSha256;
            if (step.action === "unchanged" || receiptMatches) {
              if (
                !existing ||
                !existing.active ||
                existing.revision.revisionSha256 !== step.targetRevisionSha256
              )
                throw new Error(
                  `Collection "${step.name}" changed or is unavailable. Stage the app again.`,
                );
              continue;
            }
            if (step.action === "create") {
              if (existing) {
                if (!existing.active)
                  throw new Error(
                    `Collection "${step.name}" is unavailable. Restore it and stage the app again.`,
                  );
                if (!matchesInProgress(step, existing))
                  throw new Error(`Collection "${step.name}" already exists. Stage the app again.`);
              }
              continue;
            }
            if (!existing || !existing.active)
              throw new Error(
                `Collection "${step.name}" is unavailable. Restore it and stage the app again.`,
              );
            if (existing.revision.revisionSha256 === step.targetRevisionSha256) {
              if (matchesInProgress(step, existing)) continue;
              throw new Error(
                `Collection "${step.name}" changed after staging. Stage the app again.`,
              );
            }
            if (!step.expectedCursor || !sameCursor(existing.cursor, step.expectedCursor))
              throw new Error(
                `Collection "${step.name}" changed after staging. Stage the app again.`,
              );
          }

          const saveProposal = async () => {
            await writeAtomicFile(proposalPathIn(root, stageId), JSON.stringify(proposal, null, 2));
          };
          const markInProgress = async (step: StoredCollectionStep, checkpointSha256?: string) => {
            if (step.action === "unchanged") return;
            proposal.inProgress = {
              datasetId: step.datasetId,
              action: step.action,
              targetRevisionSha256: step.targetRevisionSha256,
              ...(step.migrationSha256 === undefined
                ? {}
                : { migrationSha256: step.migrationSha256 }),
              ...(checkpointSha256 === undefined ? {} : { checkpointSha256 }),
            };
            await saveProposal();
          };
          const clearUncommittedInProgress = async (step: StoredCollectionStep) => {
            if (!matchesInProgress(step)) return;
            try {
              const live = await deps.tryApprovedArtifacts(
                step.datasetId,
                new AbortController().signal,
              );
              if (live && matchesInProgress(step, live)) return;
            } catch {
              return;
            }
            delete proposal.inProgress;
            await saveProposal().catch(() => undefined);
          };
          const persistReceipt = async (datasetId: string, receipt: StoredReceipt) => {
            proposal.receipts[datasetId] = receipt;
            if (proposal.inProgress?.datasetId === datasetId) delete proposal.inProgress;
            await saveProposal();
          };

          const collectionsApplied: Array<{
            datasetId: string;
            action: "create" | "migrate";
            revision: number;
            revisionSha256: string;
          }> = [];

          for (const step of proposal.collections) {
            deps.assertCurrent();
            input.signal.throwIfAborted();
            if (step.action === "unchanged") continue;

            const existingReceipt = proposal.receipts[step.datasetId];
            if (existingReceipt?.revisionSha256 === step.targetRevisionSha256) {
              collectionsApplied.push({
                datasetId: step.datasetId,
                action: step.action,
                revision: existingReceipt.revision,
                revisionSha256: existingReceipt.revisionSha256,
              });
              continue;
            }

            const blobs = verifiedCollections.get(step.datasetId)!;
            const existing = await deps.tryApprovedArtifacts(step.datasetId, input.signal);
            deps.assertCurrent();
            input.signal.throwIfAborted();

            if (step.action === "create") {
              if (existing) {
                if (!existing.active)
                  throw new Error(
                    `Collection "${step.name}" is unavailable. Restore it and stage the app again.`,
                  );
                if (
                  matchesInProgress(step, existing) &&
                  existing.revision.revisionSha256 === step.targetRevisionSha256
                ) {
                  await persistReceipt(step.datasetId, {
                    action: "create",
                    revision: existing.revision.revision,
                    revisionSha256: existing.revision.revisionSha256,
                    completedAtMs: Date.now(),
                  });
                  collectionsApplied.push({
                    datasetId: step.datasetId,
                    action: "create",
                    revision: existing.revision.revision,
                    revisionSha256: existing.revision.revisionSha256,
                  });
                  continue;
                }
                throw new Error(`Collection "${step.name}" already exists. Stage the app again.`);
              }

              const memFiles = new Map<string, Uint8Array>([
                [step.datasetPath, blobs.definitionBytes],
                [step.schemaPath, blobs.schemaBytes],
                [step.operationsPath, blobs.operationsBytes],
              ]);
              const prepared = await deps.prepareCreate({
                descriptorPath: step.datasetPath,
                adapter: memorySourceAdapter(deps.workspaceId, memFiles),
                signal: input.signal,
              });
              if (prepared.revision.revisionSha256 !== step.targetRevisionSha256) {
                deps.discardCreate(prepared.preparationId);
                throw new Error(
                  `Staged Collection "${step.name}" no longer matches its review digest. Stage again.`,
                );
              }
              let approved: DatasetRevision;
              try {
                await markInProgress(step);
                approved = await approveCreate({
                  preparationId: prepared.preparationId,
                  revisionSha256: prepared.revision.revisionSha256,
                  approvalAgent: agent,
                  signal: input.signal,
                });
              } catch (error) {
                deps.discardCreate(prepared.preparationId);
                await clearUncommittedInProgress(step);
                throw error;
              }
              deps.assertCurrent();
              if (approved.revisionSha256 !== step.targetRevisionSha256)
                throw new Error(`Collection "${step.name}" did not confirm the reviewed revision.`);
              await persistReceipt(step.datasetId, {
                action: "create",
                revision: approved.revision,
                revisionSha256: approved.revisionSha256,
                completedAtMs: Date.now(),
              });
              collectionsApplied.push({
                datasetId: step.datasetId,
                action: "create",
                revision: approved.revision,
                revisionSha256: approved.revisionSha256,
              });
              continue;
            }

            if (!existing || !existing.active)
              throw new Error(
                `Collection "${step.name}" is unavailable. Restore it and stage the app again.`,
              );
            if (existing.revision.revisionSha256 === step.targetRevisionSha256) {
              if (!matchesInProgress(step, existing))
                throw new Error(
                  `Collection "${step.name}" changed after staging. Stage the app again.`,
                );
              await persistReceipt(step.datasetId, {
                action: "migrate",
                revision: existing.revision.revision,
                revisionSha256: existing.revision.revisionSha256,
                completedAtMs: Date.now(),
              });
              collectionsApplied.push({
                datasetId: step.datasetId,
                action: "migrate",
                revision: existing.revision.revision,
                revisionSha256: existing.revision.revisionSha256,
              });
              continue;
            }
            if (!step.expectedCursor || !sameCursor(existing.cursor, step.expectedCursor))
              throw new Error(
                `Collection "${step.name}" changed after staging. Stage the app again.`,
              );

            const candidate = DatasetMigrationCandidate.parse(
              await deps.prepareMigrationCandidate({
                workspaceId: deps.workspaceId,
                revision: blobs.revision,
                expected: step.expectedCursor,
                schemaSql: blobs.schemaSql,
                operationSource: blobs.operationSource,
                migrationSql: blobs.migrationSql!,
                signal: input.signal,
              }),
            );
            let approving = false;
            try {
              deps.assertCurrent();
              input.signal.throwIfAborted();
              if (
                !sameCursor(candidate.expected, step.expectedCursor) ||
                candidate.approvedRevisionHash !== step.targetRevisionSha256
              )
                throw new Error(
                  `Collection "${step.name}" changed while applying. Stage the app again.`,
                );
              await markInProgress(step, candidate.checkpointSha256);
              approving = true;
              let migrated: { revision: DatasetRevision; cursor: DatasetCursor };
              try {
                migrated = await approveMigrationCandidate({
                  workspaceId: deps.workspaceId,
                  datasetId: step.datasetId,
                  candidateId: candidate.candidateId,
                  checkpointSha256: candidate.checkpointSha256,
                  approvalAgent: agent,
                  signal: input.signal,
                });
              } catch (error) {
                await clearUncommittedInProgress(step);
                throw error;
              }
              deps.assertCurrent();
              if (migrated.revision.revisionSha256 !== step.targetRevisionSha256)
                throw new Error(`Collection "${step.name}" did not confirm the reviewed update.`);
              await persistReceipt(step.datasetId, {
                action: "migrate",
                revision: migrated.revision.revision,
                revisionSha256: migrated.revision.revisionSha256,
                completedAtMs: Date.now(),
              });
              collectionsApplied.push({
                datasetId: step.datasetId,
                action: "migrate",
                revision: migrated.revision.revision,
                revisionSha256: migrated.revision.revisionSha256,
              });
            } finally {
              if (!approving) {
                await deps
                  .discardMigrationCandidate({
                    workspaceId: deps.workspaceId,
                    datasetId: step.datasetId,
                    candidateId: candidate.candidateId,
                    signal: input.signal,
                  })
                  .catch(() => undefined);
              }
            }
          }

          const activated = await deps.activateApp(
            {
              candidate: proposal.app.candidate,
              files: verifiedBundleFiles,
            },
            input.signal,
            agent,
          );
          deps.assertCurrent();
          return { activated, collectionsApplied };
        };

        const datasetIds = proposal.collections.map((step) => step.datasetId);
        const { activated, collectionsApplied } =
          deps.withExclusiveDatasets && datasetIds.length > 0
            ? await deps.withExclusiveDatasets(datasetIds, input.signal, runCommit)
            : await runCommit();
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        return {
          stageId,
          publicationId: activated.publicationId,
          authorityRevision: activated.authorityRevision,
          collectionsApplied,
        };
      } finally {
        activeStageApprovals.delete(lockKey);
      }
    },
  };
}
