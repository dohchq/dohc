import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Esbuild from "esbuild";

declare const __DOHC_STAGED_BUILTINS__:
  | {
      readonly digest: string;
      readonly files: Readonly<Record<string, string>>;
    }
  | undefined;

export const BUILTIN_NAMESPACE = "dohc-builtin";

export const BUILTIN_FILES = [
  "dohc-app.mjs",
  "dohc-charts.mjs",
  "dohc-csv.mjs",
  "dohc-icons.mjs",
  "dohc-money.mjs",
  "dohc-tokens.css",
  "dohc-ui.css",
  "dohc-ui.mjs",
  "react-dom-client.mjs",
  "react-dom.mjs",
  "react-jsx-runtime.mjs",
  "react.mjs",
] as const;

export type BuiltinFileName = (typeof BUILTIN_FILES)[number];

export const BUILTIN_SPECIFIERS: ReadonlyMap<string, BuiltinFileName> = new Map([
  ["react", "react.mjs"],
  ["react/jsx-runtime", "react-jsx-runtime.mjs"],
  ["react-dom", "react-dom.mjs"],
  ["react-dom/client", "react-dom-client.mjs"],
  ["dohc/app", "dohc-app.mjs"],
  ["dohc/ui", "dohc-ui.mjs"],
  ["dohc/charts", "dohc-charts.mjs"],
  ["dohc/icons", "dohc-icons.mjs"],
  ["dohc/money", "dohc-money.mjs"],
  ["dohc/csv", "dohc-csv.mjs"],
]);

const BUILTIN_INTERNAL_SPECIFIERS: ReadonlyMap<string, BuiltinFileName> = new Map([
  ...BUILTIN_SPECIFIERS,
  ["./dohc-tokens.css", "dohc-tokens.css"],
  ["./dohc-ui.css", "dohc-ui.css"],
]);

const RESERVED_ROOTS = new Set(["react", "react-dom", "scheduler", "dohc"]);

export function isReservedAppPackage(specifier: string): boolean {
  const root = specifier.split("/", 1)[0] ?? "";
  return RESERVED_ROOTS.has(root);
}

export function resolveBuiltinImport(
  specifier: string,
  fromBuiltin: boolean,
): BuiltinFileName | undefined {
  return (fromBuiltin ? BUILTIN_INTERNAL_SPECIFIERS : BUILTIN_SPECIFIERS).get(specifier);
}

export interface BuiltinAsset {
  readonly path: BuiltinFileName;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ClosedAppBuiltins {
  readonly files: ReadonlyMap<BuiltinFileName, BuiltinAsset>;
  readonly digest: string;
}

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function finalizeBuiltins(
  entries: ReadonlyArray<readonly [BuiltinFileName, Uint8Array]>,
): ClosedAppBuiltins {
  const files = new Map<BuiltinFileName, BuiltinAsset>();
  for (const [path, raw] of entries) {
    const bytes = Uint8Array.from(raw);
    files.set(path, { path, bytes, sha256: sha256(bytes) });
  }
  for (const name of BUILTIN_FILES) {
    if (!files.has(name)) {
      throw new Error(`Missing built-in app kit file: ${name}`);
    }
  }
  const digest = sha256(
    JSON.stringify([
      "dohc-app-builtins-v1",
      BUILTIN_FILES.map((name) => [name, files.get(name)!.sha256]),
    ]),
  );
  return { files, digest };
}

function esmExternalBridge(externals: readonly string[]): Esbuild.Plugin {
  const allowed = new Set(externals);
  return {
    name: "dohc-esm-external-bridge",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!allowed.has(args.path)) return null;
        if (args.namespace === "dohc-esm-bridge") return { path: args.path, external: true };
        return { path: args.path, namespace: "dohc-esm-bridge" };
      });
      build.onLoad({ filter: /.*/, namespace: "dohc-esm-bridge" }, (args) => ({
        contents: `import * as ns from ${JSON.stringify(args.path)}; export * from ${JSON.stringify(args.path)}; export default ns.default ?? ns;`,
        loader: "js",
      }));
    },
  };
}

function rewriteKitCssPlugin(): Esbuild.Plugin {
  return {
    name: "dohc-rewrite-kit-css",
    setup(build) {
      build.onResolve({ filter: /^\.\/tokens\.css$/ }, () => ({
        path: "./dohc-tokens.css",
        external: true,
      }));
      build.onResolve({ filter: /^\.\/ui\.css$/ }, () => ({
        path: "./dohc-ui.css",
        external: true,
      }));
    },
  };
}

