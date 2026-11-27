import { useEffect, useId, useRef } from "react";
import { cutText } from "@dohc/workspace-contracts/names";
import { prefersReducedMotion } from "../reducedMotion";
import {
  DEFAULT_FORCES,
  placeNodes,
  type GraphForces,
  type LayoutFrame,
  type LayoutRequest,
} from "./graphLayout";
import * as visuals from "./graphVisuals";

export type GraphShape =
  | "circle"
  | "ring"
  | "diamond"
  | "square"
  | "bubble"
  | "pill"
  | "hexagon"
  | "triangle";
export const LINK_STYLE = { prose: 0, structural: 1, pending: 2, mention: 3 } as const;
export type GraphLink = readonly [source: number, target: number, style?: number];
const LINK_DASH: readonly (readonly number[])[] = [[], [], [5, 4], [1.5, 3]];

export type ApprovalSurge = { nonce: number; edges: readonly (readonly [string, string])[] };

export type CanvasNode = {
  path: string;
  title: string;
  // The kind's name, spoken because the shape only shows it.
  kind: string;
  shape: GraphShape;
  degree: number;
  structural?: boolean;
  paused?: boolean;
};

export function nodeAnnouncement(node: CanvasNode): string {
  return `${node.title}, ${node.kind}, ${node.degree.toLocaleString()} link${node.degree === 1 ? "" : "s"}`;
}

export type GraphDisplay = {
  arrows: boolean;
  textFade: number;
  nodeSize: number;
  linkThickness: number;
};
export const DEFAULT_DISPLAY: GraphDisplay = {
  arrows: true,
  textFade: 0.5,
  nodeSize: 0.5,
  linkThickness: 0.5,
};
export const GROUP_HUES = ["teal", "amber", "plum", "blue", "rust", "indigo", "rose"] as const;

type Model = {
  nodes: readonly CanvasNode[];
  links: readonly GraphLink[];
};

type Options = { display: GraphDisplay; forces: GraphForces; local: boolean };
type Camera = { k: number; tx: number; ty: number };

type Palette = {
  bg: string;
  ink: string;
  node: string;
  edge: string;
  label: string;
  match: string;
  warning: string;
  line: string;
  dark: boolean;
  groups: string[];
  glowSprites: (HTMLCanvasElement | null)[];
  font: string;
  edgeAlpha: number;
  nodeDim: number;
  labelDim: number;
};

// While a node is emphasised, the other nodes stay clickable, so they dim only
// as far as every node colour keeps 3:1 and every label 4.5:1 on both
// surfaces (GraphCanvas.test.ts). Links aren't targets, so they dim further.
export const NODE_TOKEN = { light: "subtle", dark: "muted" } as const;
export const NODE_DIM = { light: 0.88, dark: 0.56 } as const;
export const LABEL_DIM = { light: 0.88, dark: 0.75 } as const;
const LINK_DIM = 0.12;

// A label's opacity, given its zoom fade and how far another node is
// emphasised. While one is, a label still fading shows not at all, so a
// dimmed label is either at LABEL_DIM or hidden, never below 4.5:1.
export function labelOpacity(fade: number, emphasis: number, dim: number, own: boolean): number {
  const rest = 1 - (1 - dim) * emphasis;
  if (own) return Math.max(fade * rest, emphasis);
  return emphasis > 0 && fade < 1 ? 0 : fade * rest;
}
const LABEL_LIMIT = 600;
// Above this many links on screen, links draw as hairlines (under a device pixel).
const DENSE_LINKS = 1000;
const HAIRLINE = 0.99;
const LABEL_HEIGHT = 15;
// Labels claim space on a grid of cells this many pixels wide and high.
const CELL = 6;
const FADE_MS = 140;

// Reads the tokens where the canvas is, not at the document's root: the
// website's demo sets them inside a shadow root.
function readPalette(canvas: HTMLCanvasElement, surface: "bg" | "panel"): Palette {
  const style = getComputedStyle(canvas);
  const token = (name: string) => style.getPropertyValue(`--dohc-${name}`).trim() || "#888";
  const themed = canvas.closest<HTMLElement>("[data-theme]") ?? document.documentElement;
  const theme = themed.dataset.theme === "dark" ? "dark" : "light";
  const groups = GROUP_HUES.map((hue) => token(`hue-${hue}`));
  return {
    bg: token(surface),
    ink: token("ink"),
    node: token(NODE_TOKEN[theme]),
    edge: token("ink"),
    label: token("muted"),
    match: token("match"),
    warning: token("warning"),
    line: token("line"),
    dark: theme === "dark",
    groups,
    glowSprites: visuals.createGlowSprites(groups),
    font: style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif",
    edgeAlpha: theme === "dark" ? 0.2 : 0.16,
    nodeDim: NODE_DIM[theme],
    labelDim: LABEL_DIM[theme],
  };
}

