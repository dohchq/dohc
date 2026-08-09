// #688: lineBlocks.ts lands a search result on the top-level BLOCK holding the
// line, which is the whole passage when the block is a paragraph and almost
// none of it when the block is a hundred-item list or a three-hundred-line
// fence. This refines that landing to a range INSIDE the block — but only
// where the source and the parsed node agree well enough to prove the answer.
//
// The mapping in lineBlocks.ts is block-granular BY DESIGN and stays that way.
// Nothing here re-splits Markdown: this reads the block's own source lines
// against the node the editor already built and asks whether the two line up.
// When they do not, the answer is null and the reveal stays at the block
// start — the behaviour before this module existed.
// A gap or trailing-blank match inside the block's span lands the item or
// content immediately above it, following lineBlocks.ts's gap rule.
// A proven later list item can descend through nested lists or fences. Every
// level must pass the same count, shape, and text checks.
//
// UNSURE, every case, all of which fall back to the block start:
//
//  - The matched line is the block's FIRST line (offset 0), or sits outside
//    the block's own lines. Both already land where the block starts.
//  - The block is neither a fenced code block nor a list. A quote, a table
//    and a paragraph have children too, but no rule here maps a source line
//    onto them, and a guessed one would land the wrong child.
//  - A code block whose text does not equal its source lines from line 1 on.
//    That is what proves the offset is exactly one opening fence — an
//    INDENTED code block (four columns the parse strips) fails it, and so
//    does a Y.Doc that has drifted from the artifact search numbered.
//  - A code block whose matched line is empty: an empty inline range renders
//    no element to scroll to.
//  - A list whose counted items disagree with the items the editor built, or
//    whose counted child's rendered text does not contain the matched line's
//    rendered text. The count rejects drift and unmodeled shapes; because it
//    can agree by coincidence, the text check rejects the wrong child.
//  - A top-level list whose matched line belongs to its FIRST item, nested
//    lines included — that item starts where the block does.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { blockForLine, columnAt, leadingColumns } from "./lineBlocks";

/** Which line of a top-level block the search matched. `lines` are the
 *  block's own source lines and `offset` indexes them from 0. */
export type IntraBlockMatch = {
  lines: readonly string[];
  offset: number;
};

/** A range inside the document, in the same coordinates the block index is
 *  resolved in: `containerPos` is where the block starts. */
export type DocRange = { from: number; to: number };

export type InlineTextRenderer = (source: string) => string;

// A list item's marker. Narrower than the list rules in lineBlocks.ts on
// purpose: this only has to recognize a line that starts an item of a list
// the parser has ALREADY built, and the count check below rejects it when it
// recognizes the wrong ones.
const LIST_ITEM_RE = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

function listItemLineSource(line: string, task: boolean): string {
  const marker = LIST_ITEM_RE.exec(line);
  let source = line
    .slice(marker?.[0].length ?? 0)
    .replace(/^[ \t]*/, "");
  if (task) source = source.replace(/^\[[ xX]\](?:[ \t]+|$)/, "");
  return source;
}

/** Remove exactly `columns` of list indent. A crossing tab becomes spaces for
 *  its overshoot, so later column checks preserve the remaining indentation. */
function dedentLine(line: string, columns: number): string {
  let index = 0;
  let column = 0;
  while (index < line.length && column < columns) {
    const character = line[index];
    if (character !== " " && character !== "\t") break;
    if (character === "\t") {
      const next = column + 4 - (column % 4);
      if (next > columns) {
        return " ".repeat(next - columns) + line.slice(index + 1);
      }
      column = next;
    } else {
      column += 1;
    }
    index += 1;
  }
  return line.slice(index);
}

/** PURE: which top-level block of `body` holds 1-based `line`, and the block's
 *  own source around it. The seam a search jump rides: the index reveals the
 *  block, the match refines the landing inside it.
 *
 *  No match when the line is not one of the block's own lines — a gap line
 *  resolves to the block ABOVE it, and a body with no block at all has
 *  nothing to slice. */
export function blockTargetForLine(
  body: string,
  line: number,
): { index: number; match?: IntraBlockMatch } {
  const block = blockForLine(body, line);
  if (block.startLine < 1 || line < block.startLine || line > block.endLine) {
    return { index: block.index };
  }
  return {
    index: block.index,
    match: {
      lines: body.split(/\r?\n/).slice(block.startLine - 1, block.endLine),
      offset: line - block.startLine,
    },
  };
}

/** PURE: the range inside `container` holding the matched source line, or
 *  null when that cannot be proven — see the unsure list above. */
export function intraBlockRange(
  container: ProseMirrorNode,
  containerPos: number,
  match: IntraBlockMatch,
  renderInlineText: InlineTextRenderer = (source) => source,
  topLevel = true,
): DocRange | null {
  const { lines, offset } = match;
  if (offset <= 0 || offset >= lines.length) return null;
  if (container.type.name === "codeBlock") {
    return codeLineRange(container, containerPos, lines, offset);
  }
  if (LIST_TYPES.has(container.type.name)) {
    return listItemRange(
      container,
      containerPos,
      lines,
      offset,
      renderInlineText,
      topLevel,
    );
  }
  return null;
}

