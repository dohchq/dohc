import { createHash } from "node:crypto";
import { parseAppPublicationCandidate, parseAppCollectionCapability, parseAppBackendCapability, APP_PUBLICATION_MAX_FILES, APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_METADATA_BYTES, type AppPublicationCandidate, type AppBackendCapability } from "@dohc/security-contract/app-publication";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { isShareablePath, isShareablePathList, isValidShareVersionId } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";

export const APP_PUBLICATION_LIMITS = { maxFiles: APP_PUBLICATION_MAX_FILES, maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES, maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES };
const inputBounds = { maxInputFiles: 512, maxInputBytes: 128 * 1024 * 1024 };
const manifestLimit = 64 * 1024;
export interface OwnerPublicationSelection { workspaceId: string; appRoot: string; shareId: string; grantId: string }
export interface OwnerPublicationGrant { shareId: string; grantId: string; generation: number; status: "active" | "revoked"; revokedAtMs: number | null; selector: { paths: string[]; versionId: string | null } | null }
type SourceAdapter = Pick<VersionedLiveAdapter, "captureSourceMetadata" | "hydrateCapturedSources">;
type BackendDeclaration = Pick<AppBackendCapability, "dataPath" | "schemaVersion" | "operations" | "tables"> & { entryPath: string; schemaPath: string };
const digest = (domain: string, value: unknown) => createHash("sha256").update(JSON.stringify([domain, value])).digest("hex");
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function declaration(bytes: Uint8Array) {
  if (bytes.byteLength > manifestLimit) throw new Error("The app publication declaration is too large.");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value) || !["entryPath,inputs,packageMap", "collection,entryPath,inputs,packageMap", "backend,entryPath,inputs,packageMap"].includes(Object.keys(value).sort().join())) throw new Error("Invalid app publication declaration.");
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
  let backend: BackendDeclaration | undefined;
  if (Object.hasOwn(row, "backend")) {
    const source = row.backend;
    if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).sort().join() !== "dataPath,entryPath,operations,schemaPath,schemaVersion,tables") throw new Error("Invalid app backend declaration.");
    const record = source as Record<string, unknown>;
    if (!isShareablePath(record.entryPath) || !isShareablePath(record.schemaPath) || !record.schemaPath.endsWith(".sql") ||
        record.entryPath === row.entryPath || !inputs.includes(record.entryPath) || !inputs.includes(record.schemaPath)) throw new Error("The app backend sources must be declared inputs.");
    const parsed = parseAppBackendCapability({ kind: "app-backend", backendPath: "backend.js", schemaPath: "schema.sql",
      backendSha256: "0".repeat(64), schemaSha256: "0".repeat(64), dataPath: record.dataPath,
      schemaVersion: record.schemaVersion, operations: record.operations, tables: record.tables });
    backend = { entryPath: record.entryPath, schemaPath: record.schemaPath, dataPath: parsed.dataPath,
      schemaVersion: parsed.schemaVersion, operations: parsed.operations, tables: parsed.tables };
  }
  return { entryPath: row.entryPath, inputs: row.inputs as string[], packageMap: Object.fromEntries(entries) as Record<string, string>, collection, backend };
}

