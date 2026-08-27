// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { DesktopRoot } from "./DesktopRoot";
import type { Workspace } from "./DesktopWorkspaceShell";

vi.mock("./DesktopFirstRun", () => ({
  DesktopFirstRun: () => <div data-testid="first-run" />,
}));

vi.mock("./DesktopWorkspaceShell", () => ({
  DesktopWorkspaceShell: (props: {
    workspace: Workspace;
    workspaces: Workspace[];
  }) => (
    <div data-testid="workspace-shell">
      <span data-testid="active-workspace">{props.workspace.workspaceId}</span>
      <span data-testid="workspace-count">{props.workspaces.length}</span>
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

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
  it("does not let a delayed registry load clobber an activated workspace", async () => {
    const registry = deferred<{ workspaces: Workspace[] }>();
    let activate: ((workspace: Workspace) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
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
