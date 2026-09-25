import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { parse } from "acorn";
import * as esbuild from "esbuild";
import { APP_BUNDLE_CONTENT_TYPES } from "@dohc/app-browser/document";
import { compileClosedAppPage, documentWrite, pageInput, pageNamespace, unsafeInlineScript } from "./closedAppPage.ts";

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
  /** maxOutputFileBytes bounds each output file and defaults to maxOutputBytes. */
  bounds: { maxInputFiles: number; maxInputBytes: number; maxOutputBytes: number; maxOutputFileBytes?: number };
}
export interface ClosedAppFileIdentity { path: string; sha256: string; byteLength: number }
export interface ClosedAppBuild {
  sourceDigest: string;
  dependencyLock: ClosedAppFileIdentity[];
  dependencyLockDigest: string;
  compiler: { recipe: "dohc-closed-app-v3"; version: string; binarySha256: string };
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
const extension = (path: string) => posix.extname(path).toLowerCase();
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function canonicalPath(path: string): string {
  if (typeof path !== "string" || !/^[A-Za-z0-9_@./-]+$/.test(path) || path.startsWith("/") ||
      path.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error("Invalid closed app path.");
  return path;
}
function loaderFor(path: string): esbuild.Loader {
  const name = posix.basename(path);
  if (name === "package.json" || /^tsconfig(?:\..*)?\.json$/.test(name)) throw new Error("App build configuration is unsupported.");
  const type = extension(path);
  const script = scriptLoaders.get(type);
  if (script) return script;
  if (type === ".json" || type === ".css") return type.slice(1) as "json" | "css";
  if (passiveExtensions.has(type)) return "dataurl";
  throw new Error("Unsupported closed app input type.");
}

function assertStaticModuleSyntax(source: string): ReturnType<typeof parse> {
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
  return ast;
}

/** A page's module code runs after the loader builds the page, so it cannot write the document either. */
async function assertScript(source: string, loader: esbuild.Loader, pageLabel?: string): Promise<void> {
  const transformed = await esbuild.transform(source, { loader, target: "es2022", tsconfigRaw, ...scriptOptions, sourcemap: false, legalComments: "none", logLevel: "silent" });
  const ast = assertStaticModuleSyntax(transformed.code);
  const write = pageLabel && documentWrite(ast);
  if (write) throw new Error(`${pageLabel} calls ${write}. Published apps cannot write markup into the page. Add the elements with DOM methods instead.`);
}

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const acceptedTypes = new Set([...scriptLoaders.keys(), ".json", ".css", ...passiveExtensions]);

/** A page publishes bundle.js and page.json; its stylesheets and module CSS go into the page, where the browser parses them. */
function pageOutputs(page: NonNullable<ReturnType<typeof compileClosedAppPage>>, built: ReadonlyMap<string, Uint8Array>, entry: string) {
  const css = (name: string) => { const bytes = built.get(name); return bytes ? text(bytes) : ""; };
  const sheets = page.stylesheets.map((_, index) => css(`page-style-${index}.css`));
  const bundle = built.get("bundle.js")!;
  if (unsafeInlineScript(text(bundle))) throw new Error(`The module scripts in ${entry} contain <!-- together with <script>, which would end the page's script early. Split one of the strings.`);
  const known = new Set(["bundle.js", "bundle.css", ...page.stylesheets.map((_, index) => `page-style-${index}.css`)]);
  if ([...built.keys()].some(name => !known.has(name))) throw new Error("Unexpected app compiler output.");
  return [{ path: "bundle.js", bytes: bundle }, { path: "page.json", bytes: new TextEncoder().encode(JSON.stringify(page.finish(sheets, css("bundle.css")))) }];
}

/** A #fragment or a passive data URL written in a stylesheet stays as written. */
function writtenAsIs(imported: { kind: string; path: string; external?: boolean }): boolean {
  return imported.external === true && imported.kind === "url-token" &&
    (imported.path.startsWith("#") || passiveMimeTypes.has(/^data:([^;,]*)/i.exec(imported.path)?.[1]?.toLowerCase() ?? ""));
}

/** Our own refusals already name the file. esbuild's syntax errors get the file and line. */
function buildFailure(error: unknown, entry: string): unknown {
  const first = error && typeof error === "object" && "errors" in error && Array.isArray(error.errors) ? error.errors[0] as esbuild.Message | undefined : undefined;
  if (!first) return error;
  if (first.pluginName === "dohc-closed-inputs") return new Error(first.text);
  const file = first.location?.file;
  const path = file?.startsWith(`${pageNamespace}:`) ? entry : file?.replace(`${namespace}:`, "");
  return new Error(path ? `${path}:${first.location!.line}: ${first.text}` : first.text);
}

async function compilerIdentity(): Promise<ClosedAppBuild["compiler"]> {
  // Match esbuild 0.28.1's installed native-package resolution; refuse override/fallback binaries.
  if (binaryOverrideAtImport || process.env.ESBUILD_BINARY_PATH || esbuild.version !== "0.28.1" ||
      !["win32", "linux", "darwin"].includes(process.platform)) throw new Error("Unsupported app compiler installation.");
  const require = createRequire(import.meta.url);
  const compilerRequire = createRequire(require.resolve("esbuild"));
  const binary = compilerRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
  return { recipe: "dohc-closed-app-v3", version: esbuild.version, binarySha256: sha256(await readFile(binary)) };
}

/** Compile captured bytes only. The caller owns source authority and process resource enforcement. */
export async function compileClosedApp(request: ClosedAppBuildRequest): Promise<ClosedAppBuild> {
  const { maxInputFiles, maxInputBytes, maxOutputBytes } = request.bounds;
  const maxOutputFileBytes = request.bounds.maxOutputFileBytes ?? maxOutputBytes;
  for (const bound of [maxInputFiles, maxInputBytes, maxOutputBytes, maxOutputFileBytes]) {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new Error("Invalid app compiler bound.");
  }
  if (!Array.isArray(request.inputs) || request.inputs.length === 0 || request.inputs.length > maxInputFiles) throw new Error("App input file bound exceeded.");
  const entry = canonicalPath(request.entryPath);
  const pageEntry = extension(entry) === ".html";
  if (!pageEntry && !scriptLoaders.has(extension(entry))) throw new Error("App entry must be a script or an HTML page.");
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
    // An HTML file is accepted only as the page entry.
    if (!(pageEntry && path === entry) && posix.basename(path) !== "collection.yaml" && extension(path) !== ".sql") loaderFor(path);
    if (inputs.has(path) || !(file.bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid app input inventory.");
    inputBytes += file.bytes.byteLength + Buffer.byteLength(path);
    if (inputBytes > maxInputBytes) throw new Error("App input byte bound exceeded.");
    const bytes = Uint8Array.from(file.bytes);
    if (sha256(bytes) !== file.sha256) throw new Error("App input digest mismatch.");
    inputs.set(path, { path, bytes, sha256: file.sha256 });
  }
  if (!inputs.has(entry)) throw new Error("App entry is outside its declared inputs.");
  for (const path of packages.values()) if (!inputs.has(path)) throw new Error("App package is outside its declared inputs.");
  const page = pageEntry ? compileClosedAppPage(entry, inputs) : null;
  const inventory = [...inputs.values()].map(({ path, bytes, sha256 }) => ({ path, sha256, byteLength: bytes.byteLength })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceDigest = recordDigest("dohc-app-source-v2", { entry, files: inventory, packages: [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) });
  const compiler = await compilerIdentity();
  const directory = await mkdtemp(join(tmpdir(), "dohc-app-compiler-"));
  try {
    const result = await esbuild.build({
      // A page's stylesheets are their own entries, so each keeps its place and identity in the page.
      absWorkingDir: directory, entryPoints: [{ in: entry, out: "bundle" }, ...(page?.stylesheets ?? []).map((sheet, index) => ({ in: sheet, out: `page-style-${index}` }))],
      outdir: "out", bundle: true,
      write: false, metafile: true, platform: "browser", format: "iife", target: "es2022",
      tsconfigRaw, ...scriptOptions, sourcemap: false, legalComments: "none", logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error", "empty-import-meta": "error" },
      plugins: [{ name: "dohc-closed-inputs", setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.kind === "entry-point") {
            if (page?.inline.has(args.path)) return { path: args.path, namespace: pageNamespace };
            if (page && args.path.startsWith(pageInput) && inputs.has(args.path.slice(pageInput.length))) return { path: args.path.slice(pageInput.length), namespace };
            return { path: canonicalPath(args.path), namespace };
          }
          const inPage = args.namespace === pageNamespace;
          const importer = inPage ? entry : args.importer;
          // Only the generated entry names inline sources and resolved files; page code cannot.
          const generated = page && args.namespace === namespace && args.importer === entry;
          if (generated && page.inline.has(args.path)) return { path: args.path, namespace: pageNamespace };
          if (generated && args.path.startsWith(pageInput) && inputs.has(args.path.slice(pageInput.length))) return { path: args.path.slice(pageInput.length), namespace };
          if (args.namespace !== namespace && !inPage) return { errors: [{ text: `${importer} imports ${args.path}, which is outside the app.` }] };
          // CSS names files by URL: a bare name is relative to the stylesheet, and #fragment points into the document.
          const css = args.kind === "url-token" || args.kind === "import-rule" || args.kind === "composes-from";
          if (css && args.path.startsWith("#")) return { path: args.path, external: true };
          if (css && /^data:/i.test(args.path)) {
            const type = /^data:([^;,]*)/i.exec(args.path)![1]!.toLowerCase();
            return passiveMimeTypes.has(type) ? { path: args.path, external: true } : { errors: [{ text: `${importer} embeds a data URL of type ${type || "unknown"}. Use an image or a WOFF2 font instead.` }] };
          }
          const specifier = css ? args.path.split(/[?#]/, 1)[0]! : args.path;
          const relative = specifier.startsWith(".") || (css && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/)/.test(specifier));
          if (!relative) {
            const path = css ? undefined : packages.get(specifier);
            if (path && inputs.has(path)) return { path, namespace };
            return { errors: [{ text: css ? `${importer} loads ${args.path} from outside the app. Save a copy in the app folder and link to that instead.`
              : `${importer} imports the package ${args.path}, which app.publish.json does not map.` }] };
          }
          let decoded = specifier;
          try { if (css) decoded = decodeURIComponent(specifier); } catch { /* reported below as a missing file */ }
          const path = posix.normalize(posix.join(inPage ? page!.base : posix.dirname(args.importer), decoded));
          const refuse = (text: string) => ({ errors: [{ text: `${importer} imports ${args.path}${text}` }] });
          if (path === ".." || path.startsWith("../")) return refuse(", which is outside the workspace.");
          if (!/^[A-Za-z0-9_@./-]+$/.test(path)) return refuse(". Rename it using only letters, digits, and _ @ . / -, then publish again.");
          if (!acceptedTypes.has(extension(path))) return refuse(`. Published apps can include only JavaScript, TypeScript, JSON, CSS, images, and WOFF2 fonts, not ${extension(path) || "files without a type"}.`);
          if (!inputs.has(path)) return refuse(", which is not in the app. Add the file, or list it in app.publish.json.");
          return { path, namespace };
        });
        build.onLoad({ filter: /.*/, namespace }, async args => {
          if (page && args.path === entry) return { contents: page.module, loader: "js" };
          const file = inputs.get(args.path);
          if (!file) return { errors: [{ text: "App source is unavailable." }] };
          const loader = loaderFor(file.path);
          if (scriptLoaders.has(extension(file.path))) await assertScript(text(file.bytes), loader, page ? file.path : undefined);
          return { contents: file.bytes, loader };
        });
        build.onLoad({ filter: /.*/, namespace: pageNamespace }, async args => {
          const inline = page?.inline.get(args.path);
          if (!inline) return { errors: [{ text: "App source is unavailable." }] };
          if (inline.loader === "js") await assertScript(inline.contents, "js", `A module script in ${entry}`);
          return inline;
        });
      } }],
    }).catch(error => { throw buildFailure(error, entry); });
    // Inline page modules derive from the entry, which the lock already names.
    const known = (key: string) => key.startsWith(namespace + ":") ? inputs.has(key.slice(namespace.length + 1))
      : !!page && key.startsWith(pageNamespace + ":") && page.inline.has(key.slice(pageNamespace.length + 1));
    const locked = new Set(page?.used.keys());
    for (const [key, input] of Object.entries(result.metafile.inputs)) {
      if (!known(key)) throw new Error("App compiler used an undeclared input.");
      for (const imported of input.imports) if (imported.external ? !writtenAsIs(imported) : !known(imported.path)) throw new Error("App compiler retained an external import.");
      if (key.startsWith(namespace + ":")) locked.add(key.slice(namespace.length + 1));
    }
    const dependencyLock = [...locked].sort().map(path => ({ path, sha256: inputs.get(path)!.sha256, byteLength: inputs.get(path)!.bytes.byteLength }));
    const built = new Map(result.outputFiles.map(file => [posix.basename(file.path.replaceAll("\\", "/")), file.contents]));
    const outputs = page ? pageOutputs(page, built, entry) : [...built].map(([path, bytes]) => ({ path, bytes }));
    const outputBytes = outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
    const oversized = outputs.find(output => output.bytes.byteLength > maxOutputFileBytes);
    if (outputBytes > maxOutputBytes || oversized) {
      const image = page && [...page.images].sort((a, b) => b[1] - a[1])[0];
      const largestImage = image ? ` The largest image is ${image[0]} (${size(image[1])}). Use smaller images.` : "";
      if (oversized?.path === "page.json" && image) {
        throw new Error(`${entry} is ${size(oversized.bytes.byteLength)} once its images are embedded. A published page can be at most ${size(maxOutputFileBytes)}.${largestImage}`);
      }
      const [bytes, limit] = oversized ? [oversized.bytes.byteLength, maxOutputFileBytes] : [outputBytes, maxOutputBytes];
      throw new Error(`The built app is ${size(bytes)}. A published app can be at most ${size(limit)}.${largestImage || " Remove files and dependencies the app does not use."}`);
    }
    const files = outputs.map(({ path, bytes }) => {
      if (path !== "bundle.js" && path !== "bundle.css" && path !== "page.json") throw new Error("Unexpected app compiler output.");
      return { path, bytes, sha256: sha256(bytes), byteLength: bytes.byteLength, contentType: APP_BUNDLE_CONTENT_TYPES[path]! };
    }).sort((a, b) => a.path < b.path ? -1 : 1);
    const passiveDigests = new Set([...inputs.values()].filter(file => passiveExtensions.has(extension(file.path))).map(file => file.sha256));
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (imported.external && writtenAsIs(imported)) continue;
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
