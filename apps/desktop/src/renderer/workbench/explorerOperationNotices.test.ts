import { describe, expect, it } from "vitest";
import { doneNotice, undoneNotice, undoRefusedNotice, type RecordedTreeChange } from "./explorerOperationNotices";

const id = "dohc-operation:11111111-1111-4111-8111-111111111111";
const moved = (fromPath: string, toPath: string, undoable = true, noUndo?: string): RecordedTreeChange => ({
  change: { id: fromPath, kind: "file", fromPath, toPath }, operationId: id, undoable, ...(noUndo ? { noUndo } : {}),
});
const deleted = (path: string): RecordedTreeChange => ({
  change: { id: path, kind: "delete-file", path }, operationId: id, undoable: true,
});

describe("what a finished tree change says", () => {
  it("names one item, and counts several as items", () => {
    expect(doneNotice([deleted("notes/budget.md")])).toEqual({ message: "Deleted budget.md", undoable: true });
    expect(doneNotice([deleted("a.md"), deleted("b")]).message).toBe("Deleted 2 items");
    expect(doneNotice([moved("notes/a.md", "notes/b.md")]).message).toBe("Renamed a.md to b.md");
    expect(doneNotice([moved("a.md", "archive/a.md")]).message).toBe("Moved a.md to archive");
    expect(doneNotice([moved("notes/a.md", "a.md")]).message).toBe("Moved a.md to Files");
    expect(doneNotice([moved("a.md", "archive/a.md"), moved("b.md", "archive/b.md")]).message).toBe("Moved 2 items to archive");
  });

  it("offers Undo only when main can reverse every change, and adds main's reason", () => {
    const reason = "Undo for a folder move isn't available yet. Move it back yourself.";
    expect(doneNotice([moved("a.md", "x/a.md"), moved("b", "x/b", false, reason)])).toEqual({
      message: `Moved 2 items to x. ${reason}`, undoable: false,
    });
    expect(doneNotice([moved("a.md", "x/a.md", false)])).toEqual({ message: "Moved a.md to x", undoable: false });
  });

  it("says what Undo put back", () => {
    expect(undoneNotice([deleted("notes/budget.md")])).toBe("Restored budget.md");
    expect(undoneNotice([deleted("a.md"), deleted("b.md")])).toBe("Restored 2 items");
    expect(undoneNotice([moved("notes/a.md", "notes/b.md")])).toBe("Renamed b.md back to a.md");
    expect(undoneNotice([moved("notes/a.md", "archive/a.md")])).toBe("Moved a.md back to notes");
    expect(undoneNotice([moved("a.md", "x/a.md"), moved("b.md", "x/b.md")])).toBe("Moved 2 items back");
  });

  it("says why Undo was refused only when main named it", () => {
    const occupied = { code: "old-path-occupied", path: "docs/budget.md" } as const;
    expect(undoRefusedNotice("rename", occupied)).toBe("Cannot undo the rename. budget.md now occupies the old path. Move it first.");
    expect(undoRefusedNotice("move", occupied)).toBe("Cannot undo the move. budget.md now occupies the old path. Move it first.");
    expect(undoRefusedNotice("delete", occupied)).toBe("Cannot undo the delete. budget.md now occupies the old path. Move it first.");
    expect(undoRefusedNotice("delete", { code: "unexplained" })).toBe("Cannot undo the delete.");
  });
});
