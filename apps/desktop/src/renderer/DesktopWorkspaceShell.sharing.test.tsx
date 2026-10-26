// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "./DesktopWorkspaceShell";
import { CHATS_TAB_PATH } from "./workbench/workbenchState";
import { deferred } from "../testing/deferred";
import { createAutomationButtons } from "./collections/useAutomationButtons";
import { DesktopWorkspaceShell, WORKSPACE, SYNC_STATUS, STORED_STATE, STORED_CHATS_STATE, storedStateWithTabs, makeBridge, renderShell, shellBootstrapProps, SHARE_STATUS, SHARE_VIEW, makeShareBridge, settleShareView } from "./DesktopWorkspaceShell.testHarness";

describe("share background work readiness", () => {
  const EDIT_SHARE: Workspace = {
    ...SHARE_VIEW,
    shareView: { ...SHARE_VIEW.shareView!, access: "edit" },
  };

  it("preserves an overdue burst's Notices intent after the opening refresh", async () => {
    const bridge = makeShareBridge();
    Object.assign(bridge, {
      pressAutomationButton: async () => ({ busy: false, relayed: true }),
      onAutomationRunSettled: () => () => undefined,
      onAutomationRunWaiting: () => () => undefined,
      onCollectionAutomationsChanged: () => () => undefined,
    });
    const opening = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockImplementationOnce(() => opening.promise);
    renderShell(bridge, EDIT_SHARE);
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const buttons = createAutomationButtons({ workspaceId: EDIT_SHARE.workspaceId, of: { collectionPath: "tasks" } });
    try {
      await act(async () => buttons.press("Finish", { id: "task", label: "task" }));
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(bridge.refreshSharedView).toHaveBeenCalledOnce();
      await act(async () => opening.resolve({ ok: true, status: "unchanged", probed: true, changedPaths: 0,
        excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null }));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2);
      expect(bridge.refreshSharedView).toHaveBeenLastCalledWith({ workspaceId: EDIT_SHARE.workspaceId, trigger: "press-burst" });
    } finally { buttons.close(); vi.useRealTimers(); }
  });

  it("waits for readiness before pushing, then reports one real failure with Try again", async () => {
    const admission = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge();
    bridge.openWorkspace.mockImplementation(() => admission.promise);
    let ready = false;
    bridge.pushShareDirectWrites.mockImplementation(async () => {
      throw new Error(ready ? "The relay did not answer." : "Share changes stopped because this window changed workspaces.");
    });
    renderShell(bridge, EDIT_SHARE);
    await settleShareView();
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledOnce());

    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridge.pushShareDirectWrites).not.toHaveBeenCalled();
    expect(bridge.onShareDirectWritesPushed).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      ready = true;
      admission.resolve(SHARE_STATUS);
    });
    const message = "dohc could not send your Collection changes to granter@dohc.test. The relay did not answer.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(toast.textContent).toContain(message);
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(within(notices).getAllByText(message)).toHaveLength(1);
    bridge.pushShareDirectWrites.mockResolvedValue(undefined);
    await user.click(within(notices).getByRole("button", { name: "Try again" }));
    expect(bridge.pushShareDirectWrites).toHaveBeenCalledTimes(2);
  });

  it.each(["refused", "stale"] as const)("keeps a %s push answer delivered after admission but before readiness", async (result) => {
    const readiness = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge();
    bridge.openWorkspace.mockImplementation(() => readiness.promise);
    renderShell(bridge, EDIT_SHARE);
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledOnce());
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(bridge.pushShareDirectWrites).not.toHaveBeenCalled();

    act(() => bridge.emitShareDirectWritesPushed({
      workspaceId: EDIT_SHARE.workspaceId,
      result: {
        status: "pushed",
        writes: [result === "refused"
          ? { result, paths: ["trip/packing/automations.yaml"], reason: "" }
          : { result, paths: ["trip/packing/collection.yaml"], stalePath: "trip/packing/collection.yaml", recoveredDraftPath: null }],
      },
    }));
    await act(async () => { readiness.resolve(SHARE_STATUS); });
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));

    const message = result === "refused"
      ? "The sync relay did not accept your change to packing/automations.yaml. Send it as a proposal."
      : "packing/collection.yaml changed before your change reached granter@dohc.test. Check the new version, or send yours as a proposal.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(message);
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
    expect(within(screen.getByTestId("notice-center")).getAllByText(message)).toHaveLength(1);
    expect(bridge.onShareDirectWritesPushed).toHaveBeenCalledOnce();
    expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce();
  });

  it("discards a pending push when the workspace changes and waits for the next admission", async () => {
    const bridge = makeShareBridge();
    const push = deferred<Awaited<ReturnType<typeof bridge.pushShareDirectWrites>>>();
    bridge.pushShareDirectWrites.mockImplementationOnce(() => push.promise);
    const nextShare = { ...EDIT_SHARE, workspaceId: "next-share" };
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell
      workspace={workspace} workspaces={[EDIT_SHARE, nextShare]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(EDIT_SHARE));
    await waitFor(() => expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce());
    const admission = deferred<typeof SHARE_STATUS>();
    bridge.openWorkspace.mockImplementation(() => admission.promise);
    view.rerender(shell(nextShare));
    await act(async () => {
      push.reject(new Error("Share changes stopped because this window changed workspaces."));
      bridge.emitShareDirectWritesPushed({
        workspaceId: EDIT_SHARE.workspaceId,
        result: { status: "failed", writes: [], errorMessage: "retired", lasting: false },
      });
    });
    expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain("could not send your Collection changes");
    await act(async () => { admission.resolve(SHARE_STATUS); });
    await waitFor(() => expect(bridge.pushShareDirectWrites).toHaveBeenCalledTimes(2));
    expect(bridge.pushShareDirectWrites).toHaveBeenLastCalledWith({ workspaceId: nextShare.workspaceId });
  });

  it("discards a refresh failure from a retired workspace", async () => {
    const bridge = makeShareBridge();
    const refresh = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockImplementationOnce(() => refresh.promise);
    const nextWorkspace = { ...WORKSPACE, workspaceId: "next-workspace" };
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell
      workspace={workspace} workspaces={[EDIT_SHARE, nextWorkspace]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(EDIT_SHARE));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    view.rerender(shell(nextWorkspace));
    await act(async () => { refresh.reject(new Error("This window changed workspaces.")); });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain("Couldn't refresh the shared view.");
  });

  it.each(["Collections", "workspace files"] as const)("discards a background %s failure from a retired workspace", async (read) => {
    const bridge = makeShareBridge();
    const pending = deferred<never>();
    if (read === "Collections") bridge.dataset.mockImplementationOnce(() => pending.promise);
    const nextWorkspace = { ...WORKSPACE, workspaceId: "next-workspace" };
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell
      workspace={workspace} workspaces={[EDIT_SHARE, nextWorkspace]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(EDIT_SHARE));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    await settleShareView();
    if (read === "Collections") {
      expect(bridge.dataset).toHaveBeenCalledOnce();
    } else {
      const calls = bridge.listWorkspaceFiles.mock.calls.length;
      bridge.listWorkspaceFiles.mockImplementationOnce(() => pending.promise);
      act(() => bridge.emitWorkspaceActivity({ workspaceId: EDIT_SHARE.workspaceId }));
      await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(calls + 1));
    }
    view.rerender(shell(nextWorkspace));
    await act(async () => { pending.reject(new Error("This window changed workspaces.")); });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain(`Could not ${read === "Collections" ? "read Collections" : "refresh workspace files"}.`);
  });
});

