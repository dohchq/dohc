import { describe, expect, it } from "vitest";
import { generateAppSource } from "./appSource";
import { discoverSites } from "./sites";

const options = { title: "Ledger", appRoot: "finance/ledger" };

describe("app source generation", () => {
  it("matches the starter fixture", () => {
    expect(generateAppSource(options)).toMatchSnapshot();
  });

  it("keeps any title inside one string literal", () => {
    const title = `A & <B> "quoted" \\ {x} \`tick\` </script>`;
    const app = generateAppSource({ ...options, title })[1]!.content;
    const literal = /<PageHeader title=\{(.*)\} \/>/s.exec(app)?.[1];
    expect(JSON.parse(literal!)).toBe(title);
  });

  it("is found as a configured app by site detection", () => {
    const paths = generateAppSource(options).map((file) => `finance/ledger/${file.path}`);
    expect(discoverSites(paths)).toEqual([
      expect.objectContaining({
        root: "finance/ledger",
        kind: "configured",
        confidence: "high",
        diagnostics: [],
      }),
    ]);
  });

  it("generates deterministic, independent file records", () => {
    const input = Object.freeze({ ...options });
    const first = generateAppSource(input);
    const second = generateAppSource(input);
    expect(second).toEqual(first);
    first[0]!.content = "changed by a caller";
    expect(generateAppSource(input)).toEqual(second);
    expect(input).toEqual(options);
  });
});
