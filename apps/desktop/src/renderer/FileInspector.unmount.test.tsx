// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { resetOrphanedDrafts } from "./orphanedDrafts";
import * as orphanedDraftsModule from "./orphanedDrafts";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { getSharedLocalDocument } from "./sharedLocalDocument";

// A note stays read-only until its lossy-note check answers and the engine
// open that follows it settles.
async function waitForEditable(): Promise<void> {
  await waitFor(() => {
    const toggle = screen.getByTestId("markdown-edit-toggle");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
  });
}
import { documentVersionKey } from "./documentVersionKey";
import {
  textEditorContent,
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
  findEnabledMarkdownEditToggle,
  toggleSourceOnce,
} from "./FileInspector.editor-fixture";
import {
  settleAfterUnmount,
  resetOrphanedDraftsAndSettle,
  TEST_CONTENT_HASH,
} from "./FileInspector.draft-fixture";
import { type DraftFlush } from "./useAutosavedTextDraft";

const csvMode = (name: "Table" | "Raw") =>
  within(screen.getByTestId("csv-raw-toggle")).getByRole("radio", { name });
import { deferred } from "../testing/deferred";
import {
  EDITOR_WRITE_STALL_MS,
  hasPendingEditorDrafts,
  settlePendingEditorDrafts,
} from "./pendingEditorDrafts";
import { loadStoredDrafts } from "./orphanedDraftStorage";

setupFileInspectorTests();

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

