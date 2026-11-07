// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { harnessBridge } from "./collab/engineDocSaveStateTestHarness";
import { FileInspector } from "./FileInspector";
import { DOCUMENT_NOT_SAVED_DRAFT_NOTICE } from "./fileInspectorUi";
import { resetOrphanedDraftsAndSettle, settleAfterUnmount, TEST_CONTENT_HASH } from "./FileInspector.draft-fixture";
import { stubEditorGlobals } from "./FileInspector.editor-fixture";

setupFileInspectorTests();

const PATH = "notes/big.md";
let harness: ReturnType<typeof harnessBridge>;

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

it("says dohc could not save an edit it refused for good", async () => {
  const user = userEvent.setup();
  render(<FileInspector workspaceId="ws-1" path={PATH} />);
  await screen.findByTestId("markdown-source-toggle");
  harness.rejectNextApplyAsTooLarge();

  await user.type(screen.getByTestId("page-title"), " Retitled");

  await waitFor(() =>
    expect(screen.getByTestId("orphaned-draft-notice").querySelector("span")?.textContent).toBe(
      DOCUMENT_NOT_SAVED_DRAFT_NOTICE,
    ),
  );
  expect(DOCUMENT_NOT_SAVED_DRAFT_NOTICE).toBe("dohc could not save this document. Copy your text to keep it.");
});

it("gives the chip no tooltip, not the raw error, when no sentence says why", async () => {
  const user = userEvent.setup();
  render(<FileInspector workspaceId="ws-1" path={PATH} />);
  await screen.findByTestId("markdown-source-toggle");
  harness.rejectNextApplyAsTooLarge();

  await user.type(screen.getByTestId("page-title"), " Retitled");

  await screen.findByTestId("orphaned-draft-notice");
  await waitFor(() => expect(screen.getByTestId("markdown-save-state").getAttribute("title")).toBe(""));
});
