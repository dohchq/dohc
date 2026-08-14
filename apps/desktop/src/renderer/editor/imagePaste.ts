import { validateUserWritePath } from "@dohc/workspace-core/paths";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { StepMap } from "@tiptap/pm/transform";
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
  const transaction = view.state.tr.insert(clamped, node);
  if (!transaction.docChanged) {
    console.warn(
      `[dohc] skipped image asset "${attrs.src}" at document position ${clamped}; the editor rejected the insertion.`,
    );
    return clamped;
  }
  view.dispatch(transaction);
  return transaction.mapping.map(clamped, 1);
}

type DiffComponent = {
  count: number;
  added: boolean;
  removed: boolean;
  previous?: DiffComponent;
};

type DiffPath = {
  oldPos: number;
  last?: DiffComponent;
};

type DiffBudget = {
  remaining: number;
};

// This bounds the quadratic part of Myers's algorithm by diagonal visits, not
// by document size. The focused measurement keeps all precise ranges for 32
// independent substitutions within this budget. A rewrite that needs more
// work switches to unique anchors and coarse ranges between them. Text anchors
// use fixed-width windows; child anchors use serialized node values. The
// fallback is O(n log n), never rejects the update, and keeps positions outside
// each changed range exact.
const SEQUENCE_DIFF_WORK_BUDGET = 4_096;
const FALLBACK_TEXT_ANCHOR_LENGTH = 8;

// Myers's sequence diff gives us every unchanged island, not only the common
// prefix and suffix. Converting its changed runs to StepMap ranges lets both
// cursors and async image anchors stay attached to unchanged content between
// independent peer edits.
function sequenceDiff<T>(
  before: readonly T[],
  after: readonly T[],
  equal: (left: T, right: T) => boolean,
  budget: DiffBudget,
): DiffComponent[] | null {
  const addToPath = (
    path: DiffPath,
    added: boolean,
    removed: boolean,
    oldPosIncrement: number,
  ): DiffPath => {
    const last = path.last;
    return {
      oldPos: path.oldPos + oldPosIncrement,
      last:
        last && last.added === added && last.removed === removed
          ? { ...last, count: last.count + 1 }
          : { count: 1, added, removed, previous: last },
    };
  };
  const extractCommon = (path: DiffPath, diagonal: number): number => {
    let oldPos = path.oldPos;
    let newPos = oldPos - diagonal;
    let count = 0;
    while (
      oldPos + 1 < before.length &&
      newPos + 1 < after.length &&
      equal(before[oldPos + 1], after[newPos + 1])
    ) {
      oldPos += 1;
      newPos += 1;
      count += 1;
    }
    if (count > 0) {
      path.last = {
        count,
        added: false,
        removed: false,
        previous: path.last,
      };
    }
    path.oldPos = oldPos;
    return newPos;
  };
  const components = (path: DiffPath): DiffComponent[] => {
    const result: DiffComponent[] = [];
    for (let component = path.last; component; component = component.previous) {
      result.push(component);
    }
    return result.reverse();
  };

  const paths: Record<number, DiffPath | undefined> = {
    0: { oldPos: -1 },
  };
  let newPos = extractCommon(paths[0]!, 0);
  if (paths[0]!.oldPos + 1 >= before.length && newPos + 1 >= after.length) {
    return components(paths[0]!);
  }

  let minDiagonal = -Infinity;
  let maxDiagonal = Infinity;
  for (
    let editLength = 1;
    editLength <= before.length + after.length;
    editLength += 1
  ) {
    for (
      let diagonal = Math.max(minDiagonal, -editLength);
      diagonal <= Math.min(maxDiagonal, editLength);
      diagonal += 2
    ) {
      if (budget.remaining === 0) return null;
      budget.remaining -= 1;
      const removePath = paths[diagonal - 1];
      const insertPath = paths[diagonal + 1];
      if (removePath) paths[diagonal - 1] = undefined;
      const insertNewPos = insertPath
        ? insertPath.oldPos - diagonal
        : -1;
      const canInsert =
        insertPath !== undefined &&
        insertNewPos >= 0 &&
        insertNewPos < after.length;
      const canRemove =
        removePath !== undefined && removePath.oldPos + 1 < before.length;
      if (!canInsert && !canRemove) {
        paths[diagonal] = undefined;
        continue;
      }
      const path =
        !canRemove ||
        (canInsert && removePath!.oldPos < insertPath!.oldPos)
          ? addToPath(insertPath!, true, false, 0)
          : addToPath(removePath!, false, true, 1);
      newPos = extractCommon(path, diagonal);
      if (path.oldPos + 1 >= before.length && newPos + 1 >= after.length) {
        return components(path);
      }
      paths[diagonal] = path;
      if (path.oldPos + 1 >= before.length) {
        maxDiagonal = Math.min(maxDiagonal, diagonal - 1);
      }
      if (newPos + 1 >= after.length) {
        minDiagonal = Math.max(minDiagonal, diagonal + 1);
      }
    }
  }
  return [
    ...(before.length > 0
      ? [{ count: before.length, added: false, removed: true }]
      : []),
    ...(after.length > 0
      ? [{ count: after.length, added: true, removed: false }]
      : []),
  ];
}

