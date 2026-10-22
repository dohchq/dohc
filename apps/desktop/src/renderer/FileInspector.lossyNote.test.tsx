// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { settleAfterUnmount } from "./FileInspector.draft-fixture";

setupFileInspectorTests();

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  vi.unstubAllGlobals();
});

// The four forms the editor can't hold, from #2458.
const LOSSY = [
  "# Readme",
  "",
  "<details>",
  "<summary>More</summary>",
  "",
  "Hidden.",
  "</details>",
  "",
  "See [the docs][docs].",
  "",
  "![logo](/docs/logo.png)",
  "",
  "1. Run this:",
  "",
  "       pnpm install",
  "",
  "[docs]: https://example.com/docs",
  "",
].join("\n");
const WRITTEN = `${yDocToMarkdown(markdownToYDoc("# Plan\n\n- [ ] Book flights\n\n**Budget:** $1,200\n"))}\n`;

function bridgeFor(reads: Array<{ text: string; contentHash: string }>) {
  let read = 0;
  const bridgeMock = {
    platform: "linux" as const,
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      ...reads[Math.min(read++, reads.length - 1)]!,
      truncated: false,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(async () => ({
      status: "written",
      contentHash: "f".repeat(64),
    })),
    openFileExternally: vi.fn(async () => undefined),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
    openEngineYDocSession: vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(markdownToYDoc(WRITTEN)),
      lineageGeneration: 1,
    })),
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

describe("a lossy note", () => {
  it("opens read-only from the file's text, with no engine session", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId("lossy-note-notice");
    expect(notice.textContent).toContain("dohc can't edit this document yet without changing parts it can't show.");
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("See the docs."));
    expect(screen.getByTestId("markdown-edit-toggle").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("opens the file in the system's app", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-open-externally"));
    expect(bridge.openFileExternally).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "a.md" });
  });

  it("warns before Edit anyway, and opens the editor only once the person confirms", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    const dialog = screen.getByRole("dialog", { name: "Edit this document anyway?" });
    expect(dialog.textContent).toContain("Saving rewrites the parts dohc can't show, such as raw HTML or reference links. History keeps the original.");
    await user.click(screen.getByTestId("lossy-note-edit-anyway-cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("lossy-note-edit-anyway"));
    await user.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
  });

  it("shows new text from disk, and opens for editing once the text is no longer lossy", async () => {
    const changed = LOSSY.replace("Hidden.", "Changed on disk.");
    const bridge = bridgeFor([
      { text: LOSSY, contentHash: "a".repeat(64) },
      { text: changed, contentHash: "b".repeat(64) },
      { text: WRITTEN, contentHash: "c".repeat(64) },
    ]);
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={0} />);
    await screen.findByTestId("lossy-note-notice");

    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("Changed on disk."));
    expect(screen.getByTestId("lossy-note-notice")).toBeTruthy();
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();

    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={2} />);
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("lossy-note-notice")).toBeNull());
  });
});

describe("a note dohc wrote", () => {
  it("holds the engine open until its check answers, then binds the editor", async () => {
    const bridge = bridgeFor([{ text: WRITTEN, contentHash: "c".repeat(64) }]);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("view-markdown");
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
  });

  it("opens again with no check once its bytes have a verdict", async () => {
    const bridge = bridgeFor([{ text: WRITTEN, contentHash: "d".repeat(64) }]);
    const first = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    first.unmount();

    const Worker = globalThis.Worker;
    const started = vi.fn();
    vi.stubGlobal("Worker", class extends Worker {
      constructor(url: URL | string) {
        super(url);
        started();
      }
    });
    await act(async () => {
      render(<FileInspector workspaceId="ws-1" path="a.md" />);
    });
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(2));
    expect(started).not.toHaveBeenCalled();
  });
});
