import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineDaemonLifecycle, EngineWorkspace, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { EngineRelayClient, type EngineRelayWorkspaceClient, RelayConfiguredDaemonClientSource, RelayTransportRouteGuard } from "./engineRelayClient";
import { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import { createDesktopLinkedChatStore } from "./liveLinkedChatStore";
import { createCaptureLiveStores, type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import { readLocalStateFrom } from "./workspaceLocalState";
import { createShareViewFiles, type ResolvedShareViewFilesTarget, type ShareViewFileChange, type ShareViewFileChangeValue } from "./shareViewFiles";
import { withStaleSensitiveWorkspaceOperation, type WorkspaceTextWriteResult } from "./workspaceAssets";


// The four remaining writes a share view admits, driven the way
// `shareViewTextWrite.e2e.test.ts` drives the text save.
//
// "The recipient can send this change" is not a UI state: it is a moment in
// this replica's engine store and a row in its `replication_log`, because the
// submit lane reads exactly that log. So every case here asserts the journal
// and the projection, never the return value alone.

export const engine = requireEngineBinaryOrSkip();
export const SHARE_ID = "share-e2e";

export const requireModule = createRequire(import.meta.url);

export interface Harness {
  workspaceId: string;
  rootPath: string;
  engineWorkspace: EngineWorkspace;
  store: CaptureVersionedTextStore;
  sessions: EngineWorkspaceSessions;
  directClient?: EngineRelayWorkspaceClient;
}

export const lifecycles: EngineDaemonLifecycle[] = [];
export const sessionSets: EngineWorkspaceSessions[] = [];
export const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sessionSets
      .splice(0)
      .map((sessions) => sessions.closeAll().catch(() => undefined)),
  );
  await Promise.all(
    lifecycles
      .splice(0)
      .map((lifecycle) => lifecycle.stop().catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * A real daemon, a real engine store, and — for a share view — the sync
 * identity its journal needs. `workspace_journals_file_moments_in_tx` journals
 * a file moment only for a workspace that replicates, and for a share view the
 * `share_view_file_lane` row recorded here is what makes that true.
 */
export async function harness(
  prefix: string,
  access?: "comment" | "edit",
  options: { chatFirst?: boolean; relayUrl?: string } = {},
): Promise<Harness> {
  const rootPath = await createTestScratch(prefix);
  roots.push(rootPath);
  const workspaceId = `${prefix}${process.pid}-${Date.now()}`;
  const lifecycle = createRealDaemonLifecycle({
    command: engine.require(),
  });
  lifecycles.push(lifecycle);
  await lifecycle.start();
  const routes = new RelayTransportRouteGuard();
  const sessions = createRealDaemonWorkspaceSessions(
    new RelayConfiguredDaemonClientSource(lifecycle, routes),
  );
  sessionSets.push(sessions);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const workspace = {
    workspaceId,
    rootPath,
    attachmentId: Symbol("test-workspace-attachment"),
  };
  const receivedShareLocation = { engineWorkspaceId: workspaceId, rootPath };
  const relayClient = new EngineRelayClient({
    sessions,
    routes,
    allowInsecureLoopbackForTests: true,
    requestDeadlineMs: REAL_DAEMON_DEADLINE_MS,
  });
  const receivedShareEngine = createReceivedShareEngineAccess({
    sessions: () => sessions,
    createStores: createCaptureLiveStores,
    relayClient: () => relayClient,
  });
  const engineWorkspace = access
    ? receivedShareEngine.workspaceFor(receivedShareLocation)
    : workspace;
  if (options.chatFirst) {
    await createDesktopLinkedChatStore(engineWorkspace, {
      sessions,
    }).ensureOpen();
  }
  let directClient: EngineRelayWorkspaceClient | undefined;
  if (access) {
    const client = receivedShareEngine.relayFor({
      ...receivedShareLocation,
      relay: { baseUrl: options.relayUrl ?? "http://127.0.0.1:9", token: "share-view-test-token" },
    });
    directClient = client;
    await client.recordShareViewIdentity({
      grantedSelector: { paths: ["docs"], versionId: null, access },
    });
  }
  const store = access
    ? receivedShareEngine.storeFor(receivedShareLocation)
    : createCaptureLiveStores(workspace, sessions).store;
  return { workspaceId, rootPath, engineWorkspace, store, sessions, directClient };
}

export async function flushCapture(harnessed: Harness) {
  return await harnessed.sessions.run(
    harnessed.engineWorkspace,
    async ({ client, workspace }) =>
      await new VersionedLiveAdapter(client, workspace, {
        workspaceId: harnessed.workspaceId,
      }).flushCapture(),
  );
}

/**
 * Writes this person's local work to the store and disk. The next push can send it.
 * A case that needs files the share already has pushes them once first.
 */
export async function seedSharedFiles(
  harnessed: Harness,
  files: readonly { path: string; text: string }[],
): Promise<void> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  for (const file of files) {
    await harnessed.store.writeTextFile({
      workspaceId: harnessed.workspaceId,
      versionId: main.id,
      path: file.path,
      text: file.text,
      metadata: { origin: "sync" },
    });
    await mkdir(dirname(join(harnessed.rootPath, file.path)), {
      recursive: true,
    });
    await writeFile(join(harnessed.rootPath, file.path), file.text, "utf8");
  }
}

export function scope(harnessed: Harness) {
  return {
    workspaceId: harnessed.workspaceId,
    rootPath: harnessed.rootPath,
    shareViewStore: () => harnessed.store,
  };
}

export function shareViewFilesOwner(
  harnessed: Pick<Harness, "workspaceId" | "rootPath">,
  store: CaptureVersionedTextStore,
) {
  const requested = {
    kind: "standalone" as const,
    workspaceId: harnessed.workspaceId,
  };
  const resolved: ResolvedShareViewFilesTarget = {
    ...requested,
    storeWorkspaceId: harnessed.workspaceId,
    schedulingRootPath: harnessed.rootPath,
    rootPath: harnessed.rootPath,
    shareId: SHARE_ID,
    recipientUserId: "recipient-a",
    granterEmail: "granter@example.com",
    grantedSelector: {
      paths: ["docs"],
      versionId: null,
      access: "edit" as const,
    },
    ended: false,
  };
  return {
    requested,
    files: createShareViewFiles({
      resolveTarget: (candidate) =>
        candidate.kind === requested.kind &&
        candidate.workspaceId === requested.workspaceId
          ? resolved
          : null,
      openStore: () => store,
      resolveRelay: async () => null,
      pull: async () => {
        throw new Error("Unexpected pull");
      },
      recordRefusals: async () => undefined,
      updateUnsavedPaths: async () => { throw new Error("Mounted shares have no unsaved paths"); },
      markEnded: async () => undefined,
      retireTarget: async () => undefined,
      assertProjectionRoot: async () => undefined,
      createMount: async () => undefined,
      removeMount: async () => ({ folderLeft: false }),
    }),
  };
}

export async function settleShareViewThroughOwner(
  harnessed: Pick<Harness, "workspaceId" | "rootPath">,
  store: CaptureVersionedTextStore,
) {
  const owner = shareViewFilesOwner(harnessed, store);
  const outcome = await withStaleSensitiveWorkspaceOperation(
    harnessed.rootPath,
    (lease) => owner.files.reconcile(lease, owner.requested, "settle"),
  );
  if (outcome.kind !== "settle") {
    throw new Error("Share-view settlement returned another operation kind.");
  }
  const { kind: _kind, ...captured } = outcome;
  return captured;
}

export interface StoreMutationBoundaryObservation {
  events: Array<
    "ensure-main" | "list-file-metadata" | "read-text-file" | "replace"
  >;
  replacement: {
    afterEventIndex: number;
    lastContentReadEventIndex: number;
    metadataOnlyPassEventIndex: number;
  } | null;
}

export function storeReplacingLeafAtMutationBoundary(
  store: CaptureVersionedTextStore,
  replace: () => Promise<void>,
): {
  store: CaptureVersionedTextStore;
  observation: StoreMutationBoundaryObservation;
} {
  const observation: StoreMutationBoundaryObservation = {
    events: [],
    replacement: null,
  };
  // Scoped capture reads the tracked content. The move/delete snapshot then
  // lists metadata without reading content. The next metadata list belongs to
  // the file-change primitive, immediately before its final disk-type check.
  let currentPassReadContent = false;
  let currentPassLastMetadataEventIndex: number | null = null;
  let sawContentRead = false;
  let mutationPass = false;
  let metadataOnlyPassEventIndex = -1;
  const proxied = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property === "ensureMainVersion") {
        return async (...args: unknown[]) => {
          mutationPass =
            sawContentRead &&
            currentPassLastMetadataEventIndex !== null &&
            !currentPassReadContent;
          if (mutationPass && currentPassLastMetadataEventIndex !== null) {
            metadataOnlyPassEventIndex = currentPassLastMetadataEventIndex;
          }
          currentPassReadContent = false;
          currentPassLastMetadataEventIndex = null;
          observation.events.push("ensure-main");
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      if (property === "readTextFile") {
        return async (...args: unknown[]) => {
          const result = await (
            value as (...inner: unknown[]) => Promise<unknown>
          ).apply(target, args);
          currentPassReadContent = true;
          sawContentRead = true;
          observation.events.push("read-text-file");
          return result;
        };
      }
      if (property === "listTextFileMetadata") {
        return async (...args: unknown[]) => {
          const result = await (
            value as (...inner: unknown[]) => Promise<unknown>
          ).apply(target, args);
          const afterEventIndex = observation.events.push(
            "list-file-metadata",
          ) - 1;
          currentPassLastMetadataEventIndex = afterEventIndex;
          if (mutationPass && observation.replacement === null) {
            observation.replacement = {
              afterEventIndex,
              lastContentReadEventIndex:
                observation.events.lastIndexOf("read-text-file"),
              metadataOnlyPassEventIndex,
            };
            observation.events.push("replace");
            await replace();
          }
          return result;
        };
      }
      return value;
    },
  }) as CaptureVersionedTextStore;
  return { store: proxied, observation };
}

