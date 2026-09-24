import { createHash } from "node:crypto";

export interface AppDocumentFile {
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  contentType: string;
}

/** An attribute value; a number stands for the embedded image `images[n]`. */
export type AppPageValue = string | Array<string | number>;
/** Name, value, and the namespace of a foreign attribute such as xlink:href. */
export type AppPageAttribute = [string, AppPageValue] | [string, AppPageValue, "xlink" | "xml" | "xmlns"];
export type AppPageNode = string | { comment: string } | AppPageElement;
export interface AppPageElement {
  tag: string;
  ns?: "svg" | "math";
  attrs: AppPageAttribute[];
  children: AppPageNode[];
  /** A template's inert content. */
  content?: AppPageNode[];
  /** A classic script that runs where it stands: `scripts[run]`. */
  run?: number;
  /** A classic script that runs once parsing ends: `scripts[defer]`. */
  defer?: number;
  /** A module script: bundle.js's module entry `modules[module]`, run once parsing ends. */
  module?: number;
}
/**
 * page.json: an HTML entry compiled for the loader. The loader builds the page
 * node by node in document order. Each classic script runs as its own script
 * where it stands, so it sees only what came before it. Deferred and module
 * scripts run in document order once parsing ends. `scripts` holds every
 * script text the page may run, including inert template scripts.
 */
export interface AppPage {
  htmlAttributes: AppPageAttribute[];
  bodyAttributes: AppPageAttribute[];
  head: AppPageNode[];
  body: AppPageNode[];
  scripts: string[];
  images: string[];
  modules: number;
}

export const APP_BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "bundle.js": "text/javascript; charset=utf-8",
  "bundle.css": "text/css; charset=utf-8",
  "page.json": "application/json; charset=utf-8",
};
/** Every script hash rides in the launch response's policy header, which browsers bound. */
export const APP_PAGE_MAX_SCRIPTS = 256;
/** Browsers stop nesting parsed elements at 512 levels. */
export const APP_PAGE_MAX_DEPTH = 512;
/** bundle.js hands the page's module entries to the loader through this global, which the loader deletes. */
export const APP_PAGE_MODULES_GLOBAL = "__dohcPageModules";

const invalid = () => new Error("Invalid app page.");
const exact = (row: unknown, keys: readonly string[]): row is Record<string, unknown> =>
  !!row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).every(key => keys.includes(key));
