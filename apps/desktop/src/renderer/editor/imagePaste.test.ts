// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  computeAttachmentPaths,
  dragCarriesFiles,
  extractImageFiles,
  generateAssetFilename,
  handleImageDrop,
  handleImagePaste,
  handlePaneImageDragOver,
  handlePaneImageDrop,
  imageExtension,
  insertImageAtPosition,
  placeImageFiles,
  pickAndInsertImages,
  sanitizeAttachmentFolderName,
  shortContentHash,
  slugifyBaseName,
  type PickedImage,
} from "./imagePaste";

describe("slugifyBaseName", () => {
  it("lowercases, dashes non-alphanumerics, and drops the extension", () => {
    expect(slugifyBaseName("My Photo.PNG")).toBe("my-photo");
    expect(slugifyBaseName("Screen Shot 2026-07-11.jpeg")).toBe(
      "screen-shot-2026-07-11",
    );
  });

  it("falls back to 'image' for an empty slug", () => {
    expect(slugifyBaseName(".png")).toBe("image");
    expect(slugifyBaseName("___")).toBe("image");
  });
});

describe("shortContentHash", () => {
  it("is stable for the same bytes and differs for different bytes", () => {
    const a = shortContentHash(new Uint8Array([1, 2, 3, 4]));
    const b = shortContentHash(new Uint8Array([1, 2, 3, 4]));
    const c = shortContentHash(new Uint8Array([1, 2, 3, 5]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-z]+$/);
  });
});

describe("imageExtension", () => {
  it("prefers a known extension on the filename", () => {
    expect(imageExtension("pic.webp", "image/png")).toBe("webp");
  });

  it("falls back to the mime type, then png", () => {
    expect(imageExtension("clipboard", "image/jpeg")).toBe("jpg");
    expect(imageExtension("clipboard", "application/octet-stream")).toBe("png");
  });
});

