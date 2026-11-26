// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { declareBodySequence } from "@dohc/ydoc-projection/body-sequence-yjs";
import { ShellErrorReporter, type ReportShellFailure } from "../shell/useShellError";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { urlPasteOfferKey } from "./urlPaste";

type EditorElement = HTMLElement & { editor: Editor };

const docs: Y.Doc[] = [];

function sequenceDoc(seed: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  declareBodySequence(doc);
  Y.applyUpdate(doc, seed);
  docs.push(doc);
  return doc;
}

function note(markdown: string): Y.Doc {
  return sequenceDoc(Y.encodeStateAsUpdate(markdownToYDoc(markdown, { bodySequence: true })));
}

function withPeer(doc: Y.Doc): Y.Doc {
  const peer = sequenceDoc(Y.encodeStateAsUpdate(doc));
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(peer, update, "relay");
  });
  peer.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(doc, update, "relay");
  });
  return peer;
}

function insertAfter(text: Y.Text, needle: string, inserted: string) {
  let index = 0;
  for (const { insert } of text.toDelta() as Array<{ insert: string | object }>) {
    if (typeof insert === "string" && insert.includes(needle)) {
      text.insert(index + insert.indexOf(needle) + needle.length, inserted);
      return;
    }
    index += typeof insert === "string" ? insert.length : 1;
  }
  throw new Error(`The sequence holds no ${needle}.`);
}

function LiveEditor(props: {
  ydoc: Y.Doc;
  pane?: string;
  handle?: React.Ref<MarkdownEditorHandle>;
}) {
  return (
    <div data-pane={props.pane ?? "one"}>
      <MarkdownEditor
        ref={props.handle}
        value=""
        onDirty={vi.fn()}
        workspaceId="workspace-1"
        path="plan.md"
        knownFiles={[]}
        collab={{ ydoc: props.ydoc, status: "connected", peerCount: 0, synced: true }}
      />
    </div>
  );
}

async function editorIn(pane = "one"): Promise<Editor> {
  const element = await waitFor(() => {
    const found = document.querySelector<EditorElement>(
      `[data-pane="${pane}"] [data-testid="markdown-editor"]`,
    );
    if (!found?.editor) throw new Error("The editor is not mounted yet.");
    return found;
  });
  return element.editor;
}

function input(editor: Editor, inputType: string) {
  act(() => {
    editor.view.dom.dispatchEvent(
      new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }),
    );
  });
}

function key(editor: Editor, init: KeyboardEventInit) {
  act(() => {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init }),
    );
  });
}

function typeAtEnd(editor: Editor, text: string) {
  act(() => {
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.insertText(text, end));
  });
}

afterEach(() => {
  cleanup();
  for (const doc of docs.splice(0)) doc.destroy();
});

