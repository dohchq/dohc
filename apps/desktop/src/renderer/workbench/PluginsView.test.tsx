// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginStatusChangedEvent,
  PluginStatusRecord,
  PluginUninstallPreflightRecord,
} from "../../ipc/bridgeContract";
import { PluginsView } from "./PluginsView";

let statusListener: ((event: PluginStatusChangedEvent) => void) | null = null;

const bridgeMock = {
  listPlugins: vi.fn(),
  openPluginWebApp: vi.fn(),
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
    webApps: [],
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
  stateData: null,
  counts: {
    unchanged: 1,
    modified: 0,
    addedSinceBaseline: 0,
    removedSinceBaseline: 0,
    unknownWithoutBaseline: 0,
    notRecoverableFromHistory: 0,
  },
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

describe("PluginsView", () => {
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

    const view = render(<PluginsView workspaceId="ws-old" />);
    expect(bridgeMock.listPlugins).toHaveBeenCalledWith({ workspaceId: "ws-old" });

    view.rerender(<PluginsView workspaceId="ws-new" />);
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

  it("offers Open for an installed plugin's web app and frees the control on success", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    bridgeMock.openPluginWebApp.mockResolvedValue({
      pluginId: "t3-code",
      webAppId: "app",
    });

    render(<PluginsView workspaceId="ws-1" />);
    const open = await screen.findByTestId("plugin-open-web-app");
    expect(open.textContent).toBe("Open T3 Code");

    await act(async () => {
      fireEvent.click(open);
      await Promise.resolve();
    });

    expect(bridgeMock.openPluginWebApp).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginRoot: installed.rootPath,
      pluginId: "t3-code",
      webAppId: "app",
    });
    // The panel sits beside the editor and stays open. The only thing the
    // success path owes the row is its control back.
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    expect(open.textContent).toBe("Open T3 Code");
  });

  it("can open a web app after leaving a workspace whose open never answered", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    const stuck = deferred<{ pluginId: string; webAppId: string }>();
    bridgeMock.openPluginWebApp.mockReturnValueOnce(stuck.promise);

    const view = render(<PluginsView workspaceId="ws-old" />);
    const stuckOpen = await screen.findByTestId("plugin-open-web-app");
    await act(async () => {
      fireEvent.click(stuckOpen);
      await Promise.resolve();
    });
    // The old workspace's open is still in flight, so its control is busy.
    expect(screen.getByTestId("plugin-open-web-app").hasAttribute("disabled")).toBe(
      true,
    );

    bridgeMock.openPluginWebApp.mockResolvedValue({
      pluginId: "t3-code",
      webAppId: "app",
    });
    view.rerender(<PluginsView workspaceId="ws-new" />);

    // MUTATION (leave openingWebApp alone across the switch): the stale
    // request never clears it — its own cleanup is skipped by the epoch
    // guard — and every Open control in this workspace stays disabled.
    const open = await screen.findByTestId("plugin-open-web-app");
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(open);
      await Promise.resolve();
    });
    expect(bridgeMock.openPluginWebApp).toHaveBeenLastCalledWith({
      workspaceId: "ws-new",
      pluginRoot: installed.rootPath,
      pluginId: "t3-code",
      webAppId: "app",
    });
  });

  it("shows the open failure on the row when the app cannot start", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    bridgeMock.openPluginWebApp.mockRejectedValue(
      new Error("The t3 server exited before becoming ready in 3 attempts."),
    );

    render(<PluginsView workspaceId="ws-1" />);
    const open = await screen.findByTestId("plugin-open-web-app");
    await act(async () => {
      fireEvent.click(open);
      await Promise.resolve();
    });

    const error = await screen.findByTestId("plugin-action-error");
    expect(error.textContent).toContain("3 attempts");
  });

  it("hides the web app control for disabled and uninstalled plugins", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("disabled-plugin", {
          status: "disabled",
          disabledReason: "user",
          webApps: [{ id: "app", title: "App" }],
        }),
        plugin("uninstalled-plugin", {
          status: "discovered",
          approvedHash: null,
          webApps: [{ id: "app", title: "App" }],
        }),
      ],
    });

    render(<PluginsView workspaceId="ws-1" />);
    await screen.findByText("disabled-plugin");
    expect(screen.queryByTestId("plugin-open-web-app")).toBeNull();
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

    render(<PluginsView workspaceId="ws-1" />);

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

  it("splits installed plugins from what the workspace only offers", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("installed-plugin"),
        plugin("candidate-plugin", {
          status: "discovered",
          runtimeStatus: null,
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
        }),
      ],
    });

    render(<PluginsView workspaceId="ws-1" />);

    const installed = await screen.findByTestId("plugins-section-installed");
    const available = screen.getByTestId("plugins-section-available");
    expect(within(installed).getByTestId("plugin-row").getAttribute("data-plugin-id"))
      .toBe("installed-plugin");
    expect(within(available).getByTestId("plugin-row").getAttribute("data-plugin-id"))
      .toBe("candidate-plugin");
    // Installed reads first — a workspace's own installed plugins are the
    // list the user came for.
    expect(installed.compareDocumentPosition(available)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The candidate is the only row that offers Install.
    expect(within(available).getByTestId("plugin-install")).toBeTruthy();
    expect(within(installed).queryByTestId("plugin-install")).toBeNull();
  });

  it("narrows the list to the plugins matching what the user typed", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("t3-code"),
        plugin("notes-widget", { directoryName: "notes-widget-src" }),
      ],
    });

    render(<PluginsView workspaceId="ws-1" />);
    await screen.findByText("t3-code");

    const filter = screen.getByTestId("plugins-filter");
    await userEvent.type(filter, "notes");
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
    expect(screen.getByTestId("plugin-row").getAttribute("data-plugin-id")).toBe(
      "notes-widget",
    );

    // The folder is the plugin's other name, so it filters too.
    await userEvent.clear(filter);
    await userEvent.type(filter, "widget-src");
    expect(screen.getByTestId("plugin-row").getAttribute("data-plugin-id")).toBe(
      "notes-widget",
    );

    await userEvent.clear(filter);
    await userEvent.type(filter, "nothing-here");
    expect(screen.queryAllByTestId("plugin-row")).toHaveLength(0);
    expect(screen.getByTestId("plugins-filter-empty").textContent).toContain(
      'No plugins match "nothing-here"',
    );

    await userEvent.clear(filter);
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);
  });

  it("tells the user where plugins come from when the workspace has none", async () => {
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [] });

    render(<PluginsView workspaceId="ws-1" />);

    const empty = await screen.findByTestId("plugins-empty");
    expect(empty.textContent).toContain("No plugins yet");
    expect(empty.textContent).toContain("plugins/");
    expect(screen.queryByTestId("plugins-filter-empty")).toBeNull();
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

    render(<PluginsView workspaceId="ws-1" />);

    expect(await screen.findByText("Disabled after repeated crashes")).toBeTruthy();
    expect(screen.getByText("Disabled — approval required")).toBeTruthy();
    expect(screen.getByTestId("plugin-enable").textContent).toBe("Enable");
    expect(screen.getByTestId("plugin-approve").textContent).toBe("Approve");
  });

  it("offers Approve for an out-of-band edit to an already user-disabled plugin", async () => {
    // holdForApproval keeps the prior "user" reason for a plugin the user had
    // already turned off. That combination matched no action predicate, so
    // the row offered nothing and the only way back was restoring old bytes.
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("user-disabled-plugin", {
          status: "disabled-pending-approval",
          disabledReason: "user",
          runtimeStatus: "disabled",
          sourceHash: HASH_B,
        }),
      ],
    });

    render(<PluginsView workspaceId="ws-1" />);

    expect((await screen.findByTestId("plugin-approve")).textContent).toBe(
      "Approve",
    );
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
          notRecoverableFromHistory: 1,
        },
        warning: {
          kind: "local-modifications",
          summary: "Uninstall will delete 2 modified or added plugin source files.",
          details: [
            "1 modified, 1 added, and 0 removed since the installation baseline.",
            "dohc cannot confirm history holds a copy of the files uninstall will delete.",
          ],
          counts: {
            ...cleanPreflight.counts,
            modified: 1,
            addedSinceBaseline: 1,
            notRecoverableFromHistory: 1,
          },
          notRecoverablePathSample: ["large.txt"],
        },
      },
    });

    render(<PluginsView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByTestId("plugin-uninstall"));

    expect(await screen.findByTestId("plugin-uninstall-dialog")).toBeTruthy();
    expect(screen.getByTestId("plugin-uninstall-warning").textContent).toContain(
      "Uninstall will delete 2 modified or added plugin source files.",
    );
    expect(screen.getByTestId("plugin-uninstall-warning").textContent).toContain(
      "dohc cannot confirm history holds a copy of the files uninstall will delete.",
    );
    expect(screen.getByText("dohc cannot confirm history holds these files:"))
      .toBeTruthy();
    expect(screen.getByTestId("plugin-uninstall-not-recoverable").textContent).toContain(
      "large.txt",
    );
  });

  it("counts the unrecoverable files the bounded sample leaves out", async () => {
    const installed = plugin("edited-plugin");
    const sample = Array.from({ length: 20 }, (_, index) => `asset-${index}.bin`);
    const counts = {
      ...cleanPreflight.counts,
      modified: 25,
      notRecoverableFromHistory: 25,
    };
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    bridgeMock.pluginUninstallPreflight.mockResolvedValue({
      ok: true,
      confirmationToken: "00000000-0000-4000-8000-000000000003",
      preflight: {
        ...cleanPreflight,
        summary: "Uninstall will delete 25 modified or added plugin source files.",
        counts,
        warning: {
          kind: "local-modifications",
          summary: "Uninstall will delete 25 modified or added plugin source files.",
          details: [
            "dohc cannot confirm history holds a copy of the files uninstall will delete.",
          ],
          counts,
          notRecoverablePathSample: sample,
        },
      },
    });

    render(<PluginsView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByTestId("plugin-uninstall"));

    expect(await screen.findByTestId("plugin-uninstall-dialog")).toBeTruthy();
    expect(
      screen.getByTestId("plugin-uninstall-not-recoverable").textContent,
    ).toContain("asset-19.bin");
    expect(
      screen.getByTestId("plugin-uninstall-not-recoverable-more").textContent,
    ).toBe("and 5 more");
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

    render(<PluginsView workspaceId="ws-1" />);
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

  it("offers a retry action for a plugin whose fresh install failed (CodeRabbit #779 R30)", async () => {
    const stuck = plugin("stuck-plugin", {
      status: "disabled-pending-repair",
      disabledReason: "repair",
      runtimeStatus: null,
      sourceHash: HASH_A,
      approvedHash: null,
      installedBaselineHash: null,
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [stuck] });
    bridgeMock.installPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("stuck-plugin"),
    });

    render(<PluginsView workspaceId="ws-1" />);

    // None of the other actions render for this exact combination — a
    // retry affordance is the row's only control.
    expect(screen.queryByTestId("plugin-install")).toBeNull();
    expect(screen.queryByTestId("plugin-enable")).toBeNull();
    expect(screen.queryByTestId("plugin-approve")).toBeNull();
    expect(screen.queryByTestId("plugin-disable")).toBeNull();
    const retryButton = await screen.findByTestId("plugin-retry-install");
    expect(retryButton.textContent).toBe("Retry install");

    await userEvent.click(retryButton);

    expect(bridgeMock.installPlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "stuck-plugin",
    });
  });

  it("offers only uninstall for an installed plugin whose manifest broke (#779 round 8 D2)", async () => {
    const broken = plugin("broken-plugin", {
      valid: false,
      status: "invalid",
      runtimeStatus: null,
      sourceHash: null,
      diagnostics: ["dohc-plugin.json is not valid JSON"],
      error: {
        stage: "discovery",
        code: "invalid-plugin",
        message: "dohc-plugin.json is not valid JSON",
      },
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [broken] });
    bridgeMock.pluginUninstallPreflight.mockResolvedValue({
      ok: true,
      confirmationToken: "token-1",
      preflight: cleanPreflight,
    });

    render(<PluginsView workspaceId="ws-1" />);

    // Uninstall is the reverse path this row must keep. Every other action
    // needs a manifest this plugin no longer has, so offering one would only
    // hand the user a control that always fails.
    const uninstallButton = await screen.findByTestId("plugin-uninstall");
    expect(uninstallButton.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("plugin-disable")).toBeNull();
    expect(screen.queryByTestId("plugin-install")).toBeNull();
    expect(screen.queryByTestId("plugin-retry-install")).toBeNull();
    expect(screen.queryByTestId("plugin-enable")).toBeNull();
    expect(screen.queryByTestId("plugin-approve")).toBeNull();

    await userEvent.click(uninstallButton);

    expect(bridgeMock.pluginUninstallPreflight).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "broken-plugin",
    });
  });

  it("surfaces the real reason and offers a retry when the plugin list fails to load (CodeRabbit #779 R29, R31)", async () => {
    bridgeMock.listPlugins.mockResolvedValueOnce({
      ok: false,
      error: {
        stage: "discovery",
        code: "discovery-failed",
        message: "The plugin pipeline could not start.",
      },
    });

    render(<PluginsView workspaceId="ws-1" />);

    const alert = await screen.findByTestId("plugins-load-error");
    expect(alert.textContent).toContain("The plugin pipeline could not start.");
    // The old copy told the user to do the exact thing the Retry button
    // right next to it already does — that redundant instruction is gone.
    expect(alert.textContent).not.toContain("Open this section again");

    bridgeMock.listPlugins.mockResolvedValueOnce({
      ok: true,
      plugins: [plugin("recovered-plugin")],
    });
    await userEvent.click(screen.getByText("Retry"));

    expect(await screen.findByText("recovered-plugin")).toBeTruthy();
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(2);
  });

  it("merges a status event newer than the in-flight list response (CodeRabbit #779 R29)", async () => {
    const list = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    bridgeMock.listPlugins.mockReturnValue(list.promise);

    render(<PluginsView workspaceId="ws-1" />);
    await waitFor(() => expect(statusListener).not.toBeNull());

    // A status event for a plugin the about-to-resolve list also contains
    // arrives while the list request is still in flight — the newer event
    // must win over the stale value the list carries for that same plugin.
    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("live-plugin", { status: "starting", runtimeStatus: "starting" }),
      });
    });

    await act(async () => {
      list.resolve({
        ok: true,
        plugins: [plugin("live-plugin", { status: "ready", runtimeStatus: "ready" })],
      });
      await list.promise;
    });

    expect(
      (await screen.findByTestId("plugin-status")).getAttribute("data-status"),
    ).toBe("starting");
  });

  it("lets a status event newer than an in-flight action's response win (fixround Section B item 14)", async () => {
    const fresh = plugin("fresh-plugin", {
      status: "discovered",
      runtimeStatus: null,
      sourceHash: null,
      approvedHash: null,
      installedBaselineHash: null,
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [fresh] });
    const install = deferred<{ ok: true; plugin: PluginStatusRecord }>();
    bridgeMock.installPlugin.mockReturnValue(install.promise);

    render(<PluginsView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByTestId("plugin-install"));
    await waitFor(() => expect(statusListener).not.toBeNull());

    // A status event carrying real, newer progress arrives while
    // installPlugin's own request is still in flight.
    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("fresh-plugin", { status: "building", runtimeStatus: null }),
      });
    });
    expect(
      (await screen.findByTestId("plugin-status")).getAttribute("data-status"),
    ).toBe("building");

    // installPlugin's own response finally resolves, but with a snapshot
    // from before that newer event — it must not roll the row backward.
    await act(async () => {
      install.resolve({
        ok: true,
        plugin: plugin("fresh-plugin", { status: "installing", runtimeStatus: null }),
      });
      await install.promise;
    });

    expect(
      screen.getByTestId("plugin-status").getAttribute("data-status"),
    ).toBe("building");
  });
});
