import { afterEach, describe, expect, it, vi } from "vitest";
import { contrastRatio, mixHex } from "../accentColor";
import { identityHues, palette } from "../tokens";
import {
  GROUP_HUES,
  LABEL_DIM,
  LINK_STYLE,
  NODE_DIM,
  NODE_TOKEN,
  createGraphRenderer,
  fitCamera,
  followCamera,
  labelOpacity,
  shortTitle,
} from "./GraphCanvas";
import {
  REST_GLOW,
  isCurvedEdge,
  outerRadius,
  quadAt,
  quadControl,
  withAlpha,
} from "./graphVisuals";

// The Graph page draws on bg, the side panel on panel.
const SURFACES = ["bg", "panel"] as const;

function lowest(theme: "light" | "dark", colors: readonly string[], alpha: number): number {
  const tokens = palette[theme];
  return Math.min(
    ...SURFACES.flatMap((surface) =>
      colors.map((color) => contrastRatio(mixHex(color, tokens[surface], alpha), tokens[surface])),
    ),
  );
}

describe.each(["light", "dark"] as const)("dimmed Graph nodes in %s", (theme) => {
  const nodeColors = [
    palette[theme][NODE_TOKEN[theme]],
    ...GROUP_HUES.map((hue) => identityHues[theme][hue]),
  ];

  it("keep every node colour at 3:1, and dim no further than that needs", () => {
    expect(lowest(theme, nodeColors, NODE_DIM[theme])).toBeGreaterThanOrEqual(3);
    expect(lowest(theme, nodeColors, NODE_DIM[theme] - 0.02)).toBeLessThan(3);
  });

  it("keep labels at 4.5:1, never fainter than their nodes", () => {
    expect(lowest(theme, [palette[theme].muted], LABEL_DIM[theme])).toBeGreaterThanOrEqual(4.5);
    expect(LABEL_DIM[theme]).toBeGreaterThanOrEqual(NODE_DIM[theme]);
  });

  it("hide a label still fading in or out while another node is emphasised", () => {
    for (const emphasis of [0.1, 0.5, 1]) {
      for (const fade of [0.05, 0.5, 0.95, 1]) {
        const alpha = labelOpacity(fade, emphasis, LABEL_DIM[theme], false);
        if (alpha > 0)
          expect(lowest(theme, [palette[theme].muted], alpha)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(labelOpacity(0.5, 1, LABEL_DIM[theme], false)).toBe(0);
    expect(labelOpacity(1, 1, LABEL_DIM[theme], false)).toBeCloseTo(LABEL_DIM[theme]);
    expect(labelOpacity(0.5, 0, LABEL_DIM[theme], false)).toBe(0.5);
    expect(labelOpacity(0.5, 1, LABEL_DIM[theme], true)).toBe(1);
  });
});

describe("fitting the Graph to its view", () => {
  it("leaves a 16 px margin on the side that limits it, centred", () => {
    // A 300 by 288 panel and a graph 1,000 wide and 500 tall: the width limits it.
    const camera = fitCamera(-500, -250, 500, 250, 300, 288);
    expect(camera.k).toBeCloseTo(0.268);
    expect(-500 * camera.k + camera.tx).toBeCloseTo(16);
    expect(500 * camera.k + camera.tx).toBeCloseTo(284);
    expect(camera.ty).toBe(144);
  });

  it("never draws a node larger than at 100% zoom", () => {
    expect(fitCamera(0, 0, 40, 20, 300, 288)).toEqual({ k: 1, tx: 130, ty: 134 });
  });

  it("zooms out to the fit at once while the layout cools, and eases otherwise", () => {
    const camera = { k: 1, tx: 100, ty: 100 };
    const out = { k: 0.5, tx: 200, ty: 0 };
    const zoomIn = { k: 2, tx: 200, ty: 0 };
    expect(followCamera(camera, out, true)).toEqual(out);
    expect(followCamera(camera, zoomIn, true)).toEqual({ k: 1.15, tx: 115, ty: 85 });
    expect(followCamera(camera, out, false)).toEqual({ k: 0.925, tx: 115, ty: 85 });
  });
});

describe("Graph labels", () => {
  it("cut a long title with no space before the …", () => {
    expect(shortTitle("Trip plan")).toBe("Trip plan");
    expect(shortTitle(`${"a".repeat(30)} bcd`)).toBe(`${"a".repeat(30)}…`);
  });
});

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function screenHex(bg: string, glow: string, alpha: number): string {
  const [br, bgc, bb] = parseHex(bg);
  const [gr, gg, gb] = parseHex(glow);
  const ch = (b: number, g: number) => b + (255 - b) * (g / 255) * alpha;
  return toHex(ch(br, gr), ch(bgc, gg), ch(bb, gb));
}

describe.each(["light", "dark"] as const)("bounded glow layer contrast in %s", (theme) => {
  const tokens = palette[theme];
  const nodeColors = [
    tokens[NODE_TOKEN[theme]],
    tokens.warning,
    ...GROUP_HUES.map((hue) => identityHues[theme][hue]),
  ];
  const worstGlows =
    theme === "dark"
      ? ["#ffffff"]
      : ["#000000", ...GROUP_HUES.map((hue) => identityHues.light[hue])];

  it("keeps nodes >= 3:1 and muted labels >= 4.5:1 under infinite overlapping halos at every mix", () => {
    for (const surface of SURFACES) {
      const baseBg = tokens[surface];
      for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
        const glowAlpha = REST_GLOW[theme] * (1 - mix);
        const nodeAlpha = 1 - (1 - NODE_DIM[theme]) * mix;
        const labelAlpha = 1 - (1 - LABEL_DIM[theme]) * mix;
        for (const glow of worstGlows) {
          const effectiveBg =
            theme === "dark" ? screenHex(baseBg, glow, glowAlpha) : mixHex(glow, baseBg, glowAlpha);
          for (const fg of nodeColors) {
            expect(
              contrastRatio(mixHex(fg, effectiveBg, nodeAlpha), effectiveBg),
            ).toBeGreaterThanOrEqual(3);
          }
          expect(
            contrastRatio(mixHex(tokens.muted, effectiveBg, labelAlpha), effectiveBg),
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe("graphVisuals helpers", () => {
  it("normalizes 6-hex, 3-hex, and rgb colors in withAlpha", () => {
    expect(withAlpha("#1a2b3c", 0.5)).toBe("rgba(26, 43, 60, 0.5)");
    expect(withAlpha("#888", 0.25)).toBe("rgba(136, 136, 136, 0.25)");
    expect(withAlpha("rgb(10, 20, 30)", 1.5)).toBe("rgba(10, 20, 30, 1)");
    expect(withAlpha("rgba(10, 20, 30, 0.9)", -0.2)).toBe("rgba(10, 20, 30, 0)");
    expect(withAlpha("currentColor", 0.5)).toBe("currentColor");
  });

  it("computes exact outer radii including the Group bubble tail", () => {
    expect(outerRadius("bubble", 10)).toBeCloseTo(Math.hypot(0.95, 1.1) * 10);
    expect(outerRadius("square", 10)).toBeCloseTo(14.1);
    expect(outerRadius("triangle", 10)).toBeCloseTo(13.5);
    expect(outerRadius("diamond", 10)).toBeCloseTo(12.5);
    expect(outerRadius("hexagon", 10)).toBeCloseTo(11.5);
    expect(outerRadius("circle", 10)).toBe(10);
  });

  it("separates bidirectional curves and evaluates unit tangents", () => {
    expect(isCurvedEdge(true, LINK_STYLE.structural)).toBe(true);
    expect(isCurvedEdge(true, LINK_STYLE.pending)).toBe(true);
    expect(isCurvedEdge(true, LINK_STYLE.prose)).toBe(false);
    expect(isCurvedEdge(true, LINK_STYLE.mention)).toBe(false);
    expect(isCurvedEdge(false, LINK_STYLE.structural)).toBe(false);

    const [cx1, cy1] = quadControl(0, 0, 100, 0);
    const [cx2, cy2] = quadControl(100, 0, 0, 0);
    expect(cx1).toBe(50);
    expect(cx2).toBe(50);
    expect(cy1).toBeGreaterThan(0);
    expect(cy2).toBeLessThan(0);
    expect(cy1).toBeCloseTo(-cy2);

    const [mx, my, ux, uy] = quadAt([0, 0, 100, 0], 0.5);
    expect(mx).toBeCloseTo(50);
    expect(my).toBeGreaterThan(0);
    expect(Math.hypot(ux, uy)).toBeCloseTo(1);
    expect(ux).toBeCloseTo(1);
  });
});

function createMockContext() {
  const calls: { op: string; args: unknown[]; state: Record<string, unknown> }[] = [];
  const state = {
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    lineDashOffset: 0,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  const stack: (typeof state)[] = [];
  const rec = (op: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ op, args, state: { ...state } });
    });
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get globalCompositeOperation() {
      return state.globalCompositeOperation;
    },
    set globalCompositeOperation(v: string) {
      state.globalCompositeOperation = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get lineCap() {
      return state.lineCap;
    },
    set lineCap(v: string) {
      state.lineCap = v;
    },
    get lineJoin() {
      return state.lineJoin;
    },
    set lineJoin(v: string) {
      state.lineJoin = v;
    },
    get lineDashOffset() {
      return state.lineDashOffset;
    },
    set lineDashOffset(v: number) {
      state.lineDashOffset = v;
    },
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: string) {
      state.textAlign = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: string) {
      state.textBaseline = v;
    },
    save: vi.fn(() => stack.push({ ...state })),
    restore: vi.fn(() => {
      const top = stack.pop();
      if (top) Object.assign(state, top);
    }),
    setTransform: rec("setTransform"),
    clearRect: rec("clearRect"),
    fillRect: rec("fillRect"),
    beginPath: rec("beginPath"),
    closePath: rec("closePath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    quadraticCurveTo: rec("quadraticCurveTo"),
    arc: rec("arc"),
    roundRect: rec("roundRect"),
    stroke: rec("stroke"),
    fill: rec("fill"),
    drawImage: rec("drawImage"),
    setLineDash: rec("setLineDash"),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    strokeText: rec("strokeText"),
    fillText: rec("fillText"),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function setupRendererEnv() {
  let nextHandle = 1;
  let now = performance.now();
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      const id = nextHandle++;
      frames.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    matchMedia: vi.fn(() => ({ matches: false })),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => {
      const map: Record<string, string> = {
        "--dohc-bg": palette.dark.bg,
        "--dohc-panel": palette.dark.panel,
        "--dohc-ink": palette.dark.ink,
        "--dohc-muted": palette.dark.muted,
        "--dohc-subtle": palette.dark.subtle,
        "--dohc-match": palette.dark.match,
        "--dohc-warning": palette.dark.warning,
        "--dohc-line": palette.dark.line,
        "--font-sans": "sans-serif",
      };
      for (const hue of GROUP_HUES) map[`--dohc-hue-${hue}`] = identityHues.dark[hue];
      return map[name] ?? "";
    },
  }));
  const makeCanvas = () => {
    const mock = createMockContext();
    const listeners = new Map<string, (event: unknown) => void>();
    const el = {
      width: 400,
      height: 300,
      dataset: {} as Record<string, string>,
      style: { cursor: "" },
      getContext: () => mock.ctx,
      closest: () => ({ dataset: { theme: "dark" } }),
      addEventListener: vi.fn((type: string, cb: (event: unknown) => void) =>
        listeners.set(type, cb),
      ),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    };
    return {
      canvas: el as unknown as HTMLCanvasElement,
      calls: mock.calls,
      fire: (type: string, event: unknown) => listeners.get(type)?.(event),
    };
  };
  vi.stubGlobal("document", {
    documentElement: { dataset: { theme: "dark" } },
    createElement: () => makeCanvas().canvas,
  });
  const drain = (limit = 200) => {
    let steps = 0;
    while (frames.size > 0 && steps < limit) {
      const [id, cb] = frames.entries().next().value as [number, FrameRequestCallback];
      frames.delete(id);
      now += 16;
      cb(now);
      steps++;
    }
    return steps;
  };
  return { makeCanvas, drain, pending: () => frames.size };
}

describe("createGraphRenderer visual behaviours", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws curved structural/pending links, obeys display.arrows=false, and restores label stroke state after lit pill", () => {
    const env = setupRendererEnv();
    const { canvas, calls } = env.makeCanvas();
    const settled = vi.fn();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled });
    renderer.resize(400, 300);
    renderer.setModel({
      nodes: [
        {
          path: "app:a",
          title: "Board",
          kind: "App",
          shape: "hexagon",
          degree: 2,
          structural: true,
        },
        {
          path: "collection:b",
          title: "Tasks",
          kind: "Collection",
          shape: "square",
          degree: 2,
          structural: true,
        },
        { path: "note.md", title: "Notes", kind: "Page", shape: "circle", degree: 1 },
      ],
      links: [
        [0, 1, LINK_STYLE.pending],
        [1, 0, LINK_STYLE.structural],
        [1, 2, LINK_STYLE.prose],
      ],
    });
    renderer.setGroups(Int16Array.from([5, 0, -1]));
    renderer.setActive(0);
    env.drain();
    expect(settled).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.op === "quadraticCurveTo")).toBe(true);
    expect(calls.some((c) => c.op === "drawImage")).toBe(true);

    calls.length = 0;
    renderer.setOptions({
      display: { arrows: false, textFade: 0, nodeSize: 0.5, linkThickness: 0.5 },
      forces: { center: 0.25, repel: 0.5, link: 0.4, distance: 0.5 },
      local: false,
    });
    env.drain();
    expect(calls.some((c) => c.op === "quadraticCurveTo")).toBe(true);
    const arrowFills = calls.filter(
      (c, idx) =>
        c.op === "fill" &&
        idx >= 4 &&
        calls[idx - 1]?.op === "closePath" &&
        calls[idx - 2]?.op === "lineTo" &&
        calls[idx - 3]?.op === "lineTo" &&
        calls[idx - 4]?.op === "moveTo",
    );
    expect(arrowFills).toHaveLength(0);

    calls.length = 0;
    renderer.resize(800, 600);
    renderer.zoomBy(6);
    renderer.setFocus(0);
    env.drain();
    const pillDraw = calls.find(
      (c) => c.op === "roundRect" && c.state.fillStyle === palette.dark.bg,
    );
    expect(pillDraw).toBeDefined();
    const pendingRing = calls.find(
      (c) => c.op === "arc" && c.state.strokeStyle === palette.dark.warning,
    );
    const activeRing = calls.find(
      (c) =>
        c.op === "arc" && c.state.strokeStyle === palette.dark.ink && c.state.lineWidth === 1.5,
    );
    expect(pendingRing).toBeDefined();
    expect(activeRing).toBeDefined();
    expect((activeRing!.args[2] as number) - (pendingRing!.args[2] as number)).toBeCloseTo(3);
    expect(pillDraw!.args[1] as number).toBeGreaterThanOrEqual(
      (activeRing!.args[1] as number) + (activeRing!.args[2] as number) + 1.5,
    );
    const laterLabelStroke = calls.find(
      (c, idx) => c.op === "strokeText" && idx > calls.indexOf(pillDraw!),
    );
    expect(laterLabelStroke?.state.lineWidth).toBe(3);
    expect(laterLabelStroke?.state.strokeStyle).toBe(palette.dark.bg);
    expect(env.pending()).toBe(0);
    renderer.destroy();
  });

  it("keeps a curved link visible when both endpoints pan offscreen but its bow stays inside the viewport", () => {
    const env = setupRendererEnv();
    const { canvas, calls, fire } = env.makeCanvas();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled: vi.fn() });
    renderer.resize(400, 300);
    renderer.setModel({
      nodes: Array.from({ length: 24 }, (_, idx) => ({
        path: `n${idx}`,
        title: `N${idx}`,
        kind: "Collection",
        shape: "square" as const,
        degree: 2,
        structural: true,
      })),
      links: [
        [0, 23, LINK_STYLE.structural],
        [23, 0, LINK_STYLE.structural],
      ],
    });
    renderer.zoomBy(8);
    env.drain();
    const sample = calls.find((c, i) => {
      if (c.op !== "quadraticCurveTo" || i === 0 || calls[i - 1]?.op !== "moveTo") return false;
      const x1 = calls[i - 1]!.args[0] as number;
      const cx = c.args[0] as number;
      const x2 = c.args[2] as number;
      const midX = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
      return midX > Math.max(x1, x2) + 4;
    });
    expect(sample).toBeDefined();
    const moveBefore = calls[calls.indexOf(sample!) - 1]!;
    const sx1 = moveBefore.args[0] as number;
    const scx = sample!.args[0] as number;
    const sx2 = sample!.args[2] as number;
    const maxEndX = Math.max(sx1, sx2);
    const midX = 0.25 * sx1 + 0.5 * scx + 0.25 * sx2;
    const shiftX = -(maxEndX + (midX - maxEndX) / 2);

    calls.length = 0;
    fire("pointerdown", { button: 0, pointerId: 1, clientX: 390, clientY: 290 });
    fire("pointermove", { pointerId: 1, clientX: 390 + shiftX, clientY: 290 });
    fire("pointerup", { pointerId: 1 });
    env.drain();
    const pannedCurve = calls.find((c, i) => {
      if (c.op !== "quadraticCurveTo" || i === 0 || calls[i - 1]?.op !== "moveTo") return false;
      const x1 = calls[i - 1]!.args[0] as number;
      const cx = c.args[0] as number;
      const x2 = c.args[2] as number;
      return x1 < 0 && x2 < 0 && 0.25 * x1 + 0.5 * cx + 0.25 * x2 > 0;
    });
    expect(pannedCurve).toBeDefined();
    renderer.destroy();
  });

  it("preserves finished hover flow across model refreshes, caps animated pending edges at 24, and keeps warning hue past the curve cutoff", () => {
    const env = setupRendererEnv();
    const { canvas, calls } = env.makeCanvas();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled: vi.fn() });
    renderer.resize(600, 500);
    const hub = {
      path: "collection:hub",
      title: "Hub",
      kind: "Collection",
      shape: "square" as const,
      degree: 26,
      structural: true,
    };
    const apps = Array.from({ length: 26 }, (_, i) => ({
      path: `app:a${i}`,
      title: `App ${i}`,
      kind: "App",
      shape: "hexagon" as const,
      degree: 1,
      structural: true,
    }));
    const model = {
      nodes: [hub, ...apps],
      links: apps.map((_, i) => [i + 1, 0, LINK_STYLE.pending] as const),
    };
    renderer.setModel(model);
    renderer.setGroups(Int16Array.from([0, ...apps.map(() => 5)]));
    env.drain();

    calls.length = 0;
    renderer.setFocus(0);
    const firstSteps = env.drain();
    expect(firstSteps).toBeGreaterThan(70);
    const movedPendingPerFrame = calls.filter(
      (c) =>
        c.op === "quadraticCurveTo" &&
        c.state.strokeStyle === palette.dark.warning &&
        (c.state.lineDashOffset as number) !== 0,
    ).length;
    expect(movedPendingPerFrame / firstSteps).toBeLessThanOrEqual(24);

    calls.length = 0;
    renderer.setModel({ nodes: [...model.nodes], links: [...model.links] });
    const refreshSteps = env.drain();
    expect(refreshSteps).toBeLessThan(10);
    expect(env.pending()).toBe(0);

    const manyNodes = Array.from({ length: 130 }, (_, i) => ({
      path: `collection:c${i}`,
      title: `C${i}`,
      kind: "Collection",
      shape: "square" as const,
      degree: 2,
      structural: true,
    }));
    const manyLinks = [
      [1, 0, LINK_STYLE.pending] as const,
      ...Array.from({ length: 125 }, (_, i) => [i + 2, 0, LINK_STYLE.structural] as const),
    ];
    renderer.setFocus(-1);
    env.drain();
    calls.length = 0;
    renderer.setModel({ nodes: manyNodes, links: manyLinks });
    env.drain();
    expect(
      calls.some((c) => c.op === "stroke" && c.state.strokeStyle === palette.dark.warning),
    ).toBe(true);

    calls.length = 0;
    renderer.setFocus(0);
    env.drain();
    expect(
      calls.some(
        (c) =>
          c.op === "stroke" &&
          c.state.strokeStyle === palette.dark.warning &&
          (c.state.lineDashOffset as number) !== 0,
      ),
    ).toBe(true);
    renderer.destroy();
  });

  it("avoids covering a neighboring node's active and pending rings with the hovered title pill", () => {
    const env = setupRendererEnv();
    const { canvas, calls, fire } = env.makeCanvas();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled: vi.fn() });
    renderer.resize(500, 400);
    renderer.setModel({
      nodes: [
        {
          path: "collection:hub",
          title: "Tasks",
          kind: "Collection",
          shape: "square",
          degree: 1,
          structural: true,
        },
        {
          path: "app:req",
          title: "Board",
          kind: "App",
          shape: "hexagon",
          degree: 1,
          structural: true,
        },
      ],
      links: [[1, 0, LINK_STYLE.pending]],
    });
    renderer.setGroups(Int16Array.from([0, 5]));
    renderer.setActive(1);
    env.drain();
    const activeBefore = calls.find(
      (c) =>
        c.op === "arc" && c.state.strokeStyle === palette.dark.ink && c.state.lineWidth === 1.5,
    )!;
    const hubSquare = calls.find(
      (c) => c.op === "roundRect" && c.state.fillStyle === identityHues.dark.teal,
    )!;
    const hubX = (hubSquare.args[0] as number) + (hubSquare.args[2] as number) / 2;
    const hubY = (hubSquare.args[1] as number) + (hubSquare.args[3] as number) / 2;
    const appX = activeBefore.args[0] as number;
    const appY = activeBefore.args[1] as number;

    fire("pointerdown", { button: 0, pointerId: 1, clientX: appX, clientY: appY });
    fire("pointermove", { pointerId: 1, clientX: hubX, clientY: hubY + 26 });
    fire("pointerup", { pointerId: 1 });
    env.drain();

    calls.length = 0;
    renderer.setFocus(0);
    env.drain();
    const pill = calls.find((c) => c.op === "roundRect" && c.state.fillStyle === palette.dark.bg);
    const activeAfter = calls.find(
      (c) =>
        c.op === "arc" && c.state.strokeStyle === palette.dark.ink && c.state.lineWidth === 1.5,
    );
    expect(pill).toBeDefined();
    expect(activeAfter).toBeDefined();
    const pillBottom = (pill!.args[1] as number) + (pill!.args[3] as number);
    const ringTop = (activeAfter!.args[1] as number) - (activeAfter!.args[2] as number);
    expect(pillBottom).toBeLessThanOrEqual(ringTop);
    renderer.destroy();
  });

  it("draws Group bubble clockwise, skips glowLayer for prose-only graphs, and falls back to non-pill title when hemmed in above and below", () => {
    const env = setupRendererEnv();
    const { canvas, calls, fire } = env.makeCanvas();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled: vi.fn() });
    renderer.resize(500, 400);

    renderer.setModel({
      nodes: [
        { path: "a.md", title: "Alpha", kind: "Page", shape: "circle", degree: 1 },
        { path: "b.md", title: "Beta", kind: "Page", shape: "circle", degree: 1 },
      ],
      links: [[0, 1, LINK_STYLE.prose]],
    });
    env.drain();
    expect(calls.some((c) => c.op === "drawImage")).toBe(false);

    calls.length = 0;
    renderer.setModel({
      nodes: [
        {
          path: "group:ops",
          title: "Ops",
          kind: "Group",
          shape: "bubble",
          degree: 2,
          structural: true,
        },
        {
          path: "collection:a",
          title: "Above",
          kind: "Collection",
          shape: "square",
          degree: 1,
          structural: true,
        },
        {
          path: "collection:b",
          title: "Below",
          kind: "Collection",
          shape: "square",
          degree: 1,
          structural: true,
        },
      ],
      links: [
        [0, 1, LINK_STYLE.structural],
        [0, 2, LINK_STYLE.structural],
      ],
    });
    renderer.setGroups(Int16Array.from([0, 0, 0]));
    env.drain();
    const bubbleArc = calls.find(
      (c) =>
        c.op === "arc" &&
        c.state.fillStyle === identityHues.dark.teal &&
        (c.args[3] as number) > 2 &&
        (c.args[4] as number) < 2,
    );
    expect(bubbleArc).toBeDefined();
    expect(bubbleArc!.args[5]).toBe(false);

    const cx = bubbleArc!.args[0] as number;
    const cy = bubbleArc!.args[1] as number;
    const squares = calls.filter(
      (c) => c.op === "roundRect" && c.state.fillStyle === identityHues.dark.teal,
    );
    const s0x = (squares[0]!.args[0] as number) + (squares[0]!.args[2] as number) / 2;
    const s0y = (squares[0]!.args[1] as number) + (squares[0]!.args[3] as number) / 2;
    const s1x = (squares[1]!.args[0] as number) + (squares[1]!.args[2] as number) / 2;
    const s1y = (squares[1]!.args[1] as number) + (squares[1]!.args[3] as number) / 2;
    fire("pointerdown", { button: 0, pointerId: 1, clientX: s0x, clientY: s0y });
    fire("pointermove", { pointerId: 1, clientX: cx, clientY: cy - 22 });
    fire("pointerup", { pointerId: 1 });
    fire("pointerdown", { button: 0, pointerId: 2, clientX: s1x, clientY: s1y });
    fire("pointermove", { pointerId: 2, clientX: cx, clientY: cy + 22 });
    fire("pointerup", { pointerId: 2 });
    env.drain();

    calls.length = 0;
    renderer.setFocus(0);
    env.drain();
    expect(calls.some((c) => c.op === "roundRect" && c.state.fillStyle === palette.dark.bg)).toBe(
      false,
    );
    expect(calls.some((c) => c.op === "fillText" && c.args[0] === "Ops")).toBe(true);
    renderer.destroy();
  });

  it("bounds hover flow to finite frames, keeps prose & paused automations calm, and settles immediately", () => {
    const env = setupRendererEnv();
    const { canvas, calls } = env.makeCanvas();
    const settled = vi.fn();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled });
    renderer.resize(400, 300);
    renderer.setModel({
      nodes: [
        { path: "a.md", title: "A", kind: "Page", shape: "circle", degree: 1 },
        { path: "b.md", title: "B", kind: "Page", shape: "circle", degree: 1 },
        {
          path: "auto:paused",
          title: "Paused",
          kind: "Automation",
          shape: "triangle",
          degree: 1,
          structural: true,
          paused: true,
        },
        {
          path: "collection:c",
          title: "Items",
          kind: "Collection",
          shape: "square",
          degree: 2,
          structural: true,
        },
        {
          path: "app:live",
          title: "Live",
          kind: "App",
          shape: "hexagon",
          degree: 1,
          structural: true,
        },
      ],
      links: [
        [0, 1, LINK_STYLE.prose],
        [2, 3, LINK_STYLE.structural],
        [4, 3, LINK_STYLE.structural],
      ],
    });
    renderer.setGroups(Int16Array.from([-1, -1, 1, 0, 5]));
    env.drain();
    expect(settled).toHaveBeenCalledOnce();

    calls.length = 0;
    renderer.setFocus(0);
    const proseSteps = env.drain();
    expect(proseSteps).toBeLessThan(20);
    expect(env.pending()).toBe(0);
    expect(calls.some((c) => c.op === "arc" && c.args[2] === 2.2)).toBe(false);

    calls.length = 0;
    renderer.setFocus(2);
    const pausedSteps = env.drain();
    expect(pausedSteps).toBeLessThan(20);
    expect(env.pending()).toBe(0);
    expect(calls.some((c) => c.op === "arc" && c.args[2] === 2.2)).toBe(false);

    calls.length = 0;
    renderer.setFocus(4);
    const liveSteps = env.drain();
    expect(liveSteps).toBeGreaterThan(70);
    expect(liveSteps).toBeLessThan(120);
    expect(env.pending()).toBe(0);
    expect(calls.some((c) => c.op === "arc" && c.args[2] === 2.2)).toBe(true);
    renderer.destroy();
  });

  it("re-resolves approval surge endpoints across setModel and terminates cleanly", () => {
    const env = setupRendererEnv();
    const { canvas, calls } = env.makeCanvas();
    const renderer = createGraphRenderer(canvas, "bg", { open: vi.fn(), settled: vi.fn() });
    renderer.resize(400, 300);
    const app = {
      path: "app:a",
      title: "Board",
      kind: "App",
      shape: "hexagon" as const,
      degree: 1,
      structural: true,
    };
    const col = {
      path: "collection:b",
      title: "Tasks",
      kind: "Collection",
      shape: "square" as const,
      degree: 1,
      structural: true,
    };
    renderer.setModel({ nodes: [app, col], links: [[0, 1, LINK_STYLE.structural]] });
    renderer.setGroups(Int16Array.from([5, 0]));
    env.drain();

    calls.length = 0;
    renderer.setApprovalSurge({ nonce: 1, edges: [["app:a", "collection:b"]] });
    renderer.setModel({ nodes: [col, app], links: [[1, 0, LINK_STYLE.structural]] });
    const surgeSteps = env.drain();
    expect(surgeSteps).toBeGreaterThan(40);
    expect(surgeSteps).toBeLessThan(90);
    expect(env.pending()).toBe(0);
    expect(calls.some((c) => c.op === "arc" && c.args[2] === 2.2)).toBe(true);
    renderer.destroy();
  });
});
