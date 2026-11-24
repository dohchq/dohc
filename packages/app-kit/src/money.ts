export interface MoneyOptions {
  readonly currency?: string;
  readonly locale?: string;
}

function currencyFormat(currency: string, locale: string | undefined) {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  return { format, digits: format.resolvedOptions().maximumFractionDigits ?? 2 };
}

export function formatCents(
  cents: number,
  { currency = "USD", locale }: MoneyOptions = {},
): string {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`formatCents needs a whole number of cents, not ${cents}.`);
  }
  const { format, digits } = currencyFormat(currency, locale);
  const units = String(Math.abs(cents)).padStart(digits + 1, "0");
  const whole = units.slice(0, units.length - digits);
  const decimal = digits === 0 ? whole : `${whole}.${units.slice(-digits)}`;
  return format.format(`${cents < 0 ? "-" : ""}${decimal}` as Intl.StringNumericLiteral);
}

const spaces = /\s/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseCents(
  text: string,
  { currency = "USD", locale }: MoneyOptions = {},
): number | null {
  const { format, digits } = currencyFormat(currency, locale);
  const numberParts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const part = (parts: Intl.NumberFormatPart[], type: string) =>
    (parts.find((item) => item.type === type)?.value ?? "").replace(spaces, "");
  let value = text.replace(spaces, "");
  for (const literal of [part(format.formatToParts(1), "currency"), currency.toUpperCase()]) {
    if (literal) value = value.split(literal).join("");
  }
  let negative = false;
  const wrapped = /^\((.+)\)$/.exec(value);
  if (wrapped) {
    negative = true;
    value = wrapped[1]!;
  }
  const signed = /^[-\u2212](.+)$/.exec(value);
  if (signed) {
    if (negative) return null;
    negative = true;
    value = signed[1]!;
  }
  const group = escape(part(numberParts, "group"));
  const decimal = escape(part(numberParts, "decimal") || ".");
  const whole = group
    ? `\\d+|\\d{1,3}(?:${group}\\d{3})+|\\d{1,2}(?:${group}\\d{2})+${group}\\d{3}`
    : "\\d+";
  const match = new RegExp(`^(${whole})(?:${decimal}(\\d+))?$`).exec(value);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const units = `${group ? match[1]!.replace(new RegExp(group, "g"), "") : match[1]}${(match[2] ?? "").padEnd(digits, "0")}`;
  const cents = Number(units);
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}
