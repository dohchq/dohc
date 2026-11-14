// Two people edit the same note before either sees the other's change, and Yjs's merge deletes content that no
// update's delete set names. It deletes a type's children with the type, and an item that arrives into a deleted
// type. Every replica does the same, in either order, so activation and live admission must accept these rows as one
// replay of them does.
// When two people set the same key of a live type at once, Yjs deletes one of the two values and no update names it.
// One of the two is kept, the same for everyone, so those rows are accepted too.
// Yjs's formatting cleanup also deletes content that no update names. Those rows stay refused here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "./import-export.js";
import {
  createLiveMarkdownHistoryValidator,
  createLiveMarkdownJournalValidator,
  createLiveMarkdownRegistrationValidator,
  type LiveMarkdownJournalResult,
} from "./liveDocumentValidation.js";
import { WORKER_LIVE_VALIDATION_POLICY } from "./liveValidationPolicy.js";
import { validateOrderedLiveUpdateCut } from "./orderedLiveUpdateCut.js";

const PATH = "notes/shared.md";
const REMOTE = Symbol("remote");
const register = createLiveMarkdownRegistrationValidator(WORKER_LIVE_VALIDATION_POLICY);
const validateHistory = createLiveMarkdownHistoryValidator(WORKER_LIVE_VALIDATION_POLICY);
const admit = createLiveMarkdownJournalValidator(WORKER_LIVE_VALIDATION_POLICY);

/** A note loaded by several clients. Each local transaction's update event is one row, as an editor's provider sends it. */
function session(markdown: string) {
  const base = markdownToYDoc(markdown, { clientID: 1 });
  const baseline = Y.encodeStateAsUpdate(base);
  base.destroy();
  const rows: Uint8Array[] = [];
  const open = (clientID: number, gc = false) => {
    const doc = new Y.Doc({ gc });
    doc.clientID = clientID;
    Y.applyUpdate(doc, baseline, REMOTE);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) rows.push(update);
    });
    return doc;
  };
  const receive = (doc: Y.Doc, ...updates: Uint8Array[]) => {
    for (const update of updates) Y.applyUpdate(doc, update, REMOTE);
  };
  return { baseline, rows, open, receive };
}

const documentFor = (checkpoint: Uint8Array) => ({
  workspaceId: "workspace",
  mainVersionId: "main",
  objectId: "object",
  lineageClaimId: createHash("sha256").update(checkpoint).digest("hex"),
});

function elements(doc: Y.Doc, name: string): Y.XmlElement[] {
  const found: Y.XmlElement[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === name) found.push(child);
      walk(child);
    }
  };
  walk(doc.getXmlFragment("body"));
  return found;
}

function textOf(element: Y.XmlElement): Y.XmlText {
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) return textOf(child);
  }
  throw new Error(`no text in ${element.nodeName}`);
}

const append = (text: Y.XmlText, value: string) => text.insert(text.length, value);

/** Whether `node` is, or holds, an element named `name`. */
function holds(node: Y.XmlElement | Y.XmlText | Y.XmlHook, name: string): boolean {
  return (
    node instanceof Y.XmlElement &&
    (node.nodeName === name || node.toArray().some((child) => holds(child, name)))
  );
}

/** Deletes the top-level block that is, or holds, the first element named `name`. */
function deleteBlock(doc: Y.Doc, name: string) {
  const body = doc.getXmlFragment("body");
  const index = body.toArray().findIndex((node) => holds(node, name));
  if (index < 0) throw new Error(`no ${name}`);
  body.delete(index, 1);
}

/** Ticks the note's first task item. Yjs types element attributes as strings unless told otherwise. */
const tick = (doc: Y.Doc) =>
  (elements(doc, "taskItem")[0] as unknown as Y.XmlElement<{ checked: boolean }>).setAttribute(
    "checked",
    true,
  );

/** Two edits made at once by clients 2 and 3, each from the same note and before either sees the other. */
interface Concurrent {
  readonly markdown: string;
  readonly first: (doc: Y.Doc) => void;
  readonly second: (doc: Y.Doc) => void;
}

