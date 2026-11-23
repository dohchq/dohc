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
import { linesGiven } from "./bodySequenceWriter.js";
import { storedValue } from "./bodySequenceYjs.js";
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
 * So is a step that starts a block from inside the first block of a list item: Enter there, and
 * a paste of several paragraphs over it. Section 4 gives the line after the split a new item,
 * with a fresh id and its records, and the item's later blocks go with it. The paste is refused
 * although the item itself survives, because its second paragraph needs that new item. The
 * container writer's split lifts both. A split of a later block stays in its item and is taken.
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

type Unit = { key: string; pos: number; kind?: string };
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
    else if (holdsNoBlocks(node) && pos >= from)
      units.push({ key: BLOCK_START, pos, kind: node.type.name });
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
  if (!sameValue(storedValue(element, key), value)) element.setAttribute(key, value);
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

/**
 * Gives a block with no boundary of its own a paragraph boundary, in front of what it holds. The
 * note reads the same after, and the block has the same index.
 */
function giveBoundary(writing: BodyWriting, reading: BodyReading, block: number): void {
  const index = placeForBoundaryOf(reading, block);
  const paragraph = reading.doc.type.schema.nodes.paragraph!.create();
  insertBoundary(writing, index, paragraph, reading.paths[block]!);
}

function isParagraphAfterItsLeaf(reading: BodyReading, block: number): boolean {
  return (
    block < reading.blocks.length && reading.lines[block]?.read?.after === reading.blocks[block]
  );
}

/**
 * The blocks with no boundary of their own that a replaced range gives one first: the block the
 * range writes into, and the block whose start it replaces with another block's start. A later
 * block the range only runs into gets none.
 */
