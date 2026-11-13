// @vitest-environment jsdom
import {
  dmSyncResult,
  DesktopWorkspaceShell,
  WORKSPACE,
  OTHER_WORKSPACE,
  SYNC_STATUS,
  storedStateWithTabs,
  makeBridge,
  renderShell,
  shellBootstrapProps,
} from "./DesktopWorkspaceShell.testHarness";
import { type Deferred, deferred } from "../testing/deferred";
import { editorTabTestId } from "../testPins";
import type {
  OwnerLiveDocumentsResult,
  ShareHandoffStatus,
  SyncDmsResult,
  JoinedChannelAnswer,
  WorkspaceUiState,
  DohcDesktopBridge,
  StopOwnerLiveDocumentResult,
  SaveOwnerLiveRecoveryCopyResult,
  RebuildEngineStoreResult,
  SyncStatusResult,
  EngineYDocSaveStateEvent,
  NoticeRow,
  ResolveAutomationControlsResult,
} from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { useState } from "react";

import type { SentNotices } from "./shell/useSentNotices";
import type { NoticeTarget } from "../notices/noticeTarget";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { liveStopError } from "../ipc/liveEditingStop";
import * as shellError from "./shell/useShellError";
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { ENGINE_STORE_BACKUP_DIR } from "../ipc/bridgeContract";

import type { Workspace } from "./DesktopWorkspaceShell";

it("says History paused with Try again, restarts capture from the row, and keeps the row cleared once capture runs", async () => {
  const bridge = makeBridge(Promise.resolve(null));
  let status: SyncStatusResult = {
    ...SYNC_STATUS,
    historyCaptureFailed: true,
    engineStoreRefused: null,
  };
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
  expect(bridge.retryHistoryCapture).toHaveBeenCalledExactlyOnceWith({
    workspaceId: WORKSPACE.workspaceId,
  });
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
  const quarantine = {
    objectId: "object-1",
    path: "notes/plan.md",
    reason: "invalid-update",
    storedOn: "this-computer" as const,
    incident: "outbox:delivery:0",
    recovery: "paused" as const,
  };
  const quarantined = (
    ...rows: NonNullable<SyncStatusResult["ownerLiveQuarantines"]>
  ): SyncStatusResult => ({ ...SYNC_STATUS, ownerLiveQuarantines: rows });
  const TITLE = "Live editing paused for notes/plan.md";
  it("runs Try again from the keyboard for the incident shown, and shows a repeated refusal again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status = quarantined(quarantine);
    bridge.getSyncStatus = vi.fn(async () => status);
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    const user = userEvent.setup();
    within(toast).getByRole("button", { name: "Try again" }).focus();
    await user.keyboard("{Enter}");
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE.workspaceId,
      objectId: "object-1",
      incident: "outbox:delivery:0",
    });
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    // Delivery has the owner's attempt: no notice while it waits.
    status = quarantined({ ...quarantine, incident: "outbox:delivery:1", recovery: "retrying" });
    const reads = bridge.getSyncStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByText(TITLE)).toBeNull();
    // The server refused it again: a new incident, so a new toast.
    status = quarantined({ ...quarantine, incident: "outbox:delivery:1" });
    act(() => bridge.emitWorkspaceActivity());
    const again = await screen.findByTestId("workspace-shell-error");
    expect(within(again).getByText(TITLE)).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      objectId: "object-1",
      incident: "outbox:delivery:1",
    });
    // Accepted: the queue drained, and nothing is left to show.
    status = SYNC_STATUS;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).queryByText(TITLE)).toBeNull();
  });

  it("saves a recovery copy from the notice, opens it, and keeps the notice", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () =>
      quarantined({ ...quarantine, recovery: "stopped-kept" }),
    );
    const saving = deferred<SaveOwnerLiveRecoveryCopyResult>();
    bridge.saveOwnerLiveRecoveryCopy = vi.fn(() => saving.promise);
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {
        name: "Save recovery copy",
      }),
    );
    // The row names the kept edits it shows, so Save writes those.
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE.workspaceId,
      path: "notes/plan.md",
      incident: quarantine.incident,
    });
    await act(async () => {
      saving.resolve({
        copyPath: "notes/plan (recovered).md",
        packagePath: "notes/plan (recovered).dohc-recovery.json",
        storedOn: "this-computer",
        keptEdits: "kept",
      });
      await saving.promise;
    });
    expect(
      await screen.findByText(
        "Saved a recovery copy of notes/plan.md in notes. Your kept edits stay on this computer.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    // The edits stay queued, so the notice that holds them stays too.
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(
      within(await screen.findByTestId("notice-center")).getByText(
        "Live editing stopped for notes/plan.md",
      ),
    ).toBeTruthy();
    expect(bridge.stopOwnerLiveDocument).not.toHaveBeenCalled();
  });

  it("never paints workspace A's late Try again failure into workspace B", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let shown = WORKSPACE.workspaceId;
    bridge.getSyncStatus = vi.fn(async () =>
      shown === WORKSPACE.workspaceId ? quarantined(quarantine) : SYNC_STATUS,
    );
    const answer = deferred<void>();
    bridge.retryOwnerLiveQuarantine = vi.fn(() => answer.promise);
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
    await userEvent.setup().click(
      within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {
        name: "Try again",
      }),
    );
    const reads = bridge.getSyncStatus.mock.calls.length;
    shown = OTHER_WORKSPACE.workspaceId;
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => {
      answer.reject(new Error("late refusal"));
      await answer.promise.catch(() => undefined);
    });
    expect(screen.queryByText(/could not try again/)).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});

