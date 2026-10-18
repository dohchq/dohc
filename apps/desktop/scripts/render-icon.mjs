#!/usr/bin/env node
// Renders the build SVGs to PNGs with the repo's installed Playwright
// chromium. Run from apps/desktop:
//   node scripts/render-icon.mjs
// electron-builder generates the Windows and Linux icons from the dual-tone
// icon.png; live Windows and Linux surfaces use the light/dark variants
// selected at runtime. macOS uses icon.icns, packed by iconutil from
// icon-mac.svg, so it runs only on a Mac.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
// Small icon sizes get a heavier mark and no paper grid, so they stay legible.
const SMALL_ICON = ".mark{stroke-width:11}.dot{r:11}.grid{display:none}";
// iconutil's iconset names and their pixel sizes.
const ICONSET = [16, 32, 128, 256, 512].flatMap((size) => [
  [`icon_${size}x${size}.png`, size],
  [`icon_${size}x${size}@2x.png`, size * 2],
]);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const render = async (variant, size, path, extraCss = "") => {
    const svg = readFileSync(join(buildDir, `${variant}.svg`), "utf8");
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}${extraCss}</style>${svg}`,
    );
    await page.locator("svg").screenshot({ path, omitBackground: true });
  };

  for (const variant of ["icon", "icon-light", "icon-dark"]) {
    await render(variant, 512, join(buildDir, `${variant}.png`));
    console.log(`Wrote build/${variant}.png`);
  }
  // The unpackaged app sets this as its Dock icon; packages use icon.icns.
  await render("icon-mac", 1024, join(buildDir, "icon-mac.png"));
  console.log("Wrote build/icon-mac.png");
  // Electron loads the @2x file beside the 1x one, and a name ending in
  // Template marks a menu bar template image.
  await render("tray-mac", 18, join(buildDir, "trayTemplate.png"));
  await render("tray-mac", 36, join(buildDir, "trayTemplate@2x.png"));
  console.log("Wrote build/trayTemplate.png and build/trayTemplate@2x.png");

  if (process.platform === "darwin") {
    const iconset = join(mkdtempSync(join(tmpdir(), "dohc-icon-")), "icon.iconset");
    try {
      for (const [name, size] of ICONSET) {
        await render("icon-mac", size, join(iconset, name), size <= 32 ? SMALL_ICON : "");
      }
      execFileSync("iconutil", ["--convert", "icns", "--output", join(buildDir, "icon.icns"), iconset]);
      console.log("Wrote build/icon.icns");
    } finally {
      rmSync(dirname(iconset), { recursive: true, force: true });
    }
  } else {
    console.log("Skipped build/icon.icns: iconutil runs only on macOS.");
  }
} finally {
  await browser.close();
}