describe("workspace share handoff placement", () => {
  it("uses the existing overlay and dismisses it without a payload or mutation", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const onDismissShareHandoff = vi.fn();
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
        handoffStatus={{ status: "failed-network", statusId: "status-test" }}
        onDismissShareHandoff={onDismissShareHandoff}
        onShareHandoffOpened={() => {}}
      />,
    );

    expect(
      await screen.findByText(
        "dohc couldn't reach the server. Check your connection, then choose Try again.",
      ),
    ).toBeTruthy();
    await userEvent.setup().click(
      screen.getByRole("button", { name: "Try again" }),
    );
    expect(bridge.retryShareHandoff).toHaveBeenCalledOnce();
    expect(bridge.retryShareHandoff.mock.calls[0]).toEqual([]);
    expect(bridge.mountShare).not.toHaveBeenCalled();
    expect(bridge.openSharedView).not.toHaveBeenCalled();
    expect(bridge.pickWorkspaceRoot).not.toHaveBeenCalled();
    expect(bridge.createWorkspaceFile).not.toHaveBeenCalled();
    expect(bridge.createWorkspaceFolder).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismissShareHandoff).toHaveBeenCalledOnce();
    expect(bridge.mountShare).not.toHaveBeenCalled();
    expect(bridge.openSharedView).not.toHaveBeenCalled();
  });
});

describe("adding a share to this workspace", () => {
  // The folder under shared-with-me is read-only at every level, so the
  // message names the level only where it has somewhere else to go. An
  // Edit code defaults to Open separately; this person chose Add.
  it.each([
    [
      "edit",
      "Added sam to shared-with-me. Its files are read-only in this workspace. To use your Edit access, choose Open a share, then Open separately.",
    ],
    [
      "view",
      "Added sam to shared-with-me. Its files are read-only and stay up to date.",
    ],
  ] as const)(
    "announces an added %s share in a toast and a Notices row, not a bar",
    async (access, message) => {
      const user = userEvent.setup();
      const bridge = makeBridge(Promise.resolve(null));
      bridge.mountShare.mockResolvedValue({
        workspace: {
          ...WORKSPACE,
          shareMounts: [
            { shareId: "share-1", label: "sam", granterEmail: "sam@dohc.test", access },
          ],
        },
        mount: { shareId: "share-1", label: "sam", status: "updated", changedPaths: 1 },
      });
      bridge.getRelayReceivedShare.mockResolvedValue({
        found: true,
        share: {
          shareId: "share-1",
          granterEmail: "sam@dohc.test",
          genericChatWritable: false,
          grantId: "grant-1",
          generation: 1,
          createdAtMs: 1,
          shareCode: "dohc-share:share-1:https://relay.dohc.test",
          selector: { paths: ["docs"], versionId: null },
          access,
        },
      });
      renderShell(bridge);

      await user.click(await screen.findByTestId("workspace-switcher"));
      await user.click(screen.getByTestId("workspace-switcher-open-share"));
      await user.type(
        await screen.findByTestId("open-share-code"),
        "dohc-share:share-1:https://relay.dohc.test",
      );
      await waitFor(() =>
        expect(screen.getByTestId("open-share-mode-separate").getAttribute("aria-checked")).toBe(
          access === "edit" ? "true" : "false",
        ),
      );
      await user.click(screen.getByTestId("open-share-mode-mount"));
      await user.click(screen.getByTestId("open-share-start"));

      expect((await screen.findByTestId("workspace-shell-notice")).textContent).toContain(
        message,
      );
      expect(screen.queryByTestId("shell-notice")).toBeNull();
      await user.click(screen.getByTestId("notice-center-toggle"));
      expect((await screen.findByTestId("notice-center")).textContent).toContain(message);
    },
  );
});

describe("active file sharing", () => {
  it("opens the relay share dialog for the active inspector path and returns a code", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true,
      workspaceSyncConnected: true,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("a.md")).toBeTruthy();
    await waitFor(() => expect(dialog.querySelector("[inert]")).toBeNull());
    expect(within(dialog).queryByTestId("share-setup")).toBeNull();

    await user.type(within(dialog).getByTestId("share-email"), "friend@dohc.test");
    await user.click(within(dialog).getByTestId("share-create"));

    const codeElement = await within(dialog).findByTestId("share-code");
    expect(codeElement.textContent).toBe("dohc-share:relay-share-1:http://relay.test");
    expect(bridge.createRelayShare).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test",
      recipientEmail: "friend@dohc.test",
      access: "view",
      paths: ["a.md"],
    });
  });

  it("opens the same dialog from the palette's Share… for the active file", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("share");
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).getAllByRole("option").map((row) => row.textContent)).toEqual(["Share…"]);
    await user.keyboard("{Enter}");

    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("a.md")).toBeTruthy();
  });

  // main offers the Explorer's Share… on a workspace that does not sync, and
  // the dialog says how to set up sync.
  it("opens the same dialog from the Explorer menu's Share… on a workspace that does not sync", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false,
    }));
    bridge.readExplorerMenu.mockResolvedValue([{ kind: "item", label: "Share…", id: "share" }]);
    const user = userEvent.setup();
    renderShell(bridge);

    const row = (await screen.findAllByTestId("tree-row")).find((candidate) => candidate.dataset.path === "a.md");
    if (!row) throw new Error("a.md row missing");
    fireEvent.contextMenu(row);
    await user.click(await screen.findByTestId("explorer-menu-item-share"));

    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("a.md")).toBeTruthy();
    expect((await within(dialog).findByTestId("share-setup")).dataset.reason).toBe("not-synced");
  });

  // The palette hides Share… whenever the toolbar draws no Share file.
  it.each<[string, Workspace | undefined, string[]]>([
    ["no editor shows a file", undefined, []],
    ["the workspace is a shared view", SHARE_VIEW, ["a.md"]],
    ["the file is in a received share", undefined, ["shared-with-me/sam/a.md"]],
  ])("offers no Share… when %s", async (_name, workspace, tabs) => {
    const bridge = (workspace ? makeShareBridge : makeBridge)(Promise.resolve(storedStateWithTabs(tabs)));
    const user = userEvent.setup();
    renderShell(bridge, workspace);
    if (workspace) await settleShareView();
    if (tabs.length > 0) await screen.findByTestId("file-inspector");
    expect(screen.queryByTestId("file-share")).toBeNull();

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("share");
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).queryAllByRole("option")).toEqual([]);
    expect(within(palette).getByText("No matching commands")).toBeTruthy();
  });

  // Share reads the same facts as About's Access, and its one action opens
  // the place that fixes the cause, where About's would.
  it.each([
    [
      "does not sync",
      { connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false },
      "not-synced", "Set up sync", "settings-section-cloud",
    ],
    [
      "is not connected to its server",
      { connected: false, email: "", serverUrl: "", workspaceSynced: true, workspaceServerUrl: "https://sync.example.org" },
      "signed-out", "Connect server", "cloud-server-url",
    ],
  ] as const)("says why before the form when the workspace %s", async (_case, status, reason, action, opens) => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => status);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    const setup = await within(await screen.findByTestId("share-dialog")).findByTestId("share-setup");
    expect(setup.dataset.reason).toBe(reason);
    if (reason === "signed-out") expect(setup.textContent).toContain("Not connected to sync.example.org");
    await user.click(within(setup).getByRole("button", { name: action }));
    expect(await screen.findByTestId(opens)).toBeTruthy();
    expect(screen.queryByTestId("share-dialog")).toBeNull();
  });
});

