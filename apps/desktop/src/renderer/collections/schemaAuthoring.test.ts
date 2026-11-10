import { describe, expect, it } from "vitest";
import {
  parseCollectionSchema,
  type CollectionSchema,
} from "@dohc/workspace-contracts";
import {
  addField,
  addSelectOption,
  addView,
  deleteView,
  renameView,
  serializeCollectionSchema,
  setFieldOptions,
  setOptionColor,
} from "./schemaAuthoring";

// The serializer's one contract: what it writes, parseCollectionSchema reads
// back as a valid schema equal to the model. The mutation helpers are pure
// and covered against that same round trip.

const FULL: CollectionSchema = {
  name: "Tasks",
  description: "Team tasks",
  fields: [
    { name: "Name", type: "text" },
    { name: "Estimate", type: "number" },
    { name: "Done", type: "checkbox" },
    { name: "Due", type: "date" },
    { name: "Status", type: "select", options: ["Todo", "Doing", "Done"], colors: { Doing: "amber", Done: "teal" } },
    { name: "Tags", type: "multi-select", options: ["a", "b"] },
    { name: "Owner", type: "person" },
    { name: "Blocks", type: "relation", collection: "projects/tasks", many: true },
    { name: "Link", type: "url" },
    { name: "Mark paid", type: "button" },
  ],
  views: [
    {
      name: "Board",
      kind: "board",
      groupBy: "Status",
      sort: [{ field: "Due", direction: "asc" }],
      visibleFields: ["Name", "Status", "Mark paid"],
      dateField: null,
    },
    {
      name: "Calendar",
      kind: "calendar",
      groupBy: null,
      sort: [],
      visibleFields: null,
      dateField: "Due",
    },
  ],
};

describe("serializeCollectionSchema", () => {
  it("round-trips every field type and view shape as a valid schema", () => {
    expect(serializeCollectionSchema(FULL)).toMatch(/^version: 1\n/);
    const parsed = parseCollectionSchema(serializeCollectionSchema(FULL));
    expect(parsed.status).toBe("valid");
    expect(parsed.reasons).toEqual([]);
    expect(parsed.schema).toEqual(FULL);
  });

  it("round-trips a minimal new-collection schema", () => {
    const minimal: CollectionSchema = {
      name: "tasks",
      description: null,
      fields: [{ name: "Name", type: "text" }],
      views: [],
    };
    const parsed = parseCollectionSchema(serializeCollectionSchema(minimal));
    expect(parsed.status).toBe("valid");
    expect(parsed.schema).toEqual(minimal);
  });
});

describe("schema mutations", () => {
  it("addField appends and round-trips", () => {
    const next = addField(FULL, { name: "Notes", type: "text" });
    expect(next.fields.at(-1)).toEqual({ name: "Notes", type: "text" });
    expect(
      parseCollectionSchema(serializeCollectionSchema(next)).status,
    ).toBe("valid");
  });

  it("writes option colors in option order", () => {
    const schema = setOptionColor(FULL, "Status", "Todo", "blue");
    expect(serializeCollectionSchema(schema)).toContain(
      "    options:\n      - Todo\n      - Doing\n      - Done\n    colors:\n      Todo: blue\n      Doing: amber\n      Done: teal\n",
    );
  });

  it("setOptionColor recolors one option and ignores an unknown one", () => {
    const next = setOptionColor(FULL, "Status", "Done", "rose");
    expect(next.fields[4]).toEqual({
      name: "Status",
      type: "select",
      options: ["Todo", "Doing", "Done"],
      colors: { Doing: "amber", Done: "rose" },
    });
    expect(setOptionColor(FULL, "Status", "Gone", "rose")).toEqual(FULL);
    // An option named like an Object member has no color until one is set.
    const odd = setFieldOptions(FULL, "Status", ["constructor"]);
    expect(odd.fields[4]).toEqual({ name: "Status", type: "select", options: ["constructor"] });
    expect(parseCollectionSchema(serializeCollectionSchema(setOptionColor(odd, "Status", "constructor", "plum"))).schema.fields[4])
      .toEqual({ name: "Status", type: "select", options: ["constructor"], colors: { constructor: "plum" } });
  });

  it("setFieldOptions replaces options only on select fields", () => {
    const next = setFieldOptions(FULL, "Status", ["Todo", "Done"]);
    // A removed option takes its color with it.
    expect(next.fields[4]).toEqual({
      name: "Status",
      type: "select",
      options: ["Todo", "Done"],
      colors: { Done: "teal" },
    });
    expect(setFieldOptions(FULL, "Status", ["Todo"], { Todo: "gray" }).fields[4]).toEqual({
      name: "Status",
      type: "select",
      options: ["Todo"],
      colors: { Todo: "gray" },
    });
    expect(setFieldOptions(FULL, "Name", ["x"]).fields[0]).toEqual({
      name: "Name",
      type: "text",
    });
  });

  it("addSelectOption appends once", () => {
    const next = addSelectOption(FULL, "Status", "Later");
    expect(next.fields[4]).toEqual({
      name: "Status",
      type: "select",
      options: ["Todo", "Doing", "Done", "Later"],
      colors: { Doing: "amber", Done: "teal" },
    });
    expect(addSelectOption(next, "Status", "Later")).toEqual(next);
  });

  it("addView, renameView, and deleteView round-trip", () => {
    const table = {
      name: "All",
      kind: "table" as const,
      groupBy: null,
      sort: [],
      visibleFields: null,
      dateField: null,
    };
    const added = addView(FULL, table);
    expect(added.views.map((view) => view.name)).toEqual([
      "Board",
      "Calendar",
      "All",
    ]);
    const renamed = renameView(added, "All", "Everything");
    expect(renamed.views.at(-1)?.name).toBe("Everything");
    const deleted = deleteView(renamed, "Everything");
    expect(deleted.views).toEqual(FULL.views);
    expect(
      parseCollectionSchema(serializeCollectionSchema(renamed)).schema.views,
    ).toEqual(renamed.views);
  });
});
