import { describe, expect, it } from "vitest";
import { WorkspacePath } from "./domain";
import { composeRenamedPath } from "./path";

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

describe("composeRenamedPath", () => {
  it("renames inside the existing folder", () => {
    expect(composeRenamedPath("finance/ledger.md", "books.md")).toBe(
      "finance/books.md",
    );
  });

  it("rejects traversal and nested path segments in the new filename", () => {
    expect(() => composeRenamedPath("finance/ledger.md", "../secret.md")).toThrow();
    expect(() => composeRenamedPath("finance/ledger.md", "nested/book.md")).toThrow();
  });
});
