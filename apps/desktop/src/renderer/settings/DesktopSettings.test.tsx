// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  checkForUpdates: vi.fn(async () => {
    updateReady = true;
    return { checked: true, state: readyUpdateState };
  }),
  installUpdate: vi.fn(async () => ({
    accepted: updateReady,
    completed: false,
    state: updateReady ? readyUpdateState : idleUpdateState,
  })),
  onUpdateState: vi.fn(() => () => {}),
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
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopSettings", () => {
  it("shows the workspace path, a copyable MCP config snippet, and usage examples", async () => {
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/home/ice/dohc/personal"
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("settings-panel")).toBeTruthy();
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    await screen.findByTestId("mcp-config-snippet");
    await user.click(screen.getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mcpServers"'));
  });

  it("toggles the MCP server on, then reflects running status", async () => {
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(
      <DesktopSettings
        workspaceId="ws-1"
        workspacePath="/x"
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
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
});
