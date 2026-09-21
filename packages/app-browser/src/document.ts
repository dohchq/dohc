import { createHash } from "node:crypto";

export interface AppDocumentFile {
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  contentType: string;
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
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw new Error("Invalid app bundle inventory.");
  const contents = new Map<string, string>();
  let bundleBytes = 0;
  for (const file of files) {
    const expectedType = file.path === "bundle.js" ? "text/javascript; charset=utf-8"
      : file.path === "bundle.css" ? "text/css; charset=utf-8" : null;
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
  // App text is data in the loader, then becomes a text node. HTML never parses
  // its closing tags, comments, or line endings as document syntax.
  const inlineJson = (text: string) => JSON.stringify(text).replaceAll("<", "\\u003c");
  const loader = `{const style=document.createElement("style");style.textContent=${inlineJson(contents.get("bundle.css") ?? "")};` +
    `document.head.append(style);const script=document.createElement("script");script.textContent=${inlineJson(script)};document.body.append(script);}`;
  const scriptSources = [loader, script].map(text => `'sha256-${createHash("sha256").update(text).digest("base64")}'`);
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
