import {
  discoverSites,
  hasIgnoredSegment,
  isSharedWithMePath,
  needsBuiltArtifact,
  parseDohcSiteConfig,
  presentBuildOutput,
  type SiteDiagnostic,
  type SitePackageManager,
  type SiteScripts,
  type WorkspaceSite,
  type WorkspaceSiteSource,
} from "@dohc/workspace-core";
import { MAX_SHARE_PATH_CHARS } from "@dohc/security-contract";
import * as acorn from "acorn";
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseHtml } from "parse5";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
import {
  assertLoopbackOnlyDevServerCommand,
  isPathAllowedForAuthority,
  splitCommandLine,
} from "./siteRunner";
import { listFiles } from "./workspaceFiles";

export type SiteAuthority =
  | { kind: "workspace" }
  | { kind: "share"; mountRoot: string };

export interface SitePackageInfo {
  root: string;
  title: string;
  kind: "static" | "package" | "configured";
  confidence: "high" | "medium" | "low";
  entryPath: string | null;
  configPath: string | null;
  packagePath: string | null;
  packageManager: SitePackageManager | null;
  scripts: Record<string, string>;
  configuredScripts: SiteScripts;
  configuredPreviewMode: "static" | "dev" | "build" | null;
  configuredBuildOutput: string | null;
  buildOutputs: string[];
  sourceFiles: string[];
  shareManifest: SiteShareManifestResult;
  diagnostics: SiteDiagnostic[];
  authority: SiteAuthority;
}

export interface SiteShareManifest {
  entryPath: string;
  assets: string[];
}

export type SiteShareManifestResult =
  | { ok: true; manifest: SiteShareManifest }
  | { ok: false; reason: "no-runnable-artifact" }
  | {
      ok: false;
      reason: "byte-budget";
      limitBytes: number;
      observedBytes: number;
    }
  | {
      ok: false;
      reason: "file-count";
      limitFiles: number;
      observedFiles: number;
    }
  | {
      ok: false;
      reason: "path-too-long";
      limitChars: number;
      observedChars: number;
      path: string;
    }
  | { ok: false; reason: "unreadable"; path: string }
  | { ok: false; reason: "non-file-reference"; path: string };

function normalizeRoot(root: string): string {
  return root === "" ? "." : root;
}

function denormalizeRoot(root: string): string {
  return root === "." ? "" : root;
}

const MAX_SHARE_MANIFEST_FILES = 100;
const MAX_SHARE_MANIFEST_SCAN_BYTES = 4 * 1024 * 1024;

function joinSitePath(root: string, relativePath: string): string {
  const normalized = normalizeRoot(root);
  return normalized === "." ? relativePath : `${normalized}/${relativePath}`;
}

function isUnder(root: string, path: string): boolean {
  const normalized = normalizeRoot(root);
  // `shared-with-me` is a real local folder, not hidden metadata; shared sites
  // under it should be detected and previewed like any other local website.
  if (normalized === ".") return !path.startsWith(".dohc/");
  return path === normalized || path.startsWith(`${normalized}/`);
}

/**
 * Returns the collaboration mount that owns a site, if any. Mounted shares
 * always have the shape shared-with-me/<label>/...; keeping the mount root on
 * the detected package lets preview/runtime surfaces preserve that authority
 * without treating the shared files as an owned workspace site.
 */
export function shareMountRootForSite(root: string): string | null {
  const parts = normalizeRoot(root).split("/");
  if (
    parts.length < 2 ||
    !isSharedWithMePath(root) ||
    !parts[1] ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    return null;
  }
  return `shared-with-me/${parts[1]}`;
}

function pathRelativeToArtifact(artifactRoot: string, path: string): string | null {
  if (artifactRoot === ".") return path;
  return path.startsWith(`${artifactRoot}/`)
    ? path.slice(artifactRoot.length + 1)
    : null;
}

// RFC 3986's scheme grammar — the one name every "is this value an absolute
// URL, not a local path" check in this file shares. A narrower allowlist
// (data|https?|javascript|mailto|tel|...) always misses some real scheme
// (blob:, file:, a custom app:, ...) that a browser still parses as
// absolute; on a platform where `:` is a legal filename character, a value
// like `file:private.txt` would otherwise fall through to filesystem
// resolution and can approve an unrelated same-named file.
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Resolves a raw reference to an artifact-root-relative path, or null when
 * it's a fragment/scheme-bearing/external value — the core join logic every
 * "where does this reference actually point" question in this file shares
 * (a plain local-path lookup, an import-map address, a <base href>). */
function resolveArtifactRelativePath(
  rawReference: string,
  fromPath: string,
  artifactRoot: string,
  base: HtmlBaseResolution,
): string | null {
  // A browser's URL parser normalizes `\` to `/` in the path of a special
  // scheme (http/https/file) before resolution — on EVERY platform, not
  // just Windows. Do the same here, on the raw reference, before any
  // path-joining, so a site authored with backslash separators resolves
  // the way it would in a real browser instead of naming a literal
  // backslash-containing filename that never exists on disk.
  const raw = rawReference.trim().split(/[?#]/, 1)[0]?.trim().replaceAll("\\", "/") ?? "";
  if (
    !raw ||
    raw.startsWith("#") ||
    raw.startsWith("//") ||
    URI_SCHEME_PATTERN.test(raw)
  ) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (base.kind === "external") return null;
  const artifactBase = artifactRoot === "." ? "" : artifactRoot;
  const candidate = posix.normalize(
    decoded.startsWith("/")
      ? posix.join(artifactBase, decoded.replace(/^\/+/, ""))
      : posix.join(
          base.kind === "local" ? base.directory : posix.dirname(fromPath),
          decoded,
        ),
  );
  if (
    !pathRelativeToArtifact(artifactRoot, candidate) ||
    hasIgnoredSegment(candidate)
  ) return null;
  return candidate;
}

function localReferenceCandidates(
  rawReference: string,
  fromPath: string,
  artifactRoot: string,
  available: ReadonlySet<string>,
  base: HtmlBaseResolution = { kind: "none" },
): string[] {
  const candidate = resolveArtifactRelativePath(rawReference, fromPath, artifactRoot, base);
  if (!candidate) return [];
  return available.has(candidate) ? [candidate] : [];
}

type HtmlBaseResolution =
  | { kind: "local"; directory: string }
  | { kind: "external" }
  | { kind: "none" };

// A structural view of the exact shape parse5's real tree nodes satisfy
// (Document/DocumentFragment/Element/Template/CommentNode/TextNode/
// DocumentType) — loose enough to avoid fighting parse5's own discriminated
// union export names, precise enough to stay type-safe (no `any`).
interface Html5Attribute {
  name: string;
  value: string;
}
interface Html5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Html5Attribute[];
  value?: string;
  childNodes?: Html5Node[];
  content?: { childNodes: Html5Node[] };
}

function isHtml5Element(node: Html5Node): node is Html5Node & { tagName: string; attrs: Html5Attribute[] } {
  return typeof node.tagName === "string";
}

// A <template>'s markup children live in `.content` (an inert document
// fragment per the HTML spec), not its own (always-empty) `.childNodes` —
// but that fragment is not part of the document tree. A browser fetches
// nothing inside inert template content until it's cloned and inserted, and
// a `<base>` inside one never affects the containing document's base URL —
// exclude it entirely, from base selection AND from reference scanning.
function html5ChildNodes(node: Html5Node): Html5Node[] {
  return node.content ? [] : (node.childNodes ?? []);
}

function html5TextContent(node: Html5Node): string {
  return html5ChildNodes(node)
    .filter((child) => child.nodeName === "#text")
    .map((child) => child.value ?? "")
    .join("");
}

// "module" is never a MIME type essence (no "type/subtype" shape) — the
// spec matches it as an exact keyword on its OWN, never through MIME
// parsing, so it's deliberately excluded from this list.
const JS_SCRIPT_TYPE_PATTERN =
  /^(?:text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript|text\/x-javascript|text\/x-ecmascript)$/i;

/** A non-JavaScript `type` (`application/json`, `text/template`, ...) makes
 * a <script> a data block — its own `src` attribute never fires a request
 * (src only applies to classic and module scripts) and its body is data,
 * never code a browser executes. A missing type, the exact `module`
 * keyword, and a classic JS MIME essence are all executable. */
function isExecutableScriptType(attrs: ReadonlyMap<string, string>): boolean {
  const type = attrs.get("type");
  if (!type) return true;
  const trimmed = type.trim();
  // The exact keyword check runs BEFORE MIME parsing, on the whole trimmed
  // value — `type="module;foo"` is neither this keyword nor a MIME
  // essence, so it's a data block, not a module (round-15 finding 3: a
  // prior essence-first version wrongly reduced "module;foo" to essence
  // "module" and matched it here).
  if (trimmed.toLowerCase() === "module") return true;
  // A `type` is otherwise a MIME type — only its ESSENCE (the type/subtype
  // before any `;parameter=value`) is what a browser compares against the
  // JS list. `text/javascript; charset=utf-8` is exactly as executable as
  // `text/javascript` alone.
  const essence = trimmed.split(";", 1)[0]?.trim() ?? "";
  return JS_SCRIPT_TYPE_PATTERN.test(essence);
}

/** A `<script>` with its own `src` never executes its body — the browser
 * fetches and runs the external file instead, and the body (sometimes a
 * fallback/polyfill payload) is inert. */
function isExecutableScriptElement(attrs: ReadonlyMap<string, string>): boolean {
  return !attrs.has("src") && isExecutableScriptType(attrs);
}

/** `<input src="...">` only fetches an image when it renders as one. */
function isImageInputElement(attrs: ReadonlyMap<string, string>): boolean {
  return attrs.get("type")?.toLowerCase() === "image";
}

// <meta http-equiv="refresh" content="0;url=target.html"> navigates the
// browser to `target.html` after the given delay — a literal navigation
// dependency the URL_ATTRIBUTE_ELEMENTS mechanism doesn't cover, since the
// URL lives inside a mini-syntax packed into `content`, not its own
// attribute. A bare delay with no "url=" part (content="5") just re-loads
// the current document and names no separate target.
const META_REFRESH_URL_PATTERN = /^\s*[\d.]*\s*[;,]\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S.*))$/i;

function metaRefreshTarget(content: string): string | undefined {
  const match = META_REFRESH_URL_PATTERN.exec(content);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return raw || undefined;
}

