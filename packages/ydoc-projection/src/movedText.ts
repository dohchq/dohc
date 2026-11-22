import * as Y from "yjs";

type DeleteSet = ReturnType<typeof Y.decodeUpdate>["ds"];

/**
 * The origin of the change that types a person's words again where their line went. An editor
 * adds it to the origins its undo tracks, so undo still takes that typing out.
 */
export const PUT_BACK_ORIGIN = Symbol("dohc.movedText.putBack");

interface Span {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
}

interface WrittenText {
  readonly text: string;
  readonly spans: readonly Span[];
}

interface TypedInLine {
  readonly item: Y.Item;
  readonly start: number;
  readonly end: number;
  readonly charactersOfLineBefore: number;
}

interface PutBack {
  readonly text: string;
  readonly beside: Span;
  readonly after: boolean;
}

const TYPED_SPANS_REMEMBERED = 4096;

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

const holds = (spans: readonly Span[], client: number, clock: number, length: number) =>
  spans.some(
    (span) =>
      span.client === client && span.clock <= clock && clock + length <= span.clock + span.length,
  );

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

const standsInNote = (line: unknown): line is Y.XmlText =>
  line instanceof Y.XmlText && line._item !== null && !line._item.deleted;

function* stringItemsWrittenBy(
  transaction: Y.Transaction,
): Generator<{ item: Y.Item | null; client: number; from: number }> {
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = transaction.doc.store.clients.get(client)!;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index++) {
      const struct = structs[index]!;
      if (struct instanceof Y.Item && struct.content instanceof Y.ContentFormat) continue;
      const text =
        struct instanceof Y.Item &&
        struct.content instanceof Y.ContentString &&
        struct.parent instanceof Y.XmlText;
      yield { item: text ? struct : null, client, from };
    }
  }
}

/**
 * The text a change wrote, one entry for each run its author wrote into one line. Yjs keeps
 * such a run's ids in a row, so a copy reads whole here even when its author typed into it.
 */
function writesOf(transaction: Y.Transaction): WrittenText[] {
  const writes: WrittenText[] = [];
  let open = null as { line: Y.XmlText; client: number; text: string; spans: Span[] } | null;
  for (const { item, client, from } of stringItemsWrittenBy(transaction)) {
    if (item === null) {
      open = null;
      continue;
    }
    if (open?.line !== item.parent || open.client !== client) {
      open = { line: item.parent as Y.XmlText, client, text: "", spans: [] };
      writes.push(open);
    }
    const skipped = Math.max(0, from - item.id.clock);
    open.text += (item.content as Y.ContentString).str.slice(skipped);
    add(open.spans, client, item.id.clock + skipped, item.length - skipped);
  }
  return writes;
}

/** Whether the characters stand in the note side by side and in this order, in one line. */
function standTogether(doc: Y.Doc, spans: readonly Span[]): boolean {
  let expected: Y.Item | null = null,
    offset = 0;
  for (const span of spans)
    for (let clock = span.clock; clock < span.clock + span.length;) {
      const item = itemAt(doc, span.client, clock);
      if (!item || item.deleted || !standsInNote(item.parent)) return false;
      const within = clock - item.id.clock;
      if (expected !== null && (item !== expected || within !== offset)) return false;
      const length = Math.min(span.clock + span.length - clock, item.length - within);
      clock += length;
      offset = within + length;
      expected = item;
      if (offset === item.length) {
        expected = item.right;
        while (expected && (expected.deleted || expected.content instanceof Y.ContentFormat))
          expected = expected.right;
        offset = 0;
      }
    }
  return true;
}

function onlyCopyOf(
  doc: Y.Doc,
  text: string,
  writes: readonly WrittenText[],
): readonly Span[] | null {
  let place: readonly Span[] | null = null;
  for (const write of writes)
    for (let at = write.text.indexOf(text); at >= 0; at = write.text.indexOf(text, at + 1)) {
      if (place !== null) return null;
      place = slice(write.spans, at, at + text.length);
    }
  return place !== null && standTogether(doc, place) ? place : null;
}

function charactersShownBefore(item: Y.Item): number {
  let count = 0;
  for (let left = item.left; left !== null; left = left.left)
    if (!left.deleted && left.countable) count += left.length;
  return count;
}

/**
 * Keeps the words a person typed into a line that someone else joins to another at the same
 * moment (#4038). Yjs cannot move text, so an editor writes a join as a delete of the line and
 * a fresh copy of its text, and words the other person just typed into the line go with the
 * delete.
 *
 * The page reads a join in a change from elsewhere: a deleted line whose text stands once, side
 * by side, in what the same change wrote. It then types its own words from that line again at
 * the same place in the copy. It does this only for words the person typed and nobody else has
 * had. Text the page wrote in a change that also deleted text, such as a line it joined itself,
 * may be a copy that others hold too, so that is left removed, as is anything the page cannot
 * place. The page never deletes.
 */
