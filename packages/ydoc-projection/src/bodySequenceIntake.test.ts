import { createHash } from "node:crypto";
import * as encoding from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import {
  BODY_SEQUENCE_CHANGE_MAX_VALUES,
  bodySequenceChangeRefusal,
  bodySequenceChangeSize,
  bodySequenceNames,
  bodySequenceRoomPolicy,
  type BodySequenceIntakeWork,
} from "./bodySequenceIntake.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  anyAsWritten,
  ARRIVALS,
  changeMadeBy,
  contentAsWritten,
  COSTLY_CHANGES,
  deliver,
  element,
  HOSTILE_STRINGS,
  LARGE_HONEST_CHANGES,
  markAsWritten,
  noteWithEveryNode,
  openPerson,
  random,
  randomChange,
  seededNote,
  skipOf,
  storedReading,
  updateOf,
  type Change,
} from "./bodySequenceChecksTestSupport.js";
import {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  markdownToYDoc,
  yDocToMarkdown,
} from "./import-export.js";
import {
  admitBodySequenceNotes,
  createLiveMarkdownHistoryValidator,
  createLiveMarkdownJournalValidator,
  createLiveMarkdownRegistrationValidator,
  liveEditFitsCopy,
  liveEditRefusal,
} from "./liveDocumentValidation.js";
import { WORKER_LIVE_VALIDATION_POLICY } from "./liveValidationPolicy.js";
import {
  readLiveUpdateAsTheCutDoes,
  validateOrderedLiveUpdateCut,
  type OrderedLiveUpdateCutPolicy,
} from "./orderedLiveUpdateCut.js";
import { BODY_CONTAINERS_FIELD, BODY_SEQUENCE_FIELD } from "./bodySequenceStore.js";

const schema = getDohcProseMirrorSchema();
const PATH = "notes/shared.md";
const POLICY = WORKER_LIVE_VALIDATION_POLICY;
const register = createLiveMarkdownRegistrationValidator(POLICY);
const admit = createLiveMarkdownJournalValidator(POLICY);
const engineReaderAdmit = createLiveMarkdownJournalValidator(POLICY, true);
const activate = createLiveMarkdownHistoryValidator(POLICY);
const seedsAsked = process.env.BODY_SEQUENCE_CHECK_SEEDS;
const SEEDS = seedsAsked === undefined ? 3 : Number(seedsAsked);
if (!Number.isSafeInteger(SEEDS) || SEEDS < 1)
  throw new Error(
    `BODY_SEQUENCE_CHECK_SEEDS must be a whole number of seeds, 1 or more. It is ${JSON.stringify(seedsAsked)}.`,
  );

const honest = { histories: 0, changes: 0 };
beforeAll(() => admitBodySequenceNotes(true));
afterAll(() => {
  admitBodySequenceNotes(false);
  console.log(`people's changes: ${JSON.stringify(honest)}`);
});

const documentFor = (checkpoint: Uint8Array) => ({
  workspaceId: "workspace",
  mainVersionId: "main",
  objectId: "object",
  lineageClaimId: createHash("sha256").update(checkpoint).digest("hex"),
});
const said = (result: { kind: string; reason?: string; source?: string }) =>
  result.kind === "refused"
    ? `refused: ${String(result.reason)} (${String(result.source)})`
    : result.kind;

/** The room as the relay runs it: what it has taken, and its check of each change against a copy. */
function room(baseline: Uint8Array) {
  const note = new Y.Doc({ gc: false });
  Y.applyUpdate(note, baseline);
  const taken: Uint8Array[] = [];
  const document = documentFor(baseline);
  const input = (candidate: Uint8Array) => ({
    document,
    currentPath: PATH,
    checkpoint: baseline,
    suffix: [...taken],
    candidate,
  });
  return {
    note,
    taken,
    vector: () => Y.encodeStateVector(note),
    missingFor: (vector: Uint8Array) => Y.encodeStateAsUpdate(note, vector),
    /** What the room's check says of the bytes as they were sent, with nothing trimmed first. */
    fitsAsSent(bytes: Uint8Array): boolean {
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(note));
      const fits = liveEditFitsCopy(copy, bytes);
      copy.destroy();
      return fits;
    },
    /** What the journal check says of the bytes as a capture would submit them. */
    journal: (bytes: Uint8Array) => said(admit(input(bytes))),
    /**
     * The bytes the room keeps of a change, or undefined when its check refuses the change. The
     * room first trims what the note already holds, which writes every value again.
     */
    offer(bytes: Uint8Array): Uint8Array | undefined {
      let kept: Uint8Array;
      try {
        kept = Y.diffUpdate(bytes, Y.encodeStateVector(note));
      } catch {
        return undefined;
      }
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(note));
      const fits = liveEditFitsCopy(copy, kept);
      copy.destroy();
      return fits ? kept : undefined;
    },
    /** What every later check says of a change the room's check took. */
    laterChecks(kept: Uint8Array) {
      const journal = said(admit(input(kept)));
      const engineReader = said(engineReaderAdmit(input(kept)));
      Y.applyUpdate(note, kept);
      taken.push(kept);
      const state = Y.encodeStateAsUpdate(note);
      const registration = said(
        register({ document: documentFor(state), currentPath: PATH, checkpoint: state }),
      );
      return { journal, engineReader, registration };
    },
    activation() {
      return said(
        activate(
          {
            document,
            currentPath: PATH,
            checkpoint: baseline,
            suffix: taken.slice(0, -1),
            candidate: taken.at(-1)!,
          },
          { from: 0, visit: () => {} },
        ),
      );
    },
  };
}

const ACCEPTED = { journal: "accepted", engineReader: "accepted", registration: "accepted" };

type Line = readonly [attrs: Record<string, unknown>, text?: string];

/** One document as a format-2 note and as a format-1 note, with the same metadata and no properties. */
function inBothFormats(lines: readonly Line[], meta: Record<string, unknown> = {}) {
  const second = new Y.Doc({ gc: false });
  const first = new Y.Doc({ gc: false });
  for (const [doc, version] of [
    [second, 2],
    [first, 1],
  ] as const) {
    doc.clientID = 1;
    doc.getMap("meta").set("schemaVersion", version);
    doc.getMap("frontmatter");
    for (const [key, value] of Object.entries(meta)) doc.getMap("meta").set(key, value);
  }
  const sequence = second.getText(BODY_SEQUENCE_FIELD);
  for (const [attrs, text] of lines) {
    sequence.insertEmbed(sequence.length, element("block", { path: [], ...attrs }), {});
    if (text) sequence.insert(sequence.length, text, {});
  }
  prosemirrorJSONToYXmlFragment(
    schema,
    readBodySequence(schema, second).toJSON(),
    first.getXmlFragment("body"),
  );
  const notes = { first: Y.encodeStateAsUpdate(first), second: Y.encodeStateAsUpdate(second) };
  first.destroy();
  second.destroy();
  return notes;
}

/** One change to a format-1 note with a property, as the room's check and the journal check see it. */
function offeredToAFormat1Note(change: (page: Y.Doc) => void) {
  const doc = markdownToYDoc("---\nstatus: draft\n---\n\nBody\n", { clientID: 1 });
  const note = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const page = new Y.Doc({ gc: false });
  page.clientID = 77;
  Y.applyUpdate(page, note);
  let sent: Uint8Array | undefined;
  page.on("update", (update: Uint8Array) => {
    sent = update;
  });
  page.transact(() => change(page));
  page.destroy();
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, note);
  const taken = liveEditFitsCopy(copy, sent!);
  copy.destroy();
  return {
    room: taken,
    journal: () =>
      said(
        admit({
          document: documentFor(note),
          currentPath: PATH,
          checkpoint: note,
          suffix: [],
          candidate: sent!,
        }),
      ),
  };
}

const registered = (note: Uint8Array) =>
  said(register({ document: documentFor(note), currentPath: PATH, checkpoint: note }));
const REFUSED_AT_REGISTRATION = "refused: invalid-schema (registration-input)";
const REFUSED_AT_SAVE = "refused: invalid-schema (final)";

describe("the names intake goes by", () => {
  it("are the format's: marks, a boundary's attributes, each inline item's, and a record's", () => {
    const names = bodySequenceNames();
    expect([...names.marks].sort()).toEqual(
      ["bold", "code", "highlight", "italic", "link", "strike", "underline"].sort(),
    );
    expect([...names.boundaryAttributes].sort()).toEqual(
      ["language", "level", "path", "source", "tex", "type"].sort(),
    );
    expect([...names.itemAttributes.keys()].sort()).toEqual(
      [
        "escapedPunctuation",
        "hardBreak",
        "image",
        "inlineAtom",
        "mathInline",
        "rawInline",
        "wikilink",
      ].sort(),
    );
    expect([...names.recordAttributes].sort()).toEqual(
      [
        "align",
        "calloutType",
        "checked",
        "colspan",
        "colwidth",
        "fold",
        "height",
        "loose",
        "rowspan",
        "start",
        "title",
        "type",
      ].sort(),
    );
  });
});

describe("a format-2 note that people edit as section 4 says, on a relay that admits such notes", () => {
  it("is registered, and reads as the document it was seeded with", () => {
    const baseline = seededNote();
    const result = register({
      document: documentFor(baseline),
      currentPath: PATH,
      checkpoint: baseline,
    });
    expect(said(result)).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.evidence.projectedMarkdown).toBe(
      [
        "---",
        "status: draft",
        "---",
        "",
        "# Trip plan",
        "",
        "Pack the **bags** tonight 😀",
        "",
        "- [ ] tickets",
        "- [x] passports",
        "",
        "> [!note] Note",
        "> Gate closes at $t_0$",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "The end",
        "",
      ].join("\n"),
    );
  });

  it.each([2, 3, 4].flatMap((people) => ARRIVALS.map((arrive) => [people, arrive] as const)))(
    "%i people, changes arriving %s: intake takes every change, and no later check refuses one",
    (people, arrive) => {
      for (let seed = 1; seed <= SEEDS; seed++)
        for (const gc of [true, false]) {
          const baseline = seededNote();
          const held = room(baseline);
          const next = random(seed * 7919 + people);
          const hub = {
            vector: held.vector,
            missingFor: held.missingFor,
            take(change: Change) {
              const where = `seed ${String(seed)}, gc ${String(gc)}, ${change.kind} from ${String(change.from)}`;
              const kept = held.offer(change.bytes);
              expect(kept, `the room's check: ${where}`).toBeDefined();
              honest.changes++;
              expect(held.laterChecks(kept!), where).toEqual(ACCEPTED);
              return kept!;
            },
          };
          const team = Array.from({ length: people }, (_, index) =>
            openPerson(baseline, 10 * (index + 1), { gc }),
          );
          for (let round = 0; round < 3; round++) {
            for (const each of team)
              for (let changes = 1 + Math.floor(next() * 3); changes > 0; changes--)
                randomChange(each, next);
            deliver(team, hub, arrive, next);
            const stored = storedReading(held.note);
            for (const each of team)
              expect(readBodySequence(schema, each.doc).toJSON()).toEqual(stored);
          }
          expect(held.activation()).toBe("accepted");
          honest.histories++;
          for (const each of team) each.doc.destroy();
          held.note.destroy();
        }
    },
    600_000,
  );

  it("is read, and written as Markdown, without its sequence or its records being declared", () => {
    const note = new Y.Doc({ gc: false });
    Y.applyUpdate(note, seededNote());
    readBodySequence(schema, note);
    yDocToMarkdown(note);
    for (const root of [BODY_SEQUENCE_FIELD, BODY_CONTAINERS_FIELD])
      expect(note.share.get(root)!.constructor, root).toBe(Y.AbstractType);
    note.destroy();
  });

  it("takes one sender's run of changes merged into one save, as the room saves them", () => {
    for (let seed = 1; seed <= 4 * SEEDS; seed++) {
      const baseline = seededNote();
      const held = room(baseline);
      const next = random(seed * 613);
      const person = openPerson(baseline, 20);
      for (let changes = 0; changes < 12; changes++) randomChange(person, next);
      const kept = person.waiting.map((change) => {
        const bytes = held.offer(change.bytes);
        expect(bytes, `seed ${String(seed)}, ${change.kind}`).toBeDefined();
        Y.applyUpdate(held.note, bytes!);
        return bytes!;
      });
      const save = Y.mergeUpdates(kept);
      expect(
        said(
          admit({
            document: documentFor(baseline),
            currentPath: PATH,
            checkpoint: baseline,
            suffix: [],
            candidate: save,
          }),
        ),
        `seed ${String(seed)}`,
      ).toBe("accepted");
      person.doc.destroy();
      held.note.destroy();
    }
  });
});

