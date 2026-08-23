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
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseHtml } from "parse5";
import type {
  ListWorkspaceFilesResult,
  WorkspaceFileEntry,
} from "../ipc/bridgeContract";
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
  // isSharedWithMePath recognizes case variants and Windows aliases (a
  // trailing dot, etc.) as the SAME reserved segment — but the returned
  // mount root must still be a literal PREFIX of the original root string,
  // or downstream validation that checks root.startsWith(mountRoot) rejects
  // an otherwise-legitimate site. Preserve parts[0]'s own spelling instead
  // of reconstructing a canonical lowercase literal.
  return `${parts[0]}/${parts[1]}`;
}

function pathRelativeToArtifact(artifactRoot: string, path: string): string | null {
  if (artifactRoot === ".") return path;
  return path.startsWith(`${artifactRoot}/`)
    ? path.slice(artifactRoot.length + 1)
    : null;
}

// The core join both resolveArtifactRelativePath (an ordinary reference) and
// htmlBaseDirectoryFromDocument (a <base href>) share: a browser resolves a
// root-absolute reference ("/x") against the SERVED root (artifactRoot), and
// a document-relative one against whichever directory the referring
// document's own base names.
function joinAgainstArtifact(artifactRoot: string, decoded: string, directory: string): string {
  const artifactBase = artifactRoot === "." ? "" : artifactRoot;
  return posix.normalize(
    decoded.startsWith("/")
      ? posix.join(artifactBase, decoded.replace(/^\/+/, ""))
      : posix.join(directory, decoded),
  );
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
  const candidate = joinAgainstArtifact(
    artifactRoot,
    decoded,
    base.kind === "local" ? base.directory : posix.dirname(fromPath),
  );
  if (
    !pathRelativeToArtifact(artifactRoot, candidate) ||
    hasIgnoredSegment(candidate)
  ) return null;
  return candidate;
}

function resolveExistingReference(
  rawReference: string,
  fromPath: string,
  artifactRoot: string,
  available: ReadonlySet<string>,
  base: HtmlBaseResolution = { kind: "none" },
): string | null {
  const candidate = resolveArtifactRelativePath(rawReference, fromPath, artifactRoot, base);
  if (!candidate) return null;
  return available.has(candidate) ? candidate : null;
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
  // essence, so it's a data block, not a module. An essence-first check
  // would wrongly reduce "module;foo" to essence "module" and match it
  // here.
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

/** `formaction` only overrides the enclosing form's submission target for a
 * SUBMIT control — a `<button>` with no `type` (its default is "submit")
 * or an explicit `type="submit"`, or an `<input type="submit"|"image">`.
 * Any other type (a plain `<button type="button">`, `<input type="text">`,
 * ...) never navigates, so the attribute is inert there. */
function isSubmitControlElement(tagName: string, attrs: ReadonlyMap<string, string>): boolean {
  const type = attrs.get("type")?.toLowerCase();
  if (tagName === "button") return !type || type === "submit";
  if (tagName === "input") return type === "submit" || type === "image";
  return false;
}

/** Being a submit control isn't enough on its own — activating one with no
 * owner form performs no navigation at all, so `formaction` is inert on
 * it. A control owns a form either by DESCENDING from one, or by a
 * `form="id"` attribute naming one anywhere in the document (the HTML
 * spec's form-association rule isn't limited to ancestors). Ids can be
 * declared AFTER the control that references them, so every `<form id>`
 * in the document is collected in its own pass before the main walk
 * needs to check any of them. */
function collectFormIds(document: Html5Node): Set<string> {
  const ids = new Set<string>();
  const visit = (node: Html5Node): void => {
    if (isHtml5Element(node) && node.tagName === "form") {
      const id = node.attrs.find((attribute) => attribute.name === "id")?.value;
      if (id) ids.add(id);
    }
    for (const child of html5ChildNodes(node)) visit(child);
  };
  visit(document);
  return ids;
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

// A <meta http-equiv="Content-Security-Policy" content="..."> that rules a
// resource class out entirely means a real browser never requests it —
// approving it into the share manifest anyway would disclose a file the
// document's own declared policy excludes. Bounded, per the CSP fetch
// directives this scanner can cheaply and unambiguously attribute a
// reference to: img-src, script-src, style-src, connect-src, worker-src,
// with default-src as the fallback each falls back to when absent. Only
// the unambiguous "this whole class is 'none'" case is recognized — a
// source list with host patterns, nonces, hashes, or 'self' is NOT
// evaluated (implementing real CSP source matching is out of this bound),
// so it never narrows what gets shared; the classes above are still exactly
// what the finding's own example ("script-src 'none'" hiding
// <script src="private.js">) demonstrates.
const CSP_DIRECTIVE_FOR_CLASS: Record<CspClass, string> = {
  img: "img-src",
  script: "script-src",
  style: "style-src",
  connect: "connect-src",
  worker: "worker-src",
};

function parseCspDirectives(content: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const rawDirective of content.split(";")) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    const name = tokens[0]?.toLowerCase();
    if (!name) continue;
    // A directive name repeated within the SAME policy: only the first
    // occurrence is honored, later repeats are ignored, per the CSP spec.
    if (!directives.has(name)) directives.set(name, tokens.slice(1));
  }
  return directives;
}

/** The CSP classes a document's meta policies rule out entirely (an
 * effective source list of exactly 'none' OR EMPTY). Every collected policy
 * is evaluated and the results unioned — under CSP's own intersection
 * semantics, ANY policy saying 'none' (or nothing at all) for a class truly
 * blocks it, regardless of what a different policy on the same document
 * allows. A directive present with no source expressions at all
 * (`<meta ... content="img-src">`, parseCspDirectives leaves it `[]`) is as
 * unambiguous a block as an explicit 'none' — a real browser permits
 * NOTHING for a class whose list has zero sources, the same as 'none'. */
function blockedCspClasses(cspPolicyContents: readonly string[]): ReadonlySet<CspClass> {
  const blocked = new Set<CspClass>();
  for (const content of cspPolicyContents) {
    const directives = parseCspDirectives(content);
    for (const cspClass of Object.keys(CSP_DIRECTIVE_FOR_CLASS) as CspClass[]) {
      const sourceList = directives.get(CSP_DIRECTIVE_FOR_CLASS[cspClass]) ?? directives.get("default-src");
      if (!sourceList) continue;
      if (sourceList.length === 0 || (sourceList.length === 1 && sourceList[0]?.toLowerCase() === "'none'")) {
        blocked.add(cspClass);
      }
    }
  }
  return blocked;
}

// CSP's own grammar for a nonce-source's value is base64-value = 1*(ALPHA /
// DIGIT / "+" / "/" / "-" / "_") *2("=") — a token outside that charset
// ('nonce-!!!') is syntactically invalid and Chromium drops it entirely,
// the same way an unrecognized keyword is dropped, rather than treating it
// as a wildcard nonce any script's own (equally malformed) nonce attribute
// could satisfy. The keyword prefix itself still matches case-insensitively
// ('NONCE-' is as valid as 'nonce-'); only the VALUE portion is grammar-
// checked here.
const NONCE_SOURCE_PATTERN = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/i;

// CSP nonce VALUES are meant to be unguessable tokens — two nonces that
// differ only in case are NOT the same one, so unlike the keyword prefix
// above, the value itself must compare case-SENSITIVELY.
function nonceSourceMatches(sourceList: readonly string[], nonce: string): boolean {
  return sourceList.some((token) => NONCE_SOURCE_PATTERN.exec(token)?.[1] === nonce);
}

const HASH_SOURCE_PATTERN = /^'sha(256|384|512)-([A-Za-z0-9+/]+=*)'$/i;

// A real browser hashes the element's exact text content (a <script>/
// <style> body) or the attribute's exact value (style=""/an on* handler,
// only reached when 'unsafe-hashes' also permits attribute matching —
// see isInlineBlockPermitted) — UTF-8 encoded, base64-digested. Multiple
// hash-source tokens can name the SAME algorithm; the digest for each
// algorithm actually present is computed once and reused.
function hashSourceMatches(sourceList: readonly string[], text: string): boolean {
  const digests = new Map<string, string>();
  for (const token of sourceList) {
    const match = HASH_SOURCE_PATTERN.exec(token);
    if (!match?.[1] || !match[2]) continue;
    const algorithm = `sha${match[1]}`;
    let digest = digests.get(algorithm);
    if (digest === undefined) {
      digest = createHash(algorithm).update(text, "utf8").digest("base64");
      digests.set(algorithm, digest);
    }
    if (digest === match[2]) return true;
  }
  return false;
}

/** Whether a SPECIFIC inline block — a <script>/<style> element's own text
 * (with its own `nonce` attribute, if any) or a style=""/on* handler
 * ATTRIBUTE's own value (`isAttribute: true`, `nonce: undefined` — an
 * attribute is never itself an element with a nonce) — is permitted to
 * execute/apply under every policy collected so far in document order
 * (CSP intersection: ANY one policy that doesn't permit it blocks the
 * block document-wide, the same rule blockedCspClasses' external-resource
 * check already follows). `script-src 'self'` (or any source list at
 * all) blocks inline content UNLESS 'unsafe-inline' or a matching nonce-/
 * hash-source is also present — unlike blockedCspClasses, 'self' alone is
 * enough to block here. A hash-source only covers an ATTRIBUTE's value
 * when the list also carries 'unsafe-hashes' (CSP3); nonce-sources never
 * do, since only an ELEMENT — never an attribute value — carries a nonce
 * of its own. 'unsafe-inline' is ignored the instant the list carries ANY
 * nonce- or hash-source token at all, per CSP2+, even for a content type
 * (an attribute against a nonce-only list) that token can never itself
 * satisfy — a real, if surprising, spec-correct lockout. */
