// Coarse relative time for ledgers such as Notices and automation runs.
// Recomputed on every render; a surface that stays open ticks to keep its
// labels honest between updates.
export function relativeTime(thenMs: number): string {
  const elapsedMs = Math.max(0, Date.now() - thenMs);
  const deltaMinutes = Math.floor(elapsedMs / 60_000);
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return new Date(thenMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
