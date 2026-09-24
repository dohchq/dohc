import { createHash } from "node:crypto";

export interface AppDocumentFile {
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  contentType: string;
}

/**
 * page.json: an HTML entry compiled for the loader. Each classic script stays
 * its own script, so its names, strict mode, and errors behave as they would
 * on a page. `scripts` run once the markup is in place; `deferred` run after
 * the document finishes parsing, where null is bundle.js.
 */
export interface AppPage {
  html: Array<[string, string]>;
  title: string | null;
  body: Array<[string, string]>;
  markup: string;
  scripts: string[];
  deferred: Array<string | null>;
}

export const APP_BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "bundle.js": "text/javascript; charset=utf-8",
  "bundle.css": "text/css; charset=utf-8",
  "page.json": "application/json; charset=utf-8",
};
const attributeName = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function parsePage(text: string): AppPage {
  const value: unknown = JSON.parse(text);
  const exact = (row: unknown, keys: string) => !!row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).sort().join() === keys;
  const attributes = (rows: unknown) => Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 2 &&
    typeof row[0] === "string" && attributeName.test(row[0]) && typeof row[1] === "string");
  if (!exact(value, "body,deferred,html,markup,scripts,title")) throw new Error("Invalid app page.");
  const page = value as AppPage;
  if (!attributes(page.html) || !attributes(page.body) || (page.title !== null && typeof page.title !== "string") || typeof page.markup !== "string" ||
      !Array.isArray(page.scripts) || !page.scripts.every(script => typeof script === "string") ||
      !Array.isArray(page.deferred) || !page.deferred.every(script => script === null || typeof script === "string") ||
      page.deferred.filter(script => script === null).length !== 1) throw new Error("Invalid app page.");
  return page;
}

/**
 * Embed only as srcdoc with sandbox="allow-scripts", without allow-same-origin.
 * The parent CSP must include scriptSources and the child's permitted media and
 * network schemes. Srcdoc inherits that policy; this meta policy only narrows it.
 * This document contains no credentials and must not hold the launch session.
 */
export function createAppDocument(
  files: readonly AppDocumentFile[],
  limits: { maxBundleBytes: number; maxDocumentBytes: number },
): { html: string; sha256: string; byteLength: number; scriptSources: readonly string[] } {
  for (const value of [limits.maxBundleBytes, limits.maxDocumentBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid app document limit.");
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 3) throw new Error("Invalid app bundle inventory.");
  const contents = new Map<string, string>();
  let bundleBytes = 0;
  for (const file of files) {
    const expectedType = Object.hasOwn(APP_BUNDLE_CONTENT_TYPES, file.path) ? APP_BUNDLE_CONTENT_TYPES[file.path] : null;
    if (!expectedType || file.contentType !== expectedType || contents.has(file.path)) throw new Error("Invalid app bundle file.");
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== file.byteLength) throw new Error("App bundle length mismatch.");
    bundleBytes += file.bytes.byteLength;
    if (bundleBytes > limits.maxBundleBytes) throw new Error("App bundle exceeds its byte limit.");
    if (createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) throw new Error("App bundle digest mismatch.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
    contents.set(file.path, text);
  }
  const script = contents.get("bundle.js");
  if (script === undefined) throw new Error("App bundle has no script.");
  const page = contents.has("page.json") ? parsePage(contents.get("page.json")!) : null;
  // App text is data in the loader, then becomes a text node. HTML never parses
  // its closing tags, comments, or line endings as document syntax.
  const inlineJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const style = `const style=document.createElement("style");style.textContent=${inlineJson(contents.get("bundle.css") ?? "")};document.head.append(style);`;
  // Each script is its own element with its own hash, inserted in document order.
  const run = "const run=text=>{const script=document.createElement(\"script\");script.textContent=text;document.body.append(script);};";
  const loader = page
    ? `{${style}${run}const page=${inlineJson(page)},bundle=${inlineJson(script)},root=document.documentElement;` +
      "for(const[name,value]of page.html)root.setAttribute(name,value);if(page.title!==null)document.title=page.title;" +
      "for(const[name,value]of page.body)document.body.setAttribute(name,value);document.body.innerHTML=page.markup;" +
      "for(const text of page.scripts)run(text);const later=()=>{for(const text of page.deferred)run(text===null?bundle:text);};" +
      "if(document.readyState===\"loading\")document.addEventListener(\"readystatechange\",later,{once:true});else later();}"
    : `{${style}${run}run(${inlineJson(script)});}`;
  const texts = new Set([loader, script, ...(page ? [...page.scripts, ...page.deferred.filter((text): text is string => text !== null)] : [])]);
  const scriptSources = [...texts].map(text => `'sha256-${createHash("sha256").update(text).digest("base64")}'`);
  // Inline styles support React style properties. Script hashes limit browser
  // script loading; approved code can still interpret data it fetches.
  const csp = `default-src 'none'; script-src ${scriptSources.join(" ")}; style-src 'unsafe-inline'; ` +
    "connect-src https: http: wss: ws:; img-src data: blob: https: http:; font-src data: https: http:; " +
    "media-src data: blob: https: http:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '</head><body><div id="root"></div>' +
    `<script>${loader}</script></body></html>`;
  const byteLength = Buffer.byteLength(html);
  if (byteLength > limits.maxDocumentBytes) throw new Error("App document exceeds its byte limit.");
  return { html, byteLength, sha256: createHash("sha256").update(html).digest("hex"), scriptSources };
}
