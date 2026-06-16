// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanelView } from "./AgentPanelView";

const config = {
  command: "dohc-mcp",
  args: ["--workspace", "/home/ice/dohc/personal", "--home", "/state/home"],
  workspacePath: "/home/ice/dohc/personal",
  home: "/state/home",
};

let active = false;
const bridge = {
  getMcpConfig: vi.fn(async () => config),
  getAgentRunStatus: vi.fn(async () => ({
    mcpEnabled: active,
    activeRun: active
      ? {
          id: "run-1",
          startedAt: 1,
          agentId: "dohc-mcp",
          onBehalfOf: "local",
          status: "running" as const,
        }
      : null,
    lastRun: null,
  })),
  startAgentRun: vi.fn(async () => {
    active = true;
    return {
      id: "run-1",
      startedAt: 1,
      agentId: "dohc-mcp",
      onBehalfOf: "local",
      status: "running" as const,
    };
  }),
  endAgentRun: vi.fn(async () => {
    active = false;
  }),
};

const writeText = vi.fn(async () => {});

function stubClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  active = false;
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AgentPanelView", () => {
  it("lists agent drivers and exposes the workspace-scoped MCP config", async () => {
    render(<AgentPanelView workspaceId="ws-1" />);

    const configSnippet = await screen.findByTestId("agent-mcp-config");
    expect(configSnippet.textContent).toContain('"mcpServers"');
    expect(configSnippet.textContent).toContain("/home/ice/dohc/personal");
    expect(configSnippet.textContent).toContain("/state/home");
    expect(screen.getAllByTestId("agent-driver-row").map((row) => row.dataset.driverId)).toEqual([
      "codex-app-server",
      "claude-acp",
      "generic-acp",
    ]);
  });

  it("starts and stops a local agent run while reporting shell activity", async () => {
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(<AgentPanelView workspaceId="ws-1" onAgentActiveChange={onAgentActiveChange} />);

    const toggle = await screen.findByTestId("agent-run-toggle");
    expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
      "stopped",
    );

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "running",
      ),
    );
    expect(screen.getByTestId("agent-active-run").textContent).toContain("dohc-mcp");
    expect(bridge.startAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(true);

    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "stopped",
      ),
    );
    expect(bridge.endAgentRun).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      runId: "run-1",
    });
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("refreshes stale stopped UI before toggling so it cannot stop a run behind a Start label", async () => {
    const user = userEvent.setup();
    render(<AgentPanelView workspaceId="ws-1" />);

    const toggle = await screen.findByTestId("agent-run-toggle");
    expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
      "stopped",
    );
    active = true;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "running",
      ),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-run-toggle").textContent).toContain("Stop");
    expect(screen.getByTestId("agent-panel-message").textContent).toBe(
      "Agent status changed. Try again.",
    );
  });

  it("refreshes stale running UI before toggling so it cannot start a run behind a Stop label", async () => {
    active = true;
    const user = userEvent.setup();
    render(<AgentPanelView workspaceId="ws-1" />);

    const toggle = await screen.findByTestId("agent-run-toggle");
    expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
      "running",
    );
    active = false;
    bridge.startAgentRun.mockClear();
    bridge.endAgentRun.mockClear();

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "stopped",
      ),
    );
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-run-toggle").textContent).toContain("Start");
  });

  it("copies the MCP config", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<AgentPanelView workspaceId="ws-1" />);

    await screen.findByTestId("agent-mcp-config");
    await user.click(screen.getByTestId("agent-copy-mcp"));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mcpServers"'));
    expect(screen.getByTestId("agent-panel-message").textContent).toBe("Copied MCP config.");
  });

  it("does not report a successful copy when clipboard access is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(<AgentPanelView workspaceId="ws-1" />);

    await screen.findByTestId("agent-mcp-config");
    await user.click(screen.getByTestId("agent-copy-mcp"));

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-panel-message").textContent).toBe(
      "Clipboard unavailable.",
    );
  });
});
