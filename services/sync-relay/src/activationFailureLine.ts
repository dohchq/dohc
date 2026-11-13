import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";

const CODE_WORD = /^[a-z0-9-]+$/;

/**
 * An engine refusal's words for a log: its code word, the part of its message before the first ": ", and only when that
 * part is a code word; the rest can name a file.
 */
export function engineRefusalWords(message: string, code: string | undefined, method?: string): string {
  const head = message.split(": ", 1)[0]!;
  const word = CODE_WORD.test(head) ? head : "unrecognized-message";
  return `${word} (code ${code}${method === undefined ? "" : `, method ${method}`})`;
}

/** The server log's words for a failed activation step. An engine refusal shows only its `engineRefusalWords`. */
export function activationFailureLine(error: unknown): string {
  if (!(error instanceof EngineRequestError)) return error instanceof Error ? error.message : String(error);
  return engineRefusalWords(error.message, error.wireError?.code, error.method);
}