it("reports an edit refusal once through Notices, without an ineffective retry", async () => {
  const bridge = makeBridge(Promise.resolve(null));
  const listeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
  bridge.onEngineYDocSaveState = vi.fn((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  renderShell(bridge);
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  const message =
    'dohc could not save an edit to "a.md". The edit is too large. Copy it from recovery.';
  const event: EngineYDocSaveStateEvent = {
    sessionId: "session-1",
    workspaceId: WORKSPACE.workspaceId,
    path: "a.md",
    seq: 1,
    state: { kind: "error", reason: "test failure", issueId: null },
    editRefusal: {
      workspaceId: WORKSPACE.workspaceId,
      path: "a.md",
      requestId: "request-1",
      message,
    },
  };
  act(() => {
    for (const listener of listeners) listener(event);
  });
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("notice-center-toggle"));
  const notices = await screen.findByTestId("notice-center");
  expect(within(notices).getAllByText(message)).toHaveLength(1);
  expect(within(notices).queryByRole("button", { name: "Try again" })).toBeNull();
  expect(within(notices).getByRole("button", { name: "Details" })).toBeTruthy();
  act(() => {
    for (const listener of listeners)
      listener({
        ...event,
        editRefusal: {
          ...event.editRefusal!,
          workspaceId: OTHER_WORKSPACE.workspaceId,
          message: "Another workspace refused an edit.",
        },
      });
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
      within(await screen.findByTestId("notice-engine-store-refused")).getByRole("button", {
        name: "Rebuild",
      }),
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

    await user.click(within(dialog).getByRole("button", { name: "Move and rebuild" }));
    expect(bridge.rebuildEngineStore).toHaveBeenCalledWith({
      workspaceId: WORKSPACE.workspaceId,
    });
    // The reverse path, named in the success copy (product invariant: every
    // reversible state change shows its reverse).
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Data store moved" })).toBe(dialog);
      expect(screen.getByTestId("engine-rebuild-dialog").textContent).toContain(
        `The old data store is at ${ENGINE_STORE_BACKUP_DIR}`,
      );
    });
  });

  it("reopens a mounted live document after a successful rebuild and sends the next edit to the fresh session", async () => {
    const rebuild = deferred<RebuildEngineStoreResult>();
    let liveSessionsGeneration = 0;
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["a.md"], "a.md")));
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
    const openEngineYDocSession = vi.fn(async (payload: { sessionId: string }) => {
      sessionIds.push(payload.sessionId);
      const doc = markdownToYDoc("# Doc\n");
      return {
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        lineageGeneration: 1,
      };
    });
    const applyEngineYDocUpdate = vi.fn(async (_payload: { sessionId: string }) => ({
      accepted: true as const,
    }));
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
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(1));

    await user.click(within(dialog).getByRole("button", { name: "Move and rebuild" }));
    await waitFor(() => expect(bridge.rebuildEngineStore).toHaveBeenCalledOnce());
    expect(openEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(closeEngineYDocSession).not.toHaveBeenCalled();

    await act(async () => {
      liveSessionsGeneration += 1;
      bridge.emitWorkspaceActivity();
      rebuild.resolve({ outcome: "moved" });
      await rebuild.promise;
    });

    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(2));
    expect(closeEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(closeEngineYDocSession.mock.invocationCallOrder[0]).toBeLessThan(
      openEngineYDocSession.mock.invocationCallOrder[1]!,
    );

    applyEngineYDocUpdate.mockClear();
    await user.type(screen.getByTestId("page-title"), " after rebuild");
    await waitFor(() => expect(applyEngineYDocUpdate).toHaveBeenCalled());
    expect(applyEngineYDocUpdate.mock.calls.at(-1)?.[0].sessionId).toBe(sessionIds[1]);
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
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["a.md"], "a.md")));
    bridge.openWorkspace = vi.fn(async () => currentStatus);
    bridge.getSyncStatus = vi.fn(async () => currentStatus);
    const openEngineYDocSession = vi.fn(async (_payload: { workspaceId: string }) => {
      const doc = markdownToYDoc("# Doc\n");
      return {
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        lineageGeneration: 1,
      };
    });
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
      within(await screen.findByTestId("notice-engine-store-refused")).getByRole("button", {
        name: "Rebuild",
      }),
    );
    await user.click(
      within(screen.getByTestId("engine-rebuild-dialog")).getByRole("button", {
        name: "Move and rebuild",
      }),
    );
    expect(screen.getByTestId("engine-rebuild-dialog").textContent).toContain("Moving");

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
    expect(screen.queryByTestId("workspace-shell-error")?.textContent ?? "").not.toContain(
      "Workspace A rebuild failed",
    );
  });
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
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  expect(screen.queryByTestId("workspace-open-failed")).toBeNull();
  // The workbench stays inert until the saved layout has loaded.
  await waitFor(() =>
    expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(false),
  );
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
    expect((await screen.findByTestId("workspace-shell-notice")).textContent).toContain(
      "Report sent",
    );
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
    extra: {
      sentNotices?: SentNotices;
      openOnReady?: NoticeTarget;
      onSwitchWorkspace?: (workspace: Workspace, open?: NoticeTarget) => void;
      workspace?: Workspace;
    },
    workspaces: Workspace[] = [extra.workspace ?? WORKSPACE],
  ) {
    vi.stubGlobal("dohcDesktop", bridge);
    return render(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell
          workspace={extra.workspace ?? WORKSPACE}
          workspaces={workspaces}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={extra.onSwitchWorkspace ?? (() => {})}
          {...(extra.sentNotices ? { sentNotices: extra.sentNotices } : {})}
          {...(extra.openOnReady ? { openOnReady: extra.openOnReady } : {})}
        />
      </>,
    );
  }

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
      collections: [
        { path: "tasks", objectId: "object-test", status: "valid" as const, reasons: [] },
      ],
      unclaimedDatasetFolders: [],
    }));
    // Main finds each automation's Collection by its id.
    bridge.findAutomationCollection.mockResolvedValue({ status: "found", collectionPath: "tasks" });
    bridge.listCollectionAutomationRuns.mockImplementation(async ({ automationId }) => ({
      status: "listed",
      runs: [
        {
          claimId: automationId.endsWith("#first") ? "atc_first" : "atc_second",
          state: "failed" as const,
          error: "The record is open elsewhere.",
          createdAtMs: 5_000,
          updatedAtMs: 5_000,
          trigger: {
            kind: "changed",
            recordId: "rec_1",
            by: "human",
            sharedAuthor: null,
            depth: 0,
          },
          writes: [],
          definitionChanged: false,
          neverStarted: false,
          chainStopped: false,
          undoUnfinished: false,
          undone: false,
        },
      ],
      next: null,
    }));
    return bridge;
  }

  // Chats' answer for a Group invitation, share-1, that waits with Join.
  const INVITATION_LISTING = {
    joined: [] as JoinedChannelAnswer[],
    sessionKey: null,
    relay: {
      state: "answered" as const,
      granted: [],
      received: [
        {
          shareId: "share-1",
          channelWireId: "wire-share-1",
          access: "read-write" as const,
          granterEmail: "owner@example.com",
        },
      ],
      removed: [],
    },
  };

  describe("from a link to a Group or a message request", () => {
    const DONE: ShareHandoffStatus = { status: "done", statusId: "status-1", shareId: "share-1" };

    function handoffBridge(uiState: Promise<WorkspaceUiState | null> = Promise.resolve(null)) {
      return Object.assign(makeBridge(uiState), {
        listChatChannelShares: vi.fn(async () => INVITATION_LISTING),
        getRelayReceivedShare: vi.fn(async (): Promise<{ found: true; chats: true }> => ({
          found: true,
          chats: true,
        })),
      });
    }
    // DesktopRoot's part: a switch remounts the shell for the other
    // workspace, and either way of ending the handoff makes it idle. `ends`
    // records each end, so a path that ends it before Chats opens it, through
    // either prop, fails these tests.
    function renderHandoff(
      bridge: ReturnType<typeof handoffBridge>,
      workspace: Workspace,
      workspaces: Workspace[],
      extra: { settings?: typeof DEFAULT_USER_SETTINGS; sentNotices?: SentNotices } = {},
    ) {
      vi.stubGlobal("dohcDesktop", bridge);
      const ends: ("opened" | "dismissed")[] = [];
      const onSwitchWorkspace = vi.fn();
      let setHostStatus!: (status: ShareHandoffStatus) => void;
      function Host() {
        const [status, setStatus] = useState<ShareHandoffStatus>(DONE);
        setHostStatus = setStatus;
        const [current, setCurrent] = useState(workspace);
        return (
          <DesktopWorkspaceShell
            key={current.workspaceId}
            workspace={current}
            workspaces={workspaces}
            {...shellBootstrapProps(bridge)}
            {...(extra.settings
              ? { userSettings: { settings: extra.settings, source: "default" as const } }
              : {})}
            {...(extra.sentNotices ? { sentNotices: extra.sentNotices } : {})}
            onSwitchWorkspace={(next: Workspace) => {
              onSwitchWorkspace(next);
              setCurrent(next);
            }}
            handoffStatus={status}
            onShareHandoffOpened={() => {
              ends.push("opened");
              setStatus({ status: "idle" });
            }}
            onDismissShareHandoff={() => {
              ends.push("dismissed");
              setStatus({ status: "idle" });
            }}
          />
        );
      }
      const { unmount } = render(<Host />);
      return {
        ends,
        onSwitchWorkspace,
        unmount,
        setStatus: (status: ShareHandoffStatus) => setHostStatus(status),
      };
    }

    // Every share read and message-request sync waits for the test. The
    // mount's reads come first; the reveal's own come after them.
    function heldBridge(uiState?: Promise<WorkspaceUiState | null>) {
      const shares: Deferred<typeof INVITATION_LISTING>[] = [];
      const syncs: Deferred<SyncDmsResult>[] = [];
      const bridge = Object.assign(handoffBridge(uiState), {
        listChatChannelShares: vi.fn(() => {
          const read = deferred<typeof INVITATION_LISTING>();
          shares.push(read);
          return read.promise;
        }),
        syncDms: vi.fn(() => {
          const sync = deferred<SyncDmsResult>();
          syncs.push(sync);
          return sync.promise;
        }),
      });
      return { bridge, shares, syncs };
    }
    const answerEvery = async (reads: Deferred<any>[], value: unknown) => {
      await act(async () => {
        for (const read of reads) read.resolve(value);
      });
    };
    const opening = () => screen.findByText("Opening share…");

    it("doesn't end the handoff when a notice's Open shows another invitation while it waits", async () => {
      const { bridge, shares, syncs } = heldBridge();
      const OTHER: NoticeRow = {
        ...MENTION,
        noticeId: "share:3",
        kind: "share-received",
        workspaceId: null,
        recipientShareId: "share-3",
        title: "Ana shared a Group with you",
        target: {},
      };
      const notices = { ...sentNotices([OTHER]), toast: OTHER };
      const { ends } = renderHandoff(bridge, WORKSPACE, [WORKSPACE], { sentNotices: notices });
      await waitFor(() => expect(shares.length).toBeGreaterThanOrEqual(2));
      await opening();
      // Toasts sit above the card.
      const before = shares.length;
      fireEvent.click(await screen.findByTestId("sent-notice-toast-open"));
      await waitFor(() =>
        expect(bridge.getRelayReceivedShare).toHaveBeenCalledWith({ shareId: "share-3" }),
      );
      await waitFor(() => expect(shares.length).toBeGreaterThan(before));
      const third: typeof INVITATION_LISTING = {
        ...INVITATION_LISTING,
        relay: {
          ...INVITATION_LISTING.relay,
          received: [
            {
              ...INVITATION_LISTING.relay.received[0]!,
              shareId: "share-3",
              channelWireId: "wire-share-3",
            },
          ],
        },
      };
      const synced = syncs.length;
      await answerEvery(syncs, dmSyncResult());
      await answerEvery(shares, third);
      await waitFor(() => expect(syncs.length).toBeGreaterThan(synced));
      await answerEvery(syncs, dmSyncResult());
      await waitFor(() =>
        expect(screen.getByTestId("chats-join-shared").getAttribute("data-invitation")).toBe(
          "share-3",
        ),
      );
      await act(async () => undefined);
      expect(ends).toEqual([]);
      // Both lists answered for the other invitation, which says nothing
      // about this one.
      expect(screen.queryByTestId("handoff-chats-absent")).toBeNull();
    });
  });

  it("opens no runs for a notice whose Open was cancelled while main looked the automation up", async () => {
    const user = userEvent.setup();
    const bridge = withRuns(makeBridge(Promise.resolve(null)));
    const found = deferred<{ status: "found"; collectionPath: string }>();
    bridge.findAutomationCollection.mockReturnValueOnce(found.promise);
    renderWithNotices(bridge, { sentNotices: sentNotices([FAILED("first", "atc_first")]) });
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("sent-notice-automation-failed:first-open-row"));
    // Closing Notices cancels the Open.
    await user.click(screen.getByTestId("notice-center-toggle"));
    await act(async () => found.resolve({ status: "found", collectionPath: "tasks" }));
    expect(screen.queryByTestId("tab-dohc://collection/tasks")).toBeNull();
  });

  describe("through an Edit share view", () => {
    const EDIT_VIEW: Workspace = {
      ...WORKSPACE,
      shareView: { shareId: "share-1", granterEmail: "owner@dohc.test", access: "edit" },
    };
    const SWITCHED_OFF = {
      to: "automation-controls",
      automation: "collection:object-tasks#first",
      sharedFile: "tasks/automations.yaml",
    } as const;
    it("lets a later Open win over an earlier one still waiting on main", async () => {
      const user = userEvent.setup();
      const bridge = withRuns(makeBridge(Promise.resolve(null)));
      const first = deferred<ResolveAutomationControlsResult>();
      bridge.resolveAutomationControls
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ status: "found", collectionPath: "chores", automation: "second" });
      const later: NoticeRow = {
        ...MENTION,
        noticeId: "automation-failed:second",
        kind: "automation-failed",
        senderKind: "automation",
        workspaceId: null,
        recipientShareId: "share-1",
        title: 'Automation "second" switched off',
        target: {
          recovery: "automation-controls",
          automation: "collection:object-chores#second",
          path: "chores/automations.yaml",
        },
      };
      renderWithNotices(bridge, {
        openOnReady: SWITCHED_OFF,
        workspace: EDIT_VIEW,
        sentNotices: sentNotices([later]),
      });
      await waitFor(() => expect(bridge.resolveAutomationControls).toHaveBeenCalledTimes(1));
      await user.click(await screen.findByTestId("notice-center-toggle"));
      await user.click(await screen.findByTestId("sent-notice-automation-failed:second-open-row"));
      expect(await screen.findByTestId("tab-dohc://collection/chores")).toBeTruthy();
      await act(async () =>
        first.resolve({ status: "found", collectionPath: "tasks", automation: "first" }),
      );
      expect(screen.queryByTestId("tab-dohc://collection/tasks")).toBeNull();
      expect(screen.queryByTestId("tab-tasks/automations.yaml")).toBeNull();
    });
  });
});

