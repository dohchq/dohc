import {
  parseApprovalAgent,
  type ApprovalAgent,
} from "@dohc/security-contract/approval-provenance";
import { createHash, randomUUID } from "node:crypto";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type {
  AppDatasetCapability,
  AppDatasetReference,
  DatasetRevision,
} from "@dohc/security-contract/dataset";
import { displayAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import {
  prepareLocalAppPublication,
  readLocalAppSource,
  type AppPublicationPreparationDependencies,
} from "../workspaces/ownerAppPublication";
import { createLocalStagedApps, type StagedDatasetApproved } from "../workspaces/localStagedApps";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "../workspaces/closedAppCompiler";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";
import { hasGeneratedDatasetSources } from "../workspaces/datasetFieldMigration";
import type { MigrateDatasetInput } from "@dohc/app-backend-runtime/dataset-host";
import { JournalError } from "@dohc/app-backend-runtime/journal";
import type { DatasetMigrationCandidate } from "@dohc/cli/dataset";
import { isDatasetServerNotFound } from "./errorWords";
import { MAIN_ONLY_SCHEMA_CHANGES } from "../workspaces/localPreviewStore";

type SourceAdapter = AppPublicationPreparationDependencies["adapter"];

/** The CLI's caller key. Agents use this door, so it can't approve an app that spends a workspace secret. */
export const localOwnerCliCaller = (workspaceId: string) => `local-owner-cli:${workspaceId}`;

export function createLocalOwnerAppPublicationHandler<
  Workspace extends { workspaceId: string; rootPath?: string; attachmentId?: symbol },
  Operation extends {
    workspace: Workspace;
    signal: AbortSignal;
    session?: { generation: number };
    scope?: string;
    assertCurrent(): void;
  },
>(deps: {
  datasetForWorkspace(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<
    { apps: Pick<LocalDatasetHost["apps"], "activate" | "has" | "list" | "withdraw"> } & Partial<
      Omit<LocalDatasetHost, "apps">
    >
  >;
  /** The Collection's approved rules, from wherever the workspace keeps its Collections. */
  approvedArtifacts?(
    workspace: Workspace,
    datasetId: string,
    signal: AbortSignal,
  ): Promise<{ revision: DatasetRevision; schemaSql: string; active: boolean }>;
  /** A Personal app's Collection access, from what the member's own grant shows. */
  datasetCapability?(
    workspace: Workspace,
    reference: AppDatasetReference,
    datasetId: string,
    alias: string | undefined,
    signal: AbortSignal,
  ): Promise<AppDatasetCapability>;
  /** Reads the app's files from somewhere other than the workspace, as a Personal app's folder. */
  appSource?(workspace: Workspace, adapter: VersionedLiveAdapter): SourceAdapter;
  /** Optional migration authority for workspaces whose Collections live on a server or locally. */
  migrationAuthority?(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<{
    approvedArtifacts(datasetId: string): Promise<StagedDatasetApproved>;
    prepareMigrationCandidate(input: MigrateDatasetInput): Promise<DatasetMigrationCandidate>;
    approveMigrationCandidate(input: {
      workspaceId: string;
      datasetId: string;
      candidateId: string;
      checkpointSha256: string;
      approvalAgent?: ApprovalAgent | null;
      signal?: AbortSignal;
    }): Promise<{
      revision: DatasetRevision;
      cursor: import("@dohc/app-backend-runtime/journal").DatasetCursor;
    }>;
    discardMigrationCandidate(input: {
      workspaceId: string;
      datasetId: string;
      candidateId: string;
      signal?: AbortSignal;
    }): Promise<unknown>;
  }>;
  flushCapture(workspace: Workspace): Promise<{ deferredWrites: readonly string[] }>;
  withAdapter<T>(
    workspace: Workspace,
    work: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  launchLocalDataset?(
    workspace: Workspace,
    publicationId: string,
    signal: AbortSignal,
  ): Promise<string>;
  verifyFrontend?(
    workspace: Workspace,
    input: Extract<OwnerAppPublicationRequest, { action: "verifyFrontend" }> & {
      versionId: string;
    },
    operation: Operation,
  ): Promise<OwnerAppPublicationResult>;
}) {
  type Prepared = Awaited<ReturnType<typeof prepareLocalAppPublication>>;
  const pending = new Map<
    string,
    {
      prepared: Prepared;
      workspaceId: string;
      callerKey: string;
      scope: string;
      signal: AbortSignal;
      digest: string;
      clear(): void;
    }
  >();
  const preparing = new Set<string>();
  const handle = async (
    input: OwnerAppPublicationRequest,
    callerKey: string,
    operation: Operation,
    attribution?: ApprovalAgent | null,
  ): Promise<OwnerAppPublicationResult | null> => {
    const agent = parseApprovalAgent(attribution);
    if (
      input.action !== "prepareLocal" &&
      input.action !== "listLocal" &&
      input.action !== "checkLocal" &&
      input.action !== "launchLocal" &&
      input.action !== "verifyFrontend" &&
      input.action !== "stage" &&
      input.action !== "listStaged" &&
      input.action !== "approveStaged" &&
      input.action !== "discardStaged" &&
      input.action !== "approve" &&
      input.action !== "cancel" &&
      input.action !== "withdraw" &&
      input.action !== "revokeCollection"
    )
      return null;
    const current = () => {
      operation.signal.throwIfAborted();
      operation.assertCurrent();
    };
    const appSource = (adapter: VersionedLiveAdapter): SourceAdapter =>
      deps.appSource?.(operation.workspace, adapter) ?? adapter;
    const workspaceId = operation.workspace.workspaceId;
    const activeVersionId = async () =>
      (
        await deps.withAdapter(operation.workspace, (adapter) =>
          adapter.getActiveVersion({ workspaceId }),
        )
      )?.id ?? "main";
    const resolveVersion = async (versionId: string | undefined) => {
      if (deps.appSource) {
        if (versionId !== undefined && versionId !== "main")
          throw new Error("Personal apps open on Main only.");
        return "main";
      }
      if (versionId === undefined) return activeVersionId();
      if (versionId === "main") return versionId;
      const versions = await deps.withAdapter(operation.workspace, (adapter) =>
        adapter.listVersions({ workspaceId }),
      );
      current();
      if (!versions?.some((version) => version.id === versionId))
        throw new Error(
          "dohc could not find this version. Choose one from Versions and try again.",
        );
      return versionId;
    };
    current();
    if (
      (input.action === "stage" || input.action === "approveStaged") &&
      (await activeVersionId()) !== "main"
    )
      throw new Error(MAIN_ONLY_SCHEMA_CHANGES);
    if (
      input.action === "stage" ||
      input.action === "listStaged" ||
      input.action === "approveStaged" ||
      input.action === "discardStaged"
    ) {
      const rootPath = operation.workspace.rootPath;
      if (!rootPath) throw new Error("Staged app reviews are unavailable for this workspace.");
      const openStaged = async (needsAuthority: boolean) => {
        const local = await deps.datasetForWorkspace(operation.workspace, operation.signal);
        current();
        const migration =
          needsAuthority && deps.migrationAuthority
            ? await deps.migrationAuthority(operation.workspace, operation.signal)
            : null;
        current();
        const useServerAuthority = local.appHostKind
          ? local.appHostKind() === "server" && !!migration
          : !!migration;
        return createLocalStagedApps({
          workspaceId: operation.workspace.workspaceId,
          workspaceRoot: rootPath,
          attachmentId: operation.workspace.attachmentId,
          assertCurrent: current,
          compile: deps.compile,
          preflightCreate: async (preflightInput) => {
            if (!local.preflightCreate)
              throw new Error("Collection preflight is unavailable on this device.");
            await local.preflightCreate(preflightInput);
          },
          tryApprovedArtifacts: async (datasetId) => {
            try {
              if (useServerAuthority && migration) {
                if (local.keptDatasetIds?.().includes(datasetId))
                  throw new Error(
                    "All Collections used by this app must be active on the same host.",
                  );
                return await migration.approvedArtifacts(datasetId);
              }
              if (!local.approvedArtifacts) return null;
              return local.approvedArtifacts(datasetId);
            } catch (error) {
              if (
                (error instanceof JournalError &&
                  error.code === "conflict" &&
                  error.message === "This Collection is not set up yet.") ||
                isDatasetServerNotFound(error)
              )
                return null;
              throw error;
            }
          },
          prepareCreate: async (createInput) => {
            if (!local.prepare)
              throw new Error("Collection creation is unavailable on this device.");
            return local.prepare(createInput);
          },
          approveCreate: async (approveInput) => {
            if (!local.approve)
              throw new Error("Collection approval is unavailable on this device.");
            return local.approve(approveInput);
          },
          discardCreate: (preparationId) => {
            local.discard?.(preparationId);
          },
          prepareMigrationCandidate: async (migrationInput) => {
            if (useServerAuthority && migration)
              return migration.prepareMigrationCandidate(migrationInput);
            if (!local.prepareMigrationCandidate)
              throw new Error("Collection updates are unavailable on this device.");
            return local.prepareMigrationCandidate(migrationInput);
          },
          approveMigrationCandidate: async (migrationInput) => {
            if (useServerAuthority && migration)
              return migration.approveMigrationCandidate(migrationInput);
            if (!local.approveMigrationCandidate)
              throw new Error("Collection updates are unavailable on this device.");
            return local.approveMigrationCandidate(migrationInput);
          },
          discardMigrationCandidate: async (migrationInput) => {
            if (useServerAuthority && migration)
              return migration.discardMigrationCandidate(migrationInput);
            if (local.discardMigrationCandidate)
              return local.discardMigrationCandidate(migrationInput);
          },
          activateApp: (prepared, signal, approvalAgent) =>
            local.apps.activate(prepared, signal, approvalAgent),
          withExclusiveDatasets: local.withExclusiveDatasets
            ? (datasetIds, signal, work) =>
                local.withExclusiveDatasets!(datasetIds, signal, (exclusive) =>
                  work({
                    approveCreate: (approveInput) => exclusive.approve(approveInput),
                    ...(useServerAuthority
                      ? {}
                      : {
                          approveMigrationCandidate: (migrationInput) =>
                            exclusive.approveMigrationCandidate(migrationInput),
                        }),
                  }),
                )
            : undefined,
        });
      };
      if (input.action === "listStaged") {
        if (
          input.appRoot !== undefined &&
          (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot))
        )
          throw new Error("Choose an app in your workspace.");
        const staged = await openStaged(false);
        const stages = await staged.list(input.appRoot);
        current();
        return OwnerAppPublicationResult.parse({ kind: "stagedListed", stages });
      }
      if (input.action === "discardStaged") {
        const staged = await openStaged(false);
        await staged.discard(input.stageId);
        current();
        return OwnerAppPublicationResult.parse({
          kind: "stagedDiscarded",
          stageId: input.stageId.toLowerCase(),
        });
      }
      if (input.action === "approveStaged") {
        const staged = await openStaged(true);
        const result = await staged.approve({
          stageId: input.stageId,
          reviewDigest: input.reviewDigest,
          agent,
          signal: operation.signal,
        });
        current();
        return OwnerAppPublicationResult.parse({ kind: "stagedApproved", ...result });
      }
      if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot))
        throw new Error("Choose an app in your workspace.");
      const capture = await deps.flushCapture(operation.workspace);
      current();
      const staged = await openStaged(true);
      const stage = await deps.withAdapter(operation.workspace, (adapter) =>
        staged.stage({
          appRoot: input.appRoot,
          migrations: input.migrations,
          deferredWrites: capture.deferredWrites,
          adapter,
          signal: operation.signal,
        }),
      );
      current();
      if (!stage) throw new Error("dohc could not capture this app. Restart dohc and try again.");
      return OwnerAppPublicationResult.parse({ kind: "staged", stage });
    }
    if (input.action === "verifyFrontend") {
      if (!deps.verifyFrontend)
        throw new Error("App frontend verification is unavailable. Restart dohc and try again.");
      const versionId = await resolveVersion(input.versionId);
      current();
      const result = await deps.verifyFrontend(
        operation.workspace,
        { ...input, versionId },
        operation,
      );
      current();
      return OwnerAppPublicationResult.parse(result);
    }
    if (input.action === "withdraw" || input.action === "revokeCollection") {
      const local = await deps.datasetForWorkspace(operation.workspace, operation.signal);
      current();
      // Other IDs belong to the sync service. A local app has no access to revoke apart from its approval.
      if (!local.apps.has(input.publicationId)) return null;
      const result = await local.apps.withdraw(
        input.publicationId,
        input.expectedAuthorityRevision,
      );
      current();
      return OwnerAppPublicationResult.parse(
        input.action === "revokeCollection" && result.kind === "withdrawn"
          ? { ...result, kind: "collectionRevoked" }
          : result,
      );
    }
    if (input.action === "launchLocal") {
      const dataset = await deps.datasetForWorkspace(operation.workspace, operation.signal);
      current();
      if (!dataset.apps.has(input.publicationId))
        throw new Error("This app is not approved on this device. Prepare it again.");
      const launch = deps.launchLocalDataset;
      if (!launch) throw new Error("Local app launch is unavailable. Restart dohc and try again.");
      const url = await launch(operation.workspace, input.publicationId, operation.signal);
      current();
      const parsed = new URL(url);
      if (
        parsed.protocol !== "http:" ||
        parsed.hostname !== "127.0.0.1" ||
        !parsed.port ||
        parsed.username ||
        parsed.password
      )
        throw new Error("The local app launcher returned an invalid address.");
      return OwnerAppPublicationResult.parse({
        kind: "localLaunched",
        publicationId: input.publicationId,
        url,
      });
    }
    if (input.action === "approve" || input.action === "cancel") {
      const entry = pending.get(input.approvalId);
      if (!entry) return null;
      if (
        entry.workspaceId !== input.workspaceId ||
        entry.callerKey !== callerKey ||
        entry.scope !== (operation.scope ?? callerKey) ||
        entry.signal !== operation.signal
      )
        throw new Error("This local app preparation expired. Prepare it again.");
      if (input.action === "cancel") {
        entry.clear();
        return { kind: "cancelled" };
      }
      if (input.candidateDigest !== entry.digest)
        throw new Error("The app candidate changed. Review it again.");
      entry.clear();
      const local = await deps.datasetForWorkspace(operation.workspace, operation.signal);
      current();
      const result = await local.apps.activate(entry.prepared, operation.signal, agent);
      current();
      return OwnerAppPublicationResult.parse({
        kind: "published",
        publicationId: result.publicationId,
        authorityRevision: result.authorityRevision,
        local: true,
      });
    }
    if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot))
      throw new Error("Choose an app in your workspace.");
    const versionId = await resolveVersion(input.versionId);
    current();
    if (input.action === "listLocal") {
      const local = await deps.datasetForWorkspace(operation.workspace, operation.signal);
      current();
      return OwnerAppPublicationResult.parse({
        kind: "localListed",
        publications: local.apps.list(input.appRoot, versionId),
      });
    }
    if (input.action === "checkLocal") {
      const capture = await deps.flushCapture(operation.workspace);
      current();
      const source = await deps.withAdapter(operation.workspace, (adapter) =>
        readLocalAppSource(
          { ...input, versionId },
          {
            adapter: appSource(adapter),
            signal: operation.signal,
            assertCurrent: current,
            deferredWrites: capture.deferredWrites,
          },
        ),
      );
      current();
      if (!source)
        throw new Error("dohc could not read this app's source. Restart dohc and try again.");
      return OwnerAppPublicationResult.parse({
        kind: "localChecked",
        appRoot: input.appRoot,
        ...source,
      });
    }
    if (preparing.has(callerKey))
      throw new Error("This caller is already preparing an app. Wait for it to finish.");
    for (const entry of pending.values()) if (entry.callerKey === callerKey) entry.clear();
    if (pending.size + preparing.size >= 8)
      throw new Error("Too many apps await approval. Cancel another preparation and try again.");
    preparing.add(callerKey);
    try {
      const capture = await deps.flushCapture(operation.workspace);
      current();
      const datasets = new Map<string, { revision: DatasetRevision; schemaSql: string }>();
      const prepared = await deps.withAdapter(operation.workspace, (adapter) =>
        prepareLocalAppPublication(
          { ...input, versionId },
          {
            adapter: appSource(adapter),
            datasetAdapter: adapter,
            signal: operation.signal,
            assertCurrent: current,
            compile: deps.compile,
            deferredWrites: capture.deferredWrites,
            ...(deps.datasetCapability
              ? {
                  resolveDatasetCapability: (reference, datasetId, alias) =>
                    deps.datasetCapability!(
                      operation.workspace,
                      reference,
                      datasetId,
                      alias,
                      operation.signal,
                    ),
                }
              : {}),
            resolveDatasetRevision: async (binding) => {
              if (!deps.approvedArtifacts)
                throw new Error(
                  "This app's Collection is unavailable. Open the Collection and try again.",
                );
              const approved = await deps.approvedArtifacts(
                operation.workspace,
                binding.datasetId,
                operation.signal,
              );
              current();
              if (!approved.active)
                throw new Error("This Collection is unavailable on this device.");
              datasets.set(binding.datasetId, approved);
              return approved.revision;
            },
          },
        ),
      );
      current();
      if (!prepared)
        throw new Error("dohc could not capture this app. Restart dohc and try again.");
      const candidate = prepared.candidate;
      if (candidate.external && callerKey === localOwnerCliCaller(input.workspaceId))
        throw new Error(
          "This app calls outside services with a workspace secret. Approve it in the dohc window: open the app and choose Review.",
        );
      const approvalId = randomUUID(),
        digest = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
      const clear = () => {
        pending.delete(approvalId);
        operation.signal.removeEventListener("abort", clear);
        clearTimeout(expiry);
      };
      const expiry = setTimeout(clear, 10 * 60_000);
      expiry.unref();
      pending.set(approvalId, {
        prepared,
        workspaceId: input.workspaceId,
        callerKey,
        scope: operation.scope ?? callerKey,
        signal: operation.signal,
        digest,
        clear,
      });
      operation.signal.addEventListener("abort", clear, { once: true });
      // The digest binds the candidate. Review app also gets what each operation does, from the revision the candidate names.
      const shown = candidate.capabilities.map((capability) => {
        const dataset =
          capability.kind === "dataset" ? datasets.get(capability.datasetId) : undefined;
        return capability.kind === "dataset" && dataset
          ? displayAppDatasetCapability(
              capability,
              dataset.revision,
              hasGeneratedDatasetSources(dataset.revision, dataset.schemaSql),
            )
          : capability;
      });
      return OwnerAppPublicationResult.parse({
        kind: "prepared",
        approvalId,
        candidateDigest: digest,
        appRoot: candidate.appRoot,
        versionId: candidate.versionId,
        sourceRevision: candidate.sourceRevision,
        sourcePaths: candidate.inputs.map((file) => file.path),
        likelySecrets: prepared.likelySecrets,
        capabilities: shown,
        ...(candidate.external ? { external: candidate.external } : {}),
        externalNetwork: true,
        local: true,
      });
    } finally {
      preparing.delete(callerKey);
    }
  };
  return Object.assign(handle, {
    /** Hands a preparation to its own caller once, for an upload in place of a local approval. */
    take(approvalId: string, callerKey: string, signal: AbortSignal): Prepared {
      const entry = pending.get(approvalId);
      if (!entry || entry.callerKey !== callerKey || entry.signal !== signal)
        throw new Error("This app preparation expired. Try again.");
      entry.clear();
      return entry.prepared;
    },
  });
}
