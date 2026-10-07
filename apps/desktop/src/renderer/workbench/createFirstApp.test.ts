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
        mutations: { createWorkspaceFile, createWorkspaceFolder },
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
    ]);
    expect(createWorkspaceFile).toHaveBeenCalledWith({
      workspaceId: "ws-apps",
      relativePath: "app/index.html",
      initialText: expect.stringContaining("<h1>My app</h1>"),
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
        mutations: { createWorkspaceFile, createWorkspaceFolder },
      }),
    ).resolves.toEqual({ root: "app-2" });

    expect(createWorkspaceFolder).toHaveBeenCalledWith({
      workspaceId: "ws-apps", relativePath: "app-2",
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
  it("reuses an empty folder with its existing casing", async () => {
    const createWorkspaceFolder = vi.fn(async () => ({ path: "App/scripts" }));
    const createWorkspaceFile = vi.fn(async () => ({ path: "App/index.html" }));
    await expect(createFirstAppFiles({
      workspaceId: "ws-apps", files: [], folders: ["App"],
      mutations: { createWorkspaceFile, createWorkspaceFolder },
    })).resolves.toEqual({ root: "App" });
    expect(createWorkspaceFolder.mock.calls).toEqual([[{ workspaceId: "ws-apps", relativePath: "App/scripts" }]]);
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
      mutations: { createWorkspaceFile, createWorkspaceFolder },
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
        appRoot: "app", title: "My app", withDohcJson: false,
      })).resolves.toMatchObject({ ok: true });
      expect(desktopFiles).toEqual(mcpFiles);
      expect(Object.keys(desktopFiles)).toHaveLength(5);
      expect(desktopFiles).not.toHaveProperty("app/dohc.json");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
