import * as Y from "yjs";
import { comparePlaces, Places } from "./removedText.js";

type DeleteSet = ReturnType<typeof Y.decodeUpdate>["ds"];

/** A run of characters by one client, by id. */
interface Span {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
}

/**
 * Text one change deleted in one place and wrote in another. Yjs cannot move text, so an editor
 * writes a joined, split or rebuilt line as a delete and a fresh copy. `source` and `copy` name
 * the same characters in the same order.
 */
interface Move {
  readonly source: readonly Span[];
  /** Changes when a later move takes the copy on to another place. */
  copy: readonly Span[];
  readonly text: string;
}

/**
 * Text a change wrote: new pieces side by side in one line, and on into the next line when the
 * first run ends its line and the next starts its own. A change that joins a line and splits
 * the result leaves the text that way.
 */
interface Run {
  /** The change made every line the run stands in. */
  readonly fresh: boolean;
  readonly lines: ReadonlySet<Y.XmlText>;
  readonly text: string;
  readonly spans: readonly Span[];
}

/** Text in a deleted line that the change's author never had, by its offset in the source. */
interface Unseen {
  readonly item: Y.Item;
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

interface Found {
  readonly move: Move;
  /** The line the text was in; null when this page no longer has the line. */
  readonly line: Y.XmlText | null;
  /** Stretches of the source that were deleted here before this change, as offsets. */
  readonly already: readonly (readonly [number, number])[];
  readonly unseen: Unseen[];
  /** Text still in the line, after text of it that the change moved to a new line. */
  readonly behind: Unseen[];
}

type Repair =
  | { readonly kind: "delete"; readonly spans: readonly Span[] }
  | {
      readonly kind: "insert";
      readonly text: string;
      readonly at: Span;
      readonly after: boolean;
      /** Where the text stands now, when the repair takes it from there. */
      readonly from: readonly Span[];
    };

const REMEMBERED = 64;

function slice(spans: readonly Span[], from: number, to: number): Span[] {
  const part: Span[] = [];
  let at = 0;
  for (const span of spans) {
    const start = Math.max(from, at),
      end = Math.min(to, at + span.length);
    if (start < end)
      part.push({ client: span.client, clock: span.clock + start - at, length: end - start });
    at += span.length;
  }
  return part;
}

function add(spans: Span[], client: number, clock: number, length: number): void {
  const last = spans.at(-1);
  if (last && last.client === client && last.clock + last.length === clock)
    spans[spans.length - 1] = { client, clock: last.clock, length: last.length + length };
  else spans.push({ client, clock, length });
}

/** Where the ids `clock` to `clock + length` stand in `spans` as one stretch, or -1. */
function offsetOf(spans: readonly Span[], client: number, clock: number, length: number): number {
  let at = 0;
  for (const span of spans) {
    if (span.client === client && span.clock <= clock && clock + length <= span.clock + span.length)
      return at + clock - span.clock;
    at += span.length;
  }
  return -1;
}

const sameSpans = (left: readonly Span[], right: readonly Span[]) =>
  left.length === right.length &&
  left.every(
    (span, index) =>
      span.client === right[index]!.client &&
      span.clock === right[index]!.clock &&
      span.length === right[index]!.length,
  );

/** An item cut where `named` starts or stops listing it: [start, end, listed]. */
function cut(item: Y.Item, named: DeleteSet): [number, number, boolean][] {
  const from = item.id.clock,
    to = from + item.length;
  const parts: [number, number, boolean][] = [];
  let cursor = from;
  for (const range of named.clients.get(item.id.client) ?? []) {
    if (range.clock + range.len <= cursor) continue;
    if (range.clock >= to) break;
    if (range.clock > cursor) parts.push([cursor - from, range.clock - from, false]);
    const end = Math.min(to, range.clock + range.len);
    parts.push([Math.max(cursor, range.clock) - from, end - from, true]);
    cursor = end;
  }
  if (cursor < to) parts.push([cursor - from, to - from, false]);
  return parts;
}

const isNew = (transaction: Y.Transaction, id: Y.ID) =>
  id.clock >= (transaction.beforeState.get(id.client) ?? 0);

/** The text this change wrote, in the note's order. */
function newRuns(transaction: Y.Transaction, places: Places): Run[] {
  const lines = new Set<Y.XmlText>();
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = transaction.doc.store.clients.get(client)!;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index++) {
      const item = structs[index]!;
      if (
        item instanceof Y.Item &&
        !item.deleted &&
        item.content instanceof Y.ContentString &&
        item.parent instanceof Y.XmlText
      )
        lines.add(item.parent);
    }
  }
  interface Piece {
    line: Y.XmlText;
    first: Y.Item;
    text: string;
    spans: Span[];
    startsLine: boolean;
    endsLine: boolean;
  }
  const pieces: Piece[] = [];
  for (const line of lines) {
    let open: Piece | null = null,
      shown = false;
    for (let item = line._start; item !== null; item = item.right) {
      if (item.content instanceof Y.ContentFormat) continue;
      if (!item.deleted && isNew(transaction, item.id) && item.content instanceof Y.ContentString) {
        if (open === null) {
          open = { line, first: item, text: "", spans: [], startsLine: !shown, endsLine: true };
          pieces.push(open);
        }
        open.text += item.content.str;
        add(open.spans, item.id.client, item.id.clock, item.length);
      } else if (!item.deleted) {
        if (open) open.endsLine = false;
        open = null;
      }
      if (!item.deleted) shown = true;
    }
  }
  const at = new Map(
    pieces.map((piece) => [piece, places.of({ item: piece.first, start: 0, end: 1 })]),
  );
  pieces.sort((left, right) => comparePlaces(at.get(left)!, at.get(right)!));
  const fresh = (line: Y.XmlText) => line._item !== null && isNew(transaction, line._item.id);
  const runs: Run[] = [];
  let last: Piece | undefined;
  for (const piece of pieces) {
    const run = runs.at(-1);
    if (run && last?.endsLine && piece.startsLine)
      runs[runs.length - 1] = {
        fresh: run.fresh && fresh(piece.line),
        lines: new Set([...run.lines, piece.line]),
        text: run.text + piece.text,
        spans: [...run.spans, ...piece.spans],
      };
    else
      runs.push({
        fresh: fresh(piece.line),
        lines: new Set([piece.line]),
        text: piece.text,
        spans: piece.spans,
      });
    last = piece;
  }
  return runs;
}

