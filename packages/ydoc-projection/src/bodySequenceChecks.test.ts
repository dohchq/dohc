import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BODY_CONTAINERS_FIELD, BODY_SEQUENCE_FIELD } from "./bodySequenceGrammar.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  ARRIVALS,
  deliver,
  element,
  openPerson,
  random,
  randomChange,
  REMOTE,
  seededNote,
  storedReading,
  type Arrive,
  type Change,
  type Person,
} from "./bodySequenceChecksTestSupport.js";
import { getDohcProseMirrorSchema, markdownToYDoc } from "./import-export.js";
import {
  admitBodySequenceNotes,
  createLiveMarkdownHistoryValidator,
  createLiveMarkdownJournalValidator,
  createLiveMarkdownRegistrationValidator,
  liveEditFitsCopy,
} from "./liveDocumentValidation.js";
import { WORKER_LIVE_VALIDATION_POLICY } from "./liveValidationPolicy.js";
import { validateOrderedLiveUpdateCut } from "./orderedLiveUpdateCut.js";

const schema = getDohcProseMirrorSchema();
const PATH = "notes/shared.md";
const POLICY = WORKER_LIVE_VALIDATION_POLICY;
const register = createLiveMarkdownRegistrationValidator(POLICY);
const admit = createLiveMarkdownJournalValidator(POLICY);
const engineReaderAdmit = createLiveMarkdownJournalValidator(POLICY, true);
const activate = createLiveMarkdownHistoryValidator(POLICY);
const SEEDS = Number(process.env.BODY_SEQUENCE_CHECK_SEEDS ?? 3);
const CLEANUP_SEEDS = Number(process.env.BODY_SEQUENCE_CLEANUP_SEEDS ?? 20);

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
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

interface Seen {
  readonly change: Change;
  readonly taken: Uint8Array;
  readonly room: boolean;
  readonly earlier: readonly Uint8Array[];
}

function relay(baseline: Uint8Array, seen?: (row: Seen) => void) {
  const room = new Y.Doc({ gc: false });
  Y.applyUpdate(room, baseline);
  let copy: Y.Doc | undefined;
  const rows: Uint8Array[] = [];
  return {
    room,
    rows,
    vector: () => Y.encodeStateVector(room),
    missingFor: (vector: Uint8Array) => Y.encodeStateAsUpdate(room, vector),
    take(change: Change) {
      const vector = Y.encodeStateVector(room);
      const taken = Y.diffUpdate(change.bytes, vector);
      if (copy && !sameBytes(Y.encodeStateVector(copy), vector)) {
        copy.destroy();
        copy = undefined;
      }
      if (!copy) {
        copy = new Y.Doc({ gc: false });
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(room));
      }
      const fits = liveEditFitsCopy(copy, taken);
      if (!fits) {
        copy.destroy();
        copy = undefined;
      }
      const earlier = rows.slice();
      Y.applyUpdate(room, taken);
      rows.push(taken);
      seen?.({ change, taken, room: fits, earlier });
      return taken;
    },
  };
}

const OFF = {
  room: false,
  cut: "accepted",
  journal: "refused: invalid-schema (admitted-cut)",
  engineReader: "refused: invalid-schema (final)",
  registration: "refused: invalid-schema (registration-input)",
};

const COUNTS = [2, 3, 4];
const SETUPS = COUNTS.flatMap((people) => ARRIVALS.map((arrive) => [people, arrive] as const));

