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
const GAP = 4;
const LINE_HEIGHT = 1.25;
const LABEL_PADDING = 5;
const EXCALIFONT_EM_WIDTHS = new Map(
  (
    [
      ["'il", 0.25],
      [",.:;|!j", 0.33],
      [' "1()-r', 0.45],
      ["?[]f", 0.5],
      ["*+<=>IL^ceknpqsuvy{}", 0.55],
      ["47/HJVY\\`abghotxz", 0.6],
      ["35689CKNSXd", 0.65],
      ["02AFP_mw~$&ERU", 0.74],
      ["#%@BDGMOQTWZ", 0.93],
    ] as const
  ).flatMap(([chars, width]) => [...chars].map((char) => [char, width] as const)),
);
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
      version: numberOr(element.version) || 1,
      x: numberOr(element.x),
      y: numberOr(element.y),
      width: numberOr(element.width),
      height: numberOr(element.height),
    };
    if (numberOr(element.angle) !== 0) summary.angle = numberOr(element.angle);
    const text = typeof element.originalText === "string" ? element.originalText : element.text;
    if (typeof text === "string") summary.text = text;
    for (const key of ["strokeColor", "backgroundColor"] as const) {
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
  const existing = (id: string) => {
    const element = next.get(id) ?? current.get(id);
    return element && !element.isDeleted ? element : undefined;
  };
  const live = (id: string): ElementSnapshot => {
    const element = existing(id);
    if (!element) throw new DrawingEditRefusal(`No element ${id}.`);
    return element;
  };
  const frame = (id: string | null | undefined) => {
    if (id && live(id).type !== "frame") throw new DrawingEditRefusal(`${id} is not a frame.`);
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
  for (const change of edit.update ?? []) {
    frame(change.frameId);
    next.set(change.id, changed(live(change.id), change));
  }
  const deleting = new Set((edit.delete ?? []).map(({ id }) => id));
  const gone = (id: unknown) => typeof id === "string" && deleting.has(id);
  for (const id of deleting) next.set(id, { ...live(id), isDeleted: true });
  for (const id of deleting.size > 0 ? current.keys() : []) {
    const before = existing(id);
    if (!before) continue;
    const after: ElementSnapshot = { ...before };
    if (gone(after.containerId)) after.isDeleted = true;
    if (gone(after.frameId)) after.frameId = null;
    for (const key of ["startBinding", "endBinding"] as const) {
      if (gone((after[key] as JsonObject | null | undefined)?.elementId)) after[key] = null;
    }
    if (Array.isArray(after.boundElements))
      after.boundElements = after.boundElements.filter((bound) => !gone((bound as JsonObject).id));
    if (stableJson(after) !== stableJson(before)) next.set(id, after);
  }
  const fitLabels = (onArrows: boolean) => {
    for (const id of new Set([...current.keys(), ...next.keys()])) {
      const text = existing(id);
      if (text?.type !== "text" || typeof text.containerId !== "string") continue;
      const container = existing(text.containerId);
      if (!container || !CONTAINERS.has(container.type)) continue;
      if ((container.type === "arrow") !== onArrows) continue;
      const before = { text: current.get(text.id), container: current.get(container.id) };
      const retexted =
        before.text?.text !== text.text || before.text?.originalText !== text.originalText;
      const resized =
        before.container?.width !== container.width ||
        before.container?.height !== container.height;
      if (!retexted && !resized) continue;
      const label = fitLabel(text, container);
      next.set(text.id, label);
      const height = labelledHeight(container, numberOr(label.height));
      if (height > numberOr(container.height)) next.set(container.id, { ...container, height });
    }
  };
  fitLabels(false);
  const placing = new Set(
    (edit.update ?? [])
      .filter((change) => change.x !== undefined || change.y !== undefined || change.points)
      .map(({ id }) => id),
  );
  for (const id of current.keys()) {
    const arrow = existing(id);
    if (placing.has(id) || arrow?.type !== "arrow" || !Array.isArray(arrow.points)) continue;
    if (arrow.points.length < 2) continue;
    const ends = arrow.points as [number, number][];
    const last = ends.length - 1;
    const shift = (key: "startBinding" | "endBinding", [px, py]: [number, number]) => {
      const binding = arrow[key] as JsonObject | null | undefined;
      const target = binding?.elementId;
      const before = typeof target === "string" ? current.get(target) : undefined;
      const after = typeof target === "string" ? existing(target) : undefined;
      if (!before || !after) return [0, 0] as const;
      const change = (key: "x" | "y" | "width" | "height") =>
        numberOr(after[key]) - numberOr(before[key]);
      if (numberOr(arrow.angle) !== 0) return [change("x"), change("y")] as const;
      const grow = (size: "width" | "height") => {
        const span = numberOr(before[size]) + 2 * numberOr(binding?.gap);
        return span > 0 ? change(size) / span : 0;
      };
      const [cx, cy] = center(before);
      const [ox, oy] = [numberOr(arrow.x) + px - cx, numberOr(arrow.y) + py - cy];
      const [cos, sin] = [Math.cos(numberOr(after.angle)), Math.sin(numberOr(after.angle))];
      const u = (ox * cos + oy * sin) * grow("width");
      const v = (oy * cos - ox * sin) * grow("height");
      return [
        change("x") + change("width") / 2 + u * cos - v * sin,
        change("y") + change("height") / 2 + u * sin + v * cos,
      ] as const;
    };
    const [sx, sy] = shift("startBinding", ends[0]!);
    const [ex, ey] = shift("endBinding", ends[last]!);
    if (sx === 0 && sy === 0 && ex === 0 && ey === 0) continue;
    const points = ends.map(([x, y], index): [number, number] =>
      index === 0 ? [x, y] : index === last ? [x - sx + ex, y - sy + ey] : [x - sx, y - sy],
    );
    next.set(id, {
      ...arrow,
      x: numberOr(arrow.x) + sx,
      y: numberOr(arrow.y) + sy,
      points,
      ...pointBox(points),
    });
  }
  for (const { id, input } of added) {
    frame(input.frameId);
    link(next, live, existing, id, input);
  }
  fitLabels(true);
  for (const id of new Set([...current.keys(), ...next.keys()])) {
    const text = existing(id);
    if (text?.type !== "text" || typeof text.containerId !== "string") continue;
    const container = existing(text.containerId);
    if (!container || (!next.has(text.id) && !next.has(container.id))) continue;
    const [cx, cy] = center(container);
    next.set(text.id, {
      ...text,
      x: cx - numberOr(text.width) / 2,
      y: cy - numberOr(text.height) / 2,
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
      ...textSize(input.text, FONT_SIZE, LINE_HEIGHT),
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
    Object.assign(result, {
      originalText: change.text,
      ...textSize(
        change.text,
        numberOr(element.fontSize) || FONT_SIZE,
        numberOr(element.lineHeight) || LINE_HEIGHT,
      ),
    });
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
  existing: (id: string) => ElementSnapshot | undefined,
  id: string,
  input: DrawingElementInput,
): void {
  const bind = (targetId: string, type: string) => {
    const target = live(targetId);
    const bound = Array.isArray(target.boundElements) ? target.boundElements : [];
    if (bound.some((each) => (each as JsonObject).id === id)) return;
    next.set(targetId, { ...target, boundElements: [...bound, { id, type }] });
  };
  if (input.containerId) {
    const container = live(input.containerId);
    if (input.type !== "text" || !CONTAINERS.has(container.type))
      throw new DrawingEditRefusal(`${id} cannot sit inside ${input.containerId}.`);
    const label = (Array.isArray(container.boundElements) ? container.boundElements : []).find(
      (bound) =>
        (bound as JsonObject).type === "text" && existing(String((bound as JsonObject).id)),
    ) as JsonObject | undefined;
    if (label)
      throw new DrawingEditRefusal(
        `${input.containerId} already has label ${String(label.id)}: update its text instead.`,
      );
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
    next.set(id, { ...next.get(id)!, [key]: { elementId: targetId, focus: 0, gap: GAP } });
    bind(targetId, "arrow");
  }
  if (input.type !== "arrow" || input.points || !(input.start || input.end)) return;
  const start = input.start ? live(input.start) : undefined;
  const end = input.end ? live(input.end) : undefined;
  const from = start
    ? edge(
        start,
        end ? center(end) : [input.x + (input.width ?? 160), input.y + (input.height ?? 0)],
      )
    : ([input.x, input.y] as const);
  const to = end
    ? edge(end, from)
    : ([from[0] + (input.width ?? 160), from[1] + (input.height ?? 0)] as const);
  const points: [number, number][] = [
    [0, 0],
    [to[0] - from[0], to[1] - from[1]],
  ];
  next.set(id, { ...next.get(id)!, x: from[0], y: from[1], points, ...pointBox(points) });
}

function center(element: ElementSnapshot) {
  const points = Array.isArray(element.points) ? (element.points as [number, number][]) : [];
  const [left, top] =
    points.length > 0
      ? [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y))]
      : [0, 0];
  return [
    numberOr(element.x) + left + numberOr(element.width) / 2,
    numberOr(element.y) + top + numberOr(element.height) / 2,
  ] as const;
}

function edge(element: ElementSnapshot, toward: readonly [number, number]) {
  const [cx, cy] = center(element);
  const [dx, dy] = [toward[0] - cx, toward[1] - cy];
  const [cos, sin] = [Math.cos(numberOr(element.angle)), Math.sin(numberOr(element.angle))];
  const [u, v] = [dx * cos + dy * sin, dy * cos - dx * sin];
  const x = Math.abs(u) / (numberOr(element.width) / 2 + GAP);
  const y = Math.abs(v) / (numberOr(element.height) / 2 + GAP);
  const along =
    element.type === "ellipse"
      ? Math.hypot(x, y)
      : element.type === "diamond"
        ? x + y
        : Math.max(x, y);
  return along > 0 ? ([cx + dx / along, cy + dy / along] as const) : ([cx, cy] as const);
}

function fitLabel(text: ElementSnapshot, container: ElementSnapshot): ElementSnapshot {
  const fontSize = numberOr(text.fontSize) || FONT_SIZE;
  const lineHeight = numberOr(text.lineHeight) || LINE_HEIGHT;
  const width = numberOr(container.width);
  const room =
    container.type === "arrow"
      ? Math.max(0.7 * width, fontSize * 11)
      : container.type === "ellipse"
        ? Math.round((width / 2) * Math.SQRT2) - LABEL_PADDING * 2
        : container.type === "diamond"
          ? Math.round(width / 2) - LABEL_PADDING * 2
          : width - LABEL_PADDING * 2;
  const wrapped = wrapText(String(text.originalText ?? text.text ?? ""), room, fontSize);
  return { ...text, text: wrapped, ...textSize(wrapped, fontSize, lineHeight) };
}

function labelledHeight(container: ElementSnapshot, textHeight: number): number {
  const needed = Math.ceil(textHeight) + LABEL_PADDING * 2;
  if (container.type === "arrow") return 0;
  if (container.type === "ellipse") return Math.round((needed / Math.SQRT2) * 2);
  if (container.type === "diamond") return 2 * needed;
  return needed;
}

function wrapText(text: string, room: number, fontSize: number): string {
  const fits = (line: string) => lineWidth(line, fontSize) <= room;
  return text
    .split("\n")
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let line: string | undefined;
      for (const word of paragraph.split(" ")) {
        const joined = line === undefined ? word : `${line} ${word}`;
        if (fits(joined)) {
          line = joined;
          continue;
        }
        if (line?.trim()) lines.push(line);
        line = line?.trim() === "" ? `${line} ` : undefined;
        for (const char of word) {
          if (line !== undefined && !fits(line + char)) {
            if (line.trim()) lines.push(line);
            line = undefined;
          }
          line = (line ?? "") + char;
        }
      }
      return [...lines, line ?? ""];
    })
    .join("\n");
}

function textSize(text: string, fontSize: number, lineHeight: number) {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => lineWidth(line, fontSize))),
    height: lines.length * fontSize * lineHeight,
  };
}

function lineWidth(line: string, fontSize: number): number {
  let width = 0;
  for (const char of line) width += EXCALIFONT_EM_WIDTHS.get(char) ?? 1;
  return width * fontSize;
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
