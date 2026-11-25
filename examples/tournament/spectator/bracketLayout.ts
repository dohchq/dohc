import {
  losersRounds,
  winnersRounds,
  type BracketSide,
  type Court,
  type Match,
  type Tournament,
} from "./model";

export const NODE_W = 220;
export const ROW_H = 28;
export const NODE_H = ROW_H * 2;
export const GAP_X = 72;
export const CHAMP_W = 184;
export const GRID = 24;
export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 1.6;
const UNIT = 84;
const PAD_X = 40;
const PAD_Y = 28;
const LANE_GAP = 76;
const GUTTER = 40;

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Spot {
  x: number;
  y: number;
}

export interface Column {
  key: string;
  index: number;
  bracket: BracketSide;
  round: number;
  top: number;
}

export interface Layout {
  at: Map<string, Spot>;
  columns: Column[];
  lanes: Array<{ round: number; index: number }>;
  laneTop: number | null;
  champion: Spot;
  width: number;
  height: number;
}

export const colX = (index: number) => PAD_X + index * (NODE_W + GAP_X);
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export const readableZoom = (width: number) =>
  width < 600 ? 1 : clamp(width / (3 * NODE_W + 2 * GAP_X + 48), 0.6, 1);

export function inView(view: View, spot: Spot, box: { w: number; h: number }) {
  const left = view.x + spot.x * view.k;
  const top = view.y + (spot.y - NODE_H / 2) * view.k;
  return (
    left >= 8 &&
    left + NODE_W * view.k <= box.w - 8 &&
    top >= 8 &&
    top + NODE_H * view.k <= box.h - 8
  );
}

const spansOf = (layout: Layout) => [
  ...[...new Set([...layout.at.values()].map((spot) => spot.x))].map((left) => [
    left,
    left + NODE_W,
  ]),
  [layout.champion.x, layout.champion.x + CHAMP_W],
];

function snapRight(layout: Layout, k: number, x: number, w: number) {
  if (w < 600) return { k, x, cut: null };
  const cut = spansOf(layout).find(
    ([left, right]) => x + left! * k < w - 8 && x + right! * k > w - 8,
  );
  if (!cut) return { k, x, cut: null };
  const start = (GUTTER - x) / k;
  const snug = (w - 16 - GUTTER) / (cut[1]! - start);
  if (snug < 0.6) return { k, x, cut: cut[0]! };
  const fitted = Math.min(k, snug);
  return { k: fitted, x: GUTTER - start * fitted, cut: null };
}

export function layoutOf(tournament: Tournament | null, matches: Match[]): Layout {
  const size = tournament?.bracketSize ?? 2;
  const winners = tournament ? winnersRounds(tournament) : 1;
  const losers = tournament ? losersRounds(tournament) : 0;
  const at = new Map<string, Spot>();
  const winnersY = (round: number, slot: number) => PAD_Y + (slot - 0.5) * 2 ** (round - 1) * UNIT;
  const losersTop = losers > 0 ? PAD_Y + (size / 2) * UNIT + LANE_GAP : null;
  const losersY = (round: number, slot: number) =>
    (losersTop ?? 0) + (slot - 0.5) * 2 ** (Math.ceil(round / 2) - 1) * UNIT;
  const winnersCol = (round: number) => (losers > 0 && round > 1 ? 2 * round - 3 : round - 1);
  const finalIndex = Math.max(winners, losers);
  const crownY = winnersY(winners, 1);
  for (const match of matches) {
    if (match.bracket === "winners")
      at.set(match.id, { x: colX(winnersCol(match.round)), y: winnersY(match.round, match.slot) });
    else if (match.bracket === "losers")
      at.set(match.id, { x: colX(match.round - 1), y: losersY(match.round, match.slot) });
    else at.set(match.id, { x: colX(finalIndex + match.round - 1), y: crownY });
  }
  const columns: Column[] = [];
  for (let index = 0; index < winners; index += 1)
    columns.push({
      key: `w${index}`,
      index: winnersCol(index + 1),
      bracket: "winners",
      round: index + 1,
      top: winnersY(index + 1, 1),
    });
  for (let index = 0; index < losers; index += 1)
    columns.push({
      key: `l${index}`,
      index,
      bracket: "losers",
      round: index + 1,
      top: losersY(index + 1, 1),
    });
  if (losers > 0)
    for (const round of [1, 2])
      columns.push({
        key: `f${round}`,
        index: finalIndex + round - 1,
        bracket: "final",
        round,
        top: crownY,
      });
  const championIndex = losers > 0 ? finalIndex + 2 : winners;
  return {
    at,
    columns,
    lanes: Array.from({ length: losers }, (_, index) => ({ round: index + 1, index })),
    laneTop: losersTop === null ? null : losersTop - LANE_GAP + 18,
    champion: { x: colX(championIndex), y: crownY },
    width: colX(championIndex) + CHAMP_W + PAD_X,
    height:
      (losersTop === null ? PAD_Y + (size / 2) * UNIT : losersTop + (size / 4) * UNIT) + PAD_Y,
  };
}