describe("with the relay's setting off, a format-2 note that people edit as section 4 says", () => {
  it("is refused at registration", () => {
    const baseline = seededNote();
    expect(
      said(register({ document: documentFor(baseline), currentPath: PATH, checkpoint: baseline })),
    ).toBe(OFF.registration);
  });

  it.each(SETUPS)(
    "%i people, changes arriving %s: every check but the ordered cut refuses every change",
    (people, arrive) => {
      for (let seed = 1; seed <= SEEDS; seed++)
        for (const gc of [true, false]) {
          const baseline = seededNote();
          const document = documentFor(baseline);
          const next = random(seed * 7919 + people);
          const hub = relay(baseline, ({ change, taken, room, earlier }) => {
            const input = {
              document,
              currentPath: PATH,
              checkpoint: baseline,
              suffix: [...earlier],
              candidate: taken,
            };
            const cut = validateOrderedLiveUpdateCut(
              {
                mode: "journal-candidate",
                checkpoint: baseline,
                suffix: [...earlier],
                candidate: taken,
              },
              POLICY,
            );
            if (cut.kind === "accepted") cut.cut.document.destroy();
            const replay = new Y.Doc({ gc: false });
            Y.applyUpdate(replay, baseline);
            for (const row of [...earlier, taken]) Y.applyUpdate(replay, row);
            const state = Y.encodeStateAsUpdate(replay);
            replay.destroy();
            expect(
              {
                room,
                cut:
                  cut.kind === "accepted"
                    ? "accepted"
                    : `refused: ${cut.reason} at ${JSON.stringify(cut.stage)}`,
                journal: said(admit(input)),
                engineReader: said(engineReaderAdmit(input)),
                registration: said(
                  register({ document: documentFor(state), currentPath: PATH, checkpoint: state }),
                ),
              },
              `seed ${String(seed)}, gc ${String(gc)}, ${change.kind} from ${String(change.from)}`,
            ).toEqual(OFF);
          });
          const team = Array.from({ length: people }, (_, index) =>
            openPerson(baseline, 10 * (index + 1), { gc }),
          );
          for (let round = 0; round < 3; round++) {
            for (const each of team)
              for (let changes = 1 + Math.floor(next() * 3); changes > 0; changes--)
                randomChange(each, next);
            deliver(team, hub, arrive, next);
            const stored = storedReading(hub.room);
            for (const each of team)
              expect(readBodySequence(schema, each.doc).toJSON(), `seed ${String(seed)}`).toEqual(
                stored,
              );
          }
          expect(
            said(
              activate(
                {
                  document,
                  currentPath: PATH,
                  checkpoint: baseline,
                  suffix: hub.rows.slice(0, -1),
                  candidate: hub.rows.at(-1)!,
                },
                { from: 0, visit: () => {} },
              ),
            ),
          ).toBe("refused: invalid-schema (admitted-cut)");
          for (const each of team) each.doc.destroy();
          hub.room.destroy();
        }
    },
    600_000,
  );
});

interface Unnamed {
  readonly client: number;
  readonly clock: number;
  readonly kind: "formatting" | "left by a merge" | "collected" | "other";
}

class NamedDeletes {
  private readonly ranges = new Map<number, [number, number][]>();
  add(update: Uint8Array) {
    const decoded = Y.decodeUpdate(update);
    const name = (client: number, clock: number, length: number) => {
      const held = this.ranges.get(client) ?? [];
      held.push([clock, clock + length]);
      this.ranges.set(client, held);
    };
    for (const [client, ranges] of decoded.ds.clients)
      for (const range of ranges) name(client, range.clock, range.len);
    for (const struct of decoded.structs)
      if (
        struct instanceof Y.GC ||
        (struct instanceof Y.Item && struct.content instanceof Y.ContentDeleted)
      )
        name(struct.id.client, struct.id.clock, struct.length);
  }
  has(client: number, clock: number) {
    return (this.ranges.get(client) ?? []).some(([from, to]) => clock >= from && clock < to);
  }
}

function unnamedDeletes(replay: Y.Doc, named: NamedDeletes): Unnamed[] {
  const found: Unnamed[] = [];
  Y.createDeleteSetFromStructStore(replay.store).clients.forEach((ranges, client) =>
    ranges.forEach((range) => {
      const structs = replay.store.clients.get(client)!;
      for (let clock = range.clock; clock < range.clock + range.len; clock++) {
        if (named.has(client, clock)) continue;
        const struct = structs[Y.findIndexSS(structs, clock)]!;
        const kind = !(struct instanceof Y.Item)
          ? "collected"
          : struct.content instanceof Y.ContentFormat
            ? "formatting"
            : struct.parent instanceof Y.AbstractType &&
                (struct.parent._item?.deleted === true ||
                  (struct.parentSub !== null && struct.right?.parentSub === struct.parentSub))
              ? "left by a merge"
              : "other";
        found.push({ client, clock, kind });
      }
    }),
  );
  return found;
}

