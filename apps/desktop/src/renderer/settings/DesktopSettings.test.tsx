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
};

const writeText = vi.fn(async () => {});

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
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("stopped");

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    expect(bridge.startAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("disables an enabled server, ending the active run", async () => {
    mcpEnabled = true;
    const user = userEvent.setup();
    render(<DesktopSettings workspaceId="ws-1" workspacePath="/x" onClose={() => {}} />);
    const toggle = await screen.findByTestId("mcp-enable-toggle");
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"),
    );
    await user.click(toggle);
    expect(bridge.endAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1", runId: "run-1" });
  });
});
