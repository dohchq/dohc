import { describe, expect, it } from "vitest";
import { doneNotice, undoneNotice, undoRefusedNotice, type RecordedTreeChange } from "./explorerOperationNotices";

const id = "dohc-operation:11111111-1111-4111-8111-111111111111";
const moved = (fromPath: string, toPath: string, undoable = true, noUndo?: string): RecordedTreeChange => ({
  change: { id: fromPath, kind: "file", fromPath, toPath }, operationId: id, undoable, ...(noUndo ? { noUndo } : {}),
});
const deleted = (path: string): RecordedTreeChange => ({
  change: { id: path, kind: "delete-file", path }, operationId: id, undoable: true,
});
// A delete main answered with its place: the system trash (true) or the
// workspace's own trash (false).
const trashed = (path: string, system: boolean, kind: "delete-file" | "delete-folder" = "delete-file", noUndo?: string): RecordedTreeChange => ({
  change: { id: path, kind, path }, operationId: id, undoable: noUndo === undefined, trashed: system, ...(noUndo ? { noUndo } : {}),
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

  it("says a delete went to the system trash, beside Undo", () => {
    expect(doneNotice([trashed("notes/report.md", true)])).toEqual({ message: "Deleted report.md. It's in the system trash.", undoable: true });
    expect(doneNotice([trashed("a.md", true), trashed("b", true, "delete-folder"), trashed("c.md", true)]).message)
      .toBe("Deleted 3 items. They're in the system trash.");
  });

  it("names the workspace's own trash when the system trash refused", () => {
    expect(doneNotice([trashed("Photos", false, "delete-folder")]).message).toBe("Deleted Photos. It's in .dohc/local/trash in this workspace.");
    expect(doneNotice([trashed("a.md", false), trashed("b.md", false)]).message)
      .toBe("Deleted 2 items. They're in .dohc/local/trash in this workspace.");
  });

  it("counts the rows in each place when a selection went to both", () => {
    expect(doneNotice([trashed("a.md", true), trashed("b.md", false), trashed("c.md", true)]).message)
      .toBe("Deleted 3 items. 2 are in the system trash, and 1 is in .dohc/local/trash in this workspace.");
    expect(doneNotice([trashed("a.md", true), trashed("b.md", false)]).message)
      .toBe("Deleted 2 items. 1 is in the system trash, and 1 is in .dohc/local/trash in this workspace.");
  });

  it("adds no place without Undo, because main's reason names it", () => {
    const reason = "Cannot undo the delete. big.bin is in the system trash. Restore it there.";
    expect(doneNotice([trashed("a.md", true), trashed("big.bin", true, "delete-file", reason)])).toEqual({
      message: `Deleted 2 items. ${reason}`, undoable: false,
    });
  });

  it("says what Undo put back", () => {
    expect(undoneNotice([deleted("notes/budget.md")])).toBe("Restored budget.md");
    expect(undoneNotice([deleted("a.md"), deleted("b.md")])).toBe("Restored 2 items");
    expect(undoneNotice([moved("notes/a.md", "notes/b.md")])).toBe("Renamed b.md back to a.md");
    expect(undoneNotice([moved("notes/a.md", "archive/a.md")])).toBe("Moved a.md back to notes");
    expect(undoneNotice([moved("a.md", "x/a.md"), moved("b.md", "x/b.md")])).toBe("Moved 2 items back");
  });

  it("says what failed and the one thing to do, when main named the refusal", () => {
    const occupied = (path: string) => ({ code: "old-path-occupied", path }) as const;
    expect(undoRefusedNotice(moved("docs/budget.md", "docs/costs.md").change, occupied("docs/budget.md")))
      .toBe("Cannot undo the rename. Move the new budget.md first.");
    expect(undoRefusedNotice(moved("Trips/notes.md", "archive/notes.md").change, occupied("Trips/notes.md")))
      .toBe("Cannot move notes.md back. Move the notes.md in Trips first.");
    expect(undoRefusedNotice(moved("notes.md", "archive/notes.md").change, occupied("notes.md")))
      .toBe("Cannot move notes.md back. Move the notes.md in Files first.");
    expect(undoRefusedNotice(deleted("docs/packing.md").change, occupied("docs/packing.md")))
      .toBe("Cannot restore packing.md. Move the new packing.md first.");
  });

  it("names the page to stop live editing for, at its current path", () => {
    const live = (path: string) => ({ code: "live-page-owned", path }) as const;
    expect(undoRefusedNotice(moved("docs/budget.md", "docs/costs.md").change, live("docs/costs.md")))
      .toBe("Cannot undo the rename. Stop live editing for costs.md first.");
    expect(undoRefusedNotice(moved("Trips/notes.md", "archive/notes.md").change, live("archive/notes.md")))
      .toBe("Cannot move notes.md back. Stop live editing for notes.md first.");
  });

  it("says only what cannot happen when main did not name the refusal", () => {
    const unexplained = { code: "unexplained" } as const;
    expect(undoRefusedNotice(moved("docs/budget.md", "docs/costs.md").change, unexplained)).toBe("Cannot undo the rename.");
    expect(undoRefusedNotice(moved("Trips/notes.md", "archive/notes.md").change, unexplained)).toBe("Cannot move notes.md back.");
    expect(undoRefusedNotice(deleted("docs/packing.md").change, unexplained)).toBe("Cannot restore packing.md.");
  });
});
