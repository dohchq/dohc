// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETED_FILE_DRAFT_NOTICE, OPENING_TITLE, OPENING_WORDS_DELAY_MS, OpeningState, OrphanedDraftNotices, REPLACED_HISTORY_DRAFT_NOTICE, ViewActions } from "./fileInspectorUi";
import { captureOrphanedDraft, loadLiveDraftRecovery, resetOrphanedDrafts } from "./orphanedDrafts";
import { PENDING_SHARE_WORDS_DELAY_MS, StateMark, type SaveStateKey } from "./ui/StateMark";
import { EditorTabs } from "./workbench/EditorTabs";
import { EditorGroupFrame } from "./workbench/tabRowActions";

afterEach(cleanup);

const noop = () => undefined;
const NO_RECOVERY: ReadonlySet<string> = new Set();

// One editor group as the shell lays it out: its tab row, then the view.
function Group(props: {
  id: string;
  groupNumber: number;
  path: string;
  onShare?: () => void;
  view?: boolean;
  saveState?: SaveStateKey | "opening";
}) {
  return (
    <div data-testid={`group-${props.id}`}>
      <EditorGroupFrame
        tabs={(actionsRef) => (
          <EditorTabs
            actionsRef={actionsRef}
            groupId={props.id}
            groupNumber={props.groupNumber}
            tabs={[{ path: props.path }]}
            activeTab={props.path}
            activeTabDirty={false}
            recoveryPaths={NO_RECOVERY}
            onActivate={noop}
            onClose={noop}
            onContextMenu={noop}
            onMove={noop}
            onMoveToGroup={noop}
            onCreateGroupRight={noop}
          />
        )}
      >
        <div data-testid={`page-${props.id}`}>
          {props.view === false ? null : (
            <ViewActions
              onShare={props.onShare}
              status={
                props.saveState === "opening" ? (
                  <OpeningState />
                ) : (
                  <StateMark
                    testId={`status-${props.id}`}
                    truncate
                    quietWhenCalm
                    state={props.saveState ?? "file-locked"}
                    shown={props.saveState ?? "file-locked"}
                  />
                )
              }
              actions={<button type="button">Source</button>}
            />
          )}
        </div>
      </EditorGroupFrame>
    </div>
  );
}

