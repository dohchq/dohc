#!/usr/bin/env node
// Renders the light/dark build SVGs to transparent 512px PNGs with the repo's
// installed Playwright chromium. Run from apps/desktop:
//   node scripts/render-icon.mjs
// electron-builder generates the static platform ico/icns from icon.png,
// which intentionally mirrors the light variant as the packaging fallback.
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  for (const theme of ["light", "dark"]) {
    const svg = readFileSync(join(buildDir, `icon-${theme}.svg`), "utf8");
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
    );
    await page.locator("svg").screenshot({
      path: join(buildDir, `icon-${theme}.png`),
      omitBackground: true,
    });
    console.log(`Wrote build/icon-${theme}.png`);
  }

  copyFileSync(join(buildDir, "icon-light.png"), join(buildDir, "icon.png"));
  console.log("Wrote build/icon.png (light packaging fallback)");
} finally {
  await browser.close();
}
