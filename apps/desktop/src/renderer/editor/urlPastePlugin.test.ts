// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { Collaboration } from "@tiptap/extension-collaboration";
import * as yTiptap from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  chooseUrlForm,
  makeUrlPasteOfferPlugin,
  urlPasteOfferKey,
  urlPasteOfferKeyDown,
  type UrlPasteOfferState,
} from "./urlPaste";

const URL_TEXT = "https://example.com/trip";
let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

// The caret starts inside the empty second paragraph, at 9.
function setup(content = "<p>Before</p><p></p><p>After</p>", caret = 9) {
  const changes: Array<UrlPasteOfferState | null> = [];
  editor = new Editor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, linkOnPaste: false } }),
      Extension.create({ name: "urlOffer", addProseMirrorPlugins: () => [makeUrlPasteOfferPlugin((offer) => changes.push(offer))] }),
    ],
    content,
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)));
  return { editor, changes };
}

function offer(target: Editor) {
  return urlPasteOfferKey.getState(target.state) ?? null;
}

// The editor's paste: the handler sees the clipboard, then the transaction
// ProseMirror dispatches for it.
function paste(target: Editor, text = URL_TEXT) {
  const event = {
    clipboardData: { files: [], getData: (type: string) => (type === "text/plain" ? text : "") },
  } as unknown as ClipboardEvent;
  target.view.someProp("handlePaste", (handle) => handle(target.view, event, Slice.empty));
  const tr = target.state.tr.insertText(text, target.state.selection.from);
  target.view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste"));
}

// Each linked text in the document, in order.
function linkedTexts(target: Editor): string[] {
  const texts: string[] = [];
  target.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "link")) texts.push(node.text!);
  });
  return texts;
}

function key(target: Editor, init: KeyboardEventInit) {
  const focusRow = vi.fn();
  const handled = urlPasteOfferKeyDown(target.view, new KeyboardEvent("keydown", init), focusRow);
  return { handled, focusRow };
}

describe("URL paste offer", () => {
  // The link extension's paste rule links a pasted URL in the transaction it
  // appends, so the current form follows the document, not the paste.
  it("appears under a URL pasted on its own line, with the current form marked", () => {
    const { editor, changes } = setup();
    paste(editor);
    expect(offer(editor)).toEqual({
      from: 9, to: 9 + URL_TEXT.length, url: URL_TEXT, text: URL_TEXT, form: "link", chosen: false, anchors: null,
    });
    expect(changes.at(-1)).toBe(offer(editor));
  });

  it("never follows a keystroke: a URL typed key by key raises nothing", () => {
    const { editor, changes } = setup();
    for (const character of URL_TEXT) editor.view.dispatch(editor.state.tr.insertText(character));
    expect(offer(editor)).toBeNull();
    expect(changes).toEqual([]);
  });

  it("stays through a modifier and is dismissed by typing", () => {
    const { editor } = setup();
    paste(editor);
    expect(key(editor, { key: "Control", ctrlKey: true }).handled).toBe(false);
    expect(offer(editor)).not.toBeNull();
    expect(key(editor, { key: "a" }).handled).toBe(false);
    expect(offer(editor)).toBeNull();
  });

  it("is dismissed by Escape, which the editor then does not see", () => {
    const { editor } = setup();
    paste(editor);
    expect(key(editor, { key: "Escape" }).handled).toBe(true);
    expect(offer(editor)).toBeNull();
  });

  it("leaves when the caret leaves its line", () => {
    const { editor } = setup();
    paste(editor);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
    expect(offer(editor)).toBeNull();
  });

  it("reaches the row on Mod+K without leaving", () => {
    const { editor } = setup();
    paste(editor);
    const { handled, focusRow } = key(editor, { key: "k", ctrlKey: true });
    expect(handled).toBe(true);
    expect(focusRow).toHaveBeenCalledOnce();
    expect(offer(editor)).not.toBeNull();
    // With no offer, Mod+K stays the link menu's.
    editor.view.dispatch(editor.state.tr.setMeta(urlPasteOfferKey, { type: "dismiss" }));
    expect(key(editor, { key: "k", ctrlKey: true }).handled).toBe(false);
  });

  it("makes a choice one transaction, mapped through later ones, that Undo takes back alone", () => {
    const { editor } = setup();
    paste(editor);
    const dispatch = vi.spyOn(editor.view, "dispatch");
    chooseUrlForm(editor.view, "plain");
    expect(dispatch).toHaveBeenCalledOnce();
    dispatch.mockRestore();
    expect(offer(editor)).toMatchObject({ form: "plain", chosen: true });
    expect(editor.getHTML()).toContain(`<p>${URL_TEXT}</p>`);

    // Another person's edit above the line moves the span. It is not in this
    // editor's undo history.
    editor.view.dispatch(editor.state.tr.insertText("Earlier ", 1).setMeta("addToHistory", false));
    expect(offer(editor)).toMatchObject({ from: 17, to: 17 + URL_TEXT.length, chosen: true });

    // Undo is the editor's own: the link returns, and the paste stays.
    editor.chain().undo().run();
    expect(editor.getHTML()).toContain(`href="${URL_TEXT}">${URL_TEXT}</a>`);
    expect(editor.getHTML()).toContain("Earlier");
    expect(offer(editor)).toMatchObject({ form: "link" });
  });

  it("changes nothing when the current form is chosen", () => {
    const { editor } = setup();
    paste(editor);
    const before = editor.state.doc;
    chooseUrlForm(editor.view, "link");
    expect(editor.state.doc).toBe(before);
    expect(offer(editor)).toBeNull();
  });

  // Without a Y.Doc nothing replaces the whole document but the editor's own
  // setContent, and mapping is exact: the span is gone, so the offer is.
  it("leaves when the whole document is replaced in an editor without a Y.Doc", () => {
    const { editor } = setup();
    paste(editor);
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, editor.state.doc.content);
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 33)));
    expect(offer(editor)).toBeNull();
  });

  it("is dismissed when an IME starts composing, which the key handler never sees", () => {
    const { editor } = setup();
    paste(editor);
    editor.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(offer(editor)).toBeNull();
  });

  it("leaves when its text changes", () => {
    const { editor } = setup();
    paste(editor);
    const { from } = offer(editor)!;
    editor.view.dispatch(editor.state.tr.insertText("x", from + 4));
    expect(offer(editor)).toBeNull();
  });

  it("ignores a URL pasted beside other text", () => {
    const { editor } = setup("<p>See </p>", 5);
    paste(editor);
    expect(offer(editor)).toBeNull();
  });
});

