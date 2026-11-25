import type { AddressedDatasetDescription, DatasetBoundApp } from "@dohc/cli/dataset";
import type { ListCollectionAutomationsResult } from "../ipc/bridgeContract";
import { triggerParts, type Automation } from "./collections/automationSentence";

export const CONNECTIONS_SHOWN = 50;

export interface ConnectedApp {
  publicationId: string;
  appRoot: string;
  alias?: string;
  scope: DatasetBoundApp["scope"];
  /** Null when an operation the app was approved for is no longer in the Collection. */
  writes: boolean | null;
  status: DatasetBoundApp["status"];
  reasons: string[];
  /** The other Collections in this view the same app uses. */
  also: string[];
}

export interface ConnectedAutomation {
  key: string;
  name: string;
  trigger: string | null;
  enabled: boolean;
  cannotRun: string | null;
}

export interface CollectionConnections {
  datasetId: string;
  name: string;
  /** Null when this viewer cannot see which apps use the Collection. */
  apps: ConnectedApp[] | null;
  automations: ConnectedAutomation[];
  /** dohc could not check some of the apps or automations that use it. */
  incomplete: boolean;
  failed: boolean;
}

export interface ConnectionReads {
  /** Only the owner reads which apps use a Collection. */
  apps?(
    datasetPath: string,
    datasetId: string,
  ): Promise<{ boundApps?: DatasetBoundApp[]; boundAppsIncomplete?: boolean }>;
  automations(collectionPath: string): Promise<ListCollectionAutomationsResult>;
}

const shown = (
  automation: Automation,
  enabled: boolean,
  cannotRun: string | null,
): ConnectedAutomation => ({
  key: automation.id,
  name: automation.name,
  trigger: triggerParts(automation.when)
    .map((part) => part.text)
    .join(""),
  enabled,
  cannotRun,
});
const unread = (index: number, entry: { id: string | null; name: string | null }) => ({
  key: `invalid:${index}`,
  name: entry.name ?? entry.id ?? "Automation",
  trigger: null,
  enabled: false,
  cannotRun: "dohc could not read this automation.",
});

function automationsOf(file: ListCollectionAutomationsResult) {
  const listed = file.status === "shared" ? file.definitions.file : file;
  if (listed.status !== "read")
    return { automations: [], unreadable: listed.status === "unreadable" };
  const automations: ConnectedAutomation[] =
    "entries" in listed
      ? listed.entries.map((entry, index) =>
          entry.status === "valid"
            ? shown(entry.automation, entry.enabledInFile ?? entry.automation.enabled, null)
            : unread(index, entry),
        )
      : listed.automations.map((entry, index) =>
          entry.valid
            ? shown(entry.automation, entry.automation.enabled, entry.cannotRun)
            : unread(index, entry),
        );
  return { automations, unreadable: false };
}

/**
 * Which apps and automations use each Collection the viewer can open. A
 * Collection with no folder in reach is left out, and so are its apps.
 */
export async function readCollectionConnections(
  datasets: readonly AddressedDatasetDescription[],
  reads: ConnectionReads,
  signal: AbortSignal,
): Promise<CollectionConnections[]> {
  const shown = datasets
    .filter((dataset) => dataset.datasetPath !== null && !dataset.archived)
    .slice(0, CONNECTIONS_SHOWN);
  const read = async (dataset: AddressedDatasetDescription) => {
    const path = dataset.datasetPath!;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    try {
      const [bound, file] = await Promise.all([
        reads.apps?.(path, dataset.datasetId) ?? null,
        reads.automations(folder),
      ]);
      const operations = new Map(dataset.operations.map((op) => [op.operationId, op]));
      const { automations, unreadable } = automationsOf(file);
      return {
        datasetId: dataset.datasetId,
        name: dataset.name,
        apps:
          bound === null
            ? null
            : (bound.boundApps ?? []).map((app) => {
                const ops = app.operationIds.map((id) => operations.get(id));
                return {
                  publicationId: app.publicationId,
                  appRoot: app.appRoot,
                  ...(app.alias === undefined ? {} : { alias: app.alias }),
                  scope: app.scope,
                  writes: ops.every((op) => op !== undefined)
                    ? ops.some((op) => !op.readOnly)
                    : null,
                  status: app.status,
                  reasons: app.reasons ?? [],
                  also: [] as string[],
                };
              }),
        automations,
        incomplete: Boolean(bound?.boundAppsIncomplete) || unreadable,
        failed: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        datasetId: dataset.datasetId,
        name: dataset.name,
        apps: null,
        automations: [],
        incomplete: false,
        failed: true,
      };
    }
  };
  const groups: CollectionConnections[] = [];
  for (let start = 0; start < shown.length; start += 4) {
    groups.push(...(await Promise.all(shown.slice(start, start + 4).map(read))));
    signal.throwIfAborted();
  }
  const uses = new Map<string, CollectionConnections[]>();
  for (const group of groups)
    for (const app of group.apps ?? [])
      uses.set(app.publicationId, [...(uses.get(app.publicationId) ?? []), group]);
  for (const group of groups)
    for (const app of group.apps ?? [])
      app.also = uses
        .get(app.publicationId)!
        .filter((other) => other !== group)
        .map((other) => other.name);
  return groups;
}