interface Case {
  readonly name: string;
  /** The change, built on the note as it stands. Undefined when it would change nothing there. */
  readonly change: (note: Uint8Array, client: number) => Uint8Array | undefined;
}

const firstOf = (sequence: Y.Text, name: string) => {
  for (let item = sequence._start; item !== null; item = item.right)
    if (
      !item.deleted &&
      item.content instanceof Y.ContentType &&
      item.content.type instanceof Y.XmlElement &&
      item.content.type.nodeName === name
    )
      return item.content.type;
  return undefined;
};

/** Ids in the note as stored, for changes that name an item no editor would name. */
function idsIn(note: Uint8Array) {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, note);
  const sequence = doc.share.get(BODY_SEQUENCE_FIELD)!;
  let letters: Y.Item | undefined;
  let pair: Y.ID | undefined;
  let boundary: Y.Item | undefined;
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentString) {
      letters ??= item;
      const at = item.content.str.search(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
      if (at >= 0) pair ??= Y.createID(item.id.client, item.id.clock + at + 1);
    } else if (item.content instanceof Y.ContentType) boundary ??= item;
  }
  const record = doc.share.get(BODY_CONTAINERS_FIELD)?._map.values().next().value;
  const attribute = (boundary?.content as Y.ContentType | undefined)?.type._map
    .values()
    .next().value;
  const ids = {
    letters: letters?.id,
    insideAPair: pair,
    boundary: boundary?.id,
    record: record?.id,
    attribute: attribute?.id,
    last: sequence._start ? lastOf(sequence._start).lastId : undefined,
  };
  doc.destroy();
  return ids;
}
const lastOf = (item: Y.Item): Y.Item => (item.right ? lastOf(item.right) : item);

const LONE_SURROGATE_BYTES = [0xed, 0xa0, 0xbd];
const LONE = new Map([["LONE", LONE_SURROGATE_BYTES]]);
const deep = (levels: number): unknown => (levels === 0 ? 1 : { in: deep(levels - 1) });
const made =
  (change: Parameters<typeof changeMadeBy>[2]): Case["change"] =>
  (note, client) =>
    changeMadeBy(note, client, change);
/** A case's change on a note that other cases have changed, where it may have nothing to change. */
const changeIfItApplies = (each: Case, note: Uint8Array, client: number) => {
  try {
    return each.change(note, client);
  } catch {
    return undefined;
  }
};

const REFUSED: readonly Case[] = [
  {
    name: "a paragraph under body",
    change: made(({ doc }) =>
      doc.getXmlFragment("body").insert(0, [new Y.XmlElement("paragraph")]),
    ),
  },
  {
    name: "a paragraph under body, deleted by the same change",
    change: made(({ doc }) => {
      doc.getXmlFragment("body").insert(0, [new Y.XmlElement("paragraph")]);
      doc.getXmlFragment("body").delete(0, 1);
    }),
  },
  {
    name: "an item under a root no note has",
    change: made(({ doc }) => doc.getMap("extra").set("k", 1)),
  },
  {
    name: "the format marker written again with the same value",
    change: made(({ doc }) => doc.getMap("meta").set("schemaVersion", 2)),
  },
  {
    name: "the format marker changed to 1",
    change: made(({ doc }) => doc.getMap("meta").set("schemaVersion", 1)),
  },
  {
    name: "the format marker deleted",
    change: made(({ doc }) => doc.getMap("meta").delete("schemaVersion")),
  },
  {
    name: "the format marker written and deleted by the same change",
    change: made(({ doc }) => {
      doc.getMap("meta").set("schemaVersion", 2);
      doc.getMap("meta").delete("schemaVersion");
    }),
  },
  {
    name: "a format marker placed before the one the note has",
    change: (_note, client) =>
      updateOf([
        { client, clock: 0, parent: "meta", key: "schemaVersion", content: new Y.ContentAny([1]) },
      ]),
  },
  {
    name: "a metadata key no note has",
    change: made(({ doc }) => doc.getMap("meta").set("htmlAtom", { a: 1 })),
  },
  {
    name: "metadata only the engine's reader writes",
    change: made(({ doc }) => doc.getMap("meta").set("dohcMarkdownSourceReader", 1)),
  },
  {
    name: "a metadata value its key cannot hold",
    change: made(({ doc }) => doc.getMap("meta").set("dohcMarkdownCrlf", false)),
  },
  {
    name: "an embedded value in the sequence",
    change: made(({ sequence }) => sequence.insertEmbed(1, { foo: 1 })),
  },
  {
    name: "an embedded value in the sequence, deleted by the same change",
    change: made(({ sequence }) => {
      sequence.insertEmbed(1, { foo: 1 });
      sequence.delete(1, 1);
    }),
  },
  {
    name: "a text nested in the sequence",
    change: made(({ sequence }) => sequence.insertEmbed(1, new Y.XmlText("x"))),
  },
  {
    name: "a map nested in the sequence",
    change: made(({ sequence }) => sequence.insertEmbed(1, new Y.Map())),
  },
  {
    name: "an element named after a block in the sequence",
    change: made(({ sequence }) => sequence.insertEmbed(1, element("paragraph", {}))),
  },
  {
    name: "an element of an unknown name in the sequence",
    change: made(({ sequence }) => sequence.insertEmbed(1, element("script", {}))),
  },
  {
    name: "a keyed item under the sequence",
    change: made(({ sequence }) => sequence.setAttribute("k", 1)),
  },
  {
    name: "a mark the schema lacks",
    change: made(({ sequence }) => sequence.format(1, 3, { colour: "red" })),
  },
  {
    name: "a mark name with a hash",
    change: made(({ sequence }) => sequence.format(1, 3, { "bold--abcdefgh": {} })),
  },
  {
    name: "a mark whose value has a key named __proto__",
    change: made(({ sequence }) =>
      sequence.format(1, 3, { link: JSON.parse('{"href":"x","__proto__":{"a":1}}') as object }),
    ),
  },
  {
    name: "a mark whose value holds a lone surrogate",
    change: made(({ sequence }) => sequence.format(1, 3, { link: { href: "\ud83d" } })),
  },
  {
    name: "a mark whose value holds a key twice",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).letters,
          content: markAsWritten("link", '{"href":"a","href":"b"}'),
        },
      ]),
  },
  {
    name: "a mark whose value holds a negative zero",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).letters,
          content: markAsWritten("bold", '{"a":-0}'),
        },
      ]),
  },
  {
    name: "a mark whose value holds a number too large to keep",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).letters,
          content: markAsWritten("bold", '{"a":1e400}'),
        },
      ]),
  },
  {
    name: "an attribute a boundary cannot have",
    change: made(({ sequence }) => firstOf(sequence, "block")!.setAttribute("colour", "red")),
  },
  {
    name: "an attribute an inline item cannot have",
    change: made(({ sequence }) =>
      firstOf(sequence, "mathInline")?.setAttribute("level", 2 as unknown as string),
    ),
  },
  {
    name: "a text under a boundary",
    change: made(({ sequence }) => firstOf(sequence, "block")!.insert(0, [new Y.XmlText("x")])),
  },
  {
    name: "an element under a boundary",
    change: made(({ sequence }) =>
      firstOf(sequence, "block")!.insert(0, [new Y.XmlElement("paragraph")]),
    ),
  },
  {
    name: "a nested map as a boundary's attribute",
    change: made(({ sequence }) =>
      firstOf(sequence, "block")!.setAttribute("path", new Y.Map() as unknown as string),
    ),
  },
  {
    name: "a record key that is no id",
    change: made(({ records }) => records.set("has space", "blockquote")),
  },
  {
    name: "a record of an attribute no container has",
    change: made(({ records }) => records.set("L.colour", 1)),
  },
  {
    name: "a nested list as a record",
    change: made(({ records }) => records.set("X", new Y.Array())),
  },
  {
    name: "an item under containers with no key",
    change: (_note, client) =>
      updateOf([{ client, clock: 0, parent: "containers", content: new Y.ContentAny(["x"]) }]),
  },
  {
    name: "a record that is undefined",
    change: made(({ records }) => records.set("X", undefined)),
  },
  {
    name: "a record that is bytes",
    change: made(({ records }) => records.set("X", new Uint8Array([1, 2]))),
  },
  {
    name: "a record that is not a number",
    change: made(({ records }) => records.set("X.start", NaN)),
  },
  {
    name: "a record that is infinite",
    change: made(({ records }) => records.set("X.start", Infinity)),
  },
  {
    name: "a record with a key named __proto__",
    change: made(({ records }) => records.set("X", JSON.parse('{"__proto__":{"a":1}}') as object)),
  },
  {
    name: "a record with a key twice",
    change: (_note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          parent: "containers",
          key: "X",
          content: anyAsWritten([118, 2, 1, 0x61, 126, 1, 0x61, 126]),
        },
      ]),
  },
  {
    name: "a property 200 levels deep",
    change: made(({ doc }) => doc.getMap("frontmatter").set("deep", deep(200))),
  },
  {
    name: "a record placed to the left of one the note has",
    change: (note, client) =>
      updateOf([
        { client, clock: 0, rightOrigin: idsIn(note).record, content: new Y.ContentAny(["x"]) },
      ]),
  },
  {
    name: "two values under one key that both show",
    change: (_note, client) =>
      updateOf([
        { client, clock: 0, parent: "containers", key: "Z", content: new Y.ContentAny(["a", "b"]) },
      ]),
  },
  {
    name: "an item whose parent is a letter",
    change: (note, client) =>
      updateOf([
        { client, clock: 0, parent: idsIn(note).letters, content: new Y.ContentString("x") },
      ]),
  },
  {
    name: "a delete that starts between the two units of an emoji",
    change: (note) => {
      const inside = idsIn(note).insideAPair;
      return inside && updateOf([], [[inside.client, inside.clock, 1]]);
    },
  },
  {
    name: "a delete that ends between the two units of an emoji",
    change: (note) => {
      const inside = idsIn(note).insideAPair;
      return inside && updateOf([], [[inside.client, inside.clock - 1, 1]]);
    },
  },
  {
    name: "two deletes that meet between the two units of an emoji and together cover it",
    change: (note) => {
      const inside = idsIn(note).insideAPair;
      return (
        inside &&
        updateOf(
          [],
          [
            [inside.client, inside.clock - 1, 1],
            [inside.client, inside.clock, 1],
          ],
        )
      );
    },
  },
  {
    name: "an emoji and a delete of half of it in one change",
    change: (note, client) =>
      updateOf(
        [{ client, clock: 0, origin: idsIn(note).last, content: new Y.ContentString("😀") }],
        [[client, 1, 1]],
      ),
  },
  {
    name: "content in the old JSON form",
    change: (_note, client) =>
      updateOf([
        { client, clock: 0, parent: "frontmatter", key: "old", content: new Y.ContentJSON([1]) },
      ]),
  },
  {
    name: "bytes embedded in the sequence",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).last,
          content: new Y.ContentBinary(new Uint8Array([1])),
        },
      ]),
  },
  {
    name: "an item of no length",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).last,
          content: contentAsWritten(4, true, (encoder) => encoder.writeString("")),
        },
      ]),
  },
  {
    name: "a change that names a struct the note lacks",
    change: (_note, client) => updateOf([], [[client, 5, 1]]),
  },
  { name: "bytes that are no update", change: () => new Uint8Array([1, 2, 3, 4, 5]) },
  {
    name: "a lone surrogate in a letter run",
    change: (note, client) =>
      updateOf(
        [{ client, clock: 0, origin: idsIn(note).last, content: new Y.ContentString("LONE") }],
        [],
        LONE,
      ),
  },
  {
    name: "a lone surrogate in a key",
    change: (_note, client) =>
      updateOf(
        [
          {
            client,
            clock: 0,
            parent: "frontmatter",
            key: "LONE",
            content: new Y.ContentAny(["x"]),
          },
        ],
        [],
        LONE,
      ),
  },
  {
    name: "a lone surrogate in a key of a value",
    change: (_note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          parent: "frontmatter",
          key: "k",
          content: anyAsWritten([118, 1, 3, ...LONE_SURROGATE_BYTES, 126]),
        },
      ]),
  },
  {
    name: "a lone surrogate in a key of a mark's value",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).letters,
          content: markAsWritten("link", '{"\\ud83d":1}'),
        },
      ]),
  },
  {
    name: "an item under frontmatter with no key",
    change: (_note, client) =>
      updateOf([{ client, clock: 0, parent: "frontmatter", content: new Y.ContentAny(["x"]) }]),
  },
  {
    name: "a keyed item under a list that is a property",
    change: (_note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          parent: "frontmatter",
          key: "tags",
          content: new Y.ContentType(new Y.Array()),
        },
        {
          client,
          clock: 1,
          parent: Y.createID(client, 0),
          key: "k",
          content: new Y.ContentAny(["x"]),
        },
      ]),
  },
  {
    name: "a value with nothing named to its left and an attribute of a line named to its right",
    change: (note, client) =>
      updateOf([
        { client, clock: 0, rightOrigin: idsIn(note).attribute, content: new Y.ContentAny(["x"]) },
      ]),
  },
  {
    name: "clocks skipped for an editor the note has not heard from",
    change: (_note, client) => skipOf(client, 0, 3),
  },
  {
    name: "a struct the note has, sent again under a root no note has",
    change: () =>
      updateOf([
        { client: 1, clock: 0, parent: "extra", key: "k", content: new Y.ContentAny([2]) },
      ]),
  },
  {
    name: "a struct the note has, sent again as an embedded value",
    change: () =>
      updateOf([
        {
          client: 1,
          clock: 0,
          parent: "meta",
          key: "schemaVersion",
          content: new Y.ContentEmbed({ a: 1 }),
        },
      ]),
  },
  {
    name: "a struct the note has, sent again as a nested text",
    change: () =>
      updateOf([
        {
          client: 1,
          clock: 0,
          parent: "meta",
          key: "schemaVersion",
          content: new Y.ContentType(new Y.XmlText()),
        },
      ]),
  },
  {
    name: "a keyed letter under the sequence",
    change: (_note, client) =>
      updateOf([
        { client, clock: 0, parent: "sequence", key: "k", content: new Y.ContentString("x") },
      ]),
  },
  {
    name: "two values under one key, the second deleted by the same change",
    change: (_note, client) =>
      updateOf(
        [
          {
            client,
            clock: 0,
            parent: "containers",
            key: "Z",
            content: new Y.ContentAny(["a", "b"]),
          },
        ],
        [[client, 1, 1]],
      ),
  },
  {
    name: "a struct that starts on a letter the note has and runs past it as a record",
    change: (note) => {
      const end = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(note)).get(1)!;
      return updateOf([
        {
          client: 1,
          clock: end - 1,
          parent: "containers",
          key: "Z",
          content: new Y.ContentAny(["over a letter", "new"]),
        },
      ]);
    },
  },
  {
    name: "a letter the note has, sent again from between the two units of an emoji",
    change: (note) => {
      const low = idsIn(note).insideAPair;
      return (
        low &&
        updateOf([
          {
            client: low.client,
            clock: low.clock,
            parent: "sequence",
            content: new Y.ContentString("x"),
          },
        ])
      );
    },
  },
  {
    name: "a letter typed between the two units of an emoji the note has",
    change: (note, client) => {
      const low = idsIn(note).insideAPair;
      return (
        low &&
        updateOf([
          {
            client,
            clock: 0,
            origin: Y.createID(low.client, low.clock - 1),
            rightOrigin: low,
            content: new Y.ContentString("x"),
          },
        ])
      );
    },
  },
  {
    name: "an emoji, and a letter typed between its two units, in one change",
    change: (note, client) =>
      updateOf([
        { client, clock: 0, origin: idsIn(note).last, content: new Y.ContentString("😀") },
        {
          client,
          clock: 2,
          origin: Y.createID(client, 0),
          rightOrigin: Y.createID(client, 1),
          content: new Y.ContentString("x"),
        },
      ]),
  },
];

