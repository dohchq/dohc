import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  classifyPath,
  validateUserMaterializePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import {
  SharedFileReadOnlyError,
  type PullShareViewResult,
  type ShareViewRefusal,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import type {
  ListWorkspaceFilesResult,
  WorkspaceFileEntry,
} from "../ipc/bridgeContract";
import {
  mediaTypeForExtension,
  type WorkspaceOperationLease,
  type WorkspaceTextReadResult,
  type WorkspaceTextWriteResult,
  WORKSPACE_ASSET_MAX_BYTES,
  workspaceTextReadResultFromBytes,
} from "./workspaceAssets";
import {
  extractFrontmatterIcon,
  type ImportCopyOutcome,
} from "./workspaceFiles";
import {
  captureStandaloneShareViewDivergence,
  captureSharedViewLocalDivergence,
  readSharedViewProjectionDebt,
  reconcileStandaloneShareView,
  refreshCapturedShareView,
  refreshSharedViewOnce,
  type RefreshSharedViewOutcome,
  type StandaloneShareViewRefreshOutcome,
  withShareViewRefreshLifecycleLock,
} from "./sharedView";
import {
  assertShareChangesJournalable,
  recordedShareSelector,
  SharePinInvalidError,
} from "./shareViewRecords";
import { shareViewTakesLocalWrites } from "./shareWriteGate";
import { isEngineTransportFailure } from "./shareViewEngineFailure";
import {
  applyShareViewFileCreate,
  applyShareViewFileImport,
  applyShareViewPathDelete,
  applyShareViewPathMove,
  applyShareViewTextWrite,
} from "./shareViewFileChanges";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

export type ShareViewFilesTarget =
  | { kind: "standalone"; workspaceId: string }
  | { kind: "mount"; workspaceId: string; shareId: string };

export interface ResolvedShareViewFilesTarget {
  kind: ShareViewFilesTarget["kind"];
  /** The registry workspace that owns this received share or mount row. */
  workspaceId: string;
  /** The engine workspace that stores the received share's canonical files. */
  storeWorkspaceId: string;
  /** The root serialized by main's process-wide workspace scheduler. */
  schedulingRootPath: string;
  /** The projected folder owned by this received share. */
  rootPath: string;
  /** Null only for a damaged standalone marker whose local store stays readable. */
  shareId: string | null;
  granterEmail: string | null;
  grantedSelector: unknown;
  ended: boolean;
  relayUrl?: string | null;
  recipientEmail?: string | null;
  /** Present only for a mount; revalidated before any projected-folder write. */
  mountLabel?: string;
}

export type ShareViewFileChange =
  | {
      kind: "save";
      path: string;
      text: string;
      expectedContentHash: string;
    }
  | { kind: "create"; path: string; initialText: string }
  | { kind: "move"; fromPath: string; toPath: string }
  | { kind: "delete"; path: string }
  | {
      kind: "import";
      absolutePaths: string[];
      screenAgainstRoots: string[] | null;
      targetDir: string | undefined;
    };

export type ShareViewFileChangeValue =
  | WorkspaceTextWriteResult
  | string
  | { trashed: boolean }
  | ImportCopyOutcome;

export interface ShareViewFileChangeEffect {
  path: string;
  before: "present" | "absent";
  after: "present" | "absent";
}

export type ShareViewFileChangeOutcome =
  | {
      status: "committed";
      kind: ShareViewFileChange["kind"];
      value: ShareViewFileChangeValue;
      projection: "current" | "pending";
    }
  | {
      status: "partial";
      kind: ShareViewFileChange["kind"];
      effects: ShareViewFileChangeEffect[];
      projection: "current" | "pending";
      message: string;
    }
  | {
      status: "indeterminate";
      kind: ShareViewFileChange["kind"];
      possibleEffects: ShareViewFileChangeEffect[];
      projection: "current" | "pending";
      message: string;
    };

export type ShareViewFileReadRequest =
  | { kind: "text"; path: string }
  | { kind: "asset"; path: string };

export type ShareViewFileReadOutcome =
  | ({ kind: "text" } & WorkspaceTextReadResult)
  | { kind: "asset"; bytes: Buffer; mediaType: string };

export type ShareViewProjectionStatus =
  | { state: "current" }
  | { state: "unavailable" }
  | {
      state: "pending";
      pendingPathCount: number;
      pendingPaths: string[];
      collisionPathCount: number;
      collisionPaths: string[];
      pullInFlight: boolean;
    };

export type ShareViewReconcileRequest = "settle" | "repair" | "refresh";

export type ShareViewReconcileOutcome =
  | {
      kind: "settle";
      capturedPaths: number;
      repairedPaths: number;
      unjournalablePaths: Awaited<
        ReturnType<typeof captureStandaloneShareViewDivergence>
      >["unjournalablePaths"];
      collisionRecordQuarantined: boolean;
    }
  | {
      kind: "repair";
      repairedPaths: number;
      unjournalablePaths: Awaited<
        ReturnType<typeof captureStandaloneShareViewDivergence>
      >["unjournalablePaths"];
      collisionRecordQuarantined: boolean;
    }
  | {
      kind: "refresh";
      outcome: StandaloneShareViewRefreshOutcome | RefreshSharedViewOutcome;
    };

export interface ShareViewFiles {
  change(
    lease: WorkspaceOperationLease,
    target: ShareViewFilesTarget,
    change: ShareViewFileChange,
  ): Promise<ShareViewFileChangeOutcome>;
  read(
    target: ShareViewFilesTarget,
    request: ShareViewFileReadRequest,
  ): Promise<ShareViewFileReadOutcome>;
  list(target: ShareViewFilesTarget): Promise<ListWorkspaceFilesResult>;
  projectionStatus(
    target: ShareViewFilesTarget,
  ): Promise<ShareViewProjectionStatus>;
  reconcile(
    lease: WorkspaceOperationLease,
    target: ShareViewFilesTarget,
    request: ShareViewReconcileRequest,
  ): Promise<ShareViewReconcileOutcome>;
  unmount(
    lease: WorkspaceOperationLease,
    target: Extract<ShareViewFilesTarget, { kind: "mount" }>,
  ): Promise<{ folderLeft: boolean }>;
}

export type ShareViewFilesStore = CaptureVersionedTextStore & {
  listTextFileMetadata: NonNullable<
    CaptureVersionedTextStore["listTextFileMetadata"]
  >;
};

export function shareViewFilesStore(
  store: CaptureVersionedTextStore,
): ShareViewFilesStore {
  const listTextFileMetadata = store.listTextFileMetadata;
  if (listTextFileMetadata === undefined) {
    throw new Error(
      "Received-share files require engine metadata listing support.",
    );
  }
  return Object.assign(store, { listTextFileMetadata });
}

export interface ShareViewFilesDependencies {
  /** Synchronous and registry-derived. It is called again after lifecycle wait. */
  resolveTarget(
    target: ShareViewFilesTarget,
  ): ResolvedShareViewFilesTarget | null;
  openStore(
    target: ResolvedShareViewFilesTarget,
  ): ShareViewFilesStore;
  resolveRelay(
    target: ActiveShareViewFilesTarget,
  ): Promise<SyncRelayConnection | null>;
  pull(
    target: ActiveShareViewFilesTarget,
    relay: SyncRelayConnection,
    input: {
      grantedSelector: NonNullable<ReturnType<typeof recordedShareSelector>>;
      recordRefusals: (refusals: ShareViewRefusal[]) => Promise<void>;
      recordCollisions?: (paths: readonly string[]) => Promise<void>;
      recordChangedPaths?: (paths: readonly string[]) => Promise<void>;
    },
  ): Promise<PullShareViewResult>;
  recordRefusals(
    target: ActiveShareViewFilesTarget,
    refusals: readonly ShareViewRefusal[],
  ): Promise<void>;
  markEnded(target: ActiveShareViewFilesTarget): Promise<void>;
  retireTarget(target: ActiveShareViewFilesTarget): Promise<void>;
  assertProjectionRoot(target: ResolvedShareViewFilesTarget): Promise<void>;
  removeMount(
    target: ActiveShareViewFilesTarget,
  ): Promise<{ folderLeft: boolean }>;
}

type ActiveShareViewFilesTarget = ResolvedShareViewFilesTarget & {
  shareId: string;
};

export class ShareViewFilesTargetMissingError extends Error {
  constructor() {
    super("This received share is no longer registered in this workspace.");
    this.name = "ShareViewFilesTargetMissingError";
  }
}

const STATUS_PATH_LIMIT = 20;
const ICON_SOURCE_MAX_BYTES = 64 * 1024;
const ICON_READ_CONCURRENCY = 8;
const ICON_CACHE_LIMIT = 4_000;

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function targetKey(target: ShareViewFilesTarget): string {
  return target.kind === "standalone"
    ? `standalone:${target.workspaceId}`
    : `mount:${target.workspaceId}:${target.shareId}`;
}

function assertSameTarget(
  expected: ResolvedShareViewFilesTarget,
  current: ResolvedShareViewFilesTarget,
): void {
  if (
    expected.kind !== current.kind ||
    expected.workspaceId !== current.workspaceId ||
    expected.storeWorkspaceId !== current.storeWorkspaceId ||
    expected.shareId !== current.shareId ||
    expected.mountLabel !== current.mountLabel ||
    !samePath(expected.rootPath, current.rootPath) ||
    !samePath(expected.schedulingRootPath, current.schedulingRootPath)
  ) {
    throw new Error(
      `Received-share target changed while ${targetKey({
        kind: expected.kind,
        workspaceId: expected.workspaceId,
        ...(expected.kind === "mount" ? { shareId: expected.shareId } : {}),
      } as ShareViewFilesTarget)} was waiting. Retry the operation.`,
    );
  }
}

function assertActiveTarget(
  target: ResolvedShareViewFilesTarget,
): asserts target is ActiveShareViewFilesTarget {
  if (target.shareId === null) {
    throw new SharePinInvalidError(target.workspaceId);
  }
}

function writableSelector(target: ActiveShareViewFilesTarget) {
  const selector = recordedShareSelector(target.grantedSelector);
  if (selector === null) throw new SharePinInvalidError(target.shareId);
  if (
    target.kind === "mount" ||
    !shareViewTakesLocalWrites({
      access: selector.access,
      ended: target.ended,
    })
  ) {
    const granter = target.granterEmail ?? "the person who shared it";
    throw new SharedFileReadOnlyError(
      `This shared view is read-only for you. Ask ${granter} for changes.`,
    );
  }
  return selector;
}

function assertPathWithinGrant(
  selector: NonNullable<ReturnType<typeof recordedShareSelector>>,
  path: string,
): void {
  const validated = validateUserWritePath(path);
  if (
    !validated.ok ||
    classifyEngineFilePath(validated.normalized).kind !== "tracked"
  ) {
    throw new SharedFileReadOnlyError(
      `This path is not available through the shared view: ${path}`,
    );
  }
  const selected =
    selector.paths.length === 0
      ? selector.versionId !== null
      : selector.paths.some(
          (granted) =>
            validated.normalized === granted ||
            validated.normalized.startsWith(`${granted}/`),
        );
  if (!selected) {
    throw new SharedFileReadOnlyError(
      `This path is outside the files shared with you: ${validated.normalized}`,
    );
  }
}

function validatedReadPath(path: string): string {
  const validated = validateUserReadPath(path);
  if (!validated.ok) {
    throw new Error(`Invalid shared file path (${validated.reason}): ${path}`);
  }
  return validated.normalized;
}

function missingFile(path: string): Error {
  return Object.assign(new Error(`Shared file not found: ${path}`), {
    code: "ENOENT",
  });
}

async function storeBytes(
  store: CaptureVersionedTextStore,
  target: ResolvedShareViewFilesTarget,
  path: string,
): Promise<Buffer> {
  const main = await store.ensureMainVersion({
    workspaceId: target.storeWorkspaceId,
  });
  const snapshot = await store.readTextFile({
    workspaceId: target.storeWorkspaceId,
    versionId: main.id,
    path,
  });
  if (snapshot === null) throw missingFile(path);
  if (snapshot.contentKind === "binary") {
    const bytes = await store.readBinaryFile({
      workspaceId: target.storeWorkspaceId,
      versionId: main.id,
      path,
    });
    if (bytes === null) throw missingFile(path);
    return Buffer.from(bytes);
  }
  return Buffer.from(snapshot.text, "utf8");
}

function foldersFor(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join("/"));
    }
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

