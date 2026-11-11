// @vitest-environment jsdom
import { LIVE_STOP_SERVER_NOT_READY, LIVE_STOP_WAITING, liveStopError, liveStopWaitingError } from "../ipc/liveEditingStop";
import "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { HOST_STOP_CASES, hostStopWireError } from "../testing/liveStopHost.test-helper";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as shellError from "./shell/useShellError";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { ENGINE_STORE_BACKUP_DIR } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { HistoryStillPausedError, ipcWireError, PRIVACY_DENIED_WORDS } from "../ipc/errorWords";
import type { DohcDesktopBridge, OwnerLiveDocumentsResult, SaveOwnerLiveRecoveryCopyResult, StopOwnerLiveDocumentResult, McpConfigResult, NoticeRow, RebuildEngineStoreResult, ResolveAutomationControlsResult, SyncStatusResult, EngineYDocSaveStateEvent, WorkspaceUiState } from "../ipc/bridgeContract";
import { useSentNotices, type SentNotices } from "./shell/useSentNotices";
import type { NoticeTarget } from "../notices/noticeTarget";
import type { Workspace } from "./DesktopWorkspaceShell";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { useEngineDoc } from "./collab/useEngineDoc";
import { useReopenKey } from "./documentVersionKey";
import { deferred } from "../testing/deferred";
import { inputCount } from "./ui/inputCount";
import { COPY_FAILURE } from "./ui/CopyButton";
import { DesktopWorkspaceShell, WORKSPACE, OTHER_WORKSPACE, SHARE_VIEW, SYNC_STATUS, READY_UPDATE_STATE, STORED_STATE, storedStateWithTabs, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

// A data store the engine refuses gets a real recovery, not a dead
// generic error. The notice explains what was found; the rebuild is explicit
// (a confirmed click), states the destination before anything moves, and the
// success copy names the reverse path.
it("keeps a failed document Stop in Notices with Try again and Copy details",async () => {
  const bridge=makeBridge(Promise.resolve(null));
  bridge.getSyncStatus=vi.fn(async () => ({...SYNC_STATUS,ownerLiveStopFailures:[{objectId:"object-a",path:"a.md",detail:"corrupt"}]}));
  renderShell(bridge);
  const user=userEvent.setup();
  await user.click(await screen.findByTestId("notice-center-toggle"));
  const notices=await screen.findByTestId("notice-center");
  const row=(await within(notices).findByText('dohc could not stop live editing for "a.md".')).closest("li")!;
  expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
  await user.click(within(row).getByRole("button",{name:"Try again"}));
  await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledWith({workspaceId:WORKSPACE.workspaceId,path:"a.md",objectId:"object-a"}));
  expect(within(notices).queryByText("corrupt")).toBeNull();
});

// History that stopped recording is one workspace error: a toast and a
// Notices row, each with Try again, and the row goes once capture runs.
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

// An open report keeps its text while other notices arrive: its Time is when
// the notice was raised, not when the list last drew.
it("keeps an open Details report's text when another notice arrives later", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.parse("2026-11-07T09:00:00Z"));
    const bridge = makeBridge(Promise.resolve(null));
    let status: SyncStatusResult = { ...SYNC_STATUS, historyCaptureFailed: true, engineStoreRefused: null };
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = await within(notices).findByTestId("notice-history-capture-failed");
    await user.click(within(row).getByRole("button", { name: "Details" }));
    const report = () => row.querySelector("pre")?.textContent;
    const before = report();
    expect(before).toContain("Time: 2026-11-07T09:00:");

    vi.setSystemTime(Date.parse("2026-11-07T10:00:00Z"));
    status = { ...status, ownerLiveStopFailures: [{ objectId: "object-a", path: "a.md", detail: "corrupt" }] };
    act(() => bridge.emitWorkspaceActivity());
    await within(notices).findByText('dohc could not stop live editing for "a.md".');
    expect(within(row).getByRole("button", { name: "Hide details" })).toBeTruthy();
    expect(report()).toBe(before);
  } finally {
    vi.useRealTimers();
  }
});

describe("History paused words", () => {
  function pausedBridge() {
    const bridge = makeBridge(Promise.resolve(null));
    const status: SyncStatusResult = { ...SYNC_STATUS, historyCaptureFailed: true, engineStoreRefused: null };
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    return bridge;
  }
  // What the renderer receives when Try again's handler rejects.
  const acrossIpc = (error: Error) =>
    new Error(`Error invoking remote method 'desktop:retry-history-capture': ${String(ipcWireError(error))}`);
  // Try again from the toast, then the words its failure shows in the toast
  // and in the Notices row.
  async function failedRetryWords(failure: Error) {
    const bridge = pausedBridge();
    bridge.retryHistoryCapture.mockRejectedValueOnce(failure);
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(bridge.retryHistoryCapture).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.workspaceId });
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).not.toContain("Your files still save normally."));
    const toast = screen.getByTestId("workspace-shell-error").textContent;
    expect(toast).toContain("History paused");
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = await within(await screen.findByTestId("notice-center")).findByTestId("notice-history-capture-failed");
    expect(row.textContent).toContain("History paused");
    return { toast, row: row.textContent, user };
  }

  it("says in the toast and the Notices row that files still save", async () => {
    renderShell(pausedBridge());
    const body = "Your files still save normally. Open files may not show changes made outside dohc until History records again.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("History paused");
    expect(toast.textContent).toContain(body);
    await userEvent.click(await screen.findByTestId("notice-center-toggle"));
    const row = await within(await screen.findByTestId("notice-center")).findByTestId("notice-history-capture-failed");
    expect(row.textContent).toContain("History paused");
    expect(row.textContent).toContain(body);
  });

  it("names the page whose live editing stopped when Try again leaves History paused", async () => {
    const { toast, row } = await failedRetryWords(acrossIpc(new HistoryStillPausedError(["notes/plan.md"])));
    const body = 'Close every tab showing "notes/plan.md", then reopen it and try again. Live editing on that page stopped.';
    expect(toast).toContain(body);
    expect(row).toContain(body);
  });

  it("counts the pages whose live editing stopped, and lists each in its Details", async () => {
    const paths = ["notes/a, b.md", "notes/12:30 \"call\".md", "notes/plan.md"];
    const { toast, row, user } = await failedRetryWords(acrossIpc(new HistoryStillPausedError(paths)));
    const body = "History is still paused because live editing stopped on 3 pages. Restart dohc to try again.";
    expect(toast).toContain(body);
    expect(row).toContain(body);
    const notice = within(screen.getByTestId("notice-center")).getByTestId("notice-history-capture-failed");
    await user.click(within(notice).getByRole("button", { name: "Details" }));
    await user.click(within(notice).getByRole("button", { name: "Copy details" }));
    const copied = (await navigator.clipboard.readText()).split("\n");
    expect(copied.filter(line => line.startsWith("File: "))).toEqual(paths.map(path => `File: ${path}`));
  });

  it.each([
    ["the engine is still reading the folder", new Error("Error invoking remote method 'desktop:retry-history-capture': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.")],
    ["capture did not settle in time", new Error("Error invoking remote method 'desktop:retry-history-capture': EngineCaptureNotSettledError: Engine capture for workspace-1 did not settle.")],
  ])("says History is still catching up when Try again finds %s", async (_reason, failure) => {
    const { toast, row } = await failedRetryWords(failure);
    const body = "History is still catching up. Try again in a few minutes.";
    expect(toast).toContain(body);
    expect(row).toContain(body);
  });

  it.each([
    ["capture still fails", acrossIpc(new HistoryStillPausedError([]))],
    ["the engine refused the restart", new Error("Error invoking remote method 'desktop:retry-history-capture': DaemonRefusalError [WORKSPACE_UNAVAILABLE]: workspace handle is unavailable")],
  ])("asks for a restart when Try again leaves History paused because %s", async (_reason, failure) => {
    const { toast, row } = await failedRetryWords(failure);
    const body = "History is still paused. Restart dohc to try again.";
    expect(toast).toContain(body);
    expect(row).toContain(body);
  });
});

