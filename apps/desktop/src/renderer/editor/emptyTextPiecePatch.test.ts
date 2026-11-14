import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

// The patch in patches/ rewrites updateYFragment in both of the package's entries. An upgrade
// or a second copy of the package would drop it without a word, so this fails first.
const MARK = "dohc: keep empty text pieces";

it("loads @tiptap/y-tiptap 3.0.8 with the empty-piece patch, through import and require", async () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@tiptap/y-tiptap");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  expect(
    version,
    "patches/@tiptap__y-tiptap@3.0.8.patch was written for 3.0.8: rewrite it and run the empty-piece race tests before upgrading",
  ).toBe("3.0.8");
  const imported = await import("@tiptap/y-tiptap");
  expect(imported.updateYFragment.toString()).toContain(MARK);
  expect((require("@tiptap/y-tiptap") as typeof imported).updateYFragment.toString()).toContain(
    MARK,
  );
});