/** A fenced block's text is its source verbatim, one line down: line 0 is the
 *  opening fence. Comparing the whole body is what proves that shift, so no
 *  fence is parsed here and a block whose body was transformed is rejected. */
function codeLineRange(
  container: ProseMirrorNode,
  containerPos: number,
  lines: readonly string[],
  offset: number,
): DocRange | null {
  const text = container.textContent;
  const textLines = text.split("\n");
  const target = offset - 1;
  if (target >= textLines.length) return null;
  const openerIndent = /^[ \t]*/.exec(lines[0] ?? "")?.[0].length ?? 0;
  const sourceText = lines
    .slice(1, 1 + textLines.length)
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      return line.slice(Math.min(indent, openerIndent));
    })
    .join("\n");
  if (sourceText !== text) return null;
  // Positions inside a textblock start one past the node itself.
  let from = containerPos + 1;
  for (let line = 0; line < target; line += 1) {
    from += (textLines[line] ?? "").length + 1;
  }
  const to = from + (textLines[target] ?? "").length;
  return to > from ? { from, to } : null;
}

/** The item holding the matched line, found by counting item starts above it
 *  only when the count equals childCount and the child's rendered text contains
 *  the matched line's rendered text. The text check rejects a wrong child when
 *  the counts agree by coincidence. The item's CONTENT is the range, so the
 *  reveal has text to render. */
function listItemRange(
  container: ProseMirrorNode,
  containerPos: number,
  lines: readonly string[],
  offset: number,
  renderInlineText: InlineTextRenderer,
  topLevel: boolean,
): DocRange | null {
  const first = lines[0] ?? "";
  const firstMarker = LIST_ITEM_RE.exec(first);
  if (!firstMarker) return null;
  const spaces = /^[ \t]*/.exec(first.slice(firstMarker[0].length))?.[0] ?? "";
  const content = columnAt(first, firstMarker[0].length + spaces.length);
  let itemCount = 1;
  let child = 0;
  const itemStarts = [0];
  for (let line = 1; line < lines.length; line += 1) {
    const text = lines[line] ?? "";
    if (leadingColumns(text) >= content || !LIST_ITEM_RE.test(text)) continue;
    if (line <= offset) child = itemCount;
    itemStarts.push(line);
    itemCount += 1;
  }
  if (itemCount !== container.childCount) return null;
  // The first item starts where the block does only at the TOP level — a
  // proven descent's own synthetic document always starts below the outer
  // item's first line, so its first item is ground the outer level never
  // reached.
  if (child <= 0 && topLevel) return null;
  const matched = lines[offset] ?? "";
  const task = container.type.name === "taskList";
  const matchedSource = listItemLineSource(matched, task);
  const matchedText = renderInlineText(matchedSource);
  const itemNode = container.child(child);
  if (!itemNode.textContent.includes(matchedText)) return null;
  let from = containerPos + 1;
  for (let before = 0; before < child; before += 1) {
    from += container.child(before).nodeSize;
  }
  const itemRange = { from: from + 1, to: from + itemNode.nodeSize - 1 };
  if (itemNode.childCount !== 2 || itemNode.child(0).type.name !== "paragraph") {
    return itemRange;
  }
  const nested = itemNode.child(1);
  if (nested.type.name !== "codeBlock" && !LIST_TYPES.has(nested.type.name)) {
    return itemRange;
  }
  const itemStart = itemStarts[child];
  if (itemStart === undefined) return itemRange;
  const itemLines = lines.slice(itemStart, itemStarts[child + 1] ?? lines.length);
  const itemLocalOffset = offset - itemStart;
  const dedentedLines = [
    listItemLineSource(itemLines[0] ?? "", task),
    ...itemLines.slice(1).map((line) => dedentLine(line, content)),
  ];
  const nestedTarget = blockTargetForLine(
    dedentedLines.join("\n"),
    itemLocalOffset + 1,
  );
  const nestedIndex = dedentedLines[0] === "" ? 0 : 1;
  if (nestedTarget.index !== nestedIndex || !nestedTarget.match) return itemRange;
  const nestedPos = from + 1 + itemNode.child(0).nodeSize;
  const refined = intraBlockRange(
    nested,
    nestedPos,
    nestedTarget.match,
    renderInlineText,
    false,
  );
  if (refined) return refined;
  if (nested.type.name !== "codeBlock" || content <= 0) return itemRange;
  const nestedStart = itemLocalOffset - nestedTarget.match.offset;
  const rawNestedLines = itemLines.slice(
    nestedStart,
    nestedStart + nestedTarget.match.lines.length,
  );
  const codeLines = rawNestedLines.map((line, index) =>
    dedentLine(line, index === 0 ? content : content - 1),
  );
  // The list parser leaves its separator column in fenced body text. The
  // full-body code check must still prove that alternate normalization.
  return (
    intraBlockRange(
      nested,
      nestedPos,
      { lines: codeLines, offset: nestedTarget.match.offset },
      renderInlineText,
      false,
    ) ?? itemRange
  );
}
