import { posix } from "node:path";
import { parse as parseScript } from "acorn";
import { defaultTreeAdapter, parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import { APP_PAGE_MAX_DEPTH, APP_PAGE_MAX_SCRIPTS, APP_PAGE_MODULES_GLOBAL, type AppPage, type AppPageAttribute, type AppPageElement, type AppPageNode, type AppPageValue } from "@dohc/app-browser/document";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.ChildNode;

/** esbuild namespace for a page's inline styles, module scripts, and the stylesheet that imports them all. */
export const pageNamespace = "dohc-app-page";
/** The page's stylesheets in document order, with their media conditions. */
export const pageStyles = "dohc-page:styles.css";
/** Resolved captured files the entry and the page stylesheet import, never user code. */
export const pageInput = "dohc-input:";

/** An HTML entry compiled into a page record, plus the module source esbuild bundles into bundle.js and bundle.css. */
export interface ClosedAppPage {
  page: AppPage;
  /** The entry module: imports the page stylesheet and hands each module script to the loader, unevaluated. */
  module: string;
  /** Inline style and module script bodies, and the page stylesheet, by specifier. */
  inline: ReadonlyMap<string, { contents: string; loader: "css" | "js" }>;
  /** The directory inline modules and styles resolve their imports from. */
  base: string;
  /** Captured files the page uses outside esbuild: classic scripts and embedded images, with their sizes. */
  used: ReadonlyMap<string, number>;
  /** Embedded images by path. */
  images: ReadonlyMap<string, number>;
}

const spaces = { html: "http://www.w3.org/1999/xhtml", svg: "http://www.w3.org/2000/svg", math: "http://www.w3.org/1998/Math/MathML" };
const attributeSpaces: Record<string, "xlink" | "xml" | "xmlns"> = {
  "http://www.w3.org/1999/xlink": "xlink", "http://www.w3.org/XML/1998/namespace": "xml", "http://www.w3.org/2000/xmlns/": "xmlns" };
const imageTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"]]);
const javascriptType = /^(?:text\/(?:javascript|ecmascript|jscript|x-javascript|x-ecmascript)|application\/(?:javascript|ecmascript))$/i;
const remote = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;
const publishableName = /^[A-Za-z0-9_@./-]+$/;
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const attribute = (element: Element, name: string) => element.attrs.find(attr => attr.name === name && !attr.namespace)?.value;
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

/**
 * A published page builds its document from a script, so document.write
 * cannot place markup where the script stands. Returns the call it finds.
 */
export function documentWrite(program: unknown): string | null {
  const pending: unknown[] = [program];
  while (pending.length) {
    const node = pending.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== "object") continue;
    if (node.type === "MemberExpression" && !node.computed) {
      const object = node.object as { type?: string; name?: string; property?: { name?: string } };
      const name = (node.property as { name?: string }).name;
      const isDocument = (object.type === "Identifier" && object.name === "document") ||
        (object.type === "MemberExpression" && object.property?.name === "document");
      if (isDocument && (name === "write" || name === "writeln")) return `document.${name}`;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) pending.push(item);
      else if (child && typeof child === "object") pending.push(child);
    }
  }
  return null;
}

/** A classic script runs as written; the build only checks that it parses, loads no module, and does not write the document. */
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
  const write = documentWrite(program);
  if (write) throw new Error(`${label} calls ${write}. Published apps cannot write markup where a script stands. Add the elements with DOM methods instead.`);
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

/** Joins value parts, merging adjacent text, and keeps a plain string when no image is embedded. */
function joined(parts: Array<string | number>): AppPageValue {
  const merged: Array<string | number> = [];
  for (const part of parts) {
    if (typeof part === "string" && typeof merged.at(-1) === "string") merged[merged.length - 1] += part;
    else if (part !== "") merged.push(part);
  }
  return merged.every(part => typeof part === "string") ? merged.join("") : merged;
}

