import { describe, expect, it } from "vitest";
import { deriveColumns } from "./columns";
import { V1_FIELDS, makeSchema } from "./testSupport";

describe("deriveColumns", () => {
  it("returns every schema field in schema order without visibleFields", () => {
    expect(deriveColumns(makeSchema())).toEqual(V1_FIELDS);
    expect(deriveColumns(makeSchema(), null)).toEqual(V1_FIELDS);
  });

  it("follows the visibleFields order and drops unknown names", () => {
    const columns = deriveColumns(makeSchema(), ["status", "renamed-away", "title"]);
    expect(columns.map((field) => field.name)).toEqual(["status", "title"]);
  });
});
