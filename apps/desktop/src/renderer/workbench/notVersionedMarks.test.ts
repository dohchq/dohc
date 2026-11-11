import { describe, expect, it, vi } from "vitest";
import { notVersionedPaths, readError } from "../../ipc/errorWords";
import { createNotVersionedMarks, notVersionedConfirmText } from "./notVersionedMarks";

describe("not-versioned marks", () => {
  it("finds the marked files at or under each path, and not beside them", () => {
    const marks = createNotVersionedMarks();
    marks.set(["Media/clip.mp4", "Media/old/raw.mov", "Mediaset/big.bin"]);
    expect(marks.under(["Media"])).toEqual(["Media/clip.mp4", "Media/old/raw.mov"]);
    expect(marks.under(["Media/clip.mp4"])).toEqual(["Media/clip.mp4"]);
    expect(marks.under(["Notes"])).toEqual([]);
    expect(marks.has("Media/clip.mp4")).toBe(true);
  });

  it("tells rows only when the marked files change", () => {
    const marks = createNotVersionedMarks();
    const changed = vi.fn();
    marks.subscribe(changed);
    marks.set(["a.mp4", "b.mp4"]);
    marks.set(["b.mp4", "a.mp4"]);
    expect(changed).toHaveBeenCalledTimes(1);
    marks.set([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe("the question before changing them", () => {
  it("names the file and says Main changes too", () => {
    expect(notVersionedConfirmText("delete", ["Media/clip.mp4"], ["Media/clip.mp4"])).toEqual({
      title: "Delete clip.mp4 from Main too?",
      body: "It isn't versioned, so Main and every version have the same copy. Deleted files go to the system trash, or to .dohc/local/trash in this workspace when the system trash refuses them.",
      confirmLabel: "Delete anyway",
    });
    expect(notVersionedConfirmText("rename", ["Media/clip.mp4"], ["Media/clip.mp4"]).title).toBe("Rename clip.mp4 in Main too?");
  });

  it("counts the files a folder or a selection carries", () => {
    expect(notVersionedConfirmText("move", ["Media", "Notes/a.md"], ["Media/clip.mp4", "Media/raw.mov"])).toEqual({
      title: "Move 2 items in Main too?",
      body: "2 files here aren't versioned, so Main and every version have the same copy.",
      confirmLabel: "Move anyway",
    });
    expect(notVersionedConfirmText("delete", ["Media"], ["Media/clip.mp4"]).body)
      .toBe("1 file here isn't versioned, so Main and every version have the same copy. Deleted files go to the system trash, or to .dohc/local/trash in this workspace when the system trash refuses them.");
  });
});

describe("main's refusal, as the renderer reads it", () => {
  const refusal = new Error("Error invoking remote method 'desktop:move-workspace-path': NotVersionedError: This change also happens in Main, because 2 files here aren't versioned.\nMedia/clip.mp4\nMedia/raw.mov");

  it("carries the files", () => {
    expect(notVersionedPaths(refusal)).toEqual(["Media/clip.mp4", "Media/raw.mov"]);
    expect(notVersionedPaths(new Error("LiveFolderError: no"))).toBeNull();
  });

  it("reads as its sentence alone", () => {
    expect(readError(refusal).words).toBe("This change also happens in Main, because 2 files here aren't versioned.");
  });
});
