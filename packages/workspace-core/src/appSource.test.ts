import { describe, expect, it } from "vitest";
import { generateAppSource } from "./appSource";

const options = { title: "Ledger", packageName: "ledger", withDohcJson: true };

describe("app source generation", () => {
  it("matches the starter fixture", () => {
    expect(generateAppSource(options)).toMatchSnapshot();
  });

  it("escapes titles in HTML and preserves them in JSON", () => {
    const title = `A & <B> "quoted" 'single' </title><script>alert(1)</script>`;
    const files = generateAppSource({ ...options, title });
    const html = files.find((file) => file.path === "index.html")!.content;
    const escaped = "A &amp; &lt;B&gt; &quot;quoted&quot; &#39;single&#39; &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;";
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<h1>${escaped}</h1>`);
    expect(html).not.toContain(title);
    const manifest = JSON.parse(files.find((file) => file.path === "dohc.json")!.content);
    expect(manifest).toEqual({
      version: 1, type: "app", title,
      preview: { mode: "static", entry: "index.html" },
      build: { command: "npm run build", output: "dist" },
    });
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

  it("omits only the optional manifest", () => {
    const withManifest = generateAppSource(options);
    const withoutManifest = generateAppSource({ ...options, withDohcJson: false });
    expect(withoutManifest).toEqual(withManifest.filter((file) => file.path !== "dohc.json"));
    expect(withoutManifest.map((file) => file.path)).toEqual([
      "index.html", "styles.css", "script.js", "scripts/build-static.mjs", "package.json",
    ]);
    expect(JSON.parse(withoutManifest.find((file) => file.path === "package.json")!.content).name).toBe("ledger");
  });
});
