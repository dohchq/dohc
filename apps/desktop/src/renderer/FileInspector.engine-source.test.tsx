// @vitest-environment jsdom
import { engineSaveState } from "../workspaces/engineYDocSaveState";
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createHash } from "node:crypto";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { isLossyMarkdown } from "@dohc/ydoc-projection/lossy-markdown";
import { FileInspector } from "./FileInspector";
import { replaceYDocWithMarkdown } from "./FileInspector.remote-fixture";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { getSharedLocalDocument } from "./sharedLocalDocument";
import { documentVersionKey } from "./documentVersionKey";
import {
  textEditorContent,
  codeEditorText,
  replaceCodeEditorText,
  codeEditorTestHost,
  advanceAutosaveDebounce,
  useAutoAdvancingFakeTimers,
  stubEditorGlobals,
  stubScrollSpy,
  findSourceEditor,
  findEnabledMarkdownEditToggle,
  toggleSourceOnce,
  type CodeEditorTestHost,
} from "./FileInspector.editor-fixture";
import {
  settleAfterUnmount,
  resetOrphanedDraftsAndSettle,
  TEST_CONTENT_HASH,
} from "./FileInspector.draft-fixture";
import { type DraftFlush } from "./useAutosavedTextDraft";

const artifactWorker = vi.hoisted(() => ({ fails: false }));
vi.mock("./editor/artifactSource", () => ({
  prepareArtifactSource: () => undefined,
  projectArtifactSource: async (doc: Y.Doc) => {
    if (artifactWorker.fails) throw new Error("worker failed");
    return (await import("@dohc/ydoc-projection")).yDocToArtifactMarkdown(doc);
  },
}));
import { forgedSources } from "../../../../packages/ydoc-projection/src/artifact-witness.fixture.ts";

setupFileInspectorTests();