const precedes = (first: Element, second: Element) =>
  (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("ViewActions", () => {
  // Four bars became two: the document's actions sit at the right end of its
  // tab row, and nothing of them stays above the page.
  it("puts the document's actions in its group's tab row, not above the page", () => {
    render(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} />);
    const row = screen.getByTestId("editor-tabs");
    const actions = within(row).getByTestId("editor-tab-actions");
    const share = within(actions).getByRole("button", { name: "Share file" });
    const toggle = within(actions).getByRole("button", { name: "Source" });
    expect(within(actions).getByTestId("status-left").textContent).toBe("File in use");
    expect(screen.getByTestId("page-left").childElementCount).toBe(0);

    // Keyboard order: the tabs, then the actions in the order the header
    // had them, then the row's own group controls.
    const tablist = within(row).getByRole("tablist");
    expect(precedes(tablist, share)).toBe(true);
    expect(precedes(share, toggle)).toBe(true);
    expect(precedes(toggle, within(row).getByTestId("create-editor-group-right"))).toBe(true);
  });

  // Run arrives once main answers that the file is an app's entry. It stands
  // left of Share, so Share and the controls right of it stay put.
  it("puts Run for an app's entry left of Share, and nothing without one", () => {
    const onRun = vi.fn();
    const { rerender } = render(<ViewActions onShare={noop} actions={<button type="button">Source</button>} />);
    expect(screen.queryByRole("button", { name: "Run app" })).toBeNull();
    rerender(<ViewActions onShare={noop} onRun={onRun} actions={<button type="button">Source</button>} />);
    const run = screen.getByRole("button", { name: "Run app" });
    expect(run.dataset.testid).toBe("file-run-app");
    expect(precedes(run, screen.getByRole("button", { name: "Share file" }))).toBe(true);
    fireEvent.click(run);
    expect(onRun).toHaveBeenCalledOnce();
  });

  // Saved, saving and saved-to-host pass on their own, so the row says them
  // only to screen readers, and typing never changes what the row draws. A
  // held file, a lasting pending share or a failed save keeps its words.
  it.each(["saved", "saving", "saved-to-host"] as const)(
    "keeps a calm %s state for screen readers only, with no box beside Share",
    (saveState) => {
      render(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState={saveState} />);
      const mark = screen.getByTestId("status-left");
      expect(mark.classList.contains("sr-only")).toBe(true);
      expect(mark.dataset.state).toBe(saveState);
      // The status box draws nothing, so the row is as wide as a loading one.
      expect(mark.parentElement?.className.split(" ")[0]).toBe("contents");
    },
  );

  it.each([
    ["file-locked", "File in use"],
    ["error", "Couldn't save"],
    ["changed-on-disk", "Changed outside dohc"],
  ] as const)("shows a %s state in words beside Share", (saveState, words) => {
    render(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState={saveState} />);
    const mark = screen.getByTestId("status-left");
    expect(mark.classList.contains("sr-only")).toBe(false);
    expect(mark.textContent).toBe(words);
  });

  // Collaborators don't have the edits until the share takes them, so a
  // pending share that lasts says so. A settle that beats the host's
  // acknowledgement passes through it on the way to saved to host; that
  // never shows words, so typing never makes the row flash.
  describe("pending share", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("shows its words once it has lasted", () => {
      render(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState="pending-share" />);
      expect(screen.getByTestId("status-left").classList.contains("sr-only")).toBe(true);
      act(() => vi.advanceTimersByTime(PENDING_SHARE_WORDS_DELAY_MS));
      const mark = screen.getByTestId("status-left");
      expect(mark.classList.contains("sr-only")).toBe(false);
      expect(mark.textContent).toBe("Saved locally · Pending share");
    });

    // Host away: each keystroke's save passes through saving, and the words
    // stay up through it until the host takes the edits.
    it("keeps its words while the person types, until the host takes the edits", () => {
      const group = (saveState: SaveStateKey) => (
        <Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState={saveState} />
      );
      const words = () => {
        const mark = screen.getByTestId("status-left");
        return mark.classList.contains("sr-only") ? null : mark.textContent;
      };
      const { rerender } = render(group("pending-share"));
      act(() => vi.advanceTimersByTime(PENDING_SHARE_WORDS_DELAY_MS));
      expect(words()).toBe("Saved locally · Pending share");
      for (let keystroke = 0; keystroke < 5; keystroke += 1) {
        rerender(group("saving"));
        expect(words()).toBe("Saved locally · Pending share");
        act(() => vi.advanceTimersByTime(100));
        rerender(group("pending-share"));
        expect(words()).toBe("Saved locally · Pending share");
      }
      // The store's own state stays readable through the held words.
      rerender(group("saving"));
      expect(screen.getByTestId("status-left").dataset.state).toBe("saving");

      rerender(group("saved-to-host"));
      expect(words()).toBeNull();
      // Resolved: the next brief pending share waits again.
      rerender(group("saving"));
      expect(words()).toBeNull();
      rerender(group("pending-share"));
      expect(words()).toBeNull();
    });

    it("draws nothing while a host answers each settle in time", () => {
      const group = (saveState: SaveStateKey) => (
        <Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState={saveState} />
      );
      const { rerender } = render(group("saving"));
      for (let settle = 0; settle < 5; settle += 1) {
        rerender(group("pending-share"));
        act(() => vi.advanceTimersByTime(PENDING_SHARE_WORDS_DELAY_MS - 1));
        expect(screen.getByTestId("status-left").classList.contains("sr-only")).toBe(true);
        rerender(group("saved-to-host"));
        rerender(group("saving"));
      }
      expect(screen.getByTestId("status-left").parentElement?.className.split(" ")[0]).toBe("contents");
    });
  });

  // An open can last, and meanwhile the page shows the disk copy read-only,
  // so a slow open says "Opening…". A quick one draws nothing: the actions
  // stay where the ready document draws them.
  describe("opening", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("draws no words and keeps the actions in place for a quick open", () => {
      const { rerender } = render(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState="opening" />);
      const opening = screen.getByTestId("markdown-open-state");
      expect(opening.classList.contains("sr-only")).toBe(true);
      expect(opening.textContent).toBe("Opening…");
      expect(opening.parentElement?.className.split(" ")[0]).toBe("contents");
      act(() => vi.advanceTimersByTime(OPENING_WORDS_DELAY_MS - 1));
      expect(screen.getByTestId("markdown-open-state").classList.contains("sr-only")).toBe(true);
      rerender(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState="saved" />);
      expect(screen.queryByTestId("markdown-open-state")).toBeNull();
      expect(screen.getByTestId("status-left").parentElement?.className.split(" ")[0]).toBe("contents");
    });

    it("says Opening… in words once the open is slow", () => {
      render(<Group id="left" groupNumber={1} path="trip/plan.md" onShare={noop} saveState="opening" />);
      act(() => vi.advanceTimersByTime(OPENING_WORDS_DELAY_MS));
      const opening = screen.getByTestId("markdown-open-state");
      expect(opening.getAttribute("role")).toBe("status");
      expect(opening.textContent).toBe("Opening…");
      expect(opening.classList.contains("sr-only")).toBe(false);
      expect(opening.getAttribute("title")).toBe(OPENING_TITLE);
    });
  });

  it("leaves the row's action slot empty for a tab with no actions", () => {
    render(<Group id="left" groupNumber={1} path="trip/plan.md" view={false} />);
    expect(screen.getByTestId("editor-tab-actions").childElementCount).toBe(0);
  });

  // A split: each group's row carries that group's document, and a click
  // acts on that document.
  it("gives each group in a split its own document actions", () => {
    const shareLeft = vi.fn();
    const shareRight = vi.fn();
    render(
      <>
        <Group id="left" groupNumber={1} path="trip/plan.md" onShare={shareLeft} />
        <Group id="right" groupNumber={2} path="trip/budget.csv" onShare={shareRight} />
      </>,
    );
    const left = within(within(screen.getByTestId("group-left")).getByTestId("editor-tab-actions"));
    const right = within(within(screen.getByTestId("group-right")).getByTestId("editor-tab-actions"));
    expect(left.getByTestId("status-left")).toBeTruthy();
    expect(left.queryByTestId("status-right")).toBeNull();
    expect(right.getByTestId("status-right")).toBeTruthy();
    expect(right.queryByTestId("status-left")).toBeNull();

    fireEvent.click(right.getByRole("button", { name: "Share file" }));
    expect(shareRight).toHaveBeenCalledOnce();
    expect(shareLeft).not.toHaveBeenCalled();
  });

  it("draws the actions in a row of their own outside an editor group", () => {
    render(<ViewActions onShare={noop} />);
    expect(screen.getByTestId("file-share")).toBeTruthy();
    expect(screen.queryByTestId("editor-tab-actions")).toBeNull();
  });
});