// Which elements a URL-bearing attribute actually fires a request from, per
// the HTML spec — the same list every attribute-reference consumer below
// shares, so a `<div data="...">` (data means nothing there) can't mint one.
const URL_ATTRIBUTE_ELEMENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  src: new Set([
    "script",
    "img",
    "audio",
    "video",
    "iframe",
    "source",
    "track",
    "embed",
    "input",
  ]),
  srcset: new Set(["img", "source"]),
  // "image" and "use" also cover the SVG-namespace elements — parse5
  // exposes an xlink:href attribute with name "href" and a separate
  // prefix field, so it already reaches this same allowlist entry.
  href: new Set(["a", "link", "area", "image", "use"]),
  poster: new Set(["video"]),
  data: new Set(["object"]),
  // A default-GET form submission navigates to `action`; a submit control's
  // own `formaction` overrides it for that one control. Both are literal
  // navigation targets a real browser follows on submit, the same way
  // clicking an `<a href>` follows that target.
  action: new Set(["form"]),
  formaction: new Set(["button", "input"]),
};

// A <link href> counts only when its `rel` names a token the browser
// actually fetches for — an alternate/canonical/author/search/etc. link
// never triggers a request the way a stylesheet or icon does. `rel` is a
// space-separated token list. `preload` only fetches when paired with `as`
// (it names WHAT is being preloaded, and without it the browser treats the
// link as inert); `modulepreload` needs no `as` — a missing `as` there
// defaults to the "script" destination and the fetch still happens.
const LINK_REL_RESOURCE_TOKENS = new Set([
  "stylesheet",
  "icon",
  "shortcut",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "manifest",
  "prefetch",
  "modulepreload",
]);
const LINK_REL_TOKENS_REQUIRING_AS = new Set(["preload"]);

// Fetch's request-destination keywords — the only valid `as` values for
// rel="preload". An invalid, unrecognized, or empty `as` gets no
// destination state at all: the browser aborts preload processing and
// makes no request, so the mere PRESENCE of the attribute isn't enough.
const PRELOAD_AS_DESTINATIONS = new Set([
  "audio", "audioworklet", "document", "embed", "fencedframe", "font",
  "frame", "iframe", "image", "manifest", "object", "paintworklet",
  "report", "script", "sharedworker", "style", "track", "video",
  "webidentity", "worker", "xslt",
]);

function isResourceConsumingLinkRel(relValue: string | undefined, asValue: string | undefined): boolean {
  if (!relValue) return false;
  const hasValidAs = !!asValue && PRELOAD_AS_DESTINATIONS.has(asValue.trim().toLowerCase());
  for (const token of relValue.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (LINK_REL_RESOURCE_TOKENS.has(token)) return true;
    if (LINK_REL_TOKENS_REQUIRING_AS.has(token) && hasValidAs) return true;
  }
  return false;
}

/** The first <base> element's href in document order — the only one that
 * counts per the HTML spec. */
function firstBaseHref(document: Html5Node): string | undefined {
  let found: string | undefined;
  const visit = (node: Html5Node): void => {
    if (found !== undefined) return;
    if (isHtml5Element(node)) {
      if (node.tagName === "base") {
        const href = node.attrs.find((attr) => attr.name === "href")?.value;
        if (href !== undefined) {
          found = href;
          return;
        }
      }
    }
    for (const child of html5ChildNodes(node)) visit(child);
  };
  visit(document);
  return found;
}

function htmlBaseDirectoryFromDocument(
  document: Html5Node,
  fromPath: string,
  artifactRoot: string,
  // A real file's own <base href> resolves relative to ITS OWN directory
  // (the default, "none"). A srcdoc pseudo-document has no file of its own —
  // its <base href>, if it declares one, resolves against the EMBEDDING
  // document's base instead, so a caller threading that base in as
  // `contextBase` gets correct resolution without a special case here.
  contextBase: HtmlBaseResolution = { kind: "none" },
): HtmlBaseResolution {
  // parse5 already decoded any HTML character reference in the href value —
  // only the URL-level percent-encoding below is still this function's job.
  const rawHref = firstBaseHref(document);
  if (!rawHref || rawHref.startsWith("#")) return { kind: "none" };
  // Same browser-URL-parser backslash normalization as
  // resolveArtifactRelativePath, applied BEFORE the external-base check —
  // a browser normalizes `\\host\...` to the network-path reference
  // `//host/...` and resolves it against that external host. Checking for
  // "//" on the raw, unnormalized href would instead let it fall through
  // to the root-relative branch below and resolve as a local directory.
  const href = rawHref.replaceAll("\\", "/");
  if (
    href.startsWith("//") ||
    URI_SCHEME_PATTERN.test(href)
  ) return { kind: "external" };
  if (contextBase.kind === "external") return { kind: "external" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return { kind: "external" };
  }
  if (!decoded) return { kind: "none" };
  const artifactBase = artifactRoot === "." ? "" : artifactRoot;
  const resolved = posix.normalize(
    decoded.startsWith("/")
      ? posix.join(artifactBase, decoded.replace(/^\/+/, ""))
      : posix.join(
          contextBase.kind === "local" ? contextBase.directory : posix.dirname(fromPath),
          decoded,
        ),
  );
  const directory = decoded.endsWith("/") ? resolved : posix.dirname(resolved);
  return (directory === artifactRoot ||
    pathRelativeToArtifact(artifactRoot, directory) !== null) &&
    !hasIgnoredSegment(directory)
    ? { kind: "local", directory }
    : { kind: "external" };
}

function referencesFromWebManifest(text: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const record = manifest as Record<string, unknown>;
  const references: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) references.push(value);
  };
  const addImages = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const image of value) {
      if (image && typeof image === "object" && !Array.isArray(image)) {
        add((image as Record<string, unknown>).src);
      }
    }
  };

  add(record.start_url);
  addImages(record.icons);
  addImages(record.screenshots);
  if (Array.isArray(record.shortcuts)) {
    for (const shortcut of record.shortcuts) {
      if (!shortcut || typeof shortcut !== "object" || Array.isArray(shortcut)) continue;
      const shortcutRecord = shortcut as Record<string, unknown>;
      add(shortcutRecord.url);
      addImages(shortcutRecord.icons);
    }
  }
  return references;
}

function referencesFromSrcset(value: string): string[] {
  const references: string[] = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\t\n\f\r ,]/.test(value[position]!)) {
      position += 1;
    }
    if (position >= value.length) break;

    const urlStart = position;
    while (position < value.length && !/[\t\n\f\r ]/.test(value[position]!)) {
      position += 1;
    }
    let url = value.slice(urlStart, position);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      if (url) references.push(url);
      continue;
    }

    let parentheses = 0;
    while (position < value.length) {
      const character = value[position]!;
      position += 1;
      if (character === "(") parentheses += 1;
      else if (character === ")" && parentheses > 0) parentheses -= 1;
      else if (character === "," && parentheses === 0) break;
    }
    references.push(url);
  }
  return references;
}

export interface BrowserTextReference {
  value: string;
  // True for a reference the browser resolves against the DOCUMENT's base
  // URL at runtime (fetch/Worker/SharedWorker/serviceWorker.register, and a
  // real DOM property assignment or setAttribute call for src/href/poster).
  // False for a reference ES modules resolve against the SCRIPT's own module
  // URL (import/export, dynamic import, new URL(...,import.meta.url),
  // importScripts) or CSS resolves against the stylesheet's own location
  // (url()/@import). An HTML file's own markup (attributes, inline CSS,
  // inline modules) already resolves uniformly against that file's own
  // <base>-aware directory regardless of this flag — it only changes
  // resolution for a reference read out of a separate external .js/.mjs
  // file, where the script's own location and the document's location can
  // genuinely differ.
  documentRelative: boolean;
  // True only for a Worker/SharedWorker/serviceWorker.register target: that
  // script runs in its OWN global scope with its own location, so anything
  // IT references (once loaded) resolves against ITS directory, not the
  // document that launched it.
  entersOwnContext?: boolean;
  // True for a <link rel="manifest"> target: the browser treats it as a web
  // app manifest regardless of its file extension (a "manifest.json" is as
  // real a manifest as a ".webmanifest" file) — carried onto the queue so
  // the scan's extension gate yields to this instead of skipping the file.
  isManifest?: boolean;
  // The grammar a JS target parses with once reached — "module" only for an
  // import/export/dynamic-import specifier (the only constructs that can
  // ONLY appear in a module); every other JS-reaching reference (a classic
  // <script src>, Worker/serviceWorker/importScripts targets, a fetched or
  // assigned .js file) defaults to "classic" when unset. An ordinary
  // <script src> with module-only syntax is a syntax error in a REAL
  // browser — parsing with the wrong grammar would accept it anyway.
  scriptKind?: ScriptKind;
}

// CSS still isn't parsed with a real parser (out of this round's scope) —
// url()/@import stay pattern-matched, but only over text a browser's CSS
// parser would actually read: a real <style> element's content, a style=""
// attribute value, or an entire external .css file. A CSS comment produces
// no tokens at all (unlike an HTML comment, which parse5 already keeps out
// of the tree as a separate node) — blank comments before matching so
// `/* url("private.txt") */` can't mint a reference the parser never sees.
const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?(?:\*\/|$)/g;
// A quoted string token that ISN'T itself url()'s or @import's own argument
// is just a CSS value (`content: 'url("x")'`) — the tokenizer never
// re-reads inside it for url()/@import syntax. Blanking every OTHER string
// token before matching (like comments) keeps that text a browser's CSS
// parser would never treat as a reference from minting one; a string
// immediately preceded by "url(" or "@import " is left alone so the
// patterns below can still extract it.
const CSS_STRING_PATTERN = /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'/g;
const CSS_URL_PATTERN =
  /url\(\s*(?:"([^"]{1,2048})"|'([^']{1,2048})'|([^"')\s][^)]{0,2047}))\s*\)/gi;
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?["']([^"']{1,2048})["']/gi;

