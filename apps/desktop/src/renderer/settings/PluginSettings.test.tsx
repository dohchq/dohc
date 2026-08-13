// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginStatusChangedEvent,
  PluginStatusRecord,
  PluginUninstallPreflightRecord,
} from "../../ipc/bridgeContract";
import { PluginSettings } from "./PluginSettings";

let statusListener: ((event: PluginStatusChangedEvent) => void) | null = null;

const bridgeMock = {
  listPlugins: vi.fn(),
  installPlugin: vi.fn(),
  disablePlugin: vi.fn(),
  enablePlugin: vi.fn(),
  approvePlugin: vi.fn(),
  pluginUninstallPreflight: vi.fn(),
  uninstallPlugin: vi.fn(),
  onPluginStatusChanged: vi.fn(
    (listener: (event: PluginStatusChangedEvent) => void) => {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    },
  ),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function plugin(
  id: string,
  overrides: Partial<PluginStatusRecord> = {},
): PluginStatusRecord {
  return {
    id,
    directoryName: id,
    rootPath: `/workspace/plugins/${id}`,
    valid: true,
    status: "ready",
    disabledReason: null,
    runtimeStatus: "ready",
    sourceHash: HASH_A,
    approvedHash: HASH_A,
    installedBaselineHash: HASH_A,
    diagnostics: [],
    warnings: [],
    error: null,
    ...overrides,
  };
}

const cleanPreflight: PluginUninstallPreflightRecord = {
  verification: "verified",
  installedBaselineHash: HASH_A,
  liveHash: HASH_A,
  baselineManifestPath: "/state/plugin-baseline.json",
  summary: "No local source modifications found.",
  counts: {
    unchanged: 1,
    modified: 0,
    addedSinceBaseline: 0,
    removedSinceBaseline: 0,
    unknownWithoutBaseline: 0,
    capturedRecoverable: 0,
    notRecoverableFromHistory: 0,
  },
  files: [],
  notRecoverablePaths: [],
  warning: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  statusListener = null;
  bridgeMock.onPluginStatusChanged.mockImplementation((listener) => {
    statusListener = listener;
    return () => {
      statusListener = null;
    };
  });
  bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [] });
  bridgeMock.pluginUninstallPreflight.mockResolvedValue({
    ok: true,
    confirmationToken: "00000000-0000-4000-8000-000000000001",
    preflight: cleanPreflight,
  });
});

afterEach(() => {
  cleanup();
});

