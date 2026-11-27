import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { DrawingEdit } from "@dohc/workspace-contracts/drawing";
import { planDrawingEdit, summarizeDrawing } from "./agentScene";
import { foldScene, insertElementRevision } from "./index";

function apply(doc: Y.Doc, edit: DrawingEdit) {
  const plan = planDrawingEdit(doc, edit, 1_700_000_000_000);
  if ("reason" in plan) throw new Error(plan.reason);
  if (plan.update) Y.applyUpdate(doc, plan.update);
  return plan.written;
}

function live(doc: Y.Doc) {
  return summarizeDrawing(foldScene(doc).elements, false);
}

describe("planDrawingEdit", () => {
  it("adds labelled, bound elements in order with Excalidraw's defaults", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "ellipse", x: 400, y: 0 },
        { id: "label", type: "text", x: 0, y: 0, text: "Start", containerId: "a" },
        { id: "go", type: "arrow", x: 200, y: 50, start: "a", end: "b" },
      ],
    });
    const scene = foldScene(doc).elements;
    expect(scene.map((element) => element.id)).toEqual(["a", "b", "label", "go"]);
    const [a, , label, go] = scene;
    expect(a).toMatchObject({
      version: 1,
      angle: 0,
      roughness: 1,
      opacity: 100,
      boundElements: [
        { id: "label", type: "text" },
        { id: "go", type: "arrow" },
      ],
    });
    expect(typeof a!.seed).toBe("number");
    expect(label).toMatchObject({
      containerId: "a",
      originalText: "Start",
      textAlign: "center",
      verticalAlign: "middle",
      x: 100 - (label!.width as number) / 2,
      y: 50 - (label!.height as number) / 2,
    });
    expect(go).toMatchObject({
      x: 204,
      startBinding: { elementId: "a", focus: 0, gap: 4 },
      endBinding: { elementId: "b", focus: 0, gap: 4 },
      endArrowhead: "arrow",
    });
    expect((go!.x as number) + (go!.points as number[][])[1]![0]!).toBeCloseTo(396.11);
    expect(live(doc).find((element) => element.id === "go")).toMatchObject({ pointCount: 2 });
  });

  it("refuses a stale expectedVersion and changes nothing", () => {
    const doc = new Y.Doc();
    apply(doc, { add: [{ id: "a", type: "rectangle", x: 0, y: 0 }] });
    const before = Y.encodeStateVector(doc);
    const plan = planDrawingEdit(
      doc,
      {
        add: [{ type: "text", x: 0, y: 0, text: "x" }],
        update: [{ id: "a", expectedVersion: 0, x: 5 }],
      },
      0,
    );
    expect(plan).toEqual({ reason: expect.stringContaining("a is at version 1, not 0") });
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("moves a container's text and arrows with it and deletes the text with the container", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "label", type: "text", x: 0, y: 0, text: "Hi", containerId: "a" },
        { id: "b", type: "diamond", x: 400, y: 0 },
        { id: "go", type: "arrow", x: 200, y: 50, start: "a", end: "b" },
      ],
    });
    const moved = apply(doc, { update: [{ id: "a", expectedVersion: 1, x: 100 }] });
    expect(moved.map(({ id }) => id).sort()).toEqual(["a", "go", "label"]);
    const label = foldScene(doc).elements.find((element) => element.id === "label")!;
    expect(label.x).toBe(200 - (label.width as number) / 2);
    const go = foldScene(doc).elements.find((element) => element.id === "go")!;
    expect(go.x).toBe(304);
    expect((go.x as number) + (go.points as number[][])[1]![0]!).toBeCloseTo(400.02);

    apply(doc, { delete: [{ id: "a", expectedVersion: 2 }] });
    expect(live(doc).map((element) => element.id)).toEqual(["b", "go"]);
    expect(live(doc).find((element) => element.id === "go")).not.toHaveProperty("startBinding");
  });

  it("moves an arrow the edit names only by its own update", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "rectangle", x: 400, y: 0, width: 200, height: 100 },
        { id: "go", type: "arrow", x: 200, y: 50, start: "a", end: "b" },
      ],
    });
    apply(doc, {
      update: [
        { id: "a", expectedVersion: 1, x: 100 },
        { id: "b", expectedVersion: 1, x: 500 },
        { id: "go", expectedVersion: 1, x: 300 },
      ],
    });
    expect(live(doc).map(({ id, x }) => [id, x])).toEqual([
      ["a", 100],
      ["b", 500],
      ["go", 300],
    ]);
  });

  it("still moves an arrow the edit only restyles", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "rectangle", x: 400, y: 0, width: 200, height: 100 },
        { id: "go", type: "arrow", x: 200, y: 50, start: "a", end: "b" },
      ],
    });
    apply(doc, {
      update: [
        { id: "b", expectedVersion: 1, y: 300 },
        { id: "go", expectedVersion: 1, strokeColor: "#e03131" },
      ],
    });
    const go = foldScene(doc).elements.find((element) => element.id === "go")!;
    expect(go).toMatchObject({ strokeColor: "#e03131" });
    expect((go.y as number) + (go.points as number[][])[1]![1]!).toBeGreaterThan(250);
  });

  it("keeps a bound arrow's ends on a shape resized in place", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "rectangle", x: 400, y: 0, width: 200, height: 100 },
        { id: "go", type: "arrow", x: 200, y: 50, start: "a", end: "b" },
      ],
    });
    apply(doc, { update: [{ id: "a", expectedVersion: 1, width: 300, height: 200 }] });
    const go = foldScene(doc).elements.find((element) => element.id === "go")!;
    const end = (go.points as number[][])[1]!;
    expect([go.x, go.y]).toEqual([304, 100]);
    expect([(go.x as number) + end[0]!, (go.y as number) + end[1]!]).toEqual([396, 50]);
  });

  it("keeps a bound arrow's end on a rotated shape resized in place", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        {
          id: "go",
          type: "arrow",
          x: 100,
          y: 300,
          points: [
            [0, 0],
            [0, -146],
          ],
        },
      ],
    });
    const scene = foldScene(doc).elements;
    const a = scene.find((element) => element.id === "a")!;
    const go = scene.find((element) => element.id === "go")!;
    insertElementRevision(doc, { ...a, version: 2, angle: Math.PI / 2 });
    insertElementRevision(doc, {
      ...go,
      version: 2,
      endBinding: { elementId: "a", focus: 0, gap: 4 },
    });
    apply(doc, { update: [{ id: "a", expectedVersion: 2, width: 300 }] });
    const moved = foldScene(doc).elements.find((element) => element.id === "go")!;
    const end = (moved.points as number[][])[1]!;
    expect((moved.x as number) + end[0]!).toBeCloseTo(150);
    expect((moved.y as number) + end[1]!).toBeCloseTo(204);
  });

  it("starts and ends a new bound arrow on rotated shapes' outlines", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "rectangle", x: 400, y: 0, width: 200, height: 100 },
      ],
    });
    for (const shape of foldScene(doc).elements)
      insertElementRevision(doc, { ...shape, version: 2, angle: Math.PI / 2 });
    apply(doc, { add: [{ id: "go", type: "arrow", x: 0, y: 0, start: "a", end: "b" }] });
    const go = foldScene(doc).elements.find((element) => element.id === "go")!;
    const end = (go.points as number[][])[1]!;
    expect(go.x).toBeCloseTo(154);
    expect(go.y).toBeCloseTo(50);
    expect((go.x as number) + end[0]!).toBeCloseTo(446);
    expect((go.y as number) + end[1]!).toBeCloseTo(50);
  });

  it("starts a new bound arrow on a rotated ellipse's or diamond's own outline", () => {
    for (const [type, outline] of [
      ["ellipse", (x: number, y: number) => Math.hypot(x, y)],
      ["diamond", (x: number, y: number) => x + y],
    ] as const) {
      const doc = new Y.Doc();
      apply(doc, {
        add: [
          { id: "a", type, x: 0, y: 0, width: 200, height: 100 },
          { id: "b", type: "rectangle", x: 400, y: 0, width: 200, height: 100 },
        ],
      });
      const a = foldScene(doc).elements.find((element) => element.id === "a")!;
      insertElementRevision(doc, { ...a, version: 2, angle: Math.PI / 4 });
      apply(doc, { add: [{ id: "go", type: "arrow", x: 0, y: 0, start: "a", end: "b" }] });
      const go = foldScene(doc).elements.find((element) => element.id === "go")!;
      const [dx, dy] = [(go.x as number) - 100, (go.y as number) - 50];
      const [u, v] = [(dx + dy) * Math.SQRT1_2, (dy - dx) * Math.SQRT1_2];
      expect(outline(Math.abs(u) / 104, Math.abs(v) / 54)).toBeCloseTo(1);
    }
  });

  it("keeps a person-drawn arrow's own gap when its shape is resized", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
        {
          id: "go",
          type: "arrow",
          x: 120,
          y: 50,
          start: "a",
          points: [
            [0, 0],
            [200, 0],
          ],
        },
      ],
    });
    const go = foldScene(doc).elements.find((element) => element.id === "go")!;
    insertElementRevision(doc, {
      ...go,
      version: 2,
      startBinding: { elementId: "a", focus: 0, gap: 20 },
    });
    apply(doc, { update: [{ id: "a", expectedVersion: 1, width: 1000 }] });
    expect(live(doc).find((element) => element.id === "go")).toMatchObject({ x: 1020, y: 50 });
  });

  it("leaves a rotated arrow where it was when its shape grows away from it", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
        {
          id: "go",
          type: "arrow",
          x: -4,
          y: 50,
          start: "a",
          points: [
            [0, 0],
            [-100, 0],
          ],
        },
      ],
    });
    const go = foldScene(doc).elements.find((element) => element.id === "go")!;
    insertElementRevision(doc, {
      ...go,
      version: 2,
      x: -54,
      y: 0,
      angle: Math.PI / 2,
      points: [
        [0, 0],
        [0, 100],
      ],
      width: 0,
      height: 100,
    });
    const written = apply(doc, { update: [{ id: "a", expectedVersion: 1, width: 200 }] });
    expect(written.map(({ id }) => id)).toEqual(["a"]);
  });

  it("edits around an arrow with no points", () => {
    const doc = new Y.Doc();
    apply(doc, { add: [{ id: "a", type: "rectangle", x: 0, y: 0 }] });
    insertElementRevision(doc, {
      id: "bad",
      type: "arrow",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      points: [],
      startBinding: { elementId: "a", focus: 0, gap: 4 },
    });
    apply(doc, { update: [{ id: "a", expectedVersion: 1, x: 50 }] });
    expect(live(doc).find((element) => element.id === "a")).toMatchObject({ x: 50 });
  });

  it("leaves a bound arrow alone when its shape is only restyled", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "b", type: "rectangle", x: 400, y: 0, width: 200, height: 100 },
        {
          id: "go",
          type: "arrow",
          x: 204,
          y: 0.1,
          start: "a",
          end: "b",
          points: [
            [0, 0],
            [192, 0],
          ],
        },
      ],
    });
    const written = apply(doc, {
      update: [{ id: "a", expectedVersion: 1, strokeColor: "#e03131" }],
    });
    expect(written.map(({ id }) => id)).toEqual(["a"]);
  });

  it("sizes changed text with the element's own font size and line height", () => {
    const doc = new Y.Doc();
    apply(doc, { add: [{ id: "t", type: "text", x: 0, y: 0, text: "Hi" }] });
    const text = foldScene(doc).elements.find((element) => element.id === "t")!;
    insertElementRevision(doc, { ...text, version: 2, fontSize: 40, lineHeight: 1.5 });
    apply(doc, { update: [{ id: "t", expectedVersion: 2, text: "hello" }] });
    expect(live(doc)).toMatchObject([{ id: "t", width: 90, height: 60 }]);
  });

  it("wraps a long label inside its shape and grows the shape to fit", () => {
    const doc = new Y.Doc();
    const notes = "Notes: keep every RECEIPT and file them by month for the accountant";
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "b", type: "ellipse", x: 400, y: 0, width: 200, height: 100 },
        { id: "label", type: "text", x: 0, y: 0, text: notes, containerId: "a" },
        { id: "round", type: "text", x: 0, y: 0, text: "One\nTwo\nThree\nFour", containerId: "b" },
      ],
    });
    const [a, b, label, round] = foldScene(doc).elements;
    expect(a).toMatchObject({ x: 0, y: 0, width: 160 });
    expect(a!.height).toBeGreaterThan(80);
    expect(label).toMatchObject({ originalText: notes });
    expect(String(label!.text).split("\n").length).toBeGreaterThan(1);
    expect(String(label!.text).replaceAll("\n", " ")).toBe(notes);
    expectInside(label!, a!, 5);
    expect(b).toMatchObject({ x: 400, y: 0, width: 200 });
    expectInsideEllipse(round!, b!);
    expect(live(doc).find(({ id }) => id === "label")).toMatchObject({ text: notes });
  });

  it("rewraps a label when its text or shape changes and keeps its arrow on the shape", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 300, height: 80 },
        { id: "b", type: "rectangle", x: 600, y: 0, width: 200, height: 80 },
        { id: "label", type: "text", x: 0, y: 0, text: "Plan", containerId: "a" },
        { id: "go", type: "arrow", x: 300, y: 40, start: "a", end: "b" },
      ],
    });
    apply(doc, {
      update: [
        {
          id: "label",
          expectedVersion: 1,
          text: "Plan the trip:\nflights, hotel, budget\nand who pays for the rental car",
        },
      ],
    });
    const scene = () => new Map(foldScene(doc).elements.map((element) => [element.id, element]));
    let elements = scene();
    expectInside(elements.get("label")!, elements.get("a")!, 5);
    expect(elements.get("a")).toMatchObject({ x: 0, y: 0, width: 300 });
    const go = elements.get("go")!;
    const startY = numberOf(go.y);
    expect(startY).toBeGreaterThan(0);
    expect(startY).toBeLessThan(numberOf(elements.get("a")!.height));
    expect(go).toMatchObject({ startBinding: { elementId: "a" }, endBinding: { elementId: "b" } });

    apply(doc, { update: [{ id: "a", expectedVersion: 2, width: 140 }] });
    elements = scene();
    expect(elements.get("a")).toMatchObject({ width: 140 });
    expectInside(elements.get("label")!, elements.get("a")!, 5);
  });

  it("keeps a resent label wrapped, wraps an arrow label to the drawn arrow, and keeps indents", () => {
    const doc = new Y.Doc();
    const long = "Send the signed receipts to the accountant before Friday";
    const list = "Steps:\n    import\n    review";
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "b", type: "rectangle", x: 300, y: 0 },
        { id: "label", type: "text", x: 0, y: 0, text: long, containerId: "a" },
        { id: "go", type: "arrow", x: 0, y: 0, start: "a", end: "b" },
        { id: "said", type: "text", x: 0, y: 0, text: long, containerId: "go" },
        { id: "c", type: "rectangle", x: 0, y: 300, width: 300 },
        { id: "steps", type: "text", x: 0, y: 0, text: list, containerId: "c" },
      ],
    });
    const scene = () => new Map(foldScene(doc).elements.map((element) => [element.id, element]));
    expect(scene().get("steps")).toMatchObject({ text: list });
    apply(doc, {
      add: [
        { id: "narrow", type: "rectangle", x: 0, y: 600, width: 90 },
        { id: "wide", type: "text", x: 0, y: 0, text: "    WWWW\n WWWW", containerId: "narrow" },
      ],
    });
    const wide = String(scene().get("wide")!.text).split("\n");
    expect(wide[0]).toMatch(/^ {4}W/u);
    expect(wide.find((line) => line.trim() === "")).toBeUndefined();
    expect(wide.filter((line) => line.startsWith(" W"))).toHaveLength(1);
    apply(doc, {
      add: [
        { id: "deep", type: "rectangle", x: 0, y: 800, width: 90 },
        { id: "indent", type: "text", x: 0, y: 0, text: "        WWWW", containerId: "deep" },
      ],
    });
    expectInside(scene().get("indent")!, scene().get("deep")!, 5);
    const arrowLabel = scene().get("said")!;
    expect(String(arrowLabel.text)).toContain("\n");
    expect(numberOf(arrowLabel.width)).toBeLessThanOrEqual(220);

    apply(doc, {
      update: [{ id: "label", expectedVersion: 1, text: long, strokeColor: "#e03131" }],
    });
    expectInside(scene().get("label")!, scene().get("a")!, 5);
  });

  it("aims an arrow bound at its start toward its height", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 200, height: 100 },
        { id: "go", type: "arrow", x: 200, y: 50, width: 100, height: 100, start: "a" },
      ],
    });
    expect(live(doc).find((element) => element.id === "go")).toMatchObject({
      x: 204,
      y: 102,
      width: 100,
      height: 100,
    });
  });

  it("lists a self-loop arrow once on its shape", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "go", type: "arrow", x: 0, y: 0, start: "a", end: "a" },
      ],
    });
    expect(live(doc).find((element) => element.id === "a")?.boundElements).toEqual([
      { id: "go", type: "arrow" },
    ]);
  });

  it("centers a label on an arrow that points back", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        {
          id: "go",
          type: "arrow",
          x: 400,
          y: 50,
          points: [
            [0, 0],
            [-200, 0],
          ],
        },
        { id: "label", type: "text", x: 0, y: 0, text: "back", containerId: "go" },
      ],
    });
    const label = foldScene(doc).elements.find((element) => element.id === "label")!;
    expect(label.x).toBe(300 - (label.width as number) / 2);
  });

  it("edits around a label whose shape is gone", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "label", type: "text", x: 0, y: 0, text: "Hi", containerId: "a" },
        { id: "b", type: "rectangle", x: 300, y: 0 },
      ],
    });
    const orphan = foldScene(doc).elements.find((element) => element.id === "a")!;
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    insertElementRevision(remote, { ...orphan, version: 2, isDeleted: true });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    apply(doc, { update: [{ id: "b", expectedVersion: 1, x: 600 }] });
    expect(live(doc).find((element) => element.id === "b")).toMatchObject({ x: 600 });
  });

  it("converges with a concurrent canvas edit to another element", () => {
    const owner = new Y.Doc();
    apply(owner, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "b", type: "rectangle", x: 300, y: 0 },
      ],
    });
    const canvas = new Y.Doc();
    Y.applyUpdate(canvas, Y.encodeStateAsUpdate(owner));
    apply(canvas, { update: [{ id: "b", expectedVersion: 1, x: 999 }] });
    apply(owner, { update: [{ id: "a", expectedVersion: 1, x: -50 }] });
    Y.applyUpdate(owner, Y.encodeStateAsUpdate(canvas));
    Y.applyUpdate(canvas, Y.encodeStateAsUpdate(owner));
    expect(live(owner)).toEqual(live(canvas));
    expect(live(owner).map(({ id, x }) => [id, x])).toEqual([
      ["a", -50],
      ["b", 999],
    ]);
  });

  it("deletes a shape and its label in either order, and refuses a second label or a missing frame", () => {
    const doc = new Y.Doc();
    apply(doc, {
      add: [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "label", type: "text", x: 0, y: 0, text: "Hi", containerId: "a" },
      ],
    });
    expect(
      planDrawingEdit(
        doc,
        { add: [{ type: "text", x: 0, y: 0, text: "Two", containerId: "a" }] },
        0,
      ),
    ).toEqual({ reason: expect.stringContaining("a already has label label") });
    expect(
      planDrawingEdit(doc, { update: [{ id: "a", expectedVersion: 1, frameId: "label" }] }, 0),
    ).toEqual({
      reason: "label is not a frame.",
    });
    apply(doc, {
      delete: [
        { id: "a", expectedVersion: 1 },
        { id: "label", expectedVersion: 1 },
      ],
    });
    expect(live(doc)).toEqual([]);
  });

  it("reads an element without a version as version 1, as the engine imports it", () => {
    expect(summarizeDrawing([{ id: "a", type: "rectangle", x: 0, y: 0 }], false)).toMatchObject([
      { id: "a", version: 1 },
    ]);
  });

  it("refuses text on a shape, points on a shape, and an unknown container", () => {
    const doc = new Y.Doc();
    for (const [edit, reason] of [
      [{ add: [{ type: "rectangle", x: 0, y: 0, text: "x" }] }, "Only a text element takes text"],
      [
        {
          add: [
            {
              type: "ellipse",
              x: 0,
              y: 0,
              points: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        "Only an arrow or line",
      ],
      [{ add: [{ type: "text", x: 0, y: 0, text: "x", containerId: "nope" }] }, "No element nope."],
    ] as const) {
      expect(planDrawingEdit(doc, edit as unknown as DrawingEdit, 0)).toEqual({
        reason: expect.stringContaining(reason),
      });
    }
  });
});

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function corners(element: Record<string, unknown>) {
  const [x, y] = [numberOf(element.x), numberOf(element.y)];
  const [width, height] = [numberOf(element.width), numberOf(element.height)];
  return { x, y, width, height, right: x + width, bottom: y + height };
}

function expectInside(
  text: Record<string, unknown>,
  shape: Record<string, unknown>,
  padding: number,
) {
  const [inner, outer] = [corners(text), corners(shape)];
  expect(inner.x).toBeGreaterThanOrEqual(outer.x + padding);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y + padding);
  expect(inner.right).toBeLessThanOrEqual(outer.right - padding);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom - padding);
}

function expectInsideEllipse(text: Record<string, unknown>, shape: Record<string, unknown>) {
  const [inner, outer] = [corners(text), corners(shape)];
  const [cx, cy] = [outer.x + outer.width / 2, outer.y + outer.height / 2];
  for (const [x, y] of [
    [inner.x, inner.y],
    [inner.right, inner.y],
    [inner.x, inner.bottom],
    [inner.right, inner.bottom],
  ] as const) {
    expect(((x - cx) / (outer.width / 2)) ** 2 + ((y - cy) / (outer.height / 2)) ** 2).toBeLessThan(
      1,
    );
  }
}
