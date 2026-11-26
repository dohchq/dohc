import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  getDohcYDocFrontmatter,
  placedBoundaries,
  serializeRichdocBody,
  startingRecords,
  yDocToMarkdown,
} from "@dohc/ydoc-projection";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  readsBodySequence,
  storedValue,
} from "@dohc/ydoc-projection/body-sequence-yjs";
import { frontmatterValueFlowYaml } from "@dohc/ydoc-projection/frontmatter";

/** A recovery copy: the note as the updates rebuild it, and how many kept edits it lists at the end because the note has no place for them. */
export type RecoveredDocument = { markdown: string; notInNote: number };

type NotInNote =
  | { kind: "text"; text: string }
  | { kind: "field"; field: string; value: unknown; now: unknown }
  | {
      kind: "attribute";
      /** The block's text, or null when the block was deleted. */
      block: string | null;
      nodeName: string;
      name: string;
      value: unknown;
      now: unknown;
      inline?: boolean;
      shownAs?: string;
    }
  | { kind: "kind"; block: string | null; value: unknown; now: unknown }
  | { kind: "move"; block: string | null; nodeName: string }
  | { kind: "other" };

/** Offsets within one item, from inclusive, to exclusive. */
type Span = readonly [from: number, to: number];

const QUOTE_LIMIT = 80;

function rootOf(type: Y.AbstractType<unknown>): Y.AbstractType<unknown> {
  let current = type;
  while (current._item) current = current._item.parent as Y.AbstractType<unknown>;
  return current;
}

function contentValue(item: Y.Item): unknown {
  const [value] = item.content.getContent();
  return value instanceof Y.AbstractType ? value.toJSON() : value;
}

function plainText(type: Y.AbstractType<unknown>): string {
  if (type instanceof Y.XmlText)
    return (type.toDelta() as { insert: unknown }[])
      .map(({ insert }) => (typeof insert === "string" ? insert : ""))
      .join("");
  if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment)
    return type
      .toArray()
      .map((child) => plainText(child as Y.AbstractType<unknown>))
      .filter((text) => text !== "")
      .join(" ");
  return "";
}

/** The parts of `from`..`to` on `client` that `deletes` does not name. */
function notDeleted(
  deletes: ReturnType<typeof Y.mergeDeleteSets>,
  client: number,
  from: number,
  to: number,
): Span[] {
  const spans: Span[] = [];
  let cursor = from;
  for (const { clock, len } of deletes.clients.get(client) ?? []) {
    if (clock + len <= cursor) continue;
    if (clock >= to) break;
    if (clock > cursor) spans.push([cursor, clock]);
    cursor = clock + len;
    if (cursor >= to) break;
  }
  if (cursor < to) spans.push([cursor, to]);
  return spans;
}

/** JSON with each exact large integer, which JSON.stringify refuses, as its digits. */
const json = (value: unknown) =>
  JSON.stringify(value, (_key, part: unknown) => (typeof part === "bigint" ? `${part}` : part));

function equal(left: unknown, right: unknown): boolean {
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(right).length &&
      leftEntries.every(([key, part]) => Object.hasOwn(right, key) && equal(part, rightRecord[key]))
    );
  }
  return left === right || Object.is(left, right);
}

const same = (left: unknown, right: unknown) => equal(left ?? null, right ?? null);

/**
 * The kept edits a rebuilt document dropped. Yjs merges a kept edit with
 * changes already accepted, and drops it from what a person sees when it was
 * typed into a block someone else deleted, or when it set a field or a
 * block's setting that someone else set at the same moment and theirs was
 * kept. Such content is in the document but deleted, and no kept update
 * deleted it. Formatting a kept edit added is not listed.
 */
