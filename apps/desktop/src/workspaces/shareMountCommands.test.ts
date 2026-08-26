import { describe, expect, it, vi } from "vitest";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
} from "@dohc/workspace-contracts/relay";
import {
  withExclusiveWorkspaceOperation,
  type WorkspaceOperationLease,
} from "./workspaceAssets";
import {
  createShareViewFiles,
  ShareViewMountRollbackError,
  type PreparedShareViewFilesMount,
  type ShareViewFiles,
} from "./shareViewFiles";
import type { ShareViewFilesOwnerCapability } from "./shareViewFilesOwner";
import type { ShareMountRecord } from "./registryStore";
import {
  createShareMountCommands,
  type ShareMountCommandDependencies,
} from "./shareMountCommands";

const WORKSPACE = { workspaceId: "workspace-one", rootPath: "C:/workspace-one" };
const SHARE_ID = "11111111-1111-4111-8111-111111111111";
const SHARE_CODE = `dohc-share:${SHARE_ID}:https://relay.example`;
const SELECTOR = {
  paths: ["docs"],
  versionId: null,
  access: "view" as const,
};
const LEASE = {} as WorkspaceOperationLease;
const assertCurrent = () => undefined;

function retiringCaller() {
  let current = true;
  const retired = new Error("retired workspace authority");
  const assertCurrent = () => {
    if (!current) throw retired;
  };
  return {
    retired,
    assertCurrent,
    retire() {
      current = false;
    },
    async invoke<T>(work: () => Promise<T>): Promise<T> {
      assertCurrent();
      const result = await work();
      assertCurrent();
      return result;
    },
  };
}

const LIVE_OWNER_COMPLETE = Symbol("live owner complete");

async function withLiveMountOwner<T>(
  target: PreparedShareViewFilesMount,
  run: (owner: ShareViewFilesOwnerCapability) => Promise<T>,
): Promise<T> {
  let settled:
    | { ok: true; value: T }
    | { ok: false; error: unknown }
    | undefined;
  const files = createShareViewFiles({
    resolveTarget: () => null,
    openStore: () => {
      throw new Error("Live owner test reached the store.");
    },
    resolveRelay: async () => null,
    pull: async () => {
      throw new Error("Live owner test reached relay pull.");
    },
    recordRefusals: async () => undefined,
    markEnded: async () => undefined,
    retireTarget: async () => undefined,
    assertProjectionRoot: async () => undefined,
    createMount: async (owner) => {
      try {
        settled = { ok: true, value: await run(owner) };
      } catch (error) {
        settled = { ok: false, error };
      }
      throw LIVE_OWNER_COMPLETE;
    },
    removeMount: async () => ({ folderLeft: false }),
  });

  try {
    await withExclusiveWorkspaceOperation(
      target.schedulingRootPath,
      (_changed, lease) => files.mount(lease, target),
    );
    throw new Error("Live owner test did not stop after admission.");
  } catch (error) {
    if (error !== LIVE_OWNER_COMPLETE) throw error;
  }
  if (settled === undefined) {
    throw new Error("Live owner test did not invoke its operation.");
  }
  if (!settled.ok) throw settled.error;
  return settled.value;
}

function preparedTarget(
  overrides: Partial<PreparedShareViewFilesMount> = {},
): PreparedShareViewFilesMount {
  return {
    kind: "mount",
    workspaceId: WORKSPACE.workspaceId,
    storeWorkspaceId: "mount-store",
    schedulingRootPath: WORKSPACE.rootPath,
    rootPath: `${WORKSPACE.rootPath}/shared-with-me/alex`,
    shareId: SHARE_ID,
    mountLabel: "alex",
    granterEmail: "alex@example.com",
    relayUrl: "https://relay.example",
    recipientEmail: null,
    grantedSelector: SELECTOR,
    ended: false,
    ...overrides,
  };
}

const CROSS_TARGET_CASES: ReadonlyArray<
  readonly [string, Partial<PreparedShareViewFilesMount>]