function linesARangeEdits(
  reading: BodyReading,
  oldStart: number,
  oldEnd: number,
  tokens: readonly Token[],
): number[] {
  const lines = new Set<number>();
  const edits = (block: number) => {
    if (block >= 0 && boundaryAt(reading, block) < 0) lines.add(block);
  };
  const holder = blockHolding(reading, oldStart);
  edits(holder);
  if (oldEnd === oldStart) return [...lines];
  const endsIn = blockHolding(reading, oldEnd);
  const first = tokens[0];
  if (first !== undefined && "block" in first) {
    const opened = blockStartingAt(reading, oldStart);
    if (opened >= 0 && endsIn <= opened) edits(opened);
  }
  return [...lines];
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

  for (const line of linesARangeEdits(reading, oldStart, oldEnd, tokens))
    giveBoundary(writing, reader.reading(), line);
  reading = reader.reading();

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
  const ends =
    replaced && (holder < 0 ? startsWithBlock : startsBlock) ? blockHolding(reading, oldEnd) : -1;
  const opened = blockStartingAt(reading, oldStart);
  const startsIn = holder >= 0 ? holder : opened >= 0 ? opened : first?.block;
  const continuesLaterBlock = replaced && startsIn !== undefined && ends > startsIn;
  if (continuesLaterBlock && boundaryAt(reading, ends) >= 0) {
    const kept = boundaryAt(reading, ends);
    const continued = tokens.findLastIndex((token) => "block" in token);
    const path = pathAt(reading, oldStart);
    const behind = formattingInForceAfter(sequence, kept + 1);
    const itsOwnStart = startsWithBlock && opened >= 0 && boundaryAt(reading, opened) < 0 ? 1 : 0;
    apply(sequence, [
      ...retain(index),
      ...inserts(
        tokens.slice(itsOwnStart, continued),
        path,
        formattingInForceAfter(sequence, index),
      ),
      { delete: kept - index },
      { retain: 1 },
      ...inserts(tokens.slice(continued + 1), path, behind),
      ...(last.index > kept ? [{ delete: last.index - kept }] : []),
    ]);
    const block = tokens[continued]!;
    if ("block" in block)
      setBoundary(boundaryElement(reading, ends)!, reading.blocks[ends]!.node, block.block, null);
    return;
  }
  if (continuesLaterBlock && oldEnd === reading.starts[ends]! + 1) {
    const itsOwnStart = rest.findLastIndex((token) => "block" in token);
    rest = rest.filter((_, at) => at !== itsOwnStart);
  }
  const kept = countBelow(reading.starts, oldEnd);
  if (replaced && first.piece === null && startsWithBlock && !continuesLaterBlock) {
    const path = pathAt(reading, oldStart);
    setBoundary(
      boundaryElement(reading, first.block)!,
      reading.blocks[first.block]!.node,
      start.block,
      samePath(path, reading.paths[first.block]!) ? null : path,
    );
    rest = rest.slice(1);
    index += 1;
    count -= 1;
  } else if (replaced && count === 1 && rest.length === 1 && start && "item" in start) {
    const element = first.piece?.element;
    if (element && element.nodeName === start.item.type.name) {
      setItem(element, start.item);
      return;
    }
  }
  if (isParagraphAfterItsLeaf(reading, kept) && count > 0) {
    const held = reading.bases[kept]!;
    if (held >= index && held < index + count) giveBoundary(writing, reading, kept);
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

type BlockStartEdit = { drop: Unit } | { add: Unit; before: number };

function blockStartsEndingAt(units: readonly Unit[], last: number): number {
  let count = 0;
  while (units[last - count]?.key === BLOCK_START) count++;
  return count;
}

function blockStartEdits(
  stored: readonly Unit[],
  wanted: readonly Unit[],
): BlockStartEdit[] | null {
  const edits: BlockStartEdit[] = [];
  let have = stored.length - 1;
  let want = wanted.length - 1;
  while (have >= 0 || want >= 0) {
    const held = stored[have];
    const asked = wanted[want];
    const spare = blockStartsEndingAt(wanted, want) - blockStartsEndingAt(stored, have);
    const same = held !== undefined && asked !== undefined && held.key === asked.key;
    const bothStart = same && held.key === BLOCK_START;
    if (same && (!bothStart || held.kind === asked.kind || spare === 0)) {
      have--;
      want--;
    } else if (asked?.key === BLOCK_START && (!bothStart || spare > 0)) {
      edits.push({ add: asked, before: have + 1 });
      want--;
    } else if (held?.key === BLOCK_START) {
      edits.push({ drop: held });
      have--;
    } else return null;
  }
  return edits;
}

function containersOf(doc: ProseMirrorNode): { pos: number; node: ProseMirrorNode }[] {
  const found: { pos: number; node: ProseMirrorNode }[] = [];
  doc.descendants((node, pos) => {
    if (holdsBlocks(node)) found.push({ pos, node });
    return holdsBlocks(node);
  });
  return found;
}

function pathOfSameContainer(
  reading: BodyReading,
  after: ProseMirrorNode,
  inAfter: number,
  depth: number,
): readonly string[] | null {
  if (depth === 0) return [];
  const wanted = containersOf(after);
  const read = containersOf(reading.doc);
  const ordinal = wanted.findIndex((container) => container.pos === inAfter);
  const same = read[ordinal];
  if (!same || read.length !== wanted.length || same.node.type !== wanted[ordinal]!.node.type)
    return null;
  const path = reading.paths[countBelow(reading.starts, same.pos)];
  return path && path.length >= depth ? path.slice(0, depth) : null;
}

function writeBlockStartsThatDiffer(writing: BodyWriting, after: ProseMirrorNode): boolean {
  const { sequence, reader } = writing;
  for (let attempt = 0; attempt < 4; attempt++) {
    const reading = reader.reading();
    const read = reading.doc;
    const differs = read === after ? null : read.content.findDiffStart(after.content);
    if (differs === null) {
      reader.adopt(after);
      return true;
    }
    let { a, b } = read.content.findDiffEnd(after.content)!;
    const overlap = differs - Math.min(a, b);
    if (overlap > 0) {
      a += overlap;
      b += overlap;
    }
    const $differs = read.resolve(differs);
    const start = $differs.parent.isTextblock ? $differs.before() : differs;
    const stored = unitsBetween(read, start, a);
    const edits = blockStartEdits(stored, unitsBetween(after, start, b));
    if (edits === null) return false;
    if (edits.length === 0) return true;
    let wrote = false;
    for (const edit of edits) {
      if ("drop" in edit) {
        const block = blockStartingAt(reading, edit.drop.pos);
        const boundary = block < 0 ? -1 : boundaryAt(reading, block);
        if (boundary < 0) continue;
        reader.touch(boundary - 1, boundary + 1);
        apply(sequence, [...retain(boundary), { delete: 1 }]);
        wrote = true;
        continue;
      }
      const $block = after.resolve(edit.add.pos);
      const depth = $block.depth;
      const path = pathOfSameContainer(reading, after, depth > 0 ? $block.before(depth) : 0, depth);
      if (path === null) return false;
      const index = indexAt(reading, stored[edit.before]?.pos ?? a);
      insertBoundary(writing, index, $block.nodeAfter!, path);
      wrote = true;
    }
    if (!wrote) return false;
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
  const planOn = (reading: BodyReading) => {
    const ranges: Formatting[] = [];
    const elements: (() => void)[] = [];
    const edited = new Set<number>();
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
        edited.add(at);
        const element = boundaryElement(reading, at);
        const stored = reading.blocks[at]!.node;
        if (element)
          elements.push(() => {
            reader.touch(boundary, boundary);
            setBoundary(element, stored, block, null);
          });
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
            edited.add(at);
            elements.push(() => {
              reader.touch(token.index, token.index);
              setItem(element, right);
            });
          }
        } else if (left.isText && !Mark.sameSet(left.marks, right.marks)) {
          const change = markChange(left.marks, right.marks);
          edited.add(at);
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
    return { ranges, elements, edited };
  };

  let plan = planOn(reader.reading());
  const bare = [...plan.edited].filter((at) => boundaryAt(reader.reading(), at) < 0);
  for (const at of bare) giveBoundary(writing, reader.reading(), at);
  if (bare.length > 0) plan = planOn(reader.reading());

  for (const set of plan.elements) set();
  if (plan.ranges.length > 0) {
    const changes: Change[] = [];
    let at = 0;
    for (const range of plan.ranges) {
      reader.touch(range.index, range.index + range.length);
      changes.push(...retain(range.index - at), {
        retain: range.length,
        attributes: range.change,
      });
      at = range.index + range.length;
    }
    apply(sequence, changes);
  }
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
 * A step that deletes a block and keeps text that followed it never reuses that block's boundary:
 * the text keeps its own boundary. So does the text of a later block that a range starting
 * inside an earlier block runs into, when the range starts a block.
 *
 * A block with no boundary of its own can come or go when its neighbours change: the paragraph
 * for what stands before the first boundary, the one the reader adds in front of a list item's
 * content, and the one for what a block cannot hold. A step that edits such a block, with a
 * letter, an inline item, a mark or a kind, gives it a paragraph boundary first, and so does one
 * that needs it to have one; the step then meets an ordinary line. After each step
 * the sequence is read again, and each block start the editor has and the reading lacks is
 * written as a boundary, in front of the boundary of the text that follows it. No letter and no
 * inline item is written to make the two agree.
 *
 * An editor calls `linesGivenBoundaries` and `giveBoundaries` first, so those boundaries are
 * written in a change of their own that undo does not record, and this one finds them there.
 * No step turns one block's boundary into another block's: a block that goes loses its boundary.
 *
 * A step that leaves the editor's document as it was writes nothing.
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
    const before = docs[at]!;
    const after = docs[at + 1]!;
    const ranges: [number, number, number, number][] = [];
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      const same =
        oldEnd - oldStart === newEnd - newStart &&
        before.slice(oldStart, oldEnd).eq(after.slice(newStart, newEnd));
      if (!same) ranges.push([oldStart, oldEnd, newStart, newEnd]);
    });
    if (ranges.length === 0) continue;
    if (formatted >= 0) writeFormatting(writing, docs[formatted]!, before);
    formatted = -1;
    for (const range of ranges.reverse()) writeRange(writing, after, ...range);
    if (!writeBlockStartsThatDiffer(writing, after)) return false;
  }
  if (formatted >= 0) writeFormatting(writing, docs[formatted]!, transaction.doc);
  return true;
}

