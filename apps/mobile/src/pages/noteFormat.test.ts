import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import type { BodySequenceUnwritten } from "@dohc/ydoc-projection/body-sequence-editor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { createLiveAdapter, LiveProvider } from "../../editor/liveAdapter";

const hoisted = vi.hoisted(() => ({
  posted: [] as string[],
  payloads: [] as unknown[],
  copied: [] as unknown[],
  mounted: [] as {
    doc: Y.Doc;
    canEdit(): boolean;
    edit(change: () => void): boolean;
    unwritten?(why: BodySequenceUnwritten): void;
    destroy: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  }[],
  readDoc: null as Y.Doc | null,
  adapter: null as Parameters<typeof createLiveAdapter>[0] | null,
}));

vi.mock("../../editor/bridge", () => ({
  post: (kind: string, payload?: { markdown?: unknown }) => {
    hoisted.posted.push(kind);
    hoisted.payloads.push(payload);
    if (kind === "markdown") hoisted.copied.push(payload?.markdown);
  },
}));
vi.mock("@dohc/ydoc-projection/browser-editor", () => ({
  mountLiveBodyEditor: (
    _element: unknown,
    options: { doc: Y.Doc; canEdit(): boolean; edit(change: () => void): boolean },
  ) => {
    const editor = { ...options, destroy: vi.fn(), refresh: vi.fn() };
    hoisted.mounted.push(editor);
    return editor;
  },
}));
vi.mock("@dohc/ydoc-projection", async (original) => ({
  ...(await original<typeof import("@dohc/ydoc-projection")>()),
  markdownToYDoc: () => hoisted.readDoc!,
}));
vi.mock("../../editor/liveAdapter", () => ({
  createLiveAdapter: (options: Parameters<typeof createLiveAdapter>[0]) => {
    hoisted.adapter = options;
    return { receive: () => undefined, provider: () => undefined };
  },
}));

const { markdownToYDoc, yDocToMarkdown } =
  await vi.importActual<typeof import("@dohc/ydoc-projection")>("@dohc/ydoc-projection");
const { mountDocument } = await import("../../editor/document");
const { followLive } = await import("../../editor/live");

class FakeElement {
  className = "";
  textContent: string | null = null;
  hidden = false;
  readonly style = { setProperty: () => undefined };
  append() {}
  after() {}
  remove() {}
  replaceChildren() {}
  addEventListener() {}
  scrollTo() {}
}

function note(format?: number, words = "Packing list") {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, words);
  paragraph.insert(0, [text]);
  getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  if (format !== undefined) doc.getMap("meta").set("schemaVersion", format);
  return doc;
}

const sequenceNote = () => markdownToYDoc("Packing list", { bodySequence: true });

function writes(doc: Y.Doc) {
  let count = 0;
  doc.on("update", () => count++);
  return () => count;
}

function provider(doc: Y.Doc) {
  return {
    doc,
    state: () => ({ status: "live" }),
    subscribe: () => () => undefined,
  } as unknown as LiveProvider;
}

const page = {
  title: "Trip",
  properties: [],
  markdown: "Packing list",
  large: false,
  editable: true,
  textScale: 1,
};

