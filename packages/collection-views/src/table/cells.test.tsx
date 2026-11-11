// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_VALUE_REASON_CODES } from "@dohc/workspace-contracts";
import type { CollectionValue, FieldDefinition } from "@dohc/workspace-contracts";
import type { CollectionQueryExecutor } from "../store";
import type { CarriedSelection } from "../useAcknowledgedSelection";
import { CellEditor, FieldCell, fieldDisplayText, FLAGGED_REASON_TITLES } from "./cells";
import {
  V1_FIELDS,
  flaggedValue,
  indexedValue,
  makeQueryResult,
  makeRecord,
} from "../testSupport";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const option = (name: string | RegExp) => screen.getByRole("option", { name });
const picked = (name: string) => option(name).getAttribute("aria-selected") === "true";
const search = () => screen.getByRole<HTMLInputElement>("combobox");
/** The option the search box's keys act on. */
const highlighted = () => document.getElementById(search().getAttribute("aria-activedescendant") ?? "")?.textContent;
/**
 * Picks or removes a tag, then saves as closing the picker does. These tests
 * mock `close`, so the picker stays mounted the way a second edit finds the
 * cell: the first save is not in the index yet.
 */
function setTag(name: string) {
  fireEvent.click(option(name));
  fireEvent.keyDown(search(), { key: "Tab" });
}

it.each(["relation", "multi-select"] as const)("keeps a later %s write intact when an earlier write is discarded", async (kind) => {
  let nextId = 0;
  let discard!: (writeId: number) => void;
  const emit = vi.fn((_value: CollectionValue, _previous?: readonly CollectionValue[]) => ++nextId);
  const selectionField: FieldDefinition = kind === "relation"
    ? { name: "links", type: "relation", collection: "tasks", many: true }
    : field("tags");
  const names = kind === "relation" ? ["a", "b", "c"] : ["alpha", "beta", "gamma"];
  const executor = vi.fn(async () => makeQueryResult(names.map(id => makeRecord(id, [indexedValue("title", id)]))));
  const editor = (value: string[], acknowledgedWriteId = 0) => <CellEditor
    field={selectionField} indexed={indexedValue(selectionField.name, value)} acknowledgedWriteId={acknowledgedWriteId}
    subscribeToDiscardedWrites={listener => { discard = listener; return () => {}; }}
    emit={emit} close={() => {}} relationExecutor={executor} />;
  const toggle = async (name: string) =>
    kind === "relation" ? fireEvent.click(await screen.findByRole("checkbox", { name })) : setTag(name);
  const chosen = (name: string) =>
    kind === "relation" ? screen.getByRole<HTMLInputElement>("checkbox", { name }).checked : picked(name);
  const view = render(editor([]));
  await toggle(names[0]!);
  await toggle(names[1]!);
  expect(emit.mock.calls[1]?.[0]).toEqual(names.slice(0, 2));
  // The queue retains failed write 1 while the full value of write 2 waits.
  act(() => discard(1));
  expect(chosen(names[0]!)).toBe(true);
  // An external selection must still survive replay of the remaining write.
  view.rerender(editor([names[2]!]));
  expect(chosen(names[2]!)).toBe(true);
  await toggle(names[2]!);
  expect(emit.mock.calls.at(-1)?.[0]).toEqual(names.slice(0, 2));
  view.rerender(editor(names.slice(0, 2), 2));
  expect(chosen(names[0]!)).toBe(true);
  expect(chosen(names[1]!)).toBe(true);
});

it("keeps later relation choices across partial acknowledgments", async () => {
  let nextId = 0;
  const emit = vi.fn((_value: CollectionValue, _previous?: readonly CollectionValue[]) => ++nextId);
  const relation: FieldDefinition = { name: "links", type: "relation", collection: "tasks", many: true };
  const executor = vi.fn(async () => makeQueryResult(["a", "b", "c"].map(id => makeRecord(id, [indexedValue("title", id)]))));
  const editor = (value: string[], acknowledgedWriteId: number) => <CellEditor
    field={relation} indexed={indexedValue("links", value)} acknowledgedWriteId={acknowledgedWriteId}
    emit={emit} close={() => {}} relationExecutor={executor} />;
  const { rerender } = render(editor([], 0));
  fireEvent.click(await screen.findByRole("checkbox", { name: "a" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "b" }));
  rerender(editor(["a"], 1));
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "b" }).checked).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "c" }));
  expect(emit.mock.calls.at(-1)?.[0]).toEqual(["a", "b", "c"]);
});

it("keeps a later removal after discarding its predecessor and retires it on discard", () => {
  let discard!: (writeId: number) => void;
  const emit = writeEmitter();
  const editor = (value: string[]) => <CellEditor
    field={field("tags")} indexed={indexedValue("tags", value)} acknowledgedWriteId={0}
    subscribeToDiscardedWrites={listener => { discard = listener; return () => {}; }}
    emit={emit} close={() => {}} />;
  const view = render(editor(["alpha", "beta"]));
  setTag("alpha");
  setTag("gamma");
  expect(emit.mock.calls.at(-1)?.[0]).toEqual(["beta", "gamma"]);
  act(() => discard(1));
  expect(picked("alpha")).toBe(false);
  view.rerender(editor(["alpha"]));
  expect(picked("beta")).toBe(false);
  expect(picked("gamma")).toBe(true);
  act(() => discard(2));
  expect(picked("alpha")).toBe(true);
  expect(picked("gamma")).toBe(false);
});

function field(name: string): FieldDefinition {
  const match = V1_FIELDS.find((entry) => entry.name === name);
  if (!match) throw new Error(`no test field named ${name}`);
  return match;
}