const formatting = (found: readonly Unnamed[]) =>
  found.filter((entry) => entry.kind === "formatting").length;

function withoutMarks(node: unknown): unknown {
  if (Array.isArray(node)) {
    const merged: unknown[] = [];
    for (const child of node.map(withoutMarks)) {
      const last = merged.at(-1) as { type?: string; text?: string } | undefined;
      const text = child as { type?: string; text?: string };
      if (text.type === "text" && last?.type === "text")
        merged[merged.length - 1] = { type: "text", text: String(last.text) + String(text.text) };
      else merged.push(child);
    }
    return merged;
  }
  if (typeof node !== "object" || node === null) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== "marks")
      .map(([key, value]) => [key, withoutMarks(value)]),
  );
}

interface CleanupCounts {
  histories: number;
  rows: number;
  cleanupRows: number;
  cleanupRowsTheRoomRefused: number;
  cleanupRowsTheCutRefused: number;
  cleanupRowsThatChangedTheStoredReading: number;
  historiesWithACleanupRow: number;
  aReplayThatDeclaresDeletedUnnamedFormatting: number;
  aReplayThatNeverDeclaresDeletedUnnamedFormatting: number;
  aDocumentThatDeclaresLateThenTakesMoreDeletedUnnamedFormatting: number;
  aReaderThatCannotSendEndedWithOtherMarks: number;
  aReaderThatCannotSendEndedWithOtherLettersOrBlocks: number;
  aPersonReadOtherThanTheStoredNote: number;
}

const noCounts = (): CleanupCounts => ({
  histories: 0,
  rows: 0,
  cleanupRows: 0,
  cleanupRowsTheRoomRefused: 0,
  cleanupRowsTheCutRefused: 0,
  cleanupRowsThatChangedTheStoredReading: 0,
  historiesWithACleanupRow: 0,
  aReplayThatDeclaresDeletedUnnamedFormatting: 0,
  aReplayThatNeverDeclaresDeletedUnnamedFormatting: 0,
  aDocumentThatDeclaresLateThenTakesMoreDeletedUnnamedFormatting: 0,
  aReaderThatCannotSendEndedWithOtherMarks: 0,
  aReaderThatCannotSendEndedWithOtherLettersOrBlocks: 0,
  aPersonReadOtherThanTheStoredNote: 0,
});

type LineChange = {
  readonly who: number;
  readonly act: "type" | "delete" | "mark";
  readonly line: number;
  readonly at: number;
  readonly length: number;
  readonly mark: string;
  readonly on: boolean;
  readonly letters: string;
};

const LINES = ["abcd efgh", "ijkl mnop", "qrst uvwx"];

function lineChanges(seed: number, people: number, rounds: number, marks: number): LineChange[][] {
  const next = random(seed * 15485863 + people);
  const pick = (below: number) => Math.floor(next() * below);
  return Array.from({ length: rounds }, () =>
    Array.from({ length: people }, (_, who) =>
      Array.from({ length: 1 + pick(3) }, (): LineChange => {
        const roll = next();
        return {
          who,
          act: roll < marks ? "mark" : roll < marks + (1 - marks) * 0.35 ? "delete" : "type",
          line: pick(LINES.length),
          at: next(),
          length: 1 + pick(5),
          mark: next() < 0.6 ? "bold" : "italic",
          on: next() < 0.65,
          letters: String.fromCharCode(0x41 + pick(26)),
        };
      }),
    ).flat(),
  );
}

function within(length: number, change: LineChange) {
  const offset = Math.min(length, Math.floor(change.at * (length + 1)));
  return { offset, span: Math.min(change.length, length - offset) };
}

