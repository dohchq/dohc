import { appBackendFileSignatureMatches } from "@dohc/security-contract/app-backend";
import { workspaceNameError } from "@dohc/workspace-contracts/workspace-paths";
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import type { Account, AccountState } from "./account";
import { segment } from "./api";
import type { ServerClient } from "./client";
import { newFileRequestId } from "./fileWrites";

export const MAX_WORKSPACE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
export const BINARY_CACHE_DIR = "dohc-files";

const IMAGE_EXTS = new Set("png jpg jpeg gif webp heic heif bmp avif".split(" "));
const NON_TEXT_EXTS = new Set("html htm xhtml svg svgz pdf".split(" "));
const TEXT_EXTS = new Set(
  "txt csv tsv json yaml yml xml log ini toml sh js ts tsx jsx css py rs go java c h cpp sql md markdown".split(
    " ",
  ),
);
const RESERVED_UPLOAD_NAMES = new Set(
  "collection.yaml dataset.json schema.sql operations.js automations.yaml".split(" "),
);
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const BINARY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

export type FilePreview =
  | { readonly kind: "image" }
  | { readonly kind: "pdf" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "other"; readonly reason?: "too-large" };

export const isPdfMagic = (b: Uint8Array): boolean =>
  b.byteLength >= 5 &&
  b[0] === 0x25 &&
  b[1] === 0x50 &&
  b[2] === 0x44 &&
  b[3] === 0x46 &&
  b[4] === 0x2d;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
};

export function classifyFilePreview(name: string, bytes: Uint8Array): FilePreview {
  const ext = extensionOf(name);
  if (IMAGE_EXTS.has(ext)) return { kind: "image" };
  if (ext === "pdf") return isPdfMagic(bytes) ? { kind: "pdf" } : { kind: "other" };
  if (NON_TEXT_EXTS.has(ext)) return { kind: "other" };
  if (bytes.byteLength > MAX_TEXT_PREVIEW_BYTES)
    return TEXT_EXTS.has(ext) ? { kind: "other", reason: "too-large" } : { kind: "other" };
  if (bytes.includes(0)) return { kind: "other" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!BINARY_CONTROL_RE.test(text) && (TEXT_EXTS.has(ext) || text.length > 0))
      return { kind: "text", text };
  } catch {}
  return { kind: "other" };
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(""));
}

export function safeUploadContentType(mimeType: string | undefined, bytes: Uint8Array): string {
  const raw = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!raw || raw.length > 127 || !MIME_RE.test(raw)) return "application/octet-stream";
  return appBackendFileSignatureMatches(raw, bytes) ? raw : "application/octet-stream";
}

export function sanitizeUploadFileName(rawName: string): string | null {
  const base = rawName.split(/[\\/]/u).at(-1)?.trim() ?? "";
  const lower = base.toLowerCase();
  if (
    !base ||
    base.startsWith(".") ||
    base.length > 255 ||
    workspaceNameError(base, "win32") !== null ||
    /\.(md|markdown|excalidraw)$/i.test(lower) ||
    RESERVED_UPLOAD_NAMES.has(lower)
  )
    return null;
  return base;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export const cacheDirectory = () => new Directory(Paths.cache, BINARY_CACHE_DIR);

export function clearBinaryFileCache(): void {
  try {
    const dir = cacheDirectory();
    if (dir.exists) dir.delete();
  } catch {}
}

export function clearBinaryCacheOnSignInChange(
  account: Pick<Account, "state" | "subscribe">,
  clear: () => void = clearBinaryFileCache,
): () => void {
  const key = (s: AccountState) =>
    s.status === "signed-in" ? `${s.signIn.origin}\0${s.signIn.userId}` : null;
  let last = key(account.state());
  return account.subscribe(() => {
    const next = key(account.state());
    if (next !== last) {
      last = next;
      clear();
    }
  });
}

export async function writeCachedBinary(name: string, bytes: Uint8Array) {
  const dir = cacheDirectory();
  dir.create({ idempotent: true, intermediates: true });
  const ext = extensionOf(name);
  const file = new File(
    dir,
    `${newFileRequestId()}${/^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : ""}`,
  );
  await file.write(bytes);
  return { uri: file.uri, dirUri: dir.uri, file };
}

export const downloadWorkspaceFile = (
  client: ServerClient,
  workspaceId: string,
  path: string,
  signal?: AbortSignal,
) =>
  client.bytes(
    "GET",
    `/sync/${segment(workspaceId)}/ops/fileBytes?path=${encodeURIComponent(path)}`,
    undefined,
    { signal, timeoutMs: 60_000, maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES },
  );

export const downloadCollectionAttachment = (
  client: ServerClient,
  workspaceId: string,
  input: {
    readonly datasetId: string;
    readonly tableId: string;
    readonly recordId: string | number;
    readonly fieldId: string;
    readonly fileId: string;
  },
  signal?: AbortSignal,
) =>
  client.bytes("POST", `/sync/${segment(workspaceId)}/ops/collectionAttachmentRead`, input, {
    signal,
    timeoutMs: 60_000,
    maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
  });

export type PickedDocument =
  | {
      readonly ok: true;
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }
  | { readonly ok: false; readonly reason: "canceled" | "too-large" | "empty" | "unreadable" };

export async function pickDocument(maxBytes: number): Promise<PickedDocument> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return { ok: false, reason: "canceled" };
  const asset = result.assets[0];
  const temp = new File(asset.uri);
  try {
    if (typeof asset.size === "number" && asset.size > maxBytes)
      return { ok: false, reason: "too-large" };
    const bytes = await temp.bytes();
    if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
    if (bytes.byteLength > maxBytes) return { ok: false, reason: "too-large" };
    return {
      ok: true,
      name: asset.name || "file",
      mimeType: safeUploadContentType(asset.mimeType, bytes),
      bytes,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    try {
      if (temp.exists) temp.delete();
    } catch {}
  }
}
