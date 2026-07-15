import {
  discoverSites,
  hasIgnoredSegment,
  isSharedWithMePath,
  parseDohcSiteConfig,
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

export interface SitePackageInfo {
  root: string;
  title: string;
  kind: "static" | "package" | "configured";
  confidence: "high" | "medium" | "low";
  entryPath: string | null;
  configPath: string | null;
  packagePath: string | null;
  packageManager: SitePackageManager | null;
  scripts: SiteScripts;
  configuredScripts: SiteScripts;
  buildOutputs: string[];
  sourceFiles: string[];
  shareManifest: {
    entryPath: string;
    assets: string[];
  } | null;
  diagnostics: SiteDiagnostic[];
  authority:
    | { kind: "workspace" }
    | { kind: "share"; mountRoot: string };
}

function normalizeRoot(root: string): string {
  return root === "" ? "." : root;
}

function denormalizeRoot(root: string): string {
  return root === "." ? "" : root;
}

// Conventional web build output folders that can signal a built/static site
// even when discovery sees the folder before an index.html entry underneath it.
const BUILD_OUTPUT_FOLDER_NAMES = ["dist", "build", "out"];
const MAX_SHARE_MANIFEST_FILES = 100;
const MAX_SHARE_MANIFEST_SCAN_BYTES = 4 * 1024 * 1024;
const SHAREABLE_BROWSER_FILE_RE =
  /\.(?:css|gif|html?|ico|jpe?g|js|json|map|mjs|png|svg|ttf|txt|wasm|webp|woff2?)$/i;
const STATIC_ASSET_ROOTS = new Set([
  "assets",
  "css",
  "data",
  "fonts",
  "images",
  "img",
  "js",
  "media",
  "public",
  "scripts",
  "static",
  "styles",
  "vendor",
]);

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

/** A materialized build output that can be served without executing site code. */
export function builtOutputRelativeToSite(site: SitePackageInfo): string | null {
  for (const output of site.buildOutputs) {
    const relativeEntry = `${output}/index.html`;
    const workspaceEntry = joinSitePath(site.root, relativeEntry);
    if (site.sourceFiles.includes(workspaceEntry)) return output;
  }
  return null;
}

export function builtEntryRelativeToSite(site: SitePackageInfo): string | null {
  const output = builtOutputRelativeToSite(site);
  return output ? `${output}/index.html` : null;
}

function needsBuiltArtifact(site: SitePackageInfo): boolean {
  return Boolean(
    site.scripts.dev ||
    site.scripts.start ||
    site.scripts.build ||
    site.configuredScripts.dev ||
    site.configuredScripts.start ||
    site.configuredScripts.build ||
    site.configuredScripts.preview ||
    site.buildOutputs.length > 0
  );
}

function pathRelativeToSite(siteRoot: string, path: string): string | null {
  if (siteRoot === ".") return path;
  return path.startsWith(`${siteRoot}/`)
    ? path.slice(siteRoot.length + 1)
    : null;
}

function localReferenceCandidates(
  rawReference: string,
  fromPath: string,
  siteRoot: string,
  available: ReadonlySet<string>,
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
  const siteBase = siteRoot === "." ? "" : siteRoot;
  const candidate = posix.normalize(
    decoded.startsWith("/")
      ? posix.join(siteBase, decoded.replace(/^\/+/, ""))
      : posix.join(posix.dirname(fromPath), decoded),
  );
  if (!pathRelativeToSite(siteRoot, candidate) || hasIgnoredSegment(candidate)) return [];
  const variants = [
    candidate,
    `${candidate}.js`,
    `${candidate}.mjs`,
    posix.join(candidate, "index.js"),
    posix.join(candidate, "index.html"),
  ];
  return [...new Set(variants)].filter((path) => available.has(path));
}

function referencesFromBrowserText(text: string): string[] {
  const references: string[] = [];
  const quoted = /["'`]([^"'`\r\n]{1,2048})["'`]/g;
  for (const match of text.matchAll(quoted)) {
    const value = match[1]?.trim();
    if (!value) continue;
    references.push(value);
    for (const candidate of value.split(",")) {
      const srcsetPath = candidate.trim().split(/\s+/, 1)[0];
      if (srcsetPath && srcsetPath !== value) references.push(srcsetPath);
    }
  }
  const unquotedCssUrl = /url\(\s*([^"')\s][^)]{0,2047})\s*\)/gi;
  for (const match of text.matchAll(unquotedCssUrl)) {
    if (match[1]) references.push(match[1]);
  }
  return references;
}

async function shareManifestForSite(
  rootPath: string,
  site: Omit<SitePackageInfo, "shareManifest">,
): Promise<SitePackageInfo["shareManifest"]> {
  const output = builtOutputRelativeToSite({ ...site, shareManifest: null });
  let entryPath: string | null = null;
  let approvedFiles: string[] = [];

  if (output) {
    const outputRoot = joinSitePath(site.root, output);
    entryPath = `${outputRoot}/index.html`;
    approvedFiles = site.sourceFiles.filter(
      (path) =>
        path.startsWith(`${outputRoot}/`) &&
        !hasIgnoredSegment(path) &&
        SHAREABLE_BROWSER_FILE_RE.test(path),
    );
  } else if (!needsBuiltArtifact({ ...site, shareManifest: null }) && site.entryPath) {
    const entryRelative = pathRelativeToSite(site.root, site.entryPath);
    if (!entryRelative || !/\.html?$/i.test(entryRelative)) return null;
    entryPath = site.entryPath;
    approvedFiles = site.sourceFiles.filter((path) => {
      if (
        path === site.packagePath ||
        path === site.configPath ||
        hasIgnoredSegment(path) ||
        !SHAREABLE_BROWSER_FILE_RE.test(path)
      ) return false;
      const relative = pathRelativeToSite(site.root, path);
      if (!relative) return false;
      const parts = relative.split("/");
      return (
        path === entryPath ||
        STATIC_ASSET_ROOTS.has(parts[0]?.toLowerCase() ?? "")
      );
    });

    const available = new Set(
      site.sourceFiles.filter(
        (path) =>
          path !== site.packagePath &&
          path !== site.configPath &&
          !hasIgnoredSegment(path) &&
          SHAREABLE_BROWSER_FILE_RE.test(path) &&
          pathRelativeToSite(site.root, path) !== null,
      ),
    );
    const approved = new Set(approvedFiles);
    const queued = new Set<string>();
    const queue = [entryPath];
    let scannedBytes = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (queued.has(current) || !/\.(?:html?|css|js|mjs)$/i.test(current)) continue;
      queued.add(current);
      try {
        const info = await stat(join(rootPath, current));
        scannedBytes += info.size;
        if (!info.isFile() || scannedBytes > MAX_SHARE_MANIFEST_SCAN_BYTES) return null;
        const text = await readFile(join(rootPath, current), "utf8");
        for (const reference of referencesFromBrowserText(text)) {
          for (const target of localReferenceCandidates(
            reference,
            current,
            site.root,
            available,
          )) {
            approved.add(target);
            queue.push(target);
          }
        }
      } catch {
        return null;
      }
    }
    approvedFiles = [...approved];
  }

  if (!entryPath || !approvedFiles.includes(entryPath)) return null;
  const files = [...new Set(approvedFiles)].sort((a, b) => a.localeCompare(b));
  if (files.length === 0 || files.length > MAX_SHARE_MANIFEST_FILES) return null;
  return {
    entryPath,
    assets: files.filter((path) => path !== entryPath),
  };
}

/**
 * Shared package sites run only the browser artifact selected by their owner.
 * A source index.html from Vite/React/etc. is not a runnable static artifact.
 */
export function sharedStaticEntryRelativeToSite(site: SitePackageInfo): string | null {
  const built = builtEntryRelativeToSite(site);
  if (built) return built;
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
    const output = builtOutputRelativeToSite(site);
    if (output) return { root: buildOutputSiteRoot(site, output), entry: "index.html" };
    return { root: site.root, entry: sharedStaticEntryRelativeToSite(site) };
  }
  return { root: site.root, entry: entryRelativeToSite(site) };
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
  const packageInfo: Omit<SitePackageInfo, "shareManifest"> = {
    root,
    title: site.title,
    kind: site.kind,
    confidence: site.confidence,
    entryPath,
    configPath: site.configPath ?? null,
    packagePath: packagePathFor(root, sourceFiles),
    packageManager: site.packageManager ?? null,
    scripts: site.scripts,
    configuredScripts,
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
      const command = configuredServerCommand(preview.command, site.configPath);
      if (command) {
        if (preview.mode === "build" || preview.mode === "static") scripts.preview = command;
        else scripts.dev = command;
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

export function discoverSiteRoots(
  rootPathOrFiles: WorkspaceFileEntry[],
  folders?: string[],
): string[];
export function discoverSiteRoots(rootPathOrFiles: string): Promise<string[]>;
export function discoverSiteRoots(
  rootPathOrFiles: string | WorkspaceFileEntry[],
  folders: string[] = [],
): Promise<string[]> | string[] {
  if (Array.isArray(rootPathOrFiles)) {
    const folderSignals = folders
      .filter((folder) => BUILD_OUTPUT_FOLDER_NAMES.includes(posix.basename(folder)))
      .map((folder) => `${folder}/index.html`);
    return discoverSites([...rootPathOrFiles.map((file) => file.path), ...folderSignals]).map(
      (site) => normalizeRoot(site.root),
    );
  }
  return listSitePackages(rootPathOrFiles).then((sites) => sites.map((site) => site.root));
}

export async function listSitePackages(rootPath: string): Promise<SitePackageInfo[]> {
  const listed = await listFiles(rootPath);
  const sources = await Promise.all(listed.files.map((file) => sourceForFile(rootPath, file.path)));
  const folderSignals = listed.folders
    .filter((folder) => BUILD_OUTPUT_FOLDER_NAMES.includes(posix.basename(folder)))
    .map((folder) => `${folder}/index.html`);
  const sites = discoverSites([...sources, ...folderSignals]);
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

export function entryRelativeToSite(site: SitePackageInfo): string | null {
  if (!site.entryPath) return null;
  if (site.root === ".") return site.entryPath;
  return site.entryPath.startsWith(`${site.root}/`)
    ? site.entryPath.slice(site.root.length + 1)
    : null;
}

export function buildOutputSiteRoot(site: SitePackageInfo, output: string): string {
  return site.root === "." ? output : `${site.root}/${output}`;
}
