// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../workspaces/workspaceSettings";
import { DesktopSettings } from "./DesktopSettings";

const config = {
  command: "dohc-mcp",
  args: ["--workspace", "/home/ice/dohc/personal", "--home", "/state/home"],
  workspacePath: "/home/ice/dohc/personal",
  home: "/state/home",
};

let mcpEnabled = false;
let updateReady = false;
const idleUpdateState = {
  status: "idle" as const,
  message: "Updates have not been checked yet.",
  currentVersion: "1.2.3",
  channel: "latest" as const,
  canCheck: true,
  canInstall: false,
};
const readyUpdateState = {
  status: "ready" as const,
  message: "Update 1.2.4 is ready — restart dohc to apply it.",
  currentVersion: "1.2.3",
  channel: "latest" as const,
  canCheck: false,
  canInstall: true,
  version: "1.2.4",
};
type SettingsUpdateState = typeof idleUpdateState | typeof readyUpdateState;
const bridge = {
  getMcpConfig: vi.fn(async () => config),
  getAgentRunStatus: vi.fn(async () => ({
    mcpEnabled,
    activeRun: mcpEnabled ? { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const } : null,
    lastRun: null,
  })),
  startAgentRun: vi.fn(async () => {
    mcpEnabled = true;
    return { id: "run-1", startedAt: 1, agentId: "dohc-mcp", onBehalfOf: "local", status: "running" as const };
  }),
  endAgentRun: vi.fn(async () => {
    mcpEnabled = false;
  }),
  getUpdateState: vi.fn(async () => (updateReady ? readyUpdateState : idleUpdateState)),
  checkForUpdates: vi.fn(async (): Promise<{
    checked: boolean;
    state: SettingsUpdateState;
  }> => {
    updateReady = true;
    return { checked: true, state: readyUpdateState };
  }),
  installUpdate: vi.fn(async (): Promise<{
    accepted: boolean;
    completed: boolean;
    state: SettingsUpdateState;
  }> => ({
    accepted: updateReady,
    completed: false,
    state: updateReady ? readyUpdateState : idleUpdateState,
  })),
  onUpdateState: vi.fn(() => () => {}),
  getUserSettings: vi.fn(async () => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "default" as const,
  })),
  setUserSettings: vi.fn(async (payload: { settings: typeof DEFAULT_USER_SETTINGS }) => ({
    settings: payload.settings,
    source: "stored" as const,
  })),
  resetUserSettings: vi.fn(async () => ({
    settings: DEFAULT_USER_SETTINGS,
    source: "stored" as const,
  })),
  getWorkspaceSettings: vi.fn(async () => ({
    settings: DEFAULT_WORKSPACE_SETTINGS,
    source: "default" as const,
  })),
  setWorkspaceSettings: vi.fn(
    async (payload: { settings: typeof DEFAULT_WORKSPACE_SETTINGS }) => ({
      settings: payload.settings,
      source: "stored" as const,
    }),
  ),
  resetWorkspaceSettings: vi.fn(async () => ({
    settings: DEFAULT_WORKSPACE_SETTINGS,
    source: "stored" as const,
  })),
  writeClipboardText: vi.fn(async (_payload: { text: string }) => undefined),
  setTitlebarTheme: vi.fn(async () => undefined),
};

