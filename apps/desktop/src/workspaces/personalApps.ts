import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import {
  parseAppDatasetCapability,
  type AppDatasetCapability,
  type AppDatasetReference,
  type DatasetDescription,
} from "@dohc/security-contract/dataset";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { atomicWriteFile } from "../atomicReplaceFile";
import { createLocalOwnerAppPublicationHandler } from "../ipc/localOwnerAppPublication";
import type { ClosedAppBuild, ClosedAppBuildRequest } from "./closedAppCompiler";
import type { LocalAppLaunchBackend, LocalAppLaunchHost } from "./localAppLaunch";
import { datasetTypes, DATASET_TYPES_FOLDER } from "./datasetTypes";
import { createLocalAppStore } from "./localAppStore";
import {
  datasetCapabilitiesOf,
  localDatasetAppStorage,
  selectDatasetCapability,
} from "./localDatasetApps";
import type { OwnerDatasetData } from "./remoteDataset";
import { createServerDatasetApps, localDatasetAppId } from "./serverDatasetApps";
import { recordedShareSelector } from "./shareViewRecords";

type MemberData = Pick<OwnerDatasetData, "describe" | "invoke" | "upload" | "file">;
type SourceAdapter = Pick<
  VersionedLiveAdapter,
  "captureSourceMetadata" | "hydrateCapturedSources" | "listTextFileMetadata" | "workspace"
>;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const MAX_FILES = 512,
  MAX_BYTES = 128 * 1024 * 1024;

/** Each joined workspace's Personal apps live here, outside its synced folder, so they never sync. */
export function personalAppFolder(stateDir: string, workspaceId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("Choose a joined workspace.");
  return join(stateDir, "personal-apps", workspaceId);
}

export async function openPersonalAppFolder(folder: string) {
  await mkdir(folder, { recursive: true });
  if (!(await lstat(folder)).isDirectory())
    throw new Error(`${folder} is not a folder. Move it away and try again.`);
  const apps = (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && isShareablePath(entry.name))
    .map((entry) => ({ appRoot: entry.name }))
    .sort((a, b) => (a.appRoot < b.appRoot ? -1 : a.appRoot > b.appRoot ? 1 : 0));
  return { kind: "personalFolder" as const, path: folder, apps };
}

async function readInside(folder: string, path: string) {
  if (!isShareablePath(path)) throw new Error(`${path} is not a file in your Personal app folder.`);
  const real = await realpath(join(folder, ...path.split("/"))).catch(() => null);
  const stats = real === null ? null : await lstat(real);
  if (!real || !stats?.isFile())
    throw new Error(`${path} does not exist in your Personal app folder.`);
  if (!real.startsWith((await realpath(folder)) + sep))
    throw new Error(`${path} is outside your Personal app folder.`);
  if (stats.size > MAX_BYTES) throw new Error(`${path} is larger than 128 MB.`);
  return new Uint8Array(await readFile(real));
}

async function walk(folder: string, under: string | undefined) {
  const found: string[] = [];
  const visit = async (relative: string) => {
    const entries = await readdir(join(folder, ...relative.split("/").filter(Boolean)), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (found.push(path), found.length > MAX_FILES))
        throw new Error(
          `${under ?? "Your Personal app folder"} has more than ${MAX_FILES} files. Remove files you don't need.`,
        );
    }
  };
  await visit(under ?? "");
  return found.sort();
}

/** Reads a Personal app from its folder on this computer, in the shape the app compiler reads a workspace. */
export function personalAppSource(
  folder: string,
  workspaceId: string,
  workspace: VersionedLiveAdapter["workspace"],
): SourceAdapter {
  const read = new Map<string, Promise<Uint8Array>>();
  const bytesOf = (path: string) => {
    let bytes = read.get(path);
    if (!bytes) read.set(path, (bytes = readInside(folder, path)));
    return bytes;
  };
  const entry = async (path: string) => {
    const bytes = await bytesOf(path);
    return {
      path,
      objectId: path,
      contentKind: "text" as const,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      latestMomentId: "personal",
    };
  };
  return {
    workspace,
    async listTextFileMetadata({ under }) {
      return Promise.all(
        (await walk(folder, under)).map(async (path) => ({
          ...(await entry(path)),
          binarySha256: null,
          updatedAtMs: 0,
          metadataOrigin: "personal",
          hasYdocMarker: false,
        })),
      );
    },
    async captureSourceMetadata({ paths, bounds }) {
      const files = await Promise.all(paths.map(entry));
      const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
      if (files.length > bounds.maxInputFiles || totalBytes > bounds.maxInputBytes)
        throw new Error(
          `This app's files are over the limit of ${bounds.maxInputFiles} files and ${bounds.maxInputBytes} bytes. It has ${files.length} files and ${totalBytes} bytes.`,
        );
      return {
        workspaceId,
        versionId: "main",
        sourceDigest: sha256(JSON.stringify(files.map((f) => [f.path, f.sha256, f.byteLength]))),
        totalBytes,
        files,
      };
    },
    async hydrateCapturedSources(capture) {
      return Promise.all(
        capture.files.map(async (file) => ({
          ...file,
          bytes: Uint8Array.from(await bytesOf(file.path)),
        })),
      );
    },
  };
}