describe("owner live documents", () => {
  it.each(["another", "closed"])(
    "drops the late pending Stop report for an %s workspace",
    async (mode) => {
      const bridge = makeBridge(Promise.resolve(null)),
        stopping = deferred<StopOwnerLiveDocumentResult>();
      bridge.listOwnerLiveDocuments = vi.fn(async () => ({
        documents: [LIVE_ROW],
        nextCursor: null,
      }));
      bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
      vi.stubGlobal("dohcDesktop", bridge);
      const shell = (workspace: Workspace) => (
        <DesktopWorkspaceShell
          workspace={workspace}
          workspaces={[WORKSPACE, OTHER_WORKSPACE]}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={() => {}}
        />
      );
      const view = render(shell(WORKSPACE)),
        user = userEvent.setup();
      const dialog = await openLiveDocumentsFromSettings(user);
      await user.click(
        await within(dialog).findByRole("button", {
          name: `Stop live editing for ${LIVE_ROW.path}`,
        }),
      );
      if (mode === "another") view.rerender(shell(OTHER_WORKSPACE));
      else view.unmount();
      await act(async () => stopping.reject(liveStopError({ code: "edits-pending" })));
      expect(screen.queryByText(`Live editing didn't stop for ${LIVE_ROW.path}`)).toBeNull();
      expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
    },
  );
  it("drops a pending Stop's Try again after switching workspaces", async () => {
    const notices = vi.spyOn(shellError, "useShellError");
    const bridge = makeBridge(Promise.resolve(null)),
      stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({
      documents: [LIVE_ROW],
      nextCursor: null,
    }));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    const view = render(shell(WORKSPACE)),
      user = userEvent.setup();
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(
      await within(dialog).findByRole("button", { name: `Stop live editing for ${LIVE_ROW.path}` }),
    );
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({ code: "edits-pending" })));
    await screen.findByTestId("workspace-shell-error");
    const latest: ReturnType<typeof shellError.useShellError> | undefined =
      notices.mock.results.at(-1)?.value;
    const retry = latest?.shellErrors.find(
      (error) => error.identity === `live-stop-edits-pending:${LIVE_ROW.objectId}`,
    )?.retry;
    notices.mockRestore();
    expect(retry).toBeTypeOf("function");
    view.rerender(shell(OTHER_WORKSPACE));
    await act(async () => {
      retry?.();
    });
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });

  it("reports a Stop refused after Live documents reopens and closes again in a toast", async () => {
    const bridge = makeBridge(Promise.resolve(null)),
      stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({
      documents: [LIVE_ROW],
      nextCursor: null,
    }));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup();
    renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(
      await within(dialog).findByRole("button", { name: `Stop live editing for ${LIVE_ROW.path}` }),
    );
    await user.keyboard("{Escape}");
    const reopened = await openLiveDocumentsFromSettings(user);
    await within(reopened).findByTestId(`live-document-row-${LIVE_ROW.path}`);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    await act(async () => stopping.reject(liveStopError({ code: "edits-pending" })));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(`Live editing didn't stop for ${LIVE_ROW.path}`)).toBeTruthy();
    expect(
      within(toast).getByText(
        "The server hasn't finished applying edits to this document. Try again in a moment.",
      ),
    ).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  const LIVE_ROW = {
    path: "notes/today.md",
    objectId: "object-today",
    status: "ready" as const,
    canResume: false,
  };

  async function openLiveDocumentsFromSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByTestId("activity-settings"));
    await screen.findByTestId("settings-dialog");
    await user.click(screen.getByTestId("settings-nav-cloud"));
    await user.click(await screen.findByRole("button", { name: "Open live documents" }));
    // Settings stays open underneath, so closing the dialog returns there.
    const dialog = await screen.findByTestId("live-documents-dialog");
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    return dialog;
  }

  it("closes back to Settings by a click outside or by Escape", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async (): Promise<OwnerLiveDocumentsResult> => ({
      documents: [],
      nextCursor: null,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(dialog.closest<HTMLElement>("[data-dohc-modal]")!);
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    expect(screen.getByTestId("settings-section-cloud")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open live documents" }));
    await screen.findByTestId("live-documents-dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    expect(screen.getByTestId("settings-section-cloud")).toBeTruthy();
  });

  it("makes a copy of a held file, with Try again when it fails, then opens the copy", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const held = {
      path: "notes/held.md",
      objectId: "object-held",
      status: "unavailable" as const,
      reason: "conflict-parent-withheld" as const,
      canResume: false,
    };
    bridge.listOwnerLiveDocuments = vi.fn(async (): Promise<OwnerLiveDocumentsResult> => ({
      documents: [held],
      nextCursor: null,
    }));
    const failed = deferred<never>();
    // The harness answers the second call with "notes/held - Copy.md".
    bridge.duplicateWorkspaceFile.mockReturnValueOnce(failed.promise);
    const user = userEvent.setup();
    renderShell(bridge);

    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(
      await within(dialog).findByRole("button", { name: `Make a copy of ${held.path}` }),
    );
    expect(bridge.duplicateWorkspaceFile).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE.workspaceId,
      relativePath: held.path,
    });
    await act(async () => {
      failed.reject(new Error("The source changed. Check the file, then try again."));
      await failed.promise.catch(() => undefined);
    });
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(`dohc could not make a copy of ${held.path}.`);
    // A failed copy leaves the list open to try another row.
    expect(screen.getByTestId("live-documents-dialog")).toBeTruthy();

    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    expect(bridge.duplicateWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId(editorTabTestId("notes/held - Copy.md"))).toBeTruthy();
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });
});

