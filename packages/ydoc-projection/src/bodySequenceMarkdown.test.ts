import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { flattenBody, recordsOfContainer } from "./bodySequenceGrammar.js";
import { newBodyWeight, writeNewBody } from "./bodySequenceWriter.js";
import { boundaryOf, readBodySequence } from "./bodySequenceYjs.js";
import { engineReadOfFrontmatter } from "./frontmatter-map.js";
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
  fitsNewNote,
  LIVE_NOTE_CAPACITY,
  LIVE_NOTE_ELEMENT_WEIGHT,
  liveNoteWeight,
  MAX_PROJECTION_BYTES,
  MAX_PROJECTION_NODES,
  type NewNoteCounts,
  SAVE_VISITS_OUTSIDE_A_MARK,
  SAVE_VISITS_PER_READ,
  WORKER_LIVE_VALIDATION_POLICY,
} from "./liveValidationPolicy.js";
import * as ordered from "./orderedLiveUpdateCut.js";
import {
  type OrderedLiveUpdateCutUsage,
  readLiveUpdateAsTheCutDoes,
} from "./orderedLiveUpdateCut.js";
import {
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  BODY_SEQUENCE_SCHEMA_VERSION,
  holdsBodySequence,
  storedValue,
} from "./bodySequenceStore.js";

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

function registeredWithVisits(doc: Y.Doc) {
  const actual = ordered.validateRegistrationCutForProjection;
  let usage: OrderedLiveUpdateCutUsage | undefined;
  const registration = vi
    .spyOn(ordered, "validateRegistrationCutForProjection")
    .mockImplementation((...args) => {
      const result = actual(...args);
      if (result.kind !== "accepted") return result;
      const finish = result.cut.finishAfterProjection;
      return {
        ...result,
        cut: {
          ...result.cut,
          finishAfterProjection: () => {
            const finished = finish();
            if (finished.kind === "accepted") usage = finished.usage;
            return finished;
          },
        },
      };
    });
  try {
    return { registered: registered(doc), usage };
  } finally {
    registration.mockRestore();
  }
}

function saveVisits(doc: Y.Doc): OrderedLiveUpdateCutUsage {
  const { registered, usage } = registeredWithVisits(doc);
  expect(registered.kind).toBe("accepted");
  return usage!;
}

function oneRead(doc: Y.Doc): OrderedLiveUpdateCutUsage {
  const read = readLiveUpdateAsTheCutDoes(
    Y.encodeStateAsUpdate(doc),
    WORKER_LIVE_VALIDATION_POLICY,
  );
  if (read.kind === "refused") throw new Error(read.reason);
  return read.usage;
}

const parsedBody = (markdown: string, reading: Reading = "source") =>
  yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(inFormat1(markdown, reading)), schema);

function formatTwoProperties(): Y.Doc {
  const doc = kept(new Y.Doc());
  doc.getMap("meta").set("schemaVersion", BODY_SEQUENCE_SCHEMA_VERSION);
  return doc;
}

const saveVisitsOf = (outside: number, inside: number, perRead: number) =>
  SAVE_VISITS_OUTSIDE_A_MARK * outside + perRead * inside;

function expectTheCountsOfWhatIsWritten(markdown: string, reading: Reading): void {
  const parsed = parsedBody(markdown, reading);
  const counts = newBodyWeight(schema, parsed, byNumber)!;
  const bare = formatTwoProperties();
  const alone = formatTwoProperties();
  writeNewBody(schema, alone, parsed, byNumber);
  const added = <T extends object>(of: (doc: Y.Doc) => T) => {
    const [whole, properties] = [of(alone), of(bare)];
    return (key: keyof T) => (whole[key] as number) - (properties[key] as number);
  };
  const weight = added(liveNoteWeight);
  expect([counts.structs, counts.elements]).toEqual([weight("structs"), weight("elements")]);
  const read = added(oneRead);
  expect([
    counts.structs,
    counts.values + counts.markValues,
    counts.bytes + counts.markBytes,
  ]).toEqual([read("structVisits"), read("valueNodeVisits"), read("decodedPayloadByteVisits")]);
  const saved = added(saveVisits);
  expect([
    SAVE_VISITS_PER_READ.maxStructVisits * counts.structs,
    saveVisitsOf(counts.values, counts.markValues, SAVE_VISITS_PER_READ.maxValueNodeVisits),
    saveVisitsOf(counts.bytes, counts.markBytes, SAVE_VISITS_PER_READ.maxDecodedPayloadByteVisits),
  ]).toEqual([saved("structVisits"), saved("valueNodeVisits"), saved("decodedPayloadByteVisits")]);
}

const ONE_EMPTY_LINE = { type: "doc", content: [{ type: "paragraph" }] };

