// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delimitedTextCodec, FileInspector, lineSpanInText } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { resetOrphanedDrafts } from "./orphanedDrafts";
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
  codeEditorTestHost,
  findTextEditorContent,
  ONE_FRAME_MS,
  advanceAutosaveDebounce,
  useAutoAdvancingFakeTimers,
  LARGE_READ_MODE_FILLER,
  stubEditorGlobals,
  stubScrollSpy,
  findSourceEditor,
  toggleSourceOnce,
} from "./FileInspector.editor-fixture";
import {
  settleAfterUnmount,
  resetOrphanedDraftsAndSettle,
  TEST_CONTENT_HASH,
} from "./FileInspector.draft-fixture";
import { type DraftFlush } from "./FileInspector";

setupFileInspectorTests();

// The same wait for a pane count: `findAllByTestId` resolves on the first
// match, so a test that wants two panes can otherwise index into one.
async function findTextEditorContents(count: number): Promise<HTMLElement[]> {
  const hosts = await waitFor(() => {
    const found = screen.getAllByTestId("view-text-editor");
    expect(found).toHaveLength(count);
    return found;
  });
  return await Promise.all(hosts.map(textEditorContent));
}

const MAX_FRAME_PUMPS = 5;

// user-event resolves a click or keystroke only once CodeMirror's own
// requestAnimationFrame-driven view update settles. Fake timers never
// advance on their own, so pump frames while the action is still pending
// instead of hanging forever waiting for a tick nothing will deliver.
async function settleUserEventAction<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  // Both branches, not just fulfillment: this derived promise must not
  // become an unhandled rejection when `pending` itself rejects. The
  // caller's own `return pending` below is where a rejection is meant to
  // surface.
  pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < MAX_FRAME_PUMPS && !done; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ONE_FRAME_MS);
    });
  }
  if (!done) {
    throw new Error(
      `user-event action did not settle within MAX_FRAME_PUMPS=${MAX_FRAME_PUMPS} frames`,
    );
  }
  return pending;
}

// data-testid="markdown-editor" names the editing surface, and both editing
// surfaces carry it: the source CodeMirror host in FileInspector and the
// WYSIWYG ProseMirror div in MarkdownEditor. Wait for the CodeMirror host when
// a test needs source mode. The test ids are pinned by e2e and must not change.
// The edit toggle is `disabled={readOnly || opening}`, and a click on a
// disabled button does nothing and does not retry. A click fired the moment the
// button exists is therefore dropped whenever the open has not answered yet,
// and the wait for the source surface then times out on a toggle that never
// happened. Clicking a mode toggle more than once is not a fix — the modes
// cycle — so the enabled button is the thing to wait for.
async function findEnabledMarkdownEditToggle(): Promise<HTMLElement> {
  return await waitFor(() => {
    const toggle = screen.getByTestId("markdown-edit-toggle");
    if (toggle instanceof HTMLButtonElement && toggle.disabled) {
      throw new Error(
        "markdown-edit-toggle is still disabled — the document is opening",
      );
    }
    return toggle;
  });
}

