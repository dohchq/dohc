import { describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "../testing/deferred";
import { confirmOpenPathWorkspace, createOpenPathOpener, resolveOpenPathTarget, type OpenPathFileSystem } from "./openPathTarget";

const home = "/Users/sam";
const notes = { workspaceId: "ws-notes", rootPath: "/Users/sam/dohc/notes" };
const nested = { workspaceId: "ws-trip", rootPath: "/Users/sam/dohc/notes/trip" };

// A case-insensitive disk, as macOS formats by default: realPath answers in
// the on-disk case, and `aliases` are links to another path.
function disk(
  entries: Record<string, "file" | "folder">,
  manifests: string[] = [],
  aliases: Record<string, string> = {},
): OpenPathFileSystem {
  const canonical = new Map(Object.keys(entries).map((path) => [path.toLowerCase(), path]));
  return {
    realPath: (path) => canonical.get((aliases[path] ?? path).toLowerCase()) ?? null,
    kindOf: (path) => entries[path] ?? null,
    hasManifest: (folder) => manifests.includes(folder),
  };
}

const base = {
  [home]: "folder", "/Users/sam/dohc/notes": "folder", "/Users/sam/dohc/notes/trip": "folder",
} as const;

function resolve(path: string, entries: Record<string, "file" | "folder">, manifests: string[] = [], aliases: Record<string, string> = {}) {
  return resolveOpenPathTarget(path, {
    workspaces: [notes, nested], home, platform: "darwin", fs: disk({ ...base, ...entries }, manifests, aliases),
  });
}

describe("resolveOpenPathTarget", () => {
  it("opens a file inside a registered workspace in that workspace, deepest first", () => {
    expect(resolve("/Users/sam/dohc/notes/plans/q3.md", { "/Users/sam/dohc/notes/plans/q3.md": "file" }))
      .toEqual({ kind: "workspace", workspace: notes, file: "plans/q3.md" });
    expect(resolve("/Users/sam/dohc/notes/trip/day-1.md", { "/Users/sam/dohc/notes/trip/day-1.md": "file" }))
      .toEqual({ kind: "workspace", workspace: nested, file: "day-1.md" });
    // A sibling whose name starts like the root is not inside it.
    expect(resolve("/Users/sam/dohc/notes-old/a.md", { "/Users/sam/dohc/notes-old/a.md": "file" }))
      .toEqual({ kind: "folder", rootPath: "/Users/sam/dohc/notes-old", hasManifest: false, file: "a.md" });
  });

  it("compares canonical paths, as the registry does, whatever case or link names them", () => {
    expect(resolve("/USERS/Sam/DOHC/Notes/Plans/Q3.md", { "/Users/sam/dohc/notes/plans/q3.md": "file" }))
      .toEqual({ kind: "workspace", workspace: notes, file: "plans/q3.md" });
    expect(resolve("/Users/sam/Desktop/notes-link/a.md", { "/Users/sam/dohc/notes/a.md": "file" }, [], {
      "/Users/sam/Desktop/notes-link/a.md": "/Users/sam/dohc/notes/a.md",
    })).toEqual({ kind: "workspace", workspace: notes, file: "a.md" });
  });

  it("opens a folder of a workspace without a file, and nothing for a path that is not there", () => {
    expect(resolve("/Users/sam/dohc/notes/plans", { "/Users/sam/dohc/notes/plans": "folder" }))
      .toEqual({ kind: "workspace", workspace: notes, file: null });
    expect(resolve("/Users/sam/gone.md", {})).toBeNull();
    expect(resolve("relative/a.md", { "relative/a.md": "file" })).toBeNull();
  });

  it("opens the workspace but no tab for a file in its .dohc folder", () => {
    expect(resolve("/Users/sam/dohc/notes/.dohc/manifest.json", { "/Users/sam/dohc/notes/.dohc/manifest.json": "file" }))
      .toEqual({ kind: "workspace", workspace: notes, file: null });
  });

  it("names the nearest folder that already has a dohc manifest", () => {
    expect(resolve("/Volumes/Work/project/docs/a.md", { "/Volumes/Work/project/docs/a.md": "file" }, ["/Volumes/Work/project"]))
      .toEqual({ kind: "folder", rootPath: "/Volumes/Work/project", hasManifest: true, file: "docs/a.md" });
  });

  it("names the file's own folder when no workspace holds it", () => {
    const file = { "/Users/sam/Downloads/notes.md": "file" } as const;
    expect(resolve("/Users/sam/Downloads/notes.md", file))
      .toEqual({ kind: "folder", rootPath: "/Users/sam/Downloads", hasManifest: false, file: "notes.md" });
    // A manifest in the home folder is one dohc cannot use, so it is passed over.
    expect(resolve("/Users/sam/Downloads/notes.md", file, [home]))
      .toEqual({ kind: "folder", rootPath: "/Users/sam/Downloads", hasManifest: false, file: "notes.md" });
  });

  it("refuses the home folder and the top folder of a disk, as the folder picker does", () => {
    expect(() => resolve("/Users/sam/todo.txt", { "/Users/sam/todo.txt": "file" }))
      .toThrow("Your home folder cannot be a workspace. Move the file into a folder, then open it again.");
    expect(() => resolve("/users/SAM", {}))
      .toThrow("Your home folder cannot be a workspace. Open a folder inside it.");
    expect(() => resolve("/todo.txt", { "/todo.txt": "file" }))
      .toThrow("The top folder of a disk cannot be a workspace. Move the file into a folder, then open it again.");
  });
});

function opener(entries: Record<string, "file" | "folder">, manifests: string[] = []) {
  const workspaces: { workspaceId: string; rootPath: string }[] = [notes];
  const answers: Deferred<boolean>[] = [];
  const deps = {
    confirm: vi.fn(() => {
      const answer = deferred<boolean>();
      answers.push(answer);
      return answer.promise;
    }),
    register: vi.fn(async (rootPath: string) => {
      const workspace = { workspaceId: `ws-${workspaces.length}`, rootPath };
      workspaces.push(workspace);
      return workspace;
    }),
    activate: vi.fn(async () => undefined),
  };
  const open = createOpenPathOpener<{ workspaceId: string; rootPath: string }, string>({
    workspaces: () => workspaces, home: () => home, platform: "darwin",
    fs: disk({ ...base, ...entries }, manifests), ...deps,
  });
  return { open, answers, ...deps };
}

describe("createOpenPathOpener", () => {
  it("asks once and registers once for files opened together from one new folder", async () => {
    const h = opener({ "/Users/sam/Downloads": "folder", "/Users/sam/Downloads/a.md": "file", "/Users/sam/Downloads/b.md": "file" });
    const first = h.open("/Users/sam/Downloads/a.md", "window");
    const second = h.open("/Users/sam/Downloads/b.md", "window");
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    h.answers[0]!.resolve(true);
    const downloads = { workspaceId: "ws-1", rootPath: "/Users/sam/Downloads" };
    await expect(first).resolves.toEqual(downloads);
    await expect(second).resolves.toEqual(downloads);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.activate.mock.calls).toEqual([[downloads, "a.md", "window"], [downloads, "b.md", "window"]]);
  });

  it("asks before a folder that already has a manifest, and Cancel opens nothing", async () => {
    const h = opener({ "/Users/sam/unzipped": "folder", "/Users/sam/unzipped/a.md": "file" }, ["/Users/sam/unzipped"]);
    const opened = h.open("/Users/sam/unzipped/a.md");
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledWith(
      { kind: "folder", rootPath: "/Users/sam/unzipped", hasManifest: true, file: "a.md" }, undefined));
    h.answers[0]!.resolve(false);
    await expect(opened).resolves.toBeNull();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("opens a registered workspace without asking, after a failed open", async () => {
    const h = opener({ "/Users/sam/dohc/notes/a.md": "file", "/Users/sam/todo.txt": "file" });
    await expect(h.open("/Users/sam/todo.txt")).rejects.toThrow("Your home folder cannot be a workspace.");
    await expect(h.open("/Users/sam/dohc/notes/a.md")).resolves.toEqual(notes);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.activate).toHaveBeenCalledWith(notes, "a.md", undefined);
  });
});

describe("confirmOpenPathWorkspace", () => {
  it("names the folder and what dohc writes there, and only Open as workspace agrees", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    await expect(confirmOpenPathWorkspace({ showMessageBox }, {
      rootPath: "/Users/sam/Downloads", hasManifest: false, file: "notes.md",
    })).resolves.toBe(true);
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
    await expect(confirmOpenPathWorkspace({ showMessageBox }, {
      rootPath: "/Users/sam/unzipped", hasManifest: true, file: null,
    })).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      detail: "/Users/sam/unzipped already has a .dohc folder. dohc keeps the workspace's history there. "
        + "Your files stay where they are.",
    }));
  });
});
