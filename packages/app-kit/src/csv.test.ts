import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv";

describe("dohc/csv", () => {
  it("parses RFC 4180 quoting, embedded line breaks, and any line ending", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(
      parseCsv(
        `${bom}date,memo,amount\r\n2026-11-01,"Coffee, beans",-12.30\r\n2026-11-02,"Said ""hi""\r\nthen left",4\n2026-11-03,,\r`,
      ),
    ).toEqual([
      ["date", "memo", "amount"],
      ["2026-11-01", "Coffee, beans", "-12.30"],
      ["2026-11-02", 'Said "hi"\r\nthen left', "4"],
      ["2026-11-03", "", ""],
    ]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv(bom)).toEqual([]);
    expect(parseCsv("a")).toEqual([["a"]]);
    expect(parseCsv("a,")).toEqual([["a", ""]]);
    expect(parseCsv("\r\n")).toEqual([[""]]);
    expect(parseCsv('""')).toEqual([[""]]);
    expect(parseCsv('5" screen,x')).toEqual([['5" screen', "x"]]);
    expect(parseCsv("a;b\nc;d", { delimiter: ";" })).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("names the line of malformed quoting", () => {
    expect(() => parseCsv('a,b\r\n"open\r\nstill open')).toThrow(
      "CSV line 2 opens a quoted field that never closes.",
    );
    expect(() => parseCsv('a\n"x"y')).toThrow("CSV line 2 has text after a closing quote.");
    expect(() => parseCsv("a", { delimiter: '"' })).toThrow(RangeError);
  });

  it("exports cells that spreadsheets read as text, not formulas", () => {
    expect(
      toCsv([
        ["memo", "amount", "note"],
        ['=HYPERLINK("http://x")', -1230, "+1"],
        ["@SUM(A1)", 12n, "-2"],
        ["\tTab", true, null],
        ["Coffee, beans", undefined, 'Say "hi"\nok'],
      ]),
    ).toBe(
      [
        "memo,amount,note",
        `"'=HYPERLINK(""http://x"")",-1230,'+1`,
        "'@SUM(A1),12,'-2",
        "'\tTab,true,",
        `"Coffee, beans",,"Say ""hi""\nok"`,
        "",
      ].join("\r\n"),
    );
    expect(toCsv([[-12.3, "a.b"]], { delimiter: "." })).toBe('"-12.3"."a.b"\r\n');
    expect(() => toCsv([[Number.NaN]])).toThrow("A CSV number must be finite, not NaN.");
  });

  it("reads back what it writes", () => {
    const rows = [
      ["a", "b,c", 'd"e', "f\r\ng", ""],
      ["", "", "", "", ""],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(parseCsv(toCsv(rows, { delimiter: "\t" }), { delimiter: "\t" })).toEqual(rows);
  });
});
