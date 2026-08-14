import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";

const EXCALIDRAW_ASSET_MIME_TYPES = new Set<BinaryFileData["mimeType"]>([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
  "application/octet-stream",
]);

export function sameArtifactAssetDescriptor(
  left: ArtifactAssetDescriptor,
  right: ArtifactAssetDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.mimeType === right.mimeType &&
    left.created === right.created &&
    left.ref === right.ref &&
    left.sha256 === right.sha256 &&
    left.lastRetrieved === right.lastRetrieved &&
    left.version === right.version
  );
}

export function binaryFileDataFromArtifact(
  expected: ArtifactAssetDescriptor,
  loaded: {
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  },
): BinaryFileData | null {
  if (!sameArtifactAssetDescriptor(loaded.descriptor, expected)) return null;
  if (
    !EXCALIDRAW_ASSET_MIME_TYPES.has(
      expected.mimeType as BinaryFileData["mimeType"],
    )
  ) {
    return null;
  }
  const mimeType = expected.mimeType as BinaryFileData["mimeType"];
  const chunks: string[] = [];
  for (let offset = 0; offset < loaded.bytes.length; offset += 0x8000) {
    chunks.push(
      String.fromCharCode(
        ...loaded.bytes.subarray(offset, offset + 0x8000),
      ),
    );
  }
  return {
    id: expected.id as BinaryFileData["id"],
    mimeType,
    dataURL: `data:${mimeType};base64,${btoa(chunks.join(""))}` as BinaryFileData["dataURL"],
    created: expected.created,
    ...(expected.lastRetrieved === undefined
      ? {}
      : { lastRetrieved: expected.lastRetrieved }),
    ...(expected.version === undefined ? {} : { version: expected.version }),
  };
}