type Line = { bare: "" | "start" | "item" | "spill"; owner?: Line };

function marksOfLetters(block: ProseMirrorNode): string {
  const marks: string[] = [];
  block.forEach((child) => {
    if (child.isText) marks.push(`${String(child.nodeSize)}${JSON.stringify(child.marks)}`);
  });
  return marks.join();
}

/**
 * The blocks with no boundary of their own that get one before some editor transactions are
 * written, by their index in what the sequence reads as now. The transactions are the ones of
 * one dispatch, and the first starts from that reading.
 *
 * Nothing is written and nothing is copied. Each step says what it touches: the block its range
 * starts in is edited, and so is each block a mark or an attribute step changes; a block whose
 * start a range takes away or replaces, and a block a range splits or ends, can alter the
 * paragraph after it and its list item's added first paragraph. `linesGiven`, the rule the
 * reference writer asks too, turns that into the blocks to give. A block whose own start the
 * dispatch takes away gets none, as a paragraph that Backspace joins away.
 */
export function linesGivenBoundaries(
  writing: BodyWriting,
  transactions: readonly Transaction[],
): number[] {
  const reading = writing.reader.reading();
  const edits = new Set<number>();
  const after = new Set<number>();
  const above = new Set<number>();
  const gone = new Set<number>();
  const maps: StepMap[] = [];
  const back = (pos: number, side: -1 | 1) => {
    let mapped = pos;
    for (let earlier = maps.length - 1; earlier >= 0; earlier--)
      mapped = maps[earlier]!.invert().map(mapped, side);
    return mapped;
  };
  const touch = (block: number) => {
    after.add(block);
    above.add(block);
  };

  for (const transaction of transactions)
    transaction.steps.forEach((step, at) => {
      const map = step.getMap();
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        const was = transaction.docs[at]!;
        const now = transaction.docs[at + 1] ?? transaction.doc;
        was.nodesBetween(step.from, step.to, (node, pos) => {
          if (!node.isTextblock) return true;
          if (marksOfLetters(node) !== marksOfLetters(now.nodeAt(pos)!))
            edits.add(blockStartingAt(reading, back(pos, 1)));
          return false;
        });
      } else if (step instanceof AttrStep) {
        const pos = back(step.pos, 1);
        const started = blockStartingAt(reading, pos);
        edits.add(started >= 0 ? started : blockHolding(reading, pos));
      } else {
        const was = transaction.docs[at]!;
        const now = transaction.docs[at + 1] ?? transaction.doc;
        map.forEach((oldStart, oldEnd, newStart, newEnd) => {
          if (
            oldEnd - oldStart === newEnd - newStart &&
            was.slice(oldStart, oldEnd).eq(now.slice(newStart, newEnd))
          )
            return;
          const from = back(oldStart, -1);
          const to = back(oldEnd, 1);
          const tokens = tokensBetween(now, newStart, newEnd);
          const startsBlock = tokens.some((token) => "block" in token);
          const holder = blockHolding(reading, from);
          if (holder >= 0) edits.add(holder);
          if (to === from) {
            if (!startsBlock) return;
            after.add(holder >= 0 ? holder : countBelow(reading.starts, from) - 1);
            if (holder >= 0 && from === reading.starts[holder]! + 1) above.add(holder);
            return;
          }
          const first = tokens[0];
          const endsIn = blockHolding(reading, to);
          for (
            let block = countBelow(reading.starts, from);
            block < reading.blocks.length && reading.starts[block]! < to;
            block++
          ) {
            const keepsItsStart =
              first !== undefined &&
              "block" in first &&
              reading.starts[block] === from &&
              endsIn <= block;
            const startsAgain = block === endsIn && startsBlock && !keepsItsStart;
            const again = tokens.findLast((token) => "block" in token);
            const asAnotherKind =
              startsAgain &&
              again !== undefined &&
              "block" in again &&
              again.block.type !== reading.blocks[block]!.node.type;
            if (keepsItsStart) edits.add(block);
            else if (!startsAgain || to > reading.starts[block]! + 1) gone.add(block);
            if (!startsAgain || asAnotherKind) touch(block);
          }
        });
      }
      maps.push(map);
    });

  const known = new Map<number, Line>();
  const lineAt = (block: number): Line | undefined => {
    if (block < 0 || block >= reading.blocks.length) return undefined;
    const seen = known.get(block);
    if (seen) return seen;
    const line: Line = { bare: "" };
    known.set(block, line);
    if (boundaryAt(reading, block) >= 0) return line;
    if (!reading.lines[block]?.element) line.bare = "start";
    else if (isParagraphAfterItsLeaf(reading, block)) {
      line.bare = "spill";
      const owner = lineAt(block - 1);
      if (owner) line.owner = owner;
    } else {
      line.bare = "item";
      let own = block + 1;
      while (
        own < reading.blocks.length &&
        (reading.lines[own] !== reading.lines[block] || boundaryAt(reading, own) < 0)
      )
        own++;
      const owner = lineAt(own);
      if (owner) line.owner = owner;
    }
    return line;
  };
  const near = new Set<number>(edits);
  for (const block of after) near.add(block + 1);
  for (const block of above)
    for (
      let added = block - 1;
      added >= 0 &&
      reading.lines[added] === reading.lines[block] &&
      isAddedParagraph(reading, added);
      added--
    )
      near.add(added);
  const blocks = [...near].filter((block) => block >= 0 && block < reading.blocks.length);
  const lines = blocks.map((block) => lineAt(block)!);
  const given = new Set(
    linesGiven(lines, {
      edits: [...edits].map(lineAt),
      after: [...after].map(lineAt),
      above: [...above].map(lineAt),
    }),
  );
  return blocks.filter((block) => given.has(lineAt(block)!) && !gone.has(block));
}

