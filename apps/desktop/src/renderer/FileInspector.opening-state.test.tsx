// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { textEditorContent, codeEditorText, replaceCodeEditorText, typeInMarkdownEditor, ONE_FRAME_MS, advanceAutosaveDebounce, useAutoAdvancingFakeTimers, stubEditorGlobals, findSourceEditor, type CodeEditorTestHost } from "./FileInspector.editor-fixture";
import { settleAfterUnmount, resetOrphanedDraftsAndSettle, TEST_CONTENT_HASH } from "./FileInspector.draft-fixture";
import { type DraftFlush } from "./useAutosavedTextDraft";

setupFileInspectorTests();

describe("markdown document opening state", () => {
  const DOC_MARKDOWN = "# Plan\n\nBase paragraph.\n";

  // An engine open the test resolves by hand — the held capture chain.
  function makeHeldOpenBridge() {
    const serverDoc = markdownToYDoc(DOC_MARKDOWN);
    let settle: ((available: boolean) => void) | null = null;
    const saveListeners = new Set<Parameters<DohcDesktopBridge["onEngineYDocSaveState"]>[0]>();
    const bridgeMock = {
      platform: "linux" as const,
      onWorkspaceActivity: vi.fn(() => () => undefined),
      readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(
        async () => ({
          text: DOC_MARKDOWN,
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        }),
      ),
      writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
        async () => ({ status: "written", contentHash: TEST_CONTENT_HASH }),
      ),
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
        (_payload: { sessionId: string }) =>
          new Promise<{
            available: boolean;
            initialUpdate?: Uint8Array;
            lineageGeneration?: number;
            documentUnavailable?: boolean;
          }>(
            (resolve) => {
              settle = (available) =>
                resolve(
                  available
                    ? {
                        available: true,
                        initialUpdate: Y.encodeStateAsUpdate(serverDoc),
                        lineageGeneration: 1,
                      }
                    : { available: false },
                );
            },
          ),
      ),
      applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
      closeEngineYDocSession: vi.fn(async () => undefined),
      onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
      onEngineYDocOwnerHandoff: () => () => undefined,
      prepareEngineYDocOwnerHandoff: async () => undefined,
      onEngineYDocLineageReplacement: vi.fn(() => () => undefined),
      onEngineYDocSaveState: vi.fn((listener: Parameters<DohcDesktopBridge["onEngineYDocSaveState"]>[0]) => {
        saveListeners.add(listener);
        return () => saveListeners.delete(listener);
      }),
    };
    return {
      bridgeMock,
      bind: () => act(() => settle?.(true)),
      reportSavedOutcome: () => act(() => {
        const sessionId = bridgeMock.openEngineYDocSession.mock.calls.at(-1)![0].sessionId;
        for (const listener of saveListeners) listener({ sessionId, workspaceId: "ws-1", path: "notes/a.md", state: { kind: "saved-here" }, seq: 0 });
      }),
      answerNotEngineBacked: () => act(() => settle?.(false)),
    };
  }

  async function renderLegacyMarkdown(
    bridge: ReturnType<typeof makeHeldOpenBridge>,
    registerDraftFlush?: (flush: DraftFlush | null) => void,
  ) {
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    return view;
  }

  async function enterLegacySourceMode(): Promise<CodeEditorTestHost> {
    fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
    const editor = await findSourceEditor();
    await textEditorContent(editor);
    return editor;
  }

  beforeEach(() => {
    stubEditorGlobals();
    // The set-aside drafts live in a module store on purpose (they must
    // outlive the keyed view), so tests must not inherit each other's.
    resetOrphanedDrafts();
  });

  afterEach(async () => {
    // Real timers before cleanup: settleAfterUnmount below awaits real
    // promise settlement, which a still-fake, still-frozen clock would hang.
    vi.useRealTimers();
    cleanup();
    await settleAfterUnmount();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await resetOrphanedDraftsAndSettle();
  });

  // The user's real attempt: click the header's edit control, then type into
  // whatever editing surface the document offers.
  async function attemptToType(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    // Whichever surface the click produced — the mutation below produces the
    // editable ones, which is the point.
    const textarea = screen.queryByTestId("markdown-editor");
    if (textarea) await user.type(textarea, "Draft!");
    const title = screen.queryByTestId("page-title");
    if (title) await user.type(title, "Retitled");
    // Past the 800ms autosave debounce, so a scheduled write has fired.
    await advanceAutosaveDebounce();
  }

  it("refuses every disk write while the open is held, then takes the keystroke into the bound session", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup();
    const { bridgeMock, bind } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");

    await attemptToType(user);
    expect(bridgeMock.writeWorkspaceText.mock.calls, "`const opening = false` in MarkdownView. The plain editor renders during the held open, the edit toggle is live, and this typing lands `writeWorkspaceText({ text: '…Base paragraph.\\nDraft!' })` — the write the binding session never sees. Asserted first so the mutation fails here, on the phantom write, not on the missing chip.").toEqual([]);

    // The wait is visible and named, and the document still reads.
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await waitFor(() =>
      expect(screen.getByTestId("view-markdown").textContent).toContain(
        "Base paragraph.",
      ),
    );
    expect(
      screen.getByTestId("markdown-edit-toggle").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      (screen.getByTestId("page-title") as HTMLTextAreaElement).readOnly,
    ).toBe(true);

    // The open answers: the session is live, and the same keystroke now goes
    // through it (the title is frontmatter in the canonical Y.Doc) instead of
    // to disk.
    // `settle` is created inside the openEngineYDocSession executor, but
    // `opening` is derived during render (useEngineDoc.ts:189), so
    // markdown-open-state is in the DOM one commit before the bridge is ever
    // called. Resolving on that element and then calling settle?.(…) can
    // silently no-op, and the test burns its whole window waiting for a state
    // nobody moved -- #590 shape 2, the same trap as the source toggle below.
    // Wait for the call that creates settle; never optional-chain it away.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bind();
    await screen.findByTestId("markdown-source-toggle");
    await user.type(screen.getByTestId("page-title"), "Retitled");
    await waitFor(() =>
      expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled(),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  async function armDraftThenReopen(
    user: ReturnType<typeof userEvent.setup>,
    bridge: ReturnType<typeof makeHeldOpenBridge>,
    extraProps: Partial<Parameters<typeof FileInspector>[0]> = {},
  ) {
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        {...extraProps}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "Draft!",
    );
    expect(bridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    // The version switch: same mount, same pending draft, same armed timer.
    // The second open stays held — the "Opening…" window under test.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={2}
        {...extraProps}
        refreshKey={(extraProps.refreshKey ?? 0) + 1}
      />,
    );
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    return view;
  }

  it("cancels the pending timer when a reopen starts, and surfaces the set-aside draft", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    await armDraftThenReopen(user, bridge);

    await advanceAutosaveDebounce();
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls, "pending-timer path: remove the render-phase capture's clearTimeout and `|| openingRef.current` from writeDraftNow's guard. The 800ms timer then fires inside this wait and the write lands while the header reads 'Opening…' — the previous version's draft on the switched tree.").toEqual([]);

    // Cancelled is not dropped: the draft is surfaced for the user to copy,
    // eagerly serialized at the flip (the editor that held it is unmounted by
    // the same commit).
    expect(
      screen.getByTestId("orphaned-draft-notice").textContent,
    ).toContain("Copy your edits to keep them.");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );

    // The chip shows beside "Opening…", not underneath it: the header slot
    // used to be either/or, hiding any state in this window. Recovery has its
    // own chip state — "Couldn't save" would invite a retry that cannot help.
    expect(screen.queryByTestId("markdown-open-state")).not.toBeNull();
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("recovery");
    expect(screen.getByTestId("markdown-save-state").textContent).toBe(
      "Edit set aside",
    );
  });

  it("hands the surface back to the document after the reopen — the set-aside draft cannot re-arm a save", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    await armDraftThenReopen(user, bridge);

    // The reopen answers "not engine-backed": the plain editor is writable
    // again and shows the DOCUMENT's text. Keeping the set-aside draft in the
    // editor instead would leave it one keystroke from landing on the new
    // version — the clobber, one step removed.
    //
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state"), "restore path: in the capture, keep `unsavedDraft.current` true and drop the setDraft/setSavedBody/latestDraft reset together. Neither the sync effect (blocked by the flag) nor the direct reset hands the surface back, and the assertion below finds 'Draft!' still in the source editor.").toBeNull(),
    );
    await waitFor(() =>
      expect(codeEditorText(screen.getByTestId("markdown-editor"))).toBe(
        DOC_MARKDOWN,
      ),
    );

    // Dismiss retires the notice, and the save pipeline is healthy again.
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    await typeInMarkdownEditor(
      user,
      screen.getByTestId("markdown-editor"),
      "New!",
    );
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: "# Plan\n\nBase paragraph.\nNew!",
          expectedContentHash: TEST_CONTENT_HASH,
        }),
    );
  });

  // A second reopen with the first notice still up must not
  // destroy the first draft. Both stay, oldest first, each with its own copy.
  it("keeps both set-aside drafts when a second reopen lands before the first is resolved", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = await armDraftThenReopen(user, bridge);

    // The reopen resolves, the user types again, and a third open starts.
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await typeInMarkdownEditor(
      user,
      screen.getByTestId("markdown-editor"),
      "More!",
    );
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={3} />,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId("orphaned-draft-notice"), "append: make captureOrphanedDraft overwrite instead of append. Only one row survives and the first edit is gone.").toHaveLength(2),
    );
    const copies = screen.getAllByTestId("orphaned-draft-copy");
    await user.click(copies[0]);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );
    await user.click(copies[1]);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nMore!",
      ),
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);
  });

  it("drains a source edit made during a held flush before close can strand it", async () => {
    const bridge = makeHeldOpenBridge();
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let secondStarted!: () => void;
    const secondWriteStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => {
        secondStarted();
        return heldSecond;
      });
    let flush: (() => Promise<void>) | null = null;
    const view = await renderLegacyMarkdown(bridge, (next) => {
      flush = next;
    });
    const source = await enterLegacySourceMode();
    replaceCodeEditorText(source, `${source.value}One`);
    await waitFor(() => expect(flush).not.toBeNull());

    const flushPromise = flush!();
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const newestSource = `${source.value}Two`;
    replaceCodeEditorText(source, newestSource);
    expect(source.value).toBe(newestSource);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    const firstToFinish = await Promise.race([
      secondWriteStarted.then(() => "second-write" as const),
      flushPromise.then(() => "flush" as const),
    ]);
    expect(firstToFinish).toBe("second-write");
    expect(codeEditorText(screen.getByTestId("markdown-editor"))).toBe(
      newestSource,
    );

    await act(async () => {
      releaseSecond();
      await heldSecond;
      await flushPromise;
    });
    view.unmount();

    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: newestSource,
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("sets aside the live WYSIWYG draft when an older in-flight save conflicts", async () => {
    // ONE_FRAME_MS below stays far under the debounce, so firing it cannot
    // itself issue a save.
    useAutoAdvancingFakeTimers();
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const bridge = makeHeldOpenBridge();
      const initialHash = "4".repeat(64);
      const externalHash = "5".repeat(64);
      const externalBody = "# External\n\nChanged elsewhere.\n";
      bridge.bridgeMock.readWorkspaceText
        .mockResolvedValueOnce({
          text: DOC_MARKDOWN,
          truncated: false,
          contentHash: initialHash,
        })
        .mockResolvedValue({
          text: externalBody,
          truncated: false,
          contentHash: externalHash,
        });
      let resolveConflict!: () => void;
      const heldConflict = new Promise<{
        status: "conflict";
        currentContentHash: string;
      }>((resolve) => {
        resolveConflict = () =>
          resolve({ status: "conflict", currentContentHash: externalHash });
      });
      bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(
        () => heldConflict,
      );
      let registeredFlush: DraftFlush | null = null;
      await renderLegacyMarkdown(bridge, (flush) => {
        registeredFlush = flush;
      });
      const editor = await screen.findByTestId("markdown-editor");
      expect(editor.classList.contains("dohc-code-editor")).toBe(false);

      await user.type(editor, "L1");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONE_FRAME_MS);
      });
      await waitFor(() =>
        expect(screen.getByTestId("markdown-save-state").dataset.state).toBe(
          "saving",
        ),
      );
      const flush = await waitFor(() => {
        if (!registeredFlush) throw new Error("draft flush has not registered");
        return registeredFlush;
      });
      const firstFlush = flush();
      await waitFor(() =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      );
      const firstIssuedBody = bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]
        .text;
      expect(firstIssuedBody).toContain("L1");

      await user.type(editor, "L2");
      expect(editor.textContent).toBe("L1PlanBase paragraph.L2");
      const newestLocalBody = firstIssuedBody.replace(
        "Base paragraph.",
        "Base paragraph.L2",
      );
      await act(async () => {
        resolveConflict();
        await heldConflict;
        await firstFlush.catch(() => undefined);
      });

      await screen.findByText("Changed elsewhere.");
      await screen.findByTestId("orphaned-draft-notice");
      fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
      await waitFor(async () =>
        expect(await navigator.clipboard.readText()).toBe(newestLocalBody),
      );
      expect(
        (await screen.findByTestId("markdown-editor")).textContent,
      ).not.toContain("L2");
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a legacy Markdown unmount conflict recoverable without another write", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "c".repeat(64);
    const externalHash = "d".repeat(64);
    const externalBody = "# External\n\nChanged elsewhere.\n";
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: DOC_MARKDOWN,
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: externalBody,
        truncated: false,
        contentHash: externalHash,
      });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(
      () => heldConflict,
    );
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    const localBody = `${source.value}Draft`;
    replaceCodeEditorText(source, localBody);
    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: localBody,
      expectedContentHash: initialHash,
    });

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    const remountBridge = makeHeldOpenBridge();
    remountBridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: externalBody,
      truncated: false,
      contentHash: externalHash,
    });
    await renderLegacyMarkdown(remountBridge);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(localBody),
    );
    await screen.findByText("Changed elsewhere.");
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(remountBridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("recovers a queued legacy unmount draft when its I/O write rejects", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "c".repeat(64);
    const firstHash = "d".repeat(64);
    bridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: DOC_MARKDOWN,
      truncated: false,
      contentHash: initialHash,
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockRejectedValueOnce(new Error("disk unavailable"));
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    replaceCodeEditorText(source, `${source.value}First`);
    await waitFor(() => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));
    const newestBody = `${source.value}Second`;
    replaceCodeEditorText(source, newestBody);
    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    const remountBridge = makeHeldOpenBridge();
    remountBridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: `${DOC_MARKDOWN}First`,
      truncated: false,
      contentHash: firstHash,
    });
    await renderLegacyMarkdown(remountBridge);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(newestBody),
    );
  });

  // Overlapping writes. Autosave A awaiting its IPC and a
  // later B must not overlap — if B settles first, a waiter releases while
  // A's older temp-file rename is still pending over newer content. One
  // write in flight, ever; the next one waits and then reads the newer text.
  it("serializes overlapping autosaves — a second write waits for the first to land", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const bridge = makeHeldOpenBridge();
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let writes = 0;
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1
        ? heldFirst
        : Promise.resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />);
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "One",
    );
    await advanceAutosaveDebounce();
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    // The user keeps typing while write one is still in flight; a second
    // autosave arms and fires.
    await typeInMarkdownEditor(
      user,
      screen.getByTestId("markdown-editor"),
      "Two",
    );
    await advanceAutosaveDebounce();
    expect(bridge.bridgeMock.writeWorkspaceText, "serialization: remove the `while (pendingWrite.current)` wait in writeDraftNow. The second write issues inside this window, overlapping the first.").toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]).toEqual([
      {
        workspaceId: "ws-1",
        relativePath: "a.md",
        text: "# Plan\n\nBase paragraph.\nOneTwo",
        expectedContentHash: TEST_CONTENT_HASH,
      },
    ]);
  });

  // Recovery follows the PATH, not the file kind. An
  // extension-changing rename remaps a markdown draft onto the text view,
  // and Copy/Dismiss must exist there too — a marker with no controls
  // strands the text behind a permanent dirty dot.

  // The queue and the obligation. Writer A is in flight,
  // writer B is parked in writeDraftNow's own wait, and the shell's flush
  // awaits the slot. When A lands, B resumes first, claims the slot, and
  // clears `unsavedDraft` — a single-await flush would return right there,
  // and the switch it gates would proceed while B lands the previous
  // version's text.
  it("the flush outlasts a queued writer that claims the slot when the first write lands", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const bridge = makeHeldOpenBridge();
    let releaseA!: () => void;
    const heldA = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseA = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let releaseB!: () => void;
    const heldB = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseB = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    let writes = 0;
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1 ? heldA : heldB;
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "One",
    );
    await advanceAutosaveDebounce();
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    // B arms and fires while A holds the slot: B is parked in the queue.
    await typeInMarkdownEditor(
      user,
      screen.getByTestId("markdown-editor"),
      "Two",
    );
    await advanceAutosaveDebounce();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    // A lands; B claims the slot and issues its own write.
    await act(async () => {
      releaseA();
      await heldA;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(flushSettled, "flush loop: make the seam await `pendingWrite` ONCE. The flush settles right here, with B still landing the old text.").toBe(false);

    await act(async () => {
      releaseB();
      await heldB;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
  });

  // A set-aside draft on a path whose read fails (a rename
  // raced an I/O failure) must still be copyable — the error branch is a
  // state the marker and close warning point into, so it must offer the
  // actions they demand.
  it("offers recovery on the failed-read branch", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    bridge.bridgeMock.readWorkspaceText.mockImplementation(async () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    captureOrphanedDraft("ws-1", "a.md", "Kept!");
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByText("dohc could not read this file.");
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText(), "error-branch render: drop {recoveryNotices} from the loading/error branch. The screen says only 'dohc could not read this file' while the close warning demands actions that render nowhere.").toBe("Kept!"),
    );
  });
});
