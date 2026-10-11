import { describe, expect, it, vi } from "vitest";
import { readFolderAppSources } from "./folderAppSources";
import { detectFolderApp } from "./folderAppDetection";

describe("folder discovery sources", () => {
  it("requests only the affected folder and reads no neighboring metadata", async () => {
    const list = vi.fn(async () => ["app/index.html", "other/dohc.json", "app/dohc.json"]);
    const source = vi.fn(async (path: string) => path);
    const sources = await readFolderAppSources("app", { list, source });
    expect(list).toHaveBeenCalledExactlyOnceWith({ path: "app", recursive: true });
    expect(source.mock.calls).toEqual([["app/index.html"], ["app/dohc.json"]]);
    expect(detectFolderApp("one", "app", sources).isApp).toBe(true);
  });
  it("never requests a recursive workspace listing for a root app", async () => {
    const list = vi.fn(async () => ["dohc.json", "web/output/index.html", "neighbor/index.html"]);
    const source = vi.fn(async (path: string) => path === "dohc.json"
      ? { path, body: JSON.stringify({ type: "app", build: { output: "web/output" } }) } : path);
    const sources = await readFolderAppSources(".", { list, source });
    expect(list.mock.calls[0]).toEqual([{ path: ".", recursive: false }]);
    expect(list.mock.calls).not.toContainEqual([{ path: ".", recursive: true }]);
    expect(source.mock.calls).not.toContainEqual(["neighbor/index.html"]);
    expect(detectFolderApp("one", ".", sources).run?.entryPath).toBe("web/output/index.html");
  });
});
