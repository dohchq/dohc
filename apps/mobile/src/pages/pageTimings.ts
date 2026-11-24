// The last page opens of one sign-in, each step in ms from the tap, for Settings in a build made with
// EXPO_PUBLIC_DOHC_TIMINGS=1.
export interface PageOpen {
  readonly name: string;
  readonly tap: number;
  read?: number;
  started?: number;
  painted?: number;
}

export function createPageTimings(now: () => number = Date.now, keep = 10) {
  const opens: PageOpen[] = [];
  let owner: object | null = null;
  return {
    /** A page screen opened for `signIn`, tapped at `tap`, or now without one. Each step counts once. */
    open(name: string, signIn: object, tap = now()) {
      if (signIn !== owner) opens.length = 0;
      owner = signIn;
      const open: PageOpen = { name, tap };
      opens.unshift(open);
      opens.splice(keep);
      return (step: "read" | "started" | "painted") => void (open[step] ??= now() - open.tap);
    },
    opens: (signIn: object): readonly PageOpen[] => (signIn === owner ? opens : []),
  };
}

export const pageTimings =
  process.env.EXPO_PUBLIC_DOHC_TIMINGS === "1" ? createPageTimings() : null;
