// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { ENGINE_STORE_BACKUP_DIR } from "../ipc/bridgeContract";
import type { OwnerLiveDocumentsResult, McpConfigResult, NoticeRow, RebuildEngineStoreResult, SyncStatusResult } from "../ipc/bridgeContract";
import type { SentNotices } from "./shell/useSentNotices";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { deferred } from "../testing/deferred";
import { WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, READY_UPDATE_STATE, storedStateWithTabs, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

// A data store the engine refuses gets a real recovery, not a dead
// generic error. The notice explains what was found; the rebuild is explicit
// (a confirmed click), states the destination before anything moves, and the
// success copy names the reverse path.
describe("engine store recovery", () => {
  const refusedStatus = {
    ...SYNC_STATUS,
    historyCaptureFailed: true as const,
    engineStoreRefused: "unsupported-fingerprint" as const,
  };

  async function openRebuildDialog(bridge: ReturnType<typeof makeBridge>) {
    const user = userEvent.setup();
    renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(
      within(
        await screen.findByTestId("notice-engine-store-refused"),
      ).getByRole("button", { name: "Rebuild" }),
    );
    return { user, dialog: await screen.findByTestId("engine-rebuild-dialog") };
  }

  it("keeps focus in the dialog during the move and restores it after close", async () => {
    const decision = deferred<RebuildEngineStoreResult>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(() => decision.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const user = userEvent.setup();
    renderShell(bridge);
    const trigger = await screen.findByTestId("notice-center-toggle");
    await user.click(trigger);
    await user.click(
      within(
        await screen.findByTestId("notice-engine-store-refused"),
      ).getByRole("button", { name: "Rebuild" }),
    );

    const dialog = await screen.findByTestId("engine-rebuild-dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    await user.click(
      within(dialog).getByRole("button", { name: "Move and rebuild" }),
    );
    expect(
      (within(dialog).getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", {
        name: "Moving",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.tab();

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialog);

    await act(async () => {
      decision.resolve({ outcome: "moved" });
      await decision.promise;
    });
    const done = await within(dialog).findByRole("button", { name: "Done" });
    expect(document.activeElement).toBe(done);
    await user.click(done);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("confirms before moving, then shows a moved result and its reverse path", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    // A partial move completed during reopen has this same result.
    bridge.rebuildEngineStore = vi.fn(async () => ({
      outcome: "moved" as const,
    }));
    const { user, dialog } = await openRebuildDialog(bridge);

    expect(
      screen.getByRole("dialog", {
        name: "Move the old data store aside and rebuild?",
      }),
    ).toBe(dialog);

    // The user learns what moves, where it goes, and what does not come
    // back, before anything moves.
    expect(dialog.textContent).toContain(".dohc/engine/pre-v2-backup");
    expect(dialog.textContent).toContain(
      "The old data store stays in the backup location. History and chats stored only there will not appear in the rebuilt workspace. Your workspace files stay in place.",
    );
    expect(bridge.rebuildEngineStore).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "Move and rebuild" }),
    );
    expect(bridge.rebuildEngineStore).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
    });
    // The reverse path, named in the success copy (product invariant: every
    // reversible state change shows its reverse).
    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Data store moved" }),
      ).toBe(dialog);
      expect(
        screen.getByTestId("engine-rebuild-dialog").textContent,
      ).toContain(`The old data store is at ${ENGINE_STORE_BACKUP_DIR}`);
    });
  });

  it.each([
    {
      cause: "unsupported-fingerprint" as const,
      sentence:
        "This workspace's data store is not in the format this version of dohc uses.",
      otherSentence: "dohc cannot read this workspace's data store.",
    },
    {
      cause: "foreign-database" as const,
      sentence: "dohc cannot read this workspace's data store.",
      otherSentence:
        "This workspace's data store is not in the format this version of dohc uses.",
    },
  ])("names the $cause refusal in the confirm dialog", async ({
    cause,
    sentence,
    otherSentence,
  }) => {
    const status = { ...refusedStatus, engineStoreRefused: cause };
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);

    const { dialog } = await openRebuildDialog(bridge);

    expect(dialog.textContent).toContain(sentence);
    expect(dialog.textContent).not.toContain(otherSentence);
    expect(dialog.textContent).not.toContain("older");
    expect(dialog.textContent).not.toContain("not created by dohc");
  });

  // A store this build could not migrate, or one a newer build migrated, is
  // intact and waits for a build that opens it. The workspace stops instead
  // of offering a rebuild that would lose what that build still opens.
  it.each([
    {
      cause: "migration-failed" as const,
      detail: "migration v2-baseline was applied from a different definition than this build's",
      sentence: "dohc could not update this workspace's data store to this version.",
    },
    {
      cause: "migrated-by-newer-build" as const,
      detail: "a newer build ran migration 5 (from-a-newer-build), which this build does not define",
      sentence: "A newer version of dohc updated this workspace's data store.",
    },
  ])("stops the workspace on $cause instead of offering the rebuild", async ({
    cause,
    detail,
    sentence,
  }) => {
    const status = {
      ...refusedStatus,
      engineStoreRefused: cause,
      engineStoreRefusedDetail: detail,
    };
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    const user = userEvent.setup();
    renderShell(bridge);

    const blocked = await screen.findByTestId("workspace-update-required");
    // Technical details reveals the report; Copy inside it copies the same lines.
    await user.click(within(blocked).getByRole("button", { name: "Show technical details" }));
    const details = await screen.findByTestId("workspace-update-details");
    await user.click(within(details).getByRole("button", { name: "Copy" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain(`Problem: ${sentence}`);
    expect(copied).toContain(`Code: ${cause}`);
    expect(copied).toContain(`Engine: ${detail}`);
    expect(copied).toContain("Workspace id: ");
    expect(copied).toContain("Folder: ");
    expect(copied).toContain("Platform: ");
    for (const line of copied.split("\n")) {
      const [label, value] = line.split(": ");
      expect(within(details).getByText(label!)).toBeTruthy();
      expect(details.textContent).toContain(value!);
    }
    expect(blocked.textContent).toContain(`${sentence} Your files are unchanged.`);
    expect(blocked.textContent).toContain("Update dohc to continue");
    // The check answers inside the stop state, where the user can see it.
    bridge.checkForUpdates = vi.fn(async () => ({
      checked: false,
      state: { status: "idle" as const, message: "Updates are available in packaged builds." },
    }));
    await user.click(within(blocked).getByRole("button", { name: "Check for updates" }));
    const result = await screen.findByTestId("workspace-update-check-result");
    expect(result.textContent).toBe("Updates are available in packaged builds.");
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    await user.click(await screen.findByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId("notice-engine-store-refused");
    expect(within(notice).queryByRole("button", { name: "Rebuild" })).toBeNull();
    expect(screen.queryByTestId("engine-rebuild-dialog")).toBeNull();
  });

  // Restarting closes the app, so every Restart asks once first. The stop
  // state's button opens the same prompt the update notice uses.
  it("asks before restarting into a ready update from the stop state", async () => {
    const status = { ...refusedStatus, engineStoreRefused: "migration-failed" as const };
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.getUpdateState = vi.fn(async () => READY_UPDATE_STATE);
    const user = userEvent.setup();
    renderShell(bridge);

    const blocked = await screen.findByTestId("workspace-update-required");
    await user.click(
      await within(blocked).findByRole("button", { name: "Restart to update" }),
    );
    const dialog = await screen.findByTestId("restart-to-update-dialog");
    expect(dialog.textContent).toContain("Restart dohc to apply the update?");
    expect(dialog.textContent).toContain("Update 1.2.4 is downloaded.");
    expect(bridge.installUpdate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("restart-to-update-dialog")).toBeNull();
    expect(bridge.installUpdate).not.toHaveBeenCalled();

    await user.click(within(blocked).getByRole("button", { name: "Restart to update" }));
    await user.click(
      within(await screen.findByTestId("restart-to-update-dialog")).getByRole("button", {
        name: "Restart now",
      }),
    );
    await waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledOnce());
  });

  it(
    "reopens a mounted live document after a successful rebuild and sends the next edit to the fresh session",
    async () => {
      const rebuild = deferred<RebuildEngineStoreResult>();
      let liveSessionsGeneration = 0;
      const bridge = makeBridge(
        Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
      );
      bridge.openWorkspace = vi.fn(async () => ({
        ...refusedStatus,
        liveSessionsGeneration,
      }));
      bridge.getSyncStatus = vi.fn(async () => ({
        ...refusedStatus,
        liveSessionsGeneration,
      }));
      bridge.rebuildEngineStore = vi.fn(() => rebuild.promise);
      const sessionIds: string[] = [];
      const openEngineYDocSession = vi.fn(
        async (payload: { sessionId: string }) => {
          sessionIds.push(payload.sessionId);
          const doc = markdownToYDoc("# Doc\n");
          return {
            available: true,
            initialUpdate: Y.encodeStateAsUpdate(doc),
            lineageGeneration: 1,
          };
        },
      );
      const applyEngineYDocUpdate = vi.fn(
        async (_payload: { sessionId: string }) => ({ accepted: true as const }),
      );
      const closeEngineYDocSession = vi.fn(async () => undefined);
      Object.assign(bridge, {
        openEngineYDocSession,
        applyEngineYDocUpdate,
        closeEngineYDocSession,
        onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
        onEngineYDocSaveState: vi.fn(() => () => undefined),
        onEngineYDocOwnerHandoff: () => () => undefined,
        prepareEngineYDocOwnerHandoff: async () => undefined,
        onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
        acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({
          accepted: true as const,
          updates: [],
        })),
      });
      const { user, dialog } = await openRebuildDialog(bridge);
      await screen.findByTestId("markdown-source-toggle");
      await waitFor(() =>
        expect(openEngineYDocSession).toHaveBeenCalledTimes(1),
      );

      await user.click(
        within(dialog).getByRole("button", { name: "Move and rebuild" }),
      );
      await waitFor(() =>
        expect(bridge.rebuildEngineStore).toHaveBeenCalledOnce(),
      );
      expect(openEngineYDocSession).toHaveBeenCalledTimes(1);
      expect(closeEngineYDocSession).not.toHaveBeenCalled();

      await act(async () => {
        liveSessionsGeneration += 1;
        bridge.emitWorkspaceActivity();
        rebuild.resolve({ outcome: "moved" });
        await rebuild.promise;
      });

      await waitFor(() =>
        expect(openEngineYDocSession).toHaveBeenCalledTimes(2),
      );
      expect(closeEngineYDocSession).toHaveBeenCalledTimes(1);
      expect(
        closeEngineYDocSession.mock.invocationCallOrder[0],
      ).toBeLessThan(openEngineYDocSession.mock.invocationCallOrder[1]!);

      applyEngineYDocUpdate.mockClear();
      await user.type(screen.getByTestId("page-title"), " after rebuild");
      await waitFor(() => expect(applyEngineYDocUpdate).toHaveBeenCalled());
      expect(applyEngineYDocUpdate.mock.calls.at(-1)?.[0].sessionId).toBe(
        sessionIds[1],
      );
    },
  );

  it("remounts live editors in every shell when one shell rebuilds the workspace", async () => {
    const rebuild = deferred<RebuildEngineStoreResult>();
    let liveSessionsGeneration = 0;
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    bridge.openWorkspace = vi.fn(async () => ({
      ...refusedStatus,
      liveSessionsGeneration,
    }));
    bridge.getSyncStatus = vi.fn(async () => ({
      ...refusedStatus,
      liveSessionsGeneration,
    }));
    bridge.rebuildEngineStore = vi.fn(() => rebuild.promise);
    const openedSessions: Array<{
      path: string;
      sessionId: string;
      workspaceId: string;
    }> = [];
    const openEngineYDocSession = vi.fn(
      async (payload: {
        path: string;
        sessionId: string;
        workspaceId: string;
      }) => {
        openedSessions.push(payload);
        const doc = markdownToYDoc("# Doc\n");
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          lineageGeneration: 1,
        };
      },
    );
    const closeEngineYDocSession = vi.fn(
      async (_payload: { sessionId: string }) => undefined,
    );
    Object.assign(bridge, {
      openEngineYDocSession,
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      closeEngineYDocSession,
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({
        accepted: true as const,
        updates: [],
      })),
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const first = render(
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledOnce());
    bridge.getWorkspaceUiState.mockResolvedValue(
      storedStateWithTabs(["b.md"], "b.md"),
    );
    const second = render(
      <DesktopWorkspaceShell
        workspace={WORKSPACE}
        workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(2));
    expect(openedSessions.slice(0, 2).map(({ path }) => path).sort()).toEqual([
      "a.md",
      "b.md",
    ]);

    const user = userEvent.setup();
    await user.click(
      await within(first.container).findByTestId("notice-center-toggle"),
    );
    await user.click(
      within(
        await within(first.container).findByTestId(
          "notice-engine-store-refused",
        ),
      ).getByRole("button", { name: "Rebuild" }),
    );
    await user.click(
      within(
        within(first.container).getByTestId("engine-rebuild-dialog"),
      ).getByRole("button", { name: "Move and rebuild" }),
    );
    await waitFor(() => expect(bridge.rebuildEngineStore).toHaveBeenCalledOnce());

    const originalSessionIds = openedSessions
      .slice(0, 2)
      .map(({ sessionId }) => sessionId)
      .sort();
    await act(async () => {
      liveSessionsGeneration = 1;
      bridge.emitWorkspaceActivity();
      rebuild.resolve({ outcome: "moved" });
      await rebuild.promise;
    });

    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(closeEngineYDocSession).toHaveBeenCalledTimes(2));
    expect(
      closeEngineYDocSession.mock.calls
        .map(([payload]) => payload.sessionId)
        .sort(),
    ).toEqual(originalSessionIds);
    expect(
      openedSessions.slice(2).map(({ path }) => path).sort(),
    ).toEqual(["a.md", "b.md"]);
    expect(
      openedSessions
        .slice(2)
        .map(({ sessionId }) => sessionId)
        .sort(),
    ).not.toEqual(originalSessionIds);
    second.unmount();
  });

  it("baselines the live-session generation when the shell switches workspaces", async () => {
    const workspaceB: Workspace = {
      ...WORKSPACE,
      workspaceId: "ws-shell-b",
      rootPath: "/home/sam/dohc/b",
    };
    let currentStatus: SyncStatusResult = {
      ...SYNC_STATUS,
      liveSessionsGeneration: 5,
    };
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    bridge.openWorkspace = vi.fn(async () => currentStatus);
    bridge.getSyncStatus = vi.fn(async () => currentStatus);
    const openEngineYDocSession = vi.fn(
      async (_payload: { workspaceId: string }) => {
        const doc = markdownToYDoc("# Doc\n");
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          lineageGeneration: 1,
        };
      },
    );
    Object.assign(bridge, {
      openEngineYDocSession,
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({
        accepted: true as const,
        updates: [],
      })),
    });
    const view = renderShell(bridge, WORKSPACE, [WORKSPACE, workspaceB]);
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledOnce());

    currentStatus = { ...SYNC_STATUS, liveSessionsGeneration: 0 };
    view.rerender(
      <DesktopWorkspaceShell
        workspace={workspaceB}
        workspaces={[WORKSPACE, workspaceB]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        openEngineYDocSession.mock.calls.filter(
          ([payload]) => payload.workspaceId === workspaceB.workspaceId,
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(bridge.openWorkspace).toHaveBeenCalledWith({
        workspaceId: workspaceB.workspaceId,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      openEngineYDocSession.mock.calls.filter(
        ([payload]) => payload.workspaceId === workspaceB.workspaceId,
      ),
    ).toHaveLength(1);
  });

  it("keeps a mounted live document on its current session when the rebuild rejects", async () => {
    const bridge = makeBridge(
      Promise.resolve(storedStateWithTabs(["a.md"], "a.md")),
    );
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(async () => {
      throw new Error("The store was not refused");
    });
    const openEngineYDocSession = vi.fn(async () => {
      const doc = markdownToYDoc("# Doc\n");
      return {
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        lineageGeneration: 1,
      };
    });
    const closeEngineYDocSession = vi.fn(async () => undefined);
    Object.assign(bridge, {
      openEngineYDocSession,
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      closeEngineYDocSession,
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({
        accepted: true as const,
        updates: [],
      })),
    });
    const { user, dialog } = await openRebuildDialog(bridge);
    await screen.findByTestId("markdown-source-toggle");
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledOnce());

    await user.click(
      within(dialog).getByRole("button", { name: "Move and rebuild" }),
    );

    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain("The store was not refused");
    await waitFor(() => expect(closeEngineYDocSession).not.toHaveBeenCalled());
    expect(openEngineYDocSession).toHaveBeenCalledOnce();
  });

  it("refuses to write over an existing backup and says what to do", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(async () => ({
      outcome: "backup-exists" as const,
    }));
    const { user, dialog } = await openRebuildDialog(bridge);

    await user.click(
      within(dialog).getByRole("button", { name: "Move and rebuild" }),
    );
    await waitFor(() => {
      const text = screen.getByTestId("engine-rebuild-dialog").textContent;
      expect(text).toContain(
        "A file or folder already exists at .dohc/engine/pre-v2-backup",
      );
      expect(text).toContain("Move it away, then try again.");
    });
  });

  it("reports a completed move and a reopen failure separately", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(async () => ({
      outcome: "moved" as const,
      reopenFailed:
        "dohc could not finish rebuilding this workspace's data store.",
    }));
    const { user, dialog } = await openRebuildDialog(bridge);

    await user.click(
      within(dialog).getByRole("button", { name: "Move and rebuild" }),
    );

    await waitFor(() => {
      const text = screen.getByTestId("engine-rebuild-dialog").textContent;
      expect(text).toContain(
        "The old data store is at .dohc/engine/pre-v2-backup",
      );
      expect(text).toContain(
        "dohc could not finish rebuilding this workspace's data store.",
      );
      expect(text).not.toContain("could not move");
    });
  });

  it("surfaces a failed move in the shell error banner", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'desktop:rebuild-engine-store': Error [EACCES]: EACCES: permission denied",
      );
    });
    const { user, dialog } = await openRebuildDialog(bridge);

    await user.click(
      within(dialog).getByRole("button", { name: "Move and rebuild" }),
    );
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "dohc could not move this workspace's data store. dohc does not have permission to use this file or folder.",
    );
    expect(toast.textContent).not.toContain("EACCES");
    // Copy keeps the error as it arrived, on its own line.
    await user.click(within(toast).getByTestId("workspace-shell-error-copy"));
    const copied = await navigator.clipboard.readText();
    expect(copied.split("\n").slice(0, 2)).toEqual([
      "Error: dohc could not move this workspace's data store. dohc does not have permission to use this file or folder.",
      "Cause: Error [EACCES]: EACCES: permission denied",
    ]);
    expect(screen.queryByTestId("engine-rebuild-dialog")).toBeNull();
  });

  it("clears rebuild state in the first render for a new workspace and discards the old response", async () => {
    const decision = deferred<RebuildEngineStoreResult>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(() => decision.promise);
    const workspaceB: Workspace = {
      ...WORKSPACE,
      workspaceId: "ws-shell-b",
      rootPath: "/home/sam/dohc/b",
    };
    const user = userEvent.setup();
    const view = renderShell(bridge, WORKSPACE, [WORKSPACE, workspaceB]);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(
      within(await screen.findByTestId("notice-engine-store-refused")).getByRole(
        "button",
        { name: "Rebuild" },
      ),
    );
    await user.click(
      within(screen.getByTestId("engine-rebuild-dialog")).getByRole("button", {
        name: "Move and rebuild",
      }),
    );
    expect(screen.getByTestId("engine-rebuild-dialog").textContent).toContain(
      "Moving",
    );

    view.rerender(
      <DesktopWorkspaceShell
        workspace={workspaceB}
        workspaces={[WORKSPACE, workspaceB]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );

    expect(screen.queryByTestId("engine-rebuild-dialog")).toBeNull();

    await act(async () => {
      decision.reject(new Error("Workspace A rebuild failed"));
      await decision.promise.catch(() => undefined);
    });
    expect(screen.queryByTestId("engine-rebuild-dialog")).toBeNull();
    expect(
      screen.queryByTestId("workspace-shell-error")?.textContent ?? "",
    ).not.toContain("Workspace A rebuild failed");
  });
});

