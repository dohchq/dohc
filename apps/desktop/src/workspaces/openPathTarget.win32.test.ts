import { describe, expect, it, vi } from "vitest";

// Windows path rules on any host: this module, and the containment helper it
// uses, run on node:path's win32 implementation.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.win32, default: actual.win32 };
});

const { resolveOpenPathTarget } = await import("./openPathTarget");

const home = "C:\\Users\\sam";
// Registered with a different letter case than the folder has on disk.
const work = { workspaceId: "ws-work", rootPath: "C:\\work" };
const entries: Record<string, "file" | "folder"> = {
  [home]: "folder",
  "C:\\Work": "folder",
  "C:\\Work\\Notes\\a.md": "file",
  "C:\\Users\\sam\\Downloads\\notes.md": "file",
  "C:\\Users\\sam\\todo.txt": "file",
  "C:\\todo.txt": "file",
  "D:\\Work\\a.md": "file",
};
const canonical = new Map(Object.keys(entries).map((path) => [path.toLowerCase(), path]));

function resolve(path: string) {
  return resolveOpenPathTarget(path, {
    workspaces: [work], home, platform: "win32",
    fs: {
      // Windows realpath answers in the on-disk case.
      realPath: (candidate) => canonical.get(candidate.toLowerCase()) ?? null,
      kindOf: (candidate) => entries[candidate] ?? null,
      hasManifest: () => false,
    },
  });
}

describe("resolveOpenPathTarget on Windows", () => {
  it("finds a file in a workspace registered in another letter case, with a forward-slash file path", () => {
    expect(resolve("c:\\WORK\\notes\\A.md")).toEqual({ kind: "workspace", workspace: work, file: "Notes/a.md" });
  });

  it("keeps another drive outside the workspace", () => {
    expect(resolve("D:\\Work\\a.md")).toEqual({ kind: "folder", rootPath: "D:\\Work", hasManifest: false, file: "a.md" });
  });

  it("names a new folder in its Windows form", () => {
    expect(resolve("C:\\Users\\sam\\Downloads\\notes.md"))
      .toEqual({ kind: "folder", rootPath: "C:\\Users\\sam\\Downloads", hasManifest: false, file: "notes.md" });
  });

  it("refuses the home folder and a drive's top folder", () => {
    expect(() => resolve("C:\\Users\\sam\\todo.txt")).toThrow("Your home folder cannot be a workspace.");
    expect(() => resolve("c:\\todo.txt")).toThrow("The top folder of a disk cannot be a workspace.");
  });
});
