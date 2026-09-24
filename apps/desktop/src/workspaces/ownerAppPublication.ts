import { parseAppPublicationCandidate, parseAppCollectionCapability, APP_PUBLICATION_MAX_FILES, APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_METADATA_BYTES, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { isShareablePath, isShareablePathList, isValidShareVersionId } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { parseDatasetBindingReference, resolveAppDatasetCapability, type AppDatasetBinding, type DatasetRevision } from "@dohc/security-contract/dataset";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";

export const APP_PUBLICATION_LIMITS = { maxFiles: APP_PUBLICATION_MAX_FILES, maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES, maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES };
const inputBounds = { maxInputFiles: 512, maxInputBytes: 128 * 1024 * 1024 };
const manifestLimit = 64 * 1024;
// Without app.publish.json a folder publishes as a static page: index.html and the styles, scripts,
// images, and fonts beside it, named as the compiler accepts them.
const staticAppFile = /^[A-Za-z0-9_@./-]+\.(?:css|js|png|jpe?g|gif|webp|avif|woff2)$/;
export interface OwnerPublicationSelection { workspaceId: string; appRoot: string; shareId: string; grantId: string }
export interface OwnerPublicationGrant { shareId: string; grantId: string; generation: number; status: "active" | "revoked"; revokedAtMs: number | null; selector: { paths: string[]; versionId: string | null } | null }
type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources" | "listTextFileMetadata">;
export interface AppPublicationPreparationDependencies {
  adapter: SourceAdapter;
  signal: AbortSignal;
  assertCurrent(): void;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  /** Resolves from the owner's approved catalog. Publication preparation cannot approve a dataset. */
  resolveDatasetRevision?(binding: AppDatasetBinding): Promise<DatasetRevision>;
}
function declaration(bytes: Uint8Array) {
  if (bytes.byteLength > manifestLimit) throw new Error("The app publication declaration is too large.");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value) || !["entryPath,inputs,packageMap", "collection,entryPath,inputs,packageMap", "dataset,entryPath,inputs,packageMap"].includes(Object.keys(value).sort().join())) throw new Error("Invalid app publication declaration.");
  const row = value as Record<string, unknown>;
  if (!isShareablePath(row.entryPath) || !Array.isArray(row.inputs) || row.inputs.length === 0 || row.inputs.length >= inputBounds.maxInputFiles ||
      !row.inputs.every(isShareablePath) || new Set(row.inputs).size !== row.inputs.length || !row.inputs.includes(row.entryPath) ||
      !row.packageMap || typeof row.packageMap !== "object" || Array.isArray(row.packageMap)) throw new Error("Invalid app publication sources.");
  const entries = Object.entries(row.packageMap);
  const inputs = row.inputs;
  if (entries.length > inputBounds.maxInputFiles || entries.some(([name, path]) => name.length > 256 || !isShareablePath(path) || !inputs.includes(path))) throw new Error("Invalid app publication packages.");
  let collection;
  if (Object.hasOwn(row, "collection")) {
    if (!row.collection || typeof row.collection !== "object" || Array.isArray(row.collection) || Object.hasOwn(row.collection, "schemaSha256")) throw new Error("Invalid collection declaration.");
    collection = parseAppCollectionCapability({ ...row.collection, schemaSha256: "0".repeat(64) });
  }
  const dataset = Object.hasOwn(row, "dataset") ? parseDatasetBindingReference(row.dataset) : undefined;
  return { entryPath: row.entryPath, inputs: row.inputs as string[], packageMap: Object.fromEntries(entries) as Record<string, string>, collection, dataset };
}

/** A missing app.publish.json requests no capabilities; the folder publishes as a static page. */
function staticDeclaration(appRoot: string, paths: readonly string[]): ReturnType<typeof declaration> {
  const entryPath = `${appRoot}/index.html`;
  if (!paths.includes(entryPath)) throw new Error(`dohc found no index.html or app.publish.json in ${appRoot}. Add one to publish this app.`);
  const inputs = [entryPath, ...paths.filter(path => staticAppFile.test(path))];
  if (inputs.length >= inputBounds.maxInputFiles) throw new Error(`${appRoot} has more than ${inputBounds.maxInputFiles - 1} files to publish. List the files to publish in an app.publish.json.`);
  return { entryPath, inputs, packageMap: {}, collection: undefined, dataset: undefined };
}

/** Source capture grants no publication authority. The relay repeats the grant check at commit. */
export async function prepareOwnerAppPublication(input: OwnerPublicationSelection, grant: OwnerPublicationGrant, dependencies: AppPublicationPreparationDependencies): Promise<{ candidate: AppPublicationCandidate; files: ClosedAppBuild["files"]; generation: number }> {
  const selector = grant.selector;
  if (grant.shareId !== input.shareId || grant.grantId !== input.grantId || grant.status !== "active" || grant.revokedAtMs !== null ||
      !Number.isSafeInteger(grant.generation) || grant.generation < 1 || !selector || !isShareablePathList(selector.paths) ||
      (selector.versionId !== null && !isValidShareVersionId(selector.versionId)) || (selector.paths.length === 0 && selector.versionId === null)) throw new Error("This app link is unavailable. Choose an active link.");
  const versionId = selector.versionId ?? "main";
  const allowed = (path: string) => isShareablePath(path) && !isSharedWithMePath(path) &&
    (selector.paths.length === 0 || selector.paths.some(root => path === root || path.startsWith(root + "/")));
  return { ...await prepareAppSources(input, versionId, allowed, dependencies), generation: grant.generation };
}

