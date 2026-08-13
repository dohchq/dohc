import { validateUserWritePath } from "@dohc/workspace-core/paths";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { documentDir } from "./imageSrc";

// Paste & drop of image FILES into the WYSIWYG editor (desktop-only).
//
// Bytes are written into the workspace at a location chosen by the workspace's
// attachment setting (see AttachmentSettings), then an image node is inserted
// whose src is the path RELATIVE to the document's folder — the same lossless
// form the markdown stores and imageSrc resolves at render time.

// Where pasted/uploaded attachments are saved (workspace setting, modeled on
// Obsidian's "Default location for new attachments"):
//   per-document  — a subfolder next to the document (`<folder>/x.png`)
//   global-folder — one folder at the workspace root (`../<folder>/x.png`)
//   same-folder   — directly beside the document (`x.png`)
export type AttachmentLocation = "per-document" | "global-folder" | "same-folder";

export type AttachmentSettings = {
  location: AttachmentLocation;
  // Subfolder name (per-document) or root folder name (global-folder). Ignored
  // for same-folder. Sanitized to a single safe path segment at use time.
  folderName: string;
};

export const DEFAULT_ATTACHMENT_FOLDER = "assets";

export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  location: "per-document",
  folderName: DEFAULT_ATTACHMENT_FOLDER,
};

// Coerces a stored folder name to a single path segment the WRITER will accept.
//
// The folder name is user input that becomes one segment of the write path, so
// "safe" here means exactly one thing: whatever we return, writeWorkspaceAsset
// must accept. The main process runs every write through validateUserWritePath,
// which rejects more than traversal — reserved names (`.dohc`,
// `shared-with-me`), ignored ones (`node_modules`, `.git`), percent-encoded
// traversal (`%2e%2e`), and Windows dot/space aliases. Re-deriving that list
// here would drift; instead we ASK the same validator, and require the path it
// normalizes to be the segment we passed in (so a name that decodes into
// several segments, like `a%2fb`, is rejected rather than quietly widening the
// target). Anything it refuses falls back to "assets" — a rejected name must
// degrade to the default, never make every paste fail its write and silently
// drop the image.
export function sanitizeAttachmentFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return DEFAULT_ATTACHMENT_FOLDER;
  // One segment only: the caller joins this into a path itself.
  if (/[/\\]/.test(trimmed)) return DEFAULT_ATTACHMENT_FOLDER;
  const validated = validateUserWritePath(trimmed);
  return validated.ok && validated.normalized === trimmed
    ? trimmed
    : DEFAULT_ATTACHMENT_FOLDER;
}

// Computes both paths a saved attachment needs, purely from the document's
// path, the chosen filename, and the setting:
//   - writePath:   workspace-relative path (from the root) the bytes land at,
//                  the form writeWorkspaceAsset expects.
//   - relativeSrc: the path RELATIVE to the document's folder that goes into
//                  the image node / markdown (`assets/x.png`, `x.png`, or
//                  `../attachments/x.png`).
export function computeAttachmentPaths(
  docPath: string,
  filename: string,
  settings: AttachmentSettings = DEFAULT_ATTACHMENT_SETTINGS,
): { writePath: string; relativeSrc: string } {
  const docDir = documentDir(docPath); // "notes/" or "" at the root
  if (settings.location === "same-folder") {
    return { writePath: `${docDir}${filename}`, relativeSrc: filename };
  }
  const folder = sanitizeAttachmentFolderName(settings.folderName);
  if (settings.location === "global-folder") {
    // One folder at the workspace root; a nested doc climbs to it with `..`.
    const depth =
      docDir === "" ? 0 : docDir.replace(/\/+$/, "").split("/").length;
    const up = "../".repeat(depth);
    return {
      writePath: `${folder}/${filename}`,
      relativeSrc: `${up}${folder}/${filename}`,
    };
  }
  // per-document (default): a subfolder next to the document.
  return {
    writePath: `${docDir}${folder}/${filename}`,
    relativeSrc: `${folder}/${filename}`,
  };
}

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

// One image the user chose through the native `/image` picker. Main read the
// bytes (it owns the dialog and fs access), so unlike a pasted/dropped File
// they are already in memory. Structurally the bridge's PickedImageFile — kept
// as a local shape so this module stays bridge-free and unit-testable.
export type PickedImage = {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
};

// Opens the native picker and resolves with the chosen images ([] = cancelled).
export type PickImages = () => Promise<readonly PickedImage[]>;