const table = (page: { sequence: Y.Text; records: Y.Map<unknown> }, client: number) => {
  const id = (name: string) => `t${String(client)}${name}`;
  for (const [name, type] of [
    ["T", "table"],
    ["R1", "tableRow"],
    ["R2", "tableRow"],
    ["A", "tableHeader"],
    ["B", "tableCell"],
    ["C", "tableCell"],
  ] as const)
    page.records.set(id(name), type);
  for (const [path, text] of [
    [["T", "R1", "A"], "head"],
    [["T", "R1", "B"], "two"],
    [["T", "R2", "C"], "lone"],
    [["R2", "C"], "row with no table"],
  ] as const) {
    page.sequence.insertEmbed(
      page.sequence.length,
      element("block", { type: "paragraph", path: path.map(id) }),
      {},
    );
    page.sequence.insert(page.sequence.length, text, {});
  }
};

const firstLine = (sequence: Y.Text) => firstOf(sequence, "block")!;

const LONG_PATH = "a path of 90,000 ids";
const TAKEN: readonly Case[] = [
  {
    name: LONG_PATH,
    change: made(({ sequence }) =>
      firstLine(sequence).setAttribute(
        "path",
        Array.from({ length: 90_000 }, () => "L") as unknown as string,
      ),
    ),
  },
  {
    name: "a letter with nothing named to its left and a letter named to its right",
    change: (note, client) =>
      updateOf([
        { client, clock: 0, rightOrigin: idsIn(note).letters, content: new Y.ContentString("x") },
      ]),
  },
  {
    name: "a code block whose language holds a line break",
    change: made(({ sequence }) => {
      firstLine(sequence).setAttribute("type", "codeBlock");
      firstLine(sequence).setAttribute("language", "ts\nconsole.log(1)");
    }),
  },
  {
    name: "a raw block of 130 nested quotes",
    change: made(({ sequence }) => {
      firstLine(sequence).setAttribute("type", "rawBlock");
      firstLine(sequence).setAttribute("source", `${"> ".repeat(130)}deep`);
    }),
  },
  {
    name: "a callout whose kind and title hold line breaks and deep quotes",
    change: made(({ records }) => {
      records.set("Q.calloutType", `note\n${"> ".repeat(130)}x`);
      records.set("Q.title", "one\ntwo");
    }),
  },
  {
    name: "CRLF line ends in a code block, a raw block, a math block and a raw inline item",
    change: made(({ sequence }) => {
      const line = (attrs: Record<string, unknown>) =>
        sequence.insertEmbed(sequence.length, element("block", { path: [], ...attrs }), {});
      line({ type: "codeBlock", language: null });
      sequence.insert(sequence.length, "a\r\nb");
      line({ type: "rawBlock", source: "<p>\r\n</p>" });
      line({ type: "mathBlock", tex: "x\r\ny" });
      line({ type: "paragraph" });
      sequence.insertEmbed(sequence.length, element("rawInline", { source: "<b>\r\n</b>" }), {});
    }),
  },
  {
    name: "a letter after a letter of the sequence that names a record as the item to its right",
    change: (note, client) =>
      updateOf([
        {
          client,
          clock: 0,
          origin: idsIn(note).letters,
          rightOrigin: idsIn(note).record,
          content: new Y.ContentString("x"),
        },
      ]),
  },
  {
    name: "a boundary with no attribute",
    change: made(({ sequence }) => sequence.insertEmbed(1, new Y.XmlElement("block"), {})),
  },
  {
    name: "a boundary whose attributes hold the wrong kinds of value",
    change: made(({ sequence }) =>
      sequence.insertEmbed(
        2,
        element("block", { type: 5, path: "x", level: "x", language: 7, tex: [], source: {} }),
        {},
      ),
    ),
  },
  {
    name: "a path of ids no record names, twice the same, and not all strings",
    change: made(({ sequence }) =>
      firstOf(sequence, "block")!.setAttribute("path", [
        "nobody",
        "L",
        "L",
        5,
        null,
        ...Array.from({ length: 200 }, (_, index) => `i${String(index)}`),
      ] as unknown as string),
    ),
  },
  {
    name: "a heading of level 99 and a kind no block has",
    change: made(({ sequence }) => {
      const boundary = firstOf(sequence, "block")!;
      boundary.setAttribute("level", 99 as unknown as string);
      boundary.setAttribute("type", "nonsense");
    }),
  },
  {
    name: "records of kinds no container has, for ids no line names",
    change: made(({ records }) => {
      records.set("L", "paragraph");
      records.set("I1", 42);
      records.set("ghost", "doc");
      records.set("Q", null);
    }),
  },
  {
    name: "attribute records that break their rule",
    change: made(({ records }) => {
      records.set("I1.checked", "yes");
      records.set("L.start", -5);
      records.set("Q.fold", 7);
      records.set("Q.title", { a: [1, 2n, "x"] });
      records.set(
        "c.colwidth",
        Array.from({ length: 5_000 }, (_, index) => index),
      );
    }),
  },
  {
    name: "marks whose values are not attributes",
    change: made(({ sequence }) => {
      sequence.format(1, 4, { bold: true });
      sequence.format(3, 4, { italic: "x" });
      sequence.format(5, 9, { link: { href: 5, target: [], rel: null } });
      sequence.format(0, 30, { code: {} });
    }),
  },
  {
    name: "inline items with no attribute, or the wrong kind of one, in a code block and before the first line",
    change: made(({ sequence }) => {
      sequence.insertEmbed(0, new Y.XmlElement("hardBreak"), {});
      sequence.insertEmbed(sequence.length - 3, new Y.XmlElement("image"), {});
      sequence.insertEmbed(sequence.length - 12, element("wikilink", { target: 5 }), {});
      sequence.insertEmbed(3, element("inlineAtom", { atomId: null, params: 1 }), {});
    }),
  },
  {
    name: "letters before the first line",
    change: made(({ sequence }) => sequence.insert(0, "lead")),
  },
  {
    name: "the first line's boundary deleted",
    change: made(({ sequence }) => sequence.delete(0, 1)),
  },
  {
    name: "everything deleted",
    change: made(({ sequence }) => sequence.delete(0, sequence.length)),
  },
  {
    name: "a table with uneven rows, and a row with no table",
    change: (note, client) => changeMadeBy(note, client, (page) => table(page, client)),
  },
  {
    name: "an attribute a boundary cannot have, removed by the same change",
    change: made(({ sequence }) => {
      const boundary = firstOf(sequence, "block")!;
      boundary.setAttribute("colour", "red");
      boundary.removeAttribute("colour");
    }),
  },
  {
    name: "a letter typed and deleted by the same change",
    change: made(({ sequence }) => {
      sequence.insert(2, "gone");
      sequence.delete(2, 4);
    }),
  },
  {
    name: "a record set three times by one change",
    change: made(({ records }) => {
      for (const kind of ["bulletList", "orderedList", "taskList"]) records.set("L", kind);
    }),
  },
  {
    name: "an emoji typed, and another deleted whole",
    change: made(({ sequence }) => {
      sequence.insert(sequence.length, "😀🎉");
      sequence.delete(sequence.length - 2, 2);
    }),
  },
  {
    name: "20,000 letters typed at once",
    change: made(({ sequence }) => sequence.insert(sequence.length, "many ".repeat(4_000))),
  },
  {
    name: "a list and a nested map as properties",
    change: made(({ doc }) => {
      doc.getMap("frontmatter").set("tags", Y.Array.from(["a", "b"]));
      doc.getMap("frontmatter").set("count", 3);
    }),
  },
];

