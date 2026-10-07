import type { RendererErrorPayload, RendererThrown } from "../ipc/bridgeContract";

// Distinct errors a window hands to main before it stops, so a loop that
// keeps failing costs nothing more.
export const RENDERER_ERROR_REPORTS = 25;
const handed = new Set<string>();

/**
 * Hands an error to main for an error report. Only the class and the stack's
 * "at" lines go: main keeps the class when it is on a known list and a
 * frame only inside dohc's own code, and sends nothing unless the person's
 * switch allows it. The message never leaves the window. A repeat is not
 * handed again. This never throws.
 */
export function reportRendererError(origin: RendererErrorPayload["origin"], error: unknown): void {
  try {
    if (handed.size >= RENDERER_ERROR_REPORTS) return;
    const payload = { origin, error: thrown(error) };
    const key = JSON.stringify(payload);
    if (handed.has(key)) return;
    handed.add(key);
    void window.dohcDesktop?.reportRendererError(payload).catch(() => undefined);
  } catch {
    // A report must not add a second failure.
  }
}

function thrown(error: unknown): RendererThrown {
  if (!(error instanceof Error)) return { type: error === null ? "object" : typeof error };
  const stack = (error.stack ?? "").split("\n").filter((line) => /^\s*at\s/.test(line)).join("\n");
  return { name: error.name.slice(0, 100), stack: stack.slice(0, 16_000) };
}
