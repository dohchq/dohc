import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";

const CODE_WORD = /^[a-z0-9-]+$/;

/**
 * The server log's words for a failed activation step. An engine refusal shows only its code word, the part of its
 * message before the first ": ", and only when that part is a code word; the rest can name a file.
 */
export function activationFailureLine(error: unknown): string {
  if (!(error instanceof EngineRequestError)) return error instanceof Error ? error.message : String(error);
  const head = error.message.split(": ", 1)[0]!;
  const word = CODE_WORD.test(head) ? head : "unrecognized-message";
  return `${word} (code ${error.wireError?.code}${error.method === undefined ? "" : `, method ${error.method}`})`;
}
