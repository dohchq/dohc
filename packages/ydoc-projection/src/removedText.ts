import * as Y from "yjs";

type DeleteSet = ReturnType<typeof Y.decodeUpdate>["ds"];

/** The editor's inline nodes; removedText.test.ts checks this against the schema. */
export const INLINE_NODES: ReadonlySet<string> = new Set([
  "hardBreak",
  "image",
  "wikilink",
  "inlineAtom",
  "mathInline",
  "escapedPunctuation",
  "rawInline",
]);

/** Text a merged change removed without its author having seen it. */
export interface RemovedText {
  /** In note order. Lines are joined by a line break; inline items appear as their Markdown. */
  readonly text: string;
  /** The clients whose text was removed. */
  readonly clients: ReadonlySet<number>;
}

interface Piece {
  readonly item: Y.Item;
  readonly start: number;
  readonly end: number;
}

/**
 * Apply an update from someone else and return the text it removed unseen.
 *
 * Deleting a line or a text piece in Yjs also deletes, and lists in the same
 * change, every item inside it that its author had. Text the author never had
 * is deleted only here: by this merge, or as it arrives inside a line that is
 * already deleted. So the removed text is what this merge deleted and the
 * update's own delete set does not list. `named` reads that set; it runs only
 * when the merge deleted text. `keep` limits the report, for example to this
 * page's own text.
 */
export function applyUpdateFindingRemovedText(
  doc: Y.Doc,
  update: Uint8Array,
  origin: unknown,
  named: () => DeleteSet,
  keep: (item: Y.Item) => boolean,
): RemovedText | null {
  // A delete that arrived before the text it names waits here and is applied with this update.
  const waiting = doc.store.pendingDs;
  let removed: RemovedText | null = null;
  const look = (transaction: Y.Transaction) => {
    if (transaction.origin !== origin || transaction.deleteSet.clients.size === 0) return;
    // Merging also sorts each client's ranges, which `unnamed` relies on; an
    // update's own list can arrive in any order.
    removed = findRemovedText(
      transaction,
      () => Y.mergeDeleteSets(waiting ? [named(), Y.decodeUpdateV2(waiting).ds] : [named()]),
      keep,
    );
  };
  // Read inside the transaction: a doc with gc on drops deleted content right after it.
  doc.on("afterTransaction", look);
  try {
    Y.applyUpdate(doc, update, origin);
  } finally {
    doc.off("afterTransaction", look);
  }
  return removed;
}

function findRemovedText(
  transaction: Y.Transaction,
  named: () => DeleteSet,
  keep: (item: Y.Item) => boolean,
): RemovedText | null {
  const deleted: Y.Item[] = [];
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    if (struct instanceof Y.Item && holdsText(struct) && keep(struct)) deleted.push(struct);
  });
  if (deleted.length === 0) return null;
  const listed = named();
  // A piece that shows nothing, such as an embed the note never writes, is not removed text.
  const pieces = deleted
    .flatMap((item) => unnamed(item, listed).map(([start, end]) => ({ item, start, end })))
    .map((piece) => ({ piece, shown: render(piece) }))
    .filter(({ shown }) => shown !== "");
  if (pieces.length === 0) return null;
  const places = new Places();
  const sorted = pieces
    .map((entry) => ({ ...entry, line: lineOf(entry.piece.item), at: places.of(entry.piece) }))
    .sort((left, right) => compare(left.at, right.at));
  let text = "";
  let line: Y.AbstractType<unknown> | null = null;
  for (const entry of sorted) {
    if (line !== null && entry.line !== line) text += "\n";
    line = entry.line;
    text += entry.shown;
  }
  return { text, clients: new Set(pieces.map(({ piece }) => piece.item.id.client)) };
}

/** Characters, and inline items such as an image, a link or a line break. */
function holdsText(item: Y.Item): boolean {
  if (item.parentSub !== null) return false;
  const content = item.content;
  if (content instanceof Y.ContentString || content instanceof Y.ContentEmbed)
    return item.parent instanceof Y.XmlText;
  return (
    content instanceof Y.ContentType &&
    content.type instanceof Y.XmlElement &&
    INLINE_NODES.has(content.type.nodeName)
  );
}

