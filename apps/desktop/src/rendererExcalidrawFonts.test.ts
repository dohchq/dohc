import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  excalidrawFontAssets,
  excalidrawFontsSource,
  withoutExcalidrawCdnFallback,
} from "../electron.vite.config";
import { excalidrawAssetPath } from "./renderer/excalidrawFonts";

async function excalidrawBundle(): Promise<string> {
  const directory = dirname(excalidrawFontsSource);
  const scripts = (await readdir(directory)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(scripts.map((name) => readFile(join(directory, name), "utf8")));
  return sources.join("\n");
}

describe("Excalidraw fonts in the renderer", () => {
  it("resolves the asset path inside the renderer folder", () => {
    for (const documentUrl of [
      "file:///app/resources/app.asar/dist/renderer/index.html?view=manager",
      "http://localhost:5173/?view=manager",
    ]) {
      const path = excalidrawAssetPath(documentUrl);
      expect(path.startsWith(new URL("./", documentUrl).href)).toBe(true);
      expect(new URL("./fonts/Virgil/Virgil-Regular.woff2", path).href).toBe(
        new URL("excalidraw/fonts/Virgil/Virgil-Regular.woff2", documentUrl).href,
      );
    }
  });

  it("still reads the asset path the renderer sets", async () => {
    // An upgrade that renames the global brings back the CDN requests.
    expect(await excalidrawBundle()).toContain("window.EXCALIDRAW_ASSET_PATH");
  });

  it("drops the CDN Excalidraw adds after the asset path", async () => {
    const bundle = await excalidrawBundle();
    expect(bundle).toContain("https://esm.sh/");
    expect(withoutExcalidrawCdnFallback(bundle)).not.toMatch(/\.push\(new URL\([^()]*ASSETS_FALLBACK_URL\)\)/u);
    // An upgrade that moves the fallback fails the build instead of bringing the CDN back.
    expect(() => withoutExcalidrawCdnFallback("urls.push(new URL(path, base));")).toThrow();
  });

  it("ships every font file Excalidraw asks for", async () => {
    const requested = [
      ...new Set((await excalidrawBundle()).match(/\.\/fonts\/[^"'`]+\.woff2/gu) ?? []),
    ];
    expect(requested.length).toBeGreaterThan(0);
    const shipped = new Set((await excalidrawFontAssets()).map((asset) => asset.fileName));
    expect(requested.filter((file) => !shipped.has(`excalidraw/${file.slice(2)}`))).toEqual([]);
  });
});