// Connect server is one path: signed in, the account and the sync switch are
// settings; signed out, connecting is the Cloud dialog.
describe("Connect server", () => {
  const SIGNED_OUT = { connected: false, email: "", serverUrl: "", workspaceSynced: false };
  const openFromPalette = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Connect server"));
  };

  it("opens the Cloud dialog while signed out, from the palette and from Settings", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => SIGNED_OUT);
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

    await openFromPalette(user);
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());

    await user.click(await screen.findByTestId("activity-settings"));
    await user.click(await screen.findByTestId("settings-nav-cloud"));
    await user.click(await screen.findByTestId("settings-cloud-connect"));
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    // Opened from Settings, the dialog closes back to Settings, by a click
    // outside it or by Escape.
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    const backdrop = screen
      .getByTestId("cloud-sync-panel")
      .closest<HTMLElement>("[data-dohc-modal]");
    await user.click(backdrop!);
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
    expect(screen.getByTestId("settings-section-cloud")).toBeTruthy();

    await user.click(screen.getByTestId("settings-cloud-connect"));
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
    expect(screen.getByTestId("settings-section-cloud")).toBeTruthy();
  });

  it("keeps a typed address when the click outside the dialog was a stray one", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => SIGNED_OUT);
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

    await openFromPalette(user);
    const field = await screen.findByTestId("cloud-server-url");
    await user.type(field, "https://cloud.dohc.test");
    await user.click(
      screen.getByTestId("cloud-sync-panel").closest<HTMLElement>("[data-dohc-modal]")!,
    );
    expect(screen.getByTestId("cloud-sync-panel")).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  // The app menu's Settings replaces the dialog rather than opening under it,
  // so Escape closes what is on top.
  it("closes the Cloud dialog when the app menu opens Settings", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => SIGNED_OUT);
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

    await openFromPalette(user);
    await screen.findByTestId("cloud-sync-panel");
    act(() => bridge.emitMenuCommand("settings"));
    await screen.findByTestId("settings-dialog");
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
  });
});