interface CanonicalFileState {
  objectId: string;
  contentKind: "text" | "binary";
  sha256: string | null;
  latestMomentId: string;
}

type CanonicalSnapshot = Map<string, CanonicalFileState>;

async function canonicalSnapshot(
  store: ShareViewFilesStore,
  workspaceId: string,
  change: ShareViewFileChange,
): Promise<CanonicalSnapshot> {
  const main = await store.ensureMainVersion({ workspaceId });
  if (change.kind === "save" || change.kind === "create") {
    const path =
      change.kind === "save"
        ? normalizedWritePath(change.path)
        : normalizedMaterializePath(change.path);
    if (path === null) return new Map();
    const file = await store.readTextFile({
      workspaceId,
      versionId: main.id,
      path,
    });
    if (file === null) return new Map();
    return new Map([
      [
        path,
        {
          objectId: file.objectId,
          contentKind: file.contentKind === "binary" ? "binary" : "text",
          sha256: file.sha256 ?? null,
          latestMomentId: file.latestMomentId,
        },
      ],
    ]);
  }
  const files = await store.listTextFileMetadata({
    workspaceId,
    versionId: main.id,
  });
  return new Map(
    files.map((file) => [
      file.path,
      {
        objectId: file.objectId,
        contentKind: file.contentKind,
        sha256: file.sha256,
        latestMomentId: file.latestMomentId,
      },
    ]),
  );
}

