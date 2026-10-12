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
