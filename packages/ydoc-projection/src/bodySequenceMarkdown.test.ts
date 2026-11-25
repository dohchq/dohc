import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import {
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  flattenBody,
  recordsOfContainer,
} from "./bodySequenceGrammar.js";
import { newBodyWeight, writeNewBody } from "./bodySequenceWriter.js";
import { boundaryOf, holdsBodySequence, readBodySequence, storedValue } from "./bodySequenceYjs.js";
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  markdownToYDoc,
  yDocToMarkdown,
} from "./import-export.js";
import {
  admitBodySequenceNotes,
  createLiveMarkdownRegistrationValidator,
} from "./liveDocumentValidation.js";
import {
  fitsLiveNoteCapacity,
  liveNoteWeight,
  WORKER_LIVE_VALIDATION_POLICY,
} from "./liveValidationPolicy.js";

const schema = getDohcProseMirrorSchema();
const register = createLiveMarkdownRegistrationValidator(WORKER_LIVE_VALIDATION_POLICY);
beforeAll(() => admitBodySequenceNotes(true));
afterAll(() => admitBodySequenceNotes(false));

const made: Y.Doc[] = [];
afterEach(() => {
  for (const doc of made.splice(0)) doc.destroy();
});

type Reading = "source" | "projection";
const CLIENT = 7;
const kept = (doc: Y.Doc) => {
  made.push(doc);
  return doc;
};
const inFormat1 = (markdown: string, reading: Reading = "source") =>
  kept(markdownToYDoc(markdown, { clientID: CLIENT, reading }));
const inFormat2 = (markdown: string, reading: Reading = "source") =>
  kept(markdownToYDoc(markdown, { clientID: CLIENT, reading, bodySequence: true }));
const byNumber = (_container: unknown, index: number) => index.toString(36);
const marker = (doc: Y.Doc) => storedValue(doc.share.get("meta"), "schemaVersion");

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const underBody = (doc: Y.Doc) =>
  yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(doc), schema).toJSON() as unknown;
const inSequence = (doc: Y.Doc) => readBodySequence(schema, doc).toJSON() as unknown;

function registered(doc: Y.Doc) {
  const checkpoint = Y.encodeStateAsUpdate(doc);
  const result = register({
    document: {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: sha(checkpoint),
    },
    currentPath: "notes/made.md",
    checkpoint,
  });
  return result.kind === "accepted"
    ? { kind: "accepted", markdown: result.evidence.projectedMarkdown }
    : { kind: `refused: ${result.reason}` };
}

const ONE_EMPTY_LINE = { type: "doc", content: [{ type: "paragraph" }] };

function expectTheSameNote(markdown: string, reading: Reading = "source"): string {
  const first = inFormat1(markdown, reading);
  const second = inFormat2(markdown, reading);
  expect(holdsBodySequence(second)).toBe(true);
  expect(second.share.has("body")).toBe(false);
  const parsed = yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(first), schema);
  const alone = kept(new Y.Doc());
  writeNewBody(schema, alone, parsed, byNumber);
  expect(newBodyWeight(schema, parsed)).toEqual(liveNoteWeight(alone));
  const held = underBody(first);
  expect(inSequence(second)).toEqual(
    getDohcYDocBodyFragment(first).length === 0 ? ONE_EMPTY_LINE : held,
  );
  const written = yDocToMarkdown(first);
  expect(yDocToMarkdown(second)).toBe(written);
  expect(registered(second)).toEqual({ kind: "accepted", markdown: written });
  return written;
}

type Fixture = { name: string } & ({ markdown: string } | { markdownNotCompared: string });
const fixtures = (
  JSON.parse(
    readFileSync(new URL("./fixtures/body-sequence.json", import.meta.url), "utf8"),
  ) as Fixture[]
).flatMap((fixture) => ("markdown" in fixture ? [[fixture.name, fixture.markdown] as const] : []));

const NOT_GIVEN_BACK: Record<string, string> = {
  "every mark, alone, together and where it means nothing":
    "the text __proto__ is written with no escape, and reads back as bold",
  "every block that holds no blocks":
    "an empty heading above an empty paragraph is written as blank lines, which read as one empty paragraph",
  "what a tableCell holds": "a quote in a table cell is written on one row, where > reads as text",
  "what a tableHeader holds":
    "a quote in a table cell is written on one row, where > reads as text",
  "every attribute as numbers, as BigInt and as values a reader repairs":
    "a list stored as loose whose items hold one paragraph each reads back as a tight list",
};

describe("the Markdown each stored fixture note is written as, read into a format-2 note", () => {
  it("covers every fixture that records its Markdown", () => {
    expect(fixtures).toHaveLength(22);
  });

  it.each(fixtures)(
    "%s: reads as the document format 1 holds, is written as the same Markdown, and is registered",
    (name, markdown) => {
      const written = expectTheSameNote(markdown);
      if (!Object.hasOwn(NOT_GIVEN_BACK, name)) expect(written).toBe(markdown);
      else expect(written).not.toBe(markdown);
    },
  );
});

