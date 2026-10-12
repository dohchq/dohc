import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
export interface UrlPasteOffer { kind: "url-paste"; text: string; url: string; from: number; to: number }
export function detectUrlPaste(input: { text: string; from: number; to: number; ownLine: boolean; inCode: boolean }): UrlPasteOffer | null {
  if (!input.ownLine || input.inCode || input.from !== input.to || input.text.length > 8192 || /\s/.test(input.text)
    || !/^https?:\/\//i.test(input.text)) return null;
  try {
    const url = new URL(input.text);
    if (!url.hostname || url.username || url.password) return null;
    return { kind: "url-paste", text: input.text, url: url.href, from: input.from, to: input.to };
  } catch { return null; }
}
// Observes only paste. It neither fetches nor consumes the editor transaction.
export function handleUrlPaste(view: EditorView, event: ClipboardEvent, offer?: (offer: UrlPasteOffer) => void): false {
  if (!offer || !view.editable || !event.clipboardData || event.clipboardData.files.length) return false;
  const { from, to, $from } = view.state.selection;
  const found = detectUrlPaste({ text: event.clipboardData.getData("text/plain"), from, to,
    ownLine: $from.parent.isTextblock
      && ($from.parent.textBetween(0, $from.parentOffset, "\n", "\n").split("\n").at(-1) ?? "").trim() === ""
      && ($from.parent.textBetween($from.parentOffset, $from.parent.content.size, "\n", "\n").split("\n")[0] ?? "").trim() === "",
    inCode: Boolean($from.parent.type.spec.code || $from.marks().some(mark => mark.type.name === "code")),
  });
  if (found) offer(found);
  return false;
}

export type UrlForm = "link" | "plain";
// The pasted URL's span in the document, mapped through every later
// transaction. `line` and `offset` identify it: the text of its line, and
// where in that line it starts. `chosen` is set once the person picks a form,
// so the row shows Undo.
export interface UrlPasteOfferState {
  from: number; to: number; url: string; text: string; line: string; offset: number; form: UrlForm; chosen: boolean;
}
type OfferMeta = { type: "dismiss" } | { type: "chosen" };

export const urlPasteOfferKey = new PluginKey<UrlPasteOfferState | null>("dohc-url-paste-offer");

function formAt(state: EditorState, from: number, to: number): UrlForm {
  const link = state.schema.marks.link;
  return link && state.doc.rangeHasMark(from, to, link) ? "link" : "plain";
}

function spanOf(offer: UrlPasteOffer, tr: Transaction, state: EditorState): UrlPasteOfferState | null {
  const from = tr.mapping.map(offer.from, -1);
  const to = tr.mapping.map(offer.from, 1);
  if (to - from !== offer.text.length || !state.doc.resolve(from).sameParent(state.doc.resolve(to))) return null;
  if (state.doc.textBetween(from, to) !== offer.text) return null;
  return { from, to, url: offer.url, text: offer.text, ...lineOf(state, from), form: formAt(state, from, to), chosen: false };
}

// One character for each inline leaf, so offsets in the line are positions.
function lineText(block: ProseMirrorNode): string {
  return block.textBetween(0, block.content.size, undefined, "￼");
}

function lineOf(state: EditorState, from: number): { line: string; offset: number } {
  const $from = state.doc.resolve(from);
  return { line: lineText($from.parent), offset: from - $from.start() };
}

// Y.js applies a remote edit, or an undo, by replacing the whole document,
// which maps the span away. The span survives only where nothing can be
// mistaken for it: the caret's line is its line, unchanged and the only line
// with that text in the document, and the URL is at its offset. Anything less
// dismisses the offer, so a choice never touches text the person didn't paste.
function refind(state: EditorState, offer: UrlPasteOfferState): number | null {
  const { $head } = state.selection;
  if (!$head.parent.isTextblock || lineText($head.parent) !== offer.line) return null;
  let copies = 0;
  state.doc.descendants((node) => {
    if (!node.isTextblock) return copies < 2;
    if (lineText(node) === offer.line) copies += 1;
    return false;
  });
  return copies === 1 ? $head.start() + offer.offset : null;
}

// The offer a URL paste raises. It leaves when its text changes or the caret
// leaves its line; typing, composing, Escape and a click elsewhere dismiss it
// from the row and the editor's key handler.
export function makeUrlPasteOfferPlugin(onChange: (offer: UrlPasteOfferState | null) => void) {
  let pending: UrlPasteOffer | null = null;
  return new Plugin<UrlPasteOfferState | null>({
    key: urlPasteOfferKey,
    state: {
      init: () => null,
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(urlPasteOfferKey) as OfferMeta | undefined;
        if (meta?.type === "dismiss") return null;
        if (pending && tr.getMeta("uiEvent") === "paste") {
          const offer = pending;
          pending = null;
          return spanOf(offer, tr, state);
        }
        if (!value) return null;
        let from = tr.mapping.map(value.from, 1);
        let to = tr.mapping.map(value.to, -1);
        if (tr.docChanged && (to - from !== value.text.length || state.doc.textBetween(from, to) !== value.text)) {
          const found = refind(state, value);
          if (found === null) return null;
          from = found;
          to = found + value.text.length;
        }
        if (!state.selection.$head.sameParent(state.doc.resolve(from))) return null;
        if (!tr.docChanged && meta?.type !== "chosen") return value;
        const { line, offset } = lineOf(state, from);
        const form = formAt(state, from, to);
        const chosen = value.chosen || meta?.type === "chosen";
        return from === value.from && to === value.to && line === value.line && offset === value.offset
          && form === value.form && chosen === value.chosen
          ? value
          : { ...value, from, to, line, offset, form, chosen };
      },
    },
    props: {
      handlePaste: (view, event) => handleUrlPaste(view, event, offer => { pending = offer; }),
      // ProseMirror gives the key handler no keys while an IME composes.
      handleDOMEvents: {
        compositionstart: (view) => {
          dismissUrlPasteOffer(view);
          return false;
        },
      },
    },
    view: () => ({
      update(view, previous) {
        const offer = urlPasteOfferKey.getState(view.state) ?? null;
        if (offer !== (urlPasteOfferKey.getState(previous) ?? null)) onChange(offer);
      },
      destroy: () => onChange(null),
    }),
  });
}

export function dismissUrlPasteOffer(view: EditorView): void {
  if (urlPasteOfferKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(urlPasteOfferKey, { type: "dismiss" }));
}

// One transaction, its own undo step, so Undo takes back the choice and
// leaves the paste. Choosing the form the text already has changes nothing.
export function chooseUrlForm(view: EditorView, form: UrlForm): void {
  const offer = urlPasteOfferKey.getState(view.state);
  const link = view.state.schema.marks.link;
  if (!offer || !link) return;
  if (offer.form === form) {
    dismissUrlPasteOffer(view);
    return;
  }
  const tr = form === "link"
    ? view.state.tr.addMark(offer.from, offer.to, link.create({ href: offer.url }))
    : view.state.tr.removeMark(offer.from, offer.to, link);
  view.dispatch(closeHistory(tr).setMeta(urlPasteOfferKey, { type: "chosen" }));
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

// Mod+K reaches the row while an offer stands; Escape dismisses it; any other
// key is typing, which dismisses it too. With no offer, a key costs one
// plugin state read.
export function urlPasteOfferKeyDown(view: EditorView, event: KeyboardEvent, focusRow: () => void): boolean {
  if (!urlPasteOfferKey.getState(view.state) || MODIFIER_KEYS.has(event.key)) return false;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
    focusRow();
    return true;
  }
  dismissUrlPasteOffer(view);
  return event.key === "Escape";
}