// The banner distinguishes document edits submitted for acceptance from
// read-only access and conversations that continue in the browser.
// Removing a mount reprojects path-keyed UI state only when the folder
// actually went. Record-only cleanup leaves the files exactly where they
// were, so their tabs, pins and drafts must survive it.
describe("shared view banner", () => {
  it("does not offer app creation in a received share workspace", async () => {
    const user = userEvent.setup();
    const bridge = Object.assign(makeShareBridge(), {
      listSites: vi.fn(async () => ({ sites: [] })),
    });
    renderShell(bridge, SHARE_VIEW);

    await user.click(await screen.findByTestId("activity-sites"));

    expect(
      await screen.findByText(
        "This shared view cannot create an app. Ask the workspace owner to add one.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create app" })).toBeNull();
    expect(bridge.createWorkspaceFolder).not.toHaveBeenCalled();
    expect(bridge.createWorkspaceFile).not.toHaveBeenCalled();
  });

  it("tells a view recipient the view is read-only", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        sharerName: "IT Security",
        access: "view",
      },
    });

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "Shared view from IT Security (sam@dohc.test) — read-only. Ask sam@dohc.test for changes.",
    );
    expect(banner.textContent).not.toContain("You can chat about");
  });

  it("tells an independent Comment recipient where to continue and renders no composer", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    bridge.listFileChats.mockResolvedValue({
      fileObjectId: "share-object-1",
      threads: [
        {
          id: "independent-thread",
          title: "Independent discussion",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });
    Object.assign(bridge, {
      listChatMessages: vi.fn(async () => ({ messages: [] })),
      listChatReactions: vi.fn(async () => ({
        reactions: [],
        viewerAuthorId: "recipient",
      })),
      markChatThreadRead: vi.fn(async () => ({
        lastReadSequence: 0,
        revision: 1,
      })),
    });
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "comment",
        genericChatWritable: true,
      },
    });

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "Shared view from sam@dohc.test. Files and Chats are read-only here. Ask sam@dohc.test where to continue the conversation.",
    );
    await userEvent.click(await screen.findByTestId("linked-chat-open"));
    await screen.findByTestId("linked-chat-thread");
    expect(
      screen.queryByTestId("linked-chat-composer"),
      "relay append authority restored a received-share composer",
    ).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    expect(banner.textContent, "giving comment the edit sentence would promise a write-back lane a comment grant does not carry.").not.toContain("send your changes");
  });

  it("keeps dependent Comment generic chats read-only and sends comments back to the browser", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    bridge.listFileChats.mockResolvedValue({
      fileObjectId: "share-object-1",
      threads: [
        {
          id: "existing-thread",
          title: "Existing discussion",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });
    Object.assign(bridge, {
      listChatMessages: vi.fn(async () => ({
        messages: [
          { presentation: { group: "fixture", hue: null, self: false },
            id: "existing-message",
            threadId: "existing-thread",
            authorKind: "human" as const,
            authorDisplayName: "Sam",
            body: "This history stays readable.",
            createdAtMs: 1,
          },
        ],
      })),
      listChatReactions: vi.fn(async () => ({
        reactions: [],
        viewerAuthorId: "recipient",
      })),
      markChatThreadRead: vi.fn(async () => ({
        lastReadSequence: 1,
        revision: 1,
      })),
    });
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "comment",
        genericChatWritable: false,
      },
    });

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "Shared view from sam@dohc.test. Files are read-only here. Continue commenting in the browser where you opened the link.",
    );
    expect(banner.textContent).not.toContain("You can chat about these files");
    expect((await screen.findByTestId("linked-chat-readonly-note")).textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
    await userEvent.click(await screen.findByTestId("linked-chat-open"));
    expect(await screen.findByText("This history stays readable.")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
  });

  // Markdown edits save live; other file changes still need acceptance.
  it("distinguishes live Markdown edits from other changes needing acceptance", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "edit",
      },
    });

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "Shared view from sam@dohc.test. Markdown edits save to the live host. Other file changes need their acceptance.",
    );
    expect(banner.textContent, "falling through to the PR2 sentence tells an edit recipient they cannot edit, which is the exact lie PR3a removes.").not.toContain("not edit them");
  });

  it("names an unknown granter the way every other share string does", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: { shareId: "share-1", granterEmail: null, access: "edit" },
    });

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "Shared view from the owner. Markdown edits save to the live host. Other file changes need their acceptance.",
    );
  });

  it("keeps the ended sentence, and drops the send control with it", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "edit",
        ended: true,
      },
    });

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "This share was ended by sam@dohc.test. Your copy stays readable but won't update anymore.",
    );
    expect(
      screen.queryByTestId("share-changes-send"),
      "an ended share cannot carry changes anywhere",
    ).toBeNull();
  });
});

// The editor's read-only stance is the level, not the marker.
// The toggle is disabled exactly when the editor is read-only, so it is the
// prop's own behaviour rather than a second reading of the level.
describe("shared view editing", () => {
  async function editToggleDisabled(
    shareView: NonNullable<Workspace["shareView"]>,
  ): Promise<boolean> {
    const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs(["a.md"])));
    renderShell(bridge, { ...SHARE_VIEW, shareView });
    const toggle = await screen.findByTestId("markdown-edit-toggle");
    // The toggle mounts disabled while the file is still opening, a moment
    // `findByTestId` does not wait out. Wait for the open to settle before
    // reading `disabled` (the read-only cases below can't tell the
    // difference either way).
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    return toggle.hasAttribute("disabled");
  }

  for (const shareView of [
    { shareId: "share-1", granterEmail: "sam@dohc.test", access: "view" as const },
    { shareId: "share-1", granterEmail: "sam@dohc.test", access: "comment" as const },
    { shareId: "share-1", granterEmail: "sam@dohc.test", damaged: true as const },
    {
      shareId: "share-1",
      granterEmail: "sam@dohc.test",
      access: "edit" as const,
      ended: true,
    },
  ]) {
    const name = shareView.damaged
      ? "an unreadable grant"
      : shareView.ended
        ? "an ended edit share"
        : `a ${shareView.access} share`;
    it(`keeps the editor read-only for ${name}`, async () => {
      expect(
        await editToggleDisabled(shareView),
        "reading the level generously opens an editor the grant does not open",
      ).toBe(true);
    });
  }

  // `damaged` and `access` are independent fields on the marker, so a record
  // can carry both. The damage wins: a grant dohc could not read is not a
  // grant it may act on.
  it("keeps the editor read-only for a damaged marker that still names edit", async () => {
    expect(
      await editToggleDisabled({
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "edit",
        damaged: true,
      }),
      "dropping the damaged test acts on a level dohc could not read",
    ).toBe(true);
  });

  it("opens the editor for an edit share", async () => {
    expect(
      await editToggleDisabled({
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "edit",
      }),
      "an unconditional shareView read-only keeps edit locked out",
    ).toBe(false);
  });

  it("keeps document editing available while an Edit share's Chats stay read-only", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        access: "edit",
        genericChatWritable: true,
      },
    });

    const toggle = await screen.findByTestId("markdown-edit-toggle");
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect((await screen.findByTestId("linked-chat-readonly-note")).textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
  });
});