const corpus = JSON.parse(
  readFileSync(
    new URL("../../../tools/rust-engine-program/nested-markdown-contract.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    name: string;
    source: string;
    canonical?: string;
    sourceCanonical?: string;
    refuse?: boolean;
    projected?: boolean;
  }[];
};

const NOT_HELD: Record<string, string> = {
  "quote-after-lists": "its last line sits in 66 containers, and a note holds lines in at most 64",
};

describe("the shared Markdown corpus, read into format-2 notes", () => {
  it("covers every case of the contract", () => {
    expect(corpus.cases).toHaveLength(363);
    expect(corpus.cases.filter((item) => item.refuse)).toHaveLength(27);
  });

  it.each(corpus.cases)(
    "$name: the contract's Markdown, or its refusal, as for format 1",
    ({ name, source, canonical, sourceCanonical, refuse, projected }) => {
      const reading = projected ? "projection" : "source";
      if (refuse) {
        expect(() => inFormat2(source, reading)).toThrow(/not representable/);
        return;
      }
      if (Object.hasOwn(NOT_HELD, name)) {
        const doc = inFormat2(source, reading);
        expect(marker(doc)).toBe(1);
        expect(yDocToMarkdown(doc)).toBe(sourceCanonical ?? canonical);
        return;
      }
      expect(expectTheSameNote(source, reading)).toBe(sourceCanonical ?? canonical);
    },
  );
});

describe("a format-2 note made from Markdown", () => {
  const SEVERAL_KINDS = [
    "---",
    "status: draft",
    "---",
    "",
    "# Trip plan",
    "",
    "Pack the **bags** and see [the list](https://example.com/list) tonight.",
    "",
    "- one",
    "  - under one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "- [ ] tickets",
    "- [x] passports",
    "",
    "> [!note] Note",
    "> Gate closes at $t_0$",
    "",
    "> quoted",
    "",
    "| a   | b   |",
    "| --- | --- |",
    "| 1   | 2   |",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "---",
    "",
    "The end",
    "",
  ].join("\n");

  it("holds the marker 2, nothing under body, a boundary with its kind and path for every line, and every record of each container", () => {
    const doc = inFormat2(SEVERAL_KINDS);
    expect(marker(doc)).toBe(2);
    expect(doc.share.has("body")).toBe(false);
    const leaves = flattenBody(readBodySequence(schema, doc), byNumber);
    expect(leaves.length).toBeGreaterThan(12);
    const boundaries: unknown[] = [];
    for (let item = doc.getText(BODY_SEQUENCE_FIELD)._start; item !== null; item = item.right) {
      const boundary = boundaryOf(item);
      if (boundary) boundaries.push(boundary.getAttributes());
    }
    expect(boundaries).toEqual(
      leaves.map((leaf) => ({
        ...leaf.attrs,
        type: leaf.type,
        path: leaf.path.map((frame) => frame.id),
      })),
    );
    const containers = new Map(
      leaves.flatMap((leaf) => leaf.path).map((frame) => [frame.id, frame]),
    );
    expect([...containers.values()].map((frame) => frame.type).sort()).toEqual(
      [
        "blockquote",
        "bulletList",
        "bulletList",
        "callout",
        "listItem",
        "listItem",
        "listItem",
        "listItem",
        "listItem",
        "orderedList",
        "table",
        "tableCell",
        "tableCell",
        "tableHeader",
        "tableHeader",
        "tableRow",
        "tableRow",
        "taskItem",
        "taskItem",
        "taskList",
      ].sort(),
    );
    const records = doc.getMap(BODY_CONTAINERS_FIELD);
    let checked = 0;
    for (const frame of containers.values())
      for (const [key, value] of recordsOfContainer(schema, frame)) {
        expect(storedValue(records, key), key).toEqual(value);
        checked++;
      }
    expect(records.size).toBe(checked);
    expect(storedValue(records, "0")).toBe("bulletList");
  });

  it("is the same bytes from every device that makes it from one text under one client", () => {
    const once = Y.encodeStateAsUpdate(inFormat2(SEVERAL_KINDS));
    const again = Y.encodeStateAsUpdate(inFormat2(SEVERAL_KINDS));
    expect(sha(again)).toBe(sha(once));
    expect(sha(Y.encodeStateAsUpdate(inFormat1(SEVERAL_KINDS)))).not.toBe(sha(once));
  });

  it("holds the same properties and metadata as a format-1 note, but for the marker, also for a file with CRLF line ends", () => {
    for (const markdown of [SEVERAL_KINDS, SEVERAL_KINDS.replaceAll("\n", "\r\n")]) {
      const first = inFormat1(markdown);
      const second = inFormat2(markdown);
      expect(getDohcYDocFrontmatter(second)).toEqual(getDohcYDocFrontmatter(first));
      expect(Object.fromEntries(second.getMap("meta").entries())).toEqual({
        ...Object.fromEntries(first.getMap("meta").entries()),
        schemaVersion: 2,
      });
      expect(expectTheSameNote(markdown)).toBe(markdown);
    }
  });

  it("made from text that is not written that way keeps the text beside it, and the relay's check finds the text is the note's", () => {
    const source = "* one\n* two\n\nSetext\n======\n";
    const doc = inFormat2(source);
    const projection = yDocToMarkdown(doc);
    expect(projection).toBe("- one\n- two\n\n# Setext\n");
    const meta = doc.getMap("meta");
    meta.set("dohcMarkdownSource", source);
    meta.set("dohcMarkdownSourceSha256", sha(source));
    meta.set("dohcMarkdownSourceProjectionSha256", sha(projection));
    expect(registered(doc)).toEqual({ kind: "accepted", markdown: source });
  });

  it("of an empty file holds no item in its sequence, and reads as one empty line", () => {
    for (const markdown of ["", "---\nstatus: draft\n---\n"]) {
      const doc = inFormat2(markdown);
      expect(doc.share.get(BODY_SEQUENCE_FIELD)?._start ?? null).toBeNull();
      expect(inSequence(doc)).toEqual(ONE_EMPTY_LINE);
      expect(expectTheSameNote(markdown)).toBe(markdown);
    }
  });
});

const TABLE = "| a   |\n| --- |\n| 1   |\n";

function expectFormat1(markdown: string): void {
  const asked = inFormat2(markdown);
  expect(marker(asked)).toBe(1);
  expect(sha(Y.encodeStateAsUpdate(asked))).toBe(sha(Y.encodeStateAsUpdate(inFormat1(markdown))));
}

describe("what format 2 cannot hold as the Markdown says it, made in format 1", () => {
  it.each([
    ["inline code under a link", "Run [`npm install`](https://docs.example/install) first.\n"],
    ["inline code under bold", "A **`flag`** here.\n"],
    ["a row height over the limit", `<!-- dohc:table row-heights=1:1000001 -->\n${TABLE}`],
    ["a callout type that holds a line separator", "> [!no te] Title\n> body\n"],
  ])("%s: format 1 keeps it, and format 2 would read it otherwise", (_what, markdown) => {
    const first = inFormat1(markdown);
    expect(yDocToMarkdown(first)).toBe(markdown);
    const parsed = yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(first), schema);
    expect(newBodyWeight(schema, parsed)).toBeNull();
    expectFormat1(markdown);
  });

  it("a row height at the limit is held", () => {
    const markdown = `<!-- dohc:table row-heights=1:1000000 -->\n${TABLE}`;
    expect(expectTheSameNote(markdown)).toBe(markdown);
  });

  it("a line inside 65 quotes, where one inside 64 is held", () => {
    const quoted = (depth: number) => `${"> ".repeat(depth)}deep\n`;
    expect(expectTheSameNote(quoted(64))).toBe(quoted(64));
    expect(yDocToMarkdown(inFormat1(quoted(65)))).toBe(quoted(65));
    expectFormat1(quoted(65));
  });

  it("a note past the relay's capacity in format 2 that fits it in format 1, and the relay registers that note", () => {
    const markdown = "a\n\n".repeat(29_000);
    const first = inFormat1(markdown);
    const parsed = yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(first), schema);
    const weight = newBodyWeight(schema, parsed)!;
    expect(fitsLiveNoteCapacity(weight, WORKER_LIVE_VALIDATION_POLICY)).toBe(false);
    expectFormat1(markdown);
    const projection = yDocToMarkdown(first);
    const meta = first.getMap("meta");
    meta.set("dohcMarkdownSource", markdown);
    meta.set("dohcMarkdownSourceSha256", sha(markdown));
    meta.set("dohcMarkdownSourceProjectionSha256", sha(projection));
    expect(registered(first)).toEqual({ kind: "accepted", markdown });
  });
});

