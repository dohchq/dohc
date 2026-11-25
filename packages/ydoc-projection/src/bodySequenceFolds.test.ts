import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  recordsOfContainer,
} from "./bodySequenceGrammar.js";
import { writeNewBody } from "./bodySequenceWriter.js";
import { BODY_SEQUENCE_SCHEMA_VERSION, readBodySequence } from "./bodySequenceYjs.js";
import {
  getDohcProseMirrorSchema,
  markdownToYDoc,
  parseRichdocMarkdown,
  yDocToMarkdown,
} from "./import-export.js";

const schema = getDohcProseMirrorSchema();
const FILE = fileURLToPath(new URL("./fixtures/body-sequence-folds.json", import.meta.url));

type Document = { type: string; attrs?: Record<string, unknown>; content?: Document[] } & Record<
  string,
  unknown
>;

const base64 = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
const byNumber = (_container: unknown, index: number) => index.toString(36);

function formatTwo(markdown: string): Y.Doc {
  const doc = markdownToYDoc(markdown, { bodySequence: true, clientID: 1 });
  expect(doc.getMap("meta").get("schemaVersion")).toBe(BODY_SEQUENCE_SCHEMA_VERSION);
  return doc;
}

function byHand(write: (note: ReturnType<typeof stored>) => void): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.getMap("meta").set("schemaVersion", BODY_SEQUENCE_SCHEMA_VERSION);
  write(stored(doc));
  return doc;
}

function stored(doc: Y.Doc) {
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  const element = (name: string, attrs: Record<string, unknown>) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    return made;
  };
  return {
    line(type: string, path: string[], attrs: Record<string, unknown> = {}) {
      sequence.insertEmbed(sequence.length, element(BLOCK_ELEMENT, { type, path, ...attrs }), {});
    },
    text(text: string, marks: Record<string, unknown> = {}) {
      sequence.insert(sequence.length, text, marks);
    },
    item(name: string, attrs: Record<string, unknown>) {
      sequence.insertEmbed(sequence.length, element(name, attrs), {});
    },
    embedded(value: string) {
      sequence.insertEmbed(sequence.length, { value } as unknown as Y.XmlElement, {});
    },
    container(id: string, type: string, attrs: Record<string, unknown> = {}) {
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
        records.set(key, value);
    },
  };
}

const parsed = (markdown: string) =>
  schema.nodeFromJSON(parseRichdocMarkdown(markdown, "projection")).toJSON() as Document;

function written(document: Document): string {
  const doc = new Y.Doc();
  doc.getMap("meta").set("schemaVersion", 1);
  prosemirrorJSONToYXmlFragment(schema, document, getDohcYDocBodyFragment(doc));
  return yDocToMarkdown(doc);
}

function readInFormatTwo(document: Document): Document {
  const doc = new Y.Doc();
  doc.getMap("meta").set("schemaVersion", BODY_SEQUENCE_SCHEMA_VERSION);
  writeNewBody(schema, doc, schema.nodeFromJSON(document), byNumber);
  return readBodySequence(schema, doc).toJSON() as Document;
}

function withoutMarksBesideCode(node: Document): Document {
  const marks = node.marks as { type: string }[] | undefined;
  const code = marks?.find((mark) => mark.type === "code");
  return {
    ...node,
    ...(code ? { marks: [code] } : {}),
    ...(node.content ? { content: node.content.map(withoutMarksBesideCode) } : {}),
  };
}

function fold(name: string, before: Y.Doc, file: string, held = true) {
  const target = parsed(file);
  expect(written(target), name).toBe(file);
  const document = readInFormatTwo(held ? target : withoutMarksBesideCode(target));
  return {
    name,
    before: base64(before),
    target,
    file,
    after: { document, markdown: written(document) },
  };
}

const list = (items: string[]) => items.map((item) => `- ${item}\n`).join("");
const items = Array.from({ length: 100 }, (_, at) => `item ${String(at)}`);
const CODE_FENCE = "```";

