// Bundles editor/page.ts for the app's web view: a small HTML file that pulls the script from its own file, so
// WebKit can keep its compiled form between web views, and the body's Inter files beside it. The app writes the files
// once, then loads the HTML.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [resolve(root, "editor/page.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["safari17", "chrome120"],
  write: false,
  logLevel: "warning",
});
const script = result.outputFiles[0].text;

// The page body's typeface: Inter, from the same package and variable wght files the desktop ships
// (@fontsource-variable/inter), with its faces and unicode ranges as written there. Only the Latin-script subsets ship;
// other scripts fall back to the system font (the DL, Nov 7). The files sit beside page.js.
const require = createRequire(import.meta.url);
const interCss = await readFile(require.resolve("@fontsource-variable/inter/index.css"), "utf8");
const fonts = [];
const faces = [];
for (const subset of ["latin", "latin-ext", "vietnamese"]) {
  const name = `inter-${subset}-wght-normal.woff2`;
  const face = interCss.match(new RegExp(`/\\* inter-${subset}-wght-normal \\*/\\s*(@font-face \\{[^}]*\\})`))?.[1];
  if (!face) throw new Error(`@fontsource-variable/inter has no ${subset} face`);
  faces.push(face.replace(/url\([^)]*\)/, `url(${name})`));
  fonts.push({ name, base64: (await readFile(require.resolve(`@fontsource-variable/inter/files/${name}`))).toString("base64") });
}

const css = `
${faces.join("\n")}
:root { color-scheme: light dark; --ink: #1c1b18; --muted: #55524a; --subtle: #746f63; --paper: #faf9f5; --rule: #e4e1d8; }
@media (prefers-color-scheme: dark) { :root { --ink: #f6f4ee; --muted: #a9a599; --subtle: #969184; --paper: #131211; --rule: #2a2925; } }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; }
html { font-size: calc(17px * var(--text-scale, 1)); }
body { font: 1rem/1.6 "Inter Variable", -apple-system, system-ui, sans-serif; }
/* The page scrolls inside #editor, not the document, so the focus scroll in WebKit has nothing to move. */
#editor { height: 100%; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; padding: 16px 16px 40vh; }
.page .icon { font-size: calc(44rem / 17); line-height: 1; margin: 8px 0 10px; }
.page .title { font-size: calc(30rem / 17); line-height: 1.2; font-weight: 700; margin: 0 0 12px; }
/* Each property is a pill, as on the desktop: its name, then its value. Read-only; a chevron only on a value that opens
   something, which keeps a 44 pt hit area around its 30 pt pill. */
.properties { display: flex; flex-wrap: wrap; gap: calc(6rem / 17); margin: 0 0 18px; padding: 0; }
.property { display: inline-flex; align-items: center; gap: calc(6rem / 17); box-sizing: border-box; min-height: calc(30rem / 17); max-width: 100%;
  padding: 3px calc(12rem / 17); border: 1px solid var(--rule); border-radius: calc(15rem / 17); font-size: calc(14rem / 17); line-height: 1.3; }
.property dt { min-width: 0; color: var(--muted); overflow-wrap: anywhere; }
.property dd { margin: 0; min-width: 0; color: var(--ink); overflow-wrap: anywhere; }
.property.opens { position: relative; }
/* From the padding box: 28 pt inside the borders plus 8 pt each way makes 44. */
.property.opens::before { content: ""; position: absolute; inset: -8px -4px; }
.property.opens dd::after { content: "\\203A" / ""; margin-left: calc(6rem / 17); color: var(--subtle); }
.markdown { outline: none; white-space: pre-wrap; word-wrap: break-word; }
.markdown h1 { font-size: calc(26rem / 17); } .markdown h2 { font-size: calc(20rem / 17); margin-top: 1.4em; }
/* Lists keep the desktop's rhythm at the phone's 17 pt, in em so it follows Dynamic Type: no paragraph gap inside an
   item, a 24 pt indent, 12 pt after the list. */
.markdown ul, .markdown ol { margin: 0 0 calc(12em / 17); padding-left: calc(24em / 17); }
.markdown li { line-height: 1.65; }
.markdown li > p { margin: 0; min-height: 1.65em; }
.markdown blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--rule); }
.markdown code, .source { font: calc(15rem / 17) ui-monospace, monospace; }
.source { white-space: pre-wrap; word-wrap: break-word; margin: 0; }
.markdown a { color: inherit; }
`;

const head = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<script>window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ kind: "head", at: Date.now() }));</script>
<style>${css}</style></head><body><div id="editor"></div>`;
const pageHtml = `${head}<script src="page.js"></script></body></html>`;

await writeFile(resolve(root, "src/editorHtml.generated.ts"), `// Generated by scripts/build-editor.mjs. Do not edit.
/** Names the folder the app writes these files to, so a new build never reads files an older one wrote. */
export const pageVersion = ${JSON.stringify(fonts.reduce((hash, font) => hash.update(font.base64), createHash("sha256").update(pageHtml).update(script)).digest("hex").slice(0, 16))};
/** The page's HTML; it loads page.js from the same folder. */
export const pageHtml = ${JSON.stringify(pageHtml)};
export const pageScript = ${JSON.stringify(script)};
/** The page body's Inter files, base64, written beside page.js. */
export const pageFonts: readonly { readonly name: string; readonly base64: string }[] = ${JSON.stringify(fonts)};
`);
const fontBytes = fonts.reduce((sum, font) => sum + Buffer.from(font.base64, "base64").length, 0);
console.log(`editor bundle: ${((pageHtml.length + script.length) / 1024).toFixed(0)} KiB, fonts ${(fontBytes / 1024).toFixed(0)} KiB in ${fonts.length} files`);
