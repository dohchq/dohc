import { Fragment, Mark, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceAroundStep, ReplaceStep, Transform, type Step } from "@tiptap/pm/transform";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { keepsAttrs, keepsMarkup } from "./bodySequenceGrammar.js";
import { createBodyReader } from "./bodySequenceReading.js";
import {
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  declareBodySequence,
  holdsBodySequence,
  readsBodySequence,
} from "./bodySequenceStore.js";
import { LONE_HALF, writeNewBody } from "./bodySequenceWriter.js";
import {
  giveBoundaries,
  howToWriteOrWhy,
  sizeLimitPast,
  writeTransaction,
  type BodyWriting,
} from "./bodySequenceWriting.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import { escapeHighlightMarkdown } from "./dohc-markdown-extensions.js";
import { frontmatterYaml } from "./frontmatter.js";
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  deleteEmptyShells,
  markdownToYDoc,
  parseRichdocMarkdown,
  serializeRichdocBody,
  startsWithFrontmatter,
} from "./import-export.js";
import { bodySequenceEditRefusal } from "./liveDocumentValidation.js";

// An agent reads a live document as Markdown and edits it by replacing text in
// that Markdown. The edit reaches the Y.Doc as the smallest change to the
// blocks it touches, computed the way the editor turns a keystroke into a
// Y.Doc change. Blocks outside the edit are never parsed back from Markdown,
// so a person typing elsewhere in the document keeps their text.
//
// Each top-level block is written as Markdown on its own and the blocks are
// joined with a blank line. That keeps every block's place in the text known,
// which is what lets an edit touch only its own blocks.
//
// These functions take and return encoded Y.Doc state, so a worker can run
// them away from the thread that holds the live document.

const BLOCK_SEPARATOR = "\n\n";

// What an agent can do when its edit would lose what a person types.
export const DOCUMENT_OPEN_REFUSAL =
  "Someone may be typing in this document, here or on a device it syncs to, and this edit " +
  "would remove a block, join two blocks, or change a block's kind, such as a paragraph " +
  "into a heading. Anything they type into that block meanwhile would be lost, so nothing " +
  "changed. Instead, change only the text inside blocks and add new blocks; ask the person " +
  "to make this change; or retry after they close the document.";

const UNSAVED = "dohc can't save this edit in a live note, so nothing changed";
const SHAPE_REFUSAL = `${UNSAVED}: it would nest a block more than 64 deep, set an attribute to a value a note can't hold, or put formatting together that a note can't hold, such as a link on inline code.`;
const CHECK_REFUSAL = `${UNSAVED}: the note would be past what a live note's check reads. Ask the person to make this change in dohc.`;
const HALF_REFUSAL =
  "The edit would leave half of a character, such as half of an emoji: the text to replace " +
  "starts or ends inside one, or the replacement holds half of one. Include whole characters.";
const OUTSIDE_REFUSAL =
  "This edit would also change text outside the text to replace, such as formatting that " +
  "starts or ends inside it, or a block that reads back differently from Markdown, such as two " +
  "paragraphs in one table cell. Nothing changed. Include that text in the text to replace, or " +
  "ask the person to make this change in dohc.";
const MARKS_REFUSAL =
  "This edit changes the formatting of text outside the text to replace, such as bold or code " +
  "that starts inside it, or a link's address or title. Nothing changed. Include that text in " +
  "the text to replace: for a link, the link text.";
const STRUCTURE_REFUSAL =
  "dohc can't yet write this change to how blocks sit inside each other into a live note, such " +
  "as adding or removing a table column, editing parts of several table cells at once, or " +
  "moving a block out of a list item. Nothing changed. Change whole rows or whole blocks " +
  "instead, or ask the person to make this change in dohc.";
const UNLIKE_REFUSAL =
  "dohc couldn't write this edit into the note as asked, so nothing changed. Read the " +
  "document again and retry, or ask the person to make this change in dohc.";