export function expectLeafReplacementAtMutationBoundary(
  observation: StoreMutationBoundaryObservation,
): void {
  const replacement = observation.replacement;
  expect(replacement).not.toBeNull();
  if (replacement === null) return;
  expect(replacement.lastContentReadEventIndex).toBeGreaterThanOrEqual(0);
  expect(replacement.lastContentReadEventIndex).toBeLessThan(
    replacement.metadataOnlyPassEventIndex,
  );
  expect(replacement.metadataOnlyPassEventIndex).toBeLessThan(
    replacement.afterEventIndex,
  );
  expect({
    contentRead:
      observation.events[replacement.lastContentReadEventIndex],
    metadataOnlyPass:
      observation.events[replacement.metadataOnlyPassEventIndex],
    mutationMetadata: observation.events[replacement.afterEventIndex],
    replacement: observation.events[replacement.afterEventIndex + 1],
  }).toEqual({
    contentRead: "read-text-file",
    metadataOnlyPass: "list-file-metadata",
    mutationMetadata: "list-file-metadata",
    replacement: "replace",
  });
}

export async function applyOwnedShareViewChange(
  input: ReturnType<typeof scope>,
  change: ShareViewFileChange,
): Promise<ShareViewFileChangeValue> {
  const owner = shareViewFilesOwner(input, input.shareViewStore());
  const outcome = await withStaleSensitiveWorkspaceOperation(
    input.rootPath,
    (lease) => owner.files.change(lease, owner.requested, change),
  );
  if (outcome.status !== "committed") throw new Error(outcome.message);
  return outcome.value;
}

