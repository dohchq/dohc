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
