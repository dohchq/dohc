export const REST_GLOW = { light: 0.08, dark: 0.16 } as const;
export const GLOW_RADIUS_FACTOR = 2.6;
export const BUBBLE_OUTER_FACTOR = Math.hypot(0.95, 1.1);
export const MAX_GLOW_STRUCTURAL = 100;
export const MAX_CURVED_LINKS = 120;
export const HOVER_FLOW_MS = 1400;
export const APPROVAL_SURGE_MS = 950;

const OUTER_FACTOR: Record<string, number> = {
  bubble: BUBBLE_OUTER_FACTOR,
  square: 1.41,
  triangle: 1.35,
  diamond: 1.25,
  hexagon: 1.15,
};
export const outerRadius = (shape: string, r: number) => (OUTER_FACTOR[shape] ?? 1) * r;
export const isCurvedEdge = (curved: boolean, style: number) =>
  curved && (style === 1 || style === 2);

export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const s = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)?.[1];
  if (hex) {
    const n = parseInt(hex.length === 3 ? hex.replace(/./g, "$&$&") : hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})` : s;
}

export const quadControl = (x1: number, y1: number, x2: number, y2: number): [number, number] => [
  (x1 + x2) / 2 - (y2 - y1) * 0.12,
  (y1 + y2) / 2 + (x2 - x1) * 0.12,
];

export function quadAt(
  [x1, y1, x2, y2]: readonly [number, number, number, number],
  t: number,
): [number, number, number, number] {
  const [cx, cy] = quadControl(x1, y1, x2, y2);
  const mt = 1 - t;
  const dx = 2 * mt * (cx - x1) + 2 * t * (x2 - cx);
  const dy = 2 * mt * (cy - y1) + 2 * t * (y2 - cy);
  const len = Math.hypot(dx, dy) || 1;
  return [
    mt * mt * x1 + 2 * mt * t * cx + t * t * x2,
    mt * mt * y1 + 2 * mt * t * cy + t * t * y2,
    dx / len,
    dy / len,
  ];
}

export function createGlowSprites(colors: readonly string[]): (HTMLCanvasElement | null)[] {
  if (typeof document === "undefined") return colors.map(() => null);
  return colors.map((color) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (const [stop, a] of [
      [0, 1],
      [0.5, 0.35],
      [1, 0],
    ] as const)
      grad.addColorStop(stop, withAlpha(color, a));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  });
}

export type GlowLayer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export function ensureGlowLayer(layer: GlowLayer | null, w: number, h: number): GlowLayer | null {
  const canvas =
    layer?.canvas ?? (typeof document !== "undefined" ? document.createElement("canvas") : null);
  const ctx = layer?.ctx ?? canvas?.getContext("2d") ?? null;
  if (!canvas || !ctx) return null;
  const cw = Math.max(1, Math.ceil(w / 2)),
    ch = Math.max(1, Math.ceil(h / 2));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  ctx.clearRect(0, 0, cw, ch);
  return { canvas, ctx };
}

export function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  [x, y, ux, uy]: readonly [number, number, number, number],
  s: number,
): void {
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * s - uy * s * 0.55, y - uy * s + ux * s * 0.55);
  ctx.lineTo(x - ux * s + uy * s * 0.55, y - uy * s - ux * s * 0.55);
  ctx.closePath();
}

export function drawComet(
  ctx: CanvasRenderingContext2D,
  e: readonly [number, number, number, number],
  t: number,
  opts: { curved: boolean; color: string; head: string },
): void {
  const fade = Math.sin(t * Math.PI);
  if (fade <= 0.02 || Math.hypot(e[2] - e[0], e[3] - e[1]) < 1) return;
  const at = (u: number) =>
    opts.curved ? quadAt(e, u) : [e[0] + (e[2] - e[0]) * u, e[1] + (e[3] - e[1]) * u];
  const [hx, hy] = at(t),
    [tx, ty] = at(Math.max(0, t - 0.18));
  ctx.save();
  ctx.strokeStyle = opts.color;
  ctx.globalAlpha = fade * 0.85;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(tx!, ty!);
  ctx.lineTo(hx!, hy!);
  ctx.stroke();
  ctx.fillStyle = opts.head;
  ctx.globalAlpha = fade;
  ctx.beginPath();
  ctx.arc(hx!, hy!, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawRipple(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  baseR: number,
  maxR: number,
  t: number,
  color: string,
): void {
  if (t <= 0 || t >= 1) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = (1 - t) * 0.65;
  ctx.lineWidth = 2 * (1 - t * 0.6);
  ctx.beginPath();
  ctx.arc(x, y, baseR + (1 - (1 - t) ** 3) * maxR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