function isInlineBlockPermitted(
  cspPolicyContents: readonly string[],
  cspClass: "script" | "style",
  nonce: string | undefined,
  text: string,
  isAttribute: boolean,
): boolean {
  for (const content of cspPolicyContents) {
    const directives = parseCspDirectives(content);
    // Chromium picks the MOST specific directive that's actually present —
    // script-src-elem for a <script> element, script-src-attr for an on*
    // handler (style-src-elem/style-src-attr the same way for style) —
    // before falling back to the generic script-src/style-src, and only
    // THEN to default-src. Consulting script-src/style-src directly here
    // would miss a policy that locks inline execution down further at the
    // element/attribute level while leaving the generic directive open
    // (`script-src 'unsafe-inline'; script-src-attr 'none'`).
    const specificDirective = `${CSP_DIRECTIVE_FOR_CLASS[cspClass]}-${isAttribute ? "attr" : "elem"}`;
    const sourceList =
      directives.get(specificDirective) ?? directives.get(CSP_DIRECTIVE_FOR_CLASS[cspClass]) ?? directives.get("default-src");
    if (!sourceList) continue;
    const hasNonceOrHashSource = sourceList.some(
      (token) => NONCE_SOURCE_PATTERN.test(token) || HASH_SOURCE_PATTERN.test(token),
    );
    const permittedByNonce = !isAttribute && nonce !== undefined && nonceSourceMatches(sourceList, nonce);
    const permittedByHash =
      (!isAttribute || sourceList.some((token) => token.toLowerCase() === "'unsafe-hashes'")) &&
      hashSourceMatches(sourceList, text);
    const permittedByUnsafeInline =
      !hasNonceOrHashSource && sourceList.some((token) => token.toLowerCase() === "'unsafe-inline'");
    if (!permittedByNonce && !permittedByHash && !permittedByUnsafeInline) return false;
  }
  return true;
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
// The LINK_REL_RESOURCE_TOKENS entries a real browser fetches as an
// image (img-src) rather than a stylesheet/manifest/script/prefetch.
const ICON_LINK_REL_TOKENS = ["icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"];

// Fetch's request-destination keywords — the only valid `as` values for
// rel="preload". An invalid, unrecognized, or empty `as` gets no
// destination state at all: the browser aborts preload processing and
// makes no request, so the mere PRESENCE of the attribute isn't enough.
const PRELOAD_AS_DESTINATIONS = new Set([
  "audio", "audioworklet", "document", "embed", "fencedframe", "fetch",
  "font", "frame", "iframe", "image", "manifest", "object", "paintworklet",
  "report", "script", "sharedworker", "style", "track", "video",
  "webidentity", "worker", "xslt",
]);

// The bounded CSP classes (see blockedCspClasses) a validated preload
// destination maps onto — only the destinations this scan already
// distinguishes elsewhere; any other valid destination (font, audio,
// document, ...) is outside the bounded set and left unclassified.
const PRELOAD_AS_DESTINATION_CSP_CLASS: Readonly<Record<string, CspClass>> = {
  image: "img",
  script: "script",
  style: "style",
  fetch: "connect",
  worker: "worker",
  sharedworker: "worker",
};

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
  // Trimmed BEFORE any classification: leading whitespace (" https://evil")
  // would otherwise fail both the "//" network-path check and
  // URI_SCHEME_PATTERN's anchored match below, letting an external URL
  // fall through and resolve as an ordinary local directory instead —
  // exactly the same way a browser's own URL parser strips leading/
  // trailing C0-control-or-space bytes before doing anything else with it.
  const rawHref = firstBaseHref(document)?.trim();
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
  const resolved = joinAgainstArtifact(
    artifactRoot,
    decoded,
    contextBase.kind === "local" ? contextBase.directory : posix.dirname(fromPath),
  );
  const directory = decoded.endsWith("/") ? resolved : posix.dirname(resolved);
  return (directory === artifactRoot ||
    pathRelativeToArtifact(artifactRoot, directory) !== null) &&
    !hasIgnoredSegment(directory)
    ? { kind: "local", directory }
    : { kind: "external" };
}

function referencesFromWebManifest(text: string): Array<{ value: string; documentDestination: boolean }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const record = manifest as Record<string, unknown>;
  const references: Array<{ value: string; documentDestination: boolean }> = [];
  const add = (value: unknown, documentDestination: boolean) => {
    if (typeof value === "string" && value.trim()) references.push({ value, documentDestination });
  };
  const addImages = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const image of value) {
      if (image && typeof image === "object" && !Array.isArray(image)) {
        add((image as Record<string, unknown>).src, false);
      }
    }
  };

  // start_url is where the browser NAVIGATES when the installed PWA
  // launches, and a shortcut's own url navigates there the same way when
  // its menu item is activated — both are document destinations, the
  // same as an <a href>, not merely fetched bytes.
  add(record.start_url, true);
  addImages(record.icons);
  addImages(record.screenshots);
  if (Array.isArray(record.shortcuts)) {
    for (const shortcut of record.shortcuts) {
      if (!shortcut || typeof shortcut !== "object" || Array.isArray(shortcut)) continue;
      const shortcutRecord = shortcut as Record<string, unknown>;
      add(shortcutRecord.url, true);
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
  // True for a <link rel="stylesheet"> href, and for every reference
  // cssReferences() itself produces (its url()/@import targets are read out
  // of text a browser is already applying as CSS, the same way a nested
  // @import target is itself an applied stylesheet). A .css file reached
  // ONLY via fetch()/an asset-style attribute never sets this — the browser
  // fetches its bytes but never parses or applies them as a stylesheet, so
  // its own url()/@import text is never read as CSS either.
  appliesAsStylesheet?: boolean;
  // True for an <object data>/<embed src>/<iframe src> reference: the
  // browser loads the target AS A NESTED DOCUMENT (a plugin/browsing
  // context), not merely as bytes or a raster-like image. An SVG target
  // reached this way is itself parsed for ITS OWN references (<image
  // href>, <use href>, inline <style>) the same way a real browser resolves
  // them — an SVG reached only via <img src> or a CSS url() stays an
  // unexpanded leaf asset, since a browser never processes ITS internal
  // references as separate requests in that context.
  documentDestination?: boolean;
  // The CSP fetch-directive class this reference belongs to, for the
  // bounded set of directives a document's own <meta http-equiv=
  // "Content-Security-Policy"> can rule out entirely: "img" (img-src),
  // "script" (script-src), "style" (style-src), "connect" (connect-src),
  // "worker" (worker-src). Unset for every reference kind outside that
  // bounded set (navigation, form-action, manifest-src, frame-src, ...) —
  // those are never filtered by CSP here, regardless of policy.
  cspClass?: CspClass;
  // The import map that was ACTIVE when this <script src>/modulepreload
  // reference was reached in document order — set only where scriptKind is
  // (an inline block's own importMap field does the equivalent job for
  // inline script text; this is that same capture for an EXTERNAL script
  // reference). Unset for every other reference kind, which never resolves
  // bare specifiers against an import map at all. The queue that turns this
  // reference into a scan target uses this INSTEAD of the document's final
  // resolved map, so a module script reached before a later <script
  // type="importmap"> still scans without one, matching a real browser.
  importMap?: ImportMapResolution;
  // A srcdoc pseudo-document is its OWN document with its OWN <meta CSP>
  // policies, entirely separate from the embedding document's — a
  // reference this srcdoc's own scan discovered (see htmlReferencesFromDocument's
  // srcdoc handling) carries THAT document's own blockedCspClasses forward,
  // so a further file it points to (an external <script src>) is filtered
  // by the policy that actually governs the srcdoc's realm, not by
  // whatever the embedding document's own policy happens to allow.
  // Unset — and the queue falls back to the embedding document's own
  // state, unchanged from before — for every reference NOT sourced from a
  // srcdoc scan.
  blockedCspClasses?: ReadonlySet<CspClass>;
}

type CspClass = "img" | "script" | "style" | "connect" | "worker";

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
// @import's target is either a bare quoted string OR a url() call — and
// url()'s own argument, same as everywhere else url() appears, can be
// unquoted CSS syntax (`@import url(theme.css)` is as valid as
// `@import url("theme.css")` or `@import "theme.css"`). Without the
// unquoted alternative, CSS_URL_PATTERN's own generic (and looser) match
// on the SAME text would classify it img-src instead of style-src.
const CSS_IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(?:"([^"]{1,2048})"|'([^']{1,2048})'|([^"')\s][^)]{0,2047}))\s*\)|"([^"]{1,2048})"|'([^']{1,2048})')/gi;
// A bare url() destination depends on the CSS property it sits in —
// img-src for most (background-image, list-style-image, ...), but
// font-src for an @font-face block's own src. A font-face body never
// legitimately nests another {}, so a flat (non-balanced) match is safe.
const CSS_FONT_FACE_BLOCK_PATTERN = /@font-face\s*\{[^}]*\}/gi;

function fontFaceBlockSpans(cssText: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of cssText.matchAll(CSS_FONT_FACE_BLOCK_PATTERN)) {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  return spans;
}

// `@import url(theme.css)` contains a real url(...) call CSS_URL_PATTERN
// ALSO matches on its own generic pass — without excluding it, the SAME
// span mints two references for the same target: one classified "style"
// (correct — @import pulls in a stylesheet) and one classified "img" (the
// generic pass's default). A policy like `img-src 'self'; style-src
// 'none'` then filters out the correct style-classified reference but
// leaves the img-classified duplicate standing, silently approving a file
// a real browser's style-src would have blocked entirely.
function importSpans(cssText: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of cssText.matchAll(CSS_IMPORT_PATTERN)) {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  return spans;
}

function blankCssStrings(cssText: string): string {
  return cssText.replace(CSS_STRING_PATTERN, (match, offset: number, full: string) => {
    const before = full.slice(Math.max(0, offset - 64), offset);
    if (/url\(\s*$/i.test(before) || /@import\s+$/i.test(before)) return match;
    return match.replace(/[^\r\n]/g, " ");
  });
}

// image-set(<candidate> <descriptor>?, ...) — each candidate can be a
// quoted STRING url (not just url(...)), and the browser fetches whichever
// one it selects for the device. Extracted from the comment-stripped text
// BEFORE blankCssStrings runs: a candidate string isn't preceded by url(
// or @import, so blanking would otherwise erase it as an ordinary,
// resource-free CSS string.
const CSS_IMAGE_SET_OPEN_PATTERN = /(?:-webkit-)?image-set\(/gi;
const CSS_IMAGE_SET_CANDIDATE_PATTERN = /"([^"]{1,2048})"|'([^']{1,2048})'/g;

/** Every image-set(...) call's FULL, balanced body — a candidate list like
 * `url("one.png") 1x, "two.png" 2x` can itself contain a nested url(...)
 * call with its OWN closing paren before image-set's own, so a single
 * non-greedy "stop at the first )" regex truncates the body early and
 * silently drops every candidate after that nested call. This walks the
 * text manually to track paren depth instead. */
function imageSetBodies(cssText: string): string[] {
  const bodies: string[] = [];
  for (const open of cssText.matchAll(CSS_IMAGE_SET_OPEN_PATTERN)) {
    const start = (open.index ?? 0) + open[0].length;
    let depth = 1;
    let index = start;
    while (index < cssText.length && depth > 0) {
      if (cssText[index] === "(") depth++;
      else if (cssText[index] === ")") depth--;
      index++;
    }
    if (depth === 0) bodies.push(cssText.slice(start, index - 1));
  }
  return bodies;
}

