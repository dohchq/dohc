import { describe, expect, it, vi } from "vitest";
import { createFolderAppDetection, detectFolderApp, MAX_REQUESTED_APP_FOLDERS } from "./folderAppDetection";
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
    const reading = service.read(workspace, "app");
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }, { path: "app/dohc.json", operation: "update" }]);
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }]);
    expect((await reading).isApp).toBe(true);
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
    await service.retire(workspace.attachmentId);
    expect(sources.mock.calls.length).toBeGreaterThan(1);
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

describe("requested-folder observation", () => {
  it("does no scan for saves in unrequested folders, including another folder beside a requested one", async () => {
    const sources = vi.fn(async () => ["app/index.html"]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    service.settledEvents(workspace, [{ path: "notes/draft.md", operation: "update" }]);
    await Promise.resolve();
    expect(sources).not.toHaveBeenCalled();
    await service.read(workspace, "app");
    updated.mockClear();
    service.settledEvents(workspace, [{ path: "notes/draft.md", operation: "update" }]);
    await Promise.resolve();
    expect(sources).toHaveBeenCalledExactlyOnceWith(workspace, "app");
    expect(updated).not.toHaveBeenCalled();
    await service.retire(workspace.attachmentId);
  });
  it("signals initial answers and changes, but not unchanged successful answers", async () => {
    const sources = vi.fn().mockResolvedValue(["app/index.html"]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    const initial = await service.read(workspace, "app");
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, initial);
    updated.mockClear();
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }]);
    await service.read(workspace, "app");
    expect(updated).not.toHaveBeenCalled();
    sources.mockResolvedValue([]);
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "delete" }]);
    await vi.waitFor(() => expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ folder: "app", isApp: false })));
    const answer = await service.read(workspace, "app");
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, answer);
    service.settledEvents(workspace, [{ path: "app/notes.md", operation: "update" }]);
    await service.read(workspace, "app");
    await service.retire(workspace.attachmentId);
    expect(updated).toHaveBeenCalledTimes(1);
  });
});