describe("the format a note is made in", () => {
  it("is format 1 unless format 2 is asked for", () => {
    const markdown = "# Title\n\nBody\n";
    const byDefault = inFormat1(markdown);
    expect(marker(byDefault)).toBe(1);
    expect(byDefault.share.get("body")?._start ?? null).not.toBeNull();
    expect(byDefault.share.has(BODY_SEQUENCE_FIELD)).toBe(false);
    const asked = kept(markdownToYDoc(markdown, { clientID: CLIENT, bodySequence: false }));
    expect(sha(Y.encodeStateAsUpdate(asked))).toBe(sha(Y.encodeStateAsUpdate(byDefault)));
  });
});

describe("the reference writer's whole body", () => {
  it("is refused for a note that already holds a body, in its sequence or in its records", () => {
    const written = inFormat2("one\n");
    const body = readBodySequence(schema, written);
    expect(() => writeNewBody(schema, written, body, byNumber)).toThrow(/already holds/);
    const recorded = kept(new Y.Doc());
    recorded.getMap(BODY_CONTAINERS_FIELD).set("q", "blockquote");
    expect(() => writeNewBody(schema, recorded, body, byNumber)).toThrow(/already holds/);
    const fresh = kept(new Y.Doc());
    writeNewBody(schema, fresh, body, byNumber);
    expect(readBodySequence(schema, fresh).toJSON()).toEqual(body.toJSON());
  });
});