describe("MarkdownEditor on a format-2 note", () => {
  it("writes edits to the sequence, and undoes them by key and from the Edit menu", async () => {
    const ydoc = note("# Plan\n\nPack");
    render(<LiveEditor ydoc={ydoc} />);
    const editor = await editorIn();
    expect(editor.view.dom.getAttribute("data-note-format")).toBe("2");

    typeAtEnd(editor, " bags");
    expect(yDocToMarkdown(ydoc)).toBe("# Plan\n\nPack bags\n");
    expect(ydoc.getXmlFragment("body").length).toBe(0);

    key(editor, { key: "z", keyCode: 90 });
    expect(yDocToMarkdown(ydoc)).toBe("# Plan\n\nPack\n");
    key(editor, { key: "Z", keyCode: 90, shiftKey: true });
    expect(yDocToMarkdown(ydoc)).toBe("# Plan\n\nPack bags\n");

    input(editor, "historyUndo");
    expect(editor.state.doc.textContent).toBe("PlanPack");
    input(editor, "historyRedo");
    expect(editor.state.doc.textContent).toBe("PlanPack bags");
  });

  it("shares one history between two panes, and shows a peer's change in both", async () => {
    const ydoc = note("Pack");
    const peer = withPeer(ydoc);
    render(
      <>
        <LiveEditor ydoc={ydoc} pane="one" />
        <LiveEditor ydoc={ydoc} pane="two" />
      </>,
    );
    const one = await editorIn("one");
    const two = await editorIn("two");

    typeAtEnd(one, " bags");
    expect(two.state.doc.textContent).toBe("Pack bags");
    input(two, "historyUndo");
    expect(one.state.doc.textContent).toBe("Pack");
    expect(two.state.doc.textContent).toBe("Pack");

    act(() => insertAfter(peer.getText("sequence"), "Pack", " light"));
    expect(one.state.doc.textContent).toBe("Pack light");
    expect(two.state.doc.textContent).toBe("Pack light");
    expect(yDocToMarkdown(ydoc)).toBe("Pack light\n");
  });

  it("mounts again with the note's format when its document is replaced", async () => {
    const first = markdownToYDoc("Old body");
    docs.push(first);
    const view = render(<LiveEditor ydoc={first} />);
    expect((await editorIn()).view.dom.getAttribute("data-note-format")).toBe("1");

    view.rerender(<LiveEditor ydoc={note("New body")} />);
    await waitFor(async () => {
      const editor = await editorIn();
      expect(editor.view.dom.getAttribute("data-note-format")).toBe("2");
      expect(editor.state.doc.textContent).toBe("New body");
    });
  });

  it("puts the first caret at the start of a note that opens with a to-do list", async () => {
    render(<LiveEditor ydoc={note("- [ ] Milk\n- [ ] Eggs")} />);
    const { $from } = (await editorIn()).state.selection;
    expect($from.parent.textContent).toBe("Milk");
    expect($from.parentOffset).toBe(0);
  });

  it("writes a list made from a paragraph, and a ticked to-do", async () => {
    const ydoc = note("Milk\n\n- [ ] Eggs");
    render(<LiveEditor ydoc={ydoc} />);
    const editor = await editorIn();
    act(() => {
      editor.chain().setTextSelection(1).toggleBulletList().run();
    });
    expect(yDocToMarkdown(ydoc)).toBe("- Milk\n\n- [ ] Eggs\n");

    act(() => {
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "taskItem") return true;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: true }),
        );
        return false;
      });
    });
    expect(yDocToMarkdown(ydoc)).toBe("- Milk\n\n- [x] Eggs\n");
  });

  it("refuses typed text it cannot write, puts the note back, and files one notice", async () => {
    const ydoc = note("Pack");
    const report = vi.fn<ReportShellFailure>();
    const handle = createRef<MarkdownEditorHandle>();
    render(
      <ShellErrorReporter.Provider value={report}>
        <LiveEditor ydoc={ydoc} handle={handle} />
      </ShellErrorReporter.Provider>,
    );
    const editor = await editorIn();

    const huge = "x".repeat(3 * 1024 * 1024);
    let taken: boolean | undefined;
    act(() => {
      taken = handle.current!.insertTypedText(huge, huge.length);
    });
    expect(taken).toBe(false);
    expect(editor.state.doc.textContent).toBe("Pack");
    expect(yDocToMarkdown(ydoc)).toBe("Pack\n");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({
      retry: null,
      identity: "unwritten-note-change:plan.md",
    });

    act(() => {
      taken = handle.current!.insertTypedText("Lunch", 5);
    });
    expect(taken).toBe(true);
    expect(yDocToMarkdown(ydoc)).toBe("Lunch\n\nPack\n");
  });

  it("keeps a pasted URL's offer through a peer's change that arrives straight after", async () => {
    const url = "https://example.com/trip";
    const ydoc = note("Before\n\nAfter");
    const peer = withPeer(ydoc);
    render(<LiveEditor ydoc={ydoc} />);
    const editor = await editorIn();
    act(() => {
      editor.chain().setTextSelection(7).splitBlock().run();
    });
    act(() => {
      const event = {
        clipboardData: { files: [], getData: (type: string) => (type === "text/plain" ? url : "") },
      } as unknown as ClipboardEvent;
      editor.view.someProp("handlePaste", (handle) => handle(editor.view, event, Slice.empty));
      const tr = editor.state.tr.insertText(url, editor.state.selection.from);
      editor.view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste"));
      insertAfter(peer.getText("sequence"), "Before", ", edited");
    });

    expect(editor.state.doc.child(0).textContent).toBe("Before, edited");
    expect(editor.state.doc.child(1).textContent).toBe(url);
    const offer = urlPasteOfferKey.getState(editor.state);
    expect(offer?.anchors).not.toBeNull();
    expect(offer).toMatchObject({ from: 17, to: 17 + url.length });
  });
});
