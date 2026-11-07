import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { LocalAppLaunchBackend } from "./localAppLaunch";
import type { LocalAppPrepared, LocalAppRow, LocalAppStore } from "./localAppStore";
import type { createLocalCollectionApps } from "./localCollectionApps";
import type { createLocalDatasetApps } from "./localDatasetApps";
import type { createLocalUnconnectedApps } from "./localUnconnectedApps";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";

/** The only local publication API exposed to owner handlers and browser launch. */
export function createLocalApps(store: LocalAppStore, dataset: ReturnType<typeof createLocalDatasetApps>, collection: ReturnType<typeof createLocalCollectionApps>,
  unconnected: ReturnType<typeof createLocalUnconnectedApps>) {
  const kind = (publicationId: string, expected?: number) => {
    const row = store.row(publicationId, expected);
    (row.kind === "dataset" ? dataset : row.kind === "collection" ? collection : unconnected).current(publicationId, expected);
    return row.kind;
  };
  // Ending or replacing a Dataset app's authority ends its binding in the same commit.
  const displace = (displaced: LocalAppRow | undefined, commit: () => void) => displaced?.kind === "dataset" ? dataset.withdrawBinding(displaced, commit) : commit();
  const backend: LocalAppLaunchBackend = {
    browserPublication(publicationId) {
      kind(publicationId);
      return store.browserPublication(publicationId);
    },
    assertBrowserPublication(publicationId, authorityRevision) {
      kind(publicationId, authorityRevision);
    },
    async checkBrowserPublication(publicationId, authorityRevision, signal) {
      if (kind(publicationId, authorityRevision) === "collection") await collection.checkBrowserPublication(publicationId, authorityRevision, signal);
    },
    request: async (publicationId, action, input, signal) => {
      const reached = kind(publicationId);
      if (reached === "unconnected") throw new Error("This app is not approved for workspace data.");
      return reached === "dataset" ? dataset.request(publicationId, action, input, signal) : collection.request(publicationId, action, input, signal);
    },
    readBrowserFile: async (publicationId, input, signal) => {
      if (kind(publicationId) !== "dataset") throw new Error("This app cannot read Collection files.");
      return dataset.readBrowserFile(publicationId, input, signal);
    },
  };
  return {
    ...backend,
    async activate(prepared: LocalAppPrepared, signal: AbortSignal, agent?: ApprovalAgent | null) {
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      // Replacing a Collection app first settles the responses it admitted.
      await collection.settleRoot(candidate.appRoot);
      const declared = candidate.capabilities[0];
      if (!declared) return unconnected.activate(prepared, signal, agent, displace);
      if (declared.kind !== "collection-create") return dataset.activate(prepared, signal, agent);
      return collection.activate(prepared, signal, agent, displace);
    },
    has: (publicationId: string) => store.has(publicationId),
    list: (appRoot: string) => store.list(appRoot).map(value => value.kind === "dataset" ? dataset.describe(value) : value.kind === "collection" ? collection.describe(value) : unconnected.describe(value)),
    /** Confirmed only when no admitted response can still be saved. Repeat at the returned revision to confirm. */
    async withdraw(publicationId: string, expected: number) {
      const ended = store.withdraw(publicationId, expected, displace);
      const unresolvedCreates = ended.kind === "collection" ? await collection.confirm(publicationId) : 0;
      return unresolvedCreates
        ? { kind: "withdrawalUnconfirmed" as const, publicationId, authorityRevision: ended.authorityRevision, unresolvedCreates }
        : { kind: "withdrawn" as const, publicationId, authorityRevision: ended.authorityRevision };
    },
    reconcile: () => collection.reconcile(),
    close: () => collection.close(),
  };
}