/** The one place `text` stands among the runs, or null when it stands in none or in several. */
function placeIn(
  runs: readonly Run[],
  text: string,
  fits: (run: Run) => boolean,
): readonly Span[] | null {
  let place: readonly Span[] | null = null;
  for (const run of runs) {
    if (!fits(run)) continue;
    const at = run.text.indexOf(text);
    if (at < 0) continue;
    if (place !== null || run.text.indexOf(text, at + 1) >= 0) return null;
    place = slice(run.spans, at, at + text.length);
  }
  return place;
}

/** The first item of `spans` that is still in the note, to say where the spans stand. */
function firstShown(doc: Y.Doc, spans: readonly Span[]): Y.Item | null {
  for (const span of spans) {
    const structs = doc.store.clients.get(span.client) ?? [];
    if (structs.length === 0) continue;
    for (let index = Y.findIndexSS(structs, span.clock); index < structs.length; index++) {
      const item = structs[index]!;
      if (item.id.clock >= span.clock + span.length) break;
      if (item instanceof Y.Item && !item.deleted && item.parent instanceof Y.XmlText) return item;
    }
  }
  return null;
}

/** How many characters of the line stand before `item`. */
function shownBefore(item: Y.Item): number {
  let count = 0;
  for (let left = item.left; left !== null; left = left.left)
    if (!left.deleted && left.countable) count += left.length;
  return count;
}

/**
 * Keeps a note whole when two people join, split or rebuild the same lines at once (#4038).
 *
 * A page remembers each move it makes or receives. When a change from elsewhere moves text the
 * page knows more about, the page makes that knowledge follow the move:
 *
 * - Text this page typed into the moved line, which the mover never had, is typed again at the
 *   same place in the copy.
 * - Text the page knows was already moved elsewhere is now in the note twice, so one copy goes.
 *   Deleting is safe to repeat, and every page picks the same copy, so any number of pages may
 *   do it.
 *
 * A page acts only on what it knows for certain: its own typing, and moves whose whole text it
 * read. A page that knows less does nothing.
 */
export class MovedText {
  private readonly moves: Move[] = [];
  private repairs: Repair[] = [];

  /** A change this page made. Call from `afterTransaction`, before Yjs drops deleted content. */
  note(transaction: Y.Transaction): void {
    if (transaction.deleteSet.clients.size === 0) return;
    const runs = newRuns(transaction, new Places());
    if (runs.length === 0) return;
    for (const { move } of this.read(transaction, transaction.deleteSet, runs).found)
      this.remember(move);
  }