function blankCssStrings(cssText: string): string {
  return cssText.replace(CSS_STRING_PATTERN, (match, offset: number, full: string) => {
    const before = full.slice(Math.max(0, offset - 64), offset);
    if (/url\(\s*$/i.test(before) || /@import\s+$/i.test(before)) return match;
    return match.replace(/[^\r\n]/g, " ");
  });
}

function cssReferences(rawCssText: string): BrowserTextReference[] {
  const withoutComments = rawCssText.replace(CSS_COMMENT_PATTERN, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );
  const cssText = blankCssStrings(withoutComments);
  const references: BrowserTextReference[] = [];
  for (const match of cssText.matchAll(CSS_URL_PATTERN)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim();
    if (value) references.push({ value, documentRelative: false });
  }
  for (const match of cssText.matchAll(CSS_IMPORT_PATTERN)) {
    const value = match[1]?.trim();
    if (value) references.push({ value, documentRelative: false });
  }
  return references;
}

// ---- JS: parse and walk the real AST (acorn) instead of pattern-matching
// source text — comments and string prose stop being code definitionally.

type AstNode = Record<string, unknown> & { type: string };

function isAstNode(value: unknown): value is AstNode {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string";
}

function astString(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

function astChild(node: AstNode, key: string): unknown {
  return node[key];
}

function astChildren(node: AstNode, key: string): unknown[] {
  const value = node[key];
  return Array.isArray(value) ? value : [];
}

/** Visits every node in the tree, generically — acorn's AST has no single
 * base visitor shape worth importing a walker library for; every node's own
 * properties already say which of its values are child nodes or arrays of
 * them (anything object-shaped that isn't loc/range/start/end). */
function walkAst(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") visit(record as AstNode);
  for (const [key, value] of Object.entries(record)) {
    if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) walkAst(item, visit);
    } else if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function stringLiteralValue(node: unknown): string | undefined {
  if (!isAstNode(node)) return undefined;
  if (node.type === "Literal") {
    const value = node.value;
    return typeof value === "string" ? value : undefined;
  }
  // A substitution-free template literal (`` `data.json` ``) is a constant
  // string to the browser, same as "data.json" — Acorn represents even a
  // plain backtick string as TemplateLiteral, never Literal.
  if (node.type === "TemplateLiteral") {
    const expressions = astChildren(node, "expressions");
    const quasis = astChildren(node, "quasis");
    if (expressions.length > 0 || quasis.length !== 1) return undefined;
    const quasi = quasis[0];
    if (!isAstNode(quasi)) return undefined;
    const templateValue = quasi.value;
    if (!templateValue || typeof templateValue !== "object") return undefined;
    const cooked = (templateValue as Record<string, unknown>).cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

/** `import.meta.url` — acorn represents `import.meta` as a MetaProperty. */
function isImportMetaUrl(node: unknown): boolean {
  if (!isAstNode(node) || node.type !== "MemberExpression") return false;
  const object = astChild(node, "object");
  const property = astChild(node, "property");
  if (!isAstNode(object) || object.type !== "MetaProperty") return false;
  return isAstNode(property) && property.type === "Identifier" && astString(property, "name") === "url";
}

// Finding 2/3's stance: a property assignment (`X.src = lit`) or
// `X.setAttribute("src", lit)` only counts as a real browser-consumed
// reference when X is PROVABLY a DOM element of a tag the HTML spec
// actually fires that property/attribute from — the result of
// document.createElement("TAG")/body/head with a known tag, or a variable
// assigned from one. DOM provenance alone does NOT prove resource semantics
// (`document.createElement("div").src` is an inert expando, no request
// happens); querySelector/getElementById produce a real element but an
// UNKNOWN tag, so they can never satisfy the (tag, property) check either —
// unprovable stays out, the same rule (tag, property) already enumerates
// for markup via URL_ATTRIBUTE_ELEMENTS, reused here rather than duplicated.
// For a share manifest, under-inclusion breaks a share visibly (a missing
// asset 404s in the open tab); over-inclusion discloses a file silently.
type DomProducingTag = string | "unknown";

// Finding 3: the browser globals this scanner trusts by identifier name —
// document, fetch, Worker, SharedWorker, URL, importScripts — must be the
// REAL globals, not a same-named local. Over-conservative by design: if the
// program declares ANY binding for the name anywhere (a function, a var/
// let/const, a parameter, a class, or an import specifier), the whole file
// treats that name as shadowed and excludes every use of it, rather than
// attempting real lexical scope resolution for a heuristic scanner.
const TRUSTED_GLOBAL_NAMES = new Set([
  "document",
  "fetch",
  "Worker",
  "SharedWorker",
  "URL",
  "importScripts",
  "window",
  "globalThis",
  "navigator",
]);
// window.X / globalThis.X are the same real global as bare X — an object
// merely NAMED "window" that isn't provably the browser global proves
// nothing (and isn't reachable outside a shadowed binding anyway, since
// "window"/"globalThis" are themselves tracked as trusted names above).
const GLOBAL_OBJECT_NAMES = new Set(["window", "globalThis"]);

function collectShadowedGlobalNames(program: AstNode): Set<string> {
  const shadowed = new Set<string>();
  const noteBindingTarget = (node: unknown): void => {
    if (!isAstNode(node)) return;
    if (node.type === "Identifier") {
      const name = astString(node, "name");
      if (name && TRUSTED_GLOBAL_NAMES.has(name)) shadowed.add(name);
      return;
    }
    if (node.type === "AssignmentPattern") {
      noteBindingTarget(astChild(node, "left"));
      return;
    }
    if (node.type === "RestElement") {
      noteBindingTarget(astChild(node, "argument"));
      return;
    }
    if (node.type === "ArrayPattern") {
      for (const element of astChildren(node, "elements")) noteBindingTarget(element);
      return;
    }
    if (node.type === "ObjectPattern") {
      for (const property of astChildren(node, "properties")) {
        if (!isAstNode(property)) continue;
        noteBindingTarget(property.type === "RestElement" ? property : astChild(property, "value"));
      }
    }
  };
  walkAst(program, (node) => {
    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        noteBindingTarget(astChild(node, "id"));
        for (const param of astChildren(node, "params")) noteBindingTarget(param);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        noteBindingTarget(astChild(node, "id"));
        break;
      case "VariableDeclarator":
        noteBindingTarget(astChild(node, "id"));
        break;
      case "CatchClause":
        noteBindingTarget(astChild(node, "param"));
        break;
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
      case "ImportSpecifier":
        noteBindingTarget(astChild(node, "local"));
        break;
      default:
        break;
    }
  });
  return shadowed;
}

/** Whether `node` is a bare global identifier `name`, or `window.name` /
 * `globalThis.name` — an arbitrary object merely NAMED `name` as a property
 * (`fake.document`, `app.serviceWorker`) proves nothing about the real
 * browser global. Every step (the global object AND the final identifier)
 * must be unshadowed. */
function isGlobalReceiver(node: unknown, name: string, shadowedGlobals: ReadonlySet<string>): boolean {
  if (shadowedGlobals.has(name) || !isAstNode(node)) return false;
  if (node.type === "Identifier") return astString(node, "name") === name;
  if (node.type === "MemberExpression") {
    const object = astChild(node, "object");
    const property = astChild(node, "property");
    if (!isAstNode(property) || property.type !== "Identifier" || astString(property, "name") !== name) {
      return false;
    }
    if (!isAstNode(object) || object.type !== "Identifier") return false;
    const objectName = astString(object, "name");
    return !!objectName && GLOBAL_OBJECT_NAMES.has(objectName) && !shadowedGlobals.has(objectName);
  }
  return false;
}

function isDocumentReceiver(node: unknown, shadowedGlobals: ReadonlySet<string>): boolean {
  return isGlobalReceiver(node, "document", shadowedGlobals);
}

/** Whether `node` is `navigator.serviceWorker` — the ONLY receiver a real
 * service-worker registration ever has. `navigator` itself must be the
 * unshadowed browser global (bare, window., or globalThis.-prefixed); an
 * arbitrary object merely named "serviceWorker" (`app.serviceWorker`) is
 * not the browser API and performs no network request. */
function isServiceWorkerReceiver(node: unknown, shadowedGlobals: ReadonlySet<string>): boolean {
  if (!isAstNode(node) || node.type !== "MemberExpression") return false;
  const object = astChild(node, "object");
  const property = astChild(node, "property");
  return (
    isAstNode(property) &&
    property.type === "Identifier" &&
    astString(property, "name") === "serviceWorker" &&
    isGlobalReceiver(object, "navigator", shadowedGlobals)
  );
}

/** The literal tag a DOM-producing expression is known to produce
 * ("div", "img", ...), "unknown" when it's provably a DOM element but its
 * concrete tag can't be determined (querySelector, getElementById, or
 * createElement with a non-literal argument), or undefined when the
 * expression isn't provably DOM-producing at all. */
function domProducingTag(
  node: unknown,
  provenTags: ReadonlyMap<string, DomProducingTag>,
  shadowedGlobals: ReadonlySet<string>,
): DomProducingTag | undefined {
  if (!isAstNode(node)) return undefined;
  if (node.type === "CallExpression") {
    const callee = astChild(node, "callee");
    if (!isAstNode(callee) || callee.type !== "MemberExpression") return undefined;
    const object = astChild(callee, "object");
    const property = astChild(callee, "property");
    if (
      !isDocumentReceiver(object, shadowedGlobals) ||
      !isAstNode(property) ||
      property.type !== "Identifier"
    ) return undefined;
    const methodName = astString(property, "name");
    if (methodName === "createElement") {
      const tag = stringLiteralValue(astChildren(node, "arguments")[0]);
      return tag ? tag.toLowerCase() : "unknown";
    }
    if (methodName === "querySelector" || methodName === "getElementById") return "unknown";
    return undefined;
  }
  if (node.type === "MemberExpression") {
    const object = astChild(node, "object");
    const property = astChild(node, "property");
    if (
      !isDocumentReceiver(object, shadowedGlobals) ||
      !isAstNode(property) ||
      property.type !== "Identifier"
    ) return undefined;
    const name = astString(property, "name");
    return name === "body" || name === "head" ? name : undefined;
  }
  if (node.type === "Identifier") {
    return provenTags.get(astString(node, "name") ?? "");
  }
  return undefined;
}

/** Every identifier PROVABLY bound to a DOM-producing expression somewhere
 * in the file, and the tag it's known to produce — a small fixed-point pass
 * (not real lexical scoping) so a chain like
 * `const a = document.createElement("img"); const b = a;` still resolves,
 * without building a full scope resolver for a heuristic scanner.
 *
 * That flat, name-keyed map is unsound across scopes on its own: an
 * unrelated function's `const img = {}` and this one's
 * `const img = document.createElement("img")` share a map key with no
 * scope resolver to tell them apart. Per the unprovable-stays-out rule,
 * the conservative fix wins over a real scope resolver a heuristic scanner
 * has no business building: a name declared or assigned ANYWHERE in the
 * file with a non-DOM-producing value (or with two DIFFERENT DOM tags) is
 * invalidated file-wide, never trusted again even where its OWN binding
 * really is DOM-producing. */
/** Every identifier name a destructuring/parameter pattern binds, however
 * nested — `{ img }`, `[img]`, `img = {}`, `...img` all still bind `img`. */
function collectPatternNames(pattern: unknown, into: Set<string>): void {
  if (!isAstNode(pattern)) return;
  if (pattern.type === "Identifier") {
    const name = astString(pattern, "name");
    if (name) into.add(name);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternNames(astChild(pattern, "left"), into);
    return;
  }
  if (pattern.type === "RestElement") {
    collectPatternNames(astChild(pattern, "argument"), into);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const prop of astChildren(pattern, "properties")) {
      if (!isAstNode(prop)) continue;
      collectPatternNames(
        prop.type === "RestElement" ? astChild(prop, "argument") : astChild(prop, "value"),
        into,
      );
    }
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of astChildren(pattern, "elements")) collectPatternNames(element, into);
  }
}

/** Every name bound by ANY function's parameter list in the file — a
 * parameter's runtime value is never provable statically (the caller
 * decides it, default value or not), so it can never be trusted as
 * DOM-producing even where a SAME-named variable elsewhere in the file
 * really is. */
function collectFunctionParameterNames(program: AstNode): Set<string> {
  const names = new Set<string>();
  walkAst(program, (node) => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const param of astChildren(node, "params")) collectPatternNames(param, names);
    }
  });
  return names;
}