// A candidate can carry an explicit type("<mime>") — a hint the browser
// uses to pick the candidate, not a second image to fetch. Its string
// argument looks identical to a real quoted candidate to
// CSS_IMAGE_SET_CANDIDATE_PATTERN — blanking type(...) text out of the
// body BEFORE matching (the earlier approach) has no notion of "inside a
// string": a REAL candidate whose own text happens to contain the
// substring "type(...)" (e.g. `"icons/type('dark').png"`) gets corrupted
// before extraction, same as blankCssStrings would corrupt an
// unrelated string if it didn't check what precedes a match. Checking
// what immediately PRECEDES each already-matched quoted string — the
// same technique blankCssStrings already uses — distinguishes a real
// type() hint (preceded by "type(") from a candidate whose own content
// merely contains that text, without needing to blank anything first.
function imageSetStringCandidates(cssText: string): string[] {
  const values: string[] = [];
  for (const body of imageSetBodies(cssText)) {
    for (const candidate of body.matchAll(CSS_IMAGE_SET_CANDIDATE_PATTERN)) {
      const start = candidate.index ?? 0;
      const before = body.slice(Math.max(0, start - 16), start);
      if (/type\(\s*$/i.test(before)) continue;
      const value = (candidate[1] ?? candidate[2])?.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

function cssReferences(rawCssText: string): BrowserTextReference[] {
  const withoutComments = rawCssText.replace(CSS_COMMENT_PATTERN, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );
  const references: BrowserTextReference[] = [];
  for (const value of imageSetStringCandidates(withoutComments)) {
    references.push({ value, documentRelative: false, appliesAsStylesheet: true, cspClass: "img" });
  }
  const cssText = blankCssStrings(withoutComments);
  const fontFaceSpans = fontFaceBlockSpans(cssText);
  const cssImportSpans = importSpans(cssText);
  for (const match of cssText.matchAll(CSS_URL_PATTERN)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim();
    if (!value) continue;
    const start = match.index ?? 0;
    // @import's OWN url(...) call is handled by the @import pass below,
    // with the correct style-src classification — matching it again here
    // would mint a second, wrongly-classified reference for the same span.
    if (cssImportSpans.some(([spanStart, spanEnd]) => start >= spanStart && start < spanEnd)) continue;
    // A bare url() inside an @font-face block's own src is font-src, not
    // img-src — font-src isn't in this scan's bounded CSP set (see
    // blockedCspClasses), so it's left unclassified rather than
    // misclassified img-src, which would let an img-src 'none' policy
    // wrongly remove a font a real browser is still allowed to fetch.
    // Everywhere else a bare url() is img-src, the more common case and
    // the one of the two actually in the bounded set.
    const inFontFace = fontFaceSpans.some(([spanStart, spanEnd]) => start >= spanStart && start < spanEnd);
    references.push({
      value,
      documentRelative: false,
      appliesAsStylesheet: true,
      ...(inFontFace ? {} : { cspClass: "img" as const }),
    });
  }
  for (const match of cssText.matchAll(CSS_IMPORT_PATTERN)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])?.trim();
    // @import pulls in a whole further STYLESHEET — style-src, not img-src.
    if (value) references.push({ value, documentRelative: false, appliesAsStylesheet: true, cspClass: "style" });
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
// document, fetch, Worker, SharedWorker, URL, importScripts,
// XMLHttpRequest — must be the REAL globals, not a same-named local.
// Over-conservative by design: if the
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
  "XMLHttpRequest",
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
    // document.documentElement (the <html> root) is exactly as always-
    // attached as document.body/document.head — an insertion proof check
    // that only recognizes body/head rejects
    // document.documentElement.appendChild(script), so a real, connected
    // (and therefore actually fetched) script gets declined as unproven.
    return name === "body" || name === "head" || name === "documentElement" ? name : undefined;
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

/**
 * Shared skeleton behind collectDomProducingTags/collectUrlLiteralNames/
 * collectXhrInstanceNames: every name bound by `identifier = source` (a
 * declarator's init or a plain `=` assignment), classified by `proveValue`.
 * A function parameter's value is never provable statically, so its name is
 * invalidated up front and can never re-enter `proven`. A bare declaration
 * (`let x;`, source null/undefined) proves nothing but doesn't invalidate
 * either — only an ACTUAL, differently-classified value does. Two DIFFERENT
 * proven values for the same name is the same cross-scope collision, just
 * between two proven bindings instead of one proven and one not — neither
 * is trustworthy, so both classifiers that carry more than one possible
 * proven value rely on this check (a classifier with exactly one possible
 * value, like collectXhrInstanceNames', can never trigger it: re-proving the
 * same value twice is not a conflict).
 *
 * `maxPasses` > 1 lets `proveValue` read the accumulator being built, for a
 * classifier (collectDomProducingTags': `let a = document.createElement(
 * "img"); let b = a;`) whose own proof can depend on an EARLIER proof from
 * the same walk. Passes stop as soon as one makes no further change.
 */
function collectProvenBindings<T>(
  program: AstNode,
  proveValue: (source: unknown, proven: ReadonlyMap<string, T>) => T | undefined,
  maxPasses = 1,
): Map<string, T> {
  const proven = new Map<string, T>();
  const invalidated = new Set<string>(collectFunctionParameterNames(program));
  for (let pass = 0; pass < maxPasses; pass += 1) {
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
      const value = proveValue(source, proven);
      if (value === undefined) {
        if (source === null || source === undefined) return;
        if (proven.delete(name)) changed = true;
        invalidated.add(name);
        return;
      }
      const existing = proven.get(name);
      if (existing !== undefined && existing !== value) {
        proven.delete(name);
        invalidated.add(name);
        changed = true;
        return;
      }
      proven.set(name, value);
      changed = true;
    });
    if (!changed) break;
  }
  return proven;
}

function collectDomProducingTags(
  program: AstNode,
  shadowedGlobals: ReadonlySet<string>,
): Map<string, DomProducingTag> {
  return collectProvenBindings(
    program,
    (source, tags) => domProducingTag(source, tags, shadowedGlobals),
    3,
  );
}

// Knowing an expression CREATES a script/link/etc. element doesn't prove
// assigning its src/href performs a request — `document.createElement
// ("script")` alone never connects it to the document; only an insertion
// call does, and only THEN does a later src/href assignment (or one that
// already ran before insertion — order doesn't matter, the request fires
// once BOTH have happened) actually fetch anything.
const DOM_INSERTION_METHOD_NAMES = new Set([
  "appendChild",
  "insertBefore",
  "append",
  "prepend",
  "replaceWith",
  "replaceChildren",
]);

/** Every identifier name EVER passed as an argument to a DOM insertion
 * call (appendChild/insertBefore/append/prepend/replaceWith/
 * replaceChildren) whose RECEIVER is itself a proven DOM node — a plain,
 * non-fixed-point pass over the already-resolved provenTags map, since
 * insertion is a terminal fact (not something that itself needs to
 * propagate through further chained assignments the way a DOM tag does).
 * Like provenTags itself, this is a flat, name-keyed check with the same
 * residual cross-scope imprecision the whole file already accepts: an
 * unrelated function's own same-named variable passed to some OTHER
 * insertion call can't be told apart from ours without real lexical
 * scoping, which this heuristic scanner deliberately doesn't build. */
function collectInsertedIdentifierNames(
  program: AstNode,
  provenTags: ReadonlyMap<string, DomProducingTag>,
  shadowedGlobals: ReadonlySet<string>,
): Set<string> {
  const inserted = new Set<string>();
  walkAst(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = astChild(node, "callee");
    if (!isAstNode(callee) || callee.type !== "MemberExpression") return;
    const property = astChild(callee, "property");
    const methodName = isAstNode(property) && property.type === "Identifier" ? astString(property, "name") : undefined;
    if (!methodName || !DOM_INSERTION_METHOD_NAMES.has(methodName)) return;
    const receiver = astChild(callee, "object");
    if (domProducingTag(receiver, provenTags, shadowedGlobals) === undefined) return;
    for (const argument of astChildren(node, "arguments")) {
      if (isAstNode(argument) && argument.type === "Identifier") {
        const name = astString(argument, "name");
        if (name) inserted.add(name);
      }
    }
  });
  return inserted;
}

// img/video/audio start loading their resource the instant the relevant
// property is SET — the classic `new Image(); img.src = url` preload idiom
// relies on exactly this, and it never inserts the element anywhere. Every
// other tag URL_ATTRIBUTE_ELEMENTS tracks (script, link, iframe, embed,
// object, input, source, ...) needs a real browser to actually CONNECT the
// element to the document before it fetches or executes anything for it.
const URL_FETCH_WITHOUT_INSERTION_TAGS = new Set(["img", "video", "audio"]);

/** Whether `object.property = lit` or `object.setAttribute("property", lit)`
 * is a proven, resource-consuming (tag, property) pair — reuses
 * URL_ATTRIBUTE_ELEMENTS, the SAME allowlist markup attributes already go
 * through, so a DOM element's real tag is held to the identical rule.
 * Also requires proof the element was actually INSERTED somewhere in the
 * document for every tag that genuinely needs it — an unattached
 * `document.createElement("script")` never connects to anything, and
 * assigning its src is inert until it does. */
function isProvenUrlReceiver(
  object: unknown,
  propertyName: string,
  provenTags: ReadonlyMap<string, DomProducingTag>,
  insertedIdentifierNames: ReadonlySet<string>,
  shadowedGlobals: ReadonlySet<string>,
): boolean {
  const tag = domProducingTag(object, provenTags, shadowedGlobals);
  if (tag === undefined || tag === "unknown" || !(URL_ATTRIBUTE_ELEMENTS[propertyName]?.has(tag) ?? false)) {
    return false;
  }
  if (URL_FETCH_WITHOUT_INSERTION_TAGS.has(tag)) return true;
  // document.body/document.head are ALWAYS already in the document — a
  // MemberExpression is the only shape domProducingTag ever returns "body"/
  // "head" for, so this can't also match a fresh document.createElement(...)
  // chain.
  if (isAstNode(object) && object.type === "MemberExpression") return true;
  // An identifier-bound element (document.createElement(...) assigned to a
  // variable, or a chain resolving to one) needs its OWN insertion proven.
  // A FRESH document.createElement(...) chain that was never bound to a
  // variable at all (object.type !== "Identifier" here) has no way to be
  // traced to a later insertion call either — unprovable, so it's declined
  // the same as an identifier that fails the insertion check, not treated
  // as automatically proven.
  if (!isAstNode(object) || object.type !== "Identifier") return false;
  const name = astString(object, "name");
  return !!name && insertedIdentifierNames.has(name);
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
interface ResolvedSpecifierMap {
  imports: ReadonlyMap<string, string>;
  // A relative/root-relative import-map KEY ("./lib.js") is itself a
  // URL-like specifier, not a bare one — the spec normalizes it against the
  // map's own (declaring document) base the same way it normalizes the
  // address it maps to, then matches an importer's specifier by its OWN
  // normalized form. Keyed by the same artifact-root-absolute ("/"-prefixed)
  // convention resolveImportMapAddresses already uses for values.
  urlLikeImports: ReadonlyMap<string, string>;
  // A URL-like key whose address resolves to something this scanner can't
  // reach locally (most commonly an external URL) is still a REAL mapping
  // the browser follows — not an absent one. Recorded so
  // resolveModuleSpecifier can treat it as a TERMINAL resolution (mint
  // nothing) instead of falling through and treating the specifier as an
  // unmapped local path, which would wrongly approve a colliding local
  // file the browser never actually requests.
  externalUrlLikeKeys: ReadonlySet<string>;
}

interface ImportMapResolution extends ResolvedSpecifierMap {
  // `scopes` remaps specifiers only for modules whose OWN resolved path
  // falls under a given prefix — keyed by that prefix (with its trailing
  // "/" preserved, so a boundary like "/feature/" can never also match
  // "/feature-other/..."), normalized the same "/"-prefixed way as a
  // urlLikeImports key. The spec tries EVERY matching scope, longest
  // prefix first, before falling back to the top-level maps above — a
  // parent scope still applies when the most specific matching scope
  // doesn't map the specifier either.
  scopes: ReadonlyMap<string, ResolvedSpecifierMap>;
}

// A document can declare more than one <script type="importmap"> — the
// HTML standard (and Chromium/WebKit as of the version this scanner
// targets) merges each into a single global import map as it's parsed,
// in document order: a key an EARLIER map already claimed (in imports,
// urlLikeImports, OR externalUrlLikeKeys — never more than one of those
// three for the same key) keeps its original value; a later map only
// ever fills in a key nothing has claimed yet.
function mergeSpecifierMaps(
  existing: ResolvedSpecifierMap,
  next: ResolvedSpecifierMap,
  lockedKeys: ReadonlySet<string>,
): ResolvedSpecifierMap {
  const imports = new Map(existing.imports);
  const urlLikeImports = new Map(existing.urlLikeImports);
  const externalUrlLikeKeys = new Set(existing.externalUrlLikeKeys);
  // A key an EARLIER map already claims keeps its value; a key an earlier
  // MODULE already resolved (lockedKeys — see lockedModuleSpecifierKeys)
  // is just as unavailable to a later map, even one introducing it for
  // the very first time — a real browser's already-resolved specifier
  // stays fixed to its original target regardless of which reason came
  // first.
  const claimed = (key: string) =>
    imports.has(key) || urlLikeImports.has(key) || externalUrlLikeKeys.has(key) || lockedKeys.has(key);
  for (const [key, value] of next.imports) if (!claimed(key)) imports.set(key, value);
  for (const [key, value] of next.urlLikeImports) if (!claimed(key)) urlLikeImports.set(key, value);
  for (const key of next.externalUrlLikeKeys) if (!claimed(key)) externalUrlLikeKeys.add(key);
  return { imports, urlLikeImports, externalUrlLikeKeys };
}

// Scopes merge the same way, per prefix: a scope only the later map
// declares is added wholesale; a scope BOTH declare merges its own
// specifier map with the same earlier-wins-or-locked rule.
function mergeImportMapResolutions(
  existing: ImportMapResolution,
  next: ImportMapResolution,
  lockedKeys: ReadonlySet<string>,
): ImportMapResolution {
  const emptySpecifierMap: ResolvedSpecifierMap = {
    imports: new Map(),
    urlLikeImports: new Map(),
    externalUrlLikeKeys: new Set(),
  };
  const scopes = new Map(existing.scopes);
  for (const [prefix, nextScope] of next.scopes) {
    const existingScope = scopes.get(prefix) ?? emptySpecifierMap;
    // A brand-new scope prefix still needs its OWN keys checked against
    // lockedKeys — a scope this map never had before is not exempt from
    // "a key an earlier module already resolved stays fixed."
    scopes.set(prefix, mergeSpecifierMaps(existingScope, nextScope, lockedKeys));
  }
  return { ...mergeSpecifierMaps(existing, next, lockedKeys), scopes };
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

/** The LONGEST scope whose prefix is an ancestor of the IMPORTING script's
 * own resolved path — the same longest-prefix-wins rule as everything
 * else here, applied to the importer's location instead of the specifier. */
/** Every scope whose prefix is an ancestor of the IMPORTING script's own
 * resolved path, longest prefix FIRST — the spec tries each matching scope
 * in turn (most specific first) and only moves on when the current one
 * doesn't map the specifier either, so a PARENT scope still applies when
 * the closest matching scope doesn't have an entry. */
function matchingScopes(
  importMap: ImportMapResolution,
  fromPath: string,
  artifactRoot: string,
): ResolvedSpecifierMap[] {
  const importerRelative = pathRelativeToArtifact(artifactRoot, fromPath);
  if (importerRelative === null) return [];
  const importerKey = `/${importerRelative}`;
  return [...importMap.scopes]
    .filter(([scopeKey]) => importerKey.startsWith(scopeKey))
    .sort(([a], [b]) => b.length - a.length)
    .map(([, scope]) => scope);
}

// The key an import map entry (or the "resolved module set" locking a
// specifier against a later remap — see lockedModuleSpecifierKeys) would
// use for this specifier: a bare specifier's own text, or a URL-like one's
// normalized, artifact-root-relative "/"-prefixed form — the same
// normalization the spec applies to a URL-like map KEY before matching it,
// applied here to a REFERRING specifier so the two compare equal.
function moduleSpecifierKey(
  specifier: string,
  fromPath: string,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
): string {
  if (isBareModuleSpecifier(specifier)) return specifier;
  const normalized = resolveArtifactRelativePath(specifier, fromPath, artifactRoot, ownBase);
  const normalizedRelative = normalized ? pathRelativeToArtifact(artifactRoot, normalized) : null;
  return normalizedRelative === null ? specifier : `/${normalizedRelative}`;
}

// A real browser's module map permanently remembers a specifier's
// resolution the FIRST time any earlier module resolves it (whether via an
// import map or a URL-like specifier's own natural relative target) — a
// LATER <script type="importmap"> cannot retroactively remap that same
// specifier for anything reached afterward either, even a brand-new key no
// EARLIER map ever claimed. mergeImportMapResolutions' own "earlier map's
// key wins" rule only covers two import maps declaring the same key; this
// closes the other half by returning every specifier key an earlier BLOCK
// already resolved, so a later map's new entry for that same key can be
// dropped too. A cheap, EAGER, resolution-only pre-scan — reuses the exact
// same AST node types and resolution rule jsReferencesFromCode's own
// deferred pass applies, just to the "was this specifier resolved" question
// alone, not full reference collection.
function lockedModuleSpecifierKeys(
  code: string,
  scriptKind: ScriptKind,
  fromPath: string,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
  importMap: ImportMapResolution | undefined,
): string[] {
  const program = parseJavaScript(code, scriptKind);
  if (!program) return [];
  const keys: string[] = [];
  walkAst(program, (node) => {
    if (
      node.type !== "ImportDeclaration" &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration" &&
      node.type !== "ImportExpression"
    ) {
      return;
    }
    const specifier = stringLiteralValue(astChild(node, "source"))?.trim();
    if (!specifier) return;
    // A path-like specifier always resolves to SOMETHING — its own natural
    // relative target, an explicit remap, or an external URL this scanner
    // can't reach locally — every one of those outcomes is a REAL
    // resolution that locks it. A bare specifier has no natural
    // resolution at all: it locks only when an import map actually maps
    // it: an unmapped bare specifier fails to resolve, so nothing was
    // fetched and nothing locks.
    const locks =
      !isBareModuleSpecifier(specifier) ||
      resolveModuleSpecifier(specifier, importMap, fromPath, ownBase, artifactRoot) !== undefined;
    if (locks) keys.push(moduleSpecifierKey(specifier, fromPath, ownBase, artifactRoot));
  });
  return keys;
}

function resolveModuleSpecifier(
  specifier: string,
  importMap: ImportMapResolution | undefined,
  fromPath: string,
  ownBase: HtmlBaseResolution,
  artifactRoot: string,
): string | undefined {
  if (!importMap) return isBareModuleSpecifier(specifier) ? undefined : specifier;
  const scopes = matchingScopes(importMap, fromPath, artifactRoot);
  if (!isBareModuleSpecifier(specifier)) {
    // A URL-like specifier still passes through the import map: the spec
    // normalizes it against the IMPORTING script's own base and matches
    // that normalized form against the map's (already-normalized) keys —
    // an exact key OR the longest "prefix/" key it starts with. Unmatched,
    // it resolves to itself — same as before this lookup existed.
    const normalizedKey = moduleSpecifierKey(specifier, fromPath, ownBase, artifactRoot);
    for (const scope of scopes) {
      if (scope.externalUrlLikeKeys.has(normalizedKey)) return undefined;
      const resolved = resolveAgainstImportMapEntries(normalizedKey, scope.urlLikeImports);
      if (resolved !== undefined) return resolved;
    }
    if (importMap.externalUrlLikeKeys.has(normalizedKey)) return undefined;
    return resolveAgainstImportMapEntries(normalizedKey, importMap.urlLikeImports) ?? specifier;
  }
  for (const scope of scopes) {
    const resolved = resolveAgainstImportMapEntries(specifier, scope.imports);
    if (resolved !== undefined) return resolved;
  }
  return resolveAgainstImportMapEntries(specifier, importMap.imports);
}

function rawSpecifierMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, specifierValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof specifierValue === "string") map.set(key, specifierValue);
    }
  }
  return map;
}

