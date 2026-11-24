import { describe, expect, it } from "vitest";
import { formatCents, parseCents } from "./money";

const nbsp = String.fromCharCode(0xa0);

describe("dohc/money", () => {
  it("formats whole cents exactly, past where floating point dollars round", () => {
    expect(formatCents(123456, { locale: "en-US" })).toBe("$1,234.56");
    expect(formatCents(-5, { locale: "en-US" })).toBe("-$0.05");
    expect(formatCents(0, { locale: "en-US" })).toBe("$0.00");
    expect(formatCents(Number.MAX_SAFE_INTEGER, { locale: "en-US" })).toBe(
      "$90,071,992,547,409.91",
    );
    expect(formatCents(123400, { currency: "EUR", locale: "de-DE" })).toBe(`1.234,00${nbsp}€`);
    expect(formatCents(1500, { currency: "JPY", locale: "en-US" })).toBe("¥1,500");
    expect(formatCents(1234, { currency: "BHD", locale: "en-US" })).toBe("BHD" + nbsp + "1.234");
    expect(() => formatCents(1.5)).toThrow("formatCents needs a whole number of cents, not 1.5.");
    expect(() => formatCents(2 ** 60)).toThrow(RangeError);
  });

  it("parses amounts people type and bank exports write into exact cents", () => {
    const usd = { locale: "en-US" };
    expect(parseCents("$1,234.56", usd)).toBe(123456);
    expect(parseCents("1234.5", usd)).toBe(123450);
    expect(parseCents("12", usd)).toBe(1200);
    expect(parseCents(" -12.30 ", usd)).toBe(-1230);
    expect(parseCents("(12.30)", usd)).toBe(-1230);
    expect(parseCents("-$0.05", usd)).toBe(-5);
    expect(parseCents("USD 7.00", usd)).toBe(700);
    expect(parseCents("-0", usd)).toBe(0);
    expect(parseCents("1.234,56", { currency: "EUR", locale: "de-DE" })).toBe(123456);
    expect(parseCents(`1${nbsp}234,56${nbsp}€`, { currency: "EUR", locale: "fr-FR" })).toBe(123456);
    expect(parseCents("¥1,500", { currency: "JPY", locale: "en-US" })).toBe(1500);
    expect(parseCents("1,23,456.78", { currency: "INR", locale: "en-IN" })).toBe(12345678);
  });

  it("refuses text that is not an exact amount instead of guessing", () => {
    const usd = { locale: "en-US" };
    for (const text of [
      "",
      "abc",
      "1.234",
      "12,5",
      "1,2345",
      "--5",
      "(-5)",
      "5-",
      "1e3",
      "Infinity",
      "1 2.30",
      "1USD2.30",
      "1$2",
      "$12$",
    ]) {
      expect(parseCents(text, usd), text).toBeNull();
    }
    expect(parseCents("15.5", { currency: "JPY", locale: "en-US" })).toBeNull();
    expect(parseCents("99999999999999999", usd)).toBeNull();
  });

  it("round-trips every formatted amount", () => {
    for (const cents of [0, 1, -1, 99, 100, 123456789, -987654321, Number.MAX_SAFE_INTEGER]) {
      for (const [currency, locale] of [
        ["USD", "en-US"],
        ["EUR", "de-DE"],
        ["EUR", "fr-FR"],
        ["JPY", "ja-JP"],
        ["EUR", "de-AT"],
        ["CHF", "de-CH"],
        ["EUR", "nl-NL"],
        ["INR", "en-IN"],
        ["EGP", "ar-EG"],
        ["ILS", "he-IL"],
        ["SEK", "sv-SE"],
      ] as const) {
        expect(parseCents(formatCents(cents, { currency, locale }), { currency, locale })).toBe(
          cents,
        );
      }
    }
  });
});
