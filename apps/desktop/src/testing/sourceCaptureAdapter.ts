import { createHash, randomUUID } from "node:crypto";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * An engine adapter over an in-memory workspace for app preparation tests.
 * It answers file listing, source capture, and blob reads, and refuses a
 * capture that names a missing file the way the engine does.
 */
export function sourceCaptureAdapter(sources: ReadonlyMap<string, string | Uint8Array>,
  options: { workspaceId?: string; onRequest?(method: string, params: Record<string, unknown>): void } = {}): VersionedLiveAdapter {
  const workspaceId = options.workspaceId ?? "w";
  const bytesOf = (path: string) => { const value = sources.get(path); return typeof value === "string" ? Buffer.from(value) : value; };
  const blobs = new Map<string, Uint8Array>();
  return new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    options.onRequest?.(request.method, params);
    if (request.method === "versionedText.list") {
      const after = typeof params.afterPath === "string" ? params.afterPath : "", limit = Number(params.limit ?? 500);
      const rest = [...sources.keys()].filter(path => path > after).sort();
      const files = rest.slice(0, limit).map(path => {
        const bytes = bytesOf(path)!;
        return { path, objectId: path, contentKind: "text", sha256: sha256(bytes), byteLength: bytes.byteLength, binarySha256: null,
          updatedAtMs: 1, latestMomentId: "m", metadataOrigin: "disk", hasYdocMarker: path.endsWith(".md") };
      });
      return { id: request.id, result: { files, nextAfterPath: rest.length > limit ? files.at(-1)!.path : null } };
    }
    if (request.method === "versionedText.captureSources") {
      const paths = [...params.paths as string[]].sort();
      if (paths.some(path => !sources.has(path))) throw Object.assign(new Error("invalid-input"), { wireError: { code: "INVALID_PARAMS", message: "invalid-input", retry: "no" } });
      const files = paths.map(path => {
        const bytes = bytesOf(path)!, hash = sha256(bytes); blobs.set(hash, Uint8Array.from(bytes));
        return { path, objectId: path, contentKind: "text", sha256: hash, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId, versionId: String(params.versionId), files, totalBytes: files.reduce((total, file) => total + file.byteLength, 0),
        sourceDigest: sha256(Buffer.from(JSON.stringify(["dohc-source-capture-v1", workspaceId, String(params.versionId), files]))) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, randomUUID(), { workspaceId });
}