const MIXED_REFUSAL =
  "dohc can't edit this note: it is marked as written in the newer note format, but its text " +
  "is still in the older one. Nothing changed.";
const limitRefusal = (limit: string) => `${UNSAVED}. ${limit} Split it into smaller edits.`;

export interface DocumentEdit {
  /** Markdown that occurs exactly once in the document. Omit it to add `replacement` at the end. */
  find?: string;
  replacement: string;
}

export interface DocumentEditOptions {
  /**
   * Someone may be typing in the document. Text typed into a block survives
   * a change to the block's text, but not the block's removal or a change of
   * its kind, so such an edit is refused. A note whose body is one sequence
   * keeps such text, so there it refuses nothing.
   */
  keepBlocks: boolean;
}

interface Layout {
  frontmatter: string;
  root: ProseMirrorNode;
  writing?: BodyWriting;
  fragment?: Y.XmlFragment;
  /** The fragment's top-level elements, and the block each one reads as. */
  elements: Y.XmlElement[];
  blocks: ProseMirrorNode[];
  /** Each block's Markdown and where it sits in the body. */
  chunks: Array<{ markdown: string; start: number; end: number }>;
  body: string;
}

type Match = { first: number; last: number; start: number; end: number };
type Unit = { pos: number; node: ProseMirrorNode; letter?: string; block: number };
type Kept = { p: number; s: number };

/** The document in `state` as the Markdown an edit matches against. */
export function documentMarkdown(state: Uint8Array): string {
  return withDoc(state, documentMarkdownOf);
}

/** The same, for a doc the caller owns. Takes a first-format doc's empty shells out. */
export function documentMarkdownOf(doc: Y.Doc): string {
  if (readsBodySequence(doc))
    return savedForm(layoutOf(doc, readBodySequence(getDohcProseMirrorSchema(), doc)));
  deleteEmptyShells(getDohcYDocBodyFragment(doc));
  return savedForm(layoutOf(doc));
}

/** A settled Markdown file as the Markdown an edit to it would match against. */
export function settledDocumentMarkdown(markdown: string): string {
  const doc = markdownToYDoc(markdown);
  try {
    return savedForm(layoutOf(doc));
  } finally {
    doc.destroy();
  }
}

