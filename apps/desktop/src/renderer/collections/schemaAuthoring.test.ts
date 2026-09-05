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
    { name: "Status", type: "select", options: ["Todo", "Doing", "Done"] },
    { name: "Tags", type: "multi-select", options: ["a", "b"] },
    { name: "Owner", type: "person" },
    { name: "Blocks", type: "relation", collection: "projects/tasks", many: true },
    { name: "Link", type: "url" },
  ],
  views: [
    {
      name: "Board",
      kind: "board",
      groupBy: "Status",
      sort: [{ field: "Due", direction: "asc" }],
      visibleFields: ["Name", "Status"],
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
  it("round-trips every v1 field type and view shape as a valid schema", () => {
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

  it("setFieldOptions replaces options only on select fields", () => {
    const next = setFieldOptions(FULL, "Status", ["Todo", "Done"]);
    expect(next.fields[4]).toEqual({
      name: "Status",
      type: "select",
      options: ["Todo", "Done"],
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
