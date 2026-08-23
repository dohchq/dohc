/** A mutation timeout can mean the daemon applied the request but lost its reply. */
export function isEngineTransportFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "transport-error") return true;
    current = record.cause;
  }
  return false;
}
