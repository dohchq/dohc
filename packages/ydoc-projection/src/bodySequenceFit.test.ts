import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { writeNewBody } from "./bodySequenceWriter.js";
import { storedValue } from "./bodySequenceStore.js";
import { getDohcProseMirrorSchema, markdownToYDoc, yDocToMarkdown } from "./import-export.js";
import {
  admitBodySequenceNotes,
  createLiveMarkdownRegistrationValidator,
} from "./liveDocumentValidation.js";
import * as policy from "./liveValidationPolicy.js";
import {
  type IndexCounts,
  type NewNoteCounts,
  newNoteIndexOperations,
  WORKER_LIVE_VALIDATION_POLICY,
} from "./liveValidationPolicy.js";
import * as ordered from "./orderedLiveUpdateCut.js";

const FIT_FILE = new URL("./fixtures/body-sequence-fit.json", import.meta.url);
const CLIENT = 7;
const schema = getDohcProseMirrorSchema();
const register = createLiveMarkdownRegistrationValidator(WORKER_LIVE_VALIDATION_POLICY);
beforeAll(() => admitBodySequenceNotes(true));
afterAll(() => admitBodySequenceNotes(false));

type Parts = [count: number, text: string][];
type Recipe = { name: string; frontmatter: Parts; body: Parts };
type Bound = IndexCounts & { indexOperations: number };
type Note = Recipe & Bound & { format: number };

const keys = (count: number, key: string): Parts => [
  [1, "---\ntable:\n"],
  [count, `  ${key}{i}: {i}\n`],
  [1, "---\n"],
];
const paragraphs = (count: number): Parts => [[count, "a\n\n"]];
const LONG_KEY = "k".repeat(50);
const REALISTIC =
  "## Heading\n\nSome *text* with a [link](https://example.com/a) and **bold** words.\n\n- item one\n- item two\n- item three\n\n> quote line\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n";
const row = (text: string) => `|${` ${text} |`.repeat(10)}\n`;

const RECIPES: Recipe[] = [
  { name: "a body of paragraphs at the struct cap", frontmatter: [], body: paragraphs(24_975) },
  { name: "mark-dense lines at the struct cap", frontmatter: [], body: [[12_495, "**a**b*c*d "]] },
  {
    name: "a realistic note near the struct cap",
    frontmatter: [[1, "---\ntitle: Notes\ntags: [a, b]\n---\n"]],
    body: [[1_000, REALISTIC]],
  },
  { name: "a list of 10,000 items", frontmatter: [], body: [[10_000, "- a\n"]] },
  {
    name: "a table of 1,000 cells",
    frontmatter: [],
    body: [
      [1, row("h")],
      [1, `|${" --- |".repeat(10)}\n`],
      [100, row("c")],
    ],
  },
  { name: "one paragraph of 250,000 astral letters", frontmatter: [], body: [[250_000, "😀"]] },
  {
    name: "400,000 astral letters and 24,000 paragraphs",
    frontmatter: [],
    body: [[400_000, "😀"], [1, "\n\n"], ...paragraphs(24_000)],
  },
  {
    name: "20,000 keys in a map and 24,000 paragraphs",
    frontmatter: keys(20_000, LONG_KEY),
    body: paragraphs(24_000),
  },
  {
    name: "20,000 keys in a map and paragraphs just under the limit",
    frontmatter: keys(20_000, LONG_KEY),
    body: paragraphs(11_050),
  },
  {
    name: "20,000 keys in a map and paragraphs just over the limit",
    frontmatter: keys(20_000, LONG_KEY),
    body: paragraphs(11_250),
  },
  {
    name: "2,000 keys of 100 bytes in a map",
    frontmatter: keys(2_000, "q".repeat(96)),
    body: [[1, "a\n"]],
  },
  {
    name: "a map with a constructor key, written as a shared map",
    frontmatter: [
      [1, "---\ntable:\n  constructor: 1\n"],
      [2_000, "  k{i}: {i}\n"],
      [1, "---\n"],
    ],
    body: [[1, "a\n"]],
  },
];
const THE_RELAY_REFUSES_IN_FORMAT_TWO = new Set([
  "400,000 astral letters and 24,000 paragraphs",
  "20,000 keys in a map and 24,000 paragraphs",
]);
const LARGE_REALISTIC = new Set([
  "a body of paragraphs at the struct cap",
  "mark-dense lines at the struct cap",
  "a realistic note near the struct cap",
]);
const BOUNDS: IndexCounts[] = [
  { structs: 0, rootEntries: 0, keySorts: 0, astral: 0 },
  { structs: 1, rootEntries: 1, keySorts: 0, astral: 0 },
  { structs: 2, rootEntries: 0, keySorts: 1, astral: 1 },
  { structs: 100_000, rootEntries: 10, keySorts: 0, astral: 0 },
  { structs: 5, rootEntries: 3, keySorts: 0, astral: 500_000 },
  { structs: 96_009, rootEntries: 7, keySorts: 17_400_000, astral: 0 },
  { structs: 0, rootEntries: 0, keySorts: 30_286_363, astral: 0 },
  { structs: 131_073, rootEntries: 65_536, keySorts: 1_234_567, astral: 123_457 },
];

const expand = (parts: Parts) =>
  parts
    .map(([count, text]) =>
      text.includes("{i}")
        ? Array.from({ length: count }, (_, i) => text.replaceAll("{i}", String(i))).join("")
        : text.repeat(count),
    )
    .join("");
