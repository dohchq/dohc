import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { createLiveAdapter, LiveProvider } from "../../editor/liveAdapter";

const hoisted = vi.hoisted(() => ({
  posted: [] as string[],
  mounted: [] as {
    canEdit(): boolean;
    edit(change: () => void): boolean;
    destroy: ReturnType<typeof vi.fn>;
  }[],
  readDoc: null as Y.Doc | null,
  adapter: null as Parameters<typeof createLiveAdapter>[0] | null,
}));

vi.mock("../../editor/bridge", () => ({
  post: (kind: string) => hoisted.posted.push(kind),
}));
vi.mock("@dohc/ydoc-projection/browser-editor", () => ({
  mountLiveBodyEditor: (
    _body: unknown,
    options: { canEdit(): boolean; edit(change: () => void): boolean },
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
  addEventListener() {}
  scrollTo() {}
}

function note(format?: number) {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "Packing list");
  paragraph.insert(0, [text]);
  getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  if (format !== undefined) doc.getMap("meta").set("schemaVersion", format);
  return doc;
}

function writes(doc: Y.Doc) {
  let count = 0;
  doc.on("update", () => count++);
  return () => count;
}

function provider(doc: Y.Doc) {
  return {
    doc,
    body: getDohcYDocBodyFragment(doc),
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
  it("binds no editor to a note in format 2, writes nothing, and tells the app", () => {
    hoisted.readDoc = note(2);
    const written = writes(hoisted.readDoc);
    mountDocument(page);
    expect(hoisted.mounted).toHaveLength(0);
    expect(written()).toBe(0);
    expect(hoisted.posted).toContain("unsupportedFormat");
  });

  it("binds the editor to a note in format 1, or with no format, which is 1", () => {
    for (const format of [1, undefined]) {
      hoisted.mounted.length = 0;
      hoisted.readDoc = note(format);
      mountDocument(page);
      expect(hoisted.mounted).toHaveLength(1);
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

  it("binds no editor to a note in format 2, writes nothing, and tells the app", () => {
    const doc = note(2);
    const written = writes(doc);
    const { changed, endEditing } = follow();
    changed(provider(doc));
    changed(provider(doc));
    expect(hoisted.mounted).toHaveLength(0);
    expect(written()).toBe(0);
    expect(hoisted.posted.filter((kind) => kind === "unsupportedFormat")).toHaveLength(1);
    expect(endEditing).toHaveBeenCalled();
  });

  it("unbinds the editor and takes no edits once another computer moves the note to format 2", () => {
    const doc = note(1);
    const { changed } = follow();
    changed(provider(doc));
    const [editor] = hoisted.mounted;
    expect(editor?.canEdit()).toBe(true);

    const elsewhere = new Y.Doc();
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(elsewhere);
    elsewhere.getMap("meta").set("schemaVersion", 2);
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
