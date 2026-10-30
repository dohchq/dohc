// A force layout for the Graph: many-body repulsion through a Barnes-Hut
// quadtree, springs along links, and a pull toward the origin. Positions live
// in typed arrays so a tick over 5,000 nodes stays a few milliseconds.

export type GraphForces = { center: number; repel: number; link: number; distance: number };

// Each force is a 0 to 1 setting; 0.5 is the default and the middle of its slider.
export const DEFAULT_FORCES: GraphForces = { center: 0.5, repel: 0.5, link: 0.5, distance: 0.5 };

export const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 280);
const VELOCITY_KEEP = 0.6;
const THETA2 = 0.81;
const LONELY_PULL = 4;

export type GraphLayout = {
  count: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  pinned: Uint8Array;
  source: Uint32Array;
  target: Uint32Array;
  linkBias: Float64Array;
  linkStrength: Float64Array;
  // 1 for a node with no links: it is pulled toward the middle harder, so
  // unlinked files ring the graph closely instead of far out.
  lonely: Uint8Array;
  alpha: number;
  alphaTarget: number;
};

// Starting places: a remembered place where the seed has one, else a spot on a
// phyllotaxis disc, an even spread with no two nodes on one point. A layout that
// kept most of its places only needs to settle the new ones, so it starts cooler.
// A stable 32-bit hash of a file's path (FNV-1a).
export function pathHash(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export function placeNodes(
  count: number,
  seed: (index: number) => { x: number; y: number } | undefined,
  hash: (index: number) => number,
): { x: Float64Array; y: Float64Array; alpha: number } {
  const x = new Float64Array(count), y = new Float64Array(count);
  // A new node starts at a point in a disc that grows with the graph. The
  // point comes from its file's hash, so it is scattered, not lined up, and
  // the same each time the Graph opens.
  const disc = 10 * Math.sqrt(count + 0.5);
  let seeded = 0;
  for (let i = 0; i < count; i++) {
    const previous = seed(i);
    if (previous) {
      x[i] = previous.x;
      y[i] = previous.y;
      seeded++;
      continue;
    }
    const h = hash(i);
    const radius = disc * Math.sqrt((h & 0xffff) / 0x10000);
    const angle = ((h >>> 16) / 0x10000) * Math.PI * 2;
    x[i] = radius * Math.cos(angle);
    y[i] = radius * Math.sin(angle);
  }
  return { x, y, alpha: count > 0 && seeded / count > 0.8 ? 0.3 : 1 };
}

export function createLayout(x: Float64Array, y: Float64Array, source: Uint32Array, target: Uint32Array, alpha = 1): GraphLayout {
  const count = x.length;
  const degree = new Uint32Array(count);
  for (let l = 0; l < source.length; l++) {
    degree[source[l]!]!++;
    degree[target[l]!]!++;
  }
  const linkBias = new Float64Array(source.length), linkStrength = new Float64Array(source.length);
  for (let l = 0; l < source.length; l++) {
    const ds = Math.max(1, degree[source[l]!]!), dt = Math.max(1, degree[target[l]!]!);
    linkBias[l] = ds / (ds + dt);
    linkStrength[l] = 1 / Math.min(ds, dt);
  }
  return {
    count,
    x,
    y,
    vx: new Float64Array(count),
    vy: new Float64Array(count),
    pinned: new Uint8Array(count),
    source,
    target,
    linkBias,
    linkStrength,
    lonely: Uint8Array.from(degree, (d) => (d === 0 ? 1 : 0)),
    alpha,
    alphaTarget: 0,
  };
}

export function reheat(layout: GraphLayout, alpha: number): void {
  layout.alpha = Math.max(layout.alpha, alpha);
}

export function settled(layout: GraphLayout): boolean {
  return layout.alpha < ALPHA_MIN && layout.alphaTarget === 0;
}

// Reused between ticks so a settling graph allocates nothing per frame.
type Tree = {
  child: Int32Array;
  point: Int32Array;
  next: Int32Array;
  mass: Float64Array;
  mx: Float64Array;
  my: Float64Array;
  size: Float64Array;
  used: number;
};
let tree: Tree | null = null;

function ensureTree(points: number): Tree {
  const capacity = Math.max(64, points * 3);
  if (tree && tree.mass.length >= capacity && tree.next.length >= points) return tree;
  tree = {
    child: new Int32Array(capacity * 4),
    point: new Int32Array(capacity),
    next: new Int32Array(points),
    mass: new Float64Array(capacity),
    mx: new Float64Array(capacity),
    my: new Float64Array(capacity),
    size: new Float64Array(capacity),
    used: 0,
  };
  return tree;
}

function newQuad(t: Tree, size: number): number {
  const q = t.used++;
  t.child.fill(-1, q * 4, q * 4 + 4);
  t.point[q] = -1;
  t.mass[q] = 0;
  t.size[q] = size;
  return q;
}

// Builds the quadtree. Internal quads have point -2; a leaf chains points that
// share one spot through `next`.
function buildTree(layout: GraphLayout): Tree {
  const { count, x, y } = layout;
  let t = ensureTree(count);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    if (x[i]! < x0) x0 = x[i]!;
    if (x[i]! > x1) x1 = x[i]!;
    if (y[i]! < y0) y0 = y[i]!;
    if (y[i]! > y1) y1 = y[i]!;
  }
  const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
  for (;;) {
    t.used = 0;
    newQuad(t, size);
    let overflow = false;
    for (let i = 0; i < count && !overflow; i++) {
      t.next[i] = -1;
      let q = 0, qx = x0, qy = y0, qs = size;
      let pending = i;
      while (pending >= 0) {
        const p = t.point[q]!;
        if (p === -1) {
          // Only the empty root has no point and no children.
          t.point[q] = pending;
          pending = -1;
        } else if (p >= 0) {
          if (Math.abs(x[p]! - x[pending]!) < 1e-9 && Math.abs(y[p]! - y[pending]!) < 1e-9) {
            t.next[pending] = t.next[p]!;
            t.next[p] = pending;
            pending = -1;
            continue;
          }
          // Split the leaf: push its chain one level down, then keep inserting.
          t.point[q] = -2;
          const half = qs / 2;
          const quadrant = (x[p]! >= qx + half ? 1 : 0) | (y[p]! >= qy + half ? 2 : 0);
          if (t.used >= t.mass.length) { overflow = true; break; }
          const c = newQuad(t, half);
          t.child[q * 4 + quadrant] = c;
          t.point[c] = p;
        } else {
          const half = qs / 2;
          const right = x[pending]! >= qx + half, below = y[pending]! >= qy + half;
          const quadrant = (right ? 1 : 0) | (below ? 2 : 0);
          if (right) qx += half;
          if (below) qy += half;
          qs = half;
          const existing = t.child[q * 4 + quadrant]!;
          if (existing === -1) {
            if (t.used >= t.mass.length) { overflow = true; break; }
            const c = newQuad(t, half);
            t.child[q * 4 + quadrant] = c;
            t.point[c] = pending;
            pending = -1;
          } else {
            q = existing;
          }
        }
      }
    }
    if (!overflow) break;
    // Deeply nested near-duplicates: grow the arrays and build again.
    tree = null;
    t = ensureTree(count * 4);
  }
  // Children always come after their parent, so one reverse pass sums mass.
  for (let q = t.used - 1; q >= 0; q--) {
    const p = t.point[q]!;
    if (p >= 0) {
      let mass = 0;
      for (let i = p; i >= 0; i = t.next[i]!) mass++;
      t.mass[q] = mass;
      t.mx[q] = x[p]!;
      t.my[q] = y[p]!;
      continue;
    }
    let mass = 0, mx = 0, my = 0;
    for (let k = 0; k < 4; k++) {
      const c = t.child[q * 4 + k]!;
      if (c < 0) continue;
      mass += t.mass[c]!;
      mx += t.mx[c]! * t.mass[c]!;
      my += t.my[c]! * t.mass[c]!;
    }
    t.mass[q] = mass;
    t.mx[q] = mass ? mx / mass : 0;
    t.my[q] = mass ? my / mass : 0;
  }
  return t;
}