// Sending changes back: the recipient's half of the lane.
describe("shared view send changes", () => {
  const EDIT_SHARE: Workspace = {
    ...SHARE_VIEW,
    shareView: {
      shareId: "share-1",
      granterEmail: "sam@dohc.test",
      access: "edit",
    },
  };
  // Send waits for main to open the view in this window.
  const readySend = async () => {
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    return screen.getByTestId("share-changes-send");
  };

  for (const shareView of [
    { shareId: "share-1", granterEmail: "sam@dohc.test", access: "view" as const },
    { shareId: "share-1", granterEmail: "sam@dohc.test", access: "comment" as const },
    { shareId: "share-1", granterEmail: "sam@dohc.test", damaged: true as const },
    {
      shareId: "share-1",
      granterEmail: "sam@dohc.test",
      access: "edit" as const,
      damaged: true as const,
    },
  ]) {
    const name = shareView.damaged
      ? `an unreadable grant${shareView.access ? " that still names edit" : ""}`
      : shareView.access;
    it(`offers no send control for ${name}`, async () => {
      const bridge = makeShareBridge();
      renderShell(bridge, { ...SHARE_VIEW, shareView });
      await screen.findByTestId("shared-view-banner");
      expect(
        screen.queryByTestId("share-changes-send"),
        "offering a send control the grant does not carry",
      ).toBeNull();
    });
  }

  // The reverse path outlives the right that created it. A granter can narrow
  // a share while changes wait, and a withdraw the downgrade took away would
  // strand them in front of someone who may never answer.
  it("still shows and withdraws changes already sent after a downgrade", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.listMyShareChanges.mockResolvedValue({
      proposals: [
        { proposalId: "proposal-1", state: "open", createdAtMs: 10, files: 2 },
      ],
    });
    renderShell(bridge, {
      ...SHARE_VIEW,
      shareView: {
        shareId: "share-1",
        granterEmail: "sam@dohc.test",
        // Narrowed after the changes were sent.
        access: "comment",
      },
    });

    const state = await screen.findByTestId("share-changes-state");
    expect(
      state.dataset.state,
      "gating the sent state on the level hides changes the recipient can still take back",
    ).toBe("open");
    expect(screen.queryByTestId("share-changes-send")).toBeNull();

    await user.click(screen.getByTestId("share-changes-withdraw"));
    await waitFor(() =>
      expect(bridge.withdrawShareChanges).toHaveBeenCalledWith({
        workspaceId: SHARE_VIEW.workspaceId,
        proposalId: "proposal-1",
      }),
    );
  });

  // After a save in an Edit share view, main pushes a Collection's own files
  // straight to the owner. A write the relay refuses stays for Send changes,
  // and its notice sends it.
  it("shows a push main ran after a save and offers a refused write as a proposal", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    renderShell(bridge, EDIT_SHARE);
    await screen.findByTestId("shared-view-banner");
    await waitFor(() => expect(bridge.pushShareDirectWrites).toHaveBeenCalledWith({ workspaceId: SHARE_VIEW.workspaceId }));

    act(() => bridge.emitShareDirectWritesPushed({
      workspaceId: SHARE_VIEW.workspaceId,
      result: { status: "pushed", writes: [{ result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" }] },
    }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "The sync relay did not accept your change to packing/automations.yaml. Send it as a proposal.",
    );
    await user.click(screen.getByTestId("workspace-shell-error-action"));
    await waitFor(() => expect(bridge.submitShareChanges).toHaveBeenCalledWith({ workspaceId: SHARE_VIEW.workspaceId }));
  });

  // Main refuses the window's calls until it has opened the view there. A
  // read sent before that would leave changes already sent unseen.
  it("reads changes already sent once main has opened the view in this window", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge();
    let admitted = false;
    bridge.openWorkspace = vi.fn(async () => {
      const opened = await status.promise;
      admitted = true;
      return opened;
    });
    bridge.getSyncStatus = vi.fn(() => status.promise);
    bridge.listMyShareChanges.mockImplementation(async () => {
      if (!admitted) throw new Error("Share changes stopped because this window changed workspaces.");
      return { proposals: [{ proposalId: "proposal-1", state: "open", createdAtMs: 10, files: 1 }] };
    });
    renderShell(bridge, EDIT_SHARE);
    await screen.findByTestId("shared-view-banner");
    expect(bridge.listMyShareChanges).not.toHaveBeenCalled();

    await act(async () => status.resolve(SHARE_STATUS));
    expect(await screen.findByTestId("share-changes-state")).toHaveProperty("dataset.state", "open");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("listens without pushing from a share view that cannot write", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, { ...SHARE_VIEW, shareView: { shareId: "share-1", granterEmail: "sam@dohc.test", access: "comment" } });
    await screen.findByTestId("shared-view-banner");
    // A write started before access ended can still report its outcome.
    await waitFor(() => expect(bridge.onShareDirectWritesPushed).toHaveBeenCalledOnce());
    expect(bridge.pushShareDirectWrites).not.toHaveBeenCalled();
  });

  // What a submit did not take. Both are things the recipient would otherwise
  // discover by their work simply not arriving.
  it("states the files a submit left outside the share", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 1,
      capturedLocalChanges: 0,
      skippedOutsideShare: 2,
      morePending: false,
    });
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    const line = await screen.findByTestId("share-changes-skipped");
    expect(
      line.textContent,
      "a silent drop is work the recipient believes they sent",
    ).toBe("2 files weren't sent — they're not part of this share.");
  });

  // The control has to come back. Sending re-reads the sent changes, and that
  // read takes a new latest-wins token — so a cleanup still comparing the
  // token the click started with never matches, and the button stays disabled
  // reading "Sending…" until the workspace is reopened.
  it("re-enables Send after a submit that reloads its own state", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    renderShell(bridge, EDIT_SHARE);

    const send = await readySend();
    await user.click(send);
    await waitFor(() => expect(bridge.submitShareChanges).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByTestId("share-changes-send").hasAttribute("disabled"),
        "comparing the pre-reload token leaves Send stuck on Sending…",
      ).toBe(false),
    );
    expect(screen.getByTestId("share-changes-send").textContent).toContain("Send changes");
  });

  // Readiness re-reads the sent changes under a fresh token. A submit started
  // before it would outlive that token and read "Sending…" for ever.
  it("sends only after admission, including from a notice shown before it", async () => {
    const admission = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge();
    const submit = deferred<Awaited<ReturnType<typeof bridge.submitShareChanges>>>();
    bridge.openWorkspace.mockImplementation(() => admission.promise);
    bridge.submitShareChanges.mockImplementationOnce(() => submit.promise);
    renderShell(bridge, EDIT_SHARE);
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledOnce());
    act(() => bridge.emitShareDirectWritesPushed({
      workspaceId: EDIT_SHARE.workspaceId,
      result: { status: "pushed", writes: [{ result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" }] },
    }));

    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    const early = screen.getByTestId("share-changes-send") as HTMLButtonElement;
    expect(early.disabled).toBe(true);
    fireEvent.click(early);
    expect(bridge.submitShareChanges).not.toHaveBeenCalled();

    await act(async () => { admission.resolve(SHARE_STATUS); });
    await waitFor(() => expect(bridge.listMyShareChanges).toHaveBeenCalled());
    await userEvent.setup().click(await screen.findByTestId("workspace-shell-error-action"));
    await waitFor(() => {
      expect(bridge.submitShareChanges).toHaveBeenCalledOnce();
      expect(screen.getByTestId("share-changes-send").textContent).toContain("Sending…");
    });

    await act(async () => submit.resolve({
      ok: true,
      submitted: 1,
      capturedLocalChanges: 0,
      skippedOutsideShare: 0,
      morePending: false,
    }));
    await waitFor(() =>
      expect((screen.getByTestId("share-changes-send") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByTestId("share-changes-send").textContent).toContain("Send changes");
  });

  it("repaints files changed by the submit capture", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs(["b.md"], "b.md")),
    );
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 1,
      skippedOutsideShare: 0,
      morePending: false,
      capturedLocalChanges: 1,
    });
    renderShell(bridge, EDIT_SHARE);

    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalled());
    const listCallsBeforeSubmit = bridge.listWorkspaceFiles.mock.calls.length;
    const readCallsBeforeSubmit = bridge.readWorkspaceText.mock.calls.length;

    await user.click(await readySend());

    await waitFor(() =>
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(
        listCallsBeforeSubmit,
      ),
    );
    await waitFor(() =>
      expect(bridge.readWorkspaceText.mock.calls.length).toBeGreaterThan(
        readCallsBeforeSubmit,
      ),
    );
  });

  it("keeps a successful submit successful when its repaint fails", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 1,
      skippedOutsideShare: 0,
      morePending: false,
      capturedLocalChanges: 1,
    });
    renderShell(bridge, EDIT_SHARE);

    await screen.findByTestId("shared-view-banner");
    await waitFor(() => expect(bridge.listMyShareChanges).toHaveBeenCalled());
    const proposalReadsBeforeSubmit = bridge.listMyShareChanges.mock.calls.length;
    bridge.listMyShareChanges.mockResolvedValue({
      proposals: [
        { proposalId: "proposal-1", state: "open", createdAtMs: 10, files: 1 },
      ],
    });
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("listing failed"));

    await user.click(await readySend());

    await waitFor(() =>
      expect(bridge.listMyShareChanges.mock.calls.length).toBeGreaterThan(
        proposalReadsBeforeSubmit,
      ),
    );
    expect((await screen.findByTestId("share-changes-state")).dataset.state).toBe(
      "open",
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("repaints captured changes and reports the relay failure when send fails", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: false,
      capturedLocalChanges: 1,
      errorMessage: "relay failed",
    });
    renderShell(bridge, EDIT_SHARE);

    await screen.findByTestId("shared-view-banner");
    const listCallsBeforeSubmit = bridge.listWorkspaceFiles.mock.calls.length;
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("listing failed"));

    await user.click(await readySend());

    await waitFor(() =>
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(
        listCallsBeforeSubmit,
      ),
    );
    const error = await screen.findByTestId("workspace-shell-error");
    expect(error.textContent).toContain("relay failed");
    expect(error.textContent).not.toContain("listing failed");
  });

  // Taking the changes back retires what the last submit said about them.
  it("clears the last submit's lines when the changes are taken back", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 1,
      capturedLocalChanges: 0,
      skippedOutsideShare: 2,
      morePending: false,
    });
    bridge.listMyShareChanges.mockResolvedValue({
      proposals: [
        { proposalId: "proposal-1", state: "open", createdAtMs: 10, files: 1 },
      ],
    });
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    await screen.findByTestId("share-changes-skipped");

    await user.click(await screen.findByTestId("share-changes-withdraw"));
    await waitFor(() => expect(bridge.withdrawShareChanges).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByTestId("share-changes-skipped"),
        "a withdrawn submission keeps describing what it skipped",
      ).toBeNull(),
    );
  });

  // Both facts, when both are true. An either/or line drops "more pending"
  // exactly when a submit was largest — which is the case the count exists to
  // report.
  it("states both what was skipped and what is still waiting", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 500,
      capturedLocalChanges: 0,
      skippedOutsideShare: 3,
      morePending: true,
    });
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    const line = await screen.findByTestId("share-changes-skipped");
    expect(
      line.textContent,
      "an either/or line hides the ~97 changes still queued",
    ).toBe(
      "3 files weren't sent — they're not part of this share. " +
        "More changes are waiting. Send again to send the rest.",
    );
  });

  it("says more changes are waiting when the bound held some back", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 500,
      capturedLocalChanges: 0,
      skippedOutsideShare: 0,
      morePending: true,
    });
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    expect((await screen.findByTestId("share-changes-skipped")).textContent).toBe(
      "More changes are waiting. Send again to send the rest.",
    );
  });

  it("states nothing extra when a submit took everything", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    await waitFor(() => expect(bridge.submitShareChanges).toHaveBeenCalled());
    expect(
      screen.queryByTestId("share-changes-skipped"),
      "a warning on every ordinary submit is a warning nobody reads",
    ).toBeNull();
  });

  it("sends the pending changes and states where they went", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.listMyShareChanges
      .mockResolvedValueOnce({ proposals: [] })
      .mockResolvedValue({
        proposals: [
          { proposalId: "proposal-1", state: "open", createdAtMs: 10, files: 2 },
        ],
      });
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    await waitFor(() =>
      expect(bridge.submitShareChanges).toHaveBeenCalledWith({
        workspaceId: EDIT_SHARE.workspaceId,
      }),
    );
    const state = await screen.findByTestId("share-changes-state");
    expect(state.dataset.state).toBe("open");
    expect(state.textContent).toContain("Sent to sam@dohc.test for review.");
    expect(screen.getByTestId("share-changes-count").textContent).toBe("2 files");
  });

  it("says so when there was nothing to send", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.submitShareChanges.mockResolvedValue({
      ok: true,
      submitted: 0,
      capturedLocalChanges: 0,
      skippedOutsideShare: 0,
      morePending: false,
    });
    renderShell(bridge, EDIT_SHARE);

    await user.click(await readySend());
    expect((await screen.findByTestId("share-changes-empty")).textContent).toBe(
      "You have no changes to send yet.",
    );
    expect(screen.queryByTestId("share-changes-state")).toBeNull();
  });

  // Submitting is reversible, and the product invariant requires the reverse
  // path to be visible while it exists.
  it("takes an open submission back", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    bridge.listMyShareChanges
      .mockResolvedValueOnce({
        proposals: [
          { proposalId: "proposal-1", state: "open", createdAtMs: 10, files: 1 },
        ],
      })
      .mockResolvedValue({
        proposals: [
          { proposalId: "proposal-1", state: "withdrawn", createdAtMs: 10, files: 1 },
        ],
      });
    renderShell(bridge, EDIT_SHARE);

    expect((await screen.findByTestId("share-changes-count")).textContent).toBe(
      "1 file",
    );
    await user.click(screen.getByTestId("share-changes-withdraw"));
    await waitFor(() =>
      expect(bridge.withdrawShareChanges).toHaveBeenCalledWith({
        workspaceId: EDIT_SHARE.workspaceId,
        proposalId: "proposal-1",
      }),
    );
    // A withdrawn submission states nothing: it is as if it was never sent.
    await waitFor(() =>
      expect(screen.queryByTestId("share-changes-state")).toBeNull(),
    );
  });

  it("states the granter's decision, and only offers a reverse path while one exists", async () => {
    for (const [state, copy] of [
      ["accepted", "sam@dohc.test accepted your changes."],
      [
        "declined",
        "sam@dohc.test declined your changes. Your copy still has them. Edit again and send new changes.",
      ],
    ] as const) {
      const bridge = makeShareBridge();
      bridge.listMyShareChanges.mockResolvedValue({
        proposals: [{ proposalId: "proposal-1", state, createdAtMs: 10, files: 1 }],
      });
      renderShell(bridge, EDIT_SHARE);

      const row = await screen.findByTestId("share-changes-state");
      expect(row.dataset.state, state).toBe(state);
      expect(row.textContent, state).toContain(copy);
      expect(
        screen.queryByTestId("share-changes-withdraw"),
        "offering Withdraw for a submission the granter already settled",
      ).toBeNull();
      // The declined Next works on this surface: the send control is still here.
      expect(screen.queryByTestId("share-changes-send")).not.toBeNull();
      cleanup();
    }
  });

  // The newest submission is the one the surface speaks for.
  it("speaks for the newest submission, not the first row it was handed", async () => {
    const bridge = makeShareBridge();
    bridge.listMyShareChanges.mockResolvedValue({
      proposals: [
        { proposalId: "proposal-new", state: "open", createdAtMs: 20, files: 3 },
        { proposalId: "proposal-old", state: "declined", createdAtMs: 10, files: 1 },
      ],
    });
    renderShell(bridge, EDIT_SHARE);

    const row = await screen.findByTestId("share-changes-state");
    expect(row.dataset.state).toBe("open");
    expect(screen.getByTestId("share-changes-count").textContent).toBe("3 files");
  });
});