// Frames a graph's bounds in a view with a 16 px margin. A node never draws
// larger than at 100% zoom, so a small graph doesn't blow up to fill the view.
export function fitCamera(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
): Camera {
  const margin = 16;
  const scale = Math.min(
    (width - margin * 2) / Math.max(1, x1 - x0),
    (height - margin * 2) / Math.max(1, y1 - y0),
  );
  const k = Math.max(0.02, Math.min(1, scale));
  return { k, tx: width / 2 - ((x0 + x1) / 2) * k, ty: height / 2 - ((y0 + y1) / 2) * k };
}

// Moves the camera one frame toward the fit, 15% of the way. While the layout
// cools, a fit that zooms out is taken at once, so the spreading graph never
// leaves the view.
export function followCamera(camera: Camera, goal: Camera, cooling: boolean): Camera {
  if (cooling && goal.k < camera.k) return goal;
  const ease = 0.15;
  return {
    k: camera.k + (goal.k - camera.k) * ease,
    tx: camera.tx + (goal.tx - camera.tx) * ease,
    ty: camera.ty + (goal.ty - camera.ty) * ease,
  };
}

function nodeRadius(degree: number, display: GraphDisplay): number {
  return (2.5 + Math.sqrt(degree) * 1.6) * (0.5 + display.nodeSize);
}

export function shortTitle(title: string): string {
  return cutText(title, 32);
}

function addShape(
  ctx: CanvasRenderingContext2D,
  shape: GraphShape,
  x: number,
  y: number,
  r: number,
): void {
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
    case "hexagon":
    case "triangle": {
      const sides = shape === "hexagon" ? 6 : 3,
        e = r * (shape === "hexagon" ? 1.15 : 1.35);
      for (let side = 0; side < sides; side++) {
        const angle = -Math.PI / 2 + (side * Math.PI * 2) / sides;
        ctx[side ? "lineTo" : "moveTo"](x + e * Math.cos(angle), y + e * Math.sin(angle));
      }
      ctx.closePath();
      return;
    }
    case "pill": {
      const e = r * 0.7;
      ctx.moveTo(x + r, y);
      ctx.roundRect(x - r, y - e, r * 2, e * 2, e);
      return;
    }
    case "bubble":
      ctx.moveTo(x - 0.62 * r, y + 0.79 * r);
      ctx.lineTo(x - 0.95 * r, y + 1.1 * r);
      ctx.lineTo(x - 0.2 * r, y + 0.98 * r);
      ctx.arc(x, y, r, Math.atan2(0.98, -0.2), Math.atan2(0.79, -0.62), true);
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
  settled(): void;
};

function sameForces(a: GraphForces, b: GraphForces): boolean {
  return (
    a.center === b.center && a.repel === b.repel && a.link === b.link && a.distance === b.distance
  );
}

