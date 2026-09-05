// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_VALUE_REASON_CODES } from "@dohc/workspace-contracts";
import type { CollectionValue, FieldDefinition } from "@dohc/workspace-contracts";
import type { CollectionQueryExecutor } from "../store";
import { CellEditor, FieldCell, FLAGGED_REASON_TITLES } from "./cells";
import { V1_FIELDS, indexedValue, makeQueryResult, makeRecord } from "../testSupport";

afterEach(cleanup);

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

  it("renders a date value", () => {
    render(<FieldCell field={field("due")} indexed={indexedValue("due", "2026-09-15")} />);
    expect(screen.getByText("2026-09-15")).toBeDefined();
  });

  it("renders a select value", () => {
    render(<FieldCell field={field("status")} indexed={indexedValue("status", "doing")} />);
    expect(screen.getByText("doing")).toBeDefined();
  });

  it("renders multi-select values joined", () => {
    render(<FieldCell field={field("tags")} indexed={indexedValue("tags", ["alpha", "gamma"])} />);
    expect(screen.getByText("alpha, gamma")).toBeDefined();
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
  it("opens editing from the display button", () => {
    const onEditStart = vi.fn();
    render(
      <FieldCell
        field={field("title")}
        indexed={indexedValue("title", "Ship it")}
        onEditStart={onEditStart}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }));
    expect(onEditStart).toHaveBeenCalledOnce();
  });

  it("renders no edit button without onEditStart", () => {
    render(<FieldCell field={field("title")} indexed={indexedValue("title", "Ship it")} />);
    expect(screen.queryByRole("button")).toBeNull();
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

interface EditorCase {
  fieldName: string;
  value: CollectionValue;
  emit?: (value: CollectionValue) => void;
  close?: () => void;
  onCreateOption?: (option: string, nextValue: CollectionValue) => void;
  relationExecutor?: CollectionQueryExecutor;
}

function renderEditor({ fieldName, value, emit, close, onCreateOption, relationExecutor }: EditorCase) {
  return render(
    <CellEditor
      field={field(fieldName)}
      indexed={indexedValue(fieldName, value)}
      emit={emit ?? vi.fn()}
      close={close ?? vi.fn()}
      onCreateOption={onCreateOption}
      relationExecutor={relationExecutor}
    />,
  );
}

describe("CellEditor", () => {
  it("commits a text edit on Enter and closes", () => {
    const emit = vi.fn();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("New title");
    expect(close).toHaveBeenCalledOnce();
  });

  it("commits an emptied text edit as null", () => {
    const emit = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("cancels a text edit on Escape without an event", () => {
    const emit = vi.fn();
    const close = vi.fn();
    renderEditor({ fieldName: "title", value: "Old", emit, close });
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("parses a number edit and drops an unparseable one", () => {
    const emit = vi.fn();
    const { unmount } = renderEditor({ fieldName: "estimate", value: 1, emit });
    const input = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(input, { target: { value: "42.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(42.5);
    unmount();

    emit.mockClear();
    const close = vi.fn();
    renderEditor({ fieldName: "estimate", value: 1, emit, close });
    const second = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(second, { target: { value: "not a number" } });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("commits a date edit", () => {
    const emit = vi.fn();
    renderEditor({ fieldName: "due", value: "2026-09-15", emit });
    const input = screen.getByDisplayValue<HTMLInputElement>("2026-09-15");
    fireEvent.change(input, { target: { value: "2026-10-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("2026-10-01");
  });

  it("hands a typed unknown select option to onCreateOption, not emit", () => {
    const emit = vi.fn();
    const close = vi.fn();
    const onCreateOption = vi.fn();
    renderEditor({ fieldName: "status", value: "todo", emit, close, onCreateOption });
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "later" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("later", "later");
    expect(emit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("picks an existing option typed into the add input instead of forking it", () => {
    const emit = vi.fn();
    const onCreateOption = vi.fn();
    renderEditor({ fieldName: "status", value: "todo", emit, onCreateOption });
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "shipped" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("shipped");
    expect(onCreateOption).not.toHaveBeenCalled();
  });

  it("hands a typed unknown multi-select option with the extended selection", () => {
    const emit = vi.fn();
    const onCreateOption = vi.fn();
    renderEditor({ fieldName: "tags", value: ["alpha"], emit, onCreateOption });
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "delta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("delta", ["alpha", "delta"]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("offers no add input without onCreateOption", () => {
    renderEditor({ fieldName: "status", value: "todo" });
    expect(screen.queryByLabelText("Add option")).toBeNull();
  });

  it("commits a select choice, empty as null", () => {
    const emit = vi.fn();
    const { unmount } = renderEditor({ fieldName: "status", value: "todo", emit });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "shipped" } });
    expect(emit).toHaveBeenCalledExactlyOnceWith("shipped");
    unmount();

    emit.mockClear();
    renderEditor({ fieldName: "status", value: "todo", emit });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("compounds multi-select toggles before any refresh lands", () => {
    // Starting at ["alpha"], toggling beta then alpha must retain beta. The
    // indexed prop still says ["alpha"] (the host's re-query has not landed),
    // so deriving each toggle from props would emit [] and erase beta.
    const emit = vi.fn();
    renderEditor({ fieldName: "tags", value: ["alpha"], emit });
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(emit).toHaveBeenLastCalledWith(["alpha", "beta"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "alpha" }));
    expect(emit).toHaveBeenLastCalledWith(["beta"]);
  });

  it("keeps the current multi-select selection when a delayed prop refresh repeats a stale value", () => {
    const emit = vi.fn();
    const view = render(
      <CellEditor
        field={field("tags")}
        indexed={indexedValue("tags", ["alpha"])}
        emit={emit}
        close={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(emit).toHaveBeenLastCalledWith(["alpha", "beta"]);

    // A slow index read re-serves ["alpha"] after the beta toggle. The open
    // editor owns the selection; the stale prop must not erase beta.
    view.rerender(
      <CellEditor
        field={field("tags")}
        indexed={indexedValue("tags", ["alpha"])}
        emit={emit}
        close={vi.fn()}
      />,
    );
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(emit).toHaveBeenLastCalledWith(["alpha", "beta", "gamma"]);
  });

  it("includes an observed remote selection in the next multi-select edit", () => {
    const emit = vi.fn();
    const editor = (value: string[]) => (
      <CellEditor field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha"]));

    view.rerender(editor(["alpha", "beta"]));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(emit).toHaveBeenLastCalledWith(["alpha", "beta", "gamma"]);
  });

  it("combines observed remote additions with a pending local removal", () => {
    const emit = vi.fn();
    const editor = (value: string[]) => (
      <CellEditor field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha", "beta"]));
    fireEvent.click(screen.getByRole("checkbox", { name: "alpha" }));
    expect(emit).toHaveBeenLastCalledWith(["beta"]);

    view.rerender(editor(["alpha", "beta", "gamma"]));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "alpha" }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "gamma" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(emit).toHaveBeenLastCalledWith(["gamma"]);
  });

  it("combines observed remote removals with a pending local addition", () => {
    const emit = vi.fn();
    const editor = (value: string[]) => (
      <CellEditor field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha", "beta"]));
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));

    view.rerender(editor(["beta"]));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "alpha" }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "gamma" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(emit).toHaveBeenLastCalledWith(["gamma"]);
  });

  it("acknowledges earlier toggles without undoing a later toggle of the same option", () => {
    const emit = vi.fn();
    const editor = (value: string[]) => (
      <CellEditor field={field("tags")} indexed={indexedValue("tags", value)} emit={emit} close={vi.fn()} />
    );
    const view = render(editor(["alpha"]));
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(emit).toHaveBeenLastCalledWith(["alpha"]);

    view.rerender(editor(["alpha", "beta"]));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(false);
    view.rerender(editor(["alpha"]));
    view.rerender(editor(["alpha", "beta"]));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "beta" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "gamma" }));
    expect(emit).toHaveBeenLastCalledWith(["alpha", "beta", "gamma"]);
  });

  it("adds a typed unknown multi-select option to the compounded selection", () => {
    // The add input reads the same live selection as the checkboxes: after a
    // beta toggle, a typed new option extends ["alpha", "beta"], not props.
    const emit = vi.fn();
    const onCreateOption = vi.fn();
    renderEditor({ fieldName: "tags", value: ["alpha"], emit, onCreateOption });
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "delta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("delta", ["alpha", "beta", "delta"]);
  });

  it("opens the relation picker against the related collection and emits ids", async () => {
    const emit = vi.fn();
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
    expect(emit).toHaveBeenCalledExactlyOnceWith(["rec-a", "rec-b"]);
  });

  it("trims a person edit and commits a whitespace-only one as null", () => {
    const emit = vi.fn();
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