> = [
  ["workspaceId", { workspaceId: "workspace-two" }],
  ["storeWorkspaceId", { storeWorkspaceId: "mount-store-two" }],
  ["shareId", { shareId: "22222222-2222-4222-8222-222222222222" }],
  ["mountLabel", { mountLabel: "blair" }],
  ["schedulingRootPath", { schedulingRootPath: "C:/workspace-two" }],
  ["rootPath", { rootPath: "C:/workspace-two/shared-with-me/blair" }],
];

function harness() {
  const events: string[] = [];
  let mounts: ShareMountRecord[] = [];
  let filesLifecycle:
    | ReturnType<typeof createShareMountCommands>["filesLifecycle"]
    | undefined;
  let mountFailure: unknown;
  let removeOutcome: { folderLeft: boolean; error?: unknown } = {
    folderLeft: false,
  };

  const files: ShareViewFiles = {
    mount: vi.fn(async (_lease, target: PreparedShareViewFilesMount) => {
      events.push("files:mount");
      await withLiveMountOwner(target, (owner) =>
        filesLifecycle!.createMount(owner, target),
      );
      if (mountFailure !== undefined) throw mountFailure;
      return {
        status: "updated",
        changedPaths: 2,
      } as Awaited<ReturnType<ShareViewFiles["mount"]>>;
    }),
    reconcile: vi.fn(async () => {
      events.push("files:reconcile");
      return {
        kind: "refresh",
        outcome: { status: "unchanged", changedPaths: 0 },
      } as Awaited<ReturnType<ShareViewFiles["reconcile"]>>;
    }),
    unmount: vi.fn(async (_lease, target) => {
      events.push("files:unmount");
      const mount = mounts.find(
        (candidate) => candidate.shareId === target.shareId,
      )!;
      const active = preparedTarget({
        shareId: mount.shareId,
        mountLabel: mount.label,
        rootPath: `${WORKSPACE.rootPath}/shared-with-me/${mount.label}`,
        granterEmail: mount.granterEmail,
        relayUrl: mount.relayUrl,
        recipientEmail: mount.recipientEmail ?? null,
        grantedSelector: mount.grantedSelector,
        ended: mount.ended === true,
      });
      return withLiveMountOwner(active, (owner) =>
        filesLifecycle!.removeMount(owner, active),
      );
    }),
    change: vi.fn(),
    read: vi.fn(),
    list: vi.fn(),
    projectionStatus: vi.fn(),
  };

  const dependencies: ShareMountCommandDependencies<{ id: string }> = {
    readMounts: () => mounts,
    writeMounts: (_workspaceId, next) => {
      events.push(`registry:${next.length}`);
      mounts = [...next];
    },
    loadCredentials: async () => {
      events.push("credentials");
      return {
        relayUrl: "https://relay.example/",
        token: "token",
        email: "recipient@example.com",
      };
    },
    fetchInfo: async () => {
      events.push("preflight");
      return { granterEmail: "alex@example.com", selector: SELECTOR };
    },
    listDirectory: async () => {
      events.push("disk:names");
      return [];
    },
    withWorkspaceOperation: async (_rootPath, run) => {
      events.push("lease:start");
      const result = await run(LEASE);
      events.push("lease:end");
      return result;
    },
    files: () => files,
    projectionFor: () => ({
      create: async () => {
        events.push("projection:create");
      },
      remove: async () => {
        events.push("projection:remove");
        return removeOutcome;
      },
    }),
    closeRelayWorkspace: async () => {
      events.push("relay:close");
    },
    workspaceSummary: (workspaceId) => {
      events.push("summary");
      return { id: workspaceId };
    },
    refreshNativeWorkspaceSurfaces: () => events.push("native"),
    // The event name carries the scope so every pinned sequence also proves
    // the notify named the HOST workspace, not another one or none.
    notifyRenderer: ({ workspaceId }) => events.push(`notify:${workspaceId}`),
    logError: (_message, _error) => events.push("log"),
  };
  const commands = createShareMountCommands(dependencies);
  filesLifecycle = commands.filesLifecycle;
  return {
    commands,
    dependencies,
    events,
    files,
    get mounts() {
      return mounts;
    },
    set mounts(next: unknown[]) {
      mounts = next as ShareMountRecord[];
    },
    set mountFailure(error: unknown) {
      mountFailure = error;
    },
    set removeOutcome(next: { folderLeft: boolean; error?: unknown }) {
      removeOutcome = next;
    },
  };
}

