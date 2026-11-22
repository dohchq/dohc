import * as Y from "yjs";

type DeleteSet = ReturnType<typeof Y.decodeUpdate>["ds"];

/**
 * The origin of the change that types a person's text again where its line went. An editor
 * adds it to the origins its undo tracks, so undo still takes that typing out.
 */
export const PUT_BACK_ORIGIN = Symbol("dohc.movedText.putBack");

interface Span {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
}

interface Move {
  readonly source: readonly Span[];
  copy: readonly Span[];
  readonly text: string;
}

interface WrittenText {
  readonly text: string;
  readonly spans: readonly Span[];
}

interface TextLeftInLine {
  readonly item: Y.Item;
  readonly start: number;
  readonly end: number;
  readonly sourceOffset: number;
}

interface MovedLine {
  readonly move: Move;
  readonly line: Y.XmlText;
  readonly lineIsGone: boolean;
  readonly neverSeenByAuthor: TextLeftInLine[];
}

interface PutBack {
  readonly text: string;
  readonly beside: Span;
  readonly after: boolean;
}

const MOVES_REMEMBERED = 256;

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

function offsetIn(spans: readonly Span[], client: number, clock: number, length: number): number {
  let at = 0;
  for (const span of spans) {
    if (span.client === client && span.clock <= clock && clock + length <= span.clock + span.length)
      return at + clock - span.clock;
    at += span.length;
  }
  return -1;
}

function offsetsListed(spans: readonly Span[], named: DeleteSet): [number, number][] {
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

function partsByListing(item: Y.Item, named: DeleteSet): [number, number, boolean][] {
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

const madeByChange = (transaction: Y.Transaction, id: Y.ID) =>
  id.clock >= (transaction.beforeState.get(id.client) ?? 0);

function itemAt(doc: Y.Doc, client: number, clock: number): Y.Item | null {
  const structs = doc.store.clients.get(client) ?? [];
  const last = structs.at(-1);
  if (!last || clock >= last.id.clock + last.length) return null;
  const struct = structs[Y.findIndexSS(structs, clock)];
  return struct instanceof Y.Item ? struct : null;
}

function linesOf(doc: Y.Doc, spans: readonly Span[]): (Y.XmlText | null)[] {
  const lines: (Y.XmlText | null)[] = [];
  for (const span of spans)
    for (let clock = span.clock; clock < span.clock + span.length;) {
      const item = itemAt(doc, span.client, clock);
      lines.push(item && !item.deleted && item.parent instanceof Y.XmlText ? item.parent : null);
      if (!item) break;
      clock = item.id.clock + item.length;
    }
  return lines;
}

const standsInNote = (line: Y.XmlText | null): line is Y.XmlText =>
  line !== null && line._item !== null && !line._item.deleted;

/**
 * The text a change wrote, one entry for each run its author wrote into one line. Yjs keeps
 * such a run's ids in a row, so a copy reads whole here even when its author typed into it.
 */
function writesOf(transaction: Y.Transaction): WrittenText[] {
  const writes: WrittenText[] = [];
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = transaction.doc.store.clients.get(client)!;
    let open = null as { line: Y.XmlText; text: string; spans: Span[] } | null;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index++) {
      const item = structs[index]!;
      if (item instanceof Y.Item && item.content instanceof Y.ContentFormat) continue;
      if (
        !(item instanceof Y.Item) ||
        !(item.content instanceof Y.ContentString) ||
        !(item.parent instanceof Y.XmlText)
      ) {
        open = null;
        continue;
      }
      if (open?.line !== item.parent) {
        open = { line: item.parent, text: "", spans: [] };
        writes.push(open);
      }
      const skipped = Math.max(0, from - item.id.clock);
      open.text += item.content.str.slice(skipped);
      add(open.spans, client, item.id.clock + skipped, item.length - skipped);
    }
  }
  return writes;
}

function onlyPlaceOf(
  text: string,
  writes: readonly WrittenText[],
  fits: (spans: readonly Span[]) => boolean,
): readonly Span[] | null {
  let place: readonly Span[] | null = null;
  for (const write of writes)
    for (let at = write.text.indexOf(text); at >= 0; at = write.text.indexOf(text, at + 1)) {
      const candidate = slice(write.spans, at, at + text.length);
      if (!fits(candidate)) continue;
      if (place !== null) return null;
      place = candidate;
    }
  return place;
}

function charactersShownBefore(item: Y.Item): number {
  let count = 0;
  for (let left = item.left; left !== null; left = left.left)
    if (!left.deleted && left.countable) count += left.length;
  return count;
}

