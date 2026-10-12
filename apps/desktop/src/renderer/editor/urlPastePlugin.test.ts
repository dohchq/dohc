// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
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

// A remote Y.js update as the editor receives it: the whole document
// replaced in one step, and the caret restored to `caret`, where its text
// moved. `edit` changes the document's JSON: paragraphs, then their nodes.
type Json = { type: string; text?: string; content?: Json[] };
function remoteReplace(target: Editor, edit: (paragraphs: Json[]) => void, caret: number) {
  const json = structuredClone(target.state.doc.toJSON()) as Json;
  edit(json.content!);
  const next = target.schema.nodeFromJSON(json);
  const tr = target.state.tr.replaceWith(0, target.state.doc.content.size, next.content).setMeta("addToHistory", false);
  target.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)));
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
      from: 9, to: 9 + URL_TEXT.length, url: URL_TEXT, text: URL_TEXT, line: URL_TEXT, offset: 0, form: "link", chosen: false,
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

  it("stays through a remote edit that replaces the whole document", () => {
    const { editor } = setup();
    paste(editor);
    // Another paragraph grows by eight characters; the caret, after the URL,
    // moves with it from 33 to 41.
    remoteReplace(editor, ([before]) => { before!.content![0]!.text = "Before, edited"; }, 41);
    expect(offer(editor)).toMatchObject({ from: 17, to: 17 + URL_TEXT.length, form: "link" });
    chooseUrlForm(editor.view, "plain");
    expect(offer(editor)).toMatchObject({ form: "plain", chosen: true });
  });

  it("leaves when a remote edit changes its text", () => {
    const { editor } = setup();
    paste(editor);
    remoteReplace(editor, ([, line]) => { line!.content![0]!.text = `${URL_TEXT}/other`; }, 33);
    expect(offer(editor)).toBeNull();
  });

  // Never act on text the person didn't paste: when a remote edit leaves
  // another copy of the URL where the pasted one might be, the offer leaves.
  it("leaves when a remote edit puts a second copy of the URL on its line", () => {
    const { editor } = setup();
    paste(editor);
    remoteReplace(editor, ([, line]) => {
      line!.content!.push({ type: "text", text: " " }, structuredClone(line!.content![0]!));
    }, 33);
    expect(offer(editor)).toBeNull();
    chooseUrlForm(editor.view, "plain");
    expect(linkedTexts(editor)).toEqual([URL_TEXT, URL_TEXT]);
  });

  it("leaves when a remote edit puts the caret in another paragraph with the URL", () => {
    const { editor } = setup();
    paste(editor);
    // "After" becomes "See " and a linked copy; the caret lands at its end.
    remoteReplace(editor, ([, line, after]) => {
      after!.content = [{ type: "text", text: "See " }, structuredClone(line!.content![0]!)];
    }, 35 + 4 + URL_TEXT.length);
    expect(offer(editor)).toBeNull();
    chooseUrlForm(editor.view, "plain");
    expect(linkedTexts(editor)).toEqual([URL_TEXT, URL_TEXT]);
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
