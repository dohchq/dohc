import { Mark, type Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  type Step,
  type StepMap,
} from "@tiptap/pm/transform";
import * as Y from "yjs";
import { BLOCK_ELEMENT } from "./bodySequenceGrammar.js";
import {
  blockHolding,
  blockStartingAt,
  isAddedParagraph,
  countBelow,
  boundaryAt,
  boundaryElement,
  indexAt,
  pathAt,
  tokenBefore,
  tokenFrom,
  tokenIn,
  type BodyReader,
  type BodyReading,
  type SequenceElement,
} from "./bodySequenceReading.js";

export type BodyWriting = { sequence: Y.Text; reader: BodyReader };

type Token =
  | { letters: string; marks: readonly Mark[] }
  | { item: ProseMirrorNode }
  | { block: ProseMirrorNode };
type Attributes = Record<string, unknown>;
type Change = {
  retain?: number;
  delete?: number;
  insert?: string | SequenceElement;
  attributes?: Attributes;
};

const holdsBlocks = (node: ProseMirrorNode) => node.isBlock && !node.isTextblock && !node.isLeaf;
const holdsNoBlocks = (node: ProseMirrorNode) => node.isBlock && (node.isTextblock || node.isLeaf);

function replaces(map: StepMap): boolean {
  let found = false;
  map.forEach(() => {
    found = true;
  });
  return found;
}

const LIST_ITEMS: ReadonlySet<string> = new Set(["listItem", "taskItem"]);

function isInFirstBlockOfItem(doc: ProseMirrorNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.depth < 2) return false;
  const item = $pos.depth - 1;
  return LIST_ITEMS.has($pos.node(item).type.name) && $pos.index(item) === 0;
}

function startsBlock(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (holdsNoBlocks(node) && pos >= from) found = true;
    return !found && !node.isInline && !node.isTextblock;
  });
  return found;
}

/**
 * Whether a step leaves every list, quote, callout and table as it is: it starts none, changes
 * none, and removes one only whole. The sequence takes such a step with no change to a path or to
 * a container record. Any other step is refused until container changes are written here, by the
 * container writer's operations.
 *
 * A step that removes the last line between two containers is one of those when the two share an
 * id: they would read as one. The container writer first gives the later one a fresh id, and
 * that write goes here too. `shareAnId` says whether the container that ends at one place of
 * `before` and the one that starts at another share an id.
 *
 * So is a step that splits the first block of a list item: section 4 gives the new line a new
 * item, with a fresh id and its records. A split of a later block stays in its item and is taken.
 */
export function keepsContainers(
  step: Step,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  shareAnId: (endOfUpper: number, startOfLower: number) => boolean,
): boolean {
  let kept = true;
  let replaced = false;
  step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
    replaced = true;
    if (isInFirstBlockOfItem(before, oldStart) && startsBlock(after, newStart, newEnd))
      kept = false;
    if (newStart === newEnd) {
      const $joint = after.resolve(newStart);
      const upper = $joint.nodeBefore;
      const lower = $joint.nodeAfter;
      if (upper && lower && holdsBlocks(upper) && holdsBlocks(lower) && shareAnId(oldStart, oldEnd))
        kept = false;
    }
    before.nodesBetween(oldStart, oldEnd, (node, pos) => {
      if (holdsBlocks(node) && pos >= oldStart !== pos + node.nodeSize <= oldEnd) kept = false;
      return kept && !node.isTextblock;
    });
    after.nodesBetween(newStart, newEnd, (node, pos) => {
      if (holdsBlocks(node) && (pos >= newStart || pos + node.nodeSize <= newEnd)) kept = false;
      return kept && !node.isTextblock;
    });
  });
  if (!replaced && step instanceof AttrStep) {
    const node = before.nodeAt(step.pos);
    if (node && holdsBlocks(node)) kept = false;
  }
  return kept;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

function splitsPair(doc: ProseMirrorNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  const before = $pos.nodeBefore?.text;
  const after = $pos.nodeAfter?.text;
  return (
    before !== undefined &&
    after !== undefined &&
    isHighSurrogate(before.charCodeAt(before.length - 1)) &&
    isLowSurrogate(after.charCodeAt(0))
  );
}

/**
 * Whether a step leaves every surrogate pair whole: it inserts, deletes, splits and formats
 * nowhere between the two units of one. A step that does not is refused.
 */
export function keepsPairs(step: Step, before: ProseMirrorNode): boolean {
  let kept = true;
  step.getMap().forEach((oldStart, oldEnd) => {
    if (splitsPair(before, oldStart) || splitsPair(before, oldEnd)) kept = false;
  });
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep)
    kept = !splitsPair(before, step.from) && !splitsPair(before, step.to);
  return kept;
}