describe("Undo on an Explorer notice", () => {
  const DELETED = "dohc-operation:22222222-2222-4222-8222-222222222222";
  type UndoAnswer = Awaited<ReturnType<DohcDesktopBridge["undoHistoryOperation"]>>;

  function undoBridge() {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn(async () => ({
        trashed: true,
        operationId: DELETED,
        undo: { available: true as const },
      })),
      undoHistoryOperation: vi.fn(async (): Promise<UndoAnswer> => ({
        ok: true,
        tracked: { state: "restored", momentCount: 1 },
        restored: [],
        remaining: [],
      })),
    });
    bridge.readExplorerMenu.mockResolvedValue([{ kind: "item", label: "Delete", id: "delete" }]);
    return bridge;
  }

  async function deleteFromMenu(path: string) {
    fireEvent.contextMenu(
      (await screen.findAllByTestId("tree-row")).find((row) => row.dataset.path === path)!,
    );
    fireEvent.click(await screen.findByTestId("explorer-menu-item-delete"));
  }

  async function undoFromNotices(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(
      within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Undo" }),
    );
  }

  const shell = (bridge: ReturnType<typeof undoBridge>, workspace: Workspace) => (
    <DesktopWorkspaceShell
      workspace={workspace}
      workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)}
      onSwitchWorkspace={() => {}}
    />
  );

  it("undoes a delete after the side panel hid the Explorer", async () => {
    const bridge = undoBridge();
    const user = userEvent.setup();
    renderShell(bridge);
    await deleteFromMenu("a.md");
    await screen.findAllByText("Deleted a.md. It's in the system trash.");
    await user.click(screen.getByTestId("titlebar-primary-sidebar"));
    expect(screen.queryByTestId("file-tree")).toBeNull();

    await undoFromNotices(user);
    await waitFor(() =>
      expect(bridge.undoHistoryOperation).toHaveBeenCalledWith({
        workspaceId: WORKSPACE.workspaceId,
        operationId: DELETED,
      }),
    );
    expect(await screen.findAllByText("Restored a.md")).not.toHaveLength(0);
  });
  it("never shows workspace A's late delete in workspace B", async () => {
    const bridge = undoBridge();
    const deleted = deferred<{
      trashed: boolean;
      operationId: string;
      undo: { available: true };
    }>();
    bridge.deleteWorkspacePath.mockReturnValueOnce(deleted.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, WORKSPACE));
    await deleteFromMenu("a.md");
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, OTHER_WORKSPACE));
    await act(async () =>
      deleted.resolve({ trashed: true, operationId: DELETED, undo: { available: true } }),
    );
    expect(screen.queryByText("Deleted a.md. It's in the system trash.")).toBeNull();
  });

  it("never reports the answer to workspace A's Undo in workspace B", async () => {
    const bridge = undoBridge();
    const undone = deferred<UndoAnswer>();
    bridge.undoHistoryOperation.mockReturnValueOnce(undone.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const user = userEvent.setup();
    const view = render(shell(bridge, WORKSPACE));
    await deleteFromMenu("a.md");
    await screen.findAllByText("Deleted a.md. It's in the system trash.");
    await undoFromNotices(user);
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, OTHER_WORKSPACE));
    await act(async () =>
      undone.resolve({
        ok: false,
        reason: "Cannot undo the delete.",
        refusal: { code: "unexplained" },
      }),
    );
    expect(screen.queryByText("Cannot restore a.md.")).toBeNull();
  });

  async function renameTo(user: ReturnType<typeof userEvent.setup>, path: string, name: string) {
    await user.click(
      (await screen.findAllByTestId("tree-row")).find((row) => row.dataset.path === path)!,
    );
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, `${name}{Enter}`);
  }

  it("never shows workspace A's live-page refusal in workspace B", async () => {
    const title = `dohc can't rename "a.md" while it has live editing on`;
    const refused = deferred<never>();
    const bridge = Object.assign(undoBridge(), {
      moveWorkspacePath: vi.fn().mockReturnValueOnce(refused.promise),
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const user = userEvent.setup();
    const view = render(shell(bridge, WORKSPACE));
    await renameTo(user, "a.md", "b");
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, OTHER_WORKSPACE));
    await act(async () =>
      refused.reject(
        new Error(`Error invoking remote method 'desktop:move-workspace-path': LivePageOwnedError: dohc can't move "a.md" while it has live editing on
In Live documents, stop live editing for this page, then move it again.`),
      ),
    );
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Live documents" })).toBeNull();
  });
});

