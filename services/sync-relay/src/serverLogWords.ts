/**
 * The words the server may show for a refusal or failure, in its log and to a document's owner. Nothing else from an
 * error reaches either, since an error's message can name a file.
 */
export const KNOWN_REFUSAL_WORDS = [
  // Why a live document's activation keeps failing, when no engine code word says more.
  "activation-refused",
  "capture-over-budget",
  "deadline",
  "engine-refused",
  "relay-error",
] as const;
export type KnownRefusalWord = (typeof KNOWN_REFUSAL_WORDS)[number];

const known: ReadonlySet<string> = new Set(KNOWN_REFUSAL_WORDS);

/** The list's word for a refusal's head, if the list has it. */
export function knownRefusalWord(head: string): KnownRefusalWord | undefined {
  return known.has(head) ? (head as KnownRefusalWord) : undefined;
}

/** An engine refusal message's head: the part before the first ": ". The rest can name a file. */
export function refusalHead(message: string): string {
  return message.split(": ", 1)[0]!;
}