describe("bounded folder tracking and resync", () => {
  it("caps nonexistent folders and evicts the least recently asked, without promoting background scans", async () => {
    const sources = vi.fn(async () => []);
    const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
    for (let i = 0; i < MAX_REQUESTED_APP_FOLDERS; i++) await service.read(workspace, "missing" + i);
    await service.read(workspace, "missing0");
    service.settledEvents(workspace, [{ path: "missing1/file.md", operation: "update" }]);
    await service.read(workspace, "missing0");
    await service.read(workspace, "extra");
    sources.mockClear();
    service.settledEvents(workspace, [{ path: "missing1/file.md", operation: "update" }]);
    await Promise.resolve();
    expect(sources).not.toHaveBeenCalled();
    service.invalidate(workspace);
    await service.retire(workspace.attachmentId);
    expect(sources).toHaveBeenCalledTimes(MAX_REQUESTED_APP_FOLDERS);
    expect(sources).toHaveBeenCalledWith(workspace, "missing0");
    expect(sources).toHaveBeenCalledWith(workspace, "extra");
    expect(sources).not.toHaveBeenCalledWith(workspace, "missing1");
  });
  it("drains evicted in-flight scans without notifying their listeners", async () => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockImplementationOnce(() => {
      started();
      return new Promise<string[]>(resolve => { release = resolve; });
    }).mockResolvedValue([]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    const reading = service.read(workspace, "evicted");
    await ready;
    service.invalidate(workspace);
    const queued = Array.from({ length: MAX_REQUESTED_APP_FOLDERS }, (_, i) => service.read(workspace, "missing" + i));
    updated.mockClear();
    let retired = false;
    const retiring = service.retire(workspace.attachmentId).then(() => { retired = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(retired).toBe(false);
    release(["evicted/index.html"]);
    await reading;
    await Promise.all(queued);
    await retiring;
    expect(sources.mock.calls.filter(([, folder]) => folder === "evicted")).toHaveLength(1);
    expect(updated).not.toHaveBeenCalledWith(workspace, expect.objectContaining({ folder: "evicted" }));
    expect(retired).toBe(true);
  });
  it.each([false, true])("signals recovery after a failed read (older successful answer: %s)", async previouslySuccessful => {
    const sources = vi.fn().mockResolvedValue(["app/index.html"]);
    const updated = vi.fn();
    const failed = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed });
    if (previouslySuccessful) await service.read(workspace, "app");
    updated.mockClear();
    sources.mockRejectedValueOnce(new Error("received-share listing unavailable"));
    if (previouslySuccessful) {
      service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }]);
      await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "received-share listing unavailable" })));
    } else await expect(service.read(workspace, "app")).rejects.toThrow("received-share listing unavailable");
    expect(updated).not.toHaveBeenCalled();
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }]);
    await vi.waitFor(() => expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ folder: "app", isApp: true })));
    const recovered = await service.read(workspace, "app");
    expect(recovered.isApp).toBe(true);
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, recovered);
    await service.retire(workspace.attachmentId);
  });
  it("rescans requested folders after resync, coalescing resyncs with settled events", async () => {
    const sources = vi.fn(async (_workspace: typeof workspace, _folder: string) => [] as string[]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    service.invalidate(workspace);
    expect(sources).not.toHaveBeenCalled();
    await service.read(workspace, "app");
    await service.read(workspace, "notes");
    sources.mockClear();
    updated.mockClear();
    sources.mockImplementation(async (_workspace, folder: string) => folder === "app" ? ["app/index.html"] : []);
    service.invalidate(workspace);
    service.invalidate(workspace);
    service.settledEvents(workspace, [{ path: "app/index.html", operation: "update" }]);
    await service.retire(workspace.attachmentId);
    expect(sources).toHaveBeenCalledTimes(2);
    expect(sources).toHaveBeenCalledWith(workspace, "app");
    expect(sources).toHaveBeenCalledWith(workspace, "notes");
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ folder: "app", isApp: true }));
  });
  it("rescans when resync arrives during an in-flight scan", async () => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockImplementationOnce(() => {
      started();
      return new Promise<string[]>(resolve => { release = resolve; });
    }).mockResolvedValue([]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    const reading = service.read(workspace, "app");
    await ready;
    service.invalidate(workspace);
    release(["app/index.html"]);
    expect((await reading).isApp).toBe(false);
    expect(sources).toHaveBeenCalledTimes(2);
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ isApp: false }));
    await service.retire(workspace.attachmentId);
  });
});

it("serializes a many-folder resync and coalesces queued and in-flight invalidations", async () => {
  let inFlight = 0;
  let peak = 0;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const sources = vi.fn(async (_workspace: typeof workspace, _folder: string) => [] as string[]);
  const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
  for (let i = 0; i < MAX_REQUESTED_APP_FOLDERS; i++) await service.read(workspace, "folder" + i);
  sources.mockClear();
  sources.mockImplementation(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (sources.mock.calls.length === 1) {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    } else await Promise.resolve();
    inFlight--;
    return [];
  });
  service.invalidate(workspace);
  service.invalidate(workspace);
  await ready;
  service.invalidate(workspace);
  service.invalidate(workspace);
  service.settledEvents(workspace, [{ path: "folder0/index.html", operation: "update" }]);
  release();
  await service.retire(workspace.attachmentId);
  expect(peak).toBe(1);
  expect(inFlight).toBe(0);
  expect(sources).toHaveBeenCalledTimes(MAX_REQUESTED_APP_FOLDERS + 1);
  for (let i = 0; i < MAX_REQUESTED_APP_FOLDERS; i++) {
    expect(sources.mock.calls.filter(([, folder]) => folder === "folder" + i)).toHaveLength(i === 0 ? 2 : 1);
  }
});

