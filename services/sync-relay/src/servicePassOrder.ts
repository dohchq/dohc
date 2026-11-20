/**
 * Plans one pass of the live host over `targets`, at most `limit` visits, taking the turn up at `from`.
 *
 * `next()` gives the visit to make now, or undefined once the pass is over. A wanted target comes before the
 * turn, also when it became wanted during the pass. A pass makes at most `floor(limit / 2)` wanted visits, so
 * the turn still goes round. A turn visit carries `turn`, where the turn stands once it is made. A wanted
 * visit carries none. No target is visited twice in a pass.
 */
export function passPlan<T>(
  targets: readonly T[],
  from: number,
  limit: number,
  wanted: (target: T) => boolean,
): { next(): { target: T; turn?: number } | undefined } {
  const visited = new Set<T>();
  const visits = Math.min(limit, targets.length);
  const wantedVisitsAllowed = Math.floor(limit / 2);
  let wantedVisits = 0;
  let cursor = targets.length === 0 ? 0 : from % targets.length;
  let passedInTurn = 0;
  return {
    next() {
      if (visited.size >= visits) return undefined;
      if (wantedVisits < wantedVisitsAllowed) {
        const target = targets.find((candidate) => !visited.has(candidate) && wanted(candidate));
        if (target !== undefined) {
          wantedVisits++;
          visited.add(target);
          return { target };
        }
      }
      while (passedInTurn < targets.length) {
        const target = targets[cursor]!;
        cursor = (cursor + 1) % targets.length;
        passedInTurn++;
        if (visited.has(target)) continue;
        visited.add(target);
        return { target, turn: cursor };
      }
      return undefined;
    },
  };
}
