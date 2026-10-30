import { useEffect, useId, useRef, useState } from "react";
import { prefersReducedMotion } from "../reducedMotion";
import { DEFAULT_FORCES, placeNodes, type GraphForces, type LayoutFrame, type LayoutRequest } from "./graphLayout";

export type GraphShape = "circle" | "ring" | "diamond" | "square" | "bubble" | "pill";

export type CanvasNode = {
  path: string;
  title: string;
  shape: GraphShape;
  degree: number;
};

export type GraphDisplay = { arrows: boolean; textFade: number; nodeSize: number; linkThickness: number };
export const DEFAULT_DISPLAY: GraphDisplay = { arrows: false, textFade: 0.5, nodeSize: 0.5, linkThickness: 0.5 };
export const GROUP_HUES = ["teal", "amber", "plum", "blue", "rust", "indigo", "rose"] as const;

type Model = {
  nodes: readonly CanvasNode[];
  links: readonly (readonly [number, number])[];
};

type Options = { display: GraphDisplay; forces: GraphForces; local: boolean };

type Palette = {
  bg: string;
  ink: string;
  node: string;
  edge: string;
  label: string;
  match: string;
  groups: string[];
  font: string;
  edgeAlpha: number;
};

const DIM = 0.12;
const LABEL_LIMIT = 600;
const LABEL_HEIGHT = 15;
// Labels claim space on a grid of cells this many pixels wide and high.
const CELL = 6;
const FADE_MS = 140;

