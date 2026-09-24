import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { parse } from "acorn";
import * as esbuild from "esbuild";
import { defaultTreeAdapter, parse as parseHtml, serialize, type DefaultTreeAdapterTypes } from "parse5";

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

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const pageNamespace = "dohc-app-page";

/** An HTML entry compiled into the same two-file bundle a script entry produces. */
interface ClosedAppPage {
  /** Rebuilds the page's document, then runs its classic scripts in document order at global scope. */
  script: string;
  /** Module source esbuild bundles: the page's stylesheets and module scripts, in document order. */
  module: string;
  /** Inline style and module script bodies, keyed by the specifiers `module` imports. */
  inline: ReadonlyMap<string, { contents: string; loader: "css" | "js" }>;
  /** Captured files the page uses outside esbuild: classic scripts and embedded images. */
  used: ReadonlySet<string>;
}

const htmlNamespace = "http://www.w3.org/1999/xhtml";
const imageTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"]]);
const javascriptType = /^(?:text\/(?:javascript|ecmascript|jscript|x-javascript|x-ecmascript)|application\/(?:javascript|ecmascript))$/i;
const moduleScript = /\.(?:js|jsx|ts|tsx)$/;
const attributeName = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find(attr => attr.name === name)?.value;
}
const textOf = (element: Element) => element.childNodes.map(child => defaultTreeAdapter.isTextNode(child) ? child.value : "").join("");

/** Null marks a data block, which stays in the page as inert markup. */
function scriptKind(element: Element): "classic" | "module" | "skip" | null {
  const type = attribute(element, "type")?.trim() ?? "";
  if (type.toLowerCase() === "module") return "module";
  if (type !== "" && !javascriptType.test(type.split(";", 1)[0]!.trim())) return null;
  return attribute(element, "nomodule") === undefined ? "classic" : "skip";
}

function classicScript(source: string, label: string): string {
  let program;
  try { program = parse(source, { ecmaVersion: "latest", sourceType: "script" }); }
  catch (error) { throw new Error(`${label} is not valid JavaScript: ${(error as Error).message}.`); }
  const pending: unknown[] = [program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if ((node as { type?: unknown }).type === "ImportExpression") throw new Error(`${label} imports a module. Load it with <script type="module"> instead.`);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) pending.push(item);
      else pending.push(child);
    }
  }
  return source;
}