function pureLucideIconsPlugin(): Esbuild.Plugin {
  return {
    name: "dohc-pure-lucide-icons",
    setup(build) {
      build.onLoad(
        { filter: /[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/][^\\/]+\.mjs$/ },
        async (args) => ({
          contents: (await readFile(args.path, "utf8")).replace(
            /= createLucideIcon\(/g,
            "= /* @__PURE__ */ createLucideIcon(",
          ),
          loader: "js",
        }),
      );
    },
  };
}

async function bundleVirtualModule(
  esbuild: typeof Esbuild,
  absWorkingDir: string,
  resolveDir: string,
  contents: string,
  externals: readonly string[],
): Promise<Uint8Array> {
  const result = await esbuild.build({
    absWorkingDir,
    stdin: { contents, resolveDir, loader: "js" },
    bundle: true,
    minify: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "silent",
    plugins: externals.length > 0 ? [esmExternalBridge(externals)] : [],
  });
  return result.outputFiles[0]!.contents;
}

async function bundleKitEntry(
  esbuild: typeof Esbuild,
  absWorkingDir: string,
  entryPoint: string,
  externals: readonly string[],
  plugins: Esbuild.Plugin[],
  keepPureAnnotations = false,
): Promise<Uint8Array> {
  const result = await esbuild.build({
    absWorkingDir,
    entryPoints: [entryPoint],
    bundle: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: !keepPureAnnotations,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "silent",
    external: [...externals],
    plugins,
  });
  return result.outputFiles[0]!.contents;
}

async function bundleKitCss(
  esbuild: typeof Esbuild,
  absWorkingDir: string,
  entryPoint: string,
): Promise<Uint8Array> {
  const result = await esbuild.build({
    absWorkingDir,
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    write: false,
    platform: "browser",
    target: "es2022",
    legalComments: "none",
    logLevel: "silent",
  });
  return result.outputFiles[0]!.contents;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function cjsNamedReexportModule(
  specifier: string,
  keys: readonly string[],
  includeDefault: boolean,
): string {
  const named = [...new Set(keys)]
    .filter((key) => key !== "default" && key !== "__esModule" && IDENTIFIER.test(key))
    .sort();
  const lines = [`import mod from ${JSON.stringify(specifier)};`];
  if (includeDefault) lines.push("export default mod;");
  if (named.length > 0) {
    lines.push(`export const { ${named.join(", ")} } = mod;`);
  }
  return lines.join("\n");
}

function resolveRuntimePackageDir(
  desktopRoot: string,
  repoRoot: string,
  desktopRequire: NodeRequire,
  pkg: "react" | "react-dom",
  runtimeEntry: string,
): string {
  for (const candidate of [
    join(desktopRoot, "node_modules", pkg),
    join(repoRoot, "packages/app-kit/node_modules", pkg),
  ]) {
    if (existsSync(join(candidate, "cjs"))) return realpathSync(candidate);
  }
  return dirname(desktopRequire.resolve(runtimeEntry));
}

export async function buildClosedAppBuiltins(
  esbuild: typeof Esbuild,
  desktopRoot: string,
): Promise<ClosedAppBuiltins> {
  const repoRoot = resolve(desktopRoot, "../..");
  const desktopRequire = createRequire(join(desktopRoot, "package.json"));
  const reactDir = resolveRuntimePackageDir(
    desktopRoot,
    repoRoot,
    desktopRequire,
    "react",
    "react/jsx-runtime",
  );
  const reactDomDir = resolveRuntimePackageDir(
    desktopRoot,
    repoRoot,
    desktopRequire,
    "react-dom",
    "react-dom/client",
  );
  const reactKeys = Object.keys(
    desktopRequire(join(reactDir, "cjs/react.production.js")) as Record<string, unknown>,
  );
  const jsxRuntimeKeys = Object.keys(
    desktopRequire(join(reactDir, "cjs/react-jsx-runtime.production.js")) as Record<
      string,
      unknown
    >,
  );
  const reactDomKeys = Object.keys(
    desktopRequire(join(reactDomDir, "cjs/react-dom.production.js")) as Record<string, unknown>,
  );
  const reactDomClientKeys = Object.keys(
    desktopRequire(join(reactDomDir, "cjs/react-dom-client.production.js")) as Record<
      string,
      unknown
    >,
  );
  const kitSrcDir = resolve(repoRoot, "packages/app-kit/src");

  const [
    reactBytes,
    jsxRuntimeBytes,
    reactDomBytes,
    reactDomClientBytes,
    dohcAppBytes,
    dohcUiBytes,
    dohcTokensCssBytes,
    dohcUiCssBytes,
    dohcChartsBytes,
    dohcIconsBytes,
    dohcMoneyBytes,
    dohcCsvBytes,
  ] = await Promise.all([
    bundleVirtualModule(
      esbuild,
      repoRoot,
      reactDir,
      cjsNamedReexportModule("react", reactKeys, true),
      [],
    ),
    bundleVirtualModule(
      esbuild,
      repoRoot,
      reactDir,
      cjsNamedReexportModule("react/jsx-runtime", jsxRuntimeKeys, false),
      ["react"],
    ),
    bundleVirtualModule(
      esbuild,
      repoRoot,
      reactDomDir,
      cjsNamedReexportModule("react-dom", reactDomKeys, true),
      ["react"],
    ),
    bundleVirtualModule(
      esbuild,
      repoRoot,
      reactDomDir,
      cjsNamedReexportModule("react-dom/client", reactDomClientKeys, true),
      ["react", "react-dom"],
    ),
    bundleKitEntry(
      esbuild,
      repoRoot,
      join(kitSrcDir, "app.tsx"),
      ["react", "react/jsx-runtime"],
      [],
    ),
    bundleKitEntry(
      esbuild,
      repoRoot,
      join(kitSrcDir, "ui.tsx"),
      ["react", "react/jsx-runtime", "react-dom"],
      [rewriteKitCssPlugin()],
    ),
    bundleKitCss(esbuild, repoRoot, join(kitSrcDir, "tokens.css")),
    bundleKitCss(esbuild, repoRoot, join(kitSrcDir, "ui.css")),
    bundleKitEntry(
      esbuild,
      repoRoot,
      join(kitSrcDir, "charts.tsx"),
      ["react", "react/jsx-runtime"],
      [rewriteKitCssPlugin()],
    ),
    bundleKitEntry(
      esbuild,
      repoRoot,
      join(kitSrcDir, "icons.ts"),
      ["react", "react/jsx-runtime"],
      [pureLucideIconsPlugin()],
      true,
    ),
    bundleKitEntry(esbuild, repoRoot, join(kitSrcDir, "money.ts"), [], []),
    bundleKitEntry(esbuild, repoRoot, join(kitSrcDir, "csv.ts"), [], []),
  ]);

  return finalizeBuiltins([
    ["react.mjs", reactBytes],
    ["react-jsx-runtime.mjs", jsxRuntimeBytes],
    ["react-dom.mjs", reactDomBytes],
    ["react-dom-client.mjs", reactDomClientBytes],
    ["dohc-app.mjs", dohcAppBytes],
    ["dohc-ui.mjs", dohcUiBytes],
    ["dohc-tokens.css", dohcTokensCssBytes],
    ["dohc-ui.css", dohcUiCssBytes],
    ["dohc-charts.mjs", dohcChartsBytes],
    ["dohc-icons.mjs", dohcIconsBytes],
    ["dohc-money.mjs", dohcMoneyBytes],
    ["dohc-csv.mjs", dohcCsvBytes],
  ]);
}

let cachedDevBuiltins: Promise<ClosedAppBuiltins> | undefined;

export async function loadClosedAppBuiltins(
  moduleUrl: string,
  esbuild?: typeof Esbuild,
): Promise<ClosedAppBuiltins> {
  const selfPath = fileURLToPath(moduleUrl);
  if (typeof __DOHC_STAGED_BUILTINS__ !== "undefined") {
    const expected = __DOHC_STAGED_BUILTINS__;
    const builtinsDir = join(dirname(selfPath), "builtins");
    const entries = await Promise.all(
      BUILTIN_FILES.map(async (name) => [name, await readFile(join(builtinsDir, name))] as const),
    );
    const loaded = finalizeBuiltins(entries);
    if (loaded.digest !== expected.digest) {
      throw new Error("Built-in app kit integrity check failed.");
    }
    for (const name of BUILTIN_FILES) {
      if (loaded.files.get(name)?.sha256 !== expected.files[name]) {
        throw new Error("Built-in app kit integrity check failed.");
      }
    }
    return loaded;
  }
  if (!cachedDevBuiltins) {
    const desktopRoot = resolve(dirname(selfPath), "../..");
    const tracked = (async () => {
      const bundler = esbuild ?? (await import("esbuild"));
      return buildClosedAppBuiltins(bundler, desktopRoot);
    })().catch((error) => {
      if (cachedDevBuiltins === tracked) cachedDevBuiltins = undefined;
      throw error;
    });
    cachedDevBuiltins = tracked;
  }
  return cachedDevBuiltins;
}