describe("single changes no editor would send, on a relay that admits format-2 notes", () => {
  it.each(REFUSED)(
    "intake and the journal check refuse $name as sent, and no later check refuses what the room keeps of it",
    ({ change }) => {
      const baseline = seededNote();
      const held = room(baseline);
      const bytes = change(baseline, 77);
      expect(bytes, "the change exists").toBeDefined();
      expect(held.fitsAsSent(bytes!), "the room's check").toBe(false);
      expect(held.journal(bytes!)).not.toBe("accepted");
      const kept = held.offer(bytes!);
      if (kept) expect(held.laterChecks(kept)).toEqual(ACCEPTED);
    },
  );

  it.each(TAKEN)("intake takes $name, and no later check refuses it", ({ change }) => {
    const baseline = seededNote();
    const held = room(baseline);
    const bytes = change(baseline, 77);
    expect(bytes, "the change exists").toBeDefined();
    const kept = held.offer(bytes!);
    expect(kept, "the room's check").toBeDefined();
    expect(held.laterChecks(kept!)).toEqual(ACCEPTED);
    expect(held.activation()).toBe("accepted");
    expect(() => yDocToMarkdown(held.note)).not.toThrow();
  });

  it("whatever intake takes of them, in any order and on top of each other, no later check refuses", () => {
    const counts = { offered: 0, taken: 0 };
    for (let seed = 1; seed <= 10 * SEEDS; seed++) {
      const baseline = seededNote();
      const held = room(baseline);
      const next = random(seed * 2053);
      const all = [...REFUSED, ...TAKEN].filter(({ name }) => name !== LONG_PATH);
      for (let step = 0; step < 14; step++) {
        const picked = all[Math.floor(next() * all.length)]!;
        const { name } = picked;
        const bytes = changeIfItApplies(picked, Y.encodeStateAsUpdate(held.note), 100 + step);
        if (!bytes) continue;
        counts.offered++;
        const kept = held.offer(bytes);
        if (!kept) continue;
        counts.taken++;
        expect(
          held.laterChecks(kept),
          `seed ${String(seed)}, step ${String(step)}: ${name}`,
        ).toEqual(ACCEPTED);
      }
      if (held.taken.length > 0) expect(held.activation(), `seed ${String(seed)}`).toBe("accepted");
      held.note.destroy();
    }
    console.log(`changes no editor would send: ${JSON.stringify(counts)}`);
    expect(counts.taken).toBeGreaterThan(0);
    expect(counts.offered).toBeGreaterThan(counts.taken);
  }, 600_000);
});

const shown = (value: string) =>
  JSON.stringify(
    value.length > 40 ? `${value.slice(0, 24)}… (${String(value.length)} long)` : value,
  );

describe("what a format-2 note's body holds never decides a save", () => {
  it("a raw block at the top that reads as a properties block is taken, where a format-1 note is refused", () => {
    const top: Line = [{ type: "rawBlock", source: "---\na: b\n---" }];
    const { first, second } = inBothFormats([top, [{ type: "paragraph" }, "text"]]);
    expect(registered(second)).toBe("accepted");
    expect(registered(first)).toBe(REFUSED_AT_REGISTRATION);

    const note = inBothFormats([[{ type: "paragraph" }, "text"]]).second;
    const held = room(note);
    const kept = held.offer(
      changeMadeBy(note, 77, ({ sequence }) => {
        firstLine(sequence).setAttribute("type", "rawBlock");
        firstLine(sequence).setAttribute("source", "---\na: b\n---");
      })!,
    );
    expect(kept, "the room's check").toBeDefined();
    expect(held.laterChecks(kept!)).toEqual(ACCEPTED);
  });

  it("a raw inline at the top that reads as a properties block is taken too, and the saved file then reads with properties the note does not have", () => {
    const note = inBothFormats([[{ type: "paragraph" }, "text"]]).second;
    const held = room(note);
    const kept = held.offer(
      changeMadeBy(note, 77, ({ sequence }) =>
        sequence.insertEmbed(1, element("rawInline", { source: "---\na: b\n---\n\n" }), {}),
      )!,
    );
    expect(kept, "the room's check").toBeDefined();
    expect(held.laterChecks(kept!)).toEqual(ACCEPTED);
    expect(getDohcYDocFrontmatter(held.note)).toEqual({});
    const file = yDocToMarkdown(held.note);
    expect(file).toBe("---\na: b\n---\n\ntext\n");
    const read = markdownToYDoc(file);
    expect(getDohcYDocFrontmatter(read)).toEqual({ a: "b" });
    read.destroy();
  });

  it("a code block whose language holds U+2028 is saved with a plain fence, where a format-1 note that holds one is refused and writing it throws", () => {
    const language = `a${String.fromCharCode(0x2028)}b`;
    const { second } = inBothFormats([[{ type: "codeBlock", language }, "code"]]);
    expect(registered(second)).toBe("accepted");
    const note = new Y.Doc({ gc: false });
    Y.applyUpdate(note, second);
    expect(yDocToMarkdown(note)).toBe("```\ncode\n```\n");
    note.destroy();

    const first = markdownToYDoc("```js\ncode\n```\n", { clientID: 1 });
    (first.getXmlFragment("body").get(0) as Y.XmlElement).setAttribute("language", language);
    expect(registered(Y.encodeStateAsUpdate(first))).toBe(REFUSED_AT_REGISTRATION);
    expect(() => yDocToMarkdown(first)).toThrow(/fenced code block/);
    first.destroy();
  });

  it("a note marked as using CRLF line ends may be emptied, as a format-1 note may", () => {
    const { first, second } = inBothFormats([], { dohcMarkdownCrlf: true });
    expect(registered(second)).toBe("accepted");
    expect(registered(first)).toBe("accepted");

    const note = inBothFormats([[{ type: "paragraph" }, "one"]], { dohcMarkdownCrlf: true }).second;
    const held = room(note);
    const kept = held.offer(
      changeMadeBy(note, 77, ({ sequence }) => sequence.delete(0, sequence.length))!,
    );
    expect(kept, "the room's check").toBeDefined();
    expect(held.laterChecks(kept!)).toEqual(ACCEPTED);
  });

  const every = noteWithEveryNode();
  it.each([
    ["each attribute of each node and mark, and the letters of each kind of line", false],
    ["each container's kind, and a line's kind and path", true],
  ] as const)(
    "%s, holding each hostile string: the note is written as Markdown and every check accepts",
    (_name, changesKinds) => {
      for (const value of HOSTILE_STRINGS) {
        const held = room(every.note);
        const change = changeMadeBy(every.note, 77, (page) => {
          for (const place of every.places)
            if (place.changesKinds === changesKinds) place.put(page, value);
        });
        const kept = held.offer(change!);
        expect(kept, `the room's check, for ${shown(value)}`).toBeDefined();
        expect(held.laterChecks(kept!), shown(value)).toEqual(ACCEPTED);
        expect(() => yDocToMarkdown(held.note), shown(value)).not.toThrow();
        held.note.destroy();
      }
    },
    120_000,
  );
});