describe("workspace shell errors", () => {
  it("keeps the workbench unavailable while existing files are prepared", async () => {
    const decision = deferred<typeof SYNC_STATUS>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(() => decision.promise);

    renderShell(bridge);

    const preparing = await screen.findByTestId("workspace-preparing");
    expect(preparing.getAttribute("role")).toBe("status");
    expect(preparing.textContent).toContain("Preparing this workspace");
    expect(preparing.textContent).toContain(
      "dohc is checking your existing files before editing starts.",
    );
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("false");
    expect(
      screen.getByTestId("workspace-workbench").hasAttribute("inert"),
    ).toBe(true);

    await act(async () => {
      decision.resolve(SYNC_STATUS);
      await decision.promise;
    });

    await waitFor(() =>
      expect(screen.queryByTestId("workspace-preparing")).toBeNull(),
    );
    expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true");
    expect(
      screen.getByTestId("workspace-workbench").hasAttribute("inert"),
    ).toBe(false);
  });

  it("keeps a failed workspace inert and opens it when the user retries", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace
      .mockRejectedValueOnce(new Error("Watcher failed"))
      .mockRejectedValueOnce(new Error("Watcher still unavailable"));

    renderShell(bridge);

    const recovery = await screen.findByTestId("workspace-open-failed");
    expect(recovery.getAttribute("role")).toBe("alert");
    expect(recovery.textContent).toContain("Couldn’t open this workspace");
    expect(recovery.textContent).toContain("Watcher failed");
    expect(recovery.textContent).toContain("Choose another workspace from the title bar");
    expect(within(recovery).queryByRole("button", { name: /dismiss/i })).toBeNull();
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(true);

    fireEvent.click(within(recovery).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(2));
    const repeatedRecovery = await screen.findByTestId("workspace-open-failed");
    expect(repeatedRecovery.textContent).toContain("Watcher still unavailable");
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(true);

    fireEvent.click(within(repeatedRecovery).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    expect(screen.queryByTestId("workspace-open-failed")).toBeNull();
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(false);
  });

  it("says why a workspace did not open in words and keeps the refusal for Copy", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:open-workspace': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    ));
    const user = userEvent.setup();
    renderShell(bridge);

    const recovery = await screen.findByTestId("workspace-open-failed");
    expect(recovery.textContent).toContain(
      "dohc is still reading this workspace's files. Try again when it finishes.",
    );
    expect(recovery.textContent).not.toMatch(/DaemonRefusalError|OVERLOADED|invoking remote method/);
    await user.click(within(recovery).getByRole("button", { name: "Copy details" }));
    const copied = (await navigator.clipboard.readText()).split("\n");
    expect(copied.slice(0, 3)).toEqual([
      "Error: Couldn't open this workspace",
      "Detail: dohc is still reading this workspace's files. Try again when it finishes.",
      "Cause: DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    ]);
  });

  it("retries a failed initial listing without reopening the workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("Listing failed"));

    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(
      false,
    );
    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain("Could not refresh workspace files. Listing failed");
    expect(bridge.openWorkspace).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(bridge.openWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("reports refresh failures after a successful file import without retrying import", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalled());
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("Refresh failed"));

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));

    await waitFor(() => {
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "Refresh failed",
      );
    });
  });
});