describe("generateAssetFilename", () => {
  it("produces <slug>-<hash>.<ext>", () => {
    const name = generateAssetFilename(
      "My Photo.png",
      "image/png",
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(name).toMatch(/^my-photo-[0-9a-z]+\.png$/);
  });
});

describe("sanitizeAttachmentFolderName", () => {
  it("keeps a valid single segment", () => {
    expect(sanitizeAttachmentFolderName("assets")).toBe("assets");
    expect(sanitizeAttachmentFolderName("  media  ")).toBe("media");
  });

  it("falls back to 'assets' for empty, separator, or dot-segment names", () => {
    expect(sanitizeAttachmentFolderName("")).toBe("assets");
    expect(sanitizeAttachmentFolderName("   ")).toBe("assets");
    expect(sanitizeAttachmentFolderName("a/b")).toBe("assets");
    expect(sanitizeAttachmentFolderName("a\\b")).toBe("assets");
    expect(sanitizeAttachmentFolderName("..")).toBe("assets");
    expect(sanitizeAttachmentFolderName(".")).toBe("assets");
  });
});

describe("computeAttachmentPaths", () => {
  const file = "pic-abc.png";

  it("per-document: a subfolder next to the document", () => {
    expect(
      computeAttachmentPaths("notes/plan.md", file, {
        location: "per-document",
        folderName: "assets",
      }),
    ).toEqual({ writePath: "notes/assets/pic-abc.png", relativeSrc: "assets/pic-abc.png" });
    // A root-level document has no folder prefix.
    expect(
      computeAttachmentPaths("plan.md", file, {
        location: "per-document",
        folderName: "assets",
      }),
    ).toEqual({ writePath: "assets/pic-abc.png", relativeSrc: "assets/pic-abc.png" });
  });

  it("same-folder: directly beside the document (folderName ignored)", () => {
    expect(
      computeAttachmentPaths("notes/plan.md", file, {
        location: "same-folder",
        folderName: "assets",
      }),
    ).toEqual({ writePath: "notes/pic-abc.png", relativeSrc: "pic-abc.png" });
    expect(
      computeAttachmentPaths("plan.md", file, {
        location: "same-folder",
        folderName: "assets",
      }),
    ).toEqual({ writePath: "pic-abc.png", relativeSrc: "pic-abc.png" });
  });

  it("global-folder: one folder at the root, climbed to with `..`", () => {
    // Root doc: no climb needed.
    expect(
      computeAttachmentPaths("plan.md", file, {
        location: "global-folder",
        folderName: "attachments",
      }),
    ).toEqual({
      writePath: "attachments/pic-abc.png",
      relativeSrc: "attachments/pic-abc.png",
    });
    // One level deep: climb once.
    expect(
      computeAttachmentPaths("notes/plan.md", file, {
        location: "global-folder",
        folderName: "attachments",
      }),
    ).toEqual({
      writePath: "attachments/pic-abc.png",
      relativeSrc: "../attachments/pic-abc.png",
    });
    // Deep nesting: climb once per folder segment.
    expect(
      computeAttachmentPaths("a/b/c/plan.md", file, {
        location: "global-folder",
        folderName: "attachments",
      }),
    ).toEqual({
      writePath: "attachments/pic-abc.png",
      relativeSrc: "../../../attachments/pic-abc.png",
    });
  });

  it("defaults to per-document/assets when no setting is threaded", () => {
    expect(computeAttachmentPaths("notes/plan.md", file)).toEqual({
      writePath: "notes/assets/pic-abc.png",
      relativeSrc: "assets/pic-abc.png",
    });
  });

  it("sanitizes an invalid folderName back to 'assets'", () => {
    expect(
      computeAttachmentPaths("notes/plan.md", file, {
        location: "per-document",
        folderName: "../evil",
      }),
    ).toEqual({ writePath: "notes/assets/pic-abc.png", relativeSrc: "assets/pic-abc.png" });
  });
});

describe("sanitizeAttachmentFolderName", () => {
  it("keeps an ordinary folder name", () => {
    expect(sanitizeAttachmentFolderName("attachments")).toBe("attachments");
    expect(sanitizeAttachmentFolderName("  my files  ")).toBe("my files");
  });

  // The whole point of falling back rather than passing the name through: the
  // main process runs every asset write through validateUserWritePath. A name it
  // REJECTS would make writeWorkspaceAsset throw for every image, and
  // placeImageFiles would quietly skip them all — a setting that silently breaks
  // pasting. So anything the writer would reject degrades to "assets" here, and
  // the paste still lands.
  it("falls back to 'assets' for any name the workspace writer would reject", () => {
    for (const rejected of [
      "",
      "   ",
      ".",
      "..",
      "a/b",
      "a\\b",
      ".dohc", // reserved
      ".DOHC", // reserved (case-insensitive)
      ".dohc.", // reserved (Windows dot-alias)
      "shared-with-me", // reserved
      "node_modules", // ignored segment
      ".git", // ignored segment
      "%2e%2e", // percent-encoded traversal
      "%2E%2E%2F", // percent-encoded traversal + separator
      "a%2fb", // decodes into TWO segments — not a single folder
      "...", // dots-only Windows alias
    ]) {
      expect(sanitizeAttachmentFolderName(rejected)).toBe("assets");
    }
  });
});

// jsdom's File does not implement arrayBuffer() in this environment, so tests
// use a minimal File-like carrying the fields the paste path reads.
function fakeImageFile(
  name: string,
  type: string,
  bytes: Uint8Array,
  sizeOverride?: number,
): File {
  return {
    name,
    type,
    size: sizeOverride ?? bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as File;
}

describe("extractImageFiles", () => {
  it("collects image files and ignores non-images", () => {
    const png = fakeImageFile("a.png", "image/png", new Uint8Array([1]));
    const txt = fakeImageFile("a.txt", "text/plain", new Uint8Array([2]));
    const files = extractImageFiles({ files: [png, txt] } as unknown as DataTransfer);
    expect(files).toEqual([png]);
  });

  it("returns [] for a null dataTransfer", () => {
    expect(extractImageFiles(null)).toEqual([]);
  });
});

// A minimal EditorView stand-in exercising the schema/tr/dispatch surface the
// insert path touches — real ProseMirror views are too heavy for a unit test.
type MockNode = { nodeSize: number; attrs: Record<string, unknown> };

function makeMockView(docSize = 8, coordsPos: number | null = 5) {
  const dispatched: Array<{ pos: number; node: MockNode }> = [];
  const imageType = {
    create: (attrs: Record<string, unknown>): MockNode => ({
      nodeSize: 1,
      attrs,
    }),
  };
  const view = {
    state: {
      selection: { from: 3 },
      schema: { nodes: { image: imageType } },
      doc: { content: { size: docSize } },
      tr: {
        insert(pos: number, node: MockNode) {
          return {
            pos,
            node,
            docChanged: true,
            mapping: { map: (mappedPos: number) => mappedPos + node.nodeSize },
          };
        },
      },
    },
    dispatch(tr: { pos: number; node: MockNode }) {
      dispatched.push(tr);
    },
    // Drops resolve their insert position from the cursor coordinates.
    posAtCoords: (_coords: { left: number; top: number }) =>
      coordsPos === null ? null : { pos: coordsPos },
  };
  return { view, dispatched };
}

describe("insertImageAtPosition", () => {
  it("dispatches an image insert and returns the position after it", () => {
    const { view, dispatched } = makeMockView();
    const next = insertImageAtPosition(
      view as never,
      { src: "assets/pic.png", alt: "" },
      3,
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.pos).toBe(3);
    expect(dispatched[0]!.node.attrs).toEqual({ src: "assets/pic.png", alt: "" });
    expect(next).toBe(4);
  });

  it("keeps a two-image batch ordered when insertion creates a paragraph wrapper", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        code_block: { content: "text*", group: "block", code: true },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("code_block", null, schema.text("x")),
        schema.node("paragraph", null, schema.text("After")),
      ]),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction);
      },
    };

    let pos = insertImageAtPosition(
      view as never,
      { src: "one.png", alt: "" },
      2,
    );
    pos = insertImageAtPosition(
      view as never,
      { src: "two.png", alt: "" },
      pos,
    );

    expect(state.doc.child(1).toJSON()).toMatchObject({
      type: "paragraph",
      content: [
        { type: "image", attrs: { src: "one.png" } },
        { type: "image", attrs: { src: "two.png" } },
      ],
    });
  });

  it("clamps an out-of-range position to the document size", () => {
    const { view, dispatched } = makeMockView(8);
    insertImageAtPosition(view as never, { src: "x", alt: "" }, 999);
    expect(dispatched[0]!.pos).toBe(8);
  });

  it("does not advance when the schema rejects the image", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          content: "inline*",
          group: "block",
          attrs: { kind: {} },
        },
        plain: { content: "text*", group: "block" },
        code_block: { content: "text*", group: "block", code: true },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("code_block", null, schema.text("x")),
        schema.node("plain", null, schema.text("After")),
      ]),
    });
    const dispatch = vi.fn(
      (transaction: Parameters<typeof state.apply>[0]) => {
        state = state.apply(transaction);
      },
    );
    const view = {
      get state() {
        return state;
      },
      dispatch,
    };

    const next = insertImageAtPosition(
      view as never,
      { src: "assets/pic.png", alt: "" },
      2,
    );

    expect(next).toBe(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.doc.child(1).textContent).toBe("After");
  });
});

