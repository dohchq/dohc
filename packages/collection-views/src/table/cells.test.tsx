// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import { FieldCell } from "./cells";
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
    expect(flagged?.getAttribute("title")).toBe("Invalid value");

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
});

describe("FieldCell editing", () => {
  it("commits a text edit on Enter", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("title")} indexed={indexedValue("title", "Old")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("New title");
  });

  it("commits an emptied text edit as null", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("title")} indexed={indexedValue("title", "Old")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("cancels a text edit on Escape without an event", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("title")} indexed={indexedValue("title", "Old")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByDisplayValue<HTMLInputElement>("Old");
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDefined();
  });

  it("parses a number edit and drops an unparseable one", () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <FieldCell field={field("estimate")} indexed={indexedValue("estimate", 1)} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(input, { target: { value: "42.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(42.5);
    unmount();

    onChange.mockClear();
    render(
      <FieldCell field={field("estimate")} indexed={indexedValue("estimate", 1)} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const second = screen.getByDisplayValue<HTMLInputElement>("1");
    fireEvent.change(second, { target: { value: "not a number" } });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles a checkbox directly", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("done")} indexed={indexedValue("done", false)} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("commits a date edit", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("due")} indexed={indexedValue("due", "2026-09-15")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByDisplayValue<HTMLInputElement>("2026-09-15");
    fireEvent.change(input, { target: { value: "2026-10-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-10-01");
  });

  it("hands a typed unknown select option to onCreateOption, not onChange", () => {
    const onChange = vi.fn();
    const onCreateOption = vi.fn();
    render(
      <FieldCell
        field={field("status")}
        indexed={indexedValue("status", "todo")}
        onChange={onChange}
        onCreateOption={onCreateOption}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "later" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("later", "later");
    expect(onChange).not.toHaveBeenCalled();
    // The editor closed; the cell is back to its display button.
    expect(screen.getByRole("button")).toBeDefined();
  });

  it("picks an existing option typed into the add input instead of forking it", () => {
    const onChange = vi.fn();
    const onCreateOption = vi.fn();
    render(
      <FieldCell
        field={field("status")}
        indexed={indexedValue("status", "todo")}
        onChange={onChange}
        onCreateOption={onCreateOption}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "shipped" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("shipped");
    expect(onCreateOption).not.toHaveBeenCalled();
  });

  it("hands a typed unknown multi-select option with the extended selection", () => {
    const onChange = vi.fn();
    const onCreateOption = vi.fn();
    render(
      <FieldCell
        field={field("tags")}
        indexed={indexedValue("tags", ["alpha"])}
        onChange={onChange}
        onCreateOption={onCreateOption}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "delta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith("delta", [
      "alpha",
      "delta",
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers no add input without onCreateOption", () => {
    render(
      <FieldCell
        field={field("status")}
        indexed={indexedValue("status", "todo")}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByLabelText("Add option")).toBeNull();
  });

  it("commits a select choice, empty as null", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("status")} indexed={indexedValue("status", "todo")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "shipped" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("shipped");

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("toggles multi-select options, adding and removing", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("tags")} indexed={indexedValue("tags", ["alpha"])} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(onChange).toHaveBeenLastCalledWith(["alpha", "beta"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "alpha" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps relation cells read-only without a relation executor", () => {
    const onChange = vi.fn();
    render(
      <FieldCell field={field("blocks")} indexed={indexedValue("blocks", ["rec-a"])} onChange={onChange} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the relation picker against the related collection and emits ids", async () => {
    const onChange = vi.fn();
    const executor = vi.fn(async () =>
      makeQueryResult([
        makeRecord("rec-a", [indexedValue("title", "Design")]),
        makeRecord("rec-b", [indexedValue("title", "Build")]),
      ]),
    );
    render(
      <FieldCell
        field={field("blocks")}
        indexed={indexedValue("blocks", ["rec-a"])}
        onChange={onChange}
        relationExecutor={executor}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Build" }));
    expect(executor).toHaveBeenCalledExactlyOnceWith({
      collectionPath: "tasks",
      limit: 100,
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["rec-a", "rec-b"]);
  });

  it("trims a person edit and commits a whitespace-only one as null", () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <FieldCell field={field("owner")} indexed={indexedValue("owner", "user-7")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByDisplayValue<HTMLInputElement>("user-7");
    fireEvent.change(input, { target: { value: "  user-9  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("user-9");
    unmount();

    onChange.mockClear();
    render(
      <FieldCell field={field("owner")} indexed={indexedValue("owner", "user-7")} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const second = screen.getByDisplayValue<HTMLInputElement>("user-7");
    fireEvent.change(second, { target: { value: "   " } });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});
