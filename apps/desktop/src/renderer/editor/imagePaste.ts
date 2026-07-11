import type { EditorView } from "@tiptap/pm/view";
import { joinWorkspacePath } from "./imageSrc";

// Paste & drop of image FILES into the WYSIWYG editor (desktop-only).
//
// Bytes are written into the workspace next to the current document under an
// `assets/` folder, then an image node is inserted whose src is the
// document-relative path (`assets/<name>`) — the same lossless form the
// markdown stores and imageSrc resolves at render time.

// Refuse anything over 20MB: this matches the main-process asset write bound,
// and images that large are almost never a paste the user meant.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Extension by mime type, for clipboard images that arrive without a filename.
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

const KNOWN_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "avif",
  "bmp",
]);

// Writes image bytes into the workspace. Injected so tests can mock it; the
// default (in MarkdownEditor) routes through the desktop bridge.
export type WriteWorkspaceAsset = (
  relativePath: string,
  bytes: Uint8Array,
) => Promise<void>;

export type ImagePasteContext = {
  workspaceId: string;
  // Current document's workspace-relative path (e.g. `notes/plan.md`).
  docPath: string;
  writeAsset: WriteWorkspaceAsset;
};

// Slug of the original filename (sans extension): lowercase, non-alphanumerics
// collapsed to single dashes, trimmed, capped. Empty names fall back to
// "image" so a filename is always produced.
export function slugifyBaseName(name: string): string {
  const withoutExt = name.replace(/\.[^./\\]*$/, "");
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "image";
}

// Short, stable content hash (FNV-1a → base36). Same bytes → same filename, so
// re-pasting one image dedupes rather than piling up near-identical files.
export function shortContentHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    // FNV prime multiply, kept in 32-bit unsigned range via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 8);
}

// Picks a file extension: a known image extension on the name wins; otherwise
// the mime type decides; falling back to "png".
export function imageExtension(name: string, mimeType: string): string {
  const nameExt = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (nameExt && KNOWN_IMAGE_EXTENSIONS.has(nameExt)) return nameExt;
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "png";
}

// Collision-safe asset filename: `<slug>-<hash>.<ext>`.
export function generateAssetFilename(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): string {
  return `${slugifyBaseName(name)}-${shortContentHash(bytes)}.${imageExtension(
    name,
    mimeType,
  )}`;
}

// Collects image Files from a clipboard/drag DataTransfer.
export function extractImageFiles(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) return [];
  const files: File[] = [];
  for (const file of Array.from(dataTransfer.files ?? [])) {
    if (file.type.startsWith("image/")) files.push(file);
  }
  return files;
}

// Inserts an image node (with a document-relative src) at `pos`, returning the
// position just after the inserted node so a batch can advance.
export function insertImageAtPosition(
  view: EditorView,
  attrs: { src: string; alt: string },
  pos: number,
): number {
  const imageType = view.state.schema.nodes.image;
  if (!imageType) return pos;
  const node = imageType.create(attrs);
  const clamped = Math.max(0, Math.min(pos, view.state.doc.content.size));
  view.dispatch(view.state.tr.insert(clamped, node));
  return clamped + node.nodeSize;
}

// Writes each image to the workspace and inserts an image node for it. Files
// too large are skipped with a quiet console warning. Insertions walk forward
// from the starting position so multiple images land in order.
//
// Exported so other entry points (the `/image` slash command) can reuse the
// exact same write+insert pathway paste/drop use, rather than duplicating it.
export async function placeImageFiles(
  view: EditorView,
  files: File[],
  context: ImagePasteContext,
  startPos: number,
): Promise<void> {
  let pos = startPos;
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      console.warn(
        `[dohc] image "${file.name}" is ${file.size} bytes; skipping paste (max ${MAX_IMAGE_BYTES}).`,
      );
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      console.warn(`[dohc] could not read pasted image "${file.name}":`, error);
      continue;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;

    const filename = generateAssetFilename(file.name, file.type, bytes);
    // src stays document-relative (`assets/<name>`) — the lossless markdown
    // form; the workspace write path joins it onto the document's folder.
    const relativeSrc = `assets/${filename}`;
    const writePath = joinWorkspacePath(context.docPath, relativeSrc);
    try {
      await context.writeAsset(writePath, bytes);
    } catch (error) {
      console.warn(`[dohc] could not write pasted image "${filename}":`, error);
      continue;
    }
    pos = insertImageAtPosition(view, { src: relativeSrc, alt: "" }, pos);
  }
}

// editorProps.handlePaste hook. Returns true (and takes over) only when the
// clipboard actually carries image files, so text/markdown paste is untouched.
export function handleImagePaste(
  view: EditorView,
  event: ClipboardEvent,
  context: ImagePasteContext,
): boolean {
  const files = extractImageFiles(event.clipboardData);
  if (files.length === 0) return false;
  event.preventDefault();
  const pos = view.state.selection.from;
  void placeImageFiles(view, files, context, pos);
  return true;
}

// editorProps.handleDrop hook. Returns true only when image files are dropped,
// inserting them at the drop point; other drops fall through to ProseMirror.
export function handleImageDrop(
  view: EditorView,
  event: DragEvent,
  context: ImagePasteContext,
): boolean {
  const files = extractImageFiles(event.dataTransfer);
  if (files.length === 0) return false;
  event.preventDefault();
  const dropPos =
    view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
    view.state.selection.from;
  void placeImageFiles(view, files, context, dropPos);
  return true;
}

// The mime types offered by the native file picker for `/image`.
export const IMAGE_PICKER_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

// Opens a transient, unattached-until-triggered `<input type="file">` and
// hands the chosen files to `onFiles`. No new IPC: the native picker is a
// plain DOM affordance the renderer already has access to. The element is
// removed after firing (or never appended at all — appendChild isn't
// required for `.click()`/`change` to work) so nothing leaks into the DOM.
export function pickImageFiles(
  onFiles: (files: File[]) => void,
  doc: Document = document,
): void {
  const input = doc.createElement("input");
  input.type = "file";
  input.accept = IMAGE_PICKER_ACCEPT;
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener(
    "change",
    () => {
      onFiles(Array.from(input.files ?? []));
      input.remove();
    },
    { once: true },
  );
  doc.body.appendChild(input);
  input.click();
}

// `/image` slash command entry point: opens the picker, then writes+inserts
// each chosen file through the same `placeImageFiles` pathway paste/drop use.
export function pickAndInsertImages(
  view: EditorView,
  pos: number,
  context: ImagePasteContext,
  doc: Document = document,
): void {
  pickImageFiles((files) => {
    if (files.length === 0) return;
    void placeImageFiles(view, files, context, pos);
  }, doc);
}
