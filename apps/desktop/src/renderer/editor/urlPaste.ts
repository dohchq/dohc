import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { ProsemirrorBinding } from "@tiptap/y-tiptap";
import { ContentString, getItem, Item, type Doc, type RelativePosition, type XmlFragment } from "yjs";
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
// Y.js anchors on the URL's first and last characters, in a document bound to
// a Y.Doc.
type SpanAnchors = { start: RelativePosition; end: RelativePosition };
// The pasted URL's span in the document, mapped through every later local
// transaction and found again through `anchors` after a remote one. `chosen`
// is set once the person picks a form, so the row shows Undo.
export interface UrlPasteOfferState {
  from: number; to: number; url: string; text: string; form: UrlForm; chosen: boolean; anchors: SpanAnchors | null;
}
type OfferMeta = { type: "dismiss" } | { type: "chosen" } | { type: "anchor"; anchors: SpanAnchors };
type YTiptap = typeof import("@tiptap/y-tiptap");
type YSync = { type: XmlFragment; binding: ProsemirrorBinding };

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
  return { from, to, url: offer.url, text: offer.text, form: formAt(state, from, to), chosen: false, anchors: null };
}

// The character a Y.js anchor sits on, or null once it is deleted.
function anchoredCharacter(doc: Doc, anchor: RelativePosition): string | null {
  if (!anchor.item) return null;
  try {
    const item = getItem(doc.store, anchor.item);
    if (!(item instanceof Item) || item.deleted || !(item.content instanceof ContentString)) return null;
    return item.content.str[anchor.item.clock - item.id.clock] ?? null;
  } catch {
    return null;
  }
}

// y-tiptap anchors a position to the character before it, so `from + 1`
// anchors the URL's first character and `to` its last.
function anchorSpan(yTiptap: YTiptap, sync: YSync, offer: UrlPasteOfferState): SpanAnchors | null {
  const anchors = {
    start: yTiptap.absolutePositionToRelativePosition(offer.from + 1, sync.type, sync.binding.mapping),
    end: yTiptap.absolutePositionToRelativePosition(offer.to, sync.type, sync.binding.mapping),
  };
  const span = sync.type.doc && anchoredSpan(yTiptap, sync, anchors, offer.text);
  return span?.from === offer.from && span.to === offer.to ? anchors : null;
}

// Y.js applies a remote edit, or an undo, by replacing the whole document,
// which maps every position away. The anchors find the pasted characters
// themselves, so the span is the person's own paste or nothing: a deleted
// character, or one that no longer starts or ends the URL, dismisses it.
function anchoredSpan(yTiptap: YTiptap, sync: YSync, anchors: SpanAnchors, text: string): { from: number; to: number } | null {
  const doc = sync.type.doc;
  if (!doc || anchoredCharacter(doc, anchors.start) !== text[0] || anchoredCharacter(doc, anchors.end) !== text.at(-1)) return null;
  const start = yTiptap.relativePositionToAbsolutePosition(doc, sync.type, anchors.start, sync.binding.mapping);
  const end = yTiptap.relativePositionToAbsolutePosition(doc, sync.type, anchors.end, sync.binding.mapping);
  return start === null || end === null ? null : { from: start - 1, to: end };
}

// The offer a URL paste raises. It leaves when its text changes or the caret
// leaves its line; typing, composing, Escape and a click elsewhere dismiss it
// from the row and the editor's key handler. `yTiptap` is the lazily loaded
// y-tiptap module when the editor is bound to a Y.Doc.
export function makeUrlPasteOfferPlugin(
  onChange: (offer: UrlPasteOfferState | null) => void,
  yTiptap: YTiptap | null = null,
) {
  let pending: UrlPasteOffer | null = null;
  return new Plugin<UrlPasteOfferState | null>({
    key: urlPasteOfferKey,
    state: {
      init: () => null,
      apply(tr, value, old, state) {
        const meta = tr.getMeta(urlPasteOfferKey) as OfferMeta | undefined;
        if (meta?.type === "dismiss") return null;
        if (pending && tr.getMeta("uiEvent") === "paste") {
          const offer = pending;
          pending = null;
          return spanOf(offer, tr, state);
        }
        if (!value) return null;
        if (meta?.type === "anchor") return { ...value, anchors: meta.anchors };
        const change: { isChangeOrigin?: boolean } | undefined = yTiptap ? tr.getMeta(yTiptap.ySyncPluginKey) : undefined;
        let from = tr.mapping.map(value.from, 1);
        let to = tr.mapping.map(value.to, -1);
        if (yTiptap && change?.isChangeOrigin) {
          // Read from the old state: this state's later plugins aren't built yet.
          const sync = yTiptap.ySyncPluginKey.getState(old) as YSync | undefined;
          const span = value.anchors && sync ? anchoredSpan(yTiptap, sync, value.anchors, value.text) : null;
          if (!span) return null;
          ({ from, to } = span);
        }
        if (tr.docChanged && (to - from !== value.text.length || state.doc.textBetween(from, to) !== value.text)) return null;
        if (!state.selection.$head.sameParent(state.doc.resolve(from))) return null;
        if (!tr.docChanged && meta?.type !== "chosen") return value;
        const form = formAt(state, from, to);
        const chosen = value.chosen || meta?.type === "chosen";
        return from === value.from && to === value.to && form === value.form && chosen === value.chosen
          ? value
          : { ...value, from, to, form, chosen };
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
        // y-tiptap's view writes the paste to the Y.Doc before this one runs,
        // so the anchors can be taken now. anchorSpan checks that they find it.
        const sync = yTiptap?.ySyncPluginKey.getState(view.state) as YSync | undefined;
        const anchors = yTiptap && sync && offer && !offer.anchors ? anchorSpan(yTiptap, sync, offer) : null;
        if (anchors) {
          view.dispatch(view.state.tr.setMeta(urlPasteOfferKey, { type: "anchor", anchors }));
          return;
        }
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
