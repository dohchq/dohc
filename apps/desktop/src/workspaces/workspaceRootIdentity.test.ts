import { describe, expect, it, vi } from "vitest";

// These are Linux folders, so the module and the containment helper it uses
// run on node:path's posix rules on any host.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.posix, default: actual.posix };
});
import { caseFoldDisk } from "../testing/caseFoldDisk";
import {
  deepestRoot,
  deepestRootSync,
  folderIdentity,
  folderIdentityKey,
  folderIdentityOf,
  folderIdentitySync,
  pathUnderRoot,
  sameFolder,
  type FolderIdentity,
} from "./workspaceRootIdentity";

// Folders under /home ignore capitals, as ext4 casefold folders do. / and /srv do not.
const disk = caseFoldDisk({
  "/home/sam/Notes/plans/q3.md": "file",
  "/home/sam/Notes/Trip/day-1.md": "file",
  "/home/sam/Notes-old/a.md": "file",
  "/srv/Notes/a.md": "file",
  "/srv/notes/a.md": "file",
}, { foldsCase: (folder) => folder === "/home" || folder.startsWith("/home/") });
const identify = (path: string) => folderIdentitySync(path, disk.stat);
const list = disk.names;
const roots = (...paths: string[]) => paths.map((path) => ({ entry: path, path }));

describe("a folder's identity", () => {
  it("is one for every spelling a folder that ignores capitals answers to", () => {
    expect(disk.realPath("/home/sam/NOTES")).toBe("/home/sam/NOTES");
    expect(identify("/home/sam/NOTES")).toEqual(identify("/home/sam/Notes"));
    expect(sameFolder(identify("/home/sam/notes"), identify("/home/sam/Notes"))).toBe(true);
  });

  it("keeps two folders apart when their disk tells capitals apart", () => {
    expect(sameFolder(identify("/srv/Notes"), identify("/srv/notes"))).toBe(false);
  });

  it("is unknown for a file, a missing path, a stat error and a zero inode, and unknown matches nothing", async () => {
    expect(identify("/srv/Notes/a.md")).toBeNull();
    expect(identify("/home/sam/gone")).toBeNull();
    expect(folderIdentityOf({ dev: 1n, ino: 0n, isDirectory: () => true })).toBeNull();
    await expect(folderIdentity("/x", () => Promise.reject(new Error("EACCES")))).resolves.toBeNull();
    expect(sameFolder(null, null)).toBe(false);
    expect(sameFolder(null, { dev: 1n, ino: 1n })).toBe(false);
  });

  it("tells apart the same inode on another device, and numbers past Number's safe range", () => {
    const big = 2n ** 53n;
    expect(Number(big) === Number(big + 1n)).toBe(true);
    const a: FolderIdentity = { dev: big, ino: big };
    expect(sameFolder(a, { dev: big, ino: big + 1n })).toBe(false);
    expect(sameFolder(a, { dev: big + 1n, ino: big })).toBe(false);
    expect(sameFolder(a, { dev: big, ino: big })).toBe(true);
    expect(folderIdentityKey(a)).not.toBe(folderIdentityKey({ dev: big, ino: big + 1n }));
  });

  it("reads the disk again each time, so a replaced folder is another folder", () => {
    let ino = 7n;
    const statPath = vi.fn(() => ({ dev: 1n, ino, isDirectory: () => true }));
    const before = folderIdentitySync("/home/sam/Notes", statPath);
    ino = 8n;
    expect(sameFolder(before, folderIdentitySync("/home/sam/Notes", statPath))).toBe(false);
    expect(statPath).toHaveBeenCalledTimes(2);
  });
});