function changeLine(who: Person, change: LineChange) {
  const all = who.tokens();
  const boundaries = all.flatMap((token, at) => (token.kind === "boundary" ? [at] : []));
  const boundary = boundaries[change.line];
  if (boundary === undefined) return;
  const length = (boundaries[change.line + 1] ?? all.length) - boundary - 1;
  const { offset, span } = within(length, change);
  const at = boundary + 1 + offset;
  if (change.act === "type") who.type(at, change.letters);
  else if (span < 1) return;
  else if (change.act === "delete") who.deleteLetters(at, span);
  else who.mark(at, span, change.mark, change.on ? {} : null);
}

function sequenceOfLines(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  doc.getMap("meta").set("schemaVersion", 2);
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  for (const line of LINES) {
    sequence.insertEmbed(sequence.length, element("block", { type: "paragraph", path: [] }), {});
    sequence.insert(sequence.length, line, {});
  }
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

type Edits = "every kind of change" | "letters and marks on three short lines";
const EDITS: readonly Edits[] = ["every kind of change", "letters and marks on three short lines"];

function honestHistory(
  seed: number,
  people: number,
  arrive: Arrive,
  gc: boolean,
  edits: Edits,
  yjsCleanup: boolean,
  counts: CleanupCounts,
) {
  const rounds = 4;
  const baseline = edits === "every kind of change" ? seededNote() : sequenceOfLines();
  const script =
    edits === "every kind of change" ? undefined : lineChanges(seed, people, rounds, 0.3);
  const next = random(seed * 104729 + people);
  const named = new NamedDeletes();
  named.add(baseline);
  const declares = new Y.Doc({ gc: false });
  declares.getText(BODY_SEQUENCE_FIELD);
  declares.getMap(BODY_CONTAINERS_FIELD);
  Y.applyUpdate(declares, baseline);
  const declaresLate = new Y.Doc({ gc: false });
  Y.applyUpdate(declaresLate, baseline);
  const reader = openPerson(baseline, 9_000, { gc, yjsCleanup });
  let cleanupRows = 0;
  let declaredHit = false;
  let declaredLateHit = false;
  const hub = relay(baseline, ({ change, taken, room, earlier }) => {
    counts.rows++;
    named.add(taken);
    Y.applyUpdate(declares, taken);
    if (formatting(unnamedDeletes(declares, named)) > 0) declaredHit = true;
    Y.applyUpdate(declaresLate, taken);
    if (formatting(unnamedDeletes(declaresLate, named)) > 0) declaredLateHit = true;
    declaresLate.getText(BODY_SEQUENCE_FIELD);
    if (change.kind !== "formatting cleanup") return;
    cleanupRows++;
    counts.cleanupRows++;
    if (!room) counts.cleanupRowsTheRoomRefused++;
    const cut = validateOrderedLiveUpdateCut(
      { mode: "journal-candidate", checkpoint: baseline, suffix: [...earlier], candidate: taken },
      POLICY,
    );
    if (cut.kind === "accepted") cut.cut.document.destroy();
    else counts.cleanupRowsTheCutRefused++;
    expect(Y.decodeUpdate(taken).structs).toHaveLength(0);
    const before = new Y.Doc({ gc: false });
    Y.applyUpdate(before, baseline);
    for (const row of earlier) Y.applyUpdate(before, row);
    const read = JSON.stringify(storedReading(before));
    Y.applyUpdate(before, taken);
    if (JSON.stringify(storedReading(before)) !== read)
      counts.cleanupRowsThatChangedTheStoredReading++;
    before.destroy();
  });
  const team = Array.from({ length: people }, (_, index) =>
    openPerson(baseline, 10 * (index + 1), { gc, yjsCleanup }),
  );
  for (let round = 0; round < rounds; round++) {
    if (script) for (const change of script[round]!) changeLine(team[change.who]!, change);
    else
      for (const each of team)
        for (let changes = 1 + Math.floor(next() * 3); changes > 0; changes--)
          randomChange(each, next);
    deliver(team, hub, arrive, next, [reader]);
    reader.waiting.length = 0;
    const stored = JSON.stringify(storedReading(hub.room));
    const opensNow = new Y.Doc();
    opensNow.getText(BODY_SEQUENCE_FIELD);
    opensNow.getMap(BODY_CONTAINERS_FIELD);
    Y.applyUpdate(opensNow, Y.encodeStateAsUpdate(hub.room));
    expect(JSON.stringify(readBodySequence(schema, opensNow).toJSON()), "a page opened now").toBe(
      stored,
    );
    opensNow.destroy();
    for (const each of team)
      if (JSON.stringify(readBodySequence(schema, each.doc).toJSON()) !== stored)
        counts.aPersonReadOtherThanTheStoredNote++;
  }
  counts.histories++;
  if (cleanupRows > 0) counts.historiesWithACleanupRow++;
  if (declaredHit) counts.aReplayThatDeclaresDeletedUnnamedFormatting++;
  if (formatting(unnamedDeletes(hub.room, named)) > 0)
    counts.aReplayThatNeverDeclaresDeletedUnnamedFormatting++;
  if (declaredLateHit) counts.aDocumentThatDeclaresLateThenTakesMoreDeletedUnnamedFormatting++;
  const stored = storedReading(hub.room);
  const shown = readBodySequence(schema, reader.doc).toJSON() as unknown;
  if (JSON.stringify(shown) !== JSON.stringify(stored)) {
    if (JSON.stringify(withoutMarks(shown)) === JSON.stringify(withoutMarks(stored)))
      counts.aReaderThatCannotSendEndedWithOtherMarks++;
    else counts.aReaderThatCannotSendEndedWithOtherLettersOrBlocks++;
  }
  expect(
    unnamedDeletes(hub.room, named).filter((entry) => entry.kind !== "left by a merge"),
    "what the room's own document deleted and no change named",
  ).toEqual([]);
  for (const doc of [declares, declaresLate, reader.doc, hub.room, ...team.map((p) => p.doc)])
    doc.destroy();
}

function everySetup(edits: Edits, yjsCleanup: boolean): CleanupCounts {
  const totals = noCounts();
  for (const [people, arrive] of SETUPS)
    for (const gc of [true, false])
      for (let seed = 1; seed <= CLEANUP_SEEDS; seed++)
        honestHistory(seed, people, arrive, gc, edits, yjsCleanup, totals);
  return totals;
}

const BOLD_X = '{"type":"text","marks":[{"type":"bold"}],"text":"x"}';
const PLAIN_X = '{"type":"text","text":"x efgh"}';
const pieceWithX = (reading: unknown) =>
  JSON.stringify(
    (reading as { content: { content?: { text?: string }[] }[] }).content[0]!.content?.find(
      (piece) => piece.text?.includes("x"),
    ),
  );

function boldAgainstDelete(yjsCleanup: boolean) {
  const baseline = sequenceOfLines();
  const hub = relay(baseline);
  const [bolder, deleter, typist, reader] = [20, 30, 40, 50].map((clientID) =>
    openPerson(baseline, clientID, { yjsCleanup }),
  ) as [Person, Person, Person, Person];
  bolder.mark(1, 4, "bold", {});
  deleter.deleteLetters(1, 4);
  const bold = hub.take(bolder.waiting.shift()!);
  typist.receive(bold);
  typist.type(5, "x");
  return { hub, bolder, deleter, typist, reader, bold };
}

describe("formatting that Yjs deletes on its own when changes meet, on a relay that admits format-2 notes", () => {
  beforeAll(() => admitBodySequenceNotes(true));
  afterAll(() => admitBodySequenceNotes(false));

  it.each(EDITS)(
    "%s, by pages that let Yjs clean: a document that never declares the sequence deletes none of it, and every page that sends ends as the stored note",
    (edits) => {
      const totals = everySetup(edits, true);
      console.log(`${edits}, pages that let Yjs clean: ${JSON.stringify(totals, null, 1)}`);
      expect(totals.aReplayThatNeverDeclaresDeletedUnnamedFormatting).toBe(0);
      expect(totals.cleanupRowsTheRoomRefused).toBe(0);
      expect(totals.cleanupRowsTheCutRefused).toBe(0);
      expect(totals.aPersonReadOtherThanTheStoredNote).toBe(0);
      expect(totals.aReaderThatCannotSendEndedWithOtherLettersOrBlocks).toBe(0);
      if (edits === "every kind of change") return;
      expect(totals.cleanupRows).toBeGreaterThan(0);
      expect(totals.aReplayThatDeclaresDeletedUnnamedFormatting).toBeGreaterThan(0);
    },
    600_000,
  );

  it.each(EDITS)(
    "%s, by pages that stop Yjs cleaning: nothing is deleted that no change names, and every page ends as the stored note",
    (edits) => {
      const totals = everySetup(edits, false);
      console.log(`${edits}, pages that stop Yjs cleaning: ${JSON.stringify(totals, null, 1)}`);
      expect(totals.cleanupRows).toBe(0);
      expect(totals.aReplayThatNeverDeclaresDeletedUnnamedFormatting).toBe(0);
      expect(totals.aPersonReadOtherThanTheStoredNote).toBe(0);
      expect(totals.aReaderThatCannotSendEndedWithOtherMarks).toBe(0);
      expect(totals.aReaderThatCannotSendEndedWithOtherLettersOrBlocks).toBe(0);
    },
    600_000,
  );

  it.each([
    [true, "plain"],
    [false, "bold"],
  ] as const)(
    "with Yjs cleaning %s, a reader that cannot send shows a letter %s that the stored note has bold",
    (yjsCleanup, shown) => {
      const { hub, bolder, deleter, typist, reader, bold } = boldAgainstDelete(yjsCleanup);
      const deleted = hub.take(deleter.waiting.shift()!);
      const typed = hub.take(typist.waiting.shift()!);
      for (const row of [bold, deleted, typed]) reader.receive(row);
      bolder.receive(Y.mergeUpdates([deleted, typed]));
      deleter.receive(Y.mergeUpdates([bold, typed]));
      typist.receive(deleted);
      expect([bolder, deleter, typist].flatMap((each) => each.waiting)).toEqual([]);
      const stored = storedReading(hub.room);
      expect(pieceWithX(stored)).toBe(BOLD_X);
      for (const each of [bolder, deleter, typist])
        expect(readBodySequence(schema, each.doc).toJSON()).toEqual(stored);
      expect(pieceWithX(readBodySequence(schema, reader.doc).toJSON())).toBe(
        shown === "bold" ? BOLD_X : PLAIN_X,
      );
    },
  );

  it("a cleanup that one page sends makes plain a letter another person typed bold", () => {
    const { hub, bolder, deleter, typist } = boldAgainstDelete(true);
    bolder.receive(hub.take(deleter.waiting.shift()!));
    expect(bolder.waiting.map((change) => change.kind)).toEqual(["formatting cleanup"]);
    hub.take(typist.waiting.shift()!);
    expect(pieceWithX(storedReading(hub.room))).toBe(BOLD_X);
    hub.take(bolder.waiting.shift()!);
    expect(pieceWithX(storedReading(hub.room))).toBe(PLAIN_X);
  });

  it("a document that declares the sequence, then takes more changes, deletes formatting no change names, and one that only reads it does not", () => {
    const baseline = sequenceOfLines();
    const [first, second, third] = [20, 30, 40].map((clientID) =>
      openPerson(baseline, clientID),
    ) as [Person, Person, Person];
    first.mark(11, 4, "italic", {});
    const italic = first.waiting.shift()!.bytes;
    for (const each of [second, third]) each.receive(italic);
    second.mark(1, 4, "bold", {});
    third.deleteLetters(1, 4);
    const rows = [italic, second.waiting.shift()!.bytes, third.waiting.shift()!.bytes];
    const named = new NamedDeletes();
    named.add(baseline);
    for (const row of rows) named.add(row);
    const unnamedAfter = (read: (doc: Y.Doc) => void) => {
      const check = new Y.Doc({ gc: false });
      Y.applyUpdate(check, baseline);
      for (const row of rows) {
        read(check);
        Y.applyUpdate(check, row);
      }
      const unnamed = formatting(unnamedDeletes(check, named));
      check.destroy();
      return unnamed;
    };
    expect(unnamedAfter((doc) => doc.getText(BODY_SEQUENCE_FIELD))).toBe(1);
    expect(unnamedAfter((doc) => readBodySequence(schema, doc))).toBe(0);
  });
});

function paragraphsOfLines(): Uint8Array {
  const doc = markdownToYDoc(`${LINES.join("\n\n")}\n`, { clientID: 1 });
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

interface Page {
  readonly waiting: Change[];
  receive(bytes: Uint8Array): void;
}

function paragraphPage(clientID: number, baseline: Uint8Array) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const waiting: Change[] = [];
  doc.on("update", (bytes: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE)
      waiting.push({
        bytes,
        from: clientID,
        kind: origin === null ? "formatting cleanup" : "typing",
      });
  });
  Y.applyUpdate(doc, baseline, REMOTE);
  return {
    doc,
    waiting,
    receive: (bytes: Uint8Array) => Y.applyUpdate(doc, bytes, REMOTE),
    change(change: LineChange) {
      const paragraph = doc.getXmlFragment("body").toArray()[change.line];
      const text = paragraph instanceof Y.XmlElement ? paragraph.toArray()[0] : undefined;
      if (!(text instanceof Y.XmlText)) return;
      const { offset, span } = within(text.length, change);
      doc.transact(() => {
        if (change.act === "type") text.insert(offset, change.letters);
        else if (span < 1) return;
        else if (change.act === "delete") text.delete(offset, span);
        else text.format(offset, span, { [change.mark]: change.on ? {} : null });
      }, "local");
    },
  };
}

