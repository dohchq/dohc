import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { jsonStringEncodedLength, MAX_PASSIVE_DATABASE_BYTES, MAX_PASSIVE_DOCUMENTS } from "./engineTextLimits";

it("keeps replica admission limits equal to the native store", () => {
  const source = readFileSync(new URL("../../../../crates/dohc-engine-storage/src/limits.rs", import.meta.url), "utf8");
  for (const [name, value] of Object.entries({ MAX_PASSIVE_DATABASE_BYTES, MAX_PASSIVE_DOCUMENTS })) {
    const expression = source.match(new RegExp(`pub const ${name}: u64 = ([0-9 *]+);`))?.[1];
    expect(expression, name).toBeDefined();
    expect(expression!.split("*").map(Number).reduce((product, part) => product * part, 1), name).toBe(value);
  }
});

// The merged-resolution budget is spent in encoded bytes, so this count must
// be the encoder’s count. `JSON.stringify` is the oracle: it builds the exact
// string the request carries, and its UTF-8 size is what the frame holds.
describe("jsonStringEncodedLength", () => {
  const vectors: Record<string, string> = {
    empty: "",
    plain: "plain ascii",
    "two-byte shorthands": '"\\\n\r\t\b\f',
    "other control bytes": String.fromCharCode(...Array.from({ length: 0x20 }, (_, i) => i)),
    "DEL is not escaped": "\u007f",
    "two-byte utf-8": "\u00e9\u07ff",
    "three-byte utf-8": "\u0800\uffff",
    "astral pair": "\u{1f642}\u{10000}",
    // A lone surrogate: three UTF-8 bytes by its value, six characters once
    // `JSON.stringify` escapes it. Counting it by value under-measures a body
    // by half, on a budget that decides whether a request can cross at all.
    "lone high surrogate": "\ud800",
    "lone low surrogate": "\udfff",
    "lone surrogate beside text": "a\ud800b",
    mixed: "\u00e9\u2713\u{1f642} mixed \n with \u0000 and \ud800",
  };

  for (const [name, sample] of Object.entries(vectors)) {
    it(`counts ${name} the way JSON.stringify writes it`, () => {
      // UTF-8 bytes, the unit a frame is measured in — not UTF-16 units.
      expect(jsonStringEncodedLength(sample)).toBe(
        Buffer.byteLength(JSON.stringify(sample), "utf8"),
      );
    });
  }
});