function collectDomProducingTags(
  program: AstNode,
  shadowedGlobals: ReadonlySet<string>,
): Map<string, DomProducingTag> {
  const tags = new Map<string, DomProducingTag>();
  const invalidated = new Set<string>(collectFunctionParameterNames(program));
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    walkAst(program, (node) => {
      let target: unknown;
      let source: unknown;
      if (node.type === "VariableDeclarator") {
        target = astChild(node, "id");
        source = astChild(node, "init");
      } else if (node.type === "AssignmentExpression" && node.operator === "=") {
        target = astChild(node, "left");
        source = astChild(node, "right");
      } else {
        return;
      }
      if (!isAstNode(target) || target.type !== "Identifier") return;
      const name = astString(target, "name");
      if (!name || invalidated.has(name)) return;
      const tag = domProducingTag(source, tags, shadowedGlobals);
      if (tag === undefined) {
        // No real initializer (a bare `let img;`) proves nothing either
        // way — only an ACTUAL non-DOM-producing value invalidates.
        if (source === null || source === undefined) return;
        if (tags.delete(name)) changed = true;
        invalidated.add(name);
        return;
      }
      const existing = tags.get(name);
      if (existing !== undefined && existing !== tag) {
        // Two DIFFERENT DOM tags for the same name is exactly the same
        // cross-scope collision, just between two DOM-producing bindings
        // instead of one DOM and one not — neither tag is trustworthy.
        tags.delete(name);
        invalidated.add(name);
        changed = true;
        return;
      }
      tags.set(name, tag);
      changed = true;
    });
    if (!changed) break;
  }
  return tags;
}

/** Whether `object.property = lit` or `object.setAttribute("property", lit)`
 * is a proven, resource-consuming (tag, property) pair — reuses
 * URL_ATTRIBUTE_ELEMENTS, the SAME allowlist markup attributes already go
 * through, so a DOM element's real tag is held to the identical rule. */
function isProvenUrlReceiver(
  object: unknown,
  propertyName: string,
  provenTags: ReadonlyMap<string, DomProducingTag>,
  shadowedGlobals: ReadonlySet<string>,
): boolean {
  const tag = domProducingTag(object, provenTags, shadowedGlobals);
  return tag !== undefined && tag !== "unknown" && (URL_ATTRIBUTE_ELEMENTS[propertyName]?.has(tag) ?? false);
}

// A worker script (reached via Worker/SharedWorker/serviceWorker.register)
// runs in its own global scope where importScripts exists; an ordinary
// document-linked script never has it. Finding 4: importScripts only counts
// in that context.
type JsScanContext = "document" | "worker";

// A browser parses an ordinary classic <script> and a <script type="module">
// with DIFFERENT grammars — module-only syntax (import/export declarations)
// is a SYNTAX ERROR in a classic script, so the browser never requests
// anything a classic script's own import statement names. Guessing via a
// dual-attempt parse (module first, falling back to script) would accept
// that syntax error as if it were valid module code.
type ScriptKind = "classic" | "module";

function parseJavaScript(code: string, scriptKind: ScriptKind): AstNode | null {
  try {
    return acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: scriptKind === "module" ? "module" : "script",
    }) as unknown as AstNode;
  } catch {
    // Not parseable with this exact grammar — scan nothing rather than
    // guess a different one. The old regex-based scanner would still match
    // patterns in garbage text; a real parser correctly finds no code to
    // have references at all, and a browser wouldn't execute it either.
    return null;
  }
}

// Finding 9: an inline <script type="importmap"> remaps bare module
// specifiers before the browser resolves them — an unmapped bare specifier
// is not a relative filesystem path at all (module resolution throws on
// one), so it must not fall through to naive local-path joining the way a
// literal relative/absolute specifier does.
interface ImportMapResolution {
  imports: ReadonlyMap<string, string>;
  // A relative/root-relative import-map KEY ("./lib.js") is itself a
  // URL-like specifier, not a bare one — the spec normalizes it against the
  // map's own (declaring document) base the same way it normalizes the
  // address it maps to, then matches an importer's specifier by its OWN
  // normalized form. Keyed by the same artifact-root-absolute ("/"-prefixed)
  // convention resolveImportMapAddresses already uses for values.
  urlLikeImports: ReadonlyMap<string, string>;
}

function isBareModuleSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith("/") &&
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !URI_SCHEME_PATTERN.test(specifier)
  );
}

/** Resolves a module specifier the way HTML's module-resolution algorithm
 * does: a path-like or absolute specifier passes through unchanged (import
 * maps don't rewrite those); a bare specifier resolves through the active
 * import map — an exact "imports" key first, then the longest matching
 * "prefix/" key — and an unmapped bare specifier resolves to nothing. */
// Exact match first, then the LONGEST "prefix/" key the specifier starts
// with — the same longest-prefix-match algorithm the spec applies to every
// import-map entry, bare or URL-like alike.
function resolveAgainstImportMapEntries(
  specifier: string,
  entries: ReadonlyMap<string, string>,
): string | undefined {
  const exact = entries.get(specifier);
  if (exact !== undefined) return exact;
  let bestPrefixKey: string | undefined;
  for (const key of entries.keys()) {
    if (!key.endsWith("/") || !specifier.startsWith(key)) continue;
    if (!bestPrefixKey || key.length > bestPrefixKey.length) bestPrefixKey = key;
  }
  if (bestPrefixKey === undefined) return undefined;
  return entries.get(bestPrefixKey)! + specifier.slice(bestPrefixKey.length);
}

function resolveModuleSpecifier(
  specifier: string,
  importMap: ImportMapResolution | undefined,
  fromPath: string,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
): string | undefined {
  if (!isBareModuleSpecifier(specifier)) {
    // A URL-like specifier still passes through the import map: the spec
    // normalizes it against the IMPORTING script's own base and matches
    // that normalized form against the map's (already-normalized) keys —
    // an exact key OR the longest "prefix/" key it starts with. Unmatched,
    // it resolves to itself — same as before this lookup existed.
    if (!importMap) return specifier;
    const normalized = resolveArtifactRelativePath(specifier, fromPath, artifactRoot, ownBase);
    const normalizedRelative = normalized ? pathRelativeToArtifact(artifactRoot, normalized) : null;
    if (normalizedRelative === null) return specifier;
    return resolveAgainstImportMapEntries(`/${normalizedRelative}`, importMap.urlLikeImports) ?? specifier;
  }
  if (!importMap) return undefined;
  return resolveAgainstImportMapEntries(specifier, importMap.imports);
}

function parseImportMap(text: string): ImportMapResolution | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const importsField = (parsed as Record<string, unknown>).imports;
  const imports = new Map<string, string>();
  if (importsField && typeof importsField === "object" && !Array.isArray(importsField)) {
    for (const [key, value] of Object.entries(importsField as Record<string, unknown>)) {
      if (typeof value === "string") imports.set(key, value);
    }
  }
  // Raw, pre-normalization form — resolveImportMapAddresses splits bare vs.
  // URL-like keys and populates urlLikeImports before this is used anywhere.
  return { imports, urlLikeImports: new Map() };
}

// Finding 8's stance: `new URL(lit, import.meta.url)` alone only
// CONSTRUCTS a URL object — the browser performs no request until the
// result reaches a consuming position (an inline argument to fetch/Worker/
// SharedWorker/serviceWorker.register, or a proven DOM property assignment/
// setAttribute value). `console.log(new URL(...))` or an otherwise-unused
// URL must mint nothing.
function newUrlLiteral(node: unknown, shadowedGlobals: ReadonlySet<string>): string | undefined {
  if (!isAstNode(node) || node.type !== "NewExpression") return undefined;
  const callee = astChild(node, "callee");
  if (!isAstNode(callee) || callee.type !== "Identifier" || astString(callee, "name") !== "URL") {
    return undefined;
  }
  if (shadowedGlobals.has("URL")) return undefined;
  const args = astChildren(node, "arguments");
  if (args.length < 2) return undefined;
  const first = stringLiteralValue(args[0]);
  if (!first || !isImportMetaUrl(args[1])) return undefined;
  return first;
}

/** Every identifier PROVABLY initialized from `new URL(lit,
 * import.meta.url)` — a one-hop pass (not real lexical scoping), the same
 * technique collectDomProducingTags uses: `const u = new URL(lit,
 * import.meta.url); fetch(u);` still counts once `u` reaches a consumer. */
function collectUrlLiteralNames(program: AstNode, shadowedGlobals: ReadonlySet<string>): Map<string, string> {
  const names = new Map<string, string>();
  walkAst(program, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const target = astChild(node, "id");
    if (!isAstNode(target) || target.type !== "Identifier") return;
    const name = astString(target, "name");
    if (!name || names.has(name)) return;
    const literal = newUrlLiteral(astChild(node, "init"), shadowedGlobals);
    if (literal !== undefined) names.set(name, literal);
  });
  return names;
}

/** The `new URL(lit, import.meta.url)` literal a CONSUMED expression
 * resolves to — either the expression IS that construct directly, or it's
 * an identifier one-hop traced back to one. undefined for neither. */