  /**
   * A change from elsewhere, inside its transaction. `named` is the change's own delete set,
   * merged. Plans the repairs, which `repair` makes, and returns which of this page's removed
   * text they put back.
   */
  follow(
    transaction: Y.Transaction,
    named: DeleteSet,
    own: (item: Y.Item) => boolean,
  ): (item: Y.Item, start: number, end: number) => boolean {
    const followed: { item: Y.Item; start: number; end: number }[] = [];
    const putBack = (item: Y.Item, start: number, end: number) =>
      followed.some((range) => range.item === item && range.start <= start && end <= range.end);
    if (named.clients.size === 0) return putBack;
    const places = new Places();
    const runs = newRuns(transaction, places);
    if (runs.length === 0) return putBack;
    const { found, orphans, lines } = this.read(transaction, named, runs);
    // Text this page knows was moved, which this change's author moved too without seeing that.
    // Where this change deleted the page's copy, the text stands in the author's copy instead.
    const elsewhere: Span[] = [];
    const again: Found[] = [];
    for (const known of this.moves) {
      const item = firstItem(transaction.doc, known.source[0]!);
      if (item && lines.has(item.parent as Y.XmlText)) continue;
      for (const [from, to] of listed(known.source, named)) {
        const text = known.text.slice(from, to);
        const copy = placeIn(runs, text, () => true);
        if (copy === null) continue;
        const move = { source: slice(known.source, from, to), copy, text };
        this.keepOne(transaction.doc, places, known, from, move, 0, to - from);
        elsewhere.push(...slice(known.copy, from, to));
        again.push({ move, line: null, already: [], unseen: [], behind: [] });
      }
    }
    const kept = ({ item, start, end }: Unseen) =>
      elsewhere.some(
        (span) =>
          span.client === item.id.client &&
          span.clock <= item.id.clock + start &&
          item.id.clock + end <= span.clock + span.length,
      );
    // A line of this page's own in the same deleted block follows the moved line before it.
    for (const orphan of orphans) {
      const home = homeOf(orphan.line, found);
      if (home)
        for (const piece of orphan.unseen)
          home.unseen.push({ ...piece, offset: home.move.text.length });
    }
    for (const { move, already, unseen, behind } of found) {
      for (const [from, to] of already) {
        const stretch = slice(move.source, from, to);
        const first = stretch[0]!;
        for (const known of this.moves) {
          const at = offsetOf(known.source, first.client, first.clock, first.length);
          if (at < 0 || !sameSpans(slice(known.source, at, at + to - from), stretch)) continue;
          this.keepOne(transaction.doc, places, known, at, move, from, to - from);
        }
      }
      // This page's typing, by where it stood in the source.
      const typed = new Map<number, string>();
      for (const piece of unseen) {
        const { item, start, end, offset } = piece;
        if (!own(item)) continue;
        followed.push({ item, start, end });
        if (kept(piece)) continue;
        typed.set(
          offset,
          (typed.get(offset) ?? "") + (item.content as Y.ContentString).str.slice(start, end),
        );
      }
      for (const [offset, text] of typed)
        this.repairs.push({
          kind: "insert",
          text,
          at: slice(move.copy, Math.max(0, offset - 1), Math.max(1, offset))[0]!,
          after: offset > 0,
          from: [],
        });
      // A split took the text before this page's own to a new line, so the page's text goes
      // after it there. The author had none of it: a split takes all that follows.
      if (behind.every(({ item }) => own(item))) {
        const left = new Map<number, { text: string; from: Span[] }>();
        for (const { item, start, end, offset } of behind) {
          const entry = left.get(offset) ?? { text: "", from: [] };
          entry.text += (item.content as Y.ContentString).str.slice(start, end);
          add(entry.from, item.id.client, item.id.clock + start, end - start);
          left.set(offset, entry);
        }
        for (const [offset, { text, from }] of left)
          this.repairs.push({
            kind: "insert",
            text,
            at: slice(move.copy, offset - 1, offset)[0]!,
            after: true,
            from,
          });
      }
    }
    for (const { move } of [...found, ...again]) this.remember(move);
    return putBack;
  }