// Automation failures (ADR 0008, Phase 4): the engine's failed claim rows
// become one durable notice per automation until the owner acknowledges the
// generation on screen. Modelled on the share-refusal banner above: the
// read comes from main on open and on every failure poke, so a restart
// re-raises anything unacknowledged.
describe("crash report notice", () => {
  const REPORT = {
    revision: 3,
    through: 3,
    source: "engine" as const,
    problems: 1,
    atMs: 5_000,
    text: "dohc crash report\n\nTime: 1970-01-01T00:00:05.000Z\nProcess: workspace engine",
  };

  it("offers Copy report and no Send report when this build has no report server", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    renderShell(bridge);

    const toast = await screen.findByTestId("crash-report-toast");
    expect(toast.textContent).toContain("The workspace engine failed");
    expect(screen.queryByTestId("crash-report-toast-send")).toBeNull();
    expect(screen.getByTestId("crash-report-toast-copy").getAttribute("aria-label")).toBe("Copy report");

    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("notice-crash-report");
    expect(row.textContent).not.toContain("Send report");
    expect(screen.getByTestId("notice-crash-report-copy").getAttribute("aria-label")).toBe("Copy report");
    expect(bridge.sendCrashReport).not.toHaveBeenCalled();
  });

  it("hands Send report to main, which asks, and says Report sent only when it went", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: "reports.example.test" });
    // The person cancelled main's dialog.
    bridge.sendCrashReport.mockResolvedValueOnce({ sent: false });
    renderShell(bridge);

    await user.click(await screen.findByTestId("crash-report-toast-send"));
    await waitFor(() => expect(bridge.sendCrashReport).toHaveBeenCalledWith({}));
    // No dialog of the renderer's own: main asks.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("crash-report-toast-send")).toBeTruthy());
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();

    bridge.sendCrashReport.mockResolvedValueOnce({ sent: true });
    bridge.readCrashReport.mockResolvedValue({ report: null, sendTo: "reports.example.test" });
    await user.click(screen.getByTestId("crash-report-toast-send"));
    await waitFor(() => expect(screen.queryByTestId("crash-report-toast")).toBeNull());
    expect((await screen.findByTestId("workspace-shell-notice")).textContent).toContain("Report sent");
  });

  it("keeps the report and offers Try again when the send fails", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: "reports.example.test" });
    bridge.sendCrashReport.mockRejectedValueOnce(
      new Error("Error invoking remote method 'desktop:send-crash-report': Error: The connection to the report server failed."),
    );
    renderShell(bridge);

    await user.click(await screen.findByTestId("crash-report-toast-send"));
    const error = await screen.findByTestId("workspace-shell-error");
    expect(error.textContent).toContain("dohc could not send the crash report. The connection to the report server failed.");

    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.sendCrashReport).toHaveBeenCalledTimes(2));
  });

  it("dismisses up to the problem on screen and shows a newer report on the poke", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    bridge.readCrashReport.mockResolvedValue({ report: null, sendTo: null });
    await user.click(await screen.findByTestId("notice-crash-report-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("notice-crash-report")).toBeNull());
    expect(bridge.dismissCrashReport).toHaveBeenCalledWith({ through: 3 });

    bridge.readCrashReport.mockResolvedValue({
      report: { ...REPORT, revision: 5, through: 4, source: "window", problems: 2 },
      sendTo: null,
    });
    act(() => bridge.emitCrashReportChanged());
    const row = await screen.findByTestId("notice-crash-report");
    expect(row.textContent).toContain("A dohc window stopped unexpectedly");
    expect(row.textContent).toContain("This report holds 2 problems.");
  });
});