function expectTheSameNote(markdown: string, reading: Reading = "source"): string {
  const first = inFormat1(markdown, reading);
  const second = inFormat2(markdown, reading);
  expect(holdsBodySequence(second)).toBe(true);
  expect(second.share.has("body")).toBe(false);
  expectTheCountsOfWhatIsWritten(markdown, reading);
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
  "every block that holds no blocks":
    "an empty heading above an empty paragraph is written as blank lines, which read as one empty paragraph",
  "what a tableCell holds": "a quote in a table cell is written on one row, where > reads as text",
  "what a tableHeader holds":
    "a quote in a table cell is written on one row, where > reads as text",
  "every attribute as numbers, as BigInt and as values a reader repairs":
    "a list stored as loose whose items hold one paragraph each reads back as a tight list",
};

const WRITTEN_FILE = new URL("./fixtures/body-sequence-written.json", import.meta.url);
const EVERY_PROPERTY = [
  "---",
  "title: Trip",
  "count: 3",
  "big: 12345678901234567890",
  "done: true",
  "nothing: null",
  "tags:",
  "  - a",
  "  - 12345678901234567890",
  "place:",
  "  city: Lisbon",
  "  days: [1, 2]",
  "---",
  "",
  "Body",
  "",
].join("\n");

describe("the notes made in format 2 from each fixture's Markdown", () => {
  it("are kept with the nodes and bytes of text the engine's Markdown writer spends reading each", () => {
    const notes = [
      ...fixtures,
      ["properties of each kind Markdown gives", EVERY_PROPERTY] as const,
    ];
    const written = notes.map(([name, markdown]) => {
      const counts = newBodyWeight(schema, parsedBody(markdown), byNumber)!;
      const doc = inFormat2(markdown);
      expect(marker(doc)).toBe(BODY_SEQUENCE_SCHEMA_VERSION);
      const read = oneRead(doc);
      return {
        name,
        update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
        engineNodes: counts.engineNodes,
        engineBytes: counts.engineBytes,
        noteNodes: counts.engineNodes + engineReadOfFrontmatter(doc.getMap("frontmatter")).nodes,
        ...liveNoteWeight(doc),
        valueNodeVisits: read.valueNodeVisits,
        decodedPayloadByteVisits: read.decodedPayloadByteVisits,
      };
    });
    expect(written.at(-1)!.noteNodes).toBeGreaterThan(written.at(-1)!.engineNodes);
    if (process.env.BODY_SEQUENCE_WRITE_FIXTURES === "1")
      writeFileSync(WRITTEN_FILE, `${JSON.stringify(written, null, 2)}\n`);
    expect(JSON.parse(readFileSync(WRITTEN_FILE, "utf8"))).toEqual(written);
  });
});

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
    expect(newBodyWeight(schema, parsed, byNumber)).toBeNull();
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
});

function withItsSource(doc: Y.Doc, markdown: string): Y.Doc {
  const meta = doc.getMap("meta");
  meta.set("dohcMarkdownSource", markdown);
  meta.set("dohcMarkdownSourceSha256", sha(markdown));
  meta.set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
  return doc;
}

function inFormat2ByHand(markdown: string): Y.Doc {
  const doc = formatTwoProperties();
  writeNewBody(schema, doc, parsedBody(markdown), byNumber);
  return withItsSource(doc, markdown);
}

function expectTheLastThatFits(fits: string, over: string) {
  const held = inFormat2(fits);
  expect(marker(held)).toBe(BODY_SEQUENCE_SCHEMA_VERSION);
  const { registered: result, usage } = registeredWithVisits(withItsSource(held, fits));
  expect(result).toEqual({ kind: "accepted", markdown: fits });
  expectFormat1(over);
  const first = withItsSource(inFormat1(over), over);
  expect(registered(first)).toEqual({ kind: "accepted", markdown: over });
  return { fits: held, usage: usage!, over: inFormat2ByHand(over) };
}

const weightOf = (doc: Y.Doc) => {
  const { structs, elements } = liveNoteWeight(doc);
  return structs + LIVE_NOTE_ELEMENT_WEIGHT * elements;
};

