// One plain-text block a person can paste into a chat or an issue: one
// "label: value" line per fact, facts without a value left out. A few
// lines, never a log: a log can carry paths a person should not paste in
// public.
export const ERROR_DETAIL_MAX_CHARS = 500;

// A fact may set its own longer bound, such as a path, which is useless
// once its file name is cut off.
export type ErrorDetailField = readonly [
  label: string,
  value: string | null | undefined,
  maxChars?: number,
];

/**
 * What a person typed that dohc did not save. Its notice says why in its
 * message, and carries all of the text in Copy details, where no cut takes
 * the end of a long one.
 */
export class TextNotSavedError extends Error {
  constructor(
    message: string,
    readonly typed: string,
  ) {
    super(message);
  }
}

/**
 * The facts Copy details lists for a shell notice, before the facts about
 * this computer. A notice with change rows shows its facts beside the
 * row's own words, so it leaves out the lines that repeat them.
 */
export function shellNoticeFields(notice: {
  tone?: string;
  message: string;
  title?: string;
  paths?: readonly string[];
  rows?: readonly string[];
  details?: ReadonlyArray<ErrorDetailField>;
}): ErrorDetailField[] {
  return [
    ...(notice.rows
      ? (notice.details ?? [])
      : [
          [notice.tone ? "Notice" : "Error", notice.message] as const,
          ...(notice.title ? [["Title", notice.title] as const] : []),
        ]),
    ...(notice.paths ?? []).map((path) => ["Path", path, path.length] as const),
    ...(notice.rows ?? []).map((row) => ["Change", row] as const),
    ...(notice.rows ? [] : (notice.details ?? [])),
  ];
}

export function errorDetails(fields: ReadonlyArray<ErrorDetailField>): string {
  return fields
    .filter((field): field is readonly [string, string, number?] => Boolean(field[1]))
    .map(([label, value, maxChars = ERROR_DETAIL_MAX_CHARS]) => {
      // One line per fact, so a multi-line message cannot smuggle in a
      // stack, and no line longer than a person would paste.
      const line = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
      return `${label}: ${line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line}`;
    })
    .join("\n");
}