// A collaborator's edits arrive through Y.js, which replaces the whole
// document in the editor and restores the caret. The offer follows the pasted
// characters themselves, and never moves to text the person didn't paste.
describe("URL paste offer in a shared document", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  // The editor on one Y.Doc, and a collaborator's Y.Doc synced both ways.
  function setupShared(content: string) {
    const ydoc = new Y.Doc();
    const peer = new Y.Doc();
    docs.push(ydoc, peer);
    const relay = (from: Y.Doc, to: Y.Doc) =>
      from.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "relay") Y.applyUpdate(to, update, "relay");
      });
    relay(ydoc, peer);
    relay(peer, ydoc);
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({ trailingNode: false, undoRedo: false, link: { openOnClick: false, linkOnPaste: false } }),
        Collaboration.configure({ document: ydoc }),
        Extension.create({ name: "urlOffer", addProseMirrorPlugins: () => [makeUrlPasteOfferPlugin(() => {}, yTiptap)] }),
      ],
    });
    editor.commands.setContent(content);
    editor.commands.setTextSelection(9);
    const fragment = peer.getXmlFragment("default");
    const peerText = (paragraph: number) => (fragment.get(paragraph) as Y.XmlElement).get(0) as Y.XmlText;
    return { editor, fragment, peerText };
  }

  it("anchors the paste in the Y.Doc and keeps it through an edit elsewhere", () => {
    const { editor, peerText } = setupShared("<p>Before</p><p></p><p>After</p>");
    paste(editor);
    expect(offer(editor)?.anchors).not.toBeNull();
    peerText(0).insert(6, ", edited");
    expect(editor.state.doc.child(0).textContent).toBe("Before, edited");
    expect(offer(editor)).toMatchObject({ from: 17, to: 17 + URL_TEXT.length, form: "link" });
    chooseUrlForm(editor.view, "plain");
    expect(offer(editor)).toMatchObject({ form: "plain", chosen: true });
    expect(linkedTexts(editor)).toEqual([]);
  });

  it("leaves when a remote edit changes its text", () => {
    const { editor, peerText } = setupShared("<p>Before</p><p></p><p>After</p>");
    paste(editor);
    peerText(1).delete(10, 1);
    expect(offer(editor)).toBeNull();
  });

  it("leaves when a remote edit deletes the pasted line, and never takes an identical one", () => {
    const { editor, fragment } = setupShared(`<p>Before</p><p></p><p><a href="${URL_TEXT}">${URL_TEXT}</a></p>`);
    paste(editor);
    expect(linkedTexts(editor)).toEqual([URL_TEXT, URL_TEXT]);
    fragment.delete(1, 1);
    expect(editor.state.doc.childCount).toBe(2);
    expect(offer(editor)).toBeNull();
    chooseUrlForm(editor.view, "plain");
    expect(linkedTexts(editor)).toEqual([URL_TEXT]);
  });

  it("keeps its own span when a collaborator adds a copy of the URL to its line", () => {
    const { editor, peerText } = setupShared("<p>Before</p><p></p><p>After</p>");
    paste(editor);
    peerText(1).insert(URL_TEXT.length, " ", { link: null });
    peerText(1).insert(URL_TEXT.length + 1, URL_TEXT, { link: { href: URL_TEXT } });
    expect(linkedTexts(editor)).toEqual([URL_TEXT, URL_TEXT]);
    expect(offer(editor)).toMatchObject({ from: 9, to: 9 + URL_TEXT.length });
    chooseUrlForm(editor.view, "plain");
    // The collaborator's copy keeps its link.
    expect(linkedTexts(editor)).toEqual([URL_TEXT]);
    expect(editor.state.doc.textBetween(9 + URL_TEXT.length + 1, 9 + 2 * URL_TEXT.length + 1)).toBe(URL_TEXT);
    expect(editor.state.doc.rangeHasMark(9 + URL_TEXT.length + 1, 9 + 2 * URL_TEXT.length + 1, editor.schema.marks.link!)).toBe(true);
  });

  it("leaves when the caret moves into another paragraph with the URL", () => {
    const { editor, fragment } = setupShared("<p>Before</p><p></p><p>After</p>");
    paste(editor);
    // A collaborator adds a last paragraph holding a linked copy.
    const text = new Y.XmlText();
    const copy = new Y.XmlElement("paragraph");
    copy.insert(0, [text]);
    fragment.insert(3, [copy]);
    text.insert(0, URL_TEXT, { link: { href: URL_TEXT } });
    expect(offer(editor)).not.toBeNull();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(offer(editor)).toBeNull();
    chooseUrlForm(editor.view, "plain");
    expect(linkedTexts(editor)).toEqual([URL_TEXT, URL_TEXT]);
  });
});