export function applyShareViewTextWrite(
  input: ReturnType<typeof scope> & {
    relativePath: string;
    text: string;
    expectedContentHash: string;
  },
) {
  return applyOwnedShareViewChange(input, {
    kind: "save",
    path: input.relativePath,
    text: input.text,
    expectedContentHash: input.expectedContentHash,
  }) as Promise<WorkspaceTextWriteResult>;
}

export function applyShareViewFileCreate(
  input: ReturnType<typeof scope> & {
    relativePath: string;
    initialText: string;
  },
) {
  return applyOwnedShareViewChange(input, {
    kind: "create",
    path: input.relativePath,
    initialText: input.initialText,
  }) as Promise<string>;
}

export function applyShareViewPathMove(
  input: ReturnType<typeof scope> & { fromPath: string; toPath: string },
) {
  return applyOwnedShareViewChange(input, {
    kind: "move",
    fromPath: input.fromPath,
    toPath: input.toPath,
  }) as Promise<string>;
}

export function applyShareViewPathDelete(
  input: ReturnType<typeof scope> & { relativePath: string },
) {
  return applyOwnedShareViewChange(input, {
    kind: "delete",
    path: input.relativePath,
  }) as Promise<{ trashed: boolean }>;
}

export function applyShareViewFileImport(
  input: ReturnType<typeof scope> & {
    absolutePaths: string[];
    screenAgainstRoots: string[] | null;
    targetDir: string | undefined;
  },
) {
  return applyOwnedShareViewChange(input, {
    kind: "import",
    absolutePaths: input.absolutePaths,
    screenAgainstRoots: input.screenAgainstRoots,
    targetDir: input.targetDir,
  }) as Promise<{ imported: string[]; skipped: number }>;
}

