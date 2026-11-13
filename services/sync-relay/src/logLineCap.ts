/**
 * Limits a log line to once a window per key, so someone who can trigger the
 * line cannot fill the log. A key logged within its window is held back and
 * counted; its next line reports that count as `repeated`. At most `maxKeys`
 * keys are remembered, and the oldest one's count is dropped first.
 */
export function createLogLineCap(windowMs = 60_000, maxKeys = 1024) {
  const lines = new Map<string, { until: number; held: number }>();
  /** The `repeated` count to log with this line, or undefined when it is held back. */
  return (key: string, nowMs: number): number | undefined => {
    const last = lines.get(key);
    if (last && nowMs < last.until) {
      last.held++;
      return undefined;
    }
    lines.delete(key);
    if (lines.size >= maxKeys) lines.delete(lines.keys().next().value!);
    lines.set(key, { until: nowMs + windowMs, held: 0 });
    return last?.held ?? 0;
  };
}