describe("notices sent to you", () => {
  function sentNotices(notices: NoticeRow[]): SentNotices {
    return {
      account: null,
      notices,
      settled: true,
      listFailure: null,
      relist: vi.fn(),
      toast: null,
      hideToast: vi.fn(),
      read: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    };
  }
  const MENTION: NoticeRow = {
    store: "account",
    noticeId: "mention:1",
    kind: "mention",
    workspaceId: WORKSPACE.workspaceId,
    recipientShareId: null,
    senderKind: "person",
    senderLabel: "Ana",
    title: "Ana mentioned you in b.md",
    body: "",
    target: { path: "b.md" },
    createdAtMs: 5_000,
    readAtMs: null,
    postedHere: false,
  };

  function renderWithNotices(
    bridge: ReturnType<typeof makeBridge>,
    extra: { sentNotices?: SentNotices; openPathOnReady?: string; onSwitchWorkspace?: (workspace: Workspace, openPath?: string) => void },
    workspaces: Workspace[] = [WORKSPACE],
  ) {
    vi.stubGlobal("dohcDesktop", bridge);
    return render(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell
          workspace={WORKSPACE}
          workspaces={workspaces}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={extra.onSwitchWorkspace ?? (() => {})}
          {...(extra.sentNotices ? { sentNotices: extra.sentNotices } : {})}
          {...(extra.openPathOnReady ? { openPathOnReady: extra.openPathOnReady } : {})}
        />
      </>,
    );
  }

  it("keeps a newer refusal after an older shell dismissal finishes", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    const shown: NoticeRow = { ...MENTION, store: "local", kind: "sync-refusal", noticeId: "refusal",
      body: "A change needs review", refusalCoordinates: [{ originId: "peer", originSeq: 1 }] };
    const dismissed = deferred<void>();
    const notices = { ...sentNotices([shown]), dismiss: vi.fn(() => dismissed.promise) };
    const view = renderWithNotices(bridge, { sentNotices: notices });
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("notice-refusal-dismiss"));
    expect(notices.dismiss).toHaveBeenCalledWith(shown);
    const newer = { ...shown, body: "A newer change needs review",
      refusalCoordinates: [{ originId: "peer", originSeq: 2 }] };
    view.rerender(<>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell workspace={WORKSPACE} workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}}
        sentNotices={{ ...notices, notices: [newer] }} />
    </>);
    expect((await screen.findByTestId("notice-refusal")).textContent).toContain(newer.body);
    await act(async () => dismissed.resolve());
    expect(screen.getByTestId("notice-refusal").textContent).toContain(newer.body);
  });

  it("opens a notice's file in this workspace and marks it read", async () => {
    const user = userEvent.setup();
    const notices = sentNotices([MENTION]);
    renderWithNotices(makeBridge(Promise.resolve(null)), { sentNotices: notices });

    const toggle = await screen.findByTestId("notice-center-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Notices, 1 unread");
    await user.click(toggle);
    await user.click(within(await screen.findByTestId("sent-notice-mention:1")).getByRole("button", { name: "Open" }));
    await screen.findByTestId("tab-b.md");
    expect(notices.read).toHaveBeenCalledWith([{ store: "account", noticeId: "mention:1" }]);
  });

  it("switches to the workspace that holds a notice, with its file", async () => {
    const user = userEvent.setup();
    const trip: Workspace = { ...WORKSPACE, workspaceId: "ws-trip", rootPath: "/home/sam/dohc/trip" };
    const onSwitchWorkspace = vi.fn();
    renderWithNotices(
      makeBridge(Promise.resolve(null)),
      { sentNotices: sentNotices([{ ...MENTION, workspaceId: "ws-trip", target: { path: "Japan/day-1.md" } }]), onSwitchWorkspace },
      [WORKSPACE, trip],
    );
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("sent-notice-mention:1");
    expect(row.textContent).toContain("Japan");
    await user.click(within(row).getByRole("button", { name: "Open" }));
    expect(onSwitchWorkspace).toHaveBeenCalledWith(trip, "Japan/day-1.md");
  });

  const FAILED = (id: string, claimId: string): NoticeRow => ({
    ...MENTION,
    noticeId: `automation-failed:${id}`,
    kind: "automation-failed",
    senderKind: "automation",
    title: `Automation "${id}" failed`,
    body: "The record is open elsewhere. It ran on this computer.",
    target: { automation: `collection:tasks#${id}`, path: "tasks/automations.yaml", run: claimId },
    postedHere: true,
  });
  function withRuns(bridge: ReturnType<typeof makeBridge>) {
    bridge.listCollections = vi.fn(async () => ({
      collections: [{ path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] }],
    }));
    // Main finds each automation's Collection by its id.
    bridge.findAutomationCollection.mockResolvedValue({ status: "found", collectionPath: "tasks" });
    bridge.listCollectionAutomationRuns.mockImplementation(async ({ automationId }) => ({ status: "listed", runs: [{
      claimId: automationId.endsWith("#first") ? "atc_first" : "atc_second", state: "failed" as const,
      error: "The record is open elsewhere.", createdAtMs: 5_000, updatedAtMs: 5_000,
      trigger: { kind: "changed", recordId: "rec_1", by: "human", sharedAuthor: null, depth: 0 }, writes: [], definitionChanged: false, neverStarted: false, chainStopped: false, undone: false,
    }], next: null }));
    return bridge;
  }

  it("tries a failed run again through main, for the notice on screen", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    renderWithNotices(bridge, { sentNotices: sentNotices([FAILED("first", "atc_first")]) });
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("sent-notice-automation-failed:first-retry"));
    expect(bridge.retryAutomationNotice).toHaveBeenCalledWith({
      account: null, notice: { store: "account", noticeId: "automation-failed:first" }, startOver: false,
    });
    expect(bridge.retryCollectionAutomation).not.toHaveBeenCalled();
  });

  it("opens a failed run's automation with its runs, and moves an open panel to the next one", async () => {
    const user = userEvent.setup();
    const bridge = withRuns(makeBridge(Promise.resolve(null)));
    renderWithNotices(bridge, { sentNotices: sentNotices([FAILED("first", "atc_first"), FAILED("second", "atc_second")]) });
    const open = async (id: string) => {
      await user.click(await screen.findByTestId("notice-center-toggle"));
      await user.click(await screen.findByTestId(`sent-notice-automation-failed:${id}-open`));
    };
    await open("first");
    expect(await screen.findByTestId("tab-dohc://collection/tasks")).toBeTruthy();
    expect(await screen.findByTestId("automation-run-atc_first", undefined, { timeout: 15_000 })).toBeTruthy();
    // The page cleared the first ask; the second still reaches the open panel.
    await open("second");
    expect(await screen.findByTestId("automation-run-atc_second")).toBeTruthy();
    expect(screen.queryByTestId("automation-run-atc_first")).toBeNull();
  });

  it("opens the file a notice named once the workspace it switched to is ready", async () => {
    renderWithNotices(makeBridge(Promise.resolve(null)), { openPathOnReady: "b.md" });
    await screen.findByTestId("tab-b.md");
  });

  describe("through a share this computer has not added", () => {
    const THROUGH_SHARE: NoticeRow = {
      ...MENTION,
      kind: "automation-notify",
      senderKind: "automation",
      workspaceId: null,
      recipientShareId: "share-1",
      title: "Weekday report is ready",
      target: { path: "Trips/Japan/report.md" },
    };
    const VIEW: Workspace = { ...WORKSPACE, workspaceId: "ws-owner-view", rootPath: "/home/sam/dohc/owner" };
    function shareBridge(access: "view" | "edit") {
      return Object.assign(makeBridge(Promise.resolve(null)), {
        mountShare: vi.fn(async () => ({
          workspace: WORKSPACE,
          mount: { shareId: "share-1", label: "owner", status: "updated" as const, changedPaths: 1 },
        })),
        openSharedView: vi.fn(async () => ({ workspace: VIEW })),
        getRelayReceivedShare: vi.fn(async () => ({
          found: true as const,
          share: {
            shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false, grantId: "g1",
            generation: 1, createdAtMs: 1, shareCode: "code-1", selector: { paths: ["Trips"], versionId: null }, access,
          },
        })),
        getDefaultShareRoot: vi.fn(async () => "/home/sam/dohc/owner"),
      });
    }

    it("adds it to shared-with-me and opens the notice's file there", async () => {
      const user = userEvent.setup();
      const bridge = shareBridge("view");
      renderWithNotices(bridge, { sentNotices: sentNotices([THROUGH_SHARE]) });

      await user.click(await screen.findByTestId("notice-center-toggle"));
      await user.click(await screen.findByTestId("sent-notice-mention:1-open"));
      await user.click(await screen.findByTestId("open-share-start"));
      expect(bridge.mountShare).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, shareCode: "code-1" });
      await screen.findByTestId("tab-shared-with-me/owner/Trips/Japan/report.md");
    });

    it("opens it as its own workspace and opens the notice's file there", async () => {
      const user = userEvent.setup();
      const bridge = shareBridge("edit");
      const onSwitchWorkspace = vi.fn();
      renderWithNotices(bridge, { sentNotices: sentNotices([THROUGH_SHARE]), onSwitchWorkspace });

      await user.click(await screen.findByTestId("notice-center-toggle"));
      await user.click(await screen.findByTestId("sent-notice-mention:1-open"));
      const start = await screen.findByTestId("open-share-start");
      await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
      await user.click(start);
      await waitFor(() => expect(onSwitchWorkspace).toHaveBeenCalledWith(VIEW, "Trips/Japan/report.md"));
    });
  });
});

