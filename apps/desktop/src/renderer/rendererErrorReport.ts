import type { RendererErrorPayload, RendererThrown } from "../ipc/bridgeContract";

/**
 * Hands an error to main for an error report. Only the class and the stack's
 * "at" lines go: main keeps the class when it is on a known list and a
 * frame only inside dohc's own code, and sends nothing unless the person's
 * switch allows it. The message never leaves the window. This never throws.
 */
export function reportRendererError(origin: RendererErrorPayload["origin"], error: unknown): void {
  try {
    void window.dohcDesktop?.reportRendererError({ origin, error: thrown(error) }).catch(() => undefined);
  } catch {
    // A report must not add a second failure.
  }
}

function thrown(error: unknown): RendererThrown {
  if (!(error instanceof Error)) return { type: error === null ? "object" : typeof error };
  const stack = (error.stack ?? "").split("\n").filter((line) => /^\s*at\s/.test(line)).join("\n");
  return { name: error.name.slice(0, 100), stack: stack.slice(0, 16_000) };
}
