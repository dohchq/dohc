// Word/character count — a computed view over the doc's text (no schema
// addition), plus a tiny generic debouncer used to throttle recompute
// down from "every keystroke" to something cheap to run on transaction.

export type WordCharCount = { words: number; characters: number };

export const EMPTY_WORD_CHAR_COUNT: WordCharCount = { words: 0, characters: 0 };

/** PURE: words = whitespace-split tokens, characters = non-newline chars.
 *  Characters are counted by Unicode code point (not UTF-16 code unit) so
 *  a surrogate-pair character like an emoji counts as one, matching what a
 *  person means by "one character". */
export function countWordsAndCharacters(text: string): WordCharCount {
  const withoutNewlines = text.replace(/\n/g, "");
  const characters = withoutNewlines === "" ? 0 : Array.from(withoutNewlines).length;
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  return { words, characters };
}

// Minimal duck-typed doc shape — matches ProseMirror's Node#textBetween.
export type PMTextDocLike = {
  content: { size: number };
  textBetween: (
    from: number,
    to: number,
    blockSeparator?: string,
    leafText?: string,
  ) => string;
};

/** The doc's full text, one block per line (headings/paragraphs/list items
 *  etc. each end a "line" so words don't fuse across block boundaries —
 *  "Hello" + "World" reads as two words, not "HelloWorld"). Code blocks
 *  are NOT excluded: their text counts too. */
export function getDocText(doc: PMTextDocLike): string {
  if (doc.content.size === 0) return "";
  return doc.textBetween(0, doc.content.size, "\n", "\n");
}

/** A trailing-edge debouncer for a no-argument callback: `schedule()`
 *  restarts the delay, `cancel()` drops any pending call (used on
 *  unmount). Mirrors windowState.ts's `createDebouncedSaver` shape. */
export function createDebouncer(
  run: () => void,
  delayMs: number,
): { schedule(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
