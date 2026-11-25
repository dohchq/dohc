export type Series = {
  id: string;
  slug: string;
  name: string;
  unit: string;
  domain: string;
};

export type Bar = {
  bucket: string;
  count: number;
  mean: number;
  total: number;
  low: number;
  high: number;
  open: number;
  close: number;
  ma7: number | null;
  ma30: number | null;
};

export type Grain = "day" | "week" | "month" | "year";
export type LagPoint = { lag: number; n: number; effective: number | null; r: number | null };
export type Snapshot = {
  start: string;
  end: string;
  grain: Grain;
  series: Array<Series & { bars: Bar[] }>;
  comparison?: LagPoint;
};
export type SavedSnapshot = Snapshot & {
  changes: Array<{ first: number; last: number } | null>;
};
export type Report = { title: string; body: string; createdAt: number; snapshot: SavedSnapshot };
export type Finding =
  | (LagPoint & { kind: "few" | "constant" })
  | (LagPoint & { kind: "fit"; r: number; ci: readonly [number, number] | null });
export type Overlays = { ma7: boolean; ma30: boolean };
export type Focus = { day: string; seriesId: string; value: number; at: string };

export const DAY = 86_400_000;
export const MIN_PAIRS = 10;
export const AXIS_COLORS = ["var(--sb-left)", "var(--sb-right)"] as const;

export function interval(r: number, n: number | null) {
  if (n === null || n < 4) return null;
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const spread = 1.96 / Math.sqrt(n - 3);
  return [Math.tanh(z - spread), Math.tanh(z + spread)] as const;
}

export function summarize(point: LagPoint): Finding {
  if (point.r === null || point.n < MIN_PAIRS)
    return { ...point, kind: point.n < MIN_PAIRS ? "few" : "constant" };
  return { ...point, kind: "fit", r: point.r, ci: interval(point.r, point.effective) };
}

export function bucketEnd(day: string, grain: Grain) {
  const date = new Date(day);
  if (grain === "week") date.setUTCDate(date.getUTCDate() + 6);
  if (grain === "month") date.setUTCMonth(date.getUTCMonth() + 1, 0);
  if (grain === "year") date.setUTCFullYear(date.getUTCFullYear() + 1, 0, 0);
  return date.toISOString().slice(0, 10);
}

export function bucketStart(day: string, grain: Grain) {
  const date = new Date(day);
  if (grain === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (grain === "month") date.setUTCDate(1);
  if (grain === "year") date.setUTCMonth(0, 1);
  return date.getTime();
}

export const GRAIN_NAMES: Record<Grain, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};
