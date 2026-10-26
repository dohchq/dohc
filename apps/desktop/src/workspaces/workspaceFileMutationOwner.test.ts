import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ShareViewFileChangeOutcome,
  ShareViewFileChangeValue,
  ShareViewFiles,
} from "./shareViewFiles";
import { readableShareLevel } from "./shareViewMarker";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import {
  createWorkspaceFileMutationOwner,
  type WorkspaceFileMutationYDocPort,
} from "./workspaceFileMutationOwner";
import { deferred } from "../testing/deferred";
import { readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { beginPendingRecovery, waitForRecovery, waitForRecoveryPrune } from "./workspaceDeleteRecovery";
import { openedLocalState } from "../testing/preparedLocalState";

interface TestEvent {
  trusted: boolean;
  authorityId?: symbol;
}

interface TestWorkspace {
  workspaceId: string;
  rootPath: string;
  readOnly?: boolean;
  shareView?: unknown;
  shareMounts?: unknown;
}

type MutationCapture = Pick<WorkspaceEngineCapture, "changePathsAs" | "beginFileRename">;
// What a test gives the harness: changePathsAs settles through this
// settleAndCloseLiveSessionsForPath as the real capture settles first.
type TestCapture = Pick<WorkspaceEngineCapture, "settleAndCloseLiveSessionsForPath"> & Partial<MutationCapture>;

const roots: string[] = [];
const trustedEvent: TestEvent = { trusted: true };
const CONTENT_HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await withExclusiveWorkspaceOperation(root, async () => undefined);
      // A move or delete schedules a prune of old recovery records, which reads the workspace's trash.
      await waitForRecoveryPrune(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function defaultShareChange(
  kind: "save" | "create" | "move" | "delete" | "import",
  value: unknown,
): ShareViewFileChangeOutcome {
  return {
    status: "committed",
    kind,
    value: value as ShareViewFileChangeValue,
    projection: "current",
  };
}

async function harness(options: {
  shareView?: unknown;
  shareMounts?: unknown;
  trashItem?: (path: string) => Promise<void>;
  beforeDocumentMutation?: (
    authorityId: symbol,
    path: string,
  ) => Promise<void>;
  // Runs before the workspace operation admits the change.
  beforeOperation?: () => Promise<void>;
} = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-file-mutations-"));
  roots.push(rootPath);
  const workspace: TestWorkspace = {
    workspaceId: `workspace-${roots.length}`,
    rootPath,
    ...(options.shareView === undefined
      ? {}
      : { shareView: options.shareView }),
    ...(options.shareMounts === undefined
      ? {}
      : { shareMounts: options.shareMounts }),
  };
  let authorityId = Symbol(`attachment:${workspace.workspaceId}`);
  let capture: MutationCapture | null = null;
  let pathChanges: MutationCapture["changePathsAs"];
  const openYDocs: Array<{
    authorityId: symbol;
    path: string;
    markDeleted: () => void;
  }> = [];
  const ownsDocument = vi.fn((candidateAuthorityId: symbol, path: string) =>
    openYDocs.some(
      (session) =>
        session.authorityId === candidateAuthorityId && session.path === path,
    ),
  );
  const withDocumentUnowned: WorkspaceFileMutationYDocPort["withDocumentUnowned"] =
    async <T>(
      candidateAuthorityId: symbol,
      path: string,
      mutation: () => Promise<T>,
    ): Promise<T> => {
      await options.beforeDocumentMutation?.(candidateAuthorityId, path);
      if (ownsDocument(candidateAuthorityId, path)) {
        throw new Error(
          "The engine owns this live document. Close its editor before writing the file directly.",
        );
      }
      return mutation();
    };
  const markDeletedUnderPath = vi.fn<
    WorkspaceFileMutationYDocPort["markDeletedUnderPath"]
  >((candidateAuthorityId, pathOrPrefix) => {
    for (const session of openYDocs) {
      if (
        session.authorityId === candidateAuthorityId &&
        (session.path === pathOrPrefix ||
          session.path.startsWith(`${pathOrPrefix}/`))
      ) {
        session.markDeleted();
      }
    }
  });
  const yDocSessions: WorkspaceFileMutationYDocPort = {
    withDocumentUnowned,
    markDeletedUnderPath,
  };
  const changeImpl: ShareViewFiles["change"] = async (
    _lease,
    _target,
    change,
  ) => {
    switch (change.kind) {
      case "create":
        return defaultShareChange("create", change.path);
      case "move":
        return defaultShareChange("move", change.toPath);
      case "delete":
        return defaultShareChange("delete", { trashed: false });
      case "save":
        return defaultShareChange("save", {
          status: "written",
          contentHash: change.expectedContentHash,
        });
      case "import":
        return defaultShareChange("import", { imported: [], skipped: 0 });
    }
  };
  const change = vi.fn(changeImpl);
  const assertTrustedSender = vi.fn((event: TestEvent) => {
    if (!event.trusted) throw new Error("Untrusted renderer.");
  });
  const requireWorkspace = vi.fn((workspaceId: string) => {
    if (workspaceId !== workspace.workspaceId) {
      throw new Error("This workspace is not open. Open it again.");
    }
    return workspace;
  });
  const notifyRenderer = vi.fn();
  const shareViewEdited = vi.fn();
  const logError = vi.fn();
  const trashItem = vi.fn(
    options.trashItem ??
      (async (path: string) => rm(path, { recursive: true, force: true })),
  );
  const rendererOperationCalls = vi.fn();
  const retirement = new AbortController();
  const withRendererWorkspaceOperation = async <Result>(
    event: TestEvent,
    workspaceId: string,
    work: (authority: {
      authorityId: symbol;
      workspace: Readonly<TestWorkspace>;
      signal: AbortSignal;
      capture: MutationCapture | null;
      yDocSessions: WorkspaceFileMutationYDocPort;
      assertCurrent(): void;
    }) => Promise<Result>,
  ): Promise<Result> => {
    rendererOperationCalls(event, workspaceId);
    // Only a gated test waits; every other change is admitted in its own turn.
    if (options.beforeOperation) await options.beforeOperation();
    if (event.authorityId !== undefined && event.authorityId !== authorityId) {
      throw new Error(
        "File change stopped because this window changed workspaces.",
      );
    }
    return await work({
      authorityId,
      workspace: requireWorkspace(workspaceId),
      signal: retirement.signal,
      capture,
      yDocSessions,
      assertCurrent: () => { if (retirement.signal.aborted || event.authorityId !== undefined && event.authorityId !== authorityId) throw new Error("File change stopped because this window changed workspaces."); },
    });
  };
  let account = "account-alice";
  const deletedBy: string[] = [];
  const history = {readHistoryOperation: vi.fn(async (input: {operationId: string}) => ({operationId: input.operationId, versionId: "main", momentCount: 0, kind: null})),  readHistoryPage: vi.fn(async () => ({ moments: [{ operation: "rename", path: "b.txt", beforePath: "a.txt" }], nextCursor: null }) as never), undoHistoryOperation: vi.fn(async () => { throw new Error("Unexpected Undo"); }) };
  const owner = createWorkspaceFileMutationOwner({
    historyFor: () => history,
    assertTrustedSender,
    withRendererWorkspaceOperation,
    shareViewFiles: { change },
    trashItem,
    localPerson: async () => ({ kind: "human", humanId: account }),
    notifyRenderer,
    shareViewEdited,
    logError,
  });
  return {
    rootPath,
    workspace,
    owner,
    history,
    change,
    assertTrustedSender,
    rendererOperationCalls,
    retirement,
    requireWorkspace,
    notifyRenderer,
    shareViewEdited,
    logError,
    trashItem,
    ownsDocument,
    withDocumentUnowned,
    markDeletedUnderPath,
    deletedBy,
    switchAccount(next: string) {
      account = next;
    },
    get authorityId(): symbol {
      return authorityId;
    },
    registerYDoc(
      path: string,
      markDeleted: () => void,
      sessionAuthorityId = authorityId,
    ) {
      openYDocs.push({
        authorityId: sessionAuthorityId,
        path,
        markDeleted,
      });
    },
    setAuthorityId(next: symbol) {
      authorityId = next;
    },
    get pathChanges() { return pathChanges; },
    setCapture(next: TestCapture | null) {
      if (next === null) { capture = null; return; }
      pathChanges = async (paths, authored, work, removed) => {
          if (authored.author.kind === "human") deletedBy.push(authored.author.humanId);
          const finishDebts = await next.settleAndCloseLiveSessionsForPath(paths[0]!);
          let gone = false;
          try {
            const value = await work({ policy: await readWorkspaceEnginePolicy(rootPath),
              readDuplicate: async () => null, hasPath: async () => false,
      duplicateFile: async () => { throw new Error("unexpected Duplicate"); },
      recordDisk: async (_path, files) => [...files], moveFile: async () => false,
              rename: async () => undefined, delete: async () => "moment", undoDelete: async () => undefined });
            gone = removed(value).length > 0;
            return value;
          } finally {
            finishDebts(gone);
          }
        };
      capture = { changePathsAs: next.changePathsAs ?? pathChanges, beginFileRename: next.beginFileRename ?? (async () => async () => undefined) };
    },
  };
}

function observePathChanges(test: Awaited<ReturnType<typeof harness>>,
  before: (paths: readonly string[]) => Promise<void> = async () => undefined,
  after: () => Promise<void> = async () => undefined): MutationCapture["changePathsAs"] {
  return vi.fn<MutationCapture["changePathsAs"]>(async (paths, authored, work, removed) => {
    await before(paths);
    const value = await test.pathChanges(paths, authored, work, removed);
    await after();
    return value;
  }) as MutationCapture["changePathsAs"];
}

async function openYDoc(
  test: Awaited<ReturnType<typeof harness>>,
  path: string,
  markDeleted = vi.fn(),
) {
  test.registerYDoc(path, markDeleted);
  return { markDeleted };
}

describe("WorkspaceFileMutationOwner", () => {
  it("rejects untrusted Duplicate and forged operation ids before workspace admission", async () => {
    const test = await harness();
    const payload = {workspaceId: test.workspace.workspaceId, relativePath: "source.md"};
    await expect(test.owner.duplicateFile({trusted: false}, payload)).rejects.toThrow("Untrusted renderer");
    await expect(test.owner.duplicateFile(trustedEvent, {...payload, operationId: "dohc-operation:forged"})).rejects.toThrow();
    expect(test.requireWorkspace).not.toHaveBeenCalled();
  });
  it("stops an Undo waiting on system trash when its workspace retires", async () => {
    const test = await harness();
    const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
    const release = beginPendingRecovery(operationId);
    let result: unknown;
    const undo = test.owner.undoHistoryOperation(trustedEvent, { workspaceId: test.workspace.workspaceId, operationId })
      .then(value => { result = value; }, error => { result = { ok: false, reason: error.message }; });
    try {
      await vi.waitFor(() => expect(test.rendererOperationCalls).toHaveBeenCalledOnce());
      expect(result).toBeUndefined();
      test.retirement.abort();
      await vi.waitFor(() => expect(result).toEqual({ ok: false, reason: "This workspace was closed. Open it again." }));
      expect(test.history.readHistoryPage).not.toHaveBeenCalled();
      expect(test.history.undoHistoryOperation).not.toHaveBeenCalled();
    } finally { release(); await undo; }
  });

  it("checks sender trust and payload shape before resolving a workspace", async () => {
    const test = await harness();

    await expect(
      test.owner.createFile(
        { trusted: false },
        {
          workspaceId: test.workspace.workspaceId,
          relativePath: "notes.md",
          initialText: "text",
        },
      ),
    ).rejects.toThrow("Untrusted renderer.");
    expect(test.requireWorkspace).not.toHaveBeenCalled();

    await expect(
      test.owner.createFile(trustedEvent, {
        workspaceId: "",
        relativePath: "notes.md",
        initialText: "text",
      }),
    ).rejects.toThrow();
    expect(test.requireWorkspace).not.toHaveBeenCalled();
  });

  it("rejects every stale renderer mutation before replacement authority is exposed", async () => {
    const test = await harness();
    const staleEvent: TestEvent = {
      trusted: true,
      authorityId: Symbol("attachment-a"),
    };
    const workspaceId = test.workspace.workspaceId;
    const mutations = [
      () => test.owner.duplicateFile(staleEvent, {workspaceId, relativePath: "source.md"}),
      () =>
        test.owner.createFile(staleEvent, {
          workspaceId,
          relativePath: "created.md",
          initialText: "created\n",
        }),
      () =>
        test.owner.createFolder(staleEvent, {
          workspaceId,
          relativePath: "created-folder",
        }),
      () =>
        test.owner.movePath(staleEvent, {
          workspaceId,
          fromPath: "before.md",
          toPath: "after.md",
        }),
      () =>
        test.owner.deletePath(staleEvent, {
          workspaceId,
          relativePath: "deleted.md",
        }),
      () =>
        test.owner.writeText(staleEvent, {
          workspaceId,
          relativePath: "written.md",
          text: "written\n",
          expectedContentHash: CONTENT_HASH,
        }),
      () =>
        test.owner.writeAsset(staleEvent, {
          workspaceId,
          relativePath: "assets/image.png",
          bytes: new Uint8Array([1, 2, 3]),
        }),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toThrow(
        "File change stopped because this window changed workspaces.",
      );
    }

    expect(test.rendererOperationCalls).toHaveBeenCalledTimes(mutations.length);
    expect(test.requireWorkspace).not.toHaveBeenCalled();
    expect(test.ownsDocument).not.toHaveBeenCalled();
    expect(test.change).not.toHaveBeenCalled();
    expect(await readdir(test.rootPath)).toEqual([]);
  });

  it("creates files and folders, writes text, and writes assets locally", async () => {
    const test = await harness();

    await expect(
      test.owner.createFile(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes/a.md",
        initialText: "first\n",
      }),
    ).resolves.toEqual({ path: "notes/a.md" });
    await expect(
      test.owner.createFolder(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "empty/deep",
      }),
    ).resolves.toEqual({ path: "empty/deep" });
    await expect(
      test.owner.writeText(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes/a.md",
        text: "second\n",
        expectedContentHash: hash("first\n"),
      }),
    ).resolves.toEqual({
      status: "written",
      contentHash: hash("second\n"),
    });
    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "assets/pixel.png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toBeUndefined();

    expect(await readFile(join(test.rootPath, "notes/a.md"), "utf8")).toBe(
      "second\n",
    );
    await expect(access(join(test.rootPath, "empty/deep"))).resolves.toBeUndefined();
    expect(await readFile(join(test.rootPath, "assets/pixel.png"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("rejects stale file, folder, text, and asset writes queued behind a change", async () => {
    for (const kind of ["file", "folder", "text", "asset"] as const) {
      const test = await harness();
      if (kind === "text") {
        await writeFile(join(test.rootPath, "existing.md"), "before\n");
      }
      const entered = deferred();
      const release = deferred();
      const blocker = withExclusiveWorkspaceOperation(
        test.rootPath,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;

      const mutation =
        kind === "file"
          ? test.owner.createFile(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              relativePath: "new.md",
              initialText: "new\n",
            })
          : kind === "folder"
            ? test.owner.createFolder(trustedEvent, {
                workspaceId: test.workspace.workspaceId,
                relativePath: "new-folder",
              })
            : kind === "text"
              ? test.owner.writeText(trustedEvent, {
                  workspaceId: test.workspace.workspaceId,
                  relativePath: "existing.md",
                  text: "after\n",
                  expectedContentHash: hash("before\n"),
                })
              : test.owner.writeAsset(trustedEvent, {
                  workspaceId: test.workspace.workspaceId,
                  relativePath: "assets/pixel.png",
                  bytes: new Uint8Array([1, 2, 3]),
                });
      release.resolve();
      await blocker;

      await expect(mutation).rejects.toThrow(
        "A file or folder changed before this write started. Try the action again.",
      );
      if (kind === "text") {
        expect(await readFile(join(test.rootPath, "existing.md"), "utf8")).toBe(
          "before\n",
        );
      } else if (kind === "asset") {
        await expect(
          access(join(test.rootPath, "assets/pixel.png")),
        ).rejects.toThrow();
      }
    }
  });

  it("finishes an admitted text write before a later exclusive operation", async () => {
    const test = await harness();
    await writeFile(join(test.rootPath, "note.md"), "before\n");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const firstError = new Error("exclusive operation failed");
    const firstExclusive = withExclusiveWorkspaceOperation(
      test.rootPath,
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw firstError;
      },
    ).catch((error: unknown) => error);
    await firstEntered.promise;

    const writing = test.owner.writeText(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      relativePath: "note.md",
      text: "after\n",
      expectedContentHash: hash("before\n"),
    });
    const laterExclusive = withExclusiveWorkspaceOperation(
      test.rootPath,
      async () => undefined,
    );

    releaseFirst.resolve();
    await expect(firstExclusive).resolves.toBe(firstError);
    await expect(writing).resolves.toEqual({
      status: "written",
      contentHash: hash("after\n"),
    });
    await laterExclusive;
    expect(await readFile(join(test.rootPath, "note.md"), "utf8")).toBe(
      "after\n",
    );
  });

  it("starts move and delete only after an earlier exclusive operation releases", async () => {
    for (const kind of ["move", "delete"] as const) {
      const test = await harness();
      const source = kind === "move" ? "from.txt" : "delete.txt";
      await writeFile(join(test.rootPath, source), "text\n");
      const trace: string[] = [];
      const entered = deferred();
      const release = deferred();
      const blocker = withExclusiveWorkspaceOperation(
        test.rootPath,
        async () => {
          trace.push("blocker:start");
          entered.resolve();
          await release.promise;
          trace.push("blocker:end");
        },
      );
      await entered.promise;
      test.setCapture({
        settleAndCloseLiveSessionsForPath: vi.fn(async () => {
          trace.push(`${kind}:start`);
          return () => undefined;
        }),
      });

      const mutation =
        kind === "move"
          ? test.owner.movePath(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              fromPath: source,
              toPath: "to.txt",
            })
          : test.owner.deletePath(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              relativePath: source,
            });
      await Promise.resolve();
      expect(trace).toEqual(["blocker:start"]);

      release.resolve();
      await blocker;
      await mutation;
      expect(trace).toEqual([
        "blocker:start",
        "blocker:end",
        `${kind}:start`,
      ]);
      await expect(access(join(test.rootPath, source))).rejects.toThrow();
    }
  });

  it("bumps the workspace generation before a successful rename finisher can fail", async () => {
    const test = await harness();
    await writeFile(join(test.rootPath, "from.md"), "source\n");
    await writeFile(join(test.rootPath, "other.md"), "before\n");
    const finisherEntered = deferred();
    const releaseFinisher = deferred();
    const finisherError = new Error("engine rename finisher failed");
    const finishRename = vi.fn(async (moved: boolean) => {
      if (!moved) return;
      finisherEntered.resolve();
      await releaseFinisher.promise;
      throw finisherError;
    });
    test.setCapture({
      changePathsAs: observePathChanges(test, undefined, () => finishRename(true)),
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });

    const moving = test.owner.movePath(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      fromPath: "from.md",
      toPath: "to.md",
    });
    await finisherEntered.promise;
    const queuedWrite = test.owner.writeText(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      relativePath: "other.md",
      text: "after\n",
      expectedContentHash: hash("before\n"),
    });

    releaseFinisher.resolve();
    await expect(moving).rejects.toThrow(finisherError.message);
    await expect(queuedWrite).rejects.toThrow(
      "A file or folder changed before this write started. Try the action again.",
    );
    expect(finishRename.mock.calls.map(([moved]) => moved)).toEqual([true]);
    expect(await readFile(join(test.rootPath, "to.md"), "utf8")).toBe(
      "source\n",
    );
    expect(await readFile(join(test.rootPath, "other.md"), "utf8")).toBe(
      "before\n",
    );
  });

  it("routes received-share changes through ShareViewFiles", async () => {
    const test = await harness({ shareView: { granterEmail: "owner@example.com" } });

    await expect(
      test.owner.createFile(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "new.txt",
        initialText: "new\n",
      }),
    ).resolves.toEqual({ path: "new.txt" });
    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath: "new.txt",
        toPath: "moved.txt",
      }),
    ).resolves.toEqual({ path: "moved.txt" });
    await expect(
      test.owner.deletePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "moved.txt",
      }),
    ).resolves.toEqual({ trashed: false });
    await expect(
      test.owner.writeText(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes.txt",
        text: "saved\n",
        expectedContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({
      status: "written",
      contentHash: CONTENT_HASH,
    });

    expect(test.change.mock.calls.map((call) => call[2].kind)).toEqual([
      "create",
      "move",
      "delete",
      "save",
    ]);
    // A create and a save are journaled edits the shell pushes; a move and a
    // delete stay for Send changes.
    expect(test.shareViewEdited.mock.calls).toEqual([
      [test.workspace.workspaceId],
      [test.workspace.workspaceId],
    ]);
    for (const [, target] of test.change.mock.calls) {
      expect(target).toEqual({
        kind: "standalone",
        workspaceId: test.workspace.workspaceId,
      });
    }
    expect(await readdir(test.rootPath)).toEqual([]);
  });

  it("refuses empty folders and raw assets in a received share", async () => {
    const test = await harness({ shareView: { granterEmail: "owner@example.com" } });

    await expect(
      test.owner.createFolder(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "empty",
      }),
    ).rejects.toThrow(
      "A shared view can't hold an empty folder. Make a file in the folder you want.",
    );
    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "asset.bin",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow(
      "This is a shared view — ask owner@example.com for changes.",
    );
    expect(test.change).not.toHaveBeenCalled();
  });

  it("routes edit-granted received-share creates and writes without touching disk", async () => {
    const grantedSelector = {
      paths: ["notes.txt"],
      versionId: null,
      access: "edit",
    } as const;
    const test = await harness({
      shareView: {
        granterEmail: "owner@example.com",
        grantedSelector,
      },
    });
    expect(readableShareLevel(grantedSelector)).toBe("edit");

    await expect(
      test.owner.createFile(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "new.txt",
        initialText: "shared\n",
      }),
    ).resolves.toEqual({ path: "new.txt" });
    await expect(
      test.owner.writeText(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes.txt",
        text: "shared\n",
        expectedContentHash: CONTENT_HASH,
      }),
    ).resolves.toEqual({
      status: "written",
      contentHash: CONTENT_HASH,
    });
    await expect(
      test.owner.createFolder(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "empty",
      }),
    ).rejects.toThrow(
      "A shared view can't hold an empty folder. Make a file in the folder you want.",
    );
    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "asset.bin",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow(
      "This is a shared view — ask owner@example.com for changes.",
    );

    expect(test.change.mock.calls.map((call) => call[2].kind)).toEqual([
      "create",
      "save",
    ]);
    expect(await readdir(test.rootPath)).toEqual([]);
  });

  it("refuses moves into or out of a mounted share", async () => {
    const test = await harness({
      shareMounts: [
        {
          shareId: "share-1",
          label: "Team",
          granterEmail: "owner@example.com",
          relayUrl: "https://relay.example.com",
          grantedSelector: { access: "view", kind: "workspace" },
        },
      ],
    });
    await mkdir(join(test.rootPath, "shared-with-me/Team"), { recursive: true });
    await writeFile(
      join(test.rootPath, "shared-with-me/Team/notes.txt"),
      "shared\n",
    );

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath: "shared-with-me/Team/notes.txt",
        toPath: "notes.txt",
      }),
    ).rejects.toThrow(
      "A mounted share is read-only. Move the item somewhere outside the mounted share.",
    );
    await expect(
      access(join(test.rootPath, "shared-with-me/Team/notes.txt")),
    ).resolves.toBeUndefined();
  });

  it("coordinates a stable engine-object rename before moving the file", async () => {
    const test = await harness();
    await writeFile(join(test.rootPath, "from.md"), "text\n");
    const trace: string[] = [];
    const finishRename = vi.fn(async (moved: boolean) => {
      trace.push(`finish:${moved}`);
    });
    const changePathsAs = observePathChanges(test, async ([fromPath = "", toPath = ""]) => {
      trace.push(`begin:${fromPath}:${toPath}`);
      await expect(access(join(test.rootPath, fromPath))).resolves.toBeUndefined();
      await expect(access(join(test.rootPath, toPath))).rejects.toThrow();
    }, () => finishRename(true));
    test.setCapture({
      changePathsAs,
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath: "./from.md",
        toPath: "archive/./to.md",
      }),
    ).resolves.toMatchObject({ path: "archive/to.md", operationId: expect.any(String), undo: { available: true } });

    expect(trace).toEqual([
      "begin:from.md:archive/to.md",
      "finish:true",
    ]);
    expect(await readFile(join(test.rootPath, "archive/to.md"), "utf8")).toBe(
      "text\n",
    );
  });

  it("coordinates an in-workspace alias move by its physical paths", async () => {
    const test = await harness();
    const notesDir = process.platform === "win32" ? "Notes" : "notes";
    await mkdir(join(test.rootPath, notesDir));
    await writeFile(join(test.rootPath, notesDir, "from.md"), "text\n");
    await symlink(
      join(test.rootPath, notesDir),
      join(test.rootPath, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const finishRename = vi.fn(async () => undefined);
    const changePathsAs = observePathChanges(test);
    test.setCapture({
      changePathsAs,
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath:
          process.platform === "win32" ? "alias/FROM.md" : "alias/from.md",
        toPath: "archive/to.md",
      }),
    ).resolves.toMatchObject({ path: "archive/to.md", operationId: expect.any(String), undo: { available: true } });

    expect(changePathsAs).toHaveBeenCalledWith([`${notesDir}/from.md`, "archive/to.md"], expect.objectContaining({ operation: "move" }), expect.any(Function), expect.any(Function));
    await expect(
      readFile(join(test.rootPath, "archive/to.md"), "utf8"),
    ).resolves.toBe("text\n");
  });

  it("returns the workspace-visible spelling for a move through an alias", async () => {
    const test = await harness();
    const notesDir = process.platform === "win32" ? "Notes" : "notes";
    await mkdir(join(test.rootPath, notesDir));
    await writeFile(join(test.rootPath, notesDir, "from.md"), "text\n");
    await symlink(
      join(test.rootPath, notesDir),
      join(test.rootPath, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const finishRename = vi.fn(async () => undefined);
    const changePathsAs = observePathChanges(test);
    test.setCapture({
      changePathsAs,
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath:
          process.platform === "win32" ? "alias/FROM.md" : "alias/from.md",
        toPath: "alias/to.md",
      }),
    ).resolves.toMatchObject({ path: "alias/to.md", operationId: expect.any(String), undo: { available: true } });

    expect(changePathsAs).toHaveBeenCalledWith([`${notesDir}/from.md`, `${notesDir}/to.md`], expect.objectContaining({ operation: "move" }), expect.any(Function), expect.any(Function));
    await expect(
      readFile(join(test.rootPath, notesDir, "to.md"), "utf8"),
    ).resolves.toBe("text\n");
  });

  it("refuses symlinked move endpoints before the engine sees either path", async () => {
    for (const escapedEndpoint of ["source", "destination"] as const) {
      const test = await harness();
      const outside = await mkdtemp(join(tmpdir(), "dohc-file-move-outside-"));
      roots.push(outside);
      await writeFile(join(test.rootPath, "inside.md"), "inside\n");
      await writeFile(join(outside, "outside.md"), "outside\n");
      await symlink(
        outside,
        join(test.rootPath, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const changePathsAs = observePathChanges(test);
      test.setCapture({
        changePathsAs,
        settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
      });

      await expect(
        test.owner.movePath(trustedEvent, {
          workspaceId: test.workspace.workspaceId,
          fromPath:
            escapedEndpoint === "source" ? "escape/outside.md" : "inside.md",
          toPath:
            escapedEndpoint === "destination"
              ? "escape/moved.md"
              : "moved.md",
        }),
      ).rejects.toThrow(/escapes (?:the )?workspace|reserved/);
      expect(changePathsAs).not.toHaveBeenCalled();
      expect(await readFile(join(test.rootPath, "inside.md"), "utf8")).toBe(
        "inside\n",
      );
      expect(await readFile(join(outside, "outside.md"), "utf8")).toBe(
        "outside\n",
      );
    }
  });

  it("refuses a conflicting disk move before starting the engine rename", async () => {
    const test = await harness();
    await writeFile(join(test.rootPath, "from.md"), "source\n");
    await writeFile(join(test.rootPath, "to.md"), "destination\n");
    const finishRename = vi.fn(async () => undefined);
    const changePathsAs = observePathChanges(test);
    test.setCapture({
      changePathsAs,
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath: "from.md",
        toPath: "to.md",
      }),
    ).rejects.toThrow("already exists");

    expect(changePathsAs).not.toHaveBeenCalled();
    expect(finishRename).not.toHaveBeenCalled();
    expect(await readFile(join(test.rootPath, "from.md"), "utf8")).toBe(
      "source\n",
    );
    expect(await readFile(join(test.rootPath, "to.md"), "utf8")).toBe(
      "destination\n",
    );
  });

  it("refuses a live-document kind change before starting an engine rename", async () => {
    const test = await harness();
    await writeFile(join(test.rootPath, "drawing.excalidraw"), "{}\n");
    const changePathsAs = observePathChanges(test);
    test.setCapture({
      changePathsAs,
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath: "drawing.excalidraw",
        toPath: "drawing.md",
      }),
    ).rejects.toThrow(
      "A rename cannot change a live document's kind from scene to richdoc. Create a new file and copy the content instead.",
    );
    expect(changePathsAs).not.toHaveBeenCalled();
  });

  it("refuses a live-document kind change in a received share", async () => {
    const test = await harness({
      shareView: { granterEmail: "owner@example.com" },
    });

    await expect(
      test.owner.movePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        fromPath: "drawing.excalidraw",
        toPath: "drawing.md",
      }),
    ).rejects.toThrow(
      "A rename cannot change a live document's kind from scene to richdoc. Create a new file and copy the content instead.",
    );
    expect(test.change).not.toHaveBeenCalled();
  });

  it("refuses a direct write when the Y.Doc mutation port owns the normalized path", async () => {
    const test = await harness();
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "before\n");
    await openYDoc(test, "notes/a.md");

    await expect(
      test.owner.writeText(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes/./a.md",
        text: "after\n",
        expectedContentHash: hash("before\n"),
      }),
    ).rejects.toThrow(
      "The engine owns this live document. Close its editor before writing the file directly.",
    );
    expect(test.ownsDocument).toHaveBeenCalledWith(
      test.authorityId,
      "notes/a.md",
    );
    expect(test.change).not.toHaveBeenCalled();
    expect(await readFile(join(test.rootPath, "notes/a.md"), "utf8")).toBe(
      "before\n",
    );
  });

  it("isolates Y.Doc ownership between attachments that reuse one workspace id", async () => {
    const test = await harness();
    const attachmentA = test.authorityId;
    const attachmentB = Symbol("attachment-b");
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/write.md"), "before\n");
    await writeFile(join(test.rootPath, "notes/delete.md"), "delete me\n");
    const markDeletedByA = vi.fn();
    test.registerYDoc("notes/write.md", vi.fn(), attachmentA);
    test.registerYDoc("notes/delete.md", markDeletedByA, attachmentA);

    test.setAuthorityId(attachmentB);
    await expect(
      test.owner.writeText(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes/write.md",
        text: "written by b\n",
        expectedContentHash: hash("before\n"),
      }),
    ).resolves.toEqual({
      status: "written",
      contentHash: hash("written by b\n"),
    });
    await expect(
      test.owner.deletePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes/delete.md",
      }),
    ).resolves.toEqual({ trashed: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/u), undo: { available: false, paths: ["notes/delete.md"], reason: `Cannot undo the delete. notes/delete.md is ${process.platform === "win32" ? "in the Recycle Bin" : "in the Trash"}. Restore it there.` } });

    expect(test.ownsDocument).toHaveBeenCalledWith(
      attachmentB,
      "notes/write.md",
    );
    expect(test.markDeletedUnderPath).toHaveBeenCalledWith(
      attachmentB,
      "notes/delete.md",
    );
    expect(markDeletedByA).not.toHaveBeenCalled();
  });

  it("refuses a direct write through an alias to an engine-owned document", async () => {
    const test = await harness();
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "before\n");
    await symlink(
      join(test.rootPath, "notes"),
      join(test.rootPath, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await openYDoc(test, "notes/a.md");

    await expect(
      test.owner.writeText(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "alias/a.md",
        text: "after\n",
        expectedContentHash: hash("before\n"),
      }),
    ).rejects.toThrow("The engine owns this live document");

    expect(test.ownsDocument).toHaveBeenCalledWith(
      test.authorityId,
      "notes/a.md",
    );
    await expect(
      readFile(join(test.rootPath, "notes/a.md"), "utf8"),
    ).resolves.toBe("before\n");
  });

  it("refuses document paths and non-destructive image collisions for asset writes", async () => {
    const test = await harness();
    await mkdir(join(test.rootPath, "assets"));
    await writeFile(join(test.rootPath, "assets/pixel.png"), new Uint8Array([1]));
    await writeFile(join(test.rootPath, "note.md"), "document\n");

    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "note.md",
        bytes: new Uint8Array([2]),
      }),
    ).rejects.toThrow(
      "The attachment path must end with a supported image extension.",
    );
    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "assets/pixel.png",
        bytes: new Uint8Array([2]),
      }),
    ).rejects.toThrow("with different content");
    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "assets/pixel.png",
        bytes: new Uint8Array([1]),
      }),
    ).resolves.toBeUndefined();

    expect(await readFile(join(test.rootPath, "note.md"), "utf8")).toBe(
      "document\n",
    );
    expect(await readFile(join(test.rootPath, "assets/pixel.png"))).toEqual(
      Buffer.from([1]),
    );
  });

  it("refuses an identical asset write through a symlink leaf", async () => {
    const test = await harness();
    await mkdir(join(test.rootPath, "assets"));
    const target = join(test.rootPath, "assets/target.png");
    const alias = join(test.rootPath, "assets/pixel.png");
    await writeFile(target, new Uint8Array([1, 2, 3]));
    await symlink(target, alias);

    await expect(
      test.owner.writeAsset(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "assets/pixel.png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(
      "An image attachment already exists at assets/pixel.png and is not a regular file.",
    );

    expect(test.ownsDocument).toHaveBeenCalledWith(
      test.authorityId,
      "assets/target.png",
    );
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("refuses asset dedup when an alias changes while ownership is queued", async () => {
    const ownershipEntered = deferred();
    const releaseOwnership = deferred();
    const test = await harness({
      beforeDocumentMutation: async () => {
        ownershipEntered.resolve();
        await releaseOwnership.promise;
      },
    });
    await mkdir(join(test.rootPath, "assets"));
    const target = join(test.rootPath, "assets/target.png");
    const alias = join(test.rootPath, "assets/pixel.png");
    await writeFile(target, new Uint8Array([1, 2, 3]));
    await symlink(target, alias);

    const writing = test.owner.writeAsset(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      relativePath: "assets/pixel.png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await ownershipEntered.promise;
    await rm(alias);
    await writeFile(alias, new Uint8Array([9]));
    releaseOwnership.resolve();

    await expect(writing).rejects.toThrow(
      "An image attachment changed at assets/pixel.png before this write could finish. Try the action again.",
    );
    expect(await readFile(alias)).toEqual(Buffer.from([9]));
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("settles Y.Doc work before a recoverable fallback delete, then marks it deleted", async () => {
    const trace: string[] = [];
    const test = await harness({
      trashItem: async () => {
        trace.push("os-trash");
        throw new Error("OS trash unavailable");
      },
    });
    await openedLocalState(test.workspace);
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "text\n");
    const markDeleted = vi.fn(() => trace.push("marked-deleted"));
    await openYDoc(test, "notes/a.md", markDeleted);
    const finishDebts = vi.fn((removed: boolean) => {
      trace.push(`finish-debts:${removed}`);
    });
    test.setCapture({
      settleAndCloseLiveSessionsForPath: vi.fn(async (path) => {
        trace.push(`settle:${path}`);
        return finishDebts;
      }),
    });

    await expect(
      test.owner.deletePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes",
      }),
    ).resolves.toEqual({ trashed: false, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/u), undo: { available: true } });

    expect(trace).toEqual([
      "settle:notes",
      "os-trash",
      "marked-deleted",
      "finish-debts:true",
    ]);
    expect(markDeleted).toHaveBeenCalledOnce();
    await expect(access(join(test.rootPath, "notes"))).rejects.toThrow();
    const trashEntries = await readdir(join(test.rootPath, ".dohc/local/trash"));
    expect(trashEntries.filter(name => name.startsWith("delete-"))).toHaveLength(1);
    expect(trashEntries.filter(name => !name.startsWith("delete-"))).toHaveLength(1);
  });

  it("credits a hand delete to the person who asked while it waits for its workspace", async () => {
    const entered = deferred();
    const release = deferred();
    const test = await harness({
      beforeOperation: async () => { entered.resolve(); await release.promise; },
    });
    await openedLocalState(test.workspace);
    test.setCapture({
      settleAndCloseLiveSessionsForPath: vi.fn(async () => () => undefined),
    });
    await writeFile(join(test.rootPath, "alice.md"), "text\n");
    const deleting = test.owner.deletePath(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      relativePath: "alice.md",
    });
    await entered.promise;
    test.switchAccount("account-bob");
    release.resolve();
    await expect(deleting).resolves.toEqual({ trashed: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/u), undo: { available: true } });
    expect(test.deletedBy).toEqual(["account-alice"]);
  });

  it("still trashes a person's delete recoverably when History is unavailable", async () => {
    const test = await harness({
      trashItem: async () => {
        throw new Error("OS trash unavailable");
      },
    });
    await openedLocalState(test.workspace);
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "text\n");
    // No engine capture: nothing records the delete, and nothing refuses it.
    await expect(test.owner.deletePath(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      relativePath: "notes",
    })).resolves.toEqual({ trashed: false, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/u), undo: { available: true } });
    await expect(access(join(test.rootPath, "notes"))).rejects.toThrow();
    const [entry] = await readdir(join(test.rootPath, ".dohc/local/trash"));
    expect(await readFile(join(test.rootPath, ".dohc/local/trash", entry!, "a.md"), "utf8")).toBe("text\n");
    expect(test.markDeletedUnderPath).toHaveBeenCalledWith(test.authorityId, "notes");
    expect(test.deletedBy).toEqual([]);
  });

  it("settles and marks an alias delete by its physical path", async () => {
    const trace: string[] = [];
    const test = await harness();
    await openedLocalState(test.workspace);
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "text\n");
    await symlink(
      join(test.rootPath, "notes"),
      join(test.rootPath, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const markDeleted = vi.fn(() => trace.push("marked"));
    await openYDoc(test, "notes/a.md", markDeleted);
    const finishDebts = vi.fn((removed: boolean) => {
      trace.push(`finish:${removed}`);
    });
    const settleAndCloseLiveSessionsForPath = vi.fn(async (path: string) => {
      trace.push(`settle:${path}`);
      return finishDebts;
    });
    test.setCapture({
      settleAndCloseLiveSessionsForPath,
    });

    await expect(
      test.owner.deletePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "alias/a.md",
      }),
    ).resolves.toEqual({ trashed: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/u), undo: { available: true } });

    expect(trace).toEqual(["settle:notes/a.md", "marked", "finish:true"]);
    expect(test.markDeletedUnderPath).toHaveBeenCalledWith(
      test.authorityId,
      "notes/a.md",
    );
    await expect(access(join(test.rootPath, "notes/a.md"))).rejects.toThrow();
  });

  it("keeps the file and its session when live delete preflight refuses before trash", async () => {
    const trashItem = vi.fn(async () => undefined);
    const test = await harness({ trashItem });
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "text\n");
    const markDeleted = vi.fn();
    await openYDoc(test, "notes/a.md", markDeleted);
    test.setCapture({
      settleAndCloseLiveSessionsForPath: vi.fn(async () => {
        throw new Error("dohc could not delete notes. This action is unavailable for shared live files.");
      }),
    });
    await expect(test.owner.deletePath(trustedEvent, {
      workspaceId: test.workspace.workspaceId,
      relativePath: "notes",
    })).rejects.toThrow("dohc could not delete notes.");
    expect(trashItem).not.toHaveBeenCalled();
    expect(markDeleted).not.toHaveBeenCalled();
    expect(await readFile(join(test.rootPath, "notes/a.md"), "utf8")).toBe("text\n");
    await expect(access(join(test.rootPath, ".dohc/local/trash"))).rejects.toThrow();
  });

  it("does not mark a Y.Doc deleted when both recovery paths fail", async () => {
    const test = await harness({
      trashItem: async () => {
        throw new Error("OS trash unavailable");
      },
    });
    await mkdir(join(test.rootPath, "notes"));
    await writeFile(join(test.rootPath, "notes/a.md"), "text\n");
    await openedLocalState(test.workspace);
    await writeFile(join(test.rootPath, ".dohc/local/trash"), "not a folder");
    const markDeleted = vi.fn();
    await openYDoc(test, "notes/a.md", markDeleted);
    const finishDebts = vi.fn();
    const settleAndCloseLiveSessionsForPath = vi.fn(async () => finishDebts);
    test.setCapture({
      settleAndCloseLiveSessionsForPath,
    });

    await expect(
      test.owner.deletePath(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "notes/./a.md",
      }),
    ).rejects.toThrow();

    expect(markDeleted).not.toHaveBeenCalled();
    expect(settleAndCloseLiveSessionsForPath).toHaveBeenCalledWith(
      "notes/a.md",
    );
    expect(finishDebts).toHaveBeenCalledWith(false);
    expect(await readFile(join(test.rootPath, "notes/a.md"), "utf8")).toBe(
      "text\n",
    );
  });

  it("validates create, move, delete, and write results from a received share", async () => {
    const cases = [
      {
        result: defaultShareChange("create", { trashed: false }),
        run: async (test: Awaited<ReturnType<typeof harness>>) =>
          test.owner.createFile(trustedEvent, {
            workspaceId: test.workspace.workspaceId,
            relativePath: "new.txt",
            initialText: "new\n",
          }),
        message: "Shared file create returned an invalid result.",
      },
      {
        result: defaultShareChange("move", { trashed: false }),
        run: async (test: Awaited<ReturnType<typeof harness>>) =>
          test.owner.movePath(trustedEvent, {
            workspaceId: test.workspace.workspaceId,
            fromPath: "from.txt",
            toPath: "to.txt",
          }),
        message: "Shared file move returned an invalid result.",
      },
      {
        result: defaultShareChange("delete", "not-a-delete-result"),
        run: async (test: Awaited<ReturnType<typeof harness>>) =>
          test.owner.deletePath(trustedEvent, {
            workspaceId: test.workspace.workspaceId,
            relativePath: "delete.txt",
          }),
        message: "Shared file delete returned an invalid result.",
      },
      {
        result: defaultShareChange("save", "not-a-write-result"),
        run: async (test: Awaited<ReturnType<typeof harness>>) =>
          test.owner.writeText(trustedEvent, {
            workspaceId: test.workspace.workspaceId,
            relativePath: "notes.txt",
            text: "saved\n",
            expectedContentHash: CONTENT_HASH,
          }),
        message: undefined,
      },
    ];

    for (const testCase of cases) {
      const test = await harness({ shareView: {} });
      test.change.mockResolvedValueOnce(testCase.result);
      const result = testCase.run(test);
      if (testCase.message) {
        await expect(result).rejects.toThrow(testCase.message);
      } else {
        await expect(result).rejects.toThrow();
      }
    }
  });

  it("invalidates queued stale work after uncertain or malformed shared structural outcomes", async () => {
    const cases: Array<{
      operation: "move" | "delete";
      outcome: ShareViewFileChangeOutcome;
    }> = [
      {
        operation: "move",
        outcome: {
          status: "partial",
          kind: "move",
          effects: [
            { path: "from.txt", before: "present", after: "absent" },
          ],
          projection: "pending",
          message: "move stopped after changing canonical state",
        },
      },
      {
        operation: "delete",
        outcome: {
          status: "partial",
          kind: "delete",
          effects: [
            { path: "delete.txt", before: "present", after: "absent" },
          ],
          projection: "pending",
          message: "delete stopped after changing canonical state",
        },
      },
      {
        operation: "move",
        outcome: {
          status: "indeterminate",
          kind: "move",
          possibleEffects: [],
          projection: "pending",
          message: "move outcome is unknown",
        },
      },
      {
        operation: "delete",
        outcome: {
          status: "indeterminate",
          kind: "delete",
          possibleEffects: [],
          projection: "pending",
          message: "delete outcome is unknown",
        },
      },
      {
        operation: "move",
        outcome: defaultShareChange("move", { trashed: false }),
      },
      {
        operation: "delete",
        outcome: defaultShareChange("delete", "not-a-delete-result"),
      },
    ];

    for (const testCase of cases) {
      const test = await harness({ shareView: {} });
      const changeEntered = deferred();
      const releaseChange = deferred();
      test.change.mockImplementationOnce(async () => {
        changeEntered.resolve();
        await releaseChange.promise;
        return testCase.outcome;
      });

      const structuralMutation =
        testCase.operation === "move"
          ? test.owner.movePath(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              fromPath: "from.txt",
              toPath: "to.txt",
            })
          : test.owner.deletePath(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              relativePath: "delete.txt",
            });
      await changeEntered.promise;
      const queuedCreate = test.owner.createFile(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "queued.txt",
        initialText: "queued\n",
      });

      releaseChange.resolve();
      await expect(structuralMutation).rejects.toThrow();
      await expect(queuedCreate).rejects.toThrow(
        "A file or folder changed before this write started. Try the action again.",
      );
      expect(test.change).toHaveBeenCalledOnce();
    }
  });

  it("keeps queued work current when a shared structural change proves no effect", async () => {
    for (const operation of ["move", "delete"] as const) {
      const test = await harness({ shareView: {} });
      const changeEntered = deferred();
      const releaseChange = deferred();
      const refusal = new Error("The shared structural change was refused.");
      test.change.mockImplementationOnce(async () => {
        changeEntered.resolve();
        await releaseChange.promise;
        throw refusal;
      });

      const structuralMutation =
        operation === "move"
          ? test.owner.movePath(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              fromPath: "from.txt",
              toPath: "to.txt",
            })
          : test.owner.deletePath(trustedEvent, {
              workspaceId: test.workspace.workspaceId,
              relativePath: "delete.txt",
            });
      await changeEntered.promise;
      const queuedCreate = test.owner.createFile(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "queued.txt",
        initialText: "queued\n",
      });

      releaseChange.resolve();
      await expect(structuralMutation).rejects.toBe(refusal);
      await expect(queuedCreate).resolves.toEqual({ path: "queued.txt" });
      expect(test.change).toHaveBeenCalledTimes(2);
    }
  });

  it("preserves partial and indeterminate shared-change recovery copy", async () => {
    const cases: Array<{
      outcome: ShareViewFileChangeOutcome;
      message: string;
    }> = [
      {
        outcome: {
          status: "partial",
          kind: "create",
          effects: [],
          projection: "pending",
          message: "partial",
        },
        message:
          "Part of the shared file change completed before the operation stopped. Refresh the shared view before you continue.",
      },
      {
        outcome: {
          status: "indeterminate",
          kind: "create",
          possibleEffects: [],
          projection: "pending",
          message: "unknown",
        },
        message:
          "dohc could not confirm whether the shared file changed. Refresh the shared view before you continue.",
      },
    ];

    for (const testCase of cases) {
      const test = await harness({ shareView: {} });
      test.change.mockResolvedValueOnce(testCase.outcome);
      await expect(
        test.owner.createFile(trustedEvent, {
          workspaceId: test.workspace.workspaceId,
          relativePath: "new.txt",
          initialText: "new\n",
        }),
      ).rejects.toThrow(testCase.message);
      expect(test.notifyRenderer).toHaveBeenCalledOnce();
      expect(test.notifyRenderer).toHaveBeenCalledWith(
        test.workspace.workspaceId,
      );
      expect(test.logError).toHaveBeenCalledWith(
        "[desktop] shared file change did not finish cleanly",
        testCase.outcome,
      );
      // An edit that did not finish is not pushed.
      expect(test.shareViewEdited).not.toHaveBeenCalled();
    }
  });

  it("notifies the renderer when a committed shared projection is pending", async () => {
    const test = await harness({ shareView: {} });
    test.change.mockResolvedValueOnce({
      status: "committed",
      kind: "create",
      value: "new.txt",
      projection: "pending",
    });

    await expect(
      test.owner.createFile(trustedEvent, {
        workspaceId: test.workspace.workspaceId,
        relativePath: "new.txt",
        initialText: "new\n",
      }),
    ).resolves.toEqual({ path: "new.txt" });
    expect(test.notifyRenderer).toHaveBeenCalledOnce();
    expect(test.notifyRenderer).toHaveBeenCalledWith(test.workspace.workspaceId);
    expect(test.logError).not.toHaveBeenCalled();
  });
});

