// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfferedPluginRecord,
  PluginStatusChangedEvent,
  PluginStatusRecord,
} from "../../ipc/bridgeContract";
import { PluginsView } from "./PluginsView";

let statusListener: ((event: PluginStatusChangedEvent) => void) | null = null;

const bridgeMock = {
  listPlugins: vi.fn(),
  listOfferedPlugins: vi.fn(),
  addOfferedPlugin: vi.fn(),
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
    panels: [],
    webApps: [],
    diagnostics: [],
    warnings: [],
    error: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
  bridgeMock.listOfferedPlugins.mockResolvedValue({ ok: true, offers: [] });
});

afterEach(() => {
  cleanup();
});

describe("PluginsView", () => {
  const offers: OfferedPluginRecord[] = [
    {
      directoryName: "codex",
      displayName: "Codex",
      description: "Runs the Codex CLI on this workspace as a dohc agent.",
      publisher: "dohc",
    },
    {
      directoryName: "claude-code",
      displayName: "Claude Code",
      description: "Runs the Claude Code CLI on this workspace as a dohc agent.",
      publisher: "dohc",
    },
  ];

  it("does not flash the empty state while offers are still loading", async () => {
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [] });
    const offersResult = deferred<{ ok: true; offers: OfferedPluginRecord[] }>();
    bridgeMock.listOfferedPlugins.mockReturnValue(offersResult.promise);

    renderList();

    // listPlugins' fast resolve settles catalog.load to ready/empty while
    // listOfferedPlugins is still deliberately unresolved: without the
    // fix, "No plugins yet" would paint here and then get replaced the
    // instant offers arrive.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("plugins-empty")).toBeNull();

    await act(async () => {
      offersResult.resolve({ ok: true, offers: [offers[0]] });
      await offersResult.promise;
    });

    expect(await screen.findByTestId("plugin-offer-row")).toBeTruthy();
    expect(screen.queryByTestId("plugins-empty")).toBeNull();
  });

  it("shows both offered driver plugins when the workspace has no plugins", async () => {
    bridgeMock.listOfferedPlugins.mockResolvedValue({ ok: true, offers });

    renderList();

    const section = await screen.findByTestId("plugins-section-offered");
    expect(within(section).getAllByTestId("plugin-offer-row")).toHaveLength(2);
    expect(within(section).getByText("Codex")).toBeTruthy();
    expect(within(section).getByText("Claude Code")).toBeTruthy();
  });

  it("drops a stale offer list after switching workspaces", async () => {
    const oldList = deferred<{ ok: true; offers: OfferedPluginRecord[] }>();
    const newList = deferred<{ ok: true; offers: OfferedPluginRecord[] }>();
    bridgeMock.listOfferedPlugins.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === "ws-old" ? oldList.promise : newList.promise,
    );

    const view = renderList({ workspaceId: "ws-old" });
    view.rerender(
      <PluginsView workspaceId="ws-new" activePluginId={null} activePluginDirectoryName={null} onOpenDetails={noop} />,
    );
    // Synchronously after the switch, before either bridge call resolves:
    // neither workspace's offers show. usePluginCatalog tags every non-
    // loading offers state with the workspaceId it was fetched for and
    // checks that tag on every render, so a workspace switch can never
    // paint a still-pending or still-resolving fetch's stale data.
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.queryByText("Claude Code")).toBeNull();

    await act(async () => {
      newList.resolve({ ok: true, offers: [offers[1]] });
      await newList.promise;
    });
    expect(await screen.findByText("Claude Code")).toBeTruthy();

    await act(async () => {
      oldList.resolve({ ok: true, offers: [offers[0]] });
      await oldList.promise;
    });
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeTruthy();
  });

  it("does not offer a driver plugin already present in the workspace", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("codex")],
    });
    bridgeMock.listOfferedPlugins.mockResolvedValue({
      ok: true,
      offers: [offers[1]],
    });

    renderList();

    const section = await screen.findByTestId("plugins-section-offered");
    expect(within(section).queryByText("Codex")).toBeNull();
    expect(within(section).getByText("Claude Code")).toBeTruthy();
  });

  it("adds an offered plugin and removes its row without reloading offers", async () => {
    bridgeMock.listOfferedPlugins.mockResolvedValue({ ok: true, offers });
    bridgeMock.addOfferedPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("codex", {
        status: "discovered",
        runtimeStatus: null,
        sourceHash: null,
        approvedHash: null,
        installedBaselineHash: null,
      }),
    });

    renderList();
    const codexRow = (await screen.findAllByTestId("plugin-offer-row")).find(
      (row) => row.getAttribute("data-plugin-directory") === "codex",
    );
    expect(codexRow).toBeTruthy();

    await userEvent.click(within(codexRow!).getByTestId("plugin-offer-add"));

    expect(bridgeMock.addOfferedPlugin).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      directoryName: "codex",
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId("plugin-offer-row")?.getAttribute("data-plugin-directory"),
      ).toBe("claude-code"),
    );
    expect(bridgeMock.listOfferedPlugins).toHaveBeenCalledTimes(1);
  });

  it("offers a plugin again once it is uninstalled (removed status event)", async () => {
    bridgeMock.listOfferedPlugins
      .mockResolvedValueOnce({ ok: true, offers: [offers[0]] })
      .mockResolvedValueOnce({ ok: true, offers: [offers[0]] });
    bridgeMock.addOfferedPlugin.mockResolvedValue({
      ok: true,
      plugin: plugin("codex", {
        status: "discovered",
        runtimeStatus: null,
        sourceHash: null,
        approvedHash: null,
        installedBaselineHash: null,
      }),
    });

    renderList();
    await userEvent.click(await screen.findByTestId("plugin-offer-add"));
    await waitFor(() => expect(screen.queryByTestId("plugin-offer-row")).toBeNull());

    act(() => {
      statusListener?.({
        kind: "removed",
        workspaceId: "ws-1",
        pluginId: "codex",
        directoryName: "codex",
      });
    });

    expect(await screen.findByTestId("plugin-offer-row")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(bridgeMock.listOfferedPlugins).toHaveBeenCalledTimes(2);
  });

  it("drops an offer once a changed status event introduces its id under another directory", async () => {
    bridgeMock.listOfferedPlugins
      .mockResolvedValueOnce({ ok: true, offers: [offers[0]] })
      .mockResolvedValueOnce({ ok: true, offers: [] });

    renderList();
    expect(await screen.findByTestId("plugin-offer-row")).toBeTruthy();

    act(() => {
      // Something other than this hook's own Add discovered "codex" under a
      // renamed directory — an agent's own copy, a second client. The
      // catalog does not know why, only that the identity now exists.
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("codex", { directoryName: "my-codex" }),
      });
    });

    await waitFor(() => expect(screen.queryByTestId("plugin-offer-row")).toBeNull());
    expect(bridgeMock.listOfferedPlugins).toHaveBeenCalledTimes(2);
  });

  // Round 23 finding 3: an invalid, never-installed candidate (a broken
  // manifest, or none at all) gets no status entry of its own, so its own
  // arrival or departure names no pluginId a "changed"/"removed" event
  // could carry — creating or deleting plugins/codex with a broken
  // manifest never fires either kind. discovery-changed is the honest
  // signal instead: discovery itself moved, so offers re-check.
  it("hides an offer once an invalid directory occupies it, and returns it once that directory is gone", async () => {
    bridgeMock.listOfferedPlugins
      .mockResolvedValueOnce({ ok: true, offers: [offers[0]] })
      .mockResolvedValueOnce({ ok: true, offers: [] })
      .mockResolvedValueOnce({ ok: true, offers: [offers[0]] });

    renderList();
    expect(await screen.findByTestId("plugin-offer-row")).toBeTruthy();

    act(() => {
      // A broken manifest just landed at plugins/codex — invalid, so
      // discovery never seeds a status for it, and no "changed"/"removed"
      // event names it either.
      statusListener?.({ kind: "discovery-changed", workspaceId: "ws-1" });
    });
    await waitFor(() => expect(screen.queryByTestId("plugin-offer-row")).toBeNull());
    expect(bridgeMock.listOfferedPlugins).toHaveBeenCalledTimes(2);

    act(() => {
      // The invalid directory is deleted — the offer's own directory is
      // free again.
      statusListener?.({ kind: "discovery-changed", workspaceId: "ws-1" });
    });
    expect(await screen.findByTestId("plugin-offer-row")).toBeTruthy();
    expect(bridgeMock.listOfferedPlugins).toHaveBeenCalledTimes(3);
  });

  it("keeps the Built in section on screen while a background refresh is in flight", async () => {
    bridgeMock.listOfferedPlugins.mockResolvedValueOnce({ ok: true, offers: [offers[0]] });

    renderList();
    expect(await screen.findByTestId("plugin-offer-row")).toBeTruthy();

    const refresh = deferred<{ ok: true; offers: OfferedPluginRecord[] }>();
    bridgeMock.listOfferedPlugins.mockReturnValueOnce(refresh.promise);

    act(() => {
      // setStatus emits several "changed" events per action — each one
      // triggers a refresh, and none of them may hide the section while
      // its own fetch is still in flight.
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("some-other-plugin"),
      });
    });

    // The refresh is pending, but the previously-ready offer — row and Add
    // control both — stays rendered, not replaced by a loading state.
    const row = screen.getByTestId("plugin-offer-row");
    expect(row).toBeTruthy();
    expect(within(row).getByTestId("plugin-offer-add")).toBeTruthy();

    await act(async () => {
      refresh.resolve({ ok: true, offers: [offers[1]] });
      await refresh.promise;
    });

    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("clears a refused Add's error once the offer leaves the list, instead of leaking onto an installed row", async () => {
    bridgeMock.listPlugins.mockResolvedValue({ ok: true, plugins: [] });
    bridgeMock.listOfferedPlugins
      .mockResolvedValueOnce({ ok: true, offers: [offers[0]] })
      .mockResolvedValueOnce({ ok: true, offers: [] });
    bridgeMock.addOfferedPlugin.mockResolvedValue({
      ok: false,
      error: {
        stage: "state",
        code: "pipeline-unavailable",
        message: 'Another plugin already claims the id "codex" in this workspace.',
      },
    });

    renderList();
    await userEvent.click(await screen.findByTestId("plugin-offer-add"));
    expect(await screen.findByTestId("plugin-action-error")).toBeTruthy();

    // A refresh — a changed/removed status event — settles with the offer
    // no longer listed.
    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("some-other-plugin"),
      });
    });
    await waitFor(() => expect(screen.queryByTestId("plugin-offer-row")).toBeNull());
    expect(screen.queryByTestId("plugin-action-error")).toBeNull();

    // "codex" now shows as an installed row — a separate identity entirely
    // from the offer that used to occupy this directoryName — and must not
    // inherit the stale Add error. "some-other-plugin" (from the refresh
    // trigger above) is already a row too, so this looks up "codex" by id
    // rather than assuming it is the only row on screen.
    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("codex"),
      });
    });

    const codexRow = await waitFor(() => {
      const found = screen
        .getAllByTestId("plugin-row")
        .find((row) => row.getAttribute("data-plugin-id") === "codex");
      if (!found) throw new Error("codex row not rendered yet");
      return found;
    });
    expect(codexRow).toBeTruthy();
    expect(screen.queryByTestId("plugin-action-error")).toBeNull();
  });

  it("shows an Adding state and a named error when Add fails", async () => {
    const addResult = deferred<{
      ok: false;
      error: { stage: "state"; code: string; message: string };
    }>();
    bridgeMock.listOfferedPlugins.mockResolvedValue({
      ok: true,
      offers: [offers[0]],
    });
    bridgeMock.addOfferedPlugin.mockReturnValue(addResult.promise);

    renderList();
    const addButton = await screen.findByTestId("plugin-offer-add");
    await userEvent.click(addButton);

    expect(addButton.textContent).toBe("Adding");
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      addResult.resolve({
        ok: false,
        error: {
          stage: "state",
          code: "pipeline-unavailable",
          message: "plugins/codex already exists in this workspace.",
        },
      });
      await addResult.promise;
    });

    expect((await screen.findByTestId("plugin-action-error")).textContent).toBe(
      "dohc could not add Codex. plugins/codex already exists in this workspace.",
    );
    expect(addButton.textContent).toBe("Add");
  });

  // The interleaving the round-8 pruneToKeys work only covered from the
  // other direction (an error already recorded, then the offer leaves):
  // here the offer leaves WHILE the refused response is still in flight.
  // A stale response settling after that must not recreate a key
  // loadOffers already pruned — there is no row left on screen to show it
  // against.
  it("does not resurrect a pruned offer error when a refused Add settles after the offer already left the list", async () => {
    bridgeMock.listOfferedPlugins.mockResolvedValueOnce({ ok: true, offers: [offers[0]] });
    const addResult = deferred<{
      ok: false;
      error: { stage: "state"; code: string; message: string };
    }>();
    bridgeMock.addOfferedPlugin.mockReturnValue(addResult.promise);

    renderList();
    const addButton = await screen.findByTestId("plugin-offer-add");
    await userEvent.click(addButton);
    expect(addButton.textContent).toBe("Adding");

    // The offer leaves the authoritative list WHILE Add is still in
    // flight — added from another window, discovered under a renamed
    // directory, whatever the reason.
    bridgeMock.listOfferedPlugins.mockResolvedValueOnce({ ok: true, offers: [] });
    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("codex", { directoryName: "my-codex" }),
      });
    });
    await waitFor(() => expect(screen.queryByTestId("plugin-offer-row")).toBeNull());

    // The refused response arrives after the row is already gone.
    await act(async () => {
      addResult.resolve({
        ok: false,
        error: {
          stage: "state",
          code: "pipeline-unavailable",
          message: "plugins/codex already exists in this workspace.",
        },
      });
      await addResult.promise;
    });

    expect(screen.queryByTestId("plugin-action-error")).toBeNull();
    expect(screen.queryByTestId("plugin-offer-row")).toBeNull();
  });

  it("shows a visible offers error with a working retry, without hiding installed plugins", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [plugin("installed-plugin")],
    });
    bridgeMock.listOfferedPlugins.mockResolvedValueOnce({
      ok: false,
      error: {
        stage: "state",
        code: "pipeline-unavailable",
        message: "The plugin pipeline could not start.",
      },
    });

    renderList();

    // A rejected or {ok:false} offers load must not silently read as an
    // empty list: the installed plugin still renders, and the offers
    // section names its own failure instead of just vanishing.
    expect(await screen.findByText("installed-plugin")).toBeTruthy();
    const offersError = await screen.findByTestId("plugins-offers-error");
    expect(offersError.textContent).toContain("The plugin pipeline could not start.");
    expect(screen.queryByTestId("plugins-section-offered")).toBeNull();

    bridgeMock.listOfferedPlugins.mockResolvedValueOnce({ ok: true, offers: [offers[0]] });
    await userEvent.click(within(offersError).getByText("Retry"));

    expect(await screen.findByTestId("plugins-section-offered")).toBeTruthy();
    expect(screen.queryByTestId("plugins-offers-error")).toBeNull();
    expect(screen.getByText("installed-plugin")).toBeTruthy();
    expect(bridgeMock.listOfferedPlugins).toHaveBeenCalledTimes(2);
  });

  it("shows the offers error even when the workspace has no plugins of its own", async () => {
    bridgeMock.listOfferedPlugins.mockRejectedValueOnce(new Error("IPC unavailable"));

    renderList();

    const offersError = await screen.findByTestId("plugins-offers-error");
    expect(offersError.textContent).toContain("IPC unavailable");
    expect(screen.queryByTestId("plugins-empty")).toBeNull();
  });

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
    // MUTATION (nest the Install button inside the row's open control): the
    // click bubbles out and the user gets a tab they never asked for on top
    // of the install they did.
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

  it("surfaces the real reason and offers a retry when the plugin list fails to load (CodeRabbit #779 R29, R31)", async () => {
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

  it("merges a status event newer than the in-flight list response (CodeRabbit #779 R29)", async () => {
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

  // Round 15 finding 2: a "removed" event carries only an id, and two rows
  // can share one (a broken manifest's directory-derived fallback colliding
  // with some other, unrelated plugin's real id). Dropping every row with
  // that id used to take the survivor down with it, even if only for one
  // render before the next full list arrived.
  it("keeps a survivor visible when a removed event's id names two rows, then reconciles for real", async () => {
    bridgeMock.listPlugins
      .mockResolvedValueOnce({
        ok: true,
        plugins: [
          plugin("codex", { directoryName: "codex-a", displayName: "Codex A" }),
          plugin("codex", { directoryName: "codex-b", displayName: "Codex B" }),
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        plugins: [plugin("codex", { directoryName: "codex-b", displayName: "Codex B" })],
      });

    renderList();
    await screen.findByText("Codex A");
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);

    act(() => {
      statusListener?.({
        kind: "removed",
        workspaceId: "ws-1",
        pluginId: "codex",
        directoryName: "codex-a",
      });
    });

    // Ambiguous id: nothing is dropped locally, so the survivor — and, for
    // this one render, the row that actually left too — both stay exactly
    // as they were. Never a bare loading state either: the whole point is
    // that nothing already on screen disappears while this settles.
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);
    expect(screen.getByText("Codex A")).toBeTruthy();
    expect(screen.getByText("Codex B")).toBeTruthy();

    // The reload it triggers reconciles for real, without a manual refresh.
    await waitFor(() => expect(screen.getAllByTestId("plugin-row")).toHaveLength(1));
    expect(screen.getByText("Codex B")).toBeTruthy();
    expect(screen.queryByText("Codex A")).toBeNull();
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(2);
  });

  // A standing collision (two rows genuinely sharing this id, at two real,
  // permanently different directories) must not re-trigger a reload on
  // every ordinary "changed" event for either row — only the single-row
  // case upsertPlugin's own migration logic can actually get wrong.
  // Checking "does ANY row with this id have a different directory" would
  // read every one of these as ambiguous forever; checking the exact row
  // upsertPlugin would migrate (matchingId.length === 1) does not.
  it("does not reload on an ordinary changed event for either row of a standing collision", async () => {
    bridgeMock.listPlugins.mockResolvedValue({
      ok: true,
      plugins: [
        plugin("codex", { directoryName: "codex-a", displayName: "Codex A" }),
        plugin("codex", { directoryName: "codex-b", displayName: "Codex B" }),
      ],
    });

    renderList();
    await screen.findByText("Codex A");
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(1);

    act(() => {
      statusListener?.({
        kind: "changed",
        workspaceId: "ws-1",
        plugin: plugin("codex", { directoryName: "codex-a", displayName: "Codex A, updated" }),
      });
    });

    await screen.findByText("Codex A, updated");
    expect(screen.getByText("Codex B")).toBeTruthy();
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(2);
    // No reload — the local merge already applied it correctly, and this is
    // the case upsertPlugin was never going to get wrong.
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(1);
  });

  // Round 16 finding 1: with no prior ready list, the ambiguity check has
  // nothing to count rows in — the naive read is "not ambiguous", so the
  // initial request's OWN merge (once it lands) re-applies the removed
  // event against whatever it fetched. If that fetch already reflects the
  // removal (one row left, sharing the removed id with the survivor), the
  // merge reads "only one row has this id now" as proof there was never a
  // collision, and drops the survivor anyway.
  it("keeps a survivor visible when a removal arrives before the initial load ever settles", async () => {
    const initialLoad = deferred<{
      ok: true;
      plugins: PluginStatusRecord[];
    }>();
    bridgeMock.listPlugins
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({
        ok: true,
        plugins: [plugin("codex", { directoryName: "codex-b", displayName: "Codex B" })],
      });

    renderList();

    // The initial request is still in flight — loadRef has never held a
    // ready list, so ambiguity cannot be read off it either way.
    act(() => {
      statusListener?.({
        kind: "removed",
        workspaceId: "ws-1",
        pluginId: "codex",
        directoryName: "codex-a",
      });
    });

    // What the in-flight request resolves to: a same-tick backend snapshot
    // already past the removal, showing only the survivor — exactly the
    // shape a buggy merge reads as "unambiguous".
    await act(async () => {
      initialLoad.resolve({
        ok: true,
        plugins: [plugin("codex", { directoryName: "codex-b", displayName: "Codex B" })],
      });
      await initialLoad.promise;
    });

    await waitFor(() => expect(screen.getAllByTestId("plugin-row")).toHaveLength(1));
    expect(screen.getByText("Codex B")).toBeTruthy();
    // The unconditional reload this pins: a second request, issued after
    // the removed event was recorded, whose own newerEvents excludes it —
    // its fetch is trusted as-is instead of re-filtered.
    expect(bridgeMock.listPlugins).toHaveBeenCalledTimes(2);
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