const SHAPES: Readonly<Record<string, Concurrent>> = {
  "typing in a paragraph that someone else deletes": {
    markdown: "Notes\n\nShared\n",
    first: (doc) => append(textOf(elements(doc, "paragraph")[1]!), "x"),
    second: (doc) => doc.getXmlFragment("body").delete(1, 1),
  },
  // An emoji is two UTF-16 units, so the typed text holds a point no edit may split. It goes with the deleted text.
  "typing an emoji in a paragraph that someone else deletes": {
    markdown: "Notes\n\nShared\n",
    first: (doc) => append(textOf(elements(doc, "paragraph")[1]!), "💩x"),
    second: (doc) => doc.getXmlFragment("body").delete(1, 1),
  },
  "typing in a list item whose list someone else deletes": {
    markdown: "Notes\n\n- one\n- two\n",
    first: (doc) => append(textOf(elements(doc, "listItem")[1]!), "x"),
    second: (doc) => deleteBlock(doc, "listItem"),
  },
  "adding a list item, with its paragraph and text, to a list that someone else deletes": {
    markdown: "Notes\n\n- one\n- two\n",
    first: (doc) => {
      const item = elements(doc, "listItem")[1]!;
      const list = item.parent as Y.XmlElement;
      list.insert(list.length, [item.clone()]);
    },
    second: (doc) => deleteBlock(doc, "listItem"),
  },
};

/** The rows of `shape` in the order given. Each is one row, from a client that had not received the other. */
function concurrentRows(shape: Concurrent, order: "first, then second" | "second, then first") {
  const { baseline, rows, open } = session(shape.markdown);
  const one = open(2),
    two = open(3);
  if (order === "first, then second") {
    shape.first(one);
    shape.second(two);
  } else {
    shape.second(two);
    shape.first(one);
  }
  expect(rows).toHaveLength(2);
  return { baseline, rows: [...rows] };
}

interface Undeclared {
  readonly client: number;
  readonly clock: number;
  readonly kind: "format" | "gc" | "other";
}

/** What one replay of the rows deletes that no row's delete set names, by struct. */
function undeclared(checkpoint: Uint8Array, rows: readonly Uint8Array[]): Undeclared[] {
  const replay = new Y.Doc({ gc: false });
  Y.applyUpdate(replay, checkpoint);
  for (const row of rows) Y.applyUpdate(replay, row);
  const declared = Y.mergeDeleteSets([
    Y.decodeUpdate(checkpoint).ds,
    ...rows.map((row) => Y.decodeUpdate(row).ds),
  ]);
  const found: Undeclared[] = [];
  Y.createDeleteSetFromStructStore(replay.store).clients.forEach((ranges, client) =>
    ranges.forEach((range) => {
      const structs = replay.store.clients.get(client)!;
      for (let clock = range.clock; clock < range.clock + range.len; clock++) {
        if (Y.isDeleted(declared, Y.createID(client, clock))) continue;
        const struct = structs[Y.findIndexSS(structs, clock)]!;
        const kind =
          struct instanceof Y.GC
            ? "gc"
            : (struct as Y.Item).content instanceof Y.ContentFormat
              ? "format"
              : "other";
        found.push({ client, clock, kind });
      }
    }),
  );
  replay.destroy();
  return found;
}

/** What a refusal carries, and what only the replay deletes, for the failure message. */
function detailOf(
  checkpoint: Uint8Array,
  rows: readonly Uint8Array[],
  result: LiveMarkdownJournalResult,
) {
  const cut = validateOrderedLiveUpdateCut(
    {
      mode: "journal-candidate",
      checkpoint,
      suffix: rows.slice(0, -1),
      candidate: rows[rows.length - 1]!,
    },
    WORKER_LIVE_VALIDATION_POLICY,
  );
  if (cut.kind === "accepted") cut.cut.document.destroy();
  const only = undeclared(checkpoint, rows).map(
    (entry) => `${entry.client}:${entry.clock}(${entry.kind})`,
  );
  const detail =
    `${JSON.stringify(result)}; cut ${cut.kind === "refused" ? `${cut.reason} at stage ${JSON.stringify(cut.stage)}` : "accepted"}; ` +
    `deleted in the replay but declared by no row: ${only.join(" ") || "none"}`;
  return { detail, stage: cut.kind === "refused" ? cut.stage : undefined };
}