beforeEach(() => {
  hoisted.posted.length = 0;
  hoisted.payloads.length = 0;
  hoisted.copied.length = 0;
  hoisted.mounted.length = 0;
  hoisted.adapter = null;
  const root = new FakeElement();
  vi.stubGlobal("document", {
    getElementById: () => root,
    createElement: () => new FakeElement(),
    documentElement: new FakeElement(),
    addEventListener: () => undefined,
  });
  vi.stubGlobal("window", {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
});
afterEach(() => vi.unstubAllGlobals());

describe("the text the app read", () => {
  it("binds no editor to a note in a format it doesn't know, writes nothing, and tells the app", () => {
    hoisted.readDoc = note(3);
    const written = writes(hoisted.readDoc);
    mountDocument(page);
    expect(hoisted.mounted).toHaveLength(0);
    expect(written()).toBe(0);
    expect(hoisted.posted).toContain("unsupportedFormat");
  });

  it("binds the editor to a note in format 1, with no format, which is 1, or in format 2", () => {
    for (const made of [() => note(1), () => note(), sequenceNote]) {
      hoisted.mounted.length = 0;
      hoisted.readDoc = made();
      mountDocument(page);
      expect(hoisted.mounted).toHaveLength(1);
      expect(hoisted.mounted[0]?.doc).toBe(hoisted.readDoc);
      expect(yDocToMarkdown(hoisted.mounted[0]!.doc)).toBe("Packing list\n");
    }
    expect(hoisted.posted).not.toContain("unsupportedFormat");
  });
});

describe("the live document", () => {
  const follow = () => {
    const endEditing = vi.fn();
    followLive({
      body: new FakeElement() as unknown as HTMLElement,
      readOnly: { destroy: () => undefined },
      label: "Trip",
      endEditing,
    });
    return { changed: hoisted.adapter!.changed, endEditing };
  };

  it("binds no editor to a note in a format it doesn't know, writes nothing, and tells the app", () => {
    const doc = note(3);
    const written = writes(doc);
    const { changed, endEditing } = follow();
    changed(provider(doc));
    changed(provider(doc));
    expect(hoisted.mounted).toHaveLength(0);
    expect(written()).toBe(0);
    expect(hoisted.posted.filter((kind) => kind === "unsupportedFormat")).toHaveLength(1);
    expect(endEditing).toHaveBeenCalled();
  });

  it("binds the editor to a note in format 2 and tells the app why a change was not saved, unless the page refused it", () => {
    const doc = sequenceNote();
    const written = writes(doc);
    const { changed } = follow();
    changed(provider(doc));
    const [editor] = hoisted.mounted;
    expect(hoisted.mounted).toHaveLength(1);
    expect(editor?.doc).toBe(doc);
    expect(editor?.canEdit()).toBe(true);
    editor?.unwritten?.("guarded");
    editor?.unwritten?.("overtaken");
    expect(hoisted.posted.filter((kind) => kind === "unwritten")).toHaveLength(1);
    expect(hoisted.payloads[hoisted.posted.indexOf("unwritten")]).toEqual({ why: "overtaken" });
    expect(hoisted.posted).not.toContain("unsupportedFormat");
    expect(written()).toBe(0);
  });

  it("binds the editor again, in place, once another computer moves the note to format 2", () => {
    const doc = note(1);
    const { changed, endEditing } = follow();
    changed(provider(doc));
    const [first] = hoisted.mounted;
    const elsewhere = new Y.Doc();
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(elsewhere);
    elsewhere.transact(() => {
      elsewhere.getMap("meta").set("schemaVersion", 2);
      elsewhere.getText("sequence").insert(0, "Packing list");
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(elsewhere, before));
    const written = writes(doc);
    const [, second] = hoisted.mounted;
    expect(first?.destroy).toHaveBeenCalledOnce();
    expect(hoisted.mounted).toHaveLength(2);
    expect(second?.doc).toBe(doc);
    expect(second?.canEdit()).toBe(true);
    expect(second?.destroy).not.toHaveBeenCalled();
    expect(endEditing).not.toHaveBeenCalled();
    expect(hoisted.posted).not.toContain("unsupportedFormat");
    expect(written()).toBe(0);
  });

  it("unbinds the editor and takes no edits once another computer moves the note to a format it doesn't know", () => {
    const doc = note(1);
    const { changed } = follow();
    changed(provider(doc));
    const [editor] = hoisted.mounted;
    expect(editor?.canEdit()).toBe(true);

    const elsewhere = new Y.Doc();
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(elsewhere);
    elsewhere.getMap("meta").set("schemaVersion", 3);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(elsewhere, before));

    const written = writes(doc);
    const change = vi.fn();
    expect(editor?.destroy).toHaveBeenCalled();
    expect(editor?.canEdit()).toBe(false);
    expect(editor?.edit(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(written()).toBe(0);
    expect(hoisted.posted).toContain("unsupportedFormat");
  });
});

describe("the live document on a note's new lineage", () => {
  const follow = () => {
    followLive({
      body: new FakeElement() as unknown as HTMLElement,
      readOnly: { destroy: () => undefined },
      label: "Trip",
      endEditing: vi.fn(),
    });
    return hoisted.adapter!.changed;
  };
  const copy = () => {
    (window as unknown as { __dohcCopyMarkdown(): void }).__dohcCopyMarkdown();
    return hoisted.copied.at(-1);
  };

  it("binds the editor to the reopened provider's document, and the old editor and copying leave the old one", () => {
    const changed = follow();
    changed(provider(sequenceNote()));
    const [first] = hoisted.mounted;
    const next = markdownToYDoc("Converted list", { bodySequence: true });
    changed(provider(next));
    const [, second] = hoisted.mounted;
    expect(hoisted.mounted).toHaveLength(2);
    expect(first?.destroy).toHaveBeenCalledOnce();
    expect(second?.doc).toBe(next);
    const change = vi.fn();
    expect(first?.canEdit()).toBe(false);
    expect(first?.edit(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(second?.canEdit()).toBe(true);
    expect(copy()).toBe("Converted list\n");
  });

  it("still copies the old document while the page stays stopped with typing unsent", () => {
    const changed = follow();
    const old = sequenceNote();
    changed(provider(old));
    changed({ ...provider(old), state: () => ({ status: "quarantined" }) } as LiveProvider);
    expect(hoisted.mounted).toHaveLength(1);
    expect(copy()).toBe("Packing list\n");
  });
});

describe("a newer read of the page", () => {
  const app = () =>
    window as unknown as {
      __dohcReplaceRead(markdown: string): void;
      __dohcCopyMarkdown(): void;
      __dohcSetEditable(value: boolean): void;
    };

  it("replaces the read text in the same page, and copying and editing follow the new text", () => {
    hoisted.readDoc = note(1);
    mountDocument(page);
    hoisted.readDoc = note(1, "Packing list and passports");
    app().__dohcReplaceRead("Packing list and passports");
    const [first, second] = hoisted.mounted;
    expect(hoisted.mounted).toHaveLength(2);
    expect(first?.destroy).toHaveBeenCalledOnce();
    expect(second?.destroy).not.toHaveBeenCalled();

    app().__dohcSetEditable(false);
    expect(second?.refresh).toHaveBeenCalled();
    expect(first?.refresh).not.toHaveBeenCalled();
    app().__dohcCopyMarkdown();
    expect(hoisted.copied).toEqual(["Packing list and passports\n"]);
  });

  it("binds no editor to a newer read in a format it doesn't know, leaves no copy or edit bound, and tells the app", () => {
    hoisted.readDoc = note(1);
    mountDocument(page);
    hoisted.readDoc = note(3);
    app().__dohcReplaceRead("Packing list");
    expect(hoisted.mounted).toHaveLength(1);
    expect(hoisted.mounted[0]?.destroy).toHaveBeenCalledOnce();
    expect(hoisted.posted).toContain("unsupportedFormat");
    expect(app().__dohcCopyMarkdown).toBeUndefined();
    expect(app().__dohcSetEditable).toBeUndefined();
  });
});