describe("what a later check still refuses of a note whose every change intake took: capacity, and the rules for properties and metadata", () => {
  it("the file's text kept in the note with no hashes beside it, as for a format-1 note", () => {
    const alone = (doc: Y.Doc) => doc.getMap("meta").set("dohcMarkdownSource", "Body\n");
    const note = seededNote();
    const held = room(note);
    const kept = held.offer(changeMadeBy(note, 77, ({ doc }) => alone(doc))!);
    expect(kept, "the room's check").toBeDefined();
    expect(held.journal(kept!)).toBe(REFUSED_AT_SAVE);
    const first = offeredToAFormat1Note(alone);
    expect(first.room).toBe(true);
    expect(first.journal()).toBe(REFUSED_AT_SAVE);
  });

  it("properties text the properties do not match, which the journal check refuses, as for a format-1 note", () => {
    const other = (doc: Y.Doc) =>
      doc.getMap("meta").set("dohcFrontmatterSource", "status: other\n");
    const note = seededNote();
    const held = room(note);
    const kept = held.offer(changeMadeBy(note, 77, ({ doc }) => other(doc))!);
    expect(kept, "the room's check").toBeDefined();
    expect(held.journal(kept!)).toBe(REFUSED_AT_SAVE);
    const first = offeredToAFormat1Note(other);
    expect(first.room).toBe(true);
    expect(first.journal()).toBe(REFUSED_AT_SAVE);
  });

  it.each([
    [
      "properties nested 200 deep as shared maps",
      (doc: Y.Doc) => {
        let map = new Y.Map<unknown>();
        doc.getMap("frontmatter").set("deep", map);
        for (let level = 0; level < 200; level++) {
          const inner = new Y.Map<unknown>();
          map.set("in", inner);
          map = inner;
        }
      },
    ],
    [
      "one property of 300,000 values",
      (doc: Y.Doc) =>
        doc.getMap("frontmatter").set(
          "many",
          Array.from({ length: 300_000 }, () => null),
        ),
    ],
  ] as const)(
    "%s, in one change: the room refuses it, where a format-1 note takes it and its save refuses it for capacity",
    (_name, write) => {
      const note = seededNote();
      const change = changeMadeBy(note, 77, ({ doc }) => write(doc))!;
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, note);
      expect(liveEditRefusal(copy, change)?.reason).toBe("capacity-refused");
      copy.destroy();
      const first = offeredToAFormat1Note(write);
      expect(first.room).toBe(true);
      expect(first.journal()).toBe("refused: capacity-refused (final)");
    },
  );

  it("more values in the whole note's properties than the save reads, each change within the limit: capacity", () => {
    const note = seededNote();
    const held = room(note);
    const verdicts = ["one", "two", "three"].map((key) => {
      const kept = held.offer(
        changeMadeBy(Y.encodeStateAsUpdate(held.note), 77, ({ doc }) =>
          doc.getMap("frontmatter").set(
            key,
            Array.from({ length: 90_000 }, () => null),
          ),
        )!,
      );
      expect(kept, "the room's check").toBeDefined();
      const verdict = held.journal(kept!);
      Y.applyUpdate(held.note, kept!);
      held.taken.push(kept!);
      return verdict;
    });
    expect(verdicts).toEqual(["accepted", "accepted", "refused: capacity-refused (final)"]);
  }, 120_000);

  it("a line that makes the saved file larger than 2 MiB, in one change of under 2 MiB: capacity", () => {
    const note = seededNote();
    const held = room(note);
    const line = (letters: number) =>
      held.offer(
        changeMadeBy(note, 77, ({ sequence }) => sequence.insert(2, "a".repeat(letters)))!,
      );
    const fits = line(2_000_000);
    expect(fits, "the room's check").toBeDefined();
    expect(held.journal(fits!)).toBe("accepted");
    const over = line(2_097_000);
    expect(over, "the room's check").toBeDefined();
    expect(over!.length).toBeLessThan(2 * 1024 * 1024);
    expect(held.journal(over!)).toBe("refused: capacity-refused (final)");
  }, 120_000);

  it("more lines in the whole note than a check will weigh, each change within the limit: capacity", () => {
    const note = seededNote();
    const held = room(note);
    const after = idsIn(note).last!;
    const emptyLines = (client: number) =>
      updateOf(
        Array.from({ length: 21_000 }, (_, index) => ({
          client,
          clock: index,
          origin: index === 0 ? after : Y.createID(client, index - 1),
          content: new Y.ContentType(new Y.XmlElement("block")),
        })),
      );
    const verdicts = [77, 78].map((client) => {
      const kept = held.offer(emptyLines(client));
      expect(kept, "the room's check").toBeDefined();
      const verdict = held.journal(kept!);
      Y.applyUpdate(held.note, kept!);
      held.taken.push(kept!);
      return verdict;
    });
    expect(verdicts).toEqual(["accepted", "refused: capacity-refused (final)"]);
  }, 120_000);
});

describe("several changes the room took, saved as one", () => {
  it("two changes that each hold 90,000 values pass the journal check together", () => {
    const note = seededNote();
    const held = room(note);
    const kept = ["X.title", "Y.title"].map((key) => {
      const bytes = held.offer(
        changeMadeBy(Y.encodeStateAsUpdate(held.note), 77, ({ records }) =>
          records.set(
            key,
            Array.from({ length: 90_000 }, () => null),
          ),
        )!,
      );
      expect(bytes, "the room's check").toBeDefined();
      Y.applyUpdate(held.note, bytes!);
      return bytes!;
    });
    expect(held.journal(Y.mergeUpdates(kept))).toBe("accepted");
  });

  it("the room's limit is for each change: three it took can together be more values than the save counts", () => {
    const policy = { ...POLICY, maxValueNodeVisits: 500_000 };
    const save = createLiveMarkdownJournalValidator(policy);
    const note = seededNote();
    const saved = (candidate: Uint8Array) =>
      said(
        save({
          document: documentFor(note),
          currentPath: PATH,
          checkpoint: note,
          suffix: [],
          candidate,
        }),
      );
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, note);
    const taken = ["X.title", "Y.title", "Z.title"].map((key, index) => {
      const change = changeMadeBy(Y.encodeStateAsUpdate(copy), 77 + index, ({ records }) =>
        records.set(
          key,
          Array.from({ length: 60_000 }, () => null),
        ),
      )!;
      expect(saved(change)).toBe("accepted");
      expect(liveEditRefusal(copy, change, policy)).toBeUndefined();
      return change;
    });
    copy.destroy();
    expect(saved(Y.mergeUpdates(taken))).toBe("refused: capacity-refused (final)");
  }, 120_000);
});

describe("a note an edit puts past the nodes the engine's Markdown writer reads", () => {
  it("is refused for capacity by the save and by registration, a node past the budget", () => {
    const quotes = Array.from({ length: 63 }, (_, depth) => depth.toString(16));
    const quotedLine = (sequence: Y.Text) => {
      sequence.insertEmbed(sequence.length, element("block", { type: "paragraph", path: quotes }));
      sequence.insert(sequence.length, "a");
    };
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 5;
    doc.getMap("meta").set("schemaVersion", 2);
    for (const id of quotes) doc.getMap(BODY_CONTAINERS_FIELD).set(id, "blockquote");
    for (let line = 0; line < 4_032; line++) quotedLine(doc.getText(BODY_SEQUENCE_FIELD));
    const baseline = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    expect(
      said(register({ document: documentFor(baseline), currentPath: PATH, checkpoint: baseline })),
    ).toBe("accepted");

    const held = room(baseline);
    const kept = held.offer(changeMadeBy(baseline, 6, ({ sequence }) => quotedLine(sequence))!);
    expect(kept, "the room's check").toBeDefined();
    expect(held.laterChecks(kept!)).toEqual({
      journal: "refused: capacity-refused (final)",
      engineReader: "refused: capacity-refused (final)",
      registration: "refused: capacity-refused (registration-input)",
    });
  }, 120_000);
});

describe("what the room keeps of a value no encoder writes", () => {
  const record =
    (bytes: readonly number[]): Case["change"] =>
    (_note, client) =>
      updateOf([
        { client, clock: 0, parent: "containers", key: "X", content: anyAsWritten(bytes) },
      ]);
  const mark =
    (json: string): Case["change"] =>
    (note, client) =>
      updateOf([
        { client, clock: 0, origin: idsIn(note).letters, content: markAsWritten("link", json) },
      ]);
  const text = (value: string) => [
    value.length,
    ...Array.from(value, (unit) => unit.charCodeAt(0)),
  ];
  const stored = (kept: Uint8Array) => {
    const item = Y.decodeUpdate(kept).structs.find(
      (struct): struct is Y.Item => struct instanceof Y.Item,
    )!;
    return item.content instanceof Y.ContentFormat
      ? (item.content.value as unknown)
      : (item.content.getContent()[0] as unknown);
  };

  it.each([
    ["a record with a key named __proto__", record([118, 1, ...text("__proto__"), 118, 0]), {}],
    [
      "a record with a key twice",
      record([118, 2, ...text("a"), 126, ...text("a"), 120]),
      { a: true },
    ],
    ["a mark's value with a key twice", mark('{"href":"a","href":"b"}'), { href: "b" }],
    ["a mark's value with a negative zero", mark('{"a":-0}'), { a: 0 }],
    ["a mark's value with a number too large to keep", mark('{"a":1e400}'), { a: null }],
  ] as const)(
    "%s: both checks refuse it as sent, and the room's trim rewrites it to a value it then takes",
    (_name, change, rewritten) => {
      const note = seededNote();
      const held = room(note);
      const bytes = change(note, 77)!;
      expect(held.fitsAsSent(bytes)).toBe(false);
      expect(held.journal(bytes)).not.toBe("accepted");
      const kept = held.offer(bytes);
      expect(kept, "the room's check, after its trim").toBeDefined();
      expect(stored(kept!)).toEqual(rewritten);
      expect(Object.keys(stored(kept!) as object)).toEqual(Object.keys(rewritten));
      expect(held.laterChecks(kept!)).toEqual(ACCEPTED);
    },
  );

  it("a mark's value with a key named __proto__ comes through the trim as sent, and the room refuses it", () => {
    const note = seededNote();
    const held = room(note);
    const bytes = mark('{"href":"x","__proto__":{"a":1}}')(note, 77)!;
    expect(held.fitsAsSent(bytes)).toBe(false);
    expect(held.journal(bytes)).not.toBe("accepted");
    expect(held.offer(bytes)).toBeUndefined();
  });
});

describe("the work intake does for one change", () => {
  const rules = { policy: POLICY, metadata: () => true };
  const note = seededNote();
  const after = idsIn(note).last!;
  const worked = (change: Uint8Array) => {
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, note);
    const work = { steps: 0 };
    const refusal = bodySequenceChangeRefusal(
      copy,
      change,
      () => Y.applyUpdate(copy, change),
      rules,
      work,
    );
    copy.destroy();
    return { refusal, steps: work.steps };
  };

  it.each([
    [
      "25,000 letters, each after a struct that arrives collected",
      50_000,
      () =>
        updateOf(
          Array.from({ length: 50_000 }, (_, clock) =>
            clock % 2 === 0
              ? { client: 77, clock, collected: 1 }
              : {
                  client: 77,
                  clock,
                  origin: clock === 1 ? after : Y.createID(77, clock - 2),
                  content: new Y.ContentString("x"),
                },
          ),
        ),
    ],
    [
      "40,000 records, each set twice by the same change",
      80_000,
      () =>
        updateOf(
          Array.from({ length: 40_000 }, (_, index) => ({
            client: 77,
            clock: 2 * index,
            parent: "containers",
            key: `k${String(index)}`,
            content: new Y.ContentAny(["first", "second"]),
          })),
          Array.from({ length: 40_000 }, (_, index) => [77, 2 * index, 1] as const),
        ),
    ],
    [
      "100,000 emoji, and 10,000 of them deleted one by one",
      10_001,
      () =>
        updateOf(
          [
            {
              client: 77,
              clock: 0,
              origin: after,
              content: new Y.ContentString("😀".repeat(100_000)),
            },
          ],
          Array.from({ length: 10_000 }, (_, index) => [77, 4 * index, 2] as const),
        ),
    ],
  ] as const)(
    "grows with the change and not with its square: %s",
    (_name, structsAndDeletes, build) => {
      const { refusal, steps } = worked(build());
      expect(refusal).toBeUndefined();
      expect(steps).toBeGreaterThan(structsAndDeletes);
      expect(steps).toBeLessThan(64 * structsAndDeletes);
    },
    60_000,
  );

  it("says capacity, not a broken change, when reading the change is more work than the policy allows", () => {
    const tight = { ...POLICY, maxValueNodeVisits: 50 };
    const change = changeMadeBy(note, 77, ({ records }) =>
      records.set(
        "X.title",
        Array.from({ length: 100 }, () => null),
      ),
    )!;
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, note);
    expect(
      bodySequenceChangeRefusal(copy, change, () => Y.applyUpdate(copy, change), {
        ...rules,
        policy: tight,
      }),
    ).toBe("capacity-refused");
    copy.destroy();
    expect(
      said(
        createLiveMarkdownJournalValidator(tight)({
          document: documentFor(note),
          currentPath: PATH,
          checkpoint: note,
          suffix: [],
          candidate: change,
        }),
      ),
    ).toMatch(/^refused: capacity-refused/);
    const fresh = new Y.Doc({ gc: false });
    Y.applyUpdate(fresh, note);
    expect(liveEditRefusal(fresh, change, tight)).toEqual({ reason: "capacity-refused" });
    expect(liveEditRefusal(fresh, new Uint8Array([1, 2, 3]))).toEqual({
      reason: "invalid-update",
    });
    fresh.destroy();
    const again = new Y.Doc({ gc: false });
    Y.applyUpdate(again, note);
    expect(liveEditRefusal(again, change)).toBeUndefined();
    again.destroy();
  });
});

