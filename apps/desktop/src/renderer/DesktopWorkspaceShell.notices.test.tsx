// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { ENGINE_STORE_BACKUP_DIR } from "../ipc/bridgeContract";
import type { DohcDesktopBridge, SaveOwnerLiveRecoveryCopyResult, RebuildEngineStoreResult, SyncStatusResult, EngineYDocSaveStateEvent } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { DesktopWorkspaceShell, WORKSPACE, OTHER_WORKSPACE, SYNC_STATUS, storedStateWithTabs, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

it("says History paused with Try again, restarts capture from the row, and keeps the row cleared once capture runs", async () => {
  const bridge = makeBridge(Promise.resolve(null));
  let status: SyncStatusResult = { ...SYNC_STATUS, historyCaptureFailed: true, engineStoreRefused: null };
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  const restart = deferred<void>();
  bridge.retryHistoryCapture.mockReturnValueOnce(restart.promise);
  renderShell(bridge);
  const user = userEvent.setup();

  const toast = await screen.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain("History paused");
  expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(within(toast).getByRole("button", { name: "Details" })).toBeTruthy();

  await user.click(await screen.findByTestId("notice-center-toggle"));
  const notices = await screen.findByTestId("notice-center");
  const row = await within(notices).findByTestId("notice-history-capture-failed");
  expect(within(row).getByRole("button", { name: "Open History" })).toBeTruthy();
  await user.click(within(row).getByRole("button", { name: "Try again" }));
  expect(bridge.retryHistoryCapture).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.workspaceId });
  // The row waits for the restart's answer.
  expect(within(notices).getByTestId("notice-history-capture-failed")).toBeTruthy();

  status = SYNC_STATUS;
  act(() => bridge.emitWorkspaceActivity());
  await waitFor(() => expect(screen.queryByTestId("notice-history-capture-failed")).toBeNull());
  // A restart that answers late with a failure must not bring the row back.
  await act(async () => {
    restart.reject(new Error("History is still paused."));
    await restart.promise.catch(() => undefined);
  });
  expect(screen.queryByTestId("notice-history-capture-failed")).toBeNull();
});

describe("edits the server refused", () => {
  const quarantine = {objectId: "object-1", path: "notes/plan.md", reason: "invalid-update", storedOn: "this-computer" as const,
    incident: "outbox:delivery:0", recovery: "paused" as const};
  const quarantined = (...rows: NonNullable<SyncStatusResult["ownerLiveQuarantines"]>): SyncStatusResult =>
    ({...SYNC_STATUS, ownerLiveQuarantines: rows});
  const TITLE = "Live editing paused for notes/plan.md";
  it("runs Try again from the keyboard for the incident shown, and shows a repeated refusal again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status = quarantined(quarantine);
    bridge.getSyncStatus = vi.fn(async () => status);
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    const user = userEvent.setup();
    within(toast).getByRole("button", {name: "Try again"}).focus();
    await user.keyboard("{Enter}");
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, objectId: "object-1", incident: "outbox:delivery:0"});
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    // Delivery has the owner's attempt: no notice while it waits.
    status = quarantined({...quarantine, incident: "outbox:delivery:1", recovery: "retrying"});
    const reads = bridge.getSyncStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByText(TITLE)).toBeNull();
    // The server refused it again: a new incident, so a new toast.
    status = quarantined({...quarantine, incident: "outbox:delivery:1"});
    act(() => bridge.emitWorkspaceActivity());
    const again = await screen.findByTestId("workspace-shell-error");
    expect(within(again).getByText(TITLE)).toBeTruthy();
    await user.click(within(again).getByRole("button", {name: "Try again"}));
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenLastCalledWith({workspaceId: WORKSPACE.workspaceId, objectId: "object-1", incident: "outbox:delivery:1"});
    // Accepted: the queue drained, and nothing is left to show.
    status = SYNC_STATUS;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).queryByText(TITLE)).toBeNull();
  });

  it("saves a recovery copy from the notice, opens it, and keeps the notice", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined({...quarantine, recovery: "stopped-kept"}));
    const saving = deferred<SaveOwnerLiveRecoveryCopyResult>();
    bridge.saveOwnerLiveRecoveryCopy = vi.fn(() => saving.promise);
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Save recovery copy"}));
    // The row names the kept edits it shows, so Save writes those.
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, path: "notes/plan.md", incident: quarantine.incident});
    await act(async () => { saving.resolve({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer", keptEdits: "kept"}); await saving.promise; });
    expect(await screen.findByText("Saved a recovery copy of notes/plan.md in notes. Your kept edits stay on this computer.")).toBeTruthy();
    expect(screen.getByRole("button", {name: "Open"})).toBeTruthy();
    // The edits stay queued, so the notice that holds them stays too.
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).getByText("Live editing stopped for notes/plan.md")).toBeTruthy();
    expect(bridge.stopOwnerLiveDocument).not.toHaveBeenCalled();
  });

  it("never paints workspace A's late Try again failure into workspace B", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let shown = WORKSPACE.workspaceId;
    bridge.getSyncStatus = vi.fn(async () => shown === WORKSPACE.workspaceId ? quarantined(quarantine) : SYNC_STATUS);
    const answer = deferred<void>();
    bridge.retryOwnerLiveQuarantine = vi.fn(() => answer.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
    );
    const view = render(shell(WORKSPACE));
    await userEvent.setup().click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Try again"}));
    const reads = bridge.getSyncStatus.mock.calls.length;
    shown = OTHER_WORKSPACE.workspaceId;
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => { answer.reject(new Error("late refusal")); await answer.promise.catch(() => undefined); });
    expect(screen.queryByText(/could not try again/)).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

});

