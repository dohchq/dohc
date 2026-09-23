import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { parse } from "acorn";
import * as esbuild from "esbuild";

export interface ClosedAppInput {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}
export interface ClosedAppBuildRequest {
  entryPath: string;
  inputs: readonly ClosedAppInput[];
  /** Bare imports resolve only through this explicit captured map. */
  packageMap?: Readonly<Record<string, string>>;
  bounds: { maxInputFiles: number; maxInputBytes: number; maxOutputBytes: number };
}
export interface ClosedAppFileIdentity { path: string; sha256: string; byteLength: number }
export interface ClosedAppBuild {
  sourceDigest: string;
  dependencyLock: ClosedAppFileIdentity[];
  dependencyLockDigest: string;
  compiler: { recipe: "dohc-closed-app-v2"; version: string; binarySha256: string };
  files: Array<ClosedAppFileIdentity & { bytes: Uint8Array; contentType: string }>;
  bundleDigest: string;
  buildDigest: string;
}

const namespace = "dohc-app-source";
const binaryOverrideAtImport = process.env.ESBUILD_BINARY_PATH;
const tsconfigRaw = { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true } };
const scriptOptions = { jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } } as const;
const scriptLoaders = new Map<string, esbuild.Loader>([[".js", "js"], [".jsx", "jsx"], [".ts", "ts"], [".tsx", "tsx"]]);
const passiveExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".woff2"]);
const passiveMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "font/woff2"]);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const recordDigest = (domain: string, value: unknown) => sha256(JSON.stringify([domain, value]));

function canonicalPath(path: string): string {
  if (typeof path !== "string" || !/^[A-Za-z0-9_@./-]+$/.test(path) || path.startsWith("/") ||
      path.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error("Invalid closed app path.");
  return path;
}
function loaderFor(path: string): esbuild.Loader {
  const name = posix.basename(path);
  if (name === "package.json" || /^tsconfig(?:\..*)?\.json$/.test(name)) throw new Error("App build configuration is unsupported.");
  const extension = posix.extname(path);
  const script = scriptLoaders.get(extension);
  if (script) return script;
  if (extension === ".json" || extension === ".css") return extension.slice(1) as "json" | "css";
  if (passiveExtensions.has(extension)) return "dataurl";
  throw new Error("Unsupported closed app input type.");
}

function assertStaticModuleSyntax(source: string): void {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const pending: unknown[] = [ast];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    if (node.type === "MetaProperty" && (node.meta as { name?: string }).name === "import") throw new Error("App import.meta is unsupported.");
    if (node.type === "ImportExpression") {
      const source = node.source as { type?: string; value?: unknown };
      if (source.type !== "Literal" || typeof source.value !== "string") throw new Error("App dynamic import must name one declared source.");
    }
    if (node.type === "CallExpression" && (node.callee as { name?: string }).name === "require") {
      const args = node.arguments as Array<{ type?: string; value?: unknown }>;
      if (args.length !== 1 || args[0]?.type !== "Literal" || typeof args[0].value !== "string") throw new Error("App require must name one declared source.");
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) pending.push(item);
      else if (child && typeof child === "object") pending.push(child);
    }
  }
}

async function compilerIdentity(): Promise<ClosedAppBuild["compiler"]> {
  // Match esbuild 0.28.1's installed native-package resolution; refuse override/fallback binaries.
  if (binaryOverrideAtImport || process.env.ESBUILD_BINARY_PATH || esbuild.version !== "0.28.1" ||
      !["win32", "linux", "darwin"].includes(process.platform)) throw new Error("Unsupported app compiler installation.");
  const require = createRequire(import.meta.url);
  const compilerRequire = createRequire(require.resolve("esbuild"));
  const binary = compilerRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
  return { recipe: "dohc-closed-app-v2", version: esbuild.version, binarySha256: sha256(await readFile(binary)) };
}