/** Local approval captures the same immutable source without creating a share grant. */
export async function prepareLocalAppPublication(input: Pick<OwnerPublicationSelection, "workspaceId" | "appRoot">, dependencies: AppPublicationPreparationDependencies): Promise<{ candidate: AppPublicationCandidate; files: ClosedAppBuild["files"] }> {
  const allowed = (path: string) => isShareablePath(path) && !isSharedWithMePath(path);
  return prepareAppSources(input, "main", allowed, dependencies);
}

async function prepareAppSources(input: Pick<OwnerPublicationSelection, "workspaceId" | "appRoot">,
  versionId: string, allowed: (path: string) => boolean, dependencies: AppPublicationPreparationDependencies): Promise<{ candidate: AppPublicationCandidate; files: ClosedAppBuild["files"] }> {
  const { adapter, signal, assertCurrent } = dependencies;
  if (!allowed(input.appRoot)) throw new Error("The app is outside this link's shared files.");
  const manifestPath = `${input.appRoot}/app.publish.json`;
  if (!allowed(manifestPath)) throw new Error("The app declaration is outside this link's shared files.");
  const capture = async (paths: string[], maxInputBytes: number) => {
    assertCurrent(); signal.throwIfAborted();
    const metadata = await adapter.captureSourceMetadata({ workspaceId: input.workspaceId, versionId, paths, bounds: { maxInputFiles: inputBounds.maxInputFiles, maxInputBytes }, signal });
    assertCurrent();
    const files = await adapter.hydrateCapturedSources(metadata, signal);
    assertCurrent();
    return { metadata, files };
  };
  assertCurrent(); signal.throwIfAborted();
  const listed = (await adapter.listTextFileMetadata({ workspaceId: input.workspaceId, versionId }))
    .map(file => file.path).filter(path => path.startsWith(`${input.appRoot}/`));
  assertCurrent(); signal.throwIfAborted();
  const first = listed.includes(manifestPath) ? await capture([manifestPath], manifestLimit) : null;
  const declared = first ? declaration(first.files[0]!.bytes) : staticDeclaration(input.appRoot, listed);
  const schemaPath = declared.collection && `${declared.collection.collectionPath}/collection.yaml`;
  if (declared.collection && !allowed(declared.collection.collectionPath)) throw new Error("The collection is outside this link's shared files.");
  const paths = [...new Set([...(first ? [manifestPath] : []), ...declared.inputs, ...(schemaPath ? [schemaPath] : [])])];
  if (paths.some(path => !allowed(path))) throw new Error("An app source is outside this link's shared files.");
  const selected = await capture(paths, inputBounds.maxInputBytes);
  if (first && selected.files.find(file => file.path === manifestPath)?.sha256 !== first.files[0]!.sha256) throw new Error("The app declaration changed. Prepare the app again.");
  const capabilities: AppPublicationCandidate["capabilities"] = [];
  if (declared.dataset) {
    if (!dependencies.resolveDatasetRevision) throw new Error("This app's Collection is unavailable. Open the Collection and try again.");
    const approved = await dependencies.resolveDatasetRevision(declared.dataset);
    assertCurrent(); signal.throwIfAborted();
    capabilities.push(resolveAppDatasetCapability(declared.dataset, approved));
  }
  if (declared.collection && schemaPath) {
    const file = selected.files.find(file => file.path === schemaPath);
    if (!file || file.bytes.byteLength > 65_536) throw new Error("The collection schema is unavailable or too large.");
    const parsed = parseCollectionSchema(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (parsed.status !== "valid" || [...declared.collection.allowedFields, ...declared.collection.readFields].some(name => !parsed.schema.fields.some(field => field.name === name))) throw new Error("Collection fields do not match its schema.");
    capabilities.push(parseAppCollectionCapability({ ...declared.collection, schemaSha256: file.sha256 }));
  }
  const built = await dependencies.compile({ entryPath: declared.entryPath, inputs: selected.files,
    packageMap: declared.packageMap, bounds: { ...inputBounds, maxOutputBytes: APP_PUBLICATION_LIMITS.maxBundleBytes } }, signal);
  assertCurrent(); signal.throwIfAborted();
  const candidate = parseAppPublicationCandidate({ versionId, appRoot: input.appRoot, entryPath: declared.entryPath, packageMap: declared.packageMap,
    sourceRevision: selected.metadata.sourceDigest, sourceDigest: built.sourceDigest, dependencyLockDigest: built.dependencyLockDigest,
    bundleDigest: built.bundleDigest, buildDigest: built.buildDigest, compilerIdentity: built.compiler,
    inputs: selected.metadata.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
    dependencies: built.dependencyLock.map(file => file.path), files: built.files.map(({ bytes: _, ...file }) => file), capabilities,
  }, APP_PUBLICATION_LIMITS);
  return { candidate, files: built.files.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) })) };
}