// As the saved file ends: a note that isn't empty ends with one line break.
function savedForm(layout: Layout): string {
  const markdown = layout.frontmatter + layout.body.trimEnd();
  return markdown === "" || markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

/**
 * The Y.Doc update that applies `edit` to the document in `state`, or null
 * when the edit changes nothing. Throws when the edit cannot apply; the
 * message says what to do instead.
 */
export function documentEditUpdate(
  state: Uint8Array,
  edit: DocumentEdit,
  options: DocumentEditOptions,
): Uint8Array | null {
  return withDoc(state, (doc) => {
    if (holdsBodySequence(doc) && !readsBodySequence(doc)) throw new Error(MIXED_REFUSAL);
    const sequence = readsBodySequence(doc) ? doc.getText(BODY_SEQUENCE_FIELD) : null;
    const writing = sequence
      ? {
          sequence,
          reader: createBodyReader(
            getDohcProseMirrorSchema(),
            sequence,
            doc.getMap(BODY_CONTAINERS_FIELD),
          ),
        }
      : undefined;
    // withDoc deleted the empty shells before the edit starts recording, so
    // the update never carries that.
    const change = planEdit({ ...layoutOf(doc, writing?.reader.reading().doc), writing }, edit);
    if (!change) return null;
    let update: Uint8Array | null = null;
    const record = (next: Uint8Array): void => {
      update = update === null ? next : Y.mergeUpdates([update, next]);
    };
    let removesBlock = false;
    doc.on("update", record);
    try {
      if (writing) change(doc);
      else
        doc.transact((transaction) => {
          change(doc);
          if (options.keepBlocks) removesBlock = removesTextBlock(transaction);
        });
    } finally {
      doc.off("update", record);
    }
    if (removesBlock) {
      throw new Error(DOCUMENT_OPEN_REFUSAL);
    }
    if (writing && update) refuseWhatTheRoomRefuses(state, update);
    return update;
  });
}

// Frontmatter written into a body lands as blocks now and reads back as
// frontmatter from the file.
export const FRONTMATTER_REFUSAL =
  "A new document starts without frontmatter. Write its body text only.";

/**
 * The update that writes the first text into a new document. The text is
 * the body only, so frontmatter is refused.
 */
export function documentCreateUpdate(
  state: Uint8Array,
  markdown: string,
  options: DocumentEditOptions,
): Uint8Array | null {
  if (startsWithFrontmatter(markdown)) throw new Error(FRONTMATTER_REFUSAL);
  return documentEditUpdate(state, { replacement: markdown }, options);
}

function withDoc<T>(state: Uint8Array, read: (doc: Y.Doc) => T): T {
  const doc = new Y.Doc();
  try {
    declareBodySequence(doc);
    Y.applyUpdate(doc, state);
    // The blocks pair with the elements, and a reading leaves empty shells out.
    if (!readsBodySequence(doc)) deleteEmptyShells(getDohcYDocBodyFragment(doc));
    return read(doc);
  } finally {
    doc.destroy();
  }
}

// Whether the transaction deleted a type that holds text or could: every
// XmlText, and every element except a leaf such as an image or a line break.
// Deleting characters inside a text keeps what others type around them.
function removesTextBlock(transaction: Y.Transaction): boolean {
  const schema = getDohcProseMirrorSchema();
  let removes = false;
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) return;
    const type = struct.content.type;
    const leaf = type instanceof Y.XmlElement && schema.nodes[type.nodeName]?.isLeaf === true;
    if (!leaf) removes = true;
  });
  return removes;
}

function layoutOf(doc: Y.Doc, read?: ProseMirrorNode): Layout {
  const values = getDohcYDocFrontmatter(doc);
  const frontmatter =
    Object.keys(values).length > 0 ? `---\n${frontmatterYaml(values)}---\n\n` : "";
  const fragment = read ? undefined : getDohcYDocBodyFragment(doc);
  const root = read ?? yXmlFragmentToProseMirrorRootNode(fragment!, getDohcProseMirrorSchema());
  const blocks: ProseMirrorNode[] = [];
  root.forEach((block) => {
    blocks.push(block);
  });
  const elements = fragment?.toArray() ?? [];
  if (
    !read &&
    (elements.length !== blocks.length ||
      elements.some(
        (element, index) =>
          !(element instanceof Y.XmlElement) || element.nodeName !== blocks[index]!.type.name,
      ))
  ) {
    throw new Error("dohc could not read the blocks of this document.");
  }
  const chunks: Layout["chunks"] = [];
  let start = 0;
  for (const [index, block] of blocks.entries()) {
    const markdown = blockMarkdown(block, index === 0);
    chunks.push({ markdown, start, end: start + markdown.length });
    start += markdown.length + BLOCK_SEPARATOR.length;
  }
  const body = chunks.map((chunk) => chunk.markdown).join(BLOCK_SEPARATOR);
  return {
    frontmatter,
    root,
    fragment,
    elements: elements as Y.XmlElement[],
    blocks,
    chunks,
    body,
  };
}

function blockMarkdown(block: ProseMirrorNode, first: boolean): string {
  if (block.type.name === "horizontalRule") return first ? "***" : "---";
  const root = escapeHighlightMarkdown({ type: "doc", content: [block.toJSON()] });
  return serializeRichdocBody(root).replace(/\n+$/u, "");
}