/** Compile captured bytes only. The caller owns source authority and process resource enforcement. */
export async function compileClosedApp(request: ClosedAppBuildRequest): Promise<ClosedAppBuild> {
  const { maxInputFiles, maxInputBytes, maxOutputBytes } = request.bounds;
  for (const bound of [maxInputFiles, maxInputBytes, maxOutputBytes]) {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new Error("Invalid app compiler bound.");
  }
  if (!Array.isArray(request.inputs) || request.inputs.length === 0 || request.inputs.length > maxInputFiles) throw new Error("App input file bound exceeded.");
  const entry = canonicalPath(request.entryPath);
  if (!scriptLoaders.has(posix.extname(entry))) throw new Error("App entry must be a script.");
  // Finish the owned snapshot before the first await; callers cannot swap bytes during compilation.
  const inputs = new Map<string, ClosedAppInput>();
  const packages = new Map<string, string>();
  let inputBytes = 0;
  if (request.packageMap !== undefined && (!request.packageMap || typeof request.packageMap !== "object" || Array.isArray(request.packageMap))) throw new Error("Invalid app package map.");
  for (const [specifier, mapped] of Object.entries(request.packageMap ?? {})) {
    if (!/^(?:@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(specifier) ||
        specifier.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid app package map.");
    const path = canonicalPath(mapped);
    inputBytes += Buffer.byteLength(specifier) + Buffer.byteLength(path);
    if (packages.size >= maxInputFiles || inputBytes > maxInputBytes) throw new Error("App package map bound exceeded.");
    packages.set(specifier, path);
  }
  for (const file of request.inputs) {
    const path = canonicalPath(file.path);
    if (posix.basename(path) !== "collection.yaml" && posix.extname(path) !== ".sql") loaderFor(path);
    if (inputs.has(path) || !(file.bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid app input inventory.");
    inputBytes += file.bytes.byteLength + Buffer.byteLength(path);
    if (inputBytes > maxInputBytes) throw new Error("App input byte bound exceeded.");
    const bytes = Uint8Array.from(file.bytes);
    if (sha256(bytes) !== file.sha256) throw new Error("App input digest mismatch.");
    inputs.set(path, { path, bytes, sha256: file.sha256 });
  }
  if (!inputs.has(entry)) throw new Error("App entry is outside its declared inputs.");
  for (const path of packages.values()) if (!inputs.has(path)) throw new Error("App package is outside its declared inputs.");
  const inventory = [...inputs.values()].map(({ path, bytes, sha256 }) => ({ path, sha256, byteLength: bytes.byteLength })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceDigest = recordDigest("dohc-app-source-v2", { entry, files: inventory, packages: [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) });
  const compiler = await compilerIdentity();
  const directory = await mkdtemp(join(tmpdir(), "dohc-app-compiler-"));
  try {
    const result = await esbuild.build({
      absWorkingDir: directory, entryPoints: [entry], outfile: "bundle.js", bundle: true,
      write: false, metafile: true, platform: "browser", format: "iife", target: "es2022",
      tsconfigRaw, ...scriptOptions, sourcemap: false, legalComments: "none", logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error", "empty-import-meta": "error" },
      plugins: [{ name: "dohc-closed-inputs", setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          try {
            let path: string;
            if (args.kind === "entry-point") path = canonicalPath(args.path);
            else {
              if (args.namespace !== namespace) throw new Error("App import is outside its declared inputs.");
              if (args.path.startsWith(".")) {
                if (!/^[A-Za-z0-9_@./-]+$/.test(args.path)) throw new Error("Invalid app import path.");
                path = canonicalPath(posix.normalize(posix.join(posix.dirname(args.importer), args.path)));
              }
              else {
                const mapped = packages.get(args.path);
                if (!mapped) throw new Error("App package is outside its declared inputs.");
                path = mapped;
              }
            }
            if (!inputs.has(path)) throw new Error("App import is outside its declared inputs.");
            return { path, namespace };
          } catch (error) { return { errors: [{ text: (error as Error).message }] }; }
        });
        build.onLoad({ filter: /.*/, namespace }, async args => {
          const file = inputs.get(args.path);
          if (!file) return { errors: [{ text: "App source is unavailable." }] };
          const loader = loaderFor(file.path);
          if (scriptLoaders.has(posix.extname(file.path))) {
            const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
            const transformed = await esbuild.transform(source, { loader, target: "es2022", tsconfigRaw, ...scriptOptions, sourcemap: false, legalComments: "none", logLevel: "silent" });
            assertStaticModuleSyntax(transformed.code);
          }
          return { contents: file.bytes, loader };
        });
      } }],
    });
    const dependencyLock = Object.keys(result.metafile.inputs).sort().map(key => {
      if (!key.startsWith(namespace + ":")) throw new Error("App compiler escaped its input namespace.");
      const file = inputs.get(key.slice(namespace.length + 1));
      if (!file) throw new Error("App compiler used an undeclared input.");
      for (const imported of result.metafile.inputs[key]!.imports) {
        if (imported.external || !imported.path.startsWith(namespace + ":") || !inputs.has(imported.path.slice(namespace.length + 1))) throw new Error("App compiler retained an external import.");
      }
      return { path: file.path, sha256: file.sha256, byteLength: file.bytes.byteLength };
    });
    let outputBytes = 0;
    const files = result.outputFiles.map(file => {
      const path = posix.basename(file.path.replaceAll("\\", "/"));
      if (path !== "bundle.js" && path !== "bundle.css") throw new Error("Unexpected app compiler output.");
      outputBytes += file.contents.byteLength;
      if (outputBytes > maxOutputBytes) throw new Error("App output byte bound exceeded.");
      return { path, bytes: file.contents, sha256: sha256(file.contents), byteLength: file.contents.byteLength,
        contentType: path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" };
    }).sort((a, b) => a.path < b.path ? -1 : 1);
    const passiveDigests = new Set([...inputs.values()].filter(file => passiveExtensions.has(posix.extname(file.path))).map(file => file.sha256));
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        const embedded = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(imported.path);
        if (imported.kind !== "url-token" || !embedded || !passiveMimeTypes.has(embedded[1]!)) throw new Error("App compiler retained an output import.");
        const bytes = embedded[2] ? Buffer.from(embedded[3]!, "base64") : Buffer.from(decodeURIComponent(embedded[3]!), "utf8");
        if (!passiveDigests.has(sha256(bytes))) throw new Error("App compiler emitted an undeclared passive asset.");
      }
    }
    const dependencyLockDigest = recordDigest("dohc-app-dependencies-v1", dependencyLock);
    const bundleDigest = recordDigest("dohc-app-bundle-v1", files.map(({ bytes: _, ...file }) => file));
    const buildDigest = recordDigest("dohc-app-build-v1", { sourceDigest, dependencyLockDigest, compiler, bundleDigest });
    return { sourceDigest, dependencyLock, dependencyLockDigest, compiler, files, bundleDigest, buildDigest };
  } finally {
    // This fresh task-owned directory never contains workspace files; esbuild cannot write to it.
    await rm(directory, { recursive: true, force: true });
  }
}
