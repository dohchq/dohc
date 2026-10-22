// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuCommand, ShareHandoffStatus, UpdateCheckResult, WorkspaceActivityEvent } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { DesktopRoot } from "./DesktopRoot";
import { COPY_FAILURE } from "./ui/CopyButton";
import type { Workspace } from "./DesktopWorkspaceShell";
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import type { ReactionStore } from "./workbench/reactionStore";
import { deferred, type Deferred } from "../testing/deferred";

const shellRenders = vi.hoisted(() => ({ count: 0 }));
const shellCommits = vi.hoisted(() => ({ onCommit: null as ((workspace: Workspace) => void) | null }));
// The reaction store each mounted shell received from DesktopRoot's owner.
const shellReactions = vi.hoisted(() => ({ current: null as ReactionStore | null }));

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

vi.mock("./DesktopWorkspaceShell", async () => {
  const { useLayoutEffect } = await import("react");
  const { useReactions } = await import("./workbench/reactionStore");
  return { DesktopWorkspaceShell: (props: {
    workspace: Workspace;
    workspaces: Workspace[];
    handoffStatus: ShareHandoffStatus;
    onDismissShareHandoff: () => void;
    onShareHandoffOpened: () => void;
    onSwitchWorkspace: (workspace: Workspace, open?: string | { automationControls: string }) => void;
    openOnReady?: string | { automationControls: string };
  }) => {
    shellRenders.count += 1;
    shellReactions.current = useReactions();
    useLayoutEffect(() => {
      shellCommits.onCommit?.(props.workspace);
    }, [props.workspace]);
    return (
    <div data-testid="workspace-shell">
      <span data-testid="active-workspace">{props.workspace.workspaceId}</span>
      <span data-testid="share-summary">{JSON.stringify(props.workspace.shareView ?? null)}</span>
      <span data-testid="workspace-count">{props.workspaces.length}</span>
      <span data-testid="open-on-ready">{JSON.stringify(props.openOnReady ?? null)}</span>
      {props.workspaces.map((next) => (
        <span key={next.workspaceId}>
          <button type="button" onClick={() => props.onSwitchWorkspace(next)}>
            {`Switch to ${next.workspaceId}`}
          </button>
          <button type="button" onClick={() => props.onSwitchWorkspace(next, "trip/day-1.md")}>
            {`Open a notice in ${next.workspaceId}`}
          </button>
          <button type="button" onClick={() => props.onSwitchWorkspace(next, { automationControls: "collection:tasks#stamp" })}>
            {`Open an automation in ${next.workspaceId}`}
          </button>
        </span>
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
    );
  } };
});

// What DesktopRoot keeps for the window: the notice list, folders a launch
// could not open, and menu commands while no shell answers them. Empty
// unless a test says otherwise.
function windowBridge() {
  return {
    listNotices: vi.fn(async () => ({ account: null, notices: [] })),
    onNoticesChanged: vi.fn(() => () => undefined),
    onWorkspacePathOpenFailed: vi.fn(() => () => undefined),
    takeWorkspacePathOpenFailures: vi.fn(async () => []),
    onMenuCommand: vi.fn(() => () => undefined),
  };
}

function workspace(workspaceId: string): Workspace {
  return {
    workspaceId,
    rootPath: `/tmp/${workspaceId}`,
    kind: "personal",
    mode: "local-first",
  };
}

describe("workspace summary changes", () => {
  function setup() {
    let registry = { workspaces: [workspace("a"), workspace("b")] };
    let emit: ((event: WorkspaceActivityEvent) => void) | undefined;
    const getWorkspaceRegistry = vi.fn(async () => registry);
    vi.stubGlobal("dohcDesktop", {
      ...windowBridge(),
      getWorkspaceRegistry,
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({ settings: DEFAULT_USER_SETTINGS, source: "default" })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn((listener: typeof emit) => { emit = listener; return () => undefined; }),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" })),
    });
    return { getWorkspaceRegistry, emit: (event: WorkspaceActivityEvent) => emit?.(event),
      replace: (next: Workspace[]) => { registry = { workspaces: next }; } };
  }

  it("refreshes the registry for the active summary and skips file activity and other workspaces", async () => {
    const h = setup();
    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    await act(async () => undefined);
    const settled = shellRenders.count;
    await act(async () => {
      h.emit({ workspaceId: "a", paths: ["note.md"] });
      h.emit({ workspaceId: "b", summaryChanged: true });
    });
    expect(h.getWorkspaceRegistry).toHaveBeenCalledOnce();
    expect(shellRenders.count).toBe(settled);
    const shareView = { shareId: "share", granterEmail: "owner@example.test", access: "view" as const,
      ended: true, unsavedPaths: ["locked.md"], unconfirmedChanges: { paths: ["automations.yaml"], unchecked: false, checked: 1 } };
    h.replace([{ ...workspace("a"), shareView }, workspace("unrelated")]);
    await act(async () => h.emit({ workspaceId: "a", summaryChanged: true }));
    expect(JSON.parse(screen.getByTestId("share-summary").textContent!)).toEqual(shareView);
    expect(screen.queryByRole("button", { name: "Switch to b" })).toBeNull();
    expect(screen.getByRole("button", { name: "Switch to unrelated" })).toBeTruthy();
  });

  it("keeps all registry changes when a summary refresh overtakes a full refresh", async () => {
    const h = setup();
    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    const read = deferred<{ workspaces: Workspace[] }>();
    h.getWorkspaceRegistry.mockReturnValueOnce(read.promise);
    act(() => h.emit({}));
    const shareView = { granterEmail: null, ended: true };
    h.replace([{ ...workspace("a"), shareView }, workspace("b"), workspace("c")]);
    await act(async () => h.emit({ workspaceId: "a", summaryChanged: true }));
    await act(async () => read.resolve({ workspaces: [workspace("a"), workspace("b"), workspace("c")] }));
    expect(JSON.parse(screen.getByTestId("share-summary").textContent!)).toEqual(shareView);
    expect(screen.getByRole("button", { name: "Switch to c" })).toBeTruthy();
  });

  it.each(["a", "b"])("accepts a summary during workspace %s's commit before passive effects", async activeId => {
    const h = setup();
    const shareView = { granterEmail: null, ended: true };
    const onCommit = vi.fn((current: Workspace) => {
      if (current.workspaceId !== activeId) return;
      shellCommits.onCommit = null;
      h.replace([{ ...workspace(activeId), shareView }, workspace("c")]);
      // The shell has committed, but the root's activity effect has not run.
      h.emit({ workspaceId: activeId, summaryChanged: true });
    });
    shellCommits.onCommit = onCommit;

    await act(async () => { render(<DesktopRoot />); });
    if (activeId === "b") {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Switch to b" }));
      });
    }

    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: activeId }));
    expect(JSON.parse(screen.getByTestId("share-summary").textContent!)).toEqual(shareView);
    expect(screen.getByRole("button", { name: "Switch to c" })).toBeTruthy();
  });

  it.each([false, true])("retains a pending summary across a switch (return: %s)", async returnToA => {
    const h = setup();
    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    const read = deferred<{ workspaces: Workspace[] }>();
    h.getWorkspaceRegistry.mockReturnValueOnce(read.promise);
    act(() => h.emit({ workspaceId: "a", summaryChanged: true }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to b" }));
    if (returnToA) fireEvent.click(screen.getByRole("button", { name: "Switch to a" }));
    const shareView = { granterEmail: null, ended: true };
    await act(async () => read.resolve({ workspaces: [{ ...workspace("a"), shareView }, workspace("b")] }));
    expect(screen.getByTestId("active-workspace").textContent).toBe(returnToA ? "a" : "b");
    if (!returnToA) {
      expect(screen.getByTestId("share-summary").textContent).toBe("null");
      fireEvent.click(screen.getByRole("button", { name: "Switch to a" }));
    }
    expect(JSON.parse(screen.getByTestId("share-summary").textContent!)).toEqual(shareView);
  });

  it("refreshes the share's shortened recovered-path list", async () => {
    const h = setup();
    const shareView = { granterEmail: null, ended: true, unsavedPaths: ["recovered.md", "locked.md"] };
    h.replace([{ ...workspace("a"), shareView }]);
    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    const recovered = { ...shareView, unsavedPaths: ["locked.md"] };
    h.replace([{ ...workspace("a"), shareView: recovered }]);
    await act(async () => h.emit({ workspaceId: "a", summaryChanged: true }));
    expect(JSON.parse(screen.getByTestId("share-summary").textContent!)).toEqual(recovered);
  });
});

