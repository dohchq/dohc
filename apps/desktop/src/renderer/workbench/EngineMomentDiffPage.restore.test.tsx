// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { engineMomentDetailForIpc } from "../../ipc/engineHistoryIpc";
import { ipcWireError } from "../../ipc/errorWords";
import { neutralHistoryPresentations } from "../../testing/historyPageFixture";
import { useShellError } from "../shell/useShellError";
import { errorDetails } from "../shell/copyDetails";
import { EngineMomentDiffPage } from "./EngineMomentDiffPage";
import { momentDiffTabPath } from "./workbenchState";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const noop = () => {};
const workspaceId = "workspace";
const path = "kyoto.md";
const refusalWords = "This file is open for editing. Close its tabs, then try again.";
const refusalDetails = "Cause: DaemonRefusalError [INVALID_PARAMS]: ydoc-session-busy";
const text = { path, contentKind: "text" as const, sha256: "a".repeat(64), byteLength: 5, text: "After" };
const moment = engineMomentDetailForIpc({ protected: false, moment: {
  id: "change", workspaceId, versionId: "main", objectId: "object", path,
  recordedAtMs: 2, operation: "write", metadata: { origin: "local-file" },
  payload: { before: { ...text, text: "Before", byteLength: 6 }, after: text },
} }, {
  named: () => "Someone", agent: () => "Owner", person: () => undefined,
  automation: automationId => ({ name: automationId }), presentations: neutralHistoryPresentations,
});

async function open(sessionInitiallyOpen: boolean) {
  let sessionOpen = sessionInitiallyOpen;
  const refused = new DaemonRefusalError({ code: "INVALID_PARAMS", message: "ydoc-session-busy", retry: "no" }, null);
  const received = new Error(`Error invoking remote method 'desktop:restore-engine-moment-file': ${String(ipcWireError(refused))}`);
  const restoreEngineMomentFile = vi.fn(async ({ momentId }: { momentId: string }) => {
    if (sessionOpen) throw received;
    return { restored: "text" as const, path, restoredMomentId: momentId === "change" ? "restored-change" : "undone-change" };
  });
  vi.stubGlobal("dohcDesktop", { readEngineMoment: vi.fn(async () => ({ moment })), restoreEngineMomentFile });
  const shell = renderHook(() => useShellError(workspaceId));
  const onRestored = vi.fn();
  const onReopenRestore = vi.fn();
  const release = vi.fn();
  const onBeforeRestore = vi.fn(async () => release);
  const onError = vi.fn((fallback: string, error: unknown, retry: () => void, identity: string) => {
    shell.result.current.reportShellError(fallback, error, retry, undefined, identity);
  });
  const page = (restoreRequested = false) => <EngineMomentDiffPage workspaceId={workspaceId} tabPath={momentDiffTabPath("change")}
    onBeforeRestore={onBeforeRestore} onOpenFile={noop} onPathResolved={noop} registerActiveUndo={noop}
    onRestored={onRestored} onStopAndRestore={noop} onError={onError} onSettled={shell.result.current.clearIdentity}
    historyAnswer={null} onReopenRestore={onReopenRestore} restoreRequested={restoreRequested} onRestoreRequestTaken={noop} />;
  const view = render(page());
  await screen.findByTestId("engine-diff-restore-file");
  return { shell, restoreEngineMomentFile, onRestored, onReopenRestore, onError, onBeforeRestore, release,
    setSessionOpen: (open: boolean) => { sessionOpen = open; },
    reopen: () => view.rerender(page(true)),
  };
}

async function confirmRestore() {
  fireEvent.click(await screen.findByTestId("engine-diff-confirm-restore"));
}

it("explains a restore refused by an open session and retries through confirmation after it closes", async () => {
  const f = await open(true);
  fireEvent.click(screen.getByTestId("engine-diff-restore-file"));
  await confirmRestore();
  await waitFor(() => expect(f.shell.result.current.shellErrors).toHaveLength(1));
  const notice = f.shell.result.current.shellErrors[0]!;
  expect(notice.message).toBe(`dohc could not restore kyoto.md. ${refusalWords}`);
  expect(errorDetails(notice.details!)).toBe(refusalDetails);
  expect(notice.identity).toBe("history-restore:kyoto.md");
  expect(notice.retry).toEqual(expect.any(Function));
  expect(f.onRestored).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);

  f.setSessionOpen(false);
  act(() => f.shell.result.current.retryShellError(notice.id));
  expect(f.onReopenRestore).toHaveBeenCalledWith("change", path);
  expect(f.restoreEngineMomentFile).toHaveBeenCalledTimes(1);
  f.reopen();
  await confirmRestore();
  await screen.findByText("Restored the earlier state. Undo restore is available here.");
  expect(f.restoreEngineMomentFile.mock.calls).toEqual([
    [{ workspaceId, momentId: "change" }], [{ workspaceId, momentId: "change" }],
  ]);
  expect(f.onRestored).toHaveBeenCalledExactlyOnceWith("change");
  expect(f.shell.result.current.shellErrors).toHaveLength(0);
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("engine-diff-undo-restore")).toBeTruthy();
});

it("explains Undo restore refused by an open session and retries the same undo after it closes", async () => {
  const f = await open(false);
  fireEvent.click(screen.getByTestId("engine-diff-restore-file"));
  await confirmRestore();
  const undo = await screen.findByTestId("engine-diff-undo-restore");
  f.setSessionOpen(true);
  fireEvent.click(undo);
  await waitFor(() => expect(f.shell.result.current.shellErrors).toHaveLength(1));
  const notice = f.shell.result.current.shellErrors[0]!;
  expect(notice.message).toBe(`dohc could not undo the restore of kyoto.md. ${refusalWords}`);
  expect(errorDetails(notice.details!)).toBe(refusalDetails);
  expect(f.onRestored).toHaveBeenCalledExactlyOnceWith("change");
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("engine-diff-undo-restore").hasAttribute("disabled")).toBe(false);

  f.setSessionOpen(false);
  act(() => f.shell.result.current.retryShellError(notice.id));
  await screen.findByText("Undid the restore. This was recorded in history.");
  expect(f.restoreEngineMomentFile.mock.calls).toEqual([
    [{ workspaceId, momentId: "change" }], [{ workspaceId, momentId: "restored-change" }], [{ workspaceId, momentId: "restored-change" }],
  ]);
  expect(f.onReopenRestore).not.toHaveBeenCalled();
  expect(f.shell.result.current.shellErrors).toHaveLength(0);
  expect(f.release).toHaveBeenCalledTimes(3);
  expect(screen.queryByTestId("engine-diff-undo-restore")).toBeNull();
});