  /** Makes the planned repairs as one change of this page's own. */
  repair(doc: Y.Doc): void {
    const repairs = this.repairs;
    this.repairs = [];
    if (repairs.length === 0) return;
    doc.transact(() => {
      for (const repair of repairs) {
        if (repair.kind === "insert") {
          const item = firstItem(doc, repair.at);
          if (!item || !(item.parent instanceof Y.XmlText)) continue;
          const within = item.deleted
            ? 0
            : repair.at.clock - item.id.clock + (repair.after ? 1 : 0);
          item.parent.insert(shownBefore(item) + within, repair.text);
        }
        for (const span of repair.kind === "insert" ? repair.from : repair.spans) {
          for (let clock = span.clock; clock < span.clock + span.length;) {
            const item = firstItem(doc, { client: span.client, clock, length: 1 });
            if (!item) break;
            const end = Math.min(span.clock + span.length, item.id.clock + item.length);
            if (!item.deleted && item.parent instanceof Y.XmlText)
              item.parent.delete(shownBefore(item) + clock - item.id.clock, end - clock);
            clock = end;
          }
        }
      }
    });
  }

  /** A copy that this move takes on to another place is still the earlier move's copy. */
  private remember(move: Move): void {
    for (const known of this.moves) known.copy = carried(known.copy, move.source, move.copy);
    this.moves.push(move);
    if (this.moves.length > REMEMBERED) this.moves.shift();
  }

  /** The text a remembered move holds for these ids, or null. */
  private textOf(client: number, clock: number, length: number): string | null {
    for (const move of this.moves) {
      const at = offsetOf(move.source, client, clock, length);
      if (at >= 0) return move.text.slice(at, at + length);
    }
    return null;
  }

  /**
   * The moves in a change: each line it deleted text from, when that text stands once in what
   * the change wrote. A line that is still there counts only when its text went to a new line,
   * as a split writes it.
   */
  private read(
    transaction: Y.Transaction,
    named: DeleteSet,
    runs: readonly Run[],
  ): {
    found: Found[];
    /** Deleted lines the change's author had none of. */
    orphans: { line: Y.XmlText; unseen: Unseen[] }[];
    lines: Map<Y.XmlText, boolean>;
  } {
    // Each line the change deleted text from, and whether the line itself went.
    const lines = new Map<Y.XmlText, boolean>();
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item) || isNew(transaction, struct.id)) return;
      const content = struct.content;
      if (content instanceof Y.ContentType && content.type instanceof Y.XmlText)
        lines.set(content.type, true);
      else if (
        content instanceof Y.ContentString &&
        struct.parent instanceof Y.XmlText &&
        struct.parent._item !== null &&
        !struct.parent._item.deleted &&
        !lines.has(struct.parent)
      )
        lines.set(struct.parent, false);
    });
    const found: Found[] = [];
    const orphans: { line: Y.XmlText; unseen: Unseen[] }[] = [];
    for (const [line, gone] of lines) {
      const source = this.readLine(transaction, line, named);
      if (source === null) continue;
      if (source.text === "") {
        if (gone && source.unseen.length > 0) orphans.push({ line, unseen: source.unseen });
        continue;
      }
      const copy = placeIn(runs, source.text, (run) => !run.lines.has(line) && (gone || run.fresh));
      if (copy === null) continue;
      found.push({
        move: { source: source.spans, copy, text: source.text },
        line,
        already: source.already,
        unseen: gone ? source.unseen : [],
        behind: gone ? [] : source.behind,
      });
    }
    return { found, orphans, lines };
  }

  /** What the change's author deleted from a line, in the line's order; null when unreadable. */
  private readLine(transaction: Y.Transaction, line: Y.XmlText, named: DeleteSet) {
    const spans: Span[] = [];
    const already: [number, number][] = [];
    const unseen: Unseen[] = [];
    const behind: Unseen[] = [];
    let text = "";
    for (let item = line._start; item !== null; item = item.right) {
      const content = item.content;
      if (content instanceof Y.ContentFormat) continue;
      for (const [start, end, listed] of cut(item, named)) {
        const id = Y.createID(item.id.client, item.id.clock + start);
        const deletedNow = Y.isDeleted(transaction.deleteSet, id);
        if (!listed) {
          if (!(content instanceof Y.ContentString) || isNew(transaction, id)) continue;
          if (deletedNow) unseen.push({ item, start, end, offset: text.length });
          else if (!item.deleted && text !== "")
            behind.push({ item, start, end, offset: text.length });
          continue;
        }
        const part =
          content instanceof Y.ContentString
            ? content.str.slice(start, end)
            : content instanceof Y.ContentDeleted
              ? this.textOf(id.client, id.clock, end - start)
              : null;
        if (part === null) return null;
        if (!deletedNow) {
          const last = already.at(-1);
          if (last && last[1] === text.length) last[1] += part.length;
          else already.push([text.length, text.length + part.length]);
        }
        add(spans, id.client, id.clock, end - start);
        text += part;
      }
    }
    return { spans, text, already, unseen, behind };
  }

  /**
   * The same text stands in two copies: `known`'s from `at`, and `move`'s from `from`. Plans
   * the delete of one. Every page that sees both picks the same one, by where the copies stand
   * and by what else each holds, so that what stays reads in the source's order.
   */
  private keepOne(
    doc: Y.Doc,
    places: Places,
    known: Move,
    at: number,
    move: Move,
    from: number,
    length: number,
  ): void {
    const ours = slice(known.copy, at, at + length),
      theirs = slice(move.copy, from, from + length);
    const here = firstShown(doc, ours),
      there = firstShown(doc, theirs);
    // With one copy gone already, the text stands once.
    if (here === null || there === null) return;
    const order = comparePlaces(
      places.of({ item: here, start: 0, end: 1 }),
      places.of({ item: there, start: 0, end: 1 }),
    );
    if (order === 0) return;
    const [earlier, later] = order < 0 ? [ours, theirs] : [theirs, ours];
    const wholeOurs = at === 0 && length === known.text.length,
      wholeTheirs = from === 0 && length === move.text.length;
    const before = at > 0 || from > 0,
      after = at + length < known.text.length || from + length < move.text.length;
    // A copy that holds more keeps its text where the rest of it stands.
    const spans = !before
      ? later
      : !after
        ? earlier
        : wholeOurs
          ? ours
          : wholeTheirs
            ? theirs
            : null;
    if (spans) this.repairs.push({ kind: "delete", spans });
  }
}

