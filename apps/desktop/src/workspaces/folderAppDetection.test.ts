import { describe, expect, it, vi } from "vitest";
import { createFolderAppDetection, detectFolderApp } from "./folderAppDetection";
import { FolderAppPayload } from "../ipc/bridgeContract";
const workspace = { workspaceId: "one", attachmentId: Symbol("one") };

describe("folder app recognition", () => {
  it("recognizes the affected folder without recognizing its neighbor or writing a manifest", () => {
    expect(detectFolderApp("one", "app", ["app/index.html", "other/index.html"])).toEqual({
      workspaceId: "one", folder: "app", isApp: true,
      run: { path: "app", entryPath: "app/index.html", previewMode: null },
    });
    expect(detectFolderApp("one", "notes", ["notes/readme.md", "other/index.html"]).isApp).toBe(false);
    expect(detectFolderApp("one", "app", ["app/nested/index.html"]).isApp).toBe(false);
  });
  it("recognizes configured apps and web packages using the existing discovery rules", () => {
    expect(detectFolderApp("one", "app", [{ path: "app/dohc.json", body: JSON.stringify({ type: "app", preview: { entry: "home.html", mode: "static" } }) }, "app/home.html"]).run)
      .toEqual({ path: "app", entryPath: "app/home.html", previewMode: "static" });
    expect(detectFolderApp("one", "app", [{ path: "app/package.json", body: JSON.stringify({ dependencies: { vite: "*" }, scripts: { dev: "vite" } }) }]).isApp).toBe(true);
    expect(detectFolderApp("one", "app", [{ path: "app/package.json", body: "{}" }]).isApp).toBe(false);
  });
  it("coalesces duplicate events and concurrent renderer reads to one scoped scan", async () => {
    const sources = vi.fn(async (_workspace, folder: string) => [folder + "/index.html"]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }, { path: "app/dohc.json", operation: "update" }]);
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }]);
    expect((await service.read(workspace, "app")).isApp).toBe(true);
    expect(sources).toHaveBeenCalledExactlyOnceWith(workspace, "app");
    await service.read(workspace, "app");
    expect(sources).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    await service.retire(workspace.attachmentId);
  });
  it("rescans after an event during an in-flight read before returning an answer", async () => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockImplementationOnce(() => { started(); return new Promise<string[]>(resolve => { release = resolve; }); }).mockResolvedValue([]);
    const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
    const answer = service.read(workspace, "app");
    await ready;
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "delete" }]);
    release(["app/index.html"]);
    expect((await answer).isApp).toBe(false);
    expect(sources).toHaveBeenCalledTimes(2);
    await service.retire(workspace.attachmentId);
  });
  it("invalidates the containing app on nested changes, deletion, and build output events", async () => {
    const sources = vi.fn(async () => ["app/dist/index.html"]);
    const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
    await service.read(workspace, "app");
    service.settledEvents(workspace, [{ path: "app/dist/index.html", operation: "update" }]);
    expect((await service.read(workspace, "app")).run?.entryPath).toBe("app/dist/index.html");
    expect(sources.mock.calls.length).toBeGreaterThan(1);
    await service.retire(workspace.attachmentId);
  });
  it("isolates attachments reusing the workspace id and drains retirement", async () => {
    const sources = vi.fn(async () => ["app/index.html"]);
    const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
    await service.read(workspace, "app");
    await service.read({ ...workspace, attachmentId: Symbol("replacement") }, "app");
    expect(sources).toHaveBeenCalledTimes(2);
    await service.retire(workspace.attachmentId);
    await service.read(workspace, "app");
    expect(sources).toHaveBeenCalledTimes(3);
  });
  it("rejects traversal and accepts a root-folder read", () => {
    expect(FolderAppPayload.safeParse({ workspaceId: "one", folder: "../other" }).success).toBe(false);
    expect(FolderAppPayload.safeParse({ workspaceId: "one", folder: "." }).success).toBe(true);
  });
});