// The P1 trap: typing arms an 800ms autosave, and unmounting
// (tab close, tab switch — the inspector is keyed by the active tab) used to
// clear the timer without flushing, silently dropping the draft. The unmount
// cleanup must fire the pending draft through writeWorkspaceText.
describe("markdown editor unmount flush", () => {
  const bridgeMock = {
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text: "# Hello\n",
      truncated: false as const,
      contentHash: TEST_CONTENT_HASH,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
      async () => ({ status: "written", contentHash: TEST_CONTENT_HASH }),
    ),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
    writeWorkspaceAsset: vi.fn<DohcDesktopBridge["writeWorkspaceAsset"]>(
      async () => undefined,
    ),
  };

  beforeEach(() => {
    stubEditorGlobals();
    resetOrphanedDrafts();
    bridgeMock.readWorkspaceText.mockReset().mockResolvedValue({
      text: "# Hello\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    bridgeMock.writeWorkspaceText.mockReset().mockResolvedValue({
      status: "written",
      contentHash: TEST_CONTENT_HASH,
    });
    bridgeMock.writeWorkspaceAsset.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(async () => {
    // Real timers before cleanup: settleAfterUnmount below awaits real
    // promise settlement, which a still-fake, still-frozen clock would hang.
    vi.useRealTimers();
    cleanup();
    await settleAfterUnmount();
    await resetOrphanedDraftsAndSettle();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function typeDraft() {
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "Draft!",
    );
    return { user, view };
  }

  it("retains the local buffer through StrictMode without a blank committed view", () => {
    const path = "assets/identity.png";
    const key = documentVersionKey("ws-1", path, undefined);
    const view = render(
      <StrictMode>
        <FileInspector workspaceId="ws-1" path={path} />
      </StrictMode>,
    );

    expect(screen.getByTestId("file-inspector")).toBeTruthy();
    const retained = getSharedLocalDocument(key);

    const nextPath = "assets/next-identity.png";
    const nextKey = documentVersionKey("ws-1", nextPath, undefined);
    view.rerender(
      <StrictMode>
        <FileInspector workspaceId="ws-1" path={nextPath} />
      </StrictMode>,
    );
    expect(screen.getAllByText("next-identity.png").length).toBeGreaterThan(0);
    expect(getSharedLocalDocument(key)).not.toBe(retained);
    const nextRetained = getSharedLocalDocument(nextKey);

    view.unmount();

    expect(getSharedLocalDocument(nextKey)).not.toBe(nextRetained);
  });

  it("shows a no-baseline flush error in both duplicate text panes", async () => {
    const path = "notes/shared-no-baseline.txt";
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", path, undefined),
    );
    buffer.publishDraft("unsaved", {});
    const flushes: DraftFlush[] = [];
    render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path={path}
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          workspaceId="ws-1"
          path={path}
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );
    await waitFor(() => expect(flushes).toHaveLength(2));

    await expect(flushes[0]!()).rejects.toThrow(
      "dohc cannot save this draft without a content hash.",
    );

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-save-state")
          .every((state) => state.dataset.state === "error"),
      ).toBe(true),
    );
  });

  it("keeps a new-version peer draft when a slower duplicate reread lands", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveFirstSwitch!: (value: ReadResult) => void;
    let resolveSecondSwitch!: (value: ReadResult) => void;
    const firstSwitch = new Promise<ReadResult>((resolve) => {
      resolveFirstSwitch = resolve;
    });
    const secondSwitch = new Promise<ReadResult>((resolve) => {
      resolveSecondSwitch = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "# Old\n",
        truncated: false,
        contentHash: "1".repeat(64),
      })
      .mockResolvedValueOnce({
        text: "# Old\n",
        truncated: false,
        contentHash: "1".repeat(64),
      })
      .mockImplementationOnce(() => firstSwitch)
      .mockImplementationOnce(() => secondSwitch);
    const user = userEvent.setup();
    const toggles: Array<(() => void) | null> = [null, null];
    const view = render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.md"
          engineVersionKey={1}
          registerSourceToggle={(toggle) => {
            toggles[0] = toggle;
          }}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.md"
          engineVersionKey={1}
          registerSourceToggle={(toggle) => {
            toggles[1] = toggle;
          }}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    await toggleSourceOnce(() => toggles[0]);
    await toggleSourceOnce(() => toggles[1]);

    view.rerender(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.md"
          engineVersionKey={2}
          refreshKey={1}
          registerSourceToggle={(toggle) => {
            toggles[0] = toggle;
          }}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.md"
          engineVersionKey={2}
          refreshKey={1}
          registerSourceToggle={(toggle) => {
            toggles[1] = toggle;
          }}
        />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4),
    );
    await act(async () => {
      resolveFirstSwitch({
        text: "# New\n",
        truncated: false,
        contentHash: "2".repeat(64),
      });
      await firstSwitch;
    });
    const firstEditorElement = (await screen.findAllByTestId("markdown-editor"))[0]!;
    await textEditorContent(firstEditorElement);
    const firstEditor = codeEditorTestHost(firstEditorElement);
    await waitFor(() => expect(firstEditor.value).toContain("# New"));
    appendCodeEditorText(firstEditor, " peer draft");
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/versioned.md", 2),
    );
    expect(buffer.getSnapshot()).toMatchObject({
      body: "# New\n peer draft",
      dirty: true,
    });

    await act(async () => {
      resolveSecondSwitch({
        text: "# New\n",
        truncated: false,
        contentHash: "2".repeat(64),
      });
      await secondSwitch;
    });

    await waitFor(() =>
      expect(buffer.getSnapshot()).toMatchObject({
        body: "# New\n peer draft",
        dirty: true,
      }),
    );
  });

  it("unblocks a duplicate text pane after its matching switch read preserves a peer draft", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveFirstSwitch!: (value: ReadResult) => void;
    let resolveSecondSwitch!: (value: ReadResult) => void;
    const firstSwitch = new Promise<ReadResult>((resolve) => {
      resolveFirstSwitch = resolve;
    });
    const secondSwitch = new Promise<ReadResult>((resolve) => {
      resolveSecondSwitch = resolve;
    });
    const oldHash = "1".repeat(64);
    const switchedHash = "2".repeat(64);
    const peerSavedHash = "3".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Old",
        truncated: false,
        contentHash: oldHash,
      })
      .mockResolvedValueOnce({
        text: "Old",
        truncated: false,
        contentHash: oldHash,
      })
      .mockImplementationOnce(() => firstSwitch)
      .mockImplementationOnce(() => secondSwitch);
    bridgeMock.writeWorkspaceText
      .mockResolvedValueOnce({ status: "written", contentHash: peerSavedHash })
      .mockResolvedValueOnce({
        status: "written",
        contentHash: "4".repeat(64),
      });
    const flushes: DraftFlush[] = [];
    const view = render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={1}
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={1}
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-text-editor")).toHaveLength(2),
    );
    view.rerender(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={2}
          refreshKey={1}
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={2}
          refreshKey={1}
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4),
    );
    await act(async () => {
      resolveFirstSwitch({
        text: "New",
        truncated: false,
        contentHash: switchedHash,
      });
      await firstSwitch;
    });
    const user = userEvent.setup();
    let editors = screen.getAllByTestId("view-text-editor");
    const firstContent = await textEditorContent(editors[0]!);
    await waitFor(() => expect(firstContent.textContent).toBe("New"));
    await user.click(firstContent);
    await user.keyboard("{End} peer");

    await act(async () => {
      resolveSecondSwitch({
        text: "New",
        truncated: false,
        contentHash: switchedHash,
      });
      await secondSwitch;
    });
    await act(async () => flushes[0]!());
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/versioned.txt",
      text: "New peer",
      expectedContentHash: switchedHash,
    });

    editors = screen.getAllByTestId("view-text-editor");
    const secondContent = await textEditorContent(editors[1]!);
    await waitFor(() => expect(secondContent.textContent).toBe("New peer"));
    await user.click(secondContent);
    await user.keyboard("{End} second");
    await act(async () => flushes[1]!());
    expect(bridgeMock.writeWorkspaceText).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/versioned.txt",
      text: "New peer second",
      expectedContentHash: peerSavedHash,
    });
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
  });

  it("keeps a peer's new-version text draft when a later duplicate read lifts its refusal", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveFirstSwitch!: (value: ReadResult) => void;
    let resolveSecondSwitch!: (value: ReadResult) => void;
    const firstSwitch = new Promise<ReadResult>((resolve) => {
      resolveFirstSwitch = resolve;
    });
    const secondSwitch = new Promise<ReadResult>((resolve) => {
      resolveSecondSwitch = resolve;
    });
    const oldHash = "1".repeat(64);
    const switchedHash = "2".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Old",
        truncated: false,
        contentHash: oldHash,
      })
      .mockResolvedValueOnce({
        text: "Old",
        truncated: false,
        contentHash: oldHash,
      })
      .mockImplementationOnce(() => firstSwitch)
      .mockImplementationOnce(() => secondSwitch);
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "written",
      contentHash: "4".repeat(64),
    });
    const view = render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={1}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={1}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-text-editor")).toHaveLength(2),
    );
    view.rerender(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={2}
          refreshKey={1}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/versioned.txt"
          engineVersionKey={2}
          refreshKey={1}
        />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4),
    );

    // Both panes type while their replacement reads are in flight, so both
    // carry a blocked edit into the lift. The second pane types first: the
    // first pane's own edit is what its own lift sets aside.
    const user = userEvent.setup();
    let editors = screen.getAllByTestId("view-text-editor");
    await user.click(await textEditorContent(editors[1]!));
    await user.keyboard("{End} blocked-b");
    await user.click(await textEditorContent(editors[0]!));
    await user.keyboard("{End} blocked-a");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstSwitch({
        text: "New",
        truncated: false,
        contentHash: switchedHash,
      });
      await firstSwitch;
    });
    editors = screen.getAllByTestId("view-text-editor");
    const firstContent = await textEditorContent(editors[0]!);
    await waitFor(() => expect(firstContent.textContent).toBe("New"));
    await user.click(firstContent);
    await user.keyboard("{End} peer");
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/versioned.txt", 2),
    );
    expect(buffer.getSnapshot()).toMatchObject({
      body: "New peer",
      dirty: true,
    });

    await act(async () => {
      resolveSecondSwitch({
        text: "New",
        truncated: false,
        contentHash: switchedHash,
      });
      await secondSwitch;
    });

    await waitFor(() =>
      expect(buffer.getSnapshot(), "peer ownership: drop the guard from the refusal-lift reset. The later pane resets the shared buffer to the disk snapshot, and the edit its peer already published for this version is gone.").toMatchObject({
        body: "New peer",
        dirty: true,
      }),
    );
    editors = screen.getAllByTestId("view-text-editor");
    const secondContent = await textEditorContent(editors[1]!);
    await waitFor(() => expect(secondContent.textContent).toBe("New peer"));
    // ...and the write that follows carries the peer's edit, not the disk
    // snapshot the lift would have restored.
    await waitFor(
      () =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "notes/versioned.txt",
          text: "New peer",
          expectedContentHash: switchedHash,
        }),
      { timeout: 2000 },
    );
  });

  it("marks every duplicate text pane errored when a blocked write leaves a shared draft dirty", async () => {
    const flushes: DraftFlush[] = [];
    const first = (
      <FileInspector
        key="first"
        workspaceId="ws-1"
        path="notes/blocked.txt"
        registerDraftFlush={(flush) => {
          if (flush) flushes[0] = flush;
        }}
      />
    );
    const second = (
      <FileInspector
        key="second"
        workspaceId="ws-1"
        path="notes/blocked.txt"
        registerDraftFlush={(flush) => {
          if (flush) flushes[1] = flush;
        }}
      />
    );
    const view = render(<>{first}{second}</>);
    const editors = await screen.findAllByTestId("view-text-editor");
    const firstContent = await textEditorContent(editors[0]!);
    const user = userEvent.setup();
    await user.click(firstContent);
    await user.keyboard("{End} dirty");
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-save-state")
          .every((state) => state.dataset.state === "saving"),
      ).toBe(true),
    );
    view.rerender(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="notes/blocked.txt"
          readOnly
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        {second}
      </>,
    );

    await act(async () => flushes[0]!());
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-save-state")
          .every((state) => state.dataset.state === "error"),
      ).toBe(true),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("marks every duplicate Markdown pane errored when a blocked write leaves a shared draft dirty", async () => {
    const flushes: DraftFlush[] = [];
    const toggles: Array<(() => void) | null> = [null, null];
    const second = (
      <FileInspector
        key="second"
        workspaceId="ws-1"
        path="notes/blocked.md"
        registerDraftFlush={(flush) => {
          if (flush) flushes[1] = flush;
        }}
        registerSourceToggle={(toggle) => {
          toggles[1] = toggle;
        }}
      />
    );
    const view = render(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="notes/blocked.md"
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
          registerSourceToggle={(toggle) => {
            toggles[0] = toggle;
          }}
        />
        {second}
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    await toggleSourceOnce(() => toggles[0]);
    await toggleSourceOnce(() => toggles[1]);
    const editors = await Promise.all(
      screen.getAllByTestId("markdown-editor").map(async (editor) => {
        await textEditorContent(editor);
        return codeEditorTestHost(editor);
      }),
    );
    const user = userEvent.setup();
    appendCodeEditorText(editors[0]!, " dirty");
    view.rerender(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="notes/blocked.md"
          readOnly
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
          registerSourceToggle={(toggle) => {
            toggles[0] = toggle;
          }}
        />
        {second}
      </>,
    );

    await act(async () => flushes[0]!());
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("markdown-save-state")
          .every((state) => state.dataset.state === "error"),
      ).toBe(true),
    );
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("refreshes a stale duplicate text pane once its peer-owned conflict draft saves", async () => {
    const initialHash = "1".repeat(64);
    const externalHash = "2".repeat(64);
    const peerSavedHash = "3".repeat(64);
    let readBody = "Base";
    let readHash = initialHash;
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveRefresh!: (value: ReadResult) => void;
    const heldRefresh = new Promise<ReadResult>((resolve) => {
      resolveRefresh = resolve;
    });
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(() => {
      reads += 1;
      if (reads === 4) return heldRefresh;
      return Promise.resolve({
        text: readBody,
        truncated: false,
        contentHash: readHash,
      });
    });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldConflict)
      .mockResolvedValueOnce({ status: "written", contentHash: peerSavedHash });
    const flushes: DraftFlush[] = [];
    const textPane = (key: string, refreshKey: number, index: number) => (
      <FileInspector
        key={key}
        workspaceId="ws-1"
        path="notes/conflict-refresh.txt"
        refreshKey={refreshKey}
        registerDraftFlush={(flush) => {
          if (flush) flushes[index] = flush;
        }}
      />
    );
    const view = render(<>{textPane("first", 0, 0)}{textPane("second", 0, 1)}</>);
    let editors = await screen.findAllByTestId("view-text-editor");
    const user = userEvent.setup();
    const firstContent = await textEditorContent(editors[0]!);
    await user.click(firstContent);
    await user.keyboard("{End} local");
    await waitFor(() => expect(flushes).toHaveLength(2));
    const firstFlush = flushes[0]!().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    readBody = "External";
    readHash = externalHash;
    view.rerender(
      <>{textPane("first", 1, 0)}{textPane("second", 0, 1)}</>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    editors = screen.getAllByTestId("view-text-editor");
    const secondContent = await textEditorContent(editors[1]!);
    await user.click(secondContent);
    await user.keyboard("{End} peer");

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(await firstFlush).toBe("rejected");
    expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3);

    readBody = "Base local peer";
    readHash = peerSavedHash;
    await act(async () => flushes[1]!());
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4),
    );
    await act(async () => {
      resolveRefresh({
        text: readBody,
        truncated: false,
        contentHash: readHash,
      });
      await heldRefresh;
    });
    expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4);
  });

  it("refreshes a stale duplicate Markdown pane once its peer-owned conflict draft saves", async () => {
    const initialHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    const peerSavedHash = "6".repeat(64);
    let readBody = "# Base\n";
    let readHash = initialHash;
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveRefresh!: (value: ReadResult) => void;
    const heldRefresh = new Promise<ReadResult>((resolve) => {
      resolveRefresh = resolve;
    });
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(() => {
      reads += 1;
      if (reads === 4) return heldRefresh;
      return Promise.resolve({
        text: readBody,
        truncated: false,
        contentHash: readHash,
      });
    });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldConflict)
      .mockResolvedValueOnce({ status: "written", contentHash: peerSavedHash });
    const flushes: DraftFlush[] = [];
    const toggles: Array<(() => void) | null> = [null, null];
    const markdownPane = (key: string, refreshKey: number, index: number) => (
      <FileInspector
        key={key}
        workspaceId="ws-1"
        path="notes/conflict-refresh.md"
        refreshKey={refreshKey}
        registerDraftFlush={(flush) => {
          if (flush) flushes[index] = flush;
        }}
        registerSourceToggle={(toggle) => {
          toggles[index] = toggle;
        }}
      />
    );
    const view = render(
      <>{markdownPane("first", 0, 0)}{markdownPane("second", 0, 1)}</>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    await toggleSourceOnce(() => toggles[0]);
    await toggleSourceOnce(() => toggles[1]);
    let editors = await Promise.all(
      screen.getAllByTestId("markdown-editor").map(async (editor) => {
        await textEditorContent(editor);
        return codeEditorTestHost(editor);
      }),
    );
    const user = userEvent.setup();
    appendCodeEditorText(editors[0]!, " local");
    await waitFor(() => expect(flushes).toHaveLength(2));
    const firstFlush = flushes[0]!().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    readBody = "# External\n";
    readHash = externalHash;
    view.rerender(
      <>{markdownPane("first", 1, 0)}{markdownPane("second", 0, 1)}</>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    editors = await Promise.all(
      screen.getAllByTestId("markdown-editor").map(async (editor) => {
        await textEditorContent(editor);
        return codeEditorTestHost(editor);
      }),
    );
    appendCodeEditorText(editors[1]!, " peer");

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(await firstFlush).toBe("rejected");
    expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3);

    readBody = "# Base\n local peer";
    readHash = peerSavedHash;
    await act(async () => flushes[1]!());
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4),
    );
    await act(async () => {
      resolveRefresh({
        text: readBody,
        truncated: false,
        contentHash: readHash,
      });
      await heldRefresh;
    });
    expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(4);
  });

  it("flushes the pending draft on unmount — the write carries the final text", async () => {
    const { view } = await typeDraft();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    // Unmount inside the 800ms autosave window (real timers; typing is fast).
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: "# Hello\nDraft!",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("materializes the final WYSIWYG body when its owner unmounts before debounce", async () => {
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    const editor = await screen.findByTestId("markdown-editor");
    expect(editor.classList.contains("dohc-code-editor")).toBe(false);
    await user.type(editor, "Latest");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: "# LatestHello\n\n",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("does not double-write when the draft already saved before unmount", async () => {
    const { user, view } = await typeDraft();
    // "Done" flushes immediately (the Ctrl+S path) — draft saved.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    view.unmount();
    // The unmount flush keys off the unsaved-draft flag, not the timer
    // handle: a clean save must not be replayed as a second write.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("palette source toggle flushes a pending raw draft before leaving source mode", async () => {
    // Leaving editable source through the palette command must flush
    // the raw draft like the header toggle does — a timer firing after the
    // mode switch would re-serialize through the (lossy) Tiptap parse.
    const user = userEvent.setup();
    let registered: (() => void) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          registered = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    // registered?.() optional-chains to a silent no-op until the inspector has
    // handed back its toggle, which leaves the view in wysiwyg and fails the
    // editor lookup below with a confusing "not found". Wait for the toggle.
    await waitFor(() => expect(registered).not.toBeNull());
    await toggleSourceOnce(() => registered); // wysiwyg -> editable source (legacy branch)
    const sourceEditor = await findSourceEditor();
    await user.click(await textEditorContent(sourceEditor));
    codeEditorView(sourceEditor).dispatch({
      selection: { anchor: sourceEditor.value.length },
    });
    await user.keyboard("Raw!");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    await toggleSourceOnce(() => registered); // source -> wysiwyg: flushes inside the window
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "a.md",
        text: "# Hello\nRaw!",
        expectedContentHash: TEST_CONTENT_HASH,
      }),
    );
  });

  it("does not focus an inactive inspector's source editor", async () => {
    let registered: (() => void) | null = null;
    render(
      <>
        <button type="button" data-testid="active-group-control">
          Active group
        </button>
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          autoFocus={false}
          registerSourceToggle={(toggle) => {
            registered = toggle;
          }}
        />
      </>,
    );
    await screen.findByTestId("view-markdown");
    const activeGroupControl = screen.getByTestId("active-group-control");
    activeGroupControl.focus();

    await toggleSourceOnce(() => registered);
    await findSourceEditor();

    expect(document.activeElement).toBe(activeGroupControl);
  });

  it("focuses the source editor when autoFocus is omitted", async () => {
    let registered: (() => void) | null = null;
    render(
      <>
        <button type="button" data-testid="previous-focus">
          Previous focus
        </button>
        <FileInspector
          workspaceId="ws-1"
          path="a.md"
          registerSourceToggle={(toggle) => {
            registered = toggle;
          }}
        />
      </>,
    );
    await screen.findByTestId("view-markdown");
    screen.getByTestId("previous-focus").focus();

    await toggleSourceOnce(() => registered);
    const sourceEditor = await findSourceEditor();

    expect(document.activeElement).toBe(await textEditorContent(sourceEditor));
  });

  it("opens large editable Markdown in CodeMirror and keeps every rapid keystroke", async () => {
    const largeBody = `# Large\n\n${"Body line\n".repeat(8_000)}`;
    const typed = "profilex-0123456789-abcdefghij";
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: largeBody,
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="large.md" />);

    const editToggle = await findEnabledMarkdownEditToggle();
    expect(editToggle.textContent).toBe("Edit");
    await user.click(editToggle);
    const sourceEditor = await findSourceEditor();
    const content = await textEditorContent(sourceEditor);

    expect(content.getAttribute("contenteditable")).toBe("true");
    expect(editToggle.textContent).toBe("WYSIWYG");
    await user.click(content);
    codeEditorView(sourceEditor).dispatch({
      selection: { anchor: largeBody.length },
    });
    await user.keyboard(typed);

    expect(sourceEditor.value).toBe(`${largeBody}${typed}`);
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text).toBe(
      `${largeBody}${typed}`,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
  });

  it("applies an accepted peer value to a mounted Markdown source editor", async () => {
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await user.click(await findEnabledMarkdownEditToggle());
    const sourceEditor = await findSourceEditor();
    const content = await textEditorContent(sourceEditor);
    await user.click(content);
    await user.keyboard("{End} local");
    expect(sourceEditor.value).toBe("# Hello local\n");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    const peerSource = {};
    act(() => {
      getSharedLocalDocument(
        documentVersionKey("ws-1", "a.md", undefined),
      ).publishDraft("# Peer\n", peerSource);
    });

    await waitFor(() => expect(sourceEditor.value).toBe("# Peer\n"));
  });

  it("keeps small Markdown WYSIWYG-first and preserves raw source across a round trip", async () => {
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    const initialEditor = await screen.findByTestId("markdown-editor");
    expect(initialEditor.classList.contains("dohc-code-editor")).toBe(false);
    const editToggle = await findEnabledMarkdownEditToggle();
    expect(editToggle.textContent).toBe("Source");
    await user.click(editToggle);
    const sourceEditor = await findSourceEditor();
    const rawSource = "# Hello\n\n<!-- keep raw -->\n";
    replaceCodeEditorText(sourceEditor, rawSource);

    await user.click(editToggle);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("markdown-editor")
          .classList.contains("dohc-code-editor"),
      ).toBe(false),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
    await user.click(editToggle);
    const reopenedSource = await findSourceEditor();
    expect(reopenedSource.value).toBe(rawSource);
  });

  it("settles a successful legacy save while mounted in StrictMode", async () => {
    let releaseWrite!: () => void;
    const heldWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseWrite = () =>
          resolve({ status: "written", contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    render(
      <StrictMode>
        <FileInspector workspaceId="ws-1" path="a.md" />
      </StrictMode>,
    );

    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "Draft!",
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.getByTestId("markdown-save-state").getAttribute("data-state"),
    ).toBe("saving");

    await act(async () => {
      releaseWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("markdown-save-state").getAttribute("data-state"),
      ).toBe("saved"),
    );
  });

  it("offers a read-only source view for read-only markdown (truncated reads)", async () => {
    // codex P3 follow-up: a read-only doc can't edit, but viewing raw source
    // is still a view. The palette toggle opens the read-only source editor and
    // never writes.
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Big\n",
      truncated: true,
      contentHash: null,
    });
    let registered: (() => void) | null = null;
    render(
      <FileInspector
        workspaceId="ws-1"
        path="large.md"
        registerSourceToggle={(toggle) => {
          registered = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => registered);
    const textarea = await findSourceEditor();
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toContain("# Big");
    await toggleSourceOnce(() => registered);
    await screen.findByTestId("view-markdown");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("edits markdown frontmatter properties through the same save seam", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("view-markdown");
    // Properties render inline under the title now — no toggle to open.
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: "---\nid: note-1\ntitle: Plan\nstatus: ready\n---\n\n# Plan\n",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("keeps a pending WYSIWYG body edit when the title changes before debounce", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\ntitle: Plan\n---\n\n# Plan\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let flush: DraftFlush | null = null;
    const user = userEvent.setup();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const editor = await screen.findByTestId("markdown-editor");
    await user.click(editor);
    await user.type(editor, "body edit");
    await waitFor(() =>
      expect(screen.getByTestId("markdown-save-state").dataset.state).toBe(
        "saving",
      ),
    );

    const title = screen.getByTestId("page-title") as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Retitled" } });
    fireEvent.blur(title);
    await waitFor(() => expect(flush).not.toBeNull());
    await act(async () => flush!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      relativePath: "a.md",
      expectedContentHash: TEST_CONTENT_HASH,
    });
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("title: Retitled");
    expect(written).toContain("body edit");
  });

  it("surfaces a failed read-mode PageIdentity save instead of hiding it", async () => {
    // Read mode hides the idle "Saved" chip, but PageIdentity stays editable and
    // autosaves title/icon edits. A failed save must still surface — otherwise
    // the optimistic title keeps showing while the write silently failed. A body
    // over the WYSIWYG threshold opens in read mode without being truncated
    // (truncated would make PageIdentity read-only and skip the save entirely).
    const bigBody = `---\ntitle: Plan\n---\n\n${LARGE_READ_MODE_FILLER}`;
    expect(bigBody.length).toBeGreaterThan(64 * 1024);
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: bigBody,
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    bridgeMock.writeWorkspaceText.mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="plan.md" />);

    // Read mode: no editor, but the editable PageIdentity title is present.
    await screen.findByTestId("page-identity");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    // No pending save yet, so the save-state chip is hidden in read mode.
    expect(screen.queryByTestId("markdown-save-state")).toBeNull();

    const title = screen.getByTestId("page-title") as HTMLInputElement;
    await user.click(title);
    await user.type(title, "!");

    // The autosave (800ms debounce) fails; the failure must become visible
    // even though we never left read mode. Await the real write first — the
    // debounce plus load must never race a wall-clock window (its old 3s
    // bound was measured at 3.1s under a 24-process load) — and bound
    // it, so a product that never writes fails as this named assertion
    // rather than as the test deadline. 10s is ~3x the loaded measurement.
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalled(),
      { timeout: 10_000 },
    );
    await waitFor(() => {
      const chip = screen.getByTestId("markdown-save-state");
      expect(chip.textContent).toBe("Couldn't save");
      expect(chip.getAttribute("data-state")).toBe("error");
    });
    // The optimistic title edit is still displayed alongside the failure.
    expect(title.value).toContain("!");
    view.unmount();
  });

  it("does not expose properties editing for truncated markdown reads", async () => {
    const user = userEvent.setup();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
      truncated: true,
      contentHash: null,
    });
    const view = render(<FileInspector workspaceId="ws-1" path="large.md" />);

    await screen.findByTestId("view-markdown");

    expect(screen.getByTestId("truncated-notice")).toBeTruthy();
    // A truncated (read-only) doc never exposes editable inline properties.
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    const editToggle = screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement;
    expect(editToggle.disabled).toBe(true);
    await user.click(editToggle);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("navigates the rendered heading in a read-only shared document", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Hello\n\n## Exact destination\nBody\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const view = render(
      <FileInspector workspaceId="ws-1" path="a.md" readOnly />,
    );
    await screen.findByTestId("view-markdown");
    await waitFor(() =>
      expect(screen.getByTestId("markdown-edit-toggle").textContent).toBe("Edit"),
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        readOnly
        headingTarget={{ anchor: "exact-destination", nonce: 2 }}
      />,
    );

    await waitFor(() => {
      const destination = screen.getByRole("heading", {
        name: "Exact destination",
      });
      expect(destination.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
    });
    expect(screen.getByTestId("markdown-edit-toggle").textContent).toBe("Edit");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("opens parsed links from the legacy read-only shared document", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: [
        "# Status",
        "",
        "[FAQ](faq%3F.md?mode=preview#answers)",
        "[Hash notes](%23notes.md?mode=preview#risks)",
        "[Section](#next%20steps)",
      ].join("\n"),
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const onOpenPath = vi.fn();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/status.md"
        readOnly
        knownMarkdownFiles={[
          { path: "#notes.md", title: "Root hash notes" },
          { path: "notes/#notes.md", title: "Notes hash notes" },
          { path: "notes/faq?.md", title: "FAQ" },
        ]}
        onOpenPath={onOpenPath}
      />,
    );
    const link = await screen.findByRole("link", { name: "FAQ" });
    await waitFor(() =>
      expect(screen.getByTestId("markdown-edit-toggle").textContent).toBe("Edit"),
    );
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    link.focus();
    expect(document.activeElement).toBe(link);

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(link.dispatchEvent(click)).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(onOpenPath).toHaveBeenCalledWith("notes/faq?.md", {
      anchor: "answers",
      nonce: 1,
    });
    expect(onOpenPath).toHaveBeenCalledOnce();

    const hashClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(
      screen.getByRole("link", { name: "Hash notes" }).dispatchEvent(hashClick),
    ).toBe(false);
    expect(onOpenPath).toHaveBeenLastCalledWith("notes/#notes.md", {
      anchor: "risks",
      nonce: 2,
    });

    const fragmentClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(
      screen.getByRole("link", { name: "Section" }).dispatchEvent(fragmentClick),
    ).toBe(false);
    expect(onOpenPath).toHaveBeenLastCalledWith("notes/status.md", {
      anchor: "next%20steps",
      nonce: 3,
    });
    expect(onOpenPath).toHaveBeenCalledTimes(3);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("scrolls to the top for an explicit empty fragment target", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Status\n\nBody\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const scrollTo = stubScrollSpy("scrollTo");
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/status.md" readOnly />,
    );
    await screen.findByTestId("view-markdown");

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/status.md"
        readOnly
        headingTarget={{ anchor: "", nonce: 29 }}
      />,
    );

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
  });

  it("keeps encoded filename hashes distinct from real fragments without known files", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: [
        "[Unknown](new%23plan.md)",
        "[Multiple](new%23release%231.md)",
        "[Fragment](new%23plan.md?mode=preview#risks)",
        "[Raw root](/plan.md#raw-root)",
        "[Encoded root](%2Fplan.md#root)",
        "[Encoded fragment](#a%2520b)",
        "[Empty fragment](#)",
        "[Malformed](bad%E0%A4%A.md#part%E0%A4%A)",
      ].join("\n"),
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const onOpenPath = vi.fn();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/status.md"
        readOnly
        knownMarkdownFiles={[]}
        onOpenPath={onOpenPath}
      />,
    );
    await screen.findByRole("link", { name: "Unknown" });

    for (const [name, expectedPath, rawFragment] of [
      ["Unknown", "notes/new#plan.md", undefined],
      ["Multiple", "notes/new#release#1.md", undefined],
      ["Fragment", "notes/new#plan.md", "risks"],
      ["Raw root", "plan.md", "raw-root"],
      ["Encoded root", "plan.md", "root"],
      ["Encoded fragment", "notes/status.md", "a%2520b"],
      ["Empty fragment", "notes/status.md", ""],
      ["Malformed", "notes/bad%E0%A4%A.md", "part%E0%A4%25A"],
    ] as const) {
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
      });
      expect(screen.getByRole("link", { name }).dispatchEvent(click)).toBe(false);
      expect(onOpenPath).toHaveBeenLastCalledWith(
        expectedPath,
        rawFragment !== undefined
          ? { anchor: rawFragment, nonce: onOpenPath.mock.calls.length }
          : undefined,
      );
    }
    expect(onOpenPath).toHaveBeenCalledTimes(8);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("keeps local source mode and selects the target heading line", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\ntitle: Plan\n---\n\n# Hello\n\nParagraph\n\n## Exact destination\nBody\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let toggleSource: (() => void) | null = null;
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
        headingTarget={{ anchor: "exact-destination", nonce: 3 }}
      />,
    );

    const expected = lineSpanInText(source.value, 9);
    await waitFor(() => {
      expect(source.selectionStart).toBe(expected.start);
      expect(source.selectionEnd).toBe(expected.end);
    });
    expect(screen.getByTestId("markdown-editor")).toBe(source);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("navigates an allocated-suffix occurrence target to the repeated base heading", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "# Foo\nfirst\n# Foo-1\nliteral\n# Foo\nthird\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let toggleSource: (() => void) | null = null;
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
      />,
    );
    await screen.findByTestId("view-markdown");
    await toggleSourceOnce(() => toggleSource);
    const source = await findSourceEditor();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        registerSourceToggle={(toggle) => {
          toggleSource = toggle;
        }}
        headingTarget={{ anchor: "foo-1", occurrence: 1, nonce: 4 }}
      />,
    );

    const expected = lineSpanInText(source.value, 5);
    await waitFor(() => {
      expect(source.selectionStart).toBe(expected.start);
      expect(source.selectionEnd).toBe(expected.end);
    });
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe("# Foo");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("routes the document header share action to the active path", async () => {
    const user = userEvent.setup();
    const onSharePath = vi.fn();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="a.md"
        onSharePath={onSharePath}
      />,
    );

    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("file-share"));

    expect(onSharePath).toHaveBeenCalledWith("a.md");
  });

  it("edits plain text files through the same bounded write seam", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const view = render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    const editor = await screen.findByTestId("view-text-editor");
    const content = await textEditorContent(editor);

    // Freeze the clock only once the editor is mounted, and never advance it
    // before unmount: the 800ms autosave debounce stays at 0ms elapsed, so
    // the unmount flush is the only thing that can produce this write.
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await settleUserEventAction(user.click(content));
    await settleUserEventAction(user.keyboard("hello world"));
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        relativePath: "notes/plain.txt",
      }),
    );
    const lastWrite = bridgeMock.writeWorkspaceText.mock.calls.at(-1)?.[0] as
      | { text: string }
      | undefined;
    expect(lastWrite?.text).not.toBe("");
  });

  it("shares a local draft and save baseline across duplicate text inspectors", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const register = (flush: DraftFlush | null) => {
      if (flush) flushes.push(flush);
    };
    const user = userEvent.setup();
    render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={register}
        />
        <FileInspector
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={register}
        />
      </>,
    );

    const [first, second] = await findTextEditorContents(2);
    await user.click(first);
    await user.keyboard("{End} shared");

    await waitFor(() => expect(second.textContent).toContain("before shared"));
    await act(async () => flushes[1]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/shared.txt",
      text: "before shared",
      expectedContentHash: TEST_CONTENT_HASH,
    });
    expect(
      screen
        .getAllByTestId("view-text-save-state")
        .every((state) => state.dataset.state === "saved"),
    ).toBe(true);
  });

  it("does not rewrite a duplicate text draft after its peer saves the same body", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    const view = render(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          key="second"
          workspaceId="ws-1"
          path="notes/shared.txt"
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );

    const [first, second] = await findTextEditorContents(2);
    await user.click(first);
    await user.keyboard("{End} first");
    await waitFor(() => expect(second.textContent).toContain("before first"));
    await user.click(second);
    await user.keyboard("{End} second");
    await waitFor(() =>
      expect(first.textContent).toContain("before first second"),
    );

    await act(async () => flushes[0]!());
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-save-state")
          .every((state) => state.dataset.state === "saved"),
      ).toBe(true),
    );
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/shared.txt",
      text: "before first second",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("hydrates a duplicate text inspector mounted after the shared draft is dirty", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    const first = (
      <FileInspector
        key="first"
        workspaceId="ws-1"
        path="notes/shared.txt"
      />
    );
    const view = render(first);
    const firstContent = await findTextEditorContent();
    await user.click(firstContent);
    await user.keyboard("{End} dirty");
    await waitFor(() => expect(firstContent.textContent).toContain("before dirty"));

    view.rerender(
      <>
        {first}
        <FileInspector
          key="second"
          workspaceId="ws-1"
          path="notes/shared.txt"
        />
      </>,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId("view-text-editor")).toHaveLength(2),
    );
    const editors = screen.getAllByTestId("view-text-editor");
    await waitFor(() =>
      expect(editors[1]!.textContent).toContain("before dirty"),
    );
  });

  it("keeps a dirty duplicate body when a forced conflict read arrives", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "before",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let finishWrite!: () => void;
    const heldWrite = new Promise<{
      status: "written";
      contentHash: string;
    }>((resolve) => {
      finishWrite = () =>
        resolve({ status: "written", contentHash: "c".repeat(64) });
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    render(
      <>
        <FileInspector workspaceId="ws-1" path="notes/conflict.txt" />
        <FileInspector workspaceId="ws-1" path="notes/conflict.txt" />
      </>,
    );
    const editors = await screen.findAllByTestId("view-text-editor");
    const first = await textEditorContent(editors[0]!);
    await user.click(first);
    await user.keyboard("{End} peer draft");
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/conflict.txt", undefined),
    );
    // Make the state under test explicit. Under combined-suite load, typing
    // can span the debounce and the default instant writer can legitimately
    // clean the buffer before the forced reread arrives.
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    expect(buffer.getSnapshot().dirty).toBe(true);

    act(() => {
      expect(
        buffer.acceptRead(
          "disk after",
          "b".repeat(64),
          {},
          true,
          buffer.beginRead(),
        ),
      ).toBe(false);
    });

    expect(buffer.getSnapshot()).toMatchObject({
      body: "before peer draft",
      contentHash: TEST_CONTENT_HASH,
      dirty: true,
      saveState: "error",
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-editor")
          .every((editor) => editor.textContent?.includes("before peer draft")),
      ).toBe(true),
    );
    await act(async () => {
      finishWrite();
      await heldWrite;
    });
  });

  it("keeps a later-started duplicate read when an older pane answers last", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveOlder!: (value: ReadResult) => void;
    let resolveNewer!: (value: ReadResult) => void;
    const older = new Promise<ReadResult>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ReadResult>((resolve) => {
      resolveNewer = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    render(
      <>
        <FileInspector workspaceId="ws-1" path="notes/ordered.txt" />
        <FileInspector workspaceId="ws-1" path="notes/ordered.txt" />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      resolveNewer({
        text: "newer",
        truncated: false,
        contentHash: "2".repeat(64),
      });
      await newer;
    });
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/ordered.txt", undefined),
    );
    await waitFor(() => expect(buffer.getSnapshot().body).toBe("newer"));

    await act(async () => {
      resolveOlder({
        text: "older",
        truncated: false,
        contentHash: "1".repeat(64),
      });
      await older;
    });

    expect(buffer.getSnapshot()).toMatchObject({
      body: "newer",
      contentHash: "2".repeat(64),
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-editor")
          .every((editor) => editor.textContent?.includes("newer")),
      ).toBe(true),
    );
  });

  it("adopts a rescued later duplicate text read after an earlier clean initialization", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    const olderHash = "0".repeat(64);
    const newerHash = "1".repeat(64);
    const writtenHash = "2".repeat(64);
    let resolveOlder!: (value: ReadResult) => void;
    let resolveNewer!: (value: ReadResult) => void;
    const older = new Promise<ReadResult>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ReadResult>((resolve) => {
      resolveNewer = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "written",
      contentHash: writtenHash,
    });
    let flush: DraftFlush | null = null;
    const user = userEvent.setup();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/rescued.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const newerView = render(
      <FileInspector workspaceId="ws-1" path="notes/rescued.txt" />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      resolveOlder({
        text: "older",
        truncated: false,
        contentHash: olderHash,
      });
      await older;
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-editor")
          .every((editor) => editor.textContent?.includes("older")),
      ).toBe(true),
    );

    await act(async () => {
      resolveNewer({
        text: "newer",
        truncated: false,
        contentHash: newerHash,
      });
      await newer;
      await Promise.resolve();
      newerView.unmount();
    });
    const editor = await waitFor(() => {
      const next = screen.getByTestId("view-text-editor");
      expect(next.textContent).toContain("newer");
      return next;
    });

    const content = await textEditorContent(editor);
    await user.click(content);
    await user.keyboard("{Control>}a{/Control}newer saved");
    await waitFor(() => expect(flush).not.toBeNull());
    await flush!();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toMatchObject({
      text: "newer saved",
      expectedContentHash: newerHash,
    });
    expect(
      getSharedLocalDocument(
        documentVersionKey("ws-1", "notes/rescued.txt", undefined),
      ).getSnapshot(),
    ).toMatchObject({
      contentHash: writtenHash,
      dirty: false,
      saveState: "saved",
    });
  });

  it("adopts a later duplicate Markdown read after an earlier clean initialization", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    const olderHash = "3".repeat(64);
    const newerHash = "4".repeat(64);
    const writtenHash = "5".repeat(64);
    let resolveOlder!: (value: ReadResult) => void;
    let resolveNewer!: (value: ReadResult) => void;
    const older = new Promise<ReadResult>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ReadResult>((resolve) => {
      resolveNewer = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "written",
      contentHash: writtenHash,
    });
    let flush: DraftFlush | null = null;
    const user = userEvent.setup();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/ordered.md"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const newerView = render(
      <FileInspector workspaceId="ws-1" path="notes/ordered.md" />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      resolveOlder({
        text: "# Older\n\nOld body.\n",
        truncated: false,
        contentHash: olderHash,
      });
      await older;
    });
    await screen.findByText("Old body.");

    await act(async () => {
      resolveNewer({
        text: "# Newer\n\nNew body.\n",
        truncated: false,
        contentHash: newerHash,
      });
      await newer;
      await Promise.resolve();
      newerView.unmount();
    });
    const editor = await waitFor(() => {
      const next = screen.getByTestId("markdown-editor");
      expect(next.textContent).toContain("New body.");
      return next;
    });

    await user.type(editor, " saved");
    await waitFor(() => expect(flush).not.toBeNull());
    await flush!();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toMatchObject({
      expectedContentHash: newerHash,
    });
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text).toContain(
      "New body.",
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text).toContain(
      "saved",
    );
    expect(
      getSharedLocalDocument(
        documentVersionKey("ws-1", "notes/ordered.md", undefined),
      ).getSnapshot(),
    ).toMatchObject({
      contentHash: writtenHash,
      dirty: false,
      saveState: "saved",
    });
  });

  it("rescues an answered read after switching version buffers before unmount", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    const initialHash = "6".repeat(64);
    const switchedHash = "7".repeat(64);
    let resolveSwitched!: (value: ReadResult) => void;
    let resolvePeer!: (value: ReadResult) => void;
    const switched = new Promise<ReadResult>((resolve) => {
      resolveSwitched = resolve;
    });
    const peer = new Promise<ReadResult>((resolve) => {
      resolvePeer = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "# Initial\n\nInitial body.\n",
        truncated: false,
        contentHash: initialHash,
      })
      .mockImplementationOnce(() => switched)
      .mockImplementationOnce(() => peer);
    const subject = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={1}
      />,
    );
    await screen.findByText("Initial body.");

    subject.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    const survivingPeer = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    const switchedBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/versioned.md", 2),
    );

    await act(async () => {
      resolveSwitched({
        text: "# Switched\n\nSwitched body.\n",
        truncated: false,
        contentHash: switchedHash,
      });
      await switched;
      await Promise.resolve();
      subject.unmount();
    });

    await waitFor(() =>
      expect(switchedBuffer.getSnapshot()).toMatchObject({
        initialized: true,
        body: "# Switched\n\nSwitched body.\n",
        contentHash: switchedHash,
      }),
    );

    await act(async () => {
      resolvePeer({
        text: "# Peer\n\nPeer body.\n",
        truncated: false,
        contentHash: "8".repeat(64),
      });
      await peer;
    });
    survivingPeer.unmount();
  });

  it("uses an older duplicate read when the later request fails", async () => {
    type ReadResult = {
      text: string;
      truncated: false;
      contentHash: string;
    };
    let resolveOlder!: (value: ReadResult) => void;
    let rejectNewer!: (reason: Error) => void;
    const older = new Promise<ReadResult>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ReadResult>((_resolve, reject) => {
      rejectNewer = reject;
    });
    bridgeMock.readWorkspaceText
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer)
      .mockResolvedValueOnce({
        text: "available",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
    const user = userEvent.setup();
    render(
      <>
        <FileInspector workspaceId="ws-1" path="notes/fallback.txt" />
        <FileInspector workspaceId="ws-1" path="notes/fallback.txt" />
      </>,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      rejectNewer(new Error("read failed"));
      await newer.catch(() => undefined);
    });
    await act(async () => {
      resolveOlder({
        text: "available",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
      await older;
    });

    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/fallback.txt", undefined),
    );
    await waitFor(() =>
      expect(buffer.getSnapshot()).toMatchObject({
        initialized: true,
        body: "available",
        contentHash: TEST_CONTENT_HASH,
      }),
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    const views = await screen.findAllByTestId("view-text-editor");
    expect(views).toHaveLength(2);
    const editor = await textEditorContent(views[1]!);
    await user.click(editor);
    await user.keyboard("{End} edit");
    await waitFor(
      () =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
          workspaceId: "ws-1",
          relativePath: "notes/fallback.txt",
          text: "available edit",
          expectedContentHash: TEST_CONTENT_HASH,
        }),
      { timeout: 5_000 },
    );
  });

  it("debounces WYSIWYG serialization without remounting its duplicate per keystroke", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "shared-wysiwyg.md", undefined),
    );
    const publishDraft = vi.spyOn(buffer, "publishDraft");
    const user = userEvent.setup();
    render(
      <>
        <FileInspector workspaceId="ws-1" path="shared-wysiwyg.md" />
        <FileInspector workspaceId="ws-1" path="shared-wysiwyg.md" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    expect(editors).toHaveLength(2);
    const peerEditor = editors[1]!;

    await user.click(editors[0]!);
    await user.type(editors[0]!, "Burst");

    expect(publishDraft).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("markdown-editor")[1]).toBe(peerEditor);
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("markdown-save-state")
          .every((state) => state.dataset.state === "saving"),
      ).toBe(true),
    );

    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(publishDraft).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getAllByTestId("markdown-editor")[1]!.textContent).toContain(
        "Burst",
      ),
    );
    expect(screen.getAllByTestId("markdown-editor")[1]).toBe(peerEditor);
  });

  it("lets a duplicate pane flush a pending WYSIWYG edit before its debounce", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="shared-wysiwyg-flush.md"
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          workspaceId="ws-1"
          path="shared-wysiwyg-flush.md"
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    await user.click(editors[0]!);
    await user.type(editors[0]!, "Peer flush");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => flushes[1]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const write = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0];
    expect(write).toMatchObject({
      workspaceId: "ws-1",
      relativePath: "shared-wysiwyg-flush.md",
      expectedContentHash: TEST_CONTENT_HASH,
    });
    expect(write.text).toContain("Hello");
    expect(write.text).toContain("Peer flush");
  });

  // The supported sequence, not simultaneous typing: one pane's autosave is in
  // flight, focus hands over, and the peer types. The peer's WYSIWYG edit is
  // LAZY, so the shared body still reads as the text the older write is
  // landing — and reporting that write as saved would strand the edit with no
  // timer and no dirty flag to bring it back.
  it("keeps a peer's lazy WYSIWYG edit alive when an older write lands", async () => {
    const path = "shared-wysiwyg-peer-write.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let finishWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(async () => {
      await held;
      return { status: "written", contentHash: "b".repeat(64) };
    });
    const user = userEvent.setup();
    render(
      <>
        <FileInspector workspaceId="ws-1" path={path} />
        <FileInspector workspaceId="ws-1" path={path} />
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await user.click(editors[0]!);
    await user.type(editors[0]!, "First");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    await user.click(editors[1]!);
    await user.type(editors[1]!, "Zz");
    // The peer's own debounce must not have fired yet, or the write below
    // proves nothing about the completing one.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishWrite();
      await held;
    });

    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText, "report the completed write as saved while a lazy peer draft is pending. The peer pane clears its timer and its unsaved flag, no second write ever issues, and closing that pane retires the edit unwritten.").toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]![0].text).toContain(
      "Zz",
    );
  });

  // The single-pane half of the same defect: no peer, no duplicate, just one
  // WYSIWYG editor typed into while its own autosave is on the wire. The
  // keystroke refills the lazy draft and re-arms the timer without publishing,
  // so the completing write must not report the document as saved.
  it("keeps a WYSIWYG keystroke typed during its own in-flight write", async () => {
    const path = "wysiwyg-inflight.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let finishWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(async () => {
      await held;
      return { status: "written", contentHash: "b".repeat(64) };
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path={path} />);
    const editor = await screen.findByTestId("markdown-editor");
    await user.click(editor);
    await user.type(editor, "First");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    await user.type(editor, "Zz");
    // The re-armed debounce must not have fired yet, or the write below could
    // be this keystroke's own rather than proof the state stayed dirty.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishWrite();
      await held;
    });

    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText, "report the completing write as saved while the lazy draft is live. The armed timer is cleared, the chip reads Saved, and the keystroke reaches neither disk nor recovery.").toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]![0].text).toContain(
      "Zz",
    );
  });

  it("keeps a pending peer WYSIWYG body when another pane changes a property", async () => {
    const path = "shared-wysiwyg-properties.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "---\ntitle: Plan\nstatus: draft\n---\n\n# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        {[0, 1].map((index) => (
          <FileInspector
            key={index}
            workspaceId="ws-1"
            path={path}
            registerDraftFlush={(flush) => {
              if (flush) flushes[index] = flush;
            }}
          />
        ))}
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    await user.click(editors[0]!);
    await user.type(editors[0]!, "Body A");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    const peerStatus = screen.getAllByLabelText(
      "Property status value",
    )[1] as HTMLInputElement;
    await act(async () => {
      fireEvent.change(peerStatus, { target: { value: "ready" } });
    });
    const shared = getSharedLocalDocument(
      documentVersionKey("ws-1", path, undefined),
    ).getSnapshot().body;
    expect(shared).toContain("status: ready");
    expect(shared).toContain("Body A");

    await act(async () => flushes[1]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("status: ready");
    expect(written).toContain("Body A");
  });

  it("hands a pending WYSIWYG body to a duplicate source editor before typing", async () => {
    const path = "shared-wysiwyg-source-handoff.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const toggles: Array<(() => void) | null> = [null, null];
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        {[0, 1].map((index) => (
          <FileInspector
            key={index}
            workspaceId="ws-1"
            path={path}
            registerSourceToggle={(toggle) => {
              toggles[index] = toggle;
            }}
            registerDraftFlush={(flush) => {
              if (flush) flushes[index] = flush;
            }}
          />
        ))}
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    await toggleSourceOnce(() => toggles[1]);
    const sourceEditor = screen
      .getAllByTestId("markdown-editor")
      .find((editor) => editor.classList.contains("dohc-code-editor"));
    expect(sourceEditor).toBeDefined();
    const sourceContent = await textEditorContent(sourceEditor!);

    await user.click(editors[0]!);
    await user.type(editors[0]!, "Body A");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await user.click(sourceContent);
    codeEditorView(sourceEditor!).dispatch({
      selection: { anchor: codeEditorText(sourceEditor!).length },
    });
    await user.keyboard("Source B");
    await act(async () => flushes[1]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("Body A");
    expect(written).toContain("Source B");
  });

  it("rebases an asynchronous image insert over a duplicate's pending body", async () => {
    const path = "shared-wysiwyg-image-handoff.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    type SettingsResult = {
      settings: typeof DEFAULT_WORKSPACE_SETTINGS;
      source: "default";
    };
    let resolveSettings!: (result: SettingsResult) => void;
    const settings = new Promise<SettingsResult>((resolve) => {
      resolveSettings = resolve;
    });
    bridgeMock.getWorkspaceSettings.mockImplementationOnce(() => settings);
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        {[0, 1].map((index) => (
          <FileInspector
            key={index}
            workspaceId="ws-1"
            path={path}
            registerDraftFlush={(flush) => {
              if (flush) flushes[index] = flush;
            }}
          />
        ))}
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    const image = new File([new Uint8Array([1, 2, 3])], "photo.png", {
      type: "image/png",
    });
    Object.defineProperty(image, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await user.click(editors[0]!);
    fireEvent.paste(editors[0]!, {
      clipboardData: {
        files: [image],
        getData: () => "",
        types: ["Files"],
      },
    });
    await waitFor(() =>
      expect(bridgeMock.getWorkspaceSettings).toHaveBeenCalledOnce(),
    );
    await user.click(editors[1]!);
    await user.type(editors[1]!, "Pane B");

    resolveSettings({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceAsset).toHaveBeenCalledOnce(),
    );
    await act(async () => flushes[0]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("Pane B");
    expect(written).toContain("assets/photo-");
  });

  it("rebases an asynchronous image insert over a duplicate source draft", async () => {
    const path = "shared-wysiwyg-image-source-handoff.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    type SettingsResult = {
      settings: typeof DEFAULT_WORKSPACE_SETTINGS;
      source: "default";
    };
    let resolveSettings!: (result: SettingsResult) => void;
    const settings = new Promise<SettingsResult>((resolve) => {
      resolveSettings = resolve;
    });
    bridgeMock.getWorkspaceSettings.mockImplementationOnce(() => settings);
    let resolveAsset!: () => void;
    const assetWrite = new Promise<void>((resolve) => {
      resolveAsset = resolve;
    });
    bridgeMock.writeWorkspaceAsset.mockImplementationOnce(() => assetWrite);
    const toggles: Array<(() => void) | null> = [null, null];
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        {[0, 1].map((index) => (
          <FileInspector
            key={index}
            workspaceId="ws-1"
            path={path}
            registerSourceToggle={(toggle) => {
              toggles[index] = toggle;
            }}
            registerDraftFlush={(flush) => {
              if (flush) flushes[index] = flush;
            }}
          />
        ))}
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    const image = new File([new Uint8Array([1, 2, 3])], "photo.png", {
      type: "image/png",
    });
    Object.defineProperty(image, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    await user.click(editors[0]!);
    fireEvent.paste(editors[0]!, {
      clipboardData: {
        files: [image],
        getData: () => "",
        types: ["Files"],
      },
    });
    await waitFor(() =>
      expect(bridgeMock.getWorkspaceSettings).toHaveBeenCalledOnce(),
    );

    resolveSettings({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceAsset).toHaveBeenCalledOnce(),
    );

    await toggleSourceOnce(() => toggles[1]);
    const sourceEditor = screen
      .getAllByTestId("markdown-editor")
      .find((editor) => editor.classList.contains("dohc-code-editor"));
    expect(sourceEditor).toBeDefined();
    await textEditorContent(sourceEditor!);
    replaceCodeEditorText(sourceEditor!, "# Hello\n\nSource B");
    resolveAsset();
    await act(async () => flushes[0]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("Source B");
    expect(written).toContain("assets/photo-");
  });

  it("keeps an empty pending WYSIWYG body when another pane changes a property", async () => {
    const path = "shared-wysiwyg-empty-properties.md";
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Restore me\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        {[0, 1].map((index) => (
          <FileInspector
            key={index}
            workspaceId="ws-1"
            path={path}
            registerDraftFlush={(flush) => {
              if (flush) flushes[index] = flush;
            }}
          />
        ))}
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    await user.click(editors[0]!);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(editors[0]!.textContent).toBe("");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await user.click(screen.getAllByTestId("property-add")[1]!);
    fireEvent.change(screen.getByLabelText("Property 1 name"), {
      target: { value: "status" },
    });
    fireEvent.change(screen.getAllByLabelText("Property status value")[1]!, {
      target: { value: "ready" },
    });
    await act(async () => flushes[1]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("status: ready");
    expect(written).not.toContain("Restore me");
  });

  it("routes the Markdown shortcut only to the active editor group", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    render(
      <>
        <FileInspector
          workspaceId="ws-1"
          path="shortcut-left.md"
          autoFocus={false}
        />
        <FileInspector
          workspaceId="ws-1"
          path="shortcut-right.md"
          autoFocus
        />
      </>,
    );
    const toggles = await waitFor(() => {
      const found = screen.getAllByTestId("markdown-edit-toggle");
      expect(found).toHaveLength(2);
      return found;
    });
    // Both documents must finish opening before the shortcut means anything: an
    // opening document is forced to read mode, so its toggle still offers
    // "Edit" and the keystroke is refused outright. The labels are the readable
    // signal that the phase closed — waiting for them is the precondition, and
    // the routing assertions below are unchanged.
    await waitFor(() =>
      expect(toggles.map((toggle) => toggle.textContent)).toEqual([
        "Source",
        "Source",
      ]),
    );

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });

    await waitFor(() =>
      expect(toggles.map((toggle) => toggle.textContent)).toEqual([
        "Source",
        "WYSIWYG",
      ]),
    );
  });

  it("settles one pane's pending WYSIWYG edit before another pane types", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    render(
      <>
        {[0, 1].map((index) => (
          <FileInspector
            key={index}
            workspaceId="ws-1"
            path="shared-wysiwyg-handoff.md"
            registerDraftFlush={(flush) => {
              if (flush) flushes[index] = flush;
            }}
          />
        ))}
      </>,
    );
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    await user.click(editors[0]!);
    await user.type(editors[0]!, "Pane A");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await user.click(editors[1]!);
    await waitFor(() => expect(editors[1]!.textContent).toContain("Pane A"));
    await user.type(editors[1]!, "Pane B");
    await act(async () => flushes[0]!());

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("Pane A");
    expect(written).toContain("Pane B");
  });

  it("keeps a pending WYSIWYG baseline when its duplicate rereads external content", async () => {
    const oldHash = "1".repeat(64);
    const externalHash = "2".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "# Before\n\n",
        truncated: false,
        contentHash: oldHash,
      })
      .mockResolvedValueOnce({
        text: "# Before\n\n",
        truncated: false,
        contentHash: oldHash,
      })
      .mockResolvedValueOnce({
        text: "# External\n\n",
        truncated: false,
        contentHash: externalHash,
      });
    bridgeMock.writeWorkspaceText.mockResolvedValueOnce({
      status: "conflict",
      currentContentHash: externalHash,
    });
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    const panes = (peerRefreshKey: number) => (
      <>
        <FileInspector
          key="writer"
          workspaceId="ws-1"
          path="shared-wysiwyg-reread.md"
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          key="reader"
          workspaceId="ws-1"
          path="shared-wysiwyg-reread.md"
          refreshKey={peerRefreshKey}
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>
    );
    const view = render(panes(0));
    const editors = await screen.findAllByTestId("markdown-editor");
    await waitFor(() => expect(flushes).toHaveLength(2));
    await user.type(editors[0]!, "Local");
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "shared-wysiwyg-reread.md", undefined),
    );
    expect(buffer.getPendingDraftSource()).not.toBeNull();

    view.rerender(panes(1));
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(buffer.getPendingDraftSource()).not.toBeNull();
    expect(buffer.getSnapshot()).toMatchObject({
      body: "# Before\n\n",
      contentHash: oldHash,
      dirty: false,
    });

    await expect(flushes[1]!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "shared-wysiwyg-reread.md",
      text: expect.stringContaining("Local"),
      expectedContentHash: oldHash,
    });
  });

  it("does not replay a duplicate Markdown draft after its peer saves the same body", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const toggles: Array<(() => void) | null> = [null, null];
    const flushes: DraftFlush[] = [];
    const user = userEvent.setup();
    const view = render(
      <>
        <FileInspector
          key="first"
          workspaceId="ws-1"
          path="shared.md"
          registerSourceToggle={(toggle) => {
            toggles[0] = toggle;
          }}
          registerDraftFlush={(flush) => {
            if (flush) flushes[0] = flush;
          }}
        />
        <FileInspector
          key="second"
          workspaceId="ws-1"
          path="shared.md"
          registerSourceToggle={(toggle) => {
            toggles[1] = toggle;
          }}
          registerDraftFlush={(flush) => {
            if (flush) flushes[1] = flush;
          }}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("view-markdown")).toHaveLength(2),
    );
    await toggleSourceOnce(() => toggles[0]);
    await toggleSourceOnce(() => toggles[1]);
    const editors = await Promise.all(
      screen.getAllByTestId("markdown-editor").map(async (editor) => {
        await textEditorContent(editor);
        return codeEditorTestHost(editor);
      }),
    );

    appendCodeEditorText(editors[0]!, "First");
    await waitFor(() => expect(editors[1]!.value).toContain("First"));
    appendCodeEditorText(editors[1]!, "Second");
    await waitFor(() => expect(editors[0]!.value).toContain("FirstSecond"));

    await act(async () => flushes[0]!());
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      relativePath: "shared.md",
      text: "# Hello\n\nFirstSecond",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("does not republish a stale Markdown pane over a newer peer draft", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let finishFirst!: () => void;
    const firstWrite = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        finishFirst = () =>
          resolve({ status: "written", contentHash: "b".repeat(64) });
      },
    );
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => firstWrite);
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "queued.md", undefined),
    );
    // Hold this pane's subscriber behind the queue interleaving. The write
    // seam must remain safe even before React applies a peer snapshot.
    buffer.subscribe = () => () => {};
    const publishDraft = vi.spyOn(buffer, "publishDraft");
    useAutoAdvancingFakeTimers();
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <FileInspector
          workspaceId="ws-1"
          path="queued.md"
        />,
      );
      await screen.findByTestId("view-markdown");
      await user.click(await findEnabledMarkdownEditToggle());
      const editor = screen.getByTestId("markdown-editor");

      appendCodeEditorText(editor, "First");
      await advanceAutosaveDebounce();
      await waitFor(() =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      );
      appendCodeEditorText(editor, "Queued");
      // The second debounce expires behind the held first write; the queued
      // write must not reach the bridge yet.
      await advanceAutosaveDebounce();
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

      let publishesBeforeRelease = 0;
      const peerSource = {};
      await act(async () => {
        buffer.publishDraft("# Peer newest\n", peerSource);
        publishesBeforeRelease = publishDraft.mock.calls.length;
        finishFirst();
        await firstWrite;
      });
      await waitFor(() =>
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      );
      expect(publishDraft).toHaveBeenCalledTimes(publishesBeforeRelease);

      expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toMatchObject({
        text: "# Peer newest\n",
        expectedContentHash: "b".repeat(64),
      });
      expect(buffer.getSnapshot().body).toBe("# Peer newest\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "plain text", path: "queued-unmount.txt", markdown: false },
    { label: "Markdown", path: "queued-unmount.md", markdown: true },
  ])(
    "does not republish a stale $label unmount snapshot over a newer peer draft",
    async ({ path, markdown }) => {
      const initial = markdown ? "# Hello\n\n" : "Hello";
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: initial,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
      let resolveFirstWrite!: (value: {
        status: "written";
        contentHash: string;
      }) => void;
      const firstWrite = new Promise<{
        status: "written";
        contentHash: string;
      }>((resolve) => {
        resolveFirstWrite = resolve;
      });
      bridgeMock.writeWorkspaceText.mockImplementationOnce(
        () => firstWrite,
      );
      const buffer = getSharedLocalDocument(
        documentVersionKey("ws-1", path, undefined),
      );
      useAutoAdvancingFakeTimers();
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const view = render(
          <FileInspector workspaceId="ws-1" path={path} />,
        );
        if (markdown) {
          await screen.findByTestId("view-markdown");
          await user.click(await findEnabledMarkdownEditToggle());
        }
        const surface = markdown
          ? screen.getByTestId("markdown-editor")
          : (await screen.findByTestId("view-text-editor")).querySelector(
              ".cm-content",
            )!;

        if (markdown) {
          appendCodeEditorText(surface as HTMLElement, " first");
        } else {
          await user.click(surface);
          await user.keyboard("{End} first");
        }
        await advanceAutosaveDebounce();
        await waitFor(() =>
          expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
        );

        if (markdown) {
          appendCodeEditorText(surface as HTMLElement, " queued");
        } else {
          await user.keyboard("{End} queued");
        }
        // Discriminating assertion: auto-advance could in principle have
        // already expired the second debounce and enqueued a normal
        // autosave writer, which would satisfy the assertions below for the
        // wrong reason (a timer-driven write, not the unmount flush this
        // test pins). Assert it hasn't: this fails loudly instead of
        // passing through that path.
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
        view.unmount();

        const peerBody = markdown ? "# Peer newest\n" : "Peer newest";
        const peerSource = {};
        buffer.publishDraft(peerBody, peerSource);
        resolveFirstWrite({ status: "written", contentHash: "b".repeat(64) });
        await firstWrite;

        await waitFor(() =>
          expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
        );
        expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toMatchObject({
          text: peerBody,
          expectedContentHash: "b".repeat(64),
        });
        expect(buffer.getSnapshot()).toMatchObject({
          body: peerBody,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("retains a peer-owned Markdown draft after an older pane save succeeds", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Hello\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let finishWrite!: () => void;
    const pending = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        finishWrite = () =>
          resolve({ status: "written", contentHash: "b".repeat(64) });
      },
    );
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => pending);
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="peer-owned.md" />);
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      "Writer",
    );
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "peer-owned.md", undefined),
    );
    const peerSource = {};

    await act(async () => {
      buffer.publishDraft("# Peer newest\n", peerSource);
      finishWrite();
      await pending;
    });

    expect(buffer.getSnapshot()).toMatchObject({
      body: "# Peer newest\n",
      contentHash: "b".repeat(64),
      dirty: true,
      saveState: "saving",
    });
    expect(buffer.getSnapshot().source).toBe(peerSource);
  });

  it.each([
    ["plain text", "notes/no-baseline.txt", "view-text-editor"],
    ["Markdown", "no-baseline.md", "view-markdown"],
  ])(
    "rejects a %s flush when the shared draft has no content hash",
    async (_label, path, viewTestId) => {
      const buffer = getSharedLocalDocument(
        documentVersionKey("ws-1", path, undefined),
      );
      buffer.publishDraft("unsaved", {});
      let flush: DraftFlush | null = null;
      render(
        <FileInspector
          workspaceId="ws-1"
          path={path}
          registerDraftFlush={(next) => {
            flush = next;
          }}
        />,
      );
      await screen.findByTestId(viewTestId);
      await waitFor(() => expect(flush).not.toBeNull());

      await expect(flush!({ captureOnFailure: true })).rejects.toThrow(
        "dohc cannot save this draft without a content hash.",
      );
      expect(buffer.getSnapshot()).toMatchObject({
        body: "unsaved",
        contentHash: null,
        dirty: true,
      });
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    },
  );

  it("does not expose a retained same-path body or hash after switching workspaces", async () => {
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({
          text: "Workspace B",
          truncated: false,
          contentHash: secondHash,
        });
    });
    bridgeMock.readWorkspaceText.mockImplementation((payload) =>
      payload.workspaceId === "ws-1"
        ? Promise.resolve({
            text: "Workspace A",
            truncated: false,
            contentHash: firstHash,
          })
        : heldSecondRead,
    );
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    await waitFor(
      () => {
        const content = screen
          .getByTestId("view-text-editor")
          .querySelector(".cm-content");
        expect(content).toBeInstanceOf(HTMLElement);
        expect(content!.textContent).toContain("Workspace A");
      },
      { timeout: 10_000 },
    );

    view.rerender(
      <FileInspector workspaceId="ws-2" path="notes/plain.txt" />,
    );
    expect(screen.queryByTestId("view-text-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    const content = await waitFor(
      () => {
        const next = screen
          .getByTestId("view-text-editor")
          .querySelector(".cm-content");
        expect(next).toBeInstanceOf(HTMLElement);
        expect(next!.textContent).toContain("Workspace B");
        return next as HTMLElement;
      },
      { timeout: 10_000 },
    );
    await user.click(content);
    await user.keyboard("{End} edit");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-2",
      relativePath: "notes/plain.txt",
      text: "Workspace B edit",
      expectedContentHash: secondHash,
    });
  }, 30_000);

  it("serializes overlapping plain-text autosaves and writes the newest draft last", async () => {
    useAutoAdvancingFakeTimers();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
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
    let writes = 0;
    bridgeMock.writeWorkspaceText.mockImplementation(() => {
      writes += 1;
      return writes === 1 ? heldFirst : heldSecond;
    });
    const user = userEvent.setup({ delay: 5, advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("One");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    await user.keyboard("Two");
    await waitFor(() => expect(content.textContent).toContain("OneTwo"));
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]).toEqual([
      {
        workspaceId: "ws-1",
        relativePath: "notes/plain.txt",
        text: "OneTwo",
        expectedContentHash: TEST_CONTENT_HASH,
      },
    ]);
    expect(content.textContent).toContain("OneTwo");
    await act(async () => {
      releaseSecond();
      await heldSecond;
    });
    view.unmount();
  });

  it("sets aside the newest plain-text draft when the file changes during its write", async () => {
    useAutoAdvancingFakeTimers();
    const initialHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    const freshHash = "6".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "External",
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
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldConflict)
      .mockResolvedValue({ status: "written", contentHash: freshHash });
    let flush: (() => Promise<void>) | null = null;
    const registerFlush = (next: (() => Promise<void>) | null) => {
      flush = next;
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={1}
        registerDraftFlush={registerFlush}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} One");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "Base One",
      expectedContentHash: initialHash,
    });

    await user.keyboard(" Two");
    expect(content.textContent).toContain("Base One Two");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={2}
        registerDraftFlush={registerFlush}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(content.textContent).toContain("Base One Two");

    await waitFor(() => expect(flush).not.toBeNull());
    const flushPromise = flush!();
    const flushResult = flushPromise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(await flushResult).toBe("rejected");
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(content.textContent).toBe("External"));
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base One Two"),
    );
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).toBe("error");

    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await user.click(content);
    await user.keyboard("{End} Fresh");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "External Fresh",
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
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).toBe("saved");
    view.unmount();
  });

  it("settles both duplicate text panes after conflict recovery is dismissed", async () => {
    const path = "notes/shared-conflict.txt";
    const initialHash = "4".repeat(64);
    const externalHash = "5".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "External",
        truncated: false,
        contentHash: externalHash,
      });
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: externalHash,
    });
    const user = userEvent.setup();
    const view = render(
      <>
        <FileInspector workspaceId="ws-1" path={path} />
        <FileInspector workspaceId="ws-1" path={path} />
      </>,
    );
    const editors = await screen.findAllByTestId("view-text-editor");
    const first = await textEditorContent(editors[0]!);
    await user.click(first);
    await user.keyboard("{End} Local");

    await screen.findAllByTestId(
      "orphaned-draft-notice",
      {},
      { timeout: 5_000 },
    );
    await waitFor(() =>
      expect(
        editors.every((editor) => editor.textContent?.includes("External")),
      ).toBe(true),
    );
    expect(
      screen
        .getAllByTestId("view-text-save-state")
        .map((state) => state.getAttribute("data-state")),
    ).toEqual(["error", "saved"]);

    await user.click(screen.getAllByTestId("recovery-dismiss")[0]!);
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("view-text-save-state")
          .map((state) => state.getAttribute("data-state")),
      ).toEqual(["saved", "saved"]),
    );
    expect(
      getSharedLocalDocument(
        documentVersionKey("ws-1", path, undefined),
      ).getSnapshot(),
    ).toMatchObject({
      body: "External",
      contentHash: externalHash,
      dirty: false,
      saveState: "saved",
    });
    view.unmount();
  });

  it("rereads plain text after a write overlaps a newer content request", async () => {
    const initialHash = "7".repeat(64);
    const localHash = "8".repeat(64);
    const externalHash = "9".repeat(64);
    let resolveSecondRead!: () => void;
    const heldSecondRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveSecondRead = () =>
        resolve({ text: "External", truncated: false, contentHash: externalHash });
    });
    let resolveThirdRead!: () => void;
    const heldThirdRead = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveThirdRead = () =>
        resolve({ text: "External", truncated: false, contentHash: externalHash });
    });
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
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
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={1}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} Local");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        refreshKey={2}
      />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    expect(content.textContent).toBe("Base Local");

    await act(async () => {
      resolveWrite();
      await heldWrite;
    });
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(3),
    );
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).not.toBe("saved");
    expect(content.textContent).toBe("Base Local");

    await act(async () => {
      resolveThirdRead();
      await heldThirdRead;
    });
    await waitFor(() => expect(content.textContent).toBe("External"));
    expect(
      screen.getByTestId("view-text-save-state").getAttribute("data-state"),
    ).toBe("saved");
    view.unmount();
  });

  it("captures the same plain-text conflict again after its first recovery is dismissed", async () => {
    const initialHash = "c".repeat(64);
    const externalHash = "d".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "Base",
        truncated: false,
        contentHash: externalHash,
      });
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: externalHash,
    });
    let flush: DraftFlush | null = null;
    const user = userEvent.setup();
    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = await findTextEditorContent();
    await waitFor(() => expect(flush).not.toBeNull());

    await user.click(content);
    await user.keyboard("{End} Draft");
    await waitFor(() =>
      expect(
        screen.getByTestId("view-text-save-state").getAttribute("data-state"),
      ).toBe("saving"),
    );
    await expect(flush!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull(),
    );
    await waitFor(() => expect(content.textContent).toBe("Base"));

    await user.click(content);
    await user.keyboard("{End} Draft");
    await waitFor(() =>
      expect(
        screen.getByTestId("view-text-save-state").getAttribute("data-state"),
      ).toBe("saving"),
    );
    await expect(flush!()).rejects.toThrow(
      "The file changed on disk while dohc saved it.",
    );
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base Draft"),
    );
  });

  it("recovers a queued plain-text unmount draft when its I/O write rejects", async () => {
    const initialHash = "e".repeat(64);
    const firstHash = "f".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "Base One",
        truncated: false,
        contentHash: firstHash,
      });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockRejectedValueOnce(new Error("disk unavailable"));
    let flush: DraftFlush | null = null;
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} One");
    await waitFor(() => expect(flush).not.toBeNull());
    const firstFlush = flush!().catch(() => undefined);
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    await user.keyboard(" Two");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await heldFirst;
      await firstFlush;
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base One Two"),
    );
  });

  it("recovers an in-flight plain-text autosave that rejects after unmount", async () => {
    const initialHash = "3".repeat(64);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "Base",
      truncated: false,
      contentHash: initialHash,
    });
    let rejectWrite!: (error: Error) => void;
    const heldWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldWrite);
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} Draft");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    view.unmount();

    await act(async () => {
      rejectWrite(new Error("disk unavailable"));
      await heldWrite.catch(() => undefined);
    });
    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base Draft"),
    );
  });

  it.each([
    { retry: "succeeds", retryFails: false, expectedRecoveries: 0 },
    { retry: "fails", retryFails: true, expectedRecoveries: 1 },
  ])(
    "lets an operation-owned plain-text retry settle before recovery when it $retry",
    async ({ retryFails, expectedRecoveries }) => {
      const initialHash = "3".repeat(64);
      const retryHash = "4".repeat(64);
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      });
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
        resolveRetry = () => resolve({ status: "written", contentHash: retryHash });
        rejectRetry = reject;
      });
      let writes = 0;
      bridgeMock.writeWorkspaceText.mockImplementation(() => {
        writes += 1;
        return writes === 1 ? issuedWrite : retryWrite;
      });
      let flush: DraftFlush | null = null;
      const recoverySpy = vi.spyOn(
        orphanedDraftsModule,
        "captureOrphanedDraft",
      );
      try {
        const user = userEvent.setup();
        const view = render(
          <FileInspector
            workspaceId="ws-1"
            path="notes/plain.txt"
            registerDraftFlush={(next) => {
              flush = next;
            }}
          />,
        );
        const content = await findTextEditorContent();
        await user.click(content);
        await user.keyboard("{End} Draft");
        await waitFor(
          () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
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
          expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
        );
        expect(recoverySpy, "recovery ownership: if the unmount observer captures before the operation retry settles, success is spurious and failure creates two recoveries.").not.toHaveBeenCalled();

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

  it("keeps a plain-text unmount conflict recoverable without another write", async () => {
    const initialHash = "7".repeat(64);
    const externalHash = "8".repeat(64);
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Base",
        truncated: false,
        contentHash: initialHash,
      })
      .mockResolvedValue({
        text: "External",
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
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldConflict);
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} Draft");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "Base Draft",
      expectedContentHash: initialHash,
    });

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base Draft"),
    );
    const recovered = await findTextEditorContent();
    await waitFor(() => expect(recovered.textContent).toBe("External"));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale path read from pairing its body with the next file's hash", async () => {
    const firstHash = "9".repeat(64);
    const secondHash = "b".repeat(64);
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveFirst = () =>
        resolve({ text: "First", truncated: false, contentHash: firstHash });
    });
    bridgeMock.readWorkspaceText.mockImplementation(({ relativePath }) =>
      relativePath === "notes/first.txt"
        ? heldFirst
        : Promise.resolve({
            text: "Second",
            truncated: false as const,
            contentHash: secondHash,
          }),
    );
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/first.txt" />,
    );
    await waitFor(() =>
      expect(bridgeMock.readWorkspaceText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        relativePath: "notes/first.txt",
      }),
    );
    view.rerender(
      <FileInspector workspaceId="ws-1" path="notes/second.txt" />,
    );
    const content = await findTextEditorContent();
    await waitFor(() => expect(content.textContent).toBe("Second"));

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    expect(content.textContent).toBe("Second");
    await user.click(content);
    await user.keyboard("{End} edit");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/second.txt",
      text: "Second edit",
      expectedContentHash: secondHash,
    });
  });

  it("holds a plain-text shell flush until the in-flight autosave lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      bridgeMock.readWorkspaceText.mockResolvedValueOnce({
        text: "",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
      let releaseWrite!: () => void;
      const heldWrite = new Promise<{
        status: "written";
        contentHash: string;
      }>((resolve) => {
        releaseWrite = () =>
          resolve({
            status: "written" as const,
            contentHash: TEST_CONTENT_HASH,
          });
      });
      bridgeMock.writeWorkspaceText.mockImplementation(() => heldWrite);
      let flush: (() => Promise<void>) | null = null;
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = render(
        <FileInspector
          workspaceId="ws-1"
          path="notes/plain.txt"
          registerDraftFlush={(next) => {
            flush = next;
          }}
        />,
      );
      const content = await findTextEditorContent();
      await user.click(content);
      await user.keyboard("Draft");
      await act(async () => vi.advanceTimersByTimeAsync(800));
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(flush).not.toBeNull());

      let flushSettled = false;
      const flushPromise = flush!().then(() => {
        flushSettled = true;
      });
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(flushSettled).toBe(false);

      await act(async () => {
        releaseWrite();
        await heldWrite;
        await flushPromise;
      });
      expect(flushSettled).toBe(true);
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rearms autosave when a debounce expires behind a shell flush", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
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
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    let flush: (() => Promise<void>) | null = null;
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = await findTextEditorContent();

    useAutoAdvancingFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());
    // Discriminating assertion: auto-advance could in principle expire the
    // debounce during the typing above and let a normal autosave — not the
    // flush below — produce the held first write. Assert it hasn't: this
    // fails loudly instead of letting an autosave satisfy the assertions
    // below for the wrong reason.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(0);

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));
    await user.keyboard("Two");
    // The second keystroke's debounce is armed behind the still-held first
    // write; firing it must not let the queued text reach the bridge yet.
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
    // The second write is already observed above, so the flush it belongs to
    // cannot have settled yet — no advance needed to know that.
    expect(flushSettled).toBe(false);
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]).toEqual([
      {
        workspaceId: "ws-1",
        relativePath: "notes/plain.txt",
        text: "OneTwo",
        expectedContentHash: TEST_CONTENT_HASH,
      },
    ]);
    await act(async () => {
      releaseSecond();
      await heldSecond;
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    view.unmount();
  });

  it("drains a flush-time edit before its debounce expires", async () => {
    useAutoAdvancingFakeTimers();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
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
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond);
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    let flushSettled = false;
    const flushPromise = flush!().then(() => {
      flushSettled = true;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await user.keyboard("Two");
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    expect(flushSettled).toBe(false);
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "OneTwo",
      expectedContentHash: TEST_CONTENT_HASH,
    });

    await act(async () => {
      releaseSecond();
      await heldSecond;
      await flushPromise;
    });
    expect(flushSettled).toBe(true);
    view.unmount();
  });

  it("shares concurrent flushes through edits made during deferred writes", async () => {
    useAutoAdvancingFakeTimers();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
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
    let releaseThird!: () => void;
    const heldThird = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseThird = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldSecond)
      .mockImplementationOnce(() => heldThird);
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    let firstSettled = false;
    let secondSettled = false;
    const firstFlush = flush!();
    const secondFlush = flush!();
    const sharedPromise = firstFlush === secondFlush;
    void firstFlush.then(() => {
      firstSettled = true;
    });
    void secondFlush.then(() => {
      secondSettled = true;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    await user.keyboard("Two");
    await advanceAutosaveDebounce();
    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const secondSettledEarly = secondSettled;

    await user.keyboard("Three");
    await advanceAutosaveDebounce();
    await act(async () => {
      releaseSecond();
      await heldSecond;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(3), {
      timeout: 5_000,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const settledBeforeDrain = firstSettled || secondSettled;
    expect(bridgeMock.writeWorkspaceText.mock.calls[2]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "OneTwoThree",
      expectedContentHash: TEST_CONTENT_HASH,
    });

    await act(async () => {
      releaseThird();
      await heldThird;
      await Promise.all([firstFlush, secondFlush]);
    });
    expect(sharedPromise).toBe(true);
    expect(secondSettledEarly).toBe(false);
    expect(settledBeforeDrain).toBe(false);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    view.unmount();
  });

  it("rejects a flush when its deferred write fails and keeps the draft retryable", async () => {
    useAutoAdvancingFakeTimers();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockRejectedValueOnce(new Error("deferred write failed"))
      .mockResolvedValue({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
    let flush: (() => Promise<void>) | null = null;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        registerDraftFlush={(next) => {
          flush = next;
        }}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("One");
    await waitFor(() => expect(flush).not.toBeNull());

    const firstFlush = flush!();
    const secondFlush = flush!();
    const sharedPromise = firstFlush === secondFlush;
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    await user.keyboard("Two");
    await advanceAutosaveDebounce();
    releaseFirst();

    const failedFlushes = await Promise.allSettled([firstFlush, secondFlush]);
    expect(sharedPromise).toBe(true);
    expect(failedFlushes).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    expect(
      failedFlushes.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          result.reason.message === "deferred write failed",
      ),
    ).toBe(true);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
    await expect(flush!()).resolves.toBeUndefined();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(3);
    expect(bridgeMock.writeWorkspaceText.mock.calls[2]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "OneTwo",
      expectedContentHash: TEST_CONTENT_HASH,
    });
    view.unmount();
  });

  it("applies a refreshed plain-text body to CodeMirror", async () => {
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "before",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      })
      .mockResolvedValueOnce({
        text: "after external edit",
        truncated: false,
        contentHash: "e".repeat(64),
      });
    const view = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" refreshKey={1} />,
    );
    const content = await findTextEditorContent();
    await waitFor(() => expect(content.textContent).toBe("before"));

    view.rerender(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" refreshKey={2} />,
    );

    await waitFor(() => expect(content.textContent).toBe("after external edit"));
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("lets Ctrl+Z undo a pending history revert in CodeMirror text files", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "before\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const onPendingUndoConsumed = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        pendingUndo={{
          token: 7,
          path: "notes/plain.txt",
          restoredText: "before\n",
          undoText: "after\n",
        }}
        onPendingUndoConsumed={onPendingUndoConsumed}
      />,
    );

    await screen.findByTestId("view-text-editor");
    await waitFor(() => expect(onPendingUndoConsumed).toHaveBeenCalledWith(7));
    await user.keyboard("{Control>}z{/Control}");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "after\n",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("edits CSV cells and saves the table file", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="data/table.csv" />);

    await screen.findByTestId("view-csv");
    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "43");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "data/table.csv",
      text: "date,amount\n2026-06-10,43",
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("does not parse a CSV keystroke in raw mode", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="data/table.csv" />);

    await screen.findByTestId("view-csv");
    await user.click(screen.getByTestId("csv-raw-toggle"));
    const parse = vi.spyOn(delimitedTextCodec, "parse");
    try {
      fireEvent.change(screen.getByTestId("csv-raw-editor"), {
        target: { value: "date,amount\n2026-06-10,420" },
      });

      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("serializes one table-cell edit once without reparsing its output", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    render(<FileInspector workspaceId="ws-1" path="data/table.csv" />);

    await screen.findByTestId("view-csv");
    const parse = vi.spyOn(delimitedTextCodec, "parse");
    const serialize = vi.spyOn(delimitedTextCodec, "serialize");
    try {
      const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
      fireEvent.change(cells[3]!, { target: { value: "43" } });
      await act(async () => Promise.resolve());

      expect(serialize).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      serialize.mockRestore();
    }
  });

  it("round-trips quoted CSV cells through the existing codec", () => {
    const text = [
      "name,note,quote",
      'Ada,"one,two","She said ""hi"""',
      'Grace,"line one\nline two",plain',
    ].join("\n");
    const rows = [
      ["name", "note", "quote"],
      ["Ada", "one,two", 'She said "hi"'],
      ["Grace", "line one\nline two", "plain"],
    ];

    expect(delimitedTextCodec.parse(text, ",")).toEqual(rows);
    expect(delimitedTextCodec.serialize(rows, ",")).toBe(text);
    expect(
      delimitedTextCodec.parse(delimitedTextCodec.serialize(rows, ","), ","),
    ).toEqual(rows);
  });

  it("preserves CSV content while switching between raw and table modes", async () => {
    const initial = 'name,note\nAda,"one,two"';
    const edited = 'name,note\nGrace,"line one\nline two"';
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: initial,
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="data/table.csv" />);

    await screen.findByTestId("view-csv");
    await user.click(screen.getByTestId("csv-raw-toggle"));
    const rawEditor = screen.getByTestId("csv-raw-editor") as HTMLTextAreaElement;
    expect(rawEditor.value).toBe(initial);
    fireEvent.change(rawEditor, { target: { value: edited } });

    await user.click(screen.getByTestId("csv-raw-toggle"));
    expect(
      (screen.getByLabelText("Row 1 column 1") as HTMLInputElement).value,
    ).toBe("Grace");
    await user.click(screen.getByTestId("csv-raw-toggle"));
    expect((screen.getByTestId("csv-raw-editor") as HTMLTextAreaElement).value).toBe(
      edited,
    );
  });

  // #579 adversarial review F1: the opening gate lived inside MarkdownView, so
  // every NON-markdown editable view carried the exact mechanism unfixed —
  // three write seams, none of them gated, reached by the same version switch.
  // A pending .csv edit plus a version bump landed pre-switch text on the
  // post-switch tree, with no capture, no notice and no recovery entry.
  it("sets a pending CSV edit aside on a version switch instead of writing it", async () => {
    useAutoAdvancingFakeTimers();
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "date,amount\n2026-06-10,42",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );

    await screen.findByTestId("view-csv");
    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "43");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    // The version switch: same mount, same pending draft, same armed timer.
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    // Cancelled is not dropped: the edit is recoverable, on the same surface
    // markdown drafts use.
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "date,amount\n2026-06-10,43",
      ),
    );

    // ...and unmounting mid-switch does not write it either.
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  // ...and the window stays honest while the reread is still in flight. Typing
  // here is not swallowed — swallowing it would lose the keystroke silently
  // when the reread lands and repaints — so it arms as normal, the write seams
  // refuse it, and the capture takes it when the refusal lifts.
  it("refuses a CSV write typed while the switch reread is in flight, and sets it aside", async () => {
    useAutoAdvancingFakeTimers();
    let releaseReread!: (
      value: Awaited<ReturnType<DohcDesktopBridge["readWorkspaceText"]>>,
    ) => void;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseReread = resolve;
        }),
      );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    await screen.findByTestId("view-csv");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );

    // The reread is held, so the body on screen still belongs to the version
    // the user just left.
    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "99");
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText, "window guard: drop `writesBlocked()` from writeDraftNow. The armed timer lands '99' — built on the pre-switch body — on the tree the switch just bound.").not.toHaveBeenCalled();

    await act(async () => {
      releaseReread({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
      await Promise.resolve();
    });
    const notices = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(notices[notices.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "date,amount\n2026-06-10,99",
      ),
    );
  });

  // ...and the error path is the half that ordering cannot save. A reread that
  // rejects selects the error branch in the same commit that lifts the
  // refusal, so the view is unmounted before it can render again and act on
  // the lift. The draft has to be taken on the way out.
  it("sets a CSV draft aside when the switch reread fails and the view is torn down", async () => {
    let rejectReread!: (reason: Error) => void;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "date,amount\n2026-06-10,42",
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      })
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectReread = reject;
        }),
      );
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    await screen.findByTestId("view-csv");
    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="data/table.csv"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );

    const cells = screen.getAllByTestId("csv-cell") as HTMLInputElement[];
    await user.clear(cells[3]!);
    await user.type(cells[3]!, "77");

    // The reread fails: `setText(null)` selects the error branch and this view
    // goes away in the same commit.
    await act(async () => {
      rejectReread(new Error("reread failed"));
      await Promise.resolve();
    });
    expect(bridgeMock.writeWorkspaceText, "F3: restore the early `return` when writes are blocked, so the cleanup drops the draft instead of setting it aside. The user's text vanishes with no notice and no recovery entry.").not.toHaveBeenCalled();

    const copies = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(copies[copies.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "date,amount\n2026-06-10,77",
      ),
    );
  });

  it("retires a captured plain-text switch draft so the automatic retry and remount can land", async () => {
    const firstBody = "Old version";
    const thirdBody = "New version";
    let rejectReread!: (reason: Error) => void;
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
      if (reads === 2) {
        return await new Promise<never>((_resolve, reject) => {
          rejectReread = reject;
        });
      }
      return {
        text: thirdBody,
        truncated: false,
        contentHash: "b".repeat(64),
      };
    });
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    let editor = await screen.findByTestId("view-text-editor");
    const content = await textEditorContent(editor);
    await user.click(content);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await user.keyboard("{End} captured");

    await act(async () => {
      rejectReread(new Error("reread failed"));
      await Promise.resolve();
    });

    await waitFor(() => expect(reads).toBe(3));
    editor = await screen.findByTestId("view-text-editor");
    await waitFor(() => expect(editor.textContent).toContain(thirdBody));
    expect(editor.textContent).not.toContain("captured");
    expect(screen.getByTestId("orphaned-draft-notice")).toBeTruthy();
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(`${firstBody} captured`),
    );

    view.unmount();
    const remount = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={3}
      />,
    );
    editor = await screen.findByTestId("view-text-editor");
    await waitFor(() => expect(editor.textContent).toContain(thirdBody));
    expect(editor.textContent).not.toContain("captured");
    remount.unmount();
  });

  it("releases the captured plain-text version buffer after a failed switch reread", async () => {
    let rejectReread!: (reason: Error) => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        return {
          text: "Old version",
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }
      return await new Promise<never>((_resolve, reject) => {
        rejectReread = reject;
      });
    });
    const oldKey = documentVersionKey("ws-1", "notes/plain.txt", 1);
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    const editor = await screen.findByTestId("view-text-editor");
    const content = await textEditorContent(editor);
    await user.click(content);
    await user.keyboard("{End} captured");
    const oldBuffer = getSharedLocalDocument(oldKey);
    expect(oldBuffer.getSnapshot().dirty).toBe(true);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => {
      rejectReread(new Error("reread failed"));
      await Promise.resolve();
    });
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Old version captured"),
    );
    view.unmount();

    const reacquired = getSharedLocalDocument(oldKey);
    expect(reacquired).not.toBe(oldBuffer);
    expect(reacquired.getSnapshot()).toMatchObject({
      initialized: false,
      dirty: false,
    });
  });

  it("releases the captured Markdown version buffer after capturing a pending draft", async () => {
    let rejectReread!: (reason: Error) => void;
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) {
        return {
          text: "# Old version\n",
          truncated: false,
          contentHash: TEST_CONTENT_HASH,
        };
      }
      return await new Promise<never>((_resolve, reject) => {
        rejectReread = reject;
      });
    });
    const oldKey = documentVersionKey("ws-1", "notes/versioned.md", 1);
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    await typeInMarkdownEditor(
      user,
      await screen.findByTestId("markdown-editor"),
      " captured",
    );
    const oldBuffer = getSharedLocalDocument(oldKey);
    expect(oldBuffer.getPendingDraftSource()).not.toBeNull();

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => {
      rejectReread(new Error("reread failed"));
      await Promise.resolve();
    });
    await screen.findByTestId("orphaned-draft-notice");
    await user.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain("captured"),
    );
    view.unmount();

    const reacquired = getSharedLocalDocument(oldKey);
    expect(reacquired).not.toBe(oldBuffer);
    expect(reacquired.getSnapshot()).toMatchObject({
      initialized: false,
      dirty: false,
    });
  });

  it("does not consume a v2 plain-text draft when a v1 writer settles", async () => {
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { text: "Version one", truncated: false, contentHash: firstHash }
        : { text: "Version two", truncated: false, contentHash: secondHash };
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockResolvedValue({ status: "written", contentHash: secondHash });
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    const firstContent = await findTextEditorContent();
    await user.click(firstContent);
    await user.keyboard("{End} v1");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    const secondBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/plain.txt", 2),
    );
    await waitFor(() =>
      expect(secondBuffer.getSnapshot()).toMatchObject({
        initialized: true,
        contentHash: secondHash,
      }),
    );
    const secondEditor = screen.getByTestId("view-text-editor");
    const secondContent = await textEditorContent(secondEditor);
    await user.click(secondContent);
    await user.keyboard("{Control>}a{/Control}Version two v2");

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toBe(
      "Version two v2",
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    view.unmount();
  });

  it("retires an in-flight plain-text conflict after a real unmount", async () => {
    const initialHash = "3".repeat(64);
    const externalHash = "4".repeat(64);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "Base",
      truncated: false,
      contentHash: initialHash,
    });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldConflict);
    const key = documentVersionKey("ws-1", "notes/plain.txt", 1);
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} Draft");
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    const oldBuffer = getSharedLocalDocument(key);
    view.unmount();

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    await waitFor(() =>
      expect(getSharedLocalDocument(key)).not.toBe(oldBuffer),
    );
  });

  it("does not consume a v2 Markdown draft when a v1 writer settles", async () => {
    const firstHash = "5".repeat(64);
    const secondHash = "6".repeat(64);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { text: "# Version one\n", truncated: false, contentHash: firstHash }
        : { text: "# Version two\n", truncated: false, contentHash: secondHash };
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockResolvedValue({ status: "written", contentHash: secondHash });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    fireEvent.click(await findEnabledMarkdownEditToggle());
    const firstSource = await findSourceEditor();
    replaceCodeEditorText(firstSource, `${firstSource.value}v1`);
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(async () =>
      expect((await findSourceEditor()).value).toContain("Version two"),
    );
    const secondSource = await findSourceEditor();
    replaceCodeEditorText(secondSource, `${secondSource.value}v2`);

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toContain(
      "Version two\nv2",
    );
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    view.unmount();
  });

  it("retires an in-flight Markdown conflict after a real unmount", async () => {
    const initialHash = "7".repeat(64);
    const externalHash = "8".repeat(64);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Base\n",
      truncated: false,
      contentHash: initialHash,
    });
    let resolveConflict!: () => void;
    const heldConflict = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveConflict = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText.mockImplementationOnce(() => heldConflict);
    const key = documentVersionKey("ws-1", "notes/versioned.md", 1);
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={1}
      />,
    );
    fireEvent.click(await findEnabledMarkdownEditToggle());
    const source = await findSourceEditor();

    useAutoAdvancingFakeTimers();
    replaceCodeEditorText(source, `${source.value}Draft`);
    await advanceAutosaveDebounce();
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    const oldBuffer = getSharedLocalDocument(key);
    view.unmount();

    await act(async () => {
      resolveConflict();
      await heldConflict;
    });
    await waitFor(() =>
      expect(getSharedLocalDocument(key)).not.toBe(oldBuffer),
    );
  });

  it("does not capture the v2 plain-text draft when v1 settles after the view closes", async () => {
    const firstHash = "9".repeat(64);
    const secondHash = "a".repeat(64);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { text: "Version one", truncated: false, contentHash: firstHash }
        : { text: "Version two", truncated: false, contentHash: secondHash };
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockResolvedValue({ status: "written", contentHash: secondHash });
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    const firstContent = await findTextEditorContent();
    await user.click(firstContent);
    await user.keyboard("{End} v1");
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    const secondBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/plain.txt", 2),
    );
    await waitFor(() =>
      expect(secondBuffer.getSnapshot()).toMatchObject({
        initialized: true,
        contentHash: secondHash,
      }),
    );
    const secondContent = await findTextEditorContent();
    await user.click(secondContent);
    await user.keyboard("{Control>}a{/Control}Version two v2");
    await waitFor(() =>
      expect(secondBuffer.getSnapshot()).toMatchObject({
        body: "Version two v2",
        dirty: true,
      }),
    );
    view.unmount();

    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={3}
      />,
    );

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toBe(
      "Version two v2",
    );
  });

  it("does not let a queued v1 plain-text writer lift the v2 switch refusal", async () => {
    useAutoAdvancingFakeTimers();
    const firstHash = "b".repeat(64);
    const secondHash = "c".repeat(64);
    let resolveReread!: (value: {
      text: string;
      truncated: false;
      contentHash: string;
    }) => void;
    const heldReread = new Promise<{
      text: string;
      truncated: false;
      contentHash: string;
    }>((resolve) => {
      resolveReread = resolve;
    });
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: "Version one",
        truncated: false,
        contentHash: firstHash,
      })
      .mockImplementationOnce(() => heldReread);
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockResolvedValue({ status: "written", contentHash: firstHash });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} v1");
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    await user.keyboard(" queued v1");
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    const secondBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/plain.txt", 2),
    );
    await act(async () => {
      expect(
        secondBuffer.initializeRead(
          "Version two from peer",
          secondHash,
          secondBuffer.beginRead(),
        ),
      ).toBe(true);
    });
    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const secondContent = await findTextEditorContent();
    await user.click(secondContent);
    await user.keyboard("{Control>}a{/Control}Version two pending");
    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReread({
        text: "Version two",
        truncated: false,
        contentHash: secondHash,
      });
      await heldReread;
    });
    view.unmount();
  });

  it("does not capture the v2 Markdown draft when v1 settles after the view closes", async () => {
    const firstHash = "d".repeat(64);
    const secondHash = "e".repeat(64);
    let reads = 0;
    bridgeMock.readWorkspaceText.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { text: "# Version one\n", truncated: false, contentHash: firstHash }
        : { text: "# Version two\n", truncated: false, contentHash: secondHash };
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>(
      (resolve) => {
        resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
      },
    );
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockResolvedValue({ status: "written", contentHash: secondHash });
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={1}
        refreshKey={1}
      />,
    );
    fireEvent.click(await findEnabledMarkdownEditToggle());
    const firstSource = await findSourceEditor();
    replaceCodeEditorText(firstSource, `${firstSource.value}v1`);
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    const secondBuffer = getSharedLocalDocument(
      documentVersionKey("ws-1", "notes/versioned.md", 2),
    );
    await waitFor(() =>
      expect(secondBuffer.getSnapshot()).toMatchObject({
        initialized: true,
        contentHash: secondHash,
      }),
    );
    const secondSource = await findSourceEditor();
    replaceCodeEditorText(secondSource, "# Version two\n\nv2");
    await waitFor(() =>
      expect(secondBuffer.getSnapshot()).toMatchObject({
        body: "# Version two\n\nv2",
        dirty: true,
      }),
    );
    view.unmount();

    render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={2}
        refreshKey={3}
      />,
    );
    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull();
    await waitFor(
      () => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
      { timeout: 5_000 },
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toBe(
      "# Version two\n\nv2",
    );
  });

  it("retires a no-baseline plain-text draft after its unmount write settles", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "Base",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const key = documentVersionKey("ws-1", "notes/plain.txt", 1);
    const oldBuffer = getSharedLocalDocument(key);
    oldBuffer.publishDraft("Base", {});
    const user = userEvent.setup();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={1}
      />,
    );
    const content = await findTextEditorContent();
    await user.click(content);
    await user.keyboard("{End} Draft");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    await waitFor(() => expect(getSharedLocalDocument(key)).not.toBe(oldBuffer));
  });

  it("retires a no-baseline Markdown draft after its unmount write settles", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "# Base\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const key = documentVersionKey("ws-1", "notes/versioned.md", 1);
    const oldBuffer = getSharedLocalDocument(key);
    oldBuffer.publishDraft("# Base\n", {});
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="notes/versioned.md"
        engineVersionKey={1}
      />,
    );
    const user = userEvent.setup();
    const editor = await screen.findByTestId("markdown-editor");
    await user.click(editor);
    await user.type(editor, "Draft");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    await waitFor(() => expect(getSharedLocalDocument(key)).not.toBe(oldBuffer));
  });

  it("keeps a duplicate peer draft while both unmounted writers settle conflicts", async () => {
    useAutoAdvancingFakeTimers();
    const initialHash = "f".repeat(64);
    const externalHash = "0".repeat(64);
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "Base",
      truncated: false,
      contentHash: initialHash,
    });
    let resolveFirst!: () => void;
    const heldFirst = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolveFirst = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    let resolvePeer!: () => void;
    const heldPeer = new Promise<{
      status: "conflict";
      currentContentHash: string;
    }>((resolve) => {
      resolvePeer = () =>
        resolve({ status: "conflict", currentContentHash: externalHash });
    });
    bridgeMock.writeWorkspaceText
      .mockImplementationOnce(() => heldFirst)
      .mockImplementationOnce(() => heldPeer);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const peer = render(
      <FileInspector workspaceId="ws-1" path="notes/plain.txt" />,
    );
    const editors = await waitFor(() => {
      const next = screen.getAllByTestId("view-text-editor");
      expect(next).toHaveLength(2);
      return next;
    });
    const firstContent = await textEditorContent(editors[0]);
    const peerContent = await textEditorContent(editors[1]);
    await user.click(firstContent);
    await user.keyboard("{End} First");
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(peerContent.textContent).toBe("Base First"));
    await user.click(peerContent);
    await user.keyboard("{End} Peer");
    await advanceAutosaveDebounce();
    const key = documentVersionKey("ws-1", "notes/plain.txt", undefined);
    const shared = getSharedLocalDocument(key);
    first.unmount();

    await act(async () => {
      resolveFirst();
      await heldFirst;
    });
    await waitFor(() =>
      expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2),
    );
    expect(getSharedLocalDocument(key)).toBe(shared);
    expect(shared.getSnapshot()).toMatchObject({
      body: "Base First Peer",
      dirty: true,
    });

    await act(async () => {
      resolvePeer();
      await heldPeer;
    });
    expect(getSharedLocalDocument(key)).toBe(shared);
    expect(shared.getSnapshot()).toMatchObject({
      body: "Base",
      dirty: false,
      saveState: "saved",
    });
    const recoveries = await screen.findAllByTestId("orphaned-draft-copy");
    await user.click(recoveries[recoveries.length - 1]!);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Base First Peer"),
    );
    peer.unmount();
    await waitFor(() => expect(getSharedLocalDocument(key)).not.toBe(shared));
  });

  it("can start editing an empty CSV as a table", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="data/empty.csv" />);

    await screen.findByTestId("csv-empty-table");
    await user.click(screen.getByTestId("csv-empty-add-row"));
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "data/empty.csv",
      text: 'column\n""',
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });

  it("routes database share actions to their active file paths", async () => {
    const user = userEvent.setup();
    const onSharePath = vi.fn();
    const view = render(
      <FileInspector
        workspaceId="ws-1"
        path="data.sqlite"
        onSharePath={onSharePath}
      />,
    );

    await screen.findByTestId("view-database");
    await user.click(screen.getByTestId("file-share"));
    expect(onSharePath).toHaveBeenCalledWith("data.sqlite");
  });

  it("shows inline properties in WYSIWYG and hides them in source mode", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("view-markdown");
    // WYSIWYG opens with properties inline under the title — no toggle needed.
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });

    // Source mode edits the raw markdown (frontmatter included), so the inline
    // property rows step aside.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await waitFor(() => {
      expect(screen.queryByTestId("properties-panel")).toBeNull();
    });

    // Returning to WYSIWYG brings the inline properties back.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
  });

  it("keeps read-mode properties edits dirty across a refresh before save", async () => {
    const largeBody = `---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n${"body\n".repeat(14_000)}`;
    const externalBody = `${largeBody}\nexternal update\n`;
    bridgeMock.readWorkspaceText
      .mockResolvedValueOnce({
        text: largeBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      })
      .mockResolvedValueOnce({
        text: externalBody,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
    const user = userEvent.setup();
    const view = render(
      <FileInspector workspaceId="ws-1" path="large.md" refreshKey={0} />,
    );

    await screen.findByTestId("view-markdown");
    // Large docs open in read mode; properties still render inline (editable).
    await screen.findByTestId("properties-panel", {}, { timeout: 5_000 });
    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");
    view.rerender(
      <FileInspector workspaceId="ws-1" path="large.md" refreshKey={1} />,
    );
    await waitFor(() => expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2));
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "large.md",
      text: largeBody.replace("status: draft", "status: ready"),
      expectedContentHash: TEST_CONTENT_HASH,
    });
  });
});
