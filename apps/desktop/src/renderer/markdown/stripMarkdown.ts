// The words of a Markdown body without its syntax, for anywhere that shows a
// message without rendering it: emphasis marks, backticks, heading and quote
// markers, link targets and fences go; bullets become "•", line breaks stay,
// and an image without alt text shows its address. Blocks are read a line at
// a time. Inside a paragraph, emphasis and links follow micromark, the parser
// the chat uses: the same flanking rules, the same pairing of runs, and the
// same link destinations and titles. Every lookahead is bounded or jumps
// through tables built once per line, so its time grows linearly with the
// body whatever the body holds. No regular expression reads more than one
// character of the body.
//
// A link's destination or title that continues on the next line, a code span
// across lines and inline HTML are read as text. An image without alt text
// whose address comes from a definition shows nothing.
//
// `atoms` are source ranges to keep exactly as written, such as mention
// chips, sorted by start. The result gives where each kept atom landed in the
// text; an atom inside syntax that the strip removes, like a link target, is
// dropped.

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import { normalizeUri } from "micromark-util-sanitize-uri";

export interface SourceRange {
  start: number;
  end: number;
}

export interface StrippedMarkdown {
  text: string;
  atoms: Array<SourceRange & { index: number }>;
}

const SPACE = 32;
const TAB = 9;
const CR = 13;
const BACKSLASH = 92;
const BACKTICK = 96;
const TILDE = 126;
const STAR = 42;
const UNDERSCORE = 95;
const HASH = 35;
const GT = 62;
const LT = 60;
const BANG = 33;
const QUOTE = 34;
const APOSTROPHE = 39;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const PIPE = 124;
const AMP = 38;
const COLON = 58;
const AT = 64;
const DASH = 45;
const PLUS = 43;
const EQUALS = 61;
const DOT = 46;
const SEMICOLON = 59;