describe("file transfers", () => {
  it("keeps file import and workspace zip export as separate commands", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    await waitFor(() => {
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
      });
    });

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Export workspace as zip"));
    await waitFor(() => {
      expect(bridge.exportWorkspaceZip).toHaveBeenCalledWith({
        workspaceId: "ws-shell-test",
      });
    });
  });

  it("reports an import as a toast and a Notices row, and a newer import replaces the row", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain("Imported 1 file.");
    expect(screen.getByTestId("notice-toasts").contains(toast)).toBe(true);

    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["one.md", "two.md"],
      skipped: 0,
    });
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-notice").textContent).toContain(
        "Imported 2 files.",
      ),
    );

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(notices.textContent).toContain("Imported 2 files.");
    expect(notices.textContent).not.toContain("Imported 1 file.");
  });

  // Every file was skipped for its name or kind, so the same files would be
  // skipped again: the notice names the count and offers no Try again.
  it("offers no Try again when an import brings nothing", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({ imported: [], skipped: 2 });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Nothing imported (2 skipped).");
    expect(within(toast).queryByTestId("workspace-shell-error-retry")).toBeNull();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(notices.textContent).toContain("Nothing imported (2 skipped).");
    expect(within(notices).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  function sharedViewBridge(refreshOk: boolean[]) {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({ files: [{ path: "notes/a.md", kind: "file" }], folders: ["notes"] });
    bridge.showExplorerMenu.mockResolvedValue("import-files");
    bridge.refreshSharedView = vi.fn(async () =>
      refreshOk.shift() === false
        ? {
            ok: false as const,
            changedPaths: 0,
            errorMessage: "The relay did not answer.",
          }
        : {
            ok: true as const,
            status: "unchanged" as const,
            changedPaths: 0,
            excludedPaths: [],
            unjournalablePaths: [],
            collisionRecordQuarantined: false,
            refusedOps: 0,
            refusedDetail: null,
          },
    );
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["notes/one.md", "notes/two.md"],
      skipped: 0,
      interrupted: true,
    });
    return bridge;
  }

  async function importIntoNotes(bridge: ReturnType<typeof makeBridge>) {
    const folder = (await screen.findAllByTestId("tree-row")).find((row) => row.dataset.path === "notes");
    if (!folder) throw new Error("notes folder row missing");
    fireEvent.contextMenu(folder);
    await waitFor(() =>
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({ workspaceId: "ws-shell-test", targetDir: "notes" }),
    );
  }

  const SHARED_VIEW = { shareId: "share-1", granterEmail: "granter@dohc.test", access: "edit" as const };

  // Picking the same files again would land second copies under collision
  // names, so the notice names what landed; Try again refreshes the shared
  // view, then asks for files for the same folder.
  it("names what an interrupted import landed, and Try again refreshes before it asks for files for the same folder", async () => {
    const bridge = sharedViewBridge([true, true]);
    renderShell(bridge, { ...WORKSPACE, shareView: SHARED_VIEW });
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();

    await importIntoNotes(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "Imported one.md and two.md before the import stopped. Import only the files that are still missing.",
    );
    await user.click(within(toast).getByTestId("workspace-shell-error-retry"));

    await waitFor(() => expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2);
    expect(bridge.refreshSharedView.mock.invocationCallOrder[1]).toBeLessThan(
      bridge.importWorkspaceFiles.mock.invocationCallOrder[1]!,
    );
    expect(bridge.importWorkspaceFiles).toHaveBeenLastCalledWith({ workspaceId: "ws-shell-test", targetDir: "notes" });
  });

  it("names what landed and why an ordinary import stopped, keeps the raw error for Copy, and Try again asks for files for the same folder", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({ files: [{ path: "notes/a.md", kind: "file" }], folders: ["notes"] });
    bridge.showExplorerMenu.mockResolvedValue("import-files");
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["notes/one.md"],
      skipped: 0,
      interrupted: true,
      stop: {
        file: "two.md",
        code: "EACCES",
        detail: "EACCES: permission denied, copyfile 'C:/source/two.md' -> 'C:/workspace/notes/two.md'",
      },
    });
    renderShell(bridge);
    const user = userEvent.setup();

    await importIntoNotes(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "Imported one.md before the import stopped. dohc isn't allowed to read two.md or write to this folder. Import only the files that are still missing.",
    );
    expect(toast.textContent).not.toContain("EACCES");
    await user.click(within(toast).getByTestId("workspace-shell-error-copy"));
    expect(await navigator.clipboard.readText()).toContain(
      "Cause: EACCES: permission denied, copyfile 'C:/source/two.md' -> 'C:/workspace/notes/two.md'",
    );
    await user.click(within(toast).getByTestId("workspace-shell-error-retry"));

    await waitFor(() => expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(bridge.importWorkspaceFiles).toHaveBeenLastCalledWith({ workspaceId: "ws-shell-test", targetDir: "notes" });
  });

  // A notice's message is cut at 500 characters. Long names must not cut off
  // the failure or the instruction; the report still lists every file.
  it("keeps the failure and the instruction whole with long file names, and lists every file in Copy details", async () => {
    const long = (stem: string) => `${stem}-${"n".repeat(196)}.md`;
    const imported = ["notes/" + long("one"), "notes/" + long("two"), "notes/" + long("three")];
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported,
      skipped: 0,
      interrupted: true,
      stop: { file: long("four"), code: "EACCES", detail: "EACCES: permission denied" },
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toMatch(/Imported one-n+…? and 2 more before the import stopped\./);
    expect(toast.textContent).toContain("or write to this folder. Import only the files that are still missing.");
    await user.click(within(toast).getByTestId("workspace-shell-error-copy"));
    const copied = await navigator.clipboard.readText();
    for (const path of imported) expect(copied).toContain(`Imported: ${path}`);
  });

  // A dangling link's refusal names the link too. With long names, the
  // instruction must still survive, and Copy keeps every path whole.
  it("keeps the instruction whole when a long-named dangling link stops an import into a deep folder", async () => {
    const long = (stem: string) => `${stem}-${"n".repeat(196)}.md`;
    const deep = `${"nested-folder/".repeat(40)}${long("one")}`;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [deep, `notes/${long("two")}`],
      skipped: 0,
      interrupted: true,
      stop: { file: long("link"), refusal: "dangling-link", detail: "The symbolic link points to a missing file." },
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("a symbolic link to a missing file. Restore that file, then import it instead.");
    expect(toast.textContent).toContain(" Import only the files that are still missing.");
    await user.click(within(toast).getByTestId("workspace-shell-error-copy"));
    expect(await navigator.clipboard.readText()).toContain(`Imported: ${deep}\n`);
  });

  it("keeps the skipped count when the first copy fails", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [],
      skipped: 2,
      stop: { file: "three.md", code: "ENOSPC", detail: "ENOSPC: no space left on device, copyfile 'three.md'" },
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "Could not import files (2 skipped). The disk is full.",
    );
  });

  // Try again removes the row before it runs. When the shared view cannot
  // refresh first, the person still learns why no file picker opened.
  it("says why no file picker opened when the shared view does not refresh before Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["notes/one.md"],
      skipped: 0,
      interrupted: true,
    });
    renderShell(bridge, {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "granter@dohc.test", damaged: true as const },
    });
    const user = userEvent.setup();

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    await user.click(within(toast).getByTestId("workspace-shell-error-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "dohc did not start the import. Refresh the shared view before you import",
      ),
    );
    expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(1);
  });

  it("words a failed first copy the same way, with the raw error only in Copy details", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [],
      skipped: 0,
      stop: { file: "one.md", code: "ENOSPC", detail: "ENOSPC: no space left on device, copyfile 'one.md'" },
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Could not import files. The disk is full.");
    expect(toast.textContent).not.toContain("ENOSPC");
    expect(within(toast).getByTestId("workspace-shell-error-retry")).toBeTruthy();
    await user.click(within(toast).getByTestId("workspace-shell-error-copy"));
    expect(await navigator.clipboard.readText()).toContain("Cause: ENOSPC: no space left on device");
  });

  // The refresh reports its own cause; the toast after it says why no file
  // picker opened and what to do next.
  it("asks for no files when the refresh before Try again fails", async () => {
    const bridge = sharedViewBridge([true, false]);
    renderShell(bridge, { ...WORKSPACE, shareView: SHARED_VIEW });
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();

    await importIntoNotes(bridge);
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByTestId("workspace-shell-error-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "dohc did not start the import. Refresh the shared view before you import",
      ),
    );
    expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2);
    expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect((await screen.findByTestId("notice-center")).textContent).toContain(
      "Couldn't refresh the shared view. The relay did not answer.",
    );
  });

  it("reports an interrupted shared import separately from ordinary skips", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["one.md", "two.md"],
      skipped: 0,
      interrupted: true,
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));

    await screen.findByText(/Imported one.md and two.md before the import stopped/);
    await waitFor(() =>
      expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("checks for desktop updates from the command palette", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Check for updates"));

    await waitFor(() => {
      expect(bridge.checkForUpdates).toHaveBeenCalledOnce();
    });
  });
});

