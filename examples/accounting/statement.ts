export type DateOrder = "ymd" | "mdy" | "dmy";
export type StatementRow = [date: string, description: string, amount: string];

const BATCH_ROWS = 500;
const BATCH_BYTES = 60 * 1024;

function isoDate(value: string, order: DateOrder): string | null {
  const text = value.trim();
  const parts =
    order === "ymd"
      ? /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)?.slice(1)
      : /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text)?.slice(1);
  if (!parts) return null;
  const [year, month, day] =
    order === "ymd" ? parts.map(Number) : order === "mdy" ? [parts[2], parts[0], parts[1]].map(Number) : [parts[2], parts[1], parts[0]].map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function amount(value: string | undefined): string | null {
  const text = (value ?? "").trim().replace(/[$€£¥]/g, "").trim();
  if (!text) return null;
  return /^(?:\(\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?\s*\)|[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?)$/.test(text)
    ? text
    : null;
}

function blank(value: string | undefined): boolean {
  return /^[-–—]?$/.test((value ?? "").trim().replace(/[$€£¥]/g, "").trim());
}

function unsignedAmount(value: string): string {
  return value.replace(/^[(\s+-]+|[\s)]+$/g, "");
}

function isZeroAmount(value: string): boolean {
  return /^0+(?:,0+)*(?:\.0+)?$/.test(unsignedAmount(value));
}

export function mapStatement(
  rows: string[][],
  columns: { date: number; description: number; amount: number; credit: number },
  order: DateOrder,
  digits: number,
): { rows: StatementRow[]; errors: string[] } {
  const out: StatementRow[] = [];
  const errors: string[] = [];
  rows.forEach((row, index) => {
    const date = isoDate(row[columns.date] ?? "", order);
    const description = (row[columns.description] ?? "").trim().slice(0, 300);
    let value: string | null = null;
    let ambiguous = false;
    let unreadable: string | null = null;
    if (columns.credit < 0) value = amount(row[columns.amount]);
    else {
      for (const cell of [row[columns.amount], row[columns.credit]]) if (!unreadable && !blank(cell) && amount(cell) === null) unreadable = cell!.trim();
      const moneyOut = amount(row[columns.amount]);
      const moneyIn = amount(row[columns.credit]);
      const hasIn = moneyIn !== null && !isZeroAmount(moneyIn);
      const hasOut = moneyOut !== null && !isZeroAmount(moneyOut);
      if (hasIn && hasOut) ambiguous = true;
      else value = hasIn ? unsignedAmount(moneyIn!) : hasOut ? `-${unsignedAmount(moneyOut!)}` : null;
    }
    if (value && isZeroAmount(value)) value = null;
    if (!date) errors.push(`Row ${index + 1} has no date in the chosen format.`);
    else if (unreadable) errors.push(`Row ${index + 1} has an amount that can't be read: ${unreadable}.`);
    else if (ambiguous) errors.push(`Row ${index + 1} has amounts in both money-in and money-out columns.`);
    else if (!value) errors.push(`Row ${index + 1} needs a nonzero amount.`);
    else if ((/\.(\d+)/.exec(value)?.[1]?.length ?? 0) > digits)
      errors.push(`Row ${index + 1} has more than ${digits} ${digits === 1 ? "decimal" : "decimals"} for this currency.`);
    else out.push([date, description, value]);
  });
  return { rows: out, errors };
}

export function statementBatches(rows: StatementRow[], envelope: Record<string, unknown>): StatementRow[][] {
  const encoder = new TextEncoder();
  const base = encoder.encode(JSON.stringify({ ...envelope, firstLine: Number.MAX_SAFE_INTEGER, rows: [] })).length;
  const batches: StatementRow[][] = [];
  let batch: StatementRow[] = [];
  let bytes = base;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    if (batch.length && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = base;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function importIdFor(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `csv-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}
