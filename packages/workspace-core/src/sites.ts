import { hasIgnoredSegment } from "./paths";

export type SiteKind = "static" | "package" | "configured";
export type SiteConfidence = "high" | "medium" | "low";
export type SitePackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface SiteScripts {
  dev?: string;
  start?: string;
  build?: string;
  preview?: string;
}

export interface SiteDiagnostic {
  path: string;
  severity: "warning" | "error";
  code: string;
  message: string;
}

export interface WorkspaceSite {
  root: string;
  title: string;
  kind: SiteKind;
  confidence: SiteConfidence;
  entry?: string;
  packageManager?: SitePackageManager;
  scripts: SiteScripts;
  buildOutputs: string[];
  configPath?: string;
  diagnostics: SiteDiagnostic[];
}

export interface WorkspaceSiteSource {
  path: string;
  body?: string | null;
}

export interface DohcSiteConfig {
  type?: "site";
  title?: string;
  preview?: {
    mode?: "static" | "dev" | "build";
    command?: string;
    entry?: string;
  };
  build?: {
    command?: string;
    output?: string;
  };
}

export interface ParsedDohcSiteConfig {
  config?: DohcSiteConfig;
  diagnostics: SiteDiagnostic[];
}

type PackageJson = {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
};

type Candidate = {
  root: string;
  hasIndexHtml: boolean;
  hasDohcConfig: boolean;
  hasPackageJson: boolean;
  hasWebPackageSignal: boolean;
  hasFrameworkConfig: boolean;
  hasBuildOutputSignal: boolean;
  entry?: string;
  packageJson?: PackageJson;
  packageManager?: SitePackageManager;
  dohcConfig?: DohcSiteConfig;
  dohcConfigPath?: string;
  frameworkConfigPath?: string;
  buildOutputs: Set<string>;
  diagnostics: SiteDiagnostic[];
};

const PACKAGE_SCRIPT_KEYS = ["dev", "start", "build", "preview"] as const;
const BUILD_OUTPUT_DIRS = ["dist", "build", "out"];

const WEB_DEPENDENCIES = new Set([
  "@angular/cli",
  "@angular/core",
  "@astrojs/react",
  "@astrojs/svelte",
  "@astrojs/vue",
  "@preact/preset-vite",
  "@remix-run/react",
  "@solidjs/start",
  "@sveltejs/kit",
  "@tanstack/react-start",
  "@tanstack/start",
  "@vitejs/plugin-react",
  "@vitejs/plugin-vue",
  "astro",
  "gatsby",
  "lit",
  "next",
  "nuxt",
  "parcel",
  "preact",
  "react",
  "react-dom",
  "react-scripts",
  "solid-js",
  "svelte",
  "vite",
  "vue",
  "webpack",
]);

const WEB_SCRIPT_TOKENS = [
  "astro",
  "gatsby",
  "next",
  "nuxt",
  "parcel",
  "react-scripts",
  "remix",
  "serve",
  "svelte-kit",
  "vite",
  "webpack",
];

const CONFIG_PATTERNS = [
  /^app\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^astro\.config\.(cjs|cts|js|json|mjs|mts|ts)$/,
  /^next\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^svelte\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^tanstack\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^vite\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^vinxi\.config\.(cjs|cts|js|mjs|mts|ts)$/,
];

const IGNORED_SITE_SEGMENTS = new Set([
  ".bun",
  ".cache",
  ".npm",
  ".parcel-cache",
  ".pnpm-store",
  ".turbo",
  ".yarn",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
  path: string,
  severity: SiteDiagnostic["severity"],
  code: string,
  message: string,
): SiteDiagnostic {
  return { path, severity, code, message };
}

function normalizeWorkspacePath(path: string): string | null {
  if (path.includes("\0")) return null;
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized === "") return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function pathBasename(path: string): string {
  return path === "" ? "" : path.split("/").at(-1) ?? path;
}

function sitePath(root: string, child: string): string {
  return root === "" ? child : `${root}/${child}`;
}

function hasIgnoredSiteSegment(path: string): boolean {
  if (hasIgnoredSegment(path)) return true;
  const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
  return segments.some((segment, index) => {
    if (IGNORED_SITE_SEGMENTS.has(segment)) return true;
    return segment === ".next" && segments[index + 1] === "cache";
  });
}

function getCandidate(candidates: Map<string, Candidate>, root: string): Candidate {
  const existing = candidates.get(root);
  if (existing) return existing;
  const candidate: Candidate = {
    root,
    hasIndexHtml: false,
    hasDohcConfig: false,
    hasPackageJson: false,
    hasWebPackageSignal: false,
    hasFrameworkConfig: false,
    hasBuildOutputSignal: false,
    buildOutputs: new Set(),
    diagnostics: [],
  };
  candidates.set(root, candidate);
  return candidate;
}

function safeRelativeConfigPath(value: string): string | undefined {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return undefined;
  }
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized !== value.replaceAll("\\", "/").replace(/^\/+/, "")) {
    return undefined;
  }
  if (normalized.startsWith("../") || normalized === "..") return undefined;
  return normalized === "" ? undefined : normalized;
}

