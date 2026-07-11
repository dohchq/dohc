import { describe, expect, it, vi } from "vitest";
import {
  countWordsAndCharacters,
  createDebouncer,
  EMPTY_WORD_CHAR_COUNT,
  getDocText,
  type PMTextDocLike,
} from "./wordCount";

describe("countWordsAndCharacters", () => {
  it("returns zero for an empty string", () => {
    expect(countWordsAndCharacters("")).toEqual(EMPTY_WORD_CHAR_COUNT);
  });

  it("counts a simple sentence", () => {
    expect(countWordsAndCharacters("Hello world")).toEqual({ words: 2, characters: 11 });
  });

  it("splits words on any run of whitespace, including newlines", () => {
    expect(countWordsAndCharacters("Hello   world\nagain")).toEqual({
      words: 3,
      characters: 18, // "Hello   world\nagain" with the \n dropped = 18 chars
    });
  });

  it("excludes newlines from the character count but not other whitespace", () => {
    const { characters } = countWordsAndCharacters("a\nb");
    expect(characters).toBe(2); // "a" + "b", the \n is dropped
  });

  it("ignores leading/trailing whitespace for word counting", () => {
    expect(countWordsAndCharacters("   padded text   ")).toEqual({
      words: 2,
      characters: 17,
    });
  });

  it("counts unicode text by code point, not UTF-16 code unit", () => {
    // "😀" is a surrogate pair (length 2 in UTF-16) but one code point.
    const { characters, words } = countWordsAndCharacters("😀 café");
    expect(words).toBe(2);
    expect(characters).toBe(6); // 😀, space, c,a,f,é
  });

  it("counts code block text as ordinary text", () => {
    // Code content arrives here as plain text (getDocText walks it same as
    // prose) — no special-casing, it just counts.
    expect(countWordsAndCharacters("const x = 1;")).toEqual({ words: 4, characters: 12 });
  });

  it("treats whitespace-only input as zero words, but still counts non-newline chars", () => {
    expect(countWordsAndCharacters("   \n  ")).toEqual({ words: 0, characters: 5 });
  });
});

describe("getDocText", () => {
  function fakeDoc(text: string): PMTextDocLike {
    return {
      content: { size: text.length || 0 },
      textBetween: () => text,
    };
  }

  it("returns empty string for an empty doc (size 0), without calling textBetween", () => {
    const textBetween = vi.fn();
    const doc: PMTextDocLike = { content: { size: 0 }, textBetween };
    expect(getDocText(doc)).toBe("");
    expect(textBetween).not.toHaveBeenCalled();
  });

  it("delegates to textBetween with block-separator newlines for a non-empty doc", () => {
    const textBetween = vi.fn().mockReturnValue("Title\nBody text");
    const doc: PMTextDocLike = { content: { size: 20 }, textBetween };
    expect(getDocText(doc)).toBe("Title\nBody text");
    expect(textBetween).toHaveBeenCalledWith(0, 20, "\n", "\n");
  });

  it("composes with countWordsAndCharacters end to end", () => {
    const doc = fakeDoc("Hello world");
    expect(countWordsAndCharacters(getDocText(doc))).toEqual({ words: 2, characters: 11 });
  });
});

describe("createDebouncer", () => {
  it("coalesces a burst of schedule() calls into a single trailing run", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const debouncer = createDebouncer(run, 300);
      debouncer.schedule();
      vi.advanceTimersByTime(200);
      debouncer.schedule();
      vi.advanceTimersByTime(200);
      debouncer.schedule();
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() drops a pending run", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const debouncer = createDebouncer(run, 300);
      debouncer.schedule();
      debouncer.cancel();
      vi.advanceTimersByTime(1000);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() without a pending run is a no-op", () => {
    const run = vi.fn();
    const debouncer = createDebouncer(run, 300);
    expect(() => debouncer.cancel()).not.toThrow();
  });

  it("runs again on a later schedule() after firing once", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const debouncer = createDebouncer(run, 100);
      debouncer.schedule();
      vi.advanceTimersByTime(100);
      expect(run).toHaveBeenCalledTimes(1);
      debouncer.schedule();
      vi.advanceTimersByTime(100);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