/** The parts of an item that `named` does not cover, as offsets into it. */
function unnamed(item: Y.Item, named: DeleteSet): [number, number][] {
  const from = item.id.clock;
  const to = from + item.length;
  const ranges: [number, number][] = [];
  const listed = named.clients.get(item.id.client) ?? [];
  // `named` lists each client's ranges in clock order. Start at the first
  // that reaches this item, so many ranges cost no rescan per item.
  let low = 0;
  for (let high = listed.length; low < high;) {
    const middle = (low + high) >>> 1;
    if (listed[middle]!.clock + listed[middle]!.len <= from) low = middle + 1;
    else high = middle;
  }
  let cursor = from;
  for (let at = low; at < listed.length; at++) {
    const deleted = listed[at]!;
    if (deleted.clock >= to) break;
    if (deleted.clock > cursor) ranges.push([cursor - from, deleted.clock - from]);
    cursor = Math.max(cursor, deleted.clock + deleted.len);
  }
  if (cursor < to) ranges.push([cursor - from, to - from]);
  return ranges;
}

function lineOf(item: Y.Item): Y.AbstractType<unknown> {
  const parent = item.parent as Y.AbstractType<unknown>;
  return parent instanceof Y.XmlText ? (parent._item!.parent as Y.AbstractType<unknown>) : parent;
}

/** Note positions, counting deleted items, so removed text sorts the way it stood. */
class Places {
  private readonly indexes = new Map<Y.Item, number>();
  private readonly paths = new Map<Y.AbstractType<unknown>, number[]>();

  of(piece: Piece): number[] {
    const parent = piece.item.parent as Y.AbstractType<unknown>;
    return [...this.path(parent), this.index(piece.item) + piece.start];
  }

  private path(type: Y.AbstractType<unknown>): number[] {
    let path = this.paths.get(type);
    if (!path) {
      const item = type._item;
      path = item ? [...this.path(item.parent as Y.AbstractType<unknown>), this.index(item)] : [];
      this.paths.set(type, path);
    }
    return path;
  }

  /** The item's offset among its siblings: lengths for text, one per element. */
  private index(item: Y.Item): number {
    const index = this.indexes.get(item);
    if (index !== undefined) return index;
    // Every sibling the walk passes is kept too, so runs that arrive right
    // to left, such as typing at a line's start, walk the line once.
    const passed: Y.Item[] = [];
    let offset = 0;
    for (let left = item.left; left; left = left.left) {
      const known = this.indexes.get(left);
      if (known !== undefined) {
        offset = known + left.length;
        break;
      }
      passed.push(left);
    }
    for (const sibling of passed.reverse()) {
      this.indexes.set(sibling, offset);
      offset += sibling.length;
    }
    this.indexes.set(item, offset);
    return offset;
  }
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function render({ item, start, end }: Piece): string {
  const content = item.content;
  if (content instanceof Y.ContentString) return content.str.slice(start, end);
  // The note's Markdown writes a string embed as its text and leaves out any other.
  if (content instanceof Y.ContentEmbed)
    return typeof content.embed === "string" ? content.embed : "";
  if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
    return inline(content.type);
  return "";
}

/** A deleted element's attributes are deleted too; read the last value written. */
function attribute(element: Y.XmlElement, key: string): string {
  const item = element._map.get(key);
  const values = item ? item.content.getContent() : [];
  const value: unknown = values[values.length - 1];
  return typeof value === "string" ? value : "";
}

function inline(element: Y.XmlElement): string {
  switch (element.nodeName) {
    case "hardBreak":
      return "\n";
    case "image":
      return `![${attribute(element, "alt")}](${attribute(element, "src")})`;
    case "wikilink": {
      const label = attribute(element, "label");
      return `[[${attribute(element, "target")}${label ? `|${label}` : ""}]]`;
    }
    case "mathInline":
      return `$${attribute(element, "tex")}$`;
    case "inlineAtom":
      return `{{${attribute(element, "source") || `atom:${attribute(element, "atomId")}`}}}`;
    case "escapedPunctuation":
      return attribute(element, "value");
    case "rawInline":
      return attribute(element, "source");
    default:
      return `[${element.nodeName}]`;
  }
}

/** What a notice quotes: at most six lines and 280 characters; Copy takes the whole text. */
export function quoteRemovedText(text: string): { quoted: string; more: number } {
  let end = Math.min(text.length, 280);
  let lineBreaks = 0;
  for (let index = 0; index < end; index++) {
    if (text[index] === "\n" && ++lineBreaks === 6) end = index;
  }
  if (end >= text.length) return { quoted: text, more: 0 };
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { quoted: `${text.slice(0, end)}…`, more: text.length - end };
}
