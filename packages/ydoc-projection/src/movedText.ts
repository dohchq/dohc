import * as Y from "yjs";
import { comparePlaces, Places } from "./removedText.js";

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

interface MoveInChange {
  readonly move: Move;
  readonly line: Y.XmlText | null;
  readonly deletedEarlier: readonly (readonly [number, number])[];
  readonly neverSeenByAuthor: TextLeftInLine[];
  readonly stillInLineAfterMovedText: TextLeftInLine[];
}

type Repair =
  | { readonly kind: "delete"; readonly spans: readonly Span[] }
  | {
      readonly kind: "type";
      readonly text: string;
      readonly beside: Span;
      readonly after: boolean;
      readonly takenFrom: readonly Span[];
    };

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

const sameSpans = (left: readonly Span[], right: readonly Span[]) =>
  left.length === right.length &&
  left.every(
    (span, index) =>
      span.client === right[index]!.client &&
      span.clock === right[index]!.clock &&
      span.length === right[index]!.length,
  );

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

function* itemPieces(
  doc: Y.Doc,
  spans: readonly Span[],
): Generator<{ item: Y.Item | null; offset: number; length: number }> {
  for (const span of spans) {
    const end = span.clock + span.length;
    for (let clock = span.clock; clock < end;) {
      const item = itemAt(doc, span.client, clock);
      if (!item) {
        yield { item: null, offset: 0, length: end - clock };
        break;
      }
      const offset = clock - item.id.clock;
      const length = Math.min(end - clock, item.length - offset);
      yield { item, offset, length };
      clock += length;
    }
  }
}

const shownInLine = (item: Y.Item | Y.GC | null): item is Y.Item =>
  item instanceof Y.Item && !item.deleted && item.parent instanceof Y.XmlText;

function newTextInWritingOrder(transaction: Y.Transaction): WrittenText[] {
  const written: WrittenText[] = [];
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = transaction.doc.store.clients.get(client)!;
    let text = "";
    const spans: Span[] = [];
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index++) {
      const item = structs[index]!;
      if (!shownInLine(item) || !(item.content instanceof Y.ContentString)) continue;
      const skipped = Math.max(0, from - item.id.clock);
      text += item.content.str.slice(skipped);
      add(spans, client, item.id.clock + skipped, item.length - skipped);
    }
    if (text) written.push({ text, spans });
  }
  return written;
}

