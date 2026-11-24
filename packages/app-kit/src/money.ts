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

const invisible = /\p{Cf}/gu;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asciiDigits = "9876543210";

export function parseCents(
  text: string,
  { currency = "USD", locale }: MoneyOptions = {},
): number | null {
  const { format, digits } = currencyFormat(currency, locale);
  const parts = format.formatToParts(-1234567.5);
  const part = (type: string) =>
    (parts.find((item) => item.type === type)?.value ?? "").replace(invisible, "");
  const localDigits = Array.from(
    new Intl.NumberFormat(locale, { useGrouping: false }).format(Number(asciiDigits)),
  );
  const signs = new Set(["-", String.fromCharCode(0x2212), part("minusSign")]);
  const symbols = [part("currency").trim(), currency.toUpperCase()].filter(Boolean);
  let value = Array.from(text.replace(invisible, "").trim(), (char) => {
    const index = localDigits.indexOf(char);
    return index === -1 ? char : asciiDigits[index]!;
  }).join("");
  let negative = false;
  const takeSign = () => {
    if (!signs.has(value[0] ?? "")) return true;
    if (negative) return false;
    negative = true;
    value = value.slice(1).trimStart();
    return true;
  };
  const wrapped = /^\((.+)\)$/.exec(value);
  if (wrapped) {
    negative = true;
    value = wrapped[1]!.trim();
  }
  if (!takeSign()) return null;
  const symbol = symbols.find((item) => value.startsWith(item) || value.endsWith(item));
  if (symbol) {
    value = value.startsWith(symbol)
      ? value.slice(symbol.length).trimStart()
      : value.slice(0, -symbol.length).trimEnd();
  }
  if (!takeSign()) return null;
  const groupText = part("group");
  const group = /^\s$/.test(groupText) ? "\\s" : escape(groupText);
  const decimal = escape(part("decimal") || ".");
  const whole = group
    ? `\\d+|\\d{1,3}(?:${group}\\d{3})+|\\d{1,2}(?:${group}\\d{2})+${group}\\d{3}`
    : "\\d+";
  const match = new RegExp(`^(${whole})(?:${decimal}(\\d+))?$`).exec(value);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const units = `${match[1]!.replace(/\D/g, "")}${(match[2] ?? "").padEnd(digits, "0")}`;
  const cents = Number(units);
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}
