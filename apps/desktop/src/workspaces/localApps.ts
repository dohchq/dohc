import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { LocalAppExternal } from "./localAppExternal";
import type { LocalAppLaunchBackend } from "./localAppLaunch";
import type { LocalAppPrepared, LocalAppRow, LocalAppStore } from "./localAppStore";
import type { createLocalCollectionApps } from "./localCollectionApps";
import type { createLocalDatasetApps } from "./localDatasetApps";
import type { createServerDatasetApps } from "./serverDatasetApps";
import type { createLocalUnconnectedApps } from "./localUnconnectedApps";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";

/** The only local publication API exposed to owner handlers and browser launch. */
export function createLocalApps(
  store: LocalAppStore,
  dataset: ReturnType<typeof createLocalDatasetApps>,
  collection: ReturnType<typeof createLocalCollectionApps>,
  unconnected: ReturnType<typeof createLocalUnconnectedApps>,
  onPublicationChanged?: () => void,
  localBudget?: () => boolean,
  external?: LocalAppExternal,
  onServer?: () => Pick<ReturnType<typeof createServerDatasetApps>, "external"> | null,
) {
  const kind = (publicationId: string, expected?: number) => {
    const row = store.row(publicationId, expected);
    (row.kind === "dataset"
      ? dataset
      : row.kind === "collection"
        ? collection
        : unconnected
    ).current(publicationId, expected);
    return row.kind;
  };
  // Ending or replacing a Dataset app's authority ends its binding in the same commit.
  const displace = (displaced: LocalAppRow | undefined, commit: () => void) =>
    displaced?.kind === "dataset" || (displaced?.candidate.external && onServer?.())
      ? dataset.withdrawBinding(displaced, commit)
      : commit();
  const backend: LocalAppLaunchBackend = {
    browserPublication(publicationId) {
      kind(publicationId);
      return store.browserPublication(publicationId);
    },
    assertBrowserPublication(publicationId, authorityRevision) {
      kind(publicationId, authorityRevision);
    },
    async checkBrowserPublication(publicationId, authorityRevision, signal) {
      if (kind(publicationId, authorityRevision) === "collection")
        await collection.checkBrowserPublication(publicationId, authorityRevision, signal);
    },
    request: async (publicationId, action, input, signal, activated) => {
      const reached = kind(publicationId);
      if (reached === "unconnected")
        throw new Error("This app is not approved for workspace data.");
      return reached === "dataset"
        ? dataset.request(publicationId, action, input, signal, activated)
        : collection.request(publicationId, action, input, signal, activated);
    },
    external: async (publicationId, input, signal) => {
      kind(publicationId, input.authorityRevision);
      const operation = store
        .row(publicationId, input.authorityRevision)
        .candidate.external?.find((value) => value.name === input.operation);
      if (!operation || !external)
        throw new AppBackendRuntimeError({
          code: "external_not_approved",
          message: `This app has no approved outside call named ${JSON.stringify(input.operation)}.`,
        });
      const server = onServer?.();
      if (server) {
        const blocked = external.unavailable();
        if (blocked)
          throw new AppBackendRuntimeError({ code: "external_unavailable", message: blocked });
        return server.external(publicationId, input, signal);
      }
      return external.call(operation, input.input, signal, () =>
        kind(publicationId, input.authorityRevision),
      );
    },
    readBrowserFile: async (publicationId, input, signal) => {
      if (kind(publicationId) !== "dataset")
        throw new Error("This app cannot read Collection files.");
      return dataset.readBrowserFile(publicationId, input, signal);
    },
    datasetRevisions(publicationId, authorityRevision) {
      return kind(publicationId, authorityRevision) === "dataset"
        ? dataset.datasetRevisions(publicationId, authorityRevision)
        : null;
    },
    subscribeDatasetChanges(publicationId, authorityRevision, onWake) {
      return kind(publicationId, authorityRevision) === "dataset"
        ? dataset.subscribeDatasetChanges(publicationId, authorityRevision, onWake)
        : () => {};
    },
    ...(localBudget ? { localBudget } : {}),
  };
  return {
    ...backend,
    async activate(prepared: LocalAppPrepared, signal: AbortSignal, agent?: ApprovalAgent | null) {
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      const blocked = candidate.external
        ? external
          ? external.unavailable()
          : "Apps can call outside services only in your own workspaces."
        : null;
      if (blocked) throw new Error(blocked);
      if (
        candidate.external &&
        candidate.capabilities[0]?.kind === "collection-create" &&
        onServer?.()
      )
        throw new Error(
          "Apps that create Collection files can't call outside services in synced workspaces.",
        );
      // Replacing a Collection app first settles the responses it admitted.
      await collection.settleRoot(candidate.appRoot);
      const declared = candidate.capabilities[0];
      const result = !declared
        ? unconnected.activate(prepared, signal, agent, displace)
        : declared.kind !== "collection-create"
          ? await dataset.activate(prepared, signal, agent)
          : await collection.activate(prepared, signal, agent, displace);
      onPublicationChanged?.();
      return result;
    },
    has: (publicationId: string) => store.has(publicationId),
    verificationPublication(publicationId: string) {
      kind(publicationId);
      return store.verificationPublication(publicationId);
    },
    heldDatasetApp: (publicationId: string) => {
      const value = store.heldRow(publicationId);
      return value?.kind === "dataset" ? value : null;
    },
    list: (appRoot: string, versionId: string) =>
      store
        .list(appRoot)
        .filter((value) => value.candidate.versionId === versionId)
        .map((value) => ({
          ...(value.kind === "dataset"
            ? dataset.describe(value)
            : value.kind === "collection"
              ? collection.describe(value)
              : unconnected.describe(value)),
          ...(value.candidate.external ? { external: value.candidate.external } : {}),
          versionId,
        })),
    /** Confirmed only when no admitted response can still be saved. Repeat at the returned revision to confirm. */
    async withdraw(publicationId: string, expected: number) {
      const ended = store.withdraw(publicationId, expected, displace);
      onPublicationChanged?.();
      const unresolvedCreates =
        ended.kind === "collection" ? await collection.confirm(publicationId) : 0;
      return unresolvedCreates
        ? {
            kind: "withdrawalUnconfirmed" as const,
            publicationId,
            authorityRevision: ended.authorityRevision,
            unresolvedCreates,
          }
        : { kind: "withdrawn" as const, publicationId, authorityRevision: ended.authorityRevision };
    },
    reconcile: () => collection.reconcile(),
    close: () => collection.close(),
  };
}

