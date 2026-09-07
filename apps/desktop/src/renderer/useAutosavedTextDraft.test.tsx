// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
import { useAutosavedTextDraft } from "./useAutosavedTextDraft";

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
  for (const release of releases.splice(0)) release();
  resetOrphanedDrafts();
  resetSharedLocalDocumentsForTests();
  vi.unstubAllGlobals();
});

describe("useAutosavedTextDraft", () => {
  it("keeps an old write conflict scoped to its document after navigation", async () => {
    const heldWrite = deferred<WriteResult>();
    const writeWorkspaceText = vi
      .fn<DohcDesktopBridge["writeWorkspaceText"]>()
      .mockImplementationOnce(() => heldWrite.promise)
      .mockResolvedValue({ status: "written", contentHash: "new-saved-hash" });
    vi.stubGlobal("dohcDesktop", {
      writeWorkspaceText,
    } satisfies Pick<DohcDesktopBridge, "writeWorkspaceText">);
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
      writeWorkspaceText,
    } satisfies Pick<DohcDesktopBridge, "writeWorkspaceText">);
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
