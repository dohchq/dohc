// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginStatusChangedEvent,
  PluginStatusRecord,
} from "../../ipc/bridgeContract";
import { PluginsView } from "./PluginsView";
import { deferred } from "../../testing/deferred";

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
    displayName: null,
    description: null,
    publisher: null,
    pluginVersion: null,
    repository: null,
    issues: null,
    license: null,
    icon: null,
    settings: [],
    commands: [],
    panels: [],
    webApps: [],
    hasFailedReplacement: false,
    diagnostics: [],
    warnings: [],
    error: null,
    ...overrides,
  };
}

const noop = () => undefined;

function renderList(
  overrides: {
    workspaceId?: string;
    activePluginId?: string | null;
    activePluginDirectoryName?: string | null;
    onOpenDetails?: (pluginId: string, directoryName: string) => void;
  } = {},
) {
  return render(
    <PluginsView
      workspaceId={overrides.workspaceId ?? "ws-1"}
      activePluginId={overrides.activePluginId ?? null}
      activePluginDirectoryName={overrides.activePluginDirectoryName ?? null}
      onOpenDetails={overrides.onOpenDetails ?? noop}
    />,
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

    const view = renderList({ workspaceId: "ws-old" });
    expect(bridgeMock.listPlugins).toHaveBeenCalledWith({ workspaceId: "ws-old" });

    view.rerender(
      <PluginsView workspaceId="ws-new" activePluginId={null} activePluginDirectoryName={null} onOpenDetails={noop} />,
    );
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

  it("opens the plugin's details tab when the row is clicked", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code")],
    });
    const onOpenDetails = vi.fn();

    renderList({ onOpenDetails });
    await userEvent.click(await screen.findByTestId("plugin-open-details"));

    expect(onOpenDetails).toHaveBeenCalledWith("t3-code", "t3-code");
  });

  it("installs from the row without opening the details tab", async () => {
    const candidate = plugin("fresh-plugin", {
      status: "discovered",
      runtimeStatus: null,
      sourceHash: null,
      approvedHash: null,
      installedBaselineHash: null,
    });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [candidate] });
    bridgeMock.installPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("fresh-plugin"),
    });
    const onOpenDetails = vi.fn();

    renderList({ onOpenDetails });
    await userEvent.click(await screen.findByTestId("plugin-install"));

    expect(bridgeMock.installPlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pluginId: "fresh-plugin",
    });
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it("marks the row whose details tab is active", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code"), plugin("other-plugin")],
    });

    const view = renderList({ activePluginId: null });
    const rows = await screen.findAllByTestId("plugin-row");
    expect(rows.every((row) => row.getAttribute("data-selected") === null)).toBe(
      true,
    );

    view.rerender(
      <PluginsView
        workspaceId="ws-1"
        activePluginId="t3-code"
        activePluginDirectoryName="t3-code"
        onOpenDetails={noop}
      />,
    );
    const selected = screen
      .getAllByTestId("plugin-row")
      .filter((row) => row.getAttribute("data-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute("data-plugin-id")).toBe("t3-code");
  });

  it("keeps every action except Install off the row", async () => {
    // The row says what a plugin is; the details tab is where it is acted on.
    // A plugin that could offer all of them proves none leaked back.
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("ready-plugin", {
          webApps: [{ id: "app", title: "T3 Code", instanced: false }],
        }),
        plugin("approval-plugin", {
          status: "disabled-pending-approval",
          disabledReason: "approval",
          runtimeStatus: "disabled",
          sourceHash: HASH_B,
        }),
        plugin("disabled-plugin", {
          status: "disabled",
          disabledReason: "user",
          runtimeStatus: null,
        }),
      ],
    });

    renderList();
    await screen.findByText("ready-plugin");

    expect(screen.queryByTestId("plugin-open-web-app")).toBeNull();
    expect(screen.queryByTestId("plugin-disable")).toBeNull();
    expect(screen.queryByTestId("plugin-enable")).toBeNull();
    expect(screen.queryByTestId("plugin-approve")).toBeNull();
    expect(screen.queryByTestId("plugin-uninstall")).toBeNull();
    expect(screen.queryByTestId("plugin-retry-install")).toBeNull();
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

    renderList();

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

  it("shows each plugin's status and folder on the row", async () => {
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
          directoryName: "approval-plugin-src",
        }),
      ],
    });

    renderList();

    expect(await screen.findByText("Disabled after repeated crashes")).toBeTruthy();
    expect(screen.getByText("Disabled — approval required")).toBeTruthy();
    // The folder is shown only when it is a second name worth reading.
    expect(screen.getByText("plugins/approval-plugin-src")).toBeTruthy();
    expect(screen.queryByText("plugins/crash-plugin")).toBeNull();
  });

  it("narrows the list to the plugins matching what the user typed", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("t3-code"),
        plugin("notes-widget", { directoryName: "notes-widget-src" }),
      ],
    });

    renderList();
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
    const filterEmpty = screen.getByTestId("plugins-filter-empty");
    expect(filterEmpty.textContent).toContain('No plugins match "nothing-here"');
    expect(within(filterEmpty).getByRole("img", { name: "dohc" })).toBeTruthy();

    await userEvent.clear(filter);
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);
  });

  describe("manifest metadata", () => {
    const described = () =>
      plugin("t3-code", {
        displayName: "T3 Code",
        description: "Runs the t3 coding agent server on this workspace.",
        publisher: "dohc",
        icon: "icon.svg",
      });

    it("shows the plugin's name, description, publisher, and icon", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [described()],
      });

      renderList();

      expect(await screen.findByText("T3 Code")).toBeTruthy();
      expect(screen.getByTestId("plugin-description").textContent).toBe(
        "Runs the t3 coding agent server on this workspace.",
      );
      expect(screen.getByTestId("plugin-publisher").textContent).toBe("dohc");
      const icon = screen.getByTestId("plugin-icon");
      expect(icon.getAttribute("src")).toBe(
        "dohc-file://ws-1/plugins/t3-code/icon.svg",
      );
      // The name is beside it, so the icon adds nothing for a screen reader.
      expect(icon.getAttribute("alt")).toBe("");
    });

    it("falls back to the id and the glyph when the manifest says nothing", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [plugin("bare-plugin")],
      });

      renderList();

      expect(await screen.findByText("bare-plugin")).toBeTruthy();
      expect(screen.queryByTestId("plugin-description")).toBeNull();
      expect(screen.queryByTestId("plugin-publisher")).toBeNull();
      expect(screen.queryByTestId("plugin-icon")).toBeNull();
    });

    it("keeps the row when the icon file fails to load", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [described()],
      });

      renderList();
      const icon = await screen.findByTestId("plugin-icon");
      await act(async () => {
        fireEvent.error(icon);
      });

      expect(screen.queryByTestId("plugin-icon")).toBeNull();
      // The row itself survives: an icon is decoration, never the row.
      expect(screen.getByTestId("plugin-row")).toBeTruthy();
      expect(screen.getByText("T3 Code")).toBeTruthy();
    });

    it("finds a plugin by its description and by its publisher", async () => {
      bridgeMock.listPlugins.mockResolvedValue({
        ok: true,
        plugins: [described(), plugin("notes-widget")],
      });

      renderList();
      await screen.findByText("T3 Code");
      const filter = screen.getByTestId("plugins-filter");

      // Nothing in the id, folder, or display name spells "coding agent".
      await userEvent.type(filter, "coding agent");
      expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
      expect(screen.getByTestId("plugin-row").getAttribute("data-plugin-id"))
        .toBe("t3-code");

      await userEvent.clear(filter);
      await userEvent.type(filter, "dohc");
      expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);

      await userEvent.clear(filter);
      await userEvent.type(filter, "T3 Code");
      expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
    });
  });

  it("tells the user where plugins come from when the workspace has none", async () => {
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [] });

    renderList();

    const empty = await screen.findByTestId("plugins-empty");
    expect(empty.textContent).toContain("No plugins yet");
    expect(empty.textContent).toContain("plugins/");
    expect(screen.queryByTestId("plugins-filter-empty")).toBeNull();
    // The brand mark, not a generic lucide glyph: EmptyState's own default.
    expect(within(empty).getByRole("img", { name: "dohc" })).toBeTruthy();
  });

  it("shows a busy Install and an actionable error when the install fails", async () => {
    const installResult = deferred<{
      ok: false;
      error: { stage: "install"; code: string; message: string };
      plugin: null;
    }>();
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
    bridgeMock.installPlugin.mockReturnValue(installResult.promise);

    renderList();
    const installButton = await screen.findByTestId("plugin-install");
    await userEvent.click(installButton);

    expect(installButton.textContent).toBe("Installing");
    expect((installButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      installResult.resolve({
        ok: false,
        error: {
          stage: "install",
          code: "install-failed",
          message: "The registry refused the request.",
        },
        plugin: null,
      });
      await installResult.promise;
    });

    expect((await screen.findByTestId("plugin-action-error")).textContent).toContain(
      "dohc could not install fresh-plugin. The registry refused the request.",
    );
    expect(installButton.textContent).toBe("Install");
    await waitFor(() =>
      expect((installButton as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("surfaces the real reason and offers a retry when the plugin list fails to load", async () => {
    bridgeMock.listPlugins.mockResolvedValueOnce({
      ok: false,
      error: {
        stage: "discovery",
        code: "discovery-failed",
        message: "The plugin pipeline could not start.",
      },
    });

    renderList();

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

  it("merges a status event newer than the in-flight list response", async () => {
    const list = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    bridgeMock.listPlugins.mockReturnValue(list.promise);

    renderList();
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

  it("merges each directory's events when colliding ids arrive during initial load", async () => {
    const list = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    bridgeMock.listPlugins.mockReturnValue(list.promise);
    renderList();
    await waitFor(() => expect(statusListener).not.toBeNull());
    act(() => {
      for (const directoryName of ["chat-a", "chat-b"]) {
        statusListener?.({
          kind: "changed",
          workspaceId: "ws-1",
          plugin: plugin("chat-plugin", { directoryName, displayName: directoryName }),
        });
      }
    });
    await act(async () => {
      list.resolve({ ok: true, plugins: [] });
      await list.promise;
    });
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);
    expect(screen.getByText("chat-a")).toBeTruthy();
    expect(screen.getByText("chat-b")).toBeTruthy();
  });

  it("does not restore the old directory from an action that settles after a rename", async () => {
    const original = plugin("chat-plugin", { directoryName: "chat-a", displayName: "Chat", status: "discovered", approvedHash: null, runtimeStatus: null });
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [original] });
    const install = deferred<{ ok: true; plugin: PluginStatusRecord }>();
    bridgeMock.installPlugin.mockReturnValue(install.promise);
    renderList();
    await userEvent.click(await screen.findByTestId("plugin-install"));
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [{ ...original, directoryName: "chat-b", status: "disabled", disabledReason: "user" }],
    });
    act(() => {
      statusListener?.({ kind: "renamed", workspaceId: "ws-1", pluginId: "chat-plugin", from: "chat-a", to: "chat-b" });
      statusListener?.({ kind: "changed", workspaceId: "ws-1", plugin: { ...original, directoryName: "chat-b", status: "disabled", disabledReason: "user" } });
    });
    await act(async () => {
      install.resolve({ ok: true, plugin: { ...original, status: "disabled", disabledReason: "user" } });
      await install.promise;
    });
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
  });

  it("keeps a renamed row while its authoritative list supersedes an older refresh", async () => {
    const original = plugin("app", { directoryName: "old-app", displayName: "App" });
    const older = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    const renamed = deferred<{ ok: true; plugins: PluginStatusRecord[] }>();
    bridgeMock.listPlugins.mockResolvedValueOnce({ ok: true, plugins: [original] })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(renamed.promise);
    renderList();
    await screen.findByText("plugins/old-app");

    act(() => statusListener?.({ kind: "discovery-changed", workspaceId: "ws-1" }));
    act(() => statusListener?.({
      kind: "renamed", workspaceId: "ws-1", pluginId: "app", from: "old-app", to: "new-app",
    }));
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(3);
    expect(screen.getByText("plugins/new-app")).toBeTruthy();
    expect(screen.queryByText("plugins/old-app")).toBeNull();

    await act(async () => {
      older.resolve({ ok: true, plugins: [original] });
      await older.promise;
    });
    expect(screen.getByText("plugins/new-app")).toBeTruthy();
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);

    act(() => statusListener?.({
      kind: "changed", workspaceId: "ws-1",
      plugin: { ...original, directoryName: "new-app", rootPath: "/workspace/plugins/new-app", status: "starting" },
    }));
    await act(async () => {
      renamed.resolve({ ok: true, plugins: [{ ...original, directoryName: "new-app", rootPath: "/workspace/plugins/new-app" }] });
      await renamed.promise;
    });
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
    expect(screen.getByTestId("plugin-status").getAttribute("data-status")).toBe("starting");
  });

  it("lets a status event newer than an in-flight action's response win", async () => {
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

    renderList();
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

  it("shows the row's own install failure, not another row's", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("first-plugin", {
          status: "discovered",
          runtimeStatus: null,
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
        }),
        plugin("second-plugin", {
          status: "discovered",
          runtimeStatus: null,
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
        }),
      ],
    });
    bridgeMock.installPlugin.mockResolvedValue({
      ok: false,
      error: { stage: "install", code: "install-failed", message: "No network." },
      plugin: null,
    });

    renderList();
    const rows = await screen.findAllByTestId("plugin-row");
    const firstRow = rows.find(
      (row) => row.getAttribute("data-plugin-id") === "first-plugin",
    )!;
    await userEvent.click(within(firstRow).getByTestId("plugin-install"));

    const errors = await screen.findAllByTestId("plugin-action-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain("first-plugin");
  });

  it("frees the Install control once a status event finishes the pipeline", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("fresh-plugin", {
          status: "building",
          runtimeStatus: null,
          sourceHash: HASH_A,
          approvedHash: null,
          installedBaselineHash: null,
        }),
      ],
    });

    renderList();
    // A pipeline that is mid-build owns the plugin; the row must not offer a
    // second Install on top of the one already running.
    await screen.findByTestId("plugin-row");
    expect(screen.queryByTestId("plugin-install")).toBeNull();

    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("fresh-plugin", {
          status: "discovered",
          runtimeStatus: null,
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
        }),
      });
    });

    const install = await screen.findByTestId("plugin-install");
    await waitFor(() =>
      expect((install as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("drops a plugin the pipeline removed", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("going-plugin"), plugin("staying-plugin")],
    });

    renderList();
    await screen.findByText("going-plugin");

    act(() => {
      statusListener?.({
        kind: "removed",
        workspaceId: "ws-1",
        pluginId: "going-plugin",
        directoryName: "going-plugin",
      });
    });

    expect(screen.queryByText("going-plugin")).toBeNull();
    expect(screen.getByText("staying-plugin")).toBeTruthy();
  });

  it("removes only the named directory when two rows share a plugin id", async () => {
    bridgeMock.listPlugins
      .mockResolvedValueOnce({
        ok: true,
        plugins: [
          plugin("chat-plugin", { directoryName: "chat-a", displayName: "Chat A" }),
          plugin("chat-plugin", { directoryName: "chat-b", displayName: "Chat B" }),
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        plugins: [plugin("chat-plugin", { directoryName: "chat-b", displayName: "Chat B" })],
      });

    renderList();
    await screen.findByText("Chat A");
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);

    act(() => {
      statusListener?.({
        kind: "removed",
        workspaceId: "ws-1",
        pluginId: "chat-plugin",
        directoryName: "chat-a",
      });
    });

    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
    expect(screen.getByText("Chat B")).toBeTruthy();
    expect(screen.queryByText("Chat A")).toBeNull();
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("does not reload on an ordinary changed event for either row of a standing collision", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("chat-plugin", { directoryName: "chat-a", displayName: "Chat A" }),
        plugin("chat-plugin", { directoryName: "chat-b", displayName: "Chat B" }),
      ],
    });

    renderList();
    await screen.findByText("Chat A");
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(1);

    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("chat-plugin", { directoryName: "chat-a", displayName: "Chat A, updated" }),
      });
    });

    await screen.findByText("Chat A, updated");
    expect(screen.getByText("Chat B")).toBeTruthy();
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);
    // No reload — the local merge already applied it correctly, and this is
    // the case upsertPlugin was never going to get wrong.
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("keeps a survivor visible when a removal arrives before the initial load ever settles", async () => {
    const initialLoad = deferred<{
      ok: true;
      plugins: PluginStatusRecord[];
    }>();
    bridgeMock.listPlugins
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({
        ok: true,
        plugins: [plugin("chat-plugin", { directoryName: "chat-b", displayName: "Chat B" })],
      });

    renderList();

    // The initial request is still in flight — loadRef has never held a
    // ready list, so ambiguity cannot be read off it either way.
    act(() => {
      statusListener?.({
        kind: "removed",
        workspaceId: "ws-1",
        pluginId: "chat-plugin",
        directoryName: "chat-a",
      });
    });

    // What the in-flight request resolves to: a same-tick backend snapshot
    // already past the removal, showing only the survivor — exactly the
    // shape a buggy merge reads as "unambiguous".
    await act(async () => {
      initialLoad.resolve({
        ok: true,
        plugins: [plugin("chat-plugin", { directoryName: "chat-b", displayName: "Chat B" })],
      });
      await initialLoad.promise;
    });

    await waitFor(() => expect(screen.getAllByTestId("plugin-row")).toHaveLength(1));
    expect(screen.getByText("Chat B")).toBeTruthy();
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("never repaints one workspace's rows from another workspace's status event", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code")],
    });

    renderList({ workspaceId: "ws-1" });
    await screen.findByText("t3-code");

    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-other",
        plugin: plugin("intruder-plugin"),
      });
    });

    expect(screen.queryByText("intruder-plugin")).toBeNull();
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
  });

  it("keeps a filtered-out plugin out of the list when its status changes", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code"), plugin("notes-widget")],
    });

    renderList();
    await screen.findByText("t3-code");
    await userEvent.type(screen.getByTestId("plugins-filter"), "notes");
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);

    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("t3-code", { status: "crashed", runtimeStatus: null }),
      });
    });

    expect(screen.getAllByTestId("plugin-row")).toHaveLength(1);
    expect(screen.getByTestId("plugin-row").getAttribute("data-plugin-id")).toBe(
      "notes-widget",
    );
  });

  it("fires the drag-free row control only once per click", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("t3-code")],
    });
    const onOpenDetails = vi.fn();

    renderList({ onOpenDetails });
    const control = await screen.findByTestId("plugin-open-details");
    fireEvent.click(control);

    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });
});