describe("a refused rename of a page this computer owns live", () => {
  const TITLE = `dohc can't rename "a.md" while it has live editing on`;
  const BODY = "In Live documents, stop live editing for this page, then rename it again.";
  const refusal =
    new Error(`Error invoking remote method 'desktop:move-workspace-path': LivePageOwnedError: dohc can't move "a.md" while it has live editing on
In Live documents, stop live editing for this page, then move it again.`);
  const treePaths = async () =>
    (await screen.findAllByTestId("tree-row")).map((row) => row.dataset.path);

  it("puts the old name back at once, says rename, and offers Try again and Live documents", async () => {
    const refused = deferred<never>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi
        .fn()
        .mockReturnValueOnce(refused.promise)
        .mockResolvedValueOnce({
          path: "renamed.md",
          undo: { available: false, reason: "", paths: [] },
        }),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({
      visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "a.md", kind: "file" as const }],
      folders: [],
    });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({
      nextCursor: null,
      documents: [
        { path: "a.md", objectId: "object-a", status: "ready" as const, canResume: false },
      ],
    }));
    renderShell(bridge);
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("tree-row")).find(
      (candidate) => candidate.dataset.path === "a.md",
    )!;
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
    const notice = (
      await within(await screen.findByTestId("notice-center")).findByText(TITLE)
    ).closest("li")!;
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(notice).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByTestId("live-document-row-a.md").getAttribute("aria-current"),
      ).toBe("true"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    // Live editing stopped: Try again renames to the name the person typed.
    // The pointer read the row on its way to Open Live documents, so its toast
    // stays closed and Try again waits in Notices.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const again = (
      await within(await screen.findByTestId("notice-center")).findByText(TITLE)
    ).closest("li")!;
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
    expect(bridge.moveWorkspacePath).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE.workspaceId,
      fromPath: "a.md",
      toPath: "renamed.md",
    });
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
  });
});

