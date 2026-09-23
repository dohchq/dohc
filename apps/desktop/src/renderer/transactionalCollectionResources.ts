import { APP_BACKEND_UPLOAD_BYTES, parseAppBackendFile, type AppBackendFile } from "@dohc/security-contract/app-backend";

export interface CollectionResourceScope {
  workspaceId: string;
  datasetId: string;
  revision: number;
  revisionSha256: string;
}
export interface CollectionUploadRequest extends CollectionResourceScope {
  fieldId: string;
  idempotencyKey: string;
  file: File;
}
export interface CollectionFileRequest extends CollectionResourceScope { fileId: string; read?: { operationId: string; fieldId: string; input: import("@dohc/security-contract/app-backend").AppBackendJson } }
export interface CollectionRelationRequest extends CollectionResourceScope { fieldId: string; search: string; limit: 20 }
export interface CollectionRelationOption { value: string | number; label: string }
export interface CollectionResources {
  uploadFile?(request: CollectionUploadRequest, signal: AbortSignal): Promise<AppBackendFile>;
  readFile?(request: CollectionFileRequest, signal: AbortSignal): Promise<{ file: AppBackendFile; bytesBase64: string }>;
  resolveRelation?(request: CollectionRelationRequest, signal: AbortSignal): Promise<{ options: CollectionRelationOption[]; hasMore: boolean }>;
}
export type CollectionResourceError = (fallback: string, error: unknown, retry: (() => void) | null) => void;

/** Download only returned bytes; never navigate to authored paths, URLs, or file content. */
export function downloadCollectionFile(expectedId: string, response: { file: AppBackendFile; bytesBase64: string }): void {
  const file = parseAppBackendFile(response.file);
  if (file.fileId !== expectedId || typeof response.bytesBase64 !== "string" || response.bytesBase64.length > Math.ceil(APP_BACKEND_UPLOAD_BYTES / 3) * 4 ||
      response.bytesBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(response.bytesBase64)) throw new Error("The collection returned an invalid file.");
  const bytes = Uint8Array.from(atob(response.bytesBase64), char => char.charCodeAt(0));
  if (bytes.byteLength !== file.byteLength) throw new Error("The collection returned an incomplete file.");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = file.name; link.hidden = true;
  try { document.body.append(link); link.click(); }
  finally { link.remove(); URL.revokeObjectURL(url); }
}
