// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { seededNote, storedReading } from "./bodySequenceChecksTestSupport.js";
import { mountLiveBodyEditor } from "./browser-editor.js";
import { admitBodySequenceNotes, liveEditFitsCopy } from "./liveDocumentValidation.js";

beforeAll(() => {
  admitBodySequenceNotes(true);
  const emptyRect = {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  const rectList = () =>
    Object.assign([emptyRect], { item: () => emptyRect }) as unknown as DOMRectList;
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = rectList;
    Range.prototype.getBoundingClientRect = () => emptyRect;
  }
  if (!Element.prototype.getClientRects) Element.prototype.getClientRects = rectList;
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
});
afterAll(() => {
  admitBodySequenceNotes(false);
  vi.useRealTimers();
});

const REMOTE = Symbol("remote");

it("a format-1 editor, open when its note turns out to be in format 2, writes nothing as the note arrives, and intake refuses every edit it makes", () => {
  vi.useFakeTimers();
  const note = seededNote();
  const page = new Y.Doc();
  page.clientID = 77;
  const sent: Uint8Array[] = [];
  page.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const mount = document.createElement("div");
  document.body.append(mount);
  const editor = mountLiveBodyEditor(mount, {
    doc: page,
    label: "Shared file editor",
    canEdit: () => true,
    edit(change) {
      change();
      return true;
    },
  });
  Y.applyUpdate(page, note, REMOTE);
  vi.runAllTimers();
  expect(sent, "written as the editor opened").toEqual([]);

  const textbox = mount.querySelector<HTMLElement>('[role="textbox"]')!;
  const paste = (text: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? text : ""), files: [] },
    });
    textbox.dispatchEvent(event);
  };
  const edits: [string, () => void][] = [
    ["typing", () => paste("typed by an old page")],
    ["a heading", () => editor.setHeading(2)],
    [
      "a new line",
      () =>
        textbox.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        ),
    ],
    ["more typing", () => paste("second line")],
    ["bold", () => editor.toggleMark("bold")],
    ["bold typing", () => paste("bold")],
  ];
  const stored = new Y.Doc({ gc: false });
  Y.applyUpdate(stored, note);
  const before = storedReading(stored);
  for (const [name, edit] of edits) {
    const from = sent.length;
    editor.focus();
    edit();
    vi.runAllTimers();
    for (const update of sent.slice(from)) {
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(stored));
      expect(liveEditFitsCopy(copy, Y.diffUpdate(update, Y.encodeStateVector(stored))), name).toBe(
        false,
      );
      copy.destroy();
    }
  }
  expect(sent.length, "the editor made edits").toBeGreaterThan(2);
  expect(storedReading(stored)).toEqual(before);
  editor.destroy();
  page.destroy();
  stored.destroy();
});
