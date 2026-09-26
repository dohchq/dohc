import { posix } from "node:path";
import { parse as parseScript } from "acorn";
import { defaultTreeAdapter, parse as parseHtml, serialize, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { APP_PAGE_MAX_SCRIPTS, appPageProblem, unsafeInlineScript, type AppPage } from "@dohc/app-browser/document";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** esbuild namespace for a page's inline styles and module scripts. */
export const pageNamespace = "dohc-app-page";
/** Resolved captured files the generated entry names as stylesheet entries or module scripts. */
export const pageInput = "dohc-input:";
/** The global bundle.js defines for the page's module and deferred-script stubs. */
const pageGlobal = "__dohcPage";
/** Chromium's HTML parser stops nesting elements here. */
const maxDepth = 512;

/**
 * An HTML entry compiled for the browser to parse natively inside the sandboxed
 * frame. Each classic script stays a parser-inserted inline script where it
 * stood, so script order, microtask checkpoints, document.currentScript, and
 * document.write behave as in a tab. Module scripts and deferred scripts become
 * inline module stubs at their original positions that call into bundle.js.
 */
export interface ClosedAppPage {
  /** The generated bundle.js entry: the module registry and the deferred-script runner. */
  module: string;
  /** Inline style and module script bodies, by specifier. */
  inline: ReadonlyMap<string, { contents: string; loader: "css" | "js" }>;
  /** esbuild entries for the page's stylesheets, in the order finish() takes their CSS. */
  stylesheets: readonly string[];
  /** The directory inline modules and styles resolve their imports from. */
  base: string;
  /** Captured files the page uses outside esbuild: classic scripts and embedded images, with their sizes. */
  used: ReadonlyMap<string, number>;
  /** Embedded images by path. */
  images: ReadonlyMap<string, number>;
  /** Fills each stylesheet with its compiled CSS, adds CSS that module scripts import, and returns the page record. */
  finish(stylesheets: readonly string[], moduleCss: string): AppPage;
}

const spaces = { html: "http://www.w3.org/1999/xhtml", svg: "http://www.w3.org/2000/svg" };
const imageTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"]]);
const javascriptType = /^(?:text\/(?:javascript|ecmascript|jscript|x-javascript|x-ecmascript)|application\/(?:javascript|ecmascript))$/i;
const remote = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;
const publishableName = /^[A-Za-z0-9_@./-]+$/;
// Link-only attributes a stylesheet loses when it becomes a <style> element.
const linkOnly = new Set(["href", "rel", "crossorigin", "integrity", "referrerpolicy", "as", "fetchpriority", "hreflang", "type", "sizes", "imagesrcset", "imagesizes", "blocking"]);
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

/** Finds a document.write or document.writeln call, which only a parser-inserted script can use as written. */
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

/** A classic script runs as written; the build checks that it parses, loads no module, and, when it runs late, writes no markup. */
function classicScript(source: string, label: string, late: boolean): string {
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
  const write = late && documentWrite(program);
  if (write) throw new Error(`${label} calls ${write} after the page has loaded, which would replace the page. Add the elements with DOM methods instead.`);
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

/** The registry bundle.js runs first in <head>: module entries by index, and a runner for deferred classic scripts. */
function registry(modules: readonly string[]): string {
  return `const modules = [${modules.map(specifier => `() => require(${JSON.stringify(specifier)})`).join(", ")}];
// Page markup can name elements after document members, so take the DOM methods before any page node exists.
const apply = Reflect.apply, own = (type, name, kind = "value") => Object.getOwnPropertyDescriptor(type.prototype, name)[kind];
const querySelector = own(Document, "querySelector"), createElement = own(Document, "createElement");
const attributes = own(Element, "attributes", "get"), setAttribute = own(Element, "setAttribute"), replaceWith = own(Element, "replaceWith");
const nextElement = own(Element, "nextElementSibling", "get"), remove = own(Element, "remove");
const getText = own(Node, "textContent", "get"), setText = own(Node, "textContent", "set");
const page = document, self = page.currentScript;
globalThis.${pageGlobal} = {
  module(index) { modules[index](); },
  // A deferred script waits as an inert placeholder; its module stub, right after it, turns it into a live script.
  defer(index) {
    const placeholder = apply(querySelector, page, ['script[type="dohc-deferred-' + index + '"]']);
    if (!placeholder) return;
    const stub = apply(nextElement, placeholder, []), script = apply(createElement, page, ["script"]);
    for (const { name, value } of apply(attributes, placeholder, [])) if (name !== "type") try { apply(setAttribute, script, [name, value]); } catch {}
    apply(setText, script, [apply(getText, placeholder, [])]);
    apply(replaceWith, placeholder, [script]);
    if (stub) apply(remove, stub, []);
  },
};
if (self) apply(remove, self, []);
`;
}

/** Compiles captured bytes only. Remote scripts and stylesheets stay out, as they do for script entries. */
export function compileClosedAppPage(entry: string, inputs: ReadonlyMap<string, { bytes: Uint8Array }>): ClosedAppPage {
  const document = parseHtml(text(inputs.get(entry)!.bytes));
  if (document.mode === "quirks") throw new Error(`${entry} has no <!doctype html>, so a browser shows it in quirks mode. Published apps always use standards mode. Add <!doctype html> as its first line.`);
  const scripts = new Set<string>(), modules: string[] = [], stylesheets: string[] = [], styleElements: Element[] = [];
  const dataUrls = new Map<string, string>(), used = new Map<string, number>(), embedded = new Map<string, number>();
  const inline = new Map<string, { contents: string; loader: "css" | "js" }>();
  let deferred = 0;
  const outside = (value: string) => `${entry} loads ${value} from outside the app. Save a copy in the app folder and link to that instead.`;
  const root = document.childNodes.find(defaultTreeAdapter.isElementNode);
  const head = root?.childNodes.find((node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "head");
  const body = root?.childNodes.find((node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "body");
  if (!root || !head || !body) throw new Error(`${entry} uses <frameset>. Published apps need a page with a <body>.`);

  // Every element in document order, with whether it sits in inert template content. Iterative, so depth cannot exhaust the stack.
  const elements: Array<{ element: Element; inTemplate: boolean }> = [];
  const pending: Array<{ element: Element; inTemplate: boolean; depth: number }> = [{ element: root, inTemplate: false, depth: 1 }];
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > maxDepth) throw new Error(`${entry} nests elements more than ${maxDepth} levels deep. Browsers stop nesting there. Flatten the markup.`);
    elements.push(next);
    const template = next.element.namespaceURI === spaces.html && next.element.tagName === "template";
    const parent: ParentNode = template ? defaultTreeAdapter.getTemplateContent(next.element as DefaultTreeAdapterTypes.Template) : next.element;
    const children = parent.childNodes.filter(defaultTreeAdapter.isElementNode);
    for (const element of children.reverse()) pending.push({ element, inTemplate: next.inTemplate || template, depth: next.depth + 1 });
  }

  // The first <base href> outside template content sets the page's base address.
  const baseElement = elements.find(({ element, inTemplate }) => !inTemplate && element.namespaceURI === spaces.html && element.tagName === "base" && attribute(element, "href") !== undefined)?.element;
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
  /** A remote, data, blob, or fragment image stays as written; a local one becomes a data URL. */
  const image = (value: string): string => {
    if (/^(?:https?:|data:|blob:|#|\/\/)/i.test(value.trim()) || value.trim() === "") return value;
    const path = local(value, "image");
    if (!dataUrls.has(path)) {
      embedded.set(path, inputs.get(path)!.bytes.byteLength);
      dataUrls.set(path, `data:${imageTypes.get(extension(path))};base64,${Buffer.from(inputs.get(path)!.bytes).toString("base64")}`);
    }
    return dataUrls.get(path)!;
  };
  const addScript = (source: string) => {
    scripts.add(source);
    if (scripts.size > APP_PAGE_MAX_SCRIPTS) throw new Error(`${entry} has more than ${APP_PAGE_MAX_SCRIPTS} scripts. Published apps can run at most ${APP_PAGE_MAX_SCRIPTS}. Combine some scripts into one file.`);
  };
  const setAttribute = (element: Element, name: string, value: string) => {
    const existing = element.attrs.find(attr => attr.name === name && !attr.namespace);
    if (existing) existing.value = value; else element.attrs.push({ name, value });
  };
  const removeAttribute = (element: Element, name: string) => { element.attrs = element.attrs.filter(attr => attr.name !== name || attr.namespace); };
  const setText = (element: Element, value: string) => {
    for (const child of [...element.childNodes]) defaultTreeAdapter.detachNode(child);
    if (value) defaultTreeAdapter.insertText(element, value);
  };
  /** A captured script file, checked so it can sit inline in the page. */
  const scriptFile = (path: string, late: boolean) => {
    // The HTML parser turns CRLF and CR into LF before a script runs and before its hash is checked, so the hash must cover that text.
    const source = classicScript(text(inputs.get(path)!.bytes).replace(/\r\n?/g, "\n"), path, late);
    if (unsafeInlineScript(source)) throw new Error(`${path} contains </script> or <!-- with <script>, which would end the script early in the page. Split the text, for example "<" + "/script>".`);
    return source;
  };
  const stub = (call: string, async: boolean): Element => {
    const element = defaultTreeAdapter.createElement("script", spaces.html as DefaultTreeAdapterTypes.Element["namespaceURI"], [{ name: "type", value: "module" }, ...(async ? [{ name: "async", value: "" }] : [])]);
    defaultTreeAdapter.insertText(element, call);
    addScript(call);
    return element;
  };

  for (const { element, inTemplate } of elements) {
    const tag = element.tagName;
    const handler = element.attrs.find(attr => /^on/i.test(attr.name));
    if (handler) throw new Error(`${entry} has an ${handler.name} attribute on <${tag}>. Published apps cannot run inline event handlers. Attach the handler in a script.`);
    const style = attribute(element, "style");
    if (style !== undefined) setAttribute(element, "style", style.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, quote: string, url: string) => `url(${quote}${image(url)}${quote})`));
    if (element.namespaceURI !== spaces.html) {
      if (tag === "script") throw new Error(`${entry} has a <script> inside <svg>. Published apps run only HTML scripts. Move the script out of the SVG.`);
      if (tag === "image" || tag === "use" || tag === "feImage") {
        for (const attr of element.attrs) if (attr.name === "href") attr.value = image(attr.value);
      }
      continue;
    }
    // Links already resolve from the page's base, and the policy refuses a base address.
    if (tag === "base" && !inTemplate) { removeAttribute(element, "href"); continue; }
    if (tag === "script") {
      const kind = scriptKind(element), src = attribute(element, "src");
      if (kind === null) continue;
      if (inTemplate) {
        if (src !== undefined) throw new Error(`${entry} has a <script src="${src}"> inside <template>. Published apps can run only inline scripts from templates.`);
        // A template script runs when app code inserts a copy, after the page has loaded.
        if (kind === "classic") addScript(classicScript(textOf(element), `A script in a template in ${entry}`, true));
        continue;
      }
      if (kind === "skip") { removeAttribute(element, "src"); continue; }
      if (kind === "module") {
        if (modules.length >= APP_PAGE_MAX_SCRIPTS) throw new Error(`${entry} has more than ${APP_PAGE_MAX_SCRIPTS} module scripts. Import them from one module instead.`);
        if (src === undefined) {
          const key = `dohc-page:${inline.size}.js`;
          inline.set(key, { contents: textOf(element), loader: "js" });
          modules.push(key);
        } else modules.push(`${pageInput}${local(src, "module")}`);
        // The element stays where it was, as an inline module that runs its bundled code.
        removeAttribute(element, "src");
        setText(element, `${pageGlobal}.module(${modules.length - 1});`);
        addScript(textOf(element));
        continue;
      }
      if (src === undefined) {
        const source = textOf(element);
        if (source) addScript(classicScript(source, `A script in ${entry}`, false));
        continue;
      }
      const path = local(src, "script");
      const async = attribute(element, "async") !== undefined;
      removeAttribute(element, "src");
      if (!async && attribute(element, "defer") === undefined) {
        // A parser-inserted inline script runs exactly where the external one did.
        const source = scriptFile(path, false);
        setText(element, source);
        addScript(source);
        continue;
      }
      // A deferred or async script waits as an inert placeholder; a module stub after it runs it when a browser would.
      const source = scriptFile(path, true);
      setText(element, source);
      addScript(source);
      setAttribute(element, "type", `dohc-deferred-${deferred}`);
      const siblings = element.parentNode!.childNodes, after = siblings[siblings.indexOf(element) + 1];
      const runner = stub(`${pageGlobal}.defer(${deferred});`, async);
      if (after) defaultTreeAdapter.insertBefore(element.parentNode!, runner, after); else defaultTreeAdapter.appendChild(element.parentNode!, runner);
      deferred++;
      continue;
    }
    // Template stylesheets stay as written; their images are still embedded below.
    if (tag === "style" && !inTemplate) {
      const type = attribute(element, "type")?.trim().toLowerCase();
      if (type && type !== "text/css") continue;
      const key = `dohc-page:${inline.size}.css`;
      inline.set(key, { contents: textOf(element), loader: "css" });
      stylesheets.push(key);
      styleElements.push(element);
      continue;
    }
    const rel = tag === "link" ? (attribute(element, "rel") ?? "").toLowerCase().split(/\s+/) : [];
    if (rel.includes("stylesheet") && !rel.includes("alternate") && !inTemplate) {
      const href = attribute(element, "href") ?? "";
      if (attribute(element, "disabled") !== undefined) throw new Error(`${entry} links the stylesheet ${href} as disabled. Published apps apply every stylesheet. Remove the link or its disabled attribute.`);
      stylesheets.push(`${pageInput}${local(href, "stylesheet")}`);
      // The stylesheet stays where it was, with its id, media, and other attributes, as a <style> element.
      const replacement = defaultTreeAdapter.createElement("style", element.namespaceURI, element.attrs.filter(attr => attr.namespace || !linkOnly.has(attr.name)));
      defaultTreeAdapter.insertBefore(element.parentNode!, replacement, element);
      defaultTreeAdapter.detachNode(element);
      styleElements.push(replacement);
      continue;
    }
    const parent = element.parentNode && defaultTreeAdapter.isElementNode(element.parentNode) ? element.parentNode.tagName : "";
    const media = tag === "video" || tag === "audio" || tag === "track" || (tag === "source" && parent !== "picture");
    if (media) {
      const src = attribute(element, "src");
      if (src !== undefined && !/^(?:https?:|data:|blob:)/i.test(src.trim())) throw new Error(`${entry} links ${src} as audio or video. Published apps cannot include local audio or video. Link to a copy on another site.`);
    }
    if (tag === "iframe" && attribute(element, "srcdoc") !== undefined) throw new Error(`${entry} embeds a page with <iframe srcdoc>. Published apps cannot embed other pages.`);
    for (const name of tag === "object" ? ["data"] : tag === "iframe" || tag === "frame" || tag === "embed" ? ["src"] : []) {
      const value = attribute(element, name)?.trim();
      if (value && value !== "about:blank") throw new Error(`${entry} embeds ${value} in <${tag}>. Published apps cannot embed other pages or files.`);
    }
    if (tag === "img" || (tag === "input" && attribute(element, "type")?.toLowerCase() === "image") || (tag === "source" && !media)) {
      const src = attribute(element, "src");
      if (src !== undefined) setAttribute(element, "src", image(src));
    }
    const poster = tag === "video" ? attribute(element, "poster") : undefined;
    if (poster !== undefined) setAttribute(element, "poster", image(poster));
    const set = tag === "img" || tag === "source" ? attribute(element, "srcset") : undefined;
    if (set !== undefined) setAttribute(element, "srcset", srcset(set).map(({ url, descriptor }) => descriptor ? `${image(url)} ${descriptor}` : image(url)).join(", "));
  }

  const finish = (css: readonly string[], moduleCss: string): AppPage => {
    // esbuild keeps custom property values as written, so compiled CSS can still hold </style>, which would end the element early.
    const safeCss = (value: string, label: string) => {
      if (/<\/style/i.test(value)) throw new Error(`${label} contains </style>, which would end the stylesheet early in the page. Write it as \\3c/style instead.`);
      return value;
    };
    for (const [index, element] of styleElements.entries()) {
      const sheet = stylesheets[index]!;
      setText(element, safeCss(css[index] ?? "", sheet.startsWith(pageInput) ? sheet.slice(pageInput.length) : `A <style> in ${entry}`));
    }
    safeCss(moduleCss, `The CSS that module scripts in ${entry} import`);
    // CSS that module scripts import lands last in <head>, as a bundler injects it.
    if (moduleCss) {
      const element = defaultTreeAdapter.createElement("style", spaces.html as DefaultTreeAdapterTypes.Element["namespaceURI"], []);
      defaultTreeAdapter.insertText(element, moduleCss);
      defaultTreeAdapter.appendChild(head, element);
    }
    const page: AppPage = {
      htmlAttributes: root.attrs.map(attr => [attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value]),
      head: serialize(head), body: serializeOuter(body), scripts: [...scripts],
    };
    const problem = appPageProblem(page);
    if (problem) throw new Error(`${entry} ${problem}`);
    return page;
  };
  return { module: registry(modules), inline, stylesheets, base, used, images: embedded, finish };
}