function editsNotInNote(
  doc: Y.Doc,
  base: Uint8Array | undefined,
  kept: readonly Uint8Array[],
): NotInNote[] {
  const dropped = droppedEdits(doc, kept);
  const frontmatter = doc.getMap("frontmatter");
  if (readsBodySequence(doc)) return sequenceEditsNotInNote(doc, base, frontmatter, dropped);
  const { lost, found } = dropped;
  const body = getDohcYDocBodyFragment(doc);

  const parentsWithText = new Set<Y.AbstractType<unknown>>();
  const elementsWithText = new Set<Y.Item>();
  for (const item of lost.keys()) {
    const parent = item.parent as Y.AbstractType<unknown>;
    if (item.parentSub !== null) {
      const value = contentValue(item);
      if (parent === frontmatter) found.push(...fieldNotInNote(doc, item.parentSub, value));
      else if (
        parent instanceof Y.XmlElement &&
        rootOf(parent as Y.AbstractType<unknown>) === body &&
        // A setting of a block the kept edits added goes with that block.
        !(parent._item !== null && lost.has(parent._item))
      ) {
        const deleted = parent._item?.deleted === true;
        const now = deleted ? undefined : parent.getAttribute(item.parentSub);
        if (deleted || !same(value, now))
          found.push({
            kind: "attribute",
            block: deleted ? null : plainText(parent as Y.AbstractType<unknown>),
            nodeName: parent.nodeName,
            name: item.parentSub,
            value,
            now,
          });
      }
      continue;
    }
    if (rootOf(parent) !== body || item.content instanceof Y.ContentFormat) continue;
    if (item.content instanceof Y.ContentString) {
      parentsWithText.add(parent);
      for (let up = parent._item; up; up = (up.parent as Y.AbstractType<unknown>)._item)
        elementsWithText.add(up);
    }
  }
  // Text in each block, in document order, one quote per unbroken run.
  for (const parent of parentsWithText) {
    const quotes = new Quotes(found);
    for (let item = parent._start; item; item = item.right) {
      if (item.content instanceof Y.ContentFormat) continue;
      const spans = item.content instanceof Y.ContentString ? lost.get(item) : undefined;
      if (spans === undefined || !(item.content instanceof Y.ContentString)) quotes.flush();
      else quotes.add(item.content.str, spans);
    }
    quotes.flush();
  }
  // Something added with settings but no text, such as an image, a formula or
  // an embed. Its settings were deleted with it, so they are read from the
  // entries Yjs keeps. An empty paragraph is not listed.
  for (const item of lost.keys()) {
    if (item.parentSub !== null || rootOf(item.parent as Y.AbstractType<unknown>) !== body)
      continue;
    const { content } = item;
    if (
      content instanceof Y.ContentString ||
      content instanceof Y.ContentFormat ||
      content instanceof Y.ContentDeleted ||
      elementsWithText.has(item)
    )
      continue;
    if (
      content instanceof Y.ContentType &&
      !(content.type instanceof Y.XmlElement && content.type._map.size > 0)
    )
      continue;
    found.push({ kind: "other" });
  }
  return found;
}

type Dropped = {
  lost: Map<Y.Item, Span[]>;
  live: Y.Item[];
  keptDeletes: ReturnType<typeof Y.mergeDeleteSets>;
  isKept: (id: Y.ID) => boolean;
  found: NotInNote[];
};

function droppedEdits(doc: Y.Doc, kept: readonly Uint8Array[]): Dropped {
  const decoded = kept.map((update) => Y.decodeUpdate(update));
  const keptDeletes = Y.mergeDeleteSets(decoded.map(({ ds }) => ds));
  // Yjs does not split an item that was already deleted when a later kept
  // update deletes part of it, and an item can hold accepted content beside kept.
  const lost = new Map<Y.Item, Span[]>();
  const live: Y.Item[] = [];
  const found: NotInNote[] = [];
  const keptClocks = new Map<number, Span[]>();
  for (const { structs } of decoded)
    for (const struct of structs)
      if (struct instanceof Y.Item) {
        const spans = keptClocks.get(struct.id.client) ?? [];
        spans.push([struct.id.clock, struct.id.clock + struct.length]);
        keptClocks.set(struct.id.client, spans);
      }
  for (const [client, spans] of keptClocks) {
    spans.sort(([left], [right]) => left - right);
    let clock = 0;
    for (const [from, end] of spans) {
      for (clock = Math.max(clock, from); clock < end;) {
        const part = Y.getItem(doc.store, Y.createID(client, clock));
        const partEnd = Math.min(end, part.id.clock + part.length);
        if (!(part instanceof Y.Item)) found.push({ kind: "other" });
        else if (part.deleted) {
          const dropped = notDeleted(keptDeletes, client, clock, partEnd).map(
            ([start, stop]): Span => [start - part.id.clock, stop - part.id.clock],
          );
          if (dropped.length > 0) lost.set(part, [...(lost.get(part) ?? []), ...dropped]);
        } else live.push(part);
        clock = partEnd;
      }
    }
  }
  const isKept = (id: Y.ID) =>
    (keptClocks.get(id.client) ?? []).some(([from, end]) => id.clock >= from && id.clock < end);
  return { lost, live, keptDeletes, isKept, found };
}

function fieldNotInNote(doc: Y.Doc, field: string, value: unknown): NotInNote[] {
  const fields = getDohcYDocFrontmatter(doc);
  const now = Object.hasOwn(fields, field) ? fields[field] : undefined;
  return same(value, now) ? [] : [{ kind: "field", field, value, now }];
}