it("reports an edit refusal once through Notices, without an ineffective retry", async () => {
  const bridge = makeBridge(Promise.resolve(null));
  const listeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
  bridge.onEngineYDocSaveState = vi.fn(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  renderShell(bridge);
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  const message = 'dohc could not save an edit to "a.md". The edit is too large. Copy it from recovery.';
  const event: EngineYDocSaveStateEvent = {
    sessionId: "session-1", workspaceId: WORKSPACE.workspaceId, path: "a.md", seq: 1, state: { kind: "error", reason: "test failure", issueId: null },
    editRefusal: { workspaceId: WORKSPACE.workspaceId, path: "a.md", requestId: "request-1", message },
  };
  act(() => { for (const listener of listeners) listener(event); });
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("notice-center-toggle"));
  const notices = await screen.findByTestId("notice-center");
  expect(within(notices).getAllByText(message)).toHaveLength(1);
  expect(within(notices).queryByRole("button", { name: "Try again" })).toBeNull();
  expect(within(notices).getByRole("button", { name: "Details" })).toBeTruthy();
  act(() => {
    for (const listener of listeners) listener({ ...event,
      editRefusal: { ...event.editRefusal!, workspaceId: OTHER_WORKSPACE.workspaceId,
        message: "Another workspace refused an edit." } });
  });
  expect(screen.queryByText("Another workspace refused an edit.")).toBeNull();
});

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
    // The workbench stays inert until the saved layout has loaded.
    await waitFor(() => expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(false));
  });

describe("crash report notice", () => {
  const REPORT = {
    revision: 3,
    through: 3,
    read: false,
    source: "engine" as const,
    problems: 1,
    atMs: 5_000,
    text: "dohc crash report\n\nTime: 1970-01-01T00:00:05.000Z\nProcess: workspace engine",
  };

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
});

describe("Undo on an Explorer notice", () => {
  const DELETED = "dohc-operation:22222222-2222-4222-8222-222222222222";
  type UndoAnswer = Awaited<ReturnType<DohcDesktopBridge["undoHistoryOperation"]>>;

  function undoBridge() {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn(async () => ({ trashed: true, operationId: DELETED, undo: { available: true as const } })),
      undoHistoryOperation: vi.fn(async (): Promise<UndoAnswer> => ({
        ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [],
      })),
    });
    bridge.readExplorerMenu.mockResolvedValue([{ kind: "item", label: "Delete", id: "delete" }]);
    return bridge;
  }

  async function deleteFromMenu(path: string) {
    fireEvent.contextMenu((await screen.findAllByTestId("tree-row")).find((row) => row.dataset.path === path)!);
    fireEvent.click(await screen.findByTestId("explorer-menu-item-delete"));
  }

  async function undoFromNotices(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Undo" }));
  }

  it("undoes a delete after the side panel hid the Explorer", async () => {
    const bridge = undoBridge();
    const user = userEvent.setup();
    renderShell(bridge);
    await deleteFromMenu("a.md");
    await screen.findAllByText("Deleted a.md. It's in the system trash.");
    await user.click(screen.getByTestId("titlebar-primary-sidebar"));
    expect(screen.queryByTestId("file-tree")).toBeNull();

    await undoFromNotices(user);
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, operationId: DELETED }));
    expect(await screen.findAllByText("Restored a.md")).not.toHaveLength(0);
  });
});

