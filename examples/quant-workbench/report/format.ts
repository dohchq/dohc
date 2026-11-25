import { formatCents } from "dohc/money";
import { DAY, type Grain } from "./model";

const fixed = Array.from(
  { length: 9 },
  (_, digits) =>
    new Intl.NumberFormat("en", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: "negative",
    }),
);
const dollars = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  notation: "compact",
});
const signed = (text: string, value: number) => (value > 0 ? "+" + text : text.replace("-", "−"));
const HUGE = 1e15;
const exponent = (value: number, digits: number) => value.toExponential(digits).replace(/-/g, "−");
const dollar = (text: string, unit: string) =>
  unit === "USD" ? text.replace(/^(−?)/, "$1$") : text;

function valueDigits(scale: number) {
  const magnitude = Math.abs(scale);
  return magnitude >= 1000
    ? 0
    : magnitude >= 100
      ? 1
      : magnitude > 0 && magnitude < 0.1
        ? Math.min(8, 1 - Math.floor(Math.log10(magnitude)))
        : 2;
}

export function formatValue(value: number, unit = "", reference = value) {
  const scale = reference || value;
  const magnitude = Math.abs(scale);
  const size = Math.abs(value);
  if (
    size > 0 &&
    (Math.max(magnitude, size) >= HUGE ||
      (unit !== "USD" && (magnitude < 1e-7 || (size < 1e-7 && size > magnitude * 1e-12))))
  )
    return dollar(exponent(value, 2), unit);
  if (unit === "USD") {
    const cents = Math.round(value * 100);
    return (Number.isSafeInteger(cents) ? formatCents(cents) : dollars.format(value)).replace(
      "-",
      "−",
    );
  }
  return fixed[valueDigits(scale)].format(value).replace("-", "−");
}

export const formatR = (r: number) => formatValue(r, "", 1);

export function formatDelta(value: number, unit = "", scale = value) {
  return signed(formatValue(value, unit, scale), value);
}

export const visibleChange = (value: number, unit: string, scale: number) =>
  /[1-9]/.test(formatDelta(value, unit, scale));

function places(step: number, most = 8) {
  for (let digits = 0; digits <= most; digits++) {
    const scaled = step * 10 ** digits;
    if (Math.round(scaled) >= 1 && Math.abs(scaled - Math.round(scaled)) < 1e-6 * scaled)
      return digits;
  }
  return most + 1;
}

const SCALES = [
  { divisor: 1e12, suffix: "T", from: 1e12 },
  { divisor: 1e9, suffix: "B", from: 1e9 },
  { divisor: 1e6, suffix: "M", from: 1e6 },
  { divisor: 1e3, suffix: "k", from: 1e4 },
  { divisor: 1, suffix: "", from: 0 },
];

export function axisFormat({ ticks, step }: { ticks: number[]; step: number }, unit = "") {
  const top = Math.max(0, ...ticks.map(Math.abs));
  const { divisor, suffix } = SCALES.find(
    (scale) => top >= scale.from && (scale.divisor === 1 || places(step / scale.divisor) <= 2),
  )!;
  const digits = places(step / divisor);
  const scientific = digits > 8 || top >= HUGE;
  const mantissa = places(step / 10 ** Math.floor(Math.log10(top || step)), 15);
  const tagDigits = scientific
    ? mantissa + 1
    : divisor === 1
      ? Math.max(digits, unit === "USD" ? 2 : valueDigits(top))
      : digits + 1;
  const write = (value: number, decimals: number) => {
    const text = scientific
      ? exponent(value, decimals)
      : fixed[Math.min(8, decimals)].format(value / divisor).replace("-", "−") + suffix;
    return dollar(text, unit);
  };
  return {
    tick: (value: number) => write(value, scientific ? mantissa : digits),
    tag: (value: number) => write(value, tagDigits),
  };
}

export const formatInterval = ([low, high]: readonly [number, number]) =>
  `${formatR(low)} to ${formatR(high)}`;

export const unitSuffix = (unit: string) =>
  !unit || unit === "USD" ? "" : unit === "%" ? unit : " " + unit;

const shortDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longDate = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const monthYear = new Intl.DateTimeFormat("en", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthOnly = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export const formatShortDay = (day: string) => shortDate.format(Date.parse(day));
export const formatDay = (day: string) => fullDate.format(Date.parse(day));
export const formatRange = (start: string, end: string) =>
  start === end ? formatDay(start) : `${formatDay(start)} to ${formatDay(end)}`;

export function bucketLabel(day: string, grain: Grain) {
  const ms = Date.parse(day);
  if (grain === "day") return longDate.format(ms);
  if (grain === "week") return `Week of ${fullDate.format(ms)}`;
  if (grain === "month") return monthYear.format(ms);
  return String(new Date(ms).getUTCFullYear());
}

function niceStep(span: number, count: number) {
  const target = Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(span / target || 1));
  return [1, 2, 2.5, 5, 10]
    .map((unit) => unit * power)
    .filter((step, index, steps) => span / step <= target + 2 || index === steps.length - 1)
    .reduce((best, step) =>
      Math.abs(span / step - target) < Math.abs(span / best - target) ? step : best,
    );
}

function snap(value: number, step: number) {
  if (value === 0) return 0;
  const digits = Math.floor(Math.log10(Math.abs(value))) - Math.floor(Math.log10(step)) + 2;
  return Number(value.toPrecision(Math.min(21, Math.max(1, digits))));
}

export function niceDomain(values: number[], count = 5) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min)) return { domain: [0, 1] as const, ticks: [0, 0.5, 1], step: 0.5 };
  if (max - min <= Math.max(Math.abs(min), Math.abs(max)) * 1e-12) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const step = niceStep(max - min, count);
  const first = Math.ceil(min / step);
  const ticks = Array.from(
    { length: Math.min(50, Math.floor(max / step + 1e-9) - first + 1) },
    (_, i) => snap((first + i) * step, step),
  );
  return { domain: [min, max] as const, ticks, step };
}

function dayTicks(min: number, max: number, step: number) {
  const ticks: number[] = [];
  let tick = min;
  if (step >= 7) while (new Date(tick).getUTCDay() !== 1) tick += DAY;
  for (; tick <= max; tick += step * DAY) ticks.push(tick);
  return { ticks, months: false };
}

function monthTicks(min: number, max: number, step: number) {
  const ticks: number[] = [];
  const date = new Date(min);
  date.setUTCDate(1);
  date.setUTCMonth(Math.ceil(date.getUTCMonth() / step) * step);
  if (date.getTime() < min) date.setUTCMonth(date.getUTCMonth() + step);
  for (; date.getTime() <= max; date.setUTCMonth(date.getUTCMonth() + step))
    ticks.push(date.getTime());
  return { ticks, months: true };
}

function yearTicks(min: number, max: number, step: number) {
  const ticks: number[] = [];
  const first = Math.ceil(new Date(min).getUTCFullYear() / step) * step;
  for (let year = first; Date.UTC(year, 0, 1) <= max; year += step) {
    if (Date.UTC(year, 0, 1) >= min) ticks.push(Date.UTC(year, 0, 1));
  }
  return { ticks, months: true };
}

export function timeTicks(min: number, max: number, count: number) {
  const days = (max - min) / DAY;
  const options = [
    ...[1, 2, 3, 7, 14, 28].map((step) => [days / step, () => dayTicks(min, max, step)] as const),
    ...[1, 2, 3, 6].map((step) => [days / 31 / step, () => monthTicks(min, max, step)] as const),
    ...[1, 2, 5, 10, 25].map(
      (step) => [days / 366 / step, () => yearTicks(min, max, step)] as const,
    ),
  ];
  let denser: ReturnType<typeof dayTicks> | null = null;
  for (const [estimate, make] of options) {
    if (estimate > count + 6) {
      denser = null;
      continue;
    }
    const option = make();
    if (option.ticks.length <= count + 1)
      return option.ticks.length < 3 && denser && denser.ticks.length <= count + 2
        ? denser
        : option;
    denser = option;
  }
  return denser ?? options.at(-1)![1]();
}

export function tickLabel(ms: number, months: boolean) {
  if (!months) return shortDate.format(ms);
  return new Date(ms).getUTCMonth() === 0
    ? String(new Date(ms).getUTCFullYear())
    : monthOnly.format(ms);
}

const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
export const count = (value: number) => whole.format(value);