const isBlank = (code: number) => code === SPACE || code === TAB;
const isDigit = (code: number) => code >= 48 && code <= 57;
const isControl = (code: number) => code < SPACE || code === 127;
const isAsciiPunctuation = (code: number) =>
  (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
const isWordCode = (code: number) => code > SPACE && !isAsciiPunctuation(code);
const isMarker = (code: number) => code === STAR || code === UNDERSCORE || code === TILDE;

const UNICODE_WHITESPACE = /\s/u;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = 1;
const PUNCTUATION = 2;
// As micromark classifies a character beside a run: -1 is the line's edge.
function classify(code: number): number {
  if (code < 0 || code === SPACE || code === TAB) return WHITESPACE;
  if (code < 128) return isAsciiPunctuation(code) ? PUNCTUATION : code === 11 || code === 12 ? WHITESPACE : 0;
  const char = String.fromCharCode(code);
  if (UNICODE_WHITESPACE.test(char)) return WHITESPACE;
  return UNICODE_PUNCTUATION.test(char) ? PUNCTUATION : 0;
}

// The deepest a link destination's parentheses nest, as micromark allows.
const DESTINATION_DEPTH = 32;
const LABEL_MAX = 999;
const ENTITY_MAX = 32;

// An emphasis or strike run that may still pair, linked to its neighbours.
interface Run {
  piece: number;
  code: number;
  size: number;
  open: boolean;
  close: boolean;
  prev: number;
  next: number;
}

// An unclosed "[" or "![", with how many runs came before it.
interface Bracket {
  piece: number;
  link: boolean;
  runs: number;
  textStart: number;
}

const normalizeLabel = (label: string) => {
  let value = "";
  let space = false;
  for (const char of label) {
    if (char === " " || char === "\t" || char === "\n" || char === "\r") space = value.length > 0;
    else {
      if (space) value += " ";
      space = false;
      value += char;
    }
  }
  return value.toLowerCase().toUpperCase();
};

export function stripMarkdown(source: string, atoms: readonly SourceRange[] = []): StrippedMarkdown {
  // Output pieces. Kept atoms remember their piece, and a link opener or an
  // emphasis run can change its own piece once its pair is found, so offsets
  // are summed last.
  const pieces: string[] = [];
  const kept: Array<{ piece: number; index: number }> = [];
  let nextAtom = 0;

  const skipAtomsBefore = (at: number) => {
    while (nextAtom < atoms.length && atoms[nextAtom]!.start < at) nextAtom++;
  };
  // Copies source text as written, noting any atom inside it.
  const copy = (from: number, to: number) => {
    skipAtomsBefore(from);
    let at = from;
    while (nextAtom < atoms.length && atoms[nextAtom]!.end <= to) {
      const atom = atoms[nextAtom]!;
      if (atom.start > at) pieces.push(source.slice(at, atom.start));
      kept.push({ piece: pieces.length, index: nextAtom });
      pieces.push(source.slice(atom.start, atom.end));
      at = atom.end;
      nextAtom++;
    }
    if (to > at) pieces.push(source.slice(at, to));
  };

  // Labels that reference definitions name. A reference link resolves only
  // to one of them.
  const defined = new Set<string>();
  let fence: { code: number; size: number } | null = null;
  // An indented line opens a code block after a blank line, the start or a
  // closed fence, and continues an open one.
  let afterBlank = true;
  let indented = false;
  // The open paragraph's runs, unclosed brackets, and a "\" that ended its
  // last line, which is a line break if the paragraph goes on.
  const runs: Run[] = [];
  const brackets: Bracket[] = [];
  // Links can't hold links: a link's "[" below this depth no longer opens one.
  let inactiveBelow = 0;
  // The last "[" or "]" read. A label with one inside can't name a definition.
  let lastBracket = -1;
  let pendingBreak = -1;
  let paragraph = false;
  // How many quotes hold the open paragraph. A line in more starts a new one;
  // a line in fewer goes on with it.
  let paragraphQuotes = 0;

  forEachLine((start, end) => {
    const at = indentEnd(start, end);
    const close = definitionClose(start, at, end);
    if (close >= 0) defined.add(normalizeLabel(source.slice(at + 1, close)));
  });
  forEachLine((start, end, last) => {
    const keepLine = fence ? stripFencedLine(start, end) : stripLine(start, end);
    if (!last && keepLine) pieces.push("\n");
  });
  endParagraph();

  let text = "";
  const offsets: number[] = [];
  for (const piece of pieces) {
    offsets.push(text.length);
    text += piece;
  }
  return {
    text,
    atoms: kept.map(({ piece, index }) => ({
      index,
      start: offsets[piece]!,
      end: offsets[piece]! + pieces[piece]!.length,
    })),
  };

  function forEachLine(visit: (start: number, end: number, last: boolean) => void) {
    let lineStart = 0;
    for (;;) {
      let lineEnd = source.indexOf("\n", lineStart);
      const last = lineEnd < 0;
      if (last) lineEnd = source.length;
      let end = lineEnd;
      if (end > lineStart && source.charCodeAt(end - 1) === CR) end--;
      visit(lineStart, end, last);
      if (last) return;
      lineStart = lineEnd + 1;
    }
  }

  // A run of one character from `at`, at most to `end`.
  function runEnd(at: number, end: number, code: number): number {
    let next = at;
    while (next < end && source.charCodeAt(next) === code) next++;
    return next;
  }

  // The "]" that ends a link reference definition's label at `at` on the line
  // from `start`, or -1. A blank label defines nothing. A tab in the label
  // counts the columns to its tab stop, as micromark counts it.
  function definitionClose(start: number, at: number, end: number): number {
    if (at >= end || source.charCodeAt(at) !== OPEN_BRACKET) return -1;
    const close = find(CLOSE_BRACKET, at, end);
    if (close + 1 >= end || source.charCodeAt(close + 1) !== COLON || close - at - 1 > LABEL_MAX) return -1;
    let column = 0;
    let size = 0;
    for (let next = start; next < close; next++) {
      const width = source.charCodeAt(next) === TAB ? 4 - (column % 4) : 1;
      column += width;
      if (next > at) size += width;
    }
    if (size > LABEL_MAX) return -1;
    return normalizeLabel(source.slice(at + 1, close)) ? close : -1;
  }

  // The first `code` in [at, end), or `end`. It never reads past the line.
  function find(code: number, at: number, end: number): number {
    let next = at;
    while (next < end && source.charCodeAt(next) !== code) next++;
    return next;
  }

  function blanksEnd(at: number, end: number): number {
    let next = at;
    while (next < end && isBlank(source.charCodeAt(next))) next++;
    return next;
  }

  function indentEnd(at: number, end: number): number {
    let next = at;
    while (next < end && next - at < 4 && isBlank(source.charCodeAt(next))) next++;
    return next;
  }

  // Whether the line from `at` holds only `allowed` characters and blanks, with
  // at least `least` of `counted`.
  function onlyOf(at: number, end: number, allowed: (code: number) => boolean, counted: number, least: number): boolean {
    let count = 0;
    for (let next = at; next < end; next++) {
      const code = source.charCodeAt(next);
      if (code === counted) count++;
      else if (!isBlank(code) && !allowed(code)) return false;
    }
    return count >= least;
  }

  function stripFencedLine(start: number, end: number): boolean {
    const open = fence!;
    const at = indentEnd(start, end);
    const after = runEnd(at, end, open.code);
    if (after - at >= open.size && onlyOf(after, end, () => false, -1, 0)) {
      fence = null;
      afterBlank = true;
      return false;
    }
    copy(start, end);
    return true;
  }

  // Strips one line outside a fence. Returns false for a line that holds only
  // syntax, so the line goes with its break.
  function stripLine(start: number, end: number): boolean {
    const continues = paragraph;
    paragraph = false;
    if (onlyOf(start, end, () => false, -1, 0)) {
      endParagraph();
      afterBlank = true;
      return true;
    }
    const code = codeStart(start, end);
    if (code >= 0 && (afterBlank || indented)) {
      endParagraph();
      indented = true;
      copy(code, end);
      return true;
    }
    afterBlank = indented = false;
    let at = indentEnd(start, end);
    const first = source.charCodeAt(at);
    if (first === BACKTICK || first === TILDE) {
      const after = runEnd(at, end, first);
      if (after - at >= 3) {
        endParagraph();
        fence = { code: first, size: after - at };
        return false;
      }
    }
    // Thematic breaks, setext underlines and table delimiter rows.
    if (
      ((first === DASH || first === STAR || first === UNDERSCORE) && onlyOf(at, end, () => false, first, 3)) ||
      (first === EQUALS && onlyOf(at, end, () => false, EQUALS, 1)) ||
      ((first === PIPE || first === DASH || first === COLON) &&
        onlyOf(at, end, (code) => code === DASH || code === COLON, PIPE, 1) &&
        find(DASH, at, end) < end)
    ) {
      endParagraph();
      return false;
    }

    // Container and heading markers. Each pass takes at least one character.
    // A list item or heading starts a new paragraph.
    let opensBlock = false;
    let heading = false;
    let quotes = 0;
    const markers = pieces.length;
    for (;;) {
      at = indentEnd(at, end);
      if (at >= end) break;
      const code = source.charCodeAt(at);
      const next = at + 1 < end ? source.charCodeAt(at + 1) : SPACE;
      if (code === GT) {
        at += isBlank(next) ? 2 : 1;
        quotes++;
        continue;
      }
      if ((code === DASH || code === STAR || code === PLUS) && isBlank(next)) {
        pieces.push("• ");
        opensBlock = true;
        at = skipTaskBox(at + 2, end);
        continue;
      }
      if (isDigit(code)) {
        let digits = at;
        while (digits < end && digits - at < 9 && isDigit(source.charCodeAt(digits))) digits++;
        const mark = digits < end ? source.charCodeAt(digits) : 0;
        const space = digits + 1 < end ? source.charCodeAt(digits + 1) : SPACE;
        if ((mark === DOT || mark === CLOSE_PAREN) && isBlank(space)) {
          pieces.push(`${source.slice(at, digits)}. `);
          opensBlock = true;
          at = skipTaskBox(digits + 2, end);
          continue;
        }
      }
      if (code === HASH) {
        const after = runEnd(at, end, HASH);
        if (after - at <= 6 && (after === end || isBlank(source.charCodeAt(after)))) {
          opensBlock = heading = true;
          at = after;
          continue;
        }
      }
      break;
    }

    let tableRow = false;
    if (at < end && source.charCodeAt(at) === PIPE) tableRow = true;
    // A link reference definition shows nothing.
    const definition = definitionClose(start, at, end) >= 0;
    if (!continues || opensBlock || quotes > paragraphQuotes || tableRow || definition || at >= end) {
      // The markers belong to this line, after the paragraph that ended.
      const own = pieces.splice(markers);
      endParagraph();
      pieces.push(...own);
      paragraphQuotes = quotes;
    } else if (pendingBreak >= 0) {
      pieces[pendingBreak] = "";
      pendingBreak = -1;
    }
    if (definition) return false;
    if (at >= end) return true;
    stripInline(tableRow ? at + 1 : at, end, tableRow);
    paragraph = !heading && !tableRow;
    return true;
  }

  // Where an indented code line's text starts, past four columns, or -1.
  function codeStart(at: number, end: number): number {
    let columns = 0;
    for (let next = at; next < end; next++) {
      const code = source.charCodeAt(next);
      if (code === SPACE) columns++;
      else if (code === TAB) columns += 4 - (columns % 4);
      else return -1;
      if (columns >= 4) return next + 1;
    }
    return -1;
  }

  function skipTaskBox(at: number, end: number): number {
    const from = indentEnd(at, end);
    if (from + 3 > end || source.charCodeAt(from) !== OPEN_BRACKET || source.charCodeAt(from + 2) !== CLOSE_BRACKET) {
      return at;
    }
    const mark = source.charCodeAt(from + 1);
    if (mark !== SPACE && mark !== 120 && mark !== 88) return at;
    return from + 3 < end && isBlank(source.charCodeAt(from + 3)) ? from + 4 : from + 3;
  }

  // The paragraph is over: its runs pair, and what can't pair stays.
  function endParagraph() {
    pairRuns(0);
    brackets.length = 0;
    inactiveBelow = 0;
    pendingBreak = -1;
  }

  // micromark's pairing of emphasis and strike runs, for the runs from
  // `bottom` on. Each closing run, left to right, takes the nearest earlier
  // run that opens with the same character. The runs between them can no
  // longer pair. For speed, `floors` remembers, for each kind of closer, how
  // far back a search has already failed.
  function pairRuns(bottom: number) {
    const count = runs.length;
    if (count === bottom) return;
    for (let index = bottom; index < count; index++) {
      runs[index]!.prev = index - 1;
      runs[index]!.next = index + 1;
    }
    const unlink = (index: number) => {
      const run = runs[index]!;
      if (run.prev >= bottom) runs[run.prev]!.next = run.next;
      if (run.next < count) runs[run.next]!.prev = run.prev;
    };
    const floors = new Map<number, number>();
    let closer = bottom;
    while (closer < count) {
      const close = runs[closer]!;
      if (!close.close) {
        closer = close.next;
        continue;
      }
      const key = close.code * 8 + (close.size % 3) * 2 + Number(close.open);
      const floor = floors.get(key) ?? bottom - 1;
      let opener = close.prev;
      while (opener > floor && !pairs(runs[opener]!, close)) opener = runs[opener]!.prev;
      if (opener <= floor) {
        floors.set(key, close.prev);
        closer = close.next;
        continue;
      }
      const open = runs[opener]!;
      const use = close.code === TILDE ? close.size : open.size > 1 && close.size > 1 ? 2 : 1;
      open.size -= use;
      close.size -= use;
      pieces[open.piece] = pieces[open.piece]!.slice(use);
      pieces[close.piece] = pieces[close.piece]!.slice(use);
      open.next = closer;
      close.prev = opener;
      // The opener changed size, so a search that passed it may now pair.
      for (const [kind, at] of floors) if (at >= opener) floors.set(kind, opener - 1);
      if (open.size === 0) unlink(opener);
      if (close.size === 0) {
        unlink(closer);
        closer = close.next;
      }
    }
    runs.length = bottom;
  }

  function pairs(open: Run, close: Run): boolean {
    if (open.code !== close.code || !open.open) return false;
    if (close.code === TILDE) return open.size === close.size;
    return !((open.close || close.open) && close.size % 3 !== 0 && (open.size + close.size) % 3 === 0);
  }

  function stripInline(start: number, end: number, tableRow: boolean) {
    // Backtick runs of the line, by length, so a code span finds its closer
    // with a pointer that only moves forward.
    const runsByLength = new Map<number, { starts: number[]; next: number }>();
    for (let at = start; at < end; at++) {
      if (source.charCodeAt(at) !== BACKTICK) continue;
      const after = runEnd(at, end, BACKTICK);
      const found = runsByLength.get(after - at) ?? { starts: [], next: 0 };
      found.starts.push(at);
      runsByLength.set(after - at, found);
      at = after - 1;
    }
    // For each title marker, the next one at or after each point that no
    // backslash escapes. Built when a title needs it.
    const titleEnds = new Map<number, Int32Array>();
    const titleEnd = (marker: number, from: number) => {
      let next = titleEnds.get(marker);
      if (!next) {
        next = new Int32Array(end - start + 1);
        next[end - start] = -1;
        const escaped = new Uint8Array(end - start + 1);
        for (let at = start; at < end; at++) {
          if (source.charCodeAt(at) === BACKSLASH && !escaped[at - start]) escaped[at + 1 - start] = 1;
        }
        for (let at = end - 1; at >= start; at--) {
          next[at - start] = source.charCodeAt(at) === marker && !escaped[at - start] ? at : next[at + 1 - start]!;
        }
        titleEnds.set(marker, next);
      }
      return next[from - start]!;
    };
    // After "]", the end of a "(destination "title")" that follows, or -1.
    const resource = (open: number): number => {
      let at = blanksEnd(open + 1, end);
      if (at >= end) return -1;
      if (source.charCodeAt(at) === CLOSE_PAREN) return at + 1;
      at = destinationEnd(at);
      if (at < 0) return -1;
      let after = blanksEnd(at, end);
      if (after >= end) return -1;
      const code = source.charCodeAt(after);
      if (after > at && (code === QUOTE || code === APOSTROPHE || code === OPEN_PAREN)) {
        const close = titleEnd(code === OPEN_PAREN ? CLOSE_PAREN : code, after + 1);
        if (close < 0) return -1;
        after = blanksEnd(close + 1, end);
      }
      return after < end && source.charCodeAt(after) === CLOSE_PAREN ? after + 1 : -1;
    };
    const destinationEnd = (at: number): number => {
      if (source.charCodeAt(at) === LT) {
        for (let next = at + 1; next < end; next++) {
          const code = source.charCodeAt(next);
          if (code === GT) return next + 1;
          if (code === LT) return -1;
          if (code === BACKSLASH) {
            const escaped = next + 1 < end ? source.charCodeAt(next + 1) : -1;
            if (escaped === LT || escaped === GT || escaped === BACKSLASH) next++;
          }
        }
        return -1;
      }
      let depth = 0;
      for (let next = at; next < end; next++) {
        const code = source.charCodeAt(next);
        // A blank inside parentheses ends no destination: the link fails.
        if (isBlank(code) || (depth === 0 && code === CLOSE_PAREN)) return depth === 0 && next > at ? next : -1;
        if (code === OPEN_PAREN) {
          if (depth >= DESTINATION_DEPTH) return -1;
          depth++;
        } else if (code === CLOSE_PAREN) depth--;
        else if (isControl(code)) return -1;
        else if (code === BACKSLASH) {
          const escaped = next + 1 < end ? source.charCodeAt(next + 1) : -1;
          if (escaped === OPEN_PAREN || escaped === CLOSE_PAREN || escaped === BACKSLASH) next++;
        }
      }
      return depth === 0 ? end : -1;
    };
    // After "]", the end of a "[label]" that follows, or -1.
    const labelEnd = (open: number): number => {
      let blank = true;
      for (let next = open + 1; next < end && next - open <= LABEL_MAX + 1; next++) {
        const code = source.charCodeAt(next);
        if (code === CLOSE_BRACKET) return blank ? -1 : next + 1;
        if (code === OPEN_BRACKET) return -1;
        if (!isBlank(code)) blank = false;
        if (code === BACKSLASH && next + 1 < end) {
          const escaped = source.charCodeAt(next + 1);
          if (escaped === OPEN_BRACKET || escaped === CLOSE_BRACKET || escaped === BACKSLASH) next++;
        }
      }
      return -1;
    };
    const isDefined = (from: number, to: number) =>
      defined.size > 0 && to - from <= LABEL_MAX && defined.has(normalizeLabel(source.slice(from, to)));
    // Where the link that "]" at `close` ends, or -1.
    const linkEnd = (bracket: Bracket, close: number): number => {
      const next = close + 1 < end ? source.charCodeAt(close + 1) : -1;
      const text = lastBracket === bracket.textStart - 1 && isDefined(bracket.textStart, close);
      if (next === OPEN_PAREN) {
        const after = resource(close + 1);
        return after >= 0 ? after : text ? close + 1 : -1;
      }
      if (next === OPEN_BRACKET) {
        const after = labelEnd(close + 1);
        if (after >= 0 && isDefined(close + 2, after - 1)) return after;
        if (!text) return -1;
        return close + 2 < end && source.charCodeAt(close + 2) === CLOSE_BRACKET ? close + 3 : -1;
      }
      return text ? close + 1 : -1;
    };
    // The last non-blank character of a table row, whose pipe is dropped.
    let rowEnd = end;
    if (tableRow) while (rowEnd > start && isBlank(source.charCodeAt(rowEnd - 1))) rowEnd--;

    let plain = start;
    let at = start;
    const flush = () => {
      if (at > plain) copy(plain, at);
    };
    while (at < end) {
      skipAtomsBefore(at);
      if (nextAtom < atoms.length && atoms[nextAtom]!.start === at && atoms[nextAtom]!.end <= end) {
        flush();
        const atom = atoms[nextAtom]!;
        copy(atom.start, atom.end);
        at = plain = atom.end;
        continue;
      }
      const code = source.charCodeAt(at);
      switch (code) {
        case BACKSLASH: {
          flush();
          const next = at + 1 < end ? source.charCodeAt(at + 1) : -1;
          if (next === -1) {
            // A line break if the paragraph goes on, else the character.
            pendingBreak = pieces.length;
            pieces.push("\\");
            at += 1;
          } else if (isAsciiPunctuation(next)) {
            pieces.push(source[at + 1]!);
            at += 2;
          } else {
            pieces.push("\\");
            at += 1;
          }
          plain = at;
          continue;
        }
        case BACKTICK: {
          flush();
          const after = runEnd(at, end, BACKTICK);
          // A run after an escaped backtick may have no closer listed.
          const found = runsByLength.get(after - at);
          while (found && found.next < found.starts.length && found.starts[found.next]! <= at) found.next++;
          const closer = found && found.next < found.starts.length ? found.starts[found.next]! : -1;
          if (!found || closer < 0) {
            pieces.push(source.slice(at, after));
            at = plain = after;
            continue;
          }
          found.next++;
          let from = after;
          let to = closer;
          // One space comes off each side, unless the span is only spaces.
          if (
            to - from >= 2 &&
            source.charCodeAt(from) === SPACE &&
            source.charCodeAt(to - 1) === SPACE &&
            runEnd(from, to, SPACE) < to
          ) {
            from++;
            to--;
          }
          copy(from, to);
          at = plain = closer + (after - at);
          continue;
        }
        case STAR:
        case UNDERSCORE:
        case TILDE: {
          flush();
          const after = runEnd(at, end, code);
          const size = after - at;
          const before = at > start ? source.charCodeAt(at - 1) : -1;
          const next = after < end ? source.charCodeAt(after) : -1;
          const left = classify(before);
          const right = classify(next);
          pieces.push(source.slice(at, after));
          at = plain = after;
          let open: boolean;
          let close: boolean;
          if (code === TILDE) {
            // A strike is one or two tildes, not after another tilde.
            if (size > 2) continue;
            open = right === 0 || (right === PUNCTUATION && left !== 0);
            close = left === 0 || (left === PUNCTUATION && right !== 0);
          } else {
            open = right === 0 || (right === PUNCTUATION && left !== 0) || isMarker(next);
            close = left === 0 || (left === PUNCTUATION && right !== 0) || isMarker(before);
            if (code === UNDERSCORE) {
              [open, close] = [open && (left !== 0 || !close), close && (right !== 0 || !open)];
            }
          }
          if (open || close) runs.push({ piece: pieces.length - 1, code, size, open, close, prev: 0, next: 0 });
          continue;
        }
        case BANG:
        case OPEN_BRACKET: {
          if (code === BANG && (at + 1 >= end || source.charCodeAt(at + 1) !== OPEN_BRACKET)) break;
          flush();
          const size = code === BANG ? 2 : 1;
          brackets.push({ piece: pieces.length, link: code === OPEN_BRACKET, runs: runs.length, textStart: at + size });
          pieces.push(source.slice(at, at + size));
          lastBracket = at + size - 1;
          at = plain = at + size;
          continue;
        }
        case CLOSE_BRACKET: {
          flush();
          const index = brackets.length - 1;
          const bracket = brackets[index];
          let after = -1;
          if (bracket) {
            brackets.length = index;
            const inactive = bracket.link && index < inactiveBelow;
            inactiveBelow = Math.min(inactiveBelow, index);
            if (!inactive) after = linkEnd(bracket, at);
          }
          lastBracket = at;
          if (after < 0) {
            pieces.push("]");
            at = plain = at + 1;
            continue;
          }
          pairRuns(bracket!.runs);
          pieces[bracket!.piece] = "";
          if (bracket!.link) inactiveBelow = brackets.length;
          // An image without alt text shows its address, as the chat draws it.
          else if (bracket!.textStart === at && after > at + 1 && source.charCodeAt(at + 1) === OPEN_PAREN) {
            const from = blanksEnd(at + 2, end);
            if (source.charCodeAt(from) !== CLOSE_PAREN) {
              const angled = source.charCodeAt(from) === LT;
              const to = destinationEnd(from);
              pieces.push(normalizeUri(decodeText(source.slice(angled ? from + 1 : from, angled ? to - 1 : to))));
            }
          }
          at = plain = after;
          continue;
        }
        case LT: {
          // An autolink keeps its address. The scan stops at the next "<",
          // so no two scans read the same text.
          let close = at + 1;
          let address = false;
          while (close < end) {
            const inner = source.charCodeAt(close);
            if (inner === GT || inner === LT || inner <= SPACE) break;
            if (inner === COLON || inner === AT) address = true;
            close++;
          }
          if (address && close < end && source.charCodeAt(close) === GT) {
            flush();
            copy(at + 1, close);
            at = plain = close + 1;
            continue;
          }
          break;
        }
        case AMP: {
          const close = referenceEnd(source, at, end);
          const decoded = close < 0 ? undefined : decodeEntity(source.slice(at + 1, close));
          if (decoded === undefined) break;
          flush();
          pieces.push(decoded);
          at = plain = close + 1;
          continue;
        }
        case PIPE: {
          if (!tableRow) break;
          flush();
          if (at + 1 < rowEnd) pieces.push("·");
          at = plain = at + 1;
          continue;
        }
      }
      at++;
    }
    flush();
  }
}

// The ";" that ends a character reference at "&", or -1.
function referenceEnd(source: string, at: number, end: number): number {
  let close = at + 1;
  while (close < end && close - at <= ENTITY_MAX && source.charCodeAt(close) !== SEMICOLON) {
    const inner = source.charCodeAt(close);
    if (!(isWordCode(inner) || inner === HASH)) return -1;
    close++;
  }
  return close < end && source.charCodeAt(close) === SEMICOLON ? close : -1;
}

// Text with its backslash escapes and character references read.
function decodeText(text: string): string {
  let value = "";
  let plain = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    let decoded: string | undefined;
    let after = at + 1;
    if (code === BACKSLASH && at + 1 < text.length && isAsciiPunctuation(text.charCodeAt(at + 1))) {
      decoded = text[at + 1];
      after = at + 2;
    } else if (code === AMP) {
      const close = referenceEnd(text, at, text.length);
      decoded = close < 0 ? undefined : decodeEntity(text.slice(at + 1, close));
      after = close + 1;
    }
    if (decoded === undefined) continue;
    value += text.slice(plain, at) + decoded;
    plain = after;
    at = after - 1;
  }
  return value + text.slice(plain);
}

// A numeric reference is "#" and up to 7 digits, or "#x" and up to 6 hex
// digits, as in micromark.
function decodeEntity(name: string): string | undefined {
  if (name.charCodeAt(0) !== HASH) return decodeNamedCharacterReference(name) || undefined;
  const hex = name[1] === "x" || name[1] === "X";
  const digits = name.slice(hex ? 2 : 1);
  if (!digits || digits.length > (hex ? 6 : 7)) return undefined;
  for (let at = 0; at < digits.length; at++) {
    const code = digits.charCodeAt(at);
    const letter = code | 32;
    if (!(code >= 48 && code <= 57) && !(hex && letter >= 97 && letter <= 102)) return undefined;
  }
  return decodeNumericCharacterReference(digits, hex ? 16 : 10);
}
