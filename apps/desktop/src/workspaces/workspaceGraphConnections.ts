import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  codeFilesOf,
  collectionAutomationId,
  stepsInOrder,
} from "@dohc/automation-executor/automation-plan";
import { parseDatasetDefinition } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import {
  LINKS_CONNECTIONS_MAX_BYTES,
  SHARE_OMITTED_CONNECTIONS,
  type LinksConnectionEdge,
  type LinksConnectionNode,
  type LinksConnectionsResult,
} from "@dohc/workspace-contracts/links";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { isDatasetDescriptor } from "./datasetAddress";
import { parseAppPublicationDeclaration } from "./ownerAppPublication";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";

type Adapter = Pick<
  VersionedLiveAdapter,
  | "getActiveVersion"
  | "listTextFileMetadata"
  | "readTextFile"
  | "listCollections"
  | "getCollection"
  | "queryCollectionRecords"
>;
type Workspace = Pick<RegistryEntry, "workspaceId" | "shareView" | "shareMounts">;
export type GraphApp = {
  root: string;
  title: string;
  entryPath: string | null;
  sourceFiles: string[];
};
export type GraphApproval = { appRoot: string; kind: string; resourceId: string };
export type GraphGroup = { id: string; kind: string; name: string; slug: string };

export const CONNECTION_LIMITS = { collections: 200, datasets: 100, apps: 100, records: 200 };
const STRUCTURAL = new Set([
  "collection.yaml",
  "automations.yaml",
  "dataset.json",
  "app.publish.json",
  "dohc.json",
  "package.json",
]);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const join = (folder: string, name: string) => (folder === "." ? name : `${folder}/${name}`);

async function eachLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
  return results;
}

export function fitConnections(result: LinksConnectionsResult): LinksConnectionsResult {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;
  let budget =
    LINKS_CONNECTIONS_MAX_BYTES -
    size({ ...result, nodes: [], edges: [], records: [], complete: false });
  let complete = result.complete;
  const fits = (item: unknown) => {
    const cost = size(item);
    if (cost > budget) {
      complete = false;
      return false;
    }
    budget -= cost;
    return true;
  };
  const nodes = result.nodes.filter(fits);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = result.edges.filter(
    (edge) =>
      ids.has(edge.source) &&
      (ids.has(edge.target) || edge.kind === "automation-runs-file") &&
      fits(edge),
  );
  const records = result.records
    .filter((entry) => ids.has(entry.collection) && fits({ ...entry, paths: [] }))
    .map((entry) => ({ ...entry, paths: entry.paths.filter(fits) }));
  return { ...result, nodes, edges, records, complete };
}

