// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { documentVersionKey } from "./documentVersionKey";
import { resetOrphanedDrafts, useOrphanedDrafts } from "./orphanedDrafts";
import { loadStoredDrafts } from "./orphanedDraftStorage";
import {
  acquireSharedLocalDocument,
  resetSharedLocalDocumentsForTests,
} from "./sharedLocalDocument";
import { useAutosavedTextDraft, type DraftFlush } from "./useAutosavedTextDraft";
import { EDITOR_WRITE_STALL_MS, hasPendingEditorDrafts, settlePendingEditorDrafts } from "./pendingEditorDrafts";
import { RecoveryCloseGuard, resetGuardedExits } from "./RecoveryCloseGuard";

type WriteResult = Awaited<ReturnType<DohcDesktopBridge["writeWorkspaceText"]>>;
const releases: Array<() => void> = [];

function documentProps(workspaceId: string, path: string, body: string) {
  const { buffer, release } = acquireSharedLocalDocument(
    documentVersionKey(workspaceId, path, undefined),
  );
  releases.push(release);
  const contentReadTicket = buffer.beginRead();
  const contentHash = `${workspaceId}-hash`;
  buffer.initializeRead(body, contentHash, contentReadTicket);
  return {
    workspaceId,
    path,
    body,
    contentHash,
    contentReadTicket,
    contentRequestId: 1,
    latestContentRequestId: 1,
    switchReadPending: false,
    switchUnresyncedRef: { current: false },
    refreshAfterConflict: vi.fn(),
    localBuffer: buffer,
  };
}

beforeEach(() => {
  resetOrphanedDrafts();
  resetSharedLocalDocumentsForTests();
});

afterEach(() => {
  cleanup();
  resetGuardedExits();
  for (const release of releases.splice(0)) release();
  resetOrphanedDrafts();
  resetSharedLocalDocumentsForTests();
  vi.unstubAllGlobals();
});

