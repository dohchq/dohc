import { describe, expect, it } from "vitest";
import {
  collisionVariantPlan,
  entryCharBudget,
  fitWithinNameMax,
  NAME_MAX_UNITS,
  nameUnitFor,
  trashEntryPlan,
  WINDOWS_MAX_PATH_CHARS,
} from "./trashEntryName";

const PREFIX = "1785780488421-0ff532fe-1e3f-4c2b-9a77-5d1e6c8b3a10-";

const byteLength = (value: string) => new TextEncoder().encode(value).length;

// The name a caller would actually land on when nothing refuses it.
const firstOf = (name: string, prefix: string, options = {}) =>
  trashEntryPlan(name, prefix, options).candidates[0]!;
// The name a caller falls back to once the platform has refused the rest.
const lastOf = (name: string, prefix: string, options = {}) => {
  const { candidates } = trashEntryPlan(name, prefix, options);
  return candidates[candidates.length - 1]!;
};

describe("the component limit, and its unit", () => {
  // The limit is the filesystem's, not ours: 255 per component on ext4, APFS
  // and NTFS alike. Pinned here because this package owns the number.
  it("caps a component at the filesystem's 255", () => {
    expect(NAME_MAX_UNITS).toBe(255);
    expect(byteLength(lastOf("z".repeat(1000), PREFIX, { unit: "utf8" }))).toBe(255);
    expect(lastOf("z".repeat(1000), PREFIX, { unit: "utf16" })).toHaveLength(255);
  });

  // NTFS counts UTF-16 code units; ext4 and APFS count UTF-8 bytes.
  it("counts UTF-16 units on Windows and UTF-8 bytes everywhere else", () => {
    expect(nameUnitFor("win32")).toBe("utf16");
    expect(nameUnitFor("linux")).toBe("utf8");
    expect(nameUnitFor("darwin")).toBe("utf8");
  });

  // The data-loss case. 70 CJK characters is 70 UTF-16 units and 210 UTF-8
  // bytes, so a byte rule on NTFS drops characters the filesystem would have
  // taken whole -- and the trash keeps no record of the original name, so
  // restoring cannot put them back.
  it("keeps a CJK name NTFS would accept, which a byte rule would truncate", () => {
    const name = `${"中".repeat(70)}.md`;
    expect(byteLength(`${PREFIX}${name}`)).toBeGreaterThan(NAME_MAX_UNITS);
    expect(`${PREFIX}${name}`.length).toBeLessThanOrEqual(NAME_MAX_UNITS);

    // Windows keeps every character...
    expect(lastOf(name, PREFIX, { unit: "utf16" })).toBe(`${PREFIX}${name}`);
    // ...and a byte-counting filesystem legitimately cannot.
    expect(lastOf(name, PREFIX, { unit: "utf8" })).not.toBe(`${PREFIX}${name}`);
    expect(byteLength(lastOf(name, PREFIX, { unit: "utf8" }))).toBeLessThanOrEqual(
      NAME_MAX_UNITS,
    );
  });

  it("leaves a name that already fits exactly as it is", () => {
    expect(lastOf("notes.md", PREFIX, { unit: "utf8" })).toBe(`${PREFIX}notes.md`);
  });

  // The boundary either side, because an off-by-one here either truncates a
  // name that fits or ships one the filesystem rejects.
  it("keeps the longest name that fits and trims the first that does not", () => {
    const budget = NAME_MAX_UNITS - byteLength(PREFIX);
    const exact = "b".repeat(budget);
    expect(lastOf(exact, PREFIX, { unit: "utf8" })).toBe(`${PREFIX}${exact}`);
    expect(byteLength(lastOf("b".repeat(budget + 1), PREFIX, { unit: "utf8" }))).toBe(
      NAME_MAX_UNITS,
    );
  });

  it("never leaves half a character behind when counting bytes", () => {
    const entry = lastOf("é".repeat(200), PREFIX, { unit: "utf8" });
    expect(byteLength(entry)).toBeLessThanOrEqual(NAME_MAX_UNITS);
    expect(entry).not.toMatch(/\uFFFD/);
  });

  it("trims a replacement character produced by the cut", () => {
    const budget = NAME_MAX_UNITS - byteLength(PREFIX);
    const name = `${"c".repeat(budget - 1)}é`;
    expect(lastOf(name, PREFIX, { unit: "utf8" })).toBe(
      `${PREFIX}${"c".repeat(budget - 1)}`,
    );
  });

  it("answers an empty name when the prefix alone exhausts the limit", () => {
    const prefix = "p".repeat(NAME_MAX_UNITS);
    expect(fitWithinNameMax("anything", prefix, { unit: "utf8" })).toBe("");
  });

  // A UTF-16 cut can land between a surrogate pair, under either unit.
  it("never leaves half a surrogate pair", () => {
    const utf16 = lastOf("😀".repeat(200), PREFIX, { unit: "utf16" });
    expect(utf16).not.toMatch(/[\uD800-\uDBFF]$/);
    const budgeted = lastOf("😀".repeat(20), PREFIX, {
      unit: "utf16",
      maxEntryChars: PREFIX.length + 11,
    });
    expect(budgeted).toBe(`${PREFIX}${"😀".repeat(5)}`);
  });
});

