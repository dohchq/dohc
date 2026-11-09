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
import type { DohcDesktopBridge, EngineYDocLineageReplacementEvent } from "../ipc/bridgeContract";
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

// Records `source` as the document's saved source, as the engine does.
function witness(doc: Y.Doc, source: string): Y.Doc {
  doc.getMap("meta").set("dohcMarkdownSource", source);
  doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
  doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(markdownToYDoc(source))));
  return doc;
}

// An engine session seeded from LOSSY, with the witness and head the engine records.
function lossySession(doc = witness(markdownToYDoc(LOSSY), LOSSY)) {
  return { available: true as const, initialUpdate: Y.encodeStateAsUpdate(doc), lineageGeneration: 1, headSha256: sha(LOSSY) };
}

type EngineHead = { sha256?: string | null; committed?: true };
type RemoteUpdateListener = (event: { sessionId: string; update: Uint8Array; head?: EngineHead; lineageGeneration: number }) => void;
const remoteUpdateListeners = new Set<RemoteUpdateListener>();
const lineageReplacementListeners = new Set<(event: EngineYDocLineageReplacementEvent) => void>();
const EMPTY_UPDATE = new Uint8Array([0, 0]);

// What `edit` changes in the engine's document, as main forwards it.
function change(doc: Y.Doc, edit: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  edit();
  return Y.encodeStateAsUpdate(doc, before);
}

function bridgeFor(reads: Array<{ text: string; contentHash: string }>) {
  let read = 0;
  remoteUpdateListeners.clear();
  lineageReplacementListeners.clear();
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
    openEngineYDocSession: vi.fn<DohcDesktopBridge["openEngineYDocSession"]>(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(markdownToYDoc(WRITTEN)),
      lineageGeneration: 1,
    })),
    applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
    closeEngineYDocSession: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: vi.fn((listener: RemoteUpdateListener) => {
      remoteUpdateListeners.add(listener);
      return () => {
        remoteUpdateListeners.delete(listener);
      };
    }),
    onEngineYDocOwnerHandoff: () => () => undefined,
    prepareEngineYDocOwnerHandoff: async () => undefined,
    onEngineYDocLineageReplacement: vi.fn((listener: (event: EngineYDocLineageReplacementEvent) => void) => {
      lineageReplacementListeners.add(listener);
      return () => {
        lineageReplacementListeners.delete(listener);
      };
    }),
    acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({ accepted: true as const, updates: [] })),
    onEngineYDocSaveState: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("dohcDesktop", bridgeMock);
  return bridgeMock;
}