describe("placeImageFiles", () => {
  it("rebases the insertion position when peer content lands during the asset write", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    const paragraph = (text: string) =>
      schema.node("paragraph", null, text ? schema.text(text) : undefined);
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [paragraph("Target")]),
    });
    const startPos = state.doc.content.size - 1;
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction);
      },
    };

    await placeImageFiles(
      view as never,
      [
        {
          name: "photo.png",
          mimeType: "image/png",
          size: 1,
          read: async () => new Uint8Array([1]),
        },
      ],
      {
        workspaceId: "ws1",
        docPath: "notes/plan.md",
        writeAsset: async () => {
          state = EditorState.create({
            schema,
            doc: schema.node("doc", null, [
              paragraph("Peer"),
              paragraph("Target"),
            ]),
          });
        },
      },
      startPos,
    );

    expect(state.doc.child(0).textContent).toBe("Peer");
    const target = state.doc.child(1);
    expect(target.textContent).toBe("Target");
    expect(target.lastChild?.type.name).toBe("image");
  });

  it("keeps a rejected two-image batch anchored after a peer replaces its paragraph", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          content: "inline*",
          group: "block",
          attrs: { kind: {} },
        },
        plain: { content: "text*", group: "block" },
        code_block: { content: "text*", group: "block", code: true },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    const paragraph = (text: string) =>
      schema.node("paragraph", { kind: "anchor" }, schema.text(text));
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        paragraph("Target"),
        schema.node("plain", null, schema.text("After")),
      ]),
    });
    const startPos = 2;
    const dispatch = vi.fn(
      (transaction: Parameters<typeof state.apply>[0]) => {
        state = state.apply(transaction);
      },
    );
    const view = {
      get state() {
        return state;
      },
      dispatch,
    };
    let writes = 0;

    await placeImageFiles(
      view as never,
      ["one.png", "two.png"].map((name) => ({
        name,
        mimeType: "image/png",
        size: 1,
        read: async () => new Uint8Array([1]),
      })),
      {
        workspaceId: "ws1",
        docPath: "notes/plan.md",
        writeAsset: async () => {
          writes += 1;
          if (writes === 1) {
            state = EditorState.create({
              schema,
              doc: schema.node("doc", null, [
                schema.node("code_block", null, schema.text("x")),
                schema.node("plain", null, schema.text("After")),
              ]),
            });
          }
        },
      },
      startPos,
    );

    expect(state.doc.child(0).type.name).toBe("code_block");
    expect(state.doc.child(1).textContent).toBe("After");
    let images = 0;
    state.doc.descendants((node) => {
      if (node.type.name === "image") images += 1;
    });
    expect(images).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not map a repeated-sibling deletion before its replacement boundary", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    const paragraph = () =>
      schema.node("paragraph", null, schema.text("same"));
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [paragraph(), paragraph(), paragraph()]),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction);
      },
    };

    await placeImageFiles(
      view as never,
      [
        {
          name: "photo.png",
          mimeType: "image/png",
          size: 1,
          read: async () => new Uint8Array([1]),
        },
      ],
      {
        workspaceId: "ws1",
        docPath: "notes/plan.md",
        writeAsset: async () => {
          state = EditorState.create({
            schema,
            doc: schema.node("doc", null, [paragraph()]),
          });
        },
      },
      7,
    );

    expect(state.doc.child(0).textContent).toBe("same");
    expect(state.doc.child(1).firstChild?.type.name).toBe("image");
  });

  it("anchors before the asynchronous attachment-settings read", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    const paragraph = (text: string) =>
      schema.node("paragraph", null, schema.text(text));
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [paragraph("Target")]),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction);
      },
    };

    await placeImageFiles(
      view as never,
      [
        {
          name: "photo.png",
          mimeType: "image/png",
          size: 1,
          read: async () => new Uint8Array([1]),
        },
      ],
      {
        workspaceId: "ws1",
        docPath: "notes/plan.md",
        readAttachments: async () => {
          state = EditorState.create({
            schema,
            doc: schema.node("doc", null, [
              paragraph("Peer"),
              paragraph("Target"),
            ]),
          });
          return { location: "per-document", folderName: "assets" };
        },
        writeAsset: async () => undefined,
      },
      state.doc.content.size - 1,
    );

    expect(state.doc.child(0).textContent).toBe("Peer");
    expect(state.doc.child(1).lastChild?.type.name).toBe("image");
  });
});

