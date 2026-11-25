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
  /**
   * Saves what `change` makes of the saved list, given undefined for none it can read.
   * Undefined keeps the list as it is. Changes run one at a time.
   */
  update(change: (value: unknown) => SavedCollections | undefined): Promise<void>;
}
/**
 * The Collections a list saved, in order. `through`: the last one it holds
 * every Collection up to, or null when it holds them all.
 */
export interface SavedCollections {
  datasets: DatasetDescription[];
  through: string | null;
}
function parseSaved(value: unknown): SavedCollections | null {
  if (typeof value !== "object" || value === null) return null;
  const { datasets, through } = value as Record<string, unknown>;
  if (!Array.isArray(datasets) || (through !== null && typeof through !== "string")) return null;
  try {
    return { datasets: datasets.map((item) => parseDatasetDescription(item)), through };
  } catch {
    return null;
  }
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
    querySql: true,
    trace: true,
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
  const savedDatasets = async () => parseSaved(await input.saved.read().catch(() => null));
  // The saved list takes each page in place of what it held over the same range.
  // A page past the Collections it holds every one of would leave a gap, so it is not saved.
  const remember = (after: string | undefined, page: Awaited<ReturnType<typeof input.list>>) =>
    input.saved.update((value) => {
      const last = page.nextCursor === null ? null : page.datasets.at(-1)?.datasetId;
      if (last === undefined) return undefined;
      const from = after ?? "",
        saved = parseSaved(value) ?? { datasets: [], through: "" };
      if (saved.through !== null && from > saved.through) return undefined;
      const kept = saved.datasets.filter(
        (dataset) => dataset.datasetId <= from || (last !== null && dataset.datasetId > last),
      );
      // A page that ends the list makes the saved list whole. A page that goes on
      // keeps a whole list whole only if it holds Collections after the page;
      // otherwise the server has more than it saved, and it is whole only through the page.
      const whole =
        last === null ||
        (saved.through === null && kept.some((dataset) => dataset.datasetId > last));
      return {
        datasets: [...kept, ...page.datasets].sort((a, b) => (a.datasetId < b.datasetId ? -1 : 1)),
        through: whole
          ? null
          : saved.through === null || last > saved.through
            ? last
            : saved.through,
      };
    });
  return routeEachDataset(input.copy, async (page) => {
    const shown = (datasets: DatasetDescription[]) =>
      page.includeArchived ? datasets : datasets.filter((dataset) => !dataset.archived);
    // Archived ones too, so the saved list serves either view.
    const ask = () => input.list({ ...page, includeArchived: true });
    const saved = await savedDatasets(),
      limit = page.limit ?? 50,
      rest = saved?.datasets.filter((dataset) => dataset.datasetId > (page.after ?? "")) ?? [];
    // The saved list answers a page it holds all of: the end of a whole list, or a full page.
    if (saved && (saved.through === null || rest.length >= limit)) {
      void (async () => {
        await remember(page.after, await ask());
        if (JSON.stringify(await savedDatasets()) !== JSON.stringify(saved)) input.changed?.();
      })().catch(() => undefined);
      return {
        datasets: shown(rest.slice(0, limit)),
        nextCursor:
          rest.length > limit || (saved.through !== null && rest.length === limit)
            ? rest[limit - 1]!.datasetId
            : null,
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