function sameCanonicalState(
  left: CanonicalFileState | undefined,
  right: CanonicalFileState | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.objectId === right.objectId &&
      left.contentKind === right.contentKind &&
      left.sha256 === right.sha256 &&
      left.latestMomentId === right.latestMomentId)
  );
}

function canonicalEffects(
  before: CanonicalSnapshot,
  after: CanonicalSnapshot,
): ShareViewFileChangeEffect[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => !sameCanonicalState(before.get(path), after.get(path)))
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({
      path,
      before: before.has(path) ? "present" : "absent",
      after: after.has(path) ? "present" : "absent",
    }));
}

function normalizedMaterializePath(path: string): string | null {
  const validated = validateUserMaterializePath(path);
  return validated.ok ? validated.normalized : null;
}

function normalizedWritePath(path: string): string | null {
  const validated = validateUserWritePath(path);
  return validated.ok ? validated.normalized : null;
}

function localDivergenceScopes(change: ShareViewFileChange): string[] {
  if (change.kind === "save" || change.kind === "delete") {
    const path = normalizedWritePath(change.path);
    return path === null ? [] : [path];
  }
  if (change.kind === "move") {
    const path = normalizedWritePath(change.fromPath);
    return path === null ? [] : [path];
  }
  return [];
}

function pathAndChildren(snapshot: CanonicalSnapshot, path: string): string[] {
  return [...snapshot.keys()].filter(
    (candidate) => candidate === path || candidate.startsWith(`${path}/`),
  );
}

