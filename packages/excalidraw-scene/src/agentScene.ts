import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import type {
  DrawingEdit,
  DrawingElementChange,
  DrawingElementInput,
  DrawingElementSummary,
} from "@dohc/workspace-contracts/drawing";
import {
  type ElementSnapshot,
  type JsonObject,
  type JsonValue,
  foldScene,
  insertElementRevision,
  stableJson,
} from "./index";

export const EMPTY_EXCALIDRAW_DOCUMENT = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "dohc",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  },
  null,
  2,
);

const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
const CONTAINERS = new Set(["rectangle", "ellipse", "diamond", "arrow"]);
const LINEAR = new Set(["arrow", "line", "freedraw"]);

export interface PlannedDrawingEdit {
  update: Uint8Array | null;
  written: ElementSnapshot[];
}

export function summarizeDrawing(
  elements: readonly unknown[],
  points: boolean,
): DrawingElementSummary[] {
  return elements.flatMap((element) => {
    if (!isObject(element) || element.isDeleted === true) return [];
    if (typeof element.id !== "string" || typeof element.type !== "string") return [];
    const summary: DrawingElementSummary = {
      id: element.id,
      type: element.type,
      version: numberOr(element.version),
      x: numberOr(element.x),
      y: numberOr(element.y),
      width: numberOr(element.width),
      height: numberOr(element.height),
    };
    if (numberOr(element.angle) !== 0) summary.angle = numberOr(element.angle);
    for (const key of ["text", "strokeColor", "backgroundColor"] as const) {
      if (typeof element[key] === "string") summary[key] = element[key];
    }
    for (const key of ["link", "frameId", "containerId"] as const) {
      if (typeof element[key] === "string") summary[key] = element[key];
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = element[key];
      if (isObject(binding) && typeof binding.elementId === "string")
        summary[key] = { elementId: binding.elementId };
    }
    const groupIds = strings(element.groupIds);
    if (groupIds.length > 0) summary.groupIds = groupIds;
    const bound = Array.isArray(element.boundElements)
      ? element.boundElements.filter(
          (item): item is { id: string; type: string } =>
            isObject(item) && typeof item.id === "string" && typeof item.type === "string",
        )
      : [];
    if (bound.length > 0) summary.boundElements = bound.map(({ id, type }) => ({ id, type }));
    if (Array.isArray(element.points) && LINEAR.has(element.type)) {
      if (points) summary.points = element.points as number[][];
      else summary.pointCount = element.points.length;
    }
    return [summary];
  });
}

export function planDrawingEdit(
  doc: Y.Doc,
  edit: DrawingEdit,
  now: number,
): PlannedDrawingEdit | { reason: string } {
  try {
    return planned(doc, edit, now);
  } catch (error) {
    if (error instanceof DrawingEditRefusal) return { reason: error.message };
    throw error;
  }
}

class DrawingEditRefusal extends Error {}

function planned(doc: Y.Doc, edit: DrawingEdit, now: number): PlannedDrawingEdit {
  const scene = foldScene(doc).elements;
  const current = new Map(scene.map((element) => [element.id, element]));
  const next = new Map<string, ElementSnapshot>();
  const latest = (element: ElementSnapshot) => next.get(element.id) ?? element;
  const live = (id: string): ElementSnapshot => {
    const element = next.get(id) ?? current.get(id);
    if (!element || element.isDeleted) throw new DrawingEditRefusal(`No element ${id}.`);
    return element;
  };
  const named = new Set<string>();
  for (const change of [...(edit.update ?? []), ...(edit.delete ?? [])]) {
    if (named.has(change.id)) throw new DrawingEditRefusal(`${change.id} is named twice.`);
    named.add(change.id);
    const element = live(change.id);
    if (element.version !== change.expectedVersion) {
      throw new DrawingEditRefusal(
        `${change.id} is at version ${element.version}, not ${change.expectedVersion}: someone changed it, so nothing changed. Read the drawing again.`,
      );
    }
  }
  let lastIndex = scene.findLast((element) => typeof element.index === "string")?.index ?? null;
  const added = (edit.add ?? []).map((input) => {
    const id = input.id ?? crypto.randomUUID();
    if (current.has(id) || next.has(id)) throw new DrawingEditRefusal(`${id} already exists.`);
    lastIndex = generateKeyBetween(lastIndex, null);
    next.set(id, created(id, input, lastIndex, now));
    return { id, input };
  });
  for (const change of edit.update ?? []) next.set(change.id, changed(live(change.id), change));
  for (const { id } of edit.delete ?? []) {
    next.set(id, { ...live(id), isDeleted: true });
    for (const element of current.values()) {
      const before = latest(element);
      if (before.isDeleted) continue;
      const after: ElementSnapshot = { ...before };
      if (after.containerId === id) after.isDeleted = true;
      if (after.frameId === id) after.frameId = null;
      for (const key of ["startBinding", "endBinding"] as const) {
        if ((after[key] as JsonObject | null | undefined)?.elementId === id) after[key] = null;
      }
      if (Array.isArray(after.boundElements))
        after.boundElements = after.boundElements.filter(
          (bound) => (bound as JsonObject).id !== id,
        );
      if (stableJson(after) !== stableJson(before)) next.set(element.id, after);
    }
  }
  for (const { id, input } of added) link(next, live, id, input);
  for (const element of [...current.values(), ...next.values()]) {
    const text = latest(element);
    if (text.type !== "text" || typeof text.containerId !== "string" || text.isDeleted) continue;
    const container = live(text.containerId);
    if (!next.has(text.id) && !next.has(container.id)) continue;
    next.set(text.id, {
      ...text,
      x: numberOr(container.x) + (numberOr(container.width) - numberOr(text.width)) / 2,
      y: numberOr(container.y) + (numberOr(container.height) - numberOr(text.height)) / 2,
    });
  }
  const written = [...next.values()].map((element) => ({
    ...element,
    version: (current.get(element.id)?.version ?? 0) + 1,
    versionNonce: randomInteger(),
    updated: now,
  }));
  if (written.length === 0) return { update: null, written };
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(scratch);
  for (const element of written) insertElementRevision(scratch, element);
  return { update: Y.encodeStateAsUpdate(scratch, before), written };
}

