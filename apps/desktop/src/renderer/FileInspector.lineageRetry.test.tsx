// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { harnessBridge } from "./collab/engineDocSaveStateTestHarness";
import { FileInspector } from "./FileInspector";
import { resetOrphanedDraftsAndSettle, settleAfterUnmount, TEST_CONTENT_HASH } from "./FileInspector.draft-fixture";
import { stubEditorGlobals } from "./FileInspector.editor-fixture";
import { loadStoredDrafts } from "./orphanedDraftStorage";
import { errorDetails } from "./shell/copyDetails";
import { ConnectionNotices } from "./shell/connectionNotices";
import { REPLACED_DOCUMENT_SAVED, REPLACED_DOCUMENT_UNSAVED, useDocumentSaveNotices } from "./shell/useDocumentSaveNotices";
import { useShellError } from "./shell/useShellError";

setupFileInspectorTests();

const PATH = "notes/big.md";
let harness: ReturnType<typeof harnessBridge>;

// The shell's toast and Notices for the active workspace, beside an editor
// that can belong to another one.
function Shell(props: { workspaceId: string; children: ReactNode }) {
  const shell = useShellError(props.workspaceId);
  useDocumentSaveNotices({ workspaceId: props.workspaceId, report: shell.reportShellFailure, clear: shell.clearIdentity, open: () => undefined });
  return (
    <>
      <ConnectionNotices
        notices={shell.shellErrors.map((error) => ({
          id: error.id,
          ...(error.title ? { title: error.title } : {}),
          message: error.message,
          details: errorDetails(error.details ?? []),
          atMs: error.atMs,
          canRetry: error.retry !== null,
          seen: error.seen,
        }))}
        reportFailure={shell.reportShellFailure}
        onRetry={shell.retryShellError}
        onHide={shell.hideShellError}
        onDismiss={shell.dismissShellError}
      />
      {props.children}
    </>
  );
}

const surface = (activeWorkspace: string) => (
  <Shell workspaceId={activeWorkspace}>
    <FileInspector workspaceId="ws-1" path={PATH} />
  </Shell>
);

function refuseDraftStorage() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
}

// An edit main has not settled, then a replaced history whose earlier edits
// storage refuses to keep.
async function failReplacement() {
  await screen.findByTestId("markdown-source-toggle");
  harness.emit("settling", 0);
  const setItem = refuseDraftStorage();
  harness.emitLineageReplacement("winner");
  const retry = await screen.findByTestId("markdown-save-state-retry");
  expect(harness.acknowledgedGenerations).toEqual([]);
  return { setItem, retry };
}

beforeEach(() => {
  stubEditorGlobals();
  harness = harnessBridge();
  harness.sourceDoc.getMap("meta").delete("contentKind");
  vi.stubGlobal("dohcDesktop", {
    ...harness.api,
    onWorkspaceActivity: () => () => undefined,
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({ text: "", truncated: false, contentHash: TEST_CONTENT_HASH })),
    listWorkspaceFiles: async () => ({ files: [{ path: PATH, kind: "file" }], folders: [] }),
    readWorkspaceDatabase: async () => ({ tables: [] }),
    getWorkspaceSettings: async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const }),
    getUpdateState: () => new Promise(() => {}),
    onUpdateState: () => () => {},
  });
});

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await resetOrphanedDraftsAndSettle();
});

it("keeps Try again on the frozen editor after its row is dismissed", async () => {
  const user = userEvent.setup();
  render(surface("ws-1"));
  const { setItem } = await failReplacement();
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REPLACED_DOCUMENT_UNSAVED);
  await user.click(screen.getByTestId("notice-center-toggle"));
  await user.click(within(screen.getByRole("dialog", { name: "Notices" })).getByRole("button", { name: "Dismiss notice" }));
  expect(screen.queryByTestId("connection-notices")).toBeNull();

  setItem.mockRestore();
  await user.click(screen.getByTestId("markdown-save-state-retry"));
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  await waitFor(() => expect(screen.queryByTestId("markdown-save-state-retry")).toBeNull());
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REPLACED_DOCUMENT_SAVED);
  expect(loadStoredDrafts(Date.now(), { bindHandles: false }).map((draft) => draft.path)).toEqual([PATH]);
});

it("offers Try again on the frozen editor when it failed while another workspace was active", async () => {
  const user = userEvent.setup();
  const view = render(surface("ws-2"));
  const { setItem } = await failReplacement();
  expect(screen.queryByTestId("connection-notices")).toBeNull();

  view.rerender(surface("ws-1"));
  expect(screen.queryByTestId("connection-notices")).toBeNull();
  setItem.mockRestore();
  await user.click(screen.getByTestId("markdown-save-state-retry"));
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  await waitFor(() => expect(screen.queryByTestId("markdown-save-state-retry")).toBeNull());
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(REPLACED_DOCUMENT_SAVED);
  await act(async () => { view.unmount(); });
});