describe("owner live documents", () => {
  const LIVE_ROW = {
    path: "notes/today.md",
    status: "ready" as const,
    canResume: false,
  };

  async function openLiveDocumentsFromSettings(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.click(await screen.findByTestId("activity-settings"));
    await screen.findByTestId("settings-dialog");
    await user.click(screen.getByTestId("settings-nav-cloud"));
    await user.click(
      await screen.findByRole("button", { name: "Open live documents" }),
    );
    // Settings hands the surface over rather than stacking on top of it.
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    return await screen.findByTestId("live-documents-dialog");
  }

  it("opens live documents from settings and drives the real bridge", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(
      async (): Promise<OwnerLiveDocumentsResult> => ({
        documents: [LIVE_ROW],
        nextCursor: null,
      }),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    const dialog = await openLiveDocumentsFromSettings(user);
    await waitFor(() =>
      expect(bridge.listOwnerLiveDocuments).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
      }),
    );
    await screen.findByTestId(`live-document-row-${LIVE_ROW.path}`);

    await user.click(
      within(dialog).getByRole("button", {
        name: `Stop live editing for ${LIVE_ROW.path}`,
      }),
    );
    await waitFor(() =>
      expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        path: LIVE_ROW.path,
      }),
    );
  });

  // The dialog's failure outlives the dialog: the shell keeps the notice and
  // its Try again, and reopens the list when there is nothing left to retry
  // into.
  it("keeps a refused read in the shell notice and reopens the dialog to retry", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async (): Promise<OwnerLiveDocumentsResult> => {
      throw new Error("The engine did not answer.");
    });
    const user = userEvent.setup();
    renderShell(bridge);

    const dialog = await openLiveDocumentsFromSettings(user);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "dohc could not load the live documents for this workspace.",
    );

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();

    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(await screen.findByTestId("live-documents-dialog")).toBeTruthy();
  });

  // DesktopRoot remounts the shell on a switch, so this rerenders the same
  // instance: the stricter case, where the shell's own guard is what keeps
  // workspace A's list from repainting or reading workspace B.
  it("closes the live documents dialog when the window changes workspaces", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(
      async (): Promise<OwnerLiveDocumentsResult> => ({
        documents: [LIVE_ROW],
        nextCursor: null,
      }),
    );
    const user = userEvent.setup();
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    const view = render(shell(WORKSPACE));

    await openLiveDocumentsFromSettings(user);
    bridge.listOwnerLiveDocuments.mockClear();

    view.rerender(shell(OTHER_WORKSPACE));

    await waitFor(() =>
      expect(screen.queryByTestId("live-documents-dialog")).toBeNull(),
    );
    expect(bridge.listOwnerLiveDocuments).not.toHaveBeenCalled();
  });

  // The notice's Try again is main's own retry command, not a repaint.
  it("runs the live delivery retry command from the notice", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const retryingStatus: SyncStatusResult = {
      ...SYNC_STATUS,
      ownerLiveDelivery: "retrying",
    };
    bridge.openWorkspace = vi.fn(async () => retryingStatus);
    bridge.getSyncStatus = vi.fn(async () => retryingStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(
      await screen.findByTestId("owner-live-delivery-toast-action"),
    );
    await waitFor(() =>
      expect(bridge.retryOwnerLiveDelivery).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
      }),
    );
  });

  // edges-05, share-09: a relay outage read "Saving…" for its whole length,
  // and the row that came three failures later named no cause and offered
  // nothing to do. Codex on #1233: the first failed pass toasts, and later
  // passes of the same failure only update the row.
  it("toasts a failed sync at once, only once per failure, and clears it on recovery", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const failing = (attempts: number): SyncStatusResult => ({
      ...SYNC_STATUS,
      state: "sync-failed",
      pendingChangeCount: 1,
      syncFailure: {
        cause: "server-unreachable",
        detail: `RelayUnreachableError: attempt ${attempts}`,
        sinceMs: 1000,
        attempts,
      },
    });
    let status = failing(1);
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    // The first Try again meets the same outage; the second gets through.
    bridge.retryCloudSync = vi
      .fn(async (_payload: { workspaceId: string; reason: "person" | "reconnect" }): Promise<SyncStatusResult> => failing(3))
      .mockImplementationOnce(async () => {
        status = failing(3);
        return status;
      })
      .mockImplementationOnce(async () => {
        status = SYNC_STATUS;
        return SYNC_STATUS;
      });
    const user = userEvent.setup();
    renderShell(bridge);

    // One failed pass: the title bar, a toast with Try again and copy, and a
    // Notices row.
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").textContent).toBe("Server unreachable"),
    );
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "dohc could not reach the server.",
    );
    expect(screen.getByTestId("workspace-shell-error-copy")).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("notice-center").textContent).toContain(
        "dohc could not reach the server.",
      ),
    );
    await user.click(screen.getByTestId("notice-center-toggle"));

    // The automatic retry fails too: the same failure, so no second toast.
    await user.click(await screen.findByRole("button", { name: "Dismiss workspace error" }));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    const readsBefore = vi.mocked(bridge.getSyncStatus).mock.calls.length;
    status = failing(2);
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() =>
      expect(vi.mocked(bridge.getSyncStatus).mock.calls.length).toBeGreaterThan(readsBefore),
    );
    await act(async () => undefined);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).toContain(
      "dohc could not reach the server.",
    );

    // Try again from the row, then close Notices so the toast can show.
    await user.click(
      within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }),
    );
    if (screen.queryByTestId("notice-center")) {
      await user.click(screen.getByTestId("notice-center-toggle"));
    }

    await waitFor(() => expect(bridge.retryCloudSync).toHaveBeenCalledTimes(1));
    // Still failing: the person asked, so the answer interrupts again.
    expect(
      (await screen.findByTestId("workspace-shell-error")).textContent,
    ).toContain("dohc could not reach the server.");

    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.retryCloudSync).toHaveBeenCalledTimes(2));
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").dataset.state).toBe("synced"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain(
      "could not reach the server",
    );
  });

  // The shell remounts on every workspace switch, with its status unknown
  // until the workspace answers. Coming back to the same outage must not
  // bring back a toast, or a row the person dismissed.
  it("keeps a sync failure quiet across a remount once shown and dismissed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const failing: SyncStatusResult = {
      ...SYNC_STATUS,
      state: "sync-failed",
      pendingChangeCount: 1,
      syncFailure: {
        cause: "server-unreachable",
        detail: "RelayUnreachableError: down",
        sinceMs: 1000,
        attempts: 2,
      },
    };
    // The status answers only when released, so the remount starts loading.
    let answer: ((status: SyncStatusResult) => void) | null = null;
    bridge.openWorkspace = vi.fn(async () => failing);
    bridge.getSyncStatus = vi.fn(async () => failing);
    const user = userEvent.setup();
    const first = renderShell(bridge);
    await screen.findByTestId("workspace-shell-error");
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = await screen.findByText("dohc could not reach the server.");
    const dismiss = row.closest("li")?.querySelector("[aria-label=\"Dismiss notice\"]");
    if (!(dismiss instanceof HTMLElement)) throw new Error("no dismiss control on the row");
    await user.click(dismiss);
    first.unmount();

    bridge.openWorkspace = vi.fn(
      () => new Promise<SyncStatusResult>((resolve) => { answer = resolve; }),
    );
    bridge.getSyncStatus = vi.fn(
      () => new Promise<SyncStatusResult>((resolve) => { answer = resolve; }),
    );
    renderShell(bridge);
    await waitFor(() => expect(answer).not.toBeNull());
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    act(() => answer?.(failing));
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").textContent).toBe("Server unreachable"),
    );
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).not.toContain(
      "could not reach the server",
    );
  });

  it("opens live documents from a stable live delivery notice", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const pausedStatus: SyncStatusResult = {
      ...SYNC_STATUS,
      ownerLiveDelivery: "retrying",
      ownerLiveDeliveryReason: "workspace-changed",
    };
    bridge.openWorkspace = vi.fn(async () => pausedStatus);
    bridge.getSyncStatus = vi.fn(async () => pausedStatus);
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(
      within(await screen.findByTestId("notice-owner-live-delivery")).getByRole(
        "button",
        { name: "Live documents" },
      ),
    );

    expect(await screen.findByTestId("live-documents-dialog")).toBeTruthy();
    expect(bridge.retryOwnerLiveDelivery).not.toHaveBeenCalled();
  });

  async function openCloudSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByTestId("activity-settings"));
    await screen.findByTestId("settings-dialog");
    await user.click(screen.getByTestId("settings-nav-cloud"));
    return await screen.findByTestId("settings-section-cloud");
  }

  it("reports an unavailable server status and restores live documents after retry", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn()
      .mockRejectedValueOnce(new Error("private IPC detail"))
      .mockResolvedValue({ connected: true, workspaceSynced: true });
    const user = userEvent.setup();
    renderShell(bridge);

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not check this workspace's server connection.");
    expect(toast.textContent).not.toContain("private IPC detail");
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(2));
    await openCloudSettings(user);
    expect(await screen.findByTestId("settings-row-live-documents")).toBeTruthy();
  });

  // The list is a call to this workspace's own server, which main refuses for
  // a workspace that has none. Local-only work gets no action that can only
  // fail — the section still offers the way to turn sync on.
  it("offers no live document list for a local-only workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: false,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await openCloudSettings(user);
    await waitFor(() =>
      expect(bridge.cloudStatus).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
      }),
    );
    expect(screen.queryByTestId("settings-row-live-documents")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open sync and sharing" }),
    ).toBeTruthy();
  });

  // Closing the connection dialog re-reads the status this gate is derived
  // from, so the list arrives without a restart or a workspace switch.
  it("offers the live document list once this workspace syncs", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let workspaceSynced = false;
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await openCloudSettings(user);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-row-live-documents")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open sync and sharing" }));
    await screen.findByTestId("cloud-sync-panel");
    workspaceSynced = true;
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());

    await openCloudSettings(user);
    expect(await screen.findByTestId("settings-row-live-documents")).toBeTruthy();
  });

  // Ending a share is reversible for 10 minutes, so the notice carries Undo.
  // The shell holds it: it works after Settings closes, from the toast and
  // from the Notices row the toast leaves behind.
  it("offers Undo for an ended share on the toast and in Notices after Settings closes", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listRelayShares = vi.fn().mockResolvedValue({
      granted: [
        {
          shareId: "share-1",
          workspaceId: WORKSPACE.workspaceId,
          recipientUserId: "friend",
          recipientEmail: "friend@dohc.test",
          selector: { paths: ["docs"], versionId: null },
          access: "view",
          grantId: "grant-1",
          generation: 1,
          createdAtMs: 1000,
          revokedAtMs: null,
          shareCode: "dohc-share:share-1:http://relay.test",
        },
      ],
      received: [],
      removed: [],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await openCloudSettings(user);
    await user.click(await screen.findByTestId("shared-by-me-revoke-start"));
    await user.click(screen.getByTestId("shared-by-me-revoke"));
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(toast.textContent).toContain(
      "Ended the share of docs with friend@dohc.test. You can undo this for 10 minutes.",
    );
    expect(within(toast).getByRole("button", { name: "Undo" })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());

    // Closing the toast keeps the row, and the row keeps the Undo.
    await user.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(notices.textContent).toContain("Ended the share of docs with friend@dohc.test.");
    await user.click(within(notices).getByRole("button", { name: "Undo" }));

    await waitFor(() =>
      expect(bridge.undoRelayShare).toHaveBeenCalledWith({ shareId: "share-1", undoId: "undo-1" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-notice").textContent).toContain(
        "Restored the share of docs with friend@dohc.test.",
      ),
    );
    // The Undo row ran once and is gone.
    expect(screen.queryByText(/You can undo this for 10 minutes/)).toBeNull();
  });
});

