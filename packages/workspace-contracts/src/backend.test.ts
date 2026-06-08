import { describe, expect, it } from "vitest";
import { WorkspacePath } from "./domain";

describe("WorkspacePath", () => {
  it("accepts relative workspace paths", () => {
    expect(WorkspacePath.parse("finance/transactions.csv")).toBe(
      "finance/transactions.csv",
    );
  });

  it("rejects absolute paths", () => {
    expect(() => WorkspacePath.parse("/finance/transactions.csv")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => WorkspacePath.parse("finance/../private.md")).toThrow();
  });
});
