import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Request, Response } from "../protocol";
import { VersionedLiveAdapter } from "./versionedLiveAdapter";
import type { SourceCapture } from "./versionedWireContract";

const bytes = new TextEncoder().encode("\uFEFFexport default 'trip';");
const sha256 = createHash("sha256").update(bytes).digest("hex");
function capture(): SourceCapture {
  const files = [{ path: "src/index.ts", objectId: "o1", contentKind: "text" as const, sha256, byteLength: bytes.length, latestMomentId: "m1" }];
  return { workspaceId: "ws", versionId: "main", totalBytes: bytes.length, files,
    sourceDigest: createHash("sha256").update(JSON.stringify(["dohc-source-capture-v1", "ws", "main", files])).digest("hex") };
}
function adapter(send: (request: Request) => Promise<Response>) {
  return new VersionedLiveAdapter({ sendRequest: send, close() {} }, "handle", { workspaceId: "ws" });
}
const selection = () => ({ workspaceId: "ws", versionId: "main", paths: ["src/index.ts"], bounds: { maxInputFiles: 2, maxInputBytes: 1024 }, signal: new AbortController().signal });

describe("selected source capture", () => {
  it("hydrates the immutable selected blob and retains its leading BOM", async () => {
    const requests: Request[] = [];
    const client = adapter(async (request) => {
      requests.push(request);
      return { id: request.id, result: request.method === "versionedText.captureSources" ? capture() :
        { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length } };
    });
    const recorded = await client.captureSourceMetadata(selection());
    const result = await client.hydrateCapturedSources(recorded, new AbortController().signal);
    expect(result).toEqual([{ path: "src/index.ts", bytes, sha256 }]);
    expect(requests.map((request) => request.method)).toEqual(["versionedText.captureSources", "versionedText.readBlob"]);
    expect(requests[1]!.params).toEqual({ workspaceId: "ws", sha256 });
  });

  it.each(["workspace", "version", "paths", "size", "digest"])("rejects mismatched %s before hydration", async (kind) => {
    const recorded = capture();
    if (kind === "workspace") recorded.workspaceId = "other";
    if (kind === "version") recorded.versionId = "other";
    if (kind === "paths") recorded.files[0]!.path = "other.ts";
    if (kind === "size") recorded.files[0]!.byteLength = -1;
    if (kind === "digest") recorded.sourceDigest = "a".repeat(64);
    const client = adapter(async (request) => ({ id: request.id, result: recorded }));
    await expect(client.captureSourceMetadata(selection())).rejects.toThrow();
  });

  it("does not publish a result after cancellation while metadata is pending", async () => {
    const controller = new AbortController();
    const client = adapter(async (request) => {
      controller.abort();
      return { id: request.id, result: capture() };
    });
    await expect(client.captureSourceMetadata({ ...selection(), signal: controller.signal })).rejects.toThrow();
  });

  it("rejects corrupted in-band bytes even when blob metadata claims the right length", async () => {
    const client = adapter(async (request) => ({ id: request.id, result: { bytesBase64: Buffer.alloc(bytes.length).toString("base64"), byteLength: bytes.length } }));
    await expect(client.hydrateCapturedSources(capture(), new AbortController().signal)).rejects.toThrow("does not match");
  });

  it("pins caller metadata before awaiting blob hydration", async () => {
    const recorded = capture();
    const client = adapter(async (request) => {
      recorded.files[0]!.path = "mutated.ts";
      recorded.files[0]!.sha256 = "b".repeat(64);
      return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length } };
    });
    expect((await client.hydrateCapturedSources(recorded, new AbortController().signal))[0]!.path).toBe("src/index.ts");
  });
});