// #613 twice over. The rule predicted which limit applied and was wrong both
// ways: first that the component limit was the only one, then that MAX_PATH
// always binds -- which took deletion away from deep workspaces on hosts
// where long paths work. It offers candidates now, and the caller asks the
// filesystem.
describe("the ladder, longest name first", () => {
  const TRASH_DIR =
    "C:\\Users\\ice\\AppData\\Local\\Temp\\dohc-mcp-test-bJMVxX\\ws\\.dohc\\trash";

  // The whole point: a name that fits is never shortened for a limit that did
  // not apply, and costs exactly one rename.
  it("offers the real name first, and only that when it fits", () => {
    const plan = trashEntryPlan("notes.md", PREFIX, {
      unit: "utf16",
      maxEntryChars: entryCharBudget(TRASH_DIR, "win32"),
    });
    expect(plan.candidates).toEqual([`${PREFIX}notes.md`]);
    expect(plan.exhausted).toBe(false);
  });

  it("starts from the untruncated name even when it cannot fit", () => {
    const name = `${"a".repeat(226)}.txt`;
    const plan = trashEntryPlan(name, PREFIX, {
      unit: "utf16",
      maxEntryChars: entryCharBudget(TRASH_DIR, "win32"),
    });
    expect(plan.candidates[0]).toBe(`${PREFIX}${name}`);
    // Then the component limit, then the composed-path limit: shorter each
    // time, and each reached only after the platform refused the last.
    expect(plan.candidates).toHaveLength(3);
    expect(plan.candidates[1]).toHaveLength(NAME_MAX_UNITS);
    expect(`${TRASH_DIR}\\${plan.candidates[2]}`.length).toBeLessThanOrEqual(
      WINDOWS_MAX_PATH_CHARS,
    );
  });

  // Where no composed-path limit applies there is nothing to fall back TO, so
  // the ladder must not invent a rung and truncate for a limit that is not
  // there.
  it("has no composed-path rung off Windows", () => {
    const name = `${"a".repeat(226)}.txt`;
    const plan = trashEntryPlan(name, PREFIX, {
      unit: "utf8",
      maxEntryChars: entryCharBudget("/home/ice/ws/.dohc/trash", "linux"),
    });
    expect(plan.candidates).toHaveLength(2);
    expect(plan.exhausted).toBe(false);
  });

  it("budgets the whole path on Windows and nothing anywhere else", () => {
    expect(entryCharBudget(TRASH_DIR, "win32")).toBe(
      WINDOWS_MAX_PATH_CHARS - TRASH_DIR.length - 1,
    );
    expect(entryCharBudget(TRASH_DIR, "linux")).toBe(Number.POSITIVE_INFINITY);
    expect(entryCharBudget(TRASH_DIR, "darwin")).toBe(Number.POSITIVE_INFINITY);
  });

  // When even the unique prefix cannot fit there is no shorter name to try,
  // and the caller has to refuse rather than rename onto a path the platform
  // will reject.
  it("reports exhausted when the prefix alone cannot fit", () => {
    const deep = `C:\\${"nested\\".repeat(30)}.dohc\\trash`;
    const plan = trashEntryPlan("notes.md", PREFIX, {
      unit: "utf16",
      maxEntryChars: entryCharBudget(deep, "win32"),
    });
    expect(plan.exhausted).toBe(true);
    // It still offers the real name: on a host where the legacy limit does
    // not apply, that one works and nothing needed refusing.
    expect(plan.candidates[0]).toBe(`${PREFIX}notes.md`);
  });
});