/** The moved line that stands before `line` in the same block, such as a to-do's first line. */
function homeOf(line: Y.XmlText, found: readonly Found[]): Found | undefined {
  const block = line._item?.parent;
  if (!(block instanceof Y.XmlElement)) return undefined;
  for (let left = block._item?.left ?? null; left !== null; left = left.left) {
    const content = left.content;
    if (!(content instanceof Y.ContentType) || !(content.type instanceof Y.XmlElement)) continue;
    let home: Found | undefined;
    for (let child = content.type._start; child !== null; child = child.right) {
      const text = child.content instanceof Y.ContentType ? child.content.type : null;
      home = found.find((entry) => entry.line === text) ?? home;
    }
    if (home) return home;
  }
  return undefined;
}

/** `spans` with each id that stands in `from` named as the id at the same place in `to`. */
function carried(
  spans: readonly Span[],
  from: readonly Span[],
  to: readonly Span[],
): readonly Span[] {
  const next: Span[] = [];
  let changed = false;
  for (const span of spans) {
    const end = span.clock + span.length;
    for (let cursor = span.clock; cursor < end;) {
      let stop = end,
        offset = -1,
        at = 0;
      for (const piece of from) {
        if (piece.client === span.client) {
          if (piece.clock <= cursor && cursor < piece.clock + piece.length) {
            offset = at + cursor - piece.clock;
            stop = Math.min(end, piece.clock + piece.length);
            break;
          }
          if (piece.clock > cursor) stop = Math.min(stop, piece.clock);
        }
        at += piece.length;
      }
      if (offset < 0) add(next, span.client, cursor, stop - cursor);
      else {
        changed = true;
        for (const moved of slice(to, offset, offset + stop - cursor))
          add(next, moved.client, moved.clock, moved.length);
      }
      cursor = stop;
    }
  }
  return changed ? next : spans;
}

function firstItem(doc: Y.Doc, span: Span): Y.Item | null {
  const structs = doc.store.clients.get(span.client) ?? [];
  if (structs.length === 0) return null;
  const last = structs[structs.length - 1]!;
  if (span.clock >= last.id.clock + last.length) return null;
  const item = structs[Y.findIndexSS(structs, span.clock)];
  return item instanceof Y.Item ? item : null;
}

/** The stretches of `spans` that `named` lists, as offsets. */
function listed(spans: readonly Span[], named: DeleteSet): [number, number][] {
  const stretches: [number, number][] = [];
  let at = 0;
  for (const span of spans) {
    for (const range of named.clients.get(span.client) ?? []) {
      const start = Math.max(span.clock, range.clock),
        end = Math.min(span.clock + span.length, range.clock + range.len);
      if (start >= end) continue;
      const from = at + start - span.clock,
        to = at + end - span.clock;
      const last = stretches.at(-1);
      if (last && last[1] === from) last[1] = to;
      else stretches.push([from, to]);
    }
    at += span.length;
  }
  return stretches;
}