// The granter's half: the notice that announces waiting changes, and the
// review it opens.
describe("share changes review", () => {
  const PROPOSAL = {
    proposalId: "proposal-1",
    shareId: "share-1",
    proposedByEmail: "friend@dohc.test",
    createdAtMs: 1000,
    ops: 1,
  };

  it("announces waiting changes and opens the review", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listShareProposals.mockResolvedValue({ proposals: [PROPOSAL] });
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId("notice-share-changes-proposal-1");
    expect(notice.textContent).toContain("friend@dohc.test sent you changes");
    expect(notice.textContent).toContain("Review them to choose what to keep.");

    // The notice opens the review. What the review then decides is driven in
    // ProposalReviewDialog.test.tsx, against the same dialog.
    await user.click(within(notice).getByRole("button", { name: "Review" }));
    await screen.findByTestId("proposal-review-dialog");
  });

  it("raises no notice when nothing is waiting", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-center");
    expect(
      screen.queryByTestId("notice-share-changes-proposal-1"),
      "announcing a review nobody submitted",
    ).toBeNull();
  });

  // A share view holds someone else's files and is refused this channel.
  it("never asks a shared view to review changes", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, SHARE_VIEW);
    await screen.findByTestId("shared-view-banner");
    expect(
      bridge.listShareProposals,
      "asking main a question it refuses, and surfacing the refusal",
    ).not.toHaveBeenCalled();
  });
});

