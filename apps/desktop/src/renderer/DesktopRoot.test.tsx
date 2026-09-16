// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { DesktopRoot } from "./DesktopRoot";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";

vi.mock("./WorkspaceManager", () => ({
  WorkspaceManager: (props: {
    workspaces: Workspace[];
    handoffStatus: ShareHandoffStatus;
    onOpenWorkspace: (workspace: Workspace) => void;
    onDismissShareHandoff: () => void;
    onShareHandoffOpened: () => void;
  }) => (
    <div data-testid="first-run">
      {props.workspaces.map((workspace) => (
        <button
          key={workspace.workspaceId}
          type="button"
          onClick={() => props.onOpenWorkspace(workspace)}
        >
          {`Open ${workspace.workspaceId}`}
        </button>
      ))}
      {props.handoffStatus.status !== "idle" ? (
        <span data-testid="handoff-active">{props.handoffStatus.status}</span>
      ) : null}
      <button type="button" onClick={props.onDismissShareHandoff}>
        Dismiss handoff
      </button>
      <button type="button" onClick={props.onShareHandoffOpened}>
        Complete handoff
      </button>
    </div>
  ),
}));

vi.mock("./DesktopWorkspaceShell", () => ({
  DesktopWorkspaceShell: (props: {
    workspace: Workspace;
    workspaces: Workspace[];
    handoffStatus: ShareHandoffStatus;
    onDismissShareHandoff: () => void;
    onShareHandoffOpened: () => void;
  }) => (
    <div data-testid="workspace-shell">
      <span data-testid="active-workspace">{props.workspace.workspaceId}</span>
      <span data-testid="workspace-count">{props.workspaces.length}</span>
      {props.handoffStatus.status !== "idle" ? (
        <span data-testid="handoff-active">{props.handoffStatus.status}</span>
      ) : null}
      <button type="button" onClick={props.onDismissShareHandoff}>
        Dismiss handoff
      </button>
      <button type="button" onClick={props.onShareHandoffOpened}>
        Complete handoff
      </button>
    </div>
  ),
}));

