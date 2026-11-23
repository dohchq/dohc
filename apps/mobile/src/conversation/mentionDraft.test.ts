import { describe, expect, it } from "vitest";
import type { ClearRequest, FieldChange } from "../../modules/chat-composer";
import { clearedBy, EMPTY_DRAFT, fieldChanged, type Draft } from "./conversationWrites";
import {
  acceptsReport,
  activeMention,
  askReplacement,
  composing,
  latestSnapshot,
  mentionCompletion,
  mentionMatches,
  NO_REPLACING,
  phoneMentions,
  replacementAnswered,
  replacePending,
  replaceRequest,
  snapshotOf,
  type FieldSnapshot,
  type Replacing,
} from "./mentionDraft";

/** A report from the native field, with the caret at the text's end unless `fields` say more. */
const report = (
  text: string,
  revision: number,
  sequence: number,
  fields: Partial<FieldChange> = {},
): FieldChange => ({
  text,
  revision,
  sequence,
  selectionStart: text.length,
  selectionEnd: text.length,
  cleared: 0,
  refused: 0,
  ...fields,
});

const snap = (text: string, fields: Partial<FieldChange> = {}): FieldSnapshot =>
  latestSnapshot(null, report(text, 4, 9, fields));

describe("the field's latest report", () => {
  it("takes the first report, and each newer one", () => {
    const first = latestSnapshot(null, report("H", 1, 1));
    expect(first).toEqual({
      text: "H",
      revision: 1,
      sequence: 1,
      selectionStart: 1,
      selectionEnd: 1,
    });
    const moved = latestSnapshot(first, report("H", 1, 2, { selectionStart: 0, selectionEnd: 0 }));
    expect(moved).toMatchObject({ revision: 1, sequence: 2, selectionStart: 0 });
  });

  it("drops a report older than, or as old as, the one it has", () => {
    const current = latestSnapshot(null, report("Hello", 5, 7));
    expect(latestSnapshot(current, report("Hell", 4, 6))).toBe(current);
    expect(latestSnapshot(current, report("Other", 5, 7))).toBe(current);
  });

  it("keeps only the field's state, not a report's answers", () => {
    const answered = report("A", 2, 3, { cleared: 1, replaced: { token: 1, applied: true } });
    expect(latestSnapshot(null, answered)).toEqual({
      text: "A",
      revision: 2,
      sequence: 3,
      selectionStart: 1,
      selectionEnd: 1,
    });
  });

  it("says when an input method is composing, and when it stops", () => {
    const marked = latestSnapshot(null, report("にほ", 2, 3, { composing: { start: 0, end: 2 } }));
    expect(composing(marked)).toBe(true);
    // Committing exactly what was composed changes no text, so the revision stays, and only the sequence moves.
    const committed = latestSnapshot(marked, report("にほ", 2, 4));
    expect(composing(committed)).toBe(false);
    expect(composing(null)).toBe(false);
  });
});