// Owns the canvas: camera, input and drawing. The layout runs in a worker; see
// LayoutRequest. React hands it a model and options; everything per frame stays
// out of React.
export function createGraphRenderer(
  canvas: HTMLCanvasElement,
  surface: "bg" | "panel",
  callbacks: Callbacks,
) {
  const ctx = canvas.getContext("2d");
  let palette = readPalette(canvas, surface);
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
  let source = new Uint32Array(0);
  let target = new Uint32Array(0);
  let style = new Uint8Array(0);
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
  let hasPending = new Uint8Array(0);
  let pathIndex = new Map<string, number>();
  let useGlow = false,
    useCurved = false;
  let glowLayer: visuals.GlowLayer | null = null;
  const remembered = new Map<string, { x: number; y: number; label: number }>();

  let width = 0,
    height = 0,
    dpr = 1;
  let k = 1,
    tx = 0,
    ty = 0;
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
  let mixFrom = 0,
    mixTo = 0,
    mixStart = 0;
  let hoverFlowActive = false,
    hoverFlowStart = -1,
    surgeStart = -1,
    lastSurgeNonce = -1;
  let litPath: string | null = null;
  let hoverFlowEdges = new Set<number>();
  let surgeEdges: readonly (readonly [string, string])[] = [];

  type Gesture =
    | {
        kind: "node";
        index: number;
        pointerId: number;
        startX: number;
        startY: number;
        moved: boolean;
      }
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
      wake();
    };
    send({ type: "reduced", reduced });
  }

  const px = (i: number) => positions[i * 2]!;
  const py = (i: number) => positions[i * 2 + 1]!;

  function remember(): void {
    for (let i = 0; i < model.nodes.length; i++)
      remembered.set(model.nodes[i]!.path, { x: px(i), y: py(i), label: labelAlpha[i]! });
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
    style = new Uint8Array(next.links.length);
    hasPending = new Uint8Array(count);
    pathIndex = new Map(next.nodes.map((node, i) => [node.path, i]));
    useGlow = next.nodes.filter((node) => node.structural).length <= visuals.MAX_GLOW_STRUCTURAL;
    let curved = 0;
    next.links.forEach(([s, t, kind = LINK_STYLE.prose], l) => {
      source[l] = s;
      target[l] = t;
      style[l] = kind;
      if (kind === LINK_STYLE.pending) hasPending[s] = 1;
      if (kind === LINK_STYLE.structural || kind === LINK_STYLE.pending) curved++;
      degree[s]!++;
      degree[t]!++;
    });
    useCurved = curved <= visuals.MAX_CURVED_LINKS;
    if (count === 0) surgeEdges = [];
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
      if (canvas.hasPointerCapture?.(gesture.pointerId))
        canvas.releasePointerCapture(gesture.pointerId);
      gesture = null;
      canvas.style.cursor = "";
    }
    layoutSettled = !worker || count === 0;
    send(
      {
        type: "model",
        generation,
        x: placed.x,
        y: placed.y,
        source: source.slice(),
        target: target.slice(),
        alpha: placed.alpha,
      },
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
    if (sizeChanged)
      for (let i = 0; i < model.nodes.length; i++)
        radius[i] = nodeRadius(model.nodes[i]!.degree, next.display);
    if (forcesChanged) {
      send({ type: "forces", forces: next.forces });
      if (model.nodes.length > 0) unsettle();
    }
    wake();
  }

  function setApprovalSurge(surge: ApprovalSurge | null): void {
    if (!surge) {
      surgeEdges = [];
      surgeStart = -1;
      return;
    }
    if (surge.nonce === lastSurgeNonce) return;
    lastSurgeNonce = surge.nonce;
    if (reduced || !visible || !ctx || !surge.edges.length) return;
    surgeEdges = surge.edges;
    surgeStart = -1;
    wake();
  }

  const collectHoverEdges = (nodeIndex: number) => {
    const edges = new Set<number>();
    for (let l = 0; l < source.length && edges.size < 24; l++) {
      const s = source[l]!,
        t = target[l]!;
      if (s !== nodeIndex && t !== nodeIndex) continue;
      if (
        style[l] === LINK_STYLE.pending ||
        (style[l] === LINK_STYLE.structural && !model.nodes[s]?.paused && !model.nodes[t]?.paused)
      )
        edges.add(l);
    }
    return edges;
  };

  function relight(): void {
    const next = hover >= 0 ? hover : focus;
    if (next < 0) {
      litPath = null;
      hoverFlowActive = false;
      hoverFlowStart = -1;
      hoverFlowEdges = new Set();
    } else if (next !== lit || litPath === null) {
      const nextPath = model.nodes[next]!.path;
      const sameNode = nextPath === litPath;
      litSet.fill(0);
      litSet[next] = 1;
      for (let a = offsets[next]!; a < offsets[next + 1]!; a++) litSet[adjacency[a]!] = 1;
      lit = next;
      litPath = nextPath;
      hoverFlowEdges = collectHoverEdges(next);
      const hasMotion =
        !reduced && ctx !== null && (hasPending[next] === 1 || hoverFlowEdges.size > 0);
      if (!sameNode) {
        hoverFlowActive = hasMotion;
        hoverFlowStart = -1;
      } else if (!hasMotion) {
        hoverFlowActive = false;
        hoverFlowStart = -1;
      }
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

  function fitTarget(): Camera {
    const count = model.nodes.length;
    if (count === 0 || width === 0 || height === 0) return { k: 1, tx: width / 2, ty: height / 2 };
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const r = radius[i]!;
      x0 = Math.min(x0, px(i) - r);
      x1 = Math.max(x1, px(i) + r);
      y0 = Math.min(y0, py(i) - r);
      y1 = Math.max(y1, py(i) + r);
    }
    return fitCamera(x0, y0, x1, y1, width, height);
  }

  function wake(): void {
    if (frame === null && visible) frame = requestAnimationFrame(step);
  }

  function step(now: number): void {
    frame = null;
    if (!visible) return;
    if (incoming && !(reduced && held)) {
      // Hand the drawn buffer back; the worker fills it with the next tick.
      const drawn = positions;
      positions = incoming.positions;
      layoutSettled = incoming.settled;
      incoming = null;
      send({ type: "frame", generation, positions: drawn }, [drawn.buffer]);
      if (held) {
        positions[held.index * 2] = held.x;
        positions[held.index * 2 + 1] = held.y;
      }
    }
    let easing = false;
    if (followLayout) {
      const goal = fitTarget();
      ({ k, tx, ty } =
        reduced || snapCamera ? goal : followCamera({ k, tx, ty }, goal, !layoutSettled && !held));
      snapCamera = false;
      easing =
        Math.abs(goal.k - k) > k * 1e-3 ||
        Math.abs(goal.tx - tx) > 0.5 ||
        Math.abs(goal.ty - ty) > 0.5;
      if (!easing && layoutSettled) followLayout = options.local;
    }
    let fading = false;
    if (mix !== mixTo && !reduced) {
      const t = Math.min(1, (now - mixStart) / FADE_MS);
      mix = mixFrom + (mixTo - mixFrom) * t;
      fading = t < 1;
      if (!fading && mixTo === 0) lit = -1;
    }
    const advance = (active: boolean, start: number, ms: number): [number, number] => {
      if (!active || reduced || !ctx) return [-1, -1];
      const s = start < 0 ? now : start;
      const elapsed = Math.max(0, now - s);
      return elapsed >= ms ? [-1, -1] : [s, elapsed / ms];
    };
    let hoverProgress = -1,
      surgeProgress = -1;
    [hoverFlowStart, hoverProgress] = advance(
      hoverFlowActive && lit >= 0,
      hoverFlowStart,
      visuals.HOVER_FLOW_MS,
    );
    if (hoverProgress < 0) hoverFlowActive = false;
    [surgeStart, surgeProgress] = advance(
      surgeEdges.length > 0,
      surgeStart,
      visuals.APPROVAL_SURGE_MS,
    );
    if (surgeProgress < 0) surgeEdges = [];
    const labelsFading = draw(now, hoverProgress, surgeProgress);
    const coreDone = !fading && !easing && !labelsFading;
    if (coreDone && layoutSettled && !incoming && canvas.dataset.settled !== "true") {
      canvas.dataset.settled = "true";
      callbacks.settled();
    }
    if (!coreDone || hoverFlowActive || surgeEdges.length > 0) frame = requestAnimationFrame(step);
  }

  // Draws a frame and reports whether a label is still fading.
  function draw(now: number, hoverProgress: number, surgeProgress: number): boolean {
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
    const dimmed = (floor: number) => (highlight ? 1 - (1 - floor) * mix : 1);
    const rest = dimmed(palette.nodeDim);
    const linkRest = dimmed(LINK_DIM);
    const sx = (i: number) => px(i) * k + tx;
    const sy = (i: number) => py(i) * k + ty;
    const minR = options.local ? 2.5 : 1.25;
    const screenR = (i: number) => Math.max(minR, radius[i]! * k);
    const group = (i: number) => (i < groups.length ? groups[i]! : -1);
    const outerR = (i: number) =>
      visuals.outerRadius(model.nodes[i]!.shape, screenR(i)) *
      (highlight && i === lit && i !== active ? 1 + 0.15 * mix : 1);
    const ringR = (i: number) =>
      outerR(i) + (i === active ? (hasPending[i] ? 6.5 : 4) : hasPending[i] ? 3.5 : 0);

    if (useGlow && mix < 1 && (glowLayer = visuals.ensureGlowLayer(glowLayer, width, height))) {
      const mode = palette.dark ? "screen" : "source-over";
      glowLayer.ctx.globalCompositeOperation = mode;
      let anyGlow = false;
      for (let i = 0; i < count; i++) {
        const sprite =
          model.nodes[i]!.structural && group(i) >= 0 ? palette.glowSprites[group(i)] : null;
        if (!sprite) continue;
        const gr = visuals.GLOW_RADIUS_FACTOR * screenR(i),
          x = sx(i),
          y = sy(i);
        if (x < -gr || y < -gr || x > width + gr || y > height + gr) continue;
        glowLayer.ctx.drawImage(sprite, (x - gr) / 2, (y - gr) / 2, gr, gr);
        anyGlow = true;
      }
      if (anyGlow) {
        ctx.save();
        ctx.globalCompositeOperation = mode;
        ctx.globalAlpha =
          (palette.dark ? visuals.REST_GLOW.dark : visuals.REST_GLOW.light) * (1 - mix);
        ctx.drawImage(glowLayer.canvas, 0, 0, width, height);
        ctx.restore();
      }
    }

    // Links: one batched stroke for the rest, one for the lit node's own.
    // Many links wider than a device pixel stall the GPU for hundreds of
    // milliseconds a frame, so a dense stroke stays a hairline.
    const lineWidth = Math.max(
      0.35,
      Math.min(2.4, (0.4 + display.linkThickness * 1.6) * Math.sqrt(Math.min(k, 2))),
    );
    const strokeWidth = (links: number, wide: number) =>
      links > DENSE_LINKS ? Math.min(wide, HAIRLINE / dpr) : wide;
    const linkColor = (s: number, edgeStyle: number, fallback: string) =>
      edgeStyle === LINK_STYLE.pending
        ? palette.warning
        : group(s) >= 0
          ? palette.groups[group(s)]!
          : fallback;
    const drawCurved = (litOnly: boolean) => {
      for (let l = 0; l < source.length; l++) {
        const edgeStyle = style[l]!,
          s = source[l]!,
          t = target[l]!;
        if (!visuals.isCurvedEdge(useCurved, edgeStyle)) continue;
        if ((highlight && (s === lit || t === lit)) !== litOnly) continue;
        const x1 = sx(s),
          y1 = sy(s),
          x2 = sx(t),
          y2 = sy(t);
        const [cx, cy] = visuals.quadControl(x1, y1, x2, y2);
        if (
          !litOnly &&
          (Math.max(x1, x2, cx) < 0 ||
            Math.max(y1, y2, cy) < 0 ||
            Math.min(x1, x2, cx) > width ||
            Math.min(y1, y2, cy) > height)
        )
          continue;
        const stroke = () => {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.quadraticCurveTo(cx, cy, x2, y2);
          ctx.stroke();
        };
        ctx.strokeStyle = linkColor(s, edgeStyle, litOnly ? palette.match : palette.edge);
        if (litOnly) {
          const litW = lineWidth * (1 + 0.4 * mix);
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
          ctx.globalAlpha = 0.2 * mix;
          ctx.lineWidth = litW * 2.5;
          stroke();
          ctx.setLineDash(LINK_DASH[edgeStyle]!);
          ctx.lineDashOffset =
            edgeStyle === LINK_STYLE.pending && hoverProgress >= 0 && hoverFlowEdges.has(l)
              ? -hoverProgress * 36
              : 0;
          ctx.globalAlpha = palette.edgeAlpha + (0.9 - palette.edgeAlpha) * mix;
          ctx.lineWidth = litW;
          stroke();
        } else {
          ctx.setLineDash(LINK_DASH[edgeStyle]!);
          ctx.globalAlpha =
            palette.edgeAlpha * linkRest * (edgeStyle === LINK_STYLE.pending ? 2.4 : 2.2);
          ctx.lineWidth = lineWidth;
          stroke();
        }
      }
      ctx.lineDashOffset = 0;
    };
    for (let pass = 0; pass < LINK_DASH.length; pass++) {
      if (visuals.isCurvedEdge(useCurved, pass)) continue;
      ctx.strokeStyle = pass === LINK_STYLE.pending ? palette.warning : palette.edge;
      ctx.globalAlpha =
        palette.edgeAlpha *
        linkRest *
        (pass === LINK_STYLE.prose || pass === LINK_STYLE.mention ? 1 : 1.8);
      ctx.setLineDash(LINK_DASH[pass]!);
      ctx.beginPath();
      let shown = 0;
      for (let l = 0; l < source.length; l++) {
        const s = source[l]!,
          t = target[l]!;
        if (style[l] !== pass || (highlight && (s === lit || t === lit))) continue;
        const x1 = sx(s),
          y1 = sy(s),
          x2 = sx(t),
          y2 = sy(t);
        if (
          (x1 < 0 && x2 < 0) ||
          (y1 < 0 && y2 < 0) ||
          (x1 > width && x2 > width) ||
          (y1 > height && y2 > height)
        )
          continue;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        shown++;
      }
      ctx.lineWidth = strokeWidth(shown, lineWidth);
      ctx.stroke();
    }
    if (useCurved) drawCurved(false);
    if (highlight) {
      ctx.globalAlpha = palette.edgeAlpha + (0.75 - palette.edgeAlpha) * mix;
      ctx.lineWidth = strokeWidth(offsets[lit + 1]! - offsets[lit]!, lineWidth * (1 + 0.4 * mix));
      for (let pass = 0; pass < LINK_DASH.length; pass++) {
        if (visuals.isCurvedEdge(useCurved, pass)) continue;
        ctx.strokeStyle = pass === LINK_STYLE.pending ? palette.warning : palette.match;
        ctx.setLineDash(LINK_DASH[pass]!);
        const splitPending = pass === LINK_STYLE.pending && hoverProgress >= 0;
        for (const animated of splitPending ? [false, true] : [false]) {
          ctx.lineDashOffset = animated ? -hoverProgress * 36 : 0;
          ctx.beginPath();
          for (let l = 0; l < source.length; l++) {
            const s = source[l]!,
              t = target[l]!;
            if (style[l] !== pass || (s !== lit && t !== lit)) continue;
            if (splitPending && hoverFlowEdges.has(l) !== animated) continue;
            ctx.moveTo(sx(s), sy(s));
            ctx.lineTo(sx(t), sy(t));
          }
          ctx.stroke();
        }
      }
      ctx.lineDashOffset = 0;
      if (useCurved) drawCurved(true);
    }
    ctx.setLineDash([]);
    if (display.arrows && k > 0.25) {
      const size = Math.max(3, 5 * Math.min(k, 1.5));
      ctx.fillStyle = palette.edge;
      ctx.globalAlpha = Math.min(0.55, palette.edgeAlpha * 2.5) * linkRest;
      ctx.beginPath();
      for (let l = 0; l < source.length; l++) {
        if (visuals.isCurvedEdge(useCurved, style[l]!)) continue;
        const s = source[l]!,
          t = target[l]!;
        const x2 = sx(t),
          y2 = sy(t);
        if (x2 < -20 || y2 < -20 || x2 > width + 20 || y2 > height + 20) continue;
        const dx = x2 - sx(s),
          dy = y2 - sy(s);
        const length = Math.hypot(dx, dy);
        const r = outerR(t);
        if (length < r + size * 2) continue;
        const ux = dx / length,
          uy = dy / length;
        visuals.drawArrowhead(ctx, [x2 - ux * (r + 1), y2 - uy * (r + 1), ux, uy], size);
      }
      ctx.fill();
      if (useCurved) {
        for (let l = 0; l < source.length; l++) {
          const edgeStyle = style[l]!,
            s = source[l]!,
            t = target[l]!;
          if (!visuals.isCurvedEdge(useCurved, edgeStyle)) continue;
          const x1 = sx(s),
            y1 = sy(s),
            x2 = sx(t),
            y2 = sy(t),
            r = outerR(t);
          const dist = Math.hypot(x2 - x1, y2 - y1);
          if (x2 < -20 || y2 < -20 || x2 > width + 20 || y2 > height + 20 || dist < r + size * 2)
            continue;
          ctx.fillStyle = linkColor(s, edgeStyle, palette.edge);
          ctx.globalAlpha =
            highlight && (s === lit || t === lit)
              ? 0.9
              : Math.min(0.65, palette.edgeAlpha * 2.8) * linkRest;
          ctx.beginPath();
          visuals.drawArrowhead(
            ctx,
            visuals.quadAt([x1, y1, x2, y2], Math.max(0.15, 1 - (r + 2) / dist)),
            size,
          );
          ctx.fill();
        }
      }
    }
    if (hoverProgress >= 0 && lit >= 0) {
      for (const l of hoverFlowEdges) {
        if (style[l] !== LINK_STYLE.structural) continue;
        const s = source[l]!,
          t = target[l]!;
        const color = linkColor(s, LINK_STYLE.structural, palette.match);
        visuals.drawComet(ctx, [sx(s), sy(s), sx(t), sy(t)], hoverProgress, {
          curved: useCurved,
          color,
          head: palette.dark ? palette.ink : color,
        });
      }
    }
    if (surgeProgress >= 0 && surgeEdges.length > 0) {
      const rippleMax = 26 * Math.min(1.5, Math.max(0.6, k));
      for (const [srcPath, dstPath] of surgeEdges) {
        const s = pathIndex.get(srcPath),
          t = pathIndex.get(dstPath);
        if (s === undefined || t === undefined) continue;
        const color = linkColor(s, LINK_STYLE.structural, palette.match);
        visuals.drawComet(ctx, [sx(s), sy(s), sx(t), sy(t)], surgeProgress, {
          curved: useCurved,
          color,
          head: palette.dark ? palette.ink : color,
        });
        const p0 = surgeProgress / 0.75,
          p1 = (surgeProgress - 0.25) / 0.75;
        visuals.drawRipple(ctx, sx(s), sy(s), outerR(s), rippleMax, p0, color);
        const dstColor = group(t) >= 0 ? palette.groups[group(t)]! : color;
        visuals.drawRipple(ctx, sx(t), sy(t), outerR(t), rippleMax, p1, dstColor);
      }
    }

    const visibleNode = (i: number) => {
      const r = screenR(i) * 1.3 + 2;
      const x = sx(i),
        y = sy(i);
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
    const plain = (i: number) => i !== active && group(i) < 0 && model.nodes[i]!.shape !== "ring";
    fillPass(palette.node, rest, (i) => plain(i) && !isLit(i));
    const ring = (i: number) => model.nodes[i]!.shape === "ring";
    palette.groups.forEach((color, hue) => {
      fillPass(color, rest, (i) => i !== active && group(i) === hue && !isLit(i) && !ring(i));
    });
    fillPass(palette.bg, 1, (i) => ring(i) && i !== active && !isLit(i));
    ctx.globalAlpha = rest;
    ctx.lineWidth = Math.max(1, Math.min(2, 1.2 * Math.sqrt(k)));
    const strokeRings = (color: string, include: (i: number) => boolean) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        if (!ring(i) || !include(i) || i === active || isLit(i) || !visibleNode(i)) continue;
        addShape(ctx, "circle", sx(i), sy(i), screenR(i));
      }
      ctx.stroke();
    };
    strokeRings(palette.node, (i) => group(i) < 0);
    palette.groups.forEach((color, hue) => strokeRings(color, (i) => group(i) === hue));
    if (highlight) {
      fillPass(palette.ink, 1, (i) => isLit(i) && i !== lit && i !== active && group(i) < 0);
      palette.groups.forEach((color, hue) => {
        fillPass(color, 1, (i) => isLit(i) && i !== lit && i !== active && group(i) === hue);
      });
    }
    if (active >= 0 && active < count) {
      const r = screenR(active);
      ctx.globalAlpha = 1;
      ctx.fillStyle = group(active) >= 0 ? palette.groups[group(active)]! : palette.ink;
      ctx.beginPath();
      addShape(
        ctx,
        model.nodes[active]!.shape === "ring" ? "circle" : model.nodes[active]!.shape,
        sx(active),
        sy(active),
        r,
      );
      ctx.fill();
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(
        sx(active),
        sy(active),
        outerR(active) + (hasPending[active] ? 6.5 : 4),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    if (highlight && lit !== active) {
      ctx.globalAlpha = 1;
      const coloredStructural = model.nodes[lit]!.structural && group(lit) >= 0;
      ctx.fillStyle = coloredStructural ? palette.groups[group(lit)]! : palette.match;
      ctx.beginPath();
      const shape = model.nodes[lit]!.shape;
      addShape(
        ctx,
        shape === "ring" ? "circle" : shape,
        sx(lit),
        sy(lit),
        screenR(lit) * (1 + 0.15 * mix),
      );
      ctx.fill();
      if (coloredStructural) {
        ctx.strokeStyle = palette.ink;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }
    ctx.strokeStyle = palette.warning;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    for (let i = 0; i < count; i++) {
      if (!hasPending[i] || !visibleNode(i)) continue;
      ctx.globalAlpha = isLit(i) || i === active ? 1 : rest;
      ctx.lineDashOffset = hoverProgress >= 0 && i === lit ? -hoverProgress * 24 : 0;
      ctx.beginPath();
      ctx.arc(sx(i), sy(i), outerR(i) + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineDashOffset = 0;
    ctx.setLineDash([]);

    const fadeAt = Math.pow(2, (display.textFade - 0.5) * 4) * (options.local ? 0.55 : 1.1);
    ctx.font = `12px ${palette.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.bg;
    const cols = Math.ceil(width / CELL),
      rows = Math.ceil(height / CELL);
    if (taken.length < cols * rows) {
      taken = new Uint8Array(cols * rows);
      dots = new Uint8Array(cols * rows);
    } else {
      taken.fill(0, 0, cols * rows);
      dots.fill(0, 0, cols * rows);
    }
    // The grid cells a node's dot covers, out to a diamond's tips, the widest
    // shape, and the hovered node's larger dot.
    const dotR = (i: number) =>
      Math.max(1.25 * screenR(i) * (highlight && i === lit ? 1 + 0.15 * mix : 1), ringR(i) + 1);
    const dotCol = (i: number, side: number) =>
      Math.max(0, Math.min(cols - 1, Math.floor((sx(i) + side * dotR(i)) / CELL)));
    const dotRow = (i: number, side: number) =>
      Math.max(0, Math.min(rows - 1, Math.floor((sy(i) + side * dotR(i)) / CELL)));
    for (let i = 0; i < count; i++) {
      if (!visibleNode(i)) continue;
      for (let r = dotRow(i, -1); r <= dotRow(i, 1); r++) {
        for (let c = dotCol(i, -1); c <= dotCol(i, 1); c++)
          if (dots[r * cols + c]! < 255) dots[r * cols + c]!++;
      }
    }
    placed = placed.length < count ? new Uint8Array(count) : placed.fill(0, 0, count);
    let drawn = 0;
    let labelsFading = false;
    const label = (i: number) => {
      if (placed[i]) return;
      placed[i] = 1;
      const own = highlight && litSet[i] === 1;
      const isPill = highlight && i === lit;
      const shown = (i === active && options.local) || k * Math.sqrt(radius[i]! / 4) >= fadeAt;
      let fits = (shown || own || labelAlpha[i]! > 0) && drawn < LABEL_LIMIT && visibleNode(i);
      let title = "",
        left = 0,
        top = 0,
        w = 0,
        boxW = 0,
        c0 = 0,
        c1 = 0,
        r0 = 0,
        r1 = 0;
      if (fits) {
        title = shortTitle(model.nodes[i]!.title);
        w = labelWidth[i] || (labelWidth[i] = ctx.measureText(title).width);
        const pillPad = isPill ? 4 : 0;
        const vPad = isPill ? 1 : 0;
        left = sx(i) - w / 2 - pillPad;
        boxW = w + pillPad * 2;
        const a0 = dotCol(i, -1),
          a1 = dotCol(i, 1),
          b0 = dotRow(i, -1),
          b1 = dotRow(i, 1);
        const avoidDots = isPill || (!own && i !== active);
        const tryTop = (candidate: number) => {
          if (
            left < 2 ||
            candidate < vPad ||
            left + boxW > width - 2 ||
            candidate + LABEL_HEIGHT + vPad > height
          )
            return false;
          c0 = Math.floor(left / CELL);
          c1 = Math.floor((left + boxW) / CELL);
          r0 = Math.max(0, Math.floor((candidate - vPad) / CELL));
          r1 = Math.min(rows - 1, Math.floor((candidate + LABEL_HEIGHT + vPad) / CELL));
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              const mine = r >= b0 && r <= b1 && c >= a0 && c <= a1 ? 1 : 0;
              if (taken[r * cols + c] || (avoidDots && dots[r * cols + c]! > mine)) return false;
            }
          }
          top = candidate;
          return true;
        };
        const below =
          sy(i) + (i === lit || i === active || hasPending[i] ? ringR(i) : screenR(i)) + 3;
        fits = tryTop(below) || (isPill && tryTop(sy(i) - ringR(i) - LABEL_HEIGHT - 3));
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
      const alpha = labelOpacity(fade, highlight ? mix : 0, palette.labelDim, own);
      if (alpha < 0.03) return;
      for (let r = r0; r <= r1; r++) taken.fill(1, r * cols + c0, r * cols + c1 + 1);
      ctx.globalAlpha = alpha;
      if (isPill) {
        ctx.fillStyle = palette.bg;
        ctx.beginPath();
        ctx.roundRect(left, top - 1, boxW, LABEL_HEIGHT + 2, 5);
        ctx.fill();
        ctx.strokeStyle = palette.line;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = palette.bg;
        ctx.fillStyle = palette.ink;
        ctx.fillText(title, sx(i), top + 1);
      } else {
        ctx.fillStyle = own || i === active ? palette.ink : palette.label;
        ctx.strokeText(title, sx(i), top + 1);
        ctx.fillText(title, sx(i), top + 1);
      }
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
    let best = -1,
      bestDistance = Infinity;
    for (let i = 0; i < model.nodes.length; i++) {
      const dx = px(i) * k + tx - x,
        dy = py(i) * k + ty - y;
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
    relight();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || gesture) return;
    const point = local(event);
    const index = hitTest(point.x, point.y);
    gesture =
      index >= 0
        ? {
            kind: "node",
            index,
            pointerId: event.pointerId,
            startX: point.x,
            startY: point.y,
            moved: false,
          }
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
      // A picture that waited for the drag keeps the node where it was dropped.
      if (reduced && incoming && held) {
        incoming.positions[held.index * 2] = held.x;
        incoming.positions[held.index * 2 + 1] = held.y;
      }
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

  const onLeave = () => {
    if (!gesture) setHover(-1);
  };
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
    if (
      nextWidth === width &&
      nextHeight === height &&
      canvas.width === Math.round(nextWidth * dpr)
    )
      return;
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
    setApprovalSurge,
    resize,
    setVisible,
    setFocus(index: number) {
      focus = index;
      relight();
      if (index < 0) return;
      // Bring a focused node into view.
      const x = px(index) * k + tx,
        y = py(index) * k + ty;
      if (x < 24 || y < 24 || x > width - 24 || y > height - 24) {
        tx += width / 2 - x;
        ty += height / 2 - y;
        followLayout = false;
      }
      wake();
    },
    // The neighbour that best continues in a direction, for arrow keys.
    neighbourToward(index: number, dx: number, dy: number): number {
      let best = -1,
        bestScore = -Infinity;
      for (let a = offsets[index]!; a < offsets[index + 1]!; a++) {
        const n = adjacency[a]!;
        const vx = px(n) - px(index),
          vy = py(n) - py(index);
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
      palette = readPalette(canvas, surface);
      labelWidth.fill(0);
      const nextReduced = prefersReducedMotion();
      if (nextReduced !== reduced) send({ type: "reduced", reduced: nextReduced });
      reduced = nextReduced;
      wake();
    },
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      glowLayer = null;
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
  links: readonly GraphLink[];
  groups: Int16Array;
  activeIndex: number;
  activePath: string | null;
  focusIndex: number;
  // Lit like focus while nothing has keyboard focus, but never spoken.
  pointIndex: number;
  display: GraphDisplay;
  forces: GraphForces;
  approvalSurge?: ApprovalSurge | null;
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
  const describedId = useId();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createGraphRenderer(canvas, props.surface, {
      open: (index) => callbacks.current.onOpen(index),
      settled: () => undefined,
    });
    rendererRef.current = renderer;
    // Size now, so the first frame draws the graph instead of waiting for the observer.
    const rect = canvas.getBoundingClientRect();
    renderer.resize(rect.width, rect.height);
    const sizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
          });
    sizeObserver?.observe(canvas);
    let onScreen = true;
    const sync = () => renderer.setVisible(onScreen && document.visibilityState !== "hidden");
    // Offscreen, as in a hidden tab or a collapsed panel, the graph draws nothing.
    const viewObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            onScreen = entry?.isIntersecting ?? true;
            sync();
          });
    viewObserver?.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    const themeObserver = new MutationObserver(() => renderer.retheme());
    const themed = canvas.closest("[data-theme]") ?? document.documentElement;
    for (const element of new Set([themed, document.documentElement])) {
      themeObserver.observe(element, {
        attributes: true,
        attributeFilter: ["data-theme", "data-system-reduced-motion"],
      });
    }
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
    rendererRef.current?.setApprovalSurge(props.approvalSurge ?? null);
  }, [props.approvalSurge]);

  useEffect(() => {
    rendererRef.current?.setActive(props.activeIndex);
  }, [props.activeIndex]);

  useEffect(() => {
    rendererRef.current?.setGroups(props.groups);
  }, [props.groups]);

  useEffect(() => {
    rendererRef.current?.setOptions({
      display: props.display,
      forces: props.forces,
      local: props.local,
    });
  }, [props.display, props.forces, props.local]);

  useEffect(() => {
    rendererRef.current?.setFocus(props.focusIndex >= 0 ? props.focusIndex : props.pointIndex);
  }, [props.focusIndex, props.pointIndex]);

  // Only keyboard focus speaks. Hover lights the node and says nothing.
  const describedNode = props.focusIndex >= 0 ? props.nodes[props.focusIndex] : undefined;

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
        {describedNode ? nodeAnnouncement(describedNode) : ""}
      </p>
    </>
  );
}

function mostLinked(nodes: readonly CanvasNode[]): number {
  let best = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i]!.degree > nodes[best]!.degree) best = i;
  return best;
}