describe("deepestRootSync", () => {
  it("finds a root through other capitals and keeps the path's own spelling as the anchor", () => {
    expect(deepestRootSync("/home/sam/NOTES/plans", roots("/home/sam/Notes"), identify, list))
      .toEqual({ entry: "/home/sam/Notes", root: "/home/sam/Notes", anchor: "/home/sam/NOTES" });
    expect(deepestRootSync("/HOME/sam/notes", roots("/home/sam/Notes"), identify, list)).toBeNull();
    expect(deepestRootSync("/home/SAM/notes", roots("/home/sam/Notes"), identify, list))
      .toMatchObject({ entry: "/home/sam/Notes", anchor: "/home/SAM/notes" });
  });

  it("picks the deepest root, even when only the outer one is spelled as the path", () => {
    expect(deepestRootSync("/home/sam/Notes/TRIP", roots("/home/sam/Notes", "/home/sam/Notes/Trip"), identify, list))
      .toMatchObject({ entry: "/home/sam/Notes/Trip", anchor: "/home/sam/Notes/TRIP" });
  });

  it("refuses a sibling whose name starts like the root, and another folder spelled with other capitals", () => {
    expect(deepestRootSync("/home/sam/notes-old", roots("/home/sam/Notes"), identify, list)).toBeNull();
    expect(deepestRootSync("/srv/notes", roots("/srv/Notes"), identify, list)).toBeNull();
  });

  it("matches nothing through a folder whose identity is unknown", () => {
    const unknown = caseFoldDisk({ "/home/sam/Notes/a.md": "file" }, {
      foldsCase: () => true, identities: { "/home/sam/Notes": { dev: 1n, ino: 0n } },
    });
    expect(deepestRootSync("/home/sam/NOTES", roots("/home/sam/Notes"), (path) => folderIdentitySync(path, unknown.stat), unknown.names))
      .toBeNull();
    // Spelling still matches as it always has.
    expect(deepestRootSync("/home/sam/Notes", roots("/home/sam/Notes"), () => null))
      .toMatchObject({ entry: "/home/sam/Notes" });
  });

  it("keeps roots whose stat numbers only differ past Number's safe range apart", () => {
    const big = 2n ** 53n;
    const wide = caseFoldDisk({ "/srv/Notes/a.md": "file", "/srv/notes/a.md": "file" }, {
      foldsCase: () => false,
      identities: { "/srv/Notes": { dev: big, ino: big }, "/srv/notes": { dev: big, ino: big + 1n } },
    });
    expect(deepestRootSync("/srv/notes", roots("/srv/Notes"), (path) => folderIdentitySync(path, wide.stat), wide.names))
      .toBeNull();
  });

  it("does not match a root reached under another name, as through a bind mount", () => {
    // /view/notes is /data/Notes mounted again. A mount inside either one can
    // put another file at the same place below it.
    const mounted = caseFoldDisk({ "/data/Notes/docs/a.md": "file", "/view/notes/docs/a.md": "file" }, {
      foldsCase: () => false,
      identities: { "/data/Notes": { dev: 5n, ino: 5n }, "/view/notes": { dev: 5n, ino: 5n } },
    });
    const probe = vi.fn((path: string) => folderIdentitySync(path, mounted.stat));
    expect(deepestRootSync("/view/notes/docs/a.md", roots("/data/Notes"), probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not match a root mounted again under other capitals on a disk that tells capitals apart", () => {
    // /srv lists both Notes and notes, so they are two entries even though
    // they are one folder, and a mount inside one may be missing in the other.
    const mounted = caseFoldDisk({ "/srv/Notes/docs/a.md": "file", "/srv/notes/docs/a.md": "file" }, {
      foldsCase: () => false,
      identities: { "/srv/Notes": { dev: 5n, ino: 5n }, "/srv/notes": { dev: 5n, ino: 5n } },
    });
    expect(deepestRootSync("/srv/notes/docs", roots("/srv/Notes"), (path) => folderIdentitySync(path, mounted.stat), mounted.names))
      .toBeNull();
  });

  it("picks the root the path respells over the same folder registered under another name", () => {
    const twice = caseFoldDisk({ "/home/sam/Notes/a.md": "file", "/view/notes/a.md": "file" }, {
      foldsCase: (folder) => folder.startsWith("/home"),
      identities: { "/home/sam/Notes": { dev: 5n, ino: 5n }, "/view/notes": { dev: 5n, ino: 5n } },
    });
    const probe = (path: string) => folderIdentitySync(path, twice.stat);
    expect(deepestRootSync("/home/sam/NOTES/a.md", roots("/home/sam/Notes", "/view/notes"), probe, twice.names))
      .toMatchObject({ entry: "/home/sam/Notes", anchor: "/home/sam/NOTES" });
  });

  it("matches nothing through other capitals when the folder holding the name cannot be read", () => {
    expect(deepestRootSync("/home/sam/NOTES", roots("/home/sam/Notes"), identify, () => null)).toBeNull();
  });

  it("reads nothing from the disk for a path spelled under its root", () => {
    const probe = vi.fn(identify);
    const listing = vi.fn(list);
    expect(deepestRootSync("/home/sam/Notes/Trip/day-1.md", roots("/home/sam/Notes", "/srv/Notes"), probe, listing))
      .toMatchObject({ entry: "/home/sam/Notes", anchor: "/home/sam/Notes" });
    expect(probe).not.toHaveBeenCalled();
    expect(listing).not.toHaveBeenCalled();
  });

  it("matches nothing when two registered roots are one folder and neither is spelled as the path", () => {
    expect(deepestRootSync("/home/sam/NOTES", roots("/home/sam/Notes", "/home/sam/notes"), identify, list)).toBeNull();
  });
});

describe("pathUnderRoot", () => {
  const identifyAsync = async (path: string) => identify(path);
  const listAsync = async (path: string) => list(path);

  it("moves a path from other capitals onto the root's spelling, keeping the rest as given", async () => {
    await expect(pathUnderRoot("/home/sam/Notes", "/home/sam/NOTES/plans/q3.md", identifyAsync, listAsync))
      .resolves.toBe("/home/sam/Notes/plans/q3.md");
    await expect(pathUnderRoot("/home/sam/Notes", "/home/sam/notes", identifyAsync, listAsync)).resolves.toBe("/home/sam/Notes");
  });

  it("returns a path spelled inside the root unchanged, without a stat", async () => {
    const probe = vi.fn(identifyAsync);
    await expect(pathUnderRoot("/home/sam/Notes", "/home/sam/Notes/plans", probe)).resolves.toBe("/home/sam/Notes/plans");
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a path outside the root, a sibling, and another folder on a disk that tells capitals apart", async () => {
    await expect(pathUnderRoot("/home/sam/Notes", "/home/sam", identifyAsync, listAsync)).resolves.toBeNull();
    await expect(pathUnderRoot("/home/sam/Notes", "/home/sam/NOTES-old/a.md", identifyAsync, listAsync)).resolves.toBeNull();
    await expect(pathUnderRoot("/srv/Notes", "/srv/notes/a.md", identifyAsync, listAsync)).resolves.toBeNull();
    const mounted = caseFoldDisk({ "/data/Notes/docs/a.md": "file", "/view/notes/docs/a.md": "file" }, {
      foldsCase: () => false,
      identities: { "/data/Notes": { dev: 5n, ino: 5n }, "/view/notes": { dev: 5n, ino: 5n } },
    });
    await expect(pathUnderRoot("/data/Notes", "/view/notes/docs", async (path) => folderIdentitySync(path, mounted.stat)))
      .resolves.toBeNull();
  });

  it("agrees with deepestRootSync", async () => {
    await expect(deepestRoot("/home/sam/Notes/TRIP", roots("/home/sam/Notes", "/home/sam/Notes/Trip"), identifyAsync, listAsync))
      .resolves.toEqual(deepestRootSync("/home/sam/Notes/TRIP", roots("/home/sam/Notes", "/home/sam/Notes/Trip"), identify, list));
  });
});