describe("the room's check of one change, by itself", () => {
  const note = seededNote();
  const past = (unit: string, most: number, held: number) =>
    `One change to a note holds at most ${most.toLocaleString("en-US")} ${unit}. This one holds ${held.toLocaleString("en-US")}.`;
  const checked = (change: Uint8Array, policy: OrderedLiveUpdateCutPolicy = POLICY) => {
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, note);
    const work: BodySequenceIntakeWork = { steps: 0 };
    const refusal = liveEditRefusal(copy, change, policy, work);
    copy.destroy();
    return { refusal, work };
  };
  const saved = (change: Uint8Array) => room(note).journal(change);
  const nested = (levels: number, innermost?: unknown) => (doc: Y.Doc) => {
    let map = new Y.Map<unknown>();
    doc.getMap("frontmatter").set("deep", map);
    for (let level = 1; level < levels; level++) {
      const inner = new Y.Map<unknown>();
      map.set("in", inner);
      map = inner;
    }
    if (innermost !== undefined) map.set("value", innermost);
  };

  it.each(LARGE_HONEST_CHANGES)(
    "%s: it is at each value and each struct a fixed number of times and hashes nothing, and what it takes the save takes",
    (_name, change, holds) => {
      const bytes = changeMadeBy(note, 77, change)!;
      expect({ bytes: bytes.length, ...bodySequenceChangeSize(bytes) }).toMatchObject(holds);
      const { refusal, work } = checked(bytes);
      const counted = holds.structs + holds.values;
      if (holds.values > BODY_SEQUENCE_CHANGE_MAX_VALUES) {
        expect(refusal).toEqual({
          reason: "capacity-refused",
          limit: past("values", BODY_SEQUENCE_CHANGE_MAX_VALUES, holds.values),
        });
        expect(work).toEqual({ steps: counted });
        return;
      }
      expect(refusal).toBeUndefined();
      expect(work.read).toMatchObject({
        structVisits: holds.structs,
        valueNodeVisits: holds.values,
        hashedBytes: 0,
      });
      expect(work.steps).toBe(
        (bytes.length > BODY_SEQUENCE_CHANGE_MAX_VALUES ? counted : 0) +
          holds.values +
          3 * holds.structs,
      );
      expect(saved(bytes)).toBe("accepted");
    },
    120_000,
  );

  it.each(
    [1_900_001, 1_300_001, 400_001, 896_001, 200_001].map(
      (values, index) => [COSTLY_CHANGES[index]![0], COSTLY_CHANGES[index]![1], values] as const,
    ),
  )(
    "%s: refused for capacity by its count of values, which names the limit, before it is read",
    (_name, change, values) => {
      const { refusal, work } = checked(changeMadeBy(note, 77, change)!);
      expect(refusal).toEqual({
        reason: "capacity-refused",
        limit: past("values", 100_000, values),
      });
      expect(work).toEqual({ steps: 1 + values });
    },
    120_000,
  );

  it("60,000 maps, each inside the one before, under frontmatter: refused for capacity, as the save refuses it", () => {
    const bytes = changeMadeBy(note, 77, COSTLY_CHANGES[5]![1])!;
    expect(checked(bytes).refusal).toEqual({ reason: "capacity-refused" });
    expect(saved(bytes)).toBe("refused: capacity-refused (candidate)");
  }, 120_000);

  const letters = (count: number) =>
    updateOf(
      Array.from({ length: count }, (_, clock) => ({
        client: 77,
        clock,
        origin: clock === 0 ? idsIn(note).last : Y.createID(77, clock - 1),
        content: new Y.ContentString("x"),
      })),
    );

  it.each([
    [
      "100,000 values in one record",
      changeMadeBy(note, 77, ({ records }) =>
        records.set(
          "X.title",
          Array.from({ length: 99_999 }, () => null),
        ),
      )!,
    ],
    [
      "one record with 99,999 keys",
      changeMadeBy(note, 77, ({ records }) =>
        records.set(
          "X.title",
          Object.fromEntries(
            Array.from({ length: 99_999 }, (_, index) => [`k${String(index)}`, null]),
          ),
        ),
      )!,
    ],
    [
      "one mark whose value holds 99,998 keys",
      changeMadeBy(note, 77, ({ sequence }) =>
        sequence.format(1, 2, {
          link: Object.fromEntries(
            Array.from({ length: 99_998 }, (_, index) => [`k${String(index)}`, null]),
          ),
        }),
      )!,
    ],
    ["100,000 letters, each its own item", letters(100_000)],
  ] as const)(
    "%s is at a limit and not past it: the room takes it, and the save takes it",
    (name, bytes) => {
      expect(bodySequenceChangeSize(bytes)).toMatchObject(
        name.includes("letters") ? { structs: 100_000 } : { values: 100_000 },
      );
      expect(checked(bytes).refusal).toBeUndefined();
      expect(saved(bytes)).toBe("accepted");
    },
    120_000,
  );

  it("a change of 100,001 values is refused for capacity with a sentence that names the limit, which is the room's own and under what the save counts", () => {
    const bytes = changeMadeBy(note, 77, ({ records }) =>
      records.set(
        "X.title",
        Array.from({ length: 100_000 }, () => null),
      ),
    )!;
    const { refusal, work } = checked(bytes);
    expect(refusal).toEqual({
      reason: "capacity-refused",
      limit: past("values", 100_000, 100_001),
    });
    expect(work.read).toBeUndefined();
    expect(saved(bytes)).toBe("accepted");
  }, 120_000);

  it.each([
    [
      "100,001 items that do not join",
      updateOf(
        Array.from({ length: 100_001 }, (_, clock) => ({
          client: 77,
          clock,
          parent: "frontmatter",
          key: `k${String(clock)}`,
          content: new Y.ContentType(new Y.Map()),
        })),
      ),
      past("items", 100_000, 100_001),
    ],
    [
      "40,001 lines, which weigh more than a note may",
      updateOf(
        Array.from({ length: 40_001 }, (_, clock) => ({
          client: 77,
          clock,
          origin: clock === 0 ? idsIn(note).last : Y.createID(77, clock - 1),
          content: new Y.ContentType(new Y.XmlElement("block")),
        })),
      ),
      past(
        "units of weight, one for each item, two for each range it deletes and 6 more for each element",
        280_000,
        280_007,
      ),
    ],
  ] as const)(
    "a change of %s is refused for capacity with a sentence that names the limit, and the save refuses it for capacity too",
    (_name, bytes, limit) => {
      const { refusal, work } = checked(bytes);
      expect(refusal).toEqual({ reason: "capacity-refused", limit });
      expect(work.read).toBeUndefined();
      expect(saved(bytes)).toMatch(/^refused: capacity-refused/);
    },
    120_000,
  );

  it.each([
    ["129 maps, each inside the one before", nested(129), undefined],
    ["130 maps, each inside the one before", nested(130), "capacity-refused"],
    ["a value 127 levels deep inside one map", nested(1, deep(127)), undefined],
    ["a value 128 levels deep inside one map", nested(1, deep(128)), "capacity-refused"],
    [
      "130 maps, each inside the one before, deleted by the same change",
      (doc: Y.Doc) => {
        nested(130)(doc);
        doc.getMap("frontmatter").delete("deep");
      },
      undefined,
    ],
  ] as const)(
    "properties of %s: the room and the save agree on capacity",
    (_name, write, reason) => {
      const bytes = changeMadeBy(note, 77, ({ doc }) => write(doc))!;
      expect(checked(bytes).refusal?.reason).toBe(reason);
      const save = saved(bytes);
      if (reason) expect(save).toBe("refused: capacity-refused (candidate)");
      else expect(save).not.toMatch(/capacity/);
    },
  );

  const lineWithDeletes = (text: string, ranges: number, width: number, apart: number) =>
    updateOf(
      [{ client: 77, clock: 0, origin: idsIn(note).last, content: new Y.ContentString(text) }],
      Array.from({ length: ranges }, (_, index) => [77, apart * index, width] as const),
    );

  it.each([
    [
      "one line of 500,000 letters and 249,999 of them deleted one by one, every other letter",
      lineWithDeletes("a".repeat(500_000), 249_999, 1, 2),
      249_999,
    ],
    [
      "249,999 emoji, each deleted by a range of its own",
      lineWithDeletes("😀".repeat(249_999), 249_999, 2, 2),
      249_999,
    ],
  ] as const)(
    "%s: refused for capacity by its count of delete ranges, which names the limit, before it is read",
    (_name, bytes, deletes) => {
      expect(bodySequenceChangeSize(bytes)).toMatchObject({ structs: 1, values: 0, deletes });
      const { refusal, work } = checked(bytes);
      expect(refusal).toEqual({
        reason: "capacity-refused",
        limit: past(
          "items, counting two more for each range it deletes, which can split one",
          100_000,
          1 + 2 * deletes,
        ),
      });
      expect(work).toEqual({ steps: 1 + deletes });
    },
    120_000,
  );

  it("one line of 100,000 letters and 49,999 of them deleted one by one is at the limit: the room takes it, and the save takes it", () => {
    const bytes = lineWithDeletes("a".repeat(100_000), 49_999, 1, 2);
    const { refusal, work } = checked(bytes);
    expect(refusal).toBeUndefined();
    expect(work.steps).toBe(3 + 5 * 49_999);
    const after = new Y.Doc({ gc: false });
    Y.applyUpdate(after, note);
    Y.applyUpdate(after, bytes);
    expect(after.store.clients.get(77)).toHaveLength(2 * 49_999);
    after.destroy();
    expect(saved(bytes)).toBe("accepted");
  }, 120_000);

  it("40,000 emoji, each deleted by a range of its own: the room is at each range four times, looks no pair up twice, and the save takes it", () => {
    const bytes = lineWithDeletes("😀".repeat(40_000), 40_000, 2, 2);
    const { refusal, work } = checked(bytes);
    expect(refusal).toBeUndefined();
    expect(work.steps).toBe(3 + 4 * 40_000);
    expect(saved(bytes)).toBe("accepted");
  }, 120_000);

  const recordAsWritten = (
    keys: number,
    write: (wire: encoding.Encoder, index: number) => void,
  ) => {
    const wire = encoding.createEncoder();
    encoding.writeUint8(wire, 118);
    encoding.writeVarUint(wire, keys);
    for (let index = 0; index < keys; index += 1) write(wire, index);
    return updateOf([
      {
        client: 77,
        clock: 0,
        parent: "containers",
        key: "X",
        content: anyAsWritten(Array.from(encoding.toUint8Array(wire))),
      },
    ]);
  };

  it("an object on the wire whose __proto__ key holds bytes, and 150,000 keys after it: every key is counted, and the change is refused for capacity before it is read", () => {
    const bytes = recordAsWritten(150_001, (wire, index) => {
      if (index === 0) {
        encoding.writeVarString(wire, "__proto__");
        encoding.writeUint8(wire, 116);
        encoding.writeVarUint8Array(wire, new Uint8Array([0]));
        return;
      }
      encoding.writeVarString(wire, `k${index.toString(36)}`);
      encoding.writeUint8(wire, 126);
    });
    expect(bodySequenceChangeSize(bytes)).toMatchObject({ structs: 1, values: 150_001 });
    const { refusal, work } = checked(bytes);
    expect(refusal).toEqual({
      reason: "capacity-refused",
      limit: past("values", 100_000, 150_001),
    });
    expect(work).toEqual({ steps: 1 + 150_001 });
  });

  it("an object on the wire with one key 350,000 times is one key once decoded: the count cannot see the copies, and the read refuses the change at the second", () => {
    const bytes = recordAsWritten(350_000, (wire) => {
      encoding.writeVarString(wire, "a");
      encoding.writeUint8(wire, 126);
    });
    expect(bodySequenceChangeSize(bytes)).toMatchObject({ structs: 1, values: 2 });
    const { refusal, work } = checked(bytes);
    expect(refusal).toEqual({ reason: "invalid-update" });
    expect(work).toEqual({ steps: 1 + 2 });
    const read = readLiveUpdateAsTheCutDoes(bytes, {
      ...POLICY,
      maxValueNodeVisits: 3,
    });
    expect(read).toEqual({ kind: "refused", reason: "invalid-update" });
  });

  it.each([
    ["40,000 levels deep, in a change small enough not to be counted", 40_000, false],
    ["50,000 levels deep, in a change the count cannot decode", 50_000, true],
  ] as const)("a value nested %s: refused for capacity", (_name, levels, counted) => {
    const wire: number[] = [];
    for (let level = 0; level < levels; level += 1) wire.push(117, 1);
    wire.push(126);
    const bytes = updateOf([
      { client: 77, clock: 0, parent: "containers", key: "X", content: anyAsWritten(wire) },
    ]);
    expect(bytes.length > BODY_SEQUENCE_CHANGE_MAX_VALUES).toBe(counted);
    if (counted) expect(() => bodySequenceChangeSize(bytes)).toThrow(RangeError);
    expect(checked(bytes).refusal).toEqual({ reason: "capacity-refused" });
  });

  it("bytes that are no change, large enough to be counted: refused as a broken change", () => {
    const bytes = new Uint8Array(150_000).fill(255);
    expect(() => bodySequenceChangeSize(bytes)).toThrow();
    expect(checked(bytes).refusal).toEqual({ reason: "invalid-update" });
  });

  it("a small change is not counted, and is read once", () => {
    const bytes = changeMadeBy(note, 77, ({ sequence }) => sequence.insert(2, "x"))!;
    const { refusal, work } = checked(bytes);
    expect(refusal).toBeUndefined();
    expect(work).toMatchObject({ steps: 3, read: { structVisits: 1, hashedBytes: 0 } });
  });

  it("the save's check is at what one read of a change is at no more often than the room's policy divides by", () => {
    const wide = Object.fromEntries(
      Object.keys(POLICY).map((field) => [field, 1e12]),
    ) as unknown as OrderedLiveUpdateCutPolicy;
    const each = Object.fromEntries(
      Object.keys(POLICY).map((field) => [field, 840]),
    ) as unknown as OrderedLiveUpdateCutPolicy;
    const room = bodySequenceRoomPolicy(each);
    const counted = (candidate: Uint8Array) => {
      const cut = validateOrderedLiveUpdateCut(
        { mode: "journal-candidate", checkpoint: note, suffix: [], candidate },
        wide,
      );
      if (cut.kind !== "accepted") throw new Error(`The cut refused it: ${cut.reason}`);
      return cut.cut.finishAfterProjection().usage;
    };
    const letter = counted(changeMadeBy(note, 9, ({ sequence }) => sequence.insert(2, "x"))!);
    const at = idsIn(note).letters!;
    const emptyDeleteGroups = encoding.createEncoder();
    encoding.writeVarUint(emptyDeleteGroups, 0);
    encoding.writeVarUint(emptyDeleteGroups, 2_000);
    for (let client = 0; client < 2_000; client++) {
      encoding.writeVarUint(emptyDeleteGroups, 5_000 + client);
      encoding.writeVarUint(emptyDeleteGroups, 0);
    }
    const inputs: [string, Uint8Array][] = [
      ...LARGE_HONEST_CHANGES.slice(0, 1).map(
        ([name, change]) => [name, changeMadeBy(note, 77, change)!] as [string, Uint8Array],
      ),
      ["one line 64 containers deep", changeMadeBy(note, 77, LARGE_HONEST_CHANGES[3]![1])!],
      ["1,000 column widths", changeMadeBy(note, 77, LARGE_HONEST_CHANGES[4]![1])!],
      [
        "a mark whose value holds 2,000 keys",
        changeMadeBy(note, 77, ({ sequence }) =>
          sequence.format(1, 2, {
            link: Object.fromEntries(
              Array.from({ length: 2_000 }, (_, index) => [`k${String(index)}`, "v"]),
            ),
          }),
        )!,
      ],
      [
        "a line of 100,000 letters",
        changeMadeBy(note, 77, ({ sequence }) => sequence.insert(2, "a".repeat(100_000)))!,
      ],
      [
        "500 letters from 500 editors",
        Y.mergeUpdates(
          Array.from({ length: 500 }, (_, index) =>
            changeMadeBy(note, 1_000 + index, ({ sequence }) => sequence.insert(2, "a"))!,
          ),
        ),
      ],
      [
        "5,000 copies of one delete",
        updateOf(
          [],
          Array.from({ length: 5_000 }, () => [at.client, at.clock, 1] as const),
        ),
      ],
      ["2,000 delete groups that delete nothing", encoding.toUint8Array(emptyDeleteGroups)],
    ];
    const COUNTS = [
      ["maxStructVisits", "structVisits"],
      ["maxValueNodeVisits", "valueNodeVisits"],
      ["maxDecodedPayloadByteVisits", "decodedPayloadByteVisits"],
      ["maxStructClientGroupVisits", "structClientGroupVisits"],
      ["maxDeleteClientGroupVisits", "deleteClientGroupVisits"],
      ["maxDeleteIntervalVisits", "deleteIntervalVisits"],
    ] as const;
    for (const [name, bytes] of inputs) {
      const read = readLiveUpdateAsTheCutDoes(bytes, wide);
      if (read.kind !== "read") throw new Error(`${name} was not read: ${read.reason}`);
      const save = counted(bytes);
      expect(read.usage.hashedBytes, name).toBe(0);
      expect(save.hashedBytes, name).toBeGreaterThan(bytes.length - 100);
      for (const [limit, count] of COUNTS)
        expect(save[count] - letter[count], `${name}: ${count}`).toBeLessThanOrEqual(
          (each[limit] / room[limit]) * read.usage[count],
        );
    }
  }, 120_000);
});