// Edits the server refused for good wait in a queue on this computer. Each
// document gets its own notice, which names it and says where its edits are.
describe("edits the server refused", () => {
  const quarantine = {objectId: "object-1", path: "notes/plan.md", reason: "invalid-update", storedOn: "this-computer" as const,
    incident: "outbox:delivery:0", recovery: "paused" as const};
  const quarantined = (...rows: NonNullable<SyncStatusResult["ownerLiveQuarantines"]>): SyncStatusResult =>
    ({...SYNC_STATUS, ownerLiveQuarantines: rows});
  const TITLE = "Live editing paused for notes/plan.md";
  const BODY = "The server could not accept your edits. dohc kept them on this computer. Save a recovery copy to get them back.";
  it.each([0, 1])("keeps each restore queue in its own save-only notice: %i", async index => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(...["old-1:delivery:0", "old-2:delivery:0"].map(incident =>
      ({...quarantine, reason: "restore-fenced", saveOnly: true as const, incident}))));
    renderShell(bridge);
    await screen.findByTestId("workspace-shell-error");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const rows = within(notices).getAllByText("Edits not written to notes/plan.md").map(title => title.closest("li")!);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).queryByRole("button", {name: "Try again"})).toBeNull();
      expect(within(row).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
      expect(row.textContent).toContain("dohc kept your unsent edits, but could not write them to your file. Save a recovery copy to get them back.");
    }
    await user.click(within(rows[index]!).getByRole("button", {name: "Save recovery copy"}));
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledWith({workspaceId: WORKSPACE.workspaceId,
      path: "notes/plan.md", incident: index === 0 ? "old-2:delivery:0" : "old-1:delivery:0"});
  });
  it("says a retired queue's live editing session ended", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined({...quarantine, reason: "retired", saveOnly: true as const}));
    renderShell(bridge);
    await screen.findByTestId("workspace-shell-error");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = within(notices).getByText("Edits not written to notes/plan.md").closest("li")!;
    expect(row.textContent).toContain("dohc kept your unsent edits because their live editing session ended. Save a recovery copy to get them back.");
    expect(row.textContent).not.toContain("could not write them to your file");
  });
  it("lists a restore queue in Live documents when the server's list cannot load", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined({...quarantine, reason: "restore-fenced", saveOnly: true as const}));
    bridge.listOwnerLiveDocuments = vi.fn(async () => { throw new Error("relay unreachable"); });
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    await userEvent.setup().click(within(toast).getByRole("button", {name: "Open Live documents"}));
    const dialog = await screen.findByTestId("live-documents-dialog");
    const row = await within(dialog).findByTestId("live-document-row-notes/plan.md-outbox:delivery:0");
    expect(within(dialog).getByText("dohc could not load the server's list. These edits are kept on this computer.")).toBeTruthy();
    expect(within(row).getByRole("button", {name: "Save recovery copy of notes/plan.md"})).toBeTruthy();
  });
  const RECOVERED = "Live editing stopped for notes/plan.md. dohc wrote your kept edits into the file.";
  const liveRows = (): OwnerLiveDocumentsResult => ({nextCursor: null, documents: [
    {path: "other.md", objectId: "object-other", status: "ready", canResume: false},
    {path: "notes/plan.md", objectId: "object-1", status: "ready", canResume: false, quarantine: "paused"},
  ]});

  it("names the document and where its edits are, as a toast and one Notices row with copy beside the text", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine));
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByText(BODY)).toBeTruthy();
    // The server named no version, so the notice claims none.
    expect(toast.textContent).not.toMatch(/version|incompatib|update dohc/i);
    expect(within(toast).getByRole("button", { name: "Details" })).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Open Live documents"})).toBeTruthy();
    // The same incident read again adds nothing.
    const reads = bridge.getSyncStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    const user = userEvent.setup();
    // Closing the toast keeps the row.
    await user.click(within(toast).getByRole("button", {name: "Dismiss workspace error"}));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(within(notices).getAllByText(TITLE)).toHaveLength(1);
    const row = within(notices).getByText(TITLE).closest("li")!;
    expect(within(row).getByText(BODY)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
    // Not the workspace's moved-or-removed notice.
    expect(within(notices).queryByTestId("notice-owner-live-delivery")).toBeNull();
  });

  it("keeps the edits queued when the row is dismissed, and does not show the same incident again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine));
    renderShell(bridge);
    await screen.findByTestId("workspace-shell-error");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    await user.click(within(row).getByRole("button", {name: "Dismiss notice"}));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    const reads = bridge.getSyncStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByText(TITLE)).toBeNull();
    // Dismissing asked main for nothing: the queue and its quarantine stay.
    expect(bridge.retryOwnerLiveQuarantine).not.toHaveBeenCalled();
    expect(bridge.stopOwnerLiveDocument).not.toHaveBeenCalled();
    expect(bridge.resumeOwnerLiveDocument).not.toHaveBeenCalled();
  });

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

  it("opens Live documents at the document's row with its Stop live editing focused", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine));
    bridge.listOwnerLiveDocuments = vi.fn(async () => liveRows());
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    await userEvent.setup().click(within(toast).getByRole("button", {name: "Open Live documents"}));
    const dialog = await screen.findByTestId("live-documents-dialog");
    const stop = await within(dialog).findByRole("button", {name: "Stop live editing for notes/plan.md"});
    await waitFor(() => expect(document.activeElement).toBe(stop));
    const row = within(dialog).getByTestId("live-document-row-notes/plan.md");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.textContent).toContain("Save a recovery copy to get them back.");
  });

  it("says the kept edits are in the file only after the Stop wrote them", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine));
    bridge.listOwnerLiveDocuments = vi.fn(async () => liveRows());
    const stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.stopOwnerLiveDocument = vi.fn(() => stopping.promise);
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Open Live documents"}));
    await user.click(await within(await screen.findByTestId("live-documents-dialog")).findByRole("button", {name: "Stop live editing for notes/plan.md"}));
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledWith({workspaceId: WORKSPACE.workspaceId, path: "notes/plan.md", objectId: "object-1"});
    expect(screen.queryByText(RECOVERED)).toBeNull();
    await act(async () => { stopping.resolve({keptEdits: "recovered"}); await stopping.promise; });
    expect(await screen.findByText(RECOVERED)).toBeTruthy();
  });

  it("keeps a Stop that could not write the edits in its own notice, without a success or a Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status = quarantined(quarantine);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.listOwnerLiveDocuments = vi.fn(async () => liveRows());
    bridge.stopOwnerLiveDocument = vi.fn(async () => {
      // Main read the queue again after the release: still there, now stopped.
      status = quarantined({...quarantine, recovery: "stopped-kept"});
      return {keptEdits: "kept" as const};
    });
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Open Live documents"}));
    await user.click(await within(await screen.findByTestId("live-documents-dialog")).findByRole("button", {name: "Stop live editing for notes/plan.md"}));
    await user.click(screen.getByRole("button", {name: "Close"}));
    act(() => bridge.emitWorkspaceActivity());
    const kept = await screen.findByText("Live editing stopped for notes/plan.md");
    const toast = kept.closest<HTMLElement>("[data-testid='workspace-shell-error']")!;
    expect(within(toast).getByText("dohc kept your unsent edits, but could not write them to your file. Save a recovery copy to get them back.")).toBeTruthy();
    expect(within(toast).queryByRole("button", {name: "Try again"})).toBeNull();
    expect(within(toast).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Open Live documents"})).toBeTruthy();
    expect(screen.queryByText(RECOVERED)).toBeNull();
  });

  // A queue over the release limits defers every Stop, so the copy is the way back.
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

  it("says when only a recovery package could be saved, and offers Try again when nothing could", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine));
    bridge.saveOwnerLiveRecoveryCopy = vi.fn()
      .mockRejectedValueOnce(new Error("dohc could not find a free name for the recovery copy. Rename older recovery copies, then try again."))
      .mockResolvedValueOnce({copyPath: null, packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer", keptEdits: "kept"});
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Save recovery copy"}));
    const failed = await screen.findByText(/^dohc could not save a recovery copy of notes\/plan\.md\. dohc could not find a free name/);
    await user.click(within(failed.closest<HTMLElement>("[data-testid='workspace-shell-error']")!).getByRole("button", {name: "Try again"}));
    expect(await screen.findByText("Saved your kept edits for notes/plan.md as a recovery package in notes. dohc could not make a readable copy. Your kept edits stay on this computer.")).toBeTruthy();
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledTimes(2);
  });

  // The server could not prepare the earlier copy of the workspace that holds
  // the edits. Its reason replaces the second sentence, and Try again saves
  // the copy again without sending the edits.
  it("says why the server could not prepare a recovery copy, in a toast and a Notices row with Try again and details", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine));
    bridge.saveOwnerLiveRecoveryCopy = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'saveOwnerLiveRecoveryCopy': ServerRecoveryCopyRefusedError [disk-space]: Ask the server administrator to free disk space, then try again."))
      .mockResolvedValueOnce({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "server", keptEdits: "copied"});
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Save recovery copy"}));
    const MESSAGE = "dohc could not save a recovery copy of notes/plan.md. Ask the server administrator to free disk space, then try again.";
    const toast = (await screen.findByText(MESSAGE)).closest<HTMLElement>("[data-testid='workspace-shell-error']")!;
    expect(within(toast).getByRole("button", { name: "Details" })).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = within(await screen.findByTestId("notice-center")).getByText(MESSAGE).closest("li")!;
    expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
    await user.click(within(row).getByRole("button", {name: "Try again"}));
    expect(await screen.findByText("Saved a recovery copy of notes/plan.md in notes. The server may now release your kept edits.")).toBeTruthy();
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledTimes(2);
    expect(bridge.retryOwnerLiveQuarantine).not.toHaveBeenCalled();
  });

  it("runs one save per file at a time, and names the workspace folder for a file at its top", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined({...quarantine, path: "plan.md"}));
    const saving = deferred<SaveOwnerLiveRecoveryCopyResult>();
    bridge.saveOwnerLiveRecoveryCopy = vi.fn(() => saving.promise);
    renderShell(bridge);
    const user = userEvent.setup();
    const save = within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Save recovery copy"});
    await user.click(save);
    await user.click(save);
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledOnce();
    await act(async () => { saving.resolve({copyPath: "plan (recovered).md", packagePath: "plan (recovered).dohc-recovery.json", storedOn: "this-computer", keptEdits: "kept"}); await saving.promise; });
    expect(await screen.findByText("Saved a recovery copy of plan.md in the workspace folder. Your kept edits stay on this computer.")).toBeTruthy();
  });

  // A document the server hosts keeps its refused edits on the server. Until
  // the owner's recovery copy is saved, the notice says so, and it stays.
  it("says dohc kept them on the server until a recovery copy is saved, then quietly that the server may release them", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const server = {...quarantine, storedOn: "server" as const, incident: "server:outbox:1"};
    let status = quarantined(server);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.saveOwnerLiveRecoveryCopy = vi.fn(async () => {
      status = quarantined({...server, recovery: "copied"});
      return {copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "server" as const, keptEdits: "copied" as const};
    });
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByText("The server could not accept your edits. dohc kept them on the server. Save a recovery copy to get them back.")).toBeTruthy();
    expect(within(toast).queryByText(BODY)).toBeNull();
    const user = userEvent.setup();
    await user.click(within(toast).getByRole("button", {name: "Save recovery copy"}));
    expect(await screen.findByText("Saved a recovery copy of notes/plan.md in notes. The server may now release your kept edits.")).toBeTruthy();
    act(() => bridge.emitWorkspaceActivity());
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    // Another of the owner's computers may have saved it, so the row names no computer.
    const copied = "The server could not accept your edits. A recovery copy of them is saved, so the server may now release them.";
    expect(await within(notices).findByText(copied)).toBeTruthy();
    expect(within(notices).queryByText("The server could not accept your edits. dohc kept them on the server. Save a recovery copy to get them back.")).toBeNull();
    // Try again still names the server's refusal.
    await user.click(within(within(notices).getByText(copied).closest("li")!).getByRole("button", {name: "Try again"}));
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, objectId: "object-1", incident: "server:outbox:1"});
  });

  // Edits the server keeps in an earlier copy of the workspace: Try again cannot reach them, so the notice offers only Save,
  // before and after a recovery copy of them is saved.
  it("says the server kept edits in an earlier copy of the workspace, and offers Save but never Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const earlier = {...quarantine, storedOn: "server" as const, incident: "server:outbox:1", earlier: true as const};
    let status = quarantined(earlier);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.saveOwnerLiveRecoveryCopy = vi.fn(async () => {
      status = quarantined({...earlier, recovery: "copied"});
      return {copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "server" as const, keptEdits: "copied" as const};
    });
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByText("The server could not accept your edits. It kept them in an earlier copy of this workspace. Save a recovery copy to get them back.")).toBeTruthy();
    expect(within(toast).queryByRole("button", {name: "Try again"})).toBeNull();
    const user = userEvent.setup();
    await user.click(within(toast).getByRole("button", {name: "Save recovery copy"}));
    expect(bridge.saveOwnerLiveRecoveryCopy).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, path: "notes/plan.md", incident: "server:outbox:1"});
    act(() => bridge.emitWorkspaceActivity());
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const copied = await within(notices).findByText("The server could not accept your edits. A recovery copy of them is saved, so the server may now release them.");
    expect(within(copied.closest("li")!).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    expect(within(copied.closest("li")!).queryByRole("button", {name: "Try again"})).toBeNull();
  });

  // The release committed, then settlement could not write the file.
  it("says once that a Stop could not write the file, and its Try again writes it", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status = quarantined({...quarantine, incident: "release:lineage:0", recovery: "not-written"});
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.stopOwnerLiveDocument = vi.fn(async () => {status = SYNC_STATUS; return {keptEdits: "recovered" as const};});
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    // The document may be live again, so the row names the edits, not the document's state.
    expect(within(toast).getByText("Edits not written to notes/plan.md")).toBeTruthy();
    expect(within(toast).getByText("When live editing stopped, dohc kept your unsent edits but could not write them to your file. Save a recovery copy to get them back.")).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    expect(screen.queryByText(RECOVERED)).toBeNull();
    // The same incident read again adds nothing.
    const reads = bridge.getSyncStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.getAllByText("Edits not written to notes/plan.md")).toHaveLength(1);
    await userEvent.setup().click(within(toast).getByRole("button", {name: "Try again"}));
    // Try again acts on the row's own document only.
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, path: "notes/plan.md",
      again: {objectId: "object-1", recovery: "not-written"}});
    expect(await screen.findByText(RECOVERED)).toBeTruthy();
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(screen.queryByText("Edits not written to notes/plan.md")).toBeNull());
  });

  // A rebuilt queue and an earlier Stop's edits for one document each keep their own row.
  it("keeps an earlier Stop's edits in their own row beside the document's current queue", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined(quarantine, {...quarantine, incident: "release:lineage:0", recovery: "not-written"}));
    renderShell(bridge);
    await userEvent.setup().click(await screen.findByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(await within(notices).findByText("Edits not written to notes/plan.md")).toBeTruthy();
    expect(within(notices).getByText(TITLE)).toBeTruthy();
  });

  // Try again found no release left: the row stays, offering only the copy, until a saved copy ends it.
  it("offers only Save recovery copy once dohc can't finish writing the edits, until a saved copy ends the row", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status = quarantined({...quarantine, incident: "release:lineage:0", recovery: "cannot-write"});
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.saveOwnerLiveRecoveryCopy = vi.fn(async () => {
      status = SYNC_STATUS;
      return {copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer" as const, keptEdits: "ended" as const};
    });
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText("Edits not written to notes/plan.md")).toBeTruthy();
    expect(within(toast).getByText("When live editing stopped, dohc kept your unsent edits but can't finish writing them to your file. Save a recovery copy to get them back.")).toBeTruthy();
    expect(within(toast).queryByRole("button", {name: "Try again"})).toBeNull();
    await userEvent.setup().click(within(toast).getByRole("button", {name: "Save recovery copy"}));
    // dohc no longer keeps them: the copy holds them now.
    expect(await screen.findByText("Saved a recovery copy of notes/plan.md in notes.")).toBeTruthy();
    expect(bridge.stopOwnerLiveDocument).not.toHaveBeenCalled();
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(screen.queryByText("Edits not written to notes/plan.md")).toBeNull());
  });

  // The engine refused to read the queue. The row names the document and the
  // refusal, offers no Save, and its Try again reads the queue again; while the
  // engine still refuses, the refusal replaces the row.
  it("keeps a queue dohc could not read in a row with the refusal, and Try again reads it again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const unreadable = {...quarantine, reason: "owner-outbox-accepted-state-incomplete", incident: "unreadable:outbox", recovery: "unreadable" as const};
    let status = quarantined(unreadable);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.retryOwnerLiveQuarantine = vi.fn()
      .mockRejectedValueOnce(new Error("owner-outbox-accepted-state-incomplete"))
      .mockImplementationOnce(async () => {status = quarantined(quarantine);});
    renderShell(bridge);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(TITLE)).toBeTruthy();
    expect(within(toast).getByText("dohc kept edits on this computer but could not read them.")).toBeTruthy();
    expect(within(toast).queryByRole("button", {name: "Save recovery copy"})).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = (await within(notices).findByText(TITLE)).closest("li")!;
    expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
    await user.click(within(row).getByRole("button", {name: "Try again"}));
    expect(bridge.retryOwnerLiveQuarantine).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, objectId: "object-1", incident: "unreadable:outbox"});
    const FAILED = "dohc could not read the edits it kept for notes/plan.md.";
    const failed = (await screen.findByText(FAILED)).closest<HTMLElement>("[data-testid='workspace-shell-error']")!;
    await user.click(within(failed).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.retryOwnerLiveQuarantine).toHaveBeenCalledTimes(2));
    // Read: the queue's own notice replaces the failure, with Save.
    act(() => bridge.emitWorkspaceActivity());
    const paused = (await screen.findByText(BODY)).closest<HTMLElement>("[data-testid='workspace-shell-error']")!;
    expect(within(paused).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const rows = await screen.findByTestId("notice-center");
    expect(within(rows).getAllByText(TITLE)).toHaveLength(1);
    expect(within(rows).queryByText(FAILED)).toBeNull();
  });

  // A Stop recorded on this computer whose server call failed: it waits, it is not stopped.
  it("files a waiting Stop quietly with Try again, and replaces it once background recovery finishes", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    let status = quarantined({...quarantine, recovery: "stopping"});
    bridge.getSyncStatus = vi.fn(async () => status);
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = (await within(notices).findByText("Stopping live editing for notes/plan.md")).closest("li")!;
    expect(within(row).getByText("dohc is waiting for the server to stop live editing. Your unsent edits stay on this computer.")).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByText(/Live editing stopped/)).toBeNull();
    await user.click(within(row).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledWith({workspaceId: WORKSPACE.workspaceId, path: "notes/plan.md",
      again: {objectId: "object-1", recovery: "stopping"}}));
    // Reconciliation released it in the background and wrote the file: nothing is left to say.
    status = SYNC_STATUS;
    const reads = bridge.getSyncStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByText("Stopping live editing for notes/plan.md")).toBeNull());
  });

  it("keeps a quiet row while a Try again waits", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus = vi.fn(async () => quarantined({...quarantine, incident: "outbox:delivery:1", recovery: "retrying"}));
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = (await within(await screen.findByTestId("notice-center")).findByText("Trying again for notes/plan.md")).closest("li")!;
    expect(within(row).getByText("dohc is sending your kept edits to the server once more.")).toBeTruthy();
    expect(within(row).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // DesktopRoot remounts the shell on a switch; this rerenders the same
  // instance, the stricter case.
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

it("dismisses unfinished Stop and restore through its workspace operation before removing the Notice", async () => {
  const bridge = makeBridge(Promise.resolve(null));
  const target = {kind: "person" as const, userId: "ana"};
  bridge.pendingStopAndRestores.mockResolvedValue([{target, label: "Ana", receipts: [], filesUndone: false,
    result: {status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, keptFields: [], fieldsMissing: 0,
      runChangesKept: 0, wroteAutomations: false, sendsMessages: false, unfinished: {step: "files", message: "Interrupted"}}}]);
  const dismissed = deferred<void>();
  bridge.dismissStopAndRestore.mockImplementation(() => dismissed.promise);
  const user = userEvent.setup();
  renderShell(bridge);
  await user.click(await screen.findByTestId("notice-center-toggle"));
  const message = "dohc stopped before restoring every file.";
  const row = (await within(await screen.findByTestId("notice-center")).findByText(message)).closest("li");
  if (row === null) throw new Error("No restore Notice row");
  await user.click(within(row).getByRole("button", {name: "Dismiss notice"}));
  expect(bridge.dismissStopAndRestore).toHaveBeenCalledWith({workspaceId: WORKSPACE.workspaceId, target});
  expect(row.isConnected).toBe(true);
  await act(async () => dismissed.resolve());
  await waitFor(() => expect(row.isConnected).toBe(false));
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

it("shows unsent draft failures through the existing toast and Notices reporter with Copy", async () => {
  const bridge = makeBridge(Promise.resolve(null));
  const listeners = new Set<(event: EngineYDocSaveStateEvent) => void>();
  bridge.onEngineYDocSaveState = vi.fn(listener => {listeners.add(listener); return () => {listeners.delete(listener);};});
  renderShell(bridge);
  await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
  const message = "Unsent changes to a.md are not saved. Draft storage refused. Copy them from the open document before you quit dohc.";
  const event: EngineYDocSaveStateEvent = {sessionId: "session-1", workspaceId: WORKSPACE.workspaceId, path: "notes/a.md", seq: 1, state: { kind: "error", reason: "test failure", issueId: null },
    editRefusal: {workspaceId: WORKSPACE.workspaceId, path: "notes/a.md", requestId: "draft-preservation", message}};
  act(() => {for (const listener of listeners) listener(event);});
  expect(await screen.findByText(message)).toBeTruthy();
  await userEvent.setup().click(await screen.findByTestId("notice-center-toggle"));
  const notices = await screen.findByTestId("notice-center");
  expect(within(notices).getAllByText(message)).toHaveLength(1);
  expect(within(notices).getByRole("button", { name: "Details" })).toBeTruthy();
  act(() => {for (const listener of listeners) listener({...event, editRefusal: {...event.editRefusal!, workspaceId: OTHER_WORKSPACE.workspaceId, message: "Wrong workspace draft."}});});
  expect(screen.queryByText("Wrong workspace draft.")).toBeNull();
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

  // The button names the restart, so pressing it restarts at once.
  it("restarts into a ready update from the stop state without asking again", async () => {
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
    await waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("moves a cell write's session with the open editor's in the same step when live sessions reopen", async () => {
    let liveSessionsGeneration = 0;
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(["a.md"], "a.md")));
    bridge.openWorkspace = vi.fn(async () => ({ ...SYNC_STATUS, liveSessionsGeneration }));
    bridge.getSyncStatus = vi.fn(async () => ({ ...SYNC_STATUS, liveSessionsGeneration }));
    // Sessions main holds for a.md. Main refuses a second session for one
    // document, so a write and an editor on different keys collide.
    let live = 0, overlapped = false;
    const openEngineYDocSession = vi.fn(async () => {
      live++; overlapped ||= live > 1;
      return { available: true, initialUpdate: Y.encodeStateAsUpdate(markdownToYDoc("# Doc\n")), lineageGeneration: 1 };
    });
    const closeEngineYDocSession = vi.fn(async () => { live--; });
    Object.assign(bridge, {
      openEngineYDocSession, closeEngineYDocSession,
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({ accepted: true as const, updates: [] })),
    });
    // A cell write to a.md opens the record as CollectionRecordFieldWrite does.
    function CellWrite() {
      useEngineDoc({ workspaceId: WORKSPACE.workspaceId, path: "a.md", enabled: true, reopenKey: useReopenKey(WORKSPACE.workspaceId) });
      return null;
    }
    vi.stubGlobal("dohcDesktop", bridge);
    render(<>
      <CellWrite />
      <DesktopWorkspaceShell workspace={WORKSPACE} workspaces={[WORKSPACE]} {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
    </>);
    await screen.findByTestId("markdown-source-toggle");
    // The write and the editor share one session.
    await waitFor(() => expect(live).toBe(1));
    const opened = openEngineYDocSession.mock.calls.length;
    overlapped = false;
    // dohc restarts its live sessions, as a rebuild or a shared view's refresh does.
    await act(async () => {
      liveSessionsGeneration = 1;
      bridge.emitWorkspaceActivity();
    });
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(opened + 1));
    await waitFor(() => expect(live).toBe(1));
    expect(overlapped).toBe(false);
  });

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
    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
    const copied = await navigator.clipboard.readText();
    expect(copied.split("\n").slice(0, 2)).toEqual([
      "Error: dohc could not move this workspace's data store. dohc does not have permission to use this file or folder.",
      "Cause: Error [EACCES]: EACCES: permission denied",
    ]);
    expect(screen.queryByTestId("engine-rebuild-dialog")).toBeNull();
  });

  // A copy refused from a toast is the newest error, so its own toast takes
  // the place of the toast the button sat in. Try again still copies the
  // details that failed, though the button that failed is gone.
  it("reports a refused copy from a toast and copies the same details on Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => refusedStatus);
    bridge.getSyncStatus = vi.fn(async () => refusedStatus);
    bridge.rebuildEngineStore = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'desktop:rebuild-engine-store': Error [EACCES]: EACCES: permission denied",
      );
    });
    const { user, dialog } = await openRebuildDialog(bridge);
    await user.click(within(dialog).getByRole("button", { name: "Move and rebuild" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Document is not focused."));

    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(COPY_FAILURE),
    );
    await user.click(
      within(screen.getByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1]![0].split("\n")[0]).toBe(
      "Error: dohc could not move this workspace's data store. dohc does not have permission to use this file or folder.",
    );
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

  it("runs a menu command while the workspace could not open", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace.mockRejectedValueOnce(new Error("Watcher failed"));
    renderShell(bridge);
    await screen.findByTestId("workspace-open-failed");
    act(() => bridge.emitMenuCommand("settings"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
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

  // #2887: a shared view goes by what it shares. Whoever reads the report
  // still needs its share id, so Copy keeps it on the line after the name.
  it("copies a shared view's name and its share id when it does not open", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:open-workspace': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    ));
    const user = userEvent.setup();
    renderShell(bridge, { ...SHARE_VIEW, shareView: { ...SHARE_VIEW.shareView!, subjectName: "Trip plans" } });

    const recovery = await screen.findByTestId("workspace-open-failed");
    await user.click(within(recovery).getByRole("button", { name: "Copy details" }));
    const copied = (await navigator.clipboard.readText()).split("\n");
    const name = copied.indexOf("Workspace: Trip plans");
    expect(name).toBeGreaterThan(-1);
    expect(copied[name + 1]).toBe("Share id: share-1");
  });

  it("names the engine folder another user owns, and keeps its path for Copy", async () => {
    const bridge = makeBridge(Promise.resolve(null), "darwin");
    bridge.openWorkspace.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:open-workspace': DaemonRefusalError [INTERNAL]: engine-folder-not-private: other-owner .dohc/engine",
    ));
    const user = userEvent.setup();
    renderShell(bridge);

    const recovery = await screen.findByTestId("workspace-open-failed");
    const words =
      "This workspace's .dohc/engine belongs to another user, so dohc can't keep its History private. " +
      "Make it and everything in it yours again, then try again.";
    expect(recovery.textContent).toContain(words);
    expect(recovery.textContent).not.toMatch(/DaemonRefusalError|INTERNAL|other-owner/);
    await user.click(within(recovery).getByRole("button", { name: "Copy details" }));
    const copied = (await navigator.clipboard.readText()).split("\n");
    expect(copied.slice(0, 3)).toEqual([
      "Error: Couldn't open this workspace",
      `Detail: ${words}`,
      "Cause: DaemonRefusalError [INTERNAL]: engine-folder-not-private: other-owner .dohc/engine",
    ]);
    fireEvent.click(within(recovery).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(2));
  });

  it("stops a workspace macOS refuses, and offers System Settings beside Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null), "darwin");
    bridge.openWorkspace.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:open-workspace': Error [privacy-denied]: EPERM: operation not permitted, opendir '/Users/me/Documents/Trip'",
    ));
    renderShell(bridge);

    const recovery = await screen.findByTestId("workspace-open-failed");
    expect(recovery.textContent).toContain(PRIVACY_DENIED_WORDS);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    fireEvent.click(within(recovery).getByRole("button", { name: "Open System Settings" }));
    expect(bridge.openSystemPrivacySettings).toHaveBeenCalledOnce();
    expect(screen.getByTestId("workspace-open-failed")).toBe(recovery);

    fireEvent.click(within(recovery).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
  });

  it("files a toast with Try again when System Settings does not open", async () => {
    const bridge = makeBridge(Promise.resolve(null), "darwin");
    bridge.openWorkspace.mockRejectedValue(new Error(
      "Error invoking remote method 'desktop:open-workspace': Error [privacy-denied]: EPERM: operation not permitted, opendir '/Users/me/Documents/Trip'",
    ));
    bridge.openSystemPrivacySettings
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'desktop:open-system-privacy-settings': Error: Failed to open URL",
      ))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderShell(bridge);

    const recovery = await screen.findByTestId("workspace-open-failed");
    fireEvent.click(within(recovery).getByRole("button", { name: "Open System Settings" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not open System Settings. Failed to open URL");
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    expect(await navigator.clipboard.readText()).toContain("dohc could not open System Settings.");
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = (await within(await screen.findByTestId("notice-center"))
      .findByText("dohc could not open System Settings. Failed to open URL")).closest("li")!;
    expect(within(row).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();

    await user.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.openSystemPrivacySettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(row.isConnected).toBe(false));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.getByTestId("workspace-open-failed")).toBeTruthy();
  });

  it("offers System Settings on a toast when macOS refuses one read", async () => {
    const bridge = makeBridge(Promise.resolve(null), "darwin");
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:list-workspace-files': DaemonRefusalError [INTERNAL]: privacy-denied",
    ));
    renderShell(bridge);

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(`Could not refresh workspace files. ${PRIVACY_DENIED_WORDS}`);
    fireEvent.click(within(toast).getByTestId("workspace-shell-error-action"));
    expect(bridge.openSystemPrivacySettings).toHaveBeenCalledOnce();
    expect(within(toast).getByTestId("workspace-shell-error-action").textContent).toBe("Open System Settings");

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await waitFor(() => expect(bridge.listWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("retries a failed initial listing without reopening the workspace", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockRejectedValueOnce(new Error("Listing failed"));

    renderShell(bridge);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"),
    );
    await waitFor(() => expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(false));
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
    read: false,
    source: "engine" as const,
    problems: 1,
    atMs: 5_000,
    text: "dohc crash report\n\nTime: 1970-01-01T00:00:05.000Z\nProcess: workspace engine",
  };

  it("offers Details and no Send report when this build has no report server", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    renderShell(bridge);

    const toast = await screen.findByTestId("crash-report-toast");
    expect(toast.textContent).toContain("The workspace engine failed");
    expect(screen.queryByTestId("crash-report-toast-send")).toBeNull();
    expect(screen.getByTestId("crash-report-toast-details").textContent).toBe("Details");

    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("notice-crash-report");
    expect(row.textContent).not.toContain("Send report");
    expect(screen.getByTestId("notice-crash-report-details").textContent).toBe("Details");
    expect(screen.queryByTestId("notice-crash-report-copy")).toBeNull();
    expect(bridge.sendCrashReport).not.toHaveBeenCalled();
  });

  it("offers Send report on the row as on the toast", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: "reports.example.test" });
    bridge.sendCrashReport.mockResolvedValueOnce({ sent: false });
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("notice-crash-report");
    await user.click(within(row).getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(bridge.sendCrashReport).toHaveBeenCalledWith({}));
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
    // Main keeps the report until it is dismissed. Reaching the row to click
    // Dismiss reads it first.
    bridge.dismissCrashReport.mockImplementationOnce(async () => {
      bridge.readCrashReport.mockResolvedValue({ report: null, sendTo: null });
      return undefined;
    });
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

  it("saves a closed toast with main, so the next launch shows only the row", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    const { unmount } = renderShell(bridge);

    bridge.readCrashReport.mockResolvedValue({ report: { ...REPORT, revision: 4, read: true }, sendTo: null });
    await user.click(await screen.findByRole("button", { name: "Close crash report notice" }));
    expect(screen.queryByTestId("crash-report-toast")).toBeNull();
    await waitFor(() => expect(bridge.markCrashReportRead).toHaveBeenCalledWith({ through: 3 }));
    unmount();

    // The next launch reads the report main kept, already read.
    renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    expect((await screen.findByTestId("notice-crash-report")).textContent).toContain("The workspace engine failed");
    expect(screen.queryByTestId("crash-report-toast")).toBeNull();
    expect(screen.queryByTestId("notice-crash-report-unread")).toBeNull();
    expect(bridge.markCrashReportRead).toHaveBeenCalledTimes(1);
  });

  it("saves the report as read when its row is read, and a newer problem toasts again", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    renderShell(bridge);

    await screen.findByTestId("crash-report-toast");
    await user.click(screen.getByTestId("notice-center-toggle"));
    bridge.readCrashReport.mockResolvedValue({ report: { ...REPORT, revision: 4, read: true }, sendTo: null });
    await user.hover(await screen.findByTestId("notice-crash-report"));
    await waitFor(() => expect(bridge.markCrashReportRead).toHaveBeenCalledWith({ through: 3 }));
    // Open Notices hides every toast, so close it to see that this one stays closed.
    await user.click(screen.getByTestId("notice-center-toggle"));
    await waitFor(() => expect(screen.queryByTestId("notice-center")).toBeNull());
    expect(screen.queryByTestId("crash-report-toast")).toBeNull();

    bridge.readCrashReport.mockResolvedValue({
      report: { ...REPORT, revision: 5, through: 4, read: false, source: "window", problems: 2 },
      sendTo: null,
    });
    act(() => bridge.emitCrashReportChanged());
    expect((await screen.findByTestId("crash-report-toast")).textContent).toContain("A dohc window stopped unexpectedly");
  });

  it("shows the toast again and says so when main could not save that it was read, and Try again saves it", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    bridge.markCrashReportRead.mockRejectedValueOnce(
      new Error("Error invoking remote method 'desktop:mark-crash-report-read': Error: EACCES: permission denied"),
    );
    renderShell(bridge);

    await user.click(await screen.findByRole("button", { name: "Close crash report notice" }));
    const error = await screen.findByTestId("workspace-shell-error");
    expect(error.textContent).toContain("dohc could not save that you read the crash report.");
    expect(await screen.findByTestId("crash-report-toast")).toBeTruthy();

    bridge.readCrashReport.mockResolvedValue({ report: { ...REPORT, revision: 4, read: true }, sendTo: null });
    await user.click(within(error).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.markCrashReportRead).toHaveBeenCalledTimes(2));
    expect(bridge.markCrashReportRead).toHaveBeenLastCalledWith({ through: 3 });
    await waitFor(() => expect(screen.queryByTestId("crash-report-toast")).toBeNull());
  });

  it("shows the row unread again when main could not save it, and saves on the next read", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCrashReport.mockResolvedValue({ report: REPORT, sendTo: null });
    bridge.markCrashReportRead.mockRejectedValueOnce(
      new Error("Error invoking remote method 'desktop:mark-crash-report-read': Error: EACCES: permission denied"),
    );
    renderShell(bridge);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.hover(await screen.findByTestId("notice-crash-report"));
    await waitFor(() => expect(bridge.markCrashReportRead).toHaveBeenCalledOnce());
    await screen.findByTestId("notice-crash-report-unread");

    bridge.readCrashReport.mockResolvedValue({ report: { ...REPORT, revision: 4, read: true }, sendTo: null });
    await user.unhover(screen.getByTestId("notice-crash-report"));
    await user.hover(screen.getByTestId("notice-crash-report"));
    await waitFor(() => expect(bridge.markCrashReportRead).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("notice-crash-report-unread")).toBeNull());
  });
});

