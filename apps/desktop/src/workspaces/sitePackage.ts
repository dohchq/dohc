import {
  discoverSites,
  parseDohcSiteConfig,
  type SitePackageManager,
  type SiteScripts,
  type WorkspaceSite,
  type WorkspaceSiteSource,
} from "@dohc/workspace-core";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
import { listFiles } from "./workspaceFiles";

export interface SiteDiagnostic {
  path?: string;
  severity: "warning" | "error";
  code: string;
  message: string;
}

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
  diagnostics: SiteDiagnostic[];
}

function normalizeRoot(root: string): string {
  return root === "" ? "." : root;
}

function denormalizeRoot(root: string): string {
  return root === "." ? "" : root;
}

function joinSitePath(root: string, relativePath: string): string {
  const normalized = normalizeRoot(root);
  return normalized === "." ? relativePath : `${normalized}/${relativePath}`;
}

function isUnder(root: string, path: string): boolean {
  const normalized = normalizeRoot(root);
  if (normalized === ".") return !path.startsWith(".dohc/");
  return path === normalized || path.startsWith(`${normalized}/`);
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

function mapWorkspaceSite(
  site: WorkspaceSite,
  files: WorkspaceFileEntry[],
  configuredScripts: SiteScripts,
): SitePackageInfo {
  const root = normalizeRoot(site.root);
  const sourceFiles = files
    .map((file) => file.path)
    .filter((path) => isUnder(root, path))
    .sort();
  const entryPath = entryPathFor(root, site.entry);
  return {
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
  };
}

async function configuredScriptsForSite(rootPath: string, site: WorkspaceSite): Promise<SiteScripts> {
  if (!site.configPath || !site.configPath.endsWith("dohc.json")) return {};
  try {
    const parsed = parseDohcSiteConfig(
      await readFile(join(rootPath, site.configPath), "utf8"),
      site.configPath,
    );
    const scripts: SiteScripts = {};
    const preview = parsed.config?.preview;
    if (preview?.command) {
      if (preview.mode === "build") scripts.preview = preview.command;
      else if (preview.mode === "static") scripts.preview = preview.command;
      else scripts.dev = preview.command;
    }
    if (parsed.config?.build?.command) scripts.build = parsed.config.build.command;
    return scripts;
  } catch {
    return {};
  }
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
  rootPathOrFiles: string | WorkspaceFileEntry[],
  folders: string[] = [],
): Promise<string[]> | string[] {
  if (Array.isArray(rootPathOrFiles)) {
    const folderSignals = folders
      .filter((folder) => ["dist", "build", "out"].includes(posix.basename(folder)))
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
    .filter((folder) => ["dist", "build", "out"].includes(posix.basename(folder)))
    .map((folder) => `${folder}/index.html`);
  const sites = discoverSites([...sources, ...folderSignals]);
  const mapped = await Promise.all(
    sites.map(async (site) =>
      mapWorkspaceSite(site, listed.files, await configuredScriptsForSite(rootPath, site)),
    ),
  );
  return mapped.sort((a, b) => a.root.localeCompare(b.root));
}

export async function getSitePackage(
  rootPath: string,
  anyPath: string,
): Promise<SitePackageInfo | null> {
  const root = denormalizeRoot(anyPath);
  const sites = await listSitePackages(rootPath);
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