function appendRange(
  ranges: number[],
  start: number,
  oldSize: number,
  newSize: number,
): void {
  if (oldSize === 0 && newSize === 0) return;
  const previous = ranges.length - 3;
  if (
    previous >= 0 &&
    ranges[previous]! + ranges[previous + 1]! === start
  ) {
    ranges[previous + 1] += oldSize;
    ranges[previous + 2] += newSize;
    return;
  }
  ranges.push(start, oldSize, newSize);
}

type DiffAnchor = {
  oldStart: number;
  newStart: number;
  length: number;
};

function uniqueItemIndices<T, Key>(
  items: readonly T[],
  keyOf: (item: T) => Key,
): Map<Key, number> {
  const indices = new Map<Key, number>();
  for (let index = 0; index < items.length; index += 1) {
    const key = keyOf(items[index]!);
    indices.set(key, indices.has(key) ? -1 : index);
  }
  return indices;
}

function increasingAnchors<T, Key>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => Key,
): DiffAnchor[] {
  const oldIndices = uniqueItemIndices(before, keyOf);
  const newIndices = uniqueItemIndices(after, keyOf);
  const candidates: DiffAnchor[] = [];
  for (const [key, oldStart] of oldIndices) {
    const newStart = newIndices.get(key);
    if (oldStart >= 0 && newStart !== undefined && newStart >= 0) {
      candidates.push({ oldStart, newStart, length: 1 });
    }
  }

  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[tails[middle]!]!.newStart < candidates[index]!.newStart) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }

  const anchors: DiffAnchor[] = [];
  for (
    let index = tails.length === 0 ? -1 : tails[tails.length - 1]!;
    index >= 0;
    index = previous[index]!
  ) {
    anchors.push(candidates[index]!);
  }
  anchors.reverse();
  return anchors;
}

function textWindows(text: string): string[] {
  const windows: string[] = [];
  for (
    let index = 0;
    index + FALLBACK_TEXT_ANCHOR_LENGTH <= text.length;
    index += 1
  ) {
    windows.push(text.slice(index, index + FALLBACK_TEXT_ANCHOR_LENGTH));
  }
  return windows;
}

function increasingTextAnchors(
  before: string,
  after: string,
): DiffAnchor[] {
  const anchors = increasingAnchors(
    textWindows(before),
    textWindows(after),
    (window) => window,
  ).map((anchor) => ({
    ...anchor,
    length: FALLBACK_TEXT_ANCHOR_LENGTH,
  }));

  const normalized: DiffAnchor[] = [];
  for (const anchor of anchors) {
    const last = normalized[normalized.length - 1];
    if (!last) {
      normalized.push({ ...anchor });
      continue;
    }
    const sameOffset =
      anchor.newStart - anchor.oldStart === last.newStart - last.oldStart;
    const overlaps =
      anchor.oldStart <= last.oldStart + last.length &&
      anchor.newStart <= last.newStart + last.length;
    if (sameOffset && overlaps) {
      last.length = Math.max(
        last.length,
        anchor.oldStart + anchor.length - last.oldStart,
      );
    } else if (
      anchor.oldStart >= last.oldStart + last.length &&
      anchor.newStart >= last.newStart + last.length
    ) {
      normalized.push({ ...anchor });
    }
  }
  return normalized;
}

function diffWithAnchors<T>(
  before: readonly T[],
  after: readonly T[],
  anchors: readonly DiffAnchor[],
  start: number,
  ranges: number[],
  sizeOf: (item: T) => number,
): void {
  let oldCursor = 0;
  let newCursor = 0;
  let pos = start;
  for (const anchor of anchors) {
    let oldSize = 0;
    let newSize = 0;
    while (oldCursor < anchor.oldStart) {
      oldSize += sizeOf(before[oldCursor++]!);
    }
    while (newCursor < anchor.newStart) {
      newSize += sizeOf(after[newCursor++]!);
    }
    appendRange(ranges, pos, oldSize, newSize);
    pos += oldSize;
    for (let count = 0; count < anchor.length; count += 1) {
      pos += sizeOf(before[oldCursor++]!);
      newCursor += 1;
    }
  }
  let oldSize = 0;
  let newSize = 0;
  while (oldCursor < before.length) {
    oldSize += sizeOf(before[oldCursor++]!);
  }
  while (newCursor < after.length) {
    newSize += sizeOf(after[newCursor++]!);
  }
  appendRange(ranges, pos, oldSize, newSize);
}

function diffTextWithAnchors(
  before: string,
  after: string,
  start: number,
  ranges: number[],
): void {
  diffWithAnchors(
    before.split(""),
    after.split(""),
    increasingTextAnchors(before, after),
    start,
    ranges,
    () => 1,
  );
}

