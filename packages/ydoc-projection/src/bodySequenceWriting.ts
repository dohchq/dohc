import { Mark, type Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  StepMap,
  Transform,
  type Step,
} from "@tiptap/pm/transform";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
} from "./bodySequenceGrammar.js";
import { linesGiven } from "./bodySequenceWriter.js";
import { storedValue, visitPieces } from "./bodySequenceYjs.js";
import {
  blockHolding,
  blockStartingAt,
  isAddedParagraph,
  countBelow,
  boundaryAt,
  boundaryElement,
  createBodyReader,
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

type Range = [oldStart: number, oldEnd: number, newStart: number, newEnd: number];

function trimRange(before: ProseMirrorNode, after: ProseMirrorNode, range: Range): Range {
  const [oldStart, oldEnd, newStart, newEnd] = range;
  const differs = before.content.findDiffStart(after.content);
  const ends = before.content.findDiffEnd(after.content);
  if (differs === null || !ends) return range;
  const shortest = Math.min(oldEnd - oldStart, newEnd - newStart);
  const $start = before.resolve(oldStart);
  const inItsBlock = $start.depth > 0 ? $start.end() - oldStart : shortest;
  let head = Math.max(0, Math.min(differs - oldStart, shortest, inItsBlock));
  if (head > 0) {
    const $old = before.resolve(oldStart + head);
    const $new = after.resolve(newStart + head);
    for (let depth = 1; depth <= $old.depth; depth++) {
      const opensInTheRange = $old.before(depth) >= oldStart;
      if (!opensInTheRange || $old.after(depth) <= oldEnd === $new.after(depth) <= newEnd) continue;
      head = $old.before(depth) - oldStart;
      break;
    }
  }
  let tail = Math.max(0, Math.min(oldEnd - ends.a, shortest - head));
  if (head > 0 && (splitsPair(before, oldStart + head) || splitsPair(after, newStart + head)))
    head -= 1;
  if (tail > 0 && (splitsPair(before, oldEnd - tail) || splitsPair(after, newEnd - tail)))
    tail -= 1;
  return [oldStart + head, oldEnd - tail, newStart + head, newEnd - tail];
}

function rangesOf(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  map: StepMap,
  trimmed = true,
): Range[] {
  const ranges: Range[] = [];
  map.forEach((oldStart, oldEnd, newStart, newEnd) => {
    const same =
      oldEnd - oldStart === newEnd - newStart &&
      before.slice(oldStart, oldEnd).eq(after.slice(newStart, newEnd));
    if (!same) ranges.push([oldStart, oldEnd, newStart, newEnd]);
  });
  return trimmed && ranges.length === 1 ? [trimRange(before, after, ranges[0]!)] : ranges;
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

function staysTheAddedParagraph(
  reading: BodyReading,
  opened: number,
  tokens: readonly Token[],
): boolean {
  const [first, second] = tokens;
  return (
    isAddedParagraph(reading, opened) &&
    first !== undefined &&
    "block" in first &&
    first.block.type.name === "paragraph" &&
    first.block.content.size === 0 &&
    second !== undefined &&
    "block" in second &&
    second.block.type !== first.block.type
  );
}

function keepsTheStartItReplaces(
  reading: BodyReading,
  opened: number,
  endsIn: number,
  tokens: readonly Token[],
): boolean {
  const first = tokens[0];
  if (first === undefined || !("block" in first)) return false;
  if (endsIn <= opened) return true;
  const startsMoreBlocks = tokens.findLastIndex((token) => "block" in token) > 0;
  return startsMoreBlocks && !staysTheAddedParagraph(reading, opened, tokens);
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
  const reading = reader.reading();
  const holder = blockHolding(reading, oldStart);
  const startsBlock = tokens.some((token) => "block" in token);
  const atStart = holder >= 0 && oldStart === reading.starts[holder]! + 1;
  const hasText = holder >= 0 && reading.blocks[holder]!.node.content.size > 0;

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
  const putsBlocksInFront =
    replaced &&
    holder < 0 &&
    opened >= 0 &&
    ends === opened &&
    tokens.filter((token) => "block" in token).length > 1;
  if ((continuesLaterBlock || putsBlocksInFront) && boundaryAt(reading, ends) >= 0) {
    const kept = boundaryAt(reading, ends);
    const continued = tokens.findLastIndex((token) => "block" in token);
    const path = pathAt(reading, oldStart);
    const behind = formattingInForceAfter(sequence, kept + 1);
    const own = continuesLaterBlock && opened >= 0 ? boundaryElement(reading, opened) : null;
    const keepsItsOwn =
      own !== null && startsWithBlock && keepsTheStartItReplaces(reading, opened, ends, tokens);
    const taken = keepsItsOwn || staysTheAddedParagraph(reading, opened, tokens) ? 1 : 0;
    const at = keepsItsOwn ? index + 1 : index;
    apply(sequence, [
      ...retain(at),
      ...inserts(tokens.slice(taken, continued), path, formattingInForceAfter(sequence, at)),
      ...(kept > at ? [{ delete: kept - at }] : []),
      { retain: 1 },
      ...inserts(tokens.slice(continued + 1), path, behind),
      ...(last.index > kept ? [{ delete: last.index - kept }] : []),
    ]);
    if (keepsItsOwn) setBoundary(own, reading.blocks[opened]!.node, start.block, null);
    const block = tokens[continued]!;
    if ("block" in block)
      setBoundary(boundaryElement(reading, ends)!, reading.blocks[ends]!.node, block.block, null);
    return;
  }
  const keepsItsStart =
    replaced &&
    first.piece === null &&
    first.block === opened &&
    startsWithBlock &&
    !continuesLaterBlock;
  if (keepsItsStart) {
    setBoundary(
      boundaryElement(reading, first.block)!,
      reading.blocks[first.block]!.node,
      start.block,
      null,
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
  const reading = reader.reading();
  const ranges: Formatting[] = [];
  const elements: (() => void)[] = [];
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
          elements.push(() => {
            reader.touch(token.index, token.index);
            setItem(element, right);
          });
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
  for (const set of elements) set();
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
}

/**
 * Writes one editor transaction to the sequence, each step by its own step map. A step that
 * replaces one range is written without what it leaves as it was at either end of that range:
 * the same block starts and ends, equal inline items, and equal letters with their marks. At the
 * range's start that stops at the end of the block the range starts in, so a selection that runs
 * out of a block is still written as one, and no later block's boundary becomes a new block's.
 *
 * What a map keeps, keeps its items. A replaced range that starts with a block's start, replaced
 * by one that starts with a block's start, keeps that boundary and sets its attributes, and so
 * does one inline item replaced by one of its kind. A block start put at the very start of a block
 * that has text goes in front of that block's boundary, so the boundary stays with its text; so do
 * the blocks a range puts in front of a block whose start it replaces and whose text it keeps.
 * Steps that replace nothing are written as formatting and as attributes of the same elements.
 * Every new boundary carries the formatting in force where it goes, and its path.
 *
 * A step that deletes a block and keeps text that followed it never reuses that block's boundary:
 * the text keeps its own boundary. So does the text of a later block that a range starting
 * inside an earlier block runs into, when the range starts a block. A range that replaces one
 * block's start and runs into a later block keeps both boundaries when it starts a block besides
 * the one it ends in: the first is the first new block's, with its kind. When all it starts is
 * the block it ends in, the first block goes. A list item's added paragraph that is still one
 * after the step gets no boundary.
 *
 * A block with no boundary of its own can come or go when its neighbours change: the paragraph
 * for what stands before the first boundary, the one the reader adds in front of a list item's
 * content, and the one for what a block cannot hold. This function gives no such block a
 * boundary. An editor calls `linesToGiveFirst` and `giveBoundaries` first, so the boundary of
 * each such block the transaction edits, or needs to have one, is written in a change of its own
 * that undo does not record, and the steps meet an ordinary line. After each step the sequence
 * is read again, and each block start the editor has and the reading lacks is written as a
 * boundary, in front of the boundary of the text that follows it. No letter and no inline item
 * is written to make the two agree.
 *
 * No step turns one block's boundary into another block's: a block that goes loses its boundary.
 *
 * A step that leaves the editor's document as it was writes nothing.
 *
 * Returns false when it stopped at a step after which the sequence does not read as the editor's
 * document: two containers that share an id became neighbours and read as one.
 * `afterEachStep` is called with the editor's document once for each step that replaces, when
 * it is written, and once more for formatting steps that end the transaction.
 */
export function writeTransaction(
  writing: BodyWriting,
  transaction: Transform,
  afterEachStep?: (shown: ProseMirrorNode) => void,
): boolean {
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
    const ranges = rangesOf(before, after, map);
    if (ranges.length === 0) continue;
    if (formatted >= 0) writeFormatting(writing, docs[formatted]!, before);
    formatted = -1;
    for (const range of ranges.reverse()) writeRange(writing, after, ...range);
    if (!writeBlockStartsThatDiffer(writing, after)) return false;
    afterEachStep?.(after);
  }
  if (formatted < 0) return true;
  writeFormatting(writing, docs[formatted]!, transaction.doc);
  afterEachStep?.(transaction.doc);
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

type Touched = {
  edits: Set<number>;
  after: Set<number>;
  above: Set<number>;
  gone: Set<number>;
  from: number;
  to: number;
  isSure: boolean;
  isNearALineWithNoBoundary: boolean;
};

function whatStepsTouch(reading: BodyReading, transactions: readonly Transform[]): Touched {
  const edits = new Set<number>();
  const after = new Set<number>();
  const above = new Set<number>();
  const gone = new Set<number>();
  const touched: Touched = {
    edits,
    after,
    above,
    gone,
    from: reading.doc.content.size,
    to: 0,
    isSure: true,
    isNearALineWithNoBoundary: false,
  };
  const maps: StepMap[] = [];
  const back = (pos: number, side: -1 | 1) => {
    let mapped = pos;
    for (let earlier = maps.length - 1; earlier >= 0; earlier--)
      mapped = maps[earlier]!.invert().map(mapped, side);
    return mapped;
  };
  const near = (from: number, to: number) => {
    touched.from = Math.min(touched.from, from);
    touched.to = Math.max(touched.to, to);
    let block = Math.max(0, countBelow(reading.starts, from + 1) - 2);
    while (block > 0 && isAddedParagraph(reading, block - 1)) block--;
    const last = Math.min(reading.blocks.length - 1, countBelow(reading.starts, to + 1));
    for (; block <= last; block++)
      if (boundaryAt(reading, block) < 0) touched.isNearALineWithNoBoundary = true;
  };
  const touch = (block: number) => {
    after.add(block);
    above.add(block);
  };
  const splitAt = (block: number, atItsStart: boolean) => {
    edits.add(block);
    after.add(block);
    if (atItsStart) above.add(block);
  };

  for (const transaction of transactions)
    transaction.steps.forEach((step, at) => {
      const was = transaction.docs[at]!;
      const now = transaction.docs[at + 1] ?? transaction.doc;
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        near(back(step.from, -1), back(step.to, 1));
        was.nodesBetween(step.from, step.to, (node, pos) => {
          if (!node.isTextblock) return true;
          if (marksOfLetters(node) !== marksOfLetters(now.nodeAt(pos)!))
            edits.add(blockStartingAt(reading, back(pos, 1)));
          return false;
        });
      } else if (step instanceof AttrStep) {
        const pos = back(step.pos, 1);
        const started = blockStartingAt(reading, pos);
        near(pos, pos);
        edits.add(started >= 0 ? started : blockHolding(reading, pos));
      } else {
        step.getMap().forEach((oldStart, oldEnd) => {
          touched.from = Math.min(touched.from, back(oldStart, -1));
          touched.to = Math.max(touched.to, back(oldEnd, 1));
        });
        for (const [oldStart, oldEnd, newStart, newEnd] of rangesOf(
          was,
          now,
          step.getMap(),
          false,
        )) {
          const from = back(oldStart, -1);
          const to = oldEnd === oldStart ? from : back(oldEnd, 1);
          const tokens = tokensBetween(now, newStart, newEnd);
          const started = tokens.filter((token) => "block" in token);
          const holder = blockHolding(reading, from);
          const endsIn = to > from ? blockHolding(reading, to) : holder;
          const first = tokens[0];
          const startsWithBlock = first !== undefined && "block" in first;
          const opened = blockStartingAt(reading, from);
          const keepsItsKind =
            opened >= 0 &&
            to === from + 1 &&
            tokens.length === 1 &&
            startsWithBlock &&
            first.block.type === reading.blocks[opened]!.node.type;
          const onlyClosesIt =
            holder >= 0 &&
            tokens.length === 0 &&
            to === from + 1 &&
            from === reading.starts[holder]! + 1 + reading.blocks[holder]!.node.content.size;
          near(from, to);
          if (!keepsItsKind && !onlyClosesIt && (holder < 0 || endsIn !== holder))
            touched.isSure = false;
          if (holder >= 0) {
            edits.add(holder);
            const startsALaterBlockAgain = endsIn > holder ? 1 : 0;
            if (started.length > startsALaterBlockAgain) {
              after.add(holder);
              if (startsWithBlock && was.resolve(oldStart).parentOffset === 0) above.add(holder);
            }
          } else if (to === from && started.length > 0) {
            const upper = countBelow(reading.starts, from) - 1;
            const lower = opened;
            const over = reading.blocks[upper]?.node;
            const isUnderIt =
              over !== undefined &&
              reading.starts[upper]! + over.nodeSize === from &&
              !isAddedParagraph(reading, upper);
            if (isUnderIt) splitAt(upper, over.content.size === 0);
            else if (lower >= 0) splitAt(lower, true);
          }
          const last = started.at(-1);
          for (
            let block = countBelow(reading.starts, from);
            block < reading.blocks.length && reading.starts[block]! < to;
            block++
          ) {
            const kind = reading.blocks[block]!.node.type;
            const keepsItsStart =
              reading.starts[block] === from &&
              keepsTheStartItReplaces(reading, block, endsIn, tokens);
            if (keepsItsStart) {
              const putInFront = endsIn === block && started.length > 1;
              const own = putInFront ? last : first;
              const startsALaterBlockAgain = endsIn > block ? 1 : 0;
              edits.add(block);
              if (started.length > 1 + startsALaterBlockAgain) after.add(block);
              if (putInFront) above.add(block);
              if (own !== undefined && "block" in own && own.block.type !== kind) touch(block);
              continue;
            }
            const startsAgain = block === endsIn && started.length > 0;
            if (!startsAgain) {
              gone.add(block);
              touch(block);
              continue;
            }
            const isTypedInto = tokens.at(-1) !== last;
            const isOnlyReached = to === reading.starts[block]! + 1;
            if (holder >= 0 && started.length === 1 && !isTypedInto && !isOnlyReached)
              gone.add(block);
            if (last !== undefined && "block" in last && last.block.type !== kind) touch(block);
            if (isTypedInto) edits.add(block);
          }
        }
      }
      maps.push(step.getMap());
    });
  return touched;
}

function linesTouched(reading: BodyReading, { edits, after, above, gone }: Touched): number[] {
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
      const owner = lineAt(ownerOfAddedParagraph(reading, block));
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

function ownerOfAddedParagraph(reading: BodyReading, block: number): number {
  let own = block + 1;
  while (
    own < reading.blocks.length &&
    (reading.lines[own] !== reading.lines[block] || boundaryAt(reading, own) < 0)
  )
    own++;
  return own;
}

/**
 * A block read with no boundary of its own, as it stands at one moment: its index, why it has
 * none, the items it shows, and the boundary and the kind of the block it depends on. That is
 * the block a paragraph stands after, or the one an added paragraph stands in front of.
 */
export type LineWithNoBoundary = {
  block: number;
  bare: "start" | "item" | "spill";
  items: readonly Y.ID[];
  owner: Y.ID | null;
  ownerKind: string | null;
  path: string;
  node: ProseMirrorNode;
};

/** Every block of a note that is read with no boundary of its own. */
export function linesWithNoBoundary({ sequence, reader }: BodyWriting): LineWithNoBoundary[] {
  const reading = reader.reading();
  const lines: (Omit<LineWithNoBoundary, "items"> & { count: number })[] = [];
  const wanted: number[] = [];
  reading.blocks.forEach((block, at) => {
    if (boundaryAt(reading, at) >= 0) return;
    const line = reading.lines[at];
    const had = wanted.length;
    for (const piece of block.shown)
      for (let unit = 0; unit < ("text" in piece ? piece.text.length : 1); unit++)
        wanted.push(reading.bases[at]! + piece.index + unit);
    const bare = !line?.element ? "start" : isParagraphAfterItsLeaf(reading, at) ? "spill" : "item";
    lines.push({
      block: at,
      bare,
      owner: line?.item?.id ?? null,
      ownerKind: line?.read?.own.node.type.name ?? null,
      path: reading.paths[at]!.join(),
      node: block.node,
      count: wanted.length - had,
    });
  });
  const ids: Y.ID[] = [];
  let index = 0;
  for (let item = sequence._start; item !== null && ids.length < wanted.length; item = item.right) {
    if (item.deleted || !item.countable) continue;
    while (ids.length < wanted.length && wanted[ids.length]! < index + item.length)
      ids.push(Y.createID(item.id.client, item.id.clock + wanted[ids.length]! - index));
    index += item.length;
  }
  let taken = 0;
  return lines.map(({ count, ...line }) => ({
    ...line,
    items: ids.slice(taken, (taken += count)),
  }));
}

const boundaryIn = (item: Y.Item | null) => {
  const type = item?.content instanceof Y.ContentType ? item.content.type : null;
  return type instanceof Y.XmlElement && type.nodeName === BLOCK_ELEMENT ? type : null;
};

/**
 * The lines with no boundary of their own that a change brought into being: those of `now` with
 * no counterpart in `before`, both from `linesWithNoBoundary`. A line's counterpart holds one of
 * its items. Text before the first boundary has the earlier such text for its counterpart, and
 * a list item's added paragraph the earlier one of the same item. Section 4 has a change write
 * the boundary of a line it brings into being, so a change should leave none.
 */
export function linesBroughtIntoBeing(
  before: readonly LineWithNoBoundary[],
  now: readonly LineWithNoBoundary[],
): LineWithNoBoundary[] {
  const isItsCounterpart = (line: LineWithNoBoundary, was: LineWithNoBoundary) =>
    line.bare === "spill"
      ? was.items.some((id) => line.items.some((own) => Y.compareIDs(id, own)))
      : was.bare === line.bare && was.path === line.path;
  return now.filter((line) => !before.some((was) => isItsCounterpart(line, was)));
}

const sameIds = (one: readonly Y.ID[], other: readonly Y.ID[]) =>
  one.length === other.length && one.every((id, at) => Y.compareIDs(id, other[at]!));

/**
 * The blocks that had no boundary of their own before a change and that the change should have
 * found with one, by their index before it. `before` is `linesWithNoBoundary` taken before the
 * change, `state` the note's state vector from then, and `writing` the note after it.
 *
 * A change that needs none leaves each such line as it was, or takes it away. A line is wanting
 * when the change wrote a boundary in front of what it holds, also with letters of its own
 * between; when it edited what the line holds and left it with no boundary; when it deleted,
 * split or changed the kind of the block the line depends on; and when the line now stands under
 * a boundary that was another line's, which got a new one. Another language, TeX or heading level
 * for a block is no other kind. `linesGiven`, the rule the reference writer asks, says which
 * lines that makes: `wanting`. `now` is `linesWithNoBoundary` taken after the change.
 *
 * `isHeaded` says whether a boundary the change made is the nearest one in front of items that
 * some such line held and that still stand, or stands for a list item's added paragraph.
 *
 * When the change is known not to have ended as the editor's document (`isUnsettled`), a list
 * item's added paragraph that something was written in front of is wanting too. A line whose
 * block went, and whose items now read in another line or which is such an added paragraph, is
 * then wanting in place of the lines the change edited, since those edits may only follow from
 * it.
 */
export function linesLeftWanting(
  before: readonly LineWithNoBoundary[],
  state: ReadonlyMap<number, number>,
  now: readonly LineWithNoBoundary[],
  writing: BodyWriting,
  isUnsettled = false,
): { wanting: number[]; isHeaded: boolean } {
  const store = writing.sequence.doc!.store;
  const nameOf = (id: Y.ID) => `${String(id.client)}:${String(id.clock)}`;
  const keyOf = (line: LineWithNoBoundary) =>
    line.owner ? `${line.bare} ${nameOf(line.owner)}` : line.bare;
  const stands = new Map(now.map((line) => [keyOf(line), line]));
  const owners = new Map<string, Line>();
  const lines = before.map((line): Line => {
    if (!line.owner) return { bare: line.bare };
    const owner = owners.get(nameOf(line.owner)) ?? { bare: "" };
    owners.set(nameOf(line.owner), owner);
    return { bare: line.bare, owner };
  });
  const isMadeByTheChange = (item: Y.Item | null) =>
    item !== null && item.id.clock >= (state.get(item.id.client) ?? 0);
  const boundaryTheChangeMade = (item: Y.Item | null) =>
    isMadeByTheChange(item) ? boundaryIn(item) : null;
  const standsNextTo = (item: Y.Item, side: "left" | "right", butWhatTheChangeTyped = false) => {
    const isPassed = (next: Y.Item) =>
      next.deleted ||
      !next.countable ||
      (butWhatTheChangeTyped && isMadeByTheChange(next) && !boundaryIn(next));
    let next = item[side];
    while (next !== null && isPassed(next)) next = next[side];
    return next;
  };
  const standsBefore = (item: Y.Item, butWhatTheChangeTyped = false) =>
    standsNextTo(item, "left", butWhatTheChangeTyped);
  const edits: Line[] = [];
  let isHeaded = false;
  const headed = (line: Line) => {
    isHeaded = true;
    edits.push(line);
  };
  const dependOnAChangedBlock: Line[] = [];
  const readInAnotherLine: Line[] = [];
  const lostTheirBlock: Line[] = [];

  before.forEach((line, at) => {
    const own = lines[at]!;
    const dependsOnAChangedBlock = () =>
      (own.owner ? dependOnAChangedBlock : edits).push(own.owner ?? own);
    const still = stands.get(keyOf(line));
    const depended = line.owner ? Y.getItem(store, line.owner) : null;
    if (still && still.ownerKind !== line.ownerKind) dependsOnAChangedBlock();
    else if (still && (!sameIds(still.items, line.items) || !still.node.eq(line.node)))
      edits.push(own);
    if (line.bare === "item") {
      if (!depended) return;
      const isItsBoundary = (item: Y.Item | null) => {
        const made = boundaryTheChangeMade(item) ?? undefined;
        return (
          made !== undefined &&
          (storedValue(made, "type") ?? "paragraph") === "paragraph" &&
          String(storedValue(made, "path")) === line.path
        );
      };
      const hasItsOwn =
        isItsBoundary(standsBefore(depended, true)) ||
        (depended.deleted && isItsBoundary(standsNextTo(depended, "right", true)));
      if (hasItsOwn) headed(own);
      else if (!isUnsettled) return;
      else if (depended.deleted) lostTheirBlock.push(own);
      else if (isMadeByTheChange(standsBefore(depended))) edits.push(own);
      return;
    }
    if (still) return;
    const moved = now.some(
      (other) => other.items[0] && line.items.some((id) => Y.compareIDs(id, other.items[0]!)),
    );
    if (moved) return void dependsOnAChangedBlock();
    const head = line.items
      .map((id) => ({ id, item: Y.getItem(store, id) }))
      .find(({ item }) => !item.deleted);
    if (!head) return;
    if (head.id.clock > head.item.id.clock) return;
    const under = standsBefore(head.item);
    const boundary = boundaryIn(under);
    const joinedItsBlock =
      under === depended &&
      (storedValue(boundary ?? undefined, "type") ?? "paragraph") === line.ownerKind;
    const tookAnothersBoundary =
      boundary !== null && !joinedItsBlock && boundaryTheChangeMade(standsBefore(under!)) !== null;
    let heading: Y.Item | null = head.item.left;
    while (heading !== null && (heading.deleted || !boundaryIn(heading))) heading = heading.left;
    if (isMadeByTheChange(heading)) headed(own);
    else if (tookAnothersBoundary) dependsOnAChangedBlock();
    else if (isUnsettled && depended?.deleted) readInAnotherLine.push(own);
  });
  const lost = [...readInAnotherLine, ...lostTheirBlock];
  const given = new Set(
    linesGiven(lines, {
      edits: lost.length > 0 ? lost : edits,
      after: dependOnAChangedBlock,
      above: dependOnAChangedBlock,
    }),
  );
  const wanting = before.filter((_, at) => given.has(lines[at]!)).map((line) => line.block);
  return { wanting, isHeaded };
}

function readsAlike(one: ProseMirrorNode, other: ProseMirrorNode): boolean {
  if (one === other) return true;
  if (!one.sameMarkup(other)) return false;
  if (one.isTextblock) {
    const shown = (block: ProseMirrorNode) =>
      block.textBetween(0, block.content.size, undefined, (leaf) => `\0${leaf.type.name}`);
    return shown(one) === shown(other);
  }
  if (one.childCount !== other.childCount) return false;
  for (let at = 0; at < one.childCount; at++)
    if (!readsAlike(one.child(at), other.child(at))) return false;
  return true;
}

const TRIES = 3;

/**
 * Writes some editor transactions to a note, a copy of the real one or a test's, and says which
 * of the blocks that had no boundary of their own should have had one first, by their index
 * before the write. `linesLeftWanting` is asked after each step, and once more for the whole
 * write against the note as it was before. `isRead` says whether the note read as the
 * editor's document after every step, marks aside. `isSettled` says that it did, that no step
 * brought a line into being with no boundary of its own, and that no boundary the write made
 * is left in front of what a line with none held.
 */
export function linesAWriteLeavesWanting(
  writing: BodyWriting,
  transactions: readonly Transform[],
): { wanting: number[]; isSettled: boolean; isRead: boolean } {
  const note = writing.sequence.doc!;
  const stateOf = () => Y.decodeStateVector(Y.encodeStateVector(note));
  const first = linesWithNoBoundary(writing);
  const begun = stateOf();
  const wanting = new Set<number>();
  let before = first;
  let state = begun;
  let isRead = true;
  let bringsNone = true;
  const isTheSameLine = (one: LineWithNoBoundary, other: LineWithNoBoundary) =>
    one.bare === other.bare &&
    (one.owner === null
      ? other.owner === null
      : other.owner !== null && Y.compareIDs(one.owner, other.owner)) &&
    (one.items[0] === undefined
      ? other.items[0] === undefined
      : other.items[0] !== undefined && Y.compareIDs(one.items[0], other.items[0]));
  const look = (shown: ProseMirrorNode | null) => {
    const now = linesWithNoBoundary(writing);
    const reads = shown !== null && readsAlike(writing.reader.reading().doc, shown);
    for (const block of linesLeftWanting(before, state, now, writing, !reads).wanting) {
      const line = before.find((each) => each.block === block)!;
      const was = first.find((each) => isTheSameLine(each, line));
      if (was) wanting.add(was.block);
    }
    isRead &&= reads;
    bringsNone &&= linesBroughtIntoBeing(before, now).length === 0;
    before = now;
    state = stateOf();
  };
  note.transact(() => {
    const wrote = transactions.every((transaction) => writeTransaction(writing, transaction, look));
    if (!wrote) look(null);
  });
  const whole = linesLeftWanting(first, begun, before, writing);
  for (const block of whole.wanting) wanting.add(block);
  return { wanting: [...wanting], isSettled: isRead && bringsNone && !whole.isHeaded, isRead };
}

type Copy = { writing: BodyWriting; transactions: readonly Transform[]; first: number };

function copyOfNote({ sequence, reader }: BodyWriting, transactions: readonly Transform[]): Copy {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(sequence.doc!));
  const copied = copy.getText(BODY_SEQUENCE_FIELD);
  const records = copy.getMap(BODY_CONTAINERS_FIELD);
  const schema = reader.reading().doc.type.schema;
  const writing = { sequence: copied, reader: createBodyReader(schema, copied, records) };
  return { writing, transactions, first: 0 };
}

function copyOfWindow(
  { sequence, reader }: BodyWriting,
  transactions: readonly Transform[],
  { from, to }: Touched,
  given: readonly number[],
): Copy | null {
  const reading = reader.reading();
  const base = reading.doc;
  const posOf = (child: number) => base.resolve(0).posAtIndex(child, 0);
  let child = Math.max(0, base.resolve(from).index(0) - 1);
  let lastChild = Math.min(base.childCount - 1, base.resolve(to).indexAfter(0));
  let first = 0;
  let last = 0;
  for (;;) {
    first = countBelow(reading.starts, posOf(child));
    last = countBelow(reading.starts, posOf(lastChild + 1)) - 1;
    if (first > 0 && reading.lines[first] === reading.lines[first - 1]) child--;
    else if (reading.lines[last + 1] && reading.lines[last + 1] === reading.lines[last])
      lastChild++;
    else break;
  }
  const line = reading.lines[first];
  if (!line || given.some((block) => block < first || block > last)) return null;
  const head = line.item ?? sequence._start;
  const marks = new Map<string, unknown>();
  for (let item = sequence._start; item !== null && item !== head; item = item.right)
    if (!item.deleted && item.content instanceof Y.ContentFormat)
      marks.set(item.content.key, item.content.value);
  const changes: Change[] = [];
  visitPieces(head, reading.lines[last + 1]?.item ?? null, marks, undefined, (piece) =>
    changes.push({
      insert:
        "text" in piece
          ? piece.text
          : "atom" in piece
            ? elementFor(piece.atom, piece.attrs)
            : elementFor(BLOCK_ELEMENT, piece.boundary),
      attributes: Object.fromEntries([...marks].filter(([, value]) => value !== null)),
    }),
  );
  const copy = new Y.Doc();
  const copied = copy.getText(BODY_SEQUENCE_FIELD);
  copied.applyDelta(changes, { sanitize: false });
  const records = sequence.doc!.getMap(BODY_CONTAINERS_FIELD);
  const writing = { sequence: copied, reader: createBodyReader(base.type.schema, copied, records) };
  const start = posOf(child);
  const shift = StepMap.offset(-start);
  const windowed: Transform[] = [];
  let doc = base.cut(start, posOf(lastChild + 1));
  let fits = writing.reader.reading().doc.eq(doc);
  for (const transaction of transactions) {
    const transform = new Transform(doc);
    for (const step of transaction.steps)
      try {
        const moved = fits ? step.map(shift) : null;
        fits = moved !== null && !transform.maybeStep(moved).failed;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        fits = false;
      }
    windowed.push(transform);
    doc = transform.doc;
  }
  if (fits) return { writing, transactions: windowed, first };
  copy.destroy();
  return null;
}

function linesATrialGives(
  open: (given: readonly number[]) => Copy | null,
  guessed: readonly number[],
): number[] | null | undefined {
  const never = new Set<number>();
  let given = [...guessed];
  for (let tries = 0; tries < TRIES; tries++) {
    const copy = open(given);
    if (!copy) return undefined;
    const { writing: trial, transactions, first } = copy;
    const note = trial.sequence.doc!;
    const there = given.map((block) => block - first);
    note.transact(() => giveBoundaries(trial, there));
    const gave = there.map((block) => trial.reader.reading().lines[block]!.item!);
    const { wanting, isSettled, isRead } = linesAWriteLeavesWanting(trial, transactions);
    const taken = given.filter((_, at) => gave[at]!.deleted);
    for (const block of taken) never.add(block);
    const more = wanting.map((block) => block + first).filter((block) => !never.has(block));
    note.destroy();
    if (taken.length + more.length === 0) return isSettled ? given : isRead ? null : undefined;
    given = [...given.filter((block) => !never.has(block)), ...more];
  }
  return undefined;
}

/**
 * The blocks with no boundary of their own that get one before some editor transactions are
 * written, by their index in what the sequence reads as now, or null when the transactions
 * cannot be written and the dispatch is to be refused. The transactions are the ones of one
 * dispatch, and the first starts from that reading.
 *
 * Nothing is written. A first guess is read from the steps: each says what it touches, as the
 * reference writer's operations do. The block a range starts in is edited, and so is each block a
 * mark or an attribute step changes. A block a range starts a block in is split, also when the
 * range replaces a selection. A block put right under another splits that one at its end, as a
 * new line under it does, and the end of an empty block is its start too. One put first in the
 * note, in a container or in a list item's stored content splits the block under it at its
 * start, and so do blocks put in front of a block whose start the range replaces and whose text
 * it keeps. A block whose start a range replaces with a start of another kind changes kind; with
 * a start of its own kind it only changes an attribute. A block whose start a range takes away
 * goes. A block that is split, changes kind or goes can alter the paragraph after it, and one
 * that goes, changes kind or is split at its start its list item's added first paragraph.
 * `linesGiven`, the rule the reference writer asks too, turns that into the blocks to give. A
 * block whose own start the dispatch takes away gets none.
 *
 * The guess is the answer when every range stays inside one block or only gives a block's start
 * another attribute, and when the dispatch comes within a block of no line with no boundary. Any
 * other dispatch is written to a copy with the guessed lines given, and
 * `linesAWriteLeavesWanting` says from what the writer did there which more lines to give. Those
 * are given on a new copy and the dispatch is written again, until it leaves no line wanting. A
 * line whose given boundary the dispatch deletes is given none.
 *
 * The copy is a window of the note: the top-level blocks the steps touch and one more on each
 * side, with whole lines, their live items only, the formatting in force where they start, and
 * the steps moved to start there. It reads the note's own container records. When the window
 * does not read as that part of the editor's document, before or after a step, or takes more
 * than three copies, the whole note is copied instead, which costs a read of the note; `trial`
 * `"note"` asks for that copy at once.
 *
 * The dispatch is refused when a copy that read as the editor's document after every step is
 * still not settled once no more lines can be given: a boundary the dispatch makes would stand
 * in front of what a line with none held, which undo would take away with whatever someone else
 * made of that line. It is refused too when the whole note takes more than three copies or does
 * not read as the editor's document.
 */
export function linesToGiveFirst(
  writing: BodyWriting,
  transactions: readonly Transform[],
  trial: "window" | "note" = "window",
): number[] | null {
  const reading = writing.reader.reading();
  const touched = whatStepsTouch(reading, transactions);
  const guessed = linesTouched(reading, touched);
  if (touched.isSure || !touched.isNearALineWithNoBoundary) return guessed;
  const inWindow =
    trial === "window"
      ? linesATrialGives((given) => copyOfWindow(writing, transactions, touched, given), guessed)
      : undefined;
  if (inWindow !== undefined) return inWindow;
  return linesATrialGives(() => copyOfNote(writing, transactions), guessed) ?? null;
}

/**
 * Gives each of some blocks with no boundary of their own a paragraph boundary. The note reads
 * the same after. Section 4 has this written in a change of its own that undo does not record,
 * just before the change that needs it.
 */
export function giveBoundaries(writing: BodyWriting, blocks: readonly number[]): void {
  for (const block of blocks) giveBoundary(writing, writing.reader.reading(), block);
}