describe("offline copies a previous account left", () => {
  const none = { workspaces: [], recordUnreadable: false, sweepPending: false };
  const removeFailure = "dohc could not remove offline copies of Collections from a previous account.";
  // Try again closes Notices, so each row is read from Notices opened again.
  async function rowOf(user: ReturnType<typeof userEvent.setup>, text: string) {
    await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0));
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    return (await within(screen.getByTestId("notice-center")).findByText(text)).closest("li")!;
  }

  it("names the workspaces that still hold them, with Try again and Copy", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);
    await waitFor(() => expect(bridge.readCollectionCopiesLeft).toHaveBeenCalledOnce());
    // The sign-out's cleanup fails after the shell opened, and main says so.
    bridge.readCollectionCopiesLeft.mockResolvedValue({ ...none, workspaces: ["/Users/ana/Trip", "/Users/ana/Fundraiser"] });
    act(() => bridge.emitCollectionCopiesLeftChanged());
    const message = `${removeFailure} They are still in Trip and Fundraiser.`;
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(message);
    const row = await rowOf(user, message);
    expect(within(row).getByRole("button", { name: "Details" })).toBeTruthy();
    // Try again that still leaves one says which, and one that removes them all ends the row.
    bridge.removeCollectionCopiesLeft.mockResolvedValueOnce({ ...none, workspaces: ["/Users/ana/Trip"] });
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    const left = `${removeFailure} They are still in Trip.`;
    const again = await rowOf(user, left);
    expect(screen.queryByText(message)).toBeNull();
    const removed = deferred<typeof none>();
    bridge.removeCollectionCopiesLeft.mockImplementationOnce(() => removed.promise);
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await act(async () => removed.resolve(none));
    expect(bridge.removeCollectionCopiesLeft).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(left)).toBeNull();
    // A later account change that removes them ends a row too.
    bridge.readCollectionCopiesLeft.mockResolvedValue({ ...none, workspaces: ["/Users/ana/Trip"] });
    act(() => bridge.emitCollectionCopiesLeftChanged());
    await rowOf(user, left);
    bridge.readCollectionCopiesLeft.mockResolvedValue(none);
    act(() => bridge.emitCollectionCopiesLeftChanged());
    await waitFor(() => expect(screen.queryByText(left)).toBeNull());
  });

  it("says when dohc could not read its record of them or check every workspace, until Try again does", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.readCollectionCopiesLeft.mockResolvedValue({ ...none, recordUnreadable: true, sweepPending: true });
    renderShell(bridge);
    const row = await rowOf(user, "dohc could not read its list of offline copies of Collections to remove, or check every workspace for them. Some may still be on this computer.");
    bridge.removeCollectionCopiesLeft.mockResolvedValueOnce({ ...none, workspaces: ["/Users/ana/Trip"], sweepPending: true });
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    const both = await rowOf(user, `${removeFailure} They are still in Trip. dohc also could not check every workspace for offline copies of Collections from a previous account.`);
    bridge.removeCollectionCopiesLeft.mockResolvedValueOnce({ ...none, sweepPending: true });
    await user.click(within(both).getByRole("button", { name: "Try again" }));
    const unchecked = await rowOf(user, "dohc could not check every workspace for offline copies of Collections from a previous account. Some may still be on this computer.");
    bridge.removeCollectionCopiesLeft.mockResolvedValueOnce(none);
    await user.click(within(unchecked).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.removeCollectionCopiesLeft).toHaveBeenCalledTimes(3));
    await act(async () => undefined);
    expect(screen.queryByText(/could not check every workspace/)).toBeNull();
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
    extra: { sentNotices?: SentNotices; openOnReady?: NoticeTarget; onSwitchWorkspace?: (workspace: Workspace, open?: NoticeTarget) => void; workspace?: Workspace },
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

  // A note with parts dohc can't show, so its band appears.
  const LOSSY_NOTE = ["# Readme", "", "<details>", "<summary>More</summary>", "", "Hidden.", "</details>", ""].join("\n");

  it("keeps a held change's band after its Notice is dismissed, because the band reads the engine's hold", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.readWorkspaceText.mockImplementation(async () => ({ text: LOSSY_NOTE, truncated: false as const, contentHash: "a".repeat(64) }));
    bridge.readHeldChange.mockImplementation(async ({ path }) => ({ change: { path, file: LOSSY_NOTE, held: `${LOSSY_NOTE}More.\n` } }));
    // No Notice row names the hold: it was dismissed, and the hold remains.
    renderWithNotices(bridge, { sentNotices: sentNotices([]) });
    const band = await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(band.textContent).toContain("dohc held a change"));
    // Only the open note's hold is read, never every hold in the workspace.
    expect(bridge.readHeldChange).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, path: "b.md" });
    expect(new Set(bridge.readHeldChange.mock.calls.map(([request]) => request.path))).toEqual(new Set(["b.md"]));
  });

  it("reads no hold when the workspace opens on a note dohc can show", async () => {
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    renderWithNotices(bridge, { sentNotices: sentNotices([]) });
    await screen.findByTestId("markdown-editor");
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
    expect(bridge.readHeldChange).not.toHaveBeenCalled();
  });

  it("clears a note's held band when the engine no longer holds its change", async () => {
    let listener: () => void = () => {};
    const bridge = Object.assign(makeBridge(Promise.resolve(STORED_STATE)), {
      onNoticesChanged: vi.fn((next: () => void) => { listener = next; return () => {}; }),
    });
    bridge.readWorkspaceText.mockImplementation(async () => ({ text: LOSSY_NOTE, truncated: false as const, contentHash: "a".repeat(64) }));
    bridge.readHeldChange.mockImplementation(async ({ path }) => ({ change: { path, file: LOSSY_NOTE, held: `${LOSSY_NOTE}More.\n` } }));
    renderWithNotices(bridge, { sentNotices: sentNotices([]) });
    const band = await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(band.textContent).toContain("dohc held a change"));
    bridge.readHeldChange.mockImplementation(async () => ({ change: null }));
    act(() => listener());
    await waitFor(() => expect(screen.getByTestId("lossy-note-notice").textContent).not.toContain("dohc held a change"));
  });

  it("keeps a held Notice dismissed after the Notice list updates", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    const shown: NoticeRow = { ...MENTION, store: "local", kind: "markdown-write-held", noticeId: "held",
      body: "A note needs review before saving" };
    const notices = sentNotices([shown]);
    const view = renderWithNotices(bridge, { sentNotices: notices });
    await screen.findByTestId("workspace-shell-notice");
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("notice-held-dismiss"));
    expect(notices.dismiss).toHaveBeenCalledExactlyOnceWith(shown);
    view.rerender(<>
      <CollectionFieldWriteHost />
      <DesktopWorkspaceShell workspace={WORKSPACE} workspaces={[WORKSPACE]}
        {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}}
        sentNotices={{ ...notices, notices: [] }} />
    </>);
    await waitFor(() => expect(screen.queryByTestId("workspace-shell-notice")).toBeNull());
    expect(screen.queryByTestId("notice-held")).toBeNull();
    expect(notices.dismiss).toHaveBeenCalledTimes(1);
  });

  it("clears a row's unread mark when the pointer reaches it, and brings it back when main cannot mark it", async () => {
    const user = userEvent.setup();
    const marking = deferred<undefined>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      listNotices: vi.fn(async () => ({ account: null, notices: [MENTION] })),
      onNoticesChanged: vi.fn(() => () => {}),
      markNotices: vi.fn(() => marking.promise),
    });
    const bootstrap = shellBootstrapProps(bridge);
    function WithSentNotices() {
      const sent = useSentNotices(true);
      return <DesktopWorkspaceShell workspace={WORKSPACE} workspaces={[WORKSPACE]} {...bootstrap}
        onSwitchWorkspace={() => {}} sentNotices={sent} />;
    }
    vi.stubGlobal("dohcDesktop", bridge);
    render(<><CollectionFieldWriteHost /><WithSentNotices /></>);

    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = await screen.findByTestId("sent-notice-mention:1");
    expect(screen.getByTestId("sent-notice-mention:1-unread")).toBeTruthy();
    fireEvent.pointerEnter(row);
    expect(screen.queryByTestId("sent-notice-mention:1-unread")).toBeNull();
    expect(screen.getByTestId("notice-center-toggle").getAttribute("aria-label")).toBe("Notices");
    expect(bridge.markNotices).toHaveBeenCalledExactlyOnceWith({
      account: null, mark: "read", notices: [{ store: "account", noticeId: "mention:1" }],
    });

    await act(async () => marking.reject(new Error("disk full")));
    await waitFor(() => expect(screen.getByTestId("sent-notice-mention:1-unread")).toBeTruthy());
    const failed = (await within(screen.getByTestId("notice-center")).findByText(/^dohc could not mark notices read\./)).closest("li")!;
    expect(within(failed).getByRole("button", { name: "Try again" })).toBeTruthy();
    // Open Notices hides toasts; the failure's toast shows once it closes.
    await user.click(screen.getByTestId("notice-center-toggle"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(/^dohc could not mark notices read\./)).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(bridge.markNotices).toHaveBeenCalledOnce();
  });

  const HELD: NoticeRow = { ...MENTION, store: "local", kind: "markdown-write-held", noticeId: "held", senderKind: null,
    title: "Held a change to b.md", body: "Saving it would also change parts dohc can't show." };

  it.each([
    ["a sync refusal", { ...MENTION, store: "local", kind: "sync-refusal", noticeId: "refusal", senderKind: null,
      body: "A change needs review", refusalCoordinates: [{ originId: "peer", originSeq: 1 }] } satisfies NoticeRow],
    ["a held change", HELD],
  ])("shows %s unread again when main cannot mark it read, and Try again sends the same read", async (_, shown) => {
    const user = userEvent.setup();
    const marking = deferred<undefined>();
    let readAtMs: number | null = null;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      listNotices: vi.fn(async () => ({ account: null, notices: [{ ...shown, readAtMs }] })),
      onNoticesChanged: vi.fn(() => () => {}),
      markNotices: vi.fn(() => marking.promise),
    });
    const bootstrap = shellBootstrapProps(bridge);
    function WithSentNotices() {
      const sent = useSentNotices(true);
      return <DesktopWorkspaceShell workspace={WORKSPACE} workspaces={[WORKSPACE]} {...bootstrap}
        onSwitchWorkspace={() => {}} sentNotices={sent} />;
    }
    vi.stubGlobal("dohcDesktop", bridge);
    render(<><CollectionFieldWriteHost /><WithSentNotices /></>);
    const unread = `notice-${shown.noticeId}-unread`;
    const read = { account: null, mark: "read", notices: [expect.objectContaining({ store: "local", noticeId: shown.noticeId })] };

    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = await screen.findByTestId(`notice-${shown.noticeId}`);
    expect(screen.getByTestId(unread)).toBeTruthy();
    fireEvent.pointerEnter(row);
    expect(screen.queryByTestId(unread)).toBeNull();
    expect(bridge.markNotices).toHaveBeenCalledExactlyOnceWith(read);

    await act(async () => marking.reject(new Error("disk full")));
    await waitFor(() => expect(screen.getByTestId(unread)).toBeTruthy());
    const failed = (await within(screen.getByTestId("notice-center")).findByText(/^dohc could not mark this Notice read\./)).closest("li")!;
    bridge.markNotices.mockImplementationOnce(async () => { readAtMs = 9_000; return undefined; });
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId(unread)).toBeNull());
    expect(bridge.markNotices).toHaveBeenCalledTimes(2);
    expect(bridge.markNotices).toHaveBeenLastCalledWith(read);
    expect(screen.queryByText(/^dohc could not mark this Notice read\./)).toBeNull();
  });

  it("keeps a held change's row unread when its toast closes", async () => {
    const user = userEvent.setup();
    const notices = sentNotices([HELD]);
    renderWithNotices(makeBridge(Promise.resolve(null)), { sentNotices: notices });
    const toast = await screen.findByTestId("workspace-shell-notice");
    await user.click(within(toast).getByRole("button", { name: "Dismiss workspace notice" }));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(notices.read).not.toHaveBeenCalled();
    expect(screen.getByTestId("notice-center-toggle").getAttribute("aria-label")).toBe("Notices, 1 unread");
  });

  it("reads a held change's row on Open note", async () => {
    const user = userEvent.setup();
    const notices = sentNotices([HELD]);
    renderWithNotices(makeBridge(Promise.resolve(null)), { sentNotices: notices });
    const toast = await screen.findByTestId("workspace-shell-notice");
    await user.click(within(toast).getByRole("button", { name: "Open note" }));
    await screen.findByTestId("tab-b.md");
    expect(notices.read).toHaveBeenCalledExactlyOnceWith([HELD]);
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(screen.getByTestId("notice-center-toggle").getAttribute("aria-label")).toBe("Notices");
  });

  it("opens a mention's file from its row, reads it and closes Notices", async () => {
    const user = userEvent.setup();
    const notices = sentNotices([MENTION]);
    renderWithNotices(makeBridge(Promise.resolve(null)), { sentNotices: notices });
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("sent-notice-mention:1-open-row"));
    await screen.findByTestId("tab-b.md");
    expect(notices.read).toHaveBeenCalledWith([{ store: "account", noticeId: "mention:1" }]);
    await waitFor(() => expect(screen.queryByTestId("notice-center")).toBeNull());
  });

  it("says in place that a mention's file is gone, opening nothing", async () => {
    const user = userEvent.setup();
    const gone: NoticeRow = { ...MENTION, target: { path: "gone.md" } };
    renderWithNotices(makeBridge(Promise.resolve(null)), { sentNotices: sentNotices([gone]) });
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("sent-notice-mention:1-open-row"));
    const row = screen.getByTestId("sent-notice-mention:1");
    expect(await within(row).findByText("dohc could not find this file.")).toBeTruthy();
    expect(screen.queryByTestId("tab-gone.md")).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(screen.queryByTestId("sent-notice-mention:1-open-row")).toBeNull();
  });

  it("keeps a read held change read, with no toast, when dohc starts again", async () => {
    const user = userEvent.setup();
    renderWithNotices(makeBridge(Promise.resolve(null)), { sentNotices: sentNotices([{ ...HELD, readAtMs: 6_000 }]) });
    const toggle = await screen.findByTestId("notice-center-toggle");
    await user.click(toggle);
    await screen.findByTestId("notice-held");
    expect(screen.queryByTestId("notice-held-unread")).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("Notices");
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
  });

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
    expect(onSwitchWorkspace).toHaveBeenCalledWith(trip, { to: "file", path: "Japan/day-1.md" });
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
      trigger: { kind: "changed", recordId: "rec_1", by: "human", sharedAuthor: null, depth: 0 }, writes: [], definitionChanged: false, neverStarted: false, chainStopped: false, undoUnfinished: false, undone: false,
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
    renderWithNotices(makeBridge(Promise.resolve(null)), { openOnReady: { to: "file", path: "b.md" } });
    await screen.findByTestId("tab-b.md");
  });

  // Chats' answer for a Group invitation, share-1, that waits with Join.
  const INVITATION_LISTING = {
    joined: [],
    sessionKey: null,
    relay: {
      state: "answered" as const,
      granted: [],
      received: [{ shareId: "share-1", channelWireId: "wire-share-1", access: "read-write" as const, granterEmail: "owner@example.com" }],
      removed: [],
    },
  };

  it("opens Chats at a Group invitation, with its Join focused, once the workspace it switched to is ready", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    Object.assign(bridge, { listChatChannelShares: vi.fn(async () => INVITATION_LISTING) });
    renderWithNotices(bridge, { openOnReady: { to: "chats-invitation", shareId: "share-1", inputs: inputCount() } });
    await waitFor(() => expect(screen.getByTestId("activity-chats").getAttribute("aria-current")).toBe("page"));
    const join = await screen.findByTestId("chats-join-shared");
    await waitFor(() => expect(document.activeElement).toBe(join));
  });

  it.each([
    ["leaves Chats", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByTestId("activity-explorer"));
      await user.click(screen.getByTestId("activity-chats"));
    }],
    ["types", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("a")],
    ["leaves the window", async () => {
      fireEvent.blur(window);
    }],
    ["picks a menu bar command", async (_user: ReturnType<typeof userEvent.setup>, bridge: ReturnType<typeof makeBridge>) => {
      act(() => bridge.emitMenuCommand("command-palette"));
    }],
  ])("drops the invitation's reveal when the person %s before Chats lists it", async (_, moveOn) => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    // Every share read, including the one each reveal makes, waits until the
    // person has moved on.
    const listed = deferred<typeof INVITATION_LISTING>();
    Object.assign(bridge, { listChatChannelShares: vi.fn(() => listed.promise) });
    renderWithNotices(bridge, { openOnReady: { to: "chats-invitation", shareId: "share-1", inputs: inputCount() } });
    await waitFor(() => expect(screen.getByTestId("activity-chats").getAttribute("aria-current")).toBe("page"));
    await moveOn(user, bridge);
    listed.resolve(INVITATION_LISTING);
    const join = await screen.findByTestId("chats-join-shared");
    expect(join.getAttribute("data-invitation")).toBe("share-1");
    // Runs Chats' pending effects, where a live reveal would focus Join.
    await act(async () => undefined);
    expect(document.activeElement).not.toBe(join);
  });

  it("drops the invitation's reveal when the person typed after pressing Open, before the workspace it switched to was ready", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge(Promise.resolve(null));
    Object.assign(bridge, { listChatChannelShares: vi.fn(async () => INVITATION_LISTING) });
    const pressed = inputCount();
    await user.keyboard("a");
    renderWithNotices(bridge, { openOnReady: { to: "chats-invitation", shareId: "share-1", inputs: pressed } });
    await waitFor(() => expect(screen.getByTestId("activity-chats").getAttribute("aria-current")).toBe("page"));
    const join = await screen.findByTestId("chats-join-shared");
    expect(join.getAttribute("data-invitation")).toBe("share-1");
    // Runs Chats' pending effects, where a live reveal would focus Join.
    await act(async () => undefined);
    expect(document.activeElement).not.toBe(join);
  });

  it("opens a file the OS opened with dohc in this workspace, each time main sends it", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderWithNotices(bridge, {});
    // Main can send it before this workspace is ready; it opens once it is.
    act(() => bridge.emitWorkspaceActivated({ ...WORKSPACE, workspaceId: "ws-other" }, "other.md"));
    act(() => bridge.emitWorkspaceActivated(WORKSPACE, "b.md"));
    await screen.findByTestId("tab-b.md");
    expect(screen.queryByTestId("tab-other.md")).toBeNull();
    act(() => bridge.emitMenuCommand("close-tab"));
    await waitFor(() => expect(screen.queryByTestId("tab-b.md")).toBeNull());
    act(() => bridge.emitWorkspaceActivated(WORKSPACE, "b.md"));
    await screen.findByTestId("tab-b.md");
  });

  it("hears a file main sends while it answers this workspace's open, before the reply", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    // Main's open handler sends the file, then replies. A listener that the
    // shell installed only after the reply would miss it.
    bridge.openWorkspace.mockImplementation(async () => {
      bridge.emitWorkspaceActivated(WORKSPACE, "b.md");
      return SYNC_STATUS;
    });
    renderWithNotices(bridge, {});
    await screen.findByTestId("tab-b.md");
    expect(bridge.openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("opens no runs for a notice whose Open was cancelled while main looked the automation up", async () => {
    const user = userEvent.setup();
    const bridge = withRuns(makeBridge(Promise.resolve(null)));
    const found = deferred<{ status: "found"; collectionPath: string }>();
    bridge.findAutomationCollection.mockReturnValueOnce(found.promise);
    renderWithNotices(bridge, { sentNotices: sentNotices([FAILED("first", "atc_first")]) });
    await user.click(await screen.findByTestId("notice-center-toggle"));
    await user.click(await screen.findByTestId("sent-notice-automation-failed:first-open"));
    // Closing Notices cancels the Open.
    await user.click(screen.getByTestId("notice-center-toggle"));
    await act(async () => found.resolve({ status: "found", collectionPath: "tasks" }));
    expect(screen.queryByTestId("tab-dohc://collection/tasks")).toBeNull();
  });

  it("offers Try again when it cannot open a switched-off automation once the workspace is ready", async () => {
    const user = userEvent.setup();
    const bridge = withRuns(makeBridge(Promise.resolve(null)));
    bridge.findAutomationCollection.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    renderWithNotices(bridge, { openOnReady: { to: "automation-controls", automation: "collection:tasks#first" } as const });
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not open this automation.");
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("tab-dohc://collection/tasks")).toBeTruthy();
    expect(bridge.findAutomationCollection).toHaveBeenCalledTimes(2);
  });

  it("opens a switched-off automation's switch once the workspace it switched to is ready", async () => {
    const bridge = withRuns(makeBridge(Promise.resolve(null)));
    const automation = {
      id: "first", name: "Stamp the date", enabled: false, when: { kind: "record-added" as const, table: null }, if: null,
      do: [{ kind: "set" as const, values: [{ field: "Done", value: { kind: "literal" as const, value: true } }], records: null, operation: null }],
    };
    bridge.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "a".repeat(64), addsStay: [], automations: [{
      valid: true, automationId: "collection:tasks#first", automation, definitionHash: "0123456789abcdef", cannotRun: null,
      reach: { kind: "checked", steps: [{ verdict: "allowed" }] }, lastRun: null,
    }] });
    renderWithNotices(bridge, { openOnReady: { to: "automation-controls", automation: "collection:tasks#first" } as const });
    expect(await screen.findByTestId("tab-dohc://collection/tasks")).toBeTruthy();
    const toggle = within(await screen.findByTestId("automation-first", undefined, { timeout: 15_000 })).getByRole("switch");
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(bridge.findAutomationCollection).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, automationId: "collection:tasks#first" });
    expect(bridge.listCollectionAutomationRuns).not.toHaveBeenCalled();
  });

  it("opens a switched-off automation's switch next to the saved tabs once they apply", async () => {
    const stored = deferred<WorkspaceUiState | null>();
    const bridge = withRuns(makeBridge(stored.promise));
    renderWithNotices(bridge, { openOnReady: { to: "automation-controls", automation: "collection:tasks#first" } as const });
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    await act(async () => undefined);
    expect(bridge.findAutomationCollection).not.toHaveBeenCalled();

    await act(async () => {
      stored.resolve(STORED_STATE);
      await stored.promise;
    });

    expect(await screen.findByTestId("tab-dohc://collection/tasks")).toBeTruthy();
    expect(screen.getByTestId("tab-b.md")).toBeTruthy();
  });

  describe("through an Edit share view", () => {
    const EDIT_VIEW: Workspace = { ...WORKSPACE, shareView: { shareId: "share-1", granterEmail: "owner@dohc.test", access: "edit" } };
    const SWITCHED_OFF = { to: "automation-controls", automation: "collection:object-tasks#first", sharedFile: "tasks/automations.yaml" } as const;
    const automation = {
      id: "first", name: "Stamp the date", enabled: false, when: { kind: "record-added" as const, table: null }, if: null,
      do: [{ kind: "set" as const, values: [{ field: "Done", value: { kind: "literal" as const, value: true } }], records: null, operation: null }],
    };

    it("opens a switched-off automation's switch in the shared panel", async () => {
      const bridge = withRuns(makeBridge(Promise.resolve(null)));
      bridge.resolveAutomationControls.mockResolvedValue({ status: "found", collectionPath: "tasks", automation: "first" });
      bridge.listCollectionAutomations.mockResolvedValue({ status: "shared", definitions: {
        file: { status: "read", entries: [{ status: "valid", automation, enabledInFile: false, canSwitch: true }] },
        contentHash: "a".repeat(64), canSwitch: true, sync: "accepted",
      } });
      renderWithNotices(bridge, { openOnReady: SWITCHED_OFF, workspace: EDIT_VIEW });
      expect(await screen.findByTestId("tab-dohc://collection/tasks")).toBeTruthy();
      const toggle = within(await screen.findByTestId("automation-first", undefined, { timeout: 15_000 })).getByRole("switch");
      await waitFor(() => expect(document.activeElement).toBe(toggle));
      expect(bridge.resolveAutomationControls).toHaveBeenCalledWith({
        workspaceId: EDIT_VIEW.workspaceId, path: "tasks/automations.yaml", automationId: "collection:object-tasks#first",
      });
      expect(bridge.findAutomationCollection).not.toHaveBeenCalled();
      expect(bridge.listCollectionAutomationRuns).not.toHaveBeenCalled();
    });

    it("opens automations.yaml when the shared panel cannot show the automation", async () => {
      const bridge = withRuns(makeBridge(Promise.resolve(null)));
      renderWithNotices(bridge, { openOnReady: SWITCHED_OFF, workspace: EDIT_VIEW });
      expect(await screen.findByTestId("tab-tasks/automations.yaml")).toBeTruthy();
      expect(screen.queryByTestId("tab-dohc://collection/tasks")).toBeNull();
    });

    it("opens automations.yaml when main cannot look the automation up", async () => {
      const bridge = withRuns(makeBridge(Promise.resolve(null)));
      bridge.resolveAutomationControls.mockRejectedValue(new Error("The workspace engine is not running."));
      renderWithNotices(bridge, { openOnReady: SWITCHED_OFF, workspace: EDIT_VIEW });
      expect(await screen.findByTestId("tab-tasks/automations.yaml")).toBeTruthy();
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    });

    it("lets a later Open win over an earlier one still waiting on main", async () => {
      const user = userEvent.setup();
      const bridge = withRuns(makeBridge(Promise.resolve(null)));
      const first = deferred<ResolveAutomationControlsResult>();
      bridge.resolveAutomationControls.mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ status: "found", collectionPath: "chores", automation: "second" });
      const later: NoticeRow = {
        ...MENTION, noticeId: "automation-failed:second", kind: "automation-failed", senderKind: "automation", workspaceId: null,
        recipientShareId: "share-1", title: 'Automation "second" switched off',
        target: { recovery: "automation-controls", automation: "collection:object-chores#second", path: "chores/automations.yaml" },
      };
      renderWithNotices(bridge, { openOnReady: SWITCHED_OFF, workspace: EDIT_VIEW, sentNotices: sentNotices([later]) });
      await waitFor(() => expect(bridge.resolveAutomationControls).toHaveBeenCalledTimes(1));
      await user.click(await screen.findByTestId("notice-center-toggle"));
      await user.click(await screen.findByTestId("sent-notice-automation-failed:second-open"));
      expect(await screen.findByTestId("tab-dohc://collection/chores")).toBeTruthy();
      await act(async () => first.resolve({ status: "found", collectionPath: "tasks", automation: "first" }));
      expect(screen.queryByTestId("tab-dohc://collection/tasks")).toBeNull();
      expect(screen.queryByTestId("tab-tasks/automations.yaml")).toBeNull();
    });

    it("opens automations.yaml in a share view that shows no Collections", async () => {
      const bridge = withRuns(makeBridge(Promise.resolve(null)));
      bridge.resolveAutomationControls.mockResolvedValue({ status: "found", collectionPath: "tasks", automation: "first" });
      const view: Workspace = { ...WORKSPACE, shareView: { shareId: "share-1", granterEmail: "owner@dohc.test", access: "view" } };
      renderWithNotices(bridge, { openOnReady: SWITCHED_OFF, workspace: view });
      expect(await screen.findByTestId("tab-tasks/automations.yaml")).toBeTruthy();
      expect(screen.queryByTestId("tab-dohc://collection/tasks")).toBeNull();
    });
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
      await waitFor(() => expect(onSwitchWorkspace).toHaveBeenCalledWith(VIEW, { to: "file", path: "Trips/Japan/report.md" }));
    });

    it("opens it as its own workspace on a switched-off automation's switch", async () => {
      const user = userEvent.setup();
      const bridge = shareBridge("edit");
      const onSwitchWorkspace = vi.fn();
      const switchedOff: NoticeRow = { ...THROUGH_SHARE, kind: "automation-failed",
        target: { recovery: "automation-controls", automation: "collection:object-tasks#stamp", path: "Trips/tasks/automations.yaml" } };
      renderWithNotices(bridge, { sentNotices: sentNotices([switchedOff]), onSwitchWorkspace });

      await user.click(await screen.findByTestId("notice-center-toggle"));
      await user.click(await screen.findByTestId("sent-notice-mention:1-open"));
      const start = await screen.findByTestId("open-share-start");
      await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
      await user.click(start);
      await waitFor(() => expect(onSwitchWorkspace).toHaveBeenCalledWith(VIEW, {
        to: "automation-controls", automation: "collection:object-tasks#stamp", sharedFile: "Trips/tasks/automations.yaml",
      }));
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
  // skipped again: the notice names each one and offers no Try again.
  it("offers no Try again when an import brings nothing", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [],
      skipped: 2,
      skippedSources: [{ path: "CON.md", reason: "windows-name" }, { path: "key.txt", reason: "link" }],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toBe(
      "2 files weren't imported" +
      "CON.md has a name Windows can't use. Rename it, then import it.\n" +
      "key.txt is a link. Drop the file it leads to." +
      "Details",
    );
    expect(within(toast).queryByTestId("workspace-shell-error-retry")).toBeNull();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(notices.textContent).toContain("2 files weren't imported");
    expect(notices.textContent).toContain("key.txt is a link.");
    expect(within(notices).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says what a palette import landed and what it skipped", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["a.md", "b.md", "c.md"],
      skipped: 2,
      skippedSources: [{ path: ".DS_Store", reason: "system-file" }, { path: "notes.md", reason: "unreadable" }],
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toBe(
      "Imported 3 files. 2 weren't imported." +
      ".DS_Store is a file the system makes.\n" +
      "notes.md couldn't be read. Check that you can open it, then import it again." +
      "Details",
    );
    expect(within(toast).queryByTestId("workspace-shell-error-retry")).toBeNull();
  });

  // A notice holds 500 characters, so the lines stop there and count the
  // rest. Copy names every skipped file the result lists.
  it("counts the skipped files a notice has no room for, and copies them all", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const skippedSources = Array.from({ length: 100 }, (_, i) => ({ path: `Trip/photos/key-${i}.txt`, reason: "link" as const }));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({ imported: [], skipped: 250, skippedSources });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    await user.click(within(toast).getByTestId("workspace-shell-toast-more"));
    const body = toast.querySelector("p")!.textContent!;
    const lines = body.split("\n");
    expect(lines[0]).toBe("Trip/photos/key-0.txt is a link. Drop the file it leads to.");
    expect(body.length).toBeLessThanOrEqual(500);
    // The count sits after the whole list.
    within(toast).getByText(`${250 - lines.length} more weren't imported.`);

    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
    const text = await navigator.clipboard.readText();
    expect(text).toContain("Skipped: Trip/photos/key-99.txt is a link. Drop the file it leads to.");
    expect(text).toContain("Skipped: 150 more");
  });

  // Under the opening cover the workbench is inert and the Explorer shows
  // Home, which takes no drop. jsdom ignores inert, so wait for the cover to
  // lift before dropping.
  async function dropFromOs(bridge: ReturnType<typeof makeBridge>, paths: string[]) {
    bridge.getDroppedFilePaths.mockReturnValue(paths);
    await waitFor(() => expect(screen.getByTestId("workspace-workbench").hasAttribute("inert")).toBe(false));
    const tree = await screen.findByTestId("file-tree");
    fireEvent.drop(tree, { dataTransfer: { files: [new File([], "dropped")], types: ["Files"] } });
  }

  // The Explorer shows what landed, so the only message is about the skip.
  it("says only what a drop skipped", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["a.md"],
      skipped: 2,
      skippedSources: [{ path: "b.md", reason: "link" }, { path: "c.md", reason: "link" }],
    });
    renderShell(bridge);

    await dropFromOs(bridge, ["/outside/a.md", "/outside/b.md", "/outside/c.md"]);
    await waitFor(() => expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({
      workspaceId: "ws-shell-test", droppedPaths: ["/outside/a.md", "/outside/b.md", "/outside/c.md"],
    }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("2 files weren't imported");
    expect(toast.textContent).toContain("c.md is a link. Drop the file it leads to.");
    expect(toast.textContent).not.toContain("Imported");
    expect(within(toast).queryByTestId("workspace-shell-error-retry")).toBeNull();
  });

  // Folders that landed are progress: the same drop again would land beside
  // them, so the notice names them and the Explorer shows them.
  it("names the folders a stopped drop created, and refreshes the Explorer", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [],
      skipped: 0,
      interrupted: true,
      folders: ["Trip"],
      stop: { file: "Trip/sub/a.md", refusal: "changed" },
    });
    renderShell(bridge);
    await screen.findByTestId("file-tree");
    const listings = bridge.listWorkspaceFiles.mock.calls.length;

    await dropFromOs(bridge, ["/outside/Trip"]);
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "Created 1 folder before the import stopped. dohc did not import a.md, because a file or folder changed while dohc copied it. Delete the empty folders before you import again.",
    );
    await waitFor(() => expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(listings));
  });

  // The contract refuses the payload, so the shell says why first.
  it("refuses more than 100 dropped items with the limit", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    renderShell(bridge);

    await dropFromOs(bridge, Array.from({ length: 101 }, (_, i) => `/outside/f-${i}.md`));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "Could not import files. dohc imports up to 100 dropped items at once. Drop fewer at a time.",
    );
    expect(bridge.importWorkspaceFiles).not.toHaveBeenCalled();
  });

  const IMPORT_FILES_ENTRY = { kind: "item" as const, label: "Import files…", id: "import-files" as const };

  function sharedViewBridge(refreshOk: boolean[]) {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "notes/a.md", kind: "file" }], folders: ["notes"] });
    bridge.readExplorerMenu.mockResolvedValue([IMPORT_FILES_ENTRY]);
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
    fireEvent.click(await screen.findByTestId("explorer-menu-item-import-files"));
    await waitFor(() =>
      expect(bridge.importWorkspaceFiles).toHaveBeenCalledWith({ workspaceId: "ws-shell-test", targetDir: "notes" }),
    );
  }

  it("opens the folder an Explorer import landed in and selects the new files, with no toast", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const listing = (files: string[]) => ({
      visibility: { status: "ready" as const, rules: [] },
      files: files.map((path) => ({ path, kind: "file" as const })),
      folders: ["notes"],
    });
    bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes/a.md"]));
    bridge.readExplorerMenu.mockResolvedValue([IMPORT_FILES_ENTRY]);
    bridge.importWorkspaceFiles.mockImplementationOnce(async () => {
      bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes/a.md", "notes/b.md", "notes/c.md"]));
      return { imported: ["notes/b.md", "notes/c.md"], skipped: 0 };
    });
    renderShell(bridge);

    await importIntoNotes(bridge);
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe("notes/b.md"));
    const selected = screen.getAllByTestId("tree-row")
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.dataset.path);
    expect(selected).toEqual(["notes/b.md", "notes/c.md"]);
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("selects a dropped empty folder, which lands no file", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const listing = (folders: string[]) => ({
      visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "notes/a.md", kind: "file" as const }],
      folders,
    });
    bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes"]));
    bridge.readExplorerMenu.mockResolvedValue([IMPORT_FILES_ENTRY]);
    bridge.importWorkspaceFiles.mockImplementationOnce(async () => {
      bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes", "notes/Empty"]));
      return { imported: [], skipped: 0, folders: ["notes/Empty"] };
    });
    renderShell(bridge);

    await importIntoNotes(bridge);
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe("notes/Empty"));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
  });

  it("keeps the newer import's selection when an older import finishes later", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const listing = (files: string[]) => ({
      visibility: { status: "ready" as const, rules: [] },
      files: files.map((path) => ({ path, kind: "file" as const })),
      folders: ["notes"],
    });
    bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes/a.md"]));
    bridge.readExplorerMenu.mockResolvedValue([IMPORT_FILES_ENTRY]);
    let finishOlder!: (result: { imported: string[]; skipped: number }) => void;
    bridge.importWorkspaceFiles
      .mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }))
      .mockImplementationOnce(async () => {
        bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes/a.md", "notes/b.md", "notes/c.md"]));
        return { imported: ["notes/c.md"], skipped: 0 };
      });
    renderShell(bridge);

    await importIntoNotes(bridge);
    await importIntoNotes(bridge);
    await waitFor(() => expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe("notes/c.md"));
    const listings = bridge.listWorkspaceFiles.mock.calls.length;

    finishOlder({ imported: ["notes/b.md"], skipped: 0 });
    await waitFor(() => expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(listings));
    await act(async () => {});
    const selected = screen.getAllByTestId("tree-row")
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.dataset.path);
    expect(selected).toEqual(["notes/c.md"]);
    expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe("notes/c.md");
  });

  it("still selects an Explorer import's files after a palette import starts and is cancelled", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const listing = (files: string[]) => ({
      visibility: { status: "ready" as const, rules: [] },
      files: files.map((path) => ({ path, kind: "file" as const })),
      folders: ["notes"],
    });
    bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes/a.md"]));
    bridge.readExplorerMenu.mockResolvedValue([IMPORT_FILES_ENTRY]);
    let finishExplorer!: (result: { imported: string[]; skipped: number }) => void;
    bridge.importWorkspaceFiles
      .mockImplementationOnce(() => new Promise((resolve) => { finishExplorer = resolve; }))
      .mockResolvedValueOnce({ imported: [], skipped: 0 });
    const user = userEvent.setup();
    renderShell(bridge);

    await importIntoNotes(bridge);
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    await waitFor(() => expect(bridge.importWorkspaceFiles).toHaveBeenCalledTimes(2));

    bridge.listWorkspaceFiles.mockResolvedValue(listing(["notes/a.md", "notes/b.md"]));
    finishExplorer({ imported: ["notes/b.md"], skipped: 0 });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe("notes/b.md"));
    expect((document.activeElement as HTMLElement).getAttribute("aria-selected")).toBe("true");
  });

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
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "notes/a.md", kind: "file" }], folders: ["notes"] });
    bridge.readExplorerMenu.mockResolvedValue([IMPORT_FILES_ENTRY]);
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
    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
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
    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
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
    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
    expect(await navigator.clipboard.readText()).toContain(`Imported: ${deep}\n`);
  });

  it("keeps the skipped count when the first copy fails, and copies the skipped files", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [],
      skipped: 2,
      skippedSources: [{ path: "key.txt", reason: "link" }, { path: ".DS_Store", reason: "system-file" }],
      stop: { file: "three.md", code: "ENOSPC", detail: "ENOSPC: no space left on device, copyfile 'three.md'" },
    });
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Could not import files (2 skipped). The disk is full.");
    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("Skipped: key.txt is a link. Drop the file it leads to.");
    expect(copied).toContain("Skipped: .DS_Store is a file the system makes.");
  });

  // Try again removes the row before it runs. When the shared view cannot
  // refresh first, the person still learns why no file picker opened. A
  // damaged share offers no import, so the share is damaged after the import.
  it("says why no file picker opened when the shared view does not refresh before Try again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.importWorkspaceFiles.mockResolvedValueOnce({
      imported: ["notes/one.md"],
      skipped: 0,
      interrupted: true,
    });
    const shareView = { shareId: "share-1", granterEmail: "granter@dohc.test", access: "edit" as const };
    const view = renderShell(bridge, { ...WORKSPACE, shareView });
    const user = userEvent.setup();

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByText("Import files"));
    const damaged = { ...WORKSPACE, shareView: { ...shareView, damaged: true as const } };
    view.rerender(
      <>
        <CollectionFieldWriteHost />
        <DesktopWorkspaceShell
          workspace={damaged}
          workspaces={[damaged]}
          {...shellBootstrapProps(bridge)}
          onSwitchWorkspace={() => {}}
        />
      </>,
    );
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
    await user.click(within(toast).getByTestId("workspace-shell-error-details"));
    await user.click(within(toast).getByTestId("workspace-shell-error-details-copy"));
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
  it.each(["toast", "Notices"])("reports an edits-pending Stop after close, retries from %s, and clears both on success", async surface => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise).mockResolvedValue({keptEdits: "none"});
    const user = userEvent.setup();
    renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const title = `Live editing didn't stop for ${LIVE_ROW.path}`;
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(title)).toBeTruthy();
    expect(within(toast).getByText("The server hasn't finished applying edits to this document. Try again in a moment.")).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Details" })).toBeTruthy();
    if (surface === "toast") {
      await user.click(within(toast).getByRole("button", {name: "Try again"}));
    } else {
      await user.click(screen.getByTestId("notice-center-toggle"));
      const notice = within(await screen.findByTestId("notice-center")).getByText(title).closest("li")!;
      expect(within(notice).getByText("The server hasn't finished applying edits to this document. Try again in a moment.")).toBeTruthy();
      expect(within(notice).getByRole("button", { name: "Details" })).toBeTruthy();
      await user.click(within(notice).getByRole("button", {name: "Try again"}));
    }
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(2));
    expect(bridge.stopOwnerLiveDocument).toHaveBeenNthCalledWith(2, {workspaceId: WORKSPACE.workspaceId, path: LIVE_ROW.path, objectId: LIVE_ROW.objectId});
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
  });

  it.each((["quarantine", "failure"] as const).flatMap(source =>
    HOST_STOP_CASES.filter(([code, state]) => ["host-paused", "host-diverged"].includes(code) || (code === "host-not-loaded" && state === "starting"))
      .map(([code, sessionHost, words, control]) => ({source, code, sessionHost, words, control}))))(
    "routes the $source Stop notice's $code refusal", async ({source, code, sessionHost, words, control}) => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus.mockResolvedValue({...SYNC_STATUS,
      ...(source === "quarantine" ? {ownerLiveQuarantines: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path,
        reason: "invalid-update", storedOn: "this-computer" as const, incident: "outbox:delivery:0", recovery: "stopping" as const}]}
        : {ownerLiveStopFailures: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path, detail: "waiting"}]})});
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValue(hostStopWireError(code, sessionHost, "untrusted relay text"));
    bridge.listOwnerLiveDocuments = vi.fn();
    const user = userEvent.setup(); renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const title = source === "quarantine" ? `Stopping live editing for ${LIVE_ROW.path}` : `dohc could not stop live editing for "${LIVE_ROW.path}".`;
    const old = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(old).getByRole("button", {name: "Try again"}));
    const toast = await screen.findByTestId("workspace-shell-error");
    await within(toast).findByText(words.slice("Live editing didn't stop. ".length));
    if (control === "none") expect(within(toast).queryByRole("button", {name: /Resume|Try again/})).toBeNull();
    else expect(within(toast).getByRole("button", {name: control === "resume" ? "Resume live editing" : "Try again"})).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    const copy = await navigator.clipboard.readText();
    expect(copy).toContain(`Server: ${sessionHost}`);
    expect(copy).not.toContain("LiveStopRefusal");
    expect(bridge.listOwnerLiveDocuments).not.toHaveBeenCalled();
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    expect(!!within(await screen.findByTestId("notice-center")).queryByText(title)).toBe(source === "quarantine");
  });
  it.each(["quarantine", "failure"] as const)("routes edits-pending from the %s Stop notice", async source => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getSyncStatus.mockResolvedValue({...SYNC_STATUS,
      ...(source === "quarantine" ? {ownerLiveQuarantines: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path,
        reason: "invalid-update", storedOn: "this-computer" as const, incident: "outbox:delivery:0", recovery: "stopping" as const}]}
        : {ownerLiveStopFailures: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path, detail: "waiting"}]})});
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValue(liveStopError({code: "edits-pending"}));
    const user = userEvent.setup(); renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const title = source === "quarantine" ? `Stopping live editing for ${LIVE_ROW.path}` : `dohc could not stop live editing for "${LIVE_ROW.path}".`;
    const old = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(old).getByRole("button", {name: "Try again"}));
    const toast = await screen.findByTestId("workspace-shell-error");
    await within(toast).findByText("The server hasn't finished applying edits to this document. Try again in a moment.");
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    expect(!!within(await screen.findByTestId("notice-center")).queryByText(title)).toBe(source === "quarantine");
  });
  it("makes no live-list read on a sync snapshot after a pending Stop", async () => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    await screen.findByText(`Live editing didn't stop for ${LIVE_ROW.path}`);
    bridge.listOwnerLiveDocuments.mockClear();
    const before = bridge.getSyncStatus.mock.calls.length;
    bridge.getSyncStatus.mockImplementation(async () => ({...SYNC_STATUS}));
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(before));
    await act(async () => {});
    expect(bridge.listOwnerLiveDocuments).not.toHaveBeenCalled();
  });
  it.each(HOST_STOP_CASES.flatMap(([code, sessionHost, words, control]) =>
    (["ready", "paused"] as const).map(status => ({code, sessionHost, words, control, status}))))(
    "keeps out-of-sight $code with $sessionHost and $status row in toast and Notices", async ({code, sessionHost, words, control, status}) => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [{...LIVE_ROW, status, canResume: true}], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise).mockResolvedValue({keptEdits: "none"});
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    const body = words.slice("Live editing didn't stop. ".length);
    await act(async () => stopping.reject(hostStopWireError(code, sessionHost, "untrusted relay text")));
    const title = `Live editing didn't stop for ${LIVE_ROW.path}`;
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(title)).toBeTruthy();
    expect(within(toast).getByText(body)).toBeTruthy();
    const resume = control === "resume";
    if (control === "none") expect(within(toast).queryByRole("button", {name: /Resume|Try again/})).toBeNull();
    else expect(within(toast).getByRole("button", {name: resume ? "Resume live editing" : "Try again"})).toBeTruthy();
    expect(toast.textContent).not.toContain("Server:");
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    expect(await navigator.clipboard.readText()).toContain(`Server: ${sessionHost}`);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = within(await screen.findByTestId("notice-center")).getByText(title).closest("li")!;
    expect(within(notice).getByText(body)).toBeTruthy();
    await user.click(within(notice).getByRole("button", { name: "Details" }));
    await user.click(within(notice).getByRole("button", { name: "Copy details" }));
    expect(await navigator.clipboard.readText()).toContain(`Server: ${sessionHost}`);
    if (control === "none") {
      expect(within(notice).queryByRole("button", {name: /Resume|Try again/})).toBeNull();
      return;
    }
    await user.click(within(notice).getByRole("button", {name: resume ? "Resume live editing" : "Try again"}));
    if (resume) await waitFor(() => expect(bridge.resumeOwnerLiveDocument).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, path: LIVE_ROW.path}));
    else await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenNthCalledWith(2, {workspaceId: WORKSPACE.workspaceId, path: LIVE_ROW.path, objectId: LIVE_ROW.objectId}));
  });
  it.each(["paused", "refused"])("offers Resume from the out-of-sight %s Stop", async state => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [{...LIVE_ROW, canResume: true,
      status: state === "paused" ? "paused" as const : "unavailable" as const,
      ...(state === "refused" ? {reason: "session-host-refused" as const} : {})}], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const text = "Recent edits haven't reached the server yet. Resume live editing to send them, then stop it.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(text)).toBeTruthy();
    expect(within(toast).queryByRole("button", {name: "Try again"})).toBeNull();
    expect(within(toast).getByRole("button", {name: "Resume live editing"})).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = within(await screen.findByTestId("notice-center")).getByText(text).closest("li")!;
    expect(within(notice).queryByRole("button", {name: "Try again"})).toBeNull();
    await user.click(within(notice).getByRole("button", {name: "Resume live editing"}));
    await waitFor(() => expect(bridge.resumeOwnerLiveDocument).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, path: LIVE_ROW.path}));
  });
  it("reports recovered kept edits after the pending Stop toast's retry", async () => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise).mockResolvedValue({keptEdits: "recovered"});
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Try again"}));
    expect(await screen.findByText(`Live editing stopped for ${LIVE_ROW.path}. dohc wrote your kept edits into the file.`)).toBeTruthy();
  });
  // As it crosses Electron's IPC, which keeps only the name and message.
  const waitingStop = () => new Error(`Error invoking remote method 'stopOwnerLiveDocument': ${String(liveStopWaitingError(new Error("fetch failed")))}`);
  const stoppingStatus = (): SyncStatusResult => ({...SYNC_STATUS, ownerLiveQuarantines: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path,
    reason: "invalid-update", storedOn: "this-computer", incident: "outbox:delivery:0", recovery: "stopping"}]});
  const STOPPING_WORDS = "dohc is waiting for the server to stop live editing. Your unsent edits stay on this computer.";
  // The document's "Stopping live editing" row says the Stop waits, and keeps
  // Save recovery copy, so Live documents adds no notice of that wait.
  it.each(["the row is there first", "the row comes after"] as const)("files one Stopping row for a waiting Stop when %s", async order => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValue(waitingStop());
    const title = `Stopping live editing for ${LIVE_ROW.path}`;
    const user = userEvent.setup();
    if (order === "the row is there first") {
      bridge.getSyncStatus.mockResolvedValue(stoppingStatus());
      renderShell(bridge);
      await user.click(await screen.findByTestId("notice-center-toggle"));
      await within(await screen.findByTestId("notice-center")).findByText(title);
      await user.click(screen.getByTestId("notice-center-toggle"));
    } else renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledOnce());
    if (order === "the row comes after") {
      await screen.findByText(LIVE_STOP_WAITING);
      bridge.getSyncStatus.mockResolvedValue(stoppingStatus());
      act(() => bridge.emitWorkspaceActivity());
    }
    await waitFor(() => expect(within(dialog).getByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`})).toHaveProperty("disabled", false));
    await user.click(within(dialog).getByRole("button", {name: "Close"}));
    await user.click(screen.getByTestId("notice-center-toggle"));
    const center = await screen.findByTestId("notice-center");
    await waitFor(() => expect(within(center).queryByText(LIVE_STOP_WAITING)).toBeNull());
    expect(within(center).getAllByText(title)).toHaveLength(1);
    const row = within(center).getByText(title).closest("li")!;
    expect(within(row).getByText(STOPPING_WORDS)).toBeTruthy();
    expect(within(row).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    expect(within(row).getByRole("button", {name: "Try again"})).toBeTruthy();
  });
  // A dismissed row says nothing, so Live documents reports the wait itself.
  it("reports a waiting Stop from Live documents after its Stopping row was dismissed", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValue(waitingStop());
    bridge.getSyncStatus.mockResolvedValue(stoppingStatus());
    const title = `Stopping live editing for ${LIVE_ROW.path}`;
    const user = userEvent.setup(); renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(row).getByRole("button", {name: "Dismiss notice"}));
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    if (screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    const toast = (await screen.findByText(LIVE_STOP_WAITING)).closest<HTMLElement>("[data-testid='workspace-shell-error']")!;
    expect(within(toast).getByText(title)).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
  });
  it("keeps the Stopping row as it was when its Try again waits again", async () => {
    const bridge = makeBridge(Promise.resolve(null)), again = deferred<StopOwnerLiveDocumentResult>();
    bridge.getSyncStatus.mockResolvedValue(stoppingStatus());
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(again.promise);
    const title = `Stopping live editing for ${LIVE_ROW.path}`;
    const user = userEvent.setup(); renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const row = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(row).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledOnce());
    await act(async () => again.reject(waitingStop()));
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    const center = await screen.findByTestId("notice-center");
    expect(within(center).getAllByText(title)).toHaveLength(1);
    const kept = within(center).getByText(title).closest("li")!;
    expect(within(kept).getByText(STOPPING_WORDS)).toBeTruthy();
    expect(within(kept).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
    expect(screen.queryByText(/dohc could not stop live editing/)).toBeNull();
  });
  it.each(["no Stopping row", "the Stopping row there first", "the Stopping row coming after"] as const)(
    "says a Stop waits, once, when the pending Stop notice's Try again waits, with %s", async order => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>(), again = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise).mockReturnValueOnce(again.promise);
    const title = `Stopping live editing for ${LIVE_ROW.path}`;
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(2));
    const showRow = async () => {
      bridge.getSyncStatus.mockResolvedValue(stoppingStatus());
      act(() => bridge.emitWorkspaceActivity());
      await user.click(screen.getByTestId("notice-center-toggle"));
      await within(await screen.findByTestId("notice-center")).findByText(STOPPING_WORDS);
      await user.click(screen.getByTestId("notice-center-toggle"));
    };
    if (order === "the Stopping row there first") await showRow();
    await act(async () => again.reject(waitingStop()));
    if (order === "the Stopping row coming after") {
      await screen.findByText(LIVE_STOP_WAITING);
      await showRow();
    }
    expect(screen.queryByText(/dohc could not stop live editing/)).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const center = await screen.findByTestId("notice-center");
    await waitFor(() => expect(within(center).getAllByText(title)).toHaveLength(1));
    const row = within(center).getByText(title).closest("li")!;
    expect(within(row).getByText(order === "no Stopping row" ? LIVE_STOP_WAITING : STOPPING_WORDS)).toBeTruthy();
    expect(within(row).getByRole("button", {name: "Try again"})).toBeTruthy();
  });
  it.each(["dialog", "quarantine", "agent"])("takes back a pending Stop notice after a later %s Stop succeeds", async control => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise).mockResolvedValue({keptEdits: "none"});
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const title = `Live editing didn't stop for ${LIVE_ROW.path}`;
    await screen.findByText(title);
    if (control === "dialog") {
      const reopened = await openLiveDocumentsFromSettings(user);
      await user.click(await within(reopened).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    } else if (control === "quarantine") {
      bridge.getSyncStatus.mockResolvedValue({...SYNC_STATUS, ownerLiveQuarantines: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path,
        reason: "invalid-update", storedOn: "this-computer", incident: "outbox:delivery:0", recovery: "stopping"}]});
      act(() => bridge.emitWorkspaceActivity());
      await user.click(screen.getByTestId("notice-center-toggle"));
      const notice = (await within(await screen.findByTestId("notice-center")).findByText(`Stopping live editing for ${LIVE_ROW.path}`)).closest("li")!;
      await user.click(within(notice).getByRole("button", {name: "Try again"}));
      await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(2));
    } else {
      // Main reports the document whose Stop succeeded, without a list read.
      act(() => bridge.emitWorkspaceActivity({workspaceId: WORKSPACE.workspaceId, liveDocumentStopped: LIVE_ROW.objectId}));
    }
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).queryByText(title)).toBeNull();
  });
  it.each(["another-document", "another-workspace", "old-admission"] as const)(
    "keeps a pending Stop notice for an agent success from %s", async mode => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    const view = render(shell(WORKSPACE)), user = userEvent.setup();
    await screen.findByTestId("activity-settings");
    await waitFor(() => expect(bridge.onWorkspaceActivity).toHaveBeenCalled());
    const oldActivity = bridge.onWorkspaceActivity.mock.calls.at(-1)![0];
    if (mode === "old-admission") {
      view.rerender(shell(OTHER_WORKSPACE));
      await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledWith({workspaceId: OTHER_WORKSPACE.workspaceId}));
      view.rerender(shell(WORKSPACE));
    }
    const stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const title = `Live editing didn't stop for ${LIVE_ROW.path}`;
    await screen.findByText(title);
    const event = {workspaceId: mode === "another-workspace" ? OTHER_WORKSPACE.workspaceId : WORKSPACE.workspaceId,
      liveDocumentStopped: mode === "another-document" ? "other-object" : LIVE_ROW.objectId};
    await act(async () => { if (mode === "old-admission") oldActivity(event); else bridge.emitWorkspaceActivity(event); });
    expect(screen.getByText(title)).toBeTruthy();
  });
  it.each(["another", "closed"])("drops the late pending Stop report for an %s workspace", async mode => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    const view = render(shell(WORKSPACE)), user = userEvent.setup();
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    if (mode === "another") view.rerender(shell(OTHER_WORKSPACE)); else view.unmount();
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    expect(screen.queryByText(`Live editing didn't stop for ${LIVE_ROW.path}`)).toBeNull();
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });
  it("drops a pending Stop's Try again after switching workspaces", async () => {
    const notices = vi.spyOn(shellError, "useShellError");
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    const view = render(shell(WORKSPACE)), user = userEvent.setup();
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    await screen.findByTestId("workspace-shell-error");
    const latest: ReturnType<typeof shellError.useShellError> | undefined = notices.mock.results.at(-1)?.value;
    const retry = latest?.shellErrors.find(error => error.identity === `live-stop-edits-pending:${LIVE_ROW.objectId}`)?.retry;
    notices.mockRestore();
    expect(retry).toBeTypeOf("function");
    view.rerender(shell(OTHER_WORKSPACE));
    await act(async () => { retry?.(); });
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });

  // Issue 2946: a Stop asked for before the list closed answers after it opens again.
  it("shows a Stop that is refused after Live documents reopens in its row, without a toast or a Notice", async () => {
    const notices = vi.spyOn(shellError, "useShellError");
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    const reopened = await openLiveDocumentsFromSettings(user);
    const row = await within(reopened).findByTestId(`live-document-row-${LIVE_ROW.path}`);
    await within(row).findByText("Stopping live editing…");
    expect((within(row).getByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    await within(row).findByText("Live editing didn't stop. The server hasn't finished applying edits to this document. Try again in a moment.");
    expect(within(row).getByRole("button", {name: `Try again to stop live editing for ${LIVE_ROW.path}`})).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    const latest: ReturnType<typeof shellError.useShellError> = notices.mock.results.at(-1)!.value;
    notices.mockRestore();
    expect(latest.shellErrors.some(error => error.identity === `live-stop-edits-pending:${LIVE_ROW.objectId}`)).toBe(false);
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });

  it("lists a Stop that succeeds after Live documents reopens as stopped", async () => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    let stopped = false;
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [stopped ? {...LIVE_ROW, status: "retired" as const} : LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    const reopened = await openLiveDocumentsFromSettings(user);
    const row = await within(reopened).findByTestId(`live-document-row-${LIVE_ROW.path}`);
    await within(row).findByText("Stopping live editing…");
    stopped = true;
    await act(async () => stopping.resolve({keptEdits: "none"}));
    await waitFor(() => expect(within(reopened).getByTestId(`live-document-row-${LIVE_ROW.path}`).children[1]?.textContent).toBe("Stopped"));
    expect(within(reopened).queryByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`})).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });

  it("reports a Stop refused after Live documents reopens and closes again in a toast", async () => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    const reopened = await openLiveDocumentsFromSettings(user);
    await within(reopened).findByTestId(`live-document-row-${LIVE_ROW.path}`);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(`Live editing didn't stop for ${LIVE_ROW.path}`)).toBeTruthy();
    expect(within(toast).getByText("The server hasn't finished applying edits to this document. Try again in a moment.")).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
  });

  it("keeps a Stop running in one workspace out of another workspace's Live documents", async () => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    const view = render(shell(WORKSPACE)), user = userEvent.setup();
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledWith({workspaceId: OTHER_WORKSPACE.workspaceId}));
    const other = await openLiveDocumentsFromSettings(user);
    await waitFor(() => expect(bridge.listOwnerLiveDocuments).toHaveBeenLastCalledWith({workspaceId: OTHER_WORKSPACE.workspaceId}));
    const row = await within(other).findByTestId(`live-document-row-${LIVE_ROW.path}`);
    await waitFor(() => expect((within(row).getByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}) as HTMLButtonElement).disabled).toBe(false));
    expect(within(row).queryByText("Stopping live editing…")).toBeNull();
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    expect(within(row).queryByText(/^Live editing didn't stop/u)).toBeNull();
    expect(screen.queryByText(`Live editing didn't stop for ${LIVE_ROW.path}`)).toBeNull();
  });


  it.each(["toast", "Notices"] as const)("opens Live documents from an out-of-sight withheld Stop in %s", async surface => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [{...LIVE_ROW, status: "unavailable" as const,
      reason: "conflict-parent-withheld" as const, canResume: false}], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const title = `Live editing didn't stop for ${LIVE_ROW.path}.`;
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(title)).toBeTruthy();
    expect(within(toast).queryByText(/conflict|Recent edits|dohc could not finish/)).toBeNull();
    expect(within(toast).queryByRole("button", {name: /Try again|Resume/})).toBeNull();
    expect(within(toast).getByRole("button", {name: "Open Live documents"})).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    expect(await navigator.clipboard.readText()).toContain(title);
    let actionSurface = toast;
    if (surface === "Notices") {
      await user.click(screen.getByTestId("notice-center-toggle"));
      actionSurface = within(await screen.findByTestId("notice-center")).getByText(title).closest("li")!;
      expect(within(actionSurface).queryByRole("button", {name: /Try again|Resume/})).toBeNull();
      expect(within(actionSurface).getByRole("button", { name: "Details" })).toBeTruthy();
    }
    await user.click(within(actionSurface).getByRole("button", {name: "Open Live documents"}));
    expect(await screen.findByTestId("live-documents-dialog")).toBeTruthy();
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledOnce();
  });
  it.each(["paused", "copied"] as const)("keeps an out-of-sight %s quarantine Stop's copy in toast and Notices", async quarantine => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [{...LIVE_ROW, canResume: false, quarantine}], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    await user.click(await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`}));
    await user.keyboard("{Escape}");
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const title = `Live editing didn't stop for ${LIVE_ROW.path}`;
    const body = "The server hasn't finished applying edits to this document. Try again in a moment.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(title)).toBeTruthy();
    expect(within(toast).getByText(body)).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
    expect(within(toast).queryByRole("button", {name: /Resume/})).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = within(await screen.findByTestId("notice-center")).getByText(title).closest("li")!;
    expect(within(notice).getByText(body)).toBeTruthy();
    expect(within(notice).getByRole("button", {name: "Try again"})).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Details" })).toBeTruthy();
  });
  it.each(["not-written", "stopping"] as const)("keeps the %s quarantine's Save row when Stop again refuses", async recovery => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    const kept = {objectId: LIVE_ROW.objectId, path: LIVE_ROW.path, reason: "invalid-update", storedOn: "this-computer" as const,
      incident: "kept-1", recovery};
    bridge.getSyncStatus.mockResolvedValue({...SYNC_STATUS, ownerLiveQuarantines: [kept]});
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const title = recovery === "not-written" ? `Edits not written to ${LIVE_ROW.path}` : `Stopping live editing for ${LIVE_ROW.path}`;
    const old = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(old).getByRole("button", {name: "Try again"}));
    const nextTitle = recovery === "not-written" ? title : `Live editing paused for ${LIVE_ROW.path}`;
    if (recovery === "stopping") {
      bridge.getSyncStatus.mockResolvedValue({...SYNC_STATUS, ownerLiveQuarantines: [{...kept, recovery: "paused", incident: "kept-2"}]});
      act(() => bridge.emitWorkspaceActivity());
      if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
      await within(await screen.findByTestId("notice-center")).findByText(nextTitle);
    }
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = within(await screen.findByTestId("notice-center")).getByText(nextTitle).closest("li")!;
    expect(within(notice).getByRole("button", {name: "Save recovery copy"})).toBeTruthy();
  });

  it.each((["failure", "quarantine"] as const).flatMap(source =>
    (["withheld", "unavailable", "resumable", "failed-read", "missing-row"] as const).map(kind => ({source, kind}))))(
    "reads the $source Stop refusal's $kind row once", async ({source, kind}) => {
    const bridge = makeBridge(Promise.resolve(null));
    const kept = {objectId: LIVE_ROW.objectId, path: LIVE_ROW.path, reason: "invalid-update", storedOn: "this-computer" as const,
      incident: "kept-1", recovery: "stopping" as const};
    bridge.getSyncStatus.mockResolvedValue({...SYNC_STATUS, ...(source === "quarantine" ? {ownerLiveQuarantines: [kept]}
      : {ownerLiveStopFailures: [{objectId: LIVE_ROW.objectId, path: LIVE_ROW.path, detail: "waiting"}]})});
    const reading = deferred<OwnerLiveDocumentsResult>();
    bridge.listOwnerLiveDocuments = vi.fn().mockReturnValueOnce(reading.promise);
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValueOnce(liveStopError({code: "edits-pending"}));
    const user = userEvent.setup(); renderShell(bridge);
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const title = source === "quarantine" ? `Stopping live editing for ${LIVE_ROW.path}` : `dohc could not stop live editing for "${LIVE_ROW.path}".`;
    const old = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(old).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.listOwnerLiveDocuments).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId}));
    if (kind === "failed-read") await act(async () => reading.reject(new Error("offline")));
    else await act(async () => reading.resolve({documents: kind === "missing-row" ? [] : [
      {...LIVE_ROW, saveOnly: true, canResume: kind !== "resumable"},
      {...LIVE_ROW, objectId: "other-document", canResume: kind !== "resumable"},
      {...LIVE_ROW, path: "notes/relay-path.md", ...(kind === "withheld" ? {status: "unavailable", reason: "conflict-parent-withheld", canResume: false}
        : kind === "unavailable" ? {status: "unavailable", reason: "document-unavailable", canResume: false}
        : {status: "paused", canResume: true})},
    ], nextCursor: null}));
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    const pendingTitle = `Live editing didn't stop for ${LIVE_ROW.path}${kind === "withheld" ? "." : ""}`;
    const center = within(await screen.findByTestId("notice-center"));
    const pending = (await center.findByText(/^Live editing didn't stop for /)).closest("li")!;
    expect(within(pending).queryByText(pendingTitle)).toBeTruthy();
    expect(bridge.listOwnerLiveDocuments).toHaveBeenCalledTimes(1);
    if (kind === "withheld") {
      expect(within(pending).queryByRole("button", {name: /Try again|Resume/})).toBeNull();
      bridge.listOwnerLiveDocuments.mockResolvedValueOnce({documents: [
        {...LIVE_ROW, path: "notes/relay-path.md", status: "unavailable", reason: "conflict-parent-withheld", canResume: false},
        {...LIVE_ROW, objectId: "other-document"}], nextCursor: null});
      await user.click(within(pending).getByRole("button", {name: "Open Live documents"}));
      const dialog = within(await screen.findByTestId("live-documents-dialog"));
      expect((await dialog.findByTestId("live-document-row-notes/relay-path.md")).getAttribute("aria-current")).toBe("true");
      expect(dialog.getByTestId(`live-document-row-${LIVE_ROW.path}`).getAttribute("aria-current")).toBeNull();
    } else if (kind === "resumable") {
      expect(within(pending).queryByRole("button", {name: "Try again"})).toBeNull();
      await user.click(within(pending).getByRole("button", {name: "Resume live editing"}));
      expect(bridge.resumeOwnerLiveDocument).toHaveBeenCalledExactlyOnceWith({workspaceId: WORKSPACE.workspaceId, path: "notes/relay-path.md"});
    } else {
      expect(within(pending).getByText("The server hasn't finished applying edits to this document. Try again in a moment.")).toBeTruthy();
      expect(within(pending).getByRole("button", {name: "Try again"})).toBeTruthy();
      if (kind === "unavailable") {
        await user.click(within(pending).getByRole("button", {name: "Try again"}));
        await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenNthCalledWith(2,
          {workspaceId: WORKSPACE.workspaceId, path: LIVE_ROW.path, objectId: LIVE_ROW.objectId}));
      }
    }
  });

  it.each((["failure", "quarantine"] as const).flatMap(source =>
    (["another-workspace", "superseded-admission"] as const).map(mode => ({source, mode}))))(
    "drops the $source Stop row read after $mode", async ({source, mode}) => {
    const notices = vi.spyOn(shellError, "useShellError");
    const bridge = makeBridge(Promise.resolve(null)), reading = deferred<OwnerLiveDocumentsResult>();
    bridge.getSyncStatus.mockImplementation(async () => ({...SYNC_STATUS,
      ...(source === "quarantine" ? {ownerLiveQuarantines: [{...LIVE_ROW,
        reason: "invalid-update", storedOn: "this-computer" as const, incident: "kept-1", recovery: "stopping" as const}]}
        : {ownerLiveStopFailures: [{...LIVE_ROW, detail: "waiting"}]})}));
    bridge.listOwnerLiveDocuments = vi.fn().mockReturnValueOnce(reading.promise);
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValueOnce(liveStopError({code: "edits-pending"}));
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />;
    const view = render(shell(WORKSPACE)), user = userEvent.setup();
    await user.click(await screen.findByTestId("notice-center-toggle"));
    const title = source === "quarantine" ? `Stopping live editing for ${LIVE_ROW.path}` : `dohc could not stop live editing for "${LIVE_ROW.path}".`;
    const old = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    await user.click(within(old).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.listOwnerLiveDocuments).toHaveBeenCalledTimes(1));
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(bridge.getSyncStatus).toHaveBeenCalledWith({workspaceId: OTHER_WORKSPACE.workspaceId}));
    if (mode === "superseded-admission") {
      view.rerender(shell(WORKSPACE));
      await waitFor(() => {
        const latest: ReturnType<typeof shellError.useShellError> = notices.mock.results.at(-1)!.value;
        expect(latest.shellErrors.some(error => error.identity === (source === "failure"
          ? `owner-stop:${WORKSPACE.workspaceId}:${LIVE_ROW.path}`
          : `owner-live-quarantine:${WORKSPACE.workspaceId}:${LIVE_ROW.objectId}`))).toBe(true);
      });
    }
    await act(async () => reading.resolve({documents: [{...LIVE_ROW, canResume: true}], nextCursor: null}));
    const latest: ReturnType<typeof shellError.useShellError> = notices.mock.results.at(-1)!.value;
    expect(latest.shellErrors.some(error => error.identity === `live-stop-edits-pending:${LIVE_ROW.objectId}`)).toBe(false);
    if (source === "failure" && mode === "superseded-admission") {
      expect(latest.shellErrors.some(error => error.identity === `owner-stop:${WORKSPACE.workspaceId}:${LIVE_ROW.path}`)).toBe(true);
    }
    notices.mockRestore();
  });

  it.each(["toast", "Notices"] as const)("starts only one quarantine Stop for two synchronous clicks in %s", async surface => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    const kept = {...LIVE_ROW, reason: "invalid-update", storedOn: "this-computer" as const, incident: "kept-1", recovery: "not-written" as const};
    bridge.getSyncStatus.mockImplementation(async () => ({...SYNC_STATUS, ownerLiveQuarantines: [{...kept}]}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValue(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    let actionSurface = await screen.findByTestId("workspace-shell-error");
    if (surface === "Notices") {
      await user.click(screen.getByTestId("notice-center-toggle"));
      actionSurface = (await within(await screen.findByTestId("notice-center")).findByText(`Edits not written to ${LIVE_ROW.path}`)).closest("li")!;
    }
    const retry = within(actionSurface).getByRole("button", {name: "Try again"});
    act(() => {
      retry.click();
      expect(retry.isConnected).toBe(true);
      expect((retry as HTMLButtonElement).disabled).toBe(false);
      retry.click();
    });
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1));
    await act(async () => stopping.resolve({keptEdits: "none"}));
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });

  it.each((["toast", "Notices"] as const).flatMap(surface =>
    (["snapshot", "refusal", "success-then-snapshot"] as const).map(ending => ({surface, ending}))))(
    "keeps the quarantine Stop retry busy in $surface through $ending and clears it when Stop ends", async ({surface, ending}) => {
    const bridge = makeBridge(Promise.resolve(null)), stopping = deferred<StopOwnerLiveDocumentResult>();
    const kept = {...LIVE_ROW, reason: "invalid-update", storedOn: "this-computer" as const, incident: "kept-1", recovery: "not-written" as const};
    bridge.getSyncStatus.mockImplementation(async () => ({...SYNC_STATUS, ownerLiveQuarantines: [{...kept}]}));
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup(); renderShell(bridge);
    const title = `Edits not written to ${LIVE_ROW.path}`;
    let actionSurface = await screen.findByTestId("workspace-shell-error");
    if (surface === "Notices") {
      await user.click(screen.getByTestId("notice-center-toggle"));
      actionSurface = (await within(await screen.findByTestId("notice-center")).findByText(title)).closest("li")!;
    }
    let retry = within(actionSurface).getByRole("button", {name: "Try again"}) as HTMLButtonElement;
    await user.click(retry);
    if (surface === "Notices") {
      await user.click(screen.getByTestId("notice-center-toggle"));
      const current = within(await screen.findByTestId("notice-center")).getByText(title).closest("li")!;
      retry = within(current).getByRole("button", {name: "Try again"}) as HTMLButtonElement;
    }
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(retry);
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1));
    let settledRetry = retry;
    if (ending === "refusal") {
      await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
      if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
      const recoveryRow = within(await screen.findByTestId("notice-center")).getByText(title).closest("li")!;
      settledRetry = within(recoveryRow).getByRole("button", {name: "Try again"}) as HTMLButtonElement;
      await waitFor(() => expect(settledRetry.disabled).toBe(false));
    } else {
      if (ending === "success-then-snapshot") {
        await act(async () => stopping.resolve({keptEdits: "none"}));
        expect(retry.disabled).toBe(false);
      }
      const before = bridge.getSyncStatus.mock.calls.length, snapshot = deferred<SyncStatusResult>();
      bridge.getSyncStatus.mockReturnValueOnce(snapshot.promise);
      act(() => bridge.emitWorkspaceActivity());
      await waitFor(() => expect(bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(before));
      await act(async () => snapshot.resolve({...SYNC_STATUS, ownerLiveQuarantines: [{...kept}]}));
      if (ending === "snapshot") {
        expect(retry.getAttribute("aria-busy")).toBe("true");
        expect(retry.disabled).toBe(true);
        fireEvent.click(retry);
        expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
        await act(async () => stopping.resolve({keptEdits: "none"}));
      }
      await waitFor(() => expect(retry.disabled).toBe(false));
    }
    expect(settledRetry.hasAttribute("aria-busy")).toBe(false);
    expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(1);
  });

  const LIVE_ROW = {
    path: "notes/today.md",
    objectId: "object-today",
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
        objectId: LIVE_ROW.objectId,
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

  // The waiting words are the same for every document, so each document's
  // waiting Stop keeps its own notice, and another report replaces only its own.
  it("keeps one waiting Stop notice per document, each with its title, words and Try again", async () => {
    const PLAN_ROW = {...LIVE_ROW, path: "notes/plan.md", objectId: "object-plan"};
    // As it crosses Electron's IPC, which keeps only the name and message.
    const waiting = () => new Error(`Error invoking remote method 'stopOwnerLiveDocument': ${String(liveStopWaitingError(new Error("fetch failed")))}`);
    const again = deferred<StopOwnerLiveDocumentResult>(), retried = deferred<StopOwnerLiveDocumentResult>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async (): Promise<OwnerLiveDocumentsResult> => ({documents: [LIVE_ROW, PLAN_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValueOnce(waiting()).mockRejectedValueOnce(waiting())
      .mockReturnValueOnce(again.promise).mockReturnValueOnce(retried.promise);
    const user = userEvent.setup();
    renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    const stopButton = (row: typeof LIVE_ROW) => within(dialog).getByRole("button", {name: `Stop live editing for ${row.path}`});
    const toastTitle = (title: string) => waitFor(() => expect(within(screen.getByTestId("workspace-shell-error")).getByText(title)).toBeTruthy());
    const [todayTitle, planTitle] = [LIVE_ROW, PLAN_ROW].map(row => `Stopping live editing for ${row.path}`) as [string, string];
    // Waits out a Stop the test answers: busy while it runs, free once the dialog has reported it.
    const settle = async (stop: typeof again) => {
      await waitFor(() => expect(stopButton(LIVE_ROW)).toHaveProperty("disabled", true));
      await act(async () => stop.reject(waiting()));
      await waitFor(() => expect(stopButton(LIVE_ROW)).toHaveProperty("disabled", false));
    };

    await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`});
    await user.click(stopButton(LIVE_ROW));
    await toastTitle(todayTitle);
    await waitFor(() => expect(stopButton(PLAN_ROW)).toHaveProperty("disabled", false));
    await user.click(stopButton(PLAN_ROW));
    await toastTitle(planTitle);
    // A second report for today.md, while both rows stand, replaces only its own.
    await waitFor(() => expect(stopButton(LIVE_ROW)).toHaveProperty("disabled", false));
    await user.click(stopButton(LIVE_ROW));
    await settle(again);
    await toastTitle(todayTitle);
    // The toast's Try again stops its own document.
    const toast = screen.getByTestId("workspace-shell-error");
    expect(within(toast).getByText(LIVE_STOP_WAITING)).toBeTruthy();
    await user.click(within(toast).getByRole("button", {name: "Try again"}));
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(4));
    for (const [n, row] of [LIVE_ROW, PLAN_ROW, LIVE_ROW, LIVE_ROW].entries()) {
      expect(bridge.stopOwnerLiveDocument).toHaveBeenNthCalledWith(n + 1, {workspaceId: WORKSPACE.workspaceId, path: row.path, objectId: row.objectId});
    }
    await settle(retried);
    await toastTitle(todayTitle);

    await user.click(within(dialog).getByRole("button", {name: "Close"}));
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const center = await screen.findByTestId("notice-center");
    for (const title of [todayTitle, planTitle]) {
      const titles = within(center).getAllByText(title);
      expect(titles).toHaveLength(1);
      const notice = titles[0]!.closest("li")!;
      expect(within(notice).getByText(LIVE_STOP_WAITING)).toBeTruthy();
      expect(within(notice).getByRole("button", {name: "Try again"})).toBeTruthy();
    }
    expect(within(center).getAllByText(LIVE_STOP_WAITING)).toHaveLength(2);
  });

  // Nothing sends a server-only Stop again, so the notice says to try again,
  // and keeps the relay's words in Copy only. The row stays while a Stop runs,
  // and through one that waits again after the dialog closes; it goes when a
  // Stop succeeds.
  it("keeps a server-only Stop the server isn't ready for, with the relay's words in Copy, until a Stop succeeds, through a closed dialog's wait", async () => {
    const relay = "Stop live editing is waiting. You can keep editing.";
    // Main's plain relay error, as it crosses Electron's IPC.
    const notReady = () => new Error(`Error invoking remote method 'stopOwnerLiveDocument': Error: ${relay}`);
    const next = deferred<StopOwnerLiveDocumentResult>();
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async (): Promise<OwnerLiveDocumentsResult> => ({documents: [LIVE_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValueOnce(notReady()).mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce({keptEdits: "none"});
    const user = userEvent.setup();
    renderShell(bridge);
    let dialog = await openLiveDocumentsFromSettings(user);
    const stopButton = () => within(dialog).getByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`});
    const title = `Live editing didn't stop for ${LIVE_ROW.path}`;
    const noticeTitles = async () => {
      await user.click(screen.getByTestId("notice-center-toggle"));
      const titles = within(await screen.findByTestId("notice-center")).queryAllByText(title);
      await user.click(screen.getByTestId("notice-center-toggle"));
      return titles;
    };

    await within(dialog).findByRole("button", {name: `Stop live editing for ${LIVE_ROW.path}`});
    await user.click(stopButton());
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(title)).toBeTruthy();
    expect(within(toast).getByText(LIVE_STOP_SERVER_NOT_READY)).toBeTruthy();
    expect(within(toast).getByRole("button", {name: "Try again"})).toBeTruthy();
    expect(toast.textContent).not.toContain(relay);
    await user.click(within(toast).getByRole("button", { name: "Details" }));
    await user.click(within(toast).getByRole("button", { name: "Copy details" }));
    expect(await navigator.clipboard.readText()).toContain(`Cause: ${relay}`);

    // The second Stop runs, and the row stays.
    await waitFor(() => expect(stopButton()).toHaveProperty("disabled", false));
    await user.click(stopButton());
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(2));
    expect(within(screen.getByTestId("workspace-shell-error")).getByText(title)).toBeTruthy();
    // It waits again after the dialog closed, which reports nothing: the row is still there, once.
    await user.click(within(dialog).getByRole("button", {name: "Close"}));
    expect(screen.queryByTestId("live-documents-dialog")).toBeNull();
    await act(async () => next.reject(notReady()));
    const kept = await noticeTitles();
    expect(kept).toHaveLength(1);
    expect(within(kept[0]!.closest("li")!).getByText(LIVE_STOP_SERVER_NOT_READY)).toBeTruthy();

    // A Stop that succeeds clears it.
    dialog = await openLiveDocumentsFromSettings(user);
    await waitFor(() => expect(stopButton()).toHaveProperty("disabled", false));
    await user.click(stopButton());
    await waitFor(() => expect(bridge.stopOwnerLiveDocument).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(stopButton()).toHaveProperty("disabled", false));
    await user.click(within(dialog).getByRole("button", {name: "Close"}));
    expect(await noticeTitles()).toHaveLength(0);
  });

  // Main reports every Stop that succeeds, including an agent's, so the
  // document's waiting row goes, and no other row.
  it("clears a document's waiting row when main reports its Stop succeeded, and leaves other documents and workspaces alone", async () => {
    const PLAN_ROW = {...LIVE_ROW, path: "notes/plan.md", objectId: "object-plan"};
    // As it crosses Electron's IPC, which keeps only the name and message.
    const waiting = () => new Error(`Error invoking remote method 'stopOwnerLiveDocument': ${String(liveStopWaitingError(new Error("fetch failed")))}`);
    const bridge = makeBridge(Promise.resolve(null));
    bridge.listOwnerLiveDocuments = vi.fn(async (): Promise<OwnerLiveDocumentsResult> => ({documents: [LIVE_ROW, PLAN_ROW], nextCursor: null}));
    bridge.stopOwnerLiveDocument = vi.fn().mockRejectedValueOnce(waiting()).mockRejectedValueOnce(waiting());
    const user = userEvent.setup();
    renderShell(bridge);
    const dialog = await openLiveDocumentsFromSettings(user);
    const [todayTitle, planTitle] = [LIVE_ROW, PLAN_ROW].map(row => `Stopping live editing for ${row.path}`) as [string, string];
    for (const [row, title] of [[LIVE_ROW, todayTitle], [PLAN_ROW, planTitle]] as const) {
      const stop = await within(dialog).findByRole("button", {name: `Stop live editing for ${row.path}`});
      await waitFor(() => expect(stop).toHaveProperty("disabled", false));
      await user.click(stop);
      await waitFor(() => expect(within(screen.getByTestId("workspace-shell-error")).getByText(title)).toBeTruthy());
    }
    await user.click(within(dialog).getByRole("button", {name: "Close"}));
    await user.click(screen.getByTestId("notice-center-toggle"));
    const center = () => within(screen.getByTestId("notice-center"));
    await screen.findByTestId("notice-center");

    await act(async () => bridge.emitWorkspaceActivity({workspaceId: OTHER_WORKSPACE.workspaceId, liveDocumentStopped: LIVE_ROW.objectId}));
    await act(async () => bridge.emitWorkspaceActivity({workspaceId: WORKSPACE.workspaceId, liveDocumentStopped: "other-object"}));
    expect(center().getByText(todayTitle)).toBeTruthy();
    expect(center().getByText(planTitle)).toBeTruthy();
    await act(async () => bridge.emitWorkspaceActivity({workspaceId: WORKSPACE.workspaceId, liveDocumentStopped: LIVE_ROW.objectId}));
    await waitFor(() => expect(center().queryByText(todayTitle)).toBeNull());
    expect(center().getByText(planTitle)).toBeTruthy();
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

  // The notice's Try again is main's own retry command, not a repaint. A
  // retry with no reason toasts once it has lasted 15 s.
  it("runs the live delivery retry command from the notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const bridge = makeBridge(Promise.resolve(null));
      const retryingStatus: SyncStatusResult = {
        ...SYNC_STATUS,
        ownerLiveDelivery: "retrying",
      };
      bridge.openWorkspace = vi.fn(async () => retryingStatus);
      bridge.getSyncStatus = vi.fn(async () => retryingStatus);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderShell(bridge);

      await screen.findByTestId("owner-live-delivery-status");
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await user.click(
        await screen.findByTestId("owner-live-delivery-toast-action"),
      );
      await waitFor(() =>
        expect(bridge.retryOwnerLiveDelivery).toHaveBeenCalledWith({
          workspaceId: WORKSPACE.workspaceId,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
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
    expect(screen.getByTestId("workspace-shell-error-details")).toBeTruthy();
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

  // Busy is not broken: a workspace still taking in files says nothing about
  // its server connection, and the next activity reads it again.
  it("says nothing while the workspace is still updating, then reads the server status again", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn()
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'desktop:cloud-status': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      ))
      .mockResolvedValue({ connected: true, workspaceSynced: true });
    const user = userEvent.setup();
    renderShell(bridge);

    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId, pathSetChanged: false }));
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(2));
    await openCloudSettings(user);
    expect(await screen.findByTestId("settings-row-live-documents")).toBeTruthy();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
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
      (await screen.findByRole("switch", { name: "Sync this workspace" })).getAttribute("aria-checked"),
    ).toBe("false");
  });

  // Turning sync on re-reads the status this gate is derived from, so the
  // list arrives without a restart or a workspace switch.
  it("offers the live document list once this workspace syncs", async () => {
    let workspaceSynced = false;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(async () => {
        workspaceSynced = true;
      }),
    });
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced,
      workspaceSyncConnected: workspaceSynced,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await openCloudSettings(user);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-row-live-documents")).toBeNull();

    await user.click(await screen.findByRole("switch", { name: "Sync this workspace" }));

    expect(bridge.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId });
    expect(await screen.findByTestId("settings-row-live-documents")).toBeTruthy();
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

  it("opens Settings' Sync and sharing page while signed in", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => ({
      connected: true,
      email: "me@dohc.test",
      serverUrl: "https://cloud.dohc.test",
      workspaceSynced: false,
    }));
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

    await openFromPalette(user);

    const section = await screen.findByTestId("settings-section-cloud");
    expect(within(section).getByTestId("settings-row-account").textContent).toContain("me@dohc.test");
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
  });

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
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });

  // The next step after signing in is the sync switch, so the dialog hands
  // over to the page that holds it.
  it("moves on to Settings' Sync and sharing page once sign-in completes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let connected = false;
      const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
        cloudLoginStart: vi.fn(async () => ({ userCode: "ABCD", verificationUri: "https://cloud.dohc.test/device" })),
        cloudLoginPoll: vi.fn(async () => {
          connected = true;
          return { status: "complete" as const, email: "me@dohc.test" };
        }),
      });
      bridge.cloudStatus = vi.fn(async () =>
        connected
          ? { connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false }
          : SIGNED_OUT,
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderShell(bridge);
      await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

      await openFromPalette(user);
      await user.type(await screen.findByTestId("cloud-server-url"), "https://cloud.dohc.test");
      await user.click(screen.getByTestId("cloud-connect-start"));
      await screen.findByTestId("cloud-user-code");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      const section = await screen.findByTestId("settings-section-cloud");
      expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
      expect((await within(section).findByTestId("settings-row-account")).textContent).toContain("me@dohc.test");
      expect(within(section).getByRole("switch", { name: "Sync this workspace" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // The titlebar's workspace menu holds Connect server.
  const connectFromTitlebarMenu = async (bridge: ReturnType<typeof makeBridge>) => {
    bridge.showWorkbenchMenu.mockResolvedValueOnce("connect-cloud");
    fireEvent.contextMenu(await screen.findByTestId("workspace-switcher"));
    await waitFor(() => expect(bridge.showWorkbenchMenu).toHaveBeenCalledWith(expect.objectContaining({ context: "status" })));
  };

  it.each([
    ["signed in, to Settings", { connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false }, "settings-section-cloud"],
    ["signed out, to the Cloud dialog", SIGNED_OUT, "cloud-server-url"],
  ] as const)("routes the titlebar menu's Connect server the same way: %s", async (_case, status, opens) => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => status);
    renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());
    await act(async () => {});

    await connectFromTitlebarMenu(bridge);

    expect(await screen.findByTestId(opens)).toBeTruthy();
    if (status.connected) expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    else expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });

  // Nobody knows yet whether the person is signed in. The dialog would show
  // a session's account row a second time, so Settings answers instead.
  it("opens Settings while the status is still unknown", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(() => new Promise<never>(() => {}));
    renderShell(bridge, WORKSPACE, [WORKSPACE, OTHER_WORKSPACE]);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

    await connectFromTitlebarMenu(bridge);

    expect(await screen.findByTestId("settings-cloud-checking")).toBeTruthy();
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
  });

  // The shell's status said signed out, but the dialog's own check finds a
  // session: the dialog hands it to Settings rather than showing the account.
  it("hands a session the dialog finds to Settings", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn()
      .mockResolvedValueOnce(SIGNED_OUT)
      .mockResolvedValue({ connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false });
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(1));
    await act(async () => {});

    await openFromPalette(user);

    const section = await screen.findByTestId("settings-section-cloud");
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
    expect((await within(section).findByTestId("settings-row-account")).textContent).toContain("me@dohc.test");
    expect(screen.getAllByTestId("settings-row-account")).toHaveLength(1);
  });

  // Access's setup notes, in About and the Sharing view: signed out, Connect
  // server starts the connect flow; signed in to an account the workspace's
  // sync does not match, the note opens Settings, where Try again lives.
  it.each([
    ["signed out", SIGNED_OUT, "sharing-received-unknown", "signed-out", "Connect server", "cloud-server-url"],
    [
      "paused for its account",
      { connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: true, workspaceSyncConnected: false },
      "sharing-granted-unknown", "other-account", "Sync and sharing", "settings-section-cloud",
    ],
  ] as const)("routes Access's setup action when %s", async (_case, status, noteId, reason, action, opens) => {
    const unknownAnswer = {
      ref: null, rows: [], visibility: "unknown" as const, nextCursor: null, checkedAtMs: null, freshness: "unknown" as const,
      coverage: { kind: "unavailable" as const, complete: false, observation: "interval" as const },
    };
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      listSharingAccess: vi.fn(async () => unknownAnswer),
      requestAccessRefresh: vi.fn(async () => undefined),
    });
    bridge.cloudStatus = vi.fn(async () => status);
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalled());

    await user.click(await screen.findByTestId("activity-sharing"));
    const note = await screen.findByTestId(noteId);
    await waitFor(() => expect(note.getAttribute("data-reason")).toBe(reason));
    await user.click(within(note).getByRole("button", { name: action }));

    expect(await screen.findByTestId(opens)).toBeTruthy();
    if (opens === "settings-section-cloud") {
      expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
      expect(await screen.findByTestId("cloud-relink-workspace")).toBeTruthy();
    } else {
      expect(screen.queryByTestId("settings-dialog")).toBeNull();
    }
  });
});