// "View markdown as source" on the ENGINE path: the toggle shows a READ-ONLY
// projection of the canonical Y.Doc (the same yDocToMarkdown the settle uses)
// — never an editable raw-markdown surface (the derived-cache invariant). The
// engine session is mocked at the bridge seam exactly like production wires
// it: openEngineYDocSession seeds the mirror doc, onEngineYDocRemoteUpdate
// forwards CRDT deltas.
describe("engine markdown source view", () => {
  const DOC_MARKDOWN = "---\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n\nBase paragraph.\n";

  /**
   * Put a draft in the document through the source editor, which is the
   * surface these draft tests actually mean.
   *
   * Written to keep pointers out of the WYSIWYG surface, because
   * ProseMirror's `mousedown` called `elementFromPoint` and jsdom did not
   * implement it: the handler threw after the test had passed, failing the
   * run with every assertion green. #619 has since stubbed hit testing in
   * `vitest.setup.ts` (measured: the TypeError returns in 21 of 32 loaded
   * runs without it), so that hazard is gone. This helper keeps the tests on
   * the source surface instead of whichever editor happened to mount first.
   */
  async function typeIntoSourceEditor(value: string): Promise<CodeEditorTestHost> {
    // Read -> WYSIWYG -> source: the surface may start in any of the three,
    // so step until CodeMirror mounts.
    for (let step = 0; step < 4; step += 1) {
      const candidate = screen.queryByTestId("markdown-editor");
      if (candidate?.classList.contains("dohc-code-editor")) {
        await textEditorContent(candidate);
        replaceCodeEditorText(candidate, value);
        return codeEditorTestHost(candidate);
      }
      fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
      await act(async () => {
        await Promise.resolve();
      });
    }
    throw new Error("The source editor never appeared.");
  }

  function makeEngineBridge(markdown: string) {
    // The engine's projection, which keeps the frontmatter text as written.
    const serverDoc = markdownToYDoc(markdown);
    const remoteListeners = new Set<
      (event: { sessionId: string; update: Uint8Array; lineageGeneration: number }) => void
    >();
    const saveStateListeners = new Set<
      (event: {
        sessionId: string;
        state: import("@dohc/workspace-contracts/save-state").SaveState;
        access?: "read-only" | "deleted" | "object-changed";
        readOnlyCause?: import("../ipc/bridgeContract").ReadOnlyTransitionCause;
        seq: number;
      }) => void
    >();
    let sessionId = "";
    const bridgeMock = {
      platform: "linux" as const,
      onWorkspaceActivity: vi.fn(() => () => undefined),
      // A lossy note's band asks the engine whether it holds a change.
      readHeldChange: vi.fn(async () => ({ change: null })),
      onNoticesChanged: vi.fn(() => () => undefined),
      readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
        text: markdown,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      })),
      writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(async () => ({
        status: "written",
        contentHash: TEST_CONTENT_HASH,
      })),
      listWorkspaceFiles: vi.fn(async () => ({
        files: [{ path: "a.md", kind: "file" }],
        folders: [],
      })),
      readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
      getWorkspaceSettings: vi.fn(async () => ({
        settings: DEFAULT_WORKSPACE_SETTINGS,
        source: "default" as const,
      })),
      openEngineYDocSession: vi.fn(
        async (payload: {
          sessionId: string;
        }): Promise<{
          available: boolean;
          initialUpdate?: Uint8Array;
          lineageGeneration?: number;
          headSha256?: string;
        }> => {
          sessionId = payload.sessionId;
          return {
            available: true,
            initialUpdate: Y.encodeStateAsUpdate(serverDoc),
            lineageGeneration: 1,
          };
        },
      ),
      applyEngineYDocUpdate: vi.fn<DohcDesktopBridge["applyEngineYDocUpdate"]>(async () => ({
        accepted: true,
      })),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(
        (
          listener: (event: {
            sessionId: string;
            update: Uint8Array;
            lineageGeneration: number;
          }) => void,
        ) => {
          remoteListeners.add(listener);
          return () => remoteListeners.delete(listener);
        },
      ),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      // The engine editor subscribes to real settle outcomes on mount (the
      // save indicator is no longer a timer). Without this the hook throws
      // "onEngineYDocSaveState is not a function" the moment an enabled
      // engine document renders.
      onEngineYDocSaveState: vi.fn(
        (
          listener: (event: {
            sessionId: string;
            state: import("@dohc/workspace-contracts/save-state").SaveState;
            access?: "read-only" | "deleted" | "object-changed";
            readOnlyCause?: import("../ipc/bridgeContract").ReadOnlyTransitionCause;
            seq: number;
          }) => void,
        ) => {
          saveStateListeners.add(listener);
          return () => saveStateListeners.delete(listener);
        },
      ),
    };
    // Simulates a remote writer (co-editor / agent) landing in the live doc:
    // mutate the engine-side doc and forward the delta like main does.
    const pushRemoteMarkdown = (next: string) => {
      const before = Y.encodeStateVector(serverDoc);
      replaceYDocWithMarkdown(serverDoc, next);
      const update = Y.encodeStateAsUpdate(serverDoc, before);
      for (const listener of remoteListeners) {
        listener({ sessionId, update, lineageGeneration: 1 });
      }
    };
    const pushSaveState = (
      state: "settling" | "saved" | "error" | "deleted" | "object-changed" | "read-only",
      seq: number,
      readOnlyCause?: import("../ipc/bridgeContract").ReadOnlyTransitionCause,
    ) => {
      for (const listener of saveStateListeners)
        listener({ sessionId, ...engineSaveState(state), seq, readOnlyCause });
    };
    return {
      bridgeMock,
      pushRemoteMarkdown,
      pushSaveState,
    };
  }

  beforeEach(() => {
    stubEditorGlobals();
    // The reopen-refusal test below captures a set-aside draft into the
    // module store — do not leak it across tests.
    resetOrphanedDrafts();
  });

  afterEach(async () => {
    cleanup();
    await settleAfterUnmount();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await resetOrphanedDraftsAndSettle();
  });

  async function renderEngineDoc(options?: {
    registerSourceToggle?: (toggle: (() => void) | null) => void;
  }) {
    const { bridgeMock, pushRemoteMarkdown } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={options?.registerSourceToggle}
      />,
    );
    // The engine session takes over once bound: the legacy Edit toggle gives
    // way to the engine header's Source toggle.
    const toggle = await screen.findByTestId("markdown-source-toggle");
    return { bridgeMock, pushRemoteMarkdown, toggle, view };
  }

  it("source view returns the witnessed settled file bytes", async () => {
    const source = '---\nzebra: last\ntitle: "Outside"\nalpha: first\n---\n\n- one\n- two\n\n';
    const doc = markdownToYDoc(source);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    doc.getMap("meta").set("dohcMarkdownSource", source);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    const { bridgeMock } = makeEngineBridge(source);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: source,
      truncated: false,
      contentHash: sha(source),
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      lineageGeneration: 1,
      headSha256: sha(source),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    fireEvent.click(await screen.findByTestId("markdown-source-toggle"));
    await waitFor(() =>
      expect(codeEditorText(screen.getByTestId("view-markdown-source"))).toBe(source),
    );
    doc.destroy();
  });

  it("source view shows canonical Markdown when the witness proof fails", async () => {
    const source = '---\nzebra: last\ntitle: "Outside"\nalpha: first\n---\n\n- one\n- two\n\n';
    const doc = markdownToYDoc(source);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    doc.getMap("meta").set("dohcMarkdownSource", source);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    const { bridgeMock } = makeEngineBridge(source);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: source,
      truncated: false,
      contentHash: sha(source),
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      lineageGeneration: 1,
      headSha256: sha(source),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    artifactWorker.fails = true;
    try {
      render(<FileInspector workspaceId="ws-1" path="a.md" />);
      fireEvent.click(await screen.findByTestId("markdown-source-toggle"));
      await waitFor(() =>
        expect(codeEditorText(screen.getByTestId("view-markdown-source"))).toBe(
          yDocToMarkdown(doc),
        ),
      );
    } finally {
      artifactWorker.fails = false;
      doc.destroy();
    }
  });

  it.each([forgedSources.at(-1)!])("source view keeps markup inert: %s", async (source) => {
    const doc = markdownToYDoc(source);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    doc.getMap("meta").set("dohcMarkdownSource", source);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    const { bridgeMock } = makeEngineBridge(source);
    // Lossy notes need explicit consent for the source and session head.
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: source,
      truncated: false,
      contentHash: sha(source),
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      lineageGeneration: 1,
      headSha256: sha(source),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    if (isLossyMarkdown(source)) {
      fireEvent.click(await screen.findByTestId("lossy-note-edit-anyway"));
      fireEvent.click(screen.getByTestId("lossy-note-edit-anyway-confirm"));
      await waitFor(() =>
        expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledWith(
          expect.objectContaining({ allowLossySourceSha256: sha(source) }),
        ),
      );
    }
    fireEvent.click(await screen.findByTestId("markdown-source-toggle"));
    const sourceView = await screen.findByTestId("view-markdown-source");
    await waitFor(() => expect(codeEditorText(sourceView)).toBe(yDocToMarkdown(doc)));
    expect(sourceView.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(sourceView.querySelector("script, iframe, img")).toBeNull();
    doc.destroy();
  });

  it("toggles a read-only source projection (frontmatter included) and back", async () => {
    const user = userEvent.setup();
    const { toggle } = await renderEngineDoc();

    await user.click(toggle);
    const sourceView = await screen.findByTestId("markdown-source-view");
    // Raw markdown, not rendered document: frontmatter and heading markup are
    // visible as text.
    await waitFor(() => {
      expect(sourceView.textContent).toContain("# Plan");
      expect(sourceView.textContent).toContain("title: Plan");
    });
    // READ-ONLY: CodeMirror's content is not editable, and the WYSIWYG pane is
    // hidden — not unmounted (unmounting would destroy the Collaboration
    // extension's undo stack and leave copy/export serializing stale state).
    const content = sourceView.querySelector(".cm-content");
    expect(content?.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByTestId("view-markdown").hidden).toBe(true);
    expect(screen.getByTestId("markdown-source-toggle").textContent).toBe("Editor");

    // Toggling back restores the document surface.
    await user.click(screen.getByTestId("markdown-source-toggle"));
    expect(screen.getByTestId("view-markdown").hidden).toBe(false);
    expect(screen.queryByTestId("markdown-source-view")).toBeNull();
  });

  it("keeps the last live document in the rich editor after clean access ends", async () => {
    const { bridgeMock, pushRemoteMarkdown } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-editor");
    await screen.findByLabelText("Property status value");
    const fileReads = bridgeMock.readWorkspaceText.mock.calls.length;
    const latest =
      "---\ntitle: Latest live title\nstatus: ready\n---\n\n# Latest live document\n\nThe recipient keeps this paragraph.\n";
    act(() => pushRemoteMarkdown(latest));
    await waitFor(() =>
      expect(screen.getByTestId("markdown-editor").textContent).toContain(
        "The recipient keeps this paragraph.",
      ),
    );
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" readOnly accessEnded />);
    await waitFor(() => expect(bridgeMock.closeEngineYDocSession).toHaveBeenCalled());

    const editor = await screen.findByTestId("markdown-editor");
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.textContent).toContain("The recipient keeps this paragraph.");
    expect((screen.getByTestId("page-title") as HTMLTextAreaElement).value).toBe(
      "Latest live title",
    );
    expect(screen.getByTestId("markdown-save-state").dataset.state).toBe("read-only");
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    // The pills stay, with no + or × and no edits.
    expect(screen.getAllByTestId("properties-panel")).toHaveLength(1);
    expect(screen.getByLabelText("Property status value")).toHaveProperty("readOnly", true);
    expect(screen.queryByTestId("property-add")).toBeNull();
    expect(screen.queryByTestId("property-remove")).toBeNull();
    expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(fileReads);
    fireEvent.click(screen.getByTestId("markdown-source-toggle"));
    const source = codeEditorTestHost(await screen.findByTestId("markdown-source-view"));
    await waitFor(() =>
      expect(codeEditorText(source)).toContain("The recipient keeps this paragraph."),
    );
    expect(codeEditorText(source)).toContain("title: Latest live title");
    expect(screen.getByTestId("view-markdown-source").textContent).not.toContain("make changes");
    expect(bridgeMock.applyEngineYDocUpdate).not.toHaveBeenCalled();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // The ended share's lifecycle: the live session reports read-only as a
  // status whether or not an edit is waiting, then the shell re-renders the
  // file through the read-only view.
  async function endAccessAfterTyping() {
    const user = userEvent.setup();
    const { bridgeMock, pushSaveState } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    captureOrphanedDraft("ws-1", "a.md", "Older set-aside text");
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-source-toggle");

    await user.type(screen.getByTestId("page-title"), " Recipient continued.");
    const deliveredSeq = () => bridgeMock.applyEngineYDocUpdate.mock.lastCall?.[0].seq ?? 0;
    await waitFor(() => expect(deliveredSeq()).toBeGreaterThan(0));
    act(() => pushSaveState("read-only", 0));
    await waitFor(() =>
      expect(screen.getByTestId("markdown-editor").getAttribute("contenteditable")).toBe("false"),
    );

    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" readOnly />);
    await waitFor(() => expect(screen.queryByTestId("markdown-source-toggle")).toBeNull());
    expect(screen.getByTestId("markdown-edit-toggle").getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByTestId("markdown-save-state").getAttribute("title")!;
    expect(
      screen.getByRole("button", { name: "Edit", description: reason }).getAttribute("title"),
    ).toBe(reason);
    const delivered = bridgeMock.applyEngineYDocUpdate.mock.calls.length;
    await user.type(screen.getByTestId("page-title"), " Typed after access stopped.");
    expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalledTimes(delivered);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    return { user };
  }

  it("keeps an unsaved edit copyable and explained after access ends", async () => {
    // An older draft keeps its own words beside the new one.
    const { user } = await endAccessAfterTyping();

    expect(screen.getByTestId("markdown-save-state").dataset.state).toBe("recovery");
    const notices = screen.getAllByTestId("orphaned-draft-notice");
    expect(notices.map((notice) => notice.querySelector("span")?.textContent)).toEqual([
      "This document reopened before your last edit saved. Copy your edits to keep them.",
      "This document became read-only. Copy your edits to keep them.",
    ]);
    await user.click(within(notices[1]!).getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "---\ntitle: Plan Recipient continued.\nstatus: draft\n---\n\n# Plan\n\nBase paragraph.\n",
      ),
    );
  });

  it("updates the same set-aside draft for a keystroke before read-only commits", async () => {
    const user = userEvent.setup();
    const { bridgeMock, pushSaveState } = makeEngineBridge(DOC_MARKDOWN);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-source-toggle");

    const title = screen.getByTestId("page-title");
    await user.type(title, " Retitled");
    await waitFor(() => expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled());

    // One React batch: the deletion event captures first, then the still-live
    // title editor accepts one final keystroke before read-only commits.
    act(() => {
      pushSaveState("deleted", 1);
      fireEvent.change(title, { target: { value: "Plan Retitled!" } });
    });

    await user.click(await screen.findByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain("title: Plan Retitled!"),
    );
    expect(screen.getAllByTestId("orphaned-draft-notice")).toHaveLength(1);
  });

  it("keeps a delete-window open refusal retryable and operation-aware", async () => {
    const operation = "delete" as const;
    const message = "dohc is still deleting a.md.";
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    const openBound = bridgeMock.openEngineYDocSession;
    let removalInProgress = true;
    const refusedBridge = {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(async (...args: Parameters<typeof openBound>) =>
        removalInProgress
          ? {
              available: false,
              removalInProgress: { operation, message },
            }
          : await openBound(...args),
      ),
    };
    vi.stubGlobal("dohcDesktop", refusedBridge);

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId("engine-removal-in-progress-notice");
    expect(notice.getAttribute("data-operation")).toBe(operation);
    expect(notice.textContent).toContain(`${message} Wait for it to finish.`);
    expect(screen.queryByTestId("deleted-while-editing-notice")).toBeNull();
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect((screen.getByTestId("page-title") as HTMLTextAreaElement).readOnly).toBe(true);
    // Read-only, the pills show with no + and no edits.
    expect(await screen.findByLabelText("Property status value")).toHaveProperty("readOnly", true);
    expect(screen.queryByTestId("property-add")).toBeNull();
    removalInProgress = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("markdown-source-toggle");
    expect(screen.queryByTestId("engine-removal-in-progress-notice")).toBeNull();
    expect(screen.queryByTestId("deleted-while-editing-notice")).toBeNull();
    expect((screen.getByTestId("page-title") as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("re-projects the source live when a remote CRDT delta lands", async () => {
    const user = userEvent.setup();
    const { toggle, pushRemoteMarkdown } = await renderEngineDoc();

    await user.click(toggle);
    const sourceView = await screen.findByTestId("markdown-source-view");
    await waitFor(() => expect(sourceView.textContent).toContain("Base paragraph."));

    act(() => {
      pushRemoteMarkdown("---\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n\nRemote edit landed.\n");
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-source-view").textContent).toContain(
        "Remote edit landed.",
      );
    });
  });

  it("does not recreate a live file that disappeared after the renderer read it", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    const openEngineYDocSession = vi.fn(async () => ({
      available: false,
      documentUnavailable: true,
    }));
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      openEngineYDocSession,
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId("file-unavailable");
    expect(notice.textContent).toContain("This file is no longer available at this path.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(openEngineYDocSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // The engine open hit its retry deadline. Like notInVersion, this
  // must not downgrade to the writable plain editor — the engine may still
  // bind the document, and a plain autosave meanwhile would take the disk
  // path #533 closed. The document stays readable, read-only, with the
  // reason stated and a retry that issues a fresh open.
  it("keeps a timed-out open read-only with the reason, and retries on request", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    let opens = 0;
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      openEngineYDocSession: vi.fn(async () => {
        opens += 1;
        return { available: false, engineMayHoldDocument: true };
      }),
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const notice = await screen.findByTestId("engine-may-hold-document-notice");
    expect(notice.textContent).toContain("dohc could not open this document for editing.");
    expect(notice.textContent).toContain("You can still read it.");
    // The content still renders — read-only, not replaced.
    expect(screen.getByTestId("view-markdown")).toBeTruthy();
    expect(
      screen.getByTestId("markdown-edit-toggle").hasAttribute("disabled") ||
        screen.getByTestId("markdown-edit-toggle").getAttribute("aria-disabled") === "true",
      "drop engineMayHoldDocument from the readOnly computation -> the edit toggle is enabled over a session the engine may still bind.",
    ).toBe(true);
    expect(opens).toBe(1);

    // Try again is a fresh open (a new request key), not a repaint.
    await user.click(screen.getByText("Try again"));
    await waitFor(() => expect(opens).toBe(2));
  });

  // When the content read itself failed, the inspector returns from its
  // loading/error branch before MarkdownView mounts. That branch must offer a
  // way back. A note no read has checked opens no session, so the way back is
  // reading it again.
  it("offers Try again when the content read failed, and opens no session for unchecked bytes", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    const read = vi.fn(async () => {
      throw new Error("read failed");
    });
    vi.stubGlobal("dohcDesktop", {
      ...bridgeMock,
      onWorkspaceActivity: vi.fn(() => () => undefined),
      readWorkspaceText: read,
    });

    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByText("dohc could not read this file.");
    expect(screen.queryByTestId("engine-may-hold-document-notice")).toBeNull();
    await user.click(screen.getByTestId("file-read-retry"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(bridgeMock.openEngineYDocSession).not.toHaveBeenCalled();
  });

  // Engine mode renders no editable source surface, which held the only
  // consumer of the pending line. Every engine-backed search result therefore
  // opened at the top of the document, whatever line it named. The engine
  // editor now takes the seam over: the line resolves to the top-level block
  // holding it, and the editor reveals that block.
  const SEARCH_DOC =
    "---\ntitle: Plan\n---\n\n# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

  function flashedBlockText(): string | undefined {
    return document.querySelector(".dohc-target-flash")?.textContent ?? undefined;
  }

  // codex on 76298ccd. The source projection hides the editor pane, so a jump
  // applied while it is up reveals a block nobody can see. A reader who
  // clicked a search result asked for the match; give them the document.
  it("leaves the source projection to show the match", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );

    await screen.findByTestId("markdown-editor");
    await user.click(screen.getByTestId("markdown-source-toggle"));
    await screen.findByTestId("view-markdown-source");
    expect(screen.getByTestId("view-markdown").hasAttribute("hidden")).toBe(true);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("view-markdown").hasAttribute("hidden"),
        "drop the setShowSource(false) -> the pane stays hidden and the reveal lands behind the source view.",
      ).toBe(false),
    );
    await waitFor(() => expect(flashedBlockText()).toBe("Third paragraph."));
  });

  // codex round 14 on b67d649c. `setShowSource(false)` only schedules the
  // unhide, so scrolling in the same effect moves an element that is still
  // `hidden` — the pane never moves and the matched title stays offscreen.
  it("scrolls to the top only once the pane is on screen", async () => {
    const user = userEvent.setup();
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    // Record whether the pane was hidden AT THE MOMENT it was scrolled — the
    // one thing a plain call-count cannot say, and the whole defect.
    const hiddenAtScroll: boolean[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: function (this: HTMLElement) {
        hiddenAtScroll.push(this.hasAttribute("hidden"));
      },
    });

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />,
    );
    await screen.findByTestId("markdown-editor");
    await user.click(screen.getByTestId("markdown-source-toggle"));
    await screen.findByTestId("view-markdown-source");
    expect(screen.getByTestId("view-markdown").hasAttribute("hidden")).toBe(true);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        // Line 2 of the file is `title: Plan`, inside the frontmatter.
        scrollTarget={{ path: "a.md", line: 2, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );

    await waitFor(() => expect(hiddenAtScroll.length).toBeGreaterThan(0));
    expect(
      hiddenAtScroll,
      "scroll inside the mapping effect -> the one recorded call happens while the pane is still hidden and moves nothing.",
    ).not.toContain(true);
  });

  // codex on 76298ccd. A version switch drops the bound Y.Doc while the
  // reopen runs (useEngineDoc), which unmounts this editor. The instance that
  // replaces it has no memory of having applied anything, so a target still
  // held above lands a second time — on a document the reader did not search.
  // The reopenKey guard covers a VERSION switch. It is not the only rebind:
  // useEngineDoc keys its request on [enabled, workspaceId, path, reopenKey,
  // retryKey], so flipping `readOnly` unbinds the Y.Doc and binds a fresh one
  // with reopenKey untouched. Reporting the landing back is what stops the
  // editor that mounts on the far side from applying the same jump again.
  it("retires the target once applied, so a rebind cannot replay it", async () => {
    useAutoAdvancingFakeTimers();
    const scrollIntoView = stubScrollSpy("scrollIntoView");
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);

    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        scrollTarget={{ path: "a.md", line: 11, nonce: 1 }}
        onScrollConsumed={vi.fn()}
      />,
    );
    await screen.findByTestId("markdown-editor");
    await waitFor(() => expect(flashedBlockText()).toBe("Third paragraph."));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // readOnly flips `enabled`, which is part of the request key — the doc
    // unbinds and the editor goes with it. reopenKey never moves.
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" readOnly onScrollConsumed={vi.fn()} />,
    );
    await waitFor(() => expect(screen.queryByTestId("markdown-editor")).toBeNull());
    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" onScrollConsumed={vi.fn()} />);
    await screen.findByTestId("markdown-editor");
    for (let settle = 0; settle < 2; settle += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
    }

    expect(
      scrollIntoView,
      "make retireJump a no-op -> the target outlives the rebind and the fresh editor reveals it a second time.",
    ).toHaveBeenCalledTimes(1);
  });

  // Unlike a consumed search jump, a heading target survives the editor
  // remount a version switch causes. See HeadingNavigationTarget for why.
  // Scope is that switch. Clicking another file tab and back does not replay:
  // activateEditorTab routes a file path through openFile, which clears the
  // target.
  it("re-applies a heading navigation when the version switches under it", async () => {
    const revealedTargets: Array<{
      connected: boolean;
      flashed: boolean;
      text: string | null;
    }> = [];
    const scrollIntoView = stubScrollSpy("scrollIntoView", function (this: HTMLElement) {
      revealedTargets.push({
        connected: this.isConnected,
        flashed: this.classList.contains("dohc-target-flash"),
        text: this.textContent,
      });
    });
    const { bridgeMock } = makeEngineBridge(SEARCH_DOC);
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const headingTarget = { anchor: "plan", nonce: 1 };

    // Deliberately mounted without the target, then given it. Mounting with it
    // lets the pre-engine local editor reveal it once before the Y.Doc binds,
    // and that extra reveal alone satisfies the count below — the consumable
    // mutation passes. Delivering it to a bound engine editor is what makes
    // the second reveal mean the remount.
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-editor");

    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" headingTarget={headingTarget} />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    // engineVersionKey reopens the session, so the editor unmounts and a fresh
    // one binds. Nothing consumed the target, so it stands.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        headingTarget={headingTarget}
      />,
    );
    await waitFor(() => expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2));
    await screen.findByTestId("markdown-editor");

    await waitFor(() =>
      expect(
        scrollIntoView,
        "give headingTarget the onBlockTargetConsumed shape -> one reveal, and the reader lands at the top of the new version.",
      ).toHaveBeenCalledTimes(2),
    );
    // Which heading, not just how many reveals: the count alone would accept a
    // second reveal that landed somewhere else.
    expect(revealedTargets[1]).toEqual({
      connected: true,
      flashed: true,
      text: "Plan",
    });
  });

  it("blocks the source autosave for the full switch reread and sets the draft aside without a heading target", async () => {
    useAutoAdvancingFakeTimers();
    const firstBody = "# Hello\n\nParagraph\n";
    const secondBody = "# Hello from the new version\n\nReplacement paragraph.\n";
    const typedBody = `${firstBody}\nTyped while the reread was pending.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" registerSourceToggle={sourceToggle} />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());

    const pendingSource = await findSourceEditor();
    expect(pendingSource.value).toBe(firstBody);
    replaceCodeEditorText(pendingSource, typedBody);
    expect(pendingSource.value).toBe(typedBody);

    // Let the armed autosave attempt its write while the independent disk
    // reread still holds the switch window open.
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(codeEditorText(screen.getByTestId("markdown-editor"))).toBe(secondBody),
    );
    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(typedBody));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps a rejected switch reread write-blocked and recovers the unmounted draft", async () => {
    const firstBody = "# Old version\n\nOld paragraph.\n";
    const typedBody = `${firstBody}\nTyped after the reopen settled.`;
    const { bridgeMock } = makeEngineBridge(firstBody);
    let rejectSecondRead!: (reason?: unknown) => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        return {
          text: firstBody,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }
      return await new Promise<never>((_resolve, reject) => {
        rejectSecondRead = reject;
      });
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    let toggleSource: (() => void) | null = null;
    const sourceToggle = (toggle: (() => void) | null) => {
      toggleSource = toggle;
    };
    const user = userEvent.setup();

    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" registerSourceToggle={sourceToggle} />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerSourceToggle={sourceToggle}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());

    const pendingSource = await findSourceEditor();
    replaceCodeEditorText(pendingSource, typedBody);
    expect(pendingSource.value).toBe(typedBody);

    await act(async () => {
      rejectSecondRead(new Error("read failed"));
      await Promise.resolve();
    });
    await screen.findByText("dohc could not read this file.");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(typedBody));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("resyncs WYSIWYG after the switch reread and preserves its pending edit", async () => {
    useAutoAdvancingFakeTimers();
    const firstBody = "# Old version\n\nOld paragraph.";
    const secondBody = "# New version\n\nReplacement paragraph.";
    const typedBody = "# Pending switch edit. Old version\n\nOld paragraph.\n";
    const freshBody = "# Fresh edit. New version\n\nReplacement paragraph.\n";
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    const firstEditor = await screen.findByTestId("markdown-editor");
    expect(firstEditor.classList.contains("dohc-code-editor")).toBe(false);

    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" refreshKey={1} engineVersionKey={1} />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());

    const pendingEditor = await screen.findByTestId("markdown-editor");
    expect(pendingEditor.classList.contains("dohc-code-editor")).toBe(false);
    await user.type(pendingEditor, "Pending switch edit. ");

    // The pending WYSIWYG autosave must answer to the same switch window as
    // the source timer and both long-lived flush callers.
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await screen.findByText("Replacement paragraph.");

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(typedBody));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    const resyncedEditor = screen.getByTestId("markdown-editor");
    expect(resyncedEditor).not.toBe(pendingEditor);
    await user.type(resyncedEditor, "Fresh edit. ");
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "a.md",
        text: freshBody,
        expectedContentHash: TEST_CONTENT_HASH,
      }),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: typedBody,
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  // The sibling of the test above, with one difference that decides
  // everything: the replacement read lands before the 800ms debounce, so the
  // WYSIWYG draft is still LAZY when the resync runs. The 900ms wait above
  // materializes it first, which is why that test cannot see this. A lazy
  // draft the resync leaves armed carries the FROZEN pre-switch editor, and
  // the next materialize — the shell's flush before an explorer op — would
  // merge it over the new version's baseline and write it.
  it("retires a lazy WYSIWYG draft when the switch reread lands before its debounce", async () => {
    const firstBody = "# Old version\n\nOld paragraph.";
    const secondBody = "# New version\n\nReplacement paragraph.";
    const typedBody = "# Zz Old version\n\nOld paragraph.\n";
    const { bridgeMock } = makeEngineBridge(firstBody);
    let releaseSecondRead!: () => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          releaseSecondRead = resolve;
        });
      }
      return {
        text: reads === 1 ? firstBody : secondBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      };
    });
    bridgeMock.openEngineYDocSession.mockResolvedValue({
      available: false,
      initialUpdate: new Uint8Array(),
    });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const user = userEvent.setup();

    let flush: DraftFlush | null = null;
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerDraftFlush={(registered) => {
          if (registered) flush = registered;
        }}
      />,
    );
    const firstEditor = await screen.findByTestId("markdown-editor");
    expect(firstEditor.classList.contains("dohc-code-editor")).toBe(false);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerDraftFlush={(registered) => {
          if (registered) flush = registered;
        }}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());

    const pendingEditor = await screen.findByTestId("markdown-editor");
    // Short on purpose: the whole test lives inside the 800ms debounce.
    await user.type(pendingEditor, "Zz ");
    const buffer = getSharedLocalDocument(documentVersionKey("ws-1", "a.md", 1));
    // The guard that keeps this test honest: if the debounce beat the read,
    // the draft is already published and this test would prove nothing.
    expect(buffer.getPendingDraftSource()).not.toBeNull();

    await act(async () => {
      releaseSecondRead();
      await Promise.resolve();
    });
    await screen.findByText("Replacement paragraph.");

    // The typed text is recoverable, exactly as the sibling test requires.
    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(typedBody));

    await act(async () => {
      await flush!();
    });
    expect(
      buffer.getPendingDraftSource(),
      "drop `clearPendingDraft` from the resync. The flush the shell runs before an explorer op materializes the pre-switch editor's body and writes it against the new version's hash — a silent overwrite.",
    ).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // The P1 the review reproduced. Typing during the open wait arms an 800ms
  // autosave and leaves a pending draft. When the refusal arrived, `readOnly`
  // flipped false->true; `readOnly` was a dependency of the unmount-flush
  // effect, so React ran that effect's previous cleanup — closure captured
  // `readOnly === false` — which walked past its own guard and wrote the
  // phantom. Turning the document read-only was itself the write.
  //
  // The refusal must therefore discard the draft, and the flush must stop
  // re-running on the transition. Both routes are covered here: the write that
  // fired on the transition, and the 800ms timer that was already scheduled.
  it("writes nothing when a document the user typed into turns read-only while it stays mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        openEngineYDocSession: vi.fn(async () => ({ available: false })),
      });

      const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
      await user.click(await findEnabledMarkdownEditToggle());
      await user.type(await screen.findByTestId("markdown-editor"), "typed");
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

      // The shell turns the path read-only (a share mount lands on it). The
      // document STAYS MOUNTED, so no unmount clears the armed autosave.
      view.rerender(<FileInspector workspaceId="ws-1" path="a.md" readOnly />);
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // codex P1, the half this change can honestly close. `writesBlocked()` stops
  // the write — correct, a read-only view must not be written — but the armed
  // 800ms timer had already fired, so the indicator sat on "Saving…" over an
  // edit that would never land. That is the same lie as a doc reading "Saved"
  // over a zero-byte file. The edit is still lost when the view is torn down
  // in this state: #567 owns that, because preserving the TEXT needs eager
  // serialization (a rearm re-serializes, and the read-only window has already
  // unmounted the editor, so it writes the PRE-EDIT body).

  it("writes nothing when a pending draft meets a not-in-version refusal on reopen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
      let opens = 0;
      let refuse!: () => void;
      const refused = new Promise<{
        available: boolean;
        notInVersion?: boolean;
      }>((resolve) => {
        refuse = () => resolve({ available: false, notInVersion: true });
      });
      vi.stubGlobal("dohcDesktop", {
        ...bridgeMock,
        openEngineYDocSession: vi.fn(() => {
          opens += 1;
          // First open: not engine-backed, so the plain editor is legitimately
          // writable. The second (the version switch) is the refusal.
          return opens === 1 ? Promise.resolve({ available: false }) : refused;
        }),
      });

      const view = render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={0} />);
      await screen.findByTestId("view-markdown");
      // Same draft, no pointer: this test's typed click reached prosemirror's
      // mousedown and threw after it passed, which failed the whole run with
      // every assertion green. See typeIntoSourceEditor.
      await typeIntoSourceEditor(`${DOC_MARKDOWN}phantom`);
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

      // The version switch. Same mount, same pending draft, same armed timer.
      view.rerender(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />);
      await act(async () => {
        refuse();
        await refused;
      });
      const notice = await screen.findByTestId("file-not-in-version");

      // Route 1: the read-only transition must not have written.
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      // Route 2: the armed autosave must not write either, now that the
      // document is read-only. Past 800ms it would have, on a stale closure.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
      // The draft is not lost and not misreported: the reopen set it aside,
      // the store outlives the replaced view, and the refusal screen
      // itself offers the copy. "Discarded" would be false here — that line
      // is reserved for a draft that really went nowhere.
      //
      expect(
        screen.getByTestId("orphaned-draft-notice"),
        "refusal recovery: drop <OrphanedDraftNotices> from the not-in-version branch. The set-aside text survives in the store but the user has no way to reach it from this screen.",
      ).toBeTruthy();
      expect(screen.queryByTestId("file-not-in-version-discarded")).toBeNull();
      expect(notice.textContent).toContain("Switch to the version that has it.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a record's body in the record panel without the title, the buttons row and the properties, and a file tab with all three", async () => {
    const { bridgeMock } = makeEngineBridge(DOC_MARKDOWN);
    const listRecordButtons = vi.fn(async () => ({
      record: { id: "rec-1", path: "a.md", conflicted: false, values: [] },
      collectionPath: "",
      fields: [],
    }));
    vi.stubGlobal("dohcDesktop", Object.assign(bridgeMock, { listRecordButtons }));
    const reports = {
      onButtonError: () => undefined,
      onButtonNotice: () => undefined,
      onOpenRecordHistory: () => undefined,
    };
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" {...reports} recordBody />);
    // The body is the file's live document, with the document's own controls.
    const editor = await screen.findByTestId("markdown-editor");
    await waitFor(() => expect(editor.textContent).toContain("Base paragraph."));
    expect(screen.getByTestId("markdown-source-toggle")).toBeTruthy();
    // The panel draws the record's name, buttons and fields, so the body draws none and asks main for no record.
    expect(screen.queryByTestId("page-identity")).toBeNull();
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    expect(screen.queryByTestId("record-buttons")).toBeNull();
    expect(listRecordButtons).not.toHaveBeenCalled();

    view.rerender(<FileInspector workspaceId="ws-1" path="a.md" {...reports} />);
    expect(((await screen.findByTestId("page-title")) as HTMLTextAreaElement).value).toBe("Plan");
    expect(await screen.findByTestId("properties-panel")).toBeTruthy();
    expect(await screen.findByTestId("record-buttons")).toBeTruthy();
  });
});