export function createWorkspaceGraphConnections<W extends Workspace>(deps: {
  withAdapter<T>(workspace: W, run: (adapter: Adapter) => Promise<T>): Promise<T | null>;
  apps(workspace: W): Promise<GraphApp[]>;
  approvals(workspace: W): Promise<GraphApproval[]>;
  groups(workspace: W): Promise<GraphGroup[]>;
}) {
  const cache = new Map<string, { key: string; value: LinksConnectionsResult }>();

  async function read(workspace: W, adapter: Adapter): Promise<LinksConnectionsResult> {
    const { workspaceId } = workspace;
    const versionId = (await adapter.getActiveVersion({ workspaceId }))?.id ?? "main";
    const files = await adapter.listTextFileMetadata({ workspaceId, versionId });
    const [approvals, groups] = await Promise.all([
      deps.approvals(workspace),
      deps.groups(workspace),
    ]);
    const signature = createHash("sha256").update(JSON.stringify([versionId, approvals, groups]));
    for (const file of files)
      signature.update(
        STRUCTURAL.has(posix.basename(file.path))
          ? `${file.path}\0${file.sha256}\n`
          : `${file.path}\n`,
      );
    const key = signature.digest("hex");
    const cached = cache.get(workspaceId);
    if (cached?.key === key) return cached.value;

    const listed = new Set(files.map((file) => file.path));
    const nodes = new Map<string, LinksConnectionNode>();
    const edges = new Map<string, LinksConnectionEdge>();
    const records: LinksConnectionsResult["records"] = [];
    let complete = true;
    const capped = <T>(items: T[], limit: number) => {
      if (items.length > limit) complete = false;
      return items.slice(0, limit);
    };
    const edge = (value: LinksConnectionEdge) => {
      if (value.source !== value.target)
        edges.set(JSON.stringify([value.source, value.target, value.kind, value.approval]), value);
    };
    const readText = async (path: string) => {
      if (!listed.has(path)) return null;
      const file = await adapter.readTextFile({
        workspaceId,
        versionId,
        path,
        maxBytes: 256 * 1024,
      });
      return file && "text" in file && typeof file.text === "string" ? file.text : null;
    };
    const owners = new Map<string, { id: string; engineId: string | null }>();

    const collections = capped(
      (await adapter.listCollections()).collections
        .filter((entry) => !isSharedWithMePath(entry.path))
        .sort((a, b) => byText(a.path, b.path)),
      CONNECTION_LIMITS.collections,
    );
    const details = await eachLimited(collections, async (summary) => {
      const [collection, query] = await Promise.all([
        adapter.getCollection({ collectionPath: summary.path }).catch(() => null),
        adapter
          .queryCollectionRecords({
            collectionPath: summary.path,
            limit: CONNECTION_LIMITS.records,
          })
          .catch(() => null),
      ]);
      return { summary, collection, query };
    });
    for (const { summary, collection, query } of details) {
      const id = `collection:${summary.path}`;
      nodes.set(id, {
        id,
        kind: "document-collection",
        path: summary.path,
        title: collection?.schema.name || posix.basename(summary.path),
        recordCount: collection?.recordCount ?? 0,
      });
      owners.set(summary.path, { id, engineId: summary.objectId });
      if (query?.nextCursor) complete = false;
      const paths = (query?.records ?? []).map((record) => record.path).sort(byText);
      if (paths.length) records.push({ collection: id, paths });
    }
    for (const { summary, collection } of details)
      for (const field of collection?.schema.fields ?? [])
        if (field.type === "relation")
          edge({
            source: `collection:${summary.path}`,
            target: `collection:${field.collection}`,
            kind: "relation",
          });

    const datasetIds = new Map<string, string>();
    const descriptors = capped(
      files
        .map((file) => file.path)
        .filter(
          (path) =>
            isDatasetDescriptor(path) && !isSharedWithMePath(path) && !path.startsWith(".dohc/"),
        )
        .sort(byText),
      CONNECTION_LIMITS.datasets,
    );
    const definitions = await eachLimited(descriptors, (path) =>
      readText(path)
        .then((text) =>
          text === null ? null : parseDatasetDefinition(JSON.parse(text), { descriptorPath: path }),
        )
        .catch(() => null),
    );
    descriptors.forEach((path, index) => {
      const definition = definitions[index];
      const folder = posix.dirname(path);
      const id = `dataset:${path}`;
      nodes.set(id, {
        id,
        kind: "dataset",
        path,
        datasetId: definition?.datasetId ?? null,
        title: definition?.name ?? (folder === "." ? "dataset.json" : posix.basename(folder)),
        firstTableId: definition?.tables[0]?.tableId ?? null,
      });
      if (definition) datasetIds.set(definition.datasetId, id);
      if (!owners.has(folder)) owners.set(folder, { id, engineId: definition?.datasetId ?? null });
    });

    const groupNode = (name: string) => {
      const channels = groups.filter((group) => group.kind === "channel");
      const bySlug = channels.find((group) => group.slug === name);
      const named = bySlug ? [bySlug] : channels.filter((group) => group.name === name);
      if (named.length !== 1) return null;
      const id = `group:${named[0]!.id}`;
      nodes.set(id, { id, kind: "group", channelId: named[0]!.id, title: named[0]!.name });
      return id;
    };
    const ownerFolders = [...owners.keys()].filter(
      (folder) => folder !== "." && listed.has(join(folder, "automations.yaml")),
    );
    const automationFiles = await eachLimited(ownerFolders, async (folder) => ({
      folder,
      text: await readText(join(folder, "automations.yaml")).catch(() => null),
    }));
    for (const { folder, text } of automationFiles) {
      const owner = owners.get(folder)!;
      const parsed = text === null || owner.engineId === null ? null : parseAutomationsFile(text);
      if (parsed?.status !== "read") continue;
      for (const entry of parsed.entries) {
        if (entry.status !== "valid") continue;
        const automation = entry.automation;
        const engineId = collectionAutomationId(owner.engineId!, automation.id);
        const id = `automation:${engineId}`;
        nodes.set(id, {
          id,
          kind: "automation",
          path: join(folder, "automations.yaml"),
          automationId: engineId,
          title: automation.name,
          enabled: automation.enabled,
        });
        edge({ source: owner.id, target: id, kind: "automation-trigger" });
        if (automation.when.kind === "group-message") {
          const group = groupNode(automation.when.group);
          if (group) edge({ source: group, target: id, kind: "automation-trigger" });
        }
        for (const { step } of stepsInOrder(automation)) {
          const target =
            step.kind === "post"
              ? groupNode(step.group)
              : (step.kind === "add-record" || step.kind === "find" || step.kind === "invoke") &&
                  step.collection
                ? owners.get(step.collection)?.id
                : null;
          if (target) edge({ source: id, target, kind: "automation-action" });
        }
        for (const file of codeFilesOf(automation, folder))
          edge({ source: id, target: posix.normalize(file), kind: "automation-runs-file" });
      }
    }

    const apps = capped(
      (await deps.apps(workspace))
        .filter((app) => !isSharedWithMePath(app.root) && !app.root.startsWith(".dohc/"))
        .sort((a, b) => byText(a.root, b.root)),
      CONNECTION_LIMITS.apps,
    );
    const manifests = await eachLimited(apps, (app) =>
      readText(join(app.root, "app.publish.json"))
        .then((text) =>
          text === null
            ? null
            : parseAppPublicationDeclaration(new TextEncoder().encode(text), app.root, {
                folder: app.sourceFiles,
              }),
        )
        .catch(() => null),
    );
    apps.forEach((app, index) => {
      const id = `app:${app.root}`;
      nodes.set(id, {
        id,
        kind: "app",
        path: app.root,
        title: app.title,
        entryPath: app.entryPath,
      });
      const approved = new Set(
        approvals
          .filter((approval) => approval.appRoot === app.root)
          .map((approval) =>
            approval.kind === "collection"
              ? `collection:${approval.resourceId}`
              : datasetIds.get(approval.resourceId),
          )
          .filter((target) => target !== undefined && nodes.has(target)),
      );
      for (const target of approved)
        edge({ source: id, target: target!, kind: "app-uses-data", approval: "approved" });
      const manifest = manifests[index];
      const requested = [
        ...(manifest?.collection ? [`collection:${manifest.collection.collectionPath}`] : []),
        ...(manifest?.dataset ? [`dataset:${manifest.dataset.datasetPath}`] : []),
        ...(manifest?.datasets ?? []).map((entry) => `dataset:${entry.reference.datasetPath}`),
      ];
      for (const target of requested)
        if (!approved.has(target) && nodes.has(target))
          edge({ source: id, target, kind: "app-uses-data", approval: "requested" });
    });

    const value = fitConnections({
      scope: "workspace",
      nodes: [...nodes.values()].sort((a, b) => byText(a.id, b.id)),
      edges: [...edges]
        .sort(([a], [b]) => byText(a, b))
        .map(([, value]) => value)
        .filter((value) => nodes.has(value.target) || value.kind === "automation-runs-file"),
      records: records.sort((a, b) => byText(a.collection, b.collection)),
      complete,
      mountsCovered: !workspace.shareMounts?.length,
    });
    cache.set(workspaceId, { key, value });
    return value;
  }

  return {
    async connections(workspace: W): Promise<LinksConnectionsResult> {
      if (shareViewIsPresent(workspace.shareView)) return SHARE_OMITTED_CONNECTIONS;
      const result = await deps.withAdapter(workspace, (adapter) => read(workspace, adapter));
      if (!result) throw new Error("Workspace engine is unavailable.");
      return result;
    },
  };
}
