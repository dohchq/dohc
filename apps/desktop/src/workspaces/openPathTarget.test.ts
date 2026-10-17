import { describe, expect, it, vi } from "vitest";
import { confirmOpenPathWorkspace, resolveOpenPathTarget } from "./openPathTarget";

const home = "/Users/sam";
const notes = { workspaceId: "ws-notes", rootPath: "/Users/sam/dohc/notes" };
const nested = { workspaceId: "ws-trip", rootPath: "/Users/sam/dohc/notes/trip" };

function resolve(path: string, disk: { files?: string[]; folders?: string[]; manifests?: string[] }) {
  const files = new Set(disk.files ?? []);
  const folders = new Set(disk.folders ?? []);
  const manifests = new Set(disk.manifests ?? []);
  return resolveOpenPathTarget(path, {
    workspaces: [notes, nested],
    home,
    platform: "darwin",
    fs: {
      kindOf: (candidate) => files.has(candidate) ? "file" : folders.has(candidate) ? "folder" : null,
      hasManifest: (folder) => manifests.has(folder),
    },
  });
}

describe("resolveOpenPathTarget", () => {
  it("opens a file inside a registered workspace in that workspace, deepest first", () => {
    expect(resolve("/Users/sam/dohc/notes/plans/q3.md", { files: ["/Users/sam/dohc/notes/plans/q3.md"] }))
      .toEqual({ kind: "workspace", workspace: notes, file: "plans/q3.md" });
    expect(resolve("/Users/sam/dohc/notes/trip/day-1.md", { files: ["/Users/sam/dohc/notes/trip/day-1.md"] }))
      .toEqual({ kind: "workspace", workspace: nested, file: "day-1.md" });
    // A sibling whose name starts like the root is not inside it.
    expect(resolve("/Users/sam/dohc/notes-old/a.md", { files: ["/Users/sam/dohc/notes-old/a.md"] }))
      .toEqual({ kind: "folder", rootPath: "/Users/sam/dohc/notes-old", hasManifest: false, file: "a.md" });
  });

  it("opens a folder of a workspace without a file, and nothing for a path that is not there", () => {
    expect(resolve("/Users/sam/dohc/notes/plans", { folders: ["/Users/sam/dohc/notes/plans"] }))
      .toEqual({ kind: "workspace", workspace: notes, file: null });
    expect(resolve("/Users/sam/gone.md", {})).toBeNull();
    expect(resolve("relative/a.md", { files: ["relative/a.md"] })).toBeNull();
  });

  it("opens the workspace but no tab for a file in its .dohc folder", () => {
    expect(resolve("/Users/sam/dohc/notes/.dohc/manifest.json", { files: ["/Users/sam/dohc/notes/.dohc/manifest.json"] }))
      .toEqual({ kind: "workspace", workspace: notes, file: null });
  });

  it("adopts the nearest folder that already has a dohc manifest", () => {
    expect(resolve("/Volumes/Work/project/docs/a.md", {
      files: ["/Volumes/Work/project/docs/a.md"], manifests: ["/Volumes/Work/project"],
    })).toEqual({ kind: "folder", rootPath: "/Volumes/Work/project", hasManifest: true, file: "docs/a.md" });
  });

  it("asks about the file's own folder when no workspace holds it", () => {
    expect(resolve("/Users/sam/Downloads/notes.md", { files: ["/Users/sam/Downloads/notes.md"] }))
      .toEqual({ kind: "folder", rootPath: "/Users/sam/Downloads", hasManifest: false, file: "notes.md" });
    // A manifest in the home folder is one dohc cannot use, so it is passed over.
    expect(resolve("/Users/sam/Downloads/notes.md", { files: ["/Users/sam/Downloads/notes.md"], manifests: [home] }))
      .toEqual({ kind: "folder", rootPath: "/Users/sam/Downloads", hasManifest: false, file: "notes.md" });
  });

  it("refuses the home folder and the top folder of a disk, as the folder picker does", () => {
    expect(() => resolve("/Users/sam/todo.txt", { files: ["/Users/sam/todo.txt"] }))
      .toThrow("Your home folder cannot be a workspace. Move the file into a folder, then open it again.");
    expect(() => resolve("/Users/Sam", { folders: ["/Users/Sam"] }))
      .toThrow("Your home folder cannot be a workspace. Open a folder inside it.");
    expect(() => resolve("/todo.txt", { files: ["/todo.txt"] }))
      .toThrow("The top folder of a disk cannot be a workspace. Move the file into a folder, then open it again.");
  });
});

describe("confirmOpenPathWorkspace", () => {
  it("names the folder and what dohc writes there, and only Open as workspace agrees", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    await expect(confirmOpenPathWorkspace({ showMessageBox }, { rootPath: "/Users/sam/Downloads", file: "notes.md" }))
      .resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledWith({
      type: "question",
      message: 'Open "Downloads" as a workspace?',
      detail: "dohc adds a .dohc folder to /Users/sam/Downloads to keep the workspace's history. "
        + "Your files stay where they are. Then dohc opens notes.md.",
      buttons: ["Open as workspace", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(confirmOpenPathWorkspace({ showMessageBox }, { rootPath: "/Users/sam/Projects", file: null }))
      .resolves.toBe(false);
    expect(showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      detail: "dohc adds a .dohc folder to /Users/sam/Projects to keep the workspace's history. Your files stay where they are.",
    }));
  });
});
