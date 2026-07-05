import { describe, expect, it } from "vitest";
import { WorkspacePath } from "./domain";
import { engineContractCompileCheck } from "./engine.compile";
import { WorkspaceError } from "./errors";
import { composeRenamedPath } from "./path";

void engineContractCompileCheck;

function expectInvalidPath(fn: () => unknown) {
  try {
    fn();
    throw new Error("Expected invalid_path");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("invalid_path");
  }
}

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
    expectInvalidPath(() =>
      composeRenamedPath("finance/ledger.md", "../secret.md"),
    );
    expectInvalidPath(() =>
      composeRenamedPath("finance/ledger.md", "nested/book.md"),
    );
  });
});