function parseImportMap(text: string): ImportMapResolution | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const imports = rawSpecifierMap((parsed as Record<string, unknown>).imports);
  const scopesField = (parsed as Record<string, unknown>).scopes;
  // Raw, pre-normalization form — each scope's own key AND its specifier
  // map both go through the same resolution resolveImportMapAddresses
  // already applies to the top-level maps, before this is used anywhere.
  const scopes = new Map<string, ResolvedSpecifierMap>();
  if (scopesField && typeof scopesField === "object" && !Array.isArray(scopesField)) {
    for (const [scopeKey, scopeValue] of Object.entries(scopesField as Record<string, unknown>)) {
      scopes.set(scopeKey, { imports: rawSpecifierMap(scopeValue), urlLikeImports: new Map(), externalUrlLikeKeys: new Set() });
    }
  }
  return { imports, urlLikeImports: new Map(), externalUrlLikeKeys: new Set(), scopes };
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
  return collectProvenBindings(program, (source) => newUrlLiteral(source, shadowedGlobals));
}

function isNewXhrExpression(node: unknown, shadowedGlobals: ReadonlySet<string>): boolean {
  if (!isAstNode(node) || node.type !== "NewExpression") return false;
  const callee = astChild(node, "callee");
  return (
    isAstNode(callee) &&
    callee.type === "Identifier" &&
    astString(callee, "name") === "XMLHttpRequest" &&
    !shadowedGlobals.has("XMLHttpRequest")
  );
}

