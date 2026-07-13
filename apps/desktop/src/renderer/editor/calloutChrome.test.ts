// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { dohcMarkdownExtensions } from "./extensions";
import { makeCalloutChromePlugin } from "./calloutChrome";

const calloutChrome = Extension.create({
  name: "testCalloutChrome",
  addProseMirrorPlugins() {
    return [makeCalloutChromePlugin()];
  },
});

const editors: Editor[] = [];
const mounts: HTMLElement[] = [];

function makeEditor(markdown: string): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  mounts.push(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      ...dohcMarkdownExtensions,
      TaskList,
      TaskItem,
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
      calloutChrome,
    ],
    content: markdown,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  while (mounts.length) mounts.pop()?.remove();
});

/** Position of the first callout node in the document. */
function calloutPos(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.type.name === "callout") found = pos;
  });
  if (found === -1) throw new Error("no callout in document");
  return found;
}

/** Change ONLY the callout title, as a remote/agent edit would. */
function externallySetTitle(editor: Editor, title: string): void {
  const pos = calloutPos(editor);
  const node = editor.state.doc.nodeAt(pos);
  if (!node) throw new Error("callout node missing");
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title }),
  );
}

function titleInput(editor: Editor): HTMLInputElement {
  const input = editor.view.dom.querySelector<HTMLInputElement>(
    ".dohc-callout-title-input",
  );
  if (!input) throw new Error("callout title input not rendered");
  return input;
}

function liveTitle(editor: Editor): string {
  const node = editor.state.doc.nodeAt(calloutPos(editor));
  return String(node?.attrs.title ?? "");
}

function liveFold(editor: Editor): string {
  const node = editor.state.doc.nodeAt(calloutPos(editor));
  return String(node?.attrs.fold ?? "");
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("callout header title staleness", () => {
  it("reflects an external title change in the rendered input, in place", () => {
    const editor = makeEditor("> [!note] Original\n> body");
    const input = titleInput(editor);
    expect(input.value).toBe("Original");

    externallySetTitle(editor, "Renamed remotely");

    // The widget DOM is reused (key omits title, so no caret-dropping remint);
    // reconcileTitleInputs re-seeds the value from the live node.
    expect(titleInput(editor)).toBe(input);
    expect(input.value).toBe("Renamed remotely");
    expect(liveTitle(editor)).toBe("Renamed remotely");
  });

  it("does not clobber a newer external title on blur when the user did not edit", () => {
    const editor = makeEditor("> [!note] Original\n> body");
    const input = titleInput(editor);

    // User focuses the input but types nothing...
    input.focus();
    // ...while a remote/agent edit renames the callout.
    externallySetTitle(editor, "Remote wins");

    // Blurring must NOT write the stale focused input back over the remote title.
    input.blur();

    expect(liveTitle(editor)).toBe("Remote wins");
  });

  it("commits a real user edit on blur", () => {
    const editor = makeEditor("> [!note] Original\n> body");
    const input = titleInput(editor);

    input.focus();
    input.value = "User typed";
    input.blur();

    expect(liveTitle(editor)).toBe("User typed");
  });

  it("keeps the focused title input across content inserted before the callout", () => {
    // A collaborator/agent inserting text before a callout shifts its document
    // position. The widget key must key off callout ORDINAL (not absolute pos),
    // or the decoration remints — dropping the focused input and its
    // uncommitted title WITHOUT a blur (the commit never fires).
    const editor = makeEditor("intro\n\n> [!note] Title\n> body");
    const input = titleInput(editor);
    input.focus();
    input.value = "Uncommitted edit";

    // Insert text at the very start of the document, before the callout.
    editor.view.dispatch(editor.state.tr.insertText("XYZ ", 1));

    // Same input element (no remint) and the uncommitted edit survives.
    const after = titleInput(editor);
    expect(after).toBe(input);
    expect(after.value).toBe("Uncommitted edit");

    // The edit still commits on blur, proving the input stayed wired up.
    after.blur();
    expect(liveTitle(editor)).toBe("Uncommitted edit");
  });

  it("Escape restores the current node title, not a stale closure snapshot", () => {
    const editor = makeEditor("> [!note] Original\n> body");
    let input = titleInput(editor);

    // Commit one edit so the closure-captured title ("Original") is now stale
    // relative to the committed value.
    input.focus();
    input.value = "First commit";
    input.blur();
    expect(liveTitle(editor)).toBe("First commit");

    // Re-acquire the (possibly reminted) input, type an uncommitted edit, then
    // Escape: it must restore the CURRENT title ("First commit"), not "Original".
    input = titleInput(editor);
    input.focus();
    input.value = "Scratch edit";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(input.value).toBe("First commit");
    expect(liveTitle(editor)).toBe("First commit");
  });

});

describe("callout header fold control", () => {
  it("toggles the fold attribute on the live callout node", () => {
    const editor = makeEditor("> [!note] Original\n> body");
    expect(liveFold(editor)).toBe("");

    const chevron = editor.view.dom.querySelector(".dohc-callout-fold");
    if (!chevron) throw new Error("fold chevron not rendered");
    click(chevron);

    expect(liveFold(editor)).toBe("-");
  });
});

describe("callout header selection", () => {
  function headerEl(editor: Editor): HTMLElement {
    const header = editor.view.dom.querySelector<HTMLElement>(".dohc-callout-header");
    if (!header) throw new Error("callout header not rendered");
    return header;
  }

  function selectedNodeName(editor: Editor): string | null {
    const selection = editor.state.selection;
    return selection instanceof NodeSelection ? selection.node.type.name : null;
  }

  it("clicking the header background selects the whole callout", () => {
    // This is the only mouse path to select a FOLDED callout (its body is
    // hidden), which in turn is what makes it deletable via Backspace.
    const editor = makeEditor("> [!note]- Folded\n> hidden body");

    headerEl(editor).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );

    expect(selectedNodeName(editor)).toBe("callout");
  });

  it("leaves clicks on the header's interactive controls alone", () => {
    const editor = makeEditor("> [!note] Titled\n> body");
    const input = editor.view.dom.querySelector(".dohc-callout-title-input");
    if (!input) throw new Error("title input not rendered");

    input.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );

    expect(selectedNodeName(editor)).toBeNull();
  });
});
