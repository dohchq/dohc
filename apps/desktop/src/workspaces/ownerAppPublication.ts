import { parseAppPublicationCandidate, parseAppCollectionCapability, APP_PUBLICATION_MAX_BLOB_BYTES, APP_PUBLICATION_MAX_FILES, APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_METADATA_BYTES, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { isShareablePath, isShareablePathList, isValidShareVersionId } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { parseDatasetBindingReference, type AppDatasetBinding, type DatasetRevision } from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { posix } from "node:path";
import { DaemonRefusalError, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";

export const APP_PUBLICATION_LIMITS = { maxFiles: APP_PUBLICATION_MAX_FILES, maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES, maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES };
const inputBounds = { maxInputFiles: 512, maxInputBytes: 128 * 1024 * 1024 };
const manifestLimit = 64 * 1024;
// Without app.publish.json a folder publishes as a static page: index.html and the styles, scripts,
// images, and fonts beside it. The compiler names a referenced file this leaves out and says why.
// These are the types the compiler accepts. Build configuration and installed packages stay out.
const staticAppFile = /^[A-Za-z0-9_@./-]+\.(?:css|js|jsx|ts|tsx|json|png|jpe?g|gif|webp|avif|woff2)$/i;
const staticAppExcluded = (path: string) => /(?:^|\/)(?:package\.json|dohc\.json|tsconfig(?:\.[^/]*)?\.json)$/.test(path) ||
  path.split("/").some(part => part === "node_modules" || part.startsWith("."));
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
/**
 * Reads app.publish.json. Its paths are relative to the app folder, so the folder can move;
 * "../" reaches files beside it. Each refusal names the manifest, the path, and the reason.
 */
export function parseAppPublicationDeclaration(bytes: Uint8Array, appRoot: string) {
  const manifestPath = `${appRoot}/app.publish.json`;
  if (bytes.byteLength > manifestLimit) throw new Error(`${manifestPath} is larger than 64 KB.`);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value) || !["entryPath,inputs,packageMap", "collection,entryPath,inputs,packageMap", "dataset,entryPath,inputs,packageMap"].includes(Object.keys(value).sort().join())) {
    throw new Error(`${manifestPath} must hold entryPath, inputs, and packageMap, and at most one of collection or dataset.`);
  }
  const row = value as Record<string, unknown>;
  const resolve = (path: unknown, field: string): string => {
    if (typeof path !== "string" || path === "") throw new Error(`${manifestPath} names no file in ${field}.`);
    if (path.startsWith("/")) throw new Error(`${manifestPath} lists ${path}. Write the path relative to ${appRoot}, without a leading /.`);
    const resolved = posix.normalize(`${appRoot}/${path}`);
    if (resolved === ".." || resolved.startsWith("../")) throw new Error(`${manifestPath} lists ${path}, which is outside the workspace.`);
    if (!isShareablePath(resolved)) throw new Error(`${manifestPath} lists ${path}, which dohc cannot publish.`);
    return resolved;
  };
  const entryPath = resolve(row.entryPath, "entryPath");
  if (!Array.isArray(row.inputs) || row.inputs.length === 0) throw new Error(`${manifestPath} must list at least one input.`);
  if (row.inputs.length >= inputBounds.maxInputFiles) throw new Error(`${manifestPath} lists more than ${inputBounds.maxInputFiles - 1} inputs.`);
  const inputs = row.inputs.map(path => resolve(path, "input"));
  const repeated = inputs.find((path, index) => inputs.indexOf(path) !== index);
  if (repeated) throw new Error(`${manifestPath} lists ${repeated} twice.`);
  if (!inputs.includes(entryPath)) throw new Error(`${manifestPath} must list its entryPath ${entryPath} among its inputs.`);
  if (!row.packageMap || typeof row.packageMap !== "object" || Array.isArray(row.packageMap)) throw new Error(`${manifestPath} has a packageMap that is not an object.`);
  const entries = Object.entries(row.packageMap).map(([name, path]) => [name, resolve(path, `packageMap target for ${name}`)] as const);
  if (entries.length > inputBounds.maxInputFiles) throw new Error(`${manifestPath} maps more than ${inputBounds.maxInputFiles} packages.`);
  for (const [name, path] of entries) {
    if (name.length > 256) throw new Error(`${manifestPath} maps a package name longer than 256 characters.`);
    if (!inputs.includes(path)) throw new Error(`${manifestPath} maps ${name} to ${path}, which is not among its inputs.`);
  }
  let collection;
  if (Object.hasOwn(row, "collection")) {
    if (!row.collection || typeof row.collection !== "object" || Array.isArray(row.collection) || Object.hasOwn(row.collection, "schemaSha256")) throw new Error(`${manifestPath} has a collection that is not an object without schemaSha256.`);
    const declared = row.collection as Record<string, unknown>;
    collection = parseAppCollectionCapability({ ...declared, collectionPath: resolve(declared.collectionPath, "collectionPath"), schemaSha256: "0".repeat(64) });
  }
  const dataset = Object.hasOwn(row, "dataset") ? parseDatasetBindingReference(row.dataset) : undefined;
  return { entryPath, inputs, packageMap: Object.fromEntries(entries) as Record<string, string>, collection, dataset };
}

