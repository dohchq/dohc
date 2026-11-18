import { expect, it } from "vitest";
import { passOrder } from "./servicePassOrder";

const notes = Array.from({ length: 26 }, (_, index) => `note-${String(index)}`);
const none = () => false;

it("visits targets in turn when nobody waits, as before", () => {
  const first = passOrder(notes, 0, 8, none);
  expect(first.visit).toEqual(notes.slice(0, 8));
  const second = passOrder(notes, first.next, 8, none);
  expect(second.visit).toEqual(notes.slice(8, 16));
  // The last pass of a round wraps to the start.
  expect(passOrder(notes, 24, 8, none).visit).toEqual([...notes.slice(24), ...notes.slice(0, 6)]);
  expect(passOrder(notes.slice(0, 3), 2, 8, none)).toEqual({
    visit: ["note-2", "note-0", "note-1"],
    next: 2,
  });
  expect(passOrder([], 5, 8, none)).toEqual({ visit: [], next: 5 });
});

it("visits a note someone waits for in the next pass, wherever its turn is", () => {
  // The last note in path order would come round in the fourth pass.
  const pass = passOrder(notes, 0, 8, (note) => note === "note-25");
  expect(pass.visit).toEqual(["note-25", ...notes.slice(0, 7)]);
  // The turn goes on from where it stopped, so the others lose one visit and no more.
  expect(pass.next).toBe(7);
});

it("gives wanted notes at most half a pass, so the others keep their turn", () => {
  // Every note is wanted, as under a stream of requests for notes that never become ready.
  const rounds: string[] = [];
  let from = 0;
  for (let pass = 0; pass < 7; pass++) {
    const { visit, next } = passOrder(notes, from, 8, () => true);
    expect(visit).toHaveLength(8);
    expect(new Set(visit).size).toBe(8);
    // The first four are the wanted ones. The rest come from the turn.
    expect(visit.slice(0, 4)).toEqual(notes.slice(0, 4));
    rounds.push(...visit.slice(4));
    from = next;
  }
  // Seven passes of four turn-visits reach all 22 other notes.
  expect(new Set([...rounds, ...notes.slice(0, 4)])).toEqual(new Set(notes));
});

it("gives a wanted note no head start when a pass visits one target", () => {
  expect(passOrder(notes, 3, 1, (note) => note === "note-25").visit).toEqual(["note-3"]);
});
