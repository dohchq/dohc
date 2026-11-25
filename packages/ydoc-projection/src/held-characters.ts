import type { InlineTokens } from "./inline-marks.js";

type Cell =
  | { kind: "text"; first: string; last: string }
  | { kind: "delimiter"; character: string }
  | { kind: "held"; character: string; at: number }
  | { kind: "opaque"; written: string }
  | { kind: "open"; close: number }
  | { kind: "close" };

const SPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]/u;
const PAIRING_WORK_PER_CELL = 256;
const PAIRING_MINIMUM_CELLS = 256;
const PAIRING_WORK_LIMIT = 2 ** 21;
const REFERENCE = "";
const TOKEN = /DOHC[A-Z]+\d+/gu;

/**
 * Writes each typed `*`, `_`, backtick, and backslash `markdown` holds. One the
 * reader would take as a delimiter, or one that keeps a written delimiter from
 * pairing, is written as a reference. A backslash before ASCII punctuation is
 * doubled. The others are written as they are, so text that reads back keeps
 * its bytes. Modeling how the reader pairs them takes at most
 * `PAIRING_WORK_PER_CELL` steps per cell and `PAIRING_WORK_LIMIT` steps in
 * all. Past that, only a backtick beside code is written as a reference.
 */
export function writeHeldCharacters(markdown: string, tokens: InlineTokens): string {
  if (tokens.held.size === 0 || !markdown.includes("DOHCHELD")) return markdown;
  const cells = cellsOf(markdown, tokens);
  const beside = new Set<number>();
  escapeBackticksBesideCode(cells, beside);
  const paired = new Set(beside);
  const escaped = escapePairs(cells, paired) ? paired : beside;
  const decided = new Map<number, string>();
  cells.forEach((cell, index) => {
    if (cell.kind !== "held") return;
    if (escaped.has(index)) decided.set(cell.at, tokens.reference(cell.character));
    else if (cell.character === "\\" && escapesNext(cells, escaped, index)) {
      decided.set(cell.at, tokens.raw("\\\\"));
    } else decided.set(cell.at, tokens.raw(cell.character));
  });
  let at = 0;
  return markdown.replace(TOKEN, (token) => {
    const character = tokens.held.get(token);
    if (character === undefined) return token;
    const written = decided.get(at) ?? tokens.raw(character);
    at += 1;
    return written;
  });
}