export class MovedText {
  private typed: Span[] = [];
  private planned: PutBack[] = [];

  /** Reads a change this page made. Call from `afterTransaction`. */
  note(transaction: Y.Transaction): void {
    if (transaction.deleteSet.clients.size > 0) return;
    for (const { item, client, from } of stringItemsWrittenBy(transaction)) {
      if (item === null) continue;
      const skipped = Math.max(0, from - item.id.clock);
      add(this.typed, client, item.id.clock + skipped, item.length - skipped);
    }
    if (this.typed.length > TYPED_SPANS_REMEMBERED)
      this.typed = this.typed.slice(-TYPED_SPANS_REMEMBERED);
  }

  /**
   * Reads a change from elsewhere inside its transaction, before Yjs drops deleted content, and
   * plans what `repair` types again. `named` is the change's own delete set, merged, and `own`
   * tells this page's text from other people's. Returns which removed text is planned.
   */
  follow(
    transaction: Y.Transaction,
    named: DeleteSet,
    own: (item: Y.Item) => boolean,
  ): (item: Y.Item, start: number, end: number) => boolean {
    const planned: TypedInLine[] = [];
    const isPlanned = (item: Y.Item, start: number, end: number) =>
      planned.some((typed) => typed.item === item && typed.start <= start && end <= typed.end);
    if (this.typed.length === 0 || named.clients.size === 0) return isPlanned;
    const linesGone: Y.XmlText[] = [];
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item) || madeByChange(transaction, struct.id)) return;
      const content = struct.content;
      if (content instanceof Y.ContentType && content.type instanceof Y.XmlText)
        linesGone.push(content.type);
    });
    if (linesGone.length === 0) return isPlanned;
    const writes = writesOf(transaction);
    if (writes.length === 0) return isPlanned;

    for (const line of linesGone) {
      const read = this.lineAsItsDeleterHadIt(transaction, line, named, own);
      if (read === null || read.text === "" || read.typedHere.length === 0) continue;
      const copy = onlyCopyOf(transaction.doc, read.text, writes);
      if (copy === null) continue;
      planned.push(...read.typedHere);
      const byPlace = new Map<number, string>();
      for (const { item, start, end, charactersOfLineBefore } of read.typedHere)
        byPlace.set(
          charactersOfLineBefore,
          (byPlace.get(charactersOfLineBefore) ?? "") +
            (item.content as Y.ContentString).str.slice(start, end),
        );
      for (const [before, text] of byPlace)
        this.planned.push({
          text,
          beside: slice(copy, Math.max(0, before - 1), Math.max(1, before))[0]!,
          after: before > 0,
        });
    }
    return isPlanned;
  }

  /**
   * Types again what `follow` planned since the last call, as one change of this page's own.
   * False when it typed less than was planned, because the page may not edit now or a place is
   * gone. The caller then tells the person of all the removed text.
   */
  repair(doc: Y.Doc, mayEdit: boolean): boolean {
    const planned = this.planned;
    this.planned = [];
    if (planned.length === 0) return true;
    if (!mayEdit) return false;
    let typedAll = true;
    doc.transact(() => {
      for (const { text, beside, after } of planned) {
        const item = itemAt(doc, beside.client, beside.clock);
        if (!item || item.deleted || !standsInNote(item.parent)) {
          typedAll = false;
          continue;
        }
        const within = beside.clock - item.id.clock + (after ? 1 : 0);
        item.parent.insert(charactersShownBefore(item) + within, text);
      }
    }, PUT_BACK_ORIGIN);
    return typedAll;
  }

  /**
   * The line's text as the change's author had it, and this page's words in the line that the
   * author never had. Null when the page cannot read the text, or when the author lacked text
   * of this page's in the line that is not typed words: that may stand elsewhere in the note.
   */
  private lineAsItsDeleterHadIt(
    transaction: Y.Transaction,
    line: Y.XmlText,
    named: DeleteSet,
    own: (item: Y.Item) => boolean,
  ) {
    const typedHere: TypedInLine[] = [];
    let text = "";
    for (let item = line._start; item !== null; item = item.right) {
      const content = item.content;
      if (content instanceof Y.ContentFormat) continue;
      for (const [start, end, listed] of partsByListing(item, named)) {
        const id = Y.createID(item.id.client, item.id.clock + start);
        if (listed) {
          if (!(content instanceof Y.ContentString)) return null;
          text += content.str.slice(start, end);
          continue;
        }
        if (madeByChange(transaction, id) || !Y.isDeleted(transaction.deleteSet, id)) continue;
        if (!own(item)) continue;
        if (
          !(content instanceof Y.ContentString) ||
          !holds(this.typed, id.client, id.clock, end - start)
        )
          return null;
        typedHere.push({ item, start, end, charactersOfLineBefore: text.length });
      }
    }
    return { text, typedHere };
  }
}
