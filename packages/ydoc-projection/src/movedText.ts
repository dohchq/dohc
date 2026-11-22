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
  readonly mover: number;
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

/**
 * The text a change wrote, one entry for each run its author wrote without making a line in
 * between, in writing order. Yjs keeps each such run's ids in a row, so a copy reads whole here
 * even when its author typed into it afterwards.
 */
function writesOf(transaction: Y.Transaction): WrittenText[] {
  const writes: WrittenText[] = [];
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = transaction.doc.store.clients.get(client)!;
    let open: { text: string; spans: Span[] } | null = null;
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
      if (open === null) {
        open = { text: "", spans: [] };
        writes.push(open);
      }
      const skipped = Math.max(0, from - item.id.clock);
      open.text += item.content.str.slice(skipped);
      add(open.spans, client, item.id.clock + skipped, item.length - skipped);
    }
  }
  return writes;
}

/** `copy` with each part its author deleted again named as where a later write put that text. */
function whereCopyEndedUp(
  doc: Y.Doc,
  text: string,
  copy: readonly Span[],
  laterWrites: readonly WrittenText[],
): Span[] {
  const ended: Span[] = [];
  let offset = 0;
  for (const { item, offset: within, length } of itemPieces(doc, copy)) {
    const part = text.slice(offset, offset + length);
    offset += length;
    let next: Span[] | null = null;
    if (item !== null && !shownInLine(item))
      for (const [index, write] of laterWrites.entries()) {
        const at = write.text.indexOf(part);
        if (at < 0) continue;
        next = whereCopyEndedUp(
          doc,
          part,
          slice(write.spans, at, at + part.length),
          laterWrites.slice(index + 1),
        );
        break;
      }
    if (next) for (const span of next) add(ended, span.client, span.clock, span.length);
    else if (item) add(ended, item.id.client, item.id.clock + within, length);
  }
  return ended;
}

function onlyPlaceOf(
  doc: Y.Doc,
  text: string,
  writes: readonly WrittenText[],
  fits: (spans: readonly Span[]) => boolean,
): readonly Span[] | null {
  let place: readonly Span[] | null = null;
  for (const [index, write] of writes.entries())
    for (let at = write.text.indexOf(text); at >= 0; at = write.text.indexOf(text, at + 1)) {
      const candidate = whereCopyEndedUp(
        doc,
        text,
        slice(write.spans, at, at + text.length),
        writes
          .slice(index + 1)
          .filter((later) => later.spans[0]!.client === write.spans[0]!.client),
      );
      if (!fits(candidate) || (place !== null && sameSpans(place, candidate))) continue;
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
 * place in the copy. Text it knows two people moved stands in two copies, and the copy of the
 * mover with the lower client id goes. Every page agrees on that wherever the copies have
 * since been moved on to, so the other mover's copy is never deleted.
 */
export class MovedText {
  private readonly moves: Move[] = [];
  private repairs: Repair[] = [];

  /** Reads a change this page made. Call from `afterTransaction`: Yjs then drops deleted content. */
  note(transaction: Y.Transaction): void {
    if (transaction.deleteSet.clients.size === 0) return;
    const written = writesOf(transaction);
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
    const written = writesOf(transaction);
    if (written.length === 0) return isPutBack;
    const doc = transaction.doc;
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
        const copy = onlyPlaceOf(doc, text, written, () => true);
        if (copy === null) continue;
        const again = { mover: copy[0]!.client, source: slice(known.source, from, to), copy, text };
        this.deleteLosingCopy(
          doc,
          { mover: known.mover, copy: slice(known.copy, from, to) },
          again,
        );
        copiesTheAuthorReplaced.push(...slice(known.copy, from, to));
        movedAgain.push(again);
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
          this.deleteLosingCopy(
            doc,
            { mover: known.mover, copy: slice(known.copy, at, at + to - from) },
            { mover: move.mover, copy: slice(move.copy, from, to) },
          );
        }
      }
      const mine = found.neverSeenByAuthor.filter(({ item }) => own(item));
      putBack.push(
        ...mine.filter(standsInAuthorsCopy),
        ...this.typeAgain(
          doc,
          move,
          mine.filter((text) => !standsInAuthorsCopy(text)),
          false,
        ),
      );
      if (found.stillInLineAfterMovedText.every(({ item }) => own(item)))
        this.typeAgain(doc, move, found.stillInLineAfterMovedText, true);
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

  private typeAgain(
    doc: Y.Doc,
    move: Move,
    texts: readonly TextLeftInLine[],
    takeFromLine: boolean,
  ): TextLeftInLine[] {
    const typedAgain: TextLeftInLine[] = [];
    const bySourceOffset = new Map<number, { text: string; takenFrom: Span[] }>();
    for (const left of texts) {
      const { item, start, end, sourceOffset } = left;
      const beside = slice(move.copy, Math.max(0, sourceOffset - 1), Math.max(1, sourceOffset))[0]!;
      const line = itemAt(doc, beside.client, beside.clock)?.parent;
      if (!(line instanceof Y.XmlText) || line._item === null || line._item.deleted) continue;
      typedAgain.push(left);
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
    return typedAgain;
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
      const copy = onlyPlaceOf(doc, source.text, written, (spans) =>
        linesOf(spans).every(
          (other) =>
            other !== line &&
            (gone || (other._item !== null && madeByChange(transaction, other._item.id))),
        ),
      );
      if (copy === null) continue;
      moves.push({
        move: { mover: copy[0]!.client, source: source.spans, copy, text: source.text },
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

  private deleteLosingCopy(
    doc: Y.Doc,
    one: { mover: number; copy: readonly Span[] },
    other: { mover: number; copy: readonly Span[] },
  ): void {
    if (one.mover === other.mover) return;
    const [kept, losing] = one.mover > other.mover ? [one, other] : [other, one];
    const keptPieces = [...itemPieces(doc, kept.copy)];
    const losingSpans: Span[] = [];
    let offset = 0;
    for (const { item, length } of keptPieces) {
      if (shownInLine(item))
        for (const span of slice(losing.copy, offset, offset + length))
          add(losingSpans, span.client, span.clock, span.length);
      offset += length;
    }
    if (losingSpans.length > 0) this.repairs.push({ kind: "delete", spans: losingSpans });
  }
}