// The ONE shape the write+insert path consumes, so a pasted File, a dropped
// File, and a natively-picked file all travel the exact same code below. Bytes
// stay lazy (`read()`) because a File's bytes still have to be pulled off disk,
// while a picked image already carries them.
export type ImageSource = {
  name: string;
  mimeType: string;
  size: number;
  read(): Promise<Uint8Array>;
};

export function fileImageSource(file: File): ImageSource {
  return {
    name: file.name,
    mimeType: file.type,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

export function pickedImageSource(picked: PickedImage): ImageSource {
  return {
    name: picked.name,
    mimeType: picked.mediaType,
    size: picked.bytes.byteLength,
    read: async () => picked.bytes,
  };
}

export type ImagePasteContext = {
  workspaceId: string;
  // Current document's workspace-relative path (e.g. `notes/plan.md`).
  docPath: string;
  writeAsset: WriteWorkspaceAsset;
  // Where saved attachments go — READ AT USE TIME, never cached by the editor.
  //
  // The setting lives in workspace settings, which the user can change (in the
  // settings dialog) while this editor stays mounted, and which differs per
  // workspace. A copy cached when the editor mounted goes stale on both counts:
  // it would keep writing to the old location after the setting changed, and to
  // workspace A's location right after a switch to B. Asking for the value at
  // the moment we write removes the cache — and the staleness — entirely.
  //
  // Absent → the per-document/"assets" default, so callers that never set it
  // (and any failure to read) keep working.
  readAttachments?: () => Promise<AttachmentSettings>;
  // Reconcile any peer edit that landed while an async picker, read, or asset
  // write was pending. The insertion then applies to the current document.
  onBeforeInsert?: () => void;
  // Opens the native `/image` picker (a main-process dialog at the workspace
  // root). Absent → `/image` simply cannot pick; paste and drop are unaffected.
  pickImages?: PickImages;
};

// Reads the attachment setting for THIS write. A failed/absent read is not an
// error: attachments fall back to the per-document default rather than the
// paste dying.
async function resolveAttachmentSettings(
  context: ImagePasteContext,
): Promise<AttachmentSettings> {
  if (!context.readAttachments) return DEFAULT_ATTACHMENT_SETTINGS;
  try {
    return await context.readAttachments();
  } catch (error) {
    console.warn(
      "[dohc] could not read the attachment location setting; using the default:",
      error,
    );
    return DEFAULT_ATTACHMENT_SETTINGS;
  }
}

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

// Short, stable content hash (twin FNV-1a lanes → base36). Same bytes → same
// filename, so re-pasting one image dedupes rather than piling up
// near-identical files. Two independently-seeded 32-bit lanes give a ~64-bit
// effective space: the filename is the ONLY guard against two DIFFERENT images
// with the same slug overwriting each other, and a 32-bit hash's birthday
// bound (~65k images per slug) is reachable for default screenshot names — so
// the extra lane keeps dedup from silently becoming data loss.
export function shortContentHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 1) {
    // FNV prime multiply, kept in 32-bit unsigned range via Math.imul.
    h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i]!, 0x85ebca6b) >>> 0;
  }
  return h1.toString(36).padStart(7, "0") + h2.toString(36).padStart(7, "0");
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

function rebasePositionAfterDocumentChange(
  pos: number,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): number {
  if (before === after) {
    return Math.max(0, Math.min(pos, after.content.size));
  }
  const start = before.content.findDiffStart(after.content);
  if (start === null) return Math.min(pos, after.content.size);
  const end = before.content.findDiffEnd(after.content);
  if (end === null) return Math.min(pos, after.content.size);
  if (pos <= start) return pos;
  const mapped =
    pos >= end.a
      ? pos + end.b - end.a
      : start + Math.min(pos - start, end.b - start);
  return Math.max(0, Math.min(mapped, after.content.size));
}