function consumedUrlLiteral(
  node: unknown,
  urlLiteralNames: ReadonlyMap<string, string>,
  shadowedGlobals: ReadonlySet<string>,
): string | undefined {
  const direct = newUrlLiteral(node, shadowedGlobals);
  if (direct !== undefined) return direct;
  if (isAstNode(node) && node.type === "Identifier") {
    return urlLiteralNames.get(astString(node, "name") ?? "");
  }
  return undefined;
}

/** `new Worker(url, { type: "module" })` loads its script as a MODULE, not
 * classic — the second argument's `type` option decides the grammar the
 * worker's own file needs to be parsed with, the same way a <script
 * type="module"> element's own attribute does. A missing/non-"module" type
 * (or a non-literal options object) stays classic, the existing default. */
function workerScriptKind(optionsNode: unknown): ScriptKind | undefined {
  if (!isAstNode(optionsNode) || optionsNode.type !== "ObjectExpression") return undefined;
  for (const prop of astChildren(optionsNode, "properties")) {
    if (!isAstNode(prop) || prop.type !== "Property") continue;
    const key = astChild(prop, "key");
    // `{ type: "module" }` and the equally valid `{ "type": "module" }`
    // both name the same option — Acorn represents the quoted form as a
    // string Literal key, not an Identifier.
    const keyName =
      isAstNode(key) && key.type === "Identifier" ? astString(key, "name") : stringLiteralValue(key);
    if (keyName !== "type") continue;
    return stringLiteralValue(astChild(prop, "value")) === "module" ? "module" : undefined;
  }
  return undefined;
}

function jsReferencesFromCode(
  code: string,
  scriptKind: ScriptKind,
  context: JsScanContext,
  fromPath: string,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
  importMap?: ImportMapResolution,
): BrowserTextReference[] {
  const program = parseJavaScript(code, scriptKind);
  if (!program) return [];
  const shadowedGlobals = collectShadowedGlobalNames(program);
  const provenDomTags = collectDomProducingTags(program, shadowedGlobals);
  const urlLiteralNames = collectUrlLiteralNames(program, shadowedGlobals);
  const references: BrowserTextReference[] = [];
  const addReference = (
    value: string | undefined,
    documentRelative: boolean,
    entersOwnContext = false,
    referenceScriptKind?: ScriptKind,
  ) => {
    const trimmed = value?.trim();
    if (trimmed) references.push({ value: trimmed, documentRelative, entersOwnContext, scriptKind: referenceScriptKind });
  };
  // import/export/dynamic-import specifiers are MODULE specifiers, subject
  // to import-map resolution — an unmapped bare specifier ("lib") is not a
  // local path at all and must not fall through to naive relative joining.
  // They can only ever appear in module grammar, so the target is a module.
  const addModuleSpecifier = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) {
      addReference(
        resolveModuleSpecifier(trimmed, importMap, fromPath, ownBase, artifactRoot),
        false,
        false,
        "module",
      );
    }
  };
  // A literal string argument, OR a consumed new URL(lit, import.meta.url)
  // result — the latter resolves against the SCRIPT's own location
  // (import.meta.url), not the document, regardless of where it's consumed.
  const consumedValue = (node: unknown): { value: string | undefined; scriptRelative: boolean } => {
    const urlLiteral = consumedUrlLiteral(node, urlLiteralNames, shadowedGlobals);
    return urlLiteral !== undefined
      ? { value: urlLiteral, scriptRelative: true }
      : { value: stringLiteralValue(node), scriptRelative: false };
  };
  const addUrlAttributeReference = (object: unknown, propertyName: string, valueNode: unknown) => {
    if (!isProvenUrlReceiver(object, propertyName, provenDomTags, shadowedGlobals)) return;
    const { value, scriptRelative } = consumedValue(valueNode);
    if (propertyName === "srcset") {
      const trimmed = value?.trim();
      if (trimmed) for (const srcsetValue of referencesFromSrcset(trimmed)) addReference(srcsetValue, !scriptRelative);
      return;
    }
    addReference(value, !scriptRelative);
  };

  walkAst(program, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        addModuleSpecifier(stringLiteralValue(astChild(node, "source")));
        break;
      }
      case "ImportExpression": {
        addModuleSpecifier(stringLiteralValue(astChild(node, "source")));
        break;
      }
      case "NewExpression": {
        const callee = astChild(node, "callee");
        const args = astChildren(node, "arguments");
        if (!isAstNode(callee) || callee.type !== "Identifier") break;
        const calleeName = astString(callee, "name");
        if (!calleeName || shadowedGlobals.has(calleeName)) break;
        if (calleeName === "Worker" || calleeName === "SharedWorker") {
          const { value, scriptRelative } = consumedValue(args[0]);
          addReference(value, !scriptRelative, true, workerScriptKind(args[1]));
        }
        // `new URL(...)` alone only constructs a URL object — no request
        // happens until the result reaches a consumer (checked at each
        // consumer above/below via consumedValue), so it mints nothing here.
        break;
      }
      case "CallExpression": {
        const callee = astChild(node, "callee");
        const args = astChildren(node, "arguments");
        if (!isAstNode(callee)) break;
        if (callee.type === "Identifier") {
          const calleeName = astString(callee, "name");
          if (!calleeName || shadowedGlobals.has(calleeName)) break;
          if (calleeName === "fetch") {
            const { value, scriptRelative } = consumedValue(args[0]);
            addReference(value, !scriptRelative);
          } else if (calleeName === "importScripts" && context === "worker") {
            for (const argument of args) addReference(stringLiteralValue(argument), false, false, "classic");
          }
        } else if (callee.type === "MemberExpression") {
          const property = astChild(callee, "property");
          const object = astChild(callee, "object");
          const propertyName =
            isAstNode(property) && property.type === "Identifier" ? astString(property, "name") : undefined;
          if (propertyName === "register" && isServiceWorkerReceiver(object, shadowedGlobals)) {
            // A registered service worker runs in its own global scope with
            // its own script URL, same as Worker/SharedWorker.
            const { value, scriptRelative } = consumedValue(args[0]);
            addReference(value, !scriptRelative, true);
          } else if (
            propertyName === "fetch" &&
            (isGlobalReceiver(object, "window", shadowedGlobals) ||
              isGlobalReceiver(object, "globalThis", shadowedGlobals))
          ) {
            // `window.fetch`/`globalThis.fetch` request exactly like a bare
            // `fetch(...)` call — the same unshadowed-global rule already
            // governs `document`/`navigator` receivers.
            const { value, scriptRelative } = consumedValue(args[0]);
            addReference(value, !scriptRelative);
          } else if (propertyName === "setAttribute" && args.length >= 2) {
            const attributeName = stringLiteralValue(args[0]);
            if (attributeName) addUrlAttributeReference(object, attributeName, args[1]);
          }
        }
        break;
      }
      case "AssignmentExpression": {
        if (node.operator !== "=") break;
        const left = astChild(node, "left");
        if (!isAstNode(left) || left.type !== "MemberExpression") break;
        const property = astChild(left, "property");
        const object = astChild(left, "object");
        const propertyName =
          isAstNode(property) && property.type === "Identifier" ? astString(property, "name") : undefined;
        if (propertyName) {
          addUrlAttributeReference(object, propertyName, astChild(node, "right"));
        }
        break;
      }
      default:
        break;
    }
  });
  return references;
}

// ---- HTML: parse once with parse5 and walk the real tree.

interface HtmlDocumentReferences {
  references: BrowserTextReference[];
  // The document's own active import map, if it declared one — undefined
  // for a plain document (never inherited: each HTML document is a fresh
  // realm, and only the module scripts IT loads share this map).
  importMap: ImportMapResolution | undefined;
}

/** Wraps one inline on* handler's value as a function body before parsing —
 * a browser compiles a handler as a FUNCTION BODY (where a bare `return` is
 * valid), not a module or program (always classic grammar — a handler
 * attribute can never declare module-only syntax), and joining every
 * handler with every script body into one string means one handler using
 * `return` would make the WHOLE combined parse fail. Parsing each handler
 * on its own also isolates a malformed handler's failure from every other
 * reference. */
function jsReferencesFromEventHandler(
  code: string,
  context: JsScanContext,
  fromPath: string,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
  importMap: ImportMapResolution | undefined,
): BrowserTextReference[] {
  return jsReferencesFromCode(
    `function __dohc_handler__(event) {\n${code}\n}`,
    "classic",
    context,
    fromPath,
    ownBase,
    artifactRoot,
    importMap,
  );
}

/** Resolves each import-map address against the DECLARING document's own
 * base, into an artifact-root-absolute ("/"-prefixed) path — so a later
 * bare-specifier match returns an address ANY importer resolves the same
 * way, regardless of the importing script's own location. Matches the HTML
 * import-map processing model: addresses are normalized against the import
 * map's own base URL when the map is parsed, not the importer's. */
function resolveImportMapAddresses(
  importMap: ImportMapResolution,
  documentPath: string,
  documentBase: HtmlBaseResolution,
  artifactRoot: string,
): ImportMapResolution {
  const resolved = new Map<string, string>();
  const resolvedUrlLike = new Map<string, string>();
  for (const [key, rawAddress] of importMap.imports) {
    const candidate = resolveArtifactRelativePath(rawAddress, documentPath, artifactRoot, documentBase);
    // candidate is already artifact-relative (it includes artifactRoot's own
    // prefix, e.g. "dist/assets/main.js"). The "/"-prefix convention below
    // means "resolve against the artifact root", which re-adds that same
    // prefix on the next pass — strip it first or a nested artifactRoot
    // gets joined onto itself.
    const artifactRelative = candidate ? pathRelativeToArtifact(artifactRoot, candidate) : null;
    if (artifactRelative === null) continue;
    const resolvedValue = `/${artifactRelative}`;
    if (isBareModuleSpecifier(key)) {
      resolved.set(key, resolvedValue);
      continue;
    }
    // A relative/root-relative key normalizes the same way its address
    // does, against THIS document's own base — an importer's specifier is
    // matched against this normalized form, not the raw key text.
    const normalizedKey = resolveArtifactRelativePath(key, documentPath, artifactRoot, documentBase);
    const normalizedKeyRelative = normalizedKey ? pathRelativeToArtifact(artifactRoot, normalizedKey) : null;
    if (normalizedKeyRelative !== null) resolvedUrlLike.set(`/${normalizedKeyRelative}`, resolvedValue);
  }
  return { imports: resolved, urlLikeImports: resolvedUrlLike };
}

