import type { DatasetRequest } from "@dohc/cli/dataset";
import { createHash } from "node:crypto";
import { parseDatasetPath, type DatasetDescription } from "@dohc/security-contract/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

export type ResolvedDatasetRequest<T = DatasetRequest> = T extends { datasetPath: string } ? Omit<T, "datasetPath"> & { datasetId: string } : T;
type Adapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources" | "listTextFileMetadata" | "workspace">;
type Address = { sha256: string; datasetId: string | null };
// Content hashes come from the current authorized engine listing, never from the caller.
const identities = new Map<string, string | null>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxBytes = 256 * 1024;
const isDescriptor = (path: string) => path === "dataset.json" || path.endsWith("/dataset.json");

const catalogs = new Map<string, { workspaceId: string; value: Promise<Map<string, Address>> }>();
export function invalidateDatasetAddresses(scope?: { workspaceId?: string }) {
  for (const [key, entry] of catalogs) if (!scope?.workspaceId || entry.workspaceId === scope.workspaceId) catalogs.delete(key);
}

function addresses(adapter: Adapter, workspaceId: string, versionId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = JSON.stringify([adapter.workspace, workspaceId, versionId]);
  const cached = catalogs.get(key);
  if (cached) return cached.value;
  // Concurrent callers share the read, but retain their own cancellation checks.
  const value = readAddresses(adapter, workspaceId, versionId, new AbortController().signal);
  const entry = { workspaceId, value };
  catalogs.set(key, entry);
  if (catalogs.size > 32) catalogs.delete(catalogs.keys().next().value!);
  void value.catch(() => { if (catalogs.get(key) === entry) catalogs.delete(key); });
  return value;
}

async function readAddresses(adapter: Adapter, workspaceId: string, versionId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const files = (await adapter.listTextFileMetadata({ workspaceId, versionId })).filter(file => isDescriptor(file.path));
  signal.throwIfAborted();
  const result = new Map<string, Address>();
  const changed = files.filter(file => {
    if (identities.has(file.sha256)) { result.set(file.path, { sha256: file.sha256, datasetId: identities.get(file.sha256)! }); return false; }
    if (file.byteLength !== null && file.byteLength > maxBytes) { result.set(file.path, { sha256: file.sha256, datasetId: null }); return false; }
    return true;
  });
  for (let offset = 0; offset < changed.length; offset += 128) {
    const paths = changed.slice(offset, offset + 128).map(file => file.path);
    const metadata = await adapter.captureSourceMetadata({ workspaceId, versionId, paths, bounds: { maxInputFiles: 128, maxInputBytes: maxBytes * 128 }, signal });
    const captured = await adapter.hydrateCapturedSources(metadata, signal);
    signal.throwIfAborted();
    if (metadata.workspaceId !== workspaceId || metadata.versionId !== versionId || captured.length !== paths.length) throw Error("Collection source capture changed. Refresh Collections.");
    for (const file of captured) {
      if (!paths.includes(file.path) || createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) throw Error("Collection source capture changed. Refresh Collections.");
      let datasetId: string | null = null;
      try {
        const definition: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
        if (typeof definition === "object" && definition !== null && "datasetId" in definition && typeof definition.datasetId === "string" && uuid.test(definition.datasetId)) datasetId = definition.datasetId;
      } catch { /* An unfinished descriptor cannot name a dataset until its JSON is readable. */ }
      identities.delete(file.sha256);
      identities.set(file.sha256, datasetId);
      if (identities.size > 1024) identities.delete(identities.keys().next().value!);
      result.set(file.path, { sha256: file.sha256, datasetId });
    }
  }
  return result;
}

/** The engine supplies source identity; the host still authorizes every operation on its ID. */
export async function resolveDatasetAddress(adapter: Adapter, workspaceId: string, path: string, signal: AbortSignal, versionId = "main"): Promise<string> {
  parseDatasetPath(path);
  const catalog = await addresses(adapter, workspaceId, versionId, signal);
  signal.throwIfAborted();
  const id = catalog.get(path)?.datasetId;
  if (!id) throw Error(`Collection reference broken: ${path}. Choose its current dataset.json path.`);
  if ([...catalog.values()].filter(value => value.datasetId === id).length !== 1) throw Error(`Collection address ambiguous: ${path}. Multiple dataset.json files contain the same dataset ID. Remove the duplicate descriptor.`);
  return id;
}

export async function addressDatasets(adapter: Adapter, workspaceId: string, datasets: DatasetDescription[], signal: AbortSignal) {
  if (!datasets.length) return [];
  const catalog = await addresses(adapter, workspaceId, "main", signal);
  signal.throwIfAborted();
  const paths = new Map<string, string | null>();
  for (const [path, value] of catalog) {
    if (value.datasetId) paths.set(value.datasetId, paths.has(value.datasetId) ? null : path);
  }
  return datasets.map(dataset => ({ ...dataset, datasetPath: paths.get(dataset.datasetId) ?? null }));
}