describe("FieldCell display", () => {
  it("renders a text value", () => {
    render(<FieldCell field={field("title")} indexed={indexedValue("title", "Ship it")} />);
    expect(screen.getByText("Ship it")).toBeDefined();
  });

  it("renders number and bigint values", () => {
    const { rerender } = render(
      <FieldCell field={field("estimate")} indexed={indexedValue("estimate", 3.5)} />,
    );
    expect(screen.getByText("3.5")).toBeDefined();
    rerender(
      <FieldCell field={field("estimate")} indexed={indexedValue("estimate", 9007199254740993n)} />,
    );
    expect(screen.getByText("9007199254740993")).toBeDefined();
  });

  it("renders a checkbox, disabled when read-only", () => {
    render(<FieldCell field={field("done")} indexed={indexedValue("done", true)} />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox");
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
  });

  it("renders a date as people read it", () => {
    render(<FieldCell field={field("due")} indexed={indexedValue("due", "2024-09-15")} />);
    expect(screen.getByText("Sep 15, 2024")).toBeDefined();
  });

  it("renders a select value as a pill in its chosen color", () => {
    const status: FieldDefinition = { name: "status", type: "select", options: ["todo", "doing"], colors: { doing: "amber" } };
    render(<FieldCell field={status} indexed={indexedValue("status", "doing")} />);
    expect(screen.getByText("doing").parentElement?.dataset.optionColor).toBe("amber");
  });

  it("renders multi-select values as one pill each, colored by name without a choice", () => {
    render(<FieldCell field={field("tags")} indexed={indexedValue("tags", ["alpha", "gamma"])} />);
    const alpha = screen.getByText("alpha").parentElement?.dataset.optionColor;
    expect(alpha).toBeDefined();
    expect(screen.getByText("gamma").parentElement?.dataset.optionColor).toBeDefined();
    cleanup();
    // The same name keeps its color in another field, so reordering never recolors it.
    const other: FieldDefinition = { name: "labels", type: "multi-select", options: ["zeta", "alpha"] };
    render(<FieldCell field={other} indexed={indexedValue("labels", ["alpha"])} />);
    expect(screen.getByText("alpha").parentElement?.dataset.optionColor).toBe(alpha);
  });

  it("renders a person through personLabel and falls back to the id", () => {
    const { rerender } = render(
      <FieldCell
        field={field("owner")}
        indexed={indexedValue("owner", "user-7")}
        personLabel={(id) => (id === "user-7" ? "Ada" : null)}
      />,
    );
    expect(screen.getByText("Ada")).toBeDefined();
    rerender(<FieldCell field={field("owner")} indexed={indexedValue("owner", "user-9")} />);
    expect(screen.getByText("user-9")).toBeDefined();
  });

  it("renders relation labels from resolved relations, ids otherwise", () => {
    const { rerender } = render(
      <FieldCell
        field={field("blocks")}
        indexed={indexedValue("blocks", ["rec-a", "rec-b"], {
          resolvedRelations: [
            { recordId: "rec-a", label: "Design" },
            { recordId: "rec-b", label: "Build" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Design, Build")).toBeDefined();
    rerender(<FieldCell field={field("blocks")} indexed={indexedValue("blocks", ["rec-a"])} />);
    expect(screen.getByText("rec-a")).toBeDefined();
  });

  it("renders a url value", () => {
    render(<FieldCell field={field("link")} indexed={indexedValue("link", "https://dohc.dev")} />);
    expect(screen.getByText("https://dohc.dev")).toBeDefined();
  });

  it("shows a button field's name and never a value kept under it", () => {
    const button: FieldDefinition = { name: "Mark paid", type: "button" };
    const stray = flaggedValue("Mark paid", true, "expected-empty");
    const { container } = render(
      <FieldCell field={button} indexed={stray} editable />,
    );
    expect(screen.getByText("Mark paid")).toBeDefined();
    expect(screen.queryByText("true")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[data-flagged='true']")?.getAttribute("title")).toBe(
      FLAGGED_REASON_TITLES["expected-empty"],
    );
    expect(fieldDisplayText(button, stray)).toBe("");
  });

  it("marks a flagged value and leaves valid and untyped values unmarked", () => {
    const { container, rerender } = render(
      <FieldCell
        field={field("estimate")}
        indexed={indexedValue("estimate", "not a number", {
          validation: { status: "flagged", reason: { code: "expected-number", path: "estimate" } },
        })}
      />,
    );
    const flagged = container.querySelector("[data-flagged='true']");
    expect(flagged).not.toBeNull();
    expect(flagged?.getAttribute("title")).toBe(
      "This value is not a number. Edit the value to replace it.",
    );

    rerender(<FieldCell field={field("estimate")} indexed={indexedValue("estimate", 2)} />);
    expect(container.querySelector("[data-flagged='true']")).toBeNull();
    rerender(
      <FieldCell
        field={field("estimate")}
        indexed={indexedValue("estimate", 2, { validation: { status: "untyped" } })}
      />,
    );
    expect(container.querySelector("[data-flagged='true']")).toBeNull();
  });

  it("shows each reason's line as the flagged cell's hover title", () => {
    for (const code of FIELD_VALUE_REASON_CODES) {
      const { container, unmount } = render(
        <FieldCell
          field={field("title")}
          indexed={indexedValue("title", "raw", {
            validation: { status: "flagged", reason: { code, path: "" } },
          })}
        />,
      );
      const flagged = container.querySelector("[data-flagged='true']");
      expect(flagged?.getAttribute("title")).toBe(FLAGGED_REASON_TITLES[code]);
      unmount();
    }
  });
});

describe("FieldCell editing", () => {
  it("draws an editable value as a button that Tab skips", () => {
    render(<FieldCell field={field("title")} indexed={indexedValue("title", "Ship it")} editable />);
    expect(screen.getByRole("button", { name: "Ship it" }).tabIndex).toBe(-1);
  });

  it("names a checkbox and a button by the field's label, not its key", () => {
    const { rerender } = render(
      <FieldCell field={{ name: "f-3", type: "checkbox" }} label="Shipped" indexed={indexedValue("f-3", true)} />,
    );
    expect(screen.getByRole("checkbox", { name: "Shipped" })).toBeDefined();
    rerender(<FieldCell field={{ name: "f-4", type: "button" }} label="Mark paid" indexed={undefined} />);
    expect(screen.getByText("Mark paid")).toBeDefined();
    expect(screen.queryByText("f-4")).toBeNull();
  });

  it("renders no edit button unless editable", () => {
    render(<FieldCell field={field("title")} indexed={indexedValue("title", "Ship it")} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens a filled url from its text, and leaves the rest of the cell to edit it", () => {
    const onOpenLink = vi.fn();
    const onCellClick = vi.fn();
    const link = indexedValue("link", "https://dohc.dev");
    const view = render(
      <div onClick={onCellClick}>
        <FieldCell field={field("link")} indexed={link} editable onOpenLink={onOpenLink} />
      </div>,
    );
    fireEvent.click(screen.getByRole("link", { name: "https://dohc.dev" }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://dohc.dev");
    // The table edits a cell from a click that reaches it. The link's click does not.
    expect(onCellClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit link" }));
    expect(onCellClick).toHaveBeenCalledOnce();
    expect(onOpenLink).toHaveBeenCalledOnce();

    // A cell nobody can edit still opens its link.
    view.rerender(<FieldCell field={field("link")} indexed={link} onOpenLink={onOpenLink} />);
    expect(screen.getByRole("link")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no link without a way to open one, for an empty url, or for a value that is not a url", () => {
    const onOpenLink = vi.fn();
    const view = render(<FieldCell field={field("link")} indexed={indexedValue("link", "https://dohc.dev")} editable />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "https://dohc.dev" })).toBeDefined();
    view.rerender(<FieldCell field={field("link")} indexed={undefined} editable onOpenLink={onOpenLink} />);
    expect(screen.queryByRole("link")).toBeNull();
    view.rerender(
      <FieldCell field={field("link")} indexed={flaggedValue("link", "not a url", "invalid-url")} editable onOpenLink={onOpenLink} />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    view.rerender(<FieldCell field={field("title")} indexed={indexedValue("title", "https://dohc.dev")} editable onOpenLink={onOpenLink} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("toggles a checkbox directly", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("done")} indexed={indexedValue("done", false)} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });
});

function writeEmitter() {
  let writeId = 0;
  return vi.fn((_value: CollectionValue, _previousValues?: readonly CollectionValue[]) => ++writeId);
}

interface EditorCase {
  fieldName: string;
  value: CollectionValue;
  typed?: string;
  emit?: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
  close?: (to?: string) => void;
  onCreateOption?: (option: string, nextValue: CollectionValue) => void;
  onOptionColorChange?: (option: string, color: string) => void;
  people?: ReadonlyArray<{ id: string; name: string }>;
  relationExecutor?: CollectionQueryExecutor;
  carried?: CarriedSelection;
}

function renderEditor({ fieldName, value, emit, close, ...rest }: EditorCase) {
  return render(
    <CellEditor
      acknowledgedWriteId={0}
      field={field(fieldName)}
      indexed={value === null ? undefined : indexedValue(fieldName, value)}
      emit={emit ?? writeEmitter()}
      close={close ?? vi.fn()}
      {...rest}
    />,
  );
}

describe("CellEditor", () => {
  it("commits a text edit on Enter and closes", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("New title");
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves an Enter or Escape that an input method owns to the composition", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "旅" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(emit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("commits an emptied text edit as null", () => {
    const emit = writeEmitter();
    renderEditor({ fieldName: "title", value: "Old", emit });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("cancels a text edit on Escape without an event", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("parses a number edit, and saves an emptied one as null", () => {
    const emit = writeEmitter();
    const { unmount } = renderEditor({ fieldName: "estimate", value: 1, emit });
    const input = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(input, { target: { value: "42.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(42.5);
    unmount();

    emit.mockClear();
    renderEditor({ fieldName: "estimate", value: 1, emit });
    const second = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(second, { target: { value: "  " } });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps a number that does not parse open, says what to do, and saves nothing", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "estimate", value: 1, emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("1");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(input, { target: { value: "twelve" } });
    for (const leave of [
      () => fireEvent.keyDown(input, { key: "Enter" }),
      () => fireEvent.keyDown(input, { key: "Tab" }),
      () => fireEvent.blur(input),
    ]) {
      leave();
      expect(emit).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    }
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("This value is not a number. Enter a number.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(input.hasAttribute("data-unsaved")).toBe(true);

    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(12);
    expect(close).toHaveBeenCalledExactlyOnceWith("down");
  });

  it("cancels a number that does not parse on Escape", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "estimate", value: 1, emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(input, { target: { value: "twelve" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    // Closing blurs the input. A cancelled edit must not save on that blur.
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ["Enter", false, "down"],
    ["Tab", false, "next"],
    ["Tab", true, "previous"],
  ] as const)("saves once on %s (shift %s) and moves the selection %s", (key, shiftKey, move) => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "New" } });
    // fireEvent returns false when the handler prevented the key's default.
    expect(fireEvent.keyDown(input, { key, shiftKey })).toBe(key !== "Tab");
    // The blur that closing causes must not save the edit a second time.
    fireEvent.blur(input);
    expect(emit).toHaveBeenCalledExactlyOnceWith("New");
    expect(close).toHaveBeenCalledExactlyOnceWith(move);
  });

  it("saves once on blur, without moving the selection", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.blur(input);
    fireEvent.blur(input);
    expect(emit).toHaveBeenCalledExactlyOnceWith("New");
    expect(close).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each(["title", "estimate", "owner", "link"])("starts a %s edit from the typed character, with the caret after it", (fieldName) => {
    const emit = writeEmitter();
    render(
      <CellEditor acknowledgedWriteId={0} field={field(fieldName)} typed="7"
        indexed={indexedValue(fieldName, fieldName === "estimate" ? 1 : "Old")} emit={emit} close={vi.fn()} />,
    );
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("7");
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(fieldName === "estimate" ? 7 : "7");
  });

  it("compounds multi-select saves before any refresh lands", () => {
    // Starting at ["alpha"], adding beta then removing alpha must retain beta.
    // The indexed prop still says ["alpha"] (the host's re-query has not
    // landed), so deriving the second edit from props would save [] and erase beta.
    const emit = writeEmitter();
    renderEditor({ fieldName: "tags", value: ["alpha"], emit });
    setTag("beta");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha", "beta"]);
    setTag("alpha");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["beta"]);
  });

  it("retires only the discarded save while earlier unindexed input remains", () => {
    const emit = writeEmitter();
    let discard!: (writeId: number) => void;
    const unsubscribe = vi.fn();
    const view = render(<CellEditor
      field={field("tags")}
      indexed={indexedValue("tags", ["alpha"])}
      acknowledgedWriteId={0}
      subscribeToDiscardedWrites={(listener) => { discard = listener; return unsubscribe; }}
      emit={emit}
      close={vi.fn()}
    />);
    setTag("beta");
    setTag("gamma");
    act(() => discard(2));
    expect(picked("beta")).toBe(true);
    expect(picked("gamma")).toBe(false);
    setTag("alpha");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["beta"]);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps the current multi-select selection when a delayed prop refresh repeats a stale value", () => {
    const emit = writeEmitter();
    const view = render(
      <CellEditor
        field={field("tags")}
        indexed={indexedValue("tags", ["alpha"])}
        acknowledgedWriteId={0}
        emit={emit}
        close={vi.fn()}
      />,
    );
    setTag("beta");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha", "beta"]);

    // A slow index read re-serves ["alpha"] after the beta save. The picker
    // owns the selection; the stale prop must not erase beta.
    view.rerender(
      <CellEditor
        field={field("tags")}
        indexed={indexedValue("tags", ["alpha"])}
        acknowledgedWriteId={0}
        emit={emit}
        close={vi.fn()}
      />,
    );
    expect(picked("beta")).toBe(true);
    setTag("gamma");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("includes an observed remote selection in the next multi-select edit", () => {
    const emit = writeEmitter();
    const editor = (value: string[]) => (
      <CellEditor acknowledgedWriteId={0} field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha"]));

    view.rerender(editor(["alpha", "beta"]));
    expect(picked("beta")).toBe(true);
    setTag("gamma");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps a remote change that arrives between a pick and the save", () => {
    const emit = writeEmitter();
    const editor = (value: string[]) => (
      <CellEditor acknowledgedWriteId={0} field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha"]));
    fireEvent.click(option("gamma"));
    // Someone else adds beta while the picker is open, with gamma picked and not saved.
    view.rerender(editor(["alpha", "beta"]));
    expect([picked("beta"), picked("gamma")]).toEqual([true, true]);
    fireEvent.keyDown(search(), { key: "Tab" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(["alpha", "beta", "gamma"], [["alpha", "beta"]]);
  });

  it("combines observed remote additions with a pending local removal", () => {
    const emit = writeEmitter();
    const editor = (value: string[]) => (
      <CellEditor acknowledgedWriteId={0} field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha", "beta"]));
    setTag("alpha");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["beta"]);

    view.rerender(editor(["alpha", "beta", "gamma"]));
    expect(picked("alpha")).toBe(false);
    expect(picked("gamma")).toBe(true);
    setTag("beta");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["gamma"]);
  });

  it("combines observed remote removals with a pending local addition", () => {
    const emit = writeEmitter();
    const editor = (value: string[]) => (
      <CellEditor acknowledgedWriteId={0} field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha", "beta"]));
    setTag("gamma");

    view.rerender(editor(["beta"]));
    expect(picked("alpha")).toBe(false);
    expect(picked("gamma")).toBe(true);
    setTag("beta");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["gamma"]);
  });

  it("acknowledges earlier saves without undoing a later save of the same option", () => {
    const emit = writeEmitter();
    const editor = (value: string[], acknowledgedWriteId = 0) => (
      <CellEditor acknowledgedWriteId={acknowledgedWriteId} field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha"]));
    setTag("beta");
    setTag("beta");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha"]);

    view.rerender(editor(["alpha", "beta"], 1));
    expect(picked("beta")).toBe(false);
    view.rerender(editor(["alpha"], 2));
    view.rerender(editor(["alpha", "beta"], 2));
    expect(picked("beta")).toBe(true);
    setTag("gamma");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("retires a completed round trip even when the acknowledged indexed value is unchanged", () => {
    const emit = writeEmitter();
    const editor = (value: string[], acknowledgedWriteId: number) => (
      <CellEditor
        field={field("tags")}
        indexed={indexedValue("tags", value)}
        acknowledgedWriteId={acknowledgedWriteId}
        emit={emit}
        close={vi.fn()}
      />
    );
    const view = render(editor(["alpha"], 0));
    setTag("beta");
    setTag("beta");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha"]);

    // Both writes finish before one coalesced index query returns.
    view.rerender(editor(["alpha"], 2));
    // A later external addition must not match and revive the retired add.
    view.rerender(editor(["alpha", "beta"], 2));
    expect(picked("beta")).toBe(true);
    setTag("gamma");
    expect(emit.mock.calls.at(-1)?.[0]).toEqual(["alpha", "beta", "gamma"]);
  });

  it("supplies every pending predecessor before a third rapid multi-select save", () => {
    const emit = writeEmitter();
    renderEditor({ fieldName: "tags", value: ["alpha"], emit });
    setTag("beta");
    setTag("gamma");
    setTag("alpha");
    expect(emit).toHaveBeenLastCalledWith(
      ["beta", "gamma"],
      [["alpha"], ["alpha", "beta"], ["alpha", "beta", "gamma"]],
    );
  });

  it("rebases pending predecessor values on newly observed remote props", () => {
    const emit = writeEmitter();
    const editor = (value: string[]) => (
      <CellEditor acknowledgedWriteId={0} field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha"]));
    setTag("beta");
    view.rerender(editor(["alpha", "gamma"]));
    setTag("alpha");
    expect(emit).toHaveBeenLastCalledWith(
      ["gamma", "beta"],
      [["alpha", "gamma"], ["alpha", "gamma", "beta"]],
    );
  });

  it("keeps the raw malformed indexed value as the base of a repair", () => {
    const emit = writeEmitter();
    renderEditor({ fieldName: "tags", value: "malformed", emit });
    setTag("alpha");
    expect(emit).toHaveBeenLastCalledWith(["malformed", "alpha"], ["malformed"]);
  });

  it("opens the relation picker against the related collection and emits ids", async () => {
    const emit = writeEmitter();
    const executor = vi.fn(async () =>
      makeQueryResult([
        makeRecord("rec-a", [indexedValue("title", "Design")]),
        makeRecord("rec-b", [indexedValue("title", "Build")]),
      ]),
    );
    renderEditor({
      fieldName: "blocks",
      value: ["rec-a"],
      emit,
      relationExecutor: executor,
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Build" }));
    expect(executor).toHaveBeenCalledExactlyOnceWith({
      collectionPath: "tasks",
      limit: 100,
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith(["rec-a", "rec-b"], [["rec-a"]]);
  });

  it("edits a person as a typed id when the host lists no people", () => {
    renderEditor({ fieldName: "owner", value: "user-7" });
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("user-7");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("trims a person edit and commits a whitespace-only one as null", () => {
    const emit = writeEmitter();
    const { unmount } = renderEditor({ fieldName: "owner", value: "user-7", emit });
    const input = screen.getByDisplayValue<HTMLInputElement>("user-7");
    fireEvent.change(input, { target: { value: "  user-9  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("user-9");
    unmount();

    emit.mockClear();
    renderEditor({ fieldName: "owner", value: "user-7", emit });
    const second = screen.getByDisplayValue<HTMLInputElement>("user-7");
    fireEvent.change(second, { target: { value: "   " } });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe("option picker", () => {
  const colored: FieldDefinition = {
    name: "status",
    type: "select",
    options: ["todo", "doing", "shipped"],
    colors: { todo: "teal" },
  };
  const options = () => screen.getAllByRole("option").map((row) => row.textContent);

  it("lists the options as pills, with a check on the current one and Clear at the end", () => {
    renderEditor({ fieldName: "status", value: "doing" });
    expect(options()).toEqual(["todo", "doing", "shipped", "Clear"]);
    expect(option("doing").querySelector("[data-option-color]")).not.toBeNull();
    expect([picked("todo"), picked("doing")]).toEqual([false, true]);
    expect(screen.getByRole("listbox", { name: "status options" }).hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("saves a picked option and closes, keeping the selection where it is", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "status", value: "todo", emit, close });
    fireEvent.click(option("shipped"));
    expect(emit).toHaveBeenCalledExactlyOnceWith("shipped");
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it("clears the value from the Clear row, which an empty cell and a search do not show", () => {
    const emit = writeEmitter();
    const view = renderEditor({ fieldName: "status", value: "todo", emit });
    fireEvent.change(search(), { target: { value: "o" } });
    expect(options()).toEqual(["todo", "doing"]);
    fireEvent.change(search(), { target: { value: "" } });
    fireEvent.click(option("Clear"));
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
    view.unmount();
    renderEditor({ fieldName: "status", value: null });
    expect(options()).toEqual(["todo", "doing", "shipped"]);
  });

  it("filters as a person types, and says when nothing matches", () => {
    renderEditor({ fieldName: "status", value: "todo" });
    fireEvent.change(search(), { target: { value: " SHIP " } });
    expect(options()).toEqual(["shipped"]);
    fireEvent.change(search(), { target: { value: "later" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText('No options match "later".')).toBeDefined();
  });

  it("starts the search from the character that opened the picker", () => {
    renderEditor({ fieldName: "status", value: "todo", typed: "s" });
    expect(search().value).toBe("s");
    expect(options()).toEqual(["shipped"]);
  });

  it("moves a highlight with the arrow keys and picks it with Enter", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "status", value: "todo", emit, close });
    expect(document.activeElement).toBe(search());
    // The highlight starts on the current value, so Enter alone changes nothing.
    expect(highlighted()).toBe("todo");
    expect(fireEvent.keyDown(search(), { key: "ArrowDown" })).toBe(false);
    expect(highlighted()).toBe("doing");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    // Past the first row the highlight wraps to the last.
    expect(highlighted()).toBe("Clear");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(highlighted()).toBe("shipped");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("shipped");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes without saving when Enter picks the value the cell already has", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "status", value: "doing", emit, close });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("highlights the first match of a search, and leaves an input method's Enter alone", () => {
    const emit = writeEmitter();
    renderEditor({ fieldName: "status", value: "shipped", emit });
    expect(highlighted()).toBe("shipped");
    fireEvent.change(search(), { target: { value: "o" } });
    expect(highlighted()).toBe("todo");
    fireEvent.keyDown(search(), { key: "Enter", isComposing: true });
    expect(emit).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("todo");
  });

  it("offers to create a typed name the options do not have, and creates it with Enter or a click", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    const onCreateOption = vi.fn();
    const view = renderEditor({ fieldName: "status", value: "todo", emit, close, onCreateOption });
    fireEvent.change(search(), { target: { value: " later " } });
    expect(options()).toEqual(["Create later"]);
    // The new option shows as the pill it will be.
    expect(option("Create later").querySelector("[data-option-color]")?.textContent).toBe("later");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("later", "later");
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    view.unmount();

    renderEditor({ fieldName: "status", value: "todo", onCreateOption });
    fireEvent.change(search(), { target: { value: "ship" } });
    // A partial match still offers the new name, after the option it matches.
    expect(options()).toEqual(["shipped", "Create ship"]);
    fireEvent.click(option("Create ship"));
    expect(onCreateOption).toHaveBeenLastCalledWith("ship", "ship");
  });

  it("picks an existing option typed in full instead of forking it", () => {
    const emit = writeEmitter();
    const onCreateOption = vi.fn();
    renderEditor({ fieldName: "status", value: "todo", emit, onCreateOption });
    fireEvent.change(search(), { target: { value: "shipped" } });
    expect(options()).toEqual(["shipped"]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("shipped");
    expect(onCreateOption).not.toHaveBeenCalled();
  });

  it("offers no Create row when the host cannot add options", () => {
    renderEditor({ fieldName: "status", value: "todo" });
    fireEvent.change(search(), { target: { value: "later" } });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("changes an option's color from its menu button, and shows no button when the host cannot save it", () => {
    const onOptionColorChange = vi.fn();
    const editor = (extra: { onOptionColorChange?: typeof onOptionColorChange }) => (
      <CellEditor acknowledgedWriteId={0} field={colored} indexed={indexedValue("status", "todo")} emit={writeEmitter()} close={vi.fn()} {...extra} />
    );
    const view = render(editor({}));
    expect(screen.queryByRole("button", { name: "todo options" })).toBeNull();
    view.rerender(editor({ onOptionColorChange }));

    const menu = screen.getByRole("button", { name: "todo options" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    const colors = screen.getByRole("radiogroup", { name: "Color for todo" });
    expect(colors.querySelector('[aria-checked="true"]')?.getAttribute("aria-label")).toBe("Teal");
    // Choosing the color it has changes nothing.
    fireEvent.click(screen.getByRole("radio", { name: "Teal" }));
    expect(onOptionColorChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("radiogroup")).toBeNull();

    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("radio", { name: "Amber" }));
    expect(onOptionColorChange).toHaveBeenCalledExactlyOnceWith("todo", "amber");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    // The picker stays open on the search box.
    expect(document.activeElement).toBe(search());
  });

  it("closes open colors with the first Escape in the search box, and the picker with the next", () => {
    const close = vi.fn();
    render(
      <CellEditor acknowledgedWriteId={0} field={colored} indexed={indexedValue("status", "todo")}
        emit={writeEmitter()} close={close} onOptionColorChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "doing options" }));
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it("opens the highlighted option's colors with the right arrow, and Escape closes only them", () => {
    const close = vi.fn();
    const onOptionColorChange = vi.fn();
    render(
      <CellEditor acknowledgedWriteId={0} field={colored} indexed={indexedValue("status", "todo")}
        emit={writeEmitter()} close={close} onOptionColorChange={onOptionColorChange} />,
    );
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    const teal = screen.getByRole("radio", { name: "Teal" });
    expect(document.activeElement).toBe(teal);
    fireEvent.keyDown(teal, { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search());
    // The right arrow moves the caret while it is inside the typed text.
    fireEvent.change(search(), { target: { value: "to" } });
    search().setSelectionRange(0, 0);
    expect(fireEvent.keyDown(search(), { key: "ArrowRight" })).toBe(true);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("cancels on Escape, and saves nothing on Tab or a press outside", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "status", value: "todo", emit, close });
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(close).toHaveBeenLastCalledWith();
    expect(fireEvent.keyDown(search(), { key: "Tab" })).toBe(false);
    expect(close).toHaveBeenLastCalledWith("next");
    fireEvent.keyDown(search(), { key: "Tab", shiftKey: true });
    expect(close).toHaveBeenLastCalledWith("previous");
    fireEvent.pointerDown(search());
    expect(close).toHaveBeenCalledTimes(3);
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenLastCalledWith("away");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("tags picker", () => {
  const chips = () => screen.getAllByRole("button", { name: /^Remove / }).map((chip) => chip.getAttribute("aria-label")?.slice(7));
  const tags = (value: string[], extra: Partial<EditorCase> = {}) => renderEditor({ fieldName: "tags", value, ...extra });

  it("shows the chosen tags as chips before the search box, over a list that allows many picks", () => {
    tags(["beta", "alpha"]);
    expect(chips()).toEqual(["beta", "alpha"]);
    expect(screen.getByRole("listbox", { name: "tags options" }).getAttribute("aria-multiselectable")).toBe("true");
    expect([picked("alpha"), picked("beta"), picked("gamma")]).toEqual([true, true, false]);
    expect(document.activeElement).toBe(search());
  });

  it("keeps picks in the picker until it closes, then saves once", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    tags(["alpha"], { emit, close });
    fireEvent.click(option("gamma"));
    fireEvent.click(option("beta"));
    // The picker stays open and shows the picks in the order they were made.
    expect(chips()).toEqual(["alpha", "gamma", "beta"]);
    expect(emit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(search(), { key: "Tab" })).toBe(false);
    expect(emit).toHaveBeenCalledExactlyOnceWith(["alpha", "gamma", "beta"], [["alpha"]]);
    expect(close).toHaveBeenCalledExactlyOnceWith("next");
  });

  it("saves once when a press outside closes it, and not for a press inside", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    tags(["alpha"], { emit, close });
    fireEvent.click(option("beta"));
    fireEvent.pointerDown(option("gamma"));
    fireEvent.pointerDown(search());
    expect(emit).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(emit).toHaveBeenCalledExactlyOnceWith(["alpha", "beta"], [["alpha"]]);
    expect(close).toHaveBeenCalledExactlyOnceWith("away");
  });

  it("drops the picks on Escape", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    tags(["alpha"], { emit, close });
    fireEvent.click(option("beta"));
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it("saves nothing when the picker closes with the tags it opened with", () => {
    const emit = writeEmitter();
    tags(["alpha"], { emit });
    fireEvent.click(option("beta"));
    fireEvent.click(option("beta"));
    fireEvent.keyDown(search(), { key: "Tab" });
    fireEvent.pointerDown(document.body);
    expect(emit).not.toHaveBeenCalled();
  });

  it("removes a tag from its chip, from its option, or with Backspace in the empty search box", () => {
    const emit = writeEmitter();
    tags(["alpha", "beta", "gamma"], { emit });
    fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
    expect(chips()).toEqual(["beta", "gamma"]);
    fireEvent.click(option("beta"));
    expect(chips()).toEqual(["gamma"]);

    // Backspace edits typed text first, and removes a chip only from an empty box.
    fireEvent.change(search(), { target: { value: "a" } });
    expect(fireEvent.keyDown(search(), { key: "Backspace" })).toBe(true);
    expect(chips()).toEqual(["gamma"]);
    fireEvent.change(search(), { target: { value: "" } });
    expect(fireEvent.keyDown(search(), { key: "Backspace" })).toBe(false);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    // With no chip left, Backspace has nothing to remove.
    fireEvent.keyDown(search(), { key: "Backspace" });

    fireEvent.keyDown(search(), { key: "Tab" });
    expect(emit).toHaveBeenCalledExactlyOnceWith([], [["alpha", "beta", "gamma"]]);
  });

  it("puts a tag picked again after the ones that stayed", () => {
    const emit = writeEmitter();
    tags(["alpha", "beta"], { emit });
    fireEvent.click(option("alpha"));
    fireEvent.click(option("alpha"));
    expect(chips()).toEqual(["beta", "alpha"]);
    fireEvent.keyDown(search(), { key: "Tab" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(["beta", "alpha"], [["alpha", "beta"]]);
  });

  it("picks the highlighted option with Enter, stays open, and clears the search", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    tags(["alpha"], { emit, close });
    fireEvent.change(search(), { target: { value: "ga" } });
    expect(highlighted()).toBe("gamma");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chips()).toEqual(["alpha", "gamma"]);
    expect(search().value).toBe("");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chips()).toEqual(["alpha", "gamma", "beta"]);
    expect(close).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("adds a created option to the picks, and saves it with them when the picker closes", () => {
    const emit = writeEmitter();
    const onCreateOption = vi.fn();
    tags(["alpha"], { emit, onCreateOption });
    fireEvent.click(option("beta"));
    fireEvent.change(search(), { target: { value: "delta" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chips()).toEqual(["alpha", "beta", "delta"]);
    // The new option joins the list, where a second pick removes it again.
    expect(picked("delta")).toBe(true);
    expect(onCreateOption).not.toHaveBeenCalled();

    fireEvent.keyDown(search(), { key: "Tab" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("delta", ["alpha", "beta", "delta"], [["alpha"]]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("saves through the plain edit when the created option was removed before closing", () => {
    const emit = writeEmitter();
    const onCreateOption = vi.fn();
    tags(["alpha"], { emit, onCreateOption });
    fireEvent.change(search(), { target: { value: "delta" } });
    fireEvent.click(option("Create delta"));
    fireEvent.click(option("beta"));
    fireEvent.click(screen.getByRole("button", { name: "Remove delta" }));
    expect(screen.queryByRole("option", { name: "delta" })).toBeNull();
    fireEvent.keyDown(search(), { key: "Tab" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(["alpha", "beta"], [["alpha"]]);
    expect(onCreateOption).not.toHaveBeenCalled();
  });

  it("adds one new option per edit, and says how to add the next", () => {
    const onCreateOption = vi.fn();
    tags(["alpha"], { onCreateOption });
    fireEvent.change(search(), { target: { value: "delta" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    fireEvent.change(search(), { target: { value: "epsilon" } });
    const held = option(/^Create epsilon/);
    expect(held.getAttribute("aria-disabled")).toBe("true");
    expect(held.textContent).toContain('Click away to save "delta" first.');
    // Enter has no row to pick, so the search text stays.
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chips()).toEqual(["alpha", "delta"]);
    expect(search().value).toBe("epsilon");
  });

  it("starts a second edit from the first when the cell reopens before the index shows it", () => {
    const emit = writeEmitter();
    const carried: CarriedSelection = { pending: [] };
    const first = tags(["alpha"], { emit, carried });
    setTag("beta");
    expect(emit).toHaveBeenLastCalledWith(["alpha", "beta"], [["alpha"]]);
    // The table unmounts the picker when it closes. The index still says ["alpha"].
    first.unmount();

    const second = tags(["alpha"], { emit, carried });
    expect(chips()).toEqual(["alpha", "beta"]);
    setTag("alpha");
    // Without the carried save this would be [], and beta would be lost.
    expect(emit).toHaveBeenLastCalledWith(["beta"], [["alpha"], ["alpha", "beta"]]);
    second.unmount();

    // Once the index shows both saves, the cell's value stands alone.
    render(
      <CellEditor acknowledgedWriteId={2} field={field("tags")} indexed={indexedValue("tags", ["beta"])}
        emit={emit} close={vi.fn()} carried={carried} />,
    );
    expect(chips()).toEqual(["beta"]);
    setTag("gamma");
    expect(emit).toHaveBeenLastCalledWith(["beta", "gamma"], [["beta"]]);
  });

  it("starts a second edit from a save that created an option, when the host returns its edit id", () => {
    const emit = writeEmitter();
    const onCreateOption = vi.fn(() => 7);
    const carried: CarriedSelection = { pending: [] };
    const first = tags(["alpha"], { emit, onCreateOption, carried });
    fireEvent.change(search(), { target: { value: "delta" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    fireEvent.keyDown(search(), { key: "Tab" });
    first.unmount();

    tags(["alpha"], { emit, carried });
    expect(chips()).toEqual(["alpha", "delta"]);
    setTag("beta");
    expect(emit).toHaveBeenCalledExactlyOnceWith(["alpha", "delta", "beta"], [["alpha"], ["alpha", "delta"]]);
  });
});

describe("date picker", () => {
  const day = (name: string) => screen.getByRole("gridcell", { name });
  const month = () => screen.getByRole("grid", { name: "due" });
  const cursor = () => document.getElementById(month().getAttribute("aria-activedescendant") ?? "")?.getAttribute("aria-label");
  const due = (value: string | null, extra: Partial<EditorCase> = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 11, 12));
    return renderEditor({ fieldName: "due", value, ...extra });
  };

  it("opens on the stored date's month, with that day and today marked, and the week starting where the calendar's does", () => {
    due("2026-11-20");
    expect(screen.getByText("November 2026")).toBeDefined();
    expect(day("November 20, 2026").getAttribute("aria-selected")).toBe("true");
    expect(day("November 11, 2026").getAttribute("aria-selected")).toBe("false");
    expect(day("November 11, 2026").getAttribute("aria-current")).toBe("date");
    expect(day("November 20, 2026").hasAttribute("aria-current")).toBe(false);
    expect(screen.getAllByRole("columnheader").map((header) => header.getAttribute("aria-label"))).toEqual([
      "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ]);
    // November 2026 starts on a Sunday and ends on a Monday: five whole weeks.
    expect(screen.getAllByRole("gridcell")).toHaveLength(35);
    expect(screen.getAllByRole("gridcell").at(-1)?.getAttribute("aria-label")).toBe("December 5, 2026");
    expect(screen.getAllByRole("gridcell")[0]?.getAttribute("aria-label")).toBe("November 1, 2026");
    expect(document.activeElement).toBe(month());
  });

  it("opens on today for an empty cell or a value that is not a date", () => {
    const view = due(null);
    expect(screen.getByText("November 2026")).toBeDefined();
    expect(cursor()).toBe("November 11, 2026");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    view.unmount();
    due("soon");
    expect(cursor()).toBe("November 11, 2026");
    expect(screen.getByRole("button", { name: "Clear" })).toBeDefined();
  });

  it("saves a picked day as YYYY-MM-DD and closes", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    due("2026-11-20", { emit, close });
    fireEvent.click(day("November 3, 2026"));
    expect(emit).toHaveBeenCalledExactlyOnceWith("2026-11-03");
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it("closes without saving when the picked day is the stored one", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    due("2026-11-20", { emit, close });
    fireEvent.click(day("November 20, 2026"));
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("saves today from Today, and empty from Clear", () => {
    const emit = writeEmitter();
    const view = due("2026-09-15", { emit });
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(emit).toHaveBeenCalledExactlyOnceWith("2026-11-11");
    view.unmount();
    due("2026-09-15", { emit });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(emit).toHaveBeenLastCalledWith(null);
  });

  it("changes the month from its buttons without saving", () => {
    const emit = writeEmitter();
    due("2026-11-20", { emit });
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("December 2026")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("October 2026")).toBeDefined();
    // The stored day stays marked in a month that still shows it.
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(day("November 20, 2026").getAttribute("aria-selected")).toBe("true");
    expect(emit).not.toHaveBeenCalled();
  });

  it("moves by a day or a week with the arrow keys and by a month with Page Up and Page Down, and picks with Enter", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    due("2026-11-20", { emit, close });
    const press = (key: string) => fireEvent.keyDown(month(), { key });
    expect(cursor()).toBe("November 20, 2026");
    expect(press("ArrowRight")).toBe(false);
    expect(cursor()).toBe("November 21, 2026");
    press("ArrowDown");
    expect(cursor()).toBe("November 28, 2026");
    // A week past the end of the month turns the page.
    press("ArrowDown");
    expect(cursor()).toBe("December 5, 2026");
    expect(screen.getByText("December 2026")).toBeDefined();
    press("ArrowLeft");
    press("ArrowUp");
    expect(cursor()).toBe("November 27, 2026");
    press("PageDown");
    expect(cursor()).toBe("December 27, 2026");
    press("PageUp");
    press("PageUp");
    expect(cursor()).toBe("October 27, 2026");
    expect(emit).not.toHaveBeenCalled();
    // A key the calendar does not use stays with the browser.
    expect(press("a")).toBe(true);

    press("Enter");
    expect(emit).toHaveBeenCalledExactlyOnceWith("2026-10-27");
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it("cancels on Escape, and saves nothing on Tab or a press outside", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    due("2026-11-20", { emit, close });
    fireEvent.keyDown(month(), { key: "ArrowRight" });
    fireEvent.keyDown(month(), { key: "Escape" });
    expect(close).toHaveBeenLastCalledWith();
    expect(fireEvent.keyDown(month(), { key: "Tab" })).toBe(false);
    expect(close).toHaveBeenLastCalledWith("next");
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenLastCalledWith("away");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("people picker", () => {
  const people = [{ id: "user-7", name: "Ada" }, { id: "user-9", name: "Grace" }];
  const names = () => screen.getAllByRole("option").map((row) => row.textContent);

  it("lists the host's people by name, with a check on the current one and a row that sets no one", () => {
    renderEditor({ fieldName: "owner", value: "user-9", people });
    expect(screen.getByRole("combobox", { name: "Search people" })).toBe(document.activeElement);
    expect(screen.getByRole("listbox", { name: "People for owner" })).toBeDefined();
    // Each row starts with the person's initial.
    expect(names()).toEqual(["AAda", "GGrace", "No one"]);
    expect([picked("Ada"), picked("Grace")]).toEqual([false, true]);
    expect(highlighted()).toBe("GGrace");
  });

  it("saves the picked person's id, and empty from No one", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    const view = renderEditor({ fieldName: "owner", value: "user-9", people, emit, close });
    fireEvent.click(option("Ada"));
    expect(emit).toHaveBeenCalledExactlyOnceWith("user-7");
    expect(close).toHaveBeenCalledExactlyOnceWith();
    view.unmount();

    renderEditor({ fieldName: "owner", value: "user-9", people, emit });
    fireEvent.click(option("No one"));
    expect(emit).toHaveBeenLastCalledWith(null);
  });

  it("searches people by name, from the character that opened the picker", () => {
    const emit = writeEmitter();
    renderEditor({ fieldName: "owner", value: null, people, typed: "g", emit });
    expect(names()).toEqual(["GGrace"]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("user-9");
  });

  it("offers no row that sets no one for an empty cell, and says when a search matches no one", () => {
    renderEditor({ fieldName: "owner", value: null, people });
    expect(names()).toEqual(["AAda", "GGrace"]);
    fireEvent.change(search(), { target: { value: "zed" } });
    expect(screen.getByText('No people match "zed".')).toBeDefined();
  });

  it("shows an id the list does not have as the current value, and never drops it", () => {
    const emit = writeEmitter();
    const close = vi.fn();
    renderEditor({ fieldName: "owner", value: "user-x", people, emit, close });
    expect(names()).toEqual(["Uuser-x", "AAda", "GGrace", "No one"]);
    expect(picked("user-x")).toBe(true);
    // Enter keeps it, and so does every way of closing without a pick.
    fireEvent.keyDown(search(), { key: "Enter" });
    fireEvent.keyDown(search(), { key: "Tab" });
    fireEvent.keyDown(search(), { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenCalledTimes(4);
    expect(emit).not.toHaveBeenCalled();
  });
});
