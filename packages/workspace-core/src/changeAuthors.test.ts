import { describe, expect, it } from "vitest";
import { createLocalChangeAuthor } from "./changeAuthors";

describe("change authors", () => {
  it("normalizes local author labels and rejects empty labels", () => {
    expect(createLocalChangeAuthor(" Local file edit ")).toEqual({
      kind: "local",
      label: "Local file edit",
    });
    expect(() => createLocalChangeAuthor("  ")).toThrow(/non-empty/i);
  });
});
