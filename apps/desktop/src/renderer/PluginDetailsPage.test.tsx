// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  pluginSizes: vi.fn(),
  openExternalUrl: vi.fn(),
  uninstallPlugin: vi.fn(),
  readWorkspaceText: vi.fn(),
  getPluginSettings: vi.fn(),
  setPluginSettings: vi.fn(),
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
    displayName: null,
    description: null,
    publisher: null,
    pluginVersion: null,
    repository: null,
    issues: null,
    license: null,
    icon: null,
    settings: [],
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
  // Nothing measured is the quiet default: a test that says nothing about
  // sizes gets no size rows, so a row appearing is always something a test
  // asked for.
  bridgeMock.pluginSizes.mockResolvedValue({
    ok: true,
    sizes: { installedBytes: null, dataBytes: null },
  });
  bridgeMock.openExternalUrl.mockResolvedValue(undefined);
  bridgeMock.getPluginSettings.mockResolvedValue({ ok: true, values: {} });
  bridgeMock.setPluginSettings.mockResolvedValue({ ok: true, values: {} });
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

  // The page is the only surface that reads this plugin's manifest, so it is
  // what tells the shell the name its tab should carry — the same route the
  // web app page's start title takes.
  it("reports the name it heads the page with, so its tab can carry it", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("hello-plugin", { displayName: "Hello Plugin" })],
    });
    const titles: Array<[string, string]> = [];

    render(
      <PluginDetailsPage
        workspaceId="ws-1"
        pluginId="hello-plugin"
        onTitle={(pluginId, title) => titles.push([pluginId, title])}
      />,
    );

    await screen.findByTestId("plugin-details-page");
    await waitFor(() => expect(titles).toEqual([["hello-plugin", "Hello Plugin"]]));
  });

  it("reports the plugin id when the manifest declares no name", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("hello-plugin")],
    });
    const titles: string[] = [];

    render(
      <PluginDetailsPage
        workspaceId="ws-1"
        pluginId="hello-plugin"
        onTitle={(_pluginId, title) => titles.push(title)}
      />,
    );

    await screen.findByTestId("plugin-details-page");
    await waitFor(() => expect(titles).toEqual(["hello-plugin"]));
  });

  it("heads the page with the manifest's name, description, publisher, and icon", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("t3-code", {
          directoryName: "t3-code-src",
          displayName: "T3 Code",
          description: "Runs the t3 coding agent server on this workspace.",
          publisher: "dohc",
          icon: "icon.svg",
        }),
      ],
    });

    renderPage("t3-code");

    expect(await screen.findByRole("heading", { name: "T3 Code" })).toBeTruthy();
    expect(screen.getByTestId("plugin-description").textContent).toBe(
      "Runs the t3 coding agent server on this workspace.",
    );
    expect(screen.getByTestId("plugin-publisher").textContent).toBe("dohc");
    expect(screen.getByTestId("plugin-icon").getAttribute("src")).toBe(
      "dohc-file://ws-1/plugins/t3-code-src/icon.svg",
    );
    // A named plugin's id has to stay visible somewhere: it is what every
    // action, folder, and error message calls this plugin. It is the rail's
    // first row now rather than a chip in the header.
    expect(screen.getByTestId("plugin-identifier").textContent).toContain(
      "t3-code",
    );
  });

  it("falls back to the id and the glyph when the manifest says nothing", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("bare-plugin")],
    });

    renderPage("bare-plugin");

    expect(await screen.findByRole("heading", { name: "bare-plugin" }))
      .toBeTruthy();
    expect(screen.queryByTestId("plugin-description")).toBeNull();
    expect(screen.queryByTestId("plugin-publisher")).toBeNull();
    expect(screen.queryByTestId("plugin-icon")).toBeNull();
    // The id is the heading here, and it is still the rail's Identifier row:
    // the rail states what dohc knows whether or not the manifest named the
    // plugin, so this row never depends on a display name.
    expect(screen.getByTestId("plugin-identifier").textContent).toContain(
      "bare-plugin",
    );
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

  // MUTATION (offer Open for a per-instance app too): this page has no
  // instance to name, so the open would be refused — and a user would be
  // handed a button that never works. The plugin's own panel opens these.
  it("offers no Open for a web app that opens one tab per instance", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "preview", title: "Preview", instanced: true }],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });

    renderPage("t3-code");
    await screen.findByTestId("plugin-details-page");
    expect(screen.queryByTestId("plugin-open-web-app")).toBeNull();
  });

  it("offers Open only for the single-tab web apps beside a per-instance one", async () => {
    const installed = plugin("t3-code", {
      webApps: [
        { id: "preview", title: "Preview", instanced: true },
        { id: "app", title: "T3 Code", instanced: false },
      ],
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [installed] });

    renderPage("t3-code");
    const buttons = await screen.findAllByTestId("plugin-open-web-app");
    expect(buttons.map((button) => button.getAttribute("data-web-app-id"))).toEqual([
      "app",
    ]);
  });

  it("offers Open for an installed plugin's web app and frees the control on success", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code", instanced: false }],
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
      instanceKey: null,
    });
    // The app opens in its own tab beside this one. The only thing the
    // success path owes this page is its control back.
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    expect(open.textContent).toBe("Open T3 Code");
  });

  it("can open a web app after leaving a workspace whose open never answered", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code", instanced: false }],
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
      instanceKey: null,
    });
  });

  it("shows the open failure on the page when the app cannot start", async () => {
    const installed = plugin("t3-code", {
      webApps: [{ id: "app", title: "T3 Code", instanced: false }],
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
          webApps: [{ id: "app", title: "App", instanced: false }],
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

  describe("skipped install hooks", () => {
    // The real lines come from the lifecycle scan, one per package the plugin
    // manifest allows a skipped hook for (pluginLifecycleScan.ts warningLine).
    function skippedHookLines(count: number): string[] {
      return Array.from(
        { length: count },
        (_unused, index) =>
          `Package "dep-${index}" 1.0.${index} allows skipped postinstall hook.`,
      );
    }

    it("keeps the list collapsed behind a summary that counts it", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code", { warnings: skippedHookLines(34) })],
      });

      renderPage("t3-code");

      const toggle = await screen.findByTestId("plugin-warnings-toggle");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toBe(
        "dohc skipped 34 install hooks in this plugin's packages",
      );
      // The reason the block collapses at all: the list scales with the
      // dependency tree, so none of it may occupy the page unasked.
      expect(screen.queryByTestId("plugin-warnings-list")).toBeNull();
      expect(screen.queryByText(skippedHookLines(34)[0])).toBeNull();
    });

    it("counts a single skipped hook in the singular", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code", { warnings: skippedHookLines(1) })],
      });

      renderPage("t3-code");

      expect((await screen.findByTestId("plugin-warnings-toggle")).textContent)
        .toBe("dohc skipped 1 install hook in this plugin's packages");
    });

    it("opens and closes the list from its disclosure", async () => {
      const lines = skippedHookLines(3);
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code", { warnings: lines })],
      });

      renderPage("t3-code");

      const toggle = await screen.findByTestId("plugin-warnings-toggle");
      await userEvent.click(toggle);

      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const list = screen.getByTestId("plugin-warnings-list");
      for (const line of lines) {
        expect(list.textContent).toContain(line);
      }
      // The expanded list says what dohc did, so the record cannot read as a
      // failure the user has to act on.
      expect(screen.getByTestId("plugin-warnings").textContent).toContain(
        "dohc turns these hooks off during install. None of them ran.",
      );

      await userEvent.click(toggle);

      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTestId("plugin-warnings-list")).toBeNull();
    });

    it("bounds the expanded list instead of growing the page", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code", { warnings: skippedHookLines(400) })],
      });

      renderPage("t3-code");

      await userEvent.click(await screen.findByTestId("plugin-warnings-toggle"));

      // Structural pin: jsdom lays nothing out, so the bound is read from the
      // classes that carry it. A 400-entry list must scroll inside its own box.
      const list = screen.getByTestId("plugin-warnings-list");
      expect(list.className).toContain("max-h-48");
      expect(list.className).toContain("overflow-y-auto");
    });

    it("never collapses a pipeline error behind the summary", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [
          plugin("t3-code", {
            status: "failed",
            warnings: skippedHookLines(12),
            error: {
              stage: "install",
              code: "install-failed",
              message: "pnpm install exited with code 1",
            },
          }),
        ],
      });

      renderPage("t3-code");

      // The error is the one thing the user must act on. It stays on the page
      // with no disclosure to open.
      expect((await screen.findByTestId("plugin-pipeline-error")).textContent)
        .toContain("pnpm install exited with code 1");
      expect(screen.getByTestId("plugin-warnings-toggle").getAttribute(
        "aria-expanded",
      )).toBe("false");
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

    it("renders a README table as a table, not raw pipes", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code")],
      });
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: "| Setting | Default |\n| --- | --- |\n| Port | 4317 |\n",
        truncated: false,
        contentHash: HASH_A,
      });

      renderPage("t3-code");

      const readme = await screen.findByTestId("plugin-readme");
      expect(readme.querySelectorAll("th")).toHaveLength(2);
      expect(readme.querySelector("td")?.textContent).toBe("Port");
      expect(readme.textContent).not.toContain("|");
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

  describe("Settings", () => {
    const declared: PluginStatusRecord["settings"] = [
      {
        key: "greeting",
        type: "string",
        label: "Greeting",
        description: "What the note says.",
        default: "Hello",
      },
      { key: "shout", type: "boolean", label: "Shout", default: false },
      { key: "repeat", type: "number", label: "Repeat", default: 1 },
      {
        key: "tone",
        type: "select",
        label: "Tone",
        default: "plain",
        options: ["plain", "warm"],
      },
    ];

    const defaults = {
      greeting: "Hello",
      shout: false,
      repeat: 1,
      tone: "plain",
    };

    function withSettings(values: Record<string, unknown> = defaults) {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("hello-plugin", { settings: declared })],
      });
      bridgeMock.getPluginSettings.mockResolvedValue({ ok: true, values });
    }

    it("does not render a Settings section for a plugin that declares none", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("t3-code")],
      });

      renderPage("t3-code");
      await screen.findByTestId("plugin-details-page");

      expect(screen.queryByTestId("plugin-settings")).toBeNull();
      // And it never asks for values it has no controls for.
      expect(bridgeMock.getPluginSettings).not.toHaveBeenCalled();
    });

    it("renders one control per declared setting, at its current value", async () => {
      withSettings({
        greeting: "Hei",
        shout: true,
        repeat: 3,
        tone: "warm",
      });

      renderPage("hello-plugin");

      await screen.findByTestId("plugin-setting-input-greeting");
      expect(bridgeMock.getPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        pluginId: "hello-plugin",
      });
      expect(screen.getByText("Greeting")).toBeTruthy();
      expect(screen.getByText("What the note says.")).toBeTruthy();
      expect(
        (screen.getByTestId("plugin-setting-input-greeting") as HTMLInputElement)
          .value,
      ).toBe("Hei");
      expect(
        screen.getByRole("switch", { name: "Shout" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        (screen.getByTestId("plugin-setting-input-repeat") as HTMLInputElement)
          .value,
      ).toBe("3");
      expect(
        (screen.getByTestId("plugin-setting-input-tone") as HTMLSelectElement)
          .value,
      ).toBe("warm");
    });

    it("saves a switch the moment it changes and shows what was stored", async () => {
      withSettings();
      bridgeMock.setPluginSettings.mockResolvedValue({
        ok: true,
        values: { ...defaults, shout: true },
      });

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      await userEvent.click(screen.getByRole("switch", { name: "Shout" }));

      expect(bridgeMock.setPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        pluginId: "hello-plugin",
        values: { shout: true },
      });
      await waitFor(() =>
        expect(
          screen.getByRole("switch", { name: "Shout" }).getAttribute("aria-checked"),
        ).toBe("true")
      );
    });

    it("saves a select the moment it changes", async () => {
      withSettings();
      bridgeMock.setPluginSettings.mockResolvedValue({
        ok: true,
        values: { ...defaults, tone: "warm" },
      });

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      await userEvent.selectOptions(
        screen.getByTestId("plugin-setting-input-tone"),
        "warm",
      );

      expect(bridgeMock.setPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        pluginId: "hello-plugin",
        values: { tone: "warm" },
      });
    });

    it("saves typed text once, when the field is left", async () => {
      withSettings();
      bridgeMock.setPluginSettings.mockResolvedValue({
        ok: true,
        values: { ...defaults, greeting: "Hei" },
      });

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      const field = screen.getByTestId("plugin-setting-input-greeting");
      await userEvent.clear(field);
      await userEvent.type(field, "Hei");
      // Still nothing saved: a plugin must not hear a user's keystrokes one
      // at a time.
      expect(bridgeMock.setPluginSettings).not.toHaveBeenCalled();

      await userEvent.tab();

      expect(bridgeMock.setPluginSettings).toHaveBeenCalledTimes(1);
      expect(bridgeMock.setPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        pluginId: "hello-plugin",
        values: { greeting: "Hei" },
      });
    });

    it("saves a number as a number, not as the text that was typed", async () => {
      withSettings();
      bridgeMock.setPluginSettings.mockResolvedValue({
        ok: true,
        values: { ...defaults, repeat: 4 },
      });

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      const field = screen.getByTestId("plugin-setting-input-repeat");
      await userEvent.clear(field);
      await userEvent.type(field, "4");
      await userEvent.tab();

      expect(bridgeMock.setPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        pluginId: "hello-plugin",
        values: { repeat: 4 },
      });
    });

    it("saves nothing when a number field is left empty, and shows the stored value again", async () => {
      withSettings();

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      const field = screen.getByTestId("plugin-setting-input-repeat");
      await userEvent.clear(field);
      await userEvent.tab();

      expect(bridgeMock.setPluginSettings).not.toHaveBeenCalled();
      expect((field as HTMLInputElement).value).toBe("1");
    });

    it("offers Reset only for a setting that is not at its default", async () => {
      withSettings({ ...defaults, greeting: "Hei" });
      bridgeMock.setPluginSettings.mockResolvedValue({
        ok: true,
        values: defaults,
      });

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      const greetingRow = screen.getByTestId("plugin-setting-greeting");
      const shoutRow = screen.getByTestId("plugin-setting-shout");
      expect(within(shoutRow).queryByRole("button", { name: "Reset" })).toBeNull();

      await userEvent.click(
        within(greetingRow).getByRole("button", { name: "Reset" }),
      );

      expect(bridgeMock.setPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        pluginId: "hello-plugin",
        values: { greeting: "Hello" },
      });
    });

    it("says so when a save is refused", async () => {
      withSettings();
      bridgeMock.setPluginSettings.mockResolvedValue({
        ok: false,
        message: 'Setting "shout" of plugin "hello-plugin" must be a boolean.',
      });

      renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      await userEvent.click(screen.getByRole("switch", { name: "Shout" }));

      const alert = await screen.findByTestId("plugin-settings-error");
      expect(alert.textContent).toContain("dohc could not save this setting.");
      expect(alert.textContent).toContain("must be a boolean");
    });

    function greetingField(): HTMLInputElement {
      return screen.getByTestId(
        "plugin-setting-input-greeting",
      ) as HTMLInputElement;
    }

    // Both pins switch plugin on a page that is already showing the section,
    // so nothing unmounts and the request token is the only thing that can
    // refuse the answer the reader walked away from. Switching before the
    // section mounts proves nothing: there is no losing request to lose.
    function withTwoPlugins() {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [
          plugin("hello-plugin", { settings: declared }),
          plugin("other-plugin", { settings: declared }),
        ],
      });
    }

    it("asks the workspace it is showing, and paints that workspace's values", async () => {
      withTwoPlugins();
      bridgeMock.getPluginSettings.mockImplementation(
        ({ workspaceId }: { workspaceId: string }) =>
          Promise.resolve({
            ok: true,
            values: workspaceId === "ws-old"
              ? defaults
              : { ...defaults, greeting: "New" },
          }),
      );

      const view = render(
        <PluginDetailsPage workspaceId="ws-old" pluginId="hello-plugin" />,
      );
      await waitFor(() => expect(greetingField().value).toBe("Hello"));

      view.rerender(
        <PluginDetailsPage workspaceId="ws-new" pluginId="hello-plugin" />,
      );

      await waitFor(() => expect(greetingField().value).toBe("New"));
      expect(bridgeMock.getPluginSettings).toHaveBeenCalledWith({
        workspaceId: "ws-new",
        pluginId: "hello-plugin",
      });
    });

    it("never paints the plugin the reader left onto the one they opened", async () => {
      const slowLoad = deferred<{ ok: true; values: Record<string, unknown> }>();
      withTwoPlugins();
      bridgeMock.getPluginSettings.mockImplementation(
        ({ pluginId }: { pluginId: string }) =>
          pluginId === "hello-plugin"
            ? slowLoad.promise
            : Promise.resolve({
              ok: true,
              values: { ...defaults, greeting: "Other" },
            }),
      );

      const view = renderPage("hello-plugin");
      // Mounted, and its load issued: only now is there an answer to lose.
      const section = await screen.findByTestId("plugin-settings");
      await waitFor(() =>
        expect(bridgeMock.getPluginSettings).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          pluginId: "hello-plugin",
        })
      );

      view.rerender(
        <PluginDetailsPage workspaceId="ws-1" pluginId="other-plugin" />,
      );
      await waitFor(() => expect(greetingField().value).toBe("Other"));
      expect(screen.getByTestId("plugin-settings")).toBe(section);

      await act(async () => {
        slowLoad.resolve({ ok: true, values: { ...defaults, greeting: "Hei" } });
        await slowLoad.promise;
      });

      expect(greetingField().value).toBe("Other");
    });

    it("never paints a save the reader left onto the plugin they opened", async () => {
      const slowSave = deferred<{ ok: true; values: Record<string, unknown> }>();
      withTwoPlugins();
      bridgeMock.getPluginSettings.mockImplementation(
        ({ pluginId }: { pluginId: string }) =>
          Promise.resolve({
            ok: true,
            values: pluginId === "hello-plugin"
              ? defaults
              : { ...defaults, greeting: "Other" },
          }),
      );
      bridgeMock.setPluginSettings.mockReturnValue(slowSave.promise);

      const view = renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      await userEvent.click(screen.getByRole("switch", { name: "Shout" }));
      expect(bridgeMock.setPluginSettings).toHaveBeenCalled();
      const section = screen.getByTestId("plugin-settings");

      view.rerender(
        <PluginDetailsPage workspaceId="ws-1" pluginId="other-plugin" />,
      );
      await waitFor(() => expect(greetingField().value).toBe("Other"));
      expect(screen.getByTestId("plugin-settings")).toBe(section);

      await act(async () => {
        slowSave.resolve({
          ok: true,
          values: { ...defaults, greeting: "Hei", shout: true },
        });
        await slowSave.promise;
      });

      expect(greetingField().value).toBe("Other");
      expect(
        screen.getByRole("switch", { name: "Shout" }).getAttribute("aria-checked"),
      ).toBe("false");
    });

    it("says nothing about a save that failed for the plugin the reader left", async () => {
      const slowSave = deferred<{ ok: true; values: Record<string, unknown> }>();
      withTwoPlugins();
      bridgeMock.getPluginSettings.mockImplementation(
        ({ pluginId }: { pluginId: string }) =>
          Promise.resolve({
            ok: true,
            values: pluginId === "hello-plugin"
              ? defaults
              : { ...defaults, greeting: "Other" },
          }),
      );
      bridgeMock.setPluginSettings.mockReturnValue(slowSave.promise);

      const view = renderPage("hello-plugin");
      await screen.findByTestId("plugin-setting-input-greeting");
      await userEvent.click(screen.getByRole("switch", { name: "Shout" }));

      view.rerender(
        <PluginDetailsPage workspaceId="ws-1" pluginId="other-plugin" />,
      );
      await waitFor(() => expect(greetingField().value).toBe("Other"));

      await act(async () => {
        slowSave.reject(new Error("the workspace closed"));
        await slowSave.promise.catch(() => undefined);
      });

      // The failure belongs to the plugin the reader left. Shown here, it
      // blames the plugin now on screen for something it never did.
      expect(screen.queryByTestId("plugin-settings-error")).toBeNull();
    });
  });
});