describe("a note made in format 2 only where the save's check and the engine's Markdown writer take it with its source text", () => {
  it("the most lines whose structs the save's check visits within its limit", () => {
    const lines = (count: number) => "a\n\n".repeat(count);
    const { usage, over } = expectTheLastThatFits(lines(24_998), lines(24_999));
    const limit = WORKER_LIVE_VALIDATION_POLICY.maxStructVisits;
    expect(usage.structVisits).toBe(limit - 4);
    expect(liveNoteWeight(over).structs * SAVE_VISITS_PER_READ.maxStructVisits).toBe(limit + 12);
    expect(registered(over)).toEqual({ kind: "refused: capacity-refused" });
  }, 120_000);

  it("the most rules whose weight fits the capacity", () => {
    const rules = (count: number) => "***\n\n".repeat(count);
    const { fits, over } = expectTheLastThatFits(rules(31_109), rules(31_110));
    expect(weightOf(fits)).toBe(LIVE_NOTE_CAPACITY - 6);
    expect(weightOf(over)).toBe(LIVE_NOTE_CAPACITY + 3);
    expect(registered(over)).toEqual({ kind: "refused: capacity-refused" });
  }, 120_000);

  it("the most quoted lines the engine's Markdown writer reads within its node budget", () => {
    const quoted = (count: number) => `${"> ".repeat(63)}a\n${"> ".repeat(62)}>\n`.repeat(count);
    const { over } = expectTheLastThatFits(quoted(4_032), quoted(4_033));
    const [path, paragraph, run, quotes] = [63, 1, 1, 63];
    const nodes = (count: number) => count * (path + paragraph + run) + quotes;
    const engineNodes = (count: number) =>
      newBodyWeight(schema, parsedBody(quoted(count)), byNumber)?.engineNodes;
    expect([engineNodes(4_032), engineNodes(4_033)]).toEqual([nodes(4_032), nodes(4_033)]);
    expect([nodes(4_032), nodes(4_033)]).toEqual([
      MAX_PROJECTION_NODES - 1,
      MAX_PROJECTION_NODES + 64,
    ]);
    expect(registered(over)).toEqual({ kind: "refused: capacity-refused" });
  }, 120_000);

  it("a table in 61 quotes, over the engine's node budget, made in format 1", () => {
    const row = `|${" a |".repeat(64)}\n`;
    const quoted = "> ".repeat(61);
    const markdown = `${quoted}${row}${quoted}|${" - |".repeat(64)}\n${`${quoted}${row}`.repeat(64)}`;
    const [quotes, table, rows, cells] = [61, 1, 65, 65 * 64];
    const [path, leaf, run, rowAndHeight, cellAndAttributes] = [quotes + 3, 1, 1, 2, 5];
    const nodes =
      cells * (path + leaf + run) +
      quotes +
      table +
      rows * rowAndHeight +
      cells * cellAndAttributes;
    expect(newBodyWeight(schema, parsedBody(markdown), byNumber)?.engineNodes).toBe(nodes);
    expect(nodes).toBe(295_552);
    expectFormat1(markdown);
    expect(registered(withItsSource(inFormat1(markdown), markdown)).kind).toBe("accepted");
    expect(registered(inFormat2ByHand(markdown))).toEqual({ kind: "refused: capacity-refused" });
  });

  it("headings in 32 lists, past the save's value visits and the engine's node budget, made in format 1", () => {
    const lists = Array.from({ length: 32 }, (_, level) => `${"  ".repeat(level)}- a\n`).join("");
    const markdown = lists + `\n${"  ".repeat(32)}# a\n`.repeat(19_000);
    const counts = newBodyWeight(schema, parsedBody(markdown), byNumber)!;
    expect(SAVE_VISITS_OUTSIDE_A_MARK * counts.values).toBeGreaterThan(
      WORKER_LIVE_VALIDATION_POLICY.maxValueNodeVisits,
    );
    expect(counts.engineNodes).toBeGreaterThan(MAX_PROJECTION_NODES);
    expectFormat1(markdown);
    expect(registered(withItsSource(inFormat1(markdown), markdown)).kind).toBe("accepted");
  }, 120_000);

  it("is refused one value, one byte of text or one engine node past each limit", () => {
    const none: NewNoteCounts = {
      structs: 0,
      elements: 0,
      values: 0,
      markValues: 0,
      bytes: 0,
      markBytes: 0,
      engineNodes: 0,
      engineBytes: 0,
    };
    const fits = (counts: Partial<NewNoteCounts>) =>
      fitsNewNote({ ...none, ...counts }, WORKER_LIVE_VALIDATION_POLICY);
    const { maxValueNodeVisits, maxDecodedPayloadByteVisits } = WORKER_LIVE_VALIDATION_POLICY;
    expect(4 * 1_250_000).toBe(maxValueNodeVisits);
    expect([fits({ values: 1_250_000 }), fits({ values: 1_250_001 })]).toEqual([true, false]);
    expect(4 * 3 + 7 * 714_284).toBe(maxValueNodeVisits);
    expect([
      fits({ values: 3, markValues: 714_284 }),
      fits({ values: 4, markValues: 714_284 }),
    ]).toEqual([true, false]);
    expect(4 * 4 + 7 * 14_285_712).toBe(maxDecodedPayloadByteVisits);
    expect([
      fits({ bytes: 4, markBytes: 14_285_712 }),
      fits({ bytes: 5, markBytes: 14_285_712 }),
    ]).toEqual([true, false]);
    expect([
      fits({ engineNodes: MAX_PROJECTION_NODES }),
      fits({ engineNodes: MAX_PROJECTION_NODES + 1 }),
    ]).toEqual([true, false]);
    expect([
      fits({ engineBytes: MAX_PROJECTION_BYTES }),
      fits({ engineBytes: MAX_PROJECTION_BYTES + 1 }),
    ]).toEqual([true, false]);
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
