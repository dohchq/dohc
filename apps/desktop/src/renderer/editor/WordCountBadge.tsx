// A quiet "N words · N characters" counter pinned to the bottom-right of
// the editor's visible pane — independent of OutlinePanel (renders even
// with 0 or 1 headings). Hover-reveal, same idea as the block gutter:
// present in the DOM at all times, invisible until the pointer is over the
// editor area (CSS handles that — see styles.css). Positioning is the same
// CSS-grid + position:sticky trick as the outline rail, mirrored to the
// bottom edge instead of the top.

import type { Editor } from "@tiptap/core";
import { useDebouncedWordCount } from "./wordCount";

export function WordCountBadge({ editor }: { editor: Editor | null }) {
  const count = useDebouncedWordCount(editor);

  if (!editor) return null;

  return (
    <div className="dohc-word-count-badge">
      <span className="dohc-word-count-badge-text" data-testid="editor-word-count">
        {count.words.toLocaleString()} words · {count.characters.toLocaleString()} characters
      </span>
    </div>
  );
}
