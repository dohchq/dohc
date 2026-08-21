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
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
import {
  assertLoopbackOnlyDevServerCommand,
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

function blankPreservingLines(text: string): string {
  return text.replace(/[^\x0d\x0a]/g, " ");
}

function blankHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
    blankPreservingLines(comment),
  );
}

function blankHtmlRawTextContents(text: string): string {
  return text.replace(
    /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi,
    (_match, open: string, _tag: string, content: string, close: string) =>
      `${open}${blankPreservingLines(content)}${close}`,
  );
}

function openingHtmlTags(text: string): string[] {
  const tags: string[] = [];
  const start = /<[A-Za-z][A-Za-z0-9-]*\b/g;
  for (const match of text.matchAll(start)) {
    let quote: "\"" | "'" | null = null;
    let position = (match.index ?? 0) + match[0].length;
    for (; position < text.length; position += 1) {
      const character = text[position]!;
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === "\"" || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") {
        tags.push(text.slice(match.index, position + 1));
        break;
      }
    }
  }
  return tags;
}

function htmlBaseDirectory(
  text: string,
  fromPath: string,
  artifactRoot: string,
): HtmlBaseResolution {
  const baseTag = /<base\b[^>]*>/i.exec(
    blankHtmlRawTextContents(blankHtmlComments(text)),
  )?.[0];
  if (!baseTag) return { kind: "none" };
  const hrefMatch =
    /\bhref\s*=\s*(?:"([^"]{1,2048})"|'([^']{1,2048})'|([^\s"'=<>]{1,2048}))/i.exec(
      baseTag,
    );
  const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3])?.trim();
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
  // URL at runtime (fetch/Worker/SharedWorker/serviceWorker.register, and an
  // assignment-shaped src/href/poster). False for a reference ES modules
  // resolve against the SCRIPT's own module URL (import/export, dynamic
  // import, new URL(...,import.meta.url)) or CSS resolves against the
  // stylesheet's own location (url()/@import). An HTML file's own markup
  // (attributes, inline CSS, inline modules) already resolves uniformly
  // against that file's own <base>-aware directory regardless of this flag —
  // it only changes resolution for a reference read out of a separate
  // external .js/.mjs file, where the script's own location and the
  // document's location can genuinely differ.
  documentRelative: boolean;
}