const writeText = vi.fn(async () => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stubClipboard() {
  // navigator.clipboard is a getter-only property in jsdom; define it. Call
  // AFTER userEvent.setup() so our spy isn't shadowed by userEvent's own stub.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  mcpEnabled = false;
  updateReady = false;
  document.documentElement.dataset.theme = "";
  document.documentElement.dataset.density = "";
  document.documentElement.dataset.reduceMotion = "";
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopSettings", () => {
  it("renders the settings shell, searches sections, and shows an empty search state", async () => {
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    expect(screen.getByTestId("settings-section-general")).toBeTruthy();
    await user.type(screen.getByTestId("settings-search"), "theme");
    expect(screen.getByTestId("settings-section-appearance")).toBeTruthy();
    await user.clear(screen.getByTestId("settings-search"));
    await user.type(screen.getByTestId("settings-search"), "nothing-here");
    expect(screen.getByTestId("settings-empty-search")).toBeTruthy();
  });

  it("persists appearance changes and applies them immediately", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="appearance"
        onClose={() => {}}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Dark" }));
    expect(bridge.setUserSettings).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        appearance: expect.objectContaining({ themeMode: "dark" }),
      }),
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(bridge.setTitlebarTheme).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("shows the workspace path, a copyable MCP config snippet, and usage examples", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/home/ice/dohc/personal"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    const snippet = await screen.findByTestId("mcp-config-snippet");
    // The snippet is the literal config the user pastes into their AI tool.
    expect(snippet.textContent).toContain('"mcpServers"');
    expect(snippet.textContent).toContain("dohc-mcp");
    expect(snippet.textContent).toContain("/home/ice/dohc/personal");
    // Usage examples are present.
    expect(screen.getByText(/Create a finance app/i)).toBeTruthy();
  });

  it("copies the config snippet to the clipboard", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    await screen.findByTestId("mcp-config-snippet");
    await user.click(screen.getByText("Copy"));
    expect(bridge.writeClipboardText).toHaveBeenCalledWith({
      text: expect.stringContaining('"mcpServers"'),
    });
  });

  it("toggles the MCP server on, then reflects running status", async () => {
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
        onAgentActiveChange={onAgentActiveChange}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(true);
  });

  it("disables an enabled server, ending the active run", async () => {
    mcpEnabled = true;
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
        onAgentActiveChange={onAgentActiveChange}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(toggle);
    expect(bridge.endAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1", runId: "run-1" });
    await waitFor(() => expect(onAgentActiveChange).toHaveBeenLastCalledWith(false));
  });

  it("refreshes stale stopped UI before toggling so it cannot disable behind an Enable label", async () => {
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");
    mcpEnabled = true;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toContain("Disable");
  });

  it("refreshes stale running UI before toggling so it cannot enable behind a Disable label", async () => {
    mcpEnabled = true;
    const user = userEvent.setup();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
        initialSection="agents"
        onClose={() => {}}
      />,
    );
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    mcpEnabled = false;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped"),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-enable-toggle").textContent).toContain("Enable");
  });

  it("shows current desktop update version and channel", async () => {
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "idle",
      ),
    );
    expect(screen.getByTestId("desktop-updates-version").textContent).toBe("1.2.3");
    expect(screen.getByTestId("desktop-updates-channel").textContent).toBe("latest");
  });

  it("checks for updates and enables restart when an update is ready", async () => {
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    expect(screen.getByTestId("install-update-button").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows update check failures and re-enables checking", async () => {
    bridge.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toContain(
        "Could not check for updates.",
      ),
    );
    expect(screen.getByTestId("check-updates-button").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shows rejected update checks returned by the main process", async () => {
    bridge.checkForUpdates.mockResolvedValueOnce({
      checked: false,
      state: idleUpdateState,
    });
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toContain(
        "No update check was started.",
      ),
    );
  });

  it("disables update actions while an update check is pending", async () => {
    const pending = deferred<{ checked: boolean; state: typeof readyUpdateState }>();
    bridge.checkForUpdates.mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("desktop-updates-status");

    await user.click(screen.getByTestId("check-updates-button"));

    await waitFor(() =>
      expect(screen.getByTestId("check-updates-button").hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(screen.getByTestId("install-update-button").hasAttribute("disabled")).toBe(
      true,
    );

    pending.resolve({ checked: true, state: readyUpdateState });
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
  });

  it("updates desktop update status from the live update subscription", async () => {
    let pushUpdate: ((state: typeof readyUpdateState) => void) | undefined;
    const onUpdateStateMock = bridge.onUpdateState as unknown as {
      mockImplementationOnce(
        implementation: (
          listener: (state: typeof readyUpdateState) => void,
        ) => () => void,
      ): void;
    };
    onUpdateStateMock.mockImplementationOnce((listener) => {
      pushUpdate = listener;
      return () => undefined;
    });
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "idle",
      ),
    );

    if (!pushUpdate) throw new Error("Update subscription was not registered.");
    pushUpdate(readyUpdateState);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
  });

  it("keeps subscription state when the initial update fetch resolves later", async () => {
    let pushUpdate: ((state: typeof readyUpdateState) => void) | undefined;
    const pending = deferred<typeof idleUpdateState>();
    bridge.getUpdateState.mockImplementationOnce(() => pending.promise);
    const onUpdateStateMock = bridge.onUpdateState as unknown as {
      mockImplementationOnce(
        implementation: (
          listener: (state: typeof readyUpdateState) => void,
        ) => () => void,
      ): void;
    };
    onUpdateStateMock.mockImplementationOnce((listener) => {
      pushUpdate = listener;
      return () => undefined;
    });
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);

    if (!pushUpdate) throw new Error("Update subscription was not registered.");
    pushUpdate(readyUpdateState);
    pending.resolve(idleUpdateState);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );
  });

  it("restarts into a ready update from settings", async () => {
    updateReady = true;
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );

    await user.click(screen.getByTestId("install-update-button"));

    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });

  it("shows rejected restart requests returned by the main process", async () => {
    updateReady = true;
    bridge.installUpdate.mockResolvedValueOnce({
      accepted: false,
      completed: false,
      state: readyUpdateState,
    });
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").getAttribute("data-state")).toBe(
        "ready",
      ),
    );

    await user.click(screen.getByTestId("install-update-button"));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-updates-status").textContent).toContain(
        "Could not restart into the update.",
      ),
    );
  });
});
