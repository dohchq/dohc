import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { WorkspaceFile, WorkspaceId, WorkspacePath } from "./domain";
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
  const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
  const decodeWorkspacePath = Schema.decodeUnknownSync(WorkspacePath);

  it("rejects empty workspace identifiers", () => {
    expect(() => decodeWorkspaceId("")).toThrow(
      "String must contain at least 1 character.",
    );
  });

  it("accepts relative workspace paths", () => {
    expect(decodeWorkspacePath("finance/transactions.csv")).toBe(
      "finance/transactions.csv",
    );
  });

  it("rejects absolute paths", () => {
    expect(() => decodeWorkspacePath("/finance/transactions.csv")).toThrow(
      "workspace paths are relative",
    );
  });

  it("rejects path traversal", () => {
    expect(() => decodeWorkspacePath("finance/../private.md")).toThrow(
      "workspace paths cannot contain ..",
    );
  });
});

describe("WorkspaceFile", () => {
  const decodeWorkspaceFile = Schema.decodeUnknownSync(WorkspaceFile);
  const file = {
    id: "file",
    workspaceId: "workspace",
    path: "notes/today.md",
    kind: "atom",
    contentType: "text/markdown",
    revision: "revision",
    updatedAt: 1,
  };

  it("rejects non-finite timestamps", () => {
    for (const updatedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => decodeWorkspaceFile({ ...file, updatedAt })).toThrow();
    }
  });

  it("keeps decoded fields mutable", () => {
    const decoded = decodeWorkspaceFile(file);
    decoded.updatedAt = 2;
    expect(decoded.updatedAt).toBe(2);
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
