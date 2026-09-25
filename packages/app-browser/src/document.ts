import { createHash } from "node:crypto";

export interface AppDocumentFile {
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  contentType: string;
}

/**
 * page.json: an HTML entry compiled for the browser to parse natively. The app
 * document is `<html>` with htmlAttributes, then `<head>` with the document's
 * own policy and bundle.js first and `head` after it, then `body`, which is the
 * whole `<body>` element. `scripts` holds every script text the page may run,
 * each pinned by hash in the policy: the page's inline scripts, template
 * scripts, and the stubs that run module and deferred scripts.
 */
export interface AppPage {
  htmlAttributes: Array<[string, string]>;
  head: string;
  body: string;
  scripts: string[];
}

export const APP_BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "bundle.js": "text/javascript; charset=utf-8",
  "bundle.css": "text/css; charset=utf-8",
  "page.json": "application/json; charset=utf-8",
};
/** Every script hash rides in the launch response's policy header, which browsers bound. */
export const APP_PAGE_MAX_SCRIPTS = 256;

const exact = (row: unknown, keys: readonly string[]): row is Record<string, unknown> =>
  !!row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).sort().join() === [...keys].sort().join();
/** Text that would end or re-escape a <script> element it sits in. */
const unsafeInlineScript = (source: string) => /<\/script/i.test(source) || (source.includes("<!--") && /<script/i.test(source));

/**
 * The one check on a page record, run by the compiler on what it emits and by
 * createAppDocument on what it loads. Returns null for a valid record, or the
 * problem as words that follow the page's file name.
 */
export function appPageProblem(page: unknown): string | null {
  const malformed = "did not compile into a valid page record.";
  if (!exact(page, ["htmlAttributes", "head", "body", "scripts"])) return malformed;
  const { htmlAttributes, head, body, scripts } = page;
  if (typeof head !== "string" || typeof body !== "string" || !/^<body[\s>]/.test(body) || !body.endsWith("</body>") ||
      !Array.isArray(scripts) || !scripts.every(script => typeof script === "string") || !Array.isArray(htmlAttributes)) return malformed;
  if (scripts.length > APP_PAGE_MAX_SCRIPTS) return `has more than ${APP_PAGE_MAX_SCRIPTS} scripts. Published apps can run at most ${APP_PAGE_MAX_SCRIPTS}. Combine some scripts into one file.`;
  for (const row of htmlAttributes) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string") return malformed;
    // The app document writes the <html> tag itself, so each name must stay one attribute name when parsed.
    if (!/^[^\s"'<>/=\0]+$/.test(row[0])) return `has an attribute named ${JSON.stringify(row[0])} on <html>. A published page cannot carry that name. Rename or remove the attribute.`;
  }
  return null;
}

function parsePage(text: string): AppPage {
  const page: unknown = JSON.parse(text);
  if (appPageProblem(page)) throw new Error("Invalid app page.");
  return page as AppPage;
}

const attributeValue = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(" ", "&nbsp;");

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
  if (page && (unsafeInlineScript(script) || contents.has("bundle.css"))) throw new Error("Invalid app page.");
  // Script text is data in the loader, then becomes a text node. HTML never parses
  // its closing tags, comments, or line endings as document syntax.
  const inlineJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const loader = `{const style=document.createElement("style");style.textContent=${inlineJson(contents.get("bundle.css") ?? "")};` +
    `document.head.append(style);const script=document.createElement("script");script.textContent=${inlineJson(script)};document.body.append(script);}`;
  // A page is parsed by the browser as written; bundle.js runs first in <head>, inline, before any page node.
  const texts = new Set(page ? [script, ...page.scripts] : [loader, script]);
  const scriptSources = [...texts].map(text => `'sha256-${createHash("sha256").update(text).digest("base64")}'`);
  // Inline styles support React style properties. Script hashes limit browser
  // script loading; approved code can still interpret data it fetches.
  const csp = `default-src 'none'; script-src ${scriptSources.join(" ")}; style-src 'unsafe-inline'; ` +
    "connect-src https: http: wss: ws:; img-src data: blob: https: http:; font-src data: https: http:; " +
    "media-src data: blob: https: http:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  // The document's own policy comes before any app markup, so the page can only narrow it.
  const policy = '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const html = page
    ? `<!doctype html><html${page.htmlAttributes.map(([name, value]) => ` ${name}="${attributeValue(value)}"`).join("")}><head>${policy}` +
      `<script>${script}</script>${page.head}</head>${page.body}</html>`
    : `<!doctype html><html><head>${policy}</head><body><div id="root"></div><script>${loader}</script></body></html>`;
  const byteLength = Buffer.byteLength(html);
  if (byteLength > limits.maxDocumentBytes) throw new Error("App document exceeds its byte limit.");
  return { html, byteLength, sha256: createHash("sha256").update(html).digest("hex"), scriptSources };
}
