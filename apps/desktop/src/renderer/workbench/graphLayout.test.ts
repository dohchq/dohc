import { describe, expect, it } from "vitest";
import { ALPHA_MIN, createLayout, DEFAULT_FORCES, reheat, settled, tick } from "./graphLayout";

function ring(count: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => [i, (i + 1) % count] as [number, number]);
}

function degrees(count: number, links: readonly (readonly [number, number])[]): Uint32Array {
  const degree = new Uint32Array(count);
  for (const [s, t] of links) {
    degree[s]!++;
    degree[t]!++;
  }
  return degree;
}

describe("graphLayout", () => {
  it("settles to finite, separated positions", () => {
    const links = ring(40);
    const layout = createLayout(40, links, degrees(40, links), () => undefined);
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
    const links: [number, number][] = [[0, 1]];
    const layout = createLayout(2, links, degrees(2, links), (i) => ({ x: i * 600, y: 0 }));
    reheat(layout, 1);
    for (let i = 0; i < 400; i++) tick(layout, DEFAULT_FORCES);
    const linked = Math.hypot(layout.x[0]! - layout.x[1]!, layout.y[0]! - layout.y[1]!);
    expect(linked).toBeGreaterThan(40);
    expect(linked).toBeLessThan(160);
  });

  it("separates nodes that start on one point", () => {
    const layout = createLayout(5, [], new Uint32Array(5), () => ({ x: 0, y: 0 }));
    reheat(layout, 1);
    for (let i = 0; i < 50; i++) tick(layout, DEFAULT_FORCES);
    const xs = new Set(Array.from(layout.x, (x) => x.toFixed(3)));
    expect(xs.size).toBeGreaterThan(1);
    for (let i = 0; i < 5; i++) expect(Number.isFinite(layout.x[i])).toBe(true);
  });

  it("keeps a pinned node where it was put", () => {
    const links = ring(10);
    const layout = createLayout(10, links, degrees(10, links), () => undefined);
    layout.pinned[3] = 1;
    layout.x[3] = 500;
    layout.y[3] = -200;
    for (let i = 0; i < 30; i++) tick(layout, DEFAULT_FORCES);
    expect(layout.x[3]).toBe(500);
    expect(layout.y[3]).toBe(-200);
  });

  it("starts a mostly remembered layout cool", () => {
    const layout = createLayout(10, [], new Uint32Array(10), (i) => (i < 9 ? { x: i * 10, y: 0 } : undefined));
    expect(layout.alpha).toBeLessThan(0.5);
    expect(layout.x[4]).toBe(40);
  });

  it("ticks a 5,000-node, 20,000-link graph within a frame budget", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const links: [number, number][] = [];
    while (links.length < 20000) {
      const s = Math.floor(random() * 5000), t = Math.floor(5000 * random() ** 2.6);
      if (s !== t) links.push([s, t]);
    }
    const layout = createLayout(5000, links, degrees(5000, links), () => undefined);
    for (let i = 0; i < 5; i++) tick(layout, DEFAULT_FORCES);
    const start = performance.now();
    for (let i = 0; i < 20; i++) tick(layout, DEFAULT_FORCES);
    const perTick = (performance.now() - start) / 20;
    console.info(`graph layout tick: ${perTick.toFixed(2)} ms`);
    expect(perTick).toBeLessThan(40);
  });
});