/** Compiles captured bytes only. Remote scripts and stylesheets stay out, as they do for script entries. */
export function compileClosedAppPage(entry: string, inputs: ReadonlyMap<string, { bytes: Uint8Array }>): ClosedAppPage {
  const document = parseHtml(text(inputs.get(entry)!.bytes));
  const scripts: string[] = [], modules: string[] = [], styles: string[] = [], images: string[] = [];
  const imageIndex = new Map<string, number>(), used = new Map<string, number>(), embedded = new Map<string, number>();
  const inline = new Map<string, { contents: string; loader: "css" | "js" }>();
  const outside = (value: string) => `${entry} loads ${value} from outside the app. Save a copy in the app folder and link to that instead.`;
  const root = document.childNodes.find(defaultTreeAdapter.isElementNode);
  const head = root?.childNodes.find((node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "head");
  const body = root?.childNodes.find((node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "body");
  if (!root || !head || !body) throw new Error(`${entry} uses <frameset>. Published apps need a page with a <body>.`);

  // The first <base href> outside template content sets the page's base address.
  const findBase = (parent: Element): Element | undefined => {
    for (const node of parent.childNodes) {
      if (!defaultTreeAdapter.isElementNode(node) || node.namespaceURI !== spaces.html || node.tagName === "template") continue;
      if (node.tagName === "base" && attribute(node, "href") !== undefined) return node;
      const found = findBase(node);
      if (found) return found;
    }
    return undefined;
  };
  const baseElement = findBase(root);
  let base = posix.dirname(entry);
  if (baseElement) {
    const href = attribute(baseElement, "href")!.trim();
    if (remote.test(href)) throw new Error(`${entry} sets its base address to ${href}. Remove the <base> element so the page's links point into the app.`);
    const resolved = posix.normalize(posix.join(href.startsWith("/") ? posix.dirname(entry) : base, href.endsWith("/") ? href : posix.dirname(`${href}x`)));
    if (resolved === ".." || resolved.startsWith("../")) throw new Error(outside(href));
    base = resolved;
  }

  /** Resolves a local reference to a captured input, or refuses it with the file and the reason. */
  const local = (reference: string, kind: keyof typeof kinds): string => {
    const value = reference.trim();
    if (remote.test(value)) throw new Error(outside(value));
    let decoded: string;
    try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]!); } catch { throw new Error(`${entry} links ${value}, which is not a valid file address.`); }
    const path = posix.normalize(posix.join(decoded.startsWith("/") ? posix.dirname(entry) : base, decoded));
    if (!decoded || path === ".." || path.startsWith("../")) throw new Error(outside(value));
    if (!publishableName.test(path)) throw new Error(`${entry} links ${decoded}. Rename it using only letters, digits, and _ @ . / -, then publish again.`);
    const expected = kinds[kind];
    if (!(expected.test as readonly string[]).includes(extension(path))) throw new Error(`${entry} links ${value} as ${expected.words}. Use ${expected.allowed} file instead.`);
    if (!inputs.has(path)) throw new Error(`${entry} links ${value}, which is not in the app. Add the file or fix the link.`);
    used.set(path, inputs.get(path)!.bytes.byteLength);
    return path;
  };
  /** A remote, data, blob, or fragment image stays as written; a local one is embedded once and referenced by number. */
  const image = (value: string): string | number => {
    if (/^(?:https?:|data:|blob:|#|\/\/)/i.test(value.trim()) || value.trim() === "") return value;
    const path = local(value, "image");
    if (!imageIndex.has(path)) {
      imageIndex.set(path, images.length);
      embedded.set(path, inputs.get(path)!.bytes.byteLength);
      images.push(`data:${imageTypes.get(extension(path))};base64,${Buffer.from(inputs.get(path)!.bytes).toString("base64")}`);
    }
    return imageIndex.get(path)!;
  };
  const cssImages = (value: string): AppPageValue => {
    const parts: Array<string | number> = [];
    let last = 0;
    for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      const url = match[2]!, start = match.index + match[0].indexOf(url, 4);
      parts.push(value.slice(last, start), image(url));
      last = start + url.length;
    }
    return joined([...parts, value.slice(last)]);
  };
  const addScript = (source: string) => {
    if (scripts.length >= APP_PAGE_MAX_SCRIPTS) throw new Error(`${entry} has more than ${APP_PAGE_MAX_SCRIPTS} scripts. Published apps can run at most ${APP_PAGE_MAX_SCRIPTS}. Combine some scripts into one file.`);
    return scripts.push(source) - 1;
  };
  const media = (element: Element, label: string) => {
    const condition = attribute(element, "media")?.trim() ?? "";
    if (/[;{}"'\\]/.test(condition)) throw new Error(`${entry} gives ${label} the media condition "${condition}", which published apps cannot carry. Use a plain media query.`);
    return condition.toLowerCase() === "all" ? "" : condition;
  };
  const attributes = (element: Element): AppPageAttribute[] => element.attrs
    .map(attr => {
      const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      const space = attr.namespace ? attributeSpaces[attr.namespace] : undefined;
      return space ? [name, attr.value, space] : [name, attr.value];
    });
  const setValue = (rows: AppPageAttribute[], name: string, value: AppPageValue) => {
    const row = rows.find(([candidate, , space]) => candidate === name && !space);
    if (row) row[1] = value;
  };

  const convert = (nodes: readonly Node[], depth: number, inTemplate: boolean): AppPageNode[] => {
    if (depth > APP_PAGE_MAX_DEPTH) throw new Error(`${entry} nests elements more than ${APP_PAGE_MAX_DEPTH} levels deep. Browsers stop nesting there. Flatten the markup.`);
    const out: AppPageNode[] = [];
    for (const node of nodes) {
      if (defaultTreeAdapter.isTextNode(node)) { out.push(node.value); continue; }
      if (defaultTreeAdapter.isCommentNode(node)) { out.push({ comment: node.data }); continue; }
      if (!defaultTreeAdapter.isElementNode(node)) continue;
      const element = convertElement(node, depth, inTemplate);
      if (element) out.push(element);
    }
    return out;
  };
  const convertElement = (element: Element, depth: number, inTemplate: boolean): AppPageElement | null => {
    const tag = element.tagName;
    const handler = element.attrs.find(attr => /^on/i.test(attr.name));
    if (handler) throw new Error(`${entry} has an ${handler.name} attribute. Published apps cannot run inline event handlers. Attach the handler in a script.`);
    const html = element.namespaceURI === spaces.html;
    const ns = element.namespaceURI === spaces.svg ? "svg" as const : element.namespaceURI === spaces.math ? "math" as const : undefined;
    if (!html && tag === "script") throw new Error(`${entry} has a <script> inside <${ns}>. Published apps run only HTML scripts. Move the script out of the SVG.`);
    const attrs = attributes(element);
    const style = attribute(element, "style");
    if (style !== undefined) setValue(attrs, "style", cssImages(style));
    const record = (extra: Partial<AppPageElement> = {}, skip: readonly string[] = []): AppPageElement => {
      const kept = skip.length ? attrs.filter(([name, , space]) => space || !skip.includes(name)) : attrs;
      const content = html && tag === "template" ? convert(defaultTreeAdapter.getTemplateContent(element as DefaultTreeAdapterTypes.Template).childNodes, depth + 1, true) : undefined;
      return { tag, ...(ns ? { ns } : {}), attrs: kept, children: convert(element.childNodes, depth + 1, inTemplate), ...(content ? { content } : {}), ...extra };
    };
    if (!html) {
      if (tag === "image" || tag === "use" || tag === "feImage") {
        for (const row of attrs) if ((row[0] === "href" || row[0] === "xlink:href") && typeof row[1] === "string") row[1] = joined([image(row[1])]);
      }
      return record();
    }
    // Links already resolve from the page's base; only the first base counts, and the policy refuses a base address.
    if (tag === "base" && !inTemplate) return record({}, ["href"]);
    if (tag === "script") {
      const kind = scriptKind(element), src = attribute(element, "src");
      if (inTemplate) {
        if (kind === null) return record();
        if (src !== undefined) throw new Error(`${entry} has a <script src="${src}"> inside <template>. Published apps can run only inline scripts from templates.`);
        // A template script runs when app code inserts a copy, so its text is hashed like any other script.
        addScript(classicScript(textOf(element), `A script in a template in ${entry}`));
        return record();
      }
      if (kind === null) return record();
      if (kind === "skip") return { ...record({}, ["src"]), children: [] };
      if (kind === "module") {
        if (modules.length >= APP_PAGE_MAX_SCRIPTS) throw new Error(`${entry} has more than ${APP_PAGE_MAX_SCRIPTS} module scripts. Import them from one module instead.`);
        if (src === undefined) {
          const key = `dohc-page:${inline.size}.js`;
          inline.set(key, { contents: textOf(element), loader: "js" });
          modules.push(key);
        } else modules.push(`${pageInput}${local(src, "module")}`);
        return { ...record({ module: modules.length - 1 }, ["src"]), children: [] };
      }
      if (src === undefined) return { ...record({ run: addScript(classicScript(textOf(element), `A script in ${entry}`)) }), children: [] };
      const path = local(src, "script");
      const source = classicScript(text(inputs.get(path)!.bytes), path);
      const later = attribute(element, "defer") !== undefined || attribute(element, "async") !== undefined;
      return { ...record(later ? { defer: addScript(source) } : { run: addScript(source) }, ["src"]), children: [] };
    }
    if (tag === "style" && !inTemplate) {
      const type = attribute(element, "type")?.trim().toLowerCase();
      if (type && type !== "text/css") return record();
      const key = `dohc-page:${inline.size}.css`;
      inline.set(key, { contents: textOf(element), loader: "css" });
      const condition = media(element, "a <style>");
      styles.push(`@import ${JSON.stringify(key)}${condition ? ` ${condition}` : ""};`);
      return null;
    }
    const rel = tag === "link" ? (attribute(element, "rel") ?? "").toLowerCase().split(/\s+/) : [];
    if (rel.includes("stylesheet") && !rel.includes("alternate") && !inTemplate) {
      const href = attribute(element, "href") ?? "";
      if (attribute(element, "disabled") !== undefined) throw new Error(`${entry} links the stylesheet ${href} as disabled. Published apps apply every stylesheet. Remove the link or its disabled attribute.`);
      const condition = media(element, `the stylesheet ${href}`);
      styles.push(`@import ${JSON.stringify(`${pageInput}${local(href, "stylesheet")}`)}${condition ? ` ${condition}` : ""};`);
      return null;
    }
    const parent = element.parentNode && defaultTreeAdapter.isElementNode(element.parentNode) ? element.parentNode.tagName : "";
    const mediaElement = tag === "video" || tag === "audio" || tag === "track" || (tag === "source" && parent !== "picture");
    if (mediaElement) {
      const src = attribute(element, "src");
      if (src !== undefined && !/^(?:https?:|data:|blob:)/i.test(src.trim())) throw new Error(`${entry} links ${src} as audio or video. Published apps cannot include local audio or video. Link to a copy on another site.`);
    }
    if (tag === "iframe" && attribute(element, "srcdoc") !== undefined) throw new Error(`${entry} embeds a page with <iframe srcdoc>. Published apps cannot embed other pages.`);
    for (const name of tag === "object" ? ["data"] : tag === "iframe" || tag === "frame" || tag === "embed" ? ["src"] : []) {
      const value = attribute(element, name)?.trim();
      if (value && value !== "about:blank") throw new Error(`${entry} embeds ${value} in <${tag}>. Published apps cannot embed other pages or files.`);
    }
    if (tag === "img" || (tag === "input" && attribute(element, "type")?.toLowerCase() === "image") || (tag === "source" && !mediaElement)) {
      const src = attribute(element, "src");
      if (src !== undefined) setValue(attrs, "src", joined([image(src)]));
    }
    const poster = tag === "video" ? attribute(element, "poster") : undefined;
    if (poster !== undefined) setValue(attrs, "poster", joined([image(poster)]));
    const set = tag === "img" || tag === "source" ? attribute(element, "srcset") : undefined;
    if (set !== undefined) {
      setValue(attrs, "srcset", joined(srcset(set).flatMap(({ url, descriptor }, index) =>
        [index ? ", " : "", image(url), descriptor ? ` ${descriptor}` : ""])));
    }
    return record();
  };

  const page: AppPage = {
    htmlAttributes: attributes(root), bodyAttributes: attributes(body),
    head: convert(head.childNodes, 1, false), body: convert(body.childNodes, 1, false),
    scripts, images, modules: modules.length,
  };
  if (styles.length) inline.set(pageStyles, { contents: styles.join("\n"), loader: "css" });
  const module = (styles.length ? `import ${JSON.stringify(pageStyles)};\n` : "") +
    `globalThis.${APP_PAGE_MODULES_GLOBAL} = [${modules.map(specifier => `() => require(${JSON.stringify(specifier)})`).join(", ")}];`;
  return { page, module, inline, base, used, images: embedded };
}