/**
 * Accepted is what should be true. A refusal must be the proof's: the final proof's, or an earlier row's proof when
 * activation checks every prefix. A refusal for any other reason fails the first assertion and can't stand in for this one.
 */
function expectAccepted(
  checkpoint: Uint8Array,
  rows: readonly Uint8Array[],
  result: LiveMarkdownJournalResult,
  source: "final" | "admitted-cut" = "final",
) {
  if (result.kind === "refused") {
    const { detail, stage } = detailOf(checkpoint, rows, result);
    expect(
      { reason: result.reason, source: result.source, stage },
      `refused for another reason: ${detail}`,
    ).toEqual({ reason: "invalid-update", source, stage: { kind: "final" } });
    expect(result.kind, detail).toBe("accepted");
  }
  return result as Extract<LiveMarkdownJournalResult, { kind: "accepted" }>;
}

function expectFinalProofRefusal(
  checkpoint: Uint8Array,
  rows: readonly Uint8Array[],
  result: LiveMarkdownJournalResult,
) {
  const { detail, stage } = detailOf(checkpoint, rows, result);
  expect(
    result.kind === "refused"
      ? { reason: result.reason, source: result.source, stage }
      : result.kind,
    detail,
  ).toEqual({ reason: "invalid-update", source: "final", stage: { kind: "final" } });
}

/** Activation's door: the whole history in one pass, with every prefix's projection checked. */
function activate(checkpoint: Uint8Array, rows: readonly Uint8Array[]) {
  let visits = 0;
  const result = validateHistory(
    {
      document: documentFor(checkpoint),
      currentPath: PATH,
      checkpoint,
      suffix: rows.slice(0, -1),
      candidate: rows[rows.length - 1]!,
    },
    {
      from: 0,
      visit: () => {
        visits++;
      },
    },
  );
  return { result, visits };
}

/** Live admission's door: each row admitted after the rows before it. */
function admitRow(checkpoint: Uint8Array, rows: readonly Uint8Array[], index: number) {
  return admit({
    document: documentFor(checkpoint),
    currentPath: PATH,
    checkpoint,
    suffix: rows.slice(0, index),
    candidate: rows[index]!,
  });
}

function admitEach(checkpoint: Uint8Array, rows: readonly Uint8Array[]) {
  let last: LiveMarkdownJournalResult | undefined;
  for (let index = 0; index < rows.length; index++) {
    last = admitRow(checkpoint, rows, index);
    expectAccepted(checkpoint, rows.slice(0, index + 1), last);
  }
  return expectAccepted(checkpoint, rows, last!);
}

function replayRegistration(checkpoint: Uint8Array, rows: readonly Uint8Array[]) {
  const replay = new Y.Doc({ gc: false });
  Y.applyUpdate(replay, checkpoint);
  for (const row of rows) Y.applyUpdate(replay, row);
  const state = Y.encodeStateAsUpdate(replay);
  replay.destroy();
  return register({ document: documentFor(checkpoint), currentPath: PATH, checkpoint: state });
}

