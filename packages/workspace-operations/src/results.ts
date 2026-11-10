// A refusal the caller reads as one line. Failed results quote the message as
// their reason, so it carries the CLI's "dohc:" prefix itself.
export class OperationError extends Error {
  constructor(message: string) {
    super(message.startsWith("dohc:") ? message : `dohc: ${message}`);
    this.name = "OperationError";
  }
}

export function failure(error: unknown, fallback: string) {
  const reason = error instanceof Error ? error.message : fallback;
  return { ok: false as const, reason };
}

export function pathRejected(reason: string, path: string) {
  return { ok: false as const, reason: `path rejected (${reason}): ${path}` };
}
