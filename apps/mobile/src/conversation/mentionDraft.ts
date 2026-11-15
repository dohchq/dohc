import type { FieldChange, ReplaceAnswer, ReplaceRequest } from "../../modules/chat-composer";

// What the composer knows of its native field's editing, apart from how it looks: the latest report of its text,
// selection and composition, and the one range replacement it may have asked for. The field's text stays its own; a
// replacement is a request the field checks against itself, and answers once.

/** The field as one report saw it. */
export type FieldSnapshot = Pick<
  FieldChange,
  "text" | "revision" | "sequence" | "selectionStart" | "selectionEnd" | "composing"
>;

/** `next` when it is newer than `current`, by its report's sequence; otherwise `current`, so a stale report is dropped. */
export function latestSnapshot(current: FieldSnapshot | null, next: FieldChange): FieldSnapshot {
  if (current !== null && next.sequence <= current.sequence) return current;
  const { text, revision, sequence, selectionStart, selectionEnd, composing } = next;
  return {
    text,
    revision,
    sequence,
    selectionStart,
    selectionEnd,
    ...(composing === undefined ? {} : { composing }),
  };
}

/** Whether an input method is still composing text the field shows, which isn't text yet, so nothing sends it. */
export const composing = (snapshot: FieldSnapshot | null) => snapshot?.composing !== undefined;

/** A replacement of `start` until `end`, in UTF-16 code units, with the caret at `caret` in the text that results. */
export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly caret: number;
}

/**
 * Why a replacement can't be asked for. `pending`: the field hasn't answered the last. `selection`: the selection isn't
 * a caret alone at the range's end. `composing`: an input method is composing. `range`: the range or caret is outside
 * the text. `surrogate`: the range or caret splits a surrogate pair.
 */
export type ReplaceRefusal = "pending" | "selection" | "composing" | "range" | "surrogate";

/** Whether UTF-16 offset `at` of `text` splits a surrogate pair. */
function splits(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The request for `edit` of the field `snapshot` saw, under `token`, or why there can be none. */
export function replaceRequest(
  snapshot: FieldSnapshot,
  edit: Replacement,
  token: number,
): ReplaceRequest | ReplaceRefusal {
  const { text } = snapshot;
  const { start, end, replacement, caret } = edit;
  if (composing(snapshot)) return "composing";
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    end > text.length
  )
    return "range";
  if (snapshot.selectionStart !== end || snapshot.selectionEnd !== end) return "selection";
  const next = text.slice(0, start) + replacement + text.slice(end);
  if (!Number.isInteger(caret) || caret < 0 || caret > next.length) return "range";
  if (splits(text, start) || splits(text, end) || splits(next, caret)) return "surrogate";
  return {
    token,
    revision: snapshot.revision,
    sequence: snapshot.sequence,
    start,
    end,
    expected: text.slice(start, end),
    replacement,
    caret,
  };
}

/** The replacement the composer last asked the field for, and the field's answer to it, once it came. */
export interface Replacing {
  readonly request: ReplaceRequest;
  readonly answer: ReplaceAnswer | null;
}

/** Nothing asked yet. Token 0 asks nothing. */
export const NO_REPLACING: Replacing = {
  request: {
    token: 0,
    revision: 0,
    sequence: 0,
    start: 0,
    end: 0,
    expected: "",
    replacement: "",
    caret: 0,
  },
  answer: null,
};

/** Whether the field still owes an answer to the last request. */
export const replacePending = (current: Replacing) =>
  current.request.token !== 0 && current.answer === null;

/**
 * Asks for `edit` of the field `snapshot` saw, under the next token, or says why it can't. One request at a time; the
 * field's refusal is final, and nothing asks again on its own.
 */
export function askReplacement(
  current: Replacing,
  snapshot: FieldSnapshot,
  edit: Replacement,
):
  | { readonly kind: "asked"; readonly replacing: Replacing }
  | { readonly kind: "refused"; readonly reason: ReplaceRefusal } {
  if (replacePending(current)) return { kind: "refused", reason: "pending" };
  const request = replaceRequest(snapshot, edit, current.request.token + 1);
  return typeof request === "string"
    ? { kind: "refused", reason: request }
    : { kind: "asked", replacing: { request, answer: null } };
}

/** `current` with the field's answer in `change`, when it answers the request still owed; anything else is ignored. */
export function replacementAnswered(
  current: Replacing,
  change: Pick<FieldChange, "replaced">,
): Replacing {
  const answer = change.replaced;
  if (answer === undefined || !replacePending(current) || answer.token !== current.request.token)
    return current;
  return { ...current, answer };
}