function parsePreview(
  value: unknown,
  path: string,
  diagnostics: SiteDiagnostic[],
): DohcSiteConfig["preview"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(path, "warning", "invalid-preview", "dohc.json preview must be an object."),
    );
    return undefined;
  }

  const preview: NonNullable<DohcSiteConfig["preview"]> = {};
  if (value.mode !== undefined) {
    if (value.mode === "static" || value.mode === "dev" || value.mode === "build") {
      preview.mode = value.mode;
    } else {
      diagnostics.push(
        diagnostic(
          path,
          "warning",
          "invalid-preview-mode",
          "dohc.json preview.mode must be static, dev, or build.",
        ),
      );
    }
  }
  if (value.command !== undefined) {
    if (typeof value.command === "string" && value.command.trim() !== "") {
      preview.command = value.command;
    } else {
      diagnostics.push(
        diagnostic(
          path,
          "warning",
          "invalid-preview-command",
          "dohc.json preview.command must be a non-empty string.",
        ),
      );
    }
  }
  if (value.entry !== undefined) {
    if (typeof value.entry === "string" && value.entry.trim() !== "") {
      const normalized = safeRelativeConfigPath(value.entry);
      if (normalized) {
        preview.entry = normalized;
      } else {
        diagnostics.push(
          diagnostic(
            path,
            "warning",
            "invalid-preview-entry",
            "dohc.json preview.entry must be a relative workspace path.",
          ),
        );
      }
    } else {
      diagnostics.push(
        diagnostic(
          path,
          "warning",
          "invalid-preview-entry",
          "dohc.json preview.entry must be a non-empty string.",
        ),
      );
    }
  }
  return Object.keys(preview).length === 0 ? undefined : preview;
}

function parseBuild(
  value: unknown,
  path: string,
  diagnostics: SiteDiagnostic[],
): DohcSiteConfig["build"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(path, "warning", "invalid-build", "dohc.json build must be an object."),
    );
    return undefined;
  }

  const build: NonNullable<DohcSiteConfig["build"]> = {};
  if (value.command !== undefined) {
    if (typeof value.command === "string" && value.command.trim() !== "") {
      build.command = value.command;
    } else {
      diagnostics.push(
        diagnostic(
          path,
          "warning",
          "invalid-build-command",
          "dohc.json build.command must be a non-empty string.",
        ),
      );
    }
  }
  if (value.output !== undefined) {
    if (typeof value.output === "string" && value.output.trim() !== "") {
      const normalized = safeRelativeConfigPath(value.output);
      if (normalized) {
        build.output = normalized;
      } else {
        diagnostics.push(
          diagnostic(
            path,
            "warning",
            "invalid-build-output",
            "dohc.json build.output must be a relative workspace path.",
          ),
        );
      }
    } else {
      diagnostics.push(
        diagnostic(
          path,
          "warning",
          "invalid-build-output",
          "dohc.json build.output must be a non-empty string.",
        ),
      );
    }
  }
  return Object.keys(build).length === 0 ? undefined : build;
}