function htmlReferencesFromDocument(
  document: Html5Node,
  context: JsScanContext,
  documentBase: HtmlBaseResolution,
  documentPath: string,
  artifactRoot: string,
): HtmlDocumentReferences {
  const attributeReferences: BrowserTextReference[] = [];
  const cssTexts: string[] = [];
  const classicJsTexts: string[] = [];
  const moduleJsTexts: string[] = [];
  const handlerTexts: string[] = [];
  const importMapTexts: string[] = [];
  const nestedReferences: BrowserTextReference[] = [];

  const visit = (node: Html5Node): void => {
    if (isHtml5Element(node)) {
      const tagName = node.tagName;
      const attrs = new Map(node.attrs.map((attribute) => [attribute.name, attribute.value]));
      // A <script>/<style>'s own URL attributes (src, ...) still count — this
      // runs for every element, script and style included — but their raw
      // text content is code or CSS, never markup, so it's collected
      // separately below and neither recurses into its (raw-text) children.
      const styleAttribute = attrs.get("style");
      if (styleAttribute) cssTexts.push(styleAttribute);
      for (const attribute of node.attrs) {
        // Inline on* handlers hold real JS the browser executes, same as a
        // <script> body — parse5 already decoded any entity in the value —
        // but they compile with function-body grammar, so they're parsed
        // separately (jsReferencesFromEventHandler), not joined into jsTexts.
        if (/^on[a-z]+$/i.test(attribute.name)) handlerTexts.push(attribute.value);
      }
      // A browser parses `srcdoc` as a nested HTML document; nothing else
      // in this file walks into its markup, so it never contributes
      // references on its own.
      const srcdoc = tagName === "iframe" ? attrs.get("srcdoc") : undefined;
      if (srcdoc !== undefined) {
        const nestedDocument = parseHtml(srcdoc);
        // The nested document's OWN <base> (if it declares one) resolves
        // relative to the EMBEDDING document's base — its "fallback base" —
        // and if it declares none, it falls back to that same base
        // directly (not the outer document's raw file path).
        const nestedBase = htmlBaseDirectoryFromDocument(nestedDocument, documentPath, artifactRoot, documentBase);
        const effectiveBase = nestedBase.kind === "none" ? documentBase : nestedBase;
        const nestedResult = htmlReferencesFromDocument(
          nestedDocument,
          context,
          effectiveBase,
          documentPath,
          artifactRoot,
        );
        for (const reference of nestedResult.references) {
          // A srcdoc pseudo-document isn't a real file with its own
          // separate script-vs-document base distinction — every one of
          // its references (markup, CSS, or script) resolves against ITS
          // OWN base. Resolve NOW, against effectiveBase, and carry the
          // result as an already-artifact-root-relative value the outer
          // scan's own base can't second-guess.
          const resolvedPath = resolveArtifactRelativePath(reference.value, documentPath, artifactRoot, effectiveBase);
          // Same "/"-prefix convention as resolveImportMapAddresses: strip
          // artifactRoot's own prefix back off before re-adding the leading
          // "/", or the next resolution pass joins artifactRoot onto itself.
          const artifactRelative = resolvedPath ? pathRelativeToArtifact(artifactRoot, resolvedPath) : null;
          if (artifactRelative !== null) {
            nestedReferences.push({ ...reference, value: `/${artifactRelative}`, documentRelative: false });
          }
        }
      }
      if (tagName === "meta" && attrs.get("http-equiv")?.toLowerCase() === "refresh") {
        const refreshTarget = metaRefreshTarget(attrs.get("content") ?? "");
        if (refreshTarget) attributeReferences.push({ value: refreshTarget, documentRelative: true });
      }
      const scriptKind: ScriptKind = attrs.get("type")?.toLowerCase() === "module" ? "module" : "classic";
      for (const attribute of node.attrs) {
        const attributeName = attribute.name;
        if (!URL_ATTRIBUTE_ELEMENTS[attributeName]?.has(tagName)) continue;
        if (attributeName === "src" && tagName === "input" && !isImageInputElement(attrs)) continue;
        // With `srcdoc` present, the browser never fetches an iframe's own
        // `src` at all — srcdoc wins outright, it isn't a fallback.
        if (attributeName === "src" && tagName === "iframe" && srcdoc !== undefined) continue;
        // A data-block script (a non-JS type, e.g. type="application/json")
        // is never fetched — src only fires a request for a classic or
        // module script.
        if (attributeName === "src" && tagName === "script" && !isExecutableScriptType(attrs)) continue;
        if (
          attributeName === "href" &&
          tagName === "link" &&
          !isResourceConsumingLinkRel(attrs.get("rel"), attrs.get("as"))
        ) continue;
        // A manifest linked as plain "manifest.json" is still a web app
        // manifest to the browser — the extension gate in the scan queue
        // must yield to this, not require a ".webmanifest" spelling.
        const isManifest =
          attributeName === "href" && tagName === "link" && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("manifest");
        // A modulepreload target is always fetched AND parsed as a module —
        // it has no <script> element of its own to carry that kind, so the
        // reference has to name it directly.
        const isModulePreload =
          attributeName === "href" && tagName === "link" && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("modulepreload");
        if (attributeName !== "srcset") {
          attributeReferences.push({
            value: attribute.value,
            documentRelative: true,
            isManifest,
            ...(attributeName === "src" && tagName === "script" ? { scriptKind } : {}),
            ...(isModulePreload ? { scriptKind: "module" as const } : {}),
          });
          continue;
        }
        for (const srcsetValue of referencesFromSrcset(attribute.value)) {
          attributeReferences.push({ value: srcsetValue, documentRelative: true });
        }
      }
      if (tagName === "script") {
        if (attrs.get("type")?.toLowerCase() === "importmap") {
          importMapTexts.push(html5TextContent(node));
        } else if (isExecutableScriptElement(attrs)) {
          (scriptKind === "module" ? moduleJsTexts : classicJsTexts).push(html5TextContent(node));
        }
        return;
      }
      if (tagName === "style") {
        cssTexts.push(html5TextContent(node));
        return;
      }
    }
    for (const child of html5ChildNodes(node)) visit(child);
  };
  visit(document);

  // Only the FIRST import map counts per the HTML standard; a document
  // never inherits one from anywhere else. Its addresses resolve against
  // THIS document's own base right away, before any importer uses them.
  const rawImportMap = importMapTexts[0] !== undefined ? parseImportMap(importMapTexts[0]) : undefined;
  const importMap = rawImportMap
    ? resolveImportMapAddresses(rawImportMap, documentPath, documentBase, artifactRoot)
    : undefined;

  const references = [
    ...attributeReferences,
    ...nestedReferences,
    ...cssReferences(cssTexts.join("\n")),
    // Each <script> element parses on its OWN — the same way a browser runs
    // each script tag independently — so a syntax error in one script never
    // discards a later, syntactically valid script's own references.
    ...classicJsTexts.flatMap((text) =>
      jsReferencesFromCode(text, "classic", context, documentPath, documentBase, artifactRoot, importMap),
    ),
    ...moduleJsTexts.flatMap((text) =>
      jsReferencesFromCode(text, "module", context, documentPath, documentBase, artifactRoot, importMap),
    ),
    ...handlerTexts.flatMap((handler) =>
      jsReferencesFromEventHandler(handler, context, documentPath, documentBase, artifactRoot, importMap),
    ),
  ];
  return { references, importMap };
}

/** Every reference in a non-HTML file — HTML is scanned from its already-
 * parsed tree instead (htmlReferencesFromDocument), so shareManifestForSite
 * only parses each HTML document once. */
function referencesFromNonHtmlFile(
  text: string,
  sourcePath: string,
  scriptKind: ScriptKind,
  context: JsScanContext,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
  executesAsCode: boolean,
  isManifest: boolean,
  importMap: ImportMapResolution | undefined,
): BrowserTextReference[] {
  // A file reached through a <link rel="manifest"> is a web app manifest to
  // the browser regardless of its own extension — a plain "manifest.json"
  // is as real a manifest as a ".webmanifest" file.
  if (isManifest || /\.webmanifest$/i.test(sourcePath)) {
    // A web app manifest's URLs (icons, start_url, ...) resolve relative to
    // the MANIFEST file itself, not the document that links it — the same
    // rule CSS's url()/@import already follow. Not document-relative.
    return referencesFromWebManifest(text).map((value) => ({ value, documentRelative: false }));
  }
  if (/\.css$/i.test(sourcePath)) return cssReferences(text);
  if (/\.(?:js|mjs)$/i.test(sourcePath)) {
    // Bytes the browser only ever FETCHES (fetch(), an asset-style URL
    // attribute) are never executed, so their text is never parsed as code
    // — the file still shares as an asset (the caller already added it to
    // `approved`), it just contributes no further references of its own.
    if (!executesAsCode) return [];
    return jsReferencesFromCode(text, scriptKind, context, sourcePath, ownBase, artifactRoot, importMap);
  }
  return [];
}

