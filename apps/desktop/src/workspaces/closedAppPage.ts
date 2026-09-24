import { posix } from "node:path";
import { parse as parseScript } from "acorn";
import { defaultTreeAdapter, parse as parseHtml, serialize, type DefaultTreeAdapterTypes } from "parse5";
import type { AppPage } from "@dohc/app-browser/document";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** esbuild namespace for a page's inline styles and module scripts. */
export const pageNamespace = "dohc-app-page";

/** An HTML entry compiled into a page record, plus the module source esbuild bundles into bundle.js and bundle.css. */
export interface ClosedAppPage {
  page: AppPage;
  /** The page's stylesheets and module scripts, in document order. */
  module: string;
  /** Inline style and module script bodies, keyed by the specifiers `module` imports. */
  inline: ReadonlyMap<string, { contents: string; loader: "css" | "js" }>;
  /** The directory a page's inline modules resolve their imports from. */
  base: string;
  /** Captured files the page uses outside esbuild: classic scripts and embedded images. */
  used: ReadonlySet<string>;
}

const htmlNamespace = "http://www.w3.org/1999/xhtml";
const imageTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"]]);
const javascriptType = /^(?:text\/(?:javascript|ecmascript|jscript|x-javascript|x-ecmascript)|application\/(?:javascript|ecmascript))$/i;
const attributeName = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const publishableName = /^[A-Za-z0-9_@./-]+$/;
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const attribute = (element: Element, name: string) => element.attrs.find(attr => attr.name === name)?.value;
const textOf = (element: Element) => element.childNodes.map(child => defaultTreeAdapter.isTextNode(child) ? child.value : "").join("");
const extension = (path: string) => posix.extname(path).toLowerCase();
const kinds = {
  script: { test: [".js"], words: "a script", allowed: "a .js" },
  module: { test: [".js", ".jsx", ".ts", ".tsx"], words: "a module script", allowed: "a .js, .jsx, .ts, or .tsx" },
  stylesheet: { test: [".css"], words: "a stylesheet", allowed: "a .css" },
  image: { test: [...imageTypes.keys()], words: "an image", allowed: "a PNG, JPEG, GIF, WebP, or AVIF" },
} as const;

/** Null marks a data block, which stays in the page as inert markup. */
function scriptKind(element: Element): "classic" | "module" | "skip" | null {
  const type = attribute(element, "type")?.trim() ?? "";
  if (type.toLowerCase() === "module") return "module";
  if (type !== "" && !javascriptType.test(type.split(";", 1)[0]!.trim())) return null;
  return attribute(element, "nomodule") === undefined ? "classic" : "skip";
}

/** A classic script runs as written; the build only checks that it parses and loads no module. */
function classicScript(source: string, label: string): string {
  let program;
  try { program = parseScript(source, { ecmaVersion: "latest", sourceType: "script" }); }
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

/** Splits a srcset into URLs and descriptors, keeping commas inside data URLs. */
function srcset(value: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index]!)) index++;
    if (index >= value.length) break;
    let end = index;
    while (end < value.length && !/\s/.test(value[end]!)) end++;
    let url = value.slice(index, end), descriptor = "";
    if (url.endsWith(",")) { url = url.replace(/,+$/, ""); index = end; }
    else {
      let stop = end;
      while (stop < value.length && value[stop] !== ",") stop++;
      descriptor = value.slice(end, stop).trim(); index = stop + 1;
    }
    candidates.push({ url, descriptor });
  }
  return candidates;
}

