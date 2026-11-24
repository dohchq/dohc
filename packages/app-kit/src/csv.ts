export interface CsvOptions {
  readonly delimiter?: string;
}

export type CsvCell = string | number | bigint | boolean | null | undefined;

function checkDelimiter(delimiter: string): string {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
    throw new RangeError("A CSV delimiter is one character other than a quote or a line break.");
  }
  return delimiter;
}

export function parseCsv(text: string, { delimiter = "," }: CsvOptions = {}): string[][] {
  checkDelimiter(delimiter);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let line = 1;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (index >= text.length) return rows;
  for (;;) {
    if (text[index] === '"') {
      const opened = line;
      index += 1;
      for (;;) {
        if (index >= text.length) {
          throw new SyntaxError(`CSV line ${opened} opens a quoted field that never closes.`);
        }
        const char = text[index]!;
        if (char === '"') {
          if (text[index + 1] !== '"') break;
          index += 1;
        }
        if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) line += 1;
        field += char;
        index += 1;
      }
      index += 1;
      const next = text[index];
      if (next !== undefined && next !== delimiter && next !== "\r" && next !== "\n") {
        throw new SyntaxError(`CSV line ${line} has text after a closing quote.`);
      }
    } else {
      while (index < text.length) {
        const char = text[index]!;
        if (char === delimiter || char === "\r" || char === "\n") break;
        field += char;
        index += 1;
      }
    }
    row.push(field);
    field = "";
    const char = text[index];
    if (char === delimiter) {
      index += 1;
      continue;
    }
    rows.push(row);
    row = [];
    if (char === undefined) return rows;
    index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
    line += 1;
    if (index >= text.length) return rows;
  }
}

const formulaStart = /^[=+\-@\t\r]/;

function csvField(cell: CsvCell, delimiter: string): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number" && !Number.isFinite(cell)) {
    throw new RangeError(`A CSV number must be finite, not ${cell}.`);
  }
  if (typeof cell !== "string") return String(cell);
  const text = formulaStart.test(cell) ? `'${cell}` : cell;
  return text.includes(delimiter) || /["\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

export function toCsv(
  rows: readonly (readonly CsvCell[])[],
  { delimiter = "," }: CsvOptions = {},
): string {
  checkDelimiter(delimiter);
  return rows
    .map((row) => `${row.map((cell) => csvField(cell, delimiter)).join(delimiter)}\r\n`)
    .join("");
}