function workspace(workspaceId: string): Workspace {
  return {
    workspaceId,
    rootPath: `/tmp/${workspaceId}`,
    kind: "personal",
    mode: "local-first",
  };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopRoot", () => {
  it("subscribes before the snapshot and does not let an older deferred snapshot beat a newer event", async () => {
    const snapshot = deferred<ShareHandoffStatus>();
    const calls: string[] = [];
    let handoffEvent: ((status: ShareHandoffStatus) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(
        (callback: (status: ShareHandoffStatus) => void) => {
          calls.push("subscribe");
          handoffEvent = callback;
          return () => undefined;
        },
      ),
      getShareHandoffStatus: vi.fn(() => {
        calls.push("snapshot");
        return snapshot.promise;
      }),
      dismissShareHandoff: vi.fn(async () => undefined),
    });

    render(<DesktopRoot />);
    expect(calls).toEqual(["subscribe", "snapshot"]);

    act(() => handoffEvent?.({ status: "redeeming", statusId: "status-new" }));
    await act(async () => {
      snapshot.resolve({ status: "failed-refused", statusId: "status-old" });
    });

    expect((await screen.findByTestId("handoff-active")).textContent).toBe(
      "redeeming",
    );
  });

  it("keeps an idle handoff out of the ordinary first-run product", async () => {
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });

    render(<DesktopRoot />);

    expect(await screen.findByTestId("first-run")).toBeTruthy();
    expect(screen.queryByTestId("handoff-active")).toBeNull();
  });

  it("dismisses a handoff by its visible identity and returns to the ordinary surface", async () => {
    const dismissShareHandoff = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({
        status: "failed-refused" as const,
        statusId: "status-refused",
      })),
      dismissShareHandoff,
    });

    render(<DesktopRoot />);
    await screen.findByTestId("handoff-active");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss handoff" }));

    expect(dismissShareHandoff).toHaveBeenCalledOnce();
    expect(dismissShareHandoff.mock.calls[0]).toEqual([
      { statusId: "status-refused" },
    ]);
    expect(screen.queryByTestId("handoff-active")).toBeNull();
    expect(screen.getByTestId("first-run")).toBeTruthy();
  });

  it("acknowledges a completed handoff once by its visible identity", async () => {
    const dismissShareHandoff = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({
        status: "done" as const,
        statusId: "status-done",
        shareId: "share-exact",
      })),
      dismissShareHandoff,
    });

    render(<DesktopRoot />);
    await screen.findByTestId("handoff-active");
    fireEvent.click(screen.getByRole("button", { name: "Complete handoff" }));

    expect(dismissShareHandoff).toHaveBeenCalledOnce();
    expect(dismissShareHandoff.mock.calls[0]).toEqual([
      { statusId: "status-done" },
    ]);
    expect(screen.queryByTestId("handoff-active")).toBeNull();
  });

  it("keeps handoff B visible while dismissal captured from A is still pending", async () => {
    const dismissal = deferred<void>();
    const dismissShareHandoff = vi.fn(() => dismissal.promise);
    let handoffEvent: ((status: ShareHandoffStatus) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(
        (callback: (status: ShareHandoffStatus) => void) => {
          handoffEvent = callback;
          return () => undefined;
        },
      ),
      getShareHandoffStatus: vi.fn(async () => ({
        status: "failed-network" as const,
        statusId: "status-a",
      })),
      dismissShareHandoff,
    });

    render(<DesktopRoot />);
    await screen.findByTestId("handoff-active");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss handoff" }));

    expect(dismissShareHandoff).toHaveBeenCalledWith({ statusId: "status-a" });
    act(() =>
      handoffEvent?.({ status: "redeeming", statusId: "status-b" }),
    );
    expect(screen.getByTestId("handoff-active").textContent).toBe("redeeming");

    await act(async () => dismissal.resolve());
    expect(screen.getByTestId("handoff-active").textContent).toBe("redeeming");
  });

  it("does not let a delayed registry load clobber an activated workspace", async () => {
    const registry = deferred<{ workspaces: Workspace[] }>();
    let activate: ((workspace: Workspace) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(() => registry.promise),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn((callback: (workspace: Workspace) => void) => {
        activate = callback;
        return () => undefined;
      }),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });

    render(<DesktopRoot />);
    await act(async () => {
      activate?.(workspace("activated"));
      registry.resolve({ workspaces: [workspace("registry-default")] });
    });

    expect((await screen.findByTestId("active-workspace")).textContent).toBe("activated");
    expect(screen.getByTestId("workspace-count").textContent).toBe("2");
  });

  it("keeps global bootstrap reads above workspace switches and revalidates on change events", async () => {
    const workspaces = [workspace("a"), workspace("b")];
    let activate: ((workspace: Workspace) => void) | null = null;
    let settingsChanged:
      | ((result: {
          settings: typeof DEFAULT_USER_SETTINGS;
          source: "default";
        }) => void)
      | null = null;
    let workspaceActivity: ((event: { workspaceId?: string }) => void) | null = null;
    const getWorkspaceRegistry = vi.fn(async () => ({ workspaces }));
    const getUserSettings = vi.fn(async () => ({
      settings: DEFAULT_USER_SETTINGS,
      source: "default" as const,
    }));
    vi.stubGlobal("dohcDesktop", {
      getWorkspaceRegistry,
      getUserSettings,
      onUserSettingsChanged: vi.fn((callback: typeof settingsChanged) => {
        settingsChanged = callback;
        return () => undefined;
      }),
      onWorkspaceActivity: vi.fn((callback: typeof workspaceActivity) => {
        workspaceActivity = callback;
        return () => undefined;
      }),
      onWorkspaceActivated: vi.fn((callback: (workspace: Workspace) => void) => {
        activate = callback;
        return () => undefined;
      }),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });

    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    await waitFor(() => expect(getUserSettings).toHaveBeenCalledTimes(1));
    expect(getWorkspaceRegistry).toHaveBeenCalledTimes(1);

    act(() => activate?.(workspaces[1]!));
    act(() => activate?.(workspaces[0]!));
    expect(getUserSettings).toHaveBeenCalledTimes(1);
    expect(getWorkspaceRegistry).toHaveBeenCalledTimes(1);

    act(() => {
      settingsChanged?.({ settings: DEFAULT_USER_SETTINGS, source: "default" });
      workspaceActivity?.({});
    });
    await waitFor(() => expect(getUserSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getWorkspaceRegistry).toHaveBeenCalledTimes(2));
  });
});