// Writes each image to the workspace and inserts an image node for it. Images
// too large are skipped with a quiet console warning. Insertions walk forward
// from the starting position so multiple images land in order.
//
// The ONE write+insert pathway: paste, drop (in-editor and pane-level), and the
// `/image` native picker all funnel through here, so the attachment-location
// setting and the document-relative src are applied identically for every entry
// point rather than being reimplemented per-surface.
export async function placeImageFiles(
  view: EditorView,
  sources: readonly ImageSource[],
  context: ImagePasteContext,
  startPos: number,
): Promise<void> {
  // One read for the whole batch: every image in a single paste/drop/pick lands
  // under the setting as it stands at that moment.
  const attachments = await resolveAttachmentSettings(context);
  let pos = startPos;
  for (const source of sources) {
    if (source.size > MAX_IMAGE_BYTES) {
      console.warn(
        `[dohc] image "${source.name}" is ${source.size} bytes; skipping (max ${MAX_IMAGE_BYTES}).`,
      );
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await source.read();
    } catch (error) {
      console.warn(`[dohc] could not read image "${source.name}":`, error);
      continue;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;

    const filename = generateAssetFilename(source.name, source.mimeType, bytes);
    // The setting picks the write target; the node/markdown src stays the
    // document-relative (lossless) form the resolver rewrites at render time.
    const { writePath, relativeSrc } = computeAttachmentPaths(
      context.docPath,
      filename,
      attachments,
    );
    try {
      await context.writeAsset(writePath, bytes);
    } catch (error) {
      console.warn(`[dohc] could not write image "${filename}":`, error);
      continue;
    }
    const docBeforeInsert = view.state.doc;
    context.onBeforeInsert?.();
    pos = rebasePositionAfterDocumentChange(
      pos,
      docBeforeInsert,
      view.state.doc,
    );
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
  void placeImageFiles(view, files.map(fileImageSource), context, pos);
  return true;
}

// editorProps.handleDrop hook. Returns true only when image files are dropped,
// inserting them at the drop point; other drops (notably an in-editor block or
// image drag, which carries a ProseMirror slice and NO files) fall through to
// ProseMirror's own move/reorder handling untouched.
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
  void placeImageFiles(view, files.map(fileImageSource), context, dropPos);
  return true;
}

// True when a drag carries OS files (rather than an in-editor ProseMirror
// slice). Read from `types` because the actual `files` list is deliberately
// empty during dragenter/dragover — the browser only exposes it on drop.
export function dragCarriesFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

// ── the document-pane drop zone ────────────────────────────────────────────
//
// ProseMirror's handleDrop only ever runs for drops that land ON the
// ProseMirror element, because ProseMirror is also the only thing that
// preventDefault()s `dragover`, and it only does so for events reaching
// `view.dom`. The document pane is strictly BIGGER than view.dom — the same
// scroller also holds the page top-matter (icon, title, properties). A file
// dropped up there hit Chromium's default file handling instead (which Electron
// then denies as a navigation), so it silently did nothing.
//
// These two handlers make the WHOLE pane accept image files and route them into
// the same placeImageFiles path. They deliberately do nothing for drags without
// files, so an in-editor block/image reorder still belongs entirely to
// ProseMirror.

// Pane `dragover`/`dragenter`: accepting the drag (preventDefault + a copy
// cursor) is what makes the browser deliver a `drop` event at all.
export function handlePaneImageDragOver(event: DragEvent): boolean {
  if (!dragCarriesFiles(event.dataTransfer)) return false;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  return true;
}

// Pane `drop`. Skips anything ProseMirror already took (it preventDefaults the
// drops it handles, and this listener sits on an ancestor), so a drop on the
// document body is never written twice. Everything else — top-matter, pane
// padding, any gap ProseMirror ignores — lands at the position under the
// cursor, or at the end of the document when the drop was outside the content.
export function handlePaneImageDrop(
  view: EditorView,
  event: DragEvent,
  context: ImagePasteContext,
): boolean {
  if (event.defaultPrevented) return false;
  const files = extractImageFiles(event.dataTransfer);
  if (files.length === 0) return false;
  event.preventDefault();
  const pos =
    view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
    view.state.doc.content.size;
  void placeImageFiles(view, files.map(fileImageSource), context, pos);
  return true;
}

// `/image` slash command entry point: opens the NATIVE picker (a main-process
// dialog rooted at the workspace directory — a renderer `<input type="file">`
// cannot be given a starting directory), then writes+inserts each chosen file
// through the same `placeImageFiles` pathway paste and drop use, so the
// attachment-location setting applies identically.
export async function pickAndInsertImages(
  view: EditorView,
  pos: number,
  context: ImagePasteContext,
): Promise<void> {
  const pick = context.pickImages;
  if (!pick) return;
  let picked: readonly PickedImage[];
  try {
    picked = await pick();
  } catch (error) {
    console.warn("[dohc] the image picker failed:", error);
    return;
  }
  if (picked.length === 0) return; // cancelled
  await placeImageFiles(view, picked.map(pickedImageSource), context, pos);
}