/** Activation and live admission accept each shape in either order, as one replay of its rows does. */
function acceptsEach(shapes: Readonly<Record<string, Concurrent>>) {
  for (const [name, shape] of Object.entries(shapes)) {
    for (const order of ["first, then second", "second, then first"] as const) {
      it(`activation accepts ${name} (${order}), with one replay's projection`, () => {
        const { baseline, rows } = concurrentRows(shape, order);
        const replayed = replayRegistration(baseline, rows);
        expect(replayed.kind, "one replay of the same rows registers").toBe("accepted");
        const { result, visits } = activate(baseline, rows);
        const accepted = expectAccepted(baseline, rows, result);
        expect(visits).toBe(rows.length);
        if (replayed.kind !== "accepted") return;
        expect(accepted.evidence.projectedMarkdownSha256).toBe(
          replayed.evidence.projectedMarkdownSha256,
        );
      });

      it(`live admission accepts ${name} (${order}), one row at a time`, () => {
        const { baseline, rows } = concurrentRows(shape, order);
        admitEach(baseline, rows);
      });
    }

    it(`accepts ${name} in either order, with the same deletions and projection`, () => {
      const ends = (["first, then second", "second, then first"] as const).map((order) => {
        const { baseline, rows } = concurrentRows(shape, order);
        const { evidence } = admitEach(baseline, rows);
        return {
          deletes: Y.decodeUpdate(evidence.stateUpdate).ds,
          markdown: evidence.projectedMarkdownSha256,
        };
      });
      expect(Y.equalDeleteSets(ends[0]!.deletes, ends[1]!.deletes)).toBe(true);
      expect(ends[0]!.markdown).toBe(ends[1]!.markdown);
    });
  }
}

/** Sets the note's `tags` property to a list holding `value`. */
const setList = (doc: Y.Doc, value: string) =>
  doc.getMap("frontmatter").set("tags", Y.Array.from([value]));

const SAME_KEY: Readonly<Record<string, Concurrent>> = {
  "two people ticking the same task item": {
    markdown: "- [ ] Pack\n",
    first: tick,
    second: tick,
  },
  "one person ticking a task item while another unticks it": {
    markdown: "- [ ] Pack\n",
    first: tick,
    second: (doc) =>
      (elements(doc, "taskItem")[0] as unknown as Y.XmlElement<{ checked: boolean }>).setAttribute(
        "checked",
        false,
      ),
  },
  "two people setting the same property": {
    markdown: "---\nstatus: draft\n---\n\nNotes\n",
    first: (doc) => doc.getMap("frontmatter").set("status", "review"),
    second: (doc) => doc.getMap("frontmatter").set("status", "done"),
  },
  "two people setting the same property to a list": {
    markdown: "---\ntags: draft\n---\n\nNotes\n",
    first: (doc) => setList(doc, "review"),
    second: (doc) => setList(doc, "done"),
  },
  "setting a property that someone else removes": {
    markdown: "---\nstatus: draft\n---\n\nNotes\n",
    first: (doc) => doc.getMap("frontmatter").set("status", "review"),
    second: (doc) => doc.getMap("frontmatter").delete("status"),
  },
  "ticking a task item whose list someone else deletes": {
    markdown: "Notes\n\n- [ ] Pack\n",
    first: tick,
    second: (doc) => deleteBlock(doc, "taskItem"),
  },
};

/** The shapes whose value that is not kept is deleted by no row. */
const UNNAMED_LOSER = [
  "two people ticking the same task item",
  "one person ticking a task item while another unticks it",
  "two people setting the same property",
  "two people setting the same property to a list",
] as const;