// Turning sync on sends no session event, and the switch shows on from the
// click, which invites closing Settings. The answer still reaches the shell.
describe("sync answers after Settings closed", () => {
  const SIGNED_IN = { connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false };

  async function startEnableThenClose(bridge: ReturnType<typeof makeBridge> & { cloudEnableSync: ReturnType<typeof vi.fn> }) {
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("activity-settings"));
    await user.click(await screen.findByTestId("settings-nav-cloud"));
    await user.click(await screen.findByRole("switch", { name: "Sync this workspace" }));
    await waitFor(() => expect(bridge.cloudEnableSync).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
  }

  it("reads the status again when an enable finishes after Settings closed", async () => {
    const enable = deferred<void>();
    let synced = false;
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(async () => {
        await enable.promise;
        synced = true;
      }),
    });
    bridge.cloudStatus = vi.fn(async () => ({ ...SIGNED_IN, workspaceSynced: synced, workspaceSyncConnected: synced }));
    renderShell(bridge);

    await startEnableThenClose(bridge);
    // Closing reads once, before the enable has finished.
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(2));
    expect(await bridge.cloudStatus.mock.results[1]!.value).toMatchObject({ workspaceSynced: false });
    await act(async () => {
      enable.resolve();
    });

    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(3));
    expect(await bridge.cloudStatus.mock.results[2]!.value).toMatchObject({ workspaceSynced: true });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  // Another window's Try again can make main adopt this account's saved
  // session without a session announcement. Closing Settings reads the
  // status again, so reopening shows the workspace syncing.
  it("reads the status again when Settings closes, after it changed elsewhere", async () => {
    let paused = true;
    const bridge = makeBridge(Promise.resolve(null));
    bridge.cloudStatus = vi.fn(async () => ({ ...SIGNED_IN, workspaceSynced: true, workspaceSyncConnected: !paused }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("activity-settings"));
    await user.click(await screen.findByTestId("settings-nav-cloud"));
    expect(await screen.findByTestId("cloud-workspace-relink")).toBeTruthy();
    expect(bridge.cloudStatus).toHaveBeenCalledTimes(1);

    paused = false;
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByTestId("activity-settings"));
    await user.click(await screen.findByTestId("settings-nav-cloud"));
    await screen.findByTestId("settings-row-sync-workspace");
    expect(screen.queryByTestId("cloud-workspace-relink")).toBeNull();
  });

  it("reports an enable that fails after Settings closed, and its Try again opens Settings", async () => {
    const enable = deferred<void>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(() => enable.promise),
    });
    bridge.cloudStatus = vi.fn(async () => SIGNED_IN);
    renderShell(bridge);

    await startEnableThenClose(bridge);
    await act(async () => {
      enable.reject(new Error("dohc could not reach the relay."));
    });

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not reach the relay.");
    // No page is watching the attempt, and the notice carries no address, so
    // Try again opens the place that holds the switch.
    await userEvent.setup().click(screen.getByTestId("workspace-shell-error-retry"));
    expect(await screen.findByTestId("settings-section-cloud")).toBeTruthy();
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    expect(bridge.cloudEnableSync).toHaveBeenCalledTimes(1);
  });

  // Pausing needs no account, so a signed-out pause's Try again goes back to
  // the switch, not to Connect server.
  it("reopens Settings for a signed-out pause that fails after Settings closed", async () => {
    const stop = deferred<never>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudStopSync: vi.fn(() => stop.promise),
    });
    bridge.cloudStatus = vi.fn(async () => ({
      connected: false, email: "", serverUrl: "", workspaceSynced: true, workspaceSyncConnected: false, workspaceSyncOwned: true,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("activity-settings"));
    await user.click(await screen.findByTestId("settings-nav-cloud"));
    // Signed out, nothing syncs, so Pause sync stands in for the switch.
    await user.click(await screen.findByRole("button", { name: "Pause sync" }));
    await waitFor(() => expect(bridge.cloudStopSync).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    await act(async () => {
      stop.reject(new Error("dohc could not pause sync for this workspace."));
    });

    await user.click(await screen.findByTestId("workspace-shell-error-retry"));
    expect(await screen.findByTestId("settings-section-cloud")).toBeTruthy();
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    expect(bridge.cloudStopSync).toHaveBeenCalledTimes(1);
  });

  it("does not show one workspace's failed enable in the next workspace", async () => {
    const enable = deferred<void>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudEnableSync: vi.fn(() => enable.promise),
    });
    bridge.cloudStatus = vi.fn(async () => SIGNED_IN);
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

    await startEnableThenClose(bridge);
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenLastCalledWith({ workspaceId: OTHER_WORKSPACE.workspaceId }));
    const reads = bridge.cloudStatus.mock.calls.length;
    await act(async () => {
      enable.reject(new Error("dohc could not reach the relay."));
    });

    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridge.cloudStatus.mock.calls.length).toBe(reads);
  });
});

