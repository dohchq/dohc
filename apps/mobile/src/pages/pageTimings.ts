// The last page opens, each step in ms from the tap, for Settings in a build made with EXPO_PUBLIC_DOHC_TIMINGS=1.
export interface PageOpen {
  readonly name: string;
  readonly tap: number;
  read?: number;
  started?: number;
  painted?: number;
}

export function createPageTimings(now: () => number = Date.now, keep = 10) {
  const opens: PageOpen[] = [];
  let tapped: number | null = null;
  return {
    tap: () => void (tapped = now()),
    /** A page screen opened, from the last tap, or from now without one. Each step counts once. */
    open(name: string) {
      const open: PageOpen = { name, tap: tapped ?? now() };
      tapped = null;
      opens.unshift(open);
      opens.splice(keep);
      return (step: "read" | "started" | "painted") => void (open[step] ??= now() - open.tap);
    },
    opens: (): readonly PageOpen[] => opens,
  };
}

export const pageTimings =
  process.env.EXPO_PUBLIC_DOHC_TIMINGS === "1" ? createPageTimings() : null;
