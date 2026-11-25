export const HEX_SIZE = 40;
const SQRT3 = Math.sqrt(3);

export function hexKeyOf(q: number, r: number): string {
  return `${q},${r}`;
}

export function axialDistance(aq: number, ar: number, bq: number, br: number): number {
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - (bq + br))) / 2;
}

export function hexCenter(q: number, r: number): { x: number; y: number } {
  return { x: HEX_SIZE * SQRT3 * (q + r / 2), y: HEX_SIZE * 1.5 * r };
}

export function hexPoints(cx: number, cy: number, radius: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i - 30) * Math.PI) / 180;
    pts.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(" ");
}

export function arrowPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;
  const ux = dx / dist;
  const uy = dy / dist;
  const upward = uy < -0.3;
  const leftward = !upward && ux < -0.3;
  const start = upward || leftward ? 0.22 : 0.3;
  const reach = upward ? 0.43 : leftward ? 0.48 : 0.56;
  const shiftX = upward ? -Math.sign(ux) * Math.abs(uy) * 9 : 0;
  const shiftY = upward ? -Math.abs(ux) * 9 : 4;
  const sx = from.x + dx * start + shiftX;
  const sy = from.y + dy * start + shiftY;
  const ex = from.x + dx * reach + shiftX;
  const ey = from.y + dy * reach + shiftY;
  const head = `${(ex + ux * 8).toFixed(1)},${(ey + uy * 8).toFixed(1)} ${(ex - uy * 6).toFixed(1)},${(ey + ux * 6).toFixed(1)} ${(ex + uy * 6).toFixed(1)},${(ey - ux * 6).toFixed(1)}`;
  return { d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)}`, head };
}

export function countBadgeWidth(seat: 1 | 2 | null, units: number): number {
  return (seat === 2 ? 15 : 15.2) + (String(units).length - 1) * 6;
}
