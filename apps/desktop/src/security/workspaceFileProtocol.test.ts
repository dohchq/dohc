import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createWorkspaceFileProtocolHandler } from "./workspaceFileProtocol";

afterEach(() => vi.unstubAllEnvs());

function harness() {
  const workspace = { workspaceId: "workspace-a" };
  const findWorkspace = vi.fn((id: string) => id === workspace.workspaceId ? workspace : null);
  const readOwnedWorkspaceAsset = vi.fn(async (): Promise<{ bytes: Buffer; mediaType: string }> => ({ bytes: Buffer.from("file"), mediaType: "text/plain" }));
  const handle = createWorkspaceFileProtocolHandler({ findWorkspace, readOwnedWorkspaceAsset });
  return { workspace, findWorkspace, readOwnedWorkspaceAsset, handle };
}

describe("workspace file protocol", () => {
  it("uses the current registry entry and passes the decoded path to the owned reader", async () => {
    const h = harness();
    const current = { workspaceId: "workspace-a" };
    h.findWorkspace.mockReturnValue(current);
    const response = await h.handle(new Request("dohc-file://workspace-a/folder/a%20b.txt?ignored=1"));
    expect(h.findWorkspace).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(h.readOwnedWorkspaceAsset).toHaveBeenCalledExactlyOnceWith(current, "folder/a b.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves only the selected buffer view", async () => {
    const h = harness();
    const backing = Buffer.from([99, 0, 128, 255, 88]);
    h.readOwnedWorkspaceAsset.mockResolvedValue({ bytes: backing.subarray(1, 4), mediaType: "application/octet-stream" });
    const response = await h.handle(new Request("dohc-file://workspace-a/data.bin"));
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 128, 255]);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("does not read a missing workspace", async () => {
    const h = harness();
    const response = await h.handle(new Request("dohc-file://missing/file.txt"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Unknown workspace");
    expect(h.readOwnedWorkspaceAsset).not.toHaveBeenCalled();
  });

  it("rejects malformed encoded paths before reading files", async () => {
    const h = harness();
    const response = await h.handle(new Request("dohc-file://workspace-a/%ZZ"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(h.readOwnedWorkspaceAsset).not.toHaveBeenCalled();
  });

  it("waits for the owned reader and hides its failure details", async () => {
    const h = harness();
    const read = deferred<{ bytes: Buffer; mediaType: string }>();
    h.readOwnedWorkspaceAsset.mockReturnValue(read.promise);
    const result = h.handle(new Request("dohc-file://workspace-a/file.txt"));
    try {
      expect(h.readOwnedWorkspaceAsset).toHaveBeenCalledOnce();
      read.reject(new Error("private workspace path or authority error"));
      const response = await result;
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    } finally {
      read.resolve({ bytes: Buffer.alloc(0), mediaType: "text/plain" });
      await result;
    }
  });

  it.each([
    [undefined, undefined, null],
    [undefined, "null", "null"],
    [undefined, "file://", "file://"],
    [undefined, "https://foreign.test", null],
    ["http://localhost:5173/app", "http://localhost:5173", "http://localhost:5173"],
    ["http://localhost:5173/app", "http://localhost:5174", null],
    ["http://localhost:5173/app", "http://localhost:5173.foreign.test", null],
    ["http://localhost:5173/app", "null", null],
    ["invalid-url", "file://", null],
  ])("selects CORS for renderer URL %s and origin %s", async (rendererUrl, origin, allowed) => {
    vi.stubEnv("ELECTRON_RENDERER_URL", rendererUrl);
    const h = harness();
    const response = await h.handle(new Request("dohc-file://workspace-a/file.txt", {
      headers: origin ? { origin } : undefined,
    }));
    expect(response.headers.get("access-control-allow-origin")).toBe(allowed);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("file");
  });
});