function planEdit(layout: Layout, edit: DocumentEdit): ((doc: Y.Doc) => void) | null {
  const replacement = edit.replacement.replaceAll("\r\n", "\n");
  if (LONE_HALF.test(replacement)) throw new Error(HALF_REFUSAL);
  if (edit.find === undefined) {
    if (replacement.trim() === "") return null;
    // New blocks follow the last block with text, ahead of any empty
    // paragraph the person's cursor may sit in.
    let lastWithText = layout.chunks.length - 1;
    while (lastWithText >= 0 && layout.chunks[lastWithText]!.markdown === "") lastWithText -= 1;
    return blockChange(layout, lastWithText + 1, lastWithText, replacement);
  }
  const find = edit.find.replaceAll("\r\n", "\n");
  const at = uniqueMatch(savedForm(layout), find) - layout.frontmatter.length;
  if (at < 0) {
    throw new Error(
      "The text is in the document's frontmatter. Document edits change the body only.",
    );
  }
  if (find === replacement) return null;
  return planBlockEdit(layout, at, at + find.length, replacement);
}

function uniqueMatch(markdown: string, find: string): number {
  const first = markdown.indexOf(find);
  if (first < 0) {
    throw new Error(
      "The text to replace is not in the document. Read the document again and copy the text exactly.",
    );
  }
  let count = 1;
  for (let at = markdown.indexOf(find, first + 1); at >= 0; at = markdown.indexOf(find, at + 1)) {
    count += 1;
  }
  if (count > 1) {
    throw new Error(
      `The text to replace occurs ${count} times. Include more of the text around it so it occurs once.`,
    );
  }
  return first;
}

