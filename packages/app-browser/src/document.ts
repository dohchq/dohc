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

const exact = (row: unknown, keys: readonly string[]): row is Record<string, unknown> =>
  !!row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).every(key => keys.includes(key));
const index = (value: unknown, length: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < length;
const imageUrl = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/;

/**
 * The one check on a page record, run by the compiler on what it emits and by
 * createAppDocument on what it loads. Returns null for a valid record, or the
 * problem as words that follow the page's file name.
 */
export function appPageProblem(page: unknown): string | null {
  const keys = ["htmlAttributes", "bodyAttributes", "head", "body", "scripts", "images", "modules"];
  const malformed = "did not compile into a valid page record.";
  if (!exact(page, keys) || keys.some(key => !Object.hasOwn(page, key))) return malformed;
  const { scripts, images, modules } = page;
  if (!Array.isArray(scripts) || !scripts.every(script => typeof script === "string") ||
      !Array.isArray(images) || !images.every(image => typeof image === "string" && imageUrl.test(image)) ||
      !index(modules, APP_PAGE_MAX_SCRIPTS + 1)) return malformed;
  if (scripts.length > APP_PAGE_MAX_SCRIPTS) return `has more than ${APP_PAGE_MAX_SCRIPTS} scripts. Published apps can run at most ${APP_PAGE_MAX_SCRIPTS}. Combine some scripts into one file.`;
  const value = (parts: unknown) => typeof parts === "string" ||
    (Array.isArray(parts) && parts.every(part => typeof part === "string" || index(part, images.length)));
  const attributes = (rows: unknown): string | null => {
    if (!Array.isArray(rows)) return malformed;
    for (const row of rows) {
      if (!Array.isArray(row) || (row.length !== 2 && row.length !== 3) || typeof row[0] !== "string" || !value(row[1]) ||
          (row.length === 3 && !["xlink", "xml", "xmlns"].includes(row[2]))) return malformed;
      // The loader recreates a name through the HTML parser when the DOM refuses it, so the name must survive that parse.
      if (!/^[^\s/>=]+$/.test(row[0])) return `has an attribute named ${JSON.stringify(row[0])}. A published page cannot carry that name. Rename or remove the attribute.`;
    }
    return null;
  };
  const nodes = (list: unknown, depth: number): string | null => {
    if (!Array.isArray(list)) return malformed;
    if (depth > APP_PAGE_MAX_DEPTH) return `nests elements more than ${APP_PAGE_MAX_DEPTH} levels deep. Browsers stop nesting there. Flatten the markup.`;
    for (const node of list) {
      if (typeof node === "string") continue;
      if (exact(node, ["comment"])) { if (typeof node.comment !== "string") return malformed; continue; }
      if (!exact(node, ["tag", "ns", "attrs", "children", "content", "run", "defer", "module"]) || typeof node.tag !== "string") return malformed;
      if (!/^[A-Za-z][^\s/>]*$/.test(node.tag)) return `has an element named ${JSON.stringify(node.tag)}. A published page cannot carry that name. Rename the element.`;
      if ((node.ns !== undefined && node.ns !== "svg" && node.ns !== "math") ||
          (node.content !== undefined && (node.tag !== "template" || node.ns !== undefined)) ||
          (node.run !== undefined && !index(node.run, scripts.length)) || (node.defer !== undefined && !index(node.defer, scripts.length)) ||
          (node.module !== undefined && !index(node.module, modules as number))) return malformed;
      const problem = attributes(node.attrs) ?? nodes(node.children, depth + 1) ?? (node.content === undefined ? null : nodes(node.content, depth + 1));
      if (problem) return problem;
    }
    return null;
  };
  return attributes(page.htmlAttributes) ?? attributes(page.bodyAttributes) ?? nodes(page.head, 1) ?? nodes(page.body, 1);
}

function parsePage(text: string): AppPage {
  const page: unknown = JSON.parse(text);
  if (appPageProblem(page)) throw new Error("Invalid app page.");
  return page as AppPage;
}

/**
 * Builds a compiled page inside the app document. It runs as one hashed script
 * with the page record, bundle, and styles as data; each script it creates
 * carries text whose hash the document's policy lists. Page markup can name
 * elements after document and form members, and page scripts can replace DOM
 * methods, so the loader takes its own references before any page node exists.
 */
const pageLoader = `(page, bundle, css) => {
  const apply = Reflect.apply, own = (owner, name, kind = "value") => Object.getOwnPropertyDescriptor(owner.prototype, name)[kind];
  const createElement = own(Document, "createElement"), createElementNS = own(Document, "createElementNS");
  const createComment = own(Document, "createComment"), createTextNode = own(Document, "createTextNode");
  const setAttribute = own(Element, "setAttribute"), setAttributeNS = own(Element, "setAttributeNS");
  const setAttributeNode = own(Element, "setAttributeNode"), removeAttributeNode = own(Element, "removeAttributeNode");
  const attributes = own(Element, "attributes", "get"), setHtml = own(Element, "innerHTML", "set");
  const appendChild = own(Node, "appendChild"), removeChild = own(Node, "removeChild");
  const firstChild = own(Node, "firstChild", "get"), setText = own(Node, "textContent", "set");
  const content = own(HTMLTemplateElement, "content", "get"), readyState = own(Document, "readyState", "get");
  const listen = own(EventTarget, "addEventListener"), createObjectURL = URL.createObjectURL;
  const root = document.documentElement, head = document.head, body = document.body, loader = document.currentScript || body.lastChild;
  const make = tag => apply(createElement, document, [tag]), append = (parent, node) => apply(appendChild, parent, [node]);
  const style = make("style"); apply(setText, style, [css]); append(head, style);
  const entry = make("script"); apply(setText, entry, [bundle]); append(head, entry); apply(removeChild, head, [entry]);
  const modules = globalThis.${APP_PAGE_MODULES_GLOBAL} || []; delete globalThis.${APP_PAGE_MODULES_GLOBAL};
  // Each embedded image becomes one blob URL that every reference shares.
  const images = page.images.map(url => {
    const binary = atob(url.slice(url.indexOf(",") + 1)), bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return createObjectURL(new Blob([bytes], { type: url.slice(5, url.indexOf(";")) }));
  });
  const spaces = { svg: "http://www.w3.org/2000/svg", math: "http://www.w3.org/1998/Math/MathML",
    xlink: "http://www.w3.org/1999/xlink", xml: "http://www.w3.org/XML/1998/namespace", xmlns: "http://www.w3.org/2000/xmlns/" };
  const parse = markup => { const holder = make("template"); apply(setHtml, holder, [markup]); return apply(firstChild, apply(content, holder, []), []); };
  const value = parts => typeof parts === "string" ? parts : parts.map(part => typeof part === "number" ? images[part] : part).join("");
  const attribute = (element, [name, parts, space]) => {
    try { space ? apply(setAttributeNS, element, [spaces[space], name, value(parts)]) : apply(setAttribute, element, [name, value(parts)]); }
    catch {
      // The HTML parser accepts names the DOM methods refuse, such as @click.
      const holder = parse("<b " + name + ">"), node = apply(attributes, holder, [])[0];
      apply(removeAttributeNode, holder, [node]); node.value = value(parts); apply(setAttributeNode, element, [node]);
    }
  };
  const create = node => {
    const is = node.attrs.find(([name]) => name === "is");
    try { return node.ns ? apply(createElementNS, document, [spaces[node.ns], node.tag]) : apply(createElement, document, is ? [node.tag, { is: value(is[1]) }] : [node.tag]); }
    catch { return node.ns ? apply(firstChild, parse("<" + node.ns + "><" + node.tag + ">"), []) : parse("<" + node.tag + ">"); }
  };
  const later = [];
  const place = (nodes, parent) => {
    for (const node of nodes) {
      if (typeof node === "string") { append(parent, apply(createTextNode, document, [node])); continue; }
      if ("comment" in node) { append(parent, apply(createComment, document, [node.comment])); continue; }
      const element = create(node);
      for (const row of node.attrs) attribute(element, row);
      if (node.run !== undefined) apply(setText, element, [page.scripts[node.run]]);
      append(parent, element);
      if (node.defer !== undefined) later[later.length] = () => apply(setText, element, [page.scripts[node.defer]]);
      if (node.module !== undefined) later[later.length] = () => {
        try { modules[node.module](); } catch (error) { (globalThis.reportError || (thrown => setTimeout(() => { throw thrown; })))(error); }
      };
      if (node.content) place(node.content, apply(content, element, []));
      place(node.children, element);
    }
  };
  // The loader is the body's last node while the parser runs it.
  apply(removeChild, body, [loader]);
  for (const row of page.htmlAttributes) attribute(root, row);
  for (const row of page.bodyAttributes) attribute(body, row);
  place(page.head, head);
  place(page.body, body);
  const finish = () => { for (const step of later) step(); };
  if (apply(readyState, document, []) === "loading") apply(listen, document, ["readystatechange", finish, { once: true }]); else finish();
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