/** What a Personal app may do with a Collection: what it declares, within what the member's own grant shows them. */
export function memberDatasetCapability(
  reference: AppDatasetReference,
  datasetId: string,
  description: DatasetDescription,
  alias?: string,
): AppDatasetCapability {
  if (description.datasetId !== datasetId)
    throw new Error("The Collection changed. Prepare the app again.");
  if (("linkReads" in reference && reference.linkReads?.length) || reference.createFields?.length)
    throw new Error(
      `Personal apps cannot use linkReads or createFields. Remove them from ${description.name}'s entry in app.publish.json.`,
    );
  if (
    reference.revision !== undefined &&
    (reference.revision !== description.revision ||
      reference.revisionSha256 !== description.revisionSha256)
  )
    throw new Error(
      `${description.name} is at revision ${description.revision}. Update or remove the revision in app.publish.json.`,
    );
  const byId = "operationIds" in reference;
  const operations = (byId ? reference.operationIds : reference.operations).map((key) => {
    const found = description.operations.find(
      (operation) => (byId ? operation.operationId : operation.name) === key,
    );
    if (!found || found.access === "owner")
      throw new Error(`${key} is not an action you can use in ${description.name}.`);
    const { operationId, name, access, readOnly } = found;
    return { operationId, name, access, readOnly };
  });
  return parseAppDatasetCapability({
    kind: "dataset",
    datasetId,
    revision: description.revision,
    revisionSha256: description.revisionSha256,
    operationIds: operations.map((operation) => operation.operationId),
    operations,
    name: description.name,
    ...(alias === undefined ? {} : { alias }),
  });
}

/** Writes a Collection's TypeScript types, as the member sees it, into the Personal app folder. */
export async function writePersonalTypes(folder: string, description: DatasetDescription) {
  const slug =
    description.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "collection";
  const types = join(folder, ...DATASET_TYPES_FOLDER.split("/"));
  await mkdir(types, { recursive: true });
  const path = join(types, `${slug}-${description.datasetId.toLowerCase()}.d.ts`);
  await atomicWriteFile(
    path,
    datasetTypes({
      revision: description.revision,
      definition: {
        name: description.name,
        operations: description.operations,
        tables: description.tables.map((table) => ({
          ...table,
          sqlName: table.name,
          fields: table.fields.map((field) =>
            field.type === "button" ? field : { ...field, sqlColumn: field.name },
          ),
        })),
      },
    }),
  );
  return path;
}

const attachmentFields = (description: DatasetDescription, operationIds: readonly string[]) =>
  description.operations
    .filter((operation) => operationIds.includes(operation.operationId))
    .flatMap((operation) =>
      (description.tables.find((table) => table.tableId === operation.tableId)?.fields ?? [])
        .filter(
          (field) => field.type === "attachment" && operation.fieldIds.includes(field.fieldId),
        )
        .map((field) => field.fieldId),
    );

/**
 * A member's approved Personal apps for one joined workspace. Each app's requests go to the
 * member's own Collection routes with the member's sign-in, so the server's grant check decides.
 */