describe("a whole history, checked at activation", () => {
  const history = (checkpoint: Uint8Array, rows: readonly Uint8Array[]) =>
    said(
      activate(
        {
          document: documentFor(checkpoint),
          currentPath: PATH,
          checkpoint,
          suffix: rows.slice(0, -1),
          candidate: rows.at(-1)!,
        },
        { from: 0, visit: () => {} },
      ),
    );
  const rowsOf = (checkpoint: Uint8Array, ...changes: ((doc: Y.Doc) => void)[]) => {
    const page = new Y.Doc({ gc: false });
    page.clientID = 77;
    Y.applyUpdate(page, checkpoint);
    const rows: Uint8Array[] = [];
    page.on("update", (update: Uint8Array) => rows.push(update));
    for (const change of changes) page.transact(() => change(page));
    page.destroy();
    return rows;
  };
  const property = (doc: Y.Doc) => doc.getMap("frontmatter").set("status", "later");

  it("is refused when an entry before the last makes a format-1 note a format-2 note", () => {
    const doc = markdownToYDoc("---\nstatus: draft\n---\n\nBody\n", { clientID: 1 });
    const note = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    expect(history(note, rowsOf(note, property))).toBe("accepted");
    expect(
      history(
        note,
        rowsOf(note, (page) => page.getMap("meta").set("schemaVersion", 2), property),
      ),
    ).toBe("refused: invalid-schema (admitted-cut)");
  });

  it("is refused when an entry before the last breaks an intake rule of a format-2 note", () => {
    const note = seededNote();
    expect(history(note, rowsOf(note, property))).toBe("accepted");
    for (const broken of [
      (page: Y.Doc) => page.getText(BODY_SEQUENCE_FIELD).insertEmbed(1, { foo: 1 }),
      (page: Y.Doc) => page.getMap("meta").set("schemaVersion", 1),
      (page: Y.Doc) => page.getMap(BODY_CONTAINERS_FIELD).set("M", new Y.Map()),
    ])
      expect(history(note, rowsOf(note, broken, property))).toBe(
        "refused: invalid-schema (admitted-cut)",
      );
  });
});