class Quotes {
  private run = "";

  constructor(private readonly found: NotInNote[]) {}

  add(text: string, spans: readonly Span[]): void {
    let at = 0;
    for (const [from, to] of spans) {
      if (from > at) this.flush();
      this.run += text.slice(from, to);
      at = to;
    }
    if (at < text.length) this.flush();
  }

  breakLine(): void {
    if (this.run !== "") this.run += "\n";
  }

  flush(): void {
    if (this.run.trim() !== "") this.found.push({ kind: "text", text: this.run.trim() });
    this.run = "";
  }
}

type Stored = { readonly _map: Map<string, Y.Item> };

function valueAt(item: Y.Item, at: number): unknown {
  const value: unknown = item.content.getContent()[at];
  return value instanceof Y.AbstractType ? value.toJSON() : value;
}

function setLast(holder: Stored | undefined, key: string): unknown {
  const item = holder?._map.get(key);
  return item ? valueAt(item, item.length - 1) : undefined;
}

function sequenceEditsNotInNote(
  doc: Y.Doc,
  base: Uint8Array | undefined,
  frontmatter: Y.Map<unknown>,
  { lost, live, keptDeletes, isKept, found }: Dropped,
): NotInNote[] {
  const schema = getDohcProseMirrorSchema();
  const sequence = doc.share.get(BODY_SEQUENCE_FIELD);
  const records = doc.share.get(BODY_CONTAINERS_FIELD);
  const baseDeletes = Y.mergeDeleteSets(base ? [Y.decodeUpdate(base).ds] : []);
  const textOf = new Map<Y.Item, string>();
  const lineOf = new Map<Y.Item, Y.Item>();
  const linesOf = new Map<unknown, Y.Item[]>();
  const emptied = new Set<unknown>();
  let line: Y.Item | null = null;
  for (let item = sequence?._start ?? null; item; item = item.right) {
    const { content } = item;
    if (content instanceof Y.ContentString) {
      if (line && !item.deleted) textOf.set(line, textOf.get(line)! + content.str);
    } else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const element = content.type;
      if (element.nodeName !== BLOCK_ELEMENT) {
        if (line) lineOf.set(item, line);
        continue;
      }
      for (let path = element._map.get("path") ?? null; path; path = path.left)
        for (let at = 0; path.deleted && at < path.length; at += 1) {
          const id = Y.createID(path.id.client, path.id.clock + at);
          if (!Y.isDeleted(keptDeletes, id) && !Y.isDeleted(baseDeletes, id))
            for (const container of [valueAt(path, at)].flat()) emptied.add(container);
        }
      if (item.deleted) continue;
      textOf.set((line = item), "");
      for (const id of [storedValue(element, "path")].flat())
        linesOf.set(id, [...(linesOf.get(id) ?? []), item]);
    }
  }
  const typeOf = new Map<string, string>();
  const leafOf = new Map<Y.Item, string>();
  for (const { item, path, leaf } of placedBoundaries(schema, doc)) {
    leafOf.set(item, leaf);
    for (const { id, type } of path) typeOf.set(id, type);
  }
  const shows = (type: string, name: string) =>
    Object.hasOwn(schema.nodes[type]?.spec.attrs ?? {}, name);
  const lostValue = (item: Y.Item) => valueAt(item, lost.get(item)!.at(-1)![1] - 1);
  const textIn = (id: string) =>
    (linesOf.get(id) ?? [])
      .map((item) => textOf.get(item) ?? "")
      .filter((text) => text !== "")
      .join(" ");
  const keptMade = (key: string) => {
    let first = records?._map.get(key) ?? null;
    while (first?.left) first = first.left;
    return first !== null && isKept(first.id);
  };

  const record = (key: string, value: unknown, dropped: boolean): NotInNote[] => {
    const dot = key.indexOf(".");
    const id = dot < 0 ? key : key.slice(0, dot);
    const type = typeOf.get(id);
    if (type === undefined && !dropped && !emptied.has(id) && !linesOf.has(id)) return [];
    const block = linesOf.has(id) ? textIn(id) : null;
    if (dot < 0)
      return (
        dropped ? type !== undefined && same(value, type) : type !== undefined || keptMade(key)
      )
        ? []
        : [{ kind: "kind", block, value, now: type }];
    const name = key.slice(dot + 1);
    const recorded = setLast(records, id);
    const kind = typeof recorded === "string" ? recorded : "block";
    if (keptMade(key) && same(value, startingRecords(schema, kind).get(name))) return [];
    if (type === undefined)
      return [{ kind: "attribute", block, nodeName: kind, name, value, now: undefined }];
    if (!shows(type, name))
      return [
        { kind: "attribute", block, nodeName: type, name, value, now: undefined, shownAs: type },
      ];
    const now = storedValue(records, key);
    return dropped && !same(value, now)
      ? [{ kind: "attribute", block, nodeName: type, name, value, now }]
      : [];
  };

  const retyped = (element: Y.XmlElement) => {
    const now = element._item!.deleted ? undefined : storedValue(element, "type");
    for (let type = element._map.get("type") ?? null; type; type = type.left)
      if (lost.has(type) && !same(lostValue(type), now)) return true;
    return false;
  };

  const setting = (element: Y.XmlElement, name: string, value: unknown): NotInNote[] => {
    const at = element._item!;
    const boundary = element.nodeName === BLOCK_ELEMENT;
    if (lost.has(at) || (boundary && name !== "type" && retyped(element))) return [];
    const type = boundary ? setLast(element, "type") : element.nodeName;
    const nodeName = typeof type === "string" ? type : "paragraph";
    if (at.deleted)
      return [
        boundary && name === "path"
          ? { kind: "move", block: null, nodeName }
          : boundary && name === "type"
            ? { kind: "kind", block: null, value, now: undefined }
            : { kind: "attribute", block: null, nodeName, name, value, now: undefined },
      ];
    const now = storedValue(element, name);
    if (same(value, now)) return [];
    const home = boundary ? at : lineOf.get(at);
    const block = home ? (textOf.get(home) ?? "") : "";
    if (!boundary) return [{ kind: "attribute", block, nodeName, name, value, now, inline: true }];
    if (name === "type") return [{ kind: "kind", block, value, now }];
    if (name === "path") return [{ kind: "move", block, nodeName }];
    return [{ kind: "attribute", block, nodeName, name, value, now }];
  };

  for (const item of lost.keys()) {
    const { parent, parentSub } = item;
    if (parentSub === null) continue;
    const value = lostValue(item);
    if (parent === frontmatter) found.push(...fieldNotInNote(doc, parentSub, value));
    else if (parent === records) found.push(...record(parentSub, value, true));
    else if (parent instanceof Y.XmlElement && parent._item?.parent === sequence)
      found.push(...setting(parent, parentSub, value));
  }
  for (const item of live) {
    const { parent, parentSub } = item;
    const value = valueAt(item, item.length - 1);
    if (parentSub === null) continue;
    if (parent === records) found.push(...record(parentSub, value, false));
    else if (
      parent instanceof Y.XmlElement &&
      !["type", "path"].includes(parentSub) &&
      !retyped(parent)
    ) {
      const leaf = leafOf.get(parent._item!);
      if (leaf !== undefined && !shows(leaf, parentSub))
        found.push({
          kind: "attribute",
          block: textOf.get(parent._item!) ?? "",
          nodeName: leaf,
          name: parentSub,
          value,
          now: undefined,
          shownAs: leaf,
        });
    }
  }

  const quotes = new Quotes(found);
  for (let item = sequence?._start ?? null; item; item = item.right) {
    const { content } = item;
    const spans = lost.get(item);
    if (content instanceof Y.ContentFormat) continue;
    if (spans === undefined) quotes.flush();
    else if (content instanceof Y.ContentString) quotes.add(content.str, spans);
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const element = content.type;
      const boundary = element.nodeName === BLOCK_ELEMENT;
      const type = boundary ? setLast(element, "type") : undefined;
      if (
        boundary
          ? schema.nodes[String(type)]?.isTextblock !== false
          : element.nodeName === "hardBreak"
      )
        quotes.breakLine();
      else {
        quotes.flush();
        found.push({ kind: "other" });
      }
    }
  }
  quotes.flush();
  return found;
}