async function shareManifestForSite(
  rootPath: string,
  site: Omit<SitePackageInfo, "shareManifest">,
): Promise<SiteShareManifestResult> {
  // Share-what-you-previewed: an explicitly configured static preview must
  // select the SAME artifact the static preview serves — the site's own
  // configured entry — not a build output left over from an earlier build.
  // Only when preview isn't pinned to "static" does a present build output
  // take priority (Build-mode preview/share). The shared-view rule in
  // staticPreviewTargetForSite (a recipient always gets a present build
  // output) is a separate concern for the RECEIVING side and is unaffected.
  const preferConfiguredStaticEntry = site.configuredPreviewMode === "static";
  const output = preferConfiguredStaticEntry ? null : presentBuildOutput(site);
  let artifactRoot: string | null = null;
  let entryPath: string | null = null;

  if (output) {
    artifactRoot = joinSitePath(site.root, output);
    entryPath = `${artifactRoot}/index.html`;
  } else if ((preferConfiguredStaticEntry || !needsBuiltArtifact(site)) && site.entryPath) {
    artifactRoot = ownedStaticEntryTarget(site).root;
    const entryRelative = pathRelativeToArtifact(artifactRoot, site.entryPath);
    if (!entryRelative || !/\.html?$/i.test(entryRelative)) {
      return { ok: false, reason: "no-runnable-artifact" };
    }
    entryPath = site.entryPath;
  }

  if (!artifactRoot || !entryPath) {
    return { ok: false, reason: "no-runnable-artifact" };
  }
  const available = new Set(
    site.sourceFiles.filter(
      (path) =>
        path !== site.packagePath &&
        path !== site.configPath &&
        !hasIgnoredSegment(path) &&
        pathRelativeToArtifact(artifactRoot, path) !== null &&
        // A workspace-owned site's own files can never legitimately reference
        // into someone else's mounted share — the relay refuses a selector
        // that reaches outside the sharer's own authority, which would fail
        // the WHOLE share rather than just dropping that one reference. The
        // same rule the preview server boundary enforces (siteRunner).
        isPathAllowedForAuthority(site.authority, path),
    ),
  );
  if (!available.has(entryPath)) {
    return { ok: false, reason: "no-runnable-artifact" };
  }

  const approved = new Set([entryPath]);
  // Keyed by (path, documentBase): a file's OWN outgoing references only
  // depend on its own content, but a document-relative reference inside it
  // resolves against whichever document's base reached it here — two
  // documents sharing one external script each need their own base's
  // resolution, so scanning by path alone would silently drop the second.
  const scanned = new Set<string>();
  const documentBaseKey = (base: HtmlBaseResolution): string =>
    base.kind === "local" ? `local:${base.directory}` : base.kind;
  // Two documents can each declare their OWN import map and both reference
  // the same external module — the map is part of what that module's own
  // `import` specifiers resolve against, so a fingerprint of its entries
  // has to be part of the dedupe key too, or the second document's map
  // never gets its own scan of a module the first document's map already
  // claimed.
  const importMapKey = (importMap: ImportMapResolution | undefined): string => {
    if (!importMap) return "none";
    // ONE structural serialization of BOTH maps together, not delimiter-
    // joined text — `=`, `,`, and `|` are all legal in a resolved path or
    // import-map key, so two DIFFERENT maps (e.g. one entry "a=/b,c=/d" vs.
    // two entries "a"->"/b" and "c"->"/d") could otherwise fingerprint
    // identically and collide in the scan key, silently dropping the
    // second document's own scan. A single JSON.stringify call over both
    // sorted entry lists has no delimiter of its own to collide on.
    const sortedEntries = (map: ReadonlyMap<string, string>) =>
      [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([sortedEntries(importMap.imports), sortedEntries(importMap.urlLikeImports)]);
  };
  // Every file is scanned with its own referring document's base — an
  // external .js/.mjs file has no <base> of its own, but a reference the
  // browser resolves against the DOCUMENT's base (fetch, an assignment-
  // shaped src/href) must still use the document that linked it, including
  // that document's own <base href> (not a blanket artifact root). context
  // carries whether the file being scanned runs as an ordinary document
  // script or as a worker's own global scope (importScripts only exists,
  // and only counts, in the latter). scriptKind carries the classic/module
  // grammar to parse a JS target with, from the reference that named it — a
  // classic <script src> and a module <script type="module" src> reaching
  // the SAME external file each parse it with THEIR OWN grammar (the dedupe
  // key below carries this too, so both scans happen). isManifest carries
  // that a target was reached through <link rel="manifest">, so the
  // extension gate below (and the file's own content dispatch) treats it as
  // a web app manifest regardless of its own file extension. importMap
  // carries the referring document's active import map (undefined for none)
  // to whatever non-HTML module script it references — an HTML document
  // never inherits one; it only ever declares its own.
  const queue: Array<{
    path: string;
    documentBase: HtmlBaseResolution;
    context: JsScanContext;
    scriptKind: ScriptKind;
    // Whether the browser EXECUTES this target as code (a <script src>, a
    // module specifier, a Worker/service-worker script, importScripts) as
    // opposed to only fetching its bytes (fetch(), or an asset-style URL
    // attribute that happens to point at a ".js" path). A fetched-only
    // target still shares as an asset — its content is just never parsed
    // for further references, the same way a browser never runs it. Part of
    // the dedupe key below for the same reason scriptKind is: the same file
    // reached both ways (once via fetch, once via <script src>) needs both
    // scans, not one "using up" the path for the other.
    executesAsCode: boolean;
    isManifest: boolean;
    importMap: ImportMapResolution | undefined;
  }> = [
    {
      path: entryPath,
      documentBase: { kind: "none" },
      context: "document",
      scriptKind: "classic",
      executesAsCode: true,
      isManifest: false,
      importMap: undefined,
    },
  ];
  let scannedBytes = 0;
  while (queue.length > 0) {
    const {
      path: current,
      documentBase: inheritedDocumentBase,
      context,
      scriptKind,
      executesAsCode,
      isManifest,
      importMap: inheritedImportMap,
    } = queue.shift()!;
    const scanKey = `${current}::${documentBaseKey(inheritedDocumentBase)}::${context}::${scriptKind}::${executesAsCode}::${isManifest}::${importMapKey(inheritedImportMap)}`;
    if (
      scanned.has(scanKey) ||
      (!isManifest && !/\.(?:html?|css|js|mjs|webmanifest)$/i.test(current))
    ) continue;
    scanned.add(scanKey);
    try {
      const info = await stat(join(rootPath, current));
      scannedBytes += info.size;
      if (!info.isFile()) {
        return { ok: false, reason: "non-file-reference", path: current };
      }
      if (scannedBytes > MAX_SHARE_MANIFEST_SCAN_BYTES) {
        return {
          ok: false,
          reason: "byte-budget",
          limitBytes: MAX_SHARE_MANIFEST_SCAN_BYTES,
          observedBytes: scannedBytes,
        };
      }
      const text = await readFile(join(rootPath, current), "utf8");
      const isHtmlFile = /\.html?$/i.test(current);
      // Parse each HTML file exactly once — both its <base> and its
      // reference scan read the same tree.
      const htmlDocument = isHtmlFile ? parseHtml(text) : null;
      const base = htmlDocument
        ? htmlBaseDirectoryFromDocument(htmlDocument, current, artifactRoot)
        : { kind: "none" as const };
      // A non-HTML file has no <base> of its own to declare, so it keeps the
      // document base of whichever HTML page referred to it. "none" means
      // "resolve against the referring file's own directory", which is only
      // correct while that referring file IS the document being scanned —
      // normalize it to this document's own directory before it can outlive
      // that scan and get applied to a different (script) file's fromPath.
      const documentBase: HtmlBaseResolution = htmlDocument
        ? base.kind === "none"
          ? { kind: "local", directory: posix.dirname(current) }
          : base
        : inheritedDocumentBase;
      const htmlResult = htmlDocument
        ? htmlReferencesFromDocument(htmlDocument, context, documentBase, current, artifactRoot)
        : null;
      const references = htmlResult
        ? htmlResult.references
        : referencesFromNonHtmlFile(
            text,
            current,
            scriptKind,
            context,
            base,
            artifactRoot,
            executesAsCode,
            isManifest,
            inheritedImportMap,
          );
      const documentImportMap = htmlResult ? htmlResult.importMap : inheritedImportMap;
      for (const reference of references) {
        const referenceBase = reference.documentRelative ? documentBase : base;
        for (const target of localReferenceCandidates(
          reference.value,
          current,
          artifactRoot,
          available,
          referenceBase,
        )) {
          approved.add(target);
          // A Worker/service-worker target runs in its own global scope with
          // its own location, so what IT references resolves against ITS OWN
          // directory, not the document that launched it — and it, and
          // everything it further references, scans in worker context.
          const propagatedDocumentBase: HtmlBaseResolution = reference.entersOwnContext
            ? { kind: "local", directory: posix.dirname(target) }
            : documentBase;
          const propagatedContext: JsScanContext = reference.entersOwnContext ? "worker" : context;
          queue.push({
            path: target,
            documentBase: propagatedDocumentBase,
            context: propagatedContext,
            scriptKind: reference.scriptKind ?? "classic",
            executesAsCode: reference.scriptKind !== undefined || reference.entersOwnContext === true,
            isManifest: reference.isManifest ?? false,
            importMap: documentImportMap,
          });
        }
      }
    } catch {
      return { ok: false, reason: "unreadable", path: current };
    }
  }

  const files = [...approved].sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    return { ok: false, reason: "no-runnable-artifact" };
  }
  if (files.length > MAX_SHARE_MANIFEST_FILES) {
    return {
      ok: false,
      reason: "file-count",
      limitFiles: MAX_SHARE_MANIFEST_FILES,
      observedFiles: files.length,
    };
  }
  // The relay's own selector refuses any path over this bound at share-create
  // time (packages/security-contract's shareSelector, the same rule
  // isShareablePath enforces reading it back) — catching it here turns what
  // would otherwise be a failed share OPERATION into an ordinary per-site
  // refusal, the same shape every other manifest limit already returns.
  const overLongPath = files.find((path) => path.length > MAX_SHARE_PATH_CHARS);
  if (overLongPath) {
    return {
      ok: false,
      reason: "path-too-long",
      limitChars: MAX_SHARE_PATH_CHARS,
      observedChars: overLongPath.length,
      path: overLongPath,
    };
  }
  return {
    ok: true,
    manifest: {
      entryPath,
      assets: files.filter((path) => path !== entryPath),
    },
  };
}

/**
 * Shared package sites run only the browser artifact selected by their owner.
 * A source index.html from Vite/React/etc. is not a runnable static artifact.
 */
export function sharedStaticEntryRelativeToSite(site: SitePackageInfo): string | null {
  const output = presentBuildOutput(site);
  if (output) return `${output}/index.html`;
  if (needsBuiltArtifact(site)) return null;
  return entryRelativeToSite(site);
}

/**
 * Resolves the HTTP document root separately from its entry. Build tools emit
 * root-absolute asset URLs, so serving dist/index.html from the source root
 * would incorrectly resolve /assets/* beside dist rather than inside it.
 */
export function staticPreviewTargetForSite(
  site: SitePackageInfo,
  options: { sharedView?: boolean } = {},
): {
  root: string;
  entry: string | null;
} {
  if (options.sharedView || site.authority.kind === "share") {
    const output = presentBuildOutput(site);
    if (output) return { root: buildOutputSiteRoot(site, output), entry: "index.html" };
    return { root: site.root, entry: sharedStaticEntryRelativeToSite(site) };
  }
  return ownedStaticEntryTarget(site);
}

function packagePathFor(root: string, sourceFiles: string[]): string | null {
  const packagePath = joinSitePath(root, "package.json");
  return sourceFiles.includes(packagePath) ? packagePath : null;
}

function entryPathFor(root: string, entry?: string): string | null {
  if (!entry) return null;
  const normalized = normalizeRoot(root);
  if (normalized !== "." && (entry === normalized || entry.startsWith(`${normalized}/`))) {
    return entry;
  }
  return joinSitePath(root, entry);
}

