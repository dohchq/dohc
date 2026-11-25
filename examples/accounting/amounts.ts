import { formatCents, parseCents } from "dohc/money";

export function money(cents: number, currency: string) {
  return formatCents(cents, { currency });
}

export function minorDigits(currency: string) {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function majorUnits(minor: number, currency: string) {
  return minor / 10 ** minorDigits(currency);
}

export function compactMoney(units: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(units);
}

export function parseAmount(value: string, currency: string): number | null {
  return value.trim()
    ? parseCents(value, { currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD" })
    : 0;
}

export function centsInput(minor: number, currency: string) {
  const digits = minorDigits(currency);
  return minor
    ? (minor / 10 ** digits).toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping: false,
      })
    : "";
}