export function fitView(layout: Layout, w: number, h: number): View {
  const k = clamp(Math.min(w / layout.width, h / layout.height), MIN_ZOOM, 1);
  return {
    k,
    x: Math.max(0, (w - layout.width * k) / 2),
    y: Math.max(0, (h - layout.height * k) / 2),
  };
}

function busyView(layout: Layout, active: Spot[], w: number, h: number): View | null {
  const nearest = (values: number[], ok: (value: number) => boolean, origin: number) =>
    values.filter(ok).sort((one, two) => Math.abs(one - origin) - Math.abs(two - origin))[0];
  const spans = spansOf(layout);
  const left = Math.min(...active.map((spot) => spot.x));
  const edge = Math.max(...active.map((spot) => spot.x)) + NODE_W;
  const right = Math.min(layout.width, edge + NODE_W + GAP_X);
  let top = Math.min(...active.map((spot) => spot.y - NODE_H / 2)) - 18;
  let bottom = Math.max(...active.map((spot) => spot.y + NODE_H / 2));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fitted = Math.min(1, (w - 2 * GUTTER) / (right - left), (h - 16) / (bottom - top));
    if (fitted < 0.75) return null;
    const most = Math.min(1, (w - GUTTER - 8) / (edge - left), (h - 4) / (bottom - top));
    const tornRight = (zoom: number) => {
      const at = GUTTER - left * zoom;
      return spans.some(([a, b]) => at + (a! - 28) * zoom < w && at + b! * zoom > w);
    };
    const k =
      [
        fitted,
        ...spans.flatMap(([a, b]) => [
          (w + 2 - GUTTER) / (a! - 28 - left),
          (w - 2 - GUTTER) / (b! - left),
        ]),
      ]
        .filter((zoom) => Number.isFinite(zoom) && zoom >= 0.75 && zoom <= Math.max(most, fitted))
        .sort((one, two) => Math.abs(one - fitted) - Math.abs(two - fitted))
        .find((zoom) => !tornRight(zoom)) ?? fitted;
    const x = GUTTER - left * k;
    const cards = [...layout.at.values()]
      .filter((spot) => x + (spot.x + NODE_W) * k > 0 && x + spot.x * k < w)
      .map((spot) => [spot.y - NODE_H / 2 - 18, spot.y + NODE_H / 2] as const);
    const tornTop = (y: number) => cards.some(([a, b]) => y + a * k < 0 && y + b * k > 0);
    const tornY = (y: number) =>
      cards.filter(
        ([a, b]) => (y + a * k < 0 && y + b * k > 0) || (y + a * k < h && y + b * k > h),
      );
    const base = (h - (bottom - top) * k) / 2 - top * k;
    const placesY = [
      base,
      ...cards.flatMap(([a, b]) => [2 - a * k, -2 - b * k, h - 2 - b * k, h + 2 - a * k]),
    ];
    const showsY = (value: number) =>
      value + top * k >= 0 && value + bottom * k <= h && !tornTop(value);
    const y = nearest(placesY, (value) => showsY(value) && tornY(value).length === 0, base);
    if (y !== undefined) return { k, x, y };
    const torn = tornY(base);
    const wider = [
      Math.min(top, ...torn.map(([a]) => a)),
      Math.max(bottom, ...torn.map(([, b]) => b)),
    ] as const;
    if (Math.min(1, (h - 16) / (wider[1] - wider[0])) < 0.75)
      return { k, x, y: nearest(placesY, showsY, base) ?? base };
    [top, bottom] = wider;
  }
  return null;
}

