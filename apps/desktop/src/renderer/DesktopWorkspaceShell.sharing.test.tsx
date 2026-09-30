// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
import { CHATS_TAB_PATH } from "./workbench/workbenchState";
import { deferred } from "../testing/deferred";
import { WORKSPACE, SYNC_STATUS, STORED_STATE, storedStateWithTabs, makeBridge, renderShell, shellBootstrapProps, SHARE_STATUS, SHARE_VIEW, makeShareBridge, settleShareView } from "./DesktopWorkspaceShell.testHarness";

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
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByText("a.md"));
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("a.md")).toBeTruthy();

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
          {
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
      "sam@dohc.test's server didn't take your change to packing/automations.yaml. Send it as a proposal.",
    );
    await user.click(screen.getByTestId("workspace-shell-error-action"));
    await waitFor(() => expect(bridge.submitShareChanges).toHaveBeenCalledWith({ workspaceId: SHARE_VIEW.workspaceId }));
  });

  it("pushes nothing from a share view that cannot write", async () => {
    const bridge = makeShareBridge();
    renderShell(bridge, { ...SHARE_VIEW, shareView: { shareId: "share-1", granterEmail: "sam@dohc.test", access: "comment" } });
    await screen.findByTestId("shared-view-banner");
    // It does not listen for pushes at all.
    expect(bridge.onShareDirectWritesPushed).not.toHaveBeenCalled();
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

    await user.click(await screen.findByTestId("share-changes-send"));
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

    const send = await screen.findByTestId("share-changes-send");
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

    await user.click(await screen.findByTestId("share-changes-send"));

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

    await user.click(screen.getByTestId("share-changes-send"));

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

    await user.click(screen.getByTestId("share-changes-send"));

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

    await user.click(await screen.findByTestId("share-changes-send"));
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

    await user.click(await screen.findByTestId("share-changes-send"));
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

    await user.click(await screen.findByTestId("share-changes-send"));
    expect((await screen.findByTestId("share-changes-skipped")).textContent).toBe(
      "More changes are waiting. Send again to send the rest.",
    );
  });

  it("states nothing extra when a submit took everything", async () => {
    const user = userEvent.setup();
    const bridge = makeShareBridge();
    renderShell(bridge, EDIT_SHARE);

    await user.click(await screen.findByTestId("share-changes-send"));
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

    await user.click(await screen.findByTestId("share-changes-send"));
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

    await user.click(await screen.findByTestId("share-changes-send"));
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
  });

  // The chat half of the same stance. A grant that names no
  // readable level grants no writes: the panel opens read-only, exactly as a
  // `view` share does. Asking whether the level is not `view` would answer
  // "writable" for a level nobody can read.
  it("opens chat read-only, because an unreadable grant grants no writes", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, damaged);

    await settleShareView();
    await screen.findByTestId("chats-panel");
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
  it("opens the per-file chat panel on a shared view and never asks for the workspace-wide listing", async () => {
    // The stored state opens with the Chats panel visible and b.md focused.
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
    expect(screen.getByTestId("titlebar-chats-sidebar")).toBeTruthy();

    // The file tab is the only tab. A workspace-wide listing would be a
    // superset to filter, which is the shape #627 came from.
    expect(screen.getByTestId("chats-panel-tab-file")).toBeTruthy();
    expect(screen.queryByTestId("chats-panel-tab-all")).toBeNull();
    expect(screen.queryByTestId("chats-panel-off")).toBeNull();

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

    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
    expect(bridge.listChatFileMentions).not.toHaveBeenCalled();
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
    await screen.findByTestId("chats-panel");

    await user.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
    await waitFor(() => expect(screen.queryByTestId("chats-panel")).toBeNull());

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).getByText("Toggle chats panel")).toBeTruthy();
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
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
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    expect(await screen.findByTestId("chats-panel")).toBeTruthy();
    expect(screen.getByTestId("titlebar-chats-sidebar")).toBeTruthy();
    // Both tabs. Collapsing every workspace to the share's file-only strip
    // would keep the share pin above green.
    expect(screen.getByTestId("chats-panel-tab-all")).toBeTruthy();
    expect(screen.getByTestId("chats-panel-tab-file")).toBeTruthy();
    await waitFor(() => expect(bridge.listChatChannels).toHaveBeenCalled());
    expect(screen.queryByTestId("chats-panel-off")).toBeNull();
  });

  // The graph's chat-mentions toggle, on its own. The test above proves the
  // panel is gone, and the panel's own gate hides it whatever this toggle
  // reads — so reverting this gate alone changed nothing any pin could see.
  // It is the most expensive one to lose: `includeChatMentions: true` is what
  // sends readWorkspaceGraph through requireEngineCapture, so an ungated
  // toggle fails the whole graph — a surface a shared view legitimately has.
  it("offers no chat mentions in the graph on a shared view", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    const user = userEvent.setup();
    renderShell(bridge, SHARE_VIEW);

    await settleShareView();
    await user.click(screen.getByTestId("activity-graph"));

    // The graph itself still works — that is the point.
    expect((await screen.findAllByTestId("graph-file-row")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("graph-chat-mentions-toggle")).toBeNull();
    expect(bridge.readWorkspaceGraph).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      includeChatMentions: false,
    });
    expect(bridge.readWorkspaceGraph).not.toHaveBeenCalledWith(
      expect.objectContaining({ includeChatMentions: true }),
    );
  });

  // Ctrl+Alt+B, on its own: whether the shell claims the chord from whatever
  // else would handle it. A shared view has a Chats panel to toggle now,
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
    ["Control", { ctrlKey: true }],
    ["Command", { metaKey: true }],
  ] as const)(
    "claims %s+Alt+B for a workspace that is not a shared view",
    async (_name, modifier) => {
      const bridge = makeBridge(Promise.resolve(STORED_STATE));
      renderShell(bridge);
      await screen.findByTestId("chats-panel");

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
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);
    await screen.findByTestId("chats-panel");

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
    await screen.findByTestId("chats-panel");

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
    expect(screen.getByTestId("chats-panel")).toBeTruthy();
  });

  // The last ungated chat call. Linked mentions ride on every markdown open
  // and every window refocus, and `listChatFileMentions` goes through
  // requireEngineCapture like every other Chats call — so a shared view was
  // still issuing one refused call per file open. Its own `.catch` swallowed
  // the refusal, which is exactly why nothing caught it.
  it("asks for no chat mentions when a shared view opens a file", async () => {
    const bridge = makeShareBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge, SHARE_VIEW);

    // The premise: the file really opened, so the panel that issues the call
    // really mounted.
    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.getBacklinks).toHaveBeenCalled());
    expect(bridge.listChatFileMentions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("still asks for chat mentions when a normal workspace opens a file", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderShell(bridge);

    await screen.findByTestId("tab-b.md");
    await waitFor(() =>
      expect(bridge.listChatFileMentions).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        path: "b.md",
      }),
    );
  });

  // The ordering interaction #626 found, on this surface. A shared view's
  // status also says no recorder, so once one lands the status clause alone
  // would produce the same result and the share clause would survive
  // deletion. Holding the status pending is what isolates it: `isShareView`
  // is a synchronous registry fact, and it is the only thing that can answer
  // in this window.
  it("states the shared-view fact for a persisted Chats tab before any status arrives", async () => {
    const status = deferred<typeof SHARE_STATUS>();
    const bridge = makeShareBridge(
      Promise.resolve(storedStateWithTabs([CHATS_TAB_PATH], CHATS_TAB_PATH)),
    );
    bridge.openWorkspace = vi.fn(() => status.promise);
    bridge.getSyncStatus = vi.fn(() => status.promise);
    renderShell(bridge, SHARE_VIEW);

    const placeholder = await screen.findByTestId("chats-page-share-view");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(placeholder.textContent).toContain("A shared view lists no chats.");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
  });
});

