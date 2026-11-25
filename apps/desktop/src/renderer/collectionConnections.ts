import type { AddressedDatasetDescription, DatasetBoundApp } from "@dohc/cli/dataset";
import type { ListCollectionAutomationsResult } from "../ipc/bridgeContract";
import { triggerParts, type Automation } from "./collections/automationSentence";

export interface ConnectedApp {
  publicationId: string;
  appRoot: string;
  alias?: string;
  scope: DatasetBoundApp["scope"];
  /** Null when an operation the app was approved for is no longer in the Collection. */
  access: "Reads" | "Writes" | "Reads and writes" | null;
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
  key: string;
  name: string;
  /** Null when this viewer cannot see which apps use the Collection, or no app can. */
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
 * Which apps and automations use each Collection the viewer can open: the
 * Collections and document Collection folders Home has listed. A Collection
 * with no folder in reach is left out, and so are its apps.
 */
export async function readCollectionConnections(
  datasets: readonly AddressedDatasetDescription[],
  documentFolders: readonly string[],
  reads: ConnectionReads,
  signal: AbortSignal,
): Promise<CollectionConnections[]> {
  const sources = [
    ...datasets.flatMap((dataset) =>
      dataset.datasetPath === null || dataset.archived
        ? []
        : [{ key: dataset.datasetId, name: dataset.name, path: dataset.datasetPath, dataset }],
    ),
    ...documentFolders.map((path) => ({
      key: `folder:${path}`,
      name: path.slice(path.lastIndexOf("/") + 1),
      path: `${path}/collection.yaml`,
      dataset: null,
    })),
  ];
  const read = async (source: (typeof sources)[number]): Promise<CollectionConnections> => {
    const folder = source.path.includes("/")
      ? source.path.slice(0, source.path.lastIndexOf("/"))
      : "";
    const base = { key: source.key, name: source.name };
    try {
      const [bound, file] = await Promise.all([
        source.dataset && reads.apps ? reads.apps(source.path, source.dataset.datasetId) : null,
        folder ? reads.automations(folder) : null,
      ]);
      const operations = new Map(source.dataset?.operations.map((op) => [op.operationId, op]));
      const { automations, unreadable } = file
        ? automationsOf(file)
        : { automations: [], unreadable: false };
      return {
        ...base,
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
                  access: ops.some((op) => op === undefined)
                    ? null
                    : ops.every((op) => op!.readOnly)
                      ? "Reads"
                      : ops.some((op) => op!.readOnly)
                        ? "Reads and writes"
                        : "Writes",
                  status: app.status,
                  reasons: app.reasons ?? [],
                  also: [],
                };
              }),
        automations,
        incomplete: Boolean(bound?.boundAppsIncomplete) || unreadable,
        failed: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ...base, apps: null, automations: [], incomplete: false, failed: true };
    }
  };
  const groups: CollectionConnections[] = [];
  for (let start = 0; start < sources.length; start += 4) {
    groups.push(...(await Promise.all(sources.slice(start, start + 4).map(read))));
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
