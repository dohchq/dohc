import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// Escape hatches for container blocks that otherwise trap the caret.
//
// The engine-mode (collab) editor has NO trailing-node extension — auto-
// appending a paragraph would write to the shared Y.Doc on mere open — so a
// document that ends in a callout, table, or fenced block has no paragraph to
// escape into. And a FOLDED callout ("toggle") hides its body with CSS, so the
// default join/caret behavior around it moves text into (or the caret onto)
// content the user cannot see.
//
// This plugin adds intent-driven exits instead of background doc mutation:
//   - Mod-Enter anywhere nested (callout, table cell, list, …) or on a block
//     NodeSelection places the caret in a paragraph after the top-level block.
//     Without this, HardBreak's Mod-Enter swallows the key inside callouts.
//   - ArrowDown at the very end of the document, when the caret is trapped
//     inside a top-level callout/table or a code-style block, creates the
//     paragraph below (parity with makeCodeBlockContinuationPlugin, which
//     only covers codeBlock — this also covers callout, queryBlock, and table).
//   - Arrow/Backspace/Delete next to a FOLDED callout select the callout node
//     instead of joining into / moving the caret onto its hidden body. A
//     second Backspace/Delete then removes it — making toggles deletable.
//
// Registration order matters: this plugin must sit AFTER the slash-command
// plugin (so menu navigation keeps ArrowDown while the menu is open), BEFORE
// makeCodeBlockContinuationPlugin (so Mod-Enter/ArrowDown in a terminal code
// block nested in a callout escape past the whole callout), and BEFORE the
// StarterKit keymaps (so Mod-Enter beats HardBreak). Top-level code blocks
// fall through on Mod-Enter for the continuation plugin to handle.
const blockExitKey = new PluginKey("dohc-block-exit");

function isFoldedCallout(node: PMNode): boolean {
  return node.type.name === "callout" && node.attrs.fold === "-";
}

type FlowNeighbor = { node: PMNode; pos: number };

// The node the caret flows into when leaving its textblock forward: the first
// following sibling, walking up from the caret's depth. Null at document end.
function flowNodeAfter($from: ResolvedPos): FlowNeighbor | null {
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const after = $from.after(depth);
    const nodeAfter = $from.doc.resolve(after).nodeAfter;
    if (nodeAfter) return { node: nodeAfter, pos: after };
  }
  return null;
}

// Mirror of flowNodeAfter for backward motion. Null at document start.
function flowNodeBefore($from: ResolvedPos): FlowNeighbor | null {
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const before = $from.before(depth);
    const nodeBefore = $from.doc.resolve(before).nodeBefore;
    if (nodeBefore) return { node: nodeBefore, pos: before - nodeBefore.nodeSize };
  }
  return null;
}

function selectNodeAt(view: EditorView, pos: number): boolean {
  view.dispatch(
    view.state.tr
      .setSelection(NodeSelection.create(view.state.doc, pos))
      .scrollIntoView(),
  );
  return true;
}

// Put the caret in a paragraph at `pos` (a top-level gap or a position inside
// a parent that accepts paragraphs), reusing an empty paragraph already
// sitting there instead of stacking a new one.
function caretIntoParagraphAt(view: EditorView, pos: number): boolean {
  if (view.editable === false) return false;
  const { state } = view;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;
  const $pos = state.doc.resolve(pos);
  let tr = state.tr;
  const existing = $pos.nodeAfter;
  if (!(existing?.type === paragraphType && existing.content.size === 0)) {
    if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), paragraphType)) {
      return false;
    }
    tr = tr.insert(pos, paragraphType.create());
  }
  tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

// Mod-Enter: escape to a paragraph after the top-level block containing the
// selection. Applies to a caret nested in any container (callout body, table
// cell, list item) and to a NodeSelection on a block (mathBlock, callout, …).
// A caret in a top-level textblock falls through (HardBreak keeps Mod-Enter,
// and exitCode already handles top-level code blocks).
function exitToParagraphBelowTopBlock(view: EditorView): boolean {
  const { selection } = view.state;
  const { $from } = selection;
  let afterPos: number;
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    afterPos = $from.depth === 0 ? selection.to : $from.after(1);
  } else if ($from.parent.isTextblock && $from.depth >= 2) {
    afterPos = $from.after(1);
  } else {
    return false;
  }
  return caretIntoParagraphAt(view, afterPos);
}

function caretAtTextblockEnd($from: ResolvedPos): boolean {
  return (
    $from.parent.isTextblock && $from.parentOffset >= $from.parent.content.size
  );
}

function caretAtTextblockStart($from: ResolvedPos): boolean {
  return $from.parent.isTextblock && $from.parentOffset === 0;
}

function handleArrowDown(view: EditorView): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!caretAtTextblockEnd($from)) return false;
  const next = flowNodeAfter($from);
  if (next) {
    // Never let the caret drop into a folded callout's hidden body — select
    // the callout instead so the user sees where they are (and can delete it).
    return isFoldedCallout(next.node) ? selectNodeAt(view, next.pos) : false;
  }
  // End of the document. Escape after a top-level callout/table (including
  // code nested inside one), or after a top-level code-style textblock. Code
  // nested in lists/blockquotes falls through so continuation stays inside
  // its immediate parent.
  const topLevelName = $from.node(1).type.name;
  const trapped =
    topLevelName === "callout" ||
    topLevelName === "table" ||
    ($from.depth === 1 && $from.parent.type.spec.code === true);
  if (!trapped) return false;
  return caretIntoParagraphAt(view, $from.after(1));
}

function handleArrowUp(view: EditorView): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!caretAtTextblockStart($from)) return false;
  const prev = flowNodeBefore($from);
  if (prev && isFoldedCallout(prev.node)) return selectNodeAt(view, prev.pos);
  return false;
}

// Backspace at the start of the block after a folded callout would silently
// join that block into the callout's hidden body (the text "vanishes").
// Select the callout instead; a second Backspace deletes it.
function handleBackspace(view: EditorView): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!caretAtTextblockStart($from)) return false;
  const prev = flowNodeBefore($from);
  if (prev && isFoldedCallout(prev.node)) return selectNodeAt(view, prev.pos);
  return false;
}

// Delete at the end of the block before a folded callout mirrors Backspace:
// select the hidden-body callout instead of pulling its content up unseen.
function handleDelete(view: EditorView): boolean {
  const { selection } = view.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!caretAtTextblockEnd($from)) return false;
  const next = flowNodeAfter($from);
  if (next && isFoldedCallout(next.node)) return selectNodeAt(view, next.pos);
  return false;
}

export function makeBlockExitPlugin(): Plugin {
  return new Plugin({
    key: blockExitKey,
    props: {
      handleKeyDown(view, event) {
        if (event.key === "Backspace" || event.key === "Delete") {
          const handled =
            event.key === "Backspace"
              ? handleBackspace(view)
              : handleDelete(view);
          if (handled) event.preventDefault();
          return handled;
        }
        if (event.altKey || event.shiftKey) return false;
        const mod = event.metaKey || event.ctrlKey;
        if (event.key === "Enter" && mod) {
          if (!exitToParagraphBelowTopBlock(view)) return false;
          event.preventDefault();
          return true;
        }
        if (mod) return false;
        let handled = false;
        switch (event.key) {
          case "ArrowDown":
            handled = handleArrowDown(view);
            break;
          case "ArrowUp":
            handled = handleArrowUp(view);
            break;
        }
        if (handled) event.preventDefault();
        return handled;
      },
    },
  });
}
