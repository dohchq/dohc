export function ipcErrorMessage(error: unknown, fallback?: string): string {
  const raw = error instanceof Error ? error.message : fallback === undefined ? String(error) : "";
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return fallback === undefined ? message : message.trim() || fallback;
}