describe("handleImagePaste", () => {
  it("ignores a paste with no image files", () => {
    const { view } = makeMockView();
    const writeAsset = vi.fn();
    const event = {
      clipboardData: { files: [] },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    const handled = handleImagePaste(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });
    expect(handled).toBe(false);
    expect(writeAsset).not.toHaveBeenCalled();
  });

  it("writes the image next to the doc and inserts a relative-src node", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const file = fakeImageFile(
      "My Photo.png",
      "image/png",
      new Uint8Array([1, 2, 3, 4]),
    );
    const preventDefault = vi.fn();
    const event = {
      clipboardData: { files: [file] },
      preventDefault,
    } as unknown as ClipboardEvent;

    const handled = handleImagePaste(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();

    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    const [writePath, bytes] = writeAsset.mock.calls[0]!;
    expect(writePath).toMatch(/^notes\/assets\/my-photo-[0-9a-z]+\.png$/);
    expect(bytes).toBeInstanceOf(Uint8Array);

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]!.node.attrs).toMatchObject({ alt: "" });
    expect(dispatched[0]!.node.attrs.src).toMatch(
      /^assets\/my-photo-[0-9a-z]+\.png$/,
    );
  });

  it("writes to a global root folder and inserts an upward-relative src", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const file = fakeImageFile("Shot.png", "image/png", new Uint8Array([9, 8, 7]));
    const event = {
      clipboardData: { files: [file] },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;

    handleImagePaste(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      readAttachments: async () => ({
        location: "global-folder",
        folderName: "attachments",
      }),
    });

    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    const [writePath] = writeAsset.mock.calls[0]!;
    // Bytes land in the single root folder...
    expect(writePath).toMatch(/^attachments\/shot-[0-9a-z]+\.png$/);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    // ...and the node src climbs to it from the nested doc's folder.
    expect(dispatched[0]!.node.attrs.src).toMatch(
      /^\.\.\/attachments\/shot-[0-9a-z]+\.png$/,
    );
  });

  it("skips an oversized image without writing it", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    // Force the size check without allocating 20MB.
    const bigFile = fakeImageFile(
      "huge.png",
      "image/png",
      new Uint8Array([1]),
      20 * 1024 * 1024 + 1,
    );
    const event = {
      clipboardData: { files: [bigFile] },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handled = handleImagePaste(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });
    expect(handled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    warn.mockRestore();
  });
});