describe("the items a format-2 note is registered with", () => {
  const withWritten = (write: (doc: Y.Doc) => unknown) => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, seededNote());
    doc.clientID = 5;
    doc.transact(() => write(doc));
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return state;
  };
  const sequenceOf = (doc: Y.Doc) => doc.getText(BODY_SEQUENCE_FIELD);
  const recordsOf = (doc: Y.Doc) => doc.getMap<unknown>(BODY_CONTAINERS_FIELD);

  const HELD: readonly (readonly [name: string, write: (doc: Y.Doc) => unknown])[] = [
    ["a map under containers", (doc: Y.Doc) => recordsOf(doc).set("M", new Y.Map())],
    ["a list under containers", (doc: Y.Doc) => recordsOf(doc).set("M", new Y.Array())],
    ["a record whose key is no id", (doc: Y.Doc) => recordsOf(doc).set("has space", "callout")],
    ["an embedded value in the sequence", (doc: Y.Doc) => sequenceOf(doc).insertEmbed(1, { a: 1 })],
    [
      "a text nested in the sequence",
      (doc: Y.Doc) => sequenceOf(doc).insertEmbed(1, new Y.XmlText("x")),
    ],
    [
      "an element of an unknown name in the sequence",
      (doc: Y.Doc) => sequenceOf(doc).insertEmbed(1, new Y.XmlElement("script")),
    ],
    ["a mark the schema lacks", (doc: Y.Doc) => sequenceOf(doc).format(1, 3, { colour: "red" })],
    [
      "an attribute a line cannot have",
      (doc: Y.Doc) => firstLine(sequenceOf(doc)).setAttribute("colour", "red"),
    ],
    [
      "a paragraph under body",
      (doc: Y.Doc) => doc.getXmlFragment("body").insert(0, [new Y.XmlElement("paragraph")]),
    ],
    ["a metadata key no note has", (doc: Y.Doc) => doc.getMap("meta").set("owner", "me")],
  ];

  it.each(HELD)("registration refuses a note that holds %s", (_name, write) => {
    expect(registered(withWritten(() => {}))).toBe("accepted");
    expect(registered(withWritten(write))).toBe(REFUSED_AT_REGISTRATION);
  });

  it.each(HELD)("activation refuses a history whose first entry holds %s", (_name, write) => {
    const history = (checkpoint: Uint8Array) =>
      said(
        activate(
          {
            document: documentFor(checkpoint),
            currentPath: PATH,
            checkpoint,
            suffix: [],
            candidate: changeMadeBy(checkpoint, 77, ({ doc }) =>
              doc.getMap("frontmatter").set("status", "later"),
            )!,
          },
          { from: 0, visit: () => {} },
        ),
      );
    expect(history(withWritten(() => {}))).toBe("accepted");
    expect(history(withWritten(write))).toBe("refused: invalid-schema (admitted-cut)");
  });

  it("intake takes no write into a map or a list that hangs under containers", () => {
    for (const nested of [() => new Y.Map<unknown>(), () => new Y.Array<unknown>()]) {
      const note = withWritten((doc) => recordsOf(doc).set("M", nested()));
      const held = room(note);
      const write = changeMadeBy(note, 77, ({ records }) => {
        const held = records.get("M");
        if (held instanceof Y.Map) held.set("k", "v");
        else (held as Y.Array<unknown>).push(["v"]);
      })!;
      expect(held.fitsAsSent(write)).toBe(false);
      expect(held.offer(write)).toBeUndefined();
    }
  });
});

describe.each([
  ["off", false],
  ["on", true],
] as const)(
  "the format marker of a format-1 note, with the relay's setting %s",
  (_name, admitted) => {
    beforeAll(() => admitBodySequenceNotes(admitted));
    afterAll(() => admitBodySequenceNotes(true));
    const fits = (note: Uint8Array, change: Uint8Array) => {
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, note);
      const taken = liveEditFitsCopy(copy, change);
      copy.destroy();
      return taken;
    };
    const sentBy = (note: Uint8Array, change: (page: Y.Doc) => void) => {
      const page = new Y.Doc({ gc: false });
      page.clientID = 77;
      Y.applyUpdate(page, note);
      let sent: Uint8Array | undefined;
      page.on("update", (update: Uint8Array) => {
        sent = update;
      });
      page.transact(() => change(page));
      page.destroy();
      return sent!;
    };

    it("no change replaces or deletes it, and other changes are taken as before", () => {
      expect(
        offeredToAFormat1Note((page) => page.getMap("frontmatter").set("status", "done")).room,
      ).toBe(true);
      for (const change of [
        (page: Y.Doc) => page.getMap("meta").set("schemaVersion", 2),
        (page: Y.Doc) => page.getMap("meta").set("schemaVersion", 1),
        (page: Y.Doc) => page.getMap("meta").delete("schemaVersion"),
        (page: Y.Doc) => {
          page.getMap("meta").set("schemaVersion", 2);
          page.getMap("meta").set("schemaVersion", 1);
        },
      ])
        expect(offeredToAFormat1Note(change).room).toBe(false);
    });

    it("a note that has none may be given the number 1, as the engine and the importer do, and nothing else", () => {
      const empty = Y.encodeStateAsUpdate(new Y.Doc());
      const imported = markdownToYDoc("Body\n", { clientID: 1 });
      expect(fits(empty, Y.encodeStateAsUpdate(imported))).toBe(true);
      imported.getMap("meta").delete("schemaVersion");
      const without = Y.encodeStateAsUpdate(imported);
      imported.destroy();
      expect(
        fits(
          without,
          sentBy(without, (page) => page.getMap("meta").set("schemaVersion", 1)),
        ),
      ).toBe(true);
      for (const value of [2, "1", 1n, true, null])
        expect(
          fits(
            without,
            sentBy(without, (page) => page.getMap("meta").set("schemaVersion", value)),
          ),
          String(value),
        ).toBe(false);
    });
  },
);

describe("the relay's setting", () => {
  it("off, a format-2 note is not registered and takes no change, and on again it takes them", () => {
    const note = seededNote();
    const changes = [
      changeMadeBy(note, 77, ({ sequence }) => sequence.insert(2, "x"))!,
      changeMadeBy(note, 77, ({ sequence }) => sequence.delete(2, 1))!,
      changeMadeBy(note, 77, ({ doc }) => doc.getMap("frontmatter").set("status", "done"))!,
    ];
    const answers = () => ({
      registration: registered(note),
      room: changes.map((change) => {
        const copy = new Y.Doc({ gc: false });
        Y.applyUpdate(copy, note);
        const refusal = liveEditRefusal(copy, change);
        copy.destroy();
        return refusal?.reason ?? "taken";
      }),
      journal: changes.map((change) => room(note).journal(change)),
    });
    const on = {
      registration: "accepted",
      room: ["taken", "taken", "taken"],
      journal: ["accepted", "accepted", "accepted"],
    };
    expect(answers()).toEqual(on);
    admitBodySequenceNotes(false);
    try {
      expect(answers()).toEqual({
        registration: REFUSED_AT_REGISTRATION,
        room: ["invalid-update", "invalid-update", "invalid-update"],
        journal: Array.from({ length: 3 }, () => "refused: invalid-schema (admitted-cut)"),
      });
    } finally {
      admitBodySequenceNotes(true);
    }
    expect(answers()).toEqual(on);
  });

  it("on, a format-1 note is checked as before, and no change can make it a format-2 note", () => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 1;
    doc.getMap("meta").set("schemaVersion", 1);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("one")]);
    doc.getXmlFragment("body").insert(0, [paragraph]);
    const baseline = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const offered = (change: (page: Y.Doc) => void) => {
      const page = new Y.Doc({ gc: false });
      page.clientID = 77;
      Y.applyUpdate(page, baseline);
      let sent: Uint8Array | undefined;
      page.on("update", (bytes: Uint8Array) => {
        sent = bytes;
      });
      page.transact(() => change(page));
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, baseline);
      const verdict = {
        room: liveEditFitsCopy(copy, sent!),
        journal: said(
          admit({
            document: documentFor(baseline),
            currentPath: PATH,
            checkpoint: baseline,
            suffix: [],
            candidate: sent!,
          }),
        ),
      };
      copy.destroy();
      page.destroy();
      return verdict;
    };
    expect(
      offered((page) => {
        const text = (page.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.insert(3, " two");
      }),
    ).toEqual({ room: true, journal: "accepted" });
    expect(offered((page) => page.getMap("meta").set("schemaVersion", 2))).toEqual({
      room: false,
      journal: "refused: invalid-schema (candidate)",
    });
    expect(offered((page) => page.getText(BODY_SEQUENCE_FIELD).insert(0, "x"))).toEqual({
      room: false,
      journal: "refused: invalid-schema (final)",
    });
  });
});

describe("which root a note that says its body is one sequence is read from", () => {
  const stray = (doc: Y.Doc) => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("stray")]);
    doc.getXmlFragment("body").insert(0, [paragraph]);
  };

  it("its text under body and no item in its sequence, as a first-format note a change marked: the file holds that text, not a blank body", () => {
    const doc = markdownToYDoc("---\nstatus: draft\n---\n\nKept line\n");
    doc.getMap("meta").set("schemaVersion", 2);
    expect(yDocToMarkdown(doc)).toBe("---\nstatus: draft\n---\n\nKept line\n");
    doc.destroy();
  });

  it("its lines in its sequence and a paragraph a writer that does not know the format put under body: the file holds its lines", () => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, seededNote());
    const lines = yDocToMarkdown(doc);
    expect(lines.split("\n").filter((line) => line !== "").length).toBeGreaterThan(5);
    stray(doc);
    expect(yDocToMarkdown(doc)).toBe(lines);
    doc.destroy();
  });

  it("every line of its sequence deleted and a paragraph under body: the file is the emptied note, since its sequence still holds items", () => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, seededNote());
    const sequence = doc.getText(BODY_SEQUENCE_FIELD);
    sequence.delete(0, sequence.length);
    const emptied = yDocToMarkdown(doc);
    stray(doc);
    expect(yDocToMarkdown(doc)).toBe(emptied);
    expect(emptied).not.toContain("stray");
    doc.destroy();
  });
});

describe("a note a conflict resolve began, which holds its lineage tag in both formats", () => {
  const TAG = "e".repeat(64);
  const typing = {
    first: (doc: Y.Doc) =>
      ((doc.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(4, "!"),
    second: (doc: Y.Doc) => {
      const sequence = doc.getText(BODY_SEQUENCE_FIELD);
      sequence.insert(sequence.length, "!", {});
    },
  };
  for (const format of ["first", "second"] as const) {
    const note = inBothFormats([[{ type: "paragraph" }, "text"]], { dohcLineageEpoch: TAG })[
      format
    ];

    it(`registers it and saves typing into it (${format} format)`, () => {
      expect(registered(note)).toBe("accepted");
      const held = room(note);
      const kept = held.offer(changeMadeBy(note, 77, ({ doc }) => typing[format](doc))!);
      expect(kept, "the room's check").toBeDefined();
      expect(held.journal(kept!)).toBe("accepted");
    });

    it(`refuses an edit that writes or removes the tag (${format} format)`, () => {
      const held = room(note);
      for (const change of [
        (doc: Y.Doc) => doc.getMap("meta").set("dohcLineageEpoch", "d".repeat(64)),
        (doc: Y.Doc) => doc.getMap("meta").set("dohcLineageEpoch", TAG),
        (doc: Y.Doc) => doc.getMap("meta").delete("dohcLineageEpoch"),
      ]) {
        const sent = changeMadeBy(note, 77, ({ doc }) => change(doc))!;
        expect(held.fitsAsSent(sent), "the room's check").toBe(false);
        expect(held.journal(sent)).toMatch(/^refused/);
      }
    });
  }

  it("refuses a tag that is not a lineage digest", () => {
    for (const tag of ["epoch", "E".repeat(64), 1])
      for (const format of ["first", "second"] as const)
        expect(
          registered(
            inBothFormats([[{ type: "paragraph" }, "text"]], { dohcLineageEpoch: tag })[format],
          ),
        ).toBe(REFUSED_AT_REGISTRATION);
  });
});
