import {
  parseAppExternalDeclaration,
  sortAppExternalOperations,
  type AppExternalOperation,
} from "@dohc/security-contract/app-external";
import { resolveDatasetAddress } from "./datasetAddress";
import { assertSourcePathsNotDeferred } from "./datasetSourceCapture";
import { isPortableNamePath } from "@dohc/workspace-contracts/names";
import {
  parseAppPublicationCandidate,
  parseAppCollectionCapability,
  APP_PUBLICATION_MAX_BLOB_BYTES,
  APP_PUBLICATION_MAX_FILES,
  APP_PUBLICATION_MAX_BUNDLE_BYTES,
  APP_PUBLICATION_MAX_METADATA_BYTES,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import {
  isShareablePath,
  isShareablePathList,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import {
  APP_DATASET_MAX_BINDINGS,
  parseAppDatasetReference,
  parseDatasetAlias,
  parseDatasetDefinition,
  resolveAppDatasetReferenceBinding,
  type AppDatasetCapability,
  type AppDatasetReference,
  type AppDatasetRevisionLookup,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import { resolveAppDatasetCapability } from "@dohc/security-contract/dataset-authorization";
import { likelySecretPrefix, type SecretPrefix } from "@dohc/security-contract/secret-prefix";
import { isUtf8 } from "node:buffer";
import { posix } from "node:path";
import { fileVersionError } from "@dohc/workspace-contracts/file-version";
import { collectionVersionError } from "@dohc/workspace-contracts/collection";
import { DaemonRefusalError, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import { isReservedAppPackage } from "./closedAppBuiltins";

export const APP_PUBLICATION_LIMITS = {
  maxFiles: APP_PUBLICATION_MAX_FILES,
  maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES,
  maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
};
const inputBounds = { maxInputFiles: 512, maxInputBytes: 128 * 1024 * 1024 };
const manifestLimit = 64 * 1024;
// Without app.publish.json a folder publishes as a static page: index.html and the styles, scripts,
// images, and fonts beside it. The compiler names a referenced file this leaves out and says why.
// These are the types the compiler accepts. Build configuration and installed packages stay out.
const staticAppFile = /\.(?:css|js|jsx|ts|tsx|json|png|jpe?g|gif|webp|avif|woff2)$/i;
const staticAppExcluded = (path: string) =>
  /(?:^|\/)(?:package\.json|dohc\.json|tsconfig(?:\.[^/]*)?\.json)$/.test(path) ||
  /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path) ||
  path.split("/").some((part) => part === "node_modules" || part.startsWith("."));
const autoManifestExcludedNames = new Set([
  "app.publish.json",
  "dataset.json",
  "collection.yaml",
  "automations.yaml",
]);
function discoverAppInputs(
  appRoot: string,
  entryPath: string,
  folder: readonly string[],
  packageMapTargets: readonly string[],
  extraExcluded?: ReadonlySet<string>,
): string[] {
  const collectionSubfolders = new Set<string>();
  const prefix = `${appRoot}/`;
  for (const path of folder) {
    if (path === `${prefix}dataset.json` || path === `${prefix}collection.yaml`) continue;
    if (path.endsWith("/dataset.json") || path.endsWith("/collection.yaml")) {
      collectionSubfolders.add(posix.dirname(path));
    }
  }
  const excluded = (path: string): boolean => {
    if (staticAppExcluded(path)) return true;
    if (extraExcluded?.has(path)) return true;
    if (autoManifestExcludedNames.has(posix.basename(path))) return true;
    if (path.startsWith(prefix)) {
      const firstSegment = path.slice(prefix.length).split("/", 1)[0];
      if (firstSegment === "changes" || firstSegment === "revisions") return true;
    }
    for (const sub of collectionSubfolders) {
      if (path === sub || path.startsWith(`${sub}/`)) return true;
    }
    return false;
  };
  const discovered = folder.filter(
    (path) => isPortableNamePath(path) && staticAppFile.test(path) && !excluded(path),
  );
  return [...new Set([entryPath, ...discovered, ...packageMapTargets])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
export interface OwnerPublicationSelection {
  workspaceId: string;
  appRoot: string;
  audience?: "link" | "workspace";
  shareId?: string;
  grantId?: string;
}
const localAllowed = (path: string) => isShareablePath(path) && !isSharedWithMePath(path);
export interface OwnerPublicationGrant {
  shareId: string;
  grantId: string;
  generation: number;
  status: "active" | "revoked";
  revokedAtMs: number | null;
  selector: { paths: string[]; versionId: string | null } | null;
}
type SourceAdapter = Pick<
  VersionedLiveAdapter,
  "captureSourceMetadata" | "hydrateCapturedSources" | "listTextFileMetadata" | "workspace"
>;
export interface AppPublicationPreparationDependencies {
  deferredWrites: readonly string[];
  adapter: SourceAdapter;
  signal: AbortSignal;
  assertCurrent(): void;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  /** Resolves from the owner's approved catalog. Publication preparation cannot approve a dataset. */
  resolveDatasetRevision?(binding: AppDatasetRevisionLookup): Promise<DatasetRevision>;
  /** Resolves a Personal app's Collection from what the member's own grant shows, in place of the owner's catalog. */
  resolveDatasetCapability?(
    reference: AppDatasetReference,
    datasetId: string,
    alias: string | undefined,
  ): Promise<AppDatasetCapability>;
  /** Where the app's dataset.json references resolve, when the app's files are read from elsewhere. */
  datasetAdapter?: SourceAdapter;
  onCollectionSchema?(text: string): void;
}
function describeJsonSyntaxLocation(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const posLineCol = / at position \d+ \(line (\d+) column (\d+)\)$/.exec(error.message);
  if (posLineCol) return `at line ${posLineCol[1]}, column ${posLineCol[2]}`;
  const posOnly = / at position (\d+)$/.exec(error.message);
  if (posOnly) return `at position ${posOnly[1]}`;
  return undefined;
}

/**
 * Reads app.publish.json. Its paths are relative to the app folder, so the folder can move;
 * "../" reaches files beside it. Dataset references use workspace-relative dataset.json paths.
 */
export function parseAppPublicationDeclaration(
  bytes: Uint8Array,
  appRoot: string,
  discovery?: { folder: readonly string[]; extraExcluded?: ReadonlySet<string> },
) {
  const manifestPath = `${appRoot}/app.publish.json`;
  if (bytes.byteLength > manifestLimit) throw new Error(`${manifestPath} is larger than 64 KB.`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const location = describeJsonSyntaxLocation(error);
    throw new Error(
      `${manifestPath} is not valid JSON${location ? ` (${location})` : ""}. Check its syntax.`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${manifestPath} must hold entryPath, optional inputs and packageMap, and at most one of collection, dataset, or datasets.`,
    );
  }
  const row = value as Record<string, unknown>;
  const versionError = fileVersionError(row.version, manifestPath);
  if (versionError) throw new Error(versionError);
  const unknownKey = Object.keys(row).find(
    (key) =>
      ![
        "version",
        "entryPath",
        "inputs",
        "packageMap",
        "collection",
        "dataset",
        "datasets",
        "external",
      ].includes(key),
  );
  if (unknownKey !== undefined) {
    throw new Error(
      `${manifestPath} has an unknown key: ${unknownKey}. Remove it or correct its name.`,
    );
  }
  const dataBindings = ["collection", "dataset", "datasets"].filter((key) =>
    Object.hasOwn(row, key),
  );
  if (dataBindings.length > 1) {
    throw new Error(`${manifestPath} must hold at most one of collection, dataset, or datasets.`);
  }
  const resolve = (path: unknown, field: string): string => {
    if (typeof path !== "string" || path === "")
      throw new Error(`${manifestPath} names no file in ${field}.`);
    if (path.startsWith("/"))
      throw new Error(
        `${manifestPath} lists ${path}. Write the path relative to ${appRoot}, without a leading /.`,
      );
    const resolved = posix.normalize(`${appRoot}/${path}`);
    if (resolved === ".." || resolved.startsWith("../"))
      throw new Error(`${manifestPath} lists ${path}, which is outside the workspace.`);
    if (!isShareablePath(resolved) || !isPortableNamePath(resolved))
      throw new Error(`${manifestPath} lists ${path}, which dohc cannot publish.`);
    return resolved;
  };
  const entryPath = resolve(row.entryPath, "entryPath");
  const rawPackageMap = Object.hasOwn(row, "packageMap") ? row.packageMap : {};
  if (!rawPackageMap || typeof rawPackageMap !== "object" || Array.isArray(rawPackageMap))
    throw new Error(`${manifestPath} has a packageMap that is not an object.`);
  const entries = Object.entries(rawPackageMap).map(
    ([name, path]) => [name, resolve(path, `packageMap target for ${name}`)] as const,
  );
  if (entries.length > inputBounds.maxInputFiles)
    throw new Error(`${manifestPath} maps more than ${inputBounds.maxInputFiles} packages.`);

  let inputs: string[];
  const explicitInputs = Object.hasOwn(row, "inputs");
  if (explicitInputs) {
    if (!Array.isArray(row.inputs) || row.inputs.length === 0)
      throw new Error(`${manifestPath} must list at least one input.`);
    if (row.inputs.length >= inputBounds.maxInputFiles)
      throw new Error(`${manifestPath} lists more than ${inputBounds.maxInputFiles - 1} inputs.`);
    inputs = row.inputs.map((path) => resolve(path, "input"));
    const repeated = inputs.find((path, index) => inputs.indexOf(path) !== index);
    if (repeated) throw new Error(`${manifestPath} lists ${repeated} twice.`);
    if (!inputs.includes(entryPath))
      throw new Error(`${manifestPath} must list its entryPath ${entryPath} among its inputs.`);
  } else {
    if (!discovery) {
      throw new Error(
        `${manifestPath} omits inputs; folder discovery is required to resolve its files.`,
      );
    }
    inputs = discoverAppInputs(
      appRoot,
      entryPath,
      discovery.folder,
      entries.map(([, path]) => path),
      discovery.extraExcluded,
    );
    if (inputs.length >= inputBounds.maxInputFiles)
      throw new Error(
        `${appRoot} has more than ${inputBounds.maxInputFiles - 1} files to publish. List the files to publish in ${manifestPath}.`,
      );
  }
  for (const [name, path] of entries) {
    if (isReservedAppPackage(name))
      throw new Error(
        `${manifestPath} maps built-in package ${name}. Remove it from packageMap; dohc provides it automatically.`,
      );
    if (name.length > 256)
      throw new Error(`${manifestPath} maps a package name longer than 256 characters.`);
    if (!inputs.includes(path))
      throw new Error(`${manifestPath} maps ${name} to ${path}, which is not among its inputs.`);
  }
  let collection;
  if (Object.hasOwn(row, "collection")) {
    if (
      !row.collection ||
      typeof row.collection !== "object" ||
      Array.isArray(row.collection) ||
      Object.hasOwn(row.collection, "schemaSha256")
    )
      throw new Error(
        `${manifestPath} has a collection that is not an object without schemaSha256.`,
      );
    const declared = row.collection as Record<string, unknown>;
    collection = parseAppCollectionCapability({
      ...declared,
      collectionPath: resolve(declared.collectionPath, "collectionPath"),
      schemaSha256: "0".repeat(64),
    });
  }
  const dataset = Object.hasOwn(row, "dataset") ? parseAppDatasetReference(row.dataset) : undefined;
  let datasets: ReadonlyArray<{ alias: string; reference: AppDatasetReference }> | undefined;
  if (Object.hasOwn(row, "datasets")) {
    if (!row.datasets || typeof row.datasets !== "object" || Array.isArray(row.datasets)) {
      throw new Error(`${manifestPath} has a datasets field that is not an object.`);
    }
    const rawEntries = Object.entries(row.datasets as Record<string, unknown>);
    if (rawEntries.length === 0) {
      throw new Error(`${manifestPath} must list at least one Collection in datasets.`);
    }
    if (rawEntries.length > APP_DATASET_MAX_BINDINGS) {
      throw new Error(
        `${manifestPath} lists ${rawEntries.length} Collections in datasets, exceeding the limit of ${APP_DATASET_MAX_BINDINGS}.`,
      );
    }
    datasets = rawEntries.map(([alias, reference]) => ({
      alias: parseDatasetAlias(alias),
      reference: parseAppDatasetReference(reference),
    }));
  }
  let external: AppExternalOperation[] | undefined;
  if (Object.hasOwn(row, "external")) {
    try {
      external = sortAppExternalOperations(parseAppExternalDeclaration(row.external));
      const shared = external.find((operation) => operation.access !== "owner");
      if (shared)
        throw new Error(
          `Operation "${shared.name}" can run only for you for now. Set its access to "owner".`,
        );
    } catch (error) {
      throw new Error(
        `${manifestPath} external: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    entryPath,
    inputs,
    packageMap: Object.fromEntries(entries) as Record<string, string>,
    collection,
    dataset,
    datasets,
    external,
  };
}

/** A missing app.publish.json requests no capabilities; the folder publishes as a static page. */
function staticDeclaration(
  appRoot: string,
  paths: readonly string[],
): ReturnType<typeof parseAppPublicationDeclaration> {
  const entryPath = `${appRoot}/index.html`;
  if (!paths.includes(entryPath))
    throw new Error(
      `dohc found no index.html or app.publish.json in ${appRoot}. Add one to publish this app.`,
    );
  const inputs = [
    entryPath,
    ...paths.filter(
      (path) => isPortableNamePath(path) && staticAppFile.test(path) && !staticAppExcluded(path),
    ),
  ];
  if (inputs.length >= inputBounds.maxInputFiles)
    throw new Error(
      `${appRoot} has more than ${inputBounds.maxInputFiles - 1} files to publish. List the files to publish in an app.publish.json.`,
    );
  return {
    entryPath,
    inputs,
    packageMap: {},
    collection: undefined,
    dataset: undefined,
    datasets: undefined,
    external: undefined,
  };
}

interface AppSourceSecret {
  path: string;
  prefix: SecretPrefix;
}

interface PreparedAppSources {
  candidate: AppPublicationCandidate;
  files: ClosedAppBuild["files"];
  likelySecrets: AppSourceSecret[];
}

/** Source capture grants no publication authority. The relay repeats the grant check at commit. A null grant prepares the app for the workspace's members, from main. */
export async function prepareOwnerAppPublication(
  input: OwnerPublicationSelection,
  grant: OwnerPublicationGrant | null,
  dependencies: AppPublicationPreparationDependencies,
): Promise<PreparedAppSources & { generation?: number }> {
  if (!grant) return prepareAppSources(input, "main", localAllowed, dependencies);
  const selector = grant.selector;
  if (
    grant.shareId !== input.shareId ||
    grant.grantId !== input.grantId ||
    grant.status !== "active" ||
    grant.revokedAtMs !== null ||
    !Number.isSafeInteger(grant.generation) ||
    grant.generation < 1 ||
    !selector ||
    !isShareablePathList(selector.paths) ||
    (selector.versionId !== null && !isValidShareVersionId(selector.versionId)) ||
    (selector.paths.length === 0 && selector.versionId === null)
  )
    throw new Error("This app link is unavailable. Choose an active link.");
  const versionId = selector.versionId ?? "main";
  const allowed = (path: string) =>
    isShareablePath(path) &&
    !isSharedWithMePath(path) &&
    (selector.paths.length === 0 ||
      selector.paths.some((root) => path === root || path.startsWith(root + "/")));
  return {
    ...(await prepareAppSources(input, versionId, allowed, dependencies)),
    generation: grant.generation,
  };
}

/**
 * Local approval captures the same immutable source without creating a share grant. It needs app.publish.json:
 * dohc shows a folder without one as a site, which offers no review to see or remove an approval.
 */
export async function prepareLocalAppPublication(
  input: Pick<OwnerPublicationSelection, "workspaceId" | "appRoot"> & { versionId: string },
  dependencies: AppPublicationPreparationDependencies,
): Promise<PreparedAppSources> {
  return prepareAppSources(input, input.versionId, localAllowed, dependencies, true);
}

/** Selects the files local preparation would capture, without compiling them. Its sourceRevision matches an unchanged approval's. */
export async function readLocalAppSource(
  input: Pick<OwnerPublicationSelection, "workspaceId" | "appRoot"> & { versionId: string },
  dependencies: SourceDependencies,
): Promise<{ sourceRevision: string; sourcePaths: string[] }> {
  const { metadata } = await selectAppSources(input, input.versionId, localAllowed, dependencies);
  return {
    sourceRevision: metadata.sourceDigest,
    sourcePaths: metadata.files.map((file) => file.path),
  };
}

type SourceDependencies = Pick<
  AppPublicationPreparationDependencies,
  "adapter" | "signal" | "assertCurrent" | "deferredWrites"
>;

async function selectAppSources(
  input: Pick<OwnerPublicationSelection, "workspaceId" | "appRoot">,
  versionId: string,
  allowed: (path: string) => boolean,
  dependencies: SourceDependencies,
  requireManifest = false,
) {
  const { adapter, signal, assertCurrent } = dependencies;
  if (!allowed(input.appRoot)) throw new Error("The app is outside this link's shared files.");
  const manifestPath = `${input.appRoot}/app.publish.json`;
  if (!allowed(manifestPath))
    throw new Error("The app declaration is outside this link's shared files.");
  assertCurrent();
  signal.throwIfAborted();
  assertSourcePathsNotDeferred(dependencies.deferredWrites, [], input.appRoot);
  const folder = (
    await adapter.listTextFileMetadata({
      workspaceId: input.workspaceId,
      versionId,
      under: input.appRoot,
    })
  ).map((file) => file.path);
  assertCurrent();
  signal.throwIfAborted();
  const hasManifest = folder.includes(manifestPath);
  if (requireManifest && !hasManifest)
    throw new Error(`Add app.publish.json to ${input.appRoot} before approving it on this device.`);
  const capture = async (paths: string[], maxInputBytes: number) => {
    assertCurrent();
    signal.throwIfAborted();
    assertSourcePathsNotDeferred(dependencies.deferredWrites, paths);
    const metadata = await adapter
      .captureSourceMetadata({
        workspaceId: input.workspaceId,
        versionId,
        paths,
        bounds: { maxInputFiles: inputBounds.maxInputFiles, maxInputBytes },
        signal,
      })
      .catch(async (error: unknown) => {
        throw await captureRefusal(error, paths, maxInputBytes);
      });
    assertCurrent();
    return metadata;
  };
  // The engine's refusal carries only its code. Only after a refusal, list the workspace to name the file.
  const captureRefusal = async (
    error: unknown,
    paths: readonly string[],
    maxInputBytes: number,
  ): Promise<unknown> => {
    if (!(error instanceof DaemonRefusalError)) return error;
    const listed = new Map(
      (await adapter.listTextFileMetadata({ workspaceId: input.workspaceId, versionId })).map(
        (file) => [file.path, file],
      ),
    );
    assertCurrent();
    signal.throwIfAborted();
    const missing = paths.find((path) => !listed.has(path));
    if (missing && (missing === manifestPath || !hasManifest))
      return new Error(`${missing} changed while dohc prepared the app. Prepare the app again.`);
    if (missing)
      return new Error(
        `${manifestPath} lists ${missing}, which does not exist. Write its paths relative to ${input.appRoot}.`,
      );
    const live = paths.find((path) => listed.get(path)!.hasYdocMarker);
    if (live)
      return new Error(`${live} is a live document. Published apps cannot include live documents.`);
    if (
      paths.reduce((total, path) => total + (listed.get(path)!.byteLength ?? 0), 0) > maxInputBytes
    ) {
      return new Error(
        paths.length === 1
          ? `${manifestPath} is larger than 64 KB.`
          : `The files in ${input.appRoot} are larger than 128 MB together.`,
      );
    }
    return error;
  };
  const first = hasManifest ? await capture([manifestPath], manifestLimit) : null;
  const manifest = first && (await adapter.hydrateCapturedSources(first, signal))[0]!;
  assertCurrent();
  let extraExcluded: Set<string> | undefined;
  let colocatedDescriptorSha256: string | undefined;
  let autoDiscovered = false;
  const colocatedDescriptor = `${input.appRoot}/dataset.json`;
  if (manifest) {
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes));
    } catch {
      parsedManifest = null;
    }
    autoDiscovered =
      parsedManifest !== null &&
      typeof parsedManifest === "object" &&
      !Array.isArray(parsedManifest) &&
      !Object.hasOwn(parsedManifest, "inputs");
    if (autoDiscovered && folder.includes(colocatedDescriptor)) {
      if (!allowed(colocatedDescriptor)) {
        throw new Error(
          `${colocatedDescriptor} is outside this link's shared files. List explicit inputs in ${manifestPath}.`,
        );
      }
      const descriptorMeta = await capture([colocatedDescriptor], 256 * 1024);
      const descriptorFile = (await adapter.hydrateCapturedSources(descriptorMeta, signal))[0];
      assertCurrent();
      signal.throwIfAborted();
      if (!descriptorFile) {
        throw new Error(
          `${colocatedDescriptor} changed while dohc prepared the app. Prepare the app again.`,
        );
      }
      colocatedDescriptorSha256 = descriptorFile.sha256;
      try {
        const def = parseDatasetDefinition(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(descriptorFile.bytes)),
          { descriptorPath: colocatedDescriptor },
        );
        extraExcluded = new Set([def.operationsPath, def.schemaPath]);
      } catch {
        throw new Error(
          `dohc could not read ${colocatedDescriptor} while selecting files for ${input.appRoot}. Fix ${colocatedDescriptor} or list explicit inputs in ${manifestPath}.`,
        );
      }
    }
  }
  const declared = manifest
    ? parseAppPublicationDeclaration(manifest.bytes, input.appRoot, { folder, extraExcluded })
    : staticDeclaration(input.appRoot, folder);
  const schemaPath = declared.collection && `${declared.collection.collectionPath}/collection.yaml`;
  if (declared.collection && !allowed(declared.collection.collectionPath))
    throw new Error(
      `${manifestPath} names the collection ${declared.collection.collectionPath}, which is outside this link's shared files. Choose a link that includes it.`,
    );
  const paths = [
    ...new Set([
      ...(first ? [manifestPath] : []),
      ...declared.inputs,
      ...(schemaPath ? [schemaPath] : []),
    ]),
  ];
  const outsidePaths = paths.filter((path) => !allowed(path));
  if (outsidePaths.length > 0) {
    const maxListed = 5;
    const listed =
      outsidePaths.length > maxListed
        ? `${outsidePaths.slice(0, maxListed).join(", ")} (and ${outsidePaths.length - maxListed} more)`
        : outsidePaths.join(", ");
    const subject = first ? `${manifestPath} lists ${listed}` : listed;
    const verb = outsidePaths.length === 1 ? "is" : "are";
    const files = outsidePaths.length === 1 ? "the file" : "those files";
    const them = outsidePaths.length === 1 ? "it" : "them";
    throw new Error(
      `${subject}, which ${verb} outside this link's shared files. Move ${files} inside ${input.appRoot}, or create a link whose paths include ${them}.`,
    );
  }
  const metadata = await capture(paths, inputBounds.maxInputBytes);
  if (
    manifest &&
    metadata.files.find((file) => file.path === manifestPath)?.sha256 !== manifest.sha256
  )
    throw new Error("The app declaration changed. Prepare the app again.");
  if (autoDiscovered) {
    const afterList = await adapter.listTextFileMetadata({
      workspaceId: input.workspaceId,
      versionId,
      under: input.appRoot,
    });
    assertCurrent();
    signal.throwIfAborted();
    const afterDescriptor = afterList.find((file) => file.path === colocatedDescriptor);
    if (
      (colocatedDescriptorSha256 !== undefined &&
        afterDescriptor?.sha256 !== colocatedDescriptorSha256) ||
      (colocatedDescriptorSha256 === undefined && afterDescriptor !== undefined)
    ) {
      throw new Error(
        `${colocatedDescriptor} changed while dohc prepared the app. Prepare the app again.`,
      );
    }
    const afterInputs = discoverAppInputs(
      input.appRoot,
      declared.entryPath,
      afterList.map((file) => file.path),
      Object.values(declared.packageMap),
      extraExcluded,
    );
    if (
      afterInputs.length !== declared.inputs.length ||
      afterInputs.some((path, index) => path !== declared.inputs[index])
    ) {
      throw new Error(
        `The files in ${input.appRoot} changed while dohc prepared the app. Prepare the app again.`,
      );
    }
  }
  return { declared, schemaPath, metadata };
}

async function prepareAppSources(
  input: Pick<OwnerPublicationSelection, "workspaceId" | "appRoot">,
  versionId: string,
  allowed: (path: string) => boolean,
  dependencies: AppPublicationPreparationDependencies,
  requireManifest = false,
): Promise<PreparedAppSources> {
  const { adapter, signal, assertCurrent } = dependencies;
  const { declared, schemaPath, metadata } = await selectAppSources(
    input,
    versionId,
    allowed,
    dependencies,
    requireManifest,
  );
  if (declared.external && dependencies.resolveDatasetCapability)
    throw new Error(
      "Personal apps can't call outside services. Only the workspace's owner can approve that.",
    );
  if (declared.external && !requireManifest)
    throw new Error(
      "Apps that call outside services run only on this computer for now. Approve it here instead of publishing.",
    );
  const selected = { metadata, files: await adapter.hydrateCapturedSources(metadata, signal) };
  assertCurrent();
  const decoder = new TextDecoder();
  const likelySecrets = selected.files.flatMap((file) => {
    if (!isUtf8(file.bytes)) return [];
    const prefix = likelySecretPrefix(decoder.decode(file.bytes));
    return prefix ? [{ path: file.path, prefix }] : [];
  });
  const capabilities: AppPublicationCandidate["capabilities"] = [];
  const datasetBindings: ReadonlyArray<{ alias?: string; reference: AppDatasetReference }> =
    declared.datasets ?? (declared.dataset ? [{ reference: declared.dataset }] : []);
  if (datasetBindings.length > 0) {
    if (!dependencies.resolveDatasetRevision && !dependencies.resolveDatasetCapability)
      throw new Error("This app's Collection is unavailable. Open the Collection and try again.");
    assertSourcePathsNotDeferred(
      dependencies.deferredWrites,
      datasetBindings.map((entry) => entry.reference.datasetPath),
    );
    const seenDatasetIds = new Set<string>();
    for (const { alias, reference } of datasetBindings) {
      const datasetId = await resolveDatasetAddress(
        dependencies.datasetAdapter ?? adapter,
        input.workspaceId,
        reference.datasetPath,
        signal,
        versionId,
      );
      assertCurrent();
      signal.throwIfAborted();
      if (seenDatasetIds.has(datasetId)) {
        throw new Error(
          `${input.appRoot}/app.publish.json binds the same Collection more than once.`,
        );
      }
      seenDatasetIds.add(datasetId);
      if (dependencies.resolveDatasetCapability) {
        capabilities.push(await dependencies.resolveDatasetCapability(reference, datasetId, alias));
        assertCurrent();
        signal.throwIfAborted();
        continue;
      }
      const { datasetPath: _path, ...rest } = reference;
      const lookup: AppDatasetRevisionLookup =
        "operationIds" in rest && rest.revision !== undefined
          ? { ...rest, datasetId }
          : {
              datasetId,
              ...(reference.revision !== undefined
                ? {
                    revision: reference.revision,
                    revisionSha256: reference.revisionSha256,
                  }
                : {}),
            };
      const approved = await dependencies.resolveDatasetRevision!(lookup);
      assertCurrent();
      signal.throwIfAborted();
      const resolved = resolveAppDatasetReferenceBinding(reference, datasetId, approved);
      const { linkReads: _requestedReads, ...binding } = resolved;
      capabilities.push(
        resolveAppDatasetCapability(
          alias === undefined ? binding : { ...binding, alias },
          approved,
        ),
      );
    }
  }
  if (declared.collection && schemaPath) {
    const file = selected.files.find((file) => file.path === schemaPath);
    if (!file || file.bytes.byteLength > 65_536)
      throw new Error("The collection schema is unavailable or too large.");
    const schemaText = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const parsed = parseCollectionSchema(schemaText);
    const versionError = collectionVersionError(parsed.reasons, schemaPath);
    if (versionError) throw new Error(versionError);
    if (
      parsed.status !== "valid" ||
      [...declared.collection.allowedFields, ...declared.collection.readFields].some(
        (name) => !parsed.schema.fields.some((field) => field.name === name),
      )
    )
      throw new Error("Collection fields do not match its schema.");
    dependencies.onCollectionSchema?.(schemaText);
    capabilities.push(
      parseAppCollectionCapability({ ...declared.collection, schemaSha256: file.sha256 }),
    );
  }
  const built = await dependencies.compile(
    {
      entryPath: declared.entryPath,
      inputs: selected.files,
      packageMap: declared.packageMap,
      bounds: {
        ...inputBounds,
        maxOutputBytes: APP_PUBLICATION_LIMITS.maxBundleBytes,
        maxOutputFileBytes: APP_PUBLICATION_MAX_BLOB_BYTES,
      },
    },
    signal,
  );
  assertCurrent();
  signal.throwIfAborted();
  const candidate = parseAppPublicationCandidate(
    {
      versionId,
      appRoot: input.appRoot,
      entryPath: declared.entryPath,
      packageMap: declared.packageMap,
      sourceRevision: selected.metadata.sourceDigest,
      sourceDigest: built.sourceDigest,
      dependencyLockDigest: built.dependencyLockDigest,
      bundleDigest: built.bundleDigest,
      buildDigest: built.buildDigest,
      compilerIdentity: built.compiler,
      inputs: selected.metadata.files.map(({ path, sha256, byteLength }) => ({
        path,
        sha256,
        byteLength,
      })),
      dependencies: built.dependencyLock.map((file) => file.path),
      files: built.files.map(({ bytes: _, ...file }) => file),
      capabilities,
      ...(declared.external ? { external: declared.external } : {}),
    },
    APP_PUBLICATION_LIMITS,
  );
  return {
    candidate,
    files: built.files.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) })),
    likelySecrets,
  };
}
