import { describe, expect, it } from "vitest";
import { generateAppSource, planNewApp } from "./appSource";
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

describe("new app plan", () => {
  it("places the starter files in a new folder, titled from its name", () => {
    expect(planNewApp({ appRoot: "trips/new_trip-app", folder: "missing" })).toEqual({
      ok: true,
      appRoot: "trips/new_trip-app",
      files: generateAppSource({ title: "New Trip App" }).map((file) => ({
        ...file,
        path: `trips/new_trip-app/${file.path}`,
      })),
    });
  });

  it.each([
    ["", "missing", "appRoot must name a folder"],
    ["app", "file", "appRoot is not a directory: app"],
    ["app", { entryCount: 1 }, "app folder already exists and is not empty: app"],
  ] as const)("refuses %j in a %j folder", (appRoot, folder, reason) => {
    expect(planNewApp({ appRoot, folder })).toEqual({ ok: false, reason });
  });

  it("accepts an empty folder and a given title", () => {
    const plan = planNewApp({ appRoot: "app", folder: { entryCount: 0 }, title: " Ledger " });
    expect(plan.ok && plan.files[1]!.content).toContain('title={"Ledger"}');
  });
});