/** A missing app.publish.json requests no capabilities; the folder publishes as a static page. */
function staticDeclaration(appRoot: string, paths: readonly string[]): ReturnType<typeof parseAppPublicationDeclaration> {
  const entryPath = `${appRoot}/index.html`;
  if (!paths.includes(entryPath)) throw new Error(`dohc found no index.html or app.publish.json in ${appRoot}. Add one to publish this app.`);
  const inputs = [entryPath, ...paths.filter(path => staticAppFile.test(path) && !staticAppExcluded(path))];
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
  assertCurrent(); signal.throwIfAborted();
  const folder = (await adapter.listTextFileMetadata({ workspaceId: input.workspaceId, versionId, under: input.appRoot })).map(file => file.path);
  assertCurrent(); signal.throwIfAborted();
  const hasManifest = folder.includes(manifestPath);
  const capture = async (paths: string[], maxInputBytes: number) => {
    assertCurrent(); signal.throwIfAborted();
    const metadata = await adapter.captureSourceMetadata({ workspaceId: input.workspaceId, versionId, paths, bounds: { maxInputFiles: inputBounds.maxInputFiles, maxInputBytes }, signal })
      .catch(async (error: unknown) => { throw await captureRefusal(error, paths, maxInputBytes); });
    assertCurrent();
    const files = await adapter.hydrateCapturedSources(metadata, signal);
    assertCurrent();
    return { metadata, files };
  };
  // The engine's refusal carries only its code. Only after a refusal, list the workspace to name the file.
  const captureRefusal = async (error: unknown, paths: readonly string[], maxInputBytes: number): Promise<unknown> => {
    if (!(error instanceof DaemonRefusalError)) return error;
    const listed = new Map((await adapter.listTextFileMetadata({ workspaceId: input.workspaceId, versionId })).map(file => [file.path, file]));
    assertCurrent(); signal.throwIfAborted();
    const missing = paths.find(path => !listed.has(path));
    if (missing && (missing === manifestPath || !hasManifest)) return new Error(`${missing} changed while dohc prepared the app. Prepare the app again.`);
    if (missing) return new Error(`${manifestPath} lists ${missing}, which does not exist. Write its paths relative to ${input.appRoot}.`);
    const live = paths.find(path => listed.get(path)!.hasYdocMarker);
    if (live) return new Error(`${live} is a live document. Published apps cannot include live documents.`);
    if (paths.reduce((total, path) => total + (listed.get(path)!.byteLength ?? 0), 0) > maxInputBytes) {
      return new Error(paths.length === 1 ? `${manifestPath} is larger than 64 KB.` : `The files in ${input.appRoot} are larger than 128 MB together.`);
    }
    return error;
  };
  const first = hasManifest ? await capture([manifestPath], manifestLimit) : null;
  const declared = first ? parseAppPublicationDeclaration(first.files[0]!.bytes, input.appRoot) : staticDeclaration(input.appRoot, folder);
  const schemaPath = declared.collection && `${declared.collection.collectionPath}/collection.yaml`;
  if (declared.collection && !allowed(declared.collection.collectionPath)) throw new Error(`${manifestPath} names the collection ${declared.collection.collectionPath}, which is outside this link's shared files. Choose a link that includes it.`);
  const paths = [...new Set([...(first ? [manifestPath] : []), ...declared.inputs, ...(schemaPath ? [schemaPath] : [])])];
  const outside = paths.find(path => !allowed(path));
  if (outside) throw new Error(`${first ? `${manifestPath} lists ${outside}` : outside}, which is outside this link's shared files. Choose a link that includes it.`);
  const selected = await capture(paths, inputBounds.maxInputBytes);
  if (first && selected.files.find(file => file.path === manifestPath)?.sha256 !== first.files[0]!.sha256) throw new Error("The app declaration changed. Prepare the app again.");
  const capabilities: AppPublicationCandidate["capabilities"] = [];
  if (declared.dataset) {
    if (!dependencies.resolveDatasetRevision) throw new Error("This app's Collection is unavailable. Open the Collection and try again.");
    const approved = await dependencies.resolveDatasetRevision(declared.dataset);
    assertCurrent(); signal.throwIfAborted();
    const { linkReads: _requestedReads, ...binding } = declared.dataset;
    capabilities.push(resolveAppDatasetCapability(binding, approved));
  }
  if (declared.collection && schemaPath) {
    const file = selected.files.find(file => file.path === schemaPath);
    if (!file || file.bytes.byteLength > 65_536) throw new Error("The collection schema is unavailable or too large.");
    const parsed = parseCollectionSchema(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (parsed.status !== "valid" || [...declared.collection.allowedFields, ...declared.collection.readFields].some(name => !parsed.schema.fields.some(field => field.name === name))) throw new Error("Collection fields do not match its schema.");
    capabilities.push(parseAppCollectionCapability({ ...declared.collection, schemaSha256: file.sha256 }));
  }
  const built = await dependencies.compile({ entryPath: declared.entryPath, inputs: selected.files,
    packageMap: declared.packageMap, bounds: { ...inputBounds, maxOutputBytes: APP_PUBLICATION_LIMITS.maxBundleBytes, maxOutputFileBytes: APP_PUBLICATION_MAX_BLOB_BYTES } }, signal);
  assertCurrent(); signal.throwIfAborted();
  const candidate = parseAppPublicationCandidate({ versionId, appRoot: input.appRoot, entryPath: declared.entryPath, packageMap: declared.packageMap,
    sourceRevision: selected.metadata.sourceDigest, sourceDigest: built.sourceDigest, dependencyLockDigest: built.dependencyLockDigest,
    bundleDigest: built.bundleDigest, buildDigest: built.buildDigest, compilerIdentity: built.compiler,
    inputs: selected.metadata.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
    dependencies: built.dependencyLock.map(file => file.path), files: built.files.map(({ bytes: _, ...file }) => file), capabilities,
  }, APP_PUBLICATION_LIMITS);
  return { candidate, files: built.files.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) })) };
}
