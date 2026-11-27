// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createBodySequenceHistory, type BodySequenceUnwritten } from "./bodySequenceEditor.js";
import { LIVE_UPDATE_MAX_BYTES } from "./liveValidationPolicy.js";
import {
  boundary,
  editorOn,
  element,
  note,
  noteOf,
  page,
  stopEveryone,
  type Person,
} from "./bodySequenceTestSupport.js";

afterEach(stopEveryone);

function toldOf(baseline: Uint8Array, captureTimeout = 0, clientID = 10) {
  const told: BodySequenceUnwritten[] = [];
  const base = page(baseline, clientID);
  const history = createBodySequenceHistory(base.doc, { captureTimeout });
  const a = editorOn(base, "bare", [], [], { history, unwritten: (why) => told.push(why) });
  return { a, told };
}

function refusedStep(a: Person, told: BodySequenceUnwritten[], step: "undo" | "redo") {
  const lines = a.lines();
  const steps = [a.history.undoStack.length, a.history.redoStack.length];
  a.sent.splice(0);
  expect(a[step]()).toBe(true);
  expect(told).toEqual(["unwritable"]);
  expect(a.sent).toEqual([]);
  expect(a.lines()).toEqual(lines);
  expect([a.history.undoStack.length, a.history.redoStack.length]).toEqual(steps);
  a.expectMirror();
}

it("refuses an undo that would put back more letters than the room takes in one change", () => {
  const { a, told } = toldOf(note("a", "x".repeat(LIVE_UPDATE_MAX_BYTES + 10)));
  const line = a.view.state.doc.child(1);
  const start = a.view.state.doc.child(0).nodeSize + 1;
  a.view.dispatch(a.view.state.tr.delete(start, start + line.content.size));
  expect(told).toEqual([]);
  expect(a.lines()).toEqual(["a", ""]);
  refusedStep(a, told, "undo");
});

it("refuses an undo that would put back an image source longer than the room takes", () => {
  const src = "x".repeat(2_097_201);
  const { a, told } = toldOf(
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary(), {});
      sequence.insertEmbed(1, element("image", { src, alt: "", title: null }), {});
    }),
  );
  a.view.dispatch(a.view.state.tr.setNodeAttribute(1, "src", "/a.png"));
  expect(told).toEqual([]);
  expect(a.view.state.doc.child(0).child(0).attrs.src).toBe("/a.png");
  refusedStep(a, told, "undo");
  expect(a.view.state.doc.child(0).child(0).attrs.src).toBe("/a.png");
});

it("refuses a redo of two pastes that one undo step took back together", () => {
  const { a, told } = toldOf(note("a"), 60_000);
  const half = "x".repeat(LIVE_UPDATE_MAX_BYTES / 2 + 10);
  a.view.dispatch(a.view.state.tr.insertText(half, 2));
  a.view.dispatch(a.view.state.tr.insertText(half, 2));
  expect(told).toEqual([]);
  expect(a.undo()).toBe(true);
  expect(a.lines()).toEqual(["a"]);
  refusedStep(a, told, "redo");
});

it("undoes a deletion too long for the quick count once its trial fits the room", () => {
  const { a, told } = toldOf(note("a", "x".repeat(200_000)));
  const start = a.view.state.doc.child(0).nodeSize + 1;
  a.view.dispatch(a.view.state.tr.delete(start, start + 200_000));
  expect(a.undo()).toBe(true);
  expect(a.lines()).toEqual(["a", "x".repeat(200_000)]);
  expect(told).toEqual([]);
  a.expectMirror();
});

it("refuses an undo that passes a step typed and erased in one capture to an older deletion", () => {
  const { a, told } = toldOf(note("a", "x".repeat(LIVE_UPDATE_MAX_BYTES + 10)), 60_000);
  const start = a.view.state.doc.child(0).nodeSize + 1;
  a.view.dispatch(a.view.state.tr.delete(start, start + LIVE_UPDATE_MAX_BYTES + 10));
  a.history.stopCapturing();
  a.view.dispatch(a.view.state.tr.insertText("y", 2));
  a.view.dispatch(a.view.state.tr.delete(2, 3));
  expect(told).toEqual([]);
  refusedStep(a, told, "undo");
});

it("refuses the undo that would put a long image source back into an image an undo restored", () => {
  const src = "x".repeat(2_097_201);
  const { a, told } = toldOf(
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary(), {});
      sequence.insertEmbed(1, element("image", { src, alt: "", title: null }), {});
      sequence.insertEmbed(2, boundary(), {});
      sequence.insert(3, "b", {});
    }),
  );
  a.view.dispatch(a.view.state.tr.setNodeAttribute(1, "src", "/a.png"));
  a.view.dispatch(a.view.state.tr.delete(1, 2));
  expect(told).toEqual([]);
  expect(a.undo()).toBe(true);
  expect(a.view.state.doc.child(0).child(0).attrs.src).toBe("/a.png");
  refusedStep(a, told, "undo");
});

it("tries an undo as the person's own client, so one just past the room's bytes is refused", () => {
  const clientID = 2 ** 31 + 5;
  const typedThenDeleted = (letters: number) => {
    const made = toldOf(note("a", "x".repeat(letters)), 0, clientID);
    const { a } = made;
    for (let at = 0; at < 200; at++) a.view.dispatch(a.view.state.tr.insertText("ab", 2));
    const start = a.view.state.doc.child(0).nodeSize + 1;
    a.view.dispatch(a.view.state.tr.delete(start, start + letters));
    a.sent.splice(0);
    return made;
  };
  const probe = typedThenDeleted(LIVE_UPDATE_MAX_BYTES - 100).a;
  expect(probe.undo()).toBe(true);
  const around = probe.sent[0]!.byteLength - (LIVE_UPDATE_MAX_BYTES - 100);
  const { a, told } = typedThenDeleted(LIVE_UPDATE_MAX_BYTES + 1 - around);
  refusedStep(a, told, "undo");
});

it("undoes a change of a stored level too large for a plain number", () => {
  const { a, told } = toldOf(
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary({ type: "heading", level: 3n }), {});
      sequence.insert(1, "T", {});
    }),
  );
  a.select([0, 1]);
  a.retype("heading", { level: 2 });
  expect(a.undo()).toBe(true);
  expect(told).toEqual([]);
  a.expectMirror();
});

it("still undoes and redoes a change that fits", () => {
  const { a, told } = toldOf(note("a"));
  a.view.dispatch(a.view.state.tr.insertText("bc", 2));
  expect(a.undo()).toBe(true);
  expect(a.lines()).toEqual(["a"]);
  expect(a.redo()).toBe(true);
  expect(a.lines()).toEqual(["abc"]);
  expect(told).toEqual([]);
});