// A drag/drop event stand-in. `types` carries "Files" exactly as a real OS file
// drag does; `files` is only populated on drop (the browser withholds it during
// dragover), which is why dragCarriesFiles reads types instead.
function makeDragEvent(
  files: File[],
  options: { defaultPrevented?: boolean; types?: string[] } = {},
) {
  const preventDefault = vi.fn();
  const dataTransfer = {
    types: options.types ?? (files.length > 0 ? ["Files"] : []),
    files,
    dropEffect: "none",
  };
  const event = {
    dataTransfer,
    clientX: 100,
    clientY: 200,
    defaultPrevented: options.defaultPrevented ?? false,
    preventDefault,
  };
  return { event: event as unknown as DragEvent, preventDefault, dataTransfer };
}

describe("handleImageDrop", () => {
  it("writes a dropped image and inserts it at the drop position", async () => {
    const { view, dispatched } = makeMockView(8, 5);
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const { event, preventDefault } = makeDragEvent([
      fakeImageFile("Dropped Shot.png", "image/png", new Uint8Array([4, 5, 6])),
    ]);

    const handled = handleImageDrop(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    expect(writeAsset.mock.calls[0]![0]).toMatch(
      /^notes\/assets\/dropped-shot-[0-9a-z]+\.png$/,
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    // Inserted where the cursor was, not at the selection.
    expect(dispatched[0]!.pos).toBe(5);
    expect(dispatched[0]!.node.attrs.src).toMatch(
      /^assets\/dropped-shot-[0-9a-z]+\.png$/,
    );
  });

  it("honors the attachment setting for the src it inserts", async () => {
    const { view, dispatched } = makeMockView(8, 5);
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const { event } = makeDragEvent([
      fakeImageFile("shot.png", "image/png", new Uint8Array([7])),
    ]);

    handleImageDrop(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      readAttachments: async () => ({
        location: "global-folder",
        folderName: "attachments",
      }),
    });

    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    expect(writeAsset.mock.calls[0]![0]).toMatch(
      /^attachments\/shot-[0-9a-z]+\.png$/,
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]!.node.attrs.src).toMatch(
      /^\.\.\/attachments\/shot-[0-9a-z]+\.png$/,
    );
  });

  it("leaves an in-editor drag (a slice, no files) to ProseMirror", () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn();
    const { event, preventDefault } = makeDragEvent([]);

    const handled = handleImageDrop(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });
});