describe("share mount commands", () => {
  it("holds command admission across relay preflight and leases only local mount work", async () => {
    const h = harness();

    const result = await h.commands.mount({
      workspace: WORKSPACE,
      shareCode: SHARE_CODE,
      assertCurrent,
    });

    expect(result).toEqual({
      workspace: { id: WORKSPACE.workspaceId },
      mount: {
        shareId: SHARE_ID,
        label: "alex",
        status: "updated",
        changedPaths: 2,
      },
    });
    expect(h.events).toEqual([
      "credentials",
      "preflight",
      "lease:start",
      "disk:names",
      "files:mount",
      "projection:create",
      "registry:1",
      "native",
      "notify:workspace-one",
      "summary",
      "lease:end",
    ]);
  });

  it("settles a committed mount before its retired caller is refused", async () => {
    const h = harness();
    const caller = retiringCaller();
    vi.mocked(h.files.mount).mockImplementationOnce(async (_lease, target) => {
      h.events.push("files:mount");
      await withLiveMountOwner(target, (owner) =>
        h.commands.filesLifecycle.createMount(owner, target),
      );
      caller.retire();
      return {
        status: "updated",
        changedPaths: 2,
      } as Awaited<ReturnType<ShareViewFiles["mount"]>>;
    });

    await expect(
      caller.invoke(() =>
        h.commands.mount({
          workspace: WORKSPACE,
          shareCode: SHARE_CODE,
          assertCurrent: caller.assertCurrent,
        }),
      ),
    ).rejects.toBe(caller.retired);

    expect(h.files.unmount).not.toHaveBeenCalled();
    expect(h.mounts).toHaveLength(1);
    expect(h.events).toEqual([
      "credentials",
      "preflight",
      "lease:start",
      "disk:names",
      "files:mount",
      "projection:create",
      "registry:1",
      "native",
      "notify:workspace-one",
      "summary",
      "lease:end",
    ]);
  });

  it("translates a mount failure after retirement and still presents cleanup", async () => {
    const h = harness();
    const caller = retiringCaller();
    vi.mocked(h.files.mount).mockImplementationOnce(async () => {
      h.events.push("files:mount");
      caller.retire();
      throw new ShareUnavailableError();
    });

    await expect(
      h.commands.mount({
        workspace: WORKSPACE,
        shareCode: SHARE_CODE,
        assertCurrent: caller.assertCurrent,
      }),
    ).rejects.toThrow("ended before it could be added");

    expect(h.events).toEqual([
      "credentials",
      "preflight",
      "lease:start",
      "disk:names",
      "files:mount",
      "log",
      "native",
      "notify:workspace-one",
    ]);
  });

  it("rolls back a durable mount when post-commit presentation fails", async () => {
    const h = harness();
    let notifyCalls = 0;
    h.dependencies.notifyRenderer = () => {
      notifyCalls += 1;
      h.events.push(`notify:${notifyCalls}`);
      if (notifyCalls === 1) throw new Error("notify failed");
    };
    const commands = createShareMountCommands(h.dependencies);

    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("Nothing was added");

    expect(h.mounts).toEqual([]);
    expect(h.events).toEqual([
      "credentials",
      "preflight",
      "lease:start",
      "disk:names",
      "files:mount",
      "projection:create",
      "registry:1",
      "native",
      "notify:1",
      "files:unmount",
      "relay:close",
      "projection:remove",
      "registry:0",
      "log",
      "native",
      "notify:2",
    ]);
  });

  it("preserves incomplete post-commit cleanup evidence", async () => {
    const h = harness();
    const cleanupFailure = new Error("folder is busy");
    const nativeFailure = new Error("native refresh failed");
    const notifyFailure = new Error("notify failed");
    const loggedErrors: unknown[] = [];
    h.dependencies.refreshNativeWorkspaceSurfaces = () => {
      throw nativeFailure;
    };
    h.dependencies.notifyRenderer = () => {
      throw notifyFailure;
    };
    h.dependencies.logError = (_message, error) => {
      loggedErrors.push(error);
    };
    h.removeOutcome = { folderLeft: true, error: cleanupFailure };
    const commands = createShareMountCommands(h.dependencies);

    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("cleanup did not finish");

    const rollbackError = loggedErrors.find(
      (error) => error instanceof ShareViewMountRollbackError,
    );
    expect(rollbackError).toBeInstanceOf(ShareViewMountRollbackError);
    expect(
      (rollbackError as ShareViewMountRollbackError).rollbackError,
    ).toBe(cleanupFailure);
    expect(loggedErrors).toContain(notifyFailure);
    expect(loggedErrors).toContain(nativeFailure);
    expect(h.mounts).toEqual([]);
  });

  it("preserves a cleanup error when rollback removed the folder", async () => {
    const h = harness();
    const cleanupFailure = new Error("metadata cleanup failed");
    const loggedErrors: unknown[] = [];
    h.dependencies.refreshNativeWorkspaceSurfaces = () => {
      throw new Error("native refresh failed");
    };
    h.dependencies.logError = (_message, error) => {
      loggedErrors.push(error);
    };
    h.removeOutcome = { folderLeft: false, error: cleanupFailure };
    const commands = createShareMountCommands(h.dependencies);

    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("cleanup did not finish");

    const rollbackError = loggedErrors.find(
      (error) => error instanceof ShareViewMountRollbackError,
    );
    expect(rollbackError).toBeInstanceOf(ShareViewMountRollbackError);
    expect(
      (rollbackError as ShareViewMountRollbackError).rollbackError,
    ).toBe(cleanupFailure);
    expect(h.mounts).toEqual([]);
  });

  it("serializes mount commands before relay preflight", async () => {
    const h = harness();
    let releaseFirst!: () => void;
    const firstPreflight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    h.dependencies.fetchInfo = async () => {
      calls += 1;
      h.events.push(`preflight:${calls}`);
      if (calls === 1) await firstPreflight;
      return { granterEmail: "alex@example.com", selector: SELECTOR };
    };
    const commands = createShareMountCommands(h.dependencies);

    const first = commands.mount({
      workspace: WORKSPACE,
      shareCode: SHARE_CODE,
      assertCurrent,
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = commands.mount({
      workspace: WORKSPACE,
      shareCode: SHARE_CODE,
      assertCurrent,
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("already added");
    expect(calls).toBe(1);
  });

  it("fails closed before relay access for invalid or cross-relay share codes", async () => {
    const invalid = harness();
    await expect(
      invalid.commands.mount({
        workspace: WORKSPACE,
        shareCode: "not-a-code",
        assertCurrent,
      }),
    ).rejects.toThrow("doesn't look like a share code");
    expect(invalid.events).toEqual([]);

    const mismatch = harness();
    mismatch.dependencies.loadCredentials = async () => ({
      relayUrl: "https://other.example",
      token: "token",
      email: null,
    });
    const commands = createShareMountCommands(mismatch.dependencies);
    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("different server");
    expect(mismatch.events).toEqual([]);
  });

  it("refuses a chat-only grant before any local mount work", async () => {
    const h = harness();
    h.dependencies.fetchInfo = async () => {
      h.events.push("preflight");
      return { granterEmail: "alex@example.com", selector: null };
    };
    const commands = createShareMountCommands(h.dependencies);

    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("shared chat channel");
    expect(h.events).toEqual(["credentials", "preflight"]);
  });

  it("reports a mount rollback double failure and still notifies the renderer", async () => {
    const h = harness();
    h.mountFailure = new ShareViewMountRollbackError(
      new Error("pull failed"),
      new Error("remove failed"),
    );

    await expect(
      h.commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("cleanup did not finish");
    expect(h.events.at(-1)).toBe("notify:workspace-one");
  });

  it("does not unmount again when files.mount rejects", async () => {
    const h = harness();
    vi.mocked(h.files.mount).mockImplementationOnce(async () => {
      h.events.push("files:mount");
      throw new Error("pull failed");
    });

    await expect(
      h.commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("Nothing was added");

    expect(h.files.unmount).not.toHaveBeenCalled();
    expect(h.mounts).toEqual([]);
  });

  it("turns registry-write plus projection-remove failure into rollback evidence", async () => {
    const h = harness();
    h.dependencies.writeMounts = () => {
      throw new Error("registry failed");
    };
    h.removeOutcome = { folderLeft: true };
    const commands = createShareMountCommands(h.dependencies);
    const target = preparedTarget();

    await expect(
      withLiveMountOwner(target, (owner) =>
        commands.filesLifecycle.createMount(owner, target),
      ),
    ).rejects.toBeInstanceOf(ShareViewMountRollbackError);
    expect(h.events).toEqual(["projection:create", "projection:remove"]);
  });

  it("does not let relay-close failure skip owner-gated removal or the tombstone", async () => {
    const h = harness();
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
    ];
    h.dependencies.closeRelayWorkspace = async () => {
      h.events.push("relay:close");
      throw new Error("close failed");
    };
    const commands = createShareMountCommands(h.dependencies);

    const target = preparedTarget({ granterEmail: null });
    const result = await withLiveMountOwner(target, (owner) =>
      commands.filesLifecycle.removeMount(owner, target),
    );

    expect(result).toEqual({ folderLeft: false });
    expect(h.mounts).toEqual([]);
    expect(h.events).toEqual([
      "relay:close",
      "log",
      "projection:remove",
      "registry:0",
    ]);
  });

  it("returns the projection error when removal leaves the mount folder", async () => {
    const h = harness();
    const removalError = new Error("folder is busy");
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
    ];
    h.removeOutcome = { folderLeft: true, error: removalError };
    const target = preparedTarget({ granterEmail: null });

    const result = await withLiveMountOwner(target, (owner) =>
      h.commands.filesLifecycle.removeMount(owner, target),
    );

    expect(result).toEqual({ folderLeft: true, error: removalError });
    expect(h.events).toEqual([
      "relay:close",
      "projection:remove",
      "log",
      "registry:0",
    ]);
  });

  it.each(CROSS_TARGET_CASES)(
    "rejects createMount when a live owner belongs to another %s",
    async (_field, overrides) => {
      const h = harness();
      const ownerTarget = preparedTarget();
      const otherTarget = preparedTarget(overrides);

      await expect(
        withLiveMountOwner(ownerTarget, (owner) =>
          h.commands.filesLifecycle.createMount(owner, otherTarget),
        ),
      ).rejects.toThrow("belongs to another target");
      expect(h.events).toEqual([]);
      expect(h.mounts).toEqual([]);
    },
  );

  it.each(CROSS_TARGET_CASES)(
    "rejects removeMount when a live owner belongs to another %s",
    async (_field, overrides) => {
      const h = harness();
      const ownerTarget = preparedTarget();
      const otherTarget = preparedTarget(overrides);

      await expect(
        withLiveMountOwner(ownerTarget, (owner) =>
          h.commands.filesLifecycle.removeMount(owner, otherTarget),
        ),
      ).rejects.toThrow("belongs to another target");
      expect(h.events).toEqual([]);
      expect(h.mounts).toEqual([]);
    },
  );

  it("refreshes usable mounts one lease at a time and contains damaged rows", async () => {
    const h = harness();
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: "alex@example.com",
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
      { shareId: "damaged", label: "../../escape" },
    ];

    const result = await h.commands.refresh({ workspace: WORKSPACE, assertCurrent });

    expect(result.results).toEqual([
      {
        shareId: SHARE_ID,
        label: "alex",
        status: "unchanged",
        changedPaths: 0,
      },
      {
        shareId: "damaged",
        label: "../../escape",
        status: "damaged",
        changedPaths: 0,
      },
    ]);
    expect(h.events).toEqual([
      "lease:start",
      "files:reconcile",
      "lease:end",
      "notify:workspace-one",
    ]);
  });

  it("settles one reconcile but starts no later mount after retirement", async () => {
    const h = harness();
    const caller = retiringCaller();
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
      {
        shareId: "22222222-2222-4222-8222-222222222222",
        label: "blair",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
    ];
    vi.mocked(h.files.reconcile).mockImplementationOnce(async () => {
      h.events.push("files:reconcile");
      caller.retire();
      return {
        kind: "refresh",
        outcome: { status: "updated", changedPaths: 1 },
      } as Awaited<ReturnType<ShareViewFiles["reconcile"]>>;
    });

    await expect(
      h.commands.refresh({
        workspace: WORKSPACE,
        assertCurrent: caller.assertCurrent,
      }),
    ).rejects.toBe(caller.retired);

    expect(h.files.reconcile).toHaveBeenCalledOnce();
    expect(h.events).toEqual([
      "lease:start",
      "files:reconcile",
      "lease:end",
      "notify:workspace-one",
    ]);
  });

  it("does not mask a classified reconcile failure after retirement", async () => {
    const h = harness();
    const caller = retiringCaller();
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
    ];
    vi.mocked(h.files.reconcile).mockImplementationOnce(async () => {
      h.events.push("files:reconcile");
      caller.retire();
      throw new RelayUnauthorizedError();
    });

    await expect(
      h.commands.refresh({
        workspace: WORKSPACE,
        assertCurrent: caller.assertCurrent,
      }),
    ).rejects.toThrow("session expired");
    expect(h.events).toEqual([
      "lease:start",
      "files:reconcile",
      "notify:workspace-one",
    ]);
  });

  it("aborts the refresh on expired credentials but still notifies", async () => {
    const h = harness();
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
    ];
    vi.mocked(h.files.reconcile).mockRejectedValueOnce(
      new RelayUnauthorizedError(),
    );

    await expect(
      h.commands.refresh({ workspace: WORKSPACE, assertCurrent }),
    ).rejects.toThrow(
      "session expired",
    );
    expect(h.events.at(-1)).toBe("notify:workspace-one");
  });

  it("keeps the empty registry tombstone when damaged mounts are removed", async () => {
    const h = harness();
    h.mounts = [
      { shareId: SHARE_ID, label: "../../escape" },
      { shareId: SHARE_ID, label: "duplicate" },
    ];

    const result = await h.commands.unmount({
      workspace: WORKSPACE,
      shareId: SHARE_ID,
      assertCurrent,
    });

    expect(result).toEqual({
      workspace: { id: WORKSPACE.workspaceId },
      folderLeft: true,
    });
    expect(h.mounts).toEqual([]);
    expect(h.events).toEqual([
      "lease:start",
      "relay:close",
      "registry:0",
      "native",
      "notify:workspace-one",
      "summary",
      "lease:end",
    ]);
  });

  it("closes relay state and removes registry ownership even when folder cleanup fails", async () => {
    const h = harness();
    h.mounts = [
      {
        shareId: SHARE_ID,
        label: "alex",
        granterEmail: null,
        relayUrl: "https://relay.example",
        recipientEmail: null,
        grantedSelector: SELECTOR,
      },
    ];
    h.removeOutcome = { folderLeft: true };

    const result = await h.commands.unmount({
      workspace: WORKSPACE,
      shareId: SHARE_ID,
      assertCurrent,
    });

    expect(result.folderLeft).toBe(true);
    expect(h.files.unmount).toHaveBeenCalledWith(LEASE, {
      kind: "mount",
      workspaceId: WORKSPACE.workspaceId,
      shareId: SHARE_ID,
    });
    expect(h.events).toEqual([
      "lease:start",
      "files:unmount",
      "relay:close",
      "projection:remove",
      "registry:0",
      "native",
      "notify:workspace-one",
      "summary",
      "lease:end",
    ]);
    expect(h.mounts).toEqual([]);
  });

  it.each(["registry-only", "usable"] as const)(
    "settles a %s unmount before its retired caller is refused",
    async (kind) => {
      const h = harness();
      const caller = retiringCaller();
      h.mounts =
        kind === "registry-only"
          ? [
              { shareId: SHARE_ID, label: "../../escape" },
              { shareId: SHARE_ID, label: "duplicate" },
            ]
          : [
              {
                shareId: SHARE_ID,
                label: "alex",
                granterEmail: null,
                relayUrl: "https://relay.example",
                recipientEmail: null,
                grantedSelector: SELECTOR,
              },
            ];
      if (kind === "registry-only") {
        h.dependencies.closeRelayWorkspace = async () => {
          h.events.push("relay:close");
          caller.retire();
        };
      } else {
        h.dependencies.projectionFor = () => ({
          create: async () => {
            h.events.push("projection:create");
          },
          remove: async () => {
            h.events.push("projection:remove");
            caller.retire();
            return { folderLeft: false };
          },
        });
      }

      await expect(
        caller.invoke(() =>
          h.commands.unmount({
            workspace: WORKSPACE,
            shareId: SHARE_ID,
            assertCurrent: caller.assertCurrent,
          }),
        ),
      ).rejects.toBe(caller.retired);

      expect(h.mounts).toEqual([]);
      expect(h.events).toEqual(
        kind === "registry-only"
          ? [
              "lease:start",
              "relay:close",
              "registry:0",
              "native",
              "notify:workspace-one",
              "summary",
              "lease:end",
            ]
          : [
              "lease:start",
              "files:unmount",
              "relay:close",
              "projection:remove",
              "registry:0",
              "native",
              "notify:workspace-one",
              "summary",
              "lease:end",
            ],
      );
    },
  );

  it.each([
    {
      caseName: "damaged registry ownership",
      mounts: [
        { shareId: SHARE_ID, label: "../../escape" },
        { shareId: SHARE_ID, label: "duplicate" },
      ],
      folderLeft: true,
    },
    {
      caseName: "a usable mount",
      mounts: [
        {
          shareId: SHARE_ID,
          label: "alex",
          granterEmail: null,
          relayUrl: "https://relay.example",
          recipientEmail: null,
          grantedSelector: SELECTOR,
        },
      ],
      folderLeft: false,
    },
  ] as const)(
    "returns committed unmount success when presenting $caseName fails",
    async ({ mounts, folderLeft }) => {
      const h = harness();
      const nativeFailure = new Error("native refresh failed");
      const notifyFailure = new Error("notify failed");
      const loggedErrors: unknown[] = [];
      h.mounts = [...mounts];
      h.dependencies.refreshNativeWorkspaceSurfaces = () => {
        throw nativeFailure;
      };
      h.dependencies.notifyRenderer = () => {
        throw notifyFailure;
      };
      h.dependencies.logError = (_message, error) => {
        loggedErrors.push(error);
      };

      await expect(
        h.commands.unmount({
          workspace: WORKSPACE,
          shareId: SHARE_ID,
          assertCurrent,
        }),
      ).resolves.toEqual({
        workspace: { id: WORKSPACE.workspaceId },
        ...(folderLeft ? { folderLeft: true } : {}),
      });
      expect(loggedErrors).toEqual([nativeFailure, notifyFailure]);
      expect(h.mounts).toEqual([]);
    },
  );

  it("maps an ended share during mount without leaving success notifications", async () => {
    const h = harness();
    h.dependencies.fetchInfo = async () => {
      throw new ShareUnavailableError();
    };
    const commands = createShareMountCommands(h.dependencies);

    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE, assertCurrent }),
    ).rejects.toThrow("No share matches that code");
    expect(h.events).toEqual(["credentials"]);
  });
});
