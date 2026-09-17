import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { isCodeBlock, isCodeMark } from "./pmHelpers";

/** The eligible text run before the cursor, without crossing a mark or atom. */
export function cursorText(
  doc: Node,
  cursorPos: number,
  position?: ResolvedPos,
): { from: number; text: string } | null {
  if (cursorPos < 0 || cursorPos > doc.content.size) return null;
  const $cursor = position ?? doc.resolve(cursorPos);
  const parent = $cursor.parent;
  if (isCodeBlock(parent)) return null;
  const offset = $cursor.textOffset;
  const index = $cursor.index();
  const node = parent.maybeChild(offset > 0 ? index : index - 1);
  if (!node?.isText || !node.text || node.marks.some(isCodeMark)) return null;
  // At a marked boundary the following run has an empty prefix. The previous
  // run is the only one that can contain a trigger ending at this position.
  const length = offset || node.text.length;
  return { from: cursorPos - length, text: node.text.slice(0, length) };
}
