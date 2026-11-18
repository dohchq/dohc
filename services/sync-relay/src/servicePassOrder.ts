/**
 * The targets one pass of the live host visits.
 *
 * A pass visits at most `limit` targets, in turn from `from`, so every target is reached however many there
 * are. A target someone is waiting for goes first: after a restart no note is ready, and the note a person
 * has open would otherwise wait for its turn behind every other. Wanted targets take at most half of a
 * pass. The rest still goes round in turn, so no stream of requests can keep another target from its turn.
 *
 * `first` are the wanted targets. `turn` are the rest, each with where the turn stands once it is visited.
 * The caller moves the turn on as it visits, so a pass that ends early loses no target its turn.
 */
export function passOrder<T>(
  targets: readonly T[],
  from: number,
  limit: number,
  wanted: (target: T) => boolean,
): { first: T[]; turn: Array<{ target: T; next: number }> } {
  if (targets.length === 0) return { first: [], turn: [] };
  const first = targets.filter(wanted).slice(0, Math.floor(limit / 2));
  const turn: Array<{ target: T; next: number }> = [];
  let next = from % targets.length;
  for (
    let seen = 0;
    first.length + turn.length < Math.min(limit, targets.length) && seen < targets.length;
    seen++
  ) {
    const target = targets[next]!;
    next = (next + 1) % targets.length;
    if (!first.includes(target)) turn.push({ target, next });
  }
  return { first, turn };
}
