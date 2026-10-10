// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewActions } from "./fileInspectorUi";
import { EditorTabs } from "./workbench/EditorTabs";
import { EditorGroupFrame } from "./workbench/tabRowActions";

afterEach(cleanup);

const noop = () => undefined;
const NO_RECOVERY: ReadonlySet<string> = new Set();

// One editor group as the shell lays it out: its tab row, then the view.
function Group(props: { id: string; groupNumber: number; path: string; onShare?: () => void; view?: boolean }) {
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
              status={<span data-testid={`status-${props.id}`}>Saving…</span>}
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
    expect(within(actions).getByTestId("status-left").textContent).toBe("Saving…");
    expect(screen.getByTestId("page-left").childElementCount).toBe(0);

    // Keyboard order: the tabs, then the actions in the order the header
    // had them, then the row's own group controls.
    const tablist = within(row).getByRole("tablist");
    expect(precedes(tablist, share)).toBe(true);
    expect(precedes(share, toggle)).toBe(true);
    expect(precedes(toggle, within(row).getByTestId("create-editor-group-right"))).toBe(true);
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
