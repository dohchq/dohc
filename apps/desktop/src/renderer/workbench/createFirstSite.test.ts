import { describe, expect, it, vi } from "vitest";
import { createFirstSiteFiles, firstSiteRoot } from "./createFirstSite";

describe("first site creation", () => {
  it("creates a folder before its source file", async () => {
    const order: string[] = [];
    const createWorkspaceFolder = vi.fn(async () => {
      order.push("folder");
      return { path: "site" };
    });
    const createWorkspaceFile = vi.fn(async () => {
      order.push("file");
      return { path: "site/index.html" };
    });

    await expect(
      createFirstSiteFiles({
        workspaceId: "ws-sites",
        files: [],
        folders: [],
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).resolves.toEqual({ root: "site" });

    expect(order).toEqual(["folder", "file"]);
    expect(createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-sites",
      relativePath: "site/index.html",
      initialText: expect.stringContaining("<h1>My site</h1>"),
    });
  });

  it("uses an existing site folder when only its entry file is missing", async () => {
    const createWorkspaceFolder = vi.fn();
    const createWorkspaceFile = vi.fn(async () => ({ path: "site/index.html" }));

    await expect(
      createFirstSiteFiles({
        workspaceId: "ws-sites",
        files: [{ path: "Site/notes.txt", kind: "file" }],
        folders: ["Site"],
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).resolves.toEqual({ root: "Site" });

    expect(createWorkspaceFolder).not.toHaveBeenCalled();
    expect(createWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "Site/index.html" }),
    );
  });

  it("does not write an entry file when its folder could not be created", async () => {
    const createWorkspaceFolder = vi.fn(async () => {
      throw new Error("disk full");
    });
    const createWorkspaceFile = vi.fn();

    await expect(
      createFirstSiteFiles({
        workspaceId: "ws-sites",
        files: [],
        folders: [],
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).rejects.toThrow("disk full");

    expect(createWorkspaceFile).not.toHaveBeenCalled();
  });

  it("chooses another root when the usual entry path already exists", () => {
    expect(
      firstSiteRoot(
        [{ path: "SITE/index.html", kind: "file" }],
        ["SITE"],
      ),
    ).toBe("site-2");
  });
});