function referencesFromBrowserText(text: string, sourcePath: string): BrowserTextReference[] {
  if (/\.webmanifest$/i.test(sourcePath)) {
    return referencesFromWebManifest(text).map((value) => ({ value, documentRelative: true }));
  }
  const references: BrowserTextReference[] = [];
  const isHtml = /\.html?$/i.test(sourcePath);
  const scanText = isHtml ? blankHtmlComments(text) : text;
  const attributeText = isHtml
    ? blankHtmlRawTextContents(scanText).replace(/<base\b[^>]*>/gi, "")
    : scanText;
  const htmlTags = isHtml ? openingHtmlTags(attributeText) : [];
  const addMatches = (input: string, pattern: RegExp, documentRelative: boolean) => {
    for (const match of input.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? match[3])?.trim();
      if (value) references.push({ value, documentRelative });
    }
  };

  if (isHtml) {
    const attribute = /\b(src|href|poster|data|srcset)\s*=\s*(?:"([^"]{1,2048})"|'([^']{1,2048})'|([^\s"'=<>`]{1,2048}))/gi;
    for (const tag of htmlTags) {
      for (const match of tag.matchAll(attribute)) {
        const value = (match[2] ?? match[3] ?? match[4])?.trim();
        if (!value) continue;
        if (match[1]?.toLowerCase() !== "srcset") {
          references.push({ value, documentRelative: true });
          continue;
        }
        for (const srcsetValue of referencesFromSrcset(value)) {
          references.push({ value: srcsetValue, documentRelative: true });
        }
      }
    }
  }

  if (/\.(?:html?|css)$/i.test(sourcePath)) {
    addMatches(scanText, /url\(\s*(?:"([^"]{1,2048})"|'([^']{1,2048})'|([^"')\s][^)]{0,2047}))\s*\)/gi, false);
    addMatches(scanText, /@import\s+(?:url\(\s*)?["']([^"']{1,2048})["']/gi, false);
  }

  if (/\.(?:html?|js|mjs)$/i.test(sourcePath)) {
    addMatches(scanText, /\b(?:import|export)\s+(?:[^"'`\r\n]{0,2048}?\s+from\s+)?["'`]([^"'`\r\n]{1,2048})["'`]/g, false);
    addMatches(scanText, /\bimport\s*\(\s*["'`]([^"'`\r\n]{1,2048})["'`]/g, false);
    addMatches(scanText, /\bnew\s+URL\(\s*["'`]([^"'`\r\n]{1,2048})["'`]\s*,\s*import\.meta\.url/g, false);
    addMatches(scanText, /\b(?:fetch|Worker|SharedWorker)\s*\(\s*["'`]([^"'`\r\n]{1,2048})["'`]/g, true);
    addMatches(scanText, /\bserviceWorker\.register\s*\(\s*["'`]([^"'`\r\n]{1,2048})["'`]/g, true);
    addMatches(isHtml ? htmlTags.join("\n") : scanText, /\b(?:src|href|poster)\s*=\s*["'`]([^"'`\r\n]{1,2048})["'`]/g, true);
  }
  return references;
}

async function shareManifestForSite(
  rootPath: string,
  site: Omit<SitePackageInfo, "shareManifest">,
): Promise<SiteShareManifestResult> {
  const output = presentBuildOutput(site);
  let artifactRoot: string | null = null;
  let entryPath: string | null = null;

  if (output) {
    artifactRoot = joinSitePath(site.root, output);
    entryPath = `${artifactRoot}/index.html`;
  } else if (!needsBuiltArtifact(site) && site.entryPath) {
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
        pathRelativeToArtifact(artifactRoot, path) !== null,
    ),
  );
  if (!available.has(entryPath)) {
    return { ok: false, reason: "no-runnable-artifact" };
  }

  const approved = new Set([entryPath]);
  const scanned = new Set<string>();
  const queue = [entryPath];
  let scannedBytes = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (scanned.has(current) || !/\.(?:html?|css|js|mjs|webmanifest)$/i.test(current)) continue;
    scanned.add(current);
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
      const base = isHtmlFile
        ? htmlBaseDirectory(text, current, artifactRoot)
        : { kind: "none" as const };
      // A separate .js/.mjs file has no <base> of its own, but a reference
      // the browser resolves against the DOCUMENT's base (fetch, Worker,
      // an assignment-shaped src/href) still needs the document's own
      // directory, not the script's — reuse the same local-base mechanism
      // an HTML file's own <base> tag already uses.
      const documentBase: HtmlBaseResolution = isHtmlFile
        ? base
        : { kind: "local", directory: artifactRoot };
      for (const reference of referencesFromBrowserText(text, current)) {
        const referenceBase = reference.documentRelative ? documentBase : base;
        for (const target of localReferenceCandidates(
          reference.value,
          current,
          artifactRoot,
          available,
          referenceBase,
        )) {
          approved.add(target);
          queue.push(target);
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

async function packageScriptsForSite(
  rootPath: string,
  packagePath: string | null,
): Promise<Record<string, string>> {
  if (!packagePath) return {};
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(rootPath, packagePath), "utf8"),
    );
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
    const parsed = parseDohcSiteConfig(
      await readFile(join(rootPath, site.configPath), "utf8"),
      site.configPath,
    );
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

async function sourceForFile(rootPath: string, path: string): Promise<string | WorkspaceSiteSource> {
  const name = posix.basename(path);
  if (name !== "package.json" && name !== "dohc.json") return path;
  try {
    return { path, body: await readFile(join(rootPath, path), "utf8") };
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