// The same class as #620, one surface over. On a workspace that is not
// a shared view but whose capture build failed, main refuses every Chats call
// — and the shell offered the panel, the tab and the mention surfaces anyway,
// because they read the renderer's own engine flag and nothing else.
//
// Chats is a persistent sidebar rather than a tab, so the copy decision is
// not the one #615 made: hiding it would remove a fixture of the window from
// a workspace that has chats on disk. The panel stays and states the fact.
describe("chats surface after a failed capture build", () => {
  const FAILED_STATUS = {
    ...SYNC_STATUS,
    historyRecordingUnavailable: true,
  };

  // Main's real answers once the capture build failed: every Chats call goes
  // through requireEngineCapture, which has no capture to hand it.
  function makeFailedCaptureBridge() {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.openWorkspace = vi.fn(async () => FAILED_STATUS);
    bridge.getSyncStatus = vi.fn(async () => FAILED_STATUS);
    for (const call of [
      "listChatChannels",
      "listChannelThreads",
      "listFileChats",
      "listChatFileMentions",
      "syncDms",
    ] as const) {
      bridge[call].mockRejectedValue(
        new Error("Chats are not enabled for this workspace."),
      );
    }
    return bridge;
  }

  it("states the fact in the Chats sidebar and asks main for no chats", async () => {
    const bridge = makeFailedCaptureBridge();
    renderShell(bridge);

    // Both halves of the premise: the renderer's own read said engine-ON —
    // the titlebar button renders on that read alone — and main's status has
    // landed carrying the failure.
    await screen.findByTestId("titlebar-chats-sidebar");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );

    // The sidebar is still there. It is the fixture the user left open, and
    // the workspace's chats are on disk — the capture build is what failed.
    expect(screen.getByTestId("chats-panel")).toBeTruthy();
    const placeholder = await screen.findByTestId("chats-panel-off");
    // One line, per the empty-state recipe (copy.md), chosen by the cause main
    // established: a build failure, so it says what dohc could not do and the
    // one next step that can change it. It must never say the workspace has
    // no chats — those outlive a session whose capture failed to build.
    expect(placeholder.textContent).toContain(
      "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.",
    );
    expect(placeholder.textContent).not.toContain("no chats");
    expect(placeholder.className).toContain("text-sm");
    expect(placeholder.className).toContain("text-muted");

    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    expect(bridge.listFileChats).not.toHaveBeenCalled();
    expect(bridge.syncDms).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // The linked-mentions panel rides every markdown open, and
  // listChatFileMentions goes through requireEngineCapture like every other
  // Chats call. Its own `.catch` swallows the refusal, which is why nothing
  // caught it (the last ungated call, from the other cause).
  it("asks for no chat mentions when a file opens", async () => {
    const bridge = makeFailedCaptureBridge();
    renderShell(bridge);

    // The premise: the file really opened, so the panel that issues the call
    // really mounted.
    await screen.findByTestId("tab-b.md");
    await waitFor(() => expect(bridge.getBacklinks).toHaveBeenCalled());
    expect(bridge.listChatFileMentions).not.toHaveBeenCalled();
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

    await screen.findByTestId("titlebar-chats-sidebar");
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(bridge.listChatChannels).not.toHaveBeenCalled();
    // The panel is mounted and states nothing: neither read the shell has
    // done proves anything about what main decided.
    expect(screen.getByTestId("chats-panel")).toBeTruthy();
    expect(screen.queryByTestId("chats-panel-off")).toBeNull();

    await act(async () => {
      decided = true;
      decision.resolve(FAILED_STATUS);
      await decision.promise;
    });
    expect(await screen.findByTestId("chats-panel-off")).toBeTruthy();
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
// palette -> Settings -> Agents & MCP path through the shell itself.
describe("runner note reaches the card through the shell's own wiring", () => {
  it("carries a recorder-less status into the restart note", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const offStatus = { ...SYNC_STATUS, historyRecordingUnavailable: true };
    bridge.openWorkspace = vi.fn(async () => offStatus);
    bridge.getSyncStatus = vi.fn(async () => offStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Agents & MCP",
      ),
    );

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
        "Settings: Open Agents & MCP",
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