// A share view whose stored grant cannot be read keeps its restrictive
// marker. Dropping it would present someone else's files as an
// ordinary writable workspace — damage failing open, which is the one
// direction this must never fail in.
describe("shared view with an unreadable grant", () => {
  const damaged = {
    ...SHARE_VIEW,
    shareView: {
      shareId: "share-1",
      recipientUserId: "recipient",
      granterEmail: "sam@dohc.test",
      damaged: true as const,
    },
  };

  it("keeps the read-only stance and says what happened", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, damaged);

    const banner = await screen.findByTestId("shared-view-banner");
    expect(banner.textContent).toContain(
      "dohc can't read what this share grants. Open the share again to restore it.",
    );
    // No level is stated, because none could be read.
    expect(banner.textContent).not.toContain("read-only. Ask");
    expect(banner.textContent).not.toContain("This share must be reopened");
    expect(banner.textContent).toContain("sam@dohc.test dohc can't read");
  });

  // The chat half of the same stance. A grant that names no
  // readable level grants no writes: the panel opens read-only, exactly as a
  // `view` share does. Asking whether the level is not `view` would answer
  // "writable" for a level nobody can read.
  it("opens chat read-only, because an unreadable grant grants no writes", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, damaged);

    await settleShareView();
    await screen.findByTestId("about-rail");
    expect(
      (await screen.findByTestId("linked-chat-readonly-note")).textContent,
      "an unreadable level must not open the composer",
    ).toBe("Chats are read-only in this shared view.");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });

  // There is no grant to pull with, so the refresh is skipped rather than
  // fired and failed. Offering it would promise a recovery it cannot do.
  it("does not offer or fire a refresh", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, damaged);

    await screen.findByTestId("shared-view-banner");
    expect(
      screen.queryByTestId("shared-view-refresh"),
      "a share with no readable grant must not offer a refresh",
    ).toBeNull();
    expect(bridge.refreshSharedView).not.toHaveBeenCalled();
  });
});