const stack = { items: new Int32Array(256) };

export function tick(layout: GraphLayout, forces: GraphForces): void {
  const { count, x, y, vx, vy, pinned } = layout;
  if (count === 0) {
    layout.alpha = 0;
    return;
  }
  layout.alpha += (layout.alphaTarget - layout.alpha) * ALPHA_DECAY;
  const alpha = layout.alpha;

  // Links pull toward a rest length; the bias moves the less-linked end more.
  // Each link's rest length varies by up to a fifth, fixed per link, so a hub's
  // neighbours scatter around it instead of lining up in rings.
  const distance = 20 + forces.distance * 120;
  const linkScale = forces.link * 2;
  for (let l = 0; l < layout.source.length; l++) {
    const s = layout.source[l]!, t = layout.target[l]!;
    let dx = x[t]! + vx[t]! - x[s]! - vx[s]!;
    let dy = y[t]! + vy[t]! - y[s]! - vy[s]!;
    let length = Math.hypot(dx, dy) || 1e-6;
    const rest = distance * (0.8 + 0.4 * ((Math.imul(l, 2654435761) >>> 0) / 4294967296));
    length = ((length - rest) / length) * alpha * layout.linkStrength[l]! * linkScale;
    dx *= length;
    dy *= length;
    const bias = layout.linkBias[l]!;
    vx[t] = vx[t]! - dx * bias;
    vy[t] = vy[t]! - dy * bias;
    vx[s] = vx[s]! + dx * (1 - bias);
    vy[s] = vy[s]! + dy * (1 - bias);
  }

  // Many-body repulsion: far quads act as one mass.
  const t = buildTree(layout);
  const strength = -(10 + forces.repel * 140) * alpha;
  let items = stack.items;
  if (items.length < t.used) items = stack.items = new Int32Array(t.used * 2);
  for (let i = 0; i < count; i++) {
    const xi = x[i]!, yi = y[i]!;
    let fx = 0, fy = 0, top = 0;
    items[top++] = 0;
    while (top > 0) {
      const q = items[--top]!;
      const dx = t.mx[q]! - xi, dy = t.my[q]! - yi;
      let d2 = dx * dx + dy * dy;
      const p = t.point[q]!;
      if (p >= 0) {
        for (let j = p; j >= 0; j = t.next[j]!) {
          if (j === i) continue;
          let jx = x[j]! - xi, jy = y[j]! - yi, jd2 = jx * jx + jy * jy;
          if (jd2 < 1e-6) {
            // Nudge coincident points apart along a direction from their indexes.
            jx = ((i * 7 + j * 13) % 11) / 11 - 0.5;
            jy = ((i * 11 + j * 7) % 13) / 13 - 0.5;
            jd2 = jx * jx + jy * jy;
          }
          if (jd2 < 1) jd2 = Math.sqrt(jd2);
          fx += (jx * strength) / jd2;
          fy += (jy * strength) / jd2;
        }
        continue;
      }
      const size = t.size[q]!;
      if ((size * size) / THETA2 < d2) {
        if (d2 < 1) d2 = Math.sqrt(d2);
        fx += (dx * strength * t.mass[q]!) / d2;
        fy += (dy * strength * t.mass[q]!) / d2;
        continue;
      }
      for (let k = 0; k < 4; k++) {
        const c = t.child[q * 4 + k]!;
        if (c >= 0) {
          if (top >= items.length) {
            const grown = new Int32Array(items.length * 2);
            grown.set(items);
            items = stack.items = grown;
          }
          items[top++] = c;
        }
      }
    }
    vx[i] = vx[i]! + fx;
    vy[i] = vy[i]! + fy;
  }

  const center = forces.center * 0.08 * alpha;
  for (let i = 0; i < count; i++) {
    if (pinned[i]) {
      vx[i] = 0;
      vy[i] = 0;
      continue;
    }
    const pull = layout.lonely[i] ? center * LONELY_PULL : center;
    vx[i] = (vx[i]! - x[i]! * pull) * VELOCITY_KEEP;
    vy[i] = (vy[i]! - y[i]! * pull) * VELOCITY_KEEP;
    x[i] = x[i]! + vx[i]!;
    y[i] = y[i]! + vy[i]!;
  }
}

