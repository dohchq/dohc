// The site vocabulary and detection helpers dohc's MCP tools use to
// recognize package managers, web dependencies, and framework config files
// when they build their own site detection on top of a workspace scan.

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

export type PackageJson = {
  name?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
};

// Framework/package signals are intentionally limited to mainstream web stacks
// with recognizable package dependencies or official CLI/build tooling. Refresh
// this list periodically as npm usage and framework conventions move.
export const WEB_DEPENDENCY_NAMES = [
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
] as const;

export const WEB_DEPENDENCIES: ReadonlySet<string> = new Set(WEB_DEPENDENCY_NAMES);

const CONFIG_PATTERNS = [
  /^app\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^astro\.config\.(cjs|cts|js|json|mjs|mts|ts)$/,
  /^next\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^svelte\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^tanstack\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^vite\.config\.(cjs|cts|js|mjs|mts|ts)$/,
  /^vinxi\.config\.(cjs|cts|js|mjs|mts|ts)$/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function packageDependencyNames(pkg: PackageJson | null | undefined): Set<string> {
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

export function hasWebDependency(pkg: PackageJson | null | undefined): boolean {
  for (const name of packageDependencyNames(pkg)) {
    if (WEB_DEPENDENCIES.has(name)) return true;
  }
  return false;
}

function packageManagerFromString(value: unknown): SitePackageManager | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("npm@")) return "npm";
  if (value.startsWith("yarn@")) return "yarn";
  if (value.startsWith("bun@")) return "bun";
  return undefined;
}

export function packageManagerFromFiles(
  names: ReadonlySet<string>,
  pkg?: PackageJson | null,
): SitePackageManager | undefined {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  return packageManagerFromString(pkg?.packageManager);
}

function isFrameworkConfig(name: string): boolean {
  return CONFIG_PATTERNS.some((pattern) => pattern.test(name));
}

export function frameworkConfigName(names: ReadonlySet<string>): string | undefined {
  return [...names].find(isFrameworkConfig);
}