// The right rail states what dohc knows about this plugin as an installation.
// The rule these pins exist to hold: a row appears only where its fact
// exists. dohc has no marketplace, so a marketplace row would have to be
// invented, and an invented row is worse than a missing one.
describe("the details rail", () => {
  const REPOSITORY = "https://github.com/pingdotgg/t3code";
  const ISSUES = "https://github.com/pingdotgg/t3code/issues";

  function railRow(testId: string): HTMLElement | null {
    return screen.queryByTestId(testId);
  }

  async function renderRail(overrides: Partial<PluginStatusRecord> = {}) {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code", overrides)],
    });
    renderPage("t3-code");
    return await screen.findByTestId("plugin-details-rail");
  }

  it("shows every fact the manifest declared", async () => {
    const rail = await renderRail({
      pluginVersion: "0.0.33",
      repository: REPOSITORY,
      issues: ISSUES,
      license: "MIT",
    });

    expect(within(rail).getByText("Installation")).toBeTruthy();
    expect(within(rail).getByText("Resources")).toBeTruthy();
    expect(railRow("plugin-rail-version")!.textContent).toContain("0.0.33");
    expect(railRow("plugin-rail-license")!.textContent).toContain("MIT");
    // The link text drops the scheme so a 15rem rail can show the rest of
    // the address; the href stays the whole URL.
    const repository = within(railRow("plugin-rail-repository")!)
      .getByRole("link");
    expect(repository.getAttribute("href")).toBe(REPOSITORY);
    expect(repository.textContent).toBe("github.com/pingdotgg/t3code");
    expect(
      within(railRow("plugin-rail-issues")!).getByRole("link")
        .getAttribute("href"),
    ).toBe(ISSUES);
  });

  // Absence is the pin, not a blank row: a reader must never have to work out
  // whether dohc lost a fact or the plugin never declared one.
  it("renders no row and no heading for a fact the manifest never declared", async () => {
    const rail = await renderRail();

    expect(railRow("plugin-rail-version")).toBeNull();
    expect(railRow("plugin-rail-repository")).toBeNull();
    expect(railRow("plugin-rail-issues")).toBeNull();
    expect(railRow("plugin-rail-license")).toBeNull();
    // Every Resources row was absent, so the section prints no heading.
    expect(within(rail).queryByText("Resources")).toBeNull();
    // Installation always has the identifier, so it keeps its heading.
    expect(within(rail).getByText("Installation")).toBeTruthy();
  });

  // dohc has no marketplace and no plugin taxonomy. VS Code's Marketplace and
  // Categories sections have no honest content here, so they do not exist.
  it("shows no marketplace or categories section", async () => {
    const rail = await renderRail({
      pluginVersion: "0.0.33",
      repository: REPOSITORY,
      license: "MIT",
    });

    expect(within(rail).queryByText("Marketplace")).toBeNull();
    expect(within(rail).queryByText("Categories")).toBeNull();
    // Nothing in this rail claims a date. The pipeline records no install or
    // approval time anywhere, so any date here would be invented.
    expect(within(rail).queryByText(/Last updated/i)).toBeNull();
    expect(within(rail).queryByText(/Released/i)).toBeNull();
  });

  // dohc's own version-of-record, which a marketplace cannot give: the
  // content hash of the source the user approved, which is what actually runs.
  it("shows the approved source hash from the record", async () => {
    await renderRail({ approvedHash: HASH_B });

    const row = railRow("plugin-rail-approved-source")!;
    expect(row.textContent).toContain(HASH_B.slice(0, 12));
    // Truncated for the eye, whole for anyone comparing it.
    expect(within(row).getByTitle(HASH_B)).toBeTruthy();
    // Never the live source hash, which can differ from what was approved.
    expect(row.textContent).not.toContain(HASH_A.slice(0, 12));
  });

  it("shows no approved source row for a plugin that was never installed", async () => {
    await renderRail({
      status: "discovered",
      approvedHash: null,
      installedBaselineHash: null,
      runtimeStatus: null,
    });

    expect(railRow("plugin-rail-approved-source")).toBeNull();
  });

  it("measures sizes after the page paints and formats them like the uninstall dialog", async () => {
    const slow = deferred<{
      ok: true;
      sizes: { installedBytes: number; dataBytes: number };
    }>();
    bridgeMock.pluginSizes.mockReturnValue(slow.promise);

    await renderRail();

    // A quiet placeholder while the walk runs, never a fabricated zero.
    expect(railRow("plugin-rail-installed-size")!.textContent).toContain(
      "Measuring",
    );
    expect(railRow("plugin-rail-stored-data")!.textContent).toContain(
      "Measuring",
    );

    await act(async () => {
      slow.resolve({
        ok: true,
        sizes: { installedBytes: 1_572_864, dataBytes: 40 },
      });
      await slow.promise;
    });

    // The preflight's own formatter: 1.5 MB, and 40 bytes rather than 0.0 MB.
    await waitFor(() =>
      expect(railRow("plugin-rail-installed-size")!.textContent).toContain(
        "1.5 MB",
      )
    );
    expect(railRow("plugin-rail-stored-data")!.textContent).toContain(
      "40 bytes",
    );
    expect(bridgeMock.pluginSizes).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "t3-code",
    });
  });

  it("drops a size row for a directory that holds nothing", async () => {
    bridgeMock.pluginSizes.mockResolvedValue({
      ok: true,
      sizes: { installedBytes: 4096, dataBytes: null },
    });

    await renderRail();

    await waitFor(() =>
      expect(railRow("plugin-rail-installed-size")!.textContent).toContain(
        "4 KB",
      )
    );
    // The plugin has written no data, so there is no stored-data fact to show.
    expect(railRow("plugin-rail-stored-data")).toBeNull();
  });

  it("shows no size rows when dohc could not measure", async () => {
    bridgeMock.pluginSizes.mockResolvedValue({
      ok: false,
      error: { stage: "discovery", code: "boom", message: "no" },
    });

    await renderRail();

    await waitFor(() => expect(railRow("plugin-rail-installed-size")).toBeNull());
    expect(railRow("plugin-rail-stored-data")).toBeNull();
  });

  // The async-guard invariant, proved where the guard is the only thing
  // holding it. Switching plugin on an already-loaded catalog keeps this rail
  // mounted, so a slow measurement for the plugin the reader left can still
  // reach the live component and repaint it. The request token is what
  // refuses it.
  it("cannot paint one plugin's sizes onto another", async () => {
    const slow = deferred<{
      ok: true;
      sizes: { installedBytes: number; dataBytes: number };
    }>();
    bridgeMock.pluginSizes.mockReturnValueOnce(slow.promise);
    bridgeMock.pluginSizes.mockResolvedValue({
      ok: true,
      sizes: { installedBytes: 40, dataBytes: null },
    });
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code"), plugin("other-plugin")],
    });

    const view = render(
      <PluginDetailsPage workspaceId="ws-1" pluginId="t3-code" />,
    );
    const rail = await screen.findByTestId("plugin-details-rail");

    view.rerender(
      <PluginDetailsPage workspaceId="ws-1" pluginId="other-plugin" />,
    );
    await waitFor(() =>
      expect(railRow("plugin-rail-installed-size")!.textContent).toContain(
        "40 bytes",
      )
    );
    // The same rail element throughout: nothing unmounted, so nothing but the
    // token can be refusing the stale answer.
    expect(screen.getByTestId("plugin-details-rail")).toBe(rail);

    // The t3-code answer lands late. It must not overwrite other-plugin.
    await act(async () => {
      slow.resolve({
        ok: true,
        sizes: { installedBytes: 999_999_999, dataBytes: 999_999_999 },
      });
      await slow.promise;
    });

    expect(railRow("plugin-rail-installed-size")!.textContent).toContain(
      "40 bytes",
    );
    expect(railRow("plugin-rail-stored-data")).toBeNull();
  });

  // The workspace case reaches the same invariant by a different road: the
  // catalog goes back to loading, so the whole rail unmounts and re-measures
  // against the workspace now on screen. Pinned because the rail must ask for
  // the new workspace, not keep showing the old one's numbers.
  it("re-measures for the workspace the reader switched to", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code")],
    });
    bridgeMock.pluginSizes.mockResolvedValue({
      ok: true,
      sizes: { installedBytes: 4096, dataBytes: null },
    });

    const view = render(
      <PluginDetailsPage workspaceId="ws-1" pluginId="t3-code" />,
    );
    await screen.findByTestId("plugin-details-rail");

    view.rerender(
      <PluginDetailsPage workspaceId="ws-2" pluginId="t3-code" />,
    );

    await waitFor(() =>
      expect(bridgeMock.pluginSizes).toHaveBeenCalledWith({
        workspaceId: "ws-2",
        pluginId: "t3-code",
      })
    );
  });

  // The only route from this renderer to the OS browser is the audited
  // openExternalUrl IPC. A bare window.open would leave the gate behind.
  it("opens a resource link through the audited external-open path", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    try {
      await renderRail({ repository: REPOSITORY });

      await userEvent.click(
        within(railRow("plugin-rail-repository")!).getByRole("link"),
      );

      expect(bridgeMock.openExternalUrl).toHaveBeenCalledWith({
        url: REPOSITORY,
      });
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders a license that is not a URL as plain text", async () => {
    await renderRail({ license: "MIT" });

    const row = railRow("plugin-rail-license")!;
    expect(row.textContent).toContain("MIT");
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("renders a license that is a URL as a link", async () => {
    const licenseUrl = "https://example.com/LICENSE";
    await renderRail({ license: licenseUrl });

    expect(
      within(railRow("plugin-rail-license")!).getByRole("link")
        .getAttribute("href"),
    ).toBe(licenseUrl);
  });

  // Structural, not visual: jsdom runs no layout engine and resolves no media
  // query, so this pins the classes that decide the two layouts rather than
  // the pixels they produce. A wide window puts the rail beside the content;
  // a narrow one drops it below, so the README never scrolls sideways.
  it("stacks below the content on a narrow window", async () => {
    const rail = await renderRail();

    const className = rail.getAttribute("class") ?? "";
    expect(className).toContain("w-full");
    expect(className).toContain("border-t");
    expect(className).toContain("lg:w-60");
    expect(className).toContain("lg:border-l");
    expect(className).toContain("lg:border-t-0");
    expect(rail.parentElement?.getAttribute("class")).toContain("lg:flex-row");
  });
});
