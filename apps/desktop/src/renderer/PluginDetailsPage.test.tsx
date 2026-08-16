// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginStatusChangedEvent,
  PluginStatusRecord,
  PluginUninstallPreflightRecord,
} from "../ipc/bridgeContract";
import { PluginDetailsPage } from "./PluginDetailsPage";

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
  readWorkspaceText: vi.fn(),
  onPluginStatusChanged: vi.fn(
    (listener: (event: PluginStatusChangedEvent) => void) => {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    },
  ),
};

vi.mock("./bridge", () => ({
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function enoent(relativePath: string): Error {
  return new Error(
    `Error invoking remote method 'desktop:read-workspace-text': Error: ENOENT: no such file or directory, stat '/workspace/${relativePath}'`,
  );
}

function renderPage(pluginId: string, workspaceId = "ws-1") {
  return render(
    <PluginDetailsPage workspaceId={workspaceId} pluginId={pluginId} />,
  );
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
  bridgeMock.readWorkspaceText.mockRejectedValue(
    enoent("plugins/unknown/README.md"),
  );
});

afterEach(() => {
  cleanup();
});

describe("PluginDetailsPage", () => {
  it("names the plugin, its folder and its status", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code", { directoryName: "t3-code-src" })],
    });

    renderPage("t3-code");

    const page = await screen.findByTestId("plugin-details-page");
    expect(page.getAttribute("data-plugin-id")).toBe("t3-code");
    expect(screen.getByRole("heading", { name: "t3-code" })).toBeTruthy();
    expect(screen.getByTestId("plugin-status").getAttribute("data-status")).toBe(
      "ready",
    );
    expect(screen.getByText("plugins/t3-code-src")).toBeTruthy();
  });

  it("sends the workspace and plugin id for every action", async () => {
    // The round-9 action pins, migrated: the page is now the only surface
    // that offers these, so this is where they are proved.
    const fresh = plugin("fresh-plugin", {
      status: "discovered",
      runtimeStatus: null,
      sourceHash: null,
      approvedHash: null,
      installedBaselineHash: null,
    });
    bridgeMock.installPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("fresh-plugin"),
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [fresh] });
    const view = renderPage("fresh-plugin");
    await userEvent.click(await screen.findByTestId("plugin-install"));
    expect(bridgeMock.installPlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "fresh-plugin",
    });
    view.unmount();

    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("ready-plugin")],
    });
    bridgeMock.disablePlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("ready-plugin", {
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      }),
    });
    const disableView = renderPage("ready-plugin");
    await userEvent.click(await screen.findByTestId("plugin-disable"));
    expect(bridgeMock.disablePlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "ready-plugin",
    });
    disableView.unmount();

    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("disabled-plugin", {
          status: "disabled",
          disabledReason: "user",
          runtimeStatus: null,
        }),
      ],
    });
    bridgeMock.enablePlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("disabled-plugin"),
    });
    const enableView = renderPage("disabled-plugin");
    await userEvent.click(await screen.findByTestId("plugin-enable"));
    expect(bridgeMock.enablePlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "disabled-plugin",
    });
    enableView.unmount();

    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("approval-plugin", {
          status: "disabled-pending-approval",
          disabledReason: "approval",
          runtimeStatus: "disabled",
          sourceHash: HASH_B,
        }),
      ],
    });
    bridgeMock.approvePlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("approval-plugin"),
    });
    const approveView = renderPage("approval-plugin");
    await userEvent.click(await screen.findByTestId("plugin-approve"));
    expect(bridgeMock.approvePlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "approval-plugin",
    });
    approveView.unmount();

    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("uninstall-plugin")],
    });
    bridgeMock.uninstallPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("uninstall-plugin", {
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      }),
    });
    renderPage("uninstall-plugin");
    await userEvent.click(await screen.findByTestId("plugin-uninstall"));
    await userEvent.click(await screen.findByTestId("plugin-uninstall-confirm"));
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

  it("offers Open for an installed plugin's web app and frees the control on success", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    bridgeMock.openPluginWebApp.mockResolvedValue({
      pluginId: "t3-code",
      webAppId: "app",
    });

    renderPage("t3-code");
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
    // The app opens in its own tab beside this one. The only thing the
    // success path owes this page is its control back.
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

    const view = renderPage("t3-code", "ws-old");
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
    view.rerender(
      <PluginDetailsPage workspaceId="ws-new" pluginId="t3-code" />,
    );

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

  it("shows the open failure on the page when the app cannot start", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });
    bridgeMock.openPluginWebApp.mockRejectedValue(
      new Error("The t3 server exited before becoming ready in 3 attempts."),
    );

    renderPage("t3-code");
    const open = await screen.findByTestId("plugin-open-web-app");
    await act(async () => {
      fireEvent.click(open);
      await Promise.resolve();
    });

    const error = await screen.findByTestId("plugin-action-error");
    expect(error.textContent).toContain("3 attempts");
  });

  it("hides the web app control for a disabled plugin", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("disabled-plugin", {
          status: "disabled",
          disabledReason: "user",
          webApps: [{ id: "app", title: "App" }],
        }),
      ],
    });

    renderPage("disabled-plugin");
    await screen.findByTestId("plugin-details-page");
    expect(screen.queryByTestId("plugin-open-web-app")).toBeNull();
    expect(screen.getByTestId("plugin-enable")).toBeTruthy();
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
      ],
    });

    const view = renderPage("crash-plugin");
    expect(await screen.findByText("Disabled after repeated crashes")).toBeTruthy();
    expect(screen.getByTestId("plugin-enable").textContent).toBe("Enable");
    view.unmount();

    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("approval-plugin", {
          status: "disabled-pending-approval",
          disabledReason: "approval",
          runtimeStatus: "disabled",
          sourceHash: HASH_B,
        }),
      ],
    });
    renderPage("approval-plugin");
    expect(await screen.findByText("Disabled — approval required")).toBeTruthy();
    expect(screen.getByTestId("plugin-approve").textContent).toBe("Approve");
  });

  it("offers Approve for an out-of-band edit to an already user-disabled plugin", async () => {
    // holdForApproval keeps the prior "user" reason for a plugin the user had
    // already turned off. That combination matched no action predicate, so
    // the plugin offered nothing and the only way back was restoring old bytes.
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

    renderPage("user-disabled-plugin");

    expect((await screen.findByTestId("plugin-approve")).textContent).toBe(
      "Approve",
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

    renderPage("stuck-plugin");

    // None of the other actions render for this exact combination — a
    // retry affordance is the page's only control.
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

    renderPage("broken-plugin");

    // Uninstall is the reverse path this plugin must keep. Every other action
    // needs a manifest it no longer has, so offering one would only hand the
    // user a control that always fails.
    const uninstallButton = await screen.findByTestId("plugin-uninstall");
    expect(uninstallButton.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("plugin-disable")).toBeNull();
    expect(screen.queryByTestId("plugin-install")).toBeNull();
    expect(screen.queryByTestId("plugin-retry-install")).toBeNull();
    expect(screen.queryByTestId("plugin-enable")).toBeNull();
    expect(screen.queryByTestId("plugin-approve")).toBeNull();
    // The page is where the failure is explained.
    expect(screen.getByTestId("plugin-pipeline-error").textContent).toContain(
      "dohc-plugin.json is not valid JSON",
    );

    await userEvent.click(uninstallButton);

    expect(bridgeMock.pluginUninstallPreflight).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "broken-plugin",
    });
  });

  it("shows uninstall warnings and names files history cannot recover", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("edited-plugin")],
    });
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

    renderPage("edited-plugin");
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
    const sample = Array.from({ length: 20 }, (_, index) => `asset-${index}.bin`);
    const counts = {
      ...cleanPreflight.counts,
      modified: 25,
      notRecoverableFromHistory: 25,
    };
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("edited-plugin")],
    });
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

    renderPage("edited-plugin");
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
      error: { stage: "state"; code: string; message: string };
      plugin: null;
    }>();
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("ready-plugin")],
    });
    bridgeMock.disablePlugin.mockReturnValue(disableResult.promise);

    renderPage("ready-plugin");
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

  it("follows the plugin's status live", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("fresh-plugin", {
          status: "discovered",
          runtimeStatus: null,
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
        }),
      ],
    });

    renderPage("fresh-plugin");
    expect(await screen.findByTestId("plugin-install")).toBeTruthy();

    // The install completes elsewhere; the page must follow it and swap the
    // controls it offers without being reopened.
    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("fresh-plugin"),
      });
    });

    expect(await screen.findByTestId("plugin-disable")).toBeTruthy();
    expect(screen.queryByTestId("plugin-install")).toBeNull();
    expect(screen.getByTestId("plugin-status").getAttribute("data-status")).toBe(
      "ready",
    );
  });

  it("says so when the plugin is no longer in this workspace", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("other-plugin")],
    });

    renderPage("gone-plugin");

    const missing = await screen.findByTestId("plugin-details-missing");
    expect(missing.textContent).toContain("gone-plugin is not in this workspace.");
  });

  it("never repaints one workspace's plugin from another workspace's list", async () => {
    const oldList = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    const newList = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    bridgeMock.listPlugins.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === "ws-old" ? oldList.promise : newList.promise,
    );

    const view = renderPage("t3-code", "ws-old");
    view.rerender(<PluginDetailsPage workspaceId="ws-new" pluginId="t3-code" />);

    await act(async () => {
      newList.resolve({
        ok: true,
        plugins: [plugin("t3-code", { directoryName: "new-workspace-copy" })],
      });
      await newList.promise;
    });
    expect(await screen.findByText("plugins/new-workspace-copy")).toBeTruthy();

    // The workspace the user left finally answers. Its plugin carries the
    // same id, so only the epoch guard keeps it off this page.
    await act(async () => {
      oldList.resolve({
        ok: true,
        plugins: [plugin("t3-code", { directoryName: "old-workspace-copy" })],
      });
      await oldList.promise;
    });
    expect(screen.queryByText("plugins/old-workspace-copy")).toBeNull();
    expect(screen.getByText("plugins/new-workspace-copy")).toBeTruthy();
  });

  it("surfaces the real reason and offers a retry when the plugin cannot load", async () => {
    bridgeMock.listPlugins.mockResolvedValueOnce({
      ok: false,
      error: {
        stage: "discovery",
        code: "discovery-failed",
        message: "The plugin pipeline could not start.",
      },
    });

    renderPage("t3-code");

    const alert = await screen.findByTestId("plugin-details-load-error");
    expect(alert.textContent).toContain("The plugin pipeline could not start.");

    bridgeMock.listPlugins.mockResolvedValueOnce({
      ok: true,
      plugins: [plugin("t3-code")],
    });
    await userEvent.click(screen.getByText("Retry"));

    expect(await screen.findByTestId("plugin-details-page")).toBeTruthy();
  });

  describe("README", () => {
    it("renders the plugin's README from its own folder", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code", { directoryName: "t3-code-src" })],
      });
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: "# t3-code\n\nWraps the published t3 coding agent server.\n",
        truncated: false,
        contentHash: HASH_A,
      });

      renderPage("t3-code");

      expect(await screen.findByTestId("plugin-readme")).toBeTruthy();
      // The folder names the file, never the plugin id: the two differ here.
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "plugins/t3-code-src/README.md",
      });
      expect(
        screen.getByText("Wraps the published t3 coding agent server."),
      ).toBeTruthy();
      // The page title owns the only h1. A README that opens by repeating the
      // plugin's name renders one level down, so the page keeps an outline.
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(
        screen.getByRole("heading", { level: 2, name: "t3-code" }),
      ).toBeTruthy();
    });

    it("strips frontmatter before rendering", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code")],
      });
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: "---\ntitle: Not shown\n---\n\nThe body.\n",
        truncated: false,
        contentHash: HASH_A,
      });

      renderPage("t3-code");

      expect(await screen.findByText("The body.")).toBeTruthy();
      expect(screen.queryByText(/title: Not shown/)).toBeNull();
    });

    it("stays quiet when the plugin has no README", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("bare-plugin")],
      });
      bridgeMock.readWorkspaceText.mockRejectedValue(
        enoent("plugins/bare-plugin/README.md"),
      );

      renderPage("bare-plugin");

      expect((await screen.findByTestId("plugin-readme-absent")).textContent).toBe(
        "This plugin has no README.",
      );
      expect(screen.queryByTestId("plugin-readme-error")).toBeNull();
    });

    it("treats an empty README as no README", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("bare-plugin")],
      });
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: "\n\n   \n",
        truncated: false,
        contentHash: HASH_A,
      });

      renderPage("bare-plugin");

      expect(await screen.findByTestId("plugin-readme-absent")).toBeTruthy();
    });

    it("reports a read failure instead of claiming there is no README", async () => {
      // MUTATION (catch every rejection as "absent"): a permission failure
      // reads as a plugin that simply documents nothing, and the user is
      // told a comfortable lie about their own workspace.
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code")],
      });
      bridgeMock.readWorkspaceText.mockRejectedValue(
        new Error(
          "Error invoking remote method 'desktop:read-workspace-text': Error: EACCES: permission denied",
        ),
      );

      renderPage("t3-code");

      const error = await screen.findByTestId("plugin-readme-error");
      expect(error.textContent).toContain("plugins/t3-code/README.md");
      expect(error.textContent).toContain("EACCES: permission denied");
      // The Electron wrapper never reaches the user.
      expect(error.textContent).not.toContain("invoking remote method");
      expect(screen.queryByTestId("plugin-readme-absent")).toBeNull();
    });

    it("never lets a slow read repaint over the folder the plugin now has", async () => {
      // MUTATION (drop the request token in useReadme): the rename's own
      // README paints first, then the read for the folder the plugin no
      // longer has lands on top of it and the page shows the wrong file.
      // A workspace switch cannot prove this — it unmounts the README —
      // so the race is exercised where it really lives: one live page whose
      // plugin changed folder underneath it.
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code", { directoryName: "old-folder" })],
      });
      const slowRead = deferred<{
        text: string;
        truncated: false;
        contentHash: string;
      }>();
      bridgeMock.readWorkspaceText.mockImplementation(
        ({ relativePath }: { relativePath: string }) =>
          relativePath === "plugins/old-folder/README.md"
            ? slowRead.promise
            : Promise.resolve({
                text: "The renamed folder README.",
                truncated: false as const,
                contentHash: HASH_A,
              }),
      );

      renderPage("t3-code");
      await screen.findByTestId("plugin-readme-loading");

      act(() => {
        statusListener?.({
          kind: "changed",
          workspaceId: "ws-1",
          plugin: plugin("t3-code", { directoryName: "new-folder" }),
        });
      });
      expect(await screen.findByText("The renamed folder README.")).toBeTruthy();

      await act(async () => {
        slowRead.resolve({
          text: "The stale folder README.",
          truncated: false,
          contentHash: HASH_A,
        });
        await slowRead.promise;
      });

      expect(screen.queryByText("The stale folder README.")).toBeNull();
      expect(screen.getByText("The renamed folder README.")).toBeTruthy();
    });

    it("never shows one workspace's README on another workspace's page", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code")],
      });
      const oldRead = deferred<{
        text: string;
        truncated: false;
        contentHash: string;
      }>();
      bridgeMock.readWorkspaceText.mockImplementation(
        ({ workspaceId }: { workspaceId: string }) =>
          workspaceId === "ws-old"
            ? oldRead.promise
            : Promise.resolve({
                text: "The new workspace README.",
                truncated: false as const,
                contentHash: HASH_A,
              }),
      );

      const view = renderPage("t3-code", "ws-old");
      await screen.findByTestId("plugin-details-page");
      view.rerender(<PluginDetailsPage workspaceId="ws-new" pluginId="t3-code" />);
      expect(await screen.findByText("The new workspace README.")).toBeTruthy();

      await act(async () => {
        oldRead.resolve({
          text: "The old workspace README.",
          truncated: false,
          contentHash: HASH_A,
        });
        await oldRead.promise;
      });

      expect(screen.queryByText("The old workspace README.")).toBeNull();
      expect(screen.getByText("The new workspace README.")).toBeTruthy();
    });
  });
});
