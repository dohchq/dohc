// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollectionFrame,
  type CollectionFrameMenuSection,
  type CollectionFrameProps,
  type CollectionFrameTab,
  type CollectionFrameViews,
} from "./CollectionFrame";
import { deferred } from "../../testing/deferred";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TABS: CollectionFrameTab[] = [
  { id: "all", name: "All tasks", kind: "table", saved: true },
  { id: "status", name: "By status", kind: "board", saved: true },
  { id: "schedule", name: "Schedule", kind: "calendar", saved: true },
];
const STATUS = { id: "status-field", name: "Status" };
const OWNER = { id: "owner-field", name: "Owner" };
const DUE = { id: "due-field", name: "Due" };

function savedViews(overrides: Partial<CollectionFrameViews> = {}): CollectionFrameViews {
  return {
    groupFields: [STATUS, OWNER],
    dateFields: [DUE],
    create: vi.fn(async () => null),
    rename: vi.fn(async () => null),
    remove: vi.fn(),
    confirmDelete: true,
    ...overrides,
  };
}

const MENU: CollectionFrameMenuSection[] = [
  { label: "View", commands: [{ id: "fields", label: "Fields", onSelect: vi.fn() }] },
  { label: "Collection", commands: [{ id: "customize", label: "Customize…", onSelect: vi.fn() }] },
];

/** A frame that keeps which tab is open, as a page does. */
function Frame(props: Partial<CollectionFrameProps> & { onSelect?: (id: string) => void }) {
  const { onSelect, ...rest } = props;
  const [active, setActive] = useState(props.activeTabId ?? "all");
  return (
    <CollectionFrame
      name="Launch tracker"
      tabs={TABS}
      menuLabel="Collection actions"
      menu={MENU}
      {...rest}
      activeTabId={active}
      onSelectTab={(id) => {
        setActive(id);
        onSelect?.(id);
      }}
    >
      {props.children ?? <p>Records</p>}
    </CollectionFrame>
  );
}

const tab = (name: string) => within(screen.getByTestId("collection-view-switcher")).getByRole("button", { name });
const addView = () => screen.getByRole("button", { name: "Add a view" });

describe("the header", () => {
  it("names the Collection as the page's heading and its region, with its count and status beside it", () => {
    render(<Frame count="7 records" status={<span>Editing is paused</span>} />);
    const page = screen.getByRole("region", { name: "Launch tracker" });
    expect(page.getAttribute("data-testid")).toBe("collection-page");
    const header = screen.getByRole("heading", { level: 1, name: "Launch tracker" }).closest("header")!;
    expect(within(header).getByTestId("collection-record-count").textContent).toBe("7 records");
    expect(within(header).getByText("Editing is paused")).toBeTruthy();
    // Nothing sits above the name.
    expect(page.firstElementChild).toBe(header);
  });

  it("shows no count when the page does not know one", () => {
    render(<Frame />);
    expect(screen.queryByTestId("collection-record-count")).toBeNull();
  });
});

