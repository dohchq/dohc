// Site detection, shared by this plugin's two halves.
//
// It lives beside the panel because dohc serves a panel its own directory and
// nothing above it: a module the panel imports has to sit next to the panel's
// page. The plugin's Node half imports the same file, so the list a user sees
// and the preview dohc starts read one implementation.
//
// Everything here is pure. It takes workspace paths, plus the bodies of the
// `dohc.json` and `package.json` files among them, and answers what the
// workspace holds. Nothing in this file touches a filesystem or a network.

/**
 * @typedef {"static" | "package" | "configured"} SiteKind
 * @typedef {"high" | "medium" | "low"} SiteConfidence
 * @typedef {"pnpm" | "npm" | "yarn" | "bun"} SitePackageManager
 * @typedef {"auto" | "static" | "dev" | "build"} PreviewMode
 * @typedef {"static" | "dev" | "build"} RunnableMode
 */

/**
 * @typedef {object} SiteScripts
 * @property {string} [dev]
 * @property {string} [start]
 * @property {string} [build]
 * @property {string} [preview]
 */

/**
 * @typedef {object} SiteDiagnostic
 * @property {string} path
 * @property {"warning" | "error"} severity
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {object} WorkspaceSite
 * @property {string} root Workspace-relative, or "" for the workspace itself.
 * @property {string} title
 * @property {SiteKind} kind
 * @property {SiteConfidence} confidence
 * @property {string} [entry] Site-relative page to serve.
 * @property {SitePackageManager} [packageManager]
 * @property {SiteScripts} scripts What the site can run, from either source.
 * @property {SiteScripts} configuredScripts Only what its dohc.json wrote out.
 *   These are command lines dohc runs as written; the rest are package scripts
 *   the site's own package manager runs.
 * @property {boolean} hasPackage True when the site root holds a package.json.
 * @property {string[]} buildOutputs
 * @property {string} [configPath]
 * @property {boolean} shared True for a site inside a share mount.
 * @property {SiteDiagnostic[]} diagnostics
 */

/**
 * @typedef {object} SiteSource
 * @property {string} path
 * @property {string} [body]
 */

const PACKAGE_SCRIPT_KEYS = ["dev", "start", "build", "preview"];
const BUILD_OUTPUT_DIRS = ["dist", "build", "out"];

/** The mount every share a user accepted lands under. */
const SHARE_MOUNT_PREFIX = "shared-with-me/";

/** Files whose contents change what a path means, so the panel reads them. */
export const SITE_SIGNAL_FILES = ["dohc.json", "package.json"];

// Mainstream web stacks with a recognizable dependency or official tooling.
// Kept identical to the list dohc's own detection used, so a workspace that
// listed a site before this plugin still lists it.
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

/**
 * Directories a site root never is, and a served path never passes through.
 * `.dohc` is the workspace's own control plane; the rest are caches and
 * installed dependencies.
 */
