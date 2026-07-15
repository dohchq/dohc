#!/usr/bin/env node
// Renders the static and themed build SVGs to transparent 512px PNGs with the
// repo's installed Playwright chromium. Run from apps/desktop:
//   node scripts/render-icon.mjs
// electron-builder generates platform ico/icns from the dual-tone icon.png;
// live app surfaces use the light/dark variants selected at runtime.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  for (const variant of ["icon", "icon-light", "icon-dark"]) {
    const svg = readFileSync(join(buildDir, `${variant}.svg`), "utf8");
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
    );
    await page.locator("svg").screenshot({
      path: join(buildDir, `${variant}.png`),
      omitBackground: true,
    });
    console.log(`Wrote build/${variant}.png`);
  }
} finally {
  await browser.close();
}