const splitsPair = (text: string, at: number) =>
  (text.charCodeAt(at - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(at) & 0xfc00) === 0xdc00;

// Rewrites the blocks that the body range [start, end) touches, counting a
// block that only meets the range at one edge. A match in a nonempty body
// always has a block at or beside it.
function planBlockEdit(
  layout: Layout,
  start: number,
  end: number,
  replacement: string,
): (doc: Y.Doc) => void {
  if (splitsPair(layout.body, start) || splitsPair(layout.body, end)) throw new Error(HALF_REFUSAL);
  const first = layout.chunks.findIndex((chunk) => chunk.end >= start);
  let last = first;
  while (last + 1 < layout.chunks.length && layout.chunks[last + 1]!.start <= end) last += 1;
  const from = Math.min(layout.chunks[first]!.start, start);
  const to = Math.max(layout.chunks[last]!.end, end);
  const markdown = layout.body.slice(from, start) + replacement + layout.body.slice(end, to);
  return blockChange(layout, first, last, markdown, start, end);
}

// Replaces blocks first..last with the blocks `markdown` parses to; with
// last < first it inserts them before block `first`. y-prosemirror then
// changes the Y.Doc into that document. Every block outside the range is
// mapped to its own element, so y-prosemirror passes over it without
// comparing it, and a block whose Markdown reads back a little differently
// is never rewritten.
function blockChange(
  layout: Layout,
  first: number,
  last: number,
  markdown: string,
  start = -1,
  end = -1,
): (doc: Y.Doc) => void {
  const schema = getDohcProseMirrorSchema();
  const note = [
    ...layout.chunks.slice(0, first).map((chunk) => chunk.markdown),
    markdown,
    ...layout.chunks.slice(last + 1).map((chunk) => chunk.markdown),
  ].join(BLOCK_SEPARATOR);
  const replacement: ProseMirrorNode[] = [];
  if (markdown.trim() !== "") {
    schema.nodeFromJSON(parseRichdocMarkdown(markdown, "source", note)).forEach((block) => {
      replacement.push(block);
    });
  }
  const blocks = [
    ...layout.blocks.slice(0, first),
    ...replacement,
    ...layout.blocks.slice(last + 1),
  ];
  const target = schema.topNodeType.createChecked(
    null,
    blocks.length > 0 ? blocks : [schema.nodes.paragraph!.create()],
  );
  const { writing } = layout;
  if (writing && !replacement.every(holdsMarkup)) throw new Error(SHAPE_REFUSAL);
  if (writing) return () => writeSequenceEdit(writing, layout, target, { first, last, start, end });
  const mapping = new Map<Y.XmlElement, ProseMirrorNode>();
  layout.elements.forEach((element, index) => {
    if (index < first || index > last) mapping.set(element, layout.blocks[index]!);
  });
  return (doc) => {
    updateYFragment(doc, layout.fragment!, target, { mapping, isOMark: new Map() });
  };
}

function writeSequenceEdit(
  writing: BodyWriting,
  layout: Layout,
  asked: ProseMirrorNode,
  match: Match,
) {
  const target = storedForm(asked);
  const before = unitsOf(layout.root);
  const wanted = unitsOf(target);
  const [from, to] = edgesOf(layout, before, match);
  const kept = middleOf(before, wanted, from, to);
  if (!kept)
    throw new Error(
      columnsChanged(layout.root, target)
        ? STRUCTURE_REFUSAL
        : middleOf(before, wanted, from, to, sameLetter)
          ? MARKS_REFUSAL
          : OUTSIDE_REFUSAL,
    );
  const attempt = (each: Kept) => {
    const transform =
      stepsTo(layout.root, target, before, wanted, each, false) ??
      stepsTo(layout.root, target, before, wanted, each, true);
    return transform && { transform, kept: each };
  };
  const lines = wholeLines(before, wanted, kept, {
    p: keepOf(before, from),
    s: before.length - to,
  });
  const found = attempt(kept) ?? (lines && attempt(lines));
  if (!found) throw new Error(STRUCTURE_REFUSAL);
  const how = howToWriteOrWhy(writing, [found.transform]);
  if ("refused" in how)
    throw new Error(how.refused === "limit" ? limitRefusal(how.limit) : STRUCTURE_REFUSAL);
  const doc = writing.sequence.doc!;
  if (how.lines.length > 0) {
    doc.transact(() => giveBoundaries(writing, how.lines));
    if (!writing.reader.reading().doc.eq(layout.root)) throw new Error(UNLIKE_REFUSAL);
  }
  const wrote = doc.transact(() =>
    how.transactions.every((each) => writeTransaction(writing, each)),
  );
  const result = readBodySequence(target.type.schema, doc);
  if (!wrote || !readsAsAsked(result, target, before, wanted, found.kept))
    throw new Error(UNLIKE_REFUSAL);
}

function refuseWhatTheRoomRefuses(state: Uint8Array, update: Uint8Array): void {
  const past = sizeLimitPast(update);
  if (past) throw new Error(limitRefusal(past));
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, state);
    const refusal = bodySequenceEditRefusal(copy, update);
    if (refusal?.limit) throw new Error(limitRefusal(refusal.limit));
    if (refusal)
      throw new Error(refusal.reason === "capacity-refused" ? CHECK_REFUSAL : UNLIKE_REFUSAL);
  } finally {
    copy.destroy();
  }
}

function unlessRangeError<T>(run: () => T, otherwise: T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError) return otherwise;
    throw error;
  }
}

function storedForm(target: ProseMirrorNode): ProseMirrorNode {
  const scratch = new Y.Doc();
  try {
    writeNewBody(target.type.schema, scratch, target, (_, at) => at.toString(36));
    return readBodySequence(target.type.schema, scratch);
  } catch (error) {
    throw error instanceof RangeError ? new Error(SHAPE_REFUSAL) : error;
  } finally {
    scratch.destroy();
  }
}

function unitsOf(root: ProseMirrorNode): Unit[] {
  const units: Unit[] = [];
  const visit = (node: ProseMirrorNode, pos: number, block: number) => {
    if (node.isText)
      for (let at = 0; at < node.text!.length; at++)
        units.push({ pos: pos + at, node, letter: node.text![at]!, block });
    else if (!node.isBlock || node.isTextblock || node.isLeaf) units.push({ pos, node, block });
  };
  root.forEach((top, offset, block) => {
    visit(top, offset, block);
    top.descendants((node, pos) => visit(node, offset + 1 + pos, block));
  });
  return units;
}

