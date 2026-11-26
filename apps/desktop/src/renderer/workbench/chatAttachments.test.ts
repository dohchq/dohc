import { describe, expect, it, vi } from "vitest";
import { WRITE_ASSET_MAX_BYTES } from "../../ipc/bridgeContract";
import { addChatFiles } from "./chatAttachments";

function fakeBridge(paths: Map<File, string>) {
  return {
    getDroppedFilePaths: vi.fn((files: File[]) =>
      files.flatMap((file) => (paths.has(file) ? [paths.get(file)!] : [])),
    ),
    importWorkspaceFiles: vi.fn(async (input: { droppedPaths?: string[]; targetDir?: string }) => ({
      imported: (input.droppedPaths ?? ["C:/picked/report.pdf"]).map(
        (path) => `${input.targetDir ? `${input.targetDir}/` : ""}${path.split("/").pop()}`,
      ),
      skipped: 0,
    })),
    writeWorkspaceAsset: vi.fn(async () => {}),
  };
}

const bytes = (size: number) => new Uint8Array(size).fill(7);

describe("addChatFiles", () => {
  it("imports files from disk and saves a pasted picture into the chat's folder", async () => {
    const video = new File([bytes(4)], "clip.mp4", { type: "video/mp4" });
    const pasted = new File([bytes(4)], "image.png", { type: "image/png" });
    const api = fakeBridge(new Map([[video, "C:/Users/me/clip.mp4"]]));

    const added = await addChatFiles(api, "ws", "team", [video, pasted]);

    expect(api.importWorkspaceFiles).toHaveBeenCalledWith({
      workspaceId: "ws",
      droppedPaths: ["C:/Users/me/clip.mp4"],
      targetDir: "team",
    });
    const [written] = api.writeWorkspaceAsset.mock.calls[0] as unknown as [
      { relativePath: string; bytes: Uint8Array },
    ];
    expect(written.relativePath).toMatch(/^team\/image-[0-9a-z]{14}\.png$/u);
    expect(written.bytes).toEqual(bytes(4));
    expect(added).toEqual({ paths: ["team/clip.mp4", written.relativePath], left: 0 });
  });

  it("saves at the workspace root, and counts what it cannot save", async () => {
    const huge = new File([bytes(WRITE_ASSET_MAX_BYTES + 1)], "big.png", { type: "image/png" });
    const text = new File(["hi"], "note.txt", { type: "text/plain" });
    const api = fakeBridge(new Map());

    const added = await addChatFiles(api, "ws", "", [huge, text]);

    expect(api.importWorkspaceFiles).not.toHaveBeenCalled();
    expect(api.writeWorkspaceAsset).not.toHaveBeenCalled();
    expect(added).toEqual({ paths: [], left: 2 });
  });

  it("keeps the saved files when a later picture fails, and fails when none saved", async () => {
    const first = new File([bytes(4)], "a.png", { type: "image/png" });
    const second = new File([bytes(5)], "b.png", { type: "image/png" });
    const api = fakeBridge(new Map());
    api.writeWorkspaceAsset
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("disk full"));

    const added = await addChatFiles(api, "ws", "team", [first, second]);
    expect(added.paths).toHaveLength(1);
    expect(added.left).toBe(1);

    api.writeWorkspaceAsset.mockRejectedValueOnce(new Error("disk full"));
    await expect(addChatFiles(api, "ws", "team", [first])).rejects.toThrow("disk full");
  });

  it("asks the import picker when no files are given", async () => {
    const api = fakeBridge(new Map());
    expect(await addChatFiles(api, "ws", "team")).toEqual({
      paths: ["team/report.pdf"],
      left: 0,
    });
    expect(api.importWorkspaceFiles).toHaveBeenCalledWith({ workspaceId: "ws", targetDir: "team" });
  });
});