/** Compiles captured bytes only. Remote scripts and stylesheets stay out, as they do for script entries. */
function compileClosedAppPage(entry: string, inputs: ReadonlyMap<string, { bytes: Uint8Array }>): ClosedAppPage {
  const directory = posix.dirname(entry);
  const document = parseHtml(text(inputs.get(entry)!.bytes));
  const classic: string[] = [], imports: string[] = [], used = new Set<string>();
  const inline = new Map<string, { contents: string; loader: "css" | "js" }>();
  let title: string | null = null;
  const local = (reference: string, test: RegExp, kind: string, allowed: string): string => {
    const value = reference.trim();
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(value)) throw new Error(`${entry} loads ${value} from outside the app. Save a copy in the app folder and link to that instead.`);
    let decoded = "";
    try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]!); } catch { /* reported below as a missing file */ }
    const path = decoded && posix.normalize(posix.join(directory, decoded.replace(/^\/+/, "")));
    if (!path || !inputs.has(path)) throw new Error(`${entry} links ${value}, which is not in the app. Add the file or fix the link.`);
    if (!test.test(path)) throw new Error(`${entry} links ${value} as ${kind}. Use ${allowed} file instead.`);
    return path;
  };
  const specifier = (path: string) => `./${posix.relative(directory, path)}`;
  const addInline = (contents: string, loader: "css" | "js") => {
    const key = `dohc-page:${inline.size}.${loader}`;
    inline.set(key, { contents, loader });
    imports.push(key);
  };
  const visit = (parent: ParentNode) => {
    for (const node of [...parent.childNodes]) {
      if (!defaultTreeAdapter.isElementNode(node)) continue;
      const handler = node.attrs.find(attr => /^on/i.test(attr.name));
      if (handler) throw new Error(`${entry} has an ${handler.name} attribute. Published apps cannot run inline event handlers. Attach the handler in a script.`);
      const html = node.namespaceURI === htmlNamespace;
      if (html && node.tagName === "title" && title === null) title = textOf(node);
      if (html && node.tagName === "script") {
        const kind = scriptKind(node), src = attribute(node, "src");
        if (kind === null) continue;
        defaultTreeAdapter.detachNode(node);
        const body = textOf(node);
        if (kind === "module") {
          if (src === undefined) addInline(body, "js");
          else imports.push(specifier(local(src, moduleScript, "a module script", "a .js, .jsx, .ts, or .tsx")));
        } else if (kind === "classic") {
          if (src === undefined) classic.push(classicScript(body, `A script in ${entry}`));
          else {
            const path = local(src, /\.js$/, "a script", "a .js");
            used.add(path);
            classic.push(classicScript(text(inputs.get(path)!.bytes), path));
          }
        }
        continue;
      }
      if (html && node.tagName === "style") {
        defaultTreeAdapter.detachNode(node);
        addInline(textOf(node), "css");
        continue;
      }
      const rel = html && node.tagName === "link" ? (attribute(node, "rel") ?? "").toLowerCase().split(/\s+/) : [];
      if (rel.includes("stylesheet") && !rel.includes("alternate")) {
        defaultTreeAdapter.detachNode(node);
        imports.push(specifier(local(attribute(node, "href") ?? "", /\.css$/, "a stylesheet", "a .css")));
        continue;
      }
      const src = html && node.tagName === "img" ? attribute(node, "src") : undefined;
      if (src !== undefined && !/^(?:https?:|data:|blob:)/i.test(src.trim())) {
        const path = local(src, /\.(?:png|jpe?g|gif|webp|avif)$/, "an image", "a PNG, JPEG, GIF, WebP, or AVIF");
        used.add(path);
        const image = node.attrs.find(attr => attr.name === "src")!;
        image.value = `data:${imageTypes.get(posix.extname(path))};base64,${Buffer.from(inputs.get(path)!.bytes).toString("base64")}`;
      }
      visit(node);
    }
  };
  visit(document);
  const root = document.childNodes.find(defaultTreeAdapter.isElementNode);
  const body = root?.childNodes.find((node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "body");
  const attributes = (element: Element | undefined) => (element?.attrs ?? []).filter(attr => attributeName.test(attr.name)).map(attr => [attr.name, attr.value]);
  const setup = { html: attributes(root), title, body: attributes(body), markup: body ? serialize(body) : "" };
  const script = `(()=>{const page=${JSON.stringify(setup)},root=document.documentElement;` +
    "for(const[name,value]of page.html)root.setAttribute(name,value);if(page.title!==null)document.title=page.title;" +
    "for(const[name,value]of page.body)document.body.setAttribute(name,value);document.body.innerHTML=page.markup;})();";
  // One classic script keeps each script's top-level names global, as separate script tags would.
  return { script: [script, ...classic].join("\n;\n"), module: imports.map(path => `import ${JSON.stringify(path)};`).join("\n"), inline, used };
}

async function assertScript(source: string, loader: esbuild.Loader): Promise<void> {
  const transformed = await esbuild.transform(source, { loader, target: "es2022", tsconfigRaw, ...scriptOptions, sourcemap: false, legalComments: "none", logLevel: "silent" });
  assertStaticModuleSyntax(transformed.code);
}