// Disconnect reaches every workspace, so its failure is news in whichever
// workspace is open when it arrives, unlike an enable.
describe("a Disconnect failure after the workspace changed", () => {
  it.each([
    ["the same shell, given another workspace", false],
    ["a new shell for the other workspace", true],
  ])("reaches the open workspace's notices: %s", async (_case, remount) => {
    const logout = deferred<void>();
    let signedIn = true;
    const sessionListeners: Array<(event: { sessionKey: string | null; phase: "changing" | "ready" }) => void> = [];
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      cloudLogout: vi.fn(() => logout.promise),
    });
    bridge.onCloudSessionChanged = vi.fn((listener: (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void) => {
      sessionListeners.push(listener);
      return () => {};
    });
    bridge.cloudStatus = vi.fn(async () =>
      signedIn
        ? { connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test", workspaceSynced: false }
        : { connected: false, email: "", serverUrl: "", workspaceSynced: false },
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        {...(remount ? { key: workspace.workspaceId } : {})}
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    const view = render(shell(WORKSPACE));
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("activity-settings"));
    await user.click(await screen.findByTestId("settings-nav-cloud"));
    await user.click(await screen.findByTestId("cloud-disconnect"));
    await waitFor(() => expect(bridge.cloudLogout).toHaveBeenCalled());

    // Main announces the logout before the step that fails: the shell drops
    // its status, and the account row leaves the page.
    signedIn = false;
    act(() => {
      for (const listener of [...sessionListeners]) listener({ sessionKey: null, phase: "ready" });
    });
    await waitFor(() => expect(screen.queryByTestId("settings-row-account")).toBeNull());

    view.rerender(shell(OTHER_WORKSPACE));
    await act(async () => {
      logout.reject(new Error("dohc could not stop sync for Notes."));
    });

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      "dohc could not stop sync for Notes.",
    );
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

    const openConnect = async () => {
      await user.keyboard("{Control>}k{/Control}");
      await user.click(await screen.findByText("Connect server"));
    };
    await openConnect();
    await user.type(
      await screen.findByTestId("cloud-server-url"),
      "https://dohc.example.test",
    );
    await user.click(screen.getByTestId("cloud-connect-start"));
    await screen.findByTestId("workspace-shell-error");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
    await openConnect();
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
  // The run and Copy MCP config sit on the page of an agent you run.
  const agentYouRun = { name: "Terminal", hue: "rose" as const, changesFiles: true, enabled: false, timeoutMinutes: 30 };
  const openAgentPage = async (user: ReturnType<typeof userEvent.setup>, agentId: string) => {
    await user.click(await waitFor(() => {
      const row = document.querySelector<HTMLElement>(`[data-testid="agent-row"][data-agent-id="${agentId}"]`);
      if (!row) throw new Error(`No row for ${agentId}.`);
      return row;
    }));
  };
  it("retries a stopped run's history from Notices after Settings closes", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const run = { id: "run-old", startedAt: 1, agentId: "agent-1", onBehalfOf: "ice", status: "running" as const };
    let activeRun: typeof run | null = run;
    bridge.getAgentRunStatus.mockImplementation(async () => ({ activeRun, lastRun: null }));
    bridge.getUserSettings = vi.fn(async () => ({
      settings: { ...DEFAULT_USER_SETTINGS, agents: { "agent-1": agentYouRun } },
      source: "default" as const,
    }));
    bridge.endAgentRun.mockImplementationOnce(async () => {
      activeRun = null;
      throw new Error("Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    });
    const user = userEvent.setup();
    renderShell(bridge);
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await within(await screen.findByTestId("command-palette")).findByText("Settings: Open Agents (MCP)"));
    await openAgentPage(user, "agent-1");
    await waitFor(() => expect(screen.getByTestId("mcp-status").getAttribute("data-state")).toBe("running"));
    await user.click(screen.getByTestId("mcp-enable-toggle"));
    await screen.findByTestId("workspace-shell-error");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = await within(await screen.findByTestId("notice-center")).findByText("Repair .dohc/agent-runs/0123456789abcdef0123456789abcdef.json, then try again.");
    const row = notice.closest("li");
    if (!row) throw new Error("The agent failure has no Notices row.");
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.endAgentRun).toHaveBeenCalledTimes(2));
    expect(bridge.endAgentRun).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE.workspaceId, runId: run.id });
    expect(bridge.startAgentRun).not.toHaveBeenCalled();
  });

  it("keeps an agent settings retry in Notices when it fails after Settings closes", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const message = "dohc could not load agent settings.";
    bridge.getMcpConfig.mockRejectedValueOnce(new Error(message));
    const user = userEvent.setup();
    renderShell(bridge);
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await within(await screen.findByTestId("command-palette")).findByText("Settings: Open Agents (MCP)"));
    await screen.findByTestId("workspace-shell-error");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    bridge.getMcpConfig.mockRejectedValueOnce(new Error(message));
    await user.click(screen.getByTestId("workspace-shell-error-retry"));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(message);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = await within(await screen.findByTestId("notice-center")).findByText(message);
    const row = notice.closest("li");
    if (!row) throw new Error("The load failure has no Notices row.");
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.getMcpConfig).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText(message)).toBeNull());
  });

  it("shows the launcher error without a copyable config", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.getMcpConfig = vi.fn(
      async (): Promise<McpConfigResult> => ({
        unavailable: true,
        message: "dohc could not prepare its MCP launcher. Restart dohc to try again.",
      }),
    );
    bridge.getUserSettings = vi.fn(async () => ({
      settings: { ...DEFAULT_USER_SETTINGS, agents: { terminal: agentYouRun } },
      source: "default" as const,
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.keyboard("{Control>}k{/Control}");
    await user.click(
      await within(await screen.findByTestId("command-palette")).findByText(
        "Settings: Open Agents (MCP)",
      ),
    );
    await openAgentPage(user, "terminal");

    expect((await screen.findByTestId("mcp-unavailable")).textContent).toBe(
      "dohc could not prepare its MCP launcher. Restart dohc to try again.",
    );
    expect(
      (screen.getByRole("button", { name: "Copy MCP config" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// The folder holds only the active version's files, so a document too large
// for live editing opens only in the version its refusal names.
describe("documents too large for live editing", () => {
  const declinedIn = (versionId: string): SyncStatusResult => ({
    ...SYNC_STATUS,
    sharingDeclined: [{
      path: "notes/large.md",
      objectId: "object-1",
      versionId,
      lineagePruned: true,
      headBlobSha256: "a".repeat(64),
      constraint: "MAX_YDOC_UPDATE_BYTES",
      limitBytes: 262_144,
      observedBytes: 280_001,
    }],
  });

  it("opens the document when its refusal is in the active version", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => declinedIn("main"));
    bridge.getSyncStatus = vi.fn(async () => declinedIn("main"));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("sharing-declined-toast-open"));
    expect(await screen.findByTestId("tab-notes/large.md")).toBeTruthy();
  });

  it("names the version to switch to instead of opening the active version's file", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    bridge.openWorkspace = vi.fn(async () => declinedIn("draft"));
    bridge.getSyncStatus = vi.fn(async () => declinedIn("draft"));
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        { id: "main", name: "Main", kind: "main" as const, createdAtMs: 0, canMergeIntoMain: false },
        { id: "draft", name: "Draft", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true },
      ],
      activeVersionId: "main",
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await user.click(await screen.findByTestId("sharing-declined-toast-open"));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      '"notes/large.md" is in the version "Draft". Switch to that version to open it.',
    );
    expect(screen.queryByTestId("tab-notes/large.md")).toBeNull();
  });

  it("opens the selected version when an object has two declines", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const status = {
      ...SYNC_STATUS,
      sharingDeclined: [
        ...declinedIn("main").sharingDeclined!,
        ...declinedIn("draft").sharingDeclined!,
      ],
    };
    bridge.openWorkspace = vi.fn(async () => status);
    bridge.getSyncStatus = vi.fn(async () => status);
    bridge.listWorkspaceVersions = vi.fn(async () => ({
      versions: [
        { id: "main", name: "Main", kind: "main" as const, createdAtMs: 0, canMergeIntoMain: false },
        { id: "draft", name: "Draft", kind: "named" as const, createdAtMs: 1, canMergeIntoMain: true },
      ],
      activeVersionId: "main",
    }));
    const user = userEvent.setup();
    renderShell(bridge);

    await screen.findByTestId("sharing-declined-toast-open");
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByTestId("notice-sharing-declined-draft:object-1"))
      .getByRole("button", { name: "Open document" }));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(
      '"notes/large.md" is in the version "Draft". Switch to that version to open it.',
    );
    expect(screen.queryByTestId("tab-notes/large.md")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByTestId("notice-sharing-declined-main:object-1"))
      .getByRole("button", { name: "Open document" }));
    expect(await screen.findByTestId("tab-notes/large.md")).toBeTruthy();
  });
});

