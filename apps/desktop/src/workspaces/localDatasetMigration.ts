import { createHash, randomUUID } from "node:crypto";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { parseDatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { MigrateDatasetInput } from "@dohc/app-backend-runtime/dataset-host";
import { DatasetMigrationCandidate } from "@dohc/cli/dataset";

type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
export interface LocalDatasetMigrationPreparation {
  preparationId: string;
  previousRevision: DatasetRevision;
  revision: DatasetRevision;
  expected: DatasetCursor;
  sourceDigest: string;
  approvalDigest: string;
  schemaSql: string;
  operationSource: string;
  migrationSql: string;
  expiresAtMs: number;
  candidate: DatasetMigrationCandidate;
}
export interface PrepareLocalDatasetMigration {
  datasetId: string;
  descriptorPath: string;
  migrationPath: string;
  adapter: SourceAdapter;
  signal?: AbortSignal;
}
const maximumBytes = 256 * 1024;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const allowed = (path: string) => isShareablePath(path) && !isSharedWithMePath(path) && !path.toLowerCase().split("/").includes(".dohc");
const sameCursor = (a: DatasetCursor, b: DatasetCursor) => a.workspaceId === b.workspaceId && a.datasetId === b.datasetId
  && a.hostEpoch === b.hostEpoch && a.approvedRevisionHash === b.approvedRevisionHash && a.revision === b.revision && a.digest === b.digest;

interface MigrationAuthority {
  workspaceId: string;
  assertCurrent(): void;
  approvedArtifacts(datasetId: string): { revision: DatasetRevision; cursor: DatasetCursor; active: boolean } | Promise<{ revision: DatasetRevision; cursor: DatasetCursor; active: boolean }>;
  prepareMigrationCandidate(input: MigrateDatasetInput): Promise<DatasetMigrationCandidate>;
  approveMigrationCandidate(input: { workspaceId: string; datasetId: string; candidateId: string; checkpointSha256: string; signal?: AbortSignal }): Promise<{ revision: DatasetRevision; cursor: DatasetCursor }>;
  discardMigrationCandidate(input: { workspaceId: string; datasetId: string; candidateId: string; signal?: AbortSignal }): Promise<unknown>;
}
type MigrationApproval = { preparationId: string; revisionSha256: string; approvalDigest: string; signal?: AbortSignal };

async function assertMigrationCursor(dependencies: MigrationAuthority, expected: DatasetCursor) {
  dependencies.assertCurrent();
  const head = await dependencies.approvedArtifacts(expected.datasetId);
  dependencies.assertCurrent();
  if (!head.active || !sameCursor(expected, head.cursor)) throw new Error("This Collection changed after review started. Prepare the change again.");
}

/** The caller consumes its saved review before entering this fresh approval authority. */
export async function approveLocalDatasetMigration(dependencies: MigrationAuthority, review: LocalDatasetMigrationPreparation, input: MigrationApproval) {
  dependencies.assertCurrent(); input.signal?.throwIfAborted();
  if (review.preparationId !== input.preparationId || review.expiresAtMs <= Date.now() || review.revision.revisionSha256 !== input.revisionSha256 || review.approvalDigest !== input.approvalDigest) {
    throw new Error("This Collection approval expired or changed. Prepare the change again.");
  }
  await assertMigrationCursor(dependencies, review.expected);
  const result = await dependencies.approveMigrationCandidate({ workspaceId: dependencies.workspaceId, datasetId: review.revision.datasetId,
    candidateId: review.candidate.candidateId, checkpointSha256: review.candidate.checkpointSha256, signal: input.signal });
  dependencies.assertCurrent();
  if (result.revision.revisionSha256 !== review.revision.revisionSha256 || result.revision.datasetId !== review.revision.datasetId ||
      result.cursor.workspaceId !== dependencies.workspaceId || result.cursor.datasetId !== review.revision.datasetId ||
      result.cursor.hostEpoch !== review.expected.hostEpoch || result.cursor.approvedRevisionHash !== review.revision.revisionSha256 || result.cursor.revision !== review.expected.revision + 1) {
    throw new Error("The server did not confirm this Collection change. Refresh the Collection before reviewing it again.");
  }
  return result;
}

/** Reviews retain captured bytes and the complete data cursor, never paths to reread at approval. */
export function createLocalDatasetMigrations(dependencies: MigrationAuthority) {
  const pending = new Map<string, LocalDatasetMigrationPreparation>();
  let preparing = 0;
  const current = (expected: DatasetCursor) => assertMigrationCursor(dependencies, expected);
  return {
    async prepareMigration(input: PrepareLocalDatasetMigration): Promise<LocalDatasetMigrationPreparation> {
      dependencies.assertCurrent(); input.signal?.throwIfAborted();
      const abort = input.signal ?? new AbortController().signal;
      for (const [key, value] of pending) if (value.expiresAtMs <= Date.now()) pending.delete(key);
      if (pending.size + preparing >= 8) throw new Error("Too many Collection changes await approval. Finish or discard a review.");
      if (!allowed(input.descriptorPath) || !allowed(input.migrationPath)
        || (input.descriptorPath !== "dataset.json" && !input.descriptorPath.endsWith("/dataset.json"))) throw new Error("Choose Collection sources in this workspace.");
      preparing++;
      try {
        const previous = await dependencies.approvedArtifacts(input.datasetId);
        await current(previous.cursor);
        const capture = async (paths: string[]) => {
          await current(previous.cursor); input.signal?.throwIfAborted();
          const metadata = await input.adapter.captureSourceMetadata({ workspaceId: dependencies.workspaceId, versionId: "main", paths,
            bounds: { maxInputFiles: 4, maxInputBytes: maximumBytes * 4 }, signal: abort });
          const files = await input.adapter.hydrateCapturedSources(metadata, abort);
          await current(previous.cursor); input.signal?.throwIfAborted();
          if (metadata.workspaceId !== dependencies.workspaceId || files.length !== paths.length || new Set(files.map(file => file.path)).size !== paths.length
            || files.some(file => !paths.includes(file.path) || file.bytes.byteLength > maximumBytes || digest(file.bytes) !== file.sha256)) throw new Error("Collection source capture failed. Prepare the change again.");
          return { metadata, files };
        };
        const first = await capture([input.descriptorPath]);
        const definition = parseDatasetDefinition(JSON.parse(decode(first.files[0]!.bytes)));
        if (definition.datasetId !== input.datasetId) throw new Error("These sources belong to another Collection. Choose the matching sources.");
        const paths = [input.descriptorPath, definition.schemaPath, definition.operationsPath, input.migrationPath];
        if (new Set(paths).size !== 4 || paths.some(path => !allowed(path))) throw new Error("Choose separate Collection source files in this workspace.");
        const captured = await capture(paths);
        if (captured.files.find(file => file.path === input.descriptorPath)!.sha256 !== first.files[0]!.sha256) throw new Error("The Collection definition changed. Prepare the change again.");
        const read = (path: string) => decode(captured.files.find(file => file.path === path)!.bytes);
        const schemaSql = read(definition.schemaPath), operationSource = read(definition.operationsPath), migrationSql = read(input.migrationPath);
        if (!migrationSql.trim() || migrationSql.includes("\0")) throw new Error("The migration SQL is empty or invalid. Update it and prepare again.");
        const revision = describeDatasetRevision({ definition, revision: previous.revision.revision + 1, schemaSql, operationSource });
        const candidate = DatasetMigrationCandidate.parse(await dependencies.prepareMigrationCandidate({ workspaceId: dependencies.workspaceId,
          revision, expected: previous.cursor, schemaSql, operationSource, migrationSql, signal: input.signal }));
        dependencies.assertCurrent(); input.signal?.throwIfAborted();
        if (!sameCursor(candidate.expected, previous.cursor) || candidate.approvedRevisionHash !== revision.revisionSha256 || candidate.expiresAtMs <= Date.now()) {
          throw new Error("The Collection change differs from this review. Refresh the Collection and prepare it again.");
        }
        const review = { preparationId: randomUUID(), previousRevision: previous.revision, revision, expected: previous.cursor,
          sourceDigest: captured.metadata.sourceDigest, schemaSql, operationSource, migrationSql, candidate, expiresAtMs: candidate.expiresAtMs };
        const preparation = { ...review, approvalDigest: digest(JSON.stringify(["dohc-dataset-migration-review-v1", review])) };
        pending.set(preparation.preparationId, structuredClone(preparation));
        return preparation;
      } finally { preparing--; }
    },
    async approveMigration(input: MigrationApproval) {
      dependencies.assertCurrent(); input.signal?.throwIfAborted();
      const review = pending.get(input.preparationId);
      if (!review || review.expiresAtMs <= Date.now() || review.revision.revisionSha256 !== input.revisionSha256 || review.approvalDigest !== input.approvalDigest) {
        throw new Error("This Collection approval expired or changed. Prepare the change again.");
      }
      // Consume before the first await: a failed or uncertain outcome requires fresh capture, never repeated SQL.
      pending.delete(input.preparationId);
      return approveLocalDatasetMigration(dependencies, review, input);
    },
    async discardMigration(preparationId: string) {
      dependencies.assertCurrent(); const review = pending.get(preparationId); pending.delete(preparationId);
      if (review) await dependencies.discardMigrationCandidate({ workspaceId: dependencies.workspaceId, datasetId: review.revision.datasetId, candidateId: review.candidate.candidateId });
    },
    clear() { pending.clear(); },
  };
}