describe("renderer reads beside background scans", () => {
  it("resolves a new folder while the background queue is blocked", async () => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockResolvedValue([]);
    const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
    await service.read(workspace, "shared");
    sources.mockImplementationOnce(() => {
      started();
      return new Promise<string[]>(resolve => { release = resolve; });
    });
    service.invalidate(workspace);
    await ready;
    const resolved = vi.fn();
    const reading = service.read(workspace, "new").then(resolved);
    try {
      await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ folder: "new", isApp: false })));
    } finally {
      release([]);
      await reading;
      await service.retire(workspace.attachmentId);
    }
  });
  it("returns the previous answer for a queued folder and broadcasts its later change", async () => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockResolvedValue(["app/index.html"]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    await service.read(workspace, "shared");
    const previous = await service.read(workspace, "app");
    sources.mockClear();
    updated.mockClear();
    sources.mockImplementationOnce(() => {
      started();
      return new Promise<string[]>(resolve => { release = resolve; });
    }).mockResolvedValue([]);
    service.invalidate(workspace);
    await ready;
    const resolved = vi.fn();
    const reading = service.read(workspace, "app").then(resolved);
    try {
      await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(previous));
      expect(sources).not.toHaveBeenCalledWith(workspace, "app");
      expect(updated).not.toHaveBeenCalled();
    } finally {
      release([]);
      await reading;
      await service.retire(workspace.attachmentId);
    }
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ folder: "app", isApp: false }));
  });
});

describe("queued and running background scans", () => {
  it.each(["resync", "events"])("retries an unanswered queued folder immediately after %s and skips its later turn", async trigger => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockResolvedValue([]);
    const service = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
    await service.read(workspace, "shared");
    sources.mockRejectedValueOnce(new Error("first read failed"));
    await expect(service.read(workspace, "app")).rejects.toThrow("first read failed");
    sources.mockClear();
    sources.mockImplementationOnce(() => {
      started();
      return new Promise<string[]>(resolve => { release = resolve; });
    }).mockResolvedValue(["app/index.html"]);
    if (trigger === "resync") service.invalidate(workspace);
    else service.settledEvents(workspace, [
      { path: "shared/file.md", operation: "update" }, { path: "app/index.html", operation: "update" },
    ]);
    await ready;
    const resolved = vi.fn();
    const retry = service.read(workspace, "app");
    expect(service.read(workspace, "app")).toBe(retry);
    const reading = retry.then(resolved);
    let retiring: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ folder: "app", isApp: true })), { timeout: 1000 });
      expect(sources.mock.calls.filter(([, folder]) => folder === "app")).toHaveLength(1);
      let retired = false;
      retiring = service.retire(workspace.attachmentId).then(() => { retired = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(retired).toBe(false);
    } finally {
      release([]);
      await reading;
      await (retiring ?? service.retire(workspace.attachmentId));
    }
    expect(sources.mock.calls.filter(([, folder]) => folder === "app")).toHaveLength(1);
  });
  it("returns the previous answer during a running background scan", async () => {
    let release!: (paths: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sources = vi.fn().mockResolvedValue(["app/index.html"]);
    const updated = vi.fn();
    const service = createFolderAppDetection({ sources, updated, failed: vi.fn() });
    const previous = await service.read(workspace, "app");
    updated.mockClear();
    sources.mockImplementationOnce(() => {
      started();
      return new Promise<string[]>(resolve => { release = resolve; });
    });
    service.invalidate(workspace);
    await ready;
    const resolved = vi.fn();
    const reading = service.read(workspace, "app").then(resolved);
    try {
      await vi.waitFor(() => expect(resolved).toHaveBeenCalledWith(previous), { timeout: 1000 });
      expect(updated).not.toHaveBeenCalled();
    } finally {
      release([]);
      await reading;
      await service.retire(workspace.attachmentId);
    }
    expect(sources).toHaveBeenCalledTimes(2);
    expect(updated).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ folder: "app", isApp: false }));
  });
});