/** Compiles captured bytes only. Remote scripts and stylesheets stay out, as they do for script entries. */
export function compileClosedAppPage(entry: string, inputs: ReadonlyMap<string, { bytes: Uint8Array }>): ClosedAppPage {
  const document = parseHtml(text(inputs.get(entry)!.bytes));
  const scripts: string[] = [], deferred: Array<string | null> = [], imports: string[] = [], used = new Set<string>();
  const inline = new Map<string, { contents: string; loader: "css" | "js" }>();
  let title: string | null = null, base = posix.dirname(entry), bundleQueued = false;
  // Template content is inert until app code clones it: resolve its resources, but run nothing from it.
  const inert = new Set<Element>();
  const elements = (parent: ParentNode, inTemplate: boolean): Element[] => parent.childNodes.flatMap(node => {
    if (!defaultTreeAdapter.isElementNode(node)) return [];
    if (inTemplate) inert.add(node);
    const content = node.namespaceURI === htmlNamespace && "content" in node ? (node as DefaultTreeAdapterTypes.Template).content : null;
    return [node, ...elements(content ?? node, inTemplate || content !== null)];
  });
  // The synthetic entry module imports from the entry's own directory.
  const fromEntry = (path: string) => `./${posix.relative(posix.dirname(entry), path)}`;
  const outside = (value: string) => `${entry} loads ${value} from outside the app. Save a copy in the app folder and link to that instead.`;
  /** Resolves a local reference to a captured input, or refuses it with the file and the reason. */
  const local = (reference: string, kind: keyof typeof kinds): string => {
    const value = reference.trim();
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(value)) throw new Error(outside(value));
    let decoded: string;
    try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]!); } catch { throw new Error(`${entry} links ${value}, which is not a valid file address.`); }
    const path = posix.normalize(posix.join(decoded.startsWith("/") ? posix.dirname(entry) : base, decoded));
    if (!decoded || path === ".." || path.startsWith("../")) throw new Error(outside(value));
    if (!publishableName.test(path)) throw new Error(`${entry} links ${decoded}. Rename it using only letters, digits, and _ @ . / -, then publish again.`);
    const expected = kinds[kind];
    if (!(expected.test as readonly string[]).includes(extension(path))) throw new Error(`${entry} links ${value} as ${expected.words}. Use ${expected.allowed} file instead.`);
    if (!inputs.has(path)) throw new Error(`${entry} links ${value}, which is not in the app. Add the file or fix the link.`);
    return path;
  };
  /** A remote, data, blob, or fragment image stays as written; a local one becomes a data URL. */
  const image = (value: string): string => {
    if (/^(?:https?:|data:|blob:|#|\/\/)/i.test(value.trim()) || value.trim() === "") return value;
    const path = local(value, "image");
    used.add(path);
    return `data:${imageTypes.get(extension(path))};base64,${Buffer.from(inputs.get(path)!.bytes).toString("base64")}`;
  };
  const refuseEmbed = (element: Element, value: string | undefined) => {
    if (value !== undefined && value.trim() !== "" && value.trim() !== "about:blank") throw new Error(`${entry} embeds ${value.trim()} in <${element.tagName}>. Published apps cannot embed other pages or files.`);
  };
  const setAttribute = (element: Element, name: string, value: string) => { element.attrs.find(attr => attr.name === name)!.value = value; };
  const all = elements(document, false);
  const baseElement = all.find(element => element.tagName === "base" && element.namespaceURI === htmlNamespace && attribute(element, "href") !== undefined);
  if (baseElement) {
    const href = attribute(baseElement, "href")!.trim();
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(href)) throw new Error(`${entry} sets its base address to ${href}. Remove the <base> element so the page's links point into the app.`);
    const resolved = posix.normalize(posix.join(href.startsWith("/") ? posix.dirname(entry) : base, href.endsWith("/") ? href : posix.dirname(`${href}x`)));
    if (resolved === ".." || resolved.startsWith("../")) throw new Error(outside(href));
    base = resolved;
  }
  for (const element of all) {
    if (element.tagName === "base" && element.namespaceURI === htmlNamespace) { defaultTreeAdapter.detachNode(element); continue; }
    const handler = element.attrs.find(attr => /^on/i.test(attr.name));
    if (handler) throw new Error(`${entry} has an ${handler.name} attribute. Published apps cannot run inline event handlers. Attach the handler in a script.`);
    const style = attribute(element, "style");
    if (style !== undefined) setAttribute(element, "style", style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, quote: string, url: string) => `url(${quote}${image(url)}${quote})`));
    const html = element.namespaceURI === htmlNamespace;
    const tag = element.tagName;
    if (!html) {
      for (const name of ["href", "xlink:href"]) {
        const value = attribute(element, name);
        if (value !== undefined && (tag === "image" || tag === "use" || tag === "feImage")) setAttribute(element, name, image(value));
      }
      continue;
    }
    if (tag === "title" && title === null && !inert.has(element)) title = textOf(element);
    if ((tag === "script" || tag === "style" || tag === "link") && inert.has(element)) continue;
    if (tag === "script") {
      const kind = scriptKind(element), src = attribute(element, "src");
      if (kind === null) continue;
      defaultTreeAdapter.detachNode(element);
      if (kind === "module") {
        if (src === undefined) {
          const key = `dohc-page:${inline.size}.js`;
          inline.set(key, { contents: textOf(element), loader: "js" });
          imports.push(key);
        } else imports.push(fromEntry(local(src, "module")));
        if (!bundleQueued) { deferred.push(null); bundleQueued = true; }
      } else if (kind === "classic") {
        if (src === undefined) scripts.push(classicScript(textOf(element), `A script in ${entry}`));
        else {
          const path = local(src, "script");
          used.add(path);
          (attribute(element, "defer") === undefined ? scripts : deferred).push(classicScript(text(inputs.get(path)!.bytes), path));
        }
      }
      continue;
    }
    if (tag === "style") {
      defaultTreeAdapter.detachNode(element);
      const key = `dohc-page:${inline.size}.css`;
      inline.set(key, { contents: textOf(element), loader: "css" });
      imports.push(key);
      continue;
    }
    const rel = tag === "link" ? (attribute(element, "rel") ?? "").toLowerCase().split(/\s+/) : [];
    if (rel.includes("stylesheet") && !rel.includes("alternate")) {
      defaultTreeAdapter.detachNode(element);
      imports.push(fromEntry(local(attribute(element, "href") ?? "", "stylesheet")));
      continue;
    }
    const parent = element.parentNode && defaultTreeAdapter.isElementNode(element.parentNode) ? element.parentNode.tagName : "";
    const media = tag === "video" || tag === "audio" || tag === "track" || (tag === "source" && parent !== "picture");
    if (media) {
      const src = attribute(element, "src");
      if (src !== undefined && !/^(?:https?:|data:|blob:)/i.test(src.trim())) throw new Error(`${entry} links ${src} as audio or video. Published apps cannot include local audio or video. Link to a copy on another site.`);
    }
    if (tag === "iframe" || tag === "frame" || tag === "embed") refuseEmbed(element, attribute(element, "src"));
    if (tag === "object") refuseEmbed(element, attribute(element, "data"));
    const imageSource = (tag === "img" || (tag === "input" && attribute(element, "type")?.toLowerCase() === "image") || (tag === "source" && !media)) ? attribute(element, "src") : undefined;
    if (imageSource !== undefined) setAttribute(element, "src", image(imageSource));
    const poster = tag === "video" ? attribute(element, "poster") : undefined;
    if (poster !== undefined) setAttribute(element, "poster", image(poster));
    const set = tag === "img" || tag === "source" ? attribute(element, "srcset") : undefined;
    if (set !== undefined) setAttribute(element, "srcset", srcset(set).map(({ url, descriptor }) => descriptor ? `${image(url)} ${descriptor}` : image(url)).join(", "));
  }
  if (!bundleQueued) deferred.push(null);
  const root = document.childNodes.find(defaultTreeAdapter.isElementNode);
  const body = root?.childNodes.find((node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "body");
  const attributes = (element: Element | undefined) => (element?.attrs ?? []).filter(attr => attributeName.test(attr.name)).map(attr => [attr.name, attr.value] as [string, string]);
  return {
    page: { html: attributes(root), title, body: attributes(body), markup: body ? serialize(body) : "", scripts, deferred },
    module: imports.map(path => `import ${JSON.stringify(path)};`).join("\n"), inline, base, used,
  };
}