describe("connection dialog retries", () => {
  // The panel that failed is gone, and the user opened a fresh one by hand
  // before choosing Try again. The notice's address must still reach it.
  it("re-scopes a reopened connection dialog to the address that failed", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      // The device flow is the panel's own call; the shell's bridge carries it
      // only for this test, and this server refuses to start one.
      cloudLoginStart: vi.fn(async (_payload: { serverUrl: string }) => {
        throw new Error("dohc could not reach this server.");
      }),
    });
    bridge.cloudStatus = vi.fn(async () => ({
      connected: false,
      email: "",
      serverUrl: "",
      workspaceSynced: false,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("activity-cloud"));
    await user.type(
      await screen.findByTestId("cloud-server-url"),
      "https://dohc.example.test",
    );
    await user.click(screen.getByTestId("cloud-connect-start"));
    await screen.findByTestId("workspace-shell-error");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
    await user.click(screen.getByTestId("activity-cloud"));
    expect(
      ((await screen.findByTestId("cloud-server-url")) as HTMLInputElement).value,
    ).toBe("");

    await user.click(screen.getByTestId("workspace-shell-error-retry"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("cloud-server-url") as HTMLInputElement).value,
      ).toBe("https://dohc.example.test"),
    );
  });
});

describe("unavailable MCP launcher settings", () => {
  it("shows the launcher error without a copyable config", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getMcpConfig = vi.fn(
      async (): Promise<McpConfigResult> => ({
        unavailable: true,
        message: "dohc could not prepare its MCP launcher. Restart dohc to try again.",
      }),
    );
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Agents & MCP",
      ),
    );

    expect((await screen.findByTestId("mcp-unavailable")).textContent).toBe(
      "dohc could not prepare its MCP launcher. Restart dohc to try again.",
    );
    expect(screen.queryByTestId("mcp-config-snippet")).toBeNull();
    const configSection = screen.getByRole("heading", { name: "MCP config" }).closest("section");
    if (!configSection) throw new Error("The MCP config section did not render.");
    expect(
      (within(configSection).getByRole("button", { name: "Copy" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