// The notice is the shell's, so its Undo outlives the Explorer, which the
// side panel unmounts when it hides or shows another view.
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

  const shell = (bridge: ReturnType<typeof undoBridge>, workspace: Workspace) => (
    <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(bridge)} onSwitchWorkspace={() => {}} />
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
    await waitFor(() => expect(bridge.undoHistoryOperation).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId, operationId: DELETED }));
    expect(await screen.findAllByText("Restored a.md")).not.toHaveLength(0);
  });

  // DesktopRoot remounts the shell on a switch; these rerender the same
  // instance, the stricter case.
  it("never shows workspace A's late delete in workspace B", async () => {
    const bridge = undoBridge();
    const deleted = deferred<{ trashed: boolean; operationId: string; undo: { available: true } }>();
    bridge.deleteWorkspacePath.mockReturnValueOnce(deleted.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, WORKSPACE));
    await deleteFromMenu("a.md");
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, OTHER_WORKSPACE));
    await act(async () => deleted.resolve({ trashed: true, operationId: DELETED, undo: { available: true } }));
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
    await act(async () => undone.resolve({ ok: false, reason: "Cannot undo the delete.", refusal: { code: "unexplained" } }));
    expect(screen.queryByText("Cannot restore a.md.")).toBeNull();
  });

  const RENAMED = "dohc-operation:33333333-3333-4333-8333-333333333333";
  async function renameTo(user: ReturnType<typeof userEvent.setup>, path: string, name: string) {
    await user.click((await screen.findAllByTestId("tree-row")).find((row) => row.dataset.path === path)!);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, `${name}{Enter}`);
  }

  it("says to stop live editing when that refused the Undo, and opens Live documents at the page", async () => {
    const reason = "dohc can't undo renaming \"b.md\" while it has live editing on\nIn Live documents, stop live editing for this page, then try again.";
    const bridge = Object.assign(undoBridge(), {
      moveWorkspacePath: vi.fn(async () => ({ path: "b.md", operationId: RENAMED, undo: { available: true as const } })),
    });
    bridge.undoHistoryOperation.mockResolvedValueOnce({ ok: false, reason, refusal: { code: "live-page-owned", path: "b.md" } });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: "b.md", objectId: "object-b", status: "ready" as const, canResume: false }] }));
    const user = userEvent.setup();
    renderShell(bridge);
    await renameTo(user, "a.md", "b");
    await screen.findAllByText("Renamed a.md to b.md");
    await undoFromNotices(user);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText("Cannot undo the rename. Stop live editing for b.md first.")).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("live-document-row-b.md").getAttribute("aria-current")).toBe("true"));
  });

  it("never shows workspace A's live-page refusal in workspace B", async () => {
    const title = `dohc can't rename "a.md" while it has live editing on`;
    const refused = deferred<never>();
    const bridge = Object.assign(undoBridge(), { moveWorkspacePath: vi.fn().mockReturnValueOnce(refused.promise) });
    vi.stubGlobal("dohcDesktop", bridge);
    const user = userEvent.setup();
    const view = render(shell(bridge, WORKSPACE));
    await renameTo(user, "a.md", "b");
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, OTHER_WORKSPACE));
    await act(async () => refused.reject(new Error(`Error invoking remote method 'desktop:move-workspace-path': LivePageOwnedError: dohc can't move "a.md" while it has live editing on
In Live documents, stop live editing for this page, then move it again.`)));
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Live documents" })).toBeNull();
  });
});

