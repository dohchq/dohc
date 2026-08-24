import { describe, expect, it, vi } from "vitest";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
} from "@dohc/workspace-contracts/relay";
import type { WorkspaceOperationLease } from "./workspaceAssets";
import type {
  PreparedShareViewFilesMount,
  ShareViewFiles,
  ShareViewFilesOwnerCapability,
} from "./shareViewFiles";
import type { ShareMountRecord } from "./registryStore";
import { ShareViewMountRollbackError } from "./shareViewFiles";
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
const OWNER = {} as ShareViewFilesOwnerCapability;

function harness() {
  const events: string[] = [];
  let mounts: ShareMountRecord[] = [];
  let filesLifecycle:
    | ReturnType<typeof createShareMountCommands>["filesLifecycle"]
    | undefined;
  let mountFailure: unknown;
  let removeOutcome: { folderLeft: boolean } = { folderLeft: false };

  const files: ShareViewFiles = {
    mount: vi.fn(async (_lease, target: PreparedShareViewFilesMount) => {
      events.push("files:mount");
      await filesLifecycle!.createMount(OWNER, target);
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
      return filesLifecycle!.removeMount(OWNER, {
        kind: "mount",
        workspaceId: WORKSPACE.workspaceId,
        storeWorkspaceId: "mount-store",
        schedulingRootPath: WORKSPACE.rootPath,
        rootPath: `${WORKSPACE.rootPath}/shared-with-me/${mount.label}`,
        shareId: mount.shareId,
        mountLabel: mount.label,
        granterEmail: mount.granterEmail,
        relayUrl: mount.relayUrl,
        recipientEmail: mount.recipientEmail ?? null,
        grantedSelector: mount.grantedSelector,
        ended: mount.ended === true,
      });
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
    notifyRenderer: () => events.push("notify"),
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
    set removeOutcome(next: { folderLeft: boolean }) {
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
      "notify",
      "summary",
      "lease:end",
    ]);
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
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = commands.mount({
      workspace: WORKSPACE,
      shareCode: SHARE_CODE,
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
      invalid.commands.mount({ workspace: WORKSPACE, shareCode: "not-a-code" }),
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
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE }),
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
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE }),
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
      h.commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE }),
    ).rejects.toThrow("cleanup did not finish");
    expect(h.events.at(-1)).toBe("notify");
  });

  it("turns registry-write plus projection-remove failure into rollback evidence", async () => {
    const h = harness();
    h.dependencies.writeMounts = () => {
      throw new Error("registry failed");
    };
    h.removeOutcome = { folderLeft: true };
    const commands = createShareMountCommands(h.dependencies);
    const target = {
      kind: "mount" as const,
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
    };

    await expect(
      commands.filesLifecycle.createMount(OWNER, target),
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

    const result = await commands.filesLifecycle.removeMount(OWNER, {
      kind: "mount",
      workspaceId: WORKSPACE.workspaceId,
      storeWorkspaceId: "mount-store",
      schedulingRootPath: WORKSPACE.rootPath,
      rootPath: `${WORKSPACE.rootPath}/shared-with-me/alex`,
      shareId: SHARE_ID,
      mountLabel: "alex",
      granterEmail: null,
      relayUrl: "https://relay.example",
      recipientEmail: null,
      grantedSelector: SELECTOR,
      ended: false,
    });

    expect(result).toEqual({ folderLeft: false });
    expect(h.mounts).toEqual([]);
    expect(h.events).toEqual([
      "relay:close",
      "log",
      "projection:remove",
      "registry:0",
    ]);
  });

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

    const result = await h.commands.refresh({ workspace: WORKSPACE });

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
      "notify",
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

    await expect(h.commands.refresh({ workspace: WORKSPACE })).rejects.toThrow(
      "session expired",
    );
    expect(h.events.at(-1)).toBe("notify");
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
      "notify",
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
      "notify",
      "summary",
      "lease:end",
    ]);
    expect(h.mounts).toEqual([]);
  });

  it("maps an ended share during mount without leaving success notifications", async () => {
    const h = harness();
    h.dependencies.fetchInfo = async () => {
      throw new ShareUnavailableError();
    };
    const commands = createShareMountCommands(h.dependencies);

    await expect(
      commands.mount({ workspace: WORKSPACE, shareCode: SHARE_CODE }),
    ).rejects.toThrow("No share matches that code");
    expect(h.events).toEqual(["credentials"]);
  });
});