it("admits operation Undo through the mutation owner and refuses missing recovery records", async () => {
  const h = await harness();
  const payload = { workspaceId: h.workspace.workspaceId, operationId: "dohc-operation:11111111-1111-4111-8111-111111111111" };
  await expect(h.owner.undoHistoryOperation({ trusted: false }, payload)).rejects.toThrow();
  await expect(h.owner.undoHistoryOperation(trustedEvent, { ...payload, workspaceId: "other" })).rejects.toThrow();
  await expect(h.owner.undoHistoryOperation(trustedEvent, { ...payload, operationId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow();
  expect(h.history.readHistoryPage).not.toHaveBeenCalled();
  const refused = (reason: string) => ({ ok: false, reason, refusal: { code: "unexplained" } });
  expect(await h.owner.undoHistoryOperation(trustedEvent, payload)).toEqual(refused("Cannot undo the rename. Its recovery record is missing or expired. Rename it back yourself."));
  h.history.readHistoryPage.mockResolvedValue({ moments: [{ operation: "delete", path: "a.txt" }], nextCursor: null } as never);
  expect(await h.owner.undoHistoryOperation(trustedEvent, payload)).toEqual(refused("Cannot undo the delete. Its recovery record is missing or expired. Restore files from History, the system trash, or .dohc/local/trash."));
  expect(h.history.undoHistoryOperation).not.toHaveBeenCalled();
  h.workspace.readOnly = true;
  expect(await h.owner.undoHistoryOperation(trustedEvent, payload)).toEqual(refused("History operations require the owning workspace. Open it to continue."));
  h.workspace.readOnly = false;
  h.workspace.shareView = { access: "read-only" };
  expect(await h.owner.undoHistoryOperation(trustedEvent, payload)).toEqual(refused("History operations require the owning workspace. Open it to continue."));
});

it("returns a person's move operation and successfully undoes it without capture", async () => {
  const h = await harness(); await openedLocalState(h.workspace); await writeFile(join(h.rootPath, "before.txt"), "body");
  const moved = await h.owner.movePath(trustedEvent, { workspaceId: h.workspace.workspaceId, fromPath: "before.txt", toPath: "after.txt" });
  expect(moved).toMatchObject({ path: "after.txt", operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
  await waitForRecovery(moved.operationId!);
  expect(await h.owner.undoHistoryOperation(trustedEvent, { workspaceId: h.workspace.workspaceId, operationId: moved.operationId! })).toMatchObject({ ok: true, restored: ["before.txt"], remaining: [] });
  expect(await readFile(join(h.rootPath, "before.txt"), "utf8")).toBe("body");
  expect((await readdir(join(h.rootPath, ".dohc/local/trash"))).filter(name => /^move-[a-f0-9]{64}\.json$/u.test(name))).toHaveLength(1);
});
