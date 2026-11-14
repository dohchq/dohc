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
  | { kind: "attribute"; block: string; nodeName: string; name: string; value: unknown; now: unknown }
  | { kind: "other" };

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

/**
 * The kept edits a rebuilt document dropped. Yjs merges a kept edit with
 * changes already accepted, and drops it from what a person sees when it was
 * typed into a block someone else deleted, or when it set a field or a
 * block's setting that someone else set at the same moment and theirs was
 * kept. Each such item is in the document but deleted, and no kept update
 * deleted it. Formatting a kept edit added is not listed.
 */
function editsNotInNote(doc: Y.Doc, kept: readonly Uint8Array[]): NotInNote[] {
  const decoded = kept.map((update) => Y.decodeUpdate(update));
  const deletedByKept = (id: Y.ID) => decoded.some(({ ds }) => Y.isDeleted(ds, id));
  const body = getDohcYDocBodyFragment(doc);
  const frontmatter = doc.getMap("frontmatter");
  const lost = new Set<Y.Item>();
  const found: NotInNote[] = [];
  for (const { structs } of decoded)
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      // The document can hold an update's struct as several items.
      for (let clock = struct.id.clock; clock < struct.id.clock + struct.length; ) {
        const part = Y.getItem(doc.store, Y.createID(struct.id.client, clock));
        // Collected with a block it was made in: its content is not in the document to show.
        if (!(part instanceof Y.Item)) found.push({ kind: "other" });
        else if (part.deleted && !deletedByKept(part.id)) lost.add(part);
        clock = part.id.clock + part.length;
      }
    }

  const parentsWithText = new Set<Y.AbstractType<unknown>>();
  const elementsWithText = new Set<Y.Item>();
  for (const item of lost) {
    const parent = item.parent as Y.AbstractType<unknown>;
    if (item.parentSub !== null) {
      // A field or a block's setting whose holder still shows: a value set at the same moment was kept instead.
      if (parent === frontmatter) {
        found.push({
          kind: "field",
          field: item.parentSub,
          value: contentValue(item),
          now: getDohcYDocFrontmatter(doc)[item.parentSub],
        });
      } else if (
        parent instanceof Y.XmlElement &&
        !parent._item?.deleted &&
        rootOf(item.parent as Y.AbstractType<unknown>) === body
      ) {
        found.push({
          kind: "attribute",
          block: plainText(item.parent as Y.AbstractType<unknown>),
          nodeName: parent.nodeName,
          name: item.parentSub,
          value: contentValue(item),
          now: parent.getAttribute(item.parentSub),
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
      if (lost.has(item) && item.content instanceof Y.ContentString) run += item.content.str;
      else flush();
    }
    flush();
  }
  // Something added with settings but no text, such as an image, a formula or an embed. An empty paragraph is not listed.
  for (const item of lost) {
    if (item.parentSub !== null || rootOf(item.parent as Y.AbstractType<unknown>) !== body) continue;
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
      !(content.type instanceof Y.XmlElement && Object.keys(content.type.getAttributes()).length > 0)
    )
      continue;
    found.push({ kind: "other" });
  }
  return found;
}

const shown = (value: unknown) =>
  value === undefined || value === null
    ? null
    : `“${typeof value === "string" ? value : JSON.stringify(value)}”`;

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
          content: edit.text.split("\n").filter((line) => line !== "").map(paragraph),
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
      const block = edit.block === "" ? `a ${edit.nodeName}` : `“${quoteOf(edit.block)}”`;
      if (edit.nodeName === "taskItem" && edit.name === "checked")
        return [
          paragraph(
            edit.value === true
              ? `Ticked ${block}. The note has it unticked.`
              : `Unticked ${block}. The note has it ticked.`,
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
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Kept edits that aren’t in this copy" }] },
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
    const separator = markdown === "" ? "" : markdown.endsWith(lineBreak) ? lineBreak : `${lineBreak}${lineBreak}`;
    return { markdown: `${markdown}${separator}${section}${lineBreak}`, notInNote: edits.length };
  } finally {
    doc.destroy();
  }
}