function sendOneByOne(pages: readonly Page[], next: () => number, take: (row: Uint8Array) => void) {
  for (;;) {
    const senders = pages.filter((page) => page.waiting.length > 0);
    if (senders.length === 0) return;
    const from = senders[Math.floor(next() * senders.length)]!;
    const { bytes } = from.waiting.shift()!;
    take(bytes);
    for (const page of pages) if (page !== from) page.receive(bytes);
  }
}

describe("the same letters and marks, in one text per paragraph and in one text for the note", () => {
  it.each([
    ["mostly writing", 0.15],
    ["mostly formatting", 0.45],
  ] as const)(
    "%s: the histories today's checks refuse for paragraphs, and those a sequence would lose formatting in",
    (name, marks) => {
      const totals = {
        histories: 0,
        paragraphs: {
          todaysJournalRefusedAsInvalidUpdate: 0,
          todaysJournalRefusedAsInvalidSchema: 0,
          todaysJournalRefused: 0,
          aReplayDeletedUnnamedFormatting: 0,
        },
        sequence: {
          aReplayThatDeclaresDeletedUnnamedFormatting: 0,
          aReplayThatNeverDeclaresDeletedUnnamedFormatting: 0,
          todaysCutRefused: 0,
        },
      };
      for (const people of COUNTS)
        for (let seed = 1; seed <= CLEANUP_SEEDS; seed++) {
          const rounds = lineChanges(seed, people, 4, marks);
          totals.histories++;

          const paragraphs = paragraphsOfLines();
          const paragraphPages = Array.from({ length: people }, (_, index) =>
            paragraphPage(10 * (index + 1), paragraphs),
          );
          const paragraphRows: Uint8Array[] = [];
          const paragraphNamed = new NamedDeletes();
          paragraphNamed.add(paragraphs);
          const paragraphReplay = new Y.Doc({ gc: false });
          Y.applyUpdate(paragraphReplay, paragraphs);
          const refusals = new Set<string>();
          let paragraphHit = false;
          const paragraphOrder = random(seed);
          for (const round of rounds) {
            for (const change of round) paragraphPages[change.who]!.change(change);
            sendOneByOne(paragraphPages, paragraphOrder, (row) => {
              const verdict = admit({
                document: documentFor(paragraphs),
                currentPath: PATH,
                checkpoint: paragraphs,
                suffix: paragraphRows.slice(),
                candidate: row,
              });
              if (verdict.kind === "refused") refusals.add(verdict.reason);
              paragraphRows.push(row);
              paragraphNamed.add(row);
              Y.applyUpdate(paragraphReplay, row);
              if (formatting(unnamedDeletes(paragraphReplay, paragraphNamed)) > 0)
                paragraphHit = true;
            });
          }
          expect(
            [...refusals].filter(
              (reason) => reason !== "invalid-update" && reason !== "invalid-schema",
            ),
          ).toEqual([]);
          if (refusals.has("invalid-update"))
            totals.paragraphs.todaysJournalRefusedAsInvalidUpdate++;
          if (refusals.has("invalid-schema"))
            totals.paragraphs.todaysJournalRefusedAsInvalidSchema++;
          if (refusals.size > 0) totals.paragraphs.todaysJournalRefused++;
          if (paragraphHit) totals.paragraphs.aReplayDeletedUnnamedFormatting++;

          const sequence = sequenceOfLines();
          const sequencePages = Array.from({ length: people }, (_, index) =>
            openPerson(sequence, 10 * (index + 1)),
          );
          const sequenceRows: Uint8Array[] = [];
          const sequenceNamed = new NamedDeletes();
          sequenceNamed.add(sequence);
          const declares = new Y.Doc({ gc: false });
          declares.getText(BODY_SEQUENCE_FIELD);
          Y.applyUpdate(declares, sequence);
          const neverDeclares = new Y.Doc({ gc: false });
          Y.applyUpdate(neverDeclares, sequence);
          let declaredHit = false;
          let undeclaredHit = false;
          let cutRefused = false;
          const sequenceOrder = random(seed);
          for (const round of rounds) {
            for (const change of round) changeLine(sequencePages[change.who]!, change);
            sendOneByOne(sequencePages, sequenceOrder, (row) => {
              const cut = validateOrderedLiveUpdateCut(
                {
                  mode: "journal-candidate",
                  checkpoint: sequence,
                  suffix: sequenceRows.slice(),
                  candidate: row,
                },
                POLICY,
              );
              if (cut.kind === "accepted") cut.cut.document.destroy();
              else cutRefused = true;
              sequenceRows.push(row);
              sequenceNamed.add(row);
              Y.applyUpdate(declares, row);
              Y.applyUpdate(neverDeclares, row);
              if (formatting(unnamedDeletes(declares, sequenceNamed)) > 0) declaredHit = true;
              if (formatting(unnamedDeletes(neverDeclares, sequenceNamed)) > 0)
                undeclaredHit = true;
            });
          }
          if (declaredHit) totals.sequence.aReplayThatDeclaresDeletedUnnamedFormatting++;
          if (undeclaredHit) totals.sequence.aReplayThatNeverDeclaresDeletedUnnamedFormatting++;
          if (cutRefused) totals.sequence.todaysCutRefused++;
          for (const page of [...paragraphPages, ...sequencePages]) page.doc.destroy();
          for (const doc of [paragraphReplay, declares, neverDeclares]) doc.destroy();
        }
      console.log(`${name}: ${JSON.stringify(totals, null, 1)}`);
      expect(totals.sequence.aReplayThatNeverDeclaresDeletedUnnamedFormatting).toBe(0);
      expect(totals.sequence.todaysCutRefused).toBe(0);
      expect(totals.paragraphs.todaysJournalRefusedAsInvalidUpdate).toBe(
        totals.paragraphs.aReplayDeletedUnnamedFormatting,
      );
    },
    600_000,
  );
});