// Typing arms an 800ms autosave, and unmounting (tab close, tab switch: the
// inspector is keyed by the active tab) must not clear the timer without
// flushing, which would silently drop the draft. The unmount cleanup must
// fire the pending draft through writeWorkspaceText.
describe("markdown editor unmount flush", () => {
  const bridgeMock = {
    platform: "linux" as const,
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text: "# Hello\n",
      truncated: false as const,
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
    writeWorkspaceAsset: vi.fn<DohcDesktopBridge["writeWorkspaceAsset"]>(async () => undefined),
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

  it.each([true])(
    "captures the latest local Markdown edit when its exit writer stalls (edit after capture: %s)",
    async (editAfterCapture) => {
      const held = deferred<Awaited<ReturnType<DohcDesktopBridge["writeWorkspaceText"]>>>();
      const latest = deferred<Awaited<ReturnType<DohcDesktopBridge["writeWorkspaceText"]>>>();
      bridgeMock.writeWorkspaceText
        .mockReturnValueOnce(held.promise)
        .mockReturnValueOnce(latest.promise);
      const user = userEvent.setup();
      const onSaveStateChange = vi.fn();
      render(
        <FileInspector workspaceId="ws-1" path="a.md" onSaveStateChange={onSaveStateChange} />,
      );
      await screen.findByTestId("view-markdown");
      const richEditor = await screen.findByTestId("markdown-editor");
      expect(richEditor.classList.contains("dohc-code-editor")).toBe(false);
      await typeInMarkdownEditor(user, richEditor, "Draft!");
      vi.useFakeTimers();
      try {
        let drained = false;
        const drain = settlePendingEditorDrafts().then((result) => {
          drained = result;
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledOnce();
        await settleUserEventAction(
          typeInMarkdownEditor(user, screen.getByTestId("markdown-editor"), "Newest!"),
        );
        expect(drained).toBe(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(EDITOR_WRITE_STALL_MS);
        });
        await drain;
        expect(drained).toBe(true);
        expect(hasPendingEditorDrafts()).toBe(false);
        expect(loadStoredDrafts(Date.now())).toEqual([
          expect.objectContaining({ path: "a.md", text: expect.stringContaining("Newest!") }),
        ]);
        const newestText = editAfterCapture ? "Later!" : "Newest!";
        if (editAfterCapture) {
          await settleUserEventAction(
            typeInMarkdownEditor(user, screen.getByTestId("markdown-editor"), newestText),
          );
          expect(hasPendingEditorDrafts()).toBe(true);
        }
        await act(async () => {
          held.resolve({ status: "written", contentHash: "late-save" });
        });
        expect(onSaveStateChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ kind: "saving" }),
        );
        expect(screen.getByTestId("markdown-save-state").dataset.state).not.toBe("saved");
        expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2);
        expect(bridgeMock.writeWorkspaceText.mock.calls[1]![0].text).toContain(newestText);
        expect(screen.getByTestId("markdown-editor").textContent).toContain(newestText);
        vi.useRealTimers();
        fireEvent.click(screen.getByTestId("markdown-edit-toggle"));
        expect(codeEditorText(await findSourceEditor())).toContain(newestText);
        await act(async () => {
          latest.resolve({ status: "written", contentHash: "latest-save" });
        });
        expect(onSaveStateChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ kind: "saved-here" }),
        );
        expect(codeEditorText(await findSourceEditor())).toContain(newestText);
        expect(loadStoredDrafts(Date.now())).toEqual([
          expect.objectContaining({ text: expect.stringContaining("Newest!") }),
        ]);
      } finally {
        await act(async () => {
          held.resolve({ status: "written", contentHash: "late-save" });
          latest.resolve({ status: "written", contentHash: "latest-save" });
        });
        vi.useRealTimers();
      }
    },
  );

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
      expect(screen.getByTestId("markdown-editor").classList.contains("dohc-code-editor")).toBe(
        false,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("markdown-save-state").getAttribute("data-state")).toBe("saved"),
    );
    await user.click(editToggle);
    const reopenedSource = await findSourceEditor();
    expect(reopenedSource.value).toBe(rawSource);
  });

  it("offers a read-only source view for read-only markdown (truncated reads)", async () => {
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

  it("writes a list property still being typed and a pending body edit when the editor goes", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "---\nid: note-1\ntitle: Plan\ntags:\n  - kyoto\n---\n\n# Plan\n",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);

    await screen.findByTestId("view-markdown");
    await waitForEditable();
    const editor = await screen.findByTestId("markdown-editor");
    await user.click(editor);
    await user.type(editor, "Draft!");
    await user.type(screen.getByLabelText("Property tags value"), ", nara");
    view.unmount();

    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    const written = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0].text;
    expect(written).toContain("tags:\n  - kyoto\n  - nara\n");
    expect(written).toContain("Draft!");
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
    expect(screen.queryByTestId("properties-panel")).toBeNull();
    const editToggle = screen.getByTestId("markdown-edit-toggle") as HTMLButtonElement;
    expect(editToggle.getAttribute("aria-disabled")).toBe("true");
    await user.click(editToggle);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

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
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));

    await user.click(editors[1]!);
    await user.type(editors[1]!, "Zz");
    // The peer's own debounce must not have fired yet, or the write below
    // proves nothing about the completing one.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishWrite();
      await held;
    });

    await waitFor(() =>
      expect(
        bridgeMock.writeWorkspaceText,
        "report the completed write as saved while a lazy peer draft is pending. The peer pane clears its timer and its unsaved flag, no second write ever issues, and closing that pane retires the edit unwritten.",
      ).toHaveBeenCalledTimes(2),
    );
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]![0].text).toContain("Zz");
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
    await waitFor(() => expect(bridgeMock.getWorkspaceSettings).toHaveBeenCalledOnce());

    resolveSettings({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default",
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceAsset).toHaveBeenCalledOnce());

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

  it.each([{ label: "Markdown", path: "queued-unmount.md", markdown: true }])(
    "does not republish a stale $label unmount snapshot over a newer peer draft",
    async ({ path, markdown }) => {
      const initial = markdown ? "# Hello\n\n" : "Hello";
      bridgeMock.readWorkspaceText.mockResolvedValue({
        text: initial,
        truncated: false,
        contentHash: TEST_CONTENT_HASH,
      });
      let resolveFirstWrite!: (value: { status: "written"; contentHash: string }) => void;
      const firstWrite = new Promise<{
        status: "written";
        contentHash: string;
      }>((resolve) => {
        resolveFirstWrite = resolve;
      });
      bridgeMock.writeWorkspaceText.mockImplementationOnce(() => firstWrite);
      const buffer = getSharedLocalDocument(documentVersionKey("ws-1", path, undefined));
      useAutoAdvancingFakeTimers();
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const view = render(<FileInspector workspaceId="ws-1" path={path} />);
        if (markdown) {
          await screen.findByTestId("view-markdown");
          await user.click(await findEnabledMarkdownEditToggle());
        }
        const surface = markdown
          ? screen.getByTestId("markdown-editor")
          : await findTextEditorContent();

        if (markdown) {
          appendCodeEditorText(surface as HTMLElement, " first");
        } else {
          await user.click(surface);
          await user.keyboard("{End} first");
        }
        await advanceAutosaveDebounce();
        await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));

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

        await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
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
    const view = render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await waitFor(() => {
      const content = screen.getByTestId("view-text-editor").querySelector(".cm-content");
      expect(content).toBeInstanceOf(HTMLElement);
      expect(content!.textContent).toContain("Workspace A");
    });

    view.rerender(<FileInspector workspaceId="ws-2" path="notes/plain.txt" />);
    expect(screen.queryByTestId("view-text-editor")).toBeNull();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecondRead();
      await heldSecondRead;
    });
    const content = await waitFor(() => {
      const next = screen.getByTestId("view-text-editor").querySelector(".cm-content");
      expect(next).toBeInstanceOf(HTMLElement);
      expect(next!.textContent).toContain("Workspace B");
      return next as HTMLElement;
    });
    await user.click(content);
    await user.keyboard("{End} edit");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-2",
      relativePath: "notes/plain.txt",
      text: "Workspace B edit",
      expectedContentHash: secondHash,
    });
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
      resolveConflict = () => resolve({ status: "conflict", currentContentHash: externalHash });
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
    await advanceAutosaveDebounce();
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2));
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
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Base One Two"));
    expect(screen.getByTestId("view-text-save-state").getAttribute("data-state")).toBe("error");

    await advanceAutosaveDebounce();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    await user.click(content);
    await user.keyboard("{End} Fresh");
    await advanceAutosaveDebounce();
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0]).toEqual({
      workspaceId: "ws-1",
      relativePath: "notes/plain.txt",
      text: "External Fresh",
      expectedContentHash: externalHash,
    });
    await expect(flush!()).rejects.toThrow("The file changed on disk while dohc saved it.");
    expect(screen.queryByTestId("orphaned-draft-notice")).not.toBeNull();

    await user.click(screen.getByTestId("recovery-dismiss"));
    await user.click(screen.getByTestId("recovery-dismiss-confirm"));
    await waitFor(() => expect(screen.queryByTestId("orphaned-draft-notice")).toBeNull());
    await expect(flush!()).resolves.toBeUndefined();
    expect(screen.getByTestId("view-text-save-state").getAttribute("data-state")).toBe("saved");
    view.unmount();
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
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>((resolve) => {
      resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
    });
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
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));
    await user.keyboard(" Two");
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await heldFirst;
      await firstFlush;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
    render(<FileInspector workspaceId="ws-1" path="notes/plain.txt" />);
    await screen.findByTestId("orphaned-draft-notice");
    fireEvent.click(screen.getByTestId("orphaned-draft-copy"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Base One Two"));
  });

  it("shares concurrent flushes through edits made during deferred writes", async () => {
    useAutoAdvancingFakeTimers();
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    let releaseFirst!: () => void;
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>((resolve) => {
      releaseFirst = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
    });
    let releaseSecond!: () => void;
    const heldSecond = new Promise<{ status: "written"; contentHash: string }>((resolve) => {
      releaseSecond = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
    });
    let releaseThird!: () => void;
    const heldThird = new Promise<{ status: "written"; contentHash: string }>((resolve) => {
      releaseThird = () => resolve({ status: "written" as const, contentHash: TEST_CONTENT_HASH });
    });
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
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));

    await user.keyboard("Two");
    await advanceAutosaveDebounce();
    await act(async () => {
      releaseFirst();
      await heldFirst;
    });
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
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
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(3));
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

  it("sets aside an early edit built on a read the document already moved past", async () => {
    type ReadResult = { text: string; truncated: false; contentHash: string };
    const newerHash = "2".repeat(64);
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
    const capture = vi.spyOn(orphanedDraftsModule, "captureOrphanedDraft");
    const olderCell = () =>
      (screen.queryAllByLabelText("Row 1 column 1") as HTMLInputElement[]).find(
        (input) => input.value === "1",
      );
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const view = render(
        <>
          <FileInspector workspaceId="ws-1" path="data/table.csv" />
          <FileInspector workspaceId="ws-1" path="data/table.csv" />
        </>,
      );
      await waitFor(() => expect(bridgeMock.readWorkspaceText).toHaveBeenCalledTimes(2));
      await act(async () => {
        resolveNewer({ text: "a\n2", truncated: false, contentHash: newerHash });
        await newer;
      });
      const buffer = getSharedLocalDocument(
        documentVersionKey("ws-1", "data/table.csv", undefined),
      );
      await waitFor(() => expect(buffer.getSnapshot().body).toBe("a\n2"));

      // Edit the older pane the moment its cells appear, before its effects.
      const edited = new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The older pane's cells did not appear within 10 s.")),
          10_000,
        );
        observer = new MutationObserver(() => {
          const cell = olderCell();
          if (!cell) return;
          clearTimeout(timer);
          observer?.disconnect();
          fireEvent.change(cell, { target: { value: "10" } });
          resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      // Outside act, so React commits the table and runs its effects in
      // separate tasks, as it does in the app.
      resolveOlder({ text: "a\n1", truncated: false, contentHash: "1".repeat(64) });
      await edited;

      expect(capture).toHaveBeenCalledWith("ws-1", "data/table.csv", "a\n10");
      expect(buffer.getSnapshot()).toMatchObject({ body: "a\n2", contentHash: newerHash });
      await waitFor(() =>
        expect(
          (screen.getAllByLabelText("Row 1 column 1") as HTMLInputElement[]).map(
            (input) => input.value,
          ),
        ).toEqual(["2", "2"]),
      );
      view.unmount();
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      observer?.disconnect();
      capture.mockRestore();
    }
  });

  it("rebuilds CSV row offsets after structural and raw edits", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValueOnce({
      text: "name,note\nAda,before\nGrace,after",
      truncated: false,
      contentHash: TEST_CONTENT_HASH,
    });
    const view = render(<FileInspector workspaceId="ws-1" path="data/table.csv" />);
    await screen.findByTestId("view-csv");
    const change = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    change("Row 1 column 1", "first");
    change("Row 2 column 2", "cached");
    fireEvent.click(screen.getByLabelText("Delete row 1"));
    change("Row 1 column 2", "after delete");
    fireEvent.click(screen.getByTestId("csv-add-column"));
    change("Row 1 column 3", "added");
    fireEvent.click(screen.getByLabelText("Delete column 1"));
    change("Row 1 column 1", "remaining");
    fireEvent.click(screen.getByTestId("csv-add-row"));
    change("Row 2 column 1", "new row");
    fireEvent.click(csvMode("Raw"));
    expect((screen.getByTestId("csv-raw-editor") as HTMLTextAreaElement).value).toBe(
      "note,column_3\nremaining,added\nnew row,",
    );
    fireEvent.change(screen.getByTestId("csv-raw-editor"), {
      target: { value: '"name",note\r\n"raw",before\r\n' },
    });
    fireEvent.click(csvMode("Table"));
    change("Row 1 column 1", "😀");
    change("Row 1 column 2", 'after "raw"');
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "data/table.csv",
      text: 'name,note\n😀,"after ""raw"""',
      expectedContentHash: TEST_CONTENT_HASH,
    });
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
    const heldFirst = new Promise<{ status: "written"; contentHash: string }>((resolve) => {
      resolveFirst = () => resolve({ status: "written", contentHash: firstHash });
    });
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
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1));

    view.rerender(
      <FileInspector
        workspaceId="ws-1"
        path="notes/plain.txt"
        engineVersionKey={2}
        refreshKey={2}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    const secondBuffer = getSharedLocalDocument(documentVersionKey("ws-1", "notes/plain.txt", 2));
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
    await waitFor(() => expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(2));
    expect(bridgeMock.writeWorkspaceText.mock.calls[1]?.[0].text).toBe("Version two v2");
  });
});
