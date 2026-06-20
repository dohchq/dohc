import { describe, expect, it } from "vitest";
import { hasLegacyAppImport, stripSourceComments } from "./sourceScanner";

describe("sourceScanner", () => {
  it("strips line and block comments without hiding real imports", () => {
    expect(hasLegacyAppImport('// import "@dohc/app";\n')).toBe(false);
    expect(hasLegacyAppImport('/* require("@dohc/app"); */\n')).toBe(false);
    expect(hasLegacyAppImport('/* comment */\nimport "@dohc/app";\n')).toBe(true);
  });

  it("ignores string and template literals", () => {
    expect(hasLegacyAppImport('const marker = "import \\"@dohc/app\\"";\n')).toBe(false);
    expect(hasLegacyAppImport("const marker = `require(\"@dohc/app\")`;\n")).toBe(false);
  });

  it("detects literal static legacy imports", () => {
    expect(hasLegacyAppImport('import "@dohc/app";\n')).toBe(true);
    expect(hasLegacyAppImport('const app = require("@dohc/app");\n')).toBe(true);
  });

  it("tracks regex literals before comment detection", () => {
    const source = 'const slashOrStar = /[/*]/;\nimport "@dohc/app";\n';
    expect(stripSourceComments(source)).toContain('import "@dohc/app"');
    expect(hasLegacyAppImport(source)).toBe(true);
  });
});