export function createPersonalApps(options: {
  workspaceId: string;
  databasePath: string;
  lifetime: AbortSignal;
  data(signal: AbortSignal): Promise<MemberData>;
}) {
  const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(options.databasePath, { allowExtension: false });
  const assertCurrent = () => options.lifetime.throwIfAborted();
  const store = createLocalAppStore({
    db,
    sources: [localDatasetAppStorage(db)],
    assertCurrent,
    transaction: (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    charge: () => {},
  });
  const data = (signal?: AbortSignal) =>
    options.data(signal ? AbortSignal.any([signal, options.lifetime]) : options.lifetime);
  const apps = createServerDatasetApps({
    store,
    workspaceId: options.workspaceId,
    assertCurrent,
    agentRun: () => null,
    lifetime: options.lifetime,
    server: {
      approve: async (candidate) => ({
        publicationId: localDatasetAppId(options.workspaceId, candidate),
        authorityRevision: 1,
      }),
      withdraw: async () => {},
      async request(publicationId, action, body, signal) {
        const capability = selectDatasetCapability(
          datasetCapabilitiesOf(store.row(publicationId).candidate),
          body.dataset as string | undefined,
        );
        const pinned = {
          workspaceId: options.workspaceId,
          datasetId: capability.datasetId,
          revision: capability.revision,
          revisionSha256: capability.revisionSha256,
          signal,
        };
        const operation = capability.operations.find((found) => found.name === body.operation);
        const member = await data(signal);
        if (action === "invoke") {
          const { catchUp: _, ...result } = await member.invoke({
            ...pinned,
            operationId: operation!.operationId,
            input: body.input as never,
            idempotencyKey: body.idempotencyKey as string,
          });
          return result;
        }
        if (action === "attempt") throw new Error("Personal apps cannot keep pending submissions.");
        const description = await member.describe(capability.datasetId);
        if (action === "upload") {
          const [fieldId] = attachmentFields(
            description,
            capability.operations
              .filter((found) => !found.readOnly)
              .map((found) => found.operationId),
          );
          if (!fieldId) throw new Error("This app cannot upload files.");
          return member.upload({
            ...pinned,
            action: "upload",
            fieldId,
            idempotencyKey: body.idempotencyKey as string,
            name: body.name as string,
            contentType: body.contentType as string,
            bytesBase64: body.bytesBase64 as string,
          });
        }
        let failure: unknown = new Error("Choose an approved read action for this file.");
        for (const fieldId of attachmentFields(description, [operation!.operationId])) {
          try {
            return await member.file({
              ...pinned,
              action: "file",
              fileId: body.fileId as string,
              read: { operationId: operation!.operationId, fieldId, input: body.input as never },
            });
          } catch (error) {
            failure = error;
          }
        }
        throw failure;
      },
    },
  });
  const backend: LocalAppLaunchBackend = {
    browserPublication(publicationId) {
      apps.current(publicationId);
      return store.browserPublication(publicationId);
    },
    assertBrowserPublication: (publicationId, authorityRevision) =>
      void apps.current(publicationId, authorityRevision),
    request: (publicationId, action, input, signal, activated) =>
      apps.request(publicationId, action, input, signal, activated),
    readBrowserFile: (publicationId, input, signal) =>
      apps.readBrowserFile(publicationId, input, signal),
  };
  return {
    backend,
    has: (publicationId: string) => store.has(publicationId),
    list: (appRoot: string) => store.list(appRoot).map((row) => apps.describe(row)),
    activate: apps.activate,
    async withdraw(publicationId: string, expected: number) {
      const ended = store.withdraw(publicationId, expected, apps.withdrawBinding);
      return {
        kind: "withdrawn" as const,
        publicationId,
        authorityRevision: ended.authorityRevision,
      };
    },
    async close() {
      await apps.close();
      db.close();
    },
  };
}

/** A joined workspace member's Personal app actions. Answers null for anyone else, so the caller refuses. */
export function createPersonalAppPublication<
  Workspace extends { workspaceId: string; shareView?: unknown },
  Operation extends {
    workspace: Workspace;
    signal: AbortSignal;
    scope?: string;
    assertCurrent(): void;
  },
>(deps: {
  stateDir(): string;
  hostFor(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<{
    apps: ReturnType<typeof createPersonalApps>;
    launcher: Pick<LocalAppLaunchHost, "launch">;
  }>;
  data(workspace: Workspace, signal: AbortSignal): Promise<MemberData>;
  withAdapter<T>(
    workspace: Workspace,
    work: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T | null>;
  compile(request: ClosedAppBuildRequest, signal: AbortSignal): Promise<ClosedAppBuild>;
  openFolder(path: string): Promise<void>;
}) {
  const folderOf = (workspace: Workspace) =>
    personalAppFolder(deps.stateDir(), workspace.workspaceId);
  const handler = createLocalOwnerAppPublicationHandler<Workspace, Operation>({
    flushCapture: async () => ({ deferredWrites: [] }),
    withAdapter: deps.withAdapter,
    compile: deps.compile,
    datasetForWorkspace: async (workspace, signal) => ({
      apps: (await deps.hostFor(workspace, signal)).apps,
    }),
    datasetCapability: async (workspace, reference, datasetId, alias, signal) =>
      memberDatasetCapability(
        reference,
        datasetId,
        await (await deps.data(workspace, signal)).describe(datasetId),
        alias,
      ),
    appSource: (workspace, adapter) =>
      personalAppSource(folderOf(workspace), workspace.workspaceId, adapter.workspace),
    launchLocalDataset: async (workspace, publicationId, signal) =>
      (await deps.hostFor(workspace, signal)).launcher.launch(publicationId, signal),
  });
  return async (
    input: OwnerAppPublicationRequest,
    callerKey: string,
    operation: Operation,
    agent: ApprovalAgent | null,
  ) => {
    const shareView = operation.workspace.shareView as { grantedSelector?: unknown } | null;
    if (recordedShareSelector(shareView?.grantedSelector)?.wholeWorkspace !== true) return null;
    if (input.action !== "personalFolder") return handler(input, callerKey, operation, agent);
    const folder = await openPersonalAppFolder(folderOf(operation.workspace));
    if (input.open) await deps.openFolder(folder.path);
    return folder;
  };
}
