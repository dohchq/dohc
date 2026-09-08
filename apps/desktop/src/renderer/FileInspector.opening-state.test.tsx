// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { isolateHistory } from "@codemirror/commands";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "./editor/import-export";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { captureOrphanedDraft, resetOrphanedDrafts } from "./orphanedDrafts";
import * as orphanedDraftsModule from "./orphanedDrafts";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { getSharedLocalDocument } from "./sharedLocalDocument";
import { documentVersionKey } from "./documentVersionKey";
import {
  textEditorContent,
  codeEditorView,
  codeEditorText,
  replaceCodeEditorText,
  appendCodeEditorText,
  typeInMarkdownEditor,
  findTextEditorContent,
  ONE_FRAME_MS,
  advanceAutosaveDebounce,
  useAutoAdvancingFakeTimers,
  stubEditorGlobals,
  findSourceEditor,
  type CodeEditorTestHost,
} from "./FileInspector.editor-fixture";
import {
  settleAfterUnmount,
  resetOrphanedDraftsAndSettle,
  TEST_CONTENT_HASH,
} from "./FileInspector.draft-fixture";
import { type DraftFlush } from "./useAutosavedTextDraft";

setupFileInspectorTests();

// The engine open runs ON the capture chain, so a document clicked while
// that chain is busy (startup reconciliation of a 1,000-file workspace, a
// version switch) waits seconds before it knows whether it is engine-backed.
// The surface used to read that wait as "not engine-backed" and render the
// plain editor — writable, autosaving straight to disk — while the session
// about to bind seeded from the engine head. A keystroke in that window went
// somewhere the session never looks. The document is now READ-ONLY until the
// open answers.
describe("markdown document opening state", () => {
  const DOC_MARKDOWN = "# Plan\n\nBase paragraph.\n";

  // An engine open the test resolves by hand — the held capture chain.
  function makeHeldOpenBridge() {
    const serverDoc = markdownToYDoc(DOC_MARKDOWN);
    let settle: ((available: boolean) => void) | null = null;
    const bridgeMock = {
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
        () =>
          new Promise<{
            available: boolean;
            initialUpdate?: Uint8Array;
            lineageGeneration?: number;
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
      onEngineYDocSaveState: vi.fn(() => () => undefined),
    };
    return {
      bridgeMock,
      bind: () => act(() => settle?.(true)),
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
      (screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("page-title") as HTMLInputElement).readOnly,
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
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
    await user.type(screen.getByTestId("page-title"), "Retitled");
    await waitFor(() =>
      expect(bridgeMock.applyEngineYDocUpdate).toHaveBeenCalled(),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps the properties panel out of an opening document", async () => {
    useAutoAdvancingFakeTimers();
    // The panel writes frontmatter through the same disk save as the body, so
    // it is part of the refusal. It is also lazy — a bare queryByTestId would
    // pass while the chunk was merely still loading, proving nothing. Load the
    // module first, then absence means refusal.
    await import("./PropertiesPanel");
    const { bridgeMock, answerNotEngineBacked } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-open-state");

    await advanceAutosaveDebounce();
    expect(screen.queryByTestId("properties-panel"), "`{!readOnly && !opening ?` → `{!readOnly ?`. The panel mounts during the held open and its property edits autosave to disk. It would still be mounted at the end of this window — `opening` does not flicker.").toBeNull();
    expect(bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);

    // The same surface, one state later, does show it — so the absence above
    // was this branch refusing, not a chunk that never arrived.
    // Wait for the call that creates `settle` (see the note above): the open
    // state renders one commit before the bridge is asked.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    answerNotEngineBacked();
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
  });

  it("gives up the bound editor the moment a version switch reopens the session", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup();
    const { bridgeMock, bind } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
    );
    // The document body loads first; only then does MarkdownView mount and ask
    // for a session. Binding before that would resolve nothing.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });

    // The shell switches the active version under the open document. It keys
    // the inspector by tab, so this is a prop change, not a remount — and the
    // session bound above is already settled and closed.
    view.rerender(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />,
    );

    // The obsolete session's editor is gone at once, not when the next open
    // answers. Anything typed into it would have gone to a closed session.
    expect(screen.queryByTestId("markdown-source-toggle")).toBeNull();
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await attemptToType(user);
    expect(bridgeMock.writeWorkspaceText.mock.calls).toEqual([]);

    // The new version's session binds and the editor comes back.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
  });

  it("restores the writable plain editor once the open answers 'not engine-backed'", async () => {
    const user = userEvent.setup();
    const { bridgeMock, answerNotEngineBacked } = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridgeMock);
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("markdown-open-state");

    // "Opening" is not "not engine-backed": a workspace without a capture answers
    // immediately and keeps its local autosave editor, undiminished.
    // Wait for the call that creates `settle` (see the note above): the open
    // state renders one commit before the bridge is asked.
    await waitFor(() =>
      expect(bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );
    expect(
      (screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "Draft!",
    );
    await waitFor(
      () =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: "# Plan\n\nBase paragraph.\nDraft!",
          expectedContentHash: TEST_CONTENT_HASH,
        }),
      { timeout: 5_000 },
    );
  });

  // A save armed before a reopen must not land during it. The reachable
  // arming: a document the engine answered "not engine-backed" for (plain
  // editor, legitimately writable), a draft typed inside the 800ms autosave
  // window, then a version switch that reopens the session on the same
  // mounted component (the shell keys the inspector by path, so the switch is
  // a prop change, not a remount). Three write paths reach disk from that
  // state — the armed timer, the unmount flush, and the shell's draft-flush
  // seam — and each gets its own test below, so killing any one path's gate
  // fails the test that names it.
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
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
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
    ).toContain("Copy your text to keep it.");
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
      { timeout: 5_000 },
    );
  });

  it("skips the unmount flush during a reopen — closing the view must not write the set-aside draft", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = await armDraftThenReopen(user, bridge);

    view.unmount();
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls, "unmount-flush path: remove the render-phase capture's `unsavedDraft.current = false` and `|| openingRef.current` from the unmount cleanup's guard. This unmount then writes the stale draft to the tree the reopen is binding.").toEqual([]);
  });

  it("refuses the shell's draft flush during a reopen — the seam must not write the set-aside draft", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    await armDraftThenReopen(user, bridge, { registerDraftFlush });
    await waitFor(() => expect(flush).not.toBeNull());

    await act(async () => {
      await flush!();
    });
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls, "draft-flush path: remove the render-phase capture's `unsavedDraft.current = false`, `|| openingRef.current` from the seam's guard, and `|| openingRef.current` from writeDraftNow's. The awaited flush then writes the stale draft mid-reopen.").toEqual([]);
  });

  // The notice promises the text stays recoverable, and the
  // inspector is KEYED — every tab switch unmounts it. The drafts therefore
  // live outside the view, keyed by workspace + path.
  it("keeps the set-aside draft across an unmount and shows it again on remount", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = await armDraftThenReopen(user, bridge);
    await screen.findByTestId("orphaned-draft-notice");

    // The user switches tabs before copying, then comes back.
    view.unmount();
    render(<FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={2} />);
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText(), "survival: clear the path's drafts in the unmount cleanup — the component-local lifetime this store exists to escape. The remount below then has nothing to show.").toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
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

  // #579 review P2, both halves. The chip carries recovery with its own state
  // and settles on Dismiss — but the lifted save state never carries it: the
  // shell's save-first machinery keys off that lift, and a prompt promising
  // to save a draft the flush cannot write would be a false promise.
  it("keeps recovery out of the lifted save state and settles the chip on dismiss", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const states: string[] = [];
    await armDraftThenReopen(user, bridge, {
      onSaveStateChange: (state) => states.push(state),
    });
    await screen.findByTestId("orphaned-draft-notice");
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("recovery");
    await waitFor(() => expect(states.at(-1), "lift: report the recovery-derived state through onSaveStateChange (the round-1 behavior). The shell then marks the tab savable-dirty and the version switch prompts to save a draft that no longer exists in the pipeline.").toBe("saved"));
    expect(states).not.toContain("error");

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice"), "chip: collapse chipState to the plain saveState. The chip then reads nothing while the notice says an edit is not saved.").toBeNull(),
    );
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();
    expect(states.at(-1)).toBe("saved");
  });

  it("shares concurrent legacy Markdown flushes until their held write lands", async () => {
    useAutoAdvancingFakeTimers();
    const bridge = makeHeldOpenBridge();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    let flush: (() => Promise<void>) | null = null;
    await renderLegacyMarkdown(bridge, (next) => {
      flush = next;
    });
    const source = await enterLegacySourceMode();
    replaceCodeEditorText(source, `${source.value}One`);
    await waitFor(() => expect(flush).not.toBeNull());

    let firstSettled = false;
    let secondSettled = false;
    const firstFlush = flush!();
    const secondFlush = flush!();
    void firstFlush.then(() => {
      firstSettled = true;
    });
    void secondFlush.then(() => {
      secondSettled = true;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const settledBeforeWrite = firstSettled || secondSettled;

    await act(async () => {
      releaseWrite();
      await heldWrite;
      await Promise.all([firstFlush, secondFlush]);
    });

    expect(firstFlush).toBe(secondFlush);
    expect(settledBeforeWrite).toBe(false);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
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

  it("does not repaint a newer frontmatter title when an older write completes", async () => {
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
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    await renderLegacyMarkdown(bridge);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "First title" } });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    fireEvent.change(title, { target: { value: "Second title" } });
    fireEvent.blur(title);
    expect(title.value).toBe("Second title");
    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("saving");
    expect(title.value).toBe("Second title");
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toContain(
      "title: Second title",
    );
    await act(async () => {
      releaseSecond();
      await heldSecond;
    });
    expect(title.value).toBe("Second title");
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
  });

  it("sets aside the newest read-mode draft when the file changes during its write", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const bridge = makeHeldOpenBridge();
    const initialBody = `---\ntitle: Plan\n---\n\n${"body\n".repeat(14_000)}`;
    const newestLocalBody = initialBody.replace(
      "title: Plan",
      "title: Newest local title",
    );
    const externalBody = initialBody.replace(
      "title: Plan",
      "title: External title",
    );
    const initialHash = "1".repeat(64);
    const externalHash = "2".repeat(64);
    const freshHash = "3".repeat(64);
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
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
    }>(
      (resolve) => {
        resolveConflict = () =>
          resolve({ status: "conflict", currentContentHash: externalHash });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldConflict)
      .mockResolvedValue({ status: "written", contentHash: freshHash });
    let flush: (() => Promise<void>) | null = null;
    const registerFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    const view = await renderLegacyMarkdown(bridge, registerFlush);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Local title" } });
    fireEvent.blur(title);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: initialBody.replace("title: Plan", "title: Local title"),
      expectedContentHash: initialHash,
    });

    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Newest local title" } });
    fireEvent.blur(title);
    expect(title.value).toBe("Newest local title");

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={1}
        registerDraftFlush={registerFlush}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(title.value).toBe("Newest local title");

    await waitFor(() => expect(flush).not.toBeNull());
    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    const flushResult = flushPromise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(await flushResult).toBe("rejected");
    expect(flushSettled).toBe(false);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "External title",
      ),
    );
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(newestLocalBody),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).not.toBe("saved");

    await advanceAutosaveDebounce();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    const recoveredTitle = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(recoveredTitle);
    fireEvent.change(recoveredTitle, { target: { value: "Fresh title" } });
    fireEvent.blur(recoveredTitle);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: externalBody.replace("title: External title", "title: Fresh title"),
      expectedContentHash: externalHash,
    });
    await expect(flush!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).not.toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await expect(flush!()).resolves.toBeUndefined();
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();
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

  it("queues a legacy Markdown unmount draft behind the hash from its in-flight write", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "e".repeat(64);
    const firstHash = "f".repeat(64);
    const secondHash = "0".repeat(64);
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
    let resolveSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveSecond = () => resolve({ status: "written", contentHash: secondHash });
      },
    );
    bridge.bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    replaceCodeEditorText(source, `${source.value}First`);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
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
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: newestBody,
      expectedContentHash: firstHash,
    });
    await act(async () => {
      resolveSecond();
      await heldSecond;
    });

    const remountBridge = makeHeldOpenBridge();
    remountBridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: newestBody,
      truncated: false,
      contentHash: secondHash,
    });
    await renderLegacyMarkdown(remountBridge);
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    expect(remountBridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("rereads legacy Markdown after a write overlaps a newer content request", async () => {
    const bridge = makeHeldOpenBridge();
    const initialBody = `---\ntitle: Base\n---\n\n${"Body\n".repeat(14_000)}`;
    const externalBody = initialBody.replace("title: Base", "title: External");
    const initialHash = "3".repeat(64);
    const localHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    let resolveThirdRead!: () => void;
    const heldThirdRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveThirdRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockImplementationOnce(() => heldSecondRead)
      .mockImplementationOnce(() => heldThirdRead);
    let resolveWrite!: () => void;
    const heldWrite = new Promise<{
      status: "written";
      contentHash: string;
    }>((resolve) => {
      resolveWrite = () => resolve({ status: "written", contentHash: localHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const view = await renderLegacyMarkdown(bridge);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Local" } });
    fireEvent.blur(title);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        refreshKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
      "Local",
    );

    await act(async () => {
      resolveWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).not.toBe("saved");
    expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
      "Local",
    );

    await act(async () => {
      resolveThirdRead();
      await heldThirdRead;
    });
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "External",
      ),
    );
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();
  });

  it("settles a WYSIWYG verification reread that differs from its completed write", async () => {
    const bridge = makeHeldOpenBridge();
    const initialBody = "---\ntitle: Base\n---\n\nBody\n";
    const externalBody = initialBody.replace("title: Base", "title: External");
    const initialHash = "6".repeat(64);
    const localHash = "7".repeat(64);
    const externalHash = "8".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    let resolveThirdRead!: () => void;
    const heldThirdRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveThirdRead = () =>
        resolve({ text: externalBody, truncated: false, contentHash: externalHash });
    });
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockImplementationOnce(() => heldSecondRead)
      .mockImplementationOnce(() => heldThirdRead);
    let resolveWrite!: () => void;
    const heldWrite = new Promise<{
      status: "written";
      contentHash: string;
    }>((resolve) => {
      resolveWrite = () => resolve({ status: "written", contentHash: localHash });
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const view = await renderLegacyMarkdown(bridge);
    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Local" } });
    fireEvent.blur(title);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    const issuedLocalBody = bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]
      .text;
    expect(issuedLocalBody).toContain("title: Local");

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        refreshKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
      resolveWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    await act(async () => {
      resolveThirdRead();
      await heldThirdRead;
    });
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "External",
      ),
    );
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(issuedLocalBody),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("error");
  });

  it("captures the same legacy conflict again after its first recovery is dismissed", async () => {
    const bridge = makeHeldOpenBridge();
    const initialBody = `---\ntitle: Base\n---\n\n${"Body\n".repeat(14_000)}`;
    const initialHash = "9".repeat(64);
    const externalHash = "b".repeat(64);
    bridge.bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: initialBody,
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: initialBody,
        truncated: false,
        contentHash: externalHash,
      });
    bridge.bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: externalHash,
    });
    const user = userEvent.setup();
    await renderLegacyMarkdown(bridge);

    const editTitle = async () => {
      const title = screen.getByTestId("page-title") as HTMLInputElement;
      fireEvent.focus(title);
      fireEvent.change(title, { target: { value: "Local" } });
      fireEvent.blur(title);
    };
    await editTitle();
    await screen.findByTestId("orphaned-draft-notice", {}, { timeout: 5_000 });
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "Base",
      ),
    );

    await editTitle();
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    await screen.findByTestId("orphaned-draft-notice");
  });

  it("clears source undo history when an accepted snapshot keeps the same text", async () => {
    const bridge = makeHeldOpenBridge();
    const acceptedHash = "a".repeat(64);
    const localBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "a.md", 1),
    );
    const subscription = vi
      .spyOn(localBuffer, "subscribe")
      .mockImplementation(() => () => undefined);
    let returnAcceptedSnapshot = false;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(async () =>
      returnAcceptedSnapshot
        ? {
            text: DOC_MARKDOWN,
            truncated: false,
            contentHash: acceptedHash,
          }
        : {
            text: DOC_MARKDOWN,
            truncated: false,
            contentHash: TEST_CONTENT_HASH,
          },
    );
    bridge.bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: acceptedHash,
    });
    let flush: DraftFlush | null = null;
    const view = await renderLegacyMarkdown(bridge, (next) => {
      flush = next;
    });
    const source = await enterLegacySourceMode();
    const editor = codeEditorView(source);

    act(() => {
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: "Draft" },
        annotations: isolateHistory.of("full"),
      });
      editor.dispatch({
        changes: {
          from: editor.state.doc.length - "Draft".length,
          to: editor.state.doc.length,
        },
        annotations: isolateHistory.of("full"),
      });
    });
    expect(codeEditorText(source)).toBe(DOC_MARKDOWN);
    await waitFor(() => expect(flush).not.toBeNull());
    const acceptRead = vi
      .spyOn(localBuffer, "acceptRead")
      .mockReturnValue(true);
    const readsBeforeAcceptance =
      bridge.bridgeMock.readWorkspaceText.mock.calls.length;
    returnAcceptedSnapshot = true;
    await expect(flush!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        refreshKey={1}
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.readWorkspaceText.mock.calls.length).toBeGreaterThan(
        readsBeforeAcceptance,
      ),
    );
    await waitFor(() => expect(acceptRead).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    const saveStateBeforeUndo = screen
      .getByTestId("markdown-save-state")
      .getAttribute("data-state");
    bridge.bridgeMock.writeWorkspaceText.mockClear();

    const user = userEvent.setup();
    await user.click(await textEditorContent(source));
    await user.keyboard("{Control>}z{/Control}");

    expect(codeEditorText(source)).toBe(DOC_MARKDOWN);
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe(saveStateBeforeUndo);
    expect(bridge.bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    acceptRead.mockRestore();
    subscription.mockRestore();
    view.unmount();
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
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
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

  it("recovers an in-flight legacy autosave that rejects after unmount", async () => {
    const bridge = makeHeldOpenBridge();
    const initialHash = "e".repeat(64);
    bridge.bridgeMock.readWorkspaceText.mockResolvedValue({
      text: DOC_MARKDOWN,
      truncated: false,
      contentHash: initialHash,
    });
    let rejectWrite!: (error: Error) => void;
    const heldWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const view = await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    const localBody = `${source.value}Draft`;
    replaceCodeEditorText(source, localBody);
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    view.unmount();

    await act(async () => {
      rejectWrite(new Error("disk unavailable"));
      await heldWrite.catch(() => undefined);
    });
    const remountBridge = makeHeldOpenBridge();
    await renderLegacyMarkdown(remountBridge);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(localBody),
    );
  });

  it("settles a held raw-source save after switching to lossy WYSIWYG without repainting or retrying", async () => {
    const bridge = makeHeldOpenBridge();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    await renderLegacyMarkdown(bridge);
    const source = await enterLegacySourceMode();
    const rawSource = `${source.value}\n<!-- keep raw -->`;
    replaceCodeEditorText(source, rawSource);

    fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const wysiwyg = await waitFor(() => {
      const editor = screen.getByTestId("markdown-editor");
      if (editor.classList.contains("dohc-code-editor")) {
        throw new Error("The WYSIWYG editor has not replaced source yet.");
      }
      return editor;
    });
    const renderedBeforeWriteLands = wysiwyg.innerHTML;
    expect(wysiwyg.textContent).not.toContain("keep raw");
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text).toBe(
      rawSource,
    );

    await act(async () => {
      releaseWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
    expect(screen.getByTestId("markdown-save-state").textContent).toBe("Saved");
    expect(screen.getByTestId("markdown-editor")).toBe(wysiwyg);
    expect(wysiwyg.innerHTML).toBe(renderedBeforeWriteLands);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  // #579 review r3, the last unguarded interleaving: an autosave that already
  // passed the guards and is awaiting its IPC write. `unsavedDraft` clears at
  // issue time, so a flush that only reads it would return at once, the
  // version would switch, and the outstanding write would land the previous
  // version's text on the new tree. The seam must hold until the write lands.
  it("holds the shell's flush until an in-flight autosave lands, so a switch cannot race the write", async () => {
    useAutoAdvancingFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const bridge = makeHeldOpenBridge();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    const registerDraftFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
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
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "Draft!",
    );
    // The 800ms timer fires; the write is now in flight, held by the mock.
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(flushSettled, "in-flight window: remove `await pendingWrite.current` from the draft-flush seam. The flush below settles with the write still in flight, and the switch it gates proceeds while the previous version's text is still landing.").toBe(false);

    // The write lands; only then does the flush release its caller.
    await act(async () => {
      releaseWrite();
      await heldWrite;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    // The draft landed exactly once, into the version being left — not lost,
    // not duplicated.
    expect(bridge.bridgeMock.writeWorkspaceText.mock.calls).toEqual([
      [
        {
          workspaceId: "ws-1",
          relativePath: "a.md",
          text: "# Plan\n\nBase paragraph.\nDraft!",
          expectedContentHash: TEST_CONTENT_HASH,
        },
      ],
    ]);

    // The switch now reopens the document; nothing further writes.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={2}
        registerDraftFlush={registerDraftFlush}
      />,
    );
    expect(screen.getByTestId("markdown-open-state").textContent).toBe(
      "Opening…",
    );
    await advanceAutosaveDebounce();
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
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
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "One",
    );
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
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
      { timeout: 5_000 },
    );
    // The serialized second write carries the newest text.
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
  it("offers recovery on a non-markdown view after an extension-changing rename", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    captureOrphanedDraft("ws-1", "a.txt", "# Plan\n\nBase paragraph.\nDraft!");
    render(<FileInspector workspaceId="ws-1" path="a.txt" />);

    // The loading branch also renders recovery. Wait for the text editor's
    // passive effect so this test proves recovery survives the view change.
    const content = await findTextEditorContent();
    await waitFor(() => expect(content.textContent, "kind coverage: drop {recoveryNotices} from the text branch. Without this wait, the loading-branch controls let the mutation pass.").toContain("Base paragraph."));
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "# Plan\n\nBase paragraph.\nDraft!",
      ),
    );
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
  });

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
      await screen.findByTestId("markdown-editor", {}, { timeout: 5_000 }),
      "One",
    );
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
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

  it("captures a failed flush when a path settlement joins its existing promise", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let rejectWrite!: (error: Error) => void;
    const heldWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: DraftFlush | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={(next) => {
          flush = next;
        }}
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
    const editor = await screen.findByTestId(
      "markdown-editor",
      {},
      { timeout: 5_000 },
    );
    await textEditorContent(editor);
    appendCodeEditorText(editor, " Late draft");
    const exactDraft = codeEditorText(editor);
    await waitFor(() => expect(flush).not.toBeNull());

    const originalFlush = flush!().catch((error: unknown) => error);
    await waitFor(() =>
      expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const settlementFlush = flush!({ captureOnFailure: true }).catch(
      (error: unknown) => error,
    );
    await act(async () => {
      rejectWrite(new Error("disk unavailable"));
      await heldWrite.catch(() => undefined);
      await Promise.all([originalFlush, settlementFlush]);
    });

    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(exactDraft),
    );
  });

  it.each([
    { retry: "succeeds", retryFails: false, expectedRecoveries: 0 },
    { retry: "fails", retryFails: true, expectedRecoveries: 1 },
  ])(
    "lets an operation-owned legacy Markdown retry settle before recovery when it $retry",
    async ({ retryFails, expectedRecoveries }) => {
      const user = userEvent.setup();
      const bridge = makeHeldOpenBridge();
      let rejectIssued!: (error: Error) => void;
      const issuedWrite = new Promise<never>((_resolve, reject) => {
        rejectIssued = reject;
      });
      let resolveRetry!: () => void;
      let rejectRetry!: (error: Error) => void;
      const retryWrite = new Promise<{
        status: "written";
        contentHash: string;
      }>((resolve, reject) => {
        resolveRetry = () =>
          resolve({ status: "written", contentHash: TEST_CONTENT_HASH });
        rejectRetry = reject;
      });
      let writes = 0;
      bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => {
        writes += 1;
        return writes === 1 ? issuedWrite : retryWrite;
      });
      let flush: DraftFlush | null = null;
      const recoverySpy = vi.spyOn(
        orphanedDraftsModule,
        "captureOrphanedDraft",
      );
      try {
        const view = await renderLegacyMarkdown(bridge, (next) => {
          flush = next;
        });
        const editor = await enterLegacySourceMode();
        appendCodeEditorText(editor, " Late draft");
        await waitFor(
          () =>
            expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
          { timeout: 5_000 },
        );
        await waitFor(() => expect(flush).not.toBeNull());
        const operationResult = flush!({ captureOnFailure: true }).then(
          () => "resolved" as const,
          () => "rejected" as const,
        );
        view.unmount();

        await act(async () => {
          rejectIssued(new Error("issued write failed"));
          await issuedWrite.catch(() => undefined);
        });
        await waitFor(() =>
          expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
        );
        // The unmount observer watches the issued write. The operation flush
        // owns its retry, so the observer must not capture between them.
        expect(recoverySpy).not.toHaveBeenCalled();

        await act(async () => {
          if (retryFails) rejectRetry(new Error("retry failed"));
          else resolveRetry();
          await retryWrite.catch(() => undefined);
        });
        expect(await operationResult).toBe(
          retryFails ? "rejected" : "resolved",
        );
        expect(recoverySpy).toHaveBeenCalledTimes(expectedRecoveries);
      } finally {
        recoverySpy.mockRestore();
      }
    },
  );

  // #579 review r15, the exact reported interleaving: the flush registers on
  // the in-flight write before a later Ctrl+S registers on the same promise.
  // Ctrl+S saves unconditionally, so `unsavedDraft` is already false — the
  // old seam therefore returned the moment the slot cleared, and the queued
  // writer landed the previous version's text after the switch. Membership
  // now starts at ENTRY. The barrier leaves later save work for the flush
  // loop, which has nothing to write when no draft is pending.
  it("does not enqueue a Ctrl+S that arrives after the flush began with no draft pending", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    let releaseA!: () => void;
    const heldA = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseA = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridge.bridgeMock.writeWorkspaceText.mockImplementation(() => heldA);
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    let flush: (() => Promise<void>) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={(next: (() => Promise<void>) | null) => {
          flush = next;
        }}
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
    const editor = await screen.findByTestId(
      "markdown-editor",
      {},
      { timeout: 5_000 },
    );
    await textEditorContent(editor);
    appendCodeEditorText(editor, "One");
    // Autosave A issues and holds. It cleared `unsavedDraft` at issue time.
    await waitFor(
      () =>
        expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(flush).not.toBeNull());

    // The seam starts first, then Ctrl+S — the reported order.
    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.focus();
    await user.keyboard("{Control>}s{/Control}");

    await act(async () => {
      releaseA();
      await heldA;
    });
    await act(async () => {
      await flushPromise;
    });
    expect(flushSettled, "barrier: drop the flushBarrier check from writeDraftNow. Ctrl+S then joins the queue behind A. The seam's captured tail does not include it, so it lands the previous version's text after the switch.").toBe(true);
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  // Read mode (a large, non-truncated document) edits title
  // and properties without `editing` ever flipping, and a reopen can hand
  // back a byte-identical body — the props.body sync effect then has no
  // dependency to fire on, so the capture itself must hand the surface back
  // or the set-aside edit keeps painting the view and rides into the next
  // property save.
  it("a reopen in read mode resets the document state the set-aside edit had painted", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    const bigBody = `# Plan\n\n${"word ".repeat(14_000)}\n`;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(async () => ({
      text: bigBody,
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    }));
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    // A read-mode title edit arms a draft; blur mirrors it into the input.
    const title = await screen.findByTestId("page-title");
    await user.type(title, "R");
    await user.tab();
    expect((title as HTMLInputElement).value).toBe("R");

    // The version switch reopens the same content.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={2}
      />,
    );
    await screen.findByTestId("orphaned-draft-notice");
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value, "read-mode reset: drop the capture's setDraft/setSavedBody/ latestDraft reset. The title keeps painting the set-aside edit and the next property save writes the set-aside document.").toBe(
        "",
      ),
    );
    await user.type(screen.getByTestId("page-title"), "New");
    await waitFor(
      () => expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalled(),
      { timeout: 5_000 },
    );
    const writes = bridge.bridgeMock.writeWorkspaceText.mock
      .calls as unknown as ReadonlyArray<[{ text: string }]>;
    const written = writes.at(-1)![0];
    expect(written.text).toContain("title: New");
    expect(written.text).not.toContain("R");
  });

  it("sets aside a read-mode edit made before the switched version finishes reading", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    const oldBody = `# Old\n\n${"old word ".repeat(14_000)}\n`;
    const newBody = `---\ntitle: New baseline\n---\n\n# New\n\n${"new word ".repeat(14_000)}\n`;
    const newHash = "b".repeat(64);
    let finishSwitchedRead!: () => void;
    const switchedRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      finishSwitchedRead = () =>
        resolve({ text: newBody, truncated: false, contentHash: newHash });
    });
    let reads = 0;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(() => {
      reads += 1;
      return reads === 1
        ? Promise.resolve({
            text: oldBody,
            truncated: false as const,
            contentHash: TEST_CONTENT_HASH,
          })
        : switchedRead;
    });
    let flush: DraftFlush | null = null;
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        engineVersionKey={1}
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    await screen.findByTestId("page-title");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={2}
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(2),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect(screen.queryByTestId("markdown-open-state")).toBeNull(),
    );

    const pendingTitle = screen.getByTestId("page-title");
    await user.type(pendingTitle, "During read");
    await user.tab();
    const switchedBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "a.md", 2),
    );
    expect(switchedBuffer.getSnapshot()).toMatchObject({
      initialized: true,
      contentHash: null,
      dirty: true,
    });

    await act(async () => {
      finishSwitchedRead();
      await switchedRead;
    });
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "New baseline",
      ),
    );
    expect(screen.getAllByTestId("orphaned-draft-notice")).toHaveLength(1);
    expect(switchedBuffer.getSnapshot()).toMatchObject({
      body: newBody,
      contentHash: newHash,
      dirty: false,
      saveState: "saved",
    });

    const title = screen.getByTestId("page-title");
    await user.clear(title);
    await user.type(title, "After read");
    await user.tab();
    await act(async () => flush!());
    expect(bridge.bridgeMock.writeWorkspaceText).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentHash: newHash,
        text: expect.stringContaining("title: After read"),
      }),
    );
  });

  it("applies a same-revision snapshot after the shared buffer changes", async () => {
    const bridge = makeHeldOpenBridge();
    const oldBody = `---\ntitle: Old\n---\n\n# Old\n\n${"old word ".repeat(14_000)}\n`;
    const switchedRead = new Promise<never>(() => undefined);
    let reads = 0;
    bridge.bridgeMock.readWorkspaceText.mockImplementation(() => {
      reads += 1;
      return reads === 1
        ? Promise.resolve({
            text: oldBody,
            truncated: false as const,
            contentHash: TEST_CONTENT_HASH,
          })
        : switchedRead;
    });
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" engineVersionKey={1} />,
    );
    await waitFor(() =>
      expect(bridge.bridgeMock.openEngineYDocSession).toHaveBeenCalledTimes(1),
    );
    bridge.answerNotEngineBacked();
    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "Old",
      ),
    );
    const oldBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "a.md", 1),
    );
    expect(oldBuffer.getSnapshot().revision).toBe(1);
    await act(async () => {
      oldBuffer.acceptRead(
        oldBody,
        TEST_CONTENT_HASH,
        {},
        false,
        oldBuffer.beginRead(),
      );
      await Promise.resolve();
    });
    expect(oldBuffer.getSnapshot().revision).toBe(2);

    const peerBody = `---\ntitle: Peer\n---\n\n# Peer\n\n${"peer word ".repeat(14_000)}\n`;
    const peerBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "a.md", 2),
    );
    peerBuffer.initializeRead(
      oldBody,
      "c".repeat(64),
      peerBuffer.beginRead(),
    );
    peerBuffer.publishDraft(peerBody, {});
    expect(peerBuffer.getSnapshot().revision).toBe(2);
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        refreshKey={1}
        engineVersionKey={2}
      />,
    );

    await waitFor(() =>
      expect((screen.getByTestId("page-title") as HTMLInputElement).value).toBe(
        "Peer",
      ),
    );
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

    await screen.findByText("Couldn't read this file.");
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText(), "error-branch render: drop {recoveryNotices} from the loading/error branch. The screen says only 'Couldn't read this file' while the close warning demands actions that render nowhere.").toBe("Kept!"),
    );
  });

  // #579 review P2 (engine half): a bound engine session's settled "Saved"
  // must not outrank an unresolved set-aside edit — the edit is not in the
  // document the engine settled.
  it("shows recovery over a settled engine document until the draft is resolved", async () => {
    const user = userEvent.setup();
    const bridge = makeHeldOpenBridge();
    vi.stubGlobal("dohcDesktop", bridge.bridgeMock);
    await armDraftThenReopen(user, bridge);

    // The reopen resolves BOUND: the engine branch renders with the notice.
    bridge.bind();
    await screen.findByTestId("markdown-source-toggle", {}, { timeout: 5_000 });
    await screen.findByTestId("orphaned-draft-notice");

    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      "engine chip: read `engine.saveState` directly instead of the recovery-aware state. The chip then says 'Saved' while the notice says the set-aside edit is not in this document.",
    ).toBe("recovery");
    expect(screen.getByTestId("markdown-save-state").textContent).toBe(
      "Edit set aside",
    );

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("saved");
    expect(screen.getByTestId("markdown-save-state").textContent).toBe("Saved");
  });
});