describe("PluginSettings", () => {
  it("drops a stale plugin list after switching workspaces", async () => {
    const oldList = deferred<{
      ok: true;
      plugins: PluginStatusRecord[];
    }>();
    const newList = deferred<{
      ok: true;
      plugins: PluginStatusRecord[];
    }>();
    bridgeMock.listPlugins.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === "ws-old" ? oldList.promise : newList.promise,
    );

    const view = render(<PluginSettings workspaceId="ws-old" />);
    expect(bridgeMock.listPlugins).toHaveBeenCalledWith({ workspaceId: "ws-old" });

    view.rerender(<PluginSettings workspaceId="ws-new" />);
    expect(bridgeMock.listPlugins).toHaveBeenCalledWith({ workspaceId: "ws-new" });

    await act(async () => {
      newList.resolve({ ok: true, plugins: [plugin("new-plugin")] });
      await newList.promise;
    });
    expect(await screen.findByText("new-plugin")).toBeTruthy();

    await act(async () => {
      oldList.resolve({ ok: true, plugins: [plugin("old-plugin")] });
      await oldList.promise;
    });
    expect(screen.queryByText("old-plugin")).toBeNull();
    expect(screen.getByText("new-plugin")).toBeTruthy();

    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-old",
        plugin: plugin("old-status-plugin"),
      });
    });
    expect(screen.queryByText("old-status-plugin")).toBeNull();
  });

  it("sends the workspace and plugin id for every action", async () => {
    const fresh = plugin("fresh-plugin", {
      status: "discovered",
      runtimeStatus: null,
      sourceHash: null,
      approvedHash: null,
      installedBaselineHash: null,
    });
    const ready = plugin("ready-plugin");
    const disabled = plugin("disabled-plugin", {
      status: "disabled",
      disabledReason: "user",
      runtimeStatus: null,
    });
    const approval = plugin("approval-plugin", {
      status: "disabled-pending-approval",
      disabledReason: "approval",
      runtimeStatus: "disabled",
      sourceHash: HASH_B,
    });
    const uninstall = plugin("uninstall-plugin");
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [fresh, ready, disabled, approval, uninstall],
    });
    bridgeMock.installPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("fresh-plugin"),
    });
    bridgeMock.disablePlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("ready-plugin", {
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      }),
    });
    bridgeMock.enablePlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("disabled-plugin"),
    });
    bridgeMock.approvePlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("approval-plugin"),
    });
    bridgeMock.uninstallPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("uninstall-plugin", {
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      }),
    });

    render(<PluginSettings workspaceId="ws-1" />);

    const rows = await screen.findAllByTestId("plugin-row");
    const row = (id: string) =>
      rows.find((entry) => entry.getAttribute("data-plugin-id") === id)!;
    await userEvent.click(within(row("fresh-plugin")).getByTestId("plugin-install"));
    await userEvent.click(within(row("ready-plugin")).getByTestId("plugin-disable"));
    await userEvent.click(within(row("disabled-plugin")).getByTestId("plugin-enable"));
    await userEvent.click(within(row("approval-plugin")).getByTestId("plugin-approve"));
    await userEvent.click(within(row("uninstall-plugin")).getByTestId("plugin-uninstall"));
    await userEvent.click(await screen.findByTestId("plugin-uninstall-confirm"));

    expect(bridgeMock.installPlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "fresh-plugin",
    });
    expect(bridgeMock.disablePlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "ready-plugin",
    });
    expect(bridgeMock.enablePlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "disabled-plugin",
    });
    expect(bridgeMock.approvePlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "approval-plugin",
    });
    expect(bridgeMock.pluginUninstallPreflight).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "uninstall-plugin",
    });
    expect(bridgeMock.uninstallPlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "uninstall-plugin",
      confirmationToken: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("distinguishes a crash-loop disable from approval-required source", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("crash-plugin", {
          status: "disabled",
          disabledReason: "crash-loop",
          runtimeStatus: "disabled",
        }),
        plugin("approval-plugin", {
          status: "disabled-pending-approval",
          disabledReason: "approval",
          runtimeStatus: "disabled",
          sourceHash: HASH_B,
        }),
      ],
    });

    render(<PluginSettings workspaceId="ws-1" />);

    expect(await screen.findByText("Disabled after repeated crashes")).toBeTruthy();
    expect(screen.getByText("Disabled — approval required")).toBeTruthy();
    expect(screen.getByTestId("plugin-enable").textContent).toBe("Enable");
    expect(screen.getByTestId("plugin-approve").textContent).toBe("Approve");
  });

  it("shows uninstall warnings and names files history cannot recover", async () => {
    const installed = plugin("edited-plugin");
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    bridgeMock.pluginUninstallPreflight.mockResolvedValue({
      ok: true,
      confirmationToken: "00000000-0000-4000-8000-000000000002",
      preflight: {
        ...cleanPreflight,
        summary: "Uninstall will delete 2 modified or added plugin source files.",
        counts: {
          ...cleanPreflight.counts,
          modified: 1,
          addedSinceBaseline: 1,
          capturedRecoverable: 1,
          notRecoverableFromHistory: 1,
        },
        notRecoverablePaths: ["large.txt"],
        warning: {
          kind: "local-modifications",
          summary: "Uninstall will delete 2 modified or added plugin source files.",
          details: [
            "1 changed file can be recovered from history.",
            "1 changed file cannot be recovered from history.",
          ],
          counts: {
            ...cleanPreflight.counts,
            modified: 1,
            addedSinceBaseline: 1,
            capturedRecoverable: 1,
            notRecoverableFromHistory: 1,
          },
          notRecoverablePaths: ["large.txt"],
        },
      },
    });

    render(<PluginSettings workspaceId="ws-1" />);
    await userEvent.click(await screen.findByTestId("plugin-uninstall"));

    expect(await screen.findByTestId("plugin-uninstall-dialog")).toBeTruthy();
    expect(screen.getByTestId("plugin-uninstall-warning").textContent).toContain(
      "Uninstall will delete 2 modified or added plugin source files.",
    );
    expect(screen.getByTestId("plugin-uninstall-warning").textContent).toContain(
      "1 changed file can be recovered from history.",
    );
    expect(screen.getByText("History cannot recover these files:")).toBeTruthy();
    expect(screen.getByTestId("plugin-uninstall-not-recoverable").textContent).toContain(
      "large.txt",
    );
  });

  it("shows a busy action and an actionable error when the action fails", async () => {
    const disableResult = deferred<{
      ok: false;
      error: {
        stage: "state";
        code: string;
        message: string;
      };
      plugin: null;
    }>();
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("ready-plugin")],
    });
    bridgeMock.disablePlugin.mockReturnValue(disableResult.promise);

    render(<PluginSettings workspaceId="ws-1" />);
    const disableButton = await screen.findByTestId("plugin-disable");
    await userEvent.click(disableButton);

    expect(disableButton.textContent).toBe("Disabling");
    expect((disableButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      disableResult.resolve({
        ok: false,
        error: {
          stage: "state",
          code: "disable-failed",
          message: "The plugin host rejected the request.",
        },
        plugin: null,
      });
      await disableResult.promise;
    });

    expect((await screen.findByTestId("plugin-action-error")).textContent).toContain(
      "dohc could not disable ready-plugin. The plugin host rejected the request.",
    );
    expect(disableButton.textContent).toBe("Disable");
    await waitFor(() =>
      expect((disableButton as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
