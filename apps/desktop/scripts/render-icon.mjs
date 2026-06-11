#!/usr/bin/env node
// Renders build/icon.svg to build/icon.png (512x512, transparent) with the
// repo's installed Playwright chromium. Run from apps/desktop:
//   node scripts/render-icon.mjs
// electron-builder generates the platform ico/icns from the 512px png.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const svg = readFileSync(join(buildDir, "icon.svg"), "utf8");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
  );
  await page.locator("svg").screenshot({
    path: join(buildDir, "icon.png"),
    omitBackground: true,
  });
  console.log("Wrote build/icon.png");
} finally {
  await browser.close();
}
