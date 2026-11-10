// A refusal the caller reads as one line. Failed results quote the message as
// their reason, so it carries the CLI's "dohc:" prefix itself.
export class OperationError extends Error {
  constructor(message: string) {
    super(message.startsWith("dohc:") ? message : `dohc: ${message}`);
    this.name = "OperationError";
  }
}

// How much of a failure's own message its reason keeps. "full" keeps any
// error's message, for a caller on the computer that runs the engine.
// "operation-only" keeps only an operation's own refusals, so nothing the
// engine says about its host reaches a caller elsewhere.
export type ErrorDetail = "full" | "operation-only";

export function failure(error: unknown, fallback: string, detail: ErrorDetail) {
  const reason = error instanceof Error && (detail === "full" || error instanceof OperationError) ? error.message : fallback;
  return { ok: false as const, reason };
}

export function pathRejected(reason: string, path: string) {
  return { ok: false as const, reason: `path rejected (${reason}): ${path}` };
}
