// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { isLossyMarkdown } from "@dohc/ydoc-projection/lossy-markdown";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "../workspaces/workspaceTextLimits";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { settleAfterUnmount } from "./FileInspector.draft-fixture";

// These tests need a note past the WYSIWYG limit, not the limit itself. A
// small limit keeps their notes small, so opening one stays fast on a busy host.
vi.mock("../workspaces/workspaceTextLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspaces/workspaceTextLimits")>()),
  WYSIWYG_MARKDOWN_THRESHOLD_BYTES: 64 * 1024,
}));

setupFileInspectorTests();

// The check's worker answers only when a test says so. The module keeps one
// worker for the file, so it is this one from the start.
const pending: Array<{ worker: { onmessage: ((event: { data: unknown }) => void) | null }; id: number; markdown: string }> = [];
class HeldWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(data: { id: number; markdown: string }) {
    pending.push({ worker: this, ...data });
  }
  terminate() {}
}
const answerChecks = () => act(() => {
  for (const check of pending.splice(0)) check.worker.onmessage?.({ data: { id: check.id, lossy: isLossyMarkdown(check.markdown) } });
});

beforeAll(async () => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: HeldWorker });
  await import("./markdown/IncrementalMarkdownDocument");
}, 60_000);

afterEach(async () => {
  pending.length = 0;
  cleanup();
  await settleAfterUnmount();
  vi.unstubAllGlobals();
});

// Past read mode's size, with a raw HTML block near the top.
const FILLER = Array.from({ length: 1200 }, (_, index) => `Paragraph ${index + 1} of plain text, long enough to fill the note.`).join("\n\n");
const LARGE_LOSSY = `# Notes\n\n<details>\n<summary>More</summary>\n\nHidden.\n</details>\n\n${FILLER}\n`;

function bridgeFor(text: string, engine: "record" | "no-record") {
  const bridgeMock = {
    platform: "linux" as const,
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({ text, truncated: false, contentHash: "a".repeat(64) })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(async () => ({ status: "written", contentHash: "f".repeat(64) })),
    openFileExternally: vi.fn(async () => undefined),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
    // With no record, the engine refuses the seed and the note has no session.
    openEngineYDocSession: vi.fn(async () => engine === "no-record"
      ? { available: false }
      : { available: true, initialUpdate: Y.encodeStateAsUpdate(markdownToYDoc(text)), lineageGeneration: 1 }),
    applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
    closeEngineYDocSession: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
    onEngineYDocOwnerHandoff: () => () => undefined,
    prepareEngineYDocOwnerHandoff: async () => undefined,
    onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
    onEngineYDocSaveState: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("dohcDesktop", bridgeMock);
  return bridgeMock;
}

// The wait: the note's text in read mode, Edit held, and the opening state.
async function expectWaiting() {
  await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("Paragraph 1 of plain text"));
  expect(screen.queryByTestId("markdown-editor")).toBeNull();
  expect(screen.getByTestId("markdown-edit-toggle").hasAttribute("disabled")).toBe(true);
  expect(screen.getByTestId("markdown-open-state").getAttribute("title"))
    .toBe("You can edit this document when it finishes opening.");
}

describe("a note past read mode's size", () => {
  it("with no engine record opens for source editing with no check", async () => {
    expect(LARGE_LOSSY.length).toBeGreaterThan(WYSIWYG_MARKDOWN_THRESHOLD_BYTES);
    const bridge = bridgeFor(LARGE_LOSSY, "no-record");
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    const toggle = screen.getByTestId("markdown-edit-toggle");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
    expect(pending).toEqual([]);
    await user.click(toggle);
    await waitFor(() => expect(toggle.textContent).toBe("WYSIWYG"));
    expect(pending).toEqual([]);
  });

  it("with an engine record shows its content read-only while the check runs, then closes the session if it is lossy", async () => {
    const bridge = bridgeFor(LARGE_LOSSY, "record");
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    // The session binds first. Until the check answers, the note stays in read
    // mode, opening, with no editor to take keys.
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pending).toHaveLength(1));
    await expectWaiting();

    await answerChecks();
    await waitFor(() => expect(bridge.closeEngineYDocSession).toHaveBeenCalled());
    expect(await screen.findByTestId("lossy-note-notice")).toBeTruthy();
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("with an engine record turns editable once a clear check answers", async () => {
    const clear = `# Notes\n\n${FILLER}\n`;
    const bridge = bridgeFor(clear, "record");
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await waitFor(() => expect(pending).toHaveLength(1));
    await expectWaiting();
    await answerChecks();
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(bridge.closeEngineYDocSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId("markdown-open-state")).toBeNull();
  });
});