describe("a report that comes late", () => {
  /** What the composer holds once it has taken `changes` in order, as its field handler takes them. */
  function take(changes: readonly FieldChange[], request: ClearRequest, start: Replacing) {
    let accepted = 0;
    let field: FieldSnapshot | null = null;
    let draft: Draft = EMPTY_DRAFT;
    let replacing = start;
    let refused = 0;
    const texts: string[] = [];
    let clears = 0;
    for (const change of changes) {
      if (change.replaced !== undefined) replacing = replacementAnswered(replacing, change);
      if (!acceptsReport(accepted, change)) continue;
      accepted = change.sequence;
      field = snapshotOf(change);
      if (change.refused !== 0) refused = change.refused;
      draft = fieldChanged(draft, change, request, null);
      texts.push(change.text);
      if (clearedBy(change, request)) clears += 1;
    }
    return { accepted, field, draft, replacing, refused, texts, clears };
  }

  it("takes only a report newer than the last it took", () => {
    expect(acceptsReport(0, report("A", 1, 1))).toBe(true);
    expect(acceptsReport(11, report("AB", 6, 12))).toBe(true);
    expect(acceptsReport(11, report("A", 5, 10))).toBe(false);
    expect(acceptsReport(11, report("AB", 6, 11))).toBe(false);
  });

  it("changes nothing when sequence 10 comes after 11, even a clear already answered", () => {
    const request = { revision: 4, token: 1 };
    const cleared = report("", 5, 10, { cleared: 1 });
    const typed = report("AB", 6, 11, { selectionStart: 1, selectionEnd: 1 });
    const taken = take(
      [cleared, typed, report("A", 5, 10, { refused: 2 }), cleared],
      request,
      NO_REPLACING,
    );
    expect(taken.accepted).toBe(11);
    expect(taken.field).toEqual(snapshotOf(typed));
    expect(taken.draft).toMatchObject({ text: "AB", textRevision: 6 });
    expect(taken.texts).toEqual(["", "AB"]);
    expect(taken.refused).toBe(0);
    expect(taken.clears).toBe(1);
  });

  it("still settles a replacement by its token, without taking the late report's text", () => {
    const asked = askReplacement(NO_REPLACING, snap("Hi @sa"), {
      start: 3,
      end: 6,
      replacement: "@sam ",
      caret: 8,
    });
    if (asked.kind !== "asked") throw new Error(`refused: ${asked.reason}`);
    const late = report("Hi @sam ", 5, 10, { replaced: { token: 1, applied: true } });
    const taken = take(
      [report("Hi @sam x", 6, 11), late],
      { revision: 0, token: 0 },
      asked.replacing,
    );
    expect(taken.replacing.answer).toEqual({ token: 1, applied: true });
    expect(taken.draft).toMatchObject({ text: "Hi @sam x", textRevision: 6 });
    expect(taken.texts).toEqual(["Hi @sam x"]);
  });
});

describe("a replacement request", () => {
  const edit = { start: 3, end: 6, replacement: "@sam ", caret: 8 };

  it("carries the snapshot's revision and sequence, and the text it replaces", () => {
    expect(replaceRequest(snap("Hi @sa"), edit, 1)).toEqual({
      token: 1,
      revision: 4,
      sequence: 9,
      start: 3,
      end: 6,
      expected: "@sa",
      replacement: "@sam ",
      caret: 8,
    });
  });

  it("keeps the text after the caret", () => {
    const request = replaceRequest(
      snap("Hi @sa there", { selectionStart: 6, selectionEnd: 6 }),
      edit,
      1,
    );
    expect(request).toMatchObject({ expected: "@sa", start: 3, end: 6 });
  });

  it("refuses a selection that isn't a caret alone at the range's end", () => {
    expect(replaceRequest(snap("Hi @sa", { selectionStart: 3, selectionEnd: 6 }), edit, 1)).toBe(
      "selection",
    );
    expect(replaceRequest(snap("Hi @sa", { selectionStart: 5, selectionEnd: 5 }), edit, 1)).toBe(
      "selection",
    );
  });

  it("refuses while an input method is composing", () => {
    expect(replaceRequest(snap("Hi @sa", { composing: { start: 4, end: 6 } }), edit, 1)).toBe(
      "composing",
    );
  });

  it("refuses a range or caret outside the text", () => {
    expect(replaceRequest(snap("Hi"), edit, 1)).toBe("range");
    expect(replaceRequest(snap("Hi @sa"), { ...edit, start: 7, end: 6 }, 1)).toBe("range");
    expect(replaceRequest(snap("Hi @sa"), { ...edit, start: -1 }, 1)).toBe("range");
    expect(replaceRequest(snap("Hi @sa"), { ...edit, caret: 9 }, 1)).toBe("range");
    expect(replaceRequest(snap("Hi @sa"), { ...edit, start: 1.5 }, 1)).toBe("range");
  });

  it("counts UTF-16 code units, and refuses a range or caret inside a surrogate pair", () => {
    // "😀" is two UTF-16 code units, so the query after it starts at 3.
    const text = "😀 @sa";
    expect(
      replaceRequest(snap(text), { start: 3, end: 6, replacement: "@sam ", caret: 8 }, 1),
    ).toMatchObject({
      expected: "@sa",
    });
    expect(replaceRequest(snap(text), { start: 1, end: 6, replacement: "x", caret: 2 }, 1)).toBe(
      "surrogate",
    );
    const after = snap("@sa😀", { selectionStart: 4, selectionEnd: 4 });
    expect(replaceRequest(after, { start: 0, end: 4, replacement: "@", caret: 1 }, 1)).toBe(
      "surrogate",
    );
    expect(replaceRequest(snap(text), { start: 3, end: 6, replacement: "🙂", caret: 4 }, 1)).toBe(
      "surrogate",
    );
  });
});

