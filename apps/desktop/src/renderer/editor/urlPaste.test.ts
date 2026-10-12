import { describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { detectUrlPaste, handleUrlPaste } from "./urlPaste";
const base = { text: "https://example.com/path", from: 1, to: 1, ownLine: true, inCode: false };
describe("URL paste offer", () => {
  it("recognizes HTTP URLs while preserving the pasted text", () => {
    expect(detectUrlPaste(base)).toEqual({ kind: "url-paste", text: base.text, url: base.text, from: 1, to: 1 });
    expect(detectUrlPaste({ ...base, text: "http://example.com" })?.url).toBe("http://example.com/");
  });
  it.each(["plain text", "https://", "javascript:alert(1)", "file:///secret", "https://example.com other", "https://example.com\n", "https://user:password@example.com"])("ignores %s", text => {
    expect(detectUrlPaste({ ...base, text })).toBeNull();
  });
  it("ignores code, selections, inline text and oversized pastes", () => {
    for (const override of [{ inCode: true }, { ownLine: false }, { to: 5 }, { text: "https://example.com/" + "a".repeat(8192) }]) {
      expect(detectUrlPaste({ ...base, ...override })).toBeNull();
    }
  });
  it("observes the editor paste without dispatch, prevention or a network request", () => {
    const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", group: "block" }, text: {} } });
    const state = EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("paragraph")]) });
    const dispatch = vi.fn();
    const view = { state, dispatch, editable: true } as unknown as EditorView;
    const event = { clipboardData: { files: [], getData: () => base.text }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    const offer = vi.fn();
    expect(handleUrlPaste(view, event, offer)).toBe(false);
    expect(offer).toHaveBeenCalledExactlyOnceWith({ kind: "url-paste", text: base.text, url: base.text, from: 1, to: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    const nonempty = EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("some text")])]) });
    handleUrlPaste({ ...view, state: nonempty.apply(nonempty.tr.setSelection(TextSelection.create(nonempty.doc, 2, 5))) } as EditorView, event, offer);
    expect(offer).toHaveBeenCalledTimes(1);
  });
});