function created(id: string, input: DrawingElementInput, index: string, now: number) {
  const { start: _start, end: _end, containerId, ...fields } = input;
  const element: ElementSnapshot = {
    id,
    type: input.type,
    x: input.x,
    y: input.y,
    width: 160,
    height: input.type === "frame" ? 300 : 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness:
      input.type === "rectangle" ? { type: 3 } : input.type === "diamond" ? { type: 2 } : null,
    seed: randomInteger(),
    version: 0,
    versionNonce: 0,
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    ...withoutUndefined(fields),
  };
  if (input.type === "frame") Object.assign(element, { name: null });
  if (input.type === "text") {
    if (!input.text) throw new DrawingEditRefusal("A text element needs text.");
    Object.assign(element, {
      fontSize: FONT_SIZE,
      fontFamily: 5,
      text: input.text,
      originalText: input.text,
      textAlign: containerId ? "center" : "left",
      verticalAlign: containerId ? "middle" : "top",
      containerId: containerId ?? null,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
      ...textSize(input.text),
    });
  } else if (input.text !== undefined) {
    throw new DrawingEditRefusal(
      `Only a text element takes text: add one with containerId ${id} to label it.`,
    );
  }
  if (input.type === "arrow" || input.type === "line") {
    const points = input.points ?? [
      [0, 0],
      [input.width ?? 160, input.height ?? 0],
    ];
    Object.assign(element, {
      points,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: input.type === "arrow" ? "arrow" : null,
      ...pointBox(points),
    });
    if (input.type === "arrow") element.elbowed = false;
  } else if (input.points || input.start || input.end) {
    throw new DrawingEditRefusal(`Only an arrow or line takes points, start, or end.`);
  }
  return element;
}

function changed(element: ElementSnapshot, change: DrawingElementChange): ElementSnapshot {
  const { id: _id, expectedVersion: _version, ...fields } = change;
  const result: ElementSnapshot = { ...element, ...withoutUndefined(fields) };
  if (change.text !== undefined) {
    if (element.type !== "text") throw new DrawingEditRefusal(`${element.id} is not text.`);
    Object.assign(result, { originalText: change.text, ...textSize(change.text) });
  }
  if (change.points !== undefined) {
    if (!LINEAR.has(element.type)) throw new DrawingEditRefusal(`${element.id} has no points.`);
    Object.assign(result, pointBox(change.points));
  }
  return result;
}

function link(
  next: Map<string, ElementSnapshot>,
  live: (id: string) => ElementSnapshot,
  id: string,
  input: DrawingElementInput,
): void {
  const bind = (targetId: string, type: string) => {
    const target = live(targetId);
    const bound = Array.isArray(target.boundElements) ? target.boundElements : [];
    next.set(targetId, { ...target, boundElements: [...bound, { id, type }] });
  };
  if (input.containerId) {
    if (input.type !== "text" || !CONTAINERS.has(live(input.containerId).type))
      throw new DrawingEditRefusal(`${id} cannot sit inside ${input.containerId}.`);
    bind(input.containerId, "text");
  }
  for (const [key, targetId] of [
    ["startBinding", input.start],
    ["endBinding", input.end],
  ] as const) {
    if (!targetId) continue;
    if (input.type !== "arrow")
      throw new DrawingEditRefusal(`Only an arrow binds its ends: ${id} is a ${input.type}.`);
    if (LINEAR.has(live(targetId).type))
      throw new DrawingEditRefusal(`${id} cannot bind to ${targetId}.`);
    next.set(id, { ...next.get(id)!, [key]: { elementId: targetId, focus: 0, gap: 4 } });
    bind(targetId, "arrow");
  }
  if (input.frameId && live(input.frameId).type !== "frame")
    throw new DrawingEditRefusal(`${input.frameId} is not a frame.`);
}

function textSize(text: string) {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => line.length)) * FONT_SIZE * 0.6,
    height: lines.length * FONT_SIZE * LINE_HEIGHT,
  };
}

function pointBox(points: readonly (readonly [number, number])[]) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function withoutUndefined(fields: object): JsonObject {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Record<string, JsonValue>;
}

function randomInteger(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
