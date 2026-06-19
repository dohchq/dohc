// Local apps are visible source folders at <scope>/.apps/<name>/ with an
// app.json manifest. Build output is hidden under .dohc/cache/apps/<name> —
// source stays inspectable and editable; cache is never treated as source.
//
// The manifest mirrors the existing dohc app manifest: read/write are GLOBS
// (scope-relative), where the `write` globs are the MAXIMUM write surface (a
// ceiling) and app trust is what actually grants writing within them. Apps
// are offline (network: false).

export interface AppManifest {
  title?: string;
  entry: string;
  read: string[];
  write: string[];
  agent?: "run" | "patch.propose";
  network: false;
}

export interface AppPackage {
  name: string;
  root: string;
  manifestPath: string;
  sourceFiles: string[];
}

const APP_DIR_RE = /(^|\/)\.apps\/([^/]+)(\/|$)/;

function appRootOf(path: string): { name: string; root: string } | null {
  const match = APP_DIR_RE.exec(path);
  if (!match) return null;
  const name = match[2];
  const idx = path.indexOf(`.apps/${name}`);
  return { name, root: path.slice(0, idx + `.apps/${name}`.length) };
}

// The scope a relative read/write glob resolves against: the folder that
// contains the app's .apps directory (e.g. app "finance/.apps/ledger" → "finance").
export function appScope(appRoot: string): string {
  const marker = appRoot.lastIndexOf("/.apps/");
  return marker === -1 ? "" : appRoot.slice(0, marker);
}

export function appBuildOutputDir(appName: string): string {
  return `.dohc/cache/apps/${appName}`;
}

export function isAppCachePath(path: string): boolean {
  return path.startsWith(".dohc/cache/apps/");
}

// Groups workspace file paths into app packages: a .apps/<name>/ folder is an
// app only if it contains an app.json at its root. Build cache is excluded.
export function discoverApps(paths: string[]): AppPackage[] {
  const byRoot = new Map<string, AppPackage>();
  for (const path of paths) {
    if (isAppCachePath(path)) continue;
    const info = appRootOf(path);
    if (!info) continue;
    let pkg = byRoot.get(info.root);
    if (!pkg) {
      pkg = {
        name: info.name,
        root: info.root,
        manifestPath: `${info.root}/app.json`,
        sourceFiles: [],
      };
      byRoot.set(info.root, pkg);
    }
    pkg.sourceFiles.push(path);
  }
  return [...byRoot.values()]
    .filter((pkg) => pkg.sourceFiles.includes(pkg.manifestPath))
    .map((pkg) => ({ ...pkg, sourceFiles: [...pkg.sourceFiles].sort() }));
}

function toArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export function parseAppManifest(json: string): AppManifest {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
    entry: typeof parsed.entry === "string" ? parsed.entry : "src/App.tsx",
    read: toArray(parsed.read).length > 0 ? toArray(parsed.read) : ["."],
    write: toArray(parsed.write),
    ...(parsed.agent === "run" || parsed.agent === "patch.propose"
      ? { agent: parsed.agent }
      : {}),
    network: false,
  };
}

// Trust is required only when the app can actually mutate the workspace or act
// as an agent — a read-only app runs with no trust prompt.
export function requiresTrust(manifest: AppManifest): boolean {
  return manifest.write.length > 0 || manifest.agent !== undefined;
}

// Minimal glob → RegExp: supports ** (any depth), * (within a segment), and
// "." / "" meaning the whole scope. Enough for read/write surface checks.
function globToRegExp(glob: string): RegExp {
  if (glob === "." || glob === "" || glob === "**") return /^.*$/;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function scopeRelative(scope: string, target: string): string | null {
  if (scope === "") return target;
  if (target === scope) return "";
  if (target.startsWith(`${scope}/`)) return target.slice(scope.length + 1);
  return null; // outside the app's scope entirely
}

// The .dohc control directory holds the trust store that governs this very
// check — it can never be inside any app's writable ceiling, trusted or not.
function isControlPath(path: string): boolean {
  return path === ".dohc" || path.startsWith(".dohc/");
}

// An app may always write inside its own folder. Writing elsewhere is a broad
// write: the target must fall within a declared `write` glob (the ceiling) AND
// the app must be trusted (the grant). Traversal segments and the .dohc control
// dir are refused before any grant is considered — the ceiling must never
// include the metadata that governs the ceiling, and a wildcard scope must not
// be a path-escape primitive.
export function appWriteAllowed(
  manifest: AppManifest,
  trust: { trusted: boolean },
  appRoot: string,
  targetPath: string,
): boolean {
  const normalizedTargetPath = targetPath.replace(/\\/g, "/");
  const normalizedAppRoot = appRoot.replace(/\\/g, "/");
  if (normalizedTargetPath.split("/").includes("..")) return false;
  if (isControlPath(normalizedTargetPath)) return false;
  if (
    normalizedTargetPath === normalizedAppRoot ||
    normalizedTargetPath.startsWith(`${normalizedAppRoot}/`)
  ) {
    return true;
  }
  if (!trust.trusted) return false;
  const rel = scopeRelative(appScope(normalizedAppRoot), normalizedTargetPath);
  if (rel === null) return false;
  return manifest.write.some((glob) => globToRegExp(glob).test(rel));
}

export type AppReadiness = "needs-testing" | "failed" | "ready";

// An app is never "ready" (runnable as trusted) until AppTester has passed —
// the gate that catches blank/fake/non-persistent apps.
export function appReadiness(state: { tested: boolean; passed: boolean }): AppReadiness {
  if (!state.tested) return "needs-testing";
  return state.passed ? "ready" : "failed";
}