function configuredServerCommand(command: string, configPath: string): string | null {
  try {
    const parsed = splitCommandLine(command);
    assertLoopbackOnlyDevServerCommand(parsed.command, parsed.args);
    return command;
  } catch (error) {
    console.warn("[desktop] ignoring configured site command", {
      configPath,
      error,
    });
    return null;
  }
}

async function mapWorkspaceSite(
  rootPath: string,
  site: WorkspaceSite,
  files: WorkspaceFileEntry[],
  configuredScripts: SiteScripts,
): Promise<SitePackageInfo> {
  const root = normalizeRoot(site.root);
  const sourceFiles = files
    .map((file) => file.path)
    .filter((path) => isUnder(root, path))
    .sort();
  const entryPath = entryPathFor(root, site.entry);
  const shareMountRoot = shareMountRootForSite(root);
  const packagePath = packagePathFor(root, sourceFiles);
  const { scripts, diagnostics: scriptDiagnostics } = await packageScriptsForSite(rootPath, packagePath);
  const packageInfo: Omit<SitePackageInfo, "shareManifest"> = {
    root,
    title: site.title,
    kind: site.kind,
    confidence: site.confidence,
    entryPath,
    configPath: site.configPath ?? null,
    packagePath,
    packageManager: site.packageManager ?? null,
    scripts,
    configuredScripts,
    configuredPreviewMode: site.configuredPreviewMode ?? null,
    configuredBuildOutput: site.configuredBuildOutput ?? null,
    buildOutputs: site.buildOutputs,
    sourceFiles,
    diagnostics: [...site.diagnostics, ...scriptDiagnostics],
    authority: shareMountRoot
      ? { kind: "share", mountRoot: shareMountRoot }
      : { kind: "workspace" },
  };
  return {
    ...packageInfo,
    shareManifest: await shareManifestForSite(rootPath, packageInfo),
  };
}

/**
 * A metadata file's content, bounded the same way sourceForFile bounds it at
 * detection time — this is a SEPARATE read of the same file (scripts are
 * derived independently from site detection), so it needs its own guard.
 * `sourceForFile` already recorded the site's metadata-too-large diagnostic;
 * this one just silently declines to read rather than duplicating it.
 */
async function readBoundedMetadataFile(absolutePath: string): Promise<string | null> {
  const info = await stat(absolutePath);
  if (info.size > MAX_METADATA_FILE_BYTES) return null;
  return readFile(absolutePath, "utf8");
}

// Matches the bridge contract's SitePackageScripts bound
// (z.record(z.string().min(1).max(200), z.string().max(10_000))) — a script
// name or body over these limits must never reach listSitePackages' output,
// or the whole response fails Zod parsing over one script in one site. Drop
// (not truncate) the offending script: a truncated shell command is a
// different, possibly dangerous, command, not a shorter version of the same
// one — mirroring the title-too-long fix without inheriting its truncation.
const MAX_SCRIPT_NAME_CHARS = 200;
const MAX_SCRIPT_BODY_CHARS = 10_000;

async function packageScriptsForSite(
  rootPath: string,
  packagePath: string | null,
): Promise<{ scripts: Record<string, string>; diagnostics: SiteDiagnostic[] }> {
  if (!packagePath) return { scripts: {}, diagnostics: [] };
  try {
    const body = await readBoundedMetadataFile(join(rootPath, packagePath));
    if (body === null) return { scripts: {}, diagnostics: [] };
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { scripts: {}, diagnostics: [] };
    }
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return { scripts: {}, diagnostics: [] };
    }
    const result: Record<string, string> = {};
    const diagnostics: SiteDiagnostic[] = [];
    for (const [name, scriptBody] of Object.entries(scripts)) {
      if (typeof scriptBody !== "string") continue;
      if (name.length === 0) {
        // The bridge contract's SitePackageScripts schema requires every
        // key to have at least one character — an empty name here would
        // make the WHOLE ListSitesResult fail Zod parsing and hide every
        // other site in the response, the same class of producer-consumer
        // mismatch the oversized-script bound below already guards.
        diagnostics.push({
          path: packagePath,
          severity: "warning",
          code: "script-name-empty",
          message: "package.json has a script with an empty name, which the bridge contract requires at least one character for, and was dropped.",
        });
        continue;
      }
      if (name.length > MAX_SCRIPT_NAME_CHARS || scriptBody.length > MAX_SCRIPT_BODY_CHARS) {
        diagnostics.push({
          path: packagePath,
          severity: "warning",
          code: "script-too-large",
          message: `package.json script "${name.slice(0, MAX_SCRIPT_NAME_CHARS)}" exceeds the ${MAX_SCRIPT_NAME_CHARS}-character name or ${MAX_SCRIPT_BODY_CHARS}-character body limit and was dropped.`,
        });
        continue;
      }
      result[name] = scriptBody;
    }
    return { scripts: result, diagnostics };
  } catch {
    return { scripts: {}, diagnostics: [] };
  }
}

async function configuredScriptsForSite(rootPath: string, site: WorkspaceSite): Promise<SiteScripts> {
  if (!site.configPath || !site.configPath.endsWith("dohc.json")) return {};
  if (
    hasTraversalSegment(site.configPath) ||
    site.configPath.startsWith("/") ||
    site.configPath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(site.configPath)
  ) {
    return {};
  }
  try {
    const body = await readBoundedMetadataFile(join(rootPath, site.configPath));
    if (body === null) return {};
    const parsed = parseDohcSiteConfig(body, site.configPath);
    const scripts: SiteScripts = {};
    const preview = parsed.config?.preview;
    if (preview?.command) {
      if (preview.mode !== "build" && preview.mode !== "static") {
        const command = configuredServerCommand(preview.command, site.configPath);
        if (command) scripts.dev = command;
      }
    }
    if (parsed.config?.build?.command) scripts.build = parsed.config.build.command;
    return scripts;
  } catch (error) {
    console.warn("[desktop] failed to read configured site scripts", {
      configPath: site.configPath,
      error,
    });
    return {};
  }
}

function hasTraversalSegment(relativePath: string): boolean {
  return relativePath.replaceAll("\\", "/").split("/").includes("..");
}

// A healthy package.json or dohc.json — even a large monorepo root listing
// hundreds of dependencies — measures in the tens of kilobytes. 1 MiB stays
// generous well past that while bounding how much a single metadata file can
// cost to read and parse. The number of such files in a workspace is bounded
// by the number of real projects a user has (not attacker-controlled fan-out
// the way file CONTENT is), so a concurrency cap on top of this byte bound
// would be machinery without a matching cost to bound.
const MAX_METADATA_FILE_BYTES = 1024 * 1024;

async function sourceForFile(rootPath: string, path: string): Promise<string | WorkspaceSiteSource> {
  const name = posix.basename(path);
  if (name !== "package.json" && name !== "dohc.json") return path;
  const absolute = join(rootPath, path);
  try {
    const info = await stat(absolute);
    if (info.size > MAX_METADATA_FILE_BYTES) {
      return {
        path,
        body: null,
        diagnostics: [
          {
            path,
            severity: "warning",
            code: "metadata-too-large",
            message: `${name} exceeds the ${MAX_METADATA_FILE_BYTES / (1024 * 1024)} MiB metadata read limit (${info.size} bytes observed) and was not read.`,
          },
        ],
      };
    }
    return { path, body: await readFile(absolute, "utf8") };
  } catch {
    return { path, body: null };
  }
}

export async function listSitePackages(rootPath: string): Promise<SitePackageInfo[]> {
  const listed = await listFiles(rootPath);
  const sources = await Promise.all(listed.files.map((file) => sourceForFile(rootPath, file.path)));
  const sites = discoverSites(sources);
  const mapped = await Promise.all(
    sites.map(async (site) =>
      mapWorkspaceSite(
        rootPath,
        site,
        listed.files,
        await configuredScriptsForSite(rootPath, site),
      ),
    ),
  );
  return mapped.sort((a, b) => a.root.localeCompare(b.root));
}

export async function getSitePackage(
  rootPath: string,
  anyPath: string,
  knownSites?: SitePackageInfo[],
): Promise<SitePackageInfo | null> {
  const root = denormalizeRoot(anyPath);
  const sites = knownSites ?? await listSitePackages(rootPath);
  return (
    sites
      .filter((site) => anyPath === site.root || root === site.root || isUnder(site.root, anyPath))
      .sort((a, b) => b.root.length - a.root.length)[0] ?? null
  );
}

/**
 * `getSitePackage` intentionally returns the deepest CONTAINING site for a
 * path, which is correct for ordinary lookups (a file inside a site still
 * belongs to it). Starting a preview is different: a stale tab can name a
 * root that stopped being a detected site while a detected ancestor still
 * exists above it. Executing the ancestor's command for a tab that named its
 * own now-gone child would run the wrong site's script. This requires the
 * containing site's root to equal the requested root exactly before a
 * preview may start.
 */
export function requireExactSiteRoot(
  site: SitePackageInfo | null,
  requestedRoot: string,
): SitePackageInfo {
  if (!site || site.root !== requestedRoot) {
    throw new Error(`Not a detected site: ${requestedRoot}`);
  }
  return site;
}

export function entryRelativeToSite(
  site: Pick<SitePackageInfo, "root" | "entryPath">,
): string | null {
  if (!site.entryPath) return null;
  if (site.root === ".") return site.entryPath;
  return site.entryPath.startsWith(`${site.root}/`)
    ? site.entryPath.slice(site.root.length + 1)
    : null;
}

/**
 * Where an ordinary (non-shared, non-build-output) configured entry is
 * actually served from. A browser resolves the page's own root-absolute
 * asset URLs against the SERVED root, so an entry in a subdirectory
 * (public/index.html) must be served from that subdirectory (public/), not
 * from site.root — otherwise its own relative assets resolve beside the
 * subdirectory instead of inside it. Both the static preview server
 * (staticPreviewTargetForSite) and the share-manifest scanner
 * (shareManifestForSite) must agree on this root; they call this one
 * function instead of computing it twice.
 */
function ownedStaticEntryTarget(
  site: Pick<SitePackageInfo, "root" | "entryPath">,
): { root: string; entry: string | null } {
  const entry = entryRelativeToSite(site);
  if (!entry) return { root: site.root, entry: null };
  const directory = posix.dirname(entry);
  return {
    root: directory === "." ? site.root : joinSitePath(site.root, directory),
    entry: posix.basename(entry),
  };
}

export function buildOutputSiteRoot(
  site: Pick<SitePackageInfo, "root">,
  output: string,
): string {
  return site.root === "." ? output : `${site.root}/${output}`;
}
