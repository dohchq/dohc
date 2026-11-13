import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { excalidrawFontsSource, withoutExcalidrawCdnFallback } from "../electron.vite.config";

async function excalidrawBundle(): Promise<string> {
  const directory = dirname(excalidrawFontsSource);
  const scripts = (await readdir(directory)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(scripts.map((name) => readFile(join(directory, name), "utf8")));
  return sources.join("\n");
}

describe("Excalidraw fonts in the renderer", () => {

  it("drops the CDN Excalidraw adds after the asset path", async () => {
    const bundle = await excalidrawBundle();
    expect(bundle).toContain("https://esm.sh/");
    expect(withoutExcalidrawCdnFallback(bundle)).not.toMatch(/\.push\(new URL\([^()]*ASSETS_FALLBACK_URL\)\)/u);
    // An upgrade that moves the fallback fails the build instead of bringing the CDN back.
    expect(() => withoutExcalidrawCdnFallback("urls.push(new URL(path, base));")).toThrow();
  });

});
