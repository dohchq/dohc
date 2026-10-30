import { describe, expect, it } from "vitest";
import {
  ALPHA_MIN,
  createLayout,
  createLayoutEngine,
  DEFAULT_FORCES,
  placeNodes,
  reheat,
  settled,
  tick,
  type LayoutFrame,
} from "./graphLayout";

function ring(count: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => [i, (i + 1) % count] as [number, number]);
}

function layoutOf(
  count: number,
  links: readonly (readonly [number, number])[],
  seed: (index: number) => { x: number; y: number } | undefined = () => undefined,
) {
  const placed = placeNodes(count, seed);
  return createLayout(
    placed.x,
    placed.y,
    Uint32Array.from(links, ([s]) => s),
    Uint32Array.from(links, ([, t]) => t),
    placed.alpha,
  );
}

describe("graphLayout", () => {
  it("settles to finite, separated positions", () => {
    const layout = layoutOf(40, ring(40));
    let ticks = 0;
    while (!settled(layout) && ticks < 1000) {
      tick(layout, DEFAULT_FORCES);
      ticks++;
    }
    expect(settled(layout)).toBe(true);
    expect(layout.alpha).toBeLessThan(ALPHA_MIN);
    let closest = Infinity;
    for (let i = 0; i < 40; i++) {
      expect(Number.isFinite(layout.x[i])).toBe(true);
      for (let j = i + 1; j < 40; j++) {
        closest = Math.min(closest, Math.hypot(layout.x[i]! - layout.x[j]!, layout.y[i]! - layout.y[j]!));
      }
    }
    expect(closest).toBeGreaterThan(5);
  });

  it("holds linked nodes near the link distance", () => {
    const layout = layoutOf(2, [[0, 1]], (i) => ({ x: i * 600, y: 0 }));
    reheat(layout, 1);
    for (let i = 0; i < 400; i++) tick(layout, DEFAULT_FORCES);
    const linked = Math.hypot(layout.x[0]! - layout.x[1]!, layout.y[0]! - layout.y[1]!);
    expect(linked).toBeGreaterThan(40);
    expect(linked).toBeLessThan(160);
  });

  it("separates nodes that start on one point", () => {
    const layout = layoutOf(5, [], () => ({ x: 0, y: 0 }));
    reheat(layout, 1);
    for (let i = 0; i < 50; i++) tick(layout, DEFAULT_FORCES);
    const xs = new Set(Array.from(layout.x, (x) => x.toFixed(3)));
    expect(xs.size).toBeGreaterThan(1);
    for (let i = 0; i < 5; i++) expect(Number.isFinite(layout.x[i])).toBe(true);
  });

  it("keeps a pinned node where it was put", () => {
    const layout = layoutOf(10, ring(10));
    layout.pinned[3] = 1;
    layout.x[3] = 500;
    layout.y[3] = -200;
    for (let i = 0; i < 30; i++) tick(layout, DEFAULT_FORCES);
    expect(layout.x[3]).toBe(500);
    expect(layout.y[3]).toBe(-200);
  });

  it("starts a mostly remembered layout cool", () => {
    const placed = placeNodes(10, (i) => (i < 9 ? { x: i * 10, y: 0 } : undefined));
    expect(placed.alpha).toBeLessThan(0.5);
    expect(placed.x[4]).toBe(40);
  });

  it("ticks a 5,000-node, 20,000-link graph within a frame budget", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const links: [number, number][] = [];
    while (links.length < 20000) {
      const s = Math.floor(random() * 5000), t = Math.floor(5000 * random() ** 2.6);
      if (s !== t) links.push([s, t]);
    }
    const layout = layoutOf(5000, links);
    for (let i = 0; i < 5; i++) tick(layout, DEFAULT_FORCES);
    const start = performance.now();
    for (let i = 0; i < 20; i++) tick(layout, DEFAULT_FORCES);
    const perTick = (performance.now() - start) / 20;
    console.info(`graph layout tick: ${perTick.toFixed(2)} ms`);
    expect(perTick).toBeLessThan(40);
  });
});

describe("layout engine", () => {
  function engine() {
    const frames: LayoutFrame[] = [];
    const queue: (() => void)[] = [];
    const layout = createLayoutEngine((frame) => frames.push(frame), (run) => queue.push(run));
    const flush = () => {
      while (queue.length) queue.shift()!();
    };
    const model = (generation: number, count: number) => {
      const placed = placeNodes(count, () => undefined);
      layout.receive({
        type: "model",
        generation,
        x: placed.x,
        y: placed.y,
        source: Uint32Array.from(ring(count), ([s]) => s),
        target: Uint32Array.from(ring(count), ([, t]) => t),
        alpha: placed.alpha,
      });
    };
    return { layout, frames, queue, flush, model };
  }

  it("ticks once per buffer the renderer hands back", () => {
    const { layout, frames, flush, model } = engine();
    model(1, 6);
    flush();
    flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.positions).toHaveLength(12);
    layout.receive({ type: "frame", generation: 1, positions: new Float32Array(12) });
    flush();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.generation).toBe(1);
  });

  it("drops a buffer from an older model", () => {
    const { layout, frames, flush, model } = engine();
    model(1, 6);
    flush();
    model(2, 4);
    flush();
    layout.receive({ type: "frame", generation: 1, positions: new Float32Array(12) });
    flush();
    expect(frames.map((frame) => frame.generation)).toEqual([1, 2]);
  });

  it("stops while hidden and resumes when shown", () => {
    const { layout, frames, flush, model } = engine();
    layout.receive({ type: "visible", visible: false });
    model(1, 6);
    flush();
    expect(frames).toHaveLength(0);
    layout.receive({ type: "visible", visible: true });
    flush();
    expect(frames).toHaveLength(1);
  });

  it("stops once settled", () => {
    const { layout, frames, flush, model } = engine();
    model(1, 6);
    for (let i = 0; i < 2000 && !frames.at(-1)?.settled; i++) {
      flush();
      const last = frames.at(-1)!;
      layout.receive({ type: "frame", generation: 1, positions: last.positions });
    }
    expect(frames.at(-1)!.settled).toBe(true);
    const count = frames.length;
    flush();
    expect(frames).toHaveLength(count);
  });

  it("posts one settled picture with reduced motion", () => {
    const { layout, frames, flush, model } = engine();
    layout.receive({ type: "reduced", reduced: true });
    model(1, 30);
    flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.settled).toBe(true);
  });

  it("holds a pinned node and settles again after release", () => {
    const { layout, frames, flush, model } = engine();
    layout.receive({ type: "reduced", reduced: true });
    model(1, 8);
    flush();
    layout.receive({ type: "reduced", reduced: false });
    layout.receive({ type: "frame", generation: 1, positions: frames[0]!.positions });
    layout.receive({ type: "pin", index: 2, x: 400, y: -300 });
    flush();
    const pinned = frames.at(-1)!;
    expect(pinned.settled).toBe(false);
    expect([pinned.positions[4], pinned.positions[5]]).toEqual([400, -300]);
    layout.receive({ type: "release", index: 2 });
    for (let i = 0; i < 2000 && !frames.at(-1)!.settled; i++) {
      layout.receive({ type: "frame", generation: 1, positions: frames.at(-1)!.positions });
      flush();
    }
    expect(frames.at(-1)!.settled).toBe(true);
  });
});
