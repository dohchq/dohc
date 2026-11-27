// Bundles sketch/canvas.tsx and Excalidraw fonts as static native assets loaded via expo-asset.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "assets/sketch");
const cdnFallback = /[\w$]+\.push\(new URL\([\w$]+, ?[\w$]+\.ASSETS_FALLBACK_URL\)\)/gu;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [resolve(root, "sketch/canvas.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  conditions: ["production"],
  target: ["chrome109", "safari16.4"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  entryNames: "sketch",
  outdir: outDir,
  plugins: [
    {
      name: "sketch-mobile-trim",
      setup(b) {
        b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({
          path: "mermaid-stub",
          namespace: "stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: 'export function parseMermaidToExcalidraw(){throw new Error("Unavailable")}',
          loader: "js",
        }));
        b.onLoad({ filter: /[\\/]@excalidraw[\\/]excalidraw[\\/].*\.js$/ }, async (args) => {
          const code = await readFile(args.path, "utf8");
          return code.includes("ASSETS_FALLBACK_URL")
            ? { contents: code.replace(cdnFallback, "0"), loader: "js" }
            : null;
        });
      },
    },
  ],
  logLevel: "warning",
});
// Distinct stems (bundle/styles/index) avoid Android res/raw extension-stripped resource collisions.
await rename(join(outDir, "sketch.js"), join(outDir, "bundle.sketchjs"));
const require = createRequire(import.meta.url);
const excalidrawDir = dirname(require.resolve("@excalidraw/excalidraw"));
await cp(join(excalidrawDir, "index.css"), join(outDir, "styles.css"));
const fontsSource = join(excalidrawDir, "fonts");
// Ship core Excalidraw font families; skip 12 MiB Xiaolai CJK subsets (system font fallback, matching build-editor.mjs).
for (const family of [
  "Assistant",
  "Cascadia",
  "ComicShanns",
  "Excalifont",
  "Liberation",
  "Lilita",
  "Nunito",
  "Virgil",
]) {
  await cp(join(fontsSource, family), join(outDir, "fonts", family), { recursive: true });
}
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><script>window.EXCALIDRAW_ASSET_PATH="./";</script><link rel="stylesheet" href="sketch.css"><style>:root{color-scheme:light dark;--dohc-bg:#faf9f5;--dohc-panel:#f3f1ea;--dohc-panel-2:#ebe8e0;--dohc-line:#e4e1d8;--dohc-ink:#1c1b18;--dohc-accent:#2d342e;--dohc-hover:#ebe8e0}:root[data-theme="dark"]{--dohc-bg:#131211;--dohc-panel:#181715;--dohc-panel-2:#201f1c;--dohc-line:#2a2925;--dohc-ink:#f6f4ee;--dohc-accent:#d7d0c0;--dohc-hover:#24231f}html,body,#root{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:var(--dohc-bg)}:root .excalidraw{--color-primary:var(--dohc-accent);--color-primary-darker:var(--dohc-accent);--color-primary-darkest:var(--dohc-accent);--color-surface-primary-container:var(--dohc-accent);--color-on-primary-container:var(--dohc-bg);--island-bg-color:var(--dohc-panel);--color-surface-lowest:var(--dohc-bg);--color-surface-low:var(--dohc-panel-2);--color-surface-mid:var(--dohc-panel-2);--color-on-surface:var(--dohc-ink);--button-hover-bg:var(--dohc-hover);--default-border-color:var(--dohc-line);--focus-highlight-color:var(--dohc-accent);--select-highlight-color:var(--dohc-accent)}</style></head><body><div id="root"></div><script src="sketch.js"></script></body></html>`;
await writeFile(join(outDir, "index.html"), html);

const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile())
  .map((e) => relative(outDir, join(e.parentPath, e.name)).split(sep).join("/"))
  .sort();
const targets = {
  "bundle.sketchjs": "sketch.js",
  "styles.css": "sketch.css",
  "index.html": "sketch.html",
};
const androidStems = new Set();
const hash = createHash("sha256");
const lines = [];
let totalBytes = 0;
for (const file of files) {
  const stem = `assets/sketch/${file}`
    .replace(/\.[^.]+$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "_");
  if (androidStems.has(stem)) throw new Error(`Duplicate Android raw resource stem: ${stem}`);
  androidStems.add(stem);
  const bytes = await readFile(join(outDir, file));
  hash.update(file).update(bytes);
  totalBytes += bytes.byteLength;
  const target = targets[file] ?? file;
  lines.push(
    `  { target: ${JSON.stringify(target)}, module: require(${JSON.stringify(`../../assets/sketch/${file}`)}) as number },`,
  );
}
const version = hash.digest("hex").slice(0, 16);
await mkdir(resolve(root, "src/sketches"), { recursive: true });
await writeFile(
  resolve(root, "src/sketches/sketchAssets.generated.ts"),
  `// Generated by scripts/build-sketch.mjs. Do not edit.\nexport const sketchVersion = ${JSON.stringify(version)};\nexport const sketchAssets: readonly { readonly target: string; readonly module: number }[] = [\n${lines.join("\n")}\n];\n`,
);
console.log(
  `sketch static assets: ${(totalBytes / 1024).toFixed(0)} KiB across ${files.length} files (v=${version})`,
);