function onlyPlaceOf(
  text: string,
  written: readonly WrittenText[],
  fits: (spans: readonly Span[]) => boolean,
): readonly Span[] | null {
  let place: readonly Span[] | null = null;
  for (const { text: all, spans } of written)
    for (let at = all.indexOf(text); at >= 0; at = all.indexOf(text, at + 1)) {
      const candidate = slice(spans, at, at + text.length);
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

function deleteShown(doc: Y.Doc, spans: readonly Span[]): void {
  for (const { item, offset, length } of [...itemPieces(doc, spans)])
    if (shownInLine(item))
      (item.parent as Y.XmlText).delete(charactersShownBefore(item) + offset, length);
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

function movedLineBefore(
  line: Y.XmlText,
  moves: readonly MoveInChange[],
): MoveInChange | undefined {
  const block = line._item?.parent;
  if (!(block instanceof Y.XmlElement)) return undefined;
  for (let left = block._item?.left ?? null; left !== null; left = left.left) {
    const content = left.content;
    if (!(content instanceof Y.ContentType) || !(content.type instanceof Y.XmlElement)) continue;
    let last: MoveInChange | undefined;
    for (let child = content.type._start; child !== null; child = child.right) {
      const text = child.content instanceof Y.ContentType ? child.content.type : null;
      last = moves.find((entry) => entry.line === text) ?? last;
    }
    if (last) return last;
  }
  return undefined;
}

/**
 * Keeps a note's text once when people join, split or rebuild the same lines at the same
 * moment (#4038). Yjs cannot move text, so an editor writes such a change as a delete and a
 * fresh copy, and two of them leave the text twice or delete what the other just wrote.
 *
 * The page reads a move in each change: text deleted from a line that stands once in what the
 * same change wrote. When a change from elsewhere moves text this page knows more about, the
 * page plans a change of its own. Its own typing in the moved line is typed again at the same
 * place in the copy. Text it knows stands in two copies loses the copy that stands earlier in
 * the note, which every page agrees on, so the last copy is never deleted.
 */
export class MovedText {
  private readonly moves: Move[] = [];
  private repairs: Repair[] = [];

  /** Reads a change this page made. Call from `afterTransaction`: Yjs then drops deleted content. */
  note(transaction: Y.Transaction): void {
    if (transaction.deleteSet.clients.size === 0) return;
    const written = newTextInWritingOrder(transaction);
    if (written.length === 0) return;
    for (const { move } of this.movesIn(transaction, transaction.deleteSet, written).moves)
      this.remember(move);
  }

  /**
   * Reads a change from elsewhere inside its transaction and plans this page's repairs.
   * `named` is the change's own delete set, merged. Returns which of the page's removed text
   * the repairs put back.
   */
  follow(
    transaction: Y.Transaction,
    named: DeleteSet,
    own: (item: Y.Item) => boolean,
  ): (item: Y.Item, start: number, end: number) => boolean {
    const putBack: TextLeftInLine[] = [];
    const isPutBack = (item: Y.Item, start: number, end: number) =>
      putBack.some((text) => text.item === item && text.start <= start && end <= text.end);
    if (named.clients.size === 0) return isPutBack;
    const written = newTextInWritingOrder(transaction);
    if (written.length === 0) return isPutBack;
    const doc = transaction.doc;
    const places = new Places();
    const { moves, linesAuthorNeverSaw, linesDeletedFrom } = this.movesIn(
      transaction,
      named,
      written,
    );

    const movedAgain: Move[] = [];
    const copiesTheAuthorReplaced: Span[] = [];
    for (const known of this.moves) {
      const first = itemAt(doc, known.source[0]!.client, known.source[0]!.clock);
      if (first && linesDeletedFrom.has(first.parent as Y.XmlText)) continue;
      for (const [from, to] of offsetsListed(known.source, named)) {
        const text = known.text.slice(from, to);
        const copy = onlyPlaceOf(text, written, () => true);
        if (copy === null) continue;
        this.deleteEarlierCopy(doc, places, slice(known.copy, from, to), copy);
        copiesTheAuthorReplaced.push(...slice(known.copy, from, to));
        movedAgain.push({ source: slice(known.source, from, to), copy, text });
      }
    }
    const standsInAuthorsCopy = ({ item, start, end }: TextLeftInLine) =>
      offsetIn(copiesTheAuthorReplaced, item.id.client, item.id.clock + start, end - start) >= 0;

    for (const { line, texts } of linesAuthorNeverSaw) {
      const home = movedLineBefore(line, moves);
      if (!home) continue;
      for (const text of texts)
        home.neverSeenByAuthor.push({ ...text, sourceOffset: home.move.text.length });
    }

    for (const found of moves) {
      const { move } = found;
      for (const [from, to] of found.deletedEarlier) {
        const stretch = slice(move.source, from, to);
        for (const known of this.moves) {
          const at = offsetIn(known.source, stretch[0]!.client, stretch[0]!.clock, 1);
          if (at < 0 || !sameSpans(slice(known.source, at, at + to - from), stretch)) continue;
          this.deleteEarlierCopy(
            doc,
            places,
            slice(known.copy, at, at + to - from),
            slice(move.copy, from, to),
          );
        }
      }
      const mine = found.neverSeenByAuthor.filter(({ item }) => own(item));
      putBack.push(...mine);
      this.typeAgain(
        move,
        mine.filter((text) => !standsInAuthorsCopy(text)),
        false,
      );
      if (found.stillInLineAfterMovedText.every(({ item }) => own(item)))
        this.typeAgain(move, found.stillInLineAfterMovedText, true);
    }
    for (const move of [...moves.map((found) => found.move), ...movedAgain]) this.remember(move);
    return isPutBack;
  }

  /**
   * Makes the repairs planned since the last call, as changes of this page's own. A page that
   * may not edit now passes false, and the plans are dropped.
   */
  repair(doc: Y.Doc, mayEdit: boolean): void {
    const repairs = this.repairs;
    this.repairs = [];
    if (!mayEdit) return;
    const deletes = repairs.filter((repair) => repair.kind === "delete");
    const typed = repairs.filter((repair) => repair.kind === "type");
    if (deletes.length > 0)
      doc.transact(() => {
        for (const { spans } of deletes) deleteShown(doc, spans);
      });
    if (typed.length > 0)
      doc.transact(() => {
        for (const { text, beside, after, takenFrom } of typed) {
          const item = itemAt(doc, beside.client, beside.clock);
          if (!item || !(item.parent instanceof Y.XmlText)) continue;
          const within = item.deleted ? 0 : beside.clock - item.id.clock + (after ? 1 : 0);
          item.parent.insert(charactersShownBefore(item) + within, text);
          deleteShown(doc, takenFrom);
        }
      }, PUT_BACK_ORIGIN);
  }

  private remember(move: Move): void {
    for (const known of this.moves) known.copy = carriedOn(known.copy, move.source, move.copy);
    this.moves.push(move);
    if (this.moves.length > MOVES_REMEMBERED) this.moves.shift();
  }

  private rememberedText(client: number, clock: number, length: number): string | null {
    for (const move of this.moves) {
      const at = offsetIn(move.source, client, clock, length);
      if (at >= 0) return move.text.slice(at, at + length);
    }
    return null;
  }

  private typeAgain(move: Move, texts: readonly TextLeftInLine[], takeFromLine: boolean): void {
    const bySourceOffset = new Map<number, { text: string; takenFrom: Span[] }>();
    for (const { item, start, end, sourceOffset } of texts) {
      const entry = bySourceOffset.get(sourceOffset) ?? { text: "", takenFrom: [] };
      entry.text += (item.content as Y.ContentString).str.slice(start, end);
      if (takeFromLine) add(entry.takenFrom, item.id.client, item.id.clock + start, end - start);
      bySourceOffset.set(sourceOffset, entry);
    }
    for (const [sourceOffset, { text, takenFrom }] of bySourceOffset)
      this.repairs.push({
        kind: "type",
        text,
        beside: slice(move.copy, Math.max(0, sourceOffset - 1), Math.max(1, sourceOffset))[0]!,
        after: sourceOffset > 0,
        takenFrom,
      });
  }

  private movesIn(transaction: Y.Transaction, named: DeleteSet, written: readonly WrittenText[]) {
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
        struct.parent._item !== null &&
        !struct.parent._item.deleted &&
        !linesDeletedFrom.has(struct.parent)
      )
        linesDeletedFrom.set(struct.parent, "line stays");
    });
    const linesOf = (spans: readonly Span[]) =>
      [...itemPieces(doc, spans)].map(({ item }) => item?.parent as Y.XmlText);
    const moves: MoveInChange[] = [];
    const linesAuthorNeverSaw: { line: Y.XmlText; texts: TextLeftInLine[] }[] = [];
    for (const [line, fate] of linesDeletedFrom) {
      const gone = fate === "line gone";
      const source = this.deletedFromLine(transaction, line, named);
      if (source === null) continue;
      if (source.text === "") {
        if (gone && source.neverSeenByAuthor.length > 0)
          linesAuthorNeverSaw.push({ line, texts: source.neverSeenByAuthor });
        continue;
      }
      const copy = onlyPlaceOf(source.text, written, (spans) =>
        linesOf(spans).every(
          (other) =>
            other !== line &&
            (gone || (other._item !== null && madeByChange(transaction, other._item.id))),
        ),
      );
      if (copy === null) continue;
      moves.push({
        move: { source: source.spans, copy, text: source.text },
        line,
        deletedEarlier: source.deletedEarlier,
        neverSeenByAuthor: gone ? source.neverSeenByAuthor : [],
        stillInLineAfterMovedText: gone ? [] : source.stillInLineAfterMovedText,
      });
    }
    return { moves, linesAuthorNeverSaw, linesDeletedFrom };
  }

  private deletedFromLine(transaction: Y.Transaction, line: Y.XmlText, named: DeleteSet) {
    const spans: Span[] = [];
    const deletedEarlier: [number, number][] = [];
    const neverSeenByAuthor: TextLeftInLine[] = [];
    const stillInLineAfterMovedText: TextLeftInLine[] = [];
    let text = "";
    for (let item = line._start; item !== null; item = item.right) {
      const content = item.content;
      if (content instanceof Y.ContentFormat) continue;
      for (const [start, end, listed] of partsByListing(item, named)) {
        const id = Y.createID(item.id.client, item.id.clock + start);
        const deletedNow = Y.isDeleted(transaction.deleteSet, id);
        if (!listed) {
          if (!(content instanceof Y.ContentString) || madeByChange(transaction, id)) continue;
          const left = { item, start, end, sourceOffset: text.length };
          if (deletedNow) neverSeenByAuthor.push(left);
          else if (!item.deleted && text !== "") stillInLineAfterMovedText.push(left);
          continue;
        }
        const part =
          content instanceof Y.ContentString
            ? content.str.slice(start, end)
            : content instanceof Y.ContentDeleted
              ? this.rememberedText(id.client, id.clock, end - start)
              : null;
        if (part === null) return null;
        if (!deletedNow) {
          const last = deletedEarlier.at(-1);
          if (last && last[1] === text.length) last[1] += part.length;
          else deletedEarlier.push([text.length, text.length + part.length]);
        }
        add(spans, id.client, id.clock, end - start);
        text += part;
      }
    }
    return { spans, text, deletedEarlier, neverSeenByAuthor, stillInLineAfterMovedText };
  }

  private deleteEarlierCopy(
    doc: Y.Doc,
    places: Places,
    one: readonly Span[],
    other: readonly Span[],
  ): void {
    const left = [...itemPieces(doc, one)],
      right = [...itemPieces(doc, other)];
    const earlier: Span[] = [];
    let l = 0,
      r = 0,
      usedLeft = 0,
      usedRight = 0;
    while (l < left.length && r < right.length) {
      const a = left[l]!,
        b = right[r]!;
      const length = Math.min(a.length - usedLeft, b.length - usedRight);
      if (shownInLine(a.item) && shownInLine(b.item)) {
        const startA = a.offset + usedLeft,
          startB = b.offset + usedRight;
        const order = comparePlaces(
          places.of({ item: a.item, start: startA, end: startA + 1 }),
          places.of({ item: b.item, start: startB, end: startB + 1 }),
        );
        if (order < 0) add(earlier, a.item.id.client, a.item.id.clock + startA, length);
        else if (order > 0) add(earlier, b.item.id.client, b.item.id.clock + startB, length);
      }
      usedLeft += length;
      usedRight += length;
      if (usedLeft === a.length) {
        l++;
        usedLeft = 0;
      }
      if (usedRight === b.length) {
        r++;
        usedRight = 0;
      }
    }
    if (earlier.length > 0) this.repairs.push({ kind: "delete", spans: earlier });
  }
}