function diffText(
  before: string,
  after: string,
  start: number,
  ranges: number[],
  budget: DiffBudget,
): void {
  let pos = start;
  let oldSize = 0;
  let newSize = 0;
  const components = sequenceDiff(
    before.split(""),
    after.split(""),
    (a, b) => a === b,
    budget,
  );
  if (components === null) {
    diffTextWithAnchors(before, after, start, ranges);
    return;
  }
  for (const component of components) {
    if (!component.added && !component.removed) {
      appendRange(ranges, pos, oldSize, newSize);
      pos += oldSize + component.count;
      oldSize = 0;
      newSize = 0;
    } else if (component.added) {
      newSize += component.count;
    } else {
      oldSize += component.count;
    }
  }
  appendRange(ranges, pos, oldSize, newSize);
}

function diffNode(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  start: number,
  ranges: number[],
  budget: DiffBudget,
): void {
  if (before.eq(after)) return;
  if (!before.sameMarkup(after)) {
    appendRange(ranges, start, before.nodeSize, after.nodeSize);
    return;
  }
  if (before.isText && after.isText) {
    diffText(before.text ?? "", after.text ?? "", start, ranges, budget);
    return;
  }
  if (before.isLeaf || after.isLeaf) {
    appendRange(ranges, start, before.nodeSize, after.nodeSize);
    return;
  }
  diffContent(before, after, start + 1, ranges, budget);
}

function diffContent(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  start: number,
  ranges: number[],
  budget: DiffBudget,
): void {
  const oldChildren: ProseMirrorNode[] = [];
  const newChildren: ProseMirrorNode[] = [];
  before.forEach((node) => oldChildren.push(node));
  after.forEach((node) => newChildren.push(node));
  let oldIndex = 0;
  let newIndex = 0;
  let pos = start;
  let changedOld: ProseMirrorNode[] = [];
  let changedNew: ProseMirrorNode[] = [];

  const flush = () => {
    if (changedOld.length === 0 && changedNew.length === 0) return;
    const oldText = changedOld.every((node) => node.isText)
      ? changedOld.map((node) => node.text ?? "").join("")
      : null;
    const newText = changedNew.every((node) => node.isText)
      ? changedNew.map((node) => node.text ?? "").join("")
      : null;
    if (oldText !== null && oldText === newText) {
      diffText(oldText, newText, pos, ranges, budget);
    } else if (
      changedOld.length === changedNew.length &&
      changedOld.every((node, index) => node.sameMarkup(changedNew[index]!))
    ) {
      let nestedPos = pos;
      for (let index = 0; index < changedOld.length; index += 1) {
        diffNode(
          changedOld[index]!,
          changedNew[index]!,
          nestedPos,
          ranges,
          budget,
        );
        nestedPos += changedOld[index]!.nodeSize;
      }
    } else {
      appendRange(
        ranges,
        pos,
        changedOld.reduce((size, node) => size + node.nodeSize, 0),
        changedNew.reduce((size, node) => size + node.nodeSize, 0),
      );
    }
    pos += changedOld.reduce((size, node) => size + node.nodeSize, 0);
    changedOld = [];
    changedNew = [];
  };

  const components = sequenceDiff(
    oldChildren,
    newChildren,
    (a, b) => a.eq(b),
    budget,
  );
  if (components === null) {
    diffWithAnchors(
      oldChildren,
      newChildren,
      increasingAnchors(oldChildren, newChildren, (node) =>
        JSON.stringify(node.toJSON()),
      ),
      start,
      ranges,
      (node) => node.nodeSize,
    );
    return;
  }
  for (const component of components) {
    if (!component.added && !component.removed) {
      flush();
      for (let count = 0; count < component.count; count += 1) {
        pos += oldChildren[oldIndex++]!.nodeSize;
        newIndex += 1;
      }
    } else if (component.added) {
      changedNew.push(...newChildren.slice(newIndex, newIndex + component.count));
      newIndex += component.count;
    } else {
      changedOld.push(...oldChildren.slice(oldIndex, oldIndex + component.count));
      oldIndex += component.count;
    }
  }
  flush();
}

export function documentReplacementMap(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): StepMap {
  if (before.eq(after)) return StepMap.empty;
  const ranges: number[] = [];
  diffContent(before, after, 0, ranges, {
    remaining: SEQUENCE_DIFF_WORK_BUDGET,
  });
  return new StepMap(ranges);
}

function rebasePositionAfterDocumentChange(
  pos: number,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): number {
  if (before === after) return Math.max(0, Math.min(pos, after.content.size));
  const mapped = documentReplacementMap(before, after).map(pos, 1);
  return Math.max(
    0,
    Math.min(mapped, after.content.size),
  );
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
  anchorDoc: ProseMirrorNode = view.state.doc,
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
    context.onBeforeInsert?.();
    pos = rebasePositionAfterDocumentChange(
      pos,
      anchorDoc,
      view.state.doc,
    );
    pos = insertImageAtPosition(view, { src: relativeSrc, alt: "" }, pos);
    anchorDoc = view.state.doc;
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
  const anchorDoc = view.state.doc;
  let picked: readonly PickedImage[];
  try {
    picked = await pick();
  } catch (error) {
    console.warn("[dohc] the image picker failed:", error);
    return;
  }
  if (picked.length === 0) return; // cancelled
  await placeImageFiles(
    view,
    picked.map(pickedImageSource),
    context,
    pos,
    anchorDoc,
  );
}