/** Every identifier PROVABLY bound to `new XMLHttpRequest()` — same
 * conservative-kill shape as collectDomProducingTags/collectUrlLiteralNames:
 * a function parameter's value is never provable, and a name later bound
 * to something else anywhere in the file is untrustworthy everywhere. */
function collectXhrInstanceNames(program: AstNode, shadowedGlobals: ReadonlySet<string>): Set<string> {
  return new Set(
    collectProvenBindings(program, (source) =>
      isNewXhrExpression(source, shadowedGlobals) ? true : undefined,
    ).keys(),
  );
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
  const insertedIdentifierNames = collectInsertedIdentifierNames(program, provenDomTags, shadowedGlobals);
  const urlLiteralNames = collectUrlLiteralNames(program, shadowedGlobals);
  const provenXhrNames = collectXhrInstanceNames(program, shadowedGlobals);
  // XMLHttpRequest.open(method, url, ...) only initializes a request — no
  // network request happens until .send() is called on the SAME instance,
  // and re-opening BEFORE sending discards the prior configuration (only
  // the LAST open() before send() is ever actually requested). walkAst is
  // a single PRE-ORDER pass over the source text's own shape, not runtime
  // order. Straight-line code (`open(a); send(); open(b);`) visits opens
  // and sends in the SAME order it runs them — the correct target for a
  // given send() is whichever open() was MOST RECENTLY VISITED before it,
  // not the receiver's LAST open() anywhere in the file (a later re-open
  // with no send after it must not retroactively steal an earlier send's
  // target). Each send() captures whatever open target is CURRENTLY on
  // record for its receiver at that point in the walk.
  //
  // A capture that comes up empty means no open() had been visited yet
  // for that receiver AT THAT POINT — e.g. a function DECLARED before a
  // later open() and CALLED after it: walk order proves nothing there.
  // Falling back to the receiver's fully-resolved open target is only
  // SOUND when that receiver only ever opens ONE distinct target in the
  // whole file — with two or more distinct opens (`function issue(){
  // xhr.send() } xhr.open(a); issue(); xhr.open(b);`), no amount of
  // walk-order bookkeeping proves which one this particular unresolved
  // send() paired with at runtime, so it's declined rather than guessed
  // — approving the wrong file, or omitting the right one, are both
  // worse than a conservative miss here.
  const xhrOpenTargets = new Map<string, { value: string | undefined; scriptRelative: boolean }>();
  const xhrDistinctOpenTargets = new Map<string, Set<string>>();
  const xhrSendCaptures: Array<{ name: string; target: { value: string | undefined; scriptRelative: boolean } | undefined }> = [];
  const references: BrowserTextReference[] = [];
  const addReference = (
    value: string | undefined,
    documentRelative: boolean,
    entersOwnContext = false,
    referenceScriptKind?: ScriptKind,
    cspClass?: CspClass,
  ) => {
    const trimmed = value?.trim();
    // Every reference this scan discovers is part of the SAME module graph
    // this code itself was reached through — its OWN `importMap` parameter
    // (a per-push-time snapshot for an inline block, or an inherited one
    // for an already-queued file) is the resolution context a real browser
    // would keep using for anything reachable from here, not whatever
    // import map the document happens to have by the time this reference's
    // OWN target is later scanned.
    if (trimmed) {
      references.push({
        value: trimmed,
        documentRelative,
        entersOwnContext,
        scriptKind: referenceScriptKind,
        cspClass,
        importMap,
      });
    }
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
        "script",
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
    if (!isProvenUrlReceiver(object, propertyName, provenDomTags, insertedIdentifierNames, shadowedGlobals)) return;
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
      case "ExportAllDeclaration":
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
          addReference(value, !scriptRelative, true, workerScriptKind(args[1]), "worker");
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
            addReference(value, !scriptRelative, false, undefined, "connect");
          } else if (calleeName === "importScripts" && context === "worker" && scriptKind === "classic") {
            // importScripts() only exists on a classic worker's global scope. A
            // module worker or module service worker has no such global — the
            // call throws before any network request is made, so a module
            // worker's importScripts(...) arguments are never fetched.
            for (const argument of args) addReference(stringLiteralValue(argument), false, false, "classic", "script");
          }
        } else if (callee.type === "MemberExpression") {
          const property = astChild(callee, "property");
          const object = astChild(callee, "object");
          const propertyName =
            isAstNode(property) && property.type === "Identifier" ? astString(property, "name") : undefined;
          if (propertyName === "register" && isServiceWorkerReceiver(object, shadowedGlobals)) {
            // A registered service worker runs in its own global scope with
            // its own script URL, same as Worker/SharedWorker — including
            // the SAME { type: "module" } registration option deciding its
            // grammar.
            const { value, scriptRelative } = consumedValue(args[0]);
            addReference(value, !scriptRelative, true, workerScriptKind(args[1]), "worker");
          } else if (
            propertyName === "fetch" &&
            (isGlobalReceiver(object, "window", shadowedGlobals) ||
              isGlobalReceiver(object, "globalThis", shadowedGlobals))
          ) {
            // `window.fetch`/`globalThis.fetch` request exactly like a bare
            // `fetch(...)` call — the same unshadowed-global rule already
            // governs `document`/`navigator` receivers.
            const { value, scriptRelative } = consumedValue(args[0]);
            addReference(value, !scriptRelative, false, undefined, "connect");
          } else if (propertyName === "setAttribute" && args.length >= 2) {
            // HTML attribute names are case-INSENSITIVE — a real
            // setAttribute("SRC", ...) call sets the same "src" attribute
            // as setAttribute("src", ...) — but URL_ATTRIBUTE_ELEMENTS is
            // keyed lowercase, so an uppercase/mixed-case literal here
            // would otherwise miss the lookup entirely and the reference
            // never gets recorded. A DIRECT property assignment
            // (`img.SRC = ...`, the OTHER addUrlAttributeReference call
            // site below) stays case-sensitive — that's real JS property
            // access, not an HTML attribute name.
            const attributeName = stringLiteralValue(args[0])?.toLowerCase();
            if (attributeName) addUrlAttributeReference(object, attributeName, args[1]);
          } else if (
            propertyName === "open" &&
            args.length >= 2 &&
            isAstNode(object) &&
            object.type === "Identifier" &&
            provenXhrNames.has(astString(object, "name") ?? "")
          ) {
            // Record the target rather than minting a reference — open()
            // alone never fetches (see xhrOpenTargets above). Overwrites
            // any earlier recorded target for this receiver: a re-open
            // discards the prior configuration for real, so only the most
            // recently visited one stays a candidate.
            const openName = astString(object, "name") ?? "";
            const target = consumedValue(args[1]);
            xhrOpenTargets.set(openName, target);
            const distinct = xhrDistinctOpenTargets.get(openName) ?? new Set<string>();
            distinct.add(`${target.scriptRelative}:${target.value ?? ""}`);
            xhrDistinctOpenTargets.set(openName, distinct);
          } else if (
            propertyName === "send" &&
            isAstNode(object) &&
            object.type === "Identifier" &&
            provenXhrNames.has(astString(object, "name") ?? "")
          ) {
            // send() is what actually issues the request — capture
            // whichever open target is on record for this receiver RIGHT
            // NOW (see xhrOpenTargets above), not whatever it ends up
            // being by the end of the walk.
            const name = astString(object, "name") ?? "";
            xhrSendCaptures.push({ name, target: xhrOpenTargets.get(name) });
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
  // url resolves against the document, the same as fetch() — for every
  // receiver that ever calls send(), regardless of the walk's source
  // order relative to its open() call(s).
  for (const capture of xhrSendCaptures) {
    // A capture that came up empty means no open() had been visited yet
    // for this receiver AT THAT POINT in the walk — walk order can't
    // resolve it. Falling back to the receiver's fully-resolved open
    // target is only sound when it's the ONLY distinct target that
    // receiver ever opens — with two or more, no walk-order bookkeeping
    // proves which one this send() paired with at runtime, so it's
    // declined rather than guessed.
    const unambiguous = (xhrDistinctOpenTargets.get(capture.name)?.size ?? 0) <= 1;
    const opened = capture.target ?? (unambiguous ? xhrOpenTargets.get(capture.name) : undefined);
    if (opened) addReference(opened.value, !opened.scriptRelative, false, undefined, "connect");
  }
  return references;
}

// ---- HTML: parse once with parse5 and walk the real tree.

interface HtmlDocumentReferences {
  references: BrowserTextReference[];
  // The document's own active import map, if it declared one — undefined
  // for a plain document (never inherited: each HTML document is a fresh
  // realm, and only the module scripts IT loads share this map).
  importMap: ImportMapResolution | undefined;
  // The FINAL (whole-document) set of CSP classes this document's own
  // meta policies rule out — carried onto the scan queue so an external
  // script/stylesheet THIS document references is scanned under the SAME
  // policy, not treated as if the document had no CSP at all. A resource
  // reached only via such an external file is requested by the browser
  // under the referring document's policy, the same way document-level
  // CSP applies to everything it loads.
  blockedCspClasses: ReadonlySet<CspClass>;
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
function resolveSpecifierMap(
  rawMap: ReadonlyMap<string, string>,
  documentPath: string,
  documentBase: HtmlBaseResolution,
  artifactRoot: string,
): ResolvedSpecifierMap {
  const resolved = new Map<string, string>();
  const resolvedUrlLike = new Map<string, string>();
  const externalUrlLikeKeys = new Set<string>();
  const normalizedKeyOf = (key: string): string | null => {
    const normalizedKey = resolveArtifactRelativePath(key, documentPath, artifactRoot, documentBase);
    const normalizedKeyRelative = normalizedKey ? pathRelativeToArtifact(artifactRoot, normalizedKey) : null;
    return normalizedKeyRelative === null ? null : `/${normalizedKeyRelative}`;
  };
  for (const [key, rawAddress] of rawMap) {
    const candidate = resolveArtifactRelativePath(rawAddress, documentPath, artifactRoot, documentBase);
    // candidate is already artifact-relative (it includes artifactRoot's own
    // prefix, e.g. "dist/assets/main.js"). The "/"-prefix convention below
    // means "resolve against the artifact root", which re-adds that same
    // prefix on the next pass — strip it first or a nested artifactRoot
    // gets joined onto itself.
    const artifactRelative = candidate ? pathRelativeToArtifact(artifactRoot, candidate) : null;
    const isBare = isBareModuleSpecifier(key);
    if (artifactRelative === null) {
      // The address resolves to something this scanner can't reach
      // locally (an external URL is the common case) — the mapping is
      // still real; a URL-like key must be recorded as a TERMINAL
      // resolution, not silently dropped as if unmapped.
      if (!isBare) {
        const normalizedKey = normalizedKeyOf(key);
        if (normalizedKey !== null) externalUrlLikeKeys.add(normalizedKey);
      }
      continue;
    }
    const resolvedValue = `/${artifactRelative}`;
    if (isBare) {
      resolved.set(key, resolvedValue);
      continue;
    }
    // A relative/root-relative key normalizes the same way its address
    // does, against THIS document's own base — an importer's specifier is
    // matched against this normalized form, not the raw key text.
    const normalizedKey = normalizedKeyOf(key);
    if (normalizedKey !== null) resolvedUrlLike.set(normalizedKey, resolvedValue);
  }
  return { imports: resolved, urlLikeImports: resolvedUrlLike, externalUrlLikeKeys };
}

function resolveImportMapAddresses(
  importMap: ImportMapResolution,
  documentPath: string,
  documentBase: HtmlBaseResolution,
  artifactRoot: string,
): ImportMapResolution {
  const { imports, urlLikeImports, externalUrlLikeKeys } = resolveSpecifierMap(
    importMap.imports,
    documentPath,
    documentBase,
    artifactRoot,
  );
  const scopes = new Map<string, ResolvedSpecifierMap>();
  for (const [scopeKey, scopeMap] of importMap.scopes) {
    // A scope's own key is itself a URL-like prefix — normalized against
    // the declaring document's base the exact same way a urlLikeImports
    // key is, so it can be compared against an importer's OWN normalized
    // path later. resolveArtifactRelativePath preserves a trailing "/" (a
    // scope key is written that way to mark a directory boundary), so
    // "/feature/" can never also match an importer under "/feature-other/".
    const normalizedScopeKey = resolveArtifactRelativePath(scopeKey, documentPath, artifactRoot, documentBase);
    const normalizedScopeRelative = normalizedScopeKey ? pathRelativeToArtifact(artifactRoot, normalizedScopeKey) : null;
    if (normalizedScopeRelative === null) continue;
    scopes.set(
      `/${normalizedScopeRelative}`,
      resolveSpecifierMap(scopeMap.imports, documentPath, documentBase, artifactRoot),
    );
  }
  return { imports, urlLikeImports, externalUrlLikeKeys, scopes };
}

function htmlReferencesFromDocument(
  document: Html5Node,
  context: JsScanContext,
  documentBase: HtmlBaseResolution,
  documentPath: string,
  artifactRoot: string,
): HtmlDocumentReferences {
  const attributeReferences: BrowserTextReference[] = [];
  // Each block carries the blockedSoFar SNAPSHOT captured at the moment it
  // was collected — a real browser starts running/applying a block (and
  // whatever it goes on to request) the instant it's parsed, so a LATER
  // meta CSP must not retroactively remove a dependency the block's OWN
  // execution already requested before that policy took effect. JS/handler
  // blocks ALSO carry the import map that was ACTIVE at the moment they
  // were collected — a module graph that already started before a later
  // <script type="importmap"> doesn't retroactively pick it up either (a
  // real browser only ever resolves specifiers against whichever map was
  // already parsed when that graph began). One tagged array instead of one
  // per kind: each push site already knows what it's collecting, and the
  // consuming flatMap below dispatches on that tag instead of running once
  // per kind's own separately-typed array.
  const deferredTexts: Array<
    | { kind: "css"; text: string; blocked: ReadonlySet<CspClass> }
    | {
        kind: "classicJs" | "moduleJs" | "handler";
        text: string;
        blocked: ReadonlySet<CspClass>;
        importMap: ImportMapResolution | undefined;
      }
  > = [];
  // The HTML standard (and Chromium/WebKit's own current support) merges
  // EVERY <script type="importmap"> into one global map, in document
  // order, as each is parsed — grown via mergeImportMapResolutions
  // (earlier-key-wins) each time visit() reaches one, never replaced.
  let activeImportMap: ImportMapResolution | undefined;
  // Every module specifier an EARLIER classic/module/handler block already
  // resolved (see lockedModuleSpecifierKeys) — grown as each block is
  // collected, consulted by mergeImportMapResolutions so a LATER import map
  // can't retroactively remap a specifier a real browser already locked in.
  let lockedSpecifierKeys = new Set<string>();
  const nestedReferences: BrowserTextReference[] = [];
  const cspPolicyContents: string[] = [];
  const formIds = collectFormIds(document);
  // Grows as visit() encounters each <meta> CSP in DOCUMENT order — a real
  // browser only starts enforcing a policy once it's actually parsed a
  // meta tag declaring it, so a reference collected BEFORE that point
  // (e.g. <script src="early.js"></script> ahead of the policy that would
  // otherwise block script-src) was already requested and must not be
  // retroactively removed. Markup references (attributeReferences,
  // nestedReferences) are filtered AT PUSH TIME against this running
  // state below. CSS/JS TEXT content is collected as raw strings during
  // the walk and only turned into references AFTER it finishes — applying
  // per-block document-order precision there would mean tracking a
  // snapshot per <style>/<script> block instead of one joined string per
  // kind; the far more common case in practice (a page with a meta CSP
  // has it in <head>, before any meaningful inline block) is captured by
  // applying the FINAL state to all of those collectively.
  let blockedSoFar: ReadonlySet<CspClass> = new Set();
  // A SEPARATE running snapshot of the RAW policy strings collected so far
  // in document order, for isInlineBlockPermitted's own per-block nonce/
  // hash matching — 'self' blocks inline execution but does NOT make
  // blockedSoFar's external-resource check treat the class as blocked, so
  // gating inline collection on blockedSoFar alone missed this class of
  // block entirely, and a class-wide flag can't tell one script's nonce
  // from another's.
  let cspPolicyContentsSoFar: readonly string[] = [];
  const pushAttributeReference = (reference: BrowserTextReference): void => {
    if (reference.cspClass && blockedSoFar.has(reference.cspClass)) return;
    attributeReferences.push(reference);
  };
  const pushNestedReference = (reference: BrowserTextReference): void => {
    if (reference.cspClass && blockedSoFar.has(reference.cspClass)) return;
    nestedReferences.push(reference);
  };

  const visit = (node: Html5Node, parentTagName?: string, insideForm = false): void => {
    if (isHtml5Element(node)) {
      const tagName = node.tagName;
      const attrs = new Map(node.attrs.map((attribute) => [attribute.name, attribute.value]));
      // A <script>/<style>'s own URL attributes (src, ...) still count — this
      // runs for every element, script and style included — but their raw
      // text content is code or CSS, never markup, so it's collected
      // separately below and neither recurses into its (raw-text) children.
      const styleAttribute = attrs.get("style");
      // A block CSP blocks from EXECUTING/APPLYING at all never runs, so
      // scanning its text for dependencies is wrong regardless of what
      // class those dependencies would themselves carry — script-src
      // 'none' blocking a <script> means a fetch() inside it never fires,
      // even though connect-src (the fetch's OWN class) might allow it.
      // A style="" attribute is never itself an element with a nonce of
      // its own (isAttribute: true, nonce: undefined) — only 'unsafe-
      // inline', or a hash of its OWN value alongside 'unsafe-hashes',
      // can permit it.
      if (styleAttribute && isInlineBlockPermitted(cspPolicyContentsSoFar, "style", undefined, styleAttribute, true)) {
        deferredTexts.push({ kind: "css", text: styleAttribute, blocked: blockedSoFar });
      }
      for (const attribute of node.attrs) {
        // Inline on* handlers hold real JS the browser executes, same as a
        // <script> body — parse5 already decoded any entity in the value —
        // but they compile with function-body grammar, so they're parsed
        // separately (jsReferencesFromEventHandler), not joined into jsTexts.
        if (
          /^on[a-z]+$/i.test(attribute.name) &&
          isInlineBlockPermitted(cspPolicyContentsSoFar, "script", undefined, attribute.value, true)
        ) {
          // A handler compiles as a function BODY (jsReferencesFromEventHandler
          // wraps it the same way before parsing) — a bare `return`, valid
          // only inside a function, would otherwise fail to parse here.
          for (const key of lockedModuleSpecifierKeys(
            `function __dohc_handler__(event) {\n${attribute.value}\n}`,
            "classic",
            documentPath,
            documentBase,
            artifactRoot,
            activeImportMap,
          )) {
            lockedSpecifierKeys.add(key);
          }
          deferredTexts.push({ kind: "handler", text: attribute.value, blocked: blockedSoFar, importMap: activeImportMap });
        }
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
            pushNestedReference({
              ...reference,
              value: `/${artifactRelative}`,
              documentRelative: false,
              // The srcdoc's OWN CSP state — not the embedding document's
              // — governs anything THIS reference's own target points to.
              blockedCspClasses: nestedResult.blockedCspClasses,
            });
          }
        }
      }
      if (tagName === "meta" && attrs.get("http-equiv")?.toLowerCase() === "refresh") {
        const refreshTarget = metaRefreshTarget(attrs.get("content") ?? "");
        // A meta-refresh is a real NAVIGATION — the browser loads the
        // target as a full document, the same as following an <a href>,
        // not merely fetching its bytes. Without documentDestination, the
        // queue treats it as an opaque leaf asset instead of parsing it
        // for its OWN stylesheets/scripts/images, so a refreshed page's
        // dependencies never make it into the share manifest.
        if (refreshTarget) {
          pushAttributeReference({ value: refreshTarget, documentRelative: true, documentDestination: true });
        }
      }
      if (tagName === "meta" && attrs.get("http-equiv")?.toLowerCase() === "content-security-policy") {
        const policyContent = attrs.get("content");
        if (policyContent) {
          cspPolicyContents.push(policyContent);
          // Takes effect from THIS point in document order onward — grows
          // the running state rather than replacing it, the same
          // union-of-all-policies reasoning blockedCspClasses itself uses.
          blockedSoFar = new Set([...blockedSoFar, ...blockedCspClasses([policyContent])]);
          cspPolicyContentsSoFar = [...cspPolicyContentsSoFar, policyContent];
        }
      }
      // Trimmed the same way isExecutableScriptType's own "module" keyword
      // check is — `type=" module "` is still the exact module keyword to
      // a real browser (only an ADDITIONAL, non-whitespace suffix like
      // "module;foo" makes it a data block instead). Without the trim
      // here, a module script's own src (or inline body) still gets
      // pushed as executable, but with the WRONG grammar attached —
      // classic instead of module — so a real static import/export in it
      // fails to parse as a syntax error and its dependencies are
      // silently dropped from the shared artifact.
      const scriptKind: ScriptKind = attrs.get("type")?.trim().toLowerCase() === "module" ? "module" : "classic";
      for (const attribute of node.attrs) {
        const attributeName = attribute.name;
        if (!URL_ATTRIBUTE_ELEMENTS[attributeName]?.has(tagName)) continue;
        if (attributeName === "src" && tagName === "input" && !isImageInputElement(attrs)) continue;
        if (
          attributeName === "formaction" &&
          !(
            isSubmitControlElement(tagName, attrs) &&
            (insideForm || (attrs.get("form") !== undefined && formIds.has(attrs.get("form")!)))
          )
        ) continue;
        // <source src> only fires a request inside <audio>/<video> — a
        // <picture><source> uses srcset instead (src there is inert), and a
        // detached/otherwise-parented <source> performs no request at all.
        if (
          attributeName === "src" &&
          tagName === "source" &&
          parentTagName !== "audio" &&
          parentTagName !== "video"
        ) continue;
        // The complementary case: <source srcset> only has meaning under
        // <picture> — an <audio>/<video> child's srcset is inert, the same
        // way its OWN src is inert under <picture>.
        if (attributeName === "srcset" && tagName === "source" && parentTagName !== "picture") continue;
        // With `srcdoc` present, the browser never fetches an iframe's own
        // `src` at all — srcdoc wins outright, it isn't a fallback.
        if (attributeName === "src" && tagName === "iframe" && srcdoc !== undefined) continue;
        // A data-block script (a non-JS type, e.g. type="application/json")
        // is never fetched — src only fires a request for a classic or
        // module script.
        if (attributeName === "src" && tagName === "script" && !isExecutableScriptType(attrs)) continue;
        // Electron's Chromium always supports module scripts, so a classic
        // script marked nomodule is skipped — never fetched.
        if (
          attributeName === "src" &&
          tagName === "script" &&
          attrs.has("nomodule") &&
          scriptKind === "classic"
        ) continue;
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
        // A <link rel="stylesheet"> href is the one LINK_REL_RESOURCE_TOKENS
        // case the browser actually parses and applies as CSS — icon,
        // manifest, prefetch, and modulepreload targets are all just fetched.
        const isStylesheet =
          attributeName === "href" && tagName === "link" && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet");
        // <object data>/<embed src>/<iframe src> load their target AS A
        // NESTED DOCUMENT (a plugin/browsing context), and <a href>/
        // <area href> NAVIGATE the browser there — an SVG or HTML page
        // reached either way is itself parsed for its own references, the
        // same way a real browser resolves them once it's the active
        // document. <img src>/CSS url() never do this. A form's own
        // action (or a submit control's formaction override) is ALSO a
        // real navigation — the browser loads and parses whatever page
        // the submission response is, GET or POST alike — so a local
        // target page's own scripts/styles/images belong in the manifest
        // the same way an <a href> target's do, not as an opaque asset.
        const isDocumentDestination =
          (attributeName === "data" && tagName === "object") ||
          (attributeName === "src" && (tagName === "embed" || tagName === "iframe")) ||
          (attributeName === "href" && (tagName === "a" || tagName === "area")) ||
          (attributeName === "action" && tagName === "form") ||
          (attributeName === "formaction" && (tagName === "button" || tagName === "input"));
        // The bounded CSP classes (see blockedCspClasses): icon-family
        // rel tokens, <img>/<video poster>/image-input src, and SVG
        // <image>/<use> href are all img-src; everything else this
        // attribute loop reaches is either already classified above
        // (script/style) or outside the bounded set (left unclassified,
        // never CSP-filtered).
        const isIconLink =
          attributeName === "href" &&
          tagName === "link" &&
          ICON_LINK_REL_TOKENS.some((token) => (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes(token));
        // A validated rel="preload" as="..." destination carries its OWN
        // CSP class the same way a real request from that destination
        // would — isResourceConsumingLinkRel already proved `as` names a
        // real destination before this reference is even reached.
        const preloadCspClass: CspClass | undefined =
          attributeName === "href" && tagName === "link" && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("preload")
            ? PRELOAD_AS_DESTINATION_CSP_CLASS[(attrs.get("as") ?? "").trim().toLowerCase()]
            : undefined;
        const cspClass: CspClass | undefined =
          (attributeName === "src" && tagName === "script") || isModulePreload
            ? "script"
            : isStylesheet
              ? "style"
              : isIconLink ||
                  (attributeName === "src" && tagName === "img") ||
                  (attributeName === "poster" && tagName === "video") ||
                  (attributeName === "src" && tagName === "input") ||
                  (attributeName === "href" && (tagName === "image" || tagName === "use"))
                ? "img"
                : preloadCspClass;
        if (attributeName !== "srcset") {
          pushAttributeReference({
            value: attribute.value,
            documentRelative: true,
            isManifest,
            appliesAsStylesheet: isStylesheet,
            documentDestination: isDocumentDestination,
            cspClass,
            ...(attributeName === "src" && tagName === "script" ? { scriptKind, importMap: activeImportMap } : {}),
            ...(isModulePreload ? { scriptKind: "module" as const, importMap: activeImportMap } : {}),
          });
          continue;
        }
        for (const srcsetValue of referencesFromSrcset(attribute.value)) {
          // srcset only fires on <img>/<source> (URL_ATTRIBUTE_ELEMENTS),
          // and a <source srcset> reaching here already passed the
          // <picture>-parent guard above — every candidate is img-src.
          pushAttributeReference({ value: srcsetValue, documentRelative: true, cspClass: "img" });
        }
      }
      if (tagName === "script") {
        if (attrs.get("type")?.toLowerCase() === "importmap") {
          // Merges into whatever's active so far — see
          // mergeImportMapResolutions — and takes effect (for the merged
          // keys a strictly EARLIER map hadn't already claimed, and that
          // lockedSpecifierKeys doesn't already lock) from THIS point in
          // document order onward. Routed through the merge even for the
          // very FIRST map — a module reached before ANY import map still
          // locks its own natural resolution against this one too.
          const rawImportMap = parseImportMap(html5TextContent(node));
          if (rawImportMap) {
            const resolved = resolveImportMapAddresses(rawImportMap, documentPath, documentBase, artifactRoot);
            activeImportMap = mergeImportMapResolutions(
              activeImportMap ?? { imports: new Map(), urlLikeImports: new Map(), externalUrlLikeKeys: new Set(), scopes: new Map() },
              resolved,
              lockedSpecifierKeys,
            );
          }
        } else if (
          isExecutableScriptElement(attrs) &&
          // Electron's Chromium always supports module scripts, so a
          // classic script marked nomodule is SKIPPED — never fetched or
          // executed — the same way an unsupported browser would be
          // expected to run it instead. A type="module" script ignores
          // nomodule per spec (nonsensical combination either way).
          !(attrs.has("nomodule") && scriptKind === "classic")
        ) {
          const scriptText = html5TextContent(node);
          // isAttribute: false — a <script> element carries its OWN nonce
          // attribute, unlike a style=""/on* attribute.
          if (isInlineBlockPermitted(cspPolicyContentsSoFar, "script", attrs.get("nonce"), scriptText, false)) {
            for (const key of lockedModuleSpecifierKeys(
              scriptText,
              scriptKind,
              documentPath,
              documentBase,
              artifactRoot,
              activeImportMap,
            )) {
              lockedSpecifierKeys.add(key);
            }
            deferredTexts.push({
              kind: scriptKind === "module" ? "moduleJs" : "classicJs",
              text: scriptText,
              blocked: blockedSoFar,
              importMap: activeImportMap,
            });
          }
        }
        return;
      }
      if (tagName === "style") {
        const styleText = html5TextContent(node);
        if (isInlineBlockPermitted(cspPolicyContentsSoFar, "style", attrs.get("nonce"), styleText, false)) {
          deferredTexts.push({ kind: "css", text: styleText, blocked: blockedSoFar });
        }
        return;
      }
    }
    const childParentTagName = isHtml5Element(node) ? node.tagName : parentTagName;
    const childInsideForm = insideForm || (isHtml5Element(node) && node.tagName === "form");
    for (const child of html5ChildNodes(node)) visit(child, childParentTagName, childInsideForm);
  };
  visit(document);

  // A resource a document's own declared CSP rules out entirely is one a
  // real browser never requests — approving it into the share manifest
  // anyway would disclose a file the policy excludes. Every source below
  // (attributeReferences/nestedReferences via pushAttributeReference/
  // pushNestedReference, and each css/js/handler BLOCK's own captured
  // `blocked` snapshot) is filtered against the CSP state that was
  // actually in effect at the moment IT was collected — a reference or
  // block reached before a later meta CSP stays approved, matching
  // document order; blockedClasses (the FINAL, whole-document state) is
  // used only as what this document hands FORWARD to files it references.
  const blockedClasses = blockedCspClasses(cspPolicyContents);
  const filterByBlock = <T extends BrowserTextReference>(refs: T[], blocked: ReadonlySet<CspClass>): T[] =>
    blocked.size === 0 ? refs : refs.filter((reference) => !reference.cspClass || !blocked.has(reference.cspClass));
  // Each <script> element parses on its OWN — the same way a browser runs
  // each script tag independently — so a syntax error in one script never
  // discards a later, syntactically valid script's own references. Each
  // block resolves bare specifiers against the import map that was ACTIVE
  // when Chromium reached it, not the document's final one — a module graph
  // that started before a later <script type="importmap"> never sees that
  // map.
  const deferredReferences = deferredTexts.flatMap((entry) => {
    const refs =
      entry.kind === "css"
        ? cssReferences(entry.text)
        : entry.kind === "handler"
          ? jsReferencesFromEventHandler(
              entry.text,
              context,
              documentPath,
              documentBase,
              artifactRoot,
              entry.importMap,
            )
          : jsReferencesFromCode(
              entry.text,
              entry.kind === "moduleJs" ? "module" : "classic",
              context,
              documentPath,
              documentBase,
              artifactRoot,
              entry.importMap,
            );
    return filterByBlock(refs, entry.blocked);
  });
  const references = [...attributeReferences, ...nestedReferences, ...deferredReferences];
  return { references, importMap: activeImportMap, blockedCspClasses: blockedClasses };
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
  appliesAsStylesheet: boolean,
): BrowserTextReference[] {
  // A file reached through a <link rel="manifest"> is a web app manifest to
  // the browser regardless of its own extension — a plain "manifest.json"
  // is as real a manifest as a ".webmanifest" file.
  if (isManifest || /\.webmanifest$/i.test(sourcePath)) {
    // A web app manifest's URLs (icons, start_url, ...) resolve relative to
    // the MANIFEST file itself, not the document that links it — the same
    // rule CSS's url()/@import already follow. Not document-relative.
    return referencesFromWebManifest(text).map(({ value, documentDestination }) => ({
      value,
      documentRelative: false,
      documentDestination,
    }));
  }
  if (/\.css$/i.test(sourcePath)) {
    // Bytes the browser only ever FETCHES (fetch(), an asset-style URL
    // attribute pointing at a ".css" path) are never applied as a
    // stylesheet, so the browser never reads its url()/@import text either
    // — the file still shares as an asset, it just contributes no further
    // references, the same reasoning executesAsCode applies to JS below.
    return appliesAsStylesheet ? cssReferences(text) : [];
  }
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
  // The mode a specific tab is actually previewing right now — a user's
  // stored per-tab choice, or the renderer's own automatic pick, both of
  // which main.ts otherwise has no visibility into. Falls back to the
  // dohc.json pin (site.configuredPreviewMode) when not given, e.g. for
  // listSitePackages' batch computation, which has no single "current tab"
  // to ask.
  effectiveMode?: SitePackageInfo["configuredPreviewMode"],
): Promise<SiteShareManifestResult> {
  // Share-what-you-previewed: a site actually being previewed as static —
  // whether pinned by dohc.json or chosen for THIS tab — must select the
  // SAME artifact the static preview serves — the site's own configured
  // entry — not a build output left over from an earlier build. Only when
  // the effective mode isn't "static" does a present build output take
  // priority (Build-mode preview/share). The shared-view rule in
  // staticPreviewTargetForSite (a recipient always gets a present build
  // output) is a separate concern for the RECEIVING side and is unaffected.
  const mode = effectiveMode ?? site.configuredPreviewMode;
  const preferConfiguredStaticEntry = mode === "static";
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
    // ONE structural serialization of every map together, not delimiter-
    // joined text — `=`, `,`, and `|` are all legal in a resolved path or
    // import-map key, so two DIFFERENT maps (e.g. one entry "a=/b,c=/d" vs.
    // two entries "a"->"/b" and "c"->"/d") could otherwise fingerprint
    // identically and collide in the scan key, silently dropping the
    // second document's own scan. A single JSON.stringify call over
    // everything sorted has no delimiter of its own to collide on.
    const sortedEntries = (map: ReadonlyMap<string, string>) =>
      [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const specifierMapKey = (map: ResolvedSpecifierMap) => [
      sortedEntries(map.imports),
      sortedEntries(map.urlLikeImports),
      [...map.externalUrlLikeKeys].sort(),
    ];
    // scopes change module resolution exactly as much as the top-level
    // maps do — two documents with identical top-level maps but different
    // scoped mappings must not fingerprint identically, or the second
    // document's own scan gets deduped away.
    const sortedScopes = [...importMap.scopes]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([scopeKey, scope]) => [scopeKey, specifierMapKey(scope)]);
    return JSON.stringify([specifierMapKey(importMap), sortedScopes]);
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
    // Whether the browser APPLIES this target as a stylesheet (a <link
    // rel="stylesheet"> href, or a nested @import reached from an already-
    // applied stylesheet) as opposed to only fetching its bytes (fetch(),
    // or an asset-style URL attribute that happens to point at a ".css"
    // path). Same reasoning, and same dedupe-key role, as executesAsCode.
    appliesAsStylesheet: boolean;
    isManifest: boolean;
    // Whether this target was reached as a NESTED DOCUMENT (<object data>,
    // <embed src>, <iframe src>) rather than an image-like or fetch-only
    // reference. Lets an SVG target through the extension gate below and
    // into the html document scan path so its own <image>/<use> references
    // resolve — the same way a real browser only processes an SVG's
    // internal references when it loads the SVG as a document.
    documentDestination: boolean;
    importMap: ImportMapResolution | undefined;
    // The referring document's OWN final set of blocked CSP classes,
    // inherited by whatever it references — an external stylesheet/script
    // is requested (and, if it in turn references further files, THOSE
    // are too) under the referring document's policy, not the empty
    // policy this field would default to if it weren't carried forward.
    blockedCspClasses: ReadonlySet<CspClass>;
  }> = [
    {
      path: entryPath,
      documentBase: { kind: "none" },
      context: "document",
      scriptKind: "classic",
      executesAsCode: true,
      appliesAsStylesheet: true,
      isManifest: false,
      // The entry path IS the document the preview loads — the same
      // status object/embed/iframe/anchor targets get once reached.
      documentDestination: true,
      importMap: undefined,
      blockedCspClasses: new Set(),
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
      appliesAsStylesheet,
      isManifest,
      documentDestination,
      importMap: inheritedImportMap,
      blockedCspClasses: inheritedBlockedCspClasses,
    } = queue.shift()!;
    // Two same-directory documents reaching the SAME external file under
    // DIFFERENT CSPs (one blocking a class the other allows) need two
    // independent scans — the same reasoning importMapKey/scriptKind/etc.
    // already carry, extended to CSP state.
    const blockedCspClassesKeyPart = [...inheritedBlockedCspClasses].sort().join(",");
    const scanKey = `${current}::${documentBaseKey(inheritedDocumentBase)}::${context}::${scriptKind}::${executesAsCode}::${appliesAsStylesheet}::${isManifest}::${documentDestination}::${blockedCspClassesKeyPart}::${importMapKey(inheritedImportMap)}`;
    const isSvgDocument = documentDestination && /\.svg$/i.test(current);
    if (
      scanned.has(scanKey) ||
      (!isManifest && !isSvgDocument && !/\.(?:html?|css|js|mjs|webmanifest)$/i.test(current))
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
      // parse5's HTML5 parser already handles SVG foreign content (an
      // <svg> root, self-closing <image>/<use> tags, xlink:href
      // normalized to a plain href) correctly — reuse the SAME document
      // scan path for an SVG reached as a document destination instead of
      // writing a second, separate XML extractor for it.
      // A .html/.htm target reached ONLY as bytes (fetch(), an asset-style
      // attribute) is never parsed or rendered by a real browser as a
      // document — same reasoning as isSvgDocument above, applied to HTML.
      const isHtmlDocument = documentDestination && /\.html?$/i.test(current);
      const isHtmlFile = isHtmlDocument || isSvgDocument;
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
      const documentImportMap = htmlResult ? htmlResult.importMap : inheritedImportMap;
      const documentBlockedCspClasses = htmlResult ? htmlResult.blockedCspClasses : inheritedBlockedCspClasses;
      const references = htmlResult
        ? // Already filtered internally against ITS OWN document-order CSP
          // state (see htmlReferencesFromDocument) — filtering it again
          // here, against the whole-document state, would retroactively
          // remove a reference collected before its own blocking meta tag.
          htmlResult.references
        : (() => {
            const nonHtmlReferences = referencesFromNonHtmlFile(
              text,
              current,
              scriptKind,
              context,
              base,
              artifactRoot,
              executesAsCode,
              isManifest,
              inheritedImportMap,
              appliesAsStylesheet,
            );
            // A .css/.js file has no CSP of its own to declare — it's
            // requested (and its own further references are too) under
            // the referring document's policy, inherited via the queue.
            return documentBlockedCspClasses.size === 0
              ? nonHtmlReferences
              : nonHtmlReferences.filter(
                  (reference) => !reference.cspClass || !documentBlockedCspClasses.has(reference.cspClass),
                );
          })();
      for (const reference of references) {
        const referenceBase = reference.documentRelative ? documentBase : base;
        const target = resolveExistingReference(
          reference.value,
          current,
          artifactRoot,
          available,
          referenceBase,
        );
        if (target) {
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
            appliesAsStylesheet: reference.appliesAsStylesheet === true,
            isManifest: reference.isManifest ?? false,
            documentDestination: reference.documentDestination === true,
            // A reference that resolves as code (scriptKind set — an
            // external <script src>/modulepreload, a Worker/importScripts
            // target, or a module specifier jsReferencesFromCode already
            // resolved) carries its OWN importMap, captured at push time to
            // whatever was active in document order right then — undefined
            // there is a deliberate "no map was active yet", not "unknown",
            // so it must NOT fall back to the document's final resolved
            // map. Every other reference kind never resolves anything
            // against an import map downstream, so documentImportMap (an
            // unused value for those) keeps prior behavior for them.
            importMap: reference.scriptKind !== undefined ? reference.importMap : documentImportMap,
            // A Worker/SharedWorker/service worker has its own policy
            // context, entirely separate from the document that created
            // it — the creator's own CSP does not apply to what the
            // worker itself fetches, so it must not carry forward (this
            // wins outright, ahead of the srcdoc case below). A reference
            // sourced from a srcdoc's OWN scan (reference.blockedCspClasses,
            // set only there) carries THAT document's policy instead of
            // the embedding document's own — every other reference kind
            // falls back to documentBlockedCspClasses, unchanged from
            // before this field existed.
            blockedCspClasses: reference.entersOwnContext
              ? new Set()
              : (reference.blockedCspClasses ?? documentBlockedCspClasses),
          });
        }
      }
    } catch {
      return { ok: false, reason: "unreadable", path: current };
    }
  }

  // `approved` is seeded with entryPath (a confirmed non-null string, per the
  // guard above) and only ever grows from there, so it can never be empty.
  const files = [...approved].sort((a, b) => a.localeCompare(b));
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