describe("useAutosavedTextDraft", () => {
  it.each(["notes.txt", ".env", "storage-refused.txt"])("captures a stalled exit for %s and fences late completion", async (path) => {
    vi.useFakeTimers();
    const held = deferred<WriteResult>();
    const later = deferred<WriteResult>();
    const writeWorkspaceText = vi.fn().mockReturnValueOnce(held.promise).mockReturnValueOnce(later.promise);
    vi.stubGlobal("dohcDesktop", { platform: "linux", writeWorkspaceText,
      onExitRound: () => () => {}, holdQuit: async () => {} });
    const refusal = path === "storage-refused.txt"
      ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); })
      : null;
    const close = vi.spyOn(window, "close").mockImplementation(() => {
      window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    });
    const editor = renderHook(useAutosavedTextDraft, {
      initialProps: documentProps("workspace", path, "before"),
      wrapper: ({ children }) => <RecoveryCloseGuard>{children}</RecoveryCloseGuard>,
    });
    try {
      act(() => editor.result.current.setDraft("first edit"));
      await act(async () => { window.dispatchEvent(new Event("beforeunload", { cancelable: true })); });
      expect(writeWorkspaceText).toHaveBeenCalledOnce();
      act(() => editor.result.current.setDraft("latest edit"));
      act(() => { window.dispatchEvent(new Event("beforeunload", { cancelable: true })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(close).toHaveBeenCalledOnce();
      const persisted = path === "notes.txt";
      expect(loadStoredDrafts(Date.now())).toEqual(persisted
        ? [expect.objectContaining({ text: "latest edit" })] : []);
      expect(screen.queryByTestId("recovery-close-warning") !== null).toBe(!persisted);
      expect(editor.result.current.saveState).toBe("error");
      act(() => editor.result.current.setDraft("newer edit"));
      await act(async () => { held.resolve({ status: "written", contentHash: "first-saved" }); });
      expect(editor.result.current.draft).toBe("newer edit");
      expect(editor.result.current.saveState).not.toBe("saved");
      expect(writeWorkspaceText).toHaveBeenCalledTimes(2);
      expect(writeWorkspaceText.mock.calls[1]![0].text).toBe("newer edit");
      await act(async () => { later.resolve({ status: "written", contentHash: "newer-saved" }); });
      expect(editor.result.current.draft).toBe("newer edit");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        held.resolve({ status: "written", contentHash: "first-saved" });
        later.resolve({ status: "written", contentHash: "newer-saved" });
      });
      refusal?.mockRestore();
      close.mockRestore();
      vi.useRealTimers();
    }
  });
  it("captures a retired editor without settling its original operation flush", async () => {
    vi.useFakeTimers();
    const held = deferred<WriteResult>();
    let flush: DraftFlush | null = null;
    const writeWorkspaceText = vi.fn().mockReturnValueOnce(held.promise)
      .mockResolvedValue({ status: "written", contentHash: "latest-saved" });
    vi.stubGlobal("dohcDesktop", { platform: "linux", writeWorkspaceText });
    const editor = renderHook(useAutosavedTextDraft, {
      initialProps: { ...documentProps("workspace", "retired.txt", "before"),
        registerDraftFlush: (next: DraftFlush | null) => { flush = next; } },
    });
    try {
      act(() => editor.result.current.setDraft("first"));
      let operationSettled = false;
      const operation = flush!().then(() => { operationSettled = true; });
      await act(async () => { await Promise.resolve(); });
      act(() => editor.result.current.setDraft("retired latest"));
      editor.unmount();
      const drain = settlePendingEditorDrafts();
      await act(async () => { await vi.advanceTimersByTimeAsync(EDITOR_WRITE_STALL_MS); });
      expect(await drain).toBe(true);
      expect(hasPendingEditorDrafts()).toBe(false);
      expect(operationSettled).toBe(false);
      expect(loadStoredDrafts(Date.now())).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: "retired latest" }),
      ]));
      await act(async () => { held.resolve({ status: "written", contentHash: "first-saved" }); await operation; });
      expect(operationSettled).toBe(true);
      expect(writeWorkspaceText.mock.calls.at(-1)![0].text).toBe("retired latest");
    } finally {
      await act(async () => { held.resolve({ status: "written", contentHash: "first-saved" }); });
      vi.useRealTimers();
    }
  });
  it("holds exit for the draft of an editor that already unmounted", async () => {
    const held = deferred<WriteResult>();
    const writeWorkspaceText = vi.fn(() => held.promise);
    vi.stubGlobal("dohcDesktop", { platform: "linux", writeWorkspaceText,
      onExitRound: () => () => {}, holdQuit: async () => {} });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    render(<RecoveryCloseGuard>{null}</RecoveryCloseGuard>);
    const editor = renderHook(useAutosavedTextDraft, { initialProps: documentProps("workspace", "old.txt", "before") });
    act(() => editor.result.current.setDraft("old pane edit"));
    editor.unmount();
    expect(writeWorkspaceText).toHaveBeenCalledOnce();
    const unload = new Event("beforeunload", { cancelable: true });
    act(() => { window.dispatchEvent(unload); });
    expect(unload.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await act(async () => { held.resolve({ status: "written", contentHash: "saved" }); });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    close.mockRestore();
  });
  it.each(["notes.txt", ".env"])("preserves a failed exit flush for %s", async (path) => {
    const writeWorkspaceText = vi.fn().mockRejectedValue(Error("write refused"));
    vi.stubGlobal("dohcDesktop", { platform: "linux", writeWorkspaceText,
      onExitRound: () => () => {}, holdQuit: async () => {} });
    const close = vi.spyOn(window, "close").mockImplementation(() => {
      window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    });
    const editor = renderHook(useAutosavedTextDraft, {
      initialProps: documentProps("workspace", path, "before"),
      wrapper: ({ children }) => <RecoveryCloseGuard>{children}</RecoveryCloseGuard>,
    });
    act(() => editor.result.current.setDraft("keep my last edit"));
    const unload = new Event("beforeunload", { cancelable: true });
    act(() => { window.dispatchEvent(unload); });
    expect(unload.defaultPrevented).toBe(true);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    if (path === ".env") {
      await screen.findByTestId("recovery-close-warning");
      expect(loadStoredDrafts(Date.now())).toEqual([]);
    } else {
      expect(loadStoredDrafts(Date.now())).toEqual([expect.objectContaining({ text: "keep my last edit" })]);
      expect(screen.queryByTestId("recovery-close-warning")).toBeNull();
    }
    close.mockRestore();
  });
  it("holds native unload until a pending text draft is saved", async () => {
    const held = deferred<WriteResult>();
    const writeWorkspaceText = vi.fn(() => held.promise);
    vi.stubGlobal("dohcDesktop", { platform: "linux", writeWorkspaceText,
      onExitRound: () => () => {}, holdQuit: async () => {} });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const editor = renderHook(useAutosavedTextDraft, {
      initialProps: documentProps("workspace", "notes.txt", "before"),
      wrapper: ({ children }) => <RecoveryCloseGuard>{children}</RecoveryCloseGuard>,
    });
    act(() => editor.result.current.setDraft("last edit"));
    const unload = new Event("beforeunload", { cancelable: true });
    act(() => { window.dispatchEvent(unload); });
    expect(unload.defaultPrevented).toBe(true);
    await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    await act(async () => { held.resolve({ status: "written", contentHash: "saved" }); });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    close.mockRestore();
  });
  it("keeps an old write conflict scoped to its document after navigation", async () => {
    const heldWrite = deferred<WriteResult>();
    const writeWorkspaceText = vi
      .fn<DohcDesktopBridge["writeWorkspaceText"]>()
      .mockImplementationOnce(() => heldWrite.promise)
      .mockResolvedValue({ status: "written", contentHash: "new-saved-hash" });
    vi.stubGlobal("dohcDesktop", {
      platform: "linux",
      writeWorkspaceText,
    } satisfies Pick<DohcDesktopBridge, "platform" | "writeWorkspaceText">);
    const oldDocument = documentProps("old-workspace", "old.txt", "old disk");
    const newDocument = documentProps("new-workspace", "new.txt", "new disk");
    const recovery = renderHook(() => ({
      old: useOrphanedDrafts("old-workspace", "old.txt"),
      current: useOrphanedDrafts("new-workspace", "new.txt"),
    }));
    const editor = renderHook(useAutosavedTextDraft, {
      initialProps: oldDocument,
    });
    let oldSave: Promise<void> | undefined;
    try {
      act(() => editor.result.current.setDraft("old unsaved text"));
      act(() => {
        oldSave = editor.result.current.saveNow();
      });
      expect(writeWorkspaceText).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "old-workspace",
        relativePath: "old.txt",
        text: "old unsaved text",
        expectedContentHash: "old-workspace-hash",
      });

      editor.rerender(newDocument);
      expect(editor.result.current.draft).toBe("new disk");
      act(() => editor.result.current.setDraft("new unsaved text"));
      await act(async () => {
        heldWrite.resolve({ status: "conflict", currentContentHash: "old-external-hash" });
        await oldSave;
      });

      expect(editor.result.current.draft).toBe("new unsaved text");
      expect(editor.result.current.getDraft()).toBe("new unsaved text");
      expect(editor.result.current.saveState).toBe("saving");
      expect(newDocument.localBuffer.getSnapshot()).toMatchObject({
        body: "new unsaved text",
        contentHash: "new-workspace-hash",
        dirty: true,
      });
      expect(recovery.result.current.old).toEqual([
        expect.objectContaining({ text: "old unsaved text" }),
      ]);
      expect(recovery.result.current.current).toEqual([]);
      expect(loadStoredDrafts(Date.now())).toEqual([
        expect.objectContaining({
          workspaceId: "old-workspace",
          path: "old.txt",
          text: "old unsaved text",
        }),
      ]);
      expect(oldDocument.refreshAfterConflict).not.toHaveBeenCalled();
      expect(newDocument.refreshAfterConflict).not.toHaveBeenCalled();
      await act(async () => editor.result.current.saveNow());
      expect(writeWorkspaceText).toHaveBeenLastCalledWith({
        workspaceId: "new-workspace",
        relativePath: "new.txt",
        text: "new unsaved text",
        expectedContentHash: "new-workspace-hash",
      });
      expect(editor.result.current.saveState).toBe("saved");
    } finally {
      await act(async () => {
        heldWrite.resolve({ status: "written", contentHash: "old-saved-hash" });
        await oldSave;
        editor.unmount();
        await oldDocument.localBuffer.settled();
        await newDocument.localBuffer.settled();
      });
      recovery.unmount();
    }
  });

  it("stores the pending draft when its unmount write fails", async () => {
    const heldWrite = deferred<WriteResult>();
    const writeWorkspaceText = vi
      .fn<DohcDesktopBridge["writeWorkspaceText"]>()
      .mockImplementation(() => heldWrite.promise);
    vi.stubGlobal("dohcDesktop", {
      platform: "linux",
      writeWorkspaceText,
    } satisfies Pick<DohcDesktopBridge, "platform" | "writeWorkspaceText">);
    const document = documentProps("workspace", "notes.txt", "disk text");
    const recovery = renderHook(() => useOrphanedDrafts("workspace", "notes.txt"));
    const editor = renderHook(useAutosavedTextDraft, { initialProps: document });
    try {
      act(() => editor.result.current.setDraft("last unsaved text\n"));
      expect(editor.result.current.getDraft()).toBe("last unsaved text\n");
      expect(writeWorkspaceText).not.toHaveBeenCalled();
      editor.unmount();
      expect(writeWorkspaceText).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "workspace",
        relativePath: "notes.txt",
        text: "last unsaved text\n",
        expectedContentHash: "workspace-hash",
      });
      expect(loadStoredDrafts(Date.now())).toEqual([]);
      await act(async () => {
        heldWrite.reject(new Error("disk unavailable"));
        await document.localBuffer.settled();
      });
      await waitFor(() => {
        expect(recovery.result.current).toEqual([
          expect.objectContaining({ text: "last unsaved text\n" }),
        ]);
        expect(loadStoredDrafts(Date.now())).toEqual([
          expect.objectContaining({
            workspaceId: "workspace",
            path: "notes.txt",
            text: "last unsaved text\n",
          }),
        ]);
      });
      expect(writeWorkspaceText).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        heldWrite.resolve({ status: "written", contentHash: "saved-hash" });
        editor.unmount();
        await document.localBuffer.settled();
      });
      recovery.unmount();
    }
  });
});