// The layout runs in a worker so settling never holds up the main thread.
// Positions travel as interleaved x, y in one of two Float32Array buffers. The
// renderer keeps the one it last drew and hands the other back after drawing
// the next, so the worker ticks at most once per drawn frame and stops when
// drawing stops.
export type LayoutRequest =
  | { type: "model"; generation: number; x: Float64Array; y: Float64Array; source: Uint32Array; target: Uint32Array; alpha: number }
  | { type: "frame"; generation: number; positions: Float32Array }
  | { type: "forces"; forces: GraphForces }
  | { type: "reduced"; reduced: boolean }
  | { type: "visible"; visible: boolean }
  | { type: "pin"; index: number; x: number; y: number }
  | { type: "release"; index: number };

export type LayoutFrame = { generation: number; positions: Float32Array; settled: boolean };

export function createLayoutEngine(post: (frame: LayoutFrame) => void, later: (run: () => void) => void) {
  let layout: GraphLayout | null = null;
  let generation = -1;
  let forces = DEFAULT_FORCES;
  let reduced = false;
  let visible = true;
  let free: Float32Array | null = null;
  let scheduled = false;

  function schedule(): void {
    if (scheduled || !layout || !free || !visible || settled(layout)) return;
    scheduled = true;
    later(run);
  }

  function run(): void {
    scheduled = false;
    if (!layout || !free || !visible || settled(layout)) return;
    if (reduced && layout.alphaTarget === 0) {
      // Settle out of sight in short slices, so new requests still arrive,
      // then post one still picture.
      const end = performance.now() + 30;
      while (!settled(layout) && performance.now() < end) tick(layout, forces);
      if (!settled(layout)) {
        scheduled = true;
        later(run);
        return;
      }
      layout.vx.fill(0);
      layout.vy.fill(0);
    } else {
      tick(layout, forces);
    }
    const positions = free;
    free = null;
    for (let i = 0; i < layout.count; i++) {
      positions[i * 2] = layout.x[i]!;
      positions[i * 2 + 1] = layout.y[i]!;
    }
    post({ generation, positions, settled: settled(layout) });
  }

  return {
    receive(request: LayoutRequest): void {
      switch (request.type) {
        case "model":
          generation = request.generation;
          layout = createLayout(request.x, request.y, request.source, request.target, request.alpha);
          free = new Float32Array(layout.count * 2);
          break;
        case "frame":
          if (request.generation === generation) free = request.positions;
          break;
        case "forces":
          forces = request.forces;
          if (layout) reheat(layout, 0.5);
          break;
        case "reduced":
          reduced = request.reduced;
          break;
        case "visible":
          visible = request.visible;
          break;
        case "pin":
          if (!layout) break;
          layout.pinned[request.index] = 1;
          layout.x[request.index] = request.x;
          layout.y[request.index] = request.y;
          if (!reduced) {
            layout.alphaTarget = 0.25;
            reheat(layout, 0.25);
          }
          break;
        case "release":
          if (!layout) break;
          layout.pinned[request.index] = 0;
          layout.alphaTarget = 0;
          break;
      }
      schedule();
    },
  };
}