beforeEach(() => {
  // jsdom has no ResizeObserver; the states page measures its sections.
  vi.stubGlobal("ResizeObserver", ObserverStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  shellCommits.onCommit = null;
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
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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

  it("renders the states page at its address only with the dev-tools grant", async () => {
    const stub = (devTools: boolean) => ({
      windowRole: "workspace",
      devTools,
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    window.location.hash = "#/dev/states";
    try {
      vi.stubGlobal("dohcDesktop", stub(false));
      const withoutGrant = render(<DesktopRoot />);
      expect(await screen.findByTestId("first-run")).toBeTruthy();
      expect(screen.queryByTestId("states-page")).toBeNull();
      withoutGrant.unmount();

      vi.stubGlobal("dohcDesktop", stub(true));
      // Await cold transforms before the DOM wait for the granted page starts.
      await import("./dev/StatesPage");
      render(<DesktopRoot />);
      expect(await screen.findByTestId("states-page")).toBeTruthy();
      expect(screen.queryByTestId("first-run")).toBeNull();
    } finally {
      window.location.hash = "";
    }
  });

  it("dismisses a handoff by its visible identity and returns to the ordinary surface", async () => {
    const dismissShareHandoff = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(() => registry.promise),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      ...windowBridge(),
      getWorkspaceRegistry,
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings,
      onAgentColorChanged: vi.fn(() => () => undefined),
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

describe("a settings file save", () => {
  it("restyles the window without rendering the shell when only the look changed", async () => {
    type Read = { settings: typeof DEFAULT_USER_SETTINGS; source: "stored" };
    let onDisk: Read = { settings: DEFAULT_USER_SETTINGS, source: "stored" };
    let settingsChanged: ((result: Read) => void) | null = null;
    const getUserSettings = vi.fn(async () => onDisk);
    vi.stubGlobal("dohcDesktop", {
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [workspace("a")] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings,
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn((callback: typeof settingsChanged) => {
        settingsChanged = callback;
        return () => undefined;
      }),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    const save = async (settings: typeof DEFAULT_USER_SETTINGS) => {
      onDisk = { settings, source: "stored" };
      const reads = getUserSettings.mock.calls.length;
      act(() => settingsChanged?.(onDisk));
      // The broadcast is followed by a backstop read; wait until it lands.
      await waitFor(() => expect(getUserSettings.mock.calls.length).toBe(reads + 1));
      await act(async () => undefined);
    };

    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    await waitFor(() => expect(getUserSettings).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    const settled = shellRenders.count;

    await save({
      ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, accentColor: "#224488" },
      editor: { ...DEFAULT_USER_SETTINGS.editor, fontFamily: "serif", fontSize: 18 },
    });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--dohc-accent")).not.toBe("");
    expect(style.getPropertyValue("--dohc-editor-font-size")).toBe("18px");
    expect(shellRenders.count).toBe(settled);

    // A setting the shell reads renders it.
    await save({ ...onDisk.settings, profile: { preferredName: "Ada" } });
    expect(shellRenders.count).toBeGreaterThan(settled);
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
      ...windowBridge(),
      getWorkspaceRegistry,
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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

describe("registry read failure", () => {
  it("names the file in technical details a person can copy", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      platform: "win32",
      getWorkspaceRegistry: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'desktop:get-workspace-registry': Error [EACCES]: EACCES: permission denied, open 'C:\\dohc\\dohc-workspaces.json'",
        );
      }),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({ settings: DEFAULT_USER_SETTINGS, source: "default" as const })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
      ...windowBridge(),
    });
    render(<DesktopRoot />);

    expect(await screen.findByText("dohc does not have permission to use this file or folder.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("EACCES");
    // The window has no OS title bar, so the screen draws its own drag strip
    // over its top edge without moving the message.
    const page = screen.getByText("dohc couldn't read its workspace registry").parentElement!;
    const strip = page.querySelector<HTMLElement>(":scope > .titlebar-drag");
    expect(page.className).toContain("relative");
    expect(strip?.className).toContain("absolute");
    expect(strip?.style.height).toBe("40px");
    fireEvent.click(screen.getByRole("button", { name: "Show technical details" }));
    const details = screen.getByRole("region", { name: "Technical details" });
    expect(details.textContent).toContain("Cause: Error [EACCES]: EACCES: permission denied, open 'C:\\dohc\\dohc-workspaces.json'");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("dohc-workspaces.json");
  });

  // No workspace shell exists yet, so the screen owns its notices: a copy the
  // clipboard refuses still arrives as a toast with Try again.
  it("reports a refused copy of the technical details as a toast", async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("Document is not focused.");
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      platform: "win32",
      getWorkspaceRegistry: vi.fn(async () => {
        throw new Error("Error invoking remote method 'desktop:get-workspace-registry': Error [EACCES]: EACCES: permission denied");
      }),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({ settings: DEFAULT_USER_SETTINGS, source: "default" as const })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
      ...windowBridge(),
    });
    render(<DesktopRoot />);

    fireEvent.click(await screen.findByRole("button", { name: "Show technical details" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(COPY_FAILURE);
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("registry grows under an idle first-run window", () => {
  it("lists a workspace registered mid-join without leaving the first-run screen", async () => {
    let registry: { workspaces: Workspace[] } = { workspaces: [] };
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => registry),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      rootPath: "/home/sam/dohc/personal",
      kind: "personal" as const,
      mode: "local-first" as const,
    };
    let registry: { workspaces: typeof workspace[] } = { workspaces: [workspace] };
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => registry),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => registry),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
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

describe("reaction writes across first run", () => {
  it("keeps a workspace's write order through first run, and retires its store once settled", async () => {
    let registry = { workspaces: [workspace("a")] };
    let emitActivity: ((event: { workspaceId?: string }) => void) | null = null;
    const writes: Deferred<unknown>[] = [];
    const setChatReaction = vi.fn(() => {
      const write = deferred<unknown>();
      writes.push(write);
      return write.promise;
    });
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => registry),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn((listener: (event: { workspaceId?: string }) => void) => {
        emitActivity = listener;
        return () => undefined;
      }),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
      setChatReaction,
      listChatReactions: vi.fn(async () => ({ reactions: [], viewerAuthorId: "you@x" })),
    });
    const toggle = (store: ReactionStore, nextState: "added" | "removed") =>
      act(() =>
        store.toggle({ threadId: "thread-1", messageId: "m1", emoji: "👍", nextState, viewerAuthorId: "you@x", onError: vi.fn() }),
      );
    const toFirstRun = async () => {
      registry = { workspaces: [] };
      await act(async () => emitActivity?.({}));
      await screen.findByTestId("first-run");
    };
    const reopen = async () => {
      registry = { workspaces: [workspace("a")] };
      await act(async () => emitActivity?.({}));
      fireEvent.click(await screen.findByRole("button", { name: "Open a" }));
      await screen.findByTestId("workspace-shell");
      return shellReactions.current!;
    };
    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    const first = shellReactions.current!;
    toggle(first, "added");

    await toFirstRun();
    const returned = await reopen();
    expect(returned).toBe(first);
    toggle(returned, "removed");
    // The remove waits for the add still out from before first run.
    expect(setChatReaction).toHaveBeenCalledTimes(1);
    await act(async () => {
      writes[0]!.resolve({});
      await writes[0]!.promise;
    });
    await waitFor(() => expect(setChatReaction).toHaveBeenCalledTimes(2));
    await act(async () => {
      writes[1]!.resolve({});
      await writes[1]!.promise;
    });
    await waitFor(() => expect(first.pending("thread-1", "m1")).toBe(false));

    await toFirstRun();
    expect(await reopen()).not.toBe(first);
  });
});

describe("opening a notice in another workspace", () => {
  it("hands the notice's file to that workspace once, and forgets it on the next switch", async () => {
    vi.stubGlobal("dohcDesktop", {
      windowRole: "workspace",
      ...windowBridge(),
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [workspace("a"), workspace("b")] })),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({
        settings: DEFAULT_USER_SETTINGS,
        source: "default" as const,
      })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
    });
    render(<DesktopRoot />);
    expect((await screen.findByTestId("active-workspace")).textContent).toBe("a");

    fireEvent.click(screen.getByRole("button", { name: "Open a notice in b" }));
    expect(screen.getByTestId("active-workspace").textContent).toBe("b");
    expect(screen.getByTestId("open-on-ready").textContent).toBe(JSON.stringify("trip/day-1.md"));

    fireEvent.click(screen.getByRole("button", { name: "Switch to a" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to b" }));
    expect(screen.getByTestId("active-workspace").textContent).toBe("b");
    expect(screen.getByTestId("open-on-ready").textContent).toBe("null");

    // A switched-off automation's switch, asked for from another workspace.
    fireEvent.click(screen.getByRole("button", { name: "Switch to a" }));
    fireEvent.click(screen.getByRole("button", { name: "Open an automation in b" }));
    expect(screen.getByTestId("open-on-ready").textContent).toBe(JSON.stringify({ automationControls: "collection:tasks#stamp" }));
  });
});

describe("the window's title and menu commands", () => {
  function stub(options: {
    windowRole: "workspace" | "manager";
    platform: NodeJS.Platform;
    workspaces: Workspace[];
    registryFails?: boolean;
  }) {
    let menu: ((command: MenuCommand) => void) | null = null;
    const closeThisWindow = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", {
      windowRole: options.windowRole,
      platform: options.platform,
      ...windowBridge(),
      onMenuCommand: vi.fn((listener: (command: MenuCommand) => void) => {
        menu = listener;
        return () => { if (menu === listener) menu = null; };
      }),
      closeThisWindow,
      checkForUpdates: vi.fn(async (): Promise<UpdateCheckResult> => ({
        checked: false, state: { status: "error", message: "This build does not update itself." },
      })),
      getWorkspaceRegistry: vi.fn(async () => {
        if (options.registryFails) throw new Error("dohc could not read dohc-workspaces.json.");
        return { workspaces: options.workspaces };
      }),
      cloudStatus: vi.fn(async () => ({ connected: false })),
      onCloudSessionChanged: vi.fn(() => () => undefined),
      getUserSettings: vi.fn(async () => ({ settings: DEFAULT_USER_SETTINGS, source: "default" as const })),
      onAgentColorChanged: vi.fn(() => () => undefined),
      onUserSettingsChanged: vi.fn(() => () => undefined),
      onWorkspaceActivity: vi.fn(() => () => undefined),
      onWorkspaceActivated: vi.fn(() => () => undefined),
      onShareHandoffStatus: vi.fn(() => () => undefined),
      getShareHandoffStatus: vi.fn(async () => ({ status: "idle" as const })),
      dismissShareHandoff: vi.fn(async () => undefined),
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
    });
    return {
      closeThisWindow,
      send: (command: MenuCommand) => act(() => menu?.(command)),
      listening: () => menu !== null,
    };
  }

  it("names a workspace window after its workspace and leaves menu commands to the shell", async () => {
    const root = stub({ windowRole: "workspace", platform: "darwin", workspaces: [workspace("trip")] });
    render(<DesktopRoot />);
    await screen.findByTestId("workspace-shell");
    // The title follows the workspace in an effect after the shell paints.
    await waitFor(() => expect(document.title).toBe("trip"));
    expect(root.listening()).toBe(false);
  });

  it.each([
    ["first-run", "workspace", []],
    ["manager", "manager", [workspace("trip")]],
  ] as const)("names the %s window dohc", async (_name, windowRole, workspaces) => {
    document.title = "stale";
    stub({ windowRole, platform: "darwin", workspaces: [...workspaces] });
    render(<DesktopRoot />);
    await screen.findByTestId("first-run");
    expect(document.title).toBe("dohc");
  });

  it.each(["darwin", "win32"] as const)("answers menu commands on the registry error screen (%s)", async (platform) => {
    const root = stub({ windowRole: "workspace", platform, workspaces: [], registryFails: true });
    render(<DesktopRoot />);
    await screen.findByText("dohc couldn't read its workspace registry");
    expect(document.title).toBe("dohc");
    // The screen subscribes to menu commands in an effect after it paints.
    await waitFor(() => expect(root.listening()).toBe(true));

    root.send("check-updates");
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("No update check was started.");

    root.send("close-tab");
    expect(root.closeThisWindow).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  });
});
