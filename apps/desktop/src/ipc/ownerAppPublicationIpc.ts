import {
  parseApprovalAgent,
  type ApprovalAgent,
} from "@dohc/security-contract/approval-provenance";
import { z } from "zod";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  parseAppPublicationCandidate,
  parseAppCollectionCapability,
  APP_PUBLICATION_MAX_BLOB_BYTES,
  APP_PUBLICATION_MAX_REQUEST_BYTES,
} from "@dohc/security-contract/app-publication";
import { createHash, randomUUID } from "node:crypto";
import { CHANNELS } from "./channels";
import { localOwnerCliCaller } from "./localOwnerAppPublication";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { RelayShareLinkListResponse } from "./bridgeContract";
import {
  OwnerAppPublicationRequest,
  OwnerAppPublicationResult,
  PERSONAL_APP_ACTIONS,
} from "./ownerAppPublicationContract";
import {
  prepareOwnerAppPublication,
  APP_PUBLICATION_LIMITS,
} from "../workspaces/ownerAppPublication";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "../workspaces/closedAppCompiler";
import {
  datasetColumnFields,
  type AppDatasetRevisionLookup,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import {
  displayAppDatasetCapability,
  resolveAppDatasetCapability,
  verifyAppDatasetCapability,
  hasGeneratedDatasetRevision,
} from "@dohc/security-contract/dataset-authorization";
import {
  createRemoteDatasetData,
  resolveRemoteDatasetArtifacts,
  resolveRemoteDatasetRevision,
} from "../workspaces/remoteDataset";
import { hasGeneratedDatasetSources } from "../workspaces/datasetFieldMigration";

/**
 * The relay's own refusal of the publication list: a 404 with its not_found body. A 403, or a 404 from something in
 * front of the relay, says nothing about whether links are live, so it stays a failure.
 */
export const publicationListUnavailable = (
  status: number,
  body: { ok?: unknown; code?: unknown } | null,
) => status === 404 && body?.ok === false && body.code === "not_found";

export function createOwnerAppPublicationHandler<
  Caller,
  Workspace extends { workspaceId: string; shareView?: unknown },
  Operation extends {
    workspace: Workspace;
    signal: AbortSignal;
    scope?: string;
    assertCurrent(): void;
  },
>(dependencies: {
  callerKey(caller: Caller): string;
  withWorkspaceOperation<Result>(
    caller: Caller,
    workspaceId: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  remoteForWorkspace(
    workspace: Workspace,
    options?: { allowPaused: boolean },
  ): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  flushCapture(workspace: Workspace): Promise<{ deferredWrites: readonly string[] }>;
  withAdapter<Result>(
    workspace: Workspace,
    work: (adapter: VersionedLiveAdapter) => Promise<Result>,
  ): Promise<Result | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  relayJson(credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown>;
  /** Like relayJson, but the relay's not_found 404 resolves to unavailable instead of throwing. */
  relayJsonOrUnavailable(
    credentials: CloudCredentials,
    path: string,
    init?: RequestInit,
  ): Promise<{ kind: "success"; body: unknown } | { kind: "unavailable" }>;
  upload(
    credentials: CloudCredentials,
    workspaceId: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  localPublication?(
    input: OwnerAppPublicationRequest,
    callerKey: string,
    operation: Operation,
    attribution: ApprovalAgent | null,
  ): Promise<OwnerAppPublicationResult | null>;
  /** A joined workspace's Personal apps, which run on this computer as the member. */
  personalPublication?(
    input: OwnerAppPublicationRequest,
    callerKey: string,
    operation: Operation,
    attribution: ApprovalAgent | null,
  ): Promise<OwnerAppPublicationResult | null>;
  /** Reads a Collection's approved rules from whoever answers for it, in place of the server alone. */
  resolveDatasetRevision?(
    workspace: Workspace,
    binding: AppDatasetRevisionLookup,
    signal: AbortSignal,
  ): Promise<DatasetRevision>;
  resolveDatasetArtifacts?(
    workspace: Workspace,
    binding: AppDatasetRevisionLookup,
    signal: AbortSignal,
  ): Promise<{ revision: DatasetRevision; schemaSql: string }>;
}) {
  type Prepared = Awaited<ReturnType<typeof prepareOwnerAppPublication>>;
  const pending = new Map<
    string,
    {
      prepared: Prepared;
      input: Extract<OwnerAppPublicationRequest, { action: "prepare" }>;
      callerKey: string;
      scope: string;
      signal: AbortSignal;
      generation: number;
      candidateDigest: string;
      createdAt: number;
      clear(): void;
      access: "view" | "comment" | "edit" | null;
      reactivation?: { publicationId: string; authorityRevision: number };
    }
  >();
  const preparing = new Map<string, symbol>();
  const bearerWarning = (access: string) =>
    `This URL is a bearer credential at ${access} access, usable by anyone who holds it.`;
  const clearExpired = () => {
    for (const entry of pending.values())
      if (entry.signal.aborted || Date.now() - entry.createdAt > 10 * 60_000) entry.clear();
  };
  return async (caller: Caller, raw: unknown, attribution?: ApprovalAgent | null) => {
    const agent = parseApprovalAgent(attribution);
    const input = OwnerAppPublicationRequest.parse(raw);
    const callerKey = dependencies.callerKey(caller);
    return dependencies.withWorkspaceOperation(caller, input.workspaceId, async (operation) => {
      operation.assertCurrent();
      if (shareViewIsPresent(operation.workspace.shareView)) {
        const personal = PERSONAL_APP_ACTIONS.has(input.action)
          ? await dependencies.personalPublication?.(input, callerKey, operation, agent)
          : null;
        operation.assertCurrent();
        operation.signal.throwIfAborted();
        if (personal) return personal;
        throw new Error("Only the original workspace can publish this app.");
      }
      if (input.action === "personalFolder")
        throw new Error(
          "Personal apps are for workspaces you joined. Build apps in this workspace.",
        );
      const local = await dependencies.localPublication?.(input, callerKey, operation, agent);
      operation.assertCurrent();
      operation.signal.throwIfAborted();
      if (local) return local;
      if (
        input.action === "prepareLocal" ||
        input.action === "listLocal" ||
        input.action === "checkLocal" ||
        input.action === "launchLocal" ||
        input.action === "verifyFrontend" ||
        input.action === "stage" ||
        input.action === "listStaged" ||
        input.action === "approveStaged" ||
        input.action === "discardStaged"
      )
        throw new Error("Local apps are unavailable. Restart dohc and try again.");
      const remote = await dependencies.remoteForWorkspace(
        operation.workspace,
        input.action === "withdraw" || input.action === "revokeCollection"
          ? { allowPaused: true }
          : undefined,
      );
      const session = credentialScopedOperation({
        assertCurrent: () => operation.assertCurrent(),
        capturedGeneration: remote.credentialGeneration,
        currentGeneration: dependencies.currentCredentialGeneration,
      });
      session.assertCurrent();
      const remoteData = createRemoteDatasetData({
        workspaceId: input.workspaceId,
        ...remote,
        signal: operation.signal,
        currentCredentialGeneration: dependencies.currentCredentialGeneration,
        assertCurrent: () => operation.assertCurrent(),
        relayJson: dependencies.relayJson,
      });
      const resolveDatasetArtifacts = (binding: AppDatasetRevisionLookup) =>
        session.run(async (): Promise<{ revision: DatasetRevision; schemaSql?: string }> => {
          if (dependencies.resolveDatasetArtifacts) {
            return await dependencies.resolveDatasetArtifacts(
              operation.workspace,
              binding,
              operation.signal,
            );
          }
          if (dependencies.resolveDatasetRevision) {
            return {
              revision: await dependencies.resolveDatasetRevision(
                operation.workspace,
                binding,
                operation.signal,
              ),
            };
          }
          return await resolveRemoteDatasetArtifacts(remoteData, binding);
        });
      const resolveDatasetRevision = (binding: AppDatasetRevisionLookup) =>
        session.run(() =>
          dependencies.resolveDatasetRevision
            ? dependencies.resolveDatasetRevision(operation.workspace, binding, operation.signal)
            : resolveRemoteDatasetRevision(remoteData, binding),
        );
      const currentGrant = async (shareId: string, grantId: string) => {
        let grant;
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = RelayShareLinkListResponse.parse(
            await session.run(() =>
              dependencies.relayJson(
                remote.credentials,
                `/sync/${encodeURIComponent(input.workspaceId)}/shares/links${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
                { signal: operation.signal },
              ),
            ),
          );
          grant = page.links.find((row) => row.shareId === shareId && row.grantId === grantId);
          if (grant) break;
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor))
            throw new Error("The app link listing changed. Try again.");
          if (cursor) seen.add(cursor);
        } while (cursor);
        if (!grant) throw new Error("This app link is unavailable. Choose an active link.");
        return grant;
      };
      const publishBody = (
        selection: Extract<OwnerAppPublicationRequest, { action: "prepare" }>,
        generation: number | undefined,
        candidate: unknown,
      ) =>
        selection.audience === "workspace"
          ? { audience: "workspace", candidate, agent }
          : {
              shareId: selection.shareId,
              grantId: selection.grantId,
              expectedGrantGeneration: generation,
              candidate,
              agent,
            };
      clearExpired();
      if (input.action === "createLink") {
        if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot))
          throw new Error("Choose an app in your workspace.");
        const paths = input.paths ?? [input.appRoot];
        if (paths.some((path) => !isShareablePath(path) || isSharedWithMePath(path)))
          throw new Error("Choose shareable paths in your workspace.");
        const raw = await session.run(() =>
          dependencies.relayJson(
            remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/shares/links`,
            {
              method: "POST",
              signal: operation.signal,
              body: JSON.stringify({
                paths,
                access: input.access,
                operationId: input.operationId,
                agent,
              }),
            },
          ),
        );
        operation.signal.throwIfAborted();
        const row = z
          .object({
            ok: z.literal(true),
            workspaceId: z.string(),
            shareId: z.string().min(1),
            grantId: z.string().min(1),
            access: z.enum(["view", "comment", "edit"]),
            selector: z.object({ paths: z.array(z.string()), versionId: z.null() }),
            url: z.string().url().max(4096).optional(),
            urlUnavailable: z.literal(true).optional(),
          })
          .parse(raw);
        if (
          row.workspaceId !== input.workspaceId ||
          row.access !== input.access ||
          JSON.stringify([...row.selector.paths].sort()) !==
            JSON.stringify([...new Set(paths)].sort())
        )
          throw new Error("The app link selection changed.");
        const facts = {
          shareId: row.shareId,
          grantId: row.grantId,
          selector: row.selector,
          access: row.access,
          bearerWarning: bearerWarning(row.access),
        };
        if (!row.url) {
          if (!row.urlUnavailable) throw new Error("The app link result is unavailable.");
          return OwnerAppPublicationResult.parse({ kind: "urlUnavailable", ...facts });
        }
        return OwnerAppPublicationResult.parse({ kind: "linkCreated", ...facts, url: row.url });
      }
      const remember = async (
        prepared: Prepared,
        selection: Extract<OwnerAppPublicationRequest, { action: "prepare" }>,
        reactivation: { publicationId: string; authorityRevision: number } | undefined,
        audience:
          | {
              access: "view" | "comment" | "edit";
              selector: { paths: string[]; versionId: string | null } | null;
            }
          | "workspace",
      ) => {
        session.assertCurrent();
        operation.signal.throwIfAborted();
        const candidate = prepared.candidate;
        if (candidate.external && callerKey === localOwnerCliCaller(selection.workspaceId))
          throw new Error(
            "This app calls outside services with a workspace secret. Share it in the dohc window: open the app and choose Share.",
          );
        const capabilities = await Promise.all(
          candidate.capabilities.map(async (capability) => {
            if (capability.kind !== "dataset") return capability;
            const { revision, schemaSql } = await resolveDatasetArtifacts(capability);
            const generatedOperations = hasGeneratedDatasetRevision(revision);
            const generatedSources =
              schemaSql !== undefined && hasGeneratedDatasetSources(revision, schemaSql);
            const withFields = reactivation
              ? capability
              : {
                  ...capability,
                  operations: capability.operations.map((operation) => {
                    const read = revision.definition.operations.find(
                      (read) =>
                        read.operationId === operation.operationId &&
                        read.kind === "read" &&
                        read.access === "helper",
                    );
                    if (!read || !generatedOperations) return operation;
                    const table = revision.definition.tables.find(
                      (table) => table.tableId === read.tableId,
                    )!;
                    const primary = datasetColumnFields(table).find(
                      (field) => field.sqlColumn === table.primaryKey,
                    )!;
                    if (!read.fieldIds.includes(primary.fieldId)) return operation;
                    return {
                      ...operation,
                      fields: table.fields
                        .filter((field) => read.fieldIds.includes(field.fieldId))
                        .map(({ fieldId, name }) => ({ fieldId, name })),
                    };
                  }),
                };
            return displayAppDatasetCapability(withFields, revision, generatedSources);
          }),
        );
        session.assertCurrent();
        operation.signal.throwIfAborted();
        for (const entry of pending.values()) if (entry.callerKey === callerKey) entry.clear();
        if (pending.size >= 8)
          throw new Error(
            "Too many apps await publication. Cancel another preparation and try again.",
          );
        const approvalId = randomUUID(),
          candidateDigest = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
        const clear = () => {
          pending.delete(approvalId);
          operation.signal.removeEventListener("abort", clear);
          clearTimeout(expiry);
        };
        const expiry = setTimeout(clear, 10 * 60_000);
        expiry.unref();
        pending.set(approvalId, {
          prepared,
          input: selection,
          candidateDigest,
          callerKey,
          signal: operation.signal,
          scope: operation.scope ?? callerKey,
          generation: remote.credentialGeneration,
          createdAt: Date.now(),
          clear,
          reactivation,
          access: audience === "workspace" ? null : audience.access,
        });
        operation.signal.addEventListener("abort", clear, { once: true });
        return OwnerAppPublicationResult.parse({
          kind: "prepared",
          approvalId,
          candidateDigest,
          appRoot: candidate.appRoot,
          versionId: candidate.versionId,
          sourceRevision: candidate.sourceRevision,
          sourcePaths: candidate.inputs.map((file) => file.path),
          likelySecrets: prepared.likelySecrets,
          capabilities,
          ...(candidate.external ? { external: candidate.external } : {}),
          externalNetwork: true,
          ...(audience === "workspace"
            ? { audience }
            : audience.selector
              ? {
                  audience: {
                    shareId: selection.shareId,
                    grantId: selection.grantId,
                    selector: audience.selector,
                    access: audience.access,
                  },
                }
              : {}),
        });
      };
      if (input.action === "reviewReactivation") {
        if (preparing.has(callerKey))
          throw new Error("This caller is already preparing an app. Wait for it to finish.");
        const raw = await session.run(() =>
          dependencies.relayJson(
            remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}`,
            { signal: operation.signal },
          ),
        );
        const row = raw as {
          operatorTakedown?: unknown;
          publicationId?: string;
          candidate?: unknown;
          active?: boolean;
          authorityRevision?: number;
          owner?: {
            workspaceId?: string;
            ownerUserId?: string;
            shareId?: string;
            grantId?: string;
            generation?: number;
          };
        } | null;
        if (
          !row ||
          row.publicationId !== input.publicationId ||
          row.active !== false ||
          row.owner?.workspaceId !== input.workspaceId ||
          row.owner.ownerUserId !== remote.credentials.userId ||
          !Number.isSafeInteger(row.authorityRevision) ||
          row.authorityRevision! < 1 ||
          (row.owner.grantId !== undefined &&
            (!Number.isSafeInteger(row.owner.generation) || row.owner.generation! < 1))
        )
          throw new Error(
            "This app publication cannot be republished. Refresh the publication list.",
          );
        if (row.operatorTakedown)
          throw new Error(
            "The server operator disabled this publication. Contact the server operator.",
          );
        const candidate = parseAppPublicationCandidate(row.candidate, APP_PUBLICATION_LIMITS);
        for (const dataset of candidate.capabilities)
          if (dataset.kind === "dataset")
            verifyAppDatasetCapability(dataset, (await resolveDatasetArtifacts(dataset)).revision);
        const reactivation = {
          publicationId: input.publicationId,
          authorityRevision: row.authorityRevision!,
        };
        const workspace = row.owner.grantId === undefined;
        const selection = OwnerAppPublicationRequest.parse({
          action: "prepare",
          workspaceId: input.workspaceId,
          appRoot: candidate.appRoot,
          ...(workspace
            ? { audience: "workspace" }
            : { shareId: row.owner.shareId, grantId: row.owner.grantId }),
        });
        if (selection.action !== "prepare") throw new Error("Invalid publication selection.");
        if (workspace)
          return await remember(
            { candidate, files: [], likelySecrets: [] },
            selection,
            reactivation,
            "workspace",
          );
        const grant = await currentGrant(selection.shareId!, selection.grantId!);
        if (
          grant.generation !== row.owner.generation ||
          !["view", "comment", "edit"].includes(grant.access)
        )
          throw new Error("The app link changed. Prepare the app again.");
        return await remember(
          { candidate, files: [], likelySecrets: [], generation: row.owner.generation! },
          selection,
          reactivation,
          { access: grant.access as "view" | "comment" | "edit", selector: grant.selector },
        );
      }
      if (input.action === "list") {
        if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot))
          throw new Error("Choose an app in your workspace.");
        const query = new URLSearchParams({ appRoot: input.appRoot });
        if (input.cursor) query.set("cursor", input.cursor);
        const answer = await session.run(() =>
          dependencies.relayJsonOrUnavailable(
            remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications?${query}`,
            { signal: operation.signal },
          ),
        );
        // The server does not publish apps for this workspace and account.
        if (answer.kind === "unavailable")
          return OwnerAppPublicationResult.parse({ kind: "listUnavailable" });
        const raw = answer.body;
        const parsed =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? OwnerAppPublicationResult.safeParse({ ...raw, kind: "listed" })
            : null;
        if (!parsed?.success)
          throw new Error(
            "dohc could not read the server's app publications. dohc or the server needs an update.",
          );
        const result = parsed.data;
        if (
          result.kind !== "listed" ||
          result.publications.some(
            (row) => !row.manifestUnavailable && row.appRoot !== input.appRoot,
          )
        )
          throw new Error("The publication list belongs to another app.");
        return result;
      }
      if (input.action === "withdraw") {
        const raw = await session.run(() =>
          dependencies.relayJson(
            remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}/withdraw`,
            {
              method: "POST",
              signal: operation.signal,
              body: JSON.stringify({ expectedAuthorityRevision: input.expectedAuthorityRevision }),
            },
          ),
        );
        const row = raw as {
          publicationId?: string;
          active?: boolean;
          authorityRevision?: number;
          owner?: { workspaceId?: string };
        } | null;
        if (
          !row ||
          row.publicationId !== input.publicationId ||
          row.owner?.workspaceId !== input.workspaceId ||
          row.active !== false
        )
          throw new Error("dohc could not confirm that this publication ended.");
        return OwnerAppPublicationResult.parse({
          kind: "withdrawn",
          publicationId: row.publicationId,
          authorityRevision: row.authorityRevision,
        });
      }
      if (input.action === "revokeCollection") {
        const raw = await session.run(() =>
          dependencies.relayJson(
            remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${input.publicationId}/collection-approval`,
            {
              method: "POST",
              signal: operation.signal,
              body: JSON.stringify({
                expectedAuthorityRevision: input.expectedAuthorityRevision,
                capability: null,
              }),
            },
          ),
        );
        const row = raw as {
          publicationId?: unknown;
          authorityRevision?: unknown;
          capability?: unknown;
        } | null;
        if (
          !row ||
          row.publicationId !== input.publicationId ||
          row.capability !== null ||
          row.authorityRevision !== input.expectedAuthorityRevision + 1
        )
          throw new Error("dohc could not confirm collection access was revoked.");
        operation.signal.throwIfAborted();
        return OwnerAppPublicationResult.parse({
          kind: "collectionRevoked",
          publicationId: row.publicationId,
          authorityRevision: row.authorityRevision,
        });
      }
      if (input.action !== "prepare") {
        const entry = pending.get(input.approvalId);
        if (
          !entry ||
          entry.callerKey !== callerKey ||
          entry.scope !== (operation.scope ?? callerKey) ||
          entry.signal !== operation.signal ||
          entry.input.workspaceId !== input.workspaceId ||
          entry.generation !== remote.credentialGeneration
        )
          throw new Error("This app preparation expired. Prepare the app again.");
        if (input.action === "cancel") {
          entry.clear();
          return OwnerAppPublicationResult.parse({ kind: "cancelled" });
        }
        if (input.candidateDigest !== entry.candidateDigest)
          throw new Error("The app candidate changed. Review it again.");
        // Consume before the first upload so duplicate approvals cannot race.
        entry.clear();
        const { prepared } = entry;
        const candidate = structuredClone(prepared.candidate);
        const datasets = candidate.capabilities.filter((value) => value.kind === "dataset");
        const grants = (dataset: (typeof datasets)[number], operationId: string) =>
          dataset.operations.some((operation) => operation.operationId === operationId);
        if (input.linkReads !== undefined) {
          if (entry.reactivation)
            throw new Error("Prepare the app again to change its link access.");
          if (
            !datasets.length ||
            input.linkReads.some(
              (read) => !datasets.some((dataset) => grants(dataset, read.operationId)),
            )
          )
            throw new Error("This app has no Collection access to approve.");
          if (
            input.linkReads.some(
              (read) => datasets.filter((dataset) => grants(dataset, read.operationId)).length > 1,
            )
          )
            throw new Error(
              "Two of this app's Collections share an action, so dohc can't tell which one a link read is for. Give people with the link no reads, or use one of those Collections.",
            );
        }
        for (const dataset of datasets) {
          const reads = (input.linkReads ?? []).filter((read) => grants(dataset, read.operationId));
          if (reads.length) dataset.linkReads = reads;
          const revision = await resolveRemoteDatasetRevision(remoteData, dataset);
          const { operations: _operations, name: _name, ...binding } = dataset;
          candidate.capabilities[candidate.capabilities.indexOf(dataset)] = reads.length
            ? resolveAppDatasetCapability(binding, revision)
            : verifyAppDatasetCapability(dataset, revision);
        }
        const finishPublication = async (publicationId: unknown, authorityRevision: unknown) => {
          const address = (authorityRevision: number) => {
            return OwnerAppPublicationResult.parse({
              ...published,
              authorityRevision,
              ...(entry.input.audience === "workspace"
                ? {}
                : { appQuery: `?app=${String(publicationId)}` }),
              ...(entry.access
                ? { access: entry.access, bearerWarning: bearerWarning(entry.access) }
                : {}),
            });
          };
          const published = OwnerAppPublicationResult.parse({
            kind: "published",
            publicationId,
            authorityRevision,
          });
          if (published.kind !== "published") throw new Error("Invalid publication result.");
          const capability = candidate.capabilities[0];
          if (!capability) return address(published.authorityRevision);
          const datasetIds = candidate.capabilities.flatMap((value) =>
            value.kind === "dataset" ? [value.datasetId] : [],
          );
          if (datasetIds.length) {
            try {
              const raw = await session.run(() =>
                dependencies.relayJson(
                  remote.credentials,
                  `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${published.publicationId}/backend/activate`,
                  {
                    method: "POST",
                    signal: operation.signal,
                    body: JSON.stringify({ authorityRevision: published.authorityRevision }),
                  },
                ),
              );
              const activated = raw as {
                publicationId?: unknown;
                authorityRevision?: unknown;
                datasetIds?: unknown;
              } | null;
              if (
                !activated ||
                activated.publicationId !== published.publicationId ||
                activated.authorityRevision !== published.authorityRevision ||
                JSON.stringify(activated.datasetIds) !== JSON.stringify(datasetIds)
              )
                throw new Error("Collection access could not be confirmed.");
              return address(published.authorityRevision);
            } catch (error) {
              operation.signal.throwIfAborted();
              session.assertCurrent();
              if (error instanceof Error && error.name === "AbortError") throw error;
              throw new Error(
                `The app is published. ${error instanceof Error ? error.message : "Collection access could not be confirmed."} Reload the publications before trying again.`,
              );
            }
          }
          try {
            const raw = await session.run(() =>
              dependencies.relayJson(
                remote.credentials,
                `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${published.publicationId}/collection-approval`,
                {
                  method: "POST",
                  signal: operation.signal,
                  body: JSON.stringify({
                    expectedAuthorityRevision: published.authorityRevision,
                    capability,
                  }),
                },
              ),
            );
            const approval = raw as {
              publicationId?: unknown;
              authorityRevision?: unknown;
              capability?: unknown;
            } | null;
            if (
              !approval ||
              approval.publicationId !== published.publicationId ||
              approval.authorityRevision !== published.authorityRevision + 1 ||
              JSON.stringify(parseAppCollectionCapability(approval.capability)) !==
                JSON.stringify(capability)
            )
              throw new Error("Collection approval changed.");
            return address(Number(approval.authorityRevision));
          } catch (error) {
            operation.signal.throwIfAborted();
            session.assertCurrent();
            if (error instanceof Error && error.name === "AbortError") throw error;
            const detail =
              error instanceof Error ? error.message : "Collection access could not be confirmed.";
            throw new Error(
              `The app is published. ${detail} Reload the publications before trying again.`,
            );
          }
        };
        if (entry.reactivation) {
          const raw = await session.run(() =>
            dependencies.relayJson(
              remote.credentials,
              `/sync/${encodeURIComponent(input.workspaceId)}/app-publications/${entry.reactivation!.publicationId}/reactivate`,
              {
                method: "POST",
                signal: operation.signal,
                body: JSON.stringify({
                  expectedAuthorityRevision: entry.reactivation!.authorityRevision,
                  agent,
                }),
              },
            ),
          );
          const row = raw as {
            publicationId?: string;
            active?: boolean;
            authorityRevision?: number;
            owner?: {
              workspaceId?: string;
              shareId?: string;
              grantId?: string;
              generation?: number;
            };
          } | null;
          if (
            !row ||
            row.publicationId !== entry.reactivation.publicationId ||
            row.active !== true ||
            row.owner?.workspaceId !== input.workspaceId ||
            (entry.input.audience === "workspace"
              ? row.owner.grantId !== undefined
              : row.owner.shareId !== entry.input.shareId ||
                row.owner.grantId !== entry.input.grantId ||
                row.owner.generation !== prepared.generation)
          )
            throw new Error(
              "dohc could not confirm that this app was republished. Refresh the publication list.",
            );
          return finishPublication(row.publicationId, row.authorityRevision);
        }
        for (const file of prepared.files) {
          await session.run(() =>
            dependencies.upload(
              remote.credentials,
              input.workspaceId,
              file.sha256,
              file.bytes,
              operation.signal,
            ),
          );
        }
        const rawResult = await session.run(() =>
          dependencies.relayJson(
            remote.credentials,
            `/sync/${encodeURIComponent(input.workspaceId)}/app-publications`,
            {
              method: "POST",
              signal: operation.signal,
              body: JSON.stringify(publishBody(entry.input, prepared.generation, candidate)),
            },
          ),
        );
        if (!rawResult || typeof rawResult !== "object")
          throw new Error("dohc could not read the publication result.");
        const row = rawResult as Record<string, unknown>;
        const owner = row.owner as Record<string, unknown> | undefined;
        if (
          !owner ||
          owner.workspaceId !== input.workspaceId ||
          (entry.input.audience === "workspace"
            ? owner.grantId !== undefined
            : owner.shareId !== entry.input.shareId ||
              owner.grantId !== entry.input.grantId ||
              owner.generation !== prepared.generation) ||
          JSON.stringify(row.candidate) !== JSON.stringify(candidate)
        )
          throw new Error("The app publication changed. Review it again.");
        if (row.operatorTakedown)
          throw new Error(
            "The server operator disabled this publication. Contact the server operator.",
          );
        if (row.active !== true)
          throw new Error(
            "This app is already unpublished. Review it from the publication list to republish it.",
          );
        return finishPublication(row.publicationId, row.authorityRevision);
      }
      // A window holds one prepared bundle. Replacement releases its old bytes.
      if (preparing.has(callerKey))
        throw new Error("This caller is already preparing an app. Wait for it to finish.");
      for (const entry of pending.values()) if (entry.callerKey === callerKey) entry.clear();
      if (pending.size + preparing.size >= 8)
        throw new Error(
          "Too many apps await publication. Cancel another preparation and try again.",
        );
      const preparation = Symbol("app preparation");
      preparing.set(callerKey, preparation);
      const assertPreparing = () => {
        session.assertCurrent();
        if (preparing.get(callerKey) !== preparation)
          throw new Error("A newer app preparation replaced this one.");
      };
      try {
        const grant =
          input.audience === "workspace"
            ? null
            : await currentGrant(input.shareId!, input.grantId!);
        const capture = await session.run(() => dependencies.flushCapture(operation.workspace));
        const prepared = await session.run(() =>
          dependencies.withAdapter(operation.workspace, (adapter) =>
            prepareOwnerAppPublication(input, grant, {
              adapter,
              signal: operation.signal,
              assertCurrent: assertPreparing,
              compile: dependencies.compile,
              resolveDatasetRevision,
              deferredWrites: capture.deferredWrites,
            }),
          ),
        );
        if (!prepared)
          throw new Error("dohc could not capture this app. Restart dohc and try again.");
        const { candidate } = prepared;
        assertPreparing();
        const publishEnvelopeBytes = Buffer.byteLength(
          JSON.stringify(publishBody(input, prepared.generation, candidate)),
          "utf8",
        );
        if (
          publishEnvelopeBytes > APP_PUBLICATION_MAX_REQUEST_BYTES ||
          prepared.files.some((file) => file.byteLength > APP_PUBLICATION_MAX_BLOB_BYTES)
        ) {
          throw new Error(
            "This app exceeds the supported publication size. Choose a smaller build.",
          );
        }
        if (!grant) return await remember(prepared, input, undefined, "workspace");
        if (!["view", "comment", "edit"].includes(grant.access))
          throw new Error("This app link access is unavailable.");
        return await remember(prepared, input, undefined, {
          access: grant.access as "view" | "comment" | "edit",
          selector: grant.selector,
        });
      } finally {
        if (preparing.get(callerKey) === preparation) preparing.delete(callerKey);
      }
    });
  };
}

/** Electron renderer adapter. Agents call createOwnerAppPublicationHandler directly. */
export function registerOwnerAppPublicationIpc<
  Sender extends { id: number },
  Workspace extends { workspaceId: string; shareView?: unknown },
  Operation extends {
    workspace: Workspace;
    signal: AbortSignal;
    session: { generation: number };
    assertCurrent(): void;
  },
>(
  dependencies: Omit<
    Parameters<typeof createOwnerAppPublicationHandler<Sender, Workspace, Operation>>[0],
    "callerKey" | "withWorkspaceOperation"
  > & {
    registerHandler(
      channel: string,
      handler: (event: { sender: Sender }, payload: unknown) => unknown,
    ): void;
    assertTrustedSender(event: { sender: Sender }): void;
    withRendererWorkspaceOperation<Result>(
      sender: Sender,
      workspaceId: string,
      message: string,
      work: (operation: Operation) => Promise<Result>,
    ): Promise<Result>;
  },
): void {
  const handler = createOwnerAppPublicationHandler<
    Sender,
    Workspace,
    Operation & { scope: string }
  >({
    callerKey: (sender: Sender) => String(sender.id),
    withWorkspaceOperation: (sender, workspaceId, work) =>
      dependencies.withRendererWorkspaceOperation(
        sender,
        workspaceId,
        "Publishing stopped because this window changed workspaces.",
        async (operation) => work({ ...operation, scope: `${operation.session.generation}` }),
      ),
    ...dependencies,
  });
  dependencies.registerHandler(
    CHANNELS.publishOwnerApp,
    async (event: { sender: Sender }, raw: unknown) => {
      dependencies.assertTrustedSender(event);
      return handler(event.sender, raw);
    },
  );
}