function changeIsFullyApplied(
  change: ShareViewFileChange,
  before: CanonicalSnapshot,
  after: CanonicalSnapshot,
): boolean {
  switch (change.kind) {
    case "save": {
      const path = normalizedWritePath(change.path);
      const expected = createHash("sha256").update(change.text).digest("hex");
      return path !== null && after.get(path)?.sha256 === expected;
    }
    case "create": {
      const path = normalizedMaterializePath(change.path);
      const expected = createHash("sha256")
        .update(change.initialText)
        .digest("hex");
      return path !== null && after.get(path)?.sha256 === expected;
    }
    case "move": {
      const from = normalizedWritePath(change.fromPath);
      const to = normalizedMaterializePath(change.toPath);
      if (from === null || to === null || from === to) return false;
      const sources = pathAndChildren(before, from);
      if (sources.length === 0) return false;
      return sources.every((source) => {
        const destination =
          source === from ? to : `${to}/${source.slice(from.length + 1)}`;
        const original = before.get(source);
        const moved = after.get(destination);
        return (
          moved !== undefined &&
          original?.objectId === moved.objectId &&
          (source === destination || !after.has(source))
        );
      });
    }
    case "delete": {
      const path = normalizedWritePath(change.path);
      return (
        path !== null &&
        pathAndChildren(before, path).length > 0 &&
        pathAndChildren(after, path).length === 0
      );
    }
    case "import":
      // A failed import may have committed a prefix of its sources. Without an
      // engine batch result, that prefix is partial even when every readable
      // source happened to land before a later source failed.
      return false;
  }
}