describe("asking the field for a replacement", () => {
  const edit = { start: 3, end: 6, replacement: "@sam ", caret: 8 };

  function ask(current: Replacing, snapshot = snap("Hi @sa")): Replacing {
    const asked = askReplacement(current, snapshot, edit);
    if (asked.kind !== "asked") throw new Error(`refused: ${asked.reason}`);
    return asked.replacing;
  }

  it("asks under a new token each time", () => {
    const first = ask(NO_REPLACING);
    expect(first.request.token).toBe(1);
    expect(replacePending(first)).toBe(true);
    const answered = replacementAnswered(first, { replaced: { token: 1, applied: true } });
    expect(ask(answered).request.token).toBe(2);
  });

  it("asks one at a time", () => {
    expect(askReplacement(ask(NO_REPLACING), snap("Hi @sa"), edit)).toEqual({
      kind: "refused",
      reason: "pending",
    });
  });

  it("says why it can't ask, and asks nothing", () => {
    expect(
      askReplacement(NO_REPLACING, snap("Hi @sa", { composing: { start: 4, end: 6 } }), edit),
    ).toEqual({ kind: "refused", reason: "composing" });
    expect(replacePending(NO_REPLACING)).toBe(false);
  });

  it("matches the field's answer to the request by token", () => {
    const pending = ask(NO_REPLACING);
    const applied = replacementAnswered(pending, { replaced: { token: 1, applied: true } });
    expect(applied.answer).toEqual({ token: 1, applied: true });
    expect(replacePending(applied)).toBe(false);
  });

  it("takes a refusal as final, so nothing asks again on its own", () => {
    const refused = replacementAnswered(ask(NO_REPLACING), {
      replaced: { token: 1, applied: false },
    });
    expect(refused.answer).toEqual({ token: 1, applied: false });
    expect(refused.request.token).toBe(1);
    expect(replacePending(refused)).toBe(false);
  });

  it("ignores an answer for another token, a second answer, and a report without one", () => {
    const first = replacementAnswered(ask(NO_REPLACING), {
      replaced: { token: 1, applied: false },
    });
    const pending = ask(first);
    expect(pending.request.token).toBe(2);
    // A late answer to the first request doesn't settle the second.
    expect(replacementAnswered(pending, { replaced: { token: 1, applied: true } })).toBe(pending);
    expect(replacementAnswered(pending, {})).toBe(pending);
    const settled = replacementAnswered(pending, { replaced: { token: 2, applied: true } });
    expect(replacementAnswered(settled, { replaced: { token: 2, applied: false } })).toBe(settled);
  });

  it("ignores an answer when nothing was asked", () => {
    expect(replacementAnswered(NO_REPLACING, { replaced: { token: 0, applied: true } })).toBe(
      NO_REPLACING,
    );
  });
});

