import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isInside, isInsideOrUnknown, isInsideOrUnknownSync, type ContainmentStat } from "./pathContainment";

const root = join(process.cwd(), "containment-root");

describe.each(["sync", "async"] as const)("isInsideOrUnknown (%s)", (mode) => {
  const check = (parent: string, child: string, statPath: ContainmentStat) => mode === "sync"
    ? isInsideOrUnknownSync(parent, child, statPath, posix)
    : isInsideOrUnknown(parent, child, async (value, options) => statPath(value, options), posix);

  it("accepts exact containment without stat", async () => {
    const statPath = vi.fn<ContainmentStat>();
    expect(await check("/work/Work", "/work/Work", statPath)).toBe(true);
    expect(await check("/work/Work/", "/work/Work/sub/file", statPath)).toBe(true);
    expect(statPath).not.toHaveBeenCalled();
  });

  it("accepts folded containment only when the ancestor has the same identity", async () => {
    const statPath = vi.fn<ContainmentStat>(() => ({ dev: 2n, ino: 9007199254740993n }));
    expect(await check("/work/Work/A/", "/work/work/A/sub/file", statPath)).toBe(true);
    expect(statPath.mock.calls).toEqual([["/work/Work/A/", { bigint: true }], ["/work/work/A", { bigint: true }]]);
  });

  it.each([{ dev: 2n, ino: 4n }, { dev: 3n, ino: 3n }])("rejects distinct folders with identity %s", async (other) => {
    const statPath = vi.fn<ContainmentStat>((value) => value === "/work/Work" ? { dev: 2n, ino: 3n } : other);
    expect(await check("/work/Work", "/work/work/file", statPath)).toBe(false);
    expect(statPath).toHaveBeenCalledTimes(2);
  });

  it("rejects ordinary outside paths, shorter paths, other roots, and relative paths without stat", async () => {
    const statPath = vi.fn<ContainmentStat>();
    for (const [parent, child] of [["/work/Work", "/work/sibling/file"], ["/work/Work", "/work"], ["/work/Work", "relative/file"], ["relative", "/work/file"]]) {
      expect(await check(parent!, child!, statPath)).toBe(false);
    }
    expect(isInsideOrUnknownSync("C:\\Work", "D:\\work\\file", statPath)).toBe(false);
    expect(statPath).not.toHaveBeenCalled();
  });

  it.each(["/work/Work", "/work/work"])("treats a stat error at %s as inside", async (failedPath) => {
    const statPath = vi.fn<ContainmentStat>((value) => {
      if (value === failedPath) throw new Error("cannot check identity");
      return { dev: 2n, ino: 3n };
    });
    expect(await check("/work/Work", "/work/work/file", statPath)).toBe(true);
  });

  it("uses full segment folding and preserves the ancestor's depth", async () => {
    const statPath = vi.fn<ContainmentStat>(() => ({ dev: 2n, ino: 3n }));
    expect(await check("/work/Straße/A", "/work/STRASSE/A/file", statPath)).toBe(true);
    expect(statPath).toHaveBeenCalledWith("/work/STRASSE/A", { bigint: true });
  });

  it("recognizes a case alias of the same folder on disk", async (context) => {
    const disk = mkdtempSync(join(tmpdir(), "dohc-containment-case-"));
    try {
      const parent = join(disk, "Work");
      mkdirSync(parent);
      if (!existsSync(join(disk, "work"))) context.skip();
      const child = join(disk, "work", "not-created", "file");
      expect(await (mode === "sync" ? isInsideOrUnknownSync(parent, child) : isInsideOrUnknown(parent, child))).toBe(true);
      expect(statSync(parent, { bigint: true }).ino).toBe(statSync(join(disk, "work"), { bigint: true }).ino);
    } finally { rmSync(disk, { recursive: true, force: true }); }
  });
});

describe("isInside", () => {
  it("counts the parent itself as inside", () => {
    expect(isInside(root, root)).toBe(true);
  });

  it("counts equality after normalization as inside", () => {
    // A trailing separator names the same directory.
    expect(isInside(`${root}${sep}`, root)).toBe(true);
    expect(isInside(root, `${root}${sep}`)).toBe(true);
  });

  it("accepts direct children and deep descendants", () => {
    expect(isInside(root, join(root, "child"))).toBe(true);
    expect(isInside(root, join(root, "a", "b", "c.txt"))).toBe(true);
  });

  it("rejects the parent of the root, siblings, and unrelated paths", () => {
    expect(isInside(root, join(root, ".."))).toBe(false);
    expect(isInside(root, join(root, "..", "sibling"))).toBe(false);
    expect(isInside(join(root, "a"), join(root, "b"))).toBe(false);
  });

  it("rejects an escape that climbs out and back down", () => {
    expect(isInside(root, join(root, "..", "..", "elsewhere", "x"))).toBe(false);
  });

  it("counts a child under a '..'-prefixed NAME as inside — '..' must be a whole segment", () => {
    expect(isInside(root, join(root, "..cache"))).toBe(true);
    expect(isInside(root, join(root, "..cache", "server.mjs"))).toBe(true);
  });

  it("rejects a case-distinct POSIX sibling", () => {
    expect(isInside("/work/WS", "/work/ws/file")).toBe(false);
    expect(isInside("/work/WS", "/work/WS/file")).toBe(true);
  });

  if (process.platform === "win32") {
    it("rejects a child on another drive", () => {
      expect(isInside("C:\\ws", "D:\\evil")).toBe(false);
      expect(isInside("C:\\ws", "D:\\evil\\x")).toBe(false);
    });

    it("rejects a case-distinct Windows sibling", () => {
      expect(isInside("C:\\work\\WS", "C:\\work\\ws\\file")).toBe(false);
      expect(isInside("C:\\work\\WS", "C:\\work\\WS\\file")).toBe(true);
    });
  }
});