describe("startup selection", () => {
  it("lets an activity refresh that beats the mount read open the first workspace", async () => {
    const startupRead = deferred<{ workspaces: Workspace[] }>();
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    const getWorkspaceRegistry = vi
      .fn(async () => ({ workspaces: [workspace("a")] }))
      .mockReturnValueOnce(startupRead.promise);
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry,
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn((listener: (event: { workspaceId?: string }) => void) => {
        emitActivity = listener;
        return () => undefined;
      }),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    render(<DesktopRoot />);
    expect(getWorkspaceRegistry).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitActivity?.({});
    });
    expect((await screen.findByTestId("active-workspace")).textContent).toBe("a");

    // The mount read lands late and stale: it must not reselect.
    await act(async () => {
      startupRead.resolve({ workspaces: [workspace("b"), workspace("a")] });
    });
    expect(screen.getByTestId("active-workspace").textContent).toBe("a");
  });
});

describe("registry grows under an idle first-run window", () => {
  it("lists a workspace registered mid-join without leaving the first-run screen", async () => {
    let registry: { workspaces: Workspace[] } = { workspaces: [] };
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => registry),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn((listener: (event: { workspaceId?: string }) => void) => {
        emitActivity = listener;
        return () => undefined;
      }),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    render(<DesktopRoot />);
    expect(await screen.findByTestId("first-run")).toBeTruthy();

    // Main registers the joined workspace and broadcasts before populate
    // finishes. The join screen must survive that broadcast.
    registry = { workspaces: [workspace("joined")] };
    await act(async () => {
      emitActivity?.({});
    });
    expect(await screen.findByRole("button", { name: "Open joined" })).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell")).toBeNull();

    // Only an explicit selection activates it.
    fireEvent.click(screen.getByRole("button", { name: "Open joined" }));
    expect((await screen.findByTestId("active-workspace")).textContent).toBe("joined");
  });
});

describe("registry emptied under an open workspace", () => {
  it("drops to first run instead of keeping a shell with nothing to open", async () => {
    const workspace = {
      workspaceId: "ws-1",
      rootPath: "/home/ice/dohc/personal",
      kind: "personal" as const,
      mode: "local-first" as const,
    };
    let registry: { workspaces: typeof workspace[] } = { workspaces: [workspace] };
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => registry),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn((listener: (event: { workspaceId?: string }) => void) => {
        emitActivity = listener;
        return () => undefined;
      }),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    render(<DesktopRoot />);
    expect(await screen.findByTestId("workspace-shell")).toBeTruthy();

    registry = { workspaces: [] };
    await act(async () => {
      emitActivity?.({});
    });
    expect(await screen.findByTestId("first-run")).toBeTruthy();
  });

  it("falls back to a remaining workspace when the open one is forgotten", async () => {
    let registry = { workspaces: [workspace("a"), workspace("b")] };
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      getWorkspaceRegistry: vi.fn(async () => registry),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn((listener: (event: { workspaceId?: string }) => void) => {
        emitActivity = listener;
        return () => undefined;
      }),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    render(<DesktopRoot />);
    expect((await screen.findByTestId("active-workspace")).textContent).toBe("a");

    registry = { workspaces: [workspace("b")] };
    await act(async () => {
      emitActivity?.({});
    });
    expect((await screen.findByTestId("active-workspace")).textContent).toBe("b");
  });
});
