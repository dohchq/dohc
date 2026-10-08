import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ToolContext } from "@dohc/mcp/tools";
import { describe, expect, it, vi } from "vitest";
import { createFirstAppFiles, firstAppRoot } from "./createFirstApp";

describe("first app creation", () => {
  it("creates parent folders before the shared starter files", async () => {
    const order: string[] = [];
    const createWorkspaceFolder = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      order.push(`folder:${relativePath}`);
      return { path: "app" };
    });
    const createWorkspaceFile = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      order.push(`file:${relativePath}`);
      return { path: "app/index.html" };
    });

    await expect(
      createFirstAppFiles({
        workspaceId: "ws-apps",
        files: [],
        folders: [],
        mutations: { createWorkspaceFile, createWorkspaceFolder, deleteWorkspacePath: vi.fn(async () => ({ trashed: true })) },
      }),
    ).resolves.toEqual({ root: "app" });

    expect(order).toEqual([
      "folder:app",
      "file:app/index.html",
      "file:app/styles.css",
      "file:app/script.js",
      "folder:app/scripts",
      "file:app/scripts/build-static.mjs",
      "file:app/package.json",
      "file:app/dohc.json",
    ]);
    expect(createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-apps",
      relativePath: "app/index.html",
      initialText: expect.stringContaining("<h1>My app</h1>"),
      exclusive: true,
    });
  });

  it("chooses another root when the existing app folder is not empty", async () => {
    const createWorkspaceFolder = vi.fn();
    const createWorkspaceFile = vi.fn(async () => ({ path: "app/index.html" }));

    await expect(
      createFirstAppFiles({
        workspaceId: "ws-apps",
        files: [{ path: "App/notes.txt", kind: "file" }],
        folders: ["App"],
        mutations: { createWorkspaceFile, createWorkspaceFolder, deleteWorkspacePath: vi.fn(async () => ({ trashed: true })) },
      }),
    ).resolves.toEqual({ root: "app-2" });

    expect(createWorkspaceFolder).toHaveBeenCalledWith({
      workspaceId: "ws-apps", relativePath: "app-2", exclusive: true,
    });
    expect(createWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "app-2/index.html" }),
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
        mutations: { createWorkspaceFile, createWorkspaceFolder, deleteWorkspacePath: vi.fn(async () => ({ trashed: true })) },
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
  it("chooses a fresh root even when a listed folder is empty", async () => {
    const createWorkspaceFolder = vi.fn(async () => ({ path: "App/scripts" }));
    const createWorkspaceFile = vi.fn(async () => ({ path: "App/index.html" }));
    await expect(createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: ["App"],
      mutations: { createWorkspaceFile, createWorkspaceFolder, deleteWorkspacePath: vi.fn(async () => ({ trashed: true })) },
    })).resolves.toEqual({ root: "app-2" });
    expect(createWorkspaceFolder.mock.calls).toEqual([
      [{ workspaceId: "ws-apps", relativePath: "app-2", exclusive: true }],
      [{ workspaceId: "ws-apps", relativePath: "app-2/scripts", exclusive: true }],
    ]);
  });

  it("refuses roots occupied by files or nested folders", () => {
    expect(firstAppRoot([{ path: "APP", kind: "file" }], [])).toBe("app-2");
    expect(firstAppRoot([], ["App", "App/notes"])).toBe("app-2");
    expect(firstAppRoot([{ path: "App/styles.css", kind: "file" }], ["App"])).toBe("app-2");
  });

  it("stops creating files when an authored write is refused", async () => {
    const createWorkspaceFolder = vi.fn(async () => ({ path: "app" }));
    const createWorkspaceFile = vi.fn(async () => { throw new Error("path refused"); });
    await expect(createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: [],
      mutations: { createWorkspaceFile, createWorkspaceFolder, deleteWorkspacePath: vi.fn(async () => ({ trashed: true })) },
    })).rejects.toThrow("path refused");
    expect(createWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it("writes the same common files as MCP for equivalent title and manifest options", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-app-source-parity-"));
    try {
      const desktopFiles: Record<string, string> = {};
      await createFirstAppFiles({
        workspaceId: "ws-apps", files: [], folders: [],
        mutations: {
          createWorkspaceFolder: async ({ relativePath }) => ({ path: relativePath }),
          deleteWorkspacePath: async () => ({ trashed: true }),
          createWorkspaceFile: async ({ relativePath, initialText }) => {
            desktopFiles[relativePath] = initialText ?? "";
            return { path: relativePath };
          },
        },
      });
      const mcpFiles: Record<string, string> = {};
      const request: NonNullable<ToolContext["request"]> = async (request) => {
        if (request.verb !== "fileWrite") throw new Error("unexpected operation");
        for (const file of request.args.files) {
          expect(file.createOnly).toBe(true);
          mcpFiles[file.path] = Buffer.from(file.contentBase64, "base64").toString("utf8");
        }
        return { ok: true, written: Object.keys(mcpFiles) };
      };
      await expect(createApp({ root: workspaceRoot, home: workspaceRoot, request }, {
        appRoot: "app", title: "My app", withDohcJson: true,
      })).resolves.toMatchObject({ ok: true });
      expect(desktopFiles).toEqual(mcpFiles);
      expect(Object.keys(desktopFiles)).toHaveLength(6);
      expect(JSON.parse(desktopFiles["app/dohc.json"]!)).toMatchObject({
        type: "app", preview: { mode: "static", entry: "index.html" },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
  it.each([false, true])("rolls back a third-file failure and preserves a pre-existing root: %s", async (rootExists) => {
    const files = new Set<string>();
    const folders = new Set(rootExists ? ["App"] : []);
    const initialRoot = rootExists ? "app-2" : "app";
    const failure = new Error("third file failed");
    let failThirdFile = true;
    let writes = 0;
    const createWorkspaceFolder = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      folders.add(relativePath);
      return { path: relativePath };
    });
    const createWorkspaceFile = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      writes += 1;
      if (failThirdFile && writes === 3) throw failure;
      files.add(relativePath);
      return { path: relativePath };
    });
    const deleteWorkspacePath = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      files.delete(relativePath);
      folders.delete(relativePath);
      return { trashed: true };
    });
    const mutations = { createWorkspaceFolder, createWorkspaceFile, deleteWorkspacePath };
    await expect(createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: [...folders], mutations,
    })).rejects.toBe(failure);
    expect(deleteWorkspacePath.mock.calls.map(([payload]) => payload.relativePath)).toEqual([
      `${initialRoot}/styles.css`, `${initialRoot}/index.html`, initialRoot,
    ]);
    expect([...files]).toEqual([]);
    expect([...folders]).toEqual(rootExists ? ["App"] : []);
    failThirdFile = false;
    await expect(createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: [...folders], mutations,
    })).resolves.toEqual({ root: initialRoot });
  });

  it("removes created child folders after a later failure", async () => {
    const createWorkspaceFolder = vi.fn(async ({ relativePath }: { relativePath: string }) => ({ path: relativePath }));
    const createWorkspaceFile = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath.endsWith("package.json")) throw new Error("package write failed");
      return { path: relativePath };
    });
    const deleteWorkspacePath = vi.fn(async () => ({ trashed: true }));
    await expect(createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: ["App"],
      mutations: { createWorkspaceFolder, createWorkspaceFile, deleteWorkspacePath },
    })).rejects.toThrow("package write failed");
    expect(deleteWorkspacePath.mock.calls).toEqual([
      [{ workspaceId: "ws-apps", relativePath: "app-2/scripts/build-static.mjs" }],
      [{ workspaceId: "ws-apps", relativePath: "app-2/scripts", emptyFolderOnly: true }],
      [{ workspaceId: "ws-apps", relativePath: "app-2/script.js" }],
      [{ workspaceId: "ws-apps", relativePath: "app-2/styles.css" }],
      [{ workspaceId: "ws-apps", relativePath: "app-2/index.html" }],
      [{ workspaceId: "ws-apps", relativePath: "app-2", emptyFolderOnly: true }],
    ]);
  });

  it("reports rollback failure and still attempts the remaining cleanup", async () => {
    const createFailure = new Error("third file failed");
    const rollbackFailure = new Error("cleanup failed");
    const createWorkspaceFolder = vi.fn(async () => ({ path: "app" }));
    const createWorkspaceFile = vi.fn(async () => ({ path: "app/index.html" }))
      .mockResolvedValueOnce({ path: "app/index.html" })
      .mockResolvedValueOnce({ path: "app/styles.css" })
      .mockRejectedValueOnce(createFailure);
    const deleteWorkspacePath = vi.fn(async () => ({ trashed: true })).mockRejectedValueOnce(rollbackFailure);
    const result = createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: [],
      mutations: { createWorkspaceFolder, createWorkspaceFile, deleteWorkspacePath },
    });
    await expect(result).rejects.toMatchObject({ cause: createFailure, errors: [createFailure, rollbackFailure] });
    expect(deleteWorkspacePath).toHaveBeenCalledTimes(3);
  });

});