function cellsOf(markdown: string, tokens: InlineTokens): Cell[] {
  const cells: Cell[] = [];
  const scopes: number[] = [];
  let plain = "";
  let opaque = "";
  let depth = 0;
  let at = 0;
  let last = 0;
  const flush = () => {
    for (const [, reference, delimiter, other] of tokens
      .write(plain)
      .matchAll(/(&(?:amp;)?#\d+;|\\=)|([*_`])|([^*_`&\\]+|[\s\S])/gu)) {
      if (reference) {
        cells.push({ kind: "text", first: REFERENCE, last: REFERENCE });
      } else if (delimiter === "`") {
        cells.push({ kind: "text", first: delimiter, last: delimiter });
      } else if (delimiter) {
        cells.push({ kind: "delimiter", character: delimiter });
      } else {
        const characters = Array.from(other!);
        const previous = cells.at(-1);
        if (previous?.kind === "text" && previous.first !== REFERENCE && previous.first !== "`") {
          previous.last = characters.at(-1)!;
        } else {
          cells.push({ kind: "text", first: characters[0]!, last: characters.at(-1)! });
        }
      }
    }
    plain = "";
  };
  for (const match of markdown.matchAll(TOKEN)) {
    const token = match[0];
    const held = tokens.held.get(token);
    const marker = [...tokens.opaque, ...tokens.scope].indexOf(token);
    if (held === undefined && marker === -1) continue;
    const between = markdown.slice(last, match.index);
    last = match.index + token.length;
    if (depth > 0) {
      opaque += between;
      if (marker === 0) depth += 1;
      if (marker === 1) depth -= 1;
      if (depth > 0) opaque += token;
      else {
        cells.push({ kind: "opaque", written: tokens.write(opaque) });
        opaque = "";
      }
      if (held !== undefined) at += 1;
      continue;
    }
    plain += between;
    flush();
    if (held !== undefined) {
      cells.push({ kind: "held", character: held, at });
      at += 1;
    } else if (marker === 0) {
      depth = 1;
    } else if (marker === 2) {
      scopes.push(cells.length);
      cells.push({ kind: "open", close: -1 });
    } else if (marker === 3) {
      const open = scopes.pop();
      if (open !== undefined) {
        (cells[open] as { close: number }).close = cells.length;
        cells.push({ kind: "close" });
      }
    }
  }
  plain += markdown.slice(last);
  flush();
  return cells;
}

function escapesNext(cells: Cell[], escaped: Set<number>, index: number): boolean {
  if (endsUnderline(cells, index)) return false;
  const next = charAfter(cells, escaped, index + 1, cells.length, "first");
  return next === REFERENCE || (next !== undefined && ASCII_PUNCTUATION.test(next));
}

function endsUnderline(cells: Cell[], index: number): boolean {
  const delimiter = cells[index + 1];
  return (
    delimiter?.kind === "opaque" && delimiter.written === "++" && cells[index + 2]?.kind === "close"
  );
}

function shown(cell: Cell, escaped: Set<number>, index: number, side: "first" | "last") {
  switch (cell.kind) {
    case "text":
      return side === "first" ? cell.first : cell.last;
    case "delimiter":
      return cell.character;
    case "held":
      return escaped.has(index) ? REFERENCE : cell.character;
    case "opaque": {
      const characters = Array.from(cell.written);
      return side === "first" ? characters[0] : characters.at(-1);
    }
    default:
      return undefined;
  }
}

function charAfter(
  cells: Cell[],
  escaped: Set<number>,
  from: number,
  to: number,
  side: "first",
): string | undefined {
  for (let index = from; index < to; index += 1) {
    const character = shown(cells[index]!, escaped, index, side);
    if (character !== undefined) return character;
  }
  return undefined;
}

function charBefore(cells: Cell[], escaped: Set<number>, from: number): string | undefined {
  for (let index = from; index >= 0; index -= 1) {
    const character = shown(cells[index]!, escaped, index, "last");
    if (character !== undefined) return character;
  }
  return undefined;
}

type Backtick = { index: number; held: boolean };

function backtickRuns(
  cells: Cell[],
  escaped: Set<number>,
  from: number,
  to: number,
  until: (found: Backtick[][]) => boolean = () => false,
): Backtick[][] {
  const found: Backtick[][] = [];
  let run: Backtick[] = [];
  const end = (): boolean => {
    if (run.length) found.push(run);
    run = [];
    return until(found);
  };
  for (let index = from; index < to; index += 1) {
    const cell = cells[index]!;
    if (cell.kind === "held") {
      if (cell.character === "`" && !escaped.has(index)) run.push({ index, held: true });
      else if (end()) return found;
    } else if (cell.kind === "opaque") {
      const pieces = cell.written.startsWith("`")
        ? Array.from(cell.written)
        : (cell.written.match(/\\[!-/:-@[-`{-~]|[\s\S]/gu) ?? []);
      for (const piece of pieces) {
        if (piece === "`") run.push({ index, held: false });
        else if (end()) return found;
      }
    } else if (cell.kind === "text" && cell.first === "`") {
      run.push({ index, held: false });
    } else if ((cell.kind === "text" || cell.kind === "delimiter") && end()) {
      return found;
    }
  }
  end();
  return found;
}

function escapeBackticksBesideCode(cells: Cell[], escaped: Set<number>): void {
  for (const run of backtickRuns(cells, escaped, 0, cells.length)) {
    if (run.some(({ held }) => held) && run.some(({ held }) => !held)) {
      for (const { index, held } of run) if (held) escaped.add(index);
    }
  }
}

type Match = { from: number; width: number; end: number };

class PairingTooLong extends Error {}

function escapePairs(cells: Cell[], escaped: Set<number>): boolean {
  let work = Math.min(
    Math.max(cells.length, PAIRING_MINIMUM_CELLS) * PAIRING_WORK_PER_CELL,
    PAIRING_WORK_LIMIT,
  );
  const spend = (steps: number): void => {
    work -= steps;
    if (work < 0) throw new PairingTooLong();
  };
  const delimits = (index: number, character: string): boolean => {
    const cell = cells[index]!;
    return (
      (cell.kind === "delimiter" && cell.character === character) ||
      (cell.kind === "held" && cell.character === character && !escaped.has(index))
    );
  };
  const punctuation = (character: string, star: boolean): boolean =>
    PUNCTUATION.test(character) && !(star && character === "~");
  const classify = (
    star: boolean,
    before: string | undefined,
    after: string | undefined,
  ): "open" | "close" | "both" | undefined => {
    const spaceAfter = after === undefined || SPACE.test(after);
    if (before === undefined || SPACE.test(before)) return spaceAfter ? undefined : "open";
    if (punctuation(before, star)) {
      if (spaceAfter) return "close";
      return punctuation(after, star) ? "both" : "open";
    }
    if (spaceAfter || punctuation(after!, star)) return "close";
    return star ? "both" : undefined;
  };
  const inner = (open: number): [number, number] => {
    const close = (cells[open] as { close: number }).close;
    return [
      open + 1 + (cells[open + 1]?.kind === "opaque" ? 1 : 0),
      close - (cells[close - 1]?.kind === "opaque" ? 1 : 0),
    ];
  };
  const isLink = (open: number): boolean => {
    const first = cells[open + 1];
    return first?.kind === "opaque" && first.written.startsWith("[");
  };
  const consumed = new Set<number>();

  const maskCodeSpans = (from: number, to: number): Set<number> => {
    const hidden = new Set<number>();
    const runs = backtickRuns(cells, escaped, from, to);
    for (let at = 0; at + 1 < runs.length; at += 1) {
      if (runs[at]!.length !== runs[at + 1]!.length) continue;
      for (let index = runs[at]![0]!.index; index <= runs[at + 1]!.at(-1)!.index; index += 1) {
        hidden.add(index);
      }
      at += 1;
    }
    return hidden;
  };

  const pastOrphanInStrong = (
    from: number,
    to: number,
    character: string,
    masked: Set<number>,
  ): number => {
    const strong = character === "*" ? "_" : "*";
    let index = from;
    const plain = () => {
      while (
        index < to &&
        (masked.has(index) || (!delimits(index, "*") && !delimits(index, "_")))
      ) {
        const cell = cells[index]!;
        index =
          cell.kind === "open" && cell.close < to && isLink(index) ? cell.close + 1 : index + 1;
      }
    };
    const pair = () => index + 1 < to && delimits(index, strong) && delimits(index + 1, strong);
    plain();
    if (!pair()) return from;
    index += 2;
    plain();
    if (!(index < to && delimits(index, character))) return from;
    index += 1;
    plain();
    return pair() ? index : from;
  };

  const emStrong = (
    from: number,
    to: number,
    before: string,
    masked: Set<number>,
  ): Match | undefined => {
    const character = shown(cells[from]!, escaped, from, "first")!;
    const star = character === "*";
    let end = from;
    while (end < to && delimits(end, character)) end += 1;
    spend(end - from);
    const length = end - from;
    const after = charAfter(cells, escaped, end, to, "first");
    if (after === undefined || SPACE.test(after)) return undefined;
    const punctuationAfter = PUNCTUATION.test(after) && after !== "~";
    if (!star && !punctuationAfter && /[\p{L}\p{N}]/u.test(before)) return undefined;
    if (
      punctuationAfter &&
      before !== "" &&
      (before === "*" || before === "_" || !(SPACE.test(before) || PUNCTUATION.test(before)))
    ) {
      return undefined;
    }
    let open = length;
    let middle = 0;
    let index = pastOrphanInStrong(end, to, character, masked);
    let match: Match | undefined;
    while (index < to && match === undefined) {
      const cell = cells[index]!;
      if (cell.kind === "open" && cell.close < to && isLink(index)) {
        index = cell.close + 1;
        continue;
      }
      if (masked.has(index) || !delimits(index, character)) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < to && !masked.has(index) && delimits(index, character)) index += 1;
      const size = index - start;
      const kind = classify(
        star,
        charBefore(cells, escaped, start - 1),
        charAfter(cells, escaped, index, to, "first"),
      );
      if (kind === undefined) continue;
      if (kind === "open") {
        open += size;
        continue;
      }
      if (kind === "both" && length % 3 && !((length + size) % 3)) {
        middle += size;
        continue;
      }
      open -= size;
      if (open > 0) continue;
      const used = Math.min(size, size + open + middle);
      match = { from, width: Math.min(length, used) % 2 ? 1 : 2, end: start + used };
    }
    spend(index - end);
    return match;
  };

  const blockers = new Set<number>();
  const opensStrike = (index: number): boolean => {
    const delimiter = cells[index + 1];
    return (
      cells[index]?.kind === "open" && delimiter?.kind === "opaque" && delimiter.written === "~~"
    );
  };
  const letter = (character: string | undefined): boolean =>
    character !== undefined && !SPACE.test(character) && !PUNCTUATION.test(character);

  const strikeForms = (open: number, to: number, before: string, masked: Set<number>): boolean => {
    const { close } = cells[open] as { close: number };
    if (masked.has(close - 1)) return false;
    const first = charAfter(cells, escaped, open + 2, close - 1, "first");
    const last = charBefore(cells, escaped, close - 2);
    const next = charAfter(cells, escaped, close + 1, to, "first");
    const opens =
      first !== undefined &&
      !SPACE.test(first) &&
      first !== "~" &&
      (letter(first) || before === "" || (!letter(before) && before !== "*" && before !== "_"));
    const closes =
      letter(last) || (last !== undefined && !SPACE.test(last) && last !== "~" && !letter(next));
    if (opens && closes) return true;
    for (const at of [open - 1, open + 2, close - 2, close + 1]) {
      const cell = cells[at];
      if (cell?.kind === "held" && cell.character !== "\\" && delimits(at, cell.character)) {
        blockers.add(at);
      }
    }
    return false;
  };

  const holdLabelBackticks = (from: number, to: number): void => {
    const runs = backtickRuns(cells, escaped, from, to);
    const last = runs.at(-1);
    if (runs.length % 2 === 0 || !last) return;
    const end = last.at(-1)!.index;
    const atEnd =
      charAfter(cells, escaped, end + 1, to, "first") === undefined &&
      shown(cells[end]!, escaped, end, "last") === "`";
    if (last.length >= 2 && atEnd) return;
    const held = runs.find((run) => run.every((backtick) => backtick.held));
    if (held) for (const { index } of held) blockers.add(index);
  };

  const lex = (from: number, to: number): void => {
    spend(to - from);
    const masked = maskCodeSpans(from, to);
    let before = "";
    for (let index = from; index < to;) {
      const cell = cells[index]!;
      if (cell.kind === "open") {
        if (cell.close < to && !(opensStrike(index) && !strikeForms(index, to, before, masked))) {
          const [innerFrom, innerTo] = inner(index);
          lex(innerFrom, innerTo);
          if (isLink(index)) holdLabelBackticks(innerFrom, innerTo);
          before = "";
          index = cell.close + 1;
        } else {
          index += 1;
        }
        continue;
      }
      if (cell.kind === "close") {
        index += 1;
        continue;
      }
      if (cell.kind === "opaque") {
        before = "";
        index += 1;
        continue;
      }
      const character = shown(cell, escaped, index, "first")!;
      if (cell.kind === "held" && character === "`") {
        const found = backtickRuns(
          cells,
          escaped,
          index,
          to,
          (runs) => runs.length > 1 && runs.at(-1)!.length === runs[0]!.length,
        );
        const run = found[0]!;
        const last = found.at(-1)!;
        const partner = found.length > 1 && last.length === run.length ? last : undefined;
        spend((partner ? partner.at(-1)!.index + 1 : to) - index);
        if (partner) for (const { index: at } of run) consumed.add(at);
        else if (opensStrike(run.at(-1)!.index + 1))
          for (const { index: at } of run) blockers.add(at);
        before = partner ? "" : character;
        index = (partner ?? run).at(-1)!.index + 1;
        continue;
      }
      if ((character === "*" || character === "_") && delimits(index, character)) {
        const match = emStrong(index, to, before, masked);
        if (match) {
          for (let offset = 0; offset < match.width; offset += 1) {
            consumed.add(match.from + offset);
            consumed.add(match.end - 1 - offset);
          }
          lex(match.from + match.width, match.end - match.width);
          before = "";
          index = match.end;
          continue;
        }
      }
      const last = shown(cell, escaped, index, "last")!;
      if (last !== "_") before = last;
      index += 1;
    }
  };

  const escapeRun = (index: number): void => {
    const { character } = cells[index] as { character: string };
    let from = index;
    while (from > 0 && cells[from - 1]!.kind === "held" && delimits(from - 1, character)) from -= 1;
    for (
      let at = from;
      at < cells.length && cells[at]!.kind === "held" && delimits(at, character);
    ) {
      escaped.add(at);
      at += 1;
    }
  };

  try {
    for (;;) {
      consumed.clear();
      blockers.clear();
      lex(0, cells.length);
      const taken = cells.flatMap((cell, index) =>
        cell.kind === "held" && consumed.has(index) ? [index] : [],
      );
      for (const index of taken) escapeRun(index);
      if (taken.length > 0) continue;
      const stranded = ["*", "_"].filter((character) =>
        cells.some(
          (cell, index) =>
            cell.kind === "delimiter" && cell.character === character && !consumed.has(index),
        ),
      );
      const besideDelimiter = (index: number): boolean =>
        stranded.length > 0 &&
        (cells[index - 1]?.kind === "delimiter" || cells[index + 1]?.kind === "delimiter");
      const blocking = cells.flatMap((cell, index) => {
        if (cell.kind !== "held" || cell.character === "\\" || !delimits(index, cell.character)) {
          return [];
        }
        if (besideDelimiter(index) || blockers.has(index)) return [index];
        if (!stranded.includes(cell.character)) return [];
        const kind = classify(
          cell.character === "*",
          charBefore(cells, escaped, index - 1),
          charAfter(cells, escaped, index + 1, cells.length, "first"),
        );
        return kind === undefined ? [] : [index];
      });
      for (const index of blocking) escapeRun(index);
      if (blocking.length === 0) return true;
    }
  } catch (error) {
    if (error instanceof PairingTooLong) return false;
    throw error;
  }
}