describe("dragCarriesFiles", () => {
  it("is true for an OS file drag even before the files are exposed", () => {
    const { dataTransfer } = makeDragEvent([], { types: ["Files"] });
    expect(dragCarriesFiles(dataTransfer as unknown as DataTransfer)).toBe(true);
  });

  it("is false for an in-editor slice drag and a null dataTransfer", () => {
    const { dataTransfer } = makeDragEvent([], {
      types: ["text/html", "text/plain"],
    });
    expect(dragCarriesFiles(dataTransfer as unknown as DataTransfer)).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
  });
});

describe("handlePaneImageDragOver", () => {
  it("accepts a file drag (so the browser will deliver a drop)", () => {
    const { event, preventDefault, dataTransfer } = makeDragEvent([], {
      types: ["Files"],
    });
    expect(handlePaneImageDragOver(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("ignores an in-editor drag, leaving ProseMirror's reorder alone", () => {
    const { event, preventDefault } = makeDragEvent([], { types: ["text/html"] });
    expect(handlePaneImageDragOver(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("handlePaneImageDrop", () => {
  it("embeds an image dropped on the pane OUTSIDE the ProseMirror content", async () => {
    // posAtCoords === null: the drop landed on the page top-matter, so there is
    // no content position under the cursor — it appends at the end of the doc.
    const { view, dispatched } = makeMockView(8, null);
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const { event, preventDefault } = makeDragEvent([
      fakeImageFile("Title Drop.png", "image/png", new Uint8Array([1, 2])),
    ]);

    const handled = handlePaneImageDrop(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    expect(writeAsset.mock.calls[0]![0]).toMatch(
      /^notes\/assets\/title-drop-[0-9a-z]+\.png$/,
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]!.pos).toBe(8); // end of the document
  });

  it("does NOT double-write a drop ProseMirror already handled", () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn();
    // ProseMirror's handleDrop preventDefaults the drops it takes; the pane
    // listener sits on an ancestor and must skip those.
    const { event } = makeDragEvent(
      [fakeImageFile("a.png", "image/png", new Uint8Array([1]))],
      { defaultPrevented: true },
    );

    expect(handlePaneImageDrop(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    })).toBe(false);
    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("ignores a drop with no image files", () => {
    const { view } = makeMockView();
    const writeAsset = vi.fn();
    const { event } = makeDragEvent([
      fakeImageFile("notes.txt", "text/plain", new Uint8Array([1])),
    ]);

    expect(handlePaneImageDrop(view as never, event, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    })).toBe(false);
    expect(writeAsset).not.toHaveBeenCalled();
  });
});

describe("pickAndInsertImages", () => {
  const picked = (name: string, bytes: number[]): PickedImage => ({
    name,
    mediaType: "image/png",
    bytes: new Uint8Array(bytes),
  });

  it("writes and inserts each image returned by the native picker", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const pickImages = vi
      .fn()
      .mockResolvedValue([picked("Diagram.png", [5, 6, 7])]);

    await pickAndInsertImages(view as never, 3, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      pickImages,
    });

    expect(pickImages).toHaveBeenCalledTimes(1);
    expect(writeAsset).toHaveBeenCalledTimes(1);
    // The picker's bytes travel the SAME write path paste/drop use, so the
    // attachment-location logic applies unchanged.
    expect(writeAsset.mock.calls[0]![0]).toMatch(
      /^notes\/assets\/diagram-[0-9a-z]+\.png$/,
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.pos).toBe(3);
    expect(dispatched[0]!.node.attrs.src).toMatch(
      /^assets\/diagram-[0-9a-z]+\.png$/,
    );
  });

  it("applies the attachment setting to picked images too", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const pickImages = vi.fn().mockResolvedValue([picked("Shot.png", [9])]);

    await pickAndInsertImages(view as never, 3, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      pickImages,
      readAttachments: async () => ({
        location: "same-folder",
        folderName: "assets",
      }),
    });

    expect(writeAsset.mock.calls[0]![0]).toMatch(/^notes\/shot-[0-9a-z]+\.png$/);
    expect(dispatched[0]!.node.attrs.src).toMatch(/^shot-[0-9a-z]+\.png$/);
  });

  it("inserts every picked image, in order", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const pickImages = vi
      .fn()
      .mockResolvedValue([picked("a.png", [1]), picked("b.png", [2])]);

    await pickAndInsertImages(view as never, 3, {
      workspaceId: "ws1",
      docPath: "plan.md",
      writeAsset,
      pickImages,
    });

    expect(writeAsset).toHaveBeenCalledTimes(2);
    expect(dispatched.map((d) => d.pos)).toEqual([3, 4]);
  });

  it("anchors before the asynchronous native picker", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
        image: {
          inline: true,
          group: "inline",
          atom: true,
          attrs: { src: {}, alt: { default: "" } },
        },
      },
    });
    const paragraph = (text: string) =>
      schema.node("paragraph", null, schema.text(text));
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [paragraph("Target")]),
    });
    const pos = state.doc.content.size - 1;
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<typeof state.apply>[0]) {
        state = state.apply(transaction);
      },
    };

    await pickAndInsertImages(view as never, pos, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset: async () => undefined,
      pickImages: async () => {
        state = EditorState.create({
          schema,
          doc: schema.node("doc", null, [
            paragraph("Peer"),
            paragraph("Target"),
          ]),
        });
        return [picked("photo.png", [1])];
      },
    });

    expect(state.doc.child(0).textContent).toBe("Peer");
    expect(state.doc.child(1).lastChild?.type.name).toBe("image");
  });

  it("writes nothing when the picker is cancelled", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn();
    const pickImages = vi.fn().mockResolvedValue([]);

    await pickAndInsertImages(view as never, 3, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      pickImages,
    });

    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("survives a picker that rejects", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pickImages = vi.fn().mockRejectedValue(new Error("dialog failed"));

    await pickAndInsertImages(view as never, 3, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      pickImages,
    });

    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    warn.mockRestore();
  });

  it("does nothing when no picker is wired (non-desktop context)", async () => {
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn();

    await pickAndInsertImages(view as never, 3, {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
    });

    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });
});