describe("the view tabs", () => {
  it("shows a tab even for one view, with the layout's icon and the open view pressed", () => {
    render(<Frame tabs={[{ id: "only", name: "Table", kind: "table" }]} activeTabId="only" />);
    const only = tab("Table");
    expect(only.getAttribute("aria-pressed")).toBe("true");
    expect(only.querySelector("svg")).toBeTruthy();
  });

  it("opens the tab a person presses", async () => {
    const onSelect = vi.fn();
    render(<Frame onSelect={onSelect} />);
    expect(tab("All tasks").getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(tab("By status"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("status");
    expect(tab("By status").getAttribute("aria-pressed")).toBe("true");
    expect(tab("All tasks").getAttribute("aria-pressed")).toBe("false");
  });

  it("is one tab stop, and the arrow keys, Home and End move between tabs", async () => {
    const user = userEvent.setup();
    render(<Frame />);
    expect(TABS.map((entry) => tab(entry.name).tabIndex)).toEqual([0, -1, -1]);
    tab("All tasks").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("By status"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tab("Schedule"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("All tasks"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tab("Schedule"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tab("All tasks"));
    // Enter opens the tab that has focus.
    await user.keyboard("{ArrowRight}{Enter}");
    expect(tab("By status").getAttribute("aria-pressed")).toBe("true");
    expect(tab("By status").tabIndex).toBe(0);
  });

  it("holds the tabs and their controls while the page says so", () => {
    render(<Frame views={savedViews()} tabsDisabled />);
    expect(TABS.every((entry) => (tab(entry.name) as HTMLButtonElement).disabled)).toBe(true);
    expect((addView() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "View actions" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.contextMenu(tab("By status"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("adding a view", () => {
  it("creates a table under the layout's name from the + popover, and closes with focus back on +", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    render(<Frame views={views} />);
    await user.click(addView());
    const popover = screen.getByRole("dialog", { name: "Add a view" });
    const name = within(popover).getByLabelText<HTMLInputElement>("Name");
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("Table");
    expect(within(popover).getAllByRole("radio").map((tile) => [tile.textContent, tile.getAttribute("aria-checked")]))
      .toEqual([["Table", "true"], ["Board", "false"], ["Calendar", "false"]]);
    await user.click(within(popover).getByRole("button", { name: "Create view" }));
    expect(views.create).toHaveBeenCalledExactlyOnceWith({ name: "Table", kind: "table" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(addView()));
  });

  it("asks which field a board groups by", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    render(<Frame views={views} />);
    await user.click(addView());
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    expect(popover.queryByLabelText("Group by")).toBeNull();
    await user.click(popover.getByRole("radio", { name: "Board" }));
    expect(popover.getByLabelText<HTMLInputElement>("Name").value).toBe("Board");
    const group = popover.getByLabelText<HTMLSelectElement>("Group by");
    expect(within(group).getAllByRole("option").map((option) => option.textContent)).toEqual(["Status", "Owner"]);
    await user.selectOptions(group, "Owner");
    await user.clear(popover.getByLabelText("Name"));
    await user.type(popover.getByLabelText("Name"), "By owner{Enter}");
    expect(views.create).toHaveBeenCalledExactlyOnceWith({ name: "By owner", kind: "board", groupBy: "owner-field" });
  });

  it("asks which date field a calendar uses", async () => {
    const user = userEvent.setup();
    const views = savedViews({ dateFields: [DUE, { id: "start-field", name: "Start" }] });
    render(<Frame views={views} />);
    await user.click(addView());
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    await user.click(popover.getByRole("radio", { name: "Calendar" }));
    await user.selectOptions(popover.getByLabelText("Date field"), "Start");
    await user.click(popover.getByRole("button", { name: "Create view" }));
    expect(views.create).toHaveBeenCalledExactlyOnceWith({ name: "Calendar", kind: "calendar", dateField: "start-field" });
  });

  it("says a Collection has no date field, offers the way to add one, and creates no calendar without it", async () => {
    const user = userEvent.setup();
    const onAddDateField = vi.fn();
    const views = savedViews({ dateFields: [], onAddDateField });
    render(<Frame views={views} />);
    await user.click(addView());
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    await user.click(popover.getByRole("radio", { name: "Calendar" }));
    expect(popover.getByText("This Collection has no date field.")).toBeTruthy();
    expect(popover.queryByLabelText("Date field")).toBeNull();
    await user.click(popover.getByRole("button", { name: "Create view" }));
    expect(popover.getByRole("alert").textContent).toBe("A calendar needs a date field. Add one first.");
    expect(views.create).not.toHaveBeenCalled();
    // The primary stays enabled, and focus goes to what fixes the problem.
    expect(document.activeElement).toBe(popover.getByRole("button", { name: "Add a date field" }));
    await user.click(popover.getByRole("button", { name: "Add a date field" }));
    expect(onAddDateField).toHaveBeenCalledOnce();
  });

  it("leaves Add a date field out for someone who cannot add one", async () => {
    const user = userEvent.setup();
    render(<Frame views={savedViews({ dateFields: [] })} />);
    await user.click(addView());
    await user.click(screen.getByRole("radio", { name: "Calendar" }));
    expect(screen.getByText("This Collection has no date field.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a date field" })).toBeNull();
  });

  it("gives a second view of a layout a name no view has, and refuses a name a view has", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    render(<Frame views={views} tabs={[...TABS, { id: "t", name: "Table", kind: "table", saved: true }]} />);
    await user.click(addView());
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    const name = popover.getByLabelText<HTMLInputElement>("Name");
    expect(name.value).toBe("Table 2");
    await user.clear(name);
    await user.click(popover.getByRole("button", { name: "Create view" }));
    expect(popover.getByRole("alert").textContent).toBe("Give the view a name.");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(popover.getByRole("alert").id);
    expect(document.activeElement).toBe(name);
    await user.type(name, "Schedule");
    expect(popover.queryByRole("alert")).toBeNull();
    await user.click(popover.getByRole("button", { name: "Create view" }));
    expect(popover.getByRole("alert").textContent).toBe('A view named "Schedule" already exists. Choose another name.');
    expect(views.create).not.toHaveBeenCalled();
  });

  it("stays open while the view saves, then says in place why it could not", async () => {
    const user = userEvent.setup();
    const saving = deferred<string | null>();
    const views = savedViews({ create: vi.fn(() => saving.promise) });
    render(<Frame views={views} />);
    await user.click(addView());
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    await user.click(popover.getByRole("button", { name: "Create view" }));
    const primary = popover.getByRole<HTMLButtonElement>("button", { name: "Creating…" });
    expect(primary.disabled).toBe(true);
    // A press outside while the view saves does not close the popover.
    fireEvent.pointerDown(screen.getByText("Records"));
    expect(screen.getByRole("dialog", { name: "Add a view" })).toBeTruthy();
    saving.resolve("dohc could not update this collection.");
    await waitFor(() => expect(popover.getByRole("alert").textContent).toBe("dohc could not update this collection."));
    expect(popover.getByRole<HTMLButtonElement>("button", { name: "Create view" }).disabled).toBe(false);
  });

  it("stays open when + or a tab is pressed while the view saves, and shows the failure", async () => {
    const user = userEvent.setup();
    const saving = deferred<string | null>();
    const views = savedViews({ create: vi.fn(() => saving.promise) });
    render(<Frame views={views} />);
    await user.click(addView());
    await user.click(screen.getByRole("button", { name: "Create view" }));
    await user.click(addView());
    expect(screen.getByRole("dialog", { name: "Add a view" })).toBeTruthy();
    await user.click(tab("By status"));
    expect(tab("By status").getAttribute("aria-pressed")).toBe("true");
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    saving.resolve("This collection changed while you were editing. Try again.");
    await waitFor(() => expect(popover.getByRole("alert").textContent).toBe("This collection changed while you were editing. Try again."));
    expect(views.create).toHaveBeenCalledOnce();
    // With the answer in, + closes the popover again.
    await user.click(addView());
    expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("keeps the popover and the typed name on an Escape that belongs to a composition ($isComposing, $keyCode)", async (composing) => {
    const user = userEvent.setup();
    render(<Frame views={savedViews()} />);
    await user.click(addView());
    const name = within(screen.getByRole("dialog", { name: "Add a view" })).getByLabelText<HTMLInputElement>("Name");
    await user.clear(name);
    await user.type(name, "にほん");
    fireEvent.keyDown(name, { key: "Escape", ...composing });
    expect(within(screen.getByRole("dialog", { name: "Add a view" })).getByLabelText<HTMLInputElement>("Name").value).toBe("にほん");
    fireEvent.keyDown(name, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull();
  });

  it("closes on Escape and on a press outside, and creates nothing", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    render(<Frame views={views} />);
    await user.click(addView());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(addView()));
    await user.click(addView());
    expect(addView().getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(screen.getByText("Records"));
    expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull();
    expect(views.create).not.toHaveBeenCalled();
  });
});

describe("a tab's menu", () => {
  it("renames the open view from its menu, in a popover on the tab", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    render(<Frame views={views} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    expect(within(screen.getByRole("menu", { name: "View actions" })).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Delete"]);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const popover = within(screen.getByRole("dialog", { name: "Rename All tasks" }));
    const name = popover.getByLabelText<HTMLInputElement>("Name");
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("All tasks");
    await user.clear(name);
    await user.type(name, "By status");
    await user.click(popover.getByRole("button", { name: "Rename" }));
    expect(popover.getByRole("alert").textContent).toBe('A view named "By status" already exists. Choose another name.');
    expect(views.rename).not.toHaveBeenCalled();
    await user.clear(name);
    await user.type(name, "Everything{Enter}");
    expect(views.rename).toHaveBeenCalledExactlyOnceWith("all", "Everything");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tab("All tasks")));
  });

  it("keeps the rename popover when a tab or + is pressed while the name saves, and shows the failure", async () => {
    const user = userEvent.setup();
    const saving = deferred<string | null>();
    const views = savedViews({ rename: vi.fn(() => saving.promise) });
    render(<Frame views={views} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const name = within(screen.getByRole("dialog", { name: "Rename All tasks" })).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Everything{Enter}");
    await user.click(tab("By status"));
    expect(screen.getByRole("dialog", { name: "Rename All tasks" })).toBeTruthy();
    await user.click(addView());
    expect(screen.getByRole("dialog", { name: "Rename All tasks" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull();
    saving.resolve("This collection changed while you were editing. Try again.");
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Rename All tasks" })).getByRole("alert").textContent)
      .toBe("This collection changed while you were editing. Try again."));
    expect(views.rename).toHaveBeenCalledExactlyOnceWith("all", "Everything");
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("keeps the rename popover and the typed name on an Escape that belongs to a composition ($isComposing, $keyCode)", async (composing) => {
    const user = userEvent.setup();
    render(<Frame views={savedViews()} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const name = within(screen.getByRole("dialog", { name: "Rename All tasks" })).getByLabelText<HTMLInputElement>("Name");
    await user.clear(name);
    await user.type(name, "すべて");
    fireEvent.keyDown(name, { key: "Escape", ...composing });
    expect(within(screen.getByRole("dialog", { name: "Rename All tasks" })).getByLabelText<HTMLInputElement>("Name").value).toBe("すべて");
    fireEvent.keyDown(name, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts focus on the open view's tab once a deleted tab is gone", async () => {
    const user = userEvent.setup();
    // A page that deletes the view after its write, and opens the first view when the open one goes.
    function Deleting() {
      const [tabs, setTabs] = useState(TABS);
      const [active, setActive] = useState("schedule");
      const remove = (id: string) => void Promise.resolve().then(() => {
        setTabs((current) => current.filter((entry) => entry.id !== id));
        setActive((current) => (current === id ? "all" : current));
      });
      return (
        <CollectionFrame name="Launch tracker" tabs={tabs} activeTabId={active} onSelectTab={setActive} views={savedViews({ confirmDelete: false, remove })} menuLabel="Collection actions" menu={MENU}>
          <p>Records</p>
        </CollectionFrame>
      );
    }
    render(<Deleting />);
    // The open tab is the last one, so its button goes with it.
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(within(screen.getByTestId("collection-view-switcher")).queryByRole("button", { name: "Schedule" })).toBeNull());
    expect(tab("All tasks").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(tab("All tasks"));
  });

  it("puts focus on the open view's tab when a tab that was not open is deleted", async () => {
    const user = userEvent.setup();
    // The next tab takes the deleted tab's place, and must not keep its focus.
    function Deleting() {
      const [tabs, setTabs] = useState(TABS);
      const remove = (id: string) => void Promise.resolve().then(() => setTabs((current) => current.filter((entry) => entry.id !== id)));
      return <Frame tabs={tabs} views={savedViews({ confirmDelete: false, remove })} />;
    }
    render(<Deleting />);
    fireEvent.contextMenu(tab("By status"));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(within(screen.getByTestId("collection-view-switcher")).queryByRole("button", { name: "By status" })).toBeNull());
    expect(document.activeElement).toBe(tab("All tasks"));
  });

  it("saves nothing when the name did not change", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    render(<Frame views={views} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{Enter}");
    expect(views.rename).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks a second time before a delete that has no Undo", async () => {
    const user = userEvent.setup();
    const views = savedViews({ confirmDelete: true });
    render(<Frame views={views} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(views.remove).not.toHaveBeenCalled();
    // The menu stays open, and the same row now confirms.
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Confirm delete" }));
    expect(views.remove).toHaveBeenCalledExactlyOnceWith("all");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("takes the question back when the menu closes", async () => {
    const user = userEvent.setup();
    const views = savedViews({ confirmDelete: true });
    render(<Frame views={views} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "View actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    expect(views.remove).not.toHaveBeenCalled();
  });

  it("deletes at once where the page offers Undo, and opens the page's editor from Edit view…", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const views = savedViews({ confirmDelete: false, onEdit });
    render(<Frame views={views} />);
    await user.click(screen.getByRole("button", { name: "View actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Edit view…", "Delete"]);
    await user.click(screen.getByRole("menuitem", { name: "Edit view…" }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("all");
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(views.remove).toHaveBeenCalledExactlyOnceWith("all");
  });

  it("opens the same menu from a right press on any tab, and from the context menu key", async () => {
    const user = userEvent.setup();
    const views = savedViews({ confirmDelete: false });
    render(<Frame views={views} />);
    // Only the open tab shows the button.
    expect(screen.getAllByRole("button", { name: "View actions" })).toHaveLength(1);
    fireEvent.contextMenu(tab("Schedule"));
    await user.click(within(screen.getByRole("menu", { name: "View actions" })).getByRole("menuitem", { name: "Delete" }));
    expect(views.remove).toHaveBeenCalledExactlyOnceWith("schedule");
    tab("By status").focus();
    await user.keyboard("{ContextMenu}");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Rename By status" })).toBeTruthy();
  });

  it("offers no menu on a tab that is not a saved view", () => {
    render(<Frame views={savedViews()} tabs={[{ id: "all", name: "All records", kind: "table" }, ...TABS.slice(1)]} />);
    expect(screen.queryByRole("button", { name: "View actions" })).toBeNull();
    fireEvent.contextMenu(tab("All records"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("tabs for someone who cannot save views", () => {
  const LAYOUTS: CollectionFrameTab[] = [
    { id: "table", name: "Table", kind: "table" },
    { id: "board", name: "Board", kind: "board" },
    { id: "calendar", name: "Calendar", kind: "calendar" },
  ];

  it("switches between the tabs, with no +, no menu, and nothing to rename or delete", async () => {
    const onSelect = vi.fn();
    render(<Frame tabs={LAYOUTS} activeTabId="table" onSelect={onSelect} />);
    expect(screen.queryByRole("button", { name: "Add a view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View actions" })).toBeNull();
    fireEvent.contextMenu(tab("Board"));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(tab("Calendar"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("calendar");
    expect(tab("Calendar").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the open view's field", () => {
  it("names the field a board groups by, and changes it from its menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Frame viewField={{ label: "Group board by", prefix: "Group by", value: STATUS.id, options: [STATUS, OWNER], onChange }} />);
    await user.click(screen.getByRole("button", { name: "Group by Status" }));
    const menu = within(screen.getByRole("menu", { name: "Group board by" }));
    expect(menu.getAllByRole("menuitemradio").map((row) => [row.textContent, row.getAttribute("aria-checked")])).toEqual([["Status", "true"], ["Owner", "false"]]);
    await user.click(menu.getByRole("menuitemradio", { name: "Owner" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(OWNER.id);
  });

  it("is left out when the view has no field to choose", () => {
    render(<Frame viewField={{ label: "Calendar date", prefix: "Date", value: undefined, options: [], onChange: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: /Date/ })).toBeNull();
  });
});

describe("tabs the page holds, or takes away, while something is open", () => {
  const GROUP = { label: "Group board by", prefix: "Group by", value: STATUS.id, options: [STATUS, OWNER] };

  it.each([
    { held: "the tabs", props: (onChange: (id: string) => void) => ({ tabsDisabled: true, viewField: { ...GROUP, onChange } }) },
    { held: "the field", props: (onChange: (id: string) => void) => ({ viewField: { ...GROUP, onChange, disabled: true } }) },
  ])("closes the open view's field menu when the page holds $held, and changes nothing", async ({ props }) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const page = render(<Frame viewField={{ ...GROUP, onChange }} />);
    await user.click(screen.getByRole("button", { name: "Group by Status" }));
    const owner = screen.getByRole("menuitemradio", { name: "Owner" });
    page.rerender(<Frame {...props(onChange)} />);
    expect(screen.queryByRole("menu")).toBeNull();
    // A row that was on screen as the page held the control picks nothing.
    fireEvent.click(owner);
    expect(onChange).not.toHaveBeenCalled();
    // Nothing opens again by itself once the page lets go.
    page.rerender(<Frame viewField={{ ...GROUP, onChange }} />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Group by Status" }).disabled).toBe(false);
  });

  it("closes the + and Rename popovers when the page holds the tabs", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    const page = render(<Frame views={views} />);
    await user.click(addView());
    page.rerender(<Frame views={views} tabsDisabled />);
    expect(screen.queryByRole("dialog")).toBeNull();
    page.rerender(<Frame views={views} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("dialog", { name: "Rename All tasks" })).toBeTruthy();
    page.rerender(<Frame views={views} tabsDisabled />);
    expect(screen.queryByRole("dialog")).toBeNull();
    page.rerender(<Frame views={views} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(views.create).not.toHaveBeenCalled();
    expect(views.rename).not.toHaveBeenCalled();
  });

  it("keeps a popover whose view is saving while the page holds the tabs, for its answer", async () => {
    const user = userEvent.setup();
    const saving = deferred<string | null>();
    const views = savedViews({ create: vi.fn(() => saving.promise) });
    const page = render(<Frame views={views} />);
    await user.click(addView());
    await user.click(screen.getByRole("button", { name: "Create view" }));
    page.rerender(<Frame views={views} tabsDisabled />);
    expect(screen.getByRole("dialog", { name: "Add a view" })).toBeTruthy();
    saving.resolve("dohc could not save this view. The saved views changed elsewhere. Try again.");
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Add a view" })).getByRole("alert").textContent)
      .toBe("dohc could not save this view. The saved views changed elsewhere. Try again."));
    // The answer shows, and nothing more saves until the page frees the tabs.
    const create = () => screen.getByRole<HTMLButtonElement>("button", { name: "Create view" });
    expect(create().disabled).toBe(true);
    fireEvent.submit(create().closest("form")!);
    expect(views.create).toHaveBeenCalledTimes(1);
    page.rerender(<Frame views={views} />);
    expect(create().disabled).toBe(false);
  });

  it("closes a tab's menu and the popovers when the person can no longer save views", async () => {
    const user = userEvent.setup();
    const views = savedViews();
    const page = render(<Frame views={views} />);
    fireEvent.contextMenu(tab("Schedule"));
    expect(screen.getByRole("menu", { name: "View actions" })).toBeTruthy();
    page.rerender(<Frame />);
    expect(screen.queryByRole("menu")).toBeNull();
    page.rerender(<Frame views={views} />);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(addView());
    page.rerender(<Frame />);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Saving views again does not bring the popover back.
    page.rerender(<Frame views={views} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    page.rerender(<Frame />);
    page.rerender(<Frame views={views} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the toolbar", () => {
  it("searches on Enter and on the Search button, within 200 characters", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Searching() {
      const [value, setValue] = useState("");
      return <Frame search={{ value, onChange: setValue, onSubmit }} />;
    }
    render(<Searching />);
    const box = screen.getByLabelText<HTMLInputElement>("Search collection");
    expect(box.maxLength).toBe(200);
    await user.type(box, "camera{Enter}");
    expect(box.value).toBe("camera");
    expect(onSubmit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("shows no search for a page that has none, and holds one that is disabled", () => {
    const first = render(<Frame />);
    expect(screen.queryByLabelText("Search collection")).toBeNull();
    first.unmount();
    render(<Frame search={{ value: "", onChange: vi.fn(), onSubmit: vi.fn(), disabled: true }} />);
    expect(screen.getByLabelText<HTMLInputElement>("Search collection").disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Search" }).disabled).toBe(true);
  });

  it("puts the page's own buttons before New record, which is last and reports its button", async () => {
    const undo = vi.fn(), finish = vi.fn(), create = vi.fn();
    render(<Frame
      actions={[{ id: "undo", label: "Undo last edit", onClick: undo }, { id: "finish", label: "Finish", onClick: finish, disabled: true }]}
      newRecord={{ onClick: create }}
    />);
    const toolbar = screen.getByTestId("collection-new-record").parentElement!;
    expect(within(toolbar).getAllByRole("button").map((button) => button.textContent || button.getAttribute("aria-label")))
      .toEqual(["Undo last edit", "Finish", "Collection actions", "New record"]);
    await userEvent.click(screen.getByRole("button", { name: "Undo last edit" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Finish" }).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("collection-new-record"));
    expect(create).toHaveBeenCalledExactlyOnceWith(screen.getByTestId("collection-new-record"));
  });

  it("leaves New record out where a person cannot add one, and holds it while the page says so", () => {
    const first = render(<Frame />);
    expect(screen.queryByTestId("collection-new-record")).toBeNull();
    first.unmount();
    render(<Frame newRecord={{ onClick: vi.fn(), disabled: true }} />);
    expect(screen.getByTestId<HTMLButtonElement>("collection-new-record").disabled).toBe(true);
  });

  it.each([
    { count: 0, open: false, shown: false },
    { count: 2, open: false, shown: true },
    { count: 0, open: true, shown: true },
  ])("shows the Automations button when the Collection has automations or its panel is open ($count, open: $open)", async ({ count, open, shown }) => {
    const onToggle = vi.fn();
    render(<Frame automations={{ count, open, onToggle }} />);
    const button = screen.queryByTestId("collection-automations-button");
    expect(button !== null).toBe(shown);
    if (!button) return;
    expect(button.getAttribute("aria-pressed")).toBe(String(open));
    expect(button.textContent).toBe(count > 0 ? `Automations${count}` : "Automations");
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("the actions menu", () => {
  const run = vi.fn(), blocked = vi.fn();
  const sections: CollectionFrameMenuSection[] = [
    { label: "View", commands: [
      { id: "fields", label: "Fields", testId: "collection-fields-button", onSelect: run },
      false,
      { id: "refresh", label: "Refresh", onSelect: blocked, disabled: true, reason: "Save or cancel the open form first." },
    ] },
    { label: "Sharing", commands: [null, undefined, false] },
    { label: "Collection", commands: [
      { id: "automations", label: "Automations", count: 3, onSelect: run },
      { id: "archive", label: "Archive", onSelect: run },
    ] },
  ];

  it("groups the commands a person has under section labels, and leaves out an empty section", async () => {
    render(<Frame menu={sections} menuLabel="Manage Collection" />);
    await userEvent.click(screen.getByRole("button", { name: "Manage Collection" }));
    const menu = screen.getByRole("menu", { name: "Manage Collection" });
    expect(within(menu).getAllByRole("group").map((group) => [
      document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent,
      within(group).getAllByRole("menuitem").map((item) => item.textContent),
    ])).toEqual([
      ["View", ["Fields", "RefreshSave or cancel the open form first."]],
      ["Collection", ["Automations3", "Archive"]],
    ]);
    expect(within(menu).getByTestId("collection-fields-button")).toBe(within(menu).getByRole("menuitem", { name: "Fields" }));
  });

  it("says why a disabled command cannot run, and does not run it", async () => {
    render(<Frame menu={sections} />);
    await userEvent.click(screen.getByRole("button", { name: "Collection actions" }));
    const refresh = screen.getByRole("menuitem", { name: "Refresh" });
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(refresh.getAttribute("aria-describedby")!)!.textContent).toBe("Save or cancel the open form first.");
    await userEvent.click(refresh);
    expect(blocked).not.toHaveBeenCalled();
  });

  it("works from the keyboard: arrows move, Enter runs, and Escape returns focus to the button", async () => {
    const user = userEvent.setup();
    render(<Frame menu={sections} />);
    const trigger = screen.getByRole("button", { name: "Collection actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Fields" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Archive" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("shows no menu button when a person has no command", () => {
    render(<Frame menu={[{ label: "View", commands: [false] }]} />);
    expect(screen.queryByRole("button", { name: "Collection actions" })).toBeNull();
  });
});

describe("what the frame draws again", () => {
  it("leaves the page's view alone when a menu or a popover opens", async () => {
    const user = userEvent.setup();
    const drawn = vi.fn();
    function View() {
      drawn();
      return <p>Records</p>;
    }
    const view = <View />;
    render(<CollectionFrame name="Launch tracker" tabs={TABS} activeTabId="all" onSelectTab={vi.fn()} views={savedViews()} menuLabel="Collection actions" menu={MENU}>{view}</CollectionFrame>);
    expect(drawn).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Collection actions" }));
    await user.keyboard("{ArrowDown}{Escape}");
    await user.click(screen.getByRole("button", { name: "View actions" }));
    await user.keyboard("{Escape}");
    await user.click(addView());
    await user.click(screen.getByRole("radio", { name: "Board" }));
    await user.hover(tab("By status"));
    expect(drawn).toHaveBeenCalledOnce();
  });

  it("docks the page's panel at the right of its view", () => {
    render(<Frame panel={<aside>Automations panel</aside>} />);
    const panel = screen.getByText("Automations panel");
    expect(panel.previousElementSibling?.contains(screen.getByText("Records"))).toBe(true);
    expect(screen.getByRole("region", { name: "Launch tracker" }).contains(panel)).toBe(true);
  });
});
