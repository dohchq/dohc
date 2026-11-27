import { describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createWorkspaceFileProtocol } from "./workspaceFileProtocol";

const TRUSTED = "file:///app/renderer/index.html";

function harness() {
  const workspace = { workspaceId: "workspace-a" };
  const findWorkspace = vi.fn((id: string) => (id === workspace.workspaceId ? workspace : null));
  const readOwnedWorkspaceAsset = vi.fn(
    async (): Promise<{ bytes: Buffer; mediaType: string }> => ({
      bytes: Buffer.from("file"),
      mediaType: "text/plain",
    }),
  );
  const protocol = createWorkspaceFileProtocol({
    findWorkspace,
    readOwnedWorkspaceAsset,
    isTrustedFrame: (url) => url === TRUSTED,
  });
  const admit = (frame: Parameters<typeof protocol.admit>[0]["frame"]) => {
    let response: Parameters<Parameters<typeof protocol.admit>[1]>[0] | undefined;
    protocol.admit({ frame, requestHeaders: { accept: "*/*" } }, (value) => {
      response = value;
    });
    return response;
  };
  const handle = (request: Request) => {
    const admitted = admit({ parent: null, url: TRUSTED });
    if (!admitted || "cancel" in admitted) throw new Error("trusted frame was refused");
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(admitted.requestHeaders)) headers.set(name, value);
    return protocol.handle(new Request(request.url, { headers }));
  };
  return { workspace, findWorkspace, readOwnedWorkspaceAsset, protocol, admit, handle };
}

describe("workspace file protocol", () => {
  it("uses the current registry entry and passes the decoded path to the owned reader", async () => {
    const h = harness();
    const current = { workspaceId: "workspace-a" };
    h.findWorkspace.mockReturnValue(current);
    const response = await h.handle(
      new Request("dohc-file://workspace-a/folder/a%20b.txt?ignored=1"),
    );
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
    h.readOwnedWorkspaceAsset.mockResolvedValue({
      bytes: backing.subarray(1, 4),
      mediaType: "application/octet-stream",
    });
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
    } finally {
      read.resolve({ bytes: Buffer.alloc(0), mediaType: "text/plain" });
      await result;
    }
  });

  it("admits only a trusted top-level frame", () => {
    const h = harness();
    const destroyed = {
      get parent(): null {
        throw new Error("Render frame was disposed before WebFrameMain could be accessed");
      },
      url: TRUSTED,
    };
    expect(h.admit({ parent: null, url: TRUSTED })).toEqual({
      requestHeaders: { accept: "*/*", "x-dohc-admitted": expect.any(String) },
    });
    for (const frame of [
      { parent: {}, url: TRUSTED },
      { parent: null, url: "http://127.0.0.1:5000/" },
      { parent: null, url: "file:///tmp/dohc-export/document.html" },
      null,
      undefined,
      destroyed,
    ]) {
      expect(h.admit(frame)).toEqual({ cancel: true });
    }
  });

  it("refuses a request the admission hook never saw", async () => {
    const h = harness();
    for (const headers of [new Headers(), new Headers({ "x-dohc-admitted": "guess" })]) {
      const response = await h.protocol.handle(
        new Request("dohc-file://workspace-a/file.txt", { headers }),
      );
      expect(response.status).toBe(404);
    }
    expect(h.findWorkspace).not.toHaveBeenCalled();
    expect(h.readOwnedWorkspaceAsset).not.toHaveBeenCalled();
  });
});