/** esbuild's own message starts with a count; a person needs the file and the reason. */
function buildFailure(error: unknown, entry: string): unknown {
  const first = error && typeof error === "object" && "errors" in error && Array.isArray(error.errors) ? error.errors[0] as esbuild.Message | undefined : undefined;
  if (!first) return error;
  const file = first.location?.file;
  const path = file?.startsWith(`${pageNamespace}:`) ? entry : file?.replace(`${namespace}:`, "");
  return new Error(path ? `${path}: ${first.text}` : first.text);
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
  const pageEntry = posix.extname(entry) === ".html";
  if (!pageEntry && !scriptLoaders.has(posix.extname(entry))) throw new Error("App entry must be a script or an HTML page.");
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
    if (!(pageEntry && path === entry) && posix.basename(path) !== "collection.yaml" && posix.extname(path) !== ".sql") loaderFor(path);
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
      absWorkingDir: directory, entryPoints: [entry], outfile: "bundle.js", bundle: true,
      write: false, metafile: true, platform: "browser", format: "iife", target: "es2022",
      tsconfigRaw, ...scriptOptions, sourcemap: false, legalComments: "none", logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error", "empty-import-meta": "error" },
      plugins: [{ name: "dohc-closed-inputs", setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          try {
            if (page && args.namespace === namespace && args.importer === entry && page.inline.has(args.path)) return { path: args.path, namespace: pageNamespace };
            let path: string;
            if (args.kind === "entry-point") path = canonicalPath(args.path);
            else {
              if (args.namespace !== namespace && args.namespace !== pageNamespace) throw new Error("App import is outside its declared inputs.");
              // An inline style or module script resolves its imports from the page.
              const importer = args.namespace === pageNamespace ? entry : args.importer;
              if (args.path.startsWith(".")) {
                if (!/^[A-Za-z0-9_@./-]+$/.test(args.path)) throw new Error("Invalid app import path.");
                path = canonicalPath(posix.normalize(posix.join(posix.dirname(importer), args.path)));
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
          if (page && args.path === entry) return { contents: page.module, loader: "js" };
          const file = inputs.get(args.path);
          if (!file) return { errors: [{ text: "App source is unavailable." }] };
          const loader = loaderFor(file.path);
          if (scriptLoaders.has(posix.extname(file.path))) await assertScript(text(file.bytes), loader);
          return { contents: file.bytes, loader };
        });
        build.onLoad({ filter: /.*/, namespace: pageNamespace }, async args => {
          const inline = page?.inline.get(args.path);
          if (!inline) return { errors: [{ text: "App source is unavailable." }] };
          if (inline.loader === "js") await assertScript(inline.contents, "js");
          return inline;
        });
      } }],
    }).catch(error => { throw buildFailure(error, entry); });
    // Inline page modules derive from the entry, which the lock already names.
    const known = (key: string) => key.startsWith(namespace + ":") ? inputs.has(key.slice(namespace.length + 1))
      : !!page && key.startsWith(pageNamespace + ":") && page.inline.has(key.slice(pageNamespace.length + 1));
    const locked = new Set(page?.used);
    for (const [key, input] of Object.entries(result.metafile.inputs)) {
      if (!known(key)) throw new Error("App compiler used an undeclared input.");
      for (const imported of input.imports) if (imported.external || !known(imported.path)) throw new Error("App compiler retained an external import.");
      if (key.startsWith(namespace + ":")) locked.add(key.slice(namespace.length + 1));
    }
    const dependencyLock = [...locked].sort().map(path => ({ path, sha256: inputs.get(path)!.sha256, byteLength: inputs.get(path)!.bytes.byteLength }));
    let outputBytes = 0;
    const files = result.outputFiles.map(file => {
      const path = posix.basename(file.path.replaceAll("\\", "/"));
      if (path !== "bundle.js" && path !== "bundle.css") throw new Error("Unexpected app compiler output.");
      // The page's document and classic scripts run before its module scripts, as a browser runs them.
      const bytes = page && path === "bundle.js" ? Buffer.concat([Buffer.from(`${page.script}\n;\n`), file.contents]) : file.contents;
      outputBytes += bytes.byteLength;
      if (outputBytes > maxOutputBytes) throw new Error("App output byte bound exceeded.");
      return { path, bytes, sha256: sha256(bytes), byteLength: bytes.byteLength,
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
