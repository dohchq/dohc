import type { DatasetReplicaSource } from "@dohc/app-backend-runtime/replica";
import { parseDatasetDescription, type DatasetDescription } from "@dohc/security-contract/dataset";
import { CollectionServerUnreachableError } from "../ipc/errorWords";
import type { RegistryEntry, RemoteIdentity } from "./registryStore";
import { routeEachDataset, type OwnerDatasetData } from "./remoteDataset";

/**
 * The server that holds a workspace's data Collections: the one it syncs
 * with, also while sync is paused. Null for a workspace with no server, whose
 * Collections this computer keeps, and for a received share, which reads the
 * sharer's.
 */
export function collectionsServer(
  entry: Pick<RegistryEntry, "shareView" | "remote" | "pausedRemote">,
): RemoteIdentity | null {
  if (entry.shareView !== undefined) return null;
  return entry.remote ?? entry.pausedRemote ?? null;
}

/** The last Collections list this computer read from the server, for reading offline. */
export interface SavedCollectionsList {
  read(): Promise<unknown>;
  write(value: DatasetDescription[]): Promise<void>;
}

/**
 * The server as a signed-out read meets it: every request is refused before
 * it is sent, as any request without a session is. The kept copy answers
 * what it can in front of it.
 */
export function signedOutServer(): OwnerDatasetData & DatasetReplicaSource {
  const refuse = async (): Promise<never> => {
    throw new Error("Sign in to your server first.");
  };
  // A Record, so a request the server gains is refused here too.
  const names: Record<keyof OwnerDatasetData | keyof DatasetReplicaSource, true> = {
    prepareMigrationCandidate: true,
    approveMigrationCandidate: true,
    migrationPreviewPage: true,
    discardMigrationCandidate: true,
    inspect: true,
    historyRevision: true,
    history: true,
    list: true,
    describe: true,
    lifecycle: true,
    deletionStatus: true,
    deletePreview: true,
    deleteDataset: true,
    archive: true,
    restore: true,
    pendingAttempts: true,
    reconcileAttempt: true,
    cancelAttempt: true,
    approvedArtifacts: true,
    invoke: true,
    upload: true,
    file: true,
    permissions: true,
    setGrant: true,
    press: true,
    capture: true,
    page: true,
    blob: true,
  };
  return Object.fromEntries(Object.keys(names).map((name) => [name, refuse])) as Record<
    keyof typeof names,
    typeof refuse
  >;
}

/**
 * A syncing workspace's Collections, all on its server. Each one's work goes
 * through this computer's kept copy of it, which reads at once and sends
 * changes to the server. The list is the last one this computer read from the
 * server, brought up to date afterwards; `changed` hears when that changed it.
 * Only a computer that never read the list waits for the server.
 */
export function createServerHomeData(input: {
  host: string;
  list: OwnerDatasetData["list"];
  copy(datasetId: string): Promise<OwnerDatasetData>;
  saved: SavedCollectionsList;
  changed?(): void;
}): OwnerDatasetData {
  const savedDatasets = async (): Promise<DatasetDescription[] | null> => {
    const value = await input.saved.read().catch(() => null);
    if (!Array.isArray(value)) return null;
    try {
      return value.map((item) => parseDatasetDescription(item));
    } catch {
      return null;
    }
  };
  // The saved list takes each page in place of what it held over the same range.
  const remember = async (
    after: string | undefined,
    page: Awaited<ReturnType<typeof input.list>>,
  ) => {
    const last = page.nextCursor === null ? null : page.datasets.at(-1)?.datasetId;
    if (last === undefined) return;
    const kept = ((await savedDatasets()) ?? []).filter(
      (dataset) =>
        dataset.datasetId <= (after ?? "") || (last !== null && dataset.datasetId > last),
    );
    await input.saved.write(
      [...kept, ...page.datasets].sort((a, b) => (a.datasetId < b.datasetId ? -1 : 1)),
    );
  };
  return routeEachDataset(input.copy, async (page) => {
    const shown = (datasets: DatasetDescription[]) =>
      page.includeArchived ? datasets : datasets.filter((dataset) => !dataset.archived);
    // Archived ones too, so the saved list serves either view.
    const ask = () => input.list({ ...page, includeArchived: true });
    const saved = await savedDatasets();
    if (saved) {
      void (async () => {
        await remember(page.after, await ask());
        if (JSON.stringify(await savedDatasets()) !== JSON.stringify(saved)) input.changed?.();
      })().catch(() => undefined);
      const limit = page.limit ?? 50,
        rest = saved.filter((dataset) => dataset.datasetId > (page.after ?? ""));
      return {
        datasets: shown(rest.slice(0, limit)),
        nextCursor: rest.length > limit ? rest[limit - 1]!.datasetId : null,
      };
    }
    let answer: Awaited<ReturnType<typeof input.list>>;
    try {
      answer = await ask();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new CollectionServerUnreachableError(
        `This workspace's Collections are on ${input.host}, which dohc can't reach.`,
        { cause: error },
      );
    }
    // A list that can't be saved still answers.
    await remember(page.after, answer).catch(() => undefined);
    return { datasets: shown(answer.datasets), nextCursor: answer.nextCursor };
  });
}