/** Files the owner listing permits the static server to expose. */
export function staticPreviewOwnerFiles(
  site: SitePackageInfo,
  target: ReturnType<typeof staticPreviewTargetForSite>,
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const workspacePath of site.sourceFiles) {
    const servedPath = pathRelativeToArtifact(target.root, workspacePath);
    if (servedPath) files.set(servedPath, workspacePath);
  }
  return files;
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

export async function listSitePackages(
  rootPath: string,
  ownedListing?: ListWorkspaceFilesResult,
): Promise<SitePackageInfo[]> {
  const listed = ownedListing ?? (await listFiles(rootPath));
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
  // See shareManifestForSite: overrides the matched site's own
  // shareManifest to select the artifact THIS specific request's caller
  // is actually previewing, instead of listSitePackages' batch
  // (dohc.json-pin-only) computation. Scoped to just the one matched
  // site — listSitePackages' own batch result for every OTHER site, and
  // for callers that pass no mode, is unaffected.
  effectiveMode?: SitePackageInfo["configuredPreviewMode"],
): Promise<SitePackageInfo | null> {
  const sites = knownSites ?? await listSitePackages(rootPath);
  const matched =
    sites
      .filter((site) => anyPath === site.root || isUnder(site.root, anyPath))
      .sort((a, b) => b.root.length - a.root.length)[0] ?? null;
  if (!matched || effectiveMode === undefined) return matched;
  const { shareManifest: _staleShareManifest, ...packageInfo } = matched;
  return { ...matched, shareManifest: await shareManifestForSite(rootPath, packageInfo, effectiveMode) };
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
  return joinSitePath(site.root, output);
}
