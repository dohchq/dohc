// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { settleAfterUnmount, TEST_CONTENT_HASH } from "./FileInspector.draft-fixture";
import { stubEditorGlobals } from "./FileInspector.editor-fixture";
import { FileInspector } from "./FileInspector";
import { NewPage } from "./NewPage";

setupFileInspectorTests();

// A new page's file can open without a live session. The plain editor then
// takes what was typed, and a file nobody can edit here shows itself: the
// page never waits for an editor that is not coming.

type Open = Awaited<ReturnType<DohcDesktopBridge["openEngineYDocSession"]>>;

function bridgeFor(open: Open) {
  const bridgeMock = {
    platform: "linux" as const,
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(async () => ({
      status: "written",
      contentHash: "f".repeat(64),
    })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "Lisbon.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
    openEngineYDocSession: vi.fn(async () => open),
    closeEngineYDocSession: vi.fn(async () => undefined),
  };
  vi.stubGlobal("dohcDesktop", bridgeMock);
  return bridgeMock;
}

// The shell renders the page's file under it once the file exists.
function renderNewPage() {
  const page = (withFile: boolean) => (
    <NewPage
      draft=""
      onDraftChange={() => undefined}
      onLeaveTitle={() => undefined}
      file={withFile ? (onEditorReady) => <FileInspector workspaceId="ws-1" path="Lisbon.md" onEditorReady={onEditorReady} /> : null}
      handedOff={false}
      onHandedOff={() => undefined}
    />
  );
  const view = render(page(false));
  return () => view.rerender(page(true));
}

beforeEach(() => {
  stubEditorGlobals();
});

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  vi.unstubAllGlobals();
});

it("hands the page to the plain editor when its file opens without a live session", async () => {
  const bridge = bridgeFor({ available: false });
  const user = userEvent.setup();
  const fileExists = renderNewPage();
  await user.keyboard("Lisbon{Enter}Day one");
  fileExists();

  await waitFor(() => expect(screen.queryByTestId("new-page")).toBeNull());
  const editor = screen.getByTestId("markdown-editor");
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(editor.textContent).toBe("Day one");
  expect(editor).toBe(document.activeElement);
  expect((screen.getByLabelText("Page title") as HTMLTextAreaElement).value).toBe("Lisbon");
  await waitFor(
    () => expect(bridge.writeWorkspaceText.mock.calls.at(-1)?.[0].text).toMatch(/^---\ntitle: Lisbon\n---\n\nDay one\n?$/),
    { timeout: 3_000 },
  );
});

it("shows a file that opens read-only", async () => {
  bridgeFor({ available: false, liveHostUnavailable: true });
  const user = userEvent.setup();
  const fileExists = renderNewPage();
  await user.keyboard("Lisbon{Enter}");
  fileExists();

  await waitFor(() => expect(screen.queryByTestId("new-page")).toBeNull());
  expect(screen.getByTestId("file-inspector").parentElement!.hasAttribute("inert")).toBe(false);
  expect(screen.getByTestId("view-markdown")).toBeTruthy();
});

it("shows a file that could not be read", async () => {
  const bridge = bridgeFor({ available: false });
  bridge.readWorkspaceText.mockRejectedValue(new Error("EACCES: permission denied"));
  const user = userEvent.setup();
  const fileExists = renderNewPage();
  await user.keyboard("Lisbon{Enter}");
  fileExists();

  await waitFor(() => expect(screen.queryByTestId("new-page")).toBeNull());
  expect(screen.getByTestId("file-inspector").parentElement!.hasAttribute("inert")).toBe(false);
  expect(screen.getByText("Couldn't read this file.")).toBeTruthy();
});
