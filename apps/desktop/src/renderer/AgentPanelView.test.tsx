// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPanelSnapshotResult } from "../ipc/bridgeContract";
import { AgentPanelView } from "./AgentPanelView";

const config = {
  command: "dohc-mcp",
  args: ["--workspace", "/home/ice/dohc/personal", "--home", "/state/home"],
  workspacePath: "/home/ice/dohc/personal",
  home: "/state/home",
};

const drivers: AgentPanelSnapshotResult["drivers"] = [
  {
    id: "codex-app-server",
    displayName: "Codex",
    installed: true,
    version: "fake-codex 1.0.0",
    auth: { status: "unknown", label: "CLI login" },
    models: [{ id: "default", name: "Default", planIncluded: true }],
  },
  {
    id: "claude-acp",
    displayName: "Claude",
    installed: false,
    auth: { status: "unknown" },
    models: [],
  },
  {
    id: "generic-acp",
    displayName: "Generic ACP",
    installed: true,
    version: "fake-acp 1.0.0",
    auth: { status: "unknown", label: "CLI login" },
    models: [],
  },
];

let active = false;
let session: AgentPanelSnapshotResult["session"] = null;

function snapshot(): AgentPanelSnapshotResult {
  return { drivers, session };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

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
  probeAgentDrivers: vi.fn(async () => snapshot()),
  getAgentSessionState: vi.fn(async () => snapshot()),
  startAgentSession: vi.fn(async () => {
    active = true;
    session = {
      driverId: "codex-app-server",
      driverName: "Codex",
      status: "waiting-permission",
      startedAt: 1,
      runId: "run-1",
      messages: [{ id: "assistant:1", role: "assistant", text: "Preparing workspace note.\n" }],
      items: [
        {
          id: "cmd-1",
          type: "command",
          title: "Write notes/codex-output.md",
          status: "in_progress",
          locations: [],
        },
      ],
      pendingPermissions: [
        {
          requestId: "perm-1",
          requestType: "command",
          title: "Write notes/codex-output.md",
          detail: "Create the requested note.",
          locations: ["notes/codex-output.md"],
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      ],
      authNotices: [],
    };
    return snapshot();
  }),
  stopAgentSession: vi.fn(async () => {
    active = false;
    if (session) session = { ...session, status: "stopped", pendingPermissions: [] };
    return snapshot();
  }),
  answerAgentPermission: vi.fn(async () => {
    active = false;
    if (session) {
      session = {
        ...session,
        status: "completed",
        messages: [
          ...session.messages,
          { id: "assistant:2", role: "assistant", text: "Done.\n" },
        ],
        items: session.items.map((item) => ({ ...item, status: "completed" as const })),
        pendingPermissions: [],
        authNotices: ["Rate limits updated."],
      };
    }
    return snapshot();
  }),
  startAgentRun: vi.fn(),
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
  session = null;
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AgentPanelView", () => {
  it("lists probed drivers and exposes the workspace-scoped MCP config", async () => {
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
    expect(screen.getAllByTestId("agent-driver-state").map((row) => row.textContent)).toContain(
      "fake-codex 1.0.0",
    );
  });

  it("starts a session, renders permission flow, and reports shell activity", async () => {
    const user = userEvent.setup();
    const onAgentActiveChange = vi.fn();
    render(<AgentPanelView workspaceId="ws-1" onAgentActiveChange={onAgentActiveChange} />);

    await screen.findByTestId("agent-run-toggle");
    await user.clear(screen.getByTestId("agent-prompt-input"));
    await user.type(screen.getByTestId("agent-prompt-input"), "Create a note");
    await user.click(screen.getByTestId("agent-run-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "waiting-permission",
      ),
    );
    expect(bridge.startAgentSession).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      driverId: "codex-app-server",
      prompt: "Create a note",
    });
    expect(screen.getByTestId("agent-stream").textContent).toContain("Preparing workspace note");
    expect(screen.getByTestId("agent-permission-request").textContent).toContain(
      "Write notes/codex-output.md",
    );
    expect(screen.getByTestId("agent-permission-locations").textContent).toContain(
      "notes/codex-output.md",
    );
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByTestId("agent-permission-allow_once"));

    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "completed",
      ),
    );
    expect(bridge.answerAgentPermission).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      requestId: "perm-1",
      decision: "allow_once",
    });
    expect(screen.getByTestId("agent-stream").textContent).toContain("Done.");
    expect(screen.getByTestId("agent-auth-notice").textContent).toContain("Rate limits");
    expect(onAgentActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("stops an active session", async () => {
    const user = userEvent.setup();
    render(<AgentPanelView workspaceId="ws-1" />);

    await screen.findByTestId("agent-run-toggle");
    await user.click(screen.getByTestId("agent-run-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "waiting-permission",
      ),
    );

    await user.click(screen.getByTestId("agent-run-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "stopped",
      ),
    );
    expect(bridge.stopAgentSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("polls active sessions without re-probing provider binaries", async () => {
    const user = userEvent.setup();
    render(<AgentPanelView workspaceId="ws-1" />);

    await screen.findByTestId("agent-run-toggle");
    expect(bridge.probeAgentDrivers).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("agent-run-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "waiting-permission",
      ),
    );
    const stateCalls = bridge.getAgentSessionState.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(bridge.getAgentSessionState.mock.calls.length).toBeGreaterThan(stateCalls);
    expect(bridge.probeAgentDrivers).toHaveBeenCalledTimes(1);
  });

  it("treats a standalone MCP run as active instead of starting a duplicate session", async () => {
    active = true;
    const user = userEvent.setup();
    render(<AgentPanelView workspaceId="ws-1" />);

    const toggle = await screen.findByTestId("agent-run-toggle");
    expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
      "running",
    );
    expect(toggle.textContent).toContain("Stop");

    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId("agent-panel-status").getAttribute("data-state")).toBe(
        "stopped",
      ),
    );
    expect(bridge.startAgentSession).not.toHaveBeenCalled();
    expect(bridge.endAgentRun).toHaveBeenCalledWith({ workspaceId: "ws-1", runId: "run-1" });
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

  it("reports clipboard write failures", async () => {
    const user = userEvent.setup();
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    stubClipboard();
    render(<AgentPanelView workspaceId="ws-1" />);

    await screen.findByTestId("agent-mcp-config");
    await user.click(screen.getByTestId("agent-copy-mcp"));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mcpServers"'));
    expect(screen.getByTestId("agent-panel-message").textContent).toBe(
      "Clipboard denied",
    );
  });

  it("ignores stale initial responses after switching workspaces", async () => {
    const oldRunStatus = deferred<Awaited<ReturnType<typeof bridge.getAgentRunStatus>>>();
    const oldConfig = deferred<Awaited<ReturnType<typeof bridge.getMcpConfig>>>();
    const oldPanel = deferred<AgentPanelSnapshotResult>();
    bridge.getAgentRunStatus
      .mockImplementationOnce(() => oldRunStatus.promise)
      .mockResolvedValueOnce({ mcpEnabled: false, activeRun: null, lastRun: null });
    bridge.getMcpConfig
      .mockImplementationOnce(() => oldConfig.promise)
      .mockResolvedValueOnce({
        ...config,
        args: ["--workspace", "/new"],
        workspacePath: "/new",
      });
    bridge.probeAgentDrivers
      .mockImplementationOnce(() => oldPanel.promise)
      .mockResolvedValueOnce({
        drivers,
        session: {
          driverId: "generic-acp",
          driverName: "Generic ACP",
          status: "running",
          startedAt: 1,
          runId: "new-run",
          messages: [{ id: "new", role: "assistant", text: "new workspace" }],
          items: [],
          pendingPermissions: [],
          authNotices: [],
        },
      });

    const { rerender } = render(<AgentPanelView workspaceId="old-workspace" />);
    rerender(<AgentPanelView workspaceId="new-workspace" />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-mcp-config").textContent).toContain("/new"),
    );
    oldRunStatus.resolve({
      mcpEnabled: true,
      activeRun: {
        id: "old-run",
        startedAt: 1,
        agentId: "dohc-mcp",
        onBehalfOf: "local",
        status: "running",
      },
      lastRun: null,
    });
    oldConfig.resolve({ ...config, args: ["--workspace", "/old"], workspacePath: "/old" });
    oldPanel.resolve({
      drivers,
      session: {
        driverId: "codex-app-server",
        driverName: "Codex",
        status: "waiting-permission",
        startedAt: 1,
        runId: "old-run",
        messages: [{ id: "old", role: "assistant", text: "old workspace" }],
        items: [],
        pendingPermissions: [],
        authNotices: [],
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-mcp-config").textContent).toContain("/new"),
    );
    expect(screen.getByTestId("agent-stream").textContent).toContain("new workspace");
    expect(screen.getByTestId("agent-stream").textContent).not.toContain("old workspace");
  });
});
