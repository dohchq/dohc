import { expect, it } from "vitest";
import { passOrder } from "./servicePassOrder";

const notes = Array.from({ length: 26 }, (_, index) => `note-${String(index)}`);
const none = () => false;
/** A whole pass: what it visits in order, and where the turn stands after it. */
const pass = (
  targets: readonly string[],
  from: number,
  limit: number,
  wanted: (target: string) => boolean = none,
) => {
  const { first, turn } = passOrder(targets, from, limit, wanted);
  return {
    visit: [...first, ...turn.map((entry) => entry.target)],
    next: turn.at(-1)?.next ?? from,
  };
};

it("visits targets in turn when nobody waits, as before", () => {
  const first = pass(notes, 0, 8);
  expect(first.visit).toEqual(notes.slice(0, 8));
  expect(pass(notes, first.next, 8).visit).toEqual(notes.slice(8, 16));
  // The last pass of a round wraps to the start.
  expect(pass(notes, 24, 8).visit).toEqual([...notes.slice(24), ...notes.slice(0, 6)]);
  expect(pass(notes.slice(0, 3), 2, 8)).toEqual({ visit: ["note-2", "note-0", "note-1"], next: 2 });
  expect(pass([], 5, 8)).toEqual({ visit: [], next: 5 });
});

it("moves the turn on with each visit, so a pass that a failure ends takes up after the note that failed", () => {
  // Each entry carries where the turn stands once it is visited.
  expect(passOrder(notes.slice(0, 3), 2, 8, none).turn).toEqual([
    { target: "note-2", next: 0 },
    { target: "note-0", next: 1 },
    { target: "note-1", next: 2 },
  ]);
  // Two notes and a pass of eight: every pass plans both. The first fails each time it is visited.
  const two = ["fails", "works"],
    visited: string[] = [];
  let from = 0;
  for (let round = 0; round < 4; round++)
    for (const { target, next } of passOrder(two, from, 8, none).turn) {
      from = next;
      visited.push(target);
      if (target === "fails") break;
    }
  expect(visited.filter((target) => target === "works").length).toBeGreaterThanOrEqual(3);
});

it("visits a note someone waits for in the next pass, wherever its turn is", () => {
  // The last note in path order would come round in the fourth pass.
  const wanted = pass(notes, 0, 8, (note) => note === "note-25");
  expect(wanted.visit).toEqual(["note-25", ...notes.slice(0, 7)]);
  // The turn goes on from where it stopped, so the others lose one visit and no more.
  expect(wanted.next).toBe(7);
});

it("gives wanted notes at most half a pass, so the others keep their turn", () => {
  // Every note is wanted, as under a stream of requests for notes that never become ready.
  const turns: string[] = [];
  let from = 0;
  for (let round = 0; round < 7; round++) {
    const { first, turn } = passOrder(notes, from, 8, () => true);
    expect(first).toEqual(notes.slice(0, 4));
    expect(turn).toHaveLength(4);
    turns.push(...turn.map((entry) => entry.target));
    from = turn.at(-1)!.next;
  }
  // Seven passes of four turn-visits reach all 22 other notes.
  expect(new Set([...turns, ...notes.slice(0, 4)])).toEqual(new Set(notes));
});

it("gives a wanted note no head start when a pass visits one target", () => {
  expect(pass(notes, 3, 1, (note) => note === "note-25").visit).toEqual(["note-3"]);
});