/** Source capture grants no publication authority. The relay repeats the grant check at commit. */
export async function prepareOwnerAppPublication(input: OwnerPublicationSelection, grant: OwnerPublicationGrant, dependencies: {
  adapter: SourceAdapter; signal: AbortSignal; assertCurrent(): void;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
}): Promise<{ candidate: AppPublicationCandidate; files: ClosedAppBuild["files"]; generation: number }> {
  const { adapter, signal, assertCurrent } = dependencies;
  const selector = grant.selector;
  if (grant.shareId !== input.shareId || grant.grantId !== input.grantId || grant.status !== "active" || grant.revokedAtMs !== null ||
      !Number.isSafeInteger(grant.generation) || grant.generation < 1 || !selector || !isShareablePathList(selector.paths) ||
      (selector.versionId !== null && !isValidShareVersionId(selector.versionId)) || (selector.paths.length === 0 && selector.versionId === null)) throw new Error("This app link is unavailable. Choose an active link.");
  const versionId = selector.versionId ?? "main";
  const allowed = (path: string) => isShareablePath(path) && !isSharedWithMePath(path) &&
    (selector.paths.length === 0 || selector.paths.some(root => path === root || path.startsWith(root + "/")));
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
  const first = await capture([manifestPath], manifestLimit);
  const declared = declaration(first.files[0]!.bytes);
  const schemaPath = declared.collection && `${declared.collection.collectionPath}/collection.yaml`;
  if (declared.collection && !allowed(declared.collection.collectionPath)) throw new Error("The collection is outside this link's shared files.");
  const paths = [...new Set([manifestPath, ...declared.inputs, ...(schemaPath ? [schemaPath] : [])])];
  if (paths.some(path => !allowed(path))) throw new Error("An app source is outside this link's shared files.");
  const selected = await capture(paths, inputBounds.maxInputBytes);
  if (selected.files.find(file => file.path === manifestPath)?.sha256 !== first.files[0]!.sha256) throw new Error("The app declaration changed. Prepare the app again.");
  const capabilities: AppPublicationCandidate["capabilities"] = [];
  if (declared.collection && schemaPath) {
    const file = selected.files.find(file => file.path === schemaPath);
    if (!file || file.bytes.byteLength > 65_536) throw new Error("The collection schema is unavailable or too large.");
    const parsed = parseCollectionSchema(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (parsed.status !== "valid" || [...declared.collection.allowedFields, ...declared.collection.readFields].some(name => !parsed.schema.fields.some(field => field.name === name))) throw new Error("Collection fields do not match its schema.");
    capabilities.push(parseAppCollectionCapability({ ...declared.collection, schemaSha256: file.sha256 }));
  }
  let built = await dependencies.compile({ entryPath: declared.entryPath, inputs: selected.files,
    packageMap: declared.packageMap, bounds: { ...inputBounds, maxOutputBytes: APP_PUBLICATION_LIMITS.maxBundleBytes } }, signal);
  assertCurrent(); signal.throwIfAborted();
  if (declared.backend) {
    const backend = declared.backend;
    const schema = selected.files.find(file => file.path === backend.schemaPath);
    if (!schema) throw new Error("The app backend schema is missing.");
    // Decode now so the published schema cannot contain invalid UTF-8.
    new TextDecoder("utf-8", { fatal: true }).decode(schema.bytes);
    const remaining = APP_PUBLICATION_LIMITS.maxBundleBytes - schema.bytes.byteLength - built.files.reduce((total, file) => total + file.byteLength, 0);
    if (remaining < 1) throw new Error("Publication bundle bound exceeded.");
    const backendBuild = await dependencies.compile({ entryPath: backend.entryPath, inputs: selected.files,
      packageMap: declared.packageMap, bounds: { ...inputBounds, maxOutputBytes: remaining } }, signal);
    assertCurrent(); signal.throwIfAborted();
    if (backendBuild.compiler.recipe !== built.compiler.recipe || backendBuild.compiler.version !== built.compiler.version ||
        backendBuild.compiler.binarySha256 !== built.compiler.binarySha256) throw new Error("The app compiler changed. Prepare the app again.");
    if (backendBuild.files.length !== 1 || backendBuild.files[0]?.path !== "bundle.js") throw new Error("The app backend must compile to one script without CSS.");
    if (built.dependencyLock.some(file => file.path === backend.entryPath || file.path === backend.schemaPath)) throw new Error("The browser app must not import its backend entry or schema.");
    const backendFile = { ...backendBuild.files[0], path: "backend.js" };
    const schemaFile = { path: "schema.sql", sha256: schema.sha256, bytes: Uint8Array.from(schema.bytes), byteLength: schema.bytes.byteLength, contentType: "application/sql; charset=utf-8" };
    const files = [...built.files, backendFile, schemaFile].sort((a, b) => ordered(a.path, b.path));
    const dependencyLock = [...new Map([...built.dependencyLock, ...backendBuild.dependencyLock,
      { path: schema.path, sha256: schema.sha256, byteLength: schema.bytes.byteLength }].map(file => [file.path, file])).values()].sort((a, b) => ordered(a.path, b.path));
    const dependencyLockDigest = digest("dohc-app-dependencies-v1", dependencyLock);
    const bundleDigest = digest("dohc-app-bundle-v1", files.map(({ bytes: _, ...file }) => file));
    const buildDigest = digest("dohc-app-build-v1", { sourceDigest: built.sourceDigest, dependencyLockDigest, compiler: built.compiler, bundleDigest });
    built = { ...built, files, dependencyLock, dependencyLockDigest, bundleDigest, buildDigest };
    capabilities.push(parseAppBackendCapability({ kind: "app-backend", dataPath: backend.dataPath,
      backendPath: backendFile.path, backendSha256: backendFile.sha256, schemaPath: schemaFile.path, schemaSha256: schemaFile.sha256,
      schemaVersion: backend.schemaVersion, operations: backend.operations, tables: backend.tables }));
  }
  const candidate = parseAppPublicationCandidate({ versionId, appRoot: input.appRoot, entryPath: declared.entryPath, packageMap: declared.packageMap,
    sourceRevision: selected.metadata.sourceDigest, sourceDigest: built.sourceDigest, dependencyLockDigest: built.dependencyLockDigest,
    bundleDigest: built.bundleDigest, buildDigest: built.buildDigest, compilerIdentity: built.compiler,
    inputs: selected.metadata.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
    dependencies: built.dependencyLock.map(file => file.path), files: built.files.map(({ bytes: _, ...file }) => file), capabilities,
  }, APP_PUBLICATION_LIMITS);
  return { candidate, files: built.files.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) })), generation: grant.generation };
}