describe("concurrent edits that Yjs deletes on merge", () => {
  acceptsEach(SHAPES);

  it("accepts a delete that Yjs carries into the content after it, with later rows on top", () => {
    const { baseline, rows, open, receive } = session("Notes\n\nShared\n\nLater\n");
    const typist = open(2),
      deleter = open(3),
      later = open(4);
    append(textOf(elements(typist, "paragraph")[1]!), "x");
    deleter.getXmlFragment("body").delete(1, 1);
    receive(later, ...rows);
    append(textOf(elements(later, "paragraph")[1]!), "y");
    receive(typist, rows[1]!, rows[2]!);
    append(textOf(elements(typist, "paragraph")[0]!), "z");
    expect(rows).toHaveLength(4);
    // Activation proves each prefix, so the merge's deletion is first met by the proof of row 2 of 4.
    const { result, visits } = activate(baseline, rows);
    expectAccepted(baseline, rows, result, "admitted-cut");
    expect(visits).toBe(rows.length);
    admitEach(baseline, rows);
  });

  it("charges the final proof exactly when it accepts a merge's deletion after many retained spans", () => {
    const { baseline, rows, open, receive } = session("Notes\n\nShared\n");
    const typist = open(2),
      deleter = open(3);
    const notes = textOf(elements(typist, "paragraph")[0]!);
    append(notes, "n".repeat(40));
    // Deleting every other letter leaves client 2 with twenty live spans and twenty declared deletions.
    typist.transact(() => {
      for (let index = notes.length - 1; index >= 5; index -= 2) notes.delete(index, 1);
    });
    receive(deleter, ...rows);
    append(textOf(elements(typist, "paragraph")[1]!), "x");
    deleter.getXmlFragment("body").delete(1, 1);
    expect(rows).toHaveLength(4);
    expect(Y.decodeUpdate(rows[1]!).ds.clients.get(2)).toHaveLength(20);
    expect(undeclared(baseline, rows)).toHaveLength(1);
    const input = (maxIndexOperations?: number) =>
      validateOrderedLiveUpdateCut(
        {
          mode: "journal-candidate",
          checkpoint: baseline,
          suffix: rows.slice(0, -1),
          candidate: rows[rows.length - 1]!,
        },
        maxIndexOperations === undefined
          ? WORKER_LIVE_VALIDATION_POLICY
          : { ...WORKER_LIVE_VALIDATION_POLICY, maxIndexOperations },
      );
    const first = input();
    if (first.kind === "refused")
      expect({ reason: first.reason, stage: first.stage }).toEqual({
        reason: "invalid-update",
        stage: { kind: "final" },
      });
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    first.cut.document.destroy();
    const exact = first.cut.usage.indexOperations;
    const atExact = input(exact);
    expect(atExact.kind).toBe("accepted");
    if (atExact.kind === "accepted") atExact.cut.document.destroy();
    const oneLess = input(exact - 1);
    expect(
      oneLess.kind === "refused" ? { reason: oneLess.reason, stage: oneLess.stage } : oneLess.kind,
    ).toEqual({ reason: "capacity-refused", stage: { kind: "final" } });
  });
});

describe("the same key set at once: one of the two is kept, the same for everyone", () => {
  acceptsEach(SAME_KEY);

  for (const name of UNNAMED_LOSER) {
    it(`deletes the value not kept with no row naming it, for ${name}`, () => {
      for (const order of ["first, then second", "second, then first"] as const) {
        const { baseline, rows } = concurrentRows(SAME_KEY[name]!, order);
        expect(
          undeclared(baseline, rows).map((entry) => entry.kind),
          order,
        ).not.toHaveLength(0);
      }
    });
  }

  it("keeps one of three values, the same for everyone, in every order the rows arrive", () => {
    const { baseline, rows, open } = session("---\nstatus: draft\n---\n\nNotes\n");
    const values = ["review", "done", "parked"];
    values.forEach((value, index) => open(index + 2).getMap("frontmatter").set("status", value));
    expect(rows).toHaveLength(3);
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const ends = orders.map((order) => {
      const arrived = order.map((index) => rows[index]!);
      expect(undeclared(baseline, arrived)).toHaveLength(2);
      const { evidence } = admitEach(baseline, arrived);
      expectAccepted(baseline, arrived, activate(baseline, arrived).result);
      return {
        deletes: Y.decodeUpdate(evidence.stateUpdate).ds,
        markdown: evidence.projectedMarkdownSha256,
      };
    });
    for (const end of ends.slice(1)) {
      expect(Y.equalDeleteSets(ends[0]!.deletes, end.deletes)).toBe(true);
      expect(end.markdown).toBe(ends[0]!.markdown);
    }
  });

  it("accepts a later row that sets the key from the value before one already admitted", () => {
    // Client 3's value is admitted first. Client 2 set the key without seeing it, so its value is placed before
    // client 3's and deleted as it arrives: the row is admitted and the note does not change.
    const { baseline, rows, open } = session("---\nstatus: draft\n---\n\nNotes\n");
    open(3).getMap("frontmatter").set("status", "review");
    open(2).getMap("frontmatter").set("status", "done");
    const before = admitRow(baseline, rows, 0);
    const after = admitEach(baseline, rows);
    expect(after.evidence.projectedMarkdownSha256).toBe(
      expectAccepted(baseline, rows.slice(0, 1), before).evidence.projectedMarkdownSha256,
    );
    const replay = new Y.Doc({ gc: false });
    for (const update of [baseline, ...rows]) Y.applyUpdate(replay, update);
    expect(replay.getMap("frontmatter").get("status")).toBe("review");
    replay.destroy();
  });
});