describe("a refused folder move", () => {
  const TITLE = `dohc can't move "box" while a page in it has live editing on`;
  const BODY = "In Live documents, stop live editing for every page in this folder, then move the folder again.";
  it("goes away when the same move later succeeds by hand", async () => {
    const refusal = new Error(`Error invoking remote method 'desktop:move-workspace-path': LiveFolderError: ${TITLE}\n${BODY}`);
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce({ path: "moved", undo: { available: false, reason: "", paths: [] } }),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "box/page.md", kind: "file" as const }], folders: ["box"] });
    renderShell(bridge);
    const user = userEvent.setup();
    const rename = async () => {
      const row = (await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === "box")!;
      await user.click(row);
      await user.keyboard("{F2}");
      const input = await screen.findByTestId("tree-edit-input");
      await user.clear(input);
      await user.type(input, "moved{Enter}");
    };
    await rename();
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(TITLE);
    expect(toast.textContent).toContain(BODY);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const row = (await within(notices).findByText(TITLE)).closest("li")!;
    expect(within(row).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Open Live documents" })).toBeTruthy();
    await user.click(screen.getByTestId("notice-center-toggle"));
    // The person stops live editing, then renames the folder again.
    await rename();
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
    expect(bridge.moveWorkspacePath).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE.workspaceId, fromPath: "box", toPath: "moved" });
    await waitFor(() => expect(screen.queryByTestId("workspace-shell-error")).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    const reopened = await screen.findByTestId("notice-center");
    expect(within(reopened).queryByText(TITLE)).toBeNull();
  });
});

describe("a folder refused in a delete of several rows", () => {
  const TITLE = `dohc can't delete "box" while a page in it has live editing on`;
  const BODY = "In Live documents, stop live editing for every page in this folder, then delete the folder again.";
  it("keeps its own notice and Open Live documents after another row failed first", async () => {
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "archive") throw new Error("Error invoking remote method 'desktop:delete-workspace-path': Error: The disk is full.");
      if (relativePath === "box") throw new Error(`Error invoking remote method 'desktop:delete-workspace-path': LiveFolderError: ${TITLE}\n${BODY}`);
    });
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), { deleteWorkspacePath });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "box/page.md", kind: "file" as const }], folders: ["archive", "box"] });
    renderShell(bridge);
    const user = userEvent.setup();
    const row = async (path: string) => (await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === path)!;
    await user.click(await row("archive"));
    await user.keyboard("{Shift>}");
    await user.click(await row("box"));
    await user.keyboard("{/Shift}{Delete}");
    // Only the newest failure is a toast, so the folder's notice waits in Notices.
    await screen.findByTestId("workspace-shell-error");
    expect(deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath)).toEqual(["archive", "box"]);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    const notice = (await within(notices).findByText(TITLE)).closest("li")!;
    expect(notice.textContent).toContain(BODY);
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Open Live documents" })).toBeTruthy();
    expect(notices.textContent).toContain("The disk is full.");
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

  it("names the page it would replace when that page has live editing on", async () => {
    const REPLACE_TITLE = `dohc can't replace "b.md" while it has live editing on`;
    const REPLACE_BODY = "In Live documents, stop live editing for this page, then try again.";
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn().mockRejectedValueOnce(new Error(`Error invoking remote method 'desktop:move-workspace-path': LivePageOwnedError: ${REPLACE_TITLE}\n${REPLACE_BODY}`)),
    });
    // b.md's file is gone, but this computer still has live editing on for it.
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "a.md", kind: "file" as const }], folders: [] });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: "b.md", objectId: "object-b", status: "ready" as const, canResume: false }] }));
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click((await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === "a.md")!);
    await user.keyboard("{F2}");
    const input = await screen.findByTestId("tree-edit-input");
    await user.clear(input);
    await user.type(input, "b{Enter}");
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(REPLACE_TITLE)).toBeTruthy();
    expect(within(toast).getByText(REPLACE_BODY)).toBeTruthy();
    expect(within(toast).queryByText(TITLE)).toBeNull();
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("live-document-row-b.md").getAttribute("aria-current")).toBe("true"));
  });
});

