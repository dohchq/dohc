import { MIN_PAIRS, interval, type LagPoint } from "./report/model";

export const lagText = (lag: number) => `${lag > 0 ? "+" : lag < 0 ? "−" : ""}${Math.abs(lag)} d`;
export const dayT = (lag: number) => (lag ? `t${lag > 0 ? "+" : "−"}${Math.abs(lag)}` : "t");

export function supported(profile: LagPoint[]) {
  const most = profile.reduce((max, point) => Math.max(max, point.n), 0);
  return Math.max(MIN_PAIRS, Math.ceil((most * 2) / 3));
}

export function peakLag(profile: LagPoint[], floor = supported(profile)) {
  return profile.reduce<LagPoint | null>(
    (best, point) =>
      point.r !== null &&
      point.n >= floor &&
      (best?.r == null || Math.abs(point.r) > Math.abs(best.r))
        ? point
        : best,
    null,
  );
}

export function strength(r: number | null, n: number, effective: number | null) {
  if (n < MIN_PAIRS) return { label: "Too few pairs", tone: "none" };
  if (r === null) return { label: "One series is constant", tone: "none" };
  if (effective === null) return { label: "Too few consecutive days", tone: "none" };
  const size = Math.abs(r);
  const range = interval(r, effective);
  if (!range) return { label: "Too few independent days", tone: "none" };
  if (range[0] <= 0 && range[1] >= 0) return { label: "No clear correlation", tone: "none" };
  if (size < 0.1) return { label: "Little linear correlation", tone: "none" };
  const floor = Math.min(Math.abs(range[0]), Math.abs(range[1]));
  const word =
    floor < 0.3 ? "Weak" : floor < 0.5 ? "Moderate" : floor < 0.8 ? "Strong" : "Very strong";
  return {
    label: `${word} ${r > 0 ? "positive" : "negative"}`,
    tone: floor < 0.3 ? "weak" : "strong",
  };
}
