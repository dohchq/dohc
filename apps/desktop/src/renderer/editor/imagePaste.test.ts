// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  extractImageFiles,
  generateAssetFilename,
  handleImagePaste,
  IMAGE_PICKER_ACCEPT,
  imageExtension,
  insertImageAtPosition,
  pickAndInsertImages,
  pickImageFiles,
  shortContentHash,
  slugifyBaseName,
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

function makeMockView(docSize = 8) {
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
          return { pos, node };
        },
      },
    },
    dispatch(tr: { pos: number; node: MockNode }) {
      dispatched.push(tr);
    },
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

  it("clamps an out-of-range position to the document size", () => {
    const { view, dispatched } = makeMockView(8);
    insertImageAtPosition(view as never, { src: "x", alt: "" }, 999);
    expect(dispatched[0]!.pos).toBe(8);
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

// A minimal Document stand-in: the `/image` slash command triggers a native
// file picker via `document.createElement("input")` + `.click()`. Neither the
// input's presence in a live DOM nor the OS dialog is testable in jsdom, so
// these tests fake just the surface pickImageFiles touches (create/append/
// click/change) and never exercise a real `<input>`.
function makeFakeInputDocument() {
  const listeners: Record<string, () => void> = {};
  const input = {
    type: "",
    accept: "",
    multiple: false,
    style: {} as Record<string, string>,
    files: null as unknown as FileList | null,
    addEventListener: (event: string, cb: () => void) => {
      listeners[event] = cb;
    },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => input),
    body: { appendChild: vi.fn() },
  } as unknown as Document;
  return { doc, input, fireChange: () => listeners.change?.() };
}

describe("pickImageFiles", () => {
  it("opens a hidden multi-file image input and triggers its picker", () => {
    const { doc, input } = makeFakeInputDocument();
    const onFiles = vi.fn();

    pickImageFiles(onFiles, doc);

    expect(input.type).toBe("file");
    expect(input.accept).toBe(IMAGE_PICKER_ACCEPT);
    expect(input.multiple).toBe(true);
    expect(doc.body.appendChild).toHaveBeenCalledWith(input);
    expect(input.click).toHaveBeenCalledTimes(1);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("forwards the chosen files on change and cleans up the element", () => {
    const { doc, input, fireChange } = makeFakeInputDocument();
    const onFiles = vi.fn();
    const file = fakeImageFile("a.png", "image/png", new Uint8Array([1]));

    pickImageFiles(onFiles, doc);
    input.files = [file] as unknown as FileList;
    fireChange();

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(input.remove).toHaveBeenCalledTimes(1);
  });

  it("never calls onFiles if the picker is dismissed (no change event)", () => {
    const { doc } = makeFakeInputDocument();
    const onFiles = vi.fn();
    pickImageFiles(onFiles, doc);
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("pickAndInsertImages", () => {
  it("writes and inserts each file chosen through the picker", async () => {
    const { doc, input, fireChange } = makeFakeInputDocument();
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn().mockResolvedValue(undefined);
    const file = fakeImageFile(
      "Diagram.png",
      "image/png",
      new Uint8Array([5, 6, 7]),
    );

    pickAndInsertImages(
      view as never,
      3,
      { workspaceId: "ws1", docPath: "notes/plan.md", writeAsset },
      doc,
    );
    input.files = [file] as unknown as FileList;
    fireChange();

    await vi.waitFor(() => expect(writeAsset).toHaveBeenCalledTimes(1));
    const [writePath] = writeAsset.mock.calls[0]!;
    expect(writePath).toMatch(/^notes\/assets\/diagram-[0-9a-z]+\.png$/);

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]!.pos).toBe(3);
  });

  it("writes nothing when the picker yields no files", () => {
    const { doc, input, fireChange } = makeFakeInputDocument();
    const { view, dispatched } = makeMockView();
    const writeAsset = vi.fn();

    pickAndInsertImages(
      view as never,
      3,
      { workspaceId: "ws1", docPath: "notes/plan.md", writeAsset },
      doc,
    );
    input.files = [] as unknown as FileList;
    fireChange();

    expect(writeAsset).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });
});
