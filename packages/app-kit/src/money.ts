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
const padding = /^[\s\p{Cf}]+|[\s\p{Cf}]+$/gu;
const spaceGroup = `[ ${String.fromCharCode(0xa0, 0x202f)}]`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asciiDigits = "9876543210";

export function parseCents(
  text: string,
  { currency = "USD", locale }: MoneyOptions = {},
): number | null {
  const { format, digits } = currencyFormat(currency, locale);
  const parts = format.formatToParts(-1234567.5);
  const raw = (type: string) =>
    (parts.find((item) => item.type === type)?.value ?? "").replace(invisible, "");
  const trim = (value: string) => value.replace(padding, "");
  const localDigits = Array.from(
    new Intl.NumberFormat(locale, { useGrouping: false }).format(Number(asciiDigits)),
  );
  const signs = new Set(["-", String.fromCharCode(0x2212), trim(raw("minusSign"))]);
  const trailingSign =
    parts.findIndex((item) => item.type === "minusSign") >
    parts.findIndex((item) => item.type === "integer");
  const symbols = [trim(raw("currency")), currency.toUpperCase()].filter(Boolean);
  let value = trim(
    Array.from(text, (char) => {
      const index = localDigits.indexOf(char);
      return index === -1 ? char : asciiDigits[index]!;
    }).join(""),
  );
  let negative = false;
  const takeSign = () => {
    const leading = signs.has(value[0] ?? "");
    if (!leading && !(trailingSign && signs.has(value.at(-1) ?? ""))) return true;
    if (negative) return false;
    negative = true;
    value = trim(leading ? value.slice(1) : value.slice(0, -1));
    return true;
  };
  const wrapped = /^\((.+)\)$/.exec(value);
  if (wrapped) {
    negative = true;
    value = trim(wrapped[1]!);
  }
  if (!takeSign()) return null;
  const symbol = symbols.find((item) => value.startsWith(item) || value.endsWith(item));
  if (symbol) {
    value = trim(
      value.startsWith(symbol) ? value.slice(symbol.length) : value.slice(0, -symbol.length),
    );
  }
  if (!takeSign()) return null;
  const groupText = raw("group");
  const group = /^\s$/.test(groupText) ? spaceGroup : escape(groupText);
  const sizes = parts
    .filter((item) => item.type === "integer")
    .map((item) => Array.from(item.value).length);
  const secondary = sizes.length > 2 ? sizes[1]! : 3;
  const decimal = escape(trim(raw("decimal")) || ".");
  const whole = group
    ? `\\d+|\\d{1,${secondary}}(?:${group}\\d{${secondary}})*${group}\\d{3}`
    : "\\d+";
  const match = new RegExp(`^(${whole})(?:${decimal}(\\d+))?$`).exec(value);
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const units = `${match[1]!.replace(/\D/g, "")}${(match[2] ?? "").padEnd(digits, "0")}`;
  const cents = Number(units);
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}
