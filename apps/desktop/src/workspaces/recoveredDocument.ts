import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import {
  getDohcYDocBodyFragment,
  getDohcYDocFrontmatter,
  serializeRichdocBody,
  yDocToMarkdown,
} from "@dohc/ydoc-projection";

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
    }
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

const same = (left: unknown, right: unknown) => json(left ?? null) === json(right ?? null);

/**
 * The kept edits a rebuilt document dropped. Yjs merges a kept edit with
 * changes already accepted, and drops it from what a person sees when it was
 * typed into a block someone else deleted, or when it set a field or a
 * block's setting that someone else set at the same moment and theirs was
 * kept. Such content is in the document but deleted, and no kept update
 * deleted it. Formatting a kept edit added is not listed.
 */
function editsNotInNote(doc: Y.Doc, kept: readonly Uint8Array[]): NotInNote[] {
  const decoded = kept.map((update) => Y.decodeUpdate(update));
  const keptDeletes = Y.mergeDeleteSets(decoded.map(({ ds }) => ds));
  const body = getDohcYDocBodyFragment(doc);
  const frontmatter = doc.getMap("frontmatter");
  // Each item holding dropped kept content, with the offsets dropped. Yjs does
  // not split an item that was already deleted when a later kept update
  // deletes part of it, and an item can hold accepted content beside kept.
  const lost = new Map<Y.Item, Span[]>();
  const found: NotInNote[] = [];
  // Kept updates can repeat each other's content, so each clock is read once.
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
        // Collected with a block it was made in: its content is not in the document to show.
        if (!(part instanceof Y.Item)) found.push({ kind: "other" });
        else if (part.deleted) {
          const dropped = notDeleted(keptDeletes, client, clock, partEnd).map(
            ([start, stop]): Span => [start - part.id.clock, stop - part.id.clock],
          );
          if (dropped.length > 0) lost.set(part, [...(lost.get(part) ?? []), ...dropped]);
        }
        clock = partEnd;
      }
    }
  }

  const parentsWithText = new Set<Y.AbstractType<unknown>>();
  const elementsWithText = new Set<Y.Item>();
  for (const item of lost.keys()) {
    const parent = item.parent as Y.AbstractType<unknown>;
    if (item.parentSub !== null) {
      const value = contentValue(item);
      if (parent === frontmatter) {
        // A value set at the same moment was kept instead.
        const now = getDohcYDocFrontmatter(doc)[item.parentSub];
        if (!same(value, now)) found.push({ kind: "field", field: item.parentSub, value, now });
      } else if (
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
    let run = "";
    const flush = () => {
      if (run.trim() !== "") found.push({ kind: "text", text: run.trim() });
      run = "";
    };
    for (let item = parent._start; item; item = item.right) {
      if (item.content instanceof Y.ContentFormat) continue;
      const spans = item.content instanceof Y.ContentString ? lost.get(item) : undefined;
      if (spans === undefined || !(item.content instanceof Y.ContentString)) {
        flush();
        continue;
      }
      let at = 0;
      for (const [from, to] of spans) {
        if (from > at) flush();
        run += item.content.str.slice(from, to);
        at = to;
      }
      if (at < item.length) flush();
    }
    flush();
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

const shown = (value: unknown) =>
  value === undefined || value === null
    ? null
    : `“${typeof value === "string" || typeof value === "bigint" ? value : json(value)}”`;

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
      const block = edit.block === "" ? `a ${edit.nodeName}` : `“${quoteOf(edit.block)}”`;
      if (task)
        return [
          paragraph(
            `${edit.value === true ? "Ticked" : "Unticked"} ${block}. The note has it ${edit.now === true ? "ticked" : "unticked"}.`,
          ),
        ];
      const now = shown(edit.now);
      return [
        paragraph(
          `Set ${edit.name} to ${shown(edit.value) ?? "nothing"} on ${block}. The note has ${now ?? "no value"}.`,
        ),
      ];
    }
  }
}

/** The closing section of a recovery copy that lists kept edits the note above it has no place for. */
function notInNoteSection(edits: readonly NotInNote[]): string {
  const others = edits.filter((edit) => edit.kind === "other").length;
  const content: JSONContent[] = [
    { type: "horizontalRule" },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Kept edits that aren’t in this copy" }],
    },
    paragraph(
      "These edits were kept on the computer that made them. A change saved at the same moment removed or replaced the place they were made, so the note above doesn’t have them.",
    ),
    ...edits.flatMap((edit) => (edit.kind === "other" ? [] : entry(edit))),
    ...(others === 0
      ? []
      : [
          paragraph(
            others === 1
              ? "1 more kept edit, such as an image, can’t be shown as text."
              : `${others} more kept edits, such as images, can’t be shown as text.`,
          ),
        ]),
  ];
  return serializeRichdocBody({ type: "doc", content });
}

/**
 * The document `accepted` then `kept` rebuild, with a closing list of the
 * kept edits it has no place for. Null when an update still waits on what it
 * depends on, which would leave its edit out.
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
    const edits = editsNotInNote(doc, kept);
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