function tokensBetween(doc: ProseMirrorNode, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const letters = node.text!.slice(Math.max(from, pos) - pos, to - pos);
      tokens.push({ letters, marks: node.marks });
    } else if (node.isInline) tokens.push({ item: node });
    else if (holdsNoBlocks(node) && pos >= from) tokens.push({ block: node });
    return !node.isInline;
  });
  return tokens;
}

type Unit = { key: string; pos: number };
const BLOCK_START = "\0";

function unitsBetween(doc: ProseMirrorNode, from: number, to: number): Unit[] {
  const units: Unit[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const first = Math.max(from, pos);
      const letters = node.text!.slice(first - pos, to - pos);
      for (let at = 0; at < letters.length; at++)
        units.push({ key: letters[at]!, pos: first + at });
    } else if (node.isInline) units.push({ key: `\0${node.type.name}`, pos });
    else if (holdsNoBlocks(node) && pos >= from) units.push({ key: BLOCK_START, pos });
    return !node.isInline;
  });
  return units;
}

function sameValue(one: unknown, other: unknown): boolean {
  if (one === other) return true;
  if (!Array.isArray(one) || !Array.isArray(other) || one.length !== other.length) return false;
  return one.every((value, at) => sameValue(value, other[at]));
}

function samePath(one: readonly string[], other: readonly string[]): boolean {
  return one.length === other.length && one.every((id, at) => id === other[at]);
}

function markAttributes(marks: readonly Mark[]): Attributes {
  return Object.fromEntries(marks.map((mark) => [mark.type.name, { ...mark.attrs }]));
}

function markChange(was: readonly Mark[], now: readonly Mark[]): Attributes {
  const change: Attributes = {};
  for (const mark of was)
    if (!now.some((other) => other.type === mark.type)) change[mark.type.name] = null;
  for (const mark of now) if (!mark.isInSet(was)) change[mark.type.name] = { ...mark.attrs };
  return change;
}

function formattingInForceAfter(sequence: Y.Text, index: number): Attributes {
  const formatting = new Map<string, unknown>();
  let left = index;
  for (let item = sequence._start; item !== null && left > 0; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (!(content instanceof Y.ContentFormat)) left -= item.length;
    else if (content.value === null) formatting.delete(content.key);
    else formatting.set(content.key, content.value);
  }
  return Object.fromEntries(formatting);
}

