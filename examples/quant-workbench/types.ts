import type { LagPoint, Series, Snapshot } from "./report/model";

export type Point = [ago: number, value: number];
export type Pair = { day: string; y_day: string; x: number; y: number };
export type Line = [[number, number], [number, number]];
export type CatalogEntry = Series & {
  start: string;
  end: string;
  count: number;
  latest: number;
  latest_at: string;
  spark: Point[];
};
export type Overview = {
  series: CatalogEntry[];
  total: number;
  matches: number;
  shown: number;
  observations: number;
  batches: number;
  shortcuts: boolean;
};
export type Comparison = {
  lag: number;
  r: number | null;
  line: Line | null;
  detrended: number | null;
  n: number;
  effective: number | null;
  points: Pair[];
};
export type Outlier = {
  id: number;
  series_id: string;
  observed_at: string;
  value: number;
  mean: number;
  z: number;
};
export type Analysis = { rollups: Snapshot; profile: LagPoint[] | null; outliers: Outlier[] };
export type Range = { start: string; end: string };
export type Preset = "30D" | "90D" | "1Y" | "All";
