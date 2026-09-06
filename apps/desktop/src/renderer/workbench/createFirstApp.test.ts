import { describe, expect, it, vi } from "vitest";
import { createFirstAppFiles, firstAppRoot } from "./createFirstApp";

describe("first app creation", () => {
  it("creates a folder before its source file", async () => {
    const order: string[] = [];
    const createWorkspaceFolder = vi.fn(async () => {
      order.push("folder");
      return { path: "app" };
    });
    const createWorkspaceFile = vi.fn(async () => {
      order.push("file");
      return { path: "app/index.html" };
    });

    await expect(
      createFirstAppFiles({
        workspaceId: "ws-apps",
        files: [],
        folders: [],
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).resolves.toEqual({ root: "app" });

    expect(order).toEqual(["folder", "file"]);
    expect(createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-apps",
      relativePath: "app/index.html",
      initialText: expect.stringContaining("<h1>My app</h1>"),
    });
  });

  it("uses an existing app folder when only its entry file is missing", async () => {
    const createWorkspaceFolder = vi.fn();
    const createWorkspaceFile = vi.fn(async () => ({ path: "app/index.html" }));

    await expect(
      createFirstAppFiles({
        workspaceId: "ws-apps",
        files: [{ path: "App/notes.txt", kind: "file" }],
        folders: ["App"],
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).resolves.toEqual({ root: "App" });

    expect(createWorkspaceFolder).not.toHaveBeenCalled();
    expect(createWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "App/index.html" }),
    );
  });

  it("does not write an entry file when its folder could not be created", async () => {
    const createWorkspaceFolder = vi.fn(async () => {
      throw new Error("disk full");
    });
    const createWorkspaceFile = vi.fn();

    await expect(
      createFirstAppFiles({
        workspaceId: "ws-apps",
        files: [],
        folders: [],
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).rejects.toThrow("disk full");

    expect(createWorkspaceFile).not.toHaveBeenCalled();
  });

  it("chooses another root when the usual entry path already exists", () => {
    expect(
      firstAppRoot(
        [{ path: "APP/index.html", kind: "file" }],
        ["APP"],
      ),
    ).toBe("app-2");
  });
});
