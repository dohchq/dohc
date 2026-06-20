import { describe, expect, it } from "vitest";
import { hasLegacyAppImport, stripSourceComments } from "./sourceScanner";

const LEGACY_SDK_PACKAGE = `@dohc/${"app"}`;
const importLegacySdk = `import "${LEGACY_SDK_PACKAGE}";\n`;
const requireLegacySdk = `require("${LEGACY_SDK_PACKAGE}");`;

describe("sourceScanner", () => {
  it("strips line and block comments without hiding real imports", () => {
    expect(hasLegacyAppImport(`// ${importLegacySdk}`)).toBe(false);
    expect(hasLegacyAppImport(`/* ${requireLegacySdk} */\n`)).toBe(false);
    expect(hasLegacyAppImport(`/* comment */\n${importLegacySdk}`)).toBe(true);
  });

  it("ignores string and template literals", () => {
    expect(hasLegacyAppImport(`const marker = "import \\"${LEGACY_SDK_PACKAGE}\\"";\n`)).toBe(false);
    expect(hasLegacyAppImport(`const marker = \`${requireLegacySdk}\`;\n`)).toBe(false);
  });

  it("detects literal static legacy imports", () => {
    expect(hasLegacyAppImport(importLegacySdk)).toBe(true);
    expect(hasLegacyAppImport(`const app = ${requireLegacySdk}\n`)).toBe(true);
  });

  it("tracks regex literals before comment detection", () => {
    const source = `const slashOrStar = /[/*]/;\n${importLegacySdk}`;
    expect(stripSourceComments(source)).toContain(importLegacySdk.trim());
    expect(hasLegacyAppImport(source)).toBe(true);
  });
});