export function parseDohcSiteConfig(json: string, path = "dohc.json"): ParsedDohcSiteConfig {
  const diagnostics: SiteDiagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        path,
        "error",
        "invalid-json",
        `dohc.json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { diagnostics };
  }

  if (!isRecord(parsed)) {
    diagnostics.push(
      diagnostic(path, "error", "invalid-config", "dohc.json must contain a JSON object."),
    );
    return { diagnostics };
  }

  const config: DohcSiteConfig = {};
  if (parsed.type !== undefined) {
    if (parsed.type === "site") {
      config.type = "site";
    } else {
      diagnostics.push(
        diagnostic(path, "warning", "invalid-type", 'dohc.json type should be "site".'),
      );
    }
  }
  if (parsed.title !== undefined) {
    if (typeof parsed.title === "string" && parsed.title.trim() !== "") {
      config.title = parsed.title;
    } else {
      diagnostics.push(
        diagnostic(path, "warning", "invalid-title", "dohc.json title must be a non-empty string."),
      );
    }
  }

  const preview = parsePreview(parsed.preview, path, diagnostics);
  if (preview) config.preview = preview;
  const build = parseBuild(parsed.build, path, diagnostics);
  if (build) config.build = build;

  return { config, diagnostics };
}

function parsePackageJson(body: string, path: string): { json?: PackageJson; diagnostics: SiteDiagnostic[] } {
  try {
    const parsed = JSON.parse(body);
    if (!isRecord(parsed)) {
      return {
        diagnostics: [
          diagnostic(path, "error", "invalid-package-json", "package.json must contain a JSON object."),
        ],
      };
    }
    return { json: parsed, diagnostics: [] };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          path,
          "error",
          "invalid-package-json",
          `package.json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function packageDependencyNames(pkg: PackageJson | undefined): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const field of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ]) {
    for (const name of objectKeys(field)) names.add(name);
  }
  return names;
}

function packageScripts(pkg: PackageJson | undefined): Record<string, string> {
  if (!pkg || !isRecord(pkg.scripts)) return {};
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string") scripts[name] = value;
  }
  return scripts;
}

function hasWebDependency(pkg: PackageJson | undefined): boolean {
  for (const name of packageDependencyNames(pkg)) {
    if (WEB_DEPENDENCIES.has(name)) return true;
  }
  return false;
}

