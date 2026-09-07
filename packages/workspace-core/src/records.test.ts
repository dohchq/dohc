import { describe, expect, it } from "vitest";
import { isRecord } from "./records";

// Boundary contract for the shared predicate: any non-null non-array object
// passes, including class instances and null-prototype objects. Callers that
// need Object.prototype validation must not use this check.
describe("isRecord", () => {
  it("rejects null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(7)).toBe(false);
  });

  it("accepts plain, class, and null-prototype objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(new Date())).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });
});