it("shows the nesting refusal without first offering lossy-note consent", async () => {
  const text = `${"*a ".repeat(17)}b${" a*".repeat(17)}\n`;
  const bridge = bridgeFor([{ text, contentHash: sha(text) }]);
  bridge.openEngineYDocSession.mockResolvedValue({ available: false });
  const shown: string[] = [];
  const observer = new MutationObserver(() => {
    if (screen.queryByTestId("lossy-note-notice")) shown.push("consent");
    if (screen.queryByTestId("rich-text-refused")) shown.push("refusal");
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("rich-text-refused");
    expect(shown).toContain("refusal");
    expect(shown).not.toContain("consent");
    expect(screen.queryByTestId("lossy-note-edit-anyway")).toBeNull();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  } finally {
    observer.disconnect();
  }
});

describe("a lossy note", () => {
  it("opens read-only from the file's text, with no engine session", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId("lossy-note-notice");
    expect(notice.textContent).toContain("This note has parts dohc can't show.");
    await waitFor(() => expect(screen.getByTestId("view-markdown").textContent).toContain("See the docs."));
    expect(screen.getByTestId("markdown-edit-toggle").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Edit", description: "This note has parts dohc can't show." }).getAttribute("title"))
      .toBe("This note has parts dohc can't show.");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("says when dohc holds a change to it", async () => {
    bridgeFor([{ text: LOSSY, contentHash: "a".repeat(64) }]);
    render(<FileInspector workspaceId="ws-1" path="a.md" changeHeld />);

    const notice = await screen.findByTestId("lossy-note-notice");
    expect(notice.textContent).toContain("dohc held a change, because saving it would rewrite parts it can't show.");
    expect(screen.getByTestId("lossy-note-edit-anyway")).toBeTruthy();
  });

  it("offers no Edit anyway in a received share, whose session drops the consent", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: sha(LOSSY) }]);
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" receivedShare />);

    const notice = await screen.findByTestId("lossy-note-notice");
    expect(notice.textContent).toContain("This note has parts dohc can't show.");
    expect(screen.queryByTestId("lossy-note-edit-anyway")).toBeNull();
    await user.click(screen.getByTestId("lossy-note-open-externally"));
    expect(bridge.openFileExternally).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "a.md" });
    expect(bridge.openEngineYDocSession).not.toHaveBeenCalled();
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

    await screen.findByText("dohc could not read this file.");
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

describe("Edit anyway", () => {
  const OUTSIDE = LOSSY.replace("Hidden.", "Changed outside dohc.");
  // The head of the file the converting save writes.
  const CONVERTED = sha(WRITTEN);

  // Main forwards each update with the head its state was read with, all
  // before React renders.
  function deliverAll(bridge: ReturnType<typeof bridgeFor>, deliveries: Array<{ update: Uint8Array; head?: EngineHead }>) {
    const sessionId = bridge.openEngineYDocSession.mock.calls.at(-1)![0].sessionId;
    act(() => {
      for (const { update, head } of deliveries) {
        for (const listener of [...remoteUpdateListeners]) listener({ sessionId, update, ...(head ? { head } : {}), lineageGeneration: 1 });
      }
    });
  }

  function deliver(bridge: ReturnType<typeof bridgeFor>, update: Uint8Array, head?: EngineHead) {
    deliverAll(bridge, [{ update, ...(head ? { head } : {}) }]);
  }

  // The engine clears the source a converted note recorded once the file holds what dohc wrote.
  function clearWitness(doc: Y.Doc) {
    for (const key of ["dohcMarkdownSource", "dohcMarkdownSourceSha256", "dohcMarkdownSourceProjectionSha256"]) doc.getMap("meta").delete(key);
  }

  function expectEditing(editor: HTMLElement, title: HTMLTextAreaElement) {
    expect(screen.getByTestId("markdown-editor")).toBe(editor);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(screen.getByTestId("page-title")).toBe(title);
    expect(document.activeElement).toBe(title);
    expect(screen.queryByTestId("lossy-note-notice")).toBeNull();
  }

  // The person accepts Edit anyway and types, which sends the converting save.
  // `reread` is what the file holds when the note reads it again.
  async function editAnyway(reread = OUTSIDE) {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: sha(LOSSY) }, { text: reread, contentHash: sha(reread) }]);
    const engineDoc = witness(markdownToYDoc(LOSSY), LOSSY);
    bridge.openEngineYDocSession.mockResolvedValue(lossySession(engineDoc));
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    await user.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("true"));
    expect(bridge.openEngineYDocSession).toHaveBeenCalledWith(expect.objectContaining({ allowLossySourceSha256: sha(LOSSY) }));
    const title = screen.getByTestId("page-title") as HTMLTextAreaElement;
    await user.type(title, " one");
    await waitFor(() => expect(bridge.applyEngineYDocUpdate).toHaveBeenCalled());
    return { bridge, engineDoc, user, title, editor: screen.getByTestId("markdown-editor") };
  }

  it("keeps the editor and its focus through the converting save and the next, and takes typing with no click", async () => {
    const { bridge, engineDoc, user, title, editor } = await editAnyway();
    const stillEditing = () => expectEditing(editor, title);

    // The converting save commits.
    deliver(bridge, EMPTY_UPDATE, { sha256: CONVERTED, committed: true });
    stillEditing();
    // The engine then clears the source the note recorded, which leaves the
    // head unknown until main reads the pair again.
    deliver(bridge, change(engineDoc, () => clearWitness(engineDoc)));
    stillEditing();
    deliver(bridge, EMPTY_UPDATE, { sha256: CONVERTED });
    stillEditing();

    const saves = bridge.applyEngineYDocUpdate.mock.calls.length;
    await user.keyboard(" two");
    await waitFor(() => expect(bridge.applyEngineYDocUpdate.mock.calls.length).toBeGreaterThan(saves));
    stillEditing();
    deliver(bridge, EMPTY_UPDATE, { sha256: sha("second save"), committed: true });
    stillEditing();
    // A resync that changed nothing reads the second save's head again.
    deliver(bridge, EMPTY_UPDATE, { sha256: sha("second save") });
    stillEditing();
    await user.keyboard(" three");
    stillEditing();
    expect(title.value).toContain("one two three");
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeEngineYDocSession).not.toHaveBeenCalled();
  });

  it("keeps the editor when the engine clears the source before a paired read confirms the converting save", async () => {
    const { bridge, engineDoc, user, title, editor } = await editAnyway();
    // State that landed during the save held its receipt back. The engine's
    // clear arrives with the head unknown, then the paired read confirms the save.
    deliver(bridge, change(engineDoc, () => clearWitness(engineDoc)));
    expectEditing(editor, title);
    deliver(bridge, EMPTY_UPDATE, { sha256: CONVERTED, committed: true });
    expectEditing(editor, title);
    await user.keyboard(" two");
    expectEditing(editor, title);
    expect(title.value).toContain("one two");
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeEngineYDocSession).not.toHaveBeenCalled();
  });

  it("keeps the editor when the converting save's receipt, a read of the head it wrote and the next save's receipt land before one render", async () => {
    const { bridge, user, title, editor } = await editAnyway();
    deliverAll(bridge, [
      { update: EMPTY_UPDATE, head: { sha256: CONVERTED, committed: true } },
      { update: EMPTY_UPDATE, head: { sha256: CONVERTED } },
      { update: EMPTY_UPDATE, head: { sha256: sha("second save"), committed: true } },
    ]);
    expectEditing(editor, title);
    await user.keyboard(" two");
    expectEditing(editor, title);
    expect(title.value).toContain("one two");
    expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeEngineYDocSession).not.toHaveBeenCalled();
  });

  it("asks again when a restore lands after the converting save's receipt, before one render", async () => {
    const { bridge } = await editAnyway(LOSSY);
    deliverAll(bridge, [
      { update: EMPTY_UPDATE, head: { sha256: CONVERTED, committed: true } },
      { update: EMPTY_UPDATE, head: { sha256: sha(LOSSY) } },
    ]);

    await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(screen.queryByTestId("markdown-editor")).toBeNull());
    expect(screen.getByTestId("lossy-note-edit-anyway")).toBeTruthy();
  });

  it("asks again for a replacement of the same bytes that installs before the session's first render", async () => {
    const bridge = bridgeFor([{ text: LOSSY, contentHash: sha(LOSSY) }]);
    let open!: (opened: ReturnType<typeof lossySession>) => void;
    bridge.openEngineYDocSession.mockImplementation(() => new Promise(resolve => {
      open = resolve;
    }));
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await user.click(await screen.findByTestId("lossy-note-edit-anyway"));
    await user.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
    await waitFor(() => expect(bridge.openEngineYDocSession).toHaveBeenCalledWith(
      expect.objectContaining({ allowLossySourceSha256: sha(LOSSY) })));
    const sessionId = bridge.openEngineYDocSession.mock.calls[0]![0].sessionId;
    const winner = witness(markdownToYDoc(LOSSY), LOSSY);
    // Main replaces the session's document with the same bytes and head while
    // the open is still out, and React renders only once both are in.
    await act(async () => {
      for (const listener of [...lineageReplacementListeners]) {
        listener({ sessionId, update: Y.encodeStateAsUpdate(winner), recoveredPaths: [], artifactAssets: [],
          head: { sha256: sha(LOSSY) }, lineageGeneration: 2 });
      }
      open(lossySession());
      await vi.waitFor(() => expect(bridge.acknowledgeEngineYDocLineageReplacement).toHaveBeenCalled());
    });

    // The note hides Edit anyway while consent holds, so it shows again only
    // once the note asks again.
    await screen.findByTestId("lossy-note-edit-anyway");
    expect(screen.getByTestId("lossy-note-notice")).toBeTruthy();
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
  });

  it("checks a restore of the accepted source that lands while the converting save is pending, and asks again once its head arrives", async () => {
    const { bridge } = await editAnyway(LOSSY);
    // The restore installs while the save runs, so its head is unknown.
    deliver(bridge, EMPTY_UPDATE, {});
    expect(screen.queryByTestId("markdown-editor")?.getAttribute("contenteditable")).not.toBe("true");
    deliver(bridge, EMPTY_UPDATE, { sha256: sha(LOSSY) });

    await screen.findByTestId("lossy-note-edit-anyway");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
  });

  it("asks again after a restore to the same bytes while the converting save is pending, even when that save's success arrives late", async () => {
    const { bridge } = await editAnyway(LOSSY);
    // The restore installs the bytes the person accepted, with the same head.
    deliver(bridge, EMPTY_UPDATE, { sha256: sha(LOSSY) });
    deliver(bridge, EMPTY_UPDATE, { sha256: CONVERTED, committed: true });

    await screen.findByTestId("lossy-note-notice");
    await waitFor(() => expect(screen.queryByTestId("markdown-editor")).toBeNull());
    expect(screen.getByTestId("lossy-note-edit-anyway")).toBeTruthy();
  });

  it.each(["before", "after"] as const)(
    "asks again for a lossy change outside dohc that lands %s the converting save commits",
    async (order) => {
      const { bridge, engineDoc } = await editAnyway();
      const outside = () => deliver(bridge, change(engineDoc, () => witness(engineDoc, OUTSIDE)), { sha256: sha(OUTSIDE) });
      if (order === "before") {
        outside();
        // The save that ran across it sends no head; main reads the pair again.
        deliver(bridge, EMPTY_UPDATE, { sha256: sha(OUTSIDE) });
      } else {
        deliver(bridge, EMPTY_UPDATE, { sha256: CONVERTED, committed: true });
        outside();
      }

      await screen.findByTestId("lossy-note-notice");
      await waitFor(() => expect(screen.queryByTestId("markdown-editor")).toBeNull());
      expect(screen.getByTestId("lossy-note-edit-anyway")).toBeTruthy();
      expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(1);
    },
  );
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