function committedValueAfterFailure(
  change: Exclude<ShareViewFileChange, { kind: "import" }>,
): ShareViewFileChangeValue {
  switch (change.kind) {
    case "save":
      return {
        status: "written",
        contentHash: createHash("sha256").update(change.text).digest("hex"),
      };
    case "create":
      return normalizedMaterializePath(change.path) ?? change.path;
    case "move":
      return normalizedMaterializePath(change.toPath) ?? change.toPath;
    case "delete":
      return { trashed: false };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createShareViewFiles(
  dependencies: ShareViewFilesDependencies,
): ShareViewFiles {
  const iconCache = new Map<
    string,
    { stamp: string; icon: string | undefined }
  >();

  function rememberIcon(
    key: string,
    value: { stamp: string; icon: string | undefined },
  ): void {
    iconCache.delete(key);
    iconCache.set(key, value);
    if (iconCache.size > ICON_CACHE_LIMIT) {
      const oldest = iconCache.keys().next().value;
      if (oldest !== undefined) iconCache.delete(oldest);
    }
  }

  async function withCurrentTarget<T>(
    requested: ShareViewFilesTarget,
    run: (target: ResolvedShareViewFilesTarget) => Promise<T>,
  ): Promise<T> {
    const admitted = dependencies.resolveTarget(requested);
    if (admitted === null) throw new ShareViewFilesTargetMissingError();
    return withShareViewRefreshLifecycleLock(admitted.rootPath, async () => {
      const current = dependencies.resolveTarget(requested);
      if (current === null) throw new ShareViewFilesTargetMissingError();
      assertSameTarget(admitted, current);
      return run(current);
    });
  }

  function assertLease(
    lease: WorkspaceOperationLease,
    target: ResolvedShareViewFilesTarget,
  ): void {
    if (!samePath(lease.rootPath, target.schedulingRootPath)) {
      throw new Error(
        "Received-share mutation did not hold its owning workspace scheduler.",
      );
    }
  }

  async function withStore<T>(
    target: ResolvedShareViewFilesTarget,
    run: (store: ShareViewFilesStore) => Promise<T>,
  ): Promise<T> {
    if (target.kind === "mount") {
      await dependencies.assertProjectionRoot(target);
    }
    return run(dependencies.openStore(target));
  }

  async function projectionState(
    target: ActiveShareViewFilesTarget,
  ): Promise<"current" | "pending"> {
    try {
      const debt = await readSharedViewProjectionDebt(
        target.rootPath,
        target.shareId,
      );
      return debt.pendingPaths.size === 0 &&
        debt.collisionPaths.size === 0 &&
        !debt.pullInFlight
        ? "current"
        : "pending";
    } catch {
      // A canonical mutation must not be reported as failed merely because
      // its recovery record cannot be inspected. Pending is the conservative
      // statement: reconciliation will verify the projection from the store.
      return "pending";
    }
  }

  async function applyChange(
    target: ActiveShareViewFilesTarget,
    change: ShareViewFileChange,
    selector: NonNullable<ReturnType<typeof recordedShareSelector>>,
  ): Promise<ShareViewFileChangeOutcome> {
    if (change.kind === "save" || change.kind === "create") {
      assertPathWithinGrant(selector, change.path);
    } else if (change.kind === "move") {
      assertPathWithinGrant(selector, change.fromPath);
      assertPathWithinGrant(selector, change.toPath);
    } else if (change.kind === "delete") {
      assertPathWithinGrant(selector, change.path);
    }
    const store = dependencies.openStore(target);
    const divergenceScopes = localDivergenceScopes(change);
    if (target.kind === "standalone" && divergenceScopes.length > 0) {
      const captured = await captureStandaloneShareViewDivergence({
        rootDir: target.rootPath,
        workspaceId: target.storeWorkspaceId,
        store,
        pinnedSelector: target.grantedSelector,
        shareId: target.shareId,
        ended: target.ended,
        paths: divergenceScopes,
      });
      if (captured.collisionRecordQuarantined) {
        throw new Error(
          "The shared view's recovery record was damaged and has been set aside. Retry the change.",
        );
      }
      assertShareChangesJournalable(captured.unjournalablePaths);
    }
    const before = await canonicalSnapshot(
      store,
      target.storeWorkspaceId,
      change,
    );
    const storeResolver = () => store;
    try {
      let value: ShareViewFileChangeValue;
      switch (change.kind) {
        case "save":
          value = await applyShareViewTextWrite({
            workspaceId: target.storeWorkspaceId,
            rootPath: target.rootPath,
            relativePath: change.path,
            text: change.text,
            expectedContentHash: change.expectedContentHash,
            shareViewStore: storeResolver,
          });
          break;
        case "create":
          value = await applyShareViewFileCreate({
            workspaceId: target.storeWorkspaceId,
            rootPath: target.rootPath,
            relativePath: change.path,
            initialText: change.initialText,
            shareViewStore: storeResolver,
          });
          break;
        case "move":
          value = await applyShareViewPathMove({
            workspaceId: target.storeWorkspaceId,
            rootPath: target.rootPath,
            fromPath: change.fromPath,
            toPath: change.toPath,
            shareViewStore: storeResolver,
          });
          break;
        case "delete":
          value = await applyShareViewPathDelete({
            workspaceId: target.storeWorkspaceId,
            rootPath: target.rootPath,
            relativePath: change.path,
            shareViewStore: storeResolver,
          });
          break;
        case "import":
          value = await applyShareViewFileImport({
            workspaceId: target.storeWorkspaceId,
            rootPath: target.rootPath,
            absolutePaths: change.absolutePaths,
            screenAgainstRoots: change.screenAgainstRoots,
            targetDir: change.targetDir,
            shareViewStore: storeResolver,
            assertPathAllowed: (path) =>
              assertPathWithinGrant(selector, path),
          });
          break;
      }
      return {
        status: "committed",
        kind: change.kind,
        value,
        projection: await projectionState(target),
      };
    } catch (error) {
      let after: CanonicalSnapshot;
      try {
        after = await canonicalSnapshot(store, target.storeWorkspaceId, change);
      } catch (inspectionError) {
        return {
          status: "indeterminate",
          kind: change.kind,
          possibleEffects: [],
          projection: "pending",
          message: `${errorMessage(error)} Canonical state could not be verified: ${errorMessage(inspectionError)}`,
        };
      }
      const effects = canonicalEffects(before, after);
      const projection = await projectionState(target);
      if (
        changeIsFullyApplied(change, before, after) &&
        change.kind !== "import"
      ) {
        return {
          status: "committed",
          kind: change.kind,
          value: committedValueAfterFailure(change),
          projection,
        };
      }
      if (isEngineTransportFailure(error)) {
        return {
          status: "indeterminate",
          kind: change.kind,
          possibleEffects: effects,
          projection,
          message: errorMessage(error),
        };
      }
      if (effects.length === 0) throw error;
      return {
        status: "partial",
        kind: change.kind,
        effects,
        projection,
        message: errorMessage(error),
      };
    }
  }

  return {
    async change(lease, requested, change) {
      return withCurrentTarget(requested, async (target) => {
        assertLease(lease, target);
        assertActiveTarget(target);
        const selector = writableSelector(target);
        return applyChange(target, change, selector);
      });
    },

    async read(requested, request) {
      return withCurrentTarget(requested, async (target) => {
        const path = validatedReadPath(request.path);
        if (classifyEngineFilePath(path).kind !== "tracked") {
          throw new SharedFileReadOnlyError(
            `This path is not available through the shared view: ${request.path}`,
          );
        }
        const bytes = await withStore(target, (store) =>
          storeBytes(store, target, path),
        );
        if (request.kind === "asset") {
          if (bytes.byteLength > WORKSPACE_ASSET_MAX_BYTES) {
            throw new Error(
              `Asset too large to serve (${bytes.byteLength} bytes): ${request.path}`,
            );
          }
          return {
            kind: "asset",
            bytes,
            mediaType: mediaTypeForExtension(path),
          };
        }
        return {
          kind: "text",
          ...workspaceTextReadResultFromBytes(bytes),
        };
      });
    },

    async list(requested) {
      return withCurrentTarget(requested, async (target) => {
        return withStore(target, async (store) => {
          const main = await store.ensureMainVersion({
            workspaceId: target.storeWorkspaceId,
          });
          const metadata = await store.listTextFileMetadata({
            workspaceId: target.storeWorkspaceId,
            versionId: main.id,
          });
          const visible = metadata.filter(
            (entry) => classifyEngineFilePath(entry.path).kind === "tracked",
          );
          const markdown = visible.filter(
            (entry) =>
              entry.contentKind === "text" &&
              (entry.byteLength ?? Number.POSITIVE_INFINITY) <=
                ICON_SOURCE_MAX_BYTES &&
              /\.(md|markdown)$/i.test(entry.path),
          );
          const uncached = markdown.filter((entry) => {
            const key = `${target.storeWorkspaceId}\0${entry.path}`;
            const stamp = entry.sha256 ?? entry.latestMomentId;
            return iconCache.get(key)?.stamp !== stamp;
          });
          let nextIcon = 0;
          await Promise.all(
            Array.from(
              {
                length: Math.min(ICON_READ_CONCURRENCY, uncached.length),
              },
              async () => {
                for (;;) {
                  const entry = uncached[nextIcon++];
                  if (!entry) return;
                  const key = `${target.storeWorkspaceId}\0${entry.path}`;
                  const stamp = entry.sha256 ?? entry.latestMomentId;
                  let icon: string | undefined;
                  try {
                    const snapshot = await store.readTextFile({
                      workspaceId: target.storeWorkspaceId,
                      versionId: main.id,
                      path: entry.path,
                    });
                    if (snapshot && snapshot.contentKind !== "binary") {
                      icon = extractFrontmatterIcon(snapshot.text.slice(0, 1024));
                    }
                  } catch {
                    // Listing stays available if one optional icon cannot be read.
                  }
                  rememberIcon(key, { stamp, icon });
                }
              },
            ),
          );
          const files: WorkspaceFileEntry[] = [];
          for (const entry of visible) {
            const file: WorkspaceFileEntry = {
              path: entry.path,
              kind: classifyPath(entry.path).kind,
            };
            if (/\.(md|markdown)$/i.test(entry.path)) {
              const cached = iconCache.get(
                `${target.storeWorkspaceId}\0${entry.path}`,
              );
              const stamp = entry.sha256 ?? entry.latestMomentId;
              if (cached?.stamp === stamp && cached.icon) {
                file.icon = cached.icon;
              }
            }
            files.push(file);
          }
          files.sort((left, right) => left.path.localeCompare(right.path));
          return { files, folders: foldersFor(files.map((file) => file.path)) };
        });
      });
    },

    async projectionStatus(requested) {
      return withCurrentTarget(requested, async (target) => {
        if (target.shareId === null) return { state: "unavailable" };
        if (target.kind === "mount") {
          await dependencies.assertProjectionRoot(target);
        }
        let debt: Awaited<ReturnType<typeof readSharedViewProjectionDebt>>;
        try {
          debt = await readSharedViewProjectionDebt(
            target.rootPath,
            target.shareId,
          );
        } catch {
          return {
            state: "pending",
            pendingPathCount: 0,
            pendingPaths: [],
            collisionPathCount: 0,
            collisionPaths: [],
            pullInFlight: false,
          };
        }
        if (
          debt.pendingPaths.size === 0 &&
          debt.collisionPaths.size === 0 &&
          !debt.pullInFlight
        ) {
          return { state: "current" };
        }
        const pendingPaths = [...debt.pendingPaths].sort();
        const collisionPaths = [...debt.collisionPaths].sort();
        return {
          state: "pending",
          pendingPathCount: pendingPaths.length,
          pendingPaths: pendingPaths.slice(0, STATUS_PATH_LIMIT),
          collisionPathCount: collisionPaths.length,
          collisionPaths: collisionPaths.slice(0, STATUS_PATH_LIMIT),
          pullInFlight: debt.pullInFlight,
        };
      });
    },

    async reconcile(lease, requested, request) {
      return withCurrentTarget(requested, async (target) => {
        assertLease(lease, target);
        assertActiveTarget(target);
        if (target.kind === "mount") {
          await dependencies.assertProjectionRoot(target);
        }
        const store = dependencies.openStore(target);
        const capture = () =>
          target.kind === "standalone"
            ? captureStandaloneShareViewDivergence({
                rootDir: target.rootPath,
                workspaceId: target.storeWorkspaceId,
                store,
                pinnedSelector: target.grantedSelector,
                shareId: target.shareId,
                ended: target.ended,
              })
            : captureSharedViewLocalDivergence(
                target.rootPath,
                target.storeWorkspaceId,
                store,
                false,
                target.shareId,
              );

        if (request === "settle") {
          if (target.kind !== "standalone") {
            throw new SharedFileReadOnlyError(
              "Mounted shares are read-only projections and have no local changes to settle.",
            );
          }
          return { kind: "settle", ...(await capture()) };
        }

        const recovered = await capture();
        const localChanges =
          recovered.capturedPaths + recovered.repairedPaths;

        if (request === "repair") {
          return {
            kind: "repair",
            repairedPaths: localChanges,
            unjournalablePaths: recovered.unjournalablePaths,
            collisionRecordQuarantined:
              recovered.collisionRecordQuarantined,
          };
        }

        const localOutcome = (
          status: RefreshSharedViewOutcome["status"],
        ): StandaloneShareViewRefreshOutcome | RefreshSharedViewOutcome => {
          const outcome: RefreshSharedViewOutcome = {
            status,
            changedPaths: localChanges,
            excludedPaths: [],
            unjournalablePaths: recovered.unjournalablePaths,
            collisionRecordQuarantined:
              recovered.collisionRecordQuarantined,
            refusedOps: 0,
            refusedDetail: null,
          };
          return target.kind === "standalone"
            ? {
                ok: true,
                ...outcome,
              }
            : outcome;
        };

        let outcome: StandaloneShareViewRefreshOutcome | RefreshSharedViewOutcome;
        if (target.ended) {
          outcome = localOutcome("ended");
        } else {
          const relay = await dependencies.resolveRelay(target);
          if (relay === null) {
            outcome = localOutcome(localChanges > 0 ? "updated" : "unchanged");
          } else {
            const pull: Parameters<
              typeof refreshSharedViewOnce
            >[0]["pull"] = async (input) =>
              dependencies.pull(target, relay, {
                grantedSelector: input.grantedSelector,
                recordRefusals: input.recordRefusals,
                recordCollisions: input.recordCollisions,
                recordChangedPaths: input.recordChangedPaths,
              });
            const recordRefusals = async (refusals: ShareViewRefusal[]) =>
              dependencies.recordRefusals(target, refusals);

            if (target.kind === "standalone") {
              outcome = await reconcileStandaloneShareView({
                rootDir: target.rootPath,
                workspaceId: target.storeWorkspaceId,
                relay,
                shareId: target.shareId,
                pull,
                store,
                pinnedSelector: target.grantedSelector,
                recordRefusals,
                ended: false,
                captured: recovered,
              });
            } else {
              outcome = await refreshCapturedShareView({
                rootDir: target.rootPath,
                workspaceId: target.storeWorkspaceId,
                relay,
                shareId: target.shareId,
                pull,
                store,
                pinnedSelector: target.grantedSelector,
                recordRefusals,
                captured: recovered,
              });
            }
          }
        }
        if (
          "ok" in outcome
            ? outcome.ok && outcome.status === "ended"
            : outcome.status === "ended"
        ) {
          await dependencies.markEnded(target);
          await dependencies.retireTarget(target);
        }
        return { kind: "refresh", outcome };
      });
    },

    async unmount(lease, requested) {
      return withCurrentTarget(requested, async (target) => {
        assertLease(lease, target);
        assertActiveTarget(target);
        if (target.kind !== "mount") {
          throw new Error(
            "Only a mounted share can be removed from a workspace.",
          );
        }
        return dependencies.removeMount(target);
      });
    },
  };
}