describe("the @name menu", () => {
  const people = phoneMentions([
    { kind: "person", handle: "maya", label: "Maya" },
    { kind: "person", handle: "mark", label: "Mark Chen" },
    { kind: "agent", handle: "nova", label: "Nova", computers: ["Ice's Mac"] },
    { kind: "personalAgent", handle: "claude", label: "Claude" },
  ]);
  const handles = (text: string, fields: Partial<FieldChange> = {}) => {
    const active = activeMention(snap(text, fields));
    return active && mentionMatches(active, people).map((candidate) => candidate.handle);
  };
  const choose = (text: string, handle: string, fields: Partial<FieldChange> = {}) => {
    const snapshot = snap(text, fields);
    const active = activeMention(snapshot);
    const candidate = people.find((each) => each.handle === handle);
    if (!active || !candidate) throw new Error("no menu");
    return mentionCompletion(snapshot, active, candidate);
  };

  it("maps a person to a user and both kinds of agent to an agent", () => {
    expect(people.map(({ kind, connected }) => [kind, connected])).toEqual([
      ["user", false],
      ["user", false],
      ["agent", false],
      ["agent", true],
    ]);
  });

  it("offers the matches for an @ at the start and mid-sentence, best first", () => {
    expect(handles("Can @may")).toEqual(["maya"]);
    // Equal matches go agents first, then by name.
    expect(handles("@ma")).toEqual(["mark", "maya"]);
    expect(handles("Can @ma")).toEqual(["mark", "maya"]);
    expect(handles("Can @")).toEqual(["claude", "nova", "mark", "maya"]);
    expect(handles("Can @zz")).toEqual([]);
    expect(handles("email@ma")).toBeNull();
    expect(handles("Can @maya ")).toBeNull();
  });

  it("offers nothing for an @ in inline code or a code fence", () => {
    expect(handles("Run `x @ma` now", { selectionStart: 10, selectionEnd: 10 })).toBeNull();
    expect(handles("```\nping @ma")).toBeNull();
    expect(handles("```\ncode\n```\nping @ma")).toEqual(["mark", "maya"]);
  });

  it("offers nothing while an input method composes, or for a selection", () => {
    expect(handles("Can @ma", { composing: { start: 5, end: 7 } })).toBeNull();
    expect(handles("Can @ma", { selectionStart: 5, selectionEnd: 7 })).toBeNull();
  });

  it("completes the query to the handle and a space, with the caret after it", () => {
    const edit = choose("Can @ma", "maya");
    expect(edit).toEqual({ start: 4, end: 7, replacement: "@maya ", caret: 10 });
    const asked = askReplacement(NO_REPLACING, snap("Can @ma"), edit);
    expect(asked.kind === "asked" && asked.replacing.request).toMatchObject({
      expected: "@ma",
      replacement: "@maya ",
      caret: 10,
    });
  });

  it("keeps the text after the caret", () => {
    const fields = { selectionStart: 7, selectionEnd: 7 };
    const edit = choose("Can @ma help?", "maya", fields);
    const snapshot = snap("Can @ma help?", fields);
    const asked = askReplacement(NO_REPLACING, snapshot, edit);
    expect(asked.kind).toBe("asked");
    const { text } = snapshot;
    expect(text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)).toBe(
      "Can @maya  help?",
    );
  });

  it("lists both candidates of a colliding handle, and either writes the same text", () => {
    const twins = phoneMentions([
      { kind: "person", handle: "sam", label: "Sam" },
      { kind: "agent", handle: "sam", label: "Sam", computers: ["Studio"] },
    ]);
    const snapshot = snap("hi @sa");
    const active = activeMention(snapshot);
    if (!active) throw new Error("no menu");
    const [first, second] = mentionMatches(active, twins);
    expect(first && second && first.id !== second.id).toBe(true);
    if (!first || !second) return;
    expect(mentionCompletion(snapshot, active, first)).toEqual(
      mentionCompletion(snapshot, active, second),
    );
  });

  it("asks nothing again after the field refuses a completion", () => {
    const asked = askReplacement(NO_REPLACING, snap("Can @ma"), choose("Can @ma", "maya"));
    if (asked.kind !== "asked") throw new Error("not asked");
    const refused = replacementAnswered(asked.replacing, {
      replaced: { token: 1, applied: false },
    });
    expect(replacePending(refused)).toBe(false);
    expect(refused.request.token).toBe(1);
  });
});