type LocalApps = ReturnType<typeof createLocalApps>;

export function routeLocalApps(main: LocalApps, preview: LocalApps): LocalApps {
  const of = (publicationId: string) => (preview.has(publicationId) ? preview : main);
  return {
    browserPublication: (id) => of(id).browserPublication(id),
    assertBrowserPublication: (id, revision) => of(id).assertBrowserPublication(id, revision),
    checkBrowserPublication: async (id, revision, signal) =>
      of(id).checkBrowserPublication?.(id, revision, signal),
    request: (id, ...rest) => of(id).request(id, ...rest),
    external: (id, input, signal) => of(id).external!(id, input, signal),
    readBrowserFile: (id, input, signal) => of(id).readBrowserFile(id, input, signal),
    datasetRevisions: (id, revision) => of(id).datasetRevisions?.(id, revision) ?? null,
    subscribeDatasetChanges: (id, revision, onWake) =>
      of(id).subscribeDatasetChanges?.(id, revision, onWake) ?? (() => {}),
    ...(main.localBudget ? { localBudget: main.localBudget } : {}),
    activate: (prepared, signal, agent) =>
      (prepared.candidate.versionId === "main" ? main : preview).activate(prepared, signal, agent),
    has: (id) => main.has(id) || preview.has(id),
    verificationPublication: (id) => of(id).verificationPublication(id),
    heldDatasetApp: (id) => main.heldDatasetApp(id),
    list: (appRoot, versionId) => (versionId === "main" ? main : preview).list(appRoot, versionId),
    withdraw: (id, expected) => of(id).withdraw(id, expected),
    reconcile: () => main.reconcile(),
    close: async () => {
      await Promise.all([main.close(), preview.close()]);
    },
  };
}
