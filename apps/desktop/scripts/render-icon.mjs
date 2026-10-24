#!/usr/bin/env node
// Renders the build SVGs to PNGs with the repo's installed Playwright
// chromium. Run from apps/desktop:
//   node scripts/render-icon.mjs
// Windows uses icon.ico and Linux uses icon.png, both from icon.svg. The
// Windows and Linux tray uses the light/dark variants selected at runtime.
// macOS uses icon.icns, packed by iconutil from icon-mac.svg, so it runs
// only on a Mac.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
// Small icon sizes get a heavier mark and no paper grid, so they stay legible.
const SMALL_ICON = ".mark{stroke-width:13}.dot{r:13}.grid{display:none}";
// iconutil's iconset names and their pixel sizes.
const ICONSET = [16, 32, 128, 256, 512].flatMap((size) => [
  [`icon_${size}x${size}.png`, size],
  [`icon_${size}x${size}@2x.png`, size * 2],
]);
// The sizes electron-builder would put in an icon.ico generated from a PNG.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Pack PNG images into an ICO file, which Windows reads from Vista on. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    // A width and height of 0 mean 256.
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const render = async (variant, size, path, extraCss = "") => {
    const svg = readFileSync(join(buildDir, `${variant}.svg`), "utf8");
    // extraCss follows the SVG so it overrides the SVG's own stylesheet.
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}<style>${extraCss}</style>`,
    );
    return page.locator("svg").screenshot({ path, omitBackground: true });
  };

  for (const variant of ["icon", "icon-light", "icon-dark"]) {
    await render(variant, 512, join(buildDir, `${variant}.png`));
    console.log(`Wrote build/${variant}.png`);
  }
  // A taskbar at 150% scale shrinks the 48px image, so it is small too.
  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, png: await render("icon", size, undefined, size <= 48 ? SMALL_ICON : "") });
  }
  writeFileSync(join(buildDir, "icon.ico"), ico(icoImages));
  console.log("Wrote build/icon.ico");
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