it("signs in again from Notices, and sync resumes with no enable or pause", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let status: SyncStatusResult = {
      ...SYNC_STATUS,
      state: "sign-in-expired",
      signInExpired: true,
    };
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(),
      cloudStopSync: vi.fn(),
      cloudLogout: vi.fn(),
      cloudLoginStart: vi.fn(async () => ({
        userCode: "ABCD",
        verificationUri: "https://cloud.dohc.test/device",
      })),
      cloudLoginPoll: vi.fn(async () => {
        status = { ...SYNC_STATUS };
        return { status: "complete" as const, email: "me@dohc.test" };
      }),
    });
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true,
      workspaceSyncConnected: true,
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
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").getAttribute("data-state")).toBe("synced"),
    );
    expect(screen.queryByTestId("notice-sign-in-expired")).toBeNull();
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    expect(bridge.cloudEnableSync).not.toHaveBeenCalled();
    expect(bridge.cloudStopSync).not.toHaveBeenCalled();
    expect(bridge.cloudLogout).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

// Settings shows the same expired row: no switch reading on while nothing
// syncs, and Sign in again in Try again's place.
it.each([
  [
    "the title bar says so",
    { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true },
    "Sign in again to sync",
  ],
  // A conflict shows first, and the switch still mustn't read on.
  [
    "a conflict shows first",
    { ...SYNC_STATUS, state: "conflict", conflictCount: 1, signInExpired: true },
    "Conflict (1)",
  ],
] as const)(
  "shows Sign in again in Settings while the sign-in is expired, never the switch, when %s",
  async (_, shown, label) => {
    const status: SyncStatusResult = shown;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(),
      cloudStopSync: vi.fn(),
      cloudLoginStart: vi.fn(async () => ({
        userCode: "ABCD",
        verificationUri: "https://cloud.dohc.test/device",
      })),
    });
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true,
      workspaceSyncConnected: true,
    }));
    renderShell(bridge);
    const user = userEvent.setup();

    expect((await screen.findByTestId("sync-status")).textContent).toBe(label);
    // Signed in, Connect server opens Settings' Sync and sharing page.
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Connect server"));
    const row = within(await screen.findByTestId("settings-row-sync-workspace"));
    expect(row.queryByRole("switch")).toBeNull();
    expect(row.getByTestId("cloud-workspace-sign-in-expired").textContent).toBe(
      "This workspace isn't syncing until you sign in again.",
    );
    expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Sign in again",
      "Pause sync",
    ]);
    await user.click(row.getByRole("button", { name: "Sign in again" }));
    await screen.findByTestId("cloud-user-code");
    // Settings stays open underneath, so closing the dialog returns there.
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    expect(bridge.cloudLoginStart).toHaveBeenCalledWith({ serverUrl: "https://cloud.dohc.test" });
    expect(bridge.cloudEnableSync).not.toHaveBeenCalled();
    expect(bridge.cloudStopSync).not.toHaveBeenCalled();
  },
);