describe("a refused delete of a page this computer owns live", () => {
  const TITLE = `dohc can't delete "a.md" while it has live editing on`;
  const BODY = "In Live documents, stop live editing for this page, then delete it again.";
  const treePaths = async () => (await screen.findAllByTestId("tree-row")).map(row => row.dataset.path);

  it("keeps the page in the tree the whole time, says delete, and offers Try again and Live documents", async () => {
    const refused = deferred<never>();
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn().mockReturnValueOnce(refused.promise).mockResolvedValueOnce(undefined),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "a.md", kind: "file" as const }], folders: [] });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: "a.md", objectId: "object-a", status: "ready" as const, canResume: false }] }));
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click((await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === "a.md")!);
    await user.keyboard("{Delete}");
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledTimes(1));
    // While the delete runs, the page stays.
    expect(await treePaths()).toContain("a.md");
    bridge.listWorkspaceFiles.mockImplementation(() => new Promise(() => undefined));
    refused.reject(new Error(`Error invoking remote method 'desktop:delete-workspace-path': LivePageOwnedError: ${TITLE}\n${BODY}`));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(await treePaths()).toContain("a.md");
    expect(toast.querySelector("[id$='-title']")?.textContent).toBe(TITLE);
    expect(toast.querySelector("[id$='-body']")?.textContent).toBe(BODY);
    expect(within(toast).queryByRole("button", { name: /Stop|Undo/u })).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    expect(within(notice).getByText(BODY)).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(notice).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("live-document-row-a.md").getAttribute("aria-current")).toBe("true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    // Live editing stopped: Try again deletes the same page.
    // The pointer read the row on its way to Open Live documents, so its toast
    // stays closed and Try again waits in Notices.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const again = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.deleteWorkspacePath).toHaveBeenCalledTimes(2));
    expect(bridge.deleteWorkspacePath).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: WORKSPACE.workspaceId, relativePath: "a.md" }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
  });

  it("deletes the rest of a selection and names every refused page in one notice", async () => {
    const SEVERAL = `dohc can't delete "a.md" and "c.md" while they have live editing on`;
    const SEVERAL_BODY = "In Live documents, stop live editing for these pages, then delete them again.";
    const refusal = (path: string) => new Error(`Error invoking remote method 'desktop:delete-workspace-path': LivePageOwnedError: dohc can't delete "${path}" while it has live editing on\n${BODY}`);
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath !== "b.md") throw refusal(relativePath);
    });
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), { deleteWorkspacePath });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: ["a.md", "b.md", "c.md"].map(path => ({ path, kind: "file" as const })), folders: [] });
    renderShell(bridge);
    const user = userEvent.setup();
    const row = async (path: string) => (await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === path)!;
    await user.click(await row("a.md"));
    await user.keyboard("{Shift>}");
    await user.click(await row("c.md"));
    await user.keyboard("{/Shift}{Delete}");
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(deleteWorkspacePath.mock.calls.map(([input]) => input.relativePath)).toEqual(["a.md", "b.md", "c.md"]);
    expect(toast.querySelector("[id$='-title']")?.textContent).toBe(SEVERAL);
    expect(toast.querySelector("[id$='-body']")?.textContent).toBe(SEVERAL_BODY);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(within(notices).getAllByText(SEVERAL)).toHaveLength(1);
    const notice = within(notices).getByText(SEVERAL).closest("li")!;
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Open Live documents" })).toBeTruthy();
    // Copy details names every refused page, however many the title shows.
    await user.click(within(notice).getByRole("button", { name: "Details" }));
    await user.click(within(notice).getByRole("button", { name: "Copy details" }));
    expect((await navigator.clipboard.readText()).split("\n")).toEqual(expect.arrayContaining(["File: a.md", "File: c.md"]));
  });

  it("takes a selection's notice back once one of its pages is deleted, after the sidebar was hidden", async () => {
    const SEVERAL = `dohc can't delete "a.md" and "c.md" while they have live editing on`;
    const refusal = (path: string) => new Error(`Error invoking remote method 'desktop:delete-workspace-path': LivePageOwnedError: dohc can't delete "${path}" while it has live editing on\n${BODY}`);
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath !== "b.md") throw refusal(relativePath);
    });
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), { deleteWorkspacePath });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: ["a.md", "b.md", "c.md"].map(path => ({ path, kind: "file" as const })), folders: [] });
    renderShell(bridge);
    const user = userEvent.setup();
    const row = async (path: string) => (await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === path)!;
    await user.click(await row("a.md"));
    await user.keyboard("{Shift>}");
    await user.click(await row("c.md"));
    await user.keyboard("{/Shift}{Delete}");
    await screen.findByText(SEVERAL);
    // Hiding the sidebar unmounts Explorer, and its notice stays in Notices.
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("side-panel")).toBeNull());
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    await screen.findByTestId("side-panel");
    deleteWorkspacePath.mockResolvedValue(undefined);
    await user.click(await row("a.md"));
    await user.keyboard("{Delete}");
    await waitFor(() => expect(deleteWorkspacePath).toHaveBeenLastCalledWith(expect.objectContaining({ relativePath: "a.md" })));
    await waitFor(() => expect(screen.queryByText(SEVERAL)).toBeNull());
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).queryByText(SEVERAL)).toBeNull();
  });
});

describe("a refused drag of a page this computer owns live", () => {
  const TITLE = `dohc can't move "a.md" while it has live editing on`;
  const BODY = "In Live documents, stop live editing for this page, then move it again.";

  it("says move, keeps the page where it was, keeps the folder for Try again, and opens its Live documents row", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      moveWorkspacePath: vi.fn()
        .mockRejectedValueOnce(new Error(`Error invoking remote method 'desktop:move-workspace-path': LivePageOwnedError: ${TITLE}\n${BODY}`))
        .mockResolvedValueOnce({ path: "docs/a.md", undo: { available: false, reason: "", paths: [] } }),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "a.md", kind: "file" as const }, { path: "docs/b.md", kind: "file" as const }], folders: ["docs"] });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: "a.md", objectId: "object-a", status: "ready" as const, canResume: false }] }));
    renderShell(bridge);
    const user = userEvent.setup();
    const rows = await screen.findAllByTestId("tree-row");
    const dataTransfer = { effectAllowed: "move", dropEffect: "move", files: [], types: [], setData: vi.fn() };
    fireEvent.dragStart(rows.find(row => row.dataset.path === "a.md")!, { dataTransfer });
    fireEvent.dragOver(rows.find(row => row.dataset.path === "docs")!, { dataTransfer });
    fireEvent.drop(rows.find(row => row.dataset.path === "docs")!, { dataTransfer });
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.querySelector("[id$='-title']")?.textContent).toBe(TITLE);
    expect(toast.querySelector("[id$='-body']")?.textContent).toBe(BODY);
    const paths = (await screen.findAllByTestId("tree-row")).map(row => row.dataset.path);
    expect(paths).toContain("a.md");
    expect(paths).not.toContain("docs/a.md");
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    await user.click(within(notice).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("live-document-row-a.md").getAttribute("aria-current")).toBe("true"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("live-documents-dialog")).toBeNull());
    // The pointer read the row on its way to Open Live documents, so its toast
    // stays closed and Try again waits in Notices.
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const again = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    await user.click(within(again).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bridge.moveWorkspacePath).toHaveBeenCalledTimes(2));
    expect(bridge.moveWorkspacePath).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE.workspaceId, fromPath: "a.md", toPath: "docs/a.md" });
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
  });
});

describe("a page delete refused while History is off", () => {
  const TITLE = `dohc can't delete "a.md" while History is off`;
  const BODY = "Without History, dohc can't check whether this page has live editing on. Restart dohc to try again.";

  it("keeps the page, shows the words, and offers neither Try again nor Live documents", async () => {
    const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
      deleteWorkspacePath: vi.fn().mockRejectedValueOnce(new Error(`Error invoking remote method 'desktop:delete-workspace-path': HistoryOffError: ${TITLE}\n${BODY}`)),
    });
    bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] },
      files: [{ path: "a.md", kind: "file" as const }], folders: [] });
    renderShell(bridge);
    const user = userEvent.setup();
    await user.click((await screen.findAllByTestId("tree-row")).find(candidate => candidate.dataset.path === "a.md")!);
    await user.keyboard("{Delete}");
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.querySelector("[id$='-title']")?.textContent).toBe(TITLE);
    expect(toast.querySelector("[id$='-body']")?.textContent).toBe(BODY);
    expect((await screen.findAllByTestId("tree-row")).map(row => row.dataset.path)).toContain("a.md");
    expect(within(toast).queryByRole("button", { name: /Try again|Open Live documents|Undo/u })).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = (await within(await screen.findByTestId("notice-center")).findByText(TITLE)).closest("li")!;
    expect(within(notice).queryByRole("button", { name: /Try again|Open Live documents/u })).toBeNull();
  });
});

// An account dohc can't confirm is not the server's fault. Its row reads the
// account again the way Settings' Try again does, opens Settings at the sync
// row, and pauses nothing: once the account is confirmed, sync reads normal.
it("reads the account again from Notices, opens Sync settings, and pauses nothing", async () => {
  let status: SyncStatusResult = { ...SYNC_STATUS, state: "account-unconfirmed" };
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudEnableSync: vi.fn(async () => {
      status = { ...SYNC_STATUS };
      return status;
    }),
    cloudStopSync: vi.fn(),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => ({
    connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
    workspaceSynced: true, workspaceSyncConnected: status.state !== "account-unconfirmed",
  }));
  renderShell(bridge);
  const user = userEvent.setup();

  expect((await screen.findByTestId("sync-status")).textContent).toBe("Couldn't confirm account");
  await user.click(await screen.findByTestId("notice-center-toggle"));
  await user.click(within(await screen.findByTestId("notice-account-unconfirmed")).getByRole("button", { name: "Sync settings" }));
  expect(await screen.findByTestId("settings-row-sync-workspace")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());

  await user.click(screen.getByTestId("notice-center-toggle"));
  await user.click(within(await screen.findByTestId("notice-account-unconfirmed")).getByRole("button", { name: "Try again" }));
  expect(bridge.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId });
  // Main pushes the confirmed status, and the title bar and Notices read
  // normal with nothing else clicked.
  act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
  await waitFor(() => expect(screen.getByTestId("sync-status").getAttribute("data-state")).toBe("synced"));
  expect(screen.queryByTestId("notice-account-unconfirmed")).toBeNull();
  expect(bridge.cloudStopSync).not.toHaveBeenCalled();
});

// Nobody is connected, which is a choice, not a fault. Its row offers the same
// connect flow as Settings' Connect server, never Try again, and pauses
// nothing.
it("offers Connect server from Notices while nobody is connected, and pauses nothing", async () => {
  const status: SyncStatusResult = { ...SYNC_STATUS, state: "not-connected" };
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudEnableSync: vi.fn(),
    cloudStopSync: vi.fn(),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => ({ connected: false, email: "", serverUrl: "", workspaceSynced: true }));
  renderShell(bridge);
  const user = userEvent.setup();

  const title = await screen.findByTestId("sync-status");
  expect(title.textContent).toBe("Connect server to sync");
  expect(title.textContent).not.toBe("Couldn't confirm account");
  await user.click(await screen.findByTestId("notice-center-toggle"));
  const row = await screen.findByTestId("notice-not-connected");
  expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
  await user.click(within(row).getByRole("button", { name: "Connect server" }));
  expect(await screen.findByTestId("cloud-sync-panel")).toBeTruthy();
  expect(bridge.cloudEnableSync).not.toHaveBeenCalled();
  expect(bridge.cloudStopSync).not.toHaveBeenCalled();
});

// The server stopped accepting the sign-in. Sign in again in Notices starts
// the same sign-in at that server, with no Disconnect first. Main rebuilds
// the engine on the new session, so sync resumes with nothing else clicked:
// no enable, no pause, and no Settings to finish in.
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

// The dialog closed after a renewal failed. The notice's Try again still
// signs in again at that server: the expired session is saved, and a plain
// dialog would hand it to Settings and start nothing.
it("signs in again at the same server from a failed renewal's notice after the dialog closes", async () => {
  const status: SyncStatusResult = { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true };
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudLoginStart: vi.fn(async (_payload: { serverUrl: string }) => {
      throw new Error("dohc couldn't reach this server.");
    }),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => ({
    connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
    workspaceSynced: true, workspaceSyncConnected: true,
  }));
  const user = userEvent.setup();
  renderShell(bridge);

  await user.click(await screen.findByTestId("notice-center-toggle"));
  const row = await screen.findByTestId("notice-sign-in-expired");
  await user.click(within(row).getByRole("button", { name: "Sign in again" }));
  await screen.findByTestId("workspace-shell-error");
  expect(bridge.cloudLoginStart).toHaveBeenCalledTimes(1);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
  await user.click(screen.getByTestId("workspace-shell-error-retry"));

  await waitFor(() => expect(bridge.cloudLoginStart).toHaveBeenCalledTimes(2));
  expect(bridge.cloudLoginStart).toHaveBeenLastCalledWith({ serverUrl: "https://cloud.dohc.test" });
  expect(await screen.findByTestId("cloud-renew")).toBeTruthy();
  expect(screen.queryByTestId("settings-dialog")).toBeNull();
});

// The renewal's first step, the status check, failed. Its notice still signs
// in again once the dialog has closed, instead of opening Settings.
it("signs in again from a renewal's failed status check after the dialog closes", async () => {
  const status: SyncStatusResult = { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true };
  let failStatus = false;
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudLoginStart: vi.fn(async (_payload: { serverUrl: string }) => ({
      userCode: "ABCD", verificationUri: "https://cloud.dohc.test/device",
    })),
    cloudLoginPoll: vi.fn(async () => ({ status: "pending" as const })),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => {
    if (failStatus) {
      failStatus = false;
      throw new Error("The engine stopped answering.");
    }
    return {
      connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true, workspaceSyncConnected: true,
    };
  });
  const user = userEvent.setup();
  renderShell(bridge);

  await user.click(await screen.findByTestId("notice-center-toggle"));
  const row = await screen.findByTestId("notice-sign-in-expired");
  failStatus = true;
  await user.click(within(row).getByRole("button", { name: "Sign in again" }));
  await screen.findByTestId("workspace-shell-error");
  expect(bridge.cloudLoginStart).not.toHaveBeenCalled();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
  await user.click(screen.getByTestId("workspace-shell-error-retry"));

  await screen.findByTestId("cloud-user-code");
  expect(bridge.cloudLoginStart).toHaveBeenCalledWith({ serverUrl: "https://cloud.dohc.test" });
  expect(screen.queryByTestId("settings-dialog")).toBeNull();
});

// A connection that failed before the sign-in expired keeps its notice. Its
// Try again during a renewal leaves the renewal a renewal, so the renewal's
// own failure still signs in again from its notice after the dialog closes.
it("keeps a renewal a renewal when an older connection notice is retried during it", async () => {
  const status: SyncStatusResult = { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true };
  let connected = false;
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudLoginStart: vi.fn(async (payload: { serverUrl: string }) => {
      throw new Error(`dohc couldn't reach ${payload.serverUrl}.`);
    }),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => (connected
    ? {
      connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
      workspaceSynced: true, workspaceSyncConnected: true,
    }
    : { connected: false, email: "", serverUrl: "", workspaceSynced: false }));
  const user = userEvent.setup();
  renderShell(bridge);
  // The first row with these words.
  const noticeRow = async (text: string) => {
    if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
    const [notice] = await within(await screen.findByTestId("notice-center")).findAllByText(text);
    const row = notice?.closest("li");
    if (!row) throw new Error(`"${text}" has no Notices row.`);
    return row;
  };

  // Signed out, a connection to another server fails.
  await user.keyboard("{Control>}k{/Control}");
  await user.click(await screen.findByText("Connect server"));
  await user.type(await screen.findByTestId("cloud-server-url"), "https://old.dohc.test");
  await user.click(screen.getByTestId("cloud-connect-start"));
  await screen.findByTestId("workspace-shell-error");
  connected = true;
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());

  // Signing in again after the sign-in expired fails too.
  await user.click(screen.getByTestId("notice-center-toggle"));
  await user.click(within(await screen.findByTestId("notice-sign-in-expired")).getByRole("button", { name: "Sign in again" }));
  await screen.findByTestId("cloud-renew");
  expect(bridge.cloudLoginStart).toHaveBeenLastCalledWith({ serverUrl: "https://cloud.dohc.test" });

  // The older notice's Try again restarts the renewal at its server.
  await user.click(within(await noticeRow("dohc couldn't reach https://old.dohc.test.")).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bridge.cloudLoginStart).toHaveBeenCalledTimes(3));
  expect(bridge.cloudLoginStart).toHaveBeenLastCalledWith({ serverUrl: "https://cloud.dohc.test" });
  expect(await screen.findByTestId("cloud-renew")).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByTestId("cloud-sync-panel")).toBeNull());
  await user.click(within(await noticeRow("dohc couldn't reach https://cloud.dohc.test.")).getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(bridge.cloudLoginStart).toHaveBeenCalledTimes(4));
  expect(bridge.cloudLoginStart).toHaveBeenLastCalledWith({ serverUrl: "https://cloud.dohc.test" });
  expect(await screen.findByTestId("cloud-renew")).toBeTruthy();
  expect(screen.queryByTestId("settings-dialog")).toBeNull();
});

// Two renewal attempts failed in one open dialog. The older failure's Try
// again signs in again there, rather than doing nothing and leaving.
it("signs in again from an older renewal notice while the dialog is still open", async () => {
  const status: SyncStatusResult = { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true };
  const failures = ["The server didn't answer.", "The sign-in code expired."];
  let attempt = 0;
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudLoginStart: vi.fn(async (_payload: { serverUrl: string }) => {
      attempt += 1;
      throw new Error(failures[attempt - 1] ?? "The server refused the sign-in.");
    }),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => ({
    connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
    workspaceSynced: true, workspaceSyncConnected: true,
  }));
  const user = userEvent.setup();
  renderShell(bridge);

  await user.click(await screen.findByTestId("notice-center-toggle"));
  await user.click(within(await screen.findByTestId("notice-sign-in-expired")).getByRole("button", { name: "Sign in again" }));
  await screen.findByTestId("cloud-renew");
  await user.click(await screen.findByTestId("cloud-renew-start"));
  await waitFor(() => expect(bridge.cloudLoginStart).toHaveBeenCalledTimes(2));

  if (!screen.queryByTestId("notice-center")) await user.click(screen.getByTestId("notice-center-toggle"));
  const notice = await within(await screen.findByTestId("notice-center")).findByText("The server didn't answer.");
  const row = notice.closest("li");
  if (!row) throw new Error("The first renewal's failure has no Notices row.");
  await user.click(within(row).getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(bridge.cloudLoginStart).toHaveBeenCalledTimes(3));
  expect(bridge.cloudLoginStart).toHaveBeenLastCalledWith({ serverUrl: "https://cloud.dohc.test" });
  expect(await screen.findByTestId("cloud-renew")).toBeTruthy();
  expect(screen.queryByTestId("settings-dialog")).toBeNull();
});

// Settings shows the same expired row: no switch reading on while nothing
// syncs, and Sign in again in Try again's place.
it.each([
  ["the title bar says so", { ...SYNC_STATUS, state: "sign-in-expired", signInExpired: true }, "Sign in again to sync"],
  // A conflict shows first, and the switch still mustn't read on.
  ["a conflict shows first", { ...SYNC_STATUS, state: "conflict", conflictCount: 1, signInExpired: true }, "Conflict (1)"],
] as const)("shows Sign in again in Settings while the sign-in is expired, never the switch, when %s", async (_, shown, label) => {
  const status: SyncStatusResult = shown;
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    cloudEnableSync: vi.fn(),
    cloudStopSync: vi.fn(),
    cloudLoginStart: vi.fn(async () => ({ userCode: "ABCD", verificationUri: "https://cloud.dohc.test/device" })),
  });
  bridge.openWorkspace = vi.fn(async () => status);
  bridge.getSyncStatus = vi.fn(async () => status);
  bridge.cloudStatus = vi.fn(async () => ({
    connected: true, email: "me@dohc.test", serverUrl: "https://cloud.dohc.test",
    workspaceSynced: true, workspaceSyncConnected: true,
  }));
  renderShell(bridge);
  const user = userEvent.setup();

  expect((await screen.findByTestId("sync-status")).textContent).toBe(label);
  // Signed in, Connect server opens Settings' Sync and sharing page.
  await user.keyboard("{Control>}k{/Control}");
  await user.click(await screen.findByText("Connect server"));
  const row = within(await screen.findByTestId("settings-row-sync-workspace"));
  expect(row.queryByRole("switch")).toBeNull();
  expect(row.getByTestId("cloud-workspace-sign-in-expired").textContent).toBe("This workspace isn't syncing until you sign in again.");
  expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual(["Sign in again", "Pause sync"]);
  await user.click(row.getByRole("button", { name: "Sign in again" }));
  await screen.findByTestId("cloud-user-code");
  expect(screen.queryByTestId("settings-dialog")).toBeNull();
  expect(bridge.cloudLoginStart).toHaveBeenCalledWith({ serverUrl: "https://cloud.dohc.test" });
  expect(bridge.cloudEnableSync).not.toHaveBeenCalled();
  expect(bridge.cloudStopSync).not.toHaveBeenCalled();
});
