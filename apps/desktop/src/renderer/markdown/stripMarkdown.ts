// The words of a Markdown body without its syntax, for anywhere that shows a
// message without rendering it: emphasis marks, backticks, heading and quote
// markers, link targets and fences go; bullets become "•" and line breaks
// stay. It does not parse. Every step reads forward through the body, and no
// lookahead rereads text another step has read, so its time grows linearly
// with the body whatever the body holds. It uses no regular expression.
//
// `atoms` are source ranges to keep exactly as written, such as mention
// chips, sorted by start. The result gives where each kept atom landed in the
// text; an atom inside syntax that the strip removes, like a link target, is
// dropped.

import { decodeNamedCharacterReference } from "decode-named-character-reference";

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
const isAsciiPunctuation = (code: number) =>
  (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
// Outside the line counts as whitespace, as it does for CommonMark's flanking.
const isWhitespace = (code: number) => code <= SPACE || code === 0xa0 || code === 0x3000;
const isWordCode = (code: number) => !isWhitespace(code) && !isAsciiPunctuation(code);

const ENTITY_MAX = 32;

export function stripMarkdown(source: string, atoms: readonly SourceRange[] = []): StrippedMarkdown {
  // Output pieces. Kept atoms remember their piece, and a link opener can
  // blank its own piece once its closer is found, so offsets are summed last.
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

  let fence: { code: number; size: number } | null = null;
  // An indented line opens a code block after a blank line, the start or a
  // closed fence, and continues an open one.
  let afterBlank = true;
  let indented = false;
  // Emphasis and strike runs that can still close, by character, while the
  // paragraph they sit in continues.
  const delimiters = new Map<number, Array<{ piece: number; size: number }>>();
  let paragraph = false;
  let lineStart = 0;
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = source.length;
    let end = lineEnd;
    if (end > lineStart && source.charCodeAt(end - 1) === CR) end--;
    const keepLine = fence ? stripFencedLine(lineStart, end) : stripLine(lineStart, end);
    if (lineEnd === source.length) break;
    if (keepLine) pieces.push("\n");
    lineStart = lineEnd + 1;
  }

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

  // A run of one character from `at`, at most to `end`.
  function runEnd(at: number, end: number, code: number): number {
    let next = at;
    while (next < end && source.charCodeAt(next) === code) next++;
    return next;
  }

  // The first `code` in [at, end), or `end`. It never reads past the line.
  function find(code: number, at: number, end: number): number {
    let next = at;
    while (next < end && source.charCodeAt(next) !== code) next++;
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
      afterBlank = true;
      return true;
    }
    const code = codeStart(start, end);
    if (code >= 0 && (afterBlank || indented)) {
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
        fence = { code: first, size: after - at };
        return false;
      }
    }
    // Thematic breaks, setext underlines and table delimiter rows.
    if ((first === DASH || first === STAR || first === UNDERSCORE) && onlyOf(at, end, () => false, first, 3)) return false;
    if (first === EQUALS && onlyOf(at, end, () => false, EQUALS, 1)) return false;
    if (
      (first === PIPE || first === DASH || first === COLON) &&
      onlyOf(at, end, (code) => code === DASH || code === COLON, PIPE, 1) &&
      find(DASH, at, end) < end
    ) {
      return false;
    }

    // Container and heading markers. Each pass takes at least one character.
    // A list item or heading starts a new paragraph.
    let opensBlock = false;
    let heading = false;
    for (;;) {
      at = indentEnd(at, end);
      if (at >= end) return true;
      const code = source.charCodeAt(at);
      const next = at + 1 < end ? source.charCodeAt(at + 1) : SPACE;
      if (code === GT) {
        at += isBlank(next) ? 2 : 1;
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

    // A link reference definition shows nothing.
    if (source.charCodeAt(at) === OPEN_BRACKET) {
      const close = find(CLOSE_BRACKET, at, end);
      if (close + 1 < end && source.charCodeAt(close + 1) === COLON) return false;
    }
    let tableRow = false;
    if (source.charCodeAt(at) === PIPE) {
      tableRow = true;
      at++;
    }
    if (!continues || opensBlock || tableRow) delimiters.clear();
    stripInline(at, end, tableRow);
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

  function stripInline(start: number, end: number, tableRow: boolean) {
    // Backtick runs of the line, by length, so a code span finds its closer
    // with a pointer that only moves forward.
    const runsByLength = new Map<number, { starts: number[]; next: number }>();
    for (let at = start; at < end; at++) {
      if (source.charCodeAt(at) !== BACKTICK) continue;
      const after = runEnd(at, end, BACKTICK);
      const runs = runsByLength.get(after - at) ?? { starts: [], next: 0 };
      runs.starts.push(at);
      runsByLength.set(after - at, runs);
      at = after - 1;
    }
    // The ")" that closes each "(" of the line, skipping escaped ones, so a
    // link's target can hold balanced parentheses. Built when a link needs it.
    let closers: Int32Array | undefined;
    const closerOf = (open: number) => {
      if (!closers) {
        closers = new Int32Array(end - start).fill(-1);
        const opens: number[] = [];
        for (let at = start; at < end; at++) {
          const code = source.charCodeAt(at);
          if (code === BACKSLASH) at++;
          else if (code === OPEN_PAREN) opens.push(at);
          else if (code === CLOSE_PAREN && opens.length > 0) closers[opens.pop()! - start] = at;
        }
      }
      return closers[open - start]!;
    };
    // The next "]" at or after a point. Each search starts past the last one
    // found, so together they read the line once.
    let bracket = -1;
    // Pieces holding an unclosed "[" or "![", newest last.
    const openers: number[] = [];
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
          if (next === -1) at += 1;
          else if (isAsciiPunctuation(next)) {
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
          const runs = runsByLength.get(after - at)!;
          while (runs.next < runs.starts.length && runs.starts[runs.next]! <= at) runs.next++;
          const closer = runs.next < runs.starts.length ? runs.starts[runs.next]! : -1;
          if (closer < 0) {
            pieces.push(source.slice(at, after));
            at = plain = after;
            continue;
          }
          runs.next++;
          let from = after;
          let to = closer;
          if (to - from >= 2 && source.charCodeAt(from) === SPACE && source.charCodeAt(to - 1) === SPACE) {
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
          const before = at > start ? source.charCodeAt(at - 1) : SPACE;
          const next = after < end ? source.charCodeAt(after) : SPACE;
          const left = !isWhitespace(next) && (!isAsciiPunctuation(next) || isWhitespace(before) || isAsciiPunctuation(before));
          const right = !isWhitespace(before) && (!isAsciiPunctuation(before) || isWhitespace(next) || isAsciiPunctuation(next));
          const size = after - at;
          const strike = code !== TILDE || size <= 2;
          const opens = strike && left && (code !== UNDERSCORE || !right || isAsciiPunctuation(before));
          const closes = strike && right && (code !== UNDERSCORE || !left || isAsciiPunctuation(next));
          // A run shows nothing only when it closes an earlier one in the
          // paragraph, as the parser pairs them; strikes pair by length.
          let open = delimiters.get(code);
          const opener = open?.at(-1);
          pieces.push(source.slice(at, after));
          if (closes && opener && (code !== TILDE || opener.size === size)) {
            open!.pop();
            pieces[opener.piece] = pieces[pieces.length - 1] = "";
          } else if (opens) {
            if (!open) delimiters.set(code, (open = []));
            open.push({ piece: pieces.length - 1, size });
          }
          at = plain = after;
          continue;
        }
        case BANG:
        case OPEN_BRACKET: {
          if (code === BANG && (at + 1 >= end || source.charCodeAt(at + 1) !== OPEN_BRACKET)) break;
          flush();
          const size = code === BANG ? 2 : 1;
          openers.push(pieces.length);
          pieces.push(source.slice(at, at + size));
          at = plain = at + size;
          continue;
        }
        case CLOSE_BRACKET: {
          flush();
          const opener = openers.pop();
          const next = at + 1 < end ? source.charCodeAt(at + 1) : -1;
          if (opener !== undefined && next === OPEN_PAREN) {
            const close = closerOf(at + 1);
            if (close >= 0) {
              pieces[opener] = "";
              at = plain = close + 1;
              continue;
            }
          }
          if (opener !== undefined && next === OPEN_BRACKET) {
            bracket = bracket >= at + 2 ? bracket : find(CLOSE_BRACKET, at + 2, end);
            if (bracket < end) {
              pieces[opener] = "";
              at = plain = bracket + 1;
              continue;
            }
          }
          pieces.push("]");
          at = plain = at + 1;
          continue;
        }
        case LT: {
          // An autolink keeps its address. The scan stops at the next "<",
          // so no two scans read the same text.
          let close = at + 1;
          let address = false;
          while (close < end) {
            const inner = source.charCodeAt(close);
            if (inner === GT || inner === LT || isWhitespace(inner)) break;
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
          let close = at + 1;
          while (close < end && close - at <= ENTITY_MAX && source.charCodeAt(close) !== SEMICOLON) {
            const inner = source.charCodeAt(close);
            if (!(isWordCode(inner) || inner === HASH)) break;
            close++;
          }
          if (close >= end || source.charCodeAt(close) !== SEMICOLON) break;
          const decoded = decodeEntity(source.slice(at + 1, close));
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

function decodeEntity(name: string): string | undefined {
  if (name.charCodeAt(0) !== HASH) return decodeNamedCharacterReference(name) || undefined;
  const hex = name[1] === "x" || name[1] === "X";
  const digits = name.slice(hex ? 2 : 1);
  if (!digits || digits.length > 7) return undefined;
  const value = Number.parseInt(digits, hex ? 16 : 10);
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return undefined;
  return String.fromCodePoint(value);
}