/**
 * The same store, with one method made to fail at the Nth call.
 *
 * A mid-apply failure is the case a folder operation cannot test any other
 * way: the engine has to accept some of the files and then refuse one, which
 * no arrangement of inputs produces on demand.
 */
export function storeFailingAt(
  store: CaptureVersionedTextStore,
  method: "renameTextFile" | "deleteTextFile",
  ...calls: number[]
): CaptureVersionedTextStore {
  let seen = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== method || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        seen += 1;
        if (calls.includes(seen)) {
          return Promise.reject(
            new Error(`engine refused ${method} call ${seen}`),
          );
        }
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as CaptureVersionedTextStore;
}

// The move RPC answers when the filesystem changed; the store row settles
// through the capture pipeline afterwards, so an instant read can see both
// case-variants of one entry. Poll for the settled listing — a refused
// rename never reaches it and fails showing the store's actual state.
export function waitForStorePaths(
  harnessed: Harness,
  expected: string[],
  message: string,
): Promise<void> {
  return expect
    .poll(() => storePaths(harnessed), {
      timeout: 30_000,
      interval: 25,
      message,
    })
    .toEqual(expected);
}

export async function storePaths(harnessed: Harness): Promise<string[]> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  const files = await harnessed.store.listTextFileMetadata({
    workspaceId: harnessed.workspaceId,
    versionId: main.id,
  });
  return files.map((file) => file.path).sort();
}

// `replication_log` is what `push_share_ops` scans, so counting its rows is
// the difference between "the engine has the change" and "the recipient can
// send it".
export function replicationLogRows(rootPath: string): number {
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => {
      prepare(sql: string): { get(): Record<string, unknown> | undefined };
      close(): void;
    };
  };
  const database = new DatabaseSync(
    join(rootPath, ".dohc", "engine", "engine.db"),
    {
    readOnly: true,
    },
  );
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS rows FROM replication_log")
      .get();
    return Number(row?.rows ?? 0);
  } finally {
    database.close();
  }
}

// `lstat`, not a read: a DIRECTORY answers a read with EISDIR, so a read-based
// probe reported every existing folder as absent — and a test asserting a
// folder was removed then passed whether or not it was.
export async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