// #615 pinned that a shared view gets no capture, so main refused every chat
// call and the panel, the tab and the titlebar button all offered a capability
// the share never had. #646 PR2 moves the line: main now answers the PER-FILE
// chat from the share scope, so that surface opens. The property #615 really
// protected survives, restated — a shared view reaches the per-file chat
// surface and never the workspace-wide listing. These pins cover the SHARE
// fact only; the failed capture build on a normal workspace is the describe
// below.
describe("shared view chats surface", () => {
  it("opens About's per-file chat on a shared view and never asks for the workspace-wide listing", async () => {
    // The stored state opens with the About rail visible and b.md focused.
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    expect(await screen.findByTestId("about-rail")).toBeTruthy();
    expect(screen.getByTestId("titlebar-about-sidebar")).toBeTruthy();

    // The rail offers no Chats view. A workspace-wide listing would be a
    // superset to filter, which is the shape #627 came from.
    expect(screen.queryByTestId("activity-chats")).toBeNull();
    expect(screen.queryByTestId("chats-view")).toBeNull();
    expect(screen.queryByTestId("about-rail-off")).toBeNull();

    await waitFor(() =>
      expect(bridge.listFileChats).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        path: "b.md",
      }),
    );
    // Every received share replaces the composer with the same chat-specific
    // refusal main returns before persistence.
    expect((await screen.findByTestId("linked-chat-readonly-note")).textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    // A shared view records no History, so About has no History section.
    expect(screen.queryByTestId("about-history")).toBeNull();

    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
    expect(bridge.chatFileMentionsPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The two ways back in that outlive the titlebar button. #615 pinned both
  // as absent; the surface they reach now exists, so both work — and neither
  // reaches the workspace-wide listing.
  it("keeps Ctrl+Alt+B and the toggle command on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    await screen.findByTestId("about-rail");

    await user.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
    await waitFor(() => expect(screen.queryByTestId("about-rail")).toBeNull());

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).getByText("Toggle About")).toBeTruthy();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });

  // A shared view has no Chats view, so no command reaches one: the palette
  // offers none and View > Chats does nothing.
  it("offers no way into Chats on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    expect(screen.queryByTestId("activity-chats")).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).getByText("View: Search")).toBeTruthy();
    expect(within(palette).queryByText("View: Chats")).toBeNull();
    await user.keyboard("{Escape}");

    act(() => bridge.emitMenuCommand("show-chats"));
    await act(async () => {});
    expect(screen.getByTestId("activity-explorer").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByTestId("chats-view")).toBeNull();
    expect(screen.queryByTestId("chats-off")).toBeNull();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
  });

  it("shows the Explorer, never Chats, when a shared view's saved layout selected Chats", async () => {
    // Every node the shell adds, from its first commit: Chats must never
    // render, not even for the frame before the saved state is corrected.
    const chatsRendered: string[] = [];
    const sidePanelTitle = (node: Node) =>
      node.parentElement?.closest('[data-testid="side-panel"] header') ? node.textContent : null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData" && sidePanelTitle(record.target) === "Chats") {
          chatsRendered.push("title");
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) {
            if (sidePanelTitle(node) === "Chats") chatsRendered.push("title");
            continue;
          }
          if (node.matches('[data-testid="chats-view"], [data-testid="chats-off"]') ||
            node.querySelector('[data-testid="chats-view"], [data-testid="chats-off"]')) {
            chatsRendered.push("view");
          }
          const headers = [
            ...(node.matches('[data-testid="side-panel"] header') ? [node] : []),
            ...node.querySelectorAll('[data-testid="side-panel"] header'),
          ];
          if (headers.some((header) => header.textContent?.startsWith("Chats"))) chatsRendered.push("title");
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      const bridge = makeShareBridge(Promise.resolve(STORED_CHATS_STATE));
      renderShell(bridge, SHARE_VIEW);

      await settleShareView();
      await waitFor(() =>
        expect(screen.getByTestId("activity-explorer").getAttribute("aria-current")).toBe("page"),
      );
      expect(await within(screen.getByTestId("side-panel")).findByTestId("file-tree")).toBeTruthy();
      await act(async () => {});
      expect(chatsRendered).toEqual([]);
      expect(bridge.listChatChannels).not.toHaveBeenCalled();
      expect(bridge.syncDms).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });

  it("states the capability for a persisted Chats tab instead of a page that can only fail", async () => {
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH)),
    );
    renderShell(bridge, SHARE_VIEW);

    // One line, per the empty-state recipe (copy.md): what is missing, then
    // the next step this surface really has. #646 PR2 changed both halves —
    // a shared view has per-file chat now, so "no chats" became false and
    // "close this tab" stopped being the real next step.
    const placeholder = await screen.findByTestId("chats-page-share-view");
    expect(placeholder.textContent).toContain(
      "A shared view lists no chats. Open a shared file to chat about it.",
    );
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");
    // The neighbouring line blames a Settings flag the share never touched.
    expect(screen.queryByTestId("chats-page-off")).toBeNull();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The other half of both gates: a healthy engine workspace gets the real
  // panel. Without this, hiding Chats from every workspace — or replacing the
  // panel with the failed-capture placeholder on every one — keeps the share
  // pins above and the pins below green.
  it("keeps Chats for a workspace that is not a shared view", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_CHATS_STATE));
    renderShell(bridge);

    expect(await screen.findByTestId("about-rail")).toBeTruthy();
    expect(screen.getByTestId("titlebar-about-sidebar")).toBeTruthy();
    // The Chats view. Dropping it from every workspace, as a share does,
    // would keep the share pin above green.
    expect(screen.getByTestId("activity-chats")).toBeTruthy();
    expect(await within(screen.getByTestId("side-panel")).findByTestId("chats-view")).toBeTruthy();
    await waitFor(() => expect(bridge.listChatChannels).toHaveBeenCalled());
    expect(screen.queryByTestId("chats-off")).toBeNull();
  });

  // The graph's chat-mentions toggle, on its own. The test above proves the
  // panel is gone, and the panel's own gate hides it whatever this toggle
  // reads — so reverting this gate alone changed nothing any pin could see.
  // Chat access stays independent of the file graph.
  it("offers no chat mentions in the graph on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    await user.click(screen.getByTestId("activity-graph"));

    // The graph itself still works — that is the point.
    expect((await screen.findAllByTestId("graph-file-row")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("graph-chat-mentions-toggle")).toBeNull();
    expect(bridge.linksEdges).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
    });
    expect(bridge.chatFileMentionsPage).not.toHaveBeenCalled();
  });

  // Ctrl+Alt+B, on its own: whether the shell claims the chord from whatever
  // else would handle it. A shared view has an About rail to toggle,
  // so it claims the chord — the same rule as any other
  // workspace, and the pin below is the one that still separates the two.
  it("claims Ctrl+Alt+B on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);
    await settleShareView();

    // A fresh event per attempt: the handler re-registers in a passive
    // effect, and a stale event carries the previous attempt's verdict.
    await waitFor(() => {
      const event = new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it.each([
    ["Control", "linux", { ctrlKey: true }],
    ["Command", "darwin", { metaKey: true }],
  ] as const)(
    "claims %s+Alt+B for a workspace that is not a shared view",
    async (_name, platform, modifier) => {
      const bridge = makeBridge(Promise.resolve(STORED_STATE), platform);
      renderShell(bridge);
      await screen.findByTestId("about-rail");

      // The handler re-registers in a passive effect whenever `chatsEnabled`
      // changes, so a single dispatch can land in the commit before that effect
      // runs. Retry with a fresh event: a stale one carries the previous
      // attempt's defaultPrevented and would pass on the first arming forever.
      await waitFor(() => {
        const event = new KeyboardEvent("keydown", {
          key: "b",
          ...modifier,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      });
    },
  );

  it("claims Command+Option+B when macOS reports the Option glyph", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE), "darwin");
    renderShell(bridge);
    await screen.findByTestId("about-rail");

    await waitFor(() => {
      const event = new KeyboardEvent("keydown", {
        key: "\u222b",
        code: "KeyB",
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it("leaves AltGr characters on physical KeyB unclaimed", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);
    await screen.findByTestId("about-rail");

    const event = new KeyboardEvent("keydown", {
      key: "∫",
      code: "KeyB",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId("about-rail")).toBeTruthy();
  });

  // This shell does not expose Chats for received views. The page reader can
  // read projected share rows, but opening a file must not request them here.
  it("asks for no chat mentions when a shared view opens a file", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);

    // The premise: the file really opened, so the panel that issues the call
    // really mounted.
    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.linksIn).toHaveBeenCalled());
    expect(bridge.chatFileMentionsPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("still asks for chat mentions when a normal workspace opens a file", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    await screen.findByTestId("tab-b.md");
    await waitFor(() =>
      expect(bridge.chatFileMentionsPage).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        subject: {path: "b.md"},
      }),
    );
  });

  it("waits for admission before restoring a shared view's persisted Chats tab", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH)),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledOnce());
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(screen.getByTestId("workspace-preparing")).toBeTruthy();
    expect(bridge.getWorkspaceUiState).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chats-page-share-view")).toBeNull();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();

    await act(async () => status.resolve(SHARE_STATUS));
    const placeholder = await screen.findByTestId("chats-page-share-view");
    expect(placeholder.textContent).toContain("A shared view lists no chats.");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });
});

