// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

describe("demo asset persistence fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("enters session-only mode once and skips later persistence attempts", async () => {
    const open = vi.fn(() => {
      const request = new EventTarget() as IDBOpenDBRequest;
      Object.defineProperty(request, "error", {
        configurable: true,
        value: new DOMException("storage blocked", "UnknownError"),
      });
      queueMicrotask(() => request.dispatchEvent(new Event("error")));
      return request;
    });
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: { open },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:demo-asset"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(() => undefined),
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const {
      configureDemoDesktopBridge,
      DEMO_ASSET_PERSISTENCE_EVENT,
      demoWorkspaceAssetsPersistAcrossSessions,
    } = await import("./demoDesktopBridge");
    configureDemoDesktopBridge({
      documents: [],
      folders: [],
      createFile: () => undefined,
      createFolder: () => undefined,
      movePath: () => undefined,
      deletePath: () => undefined,
    });
    const persistenceUnavailable = vi.fn();
    window.addEventListener(
      DEMO_ASSET_PERSISTENCE_EVENT,
      persistenceUnavailable,
    );

    const bridge = window.dohcDesktop;
    if (!bridge) throw new Error("demo bridge was not configured");
    const write = (relativePath: string) =>
      bridge.writeWorkspaceAsset({
        workspaceId: "marketing-demo",
        relativePath,
        bytes: new Uint8Array([1, 2, 3]),
      });

    await expect(write("assets/first.png")).resolves.toBeUndefined();
    expect(demoWorkspaceAssetsPersistAcrossSessions()).toBe(false);
    expect(persistenceUnavailable).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);

    await expect(write("assets/second.png")).resolves.toBeUndefined();
    expect(persistenceUnavailable).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);

    window.removeEventListener(
      DEMO_ASSET_PERSISTENCE_EVENT,
      persistenceUnavailable,
    );
  });
});