describe("OrphanedDraftNotices", () => {
  // The rows only need a bridge to exist; nothing here reaches main.
  beforeEach(() => vi.stubGlobal("dohcDesktop", new Proxy({}, { get: () => () => undefined })));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOrphanedDrafts();
  });

  it("says a replaced history's edits are set aside only once storage keeps them", async () => {
    const kept = captureOrphanedDraft("ws-1", "kept.md", "earlier edits");
    render(<OrphanedDraftNotices workspaceId="ws-1" path="kept.md" replacedDraftIds={[kept]} />);
    expect((await screen.findByTestId("orphaned-draft-notice")).textContent).toContain(REPLACED_HISTORY_DRAFT_NOTICE);
  });

  // dohc#2308. Main sets the text of a file deleted outside dohc aside while
  // its document is still open, and the banner says what the save notice says.
  it("says a deleted file's set-aside text is the file's, not a reopened document's", async () => {
    const record = {path: "notes/gone.md", objectId: "object", text: "typed", updateBase64: "AAA="};
    vi.stubGlobal("dohcDesktop", new Proxy({}, { get: (_target, name) => name === "listLiveDraftRecovery"
      ? async () => [{...record, recordId: "a".repeat(64), reason: "deleted"}, {...record, path: "notes/reopened.md", recordId: "b".repeat(64)}]
      : () => undefined }));
    await loadLiveDraftRecovery("ws-1", () => true);
    render(<OrphanedDraftNotices workspaceId="ws-1" path="notes/gone.md" />);
    expect((await screen.findByTestId("orphaned-draft-notice")).textContent).toContain(DELETED_FILE_DRAFT_NOTICE);
    cleanup();
    render(<OrphanedDraftNotices workspaceId="ws-1" path="notes/reopened.md" />);
    const reopened = (await screen.findByTestId("orphaned-draft-notice")).textContent;
    expect(reopened).toContain("This document reopened before your last edit saved.");
    expect(reopened).not.toContain("outside dohc");
  });

  it("asks for a copy of a replaced history's edits that storage refused", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const refused = captureOrphanedDraft("ws-1", "refused.md", "earlier edits");
    render(<OrphanedDraftNotices workspaceId="ws-1" path="refused.md" replacedDraftIds={[refused]} />);
    const row = await screen.findByTestId("orphaned-draft-notice");
    expect(row.textContent).not.toContain(REPLACED_HISTORY_DRAFT_NOTICE);
    expect(row.textContent).toContain("Copy your text to keep it.");
  });
});