/**
 * Whether some editor transactions can bring a block into being or take one away: a step reaches
 * past one block's text, starts a block, or changes a block's own attribute.
 */
export function changesBlocks(transactions: readonly Transaction[]): boolean {
  return transactions.some((transaction) =>
    transaction.steps.some((step, at) => {
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return false;
      if (step instanceof AttrStep) return true;
      const was = transaction.docs[at]!;
      const now = transaction.docs[at + 1] ?? transaction.doc;
      let found = false;
      step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        const $start = was.resolve(oldStart);
        const inOneBlock = $start.parent.isTextblock && oldEnd <= $start.end();
        if (!inOneBlock || startsBlock(now, newStart, newEnd)) found = true;
      });
      return found;
    }),
  );
}

function bareLine(reading: BodyReading, block: number): string {
  const line = reading.lines[block];
  const owner = line?.item ? `${String(line.item.id.client)}:${String(line.item.id.clock)}` : "";
  const node = reading.blocks[block]!.node;
  const kind = !line?.element
    ? "start"
    : isParagraphAfterItsLeaf(reading, block)
      ? "spill"
      : "item";
  const text = node.textBetween(0, node.content.size, undefined, "\uFFFC");
  return `${kind} ${owner} ${String(reading.paths[block]!.length)} ${text}`;
}

/** What marks each block read with no boundary of its own: why, from which boundary, how deep, and what it holds. */
export function linesWithNoBoundary(reading: BodyReading): Set<string> {
  const lines = new Set<string>();
  reading.blocks.forEach((_, block) => {
    if (boundaryAt(reading, block) < 0) lines.add(bareLine(reading, block));
  });
  return lines;
}

/**
 * The blocks a change left with no boundary of their own that were not there so before it, by
 * `linesWithNoBoundary` taken before the change. Section 4 has the change write their boundary
 * itself, so that it leaves no line it edited or made without one.
 */
export function linesMade(reading: BodyReading, had: ReadonlySet<string>): number[] {
  const made: number[] = [];
  reading.blocks.forEach((_, block) => {
    if (boundaryAt(reading, block) < 0 && !had.has(bareLine(reading, block))) made.push(block);
  });
  return made;
}

/**
 * Gives each of some blocks with no boundary of their own a paragraph boundary. The note reads
 * the same after. Section 4 has this written in a change of its own that undo does not record,
 * just before the change that needs it.
 */
export function giveBoundaries(writing: BodyWriting, blocks: readonly number[]): void {
  for (const block of blocks) giveBoundary(writing, writing.reader.reading(), block);
}
