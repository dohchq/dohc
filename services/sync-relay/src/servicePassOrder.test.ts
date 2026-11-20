import { expect, it } from "vitest";
import { passPlan } from "./servicePassOrder";

const notes = Array.from({ length: 26 }, (_, index) => `note-${String(index)}`);

function wholePass(
  targets: readonly string[],
  from: number,
  limit: number,
  wanted: (target: string) => boolean = () => false,
) {
  const plan = passPlan(targets, from, limit, wanted);
  const visit: string[] = [];
  let turn = from;
  for (let next = plan.next(); next; next = plan.next()) {
    visit.push(next.target);
    turn = next.turn ?? turn;
  }
  return { visit, turn };
}

it("visits targets in turn when nobody waits, wrapping at the end", () => {
  const first = wholePass(notes, 0, 8);
  expect(first).toEqual({ visit: notes.slice(0, 8), turn: 8 });
  expect(wholePass(notes, first.turn, 8).visit).toEqual(notes.slice(8, 16));
  expect(wholePass(notes, 24, 8).visit).toEqual([...notes.slice(24), ...notes.slice(0, 6)]);
  expect(wholePass(notes.slice(0, 3), 2, 8)).toEqual({
    visit: ["note-2", "note-0", "note-1"],
    turn: 2,
  });
  expect(wholePass([], 5, 8)).toEqual({ visit: [], turn: 5 });
});

it("moves the turn on with each visit, so a pass a failure ends takes up after the note that failed", () => {
  const plan = passPlan(notes.slice(0, 3), 2, 8, () => false);
  expect([plan.next(), plan.next(), plan.next(), plan.next()]).toEqual([
    { target: "note-2", turn: 0 },
    { target: "note-0", turn: 1 },
    { target: "note-1", turn: 2 },
    undefined,
  ]);
  const two = ["fails", "works"],
    visited: string[] = [];
  let from = 0;
  for (let pass = 0; pass < 4; pass++) {
    const failing = passPlan(two, from, 8, () => false);
    for (let next = failing.next(); next; next = failing.next()) {
      from = next.turn ?? from;
      visited.push(next.target);
      if (next.target === "fails") break;
    }
  }
  expect(visited.filter((target) => target === "works").length).toBeGreaterThanOrEqual(3);
});

it("visits a note already wanted first, wherever its turn is, and the turn loses one visit", () => {
  expect(wholePass(notes, 0, 8, (note) => note === "note-25")).toEqual({
    visit: ["note-25", ...notes.slice(0, 7)],
    turn: 7,
  });
});

it("visits a note that becomes wanted during the pass right after the visit under way", () => {
  const wanted = new Set<string>();
  const plan = passPlan(notes, 0, 8, (note) => wanted.has(note));
  expect(plan.next()).toEqual({ target: "note-0", turn: 1 });
  wanted.add("note-25");
  expect(plan.next()).toEqual({ target: "note-25" });
  const rest: string[] = [];
  for (let next = plan.next(); next; next = plan.next()) rest.push(next.target);
  expect(rest).toEqual(notes.slice(1, 7));
});

it("visits no note twice in a pass, though it is wanted again after its visit", () => {
  const plan = passPlan(notes.slice(0, 3), 0, 8, (note) => note === "note-1");
  const visit: string[] = [];
  for (let next = plan.next(); next; next = plan.next()) visit.push(next.target);
  expect(visit).toEqual(["note-1", "note-0", "note-2"]);
});

it("gives wanted notes at most half a pass, so the turn still reaches every note", () => {
  const inTurn: string[] = [];
  let from = 0;
  for (let pass = 0; pass < 7; pass++) {
    const plan = passPlan(notes, from, 8, () => true);
    const wantedVisits: string[] = [];
    for (let next = plan.next(); next; next = plan.next()) {
      if (next.turn === undefined) wantedVisits.push(next.target);
      else {
        inTurn.push(next.target);
        from = next.turn;
      }
    }
    expect(wantedVisits).toEqual(notes.slice(0, 4));
  }
  expect(new Set([...inTurn, ...notes.slice(0, 4)])).toEqual(new Set(notes));
});

it("gives a wanted note no head start when a pass visits one target", () => {
  expect(wholePass(notes, 3, 1, (note) => note === "note-25").visit).toEqual(["note-3"]);
});