describe("deletions no rule here accounts for stay refused", () => {
  /** Client 3 bolds "Notes" first; client 2's row, made without seeing it, runs `edit`. */
  function boldedBoth(markdown: string, edit: (doc: Y.Doc, notes: Y.XmlText) => void) {
    const { baseline, rows, open } = session(markdown);
    const one = open(2),
      two = open(3);
    textOf(elements(two, "paragraph")[0]!).format(0, 5, { bold: {} });
    one.transact(() => edit(one, textOf(elements(one, "paragraph")[0]!)));
    expect(rows).toHaveLength(2);
    return { baseline, rows: [...rows] };
  }

  function expectRefusedAtBothDoors(checkpoint: Uint8Array, rows: readonly Uint8Array[]) {
    expectFinalProofRefusal(checkpoint, rows, admitRow(checkpoint, rows, rows.length - 1));
    expectFinalProofRefusal(checkpoint, rows, activate(checkpoint, rows).result);
  }

  it("refuses deleting marked text that someone else bolded at the same moment, when the delete arrives second", () => {
    const { baseline, rows, open } = session("Notes\n\nShared\n");
    const one = open(2),
      two = open(3);
    textOf(elements(two, "paragraph")[1]!).format(0, 6, { bold: {} });
    const shared = textOf(elements(one, "paragraph")[1]!);
    shared.delete(0, shared.length);
    expect(rows).toHaveLength(2);
    const only = undeclared(baseline, rows);
    expect(only.length).toBeGreaterThan(0);
    expect(
      only.every((entry) => entry.kind === "format"),
      JSON.stringify(only),
    ).toBe(true);
    const cut = validateOrderedLiveUpdateCut(
      { mode: "journal-candidate", checkpoint: baseline, suffix: [rows[0]!], candidate: rows[1]! },
      WORKER_LIVE_VALIDATION_POLICY,
    );
    if (cut.kind === "accepted") cut.cut.document.destroy();
    expect(
      cut.kind === "refused" ? { reason: cut.reason, stage: cut.stage } : cut.kind,
      "the cut",
    ).toEqual({ reason: "invalid-update", stage: { kind: "final" } });
    const admitted = admitRow(baseline, rows, 1);
    expect(
      admitted.kind === "refused"
        ? { reason: admitted.reason, source: admitted.source }
        : admitted.kind,
      detailOf(baseline, rows, admitted).detail,
    ).toEqual({ reason: "invalid-update", source: "final" });
    const { result: activated } = activate(baseline, rows);
    expect(
      activated.kind === "refused"
        ? { reason: activated.reason, source: activated.source }
        : activated.kind,
      detailOf(baseline, rows, activated).detail,
    ).toEqual({ reason: "invalid-update", source: "final" });
  });

  it("refuses when one run of a client's deleted clocks holds both a merge's deletion and a cleanup's", () => {
    const { baseline, rows, open } = session("Notes\n\nShared\n");
    const one = open(2),
      two = open(3);
    two.transact(() => {
      textOf(elements(two, "paragraph")[0]!).format(0, 5, { bold: {} });
      two.getXmlFragment("body").delete(1, 1);
    });
    // Client 2 types into "Shared", which client 3 deleted, then bolds "Notes" as client 3 did.
    one.transact(() => {
      append(textOf(elements(one, "paragraph")[1]!), "x");
      textOf(elements(one, "paragraph")[0]!).format(0, 5, { bold: {} });
    });
    expect(rows).toHaveLength(2);
    const own = undeclared(baseline, rows).filter((entry) => entry.client === 2);
    expect(new Set(own.map((entry) => entry.kind)), JSON.stringify(own)).toEqual(
      new Set(["other", "format"]),
    );
    const clocks = own.map((entry) => entry.clock);
    expect(clocks, "one run of clocks").toEqual(clocks.map((_, index) => clocks[0]! + index));
    const cut = validateOrderedLiveUpdateCut(
      { mode: "journal-candidate", checkpoint: baseline, suffix: [rows[0]!], candidate: rows[1]! },
      WORKER_LIVE_VALIDATION_POLICY,
    );
    if (cut.kind === "accepted") cut.cut.document.destroy();
    expect(
      cut.kind === "refused" ? { reason: cut.reason, stage: cut.stage } : cut.kind,
      "the cut",
    ).toEqual({ reason: "invalid-update", stage: { kind: "final" } });
    const admitted = admitRow(baseline, rows, 1);
    expect(
      admitted.kind === "refused"
        ? { reason: admitted.reason, source: admitted.source }
        : admitted.kind,
      detailOf(baseline, rows, admitted).detail,
    ).toEqual({ reason: "invalid-update", source: "final" });
    const { result: activated } = activate(baseline, rows);
    expect(
      activated.kind === "refused"
        ? { reason: activated.reason, source: activated.source }
        : activated.kind,
      detailOf(baseline, rows, activated).detail,
    ).toEqual({ reason: "invalid-update", source: "final" });
  });

  it("refuses a cleanup's deletion that sits next to a deletion the same row declares", () => {
    const { baseline, rows } = boldedBoth("Notes\n\nShared\n", (one, notes) => {
      const shared = textOf(elements(one, "paragraph")[1]!);
      append(shared, "y");
      shared.delete(shared.length - 1, 1);
      notes.format(0, 5, { bold: {} });
    });
    const declared = Y.decodeUpdate(rows[1]!).ds.clients.get(2) ?? [];
    const only = undeclared(baseline, rows).filter((entry) => entry.client === 2);
    expect(only.length).toBeGreaterThan(0);
    expect(
      only.every((entry) => entry.kind === "format"),
      JSON.stringify(only),
    ).toBe(true);
    expect(
      declared.some((range) => range.clock + range.len === only[0]!.clock),
      "a declared deletion ends where the undeclared one starts",
    ).toBe(true);
    const cut = validateOrderedLiveUpdateCut(
      { mode: "journal-candidate", checkpoint: baseline, suffix: [rows[0]!], candidate: rows[1]! },
      WORKER_LIVE_VALIDATION_POLICY,
    );
    if (cut.kind === "accepted") cut.cut.document.destroy();
    expect(
      cut.kind === "refused" ? { reason: cut.reason, stage: cut.stage } : cut.kind,
      "the cut",
    ).toEqual({ reason: "invalid-update", stage: { kind: "final" } });
    const admitted = admitRow(baseline, rows, 1);
    expect(
      admitted.kind === "refused"
        ? { reason: admitted.reason, source: admitted.source }
        : admitted.kind,
      detailOf(baseline, rows, admitted).detail,
    ).toEqual({ reason: "invalid-update", source: "final" });
    const { result: activated } = activate(baseline, rows);
    expect(
      activated.kind === "refused"
        ? { reason: activated.reason, source: activated.source }
        : activated.kind,
      detailOf(baseline, rows, activated).detail,
    ).toEqual({ reason: "invalid-update", source: "final" });
  });

  it("refuses a keystroke the replay turns into a GC struct because the text before it arrived collected", () => {
    const { rows, open } = session("Notes\n\nShared\n");
    const typist = open(2),
      collecting = open(3, true);
    collecting.getXmlFragment("body").delete(1, 1);
    // The checkpoint comes from a document that collects deleted content, so "Shared" arrives as GC structs.
    const checkpoint = Y.encodeStateAsUpdate(collecting);
    append(textOf(elements(typist, "paragraph")[1]!), "x");
    const typed = [rows[rows.length - 1]!];
    const only = undeclared(checkpoint, typed);
    expect(
      only.map((entry) => entry.kind),
      JSON.stringify(only),
    ).toEqual(["gc"]);
    expectRefusedAtBothDoors(checkpoint, typed);
  });
});