const RESERVED_SEGMENTS = new Set([
  ".bun",
  ".cache",
  ".dohc",
  ".git",
  ".npm",
  ".parcel-cache",
  ".pnpm-store",
  ".turbo",
  ".yarn",
  "node_modules",
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} path
 * @param {"warning" | "error"} severity
 * @param {string} code
 * @param {string} message
 * @returns {SiteDiagnostic}
 */
function diagnostic(path, severity, code, message) {
  return { path, severity, code, message };
}

// Windows resolves "foo." and "foo " to "foo", so a trailing dot or space
// would otherwise spell a reserved directory that no rule here recognized.
/** @param {string} segment @returns {string} */
function stripAliasSuffix(segment) {
  return segment.replace(/[. ]+$/, "");
}

/** @param {string} path @returns {string | null} */
export function normalizeWorkspacePath(path) {
  if (path.includes("\0")) return null;
  const segments = path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map(stripAliasSuffix);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  const normalized = segments.join("/");
  return normalized === "" ? null : normalized;
}

/**
 * True for a path dohc must never treat as site content.
 *
 * The workspace-root `plugins/` tree is excluded outright: a plugin's own
 * panel page is an `index.html`, and promoting it to a site would offer to
 * serve full-trust source as a preview.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function hasReservedSegment(path) {
  const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
  if (stripAliasSuffix(segments[0] ?? "") === "plugins") return true;
  return segments.some((segment, index) => {
    const stripped = stripAliasSuffix(segment);
    const next = segments[index + 1];
    if (RESERVED_SEGMENTS.has(stripped)) return true;
    return stripped === ".next" && next !== undefined && stripAliasSuffix(next) === "cache";
  });
}

/** @param {string} path @returns {string} */
function parentPath(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** @param {string} path @returns {string} */
function fileName(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** @param {string} path @returns {string} */
function pathBasename(path) {
  return path === "" ? "" : (path.split("/").at(-1) ?? path);
}

/** @param {string} value @returns {string | undefined} */
function safeRelativeConfigPath(value) {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\")) {
    return undefined;
  }
  return normalizeWorkspacePath(value) ?? undefined;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {SiteDiagnostic[]} diagnostics
 */
function parsePreview(value, path, diagnostics) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(path, "warning", "invalid-preview", "dohc.json preview must be an object."),
    );
    return undefined;
  }

  /** @type {{ mode?: RunnableMode; command?: string; entry?: string }} */
  const preview = {};
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
      if (normalized) preview.entry = normalized;
      else {
        diagnostics.push(
          diagnostic(
            path,
            "warning",
            "invalid-preview-entry",
            "dohc.json preview.entry must be a relative workspace path, not '.', './', or an empty path.",
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

/**
 * @param {unknown} value
 * @param {string} path
 * @param {SiteDiagnostic[]} diagnostics
 */
function parseBuild(value, path, diagnostics) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(path, "warning", "invalid-build", "dohc.json build must be an object."),
    );
    return undefined;
  }

  /** @type {{ command?: string; output?: string }} */
  const build = {};
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
      if (normalized) build.output = normalized;
      else {
        diagnostics.push(
          diagnostic(
            path,
            "warning",
            "invalid-build-output",
            "dohc.json build.output must be a relative workspace path, not '.', './', or an empty path.",
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

/**
 * @param {string} json
 * @param {string} [path]
 */
export function parseSiteConfig(json, path = "dohc.json") {
  /** @type {SiteDiagnostic[]} */
  const diagnostics = [];
  /** @type {unknown} */
  let parsed;
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

  /** @type {{ type?: "site"; title?: string; preview?: ReturnType<typeof parsePreview>; build?: ReturnType<typeof parseBuild> }} */
  const config = {};
  if (parsed.type !== undefined) {
    if (parsed.type === "site") config.type = "site";
    else {
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

/**
 * @param {string} body
 * @param {string} path
 */
function parsePackageJson(body, path) {
  try {
    const parsed = JSON.parse(body);
    if (!isRecord(parsed)) {
      return {
        diagnostics: [
          diagnostic(
            path,
            "error",
            "invalid-package-json",
            "package.json must contain a JSON object.",
          ),
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

/** @param {unknown} value @returns {string[]} */
function objectKeys(value) {
  return isRecord(value) ? Object.keys(value) : [];
}

/** @param {Record<string, unknown> | undefined} pkg @returns {Set<string>} */
function packageDependencyNames(pkg) {
  /** @type {Set<string>} */
  const names = new Set();
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

/** @param {Record<string, unknown> | undefined} pkg @returns {Record<string, string>} */
function packageScripts(pkg) {
  if (!pkg || !isRecord(pkg.scripts)) return {};
  /** @type {Record<string, string>} */
  const scripts = {};
  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string") scripts[name] = value;
  }
  return scripts;
}

/** @param {Record<string, unknown> | undefined} pkg @returns {boolean} */
function hasWebDependency(pkg) {
  for (const name of packageDependencyNames(pkg)) {
    if (WEB_DEPENDENCIES.has(name)) return true;
  }
  return false;
}

const WEB_SCRIPT_BOUNDARY_CHARS = " \t\n\r:/@._-";

/** @param {string | undefined} char @returns {boolean} */
function isWebScriptBoundary(char) {
  return char === undefined || WEB_SCRIPT_BOUNDARY_CHARS.includes(char);
}

/** @param {string} haystack @param {string} token @returns {boolean} */
function includesWebScriptToken(haystack, token) {
  let index = haystack.indexOf(token);
  while (index !== -1) {
    if (
      isWebScriptBoundary(haystack[index - 1]) &&
      isWebScriptBoundary(haystack[index + token.length])
    ) {
      return true;
    }
    index = haystack.indexOf(token, index + token.length);
  }
  return false;
}

/** @param {Record<string, unknown> | undefined} pkg @returns {boolean} */
function hasWebScript(pkg) {
  return Object.entries(packageScripts(pkg)).some(([name, value]) => {
    const haystack = `${name} ${value}`.toLowerCase();
    return WEB_SCRIPT_TOKENS.some((token) => includesWebScriptToken(haystack, token));
  });
}

/**
 * @param {Record<string, unknown> | undefined} pkg
 * @param {{ preview?: { mode?: RunnableMode; command?: string }; build?: { command?: string } } | undefined} config
 * @returns {SiteScripts}
 */
export function inferSiteScripts(pkg, config) {
  const scripts = packageScripts(pkg);
  /** @type {SiteScripts} */
  const inferred = {};
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

/** @param {unknown} value @returns {SitePackageManager | undefined} */
function packageManagerFromString(value) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("npm@")) return "npm";
  if (value.startsWith("yarn@")) return "yarn";
  if (value.startsWith("bun@")) return "bun";
  return undefined;
}

/**
 * @param {ReadonlySet<string>} names
 * @param {Record<string, unknown>} [pkg]
 * @returns {SitePackageManager | undefined}
 */
export function detectPackageManager(names, pkg) {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  return packageManagerFromString(pkg?.packageManager);
}

/** @param {string} name @returns {boolean} */
function isFrameworkConfig(name) {
  return CONFIG_PATTERNS.some((pattern) => pattern.test(name));
}

/** @param {string} root @returns {string} */
function titleFromRoot(root) {
  const basename = root === "" ? "workspace site" : (root.split("/").at(-1) ?? root);
  return basename
    .replace(/^@/, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** @param {Record<string, unknown> | undefined} pkg @returns {string | undefined} */
function packageTitle(pkg) {
  if (typeof pkg?.name !== "string" || pkg.name.trim() === "") return undefined;
  const name = pkg.name.includes("/") ? (pkg.name.split("/").at(-1) ?? pkg.name) : pkg.name;
  return titleFromRoot(name);
}

/**
 * Every site this workspace holds, deepest-first by path.
 *
 * @param {readonly (string | SiteSource)[]} sources Workspace file paths. A
 *   source carrying a `body` supplies that file's contents; only `dohc.json`
 *   and `package.json` bodies change the answer.
 * @returns {WorkspaceSite[]}
 */
export function discoverSites(sources) {
  /** @type {Map<string, any>} */
  const candidates = new Map();
  /** @type {string[]} */
  const normalizedPaths = [];
  /** @type {Map<string, Set<string>>} */
  const fileNamesByRoot = new Map();
  /** @type {Array<{ path: string; body?: string }>} */
  const normalizedSources = [];

  /** @param {string} root */
  const getCandidate = (root) => {
    const existing = candidates.get(root);
    if (existing) return existing;
    const candidate = {
      root,
      hasIndexHtml: false,
      hasDohcConfig: false,
      hasPackageJson: false,
      hasWebPackageSignal: false,
      hasFrameworkConfig: false,
      hasBuildOutputSignal: false,
      /** @type {Set<string>} */
      buildOutputs: new Set(),
      /** @type {SiteDiagnostic[]} */
      diagnostics: [],
    };
    candidates.set(root, candidate);
    return candidate;
  };

  for (const source of sources) {
    const rawPath = typeof source === "string" ? source : source.path;
    const path = normalizeWorkspacePath(rawPath);
    if (!path || hasReservedSegment(path)) continue;
    normalizedPaths.push(path);
    const root = parentPath(path);
    const names = fileNamesByRoot.get(root) ?? new Set();
    names.add(fileName(path));
    fileNamesByRoot.set(root, names);
    const body = typeof source === "string" ? undefined : source.body;
    normalizedSources.push({ path, ...(typeof body === "string" ? { body } : {}) });
  }

  for (const source of normalizedSources) {
    const name = fileName(source.path);
    const root = parentPath(source.path);
    const candidate = getCandidate(root);

    if (name === "index.html") {
      // A build output is an artifact of its parent site, never a site of
      // its own.
      if (BUILD_OUTPUT_DIRS.includes(pathBasename(root))) continue;
      candidate.hasIndexHtml = true;
      candidate.entry = "index.html";
      continue;
    }

    if (name === "dohc.json") {
      candidate.hasDohcConfig = true;
      candidate.dohcConfigPath = source.path;
      if (source.body !== undefined) {
        const parsed = parseSiteConfig(source.body, source.path);
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
    }
  }

  for (const path of normalizedPaths) {
    const segments = path.split("/");
    const index = segments.findIndex((segment) => BUILD_OUTPUT_DIRS.includes(segment));
    if (index === -1 || index === segments.length - 1) continue;
    const outputDir = segments[index];
    const root = segments.slice(0, index).join("/");
    const candidate = getCandidate(root);
    candidate.buildOutputs.add(outputDir);
    if (segments.slice(index + 1).join("/") === "index.html") {
      candidate.hasBuildOutputSignal = true;
      candidate.entry ??= `${outputDir}/index.html`;
    }
  }

  for (const candidate of candidates.values()) {
    candidate.packageManager = detectPackageManager(
      fileNamesByRoot.get(candidate.root) ?? new Set(),
      candidate.packageJson,
    );
    if (candidate.dohcConfig?.build?.output) candidate.hasBuildOutputSignal = true;
  }

  return [...candidates.values()]
    .filter(
      (candidate) =>
        candidate.hasDohcConfig ||
        candidate.hasIndexHtml ||
        candidate.hasWebPackageSignal ||
        candidate.hasFrameworkConfig ||
        candidate.hasBuildOutputSignal,
    )
    .map(finalizeSite)
    .sort((a, b) => a.root.localeCompare(b.root));
}

/** @param {any} candidate @returns {WorkspaceSite} */
function finalizeSite(candidate) {
  const config = candidate.dohcConfig;
  const scripts = inferSiteScripts(candidate.packageJson, config);
  /** @type {Set<string>} */
  const buildOutputs = new Set(candidate.buildOutputs);
  if (config?.build?.output) buildOutputs.add(config.build.output);

  const configPath = candidate.dohcConfigPath ?? candidate.frameworkConfigPath;
  const entry = config?.preview?.entry ?? candidate.entry;
  return {
    root: candidate.root,
    title: config?.title ?? packageTitle(candidate.packageJson) ?? titleFromRoot(candidate.root),
    kind: candidate.hasDohcConfig || candidate.hasFrameworkConfig
      ? "configured"
      : candidate.hasPackageJson && candidate.hasWebPackageSignal
        ? "package"
        : "static",
    confidence: siteConfidence(candidate),
    ...(entry ? { entry } : {}),
    ...(candidate.packageManager ? { packageManager: candidate.packageManager } : {}),
    scripts,
    configuredScripts: inferSiteScripts(undefined, config),
    hasPackage: candidate.hasPackageJson === true,
    buildOutputs: [...buildOutputs].sort(),
    ...(configPath ? { configPath } : {}),
    shared: isSharedRoot(candidate.root),
    diagnostics: [...candidate.diagnostics],
  };
}

/** @param {any} candidate @returns {SiteConfidence} */
function siteConfidence(candidate) {
  if (candidate.dohcConfig?.type === "site") return "high";
  if (candidate.hasIndexHtml || candidate.hasFrameworkConfig) return "high";
  if (candidate.hasWebPackageSignal || candidate.hasBuildOutputSignal) return "medium";
  return "low";
}

/**
 * True for a site that came from someone else's share.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isSharedRoot(root) {
  return `${root}/`.startsWith(SHARE_MOUNT_PREFIX);
}

/**
 * The modes a site can actually open in.
 *
 * A shared site serves its files and runs nothing: a share mount holds another
 * person's code, and dohc previews it without executing it.
 *
 * @param {WorkspaceSite} site
 * @returns {RunnableMode[]}
 */
export function availableModes(site) {
  if (site.shared) return site.entry ? ["static"] : [];
  /** @type {RunnableMode[]} */
  const modes = [];
  if (site.entry) modes.push("static");
  if (site.scripts.dev || site.scripts.start) modes.push("dev");
  if (site.scripts.build || site.buildOutputs.length > 0) modes.push("build");
  return modes;
}

/**
 * Which mode to open when nobody has chosen one.
 *
 * @param {WorkspaceSite} site
 * @param {readonly RunnableMode[]} modes
 * @returns {RunnableMode | null}
 */
export function heuristicMode(site, modes) {
  if (site.shared) return modes.includes("static") ? "static" : null;
  if (modes.includes("dev")) return "dev";
  if (site.kind !== "static" && modes.includes("build")) return "build";
  if (modes.includes("static")) return "static";
  return modes.includes("build") ? "build" : null;
}

/**
 * The tab identity for one preview.
 *
 * dohc treats an instance key as opaque and hands it back to the plugin, so
 * this is the whole channel between the panel a user clicks in and the Node
 * half that starts a server. The mode rides in front because a mode a user
 * picked deliberately deserves its own tab, next to the one already open.
 *
 * @param {string} root
 * @param {PreviewMode} mode
 * @returns {string}
 */
export function previewInstanceKey(root, mode) {
  return `${mode}:${root}`;
}

/**
 * @param {string} instanceKey
 * @returns {{ root: string; mode: PreviewMode }}
 */
export function parsePreviewInstanceKey(instanceKey) {
  const separator = instanceKey.indexOf(":");
  const mode = separator === -1 ? "" : instanceKey.slice(0, separator);
  if (mode !== "auto" && mode !== "static" && mode !== "dev" && mode !== "build") {
    throw new Error(
      `A site preview instance names its mode first, as "auto:", "static:", "dev:", or "build:". This one was "${instanceKey}".`,
    );
  }
  return { root: instanceKey.slice(separator + 1), mode };
}