const WEB_SCRIPT_PATTERNS = WEB_SCRIPT_TOKENS.map((token) => {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s:/@._-])${escaped}($|[\\s:/@._-])`);
});

function hasWebScript(pkg: PackageJson | undefined): boolean {
  const scripts = packageScripts(pkg);
  return Object.entries(scripts).some(([name, value]) => {
    const haystack = `${name} ${value}`.toLowerCase();
    return WEB_SCRIPT_PATTERNS.some((pattern) => pattern.test(haystack));
  });
}

export function inferSiteScripts(
  pkg?: PackageJson,
  config?: DohcSiteConfig,
): SiteScripts {
  const scripts = packageScripts(pkg);
  const inferred: SiteScripts = {};
  for (const key of PACKAGE_SCRIPT_KEYS) {
    const value = scripts[key];
    if (typeof value === "string") inferred[key] = value;
  }

  if (config?.preview?.command) {
    if (config.preview.mode === "build" || config.preview.mode === "static") {
      inferred.preview = config.preview.command;
    } else {
      inferred.dev = config.preview.command;
    }
  }
  if (config?.build?.command) inferred.build = config.build.command;
  return inferred;
}

function packageManagerFromString(value: unknown): SitePackageManager | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("npm@")) return "npm";
  if (value.startsWith("yarn@")) return "yarn";
  if (value.startsWith("bun@")) return "bun";
  return undefined;
}

export function detectSitePackageManager(
  paths: readonly string[],
  root: string,
  pkg?: PackageJson,
): SitePackageManager | undefined {
  const has = (relativePath: string) => paths.includes(sitePath(root, relativePath));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return "npm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  return packageManagerFromString(pkg?.packageManager);
}

function isFrameworkConfig(name: string): boolean {
  return CONFIG_PATTERNS.some((pattern) => pattern.test(name));
}

function titleFromRoot(root: string): string {
  const basename = root === "" ? "workspace site" : root.split("/").at(-1) ?? root;
  return basename
    .replace(/^@/, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function packageTitle(pkg: PackageJson | undefined): string | undefined {
  if (typeof pkg?.name !== "string" || pkg.name.trim() === "") return undefined;
  const name = pkg.name.includes("/") ? pkg.name.split("/").at(-1) ?? pkg.name : pkg.name;
  return titleFromRoot(name);
}

function siteKind(candidate: Candidate): SiteKind {
  if (candidate.hasDohcConfig || candidate.hasFrameworkConfig) return "configured";
  if (candidate.hasPackageJson && candidate.hasWebPackageSignal) return "package";
  return "static";
}

function siteConfidence(candidate: Candidate): SiteConfidence {
  if (candidate.dohcConfig?.type === "site") return "high";
  if (candidate.hasIndexHtml || candidate.hasFrameworkConfig) return "high";
  if (candidate.hasWebPackageSignal || candidate.hasBuildOutputSignal) return "medium";
  return "low";
}

function shouldIncludeCandidate(candidate: Candidate): boolean {
  return (
    candidate.hasDohcConfig ||
    candidate.hasIndexHtml ||
    candidate.hasWebPackageSignal ||
    candidate.hasFrameworkConfig ||
    candidate.hasBuildOutputSignal ||
    candidate.diagnostics.length > 0
  );
}

function finalizeSite(candidate: Candidate): WorkspaceSite {
  const config = candidate.dohcConfig;
  const scripts = inferSiteScripts(candidate.packageJson, config);
  const buildOutputs = new Set(candidate.buildOutputs);
  if (config?.build?.output) buildOutputs.add(config.build.output);

  const configPath = candidate.dohcConfigPath ?? candidate.frameworkConfigPath;
  const entry = config?.preview?.entry ?? candidate.entry;
  return {
    root: candidate.root,
    title: config?.title ?? packageTitle(candidate.packageJson) ?? titleFromRoot(candidate.root),
    kind: siteKind(candidate),
    confidence: siteConfidence(candidate),
    ...(entry ? { entry } : {}),
    ...(candidate.packageManager ? { packageManager: candidate.packageManager } : {}),
    scripts,
    buildOutputs: [...buildOutputs].sort(),
    ...(configPath ? { configPath } : {}),
    diagnostics: [...candidate.diagnostics],
  };
}

function sourcePath(source: string | WorkspaceSiteSource): string {
  return typeof source === "string" ? source : source.path;
}

function sourceBody(source: string | WorkspaceSiteSource): string | undefined {
  if (typeof source === "string") return undefined;
  return typeof source.body === "string" ? source.body : undefined;
}

export function discoverSites(sources: readonly (string | WorkspaceSiteSource)[]): WorkspaceSite[] {
  const candidates = new Map<string, Candidate>();
  const normalizedPaths: string[] = [];
  const normalizedSources: Array<{ path: string; body?: string }> = [];

  for (const source of sources) {
    const path = normalizeWorkspacePath(sourcePath(source));
    if (!path || hasIgnoredSiteSegment(path)) continue;
    normalizedPaths.push(path);
    const body = sourceBody(source);
    normalizedSources.push({ path, ...(body !== undefined ? { body } : {}) });
  }

  for (const source of normalizedSources) {
    const name = fileName(source.path);
    const root = parentPath(source.path);
    const candidate = getCandidate(candidates, root);

    if (name === "index.html") {
      if (BUILD_OUTPUT_DIRS.includes(pathBasename(root))) continue;
      candidate.hasIndexHtml = true;
      candidate.entry = "index.html";
      continue;
    }

    if (name === "dohc.json") {
      candidate.hasDohcConfig = true;
      candidate.dohcConfigPath = source.path;
      if (source.body !== undefined) {
        const parsed = parseDohcSiteConfig(source.body, source.path);
        candidate.dohcConfig = parsed.config;
        candidate.diagnostics.push(...parsed.diagnostics);
        if (parsed.config?.preview?.entry) candidate.entry = parsed.config.preview.entry;
      }
      continue;
    }

    if (name === "package.json") {
      candidate.hasPackageJson = true;
      if (source.body !== undefined) {
        const parsed = parsePackageJson(source.body, source.path);
        candidate.packageJson = parsed.json;
        candidate.diagnostics.push(...parsed.diagnostics);
        candidate.hasWebPackageSignal =
          parsed.json !== undefined && (hasWebDependency(parsed.json) || hasWebScript(parsed.json));
      }
      continue;
    }

    if (isFrameworkConfig(name)) {
      candidate.hasFrameworkConfig = true;
      candidate.frameworkConfigPath ??= source.path;
      continue;
    }
  }

  for (const path of normalizedPaths) {
    const segments = path.split("/");
    const index = segments.findIndex((segment) => BUILD_OUTPUT_DIRS.includes(segment));
    if (index === -1 || index === segments.length - 1) continue;
    const outputDir = segments[index];
    const root = segments.slice(0, index).join("/");
    const candidate = getCandidate(candidates, root);
    candidate.buildOutputs.add(outputDir);
    if (segments.slice(index + 1).join("/") === "index.html") {
      candidate.hasBuildOutputSignal = true;
      candidate.entry ??= `${outputDir}/index.html`;
    }
  }

  for (const candidate of candidates.values()) {
    candidate.packageManager = detectSitePackageManager(
      normalizedPaths,
      candidate.root,
      candidate.packageJson,
    );
    if (candidate.dohcConfig?.build?.output) candidate.hasBuildOutputSignal = true;
  }

  return [...candidates.values()]
    .filter(shouldIncludeCandidate)
    .map(finalizeSite)
    .sort((a, b) => a.root.localeCompare(b.root));
}