const isLine = (units: Unit[], at: number) => at >= units.length || units[at]!.node.isBlock;

const after = (unit: Unit) =>
  unit.letter !== undefined || unit.node.isTextblock ? unit.pos + 1 : unit.pos + unit.node.nodeSize;

function same(one: Unit, other: Unit): boolean {
  if (one.letter !== undefined)
    return one.letter === other.letter && Mark.sameSet(one.node.marks, other.node.marks);
  if (one.node.isBlock && other.node.isBlock)
    return (one.node.isTextblock && other.node.isTextblock) || one.node.eq(other.node);
  return other.letter === undefined && !other.node.isBlock && one.node.eq(other.node);
}

const sameLetter = (one: Unit, other: Unit) =>
  one.letter === undefined ? same(one, other) : one.letter === other.letter;

function edgesOf(layout: Layout, units: Unit[], match: Match): [number, number] {
  const base = (block: number) => {
    const at = units.findIndex((unit) => unit.block >= block);
    return at < 0 ? units.length : at;
  };
  if (match.start < 0) return [base(match.first), base(match.first)];
  let code = 0xe000;
  while (layout.body.includes(String.fromCharCode(code))) code += 1;
  const marker = String.fromCharCode(code);
  const { schema } = layout.root.type;
  const probed = (unit: Unit, from: number, to: number, put: ProseMirrorNode) => {
    const { start } = layout.chunks[unit.block]!;
    const root = unlessRangeError(
      () => layout.root.replace(from, to, new Slice(Fragment.from(put), 0, 0)),
      null,
    );
    const markdown = root ? blockMarkdown(root.child(unit.block), unit.block === 0) : "";
    const at = markdown.indexOf(marker);
    const exact =
      at >= 0 &&
      at === markdown.lastIndexOf(marker) &&
      markdown.slice(0, at) === layout.body.slice(start, start + at);
    return exact ? start + at : -1;
  };
  const contentOf = (unit: Unit) => probed(unit, unit.pos + 1, unit.pos + 1, schema.text(marker));
  const startOf = (at: number): number => {
    const unit = units[at]!;
    if (unit.node.isTextblock) {
      const content = contentOf(unit);
      if (content >= 0) return content;
      return units[at + 1]?.block === unit.block ? startOf(at + 1) : layout.chunks[unit.block]!.end;
    }
    const end = unit.pos + (unit.letter === undefined ? unit.node.nodeSize : 1);
    const text = schema.text(marker, unit.node.isBlock ? [] : unit.node.marks);
    const put = unit.node.isBlock ? schema.nodes.paragraph!.create(null, text) : text;
    const replaced = probed(unit, unit.pos, end, put);
    const found =
      replaced >= 0 || unit.node.isBlock ? replaced : probed(unit, unit.pos, unit.pos, text);
    if (found < 0) throw new Error(OUTSIDE_REFUSAL);
    return found;
  };
  const endOf = (at: number): number => {
    const unit = units[at]!;
    if (!unit.node.isTextblock) return startOf(at) + 1;
    const content = contentOf(unit);
    if (content >= 0) return content;
    return at > base(unit.block) ? endOf(at - 1) : layout.chunks[unit.block]!.start;
  };
  const firstIn = (block: number, test: (at: number) => boolean) => {
    let [low, high] = [base(block), base(block + 1)];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (test(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  return [
    firstIn(match.first, (at) => endOf(at) > match.start),
    firstIn(match.last, (at) => startOf(at) >= match.end),
  ];
}

function middleOf(
  before: Unit[],
  wanted: Unit[],
  from: number,
  to: number,
  alike = same,
): Kept | null {
  const [n, m] = [before.length, wanted.length];
  const least = Math.min(n, m);
  let p = 0;
  while (p < least && alike(before[p]!, wanted[p]!)) p += 1;
  if (p > 0 && /[\uD800-\uDBFF]/u.test(before[p - 1]!.letter ?? "")) p -= 1;
  let s = 0;
  while (s < least && alike(before[n - 1 - s]!, wanted[m - 1 - s]!)) s += 1;
  if (s > 0 && /[\uDC00-\uDFFF]/u.test(before[n - s]!.letter ?? "")) s -= 1;
  const keep = keepOf(before, from);
  if (p < keep || s < n - to || m < keep + n - to) return null;
  p = Math.min(p, least - (n - to));
  s = Math.min(s, least - p);
  if (p + s === least && n !== m) {
    const [long, size] = n > m ? [before, n] : [wanted, m];
    let most = 0;
    while (most < p - keep && alike(long[p - 1 - most]!, long[size - s - 1 - most]!)) most += 1;
    for (let slid = 0; slid <= most; slid++)
      if (isLine(long, p - slid) && isLine(long, size - s - slid))
        return { p: p - slid, s: s + slid };
  }
  return { p, s };
}

const keepOf = (before: Unit[], from: number) =>
  from > 0 && before[from - 1]!.node.isBlock ? from - 1 : from;

function wholeLines(before: Unit[], wanted: Unit[], { p, s }: Kept, least: Kept): Kept | null {
  const [n, m] = [before.length, wanted.length];
  while (p > 0 && !(isLine(before, p) && isLine(wanted, p))) p -= 1;
  while (s > 0 && !(isLine(before, n - s) && isLine(wanted, m - s))) s -= 1;
  return p >= least.p && s >= least.s ? { p, s } : null;
}

function columnsChanged(root: ProseMirrorNode, target: ProseMirrorNode): boolean {
  const columnsOf = (node: ProseMirrorNode) => {
    const columns: number[] = [];
    node.descendants((each) => {
      if (each.type.spec.tableRole === "table") columns.push(each.firstChild?.childCount ?? 0);
    });
    return columns;
  };
  const [was, now] = [columnsOf(root), columnsOf(target)];
  return was.length === now.length && was.some((count, at) => count !== now[at]);
}

const tried = (transform: Transform, step: Step) =>
  unlessRangeError(() => !transform.maybeStep(step).failed, false);

function eachLine(root: ProseMirrorNode, visit: (line: ProseMirrorNode, pos: number) => void) {
  root.descendants((node, pos) => {
    if (node.isBlock && (node.isTextblock || node.isLeaf)) visit(node, pos);
    return !node.isTextblock;
  });
}

function linesOf(root: ProseMirrorNode): ProseMirrorNode[] {
  const lines: ProseMirrorNode[] = [];
  eachLine(root, (line) => lines.push(line));
  return lines;
}

const holdsMarkup = (node: ProseMirrorNode): boolean =>
  (node.isText
    ? keepsMarkup(node)
    : [node, ...node.marks].every((each) => keepsAttrs(each.type, each.attrs))) &&
  node.children.every(holdsMarkup);

const TABLE_PARTS = new Set(["row", "cell", "header_cell"]);

function withLines(node: ProseMirrorNode, lines: ProseMirrorNode[], at = { next: 0 }) {
  if (node.isTextblock || node.isLeaf) return lines[at.next++]!;
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => children.push(withLines(child, lines, at)));
  return node.type.createChecked(node.attrs, children, node.marks);
}

function widened(root: ProseMirrorNode, from: number, to: number): number {
  const $from = root.resolve(from);
  let depth = $from.depth;
  for (; depth > 0 && from === $from.start(depth) && $from.after(depth) <= to; depth--)
    from = $from.before(depth);
  return from;
}

function stepsTo(
  root: ProseMirrorNode,
  target: ProseMirrorNode,
  before: Unit[],
  wanted: Unit[],
  { p, s }: Kept,
  early: boolean,
): Transform | null {
  const transform = new Transform(root);
  const [n, m] = [before.length, wanted.length];
  const whole =
    isLine(before, p) && isLine(wanted, p) && isLine(before, n - s) && isLine(wanted, m - s);
  const lifted = (doc: ProseMirrorNode, pos: number) => {
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0 && pos === $pos.start(depth); depth--) {
      if (!TABLE_PARTS.has($pos.node(depth).type.spec.tableRole)) break;
      pos = $pos.before(depth);
    }
    return pos;
  };
  const at = (units: Unit[], doc: ProseMirrorNode, gap: number) =>
    whole
      ? lifted(doc, units[gap]?.pos ?? doc.content.size)
      : gap === 0
        ? 0
        : after(units[gap - 1]!);
  const lines = linesOf(target);
  const kind = (node: ProseMirrorNode, pos: number, want: ProseMirrorNode | undefined) => {
    if (!want || node.isLeaf || node.sameMarkup(want) || !want.type.validContent(node.content))
      return;
    const wrap = Fragment.from(want.type.create(want.attrs, null, want.marks));
    const end = pos + node.nodeSize;
    tried(
      transform,
      new ReplaceAroundStep(pos, end, pos + 1, end - 1, new Slice(wrap, 0, 0), 1, true),
    );
  };
  const kinds = () => {
    let index = 0;
    eachLine(transform.doc, (line, pos) => kind(line, pos, lines[index++]));
  };
  if (early) {
    const shift = lines.length - linesOf(root).length;
    let line = 0;
    before.forEach(({ node, pos }, index) => {
      if (!node.isBlock) return;
      kind(node, pos, index < p ? lines[line] : index >= n - s ? lines[line + shift] : undefined);
      line += 1;
    });
  }
  const slice = target.slice(at(wanted, target, p), at(wanted, target, m - s));
  const [from, to] = [at(before, root, p), at(before, root, n - s)];
  transform.replace(whole && slice.size === 0 ? widened(root, from, to) : from, to, slice);
  const now = unitsOf(transform.doc);
  if (now.length !== m || now.some((unit, index) => !same(unit, wanted[index]!))) return null;
  kinds();
  const rebuilt = unlessRangeError(() => withLines(target, linesOf(transform.doc)), null);
  if (!rebuilt) return null;
  const start = transform.doc.content.findDiffStart(rebuilt.content);
  if (start !== null) {
    let { a, b } = transform.doc.content.findDiffEnd(rebuilt.content)!;
    const overlap = start - Math.min(a, b);
    if (overlap > 0) [a, b] = [a + overlap, b + overlap];
    if (!tried(transform, new ReplaceStep(start, a, rebuilt.slice(start, b)))) return null;
  }
  kinds();
  return transform;
}

const unmarked = (node: ProseMirrorNode) =>
  Fragment.fromArray(node.children.map((child) => (child.isText ? child.mark([]) : child)));

function readsAsAsked(
  result: ProseMirrorNode,
  target: ProseMirrorNode,
  before: Unit[],
  wanted: Unit[],
  { p, s }: Kept,
): boolean {
  const shown = linesOf(result);
  const lines = linesOf(target);
  if (shown.length !== lines.length) return false;
  const wasCode = wanted
    .map((_, at) =>
      at < p ? at : at >= wanted.length - s ? at - wanted.length + before.length : -1,
    )
    .filter((_, at) => wanted[at]!.node.isBlock)
    .map((at) => at >= 0 && before[at]!.node.type.spec.code === true);
  const expected = lines.map((line, index) => {
    const read = shown[index]!;
    const kept = wasCode[index] && read.sameMarkup(line) && unmarked(read).eq(unmarked(line));
    return kept ? read : line;
  });
  return unlessRangeError(() => result.eq(withLines(target, expected)), false);
}