function yamlOrJson(value: unknown): string {
  try {
    return frontmatterValueFlowYaml(value);
  } catch {
    return json(value);
  }
}

const shown = (value: unknown) =>
  value === undefined || value === null
    ? null
    : typeof value === "string"
      ? `"${value}"`
      : yamlOrJson(value);

function quoteOf(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > QUOTE_LIMIT ? `${line.slice(0, QUOTE_LIMIT - 1)}…` : line;
}

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function entry(edit: Exclude<NotInNote, { kind: "other" }>): JSONContent[] {
  switch (edit.kind) {
    case "text":
      return [
        paragraph("Text added to a part that was deleted:"),
        {
          type: "blockquote",
          content: edit.text
            .split("\n")
            .filter((line) => line !== "")
            .map(paragraph),
        },
      ];
    case "field": {
      const now = shown(edit.now);
      return [
        paragraph(
          `Set ${edit.field} to ${shown(edit.value) ?? "nothing"}. ${now === null ? `The note has no ${edit.field}.` : `The note has ${now}.`}`,
        ),
      ];
    }
    case "attribute": {
      const task = edit.nodeName === "taskItem" && edit.name === "checked";
      if (edit.block === null)
        return [
          paragraph(
            task
              ? `${edit.value === true ? "Ticked" : "Unticked"} a to-do that was deleted.`
              : `Set ${edit.name} to ${shown(edit.value) ?? "nothing"} on a ${edit.nodeName} that was deleted.`,
          ),
        ];
      const quoted = edit.block === "" ? null : `"${quoteOf(edit.block)}"`;
      const block = edit.inline
        ? `a ${edit.nodeName}${quoted === null ? "" : ` in ${quoted}`}`
        : (quoted ?? `a ${edit.nodeName}`);
      const done = task
        ? `${edit.value === true ? "Ticked" : "Unticked"} ${block}.`
        : `Set ${edit.name} to ${shown(edit.value) ?? "nothing"} on ${block}.`;
      if (edit.shownAs !== undefined)
        return [paragraph(`${done} The note has it as ${article(edit.shownAs)}.`)];
      if (task)
        return [paragraph(`${done} The note has it ${edit.now === true ? "ticked" : "unticked"}.`)];
      return [paragraph(`${done} The note has ${shown(edit.now) ?? "no value"}.`)];
    }
    case "kind":
      return [
        paragraph(
          edit.block === null
            ? `Changed a part that was deleted to ${article(edit.value)}.`
            : `Changed ${edit.block === "" ? article(edit.now) : `"${quoteOf(edit.block)}"`} to ${article(edit.value)}. The note has it as ${article(edit.now)}.`,
        ),
      ];
    case "move":
      return [
        paragraph(
          edit.block === null
            ? `Moved ${article(edit.nodeName)} that was deleted.`
            : `Moved ${edit.block === "" ? article(edit.nodeName) : `"${quoteOf(edit.block)}"`}. The note has it in another place.`,
        ),
      ];
  }
}

