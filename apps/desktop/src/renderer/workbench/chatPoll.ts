// A poll drafted in the composer: the message is its question and these are
// its choices. The limits match the engine's, so the composer stops a choice
// the engine would refuse instead of letting the send fail.
export const MAX_POLL_CHOICES = 12;
export const MAX_POLL_CHOICE_LENGTH = 200;

export type PollDraft = readonly string[];

export const NEW_POLL: PollDraft = ["", ""];

// A poll in a composer. Removing it closes it and keeps its choices, so
// opening a poll again brings them back. The owner of the draft drops it
// when the message is sent or its conversation changes.
export interface ComposerPollDraft {
  choices: PollDraft;
  open: boolean;
}

// The choices of an open poll, the ones Send asks; null when it is closed.
export function openPollChoices(poll: ComposerPollDraft | null | undefined): PollDraft | null {
  return poll?.open ? poll.choices : null;
}

// Trims as the engine's Rust `str::trim` does: Unicode White_Space, which
// takes U+0085 and keeps U+FEFF, unlike JavaScript's `trim`.
export function trimChoice(choice: string): string {
  return choice.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

// The indexes of choices that repeat an earlier one once trimmed.
export function repeatedPollChoices(choices: PollDraft): ReadonlySet<number> {
  const seen = new Set<string>();
  const repeated = new Set<number>();
  choices.forEach((choice, index) => {
    const trimmed = trimChoice(choice);
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) repeated.add(index);
    seen.add(trimmed);
  });
  return repeated;
}

// The choices to send, trimmed with blanks dropped, or null while the engine
// would refuse them: fewer than two, too long, more than one line, or a repeat.
export function pollChoicesToSend(choices: PollDraft): string[] | null {
  const trimmed = choices.map(trimChoice).filter((choice) => choice.length > 0);
  if (trimmed.length < 2 || trimmed.length > MAX_POLL_CHOICES) return null;
  if (trimmed.some((choice) => choice.length > MAX_POLL_CHOICE_LENGTH || /[\r\n]/u.test(choice))) return null;
  return new Set(trimmed).size === trimmed.length ? trimmed : null;
}

// The / catalog's query: a / at the start of a word, then letters, with the
// word ending at the caret. So `https://`, `a/b`, a / inside a mention, and
// the start of a path such as `/poll/results.md` never open it.
export function activeCatalogQuery(value: string, caret: number): { start: number; query: string } | null {
  const end = Math.max(0, Math.min(caret, value.length));
  if (end < value.length && !/\s/u.test(value[end]!)) return null;
  const before = value.slice(0, end);
  const match = /(^|\s)\/(\p{L}*)$/u.exec(before);
  if (!match) return null;
  return { start: match.index + match[1]!.length, query: match[2]! };
}