// The attachment setting is workspace state that changes UNDER a mounted editor
// (the user edits it in the settings dialog; it differs per workspace). The
// paste context therefore holds a READER, not a value — these tests pin that,
// because a cached copy is exactly how the old code wrote images to the previous
// workspace's / the pre-edit location.
describe("attachment settings are read at use time", () => {
  it("re-reads the setting for every paste, so a settings change takes effect immediately", async () => {
    const { view } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    // Stands in for the workspace setting the user edits between the two pastes.
    let location: "per-document" | "same-folder" = "per-document";
    const readAttachments = vi.fn(async () => ({
      location,
      folderName: "assets",
    }));
    const context = {
      workspaceId: "ws1",
      docPath: "notes/plan.md",
      writeAsset,
      readAttachments,
    };
    const paste = () =>
      handleImagePaste(
        view as never,
        {
          clipboardData: {
            files: [fakeImageFile("a.png", "image/png", new Uint8Array([1]))],
          },
          preventDefault: vi.fn(),
        } as unknown as ClipboardEvent,
        context,
      );

    paste();
    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    expect(writeAsset.mock.calls[0]![0]).toMatch(/^notes\/assets\//);

    // The user changes the setting; the editor is NOT remounted.
    location = "same-folder";
    paste();
    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(2));
    // The second paste honors the NEW location, not the one read at mount.
    expect(writeAsset.mock.calls[1]![0]).toMatch(/^notes\/a-[0-9a-z]+\.png$/);
    expect(readAttachments).toHaveBeenCalledTimes(2);
  });

  it("falls back to the per-document default when the settings read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);

    handleImagePaste(
      view as never,
      {
        clipboardData: {
          files: [fakeImageFile("a.png", "image/png", new Uint8Array([1]))],
        },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent,
      {
        workspaceId: "ws1",
        docPath: "notes/plan.md",
        writeAsset,
        readAttachments: async () => {
          throw new Error("settings unavailable");
        },
      },
    );

    // A failed settings read must never break pasting: the image still lands, in
    // the default per-document folder.
    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    expect(writeAsset.mock.calls[0]![0]).toMatch(/^notes\/assets\//);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    warn.mockRestore();
  });
});
