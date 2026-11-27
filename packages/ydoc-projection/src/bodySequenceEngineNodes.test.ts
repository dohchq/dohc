import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { bodySequenceEngineNodes } from "./bodySequenceIntake.js";
import { MAX_PROJECTION_NODES } from "./liveValidationPolicy.js";
import { BLOCK_ELEMENT, BODY_CONTAINERS_FIELD, BODY_SEQUENCE_FIELD } from "./bodySequenceStore.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const opened = (update: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(update, "base64"));
  return doc;
};

function note(build: (put: Put) => void, records: Record<string, unknown> = {}): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("meta").set("schemaVersion", 2);
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const containers = doc.getMap(BODY_CONTAINERS_FIELD);
  for (const [key, value] of Object.entries(records)) containers.set(key, value);
  const element = (name: string, attrs: Record<string, unknown>) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    sequence.insertEmbed(sequence.length, made, {});
  };
  build({
    line: (type, path = [], attrs = {}) => element(BLOCK_ELEMENT, { type, path, ...attrs }),
    item: (name) => element(name, {}),
    letters: (text, marks = {}) => sequence.insert(sequence.length, text, marks),
  });
  return doc;
}
interface Put {
  line(type: string, path?: string[], attrs?: Record<string, unknown>): void;
  item(name: string): void;
  letters(text: string, marks?: Record<string, unknown>): void;
}
const times = (count: number, each: (at: number) => void) => {
  for (let at = 0; at < count; at++) each(at);
};

describe("the nodes the engine's Markdown writer spends reading a format-2 body", () => {
  it("are what the engine spends for each note made from a fixture's Markdown", () => {
    const written = fixture("body-sequence-written.json") as {
      name: string;
      update: string;
      engineNodes: number;
    }[];
    expect(written).toHaveLength(23);
    for (const { name, update, engineNodes } of written)
      expect([name, bodySequenceEngineNodes(opened(update))]).toEqual([name, engineNodes]);
  });

  it("are the 1,116 the engine spends for a note two people edited at length", () => {
    const { update } = fixture("body-sequence-edited.json") as { update: string };
    expect(bodySequenceEngineNodes(opened(update))).toBe(1_116);
  });

  it("are one for an empty note, and one more for a paragraph the engine adds", () => {
    expect(bodySequenceEngineNodes(note(() => {}))).toBe(1);
    expect(bodySequenceEngineNodes(note((put) => put.letters("x")))).toBe(2);
    const afterRules = note((put) =>
      times(50, () => {
        put.line("horizontalRule");
        put.letters("x");
      }),
    );
    expect(bodySequenceEngineNodes(afterRules)).toBe(50 * 3);
  });

  it("charge at most 64 entries of a path, and each container it opens", () => {
    const ids = Array.from({ length: 70 }, (_, depth) => `q${depth}`);
    const quotes = Object.fromEntries(ids.map((id) => [id, "blockquote"]));
    const deep = note((put) => put.line("paragraph", ids), quotes);
    expect(bodySequenceEngineNodes(deep)).toBe(64 + 64 + 1);
  });

  it("charge a paragraph for each list item that starts with another block", () => {
    const items = Array.from({ length: 50 }, (_, at) => `i${at}`);
    const records = { L: "bulletList", ...Object.fromEntries(items.map((id) => [id, "listItem"])) };
    const headings = note((put) => items.forEach((id) => put.line("heading", ["L", id])), records);
    const [list, entries, item, firstParagraph, heading] = [1, 2, 1, 1, 1];
    expect(bodySequenceEngineNodes(headings)).toBe(
      list + 50 * (entries + item + firstParagraph + heading),
    );
  });

  it("charge a container's attribute each time it opens", () => {
    const callouts = note(
      (put) =>
        times(20, () => {
          put.line("paragraph", ["c"]);
          put.line("paragraph");
        }),
      { c: "callout", "c.title": "Title" },
    );
    const [entry, callout, itsTitle, paragraph] = [1, 1, 1, 1];
    expect(bodySequenceEngineNodes(callouts)).toBe(
      20 * (entry + callout + itsTitle + paragraph + paragraph),
    );
  });

  it("charge each run that alternating marks make, with its copy of the marks", () => {
    const alternating = note((put) =>
      times(100, () => {
        put.letters("x", { bold: {} });
        put.letters("y");
      }),
    );
    const [paragraph, aRun, itsBold] = [1, 1, 1];
    expect(bodySequenceEngineNodes(alternating)).toBe(paragraph + 100 * (aRun + itsBold + aRun));
  });

  it("charge a link and each attribute it stores again for every run that copies it", () => {
    const link = { link: { href: "https://example.com" } };
    const cut = note((put) =>
      times(21, (run) => {
        if (run > 0) put.item("hardBreak");
        put.letters("x", link);
      }),
    );
    const [paragraph, aRun, itsLink, itsHref, aBreak] = [1, 1, 1, 1, 1];
    expect(bodySequenceEngineNodes(cut)).toBe(
      paragraph + 21 * (aRun + itsLink + itsHref) + 20 * aBreak,
    );
  });

  it("are the engine's budget less one for 4,032 lines inside 63 quotes", () => {
    const ids = Array.from({ length: 63 }, (_, depth) => depth.toString(16));
    const quotes = Object.fromEntries(ids.map((id) => [id, "blockquote"]));
    const quoted = note(
      (put) =>
        times(4_032, () => {
          put.line("paragraph", ids);
          put.letters("a");
        }),
      quotes,
    );
    expect(bodySequenceEngineNodes(quoted)).toBe(MAX_PROJECTION_NODES - 1);
  });
});
