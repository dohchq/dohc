import { describe, expect, it } from "vitest";
import { compareCodePoints, compareMessageOrder } from "./chatOrder";

describe("compareMessageOrder", () => {
  it("orders by time, then by ID", () => {
    const sorted = [
      { createdAtMs: 100, id: "z" }, { createdAtMs: 100, id: "b" }, { createdAtMs: 50, id: "y" }, { createdAtMs: 100, id: "a" },
    ].sort(compareMessageOrder);
    expect(sorted.map(message => message.id)).toEqual(["y", "a", "b", "z"]);
  });

  it("compares IDs in code point order, as the engine's byte order does", () => {
    // U+FF5E sorts before U+1F600 by code point, though its UTF-16 unit is larger.
    expect(compareCodePoints("～", "\u{1f600}")).toBeLessThan(0);
    expect("～" < "\u{1f600}").toBe(false);
    expect(compareCodePoints("ab", "abc")).toBeLessThan(0);
    expect(compareCodePoints("abc", "abc")).toBe(0);
  });
});