// This rule replaced a Buffer implementation with a TextDecoder one, and the
// two are equivalent everywhere EXCEPT a leading U+FEFF: the default decoder
// eats it as a byte-order mark. For filename bytes that is data loss with no
// error attached.
describe("truncation decodes filename bytes, not a text stream", () => {
  it("keeps a leading U+FEFF instead of eating it as a byte-order mark", () => {
    const budget = NAME_MAX_UNITS - byteLength(PREFIX);
    const name = `\uFEFF${"a".repeat(budget)}`;
    const fitted = fitWithinNameMax(name, PREFIX, { unit: "utf8" });
    expect(fitted.startsWith("\uFEFF")).toBe(true);
    expect(fitted).toBe(`\uFEFF${"a".repeat(budget - 3)}`);
  });

  // A genuine U+FFFD in a filename is a CHARACTER, and the old rule deleted it
  // whenever the cut landed right after its complete encoding: it stripped
  // every trailing U+FFFD, which cannot tell a sequence the cut broke from one
  // the name already carried. The trash keeps no record of the original name,
  // so that character was gone for good.
  it("keeps a real U+FFFD whose own bytes fit", () => {
    const budget = NAME_MAX_UNITS - byteLength(PREFIX);
    // U+FFFD is three bytes and ends exactly at the cut; the trailing "é"
    // pushes the name over the budget so the truncation branch runs at all.
    const name = `${"a".repeat(budget - 3)}\uFFFDé`;
    expect(byteLength(name)).toBeGreaterThan(budget);

    expect(fitWithinNameMax(name, PREFIX, { unit: "utf8" })).toBe(
      `${"a".repeat(budget - 3)}\uFFFD`,
    );
  });

  // The same distinction on the UTF-16 side: a pair the cut split is not the
  // same fact as a lone surrogate the name already ended with.
  it("keeps a lone surrogate it did not create", () => {
    const budget = 8;
    const prefix = "p".repeat(NAME_MAX_UNITS - budget);
    expect(fitWithinNameMax("abcdefg\uD800xyz", prefix, { unit: "utf16" })).toBe(
      "abcdefg\uD800",
    );
    // And a pair the cut DOES split loses its half.
    expect(fitWithinNameMax("abcdefg😀z", prefix, { unit: "utf16" })).toBe("abcdefg");
  });

  // Checked THROUGH the module, against a reference written a different way:
  // build the name up code point by code point and keep the longest prefix
  // that fits. Obviously correct, and it shares no code with the byte-level
  // cut, so agreeing means something. An earlier version used
  // Buffer#toString plus the same trailing-U+FFFD strip the module did, so it
  // agreed with the bug.
  it("answers the longest prefix that fits, at every offset", () => {
    const longestFitting = (name: string, budget: number) => {
      let best = "";
      for (const codePoint of name) {
        const next = best + codePoint;
        if (byteLength(next) > budget) break;
        best = next;
      }
      return best;
    };

    const corpus = [
      "\uFEFFreport.md",
      "\uFEFF\uFEFFnotes.md",
      "a\uFEFFb",
      "éé",
      "中中",
      "😀😀",
      "e\u0301e\u0301",
      "\uFEFF😀中é",
      "a\uFFFDé",
      "\uFFFD\uFFFD\uFFFD",
      "中\uFFFD😀",
    ];

    let compared = 0;
    for (const text of corpus) {
      const bytes = new TextEncoder().encode(text);
      for (let cut = 1; cut <= bytes.length; cut += 1) {
        const prefix = "p".repeat(NAME_MAX_UNITS - cut);
        expect(
          fitWithinNameMax(text, prefix, { unit: "utf8" }),
          `cut ${cut} of ${JSON.stringify(text)}`,
        ).toBe(longestFitting(text, cut));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});

// The collision path had the ladder's mechanism sitting right next to it and
// not wired in. Measuring the component in UTF-16 units is right for NTFS and
// leaves a multibyte name LONGER than the old byte rule did, so a colliding
// CJK name in a deep folder composed past MAX_PATH -- and copyFile answered
// ENOENT, #613's original symptom arriving through the import path.
describe("collision variants ride the same ladder", () => {
  // A real Windows-shaped depth, written without escapes so the length is
  // obvious: 190 characters, leaving 68 for the entry name.
  const DEEP = `C:${"/nested-folder".repeat(13)}/inbox`;

  it("offers the plain variant first, and only that when it fits", () => {
    expect(collisionVariantPlan("report.md", 2, { unit: "utf16" })).toEqual([
      "report (2).md",
    ]);
  });

  it("suffixes dotfiles and extensionless names at the end", () => {
    expect(collisionVariantPlan(".env", 2, { unit: "utf16" })).toEqual([".env (2)"]);
    expect(collisionVariantPlan("Makefile", 3, { unit: "utf16" })).toEqual([
      "Makefile (3)",
    ]);
  });

  // The regression: 84 CJK characters is 84 UTF-16 units, so the component
  // rule keeps them all -- and the composed path then passes 259.
  it("adds a shorter candidate when the composed path would not fit", () => {
    const name = `${"中".repeat(84)}.md`;
    const budget = entryCharBudget(DEEP, "win32");
    const plan = collisionVariantPlan(name, 2, { unit: "utf16", maxEntryChars: budget });

    expect(plan).toHaveLength(2);
    // Rung 1 keeps every character, and is tried first.
    expect(plan[0]).toBe(`${"中".repeat(84)} (2).md`);
    expect(`${DEEP}/${plan[0]}`.length).toBeGreaterThan(WINDOWS_MAX_PATH_CHARS);
    // Rung 2 is the one that fits, used only once the platform refuses rung 1.
    expect(`${DEEP}/${plan[1]}`.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH_CHARS);
    expect(plan[1]!.endsWith(" (2).md")).toBe(true);
  });

  // Off Windows there is no composed-path limit worth budgeting, so inventing
  // a second rung would truncate for a limit that does not exist.
  it("has no second rung where no composed limit applies", () => {
    const name = `${"中".repeat(84)}.md`;
    const plan = collisionVariantPlan(name, 2, {
      unit: "utf8",
      maxEntryChars: entryCharBudget("/home/ice/inbox", "linux"),
    });
    expect(plan).toHaveLength(1);
  });
});