export function initialView(
  layout: Layout,
  matches: Match[],
  courts: Court[],
  w: number,
  h: number,
): View {
  if (Math.min(w / layout.width, h / layout.height) >= 0.8) return fitView(layout, w, h);
  const open = matches.filter((match) => match.status === "live" || match.status === "ready");
  const active = open.flatMap((match) => layout.at.get(match.id) ?? []);
  const busy = w >= 600 && active.length > 1 ? busyView(layout, active, w, h) : null;
  if (busy) return busy;
  const onCourt = courts.find((court) => court.matchId)?.matchId;
  const target = open.find((match) => match.id === onCourt) ?? open[0] ?? matches.at(-1);
  const near = open.filter((match) => match.bracket === target?.bracket);
  const first = near.length
    ? Math.min(...near.map((match) => layout.at.get(match.id)?.x ?? PAD_X))
    : PAD_X;
  const y = target ? (layout.at.get(target.id)?.y ?? PAD_Y) : PAD_Y;
  const lane = layout.laneTop;
  const losers = target?.bracket === "losers" && lane !== null;
  const targetX = target ? (layout.at.get(target.id)?.x ?? PAD_X) : PAD_X;
  const zoom = readableZoom(w);
  const snapped = snapRight(
    layout,
    zoom,
    w < 600
      ? GUTTER - targetX * zoom
      : Math.min(GUTTER - first * zoom, w - 16 - (targetX + NODE_W) * zoom),
    w,
  );
  const k = snapped.k;
  const x = snapped.cut === null ? snapped.x : w - snapped.cut * k;
  const above = lane === null ? -1 : h - lane * k;
  const base = losers
    ? 8 - lane * k
    : above >= 0
      ? Math.min(above, 32)
      : Math.min(32, h / 2 - y * k);
  const floor = h - 4;
  const flag = 18 * k;
  const spots = [...layout.at.values()];
  const topmost = Math.min(...spots.map((spot) => (spot.y - NODE_H / 2) * k)) - flag;
  const bottom = Math.max(...spots.map((spot) => (spot.y + NODE_H / 2) * k));
  const placed =
    losers || lane === null || base + bottom <= floor
      ? base
      : Math.max(4 - topmost, Math.min(base, floor - 40 - lane * k));
  const tops = spots.map((spot) => placed + (spot.y - NODE_H / 2) * k);
  const straddles = (shift: number) =>
    tops.some((top) => top + shift - flag < floor && top + shift + NODE_H * k > floor);
  const nudge = [
    0,
    ...tops.flatMap((top) => [floor - top + flag + 2, floor - top - NODE_H * k - 2]),
  ]
    .filter((shift) => Math.abs(shift) <= 96 && placed + topmost + shift >= 4)
    .sort((left, right) => Math.abs(left) - Math.abs(right))
    .find((shift) => !straddles(shift));
  return { k, x, y: placed + (nudge ?? 0) };
}

export function columnView(
  layout: Layout,
  matches: Match[],
  column: Column,
  from: Column,
  to: Column | null,
  current: View,
  w: number,
  h: number,
): View {
  const ys = matches
    .filter((match) => match.bracket === column.bracket && match.round === column.round)
    .map((match) => layout.at.get(match.id)?.y ?? column.top);
  const top = Math.min(column.top, ...ys) - NODE_H / 2;
  const bottom = Math.max(column.top, ...ys) + NODE_H / 2;
  const lane = column.bracket === "losers" ? layout.laneTop : null;
  const end = layout.height - PAD_Y;
  const readable = Math.max(current.k, readableZoom(w));
  if (to && lane !== null) {
    const span = colX(to.index) - colX(from.index) + NODE_W;
    const whole = Math.min(1.15, (w - 2 * GUTTER) / span, (h - 16) / (end - lane));
    if (whole >= 0.7)
      return {
        k: whole,
        x: (w - span * whole) / 2 - colX(from.index) * whole,
        y: 8 - lane * whole,
      };
  }
  const zoom =
    lane === null ? readable : Math.max(readable, Math.min(1.15, (h - 16) / (end - lane)));
  const anchor =
    (colX(column.index) - colX(from.index) + NODE_W) * zoom + 2 * GUTTER <= w ? from : column;
  const { k, x } = snapRight(
    layout,
    zoom,
    Math.max(GUTTER - colX(anchor.index) * zoom, Math.min(w - layout.width * zoom, GUTTER)),
    w,
  );
  const tall = (bottom - top) * k + 80 > h;
  return {
    k,
    x,
    y:
      lane !== null && (bottom - lane) * k + 8 <= h
        ? 8 - lane * k
        : tall
          ? 40 - top * k
          : h / 2 - ((top + bottom) / 2) * k,
  };
}
