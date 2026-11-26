import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, parseRichdocMarkdown } from "./import-export.js";
import { writeNewBody } from "./bodySequenceWriter.js";
import { schema } from "./bodySequenceTestSupport.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  bodySequenceOpensWithH1,
  bodySequenceReading,
  declareBodySequence,
} from "./bodySequenceStore.js";

function firstBoundary(doc: Y.Doc): Y.XmlElement {
  for (let item = doc.getText("sequence")._start; item; item = item.right) {
    const content = item.content;
    if (!item.deleted && content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
      if (content.type.nodeName === "block") return content.type;
  }
  throw new Error("The note has no boundary.");
}

function readsAsH1(doc: Y.Doc): boolean {
  const first = readBodySequence(schema, doc).firstChild!;
  return first.type.name === "heading" && first.attrs.level === 1;
}

function opensWithH1(doc: Y.Doc): boolean {
  const answer = bodySequenceOpensWithH1(doc);
  expect(answer).toBe(readsAsH1(doc));
  return answer;
}

const note = (markdown: string) => markdownToYDoc(markdown, { bodySequence: true });

describe("bodySequenceOpensWithH1", () => {
  it.each([
    ["# Title\n\nBody", true],
    ["## Title", false],
    ["> # Title", false],
    ["- # Title", false],
    ["- [ ] # Title", false],
    ["Intro\n\n# Title", false],
    ["| # a |\n| --- |\n| b |", false],
    ["", false],
  ])("reads %j as the reader does", (markdown, expected) => {
    expect(opensWithH1(note(markdown))).toBe(expected);
  });

  it("follows a level changed in place and back", () => {
    const doc = note("# Title");
    const boundary = firstBoundary(doc);
    boundary.setAttribute("level", 2 as never);
    expect(opensWithH1(doc)).toBe(false);
    boundary.setAttribute("level", 1n as never);
    expect(opensWithH1(doc)).toBe(true);
    boundary.setAttribute("level", 7 as never);
    expect(opensWithH1(doc)).toBe(true);
    boundary.setAttribute("level", "2" as never);
    expect(opensWithH1(doc)).toBe(true);
  });

  it("reads an unknown kind as a paragraph", () => {
    const doc = note("# Title");
    firstBoundary(doc).setAttribute("type", "chapter" as never);
    expect(opensWithH1(doc)).toBe(false);
  });

  it("keeps a heading at the top level when its path names no container it can sit in", () => {
    const doc = note("- a");
    const list = (firstBoundary(doc).getAttribute("path") as unknown as string[])[0]!;
    const heading = note("# Title");
    const boundary = firstBoundary(heading);
    heading.getMap("containers").set(list, "bulletList");
    boundary.setAttribute("path", [list] as never);
    expect(opensWithH1(heading)).toBe(true);
    boundary.setAttribute("path", [list, "missing"] as never);
    expect(opensWithH1(heading)).toBe(true);
    heading.getMap("containers").set("missing", "listItem");
    expect(opensWithH1(heading)).toBe(false);
  });

  it("reads text before the first boundary as a paragraph", () => {
    const doc = note("# Title");
    doc.getText("sequence").insert(0, "x");
    expect(opensWithH1(doc)).toBe(false);
  });
});

describe("declareBodySequence", () => {
  it("keeps formatting a remote delete leaves, with no editor on the note", () => {
    const base = Y.encodeStateAsUpdate(note("abc"));
    const copy = () => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, base);
      return doc;
    };
    const bolder = copy();
    const deleter = copy();
    const mirror = new Y.Doc();
    declareBodySequence(mirror);
    Y.applyUpdate(mirror, base, "remote");
    const sent: Uint8Array[] = [];
    mirror.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") sent.push(update);
    });
    bolder.getText("sequence").format(2, 1, { bold: {} });
    deleter.getText("sequence").delete(2, 1);
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(bolder, Y.encodeStateVector(copy())), "remote");
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(deleter, Y.encodeStateVector(copy())), "remote");
    expect(sent).toEqual([]);
  });
});

describe("bodySequenceReading", () => {
  const markdown = "Plan **bold**\n\n- one\n  - two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote";
  const renamed = (text: string) => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", 2);
    const body = schema.nodeFromJSON(parseRichdocMarkdown(text, "projection"));
    writeNewBody(schema, doc, body, (_container, index) => `other${index}`);
    return doc;
  };

  it("reads the same for one body, whatever its container ids and however its items are split", () => {
    const imported = note(markdown);
    const sequence = imported.getText("sequence");
    sequence.insert(2, "x");
    sequence.delete(2, 1);
    expect(bodySequenceReading(renamed(markdown))).toBe(bodySequenceReading(imported));
  });

  it.each([
    markdown.replace("**bold**", "bold"),
    markdown.replace("  - two", "- two"),
    markdown.replace("| 1 |", "| 9 |"),
    markdown.replace("> quote", "quote"),
  ])("reads differently when the body differs: %j", (changed) => {
    expect(bodySequenceReading(note(changed))).not.toBe(bodySequenceReading(note(markdown)));
  });
});