function folds() {
  return [
    fold("a join", formatTwo("One\n\nTwo\n"), "OneTwo\n"),
    fold("a split", formatTwo("OneTwo\n"), "One\n\nTwo\n"),
    fold(
      "a new line above a line, which splits it at offset 0",
      formatTwo("# Title\n"),
      "Above\n\n# Title\n",
    ),
    fold(
      "a letter changed in a list of 100 items",
      formatTwo(list(items)),
      list(items.map((item, at) => (at === 50 ? "item 5O" : item))),
    ),
    fold(
      "the first item of a list deleted",
      formatTwo("- one\n- two\n- three\n"),
      "- two\n- three\n",
    ),
    fold("a kind change", formatTwo("Title\n\nBody\n"), "# Title\n\nBody\n"),
    fold("a wrap", formatTwo("a\n\nb\n"), "> a\n\nb\n"),
    fold("an unwrap", formatTwo("> a\n>\n> b\n"), "a\n\n> b\n"),
    fold(
      "an outdent that splits a container",
      formatTwo("- a\n  - b\n  - c\n  - d\n"),
      "- a\n  - b\n- c\n  - d\n",
    ),
    fold("a tick", formatTwo("- [ ] a\n- [ ] b\n"), "- [x] a\n- [ ] b\n"),
    fold(
      "text before the first boundary, left alone",
      byHand((note) => {
        note.text("Start");
        note.line("paragraph", []);
        note.text("Next");
      }),
      "Start\n\nNext!\n",
    ),
    fold(
      "text before the first boundary, edited",
      byHand((note) => {
        note.text("Start");
        note.line("paragraph", []);
        note.text("Next");
      }),
      "Started\n\nNext\n",
    ),
    ...[
      ["left alone", `- \n  ${CODE_FENCE}\n  code\n  ${CODE_FENCE}\n\nAfter!\n`],
      ["with its item's code block deleted", "- \n\nAfter\n"],
      ["with its item's code block retyped", "- code\n\nAfter\n"],
    ].map(([how, file]) =>
      fold(
        `a list item's added first paragraph, ${how!}`,
        byHand((note) => {
          note.container("l", "bulletList");
          note.container("i", "listItem");
          note.line("codeBlock", ["l", "i"], { language: null });
          note.text("code");
          note.line("paragraph", []);
          note.text("After");
        }),
        file!,
      ),
    ),
    ...[
      ["left alone", `${CODE_FENCE}\ncode\n${CODE_FENCE}\n\n![a](b.png)\n\nAfter!\n`],
      ["with the code block it follows deleted", "![a](b.png)\n\nAfter\n"],
      ["with the code block it follows retyped", "code\n\n![a](b.png)\n\nAfter\n"],
    ].map(([how, file]) =>
      fold(
        `the paragraph after a code block, ${how!}`,
        byHand((note) => {
          note.line("codeBlock", [], { language: null });
          note.text("code");
          note.item("image", { src: "b.png", alt: "a", title: null });
          note.line("paragraph", []);
          note.text("After");
        }),
        file!,
      ),
    ),
    fold("bold added", formatTwo("One bold word\n"), "One **bold** word\n"),
    fold("bold taken off", formatTwo("One **bold** word\n"), "One bold word\n"),
    fold(
      "a link's address changed",
      formatTwo("See [this](https://example.com) page\n"),
      "See [this](https://example.org) page\n",
    ),
    fold("an emoji edited in its middle", formatTwo("Smile 😀 now\n"), "Smile 😃 now\n"),
    fold(
      "an item the reader skips, at an edit",
      byHand((note) => {
        note.line("paragraph", []);
        note.text("ab");
        note.embedded("skipped");
        note.text("cd");
      }),
      "abXcd\n",
    ),
    ...[
      ["the line between them edited", "> a\n\nmiddle!\n\n> b\n"],
      ["the second one made a callout", "> a\n\nmiddle\n\n> [!note]\n> b\n"],
    ].map(([how, file]) =>
      fold(
        `one id on two quotes, ${how!}`,
        byHand((note) => {
          note.container("q", "blockquote");
          note.line("paragraph", ["q"]);
          note.text("a");
          note.line("paragraph", []);
          note.text("middle");
          note.line("paragraph", ["q"]);
          note.text("b");
        }),
        file!,
      ),
    ),
    fold("a whole file replaced", formatTwo("# A\n\nB\n"), "- x\n- y\n\n> z\n"),
    fold(
      "code inside a link, which format 2 holds as code alone",
      formatTwo("Run it first\n"),
      "Run [`npm install`](https://example.com) first\n",
      false,
    ),
  ];
}

it("writes each fold's note, the document it folds onto and what that note reads as after", () => {
  const made = folds();
  if (process.env.BODY_SEQUENCE_WRITE_FIXTURES === "1")
    writeFileSync(FILE, `${JSON.stringify(made, null, 2)}\n`);
  expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(made);
});