function readPalette(surface: "bg" | "panel"): Palette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--dohc-${name}`).trim() || "#888";
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    bg: token(surface),
    ink: token("ink"),
    node: token(dark ? "muted" : "subtle"),
    edge: token("ink"),
    label: token("muted"),
    match: token("match"),
    groups: GROUP_HUES.map((hue) => token(`hue-${hue}`)),
    font: style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif",
    edgeAlpha: dark ? 0.2 : 0.16,
  };
}

function nodeRadius(degree: number, display: GraphDisplay): number {
  return (2.5 + Math.sqrt(degree) * 1.6) * (0.5 + display.nodeSize);
}

function shortTitle(title: string): string {
  return title.length > 32 ? `${title.slice(0, 31)}…` : title;
}

function addShape(ctx: CanvasRenderingContext2D, shape: GraphShape, x: number, y: number, r: number): void {
  switch (shape) {
    case "diamond": {
      const e = r * 1.25;
      ctx.moveTo(x, y - e);
      ctx.lineTo(x + e, y);
      ctx.lineTo(x, y + e);
      ctx.lineTo(x - e, y);
      ctx.closePath();
      return;
    }
    case "square": {
      const e = r * 1.1;
      ctx.moveTo(x + e, y);
      ctx.roundRect(x - e, y - e, e * 2, e * 2, e * 0.32);
      return;
    }
    case "pill": {
      const e = r * 0.7;
      ctx.moveTo(x + r, y);
      ctx.roundRect(x - r, y - e, r * 2, e * 2, e);
      return;
    }
    case "bubble":
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - 0.62 * r, y + 0.79 * r);
      ctx.lineTo(x - 0.95 * r, y + 1.1 * r);
      ctx.lineTo(x - 0.2 * r, y + 0.98 * r);
      ctx.closePath();
      return;
    default:
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

export type GraphRenderer = ReturnType<typeof createGraphRenderer>;

type Callbacks = {
  open(index: number): void;
  hover(index: number): void;
  settled(): void;
};

function sameForces(a: GraphForces, b: GraphForces): boolean {
  return a.center === b.center && a.repel === b.repel && a.link === b.link && a.distance === b.distance;
}

// Owns the canvas: camera, input and drawing. The layout runs in a worker; see
// LayoutRequest. React hands it a model and options; everything per frame stays
// out of React.
export function createGraphRenderer(canvas: HTMLCanvasElement, surface: "bg" | "panel", callbacks: Callbacks) {
  const ctx = canvas.getContext("2d");
  let palette = readPalette(surface);
  let model: Model = { nodes: [], links: [] };
  let active = -1;
  // Per node, an index into GROUP_HUES, or -1 when no group matches.
  let groups: Int16Array = new Int16Array(0);
  let options: Options = { display: DEFAULT_DISPLAY, forces: DEFAULT_FORCES, local: false };
  // The positions last drawn, as interleaved x, y, and the newest from the worker.
  let positions: Float32Array = new Float32Array(0);
  let incoming: LayoutFrame | null = null;
  let generation = 0;
  let layoutSettled = true;
  // With reduced motion, a new layout draws nothing until it has settled.
  let awaitingLayout = false;
  let source = new Uint32Array(0);
  let target = new Uint32Array(0);
  let radius = new Float64Array(0);
  // Measured label widths, 0 until a label is first drawn.
  let labelWidth = new Float32Array(0);
  // Each label's opacity; it eases to 1 when the label is shown and to 0 when hidden.
  let labelAlpha = new Float32Array(0);
  let lastDraw = 0;
  let taken = new Uint8Array(0);
  // How many nodes cover each label grid cell, so labels keep clear of dots.
  let dots = new Uint8Array(0);
  let placed = new Uint8Array(0);
  // Neighbours as compressed rows: node i's are adjacency[offsets[i]..offsets[i+1]].
  let offsets = new Uint32Array(1);
  let adjacency = new Uint32Array(0);
  const remembered = new Map<string, { x: number; y: number; label: number }>();

  let width = 0, height = 0, dpr = 1;
  let k = 1, tx = 0, ty = 0;
  let followLayout = true;
  // Set once the person pans, zooms or drags; the camera then stays theirs.
  let cameraMoved = false;
  let snapCamera = true;
  let visible = true;
  let frame: number | null = null;
  let reduced = prefersReducedMotion();

  let hover = -1;
  let focus = -1;
  let lit = -1;
  let litSet = new Uint8Array(0);
  let mix = 0;
  let mixFrom = 0, mixTo = 0, mixStart = 0;

  type Gesture =
    | { kind: "node"; index: number; pointerId: number; startX: number; startY: number; moved: boolean }
    | { kind: "pan"; pointerId: number; startX: number; startY: number; tx: number; ty: number };
  let gesture: Gesture | null = null;
  // Where a dragged node is held, in graph space.
  let held: { index: number; x: number; y: number } | null = null;

  // Without its worker the graph keeps the places it has.
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./graphLayout.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  function send(request: LayoutRequest, transfer: Transferable[] = []): void {
    worker?.postMessage(request, transfer);
  }
  if (worker) {
    worker.onmessage = ({ data }: MessageEvent<LayoutFrame>) => {
      if (data.generation !== generation) return;
      incoming = data;
      wake();
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      layoutSettled = true;
      awaitingLayout = false;
      wake();
    };
    send({ type: "reduced", reduced });
  }

  const px = (i: number) => positions[i * 2]!;
  const py = (i: number) => positions[i * 2 + 1]!;

  function remember(): void {
    for (let i = 0; i < model.nodes.length; i++) remembered.set(model.nodes[i]!.path, { x: px(i), y: py(i), label: labelAlpha[i]! });
  }

  function setModel(next: Model): void {
    remember();
    model = next;
    const count = next.nodes.length;
    radius = new Float64Array(count);
    labelWidth = new Float32Array(count);
    labelAlpha = Float32Array.from(next.nodes, (node) => remembered.get(node.path)?.label ?? 0);
    for (let i = 0; i < count; i++) radius[i] = nodeRadius(next.nodes[i]!.degree, options.display);
    const degree = new Uint32Array(count);
    source = new Uint32Array(next.links.length);
    target = new Uint32Array(next.links.length);
    next.links.forEach(([s, t], l) => {
      source[l] = s;
      target[l] = t;
      degree[s]!++;
      degree[t]!++;
    });
    offsets = new Uint32Array(count + 1);
    for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i]! + degree[i]!;
    adjacency = new Uint32Array(offsets[count]!);
    const fill = offsets.slice(0, count);
    for (const [s, t] of next.links) {
      adjacency[fill[s]!++] = t;
      adjacency[fill[t]!++] = s;
    }
    const seeded = new Set<number>();
    const placed = placeNodes(count, (i) => {
      const previous = remembered.get(next.nodes[i]!.path);
      if (previous) seeded.add(i);
      return previous;
    });
    // A new node with a known neighbour starts beside it, not at the disc's edge.
    if (seeded.size > 0) {
      for (let i = 0; i < count; i++) {
        if (seeded.has(i)) continue;
        for (let a = offsets[i]!; a < offsets[i + 1]!; a++) {
          const n = adjacency[a]!;
          if (!seeded.has(n)) continue;
          placed.x[i] = placed.x[n]! + ((i % 7) - 3) * 4;
          placed.y[i] = placed.y[n]! + ((i % 5) - 2) * 4;
          break;
        }
      }
    }
    positions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 2] = placed.x[i]!;
      positions[i * 2 + 1] = placed.y[i]!;
    }
    generation++;
    incoming = null;
    held = null;
    // A press on the old model must not open or drag a node of the new one.
    if (gesture) {
      if (canvas.hasPointerCapture?.(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
      gesture = null;
      canvas.style.cursor = "";
    }
    layoutSettled = !worker || count === 0;
    awaitingLayout = !layoutSettled && reduced;
    send(
      { type: "model", generation, x: placed.x, y: placed.y, source: source.slice(), target: target.slice(), alpha: placed.alpha },
      [placed.x.buffer, placed.y.buffer],
    );
    litSet = new Uint8Array(count);
    if (hover >= count) hover = -1;
    if (focus >= count) focus = -1;
    lit = -1;
    relight();
    // A layout that starts from scratch opens framed, without zooming in from
    // the last view. An empty graph keeps the camera, so clearing a search
    // with no matches returns to the person's view.
    const fresh = count > 0 && seeded.size === 0;
    if (fresh) cameraMoved = false;
    followLayout = !cameraMoved || options.local;
    if (fresh) snapCamera = true;
    canvas.dataset.nodeCount = String(count);
    canvas.dataset.linkCount = String(next.links.length);
    canvas.dataset.settled = "false";
    wake();
  }

  function unsettle(): void {
    if (!worker) return;
    layoutSettled = false;
    canvas.dataset.settled = "false";
  }

  function setActive(index: number): void {
    active = index;
    wake();
  }

  function setGroups(next: Int16Array): void {
    groups = next;
    wake();
  }

  function setOptions(next: Options): void {
    const sizeChanged = next.display.nodeSize !== options.display.nodeSize;
    const forcesChanged = !sameForces(next.forces, options.forces);
    options = next;
    if (sizeChanged) for (let i = 0; i < model.nodes.length; i++) radius[i] = nodeRadius(model.nodes[i]!.degree, next.display);
    if (forcesChanged) {
      send({ type: "forces", forces: next.forces });
      if (model.nodes.length > 0) unsettle();
    }
    wake();
  }

  function relight(): void {
    const next = hover >= 0 ? hover : focus;
    // A cleared light keeps its node until the fade out ends.
    if (next >= 0 && next !== lit) {
      litSet.fill(0);
      litSet[next] = 1;
      for (let a = offsets[next]!; a < offsets[next + 1]!; a++) litSet[adjacency[a]!] = 1;
      lit = next;
    }
    const target = next >= 0 ? 1 : 0;
    if (reduced) {
      mix = mixTo = target;
      if (target === 0) lit = -1;
    } else if (target !== mixTo) {
      mixFrom = mix;
      mixTo = target;
      mixStart = performance.now();
    }
    canvas.dataset.hovered = next >= 0 ? model.nodes[next]!.path : "";
    wake();
  }

  function fitTarget(): { k: number; tx: number; ty: number } {
    const count = model.nodes.length;
    if (count === 0 || width === 0 || height === 0) return { k: 1, tx: width / 2, ty: height / 2 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const r = radius[i]!;
      x0 = Math.min(x0, px(i) - r);
      x1 = Math.max(x1, px(i) + r);
      y0 = Math.min(y0, py(i) - r);
      y1 = Math.max(y1, py(i) + r);
    }
    const pad = options.local ? 32 : 48;
    const scale = Math.min((width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0));
    const nextK = Math.max(0.02, Math.min(options.local ? 2 : 1.6, scale));
    return { k: nextK, tx: width / 2 - ((x0 + x1) / 2) * nextK, ty: height / 2 - ((y0 + y1) / 2) * nextK };
  }

  function wake(): void {
    if (frame === null && visible) frame = requestAnimationFrame(step);
  }

  function step(now: number): void {
    frame = null;
    if (!visible) return;
    if (incoming) {
      // Hand the drawn buffer back; the worker fills it with the next tick.
      const drawn = positions;
      positions = incoming.positions;
      layoutSettled = incoming.settled;
      awaitingLayout = false;
      incoming = null;
      send({ type: "frame", generation, positions: drawn }, [drawn.buffer]);
      if (held) {
        positions[held.index * 2] = held.x;
        positions[held.index * 2 + 1] = held.y;
      }
    }
    let easing = false;
    if (followLayout && !awaitingLayout) {
      const goal = fitTarget();
      const ease = reduced || snapCamera ? 1 : 0.15;
      snapCamera = false;
      k += (goal.k - k) * ease;
      tx += (goal.tx - tx) * ease;
      ty += (goal.ty - ty) * ease;
      easing = Math.abs(goal.k - k) > k * 1e-3 || Math.abs(goal.tx - tx) > 0.5 || Math.abs(goal.ty - ty) > 0.5;
      if (!easing && layoutSettled) followLayout = options.local;
    }
    let fading = false;
    if (mix !== mixTo && !reduced) {
      const t = Math.min(1, (now - mixStart) / FADE_MS);
      mix = mixFrom + (mixTo - mixFrom) * t;
      fading = t < 1;
      if (!fading && mixTo === 0) lit = -1;
    }
    const labelsFading = !awaitingLayout && draw(now);
    if (fading || easing || labelsFading) {
      frame = requestAnimationFrame(step);
    } else if (layoutSettled && canvas.dataset.settled !== "true") {
      canvas.dataset.settled = "true";
      callbacks.settled();
    }
  }

  // Draws a frame and reports whether a label is still fading.
  function draw(now: number): boolean {
    const fadeStep = reduced ? 1 : Math.min(34, now - lastDraw) / FADE_MS;
    lastDraw = now;
    if (!ctx) return false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);
    const count = model.nodes.length;
    if (count === 0) return false;
    const { display } = options;
    const highlight = lit >= 0 && mix > 0;
    const rest = highlight ? 1 - (1 - DIM) * mix : 1;
    const sx = (i: number) => px(i) * k + tx;
    const sy = (i: number) => py(i) * k + ty;
    const minR = options.local ? 2.5 : 1.25;
    const screenR = (i: number) => Math.max(minR, radius[i]! * k);

    // Links: one batched stroke for the rest, one for the lit node's own.
    const lineWidth = Math.max(0.35, Math.min(2.4, (0.4 + display.linkThickness * 1.6) * Math.sqrt(Math.min(k, 2))));
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = palette.edge;
    ctx.globalAlpha = palette.edgeAlpha * rest;
    ctx.beginPath();
    for (let l = 0; l < source.length; l++) {
      const s = source[l]!, t = target[l]!;
      if (highlight && (s === lit || t === lit)) continue;
      const x1 = sx(s), y1 = sy(s), x2 = sx(t), y2 = sy(t);
      if ((x1 < 0 && x2 < 0) || (y1 < 0 && y2 < 0) || (x1 > width && x2 > width) || (y1 > height && y2 > height)) continue;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    if (highlight) {
      ctx.strokeStyle = palette.match;
      ctx.globalAlpha = palette.edgeAlpha + (0.75 - palette.edgeAlpha) * mix;
      ctx.lineWidth = lineWidth * (1 + 0.4 * mix);
      ctx.beginPath();
      for (let a = offsets[lit]!; a < offsets[lit + 1]!; a++) {
        const n = adjacency[a]!;
        ctx.moveTo(sx(lit), sy(lit));
        ctx.lineTo(sx(n), sy(n));
      }
      ctx.stroke();
    }
    if (display.arrows && k > 0.25) {
      ctx.fillStyle = palette.edge;
      ctx.globalAlpha = Math.min(0.55, palette.edgeAlpha * 2.5) * rest;
      ctx.beginPath();
      const size = Math.max(3, 5 * Math.min(k, 1.5));
      for (let l = 0; l < source.length; l++) {
        const s = source[l]!, t = target[l]!;
        const x2 = sx(t), y2 = sy(t);
        if (x2 < -20 || y2 < -20 || x2 > width + 20 || y2 > height + 20) continue;
        const dx = x2 - sx(s), dy = y2 - sy(s);
        const length = Math.hypot(dx, dy);
        const r = screenR(t);
        if (length < r + size * 2) continue;
        const ux = dx / length, uy = dy / length;
        const tipX = x2 - ux * (r + 1), tipY = y2 - uy * (r + 1);
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
        ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
        ctx.closePath();
      }
      ctx.fill();
    }

    // Nodes: batched by color, rings stroked over their paper fill.
    const visibleNode = (i: number) => {
      const r = screenR(i) * 1.3 + 2;
      const x = sx(i), y = sy(i);
      return x > -r && y > -r && x < width + r && y < height + r;
    };
    const fillPass = (color: string, alpha: number, include: (i: number) => boolean) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < count; i++) {
        if (!include(i) || !visibleNode(i)) continue;
        const shape = model.nodes[i]!.shape;
        addShape(ctx, shape === "ring" ? "circle" : shape, sx(i), sy(i), screenR(i));
        any = true;
      }
      if (any) ctx.fill();
    };
    const isLit = (i: number) => highlight && litSet[i] === 1;
    const group = (i: number) => (i < groups.length ? groups[i]! : -1);
    const plain = (i: number) => i !== active && group(i) < 0 && model.nodes[i]!.shape !== "ring";
    fillPass(palette.node, rest, (i) => plain(i) && !isLit(i));
    palette.groups.forEach((color, hue) => {
      fillPass(color, rest, (i) => i !== active && group(i) === hue && !isLit(i));
    });
    // Files that are not pages: a ring on the paper.
    fillPass(palette.bg, 1, (i) => model.nodes[i]!.shape === "ring" && group(i) < 0 && i !== active);
    ctx.strokeStyle = palette.node;
    ctx.globalAlpha = rest;
    ctx.lineWidth = Math.max(1, Math.min(2, 1.2 * Math.sqrt(k)));
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      if (model.nodes[i]!.shape !== "ring" || group(i) >= 0 || i === active || isLit(i) || !visibleNode(i)) continue;
      addShape(ctx, "circle", sx(i), sy(i), screenR(i));
    }
    ctx.stroke();
    if (highlight) {
      fillPass(palette.ink, 1, (i) => isLit(i) && i !== lit && i !== active && group(i) < 0);
      palette.groups.forEach((color, hue) => {
        fillPass(color, 1, (i) => isLit(i) && i !== lit && i !== active && group(i) === hue);
      });
    }
    if (active >= 0 && active < count) {
      const r = screenR(active);
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.ink;
      ctx.beginPath();
      addShape(ctx, model.nodes[active]!.shape === "ring" ? "circle" : model.nodes[active]!.shape, sx(active), sy(active), r);
      ctx.fill();
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx(active), sy(active), r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (highlight && lit !== active) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.match;
      ctx.beginPath();
      const shape = model.nodes[lit]!.shape;
      addShape(ctx, shape === "ring" ? "circle" : shape, sx(lit), sy(lit), screenR(lit) * (1 + 0.15 * mix));
      ctx.fill();
    }

    // A label shows once its node is big enough on screen, bigger nodes first,
    // and fades in or out over FADE_MS, so a still graph has no half-faded
    // labels. The lit node, the open page and the lit neighbours claim space
    // first; a label that would overlap a placed one or run off the canvas is
    // left out, and so is one that would cross another node's dot, unless it
    // is lit or the open page. A halo in the background colour keeps text
    // clear of links.
    const fadeAt = Math.pow(2, (display.textFade - 0.5) * 4) * (options.local ? 0.55 : 1.1);
    ctx.font = `12px ${palette.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.bg;
    const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
    if (taken.length < cols * rows) {
      taken = new Uint8Array(cols * rows);
      dots = new Uint8Array(cols * rows);
    } else {
      taken.fill(0, 0, cols * rows);
      dots.fill(0, 0, cols * rows);
    }
    // The grid cells a node's dot covers, out to a diamond's tips, the widest
    // shape, and the hovered node's larger dot.
    const dotR = (i: number) => 1.25 * screenR(i) * (highlight && i === lit ? 1 + 0.15 * mix : 1);
    const dotCol = (i: number, side: number) => Math.max(0, Math.min(cols - 1, Math.floor((sx(i) + side * dotR(i)) / CELL)));
    const dotRow = (i: number, side: number) => Math.max(0, Math.min(rows - 1, Math.floor((sy(i) + side * dotR(i)) / CELL)));
    for (let i = 0; i < count; i++) {
      if (!visibleNode(i)) continue;
      for (let r = dotRow(i, -1); r <= dotRow(i, 1); r++) {
        for (let c = dotCol(i, -1); c <= dotCol(i, 1); c++) if (dots[r * cols + c]! < 255) dots[r * cols + c]!++;
      }
    }
    placed = placed.length < count ? new Uint8Array(count) : placed.fill(0, 0, count);
    let drawn = 0;
    let labelsFading = false;
    const label = (i: number) => {
      if (placed[i]) return;
      placed[i] = 1;
      const own = highlight && litSet[i] === 1;
      const shown = (i === active && options.local) || k * Math.sqrt(radius[i]! / 4) >= fadeAt;
      let fits = (shown || own || labelAlpha[i]! > 0) && drawn < LABEL_LIMIT && visibleNode(i);
      let title = "", left = 0, top = 0, w = 0, c0 = 0, c1 = 0, r0 = 0, r1 = 0;
      if (fits) {
        title = shortTitle(model.nodes[i]!.title);
        w = labelWidth[i] || (labelWidth[i] = ctx.measureText(title).width);
        left = sx(i) - w / 2;
        top = sy(i) + screenR(i) + 3;
        fits = left >= 2 && top >= 0 && left + w <= width - 2 && top + LABEL_HEIGHT <= height;
        c0 = Math.floor(left / CELL);
        c1 = Math.floor((left + w) / CELL);
        r0 = Math.floor(top / CELL);
        r1 = Math.min(rows - 1, Math.floor((top + LABEL_HEIGHT) / CELL));
        // The label may touch its own node's dot, not another's.
        const a0 = dotCol(i, -1), a1 = dotCol(i, 1), b0 = dotRow(i, -1), b1 = dotRow(i, 1);
        const avoidDots = !own && i !== active;
        for (let r = r0; fits && r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const mine = r >= b0 && r <= b1 && c >= a0 && c <= a1 ? 1 : 0;
            if (taken[r * cols + c] || (avoidDots && dots[r * cols + c]! > mine)) fits = false;
          }
        }
      }
      if (!fits) {
        labelAlpha[i] = 0;
        return;
      }
      const goal = shown ? 1 : 0;
      let fade = labelAlpha[i]!;
      if (fade !== goal) {
        fade = goal > fade ? Math.min(goal, fade + fadeStep) : Math.max(goal, fade - fadeStep);
        labelAlpha[i] = fade;
        if (fade !== goal) labelsFading = true;
      }
      const alpha = own ? Math.max(fade * rest, mix) : fade * rest;
      if (alpha < 0.03) return;
      for (let r = r0; r <= r1; r++) taken.fill(1, r * cols + c0, r * cols + c1 + 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = own || i === active ? palette.ink : palette.label;
      ctx.strokeText(title, sx(i), top + 1);
      ctx.fillText(title, sx(i), top + 1);
      drawn++;
    };
    if (highlight) label(lit);
    if (active >= 0 && active < count) label(active);
    if (highlight) for (let a = offsets[lit]!; a < offsets[lit + 1]!; a++) label(adjacency[a]!);
    for (let i = 0; i < count; i++) label(i);
    ctx.globalAlpha = 1;
    return labelsFading;
  }

  function hitTest(x: number, y: number): number {
    let best = -1, bestDistance = Infinity;
    for (let i = 0; i < model.nodes.length; i++) {
      const dx = px(i) * k + tx - x, dy = py(i) * k + ty - y;
      const distance = Math.hypot(dx, dy);
      const reach = Math.max(options.local ? 2.5 : 1.25, radius[i]! * k) + 4;
      if (distance <= reach && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }

  function local(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function setHover(index: number): void {
    if (index === hover) return;
    hover = index;
    canvas.style.cursor = index >= 0 ? "pointer" : "";
    callbacks.hover(index);
    relight();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || gesture) return;
    const point = local(event);
    const index = hitTest(point.x, point.y);
    gesture = index >= 0
      ? { kind: "node", index, pointerId: event.pointerId, startX: point.x, startY: point.y, moved: false }
      : { kind: "pan", pointerId: event.pointerId, startX: point.x, startY: point.y, tx, ty };
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    const point = local(event);
    if (!gesture) {
      setHover(hitTest(point.x, point.y));
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    const moved = Math.abs(point.x - gesture.startX) > 3 || Math.abs(point.y - gesture.startY) > 3;
    if (gesture.kind === "pan") {
      if (!moved && tx === gesture.tx && ty === gesture.ty) return;
      followLayout = false;
      cameraMoved = true;
      tx = gesture.tx + point.x - gesture.startX;
      ty = gesture.ty + point.y - gesture.startY;
      canvas.style.cursor = "grabbing";
      wake();
      return;
    }
    if (!gesture.moved && !moved) return;
    gesture.moved = true;
    // The camera holds still under a dragged node.
    followLayout = false;
    cameraMoved = true;
    const i = gesture.index;
    canvas.style.cursor = "grabbing";
    held = { index: i, x: (point.x - tx) / k, y: (point.y - ty) / k };
    positions[i * 2] = held.x;
    positions[i * 2 + 1] = held.y;
    send({ type: "pin", ...held });
    if (!reduced) unsettle();
    wake();
  }

  function onPointerUp(event: PointerEvent, cancelled = false): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const ended = gesture;
    gesture = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = hover >= 0 ? "pointer" : "";
    if (ended.kind === "pan") return;
    if (ended.moved) {
      held = null;
      send({ type: "release", index: ended.index });
      followLayout = options.local;
      wake();
      return;
    }
    if (!cancelled) callbacks.open(ended.index);
  }

  function zoomAt(x: number, y: number, factor: number): void {
    const next = Math.max(0.02, Math.min(8, k * factor));
    tx = x - ((x - tx) * next) / k;
    ty = y - ((y - ty) * next) / k;
    k = next;
    followLayout = false;
    cameraMoved = true;
    wake();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const point = local(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomAt(point.x, point.y, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)));
  }

  const onLeave = () => { if (!gesture) setHover(-1); };
  const onUp = (event: PointerEvent) => onPointerUp(event);
  const onCancel = (event: PointerEvent) => onPointerUp(event, true);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  function resize(nextWidth: number, nextHeight: number): void {
    dpr = window.devicePixelRatio || 1;
    if (nextWidth === width && nextHeight === height && canvas.width === Math.round(nextWidth * dpr)) return;
    // Keep the same world point under the canvas centre.
    tx += (nextWidth - width) / 2;
    ty += (nextHeight - height) / 2;
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    wake();
  }

  function setVisible(next: boolean): void {
    if (next !== visible) send({ type: "visible", visible: next });
    visible = next;
    if (!next && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    } else if (next) {
      wake();
    }
  }

  return {
    setModel,
    setActive,
    setGroups,
    setOptions,
    resize,
    setVisible,
    setFocus(index: number) {
      focus = index;
      relight();
      if (index < 0) return;
      // Bring a focused node into view.
      const x = px(index) * k + tx, y = py(index) * k + ty;
      if (x < 24 || y < 24 || x > width - 24 || y > height - 24) {
        tx += width / 2 - x;
        ty += height / 2 - y;
        followLayout = false;
      }
      wake();
    },
    // The neighbour that best continues in a direction, for arrow keys.
    neighbourToward(index: number, dx: number, dy: number): number {
      let best = -1, bestScore = -Infinity;
      for (let a = offsets[index]!; a < offsets[index + 1]!; a++) {
        const n = adjacency[a]!;
        const vx = px(n) - px(index), vy = py(n) - py(index);
        const length = Math.hypot(vx, vy) || 1;
        const along = (vx * dx + vy * dy) / length;
        if (along <= 0.2) continue;
        const score = along - length / 4000;
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      return best;
    },
    zoomBy(factor: number) {
      zoomAt(width / 2, height / 2, factor);
    },
    fit() {
      followLayout = true;
      cameraMoved = false;
      wake();
    },
    retheme() {
      palette = readPalette(surface);
      labelWidth.fill(0);
      const nextReduced = prefersReducedMotion();
      if (nextReduced !== reduced) send({ type: "reduced", reduced: nextReduced });
      reduced = nextReduced;
      wake();
    },
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      worker?.terminate();
      worker = null;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}

export function GraphCanvas(props: {
  nodes: readonly CanvasNode[];
  links: readonly (readonly [number, number])[];
  groups: Int16Array;
  activeIndex: number;
  activePath: string | null;
  focusIndex: number;
  display: GraphDisplay;
  forces: GraphForces;
  surface: "bg" | "panel";
  local: boolean;
  label: string;
  className: string;
  onOpen: (index: number) => void;
  onFocusChange: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [hovered, setHovered] = useState(-1);
  const describedId = useId();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createGraphRenderer(canvas, props.surface, {
      open: (index) => callbacks.current.onOpen(index),
      hover: setHovered,
      settled: () => undefined,
    });
    rendererRef.current = renderer;
    const sizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
    });
    sizeObserver?.observe(canvas);
    let onScreen = true;
    const sync = () => renderer.setVisible(onScreen && document.visibilityState !== "hidden");
    // Offscreen, as in a hidden tab or a collapsed panel, the graph draws nothing.
    const viewObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      sync();
    });
    viewObserver?.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    const themeObserver = new MutationObserver(() => renderer.retheme());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-system-reduced-motion"] });
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const retheme = () => renderer.retheme();
    motion?.addEventListener?.("change", retheme);
    return () => {
      sizeObserver?.disconnect();
      viewObserver?.disconnect();
      themeObserver.disconnect();
      motion?.removeEventListener?.("change", retheme);
      document.removeEventListener("visibilitychange", sync);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [props.surface]);

  useEffect(() => {
    rendererRef.current?.setModel({ nodes: props.nodes, links: props.links });
  }, [props.nodes, props.links]);

  useEffect(() => {
    rendererRef.current?.setActive(props.activeIndex);
  }, [props.activeIndex]);

  useEffect(() => {
    rendererRef.current?.setGroups(props.groups);
  }, [props.groups]);

  useEffect(() => {
    rendererRef.current?.setOptions({ display: props.display, forces: props.forces, local: props.local });
  }, [props.display, props.forces, props.local]);

  useEffect(() => {
    rendererRef.current?.setFocus(props.focusIndex);
  }, [props.focusIndex]);

  const described = props.focusIndex >= 0 ? props.focusIndex : hovered;
  const describedNode = described >= 0 ? props.nodes[described] : undefined;

  function onKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const directions: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      const from = props.focusIndex >= 0 ? props.focusIndex : props.activeIndex;
      if (from < 0) {
        // Start at the most-linked node: the list is sorted by links.
        if (props.nodes.length) props.onFocusChange(mostLinked(props.nodes));
        return;
      }
      const next = renderer.neighbourToward(from, direction[0], direction[1]);
      if (next >= 0) props.onFocusChange(next);
      else if (props.focusIndex < 0) props.onFocusChange(from);
      return;
    }
    if (event.key === "Enter" && props.focusIndex >= 0) {
      event.preventDefault();
      props.onOpen(props.focusIndex);
    } else if (event.key === "Escape" && props.focusIndex >= 0) {
      event.preventDefault();
      props.onFocusChange(-1);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      renderer.zoomBy(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      renderer.zoomBy(0.8);
    } else if (event.key === "0") {
      event.preventDefault();
      renderer.fit();
    }
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="graph-canvas"
        data-active-path={props.activePath ?? undefined}
        tabIndex={0}
        role="application"
        aria-roledescription="graph"
        aria-label={props.label}
        aria-describedby={describedNode ? describedId : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => props.focusIndex >= 0 && props.onFocusChange(-1)}
        className={`block touch-none select-none ${props.className}`}
      />
      <p id={describedId} data-testid="graph-focused-node" aria-live="polite" className="sr-only">
        {describedNode
          ? `${describedNode.title}, ${describedNode.degree.toLocaleString()} link${describedNode.degree === 1 ? "" : "s"}`
          : ""}
      </p>
    </>
  );
}

function mostLinked(nodes: readonly CanvasNode[]): number {
  let best = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i]!.degree > nodes[best]!.degree) best = i;
  return best;
}