describe("a refused rename of a page this computer owns live", () => {
  const TITLE = `dohc can't rename "a.md" while it has live editing on`;
  const BODY = "In Live documents, stop live editing for this page, then rename it again.";
  const refusal = new Error(`Error invoking remote method 'desktop:move-workspace-path': LivePageOwnedError: dohc can't move "a.md" while it has live editing on
In Live documents, stop live editing for this page, then move it again.`);
  const treePaths = async () => (await screen.findAllByTestId("tree-row")).map(row => row.dataset.path);

  it("puts the old name back at once, says rename, and offers Try again and Live documents", async () => {
    const refused = deferred<never>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn().mockReturnValueOnce(refused.promise)
        .mockResolvedValueOnce({ path: "renamed.md", undo: { available: false, reason: "", paths: [] } }),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "a.md", kind: "file" as const }], folders: [] });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: "a.md", objectId: "object-a", status: "ready" as const, canResume: false }] }));
    renderShell(bridge);
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === "a.md")!;
    await user.click(row);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "renamed{Enter}");
    await waitFor(async () => expect(await treePaths()).toContain("renamed.md"));
    // No refresh answers from here, so only the refusal itself can put the old name back.
    bridge.listWorkspaceFiles.mockImplementation(() => new Promise(() => undefined));
    refused.reject(refusal);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(await treePaths()).toContain("a.md");
    expect(await treePaths()).not.toContain("renamed.md");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByText(BODY)).toBeTruthy();
    expect(within(toast).queryByRole("button", { name: /Stop/u })).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(notice).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("live-document-row-a.md").getAttribute("aria-current")).toBe("true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    // Live editing stopped: Try again renames to the name the person typed.
    // The pointer read the row on its way to Open Live documents, so its toast
    // stays closed and Try again waits in Notices.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const again = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
    expect(bridge.moveWorkspacePath).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE.workspaceId, fromPath: "a.md", toPath: "renamed.md" });
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
  });

});

it("signs in again from Notices, and sync resumes with no enable or pause", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let status: SyncStatusResult = { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true };
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(),
      cloudStopSync: vi.fn(),
      cloudLogout: vi.fn(),
      cloudLoginStart: vi.fn(async () => ({ userCode: "ABCD", verificationUri: "https://cloud.dohc.test/device" })),
      cloudLoginPoll: vi.fn(async () => {
        status = { ...SYNC_STATUS };
        return { status: "complete" as const, email: "me@dohc.test" };
      }),
    });
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true, workspaceSyncConnected: true,
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderShell(bridge);

    const title = await screen.findByTestId("sync-status");
    expect(title.textContent).toBe("Sign in again to sync");
    expect(title.getAttribute("title")).toBe("Not syncing. Your sign-in expired.");
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("notice-sign-in-expired");
    expect(row.textContent).toContain("Your sign-in expired");
    await user.click(within(row).getByRole("button", { name: "Sign in again" }));
    await screen.findByTestId("cloud-user-code");
    expect(bridge.cloudLoginStart).toHaveBeenCalledWith({ serverUrl: "https://cloud.dohc.test" });
    expect(screen.queryByTestId("cloud-connected")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // Main announces the rebuilt engine's status.
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
    act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
    await waitFor(() => expect(screen.getByTestId("sync-status").getAttribute("data-state")).toBe("synced"));
    expect(screen.queryByTestId("notice-sign-in-expired")).toBeNull();
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    expect(bridge.cloudEnableSync).not.toHaveBeenCalled();
    expect(bridge.cloudStopSync).not.toHaveBeenCalled();
    expect(bridge.cloudLogout).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
