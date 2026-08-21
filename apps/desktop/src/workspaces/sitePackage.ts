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

function localReferenceCandidates(
  rawReference: string,
  fromPath: string,
  artifactRoot: string,
  available: ReadonlySet<string>,
  base: HtmlBaseResolution = { kind: "none" },
): string[] {
  const raw = rawReference.trim().split(/[?#]/, 1)[0]?.trim() ?? "";
  if (
    !raw ||
    raw.startsWith("#") ||
    raw.startsWith("//") ||
    /^(?:data|https?|javascript|mailto|tel):/i.test(raw)
  ) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return [];
  }
  const artifactBase = artifactRoot === "." ? "" : artifactRoot;
  if (base.kind === "external") return [];
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
  ) return [];
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
// fragment per the HTML spec) — its own `.childNodes` is always empty.
function html5ChildNodes(node: Html5Node): Html5Node[] {
  return node.content ? node.content.childNodes : (node.childNodes ?? []);
}

function html5TextContent(node: Html5Node): string {
  return html5ChildNodes(node)
    .filter((child) => child.nodeName === "#text")
    .map((child) => child.value ?? "")
    .join("");
}

const JS_SCRIPT_TYPE_PATTERN =
  /^(?:text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript|text\/x-javascript|text\/x-ecmascript|module)$/i;

/**
 * A `<script>` with its own `src` never executes its body — the browser
 * fetches and runs the external file instead, and the body (sometimes a
 * fallback/polyfill payload) is inert. A non-JavaScript `type`
 * (`application/json`, `text/template`, ...) means the body is data, not
 * code a browser ever executes. A missing type, `module`, and the classic JS
 * MIME types are all executable.
 */
function isExecutableScriptElement(attrs: ReadonlyMap<string, string>): boolean {
  if (attrs.has("src")) return false;
  const type = attrs.get("type");
  return !type || JS_SCRIPT_TYPE_PATTERN.test(type);
}

/** `<input src="...">` only fetches an image when it renders as one. */
function isImageInputElement(attrs: ReadonlyMap<string, string>): boolean {
  return attrs.get("type")?.toLowerCase() === "image";
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
  href: new Set(["a", "link", "area"]),
  poster: new Set(["video"]),
  data: new Set(["object"]),
};

// A <link href> counts only when its `rel` names a token the browser
// actually fetches for — an alternate/canonical/author/search/etc. link
// never triggers a request the way a stylesheet or icon does. `rel` is a
// space-separated token list; preload/modulepreload only fetch when paired
// with `as` (it names WHAT is being preloaded, and without it the browser
// treats the link as inert).
const LINK_REL_RESOURCE_TOKENS = new Set([
  "stylesheet",
  "icon",
  "shortcut",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "manifest",
  "prefetch",
]);
const LINK_REL_PRELOAD_TOKENS = new Set(["preload", "modulepreload"]);

function isResourceConsumingLinkRel(relValue: string | undefined, hasAsAttribute: boolean): boolean {
  if (!relValue) return false;
  for (const token of relValue.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (LINK_REL_RESOURCE_TOKENS.has(token)) return true;
    if (LINK_REL_PRELOAD_TOKENS.has(token) && hasAsAttribute) return true;
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
): HtmlBaseResolution {
  // parse5 already decoded any HTML character reference in the href value —
  // only the URL-level percent-encoding below is still this function's job.
  const href = firstBaseHref(document);
  if (!href || href.startsWith("#")) return { kind: "none" };
  if (
    href.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)
  ) return { kind: "external" };
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
      : posix.join(posix.dirname(fromPath), decoded),
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
}

// CSS still isn't parsed with a real parser (out of this round's scope) —
// url()/@import stay pattern-matched, but only over text a browser's CSS
// parser would actually read: a real <style> element's content, a style=""
// attribute value, or an entire external .css file.
const CSS_URL_PATTERN =
  /url\(\s*(?:"([^"]{1,2048})"|'([^']{1,2048})'|([^"')\s][^)]{0,2047}))\s*\)/gi;
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?["']([^"']{1,2048})["']/gi;

function cssReferences(cssText: string): BrowserTextReference[] {
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
  if (!isAstNode(node) || node.type !== "Literal") return undefined;
  const value = node.value;
  return typeof value === "string" ? value : undefined;
}

/** `import.meta.url` — acorn represents `import.meta` as a MetaProperty. */
function isImportMetaUrl(node: unknown): boolean {
  if (!isAstNode(node) || node.type !== "MemberExpression") return false;
  const object = astChild(node, "object");
  const property = astChild(node, "property");
  if (!isAstNode(object) || object.type !== "MetaProperty") return false;
  return isAstNode(property) && property.type === "Identifier" && astString(property, "name") === "url";
}

/** Whether `node` is the identifier `name`, or a member expression ending in
 * `.name` — covers both `serviceWorker.register(...)` and
 * `navigator.serviceWorker.register(...)`. */
function endsWithProperty(node: unknown, name: string): boolean {
  if (!isAstNode(node)) return false;
  if (node.type === "Identifier") return astString(node, "name") === name;
  if (node.type === "MemberExpression") {
    const property = astChild(node, "property");
    return isAstNode(property) && property.type === "Identifier" && astString(property, "name") === name;
  }
  return false;
}

// Finding 3's stance: a property assignment (`X.src = lit`) or
// `X.setAttribute("src", lit)` only counts as a real browser-consumed
// reference when X is PROVABLY a DOM element — the result of
// document.createElement/querySelector/getElementById/body/head, or a
// variable assigned from one. An unprovable receiver (`el.src = lit` where
// `el` came from nowhere traceable, or any other object entirely) is
// excluded. For a share manifest, under-inclusion breaks a share visibly (a
// missing asset 404s in the open tab); over-inclusion discloses a file
// silently. Unprovable consumption stays out.
const DOM_PRODUCING_CALL_NAMES = new Set(["createElement", "querySelector", "getElementById"]);
const DOM_PRODUCING_MEMBER_NAMES = new Set(["body", "head"]);
const URL_RECEIVER_PROPERTIES = new Set(["src", "href", "poster"]);

function isDocumentReceiver(node: unknown): boolean {
  if (!isAstNode(node)) return false;
  if (node.type === "Identifier") return astString(node, "name") === "document";
  if (node.type === "MemberExpression") {
    const property = astChild(node, "property");
    return isAstNode(property) && property.type === "Identifier" && astString(property, "name") === "document";
  }
  return false;
}

function isDomProducingExpression(node: unknown, provenNames: ReadonlySet<string>): boolean {
  if (!isAstNode(node)) return false;
  if (node.type === "CallExpression") {
    const callee = astChild(node, "callee");
    if (!isAstNode(callee) || callee.type !== "MemberExpression") return false;
    const object = astChild(callee, "object");
    const property = astChild(callee, "property");
    return (
      isDocumentReceiver(object) &&
      isAstNode(property) &&
      property.type === "Identifier" &&
      DOM_PRODUCING_CALL_NAMES.has(astString(property, "name") ?? "")
    );
  }
  if (node.type === "MemberExpression") {
    const object = astChild(node, "object");
    const property = astChild(node, "property");
    return (
      isDocumentReceiver(object) &&
      isAstNode(property) &&
      property.type === "Identifier" &&
      DOM_PRODUCING_MEMBER_NAMES.has(astString(property, "name") ?? "")
    );
  }
  if (node.type === "Identifier") {
    return provenNames.has(astString(node, "name") ?? "");
  }
  return false;
}

/** Every identifier PROVABLY bound to a DOM-producing expression somewhere
 * in the file — a small fixed-point pass (not real lexical scoping) so a
 * chain like `const a = document.createElement("img"); const b = a;` still
 * resolves, without building a full scope resolver for a heuristic scanner. */
function collectDomProducingNames(program: AstNode): Set<string> {
  const names = new Set<string>();
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
      if (!name || names.has(name)) return;
      if (isDomProducingExpression(source, names)) {
        names.add(name);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return names;
}

// A worker script (reached via Worker/SharedWorker/serviceWorker.register)
// runs in its own global scope where importScripts exists; an ordinary
// document-linked script never has it. Finding 4: importScripts only counts
// in that context.
type JsScanContext = "document" | "worker";

function parseJavaScript(code: string): AstNode | null {
  const acornOptions = { ecmaVersion: "latest" as const };
  try {
    return acorn.parse(code, { ...acornOptions, sourceType: "module" }) as unknown as AstNode;
  } catch {
    try {
      return acorn.parse(code, { ...acornOptions, sourceType: "script" }) as unknown as AstNode;
    } catch {
      // Not parseable JS — scan nothing rather than guess. The old
      // regex-based scanner would still match patterns in garbage text; a
      // real parser correctly finds no code to have references at all.
      return null;
    }
  }
}

function jsReferencesFromCode(code: string, context: JsScanContext): BrowserTextReference[] {
  const program = parseJavaScript(code);
  if (!program) return [];
  const provenDomNames = collectDomProducingNames(program);
  const references: BrowserTextReference[] = [];
  const addReference = (value: string | undefined, documentRelative: boolean, entersOwnContext = false) => {
    const trimmed = value?.trim();
    if (trimmed) references.push({ value: trimmed, documentRelative, entersOwnContext });
  };

  walkAst(program, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        addReference(stringLiteralValue(astChild(node, "source")), false);
        break;
      }
      case "ImportExpression": {
        addReference(stringLiteralValue(astChild(node, "source")), false);
        break;
      }
      case "NewExpression": {
        const callee = astChild(node, "callee");
        const args = astChildren(node, "arguments");
        if (!isAstNode(callee) || callee.type !== "Identifier") break;
        const calleeName = astString(callee, "name");
        if (calleeName === "URL" && args.length >= 2) {
          const first = stringLiteralValue(args[0]);
          if (first && isImportMetaUrl(args[1])) addReference(first, false);
        } else if (calleeName === "Worker" || calleeName === "SharedWorker") {
          addReference(stringLiteralValue(args[0]), true, true);
        }
        break;
      }
      case "CallExpression": {
        const callee = astChild(node, "callee");
        const args = astChildren(node, "arguments");
        if (!isAstNode(callee)) break;
        if (callee.type === "Identifier") {
          const calleeName = astString(callee, "name");
          if (calleeName === "fetch") {
            addReference(stringLiteralValue(args[0]), true);
          } else if (calleeName === "importScripts" && context === "worker") {
            for (const argument of args) addReference(stringLiteralValue(argument), false);
          }
        } else if (callee.type === "MemberExpression") {
          const property = astChild(callee, "property");
          const object = astChild(callee, "object");
          const propertyName =
            isAstNode(property) && property.type === "Identifier" ? astString(property, "name") : undefined;
          if (propertyName === "register" && endsWithProperty(object, "serviceWorker")) {
            addReference(stringLiteralValue(args[0]), true);
          } else if (propertyName === "setAttribute" && args.length >= 2) {
            const attributeName = stringLiteralValue(args[0]);
            if (
              attributeName &&
              URL_RECEIVER_PROPERTIES.has(attributeName) &&
              isDomProducingExpression(object, provenDomNames)
            ) {
              addReference(stringLiteralValue(args[1]), true);
            }
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
        if (
          propertyName &&
          URL_RECEIVER_PROPERTIES.has(propertyName) &&
          isDomProducingExpression(object, provenDomNames)
        ) {
          addReference(stringLiteralValue(astChild(node, "right")), true);
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

function htmlReferencesFromDocument(document: Html5Node, context: JsScanContext): BrowserTextReference[] {
  const attributeReferences: BrowserTextReference[] = [];
  const cssTexts: string[] = [];
  const jsTexts: string[] = [];

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
        // <script> body — parse5 already decoded any entity in the value.
        if (/^on[a-z]+$/i.test(attribute.name)) jsTexts.push(attribute.value);
      }
      for (const attribute of node.attrs) {
        const attributeName = attribute.name;
        if (!URL_ATTRIBUTE_ELEMENTS[attributeName]?.has(tagName)) continue;
        if (attributeName === "src" && tagName === "input" && !isImageInputElement(attrs)) continue;
        if (
          attributeName === "href" &&
          tagName === "link" &&
          !isResourceConsumingLinkRel(attrs.get("rel"), attrs.has("as"))
        ) continue;
        if (attributeName !== "srcset") {
          attributeReferences.push({ value: attribute.value, documentRelative: true });
          continue;
        }
        for (const srcsetValue of referencesFromSrcset(attribute.value)) {
          attributeReferences.push({ value: srcsetValue, documentRelative: true });
        }
      }
      if (tagName === "script") {
        if (isExecutableScriptElement(attrs)) jsTexts.push(html5TextContent(node));
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

  return [
    ...attributeReferences,
    ...cssReferences(cssTexts.join("\n")),
    ...jsReferencesFromCode(jsTexts.join("\n"), context),
  ];
}

/** Every reference in a non-HTML file — HTML is scanned from its already-
 * parsed tree instead (htmlReferencesFromDocument), so shareManifestForSite
 * only parses each HTML document once. */
function referencesFromNonHtmlFile(
  text: string,
  sourcePath: string,
  context: JsScanContext,
): BrowserTextReference[] {
  if (/\.webmanifest$/i.test(sourcePath)) {
    // A web app manifest's URLs (icons, start_url, ...) resolve relative to
    // the MANIFEST file itself, not the document that links it — the same
    // rule CSS's url()/@import already follow. Not document-relative.
    return referencesFromWebManifest(text).map((value) => ({ value, documentRelative: false }));
  }
  if (/\.css$/i.test(sourcePath)) return cssReferences(text);
  if (/\.(?:js|mjs)$/i.test(sourcePath)) return jsReferencesFromCode(text, context);
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
  // Every file is scanned with its own referring document's base — an
  // external .js/.mjs file has no <base> of its own, but a reference the
  // browser resolves against the DOCUMENT's base (fetch, an assignment-
  // shaped src/href) must still use the document that linked it, including
  // that document's own <base href> (not a blanket artifact root). context
  // carries whether the file being scanned runs as an ordinary document
  // script or as a worker's own global scope (importScripts only exists,
  // and only counts, in the latter).
  const queue: Array<{ path: string; documentBase: HtmlBaseResolution; context: JsScanContext }> = [
    { path: entryPath, documentBase: { kind: "none" }, context: "document" },
  ];
  let scannedBytes = 0;
  while (queue.length > 0) {
    const { path: current, documentBase: inheritedDocumentBase, context } = queue.shift()!;
    const scanKey = `${current}::${documentBaseKey(inheritedDocumentBase)}::${context}`;
    if (scanned.has(scanKey) || !/\.(?:html?|css|js|mjs|webmanifest)$/i.test(current)) continue;
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
      const references = htmlDocument
        ? htmlReferencesFromDocument(htmlDocument, context)
        : referencesFromNonHtmlFile(text, current, context);
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
          queue.push({ path: target, documentBase: propagatedDocumentBase, context: propagatedContext });
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
  const packageInfo: Omit<SitePackageInfo, "shareManifest"> = {
    root,
    title: site.title,
    kind: site.kind,
    confidence: site.confidence,
    entryPath,
    configPath: site.configPath ?? null,
    packagePath,
    packageManager: site.packageManager ?? null,
    scripts: await packageScriptsForSite(rootPath, packagePath),
    configuredScripts,
    configuredPreviewMode: site.configuredPreviewMode ?? null,
    configuredBuildOutput: site.configuredBuildOutput ?? null,
    buildOutputs: site.buildOutputs,
    sourceFiles,
    diagnostics: site.diagnostics,
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

async function packageScriptsForSite(
  rootPath: string,
  packagePath: string | null,
): Promise<Record<string, string>> {
  if (!packagePath) return {};
  try {
    const body = await readBoundedMetadataFile(join(rootPath, packagePath));
    if (body === null) return {};
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
    const result: Record<string, string> = {};
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body === "string") result[name] = body;
    }
    return result;
  } catch {
    return {};
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