// The same class as #620, one surface over. On a workspace that is not
// a shared view but whose capture build failed, main refuses every Chats call
// — and the shell offered the panel, the tab and the mention surfaces anyway,
// because they read the renderer's own engine flag and nothing else.
//
// The Chats view and About are persistent sidebars rather than tabs, so the
// copy decision is not the one #615 made: hiding them would remove a fixture
// of the window from a workspace that has chats on disk. Each stays and
// states the fact.
describe("chats surface after a failed capture build", () => {
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingUnavailable: true,
  };

  // Owned-workspace chat reads need a working capture. The stored layout
  // shows the Chats view on the left and About on the right.
  function makeFailedCaptureBridge() {
    const bridge = makeBridge(Promise.resolve(STORED_CHATS_STATE));
    bridge.openWorkspace = vi.fn(async () => FAILED_STATUS);
    bridge.getSyncStatus = vi.fn(async () => FAILED_STATUS);
    for (const call of [
      "listChatChannels",
      "listChannelThreads",
      "listFileChats",
      "chatFileMentionsPage",
      "syncDms",
    ] as const) {
      bridge[call].mockRejectedValue(
        new Error("Chats are not enabled for this workspace."),
      );
    }
    return bridge;
  }

  it("states the fact in the Chats view and About, and asks main for no chats", async () => {
    const bridge = makeFailedCaptureBridge();
    renderShell(bridge);

    // Both halves of the premise: the renderer's own read said engine-ON —
    // the titlebar button renders on that read alone — and main's status has
    // landed carrying the failure.
    await screen.findByTestId("titlebar-about-sidebar");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    // Both sidebars are still there. They are the fixtures the user left
    // open, and the workspace's chats are on disk — the capture build is what
    // failed.
    const placeholders = [
      await within(screen.getByTestId("side-panel")).findByTestId("chats-off"),
      await within(screen.getByTestId("about-rail")).findByTestId("about-rail-off"),
    ];
    for (const placeholder of placeholders) {
      // One line, per the empty-state recipe (copy.md), chosen by the cause
      // main established: a build failure, so it says what dohc could not do
      // and the one next step that can change it. It must never say the
      // workspace has no chats — those outlive a session whose capture failed
      // to build.
      expect(placeholder.textContent).toContain(
        "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.",
      );
      expect(placeholder.textContent).not.toContain("no chats");
      expect(placeholder.className).toContain("text-sm");
      expect(placeholder.className).toContain("text-muted");
    }

    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.listFileChats).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // An owned workspace with failed capture must not request chat pages when
  // a file opens. File links remain available independently.
  it("asks for no chat mentions when a file opens", async () => {
    const bridge = makeFailedCaptureBridge();
    renderShell(bridge);

    // The premise: the file really opened, so the panel that issues the call
    // really mounted.
    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.linksIn).toHaveBeenCalled());
    expect(bridge.chatFileMentionsPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("states the fact for a persisted Chats tab instead of a page that can only fail", async () => {
    const bridge = makeFailedCaptureBridge();
    bridge.getWorkspaceUiState = vi.fn(async () =>
      storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH),
    );
    renderShell(bridge);

    const placeholder = await screen.findByTestId("chats-page-off");
    expect(placeholder.textContent).toContain(
      "dohc could not open chats for this workspace.",
    );
    // The line that used to stand here blamed a Settings flag for all three
    // causes, including this one.
    expect(placeholder.textContent).not.toContain("aren't enabled");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The window before the decision, entered the way production enters it: the
  // renderer's own read answers first, and main's registry entry still holds
  // the defaults it registered before awaiting the capture build. Every input
  // the gate has says "recorder", and main has decided nothing.
  it("asks for no chats before main's capture decision lands", async () => {
    const decision = deferred<typeof FAILED_STATUS>();
    const bridge = makeFailedCaptureBridge();
    bridge.openWorkspace = vi.fn(() => decision.promise);
    let decided = false;
    bridge.getSyncStatus = vi.fn(async () => (decided ? FAILED_STATUS : SYNC_STATUS));
    renderShell(bridge);

    await screen.findByTestId("titlebar-about-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    // The saved sidebars wait for admission, even when the earlier status
    // read says capture is available.
    expect(bridge.getWorkspaceUiState).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-preparing")).toBeTruthy();
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(true);
    expect(screen.queryByTestId("chats-off")).toBeNull();
    expect(screen.queryByTestId("about-rail-off")).toBeNull();

    await act(async () => {
      decided = true;
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(await screen.findByTestId("chats-off")).toBeTruthy();
    expect(await screen.findByTestId("about-rail-off")).toBeTruthy();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

});

// #687/#589: the note's precedence and exact copy are pinned at the
// AgentsMcpSettings/RunnerSettingsCard layer, but every test there hands
// sessionRecorderOn and sharedView straight to SettingsDialog — bypassing
// the shell's own derivation. A regression that severs
// DesktopWorkspaceShell's wiring (for example, replacing the syncStatus ->
// sessionRecorderOn derivation with `undefined`, or dropping sharedView)
// would leave every other suite green. This test drives the real command
// palette -> Settings -> Agents path through the shell itself.
describe("runner note reaches the card through the shell's own wiring", () => {
  it("carries a recorder-less status into the restart note", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const offStatus = { ...SYNC_STATUS, historyRecordingUnavailable: true };
    bridge.openWorkspace = vi.fn(async () => offStatus);
    bridge.getSyncStatus = vi.fn(async () => offStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    // The docs send people to Agents to turn on MCP, so the palette finds it by "mcp".
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    await user.keyboard("mcp");
    await user.click(within(palette).getByText("Settings: Open Agents (MCP)"));

    const note = await screen.findByTestId("runner-self-test-engine-note");
    await waitFor(() =>
      expect(note.textContent).toBe(
        "The workspace engine starts when dohc starts. Restart dohc to test the runner.",
      ),
    );
  });

  it("carries a shared view into the no-chat note instead of the restart it can never satisfy", async () => {
    const user = userEvent.setup();
    renderShell(makeShareBridge(), SHARE_VIEW);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Agents (MCP)",
      ),
    );

    const note = await screen.findByTestId("runner-self-test-engine-note");
    await waitFor(() =>
      expect(note.textContent).toBe(
        "This workspace is a shared view. dohc records nothing here, so there is no chat to test.",
      ),
    );
    expect(note.textContent).not.toContain("restart");
  });
});
