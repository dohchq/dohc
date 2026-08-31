// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelationFieldDefinition } from "@dohc/workspace-contracts";
import { RelationPicker } from "./RelationPicker";
import { recordLabel } from "../recordLabel";
import { deferred, indexedValue, makeQueryResult, makeRecord } from "../testSupport";
import type { CollectionQueryResult } from "@dohc/workspace-contracts";

afterEach(cleanup);

const SINGLE: RelationFieldDefinition = {
  name: "parent",
  type: "relation",
  collection: "tasks",
  many: false,
};
const MANY: RelationFieldDefinition = { ...SINGLE, name: "blocks", many: true };

const TARGETS = [
  makeRecord("rec-a", [indexedValue("title", "Design")]),
  makeRecord("rec-b", [indexedValue("title", "Build")]),
  // No title or name: the label falls back to the filename without ".md".
  makeRecord("rec-c", []),
];

function makeExecutor(records = TARGETS) {
  return vi.fn(async () => makeQueryResult(records));
}

describe("recordLabel", () => {
  it("prefers title, then name, then the filename without .md", () => {
    expect(recordLabel(makeRecord("r", [indexedValue("title", " Design ")]))).toBe("Design");
    expect(recordLabel(makeRecord("r", [indexedValue("name", "Build")]))).toBe("Build");
    expect(
      recordLabel(
        makeRecord("r", [indexedValue("title", "   "), indexedValue("name", "Fallback")]),
      ),
    ).toBe("Fallback");
    expect(recordLabel(makeRecord("rec-c", []))).toBe("rec-c");
  });
});

describe("RelationPicker", () => {
  it("queries the related collection once and lists its records by label", async () => {
    const executor = makeExecutor();
    render(
      <RelationPicker
        field={SINGLE}
        value={null}
        executor={executor}
        emit={vi.fn()}
        close={vi.fn()}
      />,
    );
    expect(await screen.findByText("Design")).toBeDefined();
    expect(screen.getByText("Build")).toBeDefined();
    expect(screen.getByText("rec-c")).toBeDefined();
    expect(executor).toHaveBeenCalledExactlyOnceWith({
      collectionPath: "tasks",
      limit: 100,
    });
  });

  it("single: picking a record emits its id and closes", async () => {
    const emit = vi.fn();
    const close = vi.fn();
    render(
      <RelationPicker
        field={SINGLE}
        value={null}
        executor={makeExecutor()}
        emit={emit}
        close={close}
      />,
    );
    fireEvent.click(await screen.findByRole("option", { name: "Build" }));
    expect(emit).toHaveBeenCalledExactlyOnceWith("rec-b");
    expect(close).toHaveBeenCalledOnce();
  });

  it("single: Clear emits null and closes", async () => {
    const emit = vi.fn();
    const close = vi.fn();
    render(
      <RelationPicker
        field={SINGLE}
        value="rec-a"
        executor={makeExecutor()}
        emit={emit}
        close={close}
      />,
    );
    expect(
      (await screen.findByRole("option", { name: "Design" })).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByText("Clear"));
    expect(emit).toHaveBeenCalledExactlyOnceWith(null);
    expect(close).toHaveBeenCalledOnce();
  });

  it("many: toggling adds and removes ids without closing", async () => {
    const emit = vi.fn();
    const close = vi.fn();
    render(
      <RelationPicker
        field={MANY}
        value={["rec-a"]}
        executor={makeExecutor()}
        emit={emit}
        close={close}
      />,
    );
    const design = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Design" });
    expect(design.checked).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Build" }));
    expect(emit).toHaveBeenLastCalledWith(["rec-a", "rec-b"]);

    fireEvent.click(design);
    expect(emit).toHaveBeenLastCalledWith([]);
    expect(close).not.toHaveBeenCalled();
  });

  it("filters the fetched page as the search text changes", async () => {
    render(
      <RelationPicker
        field={SINGLE}
        value={null}
        executor={makeExecutor()}
        emit={vi.fn()}
        close={vi.fn()}
      />,
    );
    await screen.findByText("Design");
    fireEvent.change(screen.getByLabelText("Search records"), {
      target: { value: "des" },
    });
    expect(screen.getByText("Design")).toBeDefined();
    expect(screen.queryByText("Build")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search records"), {
      target: { value: "nothing" },
    });
    expect(screen.getByText('No records match "nothing".')).toBeDefined();
  });

  it("shows the loading line until the query settles, the empty line after", async () => {
    const gate = deferred<CollectionQueryResult>();
    const executor = vi.fn(() => gate.promise);
    render(
      <RelationPicker
        field={SINGLE}
        value={null}
        executor={executor}
        emit={vi.fn()}
        close={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading records...")).toBeDefined();
    gate.resolve(makeQueryResult([]));
    expect(
      await screen.findByText("No records in the related collection yet."),
    ).toBeDefined();
  });

  it("surfaces a failed query", async () => {
    const executor = vi.fn(async (): Promise<CollectionQueryResult> => {
      throw new Error("engine offline");
    });
    render(
      <RelationPicker
        field={SINGLE}
        value={null}
        executor={executor}
        emit={vi.fn()}
        close={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        "dohc could not read the related collection's records. engine offline",
      ),
    ).toBeDefined();
  });
});
