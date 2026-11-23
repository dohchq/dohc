import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment, updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { getDohcProseMirrorSchema, markdownToYDoc } from "./import-export.js";
import { liveEditFitsCopy } from "./liveDocumentValidation.js";

const schema = getDohcProseMirrorSchema();
const NOTES = fileURLToPath(new URL("./fixtures/body-sequence.json", import.meta.url));
const documents = (JSON.parse(readFileSync(NOTES, "utf8")) as { document: unknown }[]).map(
  (note) => note.document,
);

function itemsInTexts(parent: Y.XmlFragment | Y.XmlElement) {
  const held = { lettersAndFormatting: 0, other: 0 };
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      const inside = itemsInTexts(child);
      held.lettersAndFormatting += inside.lettersAndFormatting;
      held.other += inside.other;
    } else if (child instanceof Y.XmlText)
      for (let item = child._start; item !== null; item = item.right) {
        if (item.deleted) continue;
        const letters = item.content instanceof Y.ContentString;
        if (letters || item.content instanceof Y.ContentFormat) held.lettersAndFormatting++;
        else held.other++;
      }
  }
  return held;
}

it("puts only letters and formatting in a paragraph's text when y-prosemirror writes a note", () => {
  let lettersAndFormatting = 0;
  for (const [at, document] of documents.entries()) {
    const doc = new Y.Doc({ gc: false });
    const body = getDohcYDocBodyFragment(doc);
    prosemirrorJSONToYXmlFragment(schema, document, body);
    expect(itemsInTexts(body).other, `note ${String(at)} as written`).toBe(0);

    const edited = schema.nodeFromJSON(documents[(at + 1) % documents.length]);
    doc.transact(() =>
      updateYFragment(doc, body, edited, { mapping: new Map(), isOMark: new Map() }),
    );
    const held = itemsInTexts(body);
    expect(held.other, `note ${String(at)} as edited`).toBe(0);
    lettersAndFormatting += held.lettersAndFormatting;
    doc.destroy();
  }
  expect(lettersAndFormatting).toBeGreaterThan(500);
});

it("refuses an edit that embeds an element or a value in a paragraph's text", () => {
  const note = markdownToYDoc("Hello **there** friend\n");
  const words = (page: Y.Doc) =>
    (page.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const fits = (edit: (page: Y.Doc) => void) => {
    const page = new Y.Doc();
    Y.applyUpdate(page, Y.encodeStateAsUpdate(note));
    const before = Y.encodeStateVector(page);
    edit(page);
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(note));
    return liveEditFitsCopy(copy, Y.encodeStateAsUpdate(page, before));
  };
  expect(fits((page) => words(page).insert(5, " again"))).toBe(true);
  expect(fits((page) => words(page).insertEmbed(1, new Y.XmlElement("image")))).toBe(false);
  expect(fits((page) => words(page).insertEmbed(1, new Y.Map()))).toBe(false);
  expect(fits((page) => words(page).insertEmbed(1, { image: "x" }))).toBe(false);
});
