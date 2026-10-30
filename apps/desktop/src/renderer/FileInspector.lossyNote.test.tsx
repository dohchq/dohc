// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { settleAfterUnmount } from "./FileInspector.draft-fixture";
import { knownLossyNoteVerdict } from "./editor/lossyNote";
import { captureHeldLiveMessage } from "../ipc/errorWords";

setupFileInspectorTests();

// A lossy note shows in read mode, whose renderer loads lazily. Loading it
// once here keeps a cold transform out of the first test's wait.
beforeAll(async () => {
  await import("./markdown/IncrementalMarkdownDocument");
}, 60_000);

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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// An engine session seeded from LOSSY, with the witness the engine records.
function lossySession() {
  const doc = markdownToYDoc(LOSSY);
  doc.getMap("meta").set("dohcMarkdownSource", LOSSY);
  doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(LOSSY));
  doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
  return { available: true as const, initialUpdate: Y.encodeStateAsUpdate(doc), lineageGeneration: 1 };
}

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
    listFileChats: vi.fn<DohcDesktopBridge["listFileChats"]>(async () => ({ fileObjectId: "object-1", threads: [] })),
    // History's page for the file: its latest moment recorded LOSSY.
    listEngineMoments: vi.fn(async (): Promise<unknown> => ({ moments: [{ id: "moment-1" }] })),
    readEngineMoment: vi.fn(async (): Promise<unknown> => ({ moment: { afterText: LOSSY } })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" as const })),
    openEngineYDocSession: vi.fn(async (): Promise<{ available: true; initialUpdate: Uint8Array; lineageGeneration: number; headSha256?: string }> => ({
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
    expect(notice.textContent).toContain("dohc can't edit this note yet without changing parts it can't show.");
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("See the docs."));
    expect(screen.getByTestId("markdown-edit-toggle").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("says when dohc holds a change to it", async () => {
    bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    render(<FileInspector workspaceId="ws-1" path="a.md" changeHeld />);

    const notice = await screen.findByTestId("lossy-note-notice");
    expect(notice.textContent).toContain("dohc held a change to this note. Saving it would also change parts dohc can't show.");
    expect(screen.getByTestId("lossy-note-edit-anyway")).toBeTruthy();
  });

  it("opens the file in the system's app", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-open-externally"));
    expect(bridge.openFileExternally).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "a.md" });
  });

  it("warns before Edit anyway, and opens the editor only once the person confirms", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: sha(LOSSY) }]);
    // The session opens on the bytes the person read, so consent covers it.
    bridge.openEngineYDocSession.mockResolvedValue({ available: true,
      initialUpdate: Y.encodeStateAsUpdate(markdownToYDoc(WRITTEN)), lineageGeneration: 1, headSha256: sha(LOSSY) });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    const dialog = screen.getByRole("dialog", { name: "Edit this note anyway?" });
    await waitFor(() => expect(dialog.textContent).toContain("Saving rewrites the parts dohc can't show, such as raw HTML or reference links. History keeps the original."));
    expect(bridge.listEngineMoments).toHaveBeenCalledWith({ workspaceId: "ws-1", objectId: "object-1", limit: 1 });
    expect(bridge.readEngineMoment).toHaveBeenCalledWith({ workspaceId: "ws-1", momentId: "moment-1" });
    await user.click(screen.getByTestId("lossy-note-edit-anyway-cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("lossy-note-edit-anyway"));
    await user.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
  });

  it("promises no History in the warning for a file History doesn't track", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    bridge.listFileChats.mockResolvedValue({ fileObjectId: null, threads: [] });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    const dialog = screen.getByRole("dialog", { name: "Edit this note anyway?" });
    await waitFor(() => expect(dialog.textContent).toContain("History does not track this file, so dohc can't restore the original."));
    expect(bridge.listFileChats).toHaveBeenCalledWith({ workspaceId: "ws-1", path: "a.md" });
    expect(dialog.textContent).not.toContain("History keeps the original.");
  });

  it("promises no History in the warning when History's list for the file is empty", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    bridge.listEngineMoments.mockResolvedValue({ moments: [] });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    const dialog = screen.getByRole("dialog", { name: "Edit this note anyway?" });
    await waitFor(() => expect(dialog.textContent).toContain("dohc could not confirm that History can restore the original."));
    expect(dialog.textContent).not.toContain("History keeps the original.");
  });

  it("promises no History for bytes History's latest moment didn't record, and asks again when the warning reopens", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: sha(LOSSY) }]);
    bridge.readEngineMoment.mockResolvedValue({ moment: { afterText: "# Readme\n\nBefore the outside edit.\n" } });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    const dialog = screen.getByRole("dialog", { name: "Edit this note anyway?" });
    await waitFor(() => expect(dialog.textContent).toContain("dohc could not confirm that History can restore the original."));
    expect(dialog.textContent).not.toContain("History keeps the original.");
    await user.click(screen.getByTestId("lossy-note-edit-anyway-cancel"));

    // Capture records the outside edit while the note stays open.
    bridge.readEngineMoment.mockResolvedValue({ moment: { afterText: LOSSY } });
    await user.click(screen.getByTestId("lossy-note-edit-anyway"));
    const reopened = screen.getByRole("dialog", { name: "Edit this note anyway?" });
    await waitFor(() => expect(reopened.textContent).toContain("History keeps the original."));
  });

  it("shows the hold when capture holds the note, with no Edit anyway", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: sha(LOSSY) }]);
    const retry = vi.fn();
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" captureHeld onRetryHeldCapture={retry} />);

    const notice = await screen.findByTestId("engine-may-hold-document-notice");
    expect(notice.textContent).toContain(captureHeldLiveMessage("a.md"));
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("See the docs."));
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
    expect(screen.queryByTestId("lossy-note-edit-anyway")).toBeNull();
    expect(screen.queryByTestId("markdown-editor")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledWith("a.md");
    await user.click(screen.getByTestId("lossy-note-open-externally"));
    expect(bridge.openFileExternally).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "a.md" });
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();
  });

  it("says nothing about History in the warning until History answers", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    bridge.listFileChats.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    const dialog = screen.getByRole("dialog", { name: "Edit this note anyway?" });
    expect(dialog.textContent).toContain("Saving rewrites the parts dohc can't show, such as raw HTML or reference links.");
    expect(dialog.textContent).not.toContain("History");
  });

  it("checks a switched version's own read, and closes the session when that version is lossy", async () => {
    const bridge = bridgeFor([
      { text: WRITTEN, contentHash: "c".repeat(64) },
      { text: LOSSY, contentHash: "a".repeat(64) },
    ]);
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />);
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));

    // The switch reopens on the last version's verdict, and its read decides.
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />);
    await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("See the docs."));
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    await waitFor(() => expect(bridge.closeEngineYDocSession).toHaveBeenCalledTimes(bridge.openEngineYDocSession.mock.calls.length));
    expect(bridge.applyEngineYDocUpdate).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("reopens a switched version on the last verdict while its read is still out, with no hang", async () => {
    const bridge = bridgeFor([{ text: WRITTEN, contentHash: "c".repeat(64) }]);
    bridge.readWorkspaceText.mockImplementation(async () => {
      if (bridge.readWorkspaceText.mock.calls.length === 1) {
        return { text: WRITTEN, contentHash: "c".repeat(64), truncated: false };
      }
      return await new Promise<never>(() => undefined);
    });
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />);
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));

    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />);
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
    expect(screen.getByTestId("markdown-editor")).toBeTruthy();
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
  });

  it("closes a session that holds a lossy note its read didn't see", async () => {
    const bridge = bridgeFor([{ text: WRITTEN, contentHash: "c".repeat(64) }]);
    // The file changed between the read and the open.
    bridge.openEngineYDocSession.mockResolvedValue(lossySession());
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(bridge.closeEngineYDocSession).toHaveBeenCalled());
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridge.applyEngineYDocUpdate).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("opens a note whose session was lossy once a read brings other bytes", async () => {
    const fixed = `${yDocToMarkdown(markdownToYDoc("# Plan\n\nFixed outside dohc.\n"))}\n`;
    const bridge = bridgeFor([
      { text: WRITTEN, contentHash: "c".repeat(64) },
      { text: fixed, contentHash: "9".repeat(64) },
    ]);
    bridge.openEngineYDocSession
      .mockResolvedValueOnce(lossySession())
      .mockResolvedValue({ available: true as const, initialUpdate: Y.encodeStateAsUpdate(markdownToYDoc(fixed)), lineageGeneration: 1 });
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={0} />);
    await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(bridge.closeEngineYDocSession).toHaveBeenCalled());

    // The person fixes the file outside dohc, and the note reads it again.
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(2);
  });

  it("keeps a switched version read-only when its read never answers and its session holds a lossy note", async () => {
    const bridge = bridgeFor([{ text: WRITTEN, contentHash: "c".repeat(64) }]);
    bridge.readWorkspaceText.mockImplementation(async () => {
      if (bridge.readWorkspaceText.mock.calls.length === 1) {
        return { text: WRITTEN, contentHash: "c".repeat(64), truncated: false };
      }
      return await new Promise<never>(() => undefined);
    });
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />);
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));

    // The new version's note is lossy. Its read never answers, so only its
    // session's own check sees it.
    bridge.openEngineYDocSession.mockResolvedValue(lossySession());
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />);
    await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(bridge.closeEngineYDocSession).toHaveBeenCalledTimes(2));
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridge.applyEngineYDocUpdate).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("shows a failed read with Try again, and opens no session until a read checks the note", async () => {
    const bridge = bridgeFor([{ text: WRITTEN, contentHash: "c".repeat(64) }]);
    bridge.readWorkspaceText.mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByText("Couldn't read this file.");
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();
    expect(bridge.applyEngineYDocUpdate).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("file-read-retry"));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1);
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

  it("checks no saved text once the open is clear", async () => {
    const bridge = bridgeFor([
      { text: WRITTEN, contentHash: "c".repeat(64) },
      { text: `${WRITTEN}\nTyped.\n`, contentHash: "e".repeat(64) },
    ]);
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={0} />);
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1));
    expect(knownLossyNoteVerdict("c".repeat(64))).toBe(false);

    // A checked text gets a verdict; the saved text never does.
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" refreshKey={1} />);
    await waitFor(() => expect(bridge.readWorkspaceText).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(knownLossyNoteVerdict("e".repeat(64))).toBeUndefined();
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