function carriedOn(
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

function movedLineBefore(line: Y.XmlText, moved: readonly MovedLine[]): MovedLine | undefined {
  const block = line._item?.parent;
  if (!(block instanceof Y.XmlElement)) return undefined;
  for (let left = block._item?.left ?? null; left !== null; left = left.left) {
    const content = left.content;
    if (!(content instanceof Y.ContentType) || !(content.type instanceof Y.XmlElement)) continue;
    let last: MovedLine | undefined;
    for (let child = content.type._start; child !== null; child = child.right) {
      const text = child.content instanceof Y.ContentType ? child.content.type : null;
      last = moved.find((entry) => entry.line === text) ?? last;
    }
    if (last) return last;
  }
  return undefined;
}

/**
 * Keeps a person's text when someone else joins or rebuilds the line it is in at the same
 * moment (#4038). Yjs cannot move text, so an editor writes such a change as a delete of the
 * line and a fresh copy of its text, and what the other person just wrote into the line goes
 * with the delete.
 *
 * The page reads a move in a change from elsewhere: a deleted line whose text stands once in
 * what the same change wrote. It then plans to type its own text from that line again at the
 * same place in the copy. It never deletes anything, so it cannot remove text from the note.
 * Text it cannot place stays removed, and the caller tells the person.
 */
export class MovedText {
  private readonly ownMoves: Move[] = [];
  private planned: PutBack[] = [];

  /** Reads a change this page made. Call from `afterTransaction`: Yjs then drops deleted content. */
  note(transaction: Y.Transaction): void {
    if (transaction.deleteSet.clients.size === 0) return;
    const writes = writesOf(transaction);
    if (writes.length === 0) return;
    for (const { move } of this.movedLinesIn(transaction, transaction.deleteSet, writes).moved) {
      for (const known of this.ownMoves) known.copy = carriedOn(known.copy, move.source, move.copy);
      this.ownMoves.push(move);
      if (this.ownMoves.length > MOVES_REMEMBERED) this.ownMoves.shift();
    }
  }

  /**
   * Reads a change from elsewhere inside its transaction and plans what `repair` types again.
   * `named` is the change's own delete set, merged. Returns which of the page's removed text is
   * still in the note or planned to be: the caller leaves it out of what it tells the person.
   */
  follow(
    transaction: Y.Transaction,
    named: DeleteSet,
    own: (item: Y.Item) => boolean,
  ): (item: Y.Item, start: number, end: number) => boolean {
    const kept: TextLeftInLine[] = [];
    const isKept = (item: Y.Item, start: number, end: number) =>
      kept.some((text) => text.item === item && text.start <= start && end <= text.end);
    if (named.clients.size === 0) return isKept;
    const writes = writesOf(transaction);
    if (writes.length === 0) return isKept;
    const doc = transaction.doc;
    const { moved, linesAuthorNeverSaw } = this.movedLinesIn(transaction, named, writes);

    const ownCopiesTheAuthorAlsoWrote: Span[] = [];
    for (const known of this.ownMoves)
      for (const [from, to] of offsetsListed(known.source, named)) {
        const copy = onlyPlaceOf(known.text.slice(from, to), writes, () => true);
        if (copy !== null && linesOf(doc, copy).every(standsInNote))
          ownCopiesTheAuthorAlsoWrote.push(...slice(known.copy, from, to));
      }
    const authorWroteItToo = ({ item, start, end }: TextLeftInLine) =>
      offsetIn(ownCopiesTheAuthorAlsoWrote, item.id.client, item.id.clock + start, end - start) >=
      0;

    for (const { line, texts } of linesAuthorNeverSaw) {
      const home = movedLineBefore(line, moved);
      if (!home) continue;
      for (const text of texts)
        home.neverSeenByAuthor.push({ ...text, sourceOffset: home.move.text.length });
    }

    for (const { move, lineIsGone, neverSeenByAuthor } of moved) {
      if (!lineIsGone) continue;
      const mine = neverSeenByAuthor.filter(({ item }) => own(item));
      kept.push(...mine.filter(authorWroteItToo));
      const typedByOffset = new Map<number, string>();
      for (const left of mine.filter((text) => !authorWroteItToo(text))) {
        const { sourceOffset } = left;
        const beside = slice(move.copy, Math.max(0, sourceOffset - 1), Math.max(1, sourceOffset));
        if (!linesOf(doc, beside).every(standsInNote)) continue;
        kept.push(left);
        typedByOffset.set(
          sourceOffset,
          (typedByOffset.get(sourceOffset) ?? "") +
            (left.item.content as Y.ContentString).str.slice(left.start, left.end),
        );
      }
      for (const [sourceOffset, text] of typedByOffset)
        this.planned.push({
          text,
          beside: slice(move.copy, Math.max(0, sourceOffset - 1), Math.max(1, sourceOffset))[0]!,
          after: sourceOffset > 0,
        });
    }
    return isKept;
  }

  /**
   * Types again what `follow` planned since the last call, as one change of this page's own.
   * Returns the text it did not type, because the page may not edit now or the place is gone.
   * The caller tells the person that text was removed.
   */
  repair(doc: Y.Doc, mayEdit: boolean): string[] {
    const planned = this.planned;
    this.planned = [];
    if (planned.length === 0) return [];
    if (!mayEdit) return planned.map(({ text }) => text);
    const notTyped: string[] = [];
    doc.transact(() => {
      for (const { text, beside, after } of planned) {
        const item = itemAt(doc, beside.client, beside.clock);
        if (!item || !(item.parent instanceof Y.XmlText) || !standsInNote(item.parent)) {
          notTyped.push(text);
          continue;
        }
        const within = item.deleted ? 0 : beside.clock - item.id.clock + (after ? 1 : 0);
        item.parent.insert(charactersShownBefore(item) + within, text);
      }
    }, PUT_BACK_ORIGIN);
    return notTyped;
  }

  private rememberedText(client: number, clock: number, length: number): string | null {
    for (const move of this.ownMoves) {
      const at = offsetIn(move.source, client, clock, length);
      if (at >= 0) return move.text.slice(at, at + length);
    }
    return null;
  }

  private movedLinesIn(
    transaction: Y.Transaction,
    named: DeleteSet,
    writes: readonly WrittenText[],
  ) {
    const doc = transaction.doc;
    const linesDeletedFrom = new Map<Y.XmlText, "line gone" | "line stays">();
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item) || madeByChange(transaction, struct.id)) return;
      const content = struct.content;
      if (content instanceof Y.ContentType && content.type instanceof Y.XmlText)
        linesDeletedFrom.set(content.type, "line gone");
      else if (
        content instanceof Y.ContentString &&
        struct.parent instanceof Y.XmlText &&
        standsInNote(struct.parent) &&
        !linesDeletedFrom.has(struct.parent)
      )
        linesDeletedFrom.set(struct.parent, "line stays");
    });
    const moved: MovedLine[] = [];
    const linesAuthorNeverSaw: { line: Y.XmlText; texts: TextLeftInLine[] }[] = [];
    for (const [line, fate] of linesDeletedFrom) {
      const lineIsGone = fate === "line gone";
      const source = this.deletedFromLine(transaction, line, named);
      if (source === null) continue;
      if (source.text === "") {
        if (lineIsGone && source.neverSeenByAuthor.length > 0)
          linesAuthorNeverSaw.push({ line, texts: source.neverSeenByAuthor });
        continue;
      }
      const copy = onlyPlaceOf(source.text, writes, (spans) =>
        linesOf(doc, spans).every(
          (other) =>
            other !== line &&
            (lineIsGone ||
              (other !== null &&
                other._item !== null &&
                madeByChange(transaction, other._item.id))),
        ),
      );
      if (copy === null) continue;
      moved.push({
        move: { source: source.spans, copy, text: source.text },
        line,
        lineIsGone,
        neverSeenByAuthor: source.neverSeenByAuthor,
      });
    }
    return { moved, linesAuthorNeverSaw };
  }

  private deletedFromLine(transaction: Y.Transaction, line: Y.XmlText, named: DeleteSet) {
    const spans: Span[] = [];
    const neverSeenByAuthor: TextLeftInLine[] = [];
    let text = "";
    for (let item = line._start; item !== null; item = item.right) {
      const content = item.content;
      if (content instanceof Y.ContentFormat) continue;
      for (const [start, end, listed] of partsByListing(item, named)) {
        const id = Y.createID(item.id.client, item.id.clock + start);
        if (!listed) {
          if (
            content instanceof Y.ContentString &&
            !madeByChange(transaction, id) &&
            Y.isDeleted(transaction.deleteSet, id)
          )
            neverSeenByAuthor.push({ item, start, end, sourceOffset: text.length });
          continue;
        }
        const part =
          content instanceof Y.ContentString
            ? content.str.slice(start, end)
            : content instanceof Y.ContentDeleted
              ? this.rememberedText(id.client, id.clock, end - start)
              : null;
        if (part === null) return null;
        add(spans, id.client, id.clock, end - start);
        text += part;
      }
    }
    return { spans, text, neverSeenByAuthor };
  }
}
