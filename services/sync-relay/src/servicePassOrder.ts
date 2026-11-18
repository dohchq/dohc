/**
 * The targets one pass of the live host visits, and where the next pass takes up.
 *
 * A pass visits at most `limit` targets, in turn from `from`, so every target is reached however many there
 * are. A target someone is waiting for goes first: after a restart no note is ready, and the note a person
 * has open would otherwise wait for its turn behind every other. Wanted targets take at most half of a
 * pass. The rest still goes round in turn, so no stream of requests can keep another target from its turn.
 */
export function passOrder<T>(
  targets: readonly T[],
  from: number,
  limit: number,
  wanted: (target: T) => boolean,
): { visit: T[]; next: number } {
  if (targets.length === 0) return { visit: [], next: from };
  const first = targets.filter(wanted).slice(0, Math.floor(limit / 2));
  const visit = [...first];
  let next = from % targets.length;
  for (
    let seen = 0;
    visit.length < Math.min(limit, targets.length) && seen < targets.length;
    seen++
  ) {
    const target = targets[next]!;
    next = (next + 1) % targets.length;
    if (!first.includes(target)) visit.push(target);
  }
  return { visit, next };
}