const article = (type: unknown) => {
  const name = typeof type === "string" ? type : "block";
  return `${/^[aeiou]/iu.test(name) ? "an" : "a"} ${name}`;
};

/** The closing section of a recovery copy that lists kept edits the note above it has no place for. */
function notInNoteSection(edits: readonly NotInNote[]): string {
  const others = edits.filter((edit) => edit.kind === "other").length;
  const content: JSONContent[] = [
    { type: "horizontalRule" },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Kept edits that aren't in this copy" }],
    },
    paragraph(
      "These edits were kept on the computer that made them. A change saved at the same moment removed or replaced the place they were made, so the note above doesn't have them.",
    ),
    ...edits.flatMap((edit) => (edit.kind === "other" ? [] : entry(edit))),
    ...(others === 0
      ? []
      : [
          paragraph(
            others === 1
              ? "1 more kept edit, such as an image, can't be shown as text."
              : `${others} more kept edits, such as images, can't be shown as text.`,
          ),
        ]),
  ];
  return serializeRichdocBody({ type: "doc", content });
}

/**
 * The document `accepted` then `kept` rebuild, with a closing list of the
 * kept edits it has no place for. `accepted` starts with the base the kept
 * edits were made on. Null when an update still waits on what it depends on,
 * which would leave its edit out.
 */
export function recoveredDocument(
  accepted: readonly Uint8Array[],
  kept: readonly Uint8Array[],
): RecoveredDocument | null {
  // Without garbage collection a dropped edit stays in the document, deleted, and can be found.
  const doc = new Y.Doc({ gc: false });
  try {
    for (const update of [...accepted, ...kept]) Y.applyUpdate(doc, update);
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return null;
    const markdown = yDocToMarkdown(doc);
    const edits = editsNotInNote(doc, accepted[0], kept);
    if (edits.length === 0) return { markdown, notInNote: 0 };
    const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
    const section = notInNoteSection(edits).trimEnd().replaceAll("\n", lineBreak);
    const separator =
      markdown === "" ? "" : markdown.endsWith(lineBreak) ? lineBreak : `${lineBreak}${lineBreak}`;
    return { markdown: `${markdown}${separator}${section}${lineBreak}`, notInNote: edits.length };
  } finally {
    doc.destroy();
  }
}