const markdownOf = (recipe: Recipe) => expand(recipe.frontmatter) + expand(recipe.body);
const sha = (text: Uint8Array | string) => createHash("sha256").update(text).digest("hex");
const formatOf = (doc: Y.Doc) => storedValue(doc.share.get("meta"), "schemaVersion");

function made(markdown: string): { doc: Y.Doc; counts: NewNoteCounts } {
  const fits = policy.fitsNewNote;
  const seen: NewNoteCounts[] = [];
  const spy = vi.spyOn(policy, "fitsNewNote").mockImplementation((counts, limits) => {
    seen.push(counts);
    return fits(counts, limits);
  });
  try {
    const doc = markdownToYDoc(markdown, { clientID: CLIENT, bodySequence: true });
    expect(seen).toHaveLength(1);
    return { doc, counts: seen[0]! };
  } finally {
    spy.mockRestore();
  }
}

function withItsSource(doc: Y.Doc, markdown: string): Y.Doc {
  const meta = doc.getMap("meta");
  meta.set("dohcMarkdownSource", markdown);
  meta.set("dohcMarkdownSourceSha256", sha(markdown));
  meta.set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
  return doc;
}

function inFormatTwoByHand(recipe: Recipe, markdown: string): Y.Doc {
  const doc = markdownToYDoc(expand(recipe.frontmatter), { clientID: CLIENT, bodySequence: true });
  expect(formatOf(doc)).toBe(2);
  const inFormatOne = markdownToYDoc(markdown, { clientID: CLIENT });
  const body = yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(inFormatOne), schema);
  inFormatOne.destroy();
  writeNewBody(schema, doc, body, (_container, index) => index.toString(36));
  return withItsSource(doc, markdown);
}

function registered(doc: Y.Doc) {
  const validate = ordered.validateRegistrationCutForProjection;
  let indexOperations: number | undefined;
  const spy = vi
    .spyOn(ordered, "validateRegistrationCutForProjection")
    .mockImplementation((...args) => {
      const result = validate(...args);
      if (result.kind !== "accepted") return result;
      const finish = result.cut.finishAfterProjection;
      const finishAfterProjection = () => {
        const finished = finish();
        if (finished.kind === "accepted") indexOperations = finished.usage.indexOperations;
        return finished;
      };
      return { ...result, cut: { ...result.cut, finishAfterProjection } };
    });
  try {
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
    return { kind: result.kind === "accepted" ? "accepted" : result.reason, indexOperations };
  } finally {
    spy.mockRestore();
  }
}

const indexCounts = ({ structs, rootEntries, keySorts, astral }: IndexCounts): IndexCounts => ({
  structs,
  rootEntries,
  keySorts,
  astral,
});

describe("the index operations a new note is counted at", () => {
  const notes: Note[] = RECIPES.map((recipe) => {
    const { doc, counts } = made(markdownOf(recipe));
    const format = formatOf(doc) as number;
    doc.destroy();
    return {
      ...recipe,
      ...indexCounts(counts),
      indexOperations: newNoteIndexOperations(counts),
      format,
    };
  });
  const bounds: Bound[] = BOUNDS.map((counts) => ({
    ...counts,
    indexOperations: newNoteIndexOperations(counts),
  }));

  it("are kept with each recipe's counts, bound and format, for the engine to count alike", () => {
    if (process.env.BODY_SEQUENCE_WRITE_FIXTURES === "1")
      writeFileSync(FIT_FILE, `${JSON.stringify({ bounds, notes }, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIT_FILE, "utf8"))).toEqual({ bounds, notes });
    expect(bounds.map((bound) => bound.indexOperations).slice(0, 2)).toEqual([55_000, 55_123]);
  });

  it("send a note to format 1 where the relay would refuse it in format 2", () => {
    const formats = Object.fromEntries(notes.map((note) => [note.name, note.format]));
    expect(formats).toEqual({
      "a body of paragraphs at the struct cap": 2,
      "mark-dense lines at the struct cap": 2,
      "a realistic note near the struct cap": 2,
      "a list of 10,000 items": 2,
      "a table of 1,000 cells": 2,
      "one paragraph of 250,000 astral letters": 2,
      "400,000 astral letters and 24,000 paragraphs": 1,
      "20,000 keys in a map and 24,000 paragraphs": 1,
      "20,000 keys in a map and paragraphs just under the limit": 2,
      "20,000 keys in a map and paragraphs just over the limit": 1,
      "2,000 keys of 100 bytes in a map": 2,
      "a map with a constructor key, written as a shared map": 2,
    });
    for (const recipe of RECIPES.filter(({ name }) => THE_RELAY_REFUSES_IN_FORMAT_TWO.has(name))) {
      const doc = inFormatTwoByHand(recipe, markdownOf(recipe));
      expect(registered(doc).kind, recipe.name).toBe("capacity-refused");
      doc.destroy();
    }
  }, 600_000);

  it.each(RECIPES.map((recipe) => [recipe.name, recipe] as const))(
    "%s: in format 2, the relay takes it within its bound",
    (name, recipe) => {
      const note = notes.find((each) => each.name === name)!;
      if (note.format !== 2) return;
      const markdown = markdownOf(recipe);
      const { doc } = made(markdown);
      const result = registered(withItsSource(doc, markdown));
      doc.destroy();
      expect(result.kind).toBe("accepted");
      expect(result.indexOperations!).toBeLessThanOrEqual(note.indexOperations);
      if (LARGE_REALISTIC.has(name))
        expect(note.indexOperations / result.indexOperations!).toBeLessThanOrEqual(1.25);
    },
    120_000,
  );
});