const index = (value: unknown, length: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < length;

function parsePage(text: string): AppPage {
  const page: unknown = JSON.parse(text);
  const keys = ["htmlAttributes", "bodyAttributes", "head", "body", "scripts", "images", "modules"];
  if (!exact(page, keys) || keys.some(key => !Object.hasOwn(page, key))) throw invalid();
  const { scripts, images, modules } = page;
  if (!Array.isArray(scripts) || scripts.length > APP_PAGE_MAX_SCRIPTS || !scripts.every(script => typeof script === "string") ||
      !Array.isArray(images) || !images.every(image => typeof image === "string" && image.startsWith("data:image/")) ||
      !index(modules, APP_PAGE_MAX_SCRIPTS + 1)) throw invalid();
  const value = (parts: unknown) => typeof parts === "string" ||
    (Array.isArray(parts) && parts.every(part => typeof part === "string" || index(part, images.length)));
  const attributes = (rows: unknown) => Array.isArray(rows) && rows.every(row => Array.isArray(row) && (row.length === 2 || row.length === 3) &&
    typeof row[0] === "string" && /^[^\s/>=]+$/.test(row[0]) && value(row[1]) && (row.length === 2 || ["xlink", "xml", "xmlns"].includes(row[2])));
  const nodes = (list: unknown, depth: number): boolean => Array.isArray(list) && depth <= APP_PAGE_MAX_DEPTH && list.every(node => {
    if (typeof node === "string") return true;
    if (exact(node, ["comment"])) return typeof node.comment === "string";
    if (!exact(node, ["tag", "ns", "attrs", "children", "content", "run", "defer", "module"])) return false;
    return typeof node.tag === "string" && /^[^\s/>]+$/.test(node.tag) && (node.ns === undefined || node.ns === "svg" || node.ns === "math") &&
      attributes(node.attrs) && nodes(node.children, depth + 1) && (node.content === undefined || nodes(node.content, depth + 1)) &&
      (node.run === undefined || index(node.run, scripts.length)) && (node.defer === undefined || index(node.defer, scripts.length)) &&
      (node.module === undefined || index(node.module, modules as number));
  });
  if (!attributes(page.htmlAttributes) || !attributes(page.bodyAttributes) || !nodes(page.head, 1) || !nodes(page.body, 1)) throw invalid();
  return page as unknown as AppPage;
}

/**
 * Builds a compiled page inside the app document. It runs as one hashed script
 * with the page record, bundle, and styles as data; each script it creates
 * carries text whose hash the document's policy lists.
 */
const pageLoader = `(page, bundle, css) => {
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);
  const entry = document.createElement("script"); entry.textContent = bundle; document.head.append(entry); entry.remove();
  const modules = globalThis.${APP_PAGE_MODULES_GLOBAL} || []; delete globalThis.${APP_PAGE_MODULES_GLOBAL};
  const spaces = { svg: "http://www.w3.org/2000/svg", math: "http://www.w3.org/1998/Math/MathML",
    xlink: "http://www.w3.org/1999/xlink", xml: "http://www.w3.org/XML/1998/namespace", xmlns: "http://www.w3.org/2000/xmlns/" };
  const parse = markup => { const holder = document.createElement("template"); holder.innerHTML = markup; return holder.content.firstChild; };
  const value = parts => typeof parts === "string" ? parts : parts.map(part => typeof part === "number" ? page.images[part] : part).join("");
  const attribute = (element, [name, parts, space]) => {
    try { space ? element.setAttributeNS(spaces[space], name, value(parts)) : element.setAttribute(name, value(parts)); }
    catch {
      // The HTML parser accepts names the DOM methods refuse, such as @click.
      const holder = parse("<b " + name + ">"), node = holder.attributes[0];
      holder.removeAttributeNode(node); node.value = value(parts); element.setAttributeNode(node);
    }
  };
  const create = node => {
    const is = node.attrs.find(([name]) => name === "is");
    try { return node.ns ? document.createElementNS(spaces[node.ns], node.tag) : document.createElement(node.tag, is ? { is: value(is[1]) } : undefined); }
    catch { return node.ns ? parse("<" + node.ns + "><" + node.tag + ">").firstChild : parse("<" + node.tag + ">"); }
  };
  const later = [];
  const place = (nodes, parent) => {
    for (const node of nodes) {
      if (typeof node === "string") { parent.append(node); continue; }
      if ("comment" in node) { parent.append(document.createComment(node.comment)); continue; }
      const element = create(node);
      for (const row of node.attrs) attribute(element, row);
      if (node.run !== undefined) element.textContent = page.scripts[node.run];
      parent.append(element);
      if (node.defer !== undefined) later.push(() => { element.textContent = page.scripts[node.defer]; });
      if (node.module !== undefined) later.push(() => {
        try { modules[node.module](); } catch (error) { (globalThis.reportError || (thrown => setTimeout(() => { throw thrown; })))(error); }
      });
      if (node.content) place(node.content, element.content);
      place(node.children, element);
    }
  };
  // The loader is the body's last node while the parser runs it.
  (document.currentScript || document.body.lastChild).remove();
  for (const row of page.htmlAttributes) attribute(document.documentElement, row);
  for (const row of page.bodyAttributes) attribute(document.body, row);
  place(page.head, document.head);
  place(page.body, document.body);
  const finish = () => { for (const step of later) step(); };
  if (document.readyState === "loading") document.addEventListener("readystatechange", finish, { once: true }); else finish();
}`;

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
  const css = contents.get("bundle.css") ?? "";
  const loader = page
    ? `(${pageLoader})(${inlineJson(page)}, ${inlineJson(script)}, ${inlineJson(css)});`
    : `{const style=document.createElement("style");style.textContent=${inlineJson(css)};` +
      `document.head.append(style);const script=document.createElement("script");script.textContent=${inlineJson(script)};document.body.append(script);}`;
  const texts = new Set([loader, script, ...(page?.scripts ?? [])]);
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
    `</head><body>${page ? "" : '<div id="root"></div>'}` +
    `<script>${loader}</script></body></html>`;
  const byteLength = Buffer.byteLength(html);
  if (byteLength > limits.maxDocumentBytes) throw new Error("App document exceeds its byte limit.");
  return { html, byteLength, sha256: createHash("sha256").update(html).digest("hex"), scriptSources };
}