function elementFor(name: string, attributes: ProseMirrorNode["attrs"]): SequenceElement {
  const element: SequenceElement = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

const boundaryFor = (block: ProseMirrorNode, path: readonly string[]) =>
  elementFor(BLOCK_ELEMENT, { type: block.type.name, ...block.attrs, path: [...path] });

function setAttribute(
  element: SequenceElement,
  key: string,
  value: object | string | number | boolean | null,
): void {
  if (!sameValue(element.getAttribute(key), value)) element.setAttribute(key, value);
}

function setBoundary(
  element: SequenceElement,
  was: ProseMirrorNode,
  now: ProseMirrorNode,
  path: readonly string[] | null,
): void {
  const sameKind = was.type === now.type;
  if (!sameKind) setAttribute(element, "type", now.type.name);
  for (const [key, value] of Object.entries(now.attrs))
    if (!sameKind || !sameValue(was.attrs[key], value)) setAttribute(element, key, value);
  if (path) setAttribute(element, "path", [...path]);
}

function setItem(element: SequenceElement, now: ProseMirrorNode): void {
  for (const [key, value] of Object.entries(now.attrs)) setAttribute(element, key, value);
}

function apply(sequence: Y.Text, changes: Change[]): void {
  if (changes.every((change) => change.retain !== undefined && !change.attributes)) return;
  sequence.applyDelta(changes);
}

function inserts(tokens: readonly Token[], path: readonly string[], inForce: Attributes): Change[] {
  return tokens.map((token) => {
    if ("letters" in token)
      return { insert: token.letters, attributes: markAttributes(token.marks) };
    const element =
      "block" in token
        ? boundaryFor(token.block, path)
        : elementFor(token.item.type.name, { ...token.item.attrs });
    return { insert: element, attributes: inForce };
  });
}

const retain = (count: number): Change[] => (count > 0 ? [{ retain: count }] : []);

function insertBoundary(
  writing: BodyWriting,
  index: number,
  block: ProseMirrorNode,
  path: readonly string[],
): void {
  writing.reader.touch(index - 1, index);
  apply(writing.sequence, [
    ...retain(index),
    {
      insert: boundaryFor(block, path),
      attributes: formattingInForceAfter(writing.sequence, index),
    },
  ]);
}

function placeForBoundaryOf(reading: BodyReading, block: number): number {
  const line = reading.lines[block];
  if (!line?.element) return 0;
  return reading.bases[block]! + (reading.blocks[block]!.shown[0]?.index ?? 0);
}

function isParagraphAfterItsLeaf(reading: BodyReading, block: number): boolean {
  return (
    block < reading.blocks.length && reading.lines[block]?.read?.after === reading.blocks[block]
  );
}

function readerAddedParagraphBefore(reading: BodyReading, block: number, from: number): boolean {
  const added = block - 1;
  return (
    added >= 0 &&
    reading.lines[added] === reading.lines[block] &&
    isAddedParagraph(reading, added) &&
    reading.starts[added]! < from
  );
}

function needsOwnBoundaryFirst(
  reading: BodyReading,
  holder: number,
  atStart: boolean,
  tokens: readonly Token[],
): boolean {
  if (holder < 0 || tokens.length === 0 || boundaryAt(reading, holder) >= 0) return false;
  if (reading.blocks[holder]!.node.content.size === 0) return reading.paths[holder]!.length > 0;
  if (!atStart) return false;
  if (tokens.some((token) => "block" in token)) return true;
  const own = reading.lines[holder]?.read?.own.node;
  return (
    isParagraphAfterItsLeaf(reading, holder) && own?.isTextblock === true && "letters" in tokens[0]!
  );
}

function writeRange(
  writing: BodyWriting,
  after: ProseMirrorNode,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void {
  const { sequence, reader } = writing;
  const tokens = tokensBetween(after, newStart, newEnd);
  const paragraph = after.type.schema.nodes.paragraph!.create();
  let reading = reader.reading();
  const holder = blockHolding(reading, oldStart);
  const startsBlock = tokens.some((token) => "block" in token);
  const atStart = holder >= 0 && oldStart === reading.starts[holder]! + 1;
  const hasText = holder >= 0 && reading.blocks[holder]!.node.content.size > 0;

  if (needsOwnBoundaryFirst(reading, holder, atStart, tokens)) {
    insertBoundary(writing, placeForBoundaryOf(reading, holder), paragraph, reading.paths[holder]!);
    reading = reader.reading();
  }

  const first = tokenFrom(reading, oldStart);
  const last = tokenBefore(reading, oldEnd);
  const replaced = first !== null && last !== null && last.index >= first.index;

  if (!replaced && atStart && hasText && startsBlock && boundaryAt(reading, holder) >= 0) {
    const boundary = boundaryAt(reading, holder);
    const path = reading.paths[holder]!;
    const lastStart = tokens.findLastIndex((token) => "block" in token);
    const ending = tokens[lastStart]!;
    const $new = after.resolve(newStart);
    const upper = $new.parent.isTextblock ? $new.parent : ($new.nodeBefore ?? paragraph);
    const before: Token[] = [{ block: upper }, ...tokens.slice(0, lastStart)];
    const behind = tokens.slice(lastStart + 1);
    reader.touch(boundary - 1, boundary + 1);
    const changes = [
      ...retain(boundary),
      ...inserts(before, path, formattingInForceAfter(sequence, boundary)),
    ];
    if (behind.length > 0)
      changes.push(
        { retain: 1 },
        ...inserts(behind, path, formattingInForceAfter(sequence, boundary + 1)),
      );
    apply(sequence, changes);
    if ("block" in ending)
      setBoundary(
        boundaryElement(reading, holder)!,
        reading.blocks[holder]!.node,
        ending.block,
        null,
      );
    return;
  }

  if (!replaced && tokens.length === 0) return;
  let index = replaced ? first.index : indexAt(reading, oldStart);
  let count = replaced ? last.index - first.index + 1 : 0;
  let rest = tokens;
  reader.touch(index - 1, index + count);
  const start = rest[0];
  const startsWithBlock = start !== undefined && "block" in start;
  if (
    replaced &&
    first.piece === null &&
    (startsWithBlock || readerAddedParagraphBefore(reading, first.block, oldStart))
  ) {
    const path = pathAt(reading, oldStart);
    setBoundary(
      boundaryElement(reading, first.block)!,
      reading.blocks[first.block]!.node,
      startsWithBlock ? start.block : paragraph,
      samePath(path, reading.paths[first.block]!) ? null : path,
    );
    if (startsWithBlock) rest = rest.slice(1);
    index += 1;
    count -= 1;
  } else if (replaced && count === 1 && rest.length === 1 && start && "item" in start) {
    const element = first.piece?.element;
    if (element && element.nodeName === start.item.type.name) {
      setItem(element, start.item);
      return;
    }
  }
  const kept = countBelow(reading.starts, oldEnd);
  if (isParagraphAfterItsLeaf(reading, kept) && count > 0) {
    const held = reading.bases[kept]!;
    if (held >= index && held < index + count)
      insertBoundary(writing, placeForBoundaryOf(reading, kept), paragraph, reading.paths[kept]!);
  }
  const needsInForce = rest.some((token) => !("letters" in token));
  apply(sequence, [
    ...retain(index),
    ...inserts(
      rest,
      startsBlock ? pathAt(reading, oldStart) : [],
      needsInForce ? formattingInForceAfter(sequence, index) : {},
    ),
    ...(count > 0 ? [{ delete: count }] : []),
  ]);
}

function cutsNoContainer(doc: ProseMirrorNode, from: number, to: number): boolean {
  let whole = true;
  doc.nodesBetween(from, to, (node, pos) => {
    if (holdsBlocks(node) && (pos >= from || pos + node.nodeSize <= to)) whole = false;
    return whole && !node.isTextblock;
  });
  return whole;
}

function writeBlockStartsThatDiffer(writing: BodyWriting, after: ProseMirrorNode): boolean {
  for (let attempt = 0; attempt < 4; attempt++) {
    const read = writing.reader.reading().doc;
    const start = read === after ? null : read.content.findDiffStart(after.content);
    if (start === null) {
      writing.reader.adopt(after);
      return true;
    }
    let { a, b } = read.content.findDiffEnd(after.content)!;
    const overlap = start - Math.min(a, b);
    if (overlap > 0) {
      a += overlap;
      b += overlap;
    }
    const stored = unitsBetween(read, start, a);
    const wanted = unitsBetween(after, start, b);
    const most = Math.min(stored.length, wanted.length);
    let lead = 0;
    while (lead < most && stored[lead]!.key === wanted[lead]!.key) lead++;
    let tail = 0;
    while (
      lead + tail < most &&
      stored[stored.length - 1 - tail]!.key === wanted[wanted.length - 1 - tail]!.key
    )
      tail++;
    const gone = stored.slice(lead, stored.length - tail);
    const come = wanted.slice(lead, wanted.length - tail);
    if (gone.length === 0 && come.length === 0) return true;
    const oldEnd = tail > 0 ? stored[stored.length - tail]!.pos : a;
    const newEnd = tail > 0 ? wanted[wanted.length - tail]!.pos : b;
    const oldStart = gone[0]?.pos ?? oldEnd;
    const newStart = come[0]?.pos ?? newEnd;
    const starts = (units: readonly Unit[]) => units.every((unit) => unit.key === BLOCK_START);
    const adds = gone.length === 0 && starts(come) && cutsNoContainer(after, newStart, newEnd);
    const drops = come.length === 0 && starts(gone) && cutsNoContainer(read, oldStart, oldEnd);
    if (!adds && !drops) return false;
    writeRange(writing, after, oldStart, oldEnd, newStart, newEnd);
  }
  return false;
}

function changedBlocks(
  was: Fragment,
  now: Fragment,
  pos: number,
  visit: (was: ProseMirrorNode, now: ProseMirrorNode, pos: number) => void,
): void {
  if (was.childCount !== now.childCount) return;
  for (let at = 0, start = pos; at < now.childCount; at++) {
    const one = was.child(at);
    const other = now.child(at);
    if (one !== other && one.nodeSize === other.nodeSize) {
      if (holdsNoBlocks(other)) visit(one, other, start);
      else changedBlocks(one.content, other.content, start + 1, visit);
    }
    start += other.nodeSize;
  }
}

type Formatting = { index: number; length: number; key: string; change: Attributes; open: number };

function writeFormatting(writing: BodyWriting, was: ProseMirrorNode, now: ProseMirrorNode): void {
  const { sequence, reader } = writing;
  const reading = reader.reading();
  const ranges: Formatting[] = [];
  const starts: { index: number; block: ProseMirrorNode; path: readonly string[] }[] = [];
  let held: Formatting | null = null;
  const takesNoMarks = (index: number) => {
    if (held?.open === index) held.open = index + 1;
  };
  const letters = (index: number, length: number, change: Attributes) => {
    const key = JSON.stringify(change);
    if (held?.key === key && held.open === index) {
      held.length = index + length - held.index;
      held.open = index + length;
      return;
    }
    held = { index, length, key, change, open: index + length };
    ranges.push(held);
  };

  changedBlocks(was.content, now.content, 0, (before, block, pos) => {
    const at = blockStartingAt(reading, pos);
    if (at < 0) return;
    const boundary = boundaryAt(reading, at);
    if (boundary >= 0) takesNoMarks(boundary);
    if (!before.sameMarkup(block)) {
      if (boundary < 0)
        starts.push({ index: placeForBoundaryOf(reading, at), block, path: reading.paths[at]! });
      else {
        reader.touch(boundary, boundary);
        setBoundary(boundaryElement(reading, at)!, reading.blocks[at]!.node, block, null);
      }
    }
    if (!block.isTextblock || before.childCount === 0 || block.childCount === 0) return;
    let one = 0;
    let other = 0;
    let usedOne = 0;
    let usedOther = 0;
    for (let offset = 0; one < before.childCount && other < block.childCount;) {
      const left = before.child(one);
      const right = block.child(other);
      const length = Math.min(left.nodeSize - usedOne, right.nodeSize - usedOther);
      if (!right.isText) {
        const token = tokenIn(reading, at, offset);
        takesNoMarks(token.index);
        const element = token.piece?.element;
        const differs = ([key, value]: [string, unknown]) => !sameValue(left.attrs[key], value);
        if (element && left.type === right.type && Object.entries(right.attrs).some(differs)) {
          reader.touch(token.index, token.index);
          setItem(element, right);
        }
      } else if (left.isText && !Mark.sameSet(left.marks, right.marks)) {
        const change = markChange(left.marks, right.marks);
        for (let done = 0; done < length;) {
          const token = tokenIn(reading, at, offset + done);
          const piece = token.piece!;
          const run = Math.min(
            length - done,
            reading.bases[at]! +
              piece.index +
              ("text" in piece ? piece.text.length : 1) -
              token.index,
          );
          letters(token.index, run, change);
          done += run;
        }
      }
      offset += length;
      usedOne += length;
      usedOther += length;
      if (usedOne === left.nodeSize) {
        one += 1;
        usedOne = 0;
      }
      if (usedOther === right.nodeSize) {
        other += 1;
        usedOther = 0;
      }
    }
  });

  if (ranges.length > 0) {
    const changes: Change[] = [];
    let at = 0;
    for (const range of ranges) {
      reader.touch(range.index, range.index + range.length);
      changes.push(...retain(range.index - at), {
        retain: range.length,
        attributes: range.change,
      });
      at = range.index + range.length;
    }
    apply(sequence, changes);
  }
  for (const start of starts.reverse())
    insertBoundary(writing, start.index, start.block, start.path);
}

/**
 * Writes one editor transaction to the sequence, each step by its own step map.
 *
 * What a map keeps, keeps its items. A replaced range that starts with a block's start, replaced
 * by one that starts with a block's start, keeps that boundary and sets its attributes, and so
 * does one inline item replaced by one of its kind. A block start put at the very start of a block
 * that has text goes in front of that block's boundary, so the boundary stays with its text. Steps
 * that replace nothing are written as formatting and as attributes of the same elements. Every
 * new boundary carries the formatting in force where it goes, and its path.
 *
 * A block with no boundary of its own can come or go when its neighbours change: the paragraph
 * for what stands before the first boundary, the one the reader adds in front of a list item's
 * content, and the one for what a block cannot hold. After each step the sequence is read again,
 * and a block start the editor has and the reading lacks is written as a boundary. No letter and
 * no inline item is written to make the two agree.
 *
 * Returns false when it stopped at a step after which the sequence does not read as the editor's
 * document: two containers that share an id became neighbours and read as one.
 */
export function writeTransaction(writing: BodyWriting, transaction: Transaction): boolean {
  const docs = [...transaction.docs, transaction.doc];
  let formatted = -1;
  for (let at = 0; at < transaction.steps.length; at++) {
    const map = transaction.steps[at]!.getMap();
    if (!replaces(map)) {
      if (formatted < 0) formatted = at;
      continue;
    }
    if (formatted >= 0) writeFormatting(writing, docs[formatted]!, docs[at]!);
    formatted = -1;
    const after = docs[at + 1]!;
    const ranges: [number, number, number, number][] = [];
    map.forEach((oldStart, oldEnd, newStart, newEnd) =>
      ranges.push([oldStart, oldEnd, newStart, newEnd]),
    );
    for (const range of ranges.reverse()) writeRange(writing, after, ...range);
    if (!writeBlockStartsThatDiffer(writing, after)) return false;
  }
  if (formatted >= 0) writeFormatting(writing, docs[formatted]!, transaction.doc);
  return true;
}
